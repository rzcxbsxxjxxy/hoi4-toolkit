/**
 * 验收:当前 model.ts(已打补丁)算出来的坐标是否符合策略 A(不继承·不镜像·对齐=锚点)。
 * 两件事:
 *   1) 三个地面真相逐个对账
 *   2) 用 buildLayout 自己输出的 offX/offY 跑全量框内率,应逼近策略 A 那一列
 *      (upper_right 73% / lower_left 88% / lower_right 68% / 总体 84.1%)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout } from '../packages/gui/src/model.ts'
import { SpriteIndex, walkFiles } from '../packages/gui/src/sprites.ts'

const VAN = process.argv[2] || 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const idx = new SpriteIndex(VAN)
idx.scan([join(VAN, 'interface')])

let pass = 0
let fail = 0
function ck(name: string, ok: boolean, detail: string) {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name.padEnd(34) + detail)
  ok ? pass++ : fail++
}

console.log('════ 1) 地面真相 ════')

// ① airwingdetails.gui:父容器 width=856,btn_close UPPER_RIGHT x=-35
//    不镜像 → offX=821(框内,距右缘 35);镜像 → 891(框外)
{
  const f = join(VAN, 'interface', 'airwingdetails.gui')
  const l = buildLayout(readFileSync(f, 'utf8'), f, idx)
  const root = l.flat.find((n: any) => n.name === 'air_wing_stats_window') as any
  for (const nm of ['btn_close', 'btn_delete'] as const) {
    const n = l.flat.find((x: any) => x.name === nm) as any
    if (!n || !root) { ck(nm, false, '未找到节点'); continue }
    const rightEdge = n.offX + n.drawW
    const inside = n.offX >= 0 && rightEdge <= root.w + 1
    ck('airwingdetails/' + nm, inside,
      'offX=' + n.offX.toFixed(0) + ' 右缘=' + rightEdge.toFixed(0) + ' 父宽=' + root.w +
      ' (镜像会算出 ' + (root.w + 35) + ' → 框外)')
  }
}

// ② frontendmainview.gui:mainmenu_panel_upperright width=256 upper_right x=0
//    对齐=锚点 → offX=1664,右缘=1920 正好贴齐;对齐=左上 → offX=1920 飞出屏幕
{
  const f = join(VAN, 'interface', 'frontendmainview.gui')
  const l = buildLayout(readFileSync(f, 'utf8'), f, idx)
  const n = l.flat.find((x: any) => x.name === 'mainmenu_panel_upperright') as any
  if (n) {
    const rightEdge = n.offX + n.drawW
    ck('mainmenu_panel_upperright', Math.abs(rightEdge - 1920) <= 1,
      'offX=' + n.offX.toFixed(0) + ' 右缘=' + rightEdge.toFixed(0) + ' (应为 1920 贴齐屏幕右缘)')
  } else ck('mainmenu_panel_upperright', false, '未找到节点')
}

// ③ career_profile/common_components.gui:warfare_numbers
//    orientation=center_up, 子容器 longest_battle_duration 写
//    position={x=@StatContainerLeftX=14}(未写 orientation)→ 相对父级左上角 14px
{
  const f = join(VAN, 'interface', 'career_profile', 'common_components.gui')
  const l = buildLayout(readFileSync(f, 'utf8'), f, idx)
  const parent = l.flat.find((x: any) => x.name === 'warfare_numbers') as any
  const child = l.flat.find((x: any) => x.name === 'longest_battle_duration') as any
  if (parent && child) {
    const inside = child.offX >= -1 && child.offX + child.drawW <= parent.w + 1
    ck('career_profile 不继承', inside,
      '子 offX=' + child.offX.toFixed(0) + ' 宽=' + child.drawW.toFixed(0) +
      ' 父宽=' + parent.w + ' 父orientation=' + parent.orientation + ' (继承会算成 ' +
      (parent.w * 0.5 + child.relX - child.drawW * 0.5).toFixed(0) + ')')
  } else ck('career_profile 不继承', false, '未找到节点')
}

console.log('\n════ 2) 全量框内率(用 buildLayout 自己输出的 offX/offY) ════')
const tot = { n: 0, inn: 0 }
const per = new Map<string, { n: number; inn: number }>()
for (const f of walkFiles(join(VAN, 'interface'), ['.gui'])) {
  let src: string
  try { src = readFileSync(f, 'utf8') } catch { continue }
  let l: any
  try { l = buildLayout(src, f, idx) } catch { continue }
  for (const nd of l.flat as any[]) {
    const p = nd.parentId ? l.byId.get(nd.parentId) : null
    const pw = p ? p.w : 1920
    const ph = p ? p.h : 1080
    const parentKnown = p ? p.w > 0 && p.h > 0 && !p.sizeAuto && !p.sizeInferred : true
    if (!parentKnown || pw <= 0 || ph <= 0) continue
    if (!(nd.drawW > 0) || !(nd.drawH > 0)) continue
    const ok = nd.offX >= -1 && nd.offX + nd.drawW <= pw + 1 && nd.offY >= -1 && nd.offY + nd.drawH <= ph + 1
    tot.n++
    if (ok) tot.inn++
    const key = String(nd.effectiveOrientation ?? 'upper_left').toLowerCase()
    const s = per.get(key) || { n: 0, inn: 0 }
    s.n++; if (ok) s.inn++
    per.set(key, s)
  }
}
console.log('  总体: %d/%d = %s%%   (策略A基准 84.1%% / 镜像基准 81.5%%)',
  tot.inn, tot.n, (100 * tot.inn / tot.n).toFixed(1))
console.log('  orientation        实测    策略A基准')
const EXPECT: Record<string, string> = {
  upper_left: '86%', upper_right: '73%', lower_left: '88%', lower_right: '68%',
  center: '39%', center_up: '74%', center_down: '-', center_right: '0%',
}
for (const [k, s] of [...per.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (s.n < 30) continue
  const got = (100 * s.inn / s.n).toFixed(0) + '%'
  const exp = EXPECT[k] ?? '?'
  const match = exp === '?' || exp === '-' ? '' : (Math.abs(parseInt(got) - parseInt(exp)) <= 2 ? '  ✓' : '  ✗ 期望 ' + exp)
  console.log('  %s %s    %s%s', k.padEnd(16), got.padStart(5), (exp || '—').padStart(6), match)
}

console.log('\n结果: PASS=%d  FAIL=%d', pass, fail)
process.exit(fail ? 1 : 0)
