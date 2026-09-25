/**
 * pool.js —— 仿真台球室（球馆 +Z 端墙左侧的绿门进入）
 *
 * 为什么自己写 2D 台面物理而不用 cannon：
 *  1) 台球的全部趣味来自"预测线 == 真实轨迹"，虚线导向必须和积分器共用同一套数学；
 *     交给刚体引擎就得再猜一次它怎么撞库边，导向线永远差一点。
 *  2) 台面本质是平面问题（球心恒定高度），一份 (x,z,vx,vz) 数组 + 自适应子步就够，
 *     比建 16 个刚体更省，而且完全确定、可脚本回归。
 * 库边不是四面墙，而是"带袋口的若干线段"（RAILS）：球只在段内反弹，段外就是袋口通道，
 * 越过库线即判进袋 —— 物理与建模共用同一份 RAILS/POCKETS，不会出现"画了个洞却弹回来"。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeCarpetTexture, makeFeltTexture, makePoolBallTexture } from './textures.js';

const K = CFG.pool;
const T = K.table;
const PH = K.phys;
const GD = K.guide;
const R = K.ball.r;         // 球半径
const TH = T.h;             // 呢绒上表面高度
const BX = T.halfL;         // 库内沿半长（x，长轴）
const BZ = T.halfW;         // 库内沿半宽（z）
const YC = TH + R;          // 球心高度
const RX = BX + T.railW;    // 库外沿（台身半长）
const RZ = BZ + T.railW;

/* ---------------- 袋口 / 库边段（物理与建模共用一份数据） ---------------- */
const CM = K.pocket.cornerMouth;  // 角袋在两条库边上各留的缺口
const SM = K.pocket.sideMouth;    // 中袋缺口
const POCKETS = [
  { x: BX + 0.015, z: BZ + 0.015, r: K.pocket.r },
  { x: -BX - 0.015, z: BZ + 0.015, r: K.pocket.r },
  { x: BX + 0.015, z: -BZ - 0.015, r: K.pocket.r },
  { x: -BX - 0.015, z: -BZ - 0.015, r: K.pocket.r },
  { x: 0, z: BZ + 0.02, r: K.pocket.r * 0.94 },
  { x: 0, z: -BZ - 0.02, r: K.pocket.r * 0.94 },
];
/** 一条库边：法线轴 n、朝向 s、切向区间 [lo,hi]（区间外即袋口通道） */
const RAILS = [
  { n: 'z', s: 1, lo: -BX + CM, hi: -SM },
  { n: 'z', s: 1, lo: SM, hi: BX - CM },
  { n: 'z', s: -1, lo: -BX + CM, hi: -SM },
  { n: 'z', s: -1, lo: SM, hi: BX - CM },
  { n: 'x', s: 1, lo: -BZ + CM, hi: BZ - CM },
  { n: 'x', s: -1, lo: -BZ + CM, hi: BZ - CM },
];
const RAILS_Z = RAILS.filter((r) => r.n === 'z');
const RAILS_X = RAILS.filter((r) => r.n === 'x');

/* ---------------- 球的配色（1~7 全色，9~15 花色，8 黑） ---------------- */
const HUE = [0xf7f3e7, 0xffd21e, 0x1f57cf, 0xd8202c, 0x7b31b8, 0xff8a1e, 0x17864a, 0x8a2f22, 0x141414];
/** 三角摆球顺序：顶点 1，第三排中间放 8，其余按号位填 */
const RACK_ORDER = [1, 2, 3, 4, 8, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];

/** 射线(单位方向) vs 圆：返回最近正向距离，打不中返回 -1 */
function rayCircle(px, pz, dx, dz, cx, cz, rr) {
  const ox = px - cx, oz = pz - cz;
  const b = ox * dx + oz * dz;
  const c = ox * ox + oz * oz - rr * rr;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 1e-5) t = -b + s;   // 起点在圆内：取远端
  return t > 1e-5 ? t : -1;
}
/** 射线 vs 一条库边直线：只在切向区间内算命中，区间外（袋口通道）返回 -1 */
function rayRail(px, pz, dx, dz, rl) {
  const lim = rl.n === 'x' ? BX - R : BZ - R;
  const face = rl.s * lim;
  const d = rl.n === 'x' ? dx : dz;
  if (Math.abs(d) < 1e-6) return -1;
  const t = (face - (rl.n === 'x' ? px : pz)) / d;
  if (t < 1e-5) return -1;
  const q = rl.n === 'x' ? pz + dz * t : px + dx * t;   // 命中点在切向上的坐标
  const other = rl.n === 'x' ? BZ - R : BX - R;
  if (q < -other || q > other) return -1;               // 已经跑到别的库外面去了
  return q >= rl.lo && q <= rl.hi ? t : -1;
}
/** 射线到"打区矩形"边界的距离（含袋口缺口，用于把导向线截在台面上） */
function rayEdge(px, pz, dx, dz) {
  let t = Infinity;
  const hit = (v, c, face) => {
    if (Math.abs(v) < 1e-6) return;
    const q = (face - c) / v;
    if (q > 1e-5 && q < t) t = q;
  };
  hit(dx, px, BX - R); hit(dx, px, -(BX - R));
  hit(dz, pz, BZ - R); hit(dz, pz, -(BZ - R));
  return t;
}

export function createPool({ camera, player, sfx }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080a0d);

  const $ = (id) => document.getElementById(id);
  const bar = $('pool-bar');
  const hintEl = $('pool-hint');
  const infoEl = $('pb-info');
  const fillEl = $('pb-fill');

  /* ================= 房间（黑匣子 + 暖木） ================= */
  const RW = K.room.halfW, RL = K.room.halfL, RH = K.room.height;
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(RW * 2, RH, RL * 2),
    new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.93, metalness: 0.03, side: THREE.BackSide, envMapIntensity: 0.1 })
  );
  shell.position.y = RH / 2;
  scene.add(shell);
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(RW * 2 - 0.04, RL * 2 - 0.04),
    new THREE.MeshStandardMaterial({ map: makeCarpetTexture(), color: 0x66707e, roughness: 0.97, envMapIntensity: 0.04 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.012;
  scene.add(rug);
  // 墙裙：一整圈深色木带，离壳面 6cm，不共面
  const dadoMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.25 });
  for (const w of [
    { len: RW * 2 - 0.04, x: 0, z: -RL + 0.07, ry: 0 },
    { len: RW * 2 - 0.04, x: 0, z: RL - 0.07, ry: Math.PI },
    { len: RL * 2 - 0.04, x: -RW + 0.07, z: 0, ry: Math.PI / 2 },
    { len: RL * 2 - 0.04, x: RW - 0.07, z: 0, ry: -Math.PI / 2 },
  ]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w.len, 1.05), dadoMat);
    m.position.set(w.x, 0.53, w.z);
    m.rotation.y = w.ry;
    scene.add(m);
  }

  /* ================= 球桌 ================= */
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x3a2419, roughness: 0.42, metalness: 0.12, envMapIntensity: 0.7 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2c1b12, roughness: 0.38, metalness: 0.14, envMapIntensity: 0.8 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08d4a, roughness: 0.26, metalness: 0.9, envMapIntensity: 1.1 });

  // 台身：从地面一直顶到呢绒下方 2cm（顶面绝不能高过呢绒，否则会把台面整块盖掉）
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(RX * 2 - 0.06, TH - 0.02, RZ * 2 - 0.06), woodMat);
  cabinet.position.y = (TH - 0.02) / 2;
  scene.add(cabinet);
  /** 呢绒：整张台面就这一个不透明面片，袋口/开球线/库边投影全画在贴图里
   *  （台面上不再叠任何第二个共面对象 —— 从根上没有 z-fighting） */
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(RX * 2, RZ * 2),
    new THREE.MeshStandardMaterial({
      map: makeFeltTexture(RX * 2, RZ * 2, T.railW, POCKETS),
      roughness: 0.95, metalness: 0, envMapIntensity: 0.12,
    })
  );
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = TH;
  scene.add(felt);
  // 库边：与 RAILS 一一对应（同一段数据既用来反弹也用来建模）
  const RAIL_H = 0.105;
  for (const rl of RAILS) {
    const len = rl.hi - rl.lo;
    const face = rl.s * (rl.n === 'x' ? BX : BZ);
    const along = (rl.lo + rl.hi) / 2;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(rl.n === 'z' ? len : T.railW, RAIL_H, rl.n === 'x' ? len : T.railW), railMat);
    m.position.set(rl.n === 'x' ? face + rl.s * T.railW / 2 : along,
      TH + RAIL_H / 2 - 0.02,
      rl.n === 'z' ? face + rl.s * T.railW / 2 : along);
    scene.add(m);
    // 库顶定位珠（现实里就是给瞄准用的参照点）
    const n = rl.n === 'z' ? 3 : 2;
    for (let i = 1; i <= n; i++) {
      const q = rl.lo + (rl.hi - rl.lo) * (i / (n + 1));
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), brassMat);
      d.position.set(rl.n === 'x' ? face + rl.s * T.railW * 0.5 : q, TH + RAIL_H - 0.02,
        rl.n === 'x' ? q : face + rl.s * T.railW * 0.5);
      scene.add(d);
    }
  }

  /* ================= 灯光（台球室招牌：三头铜罩吊灯压在台面上方） ================= */
  scene.add(new THREE.HemisphereLight(0x2c3340, 0x07080a, 0.5));
  const lampGroup = new THREE.Group();
  lampGroup.position.y = 1.95;
  scene.add(lampGroup);
  const shadeGeo = new THREE.ConeGeometry(0.15, 0.13, 20, 1, true);
  const bulbGeo = new THREE.SphereGeometry(0.045, 12, 8);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0x2a2317, emissive: 0xffe6b0, emissiveIntensity: 2.6 });
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.7 });
  for (const lx of [-0.85, 0, 0.85]) {
    const sd = new THREE.Mesh(shadeGeo, brassMat);
    sd.position.set(lx, 0, 0);
    lampGroup.add(sd);
    const bl = new THREE.Mesh(bulbGeo, bulbMat);
    bl.position.set(lx, -0.075, 0);
    lampGroup.add(bl);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, RH - 1.95, 6), rodMat);
    rod.position.set(lx, (RH - 1.95) / 2, 0);
    lampGroup.add(rod);
    const lp = new THREE.PointLight(0xffdfaa, 1.35, 5.5, 1.7);
    lp.position.set(lx, -0.13, 0);
    lampGroup.add(lp);
  }
  /* 球杆架（墙角装饰，纯几何体） */
  {
    const stand = new THREE.Group();
    stand.position.set(-RW + 0.6, 0, -RL + 1.0);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.3), woodMat);
    base.position.y = 0.03;
    stand.add(base);
    const cueMatA = new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.35, metalness: 0.1, envMapIntensity: 0.8 });
    const cueMatB = new THREE.MeshStandardMaterial({ color: 0x6b3f24, roughness: 0.35, metalness: 0.1, envMapIntensity: 0.8 });
    for (let i = 0; i < 4; i++) {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.017, 1.5, 8), i % 2 ? cueMatA : cueMatB);
      stick.position.set(-0.16 + i * 0.11, 0.78, 0);
      stick.rotation.z = 0.07;
      stand.add(stick);
    }
    scene.add(stand);
  }

  /* ================= 球 ================= */
  const ballGeo = new THREE.SphereGeometry(R, 24, 16);
  /** @type {{num:number,mesh:THREE.Mesh,x:number,z:number,vx:number,vz:number,potted:boolean,sink:number}[]} */
  const balls = [];
  function mkBall(num) {
    const tex = makePoolBallTexture(num, num <= 8 ? HUE[num] : HUE[num - 8], num >= 9);
    const mesh = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.1, metalness: 0.02, envMapIntensity: 1.5,
    }));
    mesh.position.set(0, YC, 0);
    scene.add(mesh);
    const b = { num, mesh, x: 0, z: 0, vx: 0, vz: 0, potted: false, sink: 0 };
    balls.push(b);
    return b;
  }
  const cue = mkBall(0);
  for (const n of RACK_ORDER) mkBall(n);

  /** 三角摆球：顶点在摆球点（+x 侧 1/4 处），逐排向后展开 */
  function rack() {
    for (const b of balls) {
      b.potted = false; b.sink = 0; b.vx = 0; b.vz = 0;
      b.mesh.visible = true;
      b.mesh.scale.setScalar(1);
      b.mesh.quaternion.identity();
      if (b.num === 0) { b.x = -BX / 2; b.z = 0; }
      else {
        const k = RACK_ORDER.indexOf(b.num);
        const row = Math.floor((Math.sqrt(8 * k + 1) - 1) / 2);   // 第几排（0 起，每排多一颗）
        const idx = k - (row * (row + 1)) / 2;                    // 排内序号
        b.x = BX / 2 + row * (R * Math.sqrt(3));
        b.z = (idx - row / 2) * 2 * R;
      }
      b.mesh.position.set(b.x, YC, b.z);
    }
  }
  rack();

  /* ================= 球杆（摆在母球正后方，随蓄力后拉） ================= */
  const cueStick = new THREE.Group();
  {
    const mk = (r1, r2, len, z, mat) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 12), mat);
      m.rotation.x = Math.PI / 2;   // 圆柱轴 Y -> 沿 Z
      m.position.z = z;              // 组原点是杆头，杆身伸向 -Z（球的后方）
      cueStick.add(m);
    };
    mk(0.006, 0.006, 0.02, -0.01, new THREE.MeshStandardMaterial({ color: 0x3f6ea8, roughness: 0.85 }));
    mk(0.0055, 0.0125, 1.05, -0.545, new THREE.MeshStandardMaterial({ color: 0xd8b483, roughness: 0.3, metalness: 0.05, envMapIntensity: 0.9 }));
    mk(0.0125, 0.016, 0.48, -1.31, new THREE.MeshStandardMaterial({ color: 0x241610, roughness: 0.4, metalness: 0.15, envMapIntensity: 0.7 }));
  }
  cueStick.visible = false;
  scene.add(cueStick);

  /* ================= 虚线导向 ================= */
  const guideGroup = new THREE.Group();
  guideGroup.position.y = TH + 0.008; // 抬离呢绒 8mm：不与台面共面，也不会被库边埋住
  scene.add(guideGroup);
  /** 预分配顶点的虚线：每帧只写 drawRange 内的点，再重算 lineDistances */
  function mkLine(cap, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color, dashSize: GD.dash, gapSize: GD.gap, transparent: true, opacity, depthWrite: false,
    }));
    line.frustumCulled = false;
    line.renderOrder = 3;
    guideGroup.add(line);
    return {
      count() { return geo.drawRange.count; },
      /** 折线总长；出现 NaN 顶点返回 -1（线会整条消失，且不报错，必须显式断言） */
      length() {
        const n = Math.min(geo.drawRange.count, cap);
        if (n < 2) return 0;
        const a = geo.attributes.position;
        let L = 0;
        for (let i = 1; i < n; i++) {
          const dx = a.getX(i) - a.getX(i - 1), dz = a.getZ(i) - a.getZ(i - 1);
          if (!Number.isFinite(dx) || !Number.isFinite(dz)) return -1;
          L += Math.hypot(dx, dz);
        }
        return L;
      },
      show(pts) {
        const n = Math.min(cap, pts.length);
        if (n < 2) { geo.setDrawRange(0, 0); return; }
        const a = geo.attributes.position;
        for (let i = 0; i < n; i++) a.setXYZ(i, pts[i].x, 0, pts[i].z);
        a.needsUpdate = true;
        geo.setDrawRange(0, n);
        line.computeLineDistances();
      },
    };
  }
  const gMain = mkLine(2, 0xf6f2e6, 0.95);
  const gObj = mkLine(2, 0xffc46b, 0.9);
  const gCue = mkLine(2, 0x8fd0ff, 0.75);
  const gCush = mkLine(2, 0xbfe8c9, 0.6);
  const gGhost = mkLine(33, 0xffffff, 0.8);
  const HIDE = [];
  function hideGuide() { gMain.show(HIDE); gObj.show(HIDE); gCue.show(HIDE); gCush.show(HIDE); gGhost.show(HIDE); }

  /* ================= 玩法状态 ================= */
  let mode = 'walk';        // walk 走动 | aim 上手瞄准 | roll 球在滚
  let aimA = 0;             // 出杆方向角：dir = (cos aimA, sin aimA) 落在 x-z 平面
  let power = 0;
  let charging = false;
  let rollT = 0;
  let aimT = 0;             // 第一人称 <-> 出杆视角 的插值权重
  let needRack = false;
  let strokes = 0, pottedNum = 0, score = 0, fouls = 0;
  let best = Number(localStorage.getItem('bb.pool.best') || 0);
  const dir = new THREE.Vector2(1, 0);
  const _eye = new THREE.Vector3(), _tgt = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _spin = new THREE.Vector3(), _dq = new THREE.Quaternion();
  const holdEye = new THREE.Vector3(), holdQuat = new THREE.Quaternion();

  const ROOM_BOUNDS = { minX: -(RW - 0.7), maxX: RW - 0.7, minZ: -(RL - 0.7), maxZ: RL - 0.7 };
  // 台身用三个圆柱挡人（player.blockers 只支持圆形），绕台走自然留出伸手的距离
  const TABLE_BLOCKERS = [{ x: -BX * 0.8, z: 0, r: 1.0 }, { x: 0, z: 0, r: 1.0 }, { x: BX * 0.8, z: 0, r: 1.0 }];
  const GYM_BOUNDS = {
    minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
    minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
  };
  const GYM_BLOCKERS = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }];

  const nearTable = () => Math.abs(player.pos.x) < RX + K.reach && Math.abs(player.pos.z) < RZ + K.reach;
  const rolling = () => balls.some((b) => !b.potted && (b.vx !== 0 || b.vz !== 0));

  let _hint = null;
  function setHint(t) {
    if (t === _hint) return;
    _hint = t;
    hintEl.innerHTML = t || '';
    hintEl.classList.toggle('hidden', !t);
  }
  let _info = null;
  function setInfo() {
    const s = `🎱 进袋 ${pottedNum}/15 · 得分 ${score}${fouls ? ` · 洗袋 ${fouls}` : ''} · 出杆 ${strokes} · 纪录 ${best}`;
    if (s === _info) return;
    _info = s;
    infoEl.textContent = s;
  }
  let _pw = -1;
  function setPower(v) {
    const q = Math.round(v * 100);
    if (q === _pw) return;
    _pw = q;
    fillEl.style.width = `${q}%`;
  }
  function setBest() {
    if (best < score) {
      best = score;
      localStorage.setItem('bb.pool.best', String(best));
    }
  }

  /** 母球落袋后回开球点；开球点被占就沿中线找空位 */
  function respotCue() {
    cue.potted = false; cue.sink = 0;
    cue.vx = cue.vz = 0;
    cue.mesh.visible = true;
    cue.mesh.scale.setScalar(1);
    const free = (x, z) => balls.every((b) => b === cue || b.potted || Math.hypot(b.x - x, b.z - z) > 2.2 * R);
    for (let i = 0; i < 90; i++) {
      const z = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2 * R;
      for (let j = 0; j < 14; j++) {
        const x = -BX / 2 - 2 * R + j * 4 * R;
        if (Math.abs(x) > BX - R || Math.abs(z) > BZ - R) continue;
        if (free(x, z)) { cue.x = x; cue.z = z; cue.mesh.position.set(x, YC, z); return; }
      }
    }
    cue.x = -BX / 2; cue.z = 0;
  }

  function pot(b) {
    b.potted = true; b.sink = 0.01;
    b.vx = b.vz = 0;
    if (b.num === 0) {                       // 洗袋（母球落袋）：罚分，稍后自动摆回
      fouls++;
      score = Math.max(0, score - K.score.foul);
      sfx.play('bounce', { volume: 0.5, rate: 0.55 });
      setInfo();
      return;
    }
    pottedNum++;
    score += K.score.ball;
    sfx.play('bounce', { volume: 0.55, rate: 0.7 + Math.random() * 0.1 });
    if (pottedNum >= RACK_ORDER.length) {    // 清台：这一杆结算完再整桌重摆
      score += K.score.clear;
      needRack = true;
      sfx.play('cheer', { volume: 0.7 });
    }
    setInfo();
  }

  /* ================= 物理：一个子步 ================= */
  function substep(h) {
    for (const b of balls) {
      if (b.potted) continue;
      const sp = Math.hypot(b.vx, b.vz);
      if (sp === 0) continue;
      // 滚阻 = 常数项 + 速度项：慢球被常数项干脆刹住，快球也不会一路飘
      const ns = Math.max(0, sp - (PH.decel + PH.drag * sp) * h);
      const f = ns / sp;
      b.vx *= f; b.vz *= f;
      const mx = b.vx * h, mz = b.vz * h;
      b.x += mx; b.z += mz;
      if (ns < PH.stop) { b.vx = 0; b.vz = 0; }
      else {
        const d = Math.hypot(mx, mz);
        _spin.set(b.vz, 0, -b.vx).normalize();   // up × v = 纯滚动的瞬时转轴
        _dq.setFromAxisAngle(_spin, d / R);
        b.mesh.quaternion.premultiply(_dq);
      }
    }
    // 库边：段内反弹，段外（袋口通道）不拦
    for (const b of balls) {
      if (b.potted || (b.vx === 0 && b.vz === 0)) continue;
      for (const rl of RAILS_Z) {
        if (b.x < rl.lo || b.x > rl.hi) continue;
        const pen = (b.z - rl.s * BZ) * rl.s - R;
        if (pen > 0) {
          b.z -= rl.s * pen;
          const imp = Math.abs(b.vz);
          b.vz = -b.vz * PH.cushionRest;
          b.vx *= PH.cushionFric;
          if (imp > 0.3) sfx.play('rim', { volume: Math.min(0.45, imp / 8), rate: 1.35 });
        }
      }
      for (const rl of RAILS_X) {
        if (b.z < rl.lo || b.z > rl.hi) continue;
        const pen = (b.x - rl.s * BX) * rl.s - R;
        if (pen > 0) {
          b.x -= rl.s * pen;
          const imp = Math.abs(b.vx);
          b.vx = -b.vx * PH.cushionRest;
          b.vz *= PH.cushionFric;
          if (imp > 0.3) sfx.play('rim', { volume: Math.min(0.45, imp / 8), rate: 1.35 });
        }
      }
    }
    // 袋口：越过库线即进袋（缺口只存在于袋口处，所以这就是"进了那个袋"）
    for (const b of balls) {
      if (b.potted) continue;
      if (Math.abs(b.x) < BX + 0.05 && Math.abs(b.z) < BZ + 0.05) continue;
      let target = null, bd = 1e9;
      for (const p of POCKETS) {
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (d < bd) { bd = d; target = p; }
      }
      if (bd < K.pocket.r * 2) pot(b);
      else {                                  // 万一走到台角外沿又没进袋：兜住，绝不让球飞出去
        b.x = THREE.MathUtils.clamp(b.x, -BX + R, BX - R);
        b.z = THREE.MathUtils.clamp(b.z, -BZ + R, BZ - R);
      }
    }
    // 球-球：等质量对心冲量 + 位置分离
    for (let i = 1; i < balls.length; i++) {
      const a = balls[i];
      if (a.potted) continue;
      for (let j = 0; j < i; j++) {
        const c = balls[j];
        if (c.potted) continue;
        let dx = c.x - a.x, dz = c.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= 2 * R || d === 0) continue;
        dx /= d; dz /= d;
        const over = (2 * R - d) / 2;
        a.x -= dx * over; a.z -= dz * over;
        c.x += dx * over; c.z += dz * over;
        const rel = (c.vx - a.vx) * dx + (c.vz - a.vz) * dz;
        if (rel >= 0) continue;                     // 已经在分离
        const jimp = -(1 + PH.ballRest) * rel / 2;  // 等质量：冲量对半分
        a.vx -= dx * jimp; a.vz -= dz * jimp;
        c.vx += dx * jimp; c.vz += dz * jimp;
        if (-rel > 0.35) sfx.play('tap', { volume: Math.min(0.65, -rel / 6), rate: 2.1 });
      }
    }
  }

  function syncMeshes(dt) {
    for (const b of balls) {
      b.mesh.position.x = b.x;
      b.mesh.position.z = b.z;
      if (b.potted) {
        b.sink = Math.min(1, b.sink + dt * 2.6);     // 落袋：边沉边缩，不做瞬移
        b.mesh.position.y = YC - b.sink * 0.2;
        b.mesh.scale.setScalar(Math.max(0.01, 1 - b.sink * 0.55));
        if (b.sink >= 1) b.mesh.visible = false;
      } else if (b.mesh.position.y !== YC) {
        b.sink = 0;
        b.mesh.position.y = YC;
        b.mesh.scale.setScalar(1);
      }
    }
  }

  /* ================= 虚线导向：与积分器同一套数学 ================= */
  function predict() {
    const g = { kind: 'none', ball: -1, t: 0, gx: 0, gz: 0, ox: 0, oz: 0, rl: null };
    if (cue.potted) return g;
    let tBest = Infinity, hit = null;
    for (const b of balls) {
      if (b === cue || b.potted) continue;
      const t = rayCircle(cue.x, cue.z, dir.x, dir.y, b.x, b.z, 2 * R);
      if (t > 0 && t < tBest) { tBest = t; hit = b; }
    }
    let tRail = Infinity, rail = null;
    for (const rl of RAILS) {
      const t = rayRail(cue.x, cue.z, dir.x, dir.y, rl);
      if (t > 0 && t < tRail) { tRail = t; rail = rl; }
    }
    const tEdge = rayEdge(cue.x, cue.z, dir.x, dir.y);   // 撞在袋口通道上（该处没有库边段）
    if (hit && tBest <= Math.min(tRail, tEdge)) {
      const gx = cue.x + dir.x * tBest, gz = cue.z + dir.y * tBest;
      const nx = hit.x - gx, nz = hit.z - gz;
      const nl = Math.hypot(nx, nz) || 1;
      g.kind = 'ball'; g.ball = hit.num; g.t = tBest; g.gx = gx; g.gz = gz;
      g.ox = nx / nl; g.oz = nz / nl;
    } else if (rail && tRail <= tEdge) {
      g.kind = 'rail'; g.t = tRail; g.rl = rail;
      g.gx = cue.x + dir.x * tRail; g.gz = cue.z + dir.y * tRail;
    } else if (Number.isFinite(tEdge)) {
      g.kind = 'pocket'; g.t = tEdge;
      g.gx = cue.x + dir.x * tEdge; g.gz = cue.z + dir.y * tEdge;
    }
    return g;
  }

  function drawGuide() {
    const g = predict();
    if (mode !== 'aim' || g.kind === 'none') { hideGuide(); return g; }
    const end = g.kind === 'pocket' ? nearestPocket(g.gx, g.gz) : { x: g.gx, z: g.gz };
    gMain.show([{ x: cue.x, z: cue.z }, { x: end.x, z: end.z }]);
    gObj.show(HIDE); gCue.show(HIDE); gCush.show(HIDE); gGhost.show(HIDE);
    if (g.kind === 'ball') {
      // 幽灵球：母球球心走到这个圆上，正好与目标球相切
      const pts = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        pts.push({ x: g.gx + Math.cos(a) * R, z: g.gz + Math.sin(a) * R });
      }
      gGhost.show(pts);
      const ob = balls.find((b) => b.num === g.ball);
      if (ob) {
        gObj.show([{ x: ob.x, z: ob.z }, { x: ob.x + g.ox * GD.objLen, z: ob.z + g.oz * GD.objLen }]);
        // 母球沿切向分离；正面对心撞就没有分离线
        const dot = dir.x * g.ox + dir.y * g.oz;
        const tx = dir.x - g.ox * dot, tz = dir.y - g.oz * dot;
        const tl = Math.hypot(tx, tz);
        if (tl > 0.08) {
          gCue.show([{ x: g.gx, z: g.gz }, { x: g.gx + (tx / tl) * GD.cueLen, z: g.gz + (tz / tl) * GD.cueLen }]);
        }
      }
    } else if (g.kind === 'rail') {
      const nx = g.rl.n === 'x' ? g.rl.s : 0, nz = g.rl.n === 'z' ? g.rl.s : 0;
      const dot = dir.x * nx + dir.y * nz;
      const rx = dir.x - 2 * dot * nx, rz = dir.y - 2 * dot * nz;   // 镜像反射
      const t2 = rayEdge(g.gx, g.gz, rx, rz);
      const L = Math.min(GD.cushLen, t2 > 0 ? t2 : GD.cushLen);
      gCush.show([{ x: g.gx, z: g.gz }, { x: g.gx + rx * L, z: g.gz + rz * L }]);
    }
    return g;
  }
  function nearestPocket(x, z) {
    let b = POCKETS[0], bd = 1e9;
    for (const p of POCKETS) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bd) { bd = d; b = p; }
    }
    return b;
  }

  /* ================= 出杆视角 ================= */
  function aimPose() {
    _eye.set(cue.x - dir.x * K.aim.dist, YC + K.aim.drop, cue.z - dir.y * K.aim.dist);
    _tgt.set(cue.x + dir.x * K.aim.look, YC, cue.z + dir.y * K.aim.look);
    _m.lookAt(_eye, _tgt, _up);          // 相机约定：-Z 指向目标
    _q.setFromRotationMatrix(_m);
  }
  function takeOver() {
    if (cue.potted) respotCue();
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    aimA = Math.atan2(fz, fx);
    dir.set(Math.cos(aimA), Math.sin(aimA));
    mode = 'aim';
    power = 0; charging = false;
    player.speed = 0;                    // 上手就站住，WASD 用来收杆
    cueStick.visible = true;
    sfx.play('ui', { volume: 0.4 });
  }
  function releaseCue() {
    if (mode === 'roll') return;
    mode = 'walk';
    power = 0; charging = false;
    player.speed = K.walkSpeed;
    cueStick.visible = false;
    setPower(0);
    hideGuide();
  }
  function strike() {
    const v = THREE.MathUtils.lerp(K.speed[0], K.speed[1], power);
    const pw = power;
    cue.vx = dir.x * v; cue.vz = dir.y * v;
    strokes++;
    setInfo();
    rollT = 0;
    mode = 'roll';
    aimPose();
    holdEye.copy(_eye); holdQuat.copy(_q);   // 出杆后视角定住，看着球跑
    power = 0; charging = false;
    setPower(0);
    cueStick.visible = false;
    hideGuide();
    sfx.play('shoot', { volume: 0.45 + pw * 0.4, rate: 1.45 - v / 16 });
  }

  function canvasLock() {
    const c = document.getElementById('gl');
    try {
      const p = c.requestPointerLock?.();
      if (p && p.catch) p.catch(() => { /* 无手势时忽略，点画面可再锁 */ });
    } catch (e) { /* 旧浏览器同步抛错同样忽略 */ }
  }

  $('pb-rack').addEventListener('click', () => api.rerack());
  $('pb-exit').addEventListener('click', () => { if (api.onExitRequest) api.onExitRequest(); });

  /* ================= 对外接口 ================= */
  const api = {
    scene,
    onExitRequest: null,
    get mode() { return mode; },
    get score() { return score; },

    enter() {
      player.pos.set(0, 0, RZ + 1.9);
      player.vel.set(0, 0, 0);
      player.y = 0; player.vy = 0; player.landDip = 0;
      player.bounds = ROOM_BOUNDS;
      player.blockers = TABLE_BLOCKERS;
      player.eyeHeight = CFG.player.eye;
      player.speed = K.walkSpeed;
      player.mode = 'free';
      player.exitShotAim();
      player.freeYaw = 0;              // yaw=0 即面向 -z，进门正对球桌长边
      player.freePitch = -0.1;
      aimT = 0;
      mode = 'walk';
      setInfo();
      bar.classList.remove('hidden');   // 球室条常驻：重摆 / 退出都得够得着
      canvasLock();
      setHint('<b>走近球桌</b> <b>左键</b> 上手瞄准 · 回球场点 <b>🚪 退出球室</b>');
    },
    exit() {
      releaseCue();
      player.bounds = GYM_BOUNDS;
      player.blockers = GYM_BLOCKERS;
      player.eyeHeight = CFG.player.eye;
      player.speed = CFG.player.speedIdle;
      setHint('');
      bar.classList.add('hidden');
    },

    /** 每帧（main 在 playing 且 loc==='pool' 时调用，必须在 player.update 之后） */
    update(dt) {
      if (mode === 'roll') {
        rollT += dt;
        let maxSp = 0;
        for (const b of balls) if (!b.potted) maxSp = Math.max(maxSp, Math.hypot(b.vx, b.vz));
        let n = PH.sub;
        while (maxSp * (dt / n) > R * 0.7 && n < 64) n++;   // 快球自动加密子步，杜绝穿球穿库
        for (let i = 0; i < n; i++) substep(dt / n);
        if (!rolling() || rollT > PH.maxTime) {
          for (const b of balls) { b.vx = 0; b.vz = 0; }
          if (cue.potted) respotCue();
          if (needRack) { needRack = false; rack(); pottedNum = 0; }
          mode = 'aim';
          power = 0;
          cueStick.visible = true;
          sfx.play('ui', { volume: 0.25, rate: 1.35 });
        }
      } else if (mode === 'aim' && charging) {
        power = Math.min(1, power + dt / K.chargeTime);
      }
      syncMeshes(dt);
      setBest();

      if (cueStick.visible) {   // 杆头贴在母球后方，蓄力时整体后拉
        const pull = 0.035 + power * 0.17;
        cueStick.position.set(cue.x - dir.x * (R + pull), YC, cue.z - dir.y * (R + pull));
        cueStick.rotation.set(0, Math.PI / 2 - aimA, 0);
      }
      if (mode === 'aim') drawGuide();

      /* ---- 相机：第一人称 <-> 出杆视角 双向平滑插值 ---- */
      aimT += ((mode === 'walk' ? 0 : 1) - aimT) * (1 - Math.exp(-K.aim.blend * dt));
      if (aimT > 0.002) {
        if (mode === 'roll') { _eye.copy(holdEye); _q.copy(holdQuat); }
        else aimPose();
        camera.position.lerp(_eye, aimT);
        camera.quaternion.slerp(_q, aimT);
      }
      setPower(mode === 'aim' && charging ? power : 0);

      if (mode === 'walk') {
        setHint(nearTable() ? '<b>左键</b> 上手瞄准 · <b>右键</b> 继续走动' : '');
      } else if (mode === 'aim') {
        setHint('<b>移动鼠标</b> 转导向线 · <b>按住左键</b> 蓄力、松手出杆 · <b>右键</b> 收杆 · <b>E</b> 重摆 · WASD 走动');
      } else {
        setHint('球还在滚…');
      }
    },

    /** 瞄准：鼠标横向增量转导向线 */
    onLook(dx) {
      if (mode !== 'aim') return;
      aimA += dx * K.aim.sens;
      dir.set(Math.cos(aimA), Math.sin(aimA));
    },
    onLeftDown() {
      if (mode === 'roll') return;
      if (mode === 'walk') { if (nearTable()) takeOver(); return; }
      charging = true;
      power = 0;
    },
    onLeftUp() {
      if (mode !== 'aim' || !charging) return;
      charging = false;
      if (power < K.cancelCharge) { power = 0; setPower(0); return; }   // 轻点＝收力，不出杆
      strike();
    },
    onRightDown() {
      if (mode === 'aim') releaseCue();
    },
    /** 瞄准时按方向键 = 收杆回走动（与影院"按 WASD 起身"同一套语言） */
    onMoveKey() {
      if (mode === 'aim') releaseCue();
    },
    /** E / 按钮：整桌重摆 */
    rerack() {
      rack();
      pottedNum = 0;
      needRack = false;
      setInfo();
      sfx.play('ui', { volume: 0.5, rate: 1.2 });
    },
    /** 暂停/失焦：力度作废（松手的 mouseup 可能永远收不到） */
    cancelCharge() {
      charging = false;
      power = 0;
      setPower(0);
    },

    /* ---- 测试探针 ---- */
    debugPool() {
      return {
        mode, live: balls.filter((b) => !b.potted).length, potted: pottedNum,
        score, strokes, fouls, cue: [+cue.x.toFixed(3), +cue.z.toFixed(3)],
        aimT: +aimT.toFixed(3), power: +power.toFixed(2),
      };
    },
    debugGuide() {
      const g = mode === 'aim' ? drawGuide() : predict();
      return { kind: g.kind, ball: g.ball, t: +g.t.toFixed(3), gx: +g.gx.toFixed(3), gz: +g.gz.toFixed(3), ox: +g.ox.toFixed(3), oz: +g.oz.toFixed(3) };
    },
    /** 导向线是否真的落成了顶点（取错字段 → NaN → 整条线静默消失） */
    debugGuideLine() {
      drawGuide();
      return { n: gMain.count(), len: +gMain.length().toFixed(2), obj: +gObj.length().toFixed(2), cush: +gCush.length().toFixed(2) };
    },
    debugBall(num) {
      const b = balls.find((x) => x.num === num);
      return b ? { x: +b.x.toFixed(4), z: +b.z.toFixed(4), vx: +b.vx.toFixed(3), vz: +b.vz.toFixed(3), potted: b.potted } : null;
    },
    /** 测试用：把某号球挪到指定位置（摆一颗孤球，才能干净地验「预测==实际」） */
    debugPlace(num, x, z) {
      const b = balls.find((y) => y.num === num);
      if (!b || b.potted) return false;
      b.x = x; b.z = z; b.vx = 0; b.vz = 0;
      b.mesh.position.set(x, YC, z);
      return true;
    },
    /** 把导向线正对台面某个点（测试用：可稳定造出直线进袋 / 撞库等场景） */
    debugAimTo(x, z) {
      if (cue.potted) return false;
      aimA = Math.atan2(z - cue.z, x - cue.x);
      dir.set(Math.cos(aimA), Math.sin(aimA));
      return true;
    },
    /** 把导向线正对某号球：测试用来验证"预测==实际" */
    debugAimAt(num) {
      const b = balls.find((x) => x.num === num);
      if (!b) return false;
      aimA = Math.atan2(b.z - cue.z, b.x - cue.x);
      dir.set(Math.cos(aimA), Math.sin(aimA));
      return true;
    },
    /** 测试用：直接把蓄力进度设定到某值（无头 rAF 被限流，靠帧累加不可靠） */
    debugPower(v) {
      if (mode !== 'aim' || cue.potted) return false;
      charging = true; power = Math.max(0, Math.min(1, v));
      return true;
    },
    debugSettle(seconds, h = 1 / 60) {   // 无头环境 rAF 被限流，用手工步进代替等待
      const n = Math.max(1, Math.round(seconds / h));
      for (let i = 0; i < n; i++) this.update(h);
      return this.debugPool();
    },
  };
  return api;
}
