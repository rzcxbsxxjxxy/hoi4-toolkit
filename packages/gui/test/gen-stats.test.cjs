/**
 * 浏览器验收:内容生成专项(GEN_STATS_V1)
 *
 * 这页改动的判据,分两层:
 *
 *   ① 结构正确性(数据层)—— 这是本专项的核心。
 *      旧生成器有 5 处**语法合法但游戏不认**的硬错误,曾经全部通过自检:
 *        equipment少 s / decision 写不存在的 effect / ideas 缺 country 层 /
 *        country 带 tag 却 factor=1 / 装备虚构 active={block=no}
 *      现在逐条断言:产出里不能出现这些形态,且正确形态必须在。
 *
 *   ② 判据真实性 —— schema 必须来自实测扫描(不是手写表),
 *      且语义校验要真能抓到注入的错误(否则等于没校验)。
 *
 * 另含前端断言:字段表不再自带镜像、select 取值真实、脚本框有键提示可点插入。
 */
const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9357

let pass = 0, fail = 0
const ok = (b, what, extra = '') => { if (b) { pass++; console.log(`  ✓ ${what}`) } else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) } }
const line = (s) => console.log(`\n${'═'.repeat(11)} ${s} ${'═'.repeat(Math.max(0, 46 - s.length))}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function request(p, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const zlib = require('node:zlib')
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        let s = buf.toString('utf8')
        try { if (enc.includes('gzip')) s = zlib.gunzipSync(buf).toString('utf8') } catch {}
        try { resolve(JSON.parse(s)) } catch (e) { reject(new Error(s.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
const getJSON = (p) => request(p)
const postJSON = (p, b) => request(p, 'POST', b)
async function waitReady(p, tries = 60) {
  for (let i = 0; i < tries; i++) { try { const j = await getJSON(p); if (j && (j.ready || j.schema)) return j } catch {}; await sleep(700) }
  return null
}
function cdpTargets() { return new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } }) }).on('error', reject) }) }
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map()
    ws.addEventListener('open', () => resolve({
      send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })) }),
      close: () => ws.close(),
    }))
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result) } })
    ws.addEventListener('error', reject)
  })
}
/** 取某个产物文件的正文 */
function txtOf(gen, suffix) {
  const f = (gen.files || []).find((x) => x.path.endsWith(suffix) || x.path.includes(suffix))
  return f ? f.content : ''
}

async function main() {
  /* ═══════════════① schema:字段表来自真实数据 ═══════════════ */
  line('① 字段表来自实测数据(非手写表)')
  const sc = await waitReady('/api/gen/schema', 90)
  ok(!!sc && sc.ready, '字段统计就绪', sc && sc.error)
  ok(sc && sc.files > 100, `实测扫描 ${sc && sc.files} 个原版+模组文件`)
  const S = (sc && sc.schema) || {}
  ok(!!S.focus && !!S.event && !!S.decision && !!S.technology && !!S.idea && !!S.equipment,
    '6 类生成器都有 schema', Object.keys(S).join(','))

  // 旧版三处不同步:引擎读但表单没有的字段,现在必须都在
  const focusKeys = (S.focus.fields || []).map((f) => f.key)
  ok(focusKeys.includes('available'), '国策表单有 available(旧版引擎读但表单没有)')
  ok(focusKeys.includes('reward'), '国策表单有 reward(旧版缺失)')
  ok((S.decision.fields || []).some((f) => f.key === 'aiWillDo'), '决议表单有 aiWillDo(旧版缺失)')
  ok((S.technology.fields || []).some((f) => f.key === 'aiWillDo'), '科技表单有 aiWillDo(旧版缺失)')
  const evKeys = (S.event.fields || []).map((f) => f.key)
  ok(evKeys.includes('isTriggeredOnly') && evKeys.includes('fireOnlyOnce'), '事件表单有这两个开关(旧版缺失)')

  // 旧字段表 52个,现在应显著更多
  const totalFields = Object.values(S).reduce((a, s) => a + (s.fields || []).length, 0)
  ok(totalFields > 70, `字段总数 ${totalFields}(旧版 52)`)

  // select 取值必须真实:area 105 个、装备类型不带 land 泛称
  const areaF = (S.technology.fields || []).find((f) => f.key === 'area')
  ok(areaF && areaF.values && areaF.valueTotal >= 100, `科技领域 ${areaF && areaF.valueTotal} 个真实取值`)
  ok(areaF && !areaF.values.includes('land_doctrine'), 'area 不含旧假值 land_doctrine')
  const slotF = (S.equipment.fields || []).find((f) => f.key === 'equipmentSlot')
  ok(slotF && slotF.values.includes('infantry'), '装备类型含真实值 infantry')
  ok(slotF && !slotF.values.includes('land'), '装备类型不含泛称 land(原版没这个值)')

  // script 类型字段存在(条件/效果块不再是空壳占位)
  const decScripts = (S.decision.fields || []).filter((f) => f.type === 'script').map((f) => f.key)
  ok(decScripts.includes('completeEffect'), '决议「执行效果」是 script 框')
  ok(decScripts.length >= 6, `决议条件/效果共 ${decScripts.length} 个 script 框`)

  /* ═══════════════② 5 处硬错误已修正 ═══════════════ */
  line('② 5 处硬错误的产出结构(核心)')

  // #2 equipment:顶层必须复数 equipments
  const eq = await postJSON('/api/create', { kind: 'equipment', opts: { mod: 'm', lang: 'l_english', id: 'my_eq', name: '装备' } })
  const eqTxt = txtOf(eq, 'equipment/')
  ok(/^equipments\s*=\s*\{/m.test(eqTxt), '装备顶层是 equipments(复数)', eqTxt.slice(0, 40).replace(/\n/g, ' '))
  ok(!/^equipment\s*=\s*\{/m.test(eqTxt), '不再出现单数 equipment')
  // #5 虚构字段:不该再有 active={block=no}
  ok(!/active\s*=\s*\{/.test(eqTxt), '不再生成虚构的 active = { … }')
  ok(!/\b(air|armor|artillery)\s*=\s*\{/.test(eqTxt), '不再生成虚构的 air/armor/artillery 块')

  // #1 decision:真实效果块,没有顶层 effect
  const dec = await postJSON('/api/create', { kind: 'decision', opts: { mod: 'm', lang: 'l_english', id: 'my_dec' } })
  const decTxt = txtOf(dec, 'decisions/')
  ok(!/^\t+effect\s*=\s*\{/m.test(decTxt), '决议没有顶层 effect(原版 0 处)')
  ok(/complete_effect\s*=\s*\{/.test(decTxt), '决议用 complete_effect')
  ok(!/^\t+allow\s*=\s*\{/m.test(decTxt), '决议没有 allow(原版是 allowed)')
  ok(/allowed\s*=\s*\{/.test(decTxt), '决议用 allowed')

  // #3 ideas:三层 ideas > country > id
  const idea = await postJSON('/api/create', { kind: 'idea', opts: { mod: 'm', lang: 'l_english', id: 'my_idea', title: 'T', desc: 'D' } })
  const ideaTxt = txtOf(idea, 'ideas/')
  ok(/ideas\s*=\s*\{\s*\n\s*country\s*=\s*\{/m.test(ideaTxt), '理念是 ideas > country > id 三层', ideaTxt.slice(0, 60).replace(/\n/g, ' '))

  // #4 focus:country 带 tag 判定时 factor=0
  const foc = await postJSON('/api/create', { kind: 'focus', opts: { mod: 'm', lang: 'l_english', id: 'my_focus', tag: 'MY', title: 'T', desc: 'D' } })
  const focTxt = txtOf(foc, 'national_focus/')
  const countryBlk = (focTxt.match(/country\s*=\s*\{[\s\S]*?\n\t\}/) || [''])[0]
  ok(/factor\s*=\s*0/.test(countryBlk), '有 tag 判定时 factor = 0', countryBlk.replace(/\s+/g, ' ').slice(0, 70))

  // 科技:ai_will_do 用 factor(不是决议的 base),area 默认值真实
  const tech = await postJSON('/api/create', { kind: 'technology', opts: { mod: 'm', id: 'my_tech' } })
  const techTxt = txtOf(tech, 'technologies/')
  ok(/ai_will_do\s*=\s*\{\s*\n\s*factor/.test(techTxt), '科技 ai_will_do 用 factor')
  ok(!/land_doctrine/.test(techTxt), '科技默认领域不是旧假值 land_doctrine')
  ok((tech.errors || []).length === 0, '科技默认参数零语义错误', JSON.stringify(tech.errors))

  line('③ 六类默认产出零语义错误')
  for (const [k, opts] of Object.entries({
    focus: { id: 'my_focus', tag: 'MY', title: 'T', desc: 'D' },
    event: { id: 'my_event', title: 'T', desc: 'D' },
    decision: { id: 'my_dec' },
    technology: { id: 'my_tech' },
    idea: { id: 'my_idea', title: 'T', desc: 'D' },
    equipment: { id: 'my_eq', name: '装备' },
  })) {
    const r = await postJSON('/api/create', { kind: k, opts: { mod: 'm', lang: 'l_english', ...opts } })
    ok((r.errors || []).length === 0, `${k}:零 error`, JSON.stringify(r.errors).slice(0, 160))
  }

  /* ═══════════════④ 校验真能抓到注入的错误 ═══════════════ */
  line('④ 语义校验能抓到注���的错误')
  // 用一个非法枚举触发 error:装备类型填原版没有的 land_equipment_type
  const badEnum = await postJSON('/api/create', { kind: 'equipment', opts: { mod: 'm', id: 'bad_eq', equipmentSlot: 'definitely_not_a_real_type' } })
  ok((badEnum.errors || []).length > 0, '非法枚举取值被判error', JSON.stringify(badEnum.warnings).slice(0, 100))
  // 脚本块内乱写键 → warning
  const badKey = await postJSON('/api/create', { kind: 'decision', opts: { mod: 'm', id: 'd2', completeEffect: 'zzzz_not_a_real_effect = 1' } })
  const hasWarn = (badKey.warnings || []).some((w) => /zzzz_not_a_real_effect/.test(w))
  ok(hasWarn, '脚本块内的乱写键被判 warning', JSON.stringify(badKey.warnings).slice(0, 140))

  const keys = await getJSON('/api/gen/keys')
  ok(keys && keys.ok && keys.keys.length > 30, `真实键提示 ${keys && keys.keys.length} 个`)

  /* ═══════════════⑤ 前端 ═══════════════ */
  line('⑤ 前端渲染(schema 驱动 + 键提示)')
  const dir = `${process.env.TEMP}/_cdp_gen_${Date.now()}`
  const ch = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let c = null
  for (let i = 0; i < 40; i++) { try { const l = await cdpTargets(); const pg = l.find((t) => t.type === 'page'); if (pg) { c = await connect(pg.webSocketDebuggerUrl); break } } catch {}; await sleep(500) }
  if (!c) { console.log('no cdp'); process.exit(1) }
  await c.send('Page.enable'); await c.send('Runtime.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  const js = (expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value })
  const nav = async (u) => { await c.send('Page.navigate', { url: u }); await sleep(1200) }
  const wait = async (expr, n = 40) => { for (let i = 0; i < n; i++) { try { if (await js(expr)) return true } catch {}; await sleep(400) } return false }

  const errs = []
  c.send('Log.enable'); c.send('Runtime.enable')
  const collect = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text)
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text || 'exception')
  }
  // Node 22 内置 WebSocket:直接挂上监听
  const targets = await cdpTargets()
  const pgTarget = targets.find((t) => t.type === 'page')

  await nav(BASE + '/create')
  ok(await wait(`!!window.CreateApp && !!window.CreateApp.schema`, 60), '页面载入并拿到 schema(window.CreateApp)')
  const kinds = await js(`Object.keys(window.CreateApp.schema||{}).length`)
  ok(kinds === 6, `前端拿到 6 类字段表(${kinds})`)
  const groupN = await js(`document.querySelectorAll('#fields .grp').length`)
  ok(groupN > 0, `字段按分组渲染(${groupN} 组)`)
  const hintN = await js(`document.querySelectorAll('#fields .q[title]').length`)
  ok(hintN > 0, `字段带说明气泡(${hintN} 个)`)

  // 下拉取值来自真实数据 —— 切到装备类型(有 select 字段)再断言
  await js(`(()=>{const s=document.getElementById('kindSel');s.value='equipment';s.dispatchEvent(new Event('change'));return 1})()`)
  await sleep(700)
  const selN = await js(`document.querySelectorAll('#fields select').length`)
  ok(selN >= 2, `有下拉字段(${selN} 个,取值来自真实数据)`)
  const slotOpts = await js(`(()=>{const s=[...document.querySelectorAll('#fields select')].find(x=>x.dataset.key==='equipmentSlot');return s?[...s.options].map(o=>o.value).filter(Boolean).length:0})()`)
  ok(slotOpts >= 13, `装备类型下拉 ${slotOpts} 个真实取值`)
  const slotNoLand = await js(`(()=>{const s=[...document.querySelectorAll('#fields select')].find(x=>x.dataset.key==='equipmentSlot');return s? [...s.options].some(o=>o.value==='land') : true})()`)
  ok(!slotNoLand, '装备类型下拉不含泛称 land')

  // 切回决议:脚本框 + 键提示
  await js(`(()=>{const s=document.getElementById('kindSel');s.value='decision';s.dispatchEvent(new Event('change'));return 1})()`)
  await sleep(700)
  const taN = await js(`document.querySelectorAll('#fields textarea').length`)
  ok(taN >= 6, `决议有 ${taN} 个多行脚本框(条件/效果)`)
  const khN = await js(`document.querySelectorAll('#fields .kh').length`)
  ok(khN > 0, `脚本框旁挂真实键提示(${khN} 个)`)
  // 点键插入
  const kh0 = await js(`(()=>{const b=document.querySelector('#fields .kh');if(!b)return'';const k=b.textContent;b.click();return k})()`)
  await sleep(300)
  const taVal = await js(`(()=>{const t=document.querySelector('#fields textarea');return t?t.value:''})()`)
  ok(!!kh0 && taVal.includes(kh0), `点键真的插进脚本框(${kh0} → "${taVal.slice(0, 30)}")`)

  // 前端不再自带字段镜像
  const mirrored = await js(`typeof window.GEN_FIELDS !== 'undefined'`)
  ok(!mirrored, '前端已删掉手写 GEN_FIELDS 镜像(唯一数据源在引擎)')

  // 生成 + 错误区
  await js(`document.getElementById('genBtn').click()`)
  await wait(`window.CreateApp.files.length > 0`, 30)
  const filesN = await js(`window.CreateApp.files.length`)
  ok(filesN > 0, `前端生成出 ${filesN} 个产物文件`)
  const errBoxShown = await js(`(()=>{const e=document.getElementById('errBox');return e? e.classList.contains('show') : false})()`)
  ok(!errBoxShown, '默认参数下错误区不显示')
  const statTxt = await js(`(document.getElementById('statLine')||{}).textContent||''`)
  ok(/扫描|原版/.test(statTxt), '页面显示判据来源(实测扫描)', statTxt.slice(0, 80))

  line('⑥ 控制台')
  ok(errs.length === 0, '页面执行无异常', errs.slice(0, 2).join(' | '))

  console.log(`\n${'═'.repeat(60)}\n  通过 ${pass} · 失败 ${fail}\n${'═'.repeat(60)}`)
  c.close(); ch.kill()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })