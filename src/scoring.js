/**
 * scoring.js —— 计分与本地记录管理
 * 三种模式相互隔离；运球连击与投篮连击两套计数器相互独立。
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
    this.dribbleScore = 0;   // 运球得分
    this.shotScore = 0;      // 投篮得分
    this.dribbleCombo = 0;   // 运球连击
    this.shotCombo = 0;      // 投篮连击
    this.dribbleFail = 0;    // 运球连续失误计数
    this.shotFail = 0;       // 投篮连续不中计数
    this.perfectHits = 0;    // 统计：完美拍球次数
    this.shotMade = 0;       // 统计：进球数
    this.shotTaken = 0;      // 统计：出手数
    this.timeLeft = modeDef.timed ? CFG.challenge.duration : Infinity;
    this.ended = false;
  }

  /** 当前模式下展示的总分 */
  get displayScore() {
    if (this.mode.id === 'dribble') return this.dribbleScore;
    if (this.mode.id === 'shot') return this.shotScore;
    return this.dribbleScore + this.shotScore; // 自由模式：合并计算
  }

  /** 运球连击倍数（1→×1，2→×2，3+→×3 封顶） */
  dribbleMultiplier() {
    const D = CFG.dribble;
    return D.comboMul[Math.min(this.dribbleCombo, D.maxComboMul)];
  }
  shotMultiplier() {
    const D = CFG.dribble; // 倍数规则与运球一致
    return D.comboMul[Math.min(this.shotCombo, D.maxComboMul)];
  }

  /**
   * 完美拍球得分。返回 { points, multiplier }；若当前模式不计运球分则 points=0。
   */
  addDribblePerfect() {
    this.dribbleCombo++;
    this.dribbleComboMax = Math.max(this.dribbleComboMax || 0, this.dribbleCombo);
    this.dribbleFail = 0;
    this.perfectHits++;
    if (!this.mode.dribbleScore) return { points: 0, multiplier: this.dribbleMultiplier() };
    const mul = this.dribbleMultiplier();
    const pts = CFG.dribble.basePoints * mul;
    this.dribbleScore += pts;
    return { points: pts, multiplier: mul };
  }

  /** 及格拍球（不加分不涨连击，仅失误清零） */
  addDribbleGood() {
    this.dribbleFail = 0;
  }

  /** 运球一次失误 */
  addDribbleFail() {
    if (!this.mode.dribbleScore) return false; // 投篮挑战模式：运球只是移动手段，不判失误
    this.dribbleFail++;
    this.dribbleCombo = 0;
    return this.dribbleFail >= CFG.dribble.failLimit; // true = 应掉球
  }

  /** 掉球后：连击清零、失误清零 */
  onBallDropped() {
    this.dribbleCombo = 0;
    this.dribbleFail = 0;
  }

  /** 取消运球（回到持球），保留连击但不保留"本周期已点击" */
  onDribbleCancel() {
    this.dribbleFail = 0;
  }

  /** 投篮出手登记 */
  registerShotAttempt() { this.shotTaken++; }

  /** 进球。返回 { points, is3 } */
  addShotMade(dist) {
    this.shotCombo++;
    this.shotFail = 0;
    this.shotMade++;
    if (!this.mode.shotScore) return { points: 0, is3: false };
    const is3 = dist > CFG.shot.score2Dist;
    const pts = (is3 ? CFG.shot.base3 : CFG.shot.base2) * this.shotMultiplier();
    this.shotScore += pts;
    return { points: pts, is3 };
  }

  /** 投篮未中。返回是否达到 3 连败（连击清零） */
  addShotMiss() {
    if (!this.mode.shotScore) return false;
    this.shotFail++;
    if (this.shotFail >= CFG.dribble.failLimit) {
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
