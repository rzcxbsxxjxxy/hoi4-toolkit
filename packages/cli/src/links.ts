/**
 * 跨域引用图 CLI。
 *
 *   node links.ts stats [--root <path>]...        图谱统计 + 悬空概览
 *   node links.ts dangling [--root <path>]...     列出悬空引用(按类型分组)
 *   node links.ts refs <名字> [--kind ...]        查某个符号被谁引用
 *   node links.ts overrides [--root <path>]...    列出会覆盖 .gui 坐标的 properties
 *   node links.ts rename <名字> <新名> [--apply]  跨文件重命名(默认 dry-run)
 */

import {
  buildLinkGraph,
  refsOf,
  defsOf,
  positionOverrides,
  readFile,
  symKey,
  type LinkRoot,
  type SymKind,
  type SymRef,
} from '../../engine/src/links.ts'
import { planRename, type FilePatch } from '../../engine/src/rename.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'stats'
const roots: LinkRoot[] = []
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--root') {
    const p = args[++i]
    roots.push({ name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p })
  } else if (args[i] === '--name') {
    const p = args[++i]
    roots.push({ name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p })
  }
}
if (!roots.length) {
  roots.push({
    name: 'vanilla',
    path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV',
  })
  roots.push({
    name: 'KR',
    path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605',
  })
  roots.push({
    name: 'RT56',
    path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/820260968',
  })
}

const graph = buildLinkGraph(roots)

function fmtRef(r: SymRef): string {
  const loc = `${graph.roots[r.root].name}:${r.file}:${r.line}`
  const suf = r.suffix ? ` [后缀${r.suffix}]` : ''
  return `  ${r.kind.padEnd(18)} ${loc}${suf}  ← ${r.ctx}  ·  ${r.path.join(' > ')}`
}

if (cmd === 'stats') {
  const s = graph.stats
  console.log('════════ 跨域引用图 ════════')
  for (const r of graph.roots) console.log(`  ${r.name}  ${r.path}`)
  console.log(`\n扫描文件 ${s.files} 个,耗时 ${s.ms} ms`)
  console.log(`定义 ${s.defs} 条 / 引用 ${s.refs} 条 / 悬空 ${s.dangling} 条\n`)
  const byDef = new Map<string, number>()
  for (const d of graph.defs) byDef.set(d.kind, (byDef.get(d.kind) ?? 0) + 1)
  console.log('── 定义 ──')
  for (const [k, v] of [...byDef].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(7)}  ${k}`)
  console.log('\n── 引用 ──')
  for (const [k, v] of [...Object.entries(s.byKind)].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(7)}  ${k}`)
  }
  const dangBy = new Map<string, number>()
  for (const d of graph.dangling) {
    const k = `${d.target}/${d.kind}`
    dangBy.set(k, (dangBy.get(k) ?? 0) + 1)
  }
  console.log('\n── 悬空(引用了不存在的符号)──')
  for (const [k, v] of [...dangBy].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(7)}  ${k}`)
} else if (cmd === 'dangling') {
  const lim = parseInt(flag('--limit') ?? '40', 10)
  const kinds = flag('--kind')
  const list = graph.dangling.filter((r) => !kinds || r.target === kinds)
  console.log(`悬空 ${list.length} 条${kinds ? ` (target=${kinds})` : ''}`)
  for (const r of list.slice(0, lim)) console.log(fmtRef(r))
  if (list.length > lim) console.log(`  … 还有 ${list.length - lim} 条`)
} else if (cmd === 'refs') {
  const name = args[1]
  if (!name) {
    console.error('用法: links.ts refs <名字> [--kind gui_element]')
    process.exit(1)
  }
  const kind = (flag('--kind') ?? 'gui_element') as SymKind
  const defs = defsOf(graph, kind, name)
  console.log(`定义 ${defs.length} 处:`)
  for (const d of defs) console.log(`  ${graph.roots[d.root].name}:${d.file}:${d.line}  ${d.kind} ${d.name}${d.detail ? ` (${d.detail})` : ''}`)
  const refs = refsOf(graph, kind, name)
  console.log(`\n引用 ${refs.length} 处:`)
  for (const r of refs) console.log(fmtRef(r))
  const ov = positionOverrides(graph, name)
  if (ov.length) {
    console.log(`\n⚠ 位置被 scripted_gui 覆盖 —— 在 .gui 里拖这个元素不会生效:`)
    for (const r of ov) console.log(`  x=${r.override?.x ?? '-'} y=${r.override?.y ?? '-'}  @ ${graph.roots[r.root].name}:${r.file}:${r.line}`)
  }
} else if (cmd === 'overrides') {
  const list = graph.refs.filter(
    (r) => r.override?.x !== undefined || r.override?.y !== undefined,
  )
  console.log(`位置覆盖 ${list.length} 处(.gui 里的 position 会被这些值改写):`)
  for (const r of list) {
    console.log(`  ${r.name.padEnd(42)} x=${String(r.override?.x ?? '-').padEnd(8)} y=${String(r.override?.y ?? '-').padEnd(8)} @ ${graph.roots[r.root].name}:${r.file}:${r.line}  (${r.ctx})`)
  }
} else if (cmd === 'rename') {
  const from = args[1]
  const to = args[2]
  if (!from || !to) {
    console.error('用法: links.ts rename <原名> <新名> [--kind gui_element] [--apply]')
    process.exit(1)
  }
  const kind = (flag('--kind') ?? 'gui_element') as SymKind
  const defs = defsOf(graph, kind, from)
  if (!defs.length) {
    console.error(`找不到定义: ${symKey(kind, from)}`)
    process.exit(1)
  }
  const apply = args.includes('--apply')
  const patches = planRename(graph, defs[0], to)
  console.log(`重命名 ${kind} "${from}" → "${to}"`)
  console.log(`涉及 ${patches.length} 个文件,共 ${patches.reduce((s, p) => s + p.details.length, 0)} 处改动\n`)
  for (const p of patches) {
    console.log(`── ${graph.roots[p.root].name}:${p.file}`)
    for (const d of p.details) console.log(`   L${d.line}  ${d.from} → ${d.to}   (${d.kind}/${d.slot})`)
    for (const w of p.warnings) console.log(`   ⚠ ${w}`)
    console.log(`   守卫: ${p.guard.ok ? 'OK' : '失败'} — ${p.guard.message}`)
    if (!p.guard.ok) console.log(p.diff)
  }
  if (!apply) {
    console.log('\n(dry-run,加 --apply 才会写盘)')
  } else {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const p of patches) {
      if (!p.guard.ok) {
        console.log(`跳过(守卫失败): ${p.file}`)
        continue
      }
      const root = graph.roots[p.root]
      const backupDir = join(root.path, '.hoi4gui', 'backups', stamp)
      const abs = join(root.path, p.file)
      mkdirSync(dirname(join(backupDir, p.file)), { recursive: true })
      writeFileSync(join(backupDir, p.file), readFile(root, p.file), 'utf8')
      writeFileSync(abs, p.text, 'utf8')
      console.log(`已写入 ${root.name}:${p.file}(备份 ${stamp})`)
    }
  }
} else {
  console.error(`未知命令: ${cmd}`)
  process.exit(1)
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
