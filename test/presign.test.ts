import { expect, test } from "vitest";
import { env } from "cloudflare:test";

import { createR2Presigner } from "../src/crypto/presign";

test("createR2Presigner returns a URL with SigV4 query params + ISO expiry", async () => {
  const presigner = createR2Presigner(env);
  const result = await presigner.sign("run-bundles/foo/bar.mpack.gz", 300);

  const url = new URL(result.url);
  expect(url.hostname).toContain(env.R2_ACCOUNT_ID);
  expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]+$/);

  // expiresAtUtc must be ISO-8601 ~5 minutes in the future.
  const expires = new Date(result.expiresAtUtc).getTime();
  const skew = Math.abs(expires - (Date.now() + 300 * 1000));
  expect(skew).toBeLessThan(2000);
});

test("createR2Presigner throws when any R2 secret is missing", () => {
  const broken = { ...env, R2_ACCESS_KEY_ID: "" };
  expect(() => createR2Presigner(broken)).toThrow(/R2 SigV4 secrets missing/);
});
