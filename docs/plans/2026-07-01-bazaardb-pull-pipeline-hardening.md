# BazaarDB Pull Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut BazaarDB pull lag and eliminate the 404 / silent-data-loss failure modes by (A) coordinating a partner-side batch-size bump, (B) raising R2 snapshot retention and documenting the invariant, (C) making the `409 peek_outstanding` response recoverable, and (D) making `peek` skip + fail lifecycle-deleted objects instead of handing out dead presigned URLs.

**Architecture:** All four changes target the BazaarDB delivery queue (`bazaardb_delivery` D1 table + `bazaarplusplus-bazaardb-snapshots-v4` R2 bucket). A and B are ops/coordination + docs (no code). C and D are additive changes to the single handler `src/features/bazaardb/peek.ts` plus its tests and the wire-contract docs. **No schema migration is required** — both code changes reuse the existing partial index `idx_bazaardb_delivery_confirm (lease_peek_id, snapshot_id) WHERE delivery_state='pending' AND lease_peek_id IS NOT NULL`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), R2, Vitest (`@cloudflare/vitest-pool-workers`).

## Why these four (verified root cause)

The pull is **not** bottlenecked by SQL. The dropped `idx_bazaardb_delivery_pending_order` index (migration 0004) does cause a `TEMP B-TREE` sort on every peek, but measured at ~13ms even on a 200k-row backlog, and re-creating that index does not even change the query plan (the planner keeps the covering `idx_bazaardb_delivery_pending_attempts`). The real drivers of the partner's "~3 days of lag + 404s on old snapshots" are:

1. **Throughput is structurally serial.** `peek.ts` claim has `AND NOT EXISTS (SELECT 1 ... WHERE delivery_state='pending' AND lease_until_utc >= ?)` — at most **one** peek batch outstanding queue-wide; second peek gets 409. No server-side cron drain exists (`wrangler.toml` has no `[triggers]`; `src/index.ts` exports only `fetch`). Default batch is 10. If uploads outpace this serial drain, backlog grows for days. *(Structural fix = relax single-flight (option E) or server-side drain (option F) — out of scope here; A mitigates it cheaply.)*
2. **`409 peek_outstanding` is unrecoverable** (Fix C). It returns only `{status, peek_id, lease_expires_at_utc}` — not the leased ids/URLs — so a puller that lost its peek result waits out the full 600s lease, and each forced wait-and-re-peek burns one of `MaxDeliveryAttempts=3`, after which the snapshot is silently `failed`.
3. **3-day R2 lifecycle vs ~3-day lag** (Fix B + D). Objects age out while rows are still `pending`; `peek` presigns them with no existence check, so the partner gets 404s and burns attempts.

A and B stop the bleeding immediately with no deploy; C and D close the recoverability + dead-URL gaps in code.

## Global Constraints

- **No schema migration.** Do not add/drop indexes or columns. C and D reuse `idx_bazaardb_delivery_confirm` (`migrations/0001_v4_initial.sql:129-131`).
- **Do not change the `peek` default `max_items`.** It is deliberately 10 (cap 50). `test/bazaardb.delivery.test.ts:341` ("the no-max_items default stays 10") and the partner doc lock this. A sets `max_items` per request, client-side.
- **Wire-contract source of truth is `docs/api-reference.md`.** Any response-shape change must update it in the same task. Field changes in fixtures without a doc update are bugs (`CLAUDE.md`).
- **`failed` state CHECK** (`migrations/0001_v4_initial.sql:98-114`): a `failed` row must have `failed_at_utc IS NOT NULL`, `delivered_at_utc IS NULL`, and (lease CHECK at `:90-97`) `lease_peek_id IS NULL AND lease_until_utc IS NULL`. `failure_reason` is free `TEXT`.
- **`download_url` TTL = `LeaseSeconds` (600).** Presign every BazaarDB download URL with `presigner.sign(r2_key, LeaseSeconds)`.
- **R2 puts set only `httpMetadata.contentType`** — never write `customMetadata` (project rule).
- **Branch off `main` before committing** — do not commit to the default branch. Suggested branch: `bazaardb-pull-hardening`.
- **Verification per code task:** `npm run check` (tsc on prod + test tsconfigs) and `npm run test` (vitest). Single file: `npx vitest run test/bazaardb.delivery.test.ts`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/features/bazaardb/peek.ts` | Add `presignItems`/`sortByUploaded` helpers (C); recoverable 409 re-fetch (C); `splitByObjectPresence` + `failGoneRows` head-and-fail on the claim path (D) | C, D |
| `test/bazaardb.delivery.test.ts` | New recoverable-409 test + new object-gone tests; fix existing tests that seed rows without R2 objects | C, D |
| `docs/api-reference.md` | 409 shape now carries `items` (C); peek `object_gone` behavior + snapshot retention invariant (B, D) | B, C, D |
| `docs/bazaardb-snapshot-integration.md` | Partner-facing 409 recovery note (C); `object_gone` note (D) | C, D |
| `docs/architecture-decisions.md` | BazaarDB snapshot retention invariant (B); `object_gone` terminal reason (D) | B, D |

---

### Task 1 (A): Coordinate partner-side `max_items: 50`

**No code change.** The cap is already 50 (`src/features/bazaardb/delivery.ts:8`), the default is deliberately 10, and the partner doc already documents using 50 for backlog drain (`docs/bazaardb-snapshot-integration.md:180`). This task is the zero-deploy mitigation: the partner sets `max_items: 50` on every `peek` while a backlog exists, cutting round-trips ~5×. Under single-flight, fewer round-trips is the only lever the partner has without a server change.

**Files:**
- Reference only: `src/features/bazaardb/delivery.ts:7-8`, `docs/bazaardb-snapshot-integration.md:78,180`

- [ ] **Step 1: Confirm the cap and default in code**

Run: `grep -n "PeekDefaultItems\|PeekMaxItems" src/features/bazaardb/delivery.ts`
Expected: `PeekDefaultItems = 10`, `PeekMaxItems = 50`. Do **not** change these.

- [ ] **Step 2: Send the partner the concrete guidance**

Message teemaw (verbatim intent):
> While you're draining the backlog, send `{"max_items": 50}` on every `POST /bazaardb/peek` (the cap is 50; default is 10). That cuts peek→confirm round-trips ~5× per batch. It does not change correctness — confirm still accepts any subset of the batch.

- [ ] **Step 3: Verify the partner doc already states this (no edit unless missing)**

Run: `grep -n "max_items.*50\|drain the queue faster" docs/bazaardb-snapshot-integration.md`
Expected: line ~180 already says to request `"max_items": 50` for backlogs. If present, no doc edit. If absent, add one sentence to the "Working through a backlog" section. No commit needed if no file changed.

---

### Task 2 (B): Raise snapshot R2 retention + document the invariant

Removes the **cause** of the 404s/data-loss: the `bazaarplusplus-bazaardb-snapshots-v4` bucket lifecycle is 3 days while pull lag is ~3 days, so objects age out under still-`pending` rows. R2 lifecycle lives in the CF dashboard (not in this repo — `CLAUDE.md`), so the bucket change is manual; this task makes the floor explicit in the docs so it is not silently re-lowered.

**Files:**
- Manual (CF dashboard): R2 bucket `bazaarplusplus-bazaardb-snapshots-v4` lifecycle rule
- Modify: `docs/architecture-decisions.md:45-50` (Data Retention)
- Modify: `docs/api-reference.md` (Data retention section, near `:587`)

**Interfaces:**
- Produces: a documented retention floor that Fix D's `object_gone` path references as "accepted loss only when retention is breached."

- [ ] **Step 1: Raise the bucket lifecycle (manual, user action)**

In the Cloudflare dashboard → R2 → bucket `bazaarplusplus-bazaardb-snapshots-v4` → lifecycle rule: raise object expiry from **3 days to ≥ 7 days** (matches the run-bundle bucket's ~7d at `docs/api-reference.md:395`, and must exceed worst-case pull lag). This is the single most impactful change for the reported 404s.

- [ ] **Step 2: Document the invariant in the ADR**

In `docs/architecture-decisions.md`, under `## Data Retention`, add a bullet after the BazaarDB `done`/`failed` line (`:50`):

```markdown
- **Invariant: BazaarDB snapshot retention must exceed the partner's worst-case pull lag (target >= 7 days).** The snapshot bucket lifecycle is set in the CF dashboard. Below this floor, objects age out while their `bazaardb_delivery` row is still `pending`; `peek` then marks such rows `failed` with `failure_reason='object_gone'` (accepted loss) — there is no other signal.
```

- [ ] **Step 3: Document the floor in the wire-contract doc**

In `docs/api-reference.md`, in the `## Data retention` section (the `bazaardb_delivery` bullet near `:587`), add:

```markdown
- BazaarDB snapshot R2 objects are governed by an R2 lifecycle rule (CF dashboard). **Invariant: the snapshot retention horizon must exceed the partner's worst-case pull lag (target >= 7 days).** If retention drops below the lag, `peek` fails the aged-out rows as `object_gone` rather than presigning dead URLs.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture-decisions.md docs/api-reference.md
git commit -m "Document BazaarDB snapshot retention floor invariant"
```

---

### Task 3 (C): Make `409 peek_outstanding` recoverable

When a peek batch is outstanding and the partner re-peeks (e.g. after a crash that lost the original `download_url`s), return the leased batch's snapshot ids **and freshly re-presigned URLs** in the 409 body, so the partner recovers on its next request instead of waiting out the 600s lease. This is a read-only re-fetch: it does **not** increment `delivery_attempts` and does **not** mutate the lease.

**Files:**
- Modify: `src/features/bazaardb/peek.ts` (imports; new helpers `sortByUploaded`/`presignItems`; claim-path presign refactor `:142-152`; 409 branch `:127-140`)
- Test: `test/bazaardb.delivery.test.ts` (new recoverable-409 test; update existing 409 assertion `:284-288`)
- Modify: `docs/api-reference.md:521-531` (Response 409 outstanding lease)
- Modify: `docs/bazaardb-snapshot-integration.md:104-114` (partner-facing 409)

**Interfaces:**
- Produces (used by Task 4): `presignItems(presigner: R2Presigner, rows: ClaimedDeliveryRow[]): Promise<Array<{ snapshot_id: string; download_url: string }>>` — sorts by `(uploaded_at_utc, snapshot_id)` and presigns each `r2_key` with `LeaseSeconds`.
- Consumes: existing `findOutstandingLease`, `ClaimedDeliveryRow` (`{ snapshot_id, r2_key, uploaded_at_utc }`), `LeaseSeconds`.

- [ ] **Step 1: Write the failing test**

Add to `test/bazaardb.delivery.test.ts`:

```ts
test("409 peek_outstanding re-presigns the leased batch and does not burn an attempt", async () => {
  await seedDelivery("snap-out-a", "2026-06-03T00:00:01.000Z");
  await seedDelivery("snap-out-b", "2026-06-03T00:00:02.000Z");

  const first = await peek();
  const firstBody = (await first.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(firstBody.items.map((i) => i.snapshot_id)).toEqual(["snap-out-a", "snap-out-b"]);

  // Partner "lost" firstBody and re-peeks while the lease is still held.
  const recovery = await peek();
  expect(recovery.status).toBe(409);
  const recoveryBody = (await recovery.json()) as {
    status: string;
    peek_id: string;
    lease_expires_at_utc: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(recoveryBody.status).toBe("peek_outstanding");
  expect(recoveryBody.peek_id).toBe(firstBody.peek_id);
  expect(recoveryBody.items.map((i) => i.snapshot_id)).toEqual(["snap-out-a", "snap-out-b"]);
  expect(recoveryBody.items.every((i) => typeof i.download_url === "string" && i.download_url.length > 0)).toBe(true);

  // Re-fetch must NOT consume a delivery attempt (still 1 from the first peek).
  const attempts = await env.DB.prepare(
    "SELECT delivery_attempts FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{ delivery_attempts: number }>();
  expect(attempts.results.map((r) => r.delivery_attempts)).toEqual([1, 1]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/bazaardb.delivery.test.ts -t "re-presigns the leased batch"`
Expected: FAIL — the 409 body has no `items` (currently only `{status, peek_id, lease_expires_at_utc}`).

- [ ] **Step 3: Add the presign helpers and import the presigner type**

In `src/features/bazaardb/peek.ts`, change the presign import (line 1) to also import the type:

```ts
import { createR2Presigner, type R2Presigner } from "../../crypto/presign";
```

Add these helpers above `handlePeekBazaarDbSnapshots` (after `findOutstandingLease`):

```ts
function sortByUploaded(rows: ClaimedDeliveryRow[]): ClaimedDeliveryRow[] {
  return [...rows].sort((a, b) => {
    const uploaded = a.uploaded_at_utc.localeCompare(b.uploaded_at_utc);
    return uploaded === 0 ? a.snapshot_id.localeCompare(b.snapshot_id) : uploaded;
  });
}

async function presignItems(
  presigner: R2Presigner,
  rows: ClaimedDeliveryRow[],
): Promise<Array<{ snapshot_id: string; download_url: string }>> {
  return Promise.all(
    sortByUploaded(rows).map(async (row) => {
      const signed = await presigner.sign(row.r2_key, LeaseSeconds);
      return { snapshot_id: row.snapshot_id, download_url: signed.url };
    }),
  );
}
```

- [ ] **Step 4: Refactor the success path to use the helper**

In `handlePeekBazaarDbSnapshots`, replace the existing claim-success block (currently `:142-152`, the inline `claimedRows` sort + `items` `Promise.all`) with:

```ts
  const items = await presignItems(presigner, claim.results);
```

(The `logInfo` and final `return json({ peek_id: peekId, lease_expires_at_utc: leaseExpiresAtUtc, items })` below it stay unchanged.)

- [ ] **Step 5: Return items in the 409 branch**

Replace the empty-claim branch (currently `:127-140`) with:

```ts
  if (claim.results.length === 0) {
    const outstanding = await findOutstandingLease(env, nowUtc);
    if (outstanding) {
      const leased = await env.DB.prepare(
        `
          SELECT snapshot_id, r2_key, uploaded_at_utc
          FROM bazaardb_delivery
          WHERE lease_peek_id = ?
            AND delivery_state = 'pending'
        `,
      )
        .bind(outstanding.lease_peek_id)
        .all<ClaimedDeliveryRow>();

      return json(
        {
          status: "peek_outstanding",
          peek_id: outstanding.lease_peek_id,
          lease_expires_at_utc: outstanding.lease_until_utc,
          items: await presignItems(presigner, leased.results),
        },
        { status: 409 },
      );
    }
    return json({ peek_id: null, items: [] });
  }
```

- [ ] **Step 6: Update the existing 409 assertion**

In `test/bazaardb.delivery.test.ts`, the test "peek is bearer-gated and returns 409 while a previous lease is outstanding" (`:284-288`) currently asserts exact equality. Change the second-peek assertion from `toEqual({...})` to:

```ts
  expect(second.status).toBe(409);
  const secondBody = (await second.json()) as {
    status: string;
    peek_id: string;
    lease_expires_at_utc: string;
    items: Array<{ snapshot_id: string; download_url: string }>;
  };
  expect(secondBody.status).toBe("peek_outstanding");
  expect(secondBody.peek_id).toBe(firstBody.peek_id);
  expect(secondBody.lease_expires_at_utc).toBe(firstBody.lease_expires_at_utc);
  expect(secondBody.items.map((i) => i.snapshot_id)).toEqual(["snap-locked"]);
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run test/bazaardb.delivery.test.ts && npm run check`
Expected: PASS (all bazaardb tests green; tsc clean).

- [ ] **Step 8: Update the wire-contract docs**

In `docs/api-reference.md`, replace the "Response 409 outstanding lease" JSON block (`:521-531`) to include `items` and add a sentence:

```markdown
### Response 409 outstanding lease

```json
{
  "status": "peek_outstanding",
  "peek_id": "pk_...",
  "lease_expires_at_utc": "2026-06-03T12:40:00.000Z",
  "items": [
    { "snapshot_id": "string", "download_url": "https://<account>.r2.cloudflarestorage.com/..." }
  ]
}
```

The 409 now re-presigns and returns the still-unconfirmed items held by the outstanding lease, so a client that lost its original `download_url`s can recover the batch without waiting for the lease to expire. `download_url` is a fresh 10-minute SigV4 URL. The re-fetch does not consume a delivery attempt and does not extend the lease.
```

In `docs/bazaardb-snapshot-integration.md`, update the 409 section (`:104-114`): in the JSON add the `items` array (same `{snapshot_id, download_url}` shape as the 200 response at `:88-89`), and change the resolution sentence at `:114` to note that the 409 now returns the outstanding batch's items so a job that lost its peek response can re-download and confirm immediately instead of waiting for lease expiry.

- [ ] **Step 9: Commit**

```bash
git add src/features/bazaardb/peek.ts test/bazaardb.delivery.test.ts docs/api-reference.md docs/bazaardb-snapshot-integration.md
git commit -m "Return the outstanding batch items in peek 409 so pullers recover without waiting for lease expiry"
```

---

### Task 4 (D): Skip and fail lifecycle-deleted objects in `peek`

Before presigning, `head()` each claimed object. Rows whose R2 object is already gone (lifecycle-deleted) are marked `failed` with `failure_reason='object_gone'` and dropped from the response, instead of being handed out as 404-bound presigned URLs that silently burn attempts. Mirrors the existing `head()`-then-410 pattern in `src/features/ghostBattles/replayLink.ts:37-46` (the only other R2-signing path).

**Files:**
- Modify: `src/features/bazaardb/peek.ts` (new helpers `splitByObjectPresence`/`failGoneRows`; claim path between claim and presign)
- Test: `test/bazaardb.delivery.test.ts` (new object-gone tests; fix existing tests that seed rows without objects)
- Modify: `docs/api-reference.md` (peek section + delivery-attempt note)
- Modify: `docs/architecture-decisions.md:52-56` (BazaarDB Delivery Semantics)

**Interfaces:**
- Consumes (from Task 3): `presignItems`, `ClaimedDeliveryRow`.
- Produces: `splitByObjectPresence(env, rows): Promise<{ live: ClaimedDeliveryRow[]; gone: ClaimedDeliveryRow[] }>`; `failGoneRows(env, peekId, gone, nowUtc): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/bazaardb.delivery.test.ts`:

```ts
test("peek fails snapshots whose R2 object is gone and excludes them from items", async () => {
  await seedDelivery("snap-gone", "2026-06-03T00:00:01.000Z", { putObject: false });
  await seedDelivery("snap-live", "2026-06-03T00:00:02.000Z");

  const response = await peek();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    peek_id: string;
    items: Array<{ snapshot_id: string }>;
  };
  expect(body.items.map((i) => i.snapshot_id)).toEqual(["snap-live"]);

  const rows = await env.DB.prepare(
    "SELECT snapshot_id, delivery_state, failure_reason, lease_peek_id FROM bazaardb_delivery ORDER BY snapshot_id",
  ).all<{ snapshot_id: string; delivery_state: string; failure_reason: string | null; lease_peek_id: string | null }>();
  expect(rows.results).toEqual([
    { snapshot_id: "snap-gone", delivery_state: "failed", failure_reason: "object_gone", lease_peek_id: null },
    { snapshot_id: "snap-live", delivery_state: "pending", failure_reason: null, lease_peek_id: body.peek_id },
  ]);
});

test("peek returns an empty batch (peek_id null) when every claimed object is gone", async () => {
  await seedDelivery("snap-allgone-a", "2026-06-03T00:00:01.000Z", { putObject: false });
  await seedDelivery("snap-allgone-b", "2026-06-03T00:00:02.000Z", { putObject: false });

  const response = await peek();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ peek_id: null, items: [] });

  const failed = await selectFirst<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM bazaardb_delivery WHERE delivery_state = 'failed' AND failure_reason = 'object_gone'",
  );
  expect(failed?.n).toBe(2);

  // Lease slot is freed, so a fresh peek is not 409-locked.
  const next = await peek();
  expect(next.status).toBe(200);
  expect(await next.json()).toEqual({ peek_id: null, items: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bazaardb.delivery.test.ts -t "object is gone"`
Expected: FAIL — `snap-gone` is currently returned in `items` (no head check) and stays `pending`.

- [ ] **Step 3: Add the head-and-fail helpers**

In `src/features/bazaardb/peek.ts`, add above `handlePeekBazaarDbSnapshots`:

```ts
async function splitByObjectPresence(
  env: Env,
  rows: ClaimedDeliveryRow[],
): Promise<{ live: ClaimedDeliveryRow[]; gone: ClaimedDeliveryRow[] }> {
  const heads = await Promise.all(rows.map((row) => env.BAZAARDB_BUCKET.head(row.r2_key)));
  const live: ClaimedDeliveryRow[] = [];
  const gone: ClaimedDeliveryRow[] = [];
  rows.forEach((row, index) => (heads[index] == null ? gone : live).push(row));
  return { live, gone };
}

async function failGoneRows(
  env: Env,
  peekId: string,
  gone: ClaimedDeliveryRow[],
  nowUtc: string,
): Promise<void> {
  if (gone.length === 0) return;
  const placeholders = gone.map(() => "?").join(", ");
  await env.DB.prepare(
    `
      UPDATE bazaardb_delivery
      SET delivery_state = 'failed',
          failed_at_utc = ?,
          failure_reason = 'object_gone',
          state_updated_at_utc = ?,
          lease_peek_id = NULL,
          lease_until_utc = NULL
      WHERE lease_peek_id = ?
        AND delivery_state = 'pending'
        AND snapshot_id IN (${placeholders})
    `,
  )
    .bind(nowUtc, nowUtc, peekId, ...gone.map((row) => row.snapshot_id))
    .run();
  logWarn("bazaardb.peek", {
    peek_id: peekId,
    gone_count: gone.length,
    outcome: "object_gone_failed",
  });
}
```

- [ ] **Step 4: Wire head-and-fail into the claim path**

In `handlePeekBazaarDbSnapshots`, between the `claim` UPDATE and the `presignItems` call (the success path from Task 3 Step 4), insert:

```ts
  const { live, gone } = await splitByObjectPresence(env, claim.results);
  await failGoneRows(env, peekId, gone, nowUtc);

  if (live.length === 0) {
    logInfo("bazaardb.peek", {
      peek_id: peekId,
      item_count: 0,
      gone_count: gone.length,
      phase_ms: { total: Date.now() - phaseStart },
      outcome: "all_gone",
    });
    return json({ peek_id: null, items: [] });
  }

  const items = await presignItems(presigner, live);
```

Then update the trailing `logInfo` to include `gone_count: gone.length` and remove the now-duplicated `const items = await presignItems(...)` line introduced in Task 3 Step 4 (it is replaced by the one above operating on `live`). The final `return json({ peek_id: peekId, lease_expires_at_utc: leaseExpiresAtUtc, items })` stays.

- [ ] **Step 5: Fix existing tests that seed rows without R2 objects**

Fix D requires claimed rows to have objects. Two existing tests seed with `putObject: false` and will now fail because those rows get marked `object_gone`:

In "POST /bazaardb/peek claims oldest pending rows and returns presigned URLs" (`:191-219`), change `:193` from:
```ts
  await seedDelivery("snap-a", "2026-06-03T00:00:01.000Z", { putObject: false });
```
to:
```ts
  await seedDelivery("snap-a", "2026-06-03T00:00:01.000Z");
```

In "explicit max_items claims and confirms batches above 10 ..." (`:341-377`), remove `{ putObject: false }` from both `seedDelivery` loops (`:344` and `:366`) so each seeded `snap-bulk-*` row has an R2 object:
```ts
    await seedDelivery(`snap-bulk-${seconds}`, `2026-06-03T00:00:${seconds}.000Z`);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/bazaardb.delivery.test.ts && npm run check`
Expected: PASS (new object-gone tests green; updated existing tests green; tsc clean).

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: PASS (no regression in `schema.test.ts`, `ghostBattles.*`, etc.).

- [ ] **Step 8: Update the docs**

In `docs/api-reference.md`, in the `## POST /bazaardb/peek` section, add after the "Response 200 with items" block:

```markdown
Snapshots whose R2 object has already been removed by the bucket lifecycle rule are not presigned: `peek` marks each such row `failed` with `failure_reason='object_gone'` and omits it from `items`. If an entire claimed batch is gone, the response is the empty `{ "peek_id": null, "items": [] }`. This prevents handing out 404-bound URLs and the silent attempt-burn that previously followed (see the snapshot retention invariant under Data retention).
```

In `docs/architecture-decisions.md`, under `## BazaarDB Delivery Semantics` (`:52-56`), add:

```markdown
`peek` `head()`s each claimed object before presigning. A row whose R2 object is already lifecycle-deleted is marked `failed` with `failure_reason='object_gone'` (distinct from `max_delivery_attempts`) and excluded from the batch, rather than served as a dead presigned URL.
```

In `docs/bazaardb-snapshot-integration.md`, in the delivery-attempts section (`:116-125`), add one sentence noting that a snapshot whose stored object has aged out of the lifecycle window is reported as failed (`object_gone`) and never appears in a peek batch.

- [ ] **Step 9: Commit**

```bash
git add src/features/bazaardb/peek.ts test/bazaardb.delivery.test.ts docs/api-reference.md docs/architecture-decisions.md docs/bazaardb-snapshot-integration.md
git commit -m "Skip and fail lifecycle-deleted snapshots in peek instead of presigning dead URLs"
```

---

## Recommended sequencing

1. **B Step 1 (raise R2 lifecycle) + A (partner `max_items: 50`) first** — zero deploy, immediately stops new 404s and claws back lag.
2. **C, then D** — code order matters: C introduces `presignItems`/`sortByUploaded` and refactors the success path; D adds head-and-fail on top and reuses `presignItems`.
3. Ship C + D together in one PR (one branch, two commits).

## Out of scope (separate decisions, not in this plan)

- **E — relax the single-flight gate** (remove `NOT EXISTS`, allow concurrent disjoint leases). The real throughput ceiling, but a **breaking** wire change ("at most one outstanding peek" goes away) that needs partner coordination and validation of D1 concurrent-write atomicity under load.
- **F — server-side cron drain** (`scheduled()` handler that pushes to a BazaarDB ingest endpoint). Removes the pull bottleneck structurally; needs a partner ingest API + auth + new secrets. The "add the ingest worker" idea — hold as the escalation if A–D still miss SLA.
- **Restoring/replacing the dropped `pending_order` index.** Real but ~13ms; a covering index would be needed (the literal revert does not change the plan). Low priority, separate migration.

## Self-review

- **Spec coverage:** A → Task 1; B → Task 2; C → Task 3; D → Task 4. All four covered.
- **No schema migration** in any task — confirmed against the reused `idx_bazaardb_delivery_confirm`.
- **Type consistency:** `presignItems(presigner, rows)` defined in Task 3, reused in Task 4; `ClaimedDeliveryRow` (`{snapshot_id, r2_key, uploaded_at_utc}`) used consistently; `failure_reason='object_gone'` spelled identically in code, tests, and docs.
- **Test interactions handled:** Fix D breaks two existing `putObject: false` tests — Task 4 Step 5 fixes both. Fix C changes the existing 409 assertion — Task 3 Step 6 updates it.
