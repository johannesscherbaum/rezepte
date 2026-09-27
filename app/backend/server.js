const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { initDb } = require('./db');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const recipeRoutes = require('./routes/recipes');
const miscRoutes = require('./routes/misc');
const scheduleRoutes = require('./routes/schedule');
const pdfImportRoutes = require('./routes/pdfImport');
const photoImportRoutes = require('./routes/photoImport');
const markdownImportRoutes = require('./routes/markdownImport');
const imageSearchRoutes = require('./routes/imageSearch');
const ratingRoutes = require('./routes/rating');
const imageCleanupRoutes = require('./routes/imageCleanup');
const bulkRoutes = require('./routes/bulk');
const groupsRoutes = require('./routes/groups');

const app = express();
const PORT = process.env.PORT || 3000;
const IMAGE_DIR = process.env.IMAGE_DIR || '/data/images';

// Notwendig hinter dem Synology-Reverse-Proxy, sonst meldet express-rate-limit
// einen ERR_ERL_UNEXPECTED_X_FORWARDED_FOR-Fehler bei jedem Login-Request.
app.set('trust proxy', 1);


// Sicherheitsnetz: ein unbehandelter Fehler in einem async-Route-Handler
// (z.B. ein DB-Constraint-Fehler ohne try/catch) darf nicht den ganzen
// Prozess beenden, sondern soll nur geloggt werden. Das behebt die eigentliche
// Fehlerquelle nicht, verhindert aber, dass ein einzelner Bug die App
// komplett lahmlegt.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (Prozess bleibt am Leben):', reason);
});

if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Rate limiting for auth
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, validate: { xForwardedForHeader: false } }));

// Static files
app.use(express.static(path.join(__dirname, 'frontend/public')));
app.use('/images', express.static(IMAGE_DIR));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/recipes', bulkRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/recipes', pdfImportRoutes);
app.use('/api/recipes', photoImportRoutes);
app.use('/api/recipes', markdownImportRoutes);
app.use('/api', imageSearchRoutes);
app.use('/api/recipes', ratingRoutes);
app.use('/api/admin', imageCleanupRoutes);
app.use('/api', miscRoutes);
app.use('/api/recipes/:recipeId/schedule', scheduleRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Interner Fehler' });
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/cook/')) {
    return res.sendFile(path.join(__dirname, 'frontend/public/cook.html'));
  }
  res.sendFile(path.join(__dirname, 'frontend/public/index.html'));
});

async function start() {
  // Wait for DB
  let retries = 10;
  while (retries > 0) {
    try {
      await initDb();

      // Create default admin if no users exist
      const { pool } = require('./db');
      const bcrypt = require('bcryptjs');
      const { rows } = await pool.query('SELECT COUNT(*) as c FROM users');
      if (parseInt(rows[0].c) === 0) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
        await pool.query(
          "INSERT INTO users (username, email, password_hash, role) VALUES ('admin', 'admin@local', $1, 'admin')",
          [hash]
        );
        console.log('Standard-Admin erstellt: admin / ' + (process.env.ADMIN_PASSWORD || 'admin123'));
        console.log('Bitte Passwort sofort ändern!');
      }
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      console.log(`DB nicht bereit, warte 3s... (${retries} Versuche übrig)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Rezepte-App läuft auf Port ${PORT}`);
  });
}

start().catch(console.error);
