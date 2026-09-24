/**
 * 程序化音效生成工具
 * ------------------------------------------------
 * 运行: node tools/gen_audio.js
 * 产物:
 *   1. assets/audio/*.wav  —— 真实可替换的音频文件（供编辑/参考）
 *   2. assets/audio/sfx.js —— 将全部 wav 以 base64 嵌入的 <script> 数据文件
 *
 * 为什么要 sfx.js：浏览器在 file:// 协议下禁止 fetch/XHR 读取本地文件，
 * 但允许 <script src> 加载。游戏运行时从 window.BB_SFX 解码 base64 音频，
 * 实现"纯本地双击 index.html 即玩、音效零网络请求"。
 */
const fs = require('fs');
const path = require('path');

const SR = 44100; // 采样率

/* ---------- 基础合成工具 ---------- */

/** 指数衰减正弦（打击感核心：频率从 f0 快速滑到 f1） */
function thud(dur, f0, f1, decay, gain = 1) {
  const n = Math.floor(SR * dur);
  const buf = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = t / dur;
    const f = f0 + (f1 - f0) * Math.min(1, k * 4); // 频率前 1/4 时间快速下滑
    phase += (2 * Math.PI * f) / SR;
    buf[i] = Math.sin(phase) * Math.exp(-decay * k) * gain;
  }
  return buf;
}

/** 衰减白噪声（摩擦/刷网/氛围） */
function noise(dur, decay, gain = 1, lowpass = 0.5) {
  const n = Math.floor(SR * dur);
  const buf = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    y += (Math.random() * 2 - 1 - y) * lowpass; // 一阶低通
    buf[i] = y * Math.exp(-decay * k) * gain;
  }
  return buf;
}

/** 扫频音（失误提示音：下滑音） */
function sweep(dur, f0, f1, gain = 0.5, type = 'tri') {
  const n = Math.floor(SR * dur);
  const buf = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const f = f0 + (f1 - f0) * k;
    phase += (2 * Math.PI * f) / SR;
    let s = Math.sin(phase);
    if (type === 'square') s = s >= 0 ? 1 : -1;
    buf[i] = s * Math.min(1, (1 - k) * 3) * gain; // 末端淡出防爆音
  }
  return buf;
}

/** 两缓冲混合叠加（a 从 offsetSec 处开始加到 b 上） */
function mix(target, source, offsetSec = 0, gain = 1) {
  const off = Math.floor(offsetSec * SR);
  const len = Math.max(target.length, off + source.length);
  const out = target.length < len ? Float32Array.from(target) : target;
  if (out.length < len) {
    const grown = new Float32Array(len);
    grown.set(out);
    return mix(grown, source, offsetSec, gain);
  }
  for (let i = 0; i < source.length; i++) out[off + i] += source[i] * gain;
  return out;
}

/* ---------- 各音效定义 ---------- */

const SOUNDS = {
  // 完美拍球："滴答"高频清脆提示音
  tick: () => {
    let b = thud(0.07, 2100, 1500, 5, 0.7);
    b = mix(b, noise(0.02, 6, 0.25, 0.9)); // 一点点脆响
    return b;
  },
  // 普通拍球落地声（运球中每次拍击）
  tap: () => {
    let b = thud(0.12, 170, 75, 6, 0.9);
    b = mix(b, noise(0.03, 8, 0.18, 0.6), 0.002);
    return b;
  },
  // 球重重落地（掉球/投篮砸地）
  bounce: () => {
    let b = thud(0.22, 130, 48, 5, 1.0);
    b = mix(b, noise(0.04, 7, 0.2, 0.5));
    return b;
  },
  // 球撞篮筐金属声
  rim: () => {
    let b = thud(0.25, 820, 760, 4, 0.35);
    b = mix(b, thud(0.2, 1240, 1150, 5, 0.25), 0.005);
    b = mix(b, noise(0.05, 9, 0.15, 0.85));
    return b;
  },
  // 投篮出手（轻风）
  shoot: () => noise(0.18, 5, 0.3, 0.25),
  // 进球刷网
  net: () => {
    let b = noise(0.35, 4, 0.55, 0.45);
    b = mix(b, thud(0.4, 980, 1320, 3, 0.18), 0.02); // 上行小铃音点缀
    return b;
  },
  // 进球观众欢呼（低频噪声涌浪 + 零星掌声）
  cheer: () => {
    const n = Math.floor(SR * 1.4);
    let b = new Float32Array(n);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      y += (Math.random() * 2 - 1 - y) * 0.12;
      const env = Math.sin(Math.PI * k) ** 1.5; // 涌浪包络
      b[i] = y * env * 0.3;
    }
    for (let c = 0; c < 14; c++) {
      const cl = noise(0.05, 9, 0.22, 0.85);
      b = mix(b, cl, 0.15 + Math.random() * 1.0);
    }
    return b;
  },
  // 失误/掉球（下滑警示音）
  fail: () => sweep(0.3, 340, 130, 0.4, 'tri'),
  // 连击达到倍率上限的强调音
  combo: () => {
    let b = thud(0.1, 1500, 1500, 3, 0.35);
    b = mix(b, thud(0.14, 2000, 2000, 3, 0.35), 0.08);
    return b;
  },
  // 挑战倒计时结束哨
  buzzer: () => {
    const b = sweep(0.9, 430, 430, 0.0, 'square');
    const n = b.length;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      phase += (2 * Math.PI * 435) / SR;
      b[i] = (Math.sin(phase) >= 0 ? 1 : -1) * Math.min(1, (1 - k) * 4, k * 30) * 0.28;
    }
    return b;
  },
  // UI 按钮
  ui: () => thud(0.08, 760, 980, 4, 0.4),
};

/* ---------- WAV 编码 ---------- */

function encodeWav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

/* ---------- 主流程 ---------- */

const outDir = path.join(__dirname, '..', 'assets', 'audio');
const embedded = {};
for (const [name, fn] of Object.entries(SOUNDS)) {
  const samples = fn();
  const wav = encodeWav(samples);
  fs.writeFileSync(path.join(outDir, `${name}.wav`), wav);
  embedded[name] = wav.toString('base64');
  console.log(`${name}.wav  ${(wav.length / 1024).toFixed(1)} KB`);
}

const js =
  '/* 自动生成，勿手改。源: tools/gen_audio.js。base64 WAV 音频数据包（file:// 可用） */\n' +
  'window.BB_SFX = ' +
  JSON.stringify(embedded) +
  ';\n';
fs.writeFileSync(path.join(outDir, 'sfx.js'), js);
console.log('sfx.js 生成完成');
