/**
 * 探针:统计 scripted_guis 及其他域里"引用 interface 元素名"的键。
 * 只做统计,不写任何文件 —— 用来校准 links.ts 的提取规则,避免拍脑袋。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'

function walk(dir: string, ext: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, ext, out)
    else if (ext.some((e) => n.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

const LOCAL_MOD = process.env.HOI4_MOD ?? ''
const ROOTS: { name: string; base: string }[] = [
  ...(LOCAL_MOD ? [{ name: 'local-mod', base: LOCAL_MOD }] : []),
  { name: 'KR', base: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605' },
  { name: 'RT56', base: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/820260968' },
]

// scripted_gui 内一级键频次
const lvl1 = new Map<string, number>()
// scripted_gui 内二级键频次(按一级分组)
const lvl2 = new Map<string, Map<string, number>>()
// properties 下的三级键
const lvl3 = new Map<string, Map<string, number>>()
// dynamic_lists 下的三级键
const dynKeys = new Map<string, number>()
let files = 0
let guis = 0

for (const r of ROOTS) {
  for (const f of walk(join(r.base, 'common', 'scripted_guis'), ['.txt'])) {
    files++
    let doc: Document
    try {
      doc = parse(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    const top = findBlock(doc, doc.root, 'scripted_gui')
    if (!top) continue
    for (const e of top.entries) {
      if (!e.block) continue
      guis++
      for (const c of e.block.entries) {
        const k = keyText(doc, c)
        if (!k) continue
        lvl1.set(k, (lvl1.get(k) ?? 0) + 1)
        if (!c.block) continue
        let m2 = lvl2.get(k)
        if (!m2) lvl2.set(k, (m2 = new Map()))
        for (const g of c.block.entries) {
          const k3 = keyText(doc, g)
          if (!k3) continue
          m2.set(k3, (m2.get(k3) ?? 0) + 1)
          if (!g.block) continue
          let m3 = lvl3.get(`${k}.${k3}`)
          if (!m3) lvl3.set(`${k}.${k3}`, (m3 = new Map()))
          for (const h of g.block.entries) {
            const k4 = keyText(doc, h)
            if (!k4) continue
            m3.set(k4, (m3.get(k4) ?? 0) + 1)
            if (k === 'dynamic_lists' || k === 'properties') dynKeys.set(k4, (dynKeys.get(k4) ?? 0) + 1)
          }
        }
      }
    }
  }
}

console.log(`scripted_guis 文件 ${files} 个, scripted_gui 条目 ${guis} 个\n`)
console.log('── 一级键 ──')
dump(lvl1, 40)
for (const [k, m] of [...lvl2.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
  console.log(`\n── ${k} (${sum(m)}) 下的键 ──`)
  dump(m, 15)
}
console.log('\n── properties/dynamic_lists 三级键 ──')
dump(dynKeys, 25)

function sum(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}
function dump(m: Map<string, number>, n: number): void {
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)) {
    console.log(`  ${String(v).padStart(6)}  ${k}`)
  }
}

function findBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key && e.block) return e.block
  }
  return undefined
}
void valueText
void Entry
