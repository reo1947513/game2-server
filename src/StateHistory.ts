import { PlayerState } from "./netTypes";

// 1スナップショット（あるtick時点の全プレイヤー位置）。
interface Snapshot {
  tick: number;
  timestamp: number;
  states: Map<string, PlayerState>;
}

// 過去600ms分の世界状態を保持し、ラグ補償の巻き戻し参照に使う（20tick × 600ms = 12件）。
export class StateHistory {
  private snapshots: Snapshot[] = [];
  private readonly maxAgeMs = 600;

  push(tick: number, timestamp: number, players: PlayerState[]): void {
    const states = new Map<string, PlayerState>();
    for (const p of players) {
      // ディープコピー（後続tickの変更で過去が汚れないように）
      states.set(p.playerId, {
        ...p,
        position: { ...p.position },
        velocity: { ...p.velocity },
      });
    }
    this.snapshots.push({ tick, timestamp, states });
    // 古いものを捨てる
    const cutoff = timestamp - this.maxAgeMs;
    while (this.snapshots.length > 2 && this.snapshots[0].timestamp < cutoff) {
      this.snapshots.shift();
    }
  }

  // 指定時刻に最も近いスナップショットを返す。
  getAt(timestamp: number): Snapshot | null {
    if (this.snapshots.length === 0) return null;
    let best = this.snapshots[0];
    let bestDiff = Math.abs(best.timestamp - timestamp);
    for (const s of this.snapshots) {
      const d = Math.abs(s.timestamp - timestamp);
      if (d < bestDiff) {
        bestDiff = d;
        best = s;
      }
    }
    return best;
  }

  clear(): void {
    this.snapshots = [];
  }
}
