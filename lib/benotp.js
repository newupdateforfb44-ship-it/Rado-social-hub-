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
  const baseUrl = () => String(process.env.BENOTP_BASE_URL || 'https://benotp.com').replace(/\/+$/, '');
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
        headers: (opts && opts.method === 'POST') ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
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
      res.json(shape(await Order.findById(o._id)));
    } catch (e) { res.status(500).json({ error: 'Could not check the status.' }); }
  });
  app.post('/api/rado/numbers/cancel/:id', auth, async (req, res) => {
    try {
      const o = await Order.findOne({ _id: req.params.id, userId: req.user._id, kind: 'number' });
      if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.status !== 'pending') return res.status(400).json({ error: 'This order can no longer be cancelled.' });
      try {
        const s = readStatus(await call(NUMBERS_PATH, { action: 'getStatus', order_id: o.providerOrderId }));
        if (s.code) { o.code = s.code; o.status = 'completed'; await o.save(); return res.status(400).json({ error: 'The code has already arrived, so this order cannot be cancelled.' }); }
        await call(NUMBERS_PATH, { action: 'setStatus', order_id: o.providerOrderId, status: 8 });
      } catch (e) { return res.status(400).json({ error: clientMsg(e) }); }
      await refund(o._id, 'Cancelled by customer', 'cancelled');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not cancel.' }); }
  });
  app.get('/api/rado/numbers/my-orders', auth, async (req, res) => {
    const rows = await Order.find({ userId: req.user._id, kind: 'number' }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(rows.map(r => ({ ...shape(r), id: String(r._id) })));
  });

  // ═════════════════════════ PRODUCTS (Buy Accounts) ═══════════════════════
  let prodCache = { at: 0, v: null };
  async function loadProducts(force) {
    if (!force && prodCache.v && Date.now() - prodCache.at < 60 * 1000) return prodCache.v;
    await loadCfg(force);
    const list = toList(await call(PRODUCTS_PATH, { action: 'getProducts' })).map(it => {
      const id = pick(it, ['id', 'product_id', 'productId']);
      const cost = Number(pick(it, ['price', 'cost', 'amount', 'rate']));
      if (id == null || !Number.isFinite(cost)) return null;
      const stockRaw = pick(it, ['stock', 'quantity', 'qty', 'available', 'in_stock', 'count']);
      return {
        id: String(id), title: String(pick(it, ['name', 'title', 'product_name']) || ('Product ' + id)),
        category: String(pick(it, ['category', 'category_name', 'type', 'group']) || 'Other'),
        cost, price: productSell(cost, String(id)), stock: stockRaw == null ? null : Number(stockRaw),
        picture: String(pick(it, ['image', 'icon', 'logo', 'picture', 'img']) || ''),
        description: String(pick(it, ['description', 'details', 'info']) || '')
      };
    }).filter(Boolean);
    prodCache = { at: Date.now(), v: list };
    return list;
  }
  const visibleProducts = (list) => list.filter(p => !(cfg.productRules[p.id] || {}).hidden);
  const publicProduct = ({ cost, ...p }) => p;
  app.get('/api/rado/products', auth, async (req, res) => {
    try { const all = await loadProducts(); res.json(visibleProducts(all).map(publicProduct)); }
    catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/products/categories', auth, async (req, res) => {
    try { const all = await loadProducts(); res.json([...new Set(visibleProducts(all).map(p => p.category))].sort().map(name => ({ name }))); }
    catch (e) { res.json([]); }
  });

  function formatDelivery(d) {
    const body = (d && typeof d === 'object' && !Array.isArray(d) && d.data != null) ? d.data : d;
    if (typeof body === 'string') return body;
    const line = (x) => typeof x === 'string' ? x : (x && typeof x === 'object' ? Object.keys(x).map(k => k + ': ' + (typeof x[k] === 'object' ? JSON.stringify(x[k]) : x[k])).join(' | ') : String(x));
    if (Array.isArray(body)) return body.map(line).join('\n');
    return line(body);
  }
  app.post('/api/rado/products/buy', auth, async (req, res) => {
    const id = String(req.body.id || ''), amount = Math.max(1, Math.min(100, parseInt(req.body.amount, 10) || 1));
    if (!id) return res.status(400).json({ error: 'Choose a product.' });
    if (!lockUser(req.user._id)) return res.status(429).json({ error: 'Please wait, your last request is still running.' });
    try {
      let product;
      try { product = (await loadProducts(true)).find(p => p.id === id); } catch (e) { return res.status(502).json({ error: clientMsg(e) }); }
      if (!product || (cfg.productRules[product.id] || {}).hidden) return res.status(404).json({ error: 'This product is no longer available.' });
      if (product.stock != null && product.stock < amount) return res.status(400).json({ error: 'Not enough stock. Only ' + product.stock + ' left.' });
      const total = product.price * amount;
      const order = await Order.create({ kind: 'product', userId: req.user._id, userEmail: req.user.email, title: product.title, productId: id, quantity: amount, cost: product.cost * amount, sellPrice: total, status: 'pending' });
      const user = await debit(req.user, total, 'Bought ' + product.title);
      if (!user) { await Order.updateOne({ _id: order._id }, { $set: { status: 'failed', refunded: true, note: 'Insufficient balance' } }); return res.status(400).json({ error: 'Insufficient balance. Please fund your wallet.' }); }
      let d;
      try { d = await call(PRODUCTS_PATH, { action: 'buyProduct', id, amount }, { method: 'POST', timeout: 60000 }); }
      catch (e) {
        // POLICY: products are never auto-refunded - a "failed" answer is often just a network glitch. Admin decides.
        await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: (e.ambiguous ? 'Provider outcome unknown: ' : 'Provider reported a failure: ') + e.message + ' - money held, admin to send the log or refund.', updatedAt: new Date() } });
        console.error('[benotp] product order held for review', String(order._id));
        return res.status(202).json({ pending: true, message: 'We could not confirm your order. If it went through it will appear in your Orders; otherwise contact support to be refunded.' });
      }
      const details = formatDelivery(d);
      await Order.updateOne({ _id: order._id }, { $set: { status: 'completed', details, providerOrderId: String(deepFind(d, ['order_id', 'orderId', 'id']) || ''), updatedAt: new Date() } });
      // Save to the customer's purchases FIRST (retry), so the delivery can never be lost.
      for (let i = 0; i < 3; i++) {
        try { await User.updateOne({ _id: user._id }, { $push: { purchaseDetails: { logId: order._id, logTitle: product.title, logType: 'log', logDetails: details, pricePaid: total, source: 'benotp', purchasedAt: new Date() } } }); break; }
        catch (e) { await new Promise(r => setTimeout(r, 300 * (i + 1))); }
      }
      prodCache = { at: 0, v: null };
      res.json({ ok: true, logTitle: product.title, logDetails: details, newBalance: user.balance });
    } catch (e) {
      console.error('[benotp] product buy failed:', e.message);
      res.status(500).json({ error: 'Purchase failed. If you were charged, contact support and you will be refunded.' });
    } finally { unlockUser(req.user._id); }
  });

  // ═════════════════════════ ADMIN: PRICES & MARKUP ════════════════════════
  // Everything the admin panel's "Services & Prices" page needs. Writes are owner-only.
  const clampPct = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : NaN; };
  const clampPrice = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 100000000 ? Math.round(n * 100) / 100 : NaN; };

  app.get('/api/rado/admin/pricing', anyAdminAuth, async (req, res) => {
    try {
      await loadCfg(true);
      const out = { markups: { numbers: numbersPct(), products: productsPct(), numbersIsCustom: hasNum(cfg.numbersMarkup), productsIsCustom: hasNum(cfg.productsMarkup) },
        multiplier: multiplier(), numbers: [], products: [], errors: {} };
      try {
        const svc = toList(await call(NUMBERS_PATH, { action: 'getServices' })).map(normItem);
        out.numbers = svc.map(x => ({ id: x.id, name: (cfg.numberRules[x.id] || {}).name || x.name, ...(cfg.numberRules[x.id] ? { price: cfg.numberRules[x.id].price, markup: cfg.numberRules[x.id].markup, hidden: !!cfg.numberRules[x.id].hidden } : { price: null, markup: null, hidden: false }) }));
      } catch (e) { out.errors.numbers = e.message; }
      try {
        const list = await loadProducts(true);
        out.products = list.map(p => { const r = cfg.productRules[p.id] || {}; return { id: p.id, title: p.title, category: p.category, cost: Math.ceil(p.cost * multiplier()), price: p.price, stock: p.stock, customPrice: hasNum(r.price) ? Number(r.price) : null, hidden: !!r.hidden }; });
      } catch (e) { out.errors.products = e.message; }
      res.json(out);
    } catch (e) { res.status(500).json({ error: 'Could not load prices.' }); }
  });

  app.put('/api/rado/admin/pricing/markups', adminAuth, async (req, res) => {
    const n = clampPct(req.body.numbers), p = clampPct(req.body.products);
    if (Number.isNaN(n) || Number.isNaN(p)) return res.status(400).json({ error: 'Markup must be a percentage between 0 and 1000.' });
    try {
      await Settings.updateOne({ key: 'main' }, { $set: { numbersMarkup: n, productsMarkup: p, updatedAt: new Date() }, $setOnInsert: { key: 'main' } }, { upsert: true });
      prodCache = { at: 0, v: null }; await loadCfg(true);
      res.json({ ok: true, numbers: numbersPct(), products: productsPct() });
    } catch (e) { res.status(500).json({ error: 'Could not save the markup.' }); }
  });

  // One rule per service (kind "number") or product (kind "product"). Sending no price, no markup and hidden=false removes the rule.
  app.put('/api/rado/admin/pricing/rule', adminAuth, async (req, res) => {
    const kind = req.body.kind === 'product' ? 'product' : (req.body.kind === 'number' ? 'number' : '');
    const itemId = String(req.body.id || '').trim().slice(0, 120);
    if (!kind || !itemId) return res.status(400).json({ error: 'Missing service.' });
    const price = clampPrice(req.body.price), markup = kind === 'number' ? clampPct(req.body.markup) : null;
    if (Number.isNaN(price)) return res.status(400).json({ error: 'Enter a valid price in naira.' });
    if (Number.isNaN(markup)) return res.status(400).json({ error: 'Markup must be a percentage between 0 and 1000.' });
    const hidden = req.body.hidden === true;
    const field = kind === 'number' ? 'numberRules' : 'productRules';
    try {
      await Settings.updateOne({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true });
      await Settings.updateOne({ key: 'main' }, { $pull: { [field]: { itemId } } });
      if (price !== null || markup !== null || hidden) {
        await Settings.updateOne({ key: 'main' }, { $push: { [field]: { itemId, name: String(req.body.name || '').slice(0, 160), price, markup, hidden } }, $set: { updatedAt: new Date() } });
      }
      prodCache = { at: 0, v: null }; await loadCfg(true);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not save.' }); }
  });

  // Preview: provider cost and the price a customer would see for one service + country.
  app.get('/api/rado/admin/numbers/preview', anyAdminAuth, async (req, res) => {
    try {
      await loadCfg(true);
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.status(400).json({ error: 'Choose a service and a country.' });
      const cost = await numberPrice(service, country);
      res.json({ cost: Math.ceil(cost * multiplier()), price: numberSell(cost, service) });
    } catch (e) { res.status(400).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/admin/numbers/countries', anyAdminAuth, async (req, res) => {
    try {
      if (!fresh(ctyCache)) ctyCache = { at: Date.now(), v: toList(await call(NUMBERS_PATH, { action: 'getCountries' })).map(normItem).map(({ id, name }) => ({ id, name })) };
      res.json(ctyCache.v);
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });

  // Orders the admin should look at (held for review, or failed without a refund) + manual refund.
  app.get('/api/rado/admin/orders', anyAdminAuth, async (req, res) => {
    try {
      const q = req.query.status === 'attention' ? { $or: [{ status: 'review' }, { status: 'failed', refunded: false }] } : {};
      const rows = await Order.find(q).sort({ createdAt: -1 }).limit(100).lean();
      res.json(rows.map(o => ({ id: String(o._id), kind: o.kind, userEmail: o.userEmail, title: o.title, sellPrice: o.sellPrice, status: o.status, note: o.note, refunded: !!o.refunded, createdAt: o.createdAt })));
    } catch (e) { res.status(500).json({ error: 'Could not load orders.' }); }
  });
  app.post('/api/rado/admin/orders/:id/refund', adminAuth, async (req, res) => {
    try {
      const done = await refund(req.params.id, 'Refunded by admin', 'failed');
      if (!done) return res.status(400).json({ error: 'This order was already refunded or does not exist.' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not refund.' }); }
  });

  // Balance only (used by the low-balance alert and the daily summary email).
  app.get('/api/rado/admin/benotp-balance', anyAdminAuth, async (req, res) => {
    try { res.json({ balance: await call(NUMBERS_PATH, { action: 'getBalance' }) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ── Admin: see what the provider really answers (no key is ever returned) ─
  app.get('/api/rado/admin/benotp-test', anyAdminAuth, async (req, res) => {
    const out = { keySet: !!apiKey(), baseUrl: baseUrl(), markupNumbers: numbersPct(), markupProducts: productsPct(), multiplier: multiplier() };
    const tries = { balance: () => call(NUMBERS_PATH, { action: 'getBalance' }), services: () => call(NUMBERS_PATH, { action: 'getServices' }),
      countries: () => call(NUMBERS_PATH, { action: 'getCountries' }), products: () => call(PRODUCTS_PATH, { action: 'getProducts' }) };
    for (const k of Object.keys(tries)) {
      try { const d = await tries[k](); out[k] = { ok: true, sample: JSON.stringify(d).slice(0, 600) }; }
      catch (e) { out[k] = { ok: false, error: e.message }; }
    }
    res.json(out);
  });
}

module.exports = { register };
