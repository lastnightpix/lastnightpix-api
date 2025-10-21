// =================== LastNightPix API (Express) ===================
// Full version with error surface for Rekognition indexFaces
// ================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const aws = require('aws-sdk');
const sharp = require('sharp');
const multer = require('multer');
const mime = require('mime-types');
const Stripe = require('stripe');

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET;
const COLLECTION = process.env.COLLECTION;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const STRIPE_SECRET = process.env.STRIPE_SECRET || '';
const PRICE_SINGLE = Number(process.env.PRICE_SINGLE || '199'); // cents
const ALBUM_MIN = Number(process.env.ALBUM_MIN || '5');
const ALBUM_CENTS = Number(process.env.ALBUM_CENTS || '999');

// Preview / watermark tuning
const WM_TEXT = process.env.WATERMARK_TEXT || 'LastNightPix.com • PREVIEW';
const WM_OPACITY = Number(process.env.WATERMARK_OPACITY || '0.18');
const WM_ANGLE = Number(process.env.WATERMARK_ANGLE || '-30');
const PREVIEW_MAX_W = Number(process.env.PREVIEW_MAX_W || '1200');
const PREVIEW_JPEG_QUALITY = Number(process.env.PREVIEW_JPEG_QUALITY || '80');

// ---------- AWS ----------
aws.config.update({
  region: AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
const s3 = new aws.S3();
const rekognition = new aws.Rekognition();

// ---------- Stripe ----------
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// ---------- App ----------
const app = express();

// CORS
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'https://lastnightpix.netlify.app',
  'https://lastnightpix.netlify.app/',
]);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// ---------------- Health Check ----------------
app.get('/version', (req, res) => {
  const hasAdminUpload = !!(app._router.stack.find(r => r.route && r.route.path === '/admin/upload'));
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    hasAdminUpload,
    region: AWS_REGION,
    bucket: BUCKET ? '(set)' : '(MISSING)',
    collection: COLLECTION ? '(set)' : '(MISSING)',
  });
});

// ---------------- Watermarked Preview ----------------
app.get('/preview-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');

    const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    const inputBuffer = obj.Body;

    const meta = await sharp(inputBuffer).metadata();
    const width = Math.min(meta.width || PREVIEW_MAX_W, PREVIEW_MAX_W);
    const aspect = (meta.width && meta.height) ? meta.height / meta.width : 1.5;
    const outW = width;
    const outH = Math.round(outW * aspect);
    const tile = Math.round(outW / 4);
    const fontSize = Math.round(tile / 4);

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">
        <defs>
          <pattern id="wm" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(${WM_ANGLE})">
            <text x="${Math.round(tile*0.1)}" y="${Math.round(tile*0.6)}"
                  font-family="Arial" font-size="${fontSize}"
                  fill="#FFFFFF" fill-opacity="${WM_OPACITY}"
                  font-weight="700">${WM_TEXT}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;
    const svgBuffer = Buffer.from(svg);

    const out = await sharp(inputBuffer)
      .resize({ width: outW })
      .composite([{ input: svgBuffer, gravity: 'center' }])
      .jpeg({ quality: PREVIEW_JPEG_QUALITY })
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.send(out);
  } catch (err) {
    console.error('preview-image failed:', err);
    res.status(500).send('preview-image failed: ' + err.message);
  }
});

// ---------------- Face Match ----------------
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ matchFound: false, error: 'No image uploaded' });

    const isHeic = /\.(heic|heif)$/i.test(req.file.originalname);
    let selfie = sharp(req.file.buffer).rotate();
    if (isHeic) selfie = selfie.toFormat('jpeg', { quality: 92 });
    const selfieBytes = await selfie
      .resize({ width: 3000, height: 3000, fit: 'inside' })
      .toBuffer();

    const search = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION,
      FaceMatchThreshold: 75,
      MaxFaces: 50,
      QualityFilter: 'NONE',
      Image: { Bytes: selfieBytes },
    }).promise();

    const matches = search.FaceMatches || [];
    const results = matches.map(m => ({
      key: m.Face?.ExternalImageId,
      similarity: Math.round(m.Similarity || 0),
      imageUrl: `/preview-image?key=${encodeURIComponent(m.Face?.ExternalImageId)}`
    })).filter(r => r.key);

    res.json({ matchFound: results.length > 0, results });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: err.message });
  }
});

// ---------------- Admin Upload ----------------
app.post('/admin/upload', upload.array('photos', 200), async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== ADMIN_TOKEN) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const eventCode = (req.query.event || 'general').replace(/[^a-zA-Z0-9_\-:.]/g, '');
    if (!req.files?.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

    const results = [];
    for (const f of req.files) {
      try {
        let baseName = (f.originalname || 'photo.jpg').replace(/[^\w.\-]/g, '_');
        let pipeline = sharp(f.buffer).rotate().resize({ width: 3000, height: 3000, fit: 'inside' })
          .ensureAlpha().modulate({ brightness: 1.05, saturation: 1.05 })
          .toFormat('jpeg', { quality: 92 });
        const bodyBuffer = await pipeline.toBuffer();
        const key = `event-photos/${eventCode}/${Date.now()}-${baseName}`;
        await s3.putObject({ Bucket: BUCKET, Key: key, Body: bodyBuffer, ContentType: 'image/jpeg', ACL: 'private' }).promise();

        let facesIndexed = 0, unindexedReasons = [], indexError = null;
        try {
          const idx = await rekognition.indexFaces({
            CollectionId: COLLECTION,
            ExternalImageId: key,
            Image: { S3Object: { Bucket: BUCKET, Name: key } },
            DetectionAttributes: [],
            MaxFaces: 30,
            QualityFilter: 'NONE',
          }).promise();

          facesIndexed = Array.isArray(idx.FaceRecords) ? idx.FaceRecords.length : 0;
          if (Array.isArray(idx.UnindexedFaces) && idx.UnindexedFaces.length) {
            unindexedReasons = idx.UnindexedFaces.flatMap(u => u.Reasons || []);
          }
        } catch (e) {
          indexError = e.message || String(e);
          console.warn('indexFaces warn:', key, indexError);
        }

        let faceCountInImage = null;
        if (facesIndexed === 0) {
          try {
            const det = await rekognition.detectFaces({ Image: { S3Object: { Bucket: BUCKET, Name: key } } }).promise();
            faceCountInImage = Array.isArray(det.FaceDetails) ? det.FaceDetails.length : 0;
          } catch (e) { faceCountInImage = -1; }

        }

        results.push({ key, ok: true, facesIndexed, faceCountInImage, unindexedReasons, indexError });
      } catch (e) {
        results.push({ key: null, ok: false, error: e.message });
      }
    }

    res.json({ success: true, event: eventCode, uploaded: results.length, results });
  } catch (err) {
    console.error('admin upload failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- Root ----------------
app.get('/', (req, res) => res.send('LastNightPix API is running'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
