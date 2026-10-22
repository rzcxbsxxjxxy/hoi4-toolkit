/* verify_settings_perf.ts —— 真浏览器验证「构建并发度」设置卡(2026-10-10)
 *
 * 铁律:HTTP 200 + 语法绿 ≠ 功能在。
 * 必须满足就绪门:readyState==='complete' && I18N 已挂 && body 有子元素,
 * 否则空页面(server 死了/脚本报错)也会"全绿"。
 */
import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 8792)
const URL = `http://localhost:${PORT}/settings.html`

function cdp(ws: string): Promise<any> {
  // 极简 CDP 客户端:只用到 Runtime.evaluate 与 Page.navigate
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws)
    let id = 0
    const pending = new Map<number, (v: any) => void>()
    sock.onopen = () => resolve({
      send: (method: string, params: unknown) => {
        const mid = ++id
        sock.send(JSON.stringify({ id: mid, method, params }))
        return new Promise((res) => pending.set(mid, res))
      },
      close: () => sock.close(),
    })
    sock.onerror = reject
    sock.onmessage = (e: MessageEvent) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m)
        pending.delete(m.id)
      }
    }
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-'))
  const port = 9222 + Math.floor(Math.random() * 300)
  const proc = spawn(
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  try {
    // 等 CDP 端口就绪
    let list: any = null
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`)
        list = await r.json()
        if (list.length) break
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!list || !list.length) throw new Error('CDP 未就绪')
    const page = list.find((t: any) => t.type === 'page') || list[0]
    const cli = await cdp(page.webSocketDebuggerUrl)
    await cli.send('Runtime.enable', {})
    await cli.send('Page.enable', {})
    await cli.send('Page.navigate', { url: URL })
    await new Promise((r) => setTimeout(r, 2000))

    const evalJs = async (expr: string): Promise<any> => {
      const r = await cli.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      return r?.result?.result?.value
    }

    /* ★ 就绪门 —— 少了这条,空页面也会判"全绿"(实测踩过)。
     *   readyState 必须是 complete:设置页脚本在解析期就调 tr(),
     *   interactive 阶段 DOM 还没建完,此时断言会得到 false 假象。
     *   故轮询等待,不设固定 sleep。 */
    let ready = ''
    for (let i = 0; i < 25; i++) {
      ready = String(
        await evalJs(
          `(document.readyState === 'complete' && typeof window.I18N === 'object' && document.body.children.length > 0) ? 'READY' : 'WAIT:state=' + document.readyState + ',kids=' + document.body.children.length`,
        ),
      )
      if (ready === 'READY') break
      await new Promise((r) => setTimeout(r, 400))
    }
    console.log('就绪门:', ready)
    if (String(ready).startsWith('NOT_READY')) {
      console.log('✗ 页面未就绪,后续断言不可信 —— 抓 body 前 400 字:')
      console.log((await evalJs('document.body.innerHTML.slice(0,400)')) || '(空)')
      process.exit(1)
    }

    console.log('\n=== 断言 ===')
    let pass = true
    const check = (name: string, v: unknown, want: string) => {
      const okStr = String(v).includes(want)
      console.log(`${okStr ? '✓' : '✗'} ${name}: ${String(v).slice(0, 110)}`)
      if (!okStr) pass = false
    }

    check('页面标题含"设置"', await evalJs('document.title'), '设置')
    check('perf 卡片存在', await evalJs(`!!document.getElementById('perf')`), 'true')
    check('并发度下拉存在', await evalJs(`!!document.getElementById('p_conc')`), 'true')
    check('线程上限下拉存在', await evalJs(`!!document.getElementById('p_cap')`), 'true')
    check('探测缓存输入存在', await evalJs(`!!document.getElementById('p_ttl')`), 'true')
    check('重新测量按钮存在', await evalJs(`!!document.getElementById('perfProbeBtn')`), 'true')

    // perfInfo 应被 /api/perf 填充(轮询等待)
    for (let i = 0; i < 12; i++) {
      const t = String(await evalJs(`(document.getElementById('perfInfo')||{}).textContent || ''`))
      if (t && !t.includes('读取中') && !t.includes('测量中')) break
      await new Promise((r) => setTimeout(r, 700))
    }
    const info = await evalJs(`(document.getElementById('perfInfo')||{}).textContent || ''`)
    console.log(`  perfInfo 内容: ${String(info).replace(/\n/g, ' | ').slice(0, 200)}`)
    check('perfInfo 含 workers 数值', String(info), 'workers =')

    // 下拉的当前值应与设置一致
    const conc = await evalJs(`(document.getElementById('p_conc')||{}).value`)
    const cap = await evalJs(`(document.getElementById('p_cap')||{}).value`)
    const ttl = await evalJs(`(document.getElementById('p_ttl')||{}).value`)
    console.log(`  当前值: concurrency=${conc} cap=${cap} ttl=${ttl}`)
    check('concurrency 默认为 auto', conc, 'auto')
    check('探测缓存默认为 24', String(ttl), '24')

    // i18n:不能有裸 tr(" 字面量渲染到界面
    const lit = await evalJs(
      `(function(){var n=0;var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){var t=w.currentNode.nodeValue||'';if(t.indexOf(String.fromCharCode(116,114,40,34))>=0)n++;}return n})()`,
    )
    check('无 tr(" 字面量残留', lit, '0')

    cli.close()
    console.log(pass ? '\n★ 设置页验证通过' : '\n✗ 设置页验证不通过')
    process.exit(pass ? 0 : 1)
  } finally {
    proc.kill()
  }
}

main().catch((e) => {
  console.log('ERR', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})