/**
 * 规格查询 —— 面向"写代码时忘了叫什么"这个最高频痛点
 *
 *   node src/query.ts <关键词>          模糊搜名字/描述
 *   node src/query.ts --scope STATE     列出该作用域下所有可用条目
 *   node src/query.ts --scope STATE -k effect
 *   node src/query.ts <名字> --detail   看完整规格(作用域/示例/小数位)
 *
 * 数据来自 spec/ 下由 build.ts 生成的 JSON。
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpecEntry, SpecKind } from './parse.ts'

const here = dirname(fileURLToPath(import.meta.url))
const SPEC = join(here, '..', '..', '..', 'spec')

function load(kind: SpecKind): SpecEntry[] {
  return JSON.parse(readFileSync(join(SPEC, `${kind}s.json`), 'utf8')) as SpecEntry[]
}

const ALL: SpecEntry[] = [...load('effect'), ...load('trigger'), ...load('modifier')]
const SCOPE_IDX = JSON.parse(readFileSync(join(SPEC, 'scope-index.json'), 'utf8')) as {
  byScope: Record<string, string[]>
  scopes: string[]
}

const argv = process.argv.slice(2)
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (n: string) => argv.includes(n)

const scope = flag('--scope')
const kind = flag('-k') as SpecKind | undefined
const detail = has('--detail')
const term = argv.find((a) => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--scope' && argv[argv.indexOf(a) - 1] !== '-k')
const limit = parseInt(flag('--limit') ?? '30', 10)

/* ── 按作用域列出 ── */
if (scope) {
  const names = new Set(SCOPE_IDX.byScope[scope] ?? [])
  let hits = ALL.filter((e) => names.has(e.name))
  if (kind) hits = hits.filter((e) => e.kind === kind)
  console.log(`作用域 ${scope} 下可用条目: ${hits.length} 个${kind ? ` (${kind})` : ''}`)
  if (!hits.length) {
    console.log(`\n已知作用域: ${SCOPE_IDX.scopes.join(', ')}`)
    process.exit(0)
  }
  const byKind: Record<string, string[]> = {}
  for (const e of hits) (byKind[e.kind] ??= []).push(e.name)
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`\n── ${k} (${list.length}) ──`)
    console.log('  ' + list.sort().join(' '))
  }
  process.exit(0)
}

/* ── 精确/模糊搜索 ── */
if (!term) {
  console.log('用法:')
  console.log('  query <关键词>              搜索条目名与描述')
  console.log('  query --scope STATE         列出该作用域可用条目')
  console.log('  query <名字> --detail       查看完整规格')
  console.log('  query --scope COUNTRY -k effect --limit 80')
  console.log(`\n已知作用域: ${SCOPE_IDX.scopes.join(', ')}`)
  process.exit(0)
}

const lower = term.toLowerCase()
const hit = (e: SpecEntry) =>
  e.name.toLowerCase().includes(lower) ||
  (e.description ?? '').toLowerCase().includes(lower) ||
  (e.categories ?? []).some((c) => c.toLowerCase().includes(lower))

let hits = ALL.filter(hit)
if (kind) hits = hits.filter((e) => e.kind === kind)

// 完全匹配优先
hits.sort((a, b) => {
  const ae = a.name.toLowerCase() === lower ? 0 : 1
  const be = b.name.toLowerCase() === lower ? 0 : 1
  if (ae !== be) return ae - be
  const as = a.name.toLowerCase().startsWith(lower) ? 0 : 1
  const bs = b.name.toLowerCase().startsWith(lower) ? 0 : 1
  if (as !== bs) return as - bs
  return a.name.length - b.name.length
})

console.log(`匹配 "${term}": ${hits.length} 条${kind ? ` (${kind})` : ''}\n`)
for (const e of hits.slice(0, limit)) {
  console.log(`  [${e.kind}] ${e.name}`)
  if (e.scopes.length) console.log(`       作用域 : ${e.scopes.join(', ')}`)
  if (e.targets.length) console.log(`       target : ${e.targets.slice(0, 6).join(', ')}${e.targets.length > 6 ? ' …' : ''}`)
  if (e.decimals !== undefined) console.log(`       小数位 : ${e.decimals}`)
  if (e.categories?.length) console.log(`       分类   : ${e.categories.join(', ')}`)
  if (e.description && !detail) console.log(`       ${e.description.split('\n')[0].trim().slice(0, 78)}`)
  if (detail && e.description) {
    console.log('       ── 说明/示例 ──')
    for (const l of e.description.split('\n')) console.log(`       ${l}`)
  }
  console.log()
}
if (hits.length > limit) console.log(`  … 还有 ${hits.length - limit} 条,加 --limit N 查看`)
