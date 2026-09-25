/**
 * states.js —— 独立游戏状态机
 * 三种状态：无球(noBall) / 持球(hold) / 投篮蓄力(shot)
 * 每个状态是一个独立类，逻辑解耦；状态间只通过 G（游戏上下文）通信。
 *
 * 事件接口：enter() / exit() / update(dt) / onLeftDown() / onLeftUp() / onRightDown() / onTap()（空格） / onGrab()（E）
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { RIM_POS } from './court.js';

/* ================= 共用工具 ================= */

/**
 * 求"命中圈心所需的理论力度值(0~1)"——抛体运动反解。
 * 固定仰角 elevAngle，已知水平距离 d 与高度差 dy：
 *   v^2 = g*d^2 / (2*cos^2(a) * (d*tan(a) - dy))
 */
export function idealPower(releasePos) {
  const g = 9.82, a = CFG.shot.elevAngle;
  const d = Math.hypot(RIM_POS.x - releasePos.x, RIM_POS.z - releasePos.z);
  const dy = RIM_POS.y - releasePos.y;
  const denom = d * Math.tan(a) - dy;
  if (denom <= 0.01) return null; // 该位置理想弹道不存在（贴篮下）
  const v = Math.sqrt((g * d * d) / (2 * Math.cos(a) ** 2 * denom));
  const p = (v - CFG.shot.speedMin) / (CFG.shot.speedMax - CFG.shot.speedMin);
  return THREE.MathUtils.clamp(p, 0.01, 0.99);
}

/** 以力度 power 从 releasePos 出手，返回速度向量（含瞄准偏移混合） */
function shotVelocity(releasePos, power, player) {
  const a = CFG.shot.elevAngle;
  const v = CFG.shot.speedMin + power * (CFG.shot.speedMax - CFG.shot.speedMin);
  // 理想水平方向：指向圈心
  const hd = new THREE.Vector2(RIM_POS.x - releasePos.x, RIM_POS.z - releasePos.z);
  const phi = Math.atan2(-hd.x, -hd.y); // 与 player.forward 同一角度约定
  // 准星偏移以 aimBlend 权重干扰弹道（0=满辅助，1=纯手动指向）
  let err = player.wrapDelta(player.yaw - phi);
  err = THREE.MathUtils.clamp(err * CFG.shot.aimBlend, -0.28, 0.28);
  const dirYaw = phi + err;
  const elev = a; // 仰角固定，保证手感稳定（俯仰观感由瞄准视角负责）
  return new THREE.Vector3(
    -Math.sin(dirYaw) * Math.cos(elev),
    Math.sin(elev),
    -Math.cos(dirYaw) * Math.cos(elev)
  ).multiplyScalar(v);
}

/**
 * 随机投篮站位（投篮挑战用）：以圈心为极坐标原点，
 * 距离 ∈ [randomSpotMin, randomSpotMax]，扇形朝半场内侧（z 更大方向），
 * 并保证落在场内与投篮触发区内。
 */
export function randomShotSpot() {
  const S = CFG.shot, C = CFG.court;
  for (let i = 0; i < 24; i++) {
    const r = THREE.MathUtils.lerp(S.randomSpotMin, S.randomSpotMax, Math.random());
    const a = (Math.random() * 2 - 1) * 1.15; // ±66°，面向半场
    const x = RIM_POS.x + Math.sin(a) * r;
    const z = RIM_POS.z + Math.cos(a) * r;
    if (Math.abs(x) > C.halfW - 0.6) continue;
    if (z > S.zoneMaxZ - 0.3) continue;      // 留出边界余量，避免贴线抖动
    return { x, z };
  }
  return { x: 0, z: RIM_POS.z + 4.6 }; // 兜底：正面罚球位
}

/* ================= 基类 ================= */
class State {
  constructor(G) { this.G = G; }
  enter() {}
  exit() {}
  update(dt) {}
  onLeftDown() {}
  onLeftUp() {}
  onRightDown() {}
  /** 空格：拍球 */
  onTap() {}
  /** E：手上没人就捡球，球在身上就弃球 */
  onGrab() {}
}

/** 弃球：球一律放回场地中央（中圈落点），玩家要走回去才能再捡 */
function discardBall(G) {
  const { ball, machine, sfx, ui } = G;
  ball.startPhysics(new THREE.Vector3(0, 0.9, 0), null);
  sfx.play('tap', { volume: 0.45, rate: 0.8 });
  ui.setPrompt('🏀 球丢在场地中央了 · 走过去按 <b>E</b> 捡回来');
  machine.set('noBall');
}

/* ================= 1. 无球 ================= */
export class NoBallState extends State {
  enter() {
    const { player, ball, ui } = this.G;
    player.speed = CFG.player.speedIdle;
    if (ball.mode !== 'physics') ball.startPhysics(ball.position, null);
    ui.setPrompt('走近篮球，按 <b>E</b> 拾球');
  }
  update(dt) {
    const { player, ball, ui } = this.G;
    ball.syncFromPhysics();
    const near = ball.mode === 'physics' &&
      Math.hypot(player.pos.x - ball.position.x, player.pos.z - ball.position.z) < CFG.player.pickupRange &&
      ball.position.y < 1.35;
    ui.setPrompt(near
      ? '<b>E</b> 拾球'
      : 'WASD 移动 · 走近篮球后按 E 拾取');
    this._near = near;
  }
  onGrab() {
    if (!this._near) return;
    const { ball, machine, sfx } = this.G;
    ball.startHeld();
    sfx.play('ui', { volume: 0.5 });
    machine.set('hold');
  }
}

/* ================= 2. 持球 ================= */
export class HoldState extends State {
  enter() {
    const { player, ui, modeDef } = this.G;
    player.speed = CFG.player.speedHold;
    ui.setPrompt(modeDef.id === 'free'
      ? '<b>空格</b> 拍球 · <b>左键</b> 投篮（按住蓄力 松手出手）· <b>E</b> 弃球 · 全场任意位置'
      : 'WASD 走位 · <b>空格</b> 拍球 · <b>左键</b> 按住蓄力投篮 · <b>E</b> 弃球');
  }
  update(dt) {
    const { player, ball, camera, scoring, machine } = this.G;
    ball.updateHeld(dt, camera);
    if (scoring.ended) return;
    // 持球移动进入投篮触发区 -> 自动切入投篮瞄准（仅计分投篮的模式）
    if (this.G.modeDef.shotScore && player.inShotZone() && player.mode !== 'shot') {
      machine.set('shot');
    }
  }
  onLeftDown() {
    // 左键 = 投篮：立即进入蓄力状态（松手出手）
    if (!this.G.modeDef.shotScore) return;
    this.G.pendingCharge = true;
    this.G.machine.set('shot');
  }
  onTap() {
    // 空格 = 无门槛拍球：自动跟手
    const { ball, sfx, fx, ui, scoring } = this.G;
    if (ball.tap()) {
      sfx.play('tap', { rate: 1.85 + Math.random() * 0.12, volume: 0.85 });
      const { points } = scoring.addTap();
      if (points > 0) ui.showScorePopup(points, null, 0);
      fx.burstTap(ball.position);
    }
  }
  onGrab() {
    discardBall(this.G); // E = 弃球（球回到场地中央）
  }
}

/* ================= 3. 投篮蓄力 ================= */
export class ShotState extends State {
  enter() {
    const { player, ui, modeDef } = this.G;
    // 挑战模式：点位周围小圈自由走位；自由模式：慢速微调
    player.speed = modeDef.id === 'shot' ? CFG.shot.adjustSpeed : CFG.player.speedShot;
    player.enterShotAim();
    this.charge = 0;
    // 由 HoldState 长按继承而来的"按住"输入，直接开始蓄力
    this.charging = !!this.G.pendingCharge;
    this.G.pendingCharge = false;
    this.flying = false;
    this.scored = false;
    this.resolved = false;
    this.returnTimer = 0;
    this.flightT = 0;
    this._prevY = undefined; // 飞行阶段首帧采样基线（出手时再置，保证穿越判定完整）
    ui.showPowerBar(true);
    ui.setPrompt('<b>按住左键</b> 蓄力 · <b>松手</b> 投篮 · <b>右键</b> 取消 · <b>E</b> 弃球');
  }
  exit() {
    const { player, ui } = this.G;
    player.exitShotAim();
    ui.showPowerBar(false);
  }

  /** 挑战模式：把玩家钳制在随机点位中心周围的小圈内（可自由走位调整视角） */
  clampToSpot() {
    const { player, scoring } = this.G;
    const spot = scoring.currentSpot;
    if (!spot) return;
    const dx = player.pos.x - spot.x, dz = player.pos.z - spot.z;
    const d = Math.hypot(dx, dz);
    const R = CFG.shot.spotRadius;
    if (d > R) {
      player.pos.x = spot.x + (dx / d) * R;
      player.pos.z = spot.z + (dz / d) * R;
    }
  }

  update(dt) {
    const { player, ball, camera, ui, scoring, modeDef } = this.G;

    if (modeDef.id === 'shot') this.clampToSpot();

    if (!this.flying) {
      /* ---- 持球瞄准阶段 ---- */
      const raised = ball.updateHeld(dt, camera, this.charge * 0.9);
      if (this.charging) this.charge = Math.min(1, this.charge + dt / CFG.shot.chargeTime);
      // 力度条 + 最佳力度段（随站位实时反解）
      ui.updatePowerBar(this.charge, idealPower(raised));
      // 自由模式：未蓄力时走出投篮区 -> 取消瞄准，回到普通持球
      if (modeDef.id !== 'shot' && !player.inShotZone() && !this.charging && this.charge <= 0) {
        this.G.machine.set('hold');
        return;
      }
    } else {
      /* ---- 球飞行阶段：进球判定 + 落地回收 ---- */
      ball.syncFromPhysics();
      const bp = ball.body.position;
      const bv = ball.body.velocity;
      // 进球：球心自上而下穿过篮圈平面，且穿越点水平投影落在圈内
      // （对穿越瞬间做线性插值，高速时判定依然精确）
      if (!this.scored && this._prevY !== undefined) {
        const rimY = CFG.hoop.rimHeight;
        if (this._prevY >= rimY && bp.y < rimY && bv.y < 0) {
          const f = (this._prevY - rimY) / (this._prevY - bp.y || 1e-6);
          const px = this._prevX + (bp.x - this._prevX) * f;
          const pz = this._prevZ + (bp.z - this._prevZ) * f;
          const hd = Math.hypot(px - RIM_POS.x, pz - RIM_POS.z);
          if (hd < CFG.hoop.scoreRadius) this.onScore();
        }
      }
      this._prevY = bp.y; this._prevX = bp.x; this._prevZ = bp.z;

      // 篮网收束（简易碰撞判定）：进球瞬间纵向减速
      if (this.scored && bv.y < -0.5 && bp.y < CFG.hoop.rimHeight && bp.y > CFG.hoop.rimHeight - CFG.hoop.netDepth) {
        bv.y *= 0.62; bv.x *= 0.75; bv.z *= 0.75;
      }

      // 触地（或长时间飞行/卡筐超时）-> 结算并自动回球
      this.flightT += dt;
      const stuck = this.flightT > 6; // 卡在篮圈上/滚到死角时的保底回收
      if (!this.resolved && (stuck || (bp.y <= CFG.ball.radius + 0.07 && bv.length() < 6))) {
        this.resolved = true;
        this.onResolve();
      } else if (this.resolved) {
        this.returnTimer += dt;
        if (this.returnTimer > 0.4) {
          scoring.ended
            ? this.G.machine.set('hold') // 时间结束：仅收球，UI 弹窗已接管
            : this.relocateAndContinue();
        }
      }
    }
  }

  /** 回球入手的去向：投篮挑战命中后已换新站位；否则原地继续 */
  relocateAndContinue() {
    const { scoring, player, ui, modeDef } = this.G;
    if (this.scored && modeDef.id === 'shot') {
      const spot = randomShotSpot();
      player.pos.set(spot.x, 0, spot.z);
      player.vel.set(0, 0, 0);
      scoring.currentSpot = spot;
      scoring.spots++;
      this.G.sfx.play('combo', { volume: 0.55 });
      ui.showScorePopup(0, '🎲 命中！传送至新投篮点', 0);
      this.G.machine.set('shot'); // 重进投篮状态：在新点位重新架起瞄准
      return;
    }
    this.G.machine.set(player.inShotZone() && modeDef.shotScore ? 'shot' : 'hold');
  }

  onLeftDown() {
    if (this.flying) return;
    this.charging = true;
  }
  onLeftUp() {
    if (this.flying || !this.charging) return;
    this.charging = false;
    // 左键点按（蓄力过低）= 取消，不出手也不记出手数
    if (this.charge < CFG.shot.cancelCharge) {
      this.charge = 0;
      this.G.ui.setPrompt('<b>按住左键</b> 蓄力 · <b>松手</b> 投篮 · <b>右键</b> 取消 · <b>E</b> 弃球');
      return;
    }
    const { ball, player, sfx, scoring } = this.G;
    const power = this.charge;
    this.markRelease(); // 记录出手点（2/3 分判定）
    const pos = ball.position.clone();
    ball.startPhysics(pos, shotVelocity(pos, power, player));
    sfx.play('shoot');
    scoring.registerShotAttempt();
    this.flying = true;
    this.flightT = 0;
    this._prevY = undefined; // 重置穿越判定基线，从飞行首帧开始采样
    this.G.ui.setPrompt('好球轨迹 —— 盯住力度条最佳区！');
  }
  onRightDown() {
    if (this.flying) return;
    // 右键取消本次投篮：清空蓄力，回到持球状态
    this.charging = false;
    this.charge = 0;
    this.G.sfx.play('tap', { volume: 0.5, rate: 1.4 });
    this.G.machine.set('hold');
  }
  onGrab() {
    if (this.flying) return; // 球已出手就没什么可丢的
    this.charging = false;
    this.charge = 0;
    discardBall(this.G);
  }

  /** 进球事件 */
  onScore() {
    this.scored = true;
    const { scoring, sfx, fx, ui } = this.G;
    const { points, is3, distMul } = scoring.addShotMade(this.releaseDist || 5);
    sfx.play('net');
    sfx.play('cheer', { volume: 0.75 });
    fx.burstScore(RIM_POS);
    fx.shake();
    fx.flash();
    this.G.netSway();
    const label = `${is3 ? '三分' : '两分'}命中 · 距离×${distMul.toFixed(1)}`;
    ui.showScorePopup(points, label, scoring.shotCombo);
  }

  /** 球落地后结算（进或不进都走到这里） */
  onResolve() {
    const { scoring, sfx, ui } = this.G;
    if (!this.scored) {
      sfx.play('bounce', { volume: 0.9 });
      const comboReset = scoring.addShotMiss();
      if (this.G.modeDef.shotScore) {
        ui.showScorePopup(0, comboReset ? '三不沾! 连击清零' : '没进… 调整力度再来', 0);
      }
    } else {
      sfx.play('bounce', { volume: 0.5 });
    }
    ui.setPrompt('篮球回到手中…');
  }

  /** 记录出手点（用于 2/3 分判定） */
  markRelease() {
    const { player } = this.G;
    this.releaseDist = Math.hypot(
      player.pos.x - RIM_POS.x, player.pos.z - RIM_POS.z
    );
  }
}

/* ================= 状态机容器 ================= */
export class StateMachine {
  constructor() {
    this.states = {};
    this.current = null;
    this.name = '';
  }
  register(name, state) { this.states[name] = state; return this; }
  set(name) {
    if (this.current) this.current.exit();
    this.current = this.states[name];
    this.name = name;
    this.current.enter();
  }
  update(dt) { this.current?.update(dt); }
  dispatch(evt, arg) { this.current?.[evt]?.(arg); }
}
