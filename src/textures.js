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
 * 篮球场地板贴图：木纹 + 全部标线（中线/中圈/三秒区/罚球圈/三分弧/限制区）
 * 贴图覆盖整个球场 28m x 15m。
 */
export function makeCourtTexture() {
  const W = 2048, H = 1100;            // 画布分辨率
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(20260924);

  // ---- 木地板底色 ----
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#c98a45');
  grad.addColorStop(0.5, '#d69a55');
  grad.addColorStop(1, '#c68541');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 木板条纹（沿长度方向铺设）
  const plankH = 14;
  for (let y = 0; y < H; y += plankH) {
    const shade = 0.86 + rnd() * 0.24;
    ctx.fillStyle = `rgba(${Math.round(178 * shade)}, ${Math.round(118 * shade)}, ${Math.round(58 * shade)}, 0.5)`;
    ctx.fillRect(0, y, W, plankH - 1.5);
    // 木纹细线
    ctx.strokeStyle = `rgba(120, 70, 25, ${0.05 + rnd() * 0.08})`;
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      ctx.beginPath();
      const gy = y + rnd() * plankH;
      ctx.moveTo(0, gy);
      for (let x = 0; x < W; x += 64) ctx.lineTo(x, gy + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    // 板缝随机断开
    if (rnd() < 0.35) {
      ctx.fillStyle = 'rgba(90, 55, 20, 0.35)';
      ctx.fillRect(rnd() * W, y, 2, plankH);
    }
  }

  // 高光缎面感（沿 x 的宽光带）
  const sheen = ctx.createLinearGradient(0, H * 0.3, 0, H * 0.55);
  sheen.addColorStop(0, 'rgba(255,240,210,0)');
  sheen.addColorStop(0.5, 'rgba(255,240,210,0.10)');
  sheen.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);

  // ---- 坐标换算：世界 (x,z) -> 像素 ----
  // 画布像素非正方形（x 向 136.5px/m，z 向 39.3px/m），
  // 圆/弧一律用 ctx.ellipse 以 (rx=su, ry=sv) 两轴半径绘制，保证落地后是正圆且线宽一致。
  const { halfW, halfL } = CFG.court;
  const sy = (z) => ((z + halfL) / (halfL * 2)) * H;
  const su = (m) => (m / (halfW * 2)) * W;   // 米 -> 像素（x 向）
  const sv = (m) => (m / (halfL * 2)) * H;   // 米 -> 像素（z 向）
  const ell = (x, y, r, a0, a1, ccw) => ctx.ellipse(x, y, su(r), sv(r), 0, a0, a1, ccw);

  ctx.strokeStyle = '#f5f1e8';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;

  // 球场边线 + 端线
  ctx.strokeRect(2, 2, W - 4, H - 4);
  // 中线
  ctx.beginPath();
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
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
    const cx = W / 2;

    // 禁区（三秒区）：宽 4.9m，端线伸到罚球线
    const keyW = su(4.9 / 2);
    const yEnd = sy(endZ), yFt = sy(ftZ);
    ctx.strokeRect(cx - keyW, Math.min(yEnd, yFt), keyW * 2, Math.abs(yFt - yEnd));
    ctx.fillStyle = 'rgba(70, 110, 160, 0.16)';
    ctx.fillRect(cx - keyW, Math.min(yEnd, yFt), keyW * 2, Math.abs(yFt - yEnd));

    // 罚球圈
    ctx.beginPath();
    ell(cx, yFt, 1.8, 0, Math.PI * 2);
    ctx.stroke();

    // 合理冲撞区半圆（圈心投影为心，半径 1.25m，开口朝端线）
    ctx.beginPath();
    if (sign < 0) ell(cx, sy(rimFloorZ), 1.25, 0, Math.PI, false);
    else ell(cx, sy(rimFloorZ), 1.25, Math.PI, Math.PI * 2, false);
    ctx.stroke();

    // 三分弧：以圈心投影为心，半径 6.75m，两侧直线段沿边线内 0.9m 接到端线
    const cornerX = su(halfW - 0.9);                  // 角线距中线的像素距离
    const r3px = su(CFG.shot.zoneRadius);
    const ac = Math.acos(Math.min(1, cornerX / r3px)); // 弧与角线交点的参数角
    const dy = sv(CFG.shot.zoneRadius) * Math.sin(ac);  // 交点距圈心的像素纵向距离
    const cz = sy(rimFloorZ);
    ctx.beginPath();
    if (sign < 0) {
      // 近筐：弧朝场内（+y）鼓出
      ctx.moveTo(cx - cornerX, yEnd);
      ctx.lineTo(cx - cornerX, cz + dy);
      ell(cx, cz, CFG.shot.zoneRadius, Math.PI - ac, ac, true);
      ctx.lineTo(cx + cornerX, yEnd);
    } else {
      // 远筐：弧朝场内（-y）鼓出
      ctx.moveTo(cx - cornerX, yEnd);
      ctx.lineTo(cx - cornerX, cz - dy);
      ell(cx, cz, CFG.shot.zoneRadius, Math.PI + ac, Math.PI * 2 - ac, false);
      ctx.lineTo(cx + cornerX, yEnd);
    }
    ctx.stroke();
    ctx.restore();
  }
  paintEnd(-1); // 进攻端（可玩篮筐，-z）
  paintEnd(1);  // 另一端纯装饰

  // 端线外赞助区文字
  ctx.fillStyle = 'rgba(245,241,232,0.5)';
  ctx.font = `bold 56px 'Segoe UI', system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('FIRST-TOUCH HOOPS', W / 2, H - 26);
  ctx.fillText('STREET  ·  GYM  ·  3D', W / 2, 62);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16; // 斜视角地板抗摩尔纹（three 会自动钳制到驱动上限）
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
