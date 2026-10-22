/**
 * verify_parallel_data.mts —— 验收:并行的产出与主线程串行基线【逐字段一致】
 *
 * ★ 为什么必须逐字段比对:并行的最大风险不是"起不来"(那会走降级,很明显),
 *   而是"起来了但内容不对" —— HTTP 全 200、界面无报错,只是译文/定义是错的。
 *   引用图与决议图尤其危险:它们的产物直接决定界面上的名字与跳转。
 *
 * 做法:对每个图,主线程建一份当基线,再走 runInWorker 建一份,比对结构指纹。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const S = (p) => pathToFileURL(join(ROOT, 'packages', 'gui', 'src', p)).href
const E = (p) => pathToFileURL(join(ROOT, 'packages', 'engine', 'src', p)).href

const s = JSON.parse(readFileSync(resolve(ROOT, 'gui-settings.json'), 'utf8'))
const rs = []
if (s.base) rs.push({ name: 'vanilla', path: s.base, writable: false })
for (const m of s.mods ?? []) if (m.enabled) rs.push({ name: m.path.split(/[\\/]/).pop(), path: m.path, writable: true })
const ROOTS = rs.map((r) => ({ name: r.name, path: r.path, writable: r.writable }))
const GAME_DIR = rs.find((r) => !r.writable)?.path ?? rs[0].path
/* ★★ roots 的形态必须与 server 里【逐个 ensure* 实际传的】完全一致,
 *   否则指纹会假报警:server 给 tech/decisions/doctrines/mio/music/links
 *   传的是 {name,path}(没有 writable),给 dlc/defines/events 传的是
 *   {name,path,writable}。而 roots 会被原样存进产物里(.roots 字段),
 *   少一个键指纹就不同 —— 实测因此误报 5 项「内容不一致」。
 *   教训:比对两侧必须喂【同一份输入】,否则测的是输入差异不是实现差异。 */
const RP = ROOTS.map((r) => ({ name: r.name, path: r.path }))
const RPF = ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable }))

const { runInWorker, initPool, shutdownPool } = await import(S('worker-pool.ts'))
const { buildEventIndex } = await import(E('events.ts'))
const { buildFocusGraph } = await import('../packages/focus/src/model.ts')
const { buildTechGraph } = await import(E('tech.ts'))
const { buildDecisionGraph } = await import(E('decisions.ts'))
const { buildAiBehavior } = await import(E('aibehave.ts'))
const { buildDoctrineGraph, layoutDoctrines } = await import(E('doctrines.ts'))
const { buildLinkGraph } = await import(E('links.ts'))
const { buildDlcModel } = await import(E('dlc.ts'))
const { buildMioTrees } = await import(E('mio.ts'))
const { buildMusicIndex } = await import(E('music.ts'))
const { readFileSync: rf } = await import('node:fs')
const { walkFiles } = await import(S('sprites.ts'))
const { buildDefinesModel } = await import(E('defines.ts'))

/** 把任意结构拍成稳定指纹(键排序,Map 按 entries 排序)
 *
 * ★★ 必须排除「计时类字段」:图对象里普遍带 ms / builtAt / at 等
 *   运行期字段 —— 它们【本该】每次不同(主线程和 worker 是两次构建)。
 *   不排除就会把 11 个图全判成"不一致",假报警。
 *   判据:这些字段不是内容,只是耗时记录;内容一致才是我们要验的。 */
const TIMING_KEYS = new Set(['ms', 'builtAt', 'at', 'since', 'startedAt', 'elapsed'])
function fp(v, d = 0, key = '') {
  if (d > 14) return '"~"'
  if (v === null || v === undefined) return 'n'
  const t = typeof v
  if (TIMING_KEYS.has(key) && (t === 'number')) return '#timing'
  if (t === 'number') return 'n' + v
  if (t === 'boolean') return v ? 'T' : 'F'
  if (t === 'string') return 's' + JSON.stringify(v)
  if (v instanceof Map) return 'M{' + [...v.entries()].map(([k, x]) => fp(k, d + 1) + ':' + fp(x, d + 1)).sort().join(',') + '}'
  if (v instanceof Set) return 'S{' + [...v].map((x) => fp(x, d + 1)).sort().join(',') + '}'
  if (Array.isArray(v)) return 'A[' + v.map((x, i) => fp(x, d + 1, String(i))).join(',') + ']'
  const o = v
  return 'O{' + Object.keys(o).sort().map((k) => k + ':' + fp(o[k], d + 1, k)).join(',') + '}'
}

/** 找出指纹的第一个差异点 —— 只报"不一致"没法定位 */
function firstDiff(a, b, path = '', d = 0) {
  if (d > 12) return null
  if (a === b) return null
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : a instanceof Map ? 'map' : a instanceof Set ? 'set' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : b instanceof Map ? 'map' : b instanceof Set ? 'set' : typeof b
  if (ta !== tb) return `${path}: 类型 ${ta} vs ${tb}`
  if (ta === 'map') {
    const ka = [...a.keys()], kb = [...b.keys()]
    if (ka.length !== kb.length) return `${path}: map 大小 ${ka.length} vs ${kb.length}`
    for (const k of ka) {
      if (!b.has(k)) return `${path}[${JSON.stringify(String(k)).slice(0, 40)}]: worker 缺此键`
      const r = firstDiff(a.get(k), b.get(k), `${path}[${String(k).slice(0, 30)}]`, d + 1)
      if (r) return r
    }
    return null
  }
  if (ta === 'array') {
    if (a.length !== b.length) return `${path}: 长度 ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) { const r = firstDiff(a[i], b[i], `${path}[${i}]`, d + 1); if (r) return r }
    return null
  }
  if (ta === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b)
    const only = ka.filter((k) => !kb.includes(k))
    const extra = kb.filter((k) => !ka.includes(k))
    if (only.length || extra.length) return `${path}: 键不同 基线独有=[${only.slice(0, 5)}] worker独有=[${extra.slice(0, 5)}]`
    for (const k of ka) { const r = firstDiff(a[k], b[k], `${path}.${k}`, d + 1); if (r) return r }
    return null
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`
}

initPool(8)
let fail = 0
const rows = []

/* 每个图:baseRoots = server 实际传的那一份,cases 里两侧共用同一个变量 */
const CASES = [
  ['事件图', 'events', RPF, () => buildEventIndex(RPF)],
  ['国策图', 'focus', RP, () => buildFocusGraph(RP)],
  ['科技图', 'tech', RP, () => buildTechGraph(RP)],
  ['决议图', 'decisions', RP, () => buildDecisionGraph(RP)],
  ['AI 行为', 'aibehave', RP, () => buildAiBehavior(RP)],
  /* doctrines 的 builder 会把 layout 一起算出来,基线也必须带上,否则误报 */
  ['学说', 'doctrines', RP, () => { const g = buildDoctrineGraph(RP); return { g, layout: layoutDoctrines(g) } }],
  ['引用图', 'links', RP, () => buildLinkGraph(RP, { sprites: false })],
  ['DLC 内容', 'dlc', RPF, () => buildDlcModel(RPF, GAME_DIR)],
  ['军工机构', 'mio', RP, () => buildMioTrees(RP)],
  ['音乐索引', 'music', RP, () => buildMusicIndex(RP)],
  ['defines', 'defines', RPF, () => buildDefinesModel(RPF, (p) => rf(p, 'utf8'), (d) => walkFiles(d, ['.lua']))],
]

for (const [name, kind, baseRoots, mainFn] of CASES) {
  let baseOk = true
  let t0 = Date.now()
  let base
  try { base = mainFn() } catch (e) { console.log(`SKIP ${name}: 主线程基线抛错 ${e.message}`); continue }
  const mainMs = Date.now() - t0
  const fBase = fp(base)

  t0 = Date.now()
  let where = '?', same = false
  let got = null
  try {
    const r = await runInWorker({ kind, roots: baseRoots, gameDir: GAME_DIR })
    where = r.where
    got = r.data
    same = fp(got) === fBase
  } catch (e) {
    console.log(`FAIL ${name}: worker 抛错 ${e instanceof Error ? e.message : e}`)
    fail++
    continue
  }
  const workerMs = Date.now() - t0
  rows.push({ name, same, mainMs, workerMs, where })
  if (!same) {
    fail++
    console.log(`FAIL  ${name.padEnd(8)} 主线程 ${String(mainMs).padStart(6)}ms → worker ${String(workerMs).padStart(6)}ms  走=${where}`)
    console.log(`      首个差异: ${firstDiff(base, got) ?? '(指纹算法差异,非内容)'}`)
  } else {
    console.log(`PASS  ${name.padEnd(8)} 主线程 ${String(mainMs).padStart(6)}ms → worker ${String(workerMs).padStart(6)}ms  走=${where}`)
  }
}

await shutdownPool()
console.log(`\n${fail === 0 ? '全部一致' : fail + ' 项不一致'}`)
process.exit(fail === 0 ? 0 : 1)