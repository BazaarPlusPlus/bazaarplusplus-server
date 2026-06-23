import { createR2Presigner } from "../../crypto/presign";
import type { Env } from "../../env";
import { requireBearer } from "../../http/auth";
import { json, jsonError } from "../../http/json";
import { logInfo, logWarn } from "../../observability";

// Matches the replay-link TTL: both presign the same private run-bundle object.
const RunBundleDownloadTtlSeconds = 300;

type RunRow = {
  object_key: string;
  codec: string;
  schema_version: number;
  size_bytes: number;
};

/**
 * Mint a 5-minute R2 presigned download URL for a run bundle artifact by `run_id`.
 *
 * This is the `replay-link` pattern keyed on the run instead of a battle: the
 * run bundle is the whole-run artifact, so any battle's `replay-link` and this
 * route resolve to the same `runs.object_key`. Gated by `BAZAARDB_PULL_TOKEN`
 * because the consumer is the BazaarDB partner pull, which already holds it —
 * unlike `replay-link`, which is mod-facing and unauthenticated.
 */
export async function handleCreateRunBundleDownloadLink(
  request: Request,
  env: Env,
  runId: string,
): Promise<Response> {
  const unauthorized = requireBearer(request, env, "BAZAARDB_PULL_TOKEN");
  if (unauthorized) return unauthorized;

  const phaseStart = Date.now();

  const lookupStart = Date.now();
  // `runs.run_id` is the PRIMARY KEY, so this is a point lookup, not a scan.
  const row = await env.DB.prepare(
    `
      SELECT object_key, codec, schema_version, size_bytes
      FROM runs
      WHERE run_id = ?
    `,
  )
    .bind(runId)
    .first<RunRow>();
  const runLookupMs = Date.now() - lookupStart;

  if (!row) {
    logWarn("run_bundles.download_link", {
      run_id: runId,
      phase_ms: { run_lookup: runLookupMs, total: Date.now() - phaseStart },
      outcome: "run_not_found",
    });
    return jsonError("run_not_found", 404);
  }

  const head = await env.RUN_BUNDLE_BUCKET.head(row.object_key);
  if (head == null) {
    logWarn("run_bundles.download_link", {
      run_id: runId,
      object_key: row.object_key,
      phase_ms: { run_lookup: runLookupMs, total: Date.now() - phaseStart },
      outcome: "artifact_expired",
    });
    return jsonError("artifact_expired", 410);
  }

  const presigner = createR2Presigner(env, env.RUN_BUNDLE_BUCKET_NAME);
  const { url, expiresAtUtc } = await presigner.sign(row.object_key, RunBundleDownloadTtlSeconds);

  logInfo("run_bundles.download_link", {
    run_id: runId,
    phase_ms: { run_lookup: runLookupMs, total: Date.now() - phaseStart },
    outcome: "ok",
  });

  return json({
    run_id: runId,
    download_url: url,
    expires_at_utc: expiresAtUtc,
    codec: row.codec,
    schema_version: row.schema_version,
    size_bytes: row.size_bytes,
  });
}
