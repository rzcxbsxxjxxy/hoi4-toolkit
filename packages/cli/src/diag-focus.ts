/**
 * national_focus schema 探针:从真实文件统计 focus_tree / focus 两级的所有键。
 * 官方文档里没有 national_focus.md,所以 schema 只能从数据挖 —— 和 guischema 同一套路。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

function walk(dir: string, ext: string[]): string[] {
  const out: string[] = []
  let ents: string[] = []
  try {
    ents = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of ents) {
    const p = join(dir, e)
    let st: { isDirectory(): boolean }
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walk(p, ext))
    else if (ext.some((x) => e.toLowerCase().endsWith(x))) out.push(p)
  }
  return out
}

const treeKeys = new Map<string, number>()
const focusKeys = new Map<string, number>()
const treeKeyBlocks = new Map<string, number>()
let trees = 0
let focuses = 0
const iconVals = new Map<string, number>()
const styleNames = new Set<string>()
const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'))

for (const root of roots) {
  const files = walk(join(root, 'common', 'national_focus'), ['.txt'])
  for (const f of files) {
    let doc: Document
    try {
      doc = parse(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    for (const e of doc.root.entries) {
      const k = keyText(doc, e) ?? '?'
      if (k.toLowerCase() === 'style' && e.block) {
        const nm = childValue(doc, e.block, 'name')
        if (nm) styleNames.add(nm)
        continue
      }
      if (k.toLowerCase() !== 'focus_tree' || !e.block) continue
      trees++
      for (const te of e.block.entries) {
        const tk = keyText(doc, te) ?? '?'
        treeKeys.set(tk, (treeKeys.get(tk) ?? 0) + 1)
        if (te.block) treeKeyBlocks.set(tk, (treeKeyBlocks.get(tk) ?? 0) + 1)
        if (tk.toLowerCase() !== 'focus' || !te.block) continue
        focuses++
        for (const fe of te.block.entries) {
          const fk = keyText(doc, fe) ?? '?'
          focusKeys.set(fk, (focusKeys.get(fk) ?? 0) + 1)
          if (fk.toLowerCase() === 'icon') {
            const v = valueText(doc, fe)
            if (v) iconVals.set(v, (iconVals.get(v) ?? 0) + 1)
          }
        }
      }
    }
  }
}

function dump(title: string, m: Map<string, number>, total: number): void {
  console.log(`\n── ${title} (${m.size} 种,样本 ${total}) ──`)
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1])
  for (const [k, v] of rows) console.log(`  ${String(v).padStart(6)}  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`)
}

console.log(`国策树 ${trees} 棵,国策 ${focuses} 个`)
dump('focus_tree 层键', treeKeys, trees)
console.log('\n哪些是块:', [...treeKeyBlocks.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(' '))
dump('focus 层键', focusKeys, focuses)
console.log(`\n── 不同 icon 值 ${iconVals.size} 种 ──`)
;[...iconVals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k}`))
console.log(`\n── style 名 ${styleNames.size} 个 ──`)
;[...styleNames].slice(0, 8).forEach((s) => console.log(`  ${s}`))

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  }
  return undefined
}
