# meetaro
Meetaro dating app with real-time chat, notifications, and video call signaling

## Run locally

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Copy `.env.example` to `.env` and set a unique `JWT_SECRET` of at least 32 characters. `npm start` loads `.env`; keep real credentials out of source control.

## GitHub Actions

The CI workflow runs for pushes and pull requests targeting `main`, and can also be started manually from the Actions tab. It checks the server and browser JavaScript on Node.js 22 and 24, smoke-tests the HTTP app and protected API, and audits production dependencies.

Automatic deployment is not configured yet; choose a hosting provider before adding deployment steps and credentials.

## Premium checkout

Premium checkout uses Razorpay Checkout. One-time payments support UPI, cards, and account-enabled wallets. BHIM, PhonePe, Paytm, and Amazon Pay availability depends on the payment methods enabled for the Razorpay merchant account. Recurring mandates support eligible cards and UPI AutoPay; wallets are not promised for recurring payments.

To configure Razorpay in test mode:

1. Copy `.env.example` to `.env` and add your Razorpay **test** Key ID, Key Secret, and Webhook Secret. Never put live keys in client code or commit `.env`.
2. In the Razorpay Dashboard test mode, create monthly subscription plans for Chat Premium (₹99), Video Premium (₹150), and Combo (₹179), then set their Plan IDs in `.env`. The one-time plan price and duration are enforced by the server.
3. Configure a Razorpay webhook at `https://<your-public-host>/api/razorpay/webhook` for `payment.captured`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, and `subscription.completed`. Set the generated webhook secret in `.env`.
4. Enable the requested payment methods in the Razorpay Dashboard. PhonePe and Amazon Pay wallet options require Razorpay approval. Razorpay Checkout shows only methods available to the merchant and customer.
5. Run `npm start` and test with Razorpay test credentials before configuring live credentials and a public HTTPS deployment.

Auto-renewal is optional and unchecked by default. When selected, customers authorize monthly recurring charges in Razorpay Checkout; they can cancel auto-renewal in the Plans page, with access continuing through the paid billing period. Without auto-renewal, a successful one-time payment grants 30 days. Subscriptions are enabled only after Razorpay verifies them; webhook signatures are checked against the raw request body and repeated events are idempotent.
