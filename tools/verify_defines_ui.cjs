/* 用系统自带 Edge 无头模式实测 defines 平衡参数页。
 *
 * ★ 为什么必须真浏览器:本页的判据全是"渲染 + 交互 + 真实布局":
 *   表格是否真出行数、分组树是否真填、点行后检查器是否真显示该键、
 *   搜索后是否真收敛、长数组是否真折叠。dom-stub 没有布局,测了等于没测。
 *
 * 做法:msedge --headless --remote-debugging-port,再用 CDP 走 WebSocket。
 * 零依赖(不装 puppeteer / agent-browser),只用 node 内置模块。
 */
const { spawn } = require('child_process')
const os = require('os')
const http = require('http')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const URL = process.argv[2] || 'http://127.0.0.1:5173/defines'

let pass = 0, fail = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')) }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

function httpJson(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let s = ''
      r.on('data', (d) => (s += d))
      r.on('end', () => { try { res(JSON.parse(s)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log('启动无头 Edge…')
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + os.tmpdir() + '/cdp-defines-' + Date.now(),
    '--window-size=1600,900',
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) {
    console.log('无法连上 DevTools(Edge 没起来?)')
    try { child.kill() } catch {}
    process.exit(2)
  }
  const page = list.find((t) => t.type === 'page') || list[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const cmd = (method, params) => new Promise((res, rej) => {
    const i = ++id
    waiting.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', {
      expression: '(async()=>{' + expr + '})()',
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }
  const errors = []
  const consoleErrors = []

  try {
    await cmd('Page.enable')
    await cmd('Runtime.enable')
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '?')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
    })
    console.log('打开 ' + URL + '…')
    await cmd('Page.navigate', { url: URL })

    /* ── 0. 页面加载完成(等异步解析 builds) ── */
    let ready = false
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      try {
        if (await evalJs(`const c=document.querySelector('#statChip');return !!c && !/解析中|失败/.test(c.textContent) && document.querySelectorAll('tr[data-key]').length>0`)) {
          ready = true; break
        }
      } catch {}
    }
    ok('页面数据加载完成(defines 异步解析)', ready)
    if (!ready) {
      console.log('  statChip=', await evalJs(`return (document.querySelector('#statChip')||{}).textContent`))
      console.log('  表格行数=', await evalJs(`return document.querySelectorAll('tr[data-key]').length`))
      console.log('  JS 错误:', errors.slice(0, 3), consoleErrors.slice(0, 3))
      return
    }

    /* ── 1. 表格真的渲染出键值行 ── */
    const rows = await evalJs(`return document.querySelectorAll('tr[data-key]').length`)
    ok('键值表已渲染', rows > 50, `${rows} 行`)

    const stat = await evalJs(`return document.querySelector('#statChip').textContent`)
    ok('统计显示 已显示/总数', /\d+\s*\/\s*\d+/.test(stat), stat)

    /* ── 2. 键名/值/行号三列都有真实内容 ── */
    const first = await evalJs(`
      const tr=document.querySelector('tr[data-key]');
      if(!tr) return null;
      return { key:tr.dataset.key,
               cells:[...tr.querySelectorAll('td')].map(td=>td.textContent.trim()),
               line:(tr.querySelector('.ln')||{}).textContent };
    `)
    ok('行结构含 键名/值/行号 三列', !!first && first.cells.length === 3, JSON.stringify(first && first.cells))
    ok('行号是数字(可跳 IDE)', !!first && /^\d+$/.test(first.line || ''), first && first.line)

    /* ── 3. 官方注释真的显示了(defines 的核心价值) ── */
    const hasCmt = await evalJs(`return document.querySelectorAll('.cmt').length`)
    ok('行内注释已渲染', hasCmt > 20, `${hasCmt} 条带注释`)

    /* ── 4. 值类型徽标 ── */
    const tags = await evalJs(`return document.querySelectorAll('.tg').length`)
    ok('类型徽标已渲染', tags > 10, `${tags} 个`)

    /* ── 5. 左侧分组树 ── */
    const gi = await evalJs(`return document.querySelectorAll('#grpList .gi').length`)
    ok('左栏分组树已填充', gi > 20, `${gi} 项(含"全部分组")`)

    /* ── 6. 点击行 → 检查器显示同键(核心交互) ── */
    await evalJs(`
      const tr=document.querySelector('tr[data-key]');
      tr.click();
      return 1;
    `)
    await sleep(600)
    const insp = await evalJs(`
      const box=document.querySelector('#insp');
      return { text:box.textContent.slice(0,260), rows:box.querySelectorAll('.kv2 b').length };
    `)
    ok('检查器被填充', insp.rows >= 4, `字段 ${insp.rows} 个`)
    ok('检查器显示完整键名', /N[A-Za-z]+\./.test(insp.text), insp.text.slice(0, 80))
    const selOk = await evalJs(`return document.querySelectorAll('tr[data-key].sel').length`)
    ok('被点行有选中态', selOk === 1, `${selOk} 行选中`)

    /* ── 7. 搜索真的收敛 ── */
    await evalJs(`
      const q=document.querySelector('#q');
      q.value='fuel';
      q.dispatchEvent(new Event('input'));
      return 1;
    `)
    await sleep(1400)
    const afterQ = await evalJs(`return {
      rows: document.querySelectorAll('tr[data-key]').length,
      chip: document.querySelector('#statChip').textContent,
      hitFuel: /[Ff]UEL/.test(document.querySelector('#groups').textContent),
    }`)
    ok('搜索后结果收敛', afterQ.rows > 0 && afterQ.rows < rows, `${rows} → ${afterQ.rows}`)
    ok('搜索结果确实含 FUEL 键', afterQ.hitFuel)
    ok('统计反映搜索后数量', /^\d+\s*\//.test(afterQ.chip), afterQ.chip)

    /* ── 8. 清空搜索恢复 ── */
    await evalJs(`
      const q=document.querySelector('#q');
      q.value='';
      q.dispatchEvent(new Event('input'));
      return 1;
    `)
    await sleep(1400)
    const restored = await evalJs(`return document.querySelectorAll('tr[data-key]').length`)
    ok('清空搜索后恢复', restored > afterQ.rows, `${afterQ.rows} → ${restored}`)

    /* ── 9. 分组筛选 ── */
    const grpRes = await evalJs(`
      const items=[...document.querySelectorAll('#grpList .gi')];
      const nGame=items.find(x=>/^NGame/.test(x.textContent));
      if(!nGame) return {err:'左栏没有 NGame'};
      nGame.click();
      return {ok:1};
    `)
    if (grpRes.err) ok('左栏存在 NGame 分组', false, grpRes.err)
    else {
      await sleep(1200)
      const gm = await evalJs(`return {
        heads:[...document.querySelectorAll('.grp>h3 span:first-child')].map(x=>x.textContent),
        rows: document.querySelectorAll('tr[data-key]').length,
      }`)
      ok('点击分组后只显示该组', gm.heads.length === 1 && gm.heads[0] === 'NGame', JSON.stringify(gm.heads))
      ok('分组内行数合理(20~60)', gm.rows > 20 && gm.rows < 60, `${gm.rows} 行`)
      const inGroup = await evalJs(`return [...document.querySelectorAll('tr[data-key]')].every(tr=>tr.dataset.key.startsWith('NGame.'))`)
      ok('所有行都属于该组', inGroup)
    }

    /* ── 10. 类型筛选下拉已填充 ── */
    const typeOpts = await evalJs(`return [...document.querySelectorAll('#typeSel option')].map(o=>o.value).filter(Boolean)`)
    ok('类型下拉有 5 种值类型', typeOpts.length >= 5, typeOpts.join(','))

    /* ── 11. 导航里有"平衡参数"入口 ── */
    const navHas = await evalJs(`
      const a=[...document.querySelectorAll('#nav a')].map(x=>x.getAttribute('href'));
      return a.includes('/defines');
    `)
    ok('顶栏导航含 /defines', navHas === true)

    /* ── 12. 右键菜单能弹出且有实质项 ── */
    await evalJs(`
      const tr=document.querySelector('tr[data-key]');
      tr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:200}));
      return 1;
    `)
    await sleep(400)
    const menu = await evalJs(`
      const items=[...document.querySelectorAll('.ctx-i')];
      return { n:items.length, text:items.map(x=>x.textContent.trim()) };
    `)
    ok('右键菜单已弹出', menu.n >= 4, `${menu.n} 项`)
    ok('菜单含"复制键名"', (menu.text||[]).some((t) => /复制键名/.test(t)), (menu.text||[]).slice(0,3).join(' / '))
    ok('菜单含"在 IDE 中打开"', (menu.text||[]).some((t) => /IDE/.test(t)))
    await evalJs(`
      document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
      return 1;
    `)
    await sleep(250)

    /* ── 13. 快捷键:按 / 聚焦搜索框 ── */
    const kbd = await evalJs(`
      document.body.focus();
      const q=document.querySelector('#q');
      q.blur();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true}));
      await new Promise(r=>setTimeout(r,120));
      return { active: document.activeElement && document.activeElement.id };
    `)
    ok('快捷键 / 聚焦搜索框', kbd.active === 'q', 'activeElement=' + kbd.active)

    /* ── 14. 快捷键 id 已在 keymap 目录注册(设置页才看得到) ── */
    const km = await evalJs(`
      if(!window.Keymap) return {err:'Keymap 未加载'};
      const mine=Keymap.ACTIONS.filter(a=>Array.isArray(a.pages)&&a.pages.includes('defines'));
      const wild=Keymap.ACTIONS.filter(a=>a.pages==='*');
      return { total:Keymap.ACTIONS.length, mine:mine.map(a=>a.id), wild:wild.length,
               pageListed: Keymap.PAGES.some(p=>p.id==='defines') };
    `)
    ok('keymap 目录含 defines 页专属动作', !km.err && km.mine.length >= 3,
      km.err ? km.err : `${km.mine.length} 个: ${(km.mine||[]).join(', ')}`)
    ok('keymap.PAGES 已登记 defines(设置页分组可见)', km.pageListed === true)

    /* ── 15. 无 JS 报错 ── */
    ok('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '))
    ok('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
  } catch (e) {
    fail++
    fails.push('异常: ' + e.message)
    console.log('  FAIL  运行异常 → ' + e.message)
  } finally {
    try { ws.close() } catch {}
    try { child.kill() } catch {}
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  if (fail) console.log('失败项:\n - ' + fails.join('\n - '))
  process.exit(fail ? 1 : 0)
})()
