import type { FastifyInstance } from "fastify";

// deps: { db, vault, apple:{verify}, session:{issue,issueRefresh,verify,verifyRefresh},
//         spotify:{exchangeCode,getNowPlaying,control}, refreshAccessToken, clientId }
export function registerRoutes(app: FastifyInstance, deps: any) {
  const auth = async (req: any, reply: any) => {
    const h = req.headers.authorization?.replace("Bearer ", "");
    try {
      req.userId = deps.session.verify(h).userId;
    } catch {
      reply.code(401).send({ error: "unauthorized" });
    }
  };

  async function userAccessToken(userId: string): Promise<string> {
    const row = await deps.db.getProviderToken(userId, "spotify");
    if (!row || row.needs_reauth) throw new Error("needs-reauth");
    const refresh = await deps.vault.open(row.ciphertext, row.nonce);
    return (await deps.refreshAccessToken(deps.clientId, refresh)).access_token;
  }

  app.post("/auth/apple", async (req: any) => {
    const { sub } = await deps.apple.verify(req.body.idToken);
    const user = await deps.db.upsertUser(sub);
    return {
      sessionToken: deps.session.issue(user.id),
      refreshToken: deps.session.issueRefresh(user.id),
    };
  });

  app.post("/auth/refresh", async (req: any, reply: any) => {
    try {
      return {
        sessionToken: deps.session.issue(deps.session.verifyRefresh(req.body.refreshToken).userId),
      };
    } catch {
      reply.code(401).send({ error: "bad refresh" });
    }
  });

  app.post("/spotify/connect", { preHandler: auth }, async (req: any) => {
    const tok = await deps.spotify.exchangeCode(req.body.code, req.body.codeVerifier);
    await deps.db.saveProviderToken(req.userId, "spotify", await deps.vault.seal(tok.refresh_token));
    return { ok: true };
  });

  app.post("/device/register", { preHandler: auth }, async (req: any) =>
    deps.db.registerDevice(req.userId, { deviceToken: req.body.deviceToken }),
  );

  app.post("/activity/register", { preHandler: auth }, async (req: any) => {
    await deps.db.setActivityToken(
      req.body.deviceId,
      req.body.activityToken,
      req.body.pushToStartToken ?? null,
    );
    return { ok: true };
  });

  app.post("/activity/heartbeat", { preHandler: auth }, async (req: any) => {
    await deps.db.heartbeat(req.body.deviceId);
    return { ok: true };
  });

  app.post("/activity/end", { preHandler: auth }, async (req: any) => {
    await deps.db.endActivity(req.body.deviceId);
    return { ok: true };
  });

  app.post("/control", { preHandler: auth }, async (req: any) => {
    await deps.spotify.control(await userAccessToken(req.userId), req.body.action);
    return { ok: true };
  });

  app.get("/nowplaying/current", { preHandler: auth }, async (req: any) =>
    (await deps.spotify.getNowPlaying(await userAccessToken(req.userId))) ?? null,
  );

  app.get("/health", async () => ({ ok: true }));
}
