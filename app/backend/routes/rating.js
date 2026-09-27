const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authMiddleware, requireRole, requireWriteAccess } = require('../middleware/auth');

// PUT /api/recipes/:id/rating   Body: { rating: 1-5 oder null zum Entfernen }
// Gemeinsame, geteilte Bewertung pro Rezept - jeder eingeloggte Nutzer darf sie setzen.
router.put('/:id/rating', authMiddleware, async (req, res) => {
  try {
    const { rating } = req.body;
    if (rating !== null && rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 1 und 5 liegen' });
    }
    const { rows } = await pool.query(
      'UPDATE recipes SET rating = $1 WHERE id = $2 RETURNING id, rating',
      [rating === undefined ? null : rating, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rezept nicht gefunden' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /recipes/:id/rating Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Speichern der Bewertung' });
  }
});

// PUT /api/recipes/:id/to-try   Body: { to_try: true/false }
// Gemeinsames "zum Probieren"-Flag pro Rezept.
router.put('/:id/to-try', authMiddleware, async (req, res) => {
  try {
    const { to_try } = req.body;
    const { rows } = await pool.query(
      'UPDATE recipes SET to_try = $1 WHERE id = $2 RETURNING id, to_try',
      [!!to_try, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rezept nicht gefunden' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /recipes/:id/to-try Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// PUT /api/recipes/:id/set-image-path   Body: { image_path }
// Setzt einen bereits lokal vorhandenen Bildpfad direkt (z.B. aus dem ENEX-Import),
// ohne erneuten Download wie bei /fetch-image.
router.put('/:id/set-image-path', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    const { image_path } = req.body;
    if (!image_path || !image_path.startsWith('/images/')) {
      return res.status(400).json({ error: 'Ungültiger Bildpfad' });
    }
    const { rows } = await pool.query(
      'UPDATE recipes SET image_path = $1 WHERE id = $2 RETURNING id, image_path',
      [image_path, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rezept nicht gefunden' });
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /recipes/:id/set-image-path Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Setzen des Bildes' });
  }
});

// POST /api/recipes/:id/gallery-from-paths   Body: { image_paths: [...] }
// Trägt bereits lokal vorhandene Bilder (z.B. aus dem ENEX-Import) direkt in die
// Galerie ein, ohne erneuten Upload. Erstes Bild wird wie beim normalen Galerie-
// Upload automatisch als Titelbild gesetzt, falls die Galerie noch leer ist.
router.post('/:id/gallery-from-paths', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    const { image_paths } = req.body;
    if (!Array.isArray(image_paths) || !image_paths.length) {
      return res.status(400).json({ error: 'image_paths Array erforderlich' });
    }
    const valid = image_paths.filter(function (p) { return typeof p === 'string' && p.startsWith('/images/'); });
    if (!valid.length) return res.status(400).json({ error: 'Keine gültigen Bildpfade' });

    const { rows: existing } = await pool.query('SELECT COUNT(*) as c FROM recipe_images WHERE recipe_id = $1', [req.params.id]);
    let sortOrder = parseInt(existing[0].c);
    const inserted = [];

    for (const p of valid) {
      const { rows } = await pool.query(
        'INSERT INTO recipe_images (recipe_id, image_path, caption, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, p, null, sortOrder]
      );
      if (sortOrder === 0) {
        await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [p, req.params.id]);
      }
      inserted.push(rows[0]);
      sortOrder++;
    }
    res.json({ added: inserted.length, images: inserted });
  } catch (e) {
    console.error('POST /recipes/:id/gallery-from-paths Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Hinzufügen zur Galerie' });
  }
});

module.exports = router;

