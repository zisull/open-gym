/**
 * effects.js —— 视觉反馈：进球粒子、屏幕震动、Bloom 脉冲
 */
import * as THREE from 'three';
import { CFG } from './config.js';

const MAX_PARTICLES = 240;

export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.bloomPulse = 0;         // 进球后泛光强度的额外叠加量
    this.shakeT = 0;             // 剩余震动时间
    this.shakeAmp = 0;

    /* 粒子池：单个 Points，位置/颜色/生命在 CPU 模拟 */
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.vels = new Float32Array(MAX_PARTICLES * 3);
    this.lives = new Float32Array(MAX_PARTICLES);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.07,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.cursor = 0;
    this._colorsDirty = false; // 颜色只在爆点时变化，避免逐帧上传整个 color buffer
    this._nAlive = 0;          // 存活粒子数：归零后整段粒子模拟与上传一起跳过
    this.baseCamPos = new THREE.Vector3();
  }

  /** 进球彩带：从篮圈位置向四周炸开 */
  burstScore(pos) {
    const palette = [
      [1.0, 0.62, 0.15], [1.0, 0.85, 0.4], [1, 1, 1], [0.35, 0.75, 1.0],
    ];
    for (let i = 0; i < 90; i++) {
      const idx = this.cursor % MAX_PARTICLES;
      this.cursor++;
      const a = Math.random() * Math.PI * 2;
      const rr = 0.12 + Math.random() * 0.16;
      const p = idx * 3;
      this.positions[p] = pos.x + Math.cos(a) * rr;
      this.positions[p + 1] = pos.y;
      this.positions[p + 2] = pos.z + Math.sin(a) * rr;
      const up = 1.5 + Math.random() * 3.2;
      const side = 0.6 + Math.random() * 1.6;
      this.vels[p] = Math.cos(a) * side;
      this.vels[p + 1] = up;
      this.vels[p + 2] = Math.sin(a) * side;
      const c = palette[(Math.random() * palette.length) | 0];
      this.colors[p] = c[0]; this.colors[p + 1] = c[1]; this.colors[p + 2] = c[2];
      this.lives[idx] = 0.8 + Math.random() * 0.5;
    }
    this._colorsDirty = true;
  }

  /** 完美拍球的小火花 */
  burstTap(pos) {
    for (let i = 0; i < 12; i++) {
      const idx = this.cursor % MAX_PARTICLES;
      this.cursor++;
      const p = idx * 3;
      this.positions[p] = pos.x; this.positions[p + 1] = CFG.ball.radius; this.positions[p + 2] = pos.z;
      const a = Math.random() * Math.PI * 2;
      this.vels[p] = Math.cos(a) * 0.8; this.vels[p + 1] = 0.8 + Math.random() * 1.2; this.vels[p + 2] = Math.sin(a) * 0.8;
      this.colors[p] = 1; this.colors[p + 1] = 0.9; this.colors[p + 2] = 0.5;
      this.lives[idx] = 0.3;
    }
    this._colorsDirty = true;
  }

  /** 触发屏幕震动 */
  shake(amp = CFG.fx.shakeAmp, dur = CFG.fx.shakeDur) {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = Math.max(this.shakeT, dur);
  }

  /** 触发 Bloom 高光脉冲（进球时调用） */
  flash() { this.bloomPulse = 1; }

  /**
   * 每帧更新：粒子模拟 + 震动偏移 + 脉冲衰减
   * 震动以偏移量形式返回，由 main 叠加到相机上（不污染玩家逻辑位置）。
   */
  update(dt) {
    /* 粒子：没有活着的就整段跳过 —— 空池时逐帧上传 720 个顶点对画面毫无贡献 */
    if (this._nAlive > 0 || this._colorsDirty) {
      let n = 0;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (this.lives[i] <= 0) continue;
        n++;
        this.lives[i] -= dt;
        const p = i * 3;
        this.vels[p + 1] -= 6.5 * dt;
        this.positions[p] += this.vels[p] * dt;
        this.positions[p + 1] += this.vels[p + 1] * dt;
        this.positions[p + 2] += this.vels[p + 2] * dt;
        if (this.lives[i] <= 0) {
          // 藏到远处
          this.positions[p + 1] = -100;
        }
      }
      this._nAlive = n;
      this.points.geometry.attributes.position.needsUpdate = true;
      if (this._colorsDirty) {
        this.points.geometry.attributes.color.needsUpdate = true;
        this._colorsDirty = false;
      }
    }

    // Bloom 脉冲指数衰减
    this.bloomPulse *= Math.exp(-3.2 * dt);
    if (this.bloomPulse < 0.01) this.bloomPulse = 0;

    // 震动
    let off = null;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / CFG.fx.shakeDur) * this.shakeAmp;
      off = {
        x: (Math.random() - 0.5) * 2 * k,
        y: (Math.random() - 0.5) * 2 * k,
      };
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }
    return off;
  }
}
