/* ══════════════════════════════════════════════════════════════════
 * verify_gridwire_oom.cjs —— GRIDWIRE_V2 的 OOM 回归验收(2026-10-07)
 *
 * 起因:GRIDWIRE_V1 的 release() 是 `occ.forEach(删id)` —— 遍历**整张**占用表,
 *   却被放在**每条边**的循环里。实测最大树(japan_wtt_focus 448 节点 / 655 边)
 *   在 `--max-old-space-size=512` 下**直接把 V8 打崩**,浏览器里就是 Out of Memory。
 *
 * 跑法(两个都要起):
 *   node --experimental-strip-types packages/gui/src/server.ts --port 8791
 *   msedge.exe --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>
 *   node tools/verify_gridwire_oom.cjs
 *
 * 判据:
 *   ① 两页首屏真渲染(节点>0)——就绪门必须含"节点数>0",
 *     ★只看 document.body 会假通过:脚本报错页/空页的 body 也有子节点。
 *   ② 连切 67 棵树全渲染,峰值堆个位数 MB 量级
 *   ③ 连点 201 个科技树页签,无异常
 *   ④ 拖拽 120 次 pointermove 不炸堆
 * ══════════════════════════════════════════════════════════════════ */

/* OOM 回归验收:无头Edge
 *  ① 国策树/科技树两页真实渲染(节点/边数 + 堆占用)
 *  ② ★ 连切全部 67 棵国策树 —— 用户报的 OOM 就是这个场景
 *  ③ 科技树反复筛选(每次 render 都重建占用表)
 *  ④ 拖拽节流验证
 * 判据都用 DOM 可见证据 + performance.memory,不靠 console 绿。 */
const BASE = 'http://127.0.0.1:8791'
const CDP = 'http://127.0.0.1:9333'

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiters = new Map()
  const errs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && waiters.has(m.id)) {
      const { res, rej } = waiters.get(m.id)
      waiters.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errs.push('[exception] ' + (d.exception?.description || d.text).split('\n')[0])
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      waiters.set(i, { res, rej })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evalJs = async (expr, awaitP = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  await send('Runtime.enable')
  await send('Page.enable')

  // 就绪门:★ 不能只看 body 有子节点(脚本报错页也恒过)
  const waitReady = async (probe, tries = 160) => {
    for (let i = 0; i < tries; i++) {
      if (await evalJs(`document.readyState==='complete' && !!document.body && document.body.children.length>0 && (${probe})`)) return true
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  }
  const heap = () => evalJs('performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):-1')

  // ────────── ① 国策树 ──────────
  errs.length = 0
  await send('Page.navigate', { url: BASE + '/focus.html' })
  const fOK = await waitReady(`document.querySelectorAll('#gNode > g.node').length>0`)
  console.log('=== ① 国策树 focus.html ===')
  console.log('  就绪:', fOK, ' 异常:', errs.length, errs.slice(0, 3).join(' | '))
  console.log('  ', await evalJs(`JSON.stringify({
    树:(document.querySelector('#treeSel')||{}).value,
    节点:document.querySelectorAll('#gNode > g.node').length,
    连线:document.querySelectorAll('#gEdge > path.edge').length,
    mutex边:document.querySelectorAll('#gEdge > path.edge.mutex').length,
    or边:document.querySelectorAll('#gEdge > path.edge.or').length,
    branch边:document.querySelectorAll('#gEdge > path.edge.branch').length,
    GridWireV2:!!(window.GridWire&&window.GridWire.clear)
  })`))
  console.log('   堆(MB):', await heap())

  // ────────── ① b 连切全部 67 棵树(用户报的 OOM 场景) ──────────
  errs.length = 0
  const t0 = Date.now()
  const sweep = await evalJs(`(async () => {
    const sel = document.querySelector('#treeSel');
    if (!sel) return {err:'no #treeSel'};
    const ids = [...sel.options].map(o=>o.value);
    let peak = 0, maxNodes = 0, done = 0;
    for (const id of ids) {
      sel.value = id;
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      await new Promise(r=>setTimeout(r,90));
      const n = document.querySelectorAll('#gNode > g.node').length;
      const e = document.querySelectorAll('#gEdge > path.edge').length;
      if (n>maxNodes) maxNodes=n;
      if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
      if (n>0) done++;
      if (!e && n>0) return {err:'边为0但有节点 @'+id, id};
    }
    return {trees:ids.length, rendered:done, maxNodes, peakMB: Math.round(peak/1048576)};
  })()`, true)
  console.log('\n=== ① b 连切全部国策树(原OOM 场景)===')
  console.log('  耗时', Date.now() - t0, 'ms')
  console.log('  ', JSON.stringify(sweep))
  console.log('  异常:', errs.length, errs.slice(0, 3).join(' | '))
  console.log('   堆(MB):', await heap())

  // ────────── ② 科技树 ──────────
  errs.length = 0
  await send('Page.navigate', { url: BASE + '/tech.html' })
  const tOK = await waitReady(`document.querySelectorAll('#gNode > g.node').length>0`)
  console.log('\n=== ② 科技树 tech.html ===')
  console.log('  就绪:', tOK, ' 异常:', errs.length, errs.slice(0, 3).join(' | '))
  console.log('  ', await evalJs(`JSON.stringify({
    节点:document.querySelectorAll('#gNode > g.node').length,
    连线:document.querySelectorAll('#gEdge > path.edge').length,
    xor边:document.querySelectorAll('#gEdge > path.edge.xor').length,
    gated节点:document.querySelectorAll('#gNode > g.node.gated').length,
    科技树页签:document.querySelectorAll('#catbar [data-kind="tree"]').length,
    folder页签:document.querySelectorAll('#catbar [data-kind="folder"]').length,
    GridWireV2:!!(window.GridWire&&window.GridWire.clear)
  })`))
  console.log('   堆(MB):', await heap())

  // ────────── ② b 反复点科技树页签(每次 render 重建占用表) ──────────
  errs.length = 0
  const t1 = Date.now()
  const clicks = await evalJs(`(async () => {
    const pills=[...document.querySelectorAll('#catbar [data-kind="tree"]')];
    if(!pills.length) return {err:'没有科技树页签'};
    let peak=0,maxNodes=0,hiddenOnly=0;
    for (let round=0; round<3; round++) {
      for (const p of pills) {
        p.click();
        await new Promise(r=>requestAnimationFrame(r));
        const n=document.querySelectorAll('#gNode > g.node').length;
        if(n>maxNodes)maxNodes=n;
        if(!n) {
          /* 有意容错:单节点且 hidden=true 的树(如 suicide_craft —— 无 categories,
             游戏里也没有标题栏)本来就会被「显示隐藏科技」开关滤掉。
             只有【本该有节点】却0 节点才是 bug。*/
          if (p.dataset.count !== '1') return {err:'多节点页签却0节点 @'+p.dataset.id, id:p.dataset.id};
          hiddenOnly++;
          continue;
        }
        if(performance.memory) peak=Math.max(peak,performance.memory.usedJSHeapSize);
      }
    }
    return {pills:pills.length, clicks:pills.length*3, maxNodes, hiddenOnly, peakMB:Math.round(peak/1048576)};
  })()`, true)
  console.log('\n=== ② b 连点全部科技树页签 ×3轮 ===')
  console.log('  耗时', Date.now() - t1, 'ms')
  console.log('  ', JSON.stringify(clicks))
  console.log('  异常:', errs.length, errs.slice(0, 3).join(' | '))
  console.log('   堆(MB):', await heap())

  // ────────── ③ 拖拽节流 ──────────
  errs.length = 0
  await send('Page.navigate', { url: BASE + '/focus.html' })
  await waitReady(`document.querySelectorAll('#gNode > g.node').length>0`)
  const drag = await evalJs(`(async () => {
    /* 必须先切到一棵大树的页签 —— 首屏那棵可能还没渲染完(索引在后台建) */
    const sel=document.querySelector('#treeSel');
    for (const id of ['japan_wtt_focus','german_focus','soviet_focus']) {
      if (sel && [...sel.options].some(o=>o.value===id)) {
        sel.value=id; sel.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,400));
          if(document.querySelectorAll('#gNode > g.node').length>0) break }
        break;
      }
    }
    const g=document.querySelector('#gNode > g.node');
    if(!g) return {err:'no node'};
    const r=g.getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:cx,clientY:cy,button:0,buttons:1}));
    let peak=0;
    for(let i=0;i<120;i++){
      window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx+i*0.5,clientY:cy+i*0.25,buttons:1}));
      await new Promise(r=>requestAnimationFrame(r));
      if(performance.memory) peak=Math.max(peak,performance.memory.usedJSHeapSize);
    }
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:cx+60,clientY:cy+30}));
    await new Promise(r=>requestAnimationFrame(r));
    return {peakMB:Math.round(peak/1048576), edges:document.querySelectorAll('#gEdge > path.edge').length, nodes:document.querySelectorAll('#gNode > g.node').length};
  })()`, true)
  console.log('\n=== ③ 拖拽 120 次 pointermove ===')
  console.log('  ', JSON.stringify(drag), ' 异常:', errs.length, errs.slice(0, 2).join(' | '))
  console.log('   堆(MB):', await heap())

  // ④ 首屏国策树为什么 0 节点:查 focus 图是否 ready
  console.log('\n=== ④ 首屏国策树诊断 ===')
  await send('Page.navigate', { url: BASE + '/focus.html' })
  for (let i=0;i<90;i++) {
    await new Promise((r)=>setTimeout(r,500))
    const n = await evalJs(`document.querySelectorAll('#gNode > g.node').length`)
    if (n>0){ console.log('  首屏最终渲染节点数',n,'(等了约',(i+1)*0.5,'秒)'); break }
    if (i===89) console.log('  90 秒后仍 0 节点;focus 图 ready =', await evalJs(`fetch('/api/stats').then(r=>r.json()).then(j=>j.focus)`))
  }

  ws.close()
  console.log('\n全部完成。')
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })