/**
 * lib/korapay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Kuropay (Korapay) as the third payment gateway next to Flutterwave and Paystack.
 *
 *   • creates a Korapay checkout for a wallet deposit
 *   • receives Korapay's webhook  → POST /api/webhooks/korapay
 *   • handles the browser return  → GET  /api/deposit/korapay/callback
 *   • re-checks pending deposits  → used by the 30-second reconciler + status route
 *
 * Safety rules
 *   • A webhook body is NEVER trusted on its own: its signature is checked AND the
 *     payment is re-confirmed with Korapay's API before a wallet is credited.
 *   • Crediting goes through the site's creditPaymentLinkDeposit(), which is atomic,
 *     so a payment can never be credited twice.
 *
 * Environment variables (server-side only):
 *   KORAPAY_SECRET_KEY      (required)  sk_test_... / sk_live_...
 *   KORAPAY_ALLOW_USD=true  (optional)  only if your Korapay account can take USD
 */
module.exports = function mountKorapay(ctx) {
  const { app, axios, crypto, PaymentLinkDeposit, creditPaymentLinkDeposit, getPlatform } = ctx;

  const BASE = () => process.env.KORAPAY_BASE_URL || 'https://api.korapay.com/merchant';
  const configured = () => !!process.env.KORAPAY_SECRET_KEY;

  function supportsCurrency(cur) {
    const c = String(cur || '').toUpperCase();
    return c === 'NGN' || (c === 'USD' && String(process.env.KORAPAY_ALLOW_USD || '').toLowerCase() === 'true');
  }

  const http = (method, path, options = {}) => axios({
    method, url: `${BASE()}${path}`, timeout: 15000, ...options,
    headers: { Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });

  // Returns { link, reference }
  async function createCheckout({ amount, currency, reference, customerName, customerEmail, redirectUrl, notificationUrl }) {
    const r = await http('post', '/api/v1/charges/initialize', {
      data: {
        reference,
        amount: Math.round(Number(amount) * 100) / 100, // major units (naira), not kobo
        currency: String(currency || 'NGN').toUpperCase(),
        redirect_url: redirectUrl,
        notification_url: notificationUrl,
        customer: { name: customerName || 'Customer', email: customerEmail },
        merchant_bears_cost: false
      }
    });
    const d = r.data && r.data.data;
    if (!r.data || !r.data.status || !d || !d.checkout_url) {
      throw new Error((r.data && r.data.message) || 'Korapay did not return a checkout link');
    }
    return { link: d.checkout_url, reference: d.reference || reference };
  }

  // null = Korapay has no record of this reference yet
  async function verify(reference) {
    try {
      const r = await http('get', `/api/v1/charges/${encodeURIComponent(reference)}`);
      if (!r.data || !r.data.status) return null;
      return r.data.data || null;
    } catch (e) {
      const st = e.response && e.response.status;
      if (st === 404) return null;
      throw e; // network/auth problem → caller treats as still pending
    }
  }

  function txOk(tx, deposit) {
    if (!tx) return false;
    if (String(tx.status || '').toLowerCase() !== 'success') return false;
    if (String(tx.reference || tx.payment_reference || '') !== String(deposit.txRef)) return false;
    const cur = String(tx.currency || deposit.currency || 'NGN').toUpperCase();
    if (cur !== String(deposit.currency || 'NGN').toUpperCase()) return false;
    return Number(tx.amount_paid != null ? tx.amount_paid : tx.amount) >= Number(deposit.amount) - 0.01;
  }

  function normalise(tx) {
    return { ...tx, id: tx.reference || tx.payment_reference || '', channel: tx.payment_method || '' };
  }

  async function checkAndCredit(deposit) {
    if (deposit.status === 'success') return 'success';
    const tx = await verify(deposit.txRef);
    if (txOk(tx, deposit)) {
      await creditPaymentLinkDeposit(deposit, normalise(tx));
      return 'success';
    }
    const st = String((tx && tx.status) || '').toLowerCase();
    if (['failed', 'cancelled', 'expired'].includes(st)) {
      await PaymentLinkDeposit.updateOne({ _id: deposit._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
      return 'failed';
    }
    return 'pending';
  }

  // Browser comes back here after paying
  app.get('/api/deposit/korapay/callback', async (req, res) => {
    const siteUrl = process.env.SITE_URL || '';
    const fail = `${siteUrl}/deposit?deposit=failed`;
    try {
      const reference = String(req.query.reference || '');
      if (!reference) return res.redirect(fail);
      const deposit = await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'korapay' });
      if (!deposit) return res.redirect(fail);
      if (deposit.status === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
      if (!configured()) return res.redirect(fail);
      try {
        const result = await checkAndCredit(deposit);
        if (result === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
        if (result === 'failed') return res.redirect(fail);
      } catch (e) { console.error('Korapay callback verify error:', e.response?.data || e.message); }
      return res.redirect(`${siteUrl}/deposit?deposit=pending&txRef=${encodeURIComponent(reference)}`);
    } catch (e) {
      console.error('Korapay callback error:', e.message);
      res.redirect(fail);
    }
  });

  // Webhook: set  https://YOUR-SITE/api/webhooks/korapay  in the Korapay dashboard.
  // Always processed, even when the switch is OFF — the customer has already paid.
  app.post('/api/webhooks/korapay', async (req, res) => {
    const secret = process.env.KORAPAY_SECRET_KEY || '';
    const received = String(req.headers['x-korapay-signature'] || '');
    const event = req.body || {};
    const data = event.data || {};
    const reference = String(data.reference || data.payment_reference || '');
    const log = async (status, message) => {
      try {
        const p = getPlatform && getPlatform();
        if (p) await p.logWebhook({
          provider: 'korapay', channel: 'paymentlink', event: event.event || 'unknown', reference,
          txId: reference, amount: Number(data.amount || 0), currency: data.currency, status, message, payload: event
        });
      } catch { /* logging never breaks a credit */ }
    };

    if (!secret) {
      await log('signature_rejected', 'KORAPAY_SECRET_KEY is not set');
      return res.status(401).json({ error: 'Webhook not configured' });
    }
    // Korapay signs ONLY the "data" object of the payload with HMAC-SHA256 using the secret key.
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex');
    let valid = false;
    try {
      const a = Buffer.from(expected, 'utf8'), b = Buffer.from(received, 'utf8');
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (!valid) {
      console.error('Korapay webhook REJECTED: bad x-korapay-signature');
      await log('signature_rejected', 'x-korapay-signature mismatch');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    try {
      if (event.event !== 'charge.success') {
        await log('ignored', `event ${event.event || 'unknown'} is not handled`);
        return res.json({ received: true });
      }
      const deposit = reference ? await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'korapay' }) : null;
      if (!deposit) { await log('ignored', 'no wallet deposit matches this reference'); return res.json({ received: true }); }
      if (deposit.status === 'success') { await log('ignored', 'already credited'); return res.json({ received: true }); }
      const tx = await verify(reference); // never trust the webhook body alone
      if (!txOk(tx, deposit)) {
        await log('failed', `verification failed: status=${tx && tx.status} paid=${tx && tx.amount_paid}`);
        return res.json({ received: true });
      }
      await creditPaymentLinkDeposit(deposit, normalise(tx));
      await log('processed', `credited ₦${deposit.creditAmount} for ${reference}`);
      return res.json({ received: true });
    } catch (e) {
      console.error('Korapay webhook error:', e.response?.data || e.message);
      await log('failed', e.message);
      return res.status(500).json({ error: 'Processing error' }); // non-2xx → Korapay retries
    }
  });

  // Safety net for a missed webhook (called every 30s)
  let running = false;
  async function reconcilePending() {
    if (running || !configured()) return;
    running = true;
    try {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const pending = await PaymentLinkDeposit.find({ status: 'pending', gateway: 'korapay', createdAt: { $gte: since48h } }).limit(60);
      for (const dep of pending) {
        try {
          const result = await checkAndCredit(dep);
          if (result === 'success') console.log(`[Auto-Reconcile] Pending Korapay deposit ${dep.txRef} succeeded — credited.`);
          else if (result === 'pending' && Date.now() - new Date(dep.createdAt).getTime() > 24 * 60 * 60 * 1000) {
            await PaymentLinkDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed' } });
          }
        } catch (err) {
          console.warn(`[Auto-Reconcile] Korapay check failed for ${dep.txRef}:`, err.response?.data?.message || err.message);
        }
      }
    } catch (e) {
      console.error('[Auto-Reconcile] reconcilePending (Korapay) error:', e.message);
    } finally { running = false; }
  }

  return { configured, supportsCurrency, createCheckout, verify, txOk, normalise, checkAndCredit, reconcilePending };
};
