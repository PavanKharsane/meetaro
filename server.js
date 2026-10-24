const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE-THIS-LONG-RANDOM-SECRET-BEFORE-GOING-LIVE';
if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'CHANGE-THIS-LONG-RANDOM-SECRET-BEFORE-GOING-LIVE')) {
  throw new Error('Set JWT_SECRET to a unique random value of at least 32 characters before starting in production.');
}

const DATA_FILE = path.join(__dirname, 'data.json');
const db = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { users: [] };
for (const key of ['users', 'pendingSignups', 'hostApplications', 'travelBookings', 'travelReviews', 'travelReports', 'travelAudit']) {
  if (!Array.isArray(db[key])) db[key] = [];
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const newId = () => crypto.randomBytes(12).toString('base64url');

const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpUser = process.env.SMTP_USER || '';
const smtpPassword = process.env.SMTP_PASSWORD || '';
const mailTransport = smtpUser && smtpPassword
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.zoho.in',
    port: smtpPort,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPassword },
  })
  : null;
const mailFrom = process.env.MAIL_FROM || 'Meetaro <meetaro@zohomail.in>';
const hostApplicationNotifyEmail = process.env.HOST_APPLICATION_NOTIFY_EMAIL || 'meetaro@zohomail.in';
const verificationTtlMs = 10 * 60 * 1000;
const verificationResendDelayMs = 60 * 1000;
const verificationMaxAttempts = 5;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function sendEmail(message) {
  if (!mailTransport) {
    const error = new Error('Email delivery is not configured. Set SMTP_USER and SMTP_PASSWORD in .env.');
    error.status = 503;
    throw error;
  }
  try {
    await mailTransport.sendMail({ from: mailFrom, ...message });
  } catch (cause) {
    console.error('Email delivery failed:', cause.message);
    const error = new Error('Meetaro could not send the email. Check the SMTP settings and try again.');
    error.status = 502;
    throw error;
  }
}

function verificationCodeHash(email, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`${email}:${code}`).digest('hex');
}

function createVerificationCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

async function sendVerificationEmail(email, name, code) {
  const safeName = escapeHtml(name);
  await sendEmail({
    to: email,
    subject: 'Your Meetaro verification code',
    text: `Hi ${name},\n\nYour Meetaro verification code is: ${code}\n\nThis code expires in 10 minutes. If you did not request it, you can ignore this email.`,
    html: `<p>Hi ${safeName},</p><p>Your Meetaro verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`,
  });
}

async function sendWelcomeEmail(email, name) {
  const safeName = escapeHtml(name);
  await sendEmail({
    to: email,
    subject: 'Welcome to Meetaro',
    text: `Hi ${name},\n\nWelcome to Meetaro! Your email is verified and your traveller account is ready. Explore local stays, regional food, and experiences shared by hosts.\n\nQuestions or concerns? Email meetaro@zohomail.in.\n\nThe Meetaro team`,
    html: `<p>Hi ${safeName},</p><p>Welcome to Meetaro! Your email is verified and your traveller account is ready.</p><p>Explore local stays, regional food, and experiences shared by hosts.</p><p>Questions or concerns? Email <a href="mailto:meetaro@zohomail.in">meetaro@zohomail.in</a>.</p><p>The Meetaro team</p>`,
  });
}

async function sendHostApplicationNotification({ applicationId, publicName, city }) {
  const safeName = escapeHtml(publicName);
  const safeCity = escapeHtml(city);
  await sendEmail({
    to: hostApplicationNotifyEmail,
    subject: 'The New Host has been registered',
    text: `A new host application has been submitted to Meetaro.\n\nPublic name: ${publicName}\nCity: ${city}\nApplication ID: ${applicationId}\n\nReview the application in the restricted Meetaro admin dashboard. This notification does not mean the host has been approved.`,
    html: `<p>A new host application has been submitted to Meetaro.</p><p><strong>Public name:</strong> ${safeName}<br><strong>City:</strong> ${safeCity}<br><strong>Application ID:</strong> ${escapeHtml(applicationId)}</p><p>Review the application in the restricted Meetaro admin dashboard. This notification does not mean the host has been approved.</p>`,
  });
}

function ensureAdminAccount() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return;
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 16 || password.length > 128) {
    throw new Error('Configure both ADMIN_EMAIL and an ADMIN_PASSWORD of 16 to 128 characters.');
  }
  const existing = db.users.find((user) => user.email === email);
  if (existing && existing.role !== 'admin') {
    throw new Error('ADMIN_EMAIL is already registered as a non-admin user. Choose a separate admin email.');
  }
  if (existing) {
    existing.passwordHash = bcrypt.hashSync(password, 12);
    save();
    return;
  }
  db.users.push({
    id: newId(),
    name: 'Meetaro Administrator',
    email,
    passwordHash: bcrypt.hashSync(password, 12),
    role: 'admin',
    emailVerified: true,
    age: 0,
    gender: '',
  });
  save();
}
ensureAdminAccount();

const rateLimitHits = new Map();
function limit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const recent = (rateLimitHits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= maxRequests) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    recent.push(now);
    rateLimitHits.set(key, recent);
    next();
  };
}

function auth(req, res, next) {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
    if (!match) throw new Error('Missing token.');
    const { id } = jwt.verify(match[1], JWT_SECRET);
    req.user = db.users.find((user) => user.id === id);
    if (!req.user) throw new Error('Account not found.');
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

function privateUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    age: user.age,
    gender: user.gender,
    role: user.role || 'traveller',
  };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/signup', limit(10, 60 * 60 * 1000), async (req, res) => {
  const { name, email, password, age, gender } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || !email || !password || !age || !gender) {
    return res.status(400).json({ error: 'Please fill all required fields.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) return res.status(400).json({ error: 'Enter a valid email.' });
  if (String(password).length < 8 || String(password).length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (!Number.isInteger(Number(age)) || Number(age) < 18 || Number(age) > 120) return res.status(400).json({ error: 'You must be 18 or older to use Meetaro.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  if (db.users.some((user) => user.email === normalizedEmail)) return res.status(409).json({ error: 'Email already registered.' });
  if (db.pendingSignups.some((pending) => pending.email === normalizedEmail)) {
    return res.status(202).json({ message: 'Registration is already pending. Use the code in your inbox or request a new one.' });
  }
  const displayName = name.trim().slice(0, 40);
  const code = createVerificationCode();
  await sendVerificationEmail(normalizedEmail, displayName, code);
  db.pendingSignups.push({
    id: newId(),
    name: displayName,
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(String(password), 10),
    age: Number(age),
    gender: String(gender).slice(0, 30),
    verificationCodeHash: verificationCodeHash(normalizedEmail, code),
    verificationExpiresAt: Date.now() + verificationTtlMs,
    verificationAttempts: 0,
    lastVerificationSentAt: Date.now(),
  });
  save();
  res.status(202).json({ message: 'Check your email for a verification code.' });
});

app.post('/api/signup/resend', limit(5, 60 * 60 * 1000), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pending = db.pendingSignups.find((candidate) => candidate.email === email);
  if (!pending) return res.status(404).json({ error: 'No pending email verification was found. Start registration again.' });
  if (Date.now() >= pending.verificationExpiresAt) {
    db.pendingSignups = db.pendingSignups.filter((candidate) => candidate !== pending);
    save();
    return res.status(410).json({ error: 'That verification expired. Please start registration again.' });
  }
  const waitMs = verificationResendDelayMs - (Date.now() - pending.lastVerificationSentAt);
  if (waitMs > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.` });
  const code = createVerificationCode();
  await sendVerificationEmail(pending.email, pending.name, code);
  pending.verificationCodeHash = verificationCodeHash(pending.email, code);
  pending.verificationExpiresAt = Date.now() + verificationTtlMs;
  pending.verificationAttempts = 0;
  pending.lastVerificationSentAt = Date.now();
  save();
  res.json({ message: 'A new verification code has been sent.' });
});

app.post('/api/signup/verify', limit(10, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the email address and six-digit verification code.' });
  }
  const pending = db.pendingSignups.find((candidate) => candidate.email === email);
  if (!pending) return res.status(400).json({ error: 'No pending email verification was found. Start registration again.' });
  if (Date.now() >= pending.verificationExpiresAt) {
    db.pendingSignups = db.pendingSignups.filter((candidate) => candidate !== pending);
    save();
    return res.status(410).json({ error: 'That verification code expired. Please start registration again.' });
  }
  if (pending.verificationAttempts >= verificationMaxAttempts) {
    return res.status(429).json({ error: 'Too many incorrect codes. Request a new code to continue.' });
  }
  const expectedHash = Buffer.from(pending.verificationCodeHash, 'hex');
  const submittedHash = Buffer.from(verificationCodeHash(email, code), 'hex');
  if (!crypto.timingSafeEqual(expectedHash, submittedHash)) {
    pending.verificationAttempts += 1;
    save();
    return res.status(pending.verificationAttempts >= verificationMaxAttempts ? 429 : 400).json({
      error: pending.verificationAttempts >= verificationMaxAttempts
        ? 'Too many incorrect codes. Request a new code to continue.'
        : 'That verification code is incorrect.',
    });
  }
  if (db.users.some((user) => user.email === email)) {
    db.pendingSignups = db.pendingSignups.filter((candidate) => candidate !== pending);
    save();
    return res.status(409).json({ error: 'Email already registered.' });
  }

  await sendWelcomeEmail(email, pending.name);
  const user = {
    id: newId(),
    name: pending.name,
    email: pending.email,
    passwordHash: pending.passwordHash,
    age: pending.age,
    gender: pending.gender,
    role: 'traveller',
    emailVerified: true,
  };
  db.users.push(user);
  db.pendingSignups = db.pendingSignups.filter((candidate) => candidate !== pending);
  save();
  res.status(201).json({ token: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' }), user: privateUser(user) });
});

app.post('/api/login', limit(10, 15 * 60 * 1000), async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((candidate) => candidate.email === String(email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) {
    return res.status(400).json({ error: 'Wrong email or password.' });
  }
  res.json({ token: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' }), user: privateUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(privateUser(req.user)));

require('./travel').registerTravelRoutes({ app, db, save, newId, auth, limit, sendHostApplicationNotification });

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  console.error('Request failed:', error.message);
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
    return res.status(error.status).json({ error: error.message });
  }
  res.status(500).json({ error: 'The request could not be completed.' });
});

app.listen(PORT, () => console.log('Meetaro travel is running at http://localhost:' + PORT));
