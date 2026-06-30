import Fastify from "fastify";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { makeDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { LibsodiumVault } from "./vault/libsodium.js";
import { verifyAppleIdentityToken } from "./auth/apple.js";
import {
  issueSession,
  issueRefresh,
  verifySession,
  verifyRefresh,
} from "./auth/session.js";
// The provider module exports BOTH a `spotify` object and `exchangeCode`/
// `refreshAccessToken` functions. Alias `spotify` to avoid colliding with the
// local `spotify` deps facade below.
import {
  spotify as spotifyProvider,
  exchangeCode,
  refreshAccessToken,
} from "./providers/spotify.js";

const cfg = loadConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl });
const db = makeDb(pool);

const vault = new LibsodiumVault(cfg.encryptionKeyHex);

const deps = {
  db,
  vault,
  apple: {
    verify: (idToken: string) => verifyAppleIdentityToken(idToken, cfg.apple.clientId),
  },
  session: {
    issue: (uid: string) => issueSession(uid, cfg.sessionSecret),
    issueRefresh: (uid: string) => issueRefresh(uid, cfg.sessionSecret),
    verify: (t: string) => verifySession(t, cfg.sessionSecret),
    verifyRefresh: (t: string) => verifyRefresh(t, cfg.sessionSecret),
  },
  spotify: {
    exchangeCode: (code: string, codeVerifier: string) =>
      exchangeCode(cfg.spotify.clientId, cfg.spotify.redirectUri, code, codeVerifier),
    getNowPlaying: spotifyProvider.getNowPlaying,
    control: spotifyProvider.control,
  },
  refreshAccessToken: (clientId: string, refresh: string) =>
    refreshAccessToken(clientId, refresh),
  clientId: cfg.spotify.clientId,
};

const app = Fastify({ logger: true });
registerRoutes(app, deps);
app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
