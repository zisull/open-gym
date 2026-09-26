/**
 * states.js —— 独立游戏状态机
 * 球在手的三种状态：无球(noBall) / 持球(hold) / 投篮蓄力(shot)，加上手上是弓的 arch。
 * 每个状态是一个独立类，逻辑解耦；状态间只通过 G（游戏上下文）通信。
 *
 * 事件接口：enter() / exit() / update(dt) / onLeftDown() / onLeftUp() / onRightDown() / onGrab()（E）
 * 拍球不再是事件：持球状态下由 HoldState 每帧自动打节拍（见 autoDribble）。
 * 空格是玩家级的跳跃，直接走 Player.jump()，不进状态机。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { RIM_POS } from './court.js';
import { targetDist } from './archery.js';

/* ================= 共用工具 ================= */

/**
 * 求"命中圈心所需的理论力度值(0~1)"——抛体运动反解。
 * 固定仰角 elevAngle，已知水平距离 d 与高度差 dy：
 *   v^2 = g*d^2 / (2*cos^2(a) * (d*tan(a) - dy))
 */
function idealPower(releasePos) {
  const g = CFG.player.gravity, a = CFG.shot.elevAngle;
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
 * 投篮挑战的「这一球」：只定距离，不定位置。
 * r = 本球固定距离（也就是倍率），a = 出生角；之后沿这条弧随便走，
 * 因为同一个距离下总有能出手的角度 —— 老写法把点钉死在 (x,z)，
 * 撞上篮板侧翼那种特殊角度就只能干等倒计时。
 * 出生角收在弧位的六成以内，免得刚落地就贴着走不动的弧端。
 */
export function randomShotSpot() {
  const S = CFG.shot;
  const r = THREE.MathUtils.lerp(S.randomSpotMin, S.randomSpotMax, Math.random());
  return { r, a: (Math.random() * 2 - 1) * S.spotArc * 0.6 };
}

/** 本球极坐标（相对圈心）-> 场地坐标 */
export function shotSpotXZ({ r, a }) {
  return { x: RIM_POS.x + Math.sin(a) * r, z: RIM_POS.z + Math.cos(a) * r };
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
    // 走到侧门附近时由门接管提示：一帧只有一个提示写入者，省掉一次无谓的 innerHTML 重排
    ui.setPrompt(this.G.doorHint() || (near
      ? '<b>E</b> 拾球'
      : 'WASD 移动 · <b>空格</b> 跳跃 · 走近篮球后按 E 拾取'));
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
    // 结算时一律切到 hold 收尾；射箭模式手上没有球，这里当"什么都不拿"的落地态用
    this.passive = !!modeDef.bow;
    if (this.passive) return;
    player.speed = CFG.player.speedHold;
    this.tapT = 0;
    ui.setPrompt(modeDef.id === 'free'
      ? '球<b>自动拍</b>（跟着走位就变速）· <b>左键</b> 投篮（按住蓄力 松手出手）· <b>空格</b> 跳跃（可跳投）· <b>E</b> 弃球'
      : 'WASD 走位 · 球自动拍 · <b>左键</b> 按住蓄力投篮 · <b>空格</b> 跳投 · <b>E</b> 弃球');
  }
  update(dt) {
    if (this.passive) return;
    const { player, ball, camera, scoring, machine } = this.G;
    ball.updateHeld(dt, camera);
    // 结算已定：拍球声/+2 飘字都不许再冒出来（球仍随手持，只是不再打地）
    if (scoring.ended) return;
    this.autoDribble(dt);
    // 持球移动进入投篮触发区 -> 自动切入投篮瞄准（仅计分投篮的模式）
    if (this.G.modeDef.shotScore && player.inShotZone() && player.mode !== 'shot') {
      machine.set('shot');
    }
  }
  /**
   * 自动拍球：持球就一直拍，不用管键位；节拍跟着移速走（站着慢拍、跑动快拍）。
   * 上一拍动画没走完就顺延，绝不叠拍或抢帧。
   */
  autoDribble(dt) {
    const { player, ball, sfx, fx, ui, scoring } = this.G;
    const [slow, fast] = CFG.tap.every;
    const sp = Math.hypot(player.vel.x, player.vel.z);
    const gap = THREE.MathUtils.lerp(slow, fast, Math.min(1, sp / Math.max(player.speed, 0.001)));
    this.tapT += dt;
    if (this.tapT < gap) return;
    this.tapT = 0;
    if (!ball.tap()) return;
    sfx.play('tap', { rate: 1.85 + Math.random() * 0.12, volume: 0.85 });
    const { points } = scoring.addTap();
    if (points > 0) ui.showScorePopup(points, null);
    fx.burstTap(ball.position);
  }
  onLeftDown() {
    // 左键 = 投篮：立即进入蓄力状态（松手出手）
    if (!this.G.modeDef.shotScore) return;
    this.G.pendingCharge = true;
    this.G.machine.set('shot');
  }
  onGrab() {
    discardBall(this.G); // E = 弃球（球回到场地中央）
  }
}

/* ================= 3. 投篮蓄力 ================= */
export class ShotState extends State {
  enter() {
    const { player, ui, modeDef, scoring } = this.G;
    // 挑战模式：沿本球弧线走位；自由模式：慢速微调
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
    // 挑战模式说清楚"为什么走不到篮下"：这一球锁的是距离，能挑的只有角度
    const ring = modeDef.id === 'shot' && scoring.currentSpot
      ? `🎯 本球锁 <b>${scoring.currentSpot.r.toFixed(1)}m</b> · 沿弧线走位挑角度 · ` : '';
    ui.setPrompt(`${ring}<b>按住左键</b> 蓄力 · <b>松手</b> 投篮 · <b>空格</b> 跳投（空中也能出手）· <b>右键</b> 取消 · <b>E</b> 弃球`);
  }
  exit() {
    const { player, ui } = this.G;
    player.exitShotAim();
    ui.showPowerBar(false);
  }

  /**
   * 挑战模式：只锁距离、不锁角度 —— 把玩家钉在这一球的投篮弧上。
   * 沿切向（斜着走 / A、D）自由挑角度，径向分量直接削掉，所以近不了也退不了；
   * 撞到弧端时把往外顶的那半也削掉，免得贴着墙原地晃头。
   */
  clampToRing() {
    const { player, scoring } = this.G;
    const spot = scoring.currentSpot;
    if (!spot) return;
    const A = CFG.shot.spotArc;
    const dx = player.pos.x - RIM_POS.x, dz = player.pos.z - RIM_POS.z;
    const raw = Math.atan2(dx, dz);                     // 相对半场正面的偏角
    const a = THREE.MathUtils.clamp(raw, -A, A);
    const ux = Math.sin(a), uz = Math.cos(a);           // 径向单位向量
    const tx = uz, tz = -ux;                            // 切向（偏角增大方向）
    player.pos.x = RIM_POS.x + ux * spot.r;
    player.pos.z = RIM_POS.z + uz * spot.r;
    let vt = player.vel.x * tx + player.vel.z * tz;
    if (a !== raw && Math.sign(vt) === Math.sign(raw)) vt = 0;
    player.vel.x = tx * vt;
    player.vel.z = tz * vt;
  }

  update(dt) {
    const { player, ball, camera, ui, scoring, modeDef } = this.G;

    if (modeDef.id === 'shot') this.clampToRing();

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
      const p = shotSpotXZ(spot);
      player.pos.set(p.x, 0, p.z);
      player.vel.set(0, 0, 0);
      scoring.currentSpot = spot;
      scoring.spots++;
      this.G.sfx.play('combo', { volume: 0.55 });
      ui.showScorePopup(0, `🎯 命中！下一球换 ${spot.r.toFixed(1)}m`);
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
      this.G.ui.setPrompt('<b>按住左键</b> 蓄力 · <b>松手</b> 投篮 · <b>空格</b> 跳投 · <b>右键</b> 取消 · <b>E</b> 弃球');
      return;
    }
    const { ball, player, sfx, scoring, ui } = this.G;
    const power = this.charge;
    this.markRelease(); // 记录出手点（2/3 分判定）
    const pos = ball.position.clone();
    ball.startPhysics(pos, shotVelocity(pos, power, player));
    sfx.play('shoot');
    scoring.registerShotAttempt();
    this.flying = true;
    this.flightT = 0;
    this._prevY = undefined; // 重置穿越判定基线，从飞行首帧开始采样
    ui.showPowerBar(false); // 球已出手，力度条当场退场（不用等状态退出）
    ui.setPrompt('好球轨迹 —— 盯住力度条最佳区！');
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
    ui.showScorePopup(points, label);
  }

  /** 球落地后结算（进或不进都走到这里） */
  onResolve() {
    const { scoring, sfx, ui } = this.G;
    if (!this.scored) {
      sfx.play('bounce', { volume: 0.9 });
      const comboReset = scoring.addShotMiss();
      if (this.G.modeDef.shotScore) {
        ui.showScorePopup(0, comboReset ? '三不沾! 连击清零' : '没进… 调整力度再来');
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

/* ================= 4. 射箭（手上是弓，没有球） =================
   操作语言与投篮一致：按住左键蓄力、松手出手、右键取消。
   区别只有两件 —— 距离自己走位挑（没有锁弧），以及有一条**说真话的弹道虚线**：
   虚线与这一发走的是同一段定步长积分，所以虚线末端落在哪、箭就扎在哪。 */
const _hitPos = new THREE.Vector3();

export class ArchState extends State {
  enter() {
    const { player, ui, archery } = this.G;
    player.speed = CFG.player.speedIdle;   // 空手走位：距离和角度都由自己挑
    this.charge = 0;
    this.charging = false;
    this.flying = false;
    this.releaseDist = 0;
    archery.showRig(true);
    ui.showPowerBar(true);
    ui.setPrompt('WASD 走位挑靶距 · <b>按住左键</b> 拉弓 · <b>松手</b> 放箭 · 虚线末端就是落点 · <b>右键</b> 收弓');
  }
  exit() {
    this.G.archery.showRig(false);
    this.G.ui.showPowerBar(false);
  }
  update(dt) {
    const { archery, ui } = this.G;
    if (this.charging) this.charge = Math.min(1, this.charge + dt / CFG.arch.chargeTime);
    if (this.flying) {
      const ev = archery.advance(dt);
      if (ev) this.resolve(ev);
      return;
    }
    archery.aim(this.charge);      // 未拉弓也画：这条线就是准星之外唯一的瞄具
    ui.updatePowerBar(this.charge, null);
  }
  onLeftDown() { if (!this.flying) this.charging = true; }
  onLeftUp() {
    if (this.flying || !this.charging) return;
    this.charging = false;
    const { archery, scoring, ui, player } = this.G;
    // 一拉就松（拉距过低）= 收弓，不出箭也不记出手
    if (this.charge < CFG.arch.cancelDraw) {
      this.charge = 0;
      ui.updatePowerBar(0, null);
      return;
    }
    this.releaseDist = targetDist(player.pos.x, player.pos.z);   // 与 HUD 那个倍率同一个口径
    scoring.registerShotAttempt();
    archery.shoot();
    this.flying = true;
  }
  onRightDown() {
    if (this.flying) return;
    this.charging = false;
    this.charge = 0;
    this.G.sfx.play('tap', { volume: 0.5, rate: 1.4 });
  }

  /** 一箭落定：上靶面才计分，其余与投篮同一套连击惩罚 */
  resolve(ev) {
    const { scoring, sfx, fx, ui } = this.G;
    this.flying = false;
    this.charge = 0;
    ui.updatePowerBar(0, null);
    if (ev.kind === 'hit') {
      const { points, distMul, bull } = scoring.addArrowMade(ev.ring, this.releaseDist);
      sfx.play('rim', { volume: 0.9, rate: 1.5 });   // 扎进草垫那一声闷响
      if (bull) { sfx.play('cheer', { volume: 0.7 }); fx.shake(); fx.flash(); }
      fx.burstScore(_hitPos.set(ev.x, ev.y, ev.z));
      ui.showScorePopup(points, `${bull ? '🎯 黄心' : ev.ring + ' 环'} · 靶距×${distMul.toFixed(1)}`);
      return;
    }
    const comboReset = scoring.addShotMiss();
    sfx.play(ev.kind === 'board' ? 'rim' : 'bounce', { volume: 0.5, rate: 0.85 });
    ui.showScorePopup(0, ev.kind === 'board' ? '擦到靶架，没上靶面'
      : (comboReset ? '连击清零… 盯虚线末端抬一点' : '没上靶 · 看虚线落点再瞄'));
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
