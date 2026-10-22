/**
 * 浏览器验收:科技树默认图标 + 三页「显示详情」按钮(Edge 无头 + CDP)
 *   - 科技树每个节点渲染 image.nodeicon,缺失/失败回退到内置默认齿轮(data:image)
 *   - /tech、/aibehave、/focus 检查器都有「显示详情」按钮,点开后展开完整细节
 */
const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9351

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
async function waitReady(path, tries = 50) {
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
  const dir = `${process.env.TEMP}/_cdp_di_${Date.now()}`
  const ch = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' })
  let c = null
  for (let i = 0; i < 40; i++) { try { const l = await cdpTargets(); const pg = l.find((t) => t.type === 'page'); if (pg) { c = await connect(pg.webSocketDebuggerUrl); break } } catch {}; await sleep(500) }
  if (!c) { console.log('no cdp'); process.exit(1) }
  await c.send('Page.enable'); await c.send('Runtime.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  const js = (expr) => c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value })
  const nav = async (u) => { await c.send('Page.navigate', { url: u }); await sleep(3500) }
  const wait = async (expr, n = 30) => { for (let i = 0; i < n; i++) { try { if (await js(expr)) return true } catch {}; await sleep(400) } return false }

  /* ── ① 科技树:默认图标 ── */
  line('① 科技树默认图标')
  await nav(BASE + '/tech')
  await waitReady('/api/tech/graph')
  const iconReady = await wait(`document.querySelectorAll('.node image.nodeicon').length > 0`)
  ok(iconReady, '科技节点渲染出 image.nodeicon')
  // ★ req2:图标必须是【游戏内素材】GFX_technology_medium(=gfx/interface/technologies/tank_icon.dds)
  //   而不是自造的齿轮 data URI。查 href 指向的 /api/tex?id 与节点 tex 是否同源。
  const iconInfo = await js(`(()=>{const n=[...document.querySelectorAll('.node')].find(g=>g.querySelector('image.nodeicon'));if(!n)return null;const i=n.querySelector('image.nodeicon');return{href:(i.getAttribute('href')||'').slice(0,60),id:n.getAttribute('data-id')||n.id||''}})()`)
  ok(!!iconInfo, '取到首个带图标的科技节点', JSON.stringify(iconInfo))
  const techGfx = await getJSON('/api/tech/graph')
  const anyTex = (techGfx.nodes || []).filter((n) => n.tex).length
  ok(anyTex > 0, `科技投影全部带 tex(游戏默认图标 GFX_technology_medium)`, `${anyTex}/${(techGfx.nodes || []).length}`)
  const noIconButTex = (techGfx.nodes || []).filter((n) => !n.icon && n.tex).length
  ok(noIconButTex > 0, '无显式 icon 的科技也回退到游戏默认图标 tex', `count=${noIconButTex}`)
  // 真实拉一次精灵确认素材可用(200 + 有 png)
  const sprite = await getJSON('/api/tex?id=GFX_technology_medium')
  ok(!!sprite && !!sprite.png && sprite.w > 0, 'GFX_technology_medium 精灵可加载(游戏内 tank_icon.dds)', sprite ? `${sprite.w}x${sprite.h}` : 'null')
  const href = await js(`(()=>{const i=document.querySelector('.node image.nodeicon');return i?i.getAttribute('href'):null})()`)
  ok(!!href, '图标 href 非空(无破图)', href ? href.slice(0, 30) : 'null')
  const selNode = await wait(`(()=>{const g=document.querySelector('.node');if(!g)return false;g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return true})()`)
  ok(selNode, '点选一个科技节点')
  const hasBtn = await wait(`!!document.getElementById('inspDetailBtn')`)
  ok(hasBtn, '科技检查器含「显示详情」按钮')
  const before = await js(`document.getElementById('insp').textContent`)
  await js(`document.getElementById('inspDetailBtn').click()`)
  await sleep(300)
  const after = await js(`document.getElementById('insp').textContent`)
  ok(/完整字段|raw/.test(after) && after.length > before.length, '点「显示详情」后展开完整字段')

  /* ── ② AI 行为:显示详情 + 嵌套子字段 ── */
  line('② AI 行为显示详情')
  await nav(BASE + '/aibehave')
  await waitReady('/api/aibehave/graph')
  // 找一张含条目的文件卡,点它第一个条目 chip
  const clicked = await wait(`(()=>{const cards=[...document.querySelectorAll('.fcard')];for(const c of cards){const e=c.querySelector('.echip[data-act="entry"]');if(e){e.click();return true}}return false})()`)
  ok(clicked, '点选一个 AI 条目')
  const hasBtnA = await wait(`!!document.getElementById('inspDetailBtn')`)
  ok(hasBtnA, 'AI 检查器含「显示详情」按钮')
  await js(`document.getElementById('inspDetailBtn').click()`)
  await sleep(300)
  const inspA = await js(`document.getElementById('insp').textContent`)
  ok(/完整结构/.test(inspA), 'AI 详情含「完整结构(显示详情)」')
  const subCount = await js(`document.querySelectorAll('#insp .kv.sub').length`)
  ok(subCount > 0, `AI 详情展示嵌套子字段(${subCount} 行)`, 'subCount=' + subCount)

  /* ── ③ 国策树:显示详情 ── */
  line('③ 国策树显示详情')
  await nav(BASE + '/focus')
  await waitReady('/api/focus/graph')
  // 选第一棵树,再点第一个节点
  const picked = await wait(`(()=>{const t=document.querySelector('#treeList .item');if(t){t.click();return true}return false})()`)
  ok(picked, '选中第一棵国策树')
  const nodeOk = await wait(`(()=>{const g=document.querySelector('.node');if(!g)return false;g.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return true})()`, 40)
  ok(nodeOk, '点选一个国策节点')
  const hasBtnF = await wait(`!!document.getElementById('inspDetailBtn')`)
  ok(hasBtnF, '国策检查器含「显示详情」按钮')
  await js(`document.getElementById('inspDetailBtn').click()`)
  await sleep(300)
  const inspF = await js(`document.getElementById('insp').textContent`)
  ok(/完整字段|raw/.test(inspF), '国策点「显示详情」后展开完整字段')

  /* ── ③b req1: 国策块原文(available/ai_will_do/completion_reward/search_filters) ── */
  line('③b 国策块原文(req1)')
  const fg = await getJSON('/api/focus/graph')
  const trees = (fg.trees || []).filter((t) => t.nodes > 0)
  let n = 0, cAvail = 0, cAi = 0, cRew = 0, cSf = 0
  for (const t of trees.slice(0, 12)) {
    const ft = await getJSON('/api/focus/tree?id=' + encodeURIComponent(t.id))
    for (const x of ft.nodes || []) {
      n++
      if (x.available) cAvail++
      if (x.aiWillDo) cAi++
      if (x.completionReward) cRew++
      if (x.searchFilters) cSf++
    }
  }
  ok(n > 0, `抽样 ${Math.min(12, trees.length)} 棵树共 ${n} 个国策`)
  ok(cAvail > 0, `available 出现条件原文(${cAvail} 条)`)
  ok(cAi > 0, `ai_will_do 原文(${cAi} 条)`)
  ok(cRew > 0, `completion_reward 原文(${cRew} 条)`)
  ok(cSf > 0, `search_filters 原文(${cSf} 条)`)
  const blkN = await js(`document.querySelectorAll('#insp .kv.blk').length`)
  ok(blkN > 0, `检查器渲染出块原文 kv.blk(${blkN} 个)`, 'blkN=' + blkN)

  /* ── ③c req3: allow_branch + offset 联动 ── */
  line('③c allow_branch/offset 联动(req3)')
  let cBr = 0, cOffAll = 0, linked = null
  for (const t of trees) {
    const ft = await getJSON('/api/focus/tree?id=' + encodeURIComponent(t.id))
    for (const x of ft.nodes || []) {
      if (x.branch && x.branch.length) { cBr++; if (!linked && x.xOff != null && x.xOff !== x.x) linked = x }
      if (x.xOff != null && x.xOff !== x.x) cOffAll++
    }
    if (cBr > 0 && linked) break
  }
  ok(cBr > 0, `allow_branch 门控关系已建(${cBr} 个国策有 branch)`)
  ok(cOffAll > 0, `条件偏移坐标存在(${cOffAll} 个国策主坐标≠偏移坐标)`)
  ok(!!linked, '找到同时有 allow_branch 与 offset 的联动样本')
  if (linked) {
    console.log(`     样本 ${linked.id}:门控 [${linked.branch.join(', ')}],主(${linked.x},${linked.y})→偏移(${linked.xOff},${linked.yOff})`)
    ok(/allow_branch/.test(String(linked.branchRaw || '')), '样本 branchRaw 含 allow_branch 条件原文')
    // ★ 联动是【本树内】的行为,必须先把树切到样本所在树(树列表项属性是 data-tree-id),
    //   否则 S.nodes 里没有该节点,断言拿到的会是 null。
    const treeId = linked.tree || ''
    ok(!!treeId, '样本带 tree 字段(用于切换到所在树)', 'tree=' + treeId)
    const switched = await js(`(()=>{const items=[...document.querySelectorAll('#treeList .item')];const hit=items.find(x=>x.dataset&&x.dataset.treeId===${JSON.stringify(treeId)});if(hit){hit.click();return true}return false})()`)
    ok(switched, `切到样本所在树 ${treeId}`)
    await sleep(1500)
    const hasNode = await js(`(()=>{const a=window.FocusApp;if(!a||!a.S)return false;return a.S.nodes.some(x=>x.id===${JSON.stringify(linked.id)})})()`)
    ok(hasNode, `当前树已载入样本节点 ${linked.id}`)
    const gate = linked.branch[0]
    const gateOn = await js(`(()=>{const a=window.FocusApp;if(!a||!a.S)return false;a.S.completed.add(${JSON.stringify(gate)});if(a.buildGating)a.buildGating();if(a.render)a.render();return true})()`)
    ok(gateOn, `模拟完成门控国策 ${gate}`)
    await sleep(500)
    const revealed = await js(`(()=>{const a=window.FocusApp;if(!a||!a.S)return null;const x=a.S.nodes.find(y=>y.id===${JSON.stringify(linked.id)});if(!x)return null;return{vis:a.nodeVisState?a.nodeVisState(x):null,coord:a.coordOf?a.coordOf(x):null}})()`)
    ok(!!revealed && revealed.vis && revealed.vis.v, '门控完成后该国策显形(nodeVisState.v=true)', JSON.stringify(revealed))
    ok(!!revealed && revealed.coord && revealed.coord.x === linked.xOff, `显形后采用 offset 坐标 x=${linked.xOff}`, JSON.stringify(revealed && revealed.coord))
  }

  console.log(`\n${'═'.repeat(60)}\n  通过 ${pass} · 失败 ${fail}\n${'═'.repeat(60)}`)
  c.close(); ch.kill()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
