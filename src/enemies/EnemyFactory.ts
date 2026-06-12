import { EnemyType } from "../netTypes";

// ===== タワーモードの通常敵6種（サーバー権威）=====
// 既存 CoopLogic の BASE テーブル方式に揃えた、敵種別ごとの権威パラメータと生成関数。
// 数値はオフライン版 TowerMode.ts の ENEMY_CONFIG を正本として移植している。
// AI の毎フレーム処理は TowerLogic（フロア進行ロジック）から本モジュールの
// 純粋ヘルパーを呼び出して実行する。ここには「状態」と「1体ぶんの判断」だけを置く。

// タワーで湧く通常敵の種別（共有 EnemyType のうちタワー雑魚6種）。ボスは別管理。
export type TowerEnemyType =
  | "standard"
  | "fast"
  | "tank"
  | "ranged"
  | "exploder"
  | "summoner";

// ENEMY_RATIO の比率配列はこの並び順に対応する。
export const TYPE_ORDER: TowerEnemyType[] = [
  "standard",
  "fast",
  "tank",
  "ranged",
  "exploder",
  "summoner",
];

interface TowerBase {
  hp: number;
  speed: number; // m/s
  touch: number; // 接触ダメージ
  attackInterval: number; // 接触攻撃の間隔（秒）
  half: number; // XZ当たり判定半径
  height: number; // 高さ
  score: number;
}

const STANDARD_SPEED = 3.0;

// 敵種別ごとの権威パラメータ。half/height は当たり判定用にオフラインの見た目寸法から定めた。
export const TOWER_BASE: Record<TowerEnemyType, TowerBase> = {
  standard: { hp: 100, speed: STANDARD_SPEED * 1.0, touch: 10, attackInterval: 1.0, half: 0.45, height: 1.8, score: 100 },
  fast: { hp: 30, speed: STANDARD_SPEED * 2.2, touch: 8, attackInterval: 0.6, half: 0.3, height: 1.4, score: 80 },
  tank: { hp: 400, speed: STANDARD_SPEED * 0.5, touch: 25, attackInterval: 2.0, half: 0.8, height: 1.6, score: 250 },
  ranged: { hp: 60, speed: STANDARD_SPEED * 0.6, touch: 5, attackInterval: 1.5, half: 0.45, height: 1.7, score: 120 },
  exploder: { hp: 80, speed: STANDARD_SPEED * 0.9, touch: 0, attackInterval: 1.0, half: 0.45, height: 0.9, score: 100 },
  summoner: { hp: 120, speed: STANDARD_SPEED * 0.4, touch: 8, attackInterval: 1.0, half: 0.55, height: 2.0, score: 300 },
};

// ===== 各種別の特殊行動パラメータ（オフライン版と一致）=====
// 遠距離（ranged）
export const RANGED_FIRE_DIST = 8; // この距離未満なら後退しながら射撃、以上なら接近
export const RANGED_BULLET_SPEED = 18; // m/s
export const RANGED_BULLET_DAMAGE = 12;
export const RANGED_BULLET_LIFE = 3.0; // 秒

// 爆発（exploder）：死亡時に半径内へ距離減衰ダメージ
export const EXPLODER_RADIUS = 4;
export const EXPLODER_MAX_DAMAGE = 45; // 中心
export const EXPLODER_MIN_DAMAGE = 12; // 半径端

// 召喚（summoner）：一定間隔で standard を SUMMON_COUNT 体湧かせる
export const SUMMON_INTERVAL = 20; // 秒
export const SUMMON_COUNT = 2;

// サーバー側で1体ぶんを保持する状態。CoopLogic の Enemy を踏襲し、タワー固有の
// タイマー（fireCd/summonCd）を足したもの。座標は数値で持つ（共有型へ詰め替えて配る）。
export interface TowerMob {
  id: string;
  etype: TowerEnemyType;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  speed: number;
  touch: number;
  half: number;
  height: number;
  attackCd: number; // 接触攻撃のクールダウン
  fireCd: number; // ranged の射撃クールダウン
  summonCd: number; // summoner の召喚クールダウン
  currentTarget: string | null; // 追跡中プレイヤー（フォローキル判定用）
  flashedBy: string | null;
  flashedUntil: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
}

// 1体ぶんを生成する。hpMul はフロア後半でのスケーリング用（既定1.0）。
export function createTowerMob(
  id: string,
  etype: TowerEnemyType,
  x: number,
  y: number,
  z: number,
  hpMul = 1
): TowerMob {
  const b = TOWER_BASE[etype];
  const hp = Math.round(b.hp * hpMul);
  return {
    id,
    etype,
    x,
    y,
    z,
    hp,
    maxHp: hp,
    speed: b.speed,
    touch: b.touch,
    half: b.half,
    height: b.height,
    attackCd: 0,
    fireCd: etype === "ranged" ? b.attackInterval : 0,
    summonCd: etype === "summoner" ? SUMMON_INTERVAL : 0,
    currentTarget: null,
    flashedBy: null,
    flashedUntil: 0,
    spawnX: x,
    spawnY: y,
    spawnZ: z,
  };
}

// 撃破スコア。
export function scoreFor(etype: TowerEnemyType): number {
  return TOWER_BASE[etype].score;
}

// ===== フロア別の敵構成（比率テーブルの線形補間）=====
// [standard, fast, tank, ranged, exploder, summoner] の出現比率（合計1.0）。
const ENEMY_RATIO: Record<number, number[]> = {
  1: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  5: [0.6, 0.2, 0.1, 0.1, 0.0, 0.0],
  10: [0.4, 0.2, 0.1, 0.1, 0.1, 0.1],
  20: [0.2, 0.2, 0.2, 0.2, 0.1, 0.1],
  50: [0.1, 0.2, 0.2, 0.2, 0.2, 0.1],
  80: [0.1, 0.2, 0.1, 0.2, 0.2, 0.2],
};
const RATIO_KEYS = [1, 5, 10, 20, 50, 80];

// 指定フロアの出現比率を、定義済みキーの線形補間で求める。
export function ratioForFloor(floor: number): number[] {
  const f = Math.max(RATIO_KEYS[0], Math.min(RATIO_KEYS[RATIO_KEYS.length - 1], floor));
  let lo = RATIO_KEYS[0];
  let hi = RATIO_KEYS[RATIO_KEYS.length - 1];
  for (let i = 0; i < RATIO_KEYS.length - 1; i++) {
    if (f >= RATIO_KEYS[i] && f <= RATIO_KEYS[i + 1]) {
      lo = RATIO_KEYS[i];
      hi = RATIO_KEYS[i + 1];
      break;
    }
  }
  const a = ENEMY_RATIO[lo];
  const b = ENEMY_RATIO[hi];
  if (lo === hi) return a.slice();
  const t = (f - lo) / (hi - lo);
  return a.map((v, i) => v + (b[i] - v) * t);
}

// [0,1) の乱数 r を比率配列で重み付けして敵種別を1つ選ぶ（TowerLogic が r を供給）。
export function pickTypeByRatio(ratio: number[], r: number): TowerEnemyType {
  const total = ratio.reduce((s, v) => s + v, 0) || 1;
  let acc = 0;
  const x = r * total;
  for (let i = 0; i < TYPE_ORDER.length; i++) {
    acc += ratio[i] ?? 0;
    if (x < acc) return TYPE_ORDER[i];
  }
  return "standard";
}

// ===== 1体ぶんのAI判断（純粋ヘルパー）=====

// ranged：ターゲットとの距離が射撃圏内なら後退（true）、圏外なら接近（false）。
export function rangedWantsRetreat(dist: number): boolean {
  return dist < RANGED_FIRE_DIST;
}

// exploder：爆心からの距離に応じた爆発ダメージ（中心 EXPLODER_MAX、半径端 EXPLODER_MIN、外は0）。
export function exploderDamageAt(dist: number): number {
  if (dist > EXPLODER_RADIUS) return 0;
  const falloff = Math.max(0, 1 - dist / EXPLODER_RADIUS);
  return Math.round(EXPLODER_MIN_DAMAGE + (EXPLODER_MAX_DAMAGE - EXPLODER_MIN_DAMAGE) * falloff);
}

// TowerMob.etype を共有 EnemyType（広い型）へ詰め替えるための明示変換。
// TowerEnemyType は EnemyType の部分集合なので、そのまま代入可能であることを型で保証する。
export function toEnemyType(etype: TowerEnemyType): EnemyType {
  return etype;
}
