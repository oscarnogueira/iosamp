import { request } from "undici";
import type { MusicProvider, NowPlaying, ControlAction } from "./types.js";

const API = "https://api.spotify.com";
const ACCOUNTS = "https://accounts.spotify.com";

export async function exchangeCode(
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const res = await request(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.statusCode !== 200) throw new Error(`spotify token exchange ${res.statusCode}`);
  return (await res.body.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

export async function refreshAccessToken(clientId: string, refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await request(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.statusCode === 400) {
    const e: any = new Error("refresh revoked");
    e.revoked = true;
    throw e;
  }
  if (res.statusCode !== 200) throw new Error(`spotify refresh ${res.statusCode}`);
  return (await res.body.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
}

export const spotify: MusicProvider = {
  id: "spotify",
  kind: "server-poll",

  async getNowPlaying(accessToken: string): Promise<NowPlaying | null> {
    const res = await request(`${API}/v1/me/player/currently-playing`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.statusCode === 204) return null;
    if (res.statusCode === 401) {
      const e: any = new Error("expired");
      e.expired = true;
      throw e;
    }
    if (res.statusCode === 429) {
      const e: any = new Error("rate-limited");
      e.retryAfter = Number(res.headers["retry-after"] ?? "1");
      throw e;
    }
    if (res.statusCode !== 200) throw new Error(`spotify currently-playing ${res.statusCode}`);
    const b: any = await res.body.json();
    if (!b.item) return null;
    return {
      trackId: b.item.id,
      title: b.item.name,
      artist: (b.item.artists ?? []).map((a: any) => a.name).join(", "),
      album: b.item.album?.name ?? "",
      artUrl: b.item.album?.images?.[0]?.url,
      durationMs: b.item.duration_ms,
      progressMs: b.progress_ms ?? 0,
      isPlaying: !!b.is_playing,
      startedAt: Date.now() - (b.progress_ms ?? 0),
    };
  },

  async control(accessToken: string, action: ControlAction): Promise<void> {
    const auth = { authorization: `Bearer ${accessToken}` };
    const call = (method: string, path: string) =>
      request(`${API}${path}`, { method, headers: auth });

    if (action === "next") {
      await call("POST", "/v1/me/player/next");
      return;
    }
    if (action === "prev") {
      await call("POST", "/v1/me/player/previous");
      return;
    }
    // playpause: fetch current state then toggle
    const res = await request(`${API}/v1/me/player`, { headers: auth });
    const playing =
      res.statusCode === 200 ? ((await res.body.json()) as any).is_playing : false;
    await call("PUT", playing ? "/v1/me/player/pause" : "/v1/me/player/play");
  },
};
