-- Re-introduces opponent-side ingest filtering for battles.
-- Seed only from historical uploaders; do not mark historical opponents as seen.

CREATE TABLE seen_player_accounts (
  player_account_id  TEXT PRIMARY KEY,
  first_seen_at_utc  TEXT NOT NULL
);

INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc)
SELECT player_account_id, MIN(created_at_utc)
FROM runs
GROUP BY player_account_id;
