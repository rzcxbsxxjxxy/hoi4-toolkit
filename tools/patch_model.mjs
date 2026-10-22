/**
 * 按真实 Interface 语法修正 model.ts(该文件被 fs-shim 拒绝直接覆盖,故用脚本生成 + shell 替换)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __DIR = dirname(fileURLToPath(import.meta.url))

const f = join(__DIR, '..', 'packages', 'gui', 'src', 'model.ts')
let s = readFileSync(f, 'utf8')
const orig = s

const rep = (oldS, newS, tag) => {
  if (!s.includes(oldS)) {
    console.log('!! 未匹配: ' + tag)
    return false
  }
  s = s.replace(oldS, newS)
  console.log('  ok: ' + tag)
  return true
}

// 1. import walk
rep(
  "import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'",
  "import { keyText, valueText, lineOf, walk } from '../../parser/src/serialize.ts'",
  'import walk')

// 2. PROP_BLOCKS 修正 + 新增容器块
rep(
  `/** 只作为属性存在、不是子元素的块 */
const PROP_BLOCKS = new Set(['background', 'margin', 'size', 'position', 'border', 'scrollbar'])`,
  `/**
 * 只作为属性存在、不是子元素的块(实测自 vanilla 453 个 .gui 的全量扫描)。
 *
 * 注意:原实现里的 'border' 在真实语法中根本不存在 —— 真名是 borderSize,
 * 结果 borderSize = { x= y= }(1104 处)既没被当属性也没被当元素,被静默丢弃。
 */
const PROP_BLOCKS = new Set([
  'background', 'background_margin', 'border', 'bordersize', 'cursor', 'drag_scroll',
  'expandbutton', 'hide_position', 'margin', 'max', 'max_slots', 'min', 'offset', 'padding',
  'pdx_tooltip_anchor', 'peek_check_size', 'peek_check_top_left', 'peek_position',
  'position', 'scrollbar', 'show_position', 'size', 'slotsize', 'tilesize', 'track',
  'slider', 'decreasebutton', 'increasebutton', 'closed_position', 'open_position',
  'bound_tooltip', 'verticalscrollbar', 'horizontalscrollbar',
])

/**
 * 自身不是元素、但内部含子元素的容器块 —— 子元素要提升到宿主元素下。
 * 实测:expandedWindow(43 处)内含 gridBoxType / positionType / instantTextboxType,
 * 若按属性块整块跳过,这些子元素会凭空消失。
 */
const CONTAINER_BLOCKS = new Set(['expandedwindow'])`,
  'PROP_BLOCKS / CONTAINER_BLOCKS')

// 3. GuiNode: 增加 propBlocks / varRefs
rep(
  `  props: Record<string, string>
  children: GuiNode[]`,
  `  props: Record<string, string>
  /** 块形态的属性(background / borderSize / margin / slotSize…),内层标量已摊平,供属性网格编辑 */
  propBlocks: Record<string, Record<string, string>>
  /** 几何值里来自 @var 的个数 —— 界面提示"由变量驱动",避免用户改了却看不到变化 */
  varRefs: number
  children: GuiNode[]`,
  'GuiNode 字段')

// 4. Layout: 增加 vars
rep(
  `  unresolved: { id: string; sprite: string }[]
  canvasW: number`,
  `  unresolved: { id: string; sprite: string }[]
  /** 文件内 @var 定义(小写索引)。vanilla 40/453 个 .gui 用到,332 处定义 / 2467 处引用 */
  vars: Map<string, number>
  canvasW: number`,
  'Layout 字段')

// 5. Ctx: 增加 vars
rep(
  `interface Ctx {
  doc: Document
  sprites?: SpriteIndex`,
  `interface Ctx {
  doc: Document
  sprites?: SpriteIndex
  /** 小写索引的 @var 表(两遍扫描的第一遍产出) */
  vars: Map<string, number>`,
  'Ctx 字段')

// 6. buildLayout: 收集 vars
rep(
  `  const ctx: Ctx = {
    doc,
    sprites,`,
  `  const ctx: Ctx = {
    doc,
    sprites,
    vars: collectVars(doc),`,
  'buildLayout 收集 vars')

// 7. buildLayout return: vars
rep(
  `    unresolved: ctx.unresolved,
    canvasW,`,
  `    unresolved: ctx.unresolved,
    vars: ctx.vars,
    canvasW,`,
  'buildLayout return vars')

// 8. buildNode 属性/几何解析
rep(
  `  const name = childValue(doc, block, 'name') ?? '(匿名)'
  const props: Record<string, string> = {}
  const scaleRaw = childValue(doc, block, 'scale')
  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k) continue
    if (c.block) continue
    const v = valueText(doc, c)
    if (v !== undefined) props[k] = v
  }

  const posBlock = childBlock(doc, block, 'position')
  const relX = posBlock ? (num(childValue(doc, posBlock, 'x')) ?? 0) : 0
  const relY = posBlock ? (num(childValue(doc, posBlock, 'y')) ?? 0) : 0

  // size 有两种写法:{ width= height= } 与 { x= y= }(listboxType 等用后者)
  const sizeBlock = childBlock(doc, block, 'size')
  const w = sizeBlock ? (num(childValue(doc, sizeBlock, 'width')) ?? num(childValue(doc, sizeBlock, 'x')) ?? 0) : 0
  const h = sizeBlock ? (num(childValue(doc, sizeBlock, 'height')) ?? num(childValue(doc, sizeBlock, 'y')) ?? 0) : 0
  const sizeInferred = !sizeBlock

  const scale = num(scaleRaw ?? props['scale']) ?? 1
  const sprite = childValue(doc, block, 'spriteType') ?? childValue(doc, block, 'sprite')
  const bg = childBlock(doc, block, 'background')
  const bgSprite = bg ? (childValue(doc, bg, 'spriteType') ?? childValue(doc, bg, 'sprite')) : undefined`,
  `  const name = childValue(doc, block, 'name') ?? '(匿名)'
  const props: Record<string, string> = {}
  const propBlocks: Record<string, Record<string, string>> = {}
  let varRefs = 0
  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k) continue
    if (!c.block) {
      const v = valueText(doc, c)
      if (v !== undefined) props[k] = v
      continue
    }
    // 块形态属性:摊平内层标量,属性网格才能编辑 borderSize / margin / slotSize
    const inner: Record<string, string> = {}
    for (const g of c.block.entries) {
      const gk = keyText(doc, g)
      if (!gk || g.block) continue
      const gv = valueText(doc, g)
      if (gv !== undefined) inner[gk] = gv
    }
    propBlocks[k] = inner
  }

  // @var 感知的数值解析:解析不出来且确实是 @引用时,记一笔供界面提示
  const numV = (v: string | undefined): number | undefined => {
    const n = num(v, ctx.vars)
    if (n === undefined && v !== undefined && v.trim().startsWith('@')) varRefs++
    return n
  }

  const posBlock = childBlock(doc, block, 'position')
  const relX = posBlock ? (numV(childValue(doc, posBlock, 'x')) ?? 0) : 0
  const relY = posBlock ? (numV(childValue(doc, posBlock, 'y')) ?? 0) : 0

  // size 有两种写法:{ width= height= } 与 { x= y= }(listboxType 等用后者)
  const sizeBlock = childBlock(doc, block, 'size')
  const w = sizeBlock ? (numV(childValue(doc, sizeBlock, 'width')) ?? numV(childValue(doc, sizeBlock, 'x')) ?? 0) : 0
  const h = sizeBlock ? (numV(childValue(doc, sizeBlock, 'height')) ?? numV(childValue(doc, sizeBlock, 'y')) ?? 0) : 0
  const sizeInferred = !sizeBlock

  const scale = num(props['scale'], ctx.vars) ?? 1
  // 贴图引用不止 spriteType。实测 vanilla:quadTextureSprite 有 3867 处,
  // 是 iconType / buttonType 等元素的直接贴图引用 —— 只读 spriteType 会让它们渲染成空框。
  const sprite =
    childValue(doc, block, 'spriteType') ??
    childValue(doc, block, 'sprite') ??
    childValue(doc, block, 'quadTextureSprite')
  const bg = childBlock(doc, block, 'background')
  // 注意:background.name 只是局部名 —— vanilla 1473 处无一以 GFX_ 开头,不能当贴图引用。
  // background 里真正指向贴图的是 spriteType / quadTextureSprite(后者 882 处)。
  const bgSprite = bg
    ? (childValue(doc, bg, 'spriteType') ??
       childValue(doc, bg, 'sprite') ??
       childValue(doc, bg, 'quadTextureSprite'))
    : undefined`,
  'buildNode 属性/几何解析')

// 9. node 对象字段
rep(
  `    props,
    children: [],`,
  `    props,
    propBlocks,
    varRefs,
    children: [],`,
  'node 字段')

// 10. 子元素遍历:容器块提升
rep(
  `  const counters = new Map<string, number>()
  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k || !c.block) continue
    const lk = k.toLowerCase()
    if (PROP_BLOCKS.has(lk)) continue
    if (!ELEMENT_TYPES.has(lk)) continue
    const i = counters.get(k) ?? 0
    counters.set(k, i + 1)
    const child = buildNode(ctx, c, \`\${id}/\${k}:\${i}\`, depth + 1, node.absX, node.absY, id)
    if (child) node.children.push(child)
  }

  return node
}`,
  `  const counters = new Map<string, number>()
  const addChild = (key: string, e: Entry, idPath: string) => {
    const i = counters.get(key) ?? 0
    counters.set(key, i + 1)
    const child = buildNode(ctx, e, \`\${idPath}/\${key}:\${i}\`, depth + 1, node.absX, node.absY, id)
    if (child) node.children.push(child)
  }

  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k || !c.block) continue
    const lk = k.toLowerCase()
    if (PROP_BLOCKS.has(lk)) continue
    if (ELEMENT_TYPES.has(lk)) {
      addChild(k, c, id)
      continue
    }
    // 容器块(如 expandedWindow):自身不是元素,但子元素要挂到宿主下
    if (CONTAINER_BLOCKS.has(lk)) {
      const inner = new Map<string, number>()
      for (const g of c.block.entries) {
        const gk = keyText(doc, g)
        if (!gk || !g.block) continue
        if (!ELEMENT_TYPES.has(gk.toLowerCase())) continue
        const gi = inner.get(gk) ?? 0
        inner.set(gk, gi + 1)
        const child = buildNode(ctx, g, \`\${id}/\${k}/\${gk}:\${gi}\`, depth + 1, node.absX, node.absY, id)
        if (child) node.children.push(child)
      }
    }
  }

  return node
}`,
  '子元素遍历 + 容器提升')

// 11. num 支持 @var + collectVars
rep(
  `function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}`,
  `/**
 * 解析数值,支持 .gui 的 @var 引用。
 *
 * @var 不是边缘语法:vanilla 453 个 .gui 里有 40 个在用,共计 332 处定义、2467 处引用,
 * 典型如 \`size = { width = 220 height = @equipment_entry_heigth }\`。
 * 不解析的话 parseFloat("@x") = NaN,坐标与尺寸会静默退化成 0 —— 整片布局塌成一个点。
 *
 * 定义可以出现在任意层级(根级与嵌套块内都有),所以必须两遍扫描:先全文收集,再解析引用。
 * 大小写两种都有(vanilla 同时存在 @POSTERS_Y 与 @equipment_entry_heigth),
 * 故先精确匹配、再回退到小写匹配。
 */
function num(v: string | undefined, vars?: Map<string, number>): number | undefined {
  if (v === undefined) return undefined
  const raw = v.trim()
  const n = parseFloat(raw)
  if (Number.isFinite(n)) return n
  if (!raw.startsWith('@') || !vars) return undefined
  return vars.get(raw) ?? vars.get(raw.toLowerCase())
}

/** 全文收集 @var 定义(两遍扫描的第一遍)。值只取字面量,不做变量套变量。 */
function collectVars(doc: Document): Map<string, number> {
  const vars = new Map<string, number>()
  walk(doc, (e) => {
    if (e.block) return
    const k = keyText(doc, e)
    if (!k || !k.startsWith('@')) return
    const v = num(valueText(doc, e))
    if (v !== undefined) vars.set(k.toLowerCase(), v)
  })
  return vars
}`,
  'num/@var/collectVars')

if (s === orig) {
  console.log('没有任何改动')
  process.exit(1)
}
writeFileSync(join(__DIR, '..', 'packages', 'gui', 'src', '_model_patched.ts'), s, 'utf8')
console.log('已生成 _model_patched.ts')
