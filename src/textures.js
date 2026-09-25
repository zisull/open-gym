/**
 * textures.js —— 程序化贴图生成
 * 全部使用 Canvas 在运行时绘制，无外部图片依赖，天然离线可用。
 */
import * as THREE from 'three';
import { CFG } from './config.js';

/** 伪随机（固定种子，保证每次刷新画面一致） */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 高度图 -> 切线空间法线图（Sobel）。输入灰度 canvas，输出 THREE.CanvasTexture。
 * strength 越大凹凸越明显；wrap/repeat 由调用方设置。
 */
function heightToNormal(heightCanvas, strength = 2) {
  const W = heightCanvas.width, H = heightCanvas.height;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(W, H);
  const h = (x, y) => src[(((y + H) % H) * W + ((x + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const gy = (h(x, y + 1) - h(x, y - 1)) * strength; // canvas y 向下 = UV v 向下，直接用
      const len = Math.hypot(gx, gy, 1);
      const i = (y * W + x) * 4;
      out.data[i] = ((-gx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-gy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

/**
 * 球馆地面一体贴图：橡胶地垫 + 木地板 + 全部标线（中线/中圈/三秒区/罚球圈/三分弧/限制区）。
 * 覆盖整个球馆（含场外缓冲区），地板 Mesh 只用这一张、一个平面——
 * 从此不存在"两个共面 Mesh 来回闪"的 z-fighting。
 * 画布 80 像素/米，x、z 等比，圆就是正圆。
 */
export function makeCourtTexture() {
  const PPM = 80;
  const G = CFG.gym, C = CFG.court;
  const W = Math.round(G.halfW * 2 * PPM);
  const H = Math.round(G.halfL * 2 * PPM);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(20260924);
  const cx = (x) => (x + G.halfW) * PPM;   // 世界 x -> 像素
  const cz = (z) => (z + G.halfL) * PPM;   // 世界 z -> 像素（与画布 y 同向）
  const pm = (m) => m * PPM;               // 米 -> 像素

  /* ================= 场外：深色橡胶地垫 ================= */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2b3038');
  bg.addColorStop(0.5, '#272b32');
  bg.addColorStop(1, '#22262d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // 地垫颗粒噪点
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.014)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  // 地垫拼缝（每 2m）
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 2;
  for (let gx = -G.halfW + 2; gx < G.halfW; gx += 2) {
    ctx.beginPath(); ctx.moveTo(cx(gx), 0); ctx.lineTo(cx(gx), H); ctx.stroke();
  }
  for (let gz = -G.halfL + 2; gz < G.halfL; gz += 2) {
    ctx.beginPath(); ctx.moveTo(0, cz(gz)); ctx.lineTo(W, cz(gz)); ctx.stroke();
  }

  /* ================= 场内：木地板 ================= */
  const x0 = cx(-C.halfW), x1 = cx(C.halfW), z0 = cz(-C.halfL), z1 = cz(C.halfL);
  const cw = x1 - x0, ch = z1 - z0;
  const grad = ctx.createLinearGradient(0, z0, 0, z1);
  grad.addColorStop(0, '#c98a45');
  grad.addColorStop(0.5, '#d69a55');
  grad.addColorStop(1, '#c68541');
  ctx.fillStyle = grad;
  ctx.fillRect(x0, z0, cw, ch);

  // 木板条纹（沿长度方向铺设）
  const plankH = 14;
  for (let y = z0; y < z1; y += plankH) {
    const shade = 0.86 + rnd() * 0.24;
    ctx.fillStyle = `rgba(${Math.round(178 * shade)}, ${Math.round(118 * shade)}, ${Math.round(58 * shade)}, 0.5)`;
    ctx.fillRect(x0, y, cw, plankH - 1.5);
    // 木纹细线
    ctx.strokeStyle = `rgba(120, 70, 25, ${0.05 + rnd() * 0.08})`;
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      ctx.beginPath();
      const gy = y + rnd() * plankH;
      ctx.moveTo(x0, gy);
      for (let px = x0; px < x1; px += 64) ctx.lineTo(px, gy + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    // 板缝随机断开
    if (rnd() < 0.35) {
      ctx.fillStyle = 'rgba(90, 55, 20, 0.35)';
      ctx.fillRect(x0 + rnd() * cw, y, 2, plankH);
    }
  }

  // 高光缎面感（沿场长的宽光带）
  const sheen = ctx.createLinearGradient(0, z0 + ch * 0.3, 0, z0 + ch * 0.55);
  sheen.addColorStop(0, 'rgba(255,240,210,0)');
  sheen.addColorStop(0.5, 'rgba(255,240,210,0.10)');
  sheen.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x0, z0, cw, ch);

  // 场地与地垫的交界缝
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x0, z0, cw, ch);

  /* ================= 标线 ================= */
  const { halfW, halfL } = C;
  const sy = (z) => cz(z);
  const su = (m) => pm(m);
  const sv = (m) => pm(m);
  const ell = (x, y, r, a0, a1, ccw) => ctx.ellipse(x, y, su(r), sv(r), 0, a0, a1, ccw);

  ctx.strokeStyle = '#f5f1e8';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;

  // 球场边线 + 端线
  ctx.strokeRect(x0 + 3, z0 + 3, cw - 6, ch - 6);
  // 中线
  ctx.beginPath();
  ctx.moveTo(W / 2, z0); ctx.lineTo(W / 2, z1);
  ctx.stroke();
  // 中圈 + 圆心
  ctx.beginPath();
  ell(W / 2, H / 2, 1.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(245,241,232,0.9)';
  ctx.beginPath();
  ell(W / 2, H / 2, 0.25, 0, Math.PI * 2);
  ctx.fill();

  // ---- 两端禁区（近端 sign=-1 为可玩篮筐）----
  function paintEnd(sign) {
    ctx.save();
    ctx.strokeStyle = '#f5f1e8';
    ctx.lineWidth = 5;
    const endZ = sign * halfL;                        // 该端端线 z
    const faceZ = endZ - sign * 1.2;                  // 篮板面 z（向场内 1.2m）
    const rimFloorZ = faceZ - sign * CFG.hoop.rimOffset; // 圈心地面投影 z
    const ftZ = endZ - sign * 5.8;                    // 罚球线 z
    const cxp = W / 2;

    // 禁区（三秒区）：宽 4.9m，端线伸到罚球线
    const keyW = su(4.9 / 2);
    const yEnd = sy(endZ), yFt = sy(ftZ);
    ctx.strokeRect(cxp - keyW, Math.min(yEnd, yFt), keyW * 2, Math.abs(yFt - yEnd));
    ctx.fillStyle = 'rgba(70, 110, 160, 0.16)';
    ctx.fillRect(cxp - keyW, Math.min(yEnd, yFt), keyW * 2, Math.abs(yFt - yEnd));

    // 罚球圈
    ctx.beginPath();
    ell(cxp, yFt, 1.8, 0, Math.PI * 2);
    ctx.stroke();

    // 合理冲撞区半圆（圈心投影为心，半径 1.25m，开口朝端线）
    ctx.beginPath();
    if (sign < 0) ell(cxp, sy(rimFloorZ), 1.25, 0, Math.PI, false);
    else ell(cxp, sy(rimFloorZ), 1.25, Math.PI, Math.PI * 2, false);
    ctx.stroke();

    // 三分弧：以圈心投影为心，半径 6.75m，两侧直线段沿边线内 0.9m 接到端线
    const cornerX = su(halfW - 0.9);                  // 角线距中线的像素距离
    const r3px = su(CFG.shot.zoneRadius);
    const ac = Math.acos(Math.min(1, cornerX / r3px)); // 弧与角线交点的参数角
    const dy = sv(CFG.shot.zoneRadius) * Math.sin(ac);  // 交点距圈心的像素纵向距离
    const czp = sy(rimFloorZ);
    ctx.beginPath();
    if (sign < 0) {
      // 近筐：弧朝场内（+y）鼓出
      ctx.moveTo(cxp - cornerX, yEnd);
      ctx.lineTo(cxp - cornerX, czp + dy);
      ell(cxp, czp, CFG.shot.zoneRadius, Math.PI - ac, ac, true);
      ctx.lineTo(cxp + cornerX, yEnd);
    } else {
      // 远筐：弧朝场内（-y）鼓出
      ctx.moveTo(cxp - cornerX, yEnd);
      ctx.lineTo(cxp - cornerX, czp - dy);
      ell(cxp, czp, CFG.shot.zoneRadius, Math.PI + ac, Math.PI * 2 - ac, false);
      ctx.lineTo(cxp + cornerX, yEnd);
    }
    ctx.stroke();
    ctx.restore();
  }
  paintEnd(-1); // 进攻端（可玩篮筐，-z）
  paintEnd(1);  // 另一端纯装饰

  // 端线外赞助区文字（橡胶地垫带上）
  ctx.fillStyle = 'rgba(235,235,235,0.42)';
  ctx.font = `bold 90px 'Segoe UI', system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('FIRST-TOUCH HOOPS', W / 2, cz(G.halfL - 1.1));
  ctx.fillText('STREET  ·  GYM  ·  3D', W / 2, cz(-G.halfL + 1.6));

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16; // 斜视角地板抗摩尔纹（three 会自动钳制到驱动上限）
  return tex;
}

/**
 * 地板粗糙度贴图（半分辨率 40px/m）：场内漆木地板低粗糙带木纹变化、
 * 标线漆面更光；场外橡胶地垫高粗糙。与 color 贴图共用一套 UV。
 */
export function makeCourtRoughness() {
  const PPM = 40;
  const G = CFG.gym, C = CFG.court;
  const W = Math.round(G.halfW * 2 * PPM);
  const H = Math.round(G.halfL * 2 * PPM);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(90210);
  const x0 = (-C.halfW + G.halfW) * PPM, x1 = (C.halfW + G.halfW) * PPM;
  const z0 = (-C.halfL + G.halfL) * PPM, z1 = (C.halfL + G.halfL) * PPM;

  // 场外橡胶：粗糙基底
  ctx.fillStyle = 'rgb(215,215,215)';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const v = 200 + rnd() * 40;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }

  // 场内木地板：低粗糙 + 木纹条带变化
  for (let y = z0; y < z1; y += 6) { // 6px ≈ 15cm 条带，与木板条纹呼应
    const v = 86 + rnd() * 34;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x0, y, x1 - x0, 6);
  }
  // 中场圈/禁区微光泽差异（淡淡一块，肉眼是"打蜡不匀"的真实感）
  const sheen = ctx.createRadialGradient(W / 2, H / 2, 8, W / 2, H / 2, PPM * 4);
  sheen.addColorStop(0, 'rgba(60,60,60,0.35)');
  sheen.addColorStop(1, 'rgba(60,60,60,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x0, z0, x1 - x0, z1 - z0);

  // 标线漆面更光：整条描一遍亮灰（在色图描线之后无法对齐细节，用同参数重画主线）
  ctx.strokeStyle = 'rgb(66,66,66)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x0 + 1.5, z0 + 1.5, x1 - x0 - 3, z1 - z0 - 3);
  ctx.beginPath(); ctx.moveTo(W / 2, z0); ctx.lineTo(W / 2, z1); ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  return tex;
}

/** 地板法线贴图：木板缝凹槽 + 板面微噪（半分辨率）。 */
export function makeCourtNormal() {
  const PPM = 40;
  const G = CFG.gym, C = CFG.court;
  const W = Math.round(G.halfW * 2 * PPM);
  const H = Math.round(G.halfL * 2 * PPM);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(31415);

  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, W, H);
  // 场外橡胶拼缝（每 2m）+ 颗粒
  ctx.strokeStyle = 'rgb(96,96,96)';
  ctx.lineWidth = 1;
  for (let gx = -G.halfW + 2; gx < G.halfW; gx += 2) {
    ctx.beginPath(); ctx.moveTo((gx + G.halfW) * PPM, 0); ctx.lineTo((gx + G.halfW) * PPM, H); ctx.stroke();
  }
  for (let gz = -G.halfL + 2; gz < G.halfL; gz += 2) {
    ctx.beginPath(); ctx.moveTo(0, (gz + G.halfL) * PPM); ctx.lineTo(W, (gz + G.halfL) * PPM); ctx.stroke();
  }
  const x0 = (-C.halfW + G.halfW) * PPM, x1 = (C.halfW + G.halfW) * PPM;
  const z0 = (-C.halfL + G.halfL) * PPM, z1 = (C.halfL + G.halfL) * PPM;
  // 木板缝（凹槽，随断缝错位）
  for (let y = z0; y < z1; y += 7) {
    ctx.fillStyle = 'rgb(92,92,92)';
    ctx.fillRect(x0, y, x1 - x0, 1.2);
    if (rnd() < 0.4) ctx.fillRect(x0 + rnd() * (x1 - x0), y, 1.6, 7); // 端向断缝
  }
  // 板面微噪（很轻，贴近看有肌理）
  for (let i = 0; i < 5200; i++) {
    const v = 120 + rnd() * 16;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x0 + rnd() * (x1 - x0), z0 + rnd() * (z1 - z0), 1.4, 1.4);
  }
  const tex = heightToNormal(cv, 2.2);
  tex.anisotropy = 8;
  return tex;
}

/** 墙面吸音板法线贴图：竖向分格凹槽（与色图的 64px 分格对齐）。 */
export function makeWallNormal() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 64) {
    // 左侧凸棱高光面 + 右侧暗缝（凹）
    ctx.fillStyle = 'rgb(150,150,150)';
    ctx.fillRect(x + 2, 0, 5, H);
    ctx.fillStyle = 'rgb(96,96,96)';
    ctx.fillRect(x + 58, 0, 5, H);
  }
  // 板面横向微凹（吸音棉压痕）
  for (let y = 0; y < H; y += 96) {
    ctx.fillStyle = 'rgb(122,122,122)';
    ctx.fillRect(0, y, W, 2);
  }
  const tex = heightToNormal(cv, 1.6);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 篮球粗糙度贴图：筋沟与麻点更哑光，皮面打蜡区更亮。 */
export function makeBallRoughness() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(777);

  ctx.fillStyle = 'rgb(140,140,140)'; // 皮面基准（0.55）
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 4200; i++) { // 麻点略粗糙
    const v = 150 + rnd() * 50;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
  }
  ctx.strokeStyle = 'rgb(205,205,205)'; // 筋沟：皮革接缝，最哑光
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.25, S / 2, S * 0.34, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.75, S / 2, S * 0.34, Math.PI / 2, -Math.PI / 2); ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

/** 影院地毯贴图：深色绒面 + 织物织纹 + 噪点（比纯色更耐看）。 */
export function makeCarpetTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(60411);

  const g = ctx.createRadialGradient(S / 2, S / 2, 40, S / 2, S / 2, S * 0.72);
  g.addColorStop(0, '#211d26');
  g.addColorStop(1, '#16141c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // 织物织纹：细十字网
  ctx.strokeStyle = 'rgba(255,255,255,0.022)';
  ctx.lineWidth = 1;
  for (let i = 0; i < S; i += 4) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
  }
  // 绒毛噪点
  for (let i = 0; i < 7000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(200,190,220,0.028)' : 'rgba(0,0,0,0.06)';
    ctx.fillRect(rnd() * S, rnd() * S, 1.3, 1.3);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 篮球贴图：橙色底 + 黑色筋沟 + 颗粒麻点 */
export function makeBallTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(777);

  ctx.fillStyle = '#d0651b';
  ctx.fillRect(0, 0, S, S);
  // 橘色渐变斑驳
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${190 + rnd() * 45}, ${88 + rnd() * 26}, ${20 + rnd() * 18}, ${rnd() * 0.16})`;
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, 2 + rnd() * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  // 麻点颗粒
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgba(60, 25, 8, ${0.05 + rnd() * 0.1})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
  }
  // 筋沟：1 条竖线 + 1 条横线 + 2 条侧弧（UV 展开近似）
  ctx.strokeStyle = '#241207';
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.25, S / 2, S * 0.34, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.75, S / 2, S * 0.34, Math.PI / 2, -Math.PI / 2); ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 球馆墙面吸音板贴图：深色分格竖板 + 顶部管线带 + 细微噪点 */
export function makeWallTexture() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(5150);

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3b4757');
  g.addColorStop(0.5, '#333e4c');
  g.addColorStop(1, '#2a323e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 竖向吸音板分格（每 64px 一块：左侧高光 + 右侧暗缝）
  for (let x = 0; x < W; x += 64) {
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(x + 2, 0, 3, H);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x + 60, 0, 4, H);
    // 每块板表面轻微明差
    ctx.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},0.02)`;
    ctx.fillRect(x, 0, 64, H);
  }
  // 顶部管线带 + 篮球主题腰线
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, 42);
  ctx.fillStyle = 'rgba(255,122,47,0.20)';
  ctx.fillRect(0, 42, W, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 47, W, 2);
  // 细微噪点
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},0.018)`;
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 篮球颗粒凸起贴图（bumpMap）：麻点凹坑 + 筋沟深缝 */
export function makeBallBumpTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(777);

  ctx.fillStyle = '#b4b4b4';       // 中性基面
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) { // 麻点：深色=凹坑
    const v = 60 + rnd() * 90;
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, 0.8 + rnd() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#1c1c1c';     // 筋沟：最深
  ctx.lineWidth = 11;
  ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.25, S / 2, S * 0.34, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(S * 0.75, S / 2, S * 0.34, Math.PI / 2, -Math.PI / 2); ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  return tex;
}

/** 门牌贴图：暗底 + 金色字，Bloom 提亮。bg 可换底色（默认影院暗红，台球室用墨绿） */
export function makeDoorSignTexture(text, sub, bg) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, bg ? bg[0] : '#3d0f14');
  g.addColorStop(1, bg ? bg[1] : '#1e0a0d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = 'rgba(255,190,90,0.85)';
  ctx.lineWidth = 5;
  ctx.strokeRect(9, 9, 494, 110);
  ctx.fillStyle = '#ffcf7a';
  ctx.font = `bold 58px 'Microsoft YaHei', system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, sub ? 48 : 64);
  if (sub) {
    ctx.font = `24px 'Microsoft YaHei', system-ui`;
    ctx.fillStyle = 'rgba(255,207,122,0.75)';
    ctx.fillText(sub, 256, 94);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 影院银幕占位图：黑色底 + 使用说明（尚未加载视频时显示） */
export function makeScreenPlaceholderTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 576;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(512, 288, 60, 512, 288, 640);
  g.addColorStop(0, '#161b26');
  g.addColorStop(1, '#05070c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 576);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8fa3c8';
  ctx.font = `bold 44px 'Microsoft YaHei', system-ui`;
  ctx.fillText('银 幕 放 映 厅', 512, 190);
  ctx.fillStyle = '#5f6f8c';
  ctx.font = `28px 'Microsoft YaHei', system-ui`;
  ctx.fillText('① 把视频文件放进 video/ 文件夹', 512, 280);
  ctx.fillText('② 双击 tools/gen_videos.bat 生成放映清单', 512, 326);
  ctx.fillText('≤25MB 短片自动进放映单；大文件走「＋ 添加视频」', 512, 392);
  ctx.fillStyle = '#39445a';
  ctx.font = `24px 'Microsoft YaHei', system-ui`;
  ctx.fillText('「控制台」里可指定哪几部出声（多部一起响）、加片删片', 512, 448);
  ctx.fillText('MP4 · WebM · MOV · M4V · Ogg（以浏览器可解码为准）', 512, 486);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 台球桌呢绒：**整张台面（含库边下方）一张贴图，不重复**。
 * 开球线、袋口、库边投影全部画进图里 —— 台面上只有一个不透明 Mesh，
 * 不再叠任何第二个共面对象，从根上没有 z-fighting。
 * len/wid 为台面总尺寸（库外沿），pad 为库宽，pockets 为六个袋心（台面坐标，长轴 x）。
 */
export function makeFeltTexture(len, wid, pad, pockets) {
  const PPM = 400;
  const W = Math.round(len * PPM), H = Math.round(wid * PPM);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(20260925);
  // 台面坐标 -> 画布像素（画布 +x/+y 与台面的 +x/+z 同向，见 pool.js 里的 UV 推导）
  const X = (x) => (x / len + 0.5) * W;
  const Z = (z) => (z / wid + 0.5) * H;
  const S = (m) => m * PPM;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#17573c');
  g.addColorStop(0.5, '#1d6b49');
  g.addColorStop(1, '#17573c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 绒毛斜纹：顺毛/逆毛方向的反光差是台呢最好认的特征
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * W, y = rnd() * H;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.020)' : 'rgba(0,0,0,0.050)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 3.2, y + 2.2); ctx.stroke();
  }
  // 库边压在呢绒上的投影：沿打区四边一圈内阴影（比再叠一个面片干净得多）
  const pl = X(-len / 2 + pad), pr = X(len / 2 - pad);
  const pt = Z(-wid / 2 + pad), pb = Z(wid / 2 - pad);
  for (let i = 8; i > 0; i--) {
    ctx.strokeStyle = `rgba(0,0,0,${0.035 * (9 - i)})`;
    ctx.lineWidth = S(0.012);
    ctx.strokeRect(pl + (i * S(0.012)) / 2, pt + (i * S(0.012)) / 2,
      pr - pl - i * S(0.012), pb - pt - i * S(0.012));
  }
  // 中央吊灯照出来的一圈亮带
  const lamp = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, W * 0.5);
  lamp.addColorStop(0, 'rgba(255,246,214,0.12)');
  lamp.addColorStop(1, 'rgba(255,246,214,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, W, H);
  // 开球线（head string）+ 开球点 / 摆球点：都在打区长度的 1/4 处
  const hx = (len / 2 - pad) / 2;
  ctx.strokeStyle = 'rgba(235,245,240,0.20)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(-hx), pt); ctx.lineTo(X(-hx), pb); ctx.stroke();
  for (const fx of [-hx, hx]) {
    ctx.fillStyle = 'rgba(240,248,244,0.5)';
    ctx.beginPath(); ctx.arc(X(fx), H / 2, 4, 0, Math.PI * 2); ctx.fill();
  }
  // 袋口：直接画成黑洞 + 一点皮口高光，省掉六个悬浮圆片
  for (const p of pockets) {
    const r = S(p.r);
    const gg = ctx.createRadialGradient(X(p.x), Z(p.z), r * 0.35, X(p.x), Z(p.z), r);
    gg.addColorStop(0, '#000000');
    gg.addColorStop(0.72, '#04070a');
    gg.addColorStop(1, 'rgba(2,4,6,0.35)');
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(190,160,95,0.35)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), r * 0.97, 0, Math.PI * 2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 台球球面贴图（等距柱状展开）：0=母球（象牙白），1~7 全色，9~15 花色（白底彩带），8 黑。
 * 号码牌画在赤道两个对称点上，转台时总有一面能看见。
 */
export function makePoolBallTexture(num, color, striped) {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(9000 + num);
  const hex = `#${color.toString(16).padStart(6, '0')}`;

  ctx.fillStyle = striped || num === 0 ? '#f7f3e7' : hex;
  ctx.fillRect(0, 0, W, H);
  if (striped) {
    ctx.fillStyle = hex;
    ctx.fillRect(0, H * 0.3, W, H * 0.4);
  }
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.05})`;
    ctx.fillRect(rnd() * W, rnd() * H, 1.6, 1.6);
  }
  if (num > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const u of [0.25, 0.75]) {
      ctx.fillStyle = '#faf7ef';
      ctx.beginPath(); ctx.arc(W * u, H * 0.5, 21, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.font = `bold ${num > 9 ? 23 : 27}px system-ui`;
      ctx.fillText(String(num), W * u, H * 0.5 + 1);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 天空盒/背景：馆内暗色渐变顶棚氛围（球馆无真实天空，用柔和渐变替代） */
export function makeSkyTexture() {
  const cv = document.createElement('canvas');
  cv.width = 16; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#1b2330');
  g.addColorStop(0.55, '#141a24');
  g.addColorStop(1, '#0c1016');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
