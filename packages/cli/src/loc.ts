#!/usr/bin/env node
/**
 * 本地化索引 CLI(独立入口)。
 *
 * 用法: node loc.ts <目录>
 *
 * 说明:hoi4kit.ts 主入口当前被进程独占无法写入,暂用此独立入口,
 * 待解锁后会把 loc 子命令合并进 hoi4kit。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { parseLocYml, buildLocIndex } from '../../engine/src/loc.ts'

function* walkFiles(dir: string, exts: string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walkFiles(p, exts)
    else if (exts.includes(extname(name).toLowerCase())) yield p
  }
}

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node loc.ts <目录>')
  process.exit(1)
}

const files = [...walkFiles(dir, ['.yml'])].sort()
if (!files.length) {
  console.log(`未在 ${dir} 找到 .yml 文件`)
  process.exit(1)
}

const results = files.map((p) => parseLocYml(readFileSync(p, 'utf8'), relative(dir, p)))
const idx = buildLocIndex(results)

console.log(`\n════════ 本地化索引 ════════`)
console.log(`目录        ${dir}`)
console.log(`YML 文件    ${idx.files}`)
console.log(`条目总数    ${idx.entries.toLocaleString()}`)

console.log(`\n── 语言分布 ──`)
for (const [lang, n] of [...idx.byLang.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${lang.padEnd(18)} ${n.toLocaleString()}`)
}

console.log(`\n── 缺 BOM ──`)
console.log(`  ${idx.missingBom.length ? `${idx.missingBom.length} 个文件(游戏要求 UTF-8 with BOM)` : '无'}`)
for (const f of idx.missingBom.slice(0, 10)) console.log(`      ${f}`)

console.log(`\n── 重复 key(同语言内) ──`)
console.log(`  ${idx.duplicates.size} 组`)
for (const [id, arr] of [...idx.duplicates.entries()].slice(0, 12)) {
  console.log(`  ${id}  ×${arr.length}`)
  for (const e of arr.slice(0, 3)) console.log(`      ${e.file}:${e.line}  ${e.value.slice(0, 50)}`)
}

const crossFile = [...idx.keyToFile.entries()].filter(([, s]) => s.size > 1)
console.log(`\n── 跨文件同名 key ──`)
console.log(`  ${crossFile.length} 个 key 出现在多个文件(覆盖语义,需人工确认是否为有意)`)
for (const [k, s] of crossFile.slice(0, 10)) {
  console.log(`  ${k}  → ${[...s].slice(0, 3).join(', ')}${s.size > 3 ? ` 等 ${s.size} 个文件` : ''}`)
}

console.log(`\n── 解析异常 ──`)
console.log(`  ${idx.errorFiles.length} 个文件`)
for (const e of idx.errorFiles.slice(0, 10)) console.log(`  ${e.file} ×${e.count}: ${e.first}`)

process.exit(0)
