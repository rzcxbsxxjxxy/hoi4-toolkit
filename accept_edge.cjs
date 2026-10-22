// 真机验收 · headless Edge 渲染校验
// 以「打包态」后端(server.mjs)为目标,用本机 Edge 加载 built UI,
// 校验:①页面渲染(关键节点存在) ②无致命 JS 错误 ③首屏就绪时间 ④截图存档。
// 输出 JSON 结论到 stdout,供验收脚本汇总。
const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = globalThis.WebSocket

const PORT = Number(process.env.HOI4TK_PORT || 5173)
const PAGE = process.env.ACCEPT_PAGE || '/'
const OUT_DIR = 'D:/杂项/hoi4/accept'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9333

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function findPageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = execSync(`curl -s http://127.0.0.1:${CDP_PORT}/json/list`).toString()
      const arr = JSON.parse(list)
      const t = arr.find((x) => x.type === 'page') || arr[0]
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl
    } catch {}
    await sleep(300)
  }
  throw new Error('找不到 Edge CDP 页面目标')
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=D:/accept_edge_profile',
    'about:blank',
  ], { stdio: 'ignore' })
  await sleep(2500)

  const wsUrl = await findPageWs()
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const onMsg = (resolve) => (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') console.error('[page-error]', JSON.stringify(m.params?.exceptionDetails?.exception || m.params))
  }
  await new Promise((res) => ws.addEventListener('open', res))
  ws.addEventListener('message', onMsg())

  function send(method, params = {}) {
    return new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, (m) => (m.error ? rej(m.error) : res(m.result)))
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${PAGE}` })

  // 等待首屏就绪:轮询直到 readyState=complete 且存在关键节点
  let readyMs = 0
  const t0 = Date.now()
  let ok = false
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ rs: document.readyState, title: document.title, hasNav: !!document.querySelector('nav,#nav,.nav,header'), bodyKids: document.body ? document.body.children.length : 0, i18n: typeof window.I18N })`,
      returnByValue: true,
    })
    const v = JSON.parse(r.result.value)
    readyMs = Date.now() - t0
    if (v.rs === 'complete' && (v.navHit = v.hasNav || v.bodyKids > 2)) { ok = true; break }
  }

  const final = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ rs: document.readyState, title: document.title, bodyKids: document.body ? document.body.children.length : 0, i18n: typeof window.I18N, url: location.href })`,
    returnByValue: true,
  })
  const snap = JSON.parse(final.result.value)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const safeName = (PAGE === '/' ? 'home' : PAGE.replace(/\W+/g, '_')) + '.png'
  fs.writeFileSync(path.join(OUT_DIR, safeName), Buffer.from(shot.data, 'base64'))

  ws.close()
  edge.kill('SIGKILL')
  console.log(JSON.stringify({ page: PAGE, readyMs, rendered: ok, snapshot: snap, screenshot: path.join(OUT_DIR, safeName) }, null, 2))
}

main().catch((e) => { console.error('ACCEPT_FAIL', e); process.exit(1) })
