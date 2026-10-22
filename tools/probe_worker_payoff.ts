/* probe_worker_payoff.ts —— worker_threads 收益可行性实测(2026-10-10)
 *
 * ★ 要回答的唯一问题:多核并行省下的 CPU 时间,会不会被
 *   postMessage 的结构化克隆(structured clone)吃掉?
 *
 * 实测(全部用真实引擎跑出来的数据形态,不造假):
 *   1. 真实 buildFast 耗时(主线程)          → T_build
 *   2. 20 万条 Map 条目的克隆往返耗时        → T_clone
 *   3. 分片合并成本(N 片的 Map 合成 1 个)    → T_merge
 *
 * 判据:分 N 片并行 → 墙钟 ≈ T_build/N + T_clone + T_merge
 *   只有明显小于 T_build 才值得上 worker。
 *
 * 用法: node --experimental-strip-types tools/probe_worker_payoff.ts
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { SymbolRegistry } from '../packages/engine/src/completion.ts'
import type { RootSpec, SymbolDef, SymbolRef } from '../packages/engine/src/completion.ts'

/* ★ Windows 中文路径:import.meta.url 是百分号编码的,且 pathname 在 Windows 上
 *   是 "/D:/..." 形式 —— 直接传给 Worker 会被解析成 "D:\D:\..."(实测踩过)。
 *   正解:fileURLToPath(import.meta.url),它同时处理编码与盘符。 */
const SELF = fileURLToPath(import.meta.url)

function here(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url))
}

/** 真实数据的形状:byName 是 Map<string, SymbolDef[]> */
interface Payload {
  byName: [string, SymbolDef[]][]
  byKey: [string, SymbolDef[]][]
  refs: SymbolRef[]
}

function gameRoot(): { name: string; path: string } {
  const root = here('../').replace(/[\\/]$/, '')
  try {
    const s = JSON.parse(readFileSync(join(root, 'gui-settings.json'), 'utf8'))
    const r = (s.sources || []).find((x: { kind?: string }) => x.kind === 'game') || (s.sources || [])[0]
    if (r) return { name: r.name, path: r.path }
  } catch { /* 回落 */ }
  return { name: 'vanilla', path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV' }
}

/** 起一个 worker 把 payload 原样传回,量端到端 ms */
function echo(p: Payload): Promise<{ ms: number; n: number }> {
  const t = Date.now()
  return new Promise((done, fail) => {
    const w = new Worker(SELF, { workerData: { payload: p }, execArgv: ['--experimental-strip-types'] })
    w.on('message', (m: { n: number }) => { void w.terminate(); done({ ms: Date.now() - t, n: m.n }) })
    w.on('error', fail)
  })
}

async function main(): Promise<void> {
  const specs = [gameRoot()] as RootSpec[]

  console.log('=== 1. 真实 buildFast 耗时(主线程) ===')
  const a0 = Date.now()
  const reg = new SymbolRegistry()
  reg.buildFast(specs)
  const tBuild = Date.now() - a0
  console.log(`  ${tBuild} ms · ${reg.stats.defs} 定义 / ${reg.stats.refs} 引用`)

  // 从真实 registry 抽出要跨线程传的结构
  const priv = reg as unknown as {
    byName: Map<string, SymbolDef[]>
    byKey: Map<string, SymbolDef[]>
    refs: SymbolRef[]
  }
  const payload: Payload = {
    byName: [...priv.byName.entries()],
    byKey: [...priv.byKey.entries()],
    refs: priv.refs,
  }
  const mb = Buffer.byteLength(JSON.stringify(payload)) / 1048576
  console.log(`  待传结构:byName ${payload.byName.length} / byKey ${payload.byKey.length} / refs ${payload.refs.length} 条,JSON ${mb.toFixed(1)} MB`)

  console.log('\n=== 2. 结构化克隆往返(含 worker 启动) ===')
  const r = await echo(payload)
  const tClone = Math.max(0, r.ms - 90) // 扣除 worker 启动估值(~90ms)
  console.log(`  端到端 ${r.ms} ms → 纯克隆约 ${tClone} ms,回传条目 ${r.n}`)

  console.log('\n=== 3. 分片合并成本(16 片合成 1 个 Map) ===')
  const m0 = Date.now()
  const shards = 16
  const merged = new Map<string, SymbolDef[]>()
  for (let s = 0; s < shards; s++) {
    const lo = Math.floor((payload.byName.length * s) / shards)
    const hi = Math.floor((payload.byName.length * (s + 1)) / shards)
    for (const [k, v] of payload.byName.slice(lo, hi)) {
      const ex = merged.get(k)
      if (ex) ex.push(...v)
      else merged.set(k, v)
    }
  }
  const tMerge = Date.now() - m0
  console.log(`  ${tMerge} ms · 合并后 ${merged.size} 个键`)

  console.log('\n=== 结论 ===')
  console.log(`  T_build ${tBuild} ms | T_clone ~${tClone} ms | T_merge ${tMerge} ms`)
  for (const n of [2, 4, 8, 16]) {
    const wall = tBuild / n + tClone + tMerge
    console.log(
      `  ${String(n).padStart(2)} 片并行 → 墙钟约 ${String(Math.round(wall)).padStart(6)} ms` +
        (wall < tBuild ? `  提速 ${(tBuild / wall).toFixed(2)}×` : '  反而更慢'),
    )
  }
  console.log('\n  ★ 判据:净提速 > 1.5× 且 T_clone 占比 < 40% 才值得上 worker。')
}

/* ★ worker 分支必须放在文件末尾 —— 顶层 if/else 里的函数声明是块级作用域,
 *   声明不提升,主线程侧会拿到 "main is not defined"。 */
if (isMainThread) {
  main().then(
    () => process.exit(0),
    (e) => { console.log(e); process.exit(1) },
  )
} else {
  const wd = workerData as { payload?: Payload }
  parentPort!.postMessage({ payload: wd.payload, n: wd.payload?.byName.length ?? 0 })
}
