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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { CFG } from './config.js';
import { createPhysics } from './physics.js';
import { buildCourt, setupLights, applyBackground, addWallArt, RIM_POS } from './court.js';
import { createCinema } from './cinema.js';
import { GameBall } from './ball.js';
import { Player } from './player.js';
import { Effects } from './effects.js';
import { StateMachine, NoBallState, HoldState, ShotState, randomShotSpot } from './states.js';
import { ScoreManager, loadRecord, loadSetting, saveSetting, LS_SHADOW, LS_VOLUME } from './scoring.js';
import { Sfx } from './audio.js';
import { UI } from './ui.js';

/* ================= 渲染器 / 场景 / 相机 ================= */
const canvas = document.getElementById('gl');
/** 安全请求指针锁：Chrome 在 ESC 解锁后 ~1s 内再锁会抛 SecurityError 拒绝，静默重试由用户点击兜底 */
function lockPointer() {
  try {
    const p = canvas.requestPointerLock?.();
    if (p && p.catch) p.catch(() => { /* 稍后点击画面再锁 */ });
  } catch (e) { /* 旧浏览器同步抛错同样忽略 */ }
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // 软阴影
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
applyBackground(scene);
/* 室内环境贴图（PMREM）：给漆面地板 / 金属篮圈 / 玻璃篮板提供真实反射 */
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.12, 120);

/* 后期：Bloom 泛光（进球时脉冲增强）
   注意：走 EffectComposer 后 canvas 自身的 antialias 失效，
   必须给 composer 的渲染目标开 MSAA（samples），否则地板标线
   在斜视角下会产生边缘抖动/闪烁。 */
const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composerTarget = new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, composerTarget);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), CFG.fx.bloomBase, 0.55, 0.92);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

/* ================= 世界搭建 ================= */
const courtRefs = buildCourt(scene);
addWallArt(scene);              // imgs/wall 二次元墙贴画（自动生成清单）
const lights = setupLights(scene);
const { world, ballBody, matRim, matBoard } = createPhysics();

const ball = new GameBall(scene, world, ballBody);
const player = new Player(camera);
const fx = new Effects(scene, camera);
const scoring = new ScoreManager();
const sfx = new Sfx();
const ui = new UI();

/* ================= 电影院（独立场景 + 过场切换） ================= */
const cinema = createCinema({ camera, player, sfx });
cinema.scene.environment = scene.environment;   // 复用 PMREM 环境贴图
let playerLoc = 'gym';                            // gym | cinema
let fading = false;
const fadeEl = document.getElementById('fade');
const hudEl = document.getElementById('hud');

function fadeTo(swap) {
  if (fading) return;
  fading = true;
  fadeEl.classList.add('on');
  setTimeout(() => {
    swap();
    setTimeout(() => { fadeEl.classList.remove('on'); fading = false; }, 120);
  }, 420);
}
function enterCinema() {
  fadeTo(() => {
    playerLoc = 'cinema';
    renderPass.scene = cinema.scene;
    hudEl.classList.add('hidden');
    cinema.enter();
    cinema.ensurePlaylist();
    sfx.play('ui');
  });
}
function exitCinemaToGym() {
  fadeTo(() => {
    cinema.exit();
    playerLoc = 'gym';
    renderPass.scene = scene;
    const D = CFG.cinema.gymDoor;
    player.pos.set(D.x, 0, D.z - 2.4);
    player.vel.set(0, 0, 0);
    player.freeYaw = Math.atan2(D.x, player.pos.z); // 面向场地中心（yaw=atan2(-dx,-dz) 化简）
    player.freePitch = 0;
    ui.showHud(G.modeDef.name, G.modeDef.timed);
  });
}
cinema.onExitRequest = exitCinemaToGym;
/** 任何"回球馆玩法"的入口前调用：硬切回球馆场景 */
function forceGym() {
  if (playerLoc === 'gym') return;
  cinema.exit();
  playerLoc = 'gym';
  renderPass.scene = scene;
  fadeEl.classList.remove('on');
  fading = false;
}

/* ================= 状态机装配 ================= */
const netSway = { t: 0 };
const G = {
  camera, player, ball, scoring, sfx, fx, ui,
  modeDef: CFG.MODES.free,
  netSway: () => { netSway.t = 1; },
};
const machine = new StateMachine();
machine.register('noBall', new NoBallState(G));
machine.register('hold', new HoldState(G));
machine.register('shot', new ShotState(G));
G.machine = machine;

/* ================= 游戏流程状态：menu | playing | paused | result ================= */
let gameState = 'menu';
let currentModeId = 'free';
let menuCamAngle = 0;
let lastSecond = -1;
let bestCache = 0; // 当前模式纪录缓存：避免逐帧读 localStorage

function refreshMenu() {
  forceGym();
  gameState = 'menu';
  machine.set('noBall');
  ball.startPhysics(new THREE.Vector3(1.4, 1, 0.5), null);
  ui.showMenu({ free: loadRecord('free'), shot: loadRecord('shot') });
  ui.setShadowChecked(shadowOn);
  document.exitPointerLock?.();
}

function startMode(id) {
  sfx.init();               // 用户手势内初始化 AudioContext
  forceGym();
  currentModeId = id;
  G.modeDef = CFG.MODES[id];
  bestCache = loadRecord(id);
  scoring.reset(G.modeDef);
  player.vel.set(0, 0, 0);
  player.freeYaw = 0; player.freePitch = 0;
  player.yaw = 0; player.pitch = 0;
  player.exitShotAim();
  player.mode = 'free'; player.blend = 0;
  if (id === 'shot') {
    // 投篮挑战：直接空投到随机投篮点，球已在手（周围 1.5m 小圈可自由走位）
    const spot = randomShotSpot();
    player.pos.set(spot.x, 0, spot.z);
    scoring.currentSpot = spot;
    ball.startHeld();
    machine.set('shot');
  } else {
    player.pos.set(0.6, 0, 1.5);
    ball.startPhysics(new THREE.Vector3(1.2, 0.8, 0.4), null);
    machine.set('noBall');
  }
  gameState = 'playing';
  lastSecond = -1;
  ui.showHud(G.modeDef.name, G.modeDef.timed);
  ui.hideResult();
  ui.showPause(false);
  lockPointer();
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
  lockPointer();
}

/** 结算（倒计时归零 / 自由模式手动结束共用） */
function finishSession() {
  if (gameState === 'result') return;
  gameState = 'result';
  player.inputEnabled = false;
  machine.dispatch('onLeftUp');
  ball.startHeld(); // 结算时无论球在哪（飞行中）都收回手中，避免悬空或乱滚
  machine.set('hold');
  const fin = scoring.finalize();
  if (fin.isNew) bestCache = fin.best;
  sfx.play('buzzer', { volume: 0.8 });
  const m = scoring.mode;
  const scoreLabel = m.id === 'free' ? '总分（拍球+投篮）' : '投篮得分';
  const stats = [];
  stats.push(`👋 拍球 <b>${scoring.taps}</b> 次（+${scoring.tapScore} 分）`);
  if (m.shotScore) {
    const pct = scoring.shotTaken ? Math.round((scoring.shotMade / scoring.shotTaken) * 100) : 0;
    stats.push(`🎯 投篮 <b>${scoring.shotMade}</b> / <b>${scoring.shotTaken}</b> 中（命中率 <b>${pct}%</b>）· 最高连击 <b>${scoring.shotComboMax}</b>`);
  }
  if (m.id === 'shot') stats.push(`🎲 命中换位 <b>${scoring.spots}</b> 次`);
  stats.push(`🕘 ${m.timed ? `用时 ${CFG.challenge.duration}s 倒计时结束` : '自由练习'}`);
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
  // 材质可能是数组（球馆外壳六面各一个材质），必须逐项标脏才会重编译
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) m.needsUpdate = true;
  });
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
  if (k === 'escape' && gameState === 'playing' && playerLoc === 'cinema') {
    // 影院补一个 ESC 语义：入座时起身；走动时弹暂停（与球馆一致）
    if (cinema.seated) cinema.onRightDown(); else pauseGame();
    return;
  }
  if (k in keys) {
    keys[k] = true;
    if (playerLoc === 'cinema') cinema.onMoveKey(); // 坐着按移动键 -> 起身
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
});
/* 沙发上（未锁指针）区分「点击选屏」与「拖拽转向」：按下记起点，累计位移小于 6px 才算点击 */
const seatAim = { x: 0, y: 0, t: 0, moved: 0, set(x, y) { this.x = x; this.y = y; this.t = performance.now(); this.moved = 0; } };
document.addEventListener('mousemove', (e) => {
  if (gameState !== 'playing') return;
  if (document.pointerLockElement === canvas) {
    player.look(e.movementX, e.movementY);
  } else if (playerLoc === 'cinema' && cinema.seated && (e.buttons & 1) && e.target === canvas) {
    // 沙发上未锁指针：按住左键拖拽转向（任意角度环视环墙银幕）
    player.look(e.movementX, e.movementY);
    if (seatAim.t) seatAim.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
  }
});
/* 入座后滚轮 = 变焦（拉近/拉远巨幕）；未入座时一律不拦，页面自身不滚动 */
addEventListener('wheel', (e) => {
  if (gameState !== 'playing' || playerLoc !== 'cinema' || !cinema.seated) return;
  e.preventDefault();
  cinema.onWheel(e.deltaY);
}, { passive: false });
canvas.addEventListener('mousedown', (e) => {
  if (gameState !== 'playing') return;
  if (document.pointerLockElement !== canvas) {
    // 影院入座时故意解锁；走动中丢了锁 -> 点画面找回
    if (playerLoc === 'cinema') {
      if (cinema.seated) { if (!e.button) seatAim.set(e.clientX, e.clientY); } // 松手时再判定是点击还是拖拽转向
      else if (!e.button) cinema.onLeftDown();
      else lockPointer();
    }
    return;
  }
  if (playerLoc === 'cinema') {
    if (e.button === 0) cinema.onLeftDown();
    if (e.button === 2) cinema.onRightDown();
    return;
  }
  if (e.button === 0) machine.dispatch('onLeftDown');
  if (e.button === 2) machine.dispatch('onRightDown');
});
addEventListener('mouseup', (e) => {
  if (gameState !== 'playing') return;
  if (e.button === 0 && playerLoc === 'gym') machine.dispatch('onLeftUp');
  if (e.button === 0 && playerLoc === 'cinema' && cinema.seated && seatAim.t) {
    if (seatAim.moved < 6) cinema.onClick(e.clientX, e.clientY); // 没拖动 = 点击那块银幕（切出声/暂停）
    seatAim.t = 0;
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  // 玩家按 ESC 或点击外部导致解锁 -> 自动暂停（影院入座本来就不锁，跳过）
  if (document.pointerLockElement !== canvas && gameState === 'playing' && playerLoc === 'gym') pauseGame();
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

/* 自适应画质：连续 3 秒低于 40fps 就降一档渲染分辨率（不改任何玩法参数）。
   档位：min(dpr,1.75) -> min(dpr,1.25) -> 1.0。帧率恢复也不回升，避免来回抖动。 */
let fpsEMA = 60, lowFpsT = 0, qualityStep = 0;
function adaptQuality(dt) {
  if (gameState !== 'playing' || dt > 0.2) return; // 切走/卡顿尖峰不采样
  fpsEMA += (1 / Math.max(dt, 1e-4) - fpsEMA) * Math.min(1, dt * 2);
  if (fpsEMA < 40) {
    lowFpsT += dt;
    if (lowFpsT > 3 && qualityStep < 2) {
      qualityStep++;
      renderer.setPixelRatio(qualityStep === 1 ? Math.min(devicePixelRatio, 1.25) : 1);
      renderer.setSize(innerWidth, innerHeight);
      const pr = renderer.getPixelRatio();
      composer.setSize(innerWidth * pr, innerHeight * pr);
      fpsEMA = 55; lowFpsT = 0;
    }
  } else {
    lowFpsT = Math.max(0, lowFpsT - dt);
  }
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (gameState === 'playing' || gameState === 'result') {
    if (playerLoc === 'cinema') {
      /* ---- 影院：只有走动/入座/放映逻辑，球馆物理与状态机挂起 ---- */
      player.update(dt);
      cinema.update(dt);
    } else {
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

    /* ---- 电影院入口触发 + 提示 ---- */
    if (gameState === 'playing') {
      const D = CFG.cinema.gymDoor;
      const dDoor = Math.hypot(player.pos.x - D.x, player.pos.z - D.z);
      if (dDoor < D.r) enterCinema();
      else if (dDoor < 3.6) ui.setPrompt('🎬 <b>走进红门</b> 去电影院看场电影');
    }

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
    const curDist = Math.hypot(player.pos.x - RIM_POS.x, player.pos.z - RIM_POS.z);
    const dMul = ScoreManager.distanceMultiplier(curDist).toFixed(1);
    const live = scoring.mode.id === 'free'
      ? `拍球 ${scoring.taps} 次 · 投篮 ${scoring.shotMade}/${scoring.shotTaken} · 当前距离×${dMul}`
      : `进 ${scoring.shotMade} · 换位 ${scoring.spots} 次 · 当前距离×${dMul}`;
    ui.setScore(
      scoring.displayScore,
      Math.max(bestCache, scoring.displayScore),
      live
    );
    ui.setCombos(scoring.shotCombo, scoring.shotMultiplier());
    }
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

  adaptQuality(dt);
  composer.render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // composer.setSize 不乘 pixelRatio，需手动传物理像素尺寸，否则缩放窗口后模糊抖动
  const pr = renderer.getPixelRatio();
  composer.setSize(innerWidth * pr, innerHeight * pr);
});

/* ================= 启动 ================= */
ball.startPhysics(new THREE.Vector3(1.4, 1, 0.5), null);
refreshMenu();
tick();

/* ================= 调试/自动化测试钩子 =================
   ?mode=free|shot 可直接进入对应模式；
   window.GAME 供无头浏览器脚本驱动状态切换截图。 */
try {
  const params = new URLSearchParams(location.search);
  window.GAME = {
    startMode, finishSession, machine, scoring, ui, player, ball, fx,
    enterCinema, exitCinemaToGym, cinema,
    get state() { return gameState; },
    get location() { return playerLoc; },
    teleport: (x, z) => { player.pos.set(x, 0, z); },
    dispatch: (evt) => machine.dispatch(evt),
  };
  const m = params.get('mode');
  const demo = params.get('demo'); // shot|result：自动演示（截图验证用）
  if (m && CFG.MODES[m]) setTimeout(() => startMode(m), 400);
  if (params.get('loc') === 'cinema') setTimeout(() => enterCinema(), 1100);
  const tp = params.get('tp'); // tp=x,z,yaw[,pitch]：调试传送
  if (tp) setTimeout(() => {
    const [x, z, y, p] = tp.split(',').map(Number);
    GAME.teleport(x, z);
    // 缺参数时 Number() 给 NaN，必须显式挡掉：NaN 进 yaw/pitch 会让相机矩阵报废、整帧纯黑
    if (Number.isFinite(y)) { player.freeYaw = y; player.yaw = y; }
    if (Number.isFinite(p)) { player.freePitch = p; player.pitch = p; }
  }, 2300);
  if (m && demo === 'shot') {
    setTimeout(() => { if (machine.name === 'noBall') machine.dispatch('onLeftDown'); }, 1500); // 拾球
    setTimeout(() => { player.pos.set(0.5, 0, -8); }, 2000);  // 传送到投篮区
    setTimeout(() => machine.dispatch('onLeftDown'), 2900);   // 按住蓄力
  }
  if (demo) {
    // 无头断言回读通道：结果写进专用 DOM 节点，再用 --screenshot 读图
    // （任何 demo 分支都可能调 mark()，所以只要有 demo 就先把通道建好）
    const marks = [];
    let dbg = document.getElementById('dbg-out');
    if (!dbg) {
      dbg = document.createElement('div');
      dbg.id = 'dbg-out';
      dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;color:#0f0;font:16px monospace;background:#000;padding:4px 8px';
      document.body.appendChild(dbg);
    }
    var mark = (s) => { // eslint-disable-line no-var
      const cur = machine.current;
      const extra = cur && cur.charging !== undefined ? `[ch=${cur.charging?1:0},${(cur.charge ?? 0).toFixed(2)},fly=${cur.flying?1:0}]` : '';
      marks.push(`${Math.round(performance.now())}:${s}(${machine.name},t${scoring.taps},s${scoring.shotTaken})${extra}`);
      dbg.textContent = marks.join(' | ');
    };
    // 任何 demo 分支跑飞了都要能在截图里看见，而不是留下一张莫名其妙的黑图
    addEventListener('error', (e) => mark(`ERR ${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`));
  }
  if (demo === 'save') {
    // 两段式持久化断言：写死「环上 5 部片（第 1/3/5 有片、第 2/4 是空洞）」，
    // 第二次启动应复原成 n=5 src=10101，且各块屏等高 6.8、槽位圆心角 69.2°。
    // 出声名单按「片名」存（不是下标）：默认把片单里的片名全点上 → 还原后 vce 应与 src 一致（10101）；
    // 加 ?voice=ghost 则存一个不存在的片名，还原时匹配不到 → 回退成 vce=10000（第一块有片的屏出声）。
    // 延迟到默认片源的 loadedmetadata（会回调 saveLayout 覆盖）之后再写，保证这条 5 槽是最后一次写入。
    setTimeout(() => {
      const L = window.BB_VIDEOS || [];
      const rec = (i) => (L[i % L.length] ? { n: L[i % L.length].name, k: 0 } : null);
      const list = L.length ? [rec(0), null, rec(1), null, rec(2)] : [];
      localStorage.setItem('bb.cinema.screens', JSON.stringify(list));
      // ?voice=ghost → 存一个环上不存在的片名，第二次启动应回退到「第一块有片的屏」出声
      const v = params.get('voice') === 'ghost' ? ['__missing__.mp4'] : L.map((x) => x.name);
      localStorage.setItem('bb.cinema.voices', JSON.stringify(v));
      mark(`SAVED n=${list.length} ${L.map((x) => x.name).join(',') || '(片单空)'}`);
    }, 2000);
  }
  if (demo === 'tap') {
    // 自动化：走到球边 → 左键拾球 → 右键拍球 → 左键蓄力 → 松手出手，断言计分链路
    setTimeout(() => {
      player.pos.set(ball.position.x, 0, ball.position.z + 1.2); // 球会滚，先贴到球边上
      if (machine.name === 'noBall') machine.dispatch('onLeftDown');
      mark('pickup');
    }, 1200);
    setTimeout(() => { machine.dispatch('onRightDown'); mark('tap1'); }, 1800);
    setTimeout(() => { machine.dispatch('onRightDown'); mark('tap2'); }, 2600);
    setTimeout(() => { machine.dispatch('onLeftDown'); mark('charge'); }, 3400);
    // 无头环境 rAF 被限流（本例仅 ~6 帧），逐帧累加的 charge 近似为 0；
    // 手动置为 0.8 以验证「松手出手」路径（真机按住 0.8s 即为此值）
    setTimeout(() => { if (machine.current) machine.current.charge = 0.8; mark('setcharge'); }, 4200);
    setTimeout(() => { machine.dispatch('onLeftUp'); mark('release'); }, 4400);
    setTimeout(() => { mark('final'); console.log('DEMO_TAP', marks.join(' | ')); }, 6000);
  }
  if (demo === 'sit' || demo === 'grid') {
    // 公共：走到圆床边 + 左键入座（可选再开大屏墙），供两种演示复用
    addEventListener('error', (e) => {
      const el = document.getElementById('dbg-out');
      if (el) el.textContent = `ERR ${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`;
    });
    setTimeout(() => {
      player.pos.set(0, 0, CFG.cinema.bed.z + 1.6);
      // 面朝 -z（θ=180°）：那块银幕正对着玩家，座下就是圆床
      player.freeYaw = 0; player.yaw = 0;
      cinema.onLeftDown();
      if (demo === 'grid') document.getElementById('cb-big').click();
    }, 2600);
    setTimeout(() => {
      const fov0 = camera.fov;
      cinema.onWheel(-120); cinema.onWheel(-120); cinema.onWheel(-120);
      const fovIn = camera.fov;
      cinema.onWheel(120);
      const el = document.getElementById('dbg-out');
      const vs = Array.from(document.querySelectorAll('.btv'));
      const vs0 = vs[0]?.style;
      el.textContent = `${demo.toUpperCase()} seated=${cinema.seated}`
        + ` bar=${document.getElementById('cinema-bar').classList.contains('hidden') ? 0 : 1}`
        + ` eye=${player.eyeHeight.toFixed(2)} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`
        + ` big=${document.body.classList.contains('big-screen') ? 1 : 0} n=${vs.length}`
        + ` src=${vs.map((v) => ((v.currentSrc || v.src) ? 1 : 0)).join('')}`
        + ` ring=${cinema.debugRing().map((r) => `h${r.h}/a${r.arcDeg}${r.src}`).join(',')}`
        + ` vce=${cinema.debugRing().map((r) => r.voice).join('')}`
        + ` zoom=${fov0.toFixed(1)}>${fovIn.toFixed(1)}>${camera.fov.toFixed(1)}`
        + ` grid=${vs0?.getPropertyValue('--cols') || '-'}x${vs0?.getPropertyValue('--rows') || '-'}`;
    }, 3400);
  }
  if (demo === 'import') {
    // 多选导入＝整条替换：造两个假 File 走同一条 change 通道，断言环上只剩这 2 部
    // （默认片单那 1 部不再保留），且存档列表就是这两部；随后「恢复默认」退回片单。
    setTimeout(() => {
      const inp = document.getElementById('cb-file-in');
      const mk = (n) => new File([new Blob(['x'], { type: 'video/mp4' })], n, { type: 'video/mp4' });
      Object.defineProperty(inp, 'files', { value: [mk('demo-a.mp4'), mk('demo-b.mp4')] });
      inp.dispatchEvent(new Event('change'));
    }, 2600);
    setTimeout(() => {
      const saved = JSON.parse(localStorage.getItem('bb.cinema.screens') || '[]');
      mark(`IMP n=${document.querySelectorAll('.btv').length}`
        + ` ring=${cinema.debugRing().map((r) => r.src).join('')}`
        + ` saved=${saved.map((x) => (x ? x.n : '-')).join(',')}`);
    }, 3400);
    // 「恢复默认」应退回片单排布（本地导入的两块屏消失）
    setTimeout(() => { document.getElementById('cb-reset').click(); }, 4200);
    setTimeout(() => {
      mark(`RESET n=${document.querySelectorAll('.btv').length}`
        + ` ring=${cinema.debugRing().map((r) => r.src).join('')}`);
    }, 4800);
  }
  if (demo === 'wall') {
    // 统一控制台 + 多路出声：入座→开控制台→追加 2 部→勾 3 路出声→删 1 部→整体静音/还原→收条唤回。
    // aud= 直接读每个 <video> 的真实放行状态（!muted && volume>0），这才是要验的东西：
    // 旧模型 rebuild 把非焦点屏 volume 写 0、tapScreen 又只改 muted，所以点了永远不出声。
    const spk = () => document.querySelectorAll('#cc-list .cc-spk');
    const st = () => `rows=${document.querySelectorAll('#cc-list .ccrow').length}`
      + ` voice=${cinema.debugRing().map((r) => r.voice).join('')}`
      + ` aud=${Array.from(document.querySelectorAll('.btv')).map((v) => (!v.muted && v.volume > 0 ? 1 : 0)).join('')}`
      + ` btv=${document.querySelectorAll('.btv').length}`;
    setTimeout(() => {
      player.pos.set(0, 0, CFG.cinema.bed.z + 1.6);
      player.freeYaw = 0; player.yaw = 0;
      cinema.onLeftDown();
      document.getElementById('cb-console').click();
    }, 2600);
    setTimeout(() => {
      const inp = document.getElementById('cb-add-in');
      const mk = (n) => new File([new Blob(['x'], { type: 'video/mp4' })], n, { type: 'video/mp4' });
      Object.defineProperty(inp, 'files', { value: [mk('add-a.mp4'), mk('add-b.mp4')] });
      inp.dispatchEvent(new Event('change'));
    }, 3400);
    setTimeout(() => mark(`P1 ${st()} open=${document.getElementById('cinema-console').classList.contains('hidden') ? 0 : 1}`), 4200);
    setTimeout(() => { const b = spk(); b[1].click(); b[2].click(); }, 5000); // 三部一起出声
    setTimeout(() => mark(`P2 ${st()}`), 5600);
    setTimeout(() => document.querySelector('#cc-list .cc-kill').click(), 6200); // 删第一部
    setTimeout(() => mark(`P3 ${st()}`), 6800);
    setTimeout(() => {
      document.getElementById('cc-mute').click();
      const muted = cinema.debugRing().map((r) => r.voice).join('');
      document.getElementById('cc-mute').click();
      mark(`MUTE off=${muted} back=${cinema.debugRing().map((r) => r.voice).join('')}`);
    }, 7400);
    setTimeout(() => {
      document.getElementById('cb-hide').click();
      const hidden = document.getElementById('cinema-bar').classList.contains('hidden') ? 1 : 0;
      const cc = document.getElementById('cinema-console').classList.contains('hidden') ? 0 : 1;
      const ghost = document.getElementById('cb-ghost').classList.contains('hidden') ? 0 : 1;
      document.getElementById('cb-ghost').click();
      const back = document.getElementById('cinema-bar').classList.contains('hidden') ? 0 : 1;
      mark(`BAR hide=${hidden} console=${cc} ghost=${ghost} back=${back}`);
    }, 8000);
  }
  if (demo === 'ring') {
    // 视觉验证「等高 + 铺满一整圈」：导入 ?n= 部假片（blob 解码不了 -> 银幕停在占位卡上，
    // 画面看得见弧度），入座正对环墙，肉眼即可检查有无空隙/有无高低不齐
    const cnt = Math.max(1, Number(params.get('n')) || 5);
    setTimeout(() => {
      const inp = document.getElementById('cb-file-in');
      const files = Array.from({ length: cnt }, (_, i) => new File([new Blob(['x'], { type: 'video/mp4' })], `demo-${i}.mp4`, { type: 'video/mp4' }));
      Object.defineProperty(inp, 'files', { value: files });
      inp.dispatchEvent(new Event('change'));
      player.pos.set(0, 0, CFG.cinema.bed.z + 1.6);
      player.freeYaw = 0; player.yaw = 0;
      cinema.onLeftDown();
    }, 2600);
    setTimeout(() => {
      mark(`RING n=${cnt} arc=${cinema.debugRing().map((r) => r.arcDeg).join('/')} sum=${cinema.debugRing().reduce((a, r) => a + r.arcDeg, 0).toFixed(1)}`);
    }, 3600);
  }
  if (demo === 'exit') {
    // 出口门：把玩家挪到门洞口（θ=0 的 +z 侧）并手动推帧（无头 rAF 被限流，靠自然
    // 帧序赶不上断言时刻）。进厅转场的 fadeTo 有 fading 互斥，故多推几次直到真的转回去。
    const step = () => {
      if (GAME.location !== 'cinema') return;
      player.pos.set(0, 0, CFG.cinema.ring.r - 0.9);
      cinema.update(0.016);
    };
    setTimeout(() => { step(); mark(`door d=${Math.hypot(player.pos.x, player.pos.z - CFG.cinema.ring.r).toFixed(2)} loc=${GAME.location}`); }, 2400);
    setTimeout(step, 3000);
    setTimeout(step, 3600);
    setTimeout(() => mark(`done loc=${GAME.location} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`), 4600);
  }
  if (demo === 'pause') {
    // 断言：解锁回调的守卫条件（历史上误用过 window.location，恒 false）。
    // 无头下 pointer lock 从未真正获得，exitPointerLock 不产生 change 事件，
    // 故直接派发合成事件走同一回调；条件为真时应弹出暂停面板。
    setTimeout(() => { mark(`lock=${document.pointerLockElement ? 1 : 0}`); document.dispatchEvent(new Event('pointerlockchange')); }, 1600);
    setTimeout(() => { mark(`paused=${document.getElementById('pause').classList.contains('hidden') ? 0 : 1}`); }, 2600);
  }
  if (demo === 'result') {
    // 结算弹窗冒烟测试（带假数据）
    setTimeout(() => startMode(m || 'shot'), 300);
    setTimeout(() => {
      scoring.shotScore = 210; scoring.shotMade = 7; scoring.shotTaken = 11;
      scoring.shotComboMax = 5; scoring.spots = 7;
      finishSession();
    }, 1200);
  }
} catch { /* 生产环境忽略 */ }
