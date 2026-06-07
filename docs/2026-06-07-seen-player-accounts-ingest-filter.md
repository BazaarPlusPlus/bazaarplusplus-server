# Battle Ingest Filtering via `seen_player_accounts`

- **Date**: 2026-06-07
- **Status**: **Landed** (commit `dad7fdd`)
- **Scope**: `POST /run-bundles` battle ingest + new `seen_player_accounts` table.

---

## Summary

Reintroduced opponent-side ingest filtering for the `battles` table. Only battles whose `opponent_account_id` equals the uploader (self-battle) or exists in `seen_player_accounts` are written. NULL opponents are dropped.

This was originally implemented in `5f598a0`, removed in `a9539ba` (full-ingest decision), and restored in this change after confirming analyzers do not consume D1 `battles`.

## Design Decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Drop NULL opponents | SQL naturally filters them (`NULL IN (...)` is never true) |
| D2 | Analyzers don't consume D1 `battles` | Cross-repo blocker resolved; no metric impact |
| D3 | Don't clean historical dead rows | Only filter going forward; retroactive cleanup is a separate ops action |
| D4 | Use SQL conditional INSERT (`INSERT ... SELECT ... WHERE`) | Atomic within D1 batch; no app-level filtering needed |
| D5 | Accept cold-start loss | New user's battles from before their first upload are permanently dropped |

## Implementation Invariants

1. **Self-battle branch uses literal `?14 = ?6`**, not the subquery. D1 does not guarantee batch-internal read-after-write visibility, so the uploader's own `seen_player_accounts` row (written as the batch's last statement) cannot be relied upon for this request's battles.

2. **`seen_player_accounts` upsert is always the final D1 batch statement.** It serves future requests only; placing it last preserves the existing battle-count slice logic.

3. **`ON CONFLICT(battle_id) DO UPDATE` is retained** per project rules — prevents batch rollback on intra-batch `battle_id` collisions.

## Schema

```sql
CREATE TABLE seen_player_accounts (
  player_account_id TEXT PRIMARY KEY,
  first_seen_at_utc TEXT NOT NULL
);
```

Seeded from historical `runs.player_account_id` via migration `0003_add_seen_player_accounts.sql`.

## Deployment

1. `wrangler d1 migrations apply DB --remote` (creates table + backfills from `runs`)
2. `wrangler deploy` (new filtering code goes live)
3. Post-deploy catch-up backfill (covers uploaders from the migration-to-deploy window)

## Rollback

`git revert` the upload.ts change restores full-ingest. The `seen_player_accounts` table becomes an unused no-op; drop it in a follow-up migration if permanently abandoned.
