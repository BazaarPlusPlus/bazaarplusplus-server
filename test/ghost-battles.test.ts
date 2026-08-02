import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import worker from "../src/index";
import { makeBundleFixture, uploadRequest } from "./fixtures/bundle";

describe("GET /ghost-battles", () => {
  test("applies uploader eligibility without backfilling filtered history", async () => {
    const now = Date.now();
    const accountA = "ghost-uploader-a";
    const accountB = "ghost-opponent-b";
    const old = await makeBundleFixture({
      bundleId: "01J00000000000000000000201",
      runId: "ghost-run-a-old",
      uploaderAccountId: accountA,
      opponentAccountId: accountB,
      createdAtMs: now - 30_000,
      battles: undefined,
    });
    const bSelf = await makeBundleFixture({
      bundleId: "01J00000000000000000000202",
      runId: "ghost-run-b-self",
      uploaderAccountId: accountB,
      opponentAccountId: accountB,
      createdAtMs: now - 20_000,
    });
    const fresh = await makeBundleFixture({
      bundleId: "01J00000000000000000000203",
      runId: "ghost-run-a-fresh",
      uploaderAccountId: accountA,
      opponentAccountId: accountB,
      createdAtMs: now - 10_000,
      battles: [
        {
          battle_id: "battle-a-fresh",
          recorded_at_ms: now - 10_001,
          day: 11,
          hour: 3,
          encounter_id: null,
          combat_kind: "pvp",
          result: "loss",
          winner_combatant_id: "combatant-b",
          loser_combatant_id: "combatant-a",
          is_final_battle: false,
          player: {
            account_id: accountA,
            display_name: "A",
            hero_id: null,
            hero_name: "Vanessa",
            rank: null,
            rating: null,
            level: 9,
            prestige: 1,
            victories: 5,
          },
          opponent: {
            account_id: accountB,
            display_name: "B",
            hero_id: null,
            hero_name: "Pygmalien",
            rank: null,
            rating: null,
            level: 9,
            prestige: 1,
            victories: 6,
          },
        },
      ],
    });

    for (const fixture of [old, bSelf, fresh]) {
      const uploaded = await worker.fetch(uploadRequest(fixture.body, fixture.headers), env);
      expect(uploaded.status).toBe(201);
    }

    const response = await worker.fetch(
      new Request(
        `https://mod-api-v5.bazaarplusplus.com/ghost-battles?player_account_id=${accountB}`,
        { headers: { "CF-Connecting-IP": "203.0.113.9" } },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      battles: Array<Record<string, unknown>>;
    };
    expect(body.battles.map(({ battle_id }) => battle_id)).toEqual([
      "battle-a-fresh",
      "battle-001",
    ]);
    expect(body.battles[0]).toMatchObject({
      bundle_id: "01J00000000000000000000203",
      opponent: { account_id: accountB },
      player: { account_id: accountA },
      is_final_battle: false,
    });
    expect(new URL(body.battles[0].download_url as string).searchParams.get("X-Amz-Expires")).toBe(
      "604800",
    );
  });

  test("rate limits before parsing the query or touching D1", async () => {
    let key = "";
    let databaseTouched = false;
    const blockedEnv = {
      ...env,
      GHOST_BATTLE_RATE_LIMITER: {
        async limit(options: { key: string }) {
          key = options.key;
          return { success: false };
        },
      },
      DB: {
        prepare() {
          databaseTouched = true;
          throw new Error("D1 must not be touched");
        },
      },
    } as unknown as Cloudflare.Env;
    const response = await worker.fetch(
      new Request("https://mod-api-v5.bazaarplusplus.com/ghost-battles?bad=query", {
        headers: { "CF-Connecting-IP": "198.51.100.7" },
      }),
      blockedEnv,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(key).toBe("198.51.100.7");
    expect(databaseTouched).toBe(false);
  });

  test("preserves the first cross-Bundle projection for one uploader and battle ID", async () => {
    const account = "ghost-duplicate-uploader";
    const first = await makeBundleFixture({
      bundleId: "01J00000000000000000000211",
      runId: "ghost-duplicate-run-1",
      uploaderAccountId: account,
      opponentAccountId: account,
      createdAtMs: Date.now() - 2_000,
    });
    const second = await makeBundleFixture({
      bundleId: "01J00000000000000000000212",
      runId: "ghost-duplicate-run-2",
      uploaderAccountId: account,
      opponentAccountId: account,
      createdAtMs: Date.now() - 1_000,
    });
    expect((await worker.fetch(uploadRequest(first.body, first.headers), env)).status).toBe(201);
    expect((await worker.fetch(uploadRequest(second.body, second.headers), env)).status).toBe(201);

    const response = await worker.fetch(
      new Request(
        `https://mod-api-v5.bazaarplusplus.com/ghost-battles?player_account_id=${account}`,
      ),
      env,
    );
    const body = (await response.json()) as { battles: Array<{ bundle_id: string }> };
    expect(body.battles).toHaveLength(1);
    expect(body.battles[0].bundle_id).toBe("01J00000000000000000000211");
  });

  test("enforces the 5-day window and 200-row maximum", async () => {
    const account = "ghost-cap-opponent";
    const bundleId = "01J00000000000000000000220";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO bundles (
        bundle_id, run_id, uploader_account_id, object_key, bundle_sha256,
        bundle_version, manifest_bytes, object_bytes, client_created_at_ms,
        stored_at_ms, available_at_ms, run_format_version, run_bytes, run_sha256,
        has_screenshot
      ) VALUES (?1, 'ghost-cap-run', 'ghost-cap-uploader', ?2, ?3,
                5, 10, 100, ?4, ?4, ?4, 5, 10, ?3, 0)`,
    )
      .bind(
        bundleId,
        `bundles/2026-08-02/${bundleId}.bundle`,
        "c".repeat(64),
        now,
      )
      .run();
    const projection = JSON.stringify({
      day: 1,
      hour: 1,
      encounter_id: null,
      combat_kind: "pvp",
      result: "win",
      winner_combatant_id: null,
      loser_combatant_id: null,
      player: {
        account_id: "ghost-cap-uploader",
        display_name: "Uploader",
        hero_id: null,
        hero_name: null,
        rank: null,
        rating: null,
        level: null,
        prestige: null,
        victories: null,
      },
      opponent: {
        account_id: account,
        display_name: "Opponent",
        hero_id: null,
        hero_name: null,
        rank: null,
        rating: null,
        level: null,
        prestige: null,
        victories: null,
      },
    });
    const statements = Array.from({ length: 202 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO ghost_battles (
          uploader_account_id, battle_id, bundle_id, opponent_account_id,
          recorded_at_ms, is_final_battle, projection_json
        ) VALUES ('ghost-cap-uploader', ?1, ?2, ?3, ?4, 0, ?5)`,
      ).bind(
        `ghost-cap-${String(index).padStart(3, "0")}`,
        bundleId,
        account,
        index === 201 ? now - 6 * 86_400_000 : now - index,
        projection,
      ),
    );
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.DB.batch(statements.slice(offset, offset + 50));
    }

    const response = await worker.fetch(
      new Request(
        `https://mod-api-v5.bazaarplusplus.com/ghost-battles?player_account_id=${account}`,
      ),
      env,
    );
    const body = (await response.json()) as {
      battles: Array<{ battle_id: string }>;
    };
    expect(body.battles).toHaveLength(200);
    expect(body.battles[0].battle_id).toBe("ghost-cap-000");
    expect(body.battles.at(-1)?.battle_id).toBe("ghost-cap-199");
    expect(body.battles.some(({ battle_id }) => battle_id === "ghost-cap-201")).toBe(false);
  });

  test("keeps both uploader directions when both players upload the same Battle", async () => {
    const accountA = "ghost-direction-a";
    const accountB = "ghost-direction-b";
    const fixtures = [
      await makeBundleFixture({
        bundleId: "01J00000000000000000000231",
        runId: "ghost-direction-seed-a",
        uploaderAccountId: accountA,
        battles: [],
      }),
      await makeBundleFixture({
        bundleId: "01J00000000000000000000232",
        runId: "ghost-direction-seed-b",
        uploaderAccountId: accountB,
        battles: [],
      }),
      await makeBundleFixture({
        bundleId: "01J00000000000000000000233",
        runId: "ghost-direction-run-a",
        uploaderAccountId: accountA,
        opponentAccountId: accountB,
        createdAtMs: Date.now() - 2_000,
      }),
      await makeBundleFixture({
        bundleId: "01J00000000000000000000234",
        runId: "ghost-direction-run-b",
        uploaderAccountId: accountB,
        opponentAccountId: accountA,
        createdAtMs: Date.now() - 1_000,
      }),
    ];
    for (const fixture of fixtures) {
      expect((await worker.fetch(uploadRequest(fixture.body, fixture.headers), env)).status).toBe(201);
    }

    const [forA, forB] = await Promise.all(
      [accountA, accountB].map(async (account) => {
        const response = await worker.fetch(
          new Request(
            `https://mod-api-v5.bazaarplusplus.com/ghost-battles?player_account_id=${account}`,
          ),
          env,
        );
        return (await response.json()) as {
          battles: Array<{ battle_id: string; player: { account_id: string } }>;
        };
      }),
    );
    expect(forA.battles).toMatchObject([
      { battle_id: "battle-001", player: { account_id: accountB } },
    ]);
    expect(forB.battles).toMatchObject([
      { battle_id: "battle-001", player: { account_id: accountA } },
    ]);
  });
});
