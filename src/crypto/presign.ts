import { AwsClient } from "aws4fetch";

import type { Env } from "../env";

export interface R2Presigner {
  sign(objectKey: string, ttlSeconds: number): Promise<{
    url: string;
    expiresAtUtc: string;
  }>;
}

export function createR2Presigner(env: Env, bucketName: string): R2Presigner {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 SigV4 secrets missing; run `wrangler secret put R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY`",
    );
  }
  if (!bucketName) {
    throw new Error("R2 bucket name is required for presigned URLs");
  }

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const endpointHost = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  return {
    async sign(objectKey, ttlSeconds) {
      const issuedAt = Date.now();
      // Encode each path segment safely, but preserve the `/` between segments.
      const encodedKey = objectKey
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const target = new URL(`https://${endpointHost}/${bucketName}/${encodedKey}`);
      target.searchParams.set("X-Amz-Expires", String(ttlSeconds));

      const signed = await client.sign(
        new Request(target, { method: "GET" }),
        {
          aws: { signQuery: true },
        },
      );
      const expiresAtUtc = new Date(issuedAt + ttlSeconds * 1000).toISOString();
      return { url: signed.url, expiresAtUtc };
    },
  };
}
