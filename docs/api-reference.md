# V4 API Reference

**Host:** `mod-api-v4.bazaarplusplus.com`
**Auth model:** No token auth for mod-facing endpoints. `GET /bazaardb/manifest` requires a bearer token. All `player_account_id` fields are required; no sentinel fallbacks accepted.
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

**Auth:** None. `player_account_id` required in body.

### Request body (JSON)

| Field | Type | Required |
|---|---|---|
| `schema_version` | number (finite integer) | yes |
| `player_account_id` | string (non-empty) | yes |
| `submitted_at_utc` | string (ISO-8601) | yes |
| `artifact_codec` | string | yes |
| `artifact_bytes` | base64 string or byte array | yes |
| `run_projection` | object (see below) | no (defaults to `{}`) |
| `battle_projections` | array of battle objects (see below) | no (defaults to `[]`) |

**`run_projection` fields** (all optional unless noted):

| Field | Type |
|---|---|
| `run_id` | string (non-empty) | **required** |
| `status` | string | **required** |
| `ended_at_utc` | string | **required** |
| `hero_id` | string |
| `hero_name` | string |
| `player_rank` | string |
| `player_rating` | number |
| `player_position` | number |
| `started_at_utc` | string |
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
| `recorded_at_utc` | string | defaults to server time |
| `day` | number | |
| `player_name` | string | |
| `player_account_id` | string | uploader |
| `player_hero` | string | |
| `player_rank` | string | |
| `player_rating` | number | |
| `player_level` | number | |
| `opponent_name` | string | |
| `opponent_account_id` | string | filter gate: row written only if null, equals uploader, or in `seen_player_accounts` |
| `opponent_hero` | string | |
| `opponent_rank` | string | |
| `opponent_rating` | number | |
| `opponent_level` | number | |
| `result` | string | |
| `is_final_battle` | boolean | upsert uses sticky MAX — once true, never reverts |

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
| 400 | `invalid_run_bundle_request` | Missing/invalid top-level field (`schema_version`, `player_account_id`, `submitted_at_utc`, `artifact_codec`, `artifact_bytes`), invalid `run_id`/`status`/`ended_at_utc` in `run_projection`, or `player_account_id` produces an unsafe key segment |
| 400 | `battle_id_required` | A battle in `battle_projections` has no `battle_id` |
| 400 | `battle_run_id_mismatch` | A battle's `run_id` does not match `run_projection.run_id` |
| 500 | (rethrown) | R2 put failure or D1 batch failure after best-effort cleanup |

### V3 → V4 deltas

- `player_account_id` no longer accepts `"anonymous-player"` sentinel; server rejects empty/missing with `invalid_run_bundle_request`. Mod must skip upload if account id is unavailable.
- `run_bundles` table merged into `runs`; `battles.replay_available` wire field removed (was a dead field — always `true` in V3). `battles.player_account_id_in_payload` removed.
- `battles.is_bundle_final_battle` renamed to `is_final_battle` (V3 redundant `bundle_` prefix dropped).
- `battles.is_final_battle` upsert uses sticky `MAX()` semantics (V3 had unconditional overwrite — bug on retransmit reordering).
- `seen_player_accounts.last_seen_at_utc` column removed.
- R2 key `player_account_id` segment is now always a real id; no `"anonymous-player"` path.

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
      "player_hero": "string | null",
      "player_rank": "string | null",
      "player_rating": "number | null",
      "player_level": "number | null",
      "opponent_name": "string | null",
      "opponent_account_id": "string | null",
      "opponent_hero": "string | null",
      "opponent_rank": "string | null",
      "opponent_rating": "number | null",
      "opponent_level": "number | null",
      "result": "string | null",
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

- `battles[].is_bundle_final_battle` renamed to `is_final_battle`.
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
| 404 | `battle_not_found` | No battle row with that `battle_id` in D1 |
| 410 | `artifact_expired` | Battle row exists but `RUN_BUNDLE_BUCKET.head(object_key)` returned null (object deleted by R2 lifecycle) |

### V3 → V4 deltas

- 404 `battle_not_found` and 410 `artifact_expired` are now distinct error codes (V3 had a single combined error).
- `download_url` content changed from a Worker-proxied URL to a direct R2 presigned URL — wire field name unchanged; mod does not need to change its GET logic.
- `expires_at_utc` field name unchanged.
- `GET /replays/:token` endpoint removed; token-based replay download no longer exists.
- `replay_available` is no longer consulted; artifact presence is determined by `R2.head()` at request time.

---

## POST /bazaardb-screenshots

Upload a BazaarDB screenshot and its metadata. R2 put happens before D1 insert; D1 failure triggers best-effort R2 cleanup.

**Auth:** None. `player_account_id` required in body.

### Request body (JSON)

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | number | yes | must equal `1`; other values → 400 `unsupported_schema_version` |
| `submitted_at_utc` | string | yes | |
| `player_account_id` | string | yes | |
| `screenshot_id` | string | yes | must be a safe URL/key segment |
| `captured_at_utc` | string | yes | parsed as ISO datetime; must not be more than 24h in the future |
| `image_format` | string | yes | must be `"png"` |
| `image_bytes_base64` | string | yes | base64-encoded PNG bytes; max 2 MB |
| `run_id` | string | no | |
| `hero_name` | string | no | |
| `final_days` | number | no | |
| `final_victories` | number | no | |
| `player_name` | string | no | |
| `player_rank` | string | no | |
| `player_rating` | number | no | |
| `player_position` | number | no | |

### Response 200 (accepted)

```json
{
  "status": "ok",
  "screenshot_id": "string",
  "uploaded_at_utc": "string"
}
```

`uploaded_at_utc` is the server time at which the D1 row was written.

### Rejected (validation failure, 400)

```json
{ "status": "rejected", "reason": "<code>" }
```

| `reason` | Condition |
|---|---|
| `unsupported_schema_version` | `schema_version` != 1 |
| `missing_required_field` | Any of `submitted_at_utc`, `player_account_id`, `screenshot_id`, `captured_at_utc`, `image_format`, `image_bytes_base64` missing or null |
| `invalid_screenshot_id` | `screenshot_id` contains characters unsafe for R2 keys / URLs |
| `unsupported_image_format` | `image_format` is not `"png"` |
| `invalid_captured_at_utc` | `captured_at_utc` does not parse as a valid datetime, or is more than 24h in the future |
| `invalid_image_bytes_base64` | `image_bytes_base64` is not valid base64 |
| `image_too_large` | Decoded image exceeds 2 MB |
| `image_bytes_not_png` | Decoded bytes are empty or do not match PNG magic bytes |

### Error (server failure, 500)

```json
{ "status": "error", "reason": "db_upsert_failed" }
```

### V3 → V4 deltas

- `player_account_id` no longer accepts `"anonymous-player"` sentinel; mod must skip upload if account id is unavailable.
- R2 key shape changed: `bazaardb/<captured_date_utc>/<screenshot_id>.png` (V3: `bazaardb/screenshots/<date>/<id>.png`).
- Upsert on `screenshot_id` conflict updates `uploaded_at_utc`, `image_sha256`, `image_bytes`, `r2_key`.

---

## GET /bazaardb/manifest

Cursor-paginated daily manifest of BazaarDB screenshots. Each row includes a stable public image URL pointing to the public R2 bucket; images are served directly without going through the Worker.

**Auth:** `Authorization: Bearer <BAZAARDB_PULL_TOKEN>` required. Missing or wrong token → 401 (no body).

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `date` | string | yes | `YYYY-MM-DD` format; invalid → 400 `invalid_date` |
| `cursor` | string | no | base64(`<uploaded_at_utc>:<screenshot_id>`); omit for first page; malformed → 400 `invalid_cursor` |
| `limit` | integer | no | default 200; clamped to 1–500 |

### Response 200

```json
{
  "rows": [
    {
      "screenshot_id": "string",
      "player_account_id": "string",
      "run_id": "string | null",
      "hero_name": "string | null",
      "final_days": "number | null",
      "final_victories": "number | null",
      "player_name": "string | null",
      "player_rank": "string | null",
      "player_rating": "number | null",
      "player_position": "number | null",
      "captured_at_utc": "string",
      "image_format": "string",
      "image_sha256": "string",
      "image_bytes": "number",
      "image_url": "string"
    }
  ],
  "next_cursor": "string | null"
}
```

`image_url` = `https://bazaardb-assets-v4.bazaarplusplus.com/<encodeURI(r2_key)>`

`next_cursor` is non-null when `rows.length == limit`; null on the last page.

Rows ordered by `(uploaded_at_utc ASC, screenshot_id ASC)`.

Cursor encodes the last row's `(uploaded_at_utc, screenshot_id)` as `base64(<uploaded_at_utc>:<screenshot_id>)` (last `:` is the delimiter). Pass as `?cursor=` on the next request.

### Errors

| Status | Body | Condition |
|---|---|---|
| 401 | (empty) | Missing or incorrect bearer token |
| 400 | `{ "error": "invalid_date" }` | `date` param absent, wrong format, or not a valid calendar date |
| 400 | `{ "error": "invalid_cursor" }` | `cursor` param present but malformed (cannot decode or parse) |

### V3 → V4 deltas

- Top-level response key renamed: `items` → `rows`.
- Cursor format changed: V3 used `?cursor=<screenshot_id>` (bare GUID, not monotonic); V4 uses `?cursor=base64(<uploaded_at_utc>:<screenshot_id>)` composite cursor to avoid skip/duplicate on concurrent uploads.
- `image_url` field added to each row (stable public URL); `GET /bazaardb/image/:key` Worker endpoint removed.
- Bearer auth retained (`BAZAARDB_PULL_TOKEN`). Brainstorming mid-draft proposed removing it; reverted — manifest exposes `player_account_id`, `player_name`, `player_rank`, `player_rating`.
- `limit` upper bound raised from (V3 default) to 500.
