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
import { createPool } from './pool.js';
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
player.onLand = () => sfx.play('bounce', { volume: 0.3, rate: 0.72 });

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

/* ================= 台球室（同样独立场景，球馆左侧绿门进入） ================= */
const pool = createPool({ camera, player, sfx });
pool.scene.environment = scene.environment;
function enterPool() {
  fadeTo(() => {
    playerLoc = 'pool';
    renderPass.scene = pool.scene;
    hudEl.classList.add('hidden');
    ui.el.cross.classList.add('hidden');     // 台球室里不用准星（导向线就是瞄准器）
    pool.enter();
    sfx.play('ui');
  });
}
function exitPoolToGym() {
  fadeTo(() => {
    pool.exit();
    playerLoc = 'gym';
    renderPass.scene = scene;
    const D = CFG.pool.gymDoor;
    player.pos.set(D.x, 0, D.z - 2.4);
    player.vel.set(0, 0, 0);
    player.freeYaw = Math.atan2(D.x, player.pos.z); // 面向场地中心（与影院出口同一套算法）
    player.freePitch = 0;
    ui.el.cross.classList.remove('hidden');
    ui.showHud(G.modeDef.name, G.modeDef.timed);
  });
}
pool.onExitRequest = exitPoolToGym;
/** 任何"回球馆玩法"的入口前调用：硬切回球馆场景 */
function forceGym() {
  if (playerLoc === 'cinema') cinema.exit();
  else if (playerLoc === 'pool') pool.exit();
  else return;
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
  player.y = 0; player.vy = 0; player.landDip = 0; // 上一局悬空的状态不带进新局
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
  if (playerLoc === 'pool') pool.cancelCharge();
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
  if (k === 'escape' && gameState === 'playing' && playerLoc === 'pool') {
    if (pool.mode === 'aim') pool.onRightDown(); else pauseGame();  // 瞄准中先收杆
    return;
  }
  if (gameState === 'playing' && playerLoc === 'pool' && k === 'e') {
    pool.rerack();
    return;
  }
  if (gameState === 'playing' && playerLoc === 'gym') {
    // 空格=跳跃（拍球已改成持球自动，不再占键）。空格会滚动页面、也会「按下」刚点过的按钮，两样都要挡掉
    if (e.code === 'Space') {
      e.preventDefault();
      document.activeElement?.blur?.();
      if (player.jump()) sfx.play('bounce', { volume: 0.2, rate: 1.62 });
      return;
    }
    if (k === 'e') { machine.dispatch('onGrab'); return; }
  }
  if (k in keys) {
    keys[k] = true;
    if (playerLoc === 'cinema') cinema.onMoveKey(); // 坐着按移动键 -> 起身
    else if (playerLoc === 'pool') pool.onMoveKey(); // 瞄准按移动键 -> 收杆回走动
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
    // 台球室上手：横向鼠标转的是导向线（镜头定在母球后），不是人头
    if (playerLoc === 'pool' && pool.mode !== 'walk') pool.onLook(e.movementX);
    else player.look(e.movementX, e.movementY);
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
  if (playerLoc === 'pool') {
    if (e.button === 0) pool.onLeftDown();
    if (e.button === 2) pool.onRightDown();
    return;
  }
  if (e.button === 0) machine.dispatch('onLeftDown');
  if (e.button === 2) machine.dispatch('onRightDown');
});
addEventListener('mouseup', (e) => {
  if (gameState !== 'playing') return;
  if (e.button === 0 && playerLoc === 'pool') { pool.onLeftUp(); return; }
  if (e.button === 0 && playerLoc === 'gym') machine.dispatch('onLeftUp');
  if (e.button === 0 && playerLoc === 'cinema' && cinema.seated && seatAim.t) {
    if (seatAim.moved < 6) cinema.onClick(e.clientX, e.clientY); // 没拖动 = 点击那块银幕（切出声/暂停）
    seatAim.t = 0;
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  // 玩家按 ESC 或点击外部导致解锁 -> 自动暂停（影院入座本来就不锁，跳过）
  if (document.pointerLockElement !== canvas && gameState === 'playing'
    && (playerLoc === 'gym' || playerLoc === 'pool')) pauseGame();
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
    } else if (playerLoc === 'pool') {
      /* ---- 台球室：台面物理是自研 2D 解算，跟球馆 cannon 世界互不相干 ---- */
      player.update(dt);
      pool.update(dt);   // 必须在 player.update 之后：出杆视角要覆盖玩家相机
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

    /* ---- 两扇侧门入口触发 + 提示 ---- */
    if (gameState === 'playing') {
      const D = CFG.cinema.gymDoor, P = CFG.pool.gymDoor;
      const dDoor = Math.hypot(player.pos.x - D.x, player.pos.z - D.z);
      const dPool = Math.hypot(player.pos.x - P.x, player.pos.z - P.z);
      if (dDoor < D.r) enterCinema();
      else if (dPool < P.r) enterPool();
      else if (dDoor < 3.6) ui.setPrompt('🎬 <b>走进红门</b> 去电影院看场电影');
      else if (dPool < 3.6) ui.setPrompt('🎱 <b>走进绿门</b> 去台球室开一杆');
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
    enterPool, exitPoolToGym, pool,
    get state() { return gameState; },
    get location() { return playerLoc; },
    teleport: (x, z) => { player.pos.set(x, 0, z); },
    dispatch: (evt) => machine.dispatch(evt),
  };
  const m = params.get('mode');
  const demo = params.get('demo'); // shot|result：自动演示（截图验证用）
  if (m && CFG.MODES[m]) setTimeout(() => startMode(m), 400);
  if (params.get('loc') === 'cinema') setTimeout(() => enterCinema(), 1100);
  if (params.get('loc') === 'pool') setTimeout(() => enterPool(), 1100);
  const tp = params.get('tp'); // tp=x,z,yaw[,pitch]：调试传送
  if (tp) setTimeout(() => {
    const [x, z, y, p] = tp.split(',').map(Number);
    GAME.teleport(x, z);
    // 缺参数时 Number() 给 NaN，必须显式挡掉：NaN 进 yaw/pitch 会让相机矩阵报废、整帧纯黑
    if (Number.isFinite(y)) { player.freeYaw = y; player.yaw = y; }
    if (Number.isFinite(p)) { player.freePitch = p; player.pitch = p; }
  }, 2300);
  if (m && demo === 'shot') {
    setTimeout(() => { if (machine.name === 'noBall') machine.dispatch('onGrab'); }, 1500); // E 拾球
    setTimeout(() => { player.pos.set(0.5, 0, -8); }, 2000);  // 传送到投篮区
    setTimeout(() => machine.dispatch('onLeftDown'), 2900);   // 按住蓄力
  }
  if (demo) {
    // 无头断言回读通道：结果写进专用 DOM 节点，再用 --screenshot 读图
    // （任何 demo 分支都可能调 mark()，所以只要有 demo 就先把通道建好）
    var marks = []; // var：下面各 demo 分支在块外，marks/mark 都得能引用到
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
    // 自动化（新键位）：E 拾球 → 持球**自动**拍球（不按键，节拍随 update 累加）→
    // E 弃球（回中圈）→ E 再捡 → 空格跳跃（升→落→落地缓冲）→ 空中蓄力松手（跳投）。
    // 无头 rAF 被限流，靠近判定/拍球节拍/竖直积分这些"要 update 才推进"的量一律手动补帧。
    const toBall = () => {
      ball.syncFromPhysics(); // 先让网格跟刚体对齐，否则按旧位置传送会差一步
      player.pos.set(ball.position.x, 0, ball.position.z + 1.2);
      machine.update(0.016);
    };
    const drive = (n) => { for (let i = 0; i < n; i++) { machine.update(0.016); player.update(0.016); } };
    setTimeout(() => { toBall(); machine.dispatch('onGrab'); mark('pickup'); }, 1200);
    setTimeout(() => { drive(125); mark(`AUTO taps=${scoring.taps}`); }, 1900);
    setTimeout(() => { machine.dispatch('onGrab'); mark('discard'); }, 2500);
    setTimeout(() => { ball.syncFromPhysics(); mark(`dropped ${ball.position.x.toFixed(1)},${ball.position.y.toFixed(1)},${ball.position.z.toFixed(1)}`); }, 2900);
    setTimeout(() => { toBall(); machine.dispatch('onGrab'); mark('regrab'); }, 3300);
    setTimeout(() => {
      const ok = player.jump();
      drive(20);
      const up = player.y;
      drive(45);
      mark(`JUMP ok=${ok ? 1 : 0} up=${up.toFixed(2)} land=${player.y.toFixed(2)} dip=${player.landDip.toFixed(3)}`);
    }, 3900);
    setTimeout(() => {
      machine.dispatch('onLeftDown'); // 先验「右键取消」这条老路没被跳投挤掉
      const from = machine.name;
      machine.dispatch('onRightDown');
      mark(`CANCEL ${from}>${machine.name} ch=${(machine.current?.charge ?? -1).toFixed(2)}`);
    }, 4600);
    setTimeout(() => {
      player.jump();
      drive(14); // 升到 ~0.7m 才出手（真机上就是按住左键起跳再松手）
      const airY = player.y;
      machine.dispatch('onLeftDown');
      if (machine.current) machine.current.charge = 0.8; // 无头下逐帧累加的 charge 近似 0
      drive(4);
      const rel = ball.position.y;
      machine.dispatch('onLeftUp');
      mark(`JUMPSHOT air=${airY.toFixed(2)} rel=${rel.toFixed(2)} fly=${machine.current?.flying ? 1 : 0} taken=${scoring.shotTaken}`);
    }, 5200);
    setTimeout(() => { mark(`final taps=${scoring.taps}`); console.log('DEMO_TAP', marks.join(' | ')); }, 6400);
  }
  if (demo === 'move') {
    // 移动手感断言：起速应在 ~0.2s 内吃到顶速（旧的 accel/speed 写法随帧率漂移）、
    // 松手平滑滑行、反向刹车更快；跳跃 apex/滞空与配置吻合，落地有缓冲且回到地面。
    const drive = (n) => { for (let i = 0; i < n; i++) player.update(0.016); };
    const sp = () => Math.hypot(player.vel.x, player.vel.z);
    setTimeout(() => {
      player.pos.set(0, 0, 6);
      player.vel.set(0, 0, 0);
      player.keys.w = true;
      drive(6); const s10 = sp();
      drive(6); const s20 = sp();
      drive(12); const s40 = sp();
      const walk = 6 - player.pos.z; // 0.4s 内前进的米数（速度积分，验手感用的硬指标）
      player.keys.w = false;
      drive(6); const glide = sp();
      player.keys.s = true;
      drive(12); const braking = sp();
      player.keys.s = false;
      const top = player.speed;
      const ok = player.jump();
      let peak = 0, t = 0;
      while (t < 2 && (player.y > 1e-4 || player.vy > 0)) { drive(1); t += 0.016; peak = Math.max(peak, player.y); }
      drive(30);
      mark(`MOVE top=${top.toFixed(2)} s10=${s10.toFixed(2)} s20=${s20.toFixed(2)} s40=${s40.toFixed(2)}`
        + ` walk=${walk.toFixed(2)}m glide=${glide.toFixed(2)} brake=${braking.toFixed(2)}`
        + ` jump=${ok ? 1 : 0} apex=${peak.toFixed(2)}/${(CFG.player.jumpSpeed ** 2 / (2 * CFG.player.gravity)).toFixed(2)} air=${t.toFixed(2)}`
        + ` back=${player.y.toFixed(2)} dip=${player.landDip.toFixed(3)} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`);
    }, 2000);
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
      el.textContent = `${demo.toUpperCase()} seated=${cinema.seated}`
        + ` bar=${document.getElementById('cinema-bar').classList.contains('hidden') ? 0 : 1}`
        + ` eye=${player.eyeHeight.toFixed(2)} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`
        + ` big=${document.body.classList.contains('big-screen') ? 1 : 0} n=${vs.length}`
        + ` src=${vs.map((v) => ((v.currentSrc || v.src) ? 1 : 0)).join('')}`
        + ` ring=${cinema.debugRing().map((r) => `h${r.h}/a${r.arcDeg}${r.src}`).join(',')}`
        + ` vce=${cinema.debugRing().map((r) => r.voice).join('')}`
        + ` zoom=${fov0.toFixed(1)}>${fovIn.toFixed(1)}>${camera.fov.toFixed(1)}`
        // 马赛克铺法：每格 w x h（px），按各片 ar 加权铺满整屏 —— 断言 Σ行宽=视口宽、Σ行高=视口高
        + ` tile=${vs.map((v) => `${Math.round(Number(v.style.getPropertyValue('--w').replace('px', '')) || 0)}`
          + 'x'
          + Math.round(Number(v.style.getPropertyValue('--h').replace('px', '')) || 0)).join(',')}`
        + ` fit=${vs[0] ? getComputedStyle(vs[0]).objectFit : '-'}`
        + ` cells=${document.querySelectorAll('#big-wall .bwcell').length}`
        + ` add=${document.getElementById('bw-add').classList.contains('hidden') ? 0 : 1}`;
    }, 3400);
  }
  if (demo === 'import') {
    // 「＋ 添加视频」按**这次选了几部**决定动作：1 部＝追加（默认片单那部保留），
    // 多部＝整条替换（旧片单不保留、存档就是这几部）。最后「恢复默认」退回片单。
    const set = (names) => {
      const inp = document.getElementById('cb-add-in');
      Object.defineProperty(inp, 'files', {
        value: names.map((n) => new File([new Blob(['x'], { type: 'video/mp4' })], n, { type: 'video/mp4' })),
        configurable: true,
      });
      inp.dispatchEvent(new Event('change'));
    };
    const ring = () => cinema.debugRing().map((r) => r.src).join('');
    setTimeout(() => set(['demo-one.mp4']), 2600);
    setTimeout(() => mark(`ADD1 n=${document.querySelectorAll('.btv').length} ring=${ring()}`), 3300);
    setTimeout(() => set(['demo-a.mp4', 'demo-b.mp4']), 3900);
    setTimeout(() => {
      const saved = JSON.parse(localStorage.getItem('bb.cinema.screens') || '[]');
      mark(`IMP2 n=${document.querySelectorAll('.btv').length} ring=${ring()}`
        + ` saved=${saved.map((x) => (x ? x.n : '-')).join(',')}`);
    }, 4600);
    // 「恢复默认」应退回片单排布（本地导入的两块屏消失）
    setTimeout(() => { document.getElementById('cb-reset').click(); }, 5200);
    setTimeout(() => {
      mark(`RESET n=${document.querySelectorAll('.btv').length} ring=${ring()}`);
    }, 5800);
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
      // 单部添加：一次 change 只塞一个文件 → 语义是「追加一块幕」（选多部才叫整条替换）
      const inp = document.getElementById('cb-add-in');
      const mk = (n) => new File([new Blob(['x'], { type: 'video/mp4' })], n, { type: 'video/mp4' });
      const one = (n) => {
        Object.defineProperty(inp, 'files', { value: [mk(n)], configurable: true });
        inp.dispatchEvent(new Event('change'));
      };
      one('add-a.mp4');
      setTimeout(() => one('add-b.mp4'), 400);
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
    // 厅形切换：切到正多边形（2 部片 = 三角形，边数下限 3），幕面从柱面片变平面板。
    // ap=内切半径（3~5 边按 polyK 收小）、rc=外接半径、bound=走动 AABB 半宽都要跟着厅形走。
    setTimeout(() => {
      document.getElementById('cb-console').click();
      document.getElementById('cb-shape').click();
    }, 8800);
    setTimeout(() => {
      const r = cinema.debugRing();
      const hall = cinema.debugHall();
      mark(`POLY shape=${hall.shape} edges=${hall.edges} ap=${hall.ap} rc=${hall.rc} bound=${hall.bound}`
        + ` slot0=${r[0] ? r[0].slotDeg : '-'} w0=${r[0] ? r[0].w : '-'} sum=${r.reduce((a, x) => a + x.slotDeg, 0).toFixed(1)}`);
    }, 9600);
    // 换回圆筒：槽位重新等分整圈（2 块屏 = 180°+180°），弧幕回归
    setTimeout(() => { document.getElementById('cb-shape').click(); }, 10100);
    setTimeout(() => {
      const r = cinema.debugRing();
      const hall = cinema.debugHall();
      mark(`ROUND shape=${hall.shape} edges=${hall.edges} ap=${hall.ap} rc=${hall.rc}`
        + ` slot0=${r[0] ? r[0].slotDeg : '-'} w0=${r[0] ? r[0].w : '-'} sum=${r.reduce((a, x) => a + x.slotDeg, 0).toFixed(1)}`);
    }, 10800);
    // 片单快照：换片/加片各记一次；重复片单只「挪到最前」不新增副本 → 三次 playAll 只留 2 份
    setTimeout(() => {
      const l = cinema.debugLists();
      mark(`HIST n=${l.length} parts=${l.map((p) => p.n).join('/')} chips=${document.querySelectorAll('#cc-hist .cc-chip').length} rows=${document.querySelectorAll('#cc-list .ccrow').length}`);
    }, 11400);
    // 点最旧那条 chip（1 部）→ 环上整条换回那一场（含当时的出声设置）
    setTimeout(() => {
      const chips = document.querySelectorAll('#cc-hist .cc-chip');
      if (chips.length) chips[chips.length - 1].click();
    }, 11800);
    setTimeout(() => {
      mark(`BACK rows=${document.querySelectorAll('#cc-list .ccrow').length} btv=${document.querySelectorAll('.btv').length} voice=${cinema.debugRing().map((r) => r.voice).join('')}`);
    }, 12400);
    // 放映条「🚪 退出影院」：厅里没有门了，这是唯一出口 —— 只验接线（转场有淡入淡出，不靠无头帧序）
    setTimeout(() => {
      const orig = cinema.onExitRequest;
      let fired = 0;
      cinema.onExitRequest = () => { fired++; if (orig) orig(); };
      document.getElementById('cb-exit').click();
      mark(`EXIT fired=${fired} door=${document.getElementById('cb-door') ? 1 : 0} share=${document.getElementById('cb-share') ? 1 : 0}`);
      cinema.onExitRequest = orig;
    }, 13200);
  }
  if (demo === 'ring') {
    // 视觉验证「等高 + 铺满一整圈」：导入 ?n= 部假片（blob 解码不了 -> 银幕停在占位卡上，
    // 画面看得见形状），入座正对墙，肉眼即可检查有无空隙/有无高低不齐；&shape=poly 顺便切到
    // 正多边形厅（n 部片 = n 条直墙）
    const cnt = Math.max(1, Number(params.get('n')) || 5);
    const poly = params.get('shape') === 'poly';
    const big = params.get('big') === '1'; // 顺手开平铺视角，验马赛克是否真的铺满视口
    const mix = params.get('mix') === '1'; // 混一部竖版（9:16），看马赛克是否按各自比例分格
    const hole = params.get('hole') === '1'; // 中间挖一个空洞，看空格是否显示「点这里补一部」
    setTimeout(() => {
      // 一次选 cnt 部 → 走「多部＝整条替换」这条语义
      const inp = document.getElementById('cb-add-in');
      const files = Array.from({ length: cnt }, (_, i) => new File([new Blob(['x'], { type: 'video/mp4' })], `demo-${i}.mp4`, { type: 'video/mp4' }));
      Object.defineProperty(inp, 'files', { value: files });
      inp.dispatchEvent(new Event('change'));
      if (mix) cinema.debugSetAr(0, 9 / 16); // blob 元数据解不出来，只能手工喂 ar 再重排
      if (big) document.getElementById('cb-big').click(); // 先开平铺：此时 ✕ 删片是在平铺里点的
      if (hole) cinema.debugHole(1); // 再把第 2 位挖成空洞：平铺里该位变成「＋ 补一部」空格
      player.pos.set(0, 0, CFG.cinema.bed.z + 1.6);
      player.freeYaw = 0; player.yaw = 0;
      cinema.onLeftDown();
      if (poly) document.getElementById('cb-shape').click();
    }, 2600);
    setTimeout(() => {
      const r = cinema.debugRing();
      const hall = cinema.debugHall();
      // 马赛克断言：每格 w x h + 左上角，Σ(最后一格右边界) 应等于视口宽高（无空隙、无黑边）
      const tile = Array.from(document.querySelectorAll('.btv')).map((v) => {
        const p = (k) => Number(v.style.getPropertyValue(k).replace('px', '')) || 0;
        return `${p('--x').toFixed(0)},${p('--y').toFixed(0)} ${p('--w').toFixed(0)}x${p('--h').toFixed(0)}`;
      });
      const last = Array.from(document.querySelectorAll('.btv')).reduce((a, v) => {
        const p = (k) => Number(v.style.getPropertyValue(k).replace('px', '')) || 0;
        return { x: Math.max(a.x, p('--x') + p('--w')), y: Math.max(a.y, p('--y') + p('--h')) };
      }, { x: 0, y: 0 });
      mark(`RING n=${cnt} shape=${hall.shape} edges=${hall.edges} rc=${hall.rc}`
        + ` w=${r.map((x) => x.w).join('/')} arc=${r.map((x) => x.arcDeg).join('/')} sum=${r.reduce((a, x) => a + x.slotDeg, 0).toFixed(1)}`
        + (big ? ` big=${last.x.toFixed(0)}x${last.y.toFixed(0)}/${innerWidth}x${innerHeight}`
          + ` cells=${document.querySelectorAll('#big-wall .bwcell').length} tile=${tile.join(' | ')}` : ''));
    }, 3600);
  }
  if (demo === 'exit') {
    // 厅里已经没有出口门：站在墙边推帧也不该自动传送回去（防残留触发逻辑），
    // 退出只认放映条那颗「🚪 退出影院」。手动推帧是因为无头 rAF 被限流赶不上断言时刻。
    const step = () => {
      if (GAME.location !== 'cinema') return;
      player.pos.set(0, 0, cinema.debugHall().ap - 0.3); // 贴到幕后的墙面上
      cinema.update(0.016);
    };
    // 入场转场比这批定时器晚落地，所以先连着贴墙推 20 帧再断言（覆盖两种厅形都成立）
    if (params.get('shape') === 'poly') setTimeout(() => document.getElementById('cb-shape').click(), 1500);
    for (let i = 0; i < 20; i++) setTimeout(step, 1600 + i * 200);
    setTimeout(() => mark(`nowalk loc=${GAME.location}`), 5800);
    setTimeout(() => { mark(`pre=${GAME.location}`); document.getElementById('cb-exit').click(); }, 6400);
    setTimeout(() => mark(`done loc=${GAME.location} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`), 7800);
  }
  if (demo === 'poolaim') {
    // 定住不出杆，专门给截图看虚线导向：站在球桌长边中段上手，正对 1 号球
    setTimeout(() => {
      player.pos.set(0, 0, 1.5); player.yaw = -Math.PI / 2; player.freeYaw = -Math.PI / 2;
      pool.onLeftDown();
      pool.debugAimAt(1);
    }, 2600);
  }
  if (demo === 'pool') {
    // 台球室回归：摆球 -> 上手 -> 虚线导向预测 -> 一杆实证「预测==实际」-> 撞库/洗袋/收杆
    // 无头下 rAF 被限流，球的推进一律用 pool.debugSettle() 手工步进，断言才是确定的
    const P = () => pool.debugPool();
    setTimeout(() => mark(`RACK live=${P().live} cue=${P().cue} mode=${P().mode} loc=${GAME.location}`), 2200);
    // 走到球桌长边中段，左键上手
    setTimeout(() => {
      player.pos.set(0, 0, 1.5); player.yaw = -Math.PI / 2; player.freeYaw = -Math.PI / 2;
      pool.onLeftDown();
    }, 2600);
    setTimeout(() => {
      pool.debugAimAt(1);
      const g = pool.debugGuide();
      // 视线探针：屏幕正中央必须真的落在台呢上（历史上台身盒顶面高过呢绒，整块台面被木头盖掉）
      const rc = new THREE.Raycaster();
      rc.setFromCamera({ x: 0, y: 0 }, camera);
      const h0 = rc.intersectObjects(pool.scene.children, true)[0];
      const L = pool.debugGuideLine();
      mark(`AIM mode=${P().mode} aimT=${P().aimT} kind=${g.kind} b=${g.ball} t=${g.t} ghost=${g.gx},${g.gz} obj=${g.ox},${g.oz} 主线=${L.n}/${L.len} 目标线=${L.obj} cam=${camera.position.toArray().map((v) => +v.toFixed(2)).join(',')} 正中=${h0 ? `${h0.object.type}:${h0.distance.toFixed(2)}@${h0.point.toArray().map((v) => +v.toFixed(2)).join(',')}` : '空'}`);
    }, 3000);
    // 原地转 90°：线上没球了，应改判为撞库（导向线要跟着换算法）
    setTimeout(() => {
      pool.onLook(1400);
      const g = pool.debugGuide();
      const L = pool.debugGuideLine();
      mark(`TURN kind=${g.kind} t=${g.t} at=${g.gx},${g.gz} 主线=${L.n}/${L.len} 反射线=${L.cush}`);
    }, 3400);
    // 正对 1 号球：母球走直线，实际接触点必须落在导向线画出的幽灵球心上。
    // 先把 1 号球挪到空旷处 —— 贴着球堆测方向会被连锁碰撞搅乱，量不出导向线的准确度。
    // 蓄力/出杆放在同一次任务里做完：无头 rAF 节奏不可控，靠帧累加会把力度漂掉。
    let pred = null;
    setTimeout(() => {
      pool.debugPlace(1, 0.30, 0.16);
      pool.debugAimAt(1);
      pred = { g: pool.debugGuide(), b0: pool.debugBall(1) };
      pool.onLeftDown();
      pool.debugPower(0.55);
      pool.onLeftUp();
      // 1/960 细步（步长=采样间隔，都是 1/960）：母球每步只走 4mm，
      // 「目标球刚起步」那一帧的母球位置才是真实接触点
      let before = null, dep = null;
      for (let i = 0; i < 600 && !dep; i++) {
        before = pool.debugBall(0);
        pool.debugSettle(1 / 960, 1 / 960);
        const b = pool.debugBall(1);
        if (Math.hypot(b.x - pred.b0.x, b.z - pred.b0.z) > 0.004) dep = { c: before, b };
      }
      const r = P();
      const dx = dep ? dep.b.x - pred.b0.x : 0, dz = dep ? dep.b.z - pred.b0.z : 0;
      const raw = Math.hypot(dx, dz);
      const dot = raw > 0.004 ? ((dx / raw) * pred.g.ox + (dz / raw) * pred.g.oz).toFixed(3) : 'NA';
      const err = dep ? Math.hypot(dep.c.x - pred.g.gx, dep.c.z - pred.g.gz).toFixed(4) : 'none';
      mark(`SHOT ghostErr=${err} dir·pred=${dot} cue停=${JSON.stringify([before.vx, before.vz])} live=${r.live} potted=${r.potted} strokes=${r.strokes}`);
      pool.debugSettle(6);   // 再把整桌滚停，验没有球逃出台面
      mark(`REST live=${P().live} mode=${P().mode}`);
    }, 3800);
    // 定点直入袋：把 2 号球摆到「母球 → 左前角袋」那条线上正打，验真进袋 + 计分
    setTimeout(() => {
      pool.rerack();
      pool.debugPlace(2, -0.9885, 0.3535);
      pool.debugAimTo(-1.285, 0.65);
      const g = pool.debugGuide();
      pool.onLeftDown();
      pool.debugPower(0.5);
      pool.onLeftUp();
      pool.debugSettle(4);
      const r = P();
      mark(`POT kind=${g.kind} b=${g.ball} live=${r.live} potted=${r.potted} score=${r.score} fouls=${r.fouls}`);
    }, 4400);
    // 洗袋：先重摆（母球回开球点、球堆归位），再正对左前角袋打母球 → 罚分 + 自动摆回
    setTimeout(() => {
      pool.rerack();
      pool.debugAimTo(-1.285, 0.65);
      const g = pool.debugGuide();
      pool.onLeftDown();
      pool.debugPower(0.42);
      pool.onLeftUp();
      mark(`SCRATCH kind=${g.kind} t=${g.t} cue0=${P().cue}`);
      pool.debugSettle(4);
      const r = P(), c = pool.debugBall(0);
      mark(`POTCUE mode=${r.mode} live=${r.live} fouls=${r.fouls} score=${r.score} cue=${c.x},${c.z} sunk=${c.potted ? 1 : 0}`);
    }, 5000);
    // 收杆回走动 + 球室条常驻
    setTimeout(() => {
      pool.onRightDown();
      pool.debugSettle(0.6);   // 让出杆视角平滑交还第一人称
      const r = P();
      mark(`WALK mode=${r.mode} aimT=${r.aimT} bar=${document.getElementById('pool-bar').classList.contains('hidden') ? 0 : 1} bounds=${player.bounds.maxX.toFixed(1)}`);
    }, 5600);
    // 退出接线：球室条那颗按钮唯一出口
    setTimeout(() => {
      const orig = pool.onExitRequest;
      let fired = 0;
      pool.onExitRequest = () => { fired++; if (orig) orig(); };
      document.getElementById('pb-exit').click();
      pool.onExitRequest = orig;
      mark(`EXIT fired=${fired} rack=${document.getElementById('pb-rack') ? 1 : 0}`);
    }, 9800);
  }
  if (demo === 'rules') {
    // 8 球规则机回归：跳过物理，直接把「这杆进了哪些球 / 先碰到谁 / 有没有洗袋」喂给判定，
    // 于是定组、犯规换手、黑八胜负这些分支都是确定的，不受无头 rAF 节奏影响。
    var R = (x) => JSON.stringify(x);
    var st = () => {
      const p = pool.debugPool();
      return `duel=${p.duel} ph=${p.phase} turn=${p.turn} grp=${p.grp} book=[${p.book}] foul=${p.fb} 黑八标=${document.querySelectorAll('.pbk-grp.eight').length} res=${p.result} chips=${document.querySelectorAll('.pbk-chip').length}`;
    };
    setTimeout(() => { player.pos.set(0, 0, 1.5); pool.debugSetDuel(1); mark(`A 开局 ${st()}`); }, 2200);
    setTimeout(() => { pool.debugRuleShot([4], { first: 1 }); mark(`B 开球进4：不定组、继续出杆 ${st()}`); }, 2600);
    setTimeout(() => { pool.debugRuleShot([3], { first: 3 }); mark(`C 开放台进3：定你=全色 ${st()}`); }, 3000);
    setTimeout(() => { pool.debugRuleShot([11], { first: 11 }); mark(`D 先碰花色：犯规→换手 ${st()}`); }, 3400);
    // 电脑回合：手工步进整桌，应看到它思考 → 导向线扫向目标 → 自己出杆（strokes 自增）
    setTimeout(() => {
      const s0 = pool.debugPool().strokes, b0 = pool.debugBot();
      pool.debugSettle(2.2);
      mark(`E 电脑出杆 strokes=${s0}→${pool.debugPool().strokes} plan=${R(b0)} mode=${pool.debugPool().mode}`);
    }, 4200);
    setTimeout(() => { const s = pool.debugSettle(7); mark(`F 整桌停稳 ph=${s.phase} turn=${s.turn} mode=${s.mode} live=${s.live}`); }, 7000);
    setTimeout(() => {
      pool.debugSetDuel(0);
      const hid = document.getElementById('pb-book').classList.contains('hidden');
      mark(`G 切回自由练台 ${st()} 入库条隐藏=${hid ? 1 : 0}`);
    }, 9000);
    setTimeout(() => {
      pool.debugSetDuel(2); pool.debugRuleShot([1], { first: 1 }); pool.debugRuleShot([8], { first: 2 });
      mark(`H 本组没清完就进黑八→判负 ${st()}`);
    }, 9400);
    setTimeout(() => {
      pool.debugSetDuel(2); pool.debugRuleShot([1], { first: 1 });
      for (const n of [2, 3, 4, 5, 6, 7]) pool.debugRuleShot([n], { first: n });
      const mid = st();
      pool.debugRuleShot([8], { first: 8 });
      mark(`I 清台后一杆黑八→获胜 ${st()}｜清台时 ${mid}`);
    }, 9800);
    setTimeout(() => {
      pool.debugSetDuel(3); pool.debugRuleShot([9], { first: 9 });
      const x = pool.debugRuleShot([10], { first: 10, cue: true });
      mark(`J 进球同时洗袋：犯规→换手 turn=${x.turn} book=[${x.book}] 母球=${R(pool.debugBall(0))}`);
    }, 10200);
    setTimeout(() => {
      const y = pool.debugRuleShot([], { first: -1 });
      mark(`K 空杆：犯规→换手 turn=${y.turn}`);
      document.getElementById('pb-mode').click();
      mark(`L 按钮切玩法 duel=${pool.debugPool().duel} 文案=${document.getElementById('pb-mode').textContent}`);
    }, 10600);
    setTimeout(() => {
      pool.debugSetDuel(1);
      const z = pool.debugRuleShot([8], { first: 1 });
      mark(`M 开球撞进黑八：摆回继续 ph=${z.phase} turn=${z.turn} live=${z.live} book=[${z.book}] eight=${R(pool.debugBall(8))}`);
    }, 11000);
  }
  if (demo === 'book') {
    // 定住给截图看「入库记录」：你 3 颗全色、电脑 2 颗花色，刚轮到你出杆
    setTimeout(() => {
      player.pos.set(0, 0, 1.5);
      pool.debugSetDuel(2);
      pool.debugRuleShot([1], { first: 1 });     // 开球进 1：台面仍开放
      pool.debugRuleShot([2], { first: 2 });     // 定组：你=全色
      pool.debugRuleShot([3], { first: 3 });     // 连进，继续出杆
      pool.debugRuleShot([12], { first: 12 });   // 先碰花色 → 犯规换手
      pool.debugRuleShot([9], { first: 9 });     // 电脑进自己一组
      const r = pool.debugRuleShot([], { first: 10 });  // 电脑空杆 → 交回你
      mark(`BOOK turn=${r.turn} ph=${r.phase} grp=${r.grp} book=[${r.book}] foul=${r.fb}`);
      mark(`  info=${document.getElementById('pb-info').textContent}`);
      mark(`  行1=${document.querySelectorAll('.pbk-row')[0].textContent.replace(/\s+/g, ' ')}`);
      mark(`  行2=${document.querySelectorAll('.pbk-row')[1].textContent.replace(/\s+/g, ' ')}`);
      mark(`  彩片=${document.querySelectorAll('.pbk-chip').length} 花色片=${document.querySelectorAll('.pbk-chip.stripe').length}`);
    }, 2600);
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
