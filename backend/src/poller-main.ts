import { Pool } from "pg";
import type { PoolClient } from "pg";
import { loadConfig } from "./config.js";
import { makeDb } from "./db.js";
import { pollOneUser } from "./poller.js";
import { LibsodiumVault } from "./vault/libsodium.js";
import { makeApns } from "./apns.js";
import * as artwork from "./artwork.js";
import { spotify, refreshAccessToken } from "./providers/spotify.js";

const cfg = loadConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl });
const db = makeDb(pool);
const vault = new LibsodiumVault(cfg.encryptionKeyHex);
const apns = makeApns(cfg.apns);
const prevByDevice = new Map<string, any>();

let lockClient: PoolClient | null = null;
async function acquireLock(): Promise<boolean> {
  lockClient = await pool.connect();
  const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(987654321) AS got`);
  if (!rows[0].got) {
    lockClient.release();
    lockClient = null;
    return false;
  }
  return true; // hold the client for the process lifetime — do NOT release
}

async function tick() {
  const devices = await db.activeDevices();
  const now = Date.now();
  for (const device of devices) {
    try {
      const cur = await pollOneUser({
        device,
        vault,
        db,
        spotify,
        apns,
        artwork,
        refreshAccessToken,
        clientId: cfg.spotify.clientId,
        prev: prevByDevice.get(device.id) ?? null,
        now,
      });
      prevByDevice.set(device.id, cur);
    } catch (e) {
      console.error("poll error", device.id, e);
    }
  }
}

(async () => {
  if (!(await acquireLock())) {
    console.log("another poller holds the lock; exiting");
    process.exit(0);
  }
  setInterval(tick, 10_000);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
