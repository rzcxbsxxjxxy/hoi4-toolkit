// ============================================================================
// worker-entry.ts —— worker 线程【专用】入口(2026-10-17)
//
// ★★ 为什么必须单独一个文件,不能继续用 worker-pool.ts 自身当 worker 入口:
//
// 开发态直接跑 server.ts 时,new Worker(<worker-pool.ts 的路径>) 没问题;
// 但打包后 esbuild 把整个后端内联成单文件 server.mjs,worker-pool 的代码就在
// server.mjs 里,于是 worker 线程加载 server.mjs = 把 server 的顶层引导全部
// 重跑一遍(rebuildIndexes → forceBuildAll → initPool → 又一套 worker 池…),
// 递归且日志串味。实测症状:每个 worker 都打 "[并行] worker 池就绪",
// 国策图构建从 1.7s 劣化到 11.2s。
//
// 所以 worker 只加载本文件:它不 import server.ts,也就没有任何顶层副作用,
// 干净地只做「收任务 → 跑 → 回传」。真正的构建逻辑由 job-builders 按需
// 动态 import 引擎模块。
//
// 由 build:server 一并产出 worker-entry.mjs(见 package.json 的 build:server)。
// ============================================================================

import { isMainThread, parentPort } from 'node:worker_threads'

// 顶层即 worker 侧:挂消息监听后保持存活,等主线程派活。
// 双保险:isMainThread 为真说明被误当主线程加载了,直接退出而不是空转。
if (isMainThread) {
  console.error('[并行] worker-entry 被当作主线程加载,这是错误用法')
} else {
  // 动态 import 而非静态:让「挂监听」这件事发生在 import 完成后,
  // 且避免把 job-builders 的依赖图提前拉进来。
  void (async () => {
    const { startWorkerLoop } = await import('./worker-pool.ts')
    startWorkerLoop()
  })()
  // parentPort 必须已被引用,否则 worker 可能因无事可做提前退出
  void parentPort
}