const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const STOP_WORDS = new Set([
  'mit', 'und', 'nach', 'aus', 'vom', 'von', 'für', 'über', 'auf', 'in', 'an', 'bei',
  'durch', 'zu', 'zum', 'zur', 'am', 'im', 'ein', 'eine', 'einen', 'einem', 'des', 'der',
  'die', 'das', 'dem', 'den', 'beim', 'wie', 'ohne', 'oder', 'aber', 'auch', 'noch',
  'sehr', 'ganz', 'omas', 'opas', 'mamas', 'bestes', 'beste', 'bester', 'leckeres',
  'leckere', 'einfaches', 'einfache', 'schnelles', 'schnelle', 'klassisches', 'klassische',
  'klassisch', 'einfach', 'schnell', 'lecker', 'herzhaft', 'herzhaftes', 'selbstgemacht',
  'hausgemacht', 'mein', 'meine', 'unser', 'unsere', 'leicht', 'leichte', 'gesund',
  'gesunde', 'cremige', 'cremiger', 'knusprige', 'knuspriger', 'art', 'rezept', 'gericht'
]);

function cleanQuery(title) {
  const words = title
    .split(/[\s,;:–\-()[\]]+/)
    .map(function(w) { return w.replace(/[^a-zA-ZäöüÄÖÜß]/g, ''); })
    .filter(function(w) { return w.length > 2 && !STOP_WORDS.has(w.toLowerCase()); });
  return words.slice(0, 3).join(' ') || title.split(/\s+/).slice(0, 2).join(' ');
}

// GET /api/image-search?q=Gulasch
router.get('/image-search', authMiddleware, async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(503).json({ error: 'Bildsuche nicht konfiguriert – bitte PEXELS_API_KEY in der docker-compose.yml setzen.' });
  }

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Kein Suchbegriff' });

  const query = cleanQuery(q);

  try {
    const resp = await axios.get('https://api.pexels.com/v1/search', {
      params: { query: query + ' food', per_page: 9, orientation: 'landscape' },
      headers: { Authorization: apiKey.trim() },
      timeout: 10000
    });

    const photos = resp.data.photos || [];
    const images = photos.map(function(p) {
      return {
        thumbnail: p.src.medium,
        full: p.src.large,
        title: p.alt || ''
      };
    });

    res.json({ images, query });
  } catch (err) {
    const status = err.response ? err.response.status : null;
    console.error('Pexels Bildsuche Fehler (Status ' + status + '):', err.message);
    res.status(502).json({ error: 'Bildsuche fehlgeschlagen: ' + err.message });
  }
});

module.exports = router;
