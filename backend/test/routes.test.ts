import { vi, expect, test } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes.js";
import {
  issueSession,
  issueRefresh,
  verifySession,
  verifyRefresh,
} from "../src/auth/session.js";

const SECRET = "test-secret";

function makeDeps() {
  const db = {
    upsertUser: vi.fn(async () => ({ id: "u1" })),
    getProviderToken: vi.fn(async () => ({
      ciphertext: "ct",
      nonce: "nc",
      needs_reauth: false,
    })),
    registerDevice: vi.fn(async () => ({ id: "d1" })),
    setActivityToken: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    endActivity: vi.fn(async () => undefined),
    saveProviderToken: vi.fn(async () => undefined),
  };
  const vault = {
    seal: vi.fn(async () => ({ ciphertext: "ct", nonce: "nc" })),
    open: vi.fn(async () => "refresh"),
  };
  const apple = { verify: vi.fn(async () => ({ sub: "apple-1" })) };
  const session = {
    issue: (uid: string) => issueSession(uid, SECRET),
    issueRefresh: (uid: string) => issueRefresh(uid, SECRET),
    verify: (t: string) => verifySession(t, SECRET),
    verifyRefresh: (t: string) => verifyRefresh(t, SECRET),
  };
  const spotify = {
    exchangeCode: vi.fn(async () => ({ refresh_token: "r" })),
    getNowPlaying: vi.fn(async () => null as any),
    control: vi.fn(async () => undefined),
  };
  const refreshAccessToken = vi.fn(async () => ({ access_token: "a" }));
  return { db, vault, apple, session, spotify, refreshAccessToken, clientId: "cid" };
}

function buildTestApp(deps = makeDeps()) {
  const app = Fastify();
  registerRoutes(app, deps);
  return { app, deps };
}

test("POST /auth/apple returns session token", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/auth/apple", payload: { idToken: "x" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().sessionToken).toBeDefined();
});

test("POST /auth/apple returns 401 when apple verify fails", async () => {
  const deps = makeDeps();
  deps.apple.verify = vi.fn(async () => { throw new Error("bad token"); });
  const { app } = buildTestApp(deps);
  const res = await app.inject({ method: "POST", url: "/auth/apple", payload: { idToken: "x" } });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: "invalid apple token" });
});

test("POST /spotify/connect returns 400 when exchangeCode fails", async () => {
  const deps = makeDeps();
  deps.spotify.exchangeCode = vi.fn(async () => { throw new Error("boom"); });
  const { app } = buildTestApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/spotify/connect",
    headers: bearer(),
    payload: { code: "c", codeVerifier: "v" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "spotify exchange failed" });
});

test("POST /control returns 409 when provider token needs reauth", async () => {
  const deps = makeDeps();
  deps.db.getProviderToken = vi.fn(async () => ({ ciphertext: "ct", nonce: "nc", needs_reauth: true }));
  const { app } = buildTestApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/control",
    headers: bearer(),
    payload: { action: "next" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "needs-reauth" });
});

test("GET /nowplaying/current returns 409 when provider token needs reauth", async () => {
  const deps = makeDeps();
  deps.db.getProviderToken = vi.fn(async () => ({ ciphertext: "ct", nonce: "nc", needs_reauth: true }));
  const { app } = buildTestApp(deps);
  const res = await app.inject({ method: "GET", url: "/nowplaying/current", headers: bearer() });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "needs-reauth" });
});

test("authed routes reject missing session", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/control", payload: { action: "next" } });
  expect(res.statusCode).toBe(401);
});

const bearer = (uid = "u1") => ({ authorization: `Bearer ${issueSession(uid, SECRET)}` });

test("POST /spotify/connect exchanges code, seals, saves, returns ok", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/spotify/connect",
    headers: bearer(),
    payload: { code: "c", codeVerifier: "v" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(deps.spotify.exchangeCode).toHaveBeenCalledWith("c", "v");
  expect(deps.vault.seal).toHaveBeenCalledWith("r");
  expect(deps.db.saveProviderToken).toHaveBeenCalledWith("u1", "spotify", {
    ciphertext: "ct",
    nonce: "nc",
  });
});

test("POST /device/register returns the created device row", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/device/register",
    headers: bearer(),
    payload: { deviceToken: "dt" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ id: "d1" });
  expect(deps.db.registerDevice).toHaveBeenCalledWith("u1", { deviceToken: "dt" });
});

test("POST /activity/register passes pushToStartToken when present", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/activity/register",
    headers: bearer(),
    payload: { deviceId: "d1", activityToken: "at", pushToStartToken: "ps" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(deps.db.setActivityToken).toHaveBeenCalledWith("d1", "at", "ps");
});

test("POST /activity/register defaults pushToStartToken to null", async () => {
  const { app, deps } = buildTestApp();
  await app.inject({
    method: "POST",
    url: "/activity/register",
    headers: bearer(),
    payload: { deviceId: "d1", activityToken: "at" },
  });
  expect(deps.db.setActivityToken).toHaveBeenCalledWith("d1", "at", null);
});

test("POST /activity/heartbeat calls db.heartbeat", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/activity/heartbeat",
    headers: bearer(),
    payload: { deviceId: "d1" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(deps.db.heartbeat).toHaveBeenCalledWith("d1");
});

test("POST /activity/end calls db.endActivity", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/activity/end",
    headers: bearer(),
    payload: { deviceId: "d1" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(deps.db.endActivity).toHaveBeenCalledWith("d1");
});

test("POST /control resolves access token and controls playback", async () => {
  const { app, deps } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/control",
    headers: bearer(),
    payload: { action: "next" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  // userAccessToken path exercised
  expect(deps.db.getProviderToken).toHaveBeenCalledWith("u1", "spotify");
  expect(deps.vault.open).toHaveBeenCalledWith("ct", "nc");
  expect(deps.refreshAccessToken).toHaveBeenCalledWith("cid", "refresh");
  expect(deps.spotify.control).toHaveBeenCalledWith("a", "next");
});

test("GET /nowplaying/current returns the NowPlaying body", async () => {
  const deps = makeDeps();
  const np = {
    trackId: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    durationMs: 1000,
    progressMs: 10,
    isPlaying: true,
    startedAt: 0,
  };
  deps.spotify.getNowPlaying = vi.fn(async () => np);
  const { app } = buildTestApp(deps);
  const res = await app.inject({ method: "GET", url: "/nowplaying/current", headers: bearer() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(np);
  expect(deps.spotify.getNowPlaying).toHaveBeenCalledWith("a");
});

test("GET /nowplaying/current returns null body when nothing playing", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/nowplaying/current", headers: bearer() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toBeNull();
});

test("POST /auth/refresh issues a new session token from a refresh token", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: issueRefresh("u1", SECRET) },
  });
  expect(res.statusCode).toBe(200);
  const token = res.json().sessionToken;
  expect(token).toBeDefined();
  expect(verifySession(token, SECRET).userId).toBe("u1");
});

test("POST /auth/refresh rejects a normal session token with 401", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: issueSession("u1", SECRET) },
  });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: "bad refresh" });
});

test("GET /health needs no auth and returns ok", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
