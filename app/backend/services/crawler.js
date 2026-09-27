const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RezepteBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'de,en;q=0.9'
    },
    maxContentLength: 5 * 1024 * 1024
  });
  return resp.data;
}

function extractTextFromHtml(html, url) {
  const $ = cheerio.load(html);

  // Remove noise
  $('script, style, nav, footer, header, .cookie, .ad, .advertisement, .popup, .modal, .newsletter, .social, .sidebar, .comment').remove();

  // Try to find main content
  const mainSelectors = [
    'article', '[class*="recipe"]', '[itemtype*="Recipe"]',
    'main', '.content', '.post-content', '#content'
  ];

  let mainContent = '';
  for (const sel of mainSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      mainContent = el.text();
      break;
    }
  }

  if (!mainContent) mainContent = $('body').text();

  // Clean up
  mainContent = mainContent.replace(/\s+/g, ' ').trim().slice(0, 8000);

  // Try to extract image
  let imageUrl = null;
  const ogImage = $('meta[property="og:image"]').attr('content');
  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  const recipeImage = $('[itemtype*="Recipe"] img, [class*="recipe"] img').first().attr('src');
  const firstImg = $('article img, main img').first().attr('src');

  imageUrl = ogImage || twitterImage || recipeImage || firstImg || null;

  // Make absolute
  if (imageUrl && !imageUrl.startsWith('http')) {
    try {
      const base = new URL(url);
      imageUrl = new URL(imageUrl, base).href;
    } catch { imageUrl = null; }
  }

  const title = $('h1').first().text().trim() || $('title').text().trim() || '';

  return { text: mainContent, imageUrl, title };
}

async function downloadImage(imageUrl, recipeId) {
  try {
    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const contentType = resp.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const filename = `${recipeId ? recipeId + '_' + uuidv4() : uuidv4()}.${ext}`;
    const filepath = path.join(IMAGE_DIR, filename);

    fs.writeFileSync(filepath, resp.data);
    return `/images/${filename}`;
  } catch (e) {
    console.error('Image download failed:', e.message);
    return null;
  }
}

async function extractRecipeWithClaude(text, sourceTitle, url, categoryNames) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const categoryHint = (categoryNames && categoryNames.length)
    ? categoryNames.join('|')
    : 'Frühstück|Suppen|Salate|Hauptgericht|Pasta|Grillen|Backen|Kuchen & Dessert|Snacks|Getränke|Vegetarisch|Vegan';

  const prompt = `Du bist ein Rezept-Extraktor. Analysiere den folgenden Text von der Webseite "${url}" und extrahiere das Rezept als strukturiertes JSON.

Antworte NUR mit validem JSON, ohne Markdown-Backticks, ohne Erklärungen.

JSON-Struktur:
{
  "title": "Rezeptname",
  "description": "Kurze Beschreibung (1-2 Sätze)",
  "servings": 4,
  "prep_time": 15,
  "cook_time": 30,
  "difficulty": "einfach|mittel|schwer",
  "category": "eine der folgenden, EXAKT wie angegeben, oder leer wenn keine passt: ${categoryHint}",
  "ingredients": [
    { "amount": "200", "unit": "g", "name": "Mehl", "group": "" }
  ],
  "steps": [
    "Schritt 1 Beschreibung",
    "Schritt 2 Beschreibung"
  ],
  "tags": ["tag1", "tag2"],
  "notes": "Tipps oder Variationen"
}

Regeln:
- prep_time und cook_time in Minuten (Integer oder null)
- servings als Integer
- Zutatenmengen als String (z.B. "200", "1/2", "etwas")
- Einheiten normalisieren: g, kg, ml, l, TL, EL, Stück, Prise, etc.
- Tags: Zutaten-Tags, Anlass-Tags, Küchen-Tags (max 10)
- Bei "category": nur einen Namen aus der angegebenen Liste exakt übernehmen (Schreibweise beibehalten), niemals einen neuen Namen erfinden. Passt keiner wirklich, leeren String zurückgeben.
- Falls kein Rezept erkennbar: { "error": "Kein Rezept gefunden" }

Webseitentext:
${text}`;

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
    console.error('extractRecipeWithClaude: Antwort bei max_tokens abgeschnitten für Quelle:', sourceTitle || url);
    throw new Error('Rezept zu umfangreich für die Analyse in einem Durchgang.');
  }

  const rawText = resp.data.content[0].text.trim();
  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('extractRecipeWithClaude: Antwort konnte nicht als JSON geparst werden:', rawText);
    throw new Error('KI-Antwort konnte nicht ausgewertet werden');
  }
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

module.exports = { fetchPage, extractTextFromHtml, downloadImage, extractRecipeWithClaude };
