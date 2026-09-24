/**
 * gen_wall_manifest.js —— 扫描 imgs/wall/ 下的图片，生成游戏可加载的 manifest
 *
 * 用法：
 *   node tools/gen_wall_manifest.js      （或 npm run walls）
 *   或直接双击 tools/gen_walls.bat
 *
 * 背景：浏览器在 file:// 下把本地 <img> 视为污染源，WebGL 上传会抛
 * SecurityError（实测 Edge/Chromium 均如此），因此这里把图片 base64
 * 内嵌进 imgs/wall/manifest.js（window.BB_WALLS），data: URL 不受限制。
 *
 * 支持格式：jpg / jpeg / png / webp / gif / bmp
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'imgs', 'wall');
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
const MAX_MB = 8; // 单图上限（base64 后约 11MB，再多会拖慢启动）

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const files = fs.readdirSync(DIR).filter((f) => MIME[path.extname(f).toLowerCase()]);
const out = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(DIR, f));
  if (buf.length > MAX_MB * 1024 * 1024) {
    console.warn(`[跳过] ${f} 超过 ${MAX_MB}MB，未打包进 manifest`);
    continue;
  }
  out.push({ name: f, url: `data:${MIME[path.extname(f).toLowerCase()]};base64,${buf.toString('base64')}` });
}

const js = `/* 由 tools/gen_wall_manifest.js 自动生成 —— 请勿手工编辑。\n   往 imgs/wall/ 放图后重新运行生成器（或双击 tools/gen_walls.bat）。 */\nwindow.BB_WALLS = ${JSON.stringify(out)};\n`;
fs.writeFileSync(path.join(DIR, 'manifest.js'), js);
console.log(`[gen_wall_manifest] 打包 ${out.length} 张图 -> imgs/wall/manifest.js (${(js.length / 1024).toFixed(0)} KB)`);
for (const it of out) console.log(`  · ${it.name}`);
