/**
 * verify_fallback.mts —— 验收降级路径:worker 池不可用时功能必须不受影响
 *
 * ★ 为什么必须单独验:并行的价值全在「成功路径」,而降级路径恰恰是
 *   【平时不执行、一出事才执行】的代码 —— 最容易在优化时被改坏。
 *   实测踩过:initPool(0) 之后 runInWorker 直接 return null data,
 *   图全空、界面报错但没人看见(因为大家机器上 worker 都能起)。
 *
 * 做法:initPool(0) 强制主线程,逐个跑全部图,断言内容非空且与并行结果一致。
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
const RP = rs.map((r) => ({ name: r.name, path: r.path }))
const RPF = rs.map((r) => ({ name: r.name, path: r.path, writable: r.writable }))
const GAME_DIR = rs.find((r) => !r.writable)?.path ?? rs[0].path

const { runInWorker, runLocStream, initPool } = await import(S('worker-pool.ts'))

let fail = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fail++ }

/* ── 阶段一:并行(池正常)取基线 ── */
initPool(8)
const PAR: Record<string, unknown> = {}
for (const [name, kind, roots] of [
  ['科技图', 'tech', RP], ['国策图', 'focus', RP], ['决议图', 'decisions', RP],
  ['AI 行为', 'aibehave', RP], ['学说', 'doctrines', RP], ['引用图', 'links', RP],
  ['DLC 内容', 'dlc', RPF], ['军工机构', 'mio', RP], ['音乐索引', 'music', RP],
  ['事件图', 'events', RPF], ['defines', 'defines', RPF],
]) {
  const r = await runInWorker({ kind, roots, gameDir: GAME_DIR } as never)
  if (r.where !== 'worker') { console.log(`★ ${name} 没走 worker(where=${r.where}),基线不可信`); fail++ }
  PAR[kind] = r.data
}
const PAR_LOC = (await runLocStream(RPF, new Set(['l_english', 'l_simp_chinese']))).index
console.log(`并行基线取完,${Object.keys(PAR).length} 图 + loc\n`)

/* ── 阶段二:强制主线程(initPool(0)) ── */
initPool(0)
console.log('initPool(0) —— 模拟 worker 起不来\n')

const TIMING = new Set(['ms', 'builtAt', 'at', 'since'])
function fp(v, d = 0, key = '') {
  if (d > 14) return '~'
  if (v === null || v === undefined) return 'n'
  const t = typeof v
  if (TIMING.has(key) && t === 'number') return '#t'
  if (t === 'number') return 'n' + v
  if (t === 'boolean') return v ? 'T' : 'F'
  if (t === 'string') return 's' + JSON.stringify(v)
  if (v instanceof Map) return 'M{' + [...v.entries()].map(([k, x]) => fp(k, d + 1) + ':' + fp(x, d + 1)).sort().join(',') + '}'
  if (v instanceof Set) return 'S{' + [...v].map((x) => fp(x, d + 1)).sort().join(',') + '}'
  if (Array.isArray(v)) return 'A[' + v.map((x, i) => fp(x, d + 1, String(i))).join(',') + ']'
  return 'O{' + Object.keys(v).sort().map((k) => k + ':' + fp(v[k], d + 1, k)).join(',') + '}'
}

for (const [name, kind, roots] of [
  ['科技图', 'tech', RP], ['国策图', 'focus', RP], ['决议图', 'decisions', RP],
  ['AI 行为', 'aibehave', RP], ['学说', 'doctrines', RP], ['引用图', 'links', RP],
  ['DLC 内容', 'dlc', RPF], ['军工机构', 'mio', RP], ['音乐索引', 'music', RP],
  ['事件图', 'events', RPF], ['defines', 'defines', RPF],
]) {
  const t = Date.now()
  const r = await runInWorker({ kind, roots, gameDir: GAME_DIR } as never)
  const ms = Date.now() - t
  const same = fp(r.data) === fp(PAR[kind])
  check(`${name} 降级到主线程且内容一致`, r.where === 'main' && same, `where=${r.where} ${ms}ms${same ? '' : ' ★内容不一致'}`)
}

/* loc 的降级:应自动改走 buildLocIndexAsync 并标注 fallback */
const t2 = Date.now()
const loc = await runLocStream(RPF, new Set(['l_english', 'l_simp_chinese']))
check('本地化 降级到主线程分片', loc.stats.fallback === true, `fallback=${loc.stats.fallback} ${Date.now() - t2}ms`)
check('本地化 降级后内容与并行一致', fp(loc.index) === fp(PAR_LOC))

console.log(`\n${fail === 0 ? '降级路径全部通过' : fail + ' 项失败'}`)
process.exit(fail === 0 ? 0 : 1)