/**
 * cinema.js —— 电影院场景 + 圆筒环墙放映器
 * 独立 THREE.Scene：圆筒形黑匣子影厅，环墙都是银幕。**所有银幕同高**，每块的弧长
 * = 高 × 自己的宽高比（按 CylinderGeometry 取一截柱面），所以横屏占的圆心角大、竖屏占
 * 的小，但头顶脚底永远齐平；屏数 = 片源数（3 个就 3 块、5 个就 5 块），在剩下的圆弧上
 * 均匀分布。中央圆形大沙发，任意角度入座、按住拖拽环视。出口门走回球场。
 * file:// 下本地相对路径视频会污染 WebGL 贴图，因此片源只允许
 * data:（video/manifest.js 内嵌短片）或 blob:（"选择视频"文件）两种同源形式。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeDoorSignTexture, makeScreenPlaceholderTexture } from './textures.js';

const K = CFG.cinema;
const R = K.ring.r;
const H = K.ring.height;
const GAP = (K.door.gapDeg * Math.PI) / 180; // 门洞占的圆心角
const SPAN = Math.PI * 2 - GAP;              // 可用于排银幕的圆心角
const DEG = Math.PI / 180;
/** 环上某角度处的位置（约定同 CylinderGeometry：theta=0 在 +z，x=R·sin, z=R·cos） */
const ringAt = (a, r = R) => ({ x: Math.sin(a) * r, z: Math.cos(a) * r });

/** 创建离屏 <video>：必须保持渲染（opacity .01 而非 display:none）才会持续解码出帧 */
function makeVideoEl() {
  const v = document.createElement('video');
  v.className = 'btv';
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = true; // 单片循环播放
  v.muted = true; // 只有"焦点屏"出声，避免多路音轨叠加
  document.body.appendChild(v);
  return v;
}

export function createCinema({ camera, player, sfx }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070b);

  /* ================= 圆筒黑匣子（壁/顶/地三者不共面，从结构上杜绝闪烁） ========= */
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, H, 96, 1, true, GAP / 2, SPAN),
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
    new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 1, metalness: 0, envMapIntensity: 0.05 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.y = 0.01;
  scene.add(carpet);

  /* ================= 弧形银幕 ================= */
  const placeholderTex = makeScreenPlaceholderTexture();
  placeholderTex.repeat.x = -1; // 从筒内壁看是镜像的，横向翻回来
  placeholderTex.offset.x = 1;

  /** 截一柱面：半径 radius、高 h、圆心角 theta，中心已抬到屏心高度 */
  function patchGeo(radius, h, theta) {
    const seg = Math.max(8, Math.ceil(theta / 0.045));
    const g = new THREE.CylinderGeometry(radius, radius, h, seg, 1, true, -theta / 2, theta);
    g.translate(0, K.screen.cy, 0);
    return g;
  }

  const screens = []; // 与 sources 一一对应，rebuild() 重建
  let focus = 0;      // 当前出声屏索引

  /** 建一块屏：src 为 null 时是占位空洞（比如上次用本地文件放的，重开复原不了） */
  function makeScreen(src, a, slot, h) {
    const videoEl = makeVideoEl();
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.repeat.x = -1; // 同上：内壁观看要横向翻回正像
    tex.offset.x = 1;
    const mat = new THREE.MeshBasicMaterial({ map: placeholderTex, color: 0xb8c2d0, side: THREE.BackSide });
    // 初始先按 16:9 取弧（元数据到位后再按真实比例收窄）：只用槽位全宽的话，
    // 片源少的时候一块占位图能绕墙一整圈，很滑稽
    const mesh = new THREE.Mesh(patchGeo(R - 0.1, h, Math.min((h * (16 / 9)) / R, slot)), mat);
    mesh.rotation.y = a;
    scene.add(mesh);
    const s = { src, mesh, mat, tex, videoEl, slot, h };
    if (src) {
      videoEl.src = src.url;
      // 元数据到位 -> 弧长按自身宽高比收（高度不变），并揭开占位图
      videoEl.addEventListener('loadedmetadata', () => {
        const ar = (videoEl.videoWidth || 16) / (videoEl.videoHeight || 9);
        mesh.geometry.dispose();
        mesh.geometry = patchGeo(R - 0.1, h, Math.min((h * ar) / R, slot));
        mat.map = tex;
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
      });
    }
    return s;
  }

  /** 按当前片源列表重排圆环：屏数=源数，同高，弧上均匀分布 */
  function rebuild() {
    for (const s of screens) {
      scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mat.dispose();
      s.tex.dispose();
      s.videoEl.remove();
    }
    screens.length = 0;
    const n = Math.max(sources.length, 1);
    const slot = SPAN / n;
    // 高度按"最宽的 16:9 排在各自的槽里也不重叠"来定，竖屏只是两侧留些空隙
    const h = Math.min(K.screen.hMax, (slot * R) / (16 / 9));
    for (let i = 0; i < n; i++) screens.push(makeScreen(sources[i] || null, GAP / 2 + slot * (i + 0.5), slot, h));
    if (focus >= screens.length) focus = 0;
    // 新建的 <video> 音量要重新按滑块分配（只有焦点屏出声），否则多路音轨叠加
    const vv = Number($('cb-vol').value);
    screens.forEach((s, i) => { s.videoEl.volume = i === focus ? vv : 0; });
    layoutBigGrid(document.body.classList.contains('big-screen'));
    saveLayout();
  }

  /* ================= 灯光（全部不投影：影院零闪烁） ================= */
  scene.add(new THREE.HemisphereLight(0x39414f, 0x0a0a0c, 0.55));
  const proj = new THREE.PointLight(0x9fb4d8, 5, 22, 1.6);
  proj.position.set(0, K.screen.cy + 2.2, 0);
  scene.add(proj);
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0x2a1408, emissive: 0xff7a2f, emissiveIntensity: 1.6 });
  for (const deg of [62, 118, 242, 298]) {
    const a = deg * DEG;
    const p = ringAt(a, R - 0.14);
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.24), sconceMat);
    s.position.set(p.x, 3.1, p.z);
    s.rotation.y = a;
    scene.add(s);
    const l = ringAt(a, R - 0.5);
    const lp = new THREE.PointLight(0xff8844, 2.2, 9, 1.8);
    lp.position.set(l.x, 3.1, l.z);
    scene.add(lp);
  }

  /* ================= 中央圆形大沙发 ================= */
  const sofa = new THREE.Group();
  sofa.position.set(K.sofa.x, 0, K.sofa.z);
  {
    const S = K.sofa;
    const fabric = new THREE.MeshStandardMaterial({ color: 0x6b2430, roughness: 0.9, metalness: 0.02 });
    const fabricDark = new THREE.MeshStandardMaterial({ color: 0x571d28, roughness: 0.92 });
    // 座垫：扁圆柱
    const cushion = new THREE.Mesh(new THREE.CylinderGeometry(S.r, S.r * 0.96, 0.42, 40), fabric);
    cushion.position.y = 0.21;
    sofa.add(cushion);
    // 环形靠背：半圆截面的环（朝向随意，360° 都能靠）
    const back = new THREE.Mesh(new THREE.TorusGeometry(S.r - 0.28, 0.34, 12, 40), fabricDark);
    back.rotation.x = Math.PI / 2;
    back.position.y = 0.72;
    sofa.add(back);
    // 底座圈沿
    const base = new THREE.Mesh(new THREE.CylinderGeometry(S.r * 0.96, S.r * 0.9, 0.1, 40),
      new THREE.MeshStandardMaterial({ color: 0x1d1f26, roughness: 0.95 }));
    base.position.y = 0.05;
    sofa.add(base);
    // 中央小圆几
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.46, 0.4, 24),
      new THREE.MeshStandardMaterial({ color: 0x242733, roughness: 0.4, metalness: 0.3 }));
    table.position.y = 0.2;
    sofa.add(table);
  }
  scene.add(sofa);
  const sofaHit = sofa.children[0]; // 座垫作为点击目标

  /* ================= 出口门（开在 theta=0 的门洞里，走回球场） ================= */
  const exitGroup = new THREE.Group();
  exitGroup.position.set(0, 0, R - 0.06);
  exitGroup.rotation.y = Math.PI; // 门脸朝厅内
  {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 2.9, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x1c3524, roughness: 0.6, metalness: 0.3 })
    );
    frame.position.y = 1.45;
    exitGroup.add(frame);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 2.6, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x2c3440, roughness: 0.7 })
    );
    slab.position.set(0, 1.3, 0.04);
    exitGroup.add(slab);
    const signTex = makeDoorSignTexture('出 口', '→ 篮球馆');
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.48),
      new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 1.0 })
    );
    sign.position.set(0, 3.15, 0.1);
    exitGroup.add(sign);
  }
  scene.add(exitGroup);
  const exitHit = exitGroup.children[1]; // 门板本体作为点击目标

  /* ================= 片源列表与持久化 =================
     一条规则：环上有几块屏 = 列表里有几部片。「选择视频」支持多选，同名就地换、
     新名追加到环尾。列表按文件名存 localStorage，下次开机自动复原；本地临时选的
     blob 文件重开拿不到句柄，那个位置留成空洞（显示占位图），环的排布不变。 */
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
      localStorage.setItem(STORE_KEY, JSON.stringify(
        sources.map((s) => (s ? { n: s.name, k: s.local ? 1 : 0 } : null))
      ));
    } catch (e) { /* 无痕模式下存不了，不影响放映 */ }
  }

  const defaultSources = () => LIB.slice(0, K.maxScreens).map((it) => ({ name: it.name, url: it.url }));

  function loadSources() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { saved = []; }
    const list = (Array.isArray(saved) ? saved : []).slice(0, K.maxScreens)
      .map((rec) => (rec && rec.n ? LIB.find((x) => x.name === rec.n) || null : null));
    return list.some(Boolean) ? list : defaultSources();
  }

  function refreshStatus() {
    const live = sources.filter(Boolean).length;
    setStatus(live
      ? `▶ ${live} 块银幕同高环绕 · 点屏切声音 · 面朝任意方向点「选择视频」加片`
      : '还没有片源：把视频放进 video/ 或点「选择视频」');
  }

  sources = loadSources();
  try {
    const v = localStorage.getItem('bb.cinema.vol');
    if (v !== null) $('cb-vol').value = v;
  } catch (e) { /* 无痕模式读不到就用默认值 */ }
  rebuild();
  refreshStatus();

  function playAll() {
    screens.forEach((s, i) => {
      if (!s.src) return;
      s.videoEl.muted = i !== focus;
      s.videoEl.play().catch(() => { /* 未交互动前可能被拦截 */ });
    });
    applyVolume();
    playBtn.textContent = '⏸ 暂停';
  }
  function pauseAll() {
    screens.forEach((s) => s.videoEl.pause());
    playBtn.textContent = '▶ 播放';
  }

  /** 点屏幕：换出焦点（声音跟过去）并切换该屏播放/暂停 */
  function tapScreen(i) {
    const s = screens[i];
    if (!s || !s.src) return;
    focus = i;
    screens.forEach((o, j) => { o.videoEl.muted = j !== i; });
    setStatus(s.videoEl.paused ? `🔊 ${s.src.name}` : `⏸ ${s.src.name}`);
    if (s.videoEl.paused) s.videoEl.play().catch(() => {});
    playBtn.textContent = screens.some((o) => o.src && !o.videoEl.paused) ? '⏸ 暂停' : '▶ 播放';
  }

  /** 放大观看：全部片源铺满屏幕的宫格，格数随屏数变，用 CSS 变量交给 style.css 排版 */
  function layoutBigGrid(on) {
    const n = Math.max(screens.length, 1);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    screens.forEach((s, i) => {
      const st = s.videoEl.style;
      if (!on) { ['--col', '--row', '--cols', '--rows'].forEach((p) => st.removeProperty(p)); return; }
      st.setProperty('--cols', String(cols));
      st.setProperty('--rows', String(rows));
      st.setProperty('--col', String(i % cols));
      st.setProperty('--row', String(Math.floor(i / cols)));
    });
  }

  const applyVolume = () => {
    const v = Number($('cb-vol').value);
    screens.forEach((s, i) => { s.videoEl.volume = i === focus ? v : 0; });
  };

  $('cb-play').addEventListener('click', () => {
    if (!sources.some(Boolean)) { refreshStatus(); return; }
    if (screens.some((s) => s.src && !s.videoEl.paused)) pauseAll(); else playAll();
  });
  $('cb-vol').addEventListener('input', () => {
    applyVolume();
    try { localStorage.setItem('bb.cinema.vol', $('cb-vol').value); } catch (e) { /* 同上 */ }
  });
  $('cb-big').addEventListener('click', () => {
    const on = !document.body.classList.contains('big-screen');
    document.body.classList.toggle('big-screen', on);
    layoutBigGrid(on);
    $('cb-big').textContent = on ? '⛶ 回到影厅视角' : '⛶ 放大观看';
  });
  $('cb-stand').addEventListener('click', () => stand());
  $('cb-reset').addEventListener('click', () => {
    sources = defaultSources();
    focus = 0;
    rebuild();
    playAll();
    refreshStatus();
  });
  $('cb-file').addEventListener('click', () => $('cb-file-in').click());
  $('cb-file-in').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    let over = 0;
    for (const f of files) {
      const src = { name: f.name, url: URL.createObjectURL(f), local: true };
      const at = sources.findIndex((s) => s && s.name === f.name);
      if (at >= 0) sources[at] = src; // 同名 = 就地换掉那块屏
      else if (sources.length < K.maxScreens) sources.push(src);
      else over++;
    }
    rebuild();
    playAll();
    setStatus(`🎬 已导入 ${files.length} 部${over ? `，超出 ${K.maxScreens} 块屏上限忽略 ${over} 部` : ''}`);
  });

  /* ================= 入座 / 走动 ================= */
  let seated = false;
  let hoverSofa = false;
  let hoverExit = false;
  let hoverScreen = -1;
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const hintEl = $('cinema-hint');

  const GYM_BOUNDS = {
    minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
    minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
  };
  const GYM_BLOCKERS = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }];
  // 圆筒用方形 AABB 只能兜住内接正方形，所以再在 update() 里做一次径向夹取
  const ROOM_BOUNDS = { minX: -(R - 0.7), maxX: R - 0.7, minZ: -(R - 0.7), maxZ: R - 0.7 };
  const SOFA_BLOCKER = [{ x: K.sofa.x, z: K.sofa.z, r: K.sofa.r + 0.1 }];

  function setHint(t) {
    hintEl.innerHTML = t || '';
    hintEl.classList.toggle('hidden', !t);
  }

  /** 在座垫环上就近入座（保持当前朝向，任意角度都能看） */
  function sit() {
    seated = true;
    const dx = player.pos.x - K.sofa.x, dz = player.pos.z - K.sofa.z;
    const d = Math.hypot(dx, dz) || 1;
    player.pos.set(K.sofa.x + (dx / d) * K.sofa.sitR, 0, K.sofa.z + (dz / d) * K.sofa.sitR);
    player.vel.set(0, 0, 0);
    player.bounds = {
      minX: player.pos.x - 0.05, maxX: player.pos.x + 0.05,
      minZ: player.pos.z - 0.05, maxZ: player.pos.z + 0.05,
    };
    player.blockers = [];
    player.eyeHeight = K.sofa.eyeSit;
    player.speed = 0;
    bar.classList.remove('hidden');
    setHint('');
    document.exitPointerLock?.(); // 解锁后用鼠标点击放映条；转向走下方 drag 兜底
    playAll();
    sfx.play('ui', { volume: 0.4 });
  }
  function stand() {
    if (!seated) return;
    seated = false;
    player.bounds = ROOM_BOUNDS;
    player.blockers = SOFA_BLOCKER;
    player.eyeHeight = CFG.player.eye;
    player.speed = K.walkSpeed;
    bar.classList.add('hidden');
    if (document.body.classList.contains('big-screen')) {
      document.body.classList.remove('big-screen');
      layoutBigGrid(false);
      $('cb-big').textContent = '⛶ 放大观看';
    }
    canvasLock();
  }
  function canvasLock() {
    const c = document.getElementById('gl');
    c.requestPointerLock?.();
  }

  /* ================= 对外接口 ================= */

  return {
    scene,
    get seated() { return seated; },
    onExitRequest: null,

    enter() {
      player.pos.set(0, 0, R - 2.6); // 刚进门，站在出口门内侧
      player.vel.set(0, 0, 0);
      player.bounds = ROOM_BOUNDS;
      player.blockers = SOFA_BLOCKER;
      player.eyeHeight = CFG.player.eye;
      player.speed = K.walkSpeed;
      player.mode = 'free';
      player.exitShotAim();
      player.freeYaw = 0;           // 正对圆心，也就是正对环墙银幕
      player.freePitch = 0;
      canvasLock();                 // 走动状态锁指针（与球馆一致）
      if (!sources.some(Boolean)) { sources = loadSources(); rebuild(); refreshStatus(); }
      setHint('<b>左键</b> 点屏幕切换出声 · 站上沙发 <b>左键</b> 入座 · 走向 <b>出口门</b> 回球场');
    },
    exit() {
      stand();
      pauseAll();
      player.bounds = GYM_BOUNDS;
      player.blockers = GYM_BLOCKERS;
      player.eyeHeight = CFG.player.eye;
      setHint('');
      bar.classList.add('hidden');
    },

    /** 每帧（main 在 playing 且 loc==='cinema' 时调用；player.update 之后） */
    update(dt) {
      if (seated) return;
      // 径向夹取：方形 AABB 兜不住圆筒，靠这一步把玩家拉回半径内
      const rr = R - 0.75;
      const d = Math.hypot(player.pos.x - K.sofa.x, player.pos.z - K.sofa.z);
      if (d > rr) {
        const k = rr / d;
        player.pos.x = K.sofa.x + (player.pos.x - K.sofa.x) * k;
        player.pos.z = K.sofa.z + (player.pos.z - K.sofa.z) * k;
      }
      // 准星射线：沙发 / 出口门 / 环上所有银幕
      raycaster.setFromCamera({ x: 0, y: 0 }, camera);
      const targets = [sofaHit, exitHit, ...screens.map((s) => s.mesh)];
      const hits = raycaster.intersectObjects(targets, false);
      const hit = hits.find((h) => h.distance < 20) || null;
      hoverSofa = !!hit && hit.object === sofaHit;
      hoverExit = !!hit && hit.object === exitHit;
      hoverScreen = hit ? screens.findIndex((s) => s.mesh === hit.object) : -1;
      const dp = ringAt(0, R);
      if (Math.hypot(player.pos.x - dp.x, player.pos.z - dp.z) < K.door.trigR && this.onExitRequest) this.onExitRequest();
      const dSofa = Math.hypot(player.pos.x - K.sofa.x, player.pos.z - K.sofa.z);
      const nearSofa = hoverSofa || dSofa < K.sofa.r + 0.6;
      setHint(nearSofa ? '<b>左键</b> 在沙发上入座（任意朝向）'
        : hoverExit ? '<b>左键</b> 或走过去：返回篮球馆'
        : hoverScreen >= 0 && screens[hoverScreen].src ? '<b>左键</b> 播放/暂停 · 切换该屏声音' : '');
    },

    onLeftDown() {
      if (seated) return;
      // 沙发：点击时实时测距（准星命中或站得够近都算），落到座垫环上入座
      const ray = raycaster.ray;
      const sph = new THREE.Sphere(new THREE.Vector3(K.sofa.x, 0.4, K.sofa.z), K.sofa.r + 0.35);
      const onSofa = ray.intersectsSphere(sph) ||
        Math.hypot(player.pos.x - K.sofa.x, player.pos.z - K.sofa.z) < K.sofa.r + 0.6;
      if (onSofa) { sit(); return; }
      if (hoverExit) { if (this.onExitRequest) this.onExitRequest(); return; }
      if (hoverScreen >= 0) tapScreen(hoverScreen);
    },
    onRightDown() {
      if (seated) stand();
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
    /** 无头验证用：当前环上每块屏的几何（高度 / 槽位圆心角 / 中心角 / 是否有片源） */
    debugRing() {
      return screens.map((s) => ({
        h: +s.h.toFixed(2),
        slotDeg: +((s.slot / DEG) % 360).toFixed(1),
        arcDeg: +(((s.mesh.geometry.parameters?.thetaLength ?? 0) / DEG)).toFixed(1),
        src: s.src ? 1 : 0,
      }));
    },
    stopVideo() { pauseAll(); },
  };
}
