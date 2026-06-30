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

test("markPushResult clears active on 410", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("s2");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const d = await db.registerDevice(u.id, { deviceToken: "dt" });
  await db.setActivityToken(d.id, "at", null);
  await db.markPushResult(d.id, 410);
  expect((await db.activeDevices()).find(x => x.id === d.id)).toBeUndefined();
});
