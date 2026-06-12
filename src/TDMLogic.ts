import { Team, TDMShared, GameEvent } from "./netTypes";

export type KillType = "normal" | "high" | "grenade" | "melee";

interface TDMPlayerStat {
  kills: number;
  deaths: number;
  assists: number;
  score: number;
}

// チームデスマッチのルール・スコア管理。Room から委譲される。
// ダメージ適用は Room が行い、撃破時に onKill を呼ぶ。
export class TDMLogic {
  phase: "PLAYING" | "RESULT" = "PLAYING";
  timeRemaining = 300;
  killLimit = 10;
  scores: { RED: number; BLUE: number } = { RED: 0, BLUE: 0 };
  kills: { RED: number; BLUE: number } = { RED: 0, BLUE: 0 };
  teams = new Map<string, Team>();
  stats = new Map<string, TDMPlayerStat>();
  winner?: Team | "DRAW";

  private damageLog = new Map<string, Map<string, number>>(); // victim → attacker → 累積dmg
  private lastKillAt = new Map<string, number>();
  private endedFlag = false;

  // 開始時にチーム分け・制限値・統計を初期化する。
  start(playerIds: string[], hostId: string, maxPlayers: number): void {
    this.phase = "PLAYING";
    this.winner = undefined;
    this.endedFlag = false;
    this.scores = { RED: 0, BLUE: 0 };
    this.kills = { RED: 0, BLUE: 0 };
    this.teams.clear();
    this.stats.clear();
    this.damageLog.clear();
    this.lastKillAt.clear();

    this.timeRemaining = maxPlayers <= 2 ? 300 : maxPlayers <= 4 ? 420 : 600;
    this.killLimit = maxPlayers <= 2 ? 10 : maxPlayers <= 4 ? 20 : 30;

    // ホストを先頭にして、RED/BLUE を均等に割り当てる（ホストはRED）。
    const ordered = [hostId, ...playerIds.filter((id) => id !== hostId)];
    let red = 0;
    let blue = 0;
    for (const id of ordered) {
      let t: Team;
      if (id === hostId) t = "RED";
      else t = red <= blue ? "RED" : "BLUE";
      this.teams.set(id, t);
      if (t === "RED") red++;
      else blue++;
      this.stats.set(id, { kills: 0, deaths: 0, assists: 0, score: 0 });
    }
  }

  recordDamage(victimId: string, attackerId: string, dmg: number): void {
    if (attackerId === victimId) return;
    let m = this.damageLog.get(victimId);
    if (!m) {
      m = new Map();
      this.damageLog.set(victimId, m);
    }
    m.set(attackerId, (m.get(attackerId) ?? 0) + dmg);
  }

  // 撃破処理。スコア加算・連続キル・アシストを処理し、KILLイベントを積む。
  onKill(
    shooterId: string,
    victimId: string,
    killType: KillType,
    now: number,
    events: GameEvent[],
    tick: number
  ): void {
    if (this.phase !== "PLAYING") return;
    const team = this.teams.get(shooterId);
    const st = this.stats.get(shooterId);
    const vt = this.stats.get(victimId);
    if (vt) vt.deaths += 1;

    const self = shooterId === victimId;
    const friendly = !self && this.teams.get(victimId) === team;

    if (st && team && !self && !friendly) {
      let points = 100;
      if (killType === "high") points = 150;
      else if (killType === "melee") points = 200;
      else if (killType === "grenade") points = 180;

      // 連続キル（5秒以内）
      const last = this.lastKillAt.get(shooterId) ?? -99999;
      if (now - last <= 5000) points += 50;
      this.lastKillAt.set(shooterId, now);

      // アシスト（HP50以上削った別プレイヤー）
      const dl = this.damageLog.get(victimId);
      if (dl) {
        for (const [aid, dmg] of dl) {
          if (aid === shooterId) continue;
          if (dmg < 50) continue;
          const ast = this.stats.get(aid);
          const at = this.teams.get(aid);
          if (ast && at) {
            ast.assists += 1;
            ast.score += 50;
            this.scores[at] += 50;
          }
        }
      }

      st.kills += 1;
      st.score += points;
      this.scores[team] += points;
      this.kills[team] += 1;
    }

    this.damageLog.delete(victimId);
    events.push({
      type: "KILL",
      tick,
      payload: {
        shooterId,
        targetId: victimId,
        killType,
        team: team ?? "RED",
        friendly,
      },
    });

    if (this.kills.RED >= this.killLimit || this.kills.BLUE >= this.killLimit) {
      this.end();
    }
  }

  // 復活時に被ダメージ記録を消す（アシスト集計のリセット）。
  onRespawn(victimId: string): void {
    this.damageLog.delete(victimId);
  }

  tick(dt: number): void {
    if (this.phase !== "PLAYING") return;
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.end();
    }
  }

  private end(): void {
    this.phase = "RESULT";
    this.endedFlag = true;
    this.winner =
      this.kills.RED > this.kills.BLUE
        ? "RED"
        : this.kills.BLUE > this.kills.RED
          ? "BLUE"
          : "DRAW";
  }

  // 終了した瞬間に一度だけ true を返す（Supabase保存の一回起動用）。
  consumeEnded(): boolean {
    if (this.endedFlag) {
      this.endedFlag = false;
      return true;
    }
    return false;
  }

  shared(respawn: Record<string, number>): TDMShared {
    return {
      phase: this.phase,
      timeRemaining: Math.ceil(this.timeRemaining),
      scores: { ...this.scores },
      kills: { ...this.kills },
      killLimit: this.killLimit,
      teams: Object.fromEntries(this.teams),
      respawn,
      winner: this.winner,
    };
  }

  // Supabase保存用の結果データ。
  resultData(): Record<string, unknown> {
    const players: Array<Record<string, unknown>> = [];
    for (const [id, s] of this.stats) {
      players.push({
        playerId: id,
        team: this.teams.get(id),
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
        score: s.score,
      });
    }
    return {
      scores: this.scores,
      kills: this.kills,
      winner: this.winner,
      killLimit: this.killLimit,
      players,
    };
  }
}
