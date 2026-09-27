const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rezepte',
  user: process.env.DB_USER || 'rezepte',
  password: process.env.DB_PASSWORD || 'rezepte_pass',
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Migration: can_evernote Flag
      ALTER TABLE users ADD COLUMN IF NOT EXISTS can_evernote BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'sage';

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('admin','readwrite','readonly')),
        totp_secret TEXT,
        totp_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        icon TEXT DEFAULT '🍽️',
        color TEXT DEFAULT '#7c6af7',
        recipe_count INTEGER DEFAULT 0,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS recipes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        servings INTEGER DEFAULT 4,
        prep_time INTEGER,
        cook_time INTEGER,
        difficulty TEXT DEFAULT 'mittel' CHECK (difficulty IN ('einfach','mittel','schwer')),
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        source_url TEXT,
        image_path TEXT,
        image_url TEXT,
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        is_public BOOLEAN DEFAULT FALSE
      );
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 1 AND 5);
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS to_try BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS ingredients (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        amount TEXT,
        unit TEXT,
        name TEXT NOT NULL,
        group_name TEXT,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS steps (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tags (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        tag_type TEXT DEFAULT 'general' CHECK (tag_type IN ('general','ingredient','cuisine','occasion')),
        usage_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS recipe_tags (
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (recipe_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS evernote_notebooks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS evernote_notes (
        id SERIAL PRIMARY KEY,
        notebook_id INTEGER REFERENCES evernote_notebooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT,
        content_plain TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        source_url TEXT
      );
      ALTER TABLE evernote_notes ADD COLUMN IF NOT EXISTS imported_recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL;
      CREATE TABLE IF NOT EXISTS evernote_note_images (
        id SERIAL PRIMARY KEY,
        note_id INTEGER REFERENCES evernote_notes(id) ON DELETE CASCADE,
        image_path TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS evernote_note_tags (
        note_id INTEGER REFERENCES evernote_notes(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_recipes_category ON recipes(category_id);
      CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id);
      CREATE INDEX IF NOT EXISTS idx_steps_recipe ON steps(recipe_id);
      CREATE INDEX IF NOT EXISTS idx_recipe_tags_recipe ON recipe_tags(recipe_id);
      CREATE INDEX IF NOT EXISTS idx_recipe_tags_tag ON recipe_tags(tag_id);

      CREATE TABLE IF NOT EXISTS schedule_steps (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        sort_order INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_recipe ON schedule_steps(recipe_id);

      CREATE TABLE IF NOT EXISTS step_images (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        image_path TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(recipe_id, step_number)
      );

      CREATE INDEX IF NOT EXISTS idx_step_images_recipe ON step_images(recipe_id);

      CREATE TABLE IF NOT EXISTS recipe_images (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        image_path TEXT NOT NULL,
        caption TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recipe_images_recipe ON recipe_images(recipe_id);

      CREATE TABLE IF NOT EXISTS recipe_nutrition (
        recipe_id INTEGER PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
        calories NUMERIC,
        protein NUMERIC,
        fat NUMERIC,
        carbs NUMERIC,
        fiber NUMERIC,
        calculated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE recipe_nutrition ADD COLUMN IF NOT EXISTS total_weight_g NUMERIC;

      -- Multi-Tenancy: Gruppen
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        group_role TEXT NOT NULL DEFAULT 'readonly' CHECK (group_role IN ('group_admin', 'readwrite', 'readonly')),
        PRIMARY KEY (group_id, user_id)
      );

      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS recipe_shares (
        recipe_id INTEGER REFERENCES recipes(id) ON DELETE CASCADE,
        target_group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        shared_at TIMESTAMPTZ DEFAULT NOW(),
        shared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        PRIMARY KEY (recipe_id, target_group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_recipes_group ON recipes(group_id);
      CREATE INDEX IF NOT EXISTS idx_categories_group ON categories(group_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_recipe_shares_target ON recipe_shares(target_group_id);

      ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      -- Migration: globale Rollen auf admin/member vereinfachen
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      UPDATE users SET role = 'member' WHERE role NOT IN ('admin', 'member');
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'));
      ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';

      -- Migration: Standard-Gruppe anlegen und alle Daten zuordnen
      INSERT INTO groups (name, slug) VALUES ('Standard', 'standard') ON CONFLICT (slug) DO NOTHING;
      UPDATE recipes SET group_id = (SELECT id FROM groups WHERE slug = 'standard') WHERE group_id IS NULL;
      UPDATE categories SET group_id = (SELECT id FROM groups WHERE slug = 'standard') WHERE group_id IS NULL;
      -- Nur User ohne jegliche Gruppenzugehörigkeit in Standard aufnehmen
      INSERT INTO group_members (group_id, user_id, group_role)
      SELECT
        (SELECT id FROM groups WHERE slug = 'standard'),
        u.id,
        CASE u.role WHEN 'admin' THEN 'group_admin' ELSE 'readonly' END
      FROM users u
      WHERE u.id NOT IN (SELECT user_id FROM group_members)
      ON CONFLICT (group_id, user_id) DO NOTHING;
      -- Cleanup: Standard-Mitgliedschaft entfernen wenn User bereits in anderer Gruppe
      DELETE FROM group_members
      WHERE group_id = (SELECT id FROM groups WHERE slug = 'standard')
        AND user_id IN (
          SELECT user_id FROM group_members
          WHERE group_id != (SELECT id FROM groups WHERE slug = 'standard')
        );

      INSERT INTO categories (name, slug, icon, color) VALUES
        ('Frühstück', 'fruehstueck', '🥐', '#f59e0b'),
        ('Suppen', 'suppen', '🍲', '#ef4444'),
        ('Salate', 'salate', '🥗', '#22c55e'),
        ('Hauptgericht', 'hauptgericht', '🍽️', '#7c6af7'),
        ('Pasta', 'pasta', '🍝', '#f97316'),
        ('Grillen', 'grillen', '🔥', '#dc2626'),
        ('Backen', 'backen', '🥖', '#a16207'),
        ('Kuchen & Dessert', 'dessert', '🎂', '#ec4899'),
        ('Snacks', 'snacks', '🧆', '#06b6d4'),
        ('Getränke', 'getraenke', '🥤', '#8b5cf6'),
        ('Vegetarisch', 'vegetarisch', '🌿', '#16a34a'),
        ('Vegan', 'vegan', '🌱', '#15803d')
      ON CONFLICT (slug) DO NOTHING;

      -- Kategoriename muss nicht global eindeutig sein (jede Gruppe hat eigene Kategorien)
      ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;

      -- Migration: Standardkategorien für Gruppen ohne Kategorien nachfüllen
      DO $$
      DECLARE g RECORD;
      BEGIN
        FOR g IN SELECT id FROM groups WHERE id NOT IN (SELECT DISTINCT group_id FROM categories WHERE group_id IS NOT NULL) LOOP
          INSERT INTO categories (name, slug, icon, color, group_id) VALUES
            ('Frühstück',       'fruehstueck-g'||g.id,  '🥐', '#f59e0b', g.id),
            ('Suppen',          'suppen-g'||g.id,        '🍲', '#ef4444', g.id),
            ('Salate',          'salate-g'||g.id,        '🥗', '#22c55e', g.id),
            ('Hauptgericht',    'hauptgericht-g'||g.id,  '🍽️', '#7c6af7', g.id),
            ('Pasta',           'pasta-g'||g.id,         '🍝', '#f97316', g.id),
            ('Grillen',         'grillen-g'||g.id,       '🔥', '#dc2626', g.id),
            ('Backen',          'backen-g'||g.id,        '🥖', '#a16207', g.id),
            ('Kuchen & Dessert','dessert-g'||g.id,       '🎂', '#ec4899', g.id),
            ('Snacks',          'snacks-g'||g.id,        '🧆', '#06b6d4', g.id),
            ('Getränke',        'getraenke-g'||g.id,     '🥤', '#8b5cf6', g.id),
            ('Vegetarisch',     'vegetarisch-g'||g.id,   '🌿', '#16a34a', g.id),
            ('Vegan',           'vegan-g'||g.id,         '🌱', '#15803d', g.id)
          ON CONFLICT (slug) DO NOTHING;
        END LOOP;
      END $$;
    `);
    console.log('Datenbank initialisiert');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
