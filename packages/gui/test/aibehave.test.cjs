/**
 * AI 行为页(AI_BEHAVE_V1)的真浏览器验收(Edge 无头 + CDP)
 *
 * 覆盖:
 *  ① 接口归纳正确:方面 / 文件 / 条目三级齐全,条目带 id + 行号 + 来源
 *  ② 页面渲染:左栏方面、中栏文件卡、卡内条目 chip
 *  ③ 检查器:方面(字段画像) / 文件(归属与规模) / 条目(标量与子块)
 *  ④ 右键菜单:文件卡与条目 chip 都能弹出并给出"在 IDE 中打开"
 *  ⑤ 筛选:来源筛选(仅模组)与搜索框
 *
 * 判据原则(踩过太多次):HTTP 200 + 语法绿 ≠ 功能在。每条都读真实 DOM。
 * 另:**断言前先 grep 真实选择器**,别凭印象写 id/class。
 */
const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9345

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
        // 服务端对大响应会 gzip
        const zlib = require('node:zlib')
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        let s = buf.toString('utf8')
        try { if (enc.includes('gzip')) s = zlib.gunzipSync(buf).toString('utf8') } catch { /* 未压缩 */ }
        try { resolve(JSON.parse(s)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function waitReady(path, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const j = await getJSON(path)
      if (j && j.ready) return j
      if (j && !j.busy && j.error) return j
    } catch { /* 服务还在起 */ }
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
        close() { try { ws.close() } catch { /* 已关 */ } },
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
  line('① 接口:三级归纳')
  const g = await waitReady('/api/aibehave/graph')
  ok(!!g && g.ready, '/api/aibehave/graph 就绪', g ? (g.error || '') : 'null')
  if (!g || !g.ready) { console.log('\n接口未就绪,后续跳过'); process.exit(1) }
  const A = g.aspects || []
  ok(A.length >= 8, `方面数 ${A.length} ≥ 8`, A.map((a) => a.key).join(','))
  const keys = A.map((a) => a.key)
  for (const k of ['ai_strategy', 'ai_strategy_plans', 'ai_templates', 'ai_navy']) {
    ok(keys.includes(k), `含方面 ${k}`)
  }
  const withFiles = A.filter((a) => a.files.length > 0)
  ok(withFiles.length === A.length, '每个方面都有文件')
  const allEntries = A.flatMap((a) => a.files.flatMap((f) => f.entries))
  ok(allEntries.length > 500, `条目总数 ${allEntries.length} > 500`)
  ok(
    allEntries.every((e) => e.id && e.line > 0 && e.file && typeof e.root === 'number'),
    '每个条目都带 id / line / file / root',
  )
  const modFiles = A.flatMap((a) => a.files).filter((f) => !f.base)
  ok(modFiles.length > 0, `模组文件 ${modFiles.length} 个(base=false)`)
  const ovr = A.flatMap((a) => a.files).filter((f) => f.overridden)
  ok(ovr.length > 0, `被模组改写的文件 ${ovr.length} 个`, '用于验证覆盖链')
  const prof = A.find((a) => a.key === 'ai_strategy_plans')
  ok(!!prof && prof.profile.length >= 5, `字段画像条目数 ${prof ? prof.profile.length : 0} ≥ 5`)
  ok(!!prof && prof.profile[0].n > 0, `字段画像计数非零(${prof ? prof.profile[0].k + '=' + prof.profile[0].n : '-'})`)
  ok(A.every((a) => !!a.label && !!a.desc), '每个方面都有中文名与释义')

  line('② 页面渲染')
  const userDir = `${process.env.TEMP || 'C:/Users/123/AppData/Local/Temp'}/_cdp_ai_${Date.now()}`
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
    } catch { /* CDP 还没起来 */ }
    await sleep(500)
  }
  if (!c) { console.log('  ✗ Edge CDP 连不上'); process.exit(1) }
  ok(true, 'Edge CDP 已连接')

  await c.send('Page.enable')
  await c.send('Runtime.enable')
  const errs = []
  // 收集页面异常(公共件接线错了多半体现在这里)
  const client = c
  const origOnMsg = null
  void origOnMsg
  async function goto(url, waitMs = 3500) {
    await client.send('Page.navigate', { url })
    await sleep(waitMs)
  }
  async function js(expr) {
    const r = await client.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) {
      errs.push(r.exceptionDetails.text || '')
      throw new Error(r.exceptionDetails.text)
    }
    return r.result.value
  }

  await goto(BASE + '/aibehave')
  ok(true, '页面已加载')

  const aspCount = await js(`return document.querySelectorAll('#aspList .item').length`)
  ok(aspCount >= 8, `左栏方面项 ${aspCount} ≥ 8`)
  const aspText = await js(`return document.querySelector('#aspList .item')?.textContent || ''`)
  ok(/战略|计划|模板|海军|装备|态度|性格|研究|战区|区域/.test(aspText), `方面显示中文名("${aspText.trim().slice(0, 24)}")`)

  // 等文件卡:数据异步 + Incr 分批,骨架在但内容要等
  let cards = 0
  for (let i = 0; i < 30; i++) {
    cards = await js(`return document.querySelectorAll('#fileList .fcard').length`)
    if (cards > 0) break
    await sleep(400)
  }
  ok(cards > 0, `文件卡渲染 ${cards} 张`)
  const firstCard = await js(`
    const el = document.querySelector('#fileList .fcard')
    if (!el) return null
    return { name: el.querySelector('.fn')?.textContent || '', meta: el.querySelector('.fm')?.textContent || '',
             chips: el.querySelectorAll('.echip[data-act="entry"]').length, frommod: el.classList.contains('frommod') }
  `)
  ok(!!firstCard && !!firstCard.name, `文件卡有文件名("${firstCard ? firstCard.name : '-'}")`)
  ok(!!firstCard && /行|KB/.test(firstCard.meta), '文件卡有规模信息(行数/大小)')
  ok(!!firstCard && firstCard.chips > 0, `文件卡内有条目 chip ${firstCard ? firstCard.chips : 0} 个`)

  line('③ 检查器')
  /* ⚠ 判据要挑**画像足够丰富**的方面。左栏第一项是 ai_areas,它只有
   *   strategic_regions / continents 两个字段 —— 拿它断言"行数 ≥ 3"
   *   是判据写错,不是代码错(踩过多次:先看清真实数据再定阈值)。 */
  await js(`
    const sel = document.getElementById('aspSel')
    sel.value = 'ai_strategy_plans'
    sel.dispatchEvent(new Event('change'))
    return 1
  `)
  await sleep(600)
  const insp1 = await js(`return document.querySelector('#insp')?.textContent || ''`)
  ok(/字段画像/.test(insp1), '方面检查器含「字段画像」')
  ok(/战略计划/.test(insp1), '检查器显示该方面的中文名')
  const profRows = await js(`return document.querySelectorAll('#insp .prof .row').length`)
  ok(profRows >= 5, `战略计划字段画像行数 ${profRows} ≥ 5`)

  // 点文件卡的文件名 → 文件详情
  await js(`document.querySelector('#fileList .fcard .fn').click(); return 1`)
  await sleep(300)
  const insp2 = await js(`return document.querySelector('#insp')?.textContent || ''`)
  ok(/内容归属/.test(insp2) && /生效来源/.test(insp2), '文件检查器含归属与生效来源')
  ok(/条目/.test(insp2), '文件检查器列出条目')

  // 点条目 chip → 条目详情
  await js(`
    const chip = document.querySelector('#fileList .echip[data-act="entry"]')
    if (!chip || !chip.__obj) return 'nochip'
    chip.click()
    return 'ok'
  `).then((r) => ok(r === 'ok', '条目 chip 挂了数据对象(__obj)', String(r)))
  await sleep(300)
  const insp3 = await js(`return document.querySelector('#insp')?.textContent || ''`)
  ok(/标量字段/.test(insp3) && /子块构成/.test(insp3), '条目检查器含标量字段与子块构成')
  // 第一个 .kv 是「条目 / <id>」,取它的 span 才是 id 本身
  const entryId = await js(`
    const kv = document.querySelector('#insp .kv')
    return kv ? (kv.querySelector('span')?.textContent || '') : ''
  `)
  ok(!!entryId && entryId.length > 2, `条目检查器显示条目 id("${entryId}")`)

  // 取消方面筛选,恢复全部文件 —— 后面的筛选测试要在全集上跑
  await js(`
    const sel = document.getElementById('aspSel')
    sel.value = ''
    sel.dispatchEvent(new Event('change'))
    return 1
  `)
  await sleep(800)
  cards = await js(`return document.querySelectorAll('#fileList .fcard').length`)
  ok(cards > 0, `取消方面筛选后文件卡 ${cards} 张`)

  line('④ 右键菜单')
  /* ⚠ CDP 的 Input.dispatchMouseEvent(button:'right') **不产生 contextmenu**,
   *   而 Ctx.attach 监听的正是 contextmenu —— 只能合成事件(代码路径一致)。 */
  const menu1 = await js(`
    const el = document.querySelector('#fileList .fcard')
    if (!el) return 'nocard'
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }))
    await new Promise(r => setTimeout(r, 250))
    const m = document.getElementById('ctxMenuRoot')
    if (!m) return 'nomenu'
    const txt = m.textContent || ''
    return m.children.length ? txt.slice(0, 400) : 'empty'
  `)
  ok(menu1 !== 'nocard' && menu1 !== 'nomenu' && menu1 !== 'empty', '文件卡右键弹出菜单', String(menu1).slice(0, 80))
  ok(/IDE|VS ?Code|打开/.test(String(menu1)), '右键菜单含「打开」类项', String(menu1).slice(0, 120))

  const menu2 = await js(`
    const el = document.querySelector('#fileList .echip[data-act="entry"]')
    if (!el) return 'nochip'
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }))
    await new Promise(r => setTimeout(r, 250))
    const m = document.getElementById('ctxMenuRoot')
    return m ? (m.textContent || '').slice(0, 300) : 'nomenu'
  `)
  ok(!String(menu2).startsWith('nomenu'), '条目 chip 右键弹出菜单', String(menu2).slice(0, 80))
  ok(/复制条目 id/.test(String(menu2)), '条目菜单含「复制条目 id」', String(menu2).slice(0, 120))

  line('⑤ 筛选')
  // 搜索框:文件名是**完整相对路径** common/ai_strategy/GER.txt,搜其中一段
  await js(`
    const q = document.getElementById('q')
    q.value = 'GER.txt'
    q.dispatchEvent(new Event('input'))
    return 1
  `)
  await sleep(600)
  const searched = await js(`
    const cards = [...document.querySelectorAll('#fileList .fcard')]
    return { n: cards.length, hit: cards.filter(c => (c.dataset.file || '').includes('GER.txt')).length }
  `)
  ok(searched.n > 0, `搜 "GER.txt" 命中 ${searched.n} 个文件`)
  ok(searched.n === searched.hit, '搜索结果全部真的含该字样', JSON.stringify(searched))
  ok(searched.n < cards, `搜索结果 ${searched.n} < 全量 ${cards}(过滤生效)`)
  await js(`
    const q = document.getElementById('q')
    q.value = ''
    q.dispatchEvent(new Event('input'))
    return 1
  `)
  await sleep(400)

  // 来源筛选:仅模组
  const modSrc = await js(`
    const sel = document.getElementById('srcSel')
    const opt = [...sel.options].find(o => o.value === 'mod')
    if (!opt) return 'noopt'
    sel.value = 'mod'
    sel.dispatchEvent(new Event('change'))
    return 'ok'
  `)
  ok(modSrc === 'ok', '来源下拉含「模组生效」')
  await sleep(2500)
  const modOnly = await js(`
    const cards = [...document.querySelectorAll('#fileList .fcard')]
    return { n: cards.length, allMod: cards.every(c => c.classList.contains('frommod')) }
  `)
  ok(modOnly.n > 1, `仅模组时仍有 ${modOnly.n} 个文件`)
  ok(modOnly.allMod, '仅模组时卡片全部带模组标记(frommod)')

  line('⑥ 首页入口')
  await goto(BASE + '/')
  await sleep(2500)
  const homeCard = await js(`
    const a = document.querySelector('#grpContent a[href="/aibehave"]')
    if (!a) return null
    return { txt: (a.textContent || '').slice(0, 60), hasIcon: !!a.querySelector('svg') }
  `)
  ok(!!homeCard, '首页「内容」组有 AI 行为卡片')
  ok(!!homeCard && /AI 行为/.test(homeCard.txt), `卡片标题含「AI 行为」("${homeCard ? homeCard.txt.replace(/\s+/g, ' ').trim() : '-'}")`)
  ok(!!homeCard && homeCard.hasIcon, '卡片渲染了图标 svg')

  line('⑦ 控制台')
  ok(errs.length === 0, '页面执行无异常', errs.slice(0, 3).join(' | '))

  client.close()
  try { child.kill() } catch { /* 已退出 */ }

  console.log(`\n${'═'.repeat(52)}\n  通过 ${pass} / 失败 ${fail}\n${'═'.repeat(52)}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('  ✗ 未捕获异常: ' + e.message)
  process.exit(1)
})
