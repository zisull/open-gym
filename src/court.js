/**
 * court.js —— 室内篮球馆场景搭建（纯程序化几何体，无外部模型文件）
 * 包含：木地板标线、进攻端篮板/篮圈/篮网、远端装饰筐、观众座椅看台、
 *       场边围栏、墙体、顶棚灯带、光照与阴影。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeCourtTexture, makeCourtRoughness, makeCourtNormal, makeSkyTexture, makeWallTexture, makeWallNormal, makeDoorSignTexture } from './textures.js';

/** 圈心地面投影（投篮距离计算、粒子特效都以此为原点） */
export const RIM_POS = new THREE.Vector3(0, CFG.hoop.rimHeight, CFG.hoop.boardFaceZ + CFG.hoop.rimOffset);

export function buildCourt(scene) {
  /* ================= 材质 ================= */
  const floorTex = makeCourtTexture();
  // 上漆木地板改用纯 Standard 材质：去掉 clearcoat 二次高光 + 几乎不吃环境反射，
  // 相机移动时不再有游移的"假阴影"高光斑（闪烁根源之一）。
  // 粗糙度/法线交给专用贴图：漆面高光随木纹起伏、板缝有真实凹槽。
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 1.0,             // 实际粗糙度由 roughnessMap 控制（场内 ~0.35 / 场外 ~0.85）
    roughnessMap: makeCourtRoughness(),
    normalMap: makeCourtNormal(),
    normalScale: new THREE.Vector2(0.55, 0.55),
    metalness: 0.02,
    envMapIntensity: 0.12,
  });
  const paintedWood = (color, rough = 0.6) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05, envMapIntensity: 0.4 });

  /* ================= 地板（整馆一个平面，贴图自带橡胶缓冲区：无共面 Mesh = 无 z-fighting） ================= */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.gym.halfW * 2, CFG.gym.halfL * 2),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  /* ================= 墙体 / 顶棚 ================= */
  const wallTex = makeWallTexture();
  wallTex.repeat.set(4, 1);
  const wallNor = makeWallNormal();
  wallNor.repeat.set(4, 1);
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex, normalMap: wallNor, normalScale: new THREE.Vector2(0.7, 0.7),
    color: 0xffffff, roughness: 0.92, metalness: 0, envMapIntensity: 0.25, side: THREE.BackSide,
  });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x1a1f28, roughness: 0.95, metalness: 0, envMapIntensity: 0.15, side: THREE.BackSide });
  // 关键：盒子的底面与地板共面（y=0），若一起渲染就是"地板与深色面来回闪"的 z-fighting 根源。
  // BoxGeometry 六面分组顺序 +x,-x,+y,-y,+z,-z —— 底面(-y)给一个不渲染的材质直接挖掉。
  const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(CFG.gym.halfW * 2, CFG.gym.height, CFG.gym.halfL * 2),
    [wallMat, wallMat, ceilMat, hiddenMat, wallMat, wallMat]
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
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222528, emissive: 0xeaf0ff, emissiveIntensity: 3.0 });
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
  // 支架钢件改 Physical + 各向异性拉丝金属：高光沿管壁方向拉开，不再是塑料感的圆点
  const steelMat = new THREE.MeshPhysicalMaterial({
    color: 0xb8420e, roughness: 0.34, metalness: 0.82, envMapIntensity: 0.9,
    anisotropy: 0.45, anisotropyRotation: Math.PI / 2,
  });
  const rimMat = new THREE.MeshPhysicalMaterial({
    color: 0xff5a1f, roughness: 0.22, metalness: 0.85, emissive: 0x5a1400, emissiveIntensity: 0.8,
    envMapIntensity: 1.0, anisotropy: 0.35, anisotropyRotation: Math.PI / 2,
  });

  // 透明钢化玻璃篮板（低粗糙度 + 清漆层，靠环境贴图出玻璃高光）
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xdfeaf5, transparent: true, opacity: 0.12,
    roughness: 0.06, metalness: 0,
    clearcoat: 0.7, clearcoatRoughness: 0.1,
    envMapIntensity: 0.8,
  });
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
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.35), paintedWood(0x1d3a66, 0.9));
  pad.position.set(0, 0.85, CFG.hoop.boardFaceZ - 0.95);
  hoopGroup.add(pad);

  // 篮网：三层递减圆环 + 12 根竖向网丝（简易锥形网格）
  const netGroup = new THREE.Group();
  netGroup.position.copy(RIM_POS);
  const netMat = new THREE.MeshStandardMaterial({ color: 0xf7f4ec, roughness: 0.85, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
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
    strands.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 6, 0.0052, 4), netMat));
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
  // 远端装饰在阴影相机范围外：若继续投影会在其边缘产生生硬闪烁切边
  far.traverse((o) => { if (o.isMesh) o.castShadow = false; });
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
    const seatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.5 });
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
    // 座椅不投影：5x26 的密集小盒子阴影是地板条纹闪烁的主要来源，
    // 看台区域改由整块台阶面接收上方灯光渐变即可
    seats.castShadow = false;
    bleacher.add(seats);
    // 靠背斜板
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.52, 12.2), concrete);
    back.position.set(x + 0.2, h + 0.3, 0);
    bleacher.add(back);
  }
  scene.add(bleacher);

  /* ================= 场边围栏 + LED 广告屏（-x 侧与两端） ================= */
  const railMat = new THREE.MeshStandardMaterial({ color: 0xb6bec7, roughness: 0.18, metalness: 0.92, envMapIntensity: 1.0 });
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
  // +z 侧围栏拆成两段，在电影院红门（x≈6）前留出通道缺口
  mkRail(9.5, -2.75, CFG.court.halfL + 1.2, 0);
  mkRail(1.5, 9.75, CFG.court.halfL + 1.2, 0);
  // 场边 LED 广告板（暗光发光，Bloom 轻微溢出）
  const ad1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 19.5), new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: 0x2255ff, emissiveIntensity: 0.55, roughness: 0.4 }));
  ad1.position.set(-CFG.court.halfW - 1.7, 0.45, 0);
  scene.add(ad1);
  // 电子广告滚动文字贴图
  const adCv = document.createElement('canvas');
  adCv.width = 1024; adCv.height = 64;
  const adCtx = adCv.getContext('2d');
  adCtx.fillStyle = '#050a14'; adCtx.fillRect(0, 0, 1024, 64);
  adCtx.fillStyle = '#4d9fff'; adCtx.font = 'bold 40px system-ui'; adCtx.textBaseline = 'middle';
  adCtx.fillText('JUMP  ·  SHOOT  ·  SCORE  ·  精准出手  ·  连击挑战  ·  ', 10, 34);
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

  /* ================= 电影院入口（+z 墙红门 + 发光门牌，走进去转场） ================= */
  {
    const D = CFG.cinema.gymDoor;
    const g = new THREE.Group();
    g.position.set(D.x, 0, CFG.gym.halfL - 0.06);
    g.rotation.y = Math.PI; // 面朝场内（-z 方向）
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x6e1620, roughness: 0.5, metalness: 0.3 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.05, 3.15, 0.1), frameMat);
    frame.position.y = 1.57;
    g.add(frame);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.8, 0.12), paintedWood(0x2b1a12, 0.7));
    slab.position.set(0, 1.4, 0.04);
    g.add(slab);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), railMat);
    handle.position.set(-0.62, 1.35, 0.14);
    g.add(handle);
    // 门缝暖光：模拟影院里透出来的放映光，让黑门板在暗墙上可辨
    const crack = new THREE.Mesh(
      new THREE.PlaneGeometry(1.56, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xffb066 })
    );
    crack.position.set(0, 2.72, 0.115);
    g.add(crack);
    const signTex = makeDoorSignTexture('电 影 院', '🎬 走进门即可观影');
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.58),
      new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.6 })
    );
    sign.position.set(0, 3.5, 0.1);
    g.add(sign);
    // 门口导视地垫（暗红发光圈，提示可进入）
    const mat2 = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 28),
      new THREE.MeshStandardMaterial({ color: 0x5a1420, emissive: 0x7a1f2a, emissiveIntensity: 0.5, roughness: 0.9 })
    );
    mat2.rotation.x = -Math.PI / 2;
    mat2.position.set(0, 0.012, 1.1); // 局部 +z 经组旋转后指向场内
    g.add(mat2);
    scene.add(g);
  }

  return { netGroup, rim, adTex, floor };
}

/**
 * 墙面二次元贴画：读取 tools/gen_wall_manifest.js 生成的 window.BB_WALLS
 * （data:URL 图片集），自动均匀挂到四面墙的海报框上。
 * 在 buildCourt 之后调用；图片数量为 0 时静默跳过。
 */
export function addWallArt(scene) {
  const list = (typeof window !== 'undefined' && window.BB_WALLS) || [];
  if (!list.length) return;
  const loader = new THREE.TextureLoader();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.45, metalness: 0.5, envMapIntensity: 0.6 });
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  // 四面墙：位置取墙面内侧 5cm，len 为该墙可用长度
  const walls = [
    { x: 0, z: -CFG.gym.halfL + 0.05, ry: 0, len: CFG.gym.halfW * 2, alongX: true },
    { x: 0, z: CFG.gym.halfL - 0.05, ry: Math.PI, len: CFG.gym.halfW * 2, alongX: true },
    { x: -CFG.gym.halfW + 0.05, z: 0, ry: Math.PI / 2, len: CFG.gym.halfL * 2, alongX: false },
    { x: CFG.gym.halfW - 0.05, z: 0, ry: -Math.PI / 2, len: CFG.gym.halfL * 2, alongX: false },
  ];
  const groups = walls.map(() => []);
  list.forEach((it, i) => groups[i % walls.length].push(it));

  groups.forEach((g, wi) => {
    const W = walls[wi];
    g.forEach((it, k) => {
      const t = (k + 0.5) / g.length - 0.5;           // -0.5 ~ 0.5 沿墙均布
      const off = t * W.len * 0.78;
      const holder = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.05), frameMat);
      const mesh = new THREE.Mesh(planeGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, envMapIntensity: 0.3 }));
      mesh.position.z = 0.032;                        // 贴在画框玻璃面前
      holder.add(frame, mesh);
      holder.position.set(W.alongX ? W.x + off : W.x, 2.55, W.alongX ? W.z : W.z + off);
      holder.rotation.y = W.ry;
      scene.add(holder);
      loader.load(it.url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        mesh.material.map = tex;
        mesh.material.needsUpdate = true;
        const ar = tex.image.width / tex.image.height; // 保持图片原始宽高比
        const slotW = Math.max(1.2, (W.len * 0.78) / g.length - 0.35); // 不挤占邻居
        const hh = Math.min(2.5, Math.min(3.1, slotW) / Math.max(ar, 0.01));
        const w = hh * ar;
        mesh.scale.set(w, hh, 1);
        frame.scale.set(w + 0.14, hh + 0.14, 1);
      });
    });
  });
}

/**
 * 灯光：主方向光（软阴影）+ 半球环境光。
 * 返回引用供阴影开关使用。
 */
export function setupLights(scene) {
  const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x2a2118, 0.85);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xfff3e0, 2.4);
  dir.position.set(4, 14, -2);            // 更接近顶光：地板掠射阴影面积大幅缩小
  dir.castShadow = true;
  // 阴影配置原则：投射物越少、覆盖越紧、法线偏移越小越稳。
  // 密集小阴影（座椅/远端筐）已关；这里用 2048 + 温和 normalBias，
  // 避免 4096 细纹在相机移动时逐像素跳变（表现为地板"闪烁阴影"）。
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -11;
  dir.shadow.camera.right = 11;
  dir.shadow.camera.top = 13;
  dir.shadow.camera.bottom = -13;
  dir.shadow.camera.near = 4;
  dir.shadow.camera.far = 42;
  dir.shadow.bias = -0.00015;
  dir.shadow.normalBias = 0.03;
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
