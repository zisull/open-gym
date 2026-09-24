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
  v.muted = true; // 建好先静音，由 applyAudio() 按"出声集合"逐路放行（可多部同时响）
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
    const v = voices.size;
    setStatus(live
      ? `▶ ${live} 块 ${SH}m 高巨幕环绕 · 🔊 ${v} 路出声 · 🎛 控制台管片单 · 滚轮拉近拉远`
      : '还没有片源：把视频放进 video/，或在控制台里「📂 换片单」');
  }

  sources = loadSources();
  try {
    const v = localStorage.getItem('bb.cinema.vol');
    if (v !== null) $('cb-vol').value = v;
  } catch (e) { /* 无痕模式读不到就用默认值 */ }
  rebuild();
  refreshStatus();

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
    sources.splice(i, 1);
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
  $('cb-reset').addEventListener('click', () => {
    sources = defaultSources();
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
    const over = Math.max(0, files.length - K.maxScreens);
    sources = files.slice(0, K.maxScreens).map((f) => ({ name: f.name, url: URL.createObjectURL(f), local: true }));
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
      return screens.map((s, i) => ({
        h: SH,
        slotDeg: +((s.slot / DEG) % 360).toFixed(1),
        arcDeg: +((s.arc / DEG)).toFixed(1),
        ar: +(s.src?.ar ? s.src.ar.toFixed(2) : 0),
        src: s.src ? 1 : 0,
        voice: voices.has(i) ? 1 : 0,
      }));
    },
    stopVideo() { pauseAll(); },
  };
}
