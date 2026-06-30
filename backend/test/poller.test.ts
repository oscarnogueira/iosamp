import { expect, test, vi, beforeEach } from "vitest";
import { changed, pollOneUser } from "../src/poller.js";

const base = {
  trackId: "t1",
  isPlaying: true,
  progressMs: 1000,
  durationMs: 200000,
  title: "",
  artist: "",
  album: "",
  startedAt: 0,
};

// ── changed() ─────────────────────────────────────────────────

test("same track + normal progress drift does NOT fire", () => {
  expect(changed(base, { ...base, progressMs: 1500 }, 500)).toBe(false);
});
test("track change fires", () =>
  expect(changed(base, { ...base, trackId: "t2" }, 500)).toBe(true));
test("play↔pause fires", () =>
  expect(changed(base, { ...base, isPlaying: false }, 500)).toBe(true));
test("large seek fires", () =>
  expect(changed(base, { ...base, progressMs: 9000 }, 500)).toBe(true));
test("null↔something fires", () => {
  expect(changed(null, base, 500)).toBe(true);
  expect(changed(base, null, 500)).toBe(true);
});

// ── pollOneUser() ─────────────────────────────────────────────

function mkDeps(overrides: any = {}) {
  const np = {
    trackId: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    artUrl: "http://art/x.jpg",
    durationMs: 200000,
    progressMs: 1000,
    isPlaying: true,
    startedAt: 0,
    dominantColor: undefined,
  };
  const deps = {
    device: {
      id: "dev1",
      user_id: "u1",
      ciphertext: "ct",
      nonce: "nc",
      activity_token: "act-tok",
      device_token: "dev-tok",
    },
    vault: { open: vi.fn(async () => "refresh") },
    db: { markNeedsReauth: vi.fn(async () => {}), markPushResult: vi.fn(async () => {}) },
    spotify: { getNowPlaying: vi.fn(async () => np) },
    apns: {
      pushUpdate: vi.fn(async () => 200),
      pushSilentWake: vi.fn(async () => 200),
      pushStopped: vi.fn(async () => 200),
    },
    artwork: { dominantColor: vi.fn(async () => "#abcdef") },
    refreshAccessToken: vi.fn(async () => ({ access_token: "a" })),
    clientId: "client-id",
    prev: null as any,
    now: 1000,
    ...overrides,
  };
  return deps;
}

beforeEach(() => vi.clearAllMocks());

test("a. no change → pushUpdate NOT called", async () => {
  const prev = {
    trackId: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    artUrl: "http://art/x.jpg",
    durationMs: 200000,
    progressMs: 1000,
    isPlaying: true,
    startedAt: 0,
    dominantColor: undefined,
  };
  // cur same track, progress within drift relative to elapsed
  const cur = { ...prev, progressMs: 1100 };
  const deps = mkDeps({
    prev,
    now: 1000, // elapsed = now - startedAt - progressMs = 1000 - 0 - 1000 = 0
    spotify: { getNowPlaying: vi.fn(async () => cur) },
  });
  const out = await pollOneUser(deps as any);
  expect(deps.apns.pushUpdate).not.toHaveBeenCalled();
  expect(deps.apns.pushStopped).not.toHaveBeenCalled();
  expect(out).toBe(cur);
});

test("b. track change playing → pushUpdate + dominantColor + silentWake + markPushResult", async () => {
  const prev = {
    trackId: "t0",
    title: "Old",
    artist: "A",
    album: "B",
    artUrl: "http://art/old.jpg",
    durationMs: 100000,
    progressMs: 5000,
    isPlaying: true,
    startedAt: 0,
    dominantColor: undefined,
  };
  const deps = mkDeps({ prev, now: 6000 });
  const out = await pollOneUser(deps as any);
  expect(deps.apns.pushUpdate).toHaveBeenCalledTimes(1);
  const arg = deps.apns.pushUpdate.mock.calls[0];
  expect(arg[0]).toBe("act-tok");
  expect(arg[1]).toMatchObject({ trackId: "t1", dominantColor: "#abcdef" });
  expect(deps.artwork.dominantColor).toHaveBeenCalledWith("http://art/x.jpg");
  expect(deps.apns.pushSilentWake).toHaveBeenCalledWith("dev-tok");
  expect(deps.db.markPushResult).toHaveBeenCalledWith("dev1", 200);
  expect(out!.trackId).toBe("t1");
});

test("c. refresh throws revoked → markNeedsReauth, returns prev, no push", async () => {
  const prev = { ...base, artUrl: undefined, dominantColor: undefined } as any;
  const deps = mkDeps({
    prev,
    refreshAccessToken: vi.fn(async () => {
      const e: any = new Error("revoked");
      e.revoked = true;
      throw e;
    }),
  });
  const out = await pollOneUser(deps as any);
  expect(deps.db.markNeedsReauth).toHaveBeenCalledWith("u1", "spotify");
  expect(out).toBe(prev);
  expect(deps.apns.pushUpdate).not.toHaveBeenCalled();
  expect(deps.spotify.getNowPlaying).not.toHaveBeenCalled();
});

test("d. getNowPlaying null (204) with prev track → pushStopped + markPushResult, not pushUpdate", async () => {
  const prev = {
    trackId: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    artUrl: "http://art/x.jpg",
    durationMs: 200000,
    progressMs: 1000,
    isPlaying: true,
    startedAt: 0,
    dominantColor: undefined,
  };
  const deps = mkDeps({
    prev,
    now: 1000,
    spotify: { getNowPlaying: vi.fn(async () => null) },
  });
  const out = await pollOneUser(deps as any);
  expect(deps.apns.pushStopped).toHaveBeenCalledWith("act-tok");
  expect(deps.apns.pushUpdate).not.toHaveBeenCalled();
  expect(deps.db.markPushResult).toHaveBeenCalledWith("dev1", 200);
  expect(out).toBe(null);
});

test("b2. silent-wake result is fed through markPushResult (410 deactivates)", async () => {
  const prev = {
    trackId: "t0", title: "Old", artist: "A", album: "B",
    artUrl: "http://art/old.jpg", durationMs: 100000, progressMs: 5000,
    isPlaying: true, startedAt: 0, dominantColor: undefined,
  };
  const deps = mkDeps({
    prev,
    now: 6000,
    apns: {
      pushUpdate: vi.fn(async () => 200),
      pushSilentWake: vi.fn(async () => 410),
      pushStopped: vi.fn(async () => 200),
    },
  });
  await pollOneUser(deps as any);
  expect(deps.apns.pushSilentWake).toHaveBeenCalledWith("dev-tok");
  expect(deps.db.markPushResult).toHaveBeenCalledWith("dev1", 200); // main update
  expect(deps.db.markPushResult).toHaveBeenCalledWith("dev1", 410); // silent wake
});

test("f. access token is cached across ticks within the skew window", async () => {
  const cache = new Map<string, { accessToken: string; expiresAt: number }>();
  const refreshAccessToken = vi.fn(async () => ({ access_token: "a" }));
  const np = {
    trackId: "t1", title: "Song", artist: "Artist", album: "Album",
    artUrl: undefined, durationMs: 200000, progressMs: 1000,
    isPlaying: true, startedAt: 0, dominantColor: undefined,
  };
  const mk = (now: number) =>
    mkDeps({
      accessTokenCache: cache,
      refreshAccessToken,
      now,
      prev: null,
      spotify: { getNowPlaying: vi.fn(async () => np) },
    });

  await pollOneUser(mk(1000) as any);
  await pollOneUser(mk(2000) as any); // well within 50min skew
  expect(refreshAccessToken).toHaveBeenCalledTimes(1);
});

test("g. revoked refresh still triggers markNeedsReauth even with a cache", async () => {
  const cache = new Map<string, { accessToken: string; expiresAt: number }>();
  const deps = mkDeps({
    accessTokenCache: cache,
    prev: { ...base, artUrl: undefined, dominantColor: undefined } as any,
    refreshAccessToken: vi.fn(async () => {
      const e: any = new Error("revoked");
      e.revoked = true;
      throw e;
    }),
  });
  await pollOneUser(deps as any);
  expect(deps.db.markNeedsReauth).toHaveBeenCalledWith("u1", "spotify");
  expect(cache.has("dev1")).toBe(false); // nothing cached on failure
});

test("e. no activity_token → no push even on change", async () => {
  const prev = {
    trackId: "t0",
    title: "Old",
    artist: "A",
    album: "B",
    artUrl: undefined,
    durationMs: 100000,
    progressMs: 5000,
    isPlaying: true,
    startedAt: 0,
    dominantColor: undefined,
  };
  const deps = mkDeps({
    prev,
    now: 6000,
    device: {
      id: "dev1",
      user_id: "u1",
      ciphertext: "ct",
      nonce: "nc",
      activity_token: null,
      device_token: "dev-tok",
    },
  });
  const out = await pollOneUser(deps as any);
  expect(deps.apns.pushUpdate).not.toHaveBeenCalled();
  expect(deps.apns.pushStopped).not.toHaveBeenCalled();
  expect(deps.db.markPushResult).not.toHaveBeenCalled();
  expect(out!.trackId).toBe("t1");
});
