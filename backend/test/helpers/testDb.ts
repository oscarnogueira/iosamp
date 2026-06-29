import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeDb } from "../../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function makeTestDb() {
  const mem = newDb();

  // pg-mem does not ship gen_random_uuid() by default — register it manually
  mem.adapters.db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
  });

  // Get a pg-compatible Pool from the in-memory adapter
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  // Run the real migration SQL.
  // Note: pg-mem supports partial indexes (WHERE clause) as of v3, so no
  // workaround is needed for `CREATE INDEX idx_devices_active ON devices(active) WHERE active`.
  const sqlPath = join(__dirname, "../../migrations/001_init.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  await pool.query(sql);

  return makeDb(pool as never);
}
