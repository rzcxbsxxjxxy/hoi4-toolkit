/**
 * common/ 全目录 CLI:统计 / 覆盖度 / 抽样 / 查找 / 自动发现新目录 / 采纳扩展
 *
 *   node packages/cli/src/common.ts stats     总览
 *   node packages/cli/src/common.ts coverage   哪些目录有规则、哪些没有
 *   node packages/cli/src/common.ts kinds      各定义种类的数量
 *   node packages/cli/src/common.ts sample --dir ideas   抽几个 id 看取得对不对
 *   node packages/cli/src/common.ts find GER_focus_army  查定义在哪
 *   node packages/cli/src/common.ts discover   扫描无规则的目录并推断候选规则
 *   node packages/cli/src/common.ts adopt      把候选规则写入 common-rules.extra.json
 *   node packages/cli/src/common.ts dangling   图标/本地化悬空检查
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCommonIndex, loadExtraRules, type RootSpec } from '../../engine/src/common-index.ts'
import { COMMON_RULES, EXTRA_RULES_FILE, type CommonRule } from '../../engine/src/common-rules.ts'
import { probeDir, inferRules, describeProbe } from '../../engine/src/common-discover.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'stats'

const roots: RootSpec[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) roots.push({ name: `root${roots.length}`, path: args[i + 1] })
}
if (!roots.length) {
  roots.push({ name: 'vanilla', path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV' })
  roots.push({ name: 'KR', path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605' })
  roots.push({ name: 'RT56', path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/820260968' })
}
const DEFAULT_ROOT = roots[0]

function flag(n: string): string | undefined {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
function has(n: string): boolean {
  return args.includes(n)
}

const extra = loadExtraRules(flag('--extra'), roots)
const idx = buildCommonIndex(roots, { extraRules: extra })

if (cmd === 'stats') {
  console.log('=== common/ 全目录索引 ===')
  console.log(`root          ${roots.length} 个:${roots.map((r) => r.name).join(' / ')}`)
  console.log(`扫描文件      ${idx.stats.files}`)
  console.log(`触及目录      ${idx.stats.dirs}`)
  console.log(`提取定义      ${idx.stats.defs}`)
  console.log(`定义种类      ${idx.stats.kinds}`)
  console.log(`重复定义      ${idx.stats.dup}(同名多份,mod 覆盖 vanilla 属正常)`)
  if (extra.length) console.log(`外挂规则      ${extra.length} 条`)
  if (idx.errors.length) console.log(`解析失败      ${idx.errors.length} 个文件`)
  console.log(`图标/本地化引用 ${idx.refs.length}`)
} else if (cmd === 'coverage') {
  const c = idx.coverage
  console.log('=== 覆盖度 ===')
  console.log(`有规则的目录 ${c.ruled.size}  无规则的目录 ${c.unruled.length}\n`)
  const rows = [...c.fileCount.entries()].sort((a, b) => b[1] - a[1])
  console.log('目录                                     文件数   规则')
  for (const [d, n] of rows) {
    const r = c.ruled.get(d)
    console.log(`  ${d.padEnd(38)} ${String(n).padStart(6)}   ${r ? `${r} 条` : '— 未覆盖'}`)
  }
  if (c.unruled.length) {
    console.log(`\n未覆盖目录(${c.unruled.length}):`)
    for (const d of c.unruled) console.log(`  ${d}  (${c.fileCount.get(d)} 文件)`)
  }
  if (c.missing.length) console.log(`\n有规则但目录不存在:${c.missing.join(', ')}`)
} else if (cmd === 'kinds') {
  const byKind = new Map<string, number>()
  for (const d of idx.defs) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1)
  console.log('=== 定义种类 ===')
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${n}`)
  }
} else if (cmd === 'sample') {
  const dir = flag('--dir')
  if (!dir) {
    console.error('需要 --dir <目录名>')
    process.exit(1)
  }
  const hit = idx.defs.filter((d) => d.file.includes(`common/${dir}/`))
  console.log(`=== common/${dir} 抽样 (共 ${hit.length} 个定义) ===`)
  const seen = new Set<string>()
  let n = 0
  for (const d of hit) {
    if (seen.has(d.kind + d.id)) continue
    seen.add(d.kind + d.id)
    if (n++ >= 12) break
    console.log(`  ${d.kind.padEnd(28)} ${d.id}${d.scope ? `   [scope=${d.scope}]` : ''}   ${d.file}:${d.line}`)
  }
} else if (cmd === 'find') {
  const name = args[1]
  if (!name) {
    console.error('用法: common.ts find <id>')
    process.exit(1)
  }
  const hits: { kind: string; id: string; file: string; line: number; root: number }[] = []
  for (const [k, l] of idx.byId) {
    const id = k.slice(k.indexOf(':') + 1)
    if (id === name || k === name) for (const d of l) hits.push(d)
  }
  if (!hits.length) {
    console.log(`未找到 ${name}`)
  } else {
    console.log(`=== ${name} (${hits.length} 处) ===`)
    for (const h of hits.slice(0, 20)) {
      console.log(`  ${h.kind.padEnd(28)} ${roots[h.root].name}:${h.file}:${h.line}`)
    }
  }
} else if (cmd === 'discover') {
  console.log('=== 自动发现:扫描没有规则的 common 目录 ===\n')
  const targets = idx.coverage.unruled
  if (!targets.length) {
    console.log('所有存在的目录都已有规则。')
  } else {
    const found: CommonRule[] = []
    for (const d of targets) {
      const p = probeDir(roots, d)
      if (!p) continue
      console.log(`── common/${d}`)
      console.log(`   ${describeProbe(p)}`)
      const rules = inferRules(p)
      if (!rules.length) {
        console.log('   信息不足,需人工补规则\n')
        continue
      }
      found.push(...rules)
      console.log(`   候选: ${JSON.stringify(rules[0])}\n`)
    }
    if (found.length && has('--write')) {
      const p = join(DEFAULT_ROOT.path, EXTRA_RULES_FILE)
      writeFileSync(p, JSON.stringify(found, null, 2) + '\n', 'utf8')
      console.log(`已写入 ${found.length} 条候选规则 → ${p}`)
      console.log('请人工核对后使用;确认无误后建议合并进 common-rules.ts。')
    } else if (found.length) {
      console.log(`共 ${found.length} 条候选规则。加 --write 写入 ${EXTRA_RULES_FILE}`)
    }
  }
} else if (cmd === 'adopt') {
  // 采纳:把外挂规则里缺失/无效的挑出来,或直接把内置规则导出成模板
  const dir = flag('--dir')
  const out = flag('--out') ?? join(DEFAULT_ROOT.path, EXTRA_RULES_FILE)
  const rules = dir ? COMMON_RULES.filter((r) => r.dir === dir) : COMMON_RULES
  if (!rules.length) {
    console.error(`没有 ${dir ?? '任何'} 的规则`)
    process.exit(1)
  }
  const prev: CommonRule[] = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as CommonRule[]) : []
  const merged = [...prev]
  let added = 0
  for (const r of rules) {
    if (merged.some((x) => x.dir === r.dir && x.kind === r.kind)) continue
    merged.push(r)
    added++
  }
  writeFileSync(out, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  console.log(`已写入 ${out}(新增 ${added} 条,共 ${merged.length} 条)`)
} else if (cmd === 'dangling') {
  console.log('=== 悬空引用检查(图标 / 本地化)===')
  console.log(`共抽取引用 ${idx.refs.length} 条`)
  const byTarget = new Map<string, number>()
  for (const r of idx.refs) byTarget.set(r.target, (byTarget.get(r.target) ?? 0) + 1)
  for (const [t, n] of byTarget) console.log(`  ${t}: ${n}`)
  console.log('\n注:要判定是否真的悬空,需要与 interface/*.gfx 与 localisation/*.yml 交叉比对,')
  console.log('可用 links.ts / loc.ts 的索引结果作为基准库。')
} else {
  console.error(`未知命令: ${cmd}`)
  console.error('可用: stats / coverage / kinds / sample / find / discover / adopt / dangling')
  process.exit(1)
}
