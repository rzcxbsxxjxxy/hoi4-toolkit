/* ══════════════════════════════════════════════════════════════════
 * 层01:静态 / 语法 / 路由 / 后端 API
 * 由 tools/smoke_e2e.ts 演进而来。
 * 运行: node --experimental-strip-types 01_static_api.mts [--base=...] [--out=...]
 * 退出码: 0=全过(豁免不计失败),1=有失败。
 * ══════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name: string, dflt: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const BASE = arg('base', 'http://127.0.0.1:5175').replace(/\/+$/, '')
const OUT_DEFAULT = resolve(fileURLToPath(new URL('../results/01_static_api.json', import.meta.url)))
const OUT = resolve(arg('out', OUT_DEFAULT))

const PUBLIC = fileURLToPath(new URL('../../../packages/gui/public/', import.meta.url))

type Case = { name: string; pass: boolean; detail: string; exempt: boolean; exemptReason?: string }
const cases: Case[] = []
let total = 0, pass = 0, fail = 0, exempt = 0

const rec = (name: string, ok: boolean, detail: string, isExempt = false, exemptReason = '') => {
  total++
  if (isExempt) { exempt++; pass++ }
  else if (ok) pass++
  else fail++
  cases.push({ name, pass: isExempt ? true : ok, detail, exempt: isExempt, exemptReason: isExempt ? exemptReason : undefined })
  const tag = isExempt ? 'EXEMPT' : ok ? 'PASS  ' : 'FAIL  '
  console.log(`[${tag}] ${name}${detail ? '  ' + detail : ''}`)
}

/* [文件, needTheme, needNavHost, needMount, 豁免说明]
 * - check.html:深色体检页,不引 theme.css(smoke 原判据)
 * - open.html:单卡片布局,有意只引 theme-vars.css 且用 #topnav 而非 #nav(见 open.html 第7-12行注释)
 * - studio.html:纯 meta-refresh 跳转页(→ /designer),无 UI */
const PAGES: Array<[string, boolean, boolean, boolean, string?]> = [
  ['index.html',     true,  true,  true],
  ['focus.html',     true,  true,  true],
  ['tech.html',      true,  true,  true],
  ['decisions.html', true,  true,  true],
  ['designer.html',  true,  true,  true],
  ['create.html',    true,  true,  true],
  ['ide.html',       true,  true,  true],
  ['settings.html', true,  true,  true],
  ['aibehave.html',  true,  true,  true],
  ['docs.html',      true,  true,  true],
  ['ref.html',       true,  true,  true],
  ['check.html',     false, true,  true],
  ['units.html',     true,  true,  true],
  ['characters.html',true,  true,  true],
  ['defines.html',   true,  true,  true],
  ['events.html',    true,  true,  true],
  ['dlc.html',       true,  true,  true],
  ['doctrines.html', true,  true,  true],
  ['loc.html',       true,  true,  true],
  ['open.html',      false, false, true, 'open.html 是单卡片+遮罩布局,有意只引 theme-vars.css(见第7-12行注释),用 #topnav 而非 #nav;仍调用 mountNav(#topnav)'],
  ['home.html',      true,  true,  true],
  ['modrel.html',    true,  true,  true],
  ['shell.html',     true,  true,  true],
  ['studio.html',    false, false, false, 'studio.html 是纯跳转页(<meta http-equiv=refresh → /designer>),无 UI,不引 theme/nav/mount'],
  ['tracker.html',   true,  true,  true],
  ['worldmap.html',  true,  true,  true],
]

console.log('\n── 静态:页面接入统一主题 / 导航 ──')
for (const [f, needTheme, needNav, needMount, exemptReason] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  const theme = src.includes('href="/theme.css"')
  const navHost = /id="nav"/.test(src)
  const mount = src.includes('mountNav')

  if (needTheme) {
    rec(`${f} 引 theme.css`, theme, theme ? '' : '未找到 href="/theme.css"')
  } else if (exemptReason) {
    rec(`${f} 引 theme.css`, false, '不引为预期', true, exemptReason)
  } else {
    rec(`${f} 引 theme.css`, !theme, theme ? '深色页不应引 theme.css(会顶掉配色)' : '深色页不引(预期)')
  }

  if (needNav) {
    rec(`${f} 有 #nav 容器`, navHost, navHost ? '' : '未找到 id="nav"')
  } else if (exemptReason) {
    rec(`${f} 有 #nav 容器`, false, '无 #nav 为预期', true, exemptReason)
  }

  if (needMount) {
    rec(`${f} 调用 mountNav`, mount, mount ? '' : '未找到 mountNav 调用')
  } else if (exemptReason) {
    rec(`${f} 调用 mountNav`, false, '无 mountNav 为预期', true, exemptReason)
  }
}

console.log('\n── 静态:清理内联硬编码入口 ──')
for (const [f] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  const bad = /<a\s[^>]*href="\/settings"[^>]*\sstyle=/.test(src)
    || /←\s*(GUI 工作台|工作台|返回工作台)/.test(src)
  rec(`${f} 无内联「⚙设置/←工作台」`, !bad, bad ? '命中旧式内联入口正则' : '')
}

function parseErr(src: string): string | null {
  const s = src
    .replace(/^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"][ \t]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(default\s+)?/gm, '')
  try { new Function(s); return null } catch (e: any) { return e.message }
}

console.log('\n── 语法:内联 module 脚本 ──')
let inlineCount = 0
for (const [f] of PAGES) {
  const src = readFileSync(join(PUBLIC, f), 'utf8')
  /* ⚠ 正则只认**行首**的标签(同 smoke 注释里的坑) */
  const re = /^[ \t]*<script type="module">([\s\S]*?)<\/script>/gm
  let m: RegExpExecArray | null, i = 0
  while ((m = re.exec(src))) {
    inlineCount++
    const e = parseErr(m[1])
    rec(`${f} 内联 #${i++}`, !e, e || '')
  }
  if (/<script type="module">/.test(src.replace(/^[ \t]*<script type="module">[\s\S]*?<\/script>/gm, ''))) {
    rec(`${f} 注释里出现 module 标签字面量`, false, 'smoke 的抽取正则会误配')
  }
}
console.log(`  (共 ${inlineCount} 段内联 module)`)

console.log('\n── 语法:public/*.js ──')
const JS_FILES = [
  'app.js', 'focus.js', 'tech.js', 'decisions.js', 'designer.js',
  'create.js', 'ide.js', 'check.js', 'open.js', 'settings.js', 'nav.js', 'ref.js',
  'aibehave.js',
  'target.js', 'toolbar.js', 'incr.js', 'appearance.js', 'locclient.js',
  'dlc.js', 'doctrines.js', 'tex.js', 'edgepath.js', 'sizer.js',
  'ctx.js', 'keys.js', 'keymap.js', 'ctxwire.js', 'fullscreen.js',
  'ownchip.js',
  'loc.js', 'events.js',
  'units.js', 'characters.js', 'defines.js', 'modrel.js', 'tracker.js', 'worldmap.js',
  'ai.js', 'bootgate.js', 'gridwire.js', 'loadgate.js', 'music.js',
  'progress.js', 'resize.js', 'trig.js',
  'i18n.js', 'i18n-terms.js',
]
for (const f of JS_FILES) {
  const p = join(PUBLIC, f)
  let src: string
  try { src = readFileSync(p, 'utf8') }
  catch (e: any) { rec(`public/${f} 存在`, false, `读不到:${e.message}`); continue }
  const e = parseErr(src)
  rec(`public/${f} 语法`, !e, e || '')
}

console.log('\n── 路由:每个页面与静态件 ──')
const ROUTES = [
  '/', '/focus', '/tech', '/doctrines', '/decisions', '/events', '/dlc',
  '/designer', '/create', '/ide', '/check', '/open.html', '/settings', '/docs', '/aibehave',
  '/ref', '/commondocs', '/loc', '/ref.js', '/theme.css', '/theme-vars.css', '/nav.js',
  '/dlc.js', '/doctrines.js', '/aibehave.js', '/ownchip.js',
  '/target.js', '/toolbar.js', '/incr.js', '/appearance.js', '/locclient.js',
  '/units', '/characters', '/defines', '/modrel', '/home', '/shell', '/studio',
  '/tracker', '/worldmap',
  '/units.js', '/characters.js', '/defines.js', '/events.js', '/loc.js',
  '/modrel.js', '/tracker.js', '/worldmap.js',
  '/ai.js', '/bootgate.js', '/gridwire.js', '/loadgate.js', '/music.js',
  '/progress.js', '/resize.js', '/trig.js', '/i18n.js',
]
for (const u of ROUTES) {
  try {
    const r = await fetch(BASE + u)
    rec(`路由 ${u}`, r.status === 200, `${r.status}`)
  } catch (e: any) { rec(`路由 ${u}`, false, e.message) }
}

console.log('\n── 后端 API ──')
const getJson = async (u: string) => {
  const t0 = Date.now()
  let r: Response | null = null, txt = ''
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(BASE + u)
      txt = await r.text()
      break
    } catch (e: any) {
      if (attempt >= 2 || Date.now() - t0 > 120_000) throw e
      await new Promise((done) => setTimeout(done, 400))
    }
  }
  let j: any = null
  try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
  while (j && j.ready === false && j.busy && Date.now() - t0 < 120_000) {
    await new Promise((done) => setTimeout(done, 800))
    r = await fetch(BASE + u)
    txt = await r.text()
    j = null
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
  }
  return { code: (r as Response).status, ms: Date.now() - t0, len: txt.length, j, raw: txt }
}

type ApiCase = [string, (j: any) => boolean, string]
const CASES: ApiCase[] = [
  ['/api/files', j => Array.isArray(j.files) && j.files.length > 0
    && j.files.every((f: any) => typeof f.root === 'number' && typeof f.file === 'string'),
    'files[] 且带 root/file'],
  ['/api/sources', j => Array.isArray(j.sources) && j.sources.length > 0
    && j.sources.some((s: any) => s.base) && j.sources.every((s: any) => 'writable' in s),
    'sources[] 含 base 且带 writable'],
  ['/api/stats', j => typeof j.gui === 'number' && j.gui > 0 && 'pending' in j,
    'gui>0 且带 pending'],
  ['/api/aibehave/graph', j => j.ready && Array.isArray(j.aspects) && j.aspects.length > 0
    && j.aspects.some((a: any) => a.files.length > 0 && a.files[0].file && Array.isArray(a.files[0].entries))
    && j.aspects.some((a: any) => a.files.some((f: any) => f.entries.some((e: any) => e.id && e.line > 0)))
    && j.stats.entries > 0,
    'aspects[] 含文件与条目(id+line)且 entries>0'],
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
  ['/api/dlc/content', j => j.ready && Array.isArray(j.features) && j.features.length > 0
    && j.features.every((f: any) => f.count > 0 && Array.isArray(f.groups) && f.groups.length > 0)
    && j.totals.items > 0, 'features[].groups[].items'],
  ['/api/doctrines/graph', j => j.ready && Array.isArray(j.folders) && j.folders.length > 0
    && Array.isArray(j.grand) && j.grand.length > 0
    && Array.isArray(j.tracks) && j.tracks.length > 0
    && Array.isArray(j.subdoctrines) && j.subdoctrines.length > 0
    && j.issues.length === 0, 'folders+grand+tracks+subs, issues=0'],
  ['/api/dlc/content?feature=factions', j => j.features.length === 1
    && j.features[0].id === 'factions', 'feature 筛选只回 1 个'],
  ['/api/dlc/content?dlc=Gotterdammerung', j => j.totals.items > 0
    && j.totals.items < 1852, 'dlc 筛选收窄'],
  ['/api/mio/tree', j => {
    if (!j.ready || j.stats.orgs <= 0 || j.stats.traits <= 0) return false
    const structural = (j.issues || []).filter((i: any) => i.kind !== 'danglingInclude')
    if (structural.length > 0) return false
    const dangling = (j.issues || []).filter((i: any) => i.kind === 'danglingInclude')
    return dangling.length <= Math.max(1, j.stats.orgs * 0.05)
  }, 'orgs>0 traits>0,结构性诊断=0,悬空 include≤5%'],
  ['/api/loc/text?keys=SMB_army,GER_mio_trait_hoesch_facilities', j => j.ready
    && j.hit >= 1 && Array.isArray(j.langs) && j.langs.length > 0
    && j.langs.every((l: any) => l.id && l.label)
    && Object.values(j.texts).every((v: any) => !v || !/^:\s/.test((v as any).text)),
    'hit>0 语言下拉有 label 值无": "残留'],
  ['/api/tech/graph', j => Array.isArray(j.nodes) && j.nodes.length > 0
    && Array.isArray(j.slots) && j.slots.length > 0
    && j.slots.every((s: any) => s.ids.length > 1)
    && j.stats.coordMaxY < 60
    && j.stats.coordMaxY - j.stats.coordMinY < 60, 'nodes[]+slots[] 且 y 跨度 <60'],
  ['/api/texinfo?names=GFX_doctrine_strategic_destruction_medium,GFX_不存在的贴图', j => {
    const it = j.items || {}
    const a = it['GFX_doctrine_strategic_destruction_medium']
    const b = it['GFX_不存在的贴图']
    return a && a.ok === true && a.w > 0 && a.h > 0 && a.rel && b && b.ok === false
  }, 'sprite 名可解析且带天然尺寸;未定义的名字 ok=false'],
  ['/api/units', j => j.ready && Array.isArray(j.groups) && j.groups.length > 0
    && Array.isArray(j.sources) && j.own && j.stats,
    'units: ready+groups[]+sources+own+stats'],
  ['/api/characters/graph', j => j.ready && Array.isArray(j.files) && j.files.length > 0
    && j.files.every((f: any) => Array.isArray(f.characters))
    && j.own && j.stats,
    'characters: ready+files[].characters[]+own+stats'],
  ['/api/defines', j => j.ready && typeof j.total === 'number' && j.total > 0
    && Array.isArray(j.groups) && j.groups.length > 0
    && j.groups.every((g: any) => g.name && g.file && typeof g.count === 'number'),
    'defines: ready+total>0+groups[].name/file/count'],
  ['/api/defines/diff', j => j.ready && j.sum && typeof j.sum.total === 'number'
    && Array.isArray(j.modNames) && Array.isArray(j.diffs),
    'defines/diff: ready+sum+modNames[]+diffs[]'],
  ['/api/events/list', j => j.ready && typeof j.total === 'number' && j.total > 0
    && Array.isArray(j.rows) && j.rows.length > 0
    && j.rows[0].id && j.rows[0].type,
    'events/list: ready+total>0+rows[].id/type'],
  ['/api/loc/stats', j => j.ready && j.ref && Array.isArray(j.langs) && j.langs.length > 0
    && j.langs.every((l: any) => l.lang && typeof l.keys === 'number'),
    'loc/stats: ready+ref+langs[].lang/keys'],
  ['/api/loc/files', j => j.ready && j.ref && Array.isArray(j.langs) && j.langs.length > 0,
    'loc/files: ready+ref+langs[]'],
  ['/api/loc/key?key=SMB_army', j => j.ready && j.key === 'SMB_army'
    && Array.isArray(j.langs) && j.langs.length > 0
    && j.byLang && Object.keys(j.byLang).length > 0,
    'loc/key: ready+key 回显+langs[]+byLang'],
  ['/api/modmeta', j => j.gameVersion && Array.isArray(j.mods) && j.mods.length > 0,
    'modmeta: gameVersion+mods[]'],
  ['/api/tracker/status', j => j.ready && Array.isArray(j.roots) && j.roots.length > 0
    && j.roots[0].key && j.roots[0].name,
    'tracker/status: ready+roots[].key/name'],
  ['/api/worldmap/meta', j => j.ready && j.w > 0 && j.h > 0
    && Array.isArray(j.provinces) && j.provinces.length > 0
    && j.provinces[0].id && j.provinces[0].x != null,
    'worldmap/meta: ready+w/h+provinces[].id/x'],
]

for (const [u, ok, want] of CASES) {
  try {
    const r = await getJson(u)
    let good = false
    try { good = r.code === 200 && r.j !== null && ok(r.j) } catch { good = false }
    rec(`API ${u}`, good, `${r.code} ${r.len}B ${r.ms}ms  期望 ${want}`)
    if (!good) console.log('        ' + r.raw.slice(0, 160))
  } catch (e: any) { rec(`API ${u}`, false, e.message) }
}

console.log('\n── 写盘安全(只读用例,不落盘)──')
{
  const post = async (u: string, body?: any) => {
    const r = await fetch(BASE + u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    let j: any = null
    try { j = JSON.parse(await r.text()) } catch { /* 非 JSON */ }
    return { status: r.status, j }
  }
  const denied = (r: any) => r.status === 400 || r.status === 403
  const src = (await getJson('/api/sources')).j
  const baseIdx = src?.sources?.findIndex((s: any) => s.base && !s.writable)
  if (baseIdx === undefined || baseIdx < 0) {
    rec('找到只读 base 来源', false, 'sources 里没有 base')
  } else {
    const a = await post('/api/fs/write', { rootIdx: baseIdx, file: 'x.txt', content: 'hi' })
    rec('写只读来源 → 拒绝', denied(a) && /只读/.test(a.j?.error || ''), `${a.status} ${a.j?.error}`)
    const b = await post('/api/fs/write', { rootIdx: baseIdx, file: '../../evil.txt', content: 'hi' })
    rec('路径穿越 → 拒绝', denied(b) && /范围/.test(b.j?.error || ''), `${b.status} ${b.j?.error}`)
    const c = await post('/api/fs/write', { rootIdx: 9999, file: 'x.txt', content: 'hi' })
    rec('无效来源序号 → 拒绝', denied(c), `${c.status} ${c.j?.error}`)
    const d = await post('/api/gen/save', { kind: 'focus', opts: { id: 'X', name: 'X' }, rootIdx: baseIdx })
    rec('脚手架写只读 → 拒绝', denied(d), `${d.status} ${d.j?.error}`)
    const e = await post('/api/mod/new', { name: '..\\..\\evil', parent: src.sources[baseIdx].path })
    rec('模组名含 .. → 拒绝', denied(e), `${e.status} ${e.j?.error}`)
  }
}

console.log('\n── AIDE_V1 AI 接口(边界)──')
{
  const post = async (u: string, body?: any) => {
    const r = await fetch(BASE + u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    let j: any = null
    try { j = JSON.parse(await r.text()) } catch { /* 非 JSON */ }
    return { status: r.status, j }
  }
  const denied = (r: any) => r.status === 400 || r.status === 403
  try {
    const r = await fetch(BASE + '/api/ai/config')
    const j = await r.json()
    rec('AI provider 目录已下发', r.status === 200 && Array.isArray(j.providers) && j.providers.length >= 8,
      `${j.providers?.length} 个`)
    const raw = JSON.stringify(j)
    rec('★ 配置回读不含 apiKey 字段', !('apiKey' in (j.config ?? {})), '')
    rec('★ 配置回读不含 key 明文', !/sk-[A-Za-z0-9]{16,}/.test(raw), '')
    rec('hasKey / keySource 字段齐备', 'hasKey' in j && 'keySource' in j, '')
  } catch (e: any) { rec('读 /api/ai/config', false, e.message) }

  const ap1 = await post('/api/ai/apply', { id: '__definitely_missing__' })
  rec('apply 不存在的 preview → 404', ap1.status === 404, `${ap1.status}`)
  const ap2 = await post('/api/ai/apply', { id: '' })
  rec('apply 空 id → 拒绝', ap2.status === 404 || denied(ap2), `${ap2.status}`)
  const nm = await fetch(BASE + '/api/ai/nope')
  rec('未知 /api/ai/* → 404', nm.status === 404, `${nm.status}`)
  const js = await fetch(BASE + '/ai.js')
  const jst = await js.text()
  rec('/ai.js 可访问且挂 window.AI', js.status === 200 && jst.includes('window.AI'), `${js.status} ${jst.length}B`)
  rec('ai.js MIME 正确', (js.headers.get('content-type') || '').includes('javascript'), js.headers.get('content-type') || '')
}

console.log('\n── 贴图解码抽查(防空白回归)──')
{
  const SAMPLES = [
    'GFX_doctrine_strategic_destruction_medium',
    'GFX_doctrine_milestone_fighter_air',
    'GFX_doctrine_mobile_warfare_medium',
  ]
  for (const name of SAMPLES) {
    try {
      const r = await getJson('/api/tex?id=' + encodeURIComponent(name))
      const j = r.j ?? {}
      const bytes = j.png ? Buffer.from(j.png, 'base64').length : 0
      const ok = r.code === 200 && j.w > 0 && j.h > 0 && bytes > 200
      rec(`贴图 ${name}`, ok, `${j.w}x${j.h} ${bytes}B${j.frames > 1 ? ` frames=${j.frames}` : ''} ${j.error ?? ''}`)
    } catch (e: any) { rec(`贴图 ${name}`, false, e.message) }
  }
  try {
    const r = await getJson('/api/tex?id=GFX_doctrine_milestone_fighter_air')
    const j = r.j ?? {}
    rec('帧动画裁帧', j.frames === 2 && j.w >= 100 && j.w <= 110, `frames=${j.frames} w=${j.w}(原 212)`)
  } catch (e: any) { rec('帧动画裁帧', false, e.message) }
}

console.log('\n── 文档查阅 API ──')
for (const kind of ['official', 'common']) {
  try {
    const r = await getJson(`/api/docs/list?kind=${kind}`)
    const ok = r.code === 200 && r.j?.ready === true && Array.isArray(r.j.groups) && r.j.total > 0
    rec(`/api/docs/list?kind=${kind}`, ok, `${r.code} total=${r.j?.total} groups=${r.j?.groups?.length}`)
  } catch (e: any) { rec(`/api/docs/list?kind=${kind}`, false, e.message) }
}
for (const [kind, want] of [['official', `0:documentation/triggers_documentation.md`],
  ['common', `0:common/decisions/_documentation.md`]] as Array<[string, string]>) {
  try {
    const r = await getJson(`/api/docs/read?kind=${kind}&id=${encodeURIComponent(want)}`)
    const j = r.j ?? {}
    const ok = r.code === 200 && !j.error && j.title &&
      (kind === 'common' ? Array.isArray(j.sections) : Array.isArray(j.categories))
    rec(`/api/docs/read?kind=${kind}`, ok, `${r.code} ${j.title ?? j.error} ` +
      (kind === 'common' ? `sections=${j.sections?.length}` : `cats=${j.categories?.length}`))
  } catch (e: any) { rec(`/api/docs/read?kind=${kind}`, false, e.message) }
}
for (const bad of ['0:../../hoi4.exe', '0:common/../hoi4.exe', '0:hoi4.exe']) {
  try {
    const r = await getJson(`/api/docs/read?kind=common&id=${encodeURIComponent(bad)}`)
    rec(`越权拒绝 ${bad}`, r.code !== 200 || !!r.j?.error, `${r.code} ${r.j?.error ?? ''}`)
  } catch (e: any) { rec(`越权拒绝 ${bad}`, false, e.message) }
}

console.log('\n── 设置 / 模组开关 / 自动补全 / 文件树 ──')
{
  const r = await getJson('/api/settings')
  const s = r.j
  const ok = r.code === 200 && typeof s.base === 'string' && s.base.length > 0
    && Array.isArray(s.mods)
    && s.mods.every((m: any) => typeof m.path === 'string' && typeof m.enabled === 'boolean' && typeof m.name === 'string')
    && typeof s.display === 'object'
  rec('/api/settings 结构', ok, `${r.code} base=${s.base ? '✓' : '✗'} mods=${s.mods.length} display=${s.display?.theme ?? '-'}`)
  const kr = s.mods.find((m: any) => /Kaiserreich|1521695605|kaiserreich/i.test(m.path + ' ' + m.name))
  rec('/api/settings 含 KR 模组条目', !!kr, kr ? `${kr.name} enabled=${kr.enabled}` : '未找到(可写用例将跳过)')
}
{
  const complete = async (q: string, scopes?: string) => {
    const t0 = Date.now()
    for (;;) {
      const qs = 'q=' + encodeURIComponent(q) + (scopes ? '&scopes=' + encodeURIComponent(scopes) : '')
      let r: Response | null = null, j: any = null, neterr = false
      try {
        r = await fetch(BASE + '/api/completion?' + qs)
        j = await r.json().catch(() => null)
      } catch { neterr = true }
      if (!neterr && j && Array.isArray(j.items) && j.items.length > 0) return { code: (r as Response).status, j }
      if (Date.now() - t0 > 90_000) return { code: r?.status ?? 0, j }
      await new Promise((d) => setTimeout(d, 1000))
    }
  }
  const r = await complete('add_', 'official')
  const items = r.j?.items || []
  const okOff = r.code === 200 && items.length > 0
    && items.every((i: any) => i.label && typeof i.source === 'string')
    && items.every((i: any) => i.source === '官方文档')
  rec('/api/completion?scopes=official', okOff, `${r.code} ${items.length} 项 · 首条=${items[0]?.label} 出处=${items[0]?.source}`)
  const r2 = await complete('', 'common')
  const items2 = r2.j?.items || []
  const hasSource = items2.some((i: any) => /:.*:\d+$/.test(i.source || ''))
  rec('/api/completion?scopes=common 出处标注', items2.length > 0 && hasSource,
    `${items2.length} 项 · 样例来源=${items2.find((i: any) => /:.*:\d+$/.test(i.source || ''))?.source}`)
}
{
  const post = async (u: string, body?: any) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    let j: any = null; try { j = JSON.parse(await r.text()) } catch {}
    return { status: r.status, j }
  }
  const denied = (r: any) => r.status === 400 || r.status === 403
  const src = (await getJson('/api/sources')).j
  const baseIdx = src?.sources?.findIndex((s: any) => s.base && !s.writable)
  if (baseIdx >= 0) {
    const a = await post('/api/fs/mkdir', { rootIdx: baseIdx, dir: 'zz_smoke_tmp' })
    rec('mkdir 只读来源 → 拒绝', denied(a) && /只读/.test(a.j?.error || ''), `${a.status} ${a.j?.error}`)
    const b = await post('/api/fs/mkdir', { rootIdx: baseIdx, dir: '../../evil' })
    rec('mkdir 越权路径(只读来源)→ 拒绝', denied(b), `${b.status} ${b.j?.error}`)
  } else {
    rec('mkdir 只读/穿越拒绝用例(跳过)', true, '未找到只读 base 来源')
  }
  const c = await post('/api/fs/mkdir', { rootIdx: 9999, dir: 'x' })
  rec('mkdir 无效来源序号 → 拒绝', denied(c), `${c.status} ${c.j?.error}`)
}
{
  const post = async (u: string, body?: any) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    let j: any = null; try { j = JSON.parse(await r.text()) } catch {}
    return { status: r.status, j }
  }
  const settings = (await getJson('/api/settings')).j
  const kr = settings.mods.find((m: any) => /Kaiserreich|1521695605|kaiserreich/i.test(m.path + ' ' + m.name))
  if (!kr) {
    rec('fs 成功路径(跳过)', true, '无可用模组,跳过落盘用例')
  } else {
    const origEnabled = kr.enabled
    let writableIdx = -1
    try {
      if (!origEnabled) {
        const t = await post('/api/mod/toggle', { path: kr.path, enabled: true })
        rec('临时启用 KR', t.status === 200 && t.j?.ok, `${t.status} roots=${t.j?.roots?.length ?? '-'}`)
      }
      const src = (await getJson('/api/sources')).j
      writableIdx = src?.sources?.findIndex((s: any) => !s.base && s.writable)
      if (writableIdx < 0) {
        rec('fs 成功路径(无本地可写模组来源)', true,
          '本环境 sources 仅含只读 vanilla(KR 以 Steam Workshop 加载),无可写来源可测落盘',
          true, '环境无本地可写模组目录;KR 经 Steam Workshop 只读挂载')
      } else {
        rec('找到可写模组来源', true, `idx=${writableIdx}`)
      }
      if (writableIdx >= 0) {
        const tmp = 'zz_smoke_' + Date.now()
        const r1 = await post('/api/fs/mkdir', { rootIdx: writableIdx, dir: tmp })
        rec('mkdir 成功', r1.status === 200 && r1.j?.ok, `${r1.status} ${r1.j?.dir}`)
        const r2 = await post('/api/fs/rename', { rootIdx: writableIdx, from: tmp, to: tmp + '_renamed' })
        rec('rename 成功', r2.status === 200 && r2.j?.ok, `${r2.status} ${r2.j?.to}`)
        const r3 = await post('/api/fs/delete', { rootIdx: writableIdx, path: tmp + '_renamed' })
        rec('delete 成功', r3.status === 200 && r3.j?.ok, `${r3.status} ${r3.j?.path}`)
        const r4 = await post('/api/fs/delete', { rootIdx: writableIdx, path: '.' })
        rec('delete 根目录 → 拒绝', r4.status === 400 && /根目录/.test(r4.j?.error || ''), `${r4.status} ${r4.j?.error}`)
        const trav = await post('/api/fs/mkdir', { rootIdx: writableIdx, dir: '../../evil' })
        rec('mkdir 路径穿越(可写来源)→ 拒绝', trav.status === 400 && /范围/.test(trav.j?.error || ''), `${trav.status} ${trav.j?.error}`)
      }
    } finally {
      if (!origEnabled) {
        const t = await post('/api/mod/toggle', { path: kr.path, enabled: false })
        rec('恢复 KR 为停用', t.status === 200 && !t.j?.enabled, `${t.status}`)
      }
    }
  }
}

try {
  const g = (await getJson('/api/focus/graph')).j
  const t = g.trees[0]
  const r = await getJson(`/api/focus/tree?tree=${encodeURIComponent(t.id)}`)
  const r2 = await getJson(`/api/focus/tree?id=${encodeURIComponent(t.id)}`)
  rec(`/api/focus/tree?id=${t.id}`, r2.code === 200 && Array.isArray(r2.j.nodes),
    `nodes=${r2.j.nodes?.length}  (错参 tree= → ${r.code})`)
} catch (e: any) { rec('/api/focus/tree', false, e.message) }

try {
  const g = (await getJson('/api/focus/graph')).j
  const tShared = g.trees.find((x: any) => x.shared > 2)
  if (!tShared) {
    rec('共享子树', false, 'graph 里没有 shared>2 的树,判据失效')
  } else {
    const r = await getJson(`/api/focus/tree?id=${encodeURIComponent(tShared.id)}`)
    const ns = r.j.nodes || []
    const nShared = ns.filter((n: any) => n.kind === 'shared' || n.kind === 'joint').length
    rec(`共享子树 ${tShared.id}`, nShared > tShared.shared,
      `引用 ${tShared.shared} 个根 → 展开 ${nShared} 个(必须更多)`)
  }
  const tSc = g.trees.find((x: any) => x.shortcuts > 0)
  if (!tSc) {
    rec('shortcut 明细', false, 'graph 里没有带 shortcut 的树,判据失效')
  } else {
    const r = await getJson(`/api/focus/tree?id=${encodeURIComponent(tSc.id)}`)
    const sc = r.j.shortcuts
    rec(`shortcut 明细 ${tSc.id}`,
      Array.isArray(sc) && sc.length === tSc.shortcuts
      && sc.every((s: any) => s.name && s.target && typeof s.inTree === 'boolean'),
      `${sc?.length ?? 0} 条 · 本树内 ${sc?.filter((s: any) => s.inTree).length ?? 0} / 越界 ${sc?.filter((s: any) => !s.inTree).length ?? 0}`)
  }
} catch (e: any) { rec('共享子树 / shortcut', false, e.message) }

try {
  const files = (await getJson('/api/files')).j.files
  const g = files.find((x: any) => x.file?.endsWith('.gui'))
  if (!g) {
    rec('/api/layout', true, '/api/files 没有 .gui,跳过')
  } else {
    const r = await getJson(`/api/layout?root=${g.root}&file=${encodeURIComponent(g.file)}`)
    const cnt = r.j?.nodes?.length ?? 0
    rec(`/api/layout  ${g.file}`, r.code === 200 && cnt > 0, `nodes=${cnt} canvas=${r.j?.canvasW}x${r.j?.canvasH}`)
  }
} catch (e: any) { rec('/api/layout', false, e.message) }

try {
  const list = (await getJson('/api/mio/tree')).j
  const org = list.orgs?.find((o: any) => o.id?.includes('porsche')) || list.orgs?.[0]
  if (!org) {
    rec('/api/mio/tree?org=', true, '/api/mio/tree 没返回机构清单,跳过')
  } else {
    const r = await getJson(`/api/mio/tree?org=${encodeURIComponent(org.id)}`)
    const j = r.j
    const nodes = j?.nodes || []
    const bad = nodes.filter((n: any) => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length
    const ok = r.code === 200 && nodes.length > 0
      && nodes.length === (j.total ?? nodes.length)
      && bad === 0
      && nodes.some((n: any) => n.fromGeneric)
      && Array.isArray(j.issues) && j.issues.length === 0
    rec(`/api/mio/tree?org=${org.id}`, ok,
      `nodes=${nodes.length}/${j.total} generic=${nodes.filter((n: any) => n.fromGeneric).length} ` +
      `NaN=${bad} issues=${j.issues?.length} cols=${j.columns?.length}`)
  }
} catch (e: any) { rec('/api/mio/tree?org=', false, e.message) }

try {
  const j = (await getJson('/api/tech/graph')).j
  const covered = new Set()
  for (const s of j.slots) for (const id of s.ids) covered.add(id)
  /* ★ 判据随版本演进(2026-10):
   *   旧 smoke 判据:slots 必须覆盖全部「同 folder 同坐标」的科技(独立重算同格分组)。
   *   服务端改版后,slots 只归组「DLC 重叠对」(base + BBA 变体),
   *   其余同格科技由 autoPositioned 自动挪位,不再下发 slot。
   *   新判据:slots 数量与覆盖数必须与服务端自报的 stats.overlapSlots / overlapTechs
   *   完全一致(内部一致性),且 y 跨度 <60。这样若 slots 逻辑再变,仍能抓到错位。 */
  const wantSlots = j.stats.overlapSlots ?? 0
  const wantTechs = j.stats.overlapTechs ?? 0
  const maxN = Math.max(0, ...j.slots.map((s: any) => s.ids.length))
  const ySpan = j.stats.coordMaxY - j.stats.coordMinY
  const ok = j.slots.length === wantSlots
    && covered.size === wantTechs
    && ySpan < 60
  rec('/api/tech/graph slots 对账', ok,
    `slots=${j.slots.length}(自报 ${wantSlots}) 覆盖 ${covered.size}(自报 ${wantTechs}) 最深一格 ${maxN} 条 ` +
    `y跨度=${ySpan} 自动补位=${j.stats.autoPositioned}`)
} catch (e: any) { rec('/api/tech/graph slots', false, e.message) }

const result = {
  layer: '01_static_api',
  base: BASE,
  ts: new Date().toISOString(),
  summary: { total, pass, fail, exempt },
  cases,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8')

console.log(`\n══ 结果 ══`)
console.log(`总数: ${total}  通过: ${pass}  失败: ${fail}  豁免: ${exempt}`)
console.log(`JSON: ${OUT}`)
process.exit(fail === 0 ? 0 : 1)
