import { createClient, SupabaseClient } from "@supabase/supabase-js";

// サーバー専用のSupabaseクライアント。
// 環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無ければ無効化し、
// 保存呼び出しは静かにスキップする（ローカル検証はSupabaseなしで可能）。
let client: SupabaseClient | null = null;
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  client = createClient(url, key, { auth: { persistSession: false } });
  // eslint-disable-next-line no-console
  console.log("[supabase] enabled");
} else {
  // eslint-disable-next-line no-console
  console.log("[supabase] disabled (env not set)");
}

export interface MatchPlayerSummary {
  playerId: string;
  kills: number;
  deaths: number;
  score: number;
  coopWave?: number;
  // ROOFTOP DUEL の集計（rooftop モード時のみ。player_stats の rooftop_* 列へ加算）。
  rooftopKills?: number;
  rooftopHeadshots?: number;
  rooftopWins?: number;
  rooftopLongest?: number; // 最長射撃距離（m）。greatest で最大値を保持。
}

export interface MatchRecord {
  roomCode: string;
  mode: string;
  startedAt: string; // ISO8601
  endedAt: string; // ISO8601
  result: Record<string, unknown>;
  players: MatchPlayerSummary[];
}

// 試合終了時にサーバーから呼ぶ。
// match_history へ1件挿入し、player_stats を on-conflict 加算（アトミック）で更新する。
// プレイヤーごとの更新は Promise.all で並列化する。
//
// 事前に Supabase で以下の関数を作成しておく（増分はサーバー側ではなくDB側で原子的に行う）:
//
//   create or replace function increment_player_stats(
//     p_player_id text, p_kills int, p_deaths int, p_coop_wave int, p_score int
//   ) returns void language sql as $$
//     insert into player_stats (
//       player_id, total_kills, total_deaths, total_matches, highest_coop_wave, highest_score
//     )
//     values (p_player_id, p_kills, p_deaths, 1, p_coop_wave, p_score)
//     on conflict (player_id) do update set
//       total_kills = player_stats.total_kills + excluded.total_kills,
//       total_deaths = player_stats.total_deaths + excluded.total_deaths,
//       total_matches = player_stats.total_matches + 1,
//       highest_coop_wave = greatest(player_stats.highest_coop_wave, excluded.highest_coop_wave),
//       highest_score = greatest(player_stats.highest_score, excluded.highest_score),
//       updated_at = now();
//   $$;
export async function saveMatch(rec: MatchRecord): Promise<void> {
  if (!client) return;
  const db = client;
  try {
    await db.from("match_history").insert({
      room_code: rec.roomCode,
      mode: rec.mode,
      started_at: rec.startedAt,
      ended_at: rec.endedAt,
      result: rec.result,
    });

    await Promise.all(
      rec.players.map((p) =>
        db.rpc("increment_player_stats", {
          p_player_id: p.playerId,
          p_kills: p.kills,
          p_deaths: p.deaths,
          p_coop_wave: p.coopWave ?? 0,
          p_score: p.score,
          p_rooftop_kills: p.rooftopKills ?? 0,
          p_rooftop_headshots: p.rooftopHeadshots ?? 0,
          p_rooftop_wins: p.rooftopWins ?? 0,
          p_rooftop_longest: p.rooftopLongest ?? 0,
        })
      )
    );
    // eslint-disable-next-line no-console
    console.log(`[supabase] match saved (mode=${rec.mode}, players=${rec.players.length})`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[supabase] saveMatch failed", e);
  }
}
