/**
 * 规格提取 CLI
 *   node src/build.ts <docsDir> [outDir]
 *
 * 产出:
 *   effects.json / triggers.json / modifiers.json  原始条目
 *   scope-index.json                               作用域倒排索引(补全用)
 *   spec-summary.json                              统计摘要
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseSpecFile,
  buildScopeIndex,
  summarize,
  type SpecDoc,
  type SpecKind,
} from './parse.ts'

const DOCS: [string, SpecKind][] = [
  ['effects_documentation.md', 'effect'],
  ['triggers_documentation.md', 'trigger'],
  ['modifiers_documentation.md', 'modifier'],
]

const docsDir = process.argv[2] ?? process.env.HOI4_DOCS ?? ''
if (!docsDir) {
  console.error('请提供 HOI4 文档目录:')
  console.error('  node build.ts <docsDir>   或   设置环境变量 HOI4_DOCS(指向含 effects_documentation.md 等文件的目录)')
  process.exit(1)
}
const outDir = process.argv[3] ?? join(import.meta.dirname, '..', '..', '..', 'spec')

mkdirSync(outDir, { recursive: true })

const docs: SpecDoc[] = []
for (const [file, kind] of DOCS) {
  const src = readFileSync(join(docsDir, file), 'utf8')
  const doc = parseSpecFile(src, kind, file)
  docs.push(doc)
  writeFileSync(join(outDir, `${kind}s.json`), JSON.stringify(doc.entries, null, 0), 'utf8')
}

const index = buildScopeIndex(docs)
const stats = summarize(docs, index)

writeFileSync(
  join(outDir, 'scope-index.json'),
  JSON.stringify(
    {
      byScope: Object.fromEntries([...index.byScope.entries()].map(([k, v]) => [k, [...v].sort()])),
      scopes: index.scopes,
    },
    null,
    0,
  ),
  'utf8',
)
writeFileSync(join(outDir, 'spec-summary.json'), JSON.stringify(stats, null, 2), 'utf8')

/* ───────── 控制台报告 ───────── */
console.log('════════ 规格库提取 ════════')
console.log(`源目录      ${docsDir}`)
console.log(`输出目录    ${outDir}\n`)

console.log('── 文档 ──')
for (const d of stats.docs) {
  const flag = d.suspicious ? `  ⚠ 可疑 ${d.suspicious}` : ''
  console.log(`  ${d.file.padEnd(36)} ${String(d.entries).padStart(5)} 条  (章节 ${d.sections})${flag}`)
}
console.log(`  ${'合计'.padEnd(34)} ${String(stats.total).padStart(5)} 条\n`)

console.log('── 按类型 ──')
for (const [k, v] of Object.entries(stats.byKind)) console.log(`  ${k.padEnd(12)} ${v}`)

console.log('\n── 作用域覆盖(条目数 Top 15)──')
for (const [s, n] of stats.topScopes.slice(0, 15)) {
  console.log(`  ${s.padEnd(24)} ${String(n).padStart(5)}`)
}
console.log(`\n  作用域总数: ${stats.scopes.length}`)

console.log('\n── 可疑条目(未提取到任何字段)──')
let shown = 0
for (const d of docs) {
  for (const s of d.suspicious.slice(0, 6)) {
    console.log(`  ${s}`)
    shown++
  }
}
if (!shown) console.log('  无')

/* ───────── 抽样验证:随机看 3 条 ───────── */
console.log('\n── 抽样 ──')
for (const d of docs) {
  const e = d.entries[Math.floor(d.entries.length / 2)]
  if (!e) continue
  console.log(`  [${e.kind}] ${e.name}`)
  if (e.scopes.length) console.log(`      scopes   : ${e.scopes.join(', ')}`)
  if (e.targets.length) console.log(`      targets  : ${e.targets.join(', ')}`)
  if (e.decimals !== undefined) console.log(`      decimals : ${e.decimals}`)
  if (e.categories?.length) console.log(`      categorie: ${e.categories.join(', ')}`)
  if (e.placeholders?.length) console.log(`      占位符   : ${e.placeholders.join(', ')}`)
  if (e.description) console.log(`      描述     : ${e.description.split('\n')[0].slice(0, 70)}`)
}
