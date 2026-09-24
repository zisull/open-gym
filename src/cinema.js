/**
 * cinema.js —— 电影院场景 + 圆筒环墙放映器
 * 独立 THREE.Scene：圆筒形黑匣子影厅，环墙都是银幕。**全厅统一一个银幕高度（6.8m，近乎
 * 贴天花板）**，屏数 = 片源数（3 个就 3 块、5 个就 5 块），每块吃满自己的等分槽位弧（比自身
 * 宽高比略宽时按 cover 等比裁剪，不拉伸变形），所以片源一多就自动铺满一整圈。中央圆形小床
 * （无围栏，视线通透），任意角度入座、按住拖拽环视、滚轮变焦，控制条可一键收起。
 * 「放大观看」的大屏墙同时是片源管理器：每格右上角 ✕ 删片、末格 ＋ 加片（追加）。
 * 出口门走回球场。
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
  const SH = K.screen.h; // 全厅唯一的银幕高度：片多片少都不缩放
  const PR = R - 0.1;    // 银幕柱面半径（离墙留 10cm，避免与墙共面闪烁）
  const placeholderTex = makeScreenPlaceholderTexture();
  placeholderTex.repeat.x = -1; // 从筒内壁看是镜像的，横向翻回来
  placeholderTex.offset.x = 1;
  const PH_ARC = (SH * K.screen.defAr) / PR; // 占位图就按它自己的 16:9 取弧，永不拉伸

  /** 截一柱面：半径 radius、高 h、圆心角 theta，中心已抬到屏心高度 */
  function patchGeo(radius, h, theta) {
    const seg = Math.max(8, Math.ceil(theta / 0.045));
    const g = new THREE.CylinderGeometry(radius, radius, h, seg, 1, true, -theta / 2, theta);
    g.translate(0, K.screen.cy, 0);
    return g;
  }

  /** cover 适配：画面等比放大到铺满屏面，多出来的裁掉，所以永不拉伸变形。
   *  从筒内壁看贴图是左右反的，故水平方向用负的 repeat.x + 补 offset 翻回正像。 */
  function applyCover(tex, patchAr, srcAr) {
    if (patchAr >= srcAr) { // 屏比画面宽 -> 裁上下
      const f = srcAr / patchAr;
      tex.repeat.set(-1, f);
      tex.offset.set(1, (1 - f) / 2);
    } else {                // 画面比屏宽 -> 裁左右
      const f = patchAr / srcAr;
      tex.repeat.set(-f, 1);
      tex.offset.set((1 + f) / 2, 0);
    }
  }

  const screens = []; // 与 sources 一一对应，rebuild() 重建
  let focus = 0;      // 当前出声屏索引

  /** 建一块屏：src 为 null 时是永久占位空洞（比如上次用本地文件放的，重开复原不了） */
  function makeScreen(src, a, slot) {
    const videoEl = makeVideoEl();
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const arc = Math.min(slot, PH_ARC); // 元数据到位前先按占位图的比例挂上去
    const mat = new THREE.MeshBasicMaterial({ map: placeholderTex, color: 0xb8c2d0, side: THREE.BackSide });
    const mesh = new THREE.Mesh(patchGeo(PR, SH, arc), mat);
    mesh.rotation.y = a;
    scene.add(mesh);
    const s = { src, mesh, mat, tex, videoEl, slot, arc };
    if (src) {
      videoEl.src = src.url;
      // 元数据到位 -> 记下真实宽高比，把弧吃满槽位（上限 maxWide 倍）并按 cover 裁剪画面
      videoEl.addEventListener('loadedmetadata', () => {
        src.ar = (videoEl.videoWidth || 16) / (videoEl.videoHeight || 9);
        const na = Math.min(s.slot, ((SH * src.ar) / PR) * K.screen.maxWide);
        s.arc = na;
        mesh.geometry.dispose();
        mesh.geometry = patchGeo(PR, SH, na);
        applyCover(tex, (na * PR) / SH, src.ar);
        mat.map = tex;
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
        saveLayout(); // 宽高比一并存档，下次开机不用等元数据再重排
      });
    }
    return s;
  }

  /** 按当前片源列表重排圆环：屏数=源数，高度恒定，等分槽位吃到满 */
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
    for (let i = 0; i < n; i++) screens.push(makeScreen(sources[i] || null, GAP / 2 + slot * (i + 0.5), slot));
    if (focus >= screens.length) focus = 0;
    // 新建的 <video> 音量要重新按滑块分配（只有焦点屏出声），否则多路音轨叠加
    const vv = Number($('cb-vol').value);
    screens.forEach((s, i) => { s.videoEl.volume = i === focus ? vv : 0; });
    layoutBigGrid(document.body.classList.contains('big-screen'));
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
  const cove = new THREE.Mesh(new THREE.TorusGeometry(R - 0.42, 0.055, 8, 96), sconceMat);
  cove.rotation.x = Math.PI / 2;
  cove.position.y = H - 0.28;
  scene.add(cove);
  for (const deg of [62, 118, 242, 298]) {
    const l = ringAt(deg * DEG, R - 0.6);
    const lp = new THREE.PointLight(0xff9a55, 2.0, 10, 1.9); // 灯带投出的暖光，位置与灯带一致
    lp.position.set(l.x, H - 0.5, l.z);
    scene.add(lp);
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
      localStorage.setItem(STORE_KEY, JSON.stringify(
        sources.map((s) => (s ? { n: s.name, k: s.local ? 1 : 0, a: s.ar ? +s.ar.toFixed(3) : undefined } : null))
      ));
    } catch (e) { /* 无痕模式下存不了，不影响放映 */ }
  }

  const defaultSources = () => LIB.slice(0, K.maxScreens).map((it) => ({ name: it.name, url: it.url }));

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
    setStatus(live
      ? `▶ ${live} 块 ${SH}m 高巨幕环绕 · 点屏切声音 · 滚轮拉近拉远`
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

  /**
   * 放大观看：全部片源铺满屏幕的宫格，格数随屏数变（CSS 变量交给 style.css 排版）。
   * 同时在 #big-wall 上盖一层同规格的格子：每片一个「✕ 移除」，末格「＋ 加入视频」，
   * 于是这面墙既是放映墙也是片源管理器（格子按 DOM 顺序落位，天然与第 i 块片源对齐）。
   */
  function layoutBigGrid(on) {
    const wall = $('big-wall');
    wall.textContent = ''; // 重建前清空旧格子（含事件监听）
    const st = wall.style;
    if (!on) {
      wall.classList.add('hidden');
      for (const s of screens) {
        const vs = s.videoEl.style;
        ['--col', '--row', '--cols', '--rows'].forEach((p) => vs.removeProperty(p));
      }
      return;
    }
    const canAdd = sources.length < K.maxScreens;
    const total = screens.length + (canAdd ? 1 : 0);
    const cols = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / cols);
    st.setProperty('--cols', String(cols));
    st.setProperty('--rows', String(rows));
    screens.forEach((s, i) => {
      const vs = s.videoEl.style;
      vs.setProperty('--cols', String(cols));
      vs.setProperty('--rows', String(rows));
      vs.setProperty('--col', String(i % cols));
      vs.setProperty('--row', String(Math.floor(i / cols)));
    });
    screens.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'bwcell';
      if (s.src) {
        const tag = document.createElement('span');
        tag.className = 'bwname';
        tag.textContent = s.src.name;
        cell.appendChild(tag);
        const x = document.createElement('button');
        x.className = 'bwkill';
        x.textContent = '✕';
        x.title = `移除《${s.src.name}》，环上银幕一并收掉`;
        x.addEventListener('click', () => removeSource(i));
        cell.appendChild(x);
      }
      wall.appendChild(cell);
    });
    if (canAdd) {
      const add = document.createElement('button');
      add.className = 'bwadd';
      add.textContent = '＋ 加入视频';
      add.title = `追加到环上（上限 ${K.maxScreens} 块屏）`;
      add.addEventListener('click', () => $('cb-add-in').click());
      wall.appendChild(add);
    }
    wall.classList.remove('hidden');
  }

  /** 移除环上第 i 部片源：银幕与格子一起重排，并写回存档（空洞占位格同样可删） */
  function removeSource(i) {
    sources.splice(i, 1);
    if (focus >= sources.length) focus = 0;
    rebuild();
    const live = sources.filter(Boolean).length;
    setStatus(live ? `🗑 已移除 1 部，环上还有 ${live} 部巨幕` : '片单空了：点「＋ 加入视频」或「📂 选择视频」');
    sfx.play('ui', { volume: 0.4 });
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
    // 多选即全量替换：这一次选了几部，环上就放这几部，旧片单不再保留
    const over = Math.max(0, files.length - K.maxScreens);
    sources = files.slice(0, K.maxScreens).map((f) => ({ name: f.name, url: URL.createObjectURL(f), local: true }));
    focus = 0;
    rebuild();
    playAll();
    setStatus(`🎬 ${sources.length} 部巨幕环绕中${over ? `（上限 ${K.maxScreens} 块屏，多出的 ${over} 部未导入）` : ''}`);
  });

  // 大屏墙上的「＋ 加入视频」：这是**追加**（与「📂 选择视频」的整条替换相对），加完立刻重排环
  $('cb-add-in').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, K.maxScreens - sources.length);
    const take = files.slice(0, room);
    for (const f of take) sources.push({ name: f.name, url: URL.createObjectURL(f), local: true });
    focus = screens.length ? Math.min(focus, Math.max(sources.length - 1, 0)) : 0;
    rebuild();
    playAll();
    setStatus(take.length
      ? `➕ 追加 ${take.length} 部，环上共 ${sources.filter(Boolean).length} 部巨幕`
        + (files.length - take.length ? `（已到 ${K.maxScreens} 块屏上限，${files.length - take.length} 部未导入）` : '')
      : `环上已满 ${K.maxScreens} 块屏，先移走几部再加`);
  });

  /* 控制条收起/唤回：观影时不想被按钮挡住，左下角留一个小钮 */
  $('cb-hide').addEventListener('click', () => {
    bar.classList.add('hidden');
    $('cb-ghost').classList.remove('hidden');
  });
  $('cb-ghost').addEventListener('click', () => {
    bar.classList.remove('hidden');
    $('cb-ghost').classList.add('hidden');
  });

  /* ================= 入座 / 走动 ================= */
  let seated = false;
  let hoverBed = false;
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
  const BED_BLOCKER = [{ x: K.bed.x, z: K.bed.z, r: K.bed.r + 0.1 }];

  /* ---- 床上滚轮变焦：只调相机 fov，起身/回球场立刻复原 ---- */
  const fovBase = camera.fov;
  let zoomT = 0; // 0=默认视野 1=拉到最近
  function applyZoom() {
    camera.fov = fovBase - (fovBase - K.zoom.min) * zoomT;
    camera.updateProjectionMatrix();
  }

  function setHint(t) {
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
      setHint('<b>左键</b> 点屏幕切换出声 · 靠近圆床 <b>左键</b> 入座 · 走向 <b>出口门</b> 回球场');
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
      // 径向夹取：方形 AABB 兜不住圆筒，靠这一步把玩家拉回半径内
      const rr = R - 0.75;
      const d = Math.hypot(player.pos.x - K.bed.x, player.pos.z - K.bed.z);
      if (d > rr) {
        const k = rr / d;
        player.pos.x = K.bed.x + (player.pos.x - K.bed.x) * k;
        player.pos.z = K.bed.z + (player.pos.z - K.bed.z) * k;
      }
      // 准星射线：圆床 / 出口门 / 环上所有银幕
      raycaster.setFromCamera({ x: 0, y: 0 }, camera);
      const targets = [bedHit, exitHit, ...screens.map((s) => s.mesh)];
      const hits = raycaster.intersectObjects(targets, false);
      const hit = hits.find((h) => h.distance < 20) || null;
      hoverBed = !!hit && hit.object === bedHit;
      hoverExit = !!hit && hit.object === exitHit;
      hoverScreen = hit ? screens.findIndex((s) => s.mesh === hit.object) : -1;
      const dp = ringAt(0, R);
      if (Math.hypot(player.pos.x - dp.x, player.pos.z - dp.z) < K.door.trigR && this.onExitRequest) this.onExitRequest();
      const dBed = Math.hypot(player.pos.x - K.bed.x, player.pos.z - K.bed.z);
      const nearBed = hoverBed || dBed < K.bed.r + 0.6;
      setHint(nearBed ? '<b>左键</b> 在圆床上入座（任意朝向）'
        : hoverExit ? '<b>左键</b> 或走过去：返回篮球馆'
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
      if (hoverExit) { if (this.onExitRequest) this.onExitRequest(); return; }
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
    /** 无头验证用：当前环上每块屏的几何（高度 / 槽位圆心角 / 实占弧 / 宽高比 / 是否有片源） */
    debugRing() {
      return screens.map((s) => ({
        h: SH,
        slotDeg: +((s.slot / DEG) % 360).toFixed(1),
        arcDeg: +((s.arc / DEG)).toFixed(1),
        ar: +(s.src?.ar ? s.src.ar.toFixed(2) : 0),
        src: s.src ? 1 : 0,
      }));
    },
    stopVideo() { pauseAll(); },
  };
}
