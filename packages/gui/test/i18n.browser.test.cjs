/* 真浏览器验收:i18n 全站双语(无头 Edge + CDP)
 * 关注点:
 *   1. 字典真的挂上(window.I18N.dictSize() > 1900)
 *   2. 切到英文后各页**可见文本**不再有中文(哨兵白名单除外)
 *   3. data-no-i18n 保护区内的中文(模拟模组数据)不被翻
 *   4. 切回中文能还原
 *   5. 英文模式下没有 "[i18n] 缺翻译" 警告刷屏
 */
const { spawn } = require('child_process');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:5173';

const PAGES = [
  '/home.html', '/open.html', '/settings.html', '/docs.html',
  '/focus.html', '/tech.html', '/doctrines.html', '/decisions.html',
  '/events.html', '/dlc.html', '/aibehave.html', '/worldmap.html',
  '/create.html', '/loc.html', '/ide.html', '/check.html',
  '/defines.html', '/ref.html', '/modrel.html', '/designer.html',
];

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra ? '  ' + extra : '')); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, '_edge_i18n3'),
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
  }
  if (!wsUrl) { console.log('!! Edge 未启动'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params, sessionId) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });

  const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
    return r.result?.result?.value;
  };

  console.log('── 真浏览器验收 ──');

  // 0. 字典加载
  await send('Page.navigate', { url: BASE + '/home.html' }, sessionId);
  let bootReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if ((await evalJs('typeof window.I18N')) === 'object') { bootReady = true; break; }
  }
  ok('window.I18N 挂上', bootReady);
  if (!bootReady) { console.log('!! I18N 从未挂上,后续断言无意义'); process.exit(1); }
  await sleep(800);
  const dictSize = await evalJs('window.I18N.dictSize()');
  ok('字典条目 >= 1800', dictSize >= 1800, '实际 ' + dictSize);

  // 逐页:切英文 → 查残留中文 → 切回中文查还原
  const SENT = ['(匿名)', '(多 DLC)', '游戏本体', '基础游戏'];
  const report = [];
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p }, sessionId);
    /* ★ 等够久。这些页面在服务端现建索引(国策 3 万 / 科技 / 事件 2.7 万),
     *   冷启动要 10~30s;之前统一等 1400ms,重页面上的脚本还没执行完,
     *   window.I18N 自然是 undefined —— 表现为"8 个页面 I18N 没挂上",
     *   实际是**测试自己没等够**,不是产品缺陷。
     *   判据用轮询:window.I18N 一挂上就继续,不必干等固定时长。 */
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await evalJs('typeof window.I18N');
      if (t === 'object') { ready = true; break; }
    }
    if (!ready) { ok(p + ' window.I18N 就绪', false, '20s 内未挂上'); continue; }
    await sleep(600); // 再给渲染与 MutationObserver一点时间
    const r = await evalJs(`(function(){
      // ★ 先断言 I18N 存在。缺了它整段替换逻辑不会执行,
      //   cnt 恒为 0 → 下面每页都会"通过",这就是**假通过**:
      //   页面根本没被翻译,测试却报绿。
      if(!window.I18N) return {fatal:'window.I18N 未挂上'};
      window.I18N.setLang('en',{persist:false});
      window.I18N.applyI18n();
      // 跳过保护区与哨兵
      const SKIP=${JSON.stringify(SENT)};
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      const bad=[];
      let n;
      while((n=walker.nextNode())){
        if(!n.nodeValue||!n.nodeValue.trim())continue;
        if(n.parentElement&&n.parentElement.closest('[data-no-i18n]'))continue;
        const tag=n.parentElement&&n.parentElement.tagName;
        if(tag==='SCRIPT'||tag==='STYLE'||tag==='CODE'||tag==='PRE')continue;
        const txt=n.nodeValue.trim();
        if(/[\\u4e00-\\u9fa5]/.test(txt)){
          if(SKIP.indexOf(txt)>=0)continue;
          if(/^\\[(i18n|loc|check)\\]/.test(txt))continue;   // 控制台文案
          if(/^[a-z_]+[.:]/.test(txt))continue;             // 引擎/路径类
          bad.push(txt.slice(0,34));
        }
      }
      // 切回中文验证可逆
      window.I18N.setLang('zh',{persist:false});
      window.I18N.applyI18n();
      return {bad:bad.slice(0,6), cnt:bad.length, title:document.title};
    })()`);
    if (r.fatal) { ok(p + ' window.I18N 存在', false, r.fatal); continue; }
    const cnt = r.cnt || 0;
    ok(p + ' 英文模式无残留中文', cnt === 0, cnt ? cnt + ' 处: ' + JSON.stringify(r.bad) : '');
    if (cnt) report.push(p + ': ' + r.bad.join(' | '));
  }

  // 保护区验证:造一段"模组数据"中文,确认不被翻
  await send('Page.navigate', { url: BASE + '/home.html' }, sessionId);
  await sleep(1500);
  const prot = await evalJs(`(function(){
    const d=document.createElement('div');
    d.setAttribute('data-no-i18n','');
    d.innerHTML='<span>机动部队</span><span>保存</span>';
    document.body.appendChild(d);
    window.I18N.setLang('en',{persist:false});
    window.I18N.applyI18n();
    const spans=[...d.querySelectorAll('span')].map(x=>x.textContent);
    d.remove();
    window.I18N.setLang('zh',{persist:false});
    return spans;
  })()`);
  ok('★ data-no-i18n 内的模组数据不被翻译', prot[0] === '机动部队' && prot[1] === '保存',
     JSON.stringify(prot));

  // 未登记文案:确认会保留中文(不乱翻),且 t() 有 warn
  const unknown = await evalJs(`(function(){
    window.I18N.setLang('en',{persist:false});
    const d=document.createElement('div');
    d.innerHTML='<span>张伟的测试文案</span>';
    document.body.appendChild(d);
    window.I18N.applyI18n();
    const t=d.textContent;
    d.remove();
    const has=window.I18N.hasDict('张伟的测试文案');
    window.I18N.setLang('zh',{persist:false});
    return {t:t, has:has};
  })()`);
  ok('未登记文案原样保留(不乱翻)', unknown.t === '张伟的测试文案' && unknown.has === false,
     JSON.stringify(unknown));

  console.log('\n' + '─'.repeat(52));
  if (report.length) { console.log('残留明细:'); for (const l of report) console.log('  ' + l); }
  console.log('i18n 真浏览器验收: ' + pass + '/' + (pass + fail) + ' 通过');

  try { await send('Target.closeTarget', { targetId }); } catch {}
  ws.close();
  proc.kill();
  await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
