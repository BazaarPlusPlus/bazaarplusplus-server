import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import { resetTestState } from "./helpers/seed";

const PullAuth = { Authorization: "Bearer test-pull-token" };

beforeEach(async () => {
  await resetTestState(env);
});

async function setupRunWithR2Object(): Promise<{ runId: string; objectKey: string }> {
  const objectKey = "run-bundles/abcd.mpack.gz";
  await env.RUN_BUNDLE_BUCKET.put(objectKey, new Uint8Array([1, 2, 3, 4]));
  const nowUtc = "2026-05-26T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO runs (run_id, player_account_id, payload_hash, schema_version,
      object_key, codec, size_bytes, status, ended_at_utc,
      submitted_at_utc, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "run-R1", "uploader-1", "abcd", 5, objectKey,
      "application/x-bpp-runbundle+msgpack+gzip", 4, "completed", nowUtc,
      nowUtc, nowUtc, nowUtc,
    )
    .run();
  return { runId: "run-R1", objectKey };
}

function downloadLinkRequest(runId: string, headers?: HeadersInit): Request {
  return new Request(`https://example.com/run-bundles/${runId}/download-link`, {
    method: "POST",
    headers,
  });
}

test("POST /run-bundles/:run_id/download-link returns 401 without bearer token", async () => {
  await setupRunWithR2Object();
  const response = await worker.fetch(downloadLinkRequest("run-R1"), env);
  expect(response.status).toBe(401);
});

test("POST /run-bundles/:run_id/download-link returns 401 with wrong bearer token", async () => {
  await setupRunWithR2Object();
  const response = await worker.fetch(
    downloadLinkRequest("run-R1", { Authorization: "Bearer wrong-token" }),
    env,
  );
  expect(response.status).toBe(401);
});

test("POST /run-bundles/:run_id/download-link returns 400 bad_request on malformed percent-encoding (before auth)", async () => {
  // Malformed escape makes decodeURIComponent throw in matchRoute, which returns
  // the route's decodeErrorCode. Sent without a token to pin decode-before-auth:
  // routing-layer 400 must win over the handler's 401.
  const response = await worker.fetch(
    new Request("https://example.com/run-bundles/%zz/download-link", { method: "POST" }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "bad_request" });
});

test("POST /run-bundles/:run_id/download-link returns 404 run_not_found when unknown", async () => {
  const response = await worker.fetch(downloadLinkRequest("missing", PullAuth), env);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "run_not_found" });
});

test("POST /run-bundles/:run_id/download-link returns 410 artifact_expired when R2 object gone", async () => {
  const { runId, objectKey } = await setupRunWithR2Object();
  await env.RUN_BUNDLE_BUCKET.delete(objectKey);

  const response = await worker.fetch(downloadLinkRequest(runId, PullAuth), env);
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "artifact_expired" });
});

test("POST /run-bundles/:run_id/download-link returns presigned URL + bundle metadata", async () => {
  const { runId } = await setupRunWithR2Object();
  const response = await worker.fetch(downloadLinkRequest(runId, PullAuth), env);

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    run_id: string;
    download_url: string;
    expires_at_utc: string;
    codec: string;
    schema_version: number;
    size_bytes: number;
  };
  expect(body.run_id).toBe(runId);
  expect(body.download_url).toContain("X-Amz-Signature");
  expect(body.download_url).toContain("X-Amz-Expires=300");
  // Assert a *valid* ISO timestamp, not merely that the Date ctor doesn't throw
  // (it never throws — `new Date("banana")` yields an Invalid Date silently).
  const expiresAt = new Date(body.expires_at_utc);
  expect(Number.isNaN(expiresAt.getTime())).toBe(false);
  expect(expiresAt.toISOString()).toBe(body.expires_at_utc);
  expect(body.codec).toBe("application/x-bpp-runbundle+msgpack+gzip");
  expect(body.schema_version).toBe(5);
  expect(body.size_bytes).toBe(4);
});
