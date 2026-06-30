# Architecture Decisions

Standing design decisions for the V4 server. These capture rationale for choices that are not obvious from the code alone and prevent the same questions from being re-litigated.

---

## Two Separate R2 Buckets

The server uses two R2 buckets:

- `bazaarplusplus-run-bundles-v4` — semi-persistent replay artifacts, governed by an R2 lifecycle rule.
- `bazaarplusplus-bazaardb-snapshots-v4` — ephemeral delivery queue items, deleted eagerly on confirm.

They are not merged because their lifecycles are fundamentally different. Run-bundle retention is measured in days/weeks; snapshot objects are transient (confirm → immediate delete, or failed → lifecycle cleanup). Separate buckets avoid prefix-based lifecycle complexity and make token-scope failures easier to diagnose.

## R2 Presigning & Token Scope

R2 bindings (`env.RUN_BUNDLE_BUCKET`, `env.BAZAARDB_BUCKET`) are Workers-native and **do not use the R2 API token**. The token's only role is SigV4 presigning in `src/crypto/presign.ts` — it signs GET URLs that clients download directly from R2.

The token **must have Object Read on both buckets**. If it only covers one, the other bucket's presigned URLs return `AccessDenied` (403) at download time, while the Worker itself (using the binding) sees no error.

Diagnostic: if `replay-link` returns 200 with a URL but the client gets 403, the token scope is wrong.

## `is_final_battle` Sticky Semantics

`is_final_battle` is an active V4 wire field, not a placeholder. Upload writes it with `MAX(battles.is_final_battle, excluded.is_final_battle)` — once true for a `battle_id`, it cannot be reset to false by a later upload. `GET /ghost-battles` returns it as a boolean.

## Battle Ingest Filtering via `seen_player_accounts`

A battle projection is written to `battles` only when:

1. `opponent_account_id` equals the uploader (`?14 = ?6` literal comparison), OR
2. `opponent_account_id` exists in `seen_player_accounts`

NULL opponents are dropped (SQL three-valued logic naturally excludes them).

`seen_player_accounts` is the set of accounts that have uploaded at least one run. It grows monotonically. Battles against not-yet-seen opponents are silently discarded and never backfilled.

**Invariants:**

- Self-battle comparison must be a SQL literal (`?14 = ?6`), not a subquery — D1 does not guarantee batch-internal read-after-write visibility.
- The `seen_player_accounts` upsert must be the final statement in the D1 batch.
- `ON CONFLICT(battle_id) DO UPDATE` must be retained to prevent intra-batch rollbacks.

## Data Retention

- `runs` and `battles` D1 rows are retained indefinitely. There is no `DELETE` path, TTL, or scheduled sweep.
- Run-bundle R2 objects are governed by an R2 lifecycle rule in the CF dashboard (not in code). **Invariant: retention must be >= 5 days** (the ghost query lookback window). Below that, `replay-link` silently returns 410 for in-window battles.
- Orphan D1 rows (whose R2 object has expired) are expected; `replay-link` surfaces them as 410 `artifact_expired`.
- BazaarDB `done` objects are deleted at confirm time. `failed` objects are left to the bucket's R2 lifecycle rule.
- **Invariant: BazaarDB snapshot retention must exceed the partner's worst-case pull lag (target >= 7 days).** The snapshot bucket lifecycle is set in the CF dashboard. Below this floor, objects age out while their `bazaardb_delivery` row is still `pending`; `peek` then marks such rows `failed` with `failure_reason='object_gone'` (accepted loss) — there is no other signal.

## BazaarDB Delivery Semantics

Delivery is at-least-once within at most 3 peek claims. After 3 claims without confirm, a snapshot is marked `failed` — terminal state, never re-queued. The R2 object is not deleted immediately on failure; cleanup is deferred to the bucket lifecycle rule.

Re-uploading the same `snapshot_id` is a no-op once any row exists (regardless of state). The server does not revive failed rows.

## Analyzers Coupling

The `analyzers` pipeline reads `runs` directly via the Cloudflare D1 REST API (not through this Worker). Frozen contract:

- All 24 column names in `migrations/0001_v4_initial.sql` lines 7–32.
- `updated_at_utc` and `created_at_utc` are server-stamped (`new Date().toISOString()`) — the lexicographic format is a hard invariant (keyset cursor).
- `idx_runs_updated_at` must exist (used for incremental mirror).
- Analyzers do **not** consume D1 `battles`.
