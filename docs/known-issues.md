# Known Issues

Open items that have been analyzed but not yet implemented, pending decisions or cross-repo coordination.

---

## Mod-Facing Endpoints Have No Authentication

Three mod-facing endpoints accept unauthenticated requests:

| Endpoint | Risk |
|---|---|
| `POST /ghost-battles/:id/replay-link` | IDOR — any `battle_id` yields another player's artifact download URL |
| `POST /run-bundles` | Anonymous can inject fake battles into any player's ghost feed |
| `GET /ghost-battles` | Returns identifiable player metadata; enumerable |

`seen_player_accounts` filtering partially mitigates `/run-bundles` poisoning (can only target known BPP users), but does not fix the fundamental issue.

**Options under consideration:**
- Lightweight token/HMAC on mod-facing routes
- Caller-account binding (validate uploader identity server-side)
- CF edge rate limiting + document as accepted risk

Any auth option changes the wire contract and requires coordinated mod client updates.

**Pre-check needed:** Verify whether CF WAF / Rate Limiting / Access is already configured on `mod-api-v4.bazaarplusplus.com` (not visible in this repo or `wrangler.toml`).

---

## BazaarDB Failed-State R2 Cleanup

Currently, when a snapshot reaches max delivery attempts (3), `failMaxAttemptRows` marks it `failed` **and** immediately deletes the R2 object. This means a configuration incident (e.g., wrong token scope causing repeated download 403s) can burn through the entire pending queue in ~30 minutes with no recovery path.

**Proposed improvement:** Only mark failed; defer R2 deletion to the bucket lifecycle rule. This does not enable recovery (failed is still terminal), but it separates the "accepted loss" decision from the physical cleanup, giving ops a window to investigate.

Requires: BazaarDB notification (internal behavior change, no request/response shape change).

---

## `logProjectFailure` Duplication

`src/features/runBundles/upload.ts` and `src/features/bazaardb/upload.ts` contain near-identical `switch` blocks mapping `CleanupOutcome` to log events. Neither has compile-time exhaustiveness checking — adding a new `CleanupOutcome` variant would silently skip logging in both callers.

**Fix:** Extract a shared `logProjectFailure` helper with a `Record<CleanupOutcome, ...>` map.

---

## Battle Column List Drift Risk

The 25-column battle projection is restated across 7+ locations (TypeScript types, SQL, bind calls, query SELECT, response mapping, migration, API docs). A positional error (e.g., swapping `?14` and `?6`) would silently corrupt data. There is no CI guard against drift today.

**Minimal fix:** A schema test asserting `PRAGMA table_info(battles)` column order matches a runtime constant array.

---

## `/health` Is Liveness Only

`GET /health` returns 200 without probing D1, R2, or secrets. A green `/health` does not mean presigning or D1 writes work. This is documented in `api-reference.md` but not surfaced to monitoring.

---

## Uncaught 500s Lack CORS and JSON Envelope

When an unexpected exception propagates to the top-level catch in `src/index.ts`, the response is a bare 500 without CORS headers or the standard `{"error":"..."}` envelope. This doesn't affect the mod client (it retries any non-2xx without inspecting the body) but makes debugging harder in browser-based tooling.
