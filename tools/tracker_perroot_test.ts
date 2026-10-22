/**
 * 一次性验证脚本：确认 TRACKER_V2「按来源(root)独立」逻辑 + 大文件 pack 存储 + 历史索引。
 * 构造 A、B 两个临时来源目录，各自建基线、改文件后检查更新，
 * 断言：A/B 的基线/历史互不影响、clearRoot(A) 不波及其它来源、pack 取代零碎 blob、历史走索引。
 * 运行：node --experimental-strip-types tools/tracker_perroot_test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBaseline, checkUpdate, trackerStatus, listHistory, listHistorySummary, clearRoot, rootKey,
  type TrackRoot,
} from '../packages/engine/src/tracker.ts'

const base = mkdtempSync(join(tmpdir(), 'trk-'))
console.log('temp base:', base)

function makeRoot(name: string): TrackRoot {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'hello ' + name + '\n')
  writeFileSync(join(dir, 'b.txt'), 'world ' + name + '\n')
  return { name, path: dir, writable: true }
}

const A = makeRoot('modA')
const B = makeRoot('modB')
const roots = [A, B]

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  ✓ ' + msg)
  } else {
    console.log('  ✗ FAIL: ' + msg)
    failures++
  }
}

async function main() {
  const keyA = rootKey(A.path)
  const keyB = rootKey(B.path)

  console.log('\n[1] 建基线 A、B 各自独立')
  const rA = await buildBaseline(base, A)
  const rB = await buildBaseline(base, B)
  assert(rA.ok && rA.files === 2, 'A 基线建好，文件数=2 (got ' + rA.files + ')')
  assert(rB.ok && rB.files === 2, 'B 基线建好，文件数=2 (got ' + rB.files + ')')
  assert(keyA !== keyB, 'A/B 的 key 不同 (' + keyA + ' vs ' + keyB + ')')
  assert(existsSync(join(base, 'tracker', 'baseline', keyA, 'baseline.json')), 'A 基线文件落在对的目录')
  assert(existsSync(join(base, 'tracker', 'baseline', keyB, 'baseline.json')), 'B 基线文件落在对的目录')

  console.log('\n[2] pack 存储：每来源一个 content.pack + content.idx，旧版 blobs/ 已迁移清除')
  const blobsDir = join(base, 'tracker', 'blobs')
  assert(!existsSync(blobsDir), '旧版共享 blobs/ 目录已不存在（已被 pack 取代）')
  assert(existsSync(join(base, 'tracker', 'baseline', keyA, 'content.pack')), 'A 的 content.pack 存在（大文件，取代零碎 blob）')
  assert(existsSync(join(base, 'tracker', 'baseline', keyA, 'content.idx')), 'A 的 content.idx 索引存在')
  assert(existsSync(join(base, 'tracker', 'baseline', keyB, 'content.pack')), 'B 的 content.pack 存在（与 A 相互独立）')
  const szA = statSync(join(base, 'tracker', 'baseline', keyA, 'content.pack')).size
  assert(szA > 0, 'A 的 content.pack 非空（含文本压缩内容，大小=' + szA + 'B）')

  console.log('\n[3] 改 A 的文件，只检查 A')
  writeFileSync(join(A.path, 'a.txt'), 'hello MODIFIED-A\n')
  writeFileSync(join(A.path, 'c.txt'), 'new file in A\n')
  const updA = await checkUpdate(base, A)
  assert(updA.ok, 'A 检查更新成功')
  assert(!!updA.report && updA.report.changes.length === 2, 'A 检测到 2 处变更 (modified a.txt + new c.txt)，实际=' + (updA.report?.changes.length))
  const histB = listHistory(base, keyB)
  assert(histB.length === 0, 'B 仍无历史记录（A 的检查不影响 B）')

  console.log('\n[4] 历史索引：history/index.json 使得列表读取走摘要（不解析每个历史 JSON）')
  const histDirA = join(base, 'tracker', 'history', keyA)
  assert(existsSync(join(histDirA, 'index.json')), 'A 的历史轻量索引 index.json 已建立（位于 tracker/history/<key>/）')
  const idxA = JSON.parse(readFileSync(join(histDirA, 'index.json'), 'utf8'))
  assert(idxA.entries && idxA.entries.length === 1, 'A 索引含 1 条检查记录')
  const sumA = listHistorySummary(base, keyA)
  assert(sumA.length === 1 && sumA[0].fileName && sumA[0].stats, 'listHistorySummary 返回摘要（fileName/stats），无需全量解析')

  console.log('\n[5] status 两个来源各有基线')
  const st = trackerStatus(base, roots)
  assert(st.length === 2, '返回 2 条来源状态')
  const sA = st.find((s) => s.key === keyA)!
  const sB = st.find((s) => s.key === keyB)!
  assert(sA.hasBaseline && sA.lastCheckTotal === 2, 'A 有基线且最近一次检查=2 变更')
  assert(sB.hasBaseline && sB.lastCheckTotal === 0, 'B 有基线但从未检查（lastCheckTotal=0）')

  console.log('\n[6] 再查 B（不改任何文件）→ 干净，且不影响 A 历史')
  const updB = await checkUpdate(base, B)
  assert(updB.ok && (updB.report?.changes.length ?? -1) === 0, 'B 检查=0 变更（干净）')
  const histA = listHistory(base, keyA)
  assert(histA.length === 1, 'A 历史仍为 1 条（B 的检查没给 A 加记录）')

  console.log('\n[7] clearRoot(A) 只清 A')
  clearRoot(base, A.path)
  assert(!existsSync(join(base, 'tracker', 'baseline', keyA)), 'A 基线已删')
  assert(existsSync(join(base, 'tracker', 'baseline', keyB)), 'B 基线仍在')
  const st2 = trackerStatus(base, roots)
  const sA2 = st2.find((s) => s.key === keyA)!
  const sB2 = st2.find((s) => s.key === keyB)!
  assert(!sA2.hasBaseline, 'A status 回到无基线')
  assert(sB2.hasBaseline, 'B status 仍有基线')

  rmSync(base, { recursive: true, force: true })
  console.log('\n==== 结果: ' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗') + ' ====')
  process.exit(failures === 0 ? 0 : 1)
}

main()
