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
// An idle-client connection drop emits an 'error' on the Pool; without a listener
// Node would crash the process. Log and continue.
pool.on("error", (e) => console.error("pg pool error", e));
const db = makeDb(pool);
const vault = new LibsodiumVault(cfg.encryptionKeyHex);
const apns = makeApns(cfg.apns);
const prevByDevice = new Map<string, any>();
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

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

// Guard against overlapping ticks: setInterval does not await tick, so a tick that
// runs longer than the interval would otherwise re-enter and double-poll.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
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
          accessTokenCache,
        });
        prevByDevice.set(device.id, cur);
      } catch (e) {
        console.error("poll error", device.id, e);
      }
    }
  } finally {
    ticking = false;
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
