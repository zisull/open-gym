/**
 * ui.js —— DOM 界面控制器
 * 只负责"显示什么"和"把用户点击转成回调"，不含任何玩法逻辑。
 */
import { CFG } from './config.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), cross: $('crosshair'),
      mode: $('hud-mode'), score: $('hud-score'), best: $('hud-best'), sub: $('hud-sub'),
      timerBox: $('hud-timer'), timerText: $('timer-text'), timerFill: $('timer-fill'),
      chipS: $('chip-s'), comboS: $('combo-s'), mulS: $('mul-s'),
      prompt: $('hud-prompt'), popup: $('score-popup'),
      pbar: $('power-bar'), pFill: $('pb-fill'), pSweet: $('pb-sweet'),
      menu: $('menu'), pause: $('pause'), result: $('result'),
      badgeNew: $('badge-new'), resTitle: $('res-title'), resScore: $('res-score'),
      resScoreLabel: $('res-score-label'), resLines: $('res-lines'), resShare: $('res-share'),
      recFree: $('rec-free'), recShot: $('rec-shot'),
      setShadow: $('set-shadow'), setVolume: $('set-volume'), pauseShadow: $('pause-shadow'),
    };
    this._lastComboS = -1;
    this._prompt = '';
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
  }
  hideMenu() { this.el.menu.classList.add('hidden'); }

  showHud(modeName, timed) {
    this.hideMenu();
    this.el.hud.classList.remove('hidden');
    this.el.cross.classList.remove('hidden');
    this.el.mode.textContent = modeName;
    this.el.timerBox.classList.toggle('hidden', !timed);
  }

  showPause(show) { this.el.pause.classList.toggle('hidden', !show); }

  /* ---------- 数值面板 ---------- */
  setScore(score, best, subText) {
    this.el.score.textContent = score;
    this.el.best.textContent = best;
    this.el.sub.textContent = subText || '';
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
    this.el.timerText.textContent = Math.ceil(secondsLeft);
    this.el.timerFill.style.width = `${frac * 100}%`;
    this.el.timerText.classList.toggle('urgent', urgent);
  }

  setPrompt(html, kind) {
    if (this._prompt === html) return;
    this._prompt = html;
    this.el.prompt.innerHTML = html;
    this.el.prompt.classList.toggle('pump', kind === 'pump');
  }

  /* ---------- 中央飘字 ---------- */
  showScorePopup(points, label, combo) {
    const el = this.el.popup;
    el.innerHTML = (points > 0 ? `+${points}` : '') + (label ? `<small>${label}</small>` : '');
    el.classList.toggle('bad', points === 0 && !!label);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }

  /* ---------- 投篮力度条 ---------- */
  showPowerBar(show) { this.el.pbar.classList.toggle('hidden', !show); }
  updatePowerBar(charge, sweetP) {
    this.el.pFill.style.height = `${charge * 100}%`;
    this.el.pbar.classList.toggle('maxed', charge >= 0.999);
    if (sweetP == null) {
      this.el.pSweet.style.display = 'none';
    } else {
      const half = CFG.shot.sweetHalf;
      this.el.pSweet.style.display = '';
      this.el.pSweet.style.bottom = `${Math.max(0, sweetP - half) * 100}%`;
      this.el.pSweet.style.height = `${Math.min(100, half * 2 * 100)}%`;
    }
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
