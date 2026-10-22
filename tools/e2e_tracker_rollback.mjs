// E2E-2: 验证删除「最新检查点」后基线回滚 + 立即检查重新报出差异
import { fork } from 'node:child_process'
const child = fork('./child.cjs', [], {
  serialization: 'advanced',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, HOI4TK_ROOT: process.cwd(), HOI4TK_DATA: 'C:\\Users\\123\\AppData\\Local\\Temp\\hoi4tk-repro', HOI4_NO_REG: '1' },
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ready timeout')), 120000); child.on('message', (m) => { if (m && m.type === 'ready') { clearTimeout(t); res() } }) })
console.log('== child ready ==')
let reqId = 0
function ask(method, url) {
  return new Promise((res) => {
    const id = ++reqId
    const on = (m) => { if (m && m.id === id) { child.off('message', on); res(m) } }
    child.on('message', on)
    child.send({ id, req: { method, url, headers: {}, body: null } })
  })
}
const status = async () => JSON.parse((await ask('GET', '/api/tracker/status')).body.toString()).roots.find((r) => r.key === 'f1893e9f05e7e5a8')
const history = async () => JSON.parse((await ask('GET', '/api/tracker/history?root=f1893e9f05e7e5a8')).body.toString()).history
// 逐个删除直到只剩最初的 724 变更记录(1792505573320.json),使其成为「最新」
for (;;) {
  const h = await history()
  if (h.length <= 1 || h[0].fileName === '1792505573320.json') {
    if (h[0].fileName === '1792505573320.json') break
  }
  const target = h.find((e) => e.fileName !== '1792505573320.json')
  if (!target) break
  const r = await ask('POST', '/api/tracker/delhist?root=f1893e9f05e7e5a8&ts=' + encodeURIComponent(target.fileName))
  console.log('[del]', target.fileName, 'total=' + target.stats.total, '→', r.status)
}
const before = await status()
console.log('[before rollback] baselineFiles=' + before.baselineFiles + ' baselineAt=' + before.baselineAt)
// 现在删除 724 变更的检查点 → 应触发基线回滚到 22:12 检查之前
const rd = await ask('POST', '/api/tracker/delhist?root=f1893e9f05e7e5a8&ts=1792505573320.json')
console.log('[del 724-entry]', rd.status, rd.body.toString().slice(0, 60))
const after = await status()
console.log('[after rollback] baselineFiles=' + after.baselineFiles + ' baselineAt=' + after.baselineAt)
console.log('[rollback] baselineFiles ' + before.baselineFiles + ' → ' + after.baselineFiles + (after.baselineFiles !== before.baselineFiles ? '  ✅ 已回滚' : '  ⚠ 未变化'))
const t1 = Date.now()
const r5 = await ask('GET', '/api/tracker/check?root=f1893e9f05e7e5a8')
const frames = r5.body.toString('utf8').split('\n\n').filter((f) => f.startsWith('data:')).map((f) => { try { return JSON.parse(f.slice(5).trim()) } catch { return null } }).filter(Boolean)
const done = frames.find((m) => m.done)
const st = done && done.report ? done.report.stats : null
console.log('[recheck] status=' + r5.status + ' in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's → total=' + (st ? st.total : 'NO-DONE') + ' byKind=' + (st ? JSON.stringify(st.byKind) : '-'))
child.kill(); process.exit(0)
