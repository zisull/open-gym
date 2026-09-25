/**
 * tools/pw.js —— 解析 playwright-core 的位置并导出。
 * 本仓库不依赖它（游戏本身零依赖运行），只有无头验证脚本用。
 * 优先级：环境变量 PLAYWRIGHT_CORE_PATH → 本仓库 node_modules → 用户目录下的隔离 node workspace。
 * 找不到就抛明确的错，别让人对着 "Cannot find module" 猜。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDS = [
  process.env.PLAYWRIGHT_CORE_PATH,
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
  path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core'),
];
const found = CANDS.filter(Boolean).find((p) => fs.existsSync(p));
if (!found) {
  throw new Error('找不到 playwright-core：npm i -D playwright-core，或设 PLAYWRIGHT_CORE_PATH 指向它');
}
module.exports = { chromium: require(found).chromium, PW_PATH: found };
