# V4 Server Audit Report & Optimization Plan

- **Date**: 2026-06-05
- **Scope**: `bazaarplusplus-server` (V4 mod-facing backend, `mod-api-v4.bazaarplusplus.com`, Cloudflare Workers / D1 / R2 / aws4fetch). Read-only audit — no code changes in this document.
- **Baseline**: `npm run check` pass; `npm run test` 33/33 pass.
- **Status**: P0, P1, P3 repo-local items **landed** (commits `ba35436`, `e66bf03`, `f884fcf`, `dad7fdd`, `4971719`–`0664155`). P2 (security) remains a decision item.

---

## Executive Summary

No Critical, no surviving High findings. Codebase is healthy — hot-path SQL hits indexes, `env.ts` discipline holds, `presign.ts` is a clean deep module.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Run-bundle concurrent upload race: loser cleanup deletes winner's artifact | Medium | **Fixed** (`ba35436`) |
| 2 | BazaarDB peek constructs presigner after consuming attempt | Medium | **Fixed** (`ba35436`) |
| 3 | `CLAUDE.md` rule re `is_final_battle` contradicts code | Medium | **Fixed** (`93bda66`) |
| 4 | BazaarDB doc promises infinite retry; code caps at 3 | Medium | **Fixed** (doc updated) |
| 5 | Root `bpp/CLAUDE.md` says server "serves screenshot manifest" (deleted route) | Medium | **Fixed** |
| 6 | `replay-link` + `/run-bundles` zero auth (IDOR + feed poisoning) | Medium | **Open** (P2 decision) |
| 7 | Bucket name hardcoding vs binding dual-source | Low | **Fixed** (env vars) |
| 8 | V3→V5 dead code and speculative config | Low | **Fixed** (`4971719`, `caf992b`) |
| 9 | Observability gaps: 409/4xx/404/410/500 all silent | Low | **Fixed** (`ba35436`) |
| 10 | Hot-path SQL shape healthy (verified via EXPLAIN) | — | No action needed |

---

## Decision Records

### D-1: Keep Two R2 Buckets

- **Decision**: Retain `bazaarplusplus-run-bundles-v4` and `bazaarplusplus-bazaardb-snapshots-v4` separately.
- **Rationale**: Fundamentally different lifecycles — run-bundles are semi-persistent replay artifacts (R2 lifecycle-governed), snapshots are ephemeral delivery queue items (confirm-then-delete). Merging would require prefix-based lifecycle rules and not solve token-rotation failures. Fixing token scope is zero-code.

### D-2: `is_final_battle` Is an Active Wire Field

- **Decision**: `is_final_battle` is part of the V4 wire contract. Upload writes it with sticky `MAX()` semantics; `GET /ghost-battles` returns it as a boolean.
- **Rationale**: Activated by commit `945249e`; documented in `api-reference.md`; asserted in tests.

---

## Resolved: Replay Link 403 Root Cause

Users saw 403 when GETting the presigned R2 URL for replay downloads. Root cause: **R2 API token scope only covered the BazaarDB bucket**, not the run-bundles bucket.

- `peek` worked because its presign targets the BazaarDB bucket (token has access).
- `replay-link` presigned the run-bundles bucket (token lacks access) → client GET → `AccessDenied`.
- R2 bindings (`env.*_BUCKET`) are Workers-native and don't use the token; the token is only used by `presign.ts` for SigV4 GET URLs.

**Resolution**: Reissued R2 API token covering both buckets (Object Read scope). No code change needed.

---

## Open: P2 Security (Decision Required)

Three mod-facing endpoints have zero authentication:

1. **Replay-link IDOR**: Any `battle_id` yields someone else's full run artifact presigned URL.
2. **`/run-bundles` poisoning**: Anonymous can inject fake battles into any player's ghost feed.
3. **`/ghost-battles` metadata enumeration**: Returns identifiable player metadata without auth.

**Options** (need decision before implementation):
- (a) Lightweight token/HMAC for mod-facing endpoints
- (b) Caller-account binding validation
- (c) CF edge rate limiting + accept as known risk

**Blockers**: Requires wire contract change + mod client coordination for any auth option. Need to verify if CF WAF/Rate Limiting is already configured at the edge (not visible in this repo).
