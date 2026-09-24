/**
 * main.js —— 游戏入口与总装
 * 渲染循环、物理步进、输入分发、模式流程（菜单 -> 游玩 -> 暂停 -> 结算）。
 * 本文件只做"胶水"，具体逻辑在各模块内。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CFG } from './config.js';
import { createPhysics } from './physics.js';
import { buildCourt, setupLights, applyBackground, RIM_POS } from './court.js';
import { GameBall } from './ball.js';
import { Player } from './player.js';
import { Effects } from './effects.js';
import { RhythmJudge } from './rhythm.js';
import { StateMachine, NoBallState, HoldState, DribbleState, ShotState } from './states.js';
import { ScoreManager, loadRecord, loadSetting, saveSetting, LS_SHADOW, LS_VOLUME } from './scoring.js';
import { Sfx } from './audio.js';
import { UI } from './ui.js';

/* ================= 渲染器 / 场景 / 相机 ================= */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // 软阴影
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
applyBackground(scene);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 120);

/* 后期：Bloom 泛光（进球时脉冲增强） */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), CFG.fx.bloomBase, 0.55, 0.78);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

/* ================= 世界搭建 ================= */
const courtRefs = buildCourt(scene);
const lights = setupLights(scene);
const { world, ballBody, matRim, matBoard } = createPhysics();

const ball = new GameBall(scene, world, ballBody);
const player = new Player(camera);
const fx = new Effects(scene, camera);
const rhythm = new RhythmJudge();
const scoring = new ScoreManager();
const sfx = new Sfx();
const ui = new UI();

/* ================= 状态机装配 ================= */
const netSway = { t: 0 };
const G = {
  camera, player, ball, rhythm, scoring, sfx, fx, ui,
  modeDef: CFG.MODES.free,
  netSway: () => { netSway.t = 1; },
};
const machine = new StateMachine();
machine.register('noBall', new NoBallState(G));
machine.register('hold', new HoldState(G));
machine.register('dribble', new DribbleState(G));
machine.register('shot', new ShotState(G));
G.machine = machine;

/* 节奏条"周期空过"-> 记一次运球失误 */
rhythm.onCycleMiss = () => {
  if (machine.name === 'dribble' && G.modeDef.dribbleScore && !scoring.ended) {
    machine.current.registerFail();
  }
};

/* ================= 游戏流程状态：menu | playing | paused | result ================= */
let gameState = 'menu';
let currentModeId = 'free';
let menuCamAngle = 0;
let lastSecond = -1;

function refreshMenu() {
  gameState = 'menu';
  machine.set('noBall');
  ball.startPhysics(new THREE.Vector3(1.4, 1, 0.5), null);
  ui.showMenu({
    free: loadRecord('free'), dribble: loadRecord('dribble'), shot: loadRecord('shot'),
  });
  ui.setShadowChecked(shadowOn);
  document.exitPointerLock?.();
}

function startMode(id) {
  sfx.init();               // 用户手势内初始化 AudioContext
  currentModeId = id;
  G.modeDef = CFG.MODES[id];
  scoring.reset(G.modeDef);
  // 玩家回中圈，球放脚边
  player.pos.set(0.6, 0, 1.5);
  player.vel.set(0, 0, 0);
  player.freeYaw = 0; player.freePitch = 0;
  player.yaw = 0; player.pitch = 0;
  player.exitShotAim();
  player.mode = 'free'; player.blend = 0;
  ball.startPhysics(new THREE.Vector3(1.2, 0.8, 0.4), null);
  machine.set('noBall');
  gameState = 'playing';
  lastSecond = -1;
  ui.showHud(G.modeDef.name, G.modeDef.timed);
  ui.hideResult();
  ui.showPause(false);
  canvas.requestPointerLock?.();
  sfx.play('ui');
}

function pauseGame() {
  if (gameState !== 'playing') return;
  gameState = 'paused';
  player.inputEnabled = false;
  machine.dispatch('onLeftUp');  // 防蓄力卡在按住状态
  ui.showPause(true);
}

function resumeGame() {
  if (gameState !== 'paused') return;
  ui.showPause(false);
  player.inputEnabled = true;
  gameState = 'playing';
  canvas.requestPointerLock?.();
}

/** 结算（倒计时归零 / 自由模式手动结束共用） */
function finishSession() {
  if (gameState === 'result') return;
  gameState = 'result';
  player.inputEnabled = false;
  machine.dispatch('onLeftUp');
  ball.startHeld(); // 结算时无论球在哪（运球/飞行）都收回手中，避免悬空或乱滚
  machine.set('hold');
  const fin = scoring.finalize();
  sfx.play('buzzer', { volume: 0.8 });
  const m = scoring.mode;
  const scoreLabel = m.id === 'free' ? '总分（运球+投篮）' : m.id === 'dribble' ? '运球得分' : '投篮得分';
  const stats = [];
  if (m.dribbleScore) stats.push(`⛹ 完美拍球 <b>${scoring.perfectHits}</b> 次 · 最高运球连击 <b>${scoring.dribbleComboMax || 0}</b>`);
  if (m.shotScore) {
    const pct = scoring.shotTaken ? Math.round((scoring.shotMade / scoring.shotTaken) * 100) : 0;
    stats.push(`🎯 投篮 <b>${scoring.shotMade}</b> / <b>${scoring.shotTaken}</b> 中（命中率 <b>${pct}%</b>）`);
  }
  stats.push(`🕘 ${m.timed ? '用时 90s 倒计时结束' : '自由练习'}`);
  ui.showResult({
    modeName: m.name, scoreLabel, score: fin.score,
    best: fin.best, prevBest: fin.prevBest, isNew: fin.isNew, stats,
  });
  document.exitPointerLock?.();
}

/* ================= UI 回调 ================= */
let shadowOn = loadSetting(LS_SHADOW, '1') === '1';
ui.bindCallbacks({
  onModeSelect: startMode,
  onResume: resumeGame,
  onRestart: () => startMode(currentModeId),
  onFinishFree: () => { ui.showPause(false); finishSession(); },
  onQuit: () => { ui.showPause(false); ui.hideResult(); refreshMenu(); },
  onAgain: () => startMode(currentModeId),
  onShadow: (on) => applyShadow(on),
  onVolume: (v) => { sfx.setVolume(v); saveSetting(LS_VOLUME, v); },
});

function applyShadow(on) {
  shadowOn = on;
  saveSetting(LS_SHADOW, on ? '1' : '0');
  renderer.shadowMap.enabled = on;
  lights.dir.castShadow = on;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  ui.setShadowChecked(on);
}
applyShadow(shadowOn);

// 音量记忆
const savedVol = Number(loadSetting(LS_VOLUME, 0.8));
document.getElementById('set-volume').value = savedVol;
window.BB_VOLUME = savedVol;

/* ================= 输入 ================= */
const keys = player.keys;
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = true;
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && gameState === 'playing') {
    player.look(e.movementX, e.movementY);
  }
});
canvas.addEventListener('mousedown', (e) => {
  if (gameState === 'playing' && document.pointerLockElement === canvas) {
    if (e.button === 0) machine.dispatch('onLeftDown');
    if (e.button === 2) machine.dispatch('onRightDown');
  }
});
addEventListener('mouseup', (e) => {
  if (gameState === 'playing' && e.button === 0) machine.dispatch('onLeftUp');
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  // 玩家按 ESC 或点击外部导致解锁 -> 自动暂停
  if (document.pointerLockElement !== canvas && gameState === 'playing') pauseGame();
});

/* ================= 物理碰撞音效 ================= */
ballBody.addEventListener('collide', (e) => {
  const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
  if (impact < 1.2) return;
  const other = e.body;
  if (other.material === matRim && impact > 1.5) {
    sfx.play('rim', { volume: Math.min(1, impact / 8) });
  } else if (other.material === matBoard) {
    sfx.play('tap', { volume: Math.min(1, impact / 9), rate: 0.8 });
  } else {
    sfx.play('bounce', { volume: Math.min(1, impact / 10), rate: 0.92 + Math.random() * 0.14 });
  }
});

/* ================= 主循环 ================= */
const clock = new THREE.Clock();
let acc = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (gameState === 'playing' || gameState === 'result') {
    /* ---- 物理固定步长（1/120s，最多 6 子步防穿模） ---- */
    acc += dt;
    let guard = 6;
    while (acc >= 1 / 120 && guard-- > 0) {
      world.step(1 / 120);
      acc -= 1 / 120;
    }

    /* ---- 玩法更新 ---- */
    machine.update(dt);
    player.update(dt);

    /* ---- 挑战倒计时 ---- */
    if (scoring.mode.timed && !scoring.ended) {
      const justEnd = scoring.tickTimer(dt);
      const sec = Math.ceil(scoring.timeLeft);
      if (sec !== lastSecond && sec <= CFG.challenge.lastSecondTick && sec > 0) {
        lastSecond = sec;
        sfx.play('tick', { volume: 0.8, rate: 1.3 });
      }
      if (justEnd) finishSession();
      ui.setTimer(scoring.timeLeft, scoring.timeLeft / CFG.challenge.duration, scoring.timeLeft <= 10);
    }

    /* ---- HUD ---- */
    const live = scoring.mode.id === 'free'
      ? `运球 ${scoring.dribbleScore} + 投篮 ${scoring.shotScore}`
      : scoring.mode.id === 'dribble'
        ? `失误 ${scoring.dribbleFail}/3 · 完美 ${scoring.perfectHits}`
        : `进 ${scoring.shotMade} / 失 ${scoring.shotFail}/3`;
    ui.setScore(
      scoring.displayScore,
      Math.max(loadRecord(currentModeId), scoring.displayScore),
      live
    );
    ui.setCombos(
      scoring.dribbleCombo, scoring.dribbleMultiplier(),
      scoring.shotCombo, scoring.shotMultiplier()
    );
    ui.setFailDots(scoring.dribbleFail);
  } else if (gameState === 'menu') {
    /* ---- 菜单背景：镜头绕场慢游 + 物理照常 ---- */
    world.step(1 / 60, dt, 3);
    ball.syncFromPhysics();
    menuCamAngle += dt * 0.1;
    const r = 10.5;
    camera.position.set(Math.sin(menuCamAngle) * r, 3.4 + Math.sin(menuCamAngle * 1.7), Math.cos(menuCamAngle) * r - 6);
    camera.lookAt(0, 2.4, RIM_POS.z + 1.5);
  }

  /* ---- 篮网摆动（进球后衰减） ---- */
  if (netSway.t > 0) {
    netSway.t = Math.max(0, netSway.t - dt * 1.6);
    const s = netSway.t * 0.14;
    courtRefs.netGroup.rotation.x = Math.sin(performance.now() / 55) * s;
    courtRefs.netGroup.rotation.z = Math.cos(performance.now() / 70) * s;
  }

  /* ---- 特效与相机后处理 ---- */
  const shakeOff = fx.update(dt);
  if (shakeOff) {
    camera.position.x += shakeOff.x;
    camera.position.y += shakeOff.y;
  }
  bloomPass.strength = CFG.fx.bloomBase + fx.bloomPulse * (CFG.fx.bloomScore - CFG.fx.bloomBase);

  composer.render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

/* ================= 启动 ================= */
ball.startPhysics(new THREE.Vector3(1.4, 1, 0.5), null);
refreshMenu();
tick();

/* ================= 调试/自动化测试钩子 =================
   ?mode=free|dribble|shot 可直接进入对应模式；
   window.GAME 供无头浏览器脚本驱动状态切换截图。 */
try {
  const params = new URLSearchParams(location.search);
  window.GAME = {
    startMode, finishSession, machine, scoring, ui, player, ball, fx, rhythm,
    get state() { return gameState; },
    teleport: (x, z) => { player.pos.set(x, 0, z); },
    dispatch: (evt) => machine.dispatch(evt),
  };
  const m = params.get('mode');
  const demo = params.get('demo'); // dribble|shot：自动演示到对应状态（截图验证用）
  if (m && CFG.MODES[m]) setTimeout(() => startMode(m), 400);
  if (m && demo === 'dribble') {
    setTimeout(() => machine.dispatch('onLeftDown'), 1500);   // 拾球
    setTimeout(() => machine.dispatch('onRightDown'), 2300);  // 开始运球
  }
  if (m && demo === 'shot') {
    setTimeout(() => machine.dispatch('onLeftDown'), 1500);   // 拾球
    setTimeout(() => { player.pos.set(0.5, 0, -8); }, 2000);  // 传送到投篮区
    setTimeout(() => machine.dispatch('onLeftDown'), 2900);   // 按住蓄力
  }
  if (demo === 'result') {
    // 结算弹窗冒烟测试（带假数据）
    setTimeout(() => startMode(m || 'dribble'), 300);
    setTimeout(() => {
      scoring.dribbleScore = 160; scoring.perfectHits = 9; scoring.dribbleComboMax = 7;
      finishSession();
    }, 1200);
  }
} catch { /* 生产环境忽略 */ }
