/**
 * 锚点回归:用 HOI4  vanilla 中命名/位置意图明确的地面真相面板校验算法。
 *
 * 核心公式(修正后):
 *   offX = anchorX(orientation) * 父宽 + position.x - alignX * 元素绘制宽
 *   offY = anchorY(orientation) * 父高 + position.y - alignY * 元素绘制高
 *   alignX/alignY 缺省 = orientation 的锚点; origo 覆盖; centerposition=yes 强制 0.5
 *
 * 旧缺省 alignX/alignY=0(左上角)的 bug:
 *   mainmenu_panel_upperright 会算出 offX=1920,整块飞出屏幕右侧。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout } from '../packages/gui/src/model.ts'
import { SpriteIndex } from '../packages/gui/src/sprites.ts'

const VAN = process.argv[2] || 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const idx = new SpriteIndex(VAN)
idx.scan([join(VAN, 'interface')])

function load(rel: string) {
  return buildLayout(readFileSync(join(VAN, 'interface', rel), 'utf8'), rel, idx)
}
const find = (l: ReturnType<typeof load>, name: string) => l.flat.find((n) => n.name === name)

let bad = 0
const chk = (ok: boolean, msg: string) => { console.log((ok ? '  OK   ' : '  FAIL ') + msg); if (!ok) bad++ }

console.log('1) frontendmainview.gui — mainmenu_panel_upperright(地面真相:贴屏幕右上角)')
{
  const l = load('frontendmainview.gui')
  const n = find(l, 'mainmenu_panel_upperright')
  if (!n) { console.log('  节点未找到'); bad++ }
  else {
    console.log(`     position=(${n.relX},${n.relY}) size=${n.drawW}x${n.drawH} orientation=${n.orientation}`)
    console.log(`     abs=(${n.absX.toFixed(1)}, ${n.absY.toFixed(1)}) right=${(n.absX + n.drawW).toFixed(0)}`)
    chk(Math.abs(n.absX + n.drawW - 1920) <= 1, `右边缘=${(n.absX + n.drawW).toFixed(0)} ≈ 1920(屏幕右边缘)`)
    chk(Math.abs(n.absY - (-1)) <= 1, `absY=${n.absY.toFixed(1)} ≈ -1`)
  }
}

console.log('\n2) frontendmainview.gui — mainmenu_panel_upperleft(地面真相:贴屏幕左上角)')
{
  const l = load('frontendmainview.gui')
  const n = find(l, 'mainmenu_panel_upperleft')
  if (!n) { console.log('  节点未找到'); bad++ }
  else {
    console.log(`     position=(${n.relX},${n.relY}) size=${n.drawW}x${n.drawH} orientation=${n.orientation || '(未写)'}`)
    console.log(`     abs=(${n.absX.toFixed(1)}, ${n.absY.toFixed(1)})`)
    chk(Math.abs(n.absX) <= 1, `absX=${n.absX.toFixed(1)} ≈ 0`)
  }
}

console.log('\n3) career_profile/award_display_slots.gui — orientation=center + centerposition=yes')
{
  const l = load('career_profile/award_display_slots.gui')
  const n = l.flat.find((x) => x.name === 'edit_button')
  if (!n) { console.log('  节点未找到'); bad++ }
  else {
    const p = n.parentId ? l.byId.get(n.parentId) : null
    console.log(`     父级 ${p?.name} ${p?.w}x${p?.h};元素 size=${n.drawW}x${n.drawH} centerPosition=${n.centerPosition}`)
    console.log(`     offX=${n.offX} offY=${n.offY} (center*center → 元素中心落在父级中心)`)
    const cx = n.offX + n.drawW / 2, cy = n.offY + n.drawH / 2
    chk(Math.abs(cx - (p?.w ?? 0) / 2) <= 2, `中心 x=${cx.toFixed(1)} ≈ 父级中点=${(p!.w / 2).toFixed(1)}`)
    chk(Math.abs(cy - (p?.h ?? 0) / 2) <= 2, `中心 y=${cy.toFixed(1)} ≈ 父级中点=${(p!.h / 2).toFixed(1)}`)
  }
}

console.log('\n4) career_profile/profile_picture_view.gui — lower_right + centerposition=yes')
{
  const l = load('career_profile/profile_picture_view.gui')
  const n = l.flat.find((x) => x.name === 'lock' && x.orientation === 'lower_right')
  if (!n) { console.log('  节点未找到'); bad++ }
  else {
    const p = n.parentId ? l.byId.get(n.parentId) : null
    const cx = n.offX + n.drawW / 2
    const cy = n.offY + n.drawH / 2
    console.log(`     父级 ${p?.name} ${p?.w}x${p?.h};元素 ${n.drawW}x${n.drawH}`)
    console.log(`     元素中心(相对父级)= ${cx.toFixed(1)}, ${cy.toFixed(1)}`)
    chk(Math.abs(cx - 82) <= 3, `中心 x=${cx.toFixed(1)} ≈ 82`)
    chk(Math.abs(cy - 82) <= 3, `中心 y=${cy.toFixed(1)} ≈ 82`)
  }
}

console.log('\n5) 缺省 orientation 必须是 upper_left(曾误设成 center,导致全库错位)')
{
  const l = load('acesview.gui')
  const n = find(l, 'content')
  if (!n) { console.log('  节点未找到'); bad++ }
  else {
    console.log(`     父级 acesview ${l.flat[0].drawW}x${l.flat[0].drawH};content position=(${n.relX},${n.relY}) orientation=${n.orientation || '(未写)'}`)
    console.log(`     offX=${n.offX} offY=${n.offY} (未写 orientation → 偏移必须等于原始 position)`)
    chk(Math.abs(n.offX - n.relX) <= 0.01, `offX=${n.offX} === relX=${n.relX}`)
    chk(Math.abs(n.offY - n.relY) <= 0.01, `offY=${n.offY} === relY=${n.relY}`)
  }
}

console.log('\n6) 全量回归:所有 vanilla .gui 重新构建,统计异常')
{
  const { walkFiles } = await import('../packages/gui/src/sprites.ts')
  const files = walkFiles(join(VAN, 'interface'), ['.gui'])
  let errs = 0
  let nan = 0
  let outside = 0
  let anchorLeak = 0
  let total = 0
  for (const f of files) {
    let src: string
    try { src = readFileSync(f, 'utf8') } catch { continue }
    let l
    try { l = buildLayout(src, f, idx) } catch (e) { errs++; console.log('    构建异常 ' + f + ': ' + e.message); continue }
    for (const n of l.flat) {
      total++
      if (!Number.isFinite(n.absX) || !Number.isFinite(n.absY) || !Number.isFinite(n.offX) || !Number.isFinite(n.offY)) nan++
      const p = n.parentId ? l.byId.get(n.parentId) : null
      if (p && p.w > 0 && p.h > 0) {
        if (n.offX > p.w * 2 || n.offX < -p.w * 2 || n.offY > p.h * 2 || n.offY < -p.h * 2) outside++
      }
      if (!n.orientation && !n.origo && !n.centerPosition && !n.posPct) {
        if (Math.abs(n.offX - n.relX) > 0.01 || Math.abs(n.offY - n.relY) > 0.01) anchorLeak++
      }
    }
  }
  console.log(`     文件 ${files.length} · 元素 ${total} · 构建异常 ${errs} · 坐标 NaN ${nan} · 偏移超父级2倍 ${outside} · 无锚点却偏移 ${anchorLeak}`)
  chk(errs === 0, '无构建异常')
  chk(nan === 0, '无 NaN 坐标')
  chk(anchorLeak === 0, '无锚点元素的偏移等于原始 position(缺省 orientation=upper_left)')
}

console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
