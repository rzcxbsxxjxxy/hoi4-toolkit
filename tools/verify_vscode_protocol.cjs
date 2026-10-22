/* 用系统自带 Edge 无头模式实测「用 VS Code 打开」路径编码修复(VSCODE_PATH_V1)。
 *
 * ★ 背景:
 *   服务端 /api/open-external 在无法拉起 VS Code 时,会返回
 *   `protocol: vscode://file/<abs>:<line>:1` 交给浏览器接力。
 *   旧实现没对 <abs> 里的空格/括号编码,VS Code 把
 *   `C:/Program Files (x86)/Hearts of Iron IV/...` 按空格拆成
 *   Program / Files / Hearts / of / Iron 多个空白文件。
 *
 * 跑法:node verify_vscode_protocol.cjs [baseUrl]
 * 前置:服务已在 baseUrl 上跑着(root=0 是游戏目录,含空格路径)。
 */
const { spawn } = require('child_process')
const http = require('http')
const os = require('os')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9336
const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '')

let pass = 0, fail = 0, pageErr = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}
function httpJson(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log('启动无头 Edge…')
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + os.tmpdir() + '/cdp-vsp-' + Date.now(),
    '--window-size=1600,900', '--remote-debugging-port=' + PORT, 'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) { console.log('无法连上 DevTools'); child.kill('SIGKILL'); process.exit(2) }
  const tgt = list.find((t) => t.type === 'page') || list[0]

  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
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
  const evalJs = async (expr) => {
    const wrapped = '(async()=>{' + expr + '})()'
    const r = await cmd('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }

  try {
    await cmd('Page.enable'); await cmd('Runtime.enable')

    /* ── 1. 打开 IDE 页,确认脚本装载无异常 ── */
    console.log('\n── 1. IDE 页装载 ──')
    pageErr.length = 0
    await cmd('Page.navigate', { url: BASE + '/ide.html' })
    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try { if (await evalJs('return typeof openInLocalEditor === "function" && !!document.querySelector("#openVscode")')) { ready = true; break } } catch {}
    }
    ok('IDE 页已加载且 openInLocalEditor 就绪', ready)
    ok('IDE 页无未捕获异常', pageErr.length === 0, pageErr.slice(0, 2).join(' | '))

    /* ── 2. 复算期望的 protocol(与服务端同一算法) ── */
    const abs = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common/defines/00_defines.lua'
    const expected = await evalJs(`
      const abs = ${JSON.stringify(abs)};
      const vpath = abs.replace(/\\\\\\\\/g,'/').split('/').map(s=>encodeURIComponent(s)).join('/');
      return 'vscode://file/'+vpath+':5:1';
    `)
    console.log('  期望 protocol = ' + expected)

    /* ── 3. 真实请求 /api/open-external(游戏目录里一个真实文件, root=0) ── */
    console.log('\n── 2. 真实请求 /api/open-external ──')
    const j = await evalJs(`return (await fetch('/api/open-external?root=0&file=common/defines/00_defines.lua&line=5')).json()`)
    console.log('  响应 = ' + JSON.stringify(j))

    ok('open-external 返回 ok', j && j.ok === true, JSON.stringify(j).slice(0, 160))

    if (j && j.protocol) {
      // ★ 核心判据:路径被 URI 编码,不再含裸空格(旧 bug 会拆成 Program/Files/...)
      ok('protocol 含 %20(空格已编码)', /%20/.test(j.protocol), j.protocol)
      ok('protocol 含 %28x86%29(括号已编码)', /%28x86%29/i.test(j.protocol), j.protocol)
      ok('protocol 无裸空格(路径未被拆分)', !j.protocol.includes('Hearts of Iron'), j.protocol)
      ok('protocol 与期望编码一致', j.protocol === expected, j.protocol + '  vs  ' + expected)
    } else {
      // 走到了 code / 系统默认编辑器分支:说明服务端用数组传参拉起了编辑器,
      // 旧 bug 的唯一载体(protocol 分支)没触发 —— 同样证明修复无回归。
      ok('走 code/默认编辑器分支(via 存在)', !!j.via, JSON.stringify(j))
      console.log('  (未返回 protocol,改列期望编码串供人工比对: ' + expected + ')')
    }

    /* ── 4. 顺带确认其它页公共件装载无异常(防改动引入回归) ── */
    console.log('\n── 3. 回归:open 相关页无异常 ──')
    const regr = [
      { u: '/open.html', g: 'Fullscreen', label: 'open' },     // open.html 只引 fullscreen.js,不挂 Ctx/Keys
      { u: '/defines.html', g: 'Ctx', label: 'defines' },
    ]
    for (const pg of regr) {
      pageErr.length = 0
      await cmd('Page.navigate', { url: BASE + pg.u })
      let okp = false
      for (let i = 0; i < 20; i++) { await sleep(400); try { if (await evalJs('return typeof window.' + pg.g + ' !== "undefined"')) { okp = true; break } } catch {} }
      ok(pg.label + ' 公共件就绪(window.' + pg.g + ')', okp)
      ok(pg.label + ' 无未捕获异常', pageErr.length === 0, pageErr.slice(0, 2).join(' | '))
    }
  } catch (e) {
    console.log('验证脚本异常: ' + e.message)
    fail++
  } finally {
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
    try { ws.close() } catch {}
    child.kill('SIGKILL')
    process.exit(fail ? 1 : 0)
  }
})()
