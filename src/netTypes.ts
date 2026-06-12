// ARENA STRIKE オンライン（フェーズ1）のクライアント/サーバー共通メッセージ・状態の型。
// クライアント側（~/game2/src/online/netTypes.ts）にも同じ内容を置いて整合させる。

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// プレイヤー1人の状態（クライアントが送り、サーバーが中継してブロードキャストする）。
// hp はフェーズ2でサーバー権威となり、サーバーが上書きして配る。
export interface PlayerState {
  playerId: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  onGround: boolean;
  seq: number; // クライアントの入力シーケンス番号（lastProcessedSeq用）
}

// サーバー権威で物理計算するグレネードの飛行状態。
export interface ProjectileState {
  id: string;
  type: "frag" | "flash";
  position: Vec3;
  velocity: Vec3;
  fuse: number;
}

// 命中・撃破・爆発などの単発イベント。
export interface GameEvent {
  type: "HIT" | "KILL" | "GRENADE_EXPLODE" | "FLASHBANG_EXPLODE";
  payload: Record<string, unknown>;
  tick: number;
}

// ステージの当たり判定箱（ホストが開始時に送る）。
export interface Box {
  min: Vec3;
  max: Vec3;
}

export type Team = "RED" | "BLUE";

// チームデスマッチの共有状態（WorldStateに同梱して全クライアントへ配る）。
export interface TDMShared {
  phase: "PLAYING" | "RESULT";
  timeRemaining: number; // 秒
  scores: { RED: number; BLUE: number };
  kills: { RED: number; BLUE: number };
  killLimit: number;
  teams: Record<string, Team>; // playerId → チーム
  respawn: Record<string, number>; // playerId → 復活までの残り秒（0=生存）
  winner?: Team | "DRAW";
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
  projectiles: ProjectileState[]; // サーバー権威のグレネード飛行状態
  events: GameEvent[]; // このtickで発生した単発イベント
  lastProcessedSeq: Record<string, number>; // プレイヤーごとの処理済みseq
  tdm?: TDMShared; // チームデスマッチ時のみ
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
  | { type: "LEAVE_ROOM" }
  // フェーズ2：戦闘
  | { type: "SET_COLLIDERS"; payload: { colliders: Box[] } } // ホストがステージの当たり判定を送る
  | { type: "SHOT"; payload: { origin: Vec3; direction: Vec3; seq: number; rtt: number; damage: number } }
  | { type: "THROW_GRENADE"; payload: { gtype: "frag" | "flash"; origin: Vec3; velocity: Vec3 } }
  | { type: "MELEE_HIT"; payload: { kind: "knife" | "kick" } }
  | { type: "PING"; payload: { clientTime: number } };

// ===== サーバー → クライアント =====
export type ServerMessage =
  | { type: "ROOM_CREATED"; payload: { roomCode: string; playerId: string; players: PlayerInfo[]; maxPlayers: number } }
  | { type: "ROOM_JOINED"; payload: { roomCode: string; playerId: string; players: PlayerInfo[]; maxPlayers: number } }
  | { type: "PLAYER_JOINED"; payload: PlayerInfo }
  | { type: "PLAYER_LEFT"; payload: { playerId: string } }
  | { type: "GAME_START"; payload: { mode: string; stage: string } }
  | { type: "WORLD_STATE"; payload: WorldState }
  | { type: "PONG"; payload: { clientTime: number; serverTime: number } }
  | { type: "ERROR"; payload: { code: ErrorCode; message: string } };
