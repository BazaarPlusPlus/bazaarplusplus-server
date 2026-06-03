import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import {
  countRows,
  resetTestState,
  selectFirst,
} from "./helpers/seed";

function buildUpload(body: unknown): Request {
  return new Request("https://example.com/run-bundles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function payload(opts: {
  runId: string;
  uploader: string;
  battles: Array<{
    battle_id: string;
    opponent_account_id: string | null;
    player_prestige?: number;
    player_victories?: number;
    opponent_prestige?: number;
    opponent_victories?: number;
    winner_combatant_id?: string;
    loser_combatant_id?: string;
  }>;
}): unknown {
  return {
    schema_version: 4,
    player_account_id: opts.uploader,
    submitted_at_utc: "2026-05-26T00:00:00.000Z",
    artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
    artifact_bytes: [1, 2, 3, 4],
    run_projection: {
      run_id: opts.runId,
      status: "completed",
      ended_at_utc: "2026-05-26T01:00:00.000Z",
    },
    battle_projections: opts.battles.map((b) => ({
      battle_id: b.battle_id,
      run_id: opts.runId,
      recorded_at_utc: "2026-05-26T00:30:00.000Z",
      day: 5,
      player_name: opts.uploader,
      player_account_id: opts.uploader,
      player_level: 7,
      player_prestige: b.player_prestige ?? 2,
      player_victories: b.player_victories ?? 9,
      opponent_name: b.opponent_account_id ?? "Unknown",
      opponent_account_id: b.opponent_account_id,
      opponent_level: 8,
      opponent_prestige: b.opponent_prestige ?? 3,
      opponent_victories: b.opponent_victories ?? 10,
      result: "Won",
      winner_combatant_id: b.winner_combatant_id ?? "player-combatant",
      loser_combatant_id: b.loser_combatant_id ?? "opponent-combatant",
    })),
  };
}

beforeEach(async () => {
  await resetTestState(env);
});

test("battles are projected even when the opponent was not seen before", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-A",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-unknown", opponent_account_id: "stranger" },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles are projected with opponent account metadata", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-B",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-known", opponent_account_id: "known-opponent" },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles project participant prestige, victories, and winner/loser ids", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-rich-battle",
      uploader: "uploader-1",
      battles: [
        {
          battle_id: "b-rich",
          opponent_account_id: "known-opponent",
          player_prestige: 4,
          player_victories: 11,
          opponent_prestige: 5,
          opponent_victories: 12,
          winner_combatant_id: "winner-1",
          loser_combatant_id: "loser-1",
        },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);

  const row = await selectFirst<{
    player_prestige: number | null;
    player_victories: number | null;
    opponent_prestige: number | null;
    opponent_victories: number | null;
    winner_combatant_id: string | null;
    loser_combatant_id: string | null;
  }>(
    env.DB,
    `
      SELECT
        player_prestige, player_victories,
        opponent_prestige, opponent_victories,
        winner_combatant_id, loser_combatant_id
      FROM battles
      WHERE battle_id = ?
    `,
    ["b-rich"],
  );
  expect(row).toEqual({
    player_prestige: 4,
    player_victories: 11,
    opponent_prestige: 5,
    opponent_victories: 12,
    winner_combatant_id: "winner-1",
    loser_combatant_id: "loser-1",
  });
});

test("self-battle: opponent == uploader → projected", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-C",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-self", opponent_account_id: "uploader-1" },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles with NULL opponent_account_id are projected", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-D",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-null-opp", opponent_account_id: null },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("re-upload with the same run artifact is idempotent", async () => {
  const first = await worker.fetch(
    buildUpload(payload({
      runId: "run-E",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-1", opponent_account_id: "opp-1" },
      ],
    })),
    env,
  );
  expect(first.status).toBe(200);

  const second = await worker.fetch(
    buildUpload(payload({
      runId: "run-E",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-1", opponent_account_id: "opp-1" },
      ],
    })),
    env,
  );
  expect(second.status).toBe(200);

  expect(await countRows(env.DB, "battles")).toBe(1);
  expect(await countRows(env.DB, "runs")).toBe(1);
});

test("re-upload with the same run id but different artifact is rejected", async () => {
  const firstPayload = payload({
    runId: "run-F",
    uploader: "uploader-1",
    battles: [{ battle_id: "b-1", opponent_account_id: "opp-1" }],
  }) as Record<string, unknown>;
  const first = await worker.fetch(buildUpload(firstPayload), env);
  expect(first.status).toBe(200);

  const secondPayload = {
    ...firstPayload,
    artifact_bytes: [9, 9, 9],
  };
  const second = await worker.fetch(buildUpload(secondPayload), env);
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "run_bundle_conflict" });
});

test("uploading a run without battles only writes the run projection", async () => {
  await worker.fetch(
    buildUpload(payload({
      runId: "run-G",
      uploader: "uploader-2",
      battles: [],
    })),
    env,
  );
  expect(await countRows(env.DB, "runs")).toBe(1);
  expect(await countRows(env.DB, "battles")).toBe(0);
  const row = await selectFirst<{ player_account_id: string }>(
    env.DB,
    "SELECT player_account_id FROM runs WHERE run_id = ?",
    ["run-G"],
  );
  expect(row?.player_account_id).toBe("uploader-2");
});
