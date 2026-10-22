/**
 * cpu-probe.ts —— 处理器性能探测与并发度决策(2026-10-10)
 *
 * 目标:在零配置的前提下,按"这台机器到底能并行多少"来决定 worker 数量,
 * 而不是拍一个 `Math.min(4, cpus-1)`。
 *
 * ★ 为什么不能只看 os.cpus().length:
 *   ① 超线程的两个硬件线程共享同一个执行单元。纯整数解析这类负载,
 *      第二个线程通常只能拿到 60~70% 边际收益 —— 24 逻辑核 ≠ 24 份算力。
 *   ② 虚拟机/容器里 os.cpus() 可能报宿主机的核数,与实际可用配额不符。
 *   ③ 老机器(4 核)与新机器(24 核)的最佳并发度差 6 倍,固定值必然一边浪费一边不够。
 *
 * 因此这里做两级探测:
 *   静态:os.cpus() 的 model/速度、物理 vs 逻辑核推断、可用并行度(os.availableParallelism)
 *   动态:在若干个真 worker 上跑同一段定标负载,量出**实测加速比**
 *
 * 探测结果缓存到 temp/_cpu_probe.json(默认 24h 过期),避免每次启动都付探测成本。
 */

import { cpus, availableParallelism, totalmem, loadavg } from 'node:os'
import { join } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TEMP_DIR } from './cache.ts'

export interface CpuInfo {
  /** 逻辑核数(os.cpus().length) */
  logical: number
  /** Node 认可的可用并行度(尊重 cgroup 配额,比 cpus() 准) */
  available: number
  /** 推断的物理核数(超线程机器上 < logical) */
  physical: number
  /** CPU 型号(仅作日志识别) */
  model: string
  /** 总内存字节 */
  memBytes: number
  /** 1 分钟平均负载(启动时通常为 0,不可靠,仅记录) */
  load1: number
}

export interface CpuVerdict {
  info: CpuInfo
  /** 建议的 worker 并发度(1 = 不上 worker,走串行) */
  workers: number
  /** 实测加速比(定标负载,worker 数 = workers);探测失败时为 null */
  measuredSpeedup: number | null
  /** 为什么给这个数(写进日志,便于事后判断) */
  reason: string
}

/** 取 CPU 信息(纯读取,无副作用) */
export function readCpuInfo(): CpuInfo {
  const list = cpus()
  const logical = list.length
  let available = 1
  try {
    // Node 18.14+ 有;它会考虑 cgroup CPU 配额与 cpuset
    available = availableParallelism()
  } catch {
    available = logical
  }
  /* 物理核推断 —— ★ 这里刻意【不】用 model+speed 分组。
   *
   * 实测坑(本机 i9-13900HX):24 个逻辑核的 model 与 speed 完全一致
   * (全是 "13th Gen Intel(R) Core(TM) i9-13900HX|2419"),分组得 1 组 ×24,
   * 于是"成对即物理核"的推断会得出 12 —— 而真实是 8 个 P 核 + 16 个超线程。
   * os.cpus() 在混合架构(P/E 核)上不给任何可区分的信息,任何基于它的推断都是猜。
   *
   * 所以:physical 只报 os 明确给出的数(Windows 恒为逻辑数,即 physical=logical),
   * 真正的并发度由 measureSpeedup() 的【实测】决定,静态启发式只作探测失败时的兜底。 */
  const physical = logical

  return {
    logical,
    available: Math.max(1, available),
    physical: Math.max(1, physical),
    model: (list[0]?.model ?? 'unknown').trim(),
    memBytes: totalmem(),
    load1: loadavg()[0] ?? 0,
  }
}

/* ── 定标负载 ────────────────────────────────────────────────
 * 用整数混合(和 FNV-1a 同型)模拟解析器的实际运算形态:大量短循环、
 * 无浮点、无分配。这样测出的比值不会被 GC 或 JIT 优化差异污染。
 * ★ 刻意不用 Math.random / 正则:那些的方差会大到掩盖真实差异。
 *
 * ★ 负载要足够大:worker 冷启动约 90 ms,如果单份只跑 60 ms,
 *   启动开销就吃掉大半,测出来的"加速比"会被系统性低估。
 *   2e8 次 ≈ 500~900 ms,是启动开销的 6~10 倍,比例可接受。 */
function calibration(n: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < n; i++) {
    h ^= i & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
    h ^= (i >> 8) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const CAL_N = 2e8

/* ── worker 侧 ── */
if (!isMainThread && workerData && (workerData as { __cal?: boolean }).__cal) {
  const t = Date.now()
  const h = calibration(CAL_N)
  parentPort!.postMessage({ ms: Date.now() - t, h })
}

/** 跑 n 个 worker 并行执行定标负载,返回墙钟 ms */
async function runCalibration(n: number): Promise<number> {
  const t0 = Date.now()
  const workers: Worker[] = []
  // ★ 必须用 fileURLToPath:Windows 上 import.meta.url 的 pathname 是
  //   "/D:/..." 形式,直接传给 Worker 会被解析成 "D:\D:\..."(实测踩过)。
  const self = fileURLToPath(import.meta.url)
  /* ★★★ 与 worker-pool 同一判据:Electron 壳用自带 Node(v20)拉起 server.mjs,
   *   它【拒绝】把 --experimental-strip-types 当 worker execArgv,直接抛
   *   ERR_WORKER_INVALID_EXEC_ARGV。而 self 在打包态是编译后的【纯 JS】
   *   server.mjs,根本不需要类型擦除。故 .mjs 不传 flag,.ts(开发态)照传。 */
  const calExecArgv = self.endsWith('.ts') ? ['--experimental-strip-types'] : []
  try {
    await Promise.all(
      Array.from({ length: n }, () => new Promise<void>((done, fail) => {
        const w = new Worker(self, {
          workerData: { __cal: true },
          execArgv: calExecArgv,
        })
        workers.push(w)
        w.on('message', () => done())
        w.on('error', fail)
      })),
    )
  } finally {
    for (const w of workers) void w.terminate()
  }
  return Date.now() - t0
}

/**
 * 动态探测:实测在 n 个 worker 上并行跑【n 份】定标负载的加速比,并据此定并发度。
 * 返回 null 表示探测不可用(worker 起不来等),调用方应回落到静态启发式。
 *
 * ★ 加速比的定义必须是 (n × 单份耗时) / n worker 墙钟 —— 不是 单份/墙钟。
 *   后者量的是"并行效率"(n worker 跑 1 份),永远 ≤ 1,会误判成"并发无收益"。
 */
async function measureSpeedup(logical: number): Promise<{ n: number; speedup: number } | null> {
  try {
    // 单份基线(主线程跑两次取小的,压掉 JIT 预热与调度抖动)
    calibration(CAL_N / 10) // 预热
    let base = Number.MAX_SAFE_INTEGER
    for (let k = 0; k < 2; k++) {
      const t = Date.now()
      calibration(CAL_N)
      base = Math.min(base, Date.now() - t)
    }

    // 逐档加 worker,找"加速比开始变平"的拐点 —— 那才是最佳并发度。
    // 上限 8:再多对纯 CPU 负载也没明显收益,却要付内存与调度成本。
    const cands = [2, 4, 8].filter((n) => n <= Math.max(2, logical))
    if (!cands.length) return { n: 1, speedup: 1 }

    let best = { n: 1, speedup: 1 }
    for (const n of cands) {
      const wall = await runCalibration(n)
      // n 个 worker 干 n 份活,理想墙钟 = base(每份独占一核)
      const speedup = (n * base) / Math.max(1, wall)
      // ★ 边际收益判据:提速不到 12% 就不再加 worker
      if (speedup > best.speedup * 1.12) best = { n, speedup }
    }
    return best
  } catch {
    return null
  }
}

/** 缓存文件路径(探测有成本,别每次启动都付) */
function probeCachePath(): string {
  try {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })
  } catch { /* 目录建不了就直接不缓存 */ }
  return join(TEMP_DIR, '_cpu_probe.json')
}

const CACHE_TTL = 24 * 3600 * 1000

export interface ConcurrencyOptions {
  /** 强制指定并发度(测试/排障用);给 1 表示强制串行。优先级高于 cap/fixed */
  force?: number
  /** 是否跑动态探测(默认 true;探测约 1~2 秒,结果缓存 24h) */
  probe?: boolean
  /** 忽略缓存重新探测(PERF_V1:设置页的「重新测量」按钮) */
  refresh?: boolean
  /** 缓存有效期(小时)。默认 24 */
  cacheHours?: number
  /** worker 数上限(用户手动封顶) */
  cap?: number
  /** 设置页里锁定的并发度('auto' 时不传) */
  fixed?: number
}

/**
 * 主入口:决定 worker 并发度。
 * @param opts.force 强制指定并发度(测试/排障用);给 1 表示强制串行
 * @param opts.probe 是否跑动态探测(默认 true;探测约 1~2 秒,结果缓存 24h)
 */
export async function decideConcurrency(opts: ConcurrencyOptions = {}): Promise<CpuVerdict> {
  const info = readCpuInfo()
  const ttl = (opts.cacheHours ?? 24) * 3600 * 1000

  if (opts.force !== undefined && opts.force > 0) {
    return {
      info,
      workers: Math.max(1, Math.min(opts.force, info.available)),
      measuredSpeedup: null,
      reason: `调用方强制指定 workers=${opts.force}`,
    }
  }

  /* PERF_V1:设置页锁定优先于探测 —— 用户显式选的值不该被自动探测覆盖。 */
  if (opts.fixed !== undefined && opts.fixed > 0) {
    return {
      info,
      workers: Math.max(1, Math.min(opts.fixed, info.available)),
      measuredSpeedup: null,
      reason: `设置里已锁定 workers=${opts.fixed}(不跑探测)`,
    }
  }

  /* ── 缓存命中 ── */
  if (opts.probe !== false && !opts.refresh) {
    try {
      const p = probeCachePath()
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { t: number; n: number; s: number }
        if (Date.now() - j.t < ttl && j.n > 0) {
          // 机器换了(核数变了)→ 缓存作废
          if (info.logical === (j as unknown as { logical?: number }).logical) {
            const workers = opts.cap ? Math.max(1, Math.min(j.n, opts.cap)) : j.n
            return {
              info,
              workers,
              measuredSpeedup: j.s,
              reason:
                `用缓存的探测结果(${opts.cacheHours ?? 24}h 内有效,实测加速比 ${j.s.toFixed(2)}×)` +
                (opts.cap && opts.cap < j.n ? `,已按上限收到 ${workers}` : ''),
            }
          }
        }
      }
    } catch { /* 缓存坏了就当没有 */ }
  }

  /* ── 静态启发式(探测失败时的兜底) ── */
  const staticPick = staticHeuristic(info)

  if (opts.probe === false) {
    return { info, workers: staticPick, measuredSpeedup: null, reason: '按静态启发式(未跑动态探测)' }
  }

  /* ── 动态探测 ── */
  const m = await measureSpeedup(info.logical)

  if (!m) {
    return { info, workers: staticPick, measuredSpeedup: null, reason: '动态探测失败,按静态启发式' }
  }

  /* 实测出来的并发度。判据:
   * · 只有 1 核可用 → 串行
   * · 探测到的最佳档若其"每 worker 平均贡献"太低(< 0.35 份),
   *   说明这台机器此刻有别的负载吃掉了核 → 退回静态启发式。 */
  const perWorker = m.speedup / m.n
  const rawWorkers = m.n < 2 ? staticPick : m.n
  /* PERF_V1:用户设的上限在这里生效 —— 探测出 8 但用户封顶 4,就只开 4。 */
  const workers = opts.cap ? Math.max(1, Math.min(rawWorkers, opts.cap)) : rawWorkers
  const base =
    m.n < 2
      ? `动态探测:并发无收益(单份 ${' ' }→${m.speedup.toFixed(2)}×),按静态启发式取 ${staticPick}`
      : `动态探测:最佳档 ${m.n} worker,实测加速比 ${m.speedup.toFixed(2)}×(每 worker ${perWorker.toFixed(2)} 份)`
  const reason =
    workers < rawWorkers ? `${base};已按设置上限收到 ${workers}` : base

  try {
    const p = probeCachePath()
    /* ★ 缓存写【探测原始值】rawWorkers,不写被 cap 削过的 workers ——
     *   否则用户把上限从 4 调回 8 后,缓存里只剩 4,得重测才发现能用 8。 */
    writeFileSync(p, JSON.stringify({ t: Date.now(), n: rawWorkers, s: m.speedup, logical: info.logical }))
  } catch { /* 缓存写失败不影响主流程 */ }

  return { info, workers, measuredSpeedup: m.speedup, reason }
}

/** 静态启发式(动态探测失败时的兜底)。
 *  ★ 上限按"物理核的 2/3"取 —— 超线程的第二条硬件线程只能拿到 60~70% 边际收益,
 *    按逻辑核开 worker 会白付调度与内存成本。available 是硬上限(容器配额)。 */
export function staticHeuristic(info: CpuInfo): number {
  // 内存是另一个硬约束:每个解析 worker 峰值约 300~600MB(扫 3 万文件 + 建 20 万 Map)
  const memG = info.memBytes / 1073741824
  const byMem = memG >= 16 ? 6 : memG >= 12 ? 5 : memG >= 8 ? 4 : memG >= 4 ? 2 : 1
  const byCpu = Math.max(1, Math.floor((info.logical * 2) / 3))
  const cap = Math.max(1, info.available)
  return Math.max(1, Math.min(byCpu, byMem, cap, 8))
}
