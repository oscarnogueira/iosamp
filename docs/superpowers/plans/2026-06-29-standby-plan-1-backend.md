# StandBy Now-Playing — Plan 1: Backend (Node/TS on Fly.io)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend that authenticates users (Sign in with Apple → session JWT), stores per-user Spotify refresh tokens encrypted at rest, polls Spotify for active users every 10s, and pushes Live Activity updates + silent art-wake pushes via APNs.

**Architecture:** Two Fly processes from one image — an **API server** (Fastify HTTP) and a **single-instance poller**. Postgres (managed) holds users/tokens/devices; secrets live in Fly Secrets. A `MusicProvider` interface isolates Spotify; a `TokenVault` interface isolates encryption (libsodium today, KMS later). All business logic is unit-tested with Vitest + mocked HTTP (`nock`/`undici` MockAgent); APNs and Spotify are never hit live in tests.

**Tech Stack:** Node 20, TypeScript, Fastify, `pg` (node-postgres), `libsodium-wrappers`, `jsonwebtoken`, `jose` (Apple token verification), Vitest, `undici` MockAgent, Fly.io.

**Spec:** `docs/superpowers/specs/2026-06-29-standby-spotify-nowplaying-design.md`

**Depends on:** Plan 0 spike verdicts (especially APNs topic strings + silent-wake reliability) should be folded in before deploying.

---

## File Structure

```
backend/
  package.json, tsconfig.json, vitest.config.ts
  fly.toml                          # [processes] api + poller
  Dockerfile
  drizzle/ or migrations/           # SQL migrations
  src/
    config.ts                       # env loading + validation
    db.ts                           # pg pool + typed queries
    vault/
      vault.ts                      # TokenVault interface
      libsodium.ts                  # LibsodiumVault impl
    auth/
      apple.ts                      # verify Apple identity token
      session.ts                    # issue/verify backend session JWT
    providers/
      types.ts                      # MusicProvider, NowPlaying, ControlAction
      registry.ts                   # provider registry
      spotify.ts                    # OAuth exchange/refresh, getNowPlaying, control
    artwork.ts                      # fetch art, extract dominantColor hex
    apns.ts                         # JWT signing, liveactivity + silent push, 410 handling
    poller.ts                       # changed(), poll-one-user, active-set logic
    routes.ts                       # Fastify route registration (incl. GET /nowplaying/current seed)
    server.ts                       # API process entrypoint
    poller-main.ts                  # poller process entrypoint (advisory lock)
  test/                             # mirrors src/
```

---

## Task 1: Project scaffold + config

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`
- Create: `backend/src/config.ts`
- Test: `backend/test/config.test.ts`

- [ ] **Step 1: Scaffold**

```bash
mkdir -p backend/src backend/test && cd backend
npm init -y
npm pkg set type=module            # REQUIRED: nodenext ESM + .js specifiers + import.meta.url
npm i fastify pg libsodium-wrappers jsonwebtoken jose undici sharp
npm i -D typescript vitest @types/node @types/jsonwebtoken @types/pg tsx pg-mem
npx tsc --init --module nodenext --target es2022 --moduleResolution nodenext --outDir dist
npm pkg set scripts.migrate="node --import tsx scripts/migrate.ts"   # prod migration runner
```

> `scripts/migrate.ts` connects with `DATABASE_URL`, ensures a `schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())` table, then applies each `migrations/*.sql` not already recorded, inside a transaction, and records it. This makes re-deploys safe even though `001_init.sql` uses plain `CREATE TABLE` (each file runs at most once). Run on deploy via the Fly `release_command`.

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", globals: true } });
```

- [ ] **Step 2: Write the failing test for config validation**

```ts
// test/config.test.ts
import { loadConfig } from "../src/config.js";
test("throws when a required secret is missing", () => {
  expect(() => loadConfig({})).toThrow(/SPOTIFY_CLIENT_ID/);
});
test("loads all required secrets", () => {
  const env = {
    SPOTIFY_CLIENT_ID: "x", SPOTIFY_REDIRECT_URI: "standbynp://cb",
    APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_BUNDLE_ID: "b", APNS_P8: "p8",
    ENCRYPTION_KEY: "0".repeat(64), DATABASE_URL: "postgres://x",
    APPLE_CLIENT_ID: "com.x.app", SESSION_SECRET: "s",
  };
  expect(loadConfig(env).spotify.clientId).toBe("x");
});
```

- [ ] **Step 3: Run it (expect FAIL)** — `npx vitest run test/config.test.ts` → FAIL (no module).

- [ ] **Step 4: Implement `config.ts`**

```ts
// src/config.ts
export interface Config {
  spotify: { clientId: string; redirectUri: string };
  apns: { keyId: string; teamId: string; bundleId: string; p8: string; host: string };
  apple: { clientId: string };
  encryptionKeyHex: string;
  sessionSecret: string;
  databaseUrl: string;
}
const REQUIRED = ["SPOTIFY_CLIENT_ID","SPOTIFY_REDIRECT_URI","APNS_KEY_ID",
  "APNS_TEAM_ID","APNS_BUNDLE_ID","APNS_P8","ENCRYPTION_KEY","DATABASE_URL",
  "APPLE_CLIENT_ID","SESSION_SECRET"] as const;
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const k of REQUIRED) if (!env[k]) throw new Error(`Missing required secret: ${k}`);
  return {
    spotify: { clientId: env.SPOTIFY_CLIENT_ID!, redirectUri: env.SPOTIFY_REDIRECT_URI! },
    apns: { keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID!, bundleId: env.APNS_BUNDLE_ID!, p8: env.APNS_P8!,
            host: env.APNS_HOST ?? "https://api.development.push.apple.com" },  // prod: api.push.apple.com
    apple: { clientId: env.APPLE_CLIENT_ID! },
    encryptionKeyHex: env.ENCRYPTION_KEY!,
    sessionSecret: env.SESSION_SECRET!,
    databaseUrl: env.DATABASE_URL!,
  };
}
```

- [ ] **Step 5: Run it (expect PASS)** — `npx vitest run test/config.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/ && git commit -m "feat(backend): scaffold + config validation"
```

---

## Task 2: TokenVault (libsodium)

**Files:**
- Create: `backend/src/vault/vault.ts`, `backend/src/vault/libsodium.ts`
- Test: `backend/test/vault.test.ts`

- [ ] **Step 1: Failing test — round-trip + wrong-key failure**

```ts
// test/vault.test.ts
import { LibsodiumVault } from "../src/vault/libsodium.js";
const key = "a".repeat(64);          // 32 bytes hex
test("seal then open returns the plaintext", async () => {
  const v = new LibsodiumVault(key);
  const { ciphertext, nonce } = await v.seal("refresh-token-123");
  expect(await v.open(ciphertext, nonce)).toBe("refresh-token-123");
});
test("wrong key cannot open", async () => {
  const { ciphertext, nonce } = await new LibsodiumVault(key).seal("secret");
  await expect(new LibsodiumVault("b".repeat(64)).open(ciphertext, nonce)).rejects.toThrow();
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement interface + impl**

```ts
// src/vault/vault.ts
export interface TokenVault {
  seal(plaintext: string): Promise<{ ciphertext: string; nonce: string }>;
  open(ciphertext: string, nonce: string): Promise<string>;
}
```

```ts
// src/vault/libsodium.ts
import _sodium from "libsodium-wrappers";
import type { TokenVault } from "./vault.js";
export class LibsodiumVault implements TokenVault {
  constructor(private keyHex: string) {}
  private async key() {
    await _sodium.ready;
    return _sodium.from_hex(this.keyHex);
  }
  async seal(plaintext: string) {
    const s = _sodium; await s.ready;
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const ct = s.crypto_secretbox_easy(s.from_string(plaintext), nonce, await this.key());
    return { ciphertext: s.to_base64(ct), nonce: s.to_base64(nonce) };
  }
  async open(ciphertext: string, nonce: string) {
    const s = _sodium; await s.ready;
    const pt = s.crypto_secretbox_open_easy(s.from_base64(ciphertext), s.from_base64(nonce), await this.key());
    return s.to_string(pt);
  }
}
```

- [ ] **Step 4: Run (PASS).**
- [ ] **Step 5: Commit** — `git commit -am "feat(backend): libsodium TokenVault"`.

---

## Task 3: Database schema + access

**Files:**
- Create: `backend/migrations/001_init.sql`
- Create: `backend/src/db.ts`
- Test: `backend/test/db.test.ts` (against a disposable Postgres; use `pg-mem` or a Docker test DB)

- [ ] **Step 1: Write the migration**

```sql
-- migrations/001_init.sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE provider_tokens (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_token TEXT,
  activity_token TEXT,
  push_to_start_token TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  last_push_ok_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_active ON devices(active) WHERE active;
```

- [ ] **Step 2: Failing test — upsert user, store/read token**

```ts
// test/db.test.ts  (uses pg-mem; see note)
import { makeDb } from "../src/db.js";
test("upsertUser is idempotent on apple_sub", async () => {
  const db = await makeTestDb();
  const a = await db.upsertUser("sub-1");
  const b = await db.upsertUser("sub-1");
  expect(a.id).toBe(b.id);
});
test("provider token round-trips through the row", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("sub-2");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const row = await db.getProviderToken(u.id, "spotify");
  expect(row).toMatchObject({ ciphertext: "c", nonce: "n", needs_reauth: false });
});
```

> Note: `makeTestDb()` spins up `pg-mem` and runs `001_init.sql`. Install `npm i -D pg-mem`. (`gen_random_uuid()` is supported; if not, generate ids in code for tests.)

- [ ] **Step 3: Run (FAIL).**

- [ ] **Step 4: Implement `db.ts`**

```ts
// src/db.ts
import { Pool } from "pg";
export interface UserRow { id: string; apple_sub: string }
export interface TokenRow { ciphertext: string; nonce: string; needs_reauth: boolean }
export function makeDb(pool: Pool) {
  return {
    async upsertUser(appleSub: string): Promise<UserRow> {
      const { rows } = await pool.query(
        `INSERT INTO users (apple_sub) VALUES ($1)
         ON CONFLICT (apple_sub) DO UPDATE SET apple_sub = EXCLUDED.apple_sub
         RETURNING id, apple_sub`, [appleSub]);
      return rows[0];
    },
    async saveProviderToken(userId: string, provider: string, enc: { ciphertext: string; nonce: string }) {
      await pool.query(
        `INSERT INTO provider_tokens (user_id, provider, ciphertext, nonce, needs_reauth, updated_at)
         VALUES ($1,$2,$3,$4,false,now())
         ON CONFLICT (user_id, provider)
         DO UPDATE SET ciphertext=$3, nonce=$4, needs_reauth=false, updated_at=now()`,
        [userId, provider, enc.ciphertext, enc.nonce]);
    },
    async getProviderToken(userId: string, provider: string): Promise<TokenRow | null> {
      const { rows } = await pool.query(
        `SELECT ciphertext, nonce, needs_reauth FROM provider_tokens WHERE user_id=$1 AND provider=$2`,
        [userId, provider]);
      return rows[0] ?? null;
    },
    async markNeedsReauth(userId: string, provider: string) {
      await pool.query(`UPDATE provider_tokens SET needs_reauth=true WHERE user_id=$1 AND provider=$2`,
        [userId, provider]);
    },
    // device ops added in Task 7
    raw: pool,
  };
}
export type Db = ReturnType<typeof makeDb>;
```

- [ ] **Step 5: Run (PASS).** — [ ] **Step 6: Commit** `git commit -am "feat(backend): schema + db access"`.

---

## Task 4: Apple identity verification + session JWT

**Files:**
- Create: `backend/src/auth/apple.ts`, `backend/src/auth/session.ts`
- Test: `backend/test/auth.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/auth.test.ts
import { issueSession, verifySession } from "../src/auth/session.js";
test("session round-trips userId", () => {
  const t = issueSession("user-1", "secret");
  expect(verifySession(t, "secret").userId).toBe("user-1");
});
test("tampered session rejected", () => {
  expect(() => verifySession("bad.token.here", "secret")).toThrow();
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement session.ts**

```ts
// src/auth/session.ts
import jwt from "jsonwebtoken";
export function issueSession(userId: string, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: "1h" });
}
export function issueRefresh(userId: string, secret: string): string {
  return jwt.sign({ sub: userId, typ: "refresh" }, secret, { expiresIn: "60d" });
}
export function verifySession(token: string, secret: string): { userId: string } {
  const p = jwt.verify(token, secret) as { sub: string };
  return { userId: p.sub };
}
export function verifyRefresh(token: string, secret: string): { userId: string } {
  const p = jwt.verify(token, secret) as { sub: string; typ?: string };
  if (p.typ !== "refresh") throw new Error("not a refresh token");
  return { userId: p.sub };
}
```

- [ ] **Step 4: Implement apple.ts (verifies Apple identity token via Apple JWKS)**

```ts
// src/auth/apple.ts
import { createRemoteJWKSet, jwtVerify } from "jose";
const JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
export async function verifyAppleIdentityToken(idToken: string, clientId: string): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: "https://appleid.apple.com",
    audience: clientId,
  });
  return { sub: payload.sub as string };
}
```

> Test note: mock `jose` (`vi.mock("jose")`) to assert issuer/audience are passed and `sub` is returned; do not hit Apple JWKS in unit tests.

- [ ] **Step 5: Run (PASS).** — [ ] **Step 6: Commit** `git commit -am "feat(backend): apple verify + session jwt"`.

---

## Task 5: Spotify provider (OAuth exchange/refresh, getNowPlaying, control)

**Files:**
- Create: `backend/src/providers/types.ts`, `backend/src/providers/spotify.ts`
- Test: `backend/test/spotify.test.ts`

- [ ] **Step 1: Define provider types**

```ts
// src/providers/types.ts
export type ProviderKind = "server-poll" | "device-push";
export type ControlAction = "next" | "prev" | "playpause";
export interface NowPlaying {
  trackId: string; title: string; artist: string; album: string;
  artUrl?: string; durationMs: number; progressMs: number;
  isPlaying: boolean; startedAt: number; dominantColor?: string;
}
export interface MusicProvider {
  id: string;
  kind: ProviderKind;
  getNowPlaying?(accessToken: string): Promise<NowPlaying | null>;
  control?(accessToken: string, action: ControlAction): Promise<void>;
}
```

- [ ] **Step 2: Failing tests (mock Spotify HTTP with undici MockAgent)**

```ts
// test/spotify.test.ts
import { MockAgent, setGlobalDispatcher } from "undici";
import { spotify } from "../src/providers/spotify.js";

function mockSpotify() {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  return agent.get("https://api.spotify.com");
}
test("204 means nothing playing → null", async () => {
  mockSpotify().intercept({ path: "/v1/me/player/currently-playing", method: "GET" }).reply(204, "");
  expect(await spotify.getNowPlaying!("tok")).toBeNull();
});
test("200 maps to NowPlaying", async () => {
  mockSpotify().intercept({ path: "/v1/me/player/currently-playing", method: "GET" }).reply(200, {
    is_playing: true, progress_ms: 1000,
    item: { id: "t1", name: "Song", duration_ms: 200000,
      artists: [{ name: "Artist" }], album: { name: "Album", images: [{ url: "http://art" }] } },
  });
  const np = await spotify.getNowPlaying!("tok");
  expect(np).toMatchObject({ trackId: "t1", title: "Song", artist: "Artist", isPlaying: true });
});
test("control next issues POST", async () => {
  const pool = mockSpotify();
  pool.intercept({ path: "/v1/me/player/next", method: "POST" }).reply(204, "");
  await expect(spotify.control!("tok", "next")).resolves.toBeUndefined();
});
```

- [ ] **Step 3: Run (FAIL).**

- [ ] **Step 4: Implement spotify.ts**

```ts
// src/providers/spotify.ts
import { request } from "undici";
import type { MusicProvider, NowPlaying, ControlAction } from "./types.js";

const API = "https://api.spotify.com";
const ACCOUNTS = "https://accounts.spotify.com";

export async function exchangeCode(clientId: string, redirectUri: string, code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: redirectUri,
    client_id: clientId, code_verifier: codeVerifier,
  });
  const res = await request(`${ACCOUNTS}/api/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  if (res.statusCode !== 200) throw new Error(`spotify token exchange ${res.statusCode}`);
  return (await res.body.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

export async function refreshAccessToken(clientId: string, refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId,
  });
  const res = await request(`${ACCOUNTS}/api/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  if (res.statusCode === 400) { const e: any = new Error("refresh revoked"); e.revoked = true; throw e; }
  if (res.statusCode !== 200) throw new Error(`spotify refresh ${res.statusCode}`);
  return (await res.body.json()) as { access_token: string; expires_in: number; refresh_token?: string };
}

export const spotify: MusicProvider = {
  id: "spotify",
  kind: "server-poll",
  async getNowPlaying(accessToken: string): Promise<NowPlaying | null> {
    const res = await request(`${API}/v1/me/player/currently-playing`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.statusCode === 204) return null;
    if (res.statusCode === 401) { const e: any = new Error("expired"); e.expired = true; throw e; }
    if (res.statusCode === 429) {
      const e: any = new Error("rate-limited");
      e.retryAfter = Number(res.headers["retry-after"] ?? "1"); throw e;
    }
    if (res.statusCode !== 200) throw new Error(`spotify currently-playing ${res.statusCode}`);
    const b: any = await res.body.json();
    if (!b.item) return null;
    return {
      trackId: b.item.id, title: b.item.name,
      artist: (b.item.artists ?? []).map((a: any) => a.name).join(", "),
      album: b.item.album?.name ?? "",
      artUrl: b.item.album?.images?.[0]?.url,
      durationMs: b.item.duration_ms, progressMs: b.progress_ms ?? 0,
      isPlaying: !!b.is_playing,
      startedAt: Date.now() - (b.progress_ms ?? 0),
    };
  },
  async control(accessToken: string, action: ControlAction): Promise<void> {
    const auth = { authorization: `Bearer ${accessToken}` };
    const call = (method: string, path: string) =>
      request(`${API}${path}`, { method, headers: auth });
    if (action === "next") { await call("POST", "/v1/me/player/next"); return; }
    if (action === "prev") { await call("POST", "/v1/me/player/previous"); return; }
    // playpause: read state then toggle
    const res = await request(`${API}/v1/me/player`, { headers: auth });
    const playing = res.statusCode === 200 ? (await res.body.json() as any).is_playing : false;
    await call("PUT", playing ? "/v1/me/player/pause" : "/v1/me/player/play");
  },
};
```

- [ ] **Step 5: Add tests for 401 (`expired`), 429 (`retryAfter`), and refresh-revoked, then make them pass.**
- [ ] **Step 6: Run (PASS).** — [ ] **Step 7: Commit** `git commit -am "feat(backend): spotify provider"`.

---

## Task 6: Artwork (fetch + dominantColor)

**Files:**
- Create: `backend/src/artwork.ts`
- Test: `backend/test/artwork.test.ts`

- [ ] **Step 1: Failing test (known image → expected average/dominant hex; fetch failure → undefined)**

```ts
// test/artwork.test.ts
import { dominantColorFromBytes } from "../src/artwork.js";
import { readFileSync } from "node:fs";
test("solid red image → ~#ff0000", async () => {
  const png = readFileSync(new URL("./fixtures/red.png", import.meta.url));
  const hex = await dominantColorFromBytes(png);
  expect(hex.toLowerCase()).toMatch(/^#f[ef]0{4}$/);  // allow rounding
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement (use `sharp` to downscale to 1x1 = average color)**

```bash
npm i sharp
```

```ts
// src/artwork.ts
import sharp from "sharp";
import { request } from "undici";
export async function dominantColorFromBytes(bytes: Buffer | Uint8Array): Promise<string> {
  const { data } = await sharp(bytes).resize(1, 1, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = data;
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}
export async function dominantColor(artUrl: string): Promise<string | undefined> {
  try {
    const res = await request(artUrl);
    if (res.statusCode !== 200) return undefined;
    return await dominantColorFromBytes(Buffer.from(await res.body.arrayBuffer()));
  } catch { return undefined; }
}
```

- [ ] **Step 4: Add a `red.png` fixture (16x16 solid red). Run (PASS).**
- [ ] **Step 5: Commit** `git commit -am "feat(backend): artwork dominant color"`.

---

## Task 7: Device + activity persistence ops

**Files:**
- Modify: `backend/src/db.ts` (add device ops)
- Test: `backend/test/devices.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// test/devices.test.ts
test("register device token then activity token on same row", async () => {
  const db = await makeTestDb(); const u = await db.upsertUser("s");
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", "pts");
  const active = await db.activeDevices();
  expect(active.find(x => x.id === d.id)).toMatchObject({ activity_token: "at", device_token: "dt" });
});
test("markPushResult clears active on 410", async () => {
  const db = await makeTestDb(); const u = await db.upsertUser("s2");
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", null);
  await db.markPushResult(d.id, 410);
  expect((await db.activeDevices()).find(x => x.id === d.id)).toBeUndefined();
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement device ops in `db.ts`**

```ts
// add to makeDb(...) return object:
async registerDevice(userId: string, t: { deviceToken?: string }) {
  const { rows } = await pool.query(
    `INSERT INTO devices (user_id, device_token, active) VALUES ($1,$2,false) RETURNING *`,
    [userId, t.deviceToken ?? null]);
  return rows[0];
},
async setActivityToken(deviceId: string, activityToken: string, pushToStart: string | null) {
  await pool.query(
    `UPDATE devices SET activity_token=$2, push_to_start_token=$3, active=true,
       last_heartbeat_at=now(), updated_at=now() WHERE id=$1`,
    [deviceId, activityToken, pushToStart]);
},
async endActivity(deviceId: string) {
  await pool.query(`UPDATE devices SET active=false, updated_at=now() WHERE id=$1`, [deviceId]);
},
async heartbeat(deviceId: string) {
  await pool.query(`UPDATE devices SET last_heartbeat_at=now() WHERE id=$1`, [deviceId]);
},
async markPushResult(deviceId: string, status: number) {
  if (status === 410) { await pool.query(`UPDATE devices SET active=false WHERE id=$1`, [deviceId]); return; }
  if (status >= 200 && status < 300) await pool.query(`UPDATE devices SET last_push_ok_at=now() WHERE id=$1`, [deviceId]);
},
async activeDevices() {
  // Zombie eviction. A device is polled while active AND either:
  //  - it has had a successful push within 15min, OR
  //  - it has NEVER been pushed yet but registered/heartbeat'd within a grace window.
  // The NULL-last_push_ok_at case must be bounded by registration age, else a device
  // that registered-then-force-quit-while-paused (no change → no push → no 410) lingers forever.
  const { rows } = await pool.query(
    `SELECT d.*, pt.ciphertext, pt.nonce, pt.needs_reauth
     FROM devices d
     JOIN provider_tokens pt ON pt.user_id = d.user_id AND pt.provider='spotify'
     WHERE d.active = true AND pt.needs_reauth = false
       AND (
         d.last_push_ok_at > now() - interval '15 minutes'
         OR (d.last_push_ok_at IS NULL
             AND COALESCE(d.last_heartbeat_at, d.updated_at) > now() - interval '15 minutes')
       )`);
  return rows;
},
```

- [ ] **Step 4: Run (PASS).** — [ ] **Step 5: Commit** `git commit -am "feat(backend): device persistence ops"`.

---

## Task 8: APNs client

**Files:**
- Create: `backend/src/apns.ts`
- Test: `backend/test/apns.test.ts`

- [ ] **Step 1: Failing tests (mock HTTP/2 send; assert headers + 410 propagation)**

```ts
// test/apns.test.ts
import { buildHeaders } from "../src/apns.js";
test("liveactivity headers carry correct topic + priority", () => {
  const h = buildHeaders("tok", "liveactivity", "com.x.app", "10");
  expect(h["apns-topic"]).toBe("com.x.app.push-type.liveactivity");
  expect(h["apns-push-type"]).toBe("liveactivity");
  expect(h["apns-priority"]).toBe("10");
});
test("background push uses plain bundle topic", () => {
  const h = buildHeaders("tok", "background", "com.x.app", "5");
  expect(h["apns-topic"]).toBe("com.x.app");
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement apns.ts** (extract `buildHeaders` as pure + testable; keep the HTTP/2 send thin)

```ts
// src/apns.ts
import http2 from "node:http2";
import jwt from "jsonwebtoken";

export function buildHeaders(token: string, pushType: "liveactivity" | "background",
  bundleId: string, priority: string) {
  const topic = pushType === "liveactivity" ? `${bundleId}.push-type.liveactivity` : bundleId;
  return {
    ":method": "POST", ":path": `/3/device/${token}`,
    "apns-topic": topic, "apns-push-type": pushType, "apns-priority": priority,
  } as Record<string, string>;
}

export function makeApns(cfg: { keyId: string; teamId: string; bundleId: string; p8: string; host: string }) {
  // Cache the provider JWT: APNs rejects tokens minted too often (TooManyProviderTokenUpdates);
  // reuse for ~50min.
  let cached: { token: string; at: number } | null = null;
  function jwtToken() {
    const now = Date.now();
    if (!cached || now - cached.at > 50 * 60_000) {
      cached = { token: jwt.sign({ iss: cfg.teamId, iat: Math.floor(now / 1000) }, cfg.p8,
        { algorithm: "ES256", header: { alg: "ES256", kid: cfg.keyId } }), at: now };
    }
    return cached.token;
  }
  function send(token: string, pushType: "liveactivity" | "background",
    payload: object, priority: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const client = http2.connect(cfg.host);
      const req = client.request({ ...buildHeaders(token, pushType, cfg.bundleId, priority),
        authorization: `bearer ${jwtToken()}` });
      let status = 0;
      let body = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      // MUST consume the body: http2 streams stay paused until read, so 'end' never
      // fires for error responses (incl. 410 {"reason":"Unregistered"}) and the Promise
      // would hang — silently breaking the 410 liveness/eviction path.
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => { client.close(); resolve(status); });
      req.on("error", (e) => { client.close(); reject(e); });
      req.setTimeout(10_000, () => { req.close(); client.close(); reject(new Error("apns timeout")); });
      req.end(JSON.stringify(payload));
    });
  }
  return {
    pushUpdate: (activityToken: string, contentState: object) =>
      send(activityToken, "liveactivity", {
        aps: { timestamp: Math.floor(Date.now() / 1000), event: "update", "content-state": contentState },
      }, "10"),
    pushSilentWake: (deviceToken: string) =>
      send(deviceToken, "background", { aps: { "content-available": 1 } }, "5"),
    pushStopped: (activityToken: string) =>
      send(activityToken, "liveactivity", {
        aps: { timestamp: Math.floor(Date.now() / 1000), event: "update",
          "content-state": { isPlaying: false, title: "Nothing playing", artist: "", album: "",
            trackId: "", durationMs: 0, progressMs: 0, startedAt: 0 } },
      }, "5"),
  };
}
```

- [ ] **Step 4: Run (PASS).** — [ ] **Step 5: Commit** `git commit -am "feat(backend): apns client"`.

---

## Task 9: Poller logic (`changed()` + poll-one-user)

**Files:**
- Create: `backend/src/poller.ts`
- Test: `backend/test/poller.test.ts`

- [ ] **Step 1: Failing tests for `changed()`**

```ts
// test/poller.test.ts
import { changed } from "../src/poller.js";
const base = { trackId: "t1", isPlaying: true, progressMs: 1000, durationMs: 200000,
  title: "", artist: "", album: "", startedAt: 0 };
test("same track + normal progress drift does NOT fire", () => {
  expect(changed(base, { ...base, progressMs: 1500 }, 500)).toBe(false);
});
test("track change fires", () => expect(changed(base, { ...base, trackId: "t2" }, 500)).toBe(true));
test("play↔pause fires", () => expect(changed(base, { ...base, isPlaying: false }, 500)).toBe(true));
test("large seek fires", () => expect(changed(base, { ...base, progressMs: 9000 }, 500)).toBe(true));
test("null↔something fires", () => {
  expect(changed(null, base, 500)).toBe(true);
  expect(changed(base, null, 500)).toBe(true);
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement `changed()` + the per-user poll step**

```ts
// src/poller.ts
import type { NowPlaying } from "./providers/types.js";

// elapsedMs = wall time since prev was captured; used to compute expected progress.
export function changed(prev: NowPlaying | null, cur: NowPlaying | null, elapsedMs: number): boolean {
  if (!prev || !cur) return prev !== cur;
  if (prev.trackId !== cur.trackId) return true;
  if (prev.isPlaying !== cur.isPlaying) return true;
  const expected = prev.progressMs + (prev.isPlaying ? elapsedMs : 0);
  if (Math.abs(cur.progressMs - expected) > 3000) return true;   // manual seek
  return false;
}
```

```ts
// pollOneUser orchestrates: refresh token if needed → getNowPlaying → handle 401/429/revoked
// → if changed: compute dominantColor, push liveactivity update + silent wake, markPushResult.
// (Pure-ish: inject provider, apns, vault, db, artwork as params for testability.)
// All collaborators injected via deps for testability — no dynamic import, no hidden cache.
// deps.refreshAccessToken(clientId, refreshToken) → { access_token }.
export async function pollOneUser(deps: {
  device: any; vault: any; db: any; spotify: any; apns: any; artwork: any;
  refreshAccessToken: (clientId: string, refresh: string) => Promise<{ access_token: string }>;
  clientId: string; prev: NowPlaying | null; now: number;
}): Promise<NowPlaying | null> {
  const { device, vault, db, spotify, apns, artwork, refreshAccessToken, clientId, prev, now } = deps;
  const refresh = await vault.open(device.ciphertext, device.nonce);
  let access: string;
  try {
    access = (await refreshAccessToken(clientId, refresh)).access_token;   // properly awaited
  } catch (e: any) {
    if (e.revoked) { await db.markNeedsReauth(device.user_id, "spotify"); return prev; }
    return prev;                            // transient refresh error: keep last
  }
  let cur: NowPlaying | null;
  try { cur = await spotify.getNowPlaying(access); }
  catch (e: any) {
    // 401 expired / 429 retryAfter / 5xx / timeout: keep last state, next tick recovers.
    return prev;
  }
  const elapsed = prev ? now - prev.startedAt - prev.progressMs : 0;
  if (changed(prev, cur, Math.max(0, elapsed))) {
    if (!device.activity_token) return cur;
    let status: number;
    if (cur) {
      cur.dominantColor = cur.artUrl ? await artwork.dominantColor(cur.artUrl) : undefined;
      status = await apns.pushUpdate(device.activity_token, toContentState(cur));
      if (device.device_token) await apns.pushSilentWake(device.device_token);  // wake to cache art
    } else {
      // 204 → playback stopped: push a "stopped" content-state so the Live Activity
      // doesn't show the last track forever (spec §error table).
      status = await apns.pushStopped(device.activity_token);
    }
    await db.markPushResult(device.id, status);
  }
  return cur;
}
function toContentState(np: NowPlaying) {
  return { trackId: np.trackId, title: np.title, artist: np.artist, album: np.album,
    artUrl: np.artUrl, durationMs: np.durationMs, progressMs: np.progressMs,
    isPlaying: np.isPlaying, startedAt: np.startedAt, dominantColor: np.dominantColor };
}
```

- [ ] **Step 4: Add a `pollOneUser` test with all deps mocked: asserts push fires only on change, markNeedsReauth on revoked, silent wake sent when device_token present.**
- [ ] **Step 5: Run (PASS).** — [ ] **Step 6: Commit** `git commit -am "feat(backend): poller logic"`.

---

## Task 10: HTTP routes (Fastify)

**Files:**
- Create: `backend/src/routes.ts`
- Test: `backend/test/routes.test.ts` (Fastify `inject`)

- [ ] **Step 1: Failing tests**

```ts
// test/routes.test.ts
test("POST /auth/apple returns session token", async () => {
  const app = buildTestApp();  // injects mocked verifyAppleIdentityToken + db
  const res = await app.inject({ method: "POST", url: "/auth/apple", payload: { idToken: "x" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().sessionToken).toBeDefined();
});
test("authed routes reject missing session", async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/control", payload: { action: "next" } });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement routes** (auth guard via `preHandler` verifying session JWT; endpoints from spec)

```ts
// src/routes.ts
import type { FastifyInstance } from "fastify";

// deps shape (assembled in server.ts):
//   db, vault, apple:{verify}, session:{issue,issueRefresh,verify,verifyRefresh},
//   spotify:{exchangeCode,getNowPlaying,control}, refreshAccessToken, clientId
export function registerRoutes(app: FastifyInstance, deps: any) {
  const auth = async (req: any, reply: any) => {
    const h = req.headers.authorization?.replace("Bearer ", "");
    try { req.userId = deps.session.verify(h).userId; }
    catch { reply.code(401).send({ error: "unauthorized" }); }
  };
  // Resolve a user's live Spotify access token (open vault → refresh). Shared by /control + /nowplaying/current.
  async function userAccessToken(userId: string): Promise<string> {
    const row = await deps.db.getProviderToken(userId, "spotify");
    if (!row || row.needs_reauth) throw new Error("needs-reauth");
    const refresh = await deps.vault.open(row.ciphertext, row.nonce);
    return (await deps.refreshAccessToken(deps.clientId, refresh)).access_token;
  }

  app.post("/auth/apple", async (req: any) => {
    const { sub } = await deps.apple.verify(req.body.idToken);
    const user = await deps.db.upsertUser(sub);
    return { sessionToken: deps.session.issue(user.id), refreshToken: deps.session.issueRefresh(user.id) };
  });
  app.post("/auth/refresh", async (req: any, reply: any) => {
    try { return { sessionToken: deps.session.issue(deps.session.verifyRefresh(req.body.refreshToken).userId) }; }
    catch { reply.code(401).send({ error: "bad refresh" }); }
  });
  app.post("/spotify/connect", { preHandler: auth }, async (req: any) => {
    const tok = await deps.spotify.exchangeCode(req.body.code, req.body.codeVerifier);
    await deps.db.saveProviderToken(req.userId, "spotify", await deps.vault.seal(tok.refresh_token));
    return { ok: true };
  });
  app.post("/device/register", { preHandler: auth }, async (req: any) =>
    deps.db.registerDevice(req.userId, { deviceToken: req.body.deviceToken }));
  app.post("/activity/register", { preHandler: auth }, async (req: any) => {
    await deps.db.setActivityToken(req.body.deviceId, req.body.activityToken, req.body.pushToStartToken ?? null);
    return { ok: true };
  });
  app.post("/activity/heartbeat", { preHandler: auth }, async (req: any) => { await deps.db.heartbeat(req.body.deviceId); return { ok: true }; });
  app.post("/activity/end", { preHandler: auth }, async (req: any) => { await deps.db.endActivity(req.body.deviceId); return { ok: true }; });
  app.post("/control", { preHandler: auth }, async (req: any) => {
    await deps.spotify.control(await userAccessToken(req.userId), req.body.action);
    return { ok: true };
  });
  // Seed endpoint for the app at StandBy start (live fetch; returns null when nothing playing).
  app.get("/nowplaying/current", { preHandler: auth }, async (req: any) =>
    (await deps.spotify.getNowPlaying(await userAccessToken(req.userId))) ?? null);
  app.get("/health", async () => ({ ok: true }));   // poller liveness is separate (DB heartbeat row)
}
```

> Add `verifyRefresh` to `session.ts` (same as `verifySession` but asserts `typ === "refresh"`).

- [ ] **Step 4: Run (PASS).** — [ ] **Step 5: Commit** `git commit -am "feat(backend): http routes"`.

---

## Task 11: Process entrypoints + advisory-lock poller

**Files:**
- Create: `backend/src/server.ts`, `backend/src/poller-main.ts`

- [ ] **Step 1: API entrypoint**

```ts
// src/server.ts
import Fastify from "fastify";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { makeDb } from "./db.js";
import { registerRoutes } from "./routes.js";
// ...assemble deps (vault, apns, session, apple, spotify) and registerRoutes
const cfg = loadConfig();
const app = Fastify({ logger: true });
const db = makeDb(new Pool({ connectionString: cfg.databaseUrl }));
// registerRoutes(app, { ...deps });
app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
```

- [ ] **Step 2: Poller entrypoint with Postgres advisory lock (single-poller guarantee)**

```ts
// src/poller-main.ts
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { makeDb } from "./db.js";
import { pollOneUser } from "./poller.js";

const cfg = loadConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl });
const db = makeDb(pool);
const prevByDevice = new Map<string, any>();

// Hold the advisory lock on a DEDICATED long-lived client. A session-scoped lock
// taken via pool.query() is released when the pooled connection is reaped
// (idleTimeoutMillis), letting a second poller acquire it. Keep one client checked out.
let lockClient: import("pg").PoolClient | null = null;
async function acquireLock(): Promise<boolean> {
  lockClient = await pool.connect();
  const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(987654321) AS got`);
  if (!rows[0].got) { lockClient.release(); lockClient = null; return false; }
  return true;   // never release this client while the poller runs
}

// Assemble collaborators once.
import { LibsodiumVault } from "./vault/libsodium.js";
import { makeApns } from "./apns.js";
import * as artwork from "./artwork.js";
import { spotify, refreshAccessToken } from "./providers/spotify.js";
const vault = new LibsodiumVault(cfg.encryptionKeyHex);
const apns = makeApns(cfg.apns);

async function tick() {
  const devices = await db.activeDevices();
  const now = Date.now();
  for (const device of devices) {
    try {
      const cur = await pollOneUser({
        device, vault, db, spotify, apns, artwork,
        refreshAccessToken, clientId: cfg.spotify.clientId,
        prev: prevByDevice.get(device.id) ?? null, now,
      });
      prevByDevice.set(device.id, cur);
    } catch (e) { console.error("poll error", device.id, e); }
  }
}

(async () => {
  if (!(await acquireLock())) { console.log("another poller holds the lock; exiting"); process.exit(0); }
  setInterval(tick, 10_000);
})();
```

> Note: `setInterval` is fine for v1's fixed 10s cadence. Adaptive interval is deferred (spec). The advisory lock makes a second poller instance exit, satisfying the single-poller guarantee even if Fly scales the process.

- [ ] **Step 3: Commit** `git commit -am "feat(backend): server + poller entrypoints"`.

---

## Task 12: Fly.io deploy config

**Files:**
- Create: `backend/Dockerfile`, `backend/fly.toml`

- [ ] **Step 1: Dockerfile** (multi-stage: build TS → run dist).

- [ ] **Step 2: fly.toml with two processes**

```toml
app = "standby-nowplaying"
[build]
[deploy]
  release_command = "npm run migrate"    # apply migrations/*.sql before new version goes live
[processes]
  api = "node dist/server.js"
  poller = "node dist/poller-main.js"
[[services]]
  processes = ["api"]
  internal_port = 8080
  protocol = "tcp"
  [[services.ports]]
    handlers = ["http"]
    port = 80
  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

- [ ] **Step 3: Set secrets**

```bash
fly secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_REDIRECT_URI=standbynp://spotify-callback \
  APNS_KEY_ID=... APNS_TEAM_ID=... APNS_BUNDLE_ID=com.you.standby \
  APNS_P8="$(cat AuthKey.p8)" APNS_HOST=https://api.push.apple.com ENCRYPTION_KEY=$(openssl rand -hex 32) \
  APPLE_CLIENT_ID=com.you.standby SESSION_SECRET=$(openssl rand -hex 32) \
  DATABASE_URL=postgres://...
fly scale count poller=1   # pin poller to exactly one instance
```

- [ ] **Step 4: Deploy + smoke test `/health`**

```bash
fly deploy
curl https://standby-nowplaying.fly.dev/health   # → {"ok":true,...}
```

- [ ] **Step 5: Commit** `git commit -am "chore(backend): fly deploy config"`.

---

## Done When

- `npx vitest run` is green for config, vault, db, auth, spotify, artwork, devices, apns, poller, routes.
- `/health` responds on Fly; exactly one poller instance runs (verify `fly status`).
- A manual end-to-end check (real Spotify token seeded, a dummy activity token) sends an APNs push without error.
