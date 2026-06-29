import { LibsodiumVault } from "../src/vault/libsodium.js";
const key = "a".repeat(64);          // 32 bytes hex
test("seal then open returns the plaintext", async () => {
  const v = new LibsodiumVault(key);
  const { ciphertext, nonce } = await v.seal("refresh-token-123");
  expect(await v.open(ciphertext, nonce)).toBe("refresh-token-123");
});
test("wrong key cannot open", async () => {
  const { ciphertext, nonce } = await new LibsodiumVault(key).seal("secret");
  await expect(new LibsodiumVault("b".repeat(64)).open(ciphertext, nonce)).rejects.toThrow();
});
