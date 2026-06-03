-- V4 initial schema. Single migration; the V3 schema's 12-migration history
-- (auth, installation_id, ghost-battle indexes, bundle-final flag, seen-account
-- filter, BazaarDB) is collapsed and the dead artifacts (run_bundles table,
-- replay_tokens table, installation_id columns, last_seen_at_utc,
-- player_account_id_in_payload, replay_available) are gone for good.

CREATE TABLE runs (
  run_id                TEXT PRIMARY KEY,
  player_account_id     TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  object_key            TEXT NOT NULL,
  codec                 TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  status                TEXT NOT NULL,
  hero_id               TEXT,
  hero_name             TEXT,
  player_rank           TEXT,
  player_rating         INTEGER,
  player_position       INTEGER,
  started_at_utc        TEXT,
  ended_at_utc          TEXT NOT NULL,
  final_day             INTEGER,
  final_wins            INTEGER,
  final_losses          INTEGER,
  final_player_rank     TEXT,
  final_player_rating   INTEGER,
  final_player_position INTEGER,
  submitted_at_utc      TEXT NOT NULL,
  created_at_utc        TEXT NOT NULL,
  updated_at_utc        TEXT NOT NULL
);
CREATE INDEX idx_runs_ended_at    ON runs(ended_at_utc DESC, run_id DESC);
CREATE INDEX idx_runs_updated_at  ON runs(updated_at_utc DESC, run_id DESC);

CREATE TABLE battles (
  battle_id           TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  recorded_at_utc     TEXT NOT NULL,
  day                 INTEGER,

  player_name         TEXT,
  player_account_id   TEXT NOT NULL,
  player_hero         TEXT,
  player_rank         TEXT,
  player_rating       INTEGER,
  player_level        INTEGER,
  player_prestige     INTEGER,
  player_victories    INTEGER,

  opponent_name       TEXT,
  opponent_account_id TEXT,
  opponent_hero       TEXT,
  opponent_rank       TEXT,
  opponent_rating     INTEGER,
  opponent_level      INTEGER,
  opponent_prestige   INTEGER,
  opponent_victories  INTEGER,

  result              TEXT,
  winner_combatant_id TEXT,
  loser_combatant_id  TEXT,
  is_final_battle     INTEGER NOT NULL DEFAULT 0 CHECK (is_final_battle IN (0, 1)),
  updated_at_utc      TEXT NOT NULL
);
CREATE INDEX idx_battles_opponent_recorded
  ON battles(opponent_account_id, recorded_at_utc DESC, battle_id DESC)
  WHERE opponent_account_id IS NOT NULL;

CREATE TABLE bazaardb_delivery (
  snapshot_id          TEXT PRIMARY KEY,
  r2_key               TEXT NOT NULL UNIQUE,
  content_type         TEXT NOT NULL,
  body_bytes           INTEGER NOT NULL CHECK (body_bytes > 0 AND body_bytes <= 4194304),

  delivery_state       TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'done', 'failed')),

  lease_peek_id        TEXT,
  lease_until_utc      TEXT,
  delivery_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),

  uploaded_at_utc      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  state_updated_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at_utc     TEXT,
  failed_at_utc        TEXT,
  failure_reason       TEXT,

  CHECK (content_type = 'application/json'),
  CHECK (
    (lease_peek_id IS NULL AND lease_until_utc IS NULL)
    OR (
      delivery_state = 'pending'
      AND lease_peek_id IS NOT NULL
      AND lease_until_utc IS NOT NULL
    )
  ),
  CHECK (
    (
      delivery_state = 'pending'
      AND delivered_at_utc IS NULL
      AND failed_at_utc IS NULL
    )
    OR (
      delivery_state = 'done'
      AND delivered_at_utc IS NOT NULL
      AND failed_at_utc IS NULL
    )
    OR (
      delivery_state = 'failed'
      AND failed_at_utc IS NOT NULL
      AND delivered_at_utc IS NULL
    )
  )
);

CREATE INDEX idx_bazaardb_delivery_pending_order
  ON bazaardb_delivery(uploaded_at_utc, snapshot_id)
  WHERE delivery_state = 'pending';

CREATE INDEX idx_bazaardb_delivery_pending_attempts
  ON bazaardb_delivery(delivery_attempts, lease_until_utc, uploaded_at_utc, snapshot_id)
  WHERE delivery_state = 'pending';

CREATE INDEX idx_bazaardb_delivery_active_lease
  ON bazaardb_delivery(lease_until_utc, lease_peek_id)
  WHERE delivery_state = 'pending' AND lease_until_utc IS NOT NULL;

CREATE INDEX idx_bazaardb_delivery_confirm
  ON bazaardb_delivery(lease_peek_id, snapshot_id)
  WHERE delivery_state = 'pending' AND lease_peek_id IS NOT NULL;
