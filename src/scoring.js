/**
 * scoring.js —— 计分与本地记录管理
 * 两种模式相互隔离；拍球为无门槛装饰得分（仅自由模式计入），投篮连击独立计数。
 * 最高分使用 localStorage 持久保存（键见 CFG.MODES[*].recordKey）。
 */
import { CFG } from './config.js';

const LS_SHADOW = 'fpbb.settings.shadow';
const LS_VOLUME = 'fpbb.settings.volume';

export function loadRecord(modeId) {
  try { return Number(localStorage.getItem(CFG.MODES[modeId].recordKey)) || 0; }
  catch { return 0; }
}
export function saveRecord(modeId, score) {
  try { localStorage.setItem(CFG.MODES[modeId].recordKey, String(score)); } catch { /* 隐私模式忽略 */ }
}
export function loadSetting(key, dft) {
  try { const v = localStorage.getItem(key); return v === null ? dft : v; } catch { return dft; }
}
export function saveSetting(key, v) {
  try { localStorage.setItem(key, String(v)); } catch { /* noop */ }
}

export class ScoreManager {
  constructor() {
    this.mode = null;
    this.reset(CFG.MODES.free);
  }

  /** 开局/重开：清空当局数据（不影响历史最高分） */
  reset(modeDef) {
    this.mode = modeDef;
    this.tapScore = 0;       // 拍球得分（仅自由模式计入）
    this.taps = 0;           // 统计：拍球次数
    this.shotScore = 0;      // 投篮得分
    this.shotCombo = 0;      // 投篮连击
    this.shotComboMax = 0;   // 统计：最高连击
    this.shotFail = 0;       // 投篮连续不中计数
    this.shotMade = 0;       // 统计：进球数
    this.shotTaken = 0;      // 统计：出手数
    this.spots = 0;          // 统计：投篮挑战命中的站位数（换位次数）
    this.currentSpot = null; // 投篮挑战当前站位中心（小圈走位钳制用）
    this.timeLeft = modeDef.timed ? CFG.challenge.duration : Infinity;
    this.ended = false;
  }

  /** 当前模式下展示的总分 */
  get displayScore() {
    if (this.mode.id === 'shot') return this.shotScore;
    return this.tapScore + this.shotScore; // 自由模式：合并计算
  }

  /** 投篮连击倍数（索引=连击数，3+ 封顶） */
  shotMultiplier() {
    const S = CFG.shot;
    return S.comboMul[Math.min(this.shotCombo, S.maxComboMul)];
  }

  /**
   * 出手距离倍率：≥3m 起 1.0x，随距离线性增长，25m 处封顶 3.0x（球场内 ≤3x）。
   * 取 0.1 步进，便于 UI 展示整档数值。
   */
  static distanceMultiplier(dist) {
    const S = CFG.shot;
    const m = 1 + (S.distMulCap - 1) * (dist - S.distMulMin) / (S.distMulFull - S.distMulMin);
    return Math.round(Math.min(S.distMulCap, Math.max(1, m)) * 10) / 10;
  }

  /** 拍球一次（无门槛）。返回 { points } */
  addTap() {
    this.taps++;
    if (!this.mode.tapScore) return { points: 0 };
    const pts = CFG.tap.points;
    this.tapScore += pts;
    return { points: pts };
  }

  /** 投篮出手登记 */
  registerShotAttempt() { this.shotTaken++; }

  /** 进球。返回 { points, is3, distMul, multiplier }；连击 +1 */
  addShotMade(dist) {
    this.shotCombo++;
    this.shotComboMax = Math.max(this.shotComboMax, this.shotCombo);
    this.shotFail = 0;
    this.shotMade++;
    if (!this.mode.shotScore) return { points: 0, is3: false, distMul: 1, multiplier: 1 };
    const is3 = dist > CFG.shot.score2Dist;
    const distMul = ScoreManager.distanceMultiplier(dist);
    const mul = this.shotMultiplier();
    const pts = Math.round(CFG.shot.base * distMul * mul);
    this.shotScore += pts;
    return { points: pts, is3, distMul, multiplier: mul };
  }

  /** 投篮未中。返回是否达到 3 连败（连击清零） */
  addShotMiss() {
    this.shotFail++;
    if (this.shotFail >= 3) {
      this.shotCombo = 0;
      this.shotFail = 0;
      return true;
    }
    return false;
  }

  /** 倒计时推进；返回是否刚好结束 */
  tickTimer(dt) {
    if (!this.mode.timed || this.ended) return false;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.ended = true;
      return true;
    }
    return false;
  }

  /** 结算：写入新纪录则返回 true */
  finalize() {
    const score = this.displayScore;
    const best = loadRecord(this.mode.id);
    if (score > best) {
      saveRecord(this.mode.id, score);
      return { score, best: score, prevBest: best, isNew: true };
    }
    return { score, best, prevBest: best, isNew: false };
  }
}

export { LS_SHADOW, LS_VOLUME };
