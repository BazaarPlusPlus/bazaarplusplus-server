import { toBase64Url } from "../../crypto/base64";
import { sha256Base64 } from "../../crypto/hash";
import type { Env } from "../../env";
import { json, jsonError, readJson } from "../../http/json";
import { optionalFiniteNumber, optionalTrimmedString } from "../../http/request";
import { objectKeySegment, parseBody } from "../../http/validation";
import { logInfo, logWarn } from "../../observability";

type RawRunBundleRequest = {
  schema_version?: unknown;
  player_account_id?: unknown;
  submitted_at_utc?: unknown;
  artifact_codec?: unknown;
  artifact_bytes?: unknown;
  run_projection?: Record<string, unknown>;
  battle_projections?: unknown;
};

export async function handleUploadRunBundle(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = (await readJson(request)) as RawRunBundleRequest;
  const phaseStart = Date.now();

  // player_account_id is required (V3 "anonymous-player" sentinel is gone).
  const outer = parseBody(rawBody, {
    schema_version: { type: "finiteNumber", errorCode: "invalid_run_bundle_request" },
    player_account_id: { type: "string", errorCode: "invalid_run_bundle_request" },
    submitted_at_utc: { type: "string", errorCode: "invalid_run_bundle_request" },
    artifact_codec: { type: "string", errorCode: "invalid_run_bundle_request" },
    artifact_bytes: {
      type: "byteArrayOrBase64",
      errorCode: "invalid_run_bundle_request",
    },
  });

  const runProjectionRaw =
    typeof rawBody.run_projection === "object" && rawBody.run_projection != null
      ? rawBody.run_projection
      : {};
  const inner = parseBody(runProjectionRaw, {
    run_id: { type: "string", errorCode: "invalid_run_bundle_request" },
    status: { type: "string", errorCode: "invalid_run_bundle_request" },
    ended_at_utc: { type: "string", errorCode: "invalid_run_bundle_request" },
  });

  const parseMs = Date.now() - phaseStart;

  const payloadHash = await sha256Base64(outer.artifact_bytes.bytes);
  const playerKeySegment = objectKeySegment(outer.player_account_id);
  const runKeySegment = objectKeySegment(inner.run_id);
  if (playerKeySegment == null || runKeySegment == null) {
    return jsonError("invalid_run_bundle_request");
  }
  const objectKey =
    `run-bundles/${playerKeySegment}/${runKeySegment}/${toBase64Url(payloadHash)}.mpack.gz`;

  const r2Start = Date.now();
  let r2PutMs: number;
  try {
    await env.RUN_BUNDLE_BUCKET.put(objectKey, outer.artifact_bytes.bytes, {
      httpMetadata: { contentType: outer.artifact_codec },
    });
    r2PutMs = Date.now() - r2Start;
  } catch (error) {
    logWarn("run_bundles.upload", {
      run_id: inner.run_id,
      object_key: objectKey,
      error: String(error),
      outcome: "r2_put_failed",
    });
    throw error;
  }

  const nowUtc = new Date().toISOString();

  const d1Start = Date.now();
  try {
    await env.DB.prepare(
      `
        INSERT INTO runs (
          run_id, player_account_id, payload_hash, schema_version, object_key, codec,
          size_bytes, status, hero_id, hero_name, player_rank, player_rating, player_position,
          started_at_utc, ended_at_utc, final_day, final_wins, final_losses,
          final_player_rank, final_player_rating, final_player_position,
          submitted_at_utc, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          player_account_id = excluded.player_account_id,
          payload_hash = excluded.payload_hash,
          schema_version = excluded.schema_version,
          object_key = excluded.object_key,
          codec = excluded.codec,
          size_bytes = excluded.size_bytes,
          status = excluded.status,
          hero_id = excluded.hero_id,
          hero_name = excluded.hero_name,
          player_rank = excluded.player_rank,
          player_rating = excluded.player_rating,
          player_position = excluded.player_position,
          started_at_utc = excluded.started_at_utc,
          ended_at_utc = excluded.ended_at_utc,
          final_day = excluded.final_day,
          final_wins = excluded.final_wins,
          final_losses = excluded.final_losses,
          final_player_rank = excluded.final_player_rank,
          final_player_rating = excluded.final_player_rating,
          final_player_position = excluded.final_player_position,
          submitted_at_utc = excluded.submitted_at_utc,
          updated_at_utc = excluded.updated_at_utc
      `,
    )
      .bind(
        inner.run_id,
        outer.player_account_id,
        payloadHash,
        outer.schema_version,
        objectKey,
        outer.artifact_codec,
        outer.artifact_bytes.bytes.byteLength,
        inner.status,
        optionalTrimmedString(runProjectionRaw.hero_id),
        optionalTrimmedString(runProjectionRaw.hero_name),
        optionalTrimmedString(runProjectionRaw.player_rank),
        optionalFiniteNumber(runProjectionRaw.player_rating),
        optionalFiniteNumber(runProjectionRaw.player_position),
        optionalTrimmedString(runProjectionRaw.started_at_utc),
        inner.ended_at_utc,
        optionalFiniteNumber(runProjectionRaw.final_day),
        optionalFiniteNumber(runProjectionRaw.final_wins),
        optionalFiniteNumber(runProjectionRaw.final_losses),
        optionalTrimmedString(runProjectionRaw.final_player_rank),
        optionalFiniteNumber(runProjectionRaw.final_player_rating),
        optionalFiniteNumber(runProjectionRaw.final_player_position),
        outer.submitted_at_utc,
        nowUtc,
        nowUtc,
      )
      .run();
  } catch (error) {
    // D1 failed after R2 put — best-effort cleanup so we don't leak an orphan.
    try {
      await env.RUN_BUNDLE_BUCKET.delete(objectKey);
      logWarn("run_bundles.upload", {
        run_id: inner.run_id,
        object_key: objectKey,
        error: String(error),
        outcome: "d1_batch_failed_r2_cleaned",
      });
    } catch (cleanupError) {
      logWarn("run_bundles.upload", {
        run_id: inner.run_id,
        object_key: objectKey,
        error: String(error),
        cleanup_error: String(cleanupError),
        outcome: "d1_batch_failed_r2_orphaned",
      });
    }
    throw error;
  }
  const d1BatchMs = Date.now() - d1Start;

  logInfo("run_bundles.upload", {
    run_id: inner.run_id,
    phase_ms: { parse: parseMs, r2_put: r2PutMs, d1_batch: d1BatchMs, total: Date.now() - phaseStart },
    battles_in_payload: Array.isArray(rawBody.battle_projections) ? rawBody.battle_projections.length : 0,
    battles_projected: 0, // Task 2.3 will set this to real count.
    outcome: "ok",
  });

  return json({ status: "accepted", run_id: inner.run_id, object_key: objectKey });
}
