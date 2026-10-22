/** 插入路径专项测试:文件里没有 position / size 时,拖拽后应能自动补上且不破坏其余内容 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpriteIndex } from '../src/sprites.ts'
import { buildLayout } from '../src/model.ts'
import { applyEdits, makeDiff } from '../src/edit.ts'
import { parse } from '../../parser/src/parser.ts'
import { serialize } from '../../parser/src/serialize.ts'

const V = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const sprites = new SpriteIndex(V)
sprites.scan([join(V, 'interface')])

const cases: { file: string; note: string }[] = [
  { file: 'interface/menubar.gui', note: '含缺 position 的容器' },
  { file: 'interface/abilitylist.gui', note: '结构规整的小文件' },
]

for (const c of cases) {
  const src = readFileSync(join(V, c.file), 'utf8')
  const lay = buildLayout(src, c.file, sprites)

  // 找三种目标:缺 position / 缺 size / 两者都有
  const noPos = lay.flat.find((n) => n.posMissing)
  const noSize = lay.flat.find((n) => n.sizeInferred && !n.sizeUnknown)

  console.log(`\n════════ ${c.file} (${c.note}) ════════`)
  console.log(`  元素 ${lay.stats.elements},缺 position ${lay.flat.filter((n) => n.posMissing).length},尺寸推断 ${lay.flat.filter((n) => n.sizeInferred).length}`)

  const targets = [
    { n: noPos, edit: { x: 12, y: 34 }, label: '补 position' },
    { n: noSize, edit: { w: 111, h: 222 }, label: '补 size' },
  ].filter((t) => t.n) as { n: NonNullable<typeof noPos>; edit: object; label: string }[]

  for (const t of targets) {
    const l = buildLayout(src, c.file, sprites)
    const out = applyEdits(l, [{ id: t.n!.id, ...t.edit }] as never)
    const ok = out.guard.ok
    console.log(`\n  ── ${t.label}: ${t.n!.id} "${t.n!.name}" 第 ${t.n!.line} 行`)
    console.log(`     改动: ${out.details.map((d) => `${d.field}(${d.mode}) ${d.from}→${d.to}`).join(', ') || '(无)'}`)
    console.log(`     警告: ${out.warnings.join('; ') || '无'}`)
    console.log(`     守卫: ${ok ? 'OK' : 'FAIL'} — ${out.guard.message}`)

    // 重新解析验证:输出必须能再次无损往返,且目标值确实变了
    const doc = parse(out.text)
    const round = serialize(doc) === out.text
    const lay2 = buildLayout(out.text, c.file, sprites)
    const after = lay2.byId.get(t.n!.id)
    const valOk =
      after &&
      (t.edit as { x?: number; y?: number; w?: number; h?: number }).x !== undefined
        ? after.relX === (t.edit as { x: number }).x && after.relY === (t.edit as { y: number }).y
        : after
          ? after.w === (t.edit as { w: number }).w && after.h === (t.edit as { h: number }).h
          : false
    console.log(`     再次往返: ${round ? '通过' : '失败'}   目标值已生效: ${valOk ? '是' : '否'}`)
    console.log('     diff:')
    for (const line of makeDiff(src, out.text).split('\n').slice(0, 12)) console.log('       ' + line)
  }
}

console.log('\n════════ 组合:同一文件多处改动(含插入 + 替换) ════════')
const src = readFileSync(join(V, 'interface/menubar.gui'), 'utf8')
const lay = buildLayout(src, 'interface/menubar.gui', sprites)
const picks = [
  ...lay.flat.filter((n) => n.posMissing).slice(0, 1).map((n) => ({ id: n.id, x: 7, y: 9 })),
  ...lay.flat.filter((n) => !n.posMissing).slice(0, 2).map((n) => ({ id: n.id, x: n.relX + 5, y: n.relY + 3 })),
  ...lay.flat.filter((n) => !n.sizeInferred).slice(0, 1).map((n) => ({ id: n.id, w: 64, h: 48 })),
]
console.log(`  提交 ${picks.length} 处改动`)
const out = applyEdits(lay, picks as never)
console.log(`  改动明细:`)
for (const d of out.details) console.log(`    ${d.id} ${d.field}(${d.mode}) ${d.from}→${d.to} 行${d.line}`)
console.log(`  警告: ${out.warnings.join('; ') || '无'}`)
console.log(`  守卫: ${out.guard.ok ? 'OK' : 'FAIL'} — ${out.guard.message}`)
console.log(`  再次往返: ${serialize(parse(out.text)) === out.text ? '通过' : '失败'}`)
console.log('  diff:')
for (const line of makeDiff(src, out.text).split('\n')) console.log('    ' + line)
