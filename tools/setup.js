/**
 * tools/setup.js —— 一键装开发环境：依赖 -> 打包 -> 素材清单。
 *
 * 为什么不把逻辑写在 .bat 里：cmd 在 chcp 65001 下按字节推进批处理文件的读取
 * 位置，中文行会让行首的 echo 被吃掉、后半句当成命令真跑一遍（实测踩过）。
 * 所以 .bat 只留纯 ASCII 外壳，中文提示全部走这里，由 Node 正常输出 UTF-8。
 *
 * 用法：双击 安装环境.bat，或 npm run setup
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIRROR = 'https://registry.npmmirror.com';

// 整条命令都是本文件里的常量，没有外部输入，所以走 shell 拼字符串是安全的
const sh = (cmd) => spawnSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true }).status ?? 1;
const npmInstall = (mirror) => sh(`npm install --no-audit --no-fund --loglevel=error${mirror ? ` --registry=${MIRROR}` : ''}`);

console.log('');
console.log('  开放球馆 OPEN GYM —— 开发环境安装');
console.log('  ' + '-'.repeat(46));
console.log('  游戏本体不用装任何东西：双击「启动游戏.bat」就是离线完整版。');
console.log('  只有要改 src\\ 下的代码、或要跑自动回归时，才需要这一步。');
console.log('');

// 1) 依赖：three / cannon-es / esbuild / playwright-core
console.log('  [1/3] 安装依赖 three + cannon-es + esbuild + playwright-core ...');
if (npmInstall() !== 0) {
  console.log('        官方源没连通，改用国内镜像 npmmirror 重试 ...');
  if (npmInstall(true) !== 0) {
    console.log('');
    console.log('  [!] 依赖装不下来。确认网络/代理后重跑，或手动执行：');
    console.log(`      npm install --registry=${MIRROR}`);
    process.exit(1);
  }
}

// 2) 打包：src/*.js -> dist/game.js（浏览器加载的就是这个文件）
console.log('  [2/3] 打包 dist\\game.js ...');
if (sh('npm run build') !== 0) {
  console.log('');
  console.log('  [!] 打包失败，请把上面的报错发给我，或手动执行：npm run build');
  process.exit(1);
}

// 3) 素材清单：这两个 manifest 不入库（含 base64 素材），每台机器各自扫盘生成
console.log('  [3/3] 生成墙贴 / 影片清单 ...');
for (const t of ['gen_wall_manifest.js', 'gen_video_manifest.js']) {
  if (sh(`node tools/${t}`) !== 0) console.log(`        [!] ${t} 没跑成，可稍后手动重试`);
}

console.log('');
console.log('  ' + '-'.repeat(46));
console.log('  全部完成。以后改完 src\\ 里的代码，再跑一次本脚本即可重新打包。');
console.log('  开始玩：双击「启动游戏.bat」');
console.log('  跑回归：npm run regress');
console.log('');
