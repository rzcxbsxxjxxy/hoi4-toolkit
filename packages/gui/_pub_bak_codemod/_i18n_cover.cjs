/* 校验工具:比对 _i18n_extract.json 与各i18n-dict-*.js 的覆盖率。
 * 用法:node _i18n_cover.cjs           → 按文件域报缺口
 *       node _i18n_cover.cjs --miss    → 只列未收录的原文(写译文用)
 * ⚠ 哨兵值不计入缺口(它们本就不该翻译)。 */
const fs = require('fs');
const path = require('path');
const PUBLIC = __dirname;

// 收集已收录键。
// ★ 不要用「slice 到第一个 { 和最后一个 }」来抠对象字面量 —— 注释里
//   的花括号会骗过你(实测:头部注释含 '{' 时直接 SyntaxError)。
//   正确做法:桩一个 window.I18N,把文件真跑一遍,让 registerDict 收。
const collected = new Map(); // 键 -> [来源文件]
for (const f of fs.readdirSync(PUBLIC).filter((x) => /^i18n-dict-.*\.js$/.test(x))) {
  const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const got = new Map();
  //★ 桩必须带 I18N 字段:字典文件里是 `typeof window !== 'undefined' &&
  //   window.I18N && window.I18N.registerDict(D)`,只给个空 window 会静默
  //   走 fallback 分支(globalThis.__I18N_DICT),于是"收到 0 个键"却没有任何报错。
  const stub = {
    I18N: { registerDict: (o) => { for (const k of Object.keys(o || {})) got.set(k, o[k]); } },
  };
  try {
    new Function('window', src)(stub);
  } catch (e) {
    console.log('!! 执行失败 ' + f + ': ' + e.message);
    continue;
  }
  if (!got.size) console.log('!! 未收到任何键: ' + f + '(文件里有没有真的调 registerDict?)');
  for (const k of got.keys()) {
    if (!collected.has(k)) collected.set(k, []);
    collected.get(k).push(f);
  }
}

// 哨兵(与 i18n.js 的 SENTINELS 保持一致)
const SENTINELS = new Set(['(匿名)', '(多 DLC)', '游戏本体', '基础游戏']);

const rows = JSON.parse(fs.readFileSync(path.join(PUBLIC, '_i18n_extract.json'), 'utf8'));
const wantMiss = process.argv.includes('--miss');

// 字典里有、但源码里没有的键 = 废键(可能是打错字)
const haveSet = new Set(collected.keys());
const orphan = [...haveSet].filter(
  (k) => !rows.some((r) => r.s === k) && !SENTINELS.has(k)
);

const miss = rows.filter((r) => !haveSet.has(r.s) && !SENTINELS.has(r.s));

const covered = rows.length - miss.length;
console.log('字典文件:'+ [...new Set([...collected.values()].flat())].join(', '));
console.log('已收录键  :', haveSet.size);
console.log('覆盖率    : ' + covered + ' / ' + rows.length + '  (' + ((covered / rows.length) * 100).toFixed(1) + '%)');
console.log('未收录    :', miss.length);
console.log('孤儿键(源码里没有,疑似打错):', orphan.length);
if (orphan.length) console.log('   ' + orphan.slice(0, 20).map((s) => JSON.stringify(s)).join('\n   '));

if (wantMiss) {
  const g = new Map();
  for (const r of miss) {
    const f = r.at.split(':')[0].replace(' [attr]', '').replace(' [text]', '');
    if (!g.has(f)) g.set(f, []);
    g.get(f).push(r.s);
  }
  for (const [f, list] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log('\n######## ' + f + '  (' + list.length + ')');
    for (const s of list) console.log(s.replace(/\n/g, '\\n'));
  }
} else {
  const g = new Map();
  for (const r of miss) {
    const f = r.at.split(':')[0].replace(' [attr]', '').replace(' [text]', '');
    g.set(f, (g.get(f) || 0) + 1);
  }
  const top = [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('\n缺口最多的文件:');
  for (const [f, n] of top) console.log('  ' + String(n).padStart(4) + '  ' + f);
}
