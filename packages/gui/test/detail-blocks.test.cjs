/**
 * 浏览器验收:内容可视化「显示具体数据」专项(Edge 无头 + CDP)
 *   ① 决议树:5+4 个脚本块原文真实下发,检查器渲染 kv.blk + pre.raw
 *   ② 决议树:「显示详情」按钮 → 展开完整字段
 *   ③ 决议树:效果字段名正确(complete_effect/remove_effect/hidden_effect/modifier,
 *      不是不存在的 effect —— vanilla 实测 effect = { 出现 0 次)
 *   ④ 回归:国策/科技/AI 行为三页的显示详情仍然可用
 */
const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9352

let pass = 0, fail = 0
const ok = (b, what, extra = '') => { if (b) { pass++; console.log(`  ✓ ${what}`) } else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) } }
const line = (s) => console.log(`\n${'═'.repeat(11)} ${s} ${'═'.repeat(Math.max(0, 46 - s.length))}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks); const zlib = require('node:zlib')
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        let s = buf.toString('utf8')
        try { if (enc.includes('gzip')) s = zlib.gunzipSync(buf).toString('utf8') } catch {}
        try { resolve(JSON.parse(s)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}
async function waitReady(path, tries = 60) {
  for (let i = 0; i < tries; i++) { try { const j = await getJSON(path); if (j && (j.ready || (!j.busy && j.error))) return j } catch {}; await sleep(700) }
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

async function main() {
  /* ── 数据层:脚本块原文下发 ── */
  line('① 决议脚本块原文下发(数据层)')
  const dg = await waitReady('/api/decisions/graph')
  ok(!!dg, '决议图就绪', JSON.stringify(dg && dg.error))
  const cats = (dg && dg.categories) || []
  let all = []
  for (const c of cats) for (const d of c.decisions || []) all.push(d)
  ok(all.length > 0, `决议总数 ${all.length}`)
  const want = {
    availableRaw: 'available(出现条件)',
    allowRaw: 'allowed(允许条件)',
    visibleRaw: 'visible(可见条件)',
    completeRaw: 'complete_effect(完成效果)',
    modifierRaw: 'modifier(修正器)',
    removeEffectRaw: 'remove_effect(移除效果)',
    hiddenEffectRaw: 'hidden_effect(隐藏效果)',
    targetTriggerRaw: 'target_trigger(目标条件)',
    aiWillDoRaw: 'ai_will_do(AI意愿)',
  }
  for (const [k, label] of Object.entries(want)) {
    const c = all.filter((d) => d[k]).length
    ok(c > 0, `${label} 原文下发 ${c} 条`, `key=${k}`)
  }
  ok(!('effectRaw' in all[0]), '不再下发不存在的 effect 块字段', 'keys=' + Object.keys(all[0]).join(','))

  /* ── 页面层:检查器渲染 ── */
  const dir = `${process.env.TEMP}/_cdp_dec_${Date.now()}`
  const ch = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let c = null
  for (let i = 0; i < 40; i++) { try { const l = await cdpTargets(); const pg = l.find((t) => t.type === 'page'); if (pg) { c = await connect(pg.webSocketDebuggerUrl); break } } catch {}; await sleep(500) }
  if (!c) { console.log('no cdp'); process.exit(1) }
  await c.send('Page.enable'); await c.send('Runtime.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  const js = (expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value })
  const nav = async (u) => { await c.send('Page.navigate', { url: u }); await sleep(4000) }
  const wait = async (expr, n = 30) => { for (let i = 0; i < n; i++) { try { if (await js(expr)) return true } catch {}; await sleep(400) } return false }

  line('② 决议检查器渲染脚本块')
  await nav(BASE + '/decisions')
  const cards = await wait(`document.querySelectorAll('#grid .card').length > 0`, 40)
  ok(cards, '决议卡片渲染')
  // 找一个带块原文的决议:直接从 API 拿 id,再在页面里点它
  const target = all.find((d) => d.availableRaw && (d.completeRaw || d.modifierRaw))
  ok(!!target, `找到带块原文的样本决议 ${target && target.id}`)
  if (target) {
    const clicked = await js(`(()=>{const el=[...document.querySelectorAll('#grid .card')].find(x=>x.dataset.id===${JSON.stringify(target.id)});if(el){el.click();return true}return false})()`)
    if (!clicked) {
      // 卡片可能分页/懒加载,先搜索缩小范围
      await js(`(()=>{const q=document.getElementById('q');if(!q)return 0;q.value=${JSON.stringify(target.id)};q.dispatchEvent(new Event('input'));return 1})()`)
      await sleep(1200)
      await js(`(()=>{const el=[...document.querySelectorAll('#grid .card')].find(x=>x.dataset.id===${JSON.stringify(target.id)});if(el){el.click();return true}return false})()`)
    }
    await sleep(900)
    const blkN = await js(`document.querySelectorAll('#insp .kv.blk').length`)
    ok(blkN > 0, `检查器渲染块原文 kv.blk(${blkN} 个)`, 'blkN=' + blkN)
    const rawN = await js(`document.querySelectorAll('#insp pre.raw').length`)
    ok(rawN > 0, `块内容用 pre.raw 展示(${rawN} 个)`, 'rawN=' + rawN)
    const txt = await js(`document.getElementById('insp').textContent`)
    ok(/available/.test(txt), '显示 available 出现条件')
    ok(/complete_effect|modifier|remove_effect/.test(txt), '显示效果类块(完成效果/修正器/移除效果)')

    line('③ 决议「显示详情」')
    const hasBtn = await wait(`!!document.getElementById('decDetailBtn')`)
    ok(hasBtn, '决议检查器含「显示详情」按钮')
    const before = await js(`document.getElementById('insp').textContent.length`)
    await js(`document.getElementById('decDetailBtn').click()`)
    await sleep(400)
    const after = await js(`document.getElementById('insp').textContent`)
    ok(/完整字段|raw/.test(after) && after.length > before, '点「显示详情」后展开完整字段', `${before}→${after.length}`)
  }

  line('④ 回归:国策 / 科技 / AI 行为')
  await nav(BASE + '/focus')
  await waitReady('/api/focus/graph')
  await wait(`(()=>{const t=document.querySelector('#treeList .item');if(t){t.click();return true}return false})()`)
  const fNode = await wait(`(()=>{const g=document.querySelector('.node');if(!g)return false;g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return true})()`, 40)
  ok(fNode, '国策:点选节点')
  const fBtn = await wait(`!!document.getElementById('inspDetailBtn')`)
  ok(fBtn, '国策:仍有「显示详情」按钮')
  await js(`document.getElementById('inspDetailBtn').click()`); await sleep(300)
  const fTxt = await js(`document.getElementById('insp').textContent`)
  ok(/完整字段|raw/.test(fTxt), '国策:显示详情可展开')
  const fBlk = await js(`document.querySelectorAll('#insp .kv.blk').length`)
  ok(fBlk > 0, `国策:块原文仍在(${fBlk} 个)`)

  await nav(BASE + '/tech')
  await waitReady('/api/tech/graph')
  const tIcon = await wait(`document.querySelectorAll('.node image.nodeicon').length > 0`, 40)
  ok(tIcon, '科技:节点图标仍渲染')
  const tHasTex = (await getJSON('/api/tech/graph')).nodes.filter((n) => n.tex).length
  ok(tHasTex > 0, `科技:仍有 ${tHasTex} 个节点带 tex(游戏默认图标)`)

  await nav(BASE + '/aibehave')
  await waitReady('/api/aibehave/graph')
  const aClicked = await wait(`(()=>{const cards=[...document.querySelectorAll('.fcard')];for(const c of cards){const e=c.querySelector('.echip[data-act="entry"]');if(e){e.click();return true}}return false})()`, 40)
  ok(aClicked, 'AI 行为:点选条目')
  const aBtn = await wait(`!!document.getElementById('inspDetailBtn')`)
  ok(aBtn, 'AI 行为:仍有「显示详情」按钮')

  console.log(`\n${'═'.repeat(60)}\n  通过 ${pass} · 失败 ${fail}\n${'═'.repeat(60)}`)
  c.close(); ch.kill()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
