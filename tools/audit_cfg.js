/* tools/audit_cfg.js —— 静态扫描：config.js 里从未被任何模块/页面引用的键。
   用法：node tools/audit_cfg.js */
const fs = require('fs');
const path = require('path');

const roots = ['src', '.'];
const files = [];
for (const f of fs.readdirSync('src')) {
  if (f.endsWith('.js')) files.push(['src/' + f, fs.readFileSync('src/' + f, 'utf8')]);
}
files.push(['index.html', fs.readFileSync('index.html', 'utf8')]);
for (const f of fs.readdirSync('tools')) {
  if (f.endsWith('.js')) files.push(['tools/' + f, fs.readFileSync(path.join('tools', f), 'utf8')]);
}

const cfg = fs.readFileSync('src/config.js', 'utf8');
const keys = [...new Set([...cfg.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]))];
const NB = /[^A-Za-z0-9_$]/;
const hit = (s, k) => {
  let n = 0;
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + k + '($|[^A-Za-z0-9_$])', 'g');
  for (let i = 0; i < s.length; i++) { /* noop */ }
  const m = s.match(re);
  if (m) n = m.length;
  return n;
};
const dead = [];
for (const k of keys) {
  let n = 0;
  for (const [f, s] of files) {
    if (f === 'src/config.js') continue;
    n += hit(s, k);
  }
  if (n === 0) dead.push(k);
}
console.log('未被引用的 config 键（' + dead.length + '）: ' + dead.join('  '));
