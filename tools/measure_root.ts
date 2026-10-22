/** 根级窗口(depth 0)相对屏幕 1920x1080 的落位检查 */
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
let n = 0, ok = 0, files = 0, filesOk = 0
const bad: string[] = []
for (const f of walk(VAN)) {
  const src = readFileSync(f, 'utf8')
  let L: any
  try { L = buildLayout(src, f.slice(VAN.length + 1), undefined) } catch { continue }
  if (!L.nodes.length) continue
  files++
  let allOk = true
  for (const r of L.nodes) {
    if (!(r.drawW > 0 && r.drawH > 0)) continue
    n++
    const inside = r.absX >= -8 && r.absY >= -8 && r.absX + r.drawW <= 1928 && r.absY + r.drawH <= 1088
    if (inside) ok++; else { allOk = false; if (bad.length < 10) bad.push(`${f.slice(VAN.length + 1)} ${r.type}:${r.name} ori=${r.orientation || '-'} abs=${Math.round(r.absX)},${Math.round(r.absY)} ${Math.round(r.drawW)}x${Math.round(r.drawH)}`) }
  }
  if (allOk) filesOk++
}
console.log(`根窗口 ${n} 个,落在屏幕内 ${ok} = ${((ok / n) * 100).toFixed(1)}%`)
console.log(`文件 ${files} 个,全部根窗口都在屏幕内 ${filesOk} = ${((filesOk / files) * 100).toFixed(1)}%`)
console.log('\n=== 越界样例 ===')
for (const b of bad) console.log('  ' + b)
