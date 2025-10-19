require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mime = require('mime-types');
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const fs = require('fs');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const sharp = require('sharp');

// --- Stripe: lazy init so app boots even if STRIPE_SECRET is not set ---
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const secret = process.env.STRIPE_SECRET;
  if (!secret) {
    throw new Error('Stripe not configured: missing STRIPE_SECRET env var');
  }
  const Stripe = require('stripe');
  _stripe = new Stripe(secret, { apiVersion: '2024-06-20' });
  return _stripe;
}

const app = express();
// CORS: allow your Netlify site to call this API
const ALLOWED_ORIGINS = [
  'https://lastnightpix.netlify.app',
  'https://lastnightpix.netlify.app/' // safe duplicate
];

app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin (no origin), and your Netlify site
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// Handle preflight for all routes (esp. /admin/upload)
app.options('*', cors());

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.BUCKET_NAME;
const COLLECTION_ID = process.env.COLLECTION_ID;
const FRONTEND_BASE = process.env.FRONTEND_BASE || 'https://YOUR-SITE.netlify.app';

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: REGION,
});

const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

function eventPrefix(event) { return event ? `event-photos/${event}/` : `event-photos/default/`; }
function toExternalId(s3Key) { return String(s3Key).replace(/\//g, ':'); }
function fromExternalId(extId) { return String(extId).replace(/:/g, '/'); }
function colonPrefix(prefix) { return String(prefix).replace(/\//g, ':'); }

app.get('/health', (_req, res) => res.send('ok'));

/* ---------- Upload & index ---------- */
app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const prefix = eventPrefix(event);

  const tempPath = req.file.path;
  const original = (req.file.originalname || `photo-${Date.now()}.jpg`).replace(/[^\w.\-:/]+/g, '_');
  const s3Key = `${prefix}${Date.now()}-${original}`;

  try {
    const buffer = fs.readFileSync(tempPath);
    await s3.putObject({ Bucket: BUCKET, Key: s3Key, Body: buffer, ContentType: req.file.mimetype || 'image/jpeg', ACL: 'private' }).promise();

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
  } finally { safeUnlink(tempPath); }
});

/* ---------- Match (single) ---------- */
app.post('/match', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedColonPrefix = event ? colonPrefix(eventPrefix(event)) : null;
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
    if (wantedColonPrefix) matches = matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedColonPrefix));

    if (matches.length > 0) {
      const top = matches.sort((a,b)=> (b.Similarity||0)-(a.Similarity||0))[0];
      const s3Key = fromExternalId(top.Face?.ExternalImageId || '');
      return res.json({
        matchFound: true,
        imageUrl: `/preview-image?key=${encodeURIComponent(s3Key)}`,
        fullImageUrl: `/proxy-image?key=${encodeURIComponent(s3Key)}`,
        similarity: top.Similarity,
        s3Key
      });
    }
    res.json({ matchFound: false });
  } catch (err) {
    console.error('Matching failed:', err);
    res.status(500).send('Matching failed: ' + err.message);
  } finally { safeUnlink(tempPath); }
});

/* ---------- Match gallery (many) ---------- */
app.post('/match-gallery', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ matchFound: false, error: 'No file uploaded. Field must be "image".' });
  const event = (req.query.event || '').trim();
  const wantedColonPrefix = event ? colonPrefix(eventPrefix(event)) : null;
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
    if (wantedColonPrefix) matches = matches.filter(m => (m.Face?.ExternalImageId || '').startsWith(wantedColonPrefix));

    const results = matches.sort((a,b)=> (b.Similarity||0)-(a.Similarity||0)).map(m => {
      const s3Key = fromExternalId(m.Face?.ExternalImageId || '');
      return { key: s3Key, similarity: m.Similarity, imageUrl: `/preview-image?key=${encodeURIComponent(s3Key)}` };
    });

    res.json({ matchFound: results.length > 0, count: results.length, results });
  } catch (err) {
    console.error('match-gallery failed:', err);
    res.status(500).json({ matchFound: false, error: 'match-gallery failed: ' + err.message, results: [] });
  } finally { safeUnlink(tempPath); }
});

// ------- Watermarked Preview (tiled diagonal text) -------
app.get('/preview-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');

    // Read config from env or fallback
    const WM_TEXT = process.env.WATERMARK_TEXT || 'LastNightPix.com • PREVIEW';
    const WM_OPACITY = Number(process.env.WATERMARK_OPACITY || '0.18'); // 0..1
    const WM_ANGLE = Number(process.env.WATERMARK_ANGLE || '-30');      // deg
    const MAX_W = Number(process.env.PREVIEW_MAX_W || '1200');          // pixel width for previews
    const JPEG_QUALITY = Number(process.env.PREVIEW_JPEG_QUALITY || '80');

    // Get the original from S3
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    const inputBuffer = obj.Body;

    // Probe dimensions
    const sharp = require('sharp');
    const meta = await sharp(inputBuffer).metadata();

    // Scale down to MAX_W to keep previews light
    const width = Math.min(meta.width || MAX_W, MAX_W);

    // Build a full-frame SVG watermark, tiled & angled
    // We’ll size the canvas to the output width, estimate height from aspect
    const aspect = (meta.width && meta.height) ? meta.height / meta.width : 1.5;
    const outW = width;
    const outH = Math.round(outW * aspect);

    // tile size scales with width
    const tile = Math.round(outW / 4);     // each tile square
    const fontSize = Math.round(tile / 4); // readable but not huge

    // SVG with rotated group & repeated text
    // Use 'fill-opacity' for alpha; sharp respects it
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

    // Composite the SVG over a resized JPEG
    const out = await sharp(inputBuffer)
      .resize({ width: outW })
      .composite([{ input: svgBuffer, gravity: 'center' }])
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .toBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min CDN cache
    res.send(out);
  } catch (err) {
    console.error('preview-image failed:', err);
    res.status(500).send('preview-image failed: ' + err.message);
  }
});

/* ---------- Original (no watermark) ---------- */
app.get('/proxy-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');
    const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    s3Stream.on('error', e => { console.error('proxy-image S3 error:', e); if (!res.headersSent) res.status(404).send('Not found'); });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    s3Stream.pipe(res);
  } catch (err) {
    console.error('proxy-image failed:', err);
    res.status(500).send('proxy-image failed');
  }
});

/* ---------- Stripe: checkout with per-photo bundle pricing ---------- */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const stripe = getStripe();
    const { tier, key, keys, priceCents } = req.body || {};

    // Pricing config
    const SINGLE_PRICE = 199; // $1.99 for single photo
    const MAX_ALBUM = 50;     // safety cap

    let amount = 0;
    let description = '';
    let metadata = {};

    if (tier === 'album') {
      // Validate keys array
      if (!Array.isArray(keys) || keys.length === 0) {
        return res.status(400).json({ error: 'Missing keys for album purchase' });
      }
      const capped = keys.slice(0, MAX_ALBUM);
      const count = capped.length;

      // Auto pricing by count
      // 1–3: $1.99 ea; 4–10: $1.50 ea; 11+: $1.00 ea
      let per = 199;
      if (count >= 4 && count <= 10) per = 150;
      if (count >= 11) per = 100;

      // Allow explicit override via priceCents if sent
      amount = Number.isFinite(priceCents) ? priceCents : (per * count);

      description = `${count} photos @ $${(per/100).toFixed(2)} each (ZIP)`;
      metadata = { tier: 'album', keys: JSON.stringify(capped) };

    } else {
      // default single
      if (!key) return res.status(400).json({ error: 'Missing key for single purchase' });

      // Allow explicit override via priceCents, else $1.99
      amount = Number.isFinite(priceCents) ? priceCents : SINGLE_PRICE;

      description = key.split('/').pop() || 'HD Photo';
      metadata = { tier: 'single', s3_key: key };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: (tier === 'album') ? 'Full Set Download' : 'HD Photo Download',
            description
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      metadata,
      success_url: `${FRONTEND_BASE}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_BASE}/find-gallery.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session: ' + err.message });
  }
});


app.get('/download', async (req, res) => {
  try {
    const stripe = getStripe();
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).send('Missing session_id');

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') return res.status(402).send('Payment required or not verified');

    const key = session.metadata && session.metadata.s3_key;
    if (!key) return res.status(400).send('Missing key in session metadata');

    const s3Stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    s3Stream.on('error', e => { console.error('download S3 error:', e); if (!res.headersSent) res.status(404).send('Not found'); });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
    s3Stream.pipe(res);
  } catch (err) {
    console.error('download failed:', err);
    res.status(500).send('download failed: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
// ------------- Admin bulk upload + Rekognition indexing -------------
app.post('/admin/upload', upload.array('photos', 200), async (req, res) => {
  try {
    // simple bearer token check
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== (process.env.ADMIN_TOKEN || '')) {
      return res.status(401).json({ success:false, error:'Unauthorized' });
    }

    // event code optional; if blank, use "general"
    const eventCode = (req.query.event || 'general').replace(/[^a-zA-Z0-9_\-:.]/g, '');
    if (!req.files || !req.files.length) {
      return res.status(400).json({ success:false, error:'No files uploaded' });
    }

    const results = [];
    for (const f of req.files) {
      try {
        const ext = mime.extension(f.mimetype) || 'jpg';
        const safeName = (f.originalname || `photo.${ext}`).replace(/[^\w.\-]/g, '_');
        const key = `event-photos/${eventCode}/${Date.now()}-${safeName}`;

        // 1) Upload to S3
        await s3.putObject({
          Bucket: BUCKET,
          Key: key,
          Body: f.buffer,
          ContentType: f.mimetype || 'image/jpeg',
          ACL: 'private'
        }).promise();

        // 2) Index faces in Rekognition (OK if none found)
        try {
          await rekognition.indexFaces({
            CollectionId: COLLECTION,
            ExternalImageId: key, // use S3 key as external id
            Image: { S3Object: { Bucket: BUCKET, Name: key } },
            DetectionAttributes: [],
            MaxFaces: 15,
            QualityFilter: 'AUTO'
          }).promise();
        } catch (e) {
          console.warn('indexFaces warn:', key, e?.message);
        }

        results.push({ key, ok:true });
      } catch (e) {
        console.error('admin upload item failed:', e);
        results.push({ key: null, ok:false, error: e.message });
      }
    }

    res.json({ success:true, event: eventCode, uploaded: results.length, results });
  } catch (err) {
    console.error('admin upload failed:', err);
    res.status(500).json({ success:false, error:'admin upload failed: ' + err.message });
  }
});

