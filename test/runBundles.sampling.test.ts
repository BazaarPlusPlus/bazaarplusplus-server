import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import type { Env } from "../src/env";
import { handleUploadRunBundle } from "../src/features/runBundles/upload";
import {
  buildRunBundleMultipartUpload,
  runBundleMetadata,
} from "./helpers/runBundleUpload";
import { countRows, resetTestState, selectFirst } from "./helpers/seed";

// FNV-1a buckets under the shipped sampling gate: "run-sample-0" lands on 34
// (kept at 50%) and "run-sample-1" on 53 (dropped at 50%).
const KeptRunId = "run-sample-0";
const DroppedRunId = "run-sample-1";

function envWithKeepPercent(keepPercent: string | undefined): Env {
  return { ...env, RUN_BUNDLE_KEEP_PERCENT: keepPercent } as unknown as Env;
}

function upload(runId: string, keepPercent: string | undefined): Promise<Response> {
  return handleUploadRunBundle(
    buildRunBundleMultipartUpload({ metadata: runBundleMetadata({ runId }) }),
    envWithKeepPercent(keepPercent),
  );
}

beforeEach(async () => {
  await resetTestState(env);
});

test("sampled-out run answers accepted but writes nothing", async () => {
  const response = await upload(DroppedRunId, "50");

  expect(response.status).toBe(200);
  const body = await response.json<{ status: string; run_id: string; object_key: string }>();
  expect(body.status).toBe("accepted");
  expect(body.run_id).toBe(DroppedRunId);
  expect(body.object_key).toMatch(/^run-bundles\/[0-9a-f-]+\.mpack\.gz$/);

  expect(await countRows(env.DB, "runs")).toBe(0);
  expect(await countRows(env.DB, "seen_player_accounts")).toBe(0);
  expect((await env.RUN_BUNDLE_BUCKET.list()).objects).toHaveLength(0);
  expect(await env.RUN_BUNDLE_BUCKET.head(body.object_key)).toBeNull();
});

test("run inside the keep band ingests normally", async () => {
  const response = await upload(KeptRunId, "50");

  expect(response.status).toBe(200);
  const row = await selectFirst<{ object_key: string }>(
    env.DB,
    "SELECT object_key FROM runs WHERE run_id = ?",
    [KeptRunId],
  );
  expect(row).not.toBeNull();
  expect(await env.RUN_BUNDLE_BUCKET.head(row!.object_key)).not.toBeNull();
});

test("sampling verdict is stable across retries of the same run_id", async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await upload(DroppedRunId, "50");
    expect(response.status).toBe(200);
  }

  expect(await countRows(env.DB, "runs")).toBe(0);
});

test("missing or unparseable keep percent ingests everything", async () => {
  for (const keepPercent of [undefined, "not-a-number"]) {
    await resetTestState(env);
    const response = await upload(DroppedRunId, keepPercent);

    expect(response.status).toBe(200);
    expect(await countRows(env.DB, "runs")).toBe(1);
  }
});

test("keep percent 0 drops every run", async () => {
  await upload(KeptRunId, "0");
  await upload(DroppedRunId, "0");

  expect(await countRows(env.DB, "runs")).toBe(0);
});

test("keep percent 50 lands near half of a run_id population", async () => {
  for (let index = 0; index < 40; index += 1) {
    const response = await upload(`run-sample-${index}`, "50");
    expect(response.status).toBe(200);
  }

  // Deliberately a band, not an exact count: this asserts the gate samples
  // rather than pinning the suite to the current hash function.
  const kept = await countRows(env.DB, "runs");
  expect(kept).toBeGreaterThan(10);
  expect(kept).toBeLessThan(30);
});
