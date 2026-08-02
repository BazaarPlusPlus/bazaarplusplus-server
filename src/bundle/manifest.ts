import {
  MAX_BATTLES_PER_BUNDLE,
  MAX_PROJECTION_BYTES,
  MAX_RUN_BYTES,
  MAX_SCREENSHOT_BYTES,
} from "../domain/limits";
import { HttpError, invalidBundle } from "../http/errors";
import { BUNDLE_PREFIX_BYTES, BUNDLE_VERSION } from "./prefix";

const encoder = new TextEncoder();
const BUNDLE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

export interface ValidatedBattleProjection {
  battle_id: string;
  recorded_at_ms: number;
  day: number;
  hour: number;
  encounter_id: string | null;
  combat_kind: string;
  result: string;
  winner_combatant_id: string | null;
  loser_combatant_id: string | null;
  is_final_battle: boolean;
  player: CombatantProjection;
  opponent: CombatantProjection;
}

export interface CombatantProjection {
  account_id: string;
  display_name: string;
  hero_id: string | null;
  hero_name: string | null;
  rank: string | null;
  rating: number | null;
  level: number | null;
  prestige: number | null;
  victories: number | null;
}

export interface ValidatedBundleDescriptor {
  bundleId: string;
  runId: string;
  uploaderAccountId: string;
  bundleVersion: 5;
  createdAtMs: number;
  manifestBytes: number;
  objectBytes: number;
  describedObjectBytes: number;
  objectKey: string;
  run: { offset: number; length: number; sha256: string };
  screenshot: null | {
    offset: number;
    length: number;
    sha256: string;
    contentType: "image/jpeg" | "image/webp";
  };
  battles: ValidatedBattleProjection[];
}

function object(value: unknown, reason = "manifest_schema_invalid"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidBundle(reason, "Manifest field must be an object");
  }
  return value as JsonObject;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidBundle("manifest_schema_invalid", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw invalidBundle("manifest_schema_invalid", `${field} is invalid`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 256) {
    throw invalidBundle("manifest_schema_invalid", `${field} must be a string or null`);
  }
  return value;
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return safeInteger(value, field);
}

function combatant(value: unknown, field: string): CombatantProjection {
  const source = object(value);
  if (typeof source.display_name !== "string" || source.display_name.length > 256) {
    throw invalidBundle("manifest_schema_invalid", `${field}.display_name is invalid`);
  }
  return {
    account_id: identifier(source.account_id, `${field}.account_id`),
    display_name: source.display_name,
    hero_id: nullableString(source.hero_id, `${field}.hero_id`),
    hero_name: nullableString(source.hero_name, `${field}.hero_name`),
    rank: nullableString(source.rank, `${field}.rank`),
    rating: nullableSafeInteger(source.rating, `${field}.rating`),
    level: nullableSafeInteger(source.level, `${field}.level`),
    prestige: nullableSafeInteger(source.prestige, `${field}.prestige`),
    victories: nullableSafeInteger(source.victories, `${field}.victories`),
  };
}

function projectionBattle(value: unknown, uploader: string): ValidatedBattleProjection {
  const source = object(value);
  const player = combatant(source.player, "battle.player");
  const opponent = combatant(source.opponent, "battle.opponent");
  if (player.account_id !== uploader) {
    throw invalidBundle("manifest_schema_invalid", "Battle player identity differs from uploader");
  }
  if (typeof source.is_final_battle !== "boolean") {
    throw invalidBundle("manifest_schema_invalid", "battle.is_final_battle must be boolean");
  }
  return {
    battle_id: identifier(source.battle_id, "battle.battle_id"),
    recorded_at_ms: safeInteger(source.recorded_at_ms, "battle.recorded_at_ms"),
    day: safeInteger(source.day, "battle.day"),
    hour: safeInteger(source.hour, "battle.hour"),
    encounter_id: nullableString(source.encounter_id, "battle.encounter_id"),
    combat_kind: identifier(source.combat_kind, "battle.combat_kind"),
    result: identifier(source.result, "battle.result"),
    winner_combatant_id: nullableString(source.winner_combatant_id, "battle.winner_combatant_id"),
    loser_combatant_id: nullableString(source.loser_combatant_id, "battle.loser_combatant_id"),
    is_final_battle: source.is_final_battle,
    player,
    opponent,
  };
}

function parseJson(bytes: Uint8Array): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw invalidBundle("manifest_not_json", "Manifest is not valid UTF-8 JSON");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 64) throw invalidBundle("manifest_not_json", "Manifest nesting is too deep");
    } else if (character === "}" || character === "]") depth -= 1;
  }
  try {
    return object(JSON.parse(text), "manifest_not_json");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidBundle("manifest_not_json", "Manifest is not valid JSON");
  }
}

export function validateManifest(
  bytes: Uint8Array,
  declaredObjectBytes: number,
): ValidatedBundleDescriptor {
  const root = parseJson(bytes);
  if (root.bundle_version !== BUNDLE_VERSION) {
    throw new HttpError(
      422,
      "unsupported_bundle_version",
      "Manifest Bundle version is not supported",
      false,
    );
  }
  if (typeof root.bundle_id !== "string" || !BUNDLE_ID.test(root.bundle_id)) {
    throw invalidBundle("manifest_schema_invalid", "bundle_id must be a canonical ULID");
  }
  const createdAtMs = safeInteger(root.created_at_ms, "created_at_ms");
  const run = object(root.run);
  if (run.run_format_version !== 5) {
    throw new HttpError(422, "unsupported_run_format", "Run format is not supported", false);
  }
  const runId = identifier(run.run_id, "run.run_id");
  const uploader = identifier(run.player_account_id, "run.player_account_id");
  const payload = object(run.payload);
  const runOffset = safeInteger(payload.offset, "run.payload.offset");
  const runLength = safeInteger(payload.length, "run.payload.length");
  if (runOffset !== 0 || runLength === 0) {
    throw invalidBundle("run_missing", "Run segment must start at payload offset zero and be non-empty");
  }
  if (runLength >= MAX_RUN_BYTES + 1) {
    throw invalidBundle("run_too_large", "Run segment reaches the 2 MiB limit");
  }
  if (payload.content_type !== "application/x-bpp-run-v5") {
    throw invalidBundle("manifest_schema_invalid", "Run content type is invalid");
  }
  if (typeof payload.sha256 !== "string" || !SHA256.test(payload.sha256)) {
    throw invalidBundle("manifest_schema_invalid", "Run digest is invalid");
  }

  const projection = object(run.projection);
  object(projection.run);
  if (!Array.isArray(projection.battles)) {
    throw invalidBundle("manifest_schema_invalid", "run.projection.battles must be an array");
  }
  if (projection.battles.length > MAX_BATTLES_PER_BUNDLE) {
    throw invalidBundle("too_many_battles", "Bundle contains too many Battle projections");
  }
  if (encoder.encode(JSON.stringify(projection)).byteLength > MAX_PROJECTION_BYTES) {
    throw invalidBundle("projection_too_large", "Run projection exceeds its byte limit");
  }
  const battles = projection.battles.map((battle) => projectionBattle(battle, uploader));
  const battleIds = new Set<string>();
  for (const battle of battles) {
    if (battleIds.has(battle.battle_id)) {
      throw invalidBundle("manifest_schema_invalid", "Battle IDs must be unique within a Bundle");
    }
    battleIds.add(battle.battle_id);
  }

  let screenshot: ValidatedBundleDescriptor["screenshot"] = null;
  if (Object.hasOwn(root, "screenshot")) {
    const image = object(root.screenshot);
    const offset = safeInteger(image.offset, "screenshot.offset");
    const length = safeInteger(image.length, "screenshot.length");
    if (length === 0 || length > MAX_SCREENSHOT_BYTES) {
      throw invalidBundle("screenshot_too_large", "Screenshot segment is empty or too large");
    }
    if (image.content_type !== "image/jpeg" && image.content_type !== "image/webp") {
      throw invalidBundle("screenshot_type_unsupported", "Screenshot content type is unsupported");
    }
    if (typeof image.sha256 !== "string" || !SHA256.test(image.sha256)) {
      throw invalidBundle("manifest_schema_invalid", "Screenshot digest is invalid");
    }
    const width = safeInteger(image.width, "screenshot.width");
    const height = safeInteger(image.height, "screenshot.height");
    const quality = safeInteger(image.quality, "screenshot.quality");
    if (width < 1 || height < 1 || quality < 1 || quality > 100) {
      throw invalidBundle("manifest_schema_invalid", "Screenshot dimensions or quality are invalid");
    }
    safeInteger(image.captured_at_ms, "screenshot.captured_at_ms");
    if (offset < runLength) {
      throw invalidBundle("segment_overlap", "Screenshot overlaps the Run segment");
    }
    if (offset > runLength) {
      throw invalidBundle("segment_out_of_bounds", "Screenshot does not immediately follow the Run segment");
    }
    screenshot = {
      offset,
      length,
      sha256: image.sha256,
      contentType: image.content_type,
    };
  }

  const payloadBytes = runLength + (screenshot?.length ?? 0);
  const describedBytes = BUNDLE_PREFIX_BYTES + bytes.byteLength + payloadBytes;
  if (createdAtMs > 8_640_000_000_000_000) {
    throw invalidBundle("manifest_schema_invalid", "created_at_ms is outside the supported date range");
  }
  const day = new Date(createdAtMs).toISOString().slice(0, 10);
  return {
    bundleId: root.bundle_id,
    runId,
    uploaderAccountId: uploader,
    bundleVersion: 5,
    createdAtMs,
    manifestBytes: bytes.byteLength,
    objectBytes: declaredObjectBytes,
    describedObjectBytes: describedBytes,
    objectKey: `bundles/${day}/${root.bundle_id}.bundle`,
    run: { offset: runOffset, length: runLength, sha256: payload.sha256 },
    screenshot,
    battles,
  };
}

export function validObjectKey(key: string): boolean {
  return /^bundles\/\d{4}-\d{2}-\d{2}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.bundle$/.test(key);
}

export function validBundleId(value: string): boolean {
  return BUNDLE_ID.test(value);
}

export function validAccountId(value: string): boolean {
  return IDENTIFIER.test(value);
}
