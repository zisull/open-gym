/**
 * gen_video_manifest.js —— 扫描 video/ 目录，生成影院放映单 video/manifest.js
 *
 * 为什么需要这一步：file:// 协议下浏览器禁止 fetch 目录列表，游戏无法"自动看到"
 * 文件夹里有什么；且本地路径的 <video> 贴上 WebGL 银幕会触发画布污染
 * （SecurityError，实测 Edge/Chromium）。唯一可靠的离线方案是把短片以
 * data: URL 内嵌进一个 JS 清单（与 imgs/wall 墙贴画同理）。
 *
 * 大文件（单片 >25MB 或全部内嵌 >40MB，base64 还会再膨胀 1/3）不适合内嵌：
 * 清单太大会让 index.html 双击后卡近一分钟。这类片子请直接在影厅点"选择视频"，
 * 走 blob: URL（同源、不污染、流式读取不占内存、秒开）。
 *
 * 用法：双击 tools/gen_videos.bat，或在项目根目录执行 npm run videos
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'video');
const OUT = path.join(VIDEO_DIR, 'manifest.js');
const MAX_EMBED = 25 * 1024 * 1024; // 单文件内嵌上限 25MB（base64 后约 33MB）
const MAX_TOTAL = 40 * 1024 * 1024; // 清单内嵌总量上限 40MB，保证开机秒进
const EXT_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
};

function main() {
  if (!fs.existsSync(VIDEO_DIR)) {
    console.log('video/ 目录不存在，已创建。把视频文件放进去后重新运行即可。');
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
  }
  const files = fs.readdirSync(VIDEO_DIR)
    .filter((f) => EXT_MIME[path.extname(f).toLowerCase()])
    .filter((f) => !f.startsWith('.'));

  const items = [];
  let total = 0;
  for (const f of files) {
    const fp = path.join(VIDEO_DIR, f);
    const size = fs.statSync(fp).size;
    if (size > MAX_EMBED) {
      console.log(`跳过（单片 >${MAX_EMBED / 1024 / 1024}MB，进影厅用"选择视频"播放）: ${f}`);
      continue;
    }
    if (total + size > MAX_TOTAL) {
      console.log(`跳过（内嵌总量已达 ${MAX_TOTAL / 1024 / 1024}MB 上限，进影厅用"选择视频"播放）: ${f}`);
      continue;
    }
    const ext = path.extname(f).toLowerCase();
    const b64 = fs.readFileSync(fp).toString('base64');
    items.push({ name: f, url: `data:${EXT_MIME[ext]};base64,${b64}` });
    total += size;
    console.log(`内嵌: ${f} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }

  const js = '// 自动生成：video/ 目录放映单（tools/gen_videos.bat）。请勿手改，重新生成即可。\n'
    + 'window.BB_VIDEOS=' + JSON.stringify(items) + ';\n';
  fs.writeFileSync(OUT, js, 'utf8');
  const kb = (Buffer.byteLength(js) / 1024).toFixed(0);
  console.log(`打包 ${items.length} 部影片 -> video/manifest.js (${kb} KB)`);
}

main();
