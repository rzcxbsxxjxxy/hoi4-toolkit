/** 截图留证(无头Edge + CDP) */
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const BASE = 'http://127.0.0.1:5173'
const OUT = process.env.HOI4_SHOT_DIR || 'D:/杂项/hoi4/toolkit'
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function pageWs() {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/json/new?${encodeURIComponent('about:blank')}`, method: 'PUT' }, (r) => {
      let b = ''; r.on('data', (c) => (b += c))
      r.on('end', () => { try { res(JSON.parse(b).webSocketDebuggerUrl) } catch (e) { rej(e) } })
    })
    req.on('error', rej); req.end()
  })
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data)
      if (m.id && this.w.has(m.id)) { const { res, rej } = this.w.get(m.id); this.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } })
  }
  send(method, params = {}) { const id = ++this.id
    return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)) } }, 60000) }) }
}
async function main() {
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + fs.mkdtempSync('D:/杂项/hoi4/toolkit/_edgeshot-'), 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 40; i++) { try { await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/version`, (r) => { r.resume(); res() }).on('error', rej)); break } catch { await sleep(400) } }
    const ws = new WebSocket(await pageWs())
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')

    // ① 世界地图(等模型就绪)
    await cdp.send('Page.navigate', { url: BASE + '/worldmap' })
    await sleep(22000)
    let r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT + '/worldmap-multi.png', Buffer.from(r.data, 'base64'))
    console.log('saved worldmap-multi.png')

    // ② 打开诊断抽屉
    await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#toggleDiag").click()' })
    await sleep(1200)
    r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT + '/worldmap-diag.png', Buffer.from(r.data, 'base64'))
    console.log('saved worldmap-diag.png')

    // ③ 模组关系
    await cdp.send('Page.navigate', { url: BASE + '/modrel' })
    await sleep(9000)
    r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT + '/modrel.png', Buffer.from(r.data, 'base64'))
    console.log('saved modrel.png')
  } finally { try { proc.kill('SIGKILL') } catch {} }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })