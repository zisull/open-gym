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
import { StateMachine, NoBallState, HoldState, ShotState, randomShotSpot, shotSpotXZ } from './states.js';
import { ScoreManager, loadRecord, loadSetting, saveSetting, loadNumberSetting, LS_SHADOW, LS_VOLUME } from './scoring.js';
import { Sfx } from './audio.js';
import { UI, lockPointer } from './ui.js';

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
player.onLand = () => sfx.play('bounce', { volume: 0.3, rate: 0.72 });

/* ================= 电影院 / 台球室（各自独立场景 + 过场切换） ================= */
const cinema = createCinema({ camera, player, sfx });
cinema.scene.environment = scene.environment;   // 复用 PMREM 环境贴图
const pool = createPool({ camera, player, sfx });
pool.scene.environment = scene.environment;
let playerLoc = 'gym';                            // gym | cinema | pool
let fading = false;
const fadeEl = document.getElementById('fade');
const hudEl = document.getElementById('hud');

const FADE_BLACK = 420;   // 黑幕压住换场景的脏帧
const FADE_TAIL = 120;
let fadeTimerA = 0, fadeTimerB = 0;

function fadeTo(swap) {
  if (fading) return;
  fading = true;
  fadeEl.classList.add('on');
  fadeTimerA = setTimeout(() => {
    fadeTimerA = 0;
    swap();
    fadeTimerB = setTimeout(() => { fadeTimerB = 0; fadeEl.classList.remove('on'); fading = false; }, FADE_TAIL);
  }, FADE_BLACK);
}
/** 掐掉还没落地的换场景：黑幕中途回主菜单，若不取消，420ms 后人会凭空被塞进房间 */
function cancelFade() {
  clearTimeout(fadeTimerA); clearTimeout(fadeTimerB);
  fadeTimerA = fadeTimerB = 0;
}

/* ---- 房间表：进出的公共动作（换渲染场景、藏球馆 HUD）写一份，差异只落在表里 ----
   曾经四段复制粘贴，其中一段漏了收入库条 —— 多房间就靠这张表对齐。 */
const DOOR_C = CFG.cinema.gymDoor;
const DOOR_P = CFG.pool.gymDoor;
// 门触发/提示的阈值一次算成平方值：球馆主循环里不再出现开方
const DOOR_C_R2 = DOOR_C.r * DOOR_C.r, DOOR_C_HINT2 = DOOR_C.hint * DOOR_C.hint;
const DOOR_P_R2 = DOOR_P.r * DOOR_P.r, DOOR_P_HINT2 = DOOR_P.hint * DOOR_P.hint;
const DOOR_SPAWN = 2.4;   // 离开门回球馆时落在门后这么远，免得又被门立即吸回去
const HINT_CINEMA = '🎬 <b>走进红门</b> 去电影院看场电影';
const HINT_POOL = '🎱 <b>走进绿门</b> 去台球室开一杆';
/** 门边提示：走到门附近就顶替常规操作提示。状态机与主循环共用这一个出处，才不会同帧两次改写 HUD */
function doorHint() {
  const cdx = player.pos.x - DOOR_C.x, cdz = player.pos.z - DOOR_C.z;
  const pdx = player.pos.x - DOOR_P.x, pdz = player.pos.z - DOOR_P.z;
  if (cdx * cdx + cdz * cdz < DOOR_C_HINT2) return HINT_CINEMA;
  if (pdx * pdx + pdz * pdz < DOOR_P_HINT2) return HINT_POOL;
  return '';
}
const ROOMS = {
  cinema: {
    door: DOOR_C,
    api: cinema,
    enter: () => { cinema.enter(); cinema.ensurePlaylist(); },
    leave: () => cinema.exit(),
  },
  pool: {
    door: DOOR_P,
    api: pool,
    // 台球室不用准星（导向线就是瞄准器），离场再还回来
    enter: () => { ui.el.cross.classList.add('hidden'); pool.enter(); },
    leave: () => { setPoolHud(false); pool.exit(); ui.el.cross.classList.remove('hidden'); },
  },
};
function enterRoom(id) {
  const R = ROOMS[id];
  fadeTo(() => {
    playerLoc = id;
    renderPass.scene = R.api.scene;
    hudEl.classList.add('hidden');
    R.enter();
    sfx.play('ui');
  });
}
function exitRoomToGym(id) {
  const R = ROOMS[id];
  fadeTo(() => {
    R.leave();
    playerLoc = 'gym';
    renderPass.scene = scene;
    const D = R.door;
    player.pos.set(D.x, 0, D.z - DOOR_SPAWN);
    player.vel.set(0, 0, 0);
    player.freeYaw = Math.atan2(D.x, player.pos.z); // 面向场地中心（yaw=atan2(-dx,-dz) 化简）
    player.freePitch = 0;
    ui.showHud(G.modeDef.name, G.modeDef.timed);
  });
}
cinema.onExitRequest = () => exitRoomToGym('cinema');
pool.onExitRequest = () => exitRoomToGym('pool');
/** 任何"回球馆玩法"的入口前调用：硬切回球馆场景 */
function forceGym() {
  // 先进球馆的过场里 playerLoc 还没改（换场景写在黑幕里），所以取消过场必须无条件做
  cancelFade();
  const id = playerLoc;
  playerLoc = 'gym';   // 先改地点：否则 setPoolHud(false) 里"回瞄准就重锁指针"会在离场时误触发
  if (id !== 'gym') ROOMS[id].leave();
  renderPass.scene = scene;
  fadeEl.classList.remove('on');
  fading = false;
}

/* ================= 状态机装配 ================= */
const netSway = { t: 0 };
const G = {
  camera, player, ball, scoring, sfx, fx, ui, doorHint,
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
// 副标题文案的复用槽：只有里面的数字变了才重新拼字符串（见 tick 的 HUD 段）
const hudRef = { free: null, mul10: -1, n1: -1, made: -1, taken: -1, live: '' };

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
    // 投篮挑战：空投到本球那条弧上（距离锁死、角度随你走），球已在手
    const spot = randomShotSpot();
    const p = shotSpotXZ(spot);
    player.pos.set(p.x, 0, p.z);
    scoring.currentSpot = spot;
    ball.startHeld();
    machine.set('shot');
  } else {
    player.pos.set(0.6, 0, 1.5);
    ball.startPhysics(new THREE.Vector3(1.2, 0.8, 0.4), null);
    machine.set('noBall');
  }
  gameState = 'playing';
  player.inputEnabled = true;   // 结算/暂停都会关掉它：不在这统一还回来，新一局就钉在原地动不了
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
  if (poolHud) pool.onHud(true);   // 操作台开着时暂停再回来：继续让鼠标归 DOM 管
  else lockPointer();
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

// 音量记忆：存档写坏时退回默认（NaN 会污染 GainNode，让所有音效失声）
const savedVol = THREE.MathUtils.clamp(loadNumberSetting(LS_VOLUME, 0.8), 0, 1);
ui.el.setVolume.value = savedVol;
window.BB_VOLUME = savedVol;

/* ================= 输入 ================= */
const keys = player.keys;
/* 台球室「操作台」：上手时指针是锁的，DOM 一律点不动 —— Tab 临时解锁，
   鼠标就能拖杆法红点、按球室条上的按钮；再按 Tab 或直接点球台回到瞄准。
   （影院入座走的是同一套思路：故意解锁 + 拖拽转向兜底） */
let poolHud = false;
function setPoolHud(on) {
  if (poolHud === on) return;
  poolHud = on;
  document.body.classList.toggle('pool-hud', on);
  if (on) document.exitPointerLock?.();
  else if (gameState === 'playing' && playerLoc === 'pool') lockPointer();
  pool.onHud(on);
}
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (gameState === 'result' && (k === 'enter' || e.code === 'Space')) {
    // 结算面板上键盘就是那条捷径：Enter / 空格 = 再来一局（台球室打完自动续，这里同一套"不用找按钮"的规矩）
    e.preventDefault();
    document.getElementById('btn-again').click();
    return;
  }
  if (k === 'escape' && gameState === 'playing' && playerLoc === 'cinema') {
    // 影院补一个 ESC 语义：入座时起身；走动时弹暂停（与球馆一致）
    if (cinema.seated) cinema.onRightDown(); else pauseGame();
    return;
  }
  if (k === 'escape' && gameState === 'playing' && playerLoc === 'pool') {
    if (poolHud) setPoolHud(false);                        // 操作台开着：ESC 先回瞄准
    else if (pool.mode === 'aim') pool.onRightDown();      // 瞄准中先收杆
    else pauseGame();
    return;
  }
  if (gameState === 'playing' && playerLoc === 'pool' && k === 'e') {
    pool.rerack();
    return;
  }
  if (gameState === 'playing' && playerLoc === 'pool' && k === 'tab') {
    e.preventDefault();                       // Tab 默认会跳焦点，这里它是「操作台」开关
    setPoolHud(!poolHud);
    return;
  }
  if (gameState === 'playing' && playerLoc === 'pool' && (k.startsWith('arrow') || k === '0')) {
    // 杆法：方向键是「不开操作台」也能调的那条路（0 = 回中杆）
    const S = 0.18;
    e.preventDefault();
    if (k === 'arrowup') pool.nudgeSpin(0, S);
    else if (k === 'arrowdown') pool.nudgeSpin(0, -S);
    else if (k === 'arrowleft') pool.nudgeSpin(-S, 0);
    else if (k === 'arrowright') pool.nudgeSpin(S, 0);
    else pool.resetSpin();
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
    else if (playerLoc === 'pool') { setPoolHud(false); pool.onMoveKey(); } // 瞄准按移动键 -> 收杆回走动
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
});
// 按住方向键切走窗口（Alt+Tab）时 keyup 根本不会送到，键就卡在按下态：人自己往前走、
// 还停不下来。失焦一律当松手处理。
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
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
    } else if (playerLoc === 'pool' && poolHud && !e.button) {
      setPoolHud(false);      // 操作台上点一下球台 = 收工回到瞄准（这一次点击不出杆）
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
  if (document.pointerLockElement !== canvas && gameState === 'playing' && !poolHud
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

    /* ---- 两扇侧门：踩进半径就传送，靠近就接管提示（全程平方距离，见门常量处的注释） ---- */
    if (gameState === 'playing') {
      const cdx = player.pos.x - DOOR_C.x, cdz = player.pos.z - DOOR_C.z;
      const pdx = player.pos.x - DOOR_P.x, pdz = player.pos.z - DOOR_P.z;
      if (cdx * cdx + cdz * cdz < DOOR_C_R2) enterRoom('cinema');
      else if (pdx * pdx + pdz * pdz < DOOR_P_R2) enterRoom('pool');
      else { const hint = doorHint(); if (hint) ui.setPrompt(hint); }
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

    /* ---- HUD：数字真变了才重建文案（逐帧拼字符串 + toFixed 是白付的分配） ---- */
    const curDist = Math.hypot(player.pos.x - RIM_POS.x, player.pos.z - RIM_POS.z);
    const mul10 = Math.round(ScoreManager.distanceMultiplier(curDist) * 10);
    const free = scoring.mode.id === 'free';
    const n1 = free ? scoring.taps : scoring.spots;
    if (free !== hudRef.free || mul10 !== hudRef.mul10 ||
      n1 !== hudRef.n1 || scoring.shotMade !== hudRef.made || scoring.shotTaken !== hudRef.taken) {
      hudRef.free = free; hudRef.mul10 = mul10; hudRef.n1 = n1;
      hudRef.made = scoring.shotMade; hudRef.taken = scoring.shotTaken;
      const dMul = (mul10 / 10).toFixed(1);
      hudRef.live = free
        ? `拍球 ${scoring.taps} 次 · 投篮 ${scoring.shotMade}/${scoring.shotTaken} · 当前距离×${dMul}`
        : `进 ${scoring.shotMade} · 换位 ${scoring.spots} 次 · 当前距离×${dMul}`;
    }
    ui.setScore(
      scoring.displayScore,
      Math.max(bestCache, scoring.displayScore),
      hudRef.live
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
    enterRoom, exitRoomToGym, cinema, pool,
    get state() { return gameState; },
    get location() { return playerLoc; },
    teleport: (x, z) => { player.pos.set(x, 0, z); },
    dispatch: (evt) => machine.dispatch(evt),
  };
  const m = params.get('mode');
  const demo = params.get('demo'); // shot|result：自动演示（截图验证用）
  if (m && CFG.MODES[m]) setTimeout(() => startMode(m), 400);
  if (params.get('loc') === 'cinema') setTimeout(() => enterRoom('cinema'), 1100);
  if (params.get('loc') === 'pool') setTimeout(() => enterRoom('pool'), 1100);
  if (params.get('help')) setTimeout(() => document.getElementById('btn-help').click(), 300);   // ?help=1：把折叠的玩法说明展开来截图
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
  if (demo === 'help') {
    // 主页折叠说明：点「📖 怎么玩」展开 → 点浮层 ✕ 收起，断言读真实 DOM 的 hidden 与按钮文字
    const btn = document.getElementById('btn-help');
    const close = document.getElementById('help-close');
    const h = document.getElementById('help');
    const s = () => `hid=${h.classList.contains('hidden') ? 1 : 0} txt=${btn.textContent}`;
    setTimeout(() => { btn.click(); mark(`OPEN ${s()}`); }, 600);
    setTimeout(() => { close.click(); mark(`CLOSE ${s()}`); }, 1000);
  }
  if (demo === 'fade') {
    // 过场中途硬切：黑幕里 pending 的换场景必须掐掉。
    // 进房间时 playerLoc 还是 gym（换场景写在黑幕里），所以「无条件取消」这一点由这条断言守住。
    const hudOn = () => (document.getElementById('hud').classList.contains('hidden') ? 0 : 1);
    setTimeout(() => enterRoom('pool'), 1000);
    setTimeout(() => startMode('free'), 1250);   // 420ms 黑幕还没落地就开新局
    setTimeout(() => mark(`FADE end loc=${GAME.location} hud=${hudOn()} poolMode=${pool.debugPool().mode}`), 2600);
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
  if (demo === 'dribble') {
    // 「看得见」的拍球断言：一整段自动拍球里，球心的屏幕投影必须始终在画面内、
    // 且有明显的上下摆动（历史 bug：下探 0.92m 直接把球拍出画面下缘 → 只剩声音）。
    // 顺带验蓄力力度条（历史 bug：与台球力度条 id 撞车，ID 选择器盖掉 height → 看着像消失）。
    const drive = (n, each) => { for (let i = 0; i < n; i++) { machine.update(0.016); player.update(0.016); each?.(i); } };
    setTimeout(() => {
      ball.syncFromPhysics();
      player.pos.set(ball.position.x, 0, ball.position.z + 1.0);
      machine.update(0.016);
      machine.dispatch('onGrab');
      mark('pickup');
    }, 1200);
    setTimeout(() => {
      let lo = 9, hi = -9, lox = 9, hix = -9, loSy = 9, behind = 0;
      drive(90, () => {
        const v = ball.position.clone().project(camera);
        if (v.z > 1) behind++;
        lo = Math.min(lo, v.y); hi = Math.max(hi, v.y);
        lox = Math.min(lox, v.x); hix = Math.max(hix, v.x);
        loSy = Math.min(loSy, ball.mesh.scale.y);
      });
      const inFrame = lo > -1 && hi < 1 && lox > -1 && hix < 1 && behind === 0;
      mark(`BOUNCE ndcY=[${lo.toFixed(2)},${hi.toFixed(2)}] swing=${(hi - lo).toFixed(2)}`
        + ` ndcX=[${lox.toFixed(2)},${hix.toFixed(2)}] squashY=${loSy.toFixed(2)}`
        + ` behind=${behind} taps=${scoring.taps} 画面内=${inFrame ? 1 : 0}`);
    }, 2600);
    if (params.get('hold') !== 'low') setTimeout(() => {
      machine.dispatch('onLeftDown'); // 进蓄力：力度条应显形、fill 长高
      const bar = document.getElementById('power-bar');
      const fill = document.getElementById('power-fill');
      let tall = 0;
      drive(40, () => { if (!bar.classList.contains('hidden') && fill.getBoundingClientRect().height > 2) tall = 1; });
      const ch = machine.current?.charge ?? -1;
      mark(`POWER shown=${bar.classList.contains('hidden') ? 0 : 1} 有高度=${tall}`
        + ` ch=${ch.toFixed(2)} h=${fill.style.height} px=${fill.getBoundingClientRect().height.toFixed(0)}`
        + ` sweet=${document.getElementById('power-sweet').style.height}`);
      machine.dispatch('onLeftUp');
      mark(`RELEASE fly=${machine.current?.flying ? 1 : 0} 收起=${bar.classList.contains('hidden') ? 1 : 0}`);
    }, 3400);
    setTimeout(() => { console.log('DEMO_DRIBBLE', marks.join(' | ')); }, 5200);
    if (params.get('hold') === 'low') setTimeout(() => {
      // 定帧在拍球最低点（把周期拉长到永不走完）：给截图看"球确实下来了、也没出画面"
      ball._tapT = 5e5; CFG.tap.dur = 1e6;
      ball.updateHeld(0.016, camera, 0);
      const v = ball.position.clone().project(camera);
      mark(`PIN ndc=${v.x.toFixed(2)},${v.y.toFixed(2)} scale=${ball.mesh.scale.y.toFixed(2)} mode=${ball.mode}`);
    }, 6000);
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
    var hoverHint = '';   // 入座前准星扫到银幕的提示文字（下面第二个 setTimeout 里一并回读）
    // 公共：走到圆床边 + 左键入座（可选再开大屏墙），供两种演示复用
    addEventListener('error', (e) => {
      const el = document.getElementById('dbg-out');
      if (el) el.textContent = `ERR ${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`;
    });
    setTimeout(() => {
      // 入座前先验准星射线还认得银幕（点屏切换出声的链路全靠这张目标表）：
      // 站得离圆床够远（>床半径+0.6），提示就该从「入座」翻成「播放/暂停」
      player.pos.set(0, 0, CFG.cinema.bed.r + 1.2);
      player.freeYaw = 0; player.yaw = 0;
      cinema.update(0.016);
      hoverHint = document.getElementById('cinema-hint').textContent.replace(/<[^>]+>/g, '').slice(0, 10);
      player.pos.set(0, 0, CFG.cinema.bed.z + 1.6);
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
        + ` hover=${hoverHint}`
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
    // 统一控制台 + 多路出声：入座→开控制台→整条换成 3 部→勾 3 路出声→删 1 部→整体静音/还原→收条唤回。
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
      // 一次 change 塞三部 = 「整条替换」，正好把幕数钉死成 3。
      // 不能靠"在默认片单后面追加"：默认片单来自各机器的 video/manifest.js，
      // 别人克隆下来一部影片都没有，行数就对不上、勾子按钮也点空。
      const inp = document.getElementById('cb-add-in');
      const mk = (n) => new File([new Blob(['x'], { type: 'video/mp4' })], n, { type: 'video/mp4' });
      Object.defineProperty(inp, 'files', {
        value: ['a', 'b', 'c'].map((s) => mk(`cc-${s}.mp4`)), configurable: true,
      });
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
    // 加 &spin=x,y（如 &spin=0.55,-0.85）可以同时看杆法盘 + 母球分离线
    setTimeout(() => {
      player.pos.set(0, 0, 1.5); player.yaw = -Math.PI / 2; player.freeYaw = -Math.PI / 2;
      pool.onLeftDown();
      pool.debugAimAt(1);
      const s = (params.get('spin') || '').split(',').map(Number);
      if (s.length === 2 && s.every(Number.isFinite)) pool.debugSetSpin(s[0], s[1]);
      if (params.get('hud')) dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const g = pool.debugGuide(), d = pool.debugSpin();
      mark(`AIM 杆法=${d.name} 红点=${d.dot} kind=${g.kind} 分离线=${g.cue} 操作台=${document.body.classList.contains('pool-hud') ? 1 : 0}`);
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
      pool.debugSettle(1 / 60, 1 / 60); // 补一帧 update：台球力度条应写到自己的 DOM 节点上
      const pw = document.getElementById('pool-fill').style.width;
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
      mark(`SHOT ghostErr=${err} dir·pred=${dot} cue停=${JSON.stringify([before.vx, before.vz])} live=${r.live} potted=${r.potted} strokes=${r.strokes} 力度条=${pw}`);
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
    // 退出接线：球室条那颗按钮唯一出口。
    // 顺带盯住 Q-B 那个 bug：对战的入库条挂在 body 上（不在球室条那层里），
    // 退出球室时不显式收就会跟着回球馆/主菜单，所以断言"退前亮、退后收"。
    let exitFired = 0;
    const bookShown = () => (document.getElementById('pool-book').classList.contains('hidden') ? 0 : 1);
    setTimeout(() => { pool.debugSetDuel(1); }, 9400);
    setTimeout(() => {
      const orig = pool.onExitRequest;
      pool.onExitRequest = () => { exitFired++; if (orig) orig(); };
      mark(`EXIT 对战入库条=${bookShown()}`);
      document.getElementById('pool-exit').click();
      pool.onExitRequest = orig;
    }, 9800);
    setTimeout(() => {
      mark(`EXITED fired=${exitFired} 入库条=${bookShown()} loc=${GAME.location} bar=${document.getElementById('pool-bar').classList.contains('hidden') ? 0 : 1}`);
    }, 10800);
  }
  if (demo === 'spin') {
    // 杆法回归：同一杆正打，只挪红点 —— 定杆停在接触点、高杆跟进、低杆拉回；
    // 而且「导向线画出的分离方向」必须等于积分器真跑出来的方向（这套物理的立身之本）。
    const parse = (s) => { const a = s.split(',').map(Number); return { x: a[0], z: a[1] }; };
    const nrm = (v) => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
    const dot = (a, b) => a.x * b.x + a.z * b.z;
    const mv = (r) => +(r.end.x - r.at.x).toFixed(3);
    // 上一杆的球还在滚时是接不上手的（真实流程也这样），所以每杆跑完都要等回 aim 再摆下一杆
    const waitAim = () => { for (let i = 0; i < 400 && pool.debugPool().mode !== 'aim'; i++) pool.debugSettle(1 / 30, 1 / 30); };
    const shoot = (sx, sy, opt = {}) => {
      waitAim();
      pool.rerack();
      pool.onLeftDown();                       // 先上手（takeOver 会把朝向设成玩家视线），再摆位/瞄准
      pool.debugPlace(0, -0.55, 0);
      pool.debugPlace(1, -0.05, 0);
      pool.debugAimTo(opt.tx ?? 1.2, opt.tz ?? 0);
      pool.debugSetSpin(sx, sy);
      const g = pool.debugGuide();
      const m0 = pool.debugPool().mode;
      pool.debugPower(opt.pow ?? 0.6);
      pool.onLeftUp();
      let at = null;
      for (let i = 0; i < 900 && !at; i++) {
        pool.debugSettle(1 / 240, 1 / 240);
        const b1 = pool.debugBall(1);
        if (Math.hypot(b1.vx, b1.vz) > 0.05) at = pool.debugBall(0);
      }
      pool.debugSettle(opt.watch ?? 1.8);
      return { g, at, end: pool.debugBall(0), m0, roll: pool.debugPool().mode };
    };
    setTimeout(() => {
      player.pos.set(0, 0, 1.5);
      pool.debugSetDuel(0);
      const s = pool.debugSpin();
      // 开局直接读一次落盘值：模块初始化就该把「上次爱打低杆」恢复进红点（下一轮的 恢复= 要与之吻合）
      mark(`SPIN 开局 duel=${pool.debugPool().duel} 落盘=${localStorage.getItem('bb.pool.spin')} 恢复=${s.name} x=${s.x} y=${s.y} 红点=${s.dot}`);
    }, 2200);
    setTimeout(() => {
      const stun = shoot(0, 0), fol = shoot(0, 0.9), drw = shoot(0, -0.9);
      const sv = Math.hypot(stun.at.vx, stun.at.vz);
      mark(`STUN 定杆：上手=${stun.m0}/${fol.m0}/${drw.m0} 接触后母球速度=${sv.toFixed(3)}（应≈0）位移=${mv(stun)}`);
      mark(`FOLLOW 高杆：位移=${mv(fol)}（应>0.15）预测分离=${fol.g.cue} 实际=${JSON.stringify(nrm({ x: fol.at.vx, z: fol.at.vz }))}`);
      mark(`DRAW 低杆：位移=${mv(drw)}（应<-0.15）预测分离=${drw.g.cue} 实际=${JSON.stringify(nrm({ x: drw.at.vx, z: drw.at.vz }))}`);
      const pf = dot(parse(fol.g.cue), nrm({ x: fol.at.vx, z: fol.at.vz }));
      const pd = dot(parse(drw.g.cue), nrm({ x: drw.at.vx, z: drw.at.vz }));
      mark(`GUIDE 预测==实际 高杆 dot=${pf.toFixed(3)} 低杆 dot=${pd.toFixed(3)}（都该≈1）`);
    }, 2600);
    setTimeout(() => {
      // 加塞吃库：斜打 +z 库，左塞/右塞的反射方向应不同，且各自与导向线一致
      const rail = (sx) => {
        waitAim();
        pool.rerack();
        pool.onLeftDown();
        pool.debugPlace(0, -0.9, -0.15);       // 贴着开球区往 -x 一端的长库打，避开右侧球堆
        pool.debugAimTo(-0.4, 0.9);
        pool.debugSetSpin(sx, 0);
        const g = pool.debugGuide();
        pool.debugPower(0.5);
        pool.onLeftUp();
        let flip = null, pz = 0;
        for (let i = 0; i < 900 && !flip; i++) {
          pool.debugSettle(1 / 240, 1 / 240);
          const c = pool.debugBall(0);
          if (pz > 0.05 && c.vz < 0) flip = c;
          pz = c.vz;
        }
        return { g, flip };
      };
      const L = rail(-0.9), M = rail(0), Rr = rail(0.9);
      const vel = (v) => (v ? { x: v.vx, z: v.vz } : null);
      const ang = (v) => (v ? Math.atan2(v.vz, v.vx).toFixed(3) : '未出手');
      mark(`CUSH 出射角 无塞=${ang(M.flip)} 左塞=${ang(L.flip)} 右塞=${ang(Rr.flip)} 左右夹角=${(L.flip && Rr.flip ? Math.abs(Math.atan2(L.flip.vz, L.flip.vx) - Math.atan2(Rr.flip.vz, Rr.flip.vx)) : 0).toFixed(3)}rad（应>0.1）`);
      const pred = (r) => (r.flip ? dot(parse(r.g.rail), nrm(vel(r.flip))) : NaN);
      mark(`CUSH 预测==实际 左=${pred(L).toFixed(3)} 中=${pred(M).toFixed(3)} 右=${pred(Rr).toFixed(3)}（都该≈1）`);
    }, 4600);
    setTimeout(() => {
      // 上手时指针是锁的，DOM 点不动 —— Tab 开「操作台」：解锁、球室条亮起、提示改成拖红点
      const tab = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const open = () => document.body.classList.contains('pool-hud') ? 1 : 0;
      const h = () => document.getElementById('pool-hint').textContent.replace(/[\uD800-\uDFFF]/g, '').slice(0, 14);
      waitAim();                                // 等回瞄准态，提示条才走 aim 那一支
      mark(`HUD 初始=${open()} 锁=${document.pointerLockElement ? 1 : 0}`);
      tab();
      pool.debugSettle(1 / 60, 1 / 60);          // 提示条是每帧刷的，走一帧再读
      mark(`HUD 开台=${open()} 提示=${h()}`);
      pool.debugSetSpin(-0.4, -0.9);           // 操作台上把红点拖到左下：左低杆
      mark(`HUD 拖后=${pool.debugSpin().name} 红点=${pool.debugSpin().dot}`);
      tab();
      pool.debugSettle(1 / 60, 1 / 60);          // 提示条每帧才刷，走一帧再读
      mark(`HUD 关台=${open()} 提示=${h()}`);
    }, 5000);
    setTimeout(() => {
      // 拖完红点松手 → 300ms 后应把杆法写进 localStorage（下次进馆还记得你爱打低杆）
      pool.debugSetSpin(0.6, -0.35);
      setTimeout(() => mark(`SAVE 落盘=${localStorage.getItem('bb.pool.spin')} 名称=${pool.debugSpin().name}`), 520);
    }, 5200);
    setTimeout(() => { console.log('DEMO_SPIN', marks.join(' | ')); }, 8000);
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
      const hid = document.getElementById('pool-book').classList.contains('hidden');
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
      document.getElementById('pool-mode').click();
      mark(`L 按钮切玩法 duel=${pool.debugPool().duel} 文案=${document.getElementById('pool-mode').textContent}`);
    }, 10600);
    setTimeout(() => {
      pool.debugSetDuel(1);
      const z = pool.debugRuleShot([8], { first: 1 });
      mark(`M 开球撞进黑八：摆回继续 ph=${z.phase} turn=${z.turn} live=${z.live} book=[${z.book}] eight=${R(pool.debugBall(8))}`);
    }, 11000);
    setTimeout(() => {
      // 一局打完不该冷场等人去点按钮：结果亮够秒数就自动重摆开下一局，而且开球方轮换
      pool.debugSetDuel(2); pool.debugRuleShot([1], { first: 1 });
      for (const n of [2, 3, 4, 5, 6, 7]) pool.debugRuleShot([n], { first: n });
      pool.debugRuleShot([8], { first: 8 });          // 清台后一杆黑八 → 你胜 → phase=over
      const a = st();
      pool.debugSettle(CFG.pool.duel.next + 0.4);     // 走过自动续局的那个时间点
      const rk = document.getElementById('pool-rack');
      mark(`N 自动开新局 ${a} → ${st()}（该 ph=break turn=1）｜对战时重摆按钮=${rk.classList.contains('hidden') ? '隐' : '显'}`);
    }, 11400);
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
      mark(`  info=${document.getElementById('pool-info').textContent}`);
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
    // Enter = 再来一局（结算面板上不用去找鼠标）
    // 结算后持球状态还在跑：taps 必须钉在 0（否则拍球声和 +2 飘字会盖在结算面板上）
    setTimeout(() => {
      mark(`RES 面板=${document.getElementById('result').classList.contains('hidden') ? 0 : 1} state=${GAME.state} taps=${scoring.taps}`);
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, 1800);
    setTimeout(() => mark(`RES Enter后 面板=${document.getElementById('result').classList.contains('hidden') ? 0 : 1} state=${GAME.state}`), 2600);
  }
  if (demo === 'input') {
    // 真键盘链路（keydown -> player.keys -> 位移），并且专测「结算后再开一局」：
    // finishSession 会关掉 inputEnabled，startMode 若不还回来，人就钉在原地动不了。
    const tap = (k) => dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const lift = (k) => dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    const walk = (tag) => {
      player.pos.set(0, 0, 6); player.vel.set(0, 0, 0);
      tap('w');
      for (let i = 0; i < 30; i++) player.update(0.016);   // 0.48s，手动步进免得受 rAF 节流影响
      lift('w');
      mark(`${tag} 前进=${(6 - player.pos.z).toFixed(2)}m 输入开关=${player.inputEnabled ? 1 : 0}`);
    };
    setTimeout(() => { startMode('free'); walk('A1 首局'); }, 1000);
    setTimeout(() => finishSession(), 1600);
    setTimeout(() => { document.getElementById('btn-again').click(); walk('A2 结算后再来一局'); }, 2100);
    // 负对照：同一个量法显式把开关关掉，必须读 0 —— 不然说明这条断言根本不敏感，
    // A2 的 2.22m 只是碰巧来自别处。（测试自带对照，就不用去临时改生产代码验干了）
    setTimeout(() => { player.inputEnabled = false; walk('A3 对照·开关关掉'); player.inputEnabled = true; }, 2400);
    // A4：按住 W 切走窗口 —— keyup 收不到，全靠 blur 把键松掉，否则人会自己一直往前走
    setTimeout(() => {
      player.pos.set(0, 0, 6); player.vel.set(0, 0, 0);
      tap('w');
      dispatchEvent(new Event('blur'));
      for (let i = 0; i < 30; i++) player.update(0.016);
      lift('w');
      mark(`A4 失焦后 前进=${(6 - player.pos.z).toFixed(2)}m（应=0）`);
    }, 2700);
    setTimeout(() => mark(`END state=${GAME.state} loc=${GAME.location}`), 3100);
  }
  if (demo === 'spot') {
    // 投篮挑战：只锁距离、不锁角度。甩到非法位置应被吸回本球那条弧；
    // 弧内换个角度则原样保留（老写法钉在点上，特殊角度就只能干等倒计时）；命中之后才换距离。
    const rd = () => Math.hypot(player.pos.x - RIM_POS.x, player.pos.z - RIM_POS.z);
    const ang = () => Math.atan2(player.pos.x - RIM_POS.x, player.pos.z - RIM_POS.z);
    const r0 = () => scoring.currentSpot.r;
    setTimeout(() => { startMode('shot'); mark(`S0 r=${r0().toFixed(2)} 落点d=${rd().toFixed(2)}`); }, 1000);
    setTimeout(() => GAME.teleport(RIM_POS.x + Math.sin(2.9) * 9.5, RIM_POS.z + Math.cos(2.9) * 9.5), 1500);
    setTimeout(() => mark(`S1 吸回 d=${rd().toFixed(2)} 偏角=${ang().toFixed(2)}（弧上限=${CFG.shot.spotArc}）`), 2100);
    setTimeout(() => GAME.teleport(RIM_POS.x + Math.sin(0.9) * r0(), RIM_POS.z + Math.cos(0.9) * r0()), 2300);
    setTimeout(() => mark(`S2 同距离换角度 d=${rd().toFixed(2)} 偏角=${ang().toFixed(2)}（应≈0.90）`), 2900);
    setTimeout(() => {
      const before = r0();
      machine.current.scored = true;
      machine.current.relocateAndContinue();   // 命中后走的就是这段，不碰物理直接验
      mark(`S3 命中后 r=${before.toFixed(2)}→${r0().toFixed(2)} 落点d=${rd().toFixed(2)} 换距离=${before === r0() ? '否' : '是'}`);
    }, 3100);
  }
} catch { /* 生产环境忽略 */ }
