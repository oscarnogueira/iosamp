import { makeTestDb } from "./helpers/testDb.js";

test("upsertUser is idempotent on apple_sub", async () => {
  const db = await makeTestDb();
  const a = await db.upsertUser("sub-1");
  const b = await db.upsertUser("sub-1");
  expect(a.id).toBe(b.id);
});

test("provider token round-trips through the row", async () => {
  const db = await makeTestDb();
  const u = await db.upsertUser("sub-2");
  await db.saveProviderToken(u.id, "spotify", { ciphertext: "c", nonce: "n" });
  const row = await db.getProviderToken(u.id, "spotify");
  expect(row).toMatchObject({ ciphertext: "c", nonce: "n", needs_reauth: false });
});
