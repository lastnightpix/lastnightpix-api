// =================== LastNightPix API (Express) ===================
// - Watermarked previews for browsing
// - Stripe checkout (single + album) with metadata.keys
// - Post-purchase: GET /purchase/session?session_id=... -> signed HD URLs
// - Rekognition indexing/matching (with ":" mapping for ExternalImageId)
// ================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const aws = require('aws-sdk');
const sharp = require('sharp');
const multer = require('multer');
const Stripe = require('stripe');

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://lastnightpix.netlify.app';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET;
const COLLECTION = process.env.COLLECTION;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const STRIPE_SECRET = process.env.STRIPE_SECRET || '';
const PRICE_SINGLE = Number(process.env.PRICE_SINGLE || '199'); // cents
const ALBUM_MIN = Number(process.env.ALBUM_MIN || '5');
const ALBUM_CENTS = Number(process.env.ALBUM_CENTS || '999');
const API_BASE = process.env.API_BASE || 'https://lastnightpix-api.onrender.com';


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

// CORS allow Netlify + local
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8888',
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

// Helpers to map ExternalImageId <-> S3 key (Rekognition disallows "/")
const keyToExternalId = (key) => (key || '').replace(/\//g, ':');
const externalIdToKey = (eid) => (eid || '').replace(/:/g, '/');

// ---------------- Health ----------------
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

// ---------------- Watermarked Preview (centered watermark) ----------------
app.get('/preview-image', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send('Missing key');

  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    const original = obj.Body;

    // Resize to your preview width to discourage full-res screenshots
    const base = sharp(original).resize({
      width: PREVIEW_MAX_W,
      withoutEnlargement: true,
    });

    // Grab dimensions for SVG
    const { width, height } = await base.metadata();
    const w = width || 1200;
    const h = height || 800;

    // Central watermark SVG — slightly transparent so the photo is still visible
    const svg = `
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="50%" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${Math.round(w / 10)}"
          fill="white"
          fill-opacity="0.25"
          stroke="black"
          stroke-width="3"
          dominant-baseline="middle">
          ${WM_TEXT}
        </text>
      </svg>
    `;

    const watermarked = await base
      .composite([
        {
          input: Buffer.from(svg),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: PREVIEW_JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(watermarked);
  } catch (err) {
    console.error('preview-image watermark failed, sending original:', err);
    try {
      const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
      res.setHeader('Content-Type', obj.ContentType || 'image/jpeg');
      return res.send(obj.Body);
    } catch (inner) {
      console.error('preview-image fallback failed:', inner);
      return res.status(500).send('Could not load image');
    }
  }
});
// ---------------- Face Match (selfie -> gallery) ----------------
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.json({ matchFound: false, error: 'No image uploaded' });
    }

    const isHeic = /image\/heic|image\/heif/i.test(req.file.mimetype || '') ||
                   /\.(heic|heif)$/i.test(req.file.originalname || '');
    let selfie = sharp(req.file.buffer).rotate();
    if (isHeic) {
      selfie = selfie.toFormat('jpeg', { quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' });
    }
    const selfieBytes = await selfie
      .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    const search = await rekognition.searchFacesByImage({
      CollectionId: COLLECTION,
      FaceMatchThreshold: 75,     // a bit forgiving for nightlife lighting
      MaxFaces: 50,
      QualityFilter: 'NONE',
      Image: { Bytes: selfieBytes }
    }).promise();

    if (!search.FaceMatches || !search.FaceMatches.length) {
      return res.json({ matchFound: false, results: [] });
    }

    const results = [];
    for (const m of search.FaceMatches) {
      const eid = m.Face?.ExternalImageId || '';
      const key = externalIdToKey(eid);
      if (!key) continue;
      const API_BASE = process.env.API_BASE || 'https://lastnightpix-api.onrender.com';
results.push({
  key,
  similarity: Math.round(m.Similarity || 0),
  imageUrl: `${API_BASE}/preview-image?key=${encodeURIComponent(key)}`
});
    }

    const seen = new Set();
    const unique = results.filter(r => (r.key && !seen.has(r.key) && seen.add(r.key)));
    unique.sort((a,b) => (b.similarity - a.similarity));

    res.json({ matchFound: unique.length > 0, results: unique });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: err.message });
  }
});

// ---------------- Stripe Checkout ----------------
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
        success_url: `${FRONTEND_URL}/thanks.html?tier=single&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/find-gallery.html?cancel=1`,
        // Store purchased key in metadata for retrieval on thanks page
        metadata: { keys: JSON.stringify([key]) }
      });
      return res.json({ url: session.url });
    }

    if (tier === 'album') {
      const arr = Array.isArray(keys) ? keys.filter(Boolean) : [];
      if (!arr.length) return res.status(400).json({ error: 'Missing keys' });
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
        success_url: `${FRONTEND_URL}/thanks.html?tier=album&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/find-gallery.html?cancel=1`,
        metadata: { keys: JSON.stringify(arr.slice(0, 100)) }
      });
      return res.json({ url: session.url });
    }

    return res.status(400).json({ error: 'Invalid tier' });
  } catch (err) {
    console.error('create-checkout-session failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session: ' + err.message });
  }
});

// ---------------- Post-purchase: return signed HD URLs ----------------
// GET /purchase/session?session_id=cs_test_123
app.get('/purchase/session', async (req, res) => {
  try {
    if (!stripe) throw new Error('Stripe not configured: missing STRIPE_SECRET env var');

    const session_id = req.query.session_id;
    if (!session_id) return res.status(400).json({ ok: false, error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      return res.status(403).json({ ok: false, error: 'Session not paid' });
    }

    let keys = [];
    try {
      const meta = session.metadata || {};
      keys = JSON.parse(meta.keys || '[]');
    } catch {
      keys = [];
    }
    if (!Array.isArray(keys) || !keys.length) {
      return res.status(400).json({ ok: false, error: 'No purchased keys found' });
    }

    // Return short-lived signed S3 URLs for original files (no watermark)
    const items = keys.map(k => ({
      key: k,
      url: s3.getSignedUrl('getObject', {
        Bucket: BUCKET,
        Key: k,
        Expires: 60, // seconds
        ResponseContentDisposition: `attachment; filename="${k.split('/').pop() || 'photo.jpg'}"`
      })
    }));

    res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error('purchase/session failed:', err);
    res.status(500).json({ ok: false, error: 'purchase/session failed: ' + err.message });
  }
});

// ---------------- Admin Bulk Upload + Index ----------------
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
        // Normalize to JPEG (auto-rotate, resize, slight brighten)
        let baseName = (f.originalname || 'photo.jpg');
        const looksHeic = /image\/heic|image\/heif/i.test(f.mimetype || '') || /\.(heic|heif)$/i.test(baseName);
        baseName = looksHeic ? baseName.replace(/\.(heic|heif)$/i, '.jpg')
                             : baseName.replace(/\.(jpeg|jpg|png|gif|webp|tif|tiff)$/i, '.jpg');

        let pipeline = sharp(f.buffer).rotate()
          .withMetadata({ orientation: 1 })
          .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
          .ensureAlpha()
          .modulate({ brightness: 1.05, saturation: 1.05 })
          .toFormat('jpeg', { quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' });

        const bodyBuffer = await pipeline.toBuffer();
        const safeName = baseName.replace(/[^\w.\-]/g, '_');
        const key = `event-photos/${eventCode}/${Date.now()}-${safeName}`;

        // 1) Upload to S3 (private)
        await s3.putObject({
          Bucket: BUCKET,
          Key: key,
          Body: bodyBuffer,
          ContentType: 'image/jpeg',
          ACL: 'private'
        }).promise();

        // 2) Index faces (map key -> ExternalImageId with ":" instead of "/")
        const externalId = keyToExternalId(key);
        let facesIndexed = 0;
        let unindexedReasons = [];
        let indexError = null;

        try {
          const idx = await rekognition.indexFaces({
            CollectionId: COLLECTION,
            ExternalImageId: externalId,
            Image: { S3Object: { Bucket: BUCKET, Name: key } },
            DetectionAttributes: [],
            MaxFaces: 30,
            QualityFilter: 'NONE'
          }).promise();

          facesIndexed = Array.isArray(idx.FaceRecords) ? idx.FaceRecords.length : 0;
          if (Array.isArray(idx.UnindexedFaces) && idx.UnindexedFaces.length) {
            unindexedReasons = idx.UnindexedFaces.flatMap(u => u.Reasons || []).map(String);
          }
        } catch (e) {
          indexError = e?.message || String(e);
          console.warn('indexFaces warn:', key, indexError);
        }

        // If 0 faces, also report detectFaces count
        let faceCountInImage = null;
        if (facesIndexed === 0) {
          try {
            const det = await rekognition.detectFaces({
              Image: { S3Object: { Bucket: BUCKET, Name: key } },
              Attributes: ['DEFAULT']
            }).promise();
            faceCountInImage = Array.isArray(det.FaceDetails) ? det.FaceDetails.length : 0;
          } catch (e) {
            faceCountInImage = -1;
            console.warn('detectFaces warn:', key, e?.message);
          }
        }

        results.push({ key, ok: true, facesIndexed, faceCountInImage, unindexedReasons, indexError });
      } catch (e) {
        results.push({ key: null, ok: false, error: e.message });
      }
    }

    res.json({ success: true, event: eventCode, uploaded: results.length, results });
  } catch (err) {
    console.error('admin upload failed:', err);
    res.status(500).json({ success: false, error: 'admin upload failed: ' + err.message });
  }
});

// ---------------- Root ----------------
app.get('/', (req, res) => res.send('LastNightPix API is running'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
// === STRIPE WEBHOOK ===
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const items = session.metadata?.keys?.split(',') || [];
    for (const key of items) {
      try {
        // Move the file from "watermarked" folder to "clean" folder
        const srcKey = `watermarked/${key}`;
        const destKey = `clean/${key}`;
        await s3.copyObject({ Bucket: BUCKET, CopySource: `${BUCKET}/${srcKey}`, Key: destKey, ACL: 'public-read' }).promise();
        console.log(`✅ Moved ${key} to clean folder`);
      } catch (err) {
        console.error('Error moving after purchase', key, err);
      }
    }
  }

  res.json({ received: true });
});

