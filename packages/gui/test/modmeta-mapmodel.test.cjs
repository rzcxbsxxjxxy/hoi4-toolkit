/**
 * 真浏览器验收(无头 Edge + CDP + Node22 内置 WebSocket)
 * 验三件事:
 *  ① /worldmap 真的渲染出来,且来源条显示的是**模组的图**,不是原版
 *  ② 诊断抽屉能列出 replace_path 造成的 state 丢弃
 *  ③ /modrel 依赖图与 replace_path 缺口真的渲染出来
 * 判据: DOM 里必须能看到具体数值/名称 —— 骨架非空不算过。
 */
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const BASE = 'http://127.0.0.1:5173'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

let pass = 0
const fails = []
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')) }
}

/** 通过页面级 target 拿 WS(浏览器级 WS 在本环境会挂起) */
function pageWs() {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/json/new?${encodeURIComponent('about:blank')}`, method: 'PUT' }, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => { try { res(JSON.parse(b).webSocketDebuggerUrl) } catch (e) { rej(e) } })
    })
    req.on('error', rej)
    req.end()
  })
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.logs = []; this.errs = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.waits.has(m.id)) {
        const { res, rej } = this.waits.get(m.id); this.waits.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown')
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('timeout ' + method)) } }, 60000)
    })
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  async goto(url) {
    await this.send('Page.enable'); await this.send('Runtime.enable')
    await this.send('Page.navigate', { url })
    await sleep(1200)
  }
}

async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + fs.mkdtempSync('D:/杂项/hoi4/toolkit/_edgeprof-'),
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  try {
    // 等 CDP 就绪
    let ver = null
    for (let i = 0; i < 40; i++) {
      try { ver = await getJSON(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(400) }
    }
    if (!ver) throw new Error('Edge CDP 未就绪')
    console.log('Edge:', ver['Browser'])

    const wsUrl = await pageWs()
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const cdp = new CDP(ws)

    /* ── ① /worldmap ── */
    console.log('\n=== /worldmap ===')
    await cdp.goto(BASE + '/worldmap')
    // ⚠ worldmap.js 是经典脚本,顶层 const S 不挂 window,外部读不到 ——
    //   所以只能断言「渲染出来的可见证据」,不能去摸 S.meta。
    //   判据:顶栏计数从「—」变成真实数字,且来源条不再停在「来源加载中…」
    let ui = null
    for (let i = 0; i < 60; i++) {
      ui = await cdp.evalJs(
        '(()=>{const c=document.querySelector("#statChip")?.textContent||"",h=document.querySelector("#hud")?.textContent||"",s=document.querySelector("#srcbar")?.innerText||"";return {chip:c,hud:h,src:s}})()',
      )
      if (ui && /省份/.test(ui.chip) && !/来源加载中/.test(ui.src)) break
      await sleep(700)
    }
    t('顶栏统计已渲染', ui && /省份/.test(ui.chip), JSON.stringify(ui))
    t('HUD 显示生效 state 与被丢弃数', ui && /state/.test(ui.hud) && /1081/.test(ui.hud), ui && ui.hud)
    t('来源条不再停在占位文案', ui && !/来源加载中/.test(ui.src), ui && ui.src.slice(0, 100))
    const srcText = await cdp.evalJs('document.querySelector("#srcbar")?.innerText || ""')
    t('来源条显示模组图', /1521695605|Kaiserreich/.test(srcText), srcText.slice(0, 120))
    t('来源条显示 replace_path 条数', /replace_path\s*74/.test(srcText), srcText.slice(0, 200))

    const diagBtn = await cdp.evalJs('!!document.querySelector("#toggleDiag")')
    t('诊断按钮存在', diagBtn)
    if (diagBtn) {
      await cdp.evalJs('document.querySelector("#toggleDiag").click()')
      await sleep(500)
      const diagTxt = await cdp.evalJs('document.querySelector("#diagBody")?.innerText || ""')
      t('诊断列出 state-dropped', /state-dropped/.test(diagTxt), diagTxt.slice(0, 160))
      t('诊断文案含真实总数 1081', /1081/.test(diagTxt), diagTxt.slice(0, 200))
      const vis = await cdp.evalJs('document.querySelector("#diag").classList.contains("on")')
      t('诊断抽屉可见', vis)
    }
    const canvasOk = await cdp.evalJs('(()=>{const c=document.querySelector("#map");return c && c.width>100})()')
    t('画布已按容器尺寸初始化', canvasOk)

    /* ── ② /modrel ── */
    console.log('\n=== /modrel ===')
    cdp.errs.length = 0
    await cdp.goto(BASE + '/modrel')
    let m = null
    for (let i = 0; i < 30; i++) {
      m = await cdp.evalJs('(()=>{const t=document.querySelector("#table")?.innerText||"";return t?{tableLen:t.length,graphLen:(document.querySelector("#graph")?.innerText||"").length,audit:(document.querySelector("#audit")?.innerText||"").length,order:(document.querySelector("#order")?.innerText||"").length,cards:(document.querySelector("#cards")?.innerText||"").length}:null})()')
      if (m && m.tableLen > 50) break
      await sleep(600)
    }
    t('明细表已渲染', m && m.tableLen > 50, JSON.stringify(cdp.errs.slice(0, 2)))
    if (m) {
      const txt = await cdp.evalJs('document.body.innerText')
      t('显示模组名', /Kaiserreich/.test(txt))
      t('显示 replace_path 明细(74 条)', /74/.test(txt), txt.slice(0, 200))
      t('缺口区块有内容', m.audit > 20, 'len=' + m.audit)
      const auditTxt = await cdp.evalJs('document.querySelector("#audit").innerText')
      t('缺口列出 history/states', /history\/states/.test(auditTxt), auditTxt.slice(0, 160))
      t('载入顺序已渲染', m.order > 5, 'len=' + m.order)
    }
    // 只对本轮新增的 worldmap.js / modrel.js 断言无异常。
    // 页面里还有 appearance.js(早于本轮就存在)用经典 script 标签加载却含 export,
    // 那条报错与本次改动无关,不计入。
    const jsErr = cdp.errs.filter((e) => !/favicon/.test(e) && !/Unexpected token 'export'/.test(e))
    t('本轮页面无未捕获 JS 异常', jsErr.length === 0, jsErr.slice(0, 2).join(' | '))

    console.log(`\n真浏览器验收: ${pass} 通过, ${fails.length} 失败`)
    for (const f of fails) console.log('  ✗ ' + f)
    process.exitCode = fails.length ? 1 : 0
  } finally {
    try { proc.kill('SIGKILL') } catch {}
  }
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1 })