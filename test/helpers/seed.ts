type SqlValue = string | number | null;

export type InsertSeenPlayerAccountArgs = {
  playerAccountId: string;
  firstSeenAtUtc: string;
};

function exec(db: D1Database, sql: string, values: SqlValue[]): Promise<unknown> {
  return db.prepare(sql).bind(...values).run();
}

export async function resetTestState(env: {
  DB: D1Database;
  RUN_BUNDLE_BUCKET: R2Bucket;
  BAZAARDB_BUCKET: R2Bucket;
}): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM battles"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM seen_player_accounts"),
    env.DB.prepare("DELETE FROM bazaardb_delivery"),
  ]);
  for (const bucket of [env.RUN_BUNDLE_BUCKET, env.BAZAARDB_BUCKET]) {
    const list = await bucket.list();
    for (const obj of list.objects) {
      await bucket.delete(obj.key);
    }
  }
}

export async function insertSeenPlayerAccount(
  db: D1Database,
  args: InsertSeenPlayerAccountArgs,
): Promise<void> {
  await exec(
    db,
    "INSERT INTO seen_player_accounts (player_account_id, first_seen_at_utc) VALUES (?, ?)",
    [args.playerAccountId, args.firstSeenAtUtc],
  );
}

export async function selectFirst<T>(
  db: D1Database,
  sql: string,
  values: SqlValue[] = [],
): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}

export async function countRows(
  db: D1Database,
  table: "runs" | "battles" | "seen_player_accounts" | "bazaardb_delivery",
): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}
