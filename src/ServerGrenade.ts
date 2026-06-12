import { Vec3, Box, ProjectileState } from "./netTypes";

// サーバー権威のグレネード物理。クライアントの Grenade.ts と同じ式（重力26・床反発-0.45・
// AABB最小面反射）で弾道を計算し、結果を ProjectileState として配る。
export class ServerGrenade {
  position: Vec3;
  velocity: Vec3;
  fuse: number;
  readonly id: string;
  readonly type: "frag" | "flash";
  readonly ownerId: string;

  private readonly G = 26;
  private readonly R = 0.12;

  constructor(
    id: string,
    type: "frag" | "flash",
    origin: Vec3,
    velocity: Vec3,
    fuse: number,
    ownerId: string
  ) {
    this.id = id;
    this.type = type;
    this.position = { ...origin };
    this.velocity = { ...velocity };
    this.fuse = fuse;
    this.ownerId = ownerId;
  }

  // 1フレーム進める。信管が尽きたら true（起爆）。
  update(dt: number, colliders: Box[]): boolean {
    this.velocity.y -= this.G * dt;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    const p = this.position;
    const v = this.velocity;
    const r = this.R;

    // 床バウンド
    if (p.y < r) {
      p.y = r;
      if (Math.abs(v.y) > 1.0) v.y *= -0.45;
      else v.y = 0;
      v.x *= 0.8;
      v.z *= 0.8;
    }

    // AABBバウンド（最小めり込み軸で押し出して反射）
    for (const c of colliders) {
      if (
        p.x > c.min.x - r &&
        p.x < c.max.x + r &&
        p.y > c.min.y - r &&
        p.y < c.max.y + r &&
        p.z > c.min.z - r &&
        p.z < c.max.z + r
      ) {
        const pxMin = p.x - (c.min.x - r);
        const pxMax = c.max.x + r - p.x;
        const pyMin = p.y - (c.min.y - r);
        const pyMax = c.max.y + r - p.y;
        const pzMin = p.z - (c.min.z - r);
        const pzMax = c.max.z + r - p.z;
        const m = Math.min(pxMin, pxMax, pyMin, pyMax, pzMin, pzMax);
        if (m === pxMin) {
          p.x = c.min.x - r;
          v.x *= -0.45;
        } else if (m === pxMax) {
          p.x = c.max.x + r;
          v.x *= -0.45;
        } else if (m === pyMin) {
          p.y = c.min.y - r;
          v.y *= -0.45;
          v.x *= 0.8;
          v.z *= 0.8;
        } else if (m === pyMax) {
          p.y = c.max.y + r;
          v.y *= -0.45;
          v.x *= 0.8;
          v.z *= 0.8;
        } else if (m === pzMin) {
          p.z = c.min.z - r;
          v.z *= -0.45;
        } else {
          p.z = c.max.z + r;
          v.z *= -0.45;
        }
      }
    }

    this.fuse -= dt;
    return this.fuse <= 0;
  }

  toState(): ProjectileState {
    return {
      id: this.id,
      type: this.type,
      position: { ...this.position },
      velocity: { ...this.velocity },
      fuse: this.fuse,
    };
  }
}
