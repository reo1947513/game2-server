// ARENA STRIKE オンライン（フェーズ1）のクライアント/サーバー共通メッセージ・状態の型。
// クライアント側（~/game2/src/online/netTypes.ts）にも同じ内容を置いて整合させる。

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// プレイヤー1人の状態（クライアントが送り、サーバーが中継してブロードキャストする）。
export interface PlayerState {
  playerId: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  onGround: boolean;
}

// ロビーに出すプレイヤー情報。
export interface PlayerInfo {
  playerId: string;
  name: string;
  isHost: boolean;
}

// 20tick/s でブロードキャストする世界状態。
export interface WorldState {
  tick: number;
  timestamp: number;
  players: PlayerState[];
}

export type ErrorCode =
  | "ERR_ROOM_NOT_FOUND"
  | "ERR_ROOM_FULL"
  | "ERR_BAD_MESSAGE"
  | "ERR_NOT_IN_ROOM";

// ===== クライアント → サーバー =====
export type ClientMessage =
  | { type: "CREATE_ROOM"; payload: { maxPlayers: number; mode: string; stage: string } }
  | { type: "JOIN_ROOM"; payload: { roomCode: string } }
  | { type: "PLAYER_STATE"; payload: PlayerState }
  | { type: "START_GAME" }
  | { type: "LEAVE_ROOM" };

// ===== サーバー → クライアント =====
export type ServerMessage =
  | { type: "ROOM_CREATED"; payload: { roomCode: string; playerId: string; players: PlayerInfo[] } }
  | { type: "ROOM_JOINED"; payload: { roomCode: string; playerId: string; players: PlayerInfo[] } }
  | { type: "PLAYER_JOINED"; payload: PlayerInfo }
  | { type: "PLAYER_LEFT"; payload: { playerId: string } }
  | { type: "GAME_START"; payload: { mode: string; stage: string } }
  | { type: "WORLD_STATE"; payload: WorldState }
  | { type: "ERROR"; payload: { code: ErrorCode; message: string } };
