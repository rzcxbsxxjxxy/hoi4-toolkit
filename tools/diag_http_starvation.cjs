/* 诊断:后端重构建期间 HTTP 是否被"饿死"(2026-10-10)
 *
 * 假设:符号库/引用图等构建是同步大循环(实测符号库 70s),Node 单线程
 *   期间无法响应任何 HTTP → 用户点导航后,新页面的 API 请求排队几十秒
 *   → 表现就是"点击后一段时间无法启动,过一会儿才正常"。
 * 方法:全程每 500ms 打一次 /api/status,记录响应时间与 building 状态,
 *   找出最长的一段"无响应/超慢"窗口。
 */
const http = require('http')
const PORT = Number(process.argv[2] || 5199)
const DURATION = Number(process.argv[3] || 180) // 秒

function probe(timeoutMs) {
  return new Promise((res) => {
    const t0 = Date.now()
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status' }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        let j = {}
        try { j = JSON.parse(d) } catch (e) {}
        res({ ms: Date.now() - t0, code: r.statusCode, building: j.building, phase: j.phase, ready: j.ready })
      })
    })
    req.on('error', (e) => res({ ms: Date.now() - t0, code: 0, err: e.message }))
    req.setTimeout(timeoutMs, () => { req.destroy(); res({ ms: Date.now() - t0, code: -1, timeout: true }) })
  })
}

;(async () => {
  console.log('探测后端响应延迟,共 ' + DURATION + 's ...')
  const t0 = Date.now()
  let slow = []
  let n = 0
  let maxMs = 0
  let maxAt = ''
  while ((Date.now() - t0) / 1000 < DURATION) {
    const r = await probe(5000)
    n++
    if (r.ms > maxMs) { maxMs = r.ms; maxAt = r.phase || (r.ready ? '(ready)' : '(building)') }
    // 超过 1.5s 视为"明显卡顿"(正常 <50ms)
    if (r.ms > 1500) {
      slow.push({ t: ((Date.now() - t0) / 1000).toFixed(1) + 's', ms: r.ms, phase: r.phase || (r.ready ? '(ready)' : '(building)') })
    }
    await new Promise((r2) => setTimeout(r2, 500))
  }
  console.log('\n探测次数', n, ' 最长响应', maxMs + 'ms', '@', maxAt)
  console.log('\n超过 1.5s 的响应(共 ' + slow.length + ' 次):')
  for (const s of slow.slice(0, 40)) console.log('  t=' + s.t, s.ms + 'ms', s.phase)
  if (slow.length > 40) console.log('  ... 另 ' + (slow.length - 40) + ' 次')
  // 汇总:连续卡顿窗口
  if (slow.length) {
    const first = slow[0], last = slow[slow.length - 1]
    console.log('\n★ 卡顿窗口:', first.t, '→', last.t, '(共 ' + slow.length + ' 次采样)')
  }
  process.exit(0)
})()
