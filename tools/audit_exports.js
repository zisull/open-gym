/**
 * tools/audit_exports.js —— 列出「没有被任何其他 src 文件 import」的导出名。
 * 用法：node tools/audit_exports.js      （期望输出：无未被 import 的导出）
 * 与 tools/audit_cfg.js（未被引用的 config 键）配套，用来收 API 面：
 * 只在模块内部用的函数就别 export，跨文件契约越少，改一处漏一处的概率越低。
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src');
// 边界用字符类而不是 \b：本文件里的正则会经 JS 字符串再解一层转义，反斜杠类容易写飞
const B = '[^A-Za-z0-9_$]';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = {};
for (const f of files) src[f] = fs.readFileSync(path.join(dir, f), 'utf8');

const IMPORT_RE = /import[ \t]*\{([^}]*)\}/g;
const out = [];
for (const f of files) {
  for (const m of src[f].matchAll(/export[ \t]+(?:const|function|class|let)[ \t]+([A-Za-z0-9_$]+)/g)) {
    const n = m[1];
    const importers = files.filter((g) => {
      if (g === f) return false;
      for (const im of src[g].matchAll(IMPORT_RE)) {
        if (new RegExp(B + n + B).test(im[1])) return true;
      }
      return false;
    });
    const inSelf = (src[f].match(new RegExp(B + n + B, 'g')) || []).length;
    if (!importers.length) out.push(`${f}  export ${n}  （只在本文件出现 ${inSelf} 次）`);
  }
}
console.log(out.length ? `未被 import 的导出（${out.length}）:\n` + out.join('\n') : '无未被 import 的导出');
