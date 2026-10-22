// 一次性审计脚本：提取全站唯一中文文案，评估翻译工作量
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const ZH = /[\u4e00-\u9fa5]/;

// ── 1. JS：字符串字面量里的中文（排除注释行、已包t() 的）──
const jsHits = new Map(); // 原文 -> Set(file:line)
const jsFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((L, i) => {
    const code = L.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (!ZH.test(code)) return;
    for (const m of code.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      const v = m[2];
      if (!ZH.test(v)) continue;
      const before = code.slice(0, m.index);
      if (/\bt\(\s*$/.test(before)) continue; // 已经是 t('...')
      if (!jsHits.has(v)) jsHits.set(v, new Set());
      jsHits.get(v).add(f + ':' + (i + 1));
    }
  });
}

// ── 2. HTML：文本节点 + 属性 ──
const htmlHits = new Map();
const htmlFiles = fs.readdirSync(DIR).filter((f) => f.endsWith('.html'));
for (const f of htmlFiles) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const body = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const push = (v, where) => {
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t || !ZH.test(t)) return;
    if (!htmlHits.has(t)) htmlHits.set(t, new Set());
    htmlHits.get(t).add(f + where);
  };
  for (const m of body.matchAll(/[a-zA-Z-]+="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) push(m[1], ' [attr]');
  for (const m of body.matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) push(m[1], ' [text]');
}

// ── 3. 合并 ──
const all = new Map();
for (const [k, v] of jsHits) all.set(k, { where: v, src: 'js' });
for (const [k, v] of htmlHits) {
  if (all.has(k)) { const e = all.get(k); for (const x of v) e.where.add(x); e.src += '+html'; }
  else all.set(k, { where: v, src: 'html' });
}

const rows = [...all.entries()].sort((a, b) => b[1].where.size - a[1].where.size);
const sorted = rows.map(([k, v]) => ({ s: k, n: v.where.size, src: v.src, at: [...v.where][0] }));
fs.writeFileSync(path.join(DIR, '_i18n_extract.json'), JSON.stringify(sorted, null, 1), 'utf8');

console.log('unique zh strings  :', sorted.length);
console.log('  from js  :', sorted.filter((r) => r.src.includes('js')).length);
console.log('  from html:', sorted.filter((r) => r.src.includes('html')).length);
console.log('total occurrences  :', sorted.reduce((a, b) => a + b.n, 0));
console.log('appearing >=5 times:', sorted.filter((r) => r.n >= 5).length);
console.log('appearing 1 time   :', sorted.filter((r) => r.n === 1).length);
const lens = sorted.map((r) => r.s.length).sort((a, b) => a - b);
console.log('total zh chars     :', lens.reduce((a, b) => a + b, 0));
console.log('\n--- top 30 by frequency ---');
sorted.slice(0, 30).forEach((r) => console.log(String(r.n).padStart(3) + 'x  ' + r.s.slice(0, 60)));
