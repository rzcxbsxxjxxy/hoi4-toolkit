/* Edge 无头验证:军工机构树修复(多对多连线 + 独立框架)。
 * 真浏览器验证用本机 Edge(用户偏好),直连 page target 的 CDP(与 verify_vscode_protocol.cjs 同模式)。
 */
const { spawn } = require('child_process')
const http = require('http')
const os = require('os')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9336 + Math.floor(Math.random() * 50)
const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function httpJson(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

;(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + os.tmpdir() + '/cdp-mio-' + Date.now(),
    '--window-size=1600,900', '--remote-debugging-port=' + PORT, 'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) { console.log('无法连上 DevTools'); try { child.kill('SIGKILL') } catch {}; process.exit(2) }
  const tgt = list.find((t) => t.type === 'page') || list[0]

  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  const pageErr = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') pageErr.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const cmd = (method, params) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
  // ★ 表达式直接求值(returnByValue),所有 expr 必须是合法表达式(用 IIFE / 箭头返回,不要顶层 return)
  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }

  let pass = 0, fail = 0
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
  }

  try {
    await cmd('Page.enable'); await cmd('Runtime.enable')

    console.log('── MIO 树修复验证 ──')
    pageErr.length = 0
    await cmd('Page.navigate', { url: BASE + '/dlc.html' })
    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(400)
      try { if (await evalJs('!!document.querySelector("#featList") && typeof window.CtxWire !== "undefined"')) { ready = true; break } } catch {}
    }
    ok('dlc 页面装载(CtxWire 就绪)', ready)

    const featTexts = await evalJs('[...document.querySelectorAll("#featList .item")].map(e=>e.textContent.trim().slice(0,16))')
    console.log('    玩法列表=' + JSON.stringify(featTexts))

    const clicked = await evalJs(`(function(){ const items=[...document.querySelectorAll('#featList .item')]; const t=items.find(e=>/军工|MIO|military/i.test(e.textContent)); if(t){ if(typeof t.onclick==='function') t.onclick({}); else t.click(); return true } return false })()`)
    ok('点击军工机构玩法', clicked === true)

    let orgReady = false
    for (let i = 0; i < 50; i++) { await sleep(400); try { if (await evalJs('[...document.querySelectorAll("#dlcList .item")].some(e=>e.__obj&&e.__obj._k==="mioOrg")')) { orgReady = true; break } } catch {} }
    ok('机构清单加载(MIO 模式)', orgReady)
    const oc = await evalJs('[...document.querySelectorAll("#dlcList .item")].filter(e=>e.__obj&&e.__obj._k==="mioOrg").length')
    console.log('    机构数=' + oc)

    const orgDiag = await evalJs(`(function(){ const it=[...document.querySelectorAll('#dlcList .item')].find(e=>e.__obj&&e.__obj._k==='mioOrg'); if(!it) return JSON.stringify({found:false}); const id=it.__obj&&it.__obj.o?it.__obj.o.id:null; if(it.onclick) it.onclick({}); else it.click(); return JSON.stringify({found:true, id:id}) })()`)
    console.log('    orgDiag=' + orgDiag)
    let orgId = (() => { try { return JSON.parse(orgDiag).id } catch { return null } })()
    console.log('    选中机构(初选)=' + orgId)

    // ★ 优先挑一棵真有多父连线的机构,坐实"多对多时每条线都画"的修复
    //   (首棵可能全单父,看不出 bug#1 是否修好)。扫描前若干机构,取多父连线最多者。
    const pick = await evalJs(`(async()=>{
      const list=await (await fetch('/api/mio/tree')).json();
      const ids=(list.orgs||[]).map(o=>o.id);
      let best=null;
      for(const id of ids.slice(0,60)){
        const t=await (await fetch('/api/mio/tree?org='+encodeURIComponent(id))).json();
        let multi=0,total=0;
        for(const n of (t.nodes||[])) for(const lk of (n.links||[])){ total+=lk.parents.length; if(lk.parents.length>1) multi++; }
        if(multi>0 && (!best||multi>best.multi)) best={id,multi,total};
      }
      return JSON.stringify(best);
    })()`)
    let bestOrg = null
    try { bestOrg = JSON.parse(pick) } catch {}
    if (bestOrg && bestOrg.id && bestOrg.id !== orgId) {
      const swapped = await evalJs(`(function(){
        const it=[...document.querySelectorAll('#dlcList .item')].find(e=>e.__obj&&e.__obj._k==='mioOrg'&&e.__obj.o&&e.__obj.o.id===${JSON.stringify(bestOrg.id)});
        if(!it) return false;
        if(it.onclick) it.onclick({}); else it.click();
        return true;
      })()`)
      if (swapped) { orgId = bestOrg.id; console.log('    改选多父机构=' + orgId + ' (多父连线=' + bestOrg.multi + ')') }
    }

    let treeReady = false
    for (let i = 0; i < 80; i++) {
      await sleep(400)
      try { if (await evalJs('!!document.querySelector("#groups .mio-frame") && document.querySelectorAll("#groups .mio-n").length')) { treeReady = true; break } } catch {}
    }
    ok('特质树渲染(.mio-frame + 节点)', treeReady)

    const rendered = await evalJs('document.querySelectorAll("#groups .mio-links path").length')
    const exp = await evalJs(`(async()=>{ const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(${JSON.stringify(orgId)}))).json(); let s=0,nodes=0,multi=0; for(const nd of (d.nodes||[])){nodes++; for(const lk of (nd.links||[])){ s+=lk.parents.length; if(lk.parents.length>1) multi++; }} return JSON.stringify({exp:s,nodes,multi,org:d.org}) })()`)
    let expObj = { exp: -1, nodes: 0, multi: 0 }
    try { expObj = JSON.parse(exp) } catch {}
    console.log('    节点=' + expObj.nodes + '  多父连线=' + expObj.multi + '  期望连线(多父全画)=' + expObj.exp + '  实际渲染=' + rendered)
    ok('多对多连线全部绘制(渲染==parents 之和)', rendered === expObj.exp && expObj.exp > 0, 'rendered=' + rendered + ' exp=' + expObj.exp)

    const frame = await evalJs('!!document.querySelector("#groups .mio-frame") && !!document.querySelector(".mio-frame-head .mio-ftitle")')
    ok('MIO 独立框架(标题栏)存在', frame === true)
    const secs = await evalJs('document.querySelectorAll("#groups .mio-sec").length')
    const cols = await evalJs(`(async()=>{ const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(${JSON.stringify(orgId)}))).json(); return (d.columns||[]).length })()`)
    // 段落分隔数必须与数据里的列数一致(有的机构无 tree_header_text,secs=0 也正确)
    ok('列标题框架(段落分隔)渲染', secs === cols, 'secs=' + secs + ' cols=' + cols)
    const fbHidden = await evalJs(`(function(){var fb=document.querySelector("#featBar"); return fb? getComputedStyle(fb).display==="none":false})()`)
    ok('DLC 玩法切换条(上一级框架)已收起', fbHidden === true)

    await sleep(400)
    ok('无页面运行时异常', pageErr.length === 0, pageErr.slice(0, 2).join(' | '))

    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  } catch (e) {
    console.log('验证脚本异常: ' + e.message); fail++
  }
  try { child.kill('SIGKILL') } catch {}
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
