import { MockAgent, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";
import { spotify, refreshAccessToken } from "../src/providers/spotify.js";

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
