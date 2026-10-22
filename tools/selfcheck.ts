/* designer 全链路自检:改属性(替换/插入)、有父级新增、无父级新增、删除、几何回写
 * 全部在内存中跑(不落盘),用真实 vanilla .gui 文件。
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SpriteIndex, walkFiles } from '../packages/gui/src/sprites.ts'
import { buildLayout } from '../packages/gui/src/model.ts'
import { applyGuiOp, applyEdits } from '../packages/gui/src/edit.ts'
import { parse } from '../packages/parser/src/parser.ts'

const ROOT = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const sprites = new SpriteIndex(ROOT)
const files = walkFiles(join(ROOT, 'interface'), ['.gui'])
const limit = parseInt(process.argv[2] ?? '0', 10)
const sample = limit > 0 ? files.slice(0, limit) : files

const fails: string[] = []
const note = (m: string) => { fails.push(m) }
/** 统计"连续空行"出现次数(vanilla 本身就有空行,必须做差分而不是全文匹配) */
const blankRuns = (s: string) => (s.match(/\n[ \t]*\n/g) || []).length

let emptyFiles = 0, tested = 0

for (const f of sample) {
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  const src = readFileSync(f, 'utf8')
  let base
  try { base = buildLayout(src, rel, sprites) } catch (e) { note(`[${rel}] buildLayout 抛错: ${(e as Error).message}`); continue }
  if (!base.flat.length) { emptyFiles++; continue }
  tested++

  // ── 0. 基础体检:子元素是否递归带出、坐标是否有限 ──
  const total = base.flat.length
  if (base.nodes.length && total === 0) note(`[${rel}] 有顶层节点但 flat 为空`)
  for (const n of base.flat) {
    if (!isFinite(n.relX) || !isFinite(n.relY)) note(`[${rel}] 坐标非法: ${n.id} ${n.relX},${n.relY}`)
  }

  // ── 1. 改属性·替换已有值(name) ──
  const t1 = buildLayout(src, rel, sprites)
  const n1 = t1.flat.find((n) => n.name && n.name !== '(匿名)') || t1.flat[0]
  if (n1) {
    const r = applyGuiOp(t1, { kind: 'set', id: n1.id, key: 'name', value: 'zz_renamed_test' })
    if (!r.outcome.guard.ok) note(`[${rel}] SET(name) 守卫失败: ${r.outcome.guard.message}`)
    const d = parse(r.outcome.text)
    if (d.errors.length) note(`[${rel}] SET(name) 解析错误 ${d.errors.length}`)
    if (!r.outcome.text.includes('zz_renamed_test')) note(`[${rel}] SET(name) 文本未含新值`)
  }

  // ── 2. 改属性·插入新键(文件中不存在) ──
  const t2 = buildLayout(src, rel, sprites)
  const n2 = t2.flat[0]
  if (n2) {
    const r = applyGuiOp(t2, { kind: 'set', id: n2.id, key: 'zz_new_prop', value: 'hello' })
    if (!r.outcome.guard.ok) note(`[${rel}] SET(insert) 守卫失败: ${r.outcome.guard.message}`)
    const d = parse(r.outcome.text)
    if (d.errors.length) note(`[${rel}] SET(insert) 解析错误 ${d.errors.length}`)
    if (!r.outcome.text.includes('zz_new_prop')) note(`[${rel}] SET(insert) 文本未含新键`)
    // 空行/格式:必须做差分(vanilla 本身含空行)
    const b0 = blankRuns(src), b1 = blankRuns(r.outcome.text)
    if (b1 > b0) note(`[${rel}] SET(insert) 新增空行 ${b1 - b0}`)
  }

  // ── 3. 有父级新增 ──
  const t3 = buildLayout(src, rel, sprites)
  const parent = t3.flat.find((n) => n.children.length >= 0 && n.depth === 0) || t3.flat[0]
  let addedId: string | undefined
  if (parent) {
    const r = applyGuiOp(t3, {
      kind: 'add', parentId: parent.id, type: 'iconType', name: 'zz_added_icon',
      x: 10, y: 10, w: 32, h: 32, spriteType: 'GFX_questionmark', orientation: 'upper_left',
    })
    if (!r.outcome.guard.ok) note(`[${rel}] ADD(有父级) 守卫失败: ${r.outcome.guard.message}`)
    if (!r.newId) note(`[${rel}] ADD(有父级) 未返回 newId`)
    const d = parse(r.outcome.text)
    if (d.errors.length) note(`[${rel}] ADD(有父级) 解析错误 ${d.errors.length}`)
    const after = buildLayout(r.outcome.text, rel, sprites)
    const added = after.flat.find((n) => n.name === 'zz_added_icon')
    if (!added) note(`[${rel}] ADD(有父级) 新增节点在重建后找不到`)
    else {
      addedId = added.id
      if (added.parentId !== parent.id) note(`[${rel}] ADD(有父级) parentId 不符: 期望 ${parent.id} 实得 ${added.parentId}`)
      if (added.sprite !== 'GFX_questionmark') note(`[${rel}] ADD(有父级) spriteType 未写入: ${added.sprite}`)
      if (added.relX !== 10 || added.relY !== 10) note(`[${rel}] ADD(有父级) 坐标未写入: ${added.relX},${added.relY}`)
    }
    const b0 = blankRuns(src), b1 = blankRuns(r.outcome.text)
    if (b1 > b0) note(`[${rel}] ADD(有父级) 新增空行 ${b1 - b0}`)
  }

  // ── 4. 无父级新增(工具箱在未选中任何元素时点击) ──
  const t4 = buildLayout(src, rel, sprites)
  const r4 = applyGuiOp(t4, { kind: 'add', parentId: null, type: 'iconType', name: 'zz_root_icon', x: 5, y: 5 })
  const hasGuiTypes = src.includes('guiTypes')
  if (!r4.outcome.guard.ok) note(`[${rel}] ADD(无父级) 守卫失败(有guiTypes=${hasGuiTypes}): ${r4.outcome.guard.message}`)
  if (!r4.newId) note(`[${rel}] ADD(无父级) 未返回 newId`)
  if (parse(r4.outcome.text).errors.length) note(`[${rel}] ADD(无父级) 解析错误`)

  // ── 5. 删除刚新增的节点 ──
  if (addedId) {
    const t5 = buildLayout(src, rel, sprites)
    // 先加再删,模拟真实操作序列
    const ra = applyGuiOp(t5, { kind: 'add', parentId: parent!.id, type: 'iconType', name: 'zz_del_icon', x: 1, y: 1 })
    const t5b = buildLayout(ra.outcome.text, rel, sprites)
    if (ra.newId) {
      const rd = applyGuiOp(t5b, { kind: 'del', id: ra.newId })
      if (!rd.outcome.guard.ok) note(`[${rel}] DEL 守卫失败: ${rd.outcome.guard.message}`)
      if (parse(rd.outcome.text).errors.length) note(`[${rel}] DEL 解析错误`)
      const after = buildLayout(rd.outcome.text, rel, sprites)
      if (after.flat.some((n) => n.name === 'zz_del_icon')) note(`[${rel}] DEL 后节点仍存在`)
      if (after.flat.length !== t5.flat.length) note(`[${rel}] DEL 后元素数不符: ${after.flat.length} vs 原 ${t5.flat.length}`)
    } else note(`[${rel}] DEL 前置 add 未拿到 newId`)
  }

  // ── 6. 几何回写(拖拽/缩放保存) ──
  const t6 = buildLayout(src, rel, sprites)
  const n6 = t6.flat.find((n) => n.relX > 0) || t6.flat[0]
  if (n6) {
    const r = applyEdits(t6, [{ id: n6.id, x: n6.relX + 7, y: n6.relY + 3 }])
    if (!r.guard.ok) note(`[${rel}] 几何回写守卫失败: ${r.guard.message}`)
    if (parse(r.text).errors.length) note(`[${rel}] 几何回写解析错误`)
  }
}

console.log(`样本文件: ${sample.length} | 有效测试: ${tested} | 无元素文件: ${emptyFiles}`)
console.log(`失败项: ${fails.length}`)
const uniq = [...new Set(fails)]
uniq.slice(0, 30).forEach((m) => console.log('  - ' + m))
if (uniq.length > 30) console.log(`  ... 另有 ${uniq.length - 30} 条`)
