/**
 * archery.js —— 射箭：靶位（+z 端，原第二只篮筐的位置）+ 弓箭视角模型 + 弹道虚线
 *
 * 与台球室同一套立身之本：**虚线导向与真飞行走同一个定步长积分**，
 * 所以虚线落在哪、箭就落在哪 —— 这条不变量由 ?demo=arch 直接断言。
 * 拉弓力度只改箭的初速（越满越平远），下坠是真实的，靠虚线把它读出来。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeTargetTexture } from './textures.js';

const A = CFG.arch;
const G0 = CFG.player.gravity;

/**
 * 出手点在弓上（相机右下方），不在眼睛上。
 * 若从相机原点出发，弹道线就和视线重合 —— 正对靶子时整条虚线投影成穿过准星的一条竖线，
 * 落点根本读不出来。方向则仍指向准星射线上的远处，所以"准星指哪打哪"没变，
 * 只是虚线从右下方起笔、往前收拢到准星，再往下坠 —— 一条看得见的弧。
 */
const NOCK = { right: 0.15, down: 0.20, fwd: 0.30 };
const NOCK_REF = 16;

/** 靶心世界坐标（命中平面、靶距倍率都以此为原点）；只在本模块内用，外面要靶距请调 targetDist() */
const TARGET_POS = new THREE.Vector3(0, A.targetY, A.targetZ);

/** 命中点离靶心多少米 -> 环值（0 = 没上靶面）；只在本模块与贴图生成处用，不导出 */
function ringValue(d) {
  for (const ring of A.rings) if (d <= ring.r) return ring.v;
  return 0;
}

/**
 * 靶距：HUD 上那个倍率与出手计分共用这一条式子，才不会"显示 ×1.9、结算按 ×1.8 算"。
 * 取水平距离 + 视高到靶心的高差（不看相机瞬时抖动，否则倍率会随机跳档）。
 */
export function targetDist(px, pz) {
  return Math.hypot(px - TARGET_POS.x, pz - TARGET_POS.z, CFG.player.eye - TARGET_POS.y);
}

/**
 * 靶架：木框背板 + 草垫 + 靶面，正对场内（-z 方向）。
 * 全部不投影 —— 它在阴影相机边缘，一旦参与投影就会在切边上闪（远端装饰筐当年就是这么撤掉的）。
 */
export function buildRange(scene) {
  const g = new THREE.Group();
  g.position.set(0, 0, A.targetZ);
  const bh = A.boardHalf;
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.82, metalness: 0.04 });
  const post = new THREE.MeshStandardMaterial({ color: 0x3d2a18, roughness: 0.88 });
  const straw = new THREE.MeshStandardMaterial({ color: 0xa8873f, roughness: 0.97 });

  const back = new THREE.Mesh(new THREE.BoxGeometry(bh * 2, bh * 2, 0.1), wood);
  back.position.set(0, A.targetY, 0.06);
  g.add(back);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(A.faceR + 0.035, A.faceR + 0.035, 0.12, 44), straw);
  butt.rotation.x = Math.PI / 2;      // 圆柱轴 Y -> Z：两端面正好朝场内/背板
  butt.position.set(0, A.targetY, 0.005);
  g.add(butt);
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(A.faceR, 44),
    new THREE.MeshStandardMaterial({ map: makeTargetTexture(A.faceR * 2, A.rings.map((x) => x.r)), roughness: 0.95 })
  );
  face.rotation.y = Math.PI;          // CircleGeometry 默认朝 +z，转过来对准场内
  face.position.set(0, A.targetY, -0.055);
  g.add(face);

  for (const dx of [-bh - 0.05, bh + 0.05]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, A.targetY + bh + 0.12, 10), post);
    leg.position.set(dx, (A.targetY + bh + 0.12) / 2, 0.34);
    g.add(leg);
    const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, A.targetY + bh - 0.1, 8), post);
    brace.position.set(dx, (A.targetY + bh - 0.1) / 2, 0.72);
    brace.rotation.x = 0.36;          // 斜撑往后倒，正面看就是个 A 字架
    g.add(brace);
  }
  const foot = new THREE.Mesh(new THREE.BoxGeometry(bh * 2 + 0.4, 0.1, 0.9), post);
  foot.position.set(0, 0.05, 0.5);
  g.add(foot);
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  scene.add(g);
  return { group: g, face };
}

/**
 * 玩法侧：弓 + 箭 + 虚线（`createArchery`），由 states.js 的 ArchState 每帧驱动。
 */
export function createArchery({ scene, camera, player, sfx, range }) {
  /* ================= 弓箭视角模型（挂在相机下，depthTest 关掉才不会被墙吃掉） ================= */
  scene.add(camera);          // 相机得在场景图里，它的子节点才会被渲染
  const rig = new THREE.Group();
  // 挂在右下、整体缩到 0.46：真尺幅的弓（0.8m）贴在眼前会把靶子整个挡住，
  // 弓弦还会横穿屏幕中线，看着像一条渲染 bug 而不像弓。
  rig.position.set(0.17, -0.22, -0.5);
  rig.scale.setScalar(0.46);
  rig.renderOrder = 6;
  const bowMat = new THREE.MeshStandardMaterial({ color: 0x2f1d12, roughness: 0.45, metalness: 0.25, depthTest: false });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.9, depthTest: false });
  const limbPts = (sign) => new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, sign * 0.1, 0),
    new THREE.Vector3(0, sign * 0.26, -0.07),
    new THREE.Vector3(0, sign * 0.4, -0.03),
  ]);
  for (const sign of [1, -1]) {
    const limb = new THREE.Mesh(new THREE.TubeGeometry(limbPts(sign), 10, 0.014, 6), bowMat);
    limb.renderOrder = 6;
    rig.add(limb);
  }
  const riser = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.22, 0.045), gripMat);
  riser.renderOrder = 6;
  rig.add(riser);
  // 弓弦：三点折线，中间那点就是扣弦处（拉距越深越靠近脸）
  const stringGeo = new THREE.BufferGeometry();
  stringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const bowString = new THREE.Line(stringGeo, new THREE.LineBasicMaterial({ color: 0xe8e4d8, depthTest: false }));
  bowString.renderOrder = 7;
  bowString.frustumCulled = false;
  rig.add(bowString);
  const nocked = makeArrowMesh();       // 扣在弦上的那支箭（瞄准时可见）
  nocked.traverse((o) => { if (o.material) o.material.depthTest = false; o.renderOrder = 7; });
  nocked.renderOrder = 7;
  rig.add(nocked);
  rig.visible = false;
  camera.add(rig);

  /* ================= 弹道虚线 ================= */
  const guideGeo = new THREE.BufferGeometry();
  guideGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(A.guideCap * 3), 3));
  guideGeo.setDrawRange(0, 0);
  const guide = new THREE.Line(guideGeo, new THREE.LineDashedMaterial({
    color: 0xffd08a, dashSize: 0.16, gapSize: 0.13, transparent: true, opacity: 0.9, depthWrite: false,
  }));
  guide.frustumCulled = false;
  guide.renderOrder = 4;
  scene.add(guide);
  // 落点标记：虚线末端的小圈，正对相机（billboard），一眼看清"这一箭会扎在哪"
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.045, 0.075, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  marker.visible = false;
  marker.renderOrder = 4;
  scene.add(marker);

  /* ================= 飞行中的箭 ================= */
  const fly = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, mesh: null };
  const stuck = [];      // 插在靶上的箭（跟着靶组走）
  const hits = [];       // 对应的命中点（世界系，未加嵌入偏移）：无头用例靠它断言「虚线末点==真落点」
  const loose = [];      // 落地/撞墙的箭：留在场地当痕迹，攒多了回收
  const pool = [];       // 空闲网格：一局限几十箭，不能每次发射都新建
  let acc = 0;
  let recoil = 0;
  const _dir = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 0, 1);
  const _p = new THREE.Vector3();
  // 出手点/方向所用的相机基向量（每帧复用，瞄准热路径零分配）
  const _lp = new THREE.Vector3();
  const _ld = new THREE.Vector3();
  const _lr = new THREE.Vector3();
  const _lu = new THREE.Vector3();
  // 弹道状态与结果槽：瞄准每帧都要跑一遍预测，热路径上不能有分配
  const _st = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 };
  const _fc = { n: 0, ev: null, x: 0, y: 0, z: 0 };
  const _ev = { kind: '', ring: 0, dist: 0, x: 0, y: 0, z: 0 };
  // 预测与真飞行共用的顶点缓冲：每帧复用，不留分配
  const _path = Array.from({ length: A.guideCap }, () => new THREE.Vector3());

  /** 一支标准箭：杆 + 头 + 尾羽，原点取杆身中点，机头朝 +z */
  function makeArrowMesh() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0055, 0.0055, 0.66, 7),
      new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 0.6 })
    );
    shaft.rotation.x = Math.PI / 2;      // 圆柱轴 Y -> Z
    g.add(shaft);
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.008, 0.05, 8),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.35, metalness: 0.7 })
    );
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.355;
    g.add(tip);
    for (let i = 0; i < 3; i++) {
      const feather = new THREE.Mesh(
        new THREE.BoxGeometry(0.002, 0.028, 0.09),
        new THREE.MeshStandardMaterial({ color: 0xe8523f, roughness: 0.8 })
      );
      feather.position.z = -0.29;
      feather.rotation.z = (i / 3) * Math.PI * 2;
      feather.position.y = Math.cos((i / 3) * Math.PI * 2) * 0.012;
      feather.position.x = Math.sin((i / 3) * Math.PI * 2) * 0.012;
      g.add(feather);
    }
    g.visible = false;
    scene.add(g);
    return g;
  }

  /** 定步长推进一格，返回 null（还在飞）或命中事件（复用 _ev，调用方须在下次调用前用完） */
  function stepOne(s) {
    const px = s.x, py = s.y, pz = s.z;
    s.vy -= G0 * A.stepT;
    s.x += s.vx * A.stepT;
    s.y += s.vy * A.stepT;
    s.z += s.vz * A.stepT;
    s.t += A.stepT;
    _ev.x = s.x; _ev.y = s.y; _ev.z = s.z;   // 落点：飘字与特效要按在这里
    // 只在跨过命中平面那一步插值求解，所以步长再大也不会漏判
    if (pz < TARGET_POS.z && s.z >= TARGET_POS.z) {
      const f = (TARGET_POS.z - pz) / (s.z - pz);
      const hx = px + (s.x - px) * f, hy = py + (s.y - py) * f;
      if (Math.abs(hx - TARGET_POS.x) <= A.boardHalf && Math.abs(hy - TARGET_POS.y) <= A.boardHalf) {
        s.x = hx; s.y = hy; s.z = TARGET_POS.z;
        const d = Math.hypot(hx - TARGET_POS.x, hy - TARGET_POS.y);
        const v = ringValue(d);
        _ev.kind = v ? 'hit' : 'board'; _ev.ring = v; _ev.dist = d;
        _ev.x = s.x; _ev.y = s.y; _ev.z = s.z;
        return _ev;
      }
    }
    if (s.y <= 0.004) { _ev.kind = 'drop'; _ev.ring = 0; _ev.dist = 0; return _ev; }
    if (s.z >= CFG.gym.halfL - 0.08 || Math.abs(s.x) >= CFG.gym.halfW - 0.08) {
      _ev.kind = 'wall'; _ev.ring = 0; _ev.dist = 0; return _ev;
    }
    return null;
  }

  /** 从 (x,y,z)+dir 以 speed 出发，把弹道走一遍填进 _path，结果写进 _fc 并返回它 */
  function forecast(x, y, z, dir, speed) {
    const s = _st;
    s.x = x; s.y = y; s.z = z;
    s.vx = dir.x * speed; s.vy = dir.y * speed; s.vz = dir.z * speed;
    s.t = 0;
    _fc.n = 0; _fc.ev = null;
    const maxSteps = A.maxFlight / A.stepT;
    for (let i = 0; !_fc.ev && i < maxSteps; i++) {
      _fc.ev = stepOne(s);          // 注意：命中事件是复用对象，只有末次非 null 的那份有意义
      if ((i % A.guideEvery) === 0 && _fc.n < A.guideCap) _path[_fc.n++].set(s.x, s.y, s.z);
    }
    if (_fc.n < A.guideCap && _fc.ev) _path[_fc.n++].set(s.x, s.y, s.z);  // 末点必须是真落点
    _fc.x = s.x; _fc.y = s.y; _fc.z = s.z;
    return _fc;
  }

  function showGuide(n) {
    if (n < 2) { guideGeo.setDrawRange(0, 0); marker.visible = false; return; }
    const at = guideGeo.attributes.position;
    for (let i = 0; i < n; i++) at.setXYZ(i, _path[i].x, _path[i].y, _path[i].z);
    at.needsUpdate = true;
    guideGeo.setDrawRange(0, n);
    guide.computeLineDistances();
  }

  /** 算出这一箭的出手点与方向：由相机姿态现推，瞄准与出手共用同一式子（预测==飞行） */
  function launchState() {
    const q = camera.quaternion;
    _ld.set(0, 0, -1).applyQuaternion(q);
    _lr.set(1, 0, 0).applyQuaternion(q);
    _lu.set(0, 1, 0).applyQuaternion(q);
    _lp.copy(camera.position)
      .addScaledVector(_lr, NOCK.right)
      .addScaledVector(_lu, -NOCK.down)
      .addScaledVector(_ld, NOCK.fwd);
    // 方向 = 从弓指向准星射线上的参考远点：远处收拢到准星，近处看得见偏移
    _ld.multiplyScalar(NOCK_REF).add(camera.position).sub(_lp).normalize();
  }

  /** 取一支空闲箭网格（没有才新建）—— 一局几百箭也不能攒几百个 Group */
  function takeArrow() {
    const m = pool.pop() || makeArrowMesh();
    m.visible = true;
    return m;
  }

  /** 收回：脱出父级、回空闲池 */
  function recycle(m) {
    m.visible = false;
    m.parent?.remove(m);
    scene.add(m);
    pool.push(m);
  }

  /** 把箭插到命中处：靶上跟着靶组走，落地/撞墙就留在原地当痕迹 */
  function stick(ev, s) {
    const mesh = fly.mesh;
    if (!mesh) return;
    fly.mesh = null;
    _dir.set(s.vx, s.vy, s.vz).normalize();
    mesh.quaternion.setFromUnitVectors(_up, _dir);   // 箭模型的机头是 +z
    mesh.visible = true;
    if (ev.kind === 'hit' || ev.kind === 'board') {
      hits.push({ x: s.x, y: s.y, z: s.z });     // 断言用：这是穿过命中平面那一点，不含嵌入偏移
      range.updateWorldMatrix(true, false);
      mesh.position.copy(range.worldToLocal(_p.set(s.x, s.y, s.z + 0.055)));  // 靶面在靶组前 5.5cm，箭要扎进草垫
      range.add(mesh);
      stuck.push(mesh);
      if (stuck.length > A.stickMax) { recycle(stuck.shift()); hits.shift(); }
      return;
    }
    mesh.position.set(s.x, s.y, s.z);
    loose.push(mesh);
    if (loose.length > A.looseMax) recycle(loose.shift());
  }

  const api = {
    /** 力度 0~1 -> 箭速（虚线与出手共用） */
    speedOf(charge) { return A.speedMin + charge * (A.speedMax - A.speedMin); },

    showRig(on) { rig.visible = on; if (!on) { showGuide(0); marker.visible = false; } },

    /**
     * 瞄准中每帧调用：摆弓、画虚线，返回「这一箭会落在哪」（复用槽，调用方当场读完）。
     * 出手方向 = 相机朝向，准星指哪打哪，唯一的补偿是真实下坠（所以要看虚线）。
     */
    aim(charge) {
      launchState();
      const r = forecast(_lp.x, _lp.y, _lp.z, _ld, api.speedOf(charge));
      showGuide(r.n);
      if (r.n) {
        marker.position.copy(_path[r.n - 1]);
        marker.quaternion.copy(camera.quaternion);
        // 等屏尺寸：远处的落点圈若按真实大小画，到靶子那一头就只剩几个像素
        marker.scale.setScalar(THREE.MathUtils.clamp(marker.position.distanceTo(camera.position) * 0.2, 1, 3.5));
        marker.visible = true;
      } else marker.visible = false;
      poseBow(charge);
      return r.ev;
    },

    /** 放箭：真箭用同一个 forecast 的第一步起步，所以预测==飞行 */
    shoot() {
      launchState();
      const speed = api.speedOf(api.lastCharge);
      fly.x = _lp.x; fly.y = _lp.y; fly.z = _lp.z;
      fly.vx = _ld.x * speed; fly.vy = _ld.y * speed; fly.vz = _ld.z * speed;
      fly.t = 0;
      if (fly.mesh) recycle(fly.mesh);
      fly.mesh = takeArrow();
      fly.mesh.position.set(fly.x, fly.y, fly.z);
      acc = 0;
      recoil = 1;
      showGuide(0);
      marker.visible = false;
      sfx.play('shoot', { rate: 1.35, volume: 0.85 });
    },

    /** 飞行推进：固定步长吃真实 dt，撞靶/落地/撞墙/超时都返回事件 */
    advance(dt) {
      if (!fly.mesh) return null;
      acc += Math.min(dt, 0.1);
      let ev = null, guard = 0;
      while (acc >= A.stepT && guard++ < 90) {
        acc -= A.stepT;
        ev = stepOne(fly);
        if (ev) break;
      }
      if (!ev && fly.t > A.maxFlight) {
        _ev.kind = 'time'; _ev.ring = 0; _ev.dist = 0;
        _ev.x = fly.x; _ev.y = fly.y; _ev.z = fly.z;
        ev = _ev;
      }
      fly.mesh.position.set(fly.x, fly.y, fly.z);
      _dir.set(fly.vx, fly.vy, fly.vz).normalize();
      fly.mesh.quaternion.setFromUnitVectors(_up, _dir);
      if (ev) stick(ev, fly);
      return ev;
    },

    /** 收弓 / 换局：撤掉在飞的箭与虚线 */
    reset() {
      if (fly.mesh) { recycle(fly.mesh); fly.mesh = null; }
      acc = 0;
      showGuide(0);
      marker.visible = false;
    },

    clearStuck() {
      hits.length = 0;
      while (stuck.length) recycle(stuck.shift());
      while (loose.length) recycle(loose.shift());
    },

    /* ---------- 无头断言用 ---------- */
    debugGuide() {
      const at = guideGeo.attributes.position;
      const n = guideGeo.drawRange.count;
      const last = n ? { x: at.getX(n - 1), y: at.getY(n - 1), z: at.getZ(n - 1) } : null;
      // land = 本次预测的真落点：与 last 相等才说明"虚线画到哪、箭就落在哪"（末点没被顶点上限截断）
      return { n, last, land: { x: _fc.x, y: _fc.y, z: _fc.z }, kind: _fc.ev ? _fc.ev.kind : '',
        speed: api.speedOf(api.lastCharge || 0), marker: marker.visible ? 1 : 0 };
    },
    debugLineLen() {
      const at = guideGeo.attributes.position;
      const n = Math.min(guideGeo.drawRange.count, A.guideCap);
      if (n < 2) return 0;
      let L = 0;
      for (let i = 1; i < n; i++) {
        const dx = at.getX(i) - at.getX(i - 1), dy = at.getY(i) - at.getY(i - 1), dz = at.getZ(i) - at.getZ(i - 1);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return -1;  // NaN 会整条线消失，必须能显式失败
        L += Math.hypot(dx, dy, dz);
      }
      return +L.toFixed(3);
    },
    debugStuck() { return stuck.length; },
    debugHits() { return hits; },
  };
  api.lastCharge = 0;

  /** 弓的姿态：拉距越深弦越靠脸，出手后弦回弹一下 */
  function poseBow(charge) {
    api.lastCharge = charge;
    const pull = charge * 0.28 + recoil * 0.06;
    const a = stringGeo.attributes.position;
    // 中点 = 扣弦处；箭尾钉在同一个点上，所以拉弓时两者一起往脸上退
    a.setXYZ(0, 0, 0.4, -0.03);
    a.setXYZ(1, 0.045, 0.02, pull);
    a.setXYZ(2, 0, -0.4, -0.03);
    a.needsUpdate = true;
    const nockZ = pull - 0.33;   // 箭模型长 0.66、原点在杆身中点：尾落回扣弦处
    nocked.position.set(0.045, 0.02, nockZ);
    nocked.rotation.set(0, Math.PI, 0);   // 箭模型机头 +z -> 指向 -z（前方）
    nocked.visible = rig.visible && !fly.mesh;
    rig.rotation.x = charge * 0.05 - recoil * 0.1;
    recoil *= 0.86;
  }
  poseBow(0);
  return api;
}
