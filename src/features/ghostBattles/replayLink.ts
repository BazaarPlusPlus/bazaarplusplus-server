import { createR2Presigner } from "../../crypto/presign";
import type { Env } from "../../env";
import { json, jsonError } from "../../http/json";
import { logInfo } from "../../observability";

const ReplayTtlSeconds = 300;
const RunBundleBucketName = "bazaarplusplus-run-bundles-v4";

export async function handleCreateReplayLink(
  _request: Request,
  env: Env,
  battleId: string,
): Promise<Response> {
  const phaseStart = Date.now();

  const lookupStart = Date.now();
  const row = await env.DB.prepare(
    `
      SELECT runs.object_key AS object_key
      FROM battles
      JOIN runs ON battles.run_id = runs.run_id
      WHERE battles.battle_id = ?
    `,
  )
    .bind(battleId)
    .first<{ object_key: string }>();
  const battleLookupMs = Date.now() - lookupStart;

  if (!row) {
    return jsonError("battle_not_found", 404);
  }

  const head = await env.RUN_BUNDLE_BUCKET.head(row.object_key);
  if (head == null) {
    return jsonError("artifact_expired", 410);
  }

  const presigner = createR2Presigner(env, RunBundleBucketName);
  const { url, expiresAtUtc } = await presigner.sign(row.object_key, ReplayTtlSeconds);

  logInfo("ghost_battles.replay_link", {
    phase_ms: { battle_lookup: battleLookupMs, total: Date.now() - phaseStart },
    presign_key_cached: false,
  });

  return json({ download_url: url, expires_at_utc: expiresAtUtc });
}
