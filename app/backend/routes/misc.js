const express = require('express');
const router = express.Router();
const multer = require('multer');
const xml2js = require('xml2js');
const { parse: parseHtml } = require('node-html-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { pool } = require('../db');
const { authMiddleware, requireRole, requireAdminOrGroupAdmin, requireWriteAccess, optionalAuth } = require('../middleware/auth');

// ── Categories ──────────────────────────────────────────────────────────────
router.get('/categories', optionalAuth, async (req, res) => {
  const isAuthed = !!req.user;
  let catWhere = '';
  const catParams = [];

  if (isAuthed && req.user.role !== 'admin') {
    if (req.user.group_id) {
      catWhere = 'WHERE c.group_id = $1';
      catParams.push(req.user.group_id);
    } else {
      catWhere = 'WHERE FALSE';
    }
  }
  // globaler Admin und nicht-authentifizierte Nutzer: alle Kategorien

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.slug, c.icon, c.color, c.parent_id, c.group_id,
      COUNT(r.id)::int as recipe_count
    FROM categories c
    LEFT JOIN recipes r ON r.category_id = c.id ${isAuthed ? '' : 'AND r.is_public = TRUE'}
    ${catWhere}
    GROUP BY c.id ORDER BY c.parent_id NULLS FIRST, c.name
  `, catParams);
  res.json(rows);
});

router.post('/categories', authMiddleware, requireAdminOrGroupAdmin, async (req, res) => {
  try {
    const { name, icon, color, parent_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const group_id = req.user.role === 'admin'
      ? (req.body.group_id || req.user.group_id || null)
      : req.user.group_id;
    const slug = name.toLowerCase().replace(/[^a-z0-9äöüß]/g, '-').replace(/-+/g, '-') + '-' + Date.now();
    const { rows } = await pool.query(
      'INSERT INTO categories (name, slug, icon, color, parent_id, group_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, slug, icon || '🍽️', color || '#7c6af7', parent_id || null, group_id]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Eine Kategorie mit diesem Namen existiert bereits' });
    }
    console.error('POST /categories Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Anlegen der Kategorie' });
  }
});

router.patch('/categories/:id', authMiddleware, requireAdminOrGroupAdmin, async (req, res) => {
  try {
    const { name, icon, parent_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    // Verhindere zirkuläre Referenzen
    if (parent_id && parseInt(parent_id) === parseInt(req.params.id))
      return res.status(400).json({ error: 'Kategorie kann nicht ihre eigene Elternkategorie sein' });
    // Subkategorie darf nicht selbst Subkategorien haben
    if (parent_id) {
      const { rows } = await pool.query('SELECT COUNT(*) as c FROM categories WHERE parent_id = $1', [req.params.id]);
      if (parseInt(rows[0].c) > 0)
        return res.status(400).json({ error: 'Kategorie mit Subkategorien kann nicht verschoben werden' });
    }
    await pool.query(
      'UPDATE categories SET name = $1, icon = $2, parent_id = $3 WHERE id = $4',
      [name.trim(), icon || '🍽️', parent_id ? parseInt(parent_id) : null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Eine Kategorie mit diesem Namen existiert bereits' });
    }
    console.error('PATCH /categories Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Speichern der Kategorie' });
  }
});

router.delete('/categories/:id', authMiddleware, requireAdminOrGroupAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /categories Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Löschen der Kategorie' });
  }
});

// ── Tags ─────────────────────────────────────────────────────────────────────
router.get('/tags', optionalAuth, async (req, res) => {
  const isAuthed = !!req.user;
  const isAdmin = isAuthed && req.user.role === 'admin';

  if (isAuthed && !isAdmin) {
    // Nur Tags von Rezepten der eigenen Gruppe oder freigegebenen Rezepten
    if (!req.user.group_id) return res.json([]);
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.slug, t.tag_type,
        COUNT(rt.recipe_id)::int as usage_count
      FROM tags t
      JOIN recipe_tags rt ON rt.tag_id = t.id
      JOIN recipes r ON r.id = rt.recipe_id
        AND r.deleted_at IS NULL
        AND (r.group_id = $1 OR r.id IN (SELECT recipe_id FROM recipe_shares WHERE target_group_id = $1))
      GROUP BY t.id
      HAVING COUNT(rt.recipe_id) > 0
      ORDER BY COUNT(rt.recipe_id) DESC
      LIMIT 200
    `, [req.user.group_id]);
    return res.json(rows);
  }

  // Admin: alle Tags; nicht eingeloggt: nur Tags öffentlicher Rezepte
  const { rows } = await pool.query(`
    SELECT t.id, t.name, t.slug, t.tag_type,
      COUNT(rt.recipe_id)::int as usage_count
    FROM tags t
    LEFT JOIN recipe_tags rt ON rt.tag_id = t.id
    LEFT JOIN recipes r ON r.id = rt.recipe_id AND r.deleted_at IS NULL ${isAuthed ? '' : 'AND r.is_public = TRUE'}
    GROUP BY t.id
    HAVING COUNT(rt.recipe_id) > 0
    ORDER BY COUNT(rt.recipe_id) DESC
    LIMIT 200
  `);
  res.json(rows);
});

// ── Tags CRUD ─────────────────────────────────────────────────────────────────
router.post('/tags', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9äöüß]/g, '-').replace(/-+/g, '-');
    const { rows } = await pool.query(
      'INSERT INTO tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING *',
      [name.trim().toLowerCase(), slug]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('POST /tags Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Anlegen des Tags' });
  }
});

router.delete('/tags/:slug', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM tags WHERE slug = $1', [req.params.slug]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tags Fehler:', e);
    res.status(500).json({ error: 'Fehler beim Löschen des Tags' });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', optionalAuth, async (req, res) => {
  const isAuthed = !!req.user;
  let recipeFilter = isAuthed ? 'r.deleted_at IS NULL' : 'r.is_public = TRUE AND r.deleted_at IS NULL';
  const statsParams = [];

  if (isAuthed && req.user.role !== 'admin' && req.user.group_id) {
    statsParams.push(req.user.group_id);
    recipeFilter = `r.deleted_at IS NULL AND (r.group_id = $1 OR r.id IN (SELECT recipe_id FROM recipe_shares WHERE target_group_id = $1))`;
  } else if (isAuthed && req.user.role !== 'admin') {
    recipeFilter = 'FALSE';
  }

  const [recipes, cats, tags, recentRows] = await Promise.all([
    pool.query(`SELECT COUNT(*) as c FROM recipes r WHERE ${recipeFilter}`, statsParams),
    pool.query('SELECT COUNT(*) as c FROM categories WHERE recipe_count > 0'),
    pool.query('SELECT COUNT(*) as c FROM tags WHERE usage_count > 0'),
    pool.query(`SELECT r.id, r.title, r.image_path, c.icon, c.name as cat FROM recipes r LEFT JOIN categories c ON c.id = r.category_id WHERE ${recipeFilter} ORDER BY r.created_at DESC LIMIT 6`, statsParams)
  ]);

  res.json({
    recipes: parseInt(recipes.rows[0].c),
    categories: parseInt(cats.rows[0].c),
    tags: parseInt(tags.rows[0].c),
    recent: recentRows.rows
  });
});

// ── Evernote Import ───────────────────────────────────────────────────────────
const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';
const enexUpload = multer({ dest: '/tmp/', fileFilter: (req, file, cb) => {
  cb(null, file.originalname.endsWith('.enex'));
}});

function htmlToPlain(html) {
  if (!html) return '';
  try { return parseHtml(html).text.replace(/\s+/g, ' ').trim(); }
  catch { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
}

function parseEnDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

// Liest die <resource>-Elemente einer ENEX-Notiz aus (Base64-Bilddaten),
// speichert Bilder als Dateien im IMAGE_DIR und baut eine Hash->Pfad-Zuordnung,
// damit <en-media hash="..."/> im Notiztext später durch echte <img>-Tags
// ersetzt werden kann (der hash im ENML entspricht dem MD5 der Rohdaten).
function decodeEnexImageResources(note) {
  const resources = note.resource || [];
  const hashToPath = {};
  const allPaths = [];
  resources.forEach(function (res) {
    try {
      const mime = res.mime && res.mime[0];
      if (!mime || !mime.startsWith('image/')) return;
      const dataNode = res.data && res.data[0];
      const base64 = typeof dataNode === 'string' ? dataNode : (dataNode && dataNode._);
      if (!base64) return;
      const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
      const md5 = crypto.createHash('md5').update(buffer).digest('hex');
      let ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      if (!ext) ext = 'jpg';
      const filename = `enex_${uuidv4()}.${ext}`;
      fs.writeFileSync(path.join(IMAGE_DIR, filename), buffer);
      const imgPath = `/images/${filename}`;
      hashToPath[md5] = imgPath;
      allPaths.push(imgPath);
    } catch (e) {
      console.error('ENEX-Bild konnte nicht extrahiert werden:', e);
    }
  });
  return { hashToPath, allPaths };
}

router.post('/evernote/import', authMiddleware, requireAdminOrGroupAdmin, enexUpload.single('enex'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const notebookName = req.body.notebookName || req.file.originalname.replace('.enex', '');

  try {
    const xml = fs.readFileSync(req.file.path, 'utf8');
    const parser = new xml2js.Parser({ explicitArray: true, trim: true });

    const result = await new Promise((resolve, reject) =>
      parser.parseString(xml, (err, r) => err ? reject(err) : resolve(r))
    );

    const notes = result['en-export']?.note || [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let nb = await client.query('SELECT id FROM evernote_notebooks WHERE name = $1', [notebookName]);
      let nbId;
      if (nb.rows.length) {
        nbId = nb.rows[0].id;
      } else {
        const r = await client.query('INSERT INTO evernote_notebooks (name) VALUES ($1) RETURNING id', [notebookName]);
        nbId = r.rows[0].id;
      }

      let count = 0;
      for (const note of notes) {
        const { hashToPath, allPaths } = decodeEnexImageResources(note);
        const rawContent = note.content?.[0] || '';
        const html = rawContent
          .replace(/<en-note[^>]*>/gi, '<div>')
          .replace(/<\/en-note>/gi, '</div>')
          .replace(/<en-todo[^>]*/gi, '<input type="checkbox" disabled')
          .replace(/<en-media([^>]*)\/>/gi, function (match, attrs) {
            const hashMatch = attrs.match(/hash="([a-f0-9]+)"/i);
            const hash = hashMatch && hashMatch[1];
            const imgPath = hash && hashToPath[hash];
            return imgPath
              ? '<img src="' + imgPath + '" style="max-width:100%;border-radius:8px;margin:8px 0">'
              : '[Anhang]';
          });
        const plain = htmlToPlain(html);

        const { rows: [newNote] } = await client.query(`
          INSERT INTO evernote_notes (notebook_id, title, content, content_plain, created_at, updated_at, source_url)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
        `, [nbId, note.title?.[0] || 'Ohne Titel', html, plain,
            parseEnDate(note.created?.[0]), parseEnDate(note.updated?.[0]),
            note.attributes?.[0]?.['source-url']?.[0] || null]);

        for (let imgIdx = 0; imgIdx < allPaths.length; imgIdx++) {
          await client.query(
            'INSERT INTO evernote_note_images (note_id, image_path, sort_order) VALUES ($1,$2,$3)',
            [newNote.id, allPaths[imgIdx], imgIdx]
          );
        }

        for (const tag of (note.tag || [])) {
          if (tag?.trim()) {
            await client.query(
              'INSERT INTO evernote_note_tags (note_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING',
              [newNote.id, tag.trim().toLowerCase()]
            );
          }
        }
        count++;
      }

      await client.query('COMMIT');
      fs.unlinkSync(req.file.path);
      res.json({ success: true, imported: count, notebook: notebookName });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.message });
  }
});

router.get('/evernote/notebooks', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT n.id, n.name, n.created_at, COUNT(no.id) as note_count
    FROM evernote_notebooks n
    LEFT JOIN evernote_notes no ON no.notebook_id = n.id
    GROUP BY n.id ORDER BY n.name
  `);
  res.json(rows);
});

router.get('/evernote/notes', authMiddleware, async (req, res) => {
  const { notebook, search, limit = 50, offset = 0 } = req.query;
  let where = []; let params = []; let i = 1;
  if (notebook) { where.push(`n.notebook_id = $${i++}`); params.push(notebook); }
  if (search) {
    where.push(`(n.title ILIKE $${i} OR n.content_plain ILIKE $${i})`);
    params.push(`%${search}%`); i++;
  }
  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await pool.query(`
    SELECT n.id, n.title, n.created_at, n.updated_at, nb.name as notebook_name,
           LEFT(n.content_plain, 200) as snippet,
           n.imported_recipe_id, r.title as imported_recipe_title
    FROM evernote_notes n
    JOIN evernote_notebooks nb ON nb.id = n.notebook_id
    LEFT JOIN recipes r ON r.id = n.imported_recipe_id
    ${wc} ORDER BY n.updated_at DESC LIMIT $${i++} OFFSET $${i++}
  `, [...params, Number(limit), Number(offset)]);
  res.json(rows);
});

router.get('/evernote/notes/:id', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT n.*, nb.name as notebook_name, r.title as imported_recipe_title
    FROM evernote_notes n
    JOIN evernote_notebooks nb ON nb.id = n.notebook_id
    LEFT JOIN recipes r ON r.id = n.imported_recipe_id
    WHERE n.id = $1
  `, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
  const tags = await pool.query('SELECT tag FROM evernote_note_tags WHERE note_id = $1', [req.params.id]);
  const images = await pool.query('SELECT id, image_path FROM evernote_note_images WHERE note_id = $1 ORDER BY sort_order', [req.params.id]);
  res.json({ ...rows[0], tags: tags.rows.map(r => r.tag), images: images.rows });
});

// PATCH /api/evernote/notes/:id/link-recipe   Body: { recipe_id }
// Verknüpft eine Evernote-Notiz mit dem daraus erzeugten Rezept, damit bereits
// importierte Notizen in der Liste markiert werden können.
router.patch('/evernote/notes/:id/link-recipe', authMiddleware, requireAdminOrGroupAdmin, async (req, res) => {
  const { recipe_id } = req.body;
  if (!recipe_id) return res.status(400).json({ error: 'recipe_id erforderlich' });
  const { rows } = await pool.query(
    'UPDATE evernote_notes SET imported_recipe_id = $1 WHERE id = $2 RETURNING id, imported_recipe_id',
    [recipe_id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  res.json(rows[0]);
});

// DELETE /api/evernote/notes/:id
// Löscht eine einzelne Notiz aus einem importierten Notizbuch (nicht das ganze Notizbuch).
router.delete('/evernote/notes/:id', authMiddleware, requireAdminOrGroupAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM evernote_notes WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  res.json({ success: true });
});

router.delete('/evernote/notebooks/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM evernote_notebooks WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── KI-Suche ────────────────────────────────────────────────────────────────
// group_id wird im Frontend-Request mitgeschickt, da optionalAuth den User kennt
router.post('/search/nl', optionalAuth, async (req, res) => {
  console.log('NL-Suche Request:', req.body?.query);
  const { query, categories } = req.body;
  if (!query) return res.status(400).json({ error: 'query fehlt' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });

  const catList = (categories || [])
    .map(c => `ID ${c.id}: ${c.icon || ''} ${c.name}${c.parent_id ? ' (Unterkategorie)' : ''}`)
    .join('\n');

  const prompt = `Du bist ein Suchfilter für eine deutschsprachige Rezepte-App. Analysiere die Suchanfrage und extrahiere strukturierte Filter.

Verfügbare Kategorien:
${catList}

Suchanfrage: "${query}"

Regeln:
- "terms": Array der einzelnen Suchbegriffe. Stoppwörter wie "mit", "und", "ein", "eine", "etwas", "Rezept" weglassen. Beispiele: "Brot mit Roggen" → ["Brot","Roggen"], "schnelles Hähnchen und Reis" → ["Hähnchen","Reis"], "etwas mit Schokolade" → ["Schokolade"]
- "operator": "AND" wenn "mit"/"und" verbindet, "OR" wenn "oder" verbindet
- "exclude": Array von Begriffen die NICHT vorkommen sollen, z.B. bei "ohne Knoblauch" → ["Knoblauch"]
- "category_id": NUR setzen wenn terms leer ist UND User explizit eine Kategorie nennt (z.B. "alle Kuchen"). Sonst null
- "time_max"/"time_min": nur bei Zeitangaben wie "unter 30 Minuten", "schnell" → time_max 30
- "to_try": nur bei "ausprobieren", "noch nicht gemacht" o.ä.

Antworte NUR mit validem JSON, keine Erklärungen, keine Backticks:
{
  "terms": ["Begriff1", "Begriff2"],
  "operator": "AND",
  "exclude": [],
  "category_id": null,
  "time_max": null,
  "time_min": null,
  "to_try": false
}`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const text = resp.data.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Kein JSON in Antwort: ' + text);
    const filters = JSON.parse(match[0]);
    if (filters.terms && filters.terms.length && filters.category_id) filters.category_id = null;
    console.log('NL-Suche Ergebnis:', JSON.stringify(filters));
    res.json(filters);
  } catch (e) {
    console.error('NL-Suche Fehler:', e.message);
    res.status(500).json({ error: 'KI-Suche fehlgeschlagen' });
  }
});

module.exports = router;
