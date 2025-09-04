import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

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

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

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

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ error: "Mangler token" });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.userId = payload.uid;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Ugyldig/utløpt token" });
  }
}

// ---------- Auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email og password er påkrevd" });
  const conn = await pool.getConnection();
  try {
    const hash = await bcrypt.hash(password, 10);
    await conn.execute(`INSERT INTO users (email, password_hash) VALUES (?, ?)`, [email, hash]);
    const [rows] = await conn.execute(`SELECT id, email FROM users WHERE email = ?`, [email]);
    const user = rows[0];
    const token = signToken(user);
    res.json({ ok: true, token, user });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "E-post er allerede registrert" });
    } else {
      console.error(e);
      res.status(500).json({ error: "DB-feil ved registrering" });
    }
  } finally {
    conn.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email og password er påkrevd" });
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(`SELECT id, email, password_hash FROM users WHERE email = ?`, [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Feil e-post eller passord" });
    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Feil e-post eller passord" });
    const token = signToken(user);
    res.json({ ok: true, token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil ved innlogging" });
  } finally {
    conn.release();
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  res.json({ ok: true, user: { id: req.userId, email: req.userEmail } });
});

// ---------- Matvare-søk ----------
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
  const contains = withHay.filter(f =>
    !starts.includes(f) && terms.every(t => f._hay.includes(t))
  );

  const results = [...starts, ...contains].slice(0, 50).map(({ _hay, _nameNorm, ...rest }) => rest);
  res.json(results);
});

// ---------- Inventory ----------
app.post("/api/items", auth, async (req, res) => {
  const { foodId, name, quantity = 1, expirationDate } = req.body || {};
  if (!foodId || !name || !expirationDate) {
    return res.status(400).json({ error: "foodId, name og expirationDate er påkrevd" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [prod] = await conn.execute(
      `INSERT INTO products (name)
       VALUES (?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [name]
    );
    // NB: hvis du har unik constraint på name — hvis ikke, anbefalt å ha food_id i products
    const productId = prod.insertId || (await conn.execute(`SELECT id FROM products WHERE name = ?`, [name]))[0][0]?.id;

    const [item] = await conn.execute(
      `INSERT INTO inventory_items (user_id, product_id, quantity, expiration_date)
       VALUES (?, ?, ?, ?)`,
      [req.userId, productId, quantity, expirationDate]
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

app.get("/api/items", auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ii.id, p.name, ii.quantity,
              DATE_FORMAT(ii.expiration_date, '%Y-%m-%d') AS expiration_date
       FROM inventory_items ii
       JOIN products p ON p.id = ii.product_id
       WHERE ii.user_id = ?
       ORDER BY ii.expiration_date ASC
       LIMIT 200`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil" });
  }
});

// Oppdater vare (antall og/eller utløpsdato)
app.put("/api/items/:id", auth, async (req, res) => {
  const { id } = req.params;
  let { quantity, expirationDate } = req.body || {};

  if (quantity === undefined && !expirationDate) {
    return res.status(400).json({ error: "Mangler felt å oppdatere" });
  }

  // enkel validering av YYYY-MM-DD
  if (expirationDate) {
    const t = String(expirationDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return res.status(400).json({ error: "Dato må være YYYY-MM-DD" });
    }
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

    values.push(id, req.userId);

    const [result] = await conn.execute(
      `UPDATE inventory_items SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
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
app.delete("/api/items/:id", auth, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `DELETE FROM inventory_items WHERE id = ? AND user_id = ?`,
      [id, req.userId]
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
app.listen(PORT, () => console.log(`✅ Matspar (MySQL + auth) kjører på port ${PORT}`));
