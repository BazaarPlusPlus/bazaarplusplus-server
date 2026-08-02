import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { createBundleDownloadSigner } from "../src/r2/presigner";
import { RecordingBundleDownloadSigner } from "./fixtures/presigner";

describe("Bundle download presigner adapters", () => {
  test("the production adapter fixes the R2 endpoint, object, operation and 7-day expiry", async () => {
    const issuedAt = 1_785_628_800_000;
    const key = "bundles/2026-08-02/01J00000000000000000000801.bundle";
    const signed = await createBundleDownloadSigner(env).sign(key, issuedAt);
    const url = new URL(signed.url);

    expect(url.hostname).toBe(
      "bazaarplusplus-bundle-v5.test-account-id.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
    expect(signed.expiresAtMs).toBe(issuedAt + 604_800_000);
  });

  test("the test adapter records keys without network access", async () => {
    const signer = new RecordingBundleDownloadSigner();
    const signed = await signer.sign(
      "bundles/2026-08-02/01J00000000000000000000802.bundle",
      1000,
    );
    expect(signer.calls).toEqual([
      {
        objectKey: "bundles/2026-08-02/01J00000000000000000000802.bundle",
        issuedAtMs: 1000,
      },
    ]);
    expect(signed).toEqual({
      url: "https://fake.invalid/bundles%2F2026-08-02%2F01J00000000000000000000802.bundle?method=GET&expires=604800",
      expiresAtMs: 604_801_000,
    });
  });
});
