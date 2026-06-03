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
    is_final_battle: boolean;
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
      opponent_name: b.opponent_account_id ?? "Unknown",
      opponent_account_id: b.opponent_account_id,
      result: "Won",
      is_final_battle: b.is_final_battle,
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
        { battle_id: "b-unknown", opponent_account_id: "stranger", is_final_battle: false },
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
        { battle_id: "b-known", opponent_account_id: "known-opponent", is_final_battle: false },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("self-battle: opponent == uploader → projected", async () => {
  const response = await worker.fetch(
    buildUpload(payload({
      runId: "run-C",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-self", opponent_account_id: "uploader-1", is_final_battle: false },
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
        { battle_id: "b-null-opp", opponent_account_id: null, is_final_battle: false },
      ],
    })),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("re-upload with same battle_id does not rollback batch (ON CONFLICT DO UPDATE)", async () => {
  const first = await worker.fetch(
    buildUpload(payload({
      runId: "run-E",
      uploader: "uploader-1",
      battles: [
        { battle_id: "b-1", opponent_account_id: "opp-1", is_final_battle: false },
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
        { battle_id: "b-1", opponent_account_id: "opp-1", is_final_battle: true },
      ],
    })),
    env,
  );
  expect(second.status).toBe(200);

  expect(await countRows(env.DB, "battles")).toBe(1);
  const row = await selectFirst<{ is_final_battle: number }>(
    env.DB,
    "SELECT is_final_battle FROM battles WHERE battle_id = ?",
    ["b-1"],
  );
  expect(row?.is_final_battle).toBe(1);
});

test("sticky is_final_battle: once 1, stays 1 even on stale retransmit", async () => {
  // Final upload arrives first.
  await worker.fetch(
    buildUpload(payload({
      runId: "run-F",
      uploader: "uploader-1",
      battles: [{ battle_id: "b-final", opponent_account_id: "opp-2", is_final_battle: true }],
    })),
    env,
  );
  // Stale mid-run upload arrives later with is_final_battle=false — must not flip flag.
  await worker.fetch(
    buildUpload(payload({
      runId: "run-F",
      uploader: "uploader-1",
      battles: [{ battle_id: "b-final", opponent_account_id: "opp-2", is_final_battle: false }],
    })),
    env,
  );

  const row = await selectFirst<{ is_final_battle: number }>(
    env.DB,
    "SELECT is_final_battle FROM battles WHERE battle_id = ?",
    ["b-final"],
  );
  expect(row?.is_final_battle).toBe(1);
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
