import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import { resetTestState } from "./helpers/seed";

beforeEach(async () => {
  await resetTestState(env);
});

async function uploadFinalBattle(runId: string, uploader: string, opponent: string): Promise<void> {
  await worker.fetch(
    new Request("https://example.com/run-bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 4,
        player_account_id: uploader,
        submitted_at_utc: new Date().toISOString(),
        artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
        artifact_bytes: [1, 2, 3, 4],
        run_projection: {
          run_id: runId,
          status: "completed",
          ended_at_utc: new Date().toISOString(),
        },
        battle_projections: [{
          battle_id: `${runId}-b1`,
          run_id: runId,
          recorded_at_utc: new Date().toISOString(),
          player_account_id: uploader,
          opponent_account_id: opponent,
          result: "Won",
          is_final_battle: true,
        }],
      }),
    }),
    env,
  );
}

test("GET /ghost-battles without player_account_id returns 400", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/ghost-battles", { method: "GET" }),
    env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("GET /ghost-battles returns battles where opponent_account_id = query param", async () => {
  await uploadFinalBattle("run-G1", "uploader-X", "ghost-target");

  const response = await worker.fetch(
    new Request("https://example.com/ghost-battles?player_account_id=ghost-target", {
      method: "GET",
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { battles: Array<Record<string, unknown>> };
  expect(body.battles).toHaveLength(1);
  expect(body.battles[0]).toMatchObject({
    battle_id: "run-G1-b1",
    opponent_account_id: "ghost-target",
    result: "Won",
    is_final_battle: true,
  });
  // V4: NO replay_available, NO player_account_id_in_payload in the response.
  expect(body.battles[0]).not.toHaveProperty("replay_available");
  expect(body.battles[0]).not.toHaveProperty("player_account_id_in_payload");
  expect(body.battles[0]).not.toHaveProperty("is_bundle_final_battle");
});
