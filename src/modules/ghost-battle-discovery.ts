import { validAccountId } from "../bundle/manifest";
import { toHex } from "../bundle/hex";
import {
  GHOST_DEFAULT_LIMIT,
  GHOST_LOOKBACK_MS,
  GHOST_MAX_LIMIT,
} from "../limits";
import type { Env } from "../env";
import type { HandlerDeps } from "../http/deps";
import { HttpError } from "../errors";
import { logEvent } from "../observability";
import { signDownloadPage } from "../presigner";

interface GhostRow {
  battle_id: string;
  bundle_id: string;
  recorded_at_ms: number;
  is_final_battle: number;
  projection_json: string;
  object_key: string;
}

function oneValue(params: URLSearchParams, name: string, required: boolean): string | null {
  const values = params.getAll(name);
  if (values.length > 1 || (required && values.length === 0)) {
    throw new HttpError(400, "invalid_query", `${name} must appear exactly once`, false, {
      field: name,
    });
  }
  return values[0] ?? null;
}

async function accountHash(accountId: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountId)),
  );
  return toHex(bytes.subarray(0, 8));
}

export async function discoverGhostBattles(
  request: Request,
  env: Env,
  requestId: string,
  deps: HandlerDeps,
): Promise<Record<string, unknown>> {
  const rateLimitKey = request.headers.get("CF-Connecting-IP") ?? "unknown";
  let rateLimit: RateLimitOutcome;
  try {
    rateLimit = await env.GHOST_BATTLE_RATE_LIMITER.limit({ key: rateLimitKey });
  } catch {
    throw new HttpError(503, "storage_unavailable", "Ghost rate limiter is unavailable", true);
  }
  if (!rateLimit.success) {
    logEvent("ghost.discovery", { request_id: requestId, limited: true });
    throw new HttpError(
      429,
      "rate_limited",
      "Ghost Battle request rate exceeded",
      true,
      undefined,
      { "Retry-After": "60" },
    );
  }

  const url = new URL(request.url);
  const allowed = new Set(["player_account_id", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "invalid_query", `Unknown query parameter: ${key}`, false, {
        field: key,
      });
    }
  }
  const accountId = oneValue(url.searchParams, "player_account_id", true);
  if (accountId === null || !validAccountId(accountId)) {
    throw new HttpError(400, "invalid_query", "player_account_id is invalid", false, {
      field: "player_account_id",
    });
  }
  const limitValue = oneValue(url.searchParams, "limit", false);
  let limit = GHOST_DEFAULT_LIMIT;
  if (limitValue !== null) {
    if (!/^[1-9][0-9]*$/.test(limitValue)) {
      throw new HttpError(400, "invalid_query", "limit must be an integer", false, {
        field: "limit",
      });
    }
    limit = Number(limitValue);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GHOST_MAX_LIMIT) {
    throw new HttpError(400, "invalid_query", "limit must be between 1 and 200", false, {
      field: "limit",
    });
  }

  const issuedAt = deps.now();
  let rows: GhostRow[];
  try {
    const result = await env.DB.prepare(
      `SELECT
         g.battle_id,
         g.bundle_id,
         g.recorded_at_ms,
         g.is_final_battle,
         g.projection_json,
         x.object_key
       FROM ghost_battles AS g INDEXED BY idx_ghost_battles_query
       JOIN bundles AS x ON x.bundle_id = g.bundle_id
       WHERE g.opponent_account_id = ?1
         AND g.recorded_at_ms >= ?2
       ORDER BY g.recorded_at_ms DESC, g.battle_id DESC
       LIMIT ?3`,
    )
      .bind(accountId, issuedAt - GHOST_LOOKBACK_MS, limit)
      .all<GhostRow>();
    rows = result.results;
  } catch {
    throw new HttpError(503, "storage_unavailable", "Ghost Battle query failed", true);
  }

  const signer = deps.signer;
  try {
    const downloads = await signDownloadPage(
      signer,
      rows.map((row) => row.object_key),
      issuedAt,
      "Ghost Battle URL signing failed",
    );
    const battles = rows.map((row, index) => {
      const projection = JSON.parse(row.projection_json) as Record<string, unknown>;
      return {
        ...projection,
        battle_id: row.battle_id,
        bundle_id: row.bundle_id,
        recorded_at_ms: row.recorded_at_ms,
        is_final_battle: row.is_final_battle === 1,
        download_url: downloads[index].url,
        download_expires_at_ms: downloads[index].expiresAtMs,
      };
    });
    logEvent("ghost.discovery", {
      request_id: requestId,
      account_hash: await accountHash(accountId),
      row_count: rows.length,
      limited: false,
    });
    return { battles };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "storage_unavailable", "Ghost Battle URL signing failed", true);
  }
}
