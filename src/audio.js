/**
 * audio.js —— 音效管理器
 * 音频数据来源：assets/audio/sfx.js 中的 base64 WAV（由 tools/gen_audio.js 生成）。
 * 之所以走 <script> 内嵌而不是 fetch 文件：file:// 协议下浏览器禁止 fetch/XHR
 * 读取本地文件，而 script 标签不受限制 —— 保证双击 index.html 即玩。
 */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.master = null;
    this.enabled = true;
  }

  /** 必须在用户手势后调用（浏览器 AudioContext 自动播放策略） */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    const vol = Number(window.BB_VOLUME ?? 0.8);
    this.master.gain.value = vol;

    // 简易场馆混响感：短延迟反馈
    const delay = this.ctx.createDelay(0.2);
    delay.delayTime.value = 0.055;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.18;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    this.master.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(this.ctx.destination);

    // 解码内嵌 base64 wav
    const data = window.BB_SFX || {};
    for (const [name, b64] of Object.entries(data)) {
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      this.ctx.decodeAudioData(buf).then(
        (audio) => { this.buffers[name] = audio; },
        () => { /* 解码失败则该音效静默 */ }
      );
    }
  }

  setVolume(v) {
    window.BB_VOLUME = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * 播放音效
   * @param {string} name 音效名（tick/tap/bounce/rim/shoot/net/cheer/fail/combo/buzzer/ui）
   * @param {object} opt { volume, rate(变速), pan(-1~1) }
   */
  play(name, opt = {}) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const buf = this.buffers[name];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opt.rate || 1;
    const g = this.ctx.createGain();
    g.gain.value = opt.volume ?? 1;
    src.connect(g);
    if (this.ctx.createStereoPanner && opt.pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opt.pan));
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    src.start();
  }
}
