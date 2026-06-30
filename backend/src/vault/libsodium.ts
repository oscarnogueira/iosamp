import _sodium from "libsodium-wrappers";
import type { TokenVault } from "./vault.js";
export class LibsodiumVault implements TokenVault {
  constructor(private keyHex: string) {}
  private async key() {
    await _sodium.ready;
    return _sodium.from_hex(this.keyHex);
  }
  async seal(plaintext: string) {
    const s = _sodium; await s.ready;
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const ct = s.crypto_secretbox_easy(s.from_string(plaintext), nonce, await this.key());
    return { ciphertext: s.to_base64(ct), nonce: s.to_base64(nonce) };
  }
  async open(ciphertext: string, nonce: string) {
    const s = _sodium; await s.ready;
    const pt = s.crypto_secretbox_open_easy(s.from_base64(ciphertext), s.from_base64(nonce), await this.key());
    return s.to_string(pt);
  }
}
