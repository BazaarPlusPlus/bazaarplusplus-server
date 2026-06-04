# V4 API Reference

**Host:** `mod-api-v4.bazaarplusplus.com`
**Auth model:** No token auth for mod-facing endpoints. `POST /bazaardb/peek` and `POST /bazaardb/confirm` require a bearer token. All `player_account_id` fields are required; no sentinel fallbacks accepted.
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

---

## POST /run-bundles

Upload a run artifact plus its D1 projections. R2 put happens before D1 batch; D1 failure triggers best-effort R2 cleanup.

**Auth:** None. `player_account_id` required in the `metadata` part.

### Request body (multipart/form-data)

| Part | Content-Type | Required | Body |
|---|---|---|
| `metadata` | `application/json` or omitted by platform string part | yes | UTF-8 JSON with fields below |
| `artifact` | `application/x-bpp-runbundle+msgpack+gzip` | yes | Raw gzip MessagePack artifact bytes; filename `run-bundle.mpack.gz` |

The endpoint rejects legacy `application/json` run-bundle bodies with `415 { "error": "unsupported_content_type" }`.

Only the `artifact` part's Content-Type is validated; the `metadata` part is accepted as any string part (its Content-Type is not inspected), and the `artifact` filename is informational (client-supplied, server-ignored).

**`metadata` JSON fields**

| Field | Type | Required |
|---|---|---|
| `schema_version` | number (finite integer; current mod sends `5`) | yes |
| `player_account_id` | string (non-empty) | yes |
| `submitted_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`) | yes |
| `artifact_codec` | string; must equal `application/x-bpp-runbundle+msgpack+gzip` | yes |
| `run_projection` | object (see below) | no (defaults to `{}`) |
| `battle_projections` | array of battle objects (see below) | no (defaults to `[]`) |

**`run_projection` fields** (all optional unless noted):

| Field | Type |
|---|---|
| `run_id` | string (non-empty) | **required** |
| `status` | string | **required** |
| `ended_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`) | **required** |
| `hero_id` | string |
| `hero_name` | string |
| `player_rank` | string |
| `player_rating` | number |
| `player_position` | number |
| `started_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`) |
| `final_day` | number |
| `final_wins` | number |
| `final_losses` | number |
| `final_player_rank` | string |
| `final_player_rating` | number |
| `final_player_position` | number |

**`battle_projections[]` fields** (per item):

| Field | Type | Notes |
|---|---|---|
| `battle_id` | string | required; missing → 400 `battle_id_required` |
| `run_id` | string | required; must equal `run_projection.run_id` or → 400 `battle_run_id_mismatch` |
| `recorded_at_utc` | string (ISO-8601 with timezone; stored as UTC `toISOString()`) | defaults to server time |
| `day` | number | |
| `player_name` | string | |
| `player_account_id` | string | uploader |
| `player_hero` | string | |
| `player_rank` | string | |
| `player_rating` | number | |
| `player_level` | number | |
| `player_prestige` | number | |
| `player_victories` | number | |
| `opponent_name` | string | |
| `opponent_account_id` | string | nullable; every valid battle projection is written regardless of opponent account |
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

### Response 200 (accepted)

```json
{
  "status": "accepted",
  "run_id": "<string>",
  "object_key": "<string>"
}
```

`object_key` format: `run-bundles/<player_account_id>/<run_id>/<base64url(sha256)>.mpack.gz`

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `invalid_run_bundle_request` | Missing/invalid multipart part, missing/invalid metadata field (`schema_version`, `player_account_id`, `submitted_at_utc`, `artifact_codec`), invalid artifact content type, invalid `run_id`/`status`/`ended_at_utc` in `run_projection`, invalid optional timestamp, or `player_account_id`/`run_id` produces an unsafe key segment |
| 400 | `battle_id_required` | A battle in `battle_projections` has no `battle_id` |
| 400 | `battle_run_id_mismatch` | A battle's `run_id` does not match `run_projection.run_id` |
| 413 | `payload_too_large` | Artifact part is empty or larger than 8 MiB |
| 415 | `unsupported_content_type` | Request is not `multipart/form-data` |
| 409 | `run_bundle_conflict` | The `run_id` already exists with a different artifact hash |
| 500 | (rethrown) | R2 put failure or D1 batch failure after best-effort cleanup |

### V3 → V4/V5 deltas

- `player_account_id` no longer accepts `"anonymous-player"` sentinel; server rejects empty/missing with `invalid_run_bundle_request`. Mod must skip upload if account id is unavailable.
- `run_bundles` table merged into `runs`; `battles.replay_available` wire field removed (was a dead field — always `true` in V3). `battles.player_account_id_in_payload` removed.
- Bundle-final battle metadata is carried as `is_final_battle`; the old V3 `is_bundle_final_battle` name is not consumed or returned.
- Former `seen_player_accounts` opponent filtering removed; battle projections are fully ingested.
- R2 key `player_account_id` segment is now always a real id; no `"anonymous-player"` path.
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

`download_url` is a 5-minute SigV4 presigned R2 URL. The mod GETs this URL directly; no Worker proxy.

### Errors

| Status | `error` code | Condition |
|---|---|---|
| 400 | `bad_request` | Malformed percent-encoding in `:battle_id` path segment |
| 404 | `battle_not_found` | No battle (joined to its run) with that `battle_id` in D1 — either the battle row is missing or its `run_id` has no matching `runs` row |
| 410 | `artifact_expired` | Battle row exists but `RUN_BUNDLE_BUCKET.head(object_key)` returned null (object deleted by R2 lifecycle) |

### V3 → V4 deltas

- 404 `battle_not_found` and 410 `artifact_expired` are now distinct error codes (V3 had a single combined error).
- `download_url` content changed from a Worker-proxied URL to a direct R2 presigned URL — wire field name unchanged; mod does not need to change its GET logic.
- `expires_at_utc` field name unchanged.
- `GET /replays/:token` endpoint removed; token-based replay download no longer exists.
- `replay_available` is no longer consulted; artifact presence is determined by `R2.head()` at request time.

---

## POST /bazaardb/snapshots/:snapshot_id

Upload one BazaarDB snapshot DTO. The body is stored mostly as opaque JSON bytes: the server only minimally parses `snapshot.id` to verify it matches the path, and does not decode image bytes, calculate a hash, or write metadata columns.

**Auth:** None.

### Path parameter

| Param | Type | Notes |
|---|---|---|
| `:snapshot_id` | string | must match `^[A-Za-z0-9._-]{1,128}$`; malformed percent-encoding or unsafe decoded id → 400 `invalid_snapshot_id` |

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

---

## POST /bazaardb/peek

Claim the next BazaarDB delivery batch. At most one unexpired peek batch may be outstanding at a time.

**Auth:** `Authorization: Bearer <BAZAARDB_PULL_TOKEN>` required. Missing or wrong token → 401 (no body).

### Request body (optional JSON)

```json
{ "max_items": 10 }
```

`max_items` defaults to 10, is floored to an integer, and is clamped to the range 1–10 (non-finite or non-numeric values fall back to 10).

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
  "lease_expires_at_utc": "2026-06-03T12:40:00.000Z"
}
```

Call `confirm` for successfully ingested DTOs or wait for the lease to expire.

### Errors

| Status | Body | Condition |
|---|---|---|---|
| 401 | (empty) | Missing or incorrect bearer token |

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
| 400 | `{ "error": "too_many_snapshot_ids" }` | More than 10 unique non-empty ids were supplied |

---

## BazaarDB clean-break notes

- Deleted routes: `POST /bazaardb-screenshots` and `GET /bazaardb/manifest`.
- The server no longer stores BazaarDB metadata columns; `bazaardb_delivery` is only a delivery queue/ledger.
- Private R2 objects contain the full Snapshot DTO and are deleted after confirm.
- Delivery is at-least-once; BazaarDB ingest must be idempotent by `snapshot_id`.
