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

    async registerDevice(userId: string, t: { deviceToken?: string }) {
      const { rows } = await pool.query(
        `INSERT INTO devices (user_id, device_token, active) VALUES ($1,$2,false) RETURNING *`,
        [userId, t.deviceToken ?? null],
      );
      return rows[0];
    },

    async setActivityToken(deviceId: string, activityToken: string, pushToStart: string | null) {
      await pool.query(
        `UPDATE devices SET activity_token=$2, push_to_start_token=$3, active=true,
           last_heartbeat_at=now(), updated_at=now() WHERE id=$1`,
        [deviceId, activityToken, pushToStart],
      );
    },

    async endActivity(deviceId: string) {
      await pool.query(`UPDATE devices SET active=false, updated_at=now() WHERE id=$1`, [deviceId]);
    },

    async heartbeat(deviceId: string) {
      await pool.query(`UPDATE devices SET last_heartbeat_at=now() WHERE id=$1`, [deviceId]);
    },

    async markPushResult(deviceId: string, status: number) {
      if (status === 410) {
        await pool.query(`UPDATE devices SET active=false WHERE id=$1`, [deviceId]);
        return;
      }
      if (status >= 200 && status < 300) {
        await pool.query(`UPDATE devices SET last_push_ok_at=now() WHERE id=$1`, [deviceId]);
      }
    },

    async activeDevices() {
      const { rows } = await pool.query(
        `SELECT d.id, d.user_id, d.device_token, d.activity_token, d.push_to_start_token,
                d.last_heartbeat_at, d.last_push_ok_at, d.active, d.updated_at,
                pt.ciphertext, pt.nonce, pt.needs_reauth
         FROM devices d
         JOIN provider_tokens pt ON pt.user_id = d.user_id AND pt.provider='spotify'
         WHERE d.active = true AND pt.needs_reauth = false
           AND (
             d.last_push_ok_at > now() - interval '15 minutes'
             OR (d.last_push_ok_at IS NULL
                 AND COALESCE(d.last_heartbeat_at, d.updated_at) > now() - interval '15 minutes')
           )`,
      );
      return rows;
    },

    raw: pool,
  };
}

export type Db = ReturnType<typeof makeDb>;
