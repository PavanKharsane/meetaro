const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const keyId = 'rzp_test_meetaro';
const keySecret = 'test-only-secret';
const webhookSecret = 'test-webhook-secret';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function sign(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

test('Razorpay checkout, signature verification, webhook activation and cancellation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetaro-payment-test-'));
  const orders = new Map();
  const subscriptions = new Map();
  let orderCounter = 0;
  let subscriptionCounter = 0;

  const razorpayMock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const auth = Buffer.from(keyId + ':' + keySecret).toString('base64');
    if (req.headers.authorization !== 'Basic ' + auth) {
      res.writeHead(401).end(JSON.stringify({ error: { description: 'Invalid credentials' } }));
      return;
    }
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && req.url === '/v1/orders') {
      const order = { id: `order_test_${++orderCounter}`, ...body };
      orders.set(order.id, order);
      send(200, order);
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/payments/payment_test_1') {
      const order = orders.get('order_test_1');
      send(200, { id: 'payment_test_1', order_id: order.id, amount: order.amount, currency: order.currency, status: 'captured' });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/subscriptions') {
      const subscription = {
        id: `sub_test_${++subscriptionCounter}`,
        status: 'created',
        current_end: null,
        ...body,
      };
      subscriptions.set(subscription.id, subscription);
      send(200, subscription);
      return;
    }
    const subscriptionMatch = req.url.match(/^\/v1\/subscriptions\/([^/]+)(\/cancel)?$/);
    if (subscriptionMatch && req.method === 'GET') {
      send(200, subscriptions.get(subscriptionMatch[1]) || {});
      return;
    }
    if (subscriptionMatch && req.method === 'POST' && subscriptionMatch[2]) {
      const subscription = subscriptions.get(subscriptionMatch[1]);
      subscription.cancel_at_cycle_end = body.cancel_at_cycle_end;
      send(200, subscription);
      return;
    }
    send(404, { error: { description: 'Mock route not found' } });
  });

  let appServer;
  try {
    await new Promise((resolve) => razorpayMock.listen(0, '127.0.0.1', resolve));
    const razorpayPort = razorpayMock.address().port;
    const appPort = await freePort();
    fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(tempDir, 'server.js'));
    fs.cpSync(path.join(projectRoot, 'public'), path.join(tempDir, 'public'), { recursive: true });

    appServer = spawn(process.execPath, ['server.js'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(appPort),
        NODE_PATH: path.join(projectRoot, 'node_modules'),
        JWT_SECRET: 'isolated-payment-test-jwt-secret',
        RAZORPAY_KEY_ID: keyId,
        RAZORPAY_KEY_SECRET: keySecret,
        RAZORPAY_WEBHOOK_SECRET: webhookSecret,
        RAZORPAY_PLAN_CHAT: 'plan_chat_test',
        RAZORPAY_PLAN_VIDEO: 'plan_video_test',
        RAZORPAY_PLAN_COMBO: 'plan_combo_test',
        RAZORPAY_API_BASE_URL: `http://127.0.0.1:${razorpayPort}/v1`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    appServer.stderr.setEncoding('utf8');
    appServer.stderr.on('data', (chunk) => { stderr += chunk; });

    const baseUrl = `http://127.0.0.1:${appPort}`;
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (appServer.exitCode !== null) throw new Error(`App exited during startup: ${stderr}`);
      try {
        if ((await fetch(baseUrl)).ok) {
          started = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(started, `App did not start: ${stderr}`);

    const signup = await fetch(baseUrl + '/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Payment Tester',
        email: `payment-${Date.now()}@example.test`,
        password: 'Test-password-123',
        age: 28,
        gender: 'other',
      }),
    });
    assert.equal(signup.status, 200);
    const { token } = await signup.json();
    const api = (route, method = 'GET', data) => fetch(baseUrl + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });

    const createdOrder = await api('/api/checkout', 'POST', { plan: 'chat', autoRenew: false });
    assert.equal(createdOrder.status, 200);
    const order = await createdOrder.json();
    assert.equal(order.amount, 9900);
    assert.equal(order.type, 'order');
    assert.equal((await (await api('/api/me')).json()).chat, false);

    const badSignature = await api('/api/checkout/verify-order', 'POST', {
      plan: 'chat', orderId: order.orderId, paymentId: 'payment_test_1', signature: '0'.repeat(64),
    });
    assert.equal(badSignature.status, 400);

    const verified = await api('/api/checkout/verify-order', 'POST', {
      plan: 'chat',
      orderId: order.orderId,
      paymentId: 'payment_test_1',
      signature: sign(order.orderId + '|payment_test_1', keySecret),
    });
    assert.equal(verified.status, 200);
    const firstExpiry = (await (await api('/api/me')).json()).chatUntil;
    assert.ok(firstExpiry > Date.now());
    await api('/api/checkout/verify-order', 'POST', {
      plan: 'chat',
      orderId: order.orderId,
      paymentId: 'payment_test_1',
      signature: sign(order.orderId + '|payment_test_1', keySecret),
    });
    assert.equal((await (await api('/api/me')).json()).chatUntil, firstExpiry, 'repeated verification must not extend access');

    const createdSubscription = await api('/api/checkout', 'POST', { plan: 'combo', autoRenew: true });
    assert.equal(createdSubscription.status, 200);
    const subscriptionInfo = await createdSubscription.json();
    assert.equal(subscriptionInfo.type, 'subscription');
    assert.equal(subscriptions.get(subscriptionInfo.subscriptionId).total_count, 1200);
    assert.equal((await (await api('/api/me')).json()).autoRenewPending, true);
    assert.equal((await api('/api/checkout', 'POST', { plan: 'video', autoRenew: true })).status, 409);

    const providerSubscription = subscriptions.get(subscriptionInfo.subscriptionId);
    providerSubscription.status = 'active';
    providerSubscription.current_end = Math.floor(Date.now() / 1000) + 30 * 86400;
    const verification = await api('/api/checkout/verify-subscription', 'POST', {
      subscriptionId: subscriptionInfo.subscriptionId,
      paymentId: 'payment_subscription_test',
      signature: sign('payment_subscription_test|' + subscriptionInfo.subscriptionId, keySecret),
    });
    assert.equal(verification.status, 200);
    assert.equal((await (await api('/api/me')).json()).autoRenew, true);

    const event = {
      event: 'subscription.charged',
      payload: { subscription: { entity: providerSubscription } },
    };
    const rawEvent = JSON.stringify(event);
    const webhook = () => fetch(baseUrl + '/api/razorpay/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': sign(rawEvent, webhookSecret),
        'X-Razorpay-Event-Id': 'event_test_1',
      },
      body: rawEvent,
    });
    assert.equal((await webhook()).status, 200);
    assert.equal((await (await webhook()).json()).duplicate, true);
    const invalidWebhook = await fetch(baseUrl + '/api/razorpay/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': '0'.repeat(64) },
      body: rawEvent,
    });
    assert.equal(invalidWebhook.status, 400);

    const cancelled = await api('/api/subscription/cancel', 'POST', {});
    assert.equal(cancelled.status, 200);
    assert.equal((await (await api('/api/me')).json()).autoRenew, false);
    assert.equal((await (await api('/api/me')).json()).autoRenewPending, false);
    assert.equal((await api('/api/subscribe', 'POST', { plan: 'combo' })).status, 410);
  } finally {
    if (appServer && appServer.exitCode === null) {
      appServer.kill();
      await once(appServer, 'exit');
    }
    if (razorpayMock.listening) {
      await new Promise((resolve) => razorpayMock.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
