// ============================================================
//  DATING APP - SERVER  (Node.js + Express + Socket.IO)
//  Run with:  npm start      then open  http://localhost:3000
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- SETTINGS (change these as you like) ----------
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'CHANGE-THIS-LONG-RANDOM-SECRET-BEFORE-GOING-LIVE';
if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'CHANGE-THIS-LONG-RANDOM-SECRET-BEFORE-GOING-LIVE')) {
  throw new Error('Set JWT_SECRET to a unique random value of at least 32 characters before starting in production.');
}
const FREE_MESSAGE_LIMIT = 50;           // free messages per user
const PLAN_DAYS = 30;
const SUBSCRIPTION_CYCLES = 1200;
const PLANS = {
  chat:  { name: 'Chat Premium',  price: 99,  chat: true,  video: false },
  video: { name: 'Video Premium', price: 150, chat: false, video: true  },
  combo: { name: 'Combo',         price: 179, chat: true,  video: true  },
};

// ---------- VERY SIMPLE DATABASE (a JSON file) ----------
// Good for learning/testing. Move to PostgreSQL before real launch.
const FILE = path.join(__dirname, 'data.json');
let db = { users: [], likes: [], matches: [], messages: [] };
if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
db.users ||= [];
db.likes ||= [];
db.matches ||= [];
db.messages ||= [];
db.orders ||= [];
db.razorpaySubscriptions ||= [];
db.razorpayEventIds ||= [];
db.razorpayPaymentIds ||= [];
db.users.forEach((u) => {
  u.location ||= '';
  u.interests ||= [];
});
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- HELPERS ----------
const hasChat  = (u) => (u.chatUntil  || 0) > Date.now();
const hasVideo = (u) => (u.videoUntil || 0) > Date.now();
const planIdFor = (key) => process.env['RAZORPAY_PLAN_' + key.toUpperCase()];
const paymentConfigReady = () => Boolean(
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET &&
  process.env.RAZORPAY_WEBHOOK_SECRET
);
function verifyHmac(message, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(message).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
async function razorpayRequest(endpoint, method = 'GET', body) {
  const apiBase = process.env.NODE_ENV === 'test' && process.env.RAZORPAY_API_BASE_URL
    ? process.env.RAZORPAY_API_BASE_URL
    : 'https://api.razorpay.com/v1';
  const response = await fetch(apiBase + endpoint, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.description || 'Payment provider request failed.');
  return result;
}
const publicUser = (u) => ({
  id: u.id, name: u.name, age: u.age, gender: u.gender, bio: u.bio,
  location: u.location || '', interests: u.interests || [],
});
const privateUser = (u) => ({
  ...publicUser(u),
  email: u.email,
  freeLeft: Math.max(0, FREE_MESSAGE_LIMIT - (u.sent || 0)),
  chat: hasChat(u),
  video: hasVideo(u),
  chatUntil: u.chatUntil || 0,
  videoUntil: u.videoUntil || 0,
  autoRenew: Boolean(db.razorpaySubscriptions.slice().reverse().find((subscription) =>
    subscription.userId === u.id && !['cancelled', 'completed', 'expired'].includes(subscription.status) &&
    !subscription.cancelAtCycleEnd && !['created', 'authenticated', 'pending'].includes(subscription.status))),
  autoRenewPending: Boolean(db.razorpaySubscriptions.slice().reverse().find((subscription) =>
    subscription.userId === u.id && !subscription.cancelAtCycleEnd &&
    ['created', 'authenticated', 'pending'].includes(subscription.status))),
});
const otherOf = (m, id) => (m.a === id ? m.b : m.a);
const myMatch = (matchId, userId) =>
  db.matches.find((m) => m.id === matchId && (m.a === userId || m.b === userId));

// Tiny rate limiter (stops password guessing / spam)
const hits = {};
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    hits[key] = (hits[key] || []).filter((t) => now - t < windowMs);
    if (hits[key].length >= max) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    hits[key].push(now);
    next();
  };
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { id } = jwt.verify(token, SECRET);
    req.user = db.users.find((u) => u.id === id);
    if (!req.user) throw new Error('no user');
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

// ---------- WEB SERVER ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100000 });
app.use(express.json({
  limit: '50kb',
  verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Sign up
app.post('/api/signup', limit(10, 60 * 60 * 1000), async (req, res) => {
  const { name, email, password, age, gender, bio, location, interests } = req.body || {};
  if (!name || !email || !password || !age || !gender) return res.status(400).json({ error: 'Please fill all fields.' });
  if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) return res.status(400).json({ error: 'Enter a valid email.' });
  if (String(password).length < 8 || String(password).length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (!Number.isInteger(Number(age)) || Number(age) < 18 || Number(age) > 120) return res.status(400).json({ error: 'You must be 18 or older.' });
  if (typeof name !== 'string' || !name.trim() || typeof gender !== 'string') return res.status(400).json({ error: 'Enter a valid name and gender.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (db.users.find((u) => u.email === normalizedEmail)) return res.status(400).json({ error: 'Email already registered.' });
  const user = {
    id: newId(),
    name: name.trim().slice(0, 40),
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    age: Number(age),
    gender: String(gender).slice(0, 20),
    bio: String(bio || '').slice(0, 300),
    location: typeof location === 'string' ? location.trim().slice(0, 80) : '',
    interests: Array.isArray(interests) ? interests.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 30)).filter(Boolean).slice(0, 12) : [],
    sent: 0, chatUntil: 0, videoUntil: 0,
  };
  db.users.push(user);
  save();
  res.json({ token: jwt.sign({ id: user.id }, SECRET, { expiresIn: '7d' }), user: privateUser(user) });
});

// Log in
app.post('/api/login', limit(10, 15 * 60 * 1000), async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
    return res.status(400).json({ error: 'Wrong email or password.' });
  res.json({ token: jwt.sign({ id: user.id }, SECRET, { expiresIn: '7d' }), user: privateUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(privateUser(req.user)));

app.put('/api/profile', auth, (req, res) => {
  const { location, interests } = req.body || {};
  if (typeof location !== 'string' || !Array.isArray(interests) || interests.length > 12 ||
      interests.some((item) => typeof item !== 'string' || item.trim().length > 30)) {
    return res.status(400).json({ error: 'Enter a location and up to 12 valid interests.' });
  }
  req.user.location = location.trim().slice(0, 80);
  req.user.interests = [...new Set(interests.map((item) => item.trim()).filter(Boolean))];
  save();
  res.json(publicUser(req.user));
});

// People to swipe on
app.get('/api/discover', auth, (req, res) => {
  const seen = db.likes.filter((l) => l.from === req.user.id).map((l) => l.to);
  const location = (req.user.location || '').trim().toLowerCase();
  const interests = new Set((req.user.interests || []).map((item) => item.toLowerCase()));
  const list = db.users.filter((u) => u.id !== req.user.id && !seen.includes(u.id)).map((u) => {
    const shared = (u.interests || []).filter((item) => interests.has(item.toLowerCase())).length;
    const nearby = location && (u.location || '').trim().toLowerCase() === location;
    return { ...publicUser(u), recommendation: nearby && shared ? 'Nearby · shared interests' : nearby ? 'Nearby' : shared ? 'Shared interests' : '', score: shared + (nearby ? 2 : 0) };
  }).sort((a, b) => b.score - a.score).map(({ score, ...user }) => user);
  res.json(list);
});

// Like / pass
app.post('/api/like', auth, (req, res) => {
  const { toId, like } = req.body || {};
  const target = db.users.find((u) => u.id === toId);
  if (!target || target.id === req.user.id) return res.status(400).json({ error: 'Invalid user.' });
  if (db.likes.find((l) => l.from === req.user.id && l.to === toId)) return res.json({ matched: false });
  db.likes.push({ from: req.user.id, to: toId, like: !!like });
  let matched = false;
  if (like && db.likes.find((l) => l.from === toId && l.to === req.user.id && l.like)) {
    db.matches.push({ id: newId(), a: req.user.id, b: toId });
    matched = true;
  }
  save();
  res.json({ matched, name: target.name });
});

// My matches
app.get('/api/matches', auth, (req, res) => {
  const list = db.matches
    .filter((m) => m.a === req.user.id || m.b === req.user.id)
    .map((m) => ({
      id: m.id,
      user: publicUser(db.users.find((u) => u.id === otherOf(m, req.user.id))),
      unread: db.messages.filter((msg) => msg.matchId === m.id && msg.from !== req.user.id && !(msg.readBy || []).includes(req.user.id)).length,
    }));
  res.json(list);
});

// Old messages in a chat
app.get('/api/messages/:matchId', auth, (req, res) => {
  if (!myMatch(req.params.matchId, req.user.id)) return res.status(403).json({ error: 'Not allowed.' });
  res.json(db.messages.filter((m) => m.matchId === req.params.matchId));
});

app.post('/api/messages/:matchId/read', auth, (req, res) => {
  if (!myMatch(req.params.matchId, req.user.id)) return res.status(403).json({ error: 'Not allowed.' });
  db.messages.forEach((msg) => {
    if (msg.matchId === req.params.matchId && msg.from !== req.user.id) {
      msg.readBy ||= [];
      msg.deliveredTo ||= [];
      if (!msg.deliveredTo.includes(req.user.id)) msg.deliveredTo.push(req.user.id);
      if (!msg.readBy.includes(req.user.id)) {
        msg.readBy.push(req.user.id);
        io.to('u:' + msg.from).emit('receipt', { matchId: msg.matchId, messageId: msg.id, delivered: true, read: true });
      }
    }
  });
  save();
  io.to('u:' + req.user.id).emit('read', { matchId: req.params.matchId });
  res.json({ ok: true });
});

function activatePaidPlan(user, planKey, until) {
  if (!Number.isFinite(until) || until <= Date.now()) return false;
  const plan = PLANS[planKey];
  if (!plan) return false;
  if (plan.chat) user.chatUntil = Math.max(user.chatUntil || 0, until);
  if (plan.video) user.videoUntil = Math.max(user.videoUntil || 0, until);
  return true;
}

function activateOrder(order, payment) {
  if (!order || order.status === 'paid' || db.razorpayPaymentIds.includes(payment.id)) return;
  if (payment.status !== 'captured' || payment.order_id !== order.id ||
      payment.amount !== order.amount || payment.currency !== 'INR') return;
  const user = db.users.find((candidate) => candidate.id === order.userId);
  if (!user) return;
  const plan = PLANS[order.planKey];
  if (!plan) return;
  const currentExpiry = Math.max(
    plan.chat ? user.chatUntil || 0 : 0,
    plan.video ? user.videoUntil || 0 : 0,
    Date.now(),
  );
  const expiry = currentExpiry + PLAN_DAYS * 864e5;
  activatePaidPlan(user, order.planKey, expiry);
  order.status = 'paid';
  order.paymentId = payment.id;
  db.razorpayPaymentIds.push(payment.id);
  db.razorpayPaymentIds = db.razorpayPaymentIds.slice(-5000);
  save();
}

function activateSubscription(record, providerSubscription) {
  const expectedPlanId = planIdFor(record.planKey);
  const user = db.users.find((candidate) => candidate.id === record.userId);
  const end = Number(providerSubscription.current_end) * 1000;
  if (!user || !expectedPlanId || providerSubscription.id !== record.id ||
      providerSubscription.plan_id !== expectedPlanId ||
      providerSubscription.notes?.user_id !== record.userId ||
      providerSubscription.notes?.plan_key !== record.planKey ||
      providerSubscription.status !== 'active' ||
      !activatePaidPlan(user, record.planKey, end)) return false;
  record.status = providerSubscription.status;
  record.currentEnd = end;
  save();
  return true;
}

app.post('/api/checkout', limit(10, 15 * 60 * 1000), auth, async (req, res) => {
  const { plan: planKey, autoRenew } = req.body || {};
  const plan = PLANS[planKey];
  if (!plan || typeof autoRenew !== 'boolean') return res.status(400).json({ error: 'Choose a valid plan and renewal option.' });
  if (!paymentConfigReady()) return res.status(503).json({ error: 'Payment checkout is not configured. Set Razorpay test keys and a webhook secret.' });

  try {
    if (autoRenew) {
      const existingSubscription = db.razorpaySubscriptions.find((subscription) =>
        subscription.userId === req.user.id &&
        ['created', 'authenticated', 'active', 'pending'].includes(subscription.status) &&
        !subscription.cancelAtCycleEnd);
      if (existingSubscription) return res.status(409).json({ error: 'You already have an active or pending auto-renewing plan. Cancel it before starting another.' });
      const planId = planIdFor(planKey);
      if (!planId) return res.status(503).json({ error: 'Recurring billing is not configured for this plan yet.' });
      const subscription = await razorpayRequest('/subscriptions', 'POST', {
        plan_id: planId,
        total_count: SUBSCRIPTION_CYCLES,
        quantity: 1,
        customer_notify: true,
        notes: { user_id: req.user.id, plan_key: planKey },
      });
      db.razorpaySubscriptions.push({
        id: subscription.id,
        planId,
        userId: req.user.id,
        planKey,
        status: subscription.status,
        createdAt: Date.now(),
        cancelAtCycleEnd: false,
      });
      save();
      return res.json({
        type: 'subscription',
        keyId: process.env.RAZORPAY_KEY_ID,
        subscriptionId: subscription.id,
        name: plan.name,
        description: plan.name + ' with monthly auto-renewal',
        email: req.user.email,
      });
    }

    const order = await razorpayRequest('/orders', 'POST', {
      amount: plan.price * 100,
      currency: 'INR',
      receipt: 'meetaro_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24),
      notes: { user_id: req.user.id, plan_key: planKey },
    });
    db.orders.push({
      id: order.id,
      userId: req.user.id,
      planKey,
      amount: plan.price * 100,
      status: 'created',
      createdAt: Date.now(),
    });
    save();
    res.json({
      type: 'order',
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: plan.name,
      description: plan.name + ' for 30 days',
      email: req.user.email,
    });
  } catch (error) {
    console.error('Razorpay checkout initialization failed:', error.message);
    res.status(502).json({ error: 'Could not start secure checkout. Please try again.' });
  }
});

app.post('/api/checkout/verify-order', auth, async (req, res) => {
  const { plan: planKey, orderId, paymentId, signature } = req.body || {};
  const order = db.orders.find((candidate) =>
    candidate.id === orderId && candidate.userId === req.user.id && candidate.planKey === planKey);
  if (!order || typeof paymentId !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Invalid checkout confirmation.' });
  }
  if (!paymentConfigReady()) return res.status(503).json({ error: 'Payment verification is not configured.' });
  if (!verifyHmac(orderId + '|' + paymentId, signature, process.env.RAZORPAY_KEY_SECRET)) {
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }
  if (order.status === 'paid') return res.json(privateUser(req.user));

  try {
    const payment = await razorpayRequest('/payments/' + encodeURIComponent(paymentId));
    if (payment.order_id !== order.id || payment.amount !== order.amount || payment.currency !== 'INR') {
      return res.status(400).json({ error: 'Payment details do not match this order.' });
    }
    if (payment.status !== 'captured') return res.status(202).json({ pending: true, message: 'Payment is awaiting confirmation.' });
    activateOrder(order, payment);
    res.json(privateUser(req.user));
  } catch (error) {
    console.error('Razorpay payment verification failed:', error.message);
    res.status(502).json({ error: 'Could not verify payment right now. Your payment was not marked complete.' });
  }
});

app.post('/api/checkout/verify-subscription', auth, async (req, res) => {
  const { subscriptionId, paymentId, signature } = req.body || {};
  const record = db.razorpaySubscriptions.find((subscription) =>
    subscription.id === subscriptionId && subscription.userId === req.user.id);
  if (!record || typeof paymentId !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Invalid subscription confirmation.' });
  }
  if (!paymentConfigReady()) return res.status(503).json({ error: 'Subscription verification is not configured.' });
  if (!verifyHmac(paymentId + '|' + subscriptionId, signature, process.env.RAZORPAY_KEY_SECRET)) {
    return res.status(400).json({ error: 'Subscription signature verification failed.' });
  }
  try {
    const subscription = await razorpayRequest('/subscriptions/' + encodeURIComponent(subscriptionId));
    if (subscription.status === 'active' && activateSubscription(record, subscription)) {
      return res.json(privateUser(req.user));
    }
    if (['created', 'authenticated', 'pending'].includes(subscription.status)) {
      record.status = subscription.status;
      save();
      return res.status(202).json({ pending: true, message: 'Your mandate is awaiting confirmation.' });
    }
    res.status(409).json({ error: 'The recurring payment mandate was not activated.' });
  } catch (error) {
    console.error('Razorpay subscription verification failed:', error.message);
    res.status(502).json({ error: 'Could not verify the mandate right now. Please check again shortly.' });
  }
});

app.post('/api/razorpay/webhook', (req, res) => {
  const signature = req.get('X-Razorpay-Signature');
  const eventId = req.get('X-Razorpay-Event-Id');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || !req.rawBody ||
      !verifyHmac(req.rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }
  if (eventId && db.razorpayEventIds.includes(eventId)) return res.json({ ok: true, duplicate: true });

  const event = req.body?.event;
  if (event === 'payment.captured') {
    const payment = req.body.payload?.payment?.entity;
    const order = db.orders.find((candidate) => candidate.id === payment?.order_id);
    if (order) activateOrder(order, payment);
  } else if (['subscription.activated', 'subscription.charged', 'subscription.halted',
    'subscription.cancelled', 'subscription.completed'].includes(event)) {
    const providerSubscription = req.body.payload?.subscription?.entity;
    const record = db.razorpaySubscriptions.find((subscription) => subscription.id === providerSubscription?.id);
    if (record) {
      record.status = providerSubscription.status;
      if (providerSubscription.status === 'active') activateSubscription(record, providerSubscription);
      else save();
    }
  }
  if (eventId) {
    db.razorpayEventIds.push(eventId);
    db.razorpayEventIds = db.razorpayEventIds.slice(-5000);
    save();
  }
  res.json({ ok: true });
});

app.post('/api/subscription/cancel', auth, limit(5, 60 * 60 * 1000), async (req, res) => {
  const record = db.razorpaySubscriptions.slice().reverse().find((subscription) =>
    subscription.userId === req.user.id &&
    ['created', 'authenticated', 'active', 'pending'].includes(subscription.status) &&
    !subscription.cancelAtCycleEnd);
  if (!record) return res.status(404).json({ error: 'No active auto-renewing plan was found.' });
  if (!paymentConfigReady()) return res.status(503).json({ error: 'Subscription management is not configured.' });
  try {
    const result = await razorpayRequest('/subscriptions/' + encodeURIComponent(record.id) + '/cancel', 'POST', {
      cancel_at_cycle_end: true,
    });
    record.status = result.status || record.status;
    record.cancelAtCycleEnd = true;
    save();
    res.json({ ok: true, message: 'Auto-renewal is cancelled. Your current paid period remains active.' });
  } catch (error) {
    console.error('Razorpay subscription cancellation failed:', error.message);
    res.status(502).json({ error: 'Could not cancel auto-renewal. Please try again.' });
  }
});

app.post('/api/subscribe', auth, (req, res) => {
  if (!PLANS[(req.body || {}).plan]) return res.status(400).json({ error: 'Unknown plan.' });
  res.status(410).json({ error: 'Use the secure /api/checkout flow. No payment was taken or plan activated.' });
});

// ---------- REAL-TIME (chat + video call signalling) ----------
io.use((socket, next) => {
  try {
    const { id } = jwt.verify(socket.handshake.auth.token, SECRET);
    socket.user = db.users.find((u) => u.id === id);
    socket.user ? next() : next(new Error('auth'));
  } catch { next(new Error('auth')); }
});

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join('u:' + me.id);
  let deliveryChanged = false;
  db.messages.forEach((msg) => {
    if (msg.from !== me.id && !(msg.deliveredTo || []).includes(me.id)) {
      msg.deliveredTo ||= [];
      msg.deliveredTo.push(me.id);
      deliveryChanged = true;
      io.to('u:' + msg.from).emit('receipt', { matchId: msg.matchId, messageId: msg.id, delivered: true, read: false });
    }
  });
  if (deliveryChanged) save();

  // Send a chat message. The 50-message limit is enforced HERE on the server.
  let messageTimes = [];
  socket.on('send', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { matchId, text: rawText } = payload || {};
    const m = myMatch(matchId, me.id);
    const text = typeof rawText === 'string' ? rawText.trim().slice(0, 1000) : '';
    const now = Date.now();
    messageTimes = messageTimes.filter((at) => now - at < 60000);
    if (!m || !text) return reply({ error: 'Invalid message.' });
    if (messageTimes.length >= 30) return reply({ error: 'Please slow down before sending more messages.' });
    if (!hasChat(me) && (me.sent || 0) >= FREE_MESSAGE_LIMIT)
      return reply({ error: 'LIMIT' });
    messageTimes.push(now);
    me.sent = (me.sent || 0) + 1;
    const recipientId = otherOf(m, me.id);
    const delivered = Boolean(io.sockets.adapter.rooms.get('u:' + recipientId)?.size);
    const msg = { id: newId(), matchId, from: me.id, text, at: now, deliveredTo: delivered ? [recipientId] : [], readBy: [] };
    db.messages.push(msg);
    save();
    io.to('u:' + me.id).emit('message', msg);
    io.to('u:' + recipientId).emit('message', msg);
    io.to('u:' + recipientId).emit('notification', { type: 'message', matchId, from: me.id, name: me.name, text, at: now });
    if (delivered) io.to('u:' + me.id).emit('receipt', { matchId, messageId: msg.id, delivered: true, read: false });
    reply({ ok: true, freeLeft: Math.max(0, FREE_MESSAGE_LIMIT - me.sent), chat: hasChat(me) });
  });

  // Video call signalling. Only users with an active video plan can START a call.
  socket.on('call', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { matchId, type, data } = payload || {};
    const m = myMatch(matchId, me.id);
    if (!m) return reply({ error: 'Not allowed.' });
    if (!['offer', 'answer', 'ice', 'end'].includes(type)) return reply({ error: 'Invalid call signal.' });
    if (type === 'offer' && !hasVideo(me)) return reply({ error: 'VIDEO_PREMIUM' });
    if (type !== 'end' && (typeof data !== 'object' || data === null)) return reply({ error: 'Invalid call signal.' });
    io.to('u:' + otherOf(m, me.id)).emit('call', { matchId, type, data });
    reply({ ok: true });
  });
});

server.listen(PORT, () => console.log('App running at http://localhost:' + PORT));
