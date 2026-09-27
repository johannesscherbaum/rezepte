const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { authMiddleware, requireRole, requireWriteAccess, optionalAuth } = require('../middleware/auth');
const { fetchPage, extractTextFromHtml, downloadImage, extractRecipeWithClaude } = require('../services/crawler');

const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt'));
  }
});

// Helper: upsert tag
async function upsertTag(client, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9äöüß]/g, '-').replace(/-+/g, '-');
  const { rows } = await client.query(
    'INSERT INTO tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [name.toLowerCase(), slug]
  );
  return rows[0].id;
}

// Helper: save recipe with all relations
async function saveRecipe(client, data, userId, recipeId = null) {
  const { title, description, servings, prep_time, cook_time, difficulty, category_id,
          source_url, image_path, notes, ingredients, steps, tags, is_public, group_id } = data;

  let rid = recipeId;
  if (rid) {
    await client.query(`
      UPDATE recipes SET title=$1, description=$2, servings=$3, prep_time=$4, cook_time=$5,
        difficulty=$6, category_id=$7, source_url=$8, notes=$9, is_public=$10, updated_at=NOW()
        ${image_path ? ', image_path=$11' : ''}
      WHERE id=${rid}
    `, image_path
      ? [title, description, servings, prep_time, cook_time, difficulty, category_id, source_url, notes, is_public ?? false, image_path]
      : [title, description, servings, prep_time, cook_time, difficulty, category_id, source_url, notes, is_public ?? false]
    );
    await client.query('DELETE FROM ingredients WHERE recipe_id = $1', [rid]);
    await client.query('DELETE FROM steps WHERE recipe_id = $1', [rid]);
    await client.query('DELETE FROM recipe_tags WHERE recipe_id = $1', [rid]);
  } else {
    const { rows } = await client.query(`
      INSERT INTO recipes (title, description, servings, prep_time, cook_time, difficulty,
        category_id, source_url, image_path, notes, created_by, is_public, group_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
    `, [title, description, servings || 4, prep_time, cook_time, difficulty || 'mittel',
        category_id, source_url, image_path, notes, userId, is_public ?? false, group_id || null]);
    rid = rows[0].id;
  }

  // Ingredients
  if (ingredients?.length) {
    for (let i = 0; i < ingredients.length; i++) {
      const ing = ingredients[i];
      await client.query(
        'INSERT INTO ingredients (recipe_id, amount, unit, name, group_name, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [rid, ing.amount || null, ing.unit || null, ing.name, ing.group || ing.group_name || null, i]
      );
    }
  }

  // Steps
  if (steps?.length) {
    for (let i = 0; i < steps.length; i++) {
      const desc = typeof steps[i] === 'string' ? steps[i] : steps[i].description;
      await client.query(
        'INSERT INTO steps (recipe_id, step_number, description) VALUES ($1,$2,$3)',
        [rid, i + 1, desc]
      );
    }
  }

  // Tags
  if (tags?.length) {
    for (const tag of tags) {
      if (!tag?.trim()) continue;
      const tagId = await upsertTag(client, tag.trim());
      await client.query('INSERT INTO recipe_tags (recipe_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rid, tagId]);
      await client.query('UPDATE tags SET usage_count = (SELECT COUNT(*) FROM recipe_tags WHERE tag_id = $1) WHERE id = $1', [tagId]);
    }
  }

  // Update category count
  if (category_id) {
    await client.query('UPDATE categories SET recipe_count = (SELECT COUNT(*) FROM recipes WHERE category_id = $1) WHERE id = $1', [category_id]);
  }

  return rid;
}

// GET all recipes
router.get('/', optionalAuth, async (req, res) => {
  const { category, tag, search, to_try, time_max, time_min, limit = 50, offset = 0, terms: rawTerms, terms_op, exclude: rawExclude, sort = 'alpha' } = req.query;
  const isAuthed = !!req.user;

  let where = isAuthed ? ['r.deleted_at IS NULL'] : ['r.is_public = TRUE', 'r.deleted_at IS NULL'];
  let params = [];
  let i = 1;

  // Gruppen-Filter
  const sharedOnly = req.query.shared === 'only';
  let groupParamIdx = null;
  if (isAuthed && req.user.role !== 'admin') {
    if (req.user.group_id) {
      params.push(req.user.group_id);
      groupParamIdx = i++;
      if (sharedOnly) {
        // Nur fremde freigegebene Rezepte (nicht aus der eigenen Gruppe)
        where.push(`r.id IN (SELECT recipe_id FROM recipe_shares WHERE target_group_id = $${groupParamIdx})`);
      } else {
        // Standard: nur eigene Gruppe, keine freigegebenen
        where.push(`r.group_id = $${groupParamIdx}`);
      }
    } else {
      where.push('FALSE');
    }
  }

  if (category) {
    // Inkl. Subkategorien
    where.push(`(r.category_id = $${i} OR r.category_id IN (SELECT id FROM categories WHERE parent_id = $${i}))`);
    params.push(category); i++;
  }
  if (tag) {
    where.push(`EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.recipe_id = r.id AND t.slug = $${i++})`);
    params.push(tag);
  }
  if (search) {
    where.push(`(
      r.title ILIKE $${i}
      OR r.description ILIKE $${i}
      OR EXISTS (SELECT 1 FROM ingredients ing WHERE ing.recipe_id = r.id AND ing.name ILIKE $${i})
      OR EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.recipe_id = r.id AND t.name ILIKE $${i})
      OR EXISTS (SELECT 1 FROM categories c WHERE c.id = r.category_id AND c.name ILIKE $${i})
    )`);
    params.push(`%${search}%`); i++;
  }
  if (rawTerms) {
    try {
      const terms = JSON.parse(rawTerms);
      const op = terms_op === 'OR' ? 'OR' : 'AND';
      const termClauses = terms.map(function(term) {
        params.push(`%${term}%`);
        const n = i++;
        return `(r.title ILIKE $${n} OR r.description ILIKE $${n} OR EXISTS (SELECT 1 FROM ingredients ing WHERE ing.recipe_id = r.id AND ing.name ILIKE $${n}) OR EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.recipe_id = r.id AND t.name ILIKE $${n}) OR EXISTS (SELECT 1 FROM categories c WHERE c.id = r.category_id AND c.name ILIKE $${n}))`;
      });
      if (termClauses.length) where.push(`(${termClauses.join(' ' + op + ' ')})`);
      const excludes = rawExclude ? JSON.parse(rawExclude) : [];
      excludes.forEach(function(term) {
        params.push(`%${term}%`);
        const n = i++;
        where.push(`NOT (r.title ILIKE $${n} OR EXISTS (SELECT 1 FROM ingredients ing WHERE ing.recipe_id = r.id AND ing.name ILIKE $${n}) OR EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.recipe_id = r.id AND t.name ILIKE $${n}))`);
      });
    } catch(e) { /* ungültiges JSON ignorieren */ }
  }
  if (time_max) {
    // Gesamtzeit (Vorbereitung + Kochzeit) bis maximal X Minuten
    where.push(`(COALESCE(r.prep_time,0) + COALESCE(r.cook_time,0)) <= $${i++}`);
    params.push(parseInt(time_max));
  }
  if (time_min) {
    // Gesamtzeit ab mindestens X Minuten (z.B. für "über 60 Min")
    where.push(`(COALESCE(r.prep_time,0) + COALESCE(r.cook_time,0)) >= $${i++}`);
    params.push(parseInt(time_min));
  }
  if (to_try === 'true') {
    // Schnellfilter: nur "zum Probieren"-markierte Rezepte
    where.push('r.to_try = TRUE');
  } else {
    // Standardverhalten: "zum Probieren"-markierte Rezepte aus der normalen Ansicht ausblenden
    where.push('(r.to_try IS NOT TRUE)');
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // shared_from_group_name: Quellgruppe anzeigen wenn das Rezept aus einer anderen Gruppe geteilt wurde
  const sharedExpr = groupParamIdx !== null
    ? `CASE WHEN r.group_id != $${groupParamIdx} THEN g.name ELSE NULL END`
    : 'NULL::text';

  const { rows } = await pool.query(`
    SELECT r.id, r.title, r.description, r.servings, r.prep_time, r.cook_time,
           r.difficulty, r.image_path, r.image_url, r.is_public, r.rating, r.to_try,
           r.created_at, r.updated_at,
           c.name as category_name, c.icon as category_icon, c.slug as category_slug,
           u.username as author, g.name as group_name,
           ${sharedExpr} as shared_from_group_name
    FROM recipes r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN groups g ON g.id = r.group_id
    ${whereClause}
    ORDER BY ${sort === 'recent' ? 'r.created_at DESC' : sort === 'category' ? 'c.name ASC NULLS LAST, r.title ASC' : 'r.title ASC'}
    LIMIT $${i++} OFFSET $${i++}
  `, [...params, Number(limit), Number(offset)]);

  res.json(rows);
});

// POST crawl URL – muss VOR /:id stehen
router.post('/crawl', authMiddleware, requireWriteAccess, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL erforderlich' });
  try {
    const html = await fetchPage(url);
    const { text, imageUrl, title } = extractTextFromHtml(html, url);
    const { rows: catRows } = await pool.query('SELECT name FROM categories ORDER BY name');
    const recipe = await extractRecipeWithClaude(text, title, url, catRows.map(function(r) { return r.name; }));
    recipe.source_url = url;
    recipe.image_url = imageUrl;
    if (recipe.category) {
      const { rows } = await pool.query('SELECT id FROM categories WHERE name ILIKE $1', [recipe.category]);
      recipe.category_id = rows[0]?.id || null;
    }
    res.json({ recipe, image_url: imageUrl });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST crawl-text – Freitext (z.B. Evernote) via Claude zu Rezept – muss VOR /:id stehen
router.post('/crawl-text', authMiddleware, requireWriteAccess, async (req, res) => {
  const { text, title, source } = req.body;
  if (!text || text.trim().length < 20) return res.status(400).json({ error: 'Zu wenig Text' });
  try {
    const { rows: catRows2 } = await pool.query('SELECT name FROM categories ORDER BY name');
    const recipe = await extractRecipeWithClaude(text.slice(0, 6000), title || '', source || '', catRows2.map(function(r) { return r.name; }));
    if (recipe.category) {
      const { rows } = await pool.query('SELECT id FROM categories WHERE name ILIKE $1', [recipe.category]);
      recipe.category_id = rows[0]?.id || null;
    }
    res.json({ recipe });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single recipe
router.get('/:id', optionalAuth, async (req, res) => {
  const isAuthed = !!req.user;
  const { rows } = await pool.query(`
    SELECT r.*, c.name as category_name, c.icon as category_icon, c.slug as category_slug,
           u.username as author, g.name as group_name
    FROM recipes r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN groups g ON g.id = r.group_id
    WHERE r.id = $1 AND r.deleted_at IS NULL ${isAuthed ? '' : 'AND r.is_public = TRUE'}
  `, [req.params.id]);

  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const recipe = rows[0];

  // Gruppen-Zugangsprüfung für angemeldete Nicht-Admin-User
  if (isAuthed && req.user.role !== 'admin' && req.user.group_id) {
    const ownGroup = recipe.group_id === req.user.group_id;
    const { rows: shareRows } = await pool.query(
      'SELECT 1 FROM recipe_shares WHERE recipe_id = $1 AND target_group_id = $2',
      [recipe.id, req.user.group_id]
    );
    const isShared = shareRows.length > 0;
    if (!ownGroup && !isShared && !recipe.is_public) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
    if (!ownGroup && isShared) {
      recipe.shared_from_group_name = recipe.group_name;
    }
  }

  const [{ rows: ingredients }, { rows: stepsRaw }, { rows: tags }, { rows: stepImgs }] = await Promise.all([
    pool.query('SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY sort_order', [recipe.id]),
    pool.query('SELECT * FROM steps WHERE recipe_id = $1 ORDER BY step_number', [recipe.id]),
    pool.query('SELECT t.name, t.slug, t.tag_type FROM tags t JOIN recipe_tags rt ON rt.tag_id = t.id WHERE rt.recipe_id = $1', [recipe.id]),
    pool.query('SELECT step_number, image_path FROM step_images WHERE recipe_id = $1', [recipe.id])
  ]);
  const stepImgMap = {};
  stepImgs.forEach(function(img) { stepImgMap[img.step_number] = img.image_path; });
  const steps = stepsRaw.map(function(s) { return Object.assign({}, s, { image_path: stepImgMap[s.step_number] || null }); });

  res.json({ ...recipe, ingredients, steps, tags });
});

// POST create recipe
router.post('/', authMiddleware, requireWriteAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = Object.assign({}, req.body, { group_id: req.body.group_id || req.user.group_id || null });
    const id = await saveRecipe(client, data, req.user.id);
    await client.query('COMMIT');
    res.json({ id });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
});

// PUT update recipe
router.put('/:id', authMiddleware, requireWriteAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await saveRecipe(client, req.body, req.user.id, req.params.id);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
});

// DELETE recipe (soft delete)
router.delete('/:id', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows } = await pool.query('SELECT id, group_id, image_path FROM recipes WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const recipe = rows[0];

  // Fremdes (freigegebenes) Rezept → nur Freigabe entfernen, nicht löschen
  if (req.user.role !== 'admin' && recipe.group_id !== req.user.group_id) {
    await pool.query('DELETE FROM recipe_shares WHERE recipe_id = $1 AND target_group_id = $2', [recipe.id, req.user.group_id]);
    return res.json({ success: true, unshared: true });
  }

  await pool.query('UPDATE recipes SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// GET Papierkorb – gelöschte Rezepte der eigenen Gruppe
router.get('/trash', authMiddleware, async (req, res) => {
  if (!req.user.group_id && req.user.role !== 'admin')
    return res.json([]);
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(`
    SELECT r.id, r.title, r.image_path, r.deleted_at,
           c.name as category_name, c.icon as category_icon, g.name as group_name
    FROM recipes r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN groups g ON g.id = r.group_id
    WHERE r.deleted_at IS NOT NULL
      ${isAdmin ? '' : 'AND r.group_id = $1'}
    ORDER BY r.deleted_at DESC
  `, isAdmin ? [] : [req.user.group_id]);
  res.json(rows);
});

// POST Rezept wiederherstellen
router.post('/:id/restore', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows } = await pool.query('SELECT id, group_id FROM recipes WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.user.role !== 'admin' && rows[0].group_id !== req.user.group_id)
    return res.status(403).json({ error: 'Keine Berechtigung' });
  await pool.query('UPDATE recipes SET deleted_at = NULL WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// DELETE Rezept endgültig löschen
router.delete('/:id/permanent', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows } = await pool.query('SELECT id, group_id, image_path FROM recipes WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.user.role !== 'admin' && rows[0].group_id !== req.user.group_id)
    return res.status(403).json({ error: 'Keine Berechtigung' });
  if (rows[0].image_path) {
    const fp = path.join(IMAGE_DIR, path.basename(rows[0].image_path));
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
  }
  await pool.query('DELETE FROM recipes WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST upload image
router.post('/:id/image', authMiddleware, requireWriteAccess, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  const ext = req.file.mimetype.includes('png') ? 'png' : 'jpg';
  const filename = `${req.params.id}_${uuidv4()}.${ext}`;
  const dest = path.join(IMAGE_DIR, filename);
  // Kopieren statt Umbenennen (EXDEV-Fehler bei Cross-Device)
  fs.copyFileSync(req.file.path, dest);
  fs.unlinkSync(req.file.path);
  await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [`/images/${filename}`, req.params.id]);
  res.json({ image_path: `/images/${filename}` });
});

// POST download image for recipe
router.post('/:id/fetch-image', authMiddleware, requireWriteAccess, async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url erforderlich' });
  const localPath = await downloadImage(image_url, req.params.id);
  if (!localPath) return res.status(500).json({ error: 'Bild-Download fehlgeschlagen' });
  await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [localPath, req.params.id]);
  res.json({ image_path: localPath });
});

// GET alle Galerie-Bilder eines Rezepts
router.get('/:id/images', optionalAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM recipe_images WHERE recipe_id = $1 ORDER BY sort_order, created_at',
    [req.params.id]
  );
  res.json(rows);
});

// POST Galerie-Bild hochladen
router.post('/:id/images', authMiddleware, requireWriteAccess, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  const ext = req.file.mimetype.includes('png') ? 'png' : 'jpg';
  const filename = `gallery_${req.params.id}_${uuidv4()}.${ext}`;
  const dest = path.join(IMAGE_DIR, filename);
  fs.copyFileSync(req.file.path, dest);
  fs.unlinkSync(req.file.path);
  const { rows: existing } = await pool.query('SELECT COUNT(*) as c FROM recipe_images WHERE recipe_id = $1', [req.params.id]);
  const sortOrder = parseInt(existing[0].c);
  const { rows } = await pool.query(
    'INSERT INTO recipe_images (recipe_id, image_path, caption, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.params.id, `/images/${filename}`, req.body.caption || null, sortOrder]
  );
  // Erstes Bild automatisch als Hauptbild setzen
  if (sortOrder === 0) {
    await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [`/images/${filename}`, req.params.id]);
  }
  res.json(rows[0]);
});

// DELETE Galerie-Bild
router.delete('/:id/images/:imageId', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM recipe_images WHERE id = $1 AND recipe_id = $2', [req.params.imageId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const fp = path.join(IMAGE_DIR, path.basename(rows[0].image_path));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  await pool.query('DELETE FROM recipe_images WHERE id = $1', [req.params.imageId]);
  // Wenn erstes Bild gelöscht: nächstes als Hauptbild setzen
  const { rows: remaining } = await pool.query('SELECT image_path FROM recipe_images WHERE recipe_id = $1 ORDER BY sort_order LIMIT 1', [req.params.id]);
  await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [remaining[0]?.image_path || null, req.params.id]);
  res.json({ success: true });
});

// PUT Reihenfolge der Galerie-Bilder
router.put('/:id/images/order', authMiddleware, requireWriteAccess, async (req, res) => {
  const { order } = req.body; // Array von IDs in neuer Reihenfolge
  for (let i = 0; i < order.length; i++) {
    await pool.query('UPDATE recipe_images SET sort_order = $1 WHERE id = $2 AND recipe_id = $3', [i, order[i], req.params.id]);
  }
  // Erstes Bild als Hauptbild
  const { rows } = await pool.query('SELECT image_path FROM recipe_images WHERE recipe_id = $1 ORDER BY sort_order LIMIT 1', [req.params.id]);
  if (rows[0]) await pool.query('UPDATE recipes SET image_path = $1 WHERE id = $2', [rows[0].image_path, req.params.id]);
  res.json({ success: true });
});

// POST Bild zu einem Schritt hochladen (per Schritt-Nummer, stabil nach Re-Save)
router.post('/:recipeId/steps/:stepNumber/image', authMiddleware, requireWriteAccess, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  const ext = req.file.mimetype.includes('png') ? 'png' : 'jpg';
  const filename = `step_${req.params.recipeId}_${req.params.stepNumber}_${uuidv4()}.${ext}`;
  const dest = path.join(IMAGE_DIR, filename);
  fs.copyFileSync(req.file.path, dest);
  fs.unlinkSync(req.file.path);
  // Altes Bild löschen falls vorhanden
  const { rows: old_imgs } = await pool.query(
    'SELECT image_path FROM step_images WHERE recipe_id = $1 AND step_number = $2',
    [req.params.recipeId, req.params.stepNumber]
  );
  for (const img of old_imgs) {
    const fp = path.join(IMAGE_DIR, path.basename(img.image_path));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await pool.query(
    'INSERT INTO step_images (recipe_id, step_number, image_path) VALUES ($1, $2, $3) ON CONFLICT (recipe_id, step_number) DO UPDATE SET image_path = EXCLUDED.image_path',
    [req.params.recipeId, req.params.stepNumber, `/images/${filename}`]
  );
  res.json({ image_path: `/images/${filename}` });
});

// DELETE Bild eines Schritts
router.delete('/:recipeId/steps/:stepNumber/image', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT image_path FROM step_images WHERE recipe_id = $1 AND step_number = $2',
    [req.params.recipeId, req.params.stepNumber]
  );
  for (const img of rows) {
    const fp = path.join(IMAGE_DIR, path.basename(img.image_path));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await pool.query(
    'DELETE FROM step_images WHERE recipe_id = $1 AND step_number = $2',
    [req.params.recipeId, req.params.stepNumber]
  );
  res.json({ success: true });
});

// POST Rezept duplizieren
router.post('/:id/duplicate', authMiddleware, requireWriteAccess, async (req, res) => {
  const { rows: [orig] } = await pool.query('SELECT * FROM recipes WHERE id = $1', [req.params.id]);
  if (!orig) return res.status(404).json({ error: 'Nicht gefunden' });

  const { rows: [newRecipe] } = await pool.query(
    `INSERT INTO recipes (title, description, servings, prep_time, cook_time, difficulty, category_id, notes, source_url, is_public, created_by, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [orig.title + ' (Kopie)', orig.description, orig.servings, orig.prep_time, orig.cook_time,
     orig.difficulty, orig.category_id, orig.notes, orig.source_url, false, req.user.id,
     req.user.group_id || orig.group_id || null]
  );

  const { rows: ings } = await pool.query('SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY sort_order', [req.params.id]);
  for (const ing of ings) {
    await pool.query(
      'INSERT INTO ingredients (recipe_id, amount, unit, name, group_name, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [newRecipe.id, ing.amount, ing.unit, ing.name, ing.group_name, ing.sort_order]
    );
  }

  const { rows: steps } = await pool.query('SELECT * FROM steps WHERE recipe_id = $1 ORDER BY step_number', [req.params.id]);
  for (const step of steps) {
    await pool.query(
      'INSERT INTO steps (recipe_id, step_number, description) VALUES ($1,$2,$3)',
      [newRecipe.id, step.step_number, step.description]
    );
  }

  const { rows: tags } = await pool.query('SELECT tag_id FROM recipe_tags WHERE recipe_id = $1', [req.params.id]);
  for (const tag of tags) {
    await pool.query('INSERT INTO recipe_tags (recipe_id, tag_id) VALUES ($1,$2)', [newRecipe.id, tag.tag_id]);
  }

  res.json({ id: newRecipe.id });
});

// GET gespeicherte Nährwerte
router.get('/:id/nutrition', optionalAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM recipe_nutrition WHERE recipe_id = $1', [req.params.id]);
  if (!rows[0]) return res.json(null);
  const r = await pool.query('SELECT servings FROM recipes WHERE id = $1', [req.params.id]);
  res.json({ nutrition: rows[0], servings: r.rows[0]?.servings || 4 });
});

// GET Liste der Gruppen, mit denen ein Rezept geteilt wird
router.get('/:id/shares', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rs.target_group_id as group_id, g.name as group_name, rs.shared_at
     FROM recipe_shares rs JOIN groups g ON g.id = rs.target_group_id
     WHERE rs.recipe_id = $1`,
    [req.params.id]
  );
  res.json(rows);
});

// POST Rezept mit einer Gruppe teilen
router.post('/:id/share', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.group_role !== 'group_admin')
    return res.status(403).json({ error: 'Nur Gruppenadmins können Rezepte teilen' });

  const { target_group_id } = req.body;
  if (!target_group_id) return res.status(400).json({ error: 'target_group_id erforderlich' });

  const { rows: [recipe] } = await pool.query('SELECT * FROM recipes WHERE id = $1', [req.params.id]);
  if (!recipe) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.user.role !== 'admin' && recipe.group_id !== req.user.group_id)
    return res.status(403).json({ error: 'Kein Zugriff auf dieses Rezept' });
  if (recipe.group_id === parseInt(target_group_id))
    return res.status(400).json({ error: 'Rezept gehört bereits dieser Gruppe' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO recipe_shares (recipe_id, target_group_id, shared_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.params.id, target_group_id, req.user.id]
    );
    // Anforderung 8: fehlende Kategorie in Zielgruppe erstellen
    if (recipe.category_id) {
      const { rows: [cat] } = await client.query('SELECT * FROM categories WHERE id = $1', [recipe.category_id]);
      if (cat) {
        const { rows: existingCats } = await client.query(
          'SELECT id FROM categories WHERE name ILIKE $1 AND group_id = $2',
          [cat.name, target_group_id]
        );
        if (!existingCats.length) {
          const slug = cat.slug.replace(/(-\d+)?$/, '') + '-grp' + target_group_id + '-' + Date.now();
          await client.query(
            'INSERT INTO categories (name, slug, icon, color, group_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [cat.name, slug, cat.icon, cat.color, target_group_id]
          );
        }
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// DELETE Teilen eines Rezepts mit einer Gruppe aufheben
router.delete('/:id/share/:groupId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.group_role !== 'group_admin')
    return res.status(403).json({ error: 'Keine Berechtigung' });
  await pool.query(
    'DELETE FROM recipe_shares WHERE recipe_id = $1 AND target_group_id = $2',
    [req.params.id, req.params.groupId]
  );
  res.json({ success: true });
});

// POST Rezept in eigene Gruppe kopieren
router.post('/:id/copy', authMiddleware, requireWriteAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Original laden
    const { rows: [orig] } = await client.query('SELECT * FROM recipes WHERE id = $1', [req.params.id]);
    if (!orig) return res.status(404).json({ error: 'Nicht gefunden' });

    const isAdmin = req.user.role === 'admin';

    // Bereits in der eigenen Gruppe → kein Kopieren nötig
    if (orig.group_id === req.user.group_id) {
      return res.status(400).json({ error: 'Das Rezept gehört bereits deiner Gruppe' });
    }

    // Zugriff prüfen: nur freigegebene Rezepte dürfen übernommen werden
    const shareCheck = await client.query(
      'SELECT 1 FROM recipe_shares WHERE recipe_id=$1 AND target_group_id=$2',
      [orig.id, req.user.group_id]
    );
    if (!isAdmin && shareCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    // Bild kopieren wenn lokal vorhanden
    let newImagePath = orig.image_path;
    if (orig.image_path) {
      try {
        const srcFile = path.join(IMAGE_DIR, path.basename(orig.image_path));
        if (fs.existsSync(srcFile)) {
          const ext = path.extname(orig.image_path);
          const newFilename = `copy_${uuidv4()}${ext}`;
          fs.copyFileSync(srcFile, path.join(IMAGE_DIR, newFilename));
          newImagePath = `/images/${newFilename}`;
        }
      } catch (e) { /* Bildkopie fehlgeschlagen – egal, original-Pfad nutzen */ }
    }

    const { rows: [newRecipe] } = await client.query(`
      INSERT INTO recipes (title, description, servings, prep_time, cook_time, difficulty,
        category_id, source_url, image_path, image_url, notes, is_public, group_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [orig.title, orig.description, orig.servings, orig.prep_time, orig.cook_time, orig.difficulty,
       orig.category_id, orig.source_url, newImagePath, orig.image_url, orig.notes,
       false, req.user.group_id, req.user.id]);
    const newId = newRecipe.id;

    // Zutaten kopieren
    const { rows: ings } = await client.query('SELECT * FROM ingredients WHERE recipe_id=$1 ORDER BY sort_order', [orig.id]);
    for (const ing of ings) {
      await client.query('INSERT INTO ingredients (recipe_id,amount,unit,name,group_name,sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [newId, ing.amount, ing.unit, ing.name, ing.group_name, ing.sort_order]);
    }

    // Schritte kopieren
    const { rows: steps } = await client.query('SELECT * FROM steps WHERE recipe_id=$1 ORDER BY step_number', [orig.id]);
    for (const s of steps) {
      await client.query('INSERT INTO steps (recipe_id,step_number,description) VALUES ($1,$2,$3)',
        [newId, s.step_number, s.description]);
    }

    // Tags kopieren
    const { rows: rtags } = await client.query('SELECT tag_id FROM recipe_tags WHERE recipe_id=$1', [orig.id]);
    for (const t of rtags) {
      await client.query('INSERT INTO recipe_tags (recipe_id,tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [newId, t.tag_id]);
      await client.query('UPDATE tags SET usage_count = usage_count + 1 WHERE id=$1', [t.tag_id]);
    }

    // Freigabe entfernen: die Gruppe hat jetzt ihre eigene Kopie
    if (req.user.group_id) {
      await client.query(
        'DELETE FROM recipe_shares WHERE recipe_id=$1 AND target_group_id=$2',
        [orig.id, req.user.group_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, id: newId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// POST Nährwerte per KI berechnen
router.post('/:id/nutrition', authMiddleware, async (req, res) => {
  const recipe = await pool.query('SELECT * FROM recipes WHERE id = $1', [req.params.id]);
  if (!recipe.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const r = recipe.rows[0];
  const { rows: ingredients } = await pool.query('SELECT * FROM ingredients WHERE recipe_id = $1 ORDER BY sort_order', [req.params.id]);
  if (!ingredients.length) return res.status(400).json({ error: 'Keine Zutaten vorhanden' });

  const ingList = ingredients.map(function(i) {
    return [i.amount, i.unit, i.name].filter(Boolean).join(' ');
  }).join('\n');

  const prompt = `Berechne die ungefähren Nährwerte für dieses Rezept mit ${r.servings || 4} Portionen.

Zutaten:
${ingList}

Antworte NUR mit einem JSON-Objekt ohne Erklärungen:
{
  "calories": <kcal pro Portion>,
  "protein": <g Protein pro Portion>,
  "fat": <g Fett pro Portion>,
  "carbs": <g Kohlenhydrate pro Portion>,
  "fiber": <g Ballaststoffe pro Portion>,
  "total_weight_g": <geschätztes Gesamtgewicht des fertigen Gerichts in Gramm (alle Portionen zusammen)>
}

Schätze realistisch basierend auf den Zutaten. Wenn Mengenangaben fehlen, schätze typische Haushaltsmengen.`;

  const axios = require('axios');
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });

  const text = response.data.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(500).json({ error: 'KI-Antwort konnte nicht verarbeitet werden' });
  const nutrition = JSON.parse(jsonMatch[0]);
  await pool.query(
    `INSERT INTO recipe_nutrition (recipe_id, calories, protein, fat, carbs, fiber, total_weight_g, calculated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (recipe_id) DO UPDATE SET
       calories=$2, protein=$3, fat=$4, carbs=$5, fiber=$6, total_weight_g=$7, calculated_at=NOW()`,
    [req.params.id, nutrition.calories, nutrition.protein, nutrition.fat, nutrition.carbs, nutrition.fiber, nutrition.total_weight_g || null]
  );
  res.json({ nutrition, servings: r.servings || 4 });
});

module.exports = router;
