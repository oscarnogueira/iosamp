import { MockAgent, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";
import { spotify, refreshAccessToken, exchangeCode } from "../src/providers/spotify.js";

function mockSpotify() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get("https://api.spotify.com");
}

function mockAccounts() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get("https://accounts.spotify.com");
}

test("204 means nothing playing → null", async () => {
  mockSpotify().intercept({ path: "/v1/me/player/currently-playing", method: "GET" }).reply(204, "");
  expect(await spotify.getNowPlaying!("tok")).toBeNull();
});

test("200 maps to NowPlaying", async () => {
  mockSpotify().intercept({ path: "/v1/me/player/currently-playing", method: "GET" }).reply(200, {
    is_playing: true,
    progress_ms: 1000,
    item: {
      id: "t1",
      name: "Song",
      duration_ms: 200000,
      artists: [{ name: "Artist" }],
      album: { name: "Album", images: [{ url: "http://art" }] },
    },
  });
  const np = await spotify.getNowPlaying!("tok");
  expect(np).toMatchObject({ trackId: "t1", title: "Song", artist: "Artist", isPlaying: true });
  // startedAt === Date.now() - progress_ms (progress_ms === 1000). Assert a tolerant range.
  expect(np!.startedAt).toBeLessThanOrEqual(Date.now() - 1000);
  expect(np!.startedAt).toBeGreaterThan(Date.now() - 1000 - 5000);
});

test("control next issues POST", async () => {
  const pool = mockSpotify();
  pool.intercept({ path: "/v1/me/player/next", method: "POST" }).reply(204, "");
  await expect(spotify.control!("tok", "next")).resolves.toBeUndefined();
});

test("401 → getNowPlaying throws with .expired === true", async () => {
  mockSpotify()
    .intercept({ path: "/v1/me/player/currently-playing", method: "GET" })
    .reply(401, "");
  await expect(spotify.getNowPlaying!("tok")).rejects.toMatchObject({ expired: true });
});

test("429 with retry-after: 2 → throws with .retryAfter === 2", async () => {
  mockSpotify()
    .intercept({ path: "/v1/me/player/currently-playing", method: "GET" })
    .reply(429, "", { headers: { "retry-after": "2" } });
  await expect(spotify.getNowPlaying!("tok")).rejects.toMatchObject({ retryAfter: 2 });
});

test("refreshAccessToken on 400 → throws with .revoked === true", async () => {
  mockAccounts()
    .intercept({ path: "/api/token", method: "POST" })
    .reply(400, "");
  await expect(refreshAccessToken("client-id", "bad-refresh-token")).rejects.toMatchObject({
    revoked: true,
  });
});

test("control prev issues POST to /v1/me/player/previous", async () => {
  const pool = mockSpotify();
  pool.intercept({ path: "/v1/me/player/previous", method: "POST" }).reply(204, "");
  await expect(spotify.control!("tok", "prev")).resolves.toBeUndefined();
});

test("control playpause when playing → PUT /v1/me/player/pause", async () => {
  const pool = mockSpotify();
  pool.intercept({ path: "/v1/me/player", method: "GET" }).reply(200, { is_playing: true });
  pool.intercept({ path: "/v1/me/player/pause", method: "PUT" }).reply(204, "");
  await expect(spotify.control!("tok", "playpause")).resolves.toBeUndefined();
});

test("control playpause when not playing → PUT /v1/me/player/play", async () => {
  const pool = mockSpotify();
  pool.intercept({ path: "/v1/me/player", method: "GET" }).reply(200, { is_playing: false });
  pool.intercept({ path: "/v1/me/player/play", method: "PUT" }).reply(204, "");
  await expect(spotify.control!("tok", "playpause")).resolves.toBeUndefined();
});

test("exchangeCode posts PKCE body (no client_secret) and resolves tokens", async () => {
  let capturedBody = "";
  mockAccounts()
    .intercept({ path: "/api/token", method: "POST" })
    .reply(200, (opts) => {
      capturedBody = String(opts.body ?? "");
      return { access_token: "acc", refresh_token: "ref", expires_in: 3600 };
    });

  const tokens = await exchangeCode("client-id", "myapp://cb", "the-code", "the-verifier");
  expect(tokens).toMatchObject({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });

  const params = new URLSearchParams(capturedBody);
  expect(params.get("grant_type")).toBe("authorization_code");
  expect(params.get("code")).toBe("the-code");
  expect(params.get("code_verifier")).toBe("the-verifier");
  expect(params.get("client_id")).toBe("client-id");
  expect(params.has("client_secret")).toBe(false);
});
