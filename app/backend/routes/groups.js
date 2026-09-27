const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');

function isGroupAdmin(user, groupId) {
  return user.role === 'admin' || (user.group_role === 'group_admin' && user.group_id === parseInt(groupId));
}

// GET /api/groups – global admin: alle Gruppen; group_admin: nur eigene Gruppe
router.get('/', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.group_role !== 'group_admin')
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const groupFilter = req.user.role === 'admin' ? '' : 'WHERE g.id = $1';
  const params = req.user.role === 'admin' ? [] : [req.user.group_id];

  const { rows } = await pool.query(`
    SELECT g.id, g.name, g.slug, g.created_at,
      COUNT(DISTINCT gm.user_id)::int as member_count,
      COUNT(DISTINCT r.id)::int as recipe_count
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN recipes r ON r.group_id = g.id
    ${groupFilter}
    GROUP BY g.id ORDER BY g.name
  `, params);
  res.json(rows);
});

const DEFAULT_CATEGORIES = [
  { name: 'Frühstück',       slug: 'fruehstueck', icon: '🥐', color: '#f59e0b' },
  { name: 'Suppen',          slug: 'suppen',      icon: '🍲', color: '#ef4444' },
  { name: 'Salate',          slug: 'salate',      icon: '🥗', color: '#22c55e' },
  { name: 'Hauptgericht',    slug: 'hauptgericht',icon: '🍽️', color: '#7c6af7' },
  { name: 'Pasta',           slug: 'pasta',       icon: '🍝', color: '#f97316' },
  { name: 'Grillen',         slug: 'grillen',     icon: '🔥', color: '#dc2626' },
  { name: 'Backen',          slug: 'backen',      icon: '🥖', color: '#a16207' },
  { name: 'Kuchen & Dessert',slug: 'dessert',     icon: '🎂', color: '#ec4899' },
  { name: 'Snacks',          slug: 'snacks',      icon: '🧆', color: '#06b6d4' },
  { name: 'Getränke',        slug: 'getraenke',   icon: '🥤', color: '#8b5cf6' },
  { name: 'Vegetarisch',     slug: 'vegetarisch', icon: '🌿', color: '#16a34a' },
  { name: 'Vegan',           slug: 'vegan',       icon: '🌱', color: '#15803d' },
];

// POST /api/groups – Gruppe erstellen (nur globaler Admin)
router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9äöüß]/g, '-').replace(/-+/g, '-') + '-' + Date.now();
  try {
    const { rows } = await pool.query(
      'INSERT INTO groups (name, slug) VALUES ($1, $2) RETURNING *',
      [name.trim(), slug]
    );
    const group = rows[0];
    for (const cat of DEFAULT_CATEGORIES) {
      const catSlug = cat.slug + '-g' + group.id;
      await pool.query(
        'INSERT INTO categories (name, slug, icon, color, group_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING',
        [cat.name, catSlug, cat.icon, cat.color, group.id]
      );
    }
    res.json(group);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/groups/:id – Gruppe umbenennen (nur globaler Admin)
router.patch('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  const { rows } = await pool.query(
    'UPDATE groups SET name = $1 WHERE id = $2 RETURNING *',
    [name.trim(), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(rows[0]);
});

// DELETE /api/groups/:id – Gruppe löschen (nur globaler Admin)
router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// GET /api/groups/:id/members – Mitglieder auflisten
router.get('/:id/members', authMiddleware, async (req, res) => {
  if (!isGroupAdmin(req.user, req.params.id))
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.name, u.email, u.role as global_role, u.last_login, gm.group_role
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = $1
    ORDER BY gm.group_role, u.username
  `, [req.params.id]);
  res.json(rows);
});

// GET /api/groups/:id/available-users – Benutzer, die noch nicht Mitglied sind
router.get('/:id/available-users', authMiddleware, async (req, res) => {
  if (!isGroupAdmin(req.user, req.params.id))
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.email
    FROM users u
    WHERE u.id NOT IN (SELECT user_id FROM group_members WHERE group_id = $1)
    ORDER BY u.username
  `, [req.params.id]);
  res.json(rows);
});

// POST /api/groups/:id/members – Mitglied hinzufügen/Rolle setzen
router.post('/:id/members', authMiddleware, async (req, res) => {
  if (!isGroupAdmin(req.user, req.params.id))
    return res.status(403).json({ error: 'Keine Berechtigung' });

  const { user_id, group_role } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id erforderlich' });
  if (!['group_admin', 'readwrite', 'readonly'].includes(group_role))
    return res.status(400).json({ error: 'Ungültige Rolle' });
  // Nur globaler Admin kann group_admin ernennen
  if (group_role === 'group_admin' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Nur globale Admins können Gruppenadmins ernennen' });

  try {
    // Ein User gehört immer nur einer Gruppe — aus anderen Gruppen entfernen
    await pool.query('DELETE FROM group_members WHERE user_id = $1 AND group_id != $2', [user_id, req.params.id]);
    await pool.query(
      'INSERT INTO group_members (group_id, user_id, group_role) VALUES ($1, $2, $3) ON CONFLICT (group_id, user_id) DO UPDATE SET group_role = EXCLUDED.group_role',
      [req.params.id, user_id, group_role]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/groups/:id/members/:userId – Mitglied entfernen
router.delete('/:id/members/:userId', authMiddleware, async (req, res) => {
  if (!isGroupAdmin(req.user, req.params.id))
    return res.status(403).json({ error: 'Keine Berechtigung' });

  if (parseInt(req.params.userId) === req.user.id && req.user.role !== 'admin')
    return res.status(400).json({ error: 'Sich selbst nicht aus der Gruppe entfernen' });

  await pool.query(
    'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
    [req.params.id, req.params.userId]
  );
  res.json({ success: true });
});

module.exports = router;
