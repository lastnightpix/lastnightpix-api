require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const AWS = require('aws-sdk');
const fetch = require('node-fetch'); // for match-by-url

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET_NAME;
const COLLECTION_ID = process.env.COLLECTION_ID;

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !REGION || !BUCKET || !COLLECTION_ID) {
  console.warn('⚠️ Missing env vars. Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, BUCKET_NAME, COLLECTION_ID');
}

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: REGION,
});

const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }
function sanitizeName(name) {
  return (name || `upload-${Date.now()}.jpg`)
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.\-:\/]/g, '_');
}

app.get('/health', (_req, res) => res.send('ok'));

/** ---------- EVENT HELPERS ----------
 * We’ll prefix event photos like event-photos/<EVENT>/<FILENAME>.
 * upload:   accepts ?event=BroadwayAug22 (optional)
 * match*:   accepts ?event=BroadwayAug22 to FILTER results to that prefix
 */
function eventPrefix(event) {
  return event ? `event-photos/${event}/` : `event-photos/default/`;
}

// ------- Admin: upload/index event photos -------
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const prefix = eventPrefix(event);

  const tempPath = req.file.path;
  const original = sanitizeName(req.file.originalname || `photo-${Date.now()}.jpg`);
  const s3Key = `${prefix}${Date.now()}-${original}`;

  try {
    const buffer = fs.readFileSync(tempPath);

    await s3.putObject({
      Bucket: BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: req.file.mimetype || 'image/jpeg',
      ACL: 'private',
    }).promise();

    const idx = await rekognition.indexFaces({
      CollectionId: COLLECTION_ID,
      Image: { S3Object: { Bucket: BUCKET, Name: s3Key } },
      ExternalImageId: s3Key,
      DetectionAttributes: [],
    }).promise();

    res.json({ success: true, s3Key, indexedFaces: idx.FaceRecords?.length || 0 });
  } catch (err) {
    console.error('Upload/index error:', err);
    res.status(500).json({ success: false, error: 'Upload/index failed: ' + err.message });
  } finally {
    safeUnlink(tempPath);
  }
});

// ------- Match (top 1) with optional ?event= filter -------
app.post('/match', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedPrefix = event ? eventPrefix(event) : null;
  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);
    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 5,
    }).promise();

    const matches = (result.FaceMatches || []);
    const filtered = wantedPrefix
      ? matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedPrefix))
      : matches;

    if (filtered.length > 0) {
      const top = filtered.sort((a,b) => (b.Similarity||0)-(a.Similarity||0))[0];
      const key = top.Face?.ExternalImageId;
      const similarity = top.Similarity;

      // Proxy URL so links don't expire for users
      const imageUrl = `/proxy-image?key=${encodeURIComponent(key)}`;
      return res.json({ matchFound: true, imageUrl, similarity, externalImageId: key });
    }
    return res.json({ matchFound: false });
  } catch (err) {
    console.error('Matching failed:', err);
    res.status(500).send('Matching failed: ' + err.message);
  } finally {
    safeUnlink(tempPath);
  }
});

// ------- Match Gallery (many) with optional ?event= filter -------
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedPrefix = event ? eventPrefix(event) : null;
  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);
    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 80,
      MaxFaces: 12,
    }).promise();

    const matches = (result.FaceMatches || []);
    const filtered = wantedPrefix
      ? matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedPrefix))
      : matches;

    const results = filtered
      .sort((a,b) => (b.Similarity||0)-(a.Similarity||0))
      .map(m => ({ key: m.Face?.ExternalImageId, similarity: m.Similarity }))
      .filter(r => !!r.key)
      .map(r => ({ ...r, imageUrl: `/proxy-image?key=${encodeURIComponent(r.key)}` }));

    return res.json({ matchFound: results.length > 0, count: results.length, results });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-gallery failed: ' + err.message, results: [] });
  } finally {
    safeUnlink(tempPath);
  }
});

// ------- Match by URL (kept) -------
app.post('/match-by-url', async (req, res) => {
  try {
    const { url, event } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ matchFound: false, error: 'Missing or invalid url' });

    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ matchFound: false, error: 'Could not fetch url' });

    const arrayBuf = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const wantedPrefix = event ? eventPrefix(event) : null;

    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 5,
    }).promise();

    const matches = (result.FaceMatches || []);
    const filtered = wantedPrefix
      ? matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedPrefix))
      : matches;

    if (filtered.length > 0) {
      const top = filtered.sort((a,b) => (b.Similarity||0)-(a.Similarity||0))[0];
      const key = top.Face?.ExternalImageId;
      const similarity = top.Similarity;
      const imageUrl = `/proxy-image?key=${encodeURIComponent(key)}`;
      return res.json({ matchFound: true, imageUrl, similarity, externalImageId: key });
    }
    return res.json({ matchFound: false });
  } catch (err) {
    console.error('match-by-url failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-by-url failed: ' + err.message });
  }
});

// ------- Proxy image by S3 key (no expiry on client) -------
app.get('/proxy-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');

    // Stream from S3
    const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    s3Stream.on('error', (e) => {
      console.error('proxy-image S3 error:', e);
      res.status(404).send('Not found');
    });
    res.setHeader('Content-Type', 'image/jpeg');
    s3Stream.pipe(res);
  } catch (err) {
    console.error('proxy-image failed:', err);
    res.status(500).send('proxy-image failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
