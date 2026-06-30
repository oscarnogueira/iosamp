export interface TokenVault {
  seal(plaintext: string): Promise<{ ciphertext: string; nonce: string }>;
  open(ciphertext: string, nonce: string): Promise<string>;
}
