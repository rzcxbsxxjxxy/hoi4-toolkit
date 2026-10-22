/** ★ 科技树渲染回归 —— 完整复刻 tech.js 的渲染逻辑并验证
 *
 * 用法: node --experimental-strip-types verify_tech_layout.ts
 *   (不需要先起 server —— 直接从 engine 建图,和 tech.js 用同一份数据)
 *
 * 复刻点:slotIndex / stackH / 动态 YU / 按可见集归一 / 默认页签+领域
 * 验收判据:
 *   ① 像素级零重叠(区分同槽卡带 vs 跨槽真重叠)
 *   ② 堆叠不超出行距
 *   ③ 默认视图(步兵)一屏可读
 *
 * ⚠ 与 tech.js 的常量必须同步改,否则这个脚本验的不是前端真实行为。
 */
import { buildTechGraph } from '../packages/engine/src/tech.ts'

const VAN = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
const roots = [{ name: 'vanilla', path: VAN }, { name: 'Kaiserreich', path: KR }]
const g = buildTechGraph(roots)
const d = {
  nodes: [...g.nodes.values()].map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    hidden: !!n.hidden,
    folder: n.folder ?? '',
    categories: n.categories,
    posDeclared: n.posDeclared,
  })),
  slots: g.slots,
  categories: g.categories.map((c) => ({ id: c, count: [...g.nodes.values()].filter((n) => n.categories.includes(c)).length })),
  folders: g.folderOrder.map((id) => ({ id, count: [...g.nodes.values()].filter((n) => n.folder === id).length })),
}
console.log(`数据: ${d.nodes.length} 科技 / ${d.slots.length} 组同格 / ${d.folders.length} 页签\n`)

// —— tech.js 常量 ——
const XU = 104
const NW = 88
const NH = 34
const SOCKH = 12
const DEFAULT_AREA = 'infantry_weapons'
const DEFAULT_FOLDER = 'infantry_folder'

// —— 索引(同 tech.js loadGraph)——
const slotIndex = new Map()
for (const sl of d.slots) sl.ids.forEach((id, i) => slotIndex.set(id, { slot: sl, i, n: sl.ids.length }))

const stackH = (si) => (si && si.n > 1 ? NH + (si.n - 1) * SOCKH : NH)

/** 复刻 applyFilter 的核心:筛选 → 归一 → 动态行距 → 槽位合并 */
function layout({ folder = '', area = '', showHidden = false } = {}) {
  let nodes = d.nodes
  if (!showHidden) nodes = nodes.filter((n) => !n.hidden)
  if (folder) nodes = nodes.filter((n) => n.folder === folder)
  if (area) nodes = nodes.filter((n) => (n.categories || []).includes(area))

  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
  }
  const dx = nodes.length ? -minX : 0
  const dy = nodes.length ? -minY : 0

  let deepest = 1
  for (const n of nodes) {
    const s = slotIndex.get(n.id)
    if (s && s.n > deepest) deepest = s.n
  }
  const YU = deepest > 1 ? NH + (deepest - 1) * SOCKH + 14 : 62

  // 槽位 = folder|x,y(同 engine collectSlots)—— 同槽合成一张卡带
  const slots = new Map()
  for (const n of nodes) {
    const k = `${n.folder || ''}|${n.x},${n.y}`
    if (!slots.has(k)) slots.set(k, [])
    slots.get(k).push(n)
  }
  const cards = [...slots.entries()].map(([k, list]) => {
    const n0 = list[0]
    const s = slotIndex.get(list[0].id)
    const n = s ? s.n : 1
    return {
      k,
      x: (n0.x + dx) * XU,
      y: (n0.y + dy) * YU,
      h: n > 1 ? NH + (n - 1) * SOCKH : NH,
      ids: list.map((t) => t.id),
    }
  })
  return { nodes, cards, YU, deepest, dx, dy }
}

/** 卡带间是否真重叠 */
function checkOverlap(cards, label) {
  let bad = 0
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]
      const b = cards[j]
      if (a.x < b.x + NW && b.x < a.x + NW && a.y < b.y + b.h && b.y < a.y + a.h) {
        if (bad < 3) console.log(`      ✗ (${a.x / XU},${a.y}) ${a.k}=[${a.ids.slice(0, 2).join(',')}] ↔ ${b.k}=[${b.ids.slice(0, 2).join(',')}]`)
        bad++
      }
    }
  }
  console.log(`   ${label.padEnd(26)} 卡带 ${String(cards.length).padStart(3)} 张,重叠 ${bad} ${bad === 0 ? '✅' : '❌'}`)
  return bad
}
/** 堆叠是否超出行距 */
function checkSpill(cards, YU, label) {
  const over = cards.filter((c) => c.h > YU)
  const maxH = Math.max(0, ...cards.map((c) => c.h))
  console.log(`   ${label.padEnd(26)} 行距 ${YU}px,最深堆叠 ${maxH}px,超限 ${over.length} ${over.length === 0 ? '✅' : '❌'}`)
  return over.length
}

console.log('════ 默认视图(用户 2026-10:先看步兵) ════')
const def = layout({ folder: DEFAULT_FOLDER, area: DEFAULT_AREA })
console.log(`   页签=${DEFAULT_FOLDER} 领域=${DEFAULT_AREA}`)
console.log(`   可见 ${def.nodes.length} 个科技,归一偏移 dx=${def.dx} dy=${def.dy},行距 ${def.YU}px,最深堆叠 ${def.deepest} 条`)
let fail = 0
fail += checkOverlap(def.cards, '默认(步兵)')
fail += checkSpill(def.cards, def.YU, '默认(步兵)')
{
  const bs = def.cards
  const minX = Math.min(...bs.map((b) => b.x))
  const w = Math.max(...bs.map((b) => b.x)) - minX + NW
  const h = Math.max(...bs.map((b) => b.y + b.h)) - Math.min(...bs.map((b) => b.y))
  const z = Math.min(1200 / (w + 56), 760 / (h + 78), 1.6)
  console.log(`   视野 ${w}×${h} → 缩放 ${z.toFixed(2)} ${z >= 0.55 ? '✅ 可读' : '❌ 太小'}`)
  if (z < 0.55) fail++
  console.log('\n   逐个卡带:')
  for (const b of bs.sort((a, c) => a.y - c.y || a.x - c.x)) {
    console.log(`     px(${String(b.x).padStart(4)},${String(b.y).padStart(4)}) h=${String(b.h).padStart(2)}  ${b.ids.join(' / ')}`)
  }
}

console.log('\n════ 逐页签验收(游戏里一页一页翻) ════')
for (const f of d.folders.slice().sort((a, b) => b.count - a.count)) {
  const L = layout({ folder: f.id })
  if (!L.cards.length) {
    console.log(`   ${f.id.padEnd(26)} (空)`)
    continue
  }
  const bad = checkOverlap(L.cards, f.id)
  const sp = checkSpill(L.cards, L.YU, f.id)
  if (bad || sp) fail++
}

console.log('\n════ 「全部页签」全景(此时跨页签撞格不可避免,应给出提示) ════')
const allL = layout({})
checkOverlap(allL.cards, '全部页签')
console.log('   ↑ 这里有重叠是【符合游戏语义】的:各页签共用 x/y 但不同屏显示。')
console.log('     所以默认视图锁在单页签上,靠胶囊栏翻页,而不是一次全铺。')

console.log(`\n════ 结论:单页签判据失败 ${fail} 项 ${fail === 0 ? '✅ 全通过' : '❌ 需修'} ════`)
process.exit(fail === 0 ? 0 : 1)
