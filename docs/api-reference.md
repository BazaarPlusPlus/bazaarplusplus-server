# V4 API Reference

**Host:** `mod-api-v4.bazaarplusplus.com`
**Auth model:** No token auth for mod-facing endpoints. `POST /bazaardb/peek`, `POST /bazaardb/confirm`, and `POST /run-bundles/:run_id/download-link` require a bearer token (`BAZAARDB_PULL_TOKEN`). All `player_account_id` fields are required; the server does not synthesize sentinel fallbacks.
**Error shape:** `{ "error": "<code>" }` unless noted otherwise.
**CORS:** All endpoints accept preflight (`OPTIONS`).

---

## GET /health

**Auth:** None.

**Response 200:**
```json
{
  "status": "ok",
  "server_time_utc": "2026-06-03T00:00:00.000Z"
}
```

No error variants.

`/health` is a **liveness probe only**: it does not touch D1, R2, or secrets. A green `/health` does not imply `replay-link` or `peek` can presign URLs (e.g. when R2 secrets are missing those endpoints return 500 `internal_error` while `/health` stays 200).

---

## POST /run-bundles

Upload a run artifact plus its D1 projections. R2 put happens before D1 batch; D1 failure triggers best-effort R2 cleanup unless a raced committed run already references the same object.

**Auth:** None. `player_account_id` required in the `metadata` part.

### Request body (multipart/form-data)

| Part | Content-Type | Required | Body |
|---|---|---|---|
| `metadata` | `application/json` or omitted by platform string part | yes | UTF-8 JSON with fields below |
| `artifact` | `application/x-bpp-runbundle+msgpack+gzip` | yes | Raw gzip MessagePack artifact bytes; filename `run-bundle.mpack.gz` |

The endpoint rejects legacy `application/json` run-bundle bodies with `415 { "error": "unsupported_content_type" }`.

Only the `artifact` part's Content-Type is validated; the `metadata` part is accepted as any string part (its Content-Type is not inspected), and the `artifact` filename is informational (client-supplied, server-ignored).

**`metadata` JSON fields**

| Field | Type | Required |
|---|---|---|
| `schema_version` | number (finite; integer not enforced; defaults to current server schema when invalid/missing — current mod sends `5`) | no |
| `player_account_id` | string (non-empty) | yes |
| `submitted_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`; invalid/missing or more than 10 minutes in the future falls back to server receive time) | no |
| `artifact_codec` | string; defaults to the multipart artifact Content-Type when invalid/missing | no |
| `run_projection` | object (see below) | no (defaults to `{}`) |
| `battle_projections` | array of battle objects (see below; max 200 items) | no (defaults to `[]`) |

The metadata JSON must decode to an object; any other top-level JSON value (e.g. literal `null`) is rejected with 400 `invalid_run_bundle_request`.

**`run_projection` fields** (all optional unless noted):

| Field | Type |
|---|---|
| `run_id` | string (non-empty; **required**) |
| `status` | string; defaults to `completed` when invalid/missing |
| `ended_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`; invalid/missing or more than 10 minutes in the future falls back to server receive time) |
| `hero_id` | string |
| `hero_name` | string |
| `player_rank` | string |
| `player_rating` | number |
| `player_position` | number |
| `started_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`; invalid or more than 10 minutes in the future is stored as null) |
| `final_day` | number |
| `final_wins` | number |
| `final_losses` | number |
| `final_player_rank` | string |
| `final_player_rating` | number |
| `final_player_position` | number |

**`battle_projections[]` fields** (per item):

| Field | Type | Notes |
|---|---|---|
| `battle_id` | string | missing/blank battle projections are skipped; the rest of the bundle is still accepted |
| `run_id` | string | client-supplied value ignored; server always writes `run_projection.run_id` |
| `recorded_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`) | invalid/missing/far-future values fall back to `submitted_at_utc` or server receive time; the fallback itself is upper-bound clamped, so a far-future `submitted_at_utc` cannot leak into `recorded_at_utc` |
| `day` | number | |
| `player_name` | string | |
| `player_account_id` | string | client-supplied value ignored; server always writes the metadata-level `player_account_id` |
| `player_hero` | string | |
| `player_rank` | string | |
| `player_rating` | number | |
| `player_level` | number | |
| `player_prestige` | number | |
| `player_victories` | number | |
| `opponent_name` | string | |
| `opponent_account_id` | string | nullable; the battle row is written only when this equals the metadata-level uploader, or when this account already exists in `seen_player_accounts`; NULL opponents are dropped |
| `opponent_hero` | string | |
| `opponent_rank` | string | |
| `opponent_rating` | number | |
| `opponent_level` | number | |
| `opponent_prestige` | number | |
| `opponent_victories` | number | |
| `result` | string | |
| `winner_combatant_id` | string | |
| `loser_combatant_id` | string | |
| `is_final_battle` | boolean | optional; stored as a sticky marker: once true for a `battle_id`, later uploads cannot reset it to false |

Non-object `battle_projections[]` elements (e.g. literal `null`) are skipped the same way as projections without a `battle_id`; the rest of the bundle is still accepted.

For a `battle_id` collision, non-final battle fields use last-writer-wins upsert semantics; `is_final_battle` is the exception and remains sticky once true.

Battle projection ingest is opponent-filtered. `seen_player_accounts` is the set of account ids that have successfully uploaded at least one run; it is seeded from historical `runs.player_account_id` values and then updated from the metadata-level uploader on each new run upload. A battle against a not-yet-seen opponent is accepted at the request level but writes no `battles` row, and the server does not backfill those dropped rows if that opponent uploads later.

### Response 200 (accepted)

```json
{
  "status": "accepted",
  "run_id": "<string>",
  "object_key": "<string>"
}
```

`object_key` format for new uploads: `run-bundles/<uuid>.mpack.gz`. The object key intentionally omits `player_account_id`, `run_id`, and artifact hash, so replay presigned URL paths do not expose uploader identity or create shared keys across unrelated runs.

`run_id` is immutable. Re-uploading the same `run_id` with the same artifact hash returns the existing `object_key` and does not refresh `runs` or `battles` projections. Re-uploading the same `run_id` with a different artifact hash returns 409 `run_bundle_conflict`.

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `invalid_run_bundle_request` | Malformed multipart body, missing/invalid multipart part, non-object metadata JSON, missing/invalid required field (`player_account_id` or `run_id`), or invalid artifact part Content-Type |
| 400 | `too_many_battle_projections` | More than 200 battle projections were supplied |
| 413 | `payload_too_large` | Declared request body exceeds 8 MiB, or artifact part is empty or larger than 8 MiB |
| 415 | `unsupported_content_type` | Request is not `multipart/form-data` |
| 409 | `run_bundle_conflict` | The `run_id` already exists with a different artifact hash |
| 500 | `internal_error` | R2 put failure or D1 batch failure after best-effort cleanup |

The declared-size 413 applies only when the request carries a `Content-Length` header; without one, the size cap is enforced after the body is buffered (the empty/oversized artifact-part check is the hard limit, with Cloudflare platform body limits above that).

### V3 → V4/V5 deltas

- `player_account_id` is required and non-empty. Mod must skip upload if account id is unavailable.
- `run_bundles` table merged into `runs`; `battles.replay_available` wire field removed (was a dead field — always `true` in V3). `battles.player_account_id_in_payload` removed.
- Bundle-final battle metadata is carried as `is_final_battle`; the old V3 `is_bundle_final_battle` name is not consumed or returned.
- `seen_player_accounts` opponent filtering is active again. It keeps self-battles, keeps battles whose opponent has uploaded at least one run, and drops NULL or never-seen opponents at ingest.
- New V4/V5 upload object keys are opaque `run-bundles/<uuid>.mpack.gz` and contain no identity segment; rows ingested under earlier key schemes keep their original keys.
- JSON `artifact_bytes` upload bodies removed in V5; artifact bytes are transmitted only as the multipart `artifact` part.

---

## GET /ghost-battles

Query battles where the given player was the opponent. Returns battles recorded within the last 5 days.

**Auth:** None.

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `player_account_id` | string | yes | missing/blank → 400 |
| `limit` | integer | no | default 200; clamped to 1–200 |

### Response 200

```json
{
  "battles": [
    {
      "battle_id": "string",
      "recorded_at_utc": "string",
      "day": "number | null",
      "player_name": "string | null",
      "player_account_id": "string | null",
      "player_hero": "string | null",
      "player_rank": "string | null",
      "player_rating": "number | null",
      "player_level": "number | null",
      "player_prestige": "number | null",
      "player_victories": "number | null",
      "opponent_name": "string | null",
      "opponent_account_id": "string | null",
      "opponent_hero": "string | null",
      "opponent_rank": "string | null",
      "opponent_rating": "number | null",
      "opponent_level": "number | null",
      "opponent_prestige": "number | null",
      "opponent_victories": "number | null",
      "result": "string | null",
      "winner_combatant_id": "string | null",
      "loser_combatant_id": "string | null",
      "is_final_battle": "boolean"
    }
  ]
}
```

Rows ordered by `recorded_at_utc DESC, battle_id DESC`.

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `invalid_request` | `player_account_id` missing or blank |
| 500 | `internal_error` | Unexpected failure (e.g. D1 unavailable) |

### V3 → V4 deltas

- Bundle-final battle metadata is returned as `battles[].is_final_battle`; the old V3 `is_bundle_final_battle` name is not returned.
- `battles[].replay_available` removed (was dead field; mod side should hardcode `ReplayAvailable = true` locally).
- `battles[].player_account_id_in_payload` removed.
- Lookback window hardcoded to 5 days (was `GHOST_QUERY_LOOKBACK_DAYS` env var in V3).

---

## POST /ghost-battles/:battle_id/replay-link

Generate a 5-minute R2 presigned download URL for the run bundle artifact containing the given battle.

**Auth:** None.

### Path parameter

| Param | Type | Notes |
|---|---|---|
| `:battle_id` | string | URL-encoded; malformed percent-encoding → 400 |

No request body.

### Response 200

```json
{
  "download_url": "string",
  "expires_at_utc": "string"
}
```

`download_url` is a 5-minute SigV4 presigned R2 URL. The mod GETs this URL directly; no Worker proxy. After the signed URL expires, R2 may return 403; clients should request a fresh replay-link instead of scheduling downloads against the exact `expires_at_utc` boundary.

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `bad_request` | Malformed percent-encoding in `:battle_id` path segment |
| 404 | `battle_not_found` | No battle (joined to its run) with that `battle_id` in D1 — either the battle row is missing or its `run_id` has no matching `runs` row |
| 410 | `artifact_expired` | Battle row exists but `RUN_BUNDLE_BUCKET.head(object_key)` returned null (object deleted by R2 lifecycle) |
| 500 | `internal_error` | Unexpected failure (e.g. R2 presign secrets missing, D1 unavailable) |

### V3 → V4 deltas

- 404 `battle_not_found` and 410 `artifact_expired` are now distinct error codes (V3 had a single combined error).
- `download_url` content changed from a Worker-proxied URL to a direct R2 presigned URL — wire field name unchanged; mod does not need to change its GET logic.
- `expires_at_utc` field name unchanged.
- `GET /replays/:token` endpoint removed; token-based replay download no longer exists.
- `replay_available` is no longer consulted; artifact presence is determined by `R2.head()` at request time.

---

## POST /run-bundles/:run_id/download-link

Generate a 5-minute R2 presigned download URL for a run bundle artifact by `run_id`. This is the run-keyed counterpart to `replay-link`: the run bundle is the whole-run artifact, so this route and any of that run's `replay-link` calls resolve to the same `runs.object_key` and sign the same object.

**Purely additive.** This route was a new addition only — a new handler plus one route registration. No existing endpoint, schema, object key, or stored byte changed; `runs`/`battles`/`bazaardb_delivery` are untouched, and run bundles are uploaded and stored exactly as before. A consumer that ignores this route sees no behavior change.

**Auth:** `Authorization: Bearer <BAZAARDB_PULL_TOKEN>` required (same token as the BazaarDB pull endpoints). Missing or wrong token → 401 (no body). Unlike `replay-link`, this route is not mod-facing: the intended consumer is the BazaarDB partner pull, which reads `run.id` from a pulled snapshot and exchanges it for the bundle.

### Path parameter

| Param | Type | Notes |
|---|---|---|
| `:run_id` | string | URL-encoded; malformed percent-encoding → 400 |

No request body.

### Response 200

```json
{
  "run_id": "string",
  "download_url": "string",
  "expires_at_utc": "string",
  "codec": "application/x-bpp-runbundle+msgpack+gzip",
  "schema_version": 5,
  "size_bytes": 123456
}
```

`download_url` is a 5-minute SigV4 presigned R2 URL; GET it directly, no Worker proxy. After it expires R2 may return 403, so request a fresh link rather than scheduling against the exact `expires_at_utc` boundary. `codec`, `schema_version`, and `size_bytes` are echoed from the `runs` row so the consumer can frame/decode the artifact without a separate metadata call (the downloaded artifact body does not carry `schema_version`).

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `bad_request` | Malformed percent-encoding in `:run_id` path segment |
| 401 | (no body) | Missing or wrong bearer token |
| 404 | `run_not_found` | No `runs` row with that `run_id` |
| 410 | `artifact_expired` | Run row exists but `RUN_BUNDLE_BUCKET.head(object_key)` returned null (object deleted by R2 lifecycle) |
| 500 | `internal_error` | Unexpected failure (e.g. R2 presign secrets missing, D1 unavailable) |

### Downloaded artifact

GET the `download_url`; the bytes are the run bundle, **not JSON**. Framing:

- Content type `application/x-bpp-runbundle+msgpack+gzip`; `codec` in the response echoes this.
- The bytes are a gzip stream (first two bytes `0x1F 0x8B`). Gunzip, then decode the result as **MessagePack** (not JSON).
- The MessagePack map is keyed by **C# property names** (`RunId`, `Battles`, `Snapshots`, `ReplayPayload`, …) — PascalCase, *not* the snake_case used by the upload metadata. Do not decode it as snake_case.
- `schema_version` is upload metadata (echoed in this response); it is **not** present inside the artifact body.

Top-level decoded shape:

```ts
interface RunArtifact {
  RunId: string;
  Battles: RunArtifactBattle[];
}

interface RunArtifactBattle {
  BattleId: string;
  Manifest: {
    BattleId: string | null;
    RecordedAtUtc: string;
    Day: number | null; Hour: number | null;
    EncounterId: string | null; CombatKind: string | null;
    Result: string | null;
    WinnerCombatantId: string | null; LoserCombatantId: string | null;
  };
  Participants: {
    // Player* and Opponent* pairs:
    PlayerName: string | null; PlayerAccountId: string | null; PlayerHero: string | null;
    PlayerRank: string | null; PlayerRating: number | null; PlayerLevel: number | null;
    PlayerPrestige: number | null; PlayerVictories: number | null;
    OpponentName: string | null; OpponentAccountId: string | null; OpponentHero: string | null;
    OpponentRank: string | null; OpponentRating: number | null; OpponentLevel: number | null;
    OpponentPrestige: number | null; OpponentVictories: number | null;
  };
  Snapshots: {
    // Exactly four CardSets per battle, in order:
    // player_hand, player_skills, opponent_hand, opponent_skills.
    CardSets: Array<{
      Label: string;            // e.g. "player_hand"
      Status: string | null;    // Missing | CapturedEmpty | Captured
      Source: string | null;    // Unknown | OpeningMessage | LiveRetry
      Items: Array<{
        InstanceId: string; TemplateId: string;
        Type: number;             // ECardType (0=Item, 1=Skill, …)
        Size: number;             // ECardSize (1=Small, 2=Medium, 3=Large)
        Section: number | null;   // EInventorySection (0=Hand, 1=Stash)
        Socket: number | null;    // EContainerSocketId (0..9)
        Name: string | null; Tier: string | null; Enchant: string | null;
        Tags: string[];
        Attributes: Record<string, number>;
      }>;
    }>;
  };
  ReplayPayload: {
    BattleId: string;
    Version: number;
    // Raw game net messages, MessagePack/LZ4 — NOT JSON. Consumers that only
    // need card snapshots + metadata can ignore these three byte arrays.
    SpawnMessageBytes: Uint8Array;
    CombatMessageBytes: Uint8Array;
    DespawnMessageBytes: Uint8Array;
  };
}
```

The exhaustive per-field reference and full numeric-enum tables live in the mod-side contract: `bazaarplusplus-mod/docs/drafts/2026-06-24-run-bundle-artifact-download-contract.md`.

#### Decode examples

Node.js:

```ts
import { gunzipSync } from "node:zlib";
import { decode } from "@msgpack/msgpack";

const compressed = new Uint8Array(await (await fetch(downloadUrl)).arrayBuffer());
const artifact = decode(gunzipSync(compressed)) as RunArtifact;
console.log(artifact.RunId, artifact.Battles[0]?.Snapshots.CardSets);
```

Python:

```py
import gzip, msgpack, urllib.request

raw = urllib.request.urlopen(download_url).read()
artifact = msgpack.unpackb(gzip.decompress(raw), raw=False)
print(artifact["RunId"], artifact["Battles"][0]["Snapshots"]["CardSets"])
```

### Retention

The run bundle object is **auto-deleted by an R2 lifecycle rule** (configured in the Cloudflare dashboard, not in this repo) — currently **~7 days** after upload. The wire contract only guarantees a retention floor of **≥ 5 days** (the `GET /ghost-battles` lookback window); the dashboard value sits at or above that floor. After the object ages out the `runs` row persists, so this route returns **410 `artifact_expired`** rather than 404. Download promptly after reading `run.id` from a snapshot; do not assume a bundle is retrievable indefinitely.

---

## POST /bazaardb/snapshots/:snapshot_id

Upload one BazaarDB snapshot DTO. The body is stored mostly as opaque JSON bytes: the server only minimally parses `snapshot.id` to verify it matches the path, and does not decode image bytes, calculate a hash, or write metadata columns.

**Auth:** None.

### Path parameter

| Param | Type | Notes |
|---|---|---|
| `:snapshot_id` | string | must match `^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$`; malformed percent-encoding or unsafe decoded id → 400 `invalid_snapshot_id` |

The decoded path segment is trimmed before regex validation, and the body `snapshot.id` is trimmed before comparison, so whitespace-padded ids are accepted post-trim.

### Request body

`Content-Type` must be `application/json`. The body is the full Snapshot DTO assembled by the mod, including metadata and base64 image payload. The mod preserves the full local PNG but sends an upload image derivative capped at 2 MiB; `image.content_type` can be `image/png` or `image/jpeg`. Max body size is 4 MiB. Empty bodies are rejected. The server minimally parses the JSON and requires `snapshot.id` to equal the `:snapshot_id` path parameter; the rest of the DTO is stored opaquely.

Example shape:

```json
{
  "schema_version": 2,
  "snapshot": {
    "id": "snapshot-id",
    "source": "end_of_run_auto",
    "captured_at_utc": "2026-06-03T12:34:56.000Z"
  },
  "player": {
    "account_id": "player-account-id",
    "display_name": "Player",
    "rank": "Gold",
    "rating": 1234,
    "leaderboard_position": 12
  },
  "run": {
    "id": "run-id",
    "day": 10,
    "wins": 9,
    "losses": null,
    "hero": { "id": null, "name": "Vanessa" }
  },
  "image": {
    "content_type": "image/png",
    "encoding": "base64",
    "data_base64": "..."
  },
  "client": {
    "submitted_at_utc": "2026-06-03T12:35:00.000Z"
  }
}
```

### Response 200

```json
{
  "status": "ok",
  "snapshot_id": "string",
  "uploaded_at_utc": "string"
}
```

Re-uploading an existing `snapshot_id` is a no-op regardless of delivery state or outstanding lease (`pending`, `done`, `failed`, or a leased `pending` row — `leased` is not a distinct `delivery_state` value, just a `pending` row carrying `lease_peek_id`/`lease_until_utc`): the server returns 200 and does not replace or revive the existing row/object.

Idempotency takes precedence over validation: once a row exists for `snapshot_id`, the endpoint returns 200 before checking `Content-Type`, body size, or body contents, so the 4xx conditions below apply only to a `snapshot_id` that is not already stored.

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `invalid_snapshot_id` | Decoded path id is not a safe snapshot id |
| 400 | `unsupported_content_type` | `Content-Type` is not `application/json` |
| 400 | `invalid_snapshot_body` | Body is not valid JSON or lacks a `snapshot.id` field |
| 400 | `snapshot_id_mismatch` | Body `snapshot.id` does not match the path `:snapshot_id` |
| 413 | `payload_too_large` | Body is empty or exceeds 4 MiB |
| 500 | `db_insert_failed` | R2 put succeeded but D1 insert failed for a non-idempotent reason |
| 500 | `internal_error` | Other unexpected failure (e.g. R2 put failure) |

The 413 for oversized bodies is pre-checked against `Content-Length` when the header is present; without one, the cap is enforced after the body is buffered (Cloudflare platform body limits apply above that).

---

## POST /bazaardb/peek

Claim the next BazaarDB delivery batch. At most one unexpired peek batch may be outstanding at a time.

**Auth:** `Authorization: Bearer <BAZAARDB_PULL_TOKEN>` required. Missing or wrong token → 401 (no body).

### Request body (optional JSON)

```json
{ "max_items": 10 }
```

`max_items` is floored to an integer and clamped to the range 1–50. When the field is missing, non-finite, or non-numeric it falls back to the default of 10 — omitting `max_items` keeps the original batch size; larger batches are strictly opt-in.

The JSON body is parsed only when the `Content-Type` media type is `application/json` (parameters such as `charset` are allowed; matching is case-insensitive). Any other media type is treated as an empty body, so the defaults apply.

### Response 200 with items

```json
{
  "peek_id": "pk_...",
  "lease_expires_at_utc": "2026-06-03T12:40:00.000Z",
  "items": [
    {
      "snapshot_id": "string",
      "download_url": "https://<account>.r2.cloudflarestorage.com/..."
    }
  ]
}
```

`download_url` is a 10-minute SigV4 presigned GET URL for the private R2 object containing the full Snapshot DTO.

### Response 200 empty

```json
{ "peek_id": null, "items": [] }
```

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

Call `confirm` for successfully ingested DTOs or wait for the lease to expire. A pending row can be claimed at most 3 times; after that, the next `peek` marks it `failed` with `failure_reason='max_delivery_attempts'`. `failed` is a terminal accepted-loss state: the row is never re-queued or re-delivered, and its R2 object is not deleted immediately — cleanup of failed objects is owned by the bucket's R2 lifecycle rule. Re-uploading the same `snapshot_id` later still returns 200 without reviving the row, even if the lifecycle rule has already removed the object.

### Errors

| Status | Body | Condition |
|---|---|---|
| 401 | (empty) | Missing or incorrect bearer token |
| 500 | `{ "error": "internal_error" }` | Unexpected failure (e.g. R2 presign secrets missing, D1 unavailable) |

---

## POST /bazaardb/confirm

Confirm the subset of DTOs from a peek batch that BazaarDB successfully fetched and persisted. Confirmed rows move to `done`; their R2 objects are deleted after the D1 update.

**Auth:** `Authorization: Bearer <BAZAARDB_PULL_TOKEN>` required. Missing or wrong token → 401 (no body).

### Request body

```json
{
  "peek_id": "pk_...",
  "snapshot_ids": ["snap-a", "snap-b"]
}
```

The JSON body is parsed only when the `Content-Type` media type is `application/json` (parameters such as `charset` are allowed; matching is case-insensitive). Any other media type is treated as an empty body, so the request fails with 400 `missing_peek_id`.

### Response 200

```json
{
  "confirmed": ["snap-a", "snap-b"],
  "count": 2
}
```

`confirmed` only includes ids that still matched `peek_id` and `delivery_state='pending'`. Repeating a confirm for the same ids returns an empty list.

### Errors

| Status | Body | Condition |
|---|---|---|
| 401 | (empty) | Missing or incorrect bearer token |
| 400 | `{ "error": "missing_peek_id" }` | `peek_id` is missing or blank |
| 400 | `{ "error": "missing_snapshot_ids" }` | `snapshot_ids` is missing, not an array, or contains no non-empty ids |
| 400 | `{ "error": "too_many_snapshot_ids" }` | More than 50 unique non-empty ids were supplied |
| 500 | `{ "error": "internal_error" }` | Unexpected failure (e.g. D1 unavailable) |

---

## Data retention

- `runs` and `battles` D1 rows are retained indefinitely by design: the server has no `DELETE` path, TTL, or scheduled sweep for them.
- Run-bundle R2 objects are governed by an R2 lifecycle rule configured in the Cloudflare dashboard (outside this repo). **Invariant: the run-bundle retention horizon must be ≥ 5 days**, the `GET /ghost-battles` lookback window — if retention drops below that, `replay-link` starts returning 410 `artifact_expired` for battles still inside the ghost window, with no other signal.
- D1 rows whose R2 object has been lifecycle-deleted ("orphan rows") are expected and harmless; `replay-link` surfaces them as 410 `artifact_expired`.
- `bazaardb_delivery` rows in `done`/`failed` are retained indefinitely as the idempotency ledger for snapshot re-uploads. `done` objects are deleted eagerly at confirm time; `failed` objects are left to the BazaarDB bucket's R2 lifecycle rule.
- BazaarDB snapshot R2 objects are governed by an R2 lifecycle rule (CF dashboard). **Invariant: the snapshot retention horizon must exceed the partner's worst-case pull lag (target ≥ 7 days).** If retention drops below the lag, `peek` fails the aged-out rows as `object_gone` rather than presigning dead URLs.

## BazaarDB clean-break notes

- Deleted routes: `POST /bazaardb-screenshots` and `GET /bazaardb/manifest`.
- The server no longer stores BazaarDB metadata columns; `bazaardb_delivery` is only a delivery queue/ledger.
- Private R2 objects contain the full Snapshot DTO and are deleted after confirm; objects for `failed` rows are cleaned up by the bucket's R2 lifecycle rule instead.
- Delivery is at-least-once within at most 3 peek claims; BazaarDB ingest must be idempotent by `snapshot_id`.
