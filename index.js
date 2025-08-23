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
  console.warn('Missing env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, BUCKET_NAME, COLLECTION_ID');
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
    .replace(/[^a-zA-Z0-9_.\-:/]/g, '_'); // allow colon (:) for ExternalImageId trick
}

// Helpers: event prefix and colon<->slash conversion for ExternalImageId
function eventPrefix(event) {
  return event ? `event-photos/${event}/` : `event-photos/default/`;
}
function toExternalId(s3Key) {
  // Rekognition does NOT allow '/', but DOES allow ':'
  return String(s3Key).replace(/\//g, ':');
}
function fromExternalId(extId) {
  return String(extId).replace(/:/g, '/');
}
function colonPrefix(prefixWithSlashes) {
  return String(prefixWithSlashes).replace(/\//g, ':');
}

app.get('/health', (_req, res) => res.send('ok'));

// ---------- ADMIN: upload + index event photos ----------
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

    // Use colonified key for Rekognition's ExternalImageId
    const externalId = toExternalId(s3Key);

    const idx = await rekognition.indexFaces({
      CollectionId: COLLECTION_ID,
      Image: { S3Object: { Bucket: BUCKET, Name: s3Key } },
      ExternalImageId: externalId,
      DetectionAttributes: [],
    }).promise();

    res.json({ success: true, s3Key, externalId, indexedFaces: idx.FaceRecords?.length || 0 });
  } catch (err) {
    console.error('Upload/index error:', err);
    res.status(500).json({ success: false, error: 'Upload/index failed: ' + err.message });
  } finally {
    safeUnlink(tempPath);
  }
});

// ---------- MATCH (top 1) ----------
app.post('/match', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedPrefix = event ? eventPrefix(event) : null;
  const wantedColonPrefix = wantedPrefix ? colonPrefix(wantedPrefix) : null;

  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);
    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 5,
    }).promise();

    let matches = (result.FaceMatches || []);
    if (wantedColonPrefix) {
      matches = matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedColonPrefix));
    }

    if (matches.length > 0) {
      const top = matches.sort((a,b) => (b.Similarity||0)-(a.Similarity||0))[0];
      const extId = top.Face?.ExternalImageId || '';
      const s3Key = fromExternalId(extId);
      const similarity = top.Similarity;

      // Serve via proxy so user links don't expire
      const imageUrl = `/proxy-image?key=${encodeURIComponent(s3Key)}`;
      return res.json({ matchFound: true, imageUrl, similarity, externalImageId: extId, s3Key });
    }
    return res.json({ matchFound: false });
  } catch (err) {
    console.error('Matching failed:', err);
    res.status(500).send('Matching failed: ' + err.message);
  } finally {
    safeUnlink(tempPath);
  }
});

// ---------- MATCH GALLERY (many) ----------
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedPrefix = event ? eventPrefix(event) : null;
  const wantedColonPrefix = wantedPrefix ? colonPrefix(wantedPrefix) : null;

  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);
    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 80,
      MaxFaces: 12,
    }).promise();

    let matches = (result.FaceMatches || []);
    if (wantedColonPrefix) {
      matches = matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedColonPrefix));
    }

    const results = matches
      .sort((a,b) => (b.Similarity||0)-(a.Similarity||0))
      .map(m => {
        const extId = m.Face?.ExternalImageId || '';
        const s3Key = fromExternalId(extId);
        const similarity = m.Similarity;
        return {
          key: s3Key,
          similarity,
          imageUrl: `/proxy-image?key=${encodeURIComponent(s3Key)}`
        };
      });

    return res.json({ matchFound: results.length > 0, count: results.length, results });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-gallery failed: ' + err.message, results: [] });
  } finally {
    safeUnlink(tempPath);
  }
});

// ---------- MATCH BY URL (kept) ----------
app.post('/match-by-url', async (req, res) => {
  try {
    const { url, event } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ matchFound: false, error: 'Missing or invalid url' });

    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ matchFound: false, error: 'Could not fetch url' });

    const arrayBuf = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const wantedPrefix = event ? eventPrefix(event) : null;
    const wantedColonPrefix = wantedPrefix ? colonPrefix(wantedPrefix) : null;

    const result = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: buffer },
      FaceMatchThreshold: 85,
      MaxFaces: 5,
    }).promise();

    let matches = (result.FaceMatches || []);
    if (wantedColonPrefix) {
      matches = matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedColonPrefix));
    }

    if (matches.length > 0) {
      const top = matches.sort((a,b) => (b.Similarity||0)-(a.Similarity||0))[0];
      const extId = top.Face?.ExternalImageId || '';
      const s3Key = fromExternalId(extId);
      const similarity = top.Similarity;
      const imageUrl = `/proxy-image?key=${encodeURIComponent(s3Key)}`;
      return res.json({ matchFound: true, imageUrl, similarity, externalImageId: extId, s3Key });
    }
    return res.json({ matchFound: false });
  } catch (err) {
    console.error('match-by-url failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-by-url failed: ' + err.message });
  }
});

// ---------- PROXY IMAGE (no expiry on client) ----------
app.get('/proxy-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');

    const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    s3Stream.on('error', (e) => {
      console.error('proxy-image S3 error:', e);
      if (!res.headersSent) res.status(404).send('Not found');
    });
    res.setHeader('Content-Type', 'image/jpeg');
    s3Stream.pipe(res);
  } catch (err) {
    console.error('proxy-image failed:', err);
    res.status(500).send('proxy-image failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
