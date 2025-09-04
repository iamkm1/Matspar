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

// ---------- Indeks (robust parse) ----------
function normalizeFoods(json) {
  const arr = Array.isArray(json) ? json : (json.foods || json.data || []);
  return arr.map((f) => {
    const foodId = f.foodId ?? f.id ?? f.code ?? String(Math.random());
    const name = f.foodName ?? f.displayName ?? f.name ?? f.title ?? "Ukjent";
    const keywordsArr = f.searchKeywords ?? f.keywords ?? [];
    const keywords = Array.isArray(keywordsArr) ? keywordsArr.join(" ") : String(keywordsArr || "");
    return { foodId: String(foodId), name: String(name), keywords: String(keywords) };
  });
}
function buildIndex() {
  if (!fs.existsSync(dataPath)) {
    console.error("❌ Mangler foods.json i server/-mappen!");
    return [];
  }
  try {
    const rawText = fs.readFileSync(dataPath, "utf8");
    const json = JSON.parse(rawText);
    const items = normalizeFoods(json).filter((x) => x.name && x.foodId);
    fs.writeFileSync(indexPath, JSON.stringify(items));
    console.log(`🔎 Indeks generert: ${items.length} varer`);
    return items;
  } catch (e) {
    console.error("❌ Klarte ikke parse/generere indeks:", e.message);
    return [];
  }
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

// --- Normalisering for søk (diakritikk + æ/ø/å) ---
function norm(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/œ/g, "oe").replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
}

// ---------- API ----------

// Søk/autoforslag
app.get("/api/foods", (req, res) => {
  ensureIndex();
  const raw = (req.query.q ?? "").toString().trim();
  const q = norm(raw);
  if (!q) return res.json(INDEX.slice(0, 50));

  const withHay = INDEX.map(f => {
    const hay = norm(`${f.name} ${f.keywords}`);
    return { ...f, _hay: hay, _nameNorm: norm(f.name) };
  });
  const terms = q.split(/\s+/).filter(Boolean);

  const starts = withHay.filter(f => terms.every(t => f._nameNorm.startsWith(t)));
  const contains = withHay.filter(f => !starts.includes(f) && terms.every(t => f._hay.includes(t)));

  const results = [...starts, ...contains].slice(0, 50).map(({ _hay, _nameNorm, ...rest }) => rest);
  res.json(results);
});

// Opprett vare
app.post("/api/items", async (req, res) => {
  const { userId = null, foodId, name, quantity = 1, expirationDate } = req.body;
  if (!foodId || !name || !expirationDate) {
    return res.status(400).json({ error: "foodId, name og expirationDate er påkrevd" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [prod] = await conn.execute(
      `INSERT INTO products (food_id, name)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)`,
      [foodId, name]
    );
    const productId = prod.insertId;

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

// Hent varer
app.get("/api/items", async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ii.id, p.name, ii.quantity,
              DATE_FORMAT(ii.expiration_date, '%Y-%m-%d') AS expiration_date
       FROM inventory_items ii
       JOIN products p ON p.id = ii.product_id
       ORDER BY ii.expiration_date ASC
       LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil" });
  }
});

// Oppdater vare (antall og/eller utløpsdato)
app.put("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  const { quantity, expirationDate } = req.body;

  if (quantity === undefined && !expirationDate) {
    return res.status(400).json({ error: "Mangler felt å oppdatere" });
  }

  // valider datoformat YYYY-MM-DD hvis sendt inn
  if (expirationDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(expirationDate))) {
    return res.status(400).json({ error: "Dato må være YYYY-MM-DD" });
  }

  const conn = await pool.getConnection();
  try {
    const fields = [];
    const values = [];

    if (quantity !== undefined) {
      if (Number.isNaN(Number(quantity))) {
        return res.status(400).json({ error: "quantity må være et tall" });
      }
      fields.push("quantity = ?");
      values.push(Number(quantity));
    }
    if (expirationDate) {
      fields.push("expiration_date = ?");
      values.push(expirationDate);
    }

    values.push(id);

    const [result] = await conn.execute(
      `UPDATE inventory_items SET ${fields.join(", ")} WHERE id = ?`,
      values
    );

    res.json({ ok: true, updated: result.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil ved oppdatering" });
  } finally {
    conn.release();
  }
});

// Slett vare
app.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `DELETE FROM inventory_items WHERE id = ?`,
      [id]
    );
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil ved sletting" });
  } finally {
    conn.release();
  }
});

// ---------- Serve frontend ----------
app.use(express.static(publicPath));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Matspar (MySQL) kjører på port ${PORT}`));
