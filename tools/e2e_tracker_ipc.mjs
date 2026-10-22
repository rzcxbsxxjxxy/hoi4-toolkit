// E2E: 复刻打包态 app:// 链路(fork child.cjs + serialization advanced)验证两处修复
import { fork } from 'node:child_process'
const child = fork('./child.cjs', [], {
  serialization: 'advanced',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, HOI4TK_ROOT: process.cwd(), HOI4TK_DATA: 'C:\\Users\\123\\AppData\\Local\\Temp\\hoi4tk-repro', HOI4_NO_REG: '1' },
})
child.stdout.on('data', (d) => process.stdout.write('[child] ' + d))
child.stderr.on('data', (d) => process.stdout.write('[child-err] ' + d))
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
// ── T1: 166MB 历史记录的 historyEntry(修复前: IPC 序列化把子进程撑爆 → 500 纯文本)
const t0 = Date.now()
const r1 = await ask('GET', '/api/tracker/historyEntry?root=f1893e9f05e7e5a8&ts=1792505573320.json')
const mb = r1.body ? r1.body.length / 1048576 : -1
console.log('[T1] historyEntry status=' + r1.status + ' body=' + mb.toFixed(2) + 'MB in ' + (Date.now() - t0) + 'ms')
const j1 = JSON.parse(r1.body.toString('utf8'))
console.log('[T1] changes=' + j1.entry.changes.length + ' embeddedDiffRows=' + j1.entry.changes.reduce((n, c) => n + (c.diff ? c.diff.length : 0), 0))
// ── T2: 删除最新检查点 → 基线回滚 → 立即检查重新报出差异
const rh = await ask('GET', '/api/tracker/history?root=f1893e9f05e7e5a8')
const jh = JSON.parse(rh.body.toString('utf8'))
const latest = jh.history[0]
console.log('[T2] history count=' + jh.history.length + ' latest=' + latest.fileName + ' total=' + latest.stats.total)
const before = JSON.parse((await ask('GET', '/api/tracker/status')).body.toString()).roots.find((r) => r.key === 'f1893e9f05e7e5a8')
console.log('[T2] before rollback: baselineFiles=' + before.baselineFiles + ' baselineAt=' + before.baselineAt)
const rd = await ask('POST', '/api/tracker/delhist?root=f1893e9f05e7e5a8&ts=' + encodeURIComponent(latest.fileName))
console.log('[T2] delhist status=' + rd.status + ' body=' + rd.body.toString().slice(0, 80))
const after = JSON.parse((await ask('GET', '/api/tracker/status')).body.toString()).roots.find((r) => r.key === 'f1893e9f05e7e5a8')
console.log('[T2] after rollback: baselineFiles=' + after.baselineFiles + ' baselineAt=' + after.baselineAt)
const t1 = Date.now()
const r5 = await ask('GET', '/api/tracker/check?root=f1893e9f05e7e5a8')
const frames = r5.body.toString('utf8').split('\n\n').filter((f) => f.startsWith('data:')).map((f) => { try { return JSON.parse(f.slice(5).trim()) } catch { return null } }).filter(Boolean)
const done = frames.find((m) => m.done)
console.log('[T2] recheck status=' + r5.status + ' in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's → stats.total=' + (done && done.report ? done.report.stats.total : 'NO-DONE'))
// ── T3: 新写的检查记录应受 12MB diff 预算约束
const rh2 = JSON.parse((await ask('GET', '/api/tracker/history?root=f1893e9f05e7e5a8')).body.toString())
const newest = rh2.history[0]
const r3 = await ask('GET', '/api/tracker/historyEntry?root=f1893e9f05e7e5a8&ts=' + encodeURIComponent(newest.fileName))
console.log('[T3] new entry status=' + r3.status + ' body=' + (r3.body.length / 1048576).toFixed(2) + 'MB fileName=' + newest.fileName)
child.kill(); process.exit(0)
