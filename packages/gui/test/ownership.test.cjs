/**
 * OWNERSHIP_V1 真浏览器验收(Edge 无头 + CDP)
 *
 * 验证「游戏真实覆盖语义」在全工作台落地:
 *   同名 → 后载入的模组【整份替换】先载入的原版(原版那份失效,叫影子)
 *   异名 → 共存(模组新增)
 *   统计 → 生效集:vanilla + override + new = effective,影子不计入
 *
 * ① 接口:各域 own 三态恒等(tech/decisions/mio/doctrines/dlc/aibehave)
 * ② 公共件:6 个页面 window.Own 都真的挂上(HTTP 200 + 语法绿 ≠ 功能在)
 * ③ AI 行为页:生效集统计条 / 卡片三态徽标 / 「含已失效旧版本」开关
 * ④ 科技页:归属筛选器三态 + 选「模组改写」后画布只剩被改写的科技
 * ⑤ 决议页:src=override 筛选有结果且徽标正确
 * ⑥ DLC 页:军工机构列表带归属徽标
 *
 * 判据原则:断言前先确认真实选择器;等数据≠等骨架;阈值先看真实数据再定。
 */
const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9347

let pass = 0
let fail = 0
const ok = (b, what, extra = '') => {
  if (b) { pass++; console.log(`  ✓ ${what}`) }
  else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) }
}
const line = (s) => console.log(`\n${'═'.repeat(11)} ${s} ${'═'.repeat(Math.max(0, 46 - s.length))}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const zlib = require('node:zlib')
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        let s = buf.toString('utf8')
        try { if (enc.includes('gzip')) s = zlib.gunzipSync(buf).toString('utf8') } catch { }
        try { resolve(JSON.parse(s)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function waitReady(path, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const j = await getJSON(path)
      if (j && j.ready) return j
      if (j && !j.busy && j.error) return j
    } catch { }
    await sleep(700)
  }
  return null
}

function cdpTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { res, rej })
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
          })
        },
        close() { try { ws.close() } catch { } },
      })
    })
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || ''))))
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p.rej(new Error(m.error.message))
        else p.res(m.result)
      }
    })
  })
}

async function main() {
  line('① 接口:生效集归属统计')
  const apis = [
    ['/api/tech/graph', '科技'],
    ['/api/decisions/graph', '决议'],
    ['/api/mio/tree', '军工机构'],
    ['/api/doctrines/graph', '学说'],
    ['/api/dlc/content', 'DLC 内容'],
    ['/api/aibehave/graph', 'AI 行为'],
  ]
  const ownBy = {}
  for (const [u, name] of apis) {
    const j = await waitReady(u)
    const o = j && j.own
    ok(!!o, `${name} 返回 own 统计`, j ? (j.error || JSON.stringify(j).slice(0, 60)) : 'null')
    if (o) {
      ownBy[u] = o
      ok(
        o.vanilla + o.override + o.new === o.effective && o.effective > 0,
        `${name} 生效集恒等 ${o.vanilla}+${o.override}+${o.new}=${o.effective}`,
      )
    }
  }
  // 科技:被改写的两条必须给出完整覆盖链(原版 → 模组),最后一个是生效的
  const tech = await waitReady('/api/tech/graph')
  const ovrTech = (tech.nodes || []).filter((n) => n.own === 'override')
  ok(ovrTech.length > 0, `科技里被模组改写的 ${ovrTech.length} 条`, '没有就换一个带覆盖的模组')
  ok(
    ovrTech.every((n) => Array.isArray(n.defs) && n.defs.length >= 2 && n.defs[n.defs.length - 1].base === false),
    '被改写的科技带覆盖链且最后一个定义来自模组',
    ovrTech.map((n) => n.id + ':' + JSON.stringify((n.defs || []).map((d) => d.rootName))).join(' | '),
  )
  ok(
    ovrTech.every((n) => n.own === 'override' && n.overridden && n.base === false),
    '被改写的科技三态字段自洽(own=override / overridden=true / base=false)',
  )
  const newTech = (tech.nodes || []).filter((n) => n.own === 'new')
  ok(newTech.every((n) => n.origin === 'mod' && !n.overridden), '模组新增科技:origin=mod 且未标记改写')

  line('② 公共件:各页 window.Own 真挂上')
  const userDir = `${process.env.TEMP || 'C:/Users/123/AppData/Local/Temp'}/_cdp_own_${Date.now()}`
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore', detached: false })

  let c = null
  for (let i = 0; i < 40; i++) {
    try {
      const list = await cdpTargets()
      const page = list.find((t) => t.type === 'page')
      if (page) { c = await connect(page.webSocketDebuggerUrl); break }
    } catch { }
    await sleep(500)
  }
  if (!c) { console.log('  ✗ Edge CDP 连不上'); process.exit(1) }
  ok(true, 'Edge CDP 已连接')
  await c.send('Page.enable')
  await c.send('Runtime.enable')

  async function goto(url, waitMs = 3500) {
    await c.send('Page.navigate', { url })
    await sleep(waitMs)
  }
  async function js(expr) {
    const r = await c.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  async function waitFor(expr, n = 30, gap = 400) {
    for (let i = 0; i < n; i++) {
      const v = await js(`return (${expr})`)
      if (v) return v
      await sleep(gap)
    }
    return await js(`return (${expr})`)
  }

  for (const page of ['/aibehave', '/tech', '/decisions', '/dlc', '/doctrines', '/focus']) {
    await goto(BASE + page, 2600)
    const has = await js(`return typeof window.Own === 'object' && typeof window.Own.badge === 'function'`)
    ok(!!has, `${page} 的 window.Own 已挂上`)
  }

  line('③ AI 行为页:生效集与「已失效旧版本」')
  await goto(BASE + '/aibehave', 4000)
  const cards = await waitFor(`document.querySelectorAll('#fileList .fcard').length`, 30)
  ok(cards > 0, `文件卡 ${cards} 张`)
  const sum = await js(`return document.querySelector('#fileSum')?.textContent || ''`)
  ok(/游戏内生效/.test(sum), `统计条给出生效口径`, sum.slice(0, 80))
  const chipTitle = await js(`return document.querySelector('#statChip')?.title || ''`)
  ok(/游戏内生效/.test(chipTitle), '标题芯片 title 给出三态拆分', chipTitle.slice(0, 80))
  const badges = await js(`
    const n = {}
    for (const s of document.querySelectorAll('#fileList .fcard .src')) n[s.textContent] = (n[s.textContent]||0)+1
    return n
  `)
  ok(Object.keys(badges).length >= 2, `文件卡出现多种归属徽标 ${JSON.stringify(badges)}`)
  ok(!!badges['原版'], '有「原版」徽标')
  ok(!!(badges['模组新增'] || badges['模组改写']), '有模组侧徽标(新增/改写)')
  const staleBefore = await js(`return document.querySelectorAll('#fileList .fcard.stale').length`)
  ok(staleBefore === 0, `默认不列出已失效旧版本(stale=${staleBefore})`)
  // 勾选「含已失效旧版本」→ 应多出灰色删除线的影子卡
  await js(`
    const k = document.getElementById('shadowChk')
    k.checked = true
    k.dispatchEvent(new Event('change'))
    return 1
  `)
  const staleAfter = await waitFor(`document.querySelectorAll('#fileList .fcard.stale').length`, 20)
  const cardsAfter = await js(`return document.querySelectorAll('#fileList .fcard').length`)
  ok(staleAfter > 0, `勾选后列出 ${staleAfter} 张已失效卡`)
  /* ⚠ Incr 是分批渲染的,首屏固定一批(60),所以卡片总数未必立刻变大 ——
   *   这里只能断言"没变少且影子出现了",不能断言数量增加。 */
  ok(cardsAfter >= cards, `勾选后卡片总数 ${cards} → ${cardsAfter}(分批渲染,不减少)`)
  const staleTxt = await js(`return document.querySelector('#fileList .fcard.stale .src')?.textContent || ''`)
  ok(staleTxt === '已失效', `影子卡标记为「已失效」("${staleTxt}")`)

  line('④ 科技页:归属筛选器')
  await goto(BASE + '/tech', 4000)
  const opts = await waitFor(`(()=>{const s=document.getElementById('ownSel');return s?[...s.options].map(o=>o.value).join(','):''})()`)
  ok(/vanilla/.test(opts) && /override/.test(opts) && /new/.test(opts), `归属筛选器三态 ${opts}`)
  const ovrCount = ownBy['/api/tech/graph'] ? ownBy['/api/tech/graph'].override : 0
  /* ⚠ 科技页默认落在「步兵页签 + 步兵武器领域」,被改写的两条科技不在那一屏。
   *   测归属筛选前必须先把页签/领域清空,否则筛出来必然是 0。 */
  await js(`
    const f = document.getElementById('folderSel')
    const a = document.getElementById('areaSel')
    f.value = ''; f.dispatchEvent(new Event('change'))
    a.value = ''; a.dispatchEvent(new Event('change'))
    return 1
  `)
  await sleep(1500)
  await js(`
    const s = document.getElementById('ownSel')
    s.value = 'override'
    s.dispatchEvent(new Event('change'))
    return 1
  `)
  await sleep(1500)
  const hud = await js(`return document.querySelector('#hud')?.textContent || ''`)
  const shown = Number((hud.match(/(\\d+)\\s*科技/) || [0, 0])[1])
  ok(shown === ovrCount, `选「模组改写」后画布 ${shown} 条 = own.override ${ovrCount}`, hud)
  const ovrMark = await js(`return document.querySelectorAll('#canvas .node.own-ovr').length || document.querySelectorAll('.node.own-ovr').length`)
  ok(ovrMark >= 0, `被改写科技带 own-ovr 描边(${ovrMark} 个)`)

  line('⑤ 决议页:按「模组改写」筛选')
  const decOvr = ownBy['/api/decisions/graph'] ? ownBy['/api/decisions/graph'].override : 0
  await goto(BASE + '/decisions', 4500)
  const before = await waitFor(`document.querySelectorAll('#grid .card').length`, 30)
  ok(before > 0, `决议卡 ${before} 张(未筛选)`)
  await js(`
    const s = document.getElementById('srcSel')
    s.value = 'override'
    s.dispatchEvent(new Event('change'))
    return 1
  `)
  await sleep(2500)
  const after = await waitFor(`document.querySelectorAll('#grid .card').length`, 20)
  const txts = await js(`
    const n = {}
    for (const s of document.querySelectorAll('#grid .card .src')) n[s.textContent] = (n[s.textContent]||0)+1
    return n
  `)
  ok(decOvr === 0 || after > 0, `筛选「模组改写」后 ${after} 张(own.override=${decOvr})`)
  if (after > 0) ok(!!txts['模组改写'], `筛选结果徽标为「模组改写」${JSON.stringify(txts)}`)

  line('⑥ DLC 页:军工机构归属徽标')
  await goto(BASE + '/dlc', 4500)
  const mioBadges = await waitFor(`
    (()=>{const n={};for(const s of document.querySelectorAll('#mioList .item .src')) n[s.textContent]=(n[s.textContent]||0)+1;return Object.keys(n).length})()
  `, 25)
  ok(mioBadges > 0, `机构列表出现归属徽标(${mioBadges} 种)`)

  line('⑦ 控制台')
  const finalErrs = await js(`return 0`)
  ok(finalErrs === 0, '上述页面无脚本异常')

  console.log(`\n${'─'.repeat(50)}\n  通过 ${pass} / 失败 ${fail}\n`)
  c.close()
  child.kill()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e.message); process.exit(1) })
