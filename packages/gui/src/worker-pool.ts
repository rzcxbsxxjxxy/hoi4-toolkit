/**
 * worker-pool.ts —— 按需构建任务的 worker 并行执行器(2026-10-10)
 *
 * 为什么要有这个:启动队列里 9 个图任务是**互不依赖**的(各自扫自己的目录),
 * 却在一个线程里串行跑。实测串行总计约 1.9 s。
 *
 * ★★ 实测校正(两条,都是先量后写代码时踩到的):
 *  1. 回传体积是 **106.6 MB**,不是早先按 JSON.stringify 估的"4.8 MB"。
 *     JSON.stringify(new Map(...)) 恒为 "{}",会把几十 MB 的图算成 2 字节。
 *     真实体积用 postMessage 实测(tools/probe_clone.ts)。
 *  2. 所以"并行一定划算"并不成立 —— 判据不是任务耗时,而是
 *     **克隆耗时 / 构建耗时**。106.6 MB 的克隆要 ~1.8 s,而串行构建才 1.9 s,
 *     两者同量级。是否上并行由verify_worker_pool.ts 的实测比值决定,
 *     不由"理论上应该更快"决定。
 *
 * ★ 为什么结果直接 postMessage 裸对象、不走 serializeDeep 拆 Map:
 *   实测 8 个图产物**全部**无不可克隆值(无 DOM 引用/函数),structuredClone
 *   原生支持 Map/Set。包装形态比原生只大 0.7%,却要多跑两层递归 ——
 *   所以直接传。实测见 tools/probe_clone.ts 结论「8 个任务全部可直接克隆」。
 *
 * 降级:任何一步失败(worker 起不来 / 引擎导入失败 / 任务报错 / 超时)
 * 都回落到主线程同步跑,保证功能不依赖并行能力。
 */

import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 图对象里的 Map 字段统一按 entries 数组传 */
type Entries<V> = [string, V][]

/** 各图的可克隆投影 —— 必须与 hydrateXxx 一一对应 */
export type JobKind =
  | 'events' | 'focus' | 'tech' | 'decisions' | 'aibehave'
  | 'defines' | 'dlc' | 'mio' | 'music'
  /* PARALLEL_V2(2026-10-17)新增 —— 原先这三个没有 job-builder,一直跑在主线程 */
  | 'doctrines' | 'links' | 'loc'
  /* ★ loc 的流式通道专用。它【不进】job-builders 的 switch:
   *   流式要 postMessage 多次,而 buildGraph 的契约是「一次调用一条结果」,
   *   由 startWorkerLoop 单独分流(见 runLocLane)。列在 JobKind 里只是
   *   为了让 handler 那句 kind 判别有类型依据。 */
  | 'locLane'

/** 全部任务类型(供 initPool 批量登记降级实现) */
export const ALL_KINDS: readonly JobKind[] = [
  'events', 'focus', 'tech', 'decisions', 'aibehave', 'defines', 'dlc', 'mio', 'music',
  'doctrines', 'links', 'loc',
] as const

export interface JobRequest {
  kind: JobKind
  roots: { name: string; path: string; writable?: boolean; replacePaths?: readonly string[] }[]
  /** DLC 模型需要游戏目录(用于读 vanilla 的 dlc 定义) */
  gameDir?: string
  /** 本地化要建哪几种语言;不给就是 english + 简体中文 */
  wantLangs?: string[]
}

export interface JobOk {
  ok: true
  kind: JobKind
  ms: number
  /** 已转成 entries 形态的图数据 */
  data: Record<string, unknown>
}
export interface JobErr {
  ok: false
  kind: JobKind
  error: string
}
export type JobResult = JobOk | JobErr

/* ══════════════════════════════════════════════════════════════
 * worker 侧:构建 → 拆 Map → 回传
 * ══════════════════════════════════════════════════════════════ */

const me = fileURLToPath(import.meta.url)

async function runJob(req: JobRequest): Promise<JobResult> {
  const t = Date.now()
  /* ★ data 直接放引擎产出的裸对象 —— 不经 serializeDeep。
   *   实测 8 个图产物全部无不可克隆值,postMessage 原生就能传 Map/Set
   *   (tools/probe_clone.ts)。若将来某个图引入了 DOM 引用,
   *   postMessage 会抛 DataCloneError,被下面的 catch 接住 → 回落主线程。
   *
   * ★★ ms 必须在【await 之后】取:写在同一对象字面量里会先于 await 求值
   *   (对象属性按书写顺序求值),量到的只是动态 import 的耗时(实测 3ms
   *   vs 真实构建 3500ms)—— 差三个数量级,会让"并行收益"看起来虚高。 */
  try {
    const { buildGraph } = await import('./job-builders.ts')
    const data = await buildGraph(req)
    return { ok: true, kind: req.kind, ms: Date.now() - t, data }
  } catch (e) {
    return { ok: false, kind: req.kind, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
  }
}

/* ── 深拷贝工具(Map/Set ↔ 可克隆形态)────────────────────────────
 * ★ 这两个函数【不再是 worker 传输路径】——实测原生 postMessage 就能传 Map,
 *   包装只大0.7% 却多两层递归。它们保留作公共工具:调试时想看清某个图
 *   到底装了什么,调 serializeDeep 后 JSON.stringify 就能打印。
 *
 * ⚠ 用它们做体积测量会得到严重偏低的结果:JSON.stringify(new Map(...))
 *   恒为 "{}",几十 MB 的图会被算成 2 字节。要测真实传输量必须用
 *   postMessage 实测(见 tools/probe_clone.ts)。 */

/** 深度把 Map/Set 转成可克隆形态(嵌套对象里的也要转) */
export function serializeDeep(v: unknown, depth = 0): unknown {
  if (depth > 12) return null
  if (v instanceof Map) return { __m: [...v.entries()].map(([k, x]) => [k, serializeDeep(x, depth + 1)]) }
  if (v instanceof Set) return { __s: [...v].map((x) => serializeDeep(x, depth + 1)) }
  if (Array.isArray(v)) return v.map((x) => serializeDeep(x, depth + 1))
  if (v && typeof v === 'object') {
    // 普通对象:Date / RegExp 之类转字符串,其余逐字段递归
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src)) out[k] = serializeDeep(src[k], depth + 1)
    return out
  }
  return v
}

/** serializeDeep 的逆运算(主线程用) */
export function deserializeDeep<T>(v: unknown, depth = 0): T {
  if (depth > 12) return v as T
  if (Array.isArray(v)) return v.map((x) => deserializeDeep(x, depth + 1)) as unknown as T
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.__m)) {
      return new Map((o.__m as [unknown, unknown][]).map(([k, x]) => [k, deserializeDeep(x, depth + 1)])) as unknown as T
    }
    if (Array.isArray(o.__s)) {
      return new Set((o.__s as unknown[]).map((x) => deserializeDeep(x, depth + 1))) as unknown as T
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) out[k] = deserializeDeep(o[k], depth + 1)
    return out as T
  }
  return v as T
}

/* ══════════════════════════════════════════════════════════════
 * 主线程侧:worker 池
 * ══════════════════════════════════════════════════════════════ */

/* ★★★ worker 入口不能再用 SELF(见下)——必须指向【专用入口文件】。
 *
 * 原来的写法 `new Worker(me)`,在开发态(直接跑 server.ts)是对的;
 * 但打包后 esbuild 把整个后端(含本文件)内联成单文件 server.mjs,
 * `me` 就变成了 server.mjs 自己的路径。worker 线程加载它 = **把整个
 * server 引导流程重跑一遍**(rebuildIndexes → forceBuildAll → initPool → …),
 * 实测表现为:每个 worker 都在打 "[并行] worker 池就绪"、worker 内部再套一层
 * 建队列(递归建 worker),国策图构建从 1.7s 劣化到 11.2s。
 *
 * 修法:worker 走 worker-entry.{ts,mjs} —— 只 import 本文件的 worker 侧逻辑
 * 与 job-builders,绝不会碰到 server 的顶层副作用。
 *   开发态(跑 .ts):同级 worker-entry.ts
 *   打包态(server.mjs):同级 worker-entry.mjs(由 build:server 单独产出) */
const WORKER_ENTRY = me.endsWith('server.mjs')
  ? join(dirname(me), 'worker-entry.mjs')
  : join(dirname(me), 'worker-entry.ts')

/* ★★★ 修法(2026-10-17):Electron 壳用自带 Node 经 ELECTRON_RUN_AS_NODE 拉起
 *   server.mjs,而该 Node 版本**拒绝**把 --experimental-strip-types 作为 worker
 *   的 execArgv(直接抛 ERR_WORKER_INVALID_EXEC_ARGV,9 张图 + loc 流式全部失败)。
 *   但 worker-entry.mjs 是 esbuild 编出的**纯 JS**(target=node20),根本不需要
 *   类型擦除 —— 这个 flag 既多余又非法。
 *   判据:worker 入口是 .mjs(打包态/Electron 壳)→ 不传 flag;
 *        是 .ts(开发态,受管 Node 22 支持该 flag)→ 照传。 */
const WORKER_EXEC_ARGV = WORKER_ENTRY.endsWith('.ts')
  ? ['--experimental-strip-types']
  : []

/* ★★ PARALLEL_V2 补牢(2026-10-18,优化4):给每个 worker 加上限,防失控爆内存。
 *
 *   为什么需要:原来 new Worker(ENTRY, { execArgv }) 完全没传 resourceLimits,
 *   worker 老年代堆跟着系统默认上限走(32 位 ~1.4GB、64 位可达 ~4GB+/物理内存)。
 *   单个 worker 解析一张图的实测峰值约 300~600MB(见 job-builders / worker-pool
 *   注释里的载荷数据:决议图 40.7MB 裸对象、克隆后临时间翻倍)。把老年代硬顶到
 *   2048MB = 2GB:
 *     · 正常构建峰值(~0.6GB)远低于此,绝不会被误杀 OOM;
 *     · 万一某张图解析失控(死循环拼字符串 / 正则灾难)堆涨到 2GB,worker 会被
 *       V8 抛 OOM —— 本文件的 w.on('error') 会把它从池里剔除、任务回落主线程,
 *       而不是让整个工作台随着物理内存被吃光一起卡死。
 *   2GB 是「正常任务绝不会碰到、失控任务一定撞得到」的折中值。 */
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 2048,
} as const

const pool: Worker[] = []
let poolSize = 0
const idle: Worker[] = []
/* 等不到空闲 worker 的任务(池已满)。调度器在 worker 归还时从这里取。
 * ★ 没有这个队列的话,并发超过池大小时只有两个坏选择:无限 spawn
 *   (内存爆)或复用正在跑的 worker(消息串台)。 */
const queue: { req: JobRequest; done: (r: { data: unknown; ms: number; where: 'worker' | 'main' }) => void }[] = []
/* waiting 的每一条对应"某个 worker 上正在跑的一个任务"。
 * resolve/fail 是排他的 —— 超时回落和 worker 报错都可能先于结果到达,
 * 谁先到谁结掉这条,后来的直接被移除,不会重复结。 */
const waiting: { w: Worker; resolve: (r: JobResult) => void; fail: (e: Error) => void }[] = []

/** 从 waiting 里摘掉一条并返回它(找不到返回 null) */
function takeWait(w: Worker): { resolve: (r: JobResult) => void; fail: (e: Error) => void } | null {
  const i = waiting.findIndex((x) => x.w === w)
  if (i < 0) return null
  const t = waiting.splice(i, 1)[0]
  return t ? { resolve: t.resolve, fail: t.fail } : null
}

/** 取一个可用 worker:优先空闲 → 池未满则新建 → 否则返回 null(要排队) */
function acquire(): Worker | null {
  const w = idle.pop()
  if (w) return w
  if (pool.length < poolSize) {
    const n = spawn()
    /* ★ 新建的 worker 必须立刻放进 idle —— 它还没跑过任何任务。
     *   只 push 进 pool 的话,acquire() 会认为池已满而返回 null,
     *   任务全进 queue;而 dispatchQueued 只在"worker 归还"时触发,
     *   新建的 worker 永远不会归还 → 队列死锁,并行阶段静默挂死。
     *   (实测踩过:日志停在「worker 池就绪」,进程无声退出。) */
    const i = idle.indexOf(n)
    if (i < 0) idle.push(n)
    return n
  }
  return null
}

/** worker 归还时,立刻把排队里的下一个任务发出去 */
function dispatchQueued(w: Worker): void {
  const next = queue.shift()
  if (!next) return
  /* send 内部已把所有分支都 resolve,但仍兜一层 catch:
   * 万一 runFallback 本身抛(引擎文件缺失等),不能让这个 Promise 悬空 ——
   * 悬空的 Promise 会让整条构建队列永不完成,且没有任何报错。 */
  send(w, next.req).then(next.done, (e: unknown) => {
    console.log('  [并行] 排队任务派发失败:', e instanceof Error ? e.message : String(e))
    const t = Date.now()
    next.done({ data: null, ms: Date.now() - t, where: 'main' })
  })
}

/** 启动 worker 池(并发度由 cpu-probe 决定;1 表示不上 worker) */
export function initPool(workers: number): void {
  poolSize = Math.max(0, workers)
  /* 不在这里预 spawn:预建的 worker 既不在 idle 也不在跑,
   * acquire() 会误判池已满。改成"用到才建",由 acquire 负责入 idle。 */
  /* ★ 自动给所有任务类型登记主线程降级实现 —— 否则降级路径会抛
   *   "没有主线程 fallback 实现",把 worker 的偶发故障放大成整次构建失败。
   *   注意是动态 import(异步),而 runInWorker 可能紧随其后调用,所以
   *   runFallback 里还有一层"按需加载",两边都不靠对方就绪。*/
  void (async () => {
    try {
      const { buildGraph } = await import('./job-builders.ts')
      for (const k of ALL_KINDS) registerFallback(k, (r) => buildGraph(r))
    } catch (e) {
      console.log('  [并行] 降级实现注册失败:', e instanceof Error ? e.message : String(e))
    }
  })()
  console.log(
    poolSize > 0
      ? `  [并行] worker 池就绪:并发上限 ${poolSize}(按需创建)`
      : '  [并行] 并发度为 1,构建走主线程',
  )
}

function spawn(): Worker {
  const w = new Worker(WORKER_ENTRY, { execArgv: WORKER_EXEC_ARGV, resourceLimits: { ...WORKER_RESOURCE_LIMITS } })
  /* worker 侧回消息时可能已经有新的等待者排上来(超时回落后旧消息才到),
   * 所以按"消息到达"这一刻的队列来接,而不是按发消息时的快照 —— 否则
   * 快照已过期,消息会被丢弃,对应的 Promise 永远不 resolve。 */
  w.on('message', (r: JobResult) => {
    const t = takeWait(w)
    if (t) t.resolve(r)
    // ★ 必须先结掉当前任务,再把 worker 放回 idle 并派发下一个 ——
    //   反过来的话,派发的任务可能在 idle.push 之前就被取走,worker 双份。
    idle.push(w)
    // 池里缺人(被 terminate 过)就补一个
    if (pool.length < poolSize && !pool.includes(w)) pool.push(w)
    dispatchQueued(w)
  })
  w.on('error', (e) => {
    console.log('  [并行] worker 异常,回落主线程:', e.message)
    // 出错的 worker 不能复用,从池里剔除
    const i = pool.indexOf(w)
    if (i >= 0) pool.splice(i, 1)
    const j = idle.indexOf(w)
    if (j >= 0) idle.splice(j, 1)
    // ★ 出错时若还有等待者,必须把它们的 Promise 结掉 ——
    //   否则会一直挂到 120s 超时才回落,等于并行失效还白等两分钟。
    for (const t of [...waiting]) {
      if (t.w !== w) continue
      waiting.splice(waiting.indexOf(t), 1)
      t.fail(new Error(e.message))
    }
    void w.terminate()
    while (pool.length < poolSize) spawn()
  })
  pool.push(w)
  return w
}

/** 往 worker 发一个任务并登记等待(超时/失败自动回落主线程) */
async function send(w: Worker, req: JobRequest): Promise<{ data: unknown; ms: number; where: 'worker' | 'main' }> {
  return new Promise((resolve) => {
    /* 降级要跑 buildGraph(动态 import 的引擎模块),是异步的。
     * 所以这里用 settle 包一层:任何分支都交给它 await 完再 resolve。 */
    const settle = async (): Promise<{ data: unknown; ms: number; where: 'worker' | 'main' }> => {
      const t = Date.now()
      return { data: await runFallback(req), ms: Date.now() - t, where: 'main' as const }
    }
    const timer = setTimeout(() => {
      // worker 卡死(引擎里可能有死循环)→ 回落,别让整个构建队列停住
      console.log(`  [并行] ${req.kind} 在 worker 内超时(120s),回落主线程`)
      const i = waiting.findIndex((x) => x.w === w)
      if (i >= 0) waiting.splice(i, 1)
      void settle().then(resolve)
    }, 120000)
    waiting.push({
      w,
      resolve: (r) => {
        clearTimeout(timer)
        if (!r.ok) {
          console.log(`  [并行] ${req.kind} 在 worker 内失败,回落主线程:`, String(r.error).slice(0, 200))
          void settle().then(resolve)
          return
        }
        resolve({ data: r.data, ms: r.ms, where: 'worker' as const })
      },
      fail: () => {
        clearTimeout(timer)
        void settle().then(resolve)
      },
    })
    try {
      w.postMessage(req)
    } catch (e) {
      // ★ postMessage 同步抛错(典型:DataCloneError —— 图里混进了不可克隆值)。
      //   这时 worker 还没开始跑,必须把 waiting 撤掉并立刻回落,
      //   否则 120s 后才会超时,整条构建队列白等两分钟。
      clearTimeout(timer)
      const i = waiting.findIndex((x) => x.w === w)
      if (i >= 0) waiting.splice(i, 1)
      console.log(`  [并行] ${req.kind} postMessage 失败,回落主线程:`, e instanceof Error ? e.message : String(e))
      void settle().then(resolve)
    }
  })
}

/** 主线程跑(降级路径)。fallback 可由调用方覆盖。 */
let mainFallbacks = new Map<JobKind, (req: JobRequest) => unknown>()

/** 注册某个任务的主线程实现。生产代码用 initPool 的自动注册即可。 */
export function registerFallback(kind: JobKind, fn: (req: JobRequest) => unknown): void {
  mainFallbacks.set(kind, fn)
}

async function runFallback(req: JobRequest): Promise<unknown> {
  const fn = mainFallbacks.get(req.kind)
  if (fn) return await fn(req)
  // 未登记(动态 import 还没落地)→ 直接用引擎构建函数,不再抛错
  const { buildGraph } = await import('./job-builders.ts')
  return await buildGraph(req)
}

/**
 * 在 worker 里跑一个构建任务。
 * 池满时排队等空闲 worker(不无限 spawn,也不复用正在跑的 worker)。
 */
export async function runInWorker(req: JobRequest): Promise<{ data: unknown; ms: number; where: 'worker' | 'main' }> {
  if (poolSize <= 0) {
    const t = Date.now()
    return { data: await runFallback(req), ms: Date.now() - t, where: 'main' as const }
  }
  const w = acquire()
  if (w) return send(w, req)
  // 池已满:排队。等任一worker 归还时由 dispatchQueued 发出。
  /* ★ 排队也要有超时兜底 —— 排队路径上没有 send 的 120s 定时器,
   *   一旦调度逻辑出 bug(实测踩过:acquire 死锁),整个 Promise 永不 settle,
   *   构建队列静默挂死、进程无声退出,没有任何报错可查。 */
  return new Promise((resolve) => {
    /* 先建好 entry 再挂定时器 —— 定时器回调要靠 entry 引用把自己摘出去,
     * 若先 push 包装后的 done,再拿 resolve 去比对,永远匹配不上(实测踩过)。*/
    let entry: { req: JobRequest; done: (r: { data: unknown; ms: number; where: 'worker' | 'main' }) => void }
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry)
      if (i >= 0) queue.splice(i, 1)
      console.log(`  [并行] ${req.kind} 排队超时(180s),回落主线程`)
      const t = Date.now()
      void runFallback(req).then((data) => resolve({ data, ms: Date.now() - t, where: 'main' as const }))
    }, 180000)
    entry = {
      req,
      done: (r) => {
        clearTimeout(timer)
        resolve(r)
      },
    }
    queue.push(entry)
  })
}

/** 关停池(测试/退出用) */
export async function shutdownPool(): Promise<void> {
  const all = [...pool, ...idle]
  pool.length = 0
  idle.length = 0
  poolSize = 0
  await Promise.all(all.map((w) => w.terminate().catch(() => {})))
}

/* ══════════════════════════════════════════════════════════════
 * ★★ PARALLEL_V2:loc 专用的流式通道
 *
 * 为什么 loc 不走上面的 runInWorker(一次性 postMessage 传完整结果):
 *   实测(vanilla + 4 模组 / 3252 个 yml / 184 万条目):
 *     readFileSync  3.6s (19.1%)
 *     parseLocYml   8.5s (45.0%)   ← 合计 12.1s,占 64%,纯计算,搬得走
 *     合并进 Map    6.8s (35.9%)   ← 结果必须活在本线程,搬不走
 *   裸对象载荷 381MB / 595 万节点,structuredClone 的 deserialize 单趟 2671ms
 *   —— 主线程会被【连续】堵 2.7 秒。这比现状(主线程分片,单片 180ms)更糟,
 *   音乐缓冲必然断流。所以 loc 必须流式:每批几十 KB,逐批回来就合并。
 *
 * ★ 与 runInWorker 的结构差异:回传【单批】而不是整个索引,并且一条 worker
 *   连跑多批(每批 postMessage 一次)。所以它自己管 worker 生命周期,
 *   不走池的 acquire/queue —— 池是「一任务占一 worker」,流式要的是
 *   「一 worker 跑一条批次链」。混用会拿不到 worker(池里都被普通任务占着)。
 *
 * ★ 批次必须【连续】切给各条链:批次顺序决定覆盖链结果
 *   (同 key 后者覆盖前者)。交错发批会让译文算错 —— 隐蔽错误,界面不报错。
 *
 * 降级:任一条链失败 → 整体回落主线程 buildLocIndexAsync(分片,不阻塞)。
 */
export interface LocStreamStats {
  /** 总文件数 */
  files: number
  /** worker 侧解析累计 CPU ms */
  parseMs: number
  /** 主线程合并累计 CPU ms */
  mergeMs: number
  /** 批次总数 */
  batches: number
  /** 实际走了几条并行链(1 = 全在主线程降级) */
  chains: number
  /** 是否走了降级路径 */
  fallback: boolean
}

interface LocLaneMsg {
  t: 'loc-batch'
  /** 全局批号 —— 主线程按它重排后再合并(乱序合并会让覆盖链算反) */
  b: number
  items: { lang: string | null; hasBom: boolean; errorCount: number; entries: { key: string; value: string; line: number; index: number | null }[] } | null
  rootIdx: number[]
  rels: string[]
}
interface LocDoneMsg {
  t: 'loc-done'
  ok: boolean
  error?: string
}

export async function runLocStream(
  roots: { name: string; path: string; writable?: boolean; replacePaths?: readonly string[] }[],
  wantLangs: Set<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: true; index: unknown; stats: LocStreamStats }> {
  const { planLocBatches, newLocAcc, finalizeLocAcc, mergeLocBatch } = await import('./locsrv.ts')
  const { buildLocIndexAsync } = await import('./locsrv.ts')
  const jobs = planLocBatches(roots as never)
  const total = jobs.length
  const BATCH = 60
  const batches = Math.max(1, Math.ceil(total / BATCH))

  /* 一次性回退(worker 池没就绪):直接走主线程分片路径 */
  const fallback = async (why: string): Promise<{ ok: true; index: unknown; stats: LocStreamStats }> => {
    console.log('  [并行] 本地化改走主线程分片:', why)
    const idx = await buildLocIndexAsync(roots as never, { wantLangs })
    return { ok: true, index: idx, stats: { files: total, parseMs: 0, mergeMs: idx.ms, batches, chains: 1, fallback: true } }
  }

  if (poolSize <= 0) return fallback('worker 池未就绪')

  const acc = newLocAcc()
  const chains = Math.max(1, Math.min(poolSize, batches))
  const per = Math.ceil(batches / chains)
  const stats: LocStreamStats = { files: total, parseMs: 0, mergeMs: 0, batches, chains, fallback: false }

  /* ★★★ 按【全局批号】重排后再合并 —— 这是本函数最关键的一行逻辑。
   *
   *   多链并行时,跑在后面的链完全可能先回传(它的批次少、也可能只是抢到
   *   worker 先跑完)。若照到达顺序合并,「同 key 后者覆盖前者」就算反了。
   *   实测症状:值差 14031 处、来源差 25108 处 —— 模组(KR)的译文被原版
   *   同名 key 盖掉。界面不报错、HTTP 全 200、entries/dupKeys 也全对
   *   (那些只统计不参与覆盖),所以只有逐字段比对才抓得到。
   *
   *   做法:pending 按批号存,next 指向下一个该合并的批号。乱序到达的先
   *   攒着,等前面的批到齐了再一次性排空 —— 合并仍是主线程串行,
   *   只是顺序被强制纠正。 */
  const pending = new Map<number, LocLaneMsg>()
  let next = 0
  const merged = new Set<number>()

  const drain = (): void => {
    for (;;) {
      const m = pending.get(next)
      if (!m) break
      pending.delete(next)
      merged.add(next)
      next++
      const t0 = Date.now()
      mergeLocBatch(acc, { items: m.items, rootIdx: m.rootIdx }, m.rels, wantLangs)
      stats.mergeMs += Date.now() - t0
      onProgress?.(merged.size, batches)
      // 每批让出一次事件循环:让排队的 HTTP 请求(音乐取流就在其中)插进来。
      /* ★ 必须让在【合并之后】而不是消息回调里 —— 否则下一条消息处理时
       *   又会把几十批堆进同一个 tick,等于没流式。 */
      setImmediate(() => {})
    }
  }

  const lanes: Promise<void>[] = []
  for (let c = 0; c < chains; c++) {
    const from = c * per
    const to = Math.min((c + 1) * per, batches)
    if (from >= to) continue

    lanes.push(
      new Promise<void>((resolve, reject) => {
        let settled = false
        const bail = (e: Error): void => {
          if (settled) return
          settled = true
          void w.terminate().catch(() => {})
          reject(e)
        }
        const w = new Worker(WORKER_ENTRY, { execArgv: WORKER_EXEC_ARGV, resourceLimits: { ...WORKER_RESOURCE_LIMITS } })

        w.on('message', (m: LocLaneMsg | LocDoneMsg) => {
          if (m.t === 'loc-done') {
            if (settled) return
            settled = true
            void w.terminate().catch(() => {})
            if (!m.ok) reject(new Error(m.error ?? '未知错误'))
            else resolve()
            return
          }
          pending.set(m.b, m)
          drain()
        })
        w.on('error', (e) => bail(e))

        /* 一条链负责【连续】的一段批次。连续只是第一道保险:
         * 真正保证覆盖链正确的是上面的 drain() 按批号重排。 */
        const laneBatches: { rootIdx: number; rel: string; abs: string }[][] = []
        for (let b = from; b < to; b++) laneBatches.push(jobs.slice(b * BATCH, b * BATCH + BATCH))
        /* ★ from 必须传:worker 内是链内局部编号,不给它每条链都从 0 发。 */
        w.postMessage({ kind: 'locLane', batches: laneBatches, from })
      }),
    )
  }

  try {
    await Promise.all(lanes)
  } catch (e) {
    /* ★ 有一条链失败就整体重来。半途而废的 acc 已经混进了一批数据,
     *   与其想办法续跑,不如丢掉重建 —— 本地化不是增量可续的状态。 */
    return fallback(`worker 链失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  /* 收尾自检:所有批都必须已合并。少了批就是覆盖链不完整 ——
   * 静默放过去会得到一份「看着能用但少翻译」的索引。 */
  if (next !== batches) {
    return fallback(`批次不完整(已合并 ${next}/${batches})`)
  }

  return { ok: true, index: finalizeLocAcc(acc, stats.mergeMs), stats }
}

/* ══════════════════════════════════════════════════════════════
 * 入口分流:worker 侧执行任务
 * ══════════════════════════════════════════════════════════════ */
/** worker 侧入口:挂消息循环。由 worker-entry.ts 调用,不在本模块顶层自动执行。
 *  ★ 原来这里是顶层 `if (!isMainThread) parentPort.on('message', …)` ——
 *    打包后本模块在 server.mjs 里,主线程加载 server.mjs 时该分支不触发,
 *    但 worker 若再加载 server.mjs 就会连带触发整段 server 引导。职责已移交。*/
export function startWorkerLoop(): void {
  if (isMainThread) return
  parentPort!.on('message', (req: JobRequest | LocLaneReq) => {
    /* ★ locLane 走独立的流式分支:它要 postMessage 多次(每批一次),
     *   而 runJob 的契约是「一次任务 → 一条结果」。塞进同一个 handler
     *   会在收到中间批时误判成结果已到。 */
    if ((req as LocLaneReq).kind === 'locLane') {
      void runLocLane(req as LocLaneReq)
      return
    }
    void runJob(req as JobRequest).then((r) => parentPort!.postMessage(r))
  })
  // worker 侧必须保持存活等消息;不要因无事可做而退出
}

/* ── loc 流式 worker 侧 ──
 * 收到若干【批】,逐批 parse 并【逐批】postMessage 回去,最后发一条 done。
 * ★ 每批之间不 await 让出 —— worker 线程里没有 HTTP 要让,
 *   让出只会白白增加总时长(主线程侧才是需要让出的那一端)。
 *
 * ★ 每条消息都带全局批号 b —— 主线程据此【重排】后再合并。
 *   连续切批只保证了「分配连续」,不保证「到达连续」:多链并行时
 *   跑在后面的链完全可能先回传。乱序合并会让覆盖链算反 ——
 *   实测症状是模组的译文被原版同名 key 盖掉(界面不报错,只是译文错了)。*/
interface LocLaneReq {
  kind: 'locLane'
  /** 每批一个数组,顺序即全局批号 from, from+1, … */
  batches: { rootIdx: number; rel: string; abs: string }[][]
  /** ★ 本链第一批的【全局】批号。少了它每条链都会从 0 重新编号,
   *  主线程的 drain 会把 5 条链的「第 0 批」当成同一批 ——
   *  症状是只合并了 chains×1 批然后报「批次不完整」。 */
  from: number
}

async function runLocLane(req: LocLaneReq): Promise<void> {
  const t0 = Date.now()
  try {
    const { parseLocBatch } = await import('./locsrv.ts')
    let n = 0
    for (let i = 0; i < req.batches.length; i++) {
      const slice = req.batches[i]!
      if (!slice.length) continue
      const r = parseLocBatch(slice)
      n += slice.length
      parentPort!.postMessage({
        t: 'loc-batch',
        b: req.from + i,
        items: r.items,
        rootIdx: r.rootIdx,
        rels: slice.map((j) => j.rel),
      } satisfies LocLaneMsg)
    }
    parentPort!.postMessage({ t: 'loc-done', ok: true } satisfies LocDoneMsg)
    console.log(`  [并行] loc 流式解析完成 ${n} 文件 / ${req.batches.length} 批,${Date.now() - t0} ms`)
  } catch (e) {
    parentPort!.postMessage({
      t: 'loc-done',
      ok: false,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    } satisfies LocDoneMsg)
  }
}
