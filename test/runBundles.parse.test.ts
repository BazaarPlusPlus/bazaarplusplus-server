import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import {
  buildRunBundleMultipartUpload,
  runBundleMetadata,
} from "./helpers/runBundleUpload";
import { resetTestState, selectFirst } from "./helpers/seed";

function buildUpload(body: unknown): Request {
  return new Request("https://example.com/run-bundles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetTestState(env);
});

test("POST /run-bundles returns 400 invalid_run_bundle_request when player_account_id missing", async () => {
  const metadata = runBundleMetadata();
  delete metadata.player_account_id;

  const response = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles returns 400 when player_account_id is whitespace", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata(),
        player_account_id: "   ",
      },
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles writes runs row and stores R2 object on minimal valid payload", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata: runBundleMetadata() }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    status: string;
    run_id: string;
    object_key: string;
  };
  expect(body.status).toBe("accepted");
  expect(body.run_id).toBe("run-001");
  expect(body.object_key).toMatch(/^run-bundles\/player-001\/run-001\/.+\.mpack\.gz$/);

  const r2 = await env.RUN_BUNDLE_BUCKET.head(body.object_key);
  expect(r2).not.toBeNull();

  const row = await selectFirst<{
    run_id: string;
    player_account_id: string;
    status: string;
    hero_name: string;
    started_at_utc: string;
    ended_at_utc: string;
    final_day: number;
  }>(env.DB, "SELECT * FROM runs WHERE run_id = ?", ["run-001"]);
  expect(row).toMatchObject({
    run_id: "run-001",
    player_account_id: "player-001",
    status: "completed",
    hero_name: "HeroA",
    started_at_utc: "2026-05-26T00:30:00.000Z",
    ended_at_utc: "2026-05-26T01:00:00.000Z",
    final_day: 10,
  });
});

test("POST /run-bundles rejects malformed timestamps", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata({ runId: "run-invalid-time" }),
        submitted_at_utc: "2026-05-26",
      },
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles rejects legacy JSON artifact bodies", async () => {
  const response = await worker.fetch(
    buildUpload({
      schema_version: 4,
      player_account_id: "player-001",
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
      artifact_bytes: [1, 2, 3, 4],
      run_projection: {
        run_id: "run-json",
        status: "completed",
        ended_at_utc: "2026-05-26T01:00:00.000Z",
      },
      battle_projections: [],
    }),
    env,
  );

  expect(response.status).toBe(415);
  expect(await response.json()).toEqual({ error: "unsupported_content_type" });
});
