/**
 * tools/shot.js —— 无头 Edge（playwright-core）验证：打开指定 URL，等待，
 * 回读 #dbg-out 断言通道与页面状态，截图落 .shots/。
 * 用法：node tools/shot.js "<url>" <宽> <高> <等待ms> <输出名>
 * 依赖：playwright-core（位置见 tools/pw.js），跑的是本机 Edge 的无头实例。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('./pw.js');   // playwright-core 位置由 tools/pw.js 解析（见其注释）

const URL_ = process.argv[2] || pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const W = Number(process.argv[3] || 1280);
const H = Number(process.argv[4] || 720);
const WAIT = Number(process.argv[5] || 5000);
const OUT = process.argv[6] || `shot_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

  await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(WAIT);

  const info = await page.evaluate(() => {
    const dbg = document.getElementById('dbg-out');
    return {
      dbg: dbg ? dbg.textContent : null,
      paused: !document.getElementById('pause').classList.contains('hidden'),
      menu: !document.getElementById('menu').classList.contains('hidden'),
      hud: !document.getElementById('hud').classList.contains('hidden'),
      state: (window.GAME && window.GAME.state) || '-',
      loc: (window.GAME && window.GAME.location) || '-',
    };
  });

  const dir = path.join(__dirname, '..', '.shots');
  fs.mkdirSync(dir, { recursive: true });   // 干净克隆下 .shots/ 不存在
  await page.screenshot({ path: path.join(dir, OUT + '.png') });
  console.log('SAVED .shots/' + OUT + '.png');
  console.log('INFO ' + JSON.stringify(info));
  console.log('ERRORS ' + (errors.length ? errors.slice(0, 6).join(' || ') : 'none'));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
