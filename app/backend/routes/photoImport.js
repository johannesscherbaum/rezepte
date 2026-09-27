const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { authMiddleware, requireRole, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    cb(null, /^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype));
  }
});

// WICHTIG: an dasselbe Modell anpassen, das auch bei PDF-Import/Nährwerten verwendet wird
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

function buildPrompt() {
  return `Du bekommst ein Foto, das ein Kochrezept zeigt - z.B. eine Rezeptkarte, eine Kochbuchseite, eine handschriftliche Notiz oder einen Ausdruck. Erkenne den Text (auch handschriftlich) so gut wie möglich.

Gib AUSSCHLIESSLICH ein JSON-Objekt zurück (kein Markdown, keine Codeblock-Marker, kein Fliesstext davor oder danach) mit exakt diesem Format:

{
  "recipes": [
    {
      "title": "string",
      "description": "kurze Beschreibung, string oder leer",
      "servings": number oder null,
      "prep_time": number in Minuten oder null,
      "cook_time": number in Minuten oder null,
      "difficulty": "einfach" | "mittel" | "schwer",
      "ingredients": [ { "amount": "string", "unit": "string", "name": "string", "group": "string oder leer" } ],
      "steps": [ "string", "string", ... ],
      "tags": [ "string", ... ],
      "notes": "Tipps/Variationen als string oder leer"
    }
  ]
}

Regeln:
- Falls das Foto mehrere klar getrennte Rezepte zeigt, jedes als eigenes Element im Array.
- Erfinde keine Zutaten oder Schritte, die auf dem Foto nicht erkennbar sind.
- Bei unleserlichen Stellen eine sinnvolle Bestapproximation, aber nichts Erfundenes hinzudichten.
- steps als klare, einzelne Arbeitsschritte, nicht als ein einziger Fliesstext-Block.
- Sprache der Ausgabe: Deutsch.
- Falls auf dem Foto gar kein Rezept erkennbar ist, gib {"recipes": []} zurück.`;
}

// POST /api/recipes/import-photo  (multipart/form-data, Feld "photo")
router.post('/import-photo', authMiddleware, requireWriteAccess, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Kein Foto hochgeladen' });

    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype;

    const claudeResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: buildPrompt() }
          ]
        }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );

    if (claudeResp.data.stop_reason === 'max_tokens') {
      console.error('Foto-Import: Antwort bei max_tokens abgeschnitten');
      return res.status(422).json({ error: 'Antwort zu umfangreich abgeschnitten.' });
    }

    const raw = (claudeResp.data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n')
      .trim();

    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsedJson;
    try {
      parsedJson = JSON.parse(clean);
    } catch (e) {
      console.error('Foto-Import: Claude-Antwort konnte nicht geparst werden:', raw);
      return res.status(502).json({ error: 'KI-Antwort konnte nicht ausgewertet werden' });
    }

    const recipes = Array.isArray(parsedJson.recipes) ? parsedJson.recipes : [];
    res.json({ recipes: recipes });
  } catch (err) {
    console.error('Foto-Import Fehler:', err.response ? err.response.data : err);
    res.status(500).json({ error: err.message || 'Fehler beim Foto-Import' });
  }
});

module.exports = router;
