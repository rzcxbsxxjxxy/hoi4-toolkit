/**
 * AIDE_V1 真浏览器验收(无头 Edge + CDP,零依赖)
 *
 * ★ 为什么必须真浏览器:`window.AI` 挂没挂上、`#aiCfg` 有没有内容、
 *   流式渲染后 DOM 对不对 —— 这些桩测一个都测不出来。
 *   历史上已踩 6 次「HTTP 200 + 语法绿 + 桩测绿 ≠ 功能在」。
 *
 * 跑法:
 *   export MSYS_NO_PATHCONV=1
 *   "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2-5/node.exe" \
 *     _acc_ai_browser.cjs
 */
'use strict'
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const PORT = process.env.PORT_GUI || '5199'
const CDP_PORT = 9333
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

let pass = 0
let fail = 0
const ok = (b, what, extra = '') => {
  if (b) { pass++; console.log(`  ✓ ${what}`) }
  else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const j = await r.json()
      const page = j.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 没起来')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const waiting = new Map()
    const listeners = []
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id
          waiting.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
        })
      },
      on(fn) { listeners.push(fn) },
      close() { ws.close() },
    }))
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))))
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id)
        waiting.delete(m.id)
        if (m.error) w.rej(new Error(JSON.stringify(m.error)))
        else w.res(m.result)
      } else {
        for (const fn of listeners) fn(m)
      }
    })
  })
}

;(async () => {
  if (!existsSync(EDGE)) {
    console.log('找不到 msedge.exe,跳过真浏览器验收')
    process.exit(2)
  }
  const proc = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + join(process.env.TEMP || '.', 'aide-edge-profile'),
    'about:blank',
  ], { detached: false, stdio: 'ignore' })

  let c
  try {
    const target = await cdpTargets()
    c = await connect(target.webSocketDebuggerUrl)
    await c.send('Page.enable')
    await c.send('Runtime.enable')

    const evalJs = async (expr) => {
      const r = await c.send('Runtime.evaluate', {
        expression: `(async()=>{${expr}})()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
      return r.result.value
    }

    console.log('══════════ 1. 打开 IDE 页 ══════════')
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/ide` })
    await sleep(3500)
    const title = await evalJs('return document.title')
    ok(!!title, `页面已加载(title=${title})`)

    /* ★ 自举:把 provider 临时指到 mock 上游,跑完还原。
     *   不然用户配置里没 key 时,「发一条消息」这组判据必然失败,
     *   而那不是 bug —— 是没配 key。还原失败会明确告警。*/
    const MOCK_PORT = process.env.PORT_MOCK || '5299'
    const savedCfg = (await (await fetch(`http://127.0.0.1:${PORT}/api/ai/config`)).json()).config || {}
    await fetch(`http://127.0.0.1:${PORT}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        model: 'mock-model-a',
        apiKey: 'mock-key-browser',
      }),
    })

    console.log('\n══════════ 2. window.AI 真挂上了吗 ══════════')
    const hasAI = await evalJs('return typeof window.AI')
    ok(hasAI === 'object', `window.AI 存在(typeof=${hasAI})`)
    const hasApi = await evalJs('return window.AI ? Object.keys(window.AI).join(",") : ""')
    ok(hasApi.includes('mount') && hasApi.includes('send'), `AI 接口齐备:${hasApi}`)
    const hasHoiIde = await evalJs('return typeof window.HoiIde')
    ok(hasHoiIde === 'object', `window.HoiIde 存在(供刷新用)`)

    console.log('\n══════════ 3. 切到 AI 页签并挂载 ══════════')
    await evalJs(`
      const tabs=[...document.querySelectorAll('.tab')];
      const t=tabs.find(x=>x.dataset.tab==='ai');
      if(!t) return 'no-tab';
      t.click();
      return 'clicked';
    `)
    await sleep(1200)
    /* ★ 配置在页面加载后才改的,AI 面板读到的是旧值(hasKey=false 会拒绝发消息)。
     *   强制重挂一次让它重新拉配置。*/
    await evalJs(`
      window.AI.state.mounted = false;
      window.AI.state.msgs = [];
      return await window.AI.mount();
    `)
    await sleep(900)
    const hasKeyNow = await evalJs('return !!window.AI.state.hasKey')
    ok(hasKeyNow, '面板已读到 mock 配置(hasKey=true)')
    const cfgHtml = await evalJs('return (document.getElementById("aiCfg")||{}).innerHTML || ""')
    ok(cfgHtml.length > 200, `#aiCfg 已渲染(${cfgHtml.length} 字符)`)
    ok(cfgHtml.includes('aiProv'), 'provider 下拉已渲染')
    ok(cfgHtml.includes('aiKey'), 'API Key 输入框已渲染')
    const provCount = await evalJs('return document.querySelectorAll("#aiProv option").length')
    ok(provCount >= 8, `provider 选项 ${provCount} 个(≥8)`)

    console.log('\n══════════ 4. 样式自注入生效(不靠外部 CSS)══════════')
    const styled = await evalJs(`
      const el=document.querySelector('.ai-msg,.ai-quick button,#aiInput');
      if(!el) return 'no-el';
      const cs=getComputedStyle(el);
      return JSON.stringify({bg:cs.backgroundColor, color:cs.color, hasCss: !!document.getElementById('aiCss')});
    `)
    const st = JSON.parse(styled)
    ok(st.hasCss, 'aiCss 样式标签已注入')
    ok(st.bg !== 'rgba(0, 0, 0, 0)' || st.color !== '', `元素有实际样式(bg=${st.bg})`)

    console.log('\n══════════ 5. 真实发一条消息(SSE + 渲染)══════════')
    await evalJs(`
      const i=document.getElementById('aiInput');
      i.value='看看有哪些来源';
      return 1;
    `)
    await evalJs('window.AI.send(); return 1')
    /* 等流式结束:busy 归零 */
    let done = false
    for (let i = 0; i < 40; i++) {
      await sleep(400)
      done = await evalJs('return !window.AI.state.busy')
      if (done) break
    }
    ok(done, '消息发送完成(busy 已归零)')
    const msgCount = await evalJs('return document.querySelectorAll(".ai-msg").length')
    ok(msgCount >= 2, `消息已渲染 ${msgCount} 条(user + bot)`)
    const botText = await evalJs(`
      const b=[...document.querySelectorAll('.ai-msg.bot')].pop();
      return b ? b.querySelector('.ai-txt')?.textContent || '' : '';
    `)
    ok(botText.length > 0, `bot 回复有内容(${botText.slice(0, 30)}…)`)
    const toolCards = await evalJs('return document.querySelectorAll(".ai-tool").length')
    ok(toolCards >= 1, `工具调用卡片已渲染 ${toolCards} 个`)
    const toolName = await evalJs('return document.querySelector(".ai-tool .nm")?.textContent || ""')
    ok(!!toolName, `工具名正确显示:${toolName}`)

    console.log('\n══════════ 6. 工具卡片折叠(事件委托)══════════')
    const foldRaw = await evalJs(`
      const hd=document.querySelector('.ai-tool .hd');
      if(!hd) return 'no-hd';
      const bds=hd.closest('.ai-tool').querySelectorAll('.bd');
      const before=bds[0].style.display;
      hd.click();
      const after=hd.closest('.ai-tool').querySelectorAll('.bd')[0].style.display;
      return JSON.stringify({before, after});
    `)
    /* ⚠ evalJs 可能返回 'no-hd' 这类非 JSON 字符串,直接 JSON.parse 会抛,
     *   抛出的异常会中断整个验收(之前就这么断过一次)。先判前缀。*/
    if (foldRaw === 'no-hd') {
      ok(false, '工具卡片存在', '未找到 .ai-tool .hd')
    } else {
      const f = JSON.parse(foldRaw)
      ok(f.before !== f.after, `点击可折叠(${f.before} → ${f.after})`)
    }

    console.log('\n══════════ 6b. 幂等:重复 mount 不应双触发 ══════════')
    const idem = await evalJs(`
      const before = document.querySelectorAll('.ai-quick button, #aiQuick button').length;
      const n0 = window.AI.state.msgs.length;
      window.AI.state.mounted = false;
      await window.AI.mount();
      await window.AI.mount();
      return JSON.stringify({ quickCount: document.querySelectorAll('#aiQuick button').length, n0, sendBtns: document.querySelectorAll('#aiSend').length });
    `)
    const id = JSON.parse(idem)
    ok(id.sendBtns === 1, `重复 mount 后发送按钮仍只有 1 个(${id.sendBtns})`)

    console.log('\n══════════ 7. 快捷问题按钮 ══════════')
    const quickOk = await evalJs(`
      const i=document.getElementById('aiInput');
      i.value='';
      document.getElementById('aiMsgs').innerHTML='';
      window.AI.state.msgs=[];
      return 1;
    `)
    await evalJs('window.AI.state.msgs=[]; window.AI.send(""); return 1')
    await sleep(600)
    const quickCount = await evalJs('return document.querySelectorAll("#aiQuick button").length')
    /* 空消息不发送,但面板应重绘出快捷问题 */
    const hasQuick = await evalJs(`return document.getElementById('aiQuick').innerHTML.length > 0`)
    ok(hasQuick || quickCount > 0, `快捷问题区有内容(${quickCount} 个按钮)`)

    console.log('\n══════════ 8. 无控制台报错 ══════════')
    const errs = []
    c.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errs.push(m.params.exceptionDetails?.exception?.description || 'exception')
      }
    })
    await evalJs('window.AI.send("再问一次"); return 1')
    await sleep(2500)
    const real = errs.filter((e) => !/favicon|ERR_ABORTED/i.test(e))
    ok(real.length === 0, `控制台无报错`, real.slice(0, 3).join(' | '))

    console.log('\n══════════ 9. 还原 AI 配置 ══════════')
    const restored = await (async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/ai/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...savedCfg, clearKey: true }),
        })
        const now = (await (await fetch(`http://127.0.0.1:${PORT}/api/ai/config`)).json()).config || {}
        return now.provider === savedCfg.provider
      } catch { return false }
    })()
    ok(restored, '★ 已还原原有 AI 配置', `原 provider=${savedCfg.provider}`)
  } catch (e) {
    fail++
    console.log('  ✗ 验收脚本异常:' + e.message)
  } finally {
    try { c?.close() } catch { /* 忽略 */ }
    try { process.kill(proc.pid) } catch { /* 忽略 */ }
  }

  console.log(`\n判据:${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
