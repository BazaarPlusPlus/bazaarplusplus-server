import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

async function plan(sql: string, bindings: unknown[] = []): Promise<string> {
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all<{
    detail: string;
  }>();
  return result.results.map(({ detail }) => detail).join("\n");
}

describe("critical D1 query plans", () => {
  test("Bundle collection uses its covering keyset index without a temporary sort", async () => {
    const detail = await plan(
      `SELECT bundle_id, available_at_ms, object_key
       FROM bundles INDEXED BY idx_bundles_available
       WHERE available_at_ms >= ?1 AND available_at_ms < ?2
         AND (?3 IS NULL OR available_at_ms > ?3 OR (available_at_ms = ?3 AND bundle_id > ?4))
       ORDER BY available_at_ms ASC, bundle_id ASC LIMIT ?5`,
      [1, 2, null, null, 201],
    );
    expect(detail).toContain("idx_bundles_available");
    expect(detail).toContain("COVERING");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  test("Ghost discovery uses the opponent/time index and Bundle primary key", async () => {
    const detail = await plan(
      `SELECT g.battle_id, g.bundle_id, g.recorded_at_ms, g.is_final_battle,
              g.projection_json, x.object_key
       FROM ghost_battles AS g INDEXED BY idx_ghost_battles_query
       JOIN bundles AS x ON x.bundle_id = g.bundle_id
       WHERE g.opponent_account_id = ?1 AND g.recorded_at_ms >= ?2
       ORDER BY g.recorded_at_ms DESC, g.battle_id DESC LIMIT ?3`,
      ["account", 1, 200],
    );
    expect(detail).toContain("idx_ghost_battles_query");
    expect(detail).toMatch(/PRIMARY KEY|sqlite_autoindex_bundles_1/);
    expect(detail).not.toContain("TEMP B-TREE");
  });

  test("claim, active claim and exhausted lease queries use their partial indexes", async () => {
    const claimable = await plan(
      `SELECT bundle_id FROM bazaardb_deliveries INDEXED BY idx_bazaardb_claimable
       WHERE delivery_state = 'pending' AND delivery_attempts < 3 AND claimable_at_ms <= ?1
       ORDER BY claimable_at_ms, created_at_ms, bundle_id LIMIT ?2`,
      [1, 50],
    );
    expect(claimable).toContain("idx_bazaardb_claimable");
    expect(claimable).not.toContain("TEMP B-TREE");

    const claimUpdate = await plan(
      `WITH candidates AS MATERIALIZED (
         SELECT bundle_id,
                ROW_NUMBER() OVER (
                  ORDER BY claimable_at_ms, created_at_ms, bundle_id
                ) - 1 AS claim_order
         FROM bazaardb_deliveries INDEXED BY idx_bazaardb_claimable
         WHERE delivery_state = 'pending'
           AND delivery_attempts < 3
           AND claimable_at_ms <= ?1
         ORDER BY claimable_at_ms, created_at_ms, bundle_id
         LIMIT ?4
       )
       UPDATE bazaardb_deliveries
       SET active_claim_id = ?2,
           active_claim_order = (
             SELECT claim_order FROM candidates
             WHERE candidates.bundle_id = bazaardb_deliveries.bundle_id
           ),
           claimable_at_ms = ?3,
           delivery_attempts = delivery_attempts + 1,
           state_updated_at_ms = ?1
       WHERE bundle_id IN (SELECT bundle_id FROM candidates)
         AND delivery_state = 'pending'
         AND delivery_attempts < 3
         AND claimable_at_ms <= ?1`,
      [1, "claim", 2, 50],
    );
    expect(claimUpdate).toContain("idx_bazaardb_claimable");

    const active = await plan(
      `SELECT bundle_id FROM bazaardb_deliveries INDEXED BY idx_bazaardb_active_claim
       WHERE delivery_state = 'pending' AND active_claim_id = ?1`,
      ["claim"],
    );
    expect(active).toContain("idx_bazaardb_active_claim");

    const activeOrder = await plan(
      `SELECT bundle_id FROM bazaardb_deliveries INDEXED BY idx_bazaardb_active_claim_order
       WHERE delivery_state = 'pending' AND active_claim_id = ?1
       ORDER BY active_claim_order, bundle_id`,
      ["claim"],
    );
    expect(activeOrder).toContain("idx_bazaardb_active_claim_order");
    expect(activeOrder).not.toContain("TEMP B-TREE");

    const exhausted = await plan(
      `SELECT bundle_id FROM bazaardb_deliveries INDEXED BY idx_bazaardb_exhausted_lease
       WHERE delivery_state = 'pending' AND delivery_attempts = 3
         AND active_claim_id IS NOT NULL AND claimable_at_ms <= ?1`,
      [1],
    );
    expect(exhausted).toContain("idx_bazaardb_exhausted_lease");
  });

  test("settle receipt and attempt uniqueness use the receipt indexes", async () => {
    const receipt = await plan(
      `SELECT outcome, reason FROM bazaardb_delivery_attempts
       WHERE claim_id = ?1 AND bundle_id = ?2`,
      ["claim", "bundle"],
    );
    expect(receipt).toMatch(/PRIMARY KEY|sqlite_autoindex_bazaardb_delivery_attempts_1/);

    const attempt = await plan(
      `SELECT claim_id FROM bazaardb_delivery_attempts
       WHERE bundle_id = ?1 AND attempt_number = ?2`,
      ["bundle", 1],
    );
    expect(attempt).toMatch(/sqlite_autoindex_bazaardb_delivery_attempts_2/);
  });

  test("claim-time R2 expiry uses its stored-time index without a temporary sort", async () => {
    const stored = await plan(
      `SELECT bundle_id
       FROM bundles INDEXED BY idx_bundles_stored_retention
       WHERE stored_at_ms < ?1
       ORDER BY stored_at_ms, bundle_id LIMIT 100`,
      [1],
    );
    expect(stored).toContain("idx_bundles_stored_retention");
    expect(stored).not.toContain("TEMP B-TREE");
  });
});
