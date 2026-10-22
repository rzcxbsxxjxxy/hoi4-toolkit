/* ══════════════════════════════════════════════════════════════════
 * 端到端冒烟自检
 *
 * 为什么要单独做这个:
 *   1) nav.js / theme.css 是全站共用的。一个页面漏写 <div id="nav"> 或漏引
 *      theme.css,服务端不会报错,只在浏览器里表现为"没样式的裸页面"。
 *   2) 内联 <script type="module"> 里写错一个括号,同样不会让服务报错,
 *      只表现为"导航不出现"。静态解析能提前抓到。
 *   3) API 字段名改了(比如 /api/layout 从 {layout:{nodes}} 变成 {nodes}),
 *      前端会静默拿到 undefined。这里逐个断言结构。
 *
 * 注意:沙箱里 node 不能再 spawn 子进程(EBUSY),所以语法检查走 new Function
 * 在进程内解析,而不是 execFileSync('node --check')。
 * ══════════════════════════════════════════════════════════════════ */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = fileURLToPath(new URL('../packages/gui/public/', import.meta.url))
const BASE = 'http://127.0.0.1:5173'

let fail = 0
const say = (ok, msg, extra) => {
  if (!ok) fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}${extra ? `  ${extra}` : ''}`)
}

/* 页面清单:[文件, 是否必须引 theme.css]
 * 体检页是深色的,加载浅色骨架的 theme.css 会把整页顶掉,所以只接导航。 */
const PAGES = [
  ['index.html', true], ['focus.html', true], ['tech.html', true], ['decisions.html', true],
  ['designer.html', true], ['create.html', true], ['ide.html', true], ['settings.html', true],
  ['aibehave.html', true],
  ['docs.html', true], ['ref.html', true], ['check.html', false],
]
const NO_MODULE = new Set(['index.html']) // 面包屑由 app.js 注入

console.log('\n── 静态:页面接入统一主题 / 导航 ──')
for (const [f, needTheme] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  const theme = src.includes('href="/theme.css"')
  const navHost = /id="nav"/.test(src)
  const mount = src.includes('mountNav')
  say(theme === needTheme, `${f} theme.css`, needTheme ? '' : '(深色页,不引)')
  say(navHost, `${f} 有 #nav 容器`)
  say(mount, `${f} 调用 mountNav`)
}

/* 不应再出现的旧式内联入口按钮 */
console.log('\n── 静态:清理内联硬编码入口 ──')
for (const [f] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  /* 只抓"内联 style 的入口锚点"这种旧写法,正文里提到「⚙ 设置」不算 */
  const bad = /<a\s[^>]*href="\/settings"[^>]*\sstyle=/.test(src)
    || /←\s*(GUI 工作台|工作台|返回工作台)/.test(src)
  say(!bad, `${f} 无内联「⚙ 设置 / ← 工作台」`)
}

/* ── 语法检查:进程内解析 ── */
function parseErr(src) {
  /* 去掉 ESM 语法后按函数体解析;顶层 await 会报错,但页面脚本里没有 */
  const s = src
    .replace(/^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(default\s+)?/gm, '')
  try { new Function(s); return null } catch (e) { return e.message }
}

console.log('\n── 语法:内联 module 脚本 ──')
let n = 0
for (const [f] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  /* ⚠ 正则只认**行首**的标签。写 /<script type="module">([\s\S]*?)<\/script>/g
   *   的话,注释里只要提到这个标签(比如"必须放在 module 脚本之前"旁边写了
   *   字面量),匹配就会从注释开始、一直到后面真的结束标签,把中间一大段
   *   (含下一段脚本)当成"内联脚本内容"送进解析器,报出与真实原因无关的
   *   语法错。已经踩过一次:docs.html 因此报Unexpected token '**'。 */
  const re = /^[ \t]*<script type="module">([\s\S]*?)<\/script>/gm
  let m, i = 0
  while ((m = re.exec(src))) {
    n++
    const e = parseErr(m[1])
    say(!e, `${f} 内联 #${i++}`, e || '')
  }
  /* 注释里写了标签字面量 → 提醒一句,免得下次又被同一个坑绊倒 */
  if (/<script type="module">/.test(src.replace(/^[ \t]*<script type="module">[\s\S]*?<\/script>/gm, ''))) {
    say(false, `${f} 注释里出现 module 标签字面量`, 'smoke 的抽取正则会误配')
  }
}
console.log(`  (共 ${n} 段)`)

console.log('\n── 语法:public/*.js ──')
/* 公共件也要查:target/toolbar/incr 是本轮新增的全站共用脚本,
 * 任一语法错会让所有引用它的页面整段脚本失效(浏览器静默)。 */
for (const f of ['app.js', 'focus.js', 'tech.js', 'decisions.js', 'designer.js',
  'create.js', 'ide.js', 'check.js', 'open.js', 'settings.js', 'nav.js', 'ref.js',
  'aibehave.js',
  'target.js', 'toolbar.js', 'incr.js', 'appearance.js', 'locclient.js',
  'dlc.js', 'doctrines.js', 'tex.js', 'edgepath.js', 'sizer.js',
  // RIGHTCLICK_V1/V2 / KEYS_V1 / KEYMAP_V1 / FULLSCREEN_V1 的公共件。
  // ⚠ 这些文件一旦有语法错,全站 11 个页面的右键菜单 / 快捷键 / 全屏
  //   会**同时静默失效** —— 服务端不报错、页面控制台也不一定显眼。
  //   fullscreen.js 就出过一次:IIFE 声明 (global) 却收尾 `})()`,
  //   global 是 undefined,整份文件抛 TypeError 后不再挂 window.Fullscreen。
  'ctx.js', 'keys.js', 'keymap.js', 'ctxwire.js', 'fullscreen.js',
  // OWNERSHIP_V1:归属徽标公共件 —— 语法错会让 tech/focus/decisions/dlc/doctrines/aibehave
  // 六个页面的徽标与筛选一起静默失效(window.Own 未挂上 → 页面脚本直接抛错)。
  'ownchip.js',
  'loc.js', 'events.js']) {
  const e = parseErr(readFileSync(join(PUBLIC, f), 'utf8'))
  say(!e, f, e || '')
}

/* ── 路由可达 ── */
console.log('\n── 路由:每个页面与导航入口 ──')
const ROUTES = ['/', '/focus', '/tech', '/doctrines', '/decisions', '/events', '/dlc',
  '/designer', '/create', '/ide', '/check', '/open.html', '/settings', '/docs', '/aibehave',
  '/ref', '/commondocs', '/loc', '/ref.js', '/theme.css', '/theme-vars.css', '/nav.js',
  '/dlc.js', '/doctrines.js', '/aibehave.js', '/ownchip.js',
  /* UI_SLIM_V1 / MAKE_MOD_V1 新增的全站静态件 */
  '/target.js', '/toolbar.js', '/incr.js', '/appearance.js', '/locclient.js']
for (const u of ROUTES) {
  try {
    const r = await fetch(BASE + u)
    say(r.status === 200, u, `${r.status}`)
  } catch (e) { say(false, u, e.message) }
}

/* ── API 结构 ── */
console.log('\n── 后端 API ──')
/* PERF_ASYNC_V1(2026-10-04)起,重索引构建都是 setImmediate 异步:首个请求会拿到
 * ready:false/busy:true。与前端一样轮询等待就绪,否则 smoke 抢跑会误报。 */
const getJson = async (u) => {
  const t0 = Date.now()
  /* fetch failed 重试:上一个请求刚跑完重索引(CPU 密集)时,服务端会把空闲
   * keep-alive 连接关掉,客户端复用这条已关连接就报 "fetch failed"。
   * 这是客户端竞态,不是服务端错误 —— 重试一次即可,别误判成回归。 */
  let r = null, txt = ''
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(BASE + u)
      txt = await r.text()
      break
    } catch (e) {
      if (attempt >= 2 || Date.now() - t0 > 120_000) throw e
      await new Promise((done) => setTimeout(done, 400))
    }
  }
  let j = null
  try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
  while (j && j.ready === false && j.busy && Date.now() - t0 < 120_000) {
    await new Promise((done) => setTimeout(done, 800))
    r = await fetch(BASE + u)
    txt = await r.text()
    j = null
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
  }
  return { code: r.status, ms: Date.now() - t0, len: txt.length, j, raw: txt }
}
const CASES = [
  ['/api/files', j => Array.isArray(j.files) && j.files.length > 0
    && j.files.every((f) => typeof f.root === 'number' && typeof f.file === 'string'),
    'files[] 且带 root/file'],
  /* ★ MAKE_MOD_V1:来源清单是所有写盘操作(新建模组/保存生成器/IDE 保存)的下拉数据源。
   * 判据:① 至少一个来源 ② base(游戏目录)必须存在 ③ 每个来源都带 writable 标记,
   * 否则前端区分不出"能写到哪",制作闭环直接断。 */
  ['/api/sources', j => Array.isArray(j.sources) && j.sources.length > 0
    && j.sources.some((s) => s.base) && j.sources.every((s) => 'writable' in s),
    'sources[] 含 base 且带 writable'],
  /* ★ PERF_V2:主页概览走这个轻量端点,必须一次返回 gui 计数(扫 interface/*.gui,不点火重索引)。 */
  ['/api/stats', j => typeof j.gui === 'number' && j.gui > 0 && 'pending' in j,
    'gui>0 且带 pending'],
  ['/api/decisions/graph', j => Array.isArray(j.categories) || Array.isArray(j.nodes), 'categories[]|nodes[]'],
  /* ★ AI_BEHAVE_V1:common/ai_* 三级归纳。判据必须落到「方面非空 + 至少一个
   *   方面有文件 + 条目有 id 和位置」,否则解析器静默返回空也会被判通过。 */
  ['/api/aibehave/graph', j => j.ready && Array.isArray(j.aspects) && j.aspects.length > 0
    && j.aspects.some((a: any) => a.files.length > 0 && a.files[0].file && Array.isArray(a.files[0].entries))
    && j.aspects.some((a: any) => a.files.some((f: any) => f.entries.some((e: any) => e.id && e.line > 0)))
    && j.stats.entries > 0,
    'aspects[] 含文件与条目(id+line)且 entries>0'],
  /* ★ OWNERSHIP_V1:全工作台统一的「同名覆盖 / 异名共存」归属统计。
   * 判据是**生效集恒等式**:vanilla + override + new === effective,且总数 > 0。
   * 只要哪个域又回到"同名当增加"(把原版和模组两份都计进总数),这个等式立刻不成立。 */
  ['/api/tech/graph', j => j.ready && j.own && j.own.effective > 0
    && j.own.vanilla + j.own.override + j.own.new === j.own.effective
    && j.nodes.some((n: any) => n.own) && j.stats.nodes === j.own.effective,
    'own 生效集恒等(vanilla+override+new=effective)且节点带 own'],
  ['/api/decisions/graph', j => j.ready && j.own
    && j.own.vanilla + j.own.override + j.own.new === j.own.effective && j.own.effective > 0,
    'own 生效集恒等'],
  ['/api/mio/tree', j => j.ready && j.own
    && j.own.vanilla + j.own.override + j.own.new === j.own.effective && j.own.effective > 0,
    'own 生效集恒等'],
  ['/api/doctrines/graph', j => j.ready && j.own
    && j.own.vanilla + j.own.override + j.own.new === j.own.effective && j.own.effective > 0,
    'own 生效集恒等'],
  ['/api/dlc/content', j => j.ready && j.own
    && j.own.vanilla + j.own.override + j.own.new === j.own.effective && j.own.effective > 0,
    'own 生效集恒等'],
  ['/api/focus/graph', j => Array.isArray(j.trees) && j.trees.length > 0, 'trees[]'],
  ['/api/workshop', j => Array.isArray(j.mods), 'mods[]'],
  ['/api/detect', j => Array.isArray(j.cands) || Array.isArray(j.candidates) || Array.isArray(j), 'cands[]'],
  /* 新模块:DLC 内容 + 学说系统。
   * 判据不能只看 ready —— 还要确保真的抽出了条目、且四层/分组非空,
   * 否则「解析器静默返回空集合」也会被判成通过(曾经的踩坑)。 */
  ['/api/dlc/content', j => j.ready && Array.isArray(j.features) && j.features.length > 0
    && j.features.every((f) => f.count > 0 && Array.isArray(f.groups) && f.groups.length > 0)
    && j.totals.items > 0, 'features[].groups[].items'],
  ['/api/doctrines/graph', j => j.ready && Array.isArray(j.folders) && j.folders.length > 0
    && Array.isArray(j.grand) && j.grand.length > 0
    && Array.isArray(j.tracks) && j.tracks.length > 0
    && Array.isArray(j.subdoctrines) && j.subdoctrines.length > 0
    && j.issues.length === 0, 'folders+grand+tracks+subs, issues=0'],
  /* 筛选参数要真的生效,否则前端筛选器是摆设 */
  ['/api/dlc/content?feature=factions', j => j.features.length === 1
    && j.features[0].id === 'factions', 'feature 筛选只回 1 个'],
  ['/api/dlc/content?dlc=Gotterdammerung', j => j.totals.items > 0
    && j.totals.items < 1852, 'dlc 筛选收窄'],
  /* 军工机构(2026-10 新增,链状树):
   * 判据覆盖三件事 —— ① generic 层 trait 真的解析出来了(不是只认 add_trait)
   * ② 继承/include 生效 ③ 布局坐标全为有限数(NaN 会让整棵树画不出来)
   *
   * ★ 2026-10-06:`issues === 0` 改成**只对 vanilla 断言**。
   *   引擎新增了 `danglingInclude` 诊断(include 指向一个任何来源都没定义的机构),
   *   挂上模组后 KR 里有 3 条**真实**的悬空 include(USA_boeing_organisation_acquired
   *   等引的底盘机构根本没定义)—— 那是模组自身的问题,不是解析器的 bug。
   *   继续卡 `issues===0` 会让「挂模组就跑」变成必失败,判据就废了。
   *   改成:结构性诊断(orphanOverride/unknownParent/unknownRelTo,纯解析器问题)
   *   必须为 0;模组数据问题(danglingInclude)允许存在但必须 ≤ 总机构数的 5%,
   *   超过说明解析器把正常 include 误判成悬空了。 */
  ['/api/mio/tree', j => {
    if (!j.ready || j.stats.orgs <= 0 || j.stats.traits <= 0) return false
    const structural = (j.issues || []).filter(
      (i) => i.kind !== 'danglingInclude')
    if (structural.length > 0) return false
    const dangling = (j.issues || []).filter((i) => i.kind === 'danglingInclude')
    return dangling.length <= Math.max(1, j.stats.orgs * 0.05)
  }, 'orgs>0 traits>0,结构性诊断=0,悬空 include≤5%'],
  /* 本地化文本(2026-10 新增):语言名带 l_ 前头(索引键就是 yml 首行的语言头),
   * 写 'english' 匹配不上 —— 判据直接卡这个坑。 */
  ['/api/loc/text?keys=SMB_army,GER_mio_trait_hoesch_facilities', j => j.ready
    && j.hit >= 1 && Array.isArray(j.langs) && j.langs.length > 0
    && j.langs.every((l) => l.id && l.label)
    && Object.values(j.texts).every((v) => !v || !/^:\s/.test(v.text)),
    'hit>0 语言下拉有 label 值无": "残留'],
  /* 科技树:slots 是横纵向分布修正的关键 —— 同 folder 同坐标的分组必须下发,
   * 否则前端 58 组同格科技会完全重叠成一坨(用户报的"横纵向分布有误")。 */
  ['/api/tech/graph', j => Array.isArray(j.nodes) && j.nodes.length > 0
    && Array.isArray(j.slots) && j.slots.length > 0
    && j.slots.every((s) => s.ids.length > 1)
    && j.stats.coordMaxY < 60
    && j.stats.coordMaxY - j.stats.coordMinY < 60, 'nodes[]+slots[] 且 y 跨度 <60'],
  /* ★ TEX_RESOLVE_V2:/api/tex 必须同时认得三种引用形态。
   * 之前只认内部 tN,而各内容页传的是 GFX_xxx sprite 名 → 图标全 404(用户报"素材图加载不出来")。
   * 这里用 sprite 名与原始路径各打一次,防回退。 */
  ['/api/texinfo?names=GFX_doctrine_strategic_destruction_medium,GFX_不存在的贴图', j => {
    const it = j.items || {}
    const a = it['GFX_doctrine_strategic_destruction_medium']
    const b = it['GFX_不存在的贴图']
    return a && a.ok === true && a.w > 0 && a.h > 0 && a.rel && b && b.ok === false
  }, 'sprite 名可解析且带天然尺寸;未定义的名字 ok=false'],
]
for (const [u, ok, want] of CASES) {
  try {
    const r = await getJson(u)
    const good = r.code === 200 && r.j !== null && (() => { try { return ok(r.j) } catch { return false } })()
    say(good, u, `${r.code} ${r.len}B ${r.ms}ms  期望 ${want}`)
    if (!good) console.log('        ' + r.raw.slice(0, 160))
  } catch (e) { say(false, u, e.message) }
}

console.log('\n── 后端 API(带参数)──')

/* ★ MAKE_MOD_V1 写盘安全:制作闭环一旦开放写文件,最怕的就是
 *   ① 路径穿越(../../ 写出来源目录) ② 往只读的游戏目录写。
 *   这里只发"必定被拒"的请求,不产生任何磁盘副作用,可安全常驻。 */
console.log('\n── 写盘安全(只读用例,不落盘)──')
{
  const post = async (u, body) => {
    const r = await fetch(BASE + u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    let j = null
    try { j = JSON.parse(await r.text()) } catch { /* 非 JSON */ }
    return { status: r.status, j }
  }
  /* 拒绝码:参数错 400 / 权限错 403(语义不同,都算"被挡住了") */
  const denied = (r) => r.status === 400 || r.status === 403
  const src = (await getJson('/api/sources')).j
  const baseIdx = src?.sources?.findIndex((s) => s.base && !s.writable)
  if (baseIdx === undefined || baseIdx < 0) {
    say(false, '找到只读 base 来源', 'sources 里没有 base')
  } else {
    const a = await post('/api/fs/write', { rootIdx: baseIdx, file: 'x.txt', content: 'hi' })
    say(denied(a) && /只读/.test(a.j?.error || ''), '写只读来源 → 拒绝', `${a.status} ${a.j?.error}`)
    const b = await post('/api/fs/write', { rootIdx: baseIdx, file: '../../evil.txt', content: 'hi' })
    say(denied(b) && /范围/.test(b.j?.error || ''), '路径穿越 → 拒绝', `${b.status} ${b.j?.error}`)
    const c = await post('/api/fs/write', { rootIdx: 9999, file: 'x.txt', content: 'hi' })
    say(denied(c), '无效来源序号 → 拒绝', `${c.status} ${c.j?.error}`)
    const d = await post('/api/gen/save', { kind: 'focus', opts: { id: 'X', name: 'X' }, rootIdx: baseIdx })
    say(denied(d), '脚手架写只读 → 拒绝', `${d.status} ${d.j?.error}`)
    const e = await post('/api/mod/new', { name: '..\\..\\evil', parent: src.sources[baseIdx].path })
    say(denied(e), '模组名含 .. → 拒绝', `${e.status} ${e.j?.error}`)
  }
}
/* ══════════════════════════════════════════════════════════════
 * AIDE_V1 AI 开发接口
 *
 * AI 一旦拿到写盘能力,安全边界就成了**最**重要的回归点,所以这几条
 * 全部卡在这里常驻:
 *   ① /api/ai/config 回读**绝不能带 key 明文**(只允许 hasKey + 打码预览)
 *   ② apply 到只读来源必须被拒
 *   ③ apply 路径穿越必须被拒
 *   ④ apply 一个不存在的 previewId → 404
 *   ⑤ /ai.js 能取到且 MIME 是 javascript(否则浏览器静默拒绝执行)
 *
 * 全部只发"必定被拒 / 只读"的请求,不产生磁盘副作用。
 * ⚠ 不测 /api/ai/chat:那要真 key + 联网,且会烧 token。
 *   流式与工具调用的端到端验证在 _acc_ai_browser.cjs(用 mock 上游)。
 * ══════════════════════════════════════════════════════════════ */
console.log('\n── AIDE_V1 AI 接口(边界)──')
{
  const post = async (u, body) => {
    const r = await fetch(BASE + u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    let j = null
    try { j = JSON.parse(await r.text()) } catch { /* 非 JSON */ }
    return { status: r.status, j, text: await Promise.resolve('') }
  }
  const denied = (r) => r.status === 400 || r.status === 403

  try {
    const r = await fetch(BASE + '/api/ai/config')
    const j = await r.json()
    say(r.status === 200 && Array.isArray(j.providers) && j.providers.length >= 8,
      'AI provider 目录已下发', `${j.providers?.length} 个`)
    /* ★ 关键:整份响应里不能出现任何形如 key 的明文。
     * 这里用「响应里不含 apiKey 字段」+「不含常见 key 前缀」双判。*/
    const raw = JSON.stringify(j)
    say(!('apiKey' in (j.config ?? {})), '★ 配置回读不含 apiKey 字段')
    say(!/sk-[A-Za-z0-9]{16,}/.test(raw), '★ 配置回读不含 key 明文')
    say('hasKey' in j && 'keySource' in j, 'hasKey / keySource 字段齐备')
  } catch (e) { say(false, '读 /api/ai/config', e.message) }

  const ap1 = await post('/api/ai/apply', { id: '__definitely_missing__' })
  say(ap1.status === 404, 'apply 不存在的 preview → 404', `${ap1.status}`)

  const ap2 = await post('/api/ai/apply', { id: '' })
  say(ap2.status === 404 || denied(ap2), 'apply 空 id → 拒绝', `${ap2.status}`)

  const nm = await fetch(BASE + '/api/ai/nope')
  say(nm.status === 404, '未知 /api/ai/* → 404', `${nm.status}`)

  const js = await fetch(BASE + '/ai.js')
  const jst = await js.text()
  say(js.status === 200 && jst.includes('window.AI'), '/ai.js 可访问且挂 window.AI', `${js.status} ${jst.length}B`)
  say((js.headers.get('content-type') || '').includes('javascript'),
    'ai.js MIME 正确', js.headers.get('content-type') || '')
}
/* ★ 贴图解码(TEX_AUDIT 轻量版):只抽查几张,判"是不是空白"。
 * 全量体检在 audit_textures.ts(2.8 万张、约 1 分钟),这里只卡住最易回归的点:
 * DDS_PITCH_V4(只解出第 1 行)/ DXT5_ALPHA48_V4(48 位 alpha 读错)/
 * DXT3_ALPHA64_V4(字节序反了)/ DDS_SIGNED_SHIFT_V4(掩码算成负数)。
 * 这四个 bug 的共同特征:**decodeImage 返回 ok、尺寸对、format 对,像素却是垃圾**,
 * 所以只能靠"解出来的 PNG 体积 / 像素统计"这种外部判据发现。
 * 特征值:修复前 64×64 的 doctrine 图标压成 99 字节(纯空白)。 */
console.log('\n── 贴图解码抽查(防空白回归)──')
{
  const SAMPLES = [
    'GFX_doctrine_strategic_destruction_medium', // RGB32 + pitch 歧义
    'GFX_doctrine_milestone_fighter_air',         // 帧动画(2 帧)应裁到 106 宽
    'GFX_doctrine_mobile_warfare_medium',
  ]
  for (const name of SAMPLES) {
    try {
      const r = await getJson('/api/tex?id=' + encodeURIComponent(name))
      const j = r.j ?? {}
      const bytes = j.png ? Buffer.from(j.png, 'base64').length : 0
      // >200 字节 = 有实际内容(空白 64×64 只有 99 字节)
      const ok = r.code === 200 && j.w > 0 && j.h > 0 && bytes > 200
      say(ok, `贴图 ${name}`, `${j.w}x${j.h} ${bytes}B${j.frames > 1 ? ` frames=${j.frames}` : ''} ${j.error ?? ''}`)
    } catch (e) { say(false, `贴图 ${name}`, e.message) }
  }
  /* 帧动画必须按 noOfFrames 裁到单帧,否则显示成被压扁的长条 */
  try {
    const r = await getJson('/api/tex?id=GFX_doctrine_milestone_fighter_air')
    const j = r.j ?? {}
    // 该 sprite 声明 2 帧,原图 212 宽 → 单帧应约 106
    say(j.frames === 2 && j.w >= 100 && j.w <= 110, '帧动画裁帧', `frames=${j.frames} w=${j.w}(原 212)`)
  } catch (e) { say(false, '帧动画裁帧', e.message) }
}

/* 文档查阅:列表 + 读一篇(实时接口,结构必须对) */
console.log('\n── 文档查阅 API ──')
for (const kind of ['official', 'common']) {
  try {
    const r = await getJson(`/api/docs/list?kind=${kind}`)
    const ok = r.code === 200 && r.j?.ready === true && Array.isArray(r.j.groups) && r.j.total > 0
    say(ok, `/api/docs/list?kind=${kind}`, `${r.code} total=${r.j?.total} groups=${r.j?.groups?.length}`)
  } catch (e) { say(false, `/api/docs/list?kind=${kind}`, e.message) }
}
for (const [kind, want] of [['official', `0:documentation/triggers_documentation.md`],
  ['common', `0:common/decisions/_documentation.md`]] as [string, string][]) {
  try {
    const r = await getJson(`/api/docs/read?kind=${kind}&id=${encodeURIComponent(want)}`)
    const j = r.j ?? {}
    const ok = r.code === 200 && !j.error && j.title &&
      (kind === 'common' ? Array.isArray(j.sections) : Array.isArray(j.categories))
    say(ok, `/api/docs/read?kind=${kind}`, `${r.code} ${j.title ?? j.error} ` +
      (kind === 'common' ? `sections=${j.sections?.length}` : `cats=${j.categories?.length}`))
  } catch (e) { say(false, `/api/docs/read?kind=${kind}`, e.message) }
}
/* 目录穿越必须被拒 */
for (const bad of ['0:../../hoi4.exe', '0:common/../hoi4.exe', '0:hoi4.exe']) {
  try {
    const r = await getJson(`/api/docs/read?kind=common&id=${encodeURIComponent(bad)}`)
    say(r.code !== 200 || !!r.j?.error, `越权拒绝 ${bad}`, `${r.code} ${r.j?.error ?? ''}`)
  } catch (e) { say(false, `越权拒绝 ${bad}`, e.message) }
}

/* ★ IDE 自动补全 + 模组开关 + 文件树操作(2026-10 本轮新增)
 * 设计原则:凡能"只测被拒"的安全用例就不落盘;只有 fs/* 成功路径会写临时目录,
 * 且用 try/finally 保证新建的临时目录一定被删掉、KR 开关一定还原到原始状态。 */
console.log('\n── 设置 / 模组开关 / 自动补全 / 文件树 ──')

/* 1) /api/settings:默认 base-only,mods 数组带 enabled/name */
{
  const r = await getJson('/api/settings')
  const s = r.j
  const ok = r.code === 200 && typeof s.base === 'string' && s.base.length > 0
    && Array.isArray(s.mods)
    && s.mods.every((m) => typeof m.path === 'string' && typeof m.enabled === 'boolean' && typeof m.name === 'string')
    && typeof s.display === 'object'
  say(ok, '/api/settings 结构', `${r.code} base=${s.base ? '✓' : '✗'} mods=${s.mods.length} display=${s.display?.theme ?? '-'}`)
  const kr = s.mods.find((m) => /Kaiserreich|1521695605|kaiserreich/i.test(m.path + ' ' + m.name))
  say(!!kr, '/api/settings 含 KR 模组条目', kr ? `${kr.name} enabled=${kr.enabled}` : '未找到(可写用例将跳过)')
}

/* 2) /api/completion:官方文档层优先且标注出处;building 状态要轮询直到出结果 */
{
  const complete = async (q, scopes) => {
    const t0 = Date.now()
    for (;;) {
      const qs = 'q=' + encodeURIComponent(q) + (scopes ? '&scopes=' + encodeURIComponent(scopes) : '')
      let r = null, j = null, neterr = false
      try {
        r = await fetch(BASE + '/api/completion?' + qs)
        j = await r.json().catch(() => null)
      } catch { neterr = true }
      if (!neterr && j && Array.isArray(j.items) && j.items.length > 0) return { code: r.status, j }
      if (Date.now() - t0 > 90_000) return { code: r?.status ?? 0, j }
      await new Promise((d) => setTimeout(d, 1000))
    }
  }
  const r = await complete('add_', 'official')
  const items = r.j?.items || []
  const okOff = r.code === 200 && items.length > 0
    && items.every((i) => i.label && typeof i.source === 'string')
    && items.every((i) => i.source === '官方文档')
  say(okOff, '/api/completion?scopes=official', `${r.code} ${items.length} 项 · 首条=${items[0]?.label} 出处=${items[0]?.source}`)
  /* 出处标注:common 来源应形如 "vanilla:common/ideas/00_ideas.txt:123" */
  const r2 = await complete('', 'common')
  const items2 = r2.j?.items || []
  const hasSource = items2.some((i) => /:.*:\d+$/.test(i.source || ''))
  say(items2.length > 0 && hasSource, '/api/completion?scopes=common 出处标注',
    `${items2.length} 项 · 样例来源=${items2.find((i) => /:.*:\d+$/.test(i.source || ''))?.source}`)
}

/* 3) 文件树操作接口:先测"必被拒"的安全用例(不落盘) */
{
  const post = async (u, body) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    let j = null; try { j = JSON.parse(await r.text()) } catch {}
    return { status: r.status, j }
  }
  const denied = (r) => r.status === 400 || r.status === 403
  const src = (await getJson('/api/sources')).j
  const baseIdx = src?.sources?.findIndex((s) => s.base && !s.writable)
  if (baseIdx >= 0) {
    const a = await post('/api/fs/mkdir', { rootIdx: baseIdx, dir: 'zz_smoke_tmp' })
    say(denied(a) && /只读/.test(a.j?.error || ''), 'mkdir 只读来源 → 拒绝', `${a.status} ${a.j?.error}`)
    // 只读来源下,越权路径同样被拒(只读检查先于越权检查触发,仍属安全拒绝)
    const b = await post('/api/fs/mkdir', { rootIdx: baseIdx, dir: '../../evil' })
    say(denied(b), 'mkdir 越权路径(只读来源)→ 拒绝', `${b.status} ${b.j?.error}`)
  } else {
    say(true, 'mkdir 只读/穿越拒绝用例(跳过)', '未找到只读 base 来源')
  }
  const c = await post('/api/fs/mkdir', { rootIdx: 9999, dir: 'x' })
  say(denied(c), 'mkdir 无效来源序号 → 拒绝', `${c.status} ${c.j?.error}`)
}

/* 4) 文件树操作成功路径:临时启用 KR(若原本停用),做完即还原 */
{
  const post = async (u, body) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    let j = null; try { j = JSON.parse(await r.text()) } catch {}
    return { status: r.status, j }
  }
  const settings = (await getJson('/api/settings')).j
  const kr = settings.mods.find((m) => /Kaiserreich|1521695605|kaiserreich/i.test(m.path + ' ' + m.name))
  if (!kr) {
    say(true, 'fs 成功路径(跳过)', '无可用模组,跳过落盘用例')
  } else {
    const origEnabled = kr.enabled
    let writableIdx = -1
    try {
      if (!origEnabled) {
        const t = await post('/api/mod/toggle', { path: kr.path, enabled: true })
        say(t.status === 200 && t.j?.ok, '临时启用 KR', `${t.status} roots=${t.j?.roots?.length ?? '-'}`)
      }
      const src = (await getJson('/api/sources')).j
      writableIdx = src?.sources?.findIndex((s) => !s.base && s.writable)
      say(writableIdx >= 0, '找到可写模组来源', `idx=${writableIdx}`)
      if (writableIdx >= 0) {
        const tmp = 'zz_smoke_' + Date.now()
        const r1 = await post('/api/fs/mkdir', { rootIdx: writableIdx, dir: tmp })
        say(r1.status === 200 && r1.j?.ok, 'mkdir 成功', `${r1.status} ${r1.j?.dir}`)
        const r2 = await post('/api/fs/rename', { rootIdx: writableIdx, from: tmp, to: tmp + '_renamed' })
        say(r2.status === 200 && r2.j?.ok, 'rename 成功', `${r2.status} ${r2.j?.to}`)
        const r3 = await post('/api/fs/delete', { rootIdx: writableIdx, path: tmp + '_renamed' })
        say(r3.status === 200 && r3.j?.ok, 'delete 成功', `${r3.status} ${r3.j?.path}`)
        /* 防呆:删根目录(路径为 '.')必须被拒 */
        const r4 = await post('/api/fs/delete', { rootIdx: writableIdx, path: '.' })
        say(r4.status === 400 && /根目录/.test(r4.j?.error || ''), 'delete 根目录 → 拒绝', `${r4.status} ${r4.j?.error}`)
        /* 越权防护:可写来源下,../ 必须由 badFileReqNoExist 拦下(返回 400 范围) */
        const trav = await post('/api/fs/mkdir', { rootIdx: writableIdx, dir: '../../evil' })
        say(trav.status === 400 && /范围/.test(trav.j?.error || ''), 'mkdir 路径穿越(可写来源)→ 拒绝', `${trav.status} ${trav.j?.error}`)
      }
    } finally {
      if (!origEnabled) {
        const t = await post('/api/mod/toggle', { path: kr.path, enabled: false })
        say(t.status === 200 && !t.j?.enabled, '恢复 KR 为停用', `${t.status}`)
      }
    }
  }
}

/* 国策单树:参数是 id 不是 tree */
try {
  const g = (await getJson('/api/focus/graph')).j
  const t = g.trees[0]
  const r = await getJson(`/api/focus/tree?tree=${encodeURIComponent(t.id)}`)
  const r2 = await getJson(`/api/focus/tree?id=${encodeURIComponent(t.id)}`)
  say(r2.code === 200 && Array.isArray(r2.j.nodes),
    `/api/focus/tree?id=${t.id}`, `nodes=${r2.j.nodes?.length}  (错参 tree= → ${r.code})`)
} catch (e) { say(false, '/api/focus/tree', e.message) }

/* ★ 共享子树 + shortcut 明细(2026-10 新增)
 *
 * 这两条判据对应两个真实 bug,回归价值很高:
 *  ① 共享子树:argentine_focus_tree 只引 SMB_army/air_force/navy 三个**根**,
 *     但游戏会把整棵共享分支挂进树里(toa_shared 文件里三个根下共 76 个节点)。
 *     只按 tree.shared 直取 → 树里凭空少 73 个,坐标范围也小一圈。
 *     判据:展开出的 shared 节点数必须 > 直接引用的根数。
 *  ② shortcut 明细:以前只下发 shortcuts.length,前端画不出跳转点。
 *     判据:每条必须有 name+target,且 inTree 字段存在。
 */
try {
  const g = (await getJson('/api/focus/graph')).j
  const tShared = g.trees.find((x) => x.shared > 2)
  if (!tShared) {
    say(false, '共享子树', 'graph 里没有 shared>2 的树,判据失效')
  } else {
    const r = await getJson(`/api/focus/tree?id=${encodeURIComponent(tShared.id)}`)
    const ns = r.j.nodes || []
    const nShared = ns.filter((n) => n.kind === 'shared' || n.kind === 'joint').length
    say(nShared > tShared.shared,
      `共享子树 ${tShared.id}`,
      `引用 ${tShared.shared} 个根 → 展开 ${nShared} 个(必须更多)`)
  }
  const tSc = g.trees.find((x) => x.shortcuts > 0)
  if (!tSc) {
    say(false, 'shortcut 明细', 'graph 里没有带 shortcut 的树,判据失效')
  } else {
    const r = await getJson(`/api/focus/tree?id=${encodeURIComponent(tSc.id)}`)
    const sc = r.j.shortcuts
    say(Array.isArray(sc) && sc.length === tSc.shortcuts
      && sc.every((s) => s.name && s.target && typeof s.inTree === 'boolean'),
    `shortcut 明细 ${tSc.id}`,
    `${sc?.length ?? 0} 条 · 本树内 ${sc?.filter((s) => s.inTree).length ?? 0} / 越界 ${sc?.filter((s) => !s.inTree).length ?? 0}`)
  }
} catch (e) { say(false, '共享子树 / shortcut', e.message) }

/* GUI 布局:返回体是 {nodes,...} 不是 {layout:{nodes}};文件字段是 .file */
try {
  const files = (await getJson('/api/files')).j.files
  const g = files.find((x) => x.file?.endsWith('.gui'))
  if (!g) { console.log('  --   /api/files 没有 .gui,跳过 /api/layout') }
  else {
    const r = await getJson(`/api/layout?root=${g.root}&file=${encodeURIComponent(g.file)}`)
    const cnt = r.j?.nodes?.length ?? 0
    say(r.code === 200 && cnt > 0, `/api/layout  ${g.file}`, `nodes=${cnt} canvas=${r.j?.canvasW}x${r.j?.canvasH}`)
  }
} catch (e) { say(false, '/api/layout', e.message) }

/* ★ 军工机构单机构(2026-10):
 * 泛用的「orgs>0」不够 —— 曾经踩到「只解析出国家层的 add_trait、
 * generic 层的 trait 全丢」,机构只剩 8 个节点。判据要卡住:
 *   ① 可见节点数 == 实体节点数(布局阶段不能漏节点)
 *   ② 至少有一条来自 generic 继承(fromGeneric)
 *   ③ 坐标全为有限数(NaN 会让整棵树画不出来)
 *   ④ 至少有一条 all/any 父条件(否则连线画不出来) */
try {
  const list = (await getJson('/api/mio/tree')).j
  const org = list.orgs?.find((o) => o.id?.includes('porsche')) || list.orgs?.[0]
  if (!org) { console.log('  --   /api/mio/tree 没返回机构清单,跳过') }
  else {
    const r = await getJson(`/api/mio/tree?org=${encodeURIComponent(org.id)}`)
    const j = r.j
    const nodes = j?.nodes || []
    // ⚠ 坐标字段是 x/y(像素),不是 px/py —— 写错会让 NaN 判据永远失败
    const bad = nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length
    const ok = r.code === 200 && nodes.length > 0
      && nodes.length === (j.total ?? nodes.length)
      && bad === 0
      && nodes.some((n) => n.fromGeneric)
      && Array.isArray(j.issues) && j.issues.length === 0
    say(ok, `/api/mio/tree?org=${org.id}`,
      `nodes=${nodes.length}/${j.total} generic=${nodes.filter((n) => n.fromGeneric).length} ` +
      `NaN=${bad} issues=${j.issues?.length} cols=${j.columns?.length}`)
    if (nodes.length !== (j.total ?? nodes.length)) {
      console.log(`        布局漏了 ${(j.total ?? 0) - nodes.length} 个节点`)
    }
  }
} catch (e) { say(false, '/api/mio/tree?org=', e.message) }

/* ★ 科技树 slots 深度判据(2026-10 横纵向分布修正):
 * 前端靠 slots 把「同 folder 同坐标」的多条科技合成一张卡带,
 * 并按 deepest 动态放大行距。这里验证 slots 覆盖了全部同格科技。 */
try {
  const j = (await getJson('/api/tech/graph')).j
  const covered = new Set()
  for (const s of j.slots) for (const id of s.ids) covered.add(id)
  // 独立重算一遍同 folder 同坐标的分组,和下发的 slots 对账
  const ref = new Map()
  for (const n of j.nodes) {
    const k = `${n.folder}|${n.x},${n.y}`
    ref.set(k, (ref.get(k) || 0) + 1)
  }
  const expect = [...ref.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0)
  const maxN = Math.max(...j.slots.map((s) => s.ids.length))
  const ok = j.slots.length > 0 && covered.size === expect && expect > 0
  say(ok, '/api/tech/graph  slots 对账',
    `slots=${j.slots.length} 覆盖 ${covered.size} 条 (独立重算应 ${expect}) 最深一格 ${maxN} 条 ` +
    `y跨度=${j.stats.coordMaxY - j.stats.coordMinY} 自动补位=${j.stats.autoPositioned}`)
} catch (e) { say(false, '/api/tech/graph slots', e.message) }

console.log(`\n${fail === 0 ? '✔ 全部通过' : `✘ 失败 ${fail} 项`}`)
process.exit(fail === 0 ? 0 : 1)
