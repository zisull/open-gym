/**
 * ui.js —— DOM 界面控制器
 * 只负责"显示什么"和"把用户点击转成回调"，不含任何玩法逻辑。
 */
import { CFG } from './config.js';

const $ = (id) => document.getElementById(id);

/**
 * 安全请求指针锁：Chrome 在 ESC 解锁后 ~1s 内再锁会被拒绝，静默失败由用户点击画面兜底。
 * 球馆 / 台球室 / 电影院三处共用同一个 <canvas id="gl">。
 */
export function lockPointer(el = $('gl')) {
  try {
    const p = el.requestPointerLock?.();
    if (p && p.catch) p.catch(() => { /* 无手势时忽略，点画面可再锁 */ });
  } catch (e) { /* 旧浏览器同步抛错同样忽略 */ }
}

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), cross: $('crosshair'),
      mode: $('hud-mode'), score: $('hud-score'), best: $('hud-best'), sub: $('hud-sub'),
      timerBox: $('hud-timer'), timerText: $('timer-text'), timerFill: $('timer-fill'),
      chipS: $('chip-s'), comboS: $('combo-s'), mulS: $('mul-s'), comboLabel: $('combo-label'),
      prompt: $('hud-prompt'), popup: $('score-popup'),
      pbar: $('power-bar'), pFill: $('power-fill'), pSweet: $('power-sweet'),
      menu: $('menu'), pause: $('pause'), result: $('result'),
      help: $('help'), helpBtn: $('btn-help'),
      badgeNew: $('badge-new'), resTitle: $('res-title'), resScore: $('res-score'),
      resScoreLabel: $('res-score-label'), resLines: $('res-lines'), resShare: $('res-share'),
      recFree: $('rec-free'), recShot: $('rec-shot'), recArch: $('rec-arch'),
      setShadow: $('set-shadow'), setVolume: $('set-volume'), pauseShadow: $('pause-shadow'),
    };
    this._lastComboS = -1;
    this._prompt = '';
    this._lastScore = -1;
    this._lastBest = -1;
    this._lastSub = '';
    this._lastTimer = -1;
    this._bindButtons();
  }

  /** 回调注入（由 main.js 装配） */
  bindCallbacks(cb) { this.cb = cb; }

  _bindButtons() {
    document.querySelectorAll('#mode-cards .card').forEach((card) => {
      card.addEventListener('click', () => {
        card.blur();
        this.cb.onModeSelect?.(card.dataset.mode);
      });
    });
    $('btn-resume').addEventListener('click', () => this.cb.onResume?.());
    $('btn-restart').addEventListener('click', () => this.cb.onRestart?.());
    $('btn-finish').addEventListener('click', () => this.cb.onFinishFree?.());
    $('btn-quit').addEventListener('click', () => this.cb.onQuit?.());
    $('btn-again').addEventListener('click', () => this.cb.onAgain?.());
    $('btn-menu').addEventListener('click', () => this.cb.onQuit?.());
    this.el.setShadow.addEventListener('change', () => this.cb.onShadow?.(this.el.setShadow.checked));
    this.el.pauseShadow.addEventListener('change', () => this.cb.onShadow?.(this.el.pauseShadow.checked));
    this.el.setVolume.addEventListener('input', () => this.cb.onVolume?.(Number(this.el.setVolume.value)));
    const help = this.el.help, helpBtn = this.el.helpBtn;   // 用 el 表里的那份，别二次查询
    const setHelp = (open) => {
      help.classList.toggle('hidden', !open);
      helpBtn.textContent = open ? '📖 收起说明' : '📖 怎么玩';
    };
    this._setHelp = setHelp;
    // 两颗按钮都是"收起"，浮层右上角的 ✕ 是让手已经在鼠标上的人少挪一段
    helpBtn.addEventListener('click', () => {
      helpBtn.blur();   // 否则回车/空格会又触发这颗刚点过的按钮
      setHelp(help.classList.contains('hidden'));
    });
    $('help-close').addEventListener('click', () => { helpBtn.blur(); setHelp(false); });
  }

  /* ---------- 主菜单 ---------- */
  showMenu(records) {
    this.el.menu.classList.remove('hidden');
    this.el.hud.classList.add('hidden');
    this.el.cross.classList.add('hidden');
    this.el.result.classList.add('hidden');
    this.el.pause.classList.add('hidden');
    this.el.recFree.textContent = records.free;
    this.el.recShot.textContent = records.shot;
    this.el.recArch.textContent = records.arch;
    // 回主菜单一律收起说明：主页永远保持"三卡片 + 一条键位"的极简样子
    this._setHelp(false);
  }
  hideMenu() { this.el.menu.classList.add('hidden'); }

  /** modeDef 整体传进来：连击芯片的文案要跟着手上拿的是球还是弓变 */
  showHud(modeDef) {
    this.hideMenu();
    this.el.hud.classList.remove('hidden');
    this.el.cross.classList.remove('hidden');
    this.el.mode.textContent = modeDef.name;
    this.el.comboLabel.textContent = modeDef.bow ? '🏹 射箭连击' : '🏀 投篮连击';
    this.el.timerBox.classList.toggle('hidden', !modeDef.timed);
  }

  showPause(show) { this.el.pause.classList.toggle('hidden', !show); }

  /* ---------- 数值面板（脏检查：避免逐帧写 DOM） ---------- */
  setScore(score, best, subText) {
    if (score !== this._lastScore) { this.el.score.textContent = score; this._lastScore = score; }
    if (best !== this._lastBest) { this.el.best.textContent = best; this._lastBest = best; }
    if (subText !== this._lastSub) { this.el.sub.textContent = subText || ''; this._lastSub = subText; }
  }

  setCombos(cs, mulS) {
    if (cs !== this._lastComboS) {
      this.el.comboS.textContent = cs;
      this.el.mulS.textContent = `×${mulS}`;
      this.el.chipS.classList.remove('pulse'); void this.el.chipS.offsetWidth;
      if (cs > 0) this.el.chipS.classList.add('pulse');
      this._lastComboS = cs;
    }
  }

  setTimer(secondsLeft, frac, urgent) {
    const sec = Math.ceil(secondsLeft);
    if (sec !== this._lastTimer) {
      this._lastTimer = sec;
      this.el.timerText.textContent = sec;
      this.el.timerText.classList.toggle('urgent', urgent);
    }
    // 进度条按 0.5% 取整再写：90 秒里每帧改 width 只会让布局白重排，肉眼却看不出来
    const pct = Math.round(frac * 200) / 2;
    if (pct !== this._lastTimerPct) {
      this._lastTimerPct = pct;
      this.el.timerFill.style.width = `${pct}%`;
    }
  }

  setPrompt(html, kind) {
    if (this._prompt === html) return;
    this._prompt = html;
    this.el.prompt.innerHTML = html;
    this.el.prompt.classList.toggle('pump', kind === 'pump');
  }

  /* ---------- 中央飘字 ---------- */
  showScorePopup(points, label) {
    const el = this.el.popup;
    el.innerHTML = (points > 0 ? `+${points}` : '') + (label ? `<small>${label}</small>` : '');
    el.classList.toggle('bad', points === 0 && !!label);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }

  /* ---------- 投篮力度条 ---------- */
  showPowerBar(show) { this.el.pbar.classList.toggle('hidden', !show); }
  updatePowerBar(charge, sweetP) {
    // 力度条每帧都调，但 1% 以下的差别没人看得见：按整数百分比脏检查
    const pct = Math.round(charge * 100);
    if (pct !== this._lastCharge) {
      this._lastCharge = pct;
      this.el.pFill.style.height = `${pct}%`;
      this.el.pbar.classList.toggle('maxed', pct >= 100);
    }
    const sp = sweetP == null ? -1 : Math.round(sweetP * 100);
    if (sp === this._lastSweet) return;
    this._lastSweet = sp;
    if (sp < 0) { this.el.pSweet.style.display = 'none'; return; }
    const half = CFG.shot.sweetHalf;
    this.el.pSweet.style.display = '';
    this.el.pSweet.style.bottom = `${Math.max(0, sweetP - half) * 100}%`;
    this.el.pSweet.style.height = `${Math.min(100, half * 2 * 100)}%`;
  }

  /* ---------- 结算弹窗 ---------- */
  showResult({ modeName, scoreLabel, score, best, prevBest, isNew, stats }) {
    this.el.result.classList.remove('hidden');
    this.el.resTitle.textContent = `${modeName} · 结算`;
    this.el.resScore.textContent = score;
    this.el.resScoreLabel.textContent = scoreLabel;
    this.el.badgeNew.classList.toggle('hidden', !isNew);
    let html = `<div class="${isNew ? 'rec-row' : ''}">🏆 历史最高：<b>${best}</b>${isNew ? '（刷新纪录！）' : ''}</div>`;
    html += stats.map((s) => `<div>${s}</div>`).join('');
    this.el.resLines.innerHTML = html;
    // 挑战模式：分享提示更明确
    this.el.resShare.textContent = '📸 截图分享给好友，比拼你的分数！';
    this.el.resShare.classList.remove('hidden');
  }
  hideResult() { this.el.result.classList.add('hidden'); }

  setShadowChecked(on) {
    this.el.setShadow.checked = on;
    this.el.pauseShadow.checked = on;
  }
}
