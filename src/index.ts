import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { RoomManager } from "./RoomManager";
import { ClientMessage, ServerMessage, ErrorCode } from "./netTypes";

const PORT = Number(process.env.PORT) || 8080;
const rooms = new RoomManager();

// ===== HTTP（/health）＋ WebSocket を同じポートで提供 =====
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server });

// 1接続ぶんの文脈（どのルームのどのプレイヤーか）。
interface Conn {
  ws: WebSocket;
  playerId: string | null;
  roomCode: string | null;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, code: ErrorCode, message: string): void {
  send(ws, { type: "ERROR", payload: { code, message } });
}

wss.on("connection", (ws: WebSocket) => {
  const conn: Conn = { ws, playerId: null, roomCode: null };

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      sendError(ws, "ERR_BAD_MESSAGE", "不正なメッセージです");
      return;
    }
    handle(conn, msg);
  });

  ws.on("close", () => leave(conn));
  ws.on("error", () => leave(conn));
});

function handle(conn: Conn, msg: ClientMessage): void {
  switch (msg.type) {
    case "CREATE_ROOM": {
      const { room, playerId } = rooms.create(
        msg.payload.maxPlayers,
        msg.payload.mode,
        msg.payload.stage,
        conn.ws
      );
      conn.playerId = playerId;
      conn.roomCode = room.code;
      send(conn.ws, {
        type: "ROOM_CREATED",
        payload: { roomCode: room.code, playerId, players: room.infos(), maxPlayers: room.maxPlayers },
      });
      break;
    }

    case "JOIN_ROOM": {
      const code = (msg.payload.roomCode || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendError(conn.ws, "ERR_ROOM_NOT_FOUND", "ルームが見つかりません");
        break;
      }
      if (room.isFull()) {
        sendError(conn.ws, "ERR_ROOM_FULL", "ルームが満員です");
        break;
      }
      rooms.cancelDelete(code);
      const playerId = room.add(conn.ws, false);
      conn.playerId = playerId;
      conn.roomCode = code;
      send(conn.ws, {
        type: "ROOM_JOINED",
        payload: { roomCode: code, playerId, players: room.infos(), maxPlayers: room.maxPlayers },
      });
      const info = room.info(playerId);
      if (info) room.broadcastExcept(playerId, { type: "PLAYER_JOINED", payload: info });
      break;
    }

    case "PLAYER_STATE": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      room?.setState(conn.playerId, msg.payload);
      break;
    }

    case "SET_COLLIDERS": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      // ホストのステージ形状を採用する
      if (room && room.hostId === conn.playerId) room.setColliders(msg.payload.colliders);
      break;
    }

    case "SHOT": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      room?.setRtt(conn.playerId, msg.payload.rtt);
      room?.processShot(
        conn.playerId,
        msg.payload.origin,
        msg.payload.direction,
        msg.payload.rtt,
        msg.payload.damage,
        Date.now()
      );
      break;
    }

    case "THROW_GRENADE": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      room?.throwGrenade(
        conn.playerId,
        msg.payload.gtype,
        msg.payload.origin,
        msg.payload.velocity
      );
      break;
    }

    case "MELEE_HIT": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      room?.processMelee(conn.playerId, msg.payload.kind, Date.now());
      break;
    }

    case "REVIVE": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      room?.setRevive(conn.playerId, msg.payload.active);
      break;
    }

    case "PING": {
      send(conn.ws, {
        type: "PONG",
        payload: { clientTime: msg.payload.clientTime, serverTime: Date.now() },
      });
      break;
    }

    case "START_GAME": {
      if (!conn.roomCode || !conn.playerId) break;
      const room = rooms.get(conn.roomCode);
      if (room && room.hostId === conn.playerId) {
        if (room.mode === "tdm") room.startTDM(Date.now());
        else if (room.mode === "coop") room.startCoop(Date.now());
        room.broadcast({
          type: "GAME_START",
          payload: { mode: room.mode, stage: room.stage },
        });
      }
      break;
    }

    case "LEAVE_ROOM": {
      leave(conn);
      break;
    }
  }
}

function leave(conn: Conn): void {
  if (conn.roomCode && conn.playerId) {
    const room = rooms.get(conn.roomCode);
    if (room) {
      const leftId = conn.playerId;
      room.remove(leftId);
      room.broadcast({ type: "PLAYER_LEFT", payload: { playerId: leftId } });
      if (room.isEmpty()) rooms.scheduleDelete(room.code);
    }
  }
  conn.roomCode = null;
  conn.playerId = null;
}

// ===== 20tick/s（50ms）：戦闘シミュレーションを進めて WORLD_STATE をブロードキャスト =====
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    room.broadcast({ type: "WORLD_STATE", payload: room.tick(0.05, now) });
  });
}, 50);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ARENA STRIKE relay server listening on :${PORT}`);
});
