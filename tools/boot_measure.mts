/**
 * boot_measure.mts —— 端到端实测:起真 server,量启动总时长 + 构建期 HTTP 尖峰
 *
 * ★ 测 HTTP 延迟必须【单进程内循环 fetch】:每请求起一次 curl 有约 570ms
 *   的进程启动开销,会把数字彻底带偏(曾据此误判音频端点固定 750ms)。
 *
 * 判据:①/api/status 从 busy 变 ready 的墙钟 ②构建期间 /api/status 的最大延迟
 */
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 17811
const BASE = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'packages', 'gui', 'src', 'server.ts'), '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, HOI4TK_ROOT: ROOT },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => { log += d.toString() })
child.stderr.on('data', (d) => { log += d.toString() })

const t0 = Date.now()
/* ── 阶段一:等 server.listen(连接失败不算延迟样本,那只是"还没起来") ── */
const upDeadline = Date.now() + 60000
let up = false
while (Date.now() < upDeadline) {
  try {
    const r = await fetch(`${BASE}/api/status`)
    if (r.status === 200) { await r.json(); up = true; break }
  } catch { /* 还没 listen */ }
  await new Promise((r) => setTimeout(r, 100))
}
if (!up) { console.log(log); console.log('!! server 60s 内没起来'); child.kill(); process.exit(1) }
console.log(`server 已 listen @ ${Date.now() - t0} ms\n`)

/* ── 阶段二:构建期连续探活(单进程内循环,不另起进程) ── */
const samples = []
let ready = false
let readyMs = 0
const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  const s0 = Date.now()
  try {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 10000)
    const r = await fetch(`${BASE}/api/status`, { signal: ac.signal })
    clearTimeout(to)
    const j = await r.json()
    const ms = Date.now() - s0
    if (r.status === 200) {
      /* ⚠ /api/status 返回的是【扁平】对象(building/phase/done/total 直接在顶层),
       *   不是 {build:{...}} 包装 —— 读错层级会让 building 永远 undefined,
       *   于是第一发采样就判定"已就绪"直接跳出,只剩 1 个样本(测了个寂寞)。 */
      samples.push({ t: Date.now() - t0, ms, building: !!j.building, phase: j.phase ?? '(并行中)', done: j.done, total: j.total })
      if (j.building === false) { ready = true; readyMs = Date.now() - t0; break }
    }
  } catch {
    samples.push({ t: Date.now() - t0, ms: Date.now() - s0, building: true, phase: '(超时/断连)', done: 0, total: 0 })
  }
  await new Promise((r) => setTimeout(r, 100))
}

console.log(log)
console.log('\n=== 构建期 /api/status 采样 ===')
console.log('  样本数', samples.length, ' ready 墙钟', readyMs, 'ms')
const oks = samples.filter((s) => s.phase !== '(连接失败)')
if (oks.length) {
  const lat = oks.map((s) => s.ms).sort((a, b) => a - b)
  const byPhase = new Map()
  for (const s of oks) byPhase.set(s.phase, Math.max(byPhase.get(s.phase) ?? 0, s.ms))
  console.log('  延迟 中位', lat[Math.floor(lat.length / 2)], 'ms  p95', lat[Math.floor(lat.length * 0.95)], 'ms  最大', lat[lat.length - 1], 'ms')
  console.log('  超 500ms 的采样数', lat.filter((x) => x > 500).length, '/', lat.length)
  console.log('\n=== 各 phase 最大延迟 ===')
for (const [p, m] of [...byPhase].sort((a, b) => b[1] - a[1])) console.log(`    ${String(m).padStart(6)}ms  ${p}`)
/* 打印最慢的 8 个采样点 —— 只看汇总看不出尖峰发生在构建的哪个阶段 */
  console.log('\n=== 最慢 8 次采样 ===')
  for (const s of [...oks].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    console.log(`    t=${String(s.t).padStart(6)}ms  延迟 ${String(s.ms).padStart(5)}ms  进度 ${s.done}/${s.total}  ${s.phase}`)
  }
}
console.log('\n=== 各构建任务耗时(取自日志) ===')
for (const m of log.matchAll(/^\s+(?:开始构建(?:\(并行\))?: )?(.+?)[:：]?.{0,10}?(\d+) ?ms/gm)) {
  const line = m[0].trim()
  if (/就绪|完成|失败/.test(line)) console.log('  ' + line)
}
child.kill()
process.exit(0)