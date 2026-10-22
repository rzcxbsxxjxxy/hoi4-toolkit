/**
 * 根级 shared_focus / joint_focus 的键分布 —— 补 diag-focus 只扫 focus_tree 的盲区。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

function walk(dir: string): string[] {
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
    if (st.isDirectory()) out.push(...walk(p))
    else if (e.toLowerCase().endsWith('.txt')) out.push(p)
  }
  return out
}

const joint = new Map<string, number>()
const shared = new Map<string, number>()
const rootKeys = new Map<string, number>()
let jn = 0
let sn = 0

for (const root of process.argv.slice(2)) {
  for (const f of walk(join(root, 'common', 'national_focus'))) {
    let doc: Document
    try {
      doc = parse(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    for (const e of doc.root.entries) {
      const k = keyText(doc, e) ?? '?'
      rootKeys.set(k, (rootKeys.get(k) ?? 0) + 1)
      const low = k.toLowerCase()
      if (low === 'joint_focus' && e.block) {
        jn++
        for (const fe of e.block.entries) {
          const fk = keyText(doc, fe) ?? '?'
          joint.set(fk, (joint.get(fk) ?? 0) + 1)
        }
      } else if (low === 'shared_focus' && e.block) {
        sn++
        for (const fe of e.block.entries) {
          const fk = keyText(doc, fe) ?? '?'
          shared.set(fk, (shared.get(fk) ?? 0) + 1)
        }
      }
    }
  }
}

function dump(t: string, m: Map<string, number>, n: number): void {
  console.log(`\n── ${t} (${n} 个) ──`)
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(6)}  ${(v / n * 100).toFixed(1).padStart(5)}%  ${k}`)
}

console.log('── 根级键 ──')
for (const [k, v] of [...rootKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`)
dump('joint_focus 键', joint, jn)
dump('根级 shared_focus 键', shared, sn)

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  }
  return undefined
}
void childValue
