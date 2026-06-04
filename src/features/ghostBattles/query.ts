import { GHOST_QUERY_LOOKBACK_DAYS } from "../../config";
import type { Env } from "../../env";
import { json, jsonError } from "../../http/json";
import { parseClampedInteger, trimString } from "../../http/request";
import { logInfo } from "../../observability";

type GhostBattleRow = {
  battle_id: string;
  recorded_at_utc: string;
  day: number | null;
  player_name: string | null;
  player_account_id: string | null;
  player_hero: string | null;
  player_rank: string | null;
  player_rating: number | null;
  player_level: number | null;
  player_prestige: number | null;
  player_victories: number | null;
  opponent_name: string | null;
  opponent_account_id: string | null;
  opponent_hero: string | null;
  opponent_rank: string | null;
  opponent_rating: number | null;
  opponent_level: number | null;
  opponent_prestige: number | null;
  opponent_victories: number | null;
  result: string | null;
  winner_combatant_id: string | null;
  loser_combatant_id: string | null;
  is_final_battle: number;
};

export async function handleQueryGhostBattles(
  request: Request,
  env: Env,
): Promise<Response> {
  const phaseStart = Date.now();
  const url = new URL(request.url);
  const playerAccountId = trimString(url.searchParams.get("player_account_id"));
  if (!playerAccountId) {
    return jsonError("invalid_request");
  }

  const limit = parseClampedInteger(url.searchParams.get("limit"), 200, 1, 200);
  const fromUtc = new Date(
    Date.now() - GHOST_QUERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const d1Start = Date.now();
  const result = await env.DB.prepare(
    `
      SELECT
        battle_id, recorded_at_utc, day,
        player_name, player_account_id, player_hero, player_rank, player_rating, player_level,
        player_prestige, player_victories,
        opponent_name, opponent_account_id, opponent_hero, opponent_rank,
        opponent_rating, opponent_level, opponent_prestige, opponent_victories,
        result, winner_combatant_id, loser_combatant_id, is_final_battle
      FROM battles
      WHERE opponent_account_id = ?
        AND recorded_at_utc >= ?
      ORDER BY recorded_at_utc DESC, battle_id DESC
      LIMIT ?
    `,
  )
    .bind(playerAccountId, fromUtc, limit)
    .all<GhostBattleRow>();
  const d1ReadMs = Date.now() - d1Start;

  const battles = result.results.map((row) => ({
    battle_id: row.battle_id,
    recorded_at_utc: row.recorded_at_utc,
    day: row.day,
    player_name: row.player_name,
    player_account_id: row.player_account_id,
    player_hero: row.player_hero,
    player_rank: row.player_rank,
    player_rating: row.player_rating,
    player_level: row.player_level,
    player_prestige: row.player_prestige,
    player_victories: row.player_victories,
    opponent_name: row.opponent_name,
    opponent_account_id: row.opponent_account_id,
    opponent_hero: row.opponent_hero,
    opponent_rank: row.opponent_rank,
    opponent_rating: row.opponent_rating,
    opponent_level: row.opponent_level,
    opponent_prestige: row.opponent_prestige,
    opponent_victories: row.opponent_victories,
    result: row.result,
    winner_combatant_id: row.winner_combatant_id,
    loser_combatant_id: row.loser_combatant_id,
    is_final_battle: row.is_final_battle === 1,
  }));

  logInfo("ghost_battles.query", {
    phase_ms: { d1_read: d1ReadMs, total: Date.now() - phaseStart },
    row_count: battles.length,
  });

  return json({ battles });
}
