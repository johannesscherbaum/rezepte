const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production'
};

// Login
router.post('/login', async (req, res) => {
  const { username, password, totp_code } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

  // 2FA check
  if (user.totp_enabled) {
    if (!totp_code) return res.status(200).json({ requires_2fa: true });
    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: totp_code,
      window: 1
    });
    if (!verified) return res.status(401).json({ error: 'Ungültiger 2FA-Code' });
  }

  await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const gm = await pool.query(
    `SELECT gm.group_id, gm.group_role, g.name as group_name
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = $1 ORDER BY gm.group_id LIMIT 1`,
    [user.id]
  );
  const gmRow = gm.rows[0];

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ success: true, user: {
    id: user.id, username: user.username, name: user.name || null, role: user.role, email: user.email, theme: user.theme || 'sage',
    group_id: gmRow?.group_id || null,
    group_role: gmRow?.group_role || null,
    group_name: gmRow?.group_name || null
  }});
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Me – immer frisch aus DB holen
router.get('/me', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, name, email, role, totp_enabled, can_evernote, theme, created_at, last_login FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User nicht gefunden' });
  res.json({ user: {
    ...rows[0],
    group_id: req.user.group_id || null,
    group_role: req.user.group_role || null,
    group_name: req.user.group_name || null
  }});
});

// Setup 2FA
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  const secret = speakeasy.generateSecret({ name: `Rezepte (${req.user.username})`, length: 20 });
  await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret.base32, req.user.id]);
  const qr = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qr });
});

// Confirm 2FA
router.post('/2fa/confirm', authMiddleware, async (req, res) => {
  const { rows } = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
  const verified = speakeasy.totp.verify({
    secret: rows[0].totp_secret,
    encoding: 'base32',
    token: req.body.code,
    window: 1
  });
  if (!verified) return res.status(400).json({ error: 'Code ungültig' });
  await pool.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [req.user.id]);
  res.json({ success: true });
});

// Disable 2FA
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  await pool.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [req.user.id]);
  res.json({ success: true });
});

module.exports = router;
