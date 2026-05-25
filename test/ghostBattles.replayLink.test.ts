import { beforeEach, expect, test } from "vitest";
import { env } from "cloudflare:test";

import worker from "../src/index";
import { resetTestState } from "./helpers/seed";

beforeEach(async () => {
  await resetTestState(env);
});

async function setupBattleWithR2Object(): Promise<{ battleId: string; objectKey: string }> {
  const objectKey = "run-bundles/uploader-1/run-R1/abcd.mpack.gz";
  await env.RUN_BUNDLE_BUCKET.put(objectKey, new Uint8Array([1, 2, 3, 4]));
  const nowUtc = "2026-05-26T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runs (run_id, player_account_id, payload_hash, schema_version,
        object_key, codec, size_bytes, status, ended_at_utc,
        submitted_at_utc, created_at_utc, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "run-R1", "uploader-1", "abcd", 4, objectKey,
      "application/x-bpp-runbundle+msgpack+gzip", 4, "completed", nowUtc,
      nowUtc, nowUtc, nowUtc,
    ),
    env.DB.prepare(
      `INSERT INTO battles (battle_id, run_id, recorded_at_utc, player_account_id,
        opponent_account_id, is_final_battle, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("battle-R1", "run-R1", nowUtc, "uploader-1", "viewer-1", 1, nowUtc),
  ]);
  return { battleId: "battle-R1", objectKey };
}

test("POST /ghost-battles/:id/replay-link returns 404 battle_not_found when unknown", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/ghost-battles/missing/replay-link", { method: "POST" }),
    env,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "battle_not_found" });
});

test("POST /ghost-battles/:id/replay-link returns 410 artifact_expired when R2 object gone", async () => {
  const { battleId, objectKey } = await setupBattleWithR2Object();
  await env.RUN_BUNDLE_BUCKET.delete(objectKey);

  const response = await worker.fetch(
    new Request(`https://example.com/ghost-battles/${battleId}/replay-link`, { method: "POST" }),
    env,
  );
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "artifact_expired" });
});

test("POST /ghost-battles/:id/replay-link returns presigned URL + ISO expires_at_utc", async () => {
  const { battleId } = await setupBattleWithR2Object();
  const response = await worker.fetch(
    new Request(`https://example.com/ghost-battles/${battleId}/replay-link`, { method: "POST" }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { download_url: string; expires_at_utc: string };
  expect(body.download_url).toContain("X-Amz-Signature");
  expect(body.download_url).toContain("X-Amz-Expires=300");
  expect(() => new Date(body.expires_at_utc)).not.toThrow();
});
