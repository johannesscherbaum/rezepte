const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production-please';

async function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Fetch fresh group membership from DB so changes take effect without re-login
    const { rows } = await pool.query(
      `SELECT gm.group_id, gm.group_role, g.name as group_name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY gm.group_id LIMIT 1`,
      [req.user.id]
    );
    if (rows[0]) {
      req.user.group_id = rows[0].group_id;
      req.user.group_role = rows[0].group_role;
      req.user.group_name = rows[0].group_name;
    } else {
      req.user.group_id = null;
      req.user.group_role = null;
      req.user.group_name = null;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Session abgelaufen' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Keine Berechtigung' });
    next();
  };
}

// Passes for global admin OR for group_admin within their group
function requireAdminOrGroupAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (req.user.role === 'admin' || req.user.group_role === 'group_admin') return next();
  return res.status(403).json({ error: 'Keine Berechtigung' });
}

// Passes for global admin, group_admin, or readwrite group members
function requireWriteAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (req.user.role === 'admin') return next();
  if (['group_admin', 'readwrite'].includes(req.user.group_role)) return next();
  return res.status(403).json({ error: 'Keine Berechtigung' });
}

async function optionalAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query(
        `SELECT gm.group_id, gm.group_role, g.name as group_name
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.user_id = $1
         ORDER BY gm.group_id LIMIT 1`,
        [req.user.id]
      );
      if (rows[0]) {
        req.user.group_id = rows[0].group_id;
        req.user.group_role = rows[0].group_role;
        req.user.group_name = rows[0].group_name;
      }
    } catch {}
  }
  next();
}

module.exports = { authMiddleware, requireRole, requireAdminOrGroupAdmin, requireWriteAccess, optionalAuth, JWT_SECRET };
