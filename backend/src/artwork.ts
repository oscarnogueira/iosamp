import sharp from "sharp";
import { request } from "undici";

export async function dominantColorFromBytes(bytes: Buffer | Uint8Array): Promise<string> {
  const { data } = await sharp(bytes)
    .resize(1, 1, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [r = 0, g = 0, b = 0] = data;
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

export async function dominantColor(artUrl: string): Promise<string | undefined> {
  try {
    const res = await request(artUrl);
    if (res.statusCode !== 200) {
      await res.body.dump();
      return undefined;
    }
    return await dominantColorFromBytes(Buffer.from(await res.body.arrayBuffer()));
  } catch {
    return undefined;
  }
}
