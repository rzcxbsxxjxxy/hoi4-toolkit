/** 定向复现守卫失败:对单个文件做随机多改动,抓出首个失败组合 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpriteIndex } from '../src/sprites.ts'
import { buildLayout } from '../src/model.ts'
import { applyEdits, makeDiff } from '../src/edit.ts'

const V = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const sprites = new SpriteIndex(V)
sprites.scan([join(V, 'interface')])

const rel = 'interface/' + (process.argv[2] ?? 'ai_trace.gui')
const trials = parseInt(process.argv[3] ?? '400', 10)
const src = readFileSync(join(V, rel), 'utf8')
const lay0 = buildLayout(src, rel, sprites)
console.log(`════ ${rel}  元素 ${lay0.stats.elements}  行 ${src.split('\n').length} ════`)

let rng = 987654321
const rand = (n: number) => {
  rng = (rng * 1103515245 + 12345) & 0x7fffffff
  return rng % n
}

let found = 0
for (let t = 0; t < trials && found < 2; t++) {
  const lay = buildLayout(src, rel, sprites)
  const k = 2 + rand(4)
  const edits: Record<string, number>[] = []
  for (let i = 0; i < k; i++) {
    const n = lay.flat[rand(lay.flat.length)]
    const e: Record<string, number> = { id: n.id }
    if (rand(4) !== 0) { e.x = rand(200); e.y = rand(200) }
    if (rand(3) === 0) { e.w = 20 + rand(150); e.h = 20 + rand(90) }
    if (e.x === undefined && e.w === undefined) e.x = rand(200)
    edits.push(e)
  }
  const out = applyEdits(lay, edits as never)
  if (out.guard.ok) continue
  found++
  console.log(`\n── 第 ${t} 次试验失败 ──`)
  console.log(`  守卫: ${out.guard.message}`)
  console.log(`  提交 ${edits.length} 处:`)
  for (const e of edits) console.log('    ' + JSON.stringify(e))
  console.log('  实际写入:')
  for (const d of out.details) console.log(`    ${d.id}  ${d.field}(${d.mode})  ${d.from} → ${d.to}   行 ${d.line}`)
  console.log('  diff:')
  for (const line of makeDiff(src, out.text).split('\n')) console.log('    ' + line)
}
if (!found) console.log(`  ${trials} 次随机组合:守卫全部通过`)
