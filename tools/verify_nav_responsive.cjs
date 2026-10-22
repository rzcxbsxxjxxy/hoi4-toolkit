/* 验证「后端构建期间点导航是否有反应」(2026-10-10)
 *
 * 旧 bug:nav.js 把切页串行依赖在 /api/status 之后,而符号库构建 88s 期间
 *   该请求连续 5s 超时 → 点击后几十秒页面都不切("点不动")。
 * 方法:服务刚启动(构建高峰)就用无头 Edge 反复点「国策树」,
 *   测【点击 → iframe src 变成 /focus】的延迟;同时并行探测 /api/status 延迟。
 * 判据:每次点击的切页延迟都应 < 3s(修复前是几十秒甚至不切)。
 */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.argv[2] || 5199)
const CDP = 9455
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROF = path.join(os.tmpdir(), '_edgeprof_nav' + Date.now())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p, timeoutMs = 8000) {
  return new Promise((res) => {
    const t0 = Date.now()
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res({ ms: Date.now() - t0, code: r.statusCode, body: d }))
    })
    req.on('error', (e) => res({ ms: Date.now() - t0, code: 0, err: e.code }))
    req.setTimeout(timeoutMs, () => { req.destroy(); res({ ms: Date.now() - t0, code: -1, timeout: true }) })
  })
}
function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
  })
}
class C {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, (m) => (m.error ? rej(new Error(method)) : res(m.result)))
      this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value }
}

;(async () => {
  console.log('== 等服务端口 ==')
  for (let i = 0; i < 120; i++) {
    const r = await get('/api/status', 2000)
    if (r.code === 200) break
    await sleep(500)
  }
  console.log('  端口就绪,开始测试(此刻后端正在构建高峰)')

  fs.mkdirSync(PROF, { recursive: true })
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + PROF,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'])
  await sleep(2500)
  let targets
  for (let i = 0; i < 30; i++) { try { targets = await cdpGet('/json/list'); if (targets.length) break } catch (e) {} await sleep(500) }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const c = new C(ws)
  await c.send('Runtime.enable'); await c.send('Page.enable')
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(3000)
  // ★ 后端构建高峰时首屏 module 加载慢,必须轮询等 shellSwitch 挂上
  //   (它是 nav.js 这个 module 在 mountNav 里赋的 window 全局)
  for (let i = 0; i < 60; i++) {
    const ok = await c.eval(`typeof window.shellSwitch === 'function'`).catch(() => false)
    if (ok) break
    await sleep(500)
  }
  console.log('  shellSwitch 就绪:', await c.eval(`typeof window.shellSwitch === 'function'`))

  console.log('\n== 反复点「国策树」,测切页延迟 ==')
  const rows = []
  for (let i = 0; i < 25; i++) {
    // 先回首页,再从首页点国策树(模拟用户真实点击)
    await c.eval(`window.shellSwitch('/home','/home.html?frame=1'); 1`)
    await sleep(300)
    const t0 = Date.now()
    await c.eval(`(()=>{const a=[...document.querySelectorAll('#nav a[href]')].find(x=>/focus/.test(x.getAttribute('href')));if(a){a.click();return a.getAttribute('href')}return null})()`)
    let switched = -1
    for (let k = 0; k < 40; k++) { // 最多等 4s
      await sleep(100)
      const src = await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');return f?f.src:''})()`)
      if (/\/focus/.test(src)) { switched = Date.now() - t0; break }
    }
    const st = await get('/api/status', 8000)
    let j = {}
    try { j = JSON.parse(st.body || '{}') } catch (e) {}
    rows.push({ i: i + 1, 切页ms: switched, statusMs: st.ms, phase: j.phase || (j.ready ? '(ready)' : '(building)') })
    console.log(`  #${i + 1} 切页 ${switched < 0 ? '未切换(>4s)' : switched + 'ms'}  /api/status ${st.ms}ms  ${j.phase || (j.ready ? '(ready)' : '(building)')}`)
    await sleep(1200)
  }

  const bad = rows.filter((r) => r.切页ms < 0 || r.切页ms > 3000)
  const slowStatus = rows.filter((r) => r.statusMs > 1500)
  console.log('\n=== 判据 ===')
  console.log('  ① 25 次点击全部在 3s 内切页:', bad.length === 0 ? '✓' : `✗ ${bad.length} 次超时`)
  console.log('  ② /api/status 无 >1.5s 卡顿:', slowStatus.length === 0 ? '✓' : `✗ ${slowStatus.length} 次(最慢 ${Math.max(...rows.map((r) => r.statusMs))}ms)`)
  console.log('  切页延迟 中位数:', rows.map((r) => r.切页ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] + 'ms')

  ws.close(); edge.kill()
  try { fs.rmSync(PROF, { recursive: true, force: true }) } catch (e) {}
  process.exit(bad.length === 0 && slowStatus.length === 0 ? 0 : 1)
})().catch((e) => { console.log('FAIL', e.message); process.exit(1) })
