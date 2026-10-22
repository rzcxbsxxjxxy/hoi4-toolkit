import { buildBaseline, checkUpdate, getHistoryEntry, listHistorySummary, getDiff } from './packages/engine/src/tracker.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TDIR = mkdtempSync('D:/tmp/track-')
const SRC = mkdtempSync('D:/tmp/src-')
mkdirSync(join(SRC, 'common'), { recursive: true })
const root = { path: SRC, name: 'test', writable: true }
writeFileSync(join(SRC, 'common', 'a.txt'), 'line1\nline2\nline3\n')

const noop = () => {}
const b = await buildBaseline(TDIR, root, noop, false)
console.log('baseline ok files=', b.files)

writeFileSync(join(SRC, 'common', 'a.txt'), 'line1\nline2-CHANGED\nline3\nline4\n')
const c = await checkUpdate(TDIR, root, noop, false)
console.log('check ok report?', !!c.report, 'total=', c.report?.stats?.total)

const key = readdirSync(join(TDIR,'tracker','history'))[0]
console.log('root key=', key)
const sum = listHistorySummary(TDIR, key)
console.log('summary len=', sum.length, 'fileName=', sum[0]?.fileName)
const ts = sum[0]?.fileName
const entry = getHistoryEntry(TDIR, key, ts)
console.log('entry changes=', entry?.changes?.length)
try {
  const s = JSON.stringify({ ready: true, entry })
  console.log('historyEntry JSON.stringify OK len=', s.length)
} catch (e) { console.log('historyEntry JSON.stringify THREW:', (e as Error).message) }
for (const ch of entry?.changes || []) {
  try {
    const d = await getDiff(TDIR, key, ch.rel, ch.kind, ts, 0)
    const s = JSON.stringify({ ready: true, diff: d })
    console.log('diff OK', ch.kind, ch.rel, 'len=', s.length)
  } catch (e) { console.log('diff THREW for', ch.rel, ch.kind, ':', (e as Error).message) }
}
rmSync(TDIR, { recursive: true, force: true })
rmSync(SRC, { recursive: true, force: true })
