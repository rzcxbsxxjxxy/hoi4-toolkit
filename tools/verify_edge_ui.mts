/**
 * verify_edge_ui.mts —— 真浏览器验收(无头 Edge + CDP)
 *
 * ★ 就绪门三条件缺一不可(只判 document.body 会假通过):
 *   ① readyState==='complete' ② I18N 是对象 ③ body 有子节点。
 *   空页面(server 已死 → chrome-error://、脚本报错页)恒过前者的弱版本。
 * ★ 视口必须用 Emulation.setDeviceMetricsOverride —— Page.setViewport
 *   对 attached session 不可靠,实测仍是 800×600。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:17844'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 19222
const profile = mkdtempSync(join(tmpdir(), 'edge-verify-'))

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' })

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const j = await r.json()
      const page = j.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('拿不到 CDP target')
}

const target = await cdpTargets()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const waiters = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
}
function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => {
    waiters.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error('CDP 超时 ' + method)) } }, 60000)
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 异常')
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false })

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fail++
}

async function visit(path, readyExpr, label) {
  await send('Page.navigate', { url: BASE + path })
  /* 等就绪门 —— 不能固定 sleep:页面是异步渲染的 */
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const st = await evalJs(`(()=>{try{return{rs:document.readyState,i18n:typeof window.I18N==='object',kids:document.body?document.body.children.length:0,txt:(document.body?document.body.innerText:'').slice(0,400),html:document.body?document.body.children.length:0}}catch(e){return{err:String(e)}}})()`)
    if (st.rs === 'complete' && st.i18n && st.kids > 0) {
      if (!readyExpr) return st
      const v = await evalJs(readyExpr).catch(() => null)
      if (v) return { ...st, probe: v }
    }
  }
  return null
}

console.log('=== 打包态(server.mjs)真浏览器验收 ===\n')

/* ① 首页 */
const home = await visit('/', `!document.body.innerText.includes('读取中') && !document.body.innerText.includes('正在加载') ? document.body.innerText.length : 0`, 'home')
check('首页 就绪门三条件', !!home, home ? '' : '超时')
if (home) {
  console.log('   首页文本片段:', JSON.stringify(home.txt.replace(/\s+/g, ' ').slice(0, 110)))
  check('首页非空', (home.probe ?? home.txt.length) > 20)
}

/* ② 国策树(用户最初报的症状所在)。
 *   ⚠ 「正在」不等于故障:bootgate 遮罩的文案就是「正在初始化，请稍后」,
 *   它在数据到齐后自己撤掉。所以判据要看【遮罩是否还挡住 + 数据是否已渲染】,
 *   而不是全文搜「正在」—— 那样会把正常的等待文案判成残留。 */
const focus = await visit('/focus.html', `(()=>{const b=document.body;const t=b.innerText||'';
  const ov=document.getElementById('bootgate');
  return{len:t.length, canvas:document.querySelectorAll('svg,.tree,.focus-tree').length,
         overlay:!!ov, overlayShown:ov?!ov.classList.contains('hide'):false,
         tr:t.includes('tr("')}})()`, 'focus')
check('国策树页 就绪门', !!focus)
if (focus?.probe) {
  console.log('   国策树:', JSON.stringify(focus.probe))
  check('国策树有内容', focus.probe.len > 50)
  check('国策树遮罩已撤掉(#bootgate.hide)', !focus.probe.overlayShown)
  check('国策树无 tr(" 字面量(i18n 未污染)', !focus.probe.tr)
}

/* ③ 本地化(流式构建的产物) */
const loc = await visit('/loc.html', `(()=>{const t=document.body.innerText;return{len:t.length,n:(t.match(/\\n/g)||[]).length}})()`, 'loc')
check('本地化页 就绪门', !!loc)
if (loc?.probe) console.log('   本地化:', JSON.stringify(loc.probe))

/* ④ 搬进 worker 的各图接口 —— 必须用【页面 js 里真实调用的路径】。
 *   ⚠ 两个坑都踩过:
 *     1) 不要凭图的名字猜路径(我第一版猜 /api/tech-graph 全 404 ——
 *        真实是 /api/tech/graph,少一个斜杠段)。路径来源:grep public/*.js。
 *     2) 不要假设响应里有 `nodes` 字段 —— 各图投影不同:
 *        科技=stats.nodes、国策=trees[]、决议=categories[]、音乐=count、
 *        本地化=stats.entries。读错字段名会得到"0 条目"的假失败,
 *        而接口其实完全正常(实测 5 个假失败全是这个)。 */
const APIS = [
  ['/api/tech/graph', '科技图', (j) => j?.stats?.nodes ?? 0],
  ['/api/focus/graph', '国策图', (j) => j?.trees?.length ?? 0],
  ['/api/decisions/graph', '决议图', (j) => j?.categories?.length ?? 0],
  ['/api/doctrines/graph', '学说', (j) => j?.grand?.size ?? Object.keys(j?.grand ?? {}).length],
  ['/api/aibehave/graph', 'AI 行为', (j) => j?.aspects?.length ?? 0],
  ['/api/dlc/content', 'DLC 内容', (j) => j?.features?.size ?? Object.keys(j?.features ?? {}).length],
  ['/api/mio/tree', '军工机构', (j) => j?.orgs?.size ?? Object.keys(j?.orgs ?? {}).length],
  ['/api/defines', 'defines', (j) => j?.entries?.length ?? 0],
  ['/api/music', '音乐索引', (j) => j?.count ?? j?.songs?.length ?? 0],
  ['/api/loc/stats', '本地化', (j) => j?.entries ?? 0],
  ['/api/events/list', '事件图', (j) => (Array.isArray(j) ? j.length : j?.total ?? Object.keys(j).length)],
]
for (const [api, name, count] of APIS) {
  try {
    const r = await fetch(BASE + api)
    const ct = r.headers.get('content-type') ?? ''
    if (!ct.includes('json')) { check(`${name} 接口有数据`, false, `${r.status} 非 JSON`); continue }
    const j = await r.json()
    const n = count(j)
    check(`${name} 接口有数据`, r.status === 200 && n > 0, `${r.status} 条目 ${n}${j?.pending ? '(pending)' : ''}`)
  } catch (e) {
    check(`${name} 接口有数据`, false, e.message)
  }
}

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
ws.close()
edge.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)