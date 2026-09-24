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
  ball.startHeld(); // 结算时无论球在哪（飞行中）都收回手中，避免悬空或乱滚
  machine.set('hold');
  const fin = scoring.finalize();
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
  if (k in keys) {
    keys[k] = true;
    if (playerLoc === 'cinema') cinema.onMoveKey(); // 坐着按移动键 -> 起身
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
});
document.addEventListener('mousemove', (e) => {
  if (gameState !== 'playing') return;
  if (document.pointerLockElement === canvas) {
    player.look(e.movementX, e.movementY);
  } else if (playerLoc === 'cinema' && cinema.seated && (e.buttons & 1) && e.target === canvas) {
    // 沙发上未锁指针：按住左键拖拽转向（任意角度环视四面墙）
    player.look(e.movementX, e.movementY);
  }
});
canvas.addEventListener('mousedown', (e) => {
  if (gameState !== 'playing') return;
  if (document.pointerLockElement !== canvas) {
    // 影院入座时故意解锁；走动中丢了锁 -> 点画面找回
    if (playerLoc === 'cinema') {
      if (!cinema.seated && !e.button) cinema.onLeftDown();
      else if (!cinema.seated) canvas.requestPointerLock?.();
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
  if (gameState === 'playing' && playerLoc === 'gym' && e.button === 0) machine.dispatch('onLeftUp');
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
      Math.max(loadRecord(currentModeId), scoring.displayScore),
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
    if (!Number.isNaN(y)) { player.freeYaw = y; player.yaw = y; }
    if (!Number.isNaN(p)) { player.freePitch = p; player.pitch = p; }
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
    // 公共：走到沙发边 + 左键入座（可选再开四宫格），供两种演示复用
    addEventListener('error', (e) => {
      const el = document.getElementById('dbg-out');
      if (el) el.textContent = `ERR ${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`;
    });
    setTimeout(() => {
      player.pos.set(0, 0, CFG.cinema.sofa.z + 1.6);
      player.freeYaw = -Math.PI / 2; player.yaw = -Math.PI / 2;
      cinema.onLeftDown();
      if (demo === 'grid') document.getElementById('cb-big').click();
    }, 2600);
    setTimeout(() => {
      const el = document.getElementById('dbg-out');
      const vs = Array.from(document.querySelectorAll('.btv'));
      el.textContent = `${demo.toUpperCase()} seated=${cinema.seated}`
        + ` bar=${document.getElementById('cinema-bar').classList.contains('hidden') ? 0 : 1}`
        + ` eye=${player.eyeHeight.toFixed(2)} pos=${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)}`
        + ` big=${document.body.classList.contains('big-screen') ? 1 : 0} n=${vs.length}`
        + ` src=${vs.map((v) => ((v.currentSrc || v.src) ? 1 : 0)).join('')}`;
    }, 3400);
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
