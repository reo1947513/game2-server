import {
  PlayerState,
  Vec3,
  Box,
  EnemyType,
  ServerEnemyState,
  CoopShared,
  CoopStatus,
  GameEvent,
} from "./netTypes";
import { rayBox } from "./hitscan";

// Room の RoomPlayer はこの形を構造的に満たす（hp はここで書き換える）。
export interface CoopActor {
  id: string;
  hp: number;
  state: PlayerState | null;
}

interface Enemy {
  id: string;
  etype: EnemyType;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  speed: number;
  touch: number; // 接触ダメージ
  half: number; // 当たり判定の半径（XZ）
  height: number; // 当たり判定の高さ
  attackCd: number; // 接触ダメージのクールダウン
  currentTarget: string | null; // 追跡中のプレイヤーID
  flashedBy: string | null; // フラッシュを当てた投擲者ID
  flashedUntil: number; // フラッシュ有効期限（epoch ms）
}

interface CoopStat {
  status: CoopStatus;
  downTimer: number;
  reviveProgress: number;
  score: number;
}

const BASE: Record<EnemyType, { hp: number; speed: number; touch: number; half: number; height: number; pts: number }> = {
  grunt: { hp: 60, speed: 3.0, touch: 12, half: 0.45, height: 1.8, pts: 100 },
  fast: { hp: 45, speed: 4.2, touch: 10, half: 0.4, height: 1.7, pts: 120 },
  boss: { hp: 480, speed: 3.6, touch: 26, half: 0.9, height: 2.6, pts: 1000 },
};

const SPAWN_RADIUS = 16;
const REST_SECONDS = 10;
const ATTACK_CD = 0.6;
const FINISH_SECONDS = 5;
const REVIVE_SECONDS = 5;
const REVIVE_RANGE = 1.5;
const CLEAR_BONUS = 1000;
const REVIVE_BONUS = 500;

// コープ・ガントレットのサーバー権威ロジック。
// 敵の移動・接触ダメージ・Wave進行・ダウン/蘇生・敵への被弾を管理する。
export class CoopLogic {
  phase: "WAVE" | "REST" | "RESULT" = "WAVE";
  currentWave = 1;
  restCountdown = 0;
  totalScore = 0;
  wipe = false;

  private enemies: Enemy[] = [];
  private stats = new Map<string, CoopStat>();
  private reviveIntent = new Map<string, boolean>();
  private enemyCounter = 0;
  private endedFlag = false;
  private events: GameEvent[] = []; // HIT/COOP_BONUS など、Roomが毎tickで取り込む

  // Roomがこのtickで溜まったイベントを取り出す。
  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  start(actors: Map<string, CoopActor>): void {
    this.phase = "WAVE";
    this.currentWave = 1;
    this.restCountdown = 0;
    this.totalScore = 0;
    this.wipe = false;
    this.endedFlag = false;
    this.enemies = [];
    this.stats.clear();
    this.reviveIntent.clear();
    for (const a of actors.values()) {
      this.stats.set(a.id, { status: "ALIVE", downTimer: 0, reviveProgress: 0, score: 0 });
      a.hp = 100;
    }
    this.spawnWave(1, actors);
  }

  setRevive(id: string, active: boolean): void {
    this.reviveIntent.set(id, active);
  }

  // ===== 毎tick =====
  tick(dt: number, actors: Map<string, CoopActor>, _colliders: Box[]): void {
    if (this.phase === "RESULT") return;

    // 新規参加者がいればALIVEで登録（基本は固定ロスター）
    for (const a of actors.values()) {
      if (!this.stats.has(a.id)) {
        this.stats.set(a.id, { status: "ALIVE", downTimer: 0, reviveProgress: 0, score: 0 });
      }
    }

    if (this.phase === "REST") {
      this.handleRevive(dt, actors);
      this.restCountdown -= dt;
      if (this.restCountdown <= 0) {
        this.currentWave += 1;
        this.spawnWave(this.currentWave, actors);
        this.phase = "WAVE";
      }
      this.checkWipe(actors);
      return;
    }

    // ----- WAVE -----
    const alive = this.alivePlayers(actors);

    // 敵の移動と接触ダメージ
    for (const e of this.enemies) {
      e.attackCd = Math.max(0, e.attackCd - dt);
      const target = this.nearest(e, alive);
      e.currentTarget = target ? target.id : null;
      if (target && target.state) {
        const tx = target.state.position.x;
        const ty = target.state.position.y;
        const tz = target.state.position.z;
        const dx = tx - e.x;
        const dz = tz - e.z;
        const horiz = Math.hypot(dx, dz);
        const contact = e.half + 1.0;
        if (horiz > contact) {
          const inv = 1 / (horiz || 1);
          e.x += dx * inv * e.speed * dt;
          e.z += dz * inv * e.speed * dt;
        }
        e.y += (ty - e.y) * Math.min(1, dt * 4);
        if (horiz <= contact && e.attackCd <= 0) {
          this.hurtPlayer(target);
          e.attackCd = ATTACK_CD;
        }
      }
    }

    // ダウン中プレイヤーのフィニッシュ判定（敵が近くにいると進む）
    for (const a of actors.values()) {
      const st = this.stats.get(a.id);
      if (!st || st.status !== "DOWN" || !a.state) continue;
      let threatened = false;
      for (const e of this.enemies) {
        const d = Math.hypot(a.state.position.x - e.x, a.state.position.z - e.z);
        if (d <= e.half + 1.2) {
          threatened = true;
          // ダウン中の味方に張り付いている敵として記録（フォローキル判定用）
          e.currentTarget = a.id;
        }
      }
      if (threatened) {
        st.downTimer += dt;
        if (st.downTimer >= FINISH_SECONDS) {
          st.status = "DEAD";
          st.downTimer = FINISH_SECONDS;
        }
      }
    }

    this.handleRevive(dt, actors);

    // Waveクリア判定
    if (this.enemies.length === 0) {
      const allAlive = [...this.stats.values()].every((s) => s.status === "ALIVE");
      if (allAlive) this.totalScore += CLEAR_BONUS;
      this.phase = "REST";
      this.restCountdown = REST_SECONDS;
    }

    this.checkWipe(actors);
  }

  private hurtPlayer(a: CoopActor): void {
    const st = this.stats.get(a.id);
    if (!st || st.status !== "ALIVE") return;
    a.hp = Math.max(0, a.hp - this.enemyTouch(a));
    if (a.hp <= 0) {
      st.status = "DOWN";
      st.downTimer = 0;
      st.reviveProgress = 0;
    }
  }

  // 直近に接触した敵の威力を引くため、最寄り敵のtouchを使う（簡易）。
  private enemyTouch(a: CoopActor): number {
    if (!a.state) return 12;
    let best = 12;
    let bestD = Infinity;
    for (const e of this.enemies) {
      const d = Math.hypot(a.state.position.x - e.x, a.state.position.z - e.z);
      if (d < bestD) {
        bestD = d;
        best = e.touch;
      }
    }
    return best;
  }

  private handleRevive(dt: number, actors: Map<string, CoopActor>): void {
    const progressed = new Set<string>();
    for (const reviver of actors.values()) {
      const rst = this.stats.get(reviver.id);
      if (!rst || rst.status !== "ALIVE" || !reviver.state) continue;
      if (!this.reviveIntent.get(reviver.id)) continue;
      // 最寄りのダウン中の味方
      let target: CoopActor | null = null;
      let bestD = REVIVE_RANGE;
      for (const a of actors.values()) {
        if (a.id === reviver.id) continue;
        const st = this.stats.get(a.id);
        if (!st || st.status !== "DOWN" || !a.state) continue;
        const d = Math.hypot(
          a.state.position.x - reviver.state.position.x,
          a.state.position.z - reviver.state.position.z
        );
        if (d <= bestD) {
          bestD = d;
          target = a;
        }
      }
      if (target) {
        const st = this.stats.get(target.id)!;
        st.reviveProgress += dt;
        progressed.add(target.id);
        if (st.reviveProgress >= REVIVE_SECONDS) {
          st.status = "ALIVE";
          st.reviveProgress = 0;
          st.downTimer = 0;
          target.hp = 30;
          rst.score += REVIVE_BONUS;
          this.totalScore += REVIVE_BONUS;
        }
      }
    }
    // 蘇生されていないダウン者は進行を巻き戻す
    for (const [id, st] of this.stats) {
      if (st.status === "DOWN" && !progressed.has(id)) {
        st.reviveProgress = Math.max(0, st.reviveProgress - dt * 2);
      }
    }
  }

  private checkWipe(actors: Map<string, CoopActor>): void {
    if (this.phase === "RESULT") return;
    let aliveCount = 0;
    for (const a of actors.values()) {
      const st = this.stats.get(a.id);
      if (st && st.status === "ALIVE") aliveCount++;
    }
    if (actors.size > 0 && aliveCount === 0) {
      this.phase = "RESULT";
      this.wipe = true;
      this.endedFlag = true;
    }
  }

  // ===== 敵へのダメージ（射撃・近接・グレネード） =====
  damageEnemyShot(
    origin: Vec3,
    dir: Vec3,
    colliders: Box[],
    damage: number,
    attackerId: string,
    now: number
  ): void {
    if (this.phase !== "WAVE") return;
    // 壁までの距離
    let wallT = Infinity;
    for (const b of colliders) {
      const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b.min, b.max);
      if (t !== null && t < wallT) wallT = t;
    }
    let hit: Enemy | null = null;
    let hitT = wallT;
    for (const e of this.enemies) {
      const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, this.minOf(e), this.maxOf(e));
      if (t !== null && t < hitT) {
        hitT = t;
        hit = e;
      }
    }
    if (!hit) return;
    this.events.push({
      type: "HIT",
      tick: 0,
      payload: { shooterId: attackerId, targetId: hit.id, damage, x: hit.x, y: hit.y, z: hit.z },
    });
    hit.hp -= damage;
    if (hit.hp <= 0) this.killEnemy(hit, attackerId, now);
  }

  meleeEnemies(
    pos: Vec3,
    yaw: number,
    pitch: number,
    range: number,
    damage: number,
    attackerId: string,
    now: number
  ): void {
    if (this.phase !== "WAVE") return;
    const cp = Math.cos(pitch);
    const fx = -cp * Math.sin(yaw);
    const fz = -cp * Math.cos(yaw);
    for (const e of [...this.enemies]) {
      const dx = e.x - pos.x;
      const dz = e.z - pos.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz > range + e.half) continue;
      const inv = 1 / (horiz || 1);
      const dot = dx * inv * fx + dz * inv * fz;
      if (dot > 0.4) {
        e.hp -= damage;
        if (e.hp <= 0) this.killEnemy(e, attackerId, now);
      }
    }
  }

  grenadeEnemies(pos: Vec3, radius: number, ownerId: string, now: number): void {
    if (this.phase !== "WAVE") return;
    for (const e of [...this.enemies]) {
      const d = Math.hypot(e.x - pos.x, e.y + e.height * 0.5 - pos.y, e.z - pos.z);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      e.hp -= Math.round(Math.max(20, 160 * falloff));
      if (e.hp <= 0) this.killEnemy(e, ownerId, now);
    }
  }

  // フラッシュ起爆：範囲内の敵に「怯み」状態を付与する（フラッシュアシスト判定用）。
  flashEnemies(pos: Vec3, radius: number, flasherId: string, now: number): void {
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - pos.x, e.y + e.height * 0.5 - pos.y, e.z - pos.z);
      if (d > radius) continue;
      e.flashedBy = flasherId;
      e.flashedUntil = now + 1500;
    }
  }

  private award(playerId: string, pts: number): void {
    const st = this.stats.get(playerId);
    if (st) st.score += pts;
    this.totalScore += pts;
  }

  private pushBonus(playerId: string, kind: "FOLLOW_KILL" | "FLASH_ASSIST", points: number): void {
    this.events.push({ type: "COOP_BONUS", tick: 0, payload: { playerId, kind, points } });
  }

  private killEnemy(e: Enemy, killerId: string, now: number): void {
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);

    // 基本撃破点
    this.award(killerId, BASE[e.etype].pts);

    // フォローキル：ダウン中の味方に張り付いていた敵を、別プレイヤーが倒した
    if (e.currentTarget && e.currentTarget !== killerId) {
      const tgt = this.stats.get(e.currentTarget);
      if (tgt && tgt.status === "DOWN") {
        this.award(killerId, 300);
        this.pushBonus(killerId, "FOLLOW_KILL", 300);
      }
    }

    // フラッシュアシスト：フラッシュ有効中の敵を、投擲者以外が倒した
    if (e.flashedBy && now < e.flashedUntil && e.flashedBy !== killerId) {
      this.award(e.flashedBy, 150);
      this.pushBonus(e.flashedBy, "FLASH_ASSIST", 150);
    }
  }

  // ===== Waveスポーン =====
  private spawnWave(n: number, actors: Map<string, CoopActor>): void {
    const comp = this.composition(n);
    const c = this.centroid(actors);
    this.enemies = [];
    const total = comp.length;
    for (let i = 0; i < total; i++) {
      const ang = (i / total) * Math.PI * 2;
      const ex = c.x + Math.cos(ang) * SPAWN_RADIUS;
      const ez = c.z + Math.sin(ang) * SPAWN_RADIUS;
      this.enemies.push(this.makeEnemy(comp[i], ex, c.y, ez, n));
    }
  }

  private composition(n: number): EnemyType[] {
    if (n === 1) return Array<EnemyType>(6).fill("grunt");
    if (n === 2) return [...Array<EnemyType>(6).fill("grunt"), "fast", "fast"];
    if (n === 3) return Array<EnemyType>(10).fill("grunt");
    if (n === 4) return ["boss", ...Array<EnemyType>(4).fill("grunt")];
    const grunts = 4 + (n - 4);
    const fasts = n - 4;
    return ["boss", ...Array<EnemyType>(grunts).fill("grunt"), ...Array<EnemyType>(fasts).fill("fast")];
  }

  private makeEnemy(etype: EnemyType, x: number, y: number, z: number, wave: number): Enemy {
    const b = BASE[etype];
    let hp = b.hp;
    let speed = b.speed;
    if (etype === "boss" && wave >= 5) {
      hp = Math.round(b.hp * (1 + 0.5 * (wave - 4)));
      speed = b.speed + 0.1 * (wave - 4);
    }
    return {
      id: `e${this.enemyCounter++}`,
      etype,
      x,
      y,
      z,
      hp,
      maxHp: hp,
      speed,
      touch: b.touch,
      half: b.half,
      height: b.height,
      attackCd: 0,
      currentTarget: null,
      flashedBy: null,
      flashedUntil: 0,
    };
  }

  private minOf(e: Enemy): Vec3 {
    return { x: e.x - e.half, y: e.y, z: e.z - e.half };
  }
  private maxOf(e: Enemy): Vec3 {
    return { x: e.x + e.half, y: e.y + e.height, z: e.z + e.half };
  }

  private alivePlayers(actors: Map<string, CoopActor>): CoopActor[] {
    const list: CoopActor[] = [];
    for (const a of actors.values()) {
      const st = this.stats.get(a.id);
      if (st && st.status === "ALIVE" && a.state) list.push(a);
    }
    return list;
  }

  private nearest(e: Enemy, players: CoopActor[]): CoopActor | null {
    let best: CoopActor | null = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!p.state) continue;
      const d = Math.hypot(p.state.position.x - e.x, p.state.position.z - e.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private centroid(actors: Map<string, CoopActor>): Vec3 {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (const a of actors.values()) {
      if (a.state) {
        sx += a.state.position.x;
        sy += a.state.position.y;
        sz += a.state.position.z;
        n++;
      }
    }
    if (n === 0) return { x: 0, y: 0, z: 0 };
    return { x: sx / n, y: sy / n, z: sz / n };
  }

  consumeEnded(): boolean {
    if (this.endedFlag) {
      this.endedFlag = false;
      return true;
    }
    return false;
  }

  shared(actors: Map<string, CoopActor>): CoopShared {
    const enemies: ServerEnemyState[] = this.enemies.map((e) => ({
      id: e.id,
      etype: e.etype,
      position: { x: e.x, y: e.y, z: e.z },
      hp: e.hp,
      maxHp: e.maxHp,
      currentTarget: e.currentTarget,
      flashedBy: e.flashedBy,
      flashedUntil: e.flashedUntil,
    }));
    const players = [...actors.values()].map((a) => {
      const st = this.stats.get(a.id) ?? { status: "ALIVE" as CoopStatus, downTimer: 0, reviveProgress: 0, score: 0 };
      return {
        playerId: a.id,
        status: st.status,
        hp: a.hp,
        downTimer: st.downTimer,
        reviveProgress: st.reviveProgress,
        score: st.score,
      };
    });
    return {
      phase: this.phase,
      currentWave: this.currentWave,
      restCountdown: Math.max(0, Math.ceil(this.restCountdown)),
      enemiesRemaining: this.enemies.length,
      enemies,
      players,
      totalScore: this.totalScore,
      wipe: this.phase === "RESULT" ? this.wipe : undefined,
    };
  }

  resultData(): Record<string, unknown> {
    const players = [...this.stats.entries()].map(([id, s]) => ({
      playerId: id,
      status: s.status,
      score: s.score,
    }));
    return {
      wave: this.currentWave,
      totalScore: this.totalScore,
      wipe: this.wipe,
      players,
    };
  }

  // Supabase保存用のプレイヤー集計（kills/deathsは概念が異なるため0/最高Waveで埋める）。
  playerSummaries(): Array<{ playerId: string; kills: number; deaths: number; score: number; coopWave: number }> {
    return [...this.stats.entries()].map(([id, s]) => ({
      playerId: id,
      kills: 0,
      deaths: s.status === "DEAD" ? 1 : 0,
      score: s.score,
      coopWave: this.currentWave,
    }));
  }
}
