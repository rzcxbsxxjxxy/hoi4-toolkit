/**
 * 修复效果量化:在同一批样本上比较"元素矩形完整落在父级内"的比例。
 *  旧模型:offX = relX(完全忽略 orientation/origo/centerposition)
 *  新模型:offX = 锚点*父宽 + x - 自身对齐点*绘制宽
 * 样本口径与之前的模型普查一致:元素写了 orientation、父级有显式尺寸、元素尺寸已知。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout } from '../packages/gui/src/model.ts'
import { SpriteIndex, walkFiles } from '../packages/gui/src/sprites.ts'

const VAN = process.argv[2] || 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const idx = new SpriteIndex(VAN)
idx.scan([join(VAN, 'interface')])

let n = 0, oldIn = 0, newIn = 0
const per = new Map<string, { n: number; o: number; v: number }>()

for (const f of walkFiles(join(VAN, 'interface'), ['.gui'])) {
  let src: string
  try { src = readFileSync(f, 'utf8') } catch { continue }
  let l
  try { l = buildLayout(src, f, idx) } catch { continue }
  for (const nd of l.flat) {
    const ori = nd.orientation
    if (!ori) continue
    const p = nd.parentId ? l.byId.get(nd.parentId) : null
    // 根级元素父级 = 屏幕
    const pw = p ? p.w : 1920
    const ph = p ? p.h : 1080
    const parentKnown = p ? p.w > 0 && p.h > 0 && !p.sizeAuto && !p.sizeInferred : true
    if (!parentKnown || pw <= 0 || ph <= 0) continue
    if (nd.drawW <= 0 || nd.drawH <= 0) continue
    n++
    const okNew = nd.offX >= -1 && nd.offX + nd.drawW <= pw + 1 && nd.offY >= -1 && nd.offY + nd.drawH <= ph + 1
    const okOld = nd.relX >= -1 && nd.relX + nd.drawW <= pw + 1 && nd.relY >= -1 && nd.relY + nd.drawH <= ph + 1
    if (okNew) newIn++
    if (okOld) oldIn++
    const key = ori.toLowerCase()
    const s = per.get(key) || { n: 0, o: 0, v: 0 }
    s.n++; if (okOld) s.o++; if (okNew) s.v++
    per.set(key, s)
  }
}
console.log('样本(写了 orientation、父级尺寸已知、自身尺寸已知):%d', n)
console.log('  旧模型(忽略锚点)落在父级内: %d/%d = %s%%', oldIn, n, (100 * oldIn / n).toFixed(1))
console.log('  新模型(锚点折算)  落在父级内: %d/%d = %s%%', newIn, n, (100 * newIn / n).toFixed(1))
console.log('\n分 orientation(样本>=40):')
console.log('  orientation        样本    旧      新')
for (const [k, s] of [...per.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (s.n < 40) continue
  console.log(`  ${k.padEnd(16)} ${String(s.n).padStart(5)}  ${(100 * s.o / s.n).toFixed(0).padStart(4)}%  ${(100 * s.v / s.n).toFixed(0).padStart(4)}%`)
}
