/**
 * 验证 anchorFactors 对复合定向锚点(center_left/center_up/center_down…)的解析。
 * 正确公式:offX = af(ori).x * pW + relX - alignX * drawW
 *   center_left → 自身左缘对齐父级左边 → alignX=0 → offX 应 = relX(与 drawW 无关)
 *   center_up   → 自身上缘对齐父级上边 → alignY=0 → offY 应 = relY
 *   center_right→ alignX=1 → offX 应 = pW - drawW + relX(贴右)
 *   center_down → alignY=1 → offY 应 = pH - drawH + relY(贴底)
 * 若模型输出偏离上述"应有值",即为 anchorFactors 解析错误。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpriteIndex } from '../src/sprites.ts'
import { buildLayout } from '../src/_model_new.ts'

const V = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const sprites = new SpriteIndex(V)
sprites.scan([join(V, 'interface')])

// 与 model.ts 同源的“正确”解析,用于生成应有值
function af(name: string | undefined): { x: number; y: number } {
  const o = (name || '').toLowerCase()
  if (!o) return { x: 0, y: 0 }
  let x = 0
  if (o.includes('right')) x = 1
  else if (o.includes('left')) x = 0
  else if (o.includes('center') || o.includes('middle')) x = 0.5
  let y = 0
  if (o.includes('lower') || o.includes('down')) y = 1
  else if (o.includes('upper') || o.includes('up')) y = 0
  else if (o.includes('center') || o.includes('middle')) y = 0.5
  return { x, y }
}

const files = [
  'interface/abilitylist.gui',
  'interface/ast_right_vs_left_campaign_scripted_gui.gui',
  'interface/battleplantools.gui',
  'interface/career_profile/awards_view.gui',
  'interface/frontendmainview.gui',
]

let total = 0
let wrong = 0
for (const f of files) {
  const abs = join(V, f)
  let src: string
  try { src = readFileSync(abs, 'utf8') } catch { continue }
  const layout = buildLayout(src, f, sprites)
  const hits = layout.flat.filter((n) => n.orientation && /center_(up|down|left|right)|center_lower|center/.test(n.orientation.toLowerCase()))
  if (!hits.length) continue
  for (const n of hits) {
    total++
    const parent = n.parentId ? layout.byId.get(n.parentId) : undefined
    const pW = parent ? parent.drawW : 1920
    const pH = parent ? parent.drawH : 1080
    const a = af(n.orientation)
    let alignX = a.x, alignY = a.y
    if (n.centerPosition) { alignX = 0.5; alignY = 0.5 }
    else if (n.origo) { const o = af(n.origo); alignX = o.x; alignY = o.y }
    const expX = a.x * pW + n.relX - alignX * n.drawW
    const expY = a.y * pH + n.relY - alignY * n.drawH
    const dx = n.offX - expX
    const dy = n.offY - expY
    const bad = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5
    if (bad) wrong++
    if (bad || n.orientation!.toLowerCase().startsWith('center_'))
      console.log(
        `${bad ? '✗' : '✓'} ${f.split('/').pop()} | ${n.type} "${n.name}" ori=${n.orientation} ` +
        `pos=(${n.relX},${n.relY}) size=${Math.round(n.drawW)}x${Math.round(n.drawH)} ` +
        `off=(${Math.round(n.offX)},${Math.round(n.offY)}) 应有=(${Math.round(expX)},${Math.round(expY)}) ` +
        `Δ=(${Math.round(dx)},${Math.round(dy)}) pW=${Math.round(pW)}`,
      )
  }
}
console.log(`\n合计检查 ${total} 个 center* 锚点元素,偏离应有值 ${wrong} 个`)
