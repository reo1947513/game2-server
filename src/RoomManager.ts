import { WebSocket } from "ws";
import { Room } from "./Room";

// ルームの作成・取得・空室の自動削除を管理する。
export class RoomManager {
  private rooms = new Map<string, Room>();
  private deleteTimers = new Map<string, NodeJS.Timeout>();

  // 紛らわしい文字（I, O, 0, 1）を除いた英大文字＋数字。
  private readonly ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  create(
    maxPlayers: number,
    mode: string,
    stage: string,
    ws: WebSocket
  ): { room: Room; playerId: string } {
    const code = this.genCode();
    const room = new Room(code, maxPlayers > 0 ? maxPlayers : 2, mode, stage);
    const playerId = room.add(ws, true);
    this.rooms.set(code, room);
    return { room, playerId };
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  forEach(fn: (room: Room) => void): void {
    this.rooms.forEach(fn);
  }

  // 入室などでルームが空でなくなったとき、予約済みの削除を取り消す。
  cancelDelete(code: string): void {
    const t = this.deleteTimers.get(code);
    if (t) {
      clearTimeout(t);
      this.deleteTimers.delete(code);
    }
  }

  // 最後のプレイヤーが退室したら60秒後に削除する。
  scheduleDelete(code: string): void {
    this.cancelDelete(code);
    const t = setTimeout(() => {
      const room = this.rooms.get(code);
      if (room && room.isEmpty()) this.rooms.delete(code);
      this.deleteTimers.delete(code);
    }, 60_000);
    this.deleteTimers.set(code, t);
  }

  private genCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let c = "";
      for (let i = 0; i < 6; i++) {
        c += this.ALPHABET[Math.floor(Math.random() * this.ALPHABET.length)];
      }
      if (!this.rooms.has(c)) return c;
    }
    // 万一ぶつかり続けたら時刻ベースで代替
    return ("R" + Date.now().toString(36).toUpperCase()).slice(-6);
  }
}
