/**
 * lib/extras.js — admin business tools + customer extras (additive; nothing existing is replaced)
 *
 * ADMIN  (/api/admin/extras/*)
 *   activity            who changed what (every admin write is logged) — also the price-change history
 *   money               revenue / profit / refunds / top-ups: today, 7 days, 30 days
 *   providers           balances of every provider
 *   stuck, stuck/refund failed / stuck orders in one queue, one-click wallet refund
 *   customers           customer lookup, wallet credit/debit, restrict
 *   export/:what        CSV backups (users, transactions, number orders)
 * CUSTOMER (/api/extras/*)
 *   notifications       in-app events (code received, refunds). No customer e-mail is sent:
 *                       lib/mailer.js limits customer mail to password-reset + welcome on purpose.
 *   search              one search over the products catalogue
 */
const axios = require('axios');

const SECRET_KEY = /pass|secret|token|key|otp|code|authorization|cipher|pin/i;
const wat = d => new Date(new Date(d).getTime() + 3600e3); // Africa/Lagos = UTC+1, no DST

function scrub(v, depth = 0) {
  if (v == null) return v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[k] = SECRET_KEY.test(k) ? '[hidden]' : scrub(v[k], depth + 1);
    return o;
  }
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
  return v;
}

/** Pull a numeric balance out of whatever shape a provider returns. */
function extractBalance(d) {
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') { const n = Number(d.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && d.trim() ? n : null; }
  if (typeof d !== 'object') return null;
  for (const k of ['balance', 'available', 'available_balance', 'wallet', 'amount', 'credit']) {
    if (d[k] !== undefined) { const n = extractBalance(d[k]); if (n !== null) return n; }
  }
  for (const k of ['balance_minor', 'available_minor']) {
    if (Number.isFinite(Number(d[k]))) return Number(d[k]) / 100;
  }
  for (const k of ['data', 'result', 'wallet']) {
    if (d[k] && typeof d[k] === 'object') { const n = extractBalance(d[k]); if (n !== null) return n; }
  }
  return null;
}

/** Collect catalogue items ({name, id}) from any array/object shape. */
function collectItems(d, out = [], depth = 0) {
  if (!d || depth > 4) return out;
  if (Array.isArray(d)) { d.forEach(x => collectItems(x, out, depth + 1)); return out; }
  if (typeof d === 'object') {
    const name = d.customTitle || d.name || d.title || d.serviceName || d.provider;
    const id = d.id ?? d.serviceId ?? d.service_id ?? d._id ?? d.itemId ?? d.productId;
    if (typeof name === 'string' && name && id !== undefined) {
      out.push({ id: String(id), name, category: String(d.category || d.platform || ''), price: Number(d.price ?? d.sellPrice ?? d.sell ?? 0) || 0 });
    } else {
      for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object') collectItems(d[k], out, depth + 1);
    }
  }
  return out;
}

function csvCell(v) {
  if (v == null) return '';
  if (v instanceof Date) v = v.toISOString();
  v = String(v);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // stop spreadsheet formula injection
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Registered BEFORE the routes so every admin write passes through it. */
function early(app, { mongoose }) {
  const Audit = mongoose.models.ExtrasAudit || mongoose.model('ExtrasAudit', new mongoose.Schema({
    at: { type: Date, default: Date.now, index: true },
    actor: String, role: String, method: String, path: String, status: Number, body: mongoose.Schema.Types.Mixed, ip: String
  }));
  app.use('/api/admin', (req, res, next) => {
    if (!['PUT', 'POST', 'DELETE', 'PATCH'].includes(req.method)) return next();
    res.on('finish', () => {
      try {
        if (req.originalUrl.includes('/extras/')) { if (!/\/(refund|wallet|restrict)/.test(req.originalUrl)) return; }
        Audit.create({
          actor: 'owner',
          role: req.adminRole || '', method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode,
          body: scrub(req.body), ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
        }).catch(() => {});
      } catch (e) { /* never break a request because of logging */ }
    });
    next();
  });
}

function register(deps) {
  const { app, mongoose, User, Transaction, auth, anyAdminAuth } = deps;
  const push = deps.pushBalanceToUser || (() => {});
  const M = n => mongoose.models[n];
  const Audit = M('ExtrasAudit');
  const Cfg = mongoose.models.ExtrasConfig || mongoose.model('ExtrasConfig', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    thresholds: { type: mongoose.Schema.Types.Mixed, default: {} }
  }));
  const getCfg = async () => (await Cfg.findOne({ key: 'main' })) || (await Cfg.create({ key: 'main' }));
  const superOnly = (req, res, next) => req.adminRole === 'super' ? next() : res.status(403).json({ error: 'Only the owner can do this.' });
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[extras]', e.message); res.status(e.status || 500).json({ error: e.message || 'Request failed' }); } };
  const base = () => `http://127.0.0.1:${process.env.PORT || 3000}`;
  const loop = async (path, headers) => (await axios.get(base() + path, { headers, timeout: 25000 })).data;
  const adminLoop = path => {
    if (!process.env.ADMIN_PASSCODE) throw Object.assign(new Error('ADMIN_PASSCODE is not set'), { status: 500 });
    return loop(path, { 'x-admin-passcode': process.env.ADMIN_PASSCODE });
  };
  const num = v => Number(v) || 0;

  // ───────────────────────── ACTIVITY / PRICE HISTORY ─────────────────────────
  app.get('/api/admin/extras/activity', anyAdminAuth, superOnly, wrap(async (req, res) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const q = {};
    if (req.query.prices === '1') q.path = /price|markup|adjust|tier|rate|config|services|products|n3/i;
    if (req.query.q) q.$or = [{ path: new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { actor: new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    res.json(await Audit.find(q).sort({ at: -1 }).limit(limit).lean());
  }));

  // ───────────────────────── MONEY DASHBOARD ─────────────────────────
  async function lineTotals(since) {
    const out = {};
    const run = async (key, label, fn) => { try { out[key] = { label, ...(await fn()) }; } catch (e) { out[key] = { label, revenue: 0, cost: 0, profit: 0, orders: 0 }; } };
    const tot = (rows, r = 'revenue', c = 'cost') => { const x = rows[0] || {}; const revenue = num(x[r]), cost = num(x[c]); return { revenue, cost, profit: revenue - cost, orders: num(x.n) }; };
    if (M('BenotpOrder')) for (const [key, label, kind] of [['numbers', 'SMS numbers', 'number'], ['products', 'Products', 'product']]) {
      await run(key, label, async () => tot(await M('BenotpOrder').aggregate([
        { $match: { kind, status: 'completed', refunded: { $ne: true }, createdAt: { $gte: since } } },
        { $group: { _id: null, revenue: { $sum: { $ifNull: ['$sellPrice', 0] } }, cost: { $sum: { $ifNull: ['$cost', 0] } }, n: { $sum: 1 } } }])));
    }
    return out;
  }
  async function walletTotals(since) {
    const rows = await Transaction.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'success', reversed: { $ne: true } } },
      { $group: { _id: '$type', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]);
    const o = {}; rows.forEach(r => { o[r._id] = { amount: num(r.amount), n: r.n }; });
    return o;
  }
  app.get('/api/admin/extras/money', anyAdminAuth, superOnly, wrap(async (req, res) => {
    const now = new Date();
    const w = wat(now); const startWat = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate())); // midnight WAT as a UTC-shifted date
    const todayStart = new Date(startWat.getTime() - 3600e3);
    const periods = { today: todayStart, week: new Date(todayStart.getTime() - 6 * 86400e3), month: new Date(todayStart.getTime() - 29 * 86400e3) };
    const result = {};
    for (const [k, since] of Object.entries(periods)) {
      const [wallet, lines] = await Promise.all([walletTotals(since), lineTotals(since)]);
      const profit = Object.values(lines).reduce((a, l) => a + num(l.profit), 0);
      const revenue = Object.values(lines).reduce((a, l) => a + num(l.revenue), 0);
      result[k] = { since, deposits: num(wallet.deposit?.amount), depositCount: num(wallet.deposit?.n), refunds: num(wallet.refund?.amount),
        adminCredits: num(wallet.admin_credit?.amount), adminDebits: num(wallet.admin_debit?.amount), referral: num(wallet.referral_commission?.amount),
        spent: num(wallet.purchase?.amount) + num(wallet.debit?.amount), revenue, profit, lines };
    }
    const daily = await Transaction.aggregate([
      { $match: { createdAt: { $gte: periods.week }, status: 'success', reversed: { $ne: true }, type: { $in: ['deposit', 'purchase', 'debit', 'refund'] } } },
      { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Africa/Lagos' } }, t: '$type' }, amount: { $sum: '$amount' } } }]);
    const days = {};
    daily.forEach(r => { const d = days[r._id.d] = days[r._id.d] || { date: r._id.d, deposit: 0, spent: 0, refund: 0 }; if (r._id.t === 'deposit') d.deposit += r.amount; else if (r._id.t === 'refund') d.refund += r.amount; else d.spent += r.amount; });
    result.daily = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
    result.note = 'Profit uses the cost saved on each order. Older orders with no saved cost can make profit look higher than it really was.';
    res.json(result);
  }));

  // ───────────────────────── PROVIDER BALANCES + ALERTS ─────────────────────────
  const PROVIDERS = [
    { key: 'benotp', name: 'BenOTP (SMS numbers + products)', path: '/api/rado/admin/benotp-balance', unit: '' }
  ];
  async function checkProviders() {
    const cfg = await getCfg();
    const th = cfg.thresholds || {};
    return Promise.all(PROVIDERS.map(async p => {
      const row = { key: p.key, name: p.name, unit: p.unit, threshold: num(th[p.key]) || null, balance: null, error: '' };
      try { row.balance = extractBalance(await adminLoop(p.path)); if (row.balance === null) row.error = 'Balance not reported'; }
      catch (e) { row.error = (e.response && e.response.data && e.response.data.error) || e.message; }
      row.low = row.balance !== null && row.threshold != null && row.balance < row.threshold;
      return row;
    }));
  }
  app.get('/api/admin/extras/providers', anyAdminAuth, superOnly, wrap(async (req, res) => {
    res.json({ providers: await checkProviders() });
  }));

  // ───────────────────────── STUCK / FAILED ORDERS ─────────────────────────
  const ago = min => new Date(Date.now() - min * 60e3);
  app.get('/api/admin/extras/stuck', anyAdminAuth, superOnly, wrap(async (req, res) => {
    const rows = []; const since = ago(60 * 24 * 30);
    const push1 = r => rows.push({ ...r, ageMin: Math.round((Date.now() - new Date(r.at).getTime()) / 60e3) });
    const tryRun = async fn => { try { await fn(); } catch (e) { /* model missing */ } };
    await tryRun(async () => {
      for (const o of await M('BenotpOrder').find({ createdAt: { $gte: since }, $or: [{ status: 'review' }, { status: 'failed', refunded: false }, { status: 'pending', createdAt: { $lt: ago(30) } }] }).sort({ createdAt: -1 }).limit(100).lean())
        push1({ kind: 'benotp', id: String(o._id), userId: String(o.userId || ''), title: o.title || 'Order', amount: o.sellPrice, status: o.status, reason: o.note || 'Needs your decision', at: o.createdAt, canRefund: false, where: 'Admin → BenOTP orders' });
    });
    const ids = [...new Set(rows.map(r => r.userId).filter(Boolean))];
    const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
    const um = Object.fromEntries(users.map(u => [String(u._id), u]));
    rows.forEach(r => { const u = um[r.userId]; r.userName = u ? u.name : ''; r.userEmail = u ? u.email : ''; });
    rows.sort((a, b) => b.ageMin - a.ageMin); // oldest (most urgent) first
    res.json({ count: rows.length, rows });
  }));

  // ───────────────────────── CUSTOMER LOOKUP ─────────────────────────
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const USER_FIELDS = 'name email balance restricted restrictedReason createdAt lastLoginAt lastActiveAt country contactPhone referralCode apiEnabled';
  app.get('/api/admin/extras/customers', anyAdminAuth, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json([]);
    const re = new RegExp(esc(q), 'i');
    const or = [{ email: re }, { name: re }, { contactPhone: re }];
    if (/^[a-f0-9]{24}$/i.test(q)) or.push({ _id: q });
    res.json(await User.find({ $or: or }).select(USER_FIELDS).sort({ createdAt: -1 }).limit(15).lean());
  }));
  app.get('/api/admin/extras/customers/:id', anyAdminAuth, wrap(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid customer'), { status: 400 });
    const id = req.params.id;
    const user = await User.findById(id).select(USER_FIELDS).lean();
    if (!user) throw Object.assign(new Error('Customer not found'), { status: 404 });
    const uid = new mongoose.Types.ObjectId(id);
    const [txs, agg, nums, tickets] = await Promise.all([
      Transaction.find({ userId: id }).sort({ createdAt: -1 }).limit(30).lean(),
      Transaction.aggregate([{ $match: { userId: uid, status: 'success', reversed: { $ne: true } } }, { $group: { _id: '$type', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      M('BenotpOrder') ? M('BenotpOrder').find({ userId: id }).sort({ createdAt: -1 }).limit(10).lean() : [],
      M('SupportMessage') ? M('SupportMessage').find({ userId: id }).sort({ createdAt: -1 }).limit(5).lean().catch(() => []) : []
    ]);
    const t = {}; agg.forEach(r => { t[r._id] = { amount: r.amount, n: r.n }; });
    const orders = [
      ...nums.map(o => ({ at: o.createdAt, line: o.kind === 'product' ? 'Products' : 'SMS numbers', title: o.title || `${o.service || ''} ${o.phoneNumber || ''}`.trim(), amount: o.sellPrice, status: o.status + (o.refunded ? ' (refunded)' : '') }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30);
    res.json({ user, transactions: txs, orders, totals: { deposited: t.deposit?.amount || 0, spent: (t.purchase?.amount || 0) + (t.debit?.amount || 0), refunded: t.refund?.amount || 0 }, tickets: tickets.length });
  }));
  app.post('/api/admin/extras/customers/:id/wallet', anyAdminAuth, superOnly, wrap(async (req, res) => {
    const { direction, reason } = req.body || {}; const amount = Number((req.body || {}).amount);
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid customer'), { status: 400 });
    if (!['credit', 'debit'].includes(direction)) throw Object.assign(new Error('Choose credit or debit.'), { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw Object.assign(new Error('Enter a valid amount.'), { status: 400 });
    const why = String(reason || '').trim().slice(0, 200) || (direction === 'credit' ? 'Admin manual credit' : 'Admin manual debit');
    const u = direction === 'credit'
      ? await User.findByIdAndUpdate(req.params.id, { $inc: { balance: amount } }, { new: true })
      : await User.findOneAndUpdate({ _id: req.params.id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
    if (!u) throw Object.assign(new Error(direction === 'debit' ? 'Customer not found or balance is too low.' : 'Customer not found.'), { status: 404 });
    await Transaction.create({ userId: u._id, type: direction === 'credit' ? 'admin_credit' : 'admin_debit', amount, description: why, status: 'success' });
    try { push(u._id, u.balance, direction === 'credit' ? amount : -amount); } catch (e) { /* optional */ }
    res.json({ ok: true, newBalance: u.balance, message: `${direction === 'credit' ? 'Credited' : 'Debited'} ₦${amount.toLocaleString('en-NG')} — ${u.name}` });
  }));
  app.put('/api/admin/extras/customers/:id/restrict', anyAdminAuth, superOnly, wrap(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw Object.assign(new Error('Invalid customer'), { status: 400 });
    const on = !!(req.body || {}).restricted;
    const upd = on ? { restricted: true, restrictedReason: String(req.body.reason || 'Restricted by admin').slice(0, 200), restrictedAt: new Date() } : { restricted: false, restrictedReason: '', restrictedAt: null };
    const u = await User.findByIdAndUpdate(req.params.id, upd, { new: true }).select('name restricted');
    if (!u) throw Object.assign(new Error('Customer not found'), { status: 404 });
    res.json({ ok: true, message: `${u.name} ${on ? 'restricted' : 'unrestricted'}` });
  }));

  // ───────────────────────── CSV EXPORT ─────────────────────────
  const EXPORTS = {
    users: { model: () => User, select: '-password -apiSecret -apiKey -flwCustomerId', cols: ['_id', 'name', 'email', 'balance', 'restricted', 'country', 'contactPhone', 'referralCode', 'createdAt', 'lastLoginAt'], date: 'createdAt' },
    transactions: { model: () => Transaction, cols: ['_id', 'userId', 'type', 'amount', 'status', 'description', 'txRef', 'createdAt'], date: 'createdAt' },
    numbers: { model: () => M('BenotpOrder'), cols: ['_id', 'kind', 'userId', 'title', 'service', 'country', 'phoneNumber', 'quantity', 'sellPrice', 'cost', 'status', 'refunded', 'createdAt'], date: 'createdAt' }
  };
  app.get('/api/admin/extras/export/:what', anyAdminAuth, superOnly, async (req, res) => {
    try {
      const def = EXPORTS[req.params.what]; const Model = def && def.model();
      if (!def || !Model) return res.status(404).json({ error: 'Unknown export' });
      const days = Math.min(3650, Math.max(1, Number(req.query.days) || 90));
      const q = req.params.what === 'users' ? {} : { [def.date]: { $gte: new Date(Date.now() - days * 86400e3) } };
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.what}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.write('\ufeff' + def.cols.join(',') + '\n');
      let cur = Model.find(q).sort({ [def.date]: -1 }).limit(200000).lean();
      if (def.select) cur = cur.select(def.select);
      for await (const d of cur.cursor()) res.write(def.cols.map(c => csvCell(d[c])).join(',') + '\n');
      res.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'Export failed' }); else res.end(); }
  });

  // ───────────────────────── CUSTOMER: NOTIFICATIONS ─────────────────────────
  app.get('/api/extras/notifications', auth, wrap(async (req, res) => {
    const uid = req.user._id; const since = new Date(Date.now() - 3 * 86400e3); const items = [];
    const t = async fn => { try { await fn(); } catch (e) { /* ignore missing model */ } };
    const ngn = v => '₦' + num(v).toLocaleString('en-NG');
    await t(async () => (await M('BenotpOrder').find({ userId: uid, kind: 'number', code: { $nin: [null, ''] }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(10).lean())
      .forEach(o => items.push({ id: 'n' + o._id, type: 'code', title: 'Code received', text: `Your code for ${o.phoneNumber || 'your number'} has arrived.`, at: o.updatedAt, href: '/sms' })));
    await t(async () => (await Transaction.find({ userId: uid, type: 'refund', status: 'success', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(10).lean())
      .forEach(o => items.push({ id: 't' + o._id, type: 'refund', title: 'Refund received', text: `${ngn(o.amount)} returned to your wallet. ${o.description || ''}`.trim(), at: o.createdAt, href: '/transactions.html' })));
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ items: items.slice(0, 30) });
  }));

  // ───────────────────────── CUSTOMER: GLOBAL SEARCH ─────────────────────────
  const LINES = [
    { key: 'products', label: 'Products', path: '/api/rado/products', href: '/products', auth: true }
  ];
  const cache = {};
  async function lineItems(l, authHeader) {
    const c = cache[l.key];
    if (c && Date.now() - c.at < 5 * 60e3) return c.items;
    const headers = l.auth ? { Authorization: authHeader } : {};
    const items = collectItems(await loop(l.path, headers)).map(i => ({ ...i, line: l.label, href: l.href }));
    cache[l.key] = { at: Date.now(), items };
    return items;
  }
  app.get('/api/extras/search', auth, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    if (q.length < 2) return res.json({ results: [] });
    const words = q.split(/\s+/).filter(Boolean);
    const all = await Promise.all(LINES.map(l => lineItems(l, req.headers.authorization).catch(() => [])));
    const results = [];
    for (const items of all) for (const i of items) {
      const hay = `${i.name} ${i.category}`.toLowerCase();
      if (words.every(w => hay.includes(w))) results.push({ name: i.name, category: i.category, line: i.line, href: i.href, price: i.price || null, score: hay.startsWith(q) ? 0 : hay.includes(q) ? 1 : 2 });
    }
    results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    res.json({ results: results.slice(0, 40), numbers: { href: '/sms', label: 'SMS Numbers — search for "' + q + '"' } });
  }));
}

module.exports = { early, register, _test: { extractBalance, collectItems, csvCell, scrub } };
