import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- DB (Railway MySQL env vars) ----------
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: process.env.MYSQLPORT,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, "foods.json");
const indexPath = path.join(__dirname, "foods.index.json");
const publicPath = path.join(__dirname, "public");

// ---------- Indeks (robust mot forskjellige JSON-varianter) ----------
function normalizeFoods(json) {
  const arr = Array.isArray(json) ? json : (json.foods || json.data || []);
  return arr.map((f) => {
    const foodId =
      f.foodId ?? f.id ?? f.code ?? f.foodcode ?? f.FoodId ?? f.FOOD_ID ?? String(Math.random());
    const name =
      f.foodName ?? f.displayName ?? f.name ?? f.title ?? f.FoodName ?? f.matvare ?? "Ukjent";
    const keywordsArr = f.searchKeywords ?? f.keywords ?? f.searchTerms ?? f.tags ?? [];
    const keywords = Array.isArray(keywordsArr) ? keywordsArr.join(" ") : String(keywordsArr || "");
    return { foodId: String(foodId), name: String(name), keywords: String(keywords) };
  });
}

function buildIndex() {
  if (!fs.existsSync(dataPath)) {
    console.error("❌ Mangler foods.json i server/-mappen!");
    return [];
  }
  let json;
  try {
    const rawText = fs.readFileSync(dataPath, "utf8");
    json = JSON.parse(rawText);
  } catch (e) {
    console.error("❌ Klarte ikke parse foods.json:", e.message);
    return [];
  }
  const items = normalizeFoods(json).filter((x) => x.name && x.foodId);
  fs.writeFileSync(indexPath, JSON.stringify(items));
  console.log(`🔎 Indeks generert: ${items.length} varer`);
  return items;
}

let INDEX = [];
function ensureIndex() {
  try {
    if (fs.existsSync(indexPath)) {
      const txt = fs.readFileSync(indexPath, "utf8");
      INDEX = JSON.parse(txt);
      if (!Array.isArray(INDEX) || INDEX.length === 0) INDEX = buildIndex();
    } else {
      INDEX = buildIndex();
    }
  } catch {
    INDEX = buildIndex();
  }
}

// ---------- API ----------
app.get("/api/foods", (req, res) => {
  ensureIndex();
  const q = (req.query.q || "").toString().toLowerCase();
  if (!q) return res.json(INDEX.slice(0, 50));
  const terms = q.split(/\s+/).filter(Boolean);
  const results = INDEX.filter((f) => {
    const hay = `${f.name} ${f.keywords}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }).slice(0, 50);
  res.json(results);
});

app.post("/api/items", async (req, res) => {
  const { userId = null, foodId, name, quantity = 1, expirationDate } = req.body;
  if (!foodId || !name || !expirationDate) {
    return res.status(400).json({ error: "foodId, name og expirationDate er påkrevd" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert produkt
    const [prod] = await conn.execute(
      `INSERT INTO products (food_id, name)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
      [foodId, name]
    );
    const productId = prod.insertId;

    // Legg til inventory item
    const [item] = await conn.execute(
      `INSERT INTO inventory_items (user_id, product_id, quantity, expiration_date)
       VALUES (?, ?, ?, ?)`,
      [userId, productId, quantity, expirationDate]
    );

    await conn.commit();
    res.json({ ok: true, itemId: item.insertId });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "DB-feil" });
  } finally {
    conn.release();
  }
});

app.get("/api/items", async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ii.id, p.name, ii.quantity, DATE_FORMAT(ii.expiration_date, '%Y-%m-%d') AS expiration_date
       FROM inventory_items ii
       JOIN products p ON p.id = ii.product_id
       ORDER BY ii.expiration_date ASC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil" });
  }
});

// Debug (valgfritt): se hvor mange varer i indeksen
app.get("/api/debug/foods-count", (_req, res) => {
  ensureIndex();
  res.json({ count: Array.isArray(INDEX) ? INDEX.length : 0 });
});

// ---------- Serve frontend ----------
app.use(express.static(publicPath));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Matspar (MySQL) kjører på port ${PORT}`));
