/**
 * events / history / localisation 定义提取的运行器
 *
 *   node src/domains.ts <模组或游戏根目录>
 *   例:node src/domains.ts "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV"
 *
 * 独立入口原因:hoi4kit.ts 被进程独占无法写入,解锁后合并为一个命令。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '../../parser/src/index.ts'
import type { Definition } from '../../engine/src/indexer.ts'
import { EXTRA_DEF_RULES, locDefinitions, oobReferences, type Ref } from '../../engine/src/domains.ts'
import { parseLocYml } from '../../engine/src/loc.ts'

const root = process.argv[2]
/** 基准库(vanilla)。模组是叠加层,OOB / sprite 等可能定义在上游 */
const baseFlag = process.argv.indexOf('--base')
const baseRoot = baseFlag >= 0 ? process.argv[baseFlag + 1] : undefined
if (!root) {
  console.log('用法: node domains.ts <模组或游戏根目录> [--base <vanilla 根目录>]')
  process.exit(1)
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let items: string[]
    try {
      items = readdirSync(cur)
    } catch {
      continue
    }
    for (const n of items) {
      const p = join(cur, n)
      let st: { isDirectory(): boolean }
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (exts.some((x) => n.toLowerCase().endsWith(x))) out.push(p)
    }
  }
  return out.sort()
}

const sub = (name: string) => join(root, name)
const defs: Definition[] = []
const refs: Ref[] = []
let scannedTxt = 0
let scannedYml = 0

/* ── events 与 history ── */
const txtDirs = ['events', join('history', 'countries'), join('history', 'states'), join('history', 'units')]
for (const d of txtDirs) {
  const abs = sub(d)
  for (const p of walk(abs, ['.txt'])) {
    let doc
    try {
      doc = parse(readFileSync(p, 'utf8'))
    } catch {
      continue
    }
    scannedTxt++
    const rel = relative(root, p)
    for (const rule of EXTRA_DEF_RULES) {
      if (rule.dir.test(rel) || rule.dir.test(p)) {
        try {
          defs.push(...rule.extract(doc, rel))
        } catch (e) {
          console.error(`  提取 ${rule.kind} 失败: ${rel} — ${e}`)
        }
      }
    }
    if (/history[\\/]countries[\\/]/i.test(rel) || /history[\\/]countries[\\/]/i.test(p)) {
      refs.push(...oobReferences(doc, rel))
    }
  }
}

/* ── localisation ── */
const ymlFiles = walk(sub('localisation'), ['.yml'])
const locResults = ymlFiles.map((p) => parseLocYml(readFileSync(p, 'utf8'), relative(root, p)))
scannedYml = ymlFiles.length
const locDefs = locDefinitions(locResults)

/* ───────── 报告 ───────── */
console.log('════════ events / history / localisation 定义提取 ════════')
console.log(`根目录        ${root}`)
console.log(`扫描 .txt     ${scannedTxt} 个(events + history)`)
console.log(`扫描 .yml     ${scannedYml} 个(localisation)`)

console.log('\n── 定义符号统计 ──')
const byKind = new Map<string, Definition[]>()
for (const d of defs) {
  const arr = byKind.get(d.kind)
  if (arr) arr.push(d)
  else byKind.set(d.kind, [d])
}
for (const [k, arr] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(20)} ${arr.length.toLocaleString()}`)
}
console.log(`  ${'loc_key'.padEnd(20)} ${locDefs.length.toLocaleString()}`)
console.log(`  ${'合计'.padEnd(19)} ${(defs.length + locDefs.length).toLocaleString()}`)

/* ── 重复定义 ── */
console.log('\n── 重复定义(同一 kind + scope + id 出现多次)──')
const dup = new Map<string, Definition[]>()
for (const d of [...defs]) {
  // 有 scope 的按 scope 分组(如 division_template 属于某个 OOB),避免跨作用域误判
  const k = `${d.kind}:${d.scope ?? '-'}:${d.id}`
  const arr = dup.get(k) ?? []
  arr.push(d)
  dup.set(k, arr)
}
const dupList = [...dup.entries()].filter(([, v]) => v.length > 1)
console.log(`  ${dupList.length} 组`)
for (const [k, arr] of dupList.slice(0, 8)) {
  console.log(`  ${k}  ×${arr.length}`)
  for (const d of arr.slice(0, 3)) console.log(`      ${d.file}:${d.line}`)
}

/* ── 命名空间:声明了但没用 / 用了但没声明 ── */
console.log('\n── 事件命名空间 ──')
const declared = new Set(defs.filter((d) => d.kind === 'event_namespace').map((d) => d.id))
const used = new Set(defs.filter((d) => d.kind === 'event' && d.scope).map((d) => d.scope!))
const unused = [...declared].filter((n) => !used.has(n))
const undeclared = [...used].filter((n) => !declared.has(n))
console.log(`  声明 ${declared.size} 个 / 被使用 ${used.size} 个`)
console.log(`  声明但未使用: ${unused.length} 个${unused.length ? '  ' + unused.slice(0, 5).join(', ') : ''}`)
console.log(`  使用但未声明: ${undeclared.length} 个${undeclared.length ? '  ' + undeclared.slice(0, 5).join(', ') : ''}`)

/* ── OOB 交叉校验 ── */
console.log('\n── OOB 交叉校验 ──')
const ownOob = new Set(defs.filter((d) => d.kind === 'oob').map((d) => d.id))
// 上游定义:模组是叠加层,OOB 可能在 vanilla 里
const baseOob = new Set<string>()
if (baseRoot) {
  for (const p of walk(join(baseRoot, 'history', 'units'), ['.txt'])) baseOob.add(p.replace(/^.*[\\/]/, '').replace(/\.txt$/i, ''))
}
const resolvedViaBase = refs.filter((r) => !ownOob.has(r.id) && baseOob.has(r.id))
const missingOob = refs.filter((r) => !ownOob.has(r.id) && !baseOob.has(r.id))
console.log(`  本模组定义的 OOB:       ${ownOob.size} 个`)
if (baseRoot) console.log(`  上游定义的 OOB:         ${baseOob.size} 个`)
console.log(`  history/countries 引用: ${refs.length} 处(set_oob ${refs.filter((r) => r.via === 'set_oob').length} / oob ${refs.filter((r) => r.via === 'oob').length})`)
if (baseRoot) {
  console.log(`  依赖上游解析:           ${resolvedViaBase.length} 处 (${((resolvedViaBase.length / refs.length) * 100).toFixed(1)}%)`)
}
console.log(`  引用了但不存在:         ${missingOob.length} 处`)
for (const r of [...new Map(missingOob.map((x) => [x.id, x])).values()].slice(0, 10)) {
  console.log(`      ${r.id}  ← ${r.file}:${r.line} (${r.via})`)
}

/* ── 抽样 ── */
console.log('\n── 抽样 ──')
for (const k of ['event', 'state', 'country_history', 'division_template', 'oob']) {
  const arr = byKind.get(k)
  if (!arr?.length) continue
  const d = arr[Math.floor(arr.length / 2)]
  console.log(`  [${k}] ${d.id}${d.scope ? `   scope=${d.scope}` : ''}`)
  console.log(`      ${d.file}:${d.line}`)
}
const lk = locDefs[Math.floor(locDefs.length / 2)]
if (lk) console.log(`  [loc_key] ${lk.id}   scope=${lk.scope}\n      ${lk.file}:${lk.line}`)
