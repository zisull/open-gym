/**
 * court.js —— 室内篮球馆场景搭建（纯程序化几何体，无外部模型文件）
 * 包含：木地板标线、进攻端篮板/篮圈/篮网、远端装饰筐、观众座椅看台、
 *       场边围栏、墙体、顶棚灯带、光照与阴影。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeCourtTexture, makeSkyTexture } from './textures.js';

/** 圈心地面投影（投篮距离计算、粒子特效都以此为原点） */
export const RIM_POS = new THREE.Vector3(0, CFG.hoop.rimHeight, CFG.hoop.boardFaceZ + CFG.hoop.rimOffset);

export function buildCourt(scene) {
  /* ================= 材质 ================= */
  const floorTex = makeCourtTexture();
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.42,     // 上漆木地板的轻微反光
    metalness: 0.08,
    envMapIntensity: 0.6,
  });
  const paintedWood = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });

  /* ================= 地板 ================= */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.court.halfW * 2, CFG.court.halfL * 2),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // 场外地面（深灰水泥环带；与球场地板拉开 6cm，任何深度精度下都不共面闪烁）
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.gym.halfW * 2, CFG.gym.halfL * 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.9 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.06;
  apron.receiveShadow = true;
  scene.add(apron);

  /* ================= 墙体 / 顶棚 ================= */
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x303946, roughness: 0.95, side: THREE.BackSide });
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(CFG.gym.halfW * 2, CFG.gym.height, CFG.gym.halfL * 2),
    wallMat
  );
  shell.position.y = CFG.gym.height / 2;
  scene.add(shell);
  // 墙裙（深色防撞带）：四块竖板贴墙内侧
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.85 });
  const mkSkirt = (w, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, 0.06), skirtMat);
    m.position.set(x, 0.55, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
  };
  mkSkirt(CFG.gym.halfW * 2, 0, -CFG.gym.halfL + 0.03, 0);
  mkSkirt(CFG.gym.halfW * 2, 0, CFG.gym.halfL - 0.03, 0);
  mkSkirt(CFG.gym.halfL * 2, -CFG.gym.halfW + 0.03, 0, Math.PI / 2);
  mkSkirt(CFG.gym.halfL * 2, CFG.gym.halfW - 0.03, 0, Math.PI / 2);

  /* ================= 顶棚灯板（自发光，Bloom 提亮） ================= */
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfe8ff, emissiveIntensity: 2.2 });
  for (let ix = -1; ix <= 1; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 1.5), lampMat);
      lamp.position.set(ix * 5.6, CFG.gym.height - 0.14, iz * 5.2);
      scene.add(lamp);
    }
  }

  /* ================= 进攻端篮架（可计分） ================= */
  const hoopGroup = new THREE.Group();
  scene.add(hoopGroup);
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xb8420e, roughness: 0.5, metalness: 0.35 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.35, metalness: 0.5, emissive: 0x3a0d00, emissiveIntensity: 0.6 });

  // 透明篮板
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xdfeaf5, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, transmission: 0 });
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(CFG.hoop.boardW, CFG.hoop.boardH, 0.04),
    glass
  );
  const boardY = CFG.hoop.boardBottomY + CFG.hoop.boardH / 2;
  board.position.set(0, boardY, CFG.hoop.boardFaceZ);
  hoopGroup.add(board);
  // 篮板边框 + 射击方框（白色发光线条）
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf3f6f9, roughness: 0.4, emissive: 0x222222 });
  const mkEdge = (w, h, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.045), edgeMat);
    m.position.set(x, y, CFG.hoop.boardFaceZ);
    hoopGroup.add(m);
  };
  mkEdge(CFG.hoop.boardW + 0.04, 0.03, 0, CFG.hoop.boardBottomY + CFG.hoop.boardH);
  mkEdge(CFG.hoop.boardW + 0.04, 0.03, 0, CFG.hoop.boardBottomY);
  mkEdge(0.03, CFG.hoop.boardH, -CFG.hoop.boardW / 2, boardY);
  mkEdge(0.03, CFG.hoop.boardH, CFG.hoop.boardW / 2, boardY);
  mkEdge(0.62, 0.025, 0, 3.05 + 0.15);   // 内框下沿（穿过篮圈高度）
  mkEdge(0.62, 0.025, 0, 3.62);          // 内框上沿
  mkEdge(0.025, 0.57, -0.31, 3.335);     // 内框左侧
  mkEdge(0.025, 0.57, 0.31, 3.335);      // 内框右侧

  // 篮圈
  const rim = new THREE.Mesh(new THREE.TorusGeometry(CFG.hoop.rimRadius, CFG.hoop.rimTube, 12, 32), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.copy(RIM_POS);
  rim.castShadow = true;
  hoopGroup.add(rim);
  // 圈挂耳
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, CFG.hoop.rimOffset + 0.1), steelMat);
  bracket.position.set(0, CFG.hoop.rimHeight - 0.02, CFG.hoop.boardFaceZ + CFG.hoop.rimOffset / 2);
  hoopGroup.add(bracket);
  // 支撑臂 + 立柱
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 1.0), steelMat);
  arm.position.set(0, 3.55, CFG.hoop.boardFaceZ - 0.5);
  arm.rotation.x = -0.25;
  hoopGroup.add(arm);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.7, 12), steelMat);
  pole.position.set(0, 1.85, CFG.hoop.boardFaceZ - 0.95);
  pole.castShadow = true;
  hoopGroup.add(pole);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.35), paintedWood(0x2456a8));
  pad.position.set(0, 0.85, CFG.hoop.boardFaceZ - 0.95);
  hoopGroup.add(pad);

  // 篮网：三层递减圆环 + 12 根竖向网丝（简易锥形网格）
  const netGroup = new THREE.Group();
  netGroup.position.copy(RIM_POS);
  const netMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const strands = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const topR = CFG.hoop.rimRadius - 0.01;
    const botR = 0.115;
    const pts = [
      new THREE.Vector3(Math.cos(a) * topR, 0, Math.sin(a) * topR),
      new THREE.Vector3(Math.cos(a) * (topR * 0.62 + botR * 0.38), -CFG.hoop.netDepth * 0.55, Math.sin(a) * (topR * 0.62 + botR * 0.38)),
      new THREE.Vector3(Math.cos(a) * botR, -CFG.hoop.netDepth, Math.sin(a) * botR),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    strands.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 6, 0.004, 4), netMat));
  }
  strands.forEach((s) => netGroup.add(s));
  for (let r = 1; r <= 3; r++) {
    const k = r / 4;
    const rad = CFG.hoop.rimRadius * (1 - k) + 0.115 * k;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.0035, 6, 20), netMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -CFG.hoop.netDepth * k;
    netGroup.add(ring);
  }
  hoopGroup.add(netGroup);

  /* ================= 远端装饰筐（整体绕 Y 旋转 180° 镜像到 +z 端） ================= */
  const far = hoopGroup.clone(true);
  far.rotation.y = Math.PI;
  scene.add(far);

  /* ================= 看台座椅（+x 侧，楔形阶梯紧贴右墙） ================= */
  const bleacher = new THREE.Group();
  const concrete = paintedWood(0x4a5058);
  const seatColors = [0xd8431f, 0x1f5fd8, 0xf0b429, 0x2ea35a];
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const h = 0.38 + r * 0.34;                       // 该排台面高度
    const x = 7.9 + r * 0.42;                        // 逐级升高并向墙内收
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.46, h, 12.5), concrete);
    step.position.set(x, h / 2, 0);
    step.receiveShadow = true;
    bleacher.add(step);
    // 该排座椅（InstancedMesh：一实例一座，橙蓝黄绿相间）
    const seatGeo = new THREE.BoxGeometry(0.38, 0.1, 0.44);
    const seatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const N = 26;
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, N);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < N; i++) {
      dummy.position.set(x - 0.02, h + 0.24, -5.8 + (i / (N - 1)) * 11.6);
      dummy.rotation.set(0, -0.28, 0);
      dummy.updateMatrix();
      seats.setMatrixAt(i, dummy.matrix);
      color.setHex(seatColors[(i + r * 7) % seatColors.length]);
      seats.setColorAt(i, color);
    }
    seats.castShadow = true;
    bleacher.add(seats);
    // 靠背斜板
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.52, 12.2), concrete);
    back.position.set(x + 0.2, h + 0.3, 0);
    bleacher.add(back);
  }
  scene.add(bleacher);

  /* ================= 场边围栏 + LED 广告屏（-x 侧与两端） ================= */
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.35, metalness: 0.8 });
  const mkRail = (len, x, z, ry) => {
    const g = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 8), railMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 0.92;
    g.add(bar);
    const n = Math.round(len / 1.6);
    for (let i = 0; i <= n; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.92, 6), railMat);
      post.position.set(-len / 2 + (i * len) / n, 0.46, 0);
      g.add(post);
    }
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    scene.add(g);
  };
  mkRail(20, -CFG.court.halfW - 1.2, 0, Math.PI / 2);
  mkRail(14, 0, CFG.court.halfL + 1.2, 0);
  // 场边 LED 广告板（暗光发光，Bloom 轻微溢出）
  const adMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: 0x2255ff, emissiveIntensity: 0.55, roughness: 0.4 });
  const ad1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 19.5), adMat);
  ad1.position.set(-CFG.court.halfW - 1.7, 0.45, 0);
  scene.add(ad1);
  // 电子广告滚动文字贴图
  const adCv = document.createElement('canvas');
  adCv.width = 1024; adCv.height = 64;
  const adCtx = adCv.getContext('2d');
  adCtx.fillStyle = '#050a14'; adCtx.fillRect(0, 0, 1024, 64);
  adCtx.fillStyle = '#4d9fff'; adCtx.font = 'bold 40px system-ui'; adCtx.textBaseline = 'middle';
  adCtx.fillText('JUMP  ·  SHOOT  ·  SCORE  ·  运球卡点  ·  完美节奏  ·  ', 10, 34);
  const adTex = new THREE.CanvasTexture(adCv);
  adTex.wrapS = THREE.RepeatWrapping; adTex.repeat.x = 2;
  ad1.material = new THREE.MeshStandardMaterial({ map: adTex, emissiveMap: adTex, emissive: 0x88aaff, emissiveIntensity: 1.2 });

  /* ================= 球员通道入口装饰（-z 端两侧门） ================= */
  const doorMat = paintedWood(0x171c24);
  for (const dx of [-6, 6]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.6, 0.12), doorMat);
    door.position.set(dx, 1.3, -CFG.gym.halfL + 0.12);
    scene.add(door);
  }

  return { netGroup, rim, adTex, floor };
}

/**
 * 灯光：主方向光（软阴影）+ 半球环境光。
 * 返回引用供阴影开关使用。
 */
export function setupLights(scene) {
  const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x2a2118, 0.85);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xfff3e0, 2.4);
  dir.position.set(6, 11, -4);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -16;
  dir.shadow.camera.right = 16;
  dir.shadow.camera.top = 18;
  dir.shadow.camera.bottom = -18;
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 40;
  dir.shadow.bias = -0.0002;
  dir.shadow.normalBias = 0.05;   // 消除斜视角下地板的阴影条纹闪烁
  scene.add(dir);
  scene.add(dir.target);
  dir.target.position.set(0, 0, -8);

  // 篮筐下方补光，突出进攻区
  const rimSpot = new THREE.PointLight(0xfff8ee, 18, 14, 1.8);
  rimSpot.position.set(0, 6.5, RIM_POS.z + 1.5);
  scene.add(rimSpot);

  return { hemi, dir, rimSpot };
}

/** 背景（渐变天空盒替代物：球馆氛围渐变） */
export function applyBackground(scene) {
  scene.background = makeSkyTexture();
  scene.fog = new THREE.Fog(0x10151d, 26, 46);
}
