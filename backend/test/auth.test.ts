import { vi, expect, test } from "vitest";

// vi.mock is hoisted by Vitest before imports, so this intercepts
// any jose import including the one inside apple.ts
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "apple-123" } })),
}));

import { issueSession, verifySession, issueRefresh, verifyRefresh } from "../src/auth/session.js";
import { verifyAppleIdentityToken } from "../src/auth/apple.js";
import { jwtVerify } from "jose";

// ── session tests ──────────────────────────────────────────────

test("session round-trips userId", () => {
  const t = issueSession("user-1", "secret");
  expect(verifySession(t, "secret").userId).toBe("user-1");
});

test("tampered session rejected", () => {
  expect(() => verifySession("bad.token.here", "secret")).toThrow();
});

test("refresh round-trips userId", () => {
  const t = issueRefresh("user-1", "secret");
  expect(verifyRefresh(t, "secret").userId).toBe("user-1");
});

test("session token rejected by verifyRefresh (typ !== refresh)", () => {
  const t = issueSession("user-1", "secret");
  expect(() => verifyRefresh(t, "secret")).toThrow();
});

// ── apple tests (jose is mocked — no network) ─────────────────

test("verifyAppleIdentityToken resolves to { sub }", async () => {
  const result = await verifyAppleIdentityToken("tok", "com.x.app");
  expect(result).toEqual({ sub: "apple-123" });
});

test("verifyAppleIdentityToken passes issuer + audience to jwtVerify", async () => {
  const mockJwtVerify = vi.mocked(jwtVerify);
  mockJwtVerify.mockClear();
  await verifyAppleIdentityToken("tok", "com.x.app");
  expect(mockJwtVerify).toHaveBeenCalledWith(
    "tok",
    expect.anything(),
    expect.objectContaining({
      issuer: "https://appleid.apple.com",
      audience: "com.x.app",
    }),
  );
});
