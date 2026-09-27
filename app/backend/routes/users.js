const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { authMiddleware, requireRole, JWT_SECRET } = require('../middleware/auth');
const { sendWelcomeMail } = require('../services/mailer');

const COOKIE_OPTS = {
  httpOnly: true, sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: process.env.COOKIE_SECURE === 'true'
};

// ── Eigene Routen ZUERST (vor /:id) ──────────────────────────────────────────

// Eigenes Profil aktualisieren
router.patch('/me/profile', authMiddleware, async (req, res) => {
  const { username, email } = req.body;
  if (!username?.trim() || !email?.trim())
    return res.status(400).json({ error: 'Benutzername und E-Mail erforderlich' });
  try {
    const { rows } = await pool.query(
      'UPDATE users SET username = $1, email = $2 WHERE id = $3 RETURNING id, username, email, role, totp_enabled, created_at, last_login',
      [username.trim(), email.trim(), req.user.id]
    );
    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, email: user.email },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('token', token, COOKIE_OPTS);
    res.json({ user });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Benutzername oder E-Mail bereits vergeben' });
    throw e;
  }
});

// Eigenes Farbschema setzen
const ALLOWED_THEMES = ['sage', 'terracotta', 'ocean', 'plum', 'dark', 'rosa', 'lavendel', 'pfirsich'];
router.patch('/me/theme', authMiddleware, async (req, res) => {
  const { theme } = req.body;
  if (!ALLOWED_THEMES.includes(theme)) {
    return res.status(400).json({ error: 'Ungültiges Farbschema' });
  }
  await pool.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.user.id]);
  res.json({ theme });
});

// Eigenes Passwort ändern
router.post('/me/password', authMiddleware, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });
  if (new_password.length < 8)
    return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const valid = await bcrypt.compare(old_password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
  const hash = await bcrypt.hash(new_password, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ success: true });
});

// ── Admin-Routen ──────────────────────────────────────────────────────────────

// Alle User auflisten
router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.name, u.email, u.role, u.totp_enabled, u.can_evernote, u.created_at, u.last_login,
           gm.group_id, gm.group_role, g.name as group_name
    FROM users u
    LEFT JOIN group_members gm ON gm.user_id = u.id
    LEFT JOIN groups g ON g.id = gm.group_id
    ORDER BY u.created_at
  `);
  res.json(rows);
});

// User erstellen
router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const { username, email, password, role, group_id, group_role } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Alle Felder erforderlich' });
  const effectiveRole = role === 'admin' ? 'admin' : 'member';
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role',
      [username, email, hash, effectiveRole]
    );
    const newUser = rows[0];
    let groupName = null;
    if (group_id && group_role && ['group_admin','readwrite','readonly'].includes(group_role)) {
      await pool.query(
        'INSERT INTO group_members (group_id, user_id, group_role) VALUES ($1, $2, $3) ON CONFLICT (group_id, user_id) DO UPDATE SET group_role = EXCLUDED.group_role',
        [group_id, newUser.id, group_role]
      );
      const gRow = await pool.query('SELECT name FROM groups WHERE id = $1', [group_id]);
      groupName = gRow.rows[0]?.name || null;
    }
    res.json(newUser);
    // Mail asynchron senden – Fehler nicht an den Client weitergeben
    sendWelcomeMail({ to: email, username, password, groupName, groupRole: group_role }).catch(function(err) {
      console.error('[mailer] Fehler beim Senden:', err.message);
    });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Benutzername oder E-Mail bereits vergeben' });
    throw e;
  }
});

// Benutzer bearbeiten
router.patch('/:id', authMiddleware, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const isGroupAdmin = req.user.group_role === 'group_admin';
  if (!isAdmin && !isGroupAdmin)
    return res.status(403).json({ error: 'Keine Berechtigung' });

  if (!isAdmin) {
    // Gruppenadmin: darf nur name ändern, aber nur für Mitglieder seiner Gruppe
    const { rows } = await pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [req.user.group_id, req.params.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Benutzer nicht in Ihrer Gruppe' });
    const { name } = req.body;
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name || null, req.params.id]);
    return res.json({ success: true });
  }

  // Globaler Admin: alles änderbar
  const { role, password, can_evernote, name, username, email, group_id, group_role } = req.body;
  if (role && !['admin','member'].includes(role))
    return res.status(400).json({ error: 'Ungültige Rolle' });
  const updates = [];
  const vals = [];
  let idx = 1;
  if (name !== undefined)         { updates.push(`name=$${idx++}`);          vals.push(name || null); }
  if (username?.trim())            { updates.push(`username=$${idx++}`);       vals.push(username.trim()); }
  if (email?.trim())               { updates.push(`email=$${idx++}`);          vals.push(email.trim()); }
  if (role)                        { updates.push(`role=$${idx++}`);           vals.push(role); }
  if (can_evernote !== undefined)  { updates.push(`can_evernote=$${idx++}`);   vals.push(can_evernote); }
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    updates.push(`password_hash=$${idx++}`);
    vals.push(hash);
  }
  if (updates.length) {
    try {
      await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${idx}`, [...vals, req.params.id]);
    } catch(e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Benutzername oder E-Mail bereits vergeben' });
      throw e;
    }
  }
  // Gruppenzugehörigkeit aktualisieren
  if ('group_id' in req.body) {
    await pool.query('DELETE FROM group_members WHERE user_id = $1', [req.params.id]);
    if (group_id && group_role && ['group_admin','readwrite','readonly'].includes(group_role)) {
      await pool.query(
        'INSERT INTO group_members (group_id, user_id, group_role) VALUES ($1, $2, $3)',
        [group_id, req.params.id, group_role]
      );
    }
  }
  res.json({ success: true });
});

// User löschen
router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
