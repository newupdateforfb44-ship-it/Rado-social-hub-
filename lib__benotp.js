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
//   GET  /api/rado/numbers/countries | /services | /pools?service=&country= | /price?service=&country=&pool=
//   POST /api/rado/numbers/buy          { country, service, pool, expectedPrice }   (flow: country -> service -> pool -> confirm)
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
  // Marketplace = RakibSocials (same Marketplace 2 as the Marvel Nums site). Needs RAKIB_API_KEY on Render.
  // LOGOS: every product (provider products AND logs the admin adds by hand) gets its logo from
  //   1) the old brand-logo table (only when USE_LEGACY_BRAND_LOGOS=true), then
  //   2) Admin -> Services & Prices -> "Product logos (by name)"  (stored in the database, always on).
  // marketLogo() is used lazily (when a customer opens Products), by which time loadLogos/logoFor below exist.
  const marketLogo = async (title, category) => {
    let u = '';
    if (typeof deps.brandLogoFor === 'function') { try { u = await deps.brandLogoFor(title, category); } catch (e) { u = ''; } }
    if (u) return u;
    await loadLogos();
    return logoFor(title, category);
  };
  const marketHooks = {};
  try {
    const market = require('./market2').register(app, { mongoose, User, Transaction, auth, anyAdminAuth, sendAdminEmail: deps.sendAdminEmail || (async () => ({ sent: false })), brandLogoFor: marketLogo, hooks: marketHooks });
    // Logs the admin adds by hand (Admin -> Add logs) are sold through the same marketplace.
    try { require('./rado-logs').register(app, { mongoose, User, Transaction, auth, anyAdminAuth, adminAuth, market, hooks: marketHooks, logoFor: marketLogo }); }
    catch (e) { console.error('[rado-logs] could not start:', e.message); }
  } catch (e) { console.error('[market2] could not start:', e.message); }

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
  // Everything is in Naira: no dollar/rate multiplier (same as the working site). The old BENOTP_PRICE_MULTIPLIER setting is ignored.
  const multiplier = () => 1;
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
    // A custom price is never allowed below the provider price (same rule as the working site).
    if (hasNum(r.price) && Number(r.price) > 0) return Math.max(Math.ceil(Number(r.price)), Math.ceil(Number(cost) || 0));
    return Math.max(sell(cost, productsPct()), Math.ceil(Number(cost) || 0));
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
    pool: String,
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
    const money = (v) => { if (v == null || v === '' || typeof v === 'object') return NaN; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
    // First look for price-like keys anywhere in the answer (first value above 0), then "amount" as a last resort.
    const find = (re) => {
      let found = NaN;
      const walk = (o, depth) => {
        if (found > 0 || o == null || typeof o !== 'object' || depth > 5) return;
        for (const k of Object.keys(o)) { if (o[k] != null && typeof o[k] !== 'object' && re.test(k)) { const n = money(o[k]); if (n > 0) { found = n; return; } } }
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      };
      walk(d, 0);
      return found;
    };
    const v = find(/price|cost|rate/i);
    return v > 0 ? v : find(/amount/i);
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
  // Services + countries change rarely, so they are kept in memory: served instantly (even when slightly old),
  // refreshed in the background, and pre-loaded when the server starts. Customers never wait for the provider here.
  let svcCache = { at: 0, v: null }, ctyCache = { at: 0, v: null };
  const FRESH_MS = 10 * 60 * 1000, STALE_MS = 7 * 24 * 3600 * 1000;
  const inflight = new Map();
  const once = (key, fn) => { if (inflight.has(key)) return inflight.get(key); const p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); return p; };
  const cleanList = (d) => toList(d).map(normItem).filter(x => x.id && x.id !== 'undefined').map(({ id, name }) => ({ id, name }));
  // Saved copy in the database: survives restarts and Render "sleep", so the lists are ready the moment the server wakes up.
  const cacheSchema = new mongoose.Schema({ key: { type: String, unique: true }, data: { type: mongoose.Schema.Types.Mixed }, updatedAt: { type: Date, default: Date.now } });
  const SavedCache = mongoose.models.BenotpCache || mongoose.model('BenotpCache', cacheSchema);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const dbGet = async (key) => { try { return await withTimeout(SavedCache.findOne({ key }).lean(), 3000); } catch (e) { return null; } };
  const dbSet = (key, data) => { try { SavedCache.updateOne({ key }, { $set: { data, updatedAt: new Date() } }, { upsert: true }).catch(() => {}); } catch (e) { /* best-effort */ } };
  async function cachedList(get, set, action, key) {
    let c = get();
    if (!c.v) { const row = await dbGet('list:' + key); if (row && Array.isArray(row.data) && row.data.length) { c = { at: new Date(row.updatedAt).getTime(), v: row.data }; set(c); } }
    const age = Date.now() - c.at;
    if (c.v && age < FRESH_MS) return c.v;
    const load = () => once(key, async () => { const v = cleanList(await call(NUMBERS_PATH, { action }, { timeout: 15000 })); if (v.length) { set({ at: Date.now(), v }); dbSet('list:' + key, v); } return v; });
    if (c.v && age < STALE_MS) { load().catch(() => {}); return c.v; }
    return load();
  }
  const getSvc = () => cachedList(() => svcCache, (x) => { svcCache = x; }, 'getServices', 'svc');
  const getCty = () => cachedList(() => ctyCache, (x) => { ctyCache = x; }, 'getCountries', 'cty');
  const warm = () => { getSvc().catch(() => {}); getCty().catch(() => {}); };
  // BenOTP number pre-loading switched off: numbers now come from Grizzly SMS.

  // ═════════════════════ GRIZZLY SMS - SMS NUMBERS PROVIDER ═════════════════════
  // Same provider and same buying logic as the Marvel Nums site. These routes are registered BEFORE the old
  // BenOTP number routes, so they answer first.   Render environment:
  //   GRIZZLY_API_KEY=<your key>      GRIZZLY_USD_NGN=1650   (naira per $1; Grizzly prices are in dollars)
  //   GRIZZLY_BASE_URL (optional)     GRIZZLY_ROUND=50       (round prices up to the nearest N naira)
  const crypto = require('crypto');
  const GZ_ERRORS = {
    BAD_KEY: 'The number provider rejected our API key. Please contact support.',
    BAD_ACTION: 'The number provider rejected the request.',
    NO_BALANCE: 'Numbers are temporarily unavailable. Please try again later or contact support.',
    NO_NUMBERS: 'No numbers are available for that choice right now. Try another country or pool.',
    WRONG_SERVICE: 'That service is not available for sale. Pick another one.',
    SERVICE_UNAVAILABLE_REGION: 'That service is blocked in this region right now.',
    NO_ACTIVATION: 'That order no longer exists on the provider side.',
    EARLY_CANCEL_DENIED: 'You can only cancel 2 minutes after buying the number. Please wait a little and try again.'
  };
  const gzKey = () => String(process.env.GRIZZLY_API_KEY || '').trim();
  const gzBase = () => String(process.env.GRIZZLY_BASE_URL || 'https://api.grizzlysms.com/stubs/handler_api.php').trim();
  const gzRate = () => { const n = Number(process.env.GRIZZLY_USD_NGN); return n > 0 ? n : 1650; };
  const gzRound = () => { const n = Number(process.env.GRIZZLY_ROUND); return n > 0 ? n : 50; };

  async function gzCall(action, params) {
    if (!gzKey()) throw new ProviderError('Numbers are not set up yet. Please contact support.', false);
    let res;
    try {
      res = await axios.get(gzBase(), { params: { api_key: gzKey(), action, ...(params || {}) }, timeout: 25000, responseType: 'text', transformResponse: [(x) => x], validateStatus: () => true });
    } catch (e) { throw new ProviderError('Could not reach the number provider. Please try again shortly.', true); }
    if (res.status >= 500) throw new ProviderError('The number provider is having problems right now.', true);
    const text = String(res.data == null ? '' : res.data).trim();
    let body = text;
    if (/^[\[{]/.test(text)) { try { body = JSON.parse(text); } catch (e) { /* keep text */ } }
    if (typeof body === 'string' && /^[A-Z_]+$/.test(body) && !body.startsWith('STATUS_') && !body.startsWith('ACCESS_')) {
      throw new ProviderError(GZ_ERRORS[body] || ('The number provider said: ' + body), false);
    }
    return body;
  }
  const gzMem = new Map();
  async function gzCached(key, ttl, fn) {
    const c = gzMem.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    const v = await fn();
    gzMem.set(key, { at: Date.now(), v });
    if (gzMem.size > 500) gzMem.delete(gzMem.keys().next().value);
    return v;
  }
  const prettyName = (n) => String(n || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  async function gzServices() {
    return gzCached('svc', 60 * 60 * 1000, async () => {
      const r = await gzCall('getServicesList');
      const list = (r && Array.isArray(r.services) ? r.services : []).filter(x => x && x.code).map(x => ({ id: String(x.code), name: prettyName(x.name || x.code) }));
      if (!list.length) throw new ProviderError('Services could not be loaded. Please try again shortly.', false);
      return list.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
  async function gzCountries() {
    return gzCached('cty', 60 * 60 * 1000, async () => {
      const r = await gzCall('getCountries');
      const list = Object.values(r && typeof r === 'object' ? r : {}).filter(c => c && c.id != null && c.visible !== 0).map(c => ({ id: String(c.id), name: prettyName(c.eng || c.rus || c.id) }));
      if (!list.length) throw new ProviderError('Countries could not be loaded. Please try again shortly.', false);
      return list.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
  // Grizzly "pools" are price tiers: { "0.25": 1200, "0.40": 90 } = dollar price -> numbers in stock.
  async function gzTiers(service, country, fresh) {
    const get = async () => {
      const d = await gzCall('getPricesV2', { service, country });
      const t = (d && d[country] && d[country][service]) || {};
      return Object.keys(t).filter(k => Number(t[k]) > 0 && Number(k) > 0).map(k => ({ usd: Number(k), count: Number(t[k]) })).sort((a, b) => a.usd - b.usd);
    };
    return fresh ? get() : gzCached('p:' + service + ':' + country, 20 * 1000, get);
  }
  const gzPoolId = (service, country, usd) => crypto.createHash('sha256').update([service, country, usd, process.env.GRIZZLY_API_KEY || 'x'].join('|')).digest('hex').slice(0, 14);
  // Price in naira: a fixed admin price wins; otherwise the admin markup % if one is set; otherwise the default profit ladder.
  const GZ_LADDER = [[500, 300], [999, 450], [5000, 700], [10000, 1000]];
  function gzSell(usd, service) {
    const costNgn = Math.round(Number(usd) * gzRate());
    const r = cfg.numberRules[service] || {};
    if (hasNum(r.price) && Number(r.price) > 0) return Math.max(Math.ceil(Number(r.price)), costNgn);
    let price;
    if (hasNum(r.markup) || hasNum(cfg.numbersMarkup) || markupNumbers() > 0) price = sell(costNgn, hasNum(r.markup) ? Number(r.markup) : numbersPct());
    else {
      const tier = GZ_LADDER.find(t => costNgn <= t[0]);
      price = costNgn + (tier ? tier[1] : Math.round(costNgn * 0.2));
    }
    const step = gzRound();
    return Math.max(costNgn, Math.ceil(price / step) * step);
  }
  async function gzCode(o) {
    try {
      const t = String(await gzCall('getStatus', { id: o.providerOrderId }) || '').trim();
      if (t.startsWith('STATUS_OK:')) { const c = t.slice('STATUS_OK:'.length).trim(); return { code: c, message: c }; }
      if (t.startsWith('STATUS_CANCEL')) return { cancelled: true };
      return null; // STATUS_WAIT_CODE etc: nothing yet
    } catch (e) { return (e && e.ambiguous) ? undefined : null; } // undefined = could not check (provider unreachable)
  }
  async function gzCancel(o) { // throws if the provider refuses (e.g. the 2-minute rule)
    const t = String(await gzCall('setStatus', { id: o.providerOrderId, status: 8 }) || '').trim();
    if (!/ACCESS_CANCEL|ACCESS_ACTIVATION/i.test(t)) throw new ProviderError('The provider did not confirm the cancellation. Please try again in a moment.', false);
  }
  const gzFinished = (o) => { gzCall('setStatus', { id: o.providerOrderId, status: 6 }).catch(() => {}); };

  app.get('/api/rado/numbers/countries', auth, async (req, res) => {
    try { res.json(await gzCountries()); } catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/services', auth, async (req, res) => {
    try { await loadCfg(); res.json((await gzServices()).filter(s => !(cfg.numberRules[s.id] || {}).hidden)); }
    catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/pools', auth, async (req, res) => {
    try {
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.json([]);
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.json([]);
      const tiers = await gzTiers(service, country);
      res.json(tiers.map((t, i) => ({ id: gzPoolId(service, country, t.usd), name: 'Pool ' + (i + 1), price: gzSell(t.usd, service) })).sort((a, b) => a.price - b.price));
    } catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });

  app.post('/api/rado/numbers/buy', auth, async (req, res) => {
    const service = String(req.body.service || ''), country = String(req.body.country || ''), poolId = String(req.body.pool || '');
    if (!service || !country || !poolId) return res.status(400).json({ error: 'Choose a country, a service and a pool.' });
    if (!lockUser(req.user._id)) return res.status(429).json({ error: 'Please wait, your last request is still running.' });
    let order;
    try {
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available for sale.' });
      const tiers = await gzTiers(service, country, true); // live stock + price, never a stale amount
      const tier = tiers.find(t => gzPoolId(service, country, t.usd) === poolId);
      if (!tier) return res.status(400).json({ error: 'That pool just sold out. Please pick another one.' });
      const price = gzSell(tier.usd, service);
      const expected = Number(req.body.expectedPrice);
      if (Number.isFinite(expected) && expected > 0 && price > expected) return res.status(409).json({ error: 'The price changed to ₦' + price.toLocaleString() + '. Please try again.', price });
      const svcName = ((await gzServices()).find(x => x.id === service) || {}).name || service;
      const ctyName = ((await gzCountries()).find(c => c.id === country) || {}).name || country;
      const costNgn = Math.round(tier.usd * gzRate());
      order = await Order.create({ kind: 'number', userId: req.user._id, userEmail: req.user.email, title: svcName + ' number (' + ctyName + ')', service: svcName, country: ctyName, pool: poolId, cost: costNgn, sellPrice: price, status: 'pending' });
      const user = await debit(req.user, price, 'SMS number - ' + svcName + ' (' + ctyName + ')');
      if (!user) { await Order.updateOne({ _id: order._id }, { $set: { status: 'failed', refunded: true, note: 'Insufficient balance' } }); return res.status(400).json({ error: 'Insufficient balance. Please fund your wallet.' }); }
      let d;
      try { d = await gzCall('getNumberV2', { service, country, maxPrice: tier.usd }); }
      catch (e) {
        if (e.ambiguous) {
          await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Provider outcome unknown: ' + e.message, updatedAt: new Date() } });
          return res.status(202).json({ pending: true, message: 'We could not confirm your order. If a number was issued it will appear in your orders; otherwise contact support to be refunded.' });
        }
        await refund(order._id, e.message, 'failed');
        return res.status(400).json({ error: clientMsg(e) + ' Nothing was charged.' });
      }
      const aid = d && typeof d === 'object' ? d.activationId : null, phone = d && typeof d === 'object' ? d.phoneNumber : null;
      if (!aid || !phone) {
        console.error('[grizzly] buy answer unreadable:', JSON.stringify(d).slice(0, 300));
        await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Provider answer could not be read - money held, admin to check.', updatedAt: new Date() } });
        return res.status(202).json({ pending: true, message: 'We could not confirm your order. If a number was issued it will appear in your orders; otherwise contact support to be refunded.' });
      }
      await Order.updateOne({ _id: order._id }, { $set: { providerOrderId: String(aid), phoneNumber: String(phone), updatedAt: new Date() } });
      const fresh = await Order.findById(order._id);
      res.json({ ...shape(fresh), ok: true, orderId: String(order._id), phoneNumber: String(phone), newBalance: user.balance });
    } catch (e) {
      console.error('[grizzly] number buy failed:', e.message);
      res.status(500).json({ error: 'Purchase failed. If you were charged, contact support and you will be refunded.' });
    } finally { unlockUser(req.user._id); }
  });

  app.get('/api/rado/numbers/status/:id', auth, async (req, res) => {
    try {
      const o = await Order.findOne({ _id: req.params.id, userId: req.user._id, kind: 'number' });
      if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.status === 'pending' && o.providerOrderId) {
        const got = await gzCode(o);
        if (got && got.code) { o.code = got.code; o.details = got.message; o.status = 'completed'; o.updatedAt = new Date(); await o.save(); gzFinished(o); }
        else if (got && got.cancelled) await refund(o._id, 'Cancelled by provider', 'cancelled');
        else if (got !== undefined && Date.now() - new Date(o.createdAt).getTime() > ttlMs()) {
          try { await gzCancel(o); } catch (e) { /* still refund: no SMS arrived */ }
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
      const got = await gzCode(o);
      if (got === undefined) return res.status(502).json({ error: 'We could not reach the provider to check this number. Please try again in a moment.' });
      if (got && got.code) { o.code = got.code; o.details = got.message; o.status = 'completed'; await o.save(); return res.status(400).json({ error: 'The code has already arrived, so this order cannot be cancelled.' }); }
      if (!(got && got.cancelled)) {
        try { await gzCancel(o); } catch (e) { return res.status(400).json({ error: clientMsg(e) }); } // e.g. the 2-minute rule
      }
      await refund(o._id, 'Cancelled by customer', 'cancelled');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not cancel.' }); }
  });

  app.get('/api/rado/numbers/services', auth, async (req, res) => {
    try {
      await loadCfg();
      const v = await getSvc();
      res.set('Cache-Control', 'private, max-age=60').json(v.filter(x => !(cfg.numberRules[x.id] || {}).hidden));
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/countries', auth, async (req, res) => {
    try { res.set('Cache-Control', 'private, max-age=60').json(await getCty()); }
    catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  const cleanPool = (v) => { const p = String(v == null || v === '' ? '1' : v).trim(); return /^[\w.\-]{1,40}$/.test(p) ? p : '1'; };
  async function numberPrice(service, country, pool, quiet) {
    pool = cleanPool(pool);
    let d = await call(NUMBERS_PATH, { action: 'getPrice', service, country, pool }, { timeout: 10000 });
    let cost = readPrice(d);
    if (!(cost > 0)) {
      // Fallback for the other common layout: getPrices -> { country: { service: { cost, count } } }
      try {
        const d2 = await call(NUMBERS_PATH, { action: 'getPrices', service, country, pool });
        const direct = (d2 && typeof d2 === 'object') ? ((d2[country] || {})[service] || (d2[service] || {})[country]) : null;
        const c2 = direct ? readPrice(direct) : readPrice(d2);
        if (c2 > 0) { cost = c2; d = d2; }
      } catch (e) { /* keep the first answer for the log */ }
    }
    if (!(cost > 0)) {
      let snip = ''; try { snip = typeof d === 'string' ? d : JSON.stringify(d); } catch (e) {}
      if (!quiet) console.error('[benotp] price unreadable: service=' + service + ' country=' + country + ' pool=' + pool + ' reply=' + snip.slice(0, 400));
      throw new ProviderError('No number available for this pool right now. Please choose another pool.', false);
    }
    return cost;
  }
  // Step 3 of the flow: the pools the provider has for this country + service (getPools), each with the customer's price.
  const poolCache = new Map(), priceCache = new Map(); // key -> { at, v }
  const isPrim = (v) => v !== null && v !== undefined && typeof v !== 'object' && typeof v !== 'boolean';
  const META_KEY = /^(success|status|error|message|msg|code|country|service|count|total|quantity|currency|balance|areacode|area_code|carrier|time|timestamp)$/i;
  // The provider's reply has other fields around the pools (success, counts, ...). Find just the pools part.
  function poolsNode(d, depth) {
    if (d == null || typeof d !== 'object' || (depth || 0) > 3) return d;
    if (Array.isArray(d)) return d;
    for (const k of ['available_pools', 'availablePools', 'pools', 'pool_list', 'poolList', 'data', 'result', 'results']) {
      if (d[k] != null && typeof d[k] === 'object') return poolsNode(d[k], (depth || 0) + 1);
    }
    return d;
  }
  function normPool(it, key) {
    if (isPrim(it)) { const id = String(it).trim(); return id ? { id, name: 'Pool ' + id, cost: NaN, stock: null, rate: '' } : null; }
    if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
    let id = pick(it, ['pool', 'pool_id', 'poolId', 'id', 'code', 'value']);
    if (!isPrim(id)) id = key;
    if (!isPrim(id) || String(id).trim() === '') return null;
    id = String(id).trim();
    const nm = pick(it, ['name', 'title', 'label', 'pool_name', 'poolName']);
    const priceRaw = pick(it, ['price', 'cost', 'amount', 'rate']);
    const cost = isPrim(priceRaw) ? readPrice(priceRaw) : NaN;
    const stockRaw = pick(it, ['count', 'stock', 'quantity', 'qty', 'available', 'numbers', 'total']);
    const st = Number(stockRaw);
    const rateRaw = pick(it, ['success_rate', 'successRate', 'percent', 'percentage', 'quality', 'success']);
    return { id, name: (isPrim(nm) && String(nm) !== id) ? String(nm) : ('Pool ' + id), cost,
      stock: (isPrim(stockRaw) && Number.isFinite(st)) ? st : null, rate: isPrim(rateRaw) ? String(rateRaw) : '' };
  }
  function readPools(d) {
    const node = poolsNode(d, 0);
    const rows = [];
    if (Array.isArray(node)) node.forEach(x => { const r = normPool(x); if (r) rows.push(r); });
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (META_KEY.test(k) || typeof v === 'boolean' || v == null) continue;
        if (v && typeof v === 'object') { const r = normPool(Array.isArray(v) ? null : v, k); if (r) rows.push(r); }
        else if (/^[\w.\-]{1,40}$/.test(k) && !/%/.test(String(v)) && /^\d+$/.test(k)) rows.push({ id: k, name: (isPrim(v) && String(v) !== k) ? String(v) : ('Pool ' + k), cost: NaN, stock: null, rate: '' });
      }
    }
    const seen = new Set();
    return rows.filter(r => /^[\w.\-]{1,40}$/.test(r.id) && !seen.has(r.id) && seen.add(r.id));
  }
  async function poolCost(service, country, pool, quiet) {
    const key = service + '|' + country + '|' + pool, hit = priceCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
    const v = await numberPrice(service, country, pool, quiet);
    priceCache.set(key, { at: Date.now(), v });
    if (priceCache.size > 1000) priceCache.delete(priceCache.keys().next().value);
    return v;
  }
  // Fetch from the provider: the pool list and ONE shared price at the same time (the provider charges the same
  // for every pool, and the exact price is checked again at purchase time anyway).
  let poolSamples = 0;
  async function fetchPools(service, country) {
    const key = service + '|' + country;
    const poolsReq = call(NUMBERS_PATH, { action: 'getPools', service, country }, { timeout: 12000 }).then(d => ({ d }), e => ({ e }));
    const baseReq = poolCost(service, country, '1', true).then(v => v, () => NaN);
    const [pr, base] = await Promise.all([poolsReq, baseReq]);
    let rows = [];
    if (pr.e) { if (pr.e.ambiguous) throw pr.e; console.error('[benotp] getPools error:', pr.e.message); }
    else {
      rows = readPools(pr.d);
      const clearlyEmpty = pr.d && typeof pr.d === 'object' && !Array.isArray(pr.d) && ['available_pools', 'pools'].some(k => Array.isArray(pr.d[k]) && pr.d[k].length === 0);
      if (!rows.length && !clearlyEmpty) { let snip = ''; try { snip = typeof pr.d === 'string' ? pr.d : JSON.stringify(pr.d); } catch (e) {} console.error('[benotp] getPools: nothing readable. service=' + service + ' country=' + country + ' reply=' + snip.slice(0, 500)); }
    }
    // The provider says plainly there are no pools (available_pools: []): nothing to sell. Remember that briefly.
    const d0 = pr.d;
    const saysEmpty = !pr.e && d0 && typeof d0 === 'object' && !Array.isArray(d0) && ['available_pools', 'pools'].some(k => Array.isArray(d0[k]) && d0[k].length === 0);
    if (!rows.length && saysEmpty) { poolCache.set(key, { at: Date.now(), v: [], empty: true }); return []; }
    if (rows.length && poolSamples < 3) { poolSamples++; try { console.log('[benotp] getPools sample: ' + JSON.stringify(pr.d).slice(0, 700)); } catch (e) {} }
    // If the reply was something unreadable (not a clear "empty"), try the default pool once so a working combination is never hidden.
    if (!rows.length) rows = [{ id: '1', name: 'Standard', cost: NaN, stock: null, rate: '' }];
    rows = rows.filter(r => r.stock === null || r.stock > 0).slice(0, 12);
    const out = [];
    await Promise.all(rows.map(async (r, i) => {
      let cost = r.cost;
      if (!(cost > 0)) cost = base;
      if (!(cost > 0)) { try { cost = await poolCost(service, country, r.id, true); } catch (e) { cost = NaN; } }
      if (cost > 0) out.push({ id: r.id, name: r.name, cost, stock: r.stock, rate: r.rate, _o: i });
    }));
    out.sort((a, b) => a._o - b._o);
    const v = out.map(({ _o, ...p }) => p);
    if (v.length) { poolCache.set(key, { at: Date.now(), v }); dbSet('pools:' + key, v); if (poolCache.size > 400) poolCache.delete(poolCache.keys().next().value); }
    return v;
  }
  // Instant answer from memory/database when we have one (refreshed quietly in the background), live lookup only the first time.
  const POOL_FRESH_MS = 60 * 1000, POOL_STALE_MS = 6 * 3600 * 1000;
  async function loadPoolRows(service, country) {
    const key = service + '|' + country;
    let hit = poolCache.get(key);
    if (!hit) { const row = await dbGet('pools:' + key); if (row && Array.isArray(row.data) && row.data.length) { hit = { at: new Date(row.updatedAt).getTime(), v: row.data }; poolCache.set(key, hit); } }
    if (hit && hit.empty && Date.now() - hit.at >= 120000) hit = null;
    let costs;
    if (hit) {
      const age = Date.now() - hit.at;
      if (age < POOL_FRESH_MS) costs = hit.v;
      else if (age < POOL_STALE_MS) { once('pools:' + key, () => fetchPools(service, country)).catch(() => {}); costs = hit.v; }
    }
    if (!costs) costs = await once('pools:' + key, () => fetchPools(service, country));
    return costs;
  }
  // What the customer sees. When every pool costs the same and has no real name or rating of its own, they are
  // really one choice: show a single "Standard" option. At purchase time the server tries the real pools in order.
  async function loadPools(service, country) {
    const list = (await loadPoolRows(service, country)).map(({ cost, ...p }) => ({ ...p, price: numberSell(cost, service) }));
    const generic = (p) => /^Pool\s/.test(p.name) && !p.rate && p.stock == null;
    if (list.length > 1 && list.every(p => p.price === list[0].price) && list.every(generic)) return [{ id: 'auto', name: 'Standard', price: list[0].price, stock: null, rate: '' }];
    return list;
  }
  // Pre-load the most-wanted combinations a few seconds after start-up, and again every 20 minutes.
  async function warmPopular() {
    try {
      const [svc, cty] = await Promise.all([getSvc(), getCty()]);
      const sv = svc.filter(x => /^(whatsapp|telegram|facebook|instagram|tiktok)\b/i.test(String(x.name).trim())).slice(0, 5);
      const ct = cty.filter(x => /^(united states|united kingdom|nigeria|canada)$/i.test(String(x.name).trim())).slice(0, 4);
      for (const a of sv) for (const b of ct) {
        const hit = poolCache.get(a.id + '|' + b.id);
        if (hit && Date.now() - hit.at < (hit.empty ? 120000 : 10 * 60 * 1000)) continue;
        try { await once('pools:' + a.id + '|' + b.id, () => fetchPools(a.id, b.id)); } catch (e) { /* skip */ }
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) { /* warm-up is best-effort */ }
  }

  app.get('/api/rado/numbers/pools', auth, async (req, res) => {
    try {
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.status(400).json({ error: 'Choose a country and a service.' });
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      res.json(await loadPools(service, country));
    } catch (e) { res.status(502).json({ error: clientMsg(e) }); }
  });
  app.get('/api/rado/numbers/price', auth, async (req, res) => {
    try {
      const service = String(req.query.service || ''), country = String(req.query.country || '');
      if (!service || !country) return res.status(400).json({ error: 'Choose a country and a service.' });
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      const cost = await numberPrice(service, country, req.query.pool);
      res.json({ price: numberSell(cost, service) });
    } catch (e) { res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
  });

  app.post('/api/rado/numbers/buy', auth, async (req, res) => {
    const service = String(req.body.service || ''), country = String(req.body.country || ''), pool = cleanPool(req.body.pool);
    if (!service || !country) return res.status(400).json({ error: 'Choose a country and a service.' });
    if (!lockUser(req.user._id)) return res.status(429).json({ error: 'Please wait, your last request is still running.' });
    let order;
    try {
      await loadCfg();
      if ((cfg.numberRules[service] || {}).hidden) return res.status(400).json({ error: 'This service is not available right now.' });
      let candidates = [pool];
      if (pool === 'auto') {
        try { candidates = (await loadPoolRows(service, country)).map(r => r.id); } catch (e) { candidates = []; }
        if (!candidates.length) candidates = ['1'];
      }
      candidates = candidates.slice(0, 6);
      let cost;
      try { cost = await numberPrice(service, country, candidates[0]); } catch (e) { return res.status(e.ambiguous ? 502 : 400).json({ error: clientMsg(e) }); }
      const price = numberSell(cost, service);
      const expected = Number(req.body.expectedPrice);
      if (Number.isFinite(expected) && expected > 0 && price > expected) return res.status(409).json({ error: 'The price changed to ₦' + price.toLocaleString() + '. Please try again.', price });
      const svcName = ((svcCache.v || []).find(s => s.id === service) || {}).name || service;
      const ctyName = ((ctyCache.v || []).find(c => c.id === country) || {}).name || country;
      order = await Order.create({ kind: 'number', userId: req.user._id, userEmail: req.user.email, title: svcName + ' number (' + ctyName + ')', service: svcName, country: ctyName, pool, cost, sellPrice: price, status: 'pending' });
      const user = await debit(req.user, price, 'SMS number - ' + svcName + ' (' + ctyName + ')');
      if (!user) { await Order.updateOne({ _id: order._id }, { $set: { status: 'failed', refunded: true, note: 'Insufficient balance' } }); return res.status(400).json({ error: 'Insufficient balance. Please fund your wallet.' }); }
      // Try each pool in order. Only a clear "no number" answer moves on to the next pool (nothing was issued, so nothing is lost);
      // an unclear outcome stops straight away and is held for review, so a customer can never be given two numbers.
      const readNumber = (d) => {
        let id, phone;
        if (typeof d === 'string') { const m = d.match(/ACCESS_NUMBER:([^:]+):(\+?\d+)/i); if (m) { id = m[1]; phone = m[2]; } }
        else { id = deepFind(d, ['order_id', 'orderId', 'activation_id', 'activationId', 'request_id', 'id']); phone = deepFind(d, ['number', 'phone', 'phone_number', 'phoneNumber', 'mdn', 'msisdn']); }
        return { id, phone };
      };
      let d, id, phone, usedPool = candidates[0], lastErr = null;
      for (const pid of candidates) {
        usedPool = pid;
        try { d = await call(NUMBERS_PATH, { action: 'getNumber', service, country, quantity: 1, pool: pid }, { timeout: 45000 }); }
        catch (e) {
          if (e.ambiguous) {
            await Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Provider outcome unknown: ' + e.message, updatedAt: new Date() } });
            console.error('[benotp] number order held for review', String(order._id));
            return res.status(202).json({ pending: true, message: 'We could not confirm your order. If a number was issued it will appear in your orders; otherwise contact support to be refunded.' });
          }
          lastErr = e; continue;
        }
        ({ id, phone } = readNumber(d));
        break;
      }
      if (!id || !phone) {
        await refund(order._id, lastErr ? lastErr.message : 'Provider returned no number', 'failed');
        if (lastErr) return res.status(400).json({ error: (/^(NO_|BAD_|ERROR|WRONG_)/i.test(lastErr.message) ? 'No number is available for this service right now. Please try again shortly or choose another country.' : clientMsg(lastErr)) + ' Nothing was charged.' });
        console.error('[benotp] getNumber unreadable answer:', JSON.stringify(d).slice(0, 300));
        return res.status(502).json({ error: 'No number was issued. Nothing was charged.' });
      }
      await Order.updateOne({ _id: order._id }, { $set: { pool: String(usedPool) } });
      await Order.updateOne({ _id: order._id }, { $set: { providerOrderId: String(id), phoneNumber: String(phone), updatedAt: new Date() } });
      const fresh = await Order.findById(order._id);
      res.json({ ...shape(fresh), ok: true, orderId: String(order._id), phoneNumber: String(phone), newBalance: user.balance });
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
  const shape = (o) => ({ id: String(o._id), phoneNumber: o.phoneNumber, service: o.service, country: o.country, status: o.status, code: o.code, sellPrice: o.sellPrice, createdAt: o.createdAt, expiresAt: new Date(new Date(o.createdAt).getTime() + ttlMs()).toISOString(), serverTime: new Date().toISOString() });

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

  // Auto-expire: a number with no SMS after the time limit (default 20 min) is cancelled at the provider,
  // marked "expired" and refunded - even if the customer closed the page. refund() can only pay once.
  let sweeping = false;
  async function sweepExpired() {
    if (sweeping) return;
    sweeping = true;
    try {
      const cutoff = new Date(Date.now() - ttlMs());
      const rows = await Order.find({ kind: 'number', status: 'pending', refunded: false, providerOrderId: { $exists: true, $ne: '' }, createdAt: { $lt: cutoff } }).limit(25);
      for (const o of rows) {
        try {
          const got = await gzCode(o);
          if (got === undefined) continue; // provider unreachable: try again next minute, never expire blindly
          if (got && got.code) { o.code = got.code; o.details = got.message; o.status = 'completed'; o.updatedAt = new Date(); await o.save(); gzFinished(o); continue; }
          if (!(got && got.cancelled)) { try { await gzCancel(o); } catch (e) { /* still refund: no SMS arrived */ } }
          await refund(o._id, 'No SMS received in time', 'expired');
        } catch (e) { console.error('[benotp] expiry sweep failed for', String(o._id), e.message); }
      }
    } catch (e) { console.error('[benotp] expiry sweep error:', e.message); }
    finally { sweeping = false; }
  }
  setInterval(sweepExpired, 60 * 1000).unref();
  setTimeout(sweepExpired, 20 * 1000).unref();

  // ═════════════════════════ PRODUCTS (Buy Accounts) ═══════════════════════
  let prodCache = { at: 0, v: null };
  async function loadProducts(force) {
    if (!force && prodCache.v && Date.now() - prodCache.at < 60 * 1000) return prodCache.v;
    await loadCfg(force);
    const raw = await call(PRODUCTS_PATH, { action: 'getProducts' });
    // Find the product rows wherever BenOTP puts them (same reader as the working site):
    // plain list, { data: [...] }, { products: [...] }, grouped under categories, or keyed by product id.
    const txt0 = (v) => (v == null ? '' : String(v)).trim();
    const looksLikeProduct = (o) => o && typeof o === 'object' && !Array.isArray(o) &&
      (o.name || o.title || o.product_name || o.product || o.service) &&
      (o.price != null || o.cost != null || o.amount != null || o.rate != null || o.unit_price != null || o.price_per_unit != null || o.cost_price != null || o.sell_price != null);
    const extractRows = (node, cat, out, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return out;
      if (Array.isArray(node)) {
        node.forEach(i => {
          if (looksLikeProduct(i)) out.push(cat && !i.category && !i.category_name ? { ...i, category: cat } : i);
          else extractRows(i, cat, out, depth + 1);
        });
        return out;
      }
      const here = txt0(node.category_name || node.category || node.name || node.title);
      const isCategoryObj = !!(node.category_name || (node.name && node.id != null));
      for (const [k, v] of Object.entries(node)) {
        if (!v || typeof v !== 'object') continue;
        if (looksLikeProduct(v)) out.push({ id: k, ...(cat ? { category: cat } : {}), ...v });
        else extractRows(v, here && (isCategoryObj || !['data', 'products', 'items', 'result'].includes(k)) ? here : cat, out, depth + 1);
      }
      return out;
    };
    const flat = extractRows(raw, '', [], 0);
    if (!flat.length) {
      let snip = ''; try { snip = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch (e) {}
      console.error('[benotp] getProducts: no product rows found. reply=' + snip.slice(0, 400));
      throw new ProviderError('BenOTP returned no products I could read. Its reply was: ' + snip.slice(0, 200), false);
    }
    const money = (v) => { if (v == null || v === '') return NaN; if (typeof v === 'number') return v; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
    const catName = (c) => (c && typeof c === 'object') ? pick(c, ['name', 'title']) : c;
    let dropped = 0;
    const list = flat.map((it, idx) => {
      if (!it || typeof it !== 'object') { dropped++; return null; }
      const id = pick(it, ['id', 'product_id', 'productId', 'pid', 'ID', 'code', 'sku']);
      const cost = money(pick(it, ['price', 'cost', 'amount', 'rate', 'unit_price', 'price_per_unit', 'product_price', 'selling_price', 'price_ngn']));
      if (id == null || !Number.isFinite(cost)) { dropped++; return null; }
      const stockRaw = pick(it, ['stock', 'quantity', 'qty', 'available', 'in_stock', 'count', 'stock_count', 'available_stock', 'available_quantity']);
      const stockNum = money(stockRaw);
      return {
        id: String(id), title: String(pick(it, ['name', 'title', 'product_name', 'productName']) || ('Product ' + id)),
        category: String(catName(pick(it, ['category', 'category_name', 'categoryName', 'type', 'group'])) || 'Other'),
        cost, price: productSell(cost, String(id)), stock: Number.isFinite(stockNum) ? stockNum : null,
        picture: String(pick(it, ['image', 'icon', 'logo', 'picture', 'img', 'image_url', 'icon_url']) || ''),
        description: String(pick(it, ['description', 'details', 'info']) || '')
      };
    }).filter(Boolean);
    if (!list.length) {
      console.error('[benotp] getProducts gave 0 usable products. received=' + flat.length + ' dropped=' + dropped + ' sample=' + JSON.stringify(flat[0] || raw).slice(0, 500));
    }
    prodCache = { at: Date.now(), v: list };
    return list;
  }
  const visibleProducts = (list) => list.filter(p => !(cfg.productRules[p.id] || {}).hidden);
  const publicProduct = ({ cost, ...p }) => p;
  // ── Product logos by name (admin types "Facebook" + uploads a logo -> every product whose name/category has that word gets it)
  const logoSchema = new mongoose.Schema({
    keyword: { type: String, required: true, unique: true },   // normalised: lower-case letters/numbers
    label: { type: String, default: '' },
    contentType: { type: String, default: 'image/png' },
    data: { type: String, required: true },                    // base64 image
    updatedAt: { type: Date, default: Date.now }
  });
  const ProductLogo = mongoose.models.BenotpProductLogo || mongoose.model('BenotpProductLogo', logoSchema);
  const normKey = (v) => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let logoCache = { at: 0, v: [] };
  async function loadLogos(force) {
    if (!force && Date.now() - logoCache.at < 15000) return logoCache.v;
    try { logoCache = { at: Date.now(), v: await ProductLogo.find({}, { data: 0 }).lean() }; } catch (e) { logoCache.at = Date.now(); }
    return logoCache.v;
  }
  const logoUrl = (l) => '/api/rado/logo/' + l._id + '?v=' + new Date(l.updatedAt).getTime();
  function logoFor(title, category) {
    const text = ' ' + normKey((title || '') + ' ' + (category || '')) + ' ';
    let best = null;
    for (const l of logoCache.v) if (l.keyword && text.includes(' ' + l.keyword + ' ') && (!best || l.keyword.length > best.keyword.length)) best = l;
    return best ? logoUrl(best) : '';
  }
  const withLogo = (p) => { const u = logoFor(p.title, p.category); return u ? { ...p, picture: u } : p; };

  app.get('/api/rado/logo/:id', async (req, res) => {
    try {
      const l = await ProductLogo.findById(req.params.id).lean();
      if (!l) return res.status(404).end();
      res.set('Content-Type', l.contentType).set('Cache-Control', 'public, max-age=86400').send(Buffer.from(l.data, 'base64'));
    } catch (e) { res.status(404).end(); }
  });
  app.get('/api/rado/admin/logos', anyAdminAuth, async (req, res) => {
    try {
      const logos = await loadLogos(true);
      let prods = []; try { prods = await loadProducts(); } catch (e) { /* list still works */ }
      res.json(logos.map(l => ({ id: String(l._id), keyword: l.label || l.keyword, url: logoUrl(l),
        matched: prods.filter(p => (' ' + normKey(p.title + ' ' + p.category) + ' ').includes(' ' + l.keyword + ' ')).length })));
    } catch (e) { res.status(500).json({ error: 'Could not load logos.' }); }
  });
  app.put('/api/rado/admin/logos', adminAuth, async (req, res) => {
    try {
      const label = String((req.body && req.body.keyword) || '').trim().slice(0, 60);
      const keyword = normKey(label);
      if (!keyword) return res.status(400).json({ error: 'Type the name first, for example Facebook.' });
      const m = String((req.body && req.body.image) || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return res.status(400).json({ error: 'Choose a logo picture (PNG, JPG or WEBP).' });
      if (m[2].length > 600000) return res.status(400).json({ error: 'That picture is too big. Use a smaller one.' });
      await ProductLogo.findOneAndUpdate({ keyword }, { $set: { keyword, label, contentType: m[1], data: m[2], updatedAt: new Date() } }, { upsert: true });
      logoCache.at = 0;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not save the logo.' }); }
  });
  app.delete('/api/rado/admin/logos/:id', adminAuth, async (req, res) => {
    try { await ProductLogo.deleteOne({ _id: req.params.id }); logoCache.at = 0; res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: 'Could not delete the logo.' }); }
  });

  // The old BenOTP product list is retired: customers buy products from Marketplace 2 (/api/market2/*).
  // These routes stay only so old browser tabs get a clean answer instead of an error.
  app.get('/api/rado/products', auth, (req, res) => res.json([]));

  function formatDelivery(d) {
    const body = (d && typeof d === 'object' && !Array.isArray(d) && d.data != null) ? d.data : d;
    if (typeof body === 'string') return body;
    const line = (x) => typeof x === 'string' ? x : (x && typeof x === 'object' ? Object.keys(x).map(k => k + ': ' + (typeof x[k] === 'object' ? JSON.stringify(x[k]) : x[k])).join(' | ') : String(x));
    if (Array.isArray(body)) return body.map(line).join('\n');
    return line(body);
  }
  app.post('/api/rado/products/buy', auth, (req, res) => res.status(410).json({ error: 'This product list is no longer available. Please refresh the page.' }));

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
    try { res.json(await getCty()); }
    catch (e) { res.status(502).json({ error: clientMsg(e) }); }
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
      try { const d = await tries[k](); out[k] = { ok: true, sample: JSON.stringify(d).slice(0, 600) }; if (k === 'products') { try { const l = await loadProducts(true); out.productsParsed = { usable: l.length, hidden: l.length - visibleProducts(l).length, first: l[0] || null }; } catch (e) { out.productsParsed = { error: e.message }; } } }
      catch (e) { out[k] = { ok: false, error: e.message }; }
    }
    const qs = String((req.query && req.query.service) || ''), qc = String((req.query && req.query.country) || '');
    if (qs && qc) {
      try { const raw = await call(NUMBERS_PATH, { action: 'getPools', service: qs, country: qc }); out.poolsRaw = JSON.stringify(raw).slice(0, 1500); out.poolsParsed = readPools(raw).map(({ id, name, cost, stock, rate }) => ({ id, name, cost, stock, rate })); }
      catch (e) { out.poolsRaw = { error: e.message }; }
      try { const dsc = await call(NUMBERS_PATH, { action: 'getServices', country: qc }); out.servicesForCountry = { count: cleanList(dsc).length, allServicesCount: (svcCache.v || []).length }; }
      catch (e) { out.servicesForCountry = { error: e.message }; }
      out.price = {};
      for (const act of ['getPrice', 'getPrices']) {
        try { const d = await call(NUMBERS_PATH, { action: act, service: qs, country: qc, pool: 1 }); out.price[act] = { ok: true, sample: JSON.stringify(d).slice(0, 600), readAs: readPrice(d) }; }
        catch (e) { out.price[act] = { ok: false, error: e.message }; }
      }
    }
    res.json(out);
  });
}

module.exports = { register };
