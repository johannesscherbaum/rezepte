const express = require('express');
const multer = require('multer');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { authMiddleware, requireRole, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// WICHTIG: an dasselbe Modell anpassen, das auch in der Nährwert-Berechnung verwendet wird
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TEXT_CHARS = 25000;

function buildPrompt(text) {
  return `Du bekommst den Rohtext einer PDF-Datei, die ein oder mehrere Kochrezepte enthaelt. Die Struktur der PDF ist unbekannt und kann stark variieren (Kochbuch-Seiten, Rezeptkarten, Blog-Ausdrucke, Scans mit OCR-Text usw).

Extrahiere ALLE Rezepte, die du im Text findest, und gib AUSSCHLIESSLICH ein JSON-Objekt zurueck (kein Markdown, keine Codeblock-Marker, kein Fliesstext davor oder danach) mit exakt diesem Format:

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
- Wenn der Text nur ein Rezept enthaelt, gib ein Array mit einem Element zurueck.
- Erfinde keine Zutaten oder Schritte, die nicht im Text stehen.
- Mengenangaben und Einheiten so uebernehmen wie im Text (z.B. amount "200", unit "g").
- steps als klare, einzelne Arbeitsschritte, nicht als ein einziger Fliesstext-Block.
- Text-Fragmente, die keine Rezepte sind (Vorwort, Inhaltsverzeichnis, Werbung), ignorieren.
- Sprache der Ausgabe: Deutsch.

Text der PDF:
"""
${text}
"""`;
}

// POST /api/recipes/import-pdf  (multipart/form-data, Feld "pdf")
router.post('/import-pdf', authMiddleware, requireWriteAccess, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Keine PDF-Datei hochgeladen' });
    }

    const parsed = await pdfParse(req.file.buffer);
    let text = (parsed.text || '').replace(/[ \t]+\n/g, '\n').trim();

    if (!text || text.length < 30) {
      return res.status(422).json({ error: 'Konnte keinen Text aus dem PDF extrahieren (evtl. gescanntes Bild-PDF ohne Textebene)' });
    }
    text = text.slice(0, MAX_TEXT_CHARS);

    const claudeResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        messages: [{ role: 'user', content: buildPrompt(text) }]
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
      console.error('PDF-Import: Antwort wurde bei max_tokens abgeschnitten (zu viele/lange Rezepte im PDF)');
      return res.status(422).json({ error: 'Das PDF enthält zu viele oder zu umfangreiche Rezepte für einen Durchgang. Bitte das PDF in kleinere Abschnitte aufteilen und einzeln importieren.' });
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
      console.error('PDF-Import: Claude-Antwort konnte nicht geparst werden:', raw);
      return res.status(502).json({ error: 'KI-Antwort konnte nicht ausgewertet werden' });
    }

    const recipes = Array.isArray(parsedJson.recipes) ? parsedJson.recipes : [];
    res.json({ recipes: recipes });
  } catch (err) {
    console.error('PDF-Import Fehler:', err.response ? err.response.data : err);
    res.status(500).json({ error: err.message || 'Fehler beim PDF-Import' });
  }
});

module.exports = router;
