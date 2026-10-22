/* probe_clone.ts —— 判定图对象能否直接结构化克隆(2026-10-10)
 *
 * 背景:worker-pool 用 serializeDeep 把 Map 拆成 {__m:[...]} 再传,回传 57.9 MB。
 * 但 structuredClone **原生支持 Map/Set**,如果引擎产物是纯数据(无 DOM 引用),
 * 就可以直接 postMessage,既省掉序列化/反序列化两层递归,也省掉包装开销。
 *
 * 本探针给出三条硬数据:
 *   ① 直接 structuredClone 是否抛错(有 DOM 引用/函数就会抛 DataCloneError)
 *   ② 三种形态各自的真实传输字节数(用 postMessage 实测,不是 JSON.stringify)
 *   ③ 三种形态各自的往返墙钟
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const SELF = fileURLToPath(import.meta.url)

/** 引擎侧产物是否含不可克隆值(DOM / 函数 / 代理) */
function findUnclonable(v: unknown, path = '$', depth = 0, hits: string[] = []): string[] {
  if (depth > 10 || hits.length > 8) return hits
  if (typeof v === 'function') { hits.push(path + ' [function]'); return hits }
  if (v instanceof Map) {
    let i = 0
    for (const [k, x] of v) {
      findUnclonable(k, `${path}.<key ${i}>`, depth + 1, hits)
      findUnclonable(x, `${path}.get(${JSON.stringify(String(k)).slice(0, 40)})`, depth + 1, hits)
      if (++i >= 400) break // 只抽查前 400 项,够了
    }
    return hits
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < Math.min(v.length, 200); i++) findUnclonable(v[i], `${path}[${i}]`, depth + 1, hits)
    return hits
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) findUnclonable((v as Record<string, unknown>)[k], `${path}.${k}`, depth + 1, hits)
    return hits
  }
  return hits
}

/** serializeDeep:当前实现(Map → {__m:[...]} 包装) */
function sdWrap(v: unknown, d = 0): unknown {
  if (d > 12) return null
  if (v instanceof Map) return { __m: [...v.entries()].map(([k, x]) => [k, sdWrap(x, d + 1)]) }
  if (v instanceof Set) return { __s: [...v].map((x) => sdWrap(x, d + 1)) }
  if (Array.isArray(v)) return v.map((x) => sdWrap(x, d + 1))
  if (v && typeof v === 'object') {
    const s = v as Record<string, unknown>
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(s)) o[k] = sdWrap(s[k], d + 1)
    return o
  }
  return v
}

/** 结构化克隆的**真实**传输字节数:用 postMessage 往返量(main→worker→main) */
function realBytes(v: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(SELF, { execArgv: ['--experimental-strip-types'], workerData: { echo: true } })
    const t = Date.now()
    w.once('message', (n: number) => {
      void w.terminate()
      resolve(n)
    })
    w.once('error', reject)
    try {
      w.postMessage(v)
    } catch (e) {
      void w.terminate()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
    void t
  })
}

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

async function buildAll(roots: { name: string; path: string; writable?: boolean }[]): Promise<Record<string, unknown>> {
  const specs = roots.map((r) => ({ name: r.name, path: r.path, writable: r.writable }))
  const ev = await import('../packages/engine/src/events.ts')
  const te = await import('../packages/engine/src/tech.ts')
  const de = await import('../packages/engine/src/decisions.ts')
  const ai = await import('../packages/engine/src/aibehave.ts')
  const di = await import('../packages/engine/src/defines.ts')
  const dl = await import('../packages/engine/src/dlc.ts')
  const mi = await import('../packages/engine/src/mio.ts')
  const mu = await import('../packages/engine/src/music.ts')
  const { readdirSync, statSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const walk = (dir: string): string[] => {
    const out: string[] = []
    let items: string[] = []
    try { items = readdirSync(dir) } catch { return out }
    for (const n of items) {
      const p = j(dir, n)
      try {
        const st = statSync(p)
        if (st.isDirectory()) out.push(...walk(p))
        else if (st.isFile() && /\.lua$/i.test(n)) out.push(p)
      } catch { /* 跳过 */ }
    }
    return out
  }
  return {
    events: ev.buildEventIndex(specs as never),
    tech: te.buildTechGraph(specs as never),
    decisions: de.buildDecisionGraph(specs as never),
    aibehave: ai.buildAiBehavior(specs as never),
    defines: di.buildDefinesModel(specs as never, (p: string) => readFileSync(p, 'utf8'), walk),
    dlc: dl.buildDlcModel(specs as never, roots[0].path),
    mio: mi.buildMioTrees(specs as never),
    music: mu.buildMusicIndex(specs as never),
  }
}

async function main(): Promise<void> {
  const roots = [gameRoot()]
  console.log('=== 构建 8 个图(裸对象,未经任何序列化)===')
  const t0 = Date.now()
  const all = await buildAll(roots)
  console.log(`  构建合计 ${Date.now() - t0} ms\n`)

  console.log('任务        不可克隆值            直接structuredClone   序列化耗时  包装字节    原生字节')
  console.log('─'.repeat(96))

  let wrapTotal = 0
  let rawTotal = 0
  const fails: string[] = []

  for (const [kind, g] of Object.entries(all)) {
    const bad = findUnclonable(g)
    const badTxt = bad.length ? bad[0].slice(0, 22) : '无'

    let cloneOk = true
    try { structuredClone(g) } catch { cloneOk = false }
    if (!cloneOk) fails.push(kind)

    const tS = Date.now()
    const wrapped = sdWrap(g)
    const serMs = Date.now() - tS

    const wB = await realBytes(wrapped)
    const rB = cloneOk ? await realBytes(g) : -1
    wrapTotal += wB
    if (rB > 0) rawTotal += rB

    console.log(
      `${kind.padEnd(12)}${badTxt.padEnd(22)}${(cloneOk ? '✓ 可直接克隆' : '✗ 需包装').padEnd(21)}` +
        `${String(serMs).padStart(7)} ms  ${(wB / 1048576).toFixed(2).padStart(8)} MB  ${(rB / 1048576).toFixed(2).padStart(8)} MB`,
    )
  }
  console.log('─'.repeat(96))
  console.log(`包装形态合计 ${(wrapTotal / 1048576).toFixed(2)} MB   原生形态合计 ${(rawTotal / 1048576).toFixed(2)} MB`)
  if (rawTotal > 0) console.log(`→ 原生直接克隆省 ${(100 * (1 - rawTotal / wrapTotal)).toFixed(1)}% 传输量`)
  console.log(fails.length ? `\n✗ 不可直接克隆的任务: ${fails.join(', ')}` : '\n★ 8 个任务全部可直接结构化克隆')
}

/** 结构化克隆后的近似字节数(Map/Set 按条目估,数组按元素估)
 *  ★ 必须是**模块顶层**声明:写在 if/else 块里是块级作用域、不提升,
 *    worker 侧的消息回调会 ReferenceError(实测踩过,被 try/catch 吞成 -1)。 */
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

if (!isMainThread && (workerData as { echo?: boolean } | undefined)?.echo) {
  // echo 模式:收到消息 → 结构化克隆它(这才是真正的传输成本)→ 回报字节数
  parentPort!.on('message', (v: unknown) => {
    let n = 0
    try {
      const c = structuredClone(v)
      n = roughSize(c)
    } catch {
      n = -1
    }
    parentPort!.postMessage(n)
  })
} else {
  main().then(
    () => process.exit(0),
    (e) => { console.log('ERR', e instanceof Error ? e.stack : String(e)); process.exit(1) },
  )
}