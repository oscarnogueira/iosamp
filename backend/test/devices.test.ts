import { makeTestDb } from "./helpers/testDb.js";

test("register device token then activity token on same row", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("s");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", "pts");
  const active = await db.activeDevices();
  expect(active.find(x => x.id === d.id)).toMatchObject({ activity_token: "at", device_token: "dt" });
});

test("recent heartbeat keeps device active even with stale/absent last_push_ok_at", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("hb");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", null);
  // Steady state: a push happened long ago, but /activity/heartbeat keeps firing.
  await db.raw.query(
    `UPDATE devices SET last_push_ok_at = now() - interval '1 hour', last_heartbeat_at = now() WHERE id=$1`,
    [d.id],
  );
  expect((await db.activeDevices()).find(x => x.id === d.id)).toBeDefined();
});

test("device with both stale heartbeat and stale push drops out of active", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("hb2");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", null);
  await db.raw.query(
    `UPDATE devices SET last_push_ok_at = now() - interval '1 hour', last_heartbeat_at = now() - interval '1 hour' WHERE id=$1`,
    [d.id],
  );
  expect((await db.activeDevices()).find(x => x.id === d.id)).toBeUndefined();
});

test("markPushResult clears active on 410", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("s2");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", null);
  await db.markPushResult(d.id, 410);
  expect((await db.activeDevices()).find(x => x.id === d.id)).toBeUndefined();
});
