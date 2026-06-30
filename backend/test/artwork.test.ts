import { vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// Must mock before importing the module under test
vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { dominantColorFromBytes, dominantColor } from "../src/artwork.js";
import { request } from "undici";

const mockRequest = vi.mocked(request);

beforeEach(() => {
  vi.clearAllMocks();
});

test("solid red image → ~#ff0000", async () => {
  const png = readFileSync(new URL("./fixtures/red.png", import.meta.url));
  const hex = await dominantColorFromBytes(png);
  expect(hex.toLowerCase()).toMatch(/^#f[ef]0{4}$/);  // allow rounding
});

test("dominantColor returns undefined when fetch returns 404", async () => {
  const dumpFn = vi.fn().mockResolvedValue(undefined);
  mockRequest.mockResolvedValue({
    statusCode: 404,
    body: { dump: dumpFn } as unknown as ReturnType<typeof request> extends Promise<infer R> ? R["body"] : never,
  } as unknown as Awaited<ReturnType<typeof request>>);

  const result = await dominantColor("http://example.com/art.jpg");
  expect(result).toBeUndefined();
  expect(dumpFn).toHaveBeenCalledOnce();
});

test("dominantColor returns undefined when fetch throws", async () => {
  mockRequest.mockRejectedValue(new Error("ECONNREFUSED"));
  const result = await dominantColor("http://localhost:1/art.jpg");
  expect(result).toBeUndefined();
});
