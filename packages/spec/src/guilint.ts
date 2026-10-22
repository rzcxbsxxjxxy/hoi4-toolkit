/**
 * 界面引用校验(原型)
 *
 * GUI 特有的、别的工具抓不到的一类错误:
 *   .gui 里写 spriteType = "GFX_xxx"
 *   .gfx 里没定义 GFX_xxx
 *   → 游戏不报错,只是那块图标变成空白/问号。极难排查。
 *
 * 同理:texturefile 指向的 .dds 不存在。
 *
 *   node src/guilint.ts --base <vanilla/interface> --mod <mod/interface>
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { parse, keyText, valueText, lineOf } from '../../parser/src/index.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

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
  return out
}

/** .gfx 里所有"带 name 的块"都可被引用,不只是 spriteType */
function collectSprites(dirs: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of dirs) {
    // 只从 .gfx 采集定义:progressbartype / frameAnimatedSpriteType /
    // corneredTileSpriteType / textSpriteType 等都是可引用的命名资源
    for (const p of walk(d, ['.gfx'])) {
      let doc: Document
      try {
        doc = parse(readFileSync(p, 'utf8'))
      } catch {
        continue
      }
      const visit = (b: Block, depth: number) => {
        for (const e of b.entries) {
          if (!e.block) continue
          const name = childValue(doc, e.block, 'name')
          if (name) {
            const n = unq(name)
            if (n && !map.has(n)) map.set(n, relative(d, p))
          }
          // 动画子序列等不需要继续下钻,但深度浅的嵌套(如 spriteTypes>spriteType)要覆盖
          if (depth < 3) visit(e.block, depth + 1)
        }
      }
      visit(doc.root, 0)
    }
  }
  return map
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key) return valueText(doc, e)
  }
  return undefined
}
const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s)

export interface GuiIssue {
  file: string
  line: number
  element: string
  key: string
  value: string
}

/** 扫描 .gui 中的 sprite 引用 */
function collectRefs(dirs: string[]): { refs: GuiIssue[]; total: number } {
  const refs: GuiIssue[] = []
  let total = 0
  for (const d of dirs) {
    for (const p of walk(d, ['.gui'])) {
      let doc: Document
      try {
        doc = parse(readFileSync(p, 'utf8'))
      } catch {
        continue
      }
      const visit = (b: Block) => {
        for (const e of b.entries) {
          const k = keyText(doc, e)
          if (!k) continue
          if (/^spriteType$/i.test(k)) {
            const v = valueText(doc, e)
            if (v && !v.startsWith('$')) {
              total++
              refs.push({
                file: relative(d, p),
                line: lineOf(doc, e),
                element: '?',
                key: k,
                value: unq(v),
              })
            }
          }
          if (e.block) visit(e.block)
        }
      }
      visit(doc.root)
    }
  }
  return { refs, total }
}

/* ───── CLI ───── */
const argv = process.argv.slice(2)
const get = (f: string) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const base = get('--base')
const mod = get('--mod')
if (!mod) {
  console.log('用法: node guilint.ts --mod <模组/interface> [--base <vanilla/interface>]')
  process.exit(1)
}

const baseDirs = base ? [base] : []
const t0 = Date.now()
const sprites = collectSprites([...baseDirs, mod])
const { refs, total } = collectRefs([mod])
const missing = refs.filter((r) => !sprites.has(r.value))

const files = new Set(refs.map((r) => r.file))
console.log('════════ 界面引用校验 ════════')
console.log(`模组        ${mod}`)
if (base) console.log(`基准库      ${base}`)
console.log(`已定义 sprite   ${sprites.size.toLocaleString()} 个`)
console.log(`扫描 .gui       ${files.size} 个文件`)
console.log(`sprite 引用     ${total.toLocaleString()} 处`)
console.log(`未解析引用      ${missing.length} 处  (${((missing.length / total) * 100).toFixed(2)}%)`)
console.log(`耗时            ${Date.now() - t0} ms\n`)

if (missing.length) {
  console.log('── 未解析明细(前 25 条)──')
  const byVal = new Map<string, number>()
  for (const m of missing) byVal.set(m.value, (byVal.get(m.value) ?? 0) + 1)
  for (const m of missing.slice(0, 25)) {
    console.log(`  ${m.file}:${m.line}  spriteType = "${m.value}"`)
  }
  console.log(`\n── 去重后共 ${byVal.size} 个不同的缺失 sprite(Top 10)──`)
  for (const [v, n] of [...byVal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${v.padEnd(48)} 被引用 ${n} 次`)
  }
}
