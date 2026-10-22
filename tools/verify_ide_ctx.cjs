/* 验证 IDE:① ⎘ VS Code 按钮不再消失 ② 编辑区/大纲右键菜单(2026-10-10) */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.argv[2] || 5199)
const CDP = 9466
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PROF = path.join(os.tmpdir(), '_edgeprof_ide' + Date.now())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function get(p) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d }))
    }).on('error', () => res({ code: 0 }))
  })
}
function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)))
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
  console.log('== 等服务 ==')
  for (let i = 0; i < 200; i++) { const r = await get('/api/status'); if (r.code === 200) { try { if (JSON.parse(r.body).ready) break } catch (e) {} } await sleep(1000) }
  console.log('  ready')

  fs.mkdirSync(PROF, { recursive: true })
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + PROF,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'])
  await sleep(2500)
  let tg
  for (let i = 0; i < 30; i++) { try { tg = await cdpGet('/json/list'); if (tg.length) break } catch (e) {} await sleep(500) }
  const ws = new WebSocket(tg.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  const c = new C(ws)
  await c.send('Runtime.enable'); await c.send('Page.enable')
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/ide.html` })
  await sleep(4000)

  // 等文件树
  for (let i = 0; i < 40; i++) {
    const n = await c.eval(`document.querySelectorAll('#tree [data-path]').length`).catch(() => 0)
    if (n > 3) break
    await sleep(1000)
  }
  console.log('\n== ① 打开一个文件 ==')
  /* ★ 必须挑【有内容】的文件:1 行的空文件既没代码行也没大纲符号,
     右键菜单无从测(第一次就栽在这,误判成功能没实现)。 */
  let opened = null
  const cands = await c.eval(`[...document.querySelectorAll('#tree [data-path]')].filter(r=>/\\.(txt|gui|yml|lua|gfx)$/.test(r.dataset.path||'')).slice(0,25).map(r=>r.dataset.path)`)
  for (const p of cands) {
    await c.eval(`(()=>{const r=[...document.querySelectorAll('#tree [data-path]')].find(x=>x.dataset.path===${JSON.stringify(p)});if(r)r.click();return 1})()`)
    await sleep(1200)
    const n = await c.eval(`document.querySelectorAll('#code .ln').length`)
    if (n > 8) { opened = p; break }
  }
  console.log('  打开(有内容的)文件:', opened, ' 代码行:', await c.eval(`document.querySelectorAll('#code .ln').length`))
  await sleep(2500)
  const btn = await c.eval(`(()=>{const b=document.getElementById('openVscode');if(!b)return {存在:false};const r=b.getBoundingClientRect();return {存在:true,可见:r.width>0&&r.height>0,文本:b.textContent.trim(),父节点:!!b.parentElement}})()`)
  console.log('  ⎘ VS Code 按钮:', JSON.stringify(btn))
  const fname = await c.eval(`(()=>{const s=document.getElementById('fileName');return s?s.textContent:'#fileName 不存在'})()`)
  console.log('  标题区文件名:', fname)

  console.log('\n== ② 编辑区右键 ==')
  const codeRows = await c.eval(`document.querySelectorAll('#code .ln').length`)
  console.log('  代码行数:', codeRows)
  const codeMenu = await c.eval(`(()=>{
    const el=document.querySelector('#code .ln'); if(!el) return {err:'没有 .ln'};
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:300}));
    const m=document.getElementById('ctxMenu');
    return {菜单打开:m.classList.contains('on'), 项数:m.querySelectorAll('.ctx-item').length,
            首项:(m.querySelector('.ctx-item')||{}).textContent}
  })()`)
  console.log('  ', JSON.stringify(codeMenu))

  console.log('\n== ③ 大纲右键 ==')
  const olRows = await c.eval(`document.querySelectorAll('#tabOutline .ol-row').length`)
  console.log('  大纲行数:', olRows)
  const olMenu = await c.eval(`(()=>{
    document.getElementById('ctxMenu').classList.remove('on');
    const el=document.querySelector('#tabOutline .ol-row'); if(!el) return {err:'没有 .ol-row'};
    el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:300}));
    const m=document.getElementById('ctxMenu');
    const items=[...m.querySelectorAll('.ctx-item')].map(x=>x.textContent.trim());
    return {菜单打开:m.classList.contains('on'), 项数:items.length, 项:items.slice(0,6)}
  })()`)
  console.log('  ', JSON.stringify(olMenu))

  const ok1 = btn.存在 && btn.可见
  const ok2 = codeMenu.菜单打开 && codeMenu.项数 > 3
  const ok3 = olMenu.菜单打开 && olMenu.项数 > 3
  console.log('\n=== 判据 ===')
  console.log('  ① VS Code 按钮打开文件后仍在:', ok1 ? '✓' : '✗')
  console.log('  ② 编辑区右键出菜单:', ok2 ? `✓ (${codeMenu.项数} 项)` : '✗')
  console.log('  ③ 大纲右键出菜单:', ok3 ? `✓ (${olMenu.项数} 项)` : '✗')

  ws.close(); edge.kill()
  try { fs.rmSync(PROF, { recursive: true, force: true }) } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1)
})().catch((e) => { console.log('FAIL', e.message); process.exit(1) })
