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
  battle_id                    TEXT PRIMARY KEY,
  run_id                       TEXT NOT NULL,
  recorded_at_utc              TEXT NOT NULL,
  day                          INTEGER,
  player_name                  TEXT,
  player_account_id            TEXT NOT NULL,
  player_hero                  TEXT,
  player_rank                  TEXT,
  player_rating                INTEGER,
  player_level                 INTEGER,
  opponent_name                TEXT,
  opponent_account_id          TEXT,
  opponent_hero                TEXT,
  opponent_rank                TEXT,
  opponent_rating              INTEGER,
  opponent_level               INTEGER,
  result                       TEXT,
  is_final_battle              INTEGER NOT NULL DEFAULT 0,
  updated_at_utc               TEXT NOT NULL
);
CREATE INDEX idx_battles_opponent_recorded  ON battles(opponent_account_id, recorded_at_utc DESC, battle_id DESC);
CREATE INDEX idx_battles_updated_at         ON battles(updated_at_utc DESC, battle_id DESC);

CREATE TABLE seen_player_accounts (
  player_account_id TEXT PRIMARY KEY,
  first_seen_at_utc TEXT NOT NULL
);

CREATE TABLE bazaardb_screenshots (
  screenshot_id     TEXT PRIMARY KEY,
  player_account_id TEXT NOT NULL,
  run_id            TEXT,
  hero_name         TEXT,
  final_days        INTEGER,
  final_victories   INTEGER,
  player_name       TEXT,
  player_rank       TEXT,
  player_rating     INTEGER,
  player_position   INTEGER,
  captured_at_utc   TEXT NOT NULL,
  captured_date_utc TEXT NOT NULL,
  image_format      TEXT NOT NULL,
  image_sha256      TEXT NOT NULL,
  image_bytes       INTEGER NOT NULL,
  r2_key            TEXT NOT NULL,
  uploaded_at_utc   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schema_version    INTEGER NOT NULL
);
CREATE INDEX idx_bazaardb_screenshots_cursor
  ON bazaardb_screenshots(captured_date_utc, uploaded_at_utc, screenshot_id);
