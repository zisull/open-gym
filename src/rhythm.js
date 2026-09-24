/**
 * rhythm.js —— 行进运球"卡点拍球"节奏判定器
 * 进度条标记在 [0,1) 循环滚动；中央为完美区，其外包及格区。
 * 连击越高，滚动周期越短（难度提升），判定区也略微收缩。
 */
import { CFG } from './config.js';

export class RhythmJudge {
  constructor() {
    this.t = 0.13;            // 标记当前位置（0~1）
    this.combo = 0;           // 当前运球连击（由外部同步，决定难度）
    this.clickedThisCycle = false;
    this.onCycleMiss = null;  // 周期走完未点击的回调
  }

  reset() {
    this.t = 0.13;
    this.combo = 0;
    this.clickedThisCycle = false;
  }

  /** 当前滚动周期（秒）：随连击加快 */
  period() {
    const D = CFG.dribble;
    return Math.max(D.minPeriod, D.basePeriod - this.combo * D.periodStep);
  }

  /** 完美/及格区半宽（随连击收缩） */
  zones() {
    const D = CFG.dribble;
    const shrink = Math.min(this.combo * D.shrinkPerCombo, 1);
    return {
      perfect: Math.max(D.perfectMin, D.perfectHalf - D.shrinkPerCombo * this.combo),
      good: Math.max(D.goodMin, D.goodHalf - D.shrinkPerCombo * 0.5 * this.combo),
    };
  }

  /**
   * 每帧推进。返回是否发生了"周期空过"（一轮结束没点击 = 记一次失误）。
   */
  update(dt) {
    const prev = this.t;
    this.t += dt / this.period();
    if (this.t >= 1) {
      this.t -= 1;
      const missed = !this.clickedThisCycle;
      this.clickedThisCycle = false;
      if (missed && this.onCycleMiss) this.onCycleMiss();
      return true;
    }
    return false;
  }

  /**
   * 点击判定。
   * @returns {'perfect'|'good'|'miss'}
   */
  hit() {
    if (this.clickedThisCycle) return 'miss'; // 本周期已点过，再点视为乱拍
    this.clickedThisCycle = true;
    const d = Math.abs(this.t - 0.5);
    const z = this.zones();
    if (d <= z.perfect) return 'perfect';
    if (d <= z.good) return 'good';
    return 'miss';
  }
}
