// Headless Edge measurement of each GUI page load.
// Reports per-page: time-to-ready (ms), #requests, total transfer, and the slowest resources.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const WS = WebSocket // Node22 global

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 5173
const DBG = 9333
const BASE = 'http://127.0.0.1:' + PORT

const PAGES = [
  ['shell', '/'], ['home', '/home'], ['focus', '/focus'], ['check', '/check'],
  ['tracker', '/tracker'], ['tech', '/tech'], ['decisions', '/decisions'],
  ['aibehave', '/aibehave'], ['dlc', '/dlc'], ['worldmap', '/worldmap'],
  ['modrel', '/modrel'], ['defines', '/defines'], ['doctrines', '/doctrines'],
  ['create', '/create'], ['ide', '/ide'], ['designer', '/designer'],
  ['characters', '/characters'], ['units', '/units'], ['open', '/open'],
  ['settings', '/settings'], ['docs', '/docs'], ['loc', '/loc'],
  ['events', '/events'], ['ref', '/ref'], ['commondocs', '/commondocs'],
]

function pollJSON(url, ms) {
  const t0 = Date.now()
  return new Promise((res) => {
    const tick = () => {
      const req = require('node:http').get(url, (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d))
      })
      req.on('error', () => { if (Date.now() - t0 < ms) setTimeout(tick, 300); else res('') })
    }
    tick()
  })
}

function cdpc(ws, method, params) {
  return new Promise((res, rej) => {
    const id = ++cdpc._id
    const handler = (ev) => {
      let m; try { m = JSON.parse(ev.data || ev) } catch { return }
      if (m.id === id) { ws.removeEventListener('message', handler); res(m.result) }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}
cdpc._id = 0

function launchEdge() {
  const udd = 'C:/Users/123/AppData/Local/Temp/edge-measure-' + Date.now()
  const p = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--remote-debugging-port=' + DBG,
    '--user-data-dir=' + udd, 'about:blank',
  ], { stdio: 'ignore', detached: true })
  return { p, udd }
}

async function main() {
  const { p, udd } = launchEdge()
  // wait for debugger
  const ver = await pollJSON('http://127.0.0.1:' + DBG + '/json/version', 20000)
  if (!ver) { console.error('edge debug not up'); process.exit(1) }
  // pick a PAGE target (browser-level ws does not navigate)
  const list = await pollJSON('http://127.0.0.1:' + DBG + '/json/list', 10000)
  let pageWs = null
  try {
    const arr = JSON.parse(list)
    const pg = arr.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    pageWs = pg ? pg.webSocketDebuggerUrl : JSON.parse(ver).webSocketDebuggerUrl
  } catch { pageWs = JSON.parse(ver).webSocketDebuggerUrl }
  await new Promise((resolve, reject) => {
    ws = new WS(pageWs)
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  await cdpc(ws, 'Page.enable')
  await cdpc(ws, 'Runtime.enable')
  await cdpc(ws, 'Performance.enable')

  // warm-up (warm shared server caches)
  await cdpc(ws, 'Page.navigate', { url: BASE + '/home' })
  await new Promise((r) => setTimeout(r, 2500))

  const results = []
  for (const [name, path] of PAGES) {
    await cdpc(ws, 'Runtime.evaluate', { expression: 'performance.clearResourceTimings(); performance.clearMarks && performance.clearMarks();' })
    const nav = await cdpc(ws, 'Page.navigate', { url: BASE + path })
    // poll readiness
    let ready = -1
    const t0 = Date.now()
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 150))
      const e = await cdpc(ws, 'Runtime.evaluate', {
        expression: `(function(){var r=document.readyState;var lg=window.LoadGate;var busy=lg&&lg.busy&&lg.busy();var main=document.querySelector('main')||document.body;return JSON.stringify({rs:r,busy:!!busy,hc:!!(main&&main.children.length>1),t:performance.now()});})()`,
        returnByValue: true,
      })
      let st; try { st = JSON.parse(e.result.value) } catch { continue }
      if (st.rs === 'complete' && !st.busy && st.hc) { ready = Math.round(st.t); break }
      if (Date.now() - t0 > 18000) { ready = Math.round(st.t); break }
    }
    const perf = await cdpc(ws, 'Runtime.evaluate', {
      expression: `(function(){var nav=performance.getEntriesByType('navigation')[0]||{};var res=performance.getEntriesByType('resource').map(function(e){return {n:e.name.replace('${BASE}',''),d:Math.round(e.duration),tr:e.transferSize||0,dec:e.decodedBodySize||0,t:e.responseStart-e.requestStart};});res.sort(function(a,b){return b.d-a.d;});return JSON.stringify({dcl:Math.round(nav.domContentLoadedEventEnd||0),load:Math.round(nav.loadEventEnd||0),n:res.length,total:res.reduce(function(a,x){return a+x.tr;},0),slow:res.slice(0,5)});})()`,
      returnByValue: true,
    })
    let p; try { p = JSON.parse(perf.result.value) } catch { p = { dcl: -1, n: 0, total: 0, slow: [] } }
    results.push({ name, path, ready, dcl: p.dcl, load: p.load, reqs: p.n, transferKB: (p.total / 1024).toFixed(1), slow: p.slow })
    console.log(
      name.padEnd(12),
      'ready=' + String(ready).padStart(6) + 'ms',
      'dcl=' + String(p.dcl).padStart(6),
      'reqs=' + String(p.n).padStart(3),
      'xfr=' + (p.total / 1024).toFixed(0).padStart(4) + 'KB',
      '| slow: ' + (p.slow || []).map((s) => s.n.split('/').pop() + ':' + s.d + 'ms').join(', ')
    )
  }

  fs.writeFileSync('_measure_baseline.json', JSON.stringify(results, null, 2))
  try { p.kill('SIGKILL') } catch {}
  console.log('\nWROTE _measure_baseline.json')
}
let ws
main().catch((e) => { console.error(e); process.exit(1) })
