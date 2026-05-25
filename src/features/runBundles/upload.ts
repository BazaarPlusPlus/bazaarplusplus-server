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
  opponent_name?: unknown;
  opponent_account_id?: unknown;
  opponent_hero?: unknown;
  opponent_rank?: unknown;
  opponent_rating?: unknown;
  opponent_level?: unknown;
  result?: unknown;
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

// The battle INSERT uses SELECT ... WHERE to filter at write time without a
// pre-flight SELECT round-trip. The 3 WHERE branches (OR-chained):
//   1. opponent_account_id IS NULL
//   2. opponent_account_id == uploader_player_account_id (self-battle, literal)
//   3. opponent_account_id IN seen_player_accounts (known BPP user)
// Branch 2 is load-bearing: it covers self-battles WITHOUT relying on intra-batch
// read-after-write visibility against seen_player_accounts (which D1 doesn't
// guarantee). The seen_player_accounts INSERT goes LAST in the batch.
//
// is_final_battle on conflict uses MAX() — sticky semantics. Once 1, never 0.
//
// Bind parameters are ?1..?20; ?N notation (explicit positional) lets us reference
// the same bound value in multiple clauses without duplicating it.
//   ?12 = opponent_account_id (used in SELECT column list AND in WHERE)
//   ?20 = uploader player_account_id (used in WHERE self-battle branch)
const BATTLE_INSERT_SQL = `
  INSERT INTO battles (
    battle_id, run_id, recorded_at_utc, day,
    player_name, player_account_id, player_hero, player_rank, player_rating, player_level,
    opponent_name, opponent_account_id, opponent_hero, opponent_rank, opponent_rating, opponent_level,
    result, is_final_battle, updated_at_utc
  )
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
  WHERE ?12 IS NULL
     OR ?12 = ?20
     OR ?12 IN (SELECT player_account_id FROM seen_player_accounts)
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
    opponent_name = excluded.opponent_name,
    opponent_account_id = excluded.opponent_account_id,
    opponent_hero = excluded.opponent_hero,
    opponent_rank = excluded.opponent_rank,
    opponent_rating = excluded.opponent_rating,
    opponent_level = excluded.opponent_level,
    result = excluded.result,
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

  // Statements 1..N: one per battle. The SQL WHERE filters at write time:
  // battles with unknown opponents are silently discarded with zero round-trips.
  // battles_in_payload === battles.length at this layer; "actually written" count
  // is read back from meta.changes after the batch (no pre-flight needed).
  for (const battle of battleProjections) {
    const opponentAccountId = optionalTrimmedString(battle.opponent_account_id);
    const isFinalBattle = battle.is_final_battle === true ? 1 : 0;

    // 20 bind values (?1..?20):
    //  ?1  battle_id
    //  ?2  run_id
    //  ?3  recorded_at_utc
    //  ?4  day
    //  ?5  player_name
    //  ?6  player_account_id (uploader)
    //  ?7  player_hero
    //  ?8  player_rank
    //  ?9  player_rating
    //  ?10 player_level
    //  ?11 opponent_name
    //  ?12 opponent_account_id (also referenced by WHERE)
    //  ?13 opponent_hero
    //  ?14 opponent_rank
    //  ?15 opponent_rating
    //  ?16 opponent_level
    //  ?17 result
    //  ?18 is_final_battle
    //  ?19 updated_at_utc
    //  ?20 uploader again (compared against ?12 in WHERE for self-battle)
    statements.push(
      env.DB.prepare(BATTLE_INSERT_SQL).bind(
        optionalTrimmedString(battle.battle_id),               // ?1
        inner.run_id,                                          // ?2
        optionalTrimmedString(battle.recorded_at_utc) ?? nowUtc, // ?3
        optionalFiniteNumber(battle.day),                      // ?4
        optionalTrimmedString(battle.player_name),             // ?5
        outer.player_account_id,                               // ?6 — uploader
        optionalTrimmedString(battle.player_hero),             // ?7
        optionalTrimmedString(battle.player_rank),             // ?8
        optionalFiniteNumber(battle.player_rating),            // ?9
        optionalFiniteNumber(battle.player_level),             // ?10
        optionalTrimmedString(battle.opponent_name),           // ?11
        opponentAccountId,                                     // ?12 — used in WHERE
        optionalTrimmedString(battle.opponent_hero),           // ?13
        optionalTrimmedString(battle.opponent_rank),           // ?14
        optionalFiniteNumber(battle.opponent_rating),          // ?15
        optionalFiniteNumber(battle.opponent_level),           // ?16
        optionalTrimmedString(battle.result),                  // ?17
        isFinalBattle,                                         // ?18
        nowUtc,                                                // ?19
        outer.player_account_id,                               // ?20 — uploader (WHERE self-battle)
      ),
    );
  }

  // Statement N+1: seen_player_accounts INSERT goes LAST per spec Section 4.4 point 3.
  // D1 doesn't guarantee intra-batch read-after-write; the self-battle case above
  // uses a literal comparison (?12 = ?20) rather than relying on this row being visible.
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc) VALUES (?, ?)",
    ).bind(outer.player_account_id, nowUtc),
  );

  const d1Start = Date.now();
  let battlesActuallyWritten = 0;
  try {
    const batchResults = await env.DB.batch(statements);
    // Statement 0 is the runs upsert; statements 1..battleProjections.length are battles;
    // the last statement is seen_player_accounts. Each battle INSERT may write 0 rows
    // (WHERE filter rejected the opponent) or 1 row (inserted or updated on conflict).
    // Sum meta.changes across the battle slice for the real projected count.
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
    // battles_projected = rows actually written (filter may discard some battles at SQL level).
    // battles_in_payload - battles_projected = count filtered out by the seen_player_accounts gate.
    battles_projected: battlesActuallyWritten,
    outcome: "ok",
  });

  return json({ status: "accepted", run_id: inner.run_id, object_key: objectKey });
}
