/**
 * common/ 全目录 schema 挖掘器。
 *
 * 目的:HOI4 每出一个 DLC,common/ 就可能多一个新子目录(如 Gotterdämmerung 的
 * military_industrial_organization、raids)。官方文档并不覆盖全部,所以规则不能靠
 * 背,必须能从真实文件里自动挖出来。
 *
 * 对每个子目录输出:
 *   - 根级键频次(前 8)
 *   - 每个根级键下的子键频次(前 6)+ 该键是块还是简单值
 *   - 是否存在 id / name / key 之类的"自述 id"键(决定 id 取自键名还是取自值)
 *   - 常见深度
 *
 * 用法: node packages/cli/src/diag-common.ts <root1> [root2...] [--dir <子目录名>]
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, lineOf, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

interface DirStat {
  name: string
  files: number
  rootKeys: Map<string, { n: number; block: number; value: number }>
  /** 根键 → 子键频次 */
  subKeys: Map<string, Map<string, number>>
  /** 根键 → 该键块内是否常出现 id/name */
  selfId: Map<string, number>
  /** 子键里出现 id/name 的比例 */
  subSelfId: Map<string, number>
  maxDepth: number
}

const ID_KEYS = ['id', 'name', 'key', 'tag', 'token']

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  let items: string[] = []
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }
  for (const it of items) {
    const p = join(dir, it)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

function statDir(rootPath: string, dirName: string): DirStat | undefined {
  const abs = join(rootPath, 'common', dirName)
  if (!existsSync(abs)) return undefined
  const files = walk(abs, ['.txt'])
  const s: DirStat = {
    name: dirName,
    files: files.length,
    rootKeys: new Map(),
    subKeys: new Map(),
    selfId: new Map(),
    subSelfId: new Map(),
    maxDepth: 0,
  }
  for (const f of files) {
    let doc: Document
    try {
      doc = parse(readFileSync(f, 'utf8'))
    } catch {
      continue
    }
    for (const e of doc.root.entries) {
      const k = keyText(doc, e)
      if (!k) continue
      const cur = s.rootKeys.get(k) ?? { n: 0, block: 0, value: 0 }
      cur.n++
      if (e.block) cur.block++
      else if (e.value >= 0) cur.value++
      s.rootKeys.set(k, cur)
      if (!e.block) continue
      let sub = s.subKeys.get(k)
      if (!sub) {
        sub = new Map()
        s.subKeys.set(k, sub)
      }
      let hasId = false
      for (const c of e.block.entries) {
        const ck = keyText(doc, c)
        if (!ck) continue
        sub.set(ck, (sub.get(ck) ?? 0) + 1)
        if (ID_KEYS.includes(ck.toLowerCase()) && c.value >= 0) hasId = true
      }
      if (hasId) s.selfId.set(k, (s.selfId.get(k) ?? 0) + 1)
      // 二层:统计孙块里是否有 id
      for (const c of e.block.entries) {
        if (!c.block) continue
        let sid = false
        for (const g of c.block.entries) {
          const gk = keyText(doc, g)
          if (gk && ID_KEYS.includes(gk.toLowerCase()) && g.value >= 0) sid = true
        }
        if (sid) s.subSelfId.set(k, (s.subSelfId.get(k) ?? 0) + 1)
      }
    }
  }
  return s
}

function top<T>(m: Map<string, T>, n: number, val: (v: T) => number): [string, T][] {
  return [...m.entries()].sort((a, b) => val(b[1]) - val(a[1])).slice(0, n)
}

function dump(s: DirStat): void {
  console.log(`\n### ${s.name}  (${s.files} 文件)`)
  const rk = top(s.rootKeys, 6, (v) => v.n)
  for (const [k, v] of rk) {
    const kind = v.block && v.value ? `块${v.block}/值${v.value}` : v.block ? `块${v.block}` : `值${v.value}`
    const idRate = s.selfId.get(k) ?? 0
    const sidRate = s.subSelfId.get(k) ?? 0
    let line = `  ${k}  ×${v.n}  [${kind}]`
    if (idRate) line += `  自述id:${idRate}`
    if (sidRate) line += `  孙层自述id:${sidRate}`
    console.log(line)
    const sub = s.subKeys.get(k)
    if (sub) {
      const sk = top(sub, 7, (v) => v)
      console.log(`      子键: ${sk.map(([a, b]) => `${a}(${b})`).join(' ')}`)
    }
  }
  // 若根级键频次很分散,说明根级就是定义列表
  const total = [...s.rootKeys.values()].reduce((a, b) => a + b.n, 0)
  const top1 = rk[0]?.[1].n ?? 0
  if (top1 / total < 0.4 && s.rootKeys.size > 20) {
    console.log(`  → 根级键分散(${s.rootKeys.size} 种 / ${total}),像"根级即定义列表"`)
  }
}

const args = process.argv.slice(2)
const roots = args.filter((a) => !a.startsWith('--'))
const only = (() => {
  const i = args.indexOf('--dir')
  return i >= 0 ? args[i + 1] : undefined
})()

if (!roots.length) {
  console.error('用法: node diag-common.ts <root1> [root2...] [--dir <子目录>]')
  process.exit(1)
}

const dirNames = new Set<string>()
for (const r of roots) {
  const c = join(r, 'common')
  if (!existsSync(c)) continue
  for (const it of readdirSync(c)) {
    if (statSync(join(c, it)).isDirectory()) dirNames.add(it)
  }
}
const list = only ? [only] : [...dirNames].sort()
console.log(`共 ${list.length} 个 common 子目录\n`)

for (const d of list) {
  const stats = roots.map((r) => statDir(r, d)).filter((x): x is DirStat => !!x)
  if (!stats.length) continue
  // 合并
  const merged: DirStat = {
    name: d,
    files: stats.reduce((a, b) => a + b.files, 0),
    rootKeys: new Map(),
    subKeys: new Map(),
    selfId: new Map(),
    subSelfId: new Map(),
    maxDepth: 0,
  }
  for (const s of stats) {
    for (const [k, v] of s.rootKeys) {
      const cur = merged.rootKeys.get(k) ?? { n: 0, block: 0, value: 0 }
      cur.n += v.n
      cur.block += v.block
      cur.value += v.value
      merged.rootKeys.set(k, cur)
    }
    for (const [k, v] of s.subKeys) {
      const m = merged.subKeys.get(k) ?? new Map<string, number>()
      for (const [a, b] of v) m.set(a, (m.get(a) ?? 0) + b)
      merged.subKeys.set(k, m)
    }
    for (const [k, v] of s.selfId) merged.selfId.set(k, (merged.selfId.get(k) ?? 0) + v)
    for (const [k, v] of s.subSelfId) merged.subSelfId.set(k, (merged.subSelfId.get(k) ?? 0) + v)
  }
  dump(merged)
}
void lineOf
void valueText
