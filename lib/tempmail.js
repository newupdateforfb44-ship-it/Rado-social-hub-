// ── Temp Email (OTP emails) — powered by the SMS-COOL API (https://sms-cool.com/api/v1) ─────────────
// Same service the Stevologs site uses: the customer rents an email address for a website, uses it there,
// and the verification code shows up on the page. Paid from the NGN wallet, refunded if no code arrives.
//
// The API key stays on the server. Set SMS_COOL_API_KEY in Render, or paste it in Admin -> Temp Email.
//
// Customer routes                                   Admin routes (admin passcode)
//   GET  /api/rado/tempmail/options                   GET  /api/admin/tempmail/status
//   GET  /api/rado/tempmail/services                  PUT  /api/admin/tempmail/config
//   GET  /api/rado/tempmail/orders                    GET  /api/admin/tempmail/orders
//   POST /api/rado/tempmail/buy                       POST /api/admin/tempmail/orders/:id/refund
//   GET  /api/rado/tempmail/code/:id                  GET  /api/admin/tempmail/balance
//   POST /api/rado/tempmail/cancel/:id
const axios = require('axios');
const crypto = require('crypto');
const fx = require('./fx');

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{1,58})[a-z0-9]$/i;
const CLOSED = ['received', 'cancelled', 'refunded', 'failed'];

function register(app, deps) {
  const { mongoose, User, Transaction, auth } = deps;
  const adminAuth = deps.adminAuth || deps.anyAdminAuth;
  const S = mongoose.Schema;
  let runtimeApiKey = '', runtimeBaseUrl = '';

  // ───────── secrets / config ─────────
  const encKey = () => crypto.createHash('sha256').update(String(process.env.JWT_SECRET || 'provider-config-key')).digest();
  function encryptSecret(v) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv); const out = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return 'v1:' + iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + out.toString('hex'); }
  function decryptSecret(v) { try { const p = String(v || '').split(':'); if (p.length !== 4 || p[0] !== 'v1') return ''; const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(p[1], 'hex')); d.setAuthTag(Buffer.from(p[2], 'hex')); return Buffer.concat([d.update(Buffer.from(p[3], 'hex')), d.final()]).toString('utf8'); } catch (e) { return ''; } }
  const base = () => String(runtimeBaseUrl || process.env.SMS_COOL_BASE_URL || 'https://sms-cool.com/api/v1').replace(/\/+$/, '');
  const key = () => String(runtimeApiKey || process.env.SMS_COOL_API_KEY || '').trim();

  const Config = mongoose.models.TempEmailConfig || mongoose.model('TempEmailConfig', new S({
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: true },
    markupNgn: { type: Number, default: Number(process.env.SMS_COOL_EMAIL_MARKUP_NGN || 40) },
    markupPercent: { type: Number, default: 0 },
    emailDomains1: { type: [String], default: ['gmail.com'] },
    emailSites: { type: [String], default: ['telegram.com', 'facebook.com', 'instagram.com', 'google.com', 'twitter.com', 'tiktok.com', 'whatsapp.com', 'discord.com'] },
    apiKeyCipher: { type: String, default: '' }
  }));
  async function getCfg() {
    let c = await Config.findOne({ key: 'main' });
    if (!c) c = await Config.create({ key: 'main' });
    runtimeApiKey = c.apiKeyCipher ? decryptSecret(c.apiKeyCipher) : '';
    return c;
  }

  const EmailOrder = mongoose.models.TempEmailOrder || mongoose.model('TempEmailOrder', new S({
    userId: { type: S.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, default: '' },
    ref: { type: String, unique: true, required: true },
    price: Number, providerCost: Number,
    debited: { type: Boolean, default: false }, refunded: { type: Boolean, default: false },
    lastError: String,
    server: Number, serviceId: String, serviceName: String, domain: String, site: String,
    emailId: { type: String, default: '' }, email: String, code: String,
    status: { type: String, default: 'pending', index: true },
    createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
  }));

  // ───────── provider call + helpers ─────────
  const mkErr = (m, status) => { const e = new Error(m); e.status = status; return e; };
  async function call(p, params, opts) {
    await getCfg();
    if (!key()) throw mkErr('This service is not available right now.', 503);
    let r;
    try { r = await axios.get(base() + p, { params, timeout: (opts && opts.timeout) || 20000, headers: { Authorization: 'Bearer ' + key(), Accept: 'application/json' } }); }
    catch (err) {
      const st = (err.response && err.response.status) || 0; const dd = (err.response && err.response.data) || {}; const m = dd.message || dd.error || '';
      const e = new Error(m || 'Service request failed'); e.status = st || 502; e.providerMessage = String(m || ''); e.ambiguous = !st || st >= 500 || err.code === 'ECONNABORTED'; throw e;
    }
    const b = r.data;
    if (b && typeof b === 'object' && (b.status === 'error' || b.status === 'failed' || (b.error && !b.order_id))) { const e = new Error(b.message || b.error || 'Service request failed'); e.status = 400; e.providerMessage = String(b.message || b.error || ''); throw e; }
    return b || {};
  }
  const cache = new Map();
  async function cached(k, ttl, fn) {
    const h = cache.get(k);
    if (h && Date.now() - h.at < ttl) return h.v;
    try { const v = await fn(); cache.set(k, { at: Date.now(), v }); return v; } catch (e) { if (h && Date.now() - h.at < 30 * 60 * 1000) return h.v; throw e; }
  }
  const usdToNgn = async (usd) => (await fx.convert(usd, 'USD', 'NGN')) * (1 + (fx.SPREAD || 0));
  // Price = provider cost in naira + percent + fixed markup (set in Admin -> Temp Email). Never below cost.
  async function sell(cfg, usd) {
    const cost = Math.ceil(await usdToNgn(usd));
    const price = Math.ceil(cost * (1 + (Number(cfg.markupPercent) || 0) / 100) + (Number(cfg.markupNgn) || 0));
    return { cost, price: Math.max(price, cost) };
  }
  function friendly(e) {
    const m = String((e && (e.providerMessage || e.message)) || '');
    if (/stock|no emails|not available|unavailable|no .*available/i.test(m)) return 'None are available for that selection right now.';
    return 'We could not complete this purchase. Nothing was charged.';
  }
  const cleanRef = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || crypto.randomUUID();
  const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v));

  async function charge(uid, amt) { return User.findOneAndUpdate({ _id: uid, balance: { $gte: amt } }, { $inc: { balance: -amt } }, { new: true }); }
  async function claimRefund(o, status, desc, errText) {
    const c = await EmailOrder.findOneAndUpdate({ _id: o._id, refunded: false }, { $set: { refunded: true, status, updatedAt: new Date(), ...(errText ? { lastError: errText } : {}) } }, { new: true });
    if (!c) return null;
    try { await User.updateOne({ _id: o.userId }, { $inc: { balance: o.price || 0 } }); await Transaction.create({ userId: o.userId, type: 'refund', amount: o.price || 0, description: desc, status: 'success' }).catch(() => {}); }
    catch (e) { await EmailOrder.updateOne({ _id: o._id }, { $set: { refunded: false, status: 'review', lastError: 'Automatic refund needs admin review: ' + e.message } }).catch(() => {}); throw e; }
    return c;
  }
  // Charge the wallet first, then call the provider. Definite failure => automatic refund. Unclear result => "review", never a double charge.
  async function chargeAndCall(res, req, order, price, providerFn) {
    const user = await charge(req.user._id, price);
    if (!user) { await EmailOrder.updateOne({ _id: order._id }, { $set: { status: 'failed', lastError: 'Insufficient wallet balance' } }); res.status(400).json({ error: 'Insufficient wallet balance.' }); return null; }
    await EmailOrder.updateOne({ _id: order._id }, { $set: { debited: true } });
    try { return { d: await providerFn(), user }; }
    catch (e) {
      if (e.ambiguous) { await EmailOrder.updateOne({ _id: order._id }, { $set: { status: 'review', lastError: e.message, updatedAt: new Date() } }); res.status(202).json({ ok: true, pending: true, orderId: String(order._id), message: 'The provider response is unclear. Your order is being checked; please do not purchase again.' }); return null; }
      try { await claimRefund(order, 'failed', 'Purchase refund - Temp Email', e.message); }
      catch (re) { res.status(202).json({ ok: true, pending: true, orderId: String(order._id), message: 'The purchase could not be completed and the refund needs review. Please contact support.' }); return null; }
      res.status(e.status === 409 ? 409 : 400).json({ error: friendly(e) }); return null;
    }
  }
  const guard = async (req, res, next) => { try { const c = await getCfg(); if (c.enabled === false) return res.status(503).json({ error: 'Temp Email is temporarily unavailable.' }); next(); } catch (e) { res.status(500).json({ error: 'Temp Email is temporarily unavailable.' }); } };

  // ═════════ CUSTOMER ═════════
  const safeEmail = (o) => ({ id: String(o._id), email: o.email || '', service: o.serviceName || o.domain || 'Email', domain: o.domain, site: o.site || '', price: o.price, status: o.status, code: o.code || null, createdAt: o.createdAt, canCancel: ['active', 'pending'].includes(o.status) && !o.code && !!o.emailId });

  async function emailList(server, domain, site, cfg) {
    if (server === 1) {
      const d = await call('/email/services', { server: 1, domain }); const out = [];
      for (const x of (d.services || [])) { const usd = Number(x.price); if (!(usd > 0)) continue; const p = await sell(cfg, usd); out.push({ id: String(x.id), name: String(x.name), price: p.price, count: Number(x.count) || 0, usd }); }
      return out;
    }
    const d = await call('/email/services', { server: 2, site }); const out = [];
    for (const x of (d.domains || [])) { const usd = Number(x.price); if (!(usd > 0)) continue; const p = await sell(cfg, usd); out.push({ id: String(x.domain), name: String(x.name || x.domain), price: p.price, count: Number(x.count) || 0, usd }); }
    return out;
  }
  async function syncEmail(o) {
    if (!o.emailId || o.code || CLOSED.includes(o.status)) return o;
    let d; try { d = await call('/email/code', { email_id: o.emailId }); } catch (e) { if (e.status === 404) return o; throw e; }
    const st = String(d.status);
    if (st === '200') { const m = (d.messages || []).find(x => x && x.code); if (m) await EmailOrder.updateOne({ _id: o._id }, { $set: { status: 'received', code: String(m.code), updatedAt: new Date() } }); }
    else if (st === '300') { await claimRefund(o, 'cancelled', 'Temp Email refund (no code received)'); }
    return EmailOrder.findById(o._id).lean();
  }

  app.get('/api/rado/tempmail/options', auth, guard, async (req, res) => { try { const c = await getCfg(); res.set('Cache-Control', 'no-store'); res.json({ domains1: c.emailDomains1, sites: c.emailSites }); } catch (e) { res.status(500).json({ error: 'Could not load Temp Email.' }); } });
  app.get('/api/rado/tempmail/services', auth, guard, async (req, res) => {
    const server = Number(req.query.server) === 2 ? 2 : 1; const domain = String(req.query.domain || '').toLowerCase(); const site = String(req.query.site || 'telegram.com').toLowerCase();
    if (server === 1 && !HOST_RE.test(domain)) return res.status(400).json({ error: 'Choose a mail domain.' });
    if (server === 2 && !HOST_RE.test(site)) return res.status(400).json({ error: 'Enter a valid website.' });
    try { const cfg = await getCfg(); const list = await cached('svc:' + server + ':' + (server === 1 ? domain : site) + ':' + cfg.markupNgn + ':' + cfg.markupPercent, 60000, () => emailList(server, domain, site, cfg)); res.json(list.map(({ usd, ...x }) => x)); }
    catch (e) { res.status(e.status === 503 ? 503 : 502).json({ error: e.status === 503 ? e.message : 'Could not load the list right now. Please try again.' }); }
  });
  app.get('/api/rado/tempmail/orders', auth, async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json((await EmailOrder.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean()).map(safeEmail)); }
    catch (e) { res.status(500).json({ error: 'Could not load email history.' }); }
  });
  app.post('/api/rado/tempmail/buy', auth, guard, async (req, res) => {
    const b = req.body || {};
    const server = Number(b.server) === 2 ? 2 : 1; const serviceId = String(b.serviceId || '').trim().slice(0, 40); const domain = String(b.domain || '').toLowerCase().trim(); const site = String(b.site || 'telegram.com').toLowerCase().trim();
    if (server === 1 && (!/^[a-zA-Z0-9_-]{1,40}$/.test(serviceId) || !HOST_RE.test(domain))) return res.status(400).json({ error: 'Choose a domain and service.' });
    if (server === 2 && (!HOST_RE.test(domain) || !HOST_RE.test(site))) return res.status(400).json({ error: 'Choose a website and domain.' });
    const ref = cleanRef(b.clientRef);
    try {
      const cfg = await getCfg();
      const existing = await EmailOrder.findOne({ ref });
      if (existing) { if (String(existing.userId) !== String(req.user._id)) return res.status(409).json({ error: 'Invalid purchase reference.' }); return res.json({ ok: true, repeated: true, order: safeEmail(existing) }); }
      const unclear = await EmailOrder.findOne({ userId: req.user._id, status: 'review', createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
      if (unclear) return res.status(202).json({ ok: true, pending: true, orderId: String(unclear._id), message: 'A recent purchase is still being verified. Please check My Emails before trying again.' });
      const item = (await emailList(server, domain, site, cfg)).find(x => x.id === (server === 1 ? serviceId : domain));
      if (!item) return res.status(404).json({ error: 'That option is no longer available.' });
      if (!(item.count > 0)) return res.status(409).json({ error: 'Out of stock right now. Try another one.' });
      const order = await EmailOrder.create({ userId: req.user._id, userEmail: req.user.email, ref, server, serviceId: server === 1 ? serviceId : '', serviceName: server === 1 ? item.name : site, domain, site: server === 2 ? site : '', price: item.price, providerCost: item.usd, status: 'pending' });
      const r = await chargeAndCall(res, req, order, item.price, async () => {
        const q = server === 1 ? { server: 1, service_id: serviceId, domain } : { server: 2, domain, site };
        const d = await call('/email/buy', q, { timeout: 30000 });
        if (String(d.status) !== '200' || !d.email_id) throw mkErr(d.message || 'No stock available', 409);
        return d;
      });
      if (!r) return;
      await EmailOrder.updateOne({ _id: order._id }, { $set: { emailId: String(r.d.email_id), email: String(r.d.email || ''), providerCost: Number(r.d.price) || item.usd, status: 'active', updatedAt: new Date() } });
      await Transaction.create({ userId: req.user._id, type: 'purchase', amount: item.price, description: 'Temp Email - ' + (server === 1 ? item.name : domain), status: 'success' }).catch(() => {});
      res.json({ ok: true, order: safeEmail(await EmailOrder.findById(order._id).lean()), balance: r.user.balance });
    } catch (e) { console.error('[tempmail] buy failed:', e.message); res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message || 'Could not buy an email.' }); }
  });
  app.get('/api/rado/tempmail/code/:id', auth, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: 'Order not found.' });
      const o = await EmailOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' });
      res.set('Cache-Control', 'no-store'); res.json({ order: safeEmail(await syncEmail(o)) });
    } catch (e) { res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.status === 503 ? e.message : 'Could not check the code right now.' }); }
  });
  app.post('/api/rado/tempmail/cancel/:id', auth, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: 'Order not found.' });
      const o = await EmailOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.refunded || o.status === 'cancelled') return res.json({ ok: true, order: safeEmail(o) });
      if (!o.emailId || o.code || o.status === 'received') return res.status(400).json({ error: 'This email can no longer be cancelled.' });
      let d; try { d = await call('/email/cancel', { email_id: o.emailId }); } catch (e) { return res.status(400).json({ error: 'This email can no longer be cancelled.' }); }
      if (String(d.status) !== '200') return res.status(400).json({ error: d.message || 'This email can no longer be cancelled.' });
      await claimRefund(o, 'cancelled', 'Temp Email cancellation refund');
      res.json({ ok: true, order: safeEmail(await EmailOrder.findById(o._id).lean()) });
    } catch (e) { res.status(500).json({ error: 'Could not cancel right now. Please try again.' }); }
  });

  // ═════════ safety net: finish / refund orders even if the customer closed the page ═════════
  let sweeping = false;
  const sw = setInterval(async () => {
    if (sweeping || !key() || mongoose.connection.readyState !== 1) return; sweeping = true;
    try {
      const old = new Date(Date.now() - 25 * 60 * 1000), oldest = new Date(Date.now() - 6 * 60 * 60 * 1000);
      for (const o of await EmailOrder.find({ status: 'active', emailId: { $ne: '' }, createdAt: { $lt: old, $gt: oldest } }).limit(30)) await syncEmail(o).catch(() => {});
    } catch (e) { /* never crash the server */ } finally { sweeping = false; }
  }, 90 * 1000);
  if (sw.unref) sw.unref();

  // ═════════ ADMIN ═════════
  const cfgOut = (c) => ({ configured: !!key(), baseUrl: base(), enabled: c.enabled, markupNgn: c.markupNgn, markupPercent: c.markupPercent, emailDomains1: c.emailDomains1, emailSites: c.emailSites });
  app.get('/api/admin/tempmail/status', adminAuth, async (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json(cfgOut(await getCfg())); } catch (e) { res.status(500).json({ error: 'Could not load Temp Email.' }); } });
  app.get('/api/admin/tempmail/orders', adminAuth, async (req, res) => {
    try {
      const rows = await EmailOrder.find({}).sort({ createdAt: -1 }).limit(100).lean();
      res.set('Cache-Control', 'no-store');
      res.json(rows.map(o => ({ id: String(o._id), userEmail: o.userEmail || '', service: o.serviceName || o.domain || '', email: o.email || '', code: o.code || '', price: o.price, status: o.status, lastError: o.lastError || '', refunded: !!o.refunded, providerCost: o.providerCost || 0, createdAt: o.createdAt })));
    } catch (e) { res.status(500).json({ error: 'Could not load orders.' }); }
  });
  app.put('/api/admin/tempmail/config', adminAuth, async (req, res) => {
    try {
      const c = await getCfg(); const b = req.body || {};
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      for (const [f, max] of [['markupNgn', 1e6], ['markupPercent', 1000]]) if (b[f] !== undefined && b[f] !== null && b[f] !== '') { const n = Number(b[f]); if (!Number.isFinite(n) || n < 0 || n > max) return res.status(400).json({ error: f + ' is out of range.' }); c[f] = n; }
      if (Array.isArray(b.emailDomains1)) c.emailDomains1 = b.emailDomains1.map(x => String(x).toLowerCase().trim()).filter(x => HOST_RE.test(x)).slice(0, 30);
      if (Array.isArray(b.emailSites)) c.emailSites = b.emailSites.map(x => String(x).toLowerCase().trim()).filter(x => HOST_RE.test(x)).slice(0, 60);
      if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKeyCipher = encryptSecret(b.apiKey.trim());
      await c.save(); await getCfg(); cache.clear();
      res.json({ ok: true, ...cfgOut(c) });
    } catch (e) { res.status(500).json({ error: 'Could not save the settings.' }); }
  });
  app.post('/api/admin/tempmail/orders/:id/refund', adminAuth, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: 'Order not found.' });
      const o = await EmailOrder.findById(req.params.id); if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (!o.debited) return res.status(400).json({ error: 'This order was not charged.' });
      if (o.refunded) return res.status(400).json({ error: 'This order has already been refunded.' });
      if (o.code || o.status === 'received') return res.status(400).json({ error: 'A code was delivered for this order, so it cannot be refunded here.' });
      const c = await claimRefund(o, 'refunded', 'Manual refund by admin - Temp Email', 'Refunded manually by admin after provider review.');
      if (!c) return res.status(409).json({ error: 'This order was already processed.' });
      res.json({ ok: true, refunded: o.price || 0 });
    } catch (e) { res.status(500).json({ error: 'Wallet refund failed; order was returned to review.' }); }
  });
  app.get('/api/admin/tempmail/balance', adminAuth, async (req, res) => {
    try { const d = await call('/balance'); const usd = Number(d.balance) || 0; res.json({ balance: Math.round(await usdToNgn(usd)), balanceUsd: usd }); }
    catch (e) { res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.status === 503 ? e.message : 'Could not read the provider balance.' }); }
  });

  return { EmailOrder };
}

module.exports = { register };
