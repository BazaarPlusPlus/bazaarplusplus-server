import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("the initial migration creates only the V5 domain and maintenance tables", async () => {
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
    "maintenance_state",
  ]);
});
