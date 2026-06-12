import { RooftopShared, RooftopPlayerShared, ZiplineState, GameEvent, Vec3 } from "./netTypes";
import { createZiplines } from "./stages/SkylineFive";
import { ZIPLINE_COOLDOWN } from "./netTypes";

// ROOFTOP DUEL のルール・スコア管理（Phase 3a：デスマッチ＝個人戦FFA）。
// ダメージ適用は Room が行い、撃破時に onKill を呼ぶ。TDMLogic と同じ委譲構造に揃える。
// サバイバル（ラウンド制・収縮ゾーン・観戦）は Phase 4 で拡張する。

export interface RooftopKillOpts {
  headshot: boolean;
  melee: boolean;
}

interface RPStat {
  kills: number;
  deaths: number;
  score: number;
  headshots: number; // Supabase 用（Phase 5）
  onZipline: string | null; // 搭乗中のジップラインID
  ziplineStart: number; // 搭乗開始時刻（ms）
  ziplineEnd: number; // 搭乗終了予定時刻（ms）
  invulnUntil: number; // 無敵終了時刻（ms。リスポーン直後2秒）
}

function newStat(): RPStat {
  return {
    kills: 0,
    deaths: 0,
    score: 0,
    headshots: 0,
    onZipline: null,
    ziplineStart: 0,
    ziplineEnd: 0,
    invulnUntil: 0,
  };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class RooftopDuelLogic {
  rule: "deathmatch" | "survival" = "deathmatch";
  phase: "PLAYING" | "RESULT" = "PLAYING";
  timeRemaining = 480; // 8分
  killLimit = 10;
  ziplines: ZiplineState[] = [];
  stats = new Map<string, RPStat>();
  winnerId?: string;

  private lastKillAt = new Map<string, number>();
  private endedFlag = false;

  // 開始時に統計・ジップライン・キル上限を初期化する。
  start(playerIds: string[], maxPlayers: number): void {
    this.phase = "PLAYING";
    this.winnerId = undefined;
    this.endedFlag = false;
    this.timeRemaining = 480;
    this.killLimit = maxPlayers <= 2 ? 10 : maxPlayers <= 4 ? 15 : 20;
    this.ziplines = createZiplines();
    this.stats.clear();
    this.lastKillAt.clear();
    for (const id of playerIds) this.stats.set(id, newStat());
  }

  // 途中参加者を統計へ追加する（未登録なら）。
  ensureMember(id: string): void {
    if (!this.stats.has(id)) this.stats.set(id, newStat());
  }

  isOnZipline(id: string): boolean {
    return !!this.stats.get(id)?.onZipline;
  }

  // ジップライン乗り込み要求。空き＆クールダウン0＆起点付近なら承認して inUse をロックする。
  // 実際の滑走移動はクライアントが行い、サーバーはロックと終了解放だけを権威管理する。
  useZipline(playerId: string, ziplineId: string, playerPos: Vec3, now: number): boolean {
    if (this.phase !== "PLAYING") return false;
    const st = this.stats.get(playerId);
    if (!st || st.onZipline) return false;
    const z = this.ziplines.find((x) => x.id === ziplineId);
    if (!z || z.inUse || z.cooldown > 0) return false;
    if (dist(playerPos, z.from) > 3) return false; // 起点アンカー付近のみ
    z.inUse = playerId;
    st.onZipline = ziplineId;
    st.ziplineStart = now;
    st.ziplineEnd = now + (z.length / z.speed) * 1000;
    return true;
  }

  // 撃破処理。スコア加算・連続キル・終了判定。
  onKill(
    shooterId: string,
    victimId: string,
    opts: RooftopKillOpts,
    now: number,
    events: GameEvent[],
    tick: number
  ): void {
    if (this.phase !== "PLAYING") return;
    const vt = this.stats.get(victimId);
    if (vt) vt.deaths += 1;

    const st = this.stats.get(shooterId);
    const self = shooterId === victimId;
    if (st && !self) {
      // 基本点（近接＞ヘッドショット＞通常）。
      let points = 100;
      if (opts.melee) {
        points = 300;
      } else if (opts.headshot) {
        points = 200;
        st.headshots += 1;
      }
      // ジップライン中のキル（撃たれた側が移動中=180／撃った側が移動中=150）。最大を採用する。
      const shooterMoving = !!st.onZipline;
      const victimMoving = !!this.stats.get(victimId)?.onZipline;
      if (victimMoving) points = Math.max(points, 180);
      else if (shooterMoving) points = Math.max(points, 150);

      // 連続キル（10秒以内）+50。
      const last = this.lastKillAt.get(shooterId) ?? -99999;
      if (now - last <= 10000) points += 50;
      this.lastKillAt.set(shooterId, now);

      st.kills += 1;
      st.score += points;
    }

    events.push({
      type: "KILL",
      tick,
      payload: { shooterId, targetId: victimId, headshot: opts.headshot, melee: opts.melee },
    });

    if (st && st.kills >= this.killLimit) this.end();
  }

  // リスポーン時に無敵（2秒）を付与する。
  onRespawn(id: string, now: number): void {
    const st = this.stats.get(id);
    if (st) st.invulnUntil = now + 2000;
  }

  // 現在無敵かどうか（Room がダメージ無効化に使う）。
  isInvulnerable(id: string, now: number): boolean {
    const st = this.stats.get(id);
    return !!st && now < st.invulnUntil;
  }

  tick(dt: number, now: number): void {
    if (this.phase !== "PLAYING") return;
    this.timeRemaining -= dt;

    // ジップラインのクールダウン消化と、搭乗の終了解放。
    for (const z of this.ziplines) {
      if (z.cooldown > 0) z.cooldown = Math.max(0, z.cooldown - dt);
    }
    for (const st of this.stats.values()) {
      if (st.onZipline && now >= st.ziplineEnd) {
        const z = this.ziplines.find((x) => x.id === st.onZipline);
        if (z) {
          z.inUse = null;
          z.cooldown = ZIPLINE_COOLDOWN;
        }
        st.onZipline = null;
      }
    }

    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.end();
    }
  }

  private end(): void {
    this.phase = "RESULT";
    this.endedFlag = true;
    // 最高スコアを勝者にする（同点なら先に到達した順＝Mapの挿入順）。
    let best = -1;
    let winner: string | undefined;
    for (const [id, s] of this.stats) {
      if (s.score > best) {
        best = s.score;
        winner = id;
      }
    }
    this.winnerId = winner;
  }

  // 終了した瞬間に一度だけ true を返す（Supabase保存の一回起動用）。
  consumeEnded(): boolean {
    if (this.endedFlag) {
      this.endedFlag = false;
      return true;
    }
    return false;
  }

  // 共有状態を作る。alive は Room が持つ生存・リスポーン残秒（playerId→{alive,respawn}）。
  shared(now: number, alive: Record<string, { alive: boolean; respawn: number }>): RooftopShared {
    const players: RooftopPlayerShared[] = [...this.stats.entries()].map(([id, s]) => {
      const a = alive[id] ?? { alive: true, respawn: 0 };
      let progress = 0;
      if (s.onZipline && s.ziplineEnd > s.ziplineStart) {
        progress = Math.max(0, Math.min(1, (now - s.ziplineStart) / (s.ziplineEnd - s.ziplineStart)));
      }
      return {
        playerId: id,
        kills: s.kills,
        deaths: s.deaths,
        score: s.score,
        isAlive: a.alive,
        respawnCountdown: a.respawn,
        invulnUntil: s.invulnUntil,
        onZipline: s.onZipline,
        ziplineProgress: progress,
        spectatingId: null,
        roundWins: 0,
      };
    });
    return {
      rule: this.rule,
      phase: this.phase,
      timeRemaining: Math.ceil(this.timeRemaining),
      round: 1,
      killLimit: this.killLimit,
      dangerZones: [],
      ziplines: this.ziplines,
      players,
      winnerId: this.winnerId,
    };
  }

  // Supabase保存用の結果データ。
  resultData(): Record<string, unknown> {
    const players: Array<Record<string, unknown>> = [];
    for (const [id, s] of this.stats) {
      players.push({ playerId: id, kills: s.kills, deaths: s.deaths, score: s.score, headshots: s.headshots });
    }
    return { rule: this.rule, killLimit: this.killLimit, winnerId: this.winnerId, players };
  }
}
