/* smoke_pool.ts —— worker 池调度逻辑冒烟测试(2026-10-10)
 *
 * 为什么单独写:完整验收要构建 8 个图(106 MB),一旦调度逻辑死锁,
 * 反馈要等好几分钟。这里把并发上限压到 3、任务数拉到 12(9 个必须排队),
 * 用真实引擎跑(roots 指向不存在的目录 → 各图都很快返回空图),
 * 专门压调度路径:排队、派发、归还、并发上限。
 *
 * ★ 判据里特意包含「池满时排队」:这是死锁高发区 ——
 *   实测踩过 acquire() 因新建 worker 未入 idle 而整体死锁,
 *   日志停在「worker 池就绪」,进程无声退出,零报错。
 */
import { initPool, runInWorker, shutdownPool } from '../packages/gui/src/worker-pool.ts'
import type { JobKind } from '../packages/gui/src/worker-pool.ts'

const POOL = 3
const KINDS: JobKind[] = ['events', 'tech', 'decisions', 'aibehave', 'defines', 'dlc', 'mio', 'music']
/* 12 个任务 > 3 个槽 → 必有 9 个排队 */
const JOBS = Array.from({ length: 12 }, (_, i) => KINDS[i % 8])
/* 指向不存在的根:各图立刻返回空图,把耗时压到最低,只验调度 */
const ROOTS = [{ name: 'empty', path: 'C:/nonexistent_pool_smoke', writable: false }]

async function main(): Promise<void> {
  console.log(`=== 池并发上限 ${POOL},派发 ${JOBS.length} 个任务(${JOBS.length - POOL}+ 个需排队) ===`)
  initPool(POOL)

  const t0 = Date.now()
  const results = await Promise.all(JOBS.map((kind) => runInWorker({ kind, roots: ROOTS, gameDir: ROOTS[0].path })))
  const ms = Date.now() - t0

  const onWorker = results.filter((r) => r.where === 'worker').length
  const onMain = results.filter((r) => r.where === 'main').length
  console.log(`\n结果来源: worker ${onWorker} 个 / 主线程 ${onMain} 个`)
  console.log(`各任务: ${results.map((r, i) => `${JOBS[i]}=${r.where === 'worker' ? 'W' : 'M'}(${r.ms}ms)`).join(' ')}`)
  console.log(`总耗时 ${ms} ms`)

  let pass = true
  if (onMain > 0) {
    console.log(`✗ 有 ${onMain} 个任务落到主线程 —— worker 侧失败或调度退化`)
    pass = false
  } else {
    console.log(`✓ 全部 ${results.length} 个任务都在 worker 侧完成(排队路径未死锁)`)
  }

  await shutdownPool()
  console.log(pass ? '\n★ 调度逻辑通过' : '\n✗ 调度逻辑不通过')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.log('ERR', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})