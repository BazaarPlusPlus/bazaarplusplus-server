# Structural Refactor Summary

- **Date**: 2026-06-07
- **Status**: **Landed** (commits `4971719`, `1ab05b8`, `548395c`, `caf992b`, `6a83422`, `639dc45`)
- **Origin**: Architecture/DTO audit (35 findings adversarially verified, 0 refuted). Baseline HEAD `dad7fdd`.

---

## Work Packages (All Complete)

| WP | Title | Commit | Summary |
|---|---|---|---|
| WP1 | Delete dead validation machinery | `4971719` | Removed `src/http/validation.ts`; moved live exports to `request.ts` |
| WP2 | Extract multipart byte parser | `1ab05b8` | Created `src/features/runBundles/multipart.ts` (~150 lines extracted) |
| WP3 | Narrow `putThenProject` callbacks | `548395c` | Removed 4 failure callbacks; callers now log inline from the result |
| WP4 | Micro-dedup and fold-ins | `caf992b` | Added `requestMediaType`/`declaredContentLengthExceeds`; deleted `config.ts` |
| WP5 | Doc sync | `6a83422` | Fixed `api-reference.md` stale bullets and broken GFM tables |
| WP6 | Null-metadata hardening | `639dc45` | Literal `null` metadata → 400; `null` battle elements → skip |

## Frozen Surfaces (Preserved Throughout)

- Mod wire contract: route patterns, multipart part names, field names, error envelope
- Analyzers coupling: all 24 `runs` column names, timestamp format, `idx_runs_updated_at`
- BazaarDB endpoints: request/response shapes, 409 semantics, bearer auth
- Project-rule invariants: `run_id` immutability, `ON CONFLICT(battle_id)`, sticky `MAX()`, `?14 = ?6`, `seen_player_accounts` as final batch statement

## Verification

All 57 tests passing after each WP. No behavior changes except WP6 (approved: null metadata → 400 instead of 500).
