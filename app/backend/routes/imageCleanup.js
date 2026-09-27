const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');

const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';

async function getReferencedFilenames() {
  const [recipes, recipeImages, stepImages, evernoteImages] = await Promise.all([
    pool.query('SELECT image_path FROM recipes WHERE image_path IS NOT NULL'),
    pool.query('SELECT image_path FROM recipe_images WHERE image_path IS NOT NULL'),
    pool.query('SELECT image_path FROM step_images WHERE image_path IS NOT NULL'),
    pool.query('SELECT image_path FROM evernote_note_images WHERE image_path IS NOT NULL')
  ]);
  const set = new Set();
  [...recipes.rows, ...recipeImages.rows, ...stepImages.rows, ...evernoteImages.rows].forEach(function (r) {
    if (r.image_path) set.add(path.basename(r.image_path));
  });
  return set;
}

// GET /api/admin/orphaned-images - listet Dateien in IMAGE_DIR, die in keiner Tabelle mehr referenziert werden
router.get('/orphaned-images', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const referenced = await getReferencedFilenames();
    const files = fs.existsSync(IMAGE_DIR) ? fs.readdirSync(IMAGE_DIR) : [];
    const orphaned = [];
    let totalBytes = 0;
    for (const file of files) {
      if (referenced.has(file)) continue;
      const fp = path.join(IMAGE_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) continue;
        orphaned.push({ filename: file, size: stat.size, modified: stat.mtime });
        totalBytes += stat.size;
      } catch (e) { /* nicht lesbare Datei ignorieren */ }
    }
    orphaned.sort(function (a, b) { return new Date(b.modified) - new Date(a.modified); });
    res.json({ orphaned: orphaned, count: orphaned.length, totalBytes: totalBytes });
  } catch (e) {
    console.error('GET /admin/orphaned-images Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Scannen der Bilder' });
  }
});

// DELETE /api/admin/orphaned-images  Body: { filenames: [...] }
router.delete('/orphaned-images', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || !filenames.length) {
      return res.status(400).json({ error: 'filenames Array erforderlich' });
    }
    // Sicherheitsnetz: nochmal gegen die DB prüfen, damit nie versehentlich
    // ein doch noch referenziertes Bild gelöscht wird (z.B. bei Race Conditions).
    const referenced = await getReferencedFilenames();
    let deleted = 0, skipped = 0;
    for (const rawName of filenames) {
      const name = path.basename(rawName); // verhindert Path Traversal
      if (referenced.has(name)) { skipped++; continue; }
      const fp = path.join(IMAGE_DIR, name);
      try {
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted++; }
      } catch (e) {
        console.error('Löschen fehlgeschlagen für', name, e);
      }
    }
    res.json({ deleted: deleted, skipped: skipped });
  } catch (e) {
    console.error('DELETE /admin/orphaned-images Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

module.exports = router;
