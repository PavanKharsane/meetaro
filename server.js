// ============================================================
//  DATING APP - SERVER  (Node.js + Express + Socket.IO)
//  Run with:  npm start      then open  http://localhost:3000
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const PLAN_DAYS = 30;                    // each purchase lasts 30 days
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
db.users.forEach((u) => {
  u.location ||= '';
  u.interests ||= [];
});
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- HELPERS ----------
const hasChat  = (u) => (u.chatUntil  || 0) > Date.now();
const hasVideo = (u) => (u.videoUntil || 0) > Date.now();
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
app.use(express.json({ limit: '50kb' }));
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

// Buy a plan  -------------------------------------------------
// !!! TEST MODE: this gives the plan for free so you can test. !!!
// Before launch, replace with Razorpay: create the order, verify the
// payment signature, THEN give the plan. Never give plans without payment.
app.post('/api/subscribe', auth, (req, res) => {
  const plan = PLANS[(req.body || {}).plan];
  if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
  const u = req.user;
  const extend = (until) => Math.max(until || 0, Date.now()) + PLAN_DAYS * 864e5;
  if (plan.chat) u.chatUntil = extend(u.chatUntil);
  if (plan.video) u.videoUntil = extend(u.videoUntil);
  save();
  res.json(privateUser(u));
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
