// ── Provider integration: SMS numbers + Buy Accounts (products) ─────────────
// Used ONLY for the two customer features: SMS Numbers and Products.
//
// .env / Render environment:
//   BENOTP_API_KEY=your_provider_api_key        (required, never put it in code)
//   BENOTP_BASE_URL=https://benotp.com           (optional, this is the default)
//   BENOTP_MARKUP_PERCENT=20                     (optional, % added on top of the provider price, default 0)
//   BENOTP_PRODUCTS_MARKUP_PERCENT=20            (optional, defaults to BENOTP_MARKUP_PERCENT)
//   BENOTP_PRICE_MULTIPLIER=1                    (optional, use e.g. 1600 if the provider prices are in USD and you sell in NGN)
//   BENOTP_NUMBER_TTL_MIN=20                     (optional, minutes to wait for an SMS before auto-cancel + refund)
//
// Money safety (same idea as Marketplace 2):
//   1. The customer's wallet is debited atomically BEFORE the provider is called.
//   2. If the provider gives a definite error, the customer is refunded automatically (once only).
//   3. If the outcome is unknown (timeout / provider 5xx) the order is held as "review" and NOT refunded blindly.
//   4. A number with no SMS before the time limit is cancelled at the provider and refunded.
//
// Routes (all under /api/rado/ so nothing else on the site is touched):
//   GET  /api/rado/numbers/services | /countries | /price?service=&country=
//   POST /api/rado/numbers/buy          { service, country, expectedPrice }
//   GET  /api/rado/numbers/status/:id   POST /api/rado/numbers/cancel/:id   GET /api/rado/numbers/my-orders
//   GET  /api/rado/products | /products/categories      POST /api/rado/products/buy { id, amount }
//   GET  /api/rado/admin/pricing | PUT .../pricing/markups | PUT .../pricing/rule   (admin: markup, per-service prices, hide)
//   GET  /api/rado/admin/benotp-test    (admin) shows the provider's raw answers, handy for debugging

const axios = require('axios');

const NUMBERS_PATH = '/stubs/handler.php';        // "All Countries Server 1"
const PRODUCTS_PATH = '/stubs/buy-accounts.php';  // "Buy Accounts API"

function register(app, deps) {
  const { mongoose, User, Transaction, auth, anyAdminAuth } = deps;
  const adminAuth = deps.adminAuth || anyAdminAuth; // owner-only for anything that changes prices

  const apiKey = () => String(process.env.BENOTP_API_KEY || '').trim();
  const baseUrl = () => {
    // Works whether BENOTP_BASE_URL is just the domain OR the full address used on the other site
    // (e.g. https://benotp.com/stubs/buy-accounts.php) - any /stubs/... path is cut off.
    let u = String(process.env.BENOTP_BASE_URL || 'https://benotp.com').trim().replace(/\/+$/, '');
    u = u.replace(/\/stubs\/.*$/i, '').replace(/\/+$/, '');
    return u || 'https://benotp.com';
  };
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const markupNumbers = () => num(process.env.BENOTP_MARKUP_PERCENT, 0);
  const markupProducts = () => num(process.env.BENOTP_PRODUCTS_MARKUP_PERCENT, markupNumbers());
  const multiplier = () => num(process.env.BENOTP_PRICE_MULTIPLIER, 1) || 1;
  const ttlMs = () => Math.max(3, num(process.env.BENOTP_NUMBER_TTL_MIN, 20)) * 60 * 1000;
  const sell = (cost, pct) => Math.ceil(Number(cost) * multiplier() * (1 + pct / 100));

  // ── Admin-editable pricing (saved in MongoDB, so no redeploy is needed) ───
  // markups: global % for numbers / products (fall back to the env values).
  // rules:   per-service (numbers) and per-product overrides: a fixed price,
  //          or a markup % for that one service, and a hide switch.
  const ruleSchema = new mongoose.Schema({
    itemId: { type: String, required: true },
    name: { type: String, default: '' },
    price: { type: Number, default: null },   // fixed selling price in NGN (per number / per unit)
    markup: { type: Number, default: null },  // markup % for this item only (numbers)
    hidden: { type: Boolean, default: false }
  }, { _id: false });
  const settingsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    numbersMarkup: { type: Number, default: null },
    productsMarkup: { type: Number, default: null },
    numberRules: { type: [ruleSchema], default: [] },
    productRules: { type: [ruleSchema], default: [] },
    updatedAt: { type: Date, default: Date.now }
  });
  const Settings = mongoose.models.BenotpSettings || mongoose.model('BenotpSettings', settingsSchema);
  let cfg = { at: 0, numbersMarkup: null, productsMarkup: null, numberRules: {}, productRules: {} };
  const toMap = (arr) => { const m = {}; (arr || []).forEach(r => { m[r.itemId] = { name: r.name, price: r.price, markup: r.markup, hidden: !!r.hidden }; }); return m; };
  async function loadCfg(force) {
    if (!force && Date.now() - cfg.at < 15000) return cfg;
    try {
      const d = await Settings.findOne({ key: 'main' }).lean();
      cfg = { at: Date.now(), numbersMarkup: d ? d.numbersMarkup : null, productsMarkup: d ? d.productsMarkup : null,
        numberRules: toMap(d && d.numberRules), productRules: toMap(d && d.productRules) };
    } catch (e) { cfg.at = Date.now(); }
    return cfg;
  }
  const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const numbersPct = () => hasNum(cfg.numbersMarkup) ? Number(cfg.numbersMarkup) : markupNumbers();
  const productsPct = () => hasNum(cfg.productsMarkup) ? Number(cfg.productsMarkup) : markupProducts();
  function numberSell(cost, serviceId) {
    const r = cfg.numberRules[serviceId] || {};
    if (hasNum(r.price) && Number(r.price) > 0) return Math.ceil(Number(r.price));
    return sell(cost, hasNum(r.markup) ? Number(r.markup) : numbersPct());
  }
  function productSell(cost, productId) {
    const r = cfg.productRules[productId] || {};
    if (hasNum(r.price) && Number(r.price) > 0) return Math.ceil(Number(r.price));
    return sell(cost, productsPct());
  }

  // ── Model: one collection for number + product orders ────────────────────
  const orderSchema = new mongoose.Schema({
    kind: { type: String, enum: ['number', 'product'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    userEmail: String,
    title: String,
    providerOrderId: String,
    phoneNumber: String,
    service: String,
    country: String,
    productId: String,
    quantity: { type: Number, default: 1 },
    cost: { type: Number, default: 0 },
    sellPrice: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }, // pending | completed | cancelled | expired | failed | review
    code: { type: String, default: '' },
    details: { type: String, default: '' },
    note: { type: String, default: '' },
    refunded: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  const Order = mongoose.models.BenotpOrder || mongoose.model('BenotpOrder', orderSchema);

  // ── Provider client ───────────────────────────────────────────────────────
  class ProviderError extends Error {
    constructor(msg, ambiguous) { super(msg); this.ambiguous = !!ambiguous; }
  }
  const parseBody = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    const t = String(raw == null ? '' : raw).trim();
    try { return JSON.parse(t); } catch (e) { return t; }
  };
  function providerErrorText(d) {
    if (typeof d === 'string') {
      if (/^(NO_|BAD_|ERROR|WRONG_|BANNED|ACCOUNT_|INVALID)/i.test(d)) return d;
      return '';
    }
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const st = String(d.status || d.success || '').toLowerCase();
      if (d.error) return typeof d.error === 'string' ? d.error : (d.error.message || 'Provider error');
      if (['error', 'failed', 'fail', 'false'].includes(st) || d.success === false) return String(d.message || d.msg || 'Provider error');
    }
    return '';
  }
  async function call(path, params, opts) {
    const key = apiKey();
    if (!key) throw new ProviderError('This service is not set up yet. Please contact support.', false);
    let res;
    try {
      res = await axios.request({
        method: (opts && opts.method) || 'GET',
        url: baseUrl() + path,
        params: (opts && opts.method === 'POST') ? undefined : { ...params, api_key: key },
        data: (opts && opts.method === 'POST') ? new URLSearchParams({ ...params, api_key: key }).toString() : undefined,
        headers: (opts && opts.method === 'POST') ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } : { Accept: 'application/json' },
        timeout: (opts && opts.timeout) || 30000,
        responseType: 'text',
        transformResponse: [(x) => x],
        validateStatus: () => true
      });
    } catch (e) {
      throw new ProviderError('The provider could not be reached.', true);
    }
    if (res.status >= 500) throw new ProviderError('The provider is having problems right now.', true);
    const data = parseBody(res.data);
    if (res.status >= 400) throw new ProviderError(providerErrorText(data) || ('Provider refused the request (' + res.status + ').'), false);
    const err = providerErrorText(data);
    if (err) throw new ProviderError(err, false);
    return data;
  }

  // ── Tolerant readers (the provider's JSON layout is not fixed in the docs) ─
  const unwrap = (d) => {
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const k of ['data', 'result', 'results', 'services', 'countries', 'products', 'items', 'list']) {
        if (d[k] != null && typeof d[k] === 'object') return d[k];
      }
    }
    return d;
  };
  function toList(d) {
    d = unwrap(d);
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') return Object.keys(d).map(k => {
      const v = d[k];
      return (v && typeof v === 'object') ? { id: k, ...v } : { id: k, name: v };
    });
    return [];
  }
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };
  function deepFind(o, keys, depth) {
    if (o == null || depth > 4) return undefined;
    if (typeof o === 'object') {
      const v = pick(o, keys); if (v !== undefined && typeof v !== 'object') return v;
      for (const k of Object.keys(o)) { const r = deepFind(o[k], keys, depth + 1); if (r !== undefined) return r; }
    }
    return undefined;
  }
  function normItem(it) {
    if (typeof it === 'string') return { id: it, name: it };
    const id = pick(it, ['id', 'code', 'key', 'short', 'iso', 'service', 'country', 'value', 'slug']);
    const name = pick(it, ['name', 'title', 'label', 'service_name', 'country_name', 'text']) || id;
    return { id: String(id), name: String(name), raw: it };
  }
  function readPrice(d) {
    if (typeof d === 'number') return d;
    if (typeof d === 'string') { const m = d.match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; }
    const v = deepFind(d, ['price', 'cost', 'amount', 'rate']);
    return v === undefined ? NaN : Number(v);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const busy = new Set();
  const lockUser = (id) => { id = String(id); if (busy.has(id)) return false; busy.add(id); setTimeout(() => busy.delete(id), 60000); return true; };
  const unlockUser = (id) => busy.delete(String(id));
  const clientMsg = (e) => (e && e.message && !/ECONN|ENOTFOUND|timeout/i.test(e.message)) ? e.message : 'Something went wrong. Please try again.';

  async function refund(orderId, reason, newStatus) {
    const o = await Order.findOneAndUpdate({ _id: orderId, refunded: false }, { $set: { refunded: true, status: newStatus, note: reason, updatedAt: new Date() } });
    if (!o) return false;
    await User.updateOne({ _id: o.userId }, { $inc: { balance: o.sellPrice } });
    try { await Transaction.create({ userId: o.userId, type: 'refund', amount: o.sellPrice, description: 'Refund - ' + (o.title || o.kind), status: 'success' }); } catch (e) { /* ledger is best-effort */ }
    return true;
  }
  async function debit(user, amount, title) {
    const u = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
    if (u) { try { await Transaction.create({ userId: user._id, type: 'purchase', amount, description: title, status: 'success' }); } catch (e) { /* best-effort */ } }
    return u;
  }

  // ═════════════════════════ SMS NUMBERS ═══════════════════════════════════
  let svcCache = { at: 0, v: null }, ctyCache = { at: 0, v: null };
  const fresh = (c) => c.v && Date.now() - c.at < 10 * 60 * 1000;

  app.get('/api/rado/numbers/services', auth, async (req, res) => {
    try {
      await loadCfg();
      if (!fresh(svcCache)) svcCache = { at: Date.now(), v: toList(await call(NUMBERS_PATH, { action: 'getServices' })).map(normItem).map(({ id, name }) => ({ id, name })) };
      res.json(svcCache.v.filter(x => !(cfg.numberRules[x.id] || {}).hidden));
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/countries', auth, async (req, res) => {
    try {
      if (!fresh(ctyCache)) ctyCache = { at: Date.now(), v: toList(await call(NUMBERS_PATH, { action: 'getCountries' })).map(normItem).map(({ id, name }) => ({ id, name })) };
      res.json(ctyCache.v);
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  async function numberPrice(service, country) {
    const d = await call(NUMBERS_PATH, { action: 'getPrice', service, country, pool: 1 });
    const cost = readPrice(d);
    if (!Number.isFinite(cost) || cost <= 0) throw new ProviderError('No number available for this service and country right now.', false);
    return cost;
  }
  app.get('/api/rado/numbers/price', auth, async (req, res) => {
    try {
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.status(400).json({ error: 'Choose a service and a country.' });
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      const cost = await numberPrice(service, country);
      res.json({ price: numberSell(cost, service) });
    } catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });

  app.post('/api/rado/numbers/buy', auth, async (req, res) => {
    const service = String(req.body.service || ''), country = String(req.body.country || '');
    if (!service || !country) return res.status(400).json({ error: 'Choose a service and a country.' });
    if (!lockUser(req.user._id)) return res.status(429).json({ error: 'Please wait, your last request is still running.' });
    let order;
    try {
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      let cost;
      try { cost = await numberPrice(service, country); } catch (e) { return res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
      const price = numberSell(cost, service);
      const expected = Number(req.body.expectedPrice);
      if (Number.isFinite(expected) && expected > 0 && price > expected) return res.status(409).json({ error: 'The price changed to ₦' + price.toLocaleString() + '. Please try again.', price });
      const svcName = ((svcCache.v || []).find(s => s.id === service) || {}).name || service;
      const ctyName = ((ctyCache.v || []).find(c => c.id === country) || {}).name || country;
      order = await Order.create({ kind: 'number', userId: req.user._id, userEmail: req.user.email, title: svcName + ' number (' + ctyName + ')', service: svcName, country: ctyName, cost, sellPrice: price, status: 'pending' });
      const user = await debit(req.user, price, 'SMS number - ' + svcName + ' (' + ctyName + ')');
      if (!user) { await Order.updateOne({ _id: order._id }, { $set: { status: 'failed', refunded: true, note: 'Insufficient balance' } }); return res.status(400).json({ error: 'Insufficient balance. Please fund your wallet.' }); }
      let d;
      try { d = await call(NUMBERS_PATH, { action: 'getNumber', service, country, quantity: 1, pool: 1 }, { timeout: 45000 }); }
      catch (e) {
        if (!e.ambiguous) { await refund(order._id, e.message, 'failed'); return res.status(400).json({ error: clientMsg(e) + ' Nothing was charged.' }); }
        await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Provider outcome unknown: ' + e.message, updatedAt: new Date() } });
        console.error('[benotp] number order held for review', String(order._id));
        return res.status(202).json({ pending: true, message: 'We could not confirm your order. If a number was issued it will appear in your orders; otherwise contact support to be refunded.' });
      }
      let id, phone;
      if (typeof d === 'string') { const m = d.match(/ACCESS_NUMBER:([^:]+):(\+?\d+)/i); if (m) { id = m[1]; phone = m[2]; } }
      else { id = deepFind(d, ['order_id', 'orderId', 'activation_id', 'activationId', 'request_id', 'id']); phone = deepFind(d, ['number', 'phone', 'phone_number', 'phoneNumber', 'mdn', 'msisdn']); }
      if (!id || !phone) {
        await refund(order._id, 'Provider returned no number', 'failed');
        console.error('[benotp] getNumber unreadable answer:', JSON.stringify(d).slice(0, 300));
        return res.status(502).json({ error: 'No number was issued. Nothing was charged.' });
      }
      await Order.updateOne({ _id: order._id }, { $set: { providerOrderId: String(id), phoneNumber: String(phone), updatedAt: new Date() } });
      res.json({ ok: true, orderId: String(order._id), phoneNumber: String(phone), newBalance: user.balance });
    } catch (e) {
      console.error('[benotp] number buy failed:', e.message);
      res.status(500).json({ error: 'Purchase failed. If you were charged, contact support and you will be refunded.' });
    } finally { unlockUser(req.user._id); }
  });

  function readStatus(d) {
    if (typeof d === 'string') {
      let m = d.match(/STATUS_OK:(.+)/i); if (m) return { code: (m[1].match(/\d{3,8}/) || [m[1]])[0].trim() };
      if (/STATUS_CANCEL/i.test(d)) return { cancelled: true };
      return {};
    }
    const raw = deepFind(d, ['code', 'otp', 'pin', 'sms', 'text', 'message']);
    const st = String(deepFind(d, ['status', 'state']) || '').toLowerCase();
    let code = '';
    if (raw != null && !/wait|pending|no sms/i.test(String(raw))) { const m = String(raw).match(/\d{3,8}/); code = m ? m[0] : ''; }
    return { code, cancelled: /cancel|refund/.test(st), expired: /expire|timeout/.test(st) };
  }
  const shape = (o) => ({ id: String(o._id), phoneNumber: o.phoneNumber, service: o.service, country: o.country, status: o.status, code: o.code, sellPrice: o.sellPrice, createdAt: o.createdAt });

  app.get('/api/rado/numbers/status/:id', auth, async (req, res) => {
    try {
      const o = await Order.findOne({ _id: req.params.id, userId: req.user._id, kind: 'number' });
      if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.status === 'pending' && o.providerOrderId) {
        let s = {};
        try { s = readStatus(await call(NUMBERS_PATH, { action: 'getStatus', order_id: o.providerOrderId })); } catch (e) { /* keep waiting */ }
        if (s.code) { o.code = s.code; o.status = 'completed'; o.updatedAt = new Date(); await o.save(); }
        else if (s.cancelled || s.expired) { await refund(o._id, 'Cancelled by provider', 'cancelled'); }
        else if (Date.now() - new Date(o.createdAt).getTime() > ttlMs()) {
          try { await call(NUMBERS_PATH, { action: 'setStatus', order_id: o.providerOrderId, status: 8 }); } catch (e) { /* still refund: no SMS arrived */ }
          await refund(o._id, 'No SMS received in time', 'expired');
        }
      }
 // ── Provider integration: SMS numbers + Buy Accounts (products) ─────────────
// Used ONLY for the two customer features: SMS Numbers and Products.
//
// .env / Render environment:
//   BENOTP_API_KEY=your_provider_api_key        (required, never put it in code)
//   BENOTP_BASE_URL=https://benotp.com           (optional, this is the default)
//   BENOTP_MARKUP_PERCENT=20                     (optional, % added on top of the provider price, default 0)
//   BENOTP_PRODUCTS_MARKUP_PERCENT=20            (optional, defaults to BENOTP_MARKUP_PERCENT)
//   BENOTP_PRICE_MULTIPLIER=1                    (optional, use e.g. 1600 if the provider prices are in USD and you sell in NGN)
//   BENOTP_NUMBER_TTL_MIN=20                     (optional, minutes to wait for an SMS before auto-cancel + refund)
//
// Money safety (same idea as Marketplace 2):
//   1. The customer's wallet is debited atomically BEFORE the provider is called.
//   2. If the provider gives a definite error, the customer is refunded automatically (once only).
//   3. If the outcome is unknown (timeout / provider 5xx) the order is held as "review" and NOT refunded blindly.
//   4. A number with no SMS before the time limit is cancelled at the provider and refunded.
//
// Routes (all under /api/rado/ so nothing else on the site is touched):
//   GET  /api/rado/numbers/services | /countries | /price?service=&country=
//   POST /api/rado/numbers/buy          { service, country, expectedPrice }
//   GET  /api/rado/numbers/status/:id   POST /api/rado/numbers/cancel/:id   GET /api/rado/numbers/my-orders
//   GET  /api/rado/products | /products/categories      POST /api/rado/products/buy { id, amount }
//   GET  /api/rado/admin/pricing | PUT .../pricing/markups | PUT .../pricing/rule   (admin: markup, per-service prices, hide)
//   GET  /api/rado/admin/benotp-test    (admin) shows the provider's raw answers, handy for debugging

const axios = require('axios');

const NUMBERS_PATH = '/stubs/handler.php';        // "All Countries Server 1"
const PRODUCTS_PATH = '/stubs/buy-accounts.php';  // "Buy Accounts API"

function register(app, deps) {
  const { mongoose, User, Transaction, auth, anyAdminAuth } = deps;
  const adminAuth = deps.adminAuth || anyAdminAuth; // owner-only for anything that changes prices

  const apiKey = () => String(process.env.BENOTP_API_KEY || '').trim();
  const baseUrl = () => {
    // Works whether BENOTP_BASE_URL is just the domain OR the full address used on the other site
    // (e.g. https://benotp.com/stubs/buy-accounts.php) - any /stubs/... path is cut off.
    let u = String(process.env.BENOTP_BASE_URL || 'https://benotp.com').trim().replace(/\/+$/, '');
    u = u.replace(/\/stubs\/.*$/i, '').replace(/\/+$/, '');
    return u || 'https://benotp.com';
  };
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const markupNumbers = () => num(process.env.BENOTP_MARKUP_PERCENT, 0);
  const markupProducts = () => num(process.env.BENOTP_PRODUCTS_MARKUP_PERCENT, markupNumbers());
  const multiplier = () => num(process.env.BENOTP_PRICE_MULTIPLIER, 1) || 1;
  const ttlMs = () => Math.max(3, num(process.env.BENOTP_NUMBER_TTL_MIN, 20)) * 60 * 1000;
  const sell = (cost, pct) => Math.ceil(Number(cost) * multiplier() * (1 + pct / 100));

  // ── Admin-editable pricing (saved in MongoDB, so no redeploy is needed) ───
  // markups: global % for numbers / products (fall back to the env values).
  // rules:   per-service (numbers) and per-product overrides: a fixed price,
  //          or a markup % for that one service, and a hide switch.
  const ruleSchema = new mongoose.Schema({
    itemId: { type: String, required: true },
    name: { type: String, default: '' },
    price: { type: Number, default: null },   // fixed selling price in NGN (per number / per unit)
    markup: { type: Number, default: null },  // markup % for this item only (numbers)
    hidden: { type: Boolean, default: false }
  }, { _id: false });
  const settingsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    numbersMarkup: { type: Number, default: null },
    productsMarkup: { type: Number, default: null },
    numberRules: { type: [ruleSchema], default: [] },
    productRules: { type: [ruleSchema], default: [] },
    updatedAt: { type: Date, default: Date.now }
  });
  const Settings = mongoose.models.BenotpSettings || mongoose.model('BenotpSettings', settingsSchema);
  let cfg = { at: 0, numbersMarkup: null, productsMarkup: null, numberRules: {}, productRules: {} };
  const toMap = (arr) => { const m = {}; (arr || []).forEach(r => { m[r.itemId] = { name: r.name, price: r.price, markup: r.markup, hidden: !!r.hidden }; }); return m; };
  async function loadCfg(force) {
    if (!force && Date.now() - cfg.at < 15000) return cfg;
    try {
      const d = await Settings.findOne({ key: 'main' }).lean();
      cfg = { at: Date.now(), numbersMarkup: d ? d.numbersMarkup : null, productsMarkup: d ? d.productsMarkup : null,
        numberRules: toMap(d && d.numberRules), productRules: toMap(d && d.productRules) };
    } catch (e) { cfg.at = Date.now(); }
    return cfg;
  }
  const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const numbersPct = () => hasNum(cfg.numbersMarkup) ? Number(cfg.numbersMarkup) : markupNumbers();
  const productsPct = () => hasNum(cfg.productsMarkup) ? Number(cfg.productsMarkup) : markupProducts();
  function numberSell(cost, serviceId) {
    const r = cfg.numberRules[serviceId] || {};
    if (hasNum(r.price) && Number(r.price) > 0) return Math.ceil(Number(r.price));
    return sell(cost, hasNum(r.markup) ? Number(r.markup) : numbersPct());
  }
  function productSell(cost, productId) {
    const r = cfg.productRules[productId] || {};
    if (hasNum(r.price) && Number(r.price) > 0) return Math.ceil(Number(r.price));
    return sell(cost, productsPct());
  }

  // ── Model: one collection for number + product orders ────────────────────
  const orderSchema = new mongoose.Schema({
    kind: { type: String, enum: ['number', 'product'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    userEmail: String,
    title: String,
    providerOrderId: String,
    phoneNumber: String,
    service: String,
    country: String,
    productId: String,
    quantity: { type: Number, default: 1 },
    cost: { type: Number, default: 0 },
    sellPrice: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }, // pending | completed | cancelled | expired | failed | review
    code: { type: String, default: '' },
    details: { type: String, default: '' },
    note: { type: String, default: '' },
    refunded: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  const Order = mongoose.models.BenotpOrder || mongoose.model('BenotpOrder', orderSchema);

  // ── Provider client ───────────────────────────────────────────────────────
  class ProviderError extends Error {
    constructor(msg, ambiguous) { super(msg); this.ambiguous = !!ambiguous; }
  }
  const parseBody = (raw) => {
    if (raw && typeof raw === 'object') return raw;
    const t = String(raw == null ? '' : raw).trim();
    try { return JSON.parse(t); } catch (e) { return t; }
  };
  function providerErrorText(d) {
    if (typeof d === 'string') {
      if (/^(NO_|BAD_|ERROR|WRONG_|BANNED|ACCOUNT_|INVALID)/i.test(d)) return d;
      return '';
    }
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const st = String(d.status || d.success || '').toLowerCase();
      if (d.error) return typeof d.error === 'string' ? d.error : (d.error.message || 'Provider error');
      if (['error', 'failed', 'fail', 'false'].includes(st) || d.success === false) return String(d.message || d.msg || 'Provider error');
    }
    return '';
  }
  async function call(path, params, opts) {
    const key = apiKey();
    if (!key) throw new ProviderError('This service is not set up yet. Please contact support.', false);
    let res;
    try {
      res = await axios.request({
        method: (opts && opts.method) || 'GET',
        url: baseUrl() + path,
        params: (opts && opts.method === 'POST') ? undefined : { ...params, api_key: key },
        data: (opts && opts.method === 'POST') ? new URLSearchParams({ ...params, api_key: key }).toString() : undefined,
        headers: (opts && opts.method === 'POST') ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } : { Accept: 'application/json' },
        timeout: (opts && opts.timeout) || 30000,
        responseType: 'text',
        transformResponse: [(x) => x],
        validateStatus: () => true
      });
    } catch (e) {
      throw new ProviderError('The provider could not be reached.', true);
    }
    if (res.status >= 500) throw new ProviderError('The provider is having problems right now.', true);
    const data = parseBody(res.data);
    if (res.status >= 400) throw new ProviderError(providerErrorText(data) || ('Provider refused the request (' + res.status + ').'), false);
    const err = providerErrorText(data);
    if (err) throw new ProviderError(err, false);
    return data;
  }

  // ── Tolerant readers (the provider's JSON layout is not fixed in the docs) ─
  const unwrap = (d) => {
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const k of ['data', 'result', 'results', 'services', 'countries', 'products', 'items', 'list']) {
        if (d[k] != null && typeof d[k] === 'object') return d[k];
      }
    }
    return d;
  };
  function toList(d) {
    d = unwrap(d);
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') return Object.keys(d).map(k => {
      const v = d[k];
      return (v && typeof v === 'object') ? { id: k, ...v } : { id: k, name: v };
    });
    return [];
  }
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined; };
  function deepFind(o, keys, depth) {
    if (o == null || depth > 4) return undefined;
    if (typeof o === 'object') {
      const v = pick(o, keys); if (v !== undefined && typeof v !== 'object') return v;
      for (const k of Object.keys(o)) { const r = deepFind(o[k], keys, depth + 1); if (r !== undefined) return r; }
    }
    return undefined;
  }
  function normItem(it) {
    if (typeof it === 'string') return { id: it, name: it };
    const id = pick(it, ['id', 'code', 'key', 'short', 'iso', 'service', 'country', 'value', 'slug']);
    const name = pick(it, ['name', 'title', 'label', 'service_name', 'country_name', 'text']) || id;
    return { id: String(id), name: String(name), raw: it };
  }
  function readPrice(d) {
    if (typeof d === 'number') return d;
    if (typeof d === 'string') { const m = d.match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; }
    const v = deepFind(d, ['price', 'cost', 'amount', 'rate']);
    return v === undefined ? NaN : Number(v);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const busy = new Set();
  const lockUser = (id) => { id = String(id); if (busy.has(id)) return false; busy.add(id); setTimeout(() => busy.delete(id), 60000); return true; };
  const unlockUser = (id) => busy.delete(String(id));
  const clientMsg = (e) => (e && e.message && !/ECONN|ENOTFOUND|timeout/i.test(e.message)) ? e.message : 'Something went wrong. Please try again.';

  async function refund(orderId, reason, newStatus) {
    const o = await Order.findOneAndUpdate({ _id: orderId, refunded: false }, { $set: { refunded: true, status: newStatus, note: reason, updatedAt: new Date() } });
    if (!o) return false;
    await User.updateOne({ _id: o.userId }, { $inc: { balance: o.sellPrice } });
    try { await Transaction.create({ userId: o.userId, type: 'refund', amount: o.sellPrice, description: 'Refund - ' + (o.title || o.kind), status: 'success' }); } catch (e) { /* ledger is best-effort */ }
    return true;
  }
  async function debit(user, amount, title) {
    const u = await User.findOneAndUpdate({ _id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
    if (u) { try { await Transaction.create({ userId: user._id, type: 'purchase', amount, description: title, status: 'success' }); } catch (e) { /* best-effort */ } }
    return u;
  }

  // ═════════════════════════ SMS NUMBERS ═══════════════════════════════════
  let svcCache = { at: 0, v: null }, ctyCache = { at: 0, v: null };
  const fresh = (c) => c.v && Date.now() - c.at < 10 * 60 * 1000;

  app.get('/api/rado/numbers/services', auth, async (req, res) => {
    try {
      await loadCfg();
      if (!fresh(svcCache)) svcCache = { at: Date.now(), v: toList(await call(NUMBERS_PATH, { action: 'getServices' })).map(normItem).map(({ id, name }) => ({ id, name })) };
      res.json(svcCache.v.filter(x => !(cfg.numberRules[x.id] || {}).hidden));
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/countries', auth, async (req, res) => {
    try {
      if (!fresh(ctyCache)) ctyCache = { at: Date.now(), v: toList(await call(NUMBERS_PATH, { action: 'getCountries' })).map(normItem).map(({ id, name }) => ({ id, name })) };
      res.json(ctyCache.v);
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  async function numberPrice(service, country) {
    const d = await call(NUMBERS_PATH, { action: 'getPrice', service, country, pool: 1 });
    const cost = readPrice(d);
    if (!Number.isFinite(cost) || cost <= 0) throw new ProviderError('No number available for this service and country right now.', false);
    return cost;
  }
  app.get('/api/rado/numbers/price', auth, async (req, res) => {
    try {
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.status(400).json({ error: 'Choose a service and a country.' });
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      const cost = await numberPrice(service, country);
      res.json({ price: numberSell(cost, service) });
    } catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });

  app.post('/api/rado/numbers/buy', auth, async (req, res) => {
    const service = String(req.body.service || ''), country = String(req.body.country || '');
    if (!service || !country) return res.status(400).json({ error: 'Choose a service and a country.' });
    if (!lockUser(req.user._id)) return res.status(429).json({ error: 'Please wait, your last request is still running.' });
    let order;
    try {
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      let cost;
      try { cost = await numberPrice(service, country); } catch (e) { return res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
      const price = numberSell(cost, service);
      const expected = Number(req.body.expectedPrice);
      if (Number.isFinite(expected) && expected > 0 && price > expected) return res.status(409).json({ error: 'The price changed to ₦' + price.toLocaleString() + '. Please try again.', price });
      const svcName = ((svcCache.v || []).find(s => s.id === service) || {}).name || service;
      const ctyName = ((ctyCache.v || []).find(c => c.id === country) || {}).name || country;
      order = await Order.create({ kind: 'number', userId: req.user._id, userEmail: req.user.email, title: svcName + ' number (' + ctyName + ')', service: svcName, country: ctyName, cost, sellPrice: price, status: 'pending' });
      const user = await debit(req.user, price, 'SMS number - ' + svcName + ' (' + ctyName + ')');
      if (!user) { await Order.updateOne({ _id: order._id }, { $set: { status: 'failed', refunded: true, note: 'Insufficient balance' } }); return res.status(400).json({ error: 'Insufficient balance. Please fund your wallet.' }); }
      let d;
      try { d = await call(NUMBERS_PATH, { action: 'getNumber', service, country, quantity: 1, pool: 1 }, { timeout: 45000 }); }
      catch (e) {
        if (!e.ambiguous) { await refund(order._id, e.message, 'failed'); return res.status(400).json({ error: clientMsg(e) + ' Nothing was charged.' }); }
        await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Provider outcome unknown: ' + e.message, updatedAt: new Date() } });
        console.error('[benotp] number order held for review', String(order._id));
        return res.status(202).json({ pending: true, message: 'We could not confirm your order. If a number was issued it will appear in your orders; otherwise contact support to be refunded.' });
      }
      let id, phone;
      if (typeof d === 'string') { const m = d.match(/ACCESS_NUMBER:([^:]+):(\+?\d+)/i); if (m) { id = m[1]; phone = m[2]; } }
      else { id = deepFind(d, ['order_id', 'orderId', 'activation_id', 'activationId', 'request_id', 'id']); phone = deepFind(d, ['number', 'phone', 'phone_number', 'phoneNumber', 'mdn', 'msisdn']); }
      if (!id || !phone) {
        await refund(order._id, 'Provider returned no number', 'failed');
        console.error('[benotp] getNumber unreadable answer:', JSON.stringify(d).slice(0, 300));
        return res.status(502).json({ error: 'No number was issued. Nothing was charged.' });
      }
      await Order.updateOne({ _id: order._id }, { $set: { providerOrderId: String(id), phoneNumber: String(phone), updatedAt: new Date() } });
      res.json({ ok: true, orderId: String(order._id), phoneNumber: String(phone), newBalance: user.balance });
    } catch (e) {
      console.error('[benotp] number buy failed:', e.message);
      res.status(500).json({ error: 'Purchase failed. If you were charged, contact support and you will be refunded.' });
    } finally { unlockUser(req.user._id); }
  });

  function readStatus(d) {
    if (typeof d === 'string') {
      let m = d.match(/STATUS_OK:(.+)/i); if (m) return { code: (m[1].match(/\d{3,8}/) || [m[1]])[0].trim() };
      if (/STATUS_CANCEL/i.test(d)) return { cancelled: true };
      return {};
    }
    const raw = deepFind(d, ['code', 'otp', 'pin', 'sms', 'text', 'message']);
    const st = String(deepFind(d, ['status', 'state']) || '').toLowerCase();
    let code = '';
    if (raw != null && !/wait|pending|no sms/i.test(String(raw))) { const m = String(raw).match(/\d{3,8}/); code = m ? m[0] : ''; }
    return { code, cancelled: /cancel|refund/.test(st), expired: /expire|timeout/.test(st) };
  }
  const shape = (o) => ({ id: String(o._id), phoneNumber: o.phoneNumber, service: o.service, country: o.country, status: o.status, code: o.code, sellPrice: o.sellPrice, createdAt: o.createdAt });

  app.get('/api/rado/numbers/status/:id', auth, async (req, res) => {
    try {
      const o = await Order.findOne({ _id: req.params.id, userId: req.user._id, kind: 'number' });
      if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.status === 'pending' && o.providerOrderId) {
        let s = {};
        try { s = readStatus(await call(NUMBERS_PATH, { action: 'getStatus', order_id: o.providerOrderId })); } catch (e) { /* keep waiting */ }
        if (s.code) { o.code = s.code; o.status = 'completed'; o.updatedAt = new Date(); await o.save(); }
        else if (s.cancelled || s.expired) { await refund(o._id, 'Cancelled by provider', 'cancelled'); }
        else if (Date.now() - new Date(o.createdAt).getTime() > ttlMs()) {
          try { await call(NUMBERS_PATH, { action: 'setStatus', order_id: o.providerOrderId, status: 8 }); } catch (e) { /* still refund: no SMS arrived */ }
          await refund(o._id, 'No SMS received in time', 'expired');
        }
      }
 
