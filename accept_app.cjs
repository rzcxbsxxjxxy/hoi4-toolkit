// 真机验收 · 已安装 Electron 程序 CDP 校验
// 连接安装版 app 暴露的 CDP(由启动参数 --remote-debugging-port 提供),
// 找到 BrowserWindow 页面目标,校验:①渲染(关键节点) ②无致命错误
// ③首屏就绪时间 ④截图存档。输出 JSON 结论。
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = globalThis.WebSocket

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = 'D:/杂项/hoi4/accept'
const PAGE = process.env.ACCEPT_PAGE || '/'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function findPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = execSync(`curl -s http://127.0.0.1:${CDP_PORT}/json/list`).toString()
      const arr = JSON.parse(list)
      // 选 type=page 且不是 devtools 自身的目标
      const t = arr.find((x) => x.type === 'page' && x.url && !x.url.includes('devtools')) || arr.find((x) => x.type === 'page')
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('找不到 app CDP 页面目标')
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const wsUrl = await findPageWs()
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  await new Promise((res) => ws.addEventListener('open', res))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params?.exceptionDetails?.exception
      errors.push(ex?.description || ex?.value || JSON.stringify(m.params?.exceptionDetails))
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, (m) => (m.error ? rej(m.error) : res(m.result)))
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  const t0 = Date.now()
  let ok = false, readyMs = 0
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ rs: document.readyState, title: document.title, hasNav: !!document.querySelector('nav,#nav,.nav,header'), bodyKids: document.body?document.body.children.length:0, i18n: typeof window.I18N, url: location.href })`,
        returnByValue: true,
      })
      const v = JSON.parse(r.result.value)
      readyMs = Date.now() - t0
      if (v.rs === 'complete' && v.bodyKids > 2) { ok = true; break }
    } catch {}
  }

  const final = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ rs: document.readyState, title: document.title, bodyKids: document.body?document.body.children.length:0, i18n: typeof window.I18N, url: location.href, status: (window.__bootStatus||'') })`,
    returnByValue: true,
  })
  const snap = JSON.parse(final.result.value)

  let shotPath = null
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const safeName = (PAGE === '/' ? 'app_home' : PAGE.replace(/\W+/g, '_')) + '.png'
    shotPath = path.join(OUT_DIR, safeName)
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  } catch (e) { errors.push('screenshot: ' + e.message) }

  const out = { page: PAGE, readyMs, rendered: ok, fatalErrors: errors, snapshot: snap, screenshot: shotPath }
  console.log(JSON.stringify(out, null, 2))
  ws.close()
}
main().catch((e) => { console.error('ACCEPT_FAIL', e); process.exit(1) })
