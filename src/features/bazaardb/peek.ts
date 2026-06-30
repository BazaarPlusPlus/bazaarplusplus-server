import { createR2Presigner, type R2Presigner } from "../../crypto/presign";
import type { Env } from "../../env";
import { requireBearer } from "../../http/auth";
import { json, readOptionalJsonObject } from "../../http/json";
import { logError, logInfo, logWarn } from "../../observability";

import {
  type ClaimedDeliveryRow,
  createPeekId,
  LeaseSeconds,
  MaxDeliveryAttempts,
  type OutstandingLeaseRow,
  requestedPeekLimit,
} from "./delivery";

// Batch alarm threshold, independent of the per-row retry cap MaxDeliveryAttempts.
// A single poison snapshot fails alone; reaching this many failures in one sweep
// signals the whole queue is burning (e.g. R2 token mismatch on the partner side).
const MassDeliveryFailureThreshold = 3;

// `failed` is a terminal accepted-loss state: rows are never re-queued and the
// server does not delete their R2 objects here — cleanup of failed objects is
// owned by the bucket's R2 lifecycle rule. Only confirm deletes objects eagerly.
async function failMaxAttemptRows(env: Env, nowUtc: string): Promise<void> {
  const failed = await env.DB.prepare(
    `
      UPDATE bazaardb_delivery
      SET delivery_state = 'failed',
          failed_at_utc = ?,
          failure_reason = 'max_delivery_attempts',
          state_updated_at_utc = ?,
          lease_peek_id = NULL,
          lease_until_utc = NULL
      WHERE delivery_state = 'pending'
        AND (lease_until_utc IS NULL OR lease_until_utc < ?)
        AND delivery_attempts >= ?
      RETURNING snapshot_id
    `,
  )
    .bind(nowUtc, nowUtc, nowUtc, MaxDeliveryAttempts)
    .all<{ snapshot_id: string }>();

  if (failed.results.length >= MassDeliveryFailureThreshold) {
    logError("bazaardb.peek", {
      failed_count: failed.results.length,
      outcome: "mass_delivery_failure",
    });
  } else if (failed.results.length > 0) {
    logWarn("bazaardb.peek", {
      failed_count: failed.results.length,
      outcome: "max_delivery_attempts_failed",
    });
  }
}

async function findOutstandingLease(
  env: Env,
  nowUtc: string,
): Promise<OutstandingLeaseRow | null> {
  return env.DB.prepare(
    `
      SELECT lease_peek_id, lease_until_utc
      FROM bazaardb_delivery
      WHERE delivery_state = 'pending'
        AND lease_until_utc >= ?
        AND lease_peek_id IS NOT NULL
      ORDER BY lease_until_utc DESC, lease_peek_id
      LIMIT 1
    `,
  )
    .bind(nowUtc)
    .first<OutstandingLeaseRow>();
}

function sortByUploaded(rows: ClaimedDeliveryRow[]): ClaimedDeliveryRow[] {
  return [...rows].sort((a, b) => {
    const uploaded = a.uploaded_at_utc.localeCompare(b.uploaded_at_utc);
    return uploaded === 0 ? a.snapshot_id.localeCompare(b.snapshot_id) : uploaded;
  });
}

async function presignItems(
  presigner: R2Presigner,
  rows: ClaimedDeliveryRow[],
): Promise<Array<{ snapshot_id: string; download_url: string }>> {
  return Promise.all(
    sortByUploaded(rows).map(async (row) => {
      const signed = await presigner.sign(row.r2_key, LeaseSeconds);
      return { snapshot_id: row.snapshot_id, download_url: signed.url };
    }),
  );
}

async function splitByObjectPresence(
  env: Env,
  rows: ClaimedDeliveryRow[],
): Promise<{ live: ClaimedDeliveryRow[]; gone: ClaimedDeliveryRow[] }> {
  const heads = await Promise.all(rows.map((row) => env.BAZAARDB_BUCKET.head(row.r2_key)));
  const live: ClaimedDeliveryRow[] = [];
  const gone: ClaimedDeliveryRow[] = [];
  rows.forEach((row, index) => (heads[index] == null ? gone : live).push(row));
  return { live, gone };
}

async function failGoneRows(
  env: Env,
  peekId: string,
  gone: ClaimedDeliveryRow[],
  nowUtc: string,
): Promise<void> {
  if (gone.length === 0) return;
  const placeholders = gone.map(() => "?").join(", ");
  await env.DB.prepare(
    `
      UPDATE bazaardb_delivery
      SET delivery_state = 'failed',
          failed_at_utc = ?,
          failure_reason = 'object_gone',
          state_updated_at_utc = ?,
          lease_peek_id = NULL,
          lease_until_utc = NULL
      WHERE lease_peek_id = ?
        AND delivery_state = 'pending'
        AND snapshot_id IN (${placeholders})
    `,
  )
    .bind(nowUtc, nowUtc, peekId, ...gone.map((row) => row.snapshot_id))
    .run();
  logWarn("bazaardb.peek", {
    peek_id: peekId,
    gone_count: gone.length,
    outcome: "object_gone_failed",
  });
}

export async function handlePeekBazaarDbSnapshots(
  request: Request,
  env: Env,
): Promise<Response> {
  const unauthorized = requireBearer(request, env, "BAZAARDB_PULL_TOKEN");
  if (unauthorized) return unauthorized;

  const presigner = createR2Presigner(env, env.BAZAARDB_BUCKET_NAME);
  const phaseStart = Date.now();
  const requested = await readOptionalJsonObject(request);
  const maxItems = requestedPeekLimit(requested.max_items);
  const nowUtc = new Date().toISOString();
  await failMaxAttemptRows(env, nowUtc);

  const peekId = createPeekId();
  const leaseExpiresAtUtc = new Date(Date.now() + LeaseSeconds * 1000).toISOString();
  const claim = await env.DB.prepare(
    `
      UPDATE bazaardb_delivery
      SET lease_peek_id = ?,
          lease_until_utc = ?,
          delivery_attempts = delivery_attempts + 1,
          state_updated_at_utc = ?
      WHERE snapshot_id IN (
        SELECT snapshot_id
        FROM bazaardb_delivery
        WHERE delivery_state = 'pending'
          AND (lease_until_utc IS NULL OR lease_until_utc < ?)
          AND delivery_attempts < ?
        ORDER BY uploaded_at_utc, snapshot_id
        LIMIT ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM bazaardb_delivery
        WHERE delivery_state = 'pending'
          AND lease_until_utc >= ?
      )
      RETURNING snapshot_id, r2_key, uploaded_at_utc
    `,
  )
    .bind(
      peekId,
      leaseExpiresAtUtc,
      nowUtc,
      nowUtc,
      MaxDeliveryAttempts,
      maxItems,
      nowUtc,
    )
    .all<ClaimedDeliveryRow>();

  if (claim.results.length === 0) {
    const outstanding = await findOutstandingLease(env, nowUtc);
    if (outstanding) {
      const leased = await env.DB.prepare(
        `
          SELECT snapshot_id, r2_key, uploaded_at_utc
          FROM bazaardb_delivery
          WHERE lease_peek_id = ?
            AND delivery_state = 'pending'
        `,
      )
        .bind(outstanding.lease_peek_id)
        .all<ClaimedDeliveryRow>();

      return json(
        {
          status: "peek_outstanding",
          peek_id: outstanding.lease_peek_id,
          lease_expires_at_utc: outstanding.lease_until_utc,
          items: await presignItems(presigner, leased.results),
        },
        { status: 409 },
      );
    }
    return json({ peek_id: null, items: [] });
  }

  const { live, gone } = await splitByObjectPresence(env, claim.results);
  await failGoneRows(env, peekId, gone, nowUtc);

  if (live.length === 0) {
    logInfo("bazaardb.peek", {
      peek_id: peekId,
      item_count: 0,
      gone_count: gone.length,
      phase_ms: { total: Date.now() - phaseStart },
      outcome: "all_gone",
    });
    return json({ peek_id: null, items: [] });
  }

  const items = await presignItems(presigner, live);

  logInfo("bazaardb.peek", {
    peek_id: peekId,
    item_count: items.length,
    gone_count: gone.length,
    phase_ms: { total: Date.now() - phaseStart },
    outcome: "ok",
  });

  return json({
    peek_id: peekId,
    lease_expires_at_utc: leaseExpiresAtUtc,
    items,
  });
}
