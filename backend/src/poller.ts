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

function toContentState(np: NowPlaying) {
  return { trackId: np.trackId, title: np.title, artist: np.artist, album: np.album,
    artUrl: np.artUrl, durationMs: np.durationMs, progressMs: np.progressMs,
    isPlaying: np.isPlaying, startedAt: np.startedAt, dominantColor: np.dominantColor };
}

// All collaborators injected via deps — no concrete imports.
// deps.refreshAccessToken(clientId, refreshToken) → { access_token }.
// Access tokens last ~1h; cache them per device so we only call refreshAccessToken
// at most ~once per skew window instead of every 10s tick.
const ACCESS_TOKEN_SKEW_MS = 50 * 60 * 1000;

export async function pollOneUser(deps: {
  device: any; vault: any; db: any; spotify: any; apns: any; artwork: any;
  refreshAccessToken: (clientId: string, refresh: string) => Promise<{ access_token: string }>;
  clientId: string; prev: NowPlaying | null; now: number;
  accessTokenCache?: Map<string, { accessToken: string; expiresAt: number }>;
}): Promise<NowPlaying | null> {
  const { device, vault, db, spotify, apns, artwork, refreshAccessToken, clientId, prev, now, accessTokenCache } = deps;
  let access: string;
  const cached = accessTokenCache?.get(device.id);
  if (cached && cached.expiresAt > now) {
    access = cached.accessToken;
  } else {
    const refresh = await vault.open(device.ciphertext, device.nonce);
    try {
      access = (await refreshAccessToken(clientId, refresh)).access_token;
    } catch (e: any) {
      if (e.revoked) { await db.markNeedsReauth(device.user_id, "spotify"); return prev; }
      return prev;                          // transient refresh error: keep last
    }
    accessTokenCache?.set(device.id, { accessToken: access, expiresAt: now + ACCESS_TOKEN_SKEW_MS });
  }
  let cur: NowPlaying | null;
  try { cur = await spotify.getNowPlaying(access); }
  catch (e: any) {
    return prev;                            // 401/429/5xx/timeout: keep last, recover next tick
  }
  const elapsed = prev ? now - prev.startedAt - prev.progressMs : 0;
  if (changed(prev, cur, Math.max(0, elapsed))) {
    if (!device.activity_token) return cur;
    let status: number;
    if (cur) {
      cur.dominantColor = cur.artUrl ? await artwork.dominantColor(cur.artUrl) : undefined;
      status = await apns.pushUpdate(device.activity_token, toContentState(cur));
      await db.markPushResult(device.id, status);
      if (device.device_token) {
        const silentStatus = await apns.pushSilentWake(device.device_token);
        await db.markPushResult(device.id, silentStatus);   // a 410 here deactivates too
      }
    } else {
      status = await apns.pushStopped(device.activity_token);
      await db.markPushResult(device.id, status);
    }
  }
  return cur;
}
