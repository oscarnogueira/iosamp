import { Pool } from "pg";

export interface UserRow { id: string; apple_sub: string }
export interface TokenRow { ciphertext: string; nonce: string; needs_reauth: boolean }

export function makeDb(pool: Pool) {
  return {
    async upsertUser(appleSub: string): Promise<UserRow> {
      const { rows } = await pool.query(
        `INSERT INTO users (apple_sub) VALUES ($1)
         ON CONFLICT (apple_sub) DO UPDATE SET apple_sub = EXCLUDED.apple_sub
         RETURNING id, apple_sub`,
        [appleSub],
      );
      return rows[0] as UserRow;
    },

    async saveProviderToken(
      userId: string,
      provider: string,
      enc: { ciphertext: string; nonce: string },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO provider_tokens (user_id, provider, ciphertext, nonce, needs_reauth, updated_at)
         VALUES ($1,$2,$3,$4,false,now())
         ON CONFLICT (user_id, provider)
         DO UPDATE SET ciphertext=$3, nonce=$4, needs_reauth=false, updated_at=now()`,
        [userId, provider, enc.ciphertext, enc.nonce],
      );
    },

    async getProviderToken(userId: string, provider: string): Promise<TokenRow | null> {
      const { rows } = await pool.query(
        `SELECT ciphertext, nonce, needs_reauth
         FROM provider_tokens
         WHERE user_id=$1 AND provider=$2`,
        [userId, provider],
      );
      return (rows[0] as TokenRow | undefined) ?? null;
    },

    async markNeedsReauth(userId: string, provider: string): Promise<void> {
      await pool.query(
        `UPDATE provider_tokens SET needs_reauth=true WHERE user_id=$1 AND provider=$2`,
        [userId, provider],
      );
    },

    raw: pool,
  };
}

export type Db = ReturnType<typeof makeDb>;
