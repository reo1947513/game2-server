import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  PlayerState,
  PlayerInfo,
  ServerMessage,
  WorldState,
  GameEvent,
  Box,
  Vec3,
} from "./netTypes";
import { StateHistory } from "./StateHistory";
import { ServerGrenade } from "./ServerGrenade";
import { hitscan } from "./hitscan";
import { TDMLogic, KillType } from "./TDMLogic";
import { saveMatch } from "./supabase";

interface RoomPlayer {
  id: string;
  ws: WebSocket;
  isHost: boolean;
  name: string;
  state: PlayerState | null;
  hp: number; // サーバー権威のHP
  respawnAt: number; // 0=生存、>0なら復活予定時刻（ms）
  lastSeq: number; // 処理済みの入力seq
  rtt: number; // 直近のRTT（ms）
}

const FRAG_RADIUS = 6;
const FRAG_FUSE = 1.8;
const FLASH_FUSE = 1.4;
const RESPAWN_DELAY = 3000;
const RENDER_DELAY = 100; // クライアントの補間遅延ぶんも巻き戻す

// 1ルームの状態。フェーズ2では戦闘（HP・命中・グレネード）をサーバー権威で管理する。
export class Room {
  players = new Map<string, RoomPlayer>();
  hostId = "";
  private tickCount = 0;

  private history = new StateHistory();
  private projectiles: ServerGrenade[] = [];
  private pendingEvents: GameEvent[] = [];
  private colliders: Box[] = [];

  // ===== チームデスマッチ（mode === "tdm" のとき有効） =====
  private tdm: TDMLogic | null = null;
  private matchStartedAt = 0;
  private savedResult = false;

  constructor(
    public code: string,
    public maxPlayers: number,
    public mode: string,
    public stage: string
  ) {}

  add(ws: WebSocket, isHost: boolean): string {
    const id = uuidv4();
    const name = `Player${this.players.size + 1}`;
    this.players.set(id, {
      id,
      ws,
      isHost,
      name,
      state: null,
      hp: 100,
      respawnAt: 0,
      lastSeq: 0,
      rtt: 0,
    });
    if (isHost) this.hostId = id;
    return id;
  }

  remove(id: string): void {
    this.players.delete(id);
    if (id === this.hostId) {
      const first = this.players.values().next().value as RoomPlayer | undefined;
      this.hostId = first ? first.id : "";
      if (first) first.isHost = true;
    }
  }

  // クライアントが送ってきた状態を保存（HPはサーバー権威なので信用しない）。
  setState(id: string, s: PlayerState): void {
    const p = this.players.get(id);
    if (p) {
      s.playerId = id;
      p.state = s;
      p.lastSeq = s.seq ?? p.lastSeq;
    }
  }

  setRtt(id: string, rtt: number): void {
    const p = this.players.get(id);
    if (p) p.rtt = Math.max(0, Math.min(1000, rtt));
  }

  setColliders(boxes: Box[]): void {
    this.colliders = boxes;
  }

  // チームデスマッチを開始する（ホストの START_GAME 時に index から呼ぶ）。
  startTDM(now: number): void {
    this.tdm = new TDMLogic();
    this.tdm.start([...this.players.keys()], this.hostId, this.maxPlayers);
    this.matchStartedAt = now;
    this.savedResult = false;
    for (const p of this.players.values()) {
      p.hp = 100;
      p.respawnAt = 0;
    }
  }

  // ダメージ適用の一元化。HITイベントを積み、撃破時はKILL／TDMスコアと復活予約を行う。
  private applyDamage(
    attackerId: string,
    victimId: string,
    dmg: number,
    killType: KillType,
    now: number,
    headshot = false
  ): void {
    const victim = this.players.get(victimId);
    if (!victim || victim.hp <= 0) return;
    victim.hp = Math.max(0, victim.hp - dmg);
    if (this.tdm) this.tdm.recordDamage(victimId, attackerId, dmg);

    const pos = victim.state ? victim.state.position : { x: 0, y: 0, z: 0 };
    this.pendingEvents.push({
      type: "HIT",
      tick: this.tickCount,
      payload: {
        shooterId: attackerId,
        targetId: victimId,
        damage: dmg,
        headshot,
        x: pos.x,
        y: pos.y,
        z: pos.z,
      },
    });

    if (victim.hp <= 0) {
      victim.respawnAt = now + RESPAWN_DELAY;
      if (this.tdm) {
        this.tdm.onKill(attackerId, victimId, killType, now, this.pendingEvents, this.tickCount);
      } else {
        this.pendingEvents.push({
          type: "KILL",
          tick: this.tickCount,
          payload: { shooterId: attackerId, targetId: victimId },
        });
      }
    }
  }

  // 射撃の命中判定（ラグ補償あり）。
  processShot(
    shooterId: string,
    origin: Vec3,
    direction: Vec3,
    rtt: number,
    damage: number,
    now: number
  ): void {
    const shooter = this.players.get(shooterId);
    if (!shooter || shooter.hp <= 0) return;
    if (this.tdm && this.tdm.phase !== "PLAYING") return;

    const compensated = now - rtt / 2 - RENDER_DELAY;
    const snap = this.history.getAt(compensated);
    const states = snap ? snap.states : this.currentStates();

    const hit = hitscan(shooterId, origin, direction, states, this.colliders);
    if (!hit) return;

    const target = this.players.get(hit.targetId);
    if (!target || target.hp <= 0) return;

    const dmg = hit.headshot ? damage * 2 : damage;
    // 高所キル判定：射撃者の高さが3m以上なら "high"（150点）。
    const shooterY = shooter.state ? shooter.state.position.y : 0;
    const killType: KillType = shooterY >= 3 ? "high" : "normal";
    this.applyDamage(shooterId, target.id, dmg, killType, now, hit.headshot);
  }

  // 近接攻撃の命中判定（ナイフ100／キック45）。クライアントが MELEE_HIT を送ると呼ばれる。
  processMelee(attackerId: string, kind: "knife" | "kick", now: number): void {
    const a = this.players.get(attackerId);
    if (!a || a.hp <= 0 || !a.state) return;
    if (this.tdm && this.tdm.phase !== "PLAYING") return;

    const range = kind === "knife" ? 2.5 : 2.7;
    const dmg = kind === "knife" ? 100 : 45;
    const cp = Math.cos(a.state.pitch);
    const sp = Math.sin(a.state.pitch);
    const fx = -cp * Math.sin(a.state.yaw);
    const fy = sp;
    const fz = -cp * Math.cos(a.state.yaw);
    const ax = a.state.position.x;
    const ay = a.state.position.y;
    const az = a.state.position.z;

    for (const t of this.players.values()) {
      if (t.id === attackerId || t.hp <= 0 || !t.state) continue;
      const dx = t.state.position.x - ax;
      const dy = t.state.position.y - ay;
      const dz = t.state.position.z - az;
      const horiz = Math.hypot(dx, dz);
      if (horiz > range) continue;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const dot = (dx / dist) * fx + (dy / dist) * fy + (dz / dist) * fz;
      if (dot > 0.5) this.applyDamage(attackerId, t.id, dmg, "melee", now);
    }
  }

  throwGrenade(
    ownerId: string,
    gtype: "frag" | "flash",
    origin: Vec3,
    velocity: Vec3
  ): void {
    const fuse = gtype === "frag" ? FRAG_FUSE : FLASH_FUSE;
    this.projectiles.push(
      new ServerGrenade(uuidv4(), gtype, origin, velocity, fuse, ownerId)
    );
  }

  // 毎tick（dt=0.05）：グレネード前進・起爆・復活処理 → 世界状態を返す。
  tick(dt: number, now: number): WorldState {
    // グレネード
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const g = this.projectiles[i];
      if (g.update(dt, this.colliders)) {
        this.detonate(g, now);
        this.projectiles.splice(i, 1);
      }
    }
    // 復活（HP回復のみ。位置はクライアントが自分で戻す）
    for (const p of this.players.values()) {
      if (p.hp <= 0 && p.respawnAt > 0 && now >= p.respawnAt) {
        p.hp = 100;
        p.respawnAt = 0;
        if (this.tdm) this.tdm.onRespawn(p.id);
      }
    }
    // チームデスマッチのタイマーと終了判定
    if (this.tdm) {
      this.tdm.tick(dt);
      if (this.tdm.consumeEnded()) void this.saveResult(now);
    }
    return this.buildWorldState(now);
  }

  // 試合結果を Supabase へ保存する（環境変数が無ければ supabase 側でスキップ）。
  private async saveResult(now: number): Promise<void> {
    if (!this.tdm || this.savedResult) return;
    this.savedResult = true;
    const result = this.tdm.resultData();
    const players = [...this.tdm.stats.entries()].map(([id, s]) => ({
      playerId: id,
      kills: s.kills,
      deaths: s.deaths,
      score: s.score,
    }));
    await saveMatch({
      roomCode: this.code,
      mode: this.mode,
      startedAt: new Date(this.matchStartedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      result,
      players,
    });
  }

  private detonate(g: ServerGrenade, now: number): void {
    const pos = g.position;
    if (g.type === "frag") {
      // 範囲内のプレイヤーへダメージ（投擲者は自爆ダメージ控えめ）
      for (const p of this.players.values()) {
        if (p.hp <= 0 || !p.state) continue;
        const cx = p.state.position.x;
        const cy = p.state.position.y + 1.0;
        const cz = p.state.position.z;
        const d = Math.hypot(cx - pos.x, cy - pos.y, cz - pos.z);
        if (d > FRAG_RADIUS) continue;
        const falloff = 1 - d / FRAG_RADIUS;
        const dmg =
          p.id === g.ownerId
            ? Math.round(55 * falloff)
            : Math.round(Math.max(15, 120 * falloff));
        this.applyDamage(g.ownerId, p.id, dmg, "grenade", now);
      }
      this.pendingEvents.push({
        type: "GRENADE_EXPLODE",
        tick: this.tickCount,
        payload: { x: pos.x, y: pos.y, z: pos.z, ownerId: g.ownerId },
      });
    } else {
      // フラッシュは各クライアントが視線で独立計算するため、位置だけ配る
      this.pendingEvents.push({
        type: "FLASHBANG_EXPLODE",
        tick: this.tickCount,
        payload: { x: pos.x, y: pos.y, z: pos.z },
      });
    }
  }

  private currentStates(): Map<string, PlayerState> {
    const m = new Map<string, PlayerState>();
    for (const p of this.players.values()) {
      if (p.state) m.set(p.id, p.state);
    }
    return m;
  }

  private buildWorldState(now: number): WorldState {
    this.tickCount += 1;
    const players: PlayerState[] = [];
    const lastProcessedSeq: Record<string, number> = {};
    for (const p of this.players.values()) {
      if (!p.state) continue;
      // HPはサーバー権威で上書きして配る
      players.push({ ...p.state, hp: p.hp });
      lastProcessedSeq[p.id] = p.lastSeq;
    }
    // ラグ補償用の履歴に積む
    this.history.push(this.tickCount, now, players);

    const events = this.pendingEvents;
    this.pendingEvents = [];

    let tdmShared: WorldState["tdm"];
    if (this.tdm) {
      const respawn: Record<string, number> = {};
      for (const p of this.players.values()) {
        respawn[p.id] = p.respawnAt > 0 ? Math.max(0, (p.respawnAt - now) / 1000) : 0;
      }
      tdmShared = this.tdm.shared(respawn);
    }

    return {
      tick: this.tickCount,
      timestamp: now,
      players,
      projectiles: this.projectiles.map((g) => g.toState()),
      events,
      lastProcessedSeq,
      tdm: tdmShared,
    };
  }

  isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  info(id: string): PlayerInfo | null {
    const p = this.players.get(id);
    return p ? { playerId: p.id, name: p.name, isHost: p.isHost } : null;
  }

  infos(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({
      playerId: p.id,
      name: p.name,
      isHost: p.isHost,
    }));
  }

  broadcast(msg: ServerMessage): void {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
    }
  }

  broadcastExcept(exceptId: string, msg: ServerMessage): void {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
    }
  }
}
