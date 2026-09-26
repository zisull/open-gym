/**
 * tools/regress.js —— 一次跑完全量回归 demo（同一个浏览器顺序过 case，只打印断言通道与报错）。
 * 用法：node tools/regress.js [关键字过滤]      例：node tools/regress.js fade
 * 依赖：playwright-core（位置见 tools/pw.js），跑的是本机 Edge 的无头实例。
 * 判定：每个 case 的 ERRORS 必须是 none，且断言行要和 README「回归实测」小节写死的一致。
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('./pw.js');   // playwright-core 位置由 tools/pw.js 解析（见其注释）
const BASE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  // —— 篮球 ——
  ['dribble', '?mode=free&demo=dribble', 6000],
  ['tap', '?mode=free&demo=tap', 6000],
  ['shot', '?mode=free&demo=shot', 5000],
  ['move', '?mode=free&demo=move', 6000],
  ['input', '?demo=input', 5000],
  ['spot', '?demo=spot', 5000],
  ['arch', '?demo=arch', 7000],
  ['result', '?mode=free&demo=result', 6000],
  ['pause', '?mode=free&demo=pause', 5000],
  // —— 主页 / 过场 ——
  ['help', '?demo=help', 2500],
  ['fade', '?demo=fade', 4000],
  // —— 电影院 ——
  ['sit', '?mode=free&loc=cinema&demo=sit', 9000],
  ['grid', '?mode=free&loc=cinema&demo=grid', 9000],
  ['import', '?mode=free&loc=cinema&demo=import', 9000],
  ['wall', '?mode=free&loc=cinema&demo=wall', 14000],
  ['ring', '?mode=free&loc=cinema&demo=ring', 9000],
  ['exit', '?mode=free&loc=cinema&demo=exit', 10000],
  ['save', '?mode=free&loc=cinema&demo=save', 9000],
  // —— 台球室 ——
  ['pool', '?mode=free&loc=pool&demo=pool', 14000],
  ['rules', '?mode=free&loc=pool&demo=rules', 12000],
  ['book', '?mode=free&loc=pool&demo=book', 12000],
  ['spin', '?mode=free&loc=pool&demo=spin', 14000],
];

(async () => {
  const filter = process.argv[2];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let bad = 0;
  for (const [name, qs, wait] of CASES) {
    if (filter && !name.includes(filter)) continue;
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
    try {
      await page.goto(BASE + qs, { waitUntil: 'load', timeout: 30000 });
      await sleep(wait);
      const info = await page.evaluate(() => ({
        dbg: (document.getElementById('dbg-out') || {}).textContent || '-',
        state: (window.GAME && window.GAME.state) || '-',
        loc: (window.GAME && window.GAME.location) || '-',
      }));
      console.log(`[${name}] state=${info.state} loc=${info.loc}`);
      console.log(`  ${String(info.dbg).replace(/\s*\n\s*/g, ' | ')}`);
      console.log(`  ERRORS ${errors.length ? errors.slice(0, 4).join(' || ') : 'none'}`);
      if (errors.length) bad++;
    } catch (e) {
      console.log(`[${name}] FATAL ${e.message.slice(0, 200)}`);
      bad++;
    }
    await page.close();
    await sleep(300);
  }
  await browser.close();
  console.log(bad ? `=== ${bad} case(s) with errors ===` : '=== ALL CLEAN ===');
  process.exit(bad ? 1 : 0);
})();
