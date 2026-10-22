/**
 * 国策树 CLI: stats(全局统计) / trees(列出树) / show(画一棵树的 ASCII 草图) / lint(查错)
 *
 * 用法:
 *   node packages/cli/src/focus.ts stats  [--root <dir>]...
 *   node packages/cli/src/focus.ts trees  [--root <dir>]... [--tag GER]
 *   node packages/cli/src/focus.ts show <treeId> [--root <dir>]...
 *   node packages/cli/src/focus.ts lint  [--root <dir>]... [--tree <id>]
 */
import { join } from 'node:path'
import { buildFocusGraph, treeNodes } from '../../focus/src/model.ts'
import { lintFocus, summarize } from '../../focus/src/lint.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'stats'

const roots: { name: string; path: string }[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) {
    roots.push({ name: `root${roots.length}`, path: args[i + 1] })
  }
}
if (!roots.length) {
  roots.push({ name: 'vanilla', path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV' })
  roots.push({
    name: 'KR',
    path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605',
  })
  roots.push({
    name: 'RT56',
    path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/820260968',
  })
}

function flag(n: string): string | undefined {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}

const g = buildFocusGraph(roots)

if (cmd === 'stats') {
  let continuous = 0
  let withRel = 0
  let withOffset = 0
  let mutex = 0
  let icons = new Set<string>()
  for (const n of g.nodes.values()) {
    if (n.continuous) continuous++
    if (n.rel) withRel++
    if (n.offset) withOffset++
    if (n.mutex.length) mutex++
    icons.add(n.icon)
  }
  console.log(`国策树 ${g.trees.length} 棵`)
  console.log(`国策定义 ${g.nodes.size} 个`)
  console.log(`  相对坐标(relative_position_id) ${withRel}`)
  console.log(`  条件偏移(offset)               ${withOffset}`)
  console.log(`  连续国策(continue/cancel_if_invalid) ${continuous}`)
  console.log(`  有互斥(mutually_exclusive)      ${mutex}`)
  console.log(`  不同图标 ${icons.size} 种`)
  console.log(`\n坐标环 ${g.cycles.length} 处`)
  for (const c of g.cycles.slice(0, 5)) console.log(`  ${c.join(' → ')}`)
  console.log(`\nrelative_position_id 悬空 ${g.danglingRel.length} 处`)
  for (const d of g.danglingRel.slice(0, 8)) console.log(`  ${d.id} → ${d.rel}  (${d.file}:${d.line})`)
  console.log(`\n前置/互斥悬空 ${g.danglingLink.length} 处`)
  for (const d of g.danglingLink.slice(0, 8)) console.log(`  ${d.id} ${d.kind} → ${d.target}  (${d.file}:${d.line})`)
} else if (cmd === 'trees') {
  const tag = flag('--tag')
  const list = g.trees.filter((t) => !tag || t.tags.includes(tag))
  console.log(`${list.length} 棵树(tag=${tag ?? '全部'})\n`)
  for (const t of list.slice(0, 60)) {
    console.log(
      `  ${t.id.padEnd(38)} ${String(treeNodes(g, t).length).padStart(4)} 国策  ${t.tags.join(',').padEnd(12)} ${g.roots[t.root].name}${t.default ? '  [default]' : ''}`,
    )
  }
} else if (cmd === 'show') {
  const id = args[1]
  const t = g.byId.get(id ?? '')
  if (!t) {
    console.error(`找不到树 ${id}`)
    process.exit(1)
  }
  const ns = treeNodes(g, t)
  const minX = Math.min(...ns.map((n) => n.ax))
  const maxX = Math.max(...ns.map((n) => n.ax))
  const minY = Math.min(...ns.map((n) => n.ay))
  const maxY = Math.max(...ns.map((n) => n.ay))
  console.log(`树 ${t.id} — ${ns.length} 个国策,坐标 x[${minX}..${maxX}] y[${minY}..${maxY}]`)
  console.log(`文件 ${g.roots[t.root].name}:${t.file}`)
  console.log(`tags ${t.tags.join(',') || '(无)'}  连续国策位 ${t.cfp ? `(${t.cfp.x},${t.cfp.y})` : '-'}`)
  console.log()
  // 稀疏网格:按 5×5 聚合
  const CW = 4
  const CH = 2
  const cols = Math.floor((maxX - minX) / CW) + 1
  const rows = Math.floor((maxY - minY) / CH) + 1
  const grid: string[][] = Array.from({ length: Math.min(rows, 60) }, () => Array(Math.min(cols, 120)).fill(' '))
  for (const n of ns) {
    const r = Math.floor((n.ay - minY) / CH)
    const c = Math.floor((n.ax - minX) / CW)
    if (r < grid.length && c < grid[0].length) grid[r][c] = n.id.slice(0, 1).toUpperCase()
  }
  for (const row of grid) console.log('  ' + row.join(''))
  console.log('\n前 12 个国策(绝对坐标):')
  for (const n of ns.slice(0, 12)) {
    console.log(
      `  (${String(n.ax).padStart(5)},${String(n.ay).padStart(4)})  ${n.id.padEnd(40)} ${n.rel ? `rel=${n.rel}` : ''}${n.mutex.length ? ` mutex=${n.mutex.length}` : ''}`,
    )
  }
} else if (cmd === 'lint') {
  const tid = flag('--tree')
  let hasSprite: ((n: string) => boolean) | undefined
  if (args.includes('--icons')) {
    const { SpriteIndex } = await import('../../gui/src/sprites.ts')
    const si = new SpriteIndex(roots[0].path)
    si.scanAll(roots.map((r) => ({ dir: join(r.path, 'interface'), gameRoot: r.path })))
    hasSprite = (n: string) => si.get(n) !== undefined
    console.log(`已索引 ${si.stats.sprites} 个 sprite(用于 icon 检查)`)
  }
  const issues = lintFocus(g, { tree: tid, hasSprite })
  const byRule = summarize(issues)
  console.log(`\n体检结果 ${issues.length} 条`)
  for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${rule.padEnd(20)} ${n}`)
  const shown = issues.filter((i) => i.severity === 'error' || i.severity === 'warn')
  console.log(`\n需处理 ${shown.length} 条:`)
  for (const i of shown.slice(0, 25)) {
    console.log(`  [${i.severity}] ${i.rule} ${i.tree || '(全局)'}: ${i.message}`)
    if (i.file) console.log(`        ${i.file}:${i.line}`)
  }
  if (tid) {
    const t = g.byId.get(tid)
    if (t) {
      const ns = treeNodes(g, t)
      console.log(`\n树 ${tid}: ${ns.length} 个国策`)
    }
  }
} else {
  console.error(`未知命令 ${cmd}`)
  process.exit(1)
}
