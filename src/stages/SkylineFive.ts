import {
  Box,
  ZiplineState,
  BuildingId,
  BUILDINGS,
  buildColliders,
  buildZiplines,
  roofSpawnPoints,
} from "../netTypes";

// ROOFTOP DUEL のステージ「SKYLINE FIVE」サーバー権威定義。
// 幾何（ビル座標・屋上サイズ・ジップライン端点・コライダー）の正本は共有 rooftop.ts。
// ここではサーバー側で使う形（不変コライダー・リスポーン点・ジップライン生成）に整える。
// RooftopDuelLogic（次段）がこのモジュールを消費する。

// ステージの不変コライダー（ビル本体＋パラペット＋屋上小物）。
// クライアント（ホスト）が SET_COLLIDERS で送る集合と同一だが、サーバーも独自に保持して
// 射撃・ジップライン判定をホストに依存せず権威的に行えるようにする。
export const SKYLINE_COLLIDERS: Box[] = buildColliders();

// リスポーン候補（各棟の屋上中心）。キラーから最も遠い棟を選ぶ処理は RooftopDuelLogic 側。
export const SPAWN_POINTS: { id: BuildingId; pos: { x: number; y: number; z: number } }[] =
  roofSpawnPoints();

// 全棟ID（収縮ゾーンの抽選などに使う）。
export const BUILDING_IDS: BuildingId[] = BUILDINGS.map((b) => b.id);

// ルーム開始ごとに新しいジップライン状態を生成する（inUse/cooldown が可変のため毎回複製）。
export function createZiplines(): ZiplineState[] {
  return buildZiplines();
}
