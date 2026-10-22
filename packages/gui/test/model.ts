/**
 * 布局模型 + 无损回写 的端到端验证。
 *
 * 验证四件事:
 *  1. 未改动时输出 === 原文(生死线)
 *  2. 改坐标后,只有目标数字发生变化
 *  3. 注释 / 缩进 / 空行 / BOM 原样保留
 *  4. 行级守卫能拦住"改动落到预期之外"的情况
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpriteIndex } from '../src/sprites.ts'
import { buildLayout } from '../src/model.ts'
import { applyEdits, makeDiff } from '../src/edit.ts'
import { serialize } from '../../parser/src/serialize.ts'
import { parse } from '../../parser/src/parser.ts'

const V = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'

console.log('════════ 1. 建立 sprite 索引 ════════')
const t0 = Date.now()
const sprites = new SpriteIndex(V)
sprites.scan([join(V, 'interface')])
console.log(`  扫描 ${sprites.stats.files} 个 .gfx/.gui,${(Date.now() - t0)} ms`)
console.log(`  sprite 定义 ${sprites.stats.sprites} 个,其中带 texturefile ${sprites.stats.withTexture} 个`)

const sample = 'interface/abilitylist.gui'
const abs = join(V, sample)
const src = readFileSync(abs, 'utf8')

console.log('\n════════ 2. 构建布局树 ════════')
const layout = buildLayout(src, sample, sprites)
console.log(`  元素 ${layout.stats.elements} 个,最大深度 ${layout.stats.maxDepth},带 sprite ${layout.stats.withSprite}`)
console.log(`  画布 ${Math.round(layout.canvasW)} × ${Math.round(layout.canvasH)}`)
console.log(`  sprite 未解析 ${layout.unresolved.length} 处`)
for (const n of layout.nodes) {
  console.log(`  根: ${n.type} "${n.name}"  ${n.drawW}×${n.drawH}  子元素 ${n.children.length}`)
}
console.log('  前 6 个节点(含推断信息):')
for (const n of layout.flat.slice(0, 6)) {
  const inf = n.sizeInferred ? `  [尺寸推断自贴图${n.sprite ? ' ' + n.sprite : ''}]` : ''
  console.log(
    `    ${'  '.repeat(n.depth)}${n.type} "${n.name}" @(${n.relX},${n.relY}) ${Math.round(n.drawW)}×${Math.round(n.drawH)}${inf}`,
  )
}

console.log('\n════════ 3. 生死线:无改动时输出必须等于原文 ════════')
const untouched = serialize(parse(src))
console.log(`  字节一致: ${untouched === src ? '通过' : '失败'}`)

console.log('\n════════ 4. 改坐标 + 改尺寸 ════════')
const target = layout.flat.find((n) => n.type === 'iconType' && !n.sizeInferred) ?? layout.flat[1]
console.log(`  目标: ${target.id}  "${target.name}"  @(${target.relX},${target.relY}) ${target.w}×${target.h}  第 ${target.line} 行`)
const layout2 = buildLayout(src, sample, sprites)
const out = applyEdits(layout2, [{ id: target.id, x: target.relX + 25, y: target.relY + 10, w: 120, h: 60 }])
console.log(`  改动 ${out.details.length} 处:`)
for (const d of out.details) console.log(`    [${d.mode}] ${d.field}: ${d.from} → ${d.to}  (第 ${d.line} 行)`)
console.log(`  守卫: ${out.guard.ok ? 'OK' : 'FAIL'} — ${out.guard.message}`)
console.log(`  警告: ${out.warnings.length ? out.warnings.join('; ') : '无'}`)
console.log('\n  diff:')
console.log(makeDiff(src, out.text).split('\n').map((l) => '    ' + l).join('\n'))

console.log('\n════════ 5. 无损性:除目标数字外一切原样 ════════')
const strip = (s: string) => s.replace(/\d+/g, '#')
// 把原文与新文都去掉数字后比较结构:允许的差异只能来自改动行
const a = src.split('\n')
const b = out.text.split('\n')
let diffs = 0
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue
  diffs++
  if (diffs <= 6) console.log(`    行 ${i + 1}: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`)
}
console.log(`  差异行数: ${diffs}`)

console.log('\n════════ 6. 二次解析仍可无损往返 ════════')
const doc2 = parse(out.text)
console.log(`  再次序列化一致: ${serialize(doc2) === out.text ? '通过' : '失败'}`)

console.log('\n════════ 7. 缺失 position/size 时的插入能力 ════════')
const noPos = layout.flat.find((n) => n.posMissing && n.type !== 'containerWindowType')
if (noPos) {
  console.log(`  目标(无 position): ${noPos.id} "${noPos.name}" 第 ${noPos.line} 行`)
  const l3 = buildLayout(src, sample, sprites)
  const o3 = applyEdits(l3, [{ id: noPos.id, x: 42, y: 24 }])
  console.log(`  改动: ${o3.details.map((d) => `${d.field}:${d.mode}`).join(', ') || '(无)'}`)
  console.log(`  守卫: ${o3.guard.ok ? 'OK' : 'FAIL'} — ${o3.guard.message}`)
  console.log('  diff:')
  console.log(makeDiff(src, o3.text).split('\n').map((l) => '    ' + l).join('\n'))
} else {
  console.log('  该文件中没有缺 position 的元素,换一个文件测试')
}
