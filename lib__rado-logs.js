// ── Logs the admin adds by hand ──────────────────────────────────────────────
// The admin picks a name, a category (existing, or a brand-new one), a price, an
// optional logo, a description and the TYPE of log (email + password, link,
// account details, other), then pastes the stock - one unit per line.
// Each log then appears on the customers' Products page like any provider product,
// and is bought through the same order / refund / delivery code as Marketplace 2
// (see the hooks in lib/market2.js).
//
// Routes:
//   GET    /api/rado/admin/rlogs            list (types, categories, logs)
//   POST   /api/rado/admin/rlogs            add a log
//   PUT    /api/rado/admin/rlogs/:id        edit / add stock / hide
//   DELETE /api/rado/admin/rlogs/:id        delete
//   GET    /api/rado/rlog-pic/:id           the uploaded logo (public image)

const crypto = require('crypto');
const { sealRef } = require('./opaque-ref');

const TYPES = {
  login: 'Email & password',
  link: 'Link',
  details: 'Account details (several lines)',
  other: 'Other'
};
const MAX_UNITS = 5000;
const MAX_UNIT_LEN = 4000;

function parseUnits(text, logType) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let parts;
  if ((logType === 'details' || logType === 'other') && /^\s*-{3,}\s*$/m.test(raw)) parts = raw.split(/^\s*-{3,}\s*$/m);
  else if (logType === 'details') parts = [raw];              // one account that runs over several lines
  else parts = raw.split('\n');                                // login / link / other: one unit per line
  return parts.map(x => x.trim()).filter(Boolean).map(x => x.slice(0, MAX_UNIT_LEN)).slice(0, MAX_UNITS);
}

function register(app, deps) {
  const { mongoose, User, auth, anyAdminAuth, market } = deps;
  const adminAuth = deps.adminAuth || anyAdminAuth;
  const hooks = deps.hooks || {};
  const logoFor = deps.logoFor || (async () => '');   // name-based logo (Admin -> Product logos)
  const secret = () => process.env.JWT_SECRET;

  const schema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    logType: { type: String, default: 'login' },
    category: { type: String, required: true, trim: true, index: true },
    price: { type: Number, required: true },
    description: { type: String, default: '' },
    pictureType: { type: String, default: '' },
    pictureData: { type: String, default: '' },    // base64
    pictureAt: { type: Date, default: null },
    stock: { type: [String], default: [] },
    sold: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  const RadoLog = mongoose.models.RadoLog || mongoose.model('RadoLog', schema);

  // ids of logs that have an uploaded picture (checked without loading the pictures themselves)
  async function picSet(extra) {
    return new Set((await RadoLog.find({ ...(extra || {}), pictureData: { $ne: '' } }).select('_id').lean()).map(x => String(x._id)));
  }
  const picUrl = (l) => '/api/rado/rlog-pic/' + l._id + '?v=' + new Date(l.pictureAt || l.updatedAt || 0).getTime();

  async function categoriesList() {
    const own = await RadoLog.distinct('category');
    let prov = [];
    try { prov = market && market.providerCategories ? await market.providerCategories() : []; } catch (e) { /* ignore */ }
    const seen = new Map();
    [...prov, ...own].forEach(c => { const k = String(c).toLowerCase(); if (c && !seen.has(k)) seen.set(k, c); });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  // "facebook" typed again with another case must land in the SAME category.
  async function canonicalCategory(input) {
    const name = String(input || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return '';
    const hit = (await categoriesList()).find(c => c.toLowerCase() === name.toLowerCase());
    return hit || name;
  }

  function readPicture(v) {
    const m = String(v || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return { error: 'Choose a PNG, JPG or WEBP picture.' };
    if (m[2].length > 700000) return { error: 'That picture is too big. Use a smaller one.' };
    return { type: m[1], data: m[2] };
  }

  async function view(l, has) {
    let picture = has ? picUrl(l) : '';
    if (!picture) { try { picture = await logoFor(l.name, l.category); } catch (e) { picture = ''; } }
    return {
      id: String(l._id), name: l.name, logType: l.logType, category: l.category, price: l.price,
      description: l.description || '', picture, hasPicture: !!has,
      stock: (l.stock || []).length, sold: l.sold || 0, enabled: l.enabled !== false
    };
  }

  // ── Admin ──────────────────────────────────────────────────────────────────
  app.get('/api/rado/admin/rlogs', anyAdminAuth, async (req, res) => {
    try {
      const logs = await RadoLog.find({}).select('-pictureData -pictureType').sort({ createdAt: -1 }).lean();
      const has = await picSet();
      res.set('Cache-Control', 'no-store');
      res.json({ types: TYPES, categories: await categoriesList(), logs: await Promise.all(logs.map(l => view(l, has.has(String(l._id))))) });
    } catch (e) { res.status(500).json({ error: 'Could not load the logs.' }); }
  });

  app.post('/api/rado/admin/rlogs', adminAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 120);
      if (name.length < 2) return res.status(400).json({ error: 'Type the log name.' });
      const logType = TYPES[b.logType] ? b.logType : 'other';
      const price = Number(b.price);
      if (!Number.isFinite(price) || price <= 0 || price > 100000000) return res.status(400).json({ error: 'Enter the price in naira.' });
      const category = await canonicalCategory(b.category);
      if (!category) return res.status(400).json({ error: 'Choose a category or type a new one.' });
      const doc = { name, logType, price: Math.round(price * 100) / 100, category, description: String(b.description || '').slice(0, 2000), enabled: b.enabled !== false, stock: parseUnits(b.stock, logType) };
      if (b.picture) {
        const p = readPicture(b.picture);
        if (p.error) return res.status(400).json({ error: p.error });
        doc.pictureType = p.type; doc.pictureData = p.data; doc.pictureAt = new Date();
      }
      const l = await RadoLog.create(doc);
      res.json({ ok: true, id: String(l._id), stock: l.stock.length });
    } catch (e) { console.error('[rlogs] add failed:', e.message); res.status(500).json({ error: 'Could not save the log.' }); }
  });

  app.put('/api/rado/admin/rlogs/:id', adminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Log not found.' });
      const l = await RadoLog.findById(req.params.id).select('-pictureData').lean();
      if (!l) return res.status(404).json({ error: 'Log not found.' });
      const b = req.body || {};
      const set = { updatedAt: new Date() };
      const logType = (b.logType !== undefined && TYPES[b.logType]) ? b.logType : l.logType;
      if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 120); if (n.length < 2) return res.status(400).json({ error: 'Type the log name.' }); set.name = n; }
      if (logType !== l.logType) set.logType = logType;
      if (b.price !== undefined) { const p = Number(b.price); if (!Number.isFinite(p) || p <= 0 || p > 100000000) return res.status(400).json({ error: 'Enter the price in naira.' }); set.price = Math.round(p * 100) / 100; }
      if (b.category !== undefined) { const c = await canonicalCategory(b.category); if (!c) return res.status(400).json({ error: 'Choose a category or type a new one.' }); set.category = c; }
      if (b.description !== undefined) set.description = String(b.description).slice(0, 2000);
      if (typeof b.enabled === 'boolean') set.enabled = b.enabled;
      if (b.picture) { const p = readPicture(b.picture); if (p.error) return res.status(400).json({ error: p.error }); set.pictureType = p.type; set.pictureData = p.data; set.pictureAt = new Date(); }
      else if (b.removePicture) { set.pictureType = ''; set.pictureData = ''; set.pictureAt = null; }
      const add = (b.addStock !== undefined && String(b.addStock).trim()) ? parseUnits(b.addStock, logType) : [];
      const have = b.clearStock ? 0 : (l.stock || []).length;
      if (have + add.length > MAX_UNITS) return res.status(400).json({ error: 'Too much stock in one log (max ' + MAX_UNITS + ').' });
      // Atomic operators only: a sale happening at this very moment can never be overwritten.
      const update = { $set: set };
      if (b.clearStock) set.stock = add;
      else if (add.length) update.$push = { stock: { $each: add } };
      await RadoLog.updateOne({ _id: l._id }, update);
      const now = await RadoLog.findById(l._id).select('stock').lean();
      res.json({ ok: true, stock: ((now && now.stock) || []).length });
    } catch (e) { console.error('[rlogs] edit failed:', e.message); res.status(500).json({ error: 'Could not save the log.' }); }
  });

  app.delete('/api/rado/admin/rlogs/:id', adminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Log not found.' });
      await RadoLog.deleteOne({ _id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not delete the log.' }); }
  });

  // ── Public logo image ──────────────────────────────────────────────────────
  app.get('/api/rado/rlog-pic/:id', async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
      const l = await RadoLog.findById(req.params.id).select('pictureType pictureData').lean();
      if (!l || !l.pictureData) return res.status(404).end();
      res.set('Content-Type', l.pictureType || 'image/png').set('Cache-Control', 'public, max-age=86400').send(Buffer.from(l.pictureData, 'base64'));
    } catch (e) { res.status(404).end(); }
  });

  // ── Shown on the Products page (called from market2's product list) ────────
  hooks.ownProducts = async function ownProducts() {
    const logs = await RadoLog.find({ enabled: true }).select('-pictureData -pictureType').lean();
    const withPic = await picSet({ enabled: true });
    return Promise.all(logs.map(async l => {
      let picture = withPic.has(String(l._id)) ? picUrl(l) : '';
      if (!picture) { try { picture = await logoFor(l.name, l.category); } catch (e) { picture = ''; } }
      const stock = (l.stock || []).length;
      return {
        id: 0, productKey: sealRef('market2:rlog', { id: String(l._id) }, secret()),
        title: l.name, description: l.description || '', picture, category: l.category,
        price: l.price, stock, inStock: stock > 0, logType: l.logType, logTypeLabel: TYPES[l.logType] || ''
      };
    }));
  };

  // ── Buying one of them ─────────────────────────────────────────────────────
  // Same safety rules as the provider purchases: the order is written BEFORE the
  // wallet is charged, the charge is atomic, stock is reserved atomically, a
  // retry with the same clientRef returns the same order, and if anything
  // definite goes wrong the customer is refunded.
  hooks.ownBuy = async function ownBuy(req, res, logId) {
    const { Market2Order, deliverToUser, refundOrder, alertAdmin, withRetry, customerView } = market;
    let order = null;
    try {
      const quantity = Math.max(1, Math.min(100, parseInt(req.body && req.body.quantity, 10) || 1));
      const ref = String((req.body && req.body.clientRef) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || crypto.randomUUID();

      const existing = await Market2Order.findOne({ ref });
      if (existing) {
        if (String(existing.userId) !== String(req.user._id)) return res.status(409).json({ error: 'Invalid request. Please refresh and try again.' });
        if (['delivered', 'partial'].includes(existing.status)) {
          deliverToUser(existing._id).catch(() => {});
          const u = await User.findById(req.user._id).select('balance').lean();
          return res.json({ ok: true, repeated: true, ...customerView(existing), title: existing.title, balance: u && u.balance });
        }
        if (existing.status === 'failed' || existing.status === 'refunded') return res.status(400).json({ error: existing.note || 'This order did not go through. Nothing was charged.' });
        return res.status(202).json({ ok: true, pending: true, orderId: String(existing._id), ref, message: 'Your order is still being processed. Your details will appear in Orders as soon as it completes.' });
      }

      if (!mongoose.isValidObjectId(logId)) return res.status(404).json({ error: 'This product is not available.' });
      const log = await RadoLog.findById(logId).select('-pictureData').lean();
      if (!log || log.enabled === false) return res.status(404).json({ error: 'This product is not available.' });
      const have = (log.stock || []).length;
      if (have < quantity) return res.status(409).json({ error: have ? `Only ${have} left in stock.` : 'Sold out.' });

      const title = `${log.name}${quantity > 1 ? ` ×${quantity}` : ''}`;
      const total = Math.round(log.price * quantity * 100) / 100;

      order = await Market2Order.create({
        ref, userId: req.user._id, userEmail: req.user.email, productId: 0, productName: log.name, title,
        quantity, unitSell: log.price, sellTotal: total, costTotal: 0, profit: total, status: 'pending'
      });

      const user = await User.findOneAndUpdate({ _id: req.user._id, balance: { $gte: total } }, { $inc: { balance: -total } }, { new: true });
      if (!user) {
        await Market2Order.updateOne({ _id: order._id }, { $set: { status: 'failed', note: 'Insufficient balance', updatedAt: new Date() } });
        return res.status(400).json({ error: 'Insufficient balance. Please deposit funds.' });
      }
      await Market2Order.updateOne({ _id: order._id }, { $set: { debited: true } }).catch(() => {});

      // Take the units out of stock in ONE atomic step (two buyers can never get the same unit).
      const before = await RadoLog.findOneAndUpdate(
        { _id: logId, enabled: true, $expr: { $gte: [{ $size: '$stock' }, quantity] } },
        [{ $set: { stock: { $slice: ['$stock', quantity, 10000000] }, sold: { $add: ['$sold', quantity] }, updatedAt: new Date() } }],
        { new: false }
      ).select('stock').lean();
      if (!before) {
        try { await refundOrder(order._id, total, 'Sold out - refunded.', 'failed'); }
        catch (re) {
          await Market2Order.updateOne({ _id: order._id }, { $set: { status: 'review', note: 'Sold out but the automatic refund failed - refund manually. ' + re.message, updatedAt: new Date() } }).catch(() => {});
          alertAdmin('Log sale: refund failed - action needed', `Order ${order._id} for ${req.user.email} (${title}, ₦${total}) ran out of stock and the automatic refund failed. Please refund it from Admin.`);
          return res.status(202).json({ ok: true, pending: true, orderId: String(order._id), ref, message: 'This item just sold out. Your payment is safe and is being returned - contact support if your balance is not restored shortly.' });
        }
        return res.status(409).json({ error: 'Sorry, this item just sold out. Nothing was charged.' });
      }
      const keys = before.stock.slice(0, quantity);

      try { await withRetry(() => Market2Order.updateOne({ _id: order._id }, { $set: { status: 'delivered', keys, updatedAt: new Date() } }), 4, 300); }
      catch (e) {
        console.error('[rlogs] CRITICAL could not save keys to order', String(order._id), 'user', req.user.email, 'keys:', JSON.stringify(keys));
        await User.updateOne({ _id: user._id }, { $push: { purchaseDetails: { logId: order._id, logTitle: title, logType: 'log', source: 'market2', logDetails: keys.join('\n'), pricePaid: total, purchasedAt: new Date() } } }).catch(() => {});
      }
      let synced = false;
      try { await withRetry(() => deliverToUser(order._id), 3, 300); synced = true; }
      catch (e) { console.error('[rlogs] delivery sync pending - reconciler will retry:', e.message); }

      const fresh = await User.findById(user._id).select('balance').lean().catch(() => null);
      res.json({ ok: true, title, quantity, amountPaid: total, keys, balance: fresh ? fresh.balance : user.balance, orderId: String(order._id), ref, partial: false, saved: synced });
    } catch (e) {
      console.error('[rlogs] buy error:', e);
      if (order && order._id) {
        try {
          const o = await Market2Order.findById(order._id);
          if (o && o.status === 'pending' && o.debited) {
            await Market2Order.updateOne({ _id: o._id }, { $set: { status: 'review', note: 'Unexpected server error during purchase: ' + e.message, updatedAt: new Date() } });
            alertAdmin('Log sale: order needs review', `Order ${o._id} for ${o.userEmail} hit a server error after payment (${e.message}).`);
            return res.status(202).json({ ok: true, pending: true, orderId: String(o._id), ref: o.ref, message: 'Your order is being verified. Please do not buy again - your details will appear in Orders shortly.' });
          }
          if (o && o.status === 'delivered') return res.json({ ok: true, ...customerView(o), title: o.title, quantity: o.quantity });
        } catch (e2) { /* fall through */ }
      }
      res.status(500).json({ error: 'Purchase failed. If you were charged, your details will appear in Orders - otherwise nothing was taken.' });
    }
  };

  return { RadoLog, TYPES };
}

module.exports = { register, parseUnits, TYPES };
