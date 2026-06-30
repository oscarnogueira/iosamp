import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(dir, "..", "migrations");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await pool.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [f]);
    if (done.rowCount) {
      console.log("skip", f);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
      await client.query("COMMIT");
      console.log("applied", f);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
