/* 桩测:在没有浏览器的环境里验证 i18n 引擎核心逻辑。
 * 真浏览器验收见 test/i18n.test.cjs(无头 Edge + CDP)。
 * 作用:改完 i18n.js 后先跑这个,秒级反馈,别等 30秒的浏览器测试。 */
const fs = require('fs');
const path = require('path');

// ── 极简 DOM 桩:只需 nodeType / childNodes / tagName / attributes ──
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.attrs = {};
    this.nodeValue = null;
  }
  appendChild(c) { this.childNodes.push(c); return c; }
  set textContent(v) { this.childNodes = []; if (v !== '') this.appendChild(new Text(v)); }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
  }
  hasAttribute(a) { return a in this.attrs; }
  getAttribute(a) { return this.attrs[a] === undefined ? null : this.attrs[a]; }
  setAttribute(a, v) { this.attrs[a] = String(v); }
  get isContentEditable() { return false; }
}
class Text {
  constructor(v) { this.nodeType = 3; this.nodeValue = v; }
}

global.window = global;
global.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };
global.navigator = { language: 'zh-CN' };
global.document = {
  readyState: 'complete',
  documentElement: { setAttribute() {}, getAttribute: () => null },
  body: new El('body'),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};

// ── 载入被测代码 ──
const src = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8').replace(/^export \{[^}]*\}/m, '');
new Function(src)();

const { registerDict, t, hasDict, translateElement, setLang, getLang } = global.I18N;

// ── 迷你断言 ──
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got : ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)); }
};

console.log('── 桩测 ──');

// 1. 原文键注册与查询
registerDict({ '来源:': 'Source:', '保存': 'Save', '全部': 'All', '复制 id': 'Copy id', '已复制': 'Copied' });
eq('中文态 t(原文键) 返回原文', t('来源:'), '来源:');
setLang('en', { persist: false });
eq('英文态 t(原文键) 返回译文', t('来源:'), 'Source:');
eq('未登记键回落自身', t('未登记的键'), '未登记的键');
eq('hasDict 已登记', hasDict('来源:'), true);
eq('hasDict 未登记', hasDict('未登记的键'), false);

// 2. ★ 哨兵值永不可翻译(误翻=功能坏)
eq('哨兵 hasDict=false', hasDict('(匿名)'), false);
eq('哨兵 原样返回', t('(匿名)'), '(匿名)');
setLang('zh', { persist: false });

// 3. 文本节点替换
const body = new El('body');
const wrap = new El('div');
wrap.appendChild(new Text('来源:'));
const keep = new El('span');
keep.appendChild(new Text('机动部队'));      // 模拟模组数据,未登记 → 不该动
const pre = new El('pre');
pre.appendChild(new Text('来源:'));            // pre 内是代码/原文,不该动
const noI18n = new El('div');
noI18n.attrs['data-no-i18n'] = '';
noI18n.appendChild(new Text('来源:'));         // 显式数据区,不该动
body.appendChild(wrap); body.appendChild(keep); body.appendChild(pre); body.appendChild(noI18n);

setLang('en', { persist: false });
translateElement(body);
eq('登记过的文本节点被替换', wrap.textContent, 'Source:');
eq('★ 未登记的模组数据不动', keep.textContent, '机动部队');
eq('★ pre 内不动', pre.textContent, '来源:');
eq('★ data-no-i18n 子树不动', noI18n.textContent, '来源:');

// 4. 切回中文:靠反查还原
setLang('zh', { persist: false });
translateElement(body);
eq('切回中文可还原', wrap.textContent, '来源:');
eq('切回中文不影响数据', keep.textContent, '机动部队');

// 5. 首尾空白保留
const ws = new El('div');
ws.appendChild(new Text('\n  来源: \n'));
setLang('en', { persist: false });
translateElement(ws);
eq('保留首尾空白', ws.childNodes[0].nodeValue, '\n  Source: \n');

// 6. 属性替换
const ti = new El('input');
ti.attrs['title'] = '复制 id';
setLang('en', { persist: false });
translateElement(ti);
eq('title 属性被替换', ti.getAttribute('title'), 'Copy id');
// ★ input 的 value 是用户数据,绝不能翻
const inp = new El('input');
inp.attrs['title'] = '复制 id';
inp.attrs['value'] = '来源:';
translateElement(inp);
eq('★ input title 仍被替换', inp.getAttribute('title'), 'Copy id');
eq('★ input value 绝不翻', inp.getAttribute('value'), '来源:');

// 7. ★ 插值句:整串匹配不到 → **必须保持中文,不得片段替换**
//    (子串替换已验证有害:'模组'→'mod' 会造出 "AllSource"、
//     "不overridden"、"共 26882事件"。宁可留中文,不可译错。)
const comp = new El('div');
comp.appendChild(new Text('全部 (271 树)'));
const comp2 = new El('div');
comp2.appendChild(new Text('585 科技 / 382 边'));
setLang('en', { persist: false });
translateElement(comp); translateElement(comp2);
eq('★ 插值句不做子串替换(宁留中文不译错)', comp.textContent, '全部 (271 树)');
eq('★ 插值句不做子串替换(科技/边)', comp2.textContent, '585 科技 / 382 边');
// 但整串命中的插值句仍要翻
const whole = new El('div');
whole.appendChild(new Text('已复制'));
translateElement(whole);
eq('整串命中的仍被替换', whole.textContent, 'Copied');
// 保护区内的拼接句不动
const compNo = new El('div');
compNo.setAttribute('data-no-i18n', '');
compNo.appendChild(new Text('机动部队'));
translateElement(compNo);
eq('★ 保护区拼接句不动', compNo.textContent, '机动部队');

console.log('\n桩测: ' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
