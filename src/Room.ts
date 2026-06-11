import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  PlayerState,
  PlayerInfo,
  ServerMessage,
  WorldState,
} from "./netTypes";

interface RoomPlayer {
  id: string;
  ws: WebSocket;
  isHost: boolean;
  name: string;
  state: PlayerState | null;
}

// 1ルームの状態。プレイヤー一覧と各自の最新状態を保持し、ブロードキャストする。
export class Room {
  players = new Map<string, RoomPlayer>();
  hostId = "";
  private tickCount = 0;

  constructor(
    public code: string,
    public maxPlayers: number,
    public mode: string,
    public stage: string
  ) {}

  // プレイヤーを追加し、割り当てたIDを返す。
  add(ws: WebSocket, isHost: boolean): string {
    const id = uuidv4();
    const name = `Player${this.players.size + 1}`;
    this.players.set(id, { id, ws, isHost, name, state: null });
    if (isHost) this.hostId = id;
    return id;
  }

  remove(id: string): void {
    this.players.delete(id);
    // ホストが抜けたら残りの先頭をホストへ繰り上げる
    if (id === this.hostId) {
      const first = this.players.values().next().value as RoomPlayer | undefined;
      this.hostId = first ? first.id : "";
      if (first) first.isHost = true;
    }
  }

  // クライアントが送ってきた最新状態を保存する（中継方式）。
  setState(id: string, s: PlayerState): void {
    const p = this.players.get(id);
    if (p) {
      s.playerId = id; // 念のため送信者IDで上書き（なりすまし防止）
      p.state = s;
    }
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

  worldState(): WorldState {
    this.tickCount += 1;
    const players = [...this.players.values()]
      .filter((p) => p.state !== null)
      .map((p) => p.state as PlayerState);
    return { tick: this.tickCount, timestamp: Date.now(), players };
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
