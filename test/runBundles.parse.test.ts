import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
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
  const response = await worker.fetch(
    buildUpload({
      schema_version: 4,
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
      artifact_bytes: [1, 2, 3, 4],
      run_projection: {
        run_id: "run-001",
        status: "completed",
        ended_at_utc: "2026-05-26T00:00:00.000Z",
      },
      battle_projections: [],
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles returns 400 when player_account_id is whitespace", async () => {
  const response = await worker.fetch(
    buildUpload({
      schema_version: 4,
      player_account_id: "   ",
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
      artifact_bytes: [1, 2, 3, 4],
      run_projection: {
        run_id: "run-001",
        status: "completed",
        ended_at_utc: "2026-05-26T00:00:00.000Z",
      },
      battle_projections: [],
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});

test("POST /run-bundles writes runs row and stores R2 object on minimal valid payload", async () => {
  const response = await worker.fetch(
    buildUpload({
      schema_version: 4,
      player_account_id: "player-001",
      submitted_at_utc: "2026-05-26T00:00:00.000Z",
      artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
      artifact_bytes: [1, 2, 3, 4],
      run_projection: {
        run_id: "run-001",
        status: "completed",
        hero_id: "hero-a",
        hero_name: "HeroA",
        started_at_utc: "2026-05-26T08:30:00.000+08:00",
        ended_at_utc: "2026-05-26T09:00:00.000+08:00",
        final_day: 10,
        final_wins: 9,
        final_losses: 3,
      },
      battle_projections: [],
    }),
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
    buildUpload({
      schema_version: 4,
      player_account_id: "player-001",
      submitted_at_utc: "2026-05-26",
      artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
      artifact_bytes: [1, 2, 3, 4],
      run_projection: {
        run_id: "run-invalid-time",
        status: "completed",
        ended_at_utc: "2026-05-26T01:00:00.000Z",
      },
      battle_projections: [],
    }),
    env,
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_run_bundle_request" });
});
