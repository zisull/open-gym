/**
 * ball.js —— 篮球（渲染网格 + 物理刚体的统一封装）
 * 三种存在形态：
 *   physics —— 自由物理（投篮飞行、掉球后弹跳）
 *   held    —— 持球（脱离物理世界，挂在镜头右前方的"手中"，可叠加拍球动画）
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeBallTexture, makeBallBumpTexture, makeBallRoughness } from './textures.js';

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
      bumpMap: makeBallBumpTexture(),   // 麻点+筋沟微观起伏
      bumpScale: 1.6,
      roughness: 1.0,                   // 实际粗糙度由贴图控制（筋沟/麻点更哑光）
      roughnessMap: makeBallRoughness(),
      metalness: 0.02,
      envMapIntensity: 0.45,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    this._tmpQ = new THREE.Quaternion();
    this._hand = new THREE.Vector3(); // 复用的手部偏移向量（每帧调用，避免分配）
    this._heldTimer = 0;
  }

  /** 切为自由物理体，可给初速度 */
  startPhysics(pos, vel) {
    if (this.mode !== 'physics') {
      this.world.addBody(this.body);
      this.body.wakeUp();
    }
    this._tapT = undefined;
    this.mesh.scale.set(1, 1, 1);
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
    this._tapT = undefined;
    this.mesh.scale.set(1, 1, 1);
  }

  /**
   * 拍球（无门槛装饰动作）：仅持球态可触发，球自动向下拍击并回手。
   * @returns {boolean} 是否成功触发（正在拍球/非持球态返回 false）
   */
  tap() {
    if (this.mode !== 'held' || this._tapT !== undefined) return false;
    this._tapT = 0;
    return true;
  }

  /** 持球姿态：跟随相机右手位置，蓄力时举过头顶前倾；叠加拍球下探动画 */
  updateHeld(dt, camera, charge = 0) {
    this._heldTimer += dt;
    // 基准手部偏移（相机局部系）：右下前方腰部位置
    const hand = this._hand.set(0.38, -0.26 + charge * 0.60, -0.70 - charge * 0.16);
    // 轻微呼吸浮动（拍球时冻结，避免抢戏）
    let rock = 0;     // 拍球时缝线前后摆动（贴图转起来才看得见"在运球"）
    let squash = 0;   // 触底挤压
    if (this._tapT === undefined) {
      hand.y += Math.sin(this._heldTimer * 2.4) * 0.012;
      hand.x += Math.sin(this._heldTimer * 1.7) * 0.008;
    }
    // 拍球：三角波下压—触底—回手（匀速下探、到底立刻反向往上，就是那一下弹）
    if (this._tapT !== undefined) {
      this._tapT += dt;
      const u = this._tapT / CFG.tap.dur;
      if (u >= 1) {
        this._tapT = undefined;
      } else {
        const g = 1 - Math.abs(1 - 2 * u);
        hand.x -= g * 0.14;           // 下落时往身体中线收，像真正在身前拍
        hand.y -= g * 0.26;
        hand.z -= g * 0.28;           // 同时往前推：画面里就是一路往下砸
        rock = g * 1.5;
        squash = Math.max(0, 1 - Math.abs(u - 0.5) / 0.15); // 只在触底那小段挤压
      }
    }
    // 兜底：球永远不许掉出画面下缘，否则拍球又变成"只有声音没动画"
    const fwd = -hand.z;
    if (fwd > 0.05) {
      const lim = Math.tan(THREE.MathUtils.degToRad(Math.max(12, camera.fov * 0.5 - 9)));
      if (-hand.y > fwd * lim) hand.y = -fwd * lim;
      else if (hand.y > fwd * lim) hand.y = fwd * lim;
    }
    this.mesh.scale.set(1 + squash * 0.16, 1 - squash * 0.22, 1 + squash * 0.16);
    hand.applyQuaternion(camera.quaternion);
    this.mesh.position.copy(camera.position).add(hand);
    // 持球自转缓慢朝向镜头
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.rotateX(0.4 + charge * 0.5 + rock);
    this.mesh.rotateZ(Math.sin(this._heldTimer * 1.3) * 0.1);
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
}
