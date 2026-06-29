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
test("apns.host defaults to the development APNs URL (full URL — consumed by http2.connect)", () => {
  const env = {
    SPOTIFY_CLIENT_ID: "x", SPOTIFY_REDIRECT_URI: "standbynp://cb",
    APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_BUNDLE_ID: "b", APNS_P8: "p8",
    ENCRYPTION_KEY: "0".repeat(64), DATABASE_URL: "postgres://x",
    APPLE_CLIENT_ID: "com.x.app", SESSION_SECRET: "s",
  };
  expect(loadConfig(env).apns.host).toBe("https://api.development.push.apple.com");
  expect(loadConfig({ ...env, APNS_HOST: "https://api.push.apple.com" }).apns.host).toBe("https://api.push.apple.com");
});
