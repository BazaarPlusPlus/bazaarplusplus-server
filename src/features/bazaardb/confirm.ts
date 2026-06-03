import type { Env } from "../../env";
import { requireBearer } from "../../http/auth";
import { json, jsonError } from "../../http/json";
import { optionalTrimmedString } from "../../http/request";
import { logInfo, logWarn } from "../../observability";

import type { DeliveryRow } from "./delivery";
import { readOptionalJsonObject } from "./delivery";

function parseSnapshotIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const ids = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = optionalTrimmedString(value);
    if (id == null || seen.has(id)) {
      continue;
    }
    ids.push(id);
    seen.add(id);
  }
  return ids.length > 0 ? ids : null;
}

export async function handleConfirmBazaarDbSnapshots(
  request: Request,
  env: Env,
): Promise<Response> {
  const unauthorized = requireBearer(request, env, "BAZAARDB_PULL_TOKEN");
  if (unauthorized) return unauthorized;

  const body = await readOptionalJsonObject(request);
  const peekId = optionalTrimmedString(body.peek_id);
  if (peekId == null) {
    return jsonError("missing_peek_id");
  }
  const snapshotIds = parseSnapshotIds(body.snapshot_ids);
  if (snapshotIds == null) {
    return jsonError("missing_snapshot_ids");
  }

  const nowUtc = new Date().toISOString();
  const placeholders = snapshotIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `
      UPDATE bazaardb_delivery
      SET delivery_state = 'done',
          delivered_at_utc = ?,
          state_updated_at_utc = ?,
          lease_peek_id = NULL,
          lease_until_utc = NULL
      WHERE lease_peek_id = ?
        AND delivery_state = 'pending'
        AND snapshot_id IN (${placeholders})
      RETURNING snapshot_id, r2_key
    `,
  )
    .bind(nowUtc, nowUtc, peekId, ...snapshotIds)
    .all<DeliveryRow>();

  for (const row of rows.results) {
    try {
      await env.BAZAARDB_BUCKET.delete(row.r2_key);
    } catch (error) {
      logWarn("bazaardb.confirm", {
        snapshot_id: row.snapshot_id,
        r2_key: row.r2_key,
        error: String(error),
        outcome: "confirmed_r2_delete_error",
      });
    }
  }

  const confirmedSet = new Set(rows.results.map((row) => row.snapshot_id));
  const confirmed = snapshotIds.filter((id) => confirmedSet.has(id));
  logInfo("bazaardb.confirm", {
    peek_id: peekId,
    requested_count: snapshotIds.length,
    confirmed_count: confirmed.length,
    outcome: "ok",
  });

  return json({ confirmed, count: confirmed.length });
}
