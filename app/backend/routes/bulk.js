const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { authMiddleware, requireRole, requireWriteAccess } = require('../middleware/auth');

const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';

function parseIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const nums = ids.map(function (i) { return parseInt(i, 10); }).filter(function (n) { return Number.isInteger(n); });
  return nums.length ? nums : null;
}

// PATCH /api/recipes/bulk   Body: { ids: [...], category_id?, rating?, to_try? }
// Setzt Kategorie, Bewertung und/oder "zum Probieren"-Flag für mehrere Rezepte auf einmal.
router.patch('/bulk', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    const ids = parseIds(req.body.ids);
    if (!ids) return res.status(400).json({ error: 'ids Array erforderlich' });

    const hasCategory = req.body.category_id !== undefined;
    const hasRating = req.body.rating !== undefined;
    const hasToTry = req.body.to_try !== undefined;
    if (!hasCategory && !hasRating && !hasToTry) {
      return res.status(400).json({ error: 'category_id, rating oder to_try erforderlich' });
    }
    if (hasRating && req.body.rating !== null &&
        (!Number.isInteger(req.body.rating) || req.body.rating < 1 || req.body.rating > 5)) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 1 und 5 liegen' });
    }

    const sets = [];
    const params = [];
    let i = 1;
    if (hasCategory) { sets.push('category_id = $' + (i++)); params.push(req.body.category_id || null); }
    if (hasRating) { sets.push('rating = $' + (i++)); params.push(req.body.rating); }
    if (hasToTry) { sets.push('to_try = $' + (i++)); params.push(!!req.body.to_try); }
    params.push(ids);

    const { rowCount } = await pool.query(
      `UPDATE recipes SET ${sets.join(', ')} WHERE id = ANY($${i}::int[])`,
      params
    );
    res.json({ updated: rowCount });
  } catch (e) {
    console.error('PATCH /recipes/bulk Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Massen-Update' });
  }
});

// DELETE /api/recipes/bulk   Body: { ids: [...] }
router.delete('/bulk', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    const ids = parseIds(req.body.ids);
    if (!ids) return res.status(400).json({ error: 'ids Array erforderlich' });

    const { rows } = await pool.query('SELECT id, group_id, image_path FROM recipes WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [ids]);

    const isAdmin = req.user.role === 'admin';
    const ownIds = [];
    const sharedIds = [];

    rows.forEach(function(r) {
      if (isAdmin || r.group_id === req.user.group_id) {
        ownIds.push(r.id);
      } else {
        sharedIds.push(r.id);
      }
    });

    let deleted = 0, unshared = 0;
    if (ownIds.length) {
      const res2 = await pool.query('UPDATE recipes SET deleted_at = NOW() WHERE id = ANY($1::int[])', [ownIds]);
      deleted = res2.rowCount;
    }
    if (sharedIds.length && req.user.group_id) {
      const res3 = await pool.query(
        'DELETE FROM recipe_shares WHERE recipe_id = ANY($1::int[]) AND target_group_id = $2',
        [sharedIds, req.user.group_id]
      );
      unshared = res3.rowCount;
    }

    res.json({ deleted, unshared });
  } catch (e) {
    console.error('DELETE /recipes/bulk Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Massen-Löschen' });
  }
});

module.exports = router;
