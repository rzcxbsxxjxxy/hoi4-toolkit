/**
 * job-builders.ts —— 8 个图任务的构建函数（worker 侧与主线程降级侧共用）
 *
 * ★ 为什么必须是同一份:验收脚本要"串行结果 vs worker 结果"逐字段比对指纹。
 *   如果两侧各写一份构建逻辑,一旦某侧漏传字段,指纹天然不等 →
 *   被误读成"并行结果不一致"(实测在 8 个任务里假报警了 6 个)。
 *   共用同一份函数后,指纹不等就一定是真不一致。
 *
 * ★ 为什么放在 packages/ 而不是 tools/:它同时被 worker-pool 的降级路径
 *   用来在主线程执行 —— 是生产代码的一部分,不是 QA 设施。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { JobKind, JobRequest } from './worker-pool.ts'

export type GraphBuilder = (req: JobRequest) => Promise<Record<string, unknown>>

/** 递归收集 .lua(buildDefinesModel 注入用) */
function walkLua(dir: string): string[] {
  const out: string[] = []
  let items: string[] = []
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of items) {
    const p = join(dir, name)
    let st: { isDirectory(): boolean; isFile(): boolean }
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walkLua(p))
    else if (st.isFile() && /\.lua$/i.test(name)) out.push(p)
  }
  return out
}

export async function buildGraph(req: JobRequest): Promise<Record<string, unknown>> {
  switch (req.kind) {
    case 'focus': {
      /* ★ 国策图(2026-10-17 接入并行):焦点树的构建是冷启动次大块,原来跑在
       * server 主线程 —— 而音乐播放正走 /api/music/audio 从本后端 HTTP 取流,
       * 主线程一被占住音频请求就排不上队 → 缓冲断流 → 「加载国策树时音乐卡住」。
       * 挪进 worker 后主线程全程可响应 HTTP。 */
      const { buildFocusGraph } = await import('../../focus/src/model.ts')
      return buildFocusGraph(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'events': {
      const { buildEventIndex } = await import('../../engine/src/events.ts')
      return buildEventIndex(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'tech': {
      const { buildTechGraph } = await import('../../engine/src/tech.ts')
      return buildTechGraph(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'decisions': {
      const { buildDecisionGraph } = await import('../../engine/src/decisions.ts')
      return buildDecisionGraph(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'aibehave': {
      const { buildAiBehavior } = await import('../../engine/src/aibehave.ts')
      return buildAiBehavior(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'defines': {
      const { buildDefinesModel } = await import('../../engine/src/defines.ts')
      return buildDefinesModel(
        req.roots as never,
        (p: string) => readFileSync(p, 'utf8'),
        (d: string) => walkLua(d),
      ) as unknown as Record<string, unknown>
    }
    case 'dlc': {
      const { buildDlcModel } = await import('../../engine/src/dlc.ts')
      return buildDlcModel(req.roots as never, req.gameDir ?? req.roots[0]?.path ?? '') as unknown as Record<string, unknown>
    }
    case 'mio': {
      const { buildMioTrees } = await import('../../engine/src/mio.ts')
      return buildMioTrees(req.roots as never) as unknown as Record<string, unknown>
    }
    case 'music': {
      const { buildMusicIndex } = await import('../../engine/src/music.ts')
      return buildMusicIndex(req.roots as never) as unknown as Record<string, unknown>
    }
    /* ── PARALLEL_V2(2026-10-17)新增的三个:学说 / 引用图 / 本地化 ──
     * 这三个原来没有 job-builder(所以「都搬进 worker」时它们全在主线程跑)。
     * 关键点:worker 里没有 HTTP 要让,凡是为了「不阻塞主线程」而写的
     * 分片/异步路径在这里都是纯浪费 —— 主线程仍走异步版,worker 走同步版。 */
    case 'doctrines': {
      /* 学说:build + layout 一起做。layoutDoctrines 是纯计算(排布),
       * 放在 worker 里做等于把排布那部分 CPU 也带走;主线程只收结果。 */
      const { buildDoctrineGraph, layoutDoctrines } = await import('../../engine/src/doctrines.ts')
      const g = buildDoctrineGraph(req.roots as never)
      return { g, layout: layoutDoctrines(g) } as unknown as Record<string, unknown>
    }
    case 'links': {
      /* 引用图:⚠ sprites 必须传 false。
       *   server 侧两处调用(ensureLinks / ensureSymbols)都显式 {sprites:false},
       *   因为贴图索引由 spriteIdx 单独维护,引用图再建一份纯属双倍开销。
       *   选项不跟着 JobRequest 传 —— 它是「引用图自己的实现细节」,
       *   让 server 能改出不一致的结果。 */
      const { buildLinkGraph } = await import('../../engine/src/links.ts')
      return buildLinkGraph(req.roots as never, { sprites: false }) as unknown as Record<string, unknown>
    }
    case 'loc': {
      /* ★★ PARALLEL_V2:loc 是【流式】任务(见 worker-pool 的 runLocStream)。
       *   这里保留"一次性建完整索引"的实现,用途有二:
       *     ① 验收脚本要拿它与流式结果逐字段比对指纹(共用同一份才说明一致)
       *     ② worker 流式通道不可用时的降级兜底
       *   生产路径不走这里 —— 实测裸对象载荷 381MB / 595 万节点,
       *   一次 postMessage 回来的 deserialize 要 2671ms,主线程会被连续堵 2.7 秒,
       *   比现状的分片(单片 180ms)更糟。所以生产走 runLocStream 逐批合并。 */
      const { buildLocIndex } = await import('./locsrv.ts')
      return buildLocIndex(req.roots as never, {
        wantLangs: new Set(req.wantLangs ?? ['l_english', 'l_simp_chinese']),
      }) as unknown as Record<string, unknown>
    }
    default:
      throw new Error('未知任务类型 ' + String(req.kind as JobKind))
  }
}