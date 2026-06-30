import jwt from "jsonwebtoken";

export function issueSession(userId: string, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: "1h" });
}

export function issueRefresh(userId: string, secret: string): string {
  return jwt.sign({ sub: userId, typ: "refresh" }, secret, { expiresIn: "60d" });
}

export function verifySession(token: string, secret: string): { userId: string } {
  const p = jwt.verify(token, secret) as { sub: string; typ?: string };
  if (p.typ === "refresh") throw new Error("refresh token not valid as session");
  return { userId: p.sub };
}

export function verifyRefresh(token: string, secret: string): { userId: string } {
  const p = jwt.verify(token, secret) as { sub: string; typ?: string };
  if (p.typ !== "refresh") throw new Error("not a refresh token");
  return { userId: p.sub };
}
