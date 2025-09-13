require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const Jimp = require('jimp');

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
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

/* ---------- Watermarked preview ---------- */
app.get('/preview-image', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send('Missing key');

    const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    const img = await Jimp.read(obj.Body);

    const W = img.bitmap.width, H = img.bitmap.height;
    const margin = Math.floor(Math.min(W, H) * 0.03);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const text = 'LASTNIGHTPIX • PREVIEW';
    const tw = Jimp.measureText(font, text);
    const th = Jimp.measureTextHeight(font, text, W);

    const boxW = tw + margin*2, boxH = th + margin*1.2;
    const x = W - boxW - margin, y = H - boxH - margin;

    const overlay = new Jimp(boxW, boxH, 0x00000080);
    img.composite(overlay, x, y);
    img.print(font, x + margin*0.8, y + (boxH - th)/2, text);

    const out = await img.quality(80).getBufferAsync(Jimp.MIME_JPEG);
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(out);
  } catch (err) {
    console.error('preview-image failed:', err);
    res.status(500).send('preview-image failed');
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

/* ---------- Stripe: checkout + download ---------- */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const stripe = getStripe();
    const { key, priceCents } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing key' });

    const amount = Number.isFinite(priceCents) ? priceCents : 500;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'HD Photo Download', description: key.split('/').pop() },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      metadata: { s3_key: key },
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
