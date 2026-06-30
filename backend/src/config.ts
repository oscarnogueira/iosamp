export interface Config {
  spotify: { clientId: string; redirectUri: string };
  apns: { keyId: string; teamId: string; bundleId: string; p8: string; host: string };
  apple: { clientId: string };
  encryptionKeyHex: string;
  sessionSecret: string;
  databaseUrl: string;
}

const REQUIRED = ["SPOTIFY_CLIENT_ID","SPOTIFY_REDIRECT_URI","APNS_KEY_ID",
  "APNS_TEAM_ID","APNS_BUNDLE_ID","APNS_P8","ENCRYPTION_KEY","DATABASE_URL",
  "APPLE_CLIENT_ID","SESSION_SECRET"] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const k of REQUIRED) if (!env[k]) throw new Error(`Missing required secret: ${k}`);
  if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY!))
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  return {
    spotify: { clientId: env.SPOTIFY_CLIENT_ID!, redirectUri: env.SPOTIFY_REDIRECT_URI! },
    apns: { keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID!, bundleId: env.APNS_BUNDLE_ID!, p8: env.APNS_P8!,
            host: env.APNS_HOST ?? "https://api.development.push.apple.com" },
    apple: { clientId: env.APPLE_CLIENT_ID! },
    encryptionKeyHex: env.ENCRYPTION_KEY!,
    sessionSecret: env.SESSION_SECRET!,
    databaseUrl: env.DATABASE_URL!,
  };
}
