import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import pg from 'pg';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

// ---- DB ----
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false
});

// Lager tabeller automatisk ved oppstart (ingen CLI nødvendig)
async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        food_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1,
        expiration_date DATE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_exp ON inventory_items(expiration_date);
    `);
    console.log('✅ Tabeller ok');
  } finally {
    client.release();
  }
}

// ---- Paths + indeks ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, 'foods.json');
const indexPath = path.join(__dirname, 'foods.index.json');

function buildIndex() {
  if (!fs.existsSync(dataPath)) {
    console.error('❌ Mangler server/foods.json – legg den i repoet.');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const items = (raw.foods || []).map(f => ({
    foodId: f.foodId,
    name: f.foodName,
    keywords: (f.searchKeywords || []).join(' ')
  }));
  fs.writeFileSync(indexPath, JSON.stringify(items));
  console.log(`🔎 Indeks generert: ${items.length} varer`);
}

let INDEX = [];
function ensureIndexLoaded() {
  if (!fs.existsSync(indexPath)) buildIndex();     // bygg ved behov
  if (INDEX.length === 0 && fs.existsSync(indexPath)) {
    INDEX = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
}

// ---- API ----
app.get('/api/foods', (req, res) => {
  ensureIndexLoaded();
  if (INDEX.length === 0) return res.status(500).json({ error: 'Indeks mangler' });

  const q = (req.query.q || '').toString().toLowerCase();
  if (!q) return res.json(INDEX.slice(0, 50));
  const terms = q.split(/\s+/).filter(Boolean);
  const results = INDEX.filter(f => {
    const hay = `${f.name} ${f.keywords}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  }).slice(0, 50);
  res.json(results);
});

app.post('/api/items', async (req, res) => {
  const { userId = null, foodId, name, quantity = 1, expirationDate } = req.body;
  if (!foodId || !name || !expirationDate) {
    return res.status(400).json({ error: 'foodId, name og expirationDate er påkrevd' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upsert = await client.query(
      `INSERT INTO products (food_id, name)
       VALUES ($1, $2)
       ON CONFLICT (food_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [foodId, name]
    );
    const productId = upsert.rows[0].id;

    const ins = await client.query(
      `INSERT INTO inventory_items (user_id, product_id, quantity, expiration_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [userId, productId, quantity, expirationDate]
    );

    await client.query('COMMIT');
    res.json({ ok: true, itemId: ins.rows[0].id, createdAt: ins.rows[0].created_at });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'DB-feil' });
  } finally {
    client.release();
  }
});

app.get('/api/items', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT ii.id, p.name, ii.quantity, ii.expiration_date
     FROM inventory_items ii
     JOIN products p ON p.id = ii.product_id
     ORDER BY ii.expiration_date ASC
     LIMIT 100`
  );
  res.json(rows);
});

// ---- Serve frontend ----
const webPath = path.join(__dirname, '../web');
app.use(express.static(webPath));

// ---- Start ----
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await ensureTables();       // <- lager tabeller automatisk
    ensureIndexLoaded();        // <- bygger/leser indeks automatisk
    app.listen(PORT, () => console.log(`✅ Matspar kjører på port ${PORT}`));
  } catch (e) {
    console.error('Oppstart feilet:', e);
    process.exit(1);
  }
})();
