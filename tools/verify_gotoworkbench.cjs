/* 验证「保存并进入工作台」不再白屏(2026-10-10)
 *
 * 复现路径:壳(/) → 打开工程(/open.html,iframe 内) → 点「保存并进入工作台」
 * 旧 bug:open.js 在 iframe 里 location.href='/' → iframe 内又套一层 shell,
 *        壳内 shell 会隐藏导航 → 只剩外层导航条的白色画面。
 * 判据:  跳转后活动 iframe 的 src 必须是 /home(不是 /),
 *        且 iframe 内有可见内容、遮罩已收起。
 */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.argv[2] || 5199)
const CDP = 9444
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROF = path.join(os.tmpdir(), '_edgeprof_go' + Date.now())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res({ code: r.statusCode, body: d }))
      })
      .on('error', rej)
  })
}
function cdpGet(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
}

/* ── 极简 CDP 客户端(Node22 自带 WebSocket) ── */
class C {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m)
        this.pending.delete(m.id)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)))
      this.ws.send(JSON.stringify({ id, method, params }))
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(method + ' timeout'))
        }
      }, 30000)
      this.ws.addEventListener('close', () => clearTimeout(t))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
}

async function waitReady() {
  for (let i = 0; i < 240; i++) {
    const s = await get('/api/status')
    const j = JSON.parse(s.body)
    if (j.ready) return j
    await sleep(1000)
  }
  throw new Error('后端 240s 未 ready')
}

;(async () => {
  console.log('== 等后端 ready ==')
  await waitReady()
  console.log('   ready ✓')

  fs.mkdirSync(PROF, { recursive: true })
  const edge = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + CDP,
    '--user-data-dir=' + PROF,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1400,900',
    'about:blank',
  ])
  edge.on('error', (e) => console.log('edge spawn err', e.message))
  await sleep(2500)

  let targets
  for (let i = 0; i < 30; i++) {
    try {
      targets = await cdpGet('/json/list')
      if (targets.length) break
    } catch (e) {}
    await sleep(500)
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const c = new C(ws)
  await c.send('Runtime.enable')
  await c.send('Page.enable')

  console.log('== ① 打开壳 / ==')
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(3500)
  console.log('  当前活动 iframe src:', await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');return f?f.src:'(无)'})()`))

  console.log('== ② 切到「打开工程」页 ==')
  await c.eval(`window.shellSwitch('/open','/open.html?frame=1')`)
  await sleep(3000)
  const inOpen = await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');return f?f.src:'(无)'})()`)
  console.log('  活动 iframe src:', inOpen)
  console.log('  open 页在 iframe 内(parent!==window):', await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');return f&&f.contentWindow?f.contentWindow.parent!==f.contentWindow:null})()`))
  console.log('  「新建模组」区块是否已移除:', await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');if(!f||!f.contentDocument)return '?';return !f.contentDocument.querySelector('details.nm')})()`))
  console.log('  loadBtn 存在:', await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');if(!f||!f.contentDocument)return '?';return !!f.contentDocument.getElementById('loadBtn')})()`))

  console.log('== ③ 点「保存并进入工作台」 ==')
  await c.eval(`(()=>{const f=document.querySelector('#content iframe.on');f.contentDocument.getElementById('loadBtn').click();return 1})()`)

  // 轮询最终结果:最多等 180s(重建索引可能几十秒)
  let snap = null
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    snap = await c.eval(`(()=>{
      const f=document.querySelector('#content iframe.on');
      const g=document.getElementById('bootgate');
      let inner='?', children=-1;
      try{ const d=f&&f.contentDocument; if(d){ children=d.body?d.body.querySelectorAll('*').length:-1; inner=(d.title||'') } }catch(e){ inner='cross-origin' }
      return { src:f?f.src:'(无)', gateHidden:g?g.classList.contains('hide'):null,
               innerChildren:children, innerTitle:inner,
               frames:document.querySelectorAll('#content iframe').length }
    })()`)
    // ★ 必须等遮罩也收起才算通过:只看 src 会漏掉"遮罩挡住不收"这种
    //   比白屏更糟的情况(实测第一版就栽在这)。
    if (snap.src && /\/home/.test(snap.src) && snap.innerChildren > 5 && snap.gateHidden === true) break
  }
  console.log('  ★ 最终:', JSON.stringify(snap))

  const okSrc = /\/home/.test(snap.src || '')
  const okGate = snap.gateHidden === true
  const okContent = snap.innerChildren > 5
  console.log('\n=== 判据 ===')
  console.log('  ① 跳到工作台首页 /home(不是 /):', okSrc ? '✓' : '✗ ' + snap.src)
  console.log('  ② 加载遮罩已收起:', okGate ? '✓' : '✗')
  console.log('  ③ 页面有可见内容(非白屏):', okContent ? `✓ (${snap.innerChildren} 个节点, title="${snap.innerTitle}")` : '✗ 白屏')
  console.log('  ④ iframe 池大小(应 >1 且无嵌套 shell):', snap.frames)

  ws.close()
  edge.kill()
  try { fs.rmSync(PROF, { recursive: true, force: true }) } catch (e) {}
  process.exit(okSrc && okGate && okContent ? 0 : 1)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
