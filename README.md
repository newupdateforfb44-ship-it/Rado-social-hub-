# Rado Social Hub

SMS numbers, social accounts and digital products.

- Start: `npm install && npm start`
- Site name, colours, WhatsApp and domain are in `site.config.js` (or the BRAND_* environment variables).
- Payment/transaction prefix: `RSH`.

## Business tools (admin) and customer extras
- Admin Panel -> **Business tools**: money dashboard, provider balances, stuck/failed orders with one-click refund,
  customer lookup (credit/debit/restrict), activity + price-change history, CSV export.
- Customers get a notification bell, a search/favourites/recent panel, low-balance and price-changed pop-ups, and "Buy again" in order history.

## SMS Numbers + Products provider (lib/benotp.js)
Set these in your Render environment (never in the code):
- `BENOTP_API_KEY` (required)
- `BENOTP_MARKUP_PERCENT` (optional, % added to the provider price; default 0)
- `BENOTP_PRODUCTS_MARKUP_PERCENT` (optional, defaults to the number markup)
- `BENOTP_PRICE_MULTIPLIER` (optional, e.g. 1600 if the provider prices are in USD; default 1)
- `BENOTP_NUMBER_TTL_MIN` (optional, minutes to wait for an SMS before auto-cancel + refund; default 20)

Check the connection (admin logged in): `GET /api/rado/admin/benotp-test` shows the provider's raw answers.

## Deposits — Flutterwave, Paystack, Kuropay (Korapay)
Set the keys in your Render environment (never in the code), then switch each gateway ON/OFF in
**Admin Panel → Payment methods**. Only gateways that are ON *and* have their keys set appear on the customer Deposit page.
- Flutterwave: `FLW_V3_SECRET_KEY`, `FLW_SECRET_HASH`
- Paystack: `PAYSTACK_SECRET_KEY`
- Kuropay: `KORAPAY_SECRET_KEY` (optional `KORAPAY_ALLOW_USD=true`)
- `SITE_URL` must be your live https address (used for payment return links).

Webhook URLs to paste in each dashboard (also shown in the admin panel):
`/api/webhooks/flutterwave`, `/api/webhooks/paystack`, `/api/webhooks/korapay`.
Every payment reference and name uses the site name / `RSH` prefix from `site.config.js`.

## Control room (Admin Panel -> Control room) - lib/ops.js
- **Maintenance switch:** close the whole site, or only deposits / orders / SMS numbers, with a message. Webhooks, payment callbacks and the admin panel keep working.
- **Payment tools:** per-method (payment link, bank transfer) min/max deposit limits in naira, plus a Test connection button for Flutterwave, Paystack and Kuropay.
- **Daily summary email:** deposits, sales, orders needing attention, provider balances. Needs `RESEND_API_KEY`; the address is set in the Control room (or `ADMIN_ALERT_EMAIL`).
- **Backup:** owner-only download of all data (passwords and secret keys left out).
- **Rate limits:** deposit creation (12 / 10 min), purchases (40 / min), staff login (10 failed / 15 min), plus the existing login limits.
- Customers: `GET /api/user/deposit-history` feeds a "Recent deposits" list on the Deposit page.

## Product refund policy
Products (BenOTP products) are NEVER refunded automatically. A failed or unclear answer from the supplier
holds the order as "review" with the money kept; the admin then sends the log, resyncs, or refunds from the Logs tab
(or Business tools -> stuck orders). SMS numbers that receive no code are still refunded automatically.

## Providers
This site sells only BenOTP numbers and products. All older providers have been removed from the code.
