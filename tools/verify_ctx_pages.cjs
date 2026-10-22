/* 用系统自带 Edge 无头模式实测「右键菜单 + 快捷键」(RIGHTCLICK_V2)。
 *
 * ★ 为什么必须真浏览器:
 *   上一轮 8 页接线全部"代码写完、语法全绿",实际因 ctxwire.js 自身一个
 *   语法错(javadoc 里嵌了自闭合注释)导致 CtxWire 未定义、四页静默失效。
 *   桩测不出"脚本有没有真的挂上 window",真浏览器能。
 *
 * 跑法:node verify_ctx_pages.cjs [baseUrl]
 * 前置:服务已在baseUrl 上跑着。
 */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '')

let pass = 0, fail = 0, pageErr = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
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
/** 取一个 URL 的 HTTP 状态码。用于"公共件能不能取到"这种静态可达性判据。 */
function httpGet(url) {
  return new Promise((res) => {
    const u = new URL(url)
    http.get({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search }, (r) => {
      r.resume(); r.on('end', () => res(r.statusCode))
    }).on('error', () => res(0))
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log('启动无头 Edge…')
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + os.tmpdir() + '/cdp-ctx-' + Date.now(),
    '--window-size=1600,900', '--remote-debugging-port=' + PORT, 'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) { console.log('无法连上 DevTools'); process.exit(2) }
  const tgt = list.find((t) => t.type === 'page') || list[0]

  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  const logs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Log.entryAdded') logs.push('[log:' + m.params.entry.level + '] ' + m.params.entry.text)
    if (m.method === 'Runtime.exceptionThrown') {
      pageErr.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
    }
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const cmd = (method, params) => new Promise((res, rej) => {
    const i = ++id
    waiting.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
  const evalJs = async (expr) => {
    /* ★ 发到页面之前先在本地解析一遍。
     * 本脚本栽过两次:一段多写的 ')' 让 Runtime.evaluate 报
     * "Unexpected token ')'",而报错只说第 4 段、真正的问题在第 3 行,
     * 极难定位。**关键是按真实包装解析** —— 只数片段自身的括号会假阳性
     * (末尾那个 ')' 其实是 evalJs 调用的收尾,不是页面代码的一部分)。
     * 这里直接 new Function 出最终送进浏览器的那一整串,能过的才算能过。 */
    const wrapped = '(async()=>{' + expr + '})()'
    try {
      // eslint-disable-next-line no-new-func
      new Function(wrapped)
    } catch (e) {
      const first = expr.trim().split('\n')[0] || ''
      throw new Error(`evalJs 片段语法错: ${e.message}｜片段首行: ${first.slice(0, 70)}`)
    }
    const r = await cmd('Runtime.evaluate', {
      expression: wrapped, awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }
  /** 打开一页并等它安静下来。tries 是 500ms 的轮询次数(默认 40 次=20s)。 */
  async function open(path, waitFor, tries) {
    pageErr.length = 0
    await cmd('Page.navigate', { url: BASE + path })
    for (let i = 0; i < (tries || 40); i++) {
      await sleep(500)
      try { if (await evalJs('return !!(' + waitFor + ')')) return true } catch {}
    }
    return false
  }

  try {
    await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Log.enable')

    /* ═══ 0. 公共件真的挂上了(这是本轮最大的坑) ═══ */
    console.log('\n── 0. 公共件装载 ──')
    /* 公共件能从服务端取到。这一条看似废话,却是本轮最大的坑:
     * ctxwire.js / fullscreen.js 各出过一次"语法或运行时错",HTTP 200 照旧,
     * 但 window 上就是没挂上 —— 静态检查和桩测全都测不出来。 */
    const pub = ['/ctx.js', '/keys.js', '/keymap.js', '/ctxwire.js', '/fullscreen.js']
    const codes = await Promise.all(pub.map((u) => httpGet(BASE + u)))
    ok('公共件可取(5 个全部 200)', codes.every((c) => c === 200), pub.map((u, i) => u + '=' + codes[i]).join(' '))

    /* ═══ 1. 逐页:脚本无错 + 公共件在 + 右键能弹 ═══
     * ⚠ wait 必须等**真实数据节点**,不能只等骨架容器。
     *   骨架(#body / #tree)几乎立刻就有,数据要等服务端索引就绪
     *   (本地化首次要几秒)。只等骨架 → 后面所有选择器都打空,
     *   看起来像"功能坏了",其实只是没等够。这是本脚本第一版的坑。 */
    const pages = [
      { p: '/loc', wait: 'document.querySelector("#body td.v")', sel: '#body td.v', name: '本地化' },
      { p: '/dlc', wait: 'document.querySelector("#featList .item")', sel: '#featList .item', name: 'DLC' },
      { p: '/designer', wait: 'document.querySelector("#tree .tree-row")', sel: '#tree .tree-row', name: '设计器' },
      { p: '/create', wait: 'document.querySelector("#files .filetab")', sel: '#files .filetab', name: '生成' },
      { p: '/docs', wait: 'window.CtxWire && document.querySelector("#toc")', sel: '#doc h2', name: '教程' },
      { p: '/decisions', wait: 'document.querySelector("#catList .item")', sel: '#catList .item', name: '决议' },
      { p: '/events', wait: 'document.querySelector("#list .item")', sel: '#list .item', name: '事件' },
      { p: '/ref', wait: 'document.querySelector("#tree .doc")', sel: '#tree .doc', name: '文档查阅' },
    ]

    console.log('\n── 1. 八页:公共件装载 + 无脚本报错 ──')
    for (const pg of pages) {
      /* create 页的 filetab 要先生成才有,此时只等骨架;
         它的数据等待放到 1b 段做。 */
      const ready = await open(pg.p, pg.p === '/create' ? 'window.CtxWire && document.querySelector("#kindSel")' : pg.wait)
      const st = await evalJs(`return {
        ctx: typeof Ctx, keys: typeof Keys, km: typeof Keymap, cw: typeof CtxWire, fs: typeof Fullscreen,
        page: window.__KEYMAP_PAGE__ || null,
        err: null,
      }`)
      ok(pg.name + ' 公共件齐备', st.ctx === 'object' && st.keys === 'object' && st.km === 'object' && st.cw === 'object' && st.fs === 'object',
        JSON.stringify(st))
      ok(pg.name + ' 页 id 已声明', !!st.page, String(st.page))
      ok(pg.name + ' 无未捕获异常', pageErr.length === 0, pageErr.slice(0, 2).join(' | '))
      ok(pg.name + ' 已渲染', ready === true)
      void pg.sel
    }

    console.log('\n── 1b. 生成页:先产出一份产物才有右键目标 ──')
    {
      await open('/create', 'window.CtxWire && document.querySelector("#kindSel")', 30)
      const g = await evalJs(`
        // 走真实生成流程(等价于点「生成」按钮),产物 tab 才是右键对象
        const btns=[...document.querySelectorAll('button')].filter(b=>/生成/.test(b.textContent||''))
        if(!btns.length) return {err:'页面上没有「生成」按钮',
          all:[...document.querySelectorAll('button')].slice(0,10).map(b=>b.textContent)}
        btns[0].click()
        for(let i=0;i<40;i++){ if(document.querySelector('.filetab')) break; await new Promise(r=>setTimeout(r,200)) }
        return {n:document.querySelectorAll('.filetab').length}`)
      ok('生成页能产出文件 tab', g.n > 0, g.err || JSON.stringify(g))
    }

    /* ═══ 2. 右键真的弹菜单(逐页) ═══ */
    console.log('\n── 2. 右键弹菜单 ──')
    for (const pg of pages) {
      if (!pg.sel) { console.log('  SKIP  ' + pg.name + '(无右键目标)'); continue }
      let r = await open(pg.p, pg.wait)
      /* create 页的 filetab 是**生成产物**,重新导航就没了 —— 现场再生成一次。
         (第一版把它排在 pages 里当普通页,结果每轮都等不到,误报"页面就绪"失败) */
      if (pg.p === '/create') {
        r = await evalJs(`
          const btns=[...document.querySelectorAll('button')].filter(b=>/生成/.test(b.textContent||''))
          if(btns.length) btns[0].click()
          for(let i=0;i<40;i++){ if(document.querySelector('#files .filetab')) break; await new Promise(r=>setTimeout(r,200)) }
          return !!document.querySelector('#files .filetab')`)
      }
      if (!r) { ok(pg.name + ' 页面就绪', false); continue }
      const m = await evalJs(`
        const el=document.querySelector(${JSON.stringify(pg.sel)})
        if(!el) return {err:'找不到 '+${JSON.stringify(pg.sel)}}
        const box=el.getBoundingClientRect()
        const ev=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,
          clientX:Math.round(box.left+Math.min(30,box.width/2)), clientY:Math.round(box.top+Math.min(14,box.height/2))})
        el.dispatchEvent(ev)
        await new Promise(r=>setTimeout(r,250))
        const menu=document.getElementById('ctxMenuRoot')
        const items=menu?[...menu.querySelectorAll('.ctx-i .lb')].map(x=>x.textContent):[]
        return {n:items.length, items:items.slice(0,6),
                title:(menu&&menu.querySelector('.ctx-t')||{}).textContent||'',
                prevented: ev.defaultPrevented,           // 系统菜单应被吃掉
                visible: menu? menu.getBoundingClientRect().height>0 : false}`)
      ok(pg.name + ' 右键弹出菜单', m.n > 0, m.err || JSON.stringify(m))
      ok(pg.name + ' 菜单挡住了系统右键', m.prevented === true)
      ok(pg.name + ' 菜单真的可见', m.visible === true)
      if (m.n > 0) {
        console.log('        ' + m.items.join(' / '))
      }
    }

    /* ═══ 3. 右键菜单的项能真的执行(点一下复制) ═══
     * ⚠ 复制有**两条路**:navigator.clipboard.writeText(优先) 与 execCommand
     *   (fallback,legacy)。headless 里 clipboard 对象存在但调用会被拒,
     *   所以两条都得拦,只拦一条会误判成"没复制"。 */
    console.log('\n── 3. 菜单项可执行 ──')
    await open('/loc', 'document.querySelector("#body td.v")')
    const m3 = await evalJs(`
      window.__copied=null
      // ① clipboard 路线(分两步赋值,理由见第 4 段同处注释)
      const cb = { writeText: (t) => { window.__copied = String(t); return Promise.resolve() } }
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: cb }) } catch (e) {}
      // ② execCommand fallback 路线(ctx.js 的 legacy 会自己建 textarea)
      const orig=document.execCommand.bind(document)
      document.execCommand=(c)=>{ if(c==='copy'){ const ta=document.querySelector('textarea[readonly],textarea');
        window.__copied=ta?ta.value:''; return true } return orig(c) }
      const td=document.querySelector('#body td.v')
      const box=td.getBoundingClientRect()
      td.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,
        clientX:Math.round(box.left+20), clientY:Math.round(box.top+8)}))
      await new Promise(r=>setTimeout(r,250))
      const menu=document.getElementById('ctxMenuRoot')
      const items=[...menu.querySelectorAll('.ctx-i')]
      // 找「复制本地化 key」那一项点掉
      const t=items.find(i=>/复制本地化 key/.test(i.textContent||''))
      if(!t) return {err:'菜单里没有「复制本地化 key」', all:items.map(i=>i.textContent.trim()).slice(0,10)}
      t.click()
      await new Promise(r=>setTimeout(r,300))
      return {copied:window.__copied, toast:(document.getElementById('toast')||{}).textContent||''}`)
    ok('loc 右键有「复制本地化 key」', !m3.err, m3.err || '')
    ok('点了真的会复制', typeof m3.copied === 'string' && m3.copied.length > 0,
      String(m3.copied).slice(0, 40) + ' toast=' + m3.toast)

    /* ═══ 4. 快捷键:目录可改 + 真能触发 ═══
     * ⚠ Keymap.set 的签名是 set(id, comboString) —— **只两个参数**。
     *   写成 set(id, page, [keys]) 会把 page 当成 combo 存进 localStorage,
     *   然后 keysOf 读出来是 ['focus'] —— 看着像"改键没生效",其实是调错签名。 */
    /* ═══ 4. 快捷键:改键 → 刷新后真生效 ═══
     * ⚠ 两条容易踩的语义(都查过源码确认,不是猜):
     *   ① Keymap.set 的签名是 set(id, comboString) —— **只两个参数**。
     *      写成 set(id, page, [keys]) 会把 page 存成 combo,
     *      keysOf 读出来是 ['focus'] —— 看着像"改键没生效",其实是调错签名。
     *   ② keys.js 的 bind() 在**注册时**就把键位解析成 rec.keys 快照。
     *      所以 Keymap.set 之后**当前页面不重算**,必须刷新才生效 ——
     *      settings.js 第 676 行的 toast 就明写着「业务页刷新后生效」。
     *      早先在本页直接断言新键位,必失败,那是设计不是 bug。 */
    console.log('\n── 4. 快捷键(改键→刷新后生效) ──')
    // 先在 loc 页改键(sel.copyId 是 loc 页的动作)
    await open('/loc', 'document.querySelector("#body tr[data-r]")', 40)
    const m4a = await evalJs(`
      const setRes = Keymap.set('sel.copyId','mod+9')     // 复制 id 改成 Ctrl+9
      await new Promise(r=>setTimeout(r,200))
      return { setRes, before: Keymap.keysOf('sel.copyId',null),
               stored: Keymap.overrides()['sel.copyId'] }`)
    ok('改键后目录返回新键位', m4a.before.indexOf('mod+9') >= 0, JSON.stringify(m4a.before))
    ok('Keymap.set 报成功', m4a.setRes && m4a.setRes.ok === true, JSON.stringify(m4a.setRes))
    ok('新键位已持久化', m4a.stored === 'mod+9', String(m4a.stored))

    // 刷新后再验:新键位能触发、旧键位不再触发
    await open('/loc', 'document.querySelector("#body tr[data-r]")', 40)
    const m4b = await evalJs(`
      window.__copied2=null
      // ⚠ 拦剪贴板:headless 里 navigator.clipboard 存在但调用会被拒。
      //   故意**分两步**赋值而不是写嵌套对象字面量 —— 嵌套多行对象
      //   里的括号配对极难核对(本脚本第一版就栽在这,多写一个 ')' 却查不出)。
      const cb = { writeText: (t) => { window.__copied2 = String(t); return Promise.resolve() } }
      try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: cb }) } catch (e) {}
      // ⚠ 必须先**选中一个条目** —— sel.copyId 的语义是"复制当前选中项",
      //   没选中时它会 toast「先点选一个条目」而**故意不复制**。
      const row=document.querySelector('#body tr[data-r]')
      if(row) row.click()
      await new Promise(r=>setTimeout(r,250))
      const selRows=document.querySelectorAll('#body tr.sel').length
      // 新键位 mod+9
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'9',ctrlKey:true,bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,300))
      const newHit=String(window.__copied2||'').length>0
      const copied=String(window.__copied2||'').slice(0,60)
      // 旧键位 mod+c 应该不再触发
      window.__copied2=null
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,200))
      return {newHit, oldHit:String(window.__copied2||'').length>0, copied, selRows,
              page:window.__KEYMAP_PAGE__||null, keysNow:Keys.combo('sel.copyId')}`)
    ok('刷新后新键位真能触发', m4b.newHit === true,
      'copied=' + m4b.copied + ' sel行=' + m4b.selRows + ' page=' + m4b.page +
      ' 生效键位=' + JSON.stringify(m4b.keysNow))
    ok('刷新后旧键位不再触发', m4b.oldHit === false)
    /* 复原:改键是全局持久化的,不还原会污染后面所有跑的验证 */
    await evalJs(`Keymap.reset('sel.copyId'); return true`)

    /* ═══ 5. 速查表能打开(全局地基) ═══
     * ⚠ 速查表真实结构是 .sh-box(容器)+ .sh-r(每行),
     *   **没有 id、也不是 table** —— 早先按 '#keySheet / tr' 找,
     *   永远 found:false,看起来像 F1 坏了。 */
    console.log('\n── 5. 全局地基 ──')
    const m5 = await evalJs(`
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'F1',bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,400))
      const box=document.querySelector('.sh-box')
      const mask=document.querySelector('.sh-mask')
      const vis=box?getComputedStyle(box).display!=='none' && box.getBoundingClientRect().height>0:false
      const rows=box?box.querySelectorAll('.sh-r').length:0
      const groups=box?box.querySelectorAll('.sh-g').length:0
      // ⚠ 定位在 .sh-box / .sh-mask **自身**(fixed+z-index),不是外层 wrapper。
      //   查 wrapper 的 position 永远是 static —— 早先据此误判"不是浮层"。
      const bcs=box?getComputedStyle(box):null, mcs=mask?getComputedStyle(mask):null
      return {found:!!box, vis, rows, groups,
              boxPos:bcs?bcs.position:null, boxZ:bcs?bcs.zIndex:null,
              maskPos:mcs?mcs.position:null, maskZ:mcs?mcs.zIndex:null,
              inView:box?(function(){const r=box.getBoundingClientRect();
                return r.top>=0 && r.left>=0 && r.bottom<=innerHeight+2 && r.right<=innerWidth+2})():false}`)
    ok('F1 打开速查表', m5.vis === true, JSON.stringify(m5))
    ok('速查表有内容(按页列出条目)', m5.rows > 5, m5.rows + ' 行 / ' + m5.groups + ' 组')
    ok('速查表是浮层(压住页面)', m5.boxPos === 'fixed' && m5.maskPos === 'fixed',
      'box=' + m5.boxPos + '/' + m5.boxZ + ' mask=' + m5.maskPos + '/' + m5.maskZ)
    ok('浮层层级高于页面', Number(m5.boxZ) > 100 && Number(m5.maskZ) > 100, m5.boxZ + ' / ' + m5.maskZ)
    ok('速查表完整落在视口内(没被裁)', m5.inView === true)
    /* 关上,免得挡住后面的断言 */
    await evalJs(`document.querySelector('.sh-x') && document.querySelector('.sh-x').click(); return true`)

    /* ═══ 6. 全屏按钮在每页都挂上了 ═══
     * ⚠ nav.js 是异步建顶栏的,fullscreen.js 的 boot() 只在加载时试一次,
     *   剩下靠 nav.js 里 40×50ms 的重试兜底。所以这里必须**轮询等**,
     *   不能导航完立刻数 —— 早先一查就是 0,误报成"loc 页没全屏按钮"。 */
    console.log('\n── 6. 全屏按钮 ──')
    for (const pg of pages) {
      /* create 页等 filetab 会白等(重新导航后产物没了),只等骨架即可 ——
         这一段只验全屏按钮,与数据无关 */
      await open(pg.p, pg.p === '/create' ? 'window.CtxWire && document.querySelector("#kindSel")' : pg.wait, 40)
      const r = await evalJs(`
        let n=0, host=null
        for(let i=0;i<40;i++){
          n=document.querySelectorAll('#fsBtn').length
          if(n){ const b=document.getElementById('fsBtn')
                 host=b.parentElement?(b.parentElement.className||b.parentElement.id):null; break }
          await new Promise(r=>setTimeout(r,100))
        }
        const b=document.getElementById('fsBtn')
        return {n, host, label:b?b.textContent:null, supported:typeof Fullscreen.supported()==='boolean'?Fullscreen.supported():null,
                clickable:!!(b&&b.onclick)}`)
      ok(pg.name + ' 有且只有一个全屏按钮', r.n === 1, JSON.stringify(r))
      ok(pg.name + ' 全屏按钮可用', r.clickable === true && !!r.label, JSON.stringify(r))
    }

    console.log('\n── 页面控制台日志(前 8 条 warn/error) ──')
    logs.filter((l) => /error|warn/i.test(l)).slice(0, 8).forEach((l) => console.log('    ' + l.slice(0, 160)))
    if (!logs.filter((l) => /error/i.test(l)).length) console.log('    (无 error 级日志)')
  } finally {
    try { ws.close() } catch {}
    try { child.kill() } catch {}
  }
  console.log('\n' + '═'.repeat(56))
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('THREW:', e.message); process.exit(2) })