import dotenv from "dotenv";
dotenv.config();
import mysql from "mysql2/promise";
import fs from "fs";

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 10,
  multipleStatements: true
});

export async function migrate() {
  const sql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const conn = await pool.getConnection();
  try {
    await conn.query(sql);
  } finally {
    conn.release();
  }
}
