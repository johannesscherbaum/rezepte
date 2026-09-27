const express = require('express');
const router = express.Router({ mergeParams: true });
const axios = require('axios');
const { pool } = require('../db');
const { authMiddleware, requireRole, requireWriteAccess, optionalAuth } = require('../middleware/auth');

// GET schedule steps für ein Rezept
router.get('/', optionalAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM schedule_steps WHERE recipe_id = $1 ORDER BY sort_order',
    [req.params.recipeId]
  );
  res.json(rows);
});

// PUT alle steps auf einmal speichern (ersetzt vorhandene)
router.put('/', authMiddleware, requireWriteAccess, async (req, res) => {
  const { steps } = req.body;
  if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps Array erforderlich' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM schedule_steps WHERE recipe_id = $1', [req.params.recipeId]);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await client.query(
        'INSERT INTO schedule_steps (recipe_id, title, duration_minutes, notes, sort_order) VALUES ($1,$2,$3,$4,$5)',
        [req.params.recipeId, s.title, parseInt(s.duration_minutes) || 0, s.notes || null, i]
      );
    }
    await client.query('COMMIT');
    const { rows } = await pool.query(
      'SELECT * FROM schedule_steps WHERE recipe_id = $1 ORDER BY sort_order',
      [req.params.recipeId]
    );
    res.json(rows);
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
});

// POST – Claude extrahiert Zeitplan aus Rezepttext
router.post('/extract', authMiddleware, requireWriteAccess, async (req, res) => {
  const { title, ingredients, steps, notes } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY fehlt' });

  const recipeText = `
Rezept: ${title || ''}
Zutaten: ${(ingredients || []).map(i => `${i.amount||''} ${i.unit||''} ${i.name}`).join(', ')}
Zubereitung: ${(steps || []).map((s,i) => `${i+1}. ${s.description||s}`).join(' ')}
${notes ? 'Tipps: ' + notes : ''}
  `.trim();

  const prompt = `Analysiere dieses Rezept und erstelle einen detaillierten Zeitplan mit allen wichtigen Schritten (Vorbereitung, Wartezeiten, Gärzeiten, Backzeiten, Ruhezeiten etc.).

Antworte NUR mit validem JSON, keine Backticks, keine Erklärungen:
{
  "steps": [
    {
      "title": "Schrittname",
      "duration_minutes": 30,
      "notes": "optionale Hinweise zum Schritt"
    }
  ]
}

Regeln:
- Jeder Schritt braucht einen klaren Titel und eine realistische Dauer in Minuten
- Passive Zeiten (Gären, Ruhen, Backen) als eigene Schritte
- Aktive Arbeitsschritte (Kneten, Formen) ebenfalls
- Maximal 12 Schritte
- Realistische Zeiten für Brot und andere Backwaren

Rezept:
${recipeText}`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (resp.data.stop_reason === 'max_tokens') {
      console.error('Zeitplan-Extraktion: Antwort bei max_tokens abgeschnitten');
      return res.status(422).json({ error: 'Rezept zu umfangreich für die Zeitplan-Extraktion in einem Durchgang.' });
    }

    const raw = resp.data.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error('Zeitplan-Extraktion: Antwort konnte nicht als JSON geparst werden:', raw);
      return res.status(502).json({ error: 'KI-Antwort konnte nicht ausgewertet werden' });
    }
    res.json(parsed);
  } catch(e) {
    console.error('Zeitplan-Extraktion Fehler:', e.response ? e.response.data : e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

module.exports = router;
