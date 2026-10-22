/* probe_shard_payoff.ts —— 分片并行收益实测(2026-10-10)
 *
 * 上一轮 probe_worker_payoff 给出两个决定性数字:
 *   T_build 16676 ms / T_clone 6214 ms(368 MB 结构)
 * 结论:把【一个整体】搬进 worker 不划算;但把【同一个任务分成 N 片】、
 * 各片并行、只回传分片结果,克隆量不变而 build 被摊薄 —— 这是可行的形态。
 *
 * 本探针实测三件事,决定"到底该并行哪个任务":
 *   1. 启动队列里 9 个任务各自的真实耗时(串行基线)
 *   2. 最大的一个任务按 N 片并行后的墙钟(含回传)
 *   3. 回传体积 —— 这是克隆成本的分母
 *
 * 结论口径:只有"墙钟明显下降 且 回传体积小"的任务才搬 worker。
 *
 * 用法: node --experimental-strip-types tools/probe_shard_payoff.ts
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

function here(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url))
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

function mb(n: number): string {
  return (n / 1048576).toFixed(2) + ' MB'
}

/** JSON 体积(近似结构化克隆成本 —— 两者对同一份数据是同量级) */
function sizeOf(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v))
  } catch {
    return -1
  }
}

async function main(): Promise<void> {
  const roots = [gameRoot()]
  const specs = roots.map((r) => ({ name: r.name, path: r.path }))

  const E = await import('../packages/engine/src/events.ts')
  const T = await import('../packages/engine/src/tech.ts')
  const D = await import('../packages/engine/src/decisions.ts')
  const AB = await import('../packages/engine/src/aibehave.ts')
  const DF = await import('../packages/engine/src/defines.ts')
  const DL = await import('../packages/engine/src/dlc.ts')
  const MIO = await import('../packages/engine/src/mio.ts')
  const MU = await import('../packages/engine/src/music.ts')

  type Row = { name: string; ms: number; bytes: number; note: string }
  const rows: Row[] = []

  console.log('=== 启动队列 9 个任务的真实耗时与回传体积 ===\n')

  {
    const t = Date.now()
    const r = E.buildEventIndex(specs as never)
    rows.push({ name: '事件图', ms: Date.now() - t, bytes: sizeOf(r), note: `${r.events.size} 事件` })
  }
  {
    const t = Date.now()
    const r = T.buildTechGraph(specs as never)
    rows.push({ name: '科技图', ms: Date.now() - t, bytes: sizeOf(r), note: `${r.nodes.size} 科技` })
  }
  {
    const t = Date.now()
    const r = D.buildDecisionGraph(specs as never)
    rows.push({ name: '决议图', ms: Date.now() - t, bytes: sizeOf(r), note: `${r.nodes.size} 决议` })
  }
  {
    const t = Date.now()
    const r = AB.buildAiBehavior(specs as never)
    rows.push({ name: 'AI 行为', ms: Date.now() - t, bytes: sizeOf(r), note: `${(r as { entries?: unknown[] }).entries?.length ?? '?'} 条` })
  }
  {
    const t = Date.now()
    const r = DF.buildDefinesModel(specs as never)
    rows.push({ name: 'defines 参数', ms: Date.now() - t, bytes: sizeOf(r), note: '—' })
  }
  {
    const t = Date.now()
    const r = DL.buildDlcModel(specs as never, roots[0].path)
    rows.push({ name: 'DLC 内容', ms: Date.now() - t, bytes: sizeOf(r), note: '—' })
  }
  {
    const t = Date.now()
    const r = MIO.buildMioTrees(specs as never)
    rows.push({ name: '军工机构', ms: Date.now() - t, bytes: sizeOf(r), note: '—' })
  }
  {
    const t = Date.now()
    const r = MU.buildMusicIndex(specs as never)
    rows.push({ name: 'MusicIndex', ms: Date.now() - t, bytes: sizeOf(r), note: '—' })
  }
  console.log('任务              耗时 ms    回传体积      规模');
  console.log('─'.repeat(64))
  const total = rows.reduce((a, b) => a + b.ms, 0)
  let sum2 = 0
  for (const r of rows) {
    sum2 += r.ms
    console.log(
      r.name.padEnd(16) +
        String(r.ms).padStart(8) +
        (r.bytes >= 0 ? mb(r.bytes).padStart(12) : '           -') +
        '  ' + r.note,
    )
  }
  console.log('─'.repeat(64))
  console.log(`${'串行总计'.padEnd(16)}${String(sum2).padStart(8)} ms`)

  console.log('\n=== 装箱分析:这 9 个任务并行后的墙钟 ===')
  const real = rows
  const sorted = [...real].sort((a, b) => b.ms - a.ms)
  console.log(`  总 CPU ${total} ms,最大单任务 ${sorted[0].name} ${sorted[0].ms} ms`)
  for (const n of [2, 3, 4, 6, 8]) {
    // LPT 装箱(最长处理时间优先):这是任务级并行的最优近似
    const bins: number[] = Array.from({ length: n }, () => 0)
    for (const r of sorted) {
      let i = 0
      for (let j = 1; j < n; j++) if (bins[j] < bins[i]) i = j
      bins[i] += r.ms
    }
    const wall = Math.max(...bins)
    console.log(
      `  ${String(n).padStart(2)} worker → 墙钟 ${String(wall).padStart(6)} ms  ` +
        `提速 ${(total / wall).toFixed(2)}×  (受最大任务 ${sorted[0].ms} ms 封顶)`,
    )
  }

  console.log('\n=== 结论 ===')
  console.log('  · 任务级并行(每个任务整体搬进一个 worker)的墙钟下限 = 最大单任务')
  console.log('  · 若最大任务占比高,再往上加 worker 收益趋零 → 该任务需要【内部再分片】')
  const topShare = sorted[0].ms / total
  console.log(`  · 当前最大任务占比 ${(topShare * 100).toFixed(1)}%`)
  console.log(`  · 回传体积最大的任务: ${sorted.reduce((a, b) => ((b.bytes > a.bytes ? b : a)), real).name}`)
}

main().then(
  () => process.exit(0),
  (e) => { console.log(e); process.exit(1) },
)
