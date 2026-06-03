import type { D1PreparedStatement } from "@cloudflare/workers-types";

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

type BattleProjection = {
  battle_id?: unknown;
  run_id?: unknown;
  recorded_at_utc?: unknown;
  day?: unknown;
  player_name?: unknown;
  player_account_id?: unknown;
  player_hero?: unknown;
  player_rank?: unknown;
  player_rating?: unknown;
  player_level?: unknown;
  player_prestige?: unknown;
  player_victories?: unknown;
  opponent_name?: unknown;
  opponent_account_id?: unknown;
  opponent_hero?: unknown;
  opponent_rank?: unknown;
  opponent_rating?: unknown;
  opponent_level?: unknown;
  opponent_prestige?: unknown;
  opponent_victories?: unknown;
  result?: unknown;
  winner_combatant_id?: unknown;
  loser_combatant_id?: unknown;
  is_final_battle?: unknown;
};

const RUNS_INSERT_SQL = `
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
`;

// is_final_battle on conflict uses MAX() — sticky semantics. Once 1, never 0.
const BATTLE_INSERT_SQL = `
  INSERT INTO battles (
    battle_id, run_id, recorded_at_utc, day,
    player_name, player_account_id, player_hero, player_rank, player_rating, player_level,
    player_prestige, player_victories,
    opponent_name, opponent_account_id, opponent_hero, opponent_rank, opponent_rating, opponent_level,
    opponent_prestige, opponent_victories,
    result, winner_combatant_id, loser_combatant_id, is_final_battle, updated_at_utc
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(battle_id) DO UPDATE SET
    run_id = excluded.run_id,
    recorded_at_utc = excluded.recorded_at_utc,
    day = excluded.day,
    player_name = excluded.player_name,
    player_account_id = excluded.player_account_id,
    player_hero = excluded.player_hero,
    player_rank = excluded.player_rank,
    player_rating = excluded.player_rating,
    player_level = excluded.player_level,
    player_prestige = excluded.player_prestige,
    player_victories = excluded.player_victories,
    opponent_name = excluded.opponent_name,
    opponent_account_id = excluded.opponent_account_id,
    opponent_hero = excluded.opponent_hero,
    opponent_rank = excluded.opponent_rank,
    opponent_rating = excluded.opponent_rating,
    opponent_level = excluded.opponent_level,
    opponent_prestige = excluded.opponent_prestige,
    opponent_victories = excluded.opponent_victories,
    result = excluded.result,
    winner_combatant_id = excluded.winner_combatant_id,
    loser_combatant_id = excluded.loser_combatant_id,
    is_final_battle = MAX(battles.is_final_battle, excluded.is_final_battle),
    updated_at_utc = excluded.updated_at_utc
`;

export async function handleUploadRunBundle(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = (await readJson(request)) as RawRunBundleRequest;
  const phaseStart = Date.now();

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

  const battleProjections: BattleProjection[] = Array.isArray(rawBody.battle_projections)
    ? (rawBody.battle_projections as BattleProjection[])
    : [];

  // Validate each battle has battle_id and a run_id matching the run.
  for (const battle of battleProjections) {
    const battleId = optionalTrimmedString(battle.battle_id);
    if (!battleId) return jsonError("battle_id_required");
    const battleRunId = optionalTrimmedString(battle.run_id);
    if (battleRunId !== inner.run_id) return jsonError("battle_run_id_mismatch");
  }

  const parseMs = Date.now() - phaseStart;

  const payloadHash = await sha256Base64(outer.artifact_bytes.bytes);
  const playerKeySegment = objectKeySegment(outer.player_account_id);
  const runKeySegment = objectKeySegment(inner.run_id);
  if (playerKeySegment == null || runKeySegment == null) {
    return jsonError("invalid_run_bundle_request");
  }
  const objectKey =
    `run-bundles/${playerKeySegment}/${runKeySegment}/${toBase64Url(payloadHash)}.mpack.gz`;

  let r2PutMs = 0;
  const r2Start = Date.now();
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

  const statements: D1PreparedStatement[] = [];

  // Statement 0: runs upsert.
  statements.push(
    env.DB.prepare(RUNS_INSERT_SQL).bind(
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
    ),
  );

  // Statements 1..N: one upsert per battle projection.
  for (const battle of battleProjections) {
    const opponentAccountId = optionalTrimmedString(battle.opponent_account_id);
    const isFinalBattle = battle.is_final_battle === true ? 1 : 0;

    statements.push(
      env.DB.prepare(BATTLE_INSERT_SQL).bind(
        optionalTrimmedString(battle.battle_id),
        inner.run_id,
        optionalTrimmedString(battle.recorded_at_utc) ?? nowUtc,
        optionalFiniteNumber(battle.day),
        optionalTrimmedString(battle.player_name),
        outer.player_account_id,
        optionalTrimmedString(battle.player_hero),
        optionalTrimmedString(battle.player_rank),
        optionalFiniteNumber(battle.player_rating),
        optionalFiniteNumber(battle.player_level),
        optionalFiniteNumber(battle.player_prestige),
        optionalFiniteNumber(battle.player_victories),
        optionalTrimmedString(battle.opponent_name),
        opponentAccountId,
        optionalTrimmedString(battle.opponent_hero),
        optionalTrimmedString(battle.opponent_rank),
        optionalFiniteNumber(battle.opponent_rating),
        optionalFiniteNumber(battle.opponent_level),
        optionalFiniteNumber(battle.opponent_prestige),
        optionalFiniteNumber(battle.opponent_victories),
        optionalTrimmedString(battle.result),
        optionalTrimmedString(battle.winner_combatant_id),
        optionalTrimmedString(battle.loser_combatant_id),
        isFinalBattle,
        nowUtc,
      ),
    );
  }

  const d1Start = Date.now();
  let battlesActuallyWritten = 0;
  try {
    const batchResults = await env.DB.batch(statements);
    // Statement 0 is the runs upsert; statements 1..battleProjections.length are battle upserts.
    const battleResults = batchResults.slice(1, 1 + battleProjections.length);
    battlesActuallyWritten = battleResults.reduce(
      (sum, r) => sum + (r.meta?.changes ?? 0),
      0,
    );
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
    battles_in_payload: battleProjections.length,
    // battles_projected = rows inserted or updated by the battle upserts.
    battles_projected: battlesActuallyWritten,
    outcome: "ok",
  });

  return json({ status: "accepted", run_id: inner.run_id, object_key: objectKey });
}
