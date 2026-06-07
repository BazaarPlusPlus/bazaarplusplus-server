# Structural Refactor Execution Prompt — bazaarplusplus-server (2026-06-07)

> **Audience**: a fresh agent with no prior context. This document is self-contained.
> **Origin**: human-confirmed output of the 2026-06-07 architecture/DTO audit (35 findings
> adversarially verified, 0 refuted). Every line citation below was verified against
> HEAD `dad7fdd` ("Filter battle ingest by seen_player_accounts").

## Background

This repo is the V4 mod-facing backend (`mod-api-v4.bazaarplusplus.com`): a TypeScript
Cloudflare Worker over D1 + R2. Entry is `src/index.ts` (declarative route table →
feature handlers → shared kernel `src/http|crypto|storage`). Layering is already clean:
no feature→feature imports, no shared-layer→feature imports, no cycles.

A prior optimization wave (commits `ba35436`, `e66bf03`, `f884fcf`, `dad7fdd`) fixed the
correctness/security items. What remains is structural hygiene introduced or orphaned by
that wave. This refactor has **six work packages (WP1–WP6)**. WP1–WP4 are strictly
behavior-preserving. WP6 is a small, human-approved contract-aligning behavior fix.
WP5 is doc-only.

**Target end state**: `src/http/validation.ts` dead machinery gone; the multipart byte
parser lives in its own feature-local module; `putThenProject` has a minimal callback
surface; trivial duplication and the one-line `config.ts` are folded; `docs/api-reference.md`
matches the code; literal-`null` JSON inputs produce documented 400/skip instead of 500.

## Core principles

1. **Code is the single source of truth.** Verify every citation before editing; if a line
   number has drifted, find the construct by name, do not guess.
2. **Behavior preservation.** External behavior, wire shapes, log event names/fields, and
   D1 statement semantics stay identical (WP6 is the sole, explicitly approved exception).
3. **Existing structure is reference, not gospel — but scope is law.** Only touch in-scope
   files. No opportunistic refactoring, no formatting churn, no new features.

## Frozen surfaces (verified cross-repo; violating any of these is a failed refactor)

- **Mod wire contract** (`docs/api-reference.md` is the SSOT): route patterns in
  `src/index.ts:25-47`; multipart part names `metadata`/`artifact`; the exact artifact
  content-type string `application/x-bpp-runbundle+msgpack+gzip`; all snake_case JSON
  field names; the `{"error":"<code>"}` envelope; success-vs-failure status classes.
  Idempotent run-bundle replay (same `run_id` + same hash) must stay 2xx. For
  `POST /bazaardb/snapshots/:id`, the **4xx-vs-5xx class controls the mod's
  permanent-drop-vs-retry decision** — do not reclassify any error status.
- **Analyzers couple directly to D1 `runs`** (Cloudflare REST API, not the Worker): all 24
  column names exactly as in `migrations/0001_v4_initial.sql:7-32`; `updated_at_utc` /
  `created_at_utc` written via `new Date().toISOString()` (`upload.ts:464`) — format is a
  hard invariant (lexicographic keyset cursor); `idx_runs_updated_at` must stay
  (CI-guarded by `test/schema.test.ts`); `payload_hash` = base64(SHA-256(artifact bytes)),
  `size_bytes` = gzipped byte length, artifact bytes are a **byte-exact passthrough** to R2;
  `codec` default string, `schema_version` default 5, `status` default `"completed"` all feed
  analyzer hard gates.
- **BazaarDB partner endpoints** `/bazaardb/peek` + `/bazaardb/confirm`: request/response
  shapes, 409 outstanding-lease semantics, bearer auth — externally frozen.
- **Project-rule invariants** (`CLAUDE.md`): `runs.run_id` immutability + 409 semantics;
  `ON CONFLICT(battle_id) DO UPDATE`; sticky `MAX()` on `is_final_battle`; the literal
  `?14 = ?6` self-battle branch in `BATTLE_INSERT_SQL`; the `seen_player_accounts` upsert
  remains the **final** statement of the D1 batch; R2 puts set only
  `httpMetadata.contentType` (never `customMetadata`).
- **No SQL changes at all in this refactor.** The SQL constants stay in
  `src/features/runBundles/upload.ts` (project rules name that file as their home).

## Work packages — execute in order, one commit each, stop for human review after each

Verification for every package: `npm run check && npm run test` (baseline: 57/57 green).
Commit titles: imperative, no conventional-commit prefix, no trailing punctuation.

---

### WP1 — Delete dead validation machinery

**Why**: `parseBody` (`src/http/validation.ts:80`) has zero callers anywhere (src, test,
docs, configs; no re-exports; no dynamic references). Its last caller was removed by
commit `e66bf03`. Nine private helpers/types (`FieldType` :9, `FieldValue` :13,
`FieldSpec` :19, `Schema` :25, `Parsed` :27, `normalizeSpec` :35, `fail` :39, `trimmed` :43,
`parseField` :51) are reachable only through it. Only `ObjectKeySegmentPattern` (:7) and
`objectKeySegment` (:96-102) are live — used by `src/features/bazaardb/upload.ts:3,61`.

**Changes**:
1. Move `ObjectKeySegmentPattern` and `objectKeySegment` (with its doc comment) into
   `src/http/request.ts` (it already holds the other input sanitizers).
2. Delete `src/http/validation.ts` entirely (including the stale header comment at :3-5
   — "All validators throw a Response on failure" describes only the dead code).
3. Update the import in `src/features/bazaardb/upload.ts:3` to `"../../http/request"`.

**Done when**: `src/http/validation.ts` no longer exists; `grep -rn "http/validation" src/ test/`
is empty; check + tests green. **Rollback**: revert the commit.

---

### WP2 — Extract the multipart byte parser into `src/features/runBundles/multipart.ts`

**Why**: `src/features/runBundles/upload.ts` is 729 lines. Lines 140-285 are a pure,
zero-import byte-level multipart parser (only coupling: part names `"metadata"`/`"artifact"`
at :275-278 and the `RunBundleParts` type :51-57). No test imports parser internals
(coverage is HTTP-only via `worker.fetch`), so a verbatim move is invisible to the suite.

**Changes** (verbatim move — do NOT generalize, human chose feature-local):
1. Create `src/features/runBundles/multipart.ts`. Move, unchanged: `RunBundleParts`
   (:51-57), `isMultipart` (:140-144), `asciiBytes` (:146-152), `indexOfBytes` (:154-174),
   `parseMultipartBoundary` (:176-180), `parseHeaderBlock` (:182-194),
   `parseContentDispositionName` (:196-200), `findHeaderTerminator` (:202-217),
   `findNextBoundary` (:219-235), `parseMultipartBytes` (:237-285).
2. Export only what `upload.ts` consumes: `RunBundleParts`, `isMultipart` (used at :446),
   `parseMultipartBoundary` (used at :402), `parseMultipartBytes` (used at :426). The rest
   stay module-private.
3. `upload.ts` imports them; `decodeRunBundleParts`/`readMultipartRunBundle*` (:343-456)
   and the constant `RunBundleArtifactContentType` **stay in `upload.ts`** (the constant is
   also used at :481 as the `artifact_codec` fallback).

**Done when**: `upload.ts` ≈ 580 lines; no behavior diff; tests green **unchanged**.
**Rollback**: revert the commit.

---

### WP3 — Narrow `putThenProject`'s callback surface

**Why**: of the 6 optional callbacks in `src/storage/putThenProject.ts:42-51`, the four
failure callbacks (`onProjectObjectKept`/`Deleted`/`Orphaned`, `onReferenceLookupFailed`)
fire immediately before a `return` carrying identical data (`error`, `committed`, `cleanup`,
`cleanupError?`, `referenceLookupError?` — see :68-73, :84-89, :94-99, :101-107; **no awaits
between callback and return**). Both callers use them solely for `logWarn`. `onPutSucceeded`
(phase timing) and `onPutFailed` (fires before a rethrow at :56-59) cannot be replaced and stay.

**Changes**:
1. `src/storage/putThenProject.ts`: remove the four `onProject*`/`onReferenceLookupFailed`
   options and their `?.()` invocations; delete the now-orphaned `CleanupCallbackArgs`
   type (:24-28). Keep `onPutSucceeded`/`onPutFailed` and the entire control flow,
   including the returned `ProjectFailure` fields, untouched.
2. `src/features/runBundles/upload.ts`: delete the four callback blocks (:647-683). Right
   after `const projectResult = await putThenProject({...})`, **before** the existing
   raced-run handling (:694-715), add: `if (!projectResult.ok) { logWarn("run_bundles.upload", {...}) }`
   mapping `projectResult.cleanup` to the **byte-identical** outcome strings and fields:
   - `"kept"` → `outcome: "d1_batch_failed_existing_object_kept"`
   - `"deleted"` → `committed == null ? "d1_batch_failed_r2_cleaned" : "d1_batch_failed_raced_object_cleaned"`
   - `"orphaned"` → `outcome: "d1_batch_failed_r2_orphaned"`, plus `cleanup_error: String(projectResult.cleanupError)`
   - `"reference_lookup_failed"` → `outcome: "d1_batch_failed_reference_lookup_failed"`, plus `reference_lookup_error: String(projectResult.referenceLookupError)`
   All entries keep `run_id: runId`, `object_key: objectKey`, `error: String(projectResult.error)`.
3. `src/features/bazaardb/upload.ts`: same transformation for :123-156, preserving its
   strings: `"d1_insert_failed_existing_object_kept"`, `"d1_insert_failed_r2_cleaned"`
   (its `deleted` case has no raced variant), `"d1_insert_failed_r2_orphaned"` (+`cleanup_error`),
   `"d1_insert_failed_reference_lookup_failed"` (+`reference_lookup_error`); fields
   `snapshot_id`, `r2_key`, `error`. Keep the existing final `"d1_insert_failed"` logWarn
   (:165-171) as-is.

**Done when**: log output for every failure path is field-for-field identical to before
(review the mapping side-by-side with the deleted callbacks); `test/putThenProject.test.ts`
(passes no optional callbacks) and the full suite stay green.
**Risk note**: this churns code introduced in `ba35436`; the mapping review is the gate.
**Rollback**: revert the commit.

---

### WP4 — Micro-dedup and fold-ins

**Changes** (each independently revertable inside one commit):
1. `src/http/json.ts`: add
   `export function requestMediaType(request: Request): string | undefined` returning
   `request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()`; use it
   inside `readOptionalJsonObject` (:29). In `src/features/bazaardb/upload.ts`, delete the
   local `isApplicationJson` (:9-12) and use `requestMediaType(request) === "application/json"`
   at its one call site (:70).
2. `src/http/request.ts`: add
   `export function declaredContentLengthExceeds(request: Request, maxBytes: number): boolean`
   encapsulating the `Number.parseInt(request.headers.get("content-length") ?? "", 10)` +
   `Number.isFinite && > max` pattern. Use it at `src/features/runBundles/upload.ts:450-453`
   (keep `throw jsonError("payload_too_large", 413)`) and `src/features/bazaardb/upload.ts:74-77`
   (keep `return jsonError(...)`). Do not change which limit applies where (8 MiB vs 4 MiB).
3. Delete `src/config.ts`; declare `const GHOST_QUERY_LOOKBACK_DAYS = 5;` locally in
   `src/features/ghostBattles/query.ts` (drop the import at :1; usage at :46 unchanged).

**Done when**: `src/config.ts` gone; no duplicated media-type/content-length logic;
check + tests green. **Rollback**: revert the commit.

---

### WP5 — Doc sync (`docs/api-reference.md` only; zero code)

1. **Stale V3-delta bullet** (:138): currently claims "R2 key `player_account_id` segment is
   now always a real id". Replace with: "New V4/V5 upload object keys are opaque
   `run-bundles/<uuid>.mpack.gz` and contain no identity segment; rows ingested under
   earlier key schemes keep their original keys." (Matches `upload.ts:541` and the correct
   statement already at :117.)
2. **Broken GFM tables**: the multipart parts table header (:34) has 4 columns but the
   delimiter row (:35) has 3 — fix the delimiter (the whole table currently fails to render
   as a table in strict GFM). The `run_projection` table is declared 2-column (:56-57) but
   the `run_id` row (:58) has a third `**required**` cell that GFM drops — either add a
   `Required` column or fold "**required**" into the Type cell.
3. **Content-type gate on peek/confirm bodies**: document that the JSON body is parsed only
   when the Content-Type media type is `application/json` (parameters allowed,
   case-insensitive; `src/http/json.ts:29-32`); otherwise confirm behaves as if the body
   were empty → 400 `missing_peek_id`.
4. **Snapshot id trim-leniency**: note that the `:snapshot_id` path segment and the body
   `snapshot.id` are trimmed before regex validation / comparison (`bazaardb/upload.ts:60,47`),
   so whitespace-padded ids are accepted post-trim.

**Done when**: each item matches the cited code; tables render as tables. **Rollback**: revert.

---

### WP6 — Null-metadata hardening (approved behavior change; keep as its own commit, never squashed with WP1–WP5)

**Why**: doc promises 400 for missing/invalid required fields (:125) and "skip" for bad
battle projections (:78), but metadata JSON of literal `null` makes
`optionalTrimmedString(rawBody.player_account_id)` throw TypeError (`upload.ts:467` — only
`null` does; other primitives already 400), and a `null` element in `battle_projections`
throws at `upload.ts:502`. Neither is a `Response`, so `index.ts:91-99` rethrows → Workers
500. Mod impact: none (it retries any non-2xx without branching on code).

**Changes**:
1. In `decodeRunBundleParts` (after the JSON.parse at `upload.ts:361-372`): require
   `typeof rawBody === "object" && rawBody !== null`; on violation `logWarn` with
   `reason: "metadata_not_object"` (same event/fields shape as the sibling rejects) and
   `throw jsonError("invalid_run_bundle_request")`.
2. In the battle loop (`upload.ts:501-522`): first guard
   `typeof battle !== "object" || battle == null` → `skippedBattleProjections += 1; continue;`
   (unifies null elements with the documented skip path; primitive elements already skipped).
3. Tests (`test/runBundles.parse.test.ts`): (a) metadata part = literal `null` → 400
   `invalid_run_bundle_request`; (b) `battle_projections: [null, <valid battle>]` → 200 and
   exactly the valid battle row written.
4. Doc (same commit, keeps contract in lockstep): in the run-bundles section, note that
   non-object metadata JSON → 400 `invalid_run_bundle_request` and non-object battle
   projection elements are skipped.

**Done when**: both new tests pass; full suite green. **Rollback**: revert the commit
(restores the 500 behavior — acceptable, it was undocumented).

---

## Execution guardrails

- Only the files named in each WP. No edits to `.rules`/`CLAUDE.md` (if you find a pattern
  worth a rule, propose it under "Suggested .rules additions" in the PR description).
- After **each** WP: `npm run check && npm run test`, then **stop for human review** before
  the next WP.
- Never modify `migrations/`, `wrangler.toml`, SQL strings, log event names, or anything in
  the Frozen Surfaces list.
- Do not add coverage-theater tests; WP6's two tests are the only new tests in this plan.
- PR (if one PR for the batch): imperative title, no prefix/trailing punctuation, final
  `Release Notes:` section — `Fixed: run-bundle uploads with null metadata or null battle
  entries now return documented errors instead of a 500` covers WP6; everything else is
  internal (`N/A` if WP6 is excluded).
