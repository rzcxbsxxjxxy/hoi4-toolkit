/* 用系统自带的 Edge 无头模式实测「科技树分类栏可拉伸 / 可折叠(CATH_V1)」。
 *
 * ★ 为什么不用 dom-stub:这个特性的全部价值在**真实布局**上
 *   (flex-wrap:nowrap 是否真的不再堆成十几行、拖动后 offsetHeight
 *   是否真的变、折叠后画布是否真的变高)。桩没有布局,测了等于没测。
 *
 * 做法:msedge --headless --remote-debugging-port,再用 CDP 走 WebSocket。
 * 零依赖(不装 puppeteer / 不装 agent-browser),只用 node 内置模块。
 */
const { spawn } = require('child_process')
const http = require('http')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const URL = process.argv[2] || 'http://127.0.0.1:5173/tech'

let pass = 0, fail = 0
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log('启动无头 Edge…')
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + require('os').tmpdir() + '/cdp-tech-' + Date.now(),
    '--window-size=1600,900',
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) { console.log('无法连上 DevTools'); process.exit(2) }
  const page = list.find((t) => t.type === 'page') || list[0]

  // 用 node 内置的 WebSocket(22.x 有全局 WebSocket)接 CDP
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
  /** 在页面里求值(带 await 支持) */
  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', {
      expression: '(async()=>{' + expr + '})()',
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }

  try {
    await cmd('Page.enable')
    await cmd('Runtime.enable')
    console.log('打开 ' + URL + '…')
    await cmd('Page.navigate', { url: URL })
    // 等 tech.js 建完图:节点数 > 0
    let ready = false
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      try { if (await evalJs(`return document.querySelectorAll('#canvas .tn,#canvas .node,#canvas rect').length>0 || (document.querySelector('#nodeCount')||{}).textContent!==''`)) { ready = true; break } } catch {}
    }
    ok('科技树渲染完成', ready)
    if (!ready) return

    /* ── 1. 分类栏不换行(这是用户报"领域占据过长"的根因) ── */
    const m1 = await evalJs(`
      const bar=document.getElementById('catbar'); if(!bar) return {err:'无#catbar'}
      const row=bar.querySelector('.catrow'); if(!row) return {err:'无.catrow'}
      const cs=getComputedStyle(row)
      return {
        wrap: cs.flexWrap,
        overflowX: cs.overflowX,
        barH: Math.round(bar.getBoundingClientRect().height),
        pills: row.children.length,
        rowH: Math.round(row.getBoundingClientRect().height),
        foldTxt: (document.getElementById('catFold')||{}).textContent,
        grip: !!document.getElementById('catGrip'),
      }`)
    ok('#catbar 存在', !m1.err, m1.err)
    ok('.catrow 是 nowrap(不换行)', m1.wrap === 'nowrap', m1.wrap)
    ok('.catrow 横向可滚', m1.overflowX === 'auto' || m1.overflowX === 'scroll', m1.overflowX)
    ok('领域胶囊超过 10 个(才有得堆)', m1.pills > 10, String(m1.pills))
    ok('分类栏只有一行高(不再堆成十几行)', m1.rowH < 70, m1.rowH + 'px')
    ok('有折叠按钮', /折叠/.test(m1.foldTxt || ''), m1.foldTxt)
    ok('有下沿拖动把手', m1.grip === true)

    /* ── 2. 拖动把手改高 ── */
    const m2 = await evalJs(`
      const bar=document.getElementById('catbar'), g=document.getElementById('catGrip')
      const before=Math.round(bar.getBoundingClientRect().height)
      const r=g.getBoundingClientRect()
      const mk=(t,y)=>new PointerEvent(t,{bubbles:true,clientX:Math.round(r.left+r.width/2),clientY:y,button:0,pointerId:1})
      g.dispatchEvent(mk('pointerdown', r.bottom))
      g.dispatchEvent(mk('pointermove', r.bottom-40))   // 往上拖 40 → 变高 40
      g.dispatchEvent(mk('pointerup',   r.bottom-40))
      await new Promise(r=>setTimeout(r,200))
      const after=Math.round(bar.getBoundingClientRect().height)
      const stored=localStorage.getItem('gui.tech.catH')
      return {before,after,stored,delta:after-before}`)
    ok('向上拖 → 分类栏变高', m2.after > m2.before + 10, `${m2.before} → ${m2.after}`)
    ok('高度已持久化到 gui.tech.catH', m2.stored === String(m2.after), 'stored=' + m2.stored)

    /* ── 3. 双击把手 = 恢复自适应 ── */
    const m3 = await evalJs(`
      const g=document.getElementById('catGrip')
      g.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))
      await new Promise(r=>setTimeout(r,300))
      return {stored:localStorage.getItem('gui.tech.catH'), h:Math.round(document.getElementById('catbar').getBoundingClientRect().height)}`)
    ok('双击把手清除固定高(恢复自适应)', m3.stored === null, 'stored=' + m3.stored)

    /* ── 4. 折叠 / 展开 ── */
    const m4 = await evalJs(`
      const bar=document.getElementById('catbar'), fold=document.getElementById('catFold')
      const stageBefore=Math.round(document.getElementById('stage').getBoundingClientRect().height)
      const before=Math.round(bar.getBoundingClientRect().height)
      fold.click()
      await new Promise(r=>setTimeout(r,400))
      const mid={h:Math.round(bar.getBoundingClientRect().height), cls:bar.className, txt:fold.textContent, stored:localStorage.getItem('gui.tech.catH')}
      const stageMid=Math.round(document.getElementById('stage').getBoundingClientRect().height)
      fold.click()
      await new Promise(r=>setTimeout(r,400))
      return {before,mid,stageBefore,stageMid,
        after:Math.round(bar.getBoundingClientRect().height),
        afterTxt:fold.textContent, afterCls:bar.className}`)
    ok('点折叠 → 高度压到 ≤24px', m4.mid.h <= 24, m4.mid.h + 'px')
    ok('折叠态打了 collapsed 类', /collapsed/.test(m4.mid.cls), m4.mid.cls)
    ok('折叠态文案变「展开」', /展开/.test(m4.mid.txt), m4.mid.txt)
    ok('折叠态已持久化 off', m4.mid.stored === 'off', m4.mid.stored)
    ok('折叠后画布变高', m4.stageMid > m4.stageBefore, `${m4.stageBefore} → ${m4.stageMid}`)
    ok('再点恢复原高度', Math.abs(m4.after - m4.before) <= 2, `${m4.before} → ${m4.after}`)
    ok('展开后文案复原', /折叠/.test(m4.afterTxt), m4.afterTxt)
    ok('展开后 collapsed 类已摘', !/collapsed/.test(m4.afterCls), m4.afterCls)

    /* ── 5. 快捷键 Mod+B ── */
    const m5 = await evalJs(`
      const bar=document.getElementById('catbar'), fold=document.getElementById('catFold')
      const before=Math.round(bar.getBoundingClientRect().height)
      document.body.focus()
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,400))
      const mid=Math.round(bar.getBoundingClientRect().height)
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,400))
      return {before,mid,after:Math.round(bar.getBoundingClientRect().height)}`)
    ok('Ctrl+B 折叠分类栏', m5.mid < m5.before - 10, `${m5.before} → ${m5.mid}`)
    ok('Ctrl+B 再按展开', Math.abs(m5.after - m5.before) <= 2, `${m5.before} → ${m5.after}`)

    /* ── 6. 刷新后记住折叠态(用户不该每次重设) ── */
    const m6a = await evalJs(`
      document.getElementById('catFold').click()
      await new Promise(r=>setTimeout(r,300))
      return localStorage.getItem('gui.tech.catH')`)
    ok('再次折叠记为 off', m6a === 'off', String(m6a))
    await cmd('Page.navigate', { url: URL })
    await sleep(3500)
    const m6b = await evalJs(`
      const bar=document.getElementById('catbar')
      return {h:Math.round(bar.getBoundingClientRect().height), cls:bar.className, stored:localStorage.getItem('gui.tech.catH')}`)
    ok('刷新后仍是折叠态', m6b.h <= 24 && /collapsed/.test(m6b.cls), JSON.stringify(m6b))
    // 复原,免得留下脏状态
    await evalJs(`try{localStorage.removeItem('gui.tech.catH')}catch(e){};return 1`)

    /* ── 7. 顶栏下拉不被盖住(问题 1 的实际验证) ── */
    const m7 = await evalJs(`
      const btn=[...document.querySelectorAll('#nav details, #nav .navitem')].find(e=>/内容|界面/.test(e.textContent||''))
      if(!btn) return {err:'没找到顶栏分组'}
      const dd=btn.querySelector('summary, .navhead')||btn
      dd.dispatchEvent(new MouseEvent('click',{bubbles:true}))
      await new Promise(r=>setTimeout(r,300))
      const pop=btn.querySelector('.navpop')||document.querySelector('.navpop')
      if(!pop) return {err:'下拉没打开'}
      const pr=pop.getBoundingClientRect()
      // 命中测试:取下拉里第一个可见项的中心点,看它最上层是谁
      const item=pop.querySelector('a,button,.navrow')||pop
      const ir=item.getBoundingClientRect()
      const hit=document.elementFromPoint(Math.round(ir.left+Math.min(20,ir.width/2)), Math.round(ir.top+ir.height/2))
      return {popZ:getComputedStyle(document.querySelector('header')||document.body).zIndex,
              inPop: !!(hit&&pop.contains(hit)), top: hit?(hit.className||hit.tagName):'null',
              rect:[Math.round(pr.top),Math.round(pr.height)]}`)
    ok('顶栏下拉可打开', !m7.err, m7.err || '')
    if (!m7.err) {
      ok('下拉项可被命中(没有被别的层盖住)', m7.inPop === true, 'top=' + m7.top)
    }

    await cmd('Page.captureScreenshot', {}).then(async (r) => {
      require('fs').writeFileSync(__dirname + '/_tech_cath.png', Buffer.from(r.data, 'base64'))
      console.log('  截图: _tech_cath.png')
    }).catch(() => {})
  } finally {
    try { ws.close() } catch {}
    try { child.kill() } catch {}
  }
  console.log('\n' + '═'.repeat(50))
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('THREW:', e.message); process.exit(2) })