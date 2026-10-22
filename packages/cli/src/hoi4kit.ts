#!/usr/bin/env node
/**
 * hoi4kit —— HOI4 模组工程化 CLI
 *
 * 命令:
 *   stats <dir>      扫描并统计家底(定义、重复、括号问题、key 频率)
 *   roundtrip <dir>  无损往返验证(生死线)
 *   gen <kind>       内容生成脚手架(无损、round-trip 安全)
 *   lsp              启动零依赖 LSP 服务端(stdio JSON-RPC),供 VS Code 等编辑器接入
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, relative, basename, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { parse, serialize, walk, keyText } from '../../parser/src/index.ts'
import {
  DEF_RULES,
  analyzeStructure,
  collectKeyFreq,
  countEntries,
  type Definition,
  type FileStat,
} from '../../engine/src/indexer.ts'
import { validateRoots, type ValidationReport } from '../../engine/src/validate.ts'
import { generate, type GenKind } from '../../engine/src/gen.ts'

const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'

function* walkFiles(dir: string, exts: string[]): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walkFiles(p, exts)
    else if (exts.includes(extname(name).toLowerCase())) yield p
  }
}

function cmdRoundtrip(dir: string): number {
  const files = [...walkFiles(dir, ['.txt'])].sort()
  let pass = 0
  let bytes = 0
  const bad: string[] = []
  const t0 = performance.now()
  for (const p of files) {
    const buf = readFileSync(p)
    bytes += buf.length
    const src = buf.toString('utf8')
    try {
      if (Buffer.from(serialize(parse(src)), 'utf8').equals(buf)) pass++
      else bad.push(p)
    } catch {
      bad.push(p)
    }
  }
  const ms = performance.now() - t0
  console.log(`文件 ${files.length}  通过 ${pass}  失败 ${bad.length}  ${(bytes / 1048576).toFixed(2)} MB  ${ms.toFixed(0)} ms`)
  for (const b of bad.slice(0, 20)) console.log('  FAIL ' + b)
  return bad.length ? 1 : 0
}

/**
 * 全库定位某个符号的所有出现位置。
 * rename 的前置能力:改名前必须知道每一处引用,否则会漏改。
 */
function cmdFind(id: string, dir: string): number {
  const files = [...walkFiles(dir, ['.txt'])].sort()
  const hits: { file: string; line: number; text: string }[] = []
  const t0 = performance.now()
  for (const p of files) {
    const src = readFileSync(p, 'utf8')
    const doc = parse(src)
    const lines = src.split('\n')
    for (const t of doc.tokens) {
      if (t.type !== 'word' && t.type !== 'string') continue
      const v = t.type === 'string' ? t.text.replace(/^"|"$/g, '') : t.text
      if (v !== id) continue
      hits.push({ file: relative(dir, p), line: t.line, text: (lines[t.line - 1] ?? '').trim().slice(0, 90) })
    }
  }
  const ms = performance.now() - t0
  console.log(`\n符号 "${id}" 在 ${files.length} 个文件中共出现 ${hits.length} 处  (${ms.toFixed(0)} ms)\n`)
  for (const h of hits.slice(0, 40)) {
    console.log(`  ${h.file}:${h.line}`)
    console.log(`      ${h.text}`)
  }
  if (hits.length > 40) console.log(`  ... 另有 ${hits.length - 40} 处`)
  return hits.length ? 0 : 1
}

function cmdStats(dir: string): number {
  const files = [...walkFiles(dir, ['.txt'])].sort()
  const stats: FileStat[] = []
  const definitions: Definition[] = []
  const keyFreq = new Map<string, number>()
  let totalBytes = 0
  let totalLines = 0
  const t0 = performance.now()

  for (const p of files) {
    const buf = readFileSync(p)
    const src = buf.toString('utf8')
    const doc = parse(src)
    totalBytes += buf.length
    totalLines += src.split('\n').length
    const { maxDepth, bracket, issue } = analyzeStructure(doc)
    const { entries, blocks } = countEntries(doc)
    collectKeyFreq(doc, keyFreq)
    stats.push({
      file: relative(dir, p),
      bytes: buf.length,
      lines: src.split('\n').length,
      entries,
      blocks,
      maxDepth,
      bracket,
      issue,
      errors: doc.errors,
    })
    for (const rule of DEF_RULES) {
      if (!rule.dir.test(p)) continue
      if (rule.exclude?.test(p)) continue
      try {
        definitions.push(...rule.extract(doc, p))
      } catch (e) {
        console.error(`  提取 ${rule.kind} 失败: ${p} — ${e}`)
      }
    }
  }
  const ms = performance.now() - t0

  // 汇总
  console.log('\n════════ 家底统计 ════════')
  console.log(`目录        ${dir}`)
  console.log(`文件        ${files.length}`)
  console.log(`体积        ${(totalBytes / 1048576).toFixed(2)} MB`)
  console.log(`行数        ${totalLines.toLocaleString()}`)
  console.log(`耗时        ${ms.toFixed(0)} ms`)

  // 括号问题
  const bracketBad = stats.filter((s) => s.bracket !== 'ok')
  console.log(`\n── 结构问题 ──`)
  console.log(`括号不平衡   ${bracketBad.length} 个文件`)
  for (const s of bracketBad.slice(0, 15)) {
    const lines = s.issue.extraCloseAt.length ? s.issue.extraCloseAt : s.issue.unclosedAt
    const label = s.bracket === 'unclosed' ? '缺少 }' : '多出 }'
    console.log(`  [${label}] ${s.file}  第 ${lines.slice(0, 4).join('、')}${lines.length > 4 ? ` 等 ${lines.length} 处` : ''} 行`)
  }
  const errFiles = stats.filter((s) => s.errors.length)
  if (errFiles.length) {
    console.log(`语法异常     ${errFiles.length} 个文件`)
    for (const s of errFiles.slice(0, 10)) console.log(`  ${s.file}: ${s.errors[0]}`)
  }

  // 定义统计
  console.log(`\n── 定义符号 ──`)
  const byKind = new Map<string, Definition[]>()
  for (const d of definitions) {
    const arr = byKind.get(d.kind) ?? []
    arr.push(d)
    byKind.set(d.kind, arr)
  }
  console.log(`总计        ${definitions.length}`)
  const kinds = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [kind, arr] of kinds) {
    console.log(`  ${kind.padEnd(16)} ${arr.length}`)
  }

  // 重复定义
  const dupMap = new Map<string, Definition[]>()
  for (const d of definitions) {
    const k = `${d.kind}:${d.id}`
    const arr = dupMap.get(k) ?? []
    arr.push(d)
    dupMap.set(k, arr)
  }
  const dups = [...dupMap.entries()].filter(([, arr]) => arr.length > 1)
  console.log(`\n── 重复定义 ──`)
  console.log(`共 ${dups.length} 组(同名在多个位置定义,可能是覆盖也可能是笔误)`)
  for (const [k, arr] of dups.slice(0, 15)) {
    console.log(`  ${k}  ×${arr.length}`)
    for (const d of arr.slice(0, 4)) console.log(`      ${relative(dir, d.file)}:${d.line}`)
  }

  // key 频率
  console.log(`\n── 高频 key (Top 25) ──`)
  const top = [...keyFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  for (const [k, n] of top) console.log(`  ${k.padEnd(34)} ${n}`)

  return 0
}

function cmdCheck(dir: string, dirsArg?: string): number {
  // 归一化:若指向 common/,上退一级以便同时扫到 localisation/
  let root = dir
  if (/[\\/]common[\\/]?$/i.test(root)) root = join(root, '..')
  const roots = [{ name: basename(root), path: root }]
  const t0 = performance.now()
  const dirs = dirsArg ? dirsArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const r: ValidationReport = validateRoots(roots, { dirs })
  const ms = performance.now() - t0

  const line = (s = '') => console.log(s)
  line('\n════════ 模组体检报告 ════════')
  line(`范围        ${roots.map((x) => x.path).join(', ')}`)
  line(`扫描        脚本文件 ${r.scanned.files} / 本地化 ${r.scanned.locFiles}  (${(r.scanned.bytes / 1048576).toFixed(1)} MB)  ${ms.toFixed(0)} ms`)
  line(`定义        ${r.stats.defs}   引用 ${r.stats.refs}`)
  line(`\n── 汇总 ──`)
  line(`  ❌ 错误   ${r.stats.errors}`)
  line(`  ⚠ 告警    ${r.stats.warnings}`)

  if (r.syntax.length) {
    line(`\n── 语法错误 (${r.syntax.length}) ──`)
    for (const s of r.syntax.slice(0, 25)) line(`  [${s.rel}:${s.line ?? '?'}] ${s.error.slice(0, 100)}`)
    if (r.syntax.length > 25) line(`  … 另有 ${r.syntax.length - 25} 处`)
  }
  if (r.brackets.length) {
    line(`\n── 括号结构提示 (${r.brackets.length},基于 token 计数,部分合法写法会误报,需人工确认) ──`)
    for (const b of r.brackets.slice(0, 20)) {
      const ls = b.lines.slice(0, 4).join('、')
      line(`  [${b.kind === 'unclosed' ? '缺 }' : '多 }'}] ${b.rel}  第 ${ls}${b.lines.length > 4 ? ` 等${b.lines.length}处` : ''} 行`)
    }
  }
  if (r.duplicates.length) {
    const real = r.duplicates.filter((d) => d.sameFile)
    line(`\n── 重复定义 (${r.duplicates.length} 组,其中 ${real.length} 组为同文件真重复) ──`)
    for (const d of r.duplicates.slice(0, 20)) {
      const tag = d.sameFile ? '⚠同文件真重复' : '共享/覆盖'
      line(`  [${tag}] ${d.kind}:${d.id}  ×${d.count}  ${d.locs.map((l) => l.file + ':' + l.line).slice(0, 3).join(' ')}`)
    }
    if (r.duplicates.length > 20) line(`  … 另有 ${r.duplicates.length - 20} 组`)
  }
  if (r.danglingRefs.length) {
    const miss = r.danglingRefs.filter((d) => d.target === 'gfx_sprite')
    const locMiss = r.danglingRefs.filter((d) => d.target === 'loc_key')
    line(`\n── 悬空图标引用 (${miss.length},仅 GFX_ 前缀;裸名如战术/理念简写已忽略) ──`)
    for (const d of miss.slice(0, 20)) line(`  ${d.name}  ← ${d.file}:${d.line}${d.owner ? ` (${d.ownerKind}:${d.owner})` : ''}`)
    if (miss.length > 20) line(`  … 另有 ${miss.length - 20} 处`)
    line(`\n── 缺失本地化 (${locMiss.length}) ──`)
    for (const d of locMiss.slice(0, 25)) {
      const tag = d.missingInPrimary ? `缺${r.primaryLang ?? '主语言'}` : '全缺'
      line(`  [${tag}] ${d.name}  ← ${d.file}:${d.line}${d.owner ? ` (${d.ownerKind}:${d.owner})` : ''}`)
    }
    if (locMiss.length > 25) line(`  … 另有 ${locMiss.length - 25} 处`)
  }
  if (r.loc.files) {
    line(`\n── 本地化完整性 ──`)
    if (r.loc.noBom.length) line(`  无 BOM 文件   ${r.loc.noBom.length}  (游戏要求 UTF-8 BOM,中文会乱码)`)
    if (r.loc.dupKeys.length) line(`  跨文件重复键 ${r.loc.dupKeys.length}  (例: ${r.loc.dupKeys.slice(0, 3).map((d) => d.id).join(', ')})`)
    if (r.loc.errorFiles.length) line(`  解析异常文件 ${r.loc.errorFiles.length}  (例: ${r.loc.errorFiles.slice(0, 3).map((d) => d.file).join(', ')})`)
    if (!r.loc.noBom.length && !r.loc.dupKeys.length && !r.loc.errorFiles.length) line('  ✓ 未发现明显问题')
  }
  return r.stats.errors ? 1 : 0
}

/** 内容生成脚手架:生成合法 .txt/.yml 并落盘,附 round-trip 自检 */
function cmdGen(kind: string, jsonArg?: string, outDir?: string): number {
  const k = kind as GenKind
  let opts: Record<string, unknown> = {}
  if (jsonArg) {
    try {
      opts = JSON.parse(jsonArg)
    } catch (e) {
      console.error('JSON 解析失败:', String(e))
      return 1
    }
  }
  const r = generate(k, opts)
  const out = outDir ?? '.'
  console.log(`\n════════ 生成 ${k} ════════`)
  for (const f of r.files) {
    const p = join(out, f.path)
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.content)
      console.log(`  ✓ ${f.path}  (${f.content.length} 字节)`)
    } catch (e) {
      console.log(`  ✗ ${f.path}  写入失败: ${String(e)}`)
    }
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`)
  if (r.files.length) console.log(`\n已写入 ${r.files.length} 个文件到 ${out}`)
  return 0
}

/** 启动 LSP 服务端(把控制权交给它,stdin/stdout 直接对接编辑器) */
function cmdLsp(args: string[]): void {
  const serverPath = join(import.meta.dirname ?? '.', '..', '..', 'lsp', 'src', 'server.ts')
  const child = spawn(process.execPath, ['--experimental-strip-types', serverPath, ...args], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (e) => {
    console.error('LSP 启动失败:', String(e))
    process.exit(1)
  })
}

// ── 入口 ──
const [, , cmd, ...rest] = process.argv
const positional = rest.filter((a) => !a.startsWith('--'))

/** 取值选项,支持 --name=x 与 --name x 两种写法 */
function optValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(`--${name}=`.length)
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return undefined
}
// find 的第一个位置参数是符号名,其后才是目录;其他命令第一个就是目录
const symbol = cmd === 'find' ? positional[0] : undefined
const target = (cmd === 'find' ? positional[1] : positional[0]) ?? join(VANILLA, 'common')

switch (cmd) {
  case 'stats':
    process.exit(cmdStats(target))
  case 'roundtrip':
    process.exit(cmdRoundtrip(target))
  case 'find':
    if (!symbol) {
      console.error('用法: hoi4kit find <符号名> [目录]')
      process.exit(1)
    }
    process.exit(cmdFind(symbol, target))
  case 'check': {
    // 支持 --dirs=x 与 --dirs x 两种写法
    let dirsArg: string | undefined
    const eq = rest.find((a) => a.startsWith('--dirs='))
    if (eq) dirsArg = eq.slice('--dirs='.length)
    else {
      const i = rest.indexOf('--dirs')
      if (i >= 0) dirsArg = rest[i + 1]
    }
    process.exit(cmdCheck(target, dirsArg))
  }
  case 'gen': {
    const kind = positional[0] ?? 'focus'
    const j = optValue(rest, 'json')
    const out = optValue(rest, 'out')
    process.exit(cmdGen(kind, j, out))
  }
  case 'lsp':
    cmdLsp(rest)
    break
  default:
    console.log(`hoi4kit —— HOI4 模组工程化 CLI

用法:
  hoi4kit stats <dir>              扫描并统计家底
  hoi4kit roundtrip <dir>          无损往返验证
  hoi4kit find <符号名> [dir]      全库定位符号的所有出现位置
  hoi4kit check <dir>              模组体检(语法/括号/重复/悬空引用/本地化)
  hoi4kit gen <kind>               内容生成(focus/event/decision/technology/idea/equipment)
                                  --json '{...}' 传参,--out <目录> 指定输出(默认当前目录)
  hoi4kit lsp [--root <你的mod>] [--game <游戏根目录>]
                                  启动零依赖 LSP 服务端,供 VS Code 等编辑器接入

默认目录: ${VANILLA}/common`)
    process.exit(0)
}
