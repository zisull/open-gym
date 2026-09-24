/**
 * player.js —— 第一人称"玩家"（镜头即玩家，不渲染人物模型）
 * 职责：WASD 移动、鼠标阻尼转向、视角平滑插值（自由视角 <-> 投篮瞄准视角）、
 *       头部微晃（head bob）、与投篮触发区的几何判断。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { RIM_POS } from './court.js';

export class Player {
  /**
   * @param {THREE.PerspectiveCamera} camera 主相机
   */
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 0, 2.2);      // 地面位置（y 恒为 0），位于中圈附近
    this.vel = new THREE.Vector3();

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
    this.blockers = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }]; // 篮架立柱
  }

  /** 鼠标移动输入：dx/dy 为像素增量 */
  look(dx, dy) {
    if (!this.inputEnabled) return;
    const sens = CFG.player.sens;
    this.freeYaw -= dx * sens;
    this.freePitch -= dy * sens;
    // 俯仰限制在 ±85°
    this.freePitch = THREE.MathUtils.clamp(this.freePitch, -1.45, 1.45);
    if (this.mode === 'shot') {
      // 投篮模式：鼠标只能微调相对篮筐锚点的偏移
      this.shotOffsetYaw = THREE.MathUtils.clamp(this.shotOffsetYaw - dx * sens, -0.22, 0.22);
      this.shotOffsetPitch = THREE.MathUtils.clamp(this.shotOffsetPitch - dy * sens * 0.8, -0.25, 0.25);
    }
  }

  /** 切换到投篮瞄准模式（进入触发区时由状态机调用） */
  enterShotAim() {
    this.mode = 'shot';
    const aim = this.rimAim();
    this.aimAnchor = aim; // 记录初始锚点
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
    this.freePitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
    this.mode = 'free';
  }

  /** 面向篮筐所需的 yaw/pitch（从当前位置看向圈心） */
  rimAim() {
    const dx = RIM_POS.x - this.pos.x;
    const dz = RIM_POS.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    // three.js 约定：yaw=0 面向 -z
    let yaw = Math.atan2(-dx, -dz);
    const dy = RIM_POS.y - CFG.player.eye;
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
    const k = Math.min(1, P.accel * dt / Math.max(this.speed, 0.001)); // 加速度平滑
    this.vel.x += (wishX * this.speed - this.vel.x) * k;
    this.vel.z += (wishZ * this.speed - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

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
    this.targetPitch = THREE.MathUtils.clamp(desPitch, -1.45, 1.45);

    /* ---- 4. 视角阻尼（指数平滑，消除鼠标抖动） ---- */
    const damp = 1 - Math.exp(-P.lookDamping * dt);
    this.yaw += this.wrapDelta(this.targetYaw - this.yaw) * damp;
    this.pitch += (this.targetPitch - this.pitch) * damp;

    /* ---- 5. 相机落位：视高 + 头部微晃 ---- */
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    if (P.headBob) {
      this.bobPhase += dt * (4.5 + speedH * 1.4);
    }
    const bob = speedH > 0.4 ? Math.sin(this.bobPhase * 2) * 0.018 * Math.min(1, speedH / 3) : 0;
    const roll = speedH > 0.4 ? Math.sin(this.bobPhase) * 0.004 * Math.min(1, speedH / 3) : 0;

    this.camera.position.set(this.pos.x, this.eyeHeight + bob, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.camera.rotateZ(roll);
    return this;
  }
}
