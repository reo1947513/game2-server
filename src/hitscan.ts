import { Vec3, Box, PlayerState } from "./netTypes";

// プレイヤーの当たり判定（足元中心の位置から作るAABB）。
// 胴と頭を分け、頭に当たればヘッドショット（×2）。
const BODY_HALF = 0.42;
const BODY_TOP = 1.7;
const HEAD_MIN = 1.5;
const HEAD_MAX = 1.95;
const HEAD_HALF = 0.3;

// レイ（origin, dir）とAABBの交差距離（入口t）を返す。交差しなければ null。
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: Vec3,
  max: Vec3
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [min.x, min.y, min.z];
  const mx = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null; // 背後
  return tmin >= 0 ? tmin : tmax;
}

export interface HitResult {
  targetId: string;
  distance: number;
  headshot: boolean;
}

// ラグ補償済みスナップショットに対する hitscan。射撃者以外の最も近い被弾者を返す。
// 壁（colliders）に遮られる場合は命中なし（ウォールオクルージョン）。
export function hitscan(
  shooterId: string,
  origin: Vec3,
  dir: Vec3,
  players: Map<string, PlayerState>,
  colliders: Box[]
): HitResult | null {
  // まず壁までの最短距離を求める（遮蔽判定の基準）
  let wallDist = Infinity;
  for (const c of colliders) {
    const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c.min, c.max);
    if (t !== null && t < wallDist) wallDist = t;
  }

  let best: HitResult | null = null;
  for (const p of players.values()) {
    if (p.playerId === shooterId) continue;
    const px = p.position.x;
    const py = p.position.y;
    const pz = p.position.z;

    // 頭
    const headT = rayBox(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      { x: px - HEAD_HALF, y: py + HEAD_MIN, z: pz - HEAD_HALF },
      { x: px + HEAD_HALF, y: py + HEAD_MAX, z: pz + HEAD_HALF }
    );
    // 胴
    const bodyT = rayBox(
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      { x: px - BODY_HALF, y: py, z: pz - BODY_HALF },
      { x: px + BODY_HALF, y: py + BODY_TOP, z: pz + BODY_HALF }
    );

    let t: number | null = null;
    let head = false;
    if (headT !== null && (bodyT === null || headT <= bodyT)) {
      t = headT;
      head = true;
    } else if (bodyT !== null) {
      t = bodyT;
      head = false;
    }
    if (t === null) continue;
    if (t > wallDist) continue; // 壁の向こう＝遮蔽

    if (!best || t < best.distance) {
      best = { targetId: p.playerId, distance: t, headshot: head };
    }
  }
  return best;
}
