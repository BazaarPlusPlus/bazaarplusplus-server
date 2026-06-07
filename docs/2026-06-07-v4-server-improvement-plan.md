# V4 Server Improvement Plan (Third-Round Review)

- **Date**: 2026-06-07
- **Scope**: `bazaarplusplus-server` (V4 mod-facing backend). Execution plan based on third-round audit.
- **Baseline**: `npm run check` pass; `npm run test` 59/59 pass.
- **Status**: Track A (quick wins) **landed** in commit `0664155`. Tracks B–E remain open.

---

## Completed (Track A)

| Item | Commit | Summary |
|---|---|---|
| Drop `idx_bazaardb_delivery_pending_order` | `0664155` | Zero-read index causing pure write amplification; migration 0004 |
| BazaarDB mass failure alert | `0664155` | `logError` when failed count hits threshold |
| `confirm` parallel R2 delete | `0664155` | `Promise.all` instead of serial `for...of await` |
| Timestamp upper-bound clamping | `0664155` | `submitted_at_utc`/`ended_at_utc`/`started_at_utc` clamped to `now + 10min` |

---

## Open Items

### Track B — Robustness (Decided, Not Yet Implemented)

**Timestamp clamping for `runs` columns** — Decided in favor of option (a): source-level clamping. Keyset cursors use server-stamped `updated_at_utc`/`created_at_utc` and are unaffected. Already landed in `0664155`.

### Track C — Structural Hygiene

**3.2 Extract `logProjectFailure`**: Both `upload.ts` and `bazaardb/upload.ts` have near-identical `switch` blocks mapping `CleanupOutcome` to log events, with no exhaustiveness check. Extracting a shared helper would restore compile-time guarantees.

**3.1 Column list drift guard**: The 25-column battle projection is restated in 7+ places. A CI test asserting `PRAGMA table_info` matches a runtime column list would catch drift early. Deeper codegen (deriving types/queries from the list) is optional.

### Track D — Decision Items (Blocked on Decisions)

**1.1b BazaarDB failed-state semantics**: Currently `failMaxAttemptRows` marks failed AND immediately deletes R2. Proposed: only mark failed, let R2 lifecycle clean up. This aligns with the documented "failed is accepted loss" semantics but changes observable behavior. Requires BazaarDB notification.

**2.2 Data retention strategy**: D1 rows are retained indefinitely (no `DELETE`, no cron). Run-bundle R2 lifecycle must be >= 5 days (ghost query lookback). Options: (a) document-only, (b) add `[triggers]` scheduled sweep.

**4-c Mod-facing auth / rate limiting (P2)**: Zero-auth endpoints allow IDOR, ghost-feed poisoning, and metadata enumeration. Options: token/HMAC, account binding, or CF edge rate limiting. Requires mod client coordination.

### Track E — Documentation (Zero Risk)

| Item | Summary |
|---|---|
| 1.3 | Document 500 behavior for all endpoints; optionally wrap in CORS + JSON envelope |
| 4-a | Note `/health` is liveness-only (no D1/R2/secret probe) |
| 4-b | Note Content-Length bypass: without the header, size cap enforced after buffering |

---

## Decision Checklist

1. **R2 lifecycle alignment** (1.1b + 2.2): Keep immediate R2 delete on max-attempts, or defer to lifecycle?
2. **Column drift guard depth** (3.1): CI test only, or derive types/queries from single source?
3. **500 envelope** (1.3): Document only, or also wrap uncaught errors in CORS + `{"error":"internal_error"}`?
4. **P2 auth strategy** (4-c): Token/HMAC vs account binding vs edge rate limiting?
