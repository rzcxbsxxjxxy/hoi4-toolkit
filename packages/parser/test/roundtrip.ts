/**
 * Round-trip 生死线测试。
 *
 * 对每个文件: Buffer -> utf8 解码 -> parse -> serialize -> utf8 编码 -> 与原始 Buffer 逐字节比较。
 * 只要有一个字节不同,即为失败。
 *
 * 用法: node roundtrip.ts <目录> [--ext .txt,.yml] [--verbose]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parse, serialize } from '../src/index.ts'

const args = process.argv.slice(2)
const root = args.find((a) => !a.startsWith('--'))
const verbose = args.includes('--verbose')
const extArg = args.find((a) => a.startsWith('--ext='))
const exts = (extArg ? extArg.slice(6) : '.txt').split(',')

if (!root) {
  console.error('用法: node roundtrip.ts <目录> [--ext=.txt,.yml] [--verbose]')
  process.exit(1)
}

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walkFiles(p)
    else if (exts.includes(extname(name).toLowerCase())) yield p
  }
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

let total = 0
let pass = 0
let bytes = 0
let parseErrors = 0
const failures: { file: string; kind: string; detail: string }[] = []
const files: string[] = []

for (const p of walkFiles(root)) files.push(p)
files.sort()

const t0 = performance.now()

for (const p of files) {
  total++
  let buf: Buffer
  try {
    buf = readFileSync(p)
  } catch (e) {
    failures.push({ file: p, kind: 'read', detail: String(e) })
    continue
  }
  bytes += buf.length

  const src = buf.toString('utf8')
  let doc
  try {
    doc = parse(src)
  } catch (e) {
    failures.push({ file: p, kind: 'crash', detail: String(e) })
    continue
  }
  parseErrors += doc.errors.length

  const out = serialize(doc)
  const outBuf = Buffer.from(out, 'utf8')
  if (outBuf.equals(buf)) {
    pass++
    if (verbose && doc.errors.length) console.log(`  warn ${p}: ${doc.errors.length} 处语法异常`)
    continue
  }

  // 判断是否纯编码问题(用 latin1 解码可无损往返 => 文件不是 UTF-8)
  const l1 = buf.toString('latin1')
  const l1Out = Buffer.from(serializeWrapped(l1), 'latin1')
  if (l1Out.equals(buf)) {
    failures.push({ file: p, kind: 'encoding', detail: '非 UTF-8 编码(按 latin1 可无损),需转码后再处理' })
    continue
  }

  const i = firstDiff(src, out)
  const ctx = i >= 0 ? `偏移 ${i}: 原文「${src.slice(Math.max(0, i - 40), i + 40)}」` : `长度不同 ${src.length} -> ${out.length}`
  failures.push({ file: p, kind: 'content', detail: ctx })
}

const ms = performance.now() - t0

function serializeWrapped(s: string): string {
  // 编码探测用:与 serialize 同逻辑,避免引入额外 import 循环
  const { parse: p2 } = { parse }
  return serialize(p2(s))
}

console.log(`\n扫描目录: ${root}`)
console.log(`扩展名:   ${exts.join(', ')}`)
console.log(`文件总数: ${total}`)
console.log(`通过:     ${pass}`)
console.log(`失败:     ${failures.length}`)
console.log(`总字节:   ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`耗时:     ${ms.toFixed(0)} ms  (${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s)`)
console.log(`语法异常: ${parseErrors} 处(记入 errors 但不影响往返)`)

if (failures.length) {
  const byKind: Record<string, number> = {}
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  console.log(`\n失败分类: ${JSON.stringify(byKind)}`)
  console.log('\n失败明细(最多 30 条):')
  for (const f of failures.slice(0, 30)) {
    console.log(`  [${f.kind}] ${f.file}`)
    console.log(`      ${f.detail.slice(0, 200)}`)
  }
  process.exit(1)
}

console.log('\n全部通过:round-trip 逐字节一致,parser 可信。')
