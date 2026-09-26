/**
 * player.js —— 第一人称"玩家"（镜头即玩家，不渲染人物模型）
 * 职责：WASD 移动（指数逼近、帧率无关）、空格跳跃（含落地缓冲）、鼠标阻尼转向、
 *       视角平滑插值（自由视角 <-> 投篮瞄准视角）、头部微晃（head bob）、
 *       与投篮触发区的几何判断。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { RIM_POS } from './court.js';

const PITCH_LIMIT = 1.45;   // 俯仰限制 ≈ ±83°：留一点余量，避免正好仰到头顶

export class Player {
  /**
   * @param {THREE.PerspectiveCamera} camera 主相机
   */
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 0, 2.2);      // 地面位置（脚底投影），位于中圈附近
    this.vel = new THREE.Vector3();
    // --- 竖直（跳跃）---
    // pos 始终是脚底在地面上的投影；离地高度单独记在 y 上，
    // 这样边界钳制、投篮距离、拾球判定都仍是纯 2D 的，不必处处减高度。
    this.y = 0;
    this.vy = 0;
    this.landDip = 0;                              // 落地缓冲（视高瞬时下沉，指数衰减）
    this.onLand = null;                            // 落地回调（main 挂音效）

    // --- 视角状态 ---
    // freeYaw/freePitch：鼠标直接控制的"原始"目标角（累积）
    // targetYaw/targetPitch：实际驱动相机的目标角（含投篮吸附修正）
    // yaw/pitch：经阻尼后的当前角（真正渲染用，消除抖动）
    this.freeYaw = 0;                             // yaw=0 即面向 -z（开局正对进攻端篮筐）
    this.freePitch = 0;
    this.yaw = this.freeYaw;
    this.pitch = this.freePitch;
    this.targetYaw = this.freeYaw;
    this.targetPitch = this.freePitch;

    // 投篮视角修正量（瞄准模式下鼠标只能在该范围内微调）
    this.shotOffsetYaw = 0;
    this.shotOffsetPitch = 0;
    this.shotAnchorYaw = 0;   // 进入投篮区时记录的朝向
    this.shotAnchorPitch = 0;

    this.mode = 'free';       // 'free' | 'shot'（镜头行为模式，与游戏状态机并行）
    this.blend = 0;           // 自由 <-> 投篮瞄准 的插值权重（平滑过渡）
    this.speed = CFG.player.speedIdle;
    this.bobPhase = 0;
    this.keys = { w: false, a: false, s: false, d: false };
    this.inputEnabled = true; // 结算弹窗/暂停时关闭
    this.eyeHeight = CFG.player.eye;   // 当前视高（影院入座时按座位调整）
    // 可行走区域与圆柱阻挡（可被影院等场景整体替换）
    this.bounds = {
      minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
      minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
    };
    this.blockers = [
      { x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 },  // 篮架立柱
      { x: 0, z: CFG.arch.targetZ + 0.34, r: 0.8 },     // 靶架：别直接从正面走进靶子里
    ];
  }

  /** 鼠标移动输入：dx/dy 为像素增量 */
  look(dx, dy) {
    if (!this.inputEnabled) return;
    const sens = CFG.player.sens;
    this.freeYaw -= dx * sens;
    this.freePitch -= dy * sens;
    // 俯仰限制在 ±83°
    this.freePitch = THREE.MathUtils.clamp(this.freePitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (this.mode === 'shot') {
      // 投篮模式：鼠标只能微调相对篮筐锚点的偏移
      this.shotOffsetYaw = THREE.MathUtils.clamp(this.shotOffsetYaw - dx * sens, -0.22, 0.22);
      this.shotOffsetPitch = THREE.MathUtils.clamp(this.shotOffsetPitch - dy * sens * 0.8, -0.25, 0.25);
    }
  }

  /**
   * 起跳（空格）：只在落地状态下有效，空中再按不接力。
   * @returns {boolean} 是否真的跳起来了
   */
  jump() {
    if (!this.inputEnabled || this.y > 1e-4 || this.vy > 0) return false;
    this.vy = CFG.player.jumpSpeed;
    this.y = 0.002; // 立刻标记离地，本帧的落地判定不会再吃掉这次起跳
    return true;
  }

  /** 切换到投篮瞄准模式（进入触发区时由状态机调用） */
  enterShotAim() {
    this.mode = 'shot';
    const aim = this.rimAim();
    this.aimBaseYaw = this.wrapDelta(aim.yaw - this.freeYaw);
    this.aimBasePitch = aim.pitch;
    this.shotAnchorYaw = this.freeYaw;
    this.shotAnchorPitch = this.freePitch;
  }

  /** 离开投篮瞄准模式：把当前视角交还自由控制，偏移平滑归零 */
  exitShotAim() {
    if (this.mode !== 'shot') return;
    // 以当前实际视角作为新的自由视角，避免退出瞬间跳变
    this.freeYaw = this.yaw;
    this.freePitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.mode = 'free';
  }

  /** 面向篮筐所需的 yaw/pitch（从当前位置看向圈心） */
  rimAim() {
    const dx = RIM_POS.x - this.pos.x;
    const dz = RIM_POS.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    // three.js 约定：yaw=0 面向 -z
    let yaw = Math.atan2(-dx, -dz);
    const dy = RIM_POS.y - this.eyeHeight;  // 用当前视高，而不是配置默认值
    const pitch = Math.atan2(dy, dist);
    return { yaw, pitch };
  }

  /** 角度差归一到 (-PI, PI] */
  wrapDelta(d) {
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** 是否位于投篮触发区（进攻端三分线内的扇形） */
  inShotZone() {
    const p = this.pos;
    if (p.z > CFG.shot.zoneMaxZ) return false;
    const d = Math.hypot(p.x - RIM_POS.x, p.z - RIM_POS.z);
    return d < CFG.shot.zoneRadius && d > CFG.shot.zoneMinDist;
  }

  /**
   * 每帧更新
   * @param {number} dt 秒
   */
  update(dt) {
    const P = CFG.player;

    /* ---- 1. 移动输入 -> 期望速度 ---- */
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw); // 前方单位向量
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);  // 右方单位向量
    let ix = 0, iz = 0;
    if (this.inputEnabled) {
      if (this.keys.w) iz += 1;
      if (this.keys.s) iz -= 1;
      if (this.keys.d) ix += 1;
      if (this.keys.a) ix -= 1;
    }
    const mag = Math.hypot(ix, iz);
    if (mag > 0) { ix /= mag; iz /= mag; }
    const wishX = fx * iz + rx * ix;
    const wishZ = fz * iz + rz * ix;
    // 帧率无关的指数逼近：起速跟手、松键平滑滑行（旧的 accel/speed 比值写法会让
    // 手感随帧率漂移 —— 高刷屏发飘、低刷屏粘脚）
    const inAir = this.y > 1e-4 || this.vy > 0;
    const rate = (mag > 0 ? P.accel : P.brake) * (inAir ? P.airControl : 1);
    const k = 1 - Math.exp(-rate * dt);
    this.vel.x += (wishX * this.speed - this.vel.x) * k;
    this.vel.z += (wishZ * this.speed - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    /* ---- 1b. 跳跃：竖直积分 + 落地缓冲 ---- */
    if (inAir) {
      this.vy -= P.gravity * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.landDip = Math.min(0.16, -this.vy * 0.03); // 落得越重视高沉得越多
        this.y = 0;
        this.vy = 0;
        this.onLand?.(); // 落地音效由外层挂
      }
    }
    this.landDip *= Math.exp(-13 * dt);

    /* ---- 2. 边界钳制 + 圆柱阻挡（bounds/blockers 可被影院场景替换） ---- */
    const B = this.bounds;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, B.minX, B.maxX);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, B.minZ, B.maxZ);
    for (const blk of this.blockers) {
      const dpx = this.pos.x - blk.x, dpz = this.pos.z - blk.z;
      const pd = Math.hypot(dpx, dpz);
      if (pd < blk.r && pd > 0.0001) {
        this.pos.x = blk.x + (dpx / pd) * blk.r;
        this.pos.z = blk.z + (dpz / pd) * blk.r;
      }
    }

    /* ---- 3. 视角目标计算（含投篮吸附平滑插值） ---- */
    const targetBlend = this.mode === 'shot' ? 1 : 0;
    // blend 指数趋近：镜头切换无突兀跳转
    this.blend += (targetBlend - this.blend) * Math.min(1, dt * 5.2);

    let desYaw = this.freeYaw, desPitch = this.freePitch;
    if (this.mode === 'shot' && this.aimBaseYaw !== undefined) {
      const aim = this.rimAim();
      const by = this.wrapDelta(aim.yaw - this.freeYaw);
      const targetAimYaw = this.freeYaw + by + this.shotOffsetYaw;
      const targetAimPitch = aim.pitch + this.shotOffsetPitch;
      const dyaw = this.wrapDelta(targetAimYaw - this.freeYaw);
      desYaw = this.freeYaw + dyaw * this.blend;
      desPitch = THREE.MathUtils.lerp(this.freePitch, targetAimPitch, this.blend);
    }
    this.targetYaw = desYaw;
    this.targetPitch = THREE.MathUtils.clamp(desPitch, -PITCH_LIMIT, PITCH_LIMIT);

    /* ---- 4. 视角阻尼（指数平滑，消除鼠标抖动） ---- */
    const damp = 1 - Math.exp(-P.lookDamping * dt);
    this.yaw += this.wrapDelta(this.targetYaw - this.yaw) * damp;
    this.pitch += (this.targetPitch - this.pitch) * damp;

    /* ---- 5. 相机落位：视高 + 跳跃离地 + 头部微晃 ---- */
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    const bobOn = P.headBob && !inAir;
    if (bobOn) this.bobPhase += dt * (4.5 + speedH * 1.4);
    // 晃幅用平滑斜坡开门，不在某个速度上硬切（那一下突跳就是"移动不顺眼"的根源）
    const ramp = Math.min(1, Math.max(0, (speedH - 0.15) / 0.9));
    const bob = bobOn ? Math.sin(this.bobPhase * 2) * 0.018 * Math.min(1, speedH / 3) * ramp : 0;
    const roll = bobOn ? Math.sin(this.bobPhase) * 0.004 * Math.min(1, speedH / 3) * ramp : 0;

    this.camera.position.set(this.pos.x, this.eyeHeight + this.y - this.landDip + bob, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.camera.rotateZ(roll);
    return this;
  }
}
