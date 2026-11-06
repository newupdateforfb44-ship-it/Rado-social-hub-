'use strict';
/**
 * Rado Social Hub - Control room (lib/ops.js)
 *
 *  1. Maintenance switch  - close the whole site, or only deposits / orders / SMS numbers, with a message
 *  2. Daily summary email - deposits, sales, orders needing attention, provider balances
 *  3. Payment tools       - per-method min/max deposit limits and a "Test connection" button per gateway
 *  4. Rate limits         - on deposit creation
 *  5. Backup              - owner-only full data download (passwords/secrets removed)
 *
 * Everything here is owner-only (passcode) except the public status endpoint.
 * Customer-facing look is untouched: the only visible change is a slim notice while maintenance is on.
 */
const rateLimit = require('express-rate-limit');
const axios = require('axios');

// ── Route groups for maintenance ─────────────────────────────────────────────
const ORDER_POST = [/^\/api\/logs\/buy(-multi)?\//, /^\/api\/rado\/products\/buy$/, /^\/api\/v1\/buy(-multi)?\//];
const NUMBER_POST = [/^\/api\/rado\/numbers\/buy$/];
const DEPOSIT_POST = [/^\/api\/deposit\/(paymentlink|banktransfer)\/create$/, /^\/api\/intl\/quote$/];
// Never blocked, so money in flight and the admin panel keep working.
const NEVER_BLOCK = [/^\/api\/admin(\/|$)/, /^\/api\/ops\/status$/, /^\/api\/webhooks\//, /^\/api\/deposit\/[a-z]+\/callback/, /^\/api\/client-error-log$/, /^\/api\/deposit\/(paymentlink|banktransfer)\/status\//];

const DEFAULTS = () => ({
  maintenance: { site: false, deposits: false, orders: false, numbers: false, message: '' },
  limits: { paymentlink: { min: 0, max: 0 }, banktransfer: { min: 0, max: 0 } },
  daily: { enabled: false, email: '', hourWat: 21, lastSentDay: '' }
});

function register(deps) {
  const { app, mongoose, User, Transaction, auth, anyAdminAuth, adminAuth, sendAdminEmail } = deps;
  const express = require('express');
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[ops]', e.message); res.status(e.status || 500).json({ error: e.message || 'Request failed' }); } };
  const owner = adminAuth; // passcode only

  const Cfg = mongoose.models.OpsConfig || mongoose.model('OpsConfig', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    maintenance: { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS().maintenance },
    limits: { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS().limits },
    daily: { type: mongoose.Schema.Types.Mixed, default: () => DEFAULTS().daily }
  }, { minimize: false }));

  // In-memory copy so every request can check maintenance without a database round trip.
  let cache = DEFAULTS();
  const merge = doc => {
    const d = DEFAULTS();
    return {
      maintenance: { ...d.maintenance, ...(doc && doc.maintenance) },
      limits: { paymentlink: { ...d.limits.paymentlink, ...((doc && doc.limits || {}).paymentlink) }, banktransfer: { ...d.limits.banktransfer, ...((doc && doc.limits || {}).banktransfer) } },
      daily: { ...d.daily, ...(doc && doc.daily) }
    };
  };
  const refresh = async () => { try { cache = merge(await Cfg.findOne({ key: 'main' }).lean()); } catch (e) { /* keep last good copy */ } };
  const getDoc = async () => (await Cfg.findOne({ key: 'main' })) || (await Cfg.create({ key: 'main' }));
  refresh(); setInterval(refresh, 15000).unref();

  // ── Rate limits (payments) ───────────────────────────────────
  const limiterMsg = m => ({ error: m });
  const depositLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, trustProxy: true,
    message: limiterMsg('Too many deposit attempts. Please wait a few minutes and try again.')
  });
  const purchaseLimiter = rateLimit({
    windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, trustProxy: true,
    message: limiterMsg('Too many purchase requests - please slow down.')
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const p = req.path;
    if (DEPOSIT_POST.some(re => re.test(p))) return depositLimiter(req, res, next);
    if (ORDER_POST.some(re => re.test(p)) || NUMBER_POST.some(re => re.test(p))) return purchaseLimiter(req, res, next);
    next();
  });

  // ── Maintenance + deposit limits ───────────────────────────────────────────
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || NEVER_BLOCK.some(re => re.test(req.path))) return next();
    const m = cache.maintenance;
    const block = scope => res.status(503).json({ error: m.message || 'We are doing a short maintenance. Please try again soon.', maintenance: true, scope });
    if (m.site && req.method !== 'GET' && req.method !== 'HEAD') return block('site');
    if (m.site && /^\/api\/(auth|user|logs|market|rado|deposit|v1)\b/.test(req.path)) return block('site');
    if (req.method === 'POST') {
      if (m.deposits && DEPOSIT_POST.some(re => re.test(req.path))) return block('deposits');
      if (m.orders && ORDER_POST.some(re => re.test(req.path))) return block('orders');
      if (m.numbers && NUMBER_POST.some(re => re.test(req.path))) return block('numbers');
    }
    next();
  });
  app.use(['/api/deposit/paymentlink/create', '/api/deposit/banktransfer/create'], (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = req.path.includes('bank') || req.originalUrl.includes('banktransfer') ? 'banktransfer' : 'paymentlink';
    const lim = cache.limits[key] || {};
    if (!(lim.min > 0 || lim.max > 0)) return next();
    auth(req, res, () => {
      try {
        const cc = require('./countries');
        const country = req.user && req.user.country;
        if (country && typeof cc.payCurrencyFor === 'function' && cc.payCurrencyFor(country) === 'USD') return next(); // limits are in naira
      } catch (e) { /* fall through and check */ }
      const amount = parseFloat(req.body && req.body.amount);
      if (!(amount > 0)) return next(); // the route itself reports a bad amount
      const fmt = n => '₦' + Number(n).toLocaleString('en-NG');
      if (lim.min > 0 && amount < lim.min) return res.status(400).json({ error: `Minimum deposit for this method is ${fmt(lim.min)}.` });
      if (lim.max > 0 && amount > lim.max) return res.status(400).json({ error: `Maximum deposit for this method is ${fmt(lim.max)}.` });
      next();
    });
  });

  app.get('/api/ops/status', (req, res) => {
    const m = cache.maintenance;
    res.set('Cache-Control', 'no-store');
    res.json({ site: !!m.site, deposits: !!m.deposits, orders: !!m.orders, numbers: !!m.numbers, message: m.message || '' });
  });

  // ── Customer: recent deposits with status (read-only) ─────────────────────
  app.get('/api/user/deposit-history', auth, wrap(async (req, res) => {
    const M = n => mongoose.models[n];
    const uid = req.user._id; const rows = [];
    const grab = async (name, label, refField, amtFields) => {
      if (!M(name)) return;
      const docs = await M(name).find({ userId: uid }).sort({ createdAt: -1 }).limit(15).lean();
      docs.forEach(d => rows.push({
        method: label, createdAt: d.createdAt, status: d.status === 'success' || d.status === 'credited' ? 'success' : (['failed', 'cancelled', 'expired'].includes(d.status) ? 'failed' : 'pending'),
        amount: Number(amtFields.map(f => d[f]).find(v => v > 0) || 0), ref: String(d[refField] || '').slice(-8)
      }));
    };
    await Promise.all([
      grab('PaymentLinkDeposit', 'Payment link', 'txRef', ['creditAmount']),
      grab('BankTransferDeposit', 'Bank transfer', 'reference', ['creditAmount']),
      grab('VirtualAccountDeposit', 'Virtual account', 'flwRef', ['creditAmount', 'amount'])
    ]);
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(rows.slice(0, 15));
  }));

  // ── Admin: settings ────────────────────────────────────────────────────────
  app.get('/api/admin/ops/settings', owner, wrap(async (req, res) => {
    await refresh();
    res.json({ ...cache, emailReady: !!process.env.RESEND_API_KEY, defaultEmail: process.env.ADMIN_ALERT_EMAIL || '' });
  }));
  app.put('/api/admin/ops/maintenance', owner, wrap(async (req, res) => {
    const b = req.body || {}; const doc = await getDoc();
    const cur = { ...DEFAULTS().maintenance, ...(doc.maintenance || {}) };
    for (const k of ['site', 'deposits', 'orders', 'numbers']) if (b[k] !== undefined) cur[k] = !!b[k];
    if (b.message !== undefined) cur.message = String(b.message || '').slice(0, 300);
    doc.maintenance = cur; doc.markModified('maintenance'); await doc.save(); await refresh();
    res.json({ ok: true, maintenance: cache.maintenance });
  }));
  app.put('/api/admin/ops/limits', owner, wrap(async (req, res) => {
    const b = req.body || {}; const doc = await getDoc();
    const cur = merge(doc).limits;
    for (const k of ['paymentlink', 'banktransfer']) if (b[k]) {
      const min = Number(b[k].min) || 0, max = Number(b[k].max) || 0;
      if (min < 0 || max < 0) throw Object.assign(new Error('Limits cannot be negative.'), { status: 400 });
      if (min && max && min > max) throw Object.assign(new Error('The minimum cannot be bigger than the maximum.'), { status: 400 });
      cur[k] = { min, max };
    }
    doc.limits = cur; doc.markModified('limits'); await doc.save(); await refresh();
    res.json({ ok: true, limits: cache.limits });
  }));
  app.put('/api/admin/ops/daily', owner, wrap(async (req, res) => {
    const b = req.body || {}; const doc = await getDoc();
    const cur = merge(doc).daily;
    if (b.enabled !== undefined) cur.enabled = !!b.enabled;
    if (b.email !== undefined) {
      const e = String(b.email || '').trim();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
      cur.email = e;
    }
    if (b.hourWat !== undefined) { const h = Math.floor(Number(b.hourWat)); if (!(h >= 0 && h <= 23)) throw Object.assign(new Error('Hour must be 0-23.'), { status: 400 }); cur.hourWat = h; }
    doc.daily = cur; doc.markModified('daily'); await doc.save(); await refresh();
    res.json({ ok: true, daily: cache.daily });
  }));

  // ── Admin: gateway connection test ─────────────────────────────────────────
  const GATEWAYS = {
    flutterwave: { key: 'FLW_V3_SECRET_KEY', url: 'https://api.flutterwave.com/v3/balances', name: 'Flutterwave' },
    paystack:    { key: 'PAYSTACK_SECRET_KEY', url: 'https://api.paystack.co/balance', name: 'Paystack' },
    korapay:     { key: 'KORAPAY_SECRET_KEY', url: (process.env.KORAPAY_BASE_URL || 'https://api.korapay.com/merchant') + '/api/v1/balances', name: 'Kuropay' }
  };
  app.post('/api/admin/ops/test-gateway', owner, wrap(async (req, res) => {
    const g = GATEWAYS[String((req.body || {}).gateway || '')];
    if (!g) throw Object.assign(new Error('Unknown gateway.'), { status: 400 });
    const secret = process.env[g.key];
    if (!secret) return res.json({ ok: false, gateway: g.name, message: `${g.key} is not set on the server.` });
    const t0 = Date.now();
    try {
      const r = await axios.get(g.url, { headers: { Authorization: `Bearer ${secret}` }, timeout: 15000 });
      res.json({ ok: true, gateway: g.name, ms: Date.now() - t0, message: `Connected (${r.status}).` });
    } catch (e) {
      const st = e.response && e.response.status;
      const detail = (e.response && e.response.data && (e.response.data.message || e.response.data.error)) || e.message;
      res.json({ ok: false, gateway: g.name, ms: Date.now() - t0, message: (st ? `HTTP ${st}: ` : '') + String(detail).slice(0, 200) });
    }
  }));

  // ── Admin: backup ──────────────────────────────────────────────────────────
  const SECRET_KEY = /pass|secret|token|apikey|api_key|otp|hash|session|pin$/i;
  app.get('/api/admin/ops/backup', owner, async (req, res) => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="backup-${day}.jsonl"`, 'Cache-Control': 'no-store' });
      for (const name of mongoose.modelNames()) {
        const Model = mongoose.models[name];
        if (!Model || !Model.collection) continue;
        const cursor = Model.find({}).lean().cursor();
        for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
          for (const k of Object.keys(doc)) if (SECRET_KEY.test(k)) delete doc[k];
          res.write(JSON.stringify({ c: name, d: doc }) + '\n');
        }
      }
      res.end();
    } catch (e) {
      console.error('[ops] backup failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed: ' + e.message }); else res.end();
    }
  });
  app.get('/api/admin/ops/backup-info', owner, wrap(async (req, res) => {
    const out = [];
    for (const name of mongoose.modelNames()) { try { out.push({ name, count: await mongoose.models[name].estimatedDocumentCount() }); } catch (e) { /* skip */ } }
    res.json(out.sort((a, b) => b.count - a.count));
  }));

  // ── Daily summary ──────────────────────────────────────────────────────────
  const base = () => `http://127.0.0.1:${process.env.PORT || 3000}`;
  const loop = async path => (await axios.get(base() + path, { headers: { 'x-admin-passcode': process.env.ADMIN_PASSCODE }, timeout: 30000 })).data;
  const naira = n => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
  async function buildSummary() {
    const lines = [];
    const site = (process.env.BRAND_NAME || 'Rado Social Hub');
    lines.push(`${site} - daily summary`, new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' (Nigeria time)', '');
    try {
      const m = (await loop('/api/admin/extras/money')).today || {};
      lines.push('TODAY', `Deposits: ${naira(m.deposits)} (${m.depositCount || 0} payments)`, `Sales: ${naira(m.revenue)}  |  Spent by customers: ${naira(m.spent)}`, `Profit (estimate): ${naira(m.profit)}`, `Refunds: ${naira(m.refunds)}`, '');
    } catch (e) { lines.push('TODAY: could not load money figures (' + e.message + ')', ''); }
    try {
      const s = await loop('/api/admin/extras/stuck');
      const rows = s.rows || [];
      lines.push(`ORDERS NEEDING ATTENTION: ${rows.length}`);
      rows.slice(0, 10).forEach(r => lines.push(` - ${r.title} | ${naira(r.amount)} | ${r.status} | ${r.userEmail || ''} | ${r.reason || ''}`));
      if (rows.length > 10) lines.push(` ...and ${rows.length - 10} more in Business tools.`);
      lines.push('');
    } catch (e) { lines.push('ORDERS NEEDING ATTENTION: could not load (' + e.message + ')', ''); }
    try {
      const p = (await loop('/api/admin/extras/providers')).providers || [];
      lines.push('PROVIDER BALANCES');
      p.forEach(x => lines.push(` - ${x.name}: ${x.balance === null ? (x.error || 'unknown') : (x.unit || '') + Number(x.balance).toLocaleString('en-NG')}${x.low ? '  <-- LOW' : ''}`));
    } catch (e) { lines.push('PROVIDER BALANCES: could not load (' + e.message + ')'); }
    try {
      const since = new Date(Date.now() - 864e5);
      const newUsers = await User.countDocuments({ createdAt: { $gte: since } });
      lines.push('', `New customers (24h): ${newUsers}`);
    } catch (e) { /* optional */ }
    return lines.join('\n');
  }
  async function sendSummary(force) {
    const d = cache.daily;
    const to = d.email || process.env.ADMIN_ALERT_EMAIL || '';
    if (!to) return { sent: false, reason: 'No email set. Add an email address first.' };
    const text = await buildSummary();
    const r = await sendAdminEmail(to, `${process.env.BRAND_NAME || 'Rado Social Hub'} - daily summary`, text);
    return { ...r, preview: text };
  }
  app.post('/api/admin/ops/daily/send-now', owner, wrap(async (req, res) => { const r = await sendSummary(true); res.json({ ok: !!r.sent, ...r }); }));
  app.get('/api/admin/ops/daily/preview', owner, wrap(async (req, res) => res.json({ text: await buildSummary() })));
  setInterval(async () => {
    try {
      const d = cache.daily;
      if (!d.enabled || !process.env.ADMIN_PASSCODE) return;
      const wat = new Date(Date.now() + 3600e3); // WAT = UTC+1
      const day = wat.toISOString().slice(0, 10);
      if (wat.getUTCHours() < d.hourWat || d.lastSentDay === day) return;
      // Claim today's slot atomically so two server instances never send it twice.
      const claim = await Cfg.findOneAndUpdate({ key: 'main', 'daily.lastSentDay': { $ne: day } }, { $set: { 'daily.lastSentDay': day } }, { new: true });
      if (!claim) return;
      const r = await sendSummary(false);
      if (!r.sent) console.error('[ops] daily summary not sent:', r.reason);
      await refresh();
    } catch (e) { console.error('[ops] daily summary error:', e.message); }
  }, 10 * 60 * 1000).unref();

  return {};
}

module.exports = { register };
