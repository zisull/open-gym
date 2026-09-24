/**
 * cinema.js —— 电影院场景 + 四面墙放映器
 * 独立 THREE.Scene：黑匣子影厅，四面墙各一块大银幕，同时循环播放片单前 4 个视频
 * （按各自宽高比取框内最大矩形）；中央圆形大沙发，任意角度入座、鼠标自由转向。
 * 出口门走回球场。
 * file:// 下本地相对路径视频会污染 WebGL 贴图，因此片源只允许
 * data:（video/manifest.js 内嵌短片）或 blob:（"选择视频"文件）两种同源形式。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeDoorSignTexture, makeScreenPlaceholderTexture } from './textures.js';

const K = CFG.cinema;

/** 创建离屏 <video>：必须保持渲染（opacity .01 而非 display:none）才会持续解码出帧 */
function makeVideoEl(main) {
  const v = document.createElement('video');
  v.className = 'btv';
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = true; // 单片循环播放
  v.muted = !main; // 只有"焦点屏"出声，避免四路音轨叠加
  v.dataset.main = main ? '1' : '0';
  document.body.appendChild(v);
  return v;
}

export function createCinema({ camera, player, sfx }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070b);

  /* ================= 黑匣子外壳 ================= */
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.95, metalness: 0, side: THREE.BackSide, envMapIntensity: 0.1 });
  const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(K.halfW * 2, K.height, K.halfL * 2),
    [shellMat, shellMat, shellMat, hiddenMat, shellMat, shellMat]); // 底面挖掉，避免与地毯共面
  shell.position.y = K.height / 2;
  scene.add(shell);

  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(K.halfW * 2, K.halfL * 2),
    new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 1, metalness: 0, envMapIntensity: 0.05 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.y = 0.01;
  scene.add(carpet);

  /* ================= 四面墙银幕（每墙：黑色背板 + 视频面） ================= */
  const placeholderTex = makeScreenPlaceholderTexture();
  const WALL_ROT = { '-z': 0, '+z': Math.PI, '-x': Math.PI / 2, '+x': -Math.PI / 2 };
  const WALL_POS = {
    '-z': [0, 0, -K.halfL + 0.06],
    '+z': [0, 0, K.halfL - 0.06],
    '-x': [-K.halfW + 0.06, 0, 0],
    '+x': [K.halfW - 0.06, 0, 0],
  };

  const screens = K.screens.map((sc, i) => {
    const g = new THREE.Group();
    const [bx, , bz] = WALL_POS[sc.wall];
    g.position.set(bx + (sc.cx || 0), 0, bz);
    g.rotation.y = WALL_ROT[sc.wall];
    // 背板（比画面大一圈的黑色边框，遮住墙缝），尺寸始终跟着画面收放
    const bezel = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x04050a, roughness: 0.9 })
    );
    bezel.position.set(0, sc.cy, -0.03);
    g.add(bezel);
    // 画面：初始为占位图，尺寸随视频元数据加载后按宽高比重排
    const mat = new THREE.MeshBasicMaterial({ map: placeholderTex, color: 0xb8c2d0 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.position.set(0, sc.cy, 0.03);
    g.add(plane);
    scene.add(g);

    /** 把"画面 + 背板"整体收成某个宽高比在墙框内的最大矩形 */
    const fitRect = (ar) => {
      let w = sc.maxW, h = w / ar;
      if (h > sc.maxH) { h = sc.maxH; w = h * ar; }
      plane.geometry.dispose();
      plane.geometry = new THREE.PlaneGeometry(w, h);
      bezel.geometry.dispose();
      bezel.geometry = new THREE.PlaneGeometry(w + 0.8, h + 0.7);
    };
    fitRect(16 / 9); // 占位图先按 16:9 铺满墙框

    const videoEl = makeVideoEl(i === 0);
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    // 视频元数据到位 -> 画面按自身比例取最大矩形，边框跟着收放，
    // 免得竖屏片两边挂着一大块空黑框、看着像"屏幕没开满"
    videoEl.addEventListener('loadedmetadata', () => {
      fitRect((videoEl.videoWidth || 16) / (videoEl.videoHeight || 9));
      mat.map = tex;
      mat.color.setHex(0xffffff);
      mat.needsUpdate = true;
    });
    return { def: sc, group: g, plane, mat, videoEl, tex, fit: fitRect, src: null, srcUrl: '' };
  });

  /* ================= 灯光（全部不投影：影院零闪烁） ================= */
  scene.add(new THREE.HemisphereLight(0x39414f, 0x0a0a0c, 0.55));
  const proj = new THREE.PointLight(0x9fb4d8, 5, 16, 1.6);
  proj.position.set(0, K.screens[0].cy + 1.2, -K.halfL + 3.4);
  scene.add(proj);
  const sconceMat = new THREE.MeshStandardMaterial({ color: 0x2a1408, emissive: 0xff7a2f, emissiveIntensity: 1.6 });
  for (const sx of [-1, 1]) {
    for (const sz of [-3.5, 1.5]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.24), sconceMat);
      s.position.set(sx * (K.halfW - 0.08), 3.1, sz);
      scene.add(s);
      const p = new THREE.PointLight(0xff8844, 2.2, 8, 1.8);
      p.position.set(sx * (K.halfW - 0.4), 3.1, sz);
      scene.add(p);
    }
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

  /* ================= 出口门（+z 墙，走回球场） ================= */
  const exitGroup = new THREE.Group();
  exitGroup.position.set(K.exitDoor.x, 0, K.halfL - 0.06);
  exitGroup.rotation.y = Math.PI;
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

  /* ================= 四面墙片源 =================
     默认把 video/ 片单的前 4 部分给四面墙；之后只有一条规则：
     「选择视频」= 把*当前朝向*那块屏换成选中的文件。每块屏放的是哪部按文件名
     存进 localStorage，下次开机自动复原（本地临时选的大文件不在片单里，复原不了，
     想常驻就把它放进 video/ 再跑一次 gen_videos.bat）。 */
  const LIB = window.BB_VIDEOS || []; // video/manifest.js 内嵌片单
  const STORE_KEY = 'bb.cinema.screens';
  const WALL_CN = { front: '前', back: '后', left: '左', right: '右' };
  let focus = 0; // 当前出声屏索引
  let pickTarget = -1; // 「选择视频」按下那一刻锁定的目标屏

  const $ = (id) => document.getElementById(id);
  const bar = $('cinema-bar');
  const status = $('cb-status');
  const playBtn = $('cb-play');

  function setStatus(t) { status.textContent = t; }

  const loadSaved = () => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  };
  function saveLayout() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(
        screens.map((s) => (s.src ? { n: s.src.name, k: s.src.local ? 1 : 0 } : null))
      ));
    } catch (e) { /* 无痕模式下存不了，不影响放映 */ }
  }

  /** 给某块屏换片源；传 null 则清空回占位图 */
  function setSrc(s, src) {
    s.src = src || null;
    if (!src) {
      s.videoEl.removeAttribute('src');
      s.srcUrl = '';
      s.fit(16 / 9); // 空位回到 16:9 满框占位，别留上一个人的比例
      s.mat.map = placeholderTex;
      s.mat.color.setHex(0xb8c2d0);
      s.mat.needsUpdate = true;
      return;
    }
    if (s.srcUrl !== src.url) { s.videoEl.src = src.url; s.srcUrl = src.url; }
  }

  /** 按存档复原每块屏：名字还在片单里就回到原位，剩下的空位顺次补默认片源 */
  function applyLayout(saved) {
    const byName = new Map(LIB.map((it) => [it.name, it]));
    const taken = new Set();
    const fixed = screens.map((s, i) => {
      const it = saved[i] && saved[i].n && byName.get(saved[i].n);
      if (it) { taken.add(it.name); return it; }
      return null;
    });
    screens.forEach((s, i) => {
      setSrc(s, fixed[i] || LIB.find((x) => !taken.has(x.name)) || null);
      if (s.src) taken.add(s.src.name);
    });
    saveLayout();
  }
  applyLayout(loadSaved());
  setStatus(screens.some((s) => s.src)
    ? `▶ ${screens.filter((s) => s.src).length} 面墙放映中 · 面朝哪面墙点「选择视频」就换那块屏`
    : '还没有片源：把视频放进 video/ 或面朝银幕点「选择视频」');

  function playAll() {
    screens.forEach((s, i) => {
      if (!s.src) return;
      s.videoEl.muted = i !== focus;
      s.videoEl.play().catch(() => { /* 未交互动前可能被拦截 */ });
    });
    playBtn.textContent = '⏸ 暂停';
  }
  function pauseAll() {
    screens.forEach((s) => s.videoEl.pause());
    playBtn.textContent = '▶ 播放';
  }

  /** 点屏幕：换出焦点（声音跟过去）并切换该屏播放/暂停 */
  function tapScreen(i) {
    const s = screens[i];
    if (!s.src) return;
    focus = i;
    screens.forEach((o, j) => { o.videoEl.muted = j !== i; });
    if (s.videoEl.paused) { s.videoEl.play().catch(() => {}); setStatus(`🔊 ${s.src.name}`); }
    else setStatus(`⏸ ${s.src.name}`);
    playBtn.textContent = screens.some((o) => o.src && !o.videoEl.paused) ? '⏸ 暂停' : '▶ 播放';
  }

  /** 当前朝向（也就是「选择视频」要替换）的那块屏 */
  const _fwd = new THREE.Vector3();
  const _nrm = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _ndc = new THREE.Vector2();
  function facingScreen() {
    if (!seated && hoverScreen >= 0) return hoverScreen; // 准星已经指着某块屏
    camera.getWorldDirection(_fwd);
    let best = 0, bd = -2;
    screens.forEach((s, i) => {
      s.group.getWorldQuaternion(_q);
      _nrm.set(0, 0, 1).applyQuaternion(_q);
      const d = -_nrm.dot(_fwd); // 墙面法线与视线越反向越是在看这面墙
      if (d > bd) { bd = d; best = i; }
    });
    return best;
  }

  $('cb-play').addEventListener('click', () => {
    if (screens.every((s) => !s.src)) { setStatus('还没有片源：把视频放进 video/ 或点「选择视频」'); return; }
    if (screens.some((s) => s.src && !s.videoEl.paused)) pauseAll(); else playAll();
  });
  $('cb-vol').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    screens.forEach((s, i) => { s.videoEl.volume = i === focus ? v : 0; });
    try { localStorage.setItem('bb.cinema.vol', String(v)); } catch (e2) { /* 同上 */ }
  });
  try { const v = localStorage.getItem('bb.cinema.vol'); if (v !== null) $('cb-vol').value = v; } catch (e) { /* 同上 */ }
  screens[0].videoEl.volume = Number($('cb-vol').value || 0.9);
  $('cb-big').addEventListener('click', () => {
    document.body.classList.toggle('big-screen');
    $('cb-big').textContent = document.body.classList.contains('big-screen') ? '⛶ 回到影厅视角' : '⛶ 放大观看';
  });
  $('cb-stand').addEventListener('click', () => stand());
  $('cb-file').addEventListener('click', () => {
    pickTarget = facingScreen(); // 点按钮那一刻定住目标屏，之后文件框里选谁都只换这一块
    $('cb-file-in').click();
  });
  $('cb-file-in').addEventListener('change', (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f || pickTarget < 0) return;
    const s = screens[pickTarget];
    setSrc(s, { name: f.name, url: URL.createObjectURL(f), local: true });
    focus = pickTarget;
    saveLayout();
    playAll();
    setStatus(`🎬 ${WALL_CN[s.def.id]}墙银幕 → ${f.name}`);
  });

  /* ================= 入座 / 走动 ================= */
  let seated = false;
  let hoverSofa = false;
  let hoverExit = false;
  let hoverScreen = -1;
  const raycaster = new THREE.Raycaster();
  const hintEl = $('cinema-hint');

  const GYM_BOUNDS = {
    minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
    minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
  };
  const GYM_BLOCKERS = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }];
  const ROOM_BOUNDS = { minX: -K.halfW + 0.8, maxX: K.halfW - 0.55, minZ: -K.halfL + 1.1, maxZ: K.halfL - 0.75 };
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
      player.pos.set(K.exitDoor.x, 0, K.halfL - 2.6);
      player.vel.set(0, 0, 0);
      player.bounds = ROOM_BOUNDS;
      player.blockers = SOFA_BLOCKER;
      player.eyeHeight = CFG.player.eye;
      player.speed = K.walkSpeed;
      player.mode = 'free';
      player.exitShotAim();
      player.freeYaw = 0;           // 进门正对前墙银幕
      player.freePitch = 0;
      canvasLock();                // 走动状态锁指针（与球馆一致）
      if (screens.every((s) => !s.src)) applyLayout(loadSaved());
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
      if (!seated) {
        // 准星射线：沙发 / 出口门 / 四块银幕
        raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        const targets = [sofaHit, exitHit, ...screens.map((s) => s.plane)];
        const hits = raycaster.intersectObjects(targets, false);
        const hit = hits.find((h) => h.distance < 14) || null;
        hoverSofa = !!hit && hit.object === sofaHit;
        hoverExit = !!hit && hit.object === exitHit;
        hoverScreen = hit ? screens.findIndex((s) => s.plane === hit.object) : -1;
        const dExit = Math.hypot(player.pos.x - K.exitDoor.x, player.pos.z - K.exitDoor.z);
        if (dExit < K.exitDoor.r && this.onExitRequest) this.onExitRequest();
        const dSofa = Math.hypot(player.pos.x - K.sofa.x, player.pos.z - K.sofa.z);
        const nearSofa = hoverSofa || dSofa < K.sofa.r + 0.6;
        setHint(nearSofa ? '<b>左键</b> 在沙发上入座（任意朝向）'
          : hoverExit ? '<b>左键</b> 或走过去：返回篮球馆'
          : hoverScreen >= 0 && screens[hoverScreen].src ? '<b>左键</b> 播放/暂停 · 切换该屏声音' : '');
      }
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
      const hits = raycaster.intersectObjects(screens.map((s) => s.plane), false);
      if (!hits.length) return;
      const i = screens.findIndex((s) => s.plane === hits[0].object);
      if (i >= 0) tapScreen(i);
    },
    /** WASD 按下时 main 转发：坐着则起身（keydown 手势内可重新锁指针） */
    onMoveKey() {
      if (seated) stand();
    },
    /** 进入影院瞬间调用：确保每块屏都排好了片源 */
    ensurePlaylist() { if (screens.every((s) => !s.src)) applyLayout(loadSaved()); },
    stopVideo() { pauseAll(); },
  };
}
