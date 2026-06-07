import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import {
  buildRunBundleMultipartUpload,
  runBundleMetadata,
} from "./helpers/runBundleUpload";
import { countRows, resetTestState, selectFirst } from "./helpers/seed";

function buildUpload(body: unknown): Request {
  return new Request("https://example.com/run-bundles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function buildDotNetStyleMultipartUpload(metadata: Record<string, unknown>): Request {
  const encoder = new TextEncoder();
  const boundary = "5933aec4-165b-4fdc-a827-69303c9b71cb";
  const artifactBytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
  const body = concatBytes([
    encoder.encode(
      `--${boundary}\r\n`
      + "Content-Type: application/json; charset=utf-8\r\n"
      + 'Content-Disposition: form-data; name="metadata"\r\n'
      + "\r\n"
      + `${JSON.stringify(metadata)}\r\n`,
    ),
    encoder.encode(
      `--${boundary}\r\n`
      + "Content-Type: application/x-bpp-runbundle+msgpack+gzip\r\n"
      + 'Content-Disposition: form-data; name="artifact"; filename="run-bundle.mpack.gz"\r\n'
      + "\r\n",
    ),
    artifactBytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ]);

  const request = new Request("https://example.com/run-bundles", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary="${boundary}"`,
      "content-length": String(body.byteLength),
    },
    body,
  });
  return request;
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
  expect(body.object_key).toMatch(
    /^run-bundles\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mpack\.gz$/,
  );
  expect(body.object_key).not.toContain("player-001");
  expect(body.object_key).not.toContain("run-001");

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

test("POST /run-bundles accepts quoted-boundary multipart through the byte parser", async () => {
  const response = await worker.fetch(
    buildDotNetStyleMultipartUpload(runBundleMetadata({ runId: "run-quoted-boundary" })),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{ run_id: string; size_bytes: number }>(
    env.DB,
    "SELECT run_id, size_bytes FROM runs WHERE run_id = ?",
    ["run-quoted-boundary"],
  );
  expect(row).toEqual({ run_id: "run-quoted-boundary", size_bytes: 8 });
});

test("POST /run-bundles normalizes malformed run timestamps instead of rejecting the bundle", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata({ runId: "run-invalid-time" }),
        submitted_at_utc: "2026-05-26",
        run_projection: {
          run_id: "run-invalid-time",
          status: "completed",
          started_at_utc: "not-a-time",
          ended_at_utc: "also-not-a-time",
        },
      },
    }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{
    started_at_utc: string | null;
    ended_at_utc: string;
    submitted_at_utc: string;
  }>(env.DB, "SELECT started_at_utc, ended_at_utc, submitted_at_utc FROM runs WHERE run_id = ?", [
    "run-invalid-time",
  ]);
  expect(row?.started_at_utc).toBeNull();
  expect(Date.parse(row!.ended_at_utc)).not.toBeNaN();
  expect(Date.parse(row!.submitted_at_utc)).not.toBeNaN();
});

test("POST /run-bundles defaults missing status instead of rejecting the bundle", async () => {
  const metadata = runBundleMetadata({ runId: "run-missing-status" });
  metadata.run_projection = {
    ...(metadata.run_projection as Record<string, unknown>),
    status: "",
  };

  const response = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{ status: string }>(
    env.DB,
    "SELECT status FROM runs WHERE run_id = ?",
    ["run-missing-status"],
  );
  expect(row).toEqual({ status: "completed" });
});

test("POST /run-bundles defaults missing metadata artifact codec", async () => {
  const metadata = runBundleMetadata({ runId: "run-missing-codec" });
  delete metadata.artifact_codec;

  const response = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{ codec: string }>(
    env.DB,
    "SELECT codec FROM runs WHERE run_id = ?",
    ["run-missing-codec"],
  );
  expect(row).toEqual({
    codec: "application/x-bpp-runbundle+msgpack+gzip",
  });
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

test("POST /run-bundles returns 400 invalid_run_bundle_request for malformed multipart", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/run-bundles", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "not a valid multipart body",
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles rejects declared request bodies larger than the artifact cap", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/run-bundles", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data",
        "content-length": String(8 * 1024 * 1024 + 1),
      },
      body: "size is checked before multipart parsing",
    }),
    env,
  );

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "payload_too_large" });
});

test("POST /run-bundles accepts ids that are no longer used as object-key segments", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata({ runId: "run:from:game", uploader: "." }),
      },
    }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{
    run_id: string;
    player_account_id: string;
  }>(env.DB, "SELECT run_id, player_account_id FROM runs WHERE run_id = ?", [
    "run:from:game",
  ]);
  expect(row).toEqual({ run_id: "run:from:game", player_account_id: "." });
});

test("POST /run-bundles rejects too many battle projections", async () => {
  const runId = "run-too-many-battles";
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: runBundleMetadata({
        runId,
        battles: Array.from({ length: 201 }, (_, index) => ({
          battle_id: `battle-${index}`,
          run_id: runId,
        })),
      }),
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "too_many_battle_projections" });
});

test("POST /run-bundles returns 400 invalid_run_bundle_request when metadata JSON is literal null", async () => {
  const form = new FormData();
  form.set("metadata", "null");
  form.set(
    "artifact",
    new File([new Uint8Array([1, 2, 3, 4])], "run-bundle.mpack.gz", {
      type: "application/x-bpp-runbundle+msgpack+gzip",
    }),
  );

  const response = await worker.fetch(
    new Request("https://example.com/run-bundles", { method: "POST", body: form }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles skips null battle projection elements and writes the valid ones", async () => {
  const metadata = runBundleMetadata({ runId: "run-null-battle" });
  metadata.battle_projections = [
    null,
    {
      battle_id: "battle-null-sibling",
      run_id: "run-null-battle",
      opponent_account_id: "player-001",
    },
  ];

  const response = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{ battle_id: string }>(
    env.DB,
    "SELECT battle_id FROM battles WHERE run_id = ?",
    ["run-null-battle"],
  );
  expect(row).toEqual({ battle_id: "battle-null-sibling" });
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("POST /run-bundles clamps far-future run timestamps to server receive time", async () => {
  const beforeMs = Date.now();
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata({ runId: "run-future-run" }),
        submitted_at_utc: "2999-01-01T00:00:00.000Z",
        run_projection: {
          run_id: "run-future-run",
          status: "completed",
          started_at_utc: "2999-01-01T00:00:00.000Z",
          ended_at_utc: "2999-01-01T01:00:00.000Z",
        },
      },
    }),
    env,
  );
  const afterMs = Date.now();

  expect(response.status).toBe(200);
  const row = await selectFirst<{
    started_at_utc: string | null;
    ended_at_utc: string;
    submitted_at_utc: string;
  }>(env.DB, "SELECT started_at_utc, ended_at_utc, submitted_at_utc FROM runs WHERE run_id = ?", [
    "run-future-run",
  ]);
  expect(row?.started_at_utc).toBeNull();
  expect(Date.parse(row!.submitted_at_utc)).toBeGreaterThanOrEqual(beforeMs);
  expect(Date.parse(row!.submitted_at_utc)).toBeLessThanOrEqual(afterMs);
  expect(Date.parse(row!.ended_at_utc)).toBeGreaterThanOrEqual(beforeMs);
  expect(Date.parse(row!.ended_at_utc)).toBeLessThanOrEqual(afterMs);
});

test("far-future submitted_at_utc cannot poison the battle recorded_at fallback", async () => {
  const beforeMs = Date.now();
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: {
        ...runBundleMetadata({
          runId: "run-future-fallback",
          battles: [
            {
              battle_id: "battle-missing-recorded-at",
              run_id: "run-future-fallback",
              opponent_account_id: "player-001",
            },
            {
              battle_id: "battle-future-recorded-at",
              run_id: "run-future-fallback",
              recorded_at_utc: "2999-01-01T00:00:00.000Z",
              opponent_account_id: "player-001",
            },
          ],
        }),
        submitted_at_utc: "2999-01-01T00:00:00.000Z",
      },
    }),
    env,
  );
  const afterMs = Date.now();

  expect(response.status).toBe(200);
  const rows = await env.DB.prepare(
    "SELECT battle_id, recorded_at_utc FROM battles WHERE run_id = ? ORDER BY battle_id",
  )
    .bind("run-future-fallback")
    .all<{ battle_id: string; recorded_at_utc: string }>();
  expect(rows.results.map((row) => row.battle_id)).toEqual([
    "battle-future-recorded-at",
    "battle-missing-recorded-at",
  ]);
  for (const row of rows.results) {
    expect(Date.parse(row.recorded_at_utc)).toBeGreaterThanOrEqual(beforeMs);
    expect(Date.parse(row.recorded_at_utc)).toBeLessThanOrEqual(afterMs);
  }
});

test("POST /run-bundles normalizes far-future battle timestamps", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: runBundleMetadata({
        runId: "run-future-battle",
        battles: [
          {
            battle_id: "battle-future",
            run_id: "run-future-battle",
            recorded_at_utc: "2999-01-01T00:00:00.000Z",
            opponent_account_id: "player-001",
          },
        ],
      }),
    }),
    env,
  );

  expect(response.status).toBe(200);
  const row = await selectFirst<{ recorded_at_utc: string }>(
    env.DB,
    "SELECT recorded_at_utc FROM battles WHERE battle_id = ?",
    ["battle-future"],
  );
  expect(row?.recorded_at_utc).toBe("2026-05-26T00:00:00.000Z");
});
