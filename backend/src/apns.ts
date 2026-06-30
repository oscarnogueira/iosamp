import http2 from "node:http2";
import jwt from "jsonwebtoken";

export function buildHeaders(
  token: string,
  pushType: "liveactivity" | "background",
  bundleId: string,
  priority: string,
): Record<string, string> {
  const topic =
    pushType === "liveactivity" ? `${bundleId}.push-type.liveactivity` : bundleId;
  return {
    ":method": "POST",
    ":path": `/3/device/${token}`,
    "apns-topic": topic,
    "apns-push-type": pushType,
    "apns-priority": priority,
  };
}

export function makeApns(cfg: {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8: string;
  host: string;
}) {
  let cached: { token: string; at: number } | null = null;

  function jwtToken() {
    const now = Date.now();
    if (!cached || now - cached.at > 50 * 60_000) {
      cached = {
        token: jwt.sign(
          { iss: cfg.teamId, iat: Math.floor(now / 1000) },
          cfg.p8,
          { algorithm: "ES256", header: { alg: "ES256", kid: cfg.keyId } },
        ),
        at: now,
      };
    }
    return cached.token;
  }

  function send(
    token: string,
    pushType: "liveactivity" | "background",
    payload: object,
    priority: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const client = http2.connect(cfg.host);
      const req = client.request({
        ...buildHeaders(token, pushType, cfg.bundleId, priority),
        authorization: `bearer ${jwtToken()}`,
      });

      let status = 0;
      let body = "";

      req.on("response", (h) => (status = Number(h[":status"])));
      req.setEncoding("utf8");
      // CRITICAL: drain the response body so the stream can reach "end".
      // Without this, error responses with a body (e.g. 410 Unregistered)
      // never emit "end" and the promise hangs forever.
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        client.close();
        resolve(status);
      });
      req.on("error", (e) => {
        client.close();
        reject(e);
      });
      req.setTimeout(10_000, () => {
        req.close();
        client.close();
        reject(new Error("apns timeout"));
      });

      req.end(JSON.stringify(payload));
    });
  }

  return {
    pushUpdate: (activityToken: string, contentState: object) =>
      send(
        activityToken,
        "liveactivity",
        {
          aps: {
            timestamp: Math.floor(Date.now() / 1000),
            event: "update",
            "content-state": contentState,
          },
        },
        "10",
      ),

    pushSilentWake: (deviceToken: string) =>
      send(deviceToken, "background", { aps: { "content-available": 1 } }, "5"),

    pushStopped: (activityToken: string) =>
      send(
        activityToken,
        "liveactivity",
        {
          aps: {
            timestamp: Math.floor(Date.now() / 1000),
            event: "update",
            "content-state": {
              isPlaying: false,
              title: "Nothing playing",
              artist: "",
              album: "",
              trackId: "",
              durationMs: 0,
              progressMs: 0,
              startedAt: 0,
            },
          },
        },
        "5",
      ),
  };
}
