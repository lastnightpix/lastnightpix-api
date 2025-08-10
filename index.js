// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

const app = express();

// --- CORS so Wix can call your API ---
app.use(cors());

// --- Multer for form-data file uploads ---
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// --- Read config from environment ---
const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET_NAME;          // e.g. practicelastnightpix
const COLLECTION_ID = process.env.COLLECTION_ID; // e.g. my-face-collection

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !REGION || !BUCKET || !COLLECTION_ID) {
  console.warn('⚠️ Missing one or more required env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, BUCKET_NAME, COLLECTION_ID');
}

// --- AWS clients (SDK v2) ---
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: REGION,
});

const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();

// --- Health check ---
app.get('/health', (_req, res) => res.send('ok'));

// --- Helper: delete temp file safely ---
function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// --- /upload ---
// Accepts: form-data with field name: image
// Action:  uploads file to S3, indexes face to Rekognition collection with ExternalImageId = S3 Key
// Returns: { success, s3Key, imageUrl }
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "image".' });

  const tempPath = req.file.path;
  const originalName = req.file.originalname || `upload-${Date.now()}.jpg`;
  const s3Key = `faces/${Date.now()}-${originalName}`;

  try {
    const fileBuffer = fs.readFileSync(tempPath);

    // 1) Upload to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: req.file.mimetype || 'image/jpeg',
      ACL: 'private', // keep original private; we’ll share via signed URL
    }).promise();

    // 2) Index to Rekognition (reference by S3Object and tag with ExternalImageId = s3Key)
    const idx = await rekognition.indexFaces({
      CollectionId: COLLECTION_ID,
      Image: { S3Object: { Bucket: BUCKET, Name: s3Key } },
      ExternalImageId: s3Key,
      DetectionAttributes: [], // DEFAULT
    }).promise();

    // 3) Return a signed URL for convenience (thumbnail/display)
    const imageUrl = s3.getSignedUrl('getObject', {
      Bucket: BUCKET,
      Key: s3Key,
      Expires: 60 * 10, // 10 minutes
    });

    res.json({
      success: true,
      s3Key,
      indexedFaces: idx.FaceRecords?.length || 0,
      imageUrl,
    });
  } catch (err) {
    console.error('Upload/index error:', err);
    res.status(500).json({ success: false, error: 'Upload/index failed: ' + err.message });
  } finally {
    safeUnlink(tempPath);
  }
});

// --- /match ---
// Accepts: form-data with field name: image (the selfie from Wix)
// Action:  searches Rekognition collection for best match
// Returns: { matchFound: boolean, imageUrl?: string, similarity?: number, externalImageId?: string }
app.post('/match', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field name must be "image".' });

  const tempPath = req.file.path;

  try {
    const fileBuffer = fs.readFileSync(tempPath);

    // Search faces by uploaded selfie bytes
    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: fileBuffer },
      FaceMatchThreshold: 85, // you can tune this (80–95)
      MaxFaces: 1,
    }).promise();

    if (result.FaceMatches && result.FaceMatches.length > 0) {
      const top = result.FaceMatches[0];
      const externalImageId = top.Face?.ExternalImageId; // this is the S3 key we set during /upload
      const similarity = top.Similarity;

      // Build a signed URL for the matched S3 object
      const imageUrl = s3.getSignedUrl('getObject', {
        Bucket: BUCKET,
        Key: externalImageId,
        Expires: 60 * 10, // 10 minutes
      });

      return res.json({
        matchFound: true,
        imageUrl,
        similarity,
        externalImageId,
      });
    }

    return res.json({ matchFound: false });
  } catch (err) {
    console.error('Matching failed:', err);
    res.status(500).send('Matching failed: ' + err.message);
  } finally {
    safeUnlink(tempPath);
  }
});

// --- Start server (Render sets PORT) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});