/**
 * ball.js —— 篮球（渲染网格 + 物理刚体的统一封装）
 * 三种存在形态：
 *   physics  —— 自由物理（投篮飞行、掉球后弹跳）
 *   held     —— 持球（脱离物理世界，挂在镜头右前方的"手中"）
 *   dribble  —— 运球动画（脱离物理，弹跳节奏与拍球进度条同相位）
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeBallTexture } from './textures.js';

export class GameBall {
  /**
   * @param {THREE.Scene} scene
   * @param {import('cannon-es').World} world
   * @param {import('cannon-es').Body} body 物理刚体（physics.js 中创建）
   */
  constructor(scene, world, body) {
    this.world = world;
    this.body = body;
    this.mode = 'physics';

    const geo = new THREE.SphereGeometry(CFG.ball.radius, 32, 24);
    const mat = new THREE.MeshStandardMaterial({
      map: makeBallTexture(),
      roughness: 0.62,
      metalness: 0.02,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    this._tmpQ = new THREE.Quaternion();
    this._heldTimer = 0;
  }

  /** 切为自由物理体，可给初速度 */
  startPhysics(pos, vel) {
    if (this.mode !== 'physics') {
      this.world.addBody(this.body);
      this.body.wakeUp();
    }
    this.body.position.set(pos.x, pos.y, pos.z);
    this.body.velocity.set(vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.mode = 'physics';
  }

  /** 切为持球 */
  startHeld() {
    if (this.mode !== 'held') {
      this.world.removeBody(this.body);
      this.mode = 'held';
    }
    this._heldTimer = 0;
  }

  /** 切为运球动画模式 */
  startDribbleAnim() {
    if (this.mode !== 'dribble') {
      this.world.removeBody(this.body);
      this.mode = 'dribble';
    }
  }

  /** 持球姿态：跟随相机右手位置，蓄力时举过头顶前倾 */
  updateHeld(dt, camera, charge = 0) {
    this._heldTimer += dt;
    // 基准手部偏移（相机局部系）：右下前方
    const hand = new THREE.Vector3(0.42, -0.32 + charge * 0.62, -0.72 - charge * 0.18);
    // 轻微呼吸浮动
    hand.y += Math.sin(this._heldTimer * 2.4) * 0.012;
    hand.x += Math.sin(this._heldTimer * 1.7) * 0.008;
    hand.applyQuaternion(camera.quaternion);
    this.mesh.position.copy(camera.position).add(hand);
    // 持球自转缓慢朝向镜头
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.rotateX(0.4 + charge * 0.5);
    this.mesh.rotateZ(Math.sin(this._heldTimer * 1.3) * 0.1);
    return this.mesh.position;
  }

  /**
   * 运球动画：phase∈[0,1) 与进度条同相位，t=0.5（中央完美区）时球触底
   * @param {THREE.Vector3} basePos 玩家脚边球位（世界系 xz）
   */
  updateDribbleAnim(phase, basePos) {
    const r = CFG.ball.radius;
    const A = CFG.dribble.bounceAmp;
    // t=0.5 谷底，t=0/1 峰顶
    const h = r + A * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase));
    this.mesh.position.set(basePos.x, h, basePos.z);
    // 球体滚动外观：下落/上升时绕侧轴转
    this.mesh.rotation.x += (1 - h) * 0.4 + 0.05;
    this.mesh.rotation.z = Math.sin(phase * Math.PI * 2) * 0.3;
    return this.mesh.position;
  }

  /** 物理模式：把刚体状态同步到网格 */
  syncFromPhysics() {
    if (this.mode !== 'physics') return;
    this.mesh.position.set(this.body.position.x, this.body.position.y, this.body.position.z);
    this.mesh.quaternion.set(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
  }

  /** 球当前世界位置 */
  get position() { return this.mesh.position; }

  /** 是否已经落在地面上（静止判定用） */
  resting() {
    return this.mode === 'physics' &&
      this.body.velocity.length() < 0.35 &&
      this.body.position.y < CFG.ball.radius + 0.08;
  }
}
