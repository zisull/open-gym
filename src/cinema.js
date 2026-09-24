/**
 * cinema.js —— 电影院场景 + 银幕放映器
 * 独立 THREE.Scene：黑匣子影厅、4 排座椅（点击入座）、出口门（走回球馆）。
 * 银幕用 VideoTexture 播放视频；file:// 下本地相对路径视频会污染 WebGL 贴图，
 * 因此片源只允许 data:（video/manifest.js 内嵌短片）或 blob:（"选择视频"文件）两种同源形式。
 */
import * as THREE from 'three';
import { CFG } from './config.js';
import { makeDoorSignTexture, makeScreenPlaceholderTexture } from './textures.js';

const K = CFG.cinema;

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

  /* ================= 银幕（VideoTexture 载体） ================= */
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(K.screenW + 0.7, K.screenH + 0.55, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x04050a, roughness: 0.9 })
  );
  bezel.position.set(0, K.screenY, K.screenZ - 0.06);
  scene.add(bezel);

  const placeholderTex = makeScreenPlaceholderTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: placeholderTex, color: 0xb8c2d0 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(K.screenW, K.screenH), screenMat);
  screen.position.set(0, K.screenY, K.screenZ + 0.03);
  scene.add(screen);

  const videoEl = document.getElementById('btv');
  const videoTex = new THREE.VideoTexture(videoEl);
  videoTex.colorSpace = THREE.SRGBColorSpace;
  videoTex.minFilter = THREE.LinearFilter;
  videoTex.magFilter = THREE.LinearFilter;

  /* ================= 灯光（全部不投影：影院零闪烁） ================= */
  scene.add(new THREE.HemisphereLight(0x39414f, 0x0a0a0c, 0.55));
  const proj = new THREE.PointLight(0x9fb4d8, 6, 16, 1.6);
  proj.position.set(0, K.screenY, K.screenZ + 3.2);
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

  /* ================= 观众席（4 排 x 7 座，逐排升高） ================= */
  const seats = [];           // {mesh, x, z, y, row, col}
  const seatGeoC = new THREE.BoxGeometry(0.95, 0.5, 0.8);
  const seatGeoB = new THREE.BoxGeometry(0.95, 0.72, 0.16);
  const riserMat = new THREE.MeshStandardMaterial({ color: 0x20232c, roughness: 0.92 });
  const nosyMat = new THREE.MeshStandardMaterial({ color: 0x101218, roughness: 0.9 });
  K.rows.forEach((row, ri) => {
    if (row.y > 0) {
      const riser = new THREE.Mesh(new THREE.BoxGeometry(10.6, row.y, 2.3), ri >= 2 ? riserMat : nosyMat);
      riser.position.set(0, row.y / 2, row.z);
      scene.add(riser);
      // 台沿暖色导视条
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(10.6, 0.04, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x33200a, emissive: 0xffa050, emissiveIntensity: 1.2 })
      );
      strip.position.set(0, row.y + 0.02, row.z - 1.15);
      scene.add(strip);
    }
    for (let ci = 0; ci < K.cols; ci++) {
      const x = (ci - (K.cols - 1) / 2) * K.colSpacing;
      const mat = new THREE.MeshStandardMaterial({ color: 0x6b2430, roughness: 0.88, metalness: 0.02 });
      const cushion = new THREE.Mesh(seatGeoC, mat);
      cushion.position.set(x, row.y + 0.25, row.z + 0.15);
      scene.add(cushion);
      const back = new THREE.Mesh(seatGeoB, mat);
      back.position.set(x, row.y + 0.82, row.z - 0.42);
      back.rotation.x = 0.14;
      scene.add(back);
      seats.push({ mesh: cushion, mat, x, z: row.z, y: row.y, row: ri, col: ci });
    }
  });

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

  /* ================= 放映单（data:/blob: 同源片源） ================= */
  const playlist = (window.BB_VIDEOS || []).slice();
  let cur = -1;
  let bigMode = false;

  const $ = (id) => document.getElementById(id);
  const bar = $('cinema-bar');
  const sel = $('cb-list');
  const status = $('cb-status');
  const playBtn = $('cb-play');

  function refreshSelect() {
    sel.innerHTML = '';
    playlist.forEach((it, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = it.name;
      o.selected = i === cur;
      sel.appendChild(o);
    });
    sel.disabled = playlist.length === 0;
  }
  function setStatus(t) { status.textContent = t; }
  function loadIndex(i, autoplay) {
    if (!playlist.length) { setStatus('片单为空：放视频进 video/ 或点“选择视频”'); return; }
    cur = ((i % playlist.length) + playlist.length) % playlist.length;
    videoEl.src = playlist[cur].url;
    screenMat.map = videoTex;
    screenMat.color.setHex(0xffffff);
    screenMat.needsUpdate = true;
    refreshSelect();
    setStatus(`▶ ${playlist[cur].name}`);
    if (autoplay) play();
  }
  function play() {
    videoEl.play().then(() => { playBtn.textContent = '⏸ 暂停'; }).catch(() => setStatus('无法播放（格式不受浏览器支持？）'));
  }
  function pause() { videoEl.pause(); playBtn.textContent = '▶ 播放'; }
  videoEl.addEventListener('ended', () => loadIndex(cur + 1, true)); // 播完自动下一部

  $('cb-play').addEventListener('click', () => {
    if (!playlist.length) { setStatus('还没有片源'); return; }
    if (videoEl.paused) { if (cur < 0) loadIndex(0, true); else play(); } else pause();
  });
  $('cb-prev').addEventListener('click', () => loadIndex(cur - 1, !videoEl.paused));
  $('cb-next').addEventListener('click', () => loadIndex(cur + 1, !videoEl.paused));
  sel.addEventListener('change', () => loadIndex(Number(sel.value), true));
  $('cb-vol').addEventListener('input', (e) => { videoEl.volume = Number(e.target.value); });
  videoEl.volume = Number($('cb-vol').value || 0.9);
  $('cb-big').addEventListener('click', () => {
    bigMode = !bigMode;
    document.body.classList.toggle('big-screen', bigMode);
    $('cb-big').textContent = bigMode ? '⛶ 回到影厅视角' : '⛶ 放大观看';
  });
  $('cb-stand').addEventListener('click', () => stand());
  $('cb-file').addEventListener('click', () => $('cb-file-in').click());
  $('cb-file-in').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    files.forEach((f) => playlist.push({ name: f.name, url: URL.createObjectURL(f) }));
    loadIndex(playlist.length - files.length, true);
    e.target.value = '';
  });
  refreshSelect();

  /* ================= 入座 / 走动 ================= */
  let seated = null;
  let hoverSeat = null;
  let hoverExit = false;
  let hoverScreen = false;
  const raycaster = new THREE.Raycaster();
  const hintEl = $('cinema-hint');

  const GYM_BOUNDS = {
    minX: CFG.gym.playerMinX, maxX: CFG.gym.playerMaxX,
    minZ: CFG.gym.playerMinZ, maxZ: CFG.gym.playerMaxZ,
  };
  const GYM_BLOCKERS = [{ x: 0, z: CFG.hoop.boardFaceZ - 0.95, r: 0.9 }];
  const ROOM_BOUNDS = { minX: -K.halfW + 0.8, maxX: K.halfW - 0.55, minZ: -K.halfL + 1.1, maxZ: K.halfL - 0.75 };

  function setHint(t) {
    hintEl.innerHTML = t || '';
    hintEl.classList.toggle('hidden', !t);
  }

  function sit(seat) {
    seated = seat;
    player.pos.set(seat.x, 0, seat.z - 0.28);
    player.vel.set(0, 0, 0);
    player.bounds = { minX: seat.x - 0.05, maxX: seat.x + 0.05, minZ: seat.z - 0.33, maxZ: seat.z - 0.23 };
    player.blockers = [];
    player.eyeHeight = seat.y + K.eyeSit;
    player.speed = 0;
    // 目光投向银幕中心
    const dx = 0 - seat.x, dz = (K.screenZ + 0.03) - (seat.z - 0.28);
    player.freeYaw = Math.atan2(-dx, -dz);
    player.freePitch = Math.atan2(K.screenY - player.eyeHeight, Math.hypot(dx, dz));
    bar.classList.remove('hidden');
    setHint('');
    document.exitPointerLock?.();
    if (cur < 0 && playlist.length) loadIndex(0, false);
    sfx.play('ui', { volume: 0.4 });
  }
  function stand() {
    if (!seated) return;
    seated = null;
    player.bounds = ROOM_BOUNDS;
    player.blockers = [];
    player.eyeHeight = CFG.player.eye;
    player.speed = K.walkSpeed;
    bar.classList.add('hidden');
    if (bigMode) { bigMode = false; document.body.classList.remove('big-screen'); $('cb-big').textContent = '⛶ 放大观看'; }
    canvasLock();
  }
  function canvasLock() {
    const c = document.getElementById('gl');
    c.requestPointerLock?.();
  }

  /* ================= 对外接口 ================= */

  return {
    scene,
    get seated() { return !!seated; },
    onExitRequest: null,

    enter() {
      player.pos.set(K.exitDoor.x, 0, K.halfL - 2.6);
      player.vel.set(0, 0, 0);
      player.bounds = ROOM_BOUNDS;
      player.blockers = [];
      player.eyeHeight = CFG.player.eye;
      player.speed = K.walkSpeed;
      player.mode = 'free';
      player.exitShotAim();
      player.freeYaw = 0;           // 进门正对银幕
      player.freePitch = 0;
      setHint('走动选个座位：<b>左键</b> 点座入座 · 走向 <b>出口门</b> 回球场 · <b>ESC</b> 回主菜单');
    },
    exit() {
      stand();
      player.bounds = GYM_BOUNDS;
      player.blockers = GYM_BLOCKERS;
      player.eyeHeight = CFG.player.eye;
      setHint('');
      bar.classList.add('hidden');
    },

    /** 每帧（main 在 playing 且 loc==='cinema' 时调用；player.update 之后） */
    update(dt) {
      if (!seated) {
        // 准星射线：座位 / 出口门 / 银幕
        raycaster.setFromCamera({ x: 0, y: 0 }, camera);
        const hits = raycaster.intersectObjects([...seats.map((s) => s.mesh), exitHit, screen], false);
        const hit = hits.find((h) => h.distance < 9) || null;
        const newSeat = hit && seats.find((s) => s.mesh === hit.object) || null;
        hoverExit = !!hit && hit.object === exitHit;
        hoverScreen = !!hit && hit.object === screen;
        if (hoverSeat !== newSeat) {
          if (hoverSeat) hoverSeat.mat.emissive.setHex(0x000000);
          hoverSeat = newSeat;
          if (hoverSeat) hoverSeat.mat.emissive.setHex(0x3d141a);
        }
        const dExit = Math.hypot(player.pos.x - K.exitDoor.x, player.pos.z - K.exitDoor.z);
        if (dExit < K.exitDoor.r && this.onExitRequest) this.onExitRequest();
        setHint(hoverSeat ? '<b>左键</b> 入座' : hoverExit ? '<b>左键</b> 或走过去：返回篮球馆' : hoverScreen && playlist.length ? '<b>左键</b> 播放 / 暂停' : '');
      } else if (hoverSeat) {
        hoverSeat.mat.emissive.setHex(0x000000);
        hoverSeat = null;
      }
    },

    onLeftDown() {
      if (seated) return;
      if (hoverSeat) { sit(hoverSeat); return; }
      if (hoverExit) { if (this.onExitRequest) this.onExitRequest(); return; }
      if (hoverScreen && playlist.length) { videoEl.paused ? (cur < 0 ? loadIndex(0, true) : play()) : pause(); }
    },
    onRightDown() {
      if (seated) stand();
    },
    /** WASD 按下时 main 转发：坐着则起身（keydown 手势内可重新锁指针） */
    onMoveKey() {
      if (seated) stand();
    },
    /** 进入影院瞬间调用：确保有片单 */
    ensurePlaylist() { if (cur < 0 && playlist.length) loadIndex(0, false); },
    stopVideo() { videoEl.pause(); playBtn.textContent = '▶ 播放'; },
  };
}
