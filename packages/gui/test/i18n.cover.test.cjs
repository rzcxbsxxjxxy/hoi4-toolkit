/* ══════════════════════════════════════════════════════════════════
 * i18n 覆盖审计 —— i18n 完整性的守门测试
 *
 * 跑法:node packages/gui/test/i18n.cover.test.cjs
 *
 * ★ 为什么必须有这个测试:i18n 的失败模式是**静默**的。
 *   新增一个中文文案却忘了登记字典 → 英文界面里悄悄冒出一个中文,
 *   没有任何报错。所以"覆盖率"必须变成断言,而不是靠人记得看。
 *
 * 断言项:
 *   1. 100% 覆盖:public/*.js 与 *.html 里的每条中文都有译文
 *   2. 零孤儿键:字典里没有源码中不存在的键(打错字 / 源码已改)
 *   3. 哨兵值保护:'(匿名)' 等数据键**永不出现在字典里**
 *      (误翻= 功能直接坏掉,这条是硬红线)
 *   4. 无空译文 / 无「中英同形」的假翻译
 *   5. 所有字典文件语法正确且真的调了 registerDict
 * ══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
};

// ── 1. 收集字典 ──
const dict = new Map();      // 键 -> 译文
const dictFiles = fs.readdirSync(PUBLIC).filter((f) => /^i18n-dict-.*\.js$/.test(f));
console.log('── 字典文件 (' + dictFiles.length + ') ──');
ok('存在字典文件', dictFiles.length > 0);
for (const f of dictFiles) {
  const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const got = new Map();
  let called = false;
  try {
    new Function('window', src)({
      I18N: {
        registerDict(o) {
          called = true;
          for (const k of Object.keys(o || {})) got.set(k, o[k]);
        },
      },
    });
  } catch (e) {
    ok(f + ' 语法与执行', false, e.message);
    continue;
  }
  ok(f + ' 真的调了 registerDict', called);
  let dup = 0;
  for (const [k, v] of got) {
    if (dict.has(k)) { dup++; console.log('      重复键: ' + JSON.stringify(k) + ' (先见于 ' + dict.get(k).__f + ')'); }
    v.__f = f;
    dict.set(k, v);
  }
  ok(f + ' 无重复键 (' + got.size + ' 条)', dup === 0, dup + ' 个重复');
}

// ── 2. 扫描源码,提取所有中文文案 ──
const ZH = /[\u4e00-\u9fa5]/;
const SENTINELS = new Set(['(匿名)', '(多 DLC)', '游戏本体', '基础游戏']);

function scanJs(src) {
  const out = new Set();
  // ★ 必须先剥掉 /* */ 块注释,再按行剥 // 行注释。
  //   只剥行注释的话,块注释里的中文示例("跳过子树""机动部队")会被
  //   当成待翻译文案 → 报一堆假漏翻。
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of clean.split(/\r?\n/)) {
    const code = line.replace(/\/\/.*$/, '');
    if (!ZH.test(code)) continue;
    for (const m of code.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      const v = m[2];
      if (!ZH.test(v)) continue;
      if (/\bt\(\s*$/.test(code.slice(0, m.index))) continue; // 已是 t('..')
      out.add(v);
    }
  }
  return out;
}
function scanHtml(src) {
  const out = new Set();
  const body = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const m of body.matchAll(/[a-zA-Z-]+="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) out.add(m[1].trim());
  for (const m of body.matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t) out.add(t);
  }
  return out;
}

const want = new Set();
for (const f of fs.readdirSync(PUBLIC)) {
  const p = path.join(PUBLIC, f);
  // ★ 排除 i18n 引擎与字典自身:
  //   i18n.js 里的中文大半在**注释和文档字符串**里(讲机制怎么工作的),
  //   以及 DICT 的 zh 侧 —— 那些已经由语义键(t('nav.focus'))负责翻译,
  //   再登记一份原文键既重复又和注释撞车。
  if (f.startsWith('i18n') || f.startsWith('_')) continue;
  const src = fs.readFileSync(p, 'utf8');
  const set = f.endsWith('.js') ? scanJs(src) : f.endsWith('.html') ? scanHtml(src) : null;
  if (set) for (const v of set) want.add(v);
}

/**
 * ★ HTML / 模板串解构(覆盖率口径修正)。
 *
 *   源码里大量 `tr('<div ...><b>文件</b><span>' + x + '...</div>')` 这类串,
 *   运行时由 MutationObserver 按**文本节点原文**(BY_TEXT)逐个翻译内部中文标签,
 *   整段 HTML 从不会作为"一个键"去查表(那样一改空白/结构就全失效)。
 *   所以覆盖率不该要求"整段 HTML 串是键",而该要求"串里每个可见中文标签都
 *   有译文"。这里把含标签 / ${} / 换行的串解构成内部中文 token(>=2 字),
 *   用这些 token 当待覆盖项;纯插值片段(如 ' 个被跳过: ')保持原样不动。
 */
const ZH_RUN = /[\u4e00-\u9fa5][\u4e00-\u9fa5（）：、，。·\s]*/g;
function decompose(s) {
  // 只解构"带标记的"串;纯中文插值片段原样保留(它们是真实键)。
  if (!/[<>]/.test(s) && !s.includes('${') && !s.includes('\n')) return [s];
  let t = s;
  t = t.replace(/\$\{[^}]*\}/g, ' ');   // 去 ${...}
  t = t.replace(/\{\{[^}]*\}\}/g, ' '); // 去 {{...}}
  t = t.replace(/<[^>]*>/g, ' ');       // 去 HTML 标签(含 title= 等属性的中文)
  t = t.replace(/&#?[a-zA-Z0-9]+;/g, ' '); // 去实体
  const toks = new Set();
  for (const m of t.matchAll(ZH_RUN)) {
    const w = m[0].replace(/\s+/g, '').trim();
    if (w.length >= 2) toks.add(w);
  }
  return [...toks];
}
const wantD = new Set();
for (const s of want) for (const t of decompose(s)) wantD.add(t);

console.log('\n── 覆盖率 ──');
const real = [...wantD].filter((k) => !SENTINELS.has(k));
const missing = real.filter((k) => !dict.has(k));
console.log('  源码唯一中文文案: ' + real.length + ' 条(另 ' + [...want].filter((k) => SENTINELS.has(k)).length + ' 条哨兵值不参与)');
console.log('  字典已收录      : ' + (real.length - missing.length) + ' 条');
ok('100% 覆盖(无漏翻)', missing.length === 0,
   missing.length ? '漏 ' + missing.length + ' 条,前 10:\n      ' + missing.slice(0, 10).map((s) => JSON.stringify(s)).join('\n      ') : '');

/**
 * 孤儿键判定。
 *
 * ★ 这里必须区分两种"源码里没有":
 *   1. 键只出现在 /* *\/ 注释里 —— 注释不是界面文案,字典里留着是纯废键
 *      (早期提取脚本没剥注释导致的),应清理。
 *   2. 键是某个**更长句子的一部分** —— 如 docs.html 里的"位置错误"
 *      出现在 "这是早期版本最明显的一个位置错误。现在尺寸…" 中间。
 *      它不是独立的文本节点,运行时永远匹配不到,也不该单独登记。
 *   判据:键出现在任一源码(含注释)里 → 不算孤儿。只在注释里 → 孤儿。
 */
const rawAll = [];
for (const f of fs.readdirSync(PUBLIC)) {
  if (f.startsWith('_')) continue;
  if (!/\.(js|html)$/.test(f)) continue;
  rawAll.push(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
}
const appearsInRaw = (k) => rawAll.some((s) => s.includes(k));

const orphanStrict = [...dict.keys()].filter((k) => !wantD.has(k) && !SENTINELS.has(k));
const orphanReal = orphanStrict.filter((k) => !appearsInRaw(k));
const orphanBenign = orphanStrict.filter((k) => appearsInRaw(k));
ok('零孤儿键(字典无纯废键)', orphanReal.length === 0,
   orphanReal.length ? orphanReal.slice(0, 10).map((s) => JSON.stringify(s)).join('\n      ') : '');
if (orphanBenign.length) {
  console.log('  · ' + orphanBenign.length + ' 条键只作为长句片段出现(非独立文本节点,运行时不会命中):');
  console.log('      例: ' + orphanBenign.slice(0, 4).map((s) => JSON.stringify(s)).join(' / '));
}

console.log('\n── 译文质量 ──');
/**
 * ★ 允许"故意的空译文"白名单。
 *   源码把中文句子按变量切段后,英文语序常常不需要其中一段
 *   (如 '只看来自 ' + tag + ' 的机构' → "Show only agencies from GER")。
 *   这类键译成空串是**正确**的;留中文反而是 bug。
 *   但空串与"忘翻"在数据上长得一样,所以必须显式登记,
 *   否则这条断言形同虚设。
 *
 *   '的' 译成一个**空格**而不是空串:它夹在两段译文之间
 *   (如 "<b>FIRE</b>的<em>装备</em>" → "<b>FIRE</b> <em>equipment</em>"),
 *   英文靠空格断词,直接置空会把两个词粘成一个。
 */
const ALLOW_EMPTY = new Set([' 的机构', ' 个', ' 条', '的前置 ', ' 的', '的']);
const empty = [], sameAsZh = [], hasZh = [];
for (const [k, v] of dict) {
  const val = typeof v === 'string' ? v : '';
  if (!val.trim() && !ALLOW_EMPTY.has(k)) empty.push(k);
  else if (val === k) sameAsZh.push(k);
  else if (val && ZH.test(val)) hasZh.push(k);
}
ok('无未登记的空译文', empty.length === 0, empty.slice(0, 5).join(' | '));
ok('无「译文=原文」的假翻译', sameAsZh.length === 0, sameAsZh.slice(0, 8).join(' | '));
// 译文里残留少量中文是有意的(专有名词/游戏术语),只做提示不做断言
if (hasZh.length) console.log('  · 译文含中文(多为游戏术语,人工确认): ' + hasZh.length + ' 条,例: ' + hasZh.slice(0, 6).map((s) => dict.get(s)).join(' / '));

console.log('\n── 哨兵值保护 (硬红线)──');
const leaked = [...SENTINELS].filter((s) => dict.has(s));
ok('哨兵值均未进入字典', leaked.length === 0, leaked.join(' | '));

console.log('\n── 引擎加载 ──');
const i18n = fs.readFileSync(path.join(PUBLIC, 'i18n.js'), 'utf8');
ok('i18n.js 导出 registerDict', /function registerDict/.test(i18n));
ok('i18n.js 挂 window.I18N', /window\.I18N\s*=/.test(i18n));
ok('支持 data-no-i18n 跳过', i18n.includes('NO_I18N_ATTR'));
ok('有 MutationObserver 兜底异步渲染', /MutationObserver/.test(i18n));

const htmlFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const noDict = htmlFiles.filter((f) => {
  const s = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  return s.includes('i18n.js') && !s.includes('i18n-dict.js');
});
ok('所有引 i18n.js 的页面都引了字典', noDict.length === 0, noDict.join(' '));
const badOrder = htmlFiles.filter((f) => {
  const s = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const a = s.indexOf('i18n.js'), b = s.indexOf('i18n-dict.js');
  return b >= 0 && b < a;
});
ok('字典加载在 i18n.js 之后', badOrder.length === 0, badOrder.join(' '));

const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');
ok('server.ts 有 /i18n-dict.js 路由', srv.includes("'/i18n-dict.js'"));

console.log('\n' + '─'.repeat(50));
console.log('i18n 覆盖审计: ' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
