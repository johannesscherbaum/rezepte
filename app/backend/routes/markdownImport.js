const express = require('express');
const axios = require('axios');
const { authMiddleware, requireRole, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TEXT_CHARS = 25000;

function buildPrompt(text) {
  return `Du bekommst einen Markdown-Text, der ein Kochrezept enthält. Der Text kann unterschiedlich strukturiert sein (Überschriften, Listen, Fließtext, Tabellen usw.).

Extrahiere das Rezept und gib AUSSCHLIESSLICH ein JSON-Objekt zurück (kein Markdown, keine Codeblock-Marker, kein Fließtext davor oder danach) mit exakt diesem Format:

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
- Wenn der Text mehrere Rezepte enthält, jedes als eigenes Element im Array.
- Erfinde keine Zutaten oder Schritte, die nicht im Text stehen.
- Mengenangaben und Einheiten so übernehmen wie im Text (z.B. amount "200", unit "g").
- steps als klare, einzelne Arbeitsschritte, nicht als ein einziger Fließtext-Block.
- Markdown-Formatierung (**, *, #, - usw.) aus dem Ergebnis entfernen, reinen Text ausgeben.
- Sprache der Ausgabe: Deutsch.
- Falls kein Rezept erkennbar ist, gib {"recipes": []} zurück.

Markdown-Text:
"""
${text}
"""`;
}

// POST /api/recipes/import-markdown  (application/json, Feld "markdown")
router.post('/import-markdown', authMiddleware, requireWriteAccess, async (req, res) => {
  try {
    let text = (req.body.markdown || '').trim();
    if (!text || text.length < 10) {
      return res.status(400).json({ error: 'Kein Markdown-Text übermittelt' });
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
      return res.status(422).json({ error: 'Der Text ist zu umfangreich. Bitte kürzen und erneut versuchen.' });
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
      console.error('Markdown-Import: Claude-Antwort konnte nicht geparst werden:', raw);
      return res.status(502).json({ error: 'KI-Antwort konnte nicht ausgewertet werden' });
    }

    const recipes = Array.isArray(parsedJson.recipes) ? parsedJson.recipes : [];
    res.json({ recipes });
  } catch (err) {
    console.error('Markdown-Import Fehler:', err.response ? err.response.data : err);
    res.status(500).json({ error: err.message || 'Fehler beim Markdown-Import' });
  }
});

module.exports = router;
