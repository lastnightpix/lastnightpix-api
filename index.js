// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

// If you're on Node 18+, global fetch exists; otherwise install node-fetch and uncomment:
// const fetch = require('node-fetch');

const app = express();

// ------- Config & safety -------
app.use(cors());
app.use(express.json({ limit: '10mb' })); // needed for /match-by-url JSON body

const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET_NAME;          // e.g., practicelastnightpix
const COLLECTION_ID = process.env.COLLECTION_ID; // e.g., my-face-collection

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !REGION || !BUCKET || !COLLECTION_ID) {
  console.warn('⚠️ Missing env vars. Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, BUCKET_NAME, COLLECTION_ID');
}

// ------- AWS Clients (SDK v2) -------
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: REGION,
});

const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();

// ------- Multer for uploads (temp folder) -------
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ------- Helpers -------
function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

// Sanitize a filename for Rekognition ExternalImageId (only [a-zA-Z0-9_.\-:])
function sanitizeName(name) {
  return (name || `upload-${Date.now()}.jpg`)
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_');
}

// ------- Health check -------
app.get('/health', (_req, res) => res.send('ok'));

// ------- /upload -------
// form-data field: image
// Uploads to S3, indexes face, returns signed URL
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "image".' });

  const tempPath = req.file.path;
  const original = sanitizeName(req.file.originalname || `upload-${Date.now()}.jpg`);
  const s3Key = `${Date.now()}-${original}`; // flat key (NO slashes)

  try {
    const buffer = fs.readFileSync(tempPath);

    // 1) Upload to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: req.file.mimetype || 'image/jpeg',
      ACL: 'private'
    }).promise();

    // 2) Index face
    const idx = await rekognition.indexFaces({
      CollectionId: COLLECTION_ID,
      Image: { S3Object: { Bucket: BUCKET, Name: s3Key } },
      ExternalImageId: s3Key, // must match regex; we sanitized & removed slashes
      DetectionAttributes: []
    }).promise();

    // 3) Temporary signed URL to view
    const imageUrl = s3.getSignedUrl('getObject', {
      Bucket: BUCKET,
      Key: s3Key,
      Expires: 600 // 10 minutes
    });

    res.json({
      success: true,
      s3Key,
      indexedFaces: idx.FaceRecords?.length || 0,
      imageUrl
    });
  } catch (err) {
    console.error('Upload/index error:', err);
    res.status(500).json({ success: false, error: 'Upload/index failed: ' + err.message });
  } finally {
    safeUnlink(tempPath);
  }
});

// ------- /match -------
// form-data field: image
// Sends uploaded bytes to Rekognition and returns best match signed URL
app.post('/match', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field name must be "image".' });
  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);

    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 1
    }).promise();

    if (result.FaceMatches && result.FaceMatches.length > 0) {
      const top = result.FaceMatches[0];
      const externalImageId = top.Face?.ExternalImageId;
      const similarity = top.Similarity;

      const imageUrl = s3.getSignedUrl('getObject', {
        Bucket: BUCKET,
        Key: externalImageId,
        Expires: 600
      });

      return res.json({ matchFound: true, imageUrl, similarity, externalImageId });
    }

    return res.json({ matchFound: false });
  } catch (err) {
    console.error('Matching failed:', err);
    res.status(500).send('Matching failed: ' + err.message);
  } finally {
    safeUnlink(tempPath);
  }
});

// ------- /match-by-url -------
// JSON body: { url: "https://..." }
// Server downloads the image and searches (avoids Wix preview CORS issues)
app.post('/match-by-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ matchFound: false, error: 'Missing or invalid url' });
    }

    // Use global fetch (Node 18+) or node-fetch polyfill
    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ matchFound: false, error: 'Could not fetch url' });

    const arrayBuf = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 1
    }).promise();

    if (result.FaceMatches && result.FaceMatches.length > 0) {
      const top = result.FaceMatches[0];
      const externalImageId = top.Face?.ExternalImageId;
      const similarity = top.Similarity;

      const imageUrl = s3.getSignedUrl('getObject', {
        Bucket: BUCKET,
        Key: externalImageId,
        Expires: 600
      });

      return res.json({ matchFound: true, imageUrl, similarity, externalImageId });
    }

    return res.json({ matchFound: false });
  } catch (err) {
    console.error('match-by-url failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-by-url failed: ' + err.message });
  }
});

// ------- Start server -------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
