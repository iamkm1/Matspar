import express from "express";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import cors from "cors";
import { fileURLToPath } from "url";
import { pool, migrate } from "./db.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FOODS_PATH = path.join(__dirname, "data", "foods.json");

/** Health */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/**
 * Lokal foods (autofullfør)
 * Forventer filstruktur fra Matvaretabellen:
 * {
 *   "foods": [
 *     { "foodId": "06.178", "foodName": "Adzukibønner, tørr", ... },
 *     ...
 *   ]
 * }
 */
app.get("/api/foods", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().toLowerCase();

    // Les og parse lokalt datasett
    const json = await fs.readFile(FOODS_PATH, "utf8");
    const parsed = JSON.parse(json);
    const foods = Array.isArray(parsed?.foods) ? parsed.foods : [];

    // Filtrer på navn, returner maks 15 treff
    const filtered = q
      ? foods.filter(f => (f?.foodName || "").toLowerCase().includes(q)).slice(0, 15)
      : foods.slice(0, 15);

    // Map til lettvektrespons for frontend
    const results = filtered.map(f => ({
      id: f.foodId ?? f.id ?? null,
      name: f.foodName ?? f.name ?? ""
    })).filter(x => x.name);

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Registrer inventory item
 * body: { email, productName, expirationDate(YYYY-MM-DD) }
 */
app.post("/api/inventory", async (req, res) => {
  const { email, productName, expirationDate } = req.body || {};
  if (!email || !productName || !expirationDate) {
    return res.status(400).json({ error: "email, productName og expirationDate er påkrevd" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert bruker
    let [uRes] = await conn.query(
      "INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
      [email]
    );
    const userId = uRes.insertId;

    // Upsert produkt
    let [pRes] = await conn.query(
      "INSERT INTO products (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
      [productName]
    );
    const productId = pRes.insertId;

    // Insert inventory
    let [iRes] = await conn.query(
      "INSERT INTO inventory_items (user_id, product_id, expiration_date) VALUES (?, ?, ?)",
      [userId, productId, expirationDate]
    );

    // Returner raden
    const [rows] = await conn.query(
      `SELECT ii.id, ii.user_id, ii.product_id, ii.expiration_date
         FROM inventory_items ii WHERE ii.id = ?`,
      [iRes.insertId]
    );

    await conn.commit();
    res.status(201).json(rows[0]);
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

/** Varsler: utgått eller utløper innen X dager (default 3) */
app.get("/api/alerts", async (req, res) => {
  const email = req.query.email?.toString();
  const days = Number(req.query.days || 3);
  if (!email) return res.status(400).json({ error: "email er påkrevd" });

  const sql = `
    SELECT ii.id, p.name, ii.expiration_date,
           CASE
             WHEN ii.expiration_date < CURDATE() THEN 'expired'
             WHEN ii.expiration_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY) THEN 'expiring'
             ELSE 'ok'
           END AS status
    FROM inventory_items ii
    JOIN users u ON u.id = ii.user_id
    JOIN products p ON p.id = ii.product_id
    WHERE u.email = ?
    ORDER BY ii.expiration_date ASC
  `;

  const [rows] = await pool.query(sql, [days, email]);
  res.json(rows.filter(r => r.status !== "ok"));
});

/** Start / migrer */
const arg = process.argv[2];
if (arg === "migrate") {
  migrate()
    .then(() => { console.log("Migrert OK"); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  app.listen(PORT, () => console.log(`Server på http://localhost:${PORT}`));
}
