import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

test("the initial migration creates only the V5 domain tables", async () => {
  const result = await env.DB.prepare(
    `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE '_cf_%'
        AND name NOT LIKE 'sqlite_%'
        AND name <> 'd1_migrations'
      ORDER BY name
    `,
  ).all<{ name: string }>();

  expect(result.results.map(({ name }) => name)).toEqual([
    "bazaardb_deliveries",
    "bazaardb_delivery_attempts",
    "bundle_uploaders",
    "bundles",
    "ghost_battles",
  ]);
});

describe("V5 relational constraints", () => {
  const validBundleSql = `INSERT INTO bundles (
    bundle_id, run_id, uploader_account_id, object_key, bundle_sha256,
    bundle_version, manifest_bytes, object_bytes, client_created_at_ms,
    stored_at_ms, available_at_ms, run_format_version, run_bytes, run_sha256,
    has_screenshot, screenshot_content_type, screenshot_bytes, screenshot_sha256
  ) VALUES (?1, ?2, 'schema-uploader', ?3, ?4, 5, 10, 100, 1, 1, 1, 5, 10, ?4, ?5, ?6, ?7, ?8)`;

  test("foreign keys are enabled and reject a Ghost row without its Bundle", async () => {
    const foreignKeys = await env.DB.prepare(`PRAGMA foreign_keys`).first<{ foreign_keys: number }>();
    expect(foreignKeys?.foreign_keys).toBe(1);
    await expect(
      env.DB.prepare(
        `INSERT INTO ghost_battles (
          uploader_account_id, battle_id, bundle_id, opponent_account_id,
          recorded_at_ms, projection_json
        ) VALUES ('a', 'b', 'missing', 'c', 1, '{}')`,
      ).run(),
    ).rejects.toThrow();
  });

  test("Screenshot metadata cannot exploit SQLite NULL CHECK semantics", async () => {
    await expect(
      env.DB.prepare(validBundleSql)
        .bind(
          "01J00000000000000000000501",
          "schema-run-screenshot-null",
          "bundles/2026-08-02/01J00000000000000000000501.bundle",
          "a".repeat(64),
          1,
          null,
          null,
          null,
        )
        .run(),
    ).rejects.toThrow();
  });

  test("active claim order must be an integer within the claim page", async () => {
    const bundleId = "01J00000000000000000000503";
    await env.DB.prepare(validBundleSql)
      .bind(
        bundleId,
        "schema-run-fractional-claim-order",
        `bundles/2026-08-02/${bundleId}.bundle`,
        "c".repeat(64),
        0,
        null,
        null,
        null,
      )
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO bazaardb_deliveries (
          bundle_id, active_claim_id, active_claim_order, claimable_at_ms,
          delivery_attempts, created_at_ms, state_updated_at_ms
        ) VALUES (?1, 'claim-fractional', 0.5, 2, 1, 1, 1)`,
      )
        .bind(bundleId)
        .run(),
    ).rejects.toThrow();
  });

  test("a failed D1 batch rolls back the entire Bundle logical commit", async () => {
    const bundleId = "01J00000000000000000000502";
    await expect(
      env.DB.batch([
        env.DB.prepare(validBundleSql).bind(
          bundleId,
          "schema-run-atomic",
          `bundles/2026-08-02/${bundleId}.bundle`,
          "b".repeat(64),
          0,
          null,
          null,
          null,
        ),
        env.DB.prepare(
          `INSERT INTO ghost_battles (
            uploader_account_id, battle_id, bundle_id, opponent_account_id,
            recorded_at_ms, projection_json
          ) VALUES ('schema-uploader', 'bad-json', ?1, 'schema-uploader', 1, 'not-json')`,
        ).bind(bundleId),
        env.DB.prepare(
          `INSERT INTO bundle_uploaders (player_account_id, first_bundle_at_ms)
           VALUES ('schema-uploader', 1)`,
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(`SELECT bundle_id FROM bundles WHERE bundle_id = ?1`)
        .bind(bundleId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT player_account_id FROM bundle_uploaders WHERE player_account_id = 'schema-uploader'`,
      ).first(),
    ).toBeNull();
  });
});
