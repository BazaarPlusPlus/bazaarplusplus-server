import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import { sha256Base64 } from "../src/crypto/hash";
import type { Env } from "../src/env";
import { handleUploadRunBundle } from "../src/features/runBundles/upload";
import worker from "../src/index";
import {
  countRows,
  resetTestState,
  selectFirst,
} from "./helpers/seed";
import {
  buildRunBundleMultipartUpload,
  runBundleMetadata,
} from "./helpers/runBundleUpload";

function metadata(opts: {
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
}): Record<string, unknown> {
  return runBundleMetadata({
    runId: opts.runId,
    uploader: opts.uploader,
    battles: opts.battles.map((b) => ({
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
  });
}

beforeEach(async () => {
  await resetTestState(env);
});

test("battles are projected even when the opponent was not seen before", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-A",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-unknown", opponent_account_id: "stranger" }],
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles are projected with opponent account metadata", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-B",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-known", opponent_account_id: "known-opponent" }],
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles project participant prestige, victories, and winner/loser ids", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
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
      }),
    }),
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
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-C",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-self", opponent_account_id: "uploader-1" }],
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("battles with NULL opponent_account_id are projected", async () => {
  const response = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-D",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-null-opp", opponent_account_id: null }],
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await countRows(env.DB, "battles")).toBe(1);
});

test("re-upload with the same run artifact is idempotent", async () => {
  const first = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-E",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-1", opponent_account_id: "opp-1" }],
      }),
    }),
    env,
  );
  expect(first.status).toBe(200);

  const second = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-E",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-1", opponent_account_id: "opp-1" }],
      }),
    }),
    env,
  );
  expect(second.status).toBe(200);

  expect(await countRows(env.DB, "battles")).toBe(1);
  expect(await countRows(env.DB, "runs")).toBe(1);
});

test("idempotent re-upload does not refresh battle projections", async () => {
  const first = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-idempotent-projection",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-original", opponent_account_id: "opp-1" }],
      }),
    }),
    env,
  );
  expect(first.status).toBe(200);

  const second = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-idempotent-projection",
        uploader: "uploader-1",
        battles: [{ battle_id: "b-replacement", opponent_account_id: "opp-2" }],
      }),
    }),
    env,
  );
  expect(second.status).toBe(200);

  expect(await countRows(env.DB, "runs")).toBe(1);
  expect(await countRows(env.DB, "battles")).toBe(1);
  const row = await selectFirst<{ battle_id: string; opponent_account_id: string | null }>(
    env.DB,
    "SELECT battle_id, opponent_account_id FROM battles WHERE run_id = ?",
    ["run-idempotent-projection"],
  );
  expect(row).toEqual({ battle_id: "b-original", opponent_account_id: "opp-1" });
});

test("different runs with identical artifact bytes get distinct object keys", async () => {
  const artifactBytes = new Uint8Array([7, 7, 7, 7]);
  const first = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-same-artifact-a",
        uploader: "uploader-1",
        battles: [],
      }),
      artifactBytes,
    }),
    env,
  );
  const second = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-same-artifact-b",
        uploader: "uploader-2",
        battles: [],
      }),
      artifactBytes,
    }),
    env,
  );
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  const firstBody = (await first.json()) as { object_key: string };
  const secondBody = (await second.json()) as { object_key: string };
  expect(firstBody.object_key).not.toBe(secondBody.object_key);
  expect(await env.RUN_BUNDLE_BUCKET.head(firstBody.object_key)).not.toBeNull();
  expect(await env.RUN_BUNDLE_BUCKET.head(secondBody.object_key)).not.toBeNull();
});

test("re-upload with the same run id but different artifact is rejected", async () => {
  const firstMetadata = metadata({
    runId: "run-F",
    uploader: "uploader-1",
    battles: [{ battle_id: "b-1", opponent_account_id: "opp-1" }],
  });
  const first = await worker.fetch(
    buildRunBundleMultipartUpload({ metadata: firstMetadata }),
    env,
  );
  expect(first.status).toBe(200);

  const second = await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: firstMetadata,
      artifactBytes: new Uint8Array([9, 9, 9]),
    }),
    env,
  );
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ error: "run_bundle_conflict" });
});

test("uploading a run without battles only writes the run projection", async () => {
  await worker.fetch(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-G",
        uploader: "uploader-2",
        battles: [],
      }),
    }),
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

test("raced idempotent upload deletes only its own uncommitted object", async () => {
  const artifactBytes = new Uint8Array([1, 2, 3, 4]);
  const payloadHash = await sha256Base64(artifactBytes);
  const committedObjectKey = "run-bundles/00000000-0000-4000-8000-000000000000.mpack.gz";
  let findExistingRunCalls = 0;
  let putObjectKey: string | null = null;
  const deletedObjectKeys: string[] = [];

  const fakeStatement = {
    bind: () => ({
      first: async () => {
        findExistingRunCalls += 1;
        return findExistingRunCalls === 1
          ? null
          : { payload_hash: payloadHash, object_key: committedObjectKey };
      },
    }),
  };
  const fakeEnv = {
    DB: {
      prepare: () => fakeStatement,
      batch: async () => {
        throw new Error("UNIQUE constraint failed: runs.run_id");
      },
    },
    RUN_BUNDLE_BUCKET: {
      put: async (objectKey: string) => {
        putObjectKey = objectKey;
      },
      delete: async (objectKey: string) => {
        deletedObjectKeys.push(objectKey);
      },
    },
    BAZAARDB_BUCKET: {},
    RUN_BUNDLE_BUCKET_NAME: "bazaarplusplus-run-bundles-v4",
    BAZAARDB_BUCKET_NAME: "bazaarplusplus-bazaardb-snapshots-v4",
    R2_ACCOUNT_ID: "test-account-id",
    R2_ACCESS_KEY_ID: "test-access-key-id",
    R2_SECRET_ACCESS_KEY: "test-secret-access-key",
    BAZAARDB_PULL_TOKEN: "test-pull-token",
  } as unknown as Env;

  const response = await handleUploadRunBundle(
    buildRunBundleMultipartUpload({
      metadata: metadata({
        runId: "run-raced-idempotent",
        uploader: "uploader-1",
        battles: [],
      }),
      artifactBytes,
    }),
    fakeEnv,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "accepted",
    run_id: "run-raced-idempotent",
    object_key: committedObjectKey,
  });
  expect(deletedObjectKeys).toEqual([putObjectKey]);
});
