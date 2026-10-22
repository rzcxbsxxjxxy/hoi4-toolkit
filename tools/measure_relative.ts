/**
 * 诊断:子元素相对"父窗口"的定位,按嵌套深度与 orientation 细分统计。
 * 判据:子元素包围盒是否落在父元素包围盒内(容 8px)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout } from '../packages/gui/src/model.ts'

const VAN = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/interface'

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.gui')) out.push(p)
  }
  return out
}

const files = walk(VAN)
const byDepth = new Map<number, { n: number; ok: number }>()
const byOri = new Map<string, { n: number; ok: number }>()
let total = 0
let bad = 0
const badSamples: string[] = []

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  let doc: any
  let layout: any
  try {
    layout = buildLayout(src, f.slice(VAN.length + 1), undefined)
  } catch { continue }

  const rec = (ns: any[]) => {
    for (const n of ns) {
      for (const c of n.children || []) {
        // 只在父级尺寸已知时判定
        if (n.drawW > 0 && n.drawH > 0 && c.drawW > 0 && c.drawH > 0) {
          const inside =
            c.offX >= -8 && c.offY >= -8 &&
            c.offX + c.drawW <= n.drawW + 8 &&
            c.offY + c.drawH <= n.drawH + 8
          const dk = c.depth
          const d = byDepth.get(dk) || { n: 0, ok: 0 }
          d.n++
          if (inside) d.ok++
          byDepth.set(dk, d)
          const ok2 = c.orientation || '(none)'
          const o = byOri.get(ok2) || { n: 0, ok: 0 }
          o.n++
          if (inside) o.ok++
          byOri.set(ok2, o)
          total++
          if (!inside) {
            bad++
            if (badSamples.length < 12) {
              badSamples.push(
                `${f.slice(VAN.length + 1)} d${c.depth} ${c.type}:${c.name} ori=${c.orientation || '-'} ` +
                `parent(${n.type}:${n.name} ${Math.round(n.drawW)}x${Math.round(n.drawH)}) ` +
                `child ${Math.round(c.drawW)}x${Math.round(c.drawH)} off=${Math.round(c.offX)},${Math.round(c.offY)} raw=${c.relX},${c.relY}`,
              )
            }
          }
        }
      }
      rec(n.children || [])
    }
  }
  rec(layout.nodes)
}

console.log('=== 按深度 ===')
for (const [d, v] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  depth ${d}: ${v.ok}/${v.n} = ${((v.ok / v.n) * 100).toFixed(1)}%`)
}
console.log('=== 按 orientation ===')
for (const [k, v] of [...byOri.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
  console.log(`  ${k.padEnd(14)} ${v.ok}/${v.n} = ${((v.ok / v.n) * 100).toFixed(1)}%`)
}
console.log(`\n总计 ${total}, 越界 ${bad} (${((bad / total) * 100).toFixed(1)}%)`)
console.log('\n=== 越界样例 ===')
for (const s of badSamples) console.log('  ' + s)
