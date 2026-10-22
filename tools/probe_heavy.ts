/**
 * probe_heavy.ts —— 实测 6 个待搬迁重活的【构建耗时】与【postMessage 回传体积/耗时】
 *
 * 判据(来自 worker-pool.ts 头注):是否值得上并行不由"任务耗时"决定,
 * 而由 **克隆耗时 / 构建耗时** 决定。回传比构建还贵就别搬。
 *
 * 用法:node --experimental-strip-types tools/probe_heavy.ts
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUI_SRC = resolve(HERE, '..', 'packages', 'gui', 'src')

function roots(): { name: string; path: string; writable?: boolean }[] {
  const s = JSON.parse(readFileSync(resolve(GUI_SRC, '..', '..', '..', 'gui-settings.json'), 'utf8'))
  const out: { name: string; path: string; writable?: boolean }[] = []
  if (s.base) out.push({ name: 'vanilla', path: s.base, writable: false })
  for (const m of s.mods ?? []) if (m.enabled) out.push({ name: m.path.split(/[\\/]/).pop(), path: m.path, writable: true })
  return out
}

/** 深度估算 postMessage 载荷体积(遍历所有可克隆节点) */
function deepSize(v: unknown, seen = new Set<object>()): { bytes: number; nodes: number } {
  if (v === null || v === undefined) return { bytes: 1, nodes: 1 }
  const t = typeof v
  if (t === 'number' || t === 'boolean') return { bytes: 8, nodes: 1 }
  if (t === 'string') return { bytes: 2 * (v as string).length + 8, nodes: 1 }
  if (t !== 'object') return { bytes: 8, nodes: 1 }
  const o = v as object
  if (seen.has(o)) return { bytes: 8, nodes: 1 }
  seen.add(o)
  if (o instanceof Map) {
    let b = 32; let n = 1
    for (const [k, x] of o) { const a = deepSize(k, seen); const c = deepSize(x, seen); b += a.bytes + c.bytes; n += a.nodes + c.nodes }
    return { bytes: b, nodes: n }
  }
  if (o instanceof Set) {
    let b = 32; let n = 1
    for (const x of o) { const c = deepSize(x, seen); b += c.bytes; n += c.nodes }
    return { bytes: b, nodes: n }
  }
  if (Array.isArray(o)) {
    let b = 24; let n = 1
    for (const x of o) { const c = deepSize(x, seen); b += c.bytes; n += c.nodes }
    return { bytes: b, nodes: n }
  }
  let b = 24; let n = 1
  for (const k of Object.keys(o)) { const c = deepSize((o as Record<string, unknown>)[k], seen); b += 2 * k.length + 8 + c.bytes; n += c.nodes }
  return { bytes: b, nodes: n }
}

const KINDS = ['tech', 'decisions', 'doctrines', 'aibehave', 'links', 'loc'] as const

const ENTRY = join(GUI_SRC, 'worker-entry.ts')
const rs = roots()
console.log('来源:', rs.map((r) => r.name).join(' / '))
console.log('')

const rows: { kind: string; build: number; clone: number; mb: number; nodes: number; where: string }[] = []

/** 真正跑一次 postMessage 往返,量克隆(deserialize)耗时 */
for (const kind of KINDS) {
  const w = new Worker(ENTRY, { execArgv: ['--experimental-strip-types'] })
  const t0 = Date.now()
  const r = (await new Promise<Record<string, unknown>>((done, fail) => {
    w.on('message', (m: Record<string, unknown>) => done(m))
    w.on('error', fail)
    w.postMessage({ kind, roots: rs })
  })) as { ok: boolean; ms?: number; error?: string; data?: Record<string, unknown> }
  const total = Date.now() - t0
  if (!r.ok) { console.log(`${kind}: 失败 ${String(r.error).slice(0, 300)}`); await w.terminate(); continue }
  const sz = deepSize(r.data)
  // 反复 deserialize 3 次取最小,排除首次 JIT 预热
  let clone = Number.MAX_SAFE_INTEGER
  for (let i = 0; i < 3; i++) {
    const c0 = Date.now()
    structuredClone(r.data)
    clone = Math.min(clone, Date.now() - c0)
  }
  rows.push({ kind, build: r.ms ?? 0, clone, mb: sz.bytes / 1048576, nodes: sz.nodes, where: 'worker' })
  console.log(`${kind.padEnd(11)} build ${String(r.ms).padStart(6)}ms  clone ${String(clone).padStart(5)}ms  载荷 ${(sz.bytes / 1048576).toFixed(1)}MB / ${sz.nodes} 节点  往返总计 ${total}ms`)
  await w.terminate()
}

// 串行基线(主线程逐个建)
console.log('\n--- 主线程串行基线 ---')
{
  const { buildGraph } = await import('../packages/gui/src/job-builders.ts')
  for (const kind of KINDS) {
    const t = Date.now()
    const data = await buildGraph({ kind, roots: rs } as never)
    console.log(`${kind.padEnd(11)} main ${String(Date.now() - t).padStart(6)}ms  载荷 ${(deepSize(data).bytes / 1048576).toFixed(1)}MB`)
  }
}

// 并行墙钟:全部 8 worker 同时
console.log('\n--- 全部同时投进 8 worker(墙钟) ---')
{
  const ws: Worker[] = []
  const t0 = Date.now()
  const done = KINDS.map((kind) => new Promise<void>((res) => {
    const w = new Worker(ENTRY, { execArgv: ['--experimental-strip-types'] })
    ws.push(w)
    w.on('message', () => res())
    w.on('error', () => res())
    w.postMessage({ kind, roots: rs })
  }))
  await Promise.all(done)
  console.log(`6 个并行墙钟: ${Date.now() - t0} ms`)
  for (const w of ws) await w.terminate()
}