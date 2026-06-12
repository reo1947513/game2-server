import {
  RooftopShared,
  RooftopPlayerShared,
  RooftopRule,
  ZiplineState,
  GameEvent,
  Vec3,
  BuildingId,
  BUILDINGS,
} from "./netTypes";
import { createZiplines } from "./stages/SkylineFive";
import { ZIPLINE_COOLDOWN } from "./netTypes";

// ROOFTOP DUEL のルール・スコア管理。デスマッチ（個人戦FFA）とサバイバル（ラウンド制・
// 収縮ゾーン・脱落）の両ルールを扱う。ダメージ適用は Room が行い、撃破時に onKill を呼ぶ。

export interface RooftopKillOpts {
  headshot: boolean;
  melee: boolean;
}

interface RPStat {
  kills: number;
  deaths: number;
  score: number;
  headshots: number; // Supabase 用（Phase 5）
  roundWins: number; // サバイバルのラウンド勝利数
  onZipline: string | null; // 搭乗中のジップラインID
  ziplineStart: number; // 搭乗開始時刻（ms）
  ziplineEnd: number; // 搭乗終了予定時刻（ms）
  invulnUntil: number; // 無敵終了時刻（ms。デスマッチのリスポーン直後2秒）
}

function newStat(): RPStat {
  return {
    kills: 0,
    deaths: 0,
    score: 0,
    headshots: 0,
    roundWins: 0,
    onZipline: null,
    ziplineStart: 0,
    ziplineEnd: 0,
    invulnUntil: 0,
  };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// サバイバルの収縮ゾーン：ラウンド開始からの経過秒で危険化する棟を増やす。
const SHRINK_AT = [90, 120, 150]; // 秒
const DANGER_DPS = 8; // 危険ゾーンの毎秒ダメージ
const ROUND_SECONDS = 180; // 1ラウンド3分
const DEATHMATCH_SECONDS = 480; // デスマッチ8分
const ROUNDS_TO_WIN = 3;

export class RooftopDuelLogic {
  rule: RooftopRule = "deathmatch";
  phase: "PLAYING" | "RESULT" = "PLAYING";
  timeRemaining = DEATHMATCH_SECONDS; // デスマッチ=試合残り / サバイバル=ラウンド残り
  killLimit = 10;
  round = 1;
  dangerZones: BuildingId[] = [];
  ziplines: ZiplineState[] = [];
  stats = new Map<string, RPStat>();
  winnerId?: string;

  private lastKillAt = new Map<string, number>();
  private endedFlag = false;
  private roundElapsed = 0; // サバイバル：ラウンド開始からの経過秒
  private shrinkDone = 0; // 適用済みの収縮段階数
  private pendingRestart = false; // 次ラウンド開始（Roomが全員蘇生）の予約

  // 開始時に統計・ジップライン・ルール別パラメータを初期化する。
  start(playerIds: string[], maxPlayers: number, rule: RooftopRule): void {
    this.rule = rule;
    this.phase = "PLAYING";
    this.winnerId = undefined;
    this.endedFlag = false;
    this.round = 1;
    this.dangerZones = [];
    this.roundElapsed = 0;
    this.shrinkDone = 0;
    this.pendingRestart = false;
    this.killLimit = maxPlayers <= 2 ? 10 : maxPlayers <= 4 ? 15 : 20;
    this.timeRemaining = rule === "survival" ? ROUND_SECONDS : DEATHMATCH_SECONDS;
    this.ziplines = createZiplines();
    this.stats.clear();
    this.lastKillAt.clear();
    for (const id of playerIds) this.stats.set(id, newStat());
  }

  ensureMember(id: string): void {
    if (!this.stats.has(id)) this.stats.set(id, newStat());
  }

  isOnZipline(id: string): boolean {
    return !!this.stats.get(id)?.onZipline;
  }

  isInvulnerable(id: string, now: number): boolean {
    const st = this.stats.get(id);
    return !!st && now < st.invulnUntil;
  }

  // 指定座標が乗っている棟ID（屋上フットプリント内）。どこにも乗っていなければ null。
  buildingAt(pos: Vec3): BuildingId | null {
    for (const b of BUILDINGS) {
      if (
        Math.abs(pos.x - b.cx) <= b.sizeX / 2 &&
        Math.abs(pos.z - b.cz) <= b.sizeZ / 2
      ) {
        return b.id;
      }
    }
    return null;
  }

  // 危険ゾーンの毎秒ダメージ（Roomが座標→棟を判定して使う）。
  dangerDps(): number {
    return DANGER_DPS;
  }

  // ジップライン乗り込み要求。空き＆クールダウン0＆起点付近なら承認して inUse をロックする。
  useZipline(playerId: string, ziplineId: string, playerPos: Vec3, now: number): boolean {
    if (this.phase !== "PLAYING") return false;
    const st = this.stats.get(playerId);
    if (!st || st.onZipline) return false;
    const z = this.ziplines.find((x) => x.id === ziplineId);
    if (!z || z.inUse || z.cooldown > 0) return false;
    if (dist(playerPos, z.from) > 3) return false;
    z.inUse = playerId;
    st.onZipline = ziplineId;
    st.ziplineStart = now;
    st.ziplineEnd = now + (z.length / z.speed) * 1000;
    return true;
  }

  // 撃破処理。スコア加算・連続キル。デスマッチはキル上限で終了判定。
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
      let points = 100;
      if (opts.melee) {
        points = 300;
      } else if (opts.headshot) {
        points = 200;
        st.headshots += 1;
      }
      const shooterMoving = !!st.onZipline;
      const victimMoving = !!this.stats.get(victimId)?.onZipline;
      if (victimMoving) points = Math.max(points, 180);
      else if (shooterMoving) points = Math.max(points, 150);

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

    // デスマッチのみキル上限で終了。サバイバルは脱落で決まる（tickSurvivalで判定）。
    if (this.rule === "deathmatch" && st && st.kills >= this.killLimit) this.endMatch();
  }

  // デスマッチ：リスポーン時に無敵（2秒）を付与する。
  onRespawn(id: string, now: number): void {
    const st = this.stats.get(id);
    if (st) st.invulnUntil = now + 2000;
  }

  // 毎tick。aliveIds はサバイバルのラウンド終了判定に使う（Roomが生存者IDを渡す）。
  tick(dt: number, now: number, aliveIds: string[]): void {
    if (this.phase !== "PLAYING") return;

    // ジップラインのクールダウン消化と搭乗の終了解放（両ルール共通）。
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

    this.timeRemaining -= dt;

    if (this.rule === "survival") {
      this.tickSurvival(aliveIds);
    } else if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.endMatch();
    }
  }

  private tickSurvival(aliveIds: string[]): void {
    this.roundElapsed += 0; // roundElapsed は timeRemaining から導出（下で更新）
    this.roundElapsed = ROUND_SECONDS - this.timeRemaining;

    // 収縮ゾーン：所定秒を越えるたびに安全な棟を1つ危険化（最大3棟、2棟は安全に残す）。
    while (this.shrinkDone < SHRINK_AT.length && this.roundElapsed >= SHRINK_AT[this.shrinkDone]) {
      const safe = BUILDINGS.map((b) => b.id).filter((id) => !this.dangerZones.includes(id));
      if (safe.length > 2) {
        const pick = safe[Math.floor(Math.random() * safe.length)];
        this.dangerZones.push(pick);
      }
      this.shrinkDone += 1;
    }

    // ラウンド終了判定：生存者1人以下、または時間切れ。
    const timeUp = this.timeRemaining <= 0;
    if (aliveIds.length <= 1 || timeUp) {
      this.timeRemaining = Math.max(0, this.timeRemaining);
      if (aliveIds.length === 1) {
        const winner = aliveIds[0];
        const st = this.stats.get(winner);
        if (st) st.roundWins += 1;
        if (st && st.roundWins >= ROUNDS_TO_WIN) {
          this.winnerId = winner;
          this.endMatch();
          return;
        }
      }
      // それ以外（0人＝相打ち / 時間切れで複数生存）は引き分け扱い。マッチ未確定なら次ラウンドへ。
      this.round += 1;
      this.beginNextRound();
    }
  }

  // 次ラウンドの準備（Roomが consumeRoundRestart() を見て全員を蘇生・再配置する）。
  private beginNextRound(): void {
    this.timeRemaining = ROUND_SECONDS;
    this.roundElapsed = 0;
    this.shrinkDone = 0;
    this.dangerZones = [];
    this.ziplines = createZiplines();
    this.pendingRestart = true;
  }

  // Room が呼ぶ：次ラウンド開始の予約があれば true（消費）。Room は全員 hp=100 に戻す。
  consumeRoundRestart(): boolean {
    if (this.pendingRestart) {
      this.pendingRestart = false;
      return true;
    }
    return false;
  }

  private endMatch(): void {
    this.phase = "RESULT";
    this.endedFlag = true;
    if (!this.winnerId) {
      // 最高スコア（デスマッチ）／最多ラウンド勝利（サバイバル）を勝者に。
      let best = -1;
      let winner: string | undefined;
      for (const [id, s] of this.stats) {
        const metric = this.rule === "survival" ? s.roundWins : s.score;
        if (metric > best) {
          best = metric;
          winner = id;
        }
      }
      this.winnerId = winner;
    }
  }

  consumeEnded(): boolean {
    if (this.endedFlag) {
      this.endedFlag = false;
      return true;
    }
    return false;
  }

  shared(now: number, alive: Record<string, { alive: boolean; respawn: number }>): RooftopShared {
    const aliveList = [...this.stats.keys()].filter((id) => (alive[id]?.alive ?? true));
    const firstAlive = aliveList[0] ?? null;
    const players: RooftopPlayerShared[] = [...this.stats.entries()].map(([id, s]) => {
      const a = alive[id] ?? { alive: true, respawn: 0 };
      let progress = 0;
      if (s.onZipline && s.ziplineEnd > s.ziplineStart) {
        progress = Math.max(0, Math.min(1, (now - s.ziplineStart) / (s.ziplineEnd - s.ziplineStart)));
      }
      // サバイバルで脱落した者は生存者を観戦する。
      const spectatingId = this.rule === "survival" && !a.alive ? firstAlive : null;
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
        spectatingId,
        roundWins: s.roundWins,
      };
    });
    return {
      rule: this.rule,
      phase: this.phase,
      timeRemaining: Math.ceil(this.timeRemaining),
      round: this.round,
      killLimit: this.killLimit,
      dangerZones: [...this.dangerZones],
      ziplines: this.ziplines,
      players,
      winnerId: this.winnerId,
    };
  }

  resultData(): Record<string, unknown> {
    const players: Array<Record<string, unknown>> = [];
    for (const [id, s] of this.stats) {
      players.push({
        playerId: id,
        kills: s.kills,
        deaths: s.deaths,
        score: s.score,
        headshots: s.headshots,
        roundWins: s.roundWins,
      });
    }
    return { rule: this.rule, killLimit: this.killLimit, winnerId: this.winnerId, players };
  }
}
