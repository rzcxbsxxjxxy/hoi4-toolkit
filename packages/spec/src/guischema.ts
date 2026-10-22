/**
 * 界面 Schema 挖掘器
 *
 * 为什么需要这个:官方 48 份文档里**没有任何一份**描述 .gui / .gfx 格式。
 * CWTools 那套手写 .cwt 规则也因此覆盖不全。
 *
 * 解法:从真实文件里统计。700+ 个 .gui 里出现过的属性,就是游戏真正认的属性。
 * 这是"经验证的经验规则",比猜的可靠。
 *
 *   node src/guischema.ts <dir1> [dir2 ...] [--out 路径]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, keyText, valueText, lineOf } from '../../parser/src/index.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'

export interface PropStat {
  key: string
  /** 出现总次数 */
  count: number
  /** 出现在多少个不同文件 */
  files: number
  /** 值的形态分布 */
  kinds: Record<string, number>
  /** 样例值(去重,最多 5 个) */
  samples: string[]
}

export interface ElementSchema {
  type: string
  count: number
  files: number
  props: PropStat[]
}

export interface GuiSchema {
  files: number
  bytes: number
  /** 元素类型(containerWindowType / buttonType …)按出现次数降序 */
  elementTypes: ElementSchema[]
  /** .gui 文件的根级 key */
  rootKeys: PropStat[]
}

function classify(doc: Document, e: Entry): string {
  if (e.block) {
    // 区分常见结构块:position / size / 通用块
    const inner = e.block.entries.map((x) => keyText(doc, x)).filter(Boolean)
    const set = new Set(inner)
    if (set.has('x') && set.has('y')) return 'position'
    if (set.has('width') && set.has('height')) return 'size'
    if (set.size === 0) return 'block(空)'
    return 'block'
  }
  const v = valueText(doc, e)
  if (v === undefined) return '无值'
  if (/^".*"$/.test(v)) return 'string'
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number'
  if (/^(yes|no)$/i.test(v)) return 'bool'
  return 'bare'
}

function bump(stat: PropStat, kind: string, value: string, file: string) {
  stat.count++
  stat.kinds[kind] = (stat.kinds[kind] ?? 0) + 1
  if (stat.samples.length < 5 && value && !stat.samples.includes(value)) stat.samples.push(value)
  stat.filesSeen.add(file)
}

// 临时承载,输出前转成 files 计数
interface PropStatInternal extends PropStat {
  filesSeen: Set<string>
}

function newProp(key: string): PropStatInternal {
  return { key, count: 0, files: 0, kinds: {}, samples: [], filesSeen: new Set() }
}

function walkDir(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let items: string[] = []
    try {
      items = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of items) {
      const p = join(cur, name)
      let st: { isDirectory(): boolean }
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (exts.some((x) => name.toLowerCase().endsWith(x))) out.push(p)
    }
  }
  return out
}

export function mineGuiSchema(dirs: string[], exts = ['.gui', '.gfx']): GuiSchema {
  const elementMap = new Map<string, { count: number; files: Set<string>; props: Map<string, PropStatInternal> }>()
  const rootKeyMap = new Map<string, PropStatInternal>()
  let files = 0
  let bytes = 0

  for (const dir of dirs) {
    for (const p of walkDir(dir, exts)) {
      let src: string
      try {
        src = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      files++
      bytes += Buffer.byteLength(src)

      let doc: Document
      try {
        doc = parse(src)
      } catch {
        continue
      }
      const file = relative(dir, p)

      // 根级 key
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k) continue
        const st = rootKeyMap.get(k) ?? newProp(k)
        bump(st, classify(doc, e), valueText(doc, e) ?? '', file)
        rootKeyMap.set(k, st)
      }

      // 递归挖掘所有块,按"块名"归类为元素类型
      const stack: Block[] = [doc.root]
      while (stack.length) {
        const b = stack.pop()!
        for (const e of b.entries) {
          const k = keyText(doc, e)
          if (!k || !e.block) continue
          stack.push(e.block)

          // 只把形如 *Type 的块当作"元素类型";其余只是嵌套容器
          if (!/Type$/.test(k)) continue

          let el = elementMap.get(k)
          if (!el) {
            el = { count: 0, files: new Set(), props: new Map() }
            elementMap.set(k, el)
          }
          el.count++
          el.files.add(file)

          for (const c of e.block.entries) {
            const ck = keyText(doc, c)
            if (!ck) continue
            const ps = el.props.get(ck) ?? newProp(ck)
            bump(ps, classify(doc, c), valueText(doc, c) ?? '', file)
            el.props.set(ck, ps)
          }
        }
      }
    }
  }

  const finalize = (m: Map<string, PropStatInternal>): PropStat[] =>
    [...m.values()]
      .map((p) => ({ key: p.key, count: p.count, files: p.filesSeen.size, kinds: p.kinds, samples: p.samples }))
      .sort((a, b) => b.count - a.count)

  const elementTypes: ElementSchema[] = [...elementMap.entries()]
    .map(([type, v]) => ({
      type,
      count: v.count,
      files: v.files.size,
      props: finalize(v.props),
    }))
    .sort((a, b) => b.count - a.count)

  return { files, bytes, elementTypes, rootKeys: finalize(rootKeyMap) }
}

/* ───────── CLI ───────── */
const argv = process.argv.slice(2)
const outArg = argv.indexOf('--out')
const out = outArg >= 0 ? argv[outArg + 1] : join(import.meta.dirname, '..', '..', '..', 'spec', 'gui-schema.json')
const dirs = argv.filter((a) => !a.startsWith('--') && (outArg < 0 || a !== argv[outArg + 1]))

if (!dirs.length) {
  console.log('用法: node guischema.ts <目录1> [目录2 ...] [--out 输出路径]')
  process.exit(1)
}

const schema = mineGuiSchema(dirs)

mkdirSync(join(out, '..'), { recursive: true })
writeFileSync(out, JSON.stringify(schema, null, 2), 'utf8')

console.log('════════ 界面 Schema 挖掘 ════════')
console.log(`目录        ${dirs.join(' , ')}`)
console.log(`文件        ${schema.files}  (${(schema.bytes / 1048576).toFixed(2)} MB)`)
console.log(`输出        ${out}\n`)

console.log('── .gui 根级 key ──')
for (const p of schema.rootKeys.slice(0, 8)) {
  console.log(`  ${p.key.padEnd(24)} ${String(p.count).padStart(6)} 次 / ${p.files} 文件`)
}

console.log(`\n── 元素类型(共 ${schema.elementTypes.length} 种)──`)
for (const el of schema.elementTypes.slice(0, 12)) {
  console.log(`  ${el.type.padEnd(24)} ${String(el.count).padStart(6)} 个 / ${el.files} 文件 / ${el.props.length} 种属性`)
}

console.log('\n── 高频元素的核心属性(Top 4 类型 × 各 8 个)──')
for (const el of schema.elementTypes.slice(0, 4)) {
  console.log(`\n  [${el.type}]`)
  for (const p of el.props.slice(0, 8)) {
    const kinds = Object.entries(p.kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`)
      .join(' ')
    console.log(`      ${p.key.padEnd(22)} ${String(p.count).padStart(6)}  ${kinds}`)
  }
}
