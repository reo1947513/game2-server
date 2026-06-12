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
}

export interface MatchRecord {
  roomCode: string;
  mode: string;
  startedAt: string; // ISO8601
  endedAt: string; // ISO8601
  result: Record<string, unknown>;
  players: MatchPlayerSummary[];
}

interface PlayerStatsRow {
  total_kills: number | null;
  total_deaths: number | null;
  total_matches: number | null;
  highest_coop_wave: number | null;
  highest_score: number | null;
}

// 試合終了時にサーバーから呼ぶ。match_history へ1件挿入し、player_stats を加算更新する。
export async function saveMatch(rec: MatchRecord): Promise<void> {
  if (!client) return;
  try {
    await client.from("match_history").insert({
      room_code: rec.roomCode,
      mode: rec.mode,
      started_at: rec.startedAt,
      ended_at: rec.endedAt,
      result: rec.result,
    });

    for (const p of rec.players) {
      const { data } = await client
        .from("player_stats")
        .select("total_kills,total_deaths,total_matches,highest_coop_wave,highest_score")
        .eq("player_id", p.playerId)
        .maybeSingle();
      const prev = (data as PlayerStatsRow | null) ?? {
        total_kills: 0,
        total_deaths: 0,
        total_matches: 0,
        highest_coop_wave: 0,
        highest_score: 0,
      };
      await client.from("player_stats").upsert({
        player_id: p.playerId,
        total_kills: (prev.total_kills ?? 0) + p.kills,
        total_deaths: (prev.total_deaths ?? 0) + p.deaths,
        total_matches: (prev.total_matches ?? 0) + 1,
        highest_coop_wave: Math.max(prev.highest_coop_wave ?? 0, p.coopWave ?? 0),
        highest_score: Math.max(prev.highest_score ?? 0, p.score),
        updated_at: new Date().toISOString(),
      });
    }
    // eslint-disable-next-line no-console
    console.log(`[supabase] match saved (mode=${rec.mode}, players=${rec.players.length})`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[supabase] saveMatch failed", e);
  }
}
