/**
 * cinema.js —— 电影院场景 + 环墙放映器（圆筒厅 / 正多边形厅两种形态）
 * 独立 THREE.Scene：黑匣子影厅，环墙都是银幕。**全厅统一一个银幕高度（6.8m，近乎
 * 贴天花板）**，屏数 = 片源数（3 个就 3 块、5 个就 5 块），每块吃满自己的等分槽位（比自身
 * 宽高比略宽时按 cover 等比裁剪，不拉伸变形），所以片源一多就自动铺满一整圈。中央圆形小床
 * （无围栏，视线通透），任意角度入座、按住拖拽环视、滚轮变焦，控制条可一键收起。
 * 厅形二选一（控制台切换，存档记忆）：**圆筒** = 96 段柱面 + 弧形幕；**正多边形** = n 部片就
 * 是 n 条直墙（3 部三角形、4 部正方形、6 部六边形），每面墙挂一块平面幕。墙的位置由**内切
 * 半径**定：6 边以上就取 ring.r（与圆筒同距），3~5 边按 `polyK` 略微收小，免得墙比幕宽一大截。
 * 两种厅形**都没有门**：墙是一整圈闭合的（黑匣子不漏光、整圈都能挂幕），回球场只走放映条的
 * 「🚪 退出影院」。
 * 片源管理统一在放映控制台（抽屉）：一行一部管出声/播停/删片，底部换片单、加入、恢复默认；
 * 「放大观看」宫格只做切出声。
 * 「开始播放」会把当次片单名字存成历史快照（bb.cinema.playlists），控制台底部一键换回。
 * file:// 下本地相对路径视频会污染 WebGL 贴图，因此片源只允许
 * data:（video/manifest.js 内嵌短片）或 blob:（"选择视频"文件）两种同源形式。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeScreenPlaceholderTexture, makeCarpetTexture } from './textures.js';

const K = CFG.cinema;
const R = K.ring.r;
const H = K.ring.height;
const DEG = Math.PI / 180;
const SHAPE_KEY = 'bb.cinema.shape';
/** 上次的厅形：round = 圆筒弧幕（默认），poly = 正多边形直墙平面幕 */
function loadShape() {
  try { return localStorage.getItem(SHAPE_KEY) === 'poly' ? 'poly' : 'round'; } catch (e) { return 'round'; }
}
/** 环上某角度处的位置（约定同 CylinderGeometry：theta=0 在 +z，x=R·sin, z=R·cos） */
const ringAt = (a, r = R) => ({ x: Math.sin(a) * r, z: Math.cos(a) * r });
/** 正 n 边形的**外接**半径：由内切半径 ap 反推（顶点比墙面远，所以 n 越小厅越大） */
const circumR = (n, ap) => ap / Math.cos(Math.PI / n);
/** 厅壳：圆筒 = 96 段柱面；多边形 = 正 n 棱柱（每段面正好是一条直墙、挂一块幕）。
 *  CylinderGeometry 的顶点角与 ringAt 同约定，所以面心天然落在 slot·(i+0.5) 上，无需对相。 */
function shellGeo(shape, n, ap) {
  return shape === 'poly'
    ? new THREE.CylinderGeometry(circumR(n, ap), circumR(n, ap), H, n, 1, true)
    : new THREE.CylinderGeometry(R, R, H, 96, 1, true);
}
/** 走动范围的**外层 AABB**（模块级，applyShell 只改字段不换引用，所以 player.bounds 一直指向它）：
 *  真正的边界由 cinema.update() 按厅形做径向/按边法线夹取，这里只兜住多边形厅的角落。 */
const ROOM_BOUNDS = { minX: -(R - 0.7), maxX: R - 0.7, minZ: -(R - 0.7), maxZ: R - 0.7 };

/** 创建离屏 <video>：必须保持渲染（opacity .01 而非 display:none）才会持续解码出帧 */
function makeVideoEl() {
  const v = document.createElement('video');
  v.className = 'btv';
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = true; // 单片循环播放
  v.muted = true; // 建好先静音，由 applyAudio() 按"出声集合"逐路放行（可多部同时响）
  document.body.appendChild(v);
  return v;
}

export function createCinema({ camera, player, sfx }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070b);

  let shape = loadShape(); // 'round' | 'poly'（存档记忆）
  let edges = 0;           // 多边形厅的边数 = 该厅的墙数；0 表示当前是圆筒
  /** 当前厅的"墙到轴心距离"（多边形=内切半径，圆筒=R）。边数少时按 polyK 收一点：
   *  三角形那条边本来有 36m 长，幕最多 19m，墙会空一大片；收小半径既让幕基本铺满直墙、
   *  又把观看距离从 10.5m 提到 IMAX 感的 7.6m。6 边以上就与圆筒同距。 */
  const apOf = () => (edges ? R * (K.polyK[edges] || 1) : R);
  let AP = R;

  /* ================= 黑匣子厅壳（壁/顶/地三者不共面，从结构上杜绝闪烁） =========
     这里只按"圆筒"建一份占位几何，真实形态由 applyShell() 在第一次 rebuild() 时统一建好 */
  const wall = new THREE.Mesh(
    shellGeo('round', 3, R),
    new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.95, metalness: 0, side: THREE.BackSide, envMapIntensity: 0.1 })
  );
  wall.position.y = H / 2;
  scene.add(wall);
  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(R, 64),
    new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 1, side: THREE.BackSide })
  );
  ceiling.rotation.x = Math.PI / 2; // 面朝下
  ceiling.position.y = H;
  scene.add(ceiling);
  const carpet = new THREE.Mesh(
    new THREE.CircleGeometry(R, 64),
    new THREE.MeshStandardMaterial({ map: makeCarpetTexture(), roughness: 0.96, metalness: 0, envMapIntensity: 0.05 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.y = 0.01;
  scene.add(carpet);
  /** 地/顶/走动范围跟着厅形走：多边形取「过顶点的外接圆」，比直墙还大一圈，超出部分藏在墙后看不见。
   *  灯带与壁灯也一起贴到当前墙面上（圆筒=一圈圆，多边形=沿着棱走的折线带）。
   *  ROOM_BOUNDS 只是外层 AABB，真正的边界靠 update() 里按边法线做的夹取。 */
  function applyShell() {
    AP = apOf();
    const rr = edges ? circumR(edges, AP) : R;
    wall.geometry.dispose();
    wall.geometry = shellGeo(shape, Math.max(3, edges), AP);
    ceiling.geometry.dispose();
    ceiling.geometry = new THREE.CircleGeometry(rr, 64);
    carpet.geometry.dispose();
    carpet.geometry = new THREE.CircleGeometry(rr, 64);
    ROOM_BOUNDS.minX = -(rr - 0.7); ROOM_BOUNDS.maxX = rr - 0.7;
    ROOM_BOUNDS.minZ = -(rr - 0.7); ROOM_BOUNDS.maxZ = rr - 0.7;
    cove.geometry.dispose();
    if (edges) {
      // 折线灯带：走一圈墙面内缩 42cm 的多边形（过曲线控制点，转角自然圆过去，比硬折角好看）
      const vr = circumR(edges, AP - 0.42);
      const pts = [];
      for (let e = 0; e < edges; e++) {
        const a = e * ((Math.PI * 2) / edges);
        pts.push(new THREE.Vector3(Math.sin(a) * vr, 0, Math.cos(a) * vr));
      }
      cove.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), edges * 16, 0.055, 8, true);
      cove.rotation.x = 0; // 点本身已在水平面上
    } else {
      cove.geometry = new THREE.TorusGeometry(R - 0.42, 0.055, 8, 96);
      cove.rotation.x = Math.PI / 2;
    }
    sconces.forEach((lp, i) => {
      const a = edges ? (i + 0.5) * ((Math.PI * 2) / edges) : SCONCE_DEG[i] * DEG;
      const d = AP - 0.6;
      lp.position.set(Math.sin(a) * d, H - 0.5, Math.cos(a) * d);
    });
  }

  /* ================= 银幕（弧面 / 平面两种几何） ================= */
  const SH = K.screen.h; // 全厅唯一的银幕高度：片多片少都不缩放
  const PR = R - 0.1;    // 幕面到轴心的距离（离墙留 10cm，避免与墙共面闪烁）
  const placeholderTex = makeScreenPlaceholderTexture();
  placeholderTex.repeat.x = -1; // 从筒内壁看是镜像的，横向翻回来
  placeholderTex.offset.x = 1;
  const phFlat = placeholderTex.clone(); // 平面幕从内侧看就是正像，不用翻
  phFlat.repeat.set(1, 1);
  phFlat.offset.set(0, 0);
  phFlat.needsUpdate = true;
  const isPoly = () => shape === 'poly';
  /** 圆心角 -> 幕面实宽（多边形=该角对应的弦长，圆筒=弧长） */
  const arcW = (arc) => (isPoly() ? 2 * AP * Math.tan(arc / 2) : arc * PR);
  /** 目标宽度 -> 圆心角（arcW 的逆） */
  const wArc = (w) => (isPoly() ? 2 * Math.atan(w / (2 * AP)) : w / PR);
  const phArc = () => wArc(SH * K.screen.defAr); // 占位图按它自己的 16:9 取宽，永不拉伸

  /** 截一柱面：半径 radius、高 h、圆心角 theta，中心已抬到屏心高度 */
  function patchGeo(radius, h, theta) {
    const seg = Math.max(8, Math.ceil(theta / 0.045));
    const g = new THREE.CylinderGeometry(radius, radius, h, seg, 1, true, -theta / 2, theta);
    g.translate(0, K.screen.cy, 0);
    return g;
  }
  /** 一块幕的面（银幕与黑背衬共用）：圆筒切柱面片（几何自身抬到屏心高），多边形切平面板（摆位时抬） */
  function faceGeo(arc, h, radius) {
    return isPoly()
      ? new THREE.PlaneGeometry(arcW(arc), h)
      : patchGeo(radius, h, arc);
  }
  /** 摆正一块幕：圆筒只绕 y 转到槽位角（柱面片几何自身已抬到屏心高度）；
   *  平面板要抬到屏心高、站到该面墙的内侧，并把法线（默认 +z）转到朝向轴心。
   *  back=true 是黑背衬，往墙里再贴 6cm（与圆筒模式同一套间距）。 */
  function placeFace(mesh, a, back) {
    if (isPoly()) {
      const d = AP - (back ? 0.04 : 0.1);
      mesh.position.set(Math.sin(a) * d, K.screen.cy, Math.cos(a) * d);
      mesh.rotation.y = a + Math.PI;
    } else {
      mesh.position.set(0, 0, 0);
      mesh.rotation.y = a;
    }
  }

  /** cover 适配：画面等比放大到铺满幕面，多出来的裁掉，所以永不拉伸变形。
   *  圆筒内壁看是左右反的（flip=true 用负 repeat 翻回正像）；平面板本来就是正像。 */
  function applyCover(tex, patchAr, srcAr, flip) {
    const s = flip ? -1 : 1; // 水平方向的正负号
    if (patchAr >= srcAr) { // 幕比画面宽 -> 裁上下
      const f = srcAr / patchAr;
      tex.repeat.set(s, f);
      tex.offset.set(flip ? 1 : 0, (1 - f) / 2);
    } else {                // 画面比幕宽 -> 裁左右
      const f = patchAr / srcAr;
      tex.repeat.set(s * f, 1);
      tex.offset.set(flip ? (1 + f) / 2 : (1 - f) / 2, 0);
    }
  }

  const screens = []; // 与 sources 一一对应，rebuild() 重建
  /**
   * 出声集合：存的是**片源名**（不是下标），所以删片/加片/重开都不会错位。
   * 允许多部同时出声——这是"统一控制台"要解决的核心问题（旧模型只有一个 focus 位，
   * 且 rebuild 把非焦点屏 volume 写成 0、tapScreen 又只改 muted 不改 volume，点了没声）。
   */
  const VOICE_KEY = 'bb.cinema.voices';
  let voiceNames = loadVoiceNames();
  let voices = new Set(); // 每次 rebuild 由 voiceNames 映射成当前下标

  function loadVoiceNames() {
    try {
      const a = JSON.parse(localStorage.getItem(VOICE_KEY) || 'null');
      return Array.isArray(a) ? a : null; // null = 用户还没选过，默认让第一部出声
    } catch (e) { return null; }
  }
  function saveVoices() {
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(
        screens.filter((s, i) => voices.has(i) && s.src).map((s) => s.src.name)
      ));
    } catch (e) { /* 无痕模式存不了，不影响放映 */ }
  }
  /** 把 voiceNames 映射到当前 screens 下标；一个都没对上就退回「第一部有片的屏」 */
  function syncVoices() {
    voices = new Set();
    screens.forEach((s, i) => { if (s.src && voiceNames && voiceNames.includes(s.src.name)) voices.add(i); });
    if (!voices.size) {
      const first = screens.findIndex((s) => s.src);
      if (first >= 0) voices.add(first);
    }
  }

  /** 建一块屏：src 为 null 时是永久占位空洞（比如上次用本地文件放的，重开复原不了） */
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x04050a, roughness: 0.92, metalness: 0, side: THREE.BackSide });
  const frameMatFlat = new THREE.MeshStandardMaterial({ color: 0x04050a, roughness: 0.92, metalness: 0 }); // 平面板正面朝轴心
  function makeScreen(src, a, slot) {
    const poly = isPoly();
    const videoEl = makeVideoEl();
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const arc = Math.min(slot, phArc()); // 元数据到位前先按占位图的比例挂上去
    const mat = new THREE.MeshBasicMaterial({
      map: poly ? phFlat : placeholderTex, color: 0xb8c2d0, side: poly ? THREE.FrontSide : THREE.BackSide,
    });
    const mesh = new THREE.Mesh(faceGeo(arc, SH, PR), mat);
    placeFace(mesh, a, false);
    scene.add(mesh);
    // 黑色背衬：比幕面高 16cm、往墙里再贴 6cm，从上下缘包住画面 —— "挂了幕布"而不是"墙面发光"
    const frame = new THREE.Mesh(faceGeo(arc, SH + 0.16, R - 0.04), poly ? frameMatFlat : frameMat);
    placeFace(frame, a, true);
    scene.add(frame);
    const s = { src, mesh, mat, tex, videoEl, slot, arc, frame };
    /** 按当前 ar 重算幕面尺寸（元数据到位、或换厅形时调用） */
    function reshape() {
      const ar = src && src.ar ? src.ar : K.screen.defAr;
      const na = Math.min(s.slot, wArc(SH * ar * (src ? K.screen.maxWide : 1)));
      s.arc = na;
      s.mesh.geometry.dispose();
      s.mesh.geometry = faceGeo(na, SH, PR);
      s.frame.geometry.dispose();
      s.frame.geometry = faceGeo(na, SH + 0.16, R - 0.04);
      placeFace(s.mesh, a, PR);
      placeFace(s.frame, a, R - 0.04);
      if (src && src.ar) applyCover(s.tex, arcW(na) / SH, ar, !isPoly());
    }
    if (src) {
      if (src.stream) videoEl.srcObject = src.stream; // 屏幕共享：MediaStream 直进同一条 VideoTexture 流水线
      else videoEl.src = src.url;
      // 元数据到位 -> 记下真实宽高比，把幕面吃满槽位（上限 maxWide 倍）并按 cover 裁剪画面
      videoEl.addEventListener('loadedmetadata', () => {
        src.ar = (videoEl.videoWidth || 16) / (videoEl.videoHeight || 9);
        mat.map = tex;
        reshape();
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
        saveLayout(); // 宽高比一并存档，下次开机不用等元数据再重排
      });
    }
    return s;
  }

  /** 按当前片源列表重排一圈：屏数=源数，高度恒定，等分槽位吃到满；多边形厅边数=屏数 */
  function rebuild() {
    for (const s of screens) {
      scene.remove(s.mesh, s.frame);
      s.mesh.geometry.dispose();
      s.frame.geometry.dispose(); // frameMat 为共享材质，只释放几何
      s.mat.dispose();
      s.tex.dispose();
      s.videoEl.remove();
    }
    screens.length = 0;
    const n = Math.max(sources.length, 1);
    edges = shape === 'poly' ? Math.max(3, n) : 0; // 1~2 部片时多边形退化成三角形（其余边是空墙）
    applyShell();
    const slot = (Math.PI * 2) / (edges || n);
    for (let i = 0; i < n; i++) screens.push(makeScreen(sources[i] || null, slot * (i + 0.5), slot));
    syncVoices();
    applyAudio(); // 新建的 <video> 一律 muted，必须在这里按出声集合重新放行
    layoutBigGrid(document.body.classList.contains('big-screen'));
    renderConsole();
    saveLayout();
  }

  /* ================= 灯光（全部不投影：影院零闪烁） ================= */
  scene.add(new THREE.HemisphereLight(0x39414f, 0x0a0a0c, 0.55));
  // 顶心的柔光只打天花板与床沿，压得很低：影厅的黑是银幕亮起来的地方之外该有的黑
  const proj = new THREE.PointLight(0x9fb4d8, 2.6, 20, 1.8);
  proj.position.set(0, H - 0.7, 0);
  scene.add(proj);
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0x1a1207, emissive: 0xffb877, emissiveIntensity: 2.2 });
  // 天花凹槽灯带：一整圈暖光条，把「银幕上方的黑洞」变成有层次的顶棚（不投影，零闪烁风险）
  // 几何与摆位由 applyShell() 按厅形重建（圆筒=圆环，多边形=沿棱的折线带）
  const cove = new THREE.Mesh(new THREE.TorusGeometry(R - 0.42, 0.055, 8, 96), sconceMat);
  cove.rotation.x = Math.PI / 2;
  cove.position.y = H - 0.28;
  scene.add(cove);
  const SCONCE_DEG = [62, 118, 242, 298]; // 圆筒厅的暖光点方位（多边形厅改为沿墙心均分）
  const sconces = [];
  for (const deg of SCONCE_DEG) {
    const lp = new THREE.PointLight(0xff9a55, 2.0, 10, 1.9); // 灯带投出的暖光
    scene.add(lp);
    sconces.push(lp);
  }

  /* ================= 中央圆形小床（无围栏无靠背：环视零遮挡） ================= */
  const bed = new THREE.Group();
  bed.position.set(K.bed.x, 0, K.bed.z);
  {
    const B = K.bed;
    // 石墨色丝绒：sheen 给丝绒特有的柔光绒毛边；压暗是为了在黑厅里不糊成一片白
    const velvet = new THREE.MeshPhysicalMaterial({
      color: 0x3b3833, roughness: 0.9, metalness: 0,
      sheen: 1.0, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xb9a273),
    });
    const champagne = new THREE.MeshPhysicalMaterial({
      color: 0x8e7449, roughness: 0.72, metalness: 0.14,
      sheen: 1.0, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xffe9c0),
    });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.28, metalness: 0.9 });
    // 悬浮底座：比床垫小一圈 + 一道黄铜嵌线，视觉上像床浮在地毯上
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(B.r * 0.84, B.r * 0.74, 0.16, 56),
      new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.92 }));
    plinth.position.y = 0.08;
    bed.add(plinth);
    const inlay = new THREE.Mesh(new THREE.TorusGeometry(B.r * 0.84, 0.022, 8, 72), brass);
    inlay.rotation.x = Math.PI / 2;
    inlay.position.y = 0.165;
    bed.add(inlay);
    // 床垫：整块圆柱 + 一圈鼓起的滚边，边缘软过去才有高级感
    const mattress = new THREE.Mesh(new THREE.CylinderGeometry(B.r, B.r * 0.99, 0.36, 64), velvet);
    mattress.position.y = 0.34;
    bed.add(mattress);
    const piping = new THREE.Mesh(new THREE.TorusGeometry(B.r * 0.99, 0.15, 12, 64), velvet);
    piping.rotation.x = Math.PI / 2;
    piping.position.y = 0.52;
    bed.add(piping);
    // 床心一道黄铜细镶线（俯视才有层次，坐着完全不挡视线）
    const medallion = new THREE.Mesh(new THREE.TorusGeometry(B.r * 0.34, 0.014, 6, 64), brass);
    medallion.rotation.x = Math.PI / 2;
    medallion.position.y = 0.525;
    bed.add(medallion);
    // 一圈靠枕：压扁的球，均匀摆在半径 0.78 处（贴着外沿，中间留空）
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.3, 22, 14), i % 2 ? velvet : champagne);
      p.scale.set(1.35, 0.36, 1);
      p.position.set(Math.sin(a) * B.r * 0.78, 0.62, Math.cos(a) * B.r * 0.78);
      p.rotation.y = a;
      bed.add(p);
    }
  }
  scene.add(bed);
  const bedHit = bed.children[2]; // 床垫作为点击目标

  /* ================= 厅形切换（圆筒弧幕 / 正多边形直墙平面幕） =================
     厅里**没有门**：墙是一整圈闭合的黑匣子，整圈都能挂幕，回球场走放映条「🚪 退出影院」。
     多边形厅按「片数 = 边数」长：3 部三角形、4 部正方形、6 部六边形；1~2 部时退化成三角形，
     多出来的边就是空墙。内切半径固定为 ring.r，所以几种厅形下座位到幕的距离完全一样。 */
  function setShape(toPoly) {
    shape = toPoly ? 'poly' : 'round';
    try { localStorage.setItem(SHAPE_KEY, shape); } catch (e) { /* 存不了不影响放映 */ }
    rebuild(); // 边数/幕面类型/厅壳全变，整厅重排最省事
    renderShapeBtn();
    setStatus(shape === 'poly'
      ? `⬡ 多边形厅：${edges} 部片 = ${edges} 面直墙 · 幕距 ${AP.toFixed(1)}m · ${edges >= 5 ? '每面墙基本铺满' : '边少墙宽，幕居中挂一块'}`
      : '◯ 圆筒厅：环墙弧幕');
    sfx.play('ui', { volume: 0.4 });
  }
  function renderShapeBtn() {
    const b = $('cb-shape');
    if (!b) return;
    const poly = shape === 'poly';
    b.textContent = poly ? '⬡ 多边形厅' : '◯ 圆筒厅';
    b.classList.toggle('on', poly);
    b.title = poly ? '换回圆筒厅：环墙弧幕，任意片数都铺满一圈' : '改成正多边形厅：几部片就几条直墙（3 部三角形、4 部正方形、6 部六边形）';
  }

  /* ================= 片源列表与持久化 =================
     一条规则：环上有几块屏 = 列表里有几部片。「选择视频」支持多选，**这次选的就是全部
     片源**，旧片单整条替换掉；选几部就环绕放几部。列表按文件名 + 实测宽高比存 localStorage，
     下次开机自动复原；本地临时选的 blob 文件重开拿不到句柄，那个位置留成空洞（显示占位图）。 */
  const LIB = window.BB_VIDEOS || []; // video/manifest.js 内嵌片单
  const STORE_KEY = 'bb.cinema.screens';
  let sources = []; // (src|null)[]

  const $ = (id) => document.getElementById(id);
  const bar = $('cinema-bar');
  const status = $('cb-status');
  const playBtn = $('cb-play');

  function setStatus(t) { status.textContent = t; }

  function saveLayout() {
    try {
      const rec = [];
      for (const s of sources) {
        if (!s) { rec.push(null); continue; } // 空洞要留位（环上排布才复现得出来）
        if (s.shared) continue; // 屏幕共享是一次性的：重开拿不到流，连位置都不留
        rec.push({ n: s.name, k: s.local ? 1 : 0, a: s.ar ? +s.ar.toFixed(3) : undefined });
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(rec));
    } catch (e) { /* 无痕模式下存不了，不影响放映 */ }
  }

  const defaultSources = () => LIB.slice(0, K.maxScreens).map((it) => ({ name: it.name, url: it.url }));

  /** 释放一次性片源：本地文件要收回 blob URL，屏幕共享要把轨道停掉 */
  function disposeSource(src) {
    if (!src) return;
    if (src.local) { try { URL.revokeObjectURL(src.url); } catch (e) { /* noop */ } }
    if (src.shared) { try { src.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ } }
  }

  function loadSources() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { saved = []; }
    const list = (Array.isArray(saved) ? saved : []).slice(0, K.maxScreens).map((rec) => {
      const it = rec && rec.n ? LIB.find((x) => x.name === rec.n) : null;
      return it ? { name: it.name, url: it.url, ar: rec.a > 0 ? rec.a : 0 } : null;
    });
    return list.some(Boolean) ? list : defaultSources();
  }

  function refreshStatus() {
    const live = sources.filter(Boolean).length;
    const v = voices.size;
    setStatus(live
      ? `▶ ${live} 块 ${SH}m 高巨幕环绕 · 🔊 ${v} 路出声 · 🎛 控制台管片单 · 滚轮拉近拉远`
      : '还没有片源：把视频放进 video/，或在控制台里「📂 换片单」');
  }

  /* ================= 播放过的片单（快照历史）=================
     「开始播放」那一刻就记一份当次片源清单（含空洞位置，所以环上排布也一并复原），
     下次在控制台点一下就能整条换回任何一次。只有 video/ 常驻片能直接接回来；当时临时
     选的本地大文件重开拿不到句柄，恢复后那个位置是占位空洞，chip 上写明「几部需重选」。 */
  const HIST_KEY = 'bb.cinema.playlists';
  function loadPlaylists() {
    try {
      const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Array.isArray(a) ? a.filter((p) => p && Array.isArray(p.list)) : [];
    } catch (e) { return []; }
  }
  const fmtTime = (t) => {
    const d = new Date(t), p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  let playlists = loadPlaylists();
  function savePlaylists() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(playlists)); } catch (e) { /* 存不了不影响放映 */ }
  }
  const curVoices = () => screens.filter((s, i) => voices.has(i) && s.src).map((s) => s.src.name);
  /** 记一份当前清单：命中已有条目就把它提到最前（换回旧片单不该在历史里留副本），否则新增 */
  function snapshot() {
    const list = sources.map((s) => (s ? s.name : null));
    if (!list.some(Boolean)) return;
    const key = list.join('|');
    const at = playlists.findIndex((p) => p.list.join('|') === key);
    if (at >= 0) {
      const [p] = playlists.splice(at, 1);
      p.voices = curVoices();
      playlists.unshift(p);
    } else {
      playlists.unshift({ t: Date.now(), list, voices: curVoices() });
      playlists = playlists.slice(0, 6);
    }
    savePlaylists();
    renderPlaylists();
  }
  function restorePlaylist(p) {
    const old = sources;
    sources = p.list.slice(0, K.maxScreens).map((n) => {
      const it = n ? LIB.find((x) => x.name === n) : null;
      return it ? { name: it.name, url: it.url } : null;
    });
    old.forEach(disposeSource);
    voiceNames = (Array.isArray(p.voices) ? p.voices : []).slice(); // 连当时的多路出声一起换回
    rebuild();
    playAll();
    const holes = sources.filter((s) => !s).length;
    setStatus(`⏳ 已换回 ${fmtTime(p.t)} 那份片单：${sources.length} 块屏`
      + (holes ? `，其中 ${holes} 块当时是本地文件，需重新选一次文件` : ''));
  }
  function renderPlaylists() {
    const box = $('cc-hist');
    if (!box) return;
    box.textContent = '';
    // 只有一份时它就是正在放的这份，没有可恢复的历史，整行不占地方
    box.classList.toggle('hidden', playlists.length < 2);
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = '⏳ 播放过：';
    box.appendChild(lbl);
    playlists.forEach((p, k) => {
      const b = document.createElement('button');
      b.className = 'btn cc-chip' + (k === 0 ? ' on' : '');
      b.textContent = `${k === 0 ? '● ' : ''}${fmtTime(p.t)} · ${p.list.filter(Boolean).length}部`;
      b.title = `${p.list.filter(Boolean).join('、') || '（空）'}${k === 0 ? '（正在放这份）' : ' —— 点击整条换回'}`;
      b.addEventListener('click', () => restorePlaylist(p));
      box.appendChild(b);
    });
  }

  sources = loadSources();
  try {
    const v = localStorage.getItem('bb.cinema.vol');
    if (v !== null) $('cb-vol').value = v;
  } catch (e) { /* 无痕模式读不到就用默认值 */ }
  rebuild();
  refreshStatus();
  renderShapeBtn(); // 厅形按钮的文案/高亮要和存档一致

  function syncPlayBtn() {
    playBtn.textContent = screens.some((o) => o.src && !o.videoEl.paused) ? '⏸ 暂停' : '▶ 播放';
  }
  function playAll() {
    screens.forEach((s) => {
      if (!s.src) return;
      s.videoEl.play().catch(() => { /* 未交互动前可能被拦截 */ });
    });
    applyAudio();
    playBtn.textContent = '⏸ 暂停';
    snapshot(); // 「开始播放」这一刻记一份当次片源清单，供下次一键换回
  }
  function pauseAll() {
    screens.forEach((s) => s.videoEl.pause());
    playBtn.textContent = '▶ 播放';
  }

  /** 点屏幕 = 把这部片加进/移出"出声集合"（可以多部一起响），顺手把它播起来 */
  function tapScreen(i) {
    const s = screens[i];
    if (!s || !s.src) return;
    if (voices.has(i)) voices.delete(i);
    else {
      voices.add(i);
      if (s.videoEl.paused) s.videoEl.play().catch(() => {});
    }
    applyAudio();
    saveVoices();
    renderConsole();
    layoutBigGrid(document.body.classList.contains('big-screen'));
    setStatus(voices.has(i) ? `🔊 已加入出声：${s.src.name}` : `🔇 已消音：${s.src.name}`);
    syncPlayBtn();
  }

  /**
   * 放大观看：全部片源铺满屏幕的宫格，格数随屏数变（CSS 变量交给 style.css 排版）。
   * #big-wall 是同规格的格子层（格子按 DOM 顺序落位，天然与第 i 块片源对齐）：
   * 整格点一下＝该片加入/移出出声，出声的亮角标 🔊、不出声的压暗——只管"听哪个"，
   * 加片删片统一走控制台，不再在这儿摆一套重复的按钮。
   */
  function layoutBigGrid(on) {
    const wall = $('big-wall');
    wall.textContent = ''; // 重建前清空旧格子（含事件监听）
    if (!on) {
      wall.classList.add('hidden');
      for (const s of screens) {
        const vs = s.videoEl.style;
        ['--col', '--row', '--cols', '--rows'].forEach((p) => vs.removeProperty(p));
      }
      return;
    }
    const n = Math.max(screens.length, 1);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    wall.style.setProperty('--cols', String(cols));
    wall.style.setProperty('--rows', String(rows));
    screens.forEach((s, i) => {
      const vs = s.videoEl.style;
      vs.setProperty('--cols', String(cols));
      vs.setProperty('--rows', String(rows));
      vs.setProperty('--col', String(i % cols));
      vs.setProperty('--row', String(Math.floor(i / cols)));
    });
    screens.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'bwcell' + (voices.has(i) ? ' live' : '');
      const spk = document.createElement('span');
      spk.className = 'bwspk';
      spk.textContent = voices.has(i) ? '🔊' : '🔇';
      cell.appendChild(spk);
      const tag = document.createElement('span');
      tag.className = 'bwname';
      tag.textContent = s.src ? s.src.name : '（空位：控制台里加片）';
      cell.appendChild(tag);
      cell.title = s.src ? '点击切换这部片是否出声' : '这块还是空位';
      cell.addEventListener('click', () => tapScreen(i));
      wall.appendChild(cell);
    });
    wall.classList.remove('hidden');
  }

  /** 移除环上第 i 部片源：银幕、格子、控制台一起重排，并写回存档（空洞占位格同样可删） */
  function removeSource(i) {
    const [gone] = sources.splice(i, 1);
    disposeSource(gone);
    rebuild();
    const live = sources.filter(Boolean).length;
    setStatus(live ? `🗑 已移除 1 部，环上还有 ${live} 部巨幕` : '片单空了：控制台里点「＋ 加入视频」或「📂 换片单」');
    sfx.play('ui', { volume: 0.4 });
  }

  /** 总音量只作用于"出声集合"里的片；其余静音，所以多路同时放也不会糊成一团。
      注意：必须是函数声明（提升），init 里的第一次 rebuild() 就要调用它。 */
  function applyAudio() {
    const v = Number($('cb-vol').value);
    screens.forEach((s, i) => {
      const on = voices.has(i);
      s.videoEl.muted = !on;
      s.videoEl.volume = on ? v : 0;
    });
  }

  /* ================= 统一控制台：片源清单（多选出声 / 单部播停 / 删片） ================= */

  function renderConsole() {
    const list = $('cc-list');
    list.textContent = '';
    if (!screens.some((s) => s.src)) {
      const e = document.createElement('div');
      e.className = 'cc-empty';
      e.textContent = '片单是空的：下面「📂 换片单」整条替换，或「＋ 加入视频」追加。';
      list.appendChild(e);
      return;
    }
    screens.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'ccrow' + (voices.has(i) ? ' live' : '');
      const idx = document.createElement('span');
      idx.className = 'cc-idx';
      idx.textContent = String(i + 1);
      const nm = document.createElement('span');
      nm.className = 'cc-nm' + (s.src ? '' : ' hole');
      nm.textContent = s.src ? s.src.name : '空位（复原不了的本地片源）';
      nm.title = nm.textContent;
      row.append(idx, nm);
      if (s.src) {
        const spk = document.createElement('button');
        spk.className = 'btn cc-spk' + (voices.has(i) ? ' on' : '');
        spk.textContent = voices.has(i) ? '🔊' : '🔇';
        spk.title = voices.has(i) ? '移出出声' : '加入出声（可多部同时）';
        spk.addEventListener('click', () => tapScreen(i));
        const pp = document.createElement('button');
        pp.className = 'btn cc-pp';
        pp.textContent = s.videoEl.paused ? '▶' : '⏸';
        pp.title = '单独播/停这一部';
        pp.addEventListener('click', () => {
          if (s.videoEl.paused) s.videoEl.play().catch(() => {}); else s.videoEl.pause();
          renderConsole();
          syncPlayBtn();
        });
        const x = document.createElement('button');
        x.className = 'btn cc-kill';
        x.textContent = '✕';
        x.title = '从环上移除这部';
        x.addEventListener('click', () => removeSource(i));
        row.append(spk, pp, x);
      }
      list.appendChild(row);
    });
  }

  const consoleEl = $('cinema-console');
  function showConsole(v) {
    consoleEl.classList.toggle('hidden', !v);
    if (v) renderConsole();
    $('cb-console').classList.toggle('primary', v);
  }
  $('cb-console').addEventListener('click', () => showConsole(consoleEl.classList.contains('hidden')));
  $('cc-close').addEventListener('click', () => showConsole(false));
  let lastVoices = null; // 「🔇 静音」是可逆的：记下静音前的集合，再点还原
  $('cc-mute').addEventListener('click', () => {
    if (voices.size) { lastVoices = new Set(voices); voices.clear(); }
    else if (lastVoices) { voices = new Set(lastVoices); lastVoices = null; }
    applyAudio();
    saveVoices();
    renderConsole();
    layoutBigGrid(document.body.classList.contains('big-screen'));
    setStatus(voices.size ? `🔊 ${voices.size} 路出声` : '🔇 全部消音');
  });

  $('cb-play').addEventListener('click', () => {
    if (!sources.some(Boolean)) { refreshStatus(); return; }
    if (screens.some((s) => s.src && !s.videoEl.paused)) pauseAll(); else playAll();
    renderConsole();
  });
  $('cb-vol').addEventListener('input', () => {
    applyAudio();
    try { localStorage.setItem('bb.cinema.vol', $('cb-vol').value); } catch (e) { /* 同上 */ }
  });
  $('cc-add').addEventListener('click', () => $('cb-add-in').click());
  $('cb-big').addEventListener('click', () => {
    const on = !document.body.classList.contains('big-screen');
    document.body.classList.toggle('big-screen', on);
    layoutBigGrid(on);
    $('cb-big').textContent = on ? '⛶ 回到影厅视角' : '⛶ 放大观看';
  });
  $('cb-stand').addEventListener('click', () => stand());
  $('cb-exit').addEventListener('click', () => { if (api.onExitRequest) api.onExitRequest(); });
  $('cb-shape').addEventListener('click', () => setShape(shape === 'round'));
  $('cb-reset').addEventListener('click', () => {
    const old = sources;
    sources = defaultSources();
    old.forEach(disposeSource);
    voiceNames = null; // 换片单就把出声选择清回默认（第一部响）
    rebuild();
    playAll();
    refreshStatus();
  });
  $('cb-file').addEventListener('click', () => $('cb-file-in').click());
  $('cb-file-in').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    // 多选即全量替换：这一次选了几部，环上就放这几部，旧片单不再保留
    const old = sources;
    const over = Math.max(0, files.length - K.maxScreens);
    sources = files.slice(0, K.maxScreens).map((f) => ({ name: f.name, url: URL.createObjectURL(f), local: true }));
    old.forEach(disposeSource); // 旧本地片源的 blob URL 释放，防内存泄漏
    voiceNames = null;
    rebuild();
    playAll();
    setStatus(`🎬 ${sources.length} 部巨幕环绕中${over ? `（上限 ${K.maxScreens} 块屏，多出的 ${over} 部未导入）` : ''}`);
  });

  // 控制台的「＋ 加入视频」：这是**追加**（与「📂 换片单」的整条替换相对），加完立刻重排环；
  // 新加的片默认不出声，避免一追加就突然多一路音轨糊在原有那路上
  $('cb-add-in').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, K.maxScreens - sources.length);
    const take = files.slice(0, room);
    for (const f of take) sources.push({ name: f.name, url: URL.createObjectURL(f), local: true });
    rebuild();
    playAll();
    setStatus(take.length
      ? `➕ 追加 ${take.length} 部，环上共 ${sources.filter(Boolean).length} 部巨幕（新加的在控制台勾 🔊 才出声）`
        + (files.length - take.length ? `（已到 ${K.maxScreens} 块屏上限，${files.length - take.length} 部未导入）` : '')
      : `环上已满 ${K.maxScreens} 块屏，先在控制台里移走几部再加`);
  });

  /* ================= 📡 共享窗口：把屏幕上任意窗口/网页挂上一块幕 =================
     B 站直播间这类外部网页内容在 file:// 下没有第二条路：iframe 被 X-Frame-Options/CSP 挡、
     直链被 null origin 的 CORS 挡，而且跨域 <video> 必然污染 WebGL 贴图（SecurityError）。
     getDisplayMedia 拿到的 MediaStream 是用户亲手授权的，不跨域、不 taint，所以让播放器
     自己"看"那个窗口，画面照走 VideoTexture、声音照走 applyAudio 的多路出声。 */
  async function addShare() {
    const md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia) { setStatus('📡 这个浏览器不支持屏幕共享（用较新的 Chrome / Edge）'); return; }
    if (sources.length >= K.maxScreens) { setStatus(`环上已满 ${K.maxScreens} 块屏，先在控制台里 ✕ 掉一块再共享`); return; }
    let stream;
    try {
      stream = await md.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch (e1) {
      if (e1 && e1.name === 'NotAllowedError') { setStatus('📡 已取消：在浏览器弹窗里选一个窗口或标签页即可挂上幕'); return; }
      try { stream = await md.getDisplayMedia({ video: true }); } // 有些平台不支持采声，退成纯画面
      catch (e2) { setStatus(`📡 共享失败：${(e2 && e2.name) || e2}`); return; }
    }
    const src = { name: `📡 ${(stream.getVideoTracks()[0] || {}).label || '共享窗口'}`.trim(), stream, shared: true };
    // 用户在浏览器工具栏点「停止共享」→ 视频轨道 ended → 这块幕自动撤下来
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
      const at = sources.indexOf(src);
      if (at >= 0) removeSource(at);
    }));
    sources.push(src);
    voiceNames = curVoices().concat(src.name); // 新挂的直播默认让它响，否则看着没反应
    rebuild();
    playAll();
    setStatus(`📡 已挂上直播幕：${src.name}`
      + (stream.getAudioTracks().length ? ' · 含该窗口的声音' : ' · 该窗口未共享声音，只有画面'));
  }
  $('cb-share').addEventListener('click', () => { addShare(); });

  /* 控制条收起/唤回：观影时不想被按钮挡住，左下角留一个小钮（控制台一起收） */
  $('cb-hide').addEventListener('click', () => {
    bar.classList.add('hidden');
    showConsole(false);
    $('cb-ghost').classList.remove('hidden');
  });
  $('cb-ghost').addEventListener('click', () => {
    bar.classList.remove('hidden');
    $('cb-ghost').classList.add('hidden');
  });

  /* ================= 入座 / 走动 ================= */
  let seated = false;
  let hoverBed = false;
  let hoverScreen = -1;
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const hintEl = $('cinema-hint');

  const GYM_BOUNDS = {
    minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
    minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
  };
  const GYM_BLOCKERS = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }];
  // 圆筒/多边形共用同一份外层 AABB（applyShell 会按外接半径改字段），细节夹取在 update() 里做
  const BED_BLOCKER = [{ x: K.bed.x, z: K.bed.z, r: K.bed.r + 0.1 }];

  /* ---- 床上滚轮变焦：只调相机 fov，起身/回球场立刻复原 ---- */
  const fovBase = camera.fov;
  let zoomT = 0; // 0=默认视野 1=拉到最近
  function applyZoom() {
    camera.fov = fovBase - (fovBase - K.zoom.min) * zoomT;
    camera.updateProjectionMatrix();
  }

  let _lastHint = null;
  function setHint(t) {
    if (t === _lastHint) return; // 每帧射线都会调，脏检查避免逐帧写 DOM
    _lastHint = t;
    hintEl.innerHTML = t || '';
    hintEl.classList.toggle('hidden', !t);
  }

  /** 在床垫上就近入座（保持当前朝向，任意角度都能看） */
  function sit() {
    seated = true;
    const dx = player.pos.x - K.bed.x, dz = player.pos.z - K.bed.z;
    const d = Math.hypot(dx, dz) || 1;
    player.pos.set(K.bed.x + (dx / d) * K.bed.sitR, 0, K.bed.z + (dz / d) * K.bed.sitR);
    player.vel.set(0, 0, 0);
    player.bounds = {
      minX: player.pos.x - 0.05, maxX: player.pos.x + 0.05,
      minZ: player.pos.z - 0.05, maxZ: player.pos.z + 0.05,
    };
    player.blockers = [];
    player.eyeHeight = K.bed.eyeSit;
    player.speed = 0;
    // 落座即微微仰头：银幕带中心在上方约 15°，视线一进来就是画面而不是床面
    player.freePitch = K.bed.lookUp;
    player.targetPitch = K.bed.lookUp;
    player.pitch = K.bed.lookUp;
    bar.classList.remove('hidden');
    $('cb-ghost').classList.add('hidden');
    setHint('');
    document.exitPointerLock?.(); // 解锁后用鼠标点击放映条；转向走下方 drag 兜底
    playAll();
    sfx.play('ui', { volume: 0.4 });
  }
  function stand() {
    if (!seated) return;
    seated = false;
    zoomT = 0;
    applyZoom();
    player.bounds = ROOM_BOUNDS;
    player.blockers = BED_BLOCKER;
    player.eyeHeight = CFG.player.eye;
    player.speed = K.walkSpeed;
    bar.classList.add('hidden');
    showConsole(false); // 控制台是坐着用的界面，起身一起收掉
    $('cb-ghost').classList.add('hidden'); // 起身即复位「收起」状态，下次落座自然要能看到控制条
    if (document.body.classList.contains('big-screen')) {
      document.body.classList.remove('big-screen');
      layoutBigGrid(false);
      $('cb-big').textContent = '⛶ 放大观看';
    }
    canvasLock();
  }
  function canvasLock() {
    const c = document.getElementById('gl');
    try {
      const p = c.requestPointerLock?.();
      if (p && p.catch) p.catch(() => { /* 无手势/限流时忽略，点击画面可再锁 */ });
    } catch (e) { /* 旧浏览器同步抛错同样忽略 */ }
  }

  /* ================= 对外接口（api 命名：按钮回调里也要能拿到 onExitRequest） ================= */

  const api = {
    scene,
    get seated() { return seated; },
    get shape() { return shape; },
    get edges() { return edges; },
    onExitRequest: null,

    enter() {
      player.pos.set(0, 0, AP - 2.6); // 从球场进来，落在靠墙那一侧的槽位前（厅里没有门，墙是闭合的）
      player.vel.set(0, 0, 0);
      player.bounds = ROOM_BOUNDS;
      player.blockers = BED_BLOCKER;
      player.eyeHeight = CFG.player.eye;
      player.speed = K.walkSpeed;
      player.mode = 'free';
      player.exitShotAim();
      player.freeYaw = 0;           // 正对圆心，也就是正对环墙银幕
      player.freePitch = 0;
      zoomT = 0;
      applyZoom();
      canvasLock();                 // 走动状态锁指针（与球馆一致）
      if (!sources.some(Boolean)) { sources = loadSources(); rebuild(); refreshStatus(); }
      setHint('<b>左键</b> 点屏幕切换出声 · 靠近圆床 <b>左键</b> 入座 · 回球场点放映条 <b>🚪 退出影院</b>');
    },
    exit() {
      stand();
      pauseAll();
      player.bounds = GYM_BOUNDS;
      player.blockers = GYM_BLOCKERS;
      player.eyeHeight = CFG.player.eye;
      setHint('');
      bar.classList.add('hidden');
      $('cb-ghost').classList.add('hidden');
    },

    /** 每帧（main 在 playing 且 loc==='cinema' 时调用；player.update 之后） */
    update(dt) {
      if (seated) return;
      // 方形 AABB 兜不住圆/多边形，靠这一步把玩家夹回厅内：圆筒按半径，多边形按每条边的法线距离
      const lim = AP - 0.75;
      const px = player.pos.x - K.bed.x, pz = player.pos.z - K.bed.z;
      if (edges) {
        let k = 1;
        for (let e = 0; e < edges; e++) {
          const a = (e + 0.5) * ((Math.PI * 2) / edges);
          const d = px * Math.sin(a) + pz * Math.cos(a);
          if (d > 0.01) k = Math.min(k, lim / d);
        }
        if (k < 1) { player.pos.x = K.bed.x + px * k; player.pos.z = K.bed.z + pz * k; }
      } else {
        const d = Math.hypot(px, pz);
        if (d > lim) { player.pos.x = K.bed.x + px * (lim / d); player.pos.z = K.bed.z + pz * (lim / d); }
      }
      // 准星射线：圆床 + 环上所有幕（厅里没门，少一个目标也少一次"隐形物挡射线"的坑）
      raycaster.setFromCamera({ x: 0, y: 0 }, camera);
      const hits = raycaster.intersectObjects([bedHit, ...screens.map((s) => s.mesh)], false);
      const hit = hits.find((h) => h.distance < 24) || null;
      hoverBed = !!hit && hit.object === bedHit;
      hoverScreen = hit ? screens.findIndex((s) => s.mesh === hit.object) : -1;
      const dBed = Math.hypot(px, pz);
      const nearBed = hoverBed || dBed < K.bed.r + 0.6;
      setHint(nearBed ? '<b>左键</b> 在圆床上入座（任意朝向）'
        : hoverScreen >= 0 && screens[hoverScreen].src ? '<b>左键</b> 播放/暂停 · 切换该屏声音' : '');
    },

    onLeftDown() {
      if (seated) return;
      // 圆床：点击时实时测距（准星命中或站得够近都算），落到床垫环上入座
      const ray = raycaster.ray;
      const sph = new THREE.Sphere(new THREE.Vector3(K.bed.x, 0.4, K.bed.z), K.bed.r + 0.35);
      const onBed = ray.intersectsSphere(sph) ||
        Math.hypot(player.pos.x - K.bed.x, player.pos.z - K.bed.z) < K.bed.r + 0.6;
      if (onBed) { sit(); return; }
      if (hoverScreen >= 0) tapScreen(hoverScreen);
    },
    onRightDown() {
      if (seated) stand();
    },
    /** 床上滚轮：上滚拉近巨幕、下滚拉远（main 转发，仅入座时生效） */
    onWheel(deltaY) {
      if (!seated) return false;
      zoomT = Math.max(0, Math.min(1, zoomT - Math.sign(deltaY) * K.zoom.step));
      applyZoom();
      setHint('');
      return true;
    },
    /** 入座（未锁指针）时用鼠标位置点某块银幕：切该屏出声/暂停 */
    onClick(x, y) {
      const rect = document.getElementById('gl').getBoundingClientRect();
      _ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
      raycaster.setFromCamera(_ndc, camera);
      const hits = raycaster.intersectObjects(screens.map((s) => s.mesh), false);
      if (!hits.length) return;
      const i = screens.findIndex((s) => s.mesh === hits[0].object);
      if (i >= 0) tapScreen(i);
    },
    /** WASD 按下时 main 转发：坐着则起身（keydown 手势内可重新锁指针） */
    onMoveKey() {
      if (seated) stand();
    },
    /** 进入影院瞬间调用：确保环上排好了片源 */
    ensurePlaylist() {
      if (sources.some(Boolean)) return;
      sources = loadSources();
      rebuild();
      refreshStatus();
    },
    /** 无头验证用：当前厅壳形态（厅形 / 多边形边数 / 外接半径 / 走动 AABB） */
    debugHall() {
      return { shape, edges, ap: +AP.toFixed(2), rc: +(edges ? circumR(edges, AP) : R).toFixed(2), bound: +ROOM_BOUNDS.maxX.toFixed(2) };
    },
    /** 无头验证用：环上每块幕的几何（高度 / 槽位圆心角 / 实占圆心角 / 幕面实宽 / 宽高比 / 是否有片源）
     *  两种厅形都用「圆心角」表达，所以弧幕和直墙平面幕可以直接用同一组断言比。 */
    debugRing() {
      return screens.map((s, i) => ({
        h: SH,
        slotDeg: +(s.slot / DEG).toFixed(1),
        arcDeg: +(s.arc / DEG).toFixed(1),
        w: +arcW(s.arc).toFixed(2),
        ar: +(s.src?.ar ? s.src.ar.toFixed(2) : 0),
        src: s.src ? 1 : 0,
        voice: voices.has(i) ? 1 : 0,
      }));
    },
    stopVideo() { pauseAll(); },
    /** 无头验证用：已记录的片源清单快照（每部若干部 / 空洞数 / 出声路数） */
    debugLists() {
      return playlists.map((p) => ({
        n: p.list.filter(Boolean).length,
        holes: p.list.filter((x) => !x).length,
        v: (p.voices || []).length,
        names: p.list.map((x) => x || '-').join('>'),
      }));
    },
  };
  return api;
}
