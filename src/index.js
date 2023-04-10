const {createServer} = require('http');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const _ = require('lodash');
require('dotenv').config();

process.on('uncaughtException', function (err) {
  console.error((err && err.stack) ? err.stack : err);
})

async function main() {
  try {
    const app = express();
    app.use(cors());

    app.get('/', (req, res) => res.send('FS'))
    app.get('/health-check', (req, res) => res.status(204).end())

    if (process.env.USE_GRID_FS) {
      console.log('Using GridFS')
      const {MongoClient} = require('mongodb');
      const multer = require('multer');
      const fs = require('fs');
      const GridFsStorageService = require('./StorageService/GridFs');
      const url = process.env.MONGODB_URL || 'mongodb://localhost:27017';
      const dbName = process.env.DB_NAME || 'fs';
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(dbName);
      const fsFiles = db.collection('fs.files');
      const gridFs = new GridFsStorageService({bucket: 'fs', db: db})
      const uploadTokens = {}
      const multerStorageEngine = {
        _handleFile: async (req, file, cb) => {
          try {
            const uploadToken = req.body['X-Upload-Token']
            if (!uploadTokens[uploadToken])
              throw new Error("Invalid Upload token");
            delete uploadTokens[uploadToken];
            const uploadedFile = await gridFs.createFile(file);
            // @ts-ignore @obsolete @v1.0
            req.__uploadedFileName = uploadedFile.filename;
            // @ts-ignore @v2.0
            req.__uploadedFile = uploadedFile;
            cb(null, file);
          } catch (e) {
            console.error(e);
            cb(null, null);
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        _removeFile: () => {
        }
      }
      const multerOptions = {storage: multerStorageEngine}
      const uploadFileHandler = multer(multerOptions).any();
      app.get(`/upload-page`, (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
        fs.createReadStream('./src/upload.html', { encoding: 'utf8' }).pipe(res);
      });
      app.get('/api/upload-form', async (req, res) => {
        const apiKey = req.query.apiKey;
        if (apiKey !== process.env.API_KEY) {
          res.status(400).send({error: "Invalid API Key"})
          return
        }
        const uploadToken = `${Date.now()}-${_.random(1000, 9999, false)}`;
        uploadTokens[uploadToken] = true;
        const form = {
          fields: {
            'X-Upload-Token': uploadToken
          },
          url: `http://${req.headers.host}/api`,
        }
        res.send(form)
      });
      app.post('/api', uploadFileHandler, (req, res) => res.send(req.__uploadedFile));
      app.get('/api/:fileName', async (req, res, next) => {
        const fileInfo = await fsFiles.findOne({filename: req.params.fileName})
        if (fileInfo && fileInfo.contentType)
          res.setHeader('Content-Type', fileInfo.contentType);
        res.setHeader('Cache-Control', 'max-age=315360000');
        let file;
        if (req.headers.range) {
          const [start, end] = (req.headers.range.split('=')[1]).split('-')
          const range = {}
          if (start) range.start = +start
          if (end) {
            range.end = +end;
            res.status(206)
          }
          file = await gridFs.getFile(req.params.fileName, range)
        } else {
          file = await gridFs.getFile(req.params.fileName)
        }
        if (!file) {
          res.status(404).end()
          return
        }
        file.on('error', next).pipe(res)
      });
      app.delete('/api/:fileName', async (req, res) => {
        await gridFs.deleteFile(req.params.fileName);
        res.send('OK');
      });
    }

    if (process.env.USE_S3) {
      console.log('Using S3')
      const S3 = require('./StorageService/S3');
      const config = {
        credentialConfig: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          region: process.env.AWS_REGION || undefined,
          endpoint: process.env.AWS_ENDPOINT || undefined
        },
        storageConfig: {
          bucket: process.env.AWS_BUCKET,
          expiryTime: 0
        }
      };
      const s3 = new S3(config)
      app.get(`/upload-page-s3`, (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=UTF-8')
        fs.createReadStream('./src/upload-s3.html', { encoding: 'utf8' }).pipe(res);
      })
      app.get('/api-s3/upload-form', async (req, res) => {
        const apiKey = req.query.apiKey;
        if (apiKey !== process.env.API_KEY) {
          res.status(400).send({error: "Invalid API Key"});
          return;
        }
        const uploadForm = await s3.getUploadForm(req.query.filename, req.query.mimeType)
        res.send(uploadForm);
      })
      app.delete('/api-s3/:fileName', async (req, res) => {
        const apiKey = req.query.apiKey;
        if (apiKey !== process.env.API_KEY) {
          res.status(400).send({error: "Invalid API Key"});
          return;
        }
        const rs = await s3.deleteFile(req.params.fileName)
        res.send(rs);
      })
    }

    const httpServer = createServer(app);
    const PORT = process.env.PORT || process.env.API_PORT || 8081;
    httpServer.listen({port: PORT}, () => console.log(`httpServer ready at port ${PORT}`));
  } catch (e) {
    console.error(e);
  }
}

main().then(() => console.log('...'));
