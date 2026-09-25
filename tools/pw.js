/**
 * tools/pw.js —— 解析 playwright-core 的位置并导出。
 * 游戏本身零依赖运行，只有无头验证脚本用它；它已列进 devDependencies，
 * 跑 安装环境.bat 就会带上。留个环境变量给不想装的人指向别处的副本。
 * 找不到就抛明确的错，别让人对着 "Cannot find module" 猜。
 */
const fs = require('fs');
const path = require('path');

const CANDS = [
  process.env.PLAYWRIGHT_CORE_PATH,
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
];
const found = CANDS.filter(Boolean).find((p) => fs.existsSync(p));
if (!found) {
  throw new Error('找不到 playwright-core：跑一次「安装环境.bat」（或 npm install），或设 PLAYWRIGHT_CORE_PATH 指向它');
}
module.exports = { chromium: require(found).chromium, PW_PATH: found };
