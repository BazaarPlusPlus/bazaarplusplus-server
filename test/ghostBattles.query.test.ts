import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import {
  buildRunBundleMultipartUpload,
  runBundleMetadata,
} from "./helpers/runBundleUpload";
import { resetTestState } from "./helpers/seed";

beforeEach(async () => {
  await resetTestState(env);
});

async function uploadBattle(opts: {
  runId: string;
  battleId?: string;
  uploader: string;
  opponent: string;
  isFinalBattle?: boolean;
}): Promise<void> {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: runBundleMetadata({
        runId: opts.runId,
        uploader: opts.uploader,
        battles: [
          {
            battle_id: opts.battleId ?? `${opts.runId}-b1`,
            run_id: opts.runId,
            recorded_at_utc: new Date().toISOString(),
            player_account_id: opts.uploader,
            player_prestige: 6,
            player_victories: 12,
            opponent_account_id: opts.opponent,
            opponent_prestige: 7,
            opponent_victories: 13,
            result: "Won",
            winner_combatant_id: "winner-combatant",
            loser_combatant_id: "loser-combatant",
            is_final_battle: opts.isFinalBattle,
          },
        ],
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
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
  await uploadBattle({ runId: "run-G1", uploader: "uploader-X", opponent: "ghost-target" });

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
    player_account_id: "uploader-X",
    opponent_account_id: "ghost-target",
    player_prestige: 6,
    player_victories: 12,
    opponent_prestige: 7,
    opponent_victories: 13,
    result: "Won",
    winner_combatant_id: "winner-combatant",
    loser_combatant_id: "loser-combatant",
    is_final_battle: false,
  });
  expect(body.battles[0]).not.toHaveProperty("hour");
  expect(body.battles[0]).not.toHaveProperty("encounter_id");
  expect(body.battles[0]).not.toHaveProperty("combat_kind");
  // V4: NO replay_available, NO player_account_id_in_payload in the response.
  expect(body.battles[0]).not.toHaveProperty("replay_available");
  expect(body.battles[0]).not.toHaveProperty("player_account_id_in_payload");
  expect(body.battles[0]).not.toHaveProperty("is_bundle_final_battle");
});

test("GET /ghost-battles preserves true is_final_battle across later non-final battle upsert", async () => {
  await uploadBattle({
    runId: "run-final-first",
    battleId: "shared-final-battle",
    uploader: "uploader-A",
    opponent: "ghost-target",
    isFinalBattle: true,
  });
  await uploadBattle({
    runId: "run-non-final-later",
    battleId: "shared-final-battle",
    uploader: "uploader-B",
    opponent: "ghost-target",
    isFinalBattle: false,
  });

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
    battle_id: "shared-final-battle",
    player_account_id: "uploader-B",
    is_final_battle: true,
  });
  expect(body.battles[0]).not.toHaveProperty("is_bundle_final_battle");
});
