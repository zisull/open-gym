/**
 * states.js —— 独立游戏状态机
 * 四种状态：无球(noBall) / 原地持球(hold) / 行进运球(dribble) / 投篮蓄力(shot)
 * 每个状态是一个独立类，逻辑解耦；状态间只通过 G（游戏上下文）通信。
 *
 * 事件接口：enter() / exit() / update(dt) / onLeftDown() / onLeftUp() / onRightDown()
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

/* ================= 基类 ================= */
class State {
  constructor(G) { this.G = G; }
  enter() {}
  exit() {}
  update(dt) {}
  onLeftDown() {}
  onLeftUp() {}
  onRightDown() {}
}

/* ================= 1. 无球 ================= */
export class NoBallState extends State {
  enter() {
    const { player, ball, ui } = this.G;
    player.speed = CFG.player.speedIdle;
    if (ball.mode !== 'physics') ball.startPhysics(ball.position, null);
    ui.setPrompt('走近篮球，点击 <b>鼠标左键</b> 拾球');
  }
  update(dt) {
    const { player, ball, ui } = this.G;
    ball.syncFromPhysics();
    const near = ball.mode === 'physics' &&
      Math.hypot(player.pos.x - ball.position.x, player.pos.z - ball.position.z) < CFG.player.pickupRange &&
      ball.position.y < 1.35;
    ui.setPrompt(near
      ? '<b>左键</b> 拾球'
      : 'WASD 移动 · 走近篮球后拾取');
    this._near = near;
  }
  onLeftDown() {
    if (!this._near) return;
    const { ball, machine, sfx, scoring } = this.G;
    ball.startHeld();
    sfx.play('ui', { volume: 0.5 });
    machine.set('hold');
  }
}

/* ================= 2. 原地持球 ================= */
export class HoldState extends State {
  enter() {
    const { player, ui } = this.G;
    player.speed = CFG.player.speedHold;
    ui.setPrompt('<b>右键</b> 行进运球' + (this.G.modeDef.shotScore ? ' · 走入投篮区开始进攻' : ''));
  }
  update(dt) {
    const { player, ball, camera, ui, scoring, machine } = this.G;
    ball.updateHeld(dt, camera);
    if (scoring.ended) return;
    // 持球移动进入投篮触发区 -> 自动切入投篮瞄准（仅计分投篮的模式）
    if (this.G.modeDef.shotScore && player.inShotZone() && player.mode !== 'shot') {
      machine.set('shot');
    }
  }
  onRightDown() {
    // 右键开启/结束行进运球（投篮挑战模式下运球仅是位移手段，无节奏判定）
    this.G.machine.set('dribble');
  }
}

/* ================= 3. 行进运球（卡点拍球） ================= */
export class DribbleState extends State {
  enter() {
    const { player, ball, rhythm, ui, modeDef } = this.G;
    player.speed = CFG.player.speedDribble;
    this.rhythmActive = modeDef.dribbleScore; // 投篮挑战模式下仅带球跑
    ball.startDribbleAnim();
    if (this.rhythmActive) {
      rhythm.reset();
      ui.showDribbleBar(true);
      this._cycleFlashed = false;
    }
    ui.setPrompt(this.rhythmActive
      ? '滚动条进入中央 <b>左键卡点拍球</b> · 右键结束运球'
      : '带球移动中 · <b>右键</b> 结束运球');
  }
  exit() {
    this.G.ui.showDribbleBar(false);
  }
  update(dt) {
    const { player, ball, rhythm, ui, scoring, fx, sfx } = this.G;
    rhythm.combo = scoring.dribbleCombo;

    // 球在身体右侧前方弹跳
    const fx1 = -Math.sin(player.yaw), fz1 = -Math.cos(player.yaw);
    const rx1 = Math.cos(player.yaw), rz1 = -Math.sin(player.yaw);
    const base = new THREE.Vector3(
      player.pos.x + rx1 * 0.5 + fx1 * 0.35, 0,
      player.pos.z + rz1 * 0.5 + fz1 * 0.35
    );
    ball.updateDribbleAnim(this.rhythmActive ? rhythm.t : (this._freePhase = (this._freePhase || 0) + dt * 1.6) % 1, base);

    if (!this.rhythmActive || scoring.ended) return;

    // 推进滚动标记；周期走完未点击时，onCycleMiss 回调自动记失误
    rhythm.update(dt);
    ui.updateDribbleBar(rhythm.t, rhythm.zones());
  }
  onLeftDown() {
    if (!this.rhythmActive) return;
    const { rhythm, scoring, ui, fx, sfx, machine, player, ball } = this.G;
    const r = rhythm.hit();
    if (r === 'perfect') {
      const { points, multiplier } = scoring.addDribblePerfect();
      sfx.play('tick');
      sfx.play('tap', { volume: 0.7, rate: 1 + Math.random() * 0.08 });
      if (multiplier >= CFG.dribble.maxComboMul) sfx.play('combo', { volume: 0.5 });
      fx.burstTap(ball.position);
      ui.flashPerfect(points);
    } else if (r === 'good') {
      scoring.addDribbleGood();
      sfx.play('tap', { rate: 0.94 + Math.random() * 0.1 });
      ui.flashGood();
    } else {
      // 区间外乱拍 / 同周期重复拍 = 一次运球失误
      this.registerFail();
    }
    ui.updateDribbleBar(rhythm.t, rhythm.zones());
  }
  /** 记一次运球失误；满 3 次掉球 */
  registerFail() {
    const { scoring, sfx, fx, machine, player, ball, ui } = this.G;
    const dropped = scoring.addDribbleFail();
    sfx.play('fail', { volume: dropped ? 0.9 : 0.45, rate: dropped ? 1 : 1.25 });
    ui.flashMiss();
    if (dropped) {
      // 连续 3 次失误：掉球！连击清零，回到无球状态
      scoring.onBallDropped();
      const dropPos = ball.position.clone();
      ball.startPhysics(dropPos, new THREE.Vector3(
        (Math.random() - 0.5) * 2.2, 1.2, (Math.random() - 0.5) * 2.2
      ));
      sfx.play('bounce', { volume: 0.8 });
      machine.set('noBall');
    }
  }
  onRightDown() {
    this.G.scoring.onDribbleCancel();
    this.G.machine.set('hold');
  }
}

/* ================= 4. 投篮蓄力 ================= */
export class ShotState extends State {
  enter() {
    const { player, ui, modeDef } = this.G;
    player.speed = CFG.player.speedShot;
    player.enterShotAim();
    this.charge = 0;
    this.charging = false;
    this.flying = false;
    this.scored = false;
    this.resolved = false;
    this.returnTimer = 0;
    this.flightT = 0;
    this._prevY = 0;
    ui.showPowerBar(true);
    ui.setPrompt('<b>按住左键</b> 蓄力 · <b>松开</b> 投篮 · <b>右键</b> 假投');
  }
  exit() {
    const { player, ui } = this.G;
    player.exitShotAim();
    ui.showPowerBar(false);
  }

  update(dt) {
    const { player, ball, camera, ui, scoring, world } = this.G;

    if (!this.flying) {
      /* ---- 持球瞄准阶段 ---- */
      const raised = ball.updateHeld(dt, camera, this.charge * 0.9);
      if (this.charging) this.charge = Math.min(1, this.charge + dt / CFG.shot.chargeTime);
      // 力度条 + 最佳力度段（随站位实时反解）
      ui.updatePowerBar(this.charge, idealPower(raised));
      // 走出投篮区 -> 取消投篮，回到普通持球
      if (!player.inShotZone() && !this.charging) {
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
      this.flightT = (this.flightT || 0) + dt;
      const stuck = this.flightT > 6; // 卡在篮圈上/滚到死角时的保底回收
      if (!this.resolved && (stuck || (bp.y <= CFG.ball.radius + 0.07 && bv.length() < 6))) {
        this.resolved = true;
        this.onResolve();
      } else if (this.resolved) {
        this.returnTimer += dt;
        if (this.returnTimer > 0.4) {
          scoring.ended
            ? this.G.machine.set('hold') // 时间结束：仅收球，UI 弹窗已接管
            : this.G.machine.set(this.G.player.inShotZone() && this.G.modeDef.shotScore ? 'shot' : 'hold');
        }
      }
    }
  }

  onLeftDown() {
    if (this.flying) return;
    this.charging = true;
  }
  onLeftUp() {
    if (this.flying || !this.charging) return;
    const { ball, player, sfx, scoring } = this.G;
    this.charging = false;
    const power = Math.max(0.04, this.charge);
    this.markRelease(); // 记录出手点（2/3 分判定）
    const pos = ball.position.clone();
    ball.startPhysics(pos, shotVelocity(pos, power, player));
    sfx.play('shoot');
    scoring.registerShotAttempt();
    this.flying = true;
    this.flightT = 0;
    this.G.ui.setPrompt('好球轨迹 —— 盯住力度条最佳区！');
  }
  onRightDown() {
    if (this.flying) return;
    // 假投虚晃：取消蓄力，不释放篮球
    if (this.charging || this.charge > 0) {
      this.charging = false;
      this.charge = 0;
      this.G.sfx.play('tap', { volume: 0.5, rate: 1.4 });
      this.G.fx.shake(0.012, 0.12);
      this.G.ui.flashPump();
      this.G.ui.setPrompt('假投成功！重新 <b>按住左键</b> 蓄力');
    }
  }

  /** 进球事件 */
  onScore() {
    this.scored = true;
    const { scoring, sfx, fx, ui } = this.G;
    const { points, is3 } = scoring.addShotMade(this.releaseDist || 5);
    sfx.play('net');
    sfx.play('cheer', { volume: 0.75 });
    fx.burstScore(RIM_POS);
    fx.shake();
    fx.flash();
    this.G.netSway();
    ui.showScorePopup(points, is3 ? '三分命中!' : '两分命中!', scoring.shotCombo);
  }

  /** 球落地后结算（进或不进都走到这里） */
  onResolve() {
    const { scoring, sfx, ui, machine } = this.G;
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

  /** 记录出手点（用于 2/3 分判定），由 main 在释放前调用不便，直接在 onLeftUp 抓 */
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
