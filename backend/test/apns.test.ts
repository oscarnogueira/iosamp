import { expect, test, afterAll } from "vitest";
import http2 from "node:http2";
import { generateKeyPairSync } from "node:crypto";
import { buildHeaders, makeApns } from "../src/apns.js";

// ── buildHeaders ──────────────────────────────────────────────

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

// ── send() resolves (not hangs) on 410 with body ──────────────

// Generate a real EC P-256 key so jwt.sign works
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const p8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

let server: http2.Http2Server;
let port: number;

// Start a local h2c server that always responds 410 with a JSON body
await new Promise<void>((resolve) => {
  server = http2.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(410, { "content-type": "application/json" });
      res.end(JSON.stringify({ reason: "Unregistered" }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as { port: number }).port;
    resolve();
  });
});

afterAll(() => {
  server.close();
});

test(
  "send() resolves to 410 without hanging when server sends a body",
  async () => {
    const apns = makeApns({
      keyId: "KEYID123",
      teamId: "TEAMID123",
      bundleId: "com.x.app",
      p8,
      host: `http://127.0.0.1:${port}`,
    });
    const status = await apns.pushUpdate("devicetoken", { isPlaying: true });
    expect(status).toBe(410);
  },
  5_000, // 5 s timeout — should resolve almost immediately
);
