import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";
import crypto from "crypto";
import cookie from "cookie";

const app = express();
app.use(cors());
app.use(express.json());
app.set("trust proxy", true); // Railway bruker proxy

// ---------- DB ----------
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

// ---------- Indeks ----------
function normalizeFoods(json) {
  const arr = Array.isArray(json) ? json : (json.foods || json.data || []);
  return arr.map((f) => {
    const foodId =
      f.foodId ?? f.id ?? f.code ?? String(Math.random());
    const name =
      f.foodName ?? f.displayName ?? f.name ?? f.title ?? "Ukjent";
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

// ---------- Device middleware ----------
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function getClientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xff || req.ip || "";
}

app.use(async (req, res, next) => {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    let deviceId = cookies.matspar_device;

    const clientIp = getClientIp(req);
    const ipHash = clientIp ? sha256(clientIp) : null;
    const ua = req.headers["user-agent"] || "";

    const conn = await pool.getConnection();

    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await conn.execute(
        `INSERT INTO devices (device_id, ip_hash, user_agent) VALUES (?, ?, ?)`,
        [deviceId, ipHash, ua]
      );
      res.setHeader("Set-Cookie", cookie.serialize("matspar_device", deviceId, {
        httpOnly: false,
        sameSite: "Lax",
        secure: true,
        path: "/",
        maxAge: 60 * 60 * 24 * 400
      }));
    } else {
      await conn.execute(
        `UPDATE devices SET last_seen = CURRENT_TIMESTAMP, ip_hash = COALESCE(?, ip_hash)
         WHERE device_id = ?`,
        [ipHash, deviceId]
      );
    }

    req.deviceId = deviceId;
    conn.release();
    next();
  } catch (e) {
    console.error("device middleware error:", e);
    next();
  }
});

// ---------- API ----------
app.get("/api/foods", (req, res) => {
  ensureIndex();
  const raw = (req.query.q ?? "").toString().trim().toLowerCase();
  if (!raw) return res.json(INDEX.slice(0, 50));

  const norm = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = norm(raw);
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
    const deviceId = req.deviceId || null;

    const [item] = await conn.execute(
      `INSERT INTO inventory_items (user_id, product_id, quantity, expiration_date, device_id)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, productId, quantity, expirationDate, deviceId]
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

app.get("/api/items", async (req, res) => {
  try {
    const deviceId = req.deviceId || null;
    const params = [];
    let where = "";
    if (deviceId) { where = "WHERE ii.device_id = ?"; params.push(deviceId); }

    const [rows] = await pool.execute(
      `SELECT ii.id, p.name, ii.quantity,
              DATE_FORMAT(ii.expiration_date, '%Y-%m-%d') AS expiration_date
       FROM inventory_items ii
       JOIN products p ON p.id = ii.product_id
       ${where}
       ORDER BY ii.expiration_date ASC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB-feil" });
  }
});

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
app.listen(PORT, () => console.log(`✅ Matspar (MySQL + device) kjører på port ${PORT}`));
