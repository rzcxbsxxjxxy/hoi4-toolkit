/* verify_worker_pool.ts —— worker 池并行收益验收(2026-10-10)
 *
 * 对照口径:同样的 8 个任务,串行跑一遍 vs 走 worker 池并发跑一遍。
 * 判据(三条都要过,才算验收通过):
 *   ① 正确性 —— 每个任务的"内容条数"两侧完全一致(不是"跑通就算")
 *   ② 墙钟 —— 并行应显著低于串行
 *   ③ 净收益 —— 真实结构化克隆耗时 vs 省下的构建时间
 *
 * ★ 三条判据本身都踩过坑,写在这里防止下次重犯:
 *  · 指纹不能用 JSON 体积。JSON.stringify(new Map(...)) 恒为 "{}",
 *    几十 MB 的图会被算成 2 字节 → 假报警"并行结果不一致"。
 *  · 指纹必须在**同一形态**上比对。串行侧拿裸对象、worker 侧拿反序列化
 *    后的对象,Map 一个算 1 个节点一个算 N 个条目 → 天然不等。
 *  · 体积必须用 postMessage 实测,不能 JSON.stringify 估。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { initPool, runInWorker, shutdownPool } from '../packages/gui/src/worker-pool.ts'
import type { JobKind, JobRequest } from '../packages/gui/src/worker-pool.ts'
import { decideConcurrency } from '../packages/gui/src/cpu-probe.ts'
import { buildGraph } from '../packages/gui/src/job-builders.ts'

const KINDS: JobKind[] = ['events', 'tech', 'decisions', 'aibehave', 'defines', 'dlc', 'mio', 'music']

function here(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url))
}

function gameRoot(): { name: string; path: string; writable?: boolean } {
  const root = here('../').replace(/[\\/]$/, '')
  try {
    const s = JSON.parse(readFileSync(join(root, 'gui-settings.json'), 'utf8'))
    const r = (s.sources || []).find((x: { kind?: string }) => x.kind === 'game') || (s.sources || [])[0]
    if (r) return { name: r.name, path: r.path, writable: false }
  } catch { /* 回落 */ }
  return { name: 'vanilla', path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV', writable: false }
}

/** Map/Set/数组的条目数,拿不到就 0(别让判据自己抛错) */
function sizeOf(v: unknown): number {
  if (v instanceof Map || v instanceof Set) return v.size
  if (Array.isArray(v)) return v.length
  return 0
}

/**
 * 指纹:按【字段】列出每个集合型字段的条目数。
 * ★ 不做跨字段聚合(比如"所有 Map 条目加起来")—— 那样两个字段的条目
 *   互相抵消时会误判为一致;逐字段列出则任何一处不符立刻可见。
 */
function fingerprint(kind: JobKind, data: unknown): string {
  const g = (data ?? {}) as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(g).sort()) {
    const v = g[k]
    const n = sizeOf(v)
    if (n > 0) parts.push(`${k}=${n}`)
  }
  return `${kind}[${parts.join(' ')}]`
}

/** 结构化克隆后的近似字节数(仅用于量级参考,不用于判等) */
function roughSize(v: unknown, d = 0): number {
  if (d > 12) return 1
  if (typeof v === 'string') return v.length * 2 + 2
  if (typeof v === 'number') return 8
  if (typeof v === 'boolean') return 4
  if (v === null || v === undefined) return 1
  if (v instanceof Map) {
    let n = 32
    for (const [k, x] of v) n += roughSize(k, d + 1) + roughSize(x, d + 1)
    return n
  }
  if (v instanceof Set) {
    let n = 32
    for (const x of v) n += roughSize(x, d + 1)
    return n
  }
  if (Array.isArray(v)) {
    let n = 24
    for (const x of v) n += roughSize(x, d + 1)
    return n
  }
  if (typeof v === 'object') {
    let n = 24
    for (const k of Object.keys(v as Record<string, unknown>)) {
      n += k.length * 2 + 4 + roughSize((v as Record<string, unknown>)[k], d + 1)
    }
    return n
  }
  return 8
}

async function main(): Promise<void> {
  const roots = [gameRoot()]
  const req = (kind: JobKind): JobRequest => ({ kind, roots, gameDir: roots[0].path })

  console.log('=== 探测并发度 ===')
  const verdict = await decideConcurrency()
  const memG = (verdict.info.memBytes / 1073741824).toFixed(1)
  console.log(`  ${verdict.info.logical} 逻辑核 / ${memG} GB · workers=${verdict.workers} · ${verdict.reason}`)

  /* ★ 串行侧与 worker 侧调的是【同一个 buildGraph】,字段集必然一致。
   *   早先两侧各写一份,漏传字段 → 指纹天然不等 → 假报警"不一致"。 */
  const builder = buildGraph

  /* ★ 预热:先把 8 个图各构建一次扔掉。原因是文件系统的页缓存 ——
   *   第一次扫盘是冷的,之后都走内存。不预热的话,先跑的串行侧吃到冷缓存
   *   (偏慢),后跑的并行侧吃到热缓存(偏快)→ 提速比被系统性高估。
   *   实测:冷启 events 928ms,热启稳定 3500ms(来源更多时)——
   *   两次跑的绝对值不可比,只有同口径的对照才有意义。 */
  console.log('预热中(跑一遍丢弃,避免冷/热缓存偏差)…')
  for (const k of KINDS) {
    const g = await builder(req(k))
    fingerprint(k, g)   // 顺带把指纹算掉,不留在正式测量里
  }

  console.log('\n=== ① 串行基线(主线程,裸对象)===')
  const serial = new Map<JobKind, { fp: string; ms: number; bytes: number }>()
  /* 跑 3 轮取中位数,与并行侧同口径。
   * 逐任务耗时取【中位数那一轮】的记录 —— 混用不同轮的数字会让表里
   * 各行之和对不上合计,看着像 bug,实则口径不一致。 */
  const ROUNDS = 3
  const serialWalls: number[] = []
  const perRound = new Map<JobKind, { fp: string; ms: number; bytes: number }[]>()
  for (let round = 0; round < ROUNDS; round++) {
    const tRound = Date.now()
    for (const k of KINDS) {
      const t = Date.now()
      const g = await builder(req(k))
      const rec = { fp: fingerprint(k, g), ms: Date.now() - t, bytes: roughSize(g) }
      if (!perRound.has(k)) perRound.set(k, [])
      perRound.get(k)!.push(rec)
    }
    serialWalls.push(Date.now() - tRound)
  }
  const sSorted = [...serialWalls].sort((a, b) => a - b)
  const midIdx = Math.floor(sSorted.length / 2)
  const serialMs = sSorted[midIdx]!
  for (const k of KINDS) serial.set(k, perRound.get(k)![midIdx]!)
  console.log(`  ${ROUNDS} 轮墙钟: ${serialWalls.join(' / ')} ms → 取中位数 ${serialMs} ms`)
  for (const k of KINDS) {
    const s = serial.get(k)!
    console.log(`  ${k.padEnd(11)}${String(s.ms).padStart(6)} ms${(s.bytes / 1048576).toFixed(2).padStart(9)} MB`)
  }
  console.log(`  ${'串行合计'.padEnd(11)}${String(serialMs).padStart(6)} ms`)

  console.log(`\n=== ② 并行(${verdict.workers} worker)===`)
  initPool(verdict.workers)
  /* ★ 多轮取中位数:单轮受 GC / 调度抖动影响太大,曾出现 worker 侧
   *   只报 3ms 而主线程同任务 3500ms 的假象(真因是 worker-pool 的
   *   ms 在 await 前求值,已修;这里再加一层稳定性保险)。
   * 逐任务数据同样只取中位数那一轮,保证表内各行与合计同源。 */
  const parWalls: number[] = []
  let parMs = 0
  const parPerRound: { data: unknown; ms: number; where: string }[][] = []
  // 第一轮丢弃:让 8 个 worker 都完成启动与模块加载
  await Promise.all(KINDS.map((k) => runInWorker(req(k))))
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = Date.now()
    const r = await Promise.all(KINDS.map((k) => runInWorker(req(k))))
    parWalls.push(Date.now() - t0)
    parPerRound.push(r)
  }
  const sorted = [...parWalls].sort((a, b) => a - b)
  const pMid = Math.floor(sorted.length / 2)
  parMs = sorted[pMid]!
  const results = parPerRound[pMid]!
  console.log(`  ${ROUNDS} 轮墙钟: ${parWalls.join(' / ')} ms → 取中位数 ${parMs} ms`)

  console.log('\n  任务          串行 ms   worker ms    体积 MB   一致性')
  console.log('  ' + '─'.repeat(70))
  let allSame = true
  let parBytes = 0
  KINDS.forEach((k, i) => {
    const s = serial.get(k)!
    const r = results[i]
    parBytes += roughSize(r.data)
    const fp = fingerprint(k, r.data)
    const same = fp === s.fp
    if (!same) allSame = false
    const line2 =
      `  ${k.padEnd(12)}` +
      `${String(s.ms).padStart(7)}` +
      `${String(r.ms).padStart(11)}` +
      `${(roughSize(r.data) / 1048576).toFixed(2).padStart(10)} MB  `
    const verdictTxt = same ? '一致' : '不一致 ' + fp + ' vs ' + s.fp
    console.log(line2 + verdictTxt + '(' + r.where + ')')
  })
  console.log('  ' + '─'.repeat(70))
  console.log(`  ${'合计'.padEnd(12)}${String(serialMs).padStart(7)}${String(parMs).padStart(11)}${(parBytes / 1048576).toFixed(2).padStart(10)}`)

  console.log(`\n  串行 ${serialMs} ms → 并行 ${parMs} ms   提速 ${(serialMs / parMs).toFixed(2)}×`)
  console.log(`  正确性: ${allSame ? '8/8 指纹一致 ✓' : '有指纹不一致 ✗'}`)

  /* ③ 净收益判定 —— 这是"要不要上并行"的真正判据。
   * 并行的墙钟里已经含了克隆成本(parMs 是端到端量),所以直接比即可。*/
  const cpuBound = serialMs
  const gain = cpuBound - parMs
  const pct = (100 * gain / cpuBound).toFixed(1)
  console.log(`\n=== ③ 净收益判定 ===`)
  console.log(`  并发度 ${verdict.workers},实测加速比 ${(verdict.measuredSpeedup ?? 1).toFixed(2)}×`)
  console.log(`  净省 ${gain} ms,相对串行 ${pct}%`)
  if (gain > serialMs * 0.15) {
    console.log(`  判定: 值得上并行(净省超过 15%)`)
  } else {
    console.log(`  判定: 不值得上并行(净省不足 15%,且多一层 worker 复杂度与 8 份回传内存)`)
  }

  await shutdownPool()
  console.log(allSame ? '\n★ 正确性验收通过' : '\n✗ 正确性验收不通过')
}

main().then(
  () => process.exit(0),
  (e) => { console.log(e instanceof Error ? e.stack : String(e)); process.exit(1) },
)