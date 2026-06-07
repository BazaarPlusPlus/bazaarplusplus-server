import type { D1PreparedStatement } from "@cloudflare/workers-types";

import { sha256Base64 } from "../../crypto/hash";
import type { Env } from "../../env";
import { json, jsonError } from "../../http/json";
import {
  normalizeIsoDateTime,
  optionalFiniteNumber,
  optionalIsoDateTime,
  optionalTrimmedString,
} from "../../http/request";
import { logInfo, logWarn } from "../../observability";
import { putThenProject } from "../../storage/putThenProject";
import type { RunBundleParts } from "./multipart";
import { isMultipart, parseMultipartBoundary, parseMultipartBytes } from "./multipart";

type RawRunBundleRequest = {
  schema_version?: unknown;
  player_account_id?: unknown;
  submitted_at_utc?: unknown;
  artifact_codec?: unknown;
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

type ExistingRunRow = {
  payload_hash: string;
  object_key: string;
};

const RunBundleArtifactContentType = "application/x-bpp-runbundle+msgpack+gzip";
const MaxRunBundleArtifactBytes = 8 * 1024 * 1024;
const MaxBattleProjections = 200;
const MaxBattleRecordedAtFutureSkewMs = 10 * 60 * 1000;
const DefaultRunBundleSchemaVersion = 5;

const RUNS_INSERT_SQL = `
  INSERT INTO runs (
    run_id, player_account_id, payload_hash, schema_version, object_key, codec,
    size_bytes, status, hero_id, hero_name, player_rank, player_rating, player_position,
    started_at_utc, ended_at_utc, final_day, final_wins, final_losses,
    final_player_rank, final_player_rating, final_player_position,
    submitted_at_utc, created_at_utc, updated_at_utc
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ?6 is the metadata-level uploader and ?14 is the battle opponent. The literal
// self-battle branch avoids relying on same-batch reads from seen_player_accounts.
const BATTLE_INSERT_SQL = `
  INSERT INTO battles (
    battle_id, run_id, recorded_at_utc, day,
    player_name, player_account_id, player_hero, player_rank, player_rating, player_level,
    player_prestige, player_victories,
    opponent_name, opponent_account_id, opponent_hero, opponent_rank, opponent_rating, opponent_level,
    opponent_prestige, opponent_victories,
    result, winner_combatant_id, loser_combatant_id, is_final_battle, updated_at_utc
  )
  SELECT
    ?1, ?2, ?3, ?4,
    ?5, ?6, ?7, ?8, ?9, ?10,
    ?11, ?12,
    ?13, ?14, ?15, ?16, ?17, ?18,
    ?19, ?20,
    ?21, ?22, ?23, ?24, ?25
  WHERE ?14 = ?6
     OR ?14 IN (SELECT player_account_id FROM seen_player_accounts)
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

async function findExistingRun(env: Env, runId: string): Promise<ExistingRunRow | null> {
  return env.DB.prepare(
    `
      SELECT payload_hash, object_key
      FROM runs
      WHERE run_id = ?
      LIMIT 1
    `,
  )
    .bind(runId)
    .first<ExistingRunRow>();
}

function isAfterAllowedFutureSkew(isoDateTimeUtc: string, nowMs: number): boolean {
  return Date.parse(isoDateTimeUtc) > nowMs + MaxBattleRecordedAtFutureSkewMs;
}

function rejectInvalidRunBundle(reason: string, fields: Record<string, unknown> = {}): Response {
  logWarn("run_bundles.upload.reject", {
    reason,
    error: "invalid_run_bundle_request",
    ...fields,
  });
  return jsonError("invalid_run_bundle_request");
}

function schemaVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : DefaultRunBundleSchemaVersion;
}

function normalizeTimestampOrFallback(
  value: unknown,
  fallbackUtc: string,
): { value: string; normalized: boolean } {
  const normalized = normalizeIsoDateTime(value);
  return normalized == null
    ? { value: fallbackUtc, normalized: true }
    : { value: normalized, normalized: false };
}

function normalizeOptionalTimestamp(value: unknown): {
  value: string | null;
  normalized: boolean;
} {
  if (value == null || (typeof value === "string" && value.trim().length === 0)) {
    return { value: null, normalized: false };
  }

  const normalized = optionalIsoDateTime(value);
  return normalized == null
    ? { value: null, normalized: true }
    : { value: normalized, normalized: false };
}

function normalizeBattleRecordedAt(
  value: unknown,
  fallbackUtc: string,
  validationNowMs: number,
): { value: string; normalized: boolean } {
  const normalized = optionalIsoDateTime(value);
  if (normalized == null || isAfterAllowedFutureSkew(normalized, validationNowMs)) {
    return { value: fallbackUtc, normalized: true };
  }

  return { value: normalized, normalized: false };
}

function decodeRunBundleParts(
  parts: RunBundleParts,
  failureFields: Record<string, unknown> = {},
): {
  rawBody: RawRunBundleRequest;
  artifactBytes: Uint8Array;
} {
  if (parts.metadata == null || parts.artifact == null) {
    logWarn("run_bundles.upload.reject", {
      reason: "missing_or_invalid_parts",
      error: "invalid_run_bundle_request",
      metadata_present: parts.metadata != null,
      artifact_present: parts.artifact != null,
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  let rawBody: RawRunBundleRequest;
  try {
    rawBody = JSON.parse(parts.metadata) as RawRunBundleRequest;
  } catch {
    logWarn("run_bundles.upload.reject", {
      reason: "metadata_json_parse_failed",
      error: "invalid_run_bundle_request",
      metadata_length: parts.metadata.length,
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  if (parts.artifact.contentType !== RunBundleArtifactContentType) {
    logWarn("run_bundles.upload.reject", {
      reason: "artifact_content_type_mismatch",
      error: "invalid_run_bundle_request",
      artifact_content_type: parts.artifact.contentType,
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  if (
    parts.artifact.bytes.byteLength === 0 ||
    parts.artifact.bytes.byteLength > MaxRunBundleArtifactBytes
  ) {
    throw jsonError("payload_too_large", 413);
  }

  return { rawBody, artifactBytes: parts.artifact.bytes };
}

async function readMultipartRunBundleFromBytes(
  request: Request,
  failureFields: Record<string, unknown>,
): Promise<{
  rawBody: RawRunBundleRequest;
  artifactBytes: Uint8Array;
}> {
  const contentType = request.headers.get("content-type");
  const boundary = parseMultipartBoundary(contentType);
  if (boundary == null) {
    logWarn("run_bundles.upload.reject", {
      reason: "multipart_boundary_missing",
      error: "invalid_run_bundle_request",
      content_type: contentType,
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  let body: Uint8Array;
  try {
    body = new Uint8Array(await request.arrayBuffer());
  } catch {
    logWarn("run_bundles.upload.reject", {
      reason: "multipart_body_read_failed",
      error: "invalid_run_bundle_request",
      content_type: contentType,
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  const parts = parseMultipartBytes(body, boundary);
  if (parts == null) {
    logWarn("run_bundles.upload.reject", {
      reason: "multipart_parse_failed",
      error: "invalid_run_bundle_request",
      content_type: contentType,
      declared_length: request.headers.get("content-length"),
      parser: "bytes",
      ...failureFields,
    });
    throw jsonError("invalid_run_bundle_request");
  }

  return decodeRunBundleParts(parts, { parser: "bytes", ...failureFields });
}

async function readMultipartRunBundle(request: Request): Promise<{
  rawBody: RawRunBundleRequest;
  artifactBytes: Uint8Array;
}> {
  if (!isMultipart(request)) {
    throw jsonError("unsupported_content_type", 415);
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MaxRunBundleArtifactBytes) {
    throw jsonError("payload_too_large", 413);
  }

  return readMultipartRunBundleFromBytes(request, {});
}

export async function handleUploadRunBundle(
  request: Request,
  env: Env,
): Promise<Response> {
  const { rawBody, artifactBytes } = await readMultipartRunBundle(request);
  const phaseStart = Date.now();
  const nowUtc = new Date().toISOString();
  const validationNowMs = Date.now();

  const playerAccountId = optionalTrimmedString(rawBody.player_account_id);
  if (playerAccountId == null) {
    return rejectInvalidRunBundle("missing_player_account_id");
  }

  const runProjectionRaw =
    typeof rawBody.run_projection === "object" && rawBody.run_projection != null
      ? rawBody.run_projection
      : {};
  const runId = optionalTrimmedString(runProjectionRaw.run_id);
  if (runId == null) {
    return rejectInvalidRunBundle("missing_run_id");
  }
  const status = optionalTrimmedString(runProjectionRaw.status) ?? "completed";
  const artifactCodec = optionalTrimmedString(rawBody.artifact_codec)
    ?? RunBundleArtifactContentType;

  const submittedAt = normalizeTimestampOrFallback(rawBody.submitted_at_utc, nowUtc);
  const endedAt = normalizeTimestampOrFallback(runProjectionRaw.ended_at_utc, nowUtc);
  const startedAt = normalizeOptionalTimestamp(runProjectionRaw.started_at_utc);

  const battleProjections: BattleProjection[] = Array.isArray(rawBody.battle_projections)
    ? (rawBody.battle_projections as BattleProjection[])
    : [];
  if (battleProjections.length > MaxBattleProjections) {
    return jsonError("too_many_battle_projections");
  }

  let skippedBattleProjections = 0;
  let ignoredBattleRunIdMismatches = 0;
  let normalizedTimestampFields = Number(submittedAt.normalized)
    + Number(endedAt.normalized)
    + Number(startedAt.normalized);
  const validBattleProjections: Array<BattleProjection & { recorded_at_utc_normalized: string }> = [];
  for (const battle of battleProjections) {
    const battleId = optionalTrimmedString(battle.battle_id);
    if (!battleId) {
      skippedBattleProjections += 1;
      continue;
    }

    const battleRunId = optionalTrimmedString(battle.run_id);
    if (battleRunId != null && battleRunId !== runId) {
      ignoredBattleRunIdMismatches += 1;
    }

    const recordedAt = normalizeBattleRecordedAt(
      battle.recorded_at_utc,
      submittedAt.value,
      validationNowMs,
    );
    if (recordedAt.normalized) {
      normalizedTimestampFields += 1;
    }
    validBattleProjections.push({ ...battle, recorded_at_utc_normalized: recordedAt.value });
  }

  const parseMs = Date.now() - phaseStart;

  const payloadHash = await sha256Base64(artifactBytes);

  const existingRun = await findExistingRun(env, runId);
  if (existingRun != null) {
    if (existingRun.payload_hash !== payloadHash) {
      logWarn("run_bundles.upload", {
        run_id: runId,
        existing_object_key: existingRun.object_key,
        outcome: "run_bundle_conflict",
      });
      return jsonError("run_bundle_conflict", 409);
    }

    return json({ status: "accepted", run_id: runId, object_key: existingRun.object_key });
  }
  const objectKey = `run-bundles/${crypto.randomUUID()}.mpack.gz`;

  let r2PutMs = 0;
  const r2Start = Date.now();

  const statements: D1PreparedStatement[] = [];

  // Statement 0: runs insert. Existing run_id is handled before R2 write.
  statements.push(
    env.DB.prepare(RUNS_INSERT_SQL).bind(
      runId,
      playerAccountId,
      payloadHash,
      schemaVersion(rawBody.schema_version),
      objectKey,
      artifactCodec,
      artifactBytes.byteLength,
      status,
      optionalTrimmedString(runProjectionRaw.hero_id),
      optionalTrimmedString(runProjectionRaw.hero_name),
      optionalTrimmedString(runProjectionRaw.player_rank),
      optionalFiniteNumber(runProjectionRaw.player_rating),
      optionalFiniteNumber(runProjectionRaw.player_position),
      startedAt.value,
      endedAt.value,
      optionalFiniteNumber(runProjectionRaw.final_day),
      optionalFiniteNumber(runProjectionRaw.final_wins),
      optionalFiniteNumber(runProjectionRaw.final_losses),
      optionalTrimmedString(runProjectionRaw.final_player_rank),
      optionalFiniteNumber(runProjectionRaw.final_player_rating),
      optionalFiniteNumber(runProjectionRaw.final_player_position),
      submittedAt.value,
      nowUtc,
      nowUtc,
    ),
  );

  // Statements 1..N: one upsert per battle projection.
  for (const battle of validBattleProjections) {
    const opponentAccountId = optionalTrimmedString(battle.opponent_account_id);
    const isFinalBattle =
      battle.is_final_battle === true || battle.is_final_battle === 1 ? 1 : 0;

    statements.push(
      env.DB.prepare(BATTLE_INSERT_SQL).bind(
        optionalTrimmedString(battle.battle_id),
        runId,
        battle.recorded_at_utc_normalized,
        optionalFiniteNumber(battle.day),
        optionalTrimmedString(battle.player_name),
        playerAccountId,
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

  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc) VALUES (?, ?)",
    ).bind(playerAccountId, nowUtc),
  );

  let d1BatchMs = 0;
  let battlesActuallyWritten = 0;
  const projectResult = await putThenProject({
    bucket: env.RUN_BUNDLE_BUCKET,
    objectKey,
    value: artifactBytes,
    putOptions: { httpMetadata: { contentType: artifactCodec } },
    project: async () => {
      const d1Start = Date.now();
      const result = await env.DB.batch(statements);
      d1BatchMs = Date.now() - d1Start;
      return result;
    },
    findCommitted: () => findExistingRun(env, runId),
    isObjectReferenced: (committed) => committed.object_key === objectKey,
    onPutSucceeded: () => {
      r2PutMs = Date.now() - r2Start;
    },
    onPutFailed: (error) => {
      logWarn("run_bundles.upload", {
        run_id: runId,
        object_key: objectKey,
        error: String(error),
        outcome: "r2_put_failed",
      });
    },
  });

  if (!projectResult.ok) {
    switch (projectResult.cleanup) {
      case "kept":
        logWarn("run_bundles.upload", {
          run_id: runId,
          object_key: objectKey,
          error: String(projectResult.error),
          outcome: "d1_batch_failed_existing_object_kept",
        });
        break;
      case "deleted":
        logWarn("run_bundles.upload", {
          run_id: runId,
          object_key: objectKey,
          error: String(projectResult.error),
          outcome:
            projectResult.committed == null
              ? "d1_batch_failed_r2_cleaned"
              : "d1_batch_failed_raced_object_cleaned",
        });
        break;
      case "orphaned":
        logWarn("run_bundles.upload", {
          run_id: runId,
          object_key: objectKey,
          error: String(projectResult.error),
          cleanup_error: String(projectResult.cleanupError),
          outcome: "d1_batch_failed_r2_orphaned",
        });
        break;
      case "reference_lookup_failed":
        logWarn("run_bundles.upload", {
          run_id: runId,
          object_key: objectKey,
          error: String(projectResult.error),
          reference_lookup_error: String(projectResult.referenceLookupError),
          outcome: "d1_batch_failed_reference_lookup_failed",
        });
        break;
    }
  }

  if (projectResult.ok) {
    const batchResults = projectResult.value;
    // Statement 0 is the runs insert; statements 1..validBattleProjections.length are battle upserts.
    const battleResults = batchResults.slice(1, 1 + validBattleProjections.length);
    battlesActuallyWritten = battleResults.reduce(
      (sum, r) => sum + (r.meta?.changes ?? 0),
      0,
    );
  } else {
    const racedExistingRun = projectResult.committed;
    if (racedExistingRun != null) {
      if (racedExistingRun.payload_hash === payloadHash) {
        return json({
          status: "accepted",
          run_id: runId,
          object_key: racedExistingRun.object_key,
        });
      }

      logWarn("run_bundles.upload", {
        run_id: runId,
        existing_object_key: racedExistingRun.object_key,
        attempted_object_key: objectKey,
        outcome: "run_bundle_conflict_after_race",
      });
      return jsonError("run_bundle_conflict", 409);
    }

    throw projectResult.error;
  }
  logInfo("run_bundles.upload", {
    run_id: runId,
    phase_ms: { parse: parseMs, r2_put: r2PutMs, d1_batch: d1BatchMs, total: Date.now() - phaseStart },
    battles_in_payload: battleProjections.length,
    battles_skipped: skippedBattleProjections,
    battle_run_id_mismatches_ignored: ignoredBattleRunIdMismatches,
    timestamps_normalized: normalizedTimestampFields,
    // battles_projected = rows inserted or updated by the battle upserts.
    battles_projected: battlesActuallyWritten,
    outcome: "ok",
  });

  return json({ status: "accepted", run_id: runId, object_key: objectKey });
}
