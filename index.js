// =================== LastNightPix API (Express) ===================
// Minimal, production-ready server for MVP:
// - CORS (Netlify + local)
// - Watermarked preview images from S3
// - Face match across all photos (Rekognition)
// - Stripe Checkout (single + album)
// - Admin bulk upload + indexing
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
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,         // provided by Render env
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // provided by Render env
});

const s3 = new aws.S3();
const rekognition = new aws.Rekognition();

// ---------- Stripe ----------
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// ---------- App ----------
const app = express();

// CORS (Netlify + local dev)
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8888',
  'https://lastnightpix.netlify.app',
  'https://lastnightpix.netlify.app/'
]);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.options('*', cors()); // preflight

// Body parsing (for JSON routes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Upload handling (for multipart file uploads)
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB/file

// ---------------- Health / Version ----------------
app.get('/version', async (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    hasAdminUpload: !!(app._router.stack.find(r => r.route && r.route.path === '/admin/upload')),
    region: process.env.AWS_REGION,
    bucket: process.env.BUCKET ? '(set)' : '(MISSING)',
    collection: process.env.COLLECTION ? '(set)' : '(MISSING)'
  });
});

// ---------------- Watermarked Preview ----------------
// GET /preview-image?key=<S3 key>
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
                  font-family="Arial, Helvetica, sans-serif"
                  font-size="${fontSize}"
                  fill="#FFFFFF"
                  fill-opacity="${WM_OPACITY}"
                  font-weight="700"
                  letter-spacing="1">${WM_TEXT}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    const svgBuffer = Buffer.from(svg);

    const out = await sharp(inputBuffer)
      .resize({ width: outW })
      .composite([{ input: svgBuffer, gravity: 'center' }])
      .jpeg({ quality: PREVIEW_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(out);
  } catch (err) {
    console.error('preview-image failed:', err);
    res.status(500).send('preview-image failed: ' + err.message);
  }
});

// ---------------- Face Match (Gallery) ----------------
// POST /match-gallery   (multipart/form-data; field "image")
// Returns: { matchFound, results: [{key, similarity, imageUrl}] }
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.json({ matchFound: false, error: 'No image uploaded' });
    }

    // Search faces by image against your collection
    const search = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION,
      FaceMatchThreshold: 80,
MaxFaces: 50,
QualityFilter: 'NONE',
Image: { Bytes: req.file.buffer }
    }).promise();

    if (!search.FaceMatches || !search.FaceMatches.length) {
      return res.json({ matchFound: false, results: [] });
    }

    // Each Face has an ExternalImageId we set to the S3 key when indexing
    const results = [];
    for (const m of search.FaceMatches) {
      const face = m.Face || {};
      const key = face.ExternalImageId || null;
      if (!key) continue;
      results.push({
        key,
        similarity: Math.round(m.Similarity || 0),
        imageUrl: `/preview-image?key=${encodeURIComponent(key)}`
      });
    }

    // Deduplicate by key, sort by similarity desc
    const seen = new Set();
    const unique = results.filter(r => (r.key && !seen.has(r.key) && seen.add(r.key)));
    unique.sort((a,b) => (b.similarity - a.similarity));

    res.json({ matchFound: unique.length > 0, results: unique });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: err.message });
  }
});
// Debug: POST /debug-search  (multipart form: field "image")
app.post('/debug-search', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no image' });
    const out = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION,
      FaceMatchThreshold: 70,
      MaxFaces: 10,
      QualityFilter: 'NONE',
      Image: { Bytes: req.file.buffer }
    }).promise();
    const list = (out.FaceMatches || []).map(m => ({
      similarity: Math.round(m.Similarity || 0),
      key: m.Face?.ExternalImageId || null,
      faceId: m.Face?.FaceId || null
    }));
    res.json({ count: list.length, results: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- Stripe Checkout ----------------
// POST /create-checkout-session
// Body: { tier: 'single', key } OR { tier: 'album', keys: [] }
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) throw new Error('Stripe not configured: missing STRIPE_SECRET env var');

    const { tier, key, keys } = req.body || {};
    if (tier === 'single') {
      if (!key) return res.status(400).json({ error: 'Missing key' });

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'HD Photo (Single)' },
            unit_amount: PRICE_SINGLE
          },
          quantity: 1
        }],
        success_url: `${FRONTEND_URL}/thanks.html?tier=single&key=${encodeURIComponent(key)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/find-gallery.html?cancel=1`
      });

      return res.json({ url: session.url });
    }

    if (tier === 'album') {
      const arr = Array.isArray(keys) ? keys.filter(Boolean) : [];
      if (!arr.length) return res.status(400).json({ error: 'Missing keys' });

      // Simple album pricing: flat ALBUM_CENTS if >= ALBUM_MIN; otherwise sum singles
      const priceCents = (arr.length >= ALBUM_MIN) ? ALBUM_CENTS : (arr.length * PRICE_SINGLE);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `HD Album (${arr.length} photos)` },
            unit_amount: priceCents
          },
          quantity: 1
        }],
        success_url: `${FRONTEND_URL}/thanks.html?tier=album&count=${arr.length}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/find-gallery.html?cancel=1`,
        metadata: { keys: JSON.stringify(arr.slice(0, 100)) } // limited for safety
      });

      return res.json({ url: session.url });
    }

    return res.status(400).json({ error: 'Invalid tier' });
  } catch (err) {
    console.error('create-checkout-session failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session: ' + err.message });
  }
});

// ---------------- Secure Download ----------------
// GET /download?key=<S3 key>
// Returns a short-lived signed URL to the original (no watermark).
app.get('/download', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing key' });

    const url = s3.getSignedUrl('getObject', {
      Bucket: BUCKET,
      Key: key,
      Expires: 60 // seconds
    });

    res.json({ url });
  } catch (err) {
    console.error('download failed:', err);
    res.status(500).json({ error: 'download failed: ' + err.message });
  }
});

// ---------------- Admin Bulk Upload + Index ----------------
// POST /admin/upload?event=<optional>
// Header: Authorization: Bearer <ADMIN_TOKEN>
// Form field: photos (multiple)
app.post('/admin/upload', upload.array('photos', 200), async (req, res) => {
  try {
    // auth
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== ADMIN_TOKEN) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const eventCode = (req.query.event || 'general').replace(/[^a-zA-Z0-9_\-:.]/g, '');
    if (!req.files || !req.files.length) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const results = [];
    for (const f of req.files) {
      try {
        const ext = mime.extension(f.mimetype) || 'jpg';
        const safeName = (f.originalname || `photo.${ext}`).replace(/[^\w.\-]/g, '_');
        const key = `event-photos/${eventCode}/${Date.now()}-${safeName}`;

        // 1) upload to S3 (private)
        await s3.putObject({
          Bucket: BUCKET,
          Key: key,
          Body: f.buffer,
          ContentType: f.mimetype || 'image/jpeg',
          ACL: 'private'
        }).promise();

        // 2) index faces (OK if none)
let facesIndexed = 0;
try {
  const idx = await rekognition.indexFaces({
    CollectionId: COLLECTION,
    ExternalImageId: key,
    Image: { S3Object: { Bucket: BUCKET, Name: key } },
    DetectionAttributes: [],
    MaxFaces: 15,
    QualityFilter: 'NONE'
  }).promise();

  facesIndexed = Array.isArray(idx.FaceRecords) ? idx.FaceRecords.length : 0;
} catch (e) {
  console.warn('indexFaces warn:', key, e?.message);
}

// record result (always defined)
results.push({ key, ok: true, facesIndexed });
      } catch (e) {
        console.error('admin upload item failed:', e);
        results.push({ key: null, ok: false, error: e.message });
      }
    }

    res.json({ success: true, event: eventCode, uploaded: results.length, results });
  } catch (err) {
    console.error('admin upload failed:', err);
    res.status(500).json({ success: false, error: 'admin upload failed: ' + err.message });
  }
});

// ---------------- Start server ----------------
app.get('/', (req, res) => res.send('LastNightPix API is running'));
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
