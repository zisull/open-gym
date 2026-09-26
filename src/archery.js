/**
 * archery.js —— 射箭：靶位（+z 端，原第二只篮筐的位置）+ 弓箭视角模型
 *
 * **故意不给弹道辅助线，也不给准星**（台球室那条虚线在这里被撤掉，屏幕正中的瞄具也撤掉）：
 * 有落点圈或准星指着的射箭等于点名，玩家报的"难度太低"就是这个。
 * 现在唯一的依据是力度条 + 手里的弓 —— 下坠是真的，箭从右下出手也是真的，抬多少自己算。
 * 好在靶子够大（1.5m）、箭够快（满弓 12.7m 只掉 0.14m），第一箭就能上靶。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeTargetTexture } from './textures.js';

const A = CFG.arch;
const G0 = CFG.player.gravity;

/**
 * 出手点在弓上（相机右下前方），方向就是相机朝向 —— 屏幕正中不再等于落点。
 * 没有准星、也不往准星上收拢：箭从眼睛右下 15cm/20cm 处平行于视线飞出去，
 * 所以瞄着黄心会扎在黄心下方一环，抬多少得自己记住（这才是这一模式的全部难度）。
 */
const NOCK = { right: 0.15, down: 0.20, fwd: 0.30 };

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
  // 端面刻意退到靶面后 2.5cm：与 face 共面会 z-fighting，近看靶面上爬出一块草垫色的扇形
  butt.position.set(0, A.targetY, 0.03);
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
 * 玩法侧：弓 + 箭（`createArchery`），由 states.js 的 ArchState 每帧驱动。
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

  /* ================= 飞行中的箭 ================= */
  const fly = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, mesh: null };
  const stuck = [];      // 插在靶上的箭（跟着靶组走）
  const hits = [];       // 对应的命中点（世界系，未加嵌入偏移）：无头用例靠它读"这一箭真扎在哪"
  const loose = [];      // 落地/撞墙的箭：留在场地当痕迹，攒多了回收
  const pool = [];       // 空闲网格：一局限几十箭，不能每次发射都新建
  let acc = 0;
  let recoil = 0;
  const _dir = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 0, 1);
  const _p = new THREE.Vector3();
  // 出手点/方向所用的相机基向量（每帧复用，热路径零分配）
  const _lp = new THREE.Vector3();
  const _ld = new THREE.Vector3();
  const _lr = new THREE.Vector3();
  const _lu = new THREE.Vector3();
  const _ev = { kind: '', ring: 0, dist: 0, x: 0, y: 0, z: 0 };

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

  /** 算出这一箭的出手点与方向：由相机姿态现推（方向＝视线本身，不向任何瞄具收拢） */
  function launchState() {
    const q = camera.quaternion;
    _ld.set(0, 0, -1).applyQuaternion(q);
    _lr.set(1, 0, 0).applyQuaternion(q);
    _lu.set(0, 1, 0).applyQuaternion(q);
    _lp.copy(camera.position)
      .addScaledVector(_lr, NOCK.right)
      .addScaledVector(_lu, -NOCK.down)
      .addScaledVector(_ld, NOCK.fwd);
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
    /** 力度 0~1 -> 箭速 */
    speedOf(charge) { return A.speedMin + charge * (A.speedMax - A.speedMin); },

    showRig(on) { rig.visible = on; },

    /** 瞄准中每帧调用：只摆弓。没有落点预测 —— 下坠多少全看力度条与准星抬多高 */
    aim(charge) { poseBow(charge); },

    /** 放箭 */
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
      api.lastKind = '';
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
      if (ev) { api.lastKind = ev.kind; stick(ev, fly); }
      return ev;
    },

    /** 收弓 / 换局：撤掉在飞的箭 */
    reset() {
      if (fly.mesh) { recycle(fly.mesh); fly.mesh = null; }
      acc = 0;
    },

    clearStuck() {
      hits.length = 0;
      while (stuck.length) recycle(stuck.shift());
      while (loose.length) recycle(loose.shift());
    },

    /* ---------- 无头断言用 ---------- */
    debugStuck() { return stuck.length; },
    debugHits() { return hits; },
  };
  api.lastCharge = 0;
  api.lastKind = '';   // 上一箭的落点类型：hit / board / drop / wall / time（无头用例与提示都读它）

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
