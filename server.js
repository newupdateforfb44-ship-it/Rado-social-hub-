require('dotenv').config();
// ── SECURITY: validate critical secrets before starting the service ──────────
(function assertSecrets() {
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (production) {
    const problems = [];
    if (!String(process.env.MONGODB_URI || '').trim()) problems.push('MONGODB_URI is required');
    if (!String(process.env.JWT_SECRET || '').trim()) problems.push('JWT_SECRET is required');
    else if (String(process.env.JWT_SECRET).length < 32) problems.push('JWT_SECRET must be at least 32 characters');
    if (!String(process.env.ADMIN_PASSCODE || '').trim()) problems.push('ADMIN_PASSCODE is required');
    else if (String(process.env.ADMIN_PASSCODE).length < 12) problems.push('ADMIN_PASSCODE must be at least 12 characters');
    if (!String(process.env.ADMIN_SECRET_PATH || '').trim()) problems.push('ADMIN_SECRET_PATH is required');
    else if (String(process.env.ADMIN_SECRET_PATH).trim() === 'rsh-admin-secret') problems.push('ADMIN_SECRET_PATH must not use the insecure default "rsh-admin-secret"');
    if (problems.length) {
      console.error('FATAL: production environment validation failed:');
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('Set the missing/invalid values in your Render Environment settings, then redeploy.');
      process.exit(1);
    }
  } else {
    // Keep the existing local-development requirement for JWT_SECRET.
    if (!process.env.JWT_SECRET) { console.error('FATAL: JWT_SECRET is not set. Set it to a long random string (32+ chars).'); process.exit(1); }
    if (process.env.JWT_SECRET.length < 32) console.warn('SECURITY WARNING: JWT_SECRET is shorter than 32 characters — replace it with a long random string.');
    if (!process.env.ADMIN_PASSCODE) console.warn('SECURITY WARNING: ADMIN_PASSCODE is not set — admin endpoints are locked until you set it.');
    else if (process.env.ADMIN_PASSCODE.length < 12) console.warn('SECURITY WARNING: ADMIN_PASSCODE is shorter than 12 characters — use a long random passcode.');
    if (!String(process.env.ADMIN_SECRET_PATH || '').trim()) console.warn('SECURITY WARNING: ADMIN_SECRET_PATH is not set. Set a long, random private admin path before deployment.');
    else if (String(process.env.ADMIN_SECRET_PATH).trim() === 'rsh-admin-secret') console.warn('SECURITY WARNING: ADMIN_SECRET_PATH uses the insecure default "rsh-admin-secret". Replace it before deployment.');
  }
  if ((process.env.FLW_CLIENT_ID || process.env.FLW_V3_SECRET_KEY) && !(process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_HASH)) {
    console.error('SECURITY ERROR: Flutterwave is configured but FLW_SECRET_HASH is not set. Flutterwave webhooks are now REJECTED (deposits will not auto-credit) until you set FLW_SECRET_HASH to the same value as in the Flutterwave dashboard.');
  }
})();

const _crypto = require('crypto');
const { sealRef, openRef } = require('./lib/opaque-ref');
// Constant-time string compare (stops timing attacks on passcodes / webhook hashes)
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) { _crypto.timingSafeEqual(x, x); return false; }
  return _crypto.timingSafeEqual(x, y);
}
// ── Site branding / look-and-feel lives in ONE file: site.config.js ─────────
// Clone the project, edit site.config.js (or the BRAND_* vars in .env), and the
// whole site renames, recolours and re-titles itself. No need to dig in here.
const { BRAND, brandCss, publicBrand } = require('./site.config');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
if (!googleClient) console.warn(' GOOGLE_CLIENT_ID not set in .env — Google Sign-In will be disabled until configured.');
const app = express();
// Render's lightweight readiness probe; intentionally registered before all middleware/auth.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));
// Shows whether each database is connected. No secrets are returned.
app.get('/healthz/db', async (req, res) => {
  const mysqlDb = require('./lib/mysql');
  res.json({
    mongo: require('mongoose').connection.readyState === 1,
    mysql: mysqlDb.configured() ? await mysqlDb.ping() : 'not configured'
  });
});
// ── Rado Social Hub front end (only these pages exist) ─────────────────────
const RADO_PAGES = { '/': 'home', '/admin-logs': 'admin-logs', '/login': 'login', '/signin': 'login', '/register': 'register', '/signup': 'register',
  '/dashboard': 'dashboard', '/products': 'products', '/sms': 'sms', '/deposit': 'deposit', '/fund-crypto': 'fund-crypto',
  '/transactions': 'transactions', '/orders': 'orders', '/profile': 'profile', '/api-access': 'api-access' };
Object.keys(RADO_PAGES).forEach(route => app.get(route, (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'rado', RADO_PAGES[route] + '.html'));
}));
// Old Rado Social Hub paths now go to the matching Rado page (or the dashboard).
const RADO_REDIRECTS = { '/marketplace': '/products', '/logs': '/products', '/tools': '/products', '/buy-number': '/sms', '/buy-number-1': '/sms',
  '/buy-number-2': '/sms', '/buy-number-3': '/sms', '/active-number': '/sms', '/number-history': '/orders', '/purchases': '/orders',
  '/settings': '/profile', '/wallet': '/deposit', '/support': '/dashboard' };
app.get(Object.keys(RADO_REDIRECTS), (req, res) => res.redirect(302, RADO_REDIRECTS[req.path]));
app.get(/^\/(marketplace|logs|tools)\/.+/, (req, res) => res.redirect(302, '/products'));
app.get(['/games', '/giveaways', '/groups', '/messages', '/referrals',
  '/order-status', '/tutorials', '/help', '/about', '/chat'], (req, res) => res.redirect(302, '/dashboard'));
const rateLimit = require('express-rate-limit');
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','x-admin-passcode'] }));
app.options('*', cors()); // handle pre-flight OPTIONS requests
app.set('trust proxy', 2);

// Per-browser device id (cookie). Used by the sign-up limit so people who share
// one IP (mobile networks, offices) are not blocked because of each other.
app.use((req, res, next) => {
  try {
    const m = /(?:^|;\s*)rsh_did=([a-f0-9]{32})/.exec(req.headers.cookie || '');
    let id = m ? m[1] : '';
    if (!id) {
      id = require('crypto').randomBytes(16).toString('hex');
      res.append('Set-Cookie', 'rsh_did=' + id + '; Max-Age=63072000; Path=/; HttpOnly; SameSite=Lax' + (req.secure ? '; Secure' : ''));
    }
    req.deviceId = id;
  } catch (e) {}
  next();
});
app.use((req, res, next) => {
 // Keep search engines out of the API, admin and account areas, but allow the
 // public marketing/shop pages to be indexed (Google was seeing a site-wide
 // `noindex` header, which blocked rshlogs.com entirely).
 const p = req.path || '';
 const privatePath = /^\/(api|uploads|admin)/i.test(p);
 if (privatePath) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-passcode');
 next();
});

// ── sitemap.xml (Search Console needs a real XML file at the root) ──────────
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://' + (req.headers.host || BRAND.domain).replace(/^www\./, '');
  const paths = ['/', '/login', '/register'];
  const now = new Date().toISOString().slice(0, 10);
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map(u => `  <url><loc>${base}${u}</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq></url>`).join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(body);
});

// ── Brand colours + fonts as a stylesheet, and brand text as JSON ──────────
// Pages already link /brand.css, so editing site.config.js restyles the site.
app.get('/brand.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=300').send(brandCss());
});
app.get('/api/brand', (req, res) => res.json(publicBrand()));
// ── Security hardening ──────────────────────────────────────────────────────
// helmet ships the well-known protective headers (HSTS, no-sniff, frame-deny,
// referrer policy, cross-origin isolation). The Content-Security-Policy is left
// off because the pages use inline scripts, but everything else is on.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));
app.disable('x-powered-by');
// Block obvious payload abuse before any route sees it: NoSQL operator
// injection ({"$gt":""} style) inside JSON bodies and query strings.
function stripOperators(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$') || k.includes('.')) { delete obj[k]; continue; }
    stripOperators(obj[k], depth + 1);
  }
}

// Brute-force protection on the account doors (login, reset, Google).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  trustProxy: true
});
['/api/auth/login', '/api/auth/google', '/api/auth/forgot-password', '/api/auth/reset-password-with-code']
  .forEach(route => app.use(route, authLimiter));

const apiLimiter = rateLimit({
 windowMs: 60 * 1000,
 max: 300, // very generous — 3G Android retries count against this, don't penalise slow connections
 standardHeaders: true,
 legacyHeaders: false,
 skip: (req) => req.method === 'OPTIONS', // never rate-limit CORS pre-flight
 message: { error: 'Too many requests — please slow down.' },
 trustProxy: true
});
app.use('/api/', apiLimiter);
const registerLimiter = rateLimit({
 windowMs: 60 * 60 * 1000, // 1 hour
 max: 5, // 5 signups per IP per hour is generous for shared connections, brutal for bots
 standardHeaders: true,
 legacyHeaders: false,
 message: { error: 'Too many accounts created from this connection recently. Please try again later or contact support.' },
 trustProxy: true
});
app.use('/api/auth/register', registerLimiter);
// Brute-force protection for the admin passcode: 20 FAILED attempts / 15 min / IP (successful calls are not counted)
const adminFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true, skip: (req) => req.method === 'OPTIONS',
  message: { error: 'Too many failed admin attempts. Try again later.' }, trustProxy: true
});
app.use('/api/admin', adminFailLimiter);
const apiV1Limiter = rateLimit({
 windowMs: 60 * 1000,
 max: 60,
 standardHeaders: true,
 legacyHeaders: false,
 message: { error: 'API rate limit exceeded — please slow down your requests.' },
 trustProxy: true
});
app.use('/api/v1/', apiV1Limiter);
app.use(express.json({ limit: '20mb', verify: (req, res, buf) => { if ((req.originalUrl || '').startsWith('/api/webhooks/')) req.rawBody = buf; } })); // rawBody lets us verify Paystack's HMAC signature
require('./lib/extras').early(app, { mongoose }); // admin activity log (price-change history)
// ── RSH request console log ──────────────────────────────────────────────────
// Every API call is logged with method, path, status, duration and the caller,
// so any "it works for me but not for him" report can be traced in the server
// logs instead of guessed at.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const who = req.user?.email || req.user?._id || 'guest';
    const line = `[RSH] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms user=${who}`;
    if (res.statusCode >= 500) console.error(line);
    else if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });
  next();
});
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => { stripOperators(req.body); stripOperators(req.query); next(); });
require('./lib/rado-upgrade').early(app, { mongoose }); // RADO-UPGRADE early
// index:false so '/' reaches the SEO-meta-injecting route below instead of being auto-served raw.
// HTML pages are never cached: visitors were still being served an old copy of
// the home page (and other pages) out of the browser/CDN cache after a deploy.
// Versioned assets (?v=...) keep their normal cache.
// Pages load /js/rsh-ui.js and /js/back-button.js. If those files were uploaded to public/ instead of public/js/,
// serve them from there so confirm pop-ups (used by every Buy button) never 404.
['rsh-ui.js', 'back-button.js'].forEach(name => {
  app.get('/js/' + name, (req, res, next) => {
    const proper = path.join(__dirname, 'public', 'js', name), root = path.join(__dirname, 'public', name);
    if (!fs.existsSync(proper) && fs.existsSync(root)) return res.sendFile(root);
    next();
  });
});
app.use((req, res, next) => { if ((req.path || '').toLowerCase() === '/admin.html') return res.status(404).send('Not found'); next(); });
app.use((req, res, next) => {
  if (/\.(?:bak|backup|old|orig|swp|tmp)$/i.test(req.path || '')) return res.sendStatus(404);
  next();
});
app.use(express.static('public', {
  index: false,
  setHeaders(res, filePath) {
    // SECURITY: files in user-writable folders can never run as a page or script on our domain.
    if (/[\\/]public[\\/](uploads|receipts|files)[\\/]/i.test(filePath)) {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', 'sandbox; default-src \'none\'; img-src \'self\' data:; media-src \'self\'; style-src \'unsafe-inline\'');
      if (!/\.(jpe?g|png|gif|webp|mp4|mov|webm|mp3|m4a|ogg|wav)$/i.test(filePath)) res.set('Content-Disposition', 'attachment');
    }
    if (/\.html?$/i.test(filePath)) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinaryConfigured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
 cloudinary.config({
 cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
 api_key: process.env.CLOUDINARY_API_KEY,
 api_secret: process.env.CLOUDINARY_API_SECRET
 });
 console.log(' Cloudinary connected — uploaded pictures/files will persist permanently');
} else {
 console.warn('WARNING: Cloudinary is not configured (missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET). Uploads will fall back to Render local disk and WILL BE LOST on restart/redeploy. Configure all three Cloudinary variables in Render for persistent production uploads.');
}
const uploadDir = path.join(__dirname, 'public', 'uploads');
const receiptDir = path.join(__dirname, 'public', 'receipts');
const fileDir = path.join(__dirname, 'public', 'files');
[uploadDir, receiptDir, fileDir].forEach(d => {
  // If a stray FILE sits where the folder should be, replace it; otherwise uploads fail with ENOTDIR.
  try { if (fs.existsSync(d) && !fs.statSync(d).isDirectory()) fs.unlinkSync(d); } catch (e) { console.error('Could not clear non-directory at', d, e.message); }
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
// SECURITY: only ever keep a known-safe file extension on disk. A customer-supplied ".html"/".svg"/".js"
// would otherwise be served from our own domain and run as a script (stored XSS).
const SAFE_UPLOAD_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.mp4','.mov','.webm','.mp3','.m4a','.ogg','.wav','.pdf','.txt','.zip','.apk','.rar','.7z','.csv','.docx','.xlsx']);
const safeExt = (name) => { const e = path.extname(String(name || '')).toLowerCase(); return SAFE_UPLOAD_EXT.has(e) ? e : ''; };
const CHAT_ALLOWED_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.mp4','.mov','.webm','.mp3','.m4a','.ogg','.wav','.pdf','.txt','.zip','.csv','.docx','.xlsx']);
function makeStorage(folder, resourceType) {
 if (cloudinaryConfigured) {
 return new CloudinaryStorage({
 cloudinary,
 params: async (req, file) => ({
 folder: `rsh/${folder}`,
 resource_type: resourceType || 'auto', // 'auto' lets Cloudinary handle images vs arbitrary files (zip/apk/etc.)
 public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
 use_filename: false
 })
 });
 }
 const dir = folder === 'receipts' ? receiptDir : folder === 'files' ? fileDir : uploadDir;
 return multer.diskStorage({
 destination: (req, file, cb) => cb(null, dir),
 filename: (req, file, cb) => cb(null, `${folder}_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`)
 });
}
function fileUrl(file) {
 if (!file) return null;
 if (cloudinaryConfigured) return file.path; // Cloudinary gives the full https:// URL in file.path
 return `/${file.destination.includes('receipts') ? 'receipts' : file.destination.includes('files') ? 'files' : 'uploads'}/${file.filename}`;
}
const upload = multer({ storage: makeStorage('uploads', 'image'), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => /jpeg|jpg|png|gif|webp/.test(file.mimetype) ? cb(null, true) : cb(new Error('Images only')) });
const receiptUpload = multer({
 storage: multer.diskStorage({
 destination: (req, file, cb) => cb(null, receiptDir),
 filename: (req, file, cb) => cb(null, `receipt_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`)
 }),
 limits: { fileSize: 10 * 1024 * 1024 },
 fileFilter: (req, file, cb) => /jpeg|jpg|png|gif|webp|pdf/.test(file.mimetype) ? cb(null, true) : cb(new Error('Image or PDF only'))
});
const MAX_SUB_ACCOUNTS = 50;
const subReviewFileFields = Array.from({ length: MAX_SUB_ACCOUNTS }, (_, i) => ({ name: `subReviewFile_${i}`, maxCount: 1 }));
const subTutorialFileFields = Array.from({ length: MAX_SUB_ACCOUNTS }, (_, i) => ({ name: `subTutorialFile_${i}`, maxCount: 1 }));
const uploadLogFields = multer({
 storage: cloudinaryConfigured
 ? new CloudinaryStorage({
 cloudinary,
 params: async (req, file) => {
 const isReview = file.fieldname === 'adminReviewFile' || file.fieldname.startsWith('subReviewFile_');
 const isTutorial = file.fieldname === 'tutorialImages' || file.fieldname === 'tutorialVideo' || file.fieldname.startsWith('subTutorialFile_');
 return {
 folder: file.fieldname === 'deliverableFile' ? 'rsh/files' : isReview ? 'rsh/reviews' : isTutorial ? 'rsh/tutorials' : 'rsh/uploads',
 resource_type: (isReview || isTutorial) ? 'auto' : (file.fieldname === 'deliverableFile' ? 'auto' : 'image'),
 public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
 use_filename: false
 };
 }
 })
 : multer.diskStorage({
 destination: (req, file, cb) => cb(null, file.fieldname === 'deliverableFile' ? fileDir : uploadDir),
 filename: (req, file, cb) => {
 const isReview = file.fieldname === 'adminReviewFile' || file.fieldname.startsWith('subReviewFile_');
 const isTutorial = file.fieldname === 'tutorialImages' || file.fieldname === 'tutorialVideo' || file.fieldname.startsWith('subTutorialFile_');
 const prefix = file.fieldname === 'deliverableFile' ? 'file' : isReview ? 'review' : isTutorial ? 'tutorial' : 'img';
 cb(null, `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`);
 }
 }),
 limits: { fileSize: 100 * 1024 * 1024 },
 fileFilter: (req, file, cb) => {
 const isReview = file.fieldname === 'adminReviewFile' || file.fieldname.startsWith('subReviewFile_');
 const isSubTutorial = file.fieldname.startsWith('subTutorialFile_');
 if (file.fieldname === 'picture' && !/jpeg|jpg|png|gif|webp/.test(file.mimetype)) return cb(new Error('Picture must be an image'));
 if (isReview && !/jpeg|jpg|png|gif|webp|mp4|mov|webm|quicktime/.test(file.mimetype)) return cb(new Error('Review attachment must be an image or video'));
 if (isSubTutorial && !/jpeg|jpg|png|gif|webp|mp4|mov|webm|quicktime/.test(file.mimetype)) return cb(new Error('Sub-account tutorial must be an image or video'));
 if (file.fieldname === 'tutorialImages' && !/jpeg|jpg|png|gif|webp/.test(file.mimetype)) return cb(new Error('Tutorial images must be image files'));
 if (file.fieldname === 'tutorialVideo' && !/mp4|mov|webm|quicktime/.test(file.mimetype)) return cb(new Error('Tutorial video must be a video file'));
 cb(null, true);
 }
}).fields([
 { name: 'picture', maxCount: 1 }, { name: 'deliverableFile', maxCount: 1 }, { name: 'adminReviewFile', maxCount: 1 },
 { name: 'tutorialImages', maxCount: 20 }, { name: 'tutorialVideo', maxCount: 1 },
 ...subReviewFileFields, ...subTutorialFileFields
]);
const reviewUpload = multer({
 storage: cloudinaryConfigured
 ? new CloudinaryStorage({
 cloudinary,
 params: async (req, file) => ({
 folder: 'rsh/reviews',
 resource_type: 'auto', // auto-detects image vs video
 public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
 use_filename: false
 })
 })
 : multer.diskStorage({
 destination: (req, file, cb) => cb(null, uploadDir),
 filename: (req, file, cb) => cb(null, `review_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`)
 }),
 limits: { fileSize: 50 * 1024 * 1024 },
 fileFilter: (req, file, cb) => /jpeg|jpg|png|gif|webp|mp4|mov|webm|quicktime/.test(file.mimetype) ? cb(null, true) : cb(new Error('Image or video only'))
});
const chatUpload = multer({
 storage: cloudinaryConfigured
 ? new CloudinaryStorage({
 cloudinary,
 params: async (req, file) => ({
 folder: 'rsh/chat',
 resource_type: 'auto', // auto-detects image vs video vs raw file
 public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
 use_filename: false
 })
 })
 : multer.diskStorage({
 destination: (req, file, cb) => cb(null, uploadDir),
 filename: (req, file, cb) => cb(null, `chat_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`)
 }),
 limits: { fileSize: 50 * 1024 * 1024 },
 fileFilter: (req, file, cb) => CHAT_ALLOWED_EXT.has(path.extname(String(file.originalname || '')).toLowerCase()) ? cb(null, true) : cb(new Error('This file type is not allowed. Send an image, video, audio, PDF, text, zip or office file.'))
});
const depositTutorialUpload = multer({
 storage: cloudinaryConfigured
 ? new CloudinaryStorage({
 cloudinary,
 params: async (req, file) => ({
 folder: 'rsh/deposit-tutorials',
 resource_type: file.fieldname === 'video' ? 'video' : 'image',
 public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
 use_filename: false
 })
 })
 : multer.diskStorage({
 destination: (req, file, cb) => cb(null, uploadDir),
 filename: (req, file, cb) => cb(null, `deptut_${Date.now()}_${Math.random().toString(36).slice(2)}${safeExt(file.originalname)}`)
 }),
 limits: { fileSize: 100 * 1024 * 1024 },
 fileFilter: (req, file, cb) => {
 if (file.fieldname === 'video' && !/mp4|mov|webm|quicktime/.test(file.mimetype)) return cb(new Error('Tutorial video must be a video file'));
 if (file.fieldname === 'images' && !/jpeg|jpg|png|gif|webp/.test(file.mimetype)) return cb(new Error('Tutorial images must be image files'));
 cb(null, true);
 }
}).fields([{ name: 'video', maxCount: 1 }, { name: 'images', maxCount: 10 }]);
mongoose.connect(process.env.MONGODB_URI, {
 serverSelectionTimeoutMS: 10000,
 socketTimeoutMS: 45000,
 retryWrites: true,
 w: 'majority'
})
 .then(async () => {
   console.log('MongoDB connected');
   try {
     const _sl = await SiteLinks.findById('main');
     // Self-healing migration: corrects known-outdated contact numbers in the live database
     // automatically on server boot. Only matches specific OLD values — once the number is
     // '2348128358120' (or an admin sets any other custom number later), this never touches it
     // again, so it's safe to leave running indefinitely.
     const outdatedNumbers = ['2349154834677', '2348124960204'];
     let finalNumber = '2348128358120';
     if (!_sl) {
       await SiteLinks.create({ _id: 'main', whatsappNumber: '2348128358120', adminPhone: '2348128358120' });
     } else if (!_sl.whatsappNumber || outdatedNumbers.includes(_sl.whatsappNumber)) {
       await SiteLinks.findByIdAndUpdate('main', { $set: { whatsappNumber: '2348128358120', adminPhone: '2348128358120' } });
       console.log('[startup] contact number corrected to 2348128358120');
     } else {
       finalNumber = _sl.adminPhone || _sl.whatsappNumber; // an admin already set a different custom number — respect it
     }
     // Keep the WhatsApp-notification env var in sync with the database value, so a stale
     // ADMIN_WHATSAPP set in the hosting platform's environment variables can never override
     // what's actually configured in the admin panel.
     process.env.ADMIN_WHATSAPP = finalNumber;
   } catch(e) { console.error('[startup] site-links init:', e.message); }
 })
 .catch(err => console.error('MongoDB connection error:', err));
mongoose.connection.on('disconnected', () => {
 console.warn(' MongoDB disconnected — attempting reconnect…');
 setTimeout(() => {
 mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, retryWrites: true, w: 'majority' })
 .catch(e => console.error('Reconnect failed:', e.message));
 }, 3000);
});
mongoose.connection.on('reconnected', () => console.log(' MongoDB reconnected'));
// ── MySQL (optional, runs beside MongoDB) ───────────────────────────────────
const mysqlDb = require('./lib/mysql');
mysqlDb.init().catch(e => console.error('[mysql] init error:', e.message));
const userSchema = new mongoose.Schema({
 name: { type: String, required: true, trim: true },
 email: { type: String, required: true, unique: true, lowercase: true },
 password: { type: String }, // not required — Google-only accounts have no password
 googleId: { type: String, unique: true, sparse: true },
 authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
 profilePicture: { type: String, default: '' },
 flwCustomerId: { type: String, default: '' }, // Flutterwave v4 customer ID, created once and reused for future Flutterwave calls
 referralCode: { type: String, unique: true, sparse: true }, // this user's own shareable code
 referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // who referred this user, if anyone (set once, at signup)
 balance: { type: Number, default: 0 },
 restricted: { type: Boolean, default: false },
 restrictedReason: { type: String, default: '' },
 restrictedAt: { type: Date },
 lastLoginAt: { type: Date },
 lastLoginIp: { type: String },
 lastLoginUserAgent: { type: String },
 signupFingerprint: { type: String, default: '', index: true }, // ip+device hash — powers the 5-accounts-per-person rule
 signupIp: { type: String, default: '' }, // captured once at registration — used to detect referral/signup abuse (many accounts from one IP)
 lastActiveAt: { type: Date }, // updated (throttled) on authenticated requests — powers the "Active Now" list
 apiKey: { type: String, unique: true, sparse: true },
 apiSecret: { type: String },
 apiEnabled: { type: Boolean, default: false },
 apiKeyCreatedAt: { type: Date },
 apiLastUsedAt: { type: Date },
 contactPhone: { type: String, default: '' }, // user's contact number in full E.164 format (e.g. +2348012345678 / +447700900000)
 country: { type: String, default: '' },          // ISO-3166-1 alpha-2 of the user's country — drives payment methods & currency
 language: { type: String, default: 'en' },       // UI language chosen by the user
 displayCurrency: { type: String, default: '' },  // currency prices are shown in (the ledger stays NGN)
 virtualAccount: {
 enabled: { type: Boolean, default: false }, // true once created — self-serve or by admin
 accountNumber: { type: String, default: '' },
 bankName: { type: String, default: '' },
 accountName: { type: String, default: '' },
 flwRef: { type: String, default: '' }, // Flutterwave's own reference
 createdAt: { type: Date }
 },
 paystackVirtualAccount: { // dedicated virtual account issued by Paystack (Nigeria)
 enabled: { type: Boolean, default: false },
 accountNumber: { type: String, default: '' },
 bankName: { type: String, default: '' },
 accountName: { type: String, default: '' },
 customerCode: { type: String, default: '' }, // Paystack customer code (CUS_...) — how we match payments back to the user
 customerId: { type: String, default: '' },
 dedicatedAccountId: { type: String, default: '' },
 createdAt: { type: Date }
 },
 notificationsSeenAt: { type: Date, default: null },
 loginHistory: [{
 at: { type: Date, default: Date.now },
 ip: String,
 userAgent: String
 }],
 purchaseDetails: [{
 logId: mongoose.Schema.Types.ObjectId,
 logTitle: String,
 logType: { type: String, enum: ['log', 'tool'], default: 'log' },
 logDetails: String,
 toolLink: String,
 deliveryType: { type: String, enum: ['link', 'file'], default: 'link' },
 deliverableFile: String,
 deliverableFileName: String,
 pricePaid: Number,
 source: { type: String, default: 'market1' }, // 'market1' manual logs
 purchasedAt: { type: Date, default: Date.now }
 }],
 createdAt: { type: Date, default: Date.now }
});
const categorySchema = new mongoose.Schema({
 name: { type: String, required: true, unique: true, trim: true },
 showReviews: { type: Boolean, default: true }, // if false, reviews are hidden for every log in this category
 createdAt: { type: Date, default: Date.now }
});
const subAccountSchema = new mongoose.Schema({
 label: { type: String, required: true }, // e.g. "Account 1", or the phone number itself
 details: { type: String, default: '' },
 toolLink: { type: String, default: '' },
 deliveryType: { type: String, enum: ['link', 'file'], default: 'link' },
 deliverableFile: { type: String, default: '' },
 deliverableFileName: { type: String, default: '' },
 picture: { type: String, default: '' },
 price: { type: Number, required: true },
 sold: { type: Boolean, default: false },
 soldTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
 soldAt: { type: Date },
 reviews: [{
 userId: mongoose.Schema.Types.ObjectId,
 userName: String,
 rating: { type: Number, min: 1, max: 5 },
 reviewType: { type: String, enum: ['text', 'image', 'video', 'link'], default: 'text' }, // what type of review content
 content: { type: String, maxlength: 2000 }, // text comment, image URL, video URL, or link
 createdAt: { type: Date, default: Date.now }
 }],
 adminReview: {
 reviewType: { type: String, enum: ['none', 'text', 'image', 'video', 'link'], default: 'none' },
 content: { type: String, default: '' }, // text comment, image URL, video URL, or link — depending on reviewType
 rating: { type: Number, min: 1, max: 5 }
 },
 tutorial: {
 tutorialType: { type: String, enum: ['none', 'images', 'video', 'link'], default: 'none' },
 images: [{ type: String }],
 videoUrl: { type: String, default: '' },
 linkUrl: { type: String, default: '' }
 },
 createdAt: { type: Date, default: Date.now }
});
const logSchema = new mongoose.Schema({
 type: { type: String, enum: ['log', 'tool'], default: 'log' },
 listingType: { type: String, enum: ['simple', 'folder'], default: 'simple' },
 title: { type: String, required: true },
 description: { type: String, required: true },
 details: String,
 toolLink: String,
 deliveryType: { type: String, enum: ['link', 'file'], default: 'link' },
 deliverableFile: String,
 deliverableFileName: String,
 toolQty: { type: Number, default: 0 },
 maxPurchases: { type: Number, default: 1 },
 picture: String,
 price: { type: Number },
 soldCount: { type: Number, default: 0 },
 reviews: [{
 userId: mongoose.Schema.Types.ObjectId,
 userName: String,
 rating: { type: Number, min: 1, max: 5 },
 reviewType: { type: String, enum: ['text', 'image', 'video', 'link'], default: 'text' },
 content: { type: String, maxlength: 2000 },
 createdAt: { type: Date, default: Date.now }
 }],
 adminReview: {
 reviewType: { type: String, enum: ['none', 'text', 'image', 'video', 'link'], default: 'none' },
 content: { type: String, default: '' }, // text comment, image URL, video URL, or link — depending on reviewType
 rating: { type: Number, min: 1, max: 5 }
 },
 subAccounts: [subAccountSchema],
 category: { type: String, default: 'General' },
 available: { type: Boolean, default: true },
 tutorial: {
 tutorialType: { type: String, enum: ['none', 'images', 'video', 'link'], default: 'none' },
 images: [{ type: String }], // ordered list of image URLs, shown one-at-a-time with a Next button
 videoUrl: { type: String, default: '' },
 linkUrl: { type: String, default: '' }
 },
 createdAt: { type: Date, default: Date.now }
});
const transactionSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 type: { type: String, enum: ['deposit', 'purchase', 'admin_credit', 'admin_debit', 'debit', 'referral_commission', 'refund'], required: true },
 amount: { type: Number, required: true },
 description: String,
 status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
 // Idempotency key. One Flutterwave charge can only ever produce ONE wallet
 // transaction: the unique+sparse index makes a second insert throw instead of
 // silently crediting the same deposit twice.
 txRef: { type: String, index: true, unique: true, sparse: true },
 reversed: { type: Boolean, default: false },
 reversedAt: { type: Date, default: null },
 reversalReason: { type: String, default: '' },
 createdAt: { type: Date, default: Date.now }
});
const receiptSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 userName: String,
 userEmail: String,
 claimedAmount: Number,
 claimedBank: String,
 claimedAccountName: String,
 claimedAccountNumber: String,
 extractedAmount: Number,
 extractedDate: String,
 extractedTime: String,
 extractedReference: String,
 extractedSenderName: String,
 extractedRecipientName: String,
 extractedRecipientAccount: String,
 extractedBank: String,
 receiptFingerprint: { type: String, unique: true, sparse: true },
 aiVerdict: { type: String, enum: ['approved', 'rejected', 'manual_review'], default: 'manual_review' },
 aiConfidence: Number,
 aiReason: String,
 fakeTransferFlags: [String],
 receiptPath: String,
 status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
 adminNote: String,
 seenByUser: { type: Boolean, default: true }, // false once status changes away from pending, until user views it
 createdAt: { type: Date, default: Date.now }
});
const supportSchema = new mongoose.Schema({
 userId: mongoose.Schema.Types.ObjectId,
 name: String, email: String, subject: String, message: String,
 status: { type: String, enum: ['open', 'resolved'], default: 'open' },
 adminReply: String,
 seenByUser: { type: Boolean, default: true }, // false once admin replies, until user views it
 createdAt: { type: Date, default: Date.now }
});
const visitorStatsSchema = new mongoose.Schema({
 key: { type: String, default: 'global', unique: true },
 visitors: { type: Number, default: 0 }
});
const visitorLogSchema = new mongoose.Schema({
 visitorId: { type: String, required: true, unique: true },
 firstSeen: { type: Date, default: Date.now },
 lastSeen: { type: Date, default: Date.now },
 visitCount: { type: Number, default: 1 }
});
const depositTutorialSchema = new mongoose.Schema({
 method: { type: String, enum: ['paymentlink'], required: true, unique: true },
 videoUrl: { type: String, default: '' },
 imageUrls: [{ type: String }],
 caption: { type: String, default: '' },
 updatedAt: { type: Date, default: Date.now }
});
const DepositTutorial = mongoose.model('DepositTutorial', depositTutorialSchema);
const paymentMethodSettingSchema = new mongoose.Schema({
 method: { type: String, enum: ['paymentlink'], required: true, unique: true },
 enabled: { type: Boolean, default: true },
 disabledMessage: { type: String, default: '' }, // optional note shown to users, e.g. "Under maintenance"
 updatedAt: { type: Date, default: Date.now }
});
const PaymentMethodSetting = mongoose.model('PaymentMethodSetting', paymentMethodSettingSchema);
// ── PAYMENT GATEWAYS (Flutterwave / Paystack) — switchable from the admin panel ──────────────
// One row per gateway. No row yet = the built-in default: Flutterwave ON (so existing sites keep
// working exactly as before) and Paystack OFF until an admin turns it on.
const gatewaySettingSchema = new mongoose.Schema({
 gateway: { type: String, enum: ['flutterwave', 'paystack', 'korapay'], required: true, unique: true },
 enabled: { type: Boolean, default: true },
 disabledMessage: { type: String, default: '' },
 updatedAt: { type: Date, default: Date.now }
});
const GatewaySetting = mongoose.model('GatewaySetting', gatewaySettingSchema);
const GATEWAY_LIST = ['flutterwave', 'paystack', 'korapay'];
const GATEWAY_LABELS = { flutterwave: 'Flutterwave', paystack: 'Paystack', korapay: 'Kuropay' };
const GATEWAY_DEFAULT_ENABLED = { flutterwave: true, paystack: false, korapay: false };
function gatewayConfigured(g) {
 if (g === 'flutterwave') return !!process.env.FLW_V3_SECRET_KEY;
 if (g === 'paystack') return !!process.env.PAYSTACK_SECRET_KEY;
 if (g === 'korapay') return !!process.env.KORAPAY_SECRET_KEY;
 return false;
}
// { flutterwave: { enabled, configured, available, disabledMessage }, paystack: {...} }
// `available` = switched ON by the admin AND its API keys exist on the server.
async function getGatewayStates() {
 let docs = [];
 try { docs = await GatewaySetting.find({}); }
 catch (e) { console.error('[RSH] getGatewayStates failed, using defaults:', e.message); }
 const out = {};
 for (const g of GATEWAY_LIST) {
  const d = docs.find(x => x.gateway === g);
  const enabled = d ? d.enabled !== false : GATEWAY_DEFAULT_ENABLED[g];
  const configured = gatewayConfigured(g);
  out[g] = { enabled, configured, available: enabled && configured, disabledMessage: (d && d.disabledMessage) || '' };
 }
 return out;
}
const siteLinksSchema = new mongoose.Schema({
 _id: { type: String, default: 'main' },
 whatsappNumber: { type: String, default: '2348128358120' }, // digits only, no + or spaces — used as wa.me/{number}
 adminPhone: { type: String, default: '2348128358120' }, // admin contact number shown on support/contact pages
 whatsappGroupLink: { type: String, default: '#' },
 whatsappChannelLink: { type: String, default: '#' },
 // Telegram + support contact details are admin-editable (Admin → Site Links) and are
 // applied site-wide by applySiteLinks() in public/script.js. They MUST live on the
 // schema: Mongoose silently drops unknown paths, which is why saving a new Telegram
 // username used to appear to work but every page kept the old @rshlogs link.
 telegramUsername: { type: String, default: 'rshlogs' },
 telegramLink: { type: String, default: '#' },
  telegramChannelLink: { type: String, default: '' },
  telegramCommunityLink: { type: String, default: '' },
 whatsappChatLink: { type: String, default: '' },
 supportHours: { type: String, default: '' },
 logoUrl: { type: String, default: '' },
 updatedAt: { type: Date, default: Date.now }
});
const SiteLinks = mongoose.model('SiteLinks', siteLinksSchema);

// ── Admin email notifications ────────────────────────────────────────────────
// No SMTP dependency: we post to Resend, the one and only mail provider used by
// this site. With no key set the alert still lands in the admin warning banner
// and the error log, so nothing is ever silently lost.
async function sendAdminEmail(to, subject, text) {
  const target = String(to || process.env.ADMIN_ALERT_EMAIL || '').trim();
  if (!target) return { sent: false, reason: 'No admin alert email configured' };
  const from = process.env.ALERT_EMAIL_FROM || ('alerts@' + BRAND.domain);
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'No RESEND_API_KEY configured' };
  try {
    await axios.post('https://api.resend.com/emails',
      { from, to: [target], subject, text },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 });
    return { sent: true, via: 'resend' };
  } catch (e) {
    console.error('[alert-email] failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

const badgeSchema = new mongoose.Schema({
 name: { type: String, required: true, trim: true },
 icon: { type: String, default: '' }, // emoji shown next to the user's name
 description: { type: String, default: '' },
 criteriaType: { type: String, enum: ['manual', 'total_spent', 'referral_count', 'purchase_count'], default: 'manual' },
 criteriaValue: { type: Number, default: 0 }, // threshold for the criteria type (ignored for 'manual')
 enabled: { type: Boolean, default: true },
 createdAt: { type: Date, default: Date.now }
});
const Badge = mongoose.model('Badge', badgeSchema);
const userBadgeSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 badgeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Badge', required: true },
 awardedAt: { type: Date, default: Date.now }
});
userBadgeSchema.index({ userId: 1, badgeId: 1 }, { unique: true });
const UserBadge = mongoose.model('UserBadge', userBadgeSchema);
async function checkAndAwardBadges(userId) {
 try {
 const rules = await Badge.find({ enabled: true, criteriaType: { $ne: 'manual' } });
 if (!rules.length) return;
 for (const rule of rules) {
 let qualifies = false;
 if (rule.criteriaType === 'total_spent') {
 const agg = await Transaction.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(userId), type: 'purchase', status: 'success' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
 qualifies = (agg[0]?.total || 0) >= rule.criteriaValue;
 } else if (rule.criteriaType === 'purchase_count') {
 const count = await Transaction.countDocuments({ userId, type: 'purchase', status: 'success' });
 qualifies = count >= rule.criteriaValue;
 } else if (rule.criteriaType === 'referral_count') {
 const count = await User.countDocuments({ referredBy: userId });
 qualifies = count >= rule.criteriaValue;
 }
 if (qualifies) {
 await UserBadge.findOneAndUpdate({ userId, badgeId: rule._id }, { userId, badgeId: rule._id }, { upsert: true });
 }
 }
 } catch (e) { console.error('Badge check failed:', e.message); }
}
async function getSiteLinks() {
 let doc = await SiteLinks.findById('main');
 if (!doc) doc = await SiteLinks.create({ _id: 'main', whatsappNumber: '2348128358120', adminPhone: '2348128358120' });
 return doc;
}
const SOLD_SUBACCOUNT_VISIBLE_MS = 24 * 60 * 60 * 1000; // 24 hours
function stripStaleSoldSubAccounts(subAccounts) {
 const cutoff = Date.now() - SOLD_SUBACCOUNT_VISIBLE_MS;
 return (subAccounts || []).filter(sa => !sa.sold || !sa.soldAt || new Date(sa.soldAt).getTime() >= cutoff);
}
const adSchema = new mongoose.Schema({
 title: { type: String, default: '' },
 imageUrl: String,
 link: { type: String, required: true },
 active: { type: Boolean, default: true },
 createdAt: { type: Date, default: Date.now }
});
const giveawaySchema = new mongoose.Schema({
 title: { type: String, required: true },
 description: { type: String, default: '' },
 category: { type: String, default: '' }, // e.g. "Gmail", "Netflix" — cosmetic label only
 credentials: { type: String, required: true }, // the actual login/password revealed to the winner
 imageUrl: { type: String, default: '' },
 startsAt: { type: Date, default: Date.now }, // claiming is blocked server-side until this time
 status: { type: String, enum: ['active', 'claimed'], default: 'active' },
 winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
 winnerName: { type: String, default: '' },
 winnerProfilePicture: { type: String, default: '' },
 claimedAt: { type: Date },
 createdAt: { type: Date, default: Date.now }
});
const systemErrorSchema = new mongoose.Schema({
 source: { type: String, required: true }, // e.g. 'ultramsg'
 message: { type: String, required: true },
 detail: { type: String, default: '' },
 context: { type: mongoose.Schema.Types.Mixed },
 resolved: { type: Boolean, default: false },
 createdAt: { type: Date, default: Date.now }
});
const chatGroupSchema = new mongoose.Schema({
 name: { type: String, required: true, trim: true },
 description: { type: String, default: '' },
 active: { type: Boolean, default: true },
 createdAt: { type: Date, default: Date.now }
});
const chatMessageSchema = new mongoose.Schema({
 groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatGroup', required: true, index: true },
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 userName: String,
 text: { type: String, maxlength: 1000, default: '' },
 attachmentUrl: { type: String, default: '' },
 attachmentType: { type: String, enum: ['', 'image', 'video', 'file'], default: '' },
 attachmentName: { type: String, default: '' },
 deleted: { type: Boolean, default: false },
 createdAt: { type: Date, default: Date.now }
});
const conversationSchema = new mongoose.Schema({
 participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }],
 lastMessageText: { type: String, default: '' },
 lastMessageAt: { type: Date, default: Date.now },
 createdAt: { type: Date, default: Date.now }
});
const directMessageSchema = new mongoose.Schema({
 conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
 senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 senderName: String,
 text: { type: String, maxlength: 1000, default: '' },
 attachmentUrl: { type: String, default: '' },
 attachmentType: { type: String, default: '' }, // 'image' | 'video' | 'audio' | 'file'
 attachmentName: { type: String, default: '' },
 readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
 deleted: { type: Boolean, default: false },
 createdAt: { type: Date, default: Date.now }
});
const Category = mongoose.model('Category', categorySchema);
// Password-reset / engagement fields. These MUST be on the schema BEFORE the
// model is compiled, otherwise Mongoose never saves or reads them and every
// reset code shows as "invalid".
userSchema.add({
 resetCodeHash: { type: String, default: '' },
 resetCodeExpires: { type: Date, default: null },
 resetCodeAttempts: { type: Number, default: 0 },
 resetCodeSentAt: { type: Date, default: null },
 passwordChangedAt: { type: Date, default: null },
 lastWinbackEmailAt: { type: Date, default: null }
});
const User = mongoose.model('User', userSchema);
const Log = mongoose.model('Log', logSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const referralEarningSchema = new mongoose.Schema({
 referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
 purchaseAmount: { type: Number, required: true },
 commission: { type: Number, required: true },
 itemLabel: { type: String, default: '' },
 createdAt: { type: Date, default: Date.now }
});
const ReferralEarning = mongoose.model('ReferralEarning', referralEarningSchema);
const Receipt = mongoose.model('Receipt', receiptSchema);
const Support = mongoose.model('Support', supportSchema);
const VisitorStats = mongoose.model('VisitorStats', visitorStatsSchema);
const VisitorLog = mongoose.model('VisitorLog', visitorLogSchema);
const Ad = mongoose.model('Ad', adSchema);
const Giveaway = mongoose.model('Giveaway', giveawaySchema);
const weeklyRewardSchema = new mongoose.Schema({
 weekKey: { type: String, required: true, unique: true },
 winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
 winnerName: { type: String, default: '' },
 purchaseCount: { type: Number, default: 0 },
 amount: { type: Number, default: 50 },
 paidAt: { type: Date, default: Date.now }
});
const WeeklyReward = mongoose.model('WeeklyReward', weeklyRewardSchema);
const SystemError = mongoose.model('SystemError', systemErrorSchema);
app.post('/api/client-error-log', async (req, res) => {
 try {
 const { message, url, status, contentType, connectionType, downlinkMbps, userAgent } = req.body || {};
 if (!message || typeof message !== 'string' || message.length > 500) return res.status(400).end();
 await SystemError.create({
 source: 'client',
 message: String(message).slice(0, 500),
 detail: `URL: ${String(url || '').slice(0, 300)} | HTTP status: ${status ?? 'none (network-level failure)'} | Content-Type: ${contentType || 'n/a'} | Connection: ${connectionType || 'unknown'} (${downlinkMbps ?? '?'} Mbps est.) | UA: ${String(userAgent || '').slice(0, 300)}`,
 context: { url, status, contentType, connectionType, downlinkMbps }
 });
 res.status(204).end();
 } catch (e) { res.status(204).end(); } // never let logging itself surface an error to the user
});
const ChatGroup = mongoose.model('ChatGroup', chatGroupSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const DirectMessage = mongoose.model('DirectMessage', directMessageSchema);

// ── ANNOUNCEMENTS (admin "Notifications bar") ────────────────────────────────
// An announcement is a broadcast the owner posts from the admin panel. Every user
// sees it once as a popup with three actions: "Don't show again" (never shown to
// that user again), "Cancel" (close for now, shown again next session) and
// "Read more" (opens the admin-provided link, or the in-app notifications page
// when no link was set).
//
// Per-user state lives in its own collection keyed by (announcementId, userId),
// so "don't show again" and the read/unread styling survive logout, cache
// clearing and new devices — it is never kept in localStorage alone.
const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true },
  link: { type: String, default: '' },          // optional "Read more" destination
  linkLabel: { type: String, default: '' },
  image: { type: String, default: '' },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Log', default: null },
  level: { type: String, enum: ['info', 'success', 'warning', 'urgent'], default: 'info' },
  active: { type: Boolean, default: true },
  pinned: { type: Boolean, default: false },
  createdBy: { type: String, default: 'admin' },
  expiresAt: { type: Date, default: null },
}, { timestamps: true });
const Announcement = mongoose.model('Announcement', announcementSchema);

const announcementStateSchema = new mongoose.Schema({
  announcementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  readAt: { type: Date, default: null },
  dismissedAt: { type: Date, default: null },   // set by "Don't show again"
  viewedAt: { type: Date, default: null },      // first time this user actually saw the popup
  views: { type: Number, default: 0 },          // how many times it was shown to this user
  clickedAt: { type: Date, default: null },     // pressed "Read more"
  clicks: { type: Number, default: 0 },
}, { timestamps: true });
announcementStateSchema.index({ announcementId: 1, userId: 1 }, { unique: true });
const AnnouncementState = mongoose.model('AnnouncementState', announcementStateSchema);

/** Announcements that are live right now (active and not expired). */
const liveAnnouncementFilter = () => ({
  active: true,
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
});

let rshCampaigns = null; // set when lib/campaigns.js is mounted at the bottom of this file
// Set once lib/engagement.js is mounted at the bottom of this file. It owns the
// device/session records, so tokens issued before it existed keep working.
let rshEngagement = null;
/**
 * Mark a user as active right now (throttled to one write every 2 minutes).
 * Called from every authenticated path — token auth, optional auth, API keys
 * and the heartbeat — so the admin "Online now" list shows old accounts too,
 * not only the ones that happened to hit a token-protected endpoint.
 */
function touchActivity(user) {
 if (!user?._id) return;
 const last = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
 if (Date.now() - last <= 2 * 60 * 1000) return;
 user.lastActiveAt = new Date();
 User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date(), lastSeen: new Date() } })
 .catch(e => console.error('[RSH] touchActivity failed:', e.message));
}
const auth = async (req, res, next) => {
  let decoded;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || token === 'null' || token === 'undefined') return res.status(401).json({ error: 'Please log in again.', sessionEnded: true });
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Your session expired — please log in again.', sessionEnded: true }); }
  try {
  // Sliding session: anyone active keeps getting a fresh token, so it never silently expires mid-use.
  if (decoded.exp && decoded.exp * 1000 - Date.now() < 6 * 24 * 60 * 60 * 1000) {
    const fresh = { id: decoded.id }; if (decoded.sid) fresh.sid = decoded.sid;
    res.setHeader('X-Refresh-Token', jwt.sign(fresh, process.env.JWT_SECRET, { expiresIn: '30d' }));
    res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
  }
  req.user = await User.findById(decoded.id).select('-password');
  if (!req.user) return res.status(401).json({ error: 'User not found' });
  if (req.user.restricted) return res.status(403).json({ error: 'Your account has been restricted. Contact support for help.', restricted: true });
  // This device may have been signed out from another device's Settings page.
  if (rshEngagement && decoded.sid && !(await rshEngagement.touchSession(decoded.sid, req.user._id))) {
    return res.status(401).json({ error: 'This device was signed out. Please log in again.', sessionEnded: true });
  }
 if (!req.user.referralCode) {
 req.user.referralCode = await generateUniqueReferralCode();
 await req.user.save();
 }
 touchActivity(req.user);
 } catch (e) {
 console.error('[auth] lookup failed (not a token problem):', e.message);
 return res.status(503).json({ error: 'Temporary server hiccup — please try again in a moment.' });
 }
 next();
};
const optionalAuth = async (req, res, next) => {
 try {
 const token = req.headers.authorization?.split(' ')[1];
 if (!token) return next();
 const decoded = jwt.verify(token, process.env.JWT_SECRET);
 const user = await User.findById(decoded.id).select('-password');
 if (user && !user.restricted) { req.user = user; touchActivity(user); }
 } catch { /* an invalid/expired token just means "not logged in" here, not an error */ }
 next();
};
const apiKeyAuth = async (req, res, next) => {
 try {
 const key = req.headers['x-api-key'];
 const secret = req.headers['x-api-secret'];
 if (!key || !secret) return res.status(401).json({ error: 'Missing X-API-Key or X-API-Secret header' });
 const user = await User.findOne({ apiKey: key, apiEnabled: true }).select('-password');
 if (!user) return res.status(401).json({ error: 'Invalid API key or secret' });
 const stored = String(user.apiSecret || '');
 const hashed = stored.startsWith('sha256:');
 const okSecret = hashed ? safeEqual('sha256:' + _crypto.createHash('sha256').update(String(secret)).digest('hex'), stored) : safeEqual(secret, stored);
 if (!okSecret) return res.status(401).json({ error: 'Invalid API key or secret' });
 if (!hashed) user.apiSecret = 'sha256:' + _crypto.createHash('sha256').update(String(secret)).digest('hex'); // one-time upgrade of old plain-text secrets
 if (user.restricted) return res.status(403).json({ error: 'This account has been restricted', restricted: true });
 user.apiLastUsedAt = new Date();
 await user.save();
 req.apiUser = user;
 next();
 } catch (e) { res.status(500).json({ error: 'API auth error' }); }
};
const adminAuth = (req, res, next) => {
 const p = req.headers['x-admin-passcode'];
 if (!p || !safeEqual(p, process.env.ADMIN_PASSCODE)) return res.status(403).json({ error: 'Access denied' });
 req.adminRole = 'super';
 next();
};
const opsLib = require('./lib/ops');
// Owner-only panel: every admin route uses the passcode (anyAdminAuth is kept as an alias so existing route wiring still works).
const anyAdminAuth = adminAuth;
// Control room: maintenance switch, payment limits, rate limits, daily summary, backup (lib/ops.js)
const opsCtl = opsLib.register({ app, mongoose, User, Transaction, auth, anyAdminAuth, adminAuth, sendAdminEmail });
const { brandLogoFor } = require('./lib/brand-logos').register({
 app, mongoose, adminAuth, cloudinary, cloudinaryConfigured
});
// Provider integration for SMS Numbers + Products (BENOTP_API_KEY) - see lib/benotp.js
require('./lib/benotp').register(app, { mongoose, User, Transaction, auth, anyAdminAuth, adminAuth, sendAdminEmail, brandLogoFor });

// Owner-only integration diagnostics. This reports readiness without ever
// returning provider credentials, so the admin can distinguish a disabled
// switch from a missing API key before customers try to purchase.
app.get('/api/admin/providers/status', anyAdminAuth, async (req, res) => {
  try {
    const rows = [
      { id: 'benotp', name: 'BenOTP — SMS numbers + products', configured: !!String(process.env.BENOTP_API_KEY || '').trim(), enabled: true, credentialSource: 'Render environment: BENOTP_API_KEY' }
    ].map(x => ({ ...x, ready: !!x.configured && !!x.enabled, state: !x.configured ? 'missing_credentials' : (!x.enabled ? 'disabled' : 'ready') }));
    res.set('Cache-Control', 'no-store');
    res.json({ providers: rows, readyCount: rows.filter(x => x.ready).length, checkedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: 'Could not check provider readiness.' }); }
});
// Welcome popup (WhatsApp channel promo) - settings editable in Admin -> Welcome Popup
require('./lib/welcomepopup').register(app, { mongoose, adminAuth });
function sanitizeUser(u) {
 return {
 id: u._id, name: u.name, email: u.email, balance: u.balance || 0,
 restricted: !!u.restricted, createdAt: u.createdAt,
 profilePicture: u.profilePicture || '', authProvider: u.authProvider || 'local',
 referralCode: u.referralCode || '', contactPhone: u.contactPhone || '',
 country: u.country || '', language: u.language || 'en', displayCurrency: u.displayCurrency || '',
 virtualAccount: u.virtualAccount || { enabled: false, accountNumber: '', bankName: '', accountName: '', flwRef: '' }
 };
}
function generateFileFingerprint(filePath) {
 try {
 const buffer = fs.readFileSync(filePath);
 return crypto.createHash('sha256').update(buffer).digest('hex');
 } catch (e) {
 console.error('Fingerprint error:', e.message);
 return null;
 }
}
const { createWorker } = require('tesseract.js');
async function analyzeReceiptWithAI(imagePath, claimedAmount, claimedBank, claimedAccountName) {
 const flags = [];
 const extracted = {};
 let confidence = 60; // start neutral
 try {
 console.log(' Running OCR on receipt...');
 const worker = await createWorker('eng');
 const { data: { text } } = await worker.recognize(imagePath);
 await worker.terminate();
 const raw = text || '';
 const upper = raw.toUpperCase();
 console.log('OCR text:', raw.substring(0, 300));
 const fakeAppKeywords = [
 'FAKE', 'DEMO', 'TEST TRANSFER', 'SIMULATOR', 'SAMPLE',
 'IFAKEBANKALER', 'FAKE BANK ALERT', 'NOT A REAL', 'PROOF OF PAYMENT',
 'SCREENSHOT', 'FAKEBANK', 'ALERTDEMO'
 ];
 for (const kw of fakeAppKeywords) {
 if (upper.includes(kw)) {
 flags.push(`Fake app keyword detected: "${kw}"`);
 confidence -= 40;
 }
 }
 let foundAmount = null;
 const nairaSymbolMatch = raw.match(/₦\s*([\d,]+(?:\.\d{1,2})?)/);
 if (nairaSymbolMatch) {
 foundAmount = parseFloat(nairaSymbolMatch[1].replace(/,/g, ''));
 }
 if (!foundAmount) {
 const lines = raw.split('\n');
 for (const line of lines) {
 const lu = line.toUpperCase();
 if (lu.includes('AMOUNT') || lu.includes('TOTAL') || lu.includes('NGN')) {
 const numMatch = line.match(/([\d,]+(?:\.\d{1,2})?)/);
 if (numMatch) {
 const val = parseFloat(numMatch[1].replace(/,/g, ''));
 if (!isNaN(val) && val > 0 && String(Math.floor(val)).length <= 8) {
 foundAmount = val;
 break;
 }
 }
 }
 }
 }
 if (!foundAmount) {
 const allNums = [];
 const numIter = raw.matchAll(/([\d,]+(?:\.\d{1,2})?)/g);
 for (const m of numIter) {
 const val = parseFloat(m[1].replace(/,/g, ''));
 const digits = String(Math.floor(val)).length;
 if (!isNaN(val) && val > 0 && digits <= 8 && digits >= 2) allNums.push(val);
 }
 if (allNums.length > 0) {
 foundAmount = allNums.reduce((prev, curr) =>
 Math.abs(curr - claimedAmount) < Math.abs(prev - claimedAmount) ? curr : prev
 );
 }
 }
 extracted.amount = foundAmount;
 if (extracted.amount) {
 const diff = Math.abs(extracted.amount - claimedAmount);
 const pct = diff / claimedAmount;
 if (pct < 0.01) {
 confidence += 20;
 } else if (pct < 0.05) {
 confidence += 5;
 } else {
 flags.push(`Amount mismatch: receipt shows \u20a6${extracted.amount}, user claimed \u20a6${claimedAmount}`);
 confidence -= 30;
 }
 } else {
 flags.push('Could not extract amount from receipt');
 confidence -= 10;
 }
 const refMatch = raw.match(/(?:Transaction\s*No\.?|Session\s*ID|Reference(?:\s*No\.?)?|Ref(?:\s*No\.?)?|Trans(?:action)?\s*(?:ID|Ref)|NXG|FTN|TRF|RRN)[:\s#]*([A-Z0-9]{8,})/i);
 const longDigitRef = raw.match(/\b(\d{15,})\b/); // OPay 22-digit transaction numbers
 if (refMatch) {
 extracted.reference = refMatch[1];
 confidence += 15;
 } else if (longDigitRef) {
 extracted.reference = longDigitRef[1];
 confidence += 15;
 } else {
 flags.push('No transaction reference number found');
 confidence -= 15;
 }
 const dateMatch = raw.match(/(\d{4}-\d{2}-\d{2}|\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{1,2}\s+\w+\s+\d{4})/);
 if (dateMatch) {
 extracted.date = dateMatch[1];
 const receiptDate = new Date(dateMatch[1]);
 const now = new Date();
 const diffDays = (now - receiptDate) / (1000 * 60 * 60 * 24);
 if (receiptDate > now) {
 flags.push('Receipt date is in the future');
 confidence -= 35;
 } else if (diffDays > 3) {
 flags.push(`Receipt is ${Math.floor(diffDays)} days old — may be reused`);
 confidence -= 20;
 } else {
 confidence += 10; // fresh receipt
 }
 } else {
 flags.push('No date found on receipt');
 confidence -= 10;
 }
 const timeMatch = raw.match(/\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\b/i);
 if (timeMatch) extracted.time = timeMatch[1];
 const fromMatch = raw.match(/(?:From|Sender|Debit Account)[:\s]+([A-Z\s]{5,40})/i);
 if (fromMatch) extracted.senderName = fromMatch[1].trim();
 if (claimedAccountName && extracted.senderName) {
 const claimedUpper = claimedAccountName.toUpperCase().trim();
 const extractedUpper = extracted.senderName.toUpperCase().trim();
 const claimedWords = claimedUpper.split(/\s+/);
 const matchCount = claimedWords.filter(w => w.length > 2 && extractedUpper.includes(w)).length;
 if (matchCount >= 1) {
 confidence += 10;
 } else {
 flags.push(`Sender name mismatch: receipt shows "${extracted.senderName}", user entered "${claimedAccountName}"`);
 confidence -= 15;
 }
 }
 const toMatch = raw.match(/(?:To|Recipient|Beneficiary|Credit Account)[:\s]+([A-Z\s]{5,40})/i);
 if (toMatch) extracted.recipientName = toMatch[1].trim();
 const acctMatch = raw.match(/\b(\d{10})\b/);
 const maskedMatch = raw.match(/\b(\d{4})[\s\-]*\*{2,6}[\s\-]*(\d{2,4})\b/);
 if (acctMatch) extracted.recipientAccount = acctMatch[1];
 else if (maskedMatch) extracted.recipientAccount = `${maskedMatch[1]}****${maskedMatch[2]}`;
 const ourAccountName = (process.env.ACCOUNT_NAME || '').toUpperCase();
 const ourAccountNumber = process.env.ACCOUNT_NUMBER || '';
 const ourBankName = (process.env.BANK_NAME || '').toUpperCase();
 if (ourAccountNumber && extracted.recipientAccount) {
 if (extracted.recipientAccount === ourAccountNumber) {
 confidence += 25; // account number matches perfectly
 } else if (/^\d{4}\*{4}\d{2,4}$/.test(extracted.recipientAccount)) {
 const [, prefix, suffix] = extracted.recipientAccount.match(/^(\d{4})\*{4}(\d{2,4})$/);
 if (ourAccountNumber.startsWith(prefix) && ourAccountNumber.endsWith(suffix)) {
 confidence += 20; // matches on visible digits of a masked account
 } else {
 flags.push(`Masked recipient account ${extracted.recipientAccount} does not match our account ${ourAccountNumber}`);
 confidence -= 35;
 }
 } else {
 flags.push(`Recipient account ${extracted.recipientAccount} does not match our account ${ourAccountNumber}`);
 confidence -= 35;
 }
 }
 if (ourAccountName && extracted.recipientName) {
 const ourWords = ourAccountName.split(/\s+/);
 const recipUpper = extracted.recipientName.toUpperCase();
 const matchCount = ourWords.filter(w => w.length > 2 && recipUpper.includes(w)).length;
 if (matchCount >= 1) {
 confidence += 10;
 } else {
 flags.push(`Recipient name "${extracted.recipientName}" does not match our account name`);
 confidence -= 20;
 }
 }
 const bankUpper = claimedBank.toUpperCase();
 if (upper.includes(bankUpper.split(' ')[0])) {
 confidence += 10; // bank name appears in receipt
 extracted.bank = claimedBank;
 } else {
 const bankAbbrevs = { 'GTB': 'GUARANTY', 'UBA': 'UNITED BANK', 'FCMB': 'FCMB', 'ZENITH': 'ZENITH', 'ACCESS': 'ACCESS', 'KUDA': 'KUDA', 'OPAY': 'OPAY', 'MONIEPOINT': 'MONIEPOINT', 'PALMPAY': 'PALMPAY' };
 let bankFound = false;
 for (const [abbr, full] of Object.entries(bankAbbrevs)) {
 if ((bankUpper.includes(abbr) || bankUpper.includes(full)) && (upper.includes(abbr) || upper.includes(full))) {
 bankFound = true;
 extracted.bank = claimedBank;
 confidence += 5;
 break;
 }
 }
 if (!bankFound) {
 flags.push(`Bank name "${claimedBank}" not found in receipt text`);
 confidence -= 10;
 }
 }
 const stats = fs.statSync(imagePath);
 const sizeKB = stats.size / 1024;
 if (sizeKB < 20) {
 flags.push('Receipt image is suspiciously small (possible fake/edited screenshot)');
 confidence -= 20;
 } else if (sizeKB > 100) {
 confidence += 5; // larger files are usually real screenshots
 }
 confidence = Math.max(0, Math.min(100, confidence));
 let verdict;
 if (flags.some(f => f.toLowerCase().includes('fake') || f.toLowerCase().includes('future') || f.toLowerCase().includes('mismatch') && confidence < 50)) {
 verdict = confidence < 40 ? 'rejected' : 'manual_review';
 } else if (confidence >= 75 && flags.length === 0) {
 verdict = 'approved';
 } else if (confidence >= 60 && flags.length <= 1) {
 verdict = 'approved';
 } else if (confidence >= 45) {
 verdict = 'manual_review';
 } else {
 verdict = 'rejected';
 }
 const reason = flags.length === 0
 ? `Receipt verified successfully (confidence: ${confidence}%)`
 : `Issues found: ${flags[0]}${flags.length > 1 ? ` (+${flags.length - 1} more)` : ''}`;
 console.log(` OCR verdict: ${verdict} (${confidence}%) — ${reason}`);
 return { verdict, confidence, reason, flags, extracted };
 } catch (e) {
 console.error('OCR verification error:', e.message);
 return { verdict: 'manual_review', confidence: 0, reason: 'OCR unavailable — queued for manual review', flags: [], extracted: {} };
 }
}
async function generateUniqueReferralCode() {
 for (let i = 0; i < 10; i++) {
 const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. "9F3A21B4"
 if (!(await User.findOne({ referralCode: code }))) return code;
 }
 return crypto.randomBytes(6).toString('hex').toUpperCase();
}
const REFERRAL_COMMISSION_RATE = 0.04;
async function creditReferralCommission(buyer, purchaseAmount, itemLabel) {
 try {
 if (!buyer.referredBy || !purchaseAmount) return;
 const referrer = await User.findById(buyer.referredBy);
 if (!referrer || referrer.restricted) return; // never pay out commission to a restricted account
 const commission = Math.round(purchaseAmount * REFERRAL_COMMISSION_RATE * 100) / 100;
 if (commission <= 0) return;
 await User.updateOne({ _id: referrer._id }, { $inc: { balance: commission } });
 await ReferralEarning.create({
 referrerId: referrer._id, referredUserId: buyer._id,
 purchaseAmount, commission, itemLabel
 });
 await Transaction.create({
 userId: referrer._id, type: 'referral_commission', amount: commission,
 description: `4% referral commission — ${buyer.name} purchased ${itemLabel}`,
 status: 'success'
 });
 checkAndAwardBadges(referrer._id).catch(() => {});
 } catch (e) {
 console.error('Referral commission crediting failed (purchase itself is unaffected):', e.message);
 }
}
const BLOCKED_EMAIL_DOMAINS = new Set([
 'example.com', 'example.org', 'example.net', 'test.com', 'test.org', 'sample.com', 'domain.com',
 'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com', '10minutemail.net',
 'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'getnada.com',
 'sharklasers.com', 'dispostable.com', 'fakeinbox.com', 'maildrop.cc', 'mintemail.com', 'moakt.com'
]);
function isBlockedEmailDomain(email) {
 const domain = String(email).split('@')[1]?.toLowerCase().trim();
 return domain ? BLOCKED_EMAIL_DOMAINS.has(domain) : false;
}

// ── One person, five accounts maximum ───────────────────────────────────────
// Signup IP + device (user-agent) fingerprint are both counted. Once five
// accounts exist behind the same connection/device the sixth is refused, which
// stops referral farming and throwaway-account abuse without ever blocking a
// genuine household of a few users.
const MAX_ACCOUNTS_PER_PERSON = Math.max(1, Number(process.env.MAX_ACCOUNTS_PER_PERSON || 5));
function deviceFingerprint(req) {
  const ua = String(req.headers['user-agent'] || '');
  const lang = String(req.headers['accept-language'] || '');
  const did = String(req.deviceId || '');
  return crypto.createHash('sha256').update(did + '|' + ua + '|' + lang).digest('hex').slice(0, 32);
}
// Limit is per device (browser cookie). IP alone gets a much higher ceiling
// because many real customers share one IP on mobile networks.
const MAX_ACCOUNTS_PER_IP = Math.max(1, Number(process.env.MAX_ACCOUNTS_PER_IP || 50));
async function accountLimitReached(req) {
  const ip = (req.ip || req.socket?.remoteAddress || '').toString();
  const fp = deviceFingerprint(req);
  const [byDevice, byIp] = await Promise.all([
    User.countDocuments({ signupFingerprint: fp }),
    ip ? User.countDocuments({ signupIp: ip }) : 0
  ]);
  if (byDevice >= MAX_ACCOUNTS_PER_PERSON || byIp >= MAX_ACCOUNTS_PER_IP) {
    return `You have reached the limit of accounts allowed per person on this website. Please log in to one of your existing accounts, or contact support if you believe this is a mistake.`;
  }
  return null;
}

app.post('/api/auth/register', async (req, res) => {
 try {
 const { name, email, password, refCode, phone, phoneCountry, country, language } = req.body;
 const cleanName = String(name || '').trim();
 const cleanEmail = String(email || '').trim().toLowerCase();
 const cleanPhone = String(phone || '').trim();
 const cleanPassword = String(password || '');
 if (!cleanName || !cleanEmail || !cleanPhone || !cleanPassword) return res.status(400).json({ error: 'Please complete every field.' });
 if (cleanName.length < 2 || cleanName.length > 80) return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
 if (cleanPassword.length < 8 || cleanPassword.length > 128) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
 if (isBlockedEmailDomain(cleanEmail)) return res.status(400).json({ error: 'Please sign up with a real, active email address.' });
 if (await User.findOne({ email: cleanEmail })) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
 const capError = await accountLimitReached(req);
 if (capError) return res.status(429).json({ error: capError, accountLimit: true });
 const referralCode = await generateUniqueReferralCode();
 const referrer = refCode ? await User.findOne({ referralCode: String(refCode).trim().toUpperCase() }) : null;
 if (String(refCode || '').trim() && !referrer) return res.status(400).json({ error: 'That referral code is not valid. Check it, or leave the box empty.' });
 const signupIp = (req.ip || req.socket?.remoteAddress || '').toString();
 // Worldwide phone handling: the client sends the chosen country plus the local
 // number; countries.normalizePhone turns that into a validated E.164 number.
 const countriesLib = require('./lib/countries');
 const isoCountry = countriesLib.byCode(phoneCountry || country || 'NG');
 if (isoCountry && isoCountry.blocked) return res.status(403).json({ error: 'We are unable to open accounts in your country.' });
 const contactPhone = countriesLib.normalizePhone((phoneCountry || country || 'NG'), cleanPhone)
 || (countriesLib.byPhone(cleanPhone) ? cleanPhone.replace(/[^\d+]/g, '') : '');
 if (!contactPhone || contactPhone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Enter a valid phone number including your country code or select your country.' });
 if (await User.findOne({ contactPhone })) return res.status(409).json({ error: 'This phone number is already linked to an account.' });
 const user = new User({
 name: cleanName, email: cleanEmail, password: await bcrypt.hash(cleanPassword, 12),
 referralCode, referredBy: referrer ? referrer._id : null, signupIp, signupFingerprint: deviceFingerprint(req), contactPhone,
 country: isoCountry ? isoCountry.code : '',
 language: (language || 'en').slice(0, 8).toLowerCase(),
 displayCurrency: isoCountry ? isoCountry.currency : 'NGN'
 });
 await user.save();
 // Welcome email — never awaited so a slow mail provider can't stall signup.
 if (rshCampaigns) rshCampaigns.sendWelcomeEmail(user).catch(() => {});
 const token = rshEngagement ? await rshEngagement.issueToken(user, req) : jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
 res.json({ token, user: sanitizeUser(user) });
 } catch (e) { res.status(500).json({ error: 'Registration failed: ' + e.message }); }
});
app.post('/api/auth/login', async (req, res) => {
 try {
 const emailInput = String((req.body || {}).email || '').trim().toLowerCase();
 const password = String((req.body || {}).password || '');
 if (!emailInput || !password) return res.status(400).json({ error: 'Email and password are required.' });
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) return res.status(400).json({ error: 'Enter a valid email address.' });
 const user = await User.findOne({ email: emailInput });
 if (!user) return res.status(400).json({ error: 'Invalid email or password' });
 if (!user.password) return res.status(400).json({ error: 'This account signed up with Google. Please use "Continue with Google" to log in.' });
 if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid email or password' });
 if (user.restricted) return res.status(403).json({ error: `Your account has been restricted${user.restrictedReason ? ': ' + user.restrictedReason : ''}. Contact support for help.`, restricted: true });
 const ip = (req.ip || req.socket?.remoteAddress || '').toString();
 const userAgent = req.headers['user-agent'] || '';
 user.lastLoginAt = new Date();
 user.lastLoginIp = ip;
 user.lastLoginUserAgent = userAgent;
 user.loginHistory.push({ at: new Date(), ip, userAgent });
 if (user.loginHistory.length > 50) user.loginHistory = user.loginHistory.slice(-50);
 await user.save();
 const token = rshEngagement ? await rshEngagement.issueToken(user, req) : jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
 res.json({ token, user: sanitizeUser(user) });
 } catch { res.status(500).json({ error: 'Login failed' }); }
});
async function upsertGoogleUser(payload, agreedTerms, refCode, req) {
 let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email: payload.email.toLowerCase() }] });
 let isNewUser = false;
 if (payload.email_verified === false) { const err = new Error('Your Google email address is not verified.'); err.blockedDomain = true; throw err; }
 if (user) {
 if (!user.googleId) { user.googleId = payload.sub; user.authProvider = user.authProvider === 'local' && user.password ? 'local' : 'google'; }
 if (!user.profilePicture && payload.picture) user.profilePicture = payload.picture;
 } else {
 if (!agreedTerms) { const err = new Error('You must agree to the Terms & Conditions to create an account'); err.requiresTerms = true; throw err; }
 if (isBlockedEmailDomain(payload.email)) { const err = new Error('Please sign up with a real, active email address.'); err.blockedDomain = true; throw err; }
 isNewUser = true;
 if (req) {
 const capError = await accountLimitReached(req);
 if (capError) { const err = new Error(capError); err.accountLimit = true; throw err; }
 }
 const referrer = refCode ? await User.findOne({ referralCode: String(refCode).toUpperCase() }) : null;
 const signupIp = req ? (req.ip || req.socket?.remoteAddress || '').toString() : '';
 user = new User({
 name: payload.name || payload.email.split('@')[0],
 email: payload.email.toLowerCase(),
 googleId: payload.sub,
 authProvider: 'google',
 profilePicture: payload.picture || '',
 referralCode: await generateUniqueReferralCode(),
 referredBy: referrer ? referrer._id : null,
 signupIp,
 signupFingerprint: req ? deviceFingerprint(req) : ''
 });
 }
 if (user.restricted) { const err = new Error(`Your account has been restricted${user.restrictedReason ? ': ' + user.restrictedReason : ''}. Contact support for help.`); err.restricted = true; throw err; }
 if (isNewUser && rshCampaigns) rshCampaigns.sendWelcomeEmail(user).catch(() => {});
 return { user, isNewUser };
}
async function finalizeGoogleLogin(user, req) {
 const ip = (req.ip || req.socket?.remoteAddress || '').toString();
 const userAgent = req.headers['user-agent'] || '';
 user.lastLoginAt = new Date();
 user.lastLoginIp = ip;
 user.lastLoginUserAgent = userAgent;
 user.loginHistory.push({ at: new Date(), ip, userAgent });
 if (user.loginHistory.length > 50) user.loginHistory = user.loginHistory.slice(-50);
 await user.save();
 return rshEngagement ? await rshEngagement.issueToken(user, req) : jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
app.post('/api/auth/google', async (req, res) => {
 try {
 if (!googleClient) return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });
 const { credential, agreedTerms, refCode } = req.body;
 if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
 const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
 const payload = ticket.getPayload();
 if (!payload?.email) return res.status(400).json({ error: 'Could not verify Google account' });
 const { user, isNewUser } = await upsertGoogleUser(payload, agreedTerms, refCode, req);
 const token = await finalizeGoogleLogin(user, req);
 res.json({ token, user: sanitizeUser(user), isNewUser });
 } catch (e) {
 console.error('Google auth error:', e.message);
 if (e.requiresTerms) return res.status(400).json({ error: e.message, requiresTerms: true });
 if (e.restricted) return res.status(403).json({ error: e.message, restricted: true });
 if (e.blockedDomain) return res.status(400).json({ error: e.message, blockedDomain: true });
 if (e.accountLimit) return res.status(429).json({ error: e.message, accountLimit: true });
 res.status(400).json({ error: 'Google sign-in failed: ' + e.message });
 }
});
const googleRedirectClient = (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
 ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${process.env.SITE_URL || ''}/auth/google/callback`)
 : null;
const pendingGoogleLogins = new Map(); // code -> { token, user, isNewUser, expiresAt }
function cleanupPendingGoogleLogins() {
 const now = Date.now();
 for (const [code, entry] of pendingGoogleLogins) if (entry.expiresAt < now) pendingGoogleLogins.delete(code);
}
app.get('/auth/google', (req, res) => {
 if (!googleRedirectClient) return res.status(503).send('Google Sign-In is not configured on this server yet.');
 const agreedTerms = req.query.agreedTerms === '1' ? '1' : '0';
 const refCode = (req.query.ref || '').toString().slice(0, 20);
 const url = googleRedirectClient.generateAuthUrl({
 access_type: 'online',
 scope: ['openid', 'email', 'profile'],
 state: `${agreedTerms}|${refCode}`,
 prompt: 'select_account'
 });
 res.redirect(url);
});
app.get('/auth/google/callback', async (req, res) => {
 const siteUrl = process.env.SITE_URL || '';
 try {
 if (!googleRedirectClient) throw new Error('Google Sign-In is not configured on this server yet.');
 const { code, state, error: googleError } = req.query;
 if (googleError) throw new Error(googleError === 'access_denied' ? 'Sign-in was cancelled' : googleError);
 if (!code) throw new Error('Missing authorization code from Google');
 const { tokens } = await googleRedirectClient.getToken(code);
 const ticket = await googleRedirectClient.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
 const payload = ticket.getPayload();
 if (!payload?.email) throw new Error('Could not verify Google account');
 const [agreedTermsRaw, refCode] = String(state || '').split('|');
 const agreedTerms = agreedTermsRaw === '1';
 const { user, isNewUser } = await upsertGoogleUser(payload, agreedTerms, refCode, req);
 const token = await finalizeGoogleLogin(user, req);
 cleanupPendingGoogleLogins();
 const loginCode = crypto.randomBytes(24).toString('hex');
 pendingGoogleLogins.set(loginCode, { token, user: sanitizeUser(user), isNewUser, expiresAt: Date.now() + 2 * 60 * 1000 });
 res.redirect(`${siteUrl}/login?googleLoginCode=${loginCode}`);
 } catch (e) {
 console.error('Google redirect auth error:', e.message);
 const reason = e.requiresTerms ? 'terms' : e.restricted ? 'restricted' : e.blockedDomain ? 'blocked' : 'failed';
 res.redirect(`${siteUrl}/login?googleLoginError=${reason}&googleLoginMsg=${encodeURIComponent(e.message)}`);
 }
});
app.post('/api/auth/google/exchange', (req, res) => {
 const { code } = req.body;
 const entry = code && pendingGoogleLogins.get(code);
 if (code) pendingGoogleLogins.delete(code);
 if (!entry || entry.expiresAt < Date.now()) return res.status(400).json({ error: 'This sign-in link has expired. Please try again.' });
 res.json({ token: entry.token, user: entry.user, isNewUser: entry.isNewUser });
});
app.post('/api/auth/reset-password', auth, async (req, res) => {
 try {
 const { oldPassword, newPassword } = req.body;
 const user = await User.findById(req.user._id);
 if (!user.password) return res.status(400).json({ error: 'This account uses Google Sign-In and has no password. There is nothing to reset — you can set one via "Add a password" in Settings.' });
 if (!(await bcrypt.compare(oldPassword, user.password))) return res.status(400).json({ error: 'Old password incorrect' });
 if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Minimum 8 characters' });
 user.password = await bcrypt.hash(newPassword, 12);
 await user.save();
 res.json({ message: 'Password updated successfully' });
 } catch { res.status(500).json({ error: 'Reset failed' }); }
});
app.post('/api/auth/set-password', auth, async (req, res) => {
 try {
 const { newPassword } = req.body;
 const user = await User.findById(req.user._id);
 if (user.password) return res.status(400).json({ error: 'This account already has a password. Use "Change Password" instead.' });
 if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Minimum 8 characters' });
 user.password = await bcrypt.hash(newPassword, 12);
 await user.save();
 res.json({ message: ' Password set! You can now log in with email + password too.' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/user/profile', auth, async (req, res) => {
 try {
 const { name, email } = req.body;
 const user = await User.findById(req.user._id);
 if (name && name.trim()) user.name = name.trim();
 if (email && email.trim().toLowerCase() !== user.email) {
 const newEmail = email.trim().toLowerCase();
 const existing = await User.findOne({ email: newEmail, _id: { $ne: user._id } });
 if (existing) return res.status(400).json({ error: 'That email is already in use by another account' });
 user.email = newEmail;
 }
 await user.save();
 res.json({ message: ' Profile updated', user: sanitizeUser(user) });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/phone', auth, async (req, res) => {
 try {
 const { phone } = req.body;
 if (!phone) return res.status(400).json({ error: 'Phone number is required' });
 const cleaned = phone.trim().replace(/\s+/g,'');
 let normalized = cleaned;
 if (/^0[789]\d{9}$/.test(cleaned)) normalized = '+234' + cleaned.slice(1);
 if (!/^\+234[789]\d{9}$/.test(normalized)) {
 return res.status(400).json({ error: 'Enter a valid Nigerian number in +234 format (e.g. +2348012345678)' });
 }
 const user = await User.findById(req.user._id);
 user.contactPhone = normalized;
 await user.save();
 res.json({ message: ' Phone number saved', user: sanitizeUser(user) });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/user/phone', auth, async (req, res) => {
 try {
 const { phone } = req.body;
 if (!phone) return res.status(400).json({ error: 'Phone number is required' });
 const cleaned = phone.trim().replace(/\s+/g,'');
 let normalized = cleaned;
 if (/^0[789]\d{9}$/.test(cleaned)) normalized = '+234' + cleaned.slice(1);
 if (!/^\+234[789]\d{9}$/.test(normalized)) {
 return res.status(400).json({ error: 'Enter a valid Nigerian number in +234 format (e.g. +2348012345678)' });
 }
 const user = await User.findById(req.user._id);
 user.contactPhone = normalized;
 await user.save();
 res.json({ message: ' Phone number updated', user: sanitizeUser(user) });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/profile-picture', auth, upload.single('picture'), async (req, res) => {
 try {
 if (!req.file) return res.status(400).json({ error: 'No picture uploaded' });
 const user = await User.findById(req.user._id);
 user.profilePicture = fileUrl(req.file);
 await user.save();
 res.json({ message: ' Profile picture updated', profilePicture: user.profilePicture });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/user/api-key', auth, async (req, res) => {
 const user = await User.findById(req.user._id).select('apiKey apiEnabled apiKeyCreatedAt apiLastUsedAt');
 res.json({ apiKey: user.apiKey || null, apiEnabled: user.apiEnabled, createdAt: user.apiKeyCreatedAt, lastUsedAt: user.apiLastUsedAt, hasSecret: !!user.apiKey });
});
app.post('/api/user/api-key/generate', auth, async (req, res) => {
 try {
 const user = await User.findById(req.user._id);
 user.apiKey = 'rsh_live_' + crypto.randomBytes(16).toString('hex');
 const plainSecret = crypto.randomBytes(32).toString('hex');
 user.apiSecret = 'sha256:' + crypto.createHash('sha256').update(plainSecret).digest('hex'); // only the hash is stored
 user.apiEnabled = true;
 user.apiKeyCreatedAt = new Date();
 await user.save();
 res.json({ apiKey: user.apiKey, apiSecret: plainSecret, message: ' API key generated. Save your secret now — it will not be shown again.' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/api-key/revoke', auth, async (req, res) => {
 try {
 const user = await User.findById(req.user._id);
 user.apiKey = undefined; user.apiSecret = undefined; user.apiEnabled = false;
 await user.save();
 res.json({ message: ' API key revoked' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/user/me', auth, async (req, res) => res.json(await User.findById(req.user._id).select('-password -apiSecret')));
app.get('/api/referrals/summary', auth, async (req, res) => {
 try {
 const siteUrl = process.env.SITE_URL || '';
 const referredCount = await User.countDocuments({ referredBy: req.user._id });
 const earnings = await ReferralEarning.find({ referrerId: req.user._id }).sort({ createdAt: -1 }).limit(50);
 const totalEarned = earnings.reduce((sum, e) => sum + e.commission, 0);
 res.json({
 referralCode: req.user.referralCode,
 referralLink: `${siteUrl}/?ref=${req.user.referralCode}`,
 referredCount,
 totalEarned,
 commissionRate: REFERRAL_COMMISSION_RATE,
 recentEarnings: earnings.map(e => ({ commission: e.commission, purchaseAmount: e.purchaseAmount, itemLabel: e.itemLabel, createdAt: e.createdAt }))
 });
 } catch (e) { res.status(500).json({ error: 'Failed to load referral summary' }); }
});
app.get('/api/user/transactions', auth, async (req, res) => res.json(await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100)));
app.get('/api/user/deposit-summary', auth, async (req, res) => {
 try {
 const agg = await Transaction.aggregate([
 { $match: { userId: req.user._id, type: 'deposit', status: 'success' } },
 { $group: { _id: null, total: { $sum: '$amount' } } }
 ]);
 res.json({ totalDeposited: agg[0]?.total || 0, currentBalance: req.user.balance || 0 });
 } catch (e) { res.status(500).json({ error: 'Failed to load deposit summary' }); }
});
app.get('/api/user/purchases', auth, async (req, res) => {
 const u = await User.findById(req.user._id).select('purchaseDetails');
 res.json(u.purchaseDetails || []);
});
// ── ANNOUNCEMENT ROUTES ──────────────────────────────────────────────────────
// User-facing: the list plus this user's own read/dismissed state.
app.get('/api/announcements', auth, async (req, res) => {
 try {
  const items = await Announcement.find(liveAnnouncementFilter())
    .sort({ pinned: -1, createdAt: -1 }).limit(50).lean();
  const states = await AnnouncementState.find({
    userId: req.user._id,
    announcementId: { $in: items.map(i => i._id) },
  }).lean();
  const byId = new Map(states.map(st => [String(st.announcementId), st]));
  const out = items.map(a => {
    const st = byId.get(String(a._id));
    return {
      id: String(a._id),
      title: a.title,
      message: a.message,
      link: a.link || '',
      linkLabel: a.linkLabel || '',
      image: a.image || '',
      itemId: a.itemId ? String(a.itemId) : '',
      level: a.level || 'info',
      pinned: !!a.pinned,
      createdAt: a.createdAt,
      read: !!(st && st.readAt),
      readAt: (st && st.readAt) || null,
      dismissed: !!(st && st.dismissedAt),
    };
  });
  res.json({
    items: out,
    unread: out.filter(a => !a.read).length,
    // Popups: everything this user has not permanently dismissed and has not read yet.
    popups: out.filter(a => !a.dismissed && !a.read).map(a => a.id),
  });
 } catch (e) { res.status(500).json({ error: 'Failed to load announcements' }); }
});

/** Mark read (Read more / opened) or permanently dismissed ("Don't show again"). */
app.post('/api/announcements/:id/state', auth, async (req, res) => {
 try {
  const { read, dismissed, viewed, clicked } = req.body || {};
  const ann = await Announcement.findById(req.params.id).select('_id');
  if (!ann) return res.status(404).json({ error: 'Announcement not found' });
  const set = {};
  const inc = {};
  const now0 = new Date();
  if (viewed === true) { inc.views = 1; }
  if (clicked === true) { inc.clicks = 1; set.readAt = now0; }
  if (read === true) set.readAt = new Date();
  if (dismissed === true) { set.dismissedAt = new Date(); if (!set.readAt) set.readAt = new Date(); }
  if (dismissed === false) set.dismissedAt = null;
  const update = { $set: set, $setOnInsert: { announcementId: ann._id, userId: req.user._id } };
  if (Object.keys(inc).length) update.$inc = inc;
  // First-touch timestamps must not overwrite an earlier one, so they go in $setOnInsert-safe form.
  const existing = await AnnouncementState.findOne({ announcementId: ann._id, userId: req.user._id }).select('viewedAt clickedAt').lean();
  if (viewed === true && !(existing && existing.viewedAt)) update.$set.viewedAt = now0;
  if (clicked === true && !(existing && existing.clickedAt)) update.$set.clickedAt = now0;
  const st = await AnnouncementState.findOneAndUpdate(
    { announcementId: ann._id, userId: req.user._id },
    update,
    { new: true, upsert: true }
  );
  res.json({ id: String(ann._id), read: !!st.readAt, dismissed: !!st.dismissedAt });
 } catch (e) { res.status(500).json({ error: 'Failed to save notification state' }); }
});

/** Mark every live announcement as read for this user (used by the notifications page). */
app.post('/api/announcements/read-all', auth, async (req, res) => {
 try {
  const items = await Announcement.find(liveAnnouncementFilter()).select('_id').lean();
  const now = new Date();
  await Promise.all(items.map(a => AnnouncementState.updateOne(
    { announcementId: a._id, userId: req.user._id },
    { $set: { readAt: now }, $setOnInsert: { announcementId: a._id, userId: req.user._id } },
    { upsert: true }
  )));
  res.json({ message: 'All announcements marked as read', count: items.length });
 } catch (e) { res.status(500).json({ error: 'Failed to mark announcements read' }); }
});

// Admin: the "Notifications bar" tab.
app.get('/api/admin/announcements', adminAuth, async (req, res) => {
 try {
  const items = await Announcement.find().sort({ createdAt: -1 }).limit(200).lean();
  const stats = await AnnouncementState.aggregate([
    { $group: { _id: '$announcementId',
      reads: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } },
      dismissals: { $sum: { $cond: [{ $ifNull: ['$dismissedAt', false] }, 1, 0] } },
      viewers: { $sum: { $cond: [{ $ifNull: ['$viewedAt', false] }, 1, 0] } },
      impressions: { $sum: { $ifNull: ['$views', 0] } },
      clickers: { $sum: { $cond: [{ $ifNull: ['$clickedAt', false] }, 1, 0] } },
      clicks: { $sum: { $ifNull: ['$clicks', 0] } } } }
  ]);
  const byId = new Map(stats.map(s => [String(s._id), s]));
  res.json(items.map(a => {
    const st = byId.get(String(a._id)) || {};
    const viewers = st.viewers || 0;
    return {
      ...a,
      id: String(a._id),
      reads: st.reads || 0,
      dismissals: st.dismissals || 0,
      viewers,
      impressions: st.impressions || 0,
      clickers: st.clickers || 0,
      clicks: st.clicks || 0,
      ctr: viewers ? Math.round(((st.clickers || 0) / viewers) * 1000) / 10 : 0,
    };
  }));
 } catch (e) { res.status(500).json({ error: 'Failed to load announcements' }); }
});

/** Analytics: how many users saw each notification and how many pressed "Read more". */
app.get('/api/admin/announcements/analytics', adminAuth, async (req, res) => {
 try {
  const [items, stats, totalUsers] = await Promise.all([
    Announcement.find().sort({ createdAt: -1 }).limit(200).lean(),
    AnnouncementState.aggregate([
      { $group: { _id: '$announcementId',
        viewers: { $sum: { $cond: [{ $ifNull: ['$viewedAt', false] }, 1, 0] } },
        impressions: { $sum: { $ifNull: ['$views', 0] } },
        clickers: { $sum: { $cond: [{ $ifNull: ['$clickedAt', false] }, 1, 0] } },
        clicks: { $sum: { $ifNull: ['$clicks', 0] } },
        reads: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } },
        dismissals: { $sum: { $cond: [{ $ifNull: ['$dismissedAt', false] }, 1, 0] } } } }
    ]),
    User.countDocuments(),
  ]);
  const byId = new Map(stats.map(s => [String(s._id), s]));
  const rows = items.map(a => {
    const st = byId.get(String(a._id)) || {};
    const viewers = st.viewers || 0;
    const clickers = st.clickers || 0;
    return {
      id: String(a._id),
      title: a.title,
      level: a.level || 'info',
      active: a.active !== false,
      link: a.link || '',
      createdAt: a.createdAt,
      viewers,
      impressions: st.impressions || 0,
      clickers,
      clicks: st.clicks || 0,
      reads: st.reads || 0,
      dismissals: st.dismissals || 0,
      reachPercent: totalUsers ? Math.round((viewers / totalUsers) * 1000) / 10 : 0,
      ctr: viewers ? Math.round((clickers / viewers) * 1000) / 10 : 0,
    };
  });
  const totals = rows.reduce((t, r) => ({
    viewers: t.viewers + r.viewers,
    impressions: t.impressions + r.impressions,
    clickers: t.clickers + r.clickers,
    clicks: t.clicks + r.clicks,
    reads: t.reads + r.reads,
    dismissals: t.dismissals + r.dismissals,
  }), { viewers: 0, impressions: 0, clickers: 0, clicks: 0, reads: 0, dismissals: 0 });
  res.json({ totalUsers, totals, rows });
 } catch (e) { res.status(500).json({ error: 'Failed to load notification analytics' }); }
});

app.post('/api/admin/announcements', adminAuth, upload.single('image'), async (req, res) => {
 try {
  const { title, message, link, linkLabel, level, pinned, active, expiresAt } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });
  const clean = String(link || '').trim();
  if (clean && !/^(https?:\/\/|\/)/i.test(clean)) {
    return res.status(400).json({ error: 'Link must start with http://, https:// or /' });
  }
  const ann = await Announcement.create({
    title: String(title).trim().slice(0, 140),
    message: String(message).trim().slice(0, 2000),
    link: clean,
    linkLabel: String(linkLabel || '').trim().slice(0, 40),
    image: req.file ? fileUrl(req.file) : '',
    level: ['info', 'success', 'warning', 'urgent'].includes(level) ? level : 'info',
    pinned: pinned === true || pinned === 'true',
    active: active === false || active === 'false' ? false : true,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    createdBy: 'owner',
  });
  res.json(ann);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/announcements/:id', adminAuth, upload.single('image'), async (req, res) => {
 try {
  const up = {};
  ['title', 'message', 'link', 'linkLabel', 'level'].forEach(k => {
    if (typeof req.body[k] !== 'undefined') up[k] = String(req.body[k] || '').trim();
  });
  if (up.link && !/^(https?:\/\/|\/)/i.test(up.link)) {
    return res.status(400).json({ error: 'Link must start with http://, https:// or /' });
  }
  if (typeof req.body.active !== 'undefined') up.active = req.body.active === true || req.body.active === 'true';
  if (typeof req.body.pinned !== 'undefined') up.pinned = req.body.pinned === true || req.body.pinned === 'true';
  if (typeof req.body.expiresAt !== 'undefined') up.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.file) up.image = fileUrl(req.file);
  const ann = await Announcement.findByIdAndUpdate(req.params.id, up, { new: true });
  if (!ann) return res.status(404).json({ error: 'Not found' });
  res.json(ann);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/announcements/:id', adminAuth, async (req, res) => {
 try {
  await AnnouncementState.deleteMany({ announcementId: req.params.id });
  await Announcement.findByIdAndDelete(req.params.id);
  res.json({ message: 'Announcement deleted' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/notifications', auth, async (req, res) => {
 try {
 const user = await User.findById(req.user._id).select('notificationsSeenAt');
 let seenAt = user.notificationsSeenAt;
 if (!seenAt) {
 seenAt = new Date();
 await User.findByIdAndUpdate(req.user._id, { notificationsSeenAt: seenAt });
 }
 const [receipts, tickets, transactions, supportReplies, announcements, announcementStates] = await Promise.all([
 Receipt.find({ userId: req.user._id, status: { $ne: 'pending' }, seenByUser: false }).sort({ createdAt: -1 }).limit(30),
 Support.find({ userId: req.user._id, status: 'resolved', seenByUser: false }).sort({ createdAt: -1 }).limit(30),
 Transaction.find({ userId: req.user._id, status: 'success', type: { $in: ['deposit', 'purchase', 'admin_credit'] } }).sort({ createdAt: -1 }).limit(30),
 SupportMessage.find({ userId: req.user._id, sender: 'admin', readByUser: false }).sort({ createdAt: -1 }).limit(30),
 Announcement.find(liveAnnouncementFilter()).sort({ pinned: -1, createdAt: -1 }).limit(50).lean(),
 AnnouncementState.find({ userId: req.user._id }).lean()
 ]);
 const announcementRead = new Map(announcementStates.map(s => [String(s.announcementId), !!s.readAt]));
 const items = [
 ...receipts.map(r => ({
 id: r._id, type: 'deposit',
 title: r.status === 'approved' ? ' Deposit approved' : ' Deposit rejected',
 message: r.status === 'approved' ? `Your ₦${r.claimedAmount.toLocaleString('en-NG')} deposit was approved.` : `Your ₦${r.claimedAmount.toLocaleString('en-NG')} deposit was rejected.${r.adminNote ? ' ' + r.adminNote : ''}`,
 createdAt: r.createdAt
 })),
 ...tickets.map(t => ({
 id: t._id, type: 'support',
 title: ' Support replied',
 message: t.adminReply ? t.adminReply.slice(0, 120) : 'Your support ticket has a reply.',
 createdAt: t.createdAt
 })),
  ...supportReplies.map(m => ({
  id: m._id, type: 'live-support',
  title: ' New live support reply',
  message: m.text.slice(0, 120),
  link: '/support',
  createdAt: m.createdAt
  })),
  ...announcements.map(a => ({
   id: a._id, type: 'announcement', title: a.title, message: a.message,
   link: a.link || '/notifications', image: a.image || '', level: a.level || 'info',
   unread: !announcementRead.get(String(a._id)), createdAt: a.createdAt
  })),
 ...transactions.map(tx => ({
 id: tx._id,
 type: tx.type,
 title: tx.type === 'deposit' ? ' Deposit received' : tx.type === 'purchase' ? ' Purchase successful' : ' Balance credited',
 message: tx.type === 'deposit' ? `₦${tx.amount.toLocaleString('en-NG')} was added to your wallet.` : tx.type === 'purchase' ? `${tx.description || 'Purchase completed'} — ₦${tx.amount.toLocaleString('en-NG')}` : `${tx.description || 'Your balance was credited'} — ₦${tx.amount.toLocaleString('en-NG')}`,
 createdAt: tx.createdAt
 }))
 ].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 40);
 const unreadCount = items.filter(i => i.unread === true || (i.type !== 'announcement' && new Date(i.createdAt) > seenAt)).length;
 res.json({ count: unreadCount, items });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/notifications/mark-seen', auth, async (req, res) => {
 try {
 await Promise.all([
 Receipt.updateMany({ userId: req.user._id, seenByUser: false }, { seenByUser: true }),
 Support.updateMany({ userId: req.user._id, seenByUser: false }, { seenByUser: true }),
 SupportMessage.updateMany({ userId: req.user._id, sender: 'admin', readByUser: false }, { readByUser: true }),
 (async () => {
   const live = await Announcement.find(liveAnnouncementFilter()).select('_id').lean();
   const now = new Date();
   await Promise.all(live.map(a => AnnouncementState.updateOne(
     { announcementId: a._id, userId: req.user._id },
     { $set: { readAt: now }, $setOnInsert: { announcementId: a._id, userId: req.user._id } },
     { upsert: true }
   )));
 })(),
 User.findByIdAndUpdate(req.user._id, { notificationsSeenAt: new Date() })
 ]);
 res.json({ message: 'Notifications marked as read' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/logs', optionalAuth, async (req, res) => {
 res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma', 'no-cache');
 res.set('Expires', '0');
 const filter = { available: true };
 if (req.query.type && req.query.type !== 'all') filter.type = req.query.type;
 if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
 const logs = await Log.find(filter).select('-details -toolLink -deliverableFile -subAccounts.details -subAccounts.toolLink -subAccounts.deliverableFile').sort({ createdAt: -1 });
 const categories = await Category.find();
 const showReviewsFor = new Set(categories.filter(c => c.showReviews).map(c => c.name));
 const visible = await Promise.all(logs.map(async l => {
 const obj = l.toObject();
 if (!showReviewsFor.has(l.category)) {
 obj.reviews = [];
 obj.adminReview = { reviewType: 'none', content: '' };
 if (obj.subAccounts) obj.subAccounts = obj.subAccounts.map(sa => ({ ...sa, reviews: [], adminReview: { reviewType: 'none', content: '' } }));
 }
 if (obj.listingType === 'folder') {
 obj.subAccounts = stripStaleSoldSubAccounts(obj.subAccounts);
 obj.availableCount = obj.subAccounts.filter(sa => !sa.sold).length;
 obj.soldOut = obj.availableCount === 0;
 const availablePrices = obj.subAccounts.filter(sa => !sa.sold).map(sa => sa.price);
 obj.priceFrom = availablePrices.length ? Math.min(...availablePrices) : null;
 } else if (obj.type === 'tool') {
 obj.soldOut = obj.toolQty > 0 && obj.soldCount >= obj.toolQty;
 } else {
 obj.soldOut = obj.maxPurchases > 0 && obj.soldCount >= obj.maxPurchases;
 }
 const brandLogo = await brandLogoFor(obj.title, obj.category);
 if (brandLogo) obj.picture = brandLogo;
 return obj;
 }));
 res.json(visible);
});
app.get('/api/logs/:id', optionalAuth, async (req, res) => {
 res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma', 'no-cache');
 res.set('Expires', '0');
 const log = await Log.findById(req.params.id).select('-details -toolLink -deliverableFile -subAccounts.details -subAccounts.toolLink -subAccounts.deliverableFile');
 if (!log) return res.status(404).json({ error: 'Not found' });
 const cat = await Category.findOne({ name: log.category });
 const showReviews = !cat || cat.showReviews; // default to showing if category record doesn't exist yet
 const obj = log.toObject();
 if (!showReviews) {
 obj.reviews = [];
 obj.adminReview = { reviewType: 'none', content: '' };
 if (obj.subAccounts) obj.subAccounts = obj.subAccounts.map(sa => ({ ...sa, reviews: [], adminReview: { reviewType: 'none', content: '' } }));
 }
 if (obj.listingType === 'folder') {
 obj.subAccounts = stripStaleSoldSubAccounts(obj.subAccounts);
 obj.availableCount = obj.subAccounts.filter(sa => !sa.sold).length;
 obj.soldOut = obj.availableCount === 0;
 const availablePrices = obj.subAccounts.filter(sa => !sa.sold).map(sa => sa.price);
 obj.priceFrom = availablePrices.length ? Math.min(...availablePrices) : null;
 } else if (obj.type === 'tool') {
 obj.soldOut = obj.toolQty > 0 && obj.soldCount >= obj.toolQty;
 } else {
 obj.soldOut = obj.maxPurchases > 0 && obj.soldCount >= obj.maxPurchases;
 }
 const brandLogo = await brandLogoFor(obj.title, obj.category);
 if (brandLogo) obj.picture = brandLogo;
 res.json(obj);
});
// A sub-account is only sellable if the admin actually put credentials/delivery content on it.
function subHasCredentials(sa) {
  return !!(sa && ((sa.details && String(sa.details).trim()) || (sa.toolLink && String(sa.toolLink).trim()) || (sa.deliverableFile && String(sa.deliverableFile).trim())));
}
app.post('/api/logs/buy/:id', auth, async (req, res) => {
 try {
 const { subAccountId } = req.body;
 const log = await Log.findById(req.params.id);
 if (!log || !log.available) return res.status(404).json({ error: 'Item not available' });
 const user = await User.findById(req.user._id);

 if (log.listingType === 'folder') {
   if (!subAccountId) return res.status(400).json({ error: 'Choose a sub-account to buy' });
   // ATOMIC CLAIM — only touches the ONE matching sub-account (sold:false).
   // Two concurrent buyers can never both get the same account.
   const claimed = await Log.findOneAndUpdate(
     { _id: log._id, subAccounts: { $elemMatch: { _id: subAccountId, sold: false } } },
     { $set: { 'subAccounts.$.sold': true, 'subAccounts.$.soldTo': user._id, 'subAccounts.$.soldAt': new Date() } },
     { new: true }
   );
   if (!claimed) return res.status(400).json({ error: 'This account has already been sold — please choose another.' });
   const sub = claimed.subAccounts.id(subAccountId);
   if (!sub) {
     // Roll back — safety net
     await Log.updateOne({ _id: log._id, 'subAccounts._id': subAccountId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
     return res.status(500).json({ error: 'Sub-account data error — please try again' });
   }
   if (!subHasCredentials(sub)) {
     await Log.updateOne({ _id: log._id, 'subAccounts._id': subAccountId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
     return res.status(409).json({ error: 'This account has no login details added yet, so you were NOT charged. Please contact admin or choose another account.' });
   }
   // BALANCE CHECK after claim — roll back if insufficient
   if ((user.balance || 0) < sub.price) {
     await Log.updateOne({ _id: log._id, 'subAccounts._id': subAccountId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
     return res.status(400).json({ error: 'Insufficient balance. Please deposit funds.' });
   }
   // ATOMIC DEDUCT — never read-modify-write; concurrent ops are safe
   const updatedUser = await User.findOneAndUpdate(
     { _id: user._id, balance: { $gte: sub.price } }, { $inc: { balance: -sub.price } }, { new: true }
   );
   if (!updatedUser) {
     await Log.updateOne({ _id: log._id, 'subAccounts._id': subAccountId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
     return res.status(400).json({ error: 'Insufficient balance. Please deposit funds.' });
   }
   // Push purchase record atomically — never overwrites other purchaseDetails
   const purchasedAt = new Date();
   await User.updateOne({ _id: user._id }, { $push: { purchaseDetails: {
     logId: log._id, logTitle: `${log.title} — ${sub.label}`, logType: log.type,
     logDetails: sub.details || '', toolLink: sub.toolLink || '',
     deliveryType: sub.deliveryType || 'link',
     deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || '',
     pricePaid: sub.price, subAccountId: sub._id, purchasedAt
   }}});
   await Transaction.create({ userId: user._id, type: 'purchase', amount: sub.price, description: `Purchased: ${log.title} — ${sub.label}`, status: 'success' });
   await creditReferralCommission(updatedUser, sub.price, `${log.title} — ${sub.label}`);
   checkAndAwardBadges(user._id).catch(() => {});
   // Re-label ONLY the unsold sub-accounts so numbering stays clean
   const freshLog = await Log.findById(log._id);
   if (freshLog) {
     let labelIdx = 1;
     freshLog.subAccounts.forEach(sa => { if (!sa.sold) sa.label = `Account ${labelIdx++}`; });
     await freshLog.save();
   }
   return res.json({
     message: 'Purchase successful!', newBalance: updatedUser.balance,
     logDetails: sub.details || '', toolLink: sub.toolLink || '',
     deliveryType: sub.deliveryType || 'link',
     deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || '',
     logType: log.type, logTitle: `${log.title} — ${sub.label}`,
   });
 }

 // Non-folder items (single log or tool)
 if (log.type === 'log') {
   if (user.purchaseDetails.find(p => String(p.logId) === String(log._id)))
     return res.status(400).json({ error: 'You already purchased this account.' });
   if (log.maxPurchases > 0 && log.soldCount >= log.maxPurchases)
     return res.status(400).json({ error: 'This account has already been sold.' });
 }
 if (log.type === 'tool' && log.toolQty > 0 && log.soldCount >= log.toolQty)
   return res.status(400).json({ error: 'This tool is out of stock.' });
 if ((user.balance || 0) < log.price)
   return res.status(400).json({ error: 'Insufficient balance. Please deposit funds.' });
 if (!(Number(log.price) >= 0)) return res.status(400).json({ error: 'Invalid item price' });
 // SECURITY: atomic stock claim (no overselling) + atomic wallet debit AND purchase record in ONE operation:
 // the balance can never go negative and a single "log" cannot be bought twice by parallel requests.
 const stockField = log.type === 'tool' ? 'toolQty' : 'maxPurchases';
 const stockClaim = await Log.findOneAndUpdate(
   { _id: log._id, $expr: { $or: [ { $lte: [ { $ifNull: ['$' + stockField, 0] }, 0 ] }, { $lt: [ { $ifNull: ['$soldCount', 0] }, '$' + stockField ] } ] } },
   { $inc: { soldCount: 1 } }, { new: true }
 );
 if (!stockClaim) return res.status(400).json({ error: 'This item is sold out.' });
 const dedupe = log.type === 'log' ? { 'purchaseDetails.logId': { $ne: log._id } } : {};
 const updatedUser = await User.findOneAndUpdate(
   { _id: user._id, balance: { $gte: log.price }, ...dedupe },
   { $inc: { balance: -log.price }, $push: { purchaseDetails: {
   logId: log._id, logTitle: log.title, logType: log.type, logDetails: log.details || '',
   toolLink: log.toolLink || '', deliveryType: log.deliveryType || 'link',
   deliverableFile: log.deliverableFile || '', deliverableFileName: log.deliverableFileName || '',
   pricePaid: log.price, purchasedAt: new Date()
 } } },
   { new: true }
 );
 if (!updatedUser) {
   await Log.updateOne({ _id: log._id }, { $inc: { soldCount: -1 } });
   return res.status(400).json({ error: 'Insufficient balance (or you already purchased this account). Please deposit funds.' });
 }
 await Transaction.create({ userId: user._id, type: 'purchase', amount: log.price, description: `Purchased: ${log.title}`, status: 'success' });
 await creditReferralCommission(updatedUser, log.price, log.title);
 checkAndAwardBadges(user._id).catch(() => {});

 // ── Send purchase confirmation email ──────────────────────
 try {
   if (rshCampaigns && typeof rshCampaigns.sendPurchaseEmail === 'function') {
     rshCampaigns.sendPurchaseEmail({
       user: updatedUser,
       item: { title: log.title, type: log.type, price: log.price },
       newBalance: updatedUser.balance
     }).catch(() => {}); // fire-and-forget, never block response
   }
 } catch (_) {}

 res.json({
   message: 'Purchase successful!', newBalance: updatedUser.balance,
   logDetails: log.details || '', toolLink: log.toolLink || '',
   deliveryType: log.deliveryType || 'link',
   deliverableFile: log.deliverableFile || '', deliverableFileName: log.deliverableFileName || '',
   logType: log.type, logTitle: log.title,
 });
 } catch (e) { res.status(500).json({ error: 'Purchase failed: ' + e.message }); }
});
app.post('/api/logs/buy-multi/:id', auth, async (req, res) => {
  const claimedIds = []; // track what we've claimed so we can roll back on any failure
  try {
    const { subAccountIds } = req.body;
    if (!Array.isArray(subAccountIds) || !subAccountIds.length)
      return res.status(400).json({ error: 'Select at least one account to buy' });
    if (subAccountIds.length > 50)
      return res.status(400).json({ error: 'Please buy in smaller batches (max 50 at once)' });
    const log = await Log.findById(req.params.id);
    if (!log || !log.available) return res.status(404).json({ error: 'Item not available' });
    if (log.listingType !== 'folder') return res.status(400).json({ error: 'This item does not support multi-select purchase' });
    const user = await User.findById(req.user._id);
    const claimedSubs = []; // { _id, price, label, details, ... } for each successfully claimed sub
    for (const subId of subAccountIds) {
      const claimed = await Log.findOneAndUpdate(
        { _id: log._id, subAccounts: { $elemMatch: { _id: subId, sold: false } } },
        { $set: { 'subAccounts.$.sold': true, 'subAccounts.$.soldTo': user._id, 'subAccounts.$.soldAt': new Date() } },
        { new: true }
      );
      if (!claimed) {
        for (const rid of claimedIds) {
          await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
        }
        return res.status(400).json({ error: 'One of the selected accounts was just sold to someone else. Please refresh and try again.' });
      }
      claimedIds.push(subId);
      claimedSubs.push(claimed.subAccounts.id(subId));
    }
    if (claimedSubs.some(sa => !subHasCredentials(sa))) {
      for (const rid of claimedIds) {
        await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
      }
      claimedIds.length = 0;
      return res.status(409).json({ error: 'This account has no login details added yet, so you were NOT charged. Please contact admin or choose another account.' });
    }
    const total = claimedSubs.reduce((sum, s) => sum + (s.price || 0), 0);
    if ((user.balance || 0) < total) {
      for (const rid of claimedIds) {
        await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
      }
      return res.status(400).json({ error: 'Insufficient balance for this batch. Please deposit funds.' });
    }
    const _docs = claimedSubs.map(sub => ({
 logId: log._id, logTitle: `${log.title} — ${sub.label}`, logType: log.type, logDetails: sub.details || '',
 toolLink: sub.toolLink || '', deliveryType: sub.deliveryType || 'link',
 deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || '',
 pricePaid: sub.price, subAccountId: sub._id
 }));
 // SECURITY: atomic conditional debit + purchase records in one write (no double-spend, no negative balance)
 const _debited = await User.findOneAndUpdate(
 { _id: user._id, balance: { $gte: total } },
 { $inc: { balance: -total }, $push: { purchaseDetails: { $each: _docs } } }, { new: true }
 );
 if (!_debited) {
 for (const rid of claimedIds) await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: 'Insufficient balance for this batch. Please deposit funds.' });
 }
 user.balance = _debited.balance; user.purchaseDetails = _debited.purchaseDetails;
 const purchasedItems = [];
 const newRecords = _debited.purchaseDetails.slice(-claimedSubs.length);
    newRecords.forEach((rec, i) => {
      purchasedItems.push({
        logDetails: rec.logDetails, toolLink: rec.toolLink, deliveryType: rec.deliveryType,
        deliverableFile: rec.deliverableFile, deliverableFileName: rec.deliverableFileName,
        logTitle: rec.logTitle, purchaseId: rec._id, purchasedAt: rec.purchasedAt, pricePaid: rec.pricePaid
      });
    });
    await Transaction.create({
      userId: user._id, type: 'purchase', amount: total,
      description: `Purchased ${claimedSubs.length} accounts from ${log.title}`, status: 'success'
    });
    for (const sub of claimedSubs) {
      await creditReferralCommission(user, sub.price, `${log.title} — ${sub.label}`);
    }
    checkAndAwardBadges(user._id).catch(() => {});
    const freshLog = await Log.findById(log._id);
    const boughtIds = new Set(claimedIds.map(String));
    const remaining = freshLog.subAccounts.filter(sa => !boughtIds.has(String(sa._id)));
    remaining.forEach((sa, idx) => { sa.label = `Account ${idx + 1}`; });
    freshLog.subAccounts = remaining;
    await freshLog.save();
    res.json({ message: `${claimedSubs.length} accounts purchased!`, newBalance: user.balance, total, items: purchasedItems });
  } catch (e) {
    for (const rid of claimedIds) {
      try { await Log.updateOne({ _id: req.params.id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } }); } catch {}
    }
    res.status(500).json({ error: 'Purchase failed: ' + e.message });
  }
});
app.post('/api/logs/:id/review', auth, reviewUpload.single('reviewFile'), async (req, res) => {
 try {
 const { rating, subAccountId, reviewType } = req.body;
 let content = req.body.content;
 if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1–5 required' });
 if (!['text', 'image', 'video', 'link'].includes(reviewType)) return res.status(400).json({ error: 'Invalid review type' });
 if (reviewType === 'image' || reviewType === 'video') {
 if (!req.file) return res.status(400).json({ error: `Please upload a ${reviewType} file` });
 content = fileUrl(req.file);
 } else {
 if (!content || !content.trim()) return res.status(400).json({ error: 'Review content required' });
 content = content.trim();
 }
 const user = await User.findById(req.user._id);
 const purchase = user.purchaseDetails.find(p => String(p.logId) === req.params.id && (!subAccountId || String(p.subAccountId) === String(subAccountId)));
 if (!purchase) return res.status(403).json({ error: 'Purchase this item first' });
 const log = await Log.findById(req.params.id);
 if (!log) return res.status(404).json({ error: 'Not found' });
 if (log.listingType === 'folder') {
 if (!subAccountId) return res.status(400).json({ error: 'subAccountId required for folder listings' });
 const sub = log.subAccounts.id(subAccountId);
 if (!sub) return res.status(404).json({ error: 'Sub-account not found' });
 if (sub.reviews.find(r => String(r.userId) === String(user._id)))
 return res.status(400).json({ error: 'Already reviewed' });
 sub.reviews.push({ userId: user._id, userName: user.name, rating: parseInt(rating), reviewType, content });
 await log.save();
 return res.json({ message: 'Review submitted!' });
 }
 if (log.reviews.find(r => String(r.userId) === String(user._id)))
 return res.status(400).json({ error: 'Already reviewed' });
 log.reviews.push({ userId: user._id, userName: user.name, rating: parseInt(rating), reviewType, content });
 await log.save();
 res.json({ message: 'Review submitted!' });
 } catch (e) { res.status(500).json({ error: 'Review failed: ' + e.message }); }
});
// ── ACTIVITY WINDOW ───────────────────────────────────────────────────────────
// "Live activity" and "active users" always look back a rolling 24 hours.
// The window is computed from absolute UTC timestamps (Date.now() minus the
// window), so it is timezone-independent: a user in Lagos, London or Los
// Angeles sees the same rolling 24h slice of data, and no calendar-day or
// server-timezone boundary can shrink it back to a shorter window.
const ACTIVITY_WINDOW_HOURS = 24;
const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000;
const activitySince = () => new Date(Date.now() - ACTIVITY_WINDOW_MS);
app.get('/api/public/stats', async (req, res) => {
 try {
 const [activeLogs, activeTools, categoryCount, deliveredCount, totalUsers] = await Promise.all([
 Log.countDocuments({ type: 'log', available: true }),
 Log.countDocuments({ type: 'tool', available: true }),
 Category.countDocuments(),
 Transaction.countDocuments({ type: 'purchase', status: 'success' }),
 User.countDocuments()
 ]);
 res.json({ activeLogs, activeTools, categoryCount, deliveredCount, totalUsers });
 } catch (e) { res.status(500).json({ error: 'Failed to load stats' }); }
});
// Live activity for the last 24 hours — powers the public "LIVE" strip on the home page.
// Names are masked, no user ids leave the server; purely social proof.
app.get('/api/public/live-stats', async (req, res) => {
 try {
 const since = activitySince();
 const maskName = (n) => {
 const name = String(n || 'User').trim();
 if (name.length <= 2) return name[0] + '***';
 return name.slice(0, 2) + '***' + name.slice(-1);
 };
 const [purchases, deposits, recent] = await Promise.all([
 Transaction.aggregate([
 { $match: { type: 'purchase', status: 'success', createdAt: { $gte: since } } },
 { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$amount' } } }
 ]),
 Transaction.aggregate([
 { $match: { type: 'deposit', status: 'success', createdAt: { $gte: since } } },
 { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$amount' } } }
 ]),
 Transaction.find({ type: { $in: ['purchase', 'deposit'] }, status: 'success', createdAt: { $gte: since } })
 .sort({ createdAt: -1 }).limit(8).populate('userId', 'name').lean()
 ]);
 res.json({
 windowHours: ACTIVITY_WINDOW_HOURS,
 purchases: { count: purchases[0]?.count || 0, volume: Math.round(purchases[0]?.volume || 0) },
 deposits: { count: deposits[0]?.count || 0, volume: Math.round(deposits[0]?.volume || 0) },
 feed: (recent || []).map(t => ({
 type: t.type,
 amount: Math.round(t.amount || 0),
 name: maskName(t.userId && t.userId.name),
 at: t.createdAt
 }))
 });
 } catch (e) {
 res.status(500).json({ error: 'Failed to load live stats' });
 }
});
app.get('/api/categories', async (req, res) => {
 try {
 const cats = await Category.find().sort({ name: 1 });
 res.json(Array.isArray(cats) ? cats : []);
 } catch (e) {
 console.error('GET /api/categories error:', e.message);
 res.status(500).json([]);
 }
});
app.get('/api/admin/categories', adminAuth, async (req, res) => {
 res.json(await Category.find().sort({ name: 1 }));
});
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
 try {
 const { showReviews } = req.body;
 const update = {};
 if (typeof showReviews !== 'undefined') update.showReviews = showReviews === true || showReviews === 'true';
 const cat = await Category.findByIdAndUpdate(req.params.id, update, { new: true });
 if (!cat) return res.status(404).json({ error: 'Not found' });
 res.json(cat);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
const FIXED_CATEGORIES = [
 'Gmail',
 'TikTok',
 'Facebook',
 'Twitter',
 'Instagram',
 'Snapchat',
 'Texting App',
 'VPN & Proxy',
 'Netflix',
 'Others'
];
async function seedDefaultCategories() {
 for (const name of FIXED_CATEGORIES) {
 await Category.findOneAndUpdate({ name }, { $setOnInsert: { name, showReviews: true } }, { upsert: true });
 }
 await Log.updateMany({ category: 'Texting Apps (TextPlus, NextPlus, Google Voice, TextNow, etc.)' }, { $set: { category: 'Texting App' } });
 await Category.deleteMany({ name: { $nin: FIXED_CATEGORIES } });
}
seedDefaultCategories().catch(() => {});
app.get('/api/banks', async (req, res) => {
 const banks = [
 { name: 'Access Bank', code: '044' },
 { name: 'Citibank Nigeria', code: '023' },
 { name: 'Ecobank Nigeria', code: '050' },
 { name: 'Fidelity Bank', code: '070' },
 { name: 'First Bank of Nigeria', code: '011' },
 { name: 'First City Monument Bank (FCMB)', code: '214' },
 { name: 'Globus Bank', code: '00103' },
 { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
 { name: 'Heritage Bank', code: '030' },
 { name: 'Keystone Bank', code: '082' },
 { name: 'Kuda Bank', code: '50211' },
 { name: 'Moniepoint MFB', code: '50515' },
 { name: 'OPay (PayCom)', code: '999992' },
 { name: 'Palmpay', code: '999991' },
 { name: 'Parallex Bank', code: '526' },
 { name: 'Polaris Bank', code: '076' },
 { name: 'Providus Bank', code: '101' },
 { name: 'Stanbic IBTC Bank', code: '221' },
 { name: 'Standard Chartered Bank', code: '068' },
 { name: 'Sterling Bank', code: '232' },
 { name: 'Suntrust Bank', code: '100' },
 { name: 'Taj Bank', code: '302' },
 { name: 'Union Bank of Nigeria', code: '032' },
 { name: 'United Bank for Africa (UBA)', code: '033' },
 { name: 'Unity Bank', code: '215' },
 { name: 'VFD Microfinance Bank', code: '566' },
 { name: 'Wema Bank', code: '035' },
 { name: 'Zenith Bank', code: '057' },
 { name: 'Carbon (Paylater)', code: '565' },
 { name: 'Rubies MFB', code: '125' },
 { name: 'Sparkle MFB', code: '51310' },
 { name: 'ALAT by Wema', code: '035A' },
 { name: 'Mint MFB', code: '50304' },
 { name: 'Jaiz Bank', code: '301' }
 ];
 res.json(banks);
});
app.get('/api/verify-account', auth, async (req, res) => {
 const { account_number, bank_code } = req.query;
 if (!account_number || !bank_code) return res.status(400).json({ error: 'Account number and bank code required' });
 try {
 const r = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`, {
 headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
 timeout: 8000
 });
 res.json({ accountName: r.data.data.account_name, accountNumber: r.data.data.account_number });
 } catch (e) {
 res.status(400).json({ error: 'Name lookup unavailable. Enter your name manually.' });
 }
});
const FLW_IS_LIVE = process.env.FLW_ENV === 'live';
const FLW_API_BASE = FLW_IS_LIVE
 ? 'https://api.flutterwave.cloud/f4bexperience' // production
 : 'https://developersandbox-api.flutterwave.com'; // sandbox/test
const rshCountries = require('./lib/countries');
const rshGeo = require('./lib/geo');
const rshFx = require('./lib/fx');
const rshFlwMethods = require('./lib/flw-methods');
let rshPlatform = null; // set once lib/platform.js is mounted at the bottom of this file
const FLW_TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
let _flwTokenCache = { token: null, expiresAt: 0 };
async function getFlwAccessToken() {
 if (_flwTokenCache.token && Date.now() < _flwTokenCache.expiresAt - 30000) return _flwTokenCache.token; // 30s safety margin
 const params = new URLSearchParams({
 client_id: process.env.FLW_CLIENT_ID,
 client_secret: process.env.FLW_CLIENT_SECRET,
 grant_type: 'client_credentials'
 });
 const tokenRes = await axios.post(FLW_TOKEN_URL, params, {
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000
 });
 _flwTokenCache = { token: tokenRes.data.access_token, expiresAt: Date.now() + (tokenRes.data.expires_in * 1000) };
 return _flwTokenCache.token;
}
async function flwHeaders() {
 const token = await getFlwAccessToken();
 return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function handleFlutterwaveWebhook(req, res) {
 const receivedHash = req.headers['verif-hash'];
 const expectedHash = process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_HASH || '';
 console.log(' RSH webhook received (signature present:', !!receivedHash, ')');
 // SECURITY: a webhook is ONLY accepted when FLW_SECRET_HASH is configured AND matches (constant-time).
 if (!expectedHash || !safeEqual(receivedHash, expectedHash)) {
 console.error(' RSH webhook REJECTED:', !expectedHash ? 'FLW_SECRET_HASH is not configured on the server' : 'signature mismatch');
 if (rshPlatform) await rshPlatform.logWebhook({ channel: 'charge', status: 'signature_rejected', message: !expectedHash ? 'FLW_SECRET_HASH not configured' : 'verif-hash mismatch', payload: {} });
 return res.status(401).json({ error: 'Invalid webhook signature' });
 }
 const event = req.body;
 const tx = event.data || {};
 const eventType = event.event || event.type;
 const txStatus = tx.status;
 const txRefAny = tx.tx_ref || tx.reference || '';
 console.log('RSH webhook event:', eventType);
 console.log(' tx.id :', tx.id);
 console.log(' tx.tx_ref/ref :', txRefAny);
 console.log(' tx.flw_ref :', tx.flw_ref);
 console.log(' tx.amount :', tx.amount);
 console.log(' tx.status :', txStatus);
 console.log(' tx.currency :', tx.currency);
 console.log(' tx.customer :', JSON.stringify(tx.customer || {}));
 console.log(' tx.va_number :', tx.virtual_account_number || '(none)');
 console.log(' tx.narration :', tx.narration || tx.meta?.narration || '(none)');
 console.log(' tx.meta :', JSON.stringify(tx.meta || {}).slice(0, 300));
 // Record every delivery so the admin desk can prove what arrived and when.
 const whLog = rshPlatform ? await rshPlatform.logWebhook({
 channel: 'charge', event: eventType || 'unknown', reference: txRefAny,
 txId: tx.id, amount: tx.amount, currency: tx.currency,
 status: 'received', message: `status=${txStatus}`, payload: event,
 }) : null;
 const markWebhook = async (status, message) => {
 try {
 if (whLog && rshPlatform) {
 await rshPlatform.WebhookEvent.updateOne({ _id: whLog._id }, { $set: { status, message: String(message || '').slice(0, 900) } });
 if (['failed', 'conversion_error'].includes(status)) {
 await rshPlatform.alertOps('webhook_' + status, `Flutterwave charge webhook ${status}`, message, { reference: txRefAny, txId: tx.id });
 }
 }
 } catch { /* logging never breaks a credit */ }
 };
 const validCompletionEvents = ['charge.completed', 'charge.successful', 'transfer.completed', 'payment.successful'];
 const normEventType = String(eventType || '').trim().toLowerCase();
 if (!validCompletionEvents.includes(normEventType)) {
  res.json({ received: true });
  // ── AUTO-REVERSAL ──────────────────────────────────────────────────────────
  const isReversalEvent = [
    'transfer.reversal','charge.reversed','transfer.failed','virtual_account.reversed',
    'charge.failed','refund.processed','charge.refunded','refund.successful','transfer.reversed'
  ].includes(String(eventType || '').toLowerCase());
  if (isReversalEvent && txRefAny) {
    console.log(' [AUTO-REVERSAL] Processing:', eventType, 'ref:', txRefAny);
    try {
      const revIds = [tx.id, tx.flw_ref, tx.tx_ref, tx.reference].filter(Boolean).map(String);
      const origDeposit = await Transaction.findOne({ txRef: { $in: revIds }, type: 'deposit', status: 'success' });
      if (!origDeposit) { await markWebhook('ignored','reversal: no credited deposit for ref: '+txRefAny); return; }
      if (origDeposit.reversed) { await markWebhook('ignored','reversal: already reversed for ref: '+txRefAny); return; }
      const marked = await Transaction.findOneAndUpdate(
        { _id: origDeposit._id, reversed: { $ne: true } },
        { reversed: true, reversedAt: new Date(), reversalReason: 'Auto-reversal: '+eventType },
        { new: true }
      );
      if (!marked) { console.log(' [AUTO-REVERSAL] Concurrent block for ref:', txRefAny); return; }
      const reversalAmount = origDeposit.amount;
      const user = await User.findByIdAndUpdate(origDeposit.userId, { $inc: { balance: -reversalAmount } }, { new: true });
      if (user) {
        await Transaction.create({ userId: user._id, type: 'debit', amount: reversalAmount,
          description: 'Deposit reversal (auto): '+txRefAny+' — '+eventType,
          txRef: txRefAny+'_rev', status: 'success' });
        console.log(' [AUTO-REVERSAL] -₦'+reversalAmount+' from '+user.email+' → balance ₦'+user.balance+(user.balance<0?' (NEGATIVE)':''));
        if (user.balance < 0 && rshPlatform) {
          await rshPlatform.alertOps('negative_balance','User balance went negative after auto-reversal',
            'User: '+user.email+' — Balance: ₦'+user.balance+' after ₦'+reversalAmount+' reversal of '+txRefAny,
            { userId: String(user._id), txRef: txRefAny });
        }
      }
      await markWebhook('credited','Auto-reversal: ₦'+reversalAmount+' deducted from user '+origDeposit.userId);
    } catch (revErr) {
      console.error(' [AUTO-REVERSAL] Error:', revErr.message);
      await markWebhook('failed','auto-reversal error: '+revErr.message);
    }
    return;
  }
  await markWebhook('ignored', 'event type is not charge.completed: ' + eventType);
  console.log(' Skipping: event type is not charge.completed (got:', eventType, ')');
  return;
 }
 const normTxStatus = String(txStatus || '').trim().toLowerCase();
 if (!tx || (!['successful', 'succeeded', 'success', 'completed'].includes(normTxStatus))) {
 res.json({ received: true });
 console.warn(' Skipping: tx.status is not successful/succeeded (got:', txStatus, ')');
 await markWebhook('ignored', 'tx status not successful: ' + txStatus);
 return;
 }
 const normCurrency = String(tx.currency || '').trim().toUpperCase();
 if (normCurrency !== 'NGN' && normCurrency !== 'USD') {
 res.json({ received: true });
 console.warn(' Skipping: unsupported settlement currency (got:', tx.currency, ')');
 await markWebhook('ignored', 'unsupported currency: ' + tx.currency);
 return;
 }
 console.log(' All checks passed — processing credit...');
 // Credit BEFORE answering Flutterwave. The old code answered 200 first and
 // credited in setImmediate(): any crash, restart or transient DB/API error in
 // that background task silently threw the deposit away and Flutterwave never
 // retried it, which is why some deposits simply never confirmed.
 const processCharge = async () => {
 try {
 if (txRefAny) {
 console.log(` Checking ref '${txRefAny}' against PaymentLinkDeposit...`);
 const plDeposit = await PaymentLinkDeposit.findOne({ txRef: txRefAny });
 if (plDeposit) {
 console.log(` Matched PaymentLinkDeposit — routing to handlePaymentLinkWebhookCredit`);
 if (plDeposit.status === 'success') {
 if (rshPlatform) await rshPlatform.logIdempotencyConflict(txRefAny, 'Payment link deposit was already credited — duplicate delivery ignored', { txId: tx.id });
 await markWebhook('duplicate', 'payment link deposit already credited');
 return;
 }
 await handlePaymentLinkWebhookCredit(plDeposit, tx);
 await markWebhook('processed', 'Payment link deposit credited');
 return;
 }
 console.log(` Not a PL deposit. Checking BankTransferDeposit...`);
 const btDeposit = await BankTransferDeposit.findOne({ reference: txRefAny, status: 'pending' });
 if (btDeposit) {
 console.log(` Matched BankTransferDeposit ref=${txRefAny} — crediting via webhook`);
 if (await Transaction.exists({ txRef: chargeKey(tx) })) { await markWebhook('duplicate', 'charge already credited'); return; }
 const btConfirmed = await flwConfirmCharge(tx, { expectedRef: btDeposit.reference, minAmount: btDeposit.amount * 0.99, currency: 'NGN' });
 if (!btConfirmed) { await markWebhook('failed', 'bank transfer failed server-side verification'); return; }
 const freshBT = await BankTransferDeposit.findOneAndUpdate(
 { _id: btDeposit._id, status: 'pending' },
 { status: 'success', flwChargeId: String(tx.flw_ref || tx.id || '') },
 { new: true }
 );
 if (freshBT) {
 const btUser = await User.findByIdAndUpdate(
 freshBT.userId,
 { $inc: { balance: freshBT.creditAmount } },
 { new: true }
 );
 await Transaction.create({
 userId: freshBT.userId, type: 'deposit', amount: freshBT.creditAmount, txRef: chargeKey(tx),
 description: `VA bank transfer deposit — ₦${freshBT.creditAmount.toLocaleString('en-NG')} credited (fee ₦${freshBT.fee}) via ${freshBT.bankName || 'bank transfer'}`,
 status: 'success'
 });
 if (btUser) pushBalanceToUser(freshBT.userId, btUser.balance);
 console.log(` BT webhook credited ₦${freshBT.creditAmount} for user ${freshBT.userId}`);
 await markWebhook('processed', 'Bank transfer deposit credited');
 } else {
 console.log(` BT deposit already credited (race condition prevented)`);
 if (rshPlatform) await rshPlatform.logIdempotencyConflict(txRefAny, 'Bank transfer deposit already credited — duplicate delivery ignored', { txId: tx.id });
 await markWebhook('duplicate', 'bank transfer deposit already credited');
 }
 return;
 }
 console.log(` No PL or BT deposit matched ref. Continuing to permanent VA match...`);
 }
 const settings = await getVASettings();
 if (!settings.globalEnabled) {
 console.warn('RSH webhook: virtual accounts globally disabled — tx', tx.id, 'not credited');
 return;
 }
 let user = null;
 const customerEmail = (tx.customer?.email || '').trim().toLowerCase();
 if (customerEmail) {
 user = await User.findOne({ email: customerEmail });
 if (user) console.log('RSH webhook: matched user by email:', customerEmail);
 }
 if (!user) {
 const meta = tx.meta || {};
 const vaAccNum =
 tx.virtual_account_number ||
 meta.virtual_account_number ||
 meta.account_number ||
 meta.destinationAccountNumber ||
 meta.beneficiaryAccountNumber ||
 (tx.account?.number) ||
 null;
 if (vaAccNum) {
 user = await User.findOne({ 'virtualAccount.accountNumber': vaAccNum });
 if (user) console.log('RSH webhook: matched user by VA account number:', vaAccNum);
 }
 }
 if (!user) {
 const narration = String(tx.narration || tx.meta?.narration || '');
 if (narration.startsWith(BRAND.txPrefix + ' ') || narration.startsWith(BRAND.txPrefix + '-')) {
 const nameSlug = narration.replace(new RegExp('^' + BRAND.txPrefix + '[-\\s]', 'i'), '').split(/[\s-]/)[0].toLowerCase();
 if (nameSlug.length >= 3) {
 user = await User.findOne({
 'virtualAccount.enabled': true,
 name: { $regex: new RegExp('^' + nameSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
 });
 if (user) console.log('RSH webhook: matched user by narration slug:', nameSlug, '', user.name);
 }
 }
 }
 if (!user) {
 await markWebhook('failed', 'No RSH user could be matched to this payment');
 console.warn('RSH webhook: NO user found for tx', tx.id,
 '| email:', customerEmail, '| ref:', txRefAny,
 '| This payment arrived in Flutterwave but was NOT credited.',
 '| Full customer:', JSON.stringify(tx.customer));
 return;
 }
 if (!user.virtualAccount?.enabled) {
 console.warn(`RSH webhook: VA disabled for ${user.email} — ₦${tx.amount} NOT credited`);
 return;
 }
 await handleVaWebhookCredit(user, tx);
 await markWebhook('processed', 'Virtual account deposit credited');
 } catch (e) {
 console.error('RSH webhook error:', e.message, e.stack?.slice(0, 400));
 await markWebhook('failed', e.message);
 throw e;
 }
 };
 try {
 await processCharge();
 res.json({ received: true });
 } catch {
 // Non-2xx = Flutterwave retries this exact delivery. The credit path is
 // idempotent, so a retry can never double-credit.
 res.status(500).json({ error: 'processing_failed, please retry' });
 }
}
app.post('/api/webhooks/flutterwave', express.json(), handleFlutterwaveWebhook);
app.post('/api/deposit/paymentlink/callback', express.json(), handleFlutterwaveWebhook);
// One stable key per Flutterwave charge. tx.id is the only value Flutterwave
// guarantees to be identical on every delivery / API read of the same charge;
// flw_ref alone changed shape between retries and channels, which is how the
// same money could be recorded twice under two different keys.
// SECURITY: never trust a webhook body alone. Confirm the charge with Flutterwave's API.
// Returns the verified charge, or null if it is not a matching successful payment.
// THROWS if Flutterwave cannot be reached so the webhook answers 500 and Flutterwave retries (fail-closed).
async function flwConfirmCharge(tx, { expectedRef, minAmount, currency }) {
 let vtx = null;
 if (tx && tx.id) {
  const r = await flwAxios.get(`/transactions/${encodeURIComponent(tx.id)}/verify`, { timeout: 10000 });
  vtx = r.data && r.data.data;
 } else if (expectedRef) {
  const r = await flwAxios.get('/transactions/verify_by_reference', { params: { tx_ref: expectedRef }, timeout: 10000 });
  vtx = r.data && r.data.data;
 }
 if (!vtx) return null;
 const ok = String(vtx.status || '').trim().toLowerCase() === 'successful'
  && String(vtx.currency || '').trim().toUpperCase() === String(currency || 'NGN').toUpperCase()
  && Number(vtx.amount) >= Number(minAmount || 0)
  && (!expectedRef || String(vtx.tx_ref || vtx.reference || '') === String(expectedRef));
 return ok ? vtx : null;
}
function chargeKey(tx) {
 return String(tx.id || tx.flw_ref || tx.tx_ref || tx.reference || '');
}
// A charge that already belongs to a payment link or a one-off bank-transfer
// deposit must never be credited again by the permanent-VA path (webhook or
// reconciler) — that was a real double-credit route.
async function chargeBelongsToOtherChannel(tx) {
 const ids = [tx.id, tx.flw_ref, tx.tx_ref, tx.reference].filter(Boolean).map(String);
 if (!ids.length) return false;
 try {
  const [pl, bt] = await Promise.all([
   PaymentLinkDeposit.findOne({ $or: [{ txRef: { $in: ids } }, { flwTransactionId: { $in: ids } }] }).select('_id'),
   BankTransferDeposit.findOne({ $or: [{ reference: { $in: ids } }, { flwChargeId: { $in: ids } }] }).select('_id')
  ]);
  return !!(pl || bt);
 } catch { return false; }
}
async function handleVaWebhookCredit(user, tx) {
 const flwRef = chargeKey(tx);
 if (!flwRef) { console.warn(' VA credit skipped: charge has no usable reference'); return { status: 'skipped' }; }
 console.log(`\n handleVaWebhookCredit START user=${user.email} key=${flwRef} amount=${tx.amount}`);
 if (await chargeBelongsToOtherChannel(tx)) {
  console.log(` ${flwRef} belongs to a payment-link/bank-transfer deposit — not crediting again`);
  return { status: 'duplicate' };
 }
 const receivedAmount = Number(tx.amount || 0);
 if (receivedAmount <= 0) { console.warn(' SKIPPED: received amount is zero or negative'); return { status: 'skipped' }; }
 const fee = calcDepositFee(receivedAmount);
 const creditAmount = receivedAmount - fee;
 if (creditAmount <= 0) { console.warn(` SKIPPED: credit ₦${creditAmount} after ₦${fee} fee`); return { status: 'skipped' }; }

 // ── ATOMIC CLAIM ───────────────────────────────────────────────────────────
 // The old code did findOne() then create(). Two deliveries arriving at the
 // same moment (webhook + poll, or several users hitting the box at once) both
 // saw "no record" and both credited. Now the claim is a single upsert: only
 // the request that actually INSERTS the row is allowed to move money.
 let claimedNew = false;
 let claimId = null;
 try {
  const claim = await VirtualAccountDeposit.findOneAndUpdate(
   { flwRef },
   { $setOnInsert: {
     userId: user._id, flwRef, flwTxId: String(tx.id || ''),
     amount: receivedAmount, creditAmount,
     accountNumber: user.virtualAccount?.accountNumber || '',
     status: 'pending', rawPayload: tx, createdAt: new Date()
    } },
   { upsert: true, new: true, rawResult: true }
  );
  claimedNew = !claim?.lastErrorObject?.updatedExisting;
  claimId = claim?.value?._id;
 } catch (e) {
  if (e && e.code === 11000) { console.log(` DUPLICATE ${flwRef} — another worker already claimed it`); return { status: 'duplicate' }; }
  throw e; // real DB problem → webhook returns 500 → Flutterwave retries
 }
 if (!claimedNew) { console.log(` DUPLICATE ${flwRef} for ${user.email} — already recorded, skipping`); return { status: 'duplicate' }; }

 // ── INDEPENDENT VERIFICATION ───────────────────────────────────────────────
 let verified = false;
 try {
  const vRes = await flwAxios.get(`/transactions/${encodeURIComponent(tx.id)}/verify`, { timeout: 8000 });
  const vtx = vRes.data?.data;
  if (vtx) {
   verified = String(vtx.status || '').trim().toLowerCase() === 'successful' && String(vtx.currency || '').trim().toUpperCase() === 'NGN' && Number(vtx.amount) >= receivedAmount * 0.99;
   console.log(` verify: status=${vtx.status} currency=${vtx.currency} amount=${vtx.amount} → ${verified}`);
  } else {
   verified = false;
   console.warn(' Verify returned no data — NOT crediting');
  }
 } catch (ve) {
  // fail CLOSED: release the claim and let Flutterwave retry the webhook later
  if (claimId) await VirtualAccountDeposit.deleteOne({ _id: claimId, status: 'pending' }).catch(() => {});
  console.warn(` Verify API unavailable (${ve.message}) — NOT crediting, webhook will be retried`);
  throw new Error('verification unavailable');
 }
 if (!verified) {
  // Release the claim so a later legitimate delivery can still be credited.
  if (claimId) await VirtualAccountDeposit.deleteOne({ _id: claimId, status: 'pending' }).catch(() => {});
  console.warn(` ${flwRef} NOT credited — failed Flutterwave verification`);
  return { status: 'rejected' };
 }

 // ── MONEY MOVES ONCE ───────────────────────────────────────────────────────
 // The wallet transaction carries txRef = the charge key and a unique index,
 // so even if this collection was ever recreated without the VA index, the
 // second attempt throws instead of crediting twice.
 try {
  await Transaction.create({
   userId: user._id, type: 'deposit', amount: creditAmount, txRef: flwRef,
   description: `VA deposit — ₦${creditAmount.toLocaleString('en-NG')} credited (₦${receivedAmount.toLocaleString('en-NG')} received, ₦${fee} fee) via ${user.virtualAccount?.bankName || 'bank transfer'}`,
   status: 'success'
  });
 } catch (e) {
  if (e && e.code === 11000) {
   console.log(` ${flwRef} already has a wallet transaction — not crediting again`);
   await VirtualAccountDeposit.updateOne({ _id: claimId }, { $set: { status: 'success' } }).catch(() => {});
   return { status: 'duplicate' };
  }
  throw e;
 }
 const updated = await User.findByIdAndUpdate(user._id, { $inc: { balance: creditAmount } }, { new: true }).select('balance');
 await VirtualAccountDeposit.updateOne({ _id: claimId }, { $set: { status: 'success' } });
 if (updated) {
  pushBalanceToUser(user._id, updated.balance, creditAmount);
  const vaDepMsg = `event: va_deposit\ndata: ${JSON.stringify({
   creditAmount, receivedAmount, fee, balance: updated.balance,
   bank: user.virtualAccount?.bankName || 'bank transfer', flwRef, ts: Date.now()
  })}\n\n`;
  const clients = sseClients.get(String(user._id));
  if (clients && clients.size) { for (const r of clients) { try { r.write(vaDepMsg); } catch { clients.delete(r); } } }
 }
 console.log(` RSH VA credited: ₦${creditAmount} to ${user.email} (received ₦${receivedAmount}, fee ₦${fee}) | key:${flwRef}`);
 return { status: 'credited', creditAmount };
}
async function handlePaymentLinkWebhookCredit(deposit, tx) {
 if (deposit.status === 'success') { console.log(`Payment link webhook: tx_ref ${deposit.txRef} already credited — skipped`); return; }
 const expectedCurrency = String(deposit.currency || 'NGN').toUpperCase();
 const gotCurrency = String(tx.currency || 'NGN').toUpperCase();
 if (gotCurrency !== expectedCurrency) {
 console.warn(`Payment link webhook: currency mismatch for ${deposit.txRef} — expected ${expectedCurrency}, got ${tx.currency}`);
 return;
 }
 const receivedAmt = Number(tx.charged_amount || tx.amount || 0);
 if (receivedAmt < (deposit.amount * 0.98)) {
 console.warn(`Payment link webhook: amount mismatch for ${deposit.txRef} — expected ≥${expectedCurrency} ${deposit.amount}, got ${tx.amount}`);
 return;
 }
 const confirmedTx = await flwConfirmCharge(tx, { expectedRef: deposit.txRef, minAmount: deposit.amount * 0.98, currency: expectedCurrency });
 if (!confirmedTx) { console.warn(`Payment link webhook: ${deposit.txRef} FAILED server-side verification — not credited`); return; }
 await creditPaymentLinkDeposit(deposit, confirmedTx);
 console.log(` Payment link deposit credited via webhook: ₦${deposit.creditAmount} for tx_ref ${deposit.txRef}`);
}
const FLW_PROXY_URL = process.env.FLW_PROXY_URL || '';
let flwProxyAgent = null;
if (FLW_PROXY_URL) {
 try {
 const { HttpsProxyAgent } = require('https-proxy-agent');
 flwProxyAgent = new HttpsProxyAgent(FLW_PROXY_URL);
 console.log('Flutterwave requests will be routed through FLW_PROXY_URL');
 } catch (e) {
 console.error('FLW_PROXY_URL is set but https-proxy-agent failed to load — run `npm install`. Falling back to direct requests.', e.message);
 }
}
const FLW_V3_BASE = 'https://api.flutterwave.com/v3';
const flwAxios = axios.create({
 baseURL: FLW_V3_BASE,
 timeout: 15000,
 httpsAgent: flwProxyAgent || undefined,
 proxy: false // disable axios' own proxy env-var handling; we manage the agent ourselves
});
flwAxios.interceptors.request.use(config => {
 config.headers = { ...config.headers, Authorization: `Bearer ${process.env.FLW_V3_SECRET_KEY}` };
 return config;
});
const virtualAccountDepositSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 flwRef: { type: String, required: true, unique: true }, // Flutterwave tx reference (Paystack rows are prefixed PSK-)
 gateway: { type: String, enum: ['flutterwave', 'paystack'], default: 'flutterwave' },
 flwTxId: { type: String, default: '' },
 amount: { type: Number, required: true },
 creditAmount: { type: Number, required: true },
 accountNumber: { type: String },
 status: { type: String, enum: ['pending','success','failed'], default: 'pending' },
 rawPayload: { type: Object },
 createdAt: { type: Date, default: Date.now }
});
const VirtualAccountDeposit = mongoose.model('VirtualAccountDeposit', virtualAccountDepositSchema);
// One single settings document — there used to be two different schemas
// registered under the same model name, which meant findOne() could return a
// *different* document than the one the admin toggle wrote to. That is exactly
// how "Virtual Accounts Temporarily Unavailable" ended up showing for some
// people while others were fine. Now there is exactly one document, always.
const virtualAccountSettingsSchema = new mongoose.Schema({
 globalEnabled: { type: Boolean, default: true },
 updatedAt: { type: Date, default: Date.now }
});
const VirtualAccountSettings = mongoose.model('VirtualAccountSettings', virtualAccountSettingsSchema);
async function getVASettings() {
 try {
 let s = await VirtualAccountSettings.findOne().sort({ _id: 1 });
 if (!s) { s = await VirtualAccountSettings.create({ globalEnabled: true }); }
 // Clean up any stray duplicate settings docs from older releases so the
 // answer can never depend on which one happens to be read first.
 VirtualAccountSettings.deleteMany({ _id: { $ne: s._id } }).catch(() => {});
 return s;
 } catch (e) {
 // Never let a database hiccup look like "maintenance mode" to a customer.
 console.error('[RSH] getVASettings failed, defaulting to ENABLED:', e.message);
 return { globalEnabled: true };
 }
}
app.put('/api/admin/virtual-accounts/settings', adminAuth, async (req, res) => {
 try {
 const { globalEnabled } = req.body;
 let s = await VirtualAccountSettings.findOne().sort({ _id: 1 });
 if (!s) s = new VirtualAccountSettings();
 s.globalEnabled = !!globalEnabled;
 s.updatedAt = new Date();
 await s.save();
 await VirtualAccountSettings.deleteMany({ _id: { $ne: s._id } }).catch(() => {});
 console.log('[RSH] Admin set virtual accounts globalEnabled =', s.globalEnabled);
 res.json({ globalEnabled: s.globalEnabled });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/virtual-accounts/settings', adminAuth, async (req, res) => {
 try {
 const s = await getVASettings();
 res.json({ globalEnabled: s.globalEnabled });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/virtual-accounts', adminAuth, async (req, res) => {
 try {
 const users = await User.find({ 'virtualAccount.accountNumber': { $ne: '' } })
 .select('name email virtualAccount balance createdAt')
 .sort({ 'virtualAccount.createdAt': -1 })
 .limit(500);
 res.json(users.map(u => ({
 id: u._id, name: u.name, email: u.email, balance: u.balance,
 virtualAccount: u.virtualAccount, createdAt: u.createdAt
 })));
 } catch (e) { res.status(500).json({ error: e.message }); }
});
/**
 * Which country do we treat this customer as being in for the virtual-account
 * rail? Profile country wins, then a Nigerian phone number on the profile
 * (this rescues long-standing users who signed up before the country field
 * existed and who browse through a VPN or a foreign mobile network), then the
 * normal header/IP lookup. Nigeria is the fallback, never a foreign country.
 */
async function resolveVACountry(req, user) {
 const profile = String(user?.country || '').trim().toUpperCase();
 if (profile) return { code: profile, source: 'profile' };
 const phone = String(user?.contactPhone || '').replace(/[^0-9+]/g, '');
 if (/^(\+?234|0)[789]\d{9}$/.test(phone)) return { code: 'NG', source: 'phone' };
 try {
 return await rshGeo.resolveCountry(req, user);
 } catch (e) {
 console.error('[RSH] geo lookup failed, defaulting to NG:', e.message);
 return { code: 'NG', source: 'default' };
 }
}
async function createVirtualAccountForUser(user) {
 // ── NIGERIA-ONLY HARD GUARD ────────────────────────────────────────────────
 // Flutterwave has only approved dedicated virtual accounts for Nigeria on this
 // merchant account (Bank Transfer Ghana is still pending review), so no other
 // market may ever have one created — not by a user, not by an admin.
 const vaCountry = String(user.country || 'NG').toUpperCase();
 if (!rshFlwMethods.supportsVirtualAccount(vaCountry)) {
 const err = new Error('Virtual accounts are available to customers in Nigeria only. Use the payment link — it is priced in US dollars for your country.');
 err.status = 403;
 throw err;
 }
 if (user.virtualAccount?.accountNumber) {
 user.virtualAccount.enabled = true;
 await user.save();
 return { message: 'Virtual account re-enabled', virtualAccount: user.virtualAccount };
 }
 const bvn = process.env.FLW_PLATFORM_BVN;
 if (!bvn) throw new Error('FLW_PLATFORM_BVN is not set in environment variables');
 if (!process.env.FLW_V3_SECRET_KEY) throw new Error('FLW_V3_SECRET_KEY is not set');
 const slug = user.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
 const txRef = `${BRAND.txPrefix}-VA-${slug}-${Date.now()}`;
 const nameParts = user.name.trim().split(/\s+/);
 const firstName = nameParts[0] || BRAND.name;
 const lastName = nameParts.slice(1).join(' ') || 'User';
 const payload = {
 email: user.email, // KEY: this is how we match payments back to the user
 is_permanent: true, // permanent — never expires
 bvn: bvn,
 tx_ref: txRef,
 amount: 0, // no pre-set amount — any amount accepted
 currency: 'NGN',
 narration: `${BRAND.txPrefix} ${user.name.trim().slice(0, 18)}`, // shows on sender's bank receipt
 firstname: firstName,
 lastname: lastName,
 phonenumber: user.contactPhone || '08000000000',
 };
 const flwRes = await flwAxios.post('/virtual-account-numbers', payload, { timeout: 20000 });
 const va = flwRes.data?.data;
 if (!va || !va.account_number) {
 console.error('FLW virtual account creation failed:', flwRes.data);
 throw new Error(flwRes.data?.message || 'Flutterwave did not return an account number');
 }
 user.virtualAccount = {
 enabled: true,
 accountNumber: va.account_number,
 bankName: va.bank_name || 'Wema Bank',
 accountName: `${BRAND.txPrefix} ${user.name.trim()}`.slice(0, 30), // "RSH John Doe" — shown on deposit page and bank receipts
 flwRef: va.flw_ref || txRef,
 createdAt: new Date()
 };
 await user.save();
 return { message: ' Virtual account created', virtualAccount: user.virtualAccount };
}
// ═══ PAYSTACK DEDICATED VIRTUAL ACCOUNTS ════════════════════════════════════
function isPaystackDvaTx(tx) {
 return !!tx && [tx.channel, tx.authorization && tx.authorization.channel].some(c => String(c || '').toLowerCase() === 'dedicated_nuban');
}
// Who owns the account the money was sent to? Account number first, then Paystack customer code.
async function findUserForPaystackVa(...sources) {
 for (const t of sources) {
  if (!t) continue;
  const nums = [t.dedicated_account && t.dedicated_account.account_number, t.authorization && t.authorization.receiver_bank_account_number, t.metadata && t.metadata.receiver_account_number]
   .filter(Boolean).map(String);
  for (const n of nums) {
   const u = await User.findOne({ 'paystackVirtualAccount.accountNumber': n });
   if (u) return u;
  }
 }
 for (const t of sources) {
  const code = t && t.customer && t.customer.customer_code;
  if (code) {
   const u = await User.findOne({ 'paystackVirtualAccount.customerCode': code });
   if (u) return u;
  }
 }
 return null;
}
async function createPaystackVirtualAccountForUser(user) {
 const vaCountry = String(user.country || 'NG').toUpperCase();
 if (vaCountry !== 'NG') {
  const err = new Error('Virtual accounts are available to customers in Nigeria only. Use the payment link — it is priced in US dollars for your country.');
  err.status = 403;
  throw err;
 }
 if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not set');
 if (user.paystackVirtualAccount?.accountNumber) {
  user.paystackVirtualAccount.enabled = true;
  await user.save();
  return { message: 'Virtual account re-enabled', virtualAccount: user.paystackVirtualAccount };
 }
 const email = String(user.email || '').trim().toLowerCase();
 const nameParts = String(user.name || '').trim().split(/\s+/);
 const first_name = nameParts[0] || BRAND.name;
 const last_name = nameParts.slice(1).join(' ') || 'User';
 const phone = user.contactPhone || undefined;
 // 1. Paystack customer — reuse it if this e-mail already has one.
 let customer = null;
 try { customer = (await paystackAxios.get(`/customer/${encodeURIComponent(email)}`)).data?.data || null; }
 catch (e) { if (e.response?.status !== 404) throw e; }
 if (!customer) customer = (await paystackAxios.post('/customer', { email, first_name, last_name, phone })).data?.data || null;
 if (!customer?.customer_code) throw new Error('Paystack did not return a customer');
 // 2. Dedicated account — reuse it if this customer already has one.
 let da = customer.dedicated_account && customer.dedicated_account.account_number ? customer.dedicated_account : null;
 if (!da) {
  const r = await paystackAxios.post('/dedicated_account', {
   customer: customer.customer_code,
   preferred_bank: process.env.PAYSTACK_DVA_BANK || 'wema-bank',
   first_name, last_name, phone
  }, { timeout: 25000 });
  da = r.data?.data || null;
 }
 const accountNumber = (da && da.account_number) || '';
 user.paystackVirtualAccount = {
  enabled: !!accountNumber,
  accountNumber,
  bankName: (da && da.bank && da.bank.name) || '',
  accountName: (da && da.account_name) || '',
  customerCode: customer.customer_code,
  customerId: String(customer.id || ''),
  dedicatedAccountId: String((da && da.id) || ''),
  createdAt: new Date()
 };
 await user.save();
 if (!accountNumber) return { message: 'Your account is being set up — it will appear here in a moment.', pending: true, virtualAccount: user.paystackVirtualAccount };
 return { message: ' Virtual account created', virtualAccount: user.paystackVirtualAccount };
}
// Paystack tells us (webhook) when an account that was still being assigned is ready.
async function applyPaystackDvaAssigned(data) {
 const code = data?.customer?.customer_code;
 const da = data?.dedicated_account || {};
 if (!code || !da.account_number) return false;
 let user = await User.findOne({ 'paystackVirtualAccount.customerCode': code });
 if (!user && data.customer.email) user = await User.findOne({ email: String(data.customer.email).trim().toLowerCase() });
 if (!user) return false;
 await User.updateOne({ _id: user._id }, { $set: {
  'paystackVirtualAccount.enabled': true,
  'paystackVirtualAccount.accountNumber': String(da.account_number),
  'paystackVirtualAccount.bankName': (da.bank && da.bank.name) || '',
  'paystackVirtualAccount.accountName': da.account_name || '',
  'paystackVirtualAccount.customerCode': code,
  'paystackVirtualAccount.dedicatedAccountId': String(da.id || ''),
  'paystackVirtualAccount.createdAt': user.paystackVirtualAccount?.createdAt || new Date()
 } });
 return true;
}
// Credits one Paystack virtual-account transfer to the wallet. `tx` MUST come straight from Paystack's
// API (verify or list) — callers never pass an unverified webhook body. Safe to call repeatedly:
// the unique wallet-transaction reference means money can only ever move once.
async function handlePaystackVaCredit(user, tx) {
 if (!tx || !tx.reference) return { status: 'skipped' };
 const key = 'PSK-' + String(tx.reference);
 if (String(tx.status || '').toLowerCase() !== 'success' || String(tx.currency || '').toUpperCase() !== 'NGN') return { status: 'rejected' };
 const receivedAmount = Number(tx.amount || 0) / 100; // kobo → naira
 if (receivedAmount <= 0) return { status: 'skipped' };
 const fee = calcDepositFee(receivedAmount);
 const creditAmount = receivedAmount - fee;
 if (creditAmount <= 0) return { status: 'skipped' };
 const acct = user.paystackVirtualAccount?.accountNumber || '';
 let claim;
 try {
  claim = await VirtualAccountDeposit.findOneAndUpdate(
   { flwRef: key },
   { $setOnInsert: { userId: user._id, flwRef: key, flwTxId: String(tx.id || ''), gateway: 'paystack', amount: receivedAmount, creditAmount, accountNumber: acct, status: 'pending', rawPayload: tx, createdAt: new Date() } },
   { upsert: true, new: true }
  );
 } catch (e) {
  if (e && e.code === 11000) claim = await VirtualAccountDeposit.findOne({ flwRef: key });
  else throw e;
 }
 if (!claim) return { status: 'skipped' };
 if (claim.status === 'success') return { status: 'duplicate' };
 try {
  await Transaction.create({
   userId: user._id, type: 'deposit', amount: creditAmount, txRef: key,
   description: `VA deposit — ₦${creditAmount.toLocaleString('en-NG')} credited (₦${receivedAmount.toLocaleString('en-NG')} received, ₦${fee} fee) via ${user.paystackVirtualAccount?.bankName || 'Paystack bank transfer'}`,
   status: 'success'
  });
 } catch (e) {
  if (e && e.code === 11000) {
   await VirtualAccountDeposit.updateOne({ _id: claim._id }, { $set: { status: 'success' } }).catch(() => {});
   return { status: 'duplicate' };
  }
  throw e;
 }
 const updated = await User.findByIdAndUpdate(user._id, { $inc: { balance: creditAmount } }, { new: true }).select('balance');
 await VirtualAccountDeposit.updateOne({ _id: claim._id }, { $set: { status: 'success' } });
 if (updated) {
  pushBalanceToUser(user._id, updated.balance, creditAmount);
  const msg = `event: va_deposit\ndata: ${JSON.stringify({ creditAmount, receivedAmount, fee, balance: updated.balance, bank: user.paystackVirtualAccount?.bankName || 'bank transfer', flwRef: key, ts: Date.now() })}\n\n`;
  const clients = sseClients.get(String(user._id));
  if (clients && clients.size) { for (const r of clients) { try { r.write(msg); } catch { clients.delete(r); } } }
 }
 console.log(` RSH Paystack VA credited: ₦${creditAmount} to ${user.email} (received ₦${receivedAmount}, fee ₦${fee}) | key:${key}`);
 return { status: 'credited', creditAmount };
}
// Safety net for a missed webhook: look at the last 24h of successful Paystack charges.
let _psVaReconcileRunning = false;
async function reconcilePaystackVADeposits() {
 if (_psVaReconcileRunning || !process.env.PAYSTACK_SECRET_KEY) return;
 _psVaReconcileRunning = true;
 try {
  if (!(await User.exists({ 'paystackVirtualAccount.accountNumber': { $exists: true, $ne: '' } }))) return;
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (let page = 1; page <= 3; page++) {
   const r = await paystackAxios.get('/transaction', { params: { status: 'success', perPage: 100, page, from }, timeout: 15000 });
   const list = r.data?.data || [];
   if (!list.length) break;
   for (const tx of list) {
    if (!isPaystackDvaTx(tx) || !tx.reference) continue;
    try {
     if (await VirtualAccountDeposit.findOne({ flwRef: 'PSK-' + tx.reference, status: 'success' }).select('_id')) continue;
     const user = await findUserForPaystackVa(tx);
     if (user) await handlePaystackVaCredit(user, tx);
    } catch (e) { console.warn('[PS-VA-reconcile] credit error:', e.message); }
   }
   if (list.length < 100) break;
  }
 } catch (e) {
  console.warn('[PS-VA-reconcile] error:', e.response?.data?.message || e.message);
 } finally { _psVaReconcileRunning = false; }
}
app.get('/api/user/virtual-account', auth, async (req, res) => {
 try {
 const user = await User.findById(req.user._id).select('virtualAccount paystackVirtualAccount name balance country contactPhone');
 const settings = await getVASettings();
 const vaGw = req.query.gateway === 'paystack' ? 'paystack' : 'flutterwave';
 const vaStates = await getGatewayStates();
 const va = (vaGw === 'paystack' ? user.paystackVirtualAccount : user.virtualAccount) || {};
 const gwOn = vaGw === 'paystack' ? vaStates.paystack.available : vaStates.flutterwave.enabled;
 // Nigeria-only rail. The country comes from the profile first and from the
 // caller's IP when the profile has none, so accounts created before the
 // country field existed are handled correctly too. Any non-Nigerian user —
 // including one who already has an account number from an earlier release —
 // gets nothing back and the deposit page hides the card entirely.
 const geoRes = await resolveVACountry(req, user);
 console.log(`[RSH] VA check for ${user.email || user._id}: country=${geoRes.code} (${geoRes.source}) globalEnabled=${settings.globalEnabled} hasAccount=${!!va.accountNumber}`);
 if (geoRes.code !== 'NG') {
 return res.json({
 enabled: false,
 available: false,
 reason: 'country',
 country: geoRes.code,
 message: 'Virtual accounts are available to customers in Nigeria only. Use the payment link — it is priced in US dollars for your country.',
 balance: user.balance || 0,
 globalEnabled: settings.globalEnabled
 });
 }
 res.json({
 available: true,
 enabled: !!(va.enabled && va.accountNumber),
 accountNumber: va.accountNumber || '',
 bankName: va.bankName || 'Wema Bank',
 accountName: va.accountName || user.name || '',
 userName: user.name || '',
 balance: user.balance || 0,
 createdAt: va.createdAt || null,
 globalEnabled: settings.globalEnabled && gwOn,
 gateway: vaGw,
 pending: !!(va.customerCode && !va.accountNumber)
 });
 } catch (e) {
 // A failure here must never be mistaken for "maintenance". Report the error
 // but keep available/globalEnabled true so the page shows the Generate card.
 console.error('[RSH] /api/user/virtual-account failed:', e.message);
 res.status(200).json({ available: true, enabled: false, globalEnabled: true, error: e.message, balance: req.user?.balance || 0 });
 }
});
app.post('/api/user/virtual-account/create', auth, async (req, res) => {
 try {
 const settings = await getVASettings();
 if (!settings.globalEnabled) return res.status(503).json({ error: 'Virtual accounts are temporarily disabled — please try again later or use another deposit method.' });
 const vaGw = String(req.body?.gateway || 'flutterwave').toLowerCase() === 'paystack' ? 'paystack' : 'flutterwave';
 const vaStates = await getGatewayStates();
 if (vaGw === 'paystack' ? !vaStates.paystack.available : !vaStates.flutterwave.enabled) return res.status(503).json({ error: (vaStates[vaGw].disabledMessage) || 'Bank transfer is temporarily unavailable — please use the payment link instead.' });
 const user = await User.findById(req.user._id);
 if (!user) return res.status(404).json({ error: 'User not found' });
 if (!user.contactPhone) {
 return res.status(428).json({ error: 'Please add your phone number and country before creating a virtual account.', needsPhone: true });
 }
 const resolved = await resolveVACountry(req, user);
 console.log(`[RSH] VA create requested by ${user.email}: country=${resolved.code} (${resolved.source})`);
 if (resolved.code !== 'NG') {
 return res.status(403).json({
 error: 'Virtual accounts are available to customers in Nigeria only. Use the payment link — it is priced in US dollars for your country.',
 methods: ['paymentlink'],
 });
 }
 const result = (String(req.body?.gateway || '').toLowerCase() === 'paystack') ? await createPaystackVirtualAccountForUser(user) : await createVirtualAccountForUser(user);
 res.json(result);
 } catch (e) {
 const msg = e.response?.data?.message || e.message;
 console.error('Self-serve VA create error:', msg);
 res.status(e.status || 500).json({ error: msg });
 }
});
app.post('/api/admin/virtual-accounts/create/:userId', adminAuth, async (req, res) => {
 try {
 const user = await User.findById(req.params.userId);
 if (!user) return res.status(404).json({ error: 'User not found' });
 const result = (String(req.body?.gateway || '').toLowerCase() === 'paystack') ? await createPaystackVirtualAccountForUser(user) : await createVirtualAccountForUser(user);
 res.json(result);
 } catch (e) {
 const msg = e.response?.data?.message || e.message;
 console.error('VA create error:', msg);
 res.status(e.status || 500).json({ error: msg });
 }
});
app.put('/api/admin/virtual-accounts/toggle/:userId', adminAuth, async (req, res) => {
 try {
 const user = await User.findById(req.params.userId);
 if (!user) return res.status(404).json({ error: 'User not found' });
 if (!user.virtualAccount?.accountNumber) return res.status(400).json({ error: 'User has no virtual account yet. Create one first.' });
 user.virtualAccount.enabled = !user.virtualAccount.enabled;
 await user.save();
 res.json({ message: `Virtual account ${user.virtualAccount.enabled ? 'enabled' : 'disabled'}`, enabled: user.virtualAccount.enabled });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/virtual-accounts/:userId', adminAuth, async (req, res) => {
 try {
 const user = await User.findById(req.params.userId);
 if (!user) return res.status(404).json({ error: 'User not found' });
 user.virtualAccount = { enabled: false, accountNumber: '', bankName: '', accountName: '', flwRef: '' };
 await user.save();
 res.json({ message: 'Virtual account removed from this user' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/virtual-accounts/deposits', adminAuth, async (req, res) => {
 try {
 const deposits = await VirtualAccountDeposit.find()
 .sort({ createdAt: -1 }).limit(200)
 .populate('userId', 'name email');
 res.json(deposits);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
const paymentLinkDepositSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 txRef: { type: String, required: true, unique: true },
 amount: { type: Number, required: true }, // what Flutterwave actually charges the user
 // The charge currency. Nigeria is billed in NGN; every other country is
 // billed in USD, so verification must compare against THIS, not a hardcoded
 // 'NGN' — otherwise a legitimate dollar payment never gets credited.
 currency: { type: String, default: 'NGN' },
 creditAmount: { type: Number, required: true }, // what gets added to the wallet (amount - fee)
 fee: { type: Number, default: 0 },
 status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
 flwTransactionId: { type: String, default: '' },
 gateway: { type: String, enum: ['flutterwave', 'paystack', 'korapay'], default: 'flutterwave' }, // which provider took this payment (old rows = flutterwave)
 gatewayTxId: { type: String, default: '' }, // Paystack's own transaction id
 rawPayload: { type: mongoose.Schema.Types.Mixed },
 creditedAt: { type: Date },
 // Reversal tracking — prevents double-deduction if a failed deposit webhook fires twice
 reversed: { type: Boolean, default: false },
 reversedAt: { type: Date, default: null },
 reversalReason: { type: String, default: '' },
 createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 }
});
const PaymentLinkDeposit = mongoose.model('PaymentLinkDeposit', paymentLinkDepositSchema);
function calcDepositFee(creditAmount) {
 if (creditAmount >= 100 && creditAmount <= 499) return 10;
 if (creditAmount >= 500 && creditAmount <= 999) return 20;
 if (creditAmount >= 1000 && creditAmount <= 9999) return 50;
 if (creditAmount >= 10000 && creditAmount <= 99999) return 100;
 if (creditAmount >= 100000) return 100; // capped flat for very large deposits
 return 0;
}
function calcChargeAmount(creditAmount) {
 return creditAmount + calcDepositFee(creditAmount);
}
// ═══ PAYSTACK HELPERS ═══════════════════════════════════════════════════════
const paystackAxios = axios.create({ baseURL: 'https://api.paystack.co', timeout: 15000 });
paystackAxios.interceptors.request.use(config => {
 config.headers = { ...config.headers, Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
 return config;
});
// Paystack can only settle currencies that are switched on for the merchant account.
// NGN always works. USD must be enabled in the Paystack dashboard AND PAYSTACK_ALLOW_USD=true set here.
function paystackSupportsCurrency(cur) {
 const c = String(cur || '').toUpperCase();
 return c === 'NGN' || (c === 'USD' && String(process.env.PAYSTACK_ALLOW_USD || '').toLowerCase() === 'true');
}
// Returns Paystack's transaction object, or null when the reference does not exist (yet).
async function paystackVerify(reference) {
 try {
  const r = await paystackAxios.get(`/transaction/verify/${encodeURIComponent(reference)}`, { timeout: 15000 });
  return r.data?.data || null;
 } catch (e) {
  const msg = String(e.response?.data?.message || '');
  if (e.response?.status === 404 || /not found/i.test(msg)) return null;
  throw e;
 }
}
// Paystack amounts are in the currency's subunit (kobo / cents). Never credit less than was asked for.
function paystackTxOk(tx, deposit) {
 if (!tx) return false;
 return String(tx.status || '').toLowerCase() === 'success'
  && String(tx.currency || '').toUpperCase() === String(deposit.currency || 'NGN').toUpperCase()
  && Number(tx.amount) >= Math.round(Number(deposit.amount) * 100)
  && String(tx.reference || '') === String(deposit.txRef);
}
// ── KUROPAY (Korapay) gateway (lib/korapay.js) — adds its own webhook + callback routes ──
const rshKorapay = require('./lib/korapay')({
 app, axios, crypto, PaymentLinkDeposit, creditPaymentLinkDeposit, getPlatform: () => rshPlatform
});
app.post('/api/deposit/paymentlink/create', auth, async (req, res) => {
 let gateway = '';
 try {
 const gwStates = await getGatewayStates();
 if (!gwStates.flutterwave.configured && !gwStates.paystack.configured && !gwStates.korapay.configured) {
  return res.status(503).json({ error: 'Payments are not configured yet — contact support.' });
 }
 if (!gwStates.flutterwave.available && !gwStates.paystack.available && !gwStates.korapay.available) {
  return res.status(503).json({ error: gwStates.flutterwave.disabledMessage || gwStates.paystack.disabledMessage || gwStates.korapay.disabledMessage || 'Deposits are temporarily unavailable — please try again later.' });
 }
 const methodSetting = await PaymentMethodSetting.findOne({ method: 'paymentlink' });
 if (methodSetting && methodSetting.enabled === false) {
 return res.status(503).json({ error: methodSetting.disabledMessage || 'Payment Link deposits are temporarily unavailable — please try again later.' });
 }
 const { amount, method } = req.body;
 const user = await User.findById(req.user._id);
 if (!user) return res.status(404).json({ error: 'User not found' });
 // Nigerians pay in naira; everyone else pays in US dollars. The wallet ledger
 // stays in NGN either way, so a dollar charge is converted at the live rate.
 // The country is resolved from the profile first and the request second, so a
 // missing profile country can never accidentally price a foreign user in ₦.
 const plGeo = await rshGeo.resolveCountry(req, user);
 const payCurrency = rshCountries.payCurrencyFor(plGeo.code);
 const parsedAmount = parseFloat(amount);
 let creditNgn, chargeAmount, chargeCurrency, fee;
 if (payCurrency === 'USD') {
 if (!parsedAmount || parsedAmount < 1) return res.status(400).json({ error: 'Minimum deposit is $1' });
 let ngn;
 try { ngn = Math.floor(await rshFx.ngnCreditForPayment(parsedAmount, 'USD')); }
 catch (convErr) {
 if (rshPlatform) await rshPlatform.logConversionError('USD→NGN quote failed while creating a payment link', convErr.message, { userId: String(user._id) });
 return res.status(503).json({ error: 'Exchange rates are temporarily unavailable — please try again in a moment.' });
 }
 // Foreign deposits carry the same service charge as naira deposits, and it is
 // ADDED to what the customer pays instead of shaved off the wallet credit, so
 // "deposit $10" always lands the full dollar value in the wallet.
 fee = calcDepositFee(ngn);
 const ngnPerUsd = ngn / parsedAmount; // effective rate for this quote
 const feeUsd = Math.ceil((fee / ngnPerUsd) * 100) / 100;
 creditNgn = ngn;
 chargeAmount = Math.round((parsedAmount + feeUsd) * 100) / 100;
 chargeCurrency = 'USD';
 } else {
 if (!parsedAmount || parsedAmount < 100) return res.status(400).json({ error: 'Minimum deposit is ₦100' });
 fee = calcDepositFee(parsedAmount);
 creditNgn = parsedAmount;
 chargeAmount = parsedAmount + fee;
 chargeCurrency = 'NGN';
 }
 // ── Which gateway takes this payment? ──────────────────────────────────────
 // The customer's pick wins when it is available; otherwise Flutterwave, then Paystack.
 const requested = String(req.body.gateway || '').trim().toLowerCase();
 if (requested && !GATEWAY_LIST.includes(requested)) return res.status(400).json({ error: 'Unknown payment gateway' });
 const gwOk = {
  flutterwave: gwStates.flutterwave.available,
  paystack: gwStates.paystack.available && paystackSupportsCurrency(chargeCurrency),
  korapay: gwStates.korapay.available && rshKorapay.supportsCurrency(chargeCurrency)
 };
 gateway = requested || (gwOk.flutterwave ? 'flutterwave' : (gwOk.paystack ? 'paystack' : (gwOk.korapay ? 'korapay' : '')));
 if (!gateway || !gwOk[gateway]) {
  const which = gateway || 'flutterwave';
  return res.status(503).json({ error: gwStates[which].disabledMessage || `${GATEWAY_LABELS[which]} is currently unavailable for your country or currency — please choose another payment option.` });
 }
 let txRef = `${BRAND.txPrefix}-PL-${user._id}-${Date.now()}`;
 const siteUrl = process.env.SITE_URL || '';
 let link, paymentOptions = null;
 if (gateway === 'korapay') {
  // Korapay references: letters, numbers, - _ only
  txRef = txRef.replace(/[^A-Za-z0-9_-]/g, '-');
  const kp = await rshKorapay.createCheckout({
   amount: chargeAmount, currency: chargeCurrency, reference: txRef,
   customerName: user.name || `${BRAND.name} Customer`, customerEmail: user.email,
   redirectUrl: `${siteUrl}/api/deposit/korapay/callback`,
   notificationUrl: `${siteUrl}/api/webhooks/korapay`
  });
  link = kp.link;
 } else if (gateway === 'paystack') {
  // Paystack references may only contain letters, numbers and - . =
  txRef = txRef.replace(/[^A-Za-z0-9.=-]/g, '-');
  const psRes = await paystackAxios.post('/transaction/initialize', {
   email: user.email, // auto-filled from the logged-in account — never typed by the user
   amount: Math.round(chargeAmount * 100), // kobo / cents
   currency: chargeCurrency,
   reference: txRef,
   callback_url: `${siteUrl}/api/deposit/paystack/callback`,
   metadata: {
    userId: String(user._id), purpose: 'wallet_deposit', creditNgn,
    cancel_action: `${siteUrl}/deposit?deposit=cancelled`
   }
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
  link = psRes.data?.data?.authorization_url;
  if (!psRes.data?.status || !link) throw new Error(psRes.data?.message || 'Paystack did not return a payment link');
 } else {
  // Only the rails Flutterwave has actually approved for this market are
  // offered — a customer never sees a method that will fail at checkout.
  paymentOptions = rshFlwMethods.paymentOptionsFor(plGeo.code, chargeCurrency);
  const payload = {
   tx_ref: txRef,
   amount: chargeAmount,
   currency: chargeCurrency,
   redirect_url: `${siteUrl}/api/deposit/paymentlink/callback`,
   payment_options: paymentOptions,
   customer: {
    email: user.email, // auto-filled from the logged-in account — never typed by the user
    name: user.name || `${BRAND.name} Customer`
   },
   customizations: { title: `${BRAND.name} Wallet Deposit`, description: `Deposit for ${user.name}` }
  };
  const flwRes = await flwAxios.post(`/payments`, payload, {
   headers: { 'Content-Type': 'application/json' },
   timeout: 15000
  });
  link = flwRes.data?.data?.link;
  if (!link) throw new Error('Flutterwave did not return a payment link');
 }
 await PaymentLinkDeposit.create({ userId: user._id, txRef, amount: chargeAmount, currency: chargeCurrency, creditAmount: creditNgn, fee, status: 'pending', gateway });
 res.json({ link, txRef, gateway, currency: chargeCurrency, charged: chargeAmount, creditNgn, country: plGeo.code, paymentOptions });
 } catch (e) {
 console.error('Payment link create error:', JSON.stringify(e.response?.data || e.message, null, 2));
 try {
 await SystemError.create({
 source: gateway || 'flutterwave',
 message: 'Failed to create payment link for deposit',
 detail: JSON.stringify(e.response?.data || e.message),
 context: { userId: req.user?._id, attemptedAmount: req.body?.amount, gateway }
 });
 } catch {}
 res.status(502).json({
 error: 'Our payment provider is temporarily unavailable. Your funds are safe — nothing was charged. Please try again shortly, or contact support if this keeps happening.'
 });
 }
});
app.get('/api/deposit/paymentlink/callback', async (req, res) => {
 const siteUrl = process.env.SITE_URL || '';
 const failRedirect = `${siteUrl}/deposit?deposit=failed`;
 const pendingRedirect = (txRef) => `${siteUrl}/deposit?deposit=pending&txRef=${encodeURIComponent(txRef)}`;
 try {
 const { status, tx_ref, transaction_id } = req.query;
 if (!tx_ref) return res.redirect(failRedirect);
 const deposit = await PaymentLinkDeposit.findOne({ txRef: tx_ref });
 if (!deposit) return res.redirect(failRedirect);
 if (deposit.status === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
 if (status === 'cancelled' || status === 'failed') {
 console.warn(`Browser callback reported ${status} for ${tx_ref} — leaving deposit open for the webhook / verification`);
 return res.redirect(`${siteUrl}/deposit?deposit=cancelled`);
 }
 if (!process.env.FLW_V3_SECRET_KEY) return res.redirect(failRedirect);
 if (transaction_id) {
 try {
 const verify = await flwAxios.get(`/transactions/${transaction_id}/verify`, { timeout: 15000 });
 const tx = verify.data?.data;
 const ok = tx && String(tx.status || '').trim().toLowerCase() === 'successful'
 && String(tx.currency || '').trim().toUpperCase() === String(deposit.currency || 'NGN').toUpperCase()
 && Number(tx.amount) >= Number(deposit.amount) * 0.98 && tx.tx_ref === deposit.txRef;
 if (ok) { await creditPaymentLinkDeposit(deposit, tx); return res.redirect(`${siteUrl}/deposit?deposit=success`); }
 } catch (e) { console.error('Callback verify-by-id error:', e.response?.data || e.message); }
 }
 try {
 const verify = await flwAxios.get(`/transactions/verify_by_reference`, {
 params: { tx_ref: deposit.txRef }, timeout: 15000
 });
 const tx = verify.data?.data;
 if (tx && String(tx.status || '').trim().toLowerCase() === 'successful' && String(tx.currency || '').trim().toUpperCase() === String(deposit.currency || 'NGN').toUpperCase() && Number(tx.amount) >= Number(deposit.amount) * 0.98) {
 await creditPaymentLinkDeposit(deposit, tx);
 return res.redirect(`${siteUrl}/deposit?deposit=success`);
 }
 return res.redirect(pendingRedirect(tx_ref));
 } catch (e) {
 console.error('Callback verify-by-ref error:', e.response?.data || e.message);
 return res.redirect(pendingRedirect(tx_ref));
 }
 } catch (e) {
 console.error('Payment link callback error:', e.response?.data || e.message);
 res.redirect(failRedirect);
 }
});
// ── Paystack: browser comes back here after paying ───────────────────────────
app.get('/api/deposit/paystack/callback', async (req, res) => {
 const siteUrl = process.env.SITE_URL || '';
 const failRedirect = `${siteUrl}/deposit?deposit=failed`;
 const pendingRedirect = (ref) => `${siteUrl}/deposit?deposit=pending&txRef=${encodeURIComponent(ref)}`;
 try {
  const reference = String(req.query.reference || req.query.trxref || '');
  if (!reference) return res.redirect(failRedirect);
  const deposit = await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'paystack' });
  if (!deposit) return res.redirect(failRedirect);
  if (deposit.status === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
  if (!process.env.PAYSTACK_SECRET_KEY) return res.redirect(failRedirect);
  try {
   const tx = await paystackVerify(reference);
   if (paystackTxOk(tx, deposit)) {
    await creditPaymentLinkDeposit(deposit, tx);
    return res.redirect(`${siteUrl}/deposit?deposit=success`);
   }
   const st = String(tx?.status || '').toLowerCase();
   if (st === 'failed' || st === 'reversed') {
    await PaymentLinkDeposit.updateOne({ _id: deposit._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
    return res.redirect(failRedirect);
   }
   if (st === 'abandoned') return res.redirect(`${siteUrl}/deposit?deposit=cancelled`);
   return res.redirect(pendingRedirect(reference));
  } catch (e) {
   console.error('Paystack callback verify error:', e.response?.data || e.message);
   return res.redirect(pendingRedirect(reference));
  }
 } catch (e) {
  console.error('Paystack callback error:', e.message);
  res.redirect(failRedirect);
 }
});
// ── Paystack webhook (set https://YOUR-SITE/api/webhooks/paystack in the Paystack dashboard) ──
// Always processed — even when the Paystack switch is OFF — because the customer has already paid.
app.post('/api/webhooks/paystack', async (req, res) => {
 const secret = process.env.PAYSTACK_SECRET_KEY || '';
 const received = String(req.headers['x-paystack-signature'] || '');
 const event = req.body || {};
 const data = event.data || {};
 const reference = String(data.reference || '');
 const log = async (status, message) => {
  try {
   if (rshPlatform) await rshPlatform.logWebhook({
    provider: 'paystack', channel: 'paymentlink', event: event.event || 'unknown', reference,
    txId: data.id, amount: Number(data.amount || 0) / 100, currency: data.currency, status, message, payload: event
   });
  } catch { /* logging never breaks a credit */ }
 };
 if (!secret || !req.rawBody) {
  await log('signature_rejected', !secret ? 'PAYSTACK_SECRET_KEY is not set' : 'raw body unavailable');
  return res.status(401).json({ error: 'Webhook not configured' });
 }
 const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
 let valid = false;
 try {
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(received, 'utf8');
  valid = a.length === b.length && crypto.timingSafeEqual(a, b);
 } catch { valid = false; }
 if (!valid) {
  console.error('Paystack webhook REJECTED: bad x-paystack-signature');
  await log('signature_rejected', 'x-paystack-signature mismatch');
  return res.status(401).json({ error: 'Invalid webhook signature' });
 }
 try {
  if (event.event === 'dedicatedaccount.assign.success') {
   const ok = await applyPaystackDvaAssigned(data);
   await log(ok ? 'processed' : 'ignored', ok ? 'virtual account assigned' : 'no matching customer for assigned account');
   return res.json({ received: true });
  }
  if (event.event === 'dedicatedaccount.assign.failed') {
   await log('failed', 'Paystack could not assign a dedicated account');
   return res.json({ received: true });
  }
  if (event.event !== 'charge.success') {
   await log('ignored', `event ${event.event || 'unknown'} is not handled`);
   return res.json({ received: true });
  }
  const deposit = reference ? await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'paystack' }) : null;
  if (!deposit && isPaystackDvaTx(data)) {
   // A bank transfer into a customer's dedicated virtual account.
   const vtx = await paystackVerify(reference);
   if (!vtx || String(vtx.status || '').toLowerCase() !== 'success') {
    await log('failed', `virtual account verification failed: status=${vtx?.status || 'not found'}`);
    return res.json({ received: true });
   }
   const owner = await findUserForPaystackVa(vtx, data);
   if (!owner) { await log('failed', 'virtual account transfer matches no user'); return res.json({ received: true }); }
   const out = await handlePaystackVaCredit(owner, vtx);
   await log(out.status === 'credited' ? 'processed' : 'ignored', `virtual account ${out.status}${out.creditAmount ? ' ₦' + out.creditAmount : ''}`);
   return res.json({ received: true });
  }
  if (!deposit) { await log('ignored', 'no wallet deposit matches this reference'); return res.json({ received: true }); }
  if (deposit.status === 'success') { await log('ignored', 'already credited'); return res.json({ received: true }); }
  // Never trust the webhook body alone — confirm with Paystack's API before crediting.
  const tx = await paystackVerify(reference);
  if (!paystackTxOk(tx, deposit)) {
   await log('failed', `verification failed: status=${tx?.status || 'not found'} amount=${tx?.amount} currency=${tx?.currency}`);
   return res.json({ received: true });
  }
  await creditPaymentLinkDeposit(deposit, tx);
  await log('processed', `credited ₦${deposit.creditAmount} for ${reference}`);
  return res.json({ received: true });
 } catch (e) {
  console.error('Paystack webhook error:', e.response?.data || e.message);
  await log('failed', e.message);
  return res.status(500).json({ error: 'Processing error' }); // non-2xx → Paystack retries
 }
});
async function creditPaymentLinkDeposit(deposit, tx) {
  const fresh = await PaymentLinkDeposit.findOneAndUpdate(
    { _id: deposit._id, status: 'pending' },
    { status: 'success', ...((deposit.gateway === 'paystack' || deposit.gateway === 'korapay') ? { gatewayTxId: String(tx.id || '') } : { flwTransactionId: String(tx.id || '') }), creditedAt: new Date(), rawPayload: tx },
    { new: true }
  );
  if (!fresh) return; // Already credited or failed — never double-credit
  // Use atomic $inc so a concurrent deposit/purchase never causes a race condition
  const updated = await User.findByIdAndUpdate(
    fresh.userId,
    { $inc: { balance: fresh.creditAmount ?? fresh.amount } },
    { new: true }
  ).select('balance name email');
  if (!updated) return;
  const creditAmount = fresh.creditAmount ?? fresh.amount;
  await Transaction.create({
    userId: updated._id, type: 'deposit', amount: creditAmount,
    txRef: deposit.txRef,
    description: deposit.gateway === 'korapay' ? `Deposit via Kuropay (${tx.channel || 'unknown method'})` : deposit.gateway === 'paystack' ? `Deposit via Paystack (${tx.channel || 'unknown method'})` : `Deposit via Flutterwave payment link (${tx.payment_type || 'unknown method'})`,
    status: 'success'
  });
  pushBalanceToUser(updated._id, updated.balance, creditAmount);
  console.log(`✅ Payment link deposit credited: ₦${creditAmount} (charged ₦${fresh.amount}) for ${updated.name}`);
}

// ── Admin: Reverse a failed deposit ──────────────────────────────────────────
// Called manually by admin if a credited deposit later bounces/reverses.
// Uses the reversed:false guard to ensure exactly-once deduction.
app.post('/api/admin/deposit/reverse', adminAuth, async (req, res) => {
  try {
    const { txRef, reason } = req.body;
    if (!txRef) return res.status(400).json({ error: 'txRef required' });

    // Find by PaymentLinkDeposit first
    let deposit = await PaymentLinkDeposit.findOne({ txRef });
    if (!deposit) {
      // Try bank transfer deposits
      const BankTransferDeposit = mongoose.models.BankTransferDeposit;
      if (BankTransferDeposit) deposit = await BankTransferDeposit.findOne({ reference: txRef });
    }
    if (!deposit) return res.status(404).json({ error: 'Deposit not found by txRef/reference' });
    if (deposit.status !== 'success') return res.status(400).json({ error: 'Deposit was never successfully credited — nothing to reverse' });
    if (deposit.reversed) return res.status(400).json({ error: `Already reversed on ${deposit.reversedAt?.toLocaleString('en-NG')} — will not deduct again` });

    const creditAmount = deposit.creditAmount ?? deposit.amount ?? 0;

    // Atomic mark-as-reversed FIRST — if this fails (already reversed), we stop before touching balance
    const marked = await deposit.constructor.findOneAndUpdate(
      { _id: deposit._id, reversed: false },
      { reversed: true, reversedAt: new Date(), reversalReason: reason || 'Admin reversal' },
      { new: true }
    );
    if (!marked) return res.status(409).json({ error: 'Concurrent reversal detected — deposit was already reversed' });

    // Now deduct — balance can go negative (same as admin deduct)
    const user = await User.findByIdAndUpdate(
      deposit.userId,
      { $inc: { balance: -creditAmount } },
      { new: true }
    ).select('balance name email');
    if (!user) return res.status(404).json({ error: 'User not found — manual balance fix needed' });

    await Transaction.create({
      userId: user._id, type: 'admin_debit', amount: creditAmount,
      description: `Deposit reversal: ${txRef} — ${reason || 'failed transaction reversed'}`,
      status: 'success'
    });
    pushBalanceToUser(user._id, user.balance);
    console.log(`[RSH] Deposit reversed: ₦${creditAmount} from ${user.email} (txRef:${txRef}) — new balance ₦${user.balance}`);
    res.json({
      success: true,
      message: `✅ Reversed ₦${creditAmount.toLocaleString('en-NG')} from ${user.name}'s wallet`,
      newBalance: user.balance,
      userName: user.name, userEmail: user.email,
      note: user.balance < 0 ? `⚠️ Balance is now negative (₦${user.balance.toLocaleString('en-NG')}) — user spent the money before reversal` : null
    });
  } catch (e) {
    console.error('[deposit-reverse]', e.message);
    res.status(500).json({ error: 'Reversal failed: ' + e.message });
  }
});
app.get('/api/deposit/paymentlink/status/:txRef', auth, async (req, res) => {
 try {
 const deposit = await PaymentLinkDeposit.findOne({ txRef: req.params.txRef, userId: req.user._id });
 if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
 if (deposit.status !== 'pending') return res.json({ status: deposit.status, creditAmount: deposit.creditAmount });
 if (deposit.gateway === 'korapay') {
 try { const r = await rshKorapay.checkAndCredit(deposit); return res.json({ status: r, creditAmount: deposit.creditAmount }); }
 catch (pollErr) { console.error('Kuropay status poll error:', pollErr.response?.data || pollErr.message); return res.json({ status: 'pending' }); }
 }
 if (deposit.gateway === 'paystack') {
 if (process.env.PAYSTACK_SECRET_KEY) {
 try {
 const tx = await paystackVerify(deposit.txRef);
 if (paystackTxOk(tx, deposit)) {
 await creditPaymentLinkDeposit(deposit, tx);
 return res.json({ status: 'success', creditAmount: deposit.creditAmount });
 }
 const st = String(tx?.status || '').toLowerCase();
 if (st === 'failed' || st === 'reversed') {
 await PaymentLinkDeposit.updateOne({ _id: deposit._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
 return res.json({ status: 'failed' });
 }
 } catch (pollErr) {
 console.error('Paystack status poll error:', pollErr.response?.data || pollErr.message);
 }
 }
 return res.json({ status: 'pending' });
 }
 if (process.env.FLW_V3_SECRET_KEY) {
 try {
 const verify = await flwAxios.get(`/transactions/verify_by_reference`, {
 params: { tx_ref: deposit.txRef }, timeout: 12000
 });
 const tx = verify.data?.data;
 if (tx && tx.status === 'successful' && tx.currency === (deposit.currency || 'NGN') && tx.amount >= deposit.amount) {
 await creditPaymentLinkDeposit(deposit, tx);
 return res.json({ status: 'success', creditAmount: deposit.creditAmount });
 }
 if (tx && (tx.status === 'failed' || tx.status === 'cancelled')) {
   await PaymentLinkDeposit.updateOne({ _id: deposit._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
   return res.json({ status: 'failed' });
 }
 if (tx && tx.status === 'pending') return res.json({ status: 'pending' });
 } catch (pollErr) {
 console.error('Payment link status poll error:', pollErr.response?.data || pollErr.message);
 }
 }
 res.json({ status: 'pending' });
 } catch (e) {
 console.error('Status check error:', e.message);
 res.status(500).json({ error: 'Failed to check deposit status' });
 }
});
const bankTransferDepositSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 reference: { type: String, required: true, unique: true },
 virtualAccountId: { type: String, default: '' },
 accountNumber: { type: String, default: '' },
 bankName: { type: String, default: '' },
 amount: { type: Number, required: true }, // what Flutterwave actually charges (incl. fee)
 creditAmount: { type: Number, required: true }, // what gets added to the wallet
 fee: { type: Number, default: 0 },
 status: { type: String, enum: ['pending', 'success', 'failed', 'expired'], default: 'pending' },
 expiresAt: { type: Date },
 flwChargeId: { type: String, default: '' },
 createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 }
});
const BankTransferDeposit = mongoose.model('BankTransferDeposit', bankTransferDepositSchema);
const FLW_BANK_TRANSFER_BANK_CODE = process.env.FLW_BANK_TRANSFER_BANK_CODE || '035';
const flwV4Axios = axios.create({
 baseURL: FLW_API_BASE,
 timeout: 15000,
 httpsAgent: flwProxyAgent || undefined,
 proxy: false
});
flwV4Axios.interceptors.request.use(async config => {
 const token = await getFlwAccessToken();
 config.headers = { ...config.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
 return config;
});
async function getOrCreateFlwCustomer(user) {
 if (user.flwCustomerId) return user.flwCustomerId;
 const nameParts = (user.name || `${BRAND.name} Customer`).trim().split(/\s+/);
 const first = nameParts[0] || BRAND.name;
 const last = nameParts.slice(1).join(' ') || 'Customer';
 const r = await flwV4Axios.post('/customers', { name: { first, last }, email: user.email });
 const customerId = r.data?.data?.id;
 if (!customerId) throw new Error('Flutterwave did not return a customer id');
 user.flwCustomerId = customerId;
 await user.save();
 return customerId;
}
app.post('/api/deposit/banktransfer/create', auth, async (req, res) => {
 try {
 if (!(await getGatewayStates()).flutterwave.enabled) return res.status(503).json({ error: 'Bank transfer is temporarily unavailable — please use the payment link instead.' });
 if (!process.env.FLW_CLIENT_ID || !process.env.FLW_CLIENT_SECRET) {
 return res.status(503).json({ error: 'Bank transfer deposits are not configured yet — contact support.' });
 }
 const user = await User.findById(req.user._id);
 if (!user) return res.status(404).json({ error: 'User not found' });
 // ── NIGERIA-ONLY HARD GUARD ───────────────────────────────────────────────
 // A dynamic virtual account is an NGN bank account: only Nigeria is approved
 // on this Flutterwave account, so everyone else is sent to the payment link.
 const btGeo = await rshGeo.resolveCountry(req, user);
 if (!rshFlwMethods.supportsVirtualAccount(btGeo.code)) {
 return res.status(403).json({
 error: 'Bank transfer deposits are available to customers in Nigeria only. Use the payment link — it is priced in US dollars for your country.',
 country: btGeo.code,
 methods: ['paymentlink'],
 });
 }
 const { amount } = req.body;
 const parsedAmount = parseFloat(amount); // what the user wants CREDITED to their wallet
 if (!parsedAmount || parsedAmount < 100) return res.status(400).json({ error: 'Minimum deposit is ₦100' });
 const fee = calcDepositFee(parsedAmount);
 const chargeAmount = parsedAmount + fee; // what Flutterwave actually charges
 const customerId = await getOrCreateFlwCustomer(user);
 const reference = `${BRAND.txPrefix}-BT-${user._id}-${Date.now()}`;
 const expirySeconds = 1800; // 30 minutes
 const r = await flwV4Axios.post('/virtual-accounts', {
 reference, customer_id: customerId, expiry: expirySeconds,
 amount: chargeAmount, currency: 'NGN', account_type: 'dynamic',
 narration: `${BRAND.txPrefix} Wallet Deposit - ${user.name}`,
 bank_code: FLW_BANK_TRANSFER_BANK_CODE
 }, { headers: { 'X-Idempotency-Key': reference } });
 const d = r.data?.data;
 if (!d?.account_number) throw new Error('Flutterwave did not return account details');
 const expiresAt = new Date(Date.now() + expirySeconds * 1000);
 await BankTransferDeposit.create({
 userId: user._id, reference, virtualAccountId: d.id || '', accountNumber: d.account_number,
 bankName: d.account_bank_name || '', amount: chargeAmount, creditAmount: parsedAmount, fee,
 status: 'pending', expiresAt
 });
 res.json({
 reference, accountNumber: d.account_number, bankName: d.account_bank_name || '',
 amount: chargeAmount, creditAmount: parsedAmount, beneficiary: d.note || user.name,
 expiresAt
 });
 } catch (e) {
 console.error('Bank transfer create error:', e.response?.data || e.message);
 try {
 await SystemError.create({
 source: 'flutterwave',
 message: 'Failed to create bank transfer virtual account',
 detail: JSON.stringify(e.response?.data || e.message),
 context: { userId: req.user?._id, attemptedAmount: req.body?.amount }
 });
 } catch {}
 res.status(502).json({
 error: 'Our payment provider is temporarily unavailable. Your funds are safe — nothing was charged. Please try again shortly, or contact support if this keeps happening.'
 });
 }
});
app.get('/api/deposit/banktransfer/status/:reference', auth, async (req, res) => {
 try {
 const deposit = await BankTransferDeposit.findOne({ reference: req.params.reference, userId: req.user._id });
 if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
 if (deposit.status !== 'pending') {
 console.log(`BT poll: deposit ${deposit.reference} already ${deposit.status}`);
 return res.json({ status: deposit.status });
 }
 if (deposit.expiresAt && Date.now() > new Date(deposit.expiresAt).getTime()) {
 deposit.status = 'expired';
 await deposit.save();
 console.log(`BT poll: deposit ${deposit.reference} expired`);
 return res.json({ status: 'expired' });
 }
 try {
 const fromDate = new Date(deposit.createdAt || Date.now() - 3600000);
 const toDate = new Date(Math.min(Date.now(), deposit.expiresAt ? new Date(deposit.expiresAt).getTime() : Date.now()));
 const fromStr = fromDate.toISOString().slice(0, 10);
 const toStr = new Date(toDate.getTime() + 86400000).toISOString().slice(0, 10); // +1 day buffer
 console.log(`BT poll: checking FLW v3 /transactions for ref=${deposit.reference} acct=${deposit.accountNumber} from=${fromStr} to=${toStr}`);
 const txListRes = await flwAxios.get('/transactions', {
 params: {
 from: fromStr,
 to: toStr,
 status: 'successful',
 currency: 'NGN',
 },
 timeout: 10000
 });
 const txList = txListRes.data?.data || [];
 console.log(`BT poll: FLW returned ${txList.length} successful NGN transactions`);
 const match = txList.find(t => {
 const amountOk = Number(t.amount) >= deposit.amount * 0.99; // allow tiny rounding
 const acctMatch =
 (t.meta?.accountNumber === deposit.accountNumber) ||
 (t.meta?.destinationAccountNumber === deposit.accountNumber) ||
 String(t.narration || '').includes(deposit.accountNumber) ||
 String(t.meta?.narration || '').includes(deposit.accountNumber);
 const refMatch = (t.tx_ref === deposit.reference);
 return (acctMatch || refMatch) && amountOk;
 });
 // Guard: if that charge was already credited as a permanent-VA deposit,
 // crediting it here as a bank transfer would pay the same money twice.
 if (match && (await VirtualAccountDeposit.findOne({ flwRef: chargeKey(match) }).select('_id') || await Transaction.exists({ txRef: chargeKey(match) }))) {
 console.log('BT poll: charge already credited as a VA deposit — ignoring');
 return res.json({ status: 'pending' });
 }
 if (match) {
 console.log(`BT poll: MATCH found — tx ${match.id} amount ₦${match.amount} for ref ${deposit.reference}`);
 const fresh = await BankTransferDeposit.findOneAndUpdate(
 { _id: deposit._id, status: 'pending' },
 { status: 'success', flwChargeId: String(match.id || match.flw_ref || '') },
 { new: true }
 );
 if (fresh) {
 const updatedUser = await User.findByIdAndUpdate(
 fresh.userId,
 { $inc: { balance: fresh.creditAmount } },
 { new: true }
 );
 await Transaction.create({
 userId: fresh.userId,
 type: 'deposit',
 txRef: chargeKey(match),
 amount: fresh.creditAmount,
 description: `VA bank transfer deposit — ₦${fresh.creditAmount.toLocaleString('en-NG')} credited (₦${fresh.amount.toLocaleString('en-NG')} received, ₦${fresh.fee} fee) via ${fresh.bankName || 'bank transfer'}`,
 status: 'success'
 });
 if (updatedUser) pushBalanceToUser(fresh.userId, updatedUser.balance);
 console.log(` BT poll credited ₦${fresh.creditAmount} for user ${fresh.userId}`);
 return res.json({ status: 'success' });
 } else {
 console.log(`BT poll: deposit ${deposit.reference} already credited (webhook beat us)`);
 return res.json({ status: 'success' });
 }
 } else {
 console.log(`BT poll: no matching transaction found yet for ${deposit.reference}`);
 }
 } catch (pollErr) {
 console.error('BT poll FLW API error:', pollErr.response?.data || pollErr.message);
 }
 res.json({ status: 'pending' });
 } catch (e) {
 console.error('BT status endpoint error:', e.message);
 res.status(500).json({ error: 'Failed to check deposit status' });
 }
});
app.get('/api/user/virtual-account/latest-deposit', auth, async (req, res) => {
 try {
 const user = await User.findById(req.user._id).select('balance virtualAccount paystackVirtualAccount email');
 if (!user) return res.status(404).json({ error: 'User not found' });
 const latest = await VirtualAccountDeposit.findOne({ userId: user._id })
 .sort({ createdAt: -1 })
 .select('status amount creditAmount createdAt flwRef');
 let reconCredit = null;
 const vaEnabled = user.virtualAccount?.enabled && user.virtualAccount?.accountNumber;
 if (vaEnabled) {
 const cacheKey = String(user._id);
 const lastCheck = _vaReconCache.get(cacheKey) || 0;
 if (Date.now() - lastCheck > 30000) { // throttle: check at most every 30s
 _vaReconCache.set(cacheKey, Date.now());
 try {
 const from = new Date(Date.now() - 2 * 60 * 60 * 1000);
 const to = new Date(Date.now() + 3600000);
 const txRes = await flwAxios.get('/transactions', {
 params: { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10),
 status: 'successful', currency: 'NGN' },
 timeout: 8000
 });
 const txList = txRes.data?.data || [];
 const vaAccNum = user.virtualAccount.accountNumber;
 for (const tx of txList) {
 const custEmail = (tx.customer?.email || '').toLowerCase();
 const txAccNum = tx.virtual_account_number || tx.meta?.accountNumber || tx.meta?.destinationAccountNumber;
 // Account number is the only trustworthy match here. Matching on e-mail alone
 // re-credited payment-link / bank-transfer payments the same user had already
 // made, which showed up as a second confirmation for one deposit.
 const isMatch = txAccNum && txAccNum === vaAccNum;
 if (!isMatch) continue;
 const flwRef = chargeKey(tx);
 if (!flwRef) continue;
 const already = await VirtualAccountDeposit.findOne({ flwRef }).select('_id');
 if (already) continue; // already credited
 console.log(`[VA-poll-reconcile] Found uncredited tx ${flwRef} for ${user.email} ₦${tx.amount}`);
 const out = await handleVaWebhookCredit(user, tx).catch(err => { console.warn('[VA-poll-reconcile] credit error:', err.message); return null; });
 if (out?.status === 'credited') { reconCredit = { flwRef, amount: tx.amount }; break; }
 continue;
 }
 } catch (reconErr) {
 console.warn('[VA-poll-reconcile] error:', reconErr.message);
 }
 }
 }
 if (!reconCredit && user.paystackVirtualAccount?.enabled && user.paystackVirtualAccount?.customerId && process.env.PAYSTACK_SECRET_KEY) {
 const psKey = 'ps:' + String(user._id);
 if (Date.now() - (_vaReconCache.get(psKey) || 0) > 30000) { // throttle: at most every 30s
 _vaReconCache.set(psKey, Date.now());
 try {
 const psRes = await paystackAxios.get('/transaction', {
 params: { customer: user.paystackVirtualAccount.customerId, status: 'success', perPage: 20, from: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
 timeout: 10000
 });
 for (const ptx of (psRes.data?.data || [])) {
 if (!isPaystackDvaTx(ptx)) continue;
 const out = await handlePaystackVaCredit(user, ptx).catch(err => { console.warn('[PS-VA-poll-reconcile] credit error:', err.message); return null; });
 if (out?.status === 'credited') { reconCredit = { flwRef: 'PSK-' + ptx.reference, amount: Number(ptx.amount) / 100 }; break; }
 }
 } catch (psErr) { console.warn('[PS-VA-poll-reconcile] error:', psErr.response?.data?.message || psErr.message); }
 }
 }
 const latestFinal = reconCredit
 ? await VirtualAccountDeposit.findOne({ userId: user._id }).sort({ createdAt: -1 }).select('status amount creditAmount createdAt flwRef')
 : latest;
 const freshUser = reconCredit ? await User.findById(user._id).select('balance') : user;
 res.json({
 balance: freshUser.balance || 0,
 vaEnabled: !!(vaEnabled || (user.paystackVirtualAccount?.enabled && user.paystackVirtualAccount?.accountNumber)),
 reconCredit, // non-null if we just credited something in this poll
 latestDeposit: latestFinal ? {
 status: latestFinal.status,
 amount: latestFinal.amount,
 creditAmount:latestFinal.creditAmount,
 createdAt: latestFinal.createdAt,
 flwRef: latestFinal.flwRef
 } : null
 });
 } catch (e) {
 console.error('VA latest-deposit poll error:', e.message);
 res.status(500).json({ error: 'Failed to check VA status' });
 }
});
const _vaReconCache = new Map();
app.get('/api/user/virtual-account/deposits', auth, async (req, res) => {
 try {
 const deposits = await VirtualAccountDeposit.find({ userId: req.user._id })
 .sort({ createdAt: -1 }).limit(20)
 .select('amount creditAmount status createdAt flwRef');
 res.json({ deposits });
 } catch (e) {
 res.status(500).json({ error: 'Failed to fetch VA deposits' });
 }
});
async function sendWhatsAppNotification(user, amount, bank, accountName, receiptId, receiptImageUrl, aiResult) {
 try {
 const instance = process.env.ULTRAMSG_INSTANCE;
 const token = process.env.ULTRAMSG_TOKEN;
 const phone = process.env.ADMIN_WHATSAPP;
 const siteUrl = process.env.SITE_URL || 'https://your-site.onrender.com';
 const adminPath = process.env.ADMIN_SECRET_PATH || 'rsh-admin-secret';
 const passcode = process.env.ADMIN_PASSCODE;
 if (!instance || !token || !phone) {
 const msg = 'UltraMsg not configured — WhatsApp notification skipped';
 console.log(msg);
 await SystemError.create({
 source: 'ultramsg',
 message: msg,
 detail: 'Missing ULTRAMSG_INSTANCE, ULTRAMSG_TOKEN, or ADMIN_WHATSAPP in environment variables.',
 context: { userEmail: user.email, amount, receiptId: String(receiptId) }
 });
 return { sent: false, error: msg };
 }
 const approveLink = `${siteUrl}/${adminPath}`; // SECURITY: never put the admin passcode in a link
 const rejectLink = approveLink;
 const aiSummary = aiResult
 ? ` AI: ${aiResult.verdict.toUpperCase()} (${aiResult.confidence}%)\n Reason: ${aiResult.reason}${aiResult.flags?.length ? '\n Flags: ' + aiResult.flags.join(', ') : ''}\n\n`
 : '';
 const msg =
 `*${BRAND.name.toUpperCase()} DEPOSIT — MANUAL REVIEW*\n\n` +
 `User: ${user.name}\n` +
 `Email: ${user.email}\n` +
 `Amount: ₦${amount.toLocaleString('en-NG')}\n` +
 `Bank: ${bank}\n` +
 `Sender: ${accountName || 'Not provided'}\n` +
 `Time: ${new Date().toLocaleString('en-NG')}\n\n` +
 aiSummary +
 `APPROVE:\n${approveLink}\n\n` +
 `REJECT:\n${rejectLink}\n\n` +
 `Admin Panel: ${siteUrl}/${adminPath}`;
 const baseUrl = `https://api.ultramsg.com/${instance}`;
 await axios.post(`${baseUrl}/messages/chat`, { token, to: phone, body: msg }, { timeout: 10000 });
 console.log(' WhatsApp text notification sent via UltraMsg');
 const receiptUrl = receiptImageUrl.startsWith('http') ? receiptImageUrl : `${siteUrl}${receiptImageUrl}`;
 await axios.post(`${baseUrl}/messages/image`, {
 token, to: phone,
 image: receiptUrl,
 caption: ` Receipt — ${user.name} — ₦${amount.toLocaleString('en-NG')} via ${bank}`
 }, { timeout: 10000 });
 console.log(' WhatsApp receipt image sent via UltraMsg');
 return { sent: true };
 } catch (e) {
 const detail = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
 console.log('WhatsApp notification failed (non-fatal):', detail);
 try {
 await SystemError.create({
 source: 'ultramsg',
 message: 'Failed to send WhatsApp deposit notification',
 detail,
 context: { userEmail: user?.email, amount, receiptId: String(receiptId || '') }
 });
 } catch (logErr) { console.log('Failed to persist SystemError:', logErr.message); }
 return { sent: false, error: detail };
 }
}
app.get('/api/admin/receipts/:id/quick-action', (req, res) => {
 // SECURITY: disabled. A state-changing GET carrying the master admin passcode in the URL leaks the
 // passcode (logs, WhatsApp, link-preview bots) and can be fired by crawlers. Use the admin panel.
 res.status(410).send('<h2>This one-click link has been retired for security. Please approve or reject receipts from the admin panel.</h2>');
});
app.post('/api/visit', async (req, res) => {
 try {
 const { visitorId } = req.body;
 let isNewVisitor = false;
 if (visitorId) {
 const before = await VisitorLog.findOneAndUpdate(
 { visitorId },
 { $inc: { visitCount: 1 }, $set: { lastSeen: new Date() }, $setOnInsert: { visitorId, firstSeen: new Date() } },
 { upsert: true, new: false, includeResultMetadata: true }
 );
 isNewVisitor = !before?.lastErrorObject?.updatedExisting;
 }
 const stats = await VisitorStats.findOneAndUpdate(
 { key: 'global' },
 { $inc: { visitors: isNewVisitor ? 1 : 0 }, $setOnInsert: { key: 'global' } },
 { upsert: true, new: true }
 );
 res.json({ visitors: stats.visitors });
 } catch (e) {
 console.error('Visit tracking error:', e.message);
 res.status(500).json({ error: 'Failed to record visit' });
 }
});
app.get('/api/visit', async (req, res) => {
 try {
 const stats = await VisitorStats.findOne({ key: 'global' });
 res.json({ visitors: stats?.visitors || 0 });
 } catch (e) {
 res.status(500).json({ error: 'Failed to load visitor stats' });
 }
});
app.get('/api/ads', async (req, res) => {
 try {
 const ads = await Ad.find({ active: true }).sort({ createdAt: -1 });
 res.json(ads);
 } catch (e) { res.status(500).json({ error: 'Failed to load ads' }); }
});
// Attaches each sender's CURRENT profile picture to a list of chat/DM messages.
// Returned as an extra `senderPicture` field, and left as an empty string when the user
// never uploaded one — the UI then falls back to an initial instead of a stock avatar.
async function withSenderPictures(messages, idField) {
 const list = messages.map(m => (typeof m.toObject === 'function' ? m.toObject() : m));
 const ids = [...new Set(list.map(m => String(m[idField] && m[idField]._id ? m[idField]._id : m[idField])).filter(Boolean))];
 if (!ids.length) return list;
 let picMap = {};
 try {
 const users = await User.find({ _id: { $in: ids } }).select('profilePicture');
 picMap = Object.fromEntries(users.map(u => [String(u._id), u.profilePicture || '']));
 } catch { picMap = {}; }
 return list.map(m => {
 const sid = String(m[idField] && m[idField]._id ? m[idField]._id : m[idField]);
 return { ...m, senderPicture: picMap[sid] || '' };
 });
}
app.get('/api/chat/groups', auth, async (req, res) => {
 const groups = await ChatGroup.find({ active: true }).sort({ createdAt: 1 });
 res.json(groups);
});
app.get('/api/chat/groups/:groupId/messages', auth, async (req, res) => {
 try {
 const group = await ChatGroup.findById(req.params.groupId);
 if (!group || !group.active) return res.status(404).json({ error: 'Group not found' });
 const after = req.query.after; // ISO date — only return messages after this (for polling)
 const filter = { groupId: group._id, deleted: false };
 if (after) filter.createdAt = { $gt: new Date(after) };
 const limit = after ? 100 : 50; // full history capped, polling deltas uncapped-ish
 const messages = await ChatMessage.find(filter).sort({ createdAt: after ? 1 : -1 }).limit(limit);
 const ordered = after ? messages : messages.reverse();
 res.json(await withSenderPictures(ordered, 'userId'));
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chat/groups/:groupId/messages', auth, chatUpload.single('attachment'), async (req, res) => {
 try {
 const text = (req.body.text || '').trim();
 const file = req.file;
 if (!text && !file) return res.status(400).json({ error: 'Message cannot be empty' });
 if (text.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
 const group = await ChatGroup.findById(req.params.groupId);
 if (!group || !group.active) return res.status(404).json({ error: 'Group not found or closed' });
 let attachmentUrl = '', attachmentType = '', attachmentName = '';
 if (file) {
 attachmentUrl = fileUrl(file);
 attachmentName = file.originalname;
 if (/^image\//.test(file.mimetype)) attachmentType = 'image';
 else if (/^video\//.test(file.mimetype)) attachmentType = 'video';
 else if (/^audio\//.test(file.mimetype)) attachmentType = 'audio';
 else attachmentType = 'file';
 }
 const msg = await ChatMessage.create({
 groupId: group._id, userId: req.user._id, userName: req.user.name,
 text, attachmentUrl, attachmentType, attachmentName
 });
 res.json({ ...msg.toObject(), senderPicture: req.user.profilePicture || '' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dm/start', auth, async (req, res) => {
 try {
 const { userId } = req.body;
 if (!userId) return res.status(400).json({ error: 'userId required' });
 if (String(userId) === String(req.user._id)) return res.status(400).json({ error: "You can't message yourself" });
 const otherUser = await User.findById(userId).select('name');
 if (!otherUser) return res.status(404).json({ error: 'User not found' });
 let convo = await Conversation.findOne({ participants: { $all: [req.user._id, userId], $size: 2 } });
 if (!convo) convo = await Conversation.create({ participants: [req.user._id, userId] });
 res.json(convo);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/dm/conversations', auth, async (req, res) => {
 try {
 const convos = await Conversation.find({ participants: req.user._id }).sort({ lastMessageAt: -1 }).limit(100);
 const otherIds = convos.map(c => c.participants.find(p => String(p) !== String(req.user._id)));
 const others = await User.find({ _id: { $in: otherIds } }).select('name profilePicture');
 const otherMap = Object.fromEntries(others.map(u => [String(u._id), u.name]));
 const otherPicMap = Object.fromEntries(others.map(u => [String(u._id), u.profilePicture || '']));
 const unreadCounts = await DirectMessage.aggregate([
 { $match: { conversationId: { $in: convos.map(c => c._id) }, senderId: { $ne: req.user._id }, readBy: { $ne: req.user._id }, deleted: false } },
 { $group: { _id: '$conversationId', count: { $sum: 1 } } }
 ]);
 const unreadMap = Object.fromEntries(unreadCounts.map(u => [String(u._id), u.count]));
 res.json(convos.map(c => {
 const otherId = c.participants.find(p => String(p) !== String(req.user._id));
 return {
 _id: c._id, otherUserId: otherId, otherUserName: otherMap[String(otherId)] || 'Unknown user',
 otherUserPicture: otherPicMap[String(otherId)] || '',
 lastMessageText: c.lastMessageText, lastMessageAt: c.lastMessageAt,
 unreadCount: unreadMap[String(c._id)] || 0
 };
 }));
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/dm/conversations/:id/messages', auth, async (req, res) => {
 try {
 const convo = await Conversation.findById(req.params.id);
 if (!convo || !convo.participants.some(p => String(p) === String(req.user._id)))
 return res.status(404).json({ error: 'Conversation not found' });
 const after = req.query.after;
 const filter = { conversationId: convo._id, deleted: false };
 if (after) filter.createdAt = { $gt: new Date(after) };
 const limit = after ? 100 : 50;
 const messages = await DirectMessage.find(filter).sort({ createdAt: after ? 1 : -1 }).limit(limit);
 const ordered = after ? messages : messages.reverse();
 res.json(await withSenderPictures(ordered, 'senderId'));
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dm/conversations/:id/messages', auth, chatUpload.single('attachment'), async (req, res) => {
 try {
 const text = (req.body.text || '').trim();
 const file = req.file;
 if (!text && !file) return res.status(400).json({ error: 'Message cannot be empty' });
 if (text.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
 const convo = await Conversation.findById(req.params.id);
 if (!convo || !convo.participants.some(p => String(p) === String(req.user._id)))
 return res.status(404).json({ error: 'Conversation not found' });
 let attachmentUrl = '', attachmentType = '', attachmentName = '';
 if (file) {
 attachmentUrl = fileUrl(file);
 attachmentName = file.originalname;
 if (/^image\//.test(file.mimetype)) attachmentType = 'image';
 else if (/^video\//.test(file.mimetype)) attachmentType = 'video';
 else if (/^audio\//.test(file.mimetype)) attachmentType = 'audio';
 else attachmentType = 'file';
 }
 const msg = await DirectMessage.create({
 conversationId: convo._id, senderId: req.user._id, senderName: req.user.name,
 text, attachmentUrl, attachmentType, attachmentName, readBy: [req.user._id]
 });
 convo.lastMessageText = text ? text.slice(0, 100) : (attachmentType === 'audio' ? 'Voice note' : attachmentType ? 'Attachment' : '');
 convo.lastMessageAt = new Date();
 await convo.save();
 res.json({ ...msg.toObject(), senderPicture: req.user.profilePicture || '' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dm/conversations/:id/read', auth, async (req, res) => {
 try {
 const convo = await Conversation.findById(req.params.id);
 if (!convo || !convo.participants.some(p => String(p) === String(req.user._id)))
 return res.status(404).json({ error: 'Conversation not found' });
 await DirectMessage.updateMany(
 { conversationId: convo._id, readBy: { $ne: req.user._id } },
 { $addToSet: { readBy: req.user._id } }
 );
 res.json({ message: 'Marked as read' });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/chat/groups', adminAuth, async (req, res) => res.json(await ChatGroup.find().sort({ createdAt: -1 })));
app.post('/api/admin/chat/groups', adminAuth, async (req, res) => {
 try {
 const { name, description } = req.body;
 if (!name) return res.status(400).json({ error: 'Group name required' });
 const group = await ChatGroup.create({ name, description: description || '' });
 res.json(group);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/chat/groups/:id', adminAuth, async (req, res) => {
 try {
 const { name, description, active } = req.body;
 const update = {};
 if (name !== undefined) update.name = name;
 if (description !== undefined) update.description = description;
 if (active !== undefined) update.active = active === true || active === 'true';
 const group = await ChatGroup.findByIdAndUpdate(req.params.id, update, { new: true });
 if (!group) return res.status(404).json({ error: 'Not found' });
 res.json(group);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/chat/groups/:id', adminAuth, async (req, res) => {
 await ChatGroup.findByIdAndDelete(req.params.id);
 await ChatMessage.deleteMany({ groupId: req.params.id });
 res.json({ message: 'Group deleted' });
});
app.delete('/api/admin/chat/messages/:id', adminAuth, async (req, res) => {
 const msg = await ChatMessage.findByIdAndUpdate(req.params.id, { deleted: true }, { new: true });
 if (!msg) return res.status(404).json({ error: 'Not found' });
 res.json({ message: 'Message removed' });
});
app.get('/api/v1/me', apiKeyAuth, async (req, res) => {
 res.json({ id: req.apiUser._id, name: req.apiUser.name, email: req.apiUser.email, balance: req.apiUser.balance, restricted: req.apiUser.restricted });
});
app.get('/api/v1/balance', apiKeyAuth, async (req, res) => {
 res.json({ balance: req.apiUser.balance || 0 });
});
app.get('/api/v1/purchases', apiKeyAuth, async (req, res) => {
 const u = await User.findById(req.apiUser._id).select('purchaseDetails');
 res.json(u.purchaseDetails || []);
});
app.get('/api/v1/purchases/:purchaseId', apiKeyAuth, async (req, res) => {
 const u = await User.findById(req.apiUser._id).select('purchaseDetails');
 const purchase = (u.purchaseDetails || []).id(req.params.purchaseId);
 if (!purchase) return res.status(404).json({ error: 'Purchase not found on your account' });
 res.json(purchase);
});
app.get('/api/v1/listings', apiKeyAuth, async (req, res) => {
 const filter = { available: true };
 if (req.query.type && req.query.type !== 'all') filter.type = req.query.type;
 const logs = await Log.find(filter).select('-details -toolLink -deliverableFile').sort({ createdAt: -1 });
 const visible = logs.filter(l => l.type === 'tool' || l.maxPurchases <= 0 || l.soldCount < l.maxPurchases);
 res.json(visible);
});
app.get('/api/v1/listings/:id', apiKeyAuth, async (req, res) => {
 const log = await Log.findById(req.params.id).select('-details -toolLink -deliverableFile');
 if (!log) return res.status(404).json({ error: 'Not found' });
 res.json(log);
});
app.post('/api/v1/buy/:id', apiKeyAuth, async (req, res) => {
 try {
 const log = await Log.findById(req.params.id);
 if (!log || !log.available) return res.status(404).json({ error: 'Item not available' });
 const user = await User.findById(req.apiUser._id);
 if (log.listingType === 'folder') {
 const available = (log.subAccounts || []).filter(sa => !sa.sold);
 if (!available.length) return res.status(400).json({ error: 'Sold out' });
 let targetId = req.body.subAccountId;
 if (!targetId) {
 available.sort((a, b) => (a.price||0) - (b.price||0));
 targetId = available[0]._id;
 }
 const claimed = await Log.findOneAndUpdate(
 { _id: log._id, subAccounts: { $elemMatch: { _id: targetId, sold: false } } },
 { $set: { 'subAccounts.$.sold': true, 'subAccounts.$.soldTo': user._id, 'subAccounts.$.soldAt': new Date() } },
 { new: true }
 );
 if (!claimed) return res.status(400).json({ error: 'That account was just sold to someone else — try again or omit subAccountId to auto-pick another.' });
 const sub = claimed.subAccounts.id(targetId);
 if ((user.balance || 0) < sub.price) {
 await Log.updateOne({ _id: log._id, 'subAccounts._id': targetId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: `Insufficient balance — this account costs ₦${sub.price}` });
 }
 const _subDoc = {
 logId: log._id, logTitle: `${log.title} — ${sub.label}`, logType: log.type, logDetails: sub.details || '',
 toolLink: sub.toolLink || '', deliveryType: sub.deliveryType || 'link',
 deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || '',
 pricePaid: sub.price, subAccountId: sub._id
 };
 const _deb = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: sub.price } }, { $inc: { balance: -sub.price }, $push: { purchaseDetails: _subDoc } }, { new: true });
 if (!_deb) {
 await Log.updateOne({ _id: log._id, 'subAccounts._id': targetId }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: `Insufficient balance — this account costs ₦${sub.price}` });
 }
 user.balance = _deb.balance; user.purchaseDetails = _deb.purchaseDetails;
 const purchaseRecord = _deb.purchaseDetails[_deb.purchaseDetails.length - 1];
 await Transaction.create({ userId: user._id, type: 'purchase', amount: sub.price, description: `Purchased via API: ${log.title} — ${sub.label}`, status: 'success' });
 await creditReferralCommission(user, sub.price, `${log.title} — ${sub.label}`);
 checkAndAwardBadges(user._id).catch(() => {});
 return res.json({
 message: 'Purchase successful', newBalance: user.balance, purchaseId: purchaseRecord._id, purchasedAt: purchaseRecord.purchasedAt,
 itemPrice: sub.price, totalCharged: sub.price,
 logDetails: sub.details || '', toolLink: sub.toolLink || '', deliveryType: sub.deliveryType || 'link',
 deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || ''
 });
 }
 if (log.type === 'log') {
 if (log.maxPurchases > 0 && log.soldCount >= log.maxPurchases) return res.status(400).json({ error: 'Sold out' });
 } else if (log.toolQty > 0 && log.soldCount >= log.toolQty) {
 return res.status(400).json({ error: 'Out of stock' });
 }
 if (!(Number(log.price) >= 0)) return res.status(400).json({ error: 'Invalid item price' });
 const _sf = log.type === 'tool' ? 'toolQty' : 'maxPurchases';
 const _claim = await Log.findOneAndUpdate(
 { _id: log._id, $expr: { $or: [ { $lte: [ { $ifNull: ['$' + _sf, 0] }, 0 ] }, { $lt: [ { $ifNull: ['$soldCount', 0] }, '$' + _sf ] } ] } },
 { $inc: { soldCount: 1 } }, { new: true });
 if (!_claim) return res.status(400).json({ error: 'Sold out' });
 const _deb = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: log.price } }, { $inc: { balance: -log.price }, $push: { purchaseDetails: {
 logId: log._id, logTitle: log.title, logType: log.type, logDetails: log.details || '',
 toolLink: log.toolLink || '', deliveryType: log.deliveryType || 'link',
 deliverableFile: log.deliverableFile || '', deliverableFileName: log.deliverableFileName || '',
 pricePaid: log.price } } }, { new: true });
 if (!_deb) {
 await Log.updateOne({ _id: log._id }, { $inc: { soldCount: -1 } });
 return res.status(400).json({ error: `Insufficient balance — this item costs ₦${log.price}` });
 }
 user.balance = _deb.balance; user.purchaseDetails = _deb.purchaseDetails;
 const purchaseRecord = _deb.purchaseDetails[_deb.purchaseDetails.length - 1];
 await Transaction.create({ userId: user._id, type: 'purchase', amount: log.price, description: `Purchased via API: ${log.title}`, status: 'success' });
 await creditReferralCommission(user, log.price, log.title);
 checkAndAwardBadges(user._id).catch(() => {});
 res.json({
 message: 'Purchase successful', newBalance: user.balance, purchaseId: purchaseRecord._id, purchasedAt: purchaseRecord.purchasedAt,
 itemPrice: log.price, totalCharged: log.price,
 logDetails: log.details || '', toolLink: log.toolLink || '', deliveryType: log.deliveryType || 'link',
 deliverableFile: log.deliverableFile || '', deliverableFileName: log.deliverableFileName || ''
 });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/buy-multi/:id', apiKeyAuth, async (req, res) => {
 const claimedIds = [];
 try {
 const { subAccountIds } = req.body;
 if (!Array.isArray(subAccountIds) || !subAccountIds.length)
 return res.status(400).json({ error: 'subAccountIds must be a non-empty array' });
 if (subAccountIds.length > 50) return res.status(400).json({ error: 'Max 50 accounts per batch' });
 const log = await Log.findById(req.params.id);
 if (!log || !log.available) return res.status(404).json({ error: 'Item not available' });
 if (log.listingType !== 'folder') return res.status(400).json({ error: 'This item does not support multi-buy' });
 const user = await User.findById(req.apiUser._id);
 const claimedSubs = [];
 for (const subId of subAccountIds) {
 const claimed = await Log.findOneAndUpdate(
 { _id: log._id, subAccounts: { $elemMatch: { _id: subId, sold: false } } },
 { $set: { 'subAccounts.$.sold': true, 'subAccounts.$.soldTo': user._id, 'subAccounts.$.soldAt': new Date() } },
 { new: true }
 );
 if (!claimed) {
 for (const rid of claimedIds) await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: 'One of the requested accounts was already sold. Nothing was charged — retry with different IDs.' });
 }
 claimedIds.push(subId);
 claimedSubs.push(claimed.subAccounts.id(subId));
 }
 const total = claimedSubs.reduce((s, sa) => s + (sa.price || 0), 0);
 if ((user.balance || 0) < total) {
 for (const rid of claimedIds) await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: `Insufficient balance — this batch costs ₦${total}` });
 }
 const _docs = claimedSubs.map(sub => ({
 logId: log._id, logTitle: `${log.title} — ${sub.label}`, logType: log.type, logDetails: sub.details || '',
 toolLink: sub.toolLink || '', deliveryType: sub.deliveryType || 'link',
 deliverableFile: sub.deliverableFile || '', deliverableFileName: sub.deliverableFileName || '',
 pricePaid: sub.price, subAccountId: sub._id
 }));
 // SECURITY: atomic conditional debit + purchase records in one write (no double-spend, no negative balance)
 const _debited = await User.findOneAndUpdate(
 { _id: user._id, balance: { $gte: total } },
 { $inc: { balance: -total }, $push: { purchaseDetails: { $each: _docs } } }, { new: true }
 );
 if (!_debited) {
 for (const rid of claimedIds) await Log.updateOne({ _id: log._id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } });
 return res.status(400).json({ error: 'Insufficient balance for this batch. Please deposit funds.' });
 }
 user.balance = _debited.balance; user.purchaseDetails = _debited.purchaseDetails;
 const newRecords = _debited.purchaseDetails.slice(-claimedSubs.length);
 await Transaction.create({ userId: user._id, type: 'purchase', amount: total, description: `Purchased ${claimedSubs.length} accounts via API: ${log.title}`, status: 'success' });
 for (const sub of claimedSubs) await creditReferralCommission(user, sub.price, `${log.title} — ${sub.label}`);
 checkAndAwardBadges(user._id).catch(() => {});
 res.json({
 message: `${claimedSubs.length} accounts purchased`, newBalance: user.balance, totalCharged: total,
 items: newRecords.map(r => ({
 purchaseId: r._id, purchasedAt: r.purchasedAt, pricePaid: r.pricePaid, logTitle: r.logTitle,
 logDetails: r.logDetails, toolLink: r.toolLink, deliveryType: r.deliveryType,
 deliverableFile: r.deliverableFile, deliverableFileName: r.deliverableFileName
 }))
 });
 } catch (e) {
 for (const rid of claimedIds) { try { await Log.updateOne({ _id: req.params.id, 'subAccounts._id': rid }, { $set: { 'subAccounts.$.sold': false, 'subAccounts.$.soldTo': null, 'subAccounts.$.soldAt': null } }); } catch {} }
 res.status(500).json({ error: e.message });
 }
});
app.get('/api/v1/categories', apiKeyAuth, async (req, res) => {
 try {
 const cats = await Category.find().sort({ name: 1 });
 res.json({ categories: cats.map(c => ({ id: c._id, name: c.name })) });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/marketplace', apiKeyAuth, async (req, res) => {
 try {
 const { category, type, search } = req.query;
 const page = Math.max(1, parseInt(req.query.page) || 1);
 const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
 const skip = (page - 1) * limit;
 const filter = { available: true };
 if (type && type !== 'all') filter.type = type;
 if (category) filter.category = category;
 if (search) filter.$or = [
 { title: { $regex: search, $options: 'i' } },
 { description: { $regex: search, $options: 'i' } },
 { category: { $regex: search, $options: 'i' } }
 ];
 const [total, logs] = await Promise.all([
 Log.countDocuments(filter),
 Log.find(filter)
 .select('title description type category price soldCount maxPurchases toolQty listingType picture available createdAt')
 .sort({ createdAt: -1 })
 .skip(skip).limit(limit)
 ]);
 const items = logs.map(l => {
 const isTool = l.type === 'tool';
 const soldOut = isTool ? (l.toolQty > 0 && l.soldCount >= l.toolQty) : (l.maxPurchases > 0 && l.soldCount >= l.maxPurchases);
 return {
 id: l._id,
 title: l.title,
 description: l.description,
 type: l.type,
 listingType: l.listingType,
 category: l.category,
 price: l.price,
 soldCount: l.soldCount,
 stockLeft: isTool ? (l.toolQty > 0 ? Math.max(0, l.toolQty - l.soldCount) : null) : (l.maxPurchases > 0 ? Math.max(0, l.maxPurchases - l.soldCount) : null),
 soldOut,
 picture: l.picture || null,
 available: l.available,
 createdAt: l.createdAt
 };
 });
 res.json({
 page, limit, total,
 totalPages: Math.ceil(total / limit),
 items
 });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/tools', apiKeyAuth, async (req, res) => {
 try {
 const { category, search } = req.query;
 const page = Math.max(1, parseInt(req.query.page) || 1);
 const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
 const skip = (page - 1) * limit;
 const filter = { available: true, type: 'tool' };
 if (category) filter.category = category;
 if (search) filter.$or = [{ title: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
 const [total, tools] = await Promise.all([
 Log.countDocuments(filter),
 Log.find(filter)
 .select('title description category price soldCount toolQty picture listingType createdAt')
 .sort({ createdAt: -1 })
 .skip(skip).limit(limit)
 ]);
 res.json({
 page, limit, total, totalPages: Math.ceil(total / limit),
 tools: tools.map(t => ({
 id: t._id, title: t.title, description: t.description,
 category: t.category, price: t.price, soldCount: t.soldCount,
 stockTotal: t.toolQty || null,
 stockLeft: t.toolQty > 0 ? Math.max(0, t.toolQty - t.soldCount) : null,
 soldOut: t.toolQty > 0 && t.soldCount >= t.toolQty,
 picture: t.picture || null, listingType: t.listingType, createdAt: t.createdAt
 }))
 });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/marketplace/:id', apiKeyAuth, async (req, res) => {
 try {
 const log = await Log.findById(req.params.id)
 .select('-details -toolLink -deliverableFile -deliverableFileName -subAccounts');
 if (!log) return res.status(404).json({ error: 'Item not found' });
 const isTool = log.type === 'tool';
 const soldOut = isTool ? (log.toolQty > 0 && log.soldCount >= log.toolQty) : (log.maxPurchases > 0 && log.soldCount >= log.maxPurchases);
 res.json({
 id: log._id, title: log.title, description: log.description,
 type: log.type, listingType: log.listingType, category: log.category,
 price: log.price, soldCount: log.soldCount,
 stockLeft: isTool ? (log.toolQty > 0 ? Math.max(0, log.toolQty - log.soldCount) : null) : (log.maxPurchases > 0 ? Math.max(0, log.maxPurchases - log.soldCount) : null),
 soldOut, picture: log.picture || null, available: log.available,
 averageRating: log.reviews?.length ? (log.reviews.reduce((s,r)=>s+r.rating,0)/log.reviews.length).toFixed(1) : null,
 reviewCount: log.reviews?.length || 0,
 createdAt: log.createdAt
 });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/transactions', apiKeyAuth, async (req, res) => {
 try {
 const page = Math.max(1, parseInt(req.query.page) || 1);
 const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
 const [total, txs] = await Promise.all([
 Transaction.countDocuments({ userId: req.apiUser._id }),
 Transaction.find({ userId: req.apiUser._id })
 .sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit)
 .select('type amount description status createdAt')
 ]);
 res.json({ page, limit, total, totalPages: Math.ceil(total/limit), transactions: txs });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/top-buyers', optionalAuth, async (req, res) => {
 try {
 const top = await Transaction.aggregate([
 { $match: { type: 'purchase', status: 'success' } },
 { $group: { _id: '$userId', totalSpent: { $sum: '$amount' }, purchaseCount: { $sum: 1 } } },
 { $sort: { totalSpent: -1 } },
 { $limit: 10 },
 { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
 { $unwind: '$user' },
 { $project: { name: '$user.name', profilePicture: '$user.profilePicture', totalSpent: 1, purchaseCount: 1 } }
 ]);
 res.json(top);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/support', async (req, res) => {
 try {
 const { name, email, subject, message, userId } = req.body;
 if (!name || !email || !message) return res.status(400).json({ error: 'Name, email and message required' });
 await Support.create({ name, email, subject: subject || 'General', message, userId });
 res.json({ message: 'Support ticket submitted!' });
 } catch { res.status(500).json({ error: 'Failed to submit ticket' }); }
});
const supportMessageSchema = new mongoose.Schema({
 userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 sender: { type: String, enum: ['user', 'admin'], required: true },
 senderName: { type: String, default: '' },
 text: { type: String, default: '', maxlength: 2000 },
 attachmentUrl: { type: String, default: '' },
 attachmentType: { type: String, enum: ['', 'image'], default: '' },
 attachmentName: { type: String, default: '' },
 readByUser: { type: Boolean, default: false },
 readByAdmin: { type: Boolean, default: false },
 conversationStatus: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
 closedAt: { type: Date, default: null },
 createdAt: { type: Date, default: Date.now, index: true }
});
const SupportMessage = mongoose.models.SupportMessage || mongoose.model('SupportMessage', supportMessageSchema);

app.get('/api/support/live', auth, async (req, res) => {
 try {
  const messages = await SupportMessage.find({ userId: req.user._id }).sort({ createdAt: 1 }).limit(300).lean();
  const latest = messages[messages.length - 1];
  await SupportMessage.updateMany({ userId: req.user._id, sender: 'admin', readByUser: false }, { $set: { readByUser: true } });
  res.json({ messages, status: latest?.conversationStatus || 'open', closedAt: latest?.closedAt || null });
 } catch { res.status(500).json({ error: 'Could not load support chat' }); }
});
app.post('/api/support/live', auth, chatUpload.single('attachment'), async (req, res) => {
 try {
  const text = String(req.body.text || '').trim();
  const attachmentUrl = req.file ? fileUrl(req.file) : '';
  if (!text && !attachmentUrl) return res.status(400).json({ error: 'Message or image is required' });
  if (req.file && !/^image\//i.test(req.file.mimetype || '')) return res.status(400).json({ error: 'Support attachments must be images' });
  if (text.length > 2000) return res.status(400).json({ error: 'Message is too long' });
  const latest = await SupportMessage.findOne({ userId: req.user._id }).sort({ createdAt: -1 }).select('conversationStatus');
  if (latest?.conversationStatus === 'closed') return res.status(409).json({ error: 'This conversation is closed. Reopen it to send a new message.' });
  res.json(await SupportMessage.create({ userId: req.user._id, sender: 'user', senderName: req.user.name, text, attachmentUrl, attachmentType: attachmentUrl ? 'image' : '', attachmentName: req.file?.originalname || '', readByUser: true }));
 } catch { res.status(500).json({ error: 'Could not send message' }); }
});
app.post('/api/support/live/status', auth, async (req, res) => {
 try {
  const status = req.body?.status === 'open' ? 'open' : 'closed';
  const closedAt = status === 'closed' ? new Date() : null;
  await SupportMessage.updateMany({ userId: req.user._id }, { $set: { conversationStatus: status, closedAt } });
  res.json({ status, closedAt });
 } catch { res.status(500).json({ error: 'Could not update conversation' }); }
});
app.get('/api/admin/support/live', anyAdminAuth, async (req, res) => {
 try {
  res.json(await SupportMessage.aggregate([
   { $sort: { createdAt: 1 } },
    { $group: { _id: '$userId', lastMessage: { $last: { $cond: [{ $ne: ['$text', ''] }, '$text', '📷 Image'] } }, lastAt: { $last: '$createdAt' }, status: { $last: '$conversationStatus' }, unread: { $sum: { $cond: [{ $and: [{ $eq: ['$sender', 'user'] }, { $eq: ['$readByAdmin', false] }] }, 1, 0] } } } },
   { $sort: { lastAt: -1 } },
   { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
   { $unwind: '$user' },
   { $project: { userId: '$_id', name: '$user.name', email: '$user.email', lastMessage: 1, lastAt: 1, status: { $ifNull: ['$status', 'open'] }, unread: 1 } }
  ]));
 } catch { res.status(500).json({ error: 'Could not load live chats' }); }
});
app.get('/api/admin/support/live/:userId', anyAdminAuth, async (req, res) => {
 try {
  const messages = await SupportMessage.find({ userId: req.params.userId }).sort({ createdAt: 1 }).limit(300).lean();
  const latest = messages[messages.length - 1];
  await SupportMessage.updateMany({ userId: req.params.userId, sender: 'user', readByAdmin: false }, { $set: { readByAdmin: true } });
  res.json({ messages, status: latest?.conversationStatus || 'open', closedAt: latest?.closedAt || null });
 } catch { res.status(500).json({ error: 'Could not load conversation' }); }
});
app.post('/api/admin/support/live/:userId', anyAdminAuth, chatUpload.single('attachment'), async (req, res) => {
 try {
  const text = String(req.body.text || '').trim();
  const attachmentUrl = req.file ? fileUrl(req.file) : '';
  if (!text && !attachmentUrl) return res.status(400).json({ error: 'Reply or image is required' });
  if (req.file && !/^image\//i.test(req.file.mimetype || '')) return res.status(400).json({ error: 'Support attachments must be images' });
  if (text.length > 2000) return res.status(400).json({ error: 'Reply is too long' });
  const latest = await SupportMessage.findOne({ userId: req.params.userId }).sort({ createdAt: -1 }).select('conversationStatus');
  if (latest?.conversationStatus === 'closed') return res.status(409).json({ error: 'Reopen this conversation before replying.' });
  res.json(await SupportMessage.create({ userId: req.params.userId, sender: 'admin', senderName: `${BRAND.name} Support`, text, attachmentUrl, attachmentType: attachmentUrl ? 'image' : '', attachmentName: req.file?.originalname || '', readByAdmin: true }));
 } catch { res.status(500).json({ error: 'Could not send reply' }); }
});
app.post('/api/admin/support/live/:userId/status', anyAdminAuth, async (req, res) => {
 try {
  const status = req.body?.status === 'open' ? 'open' : 'closed';
  const closedAt = status === 'closed' ? new Date() : null;
  await SupportMessage.updateMany({ userId: req.params.userId }, { $set: { conversationStatus: status, closedAt } });
  res.json({ status, closedAt });
 } catch { res.status(500).json({ error: 'Could not update conversation' }); }
});

/**
 * Operations dashboard: unanswered customer chats.
 */
app.get('/api/admin/ops-overview', anyAdminAuth, async (req, res) => {
 try {
  const [unread, waiting, recent] = await Promise.all([
   SupportMessage.countDocuments({ sender: 'user', readByAdmin: false }),
   SupportMessage.distinct('userId', { sender: 'user', readByAdmin: false }),
   SupportMessage.find({ sender: 'user', readByAdmin: false }).sort({ createdAt: -1 }).limit(8)
     .populate('userId', 'name email').lean()
  ]);
  res.json({
   chat: {
    unreadMessages: unread,
    waitingUsers: (waiting || []).length,
    recent: (recent || []).map(m => ({
     name: m.userId?.name || 'User',
     email: m.userId?.email || '',
     text: String(m.text || '').slice(0, 140),
     createdAt: m.createdAt,
     userId: m.userId?._id || m.userId
    }))
   }
  });
 } catch (e) { res.status(500).json({ error: e.message || 'Could not load overview' }); }
});


const SUPPORT_FAQ = [
 { keywords: ['deposit', 'fund', 'top up', 'topup', 'add money', 'add fund'], reply: "To deposit: go to the Deposit page, choose Bank Transfer or Card, enter an amount, and follow the on-screen steps. Funds usually reflect within a minute or two. If a deposit doesn't reflect after 10+ minutes, contact support with your reference." },
 { keywords: ['virtual account', 'account number', 'bank transfer'], reply: "Your virtual account is a one-time bank account number generated just for your deposit — transfer the exact amount shown, from any Nigerian bank, and your wallet updates automatically once it clears." },
 { keywords: ['balance', 'wallet', 'how much do i have', 'my money'], reply: "You can see your current wallet balance at the top of the app, or on your Deposit page — it also shows your total lifetime deposits. It updates instantly after every purchase, deposit, or refund." },
 { keywords: ['refund', 'money back', 'chargeback'], reply: "If an item you purchased doesn't work as described, contact support with your receipt ID (found in Transactions) and the admin team will review it — refunds and replacements are handled case by case." },
 { keywords: ['buy', 'purchase', 'order', 'checkout'], reply: "To buy something: open Marketplace, pick a listing, and confirm the purchase — it's deducted straight from your wallet balance and delivered instantly to your Purchases page." },
 { keywords: ['delivery', 'deliver', 'received', 'where is my'], reply: "Delivery is instant for almost everything — check your Purchases page right after buying. If nothing shows up after a few minutes, contact support with your receipt ID." },
 { keywords: ['referral', 'refer a friend', 'refer', 'commission', 'invite'], reply: "Share your referral link from the Referrals page. You earn a 4% commission automatically whenever someone you referred makes a purchase." },
 { keywords: ['api', 'developer', 'integrate', 'endpoint', 'fetch', 'json'], reply: "Generate an API Key + Secret from Settings API Access, then check the API Docs page (in the menu) for endpoints, JSON responses, and code examples in cURL, JavaScript, and Python." },
 { keywords: ['number', 'otp', 'virtual number', 'buy number', 'sms verification', 'phone verification'], reply: "SMS Numbers gives you a real phone number to receive SMS/OTP codes for verifying accounts. Open the SMS Numbers page, choose your service and country, and the code arrives automatically once the sender sends it — no manual refresh needed. If no code arrives in time, the number is cancelled and refunded automatically." },
 { keywords: ['sms', 'otp not arriving', 'code not coming', 'no code'], reply: "Codes usually arrive within a minute or two of the sender texting the number — the order screen updates automatically, no need to refresh. If nothing arrives before your order times out, it's cancelled automatically and you're not charged." },
 { keywords: ['badge', 'achievement', 'unlock'], reply: "Badges are earned automatically as you use the platform — spending and referring friends all count. Check the Referrals or Home page to see which ones you've unlocked." },
 { keywords: ['password', 'login', 'forgot', 'can\'t sign in', 'cant sign in'], reply: "Use the 'Forgot Password' link on the Login page to reset it via email. If you're still stuck, contact support directly." },
 { keywords: ['restrict', 'blocked', 'suspend', 'banned'], reply: "If your account was restricted, it's usually tied to a security check (e.g. signup details). Contact support with your account email and the team will review it." },
 { keywords: ['fee', 'charge', 'extra cost'], reply: "A small fee may apply on deposits and API-based purchases to cover payment processing — the exact amount is always shown before you confirm." },
 { keywords: ['contact', 'human', 'agent', 'real person', 'talk to someone'], reply: "For anything beyond the basics, tap the Support button (bottom-right, headset icon) — it has Contact Owner, Community, Channel, and Telegram, plus this assistant." }
];
function matchSupportFaq(message) {
 const lower = message.toLowerCase();
 let best = null, bestScore = 0;
 for (const item of SUPPORT_FAQ) {
 const score = item.keywords.reduce((s, k) => s + (lower.includes(k) ? k.length : 0), 0); // longer/more-specific keyword matches score higher
 if (score > bestScore) { best = item; bestScore = score; }
 }
 return best ? best.reply : null;
}
app.post('/api/support/ai-chat', auth, async (req, res) => {
 try {
 const { message } = req.body;
 if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });
 const faqReply = matchSupportFaq(message);
 if (faqReply) return res.json({ reply: faqReply, source: 'faq' });
 res.json({ reply: "I'm not sure about that one — please reach out on WhatsApp support and the team will help you directly.", source: 'fallback' });
 } catch (e) { res.status(500).json({ error: 'Failed to get a reply — please try again.' }); }
});
app.post('/api/admin/verify', (req, res) => {
 safeEqual(req.body && req.body.passcode, process.env.ADMIN_PASSCODE) ? res.json({ success: true }) : res.status(403).json({ error: 'Wrong passcode' });
});
app.get('/api/admin/inventory-breakdown', adminAuth, async (req, res) => {
 try {
 const logs = await Log.find({ available: true });
 const rows = logs.map(l => {
 let unsoldCount, subtotal, priceLabel;
 if (l.type === 'tool') {
 unsoldCount = 1;
 subtotal = l.price || 0;
 priceLabel = `₦${(l.price || 0).toLocaleString('en-NG')} (fixed, tools aren't multiplied by stock)`;
 } else if (l.listingType === 'folder') {
 const unsold = (l.subAccounts || []).filter(sa => !sa.sold);
 unsoldCount = unsold.length;
 subtotal = unsold.reduce((s, sa) => s + (sa.price || 0), 0);
 priceLabel = `${unsoldCount} unsold sub-account(s)`;
 } else {
 unsoldCount = Math.max(0, (l.maxPurchases || 1) - (l.soldCount || 0));
 subtotal = l.price || 0;
 priceLabel = `₦${(l.price || 0).toLocaleString('en-NG')} (${unsoldCount} remaining, counted once)`;
 }
 return { id: l._id, title: l.title, type: l.type, listingType: l.listingType, unsoldCount, subtotal, priceLabel };
 }).filter(r => r.subtotal > 0).sort((a, b) => b.subtotal - a.subtotal);
 res.json(rows);
 } catch (e) { res.status(500).json({ error: 'Failed to load breakdown: ' + e.message }); }
});
app.get('/api/admin/logs', adminAuth, async (req, res) => {
 res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma', 'no-cache');
 res.set('Expires', '0');
 const logs = await Log.find().sort({ createdAt: -1 });
 if (req.query.includeSold === '1') return res.json(logs); // full history, including old sold sub-accounts
 const withStaleSoldStripped = logs.map(l => {
 if (l.listingType !== 'folder') return l;
 const obj = l.toObject();
 obj.subAccounts = stripStaleSoldSubAccounts(obj.subAccounts);
 return obj;
 });
 res.json(withStaleSoldStripped);
});
app.post('/api/admin/logs/clean-sold', adminAuth, async (req, res) => {
 try {
 const folderLogs = await Log.find({ listingType: 'folder', 'subAccounts.sold': true });
 let logsAffected = 0, subAccountsRemoved = 0;
 for (const log of folderLogs) {
 const before = log.subAccounts.length;
 log.subAccounts = log.subAccounts.filter(sa => !sa.sold);
 const removed = before - log.subAccounts.length;
 if (removed > 0) {
 await log.save();
 logsAffected++;
 subAccountsRemoved += removed;
 }
 }
 res.json({ logsAffected, subAccountsRemoved });
 } catch (e) { res.status(500).json({ error: 'Cleanup failed: ' + e.message }); }
});
function heuristicSplitLogs(text) {
 const raw = String(text).replace(/\r\n/g, '\n');
 let blocks = raw.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
 if (blocks.length > 1) return blocks;
 const numberedSplit = raw.split(/\n(?=\s*(?:\d{1,3}[\.\)]|account\s*\d{1,3}\s*[:.\)])\s*)/i)
 .map(b => b.trim()).filter(Boolean);
 if (numberedSplit.length > 1) return numberedSplit;
 const lines = raw.split('\n');
 const counts = {};
 lines.forEach(l => {
 const key = l.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 12);
 if (key.length >= 3) counts[key] = (counts[key] || 0) + 1;
 });
 const anchorKey = Object.keys(counts).find(k => counts[k] >= 2 && counts[k] <= 200);
 if (anchorKey) {
 const anchorIndexes = [];
 lines.forEach((l, i) => {
 const key = l.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 12);
 if (key === anchorKey) anchorIndexes.push(i);
 });
 if (anchorIndexes.length > 1) {
 const chunks = [];
 for (let i = 0; i < anchorIndexes.length; i++) {
 const start = anchorIndexes[i];
 const end = i + 1 < anchorIndexes.length ? anchorIndexes[i + 1] : lines.length;
 const chunk = lines.slice(start, end).join('\n').trim();
 if (chunk) chunks.push(chunk);
 }
 if (chunks.length > 1) return chunks;
 }
 }
 return raw.trim() ? [raw.trim()] : [];
}
app.post('/api/admin/ai-split-logs', adminAuth, async (req, res) => {
 try {
 const { text } = req.body;
 if (!text || !String(text).trim()) return res.status(400).json({ error: 'Paste the raw logs text first' });
 const accounts = heuristicSplitLogs(text);
 if (!accounts.length) return res.status(400).json({ error: 'Could not detect any account entries in this text — check the paste and try again.' });
 if (accounts.length === 1) {
 return res.json({ accounts, note: 'Only detected 1 entry — if you pasted multiple accounts, try separating each one with a blank line for reliable splitting.' });
 }
 res.json({ accounts });
 } catch (e) {
 console.error('Split logs error:', e.message);
 res.status(500).json({ error: 'Splitting failed: ' + e.message });
 }
});
app.post('/api/admin/logs', adminAuth, uploadLogFields, async (req, res) => {
 try {
 const { title, description, details, toolLink, toolQty, maxPurchases, price, category, type, deliveryType, listingType, subAccounts, adminReviewType, adminReviewContent, adminReviewRating, tutorialType, tutorialLinkUrl } = req.body;
 const isFolder = listingType === 'folder';
 if (!title) return res.status(400).json({ error: 'Title required' });
 if (!isFolder && !price) return res.status(400).json({ error: 'Price required' });
 const picFile = req.files?.picture?.[0];
 const deliverableFile = req.files?.deliverableFile?.[0];
 const reviewFile = req.files?.adminReviewFile?.[0];
 const picture = picFile ? fileUrl(picFile) : null;
 let tutorial = { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' };
 if (tutorialType === 'images') {
 const tutorialImageFiles = req.files?.tutorialImages || [];
 if (!tutorialImageFiles.length) return res.status(400).json({ error: 'Please upload at least one tutorial image' });
 tutorial = { tutorialType: 'images', images: tutorialImageFiles.map(fileUrl), videoUrl: '', linkUrl: '' };
 } else if (tutorialType === 'video') {
 const tutorialVideoFile = req.files?.tutorialVideo?.[0];
 if (!tutorialVideoFile) return res.status(400).json({ error: 'Please upload a tutorial video' });
 tutorial = { tutorialType: 'video', images: [], videoUrl: fileUrl(tutorialVideoFile), linkUrl: '' };
 } else if (tutorialType === 'link') {
 if (!tutorialLinkUrl) return res.status(400).json({ error: 'Please provide a tutorial link' });
 tutorial = { tutorialType: 'link', images: [], videoUrl: '', linkUrl: tutorialLinkUrl };
 }
 let adminReview = { reviewType: 'none', content: '' };
 if (adminReviewType && adminReviewType !== 'none') {
 adminReview.reviewType = adminReviewType;
 if ((adminReviewType === 'image' || adminReviewType === 'video') && reviewFile) adminReview.content = fileUrl(reviewFile);
 else if (adminReviewType === 'text' || adminReviewType === 'link') adminReview.content = adminReviewContent || '';
 if (adminReviewRating) adminReview.rating = parseInt(adminReviewRating);
 }
 const finalDeliveryType = deliveryType === 'file' ? 'file' : 'link';
 if (!isFolder && type === 'tool') {
 if (finalDeliveryType === 'file' && !deliverableFile) return res.status(400).json({ error: 'Please upload the deliverable file' });
 if (finalDeliveryType === 'link' && !toolLink) return res.status(400).json({ error: 'Tool link is required' });
 }
 let parsedSubAccounts = [];
 if (isFolder) {
 try { parsedSubAccounts = subAccounts ? JSON.parse(subAccounts) : []; } catch { return res.status(400).json({ error: 'Invalid sub-accounts data' }); }
 if (!parsedSubAccounts.length) return res.status(400).json({ error: 'A folder needs at least one sub-account' });
 parsedSubAccounts = parsedSubAccounts.map((sa, idx) => {
 let saAdminReview = { reviewType: 'none', content: '' };
 if (sa.adminReviewType && sa.adminReviewType !== 'none') {
 saAdminReview.reviewType = sa.adminReviewType;
 const saReviewFile = req.files?.[`subReviewFile_${idx}`]?.[0];
 if ((sa.adminReviewType === 'image' || sa.adminReviewType === 'video') && saReviewFile) saAdminReview.content = fileUrl(saReviewFile);
 else if (sa.adminReviewType === 'text' || sa.adminReviewType === 'link') saAdminReview.content = sa.adminReviewContent || '';
 if (sa.adminReviewRating) saAdminReview.rating = parseInt(sa.adminReviewRating);
 }
 let saTutorial = { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' };
 if (sa.tutorialType && sa.tutorialType !== 'none') {
 saTutorial.tutorialType = sa.tutorialType;
 const saTutFile = req.files?.[`subTutorialFile_${idx}`]?.[0];
 if (sa.tutorialType === 'video' && saTutFile) saTutorial.videoUrl = fileUrl(saTutFile);
 else if (sa.tutorialType === 'images' && saTutFile) saTutorial.images = [fileUrl(saTutFile)];
 else if (sa.tutorialType === 'link') saTutorial.linkUrl = sa.tutorialLinkUrl || '';
 }
 return {
 label: sa.label || 'Account', details: sa.details || '', toolLink: sa.toolLink || '',
 deliveryType: sa.deliveryType === 'file' ? 'file' : 'link',
 price: parseFloat(sa.price) || 0, picture: sa.picture || '',
 adminReview: saAdminReview, tutorial: saTutorial
 };
 });
 if (parsedSubAccounts.some(sa => !sa.price)) return res.status(400).json({ error: 'Every sub-account needs a price' });
 { const blankIdx = parsedSubAccounts.findIndex(sa => !subHasCredentials(sa));
   if (blankIdx !== -1) return res.status(400).json({ error: `"${parsedSubAccounts[blankIdx].label}" has no login details. Paste its credentials in the Details box before saving.` }); }
 }
 const log = await Log.create({
 type: type || 'log', listingType: isFolder ? 'folder' : 'simple',
 title, description: description || '', details: isFolder ? '' : (details || ''),
 toolLink: isFolder ? '' : (toolLink || ''),
 deliveryType: finalDeliveryType,
 deliverableFile: isFolder ? '' : (deliverableFile ? fileUrl(deliverableFile) : ''),
 deliverableFileName: isFolder ? '' : (deliverableFile ? deliverableFile.originalname : ''),
 toolQty: parseInt(toolQty) || 0, maxPurchases: parseInt(maxPurchases) || 1,
 price: isFolder ? undefined : parseFloat(price),
 subAccounts: isFolder ? parsedSubAccounts : [],
 category: category || 'General', picture,
 adminReview, tutorial
 });
 res.json(log);
 } catch (e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
});
app.put('/api/admin/logs/:id', adminAuth, uploadLogFields, async (req, res) => {
 try {
 const { title, description, details, toolLink, toolQty, maxPurchases, price, category, type, available, deliveryType, subAccounts, adminReviewType, adminReviewContent, adminReviewRating, clearAdminReview, tutorialType, tutorialLinkUrl, clearTutorial } = req.body;
 const existing = await Log.findById(req.params.id);
 if (!existing) return res.status(404).json({ error: 'Not found' });
 const update = { title, description, category, type: type || 'log', available: available === 'true' };
 if (existing.listingType !== 'folder') {
 update.details = details; update.toolLink = toolLink;
 update.toolQty = parseInt(toolQty) || 0; update.maxPurchases = parseInt(maxPurchases) || 1;
 update.price = parseFloat(price);
 } else if (subAccounts) {
 try {
 const incoming = JSON.parse(subAccounts);
 update.subAccounts = incoming.map((sa, idx) => {
 let saAdminReview = sa.adminReview || { reviewType: 'none', content: '' };
 if (sa.clearAdminReview) {
 saAdminReview = { reviewType: 'none', content: '' };
 } else if (sa.adminReviewType && sa.adminReviewType !== 'none') {
 saAdminReview = { reviewType: sa.adminReviewType };
 const saReviewFile = req.files?.[`subReviewFile_${idx}`]?.[0];
 if ((sa.adminReviewType === 'image' || sa.adminReviewType === 'video') && saReviewFile) saAdminReview.content = fileUrl(saReviewFile);
 else if (sa.adminReviewType === 'image' || sa.adminReviewType === 'video') saAdminReview.content = (sa.adminReview && sa.adminReview.content) || '';
 else saAdminReview.content = sa.adminReviewContent || '';
 if (sa.adminReviewRating) saAdminReview.rating = parseInt(sa.adminReviewRating);
 }
 let saTutorial = sa.tutorial || { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' };
 if (sa.clearTutorial) {
 saTutorial = { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' };
 } else if (sa.tutorialType && sa.tutorialType !== 'none') {
 saTutorial = { tutorialType: sa.tutorialType, images: [], videoUrl: '', linkUrl: '' };
 const saTutFile = req.files?.[`subTutorialFile_${idx}`]?.[0];
 if (sa.tutorialType === 'video') saTutorial.videoUrl = saTutFile ? fileUrl(saTutFile) : (sa.tutorial?.videoUrl || '');
 else if (sa.tutorialType === 'images') saTutorial.images = saTutFile ? [fileUrl(saTutFile)] : (sa.tutorial?.images || []);
 else if (sa.tutorialType === 'link') saTutorial.linkUrl = sa.tutorialLinkUrl || '';
 }
 return {
 _id: sa._id, label: sa.label || 'Account', details: sa.details || '', toolLink: sa.toolLink || '',
 deliverableFile: (existing.subAccounts.id(sa._id) || {}).deliverableFile || '', deliverableFileName: (existing.subAccounts.id(sa._id) || {}).deliverableFileName || '',
 deliveryType: sa.deliveryType === 'file' ? 'file' : 'link',
 price: parseFloat(sa.price) || 0, picture: sa.picture || '',
 sold: !!sa.sold, soldTo: sa.soldTo, soldAt: sa.soldAt, reviews: sa.reviews || [],
 adminReview: saAdminReview, tutorial: saTutorial
 };
 });
 const blank = update.subAccounts.find(sa => !sa.sold && !subHasCredentials(sa));
 if (blank) return res.status(400).json({ error: `"${blank.label}" has no login details. Paste its credentials in the Details box before saving.` });
 } catch { return res.status(400).json({ error: 'Invalid sub-accounts data' }); }
 }
 if (deliveryType) update.deliveryType = deliveryType === 'file' ? 'file' : 'link';
 const picFile = req.files?.picture?.[0];
 const deliverableFile = req.files?.deliverableFile?.[0];
 const reviewFile = req.files?.adminReviewFile?.[0];
 if (picFile) update.picture = fileUrl(picFile);
 if (deliverableFile) {
 update.deliverableFile = fileUrl(deliverableFile);
 update.deliverableFileName = deliverableFile.originalname;
 }
 if (clearAdminReview === 'true') {
 update.adminReview = { reviewType: 'none', content: '' };
 } else if (adminReviewType && adminReviewType !== 'none') {
 const ar = { reviewType: adminReviewType };
 if ((adminReviewType === 'image' || adminReviewType === 'video') && reviewFile) ar.content = fileUrl(reviewFile);
 else if (adminReviewType === 'image' || adminReviewType === 'video') ar.content = existing.adminReview?.content || '';
 else ar.content = adminReviewContent || '';
 if (adminReviewRating) ar.rating = parseInt(adminReviewRating);
 update.adminReview = ar;
 }
 if (clearTutorial === 'true') {
 update.tutorial = { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' };
 } else if (tutorialType === 'images') {
 const tutorialImageFiles = req.files?.tutorialImages || [];
 if (tutorialImageFiles.length) update.tutorial = { tutorialType: 'images', images: tutorialImageFiles.map(fileUrl), videoUrl: '', linkUrl: '' };
 } else if (tutorialType === 'video') {
 const tutorialVideoFile = req.files?.tutorialVideo?.[0];
 if (tutorialVideoFile) update.tutorial = { tutorialType: 'video', images: [], videoUrl: fileUrl(tutorialVideoFile), linkUrl: '' };
 } else if (tutorialType === 'link' && tutorialLinkUrl) {
 update.tutorial = { tutorialType: 'link', images: [], videoUrl: '', linkUrl: tutorialLinkUrl };
 }
 const log = await Log.findByIdAndUpdate(req.params.id, update, { new: true });
 if (!log) return res.status(404).json({ error: 'Not found' });
 res.json(log);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/logs/:id', adminAuth, async (req, res) => { await Log.findByIdAndDelete(req.params.id); res.json({ message: 'Deleted' }); });
app.delete('/api/admin/logs/:id/tutorial', adminAuth, async (req, res) => {
 const log = await Log.findByIdAndUpdate(
 req.params.id,
 { tutorial: { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '' } },
 { new: true }
 );
 if (!log) return res.status(404).json({ error: 'Not found' });
 res.json({ message: 'Tutorial removed', log });
});
app.get('/api/admin/users', adminAuth, async (req, res) => {
 const { search, limit } = req.query;
 const filter = search
 ? { $or: [
 { name: new RegExp(search, 'i') },
 { email: new RegExp(search, 'i') },
 { contactPhone: new RegExp(search, 'i') },
 { 'virtualAccount.accountNumber': new RegExp(search, 'i') }
 ] }
 : {};
 const query = User.find(filter).select('-password -apiSecret').sort({ createdAt: -1 });
 if (limit) query.limit(Math.min(Number(limit) || 50, 200));
 res.json(await query);
});
// Heartbeat — the browser pings this while a page is open so someone reading
// the site (rather than clicking API-backed buttons) still counts as online.
app.post('/api/heartbeat', auth, async (req, res) => {
 try {
 await User.updateOne({ _id: req.user._id }, { $set: { lastActiveAt: new Date(), lastSeen: new Date() } });
 res.json({ ok: true, at: new Date() });
 } catch (e) {
 console.error('[RSH] heartbeat failed:', e.message);
 res.status(500).json({ error: e.message });
 }
});
app.get('/api/admin/active-users', adminAuth, async (req, res) => {
 try {
 const since = activitySince();
 // Older accounts predate the lastActiveAt field, so also accept lastSeen.
 // Without this an account created before that field existed could deposit,
 // be credited and still never appear in the "online" list.
 const users = await User.find({ $or: [{ lastActiveAt: { $gte: since } }, { lastSeen: { $gte: since } }] })
 .select('name email profilePicture lastActiveAt lastSeen balance country contactPhone virtualAccount createdAt')
 .sort({ lastActiveAt: -1, lastSeen: -1 })
 .lean();
 const rows = users.map(u => ({ ...u, lastActiveAt: u.lastActiveAt || u.lastSeen }));
 console.log(`[RSH] Admin active-users: ${rows.length} online in last ${ACTIVITY_WINDOW_HOURS}h`);
 res.json(rows);
 } catch (e) {
 console.error('[RSH] active-users failed:', e.message);
 res.status(500).json({ error: 'Failed to load active users' });
 }
});
app.get('/api/active-users', optionalAuth, async (req, res) => {
 try {
 const since = activitySince();
 const users = await User.find({ $or: [{ lastActiveAt: { $gte: since } }, { lastSeen: { $gte: since } }] })
 .select('name profilePicture lastActiveAt lastSeen')
 .sort({ lastActiveAt: -1 })
 .limit(50);
 res.json({ count: users.length, users });
 } catch (e) { res.status(500).json({ error: 'Failed to load active users' }); }
});
app.post('/api/admin/credit', adminAuth, async (req, res) => {
 try {
 const { userId, amount, reason } = req.body;
 if (!userId) return res.status(400).json({ error: 'User ID required' });
 const parsed = parseFloat(amount);
 if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Valid amount required' });
 // Atomic $inc — reading the balance and saving it back could wipe out a
 // deposit or purchase that landed in the same second, which is how a credit
 // can look like it "did not reflect" on the customer's side.
 const user = await User.findByIdAndUpdate(userId, { $inc: { balance: parsed } }, { new: true });
 if (!user) return res.status(404).json({ error: 'User not found' });
 await Transaction.create({ userId: user._id, type: 'admin_credit', amount: parsed, description: reason || 'Admin manual credit', status: 'success' });
 pushBalanceToUser(user._id, user.balance, parsed);
 console.log(`[RSH] Admin credited ₦${parsed} to ${user.email} — new balance ₦${user.balance}`);
 res.json({ success: true, message: ` Credited ₦${parsed.toLocaleString('en-NG')} to ${user.name}`, newBalance: user.balance, userName: user.name, userEmail: user.email });
 } catch (e) { res.status(500).json({ error: 'Credit failed: ' + e.message }); }
});
app.post('/api/admin/deduct', adminAuth, async (req, res) => {
 try {
 const { userId, amount, reason } = req.body;
 if (!userId) return res.status(400).json({ error: 'User ID required' });
 const parsed = parseFloat(amount);
 if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Valid amount required' });
 // Deduct FULL requested amount using atomic $inc — balance CAN go negative.
 // Example: balance ₦3500, deduct ₦5000 → balance becomes -₦1500 (displayed in red).
 // This mirrors how credit works and lets admin accurately record any amount.
 const user = await User.findByIdAndUpdate(userId, { $inc: { balance: -parsed } }, { new: true });
 if (!user) return res.status(404).json({ error: 'User not found' });
 await Transaction.create({ userId: user._id, type: 'admin_debit', amount: parsed, description: reason || 'Admin manual deduction', status: 'success' });
 pushBalanceToUser(user._id, user.balance);
 const balLabel = user.balance < 0 ? `-₦${Math.abs(user.balance).toLocaleString('en-NG')}` : `₦${user.balance.toLocaleString('en-NG')}`;
 console.log(`[RSH] Admin deducted ₦${parsed} from ${user.email} — new balance ${balLabel}`);
 res.json({ success: true, message: `✅ Deducted ₦${parsed.toLocaleString('en-NG')} from ${user.name} — new balance: ${balLabel}`, newBalance: user.balance, userName: user.name, userEmail: user.email });
 } catch (e) { res.status(500).json({ error: 'Deduction failed: ' + e.message }); }
});
function getWeekBounds(date = new Date()) {
 const d = new Date(date);
 const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
 const diffToMonday = day === 0 ? -6 : 1 - day; // if Sunday, Monday was 6 days ago
 const monday = new Date(d);
 monday.setHours(0, 0, 0, 0);
 monday.setDate(d.getDate() + diffToMonday);
 const nextMonday = new Date(monday);
 nextMonday.setDate(monday.getDate() + 7);
 const weekKey = monday.toISOString().slice(0, 10);
 return { start: monday, end: nextMonday, weekKey };
}
app.get('/api/admin/weekly-top-buyer', adminAuth, async (req, res) => {
 try {
 let start, end, weekKey;
 if (req.query.weekKey) {
 start = new Date(req.query.weekKey + 'T00:00:00.000Z');
 end = new Date(start); end.setDate(start.getDate() + 7);
 weekKey = req.query.weekKey;
 } else {
 ({ start, end, weekKey } = getWeekBounds());
 }
 const purchases = await Transaction.aggregate([
 { $match: { type: 'purchase', status: 'success', createdAt: { $gte: start, $lt: end } } },
 { $group: { _id: '$userId', purchaseCount: { $sum: 1 } } },
 { $sort: { purchaseCount: -1 } },
 { $limit: 10 }
 ]);
 const userIds = purchases.map(p => p._id);
 const users = await User.find({ _id: { $in: userIds } }).select('name email');
 const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
 const leaderboard = purchases.map(p => ({
 userId: p._id, purchaseCount: p.purchaseCount,
 name: userMap[String(p._id)]?.name || 'Unknown', email: userMap[String(p._id)]?.email || ''
 }));
 const alreadyPaid = await WeeklyReward.findOne({ weekKey });
 res.json({ weekKey, weekStart: start, weekEnd: end, leaderboard, alreadyPaid: alreadyPaid || null });
 } catch (e) { res.status(500).json({ error: 'Failed to load weekly leaderboard: ' + e.message }); }
});
app.post('/api/admin/weekly-top-buyer/pay', adminAuth, async (req, res) => {
 try {
 const { weekKey, userId, amount } = req.body;
 if (!weekKey || !userId) return res.status(400).json({ error: 'weekKey and userId are required' });
 const existing = await WeeklyReward.findOne({ weekKey });
 if (existing) return res.status(409).json({ error: `Week ${weekKey} was already paid out to ${existing.winnerName}.` });
 const user = await User.findById(userId);
 if (!user) return res.status(404).json({ error: 'User not found' });
 const rewardAmount = parseFloat(amount) || 50;
 const { start, end } = getWeekBounds(new Date(weekKey + 'T00:00:00.000Z'));
 const purchaseCount = await Transaction.countDocuments({ userId, type: 'purchase', status: 'success', createdAt: { $gte: start, $lt: end } });
 await User.updateOne({ _id: user._id }, { $inc: { balance: rewardAmount } });
 user.balance = (user.balance || 0) + rewardAmount; // (display value only)
 await Transaction.create({ userId: user._id, type: 'admin_credit', amount: rewardAmount, description: ` Weekly top buyer reward (week of ${weekKey})`, status: 'success' });
 await WeeklyReward.create({ weekKey, winnerId: user._id, winnerName: user.name, purchaseCount, amount: rewardAmount });
 res.json({ success: true, message: ` Awarded ₦${rewardAmount} to ${user.name} for week of ${weekKey}!`, newBalance: user.balance });
 } catch (e) {
 if (e.code === 11000) return res.status(409).json({ error: 'This week was already paid out (race condition caught).' });
 res.status(500).json({ error: 'Failed to pay weekly reward: ' + e.message });
 }
});
app.put('/api/admin/users/:id/restrict', adminAuth, async (req, res) => {
 try {
 const { restricted, reason } = req.body;
 const update = { restricted: !!restricted };
 if (restricted) { update.restrictedReason = reason || 'Restricted by admin'; update.restrictedAt = new Date(); }
 else { update.restrictedReason = ''; update.restrictedAt = null; }
 const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password -apiSecret');
 if (!user) return res.status(404).json({ error: 'User not found' });
 res.json({ success: true, user, message: restricted ? ` ${user.name} has been restricted` : ` ${user.name} has been unrestricted` });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/security/suspicious-emails', anyAdminAuth, async (req, res) => {
 try {
 const users = await User.find({ restricted: { $ne: true } }).select('name email createdAt referredBy balance');
 const suspicious = users.filter(u => isBlockedEmailDomain(u.email));
 res.json(suspicious);
 } catch (e) { res.status(500).json({ error: 'Failed to scan for suspicious emails' }); }
});
app.get('/api/admin/security/referral-clusters', anyAdminAuth, async (req, res) => {
 try {
 const CLUSTER_THRESHOLD = 3; // 3+ referred accounts sharing one signup IP is flagged
 const rows = await User.aggregate([
 { $match: { referredBy: { $ne: null }, signupIp: { $nin: [null, ''] } } },
 { $group: { _id: { referredBy: '$referredBy', ip: '$signupIp' }, count: { $sum: 1 }, users: { $push: { id: '$_id', name: '$name', email: '$email', createdAt: '$createdAt' } } } },
 { $match: { count: { $gte: CLUSTER_THRESHOLD } } },
 { $sort: { count: -1 } }
 ]);
 const referrerIds = rows.map(r => r._id.referredBy);
 const referrers = await User.find({ _id: { $in: referrerIds } }).select('name email restricted');
 const referrerMap = Object.fromEntries(referrers.map(r => [r._id.toString(), r]));
 res.json(rows.map(r => ({
 referrer: referrerMap[r._id.referredBy.toString()] || null,
 signupIp: r._id.ip,
 count: r.count,
 users: r.users
 })));
 } catch (e) { res.status(500).json({ error: 'Failed to scan for referral clusters' }); }
});
app.post('/api/admin/security/bulk-restrict', anyAdminAuth, async (req, res) => {
 try {
 const { userIds, reason } = req.body;
 if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds array is required' });
 const result = await User.updateMany(
 { _id: { $in: userIds } },
 { restricted: true, restrictedReason: reason || 'Referral/signup abuse detected', restrictedAt: new Date() }
 );
 res.json({ message: `Restricted ${result.modifiedCount} account(s)` });
 } catch (e) { res.status(500).json({ error: 'Bulk restrict failed: ' + e.message }); }
});
async function permanentlyDeleteUsers(userIds) {
 await Promise.all([
 Transaction.deleteMany({ userId: { $in: userIds } }),
 ReferralEarning.deleteMany({ $or: [{ referrerId: { $in: userIds } }, { referredUserId: { $in: userIds } }] }),
 UserBadge.deleteMany({ userId: { $in: userIds } })
 ]);
 const result = await User.deleteMany({ _id: { $in: userIds } });
 return result.deletedCount;
}
app.post('/api/admin/security/delete-users', adminAuth, async (req, res) => {
 try {
 const { userIds } = req.body;
 if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: 'userIds array is required' });
 const deletedCount = await permanentlyDeleteUsers(userIds);
 res.json({ message: `Permanently deleted ${deletedCount} account(s)` });
 } catch (e) { res.status(500).json({ error: 'Delete failed: ' + e.message }); }
});
app.post('/api/admin/security/purge-suspicious-emails', adminAuth, async (req, res) => {
 try {
 const users = await User.find({}).select('_id email');
 const toDelete = users.filter(u => isBlockedEmailDomain(u.email)).map(u => u._id);
 if (!toDelete.length) return res.json({ message: 'No suspicious accounts found — nothing to delete.', deletedCount: 0 });
 const deletedCount = await permanentlyDeleteUsers(toDelete);
 res.json({ message: `Permanently deleted ${deletedCount} account(s) using fake/disposable email domains`, deletedCount });
 } catch (e) { res.status(500).json({ error: 'Purge failed: ' + e.message }); }
});
app.get('/api/admin/users/:id/logins', adminAuth, async (req, res) => {
 const user = await User.findById(req.params.id).select('name email lastLoginAt lastLoginIp lastLoginUserAgent loginHistory');
 if (!user) return res.status(404).json({ error: 'User not found' });
 res.json(user);
});
app.get('/api/admin/receipts', anyAdminAuth, async (req, res) => {
 const receipts = await Receipt.find({ status: 'pending' }).populate('userId', 'name email').sort({ createdAt: -1 });
 res.json(receipts);
});
app.get('/api/admin/receipts/all', anyAdminAuth, async (req, res) => {
 const receipts = await Receipt.find().populate('userId', 'name email').sort({ createdAt: -1 }).limit(200);
 res.json(receipts);
});
app.post('/api/admin/receipts/:id/action', anyAdminAuth, async (req, res) => {
 try {
 const { action, note } = req.body;
 if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
 if (action === 'approved') {
 // Check BEFORE claiming so a bad amount can never leave a receipt stuck as "approved" without a credit.
 const pre = await Receipt.findOne({ _id: req.params.id, status: 'pending' }).select('claimedAmount');
 if (!pre) return res.status(400).json({ error: 'Receipt not found or already processed' });
 const preAmt = Number(pre.claimedAmount);
 if (!Number.isFinite(preAmt) || preAmt <= 0) return res.status(400).json({ error: 'Invalid receipt amount' });
 }
 // atomic claim: only ONE request can move a receipt out of "pending" (stops double-credit on double-click / replay)
 const receipt = await Receipt.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: action, adminNote: note || '', seenByUser: false } }, { new: true });
 if (!receipt) return res.status(400).json({ error: 'Receipt not found or already processed' });
 if (action === 'approved') {
 const amt = Number(receipt.claimedAmount);
 if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid receipt amount' });
 const user = await User.findByIdAndUpdate(receipt.userId, { $inc: { balance: amt } }, { new: true });
 if (user) {
 await Transaction.create({ userId: user._id, type: 'deposit', amount: receipt.claimedAmount, description: `Manual deposit approved by admin via ${receipt.claimedBank}`, status: 'success' });
 }
 }
 res.json({ message: `Receipt ${action} successfully` });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/system-errors', anyAdminAuth, async (req, res) => {
 const errors = await SystemError.find().sort({ createdAt: -1 }).limit(100);
 res.json(errors);
});
app.put('/api/admin/system-errors/:id/resolve', anyAdminAuth, async (req, res) => {
 await SystemError.findByIdAndUpdate(req.params.id, { resolved: true });
 res.json({ message: 'Marked resolved' });
});
app.get('/api/admin/ads', adminAuth, async (req, res) => res.json(await Ad.find().sort({ createdAt: -1 })));
app.post('/api/admin/ads', adminAuth, upload.single('image'), async (req, res) => {
 try {
 const { title, link } = req.body;
 if (!link) return res.status(400).json({ error: 'Ad link is required' });
 const imageUrl = req.file ? fileUrl(req.file) : (req.body.imageUrl || '');
 const ad = await Ad.create({ title: title || '', link, imageUrl });
 res.json(ad);
 } catch (e) { res.status(500).json({ error: 'Failed to create ad: ' + e.message }); }
});
app.put('/api/admin/ads/:id', adminAuth, upload.single('image'), async (req, res) => {
 try {
 const { title, link, active } = req.body;
 const update = { title, link };
 if (active !== undefined) update.active = active === 'true';
 if (req.file) update.imageUrl = fileUrl(req.file);
 const ad = await Ad.findByIdAndUpdate(req.params.id, update, { new: true });
 if (!ad) return res.status(404).json({ error: 'Ad not found' });
 res.json(ad);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/ads/:id', adminAuth, async (req, res) => { await Ad.findByIdAndDelete(req.params.id); res.json({ message: 'Ad removed' }); });
app.get('/api/deposit-tutorials', optionalAuth, async (req, res) => {
 try {
 const docs = await DepositTutorial.find({});
 const byMethod = {};
 docs.forEach(d => { byMethod[d.method] = { videoUrl: d.videoUrl, imageUrls: d.imageUrls, caption: d.caption }; });
 res.json(byMethod);
 } catch (e) { res.status(500).json({ error: 'Failed to load tutorials' }); }
});
app.get('/api/config/cloudinary', (req, res) => {
 res.json({
 cloudName: cloudinaryConfigured ? process.env.CLOUDINARY_CLOUD_NAME : null,
 uploadPreset: process.env.CLOUDINARY_UNSIGNED_PRESET || null,
 configured: cloudinaryConfigured && !!process.env.CLOUDINARY_UNSIGNED_PRESET
 });
});
app.post('/api/admin/deposit-tutorials/:method', adminAuth, depositTutorialUpload, async (req, res) => {
 try {
 const { method } = req.params;
 if (!['paymentlink'].includes(method)) return res.status(400).json({ error: 'Invalid method' });
 const update = { method, updatedAt: new Date() };
 if (req.body.caption !== undefined) update.caption = req.body.caption;
 if (req.body.videoUrl) update.videoUrl = req.body.videoUrl;
 else if (req.files?.video?.[0]) update.videoUrl = fileUrl(req.files.video[0]);
 if (req.files?.images?.length) update.imageUrls = req.files.images.map(fileUrl);
 const doc = await DepositTutorial.findOneAndUpdate({ method }, update, { upsert: true, new: true });
 res.json(doc);
 } catch (e) { res.status(500).json({ error: 'Failed to save tutorial: ' + e.message }); }
});
app.delete('/api/admin/deposit-tutorials/:method', adminAuth, async (req, res) => {
 try {
 const { method } = req.params;
 await DepositTutorial.findOneAndUpdate({ method }, { videoUrl: '', imageUrls: [], caption: '' }, { upsert: true });
 res.json({ message: 'Tutorial cleared' });
 } catch (e) { res.status(500).json({ error: 'Failed to clear tutorial' }); }
});
app.get('/api/badges', optionalAuth, async (req, res) => {
 try { res.json(await Badge.find({ enabled: true }).sort({ createdAt: 1 })); }
 catch (e) { res.status(500).json({ error: 'Failed to load badges' }); }
});
app.get('/api/badges/mine', auth, async (req, res) => {
 try {
 const earned = await UserBadge.find({ userId: req.user._id }).populate('badgeId');
 res.json(earned.filter(e => e.badgeId).map(e => ({ ...e.badgeId.toObject(), awardedAt: e.awardedAt })));
 } catch (e) { res.status(500).json({ error: 'Failed to load your badges' }); }
});
app.get('/api/badges/user/:userId', optionalAuth, async (req, res) => {
 try {
 const earned = await UserBadge.find({ userId: req.params.userId }).populate('badgeId');
 res.json(earned.filter(e => e.badgeId && e.badgeId.enabled).map(e => ({ name: e.badgeId.name, icon: e.badgeId.icon })));
 } catch (e) { res.status(500).json({ error: 'Failed to load badges' }); }
});
app.get('/api/admin/badges', anyAdminAuth, async (req, res) => {
 try { res.json(await Badge.find({}).sort({ createdAt: -1 })); }
 catch (e) { res.status(500).json({ error: 'Failed to load badges' }); }
});
app.post('/api/admin/badges', anyAdminAuth, async (req, res) => {
 try {
 const { name, icon, description, criteriaType, criteriaValue } = req.body;
 if (!name) return res.status(400).json({ error: 'name is required' });
 const badge = await Badge.create({
 name: name.trim(), icon: icon || '', description: description || '',
 criteriaType: criteriaType || 'manual', criteriaValue: Number(criteriaValue) || 0
 });
 res.json(badge);
 } catch (e) { res.status(500).json({ error: 'Failed to create badge: ' + e.message }); }
});
app.put('/api/admin/badges/:id', anyAdminAuth, async (req, res) => {
 try {
 const { name, icon, description, criteriaType, criteriaValue, enabled } = req.body;
 const update = {};
 if (name !== undefined) update.name = name.trim();
 if (icon !== undefined) update.icon = icon;
 if (description !== undefined) update.description = description;
 if (criteriaType !== undefined) update.criteriaType = criteriaType;
 if (criteriaValue !== undefined) update.criteriaValue = Number(criteriaValue);
 if (enabled !== undefined) update.enabled = !!enabled;
 const badge = await Badge.findByIdAndUpdate(req.params.id, update, { new: true });
 if (!badge) return res.status(404).json({ error: 'Not found' });
 res.json(badge);
 } catch (e) { res.status(500).json({ error: 'Failed to update badge' }); }
});
app.delete('/api/admin/badges/:id', anyAdminAuth, async (req, res) => {
 try {
 await Badge.findByIdAndDelete(req.params.id);
 await UserBadge.deleteMany({ badgeId: req.params.id });
 res.json({ message: 'Deleted' });
 } catch (e) { res.status(500).json({ error: 'Failed to delete badge' }); }
});
app.post('/api/admin/badges/:id/award', anyAdminAuth, async (req, res) => {
 try {
 const { email } = req.body;
 if (!email) return res.status(400).json({ error: 'email is required' });
 const user = await User.findOne({ email: email.trim().toLowerCase() });
 if (!user) return res.status(404).json({ error: 'No user found with that email' });
 await UserBadge.findOneAndUpdate({ userId: user._id, badgeId: req.params.id }, { userId: user._id, badgeId: req.params.id }, { upsert: true });
 res.json({ message: `Awarded to ${user.name}` });
 } catch (e) { res.status(500).json({ error: 'Failed to award badge: ' + e.message }); }
});
app.post('/api/admin/badges/:id/revoke', anyAdminAuth, async (req, res) => {
 try {
 const { email } = req.body;
 if (!email) return res.status(400).json({ error: 'email is required' });
 const user = await User.findOne({ email: email.trim().toLowerCase() });
 if (!user) return res.status(404).json({ error: 'No user found with that email' });
 await UserBadge.deleteOne({ userId: user._id, badgeId: req.params.id });
 res.json({ message: `Revoked from ${user.name}` });
 } catch (e) { res.status(500).json({ error: 'Failed to revoke badge: ' + e.message }); }
});
app.get('/api/deposit/payment-methods', optionalAuth, async (req, res) => {
 try {
 const [docs, vaSettings] = await Promise.all([
 PaymentMethodSetting.find({}),
 getVASettings()
 ]);
 const byMethod = {
 paymentlink: { enabled: true, disabledMessage: '' },
 virtualaccount: { enabled: vaSettings.globalEnabled, disabledMessage: vaSettings.globalEnabled ? '' : 'Virtual accounts are temporarily unavailable. Please use Payment Link instead.' }
 };
 docs.forEach(d => { byMethod[d.method] = { enabled: d.enabled, disabledMessage: d.disabledMessage || '' }; });
 byMethod.virtualaccount = { enabled: vaSettings.globalEnabled, disabledMessage: vaSettings.globalEnabled ? '' : 'Virtual accounts are temporarily unavailable. Please use Payment Link instead.' };
 // Country gate: outside Nigeria only the payment link exists, priced in USD.
 const geo = await rshGeo.resolveCountry(req, req.user || null);
 const isNg = rshFlwMethods.supportsVirtualAccount(geo.code);
 if (!isNg) {
 byMethod.virtualaccount = { enabled: false, disabledMessage: 'Virtual accounts are available in Nigeria only. Use the payment link — it is priced in US dollars.' };
 byMethod.banktransfer = { enabled: false, disabledMessage: 'Bank transfer deposits are available in Nigeria only.' };
 }
 byMethod.country = geo.code;
 byMethod.payCurrency = rshCountries.payCurrencyFor(geo.code);
 byMethod.methods = isNg ? ['virtualaccount', 'paymentlink'] : ['paymentlink'];
 byMethod.checkoutMethods = rshFlwMethods.describeFor(geo.code);
 // Gateways the customer can choose between for the payment link.
 const gw = await getGatewayStates();
 const payCur = rshCountries.payCurrencyFor(geo.code);
 byMethod.gateways = {
  flutterwave: { enabled: gw.flutterwave.enabled, available: gw.flutterwave.available, disabledMessage: gw.flutterwave.disabledMessage },
  paystack: { enabled: gw.paystack.enabled, available: gw.paystack.available && paystackSupportsCurrency(payCur), disabledMessage: gw.paystack.disabledMessage },
  korapay: { enabled: gw.korapay.enabled, available: gw.korapay.available && rshKorapay.supportsCurrency(payCur), disabledMessage: gw.korapay.disabledMessage }
 };
 byMethod.defaultGateway = byMethod.gateways.flutterwave.available ? 'flutterwave' : (byMethod.gateways.paystack.available ? 'paystack' : (byMethod.gateways.korapay.available ? 'korapay' : ''));
 // Virtual accounts can be issued by Flutterwave or Paystack — a gateway that is switched off stops issuing them.
 byMethod.vaGateways = { flutterwave: gw.flutterwave.enabled, paystack: gw.paystack.available };
 if (!byMethod.vaGateways.flutterwave && !byMethod.vaGateways.paystack) {
  byMethod.virtualaccount = { enabled: false, disabledMessage: gw.flutterwave.disabledMessage || gw.paystack.disabledMessage || 'Bank transfer is temporarily unavailable. Please use Payment Link instead.' };
 }
 if (!gw.flutterwave.enabled) {
  byMethod.banktransfer = { enabled: false, disabledMessage: gw.flutterwave.disabledMessage || 'Bank transfer is temporarily unavailable. Please use Payment Link instead.' };
 }
 res.json(byMethod);
 } catch (e) { res.status(500).json({ error: 'Failed to load payment method settings' }); }
});
// Where is this visitor? Public on purpose: the browser needs it before login so
// public/js/money.js can pick the display currency (naira inside Nigeria, US
// dollars everywhere else) on the very first paint. Returns nothing but a
// two-letter country code and the currency that follows from it.
app.get('/api/public/geo', async (req, res) => {
 res.set('Cache-Control', 'no-store');
 try {
  const geo = await rshGeo.resolveCountry(req, req.user || null);
  res.json({ country: geo.code, source: geo.source, currency: geo.code === 'NG' ? 'NGN' : 'USD' });
 } catch (e) {
  res.json({ country: 'NG', source: 'default', currency: 'NGN' });
 }
});
app.get('/api/public/site-links', async (req, res) => {
 res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
 res.set('Pragma', 'no-cache');
 res.set('Expires', '0');
 try {
 const links = await getSiteLinks();
 const tgUser = String(links.telegramUsername || '').replace(/^@/, '');
   const tgLink = links.telegramLink || ('https://t.me/' + tgUser);
   res.json({ whatsappNumber: links.whatsappNumber, adminPhone: links.adminPhone || links.whatsappNumber, whatsappGroupLink: links.whatsappGroupLink, whatsappChannelLink: links.whatsappChannelLink, telegramUsername: tgUser, telegramLink: tgLink, telegramChannelLink: links.telegramChannelLink || '', telegramCommunityLink: links.telegramCommunityLink || '', whatsappChatLink: links.whatsappChatLink || ('https://wa.me/' + links.whatsappNumber), supportHours: links.supportHours || '', logoUrl: links.logoUrl || '' });
 } catch (e) { res.status(500).json({ error: 'Failed to load site links' }); }
});
app.get('/api/admin/site-links', anyAdminAuth, async (req, res) => {
 try { res.json(await getSiteLinks()); } catch (e) { res.status(500).json({ error: 'Failed to load site links' }); }
});
app.post('/api/admin/site-links', anyAdminAuth, async (req, res) => {
 try {
 const { whatsappNumber, adminPhone, whatsappGroupLink, whatsappChannelLink , telegramUsername, telegramLink, telegramChannelLink, telegramCommunityLink, whatsappChatLink, supportHours } = req.body;
 const isPlaceholder = v => { const x = String(v == null ? '' : v).trim(); return x === '' || x === '#'; };
 const update = { updatedAt: new Date() };
 if (whatsappNumber !== undefined) {
 const cleaned = String(whatsappNumber).replace(/[^\d]/g, '');
 if (cleaned.length < 10) return res.status(400).json({ error: 'WhatsApp number must be at least 10 digits' });
 update.whatsappNumber = cleaned;
 process.env.ADMIN_WHATSAPP = cleaned;
 }
 if (adminPhone !== undefined) {
 const cleaned = String(adminPhone).replace(/[^\d]/g, '');
 if (cleaned.length < 10) return res.status(400).json({ error: 'Admin phone must be at least 10 digits' });
 update.adminPhone = cleaned;
 }
 if (whatsappGroupLink !== undefined) {
 const link = String(whatsappGroupLink).trim();
 if (!isPlaceholder(link) && !link.startsWith('https://')) return res.status(400).json({ error: 'Group link must start with https://' });
 update.whatsappGroupLink = link;
 }
 if (whatsappChannelLink !== undefined) {
 const link = String(whatsappChannelLink).trim();
 if (!isPlaceholder(link) && !link.startsWith('https://')) return res.status(400).json({ error: 'Channel link must start with https://' });
 update.whatsappChannelLink = link;
 }
  // NOTE: telegramUsername is treated as the source of truth. It's processed
  // AFTER telegramLink on purpose: the admin UI always submits both fields
  // together (the link input is pre-filled from the last saved value and only
  // labeled "auto-filled" — it doesn't actually track the username input live),
  // so if telegramLink were applied last it could silently overwrite a fresh
  // username change with the stale link that was sitting in that field.
  if (telegramLink !== undefined && !isPlaceholder(telegramLink)) {
   const link = String(telegramLink).trim();
   if (!/^https:\/\//.test(link)) return res.status(400).json({ error: 'Telegram link must start with https://' });
   update.telegramLink = link;
  }
  if (telegramUsername !== undefined) {
   const u = String(telegramUsername).trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
   if (u && !/^[A-Za-z0-9_]{4,32}$/.test(u)) return res.status(400).json({ error: 'Telegram username must be 4-32 letters, numbers or underscores' });
   update.telegramUsername = u;
   if (u) update.telegramLink = 'https://t.me/' + u;
  }
  if (whatsappChatLink !== undefined) {
   const link = String(whatsappChatLink).trim();
   if (!isPlaceholder(link) && !/^https:\/\//.test(link)) return res.status(400).json({ error: 'WhatsApp link must start with https://' });
   update.whatsappChatLink = link;
  }
  if (supportHours !== undefined) update.supportHours = String(supportHours).trim().slice(0, 120);
 const doc = await SiteLinks.findByIdAndUpdate('main', { $set: update }, { upsert: true, new: true });
 console.log(`[admin] site-links updated:`, JSON.stringify(update));
 res.json({ ok: true, whatsappNumber: doc.whatsappNumber, adminPhone: doc.adminPhone || doc.whatsappNumber, whatsappGroupLink: doc.whatsappGroupLink, whatsappChannelLink: doc.whatsappChannelLink, telegramUsername: doc.telegramUsername, telegramLink: doc.telegramLink, telegramChannelLink: doc.telegramChannelLink || '', telegramCommunityLink: doc.telegramCommunityLink || '', whatsappChatLink: doc.whatsappChatLink, supportHours: doc.supportHours });
 } catch (e) { res.status(500).json({ error: 'Failed to update site links: ' + e.message }); }
});
const brandLogoUpload = multer({
 storage: makeStorage('uploads', 'image'),
 limits: { fileSize: 3 * 1024 * 1024 },
 fileFilter: (req, file, cb) => {
  const extensions = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] };
  const allowed = extensions[file.mimetype];
  if (!allowed || !allowed.includes(path.extname(file.originalname).toLowerCase())) return cb(new Error('Use a PNG, JPEG, or WebP image.'));
  cb(null, true);
 }
});
app.post('/api/admin/brand-logo', adminAuth, (req, res, next) => {
 brandLogoUpload.single('image')(req, res, err => {
  if (err) return res.status(400).json({ error: err.message || 'Could not upload the logo.' });
  next();
 });
}, async (req, res) => {
 try {
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPEG, or WebP logo image.' });
  const logoUrl = fileUrl(req.file);
  if (!logoUrl) return res.status(500).json({ error: 'The logo upload did not return a usable image URL.' });
  await SiteLinks.findByIdAndUpdate('main', { $set: { logoUrl, updatedAt: new Date() } }, { upsert: true, new: true });
  res.json({ ok: true, logoUrl });
 } catch (e) {
  console.error('[admin] brand logo update failed:', e.name);
  res.status(500).json({ error: 'Could not save the site logo.' });
 }
});
app.delete('/api/admin/brand-logo', adminAuth, async (req, res) => {
 try {
  await SiteLinks.findByIdAndUpdate('main', { $set: { logoUrl: '', updatedAt: new Date() } }, { upsert: true, new: true });
  res.json({ ok: true, logoUrl: '' });
 } catch (e) {
  console.error('[admin] brand logo removal failed:', e.name);
  res.status(500).json({ error: 'Could not remove the site logo.' });
 }
});
app.get('/api/admin/payment-methods', anyAdminAuth, async (req, res) => {
 try {
 const docs = await PaymentMethodSetting.find({});
 const byMethod = { paymentlink: { enabled: true, disabledMessage: '' } };
 docs.forEach(d => { byMethod[d.method] = { enabled: d.enabled, disabledMessage: d.disabledMessage || '' }; });
 res.json(byMethod);
 } catch (e) { res.status(500).json({ error: 'Failed to load payment method settings' }); }
});
app.post('/api/admin/payment-methods/:method', adminAuth, async (req, res) => {
 try {
 const { method } = req.params;
 if (!['paymentlink'].includes(method)) return res.status(400).json({ error: 'Invalid method' });
 const { enabled, disabledMessage } = req.body;
 const update = { method, updatedAt: new Date() };
 if (enabled !== undefined) update.enabled = !!enabled;
 if (disabledMessage !== undefined) update.disabledMessage = disabledMessage;
 const doc = await PaymentMethodSetting.findOneAndUpdate({ method }, update, { upsert: true, new: true });
 res.json(doc);
 } catch (e) { res.status(500).json({ error: 'Failed to update payment method: ' + e.message }); }
});
app.get('/api/admin/payment-gateways', anyAdminAuth, async (req, res) => {
 try {
  const states = await getGatewayStates();
  const site = (process.env.SITE_URL || '').replace(/\/$/, '');
  res.json({
   ...states,
   paystackUsdEnabled: String(process.env.PAYSTACK_ALLOW_USD || '').toLowerCase() === 'true',
   webhookUrls: { flutterwave: `${site}/api/webhooks/flutterwave`, paystack: `${site}/api/webhooks/paystack`, korapay: `${site}/api/webhooks/korapay` }
  });
 } catch (e) { res.status(500).json({ error: 'Failed to load payment gateways' }); }
});
app.post('/api/admin/payment-gateways/:gateway', adminAuth, async (req, res) => {
 try {
  const { gateway } = req.params;
  if (!GATEWAY_LIST.includes(gateway)) return res.status(400).json({ error: 'Invalid gateway' });
  const { enabled, disabledMessage } = req.body;
  const update = { gateway, updatedAt: new Date() };
  if (enabled !== undefined) {
   if (enabled && !gatewayConfigured(gateway)) {
    const keyName = gateway === 'paystack' ? 'PAYSTACK_SECRET_KEY' : (gateway === 'korapay' ? 'KORAPAY_SECRET_KEY' : 'FLW_V3_SECRET_KEY');
    return res.status(400).json({ error: `${GATEWAY_LABELS[gateway]} cannot be switched on yet — ${keyName} is not set on the server.` });
   }
   update.enabled = !!enabled;
  }
  if (disabledMessage !== undefined) update.disabledMessage = String(disabledMessage).slice(0, 300);
  await GatewaySetting.findOneAndUpdate({ gateway }, update, { upsert: true, new: true });
  console.log(`[admin] payment gateway ${gateway} updated:`, JSON.stringify(update));
  res.json({ ok: true, gateways: await getGatewayStates() });
 } catch (e) { res.status(500).json({ error: 'Failed to update payment gateway: ' + e.message }); }
});
app.get('/api/admin/giveaways', adminAuth, async (req, res) => {
 res.json(await Giveaway.find().sort({ createdAt: -1 }));
});
app.post('/api/admin/giveaways', adminAuth, upload.single('image'), async (req, res) => {
 try {
 const { title, description, category, credentials, startsInMinutes } = req.body;
 if (!title || !credentials) return res.status(400).json({ error: 'Title and credentials are required' });
 const imageUrl = req.file ? fileUrl(req.file) : (req.body.imageUrl || '');
 const minutes = parseFloat(startsInMinutes) || 0;
 const startsAt = new Date(Date.now() + Math.max(0, minutes) * 60 * 1000);
 const giveaway = await Giveaway.create({ title, description: description || '', category: category || '', credentials, imageUrl, startsAt });
 res.json(giveaway);
 } catch (e) { res.status(500).json({ error: 'Failed to create giveaway: ' + e.message }); }
});
app.delete('/api/admin/giveaways/:id', adminAuth, async (req, res) => {
 await Giveaway.findByIdAndDelete(req.params.id);
 res.json({ message: 'Giveaway removed' });
});
app.get('/api/giveaways', optionalAuth, async (req, res) => {
 const all = await Giveaway.find().sort({ createdAt: -1 }).limit(100);
 res.json(all.map(g => ({
 _id: g._id, title: g.title, description: g.description, category: g.category,
 imageUrl: g.imageUrl, status: g.status, startsAt: g.startsAt, winnerName: g.winnerName,
 winnerProfilePicture: g.winnerProfilePicture, claimedAt: g.claimedAt, createdAt: g.createdAt
 })));
});
app.post('/api/giveaways/:id/claim', auth, async (req, res) => {
 try {
 const giveaway = await Giveaway.findById(req.params.id);
 if (!giveaway) return res.status(404).json({ error: 'Giveaway not found' });
 if (giveaway.startsAt && giveaway.startsAt.getTime() > Date.now()) {
 return res.status(403).json({ error: 'This giveaway hasn\'t started yet — hang tight!', startsAt: giveaway.startsAt });
 }
 const user = await User.findById(req.user._id);
 const won = await Giveaway.findOneAndUpdate(
 { _id: req.params.id, status: 'active', startsAt: { $lte: new Date() } },
 { status: 'claimed', winnerId: user._id, winnerName: user.name, winnerProfilePicture: user.profilePicture || '', claimedAt: new Date() },
 { new: true }
 );
 if (!won) return res.status(409).json({ error: 'Too slow! Someone already claimed this giveaway.' });
 res.json({ message: ' You won!', credentials: won.credentials, title: won.title });
 } catch (e) { res.status(500).json({ error: 'Failed to claim giveaway: ' + e.message }); }
});
app.get('/api/admin/visits', adminAuth, async (req, res) => {
 const stats = await VisitorStats.findOne({ key: 'global' });
 res.json({ visitors: stats?.visitors || 0 });
});
async function computeInventoryValue() {
 const logs = await Log.find({ available: true });
 let logsValue = 0, toolsValue = 0;
 for (const l of logs) {
 if (l.type === 'tool') {
 toolsValue += (l.price || 0);
 } else if (l.listingType === 'folder') {
 logsValue += (l.subAccounts || []).filter(sa => !sa.sold).reduce((s, sa) => s + (sa.price || 0), 0);
 } else {
 logsValue += (l.price || 0);
 }
 }
 return { logsValue, toolsValue };
}
app.get('/api/admin/system-errors', adminAuth, async (req, res) => {
 const errors = await SystemError.find({ resolved: false }).sort({ createdAt: -1 }).limit(100);
 res.json(errors);
});
app.put('/api/admin/system-errors/:id/resolve', adminAuth, async (req, res) => {
 const err = await SystemError.findByIdAndUpdate(req.params.id, { resolved: true }, { new: true });
 if (!err) return res.status(404).json({ error: 'Not found' });
 res.json(err);
});
app.get('/api/admin/support', anyAdminAuth, async (req, res) => res.json(await Support.find().sort({ createdAt: -1 })));
app.put('/api/admin/support/:id', anyAdminAuth, async (req, res) => { const t = await Support.findByIdAndUpdate(req.params.id, { adminReply: req.body.reply, status: 'resolved', seenByUser: false }, { new: true }); res.json(t); });
app.get('/api/admin/transactions', adminAuth, async (req, res) => res.json(await Transaction.find().populate('userId', 'name email').sort({ createdAt: -1 }).limit(200)));
const SITE_ORIGIN = process.env.SITE_URL || '';
app.get(`/${process.env.ADMIN_SECRET_PATH || 'rsh-admin-secret'}`, (req, res) => {
  // No caching: admins were seeing an old admin.html
  // served from the browser/proxy cache after a deploy.
  res.set('Cache-Control', 'no-store, must-revalidate');
  (res.set('Cache-Control', 'no-store, must-revalidate'), res.sendFile(path.join(__dirname, 'public', 'admin.html')));
});
// Direct /admin.html hits must not be cached either.
app.get('/admin.html', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  (res.set('Cache-Control', 'no-store, must-revalidate'), res.sendFile(path.join(__dirname, 'public', 'admin.html')));
});
app.get('/virtual-account', (req, res) => res.redirect(301, '/deposit'));
// Legacy bill/VTU paths (airtime, data, cable TV, electricity, betting) were removed.
// Kept as permanent redirects so old links and bookmarks land on the homepage.
app.get(['/services', '/airtime', '/data', '/cable', '/electricity', '/betting', '/data-bill'], (req, res) => res.redirect(301, '/'));
app.get('/api-docs', (req, res) => res.redirect(302, '/dashboard'));
app.get('/apidocs', (req, res) => res.redirect(302, '/dashboard'));
// NOTE: the SPA catch-all used to live here, which silently shadowed EVERY route
// registered further down this file (global payments, wallet, countries, the
// operations layer). Those endpoints answered with index.html instead of JSON,
// which is why the wallet said "undefined is not an object" and the deposit
// page rendered blank. It is now mounted at the very bottom, after every route.
const sseClients = new Map(); // userId (string) Set<res>
app.get('/api/user/events', auth, (req, res) => {
 res.setHeader('Content-Type', 'text/event-stream');
 res.setHeader('Cache-Control', 'no-cache');
 res.setHeader('Connection', 'keep-alive');
 res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering for Render/Railway
 res.flushHeaders();
 const userId = String(req.user._id);
 if (!sseClients.has(userId)) sseClients.set(userId, new Set());
 sseClients.get(userId).add(res);
 const keepAlive = setInterval(() => {
 try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
 }, 25000);
 req.on('close', () => {
 clearInterval(keepAlive);
 sseClients.get(userId)?.delete(res);
 if (!sseClients.get(userId)?.size) sseClients.delete(userId);
 });
 User.findById(req.user._id).select('balance').then(u => {
 if (u) res.write(`event: balance\ndata: ${JSON.stringify({ balance: u.balance || 0 })}\n\n`);
 }).catch(() => {});
});
function pushBalanceToUser(userId, newBalance, creditAmount = null) {
 const clients = sseClients.get(String(userId));
 if (!clients || !clients.size) return;
 const payload = { balance: newBalance, source: 'virtual_account' };
 if (creditAmount !== null && creditAmount > 0) payload.creditAmount = creditAmount;
 const msg = `event: balance\ndata: ${JSON.stringify(payload)}\n\n`;
 for (const res of clients) {
 try { res.write(msg); } catch { clients.delete(res); }
 }
}
// ═══ AUTOMATIC PENDING DEPOSITS RECONCILIATION ═══════════════════════════
// Continuously checks all pending deposits (Payment Links, Virtual Accounts, and Bank Transfers)
// against Flutterwave so users do NOT stay stuck in pending and do NOT require admin manual acceptance.
// Also marks failed/cancelled/refunded payments so they never credit the user balance.
let _pendingCheckRunning = false;
async function checkAllPendingFlutterwaveDeposits() {
  if (_pendingCheckRunning) return;
  _pendingCheckRunning = true;
  try {
    if (!process.env.FLW_V3_SECRET_KEY) return;
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // 1. Check all pending PaymentLinkDeposit records
    const pendingPLs = await PaymentLinkDeposit.find({
      status: 'pending',
      gateway: { $nin: ['paystack', 'korapay'] },
      createdAt: { $gte: since48h }
    }).limit(60);

    for (const dep of pendingPLs) {
      try {
        const verify = await flwAxios.get('/transactions/verify_by_reference', {
          params: { tx_ref: dep.txRef },
          timeout: 10000
        });
        const tx = verify.data?.data;
        if (tx) {
          const txStatus = String(tx.status || '').trim().toLowerCase();
          if (txStatus === 'successful' || txStatus === 'completed') {
            const expectedCurrency = String(dep.currency || 'NGN').toUpperCase();
            const gotCurrency = String(tx.currency || 'NGN').toUpperCase();
            const receivedAmt = Number(tx.charged_amount || tx.amount || 0);
            if (gotCurrency === expectedCurrency && receivedAmt >= (dep.amount * 0.98)) {
              console.log(`[Auto-Reconcile] Pending PaymentLink ${dep.txRef} succeeded on Flutterwave! Crediting user...`);
              await creditPaymentLinkDeposit(dep, tx);
            }
          } else if (txStatus === 'failed' || txStatus === 'cancelled') {
            console.log(`[Auto-Reconcile] Pending PaymentLink ${dep.txRef} failed on Flutterwave. Marking as failed.`);
            await PaymentLinkDeposit.updateOne(
              { _id: dep._id, status: 'pending' },
              { $set: { status: 'failed', rawPayload: tx } }
            );
          }
        }
      } catch (err) {
        if (err.response?.status === 404 && (Date.now() - new Date(dep.createdAt).getTime() > 24 * 60 * 60 * 1000)) {
          await PaymentLinkDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed', failureReason: 'expired_unpaid' } });
        }
      }
    }

    // 2. Check pending BankTransferDeposit records
    const pendingBTs = await BankTransferDeposit.find({
      status: 'pending',
      createdAt: { $gte: since48h }
    }).limit(50);

    for (const dep of pendingBTs) {
      try {
        const verify = await flwAxios.get('/transactions/verify_by_reference', {
          params: { tx_ref: dep.reference },
          timeout: 10000
        });
        const tx = verify.data?.data;
        if (tx) {
          const txStatus = String(tx.status || '').trim().toLowerCase();
          if (txStatus === 'successful' || txStatus === 'completed') {
            const claimed = await BankTransferDeposit.findOneAndUpdate(
              { _id: dep._id, status: 'pending' },
              { status: 'success', flwChargeId: String(tx.flw_ref || tx.id || '') },
              { new: true }
            );
            if (claimed) {
              const u = await User.findByIdAndUpdate(claimed.userId, { $inc: { balance: claimed.creditAmount } }, { new: true });
              await Transaction.create({
                userId: claimed.userId,
                type: 'deposit',
                amount: claimed.creditAmount,
                txRef: chargeKey(tx),
                description: `VA bank transfer deposit — ₦${claimed.creditAmount.toLocaleString('en-NG')} credited (auto-check) via ${claimed.bankName || 'bank transfer'}`,
                status: 'success'
              });
              if (u) pushBalanceToUser(claimed.userId, u.balance, claimed.creditAmount);
              console.log(`[Auto-Reconcile] Bank transfer ${dep.reference} confirmed and credited!`);
            }
          } else if (txStatus === 'failed' || txStatus === 'cancelled') {
            await BankTransferDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed' } });
          }
        }
      } catch (err) {
        if (dep.expiresAt && new Date() > dep.expiresAt) {
          await BankTransferDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'expired' } });
        }
      }
    }

    // 3. Check pending VirtualAccountDeposit records
    const pendingVAs = await VirtualAccountDeposit.find({
      status: 'pending',
      createdAt: { $gte: since48h }
    }).limit(50);

    for (const dep of pendingVAs) {
      try {
        const user = await User.findById(dep.userId);
        if (!user) continue;
        const out = await handleVaWebhookCredit(user, dep.rawPayload || { flw_ref: dep.flwRef, id: dep.flwTxId, amount: dep.amount, currency: 'NGN', status: 'successful' });
        if (out?.status === 'credited') {
          console.log(`[Auto-Reconcile] VirtualAccount deposit ${dep.flwRef} confirmed and credited!`);
        }
      } catch (err) {
        console.warn(`[Auto-Reconcile] Error checking VA deposit ${dep.flwRef}:`, err.message);
      }
    }
  } catch (e) {
    console.error('[Auto-Reconcile] checkAllPendingDeposits error:', e.message);
  } finally {
    _pendingCheckRunning = false;
  }
}

let _vaReconcileRunning = false;
async function reconcileVADeposits() {
 // Overlapping runs used to race each other (and the webhook) on the same
 // charge. One run at a time, always.
 if (_vaReconcileRunning) { console.log('[VA-reconcile] previous run still going — skipping this tick'); return; }
 _vaReconcileRunning = true;
 try {
 const settings = await getVASettings().catch(() => ({ globalEnabled: true }));
 if (!settings.globalEnabled) return;
 const from = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24 h
 const fromStr = from.toISOString().slice(0, 10);
 const toStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
 let page = 1, found = 0;
 while (page <= 5) { // cap at 5 pages (500 tx) to stay fast
 const res = await flwAxios.get('/transactions', {
 params: { from: fromStr, to: toStr, status: 'successful', currency: 'NGN', page, per_page: 100 },
 timeout: 12000
 });
 const list = res.data?.data || [];
 if (!list.length) break;
 for (const tx of list) {
 const isVA = tx.payment_type === 'account'
 || (tx.meta?.source || '').toLowerCase().includes('virtual')
 || tx.virtual_account_number;
 if (!isVA) continue;
 const flwRef = chargeKey(tx);
 if (!flwRef) continue;
 try {
 const already = await VirtualAccountDeposit.findOne({ flwRef }).select('_id');
 if (already) continue; // already credited
 if (await chargeBelongsToOtherChannel(tx)) continue; // payment link / bank transfer money
 let user = null;
 const vaNum = tx.virtual_account_number || tx.meta?.account_number || tx.meta?.accountNumber || tx.meta?.destinationAccountNumber;
 if (vaNum) user = await User.findOne({ 'virtualAccount.accountNumber': vaNum });
 if (!user) {
 const custEmail = (tx.customer?.email || '').trim().toLowerCase();
 // e-mail match is only accepted for a genuine virtual-account charge
 if (custEmail && (tx.payment_type === 'account' || tx.virtual_account_number)) {
 user = await User.findOne({ email: custEmail });
 }
 }
 if (!user || !user.virtualAccount?.enabled) continue;
 console.log(`[VA-reconcile] Crediting missed tx ${flwRef} for ${user.email} ₦${tx.amount}`);
 const out = await handleVaWebhookCredit(user, tx);
 if (out?.status === 'credited') found++;
 } catch (txErr) {
 // One bad charge must never abort the whole sweep.
 console.warn('[VA-reconcile] tx', flwRef, 'error:', txErr.message);
 }
 }
 if (list.length < 100) break; // last page
 page++;
 }
 if (found) console.log(`[VA-reconcile] Caught and credited ${found} missed VA payment(s)`);
 else console.log(`[VA-reconcile] No missed payments found`);
 } catch (e) {
 console.error('[VA-reconcile] error:', e.response?.data || e.message);
 } finally {
 _vaReconcileRunning = false;
 }
}
// Paystack pending deposits: verify each one with Paystack and credit / fail it — independent of
// Flutterwave's keys, so a Paystack-only setup still self-heals when a webhook is missed.
let _pendingPsCheckRunning = false;
async function checkPendingPaystackDeposits() {
  if (_pendingPsCheckRunning || !process.env.PAYSTACK_SECRET_KEY) return;
  _pendingPsCheckRunning = true;
  try {
    const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const pending = await PaymentLinkDeposit.find({ status: 'pending', gateway: 'paystack', createdAt: { $gte: since48h } }).limit(60);
    for (const dep of pending) {
      try {
        const tx = await paystackVerify(dep.txRef);
        if (paystackTxOk(tx, dep)) {
          console.log(`[Auto-Reconcile] Pending Paystack deposit ${dep.txRef} succeeded! Crediting user...`);
          await creditPaymentLinkDeposit(dep, tx);
        } else if (tx && ['failed', 'reversed'].includes(String(tx.status || '').toLowerCase())) {
          await PaymentLinkDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
        } else if (Date.now() - new Date(dep.createdAt).getTime() > 24 * 60 * 60 * 1000 && (!tx || String(tx.status || '').toLowerCase() === 'abandoned')) {
          await PaymentLinkDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed' } });
        }
      } catch (err) {
        console.warn(`[Auto-Reconcile] Paystack check failed for ${dep.txRef}:`, err.response?.data?.message || err.message);
      }
    }
  } catch (e) {
    console.error('[Auto-Reconcile] checkPendingPaystackDeposits error:', e.message);
  } finally {
    _pendingPsCheckRunning = false;
  }
}
async function checkAllPendingDeposits() {
  await checkAllPendingFlutterwaveDeposits();
  await checkPendingPaystackDeposits();
  await rshKorapay.reconcilePending();
}
setTimeout(() => {
  reconcileVADeposits();
  checkAllPendingDeposits();
  setInterval(reconcileVADeposits, 60 * 1000);
  reconcilePaystackVADeposits();
  setInterval(reconcilePaystackVADeposits, 2 * 60 * 1000);
  setInterval(checkAllPendingDeposits, 30 * 1000);
}, 5000);
// ═══ MACHINE TRANSLATION (whole-site language switch) ═════════════════════
// The phrase table in public/js/i18n.js covers the common UI strings instantly
// and offline. Anything it does not know is sent here in batches, translated
// once, then cached — in memory on the server and in localStorage in the
// browser — so a language switch translates every page, including copy that is
// rendered dynamically by script.js.
const I18N_CACHE = new Map();            // `${lang}\u0000${text}` -> translated
const I18N_MAX_ENTRIES = 20000;

async function translateOne(text, lang) {
  const key = lang + '\u0000' + text;
  if (I18N_CACHE.has(key)) return I18N_CACHE.get(key);
  let out = text;
  try {
    const r = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'en', tl: lang, dt: 't', q: text },
      timeout: 6000
    });
    const parts = (r.data && r.data[0]) || [];
    const joined = parts.map(p => (p && p[0]) || '').join('');
    if (joined.trim()) out = joined;
  } catch (e) { /* offline or rate-limited — fall back to English */ }
  if (I18N_CACHE.size > I18N_MAX_ENTRIES) I18N_CACHE.clear();
  I18N_CACHE.set(key, out);
  return out;
}

app.post('/api/i18n/translate', async (req, res) => {
  try {
    const lang = String(req.body?.lang || '').toLowerCase().slice(0, 5);
    const items = Array.isArray(req.body?.texts) ? req.body.texts : [];
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(lang)) return res.status(400).json({ error: 'Bad language code' });
    if (lang === 'en') return res.json({ lang, translations: {} });
    const texts = items
      .map(t => String(t || '').trim())
      .filter(t => t && t.length <= 400)
      .slice(0, 80);
    const out = {};
    // Small concurrency so one big page never opens 80 sockets at once.
    for (let i = 0; i < texts.length; i += 8) {
      const chunk = texts.slice(i, i + 8);
      const done = await Promise.all(chunk.map(t => translateOne(t, lang)));
      chunk.forEach((t, k) => { out[t] = done[k]; });
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ lang, translations: out });
  } catch (e) {
    res.status(500).json({ error: 'Translation service unavailable' });
  }
});

// ═══ GLOBAL PAYMENTS ══════════════════════════════════════════════════════
// Worldwide country directory, multi-currency quoting and per-user locale. See docs/API.md for the full endpoint reference.
const rshGlobalPay = require('./lib/global-payments')({
  app, express, mongoose, User, Transaction, auth,
  flwV4Axios, getOrCreateFlwCustomer, SystemError
});

// ═══ OPERATIONS LAYER ═════════════════════════════════════════════════════
// Wallet breakdown, admin deposit desk (search /
// manual retry / CSV + PDF export) and the webhook ledger with alerting.

/**
 * Manually re-run the confirmation for a single deposit, from any rail.
 * Always idempotent: a deposit that is already credited is reported as such
 * instead of being credited twice.
 */
async function retryDepositConfirmation(source, id) {
  if (source === 'paymentlink') {
    const dep = await PaymentLinkDeposit.findById(id);
    if (!dep) return { ok: false, message: 'Deposit not found' };
    if (dep.status === 'success') return { ok: true, credited: false, reference: dep.txRef, message: 'Already credited' };
    if (dep.gateway === 'korapay') {
      const result = await rshKorapay.checkAndCredit(dep);
      return { ok: true, credited: result === 'success', creditNgn: dep.creditAmount, reference: dep.txRef, message: 'Confirmation re-run against Kuropay (' + result + ')' };
    }
    if (dep.gateway === 'paystack') {
      const psTx = await paystackVerify(dep.txRef);
      if (!paystackTxOk(psTx, dep)) return { ok: true, credited: false, reference: dep.txRef, message: `Paystack reports status: ${psTx?.status || 'not found'}` };
      await creditPaymentLinkDeposit(dep, psTx);
      const freshPs = await PaymentLinkDeposit.findById(id).lean();
      return { ok: true, credited: freshPs.status === 'success', creditNgn: dep.creditAmount, reference: dep.txRef, message: 'Confirmation re-run against Paystack' };
    }
    const verify = await flwAxios.get('/transactions/verify_by_reference', { params: { tx_ref: dep.txRef }, timeout: 15000 });
    const tx = verify.data?.data;
    if (!tx || tx.status !== 'successful') return { ok: true, credited: false, reference: dep.txRef, message: `Flutterwave reports status: ${tx?.status || 'not found'}` };
    await handlePaymentLinkWebhookCredit(dep, tx);
    const fresh = await PaymentLinkDeposit.findById(id).lean();
    return { ok: true, credited: fresh.status === 'success', creditNgn: dep.creditAmount, reference: dep.txRef, message: 'Confirmation re-run against Flutterwave' };
  }

  if (source === 'banktransfer') {
    const dep = await BankTransferDeposit.findById(id);
    if (!dep) return { ok: false, message: 'Deposit not found' };
    if (dep.status === 'success') return { ok: true, credited: false, reference: dep.reference, message: 'Already credited' };
    const verify = await flwAxios.get('/transactions/verify_by_reference', { params: { tx_ref: dep.reference }, timeout: 15000 });
    const tx = verify.data?.data;
    if (!tx || tx.status !== 'successful') return { ok: true, credited: false, reference: dep.reference, message: `Flutterwave reports status: ${tx?.status || 'not found'}` };
    const claimed = await BankTransferDeposit.findOneAndUpdate({ _id: dep._id, status: 'pending' }, { status: 'success', flwChargeId: String(tx.flw_ref || tx.id || '') }, { new: true });
    if (!claimed) return { ok: true, credited: false, reference: dep.reference, message: 'Another process credited it first' };
    const u = await User.findByIdAndUpdate(claimed.userId, { $inc: { balance: claimed.creditAmount } }, { new: true });
    await Transaction.create({ userId: claimed.userId, type: 'deposit', amount: claimed.creditAmount, description: `VA bank transfer deposit — manual retry (₦${claimed.creditAmount})`, status: 'success' });
    if (u) pushBalanceToUser(claimed.userId, u.balance);
    return { ok: true, credited: true, creditNgn: claimed.creditAmount, reference: claimed.reference, message: 'Credited on manual retry' };
  }

  if (source === 'virtualaccount') {
    const dep = await VirtualAccountDeposit.findById(id);
    if (!dep) return { ok: false, message: 'Deposit not found' };
    if (dep.status === 'success') return { ok: true, credited: false, reference: dep.flwRef, message: 'Already credited' };
    if (dep.gateway === 'paystack') {
      const psOwner = await User.findById(dep.userId);
      if (!psOwner) return { ok: false, message: 'Owner account no longer exists' };
      const psVtx = await paystackVerify(String(dep.flwRef).replace(/^PSK-/, ''));
      if (!psVtx) return { ok: true, credited: false, reference: dep.flwRef, message: 'Paystack has no record of this payment' };
      await handlePaystackVaCredit(psOwner, psVtx);
      const psFresh = await VirtualAccountDeposit.findById(id).lean();
      return { ok: true, credited: psFresh.status === 'success', creditNgn: psFresh.creditAmount, reference: dep.flwRef, message: 'Paystack virtual account credit re-run' };
    }
    const user = await User.findById(dep.userId);
    if (!user) return { ok: false, message: 'Owner account no longer exists' };
    await handleVaWebhookCredit(user, dep.rawPayload || { flw_ref: dep.flwRef, id: dep.flwTxId, amount: dep.amount, currency: 'NGN', status: 'successful' });
    const fresh = await VirtualAccountDeposit.findById(id).lean();
    return { ok: true, credited: fresh.status === 'success', creditNgn: fresh.creditAmount, reference: dep.flwRef, message: 'Virtual account credit re-run' };
  }

  return { ok: false, message: 'Unknown deposit source' };
}

rshPlatform = require('./lib/platform')({
  app, express, mongoose, auth, adminAuth, anyAdminAuth,
  User, Transaction, SystemError,
  VirtualAccountDeposit, PaymentLinkDeposit, BankTransferDeposit,
  retryDeposit: retryDepositConfirmation,
});
rshGlobalPay.setPlatform(rshPlatform);

// ═══ ENGAGEMENT + ACCOUNT SECURITY ════════════════════════════════════════
// Password reset by emailed code, win-back emails for idle customers, daily
// and the logged-in device manager. See lib/engagement.js.
rshEngagement = require('./lib/engagement')({
  app, mongoose, User, Transaction, auth
});

// Email delivery dashboard, welcome emails, admin campaign controls and the
// referral reward that pays both sides on the new customer's first spend.
rshCampaigns = require('./lib/campaigns')({
  app, mongoose, User, Transaction, auth, anyAdminAuth, engagement: rshEngagement
});

// ═══ 404 + SPA FALLBACK — MUST STAY LAST ══════════════════════════════════
// Anything under /api that reached this point genuinely does not exist, so it
// answers with JSON. Registering the HTML fallback ahead of an API route makes
// that route return a web page to fetch(), which is impossible to debug from
// the browser — keep this block at the very end of the file.
// Product logo library admin routes
try {
  require('./lib/rado-upgrade').late(app, { mongoose, anyAdminAuth });
  require('./lib/extras').register({ app, mongoose, User, Transaction, auth, anyAdminAuth, pushBalanceToUser });
} catch (extrasErr) { console.error('[extras] failed to load:', extrasErr.message); }
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});
// Unknown pages: the site is multi-page (public/rado/*), so there is no SPA shell to fall back to.
// Page-like paths go to the login/home page; anything that looks like a file is a plain 404.
app.get('*', (req, res) => {
  if (/\.[a-z0-9]{1,8}$/i.test(req.path || '')) return res.status(404).send('Not found');
  res.redirect(302, '/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(` RSH on :${PORT}`));
