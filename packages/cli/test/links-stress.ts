/**
 * 跨域联动压力测试。
 *
 * 核心断言是"反向替换":把改名后的文本里所有新名换回旧名,必须逐字节等于原文。
 * 这比"diff 行数对得上"强得多 —— 只要多动了一个空格、吃掉一个注释,断言就失败。
 *
 * 用法:
 *   node links-stress.ts rename [--root <path>] [--limit N]
 *   node links-stress.ts xy     [--root <path>]
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLinkGraph, refsOf, defsOf, type LinkRoot, type SymKind } from '../../engine/src/links.ts'
import { planRename, planXySync, type FilePatch } from '../../engine/src/rename.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'rename'
const roots: LinkRoot[] = []
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--root') {
    const p = args[++i]
    roots.push({ name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p })
  }
}
const DEFAULT_ROOTS: LinkRoot[] = [
  { name: 'vanilla', path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV' },
  { name: 'KR', path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605' },
  { name: 'RT56', path: 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/820260968' },
]
if (!roots.length) roots.push(...DEFAULT_ROOTS)
const limit = parseInt(flag('--limit') ?? '0', 10) || Infinity

console.log('════════ 跨域联动压力测试 ════════')
for (const r of roots) console.log(`  ${r.name}  ${r.path}`)
const g = buildLinkGraph(roots, { sprites: false })
console.log(`图: ${g.stats.defs} 定义 / ${g.stats.refs} 引用 / ${g.stats.dangling} 悬空\n`)

function flag(n: string): string | undefined {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * 词边界替换,避免 tab_1 误伤 tab_10。
 * 右侧只排除字母数字、**不排除下划线** —— 引用键带后缀(tab_1_visible),
 * 排除下划线的话带后缀的那几处根本不会被替换,断言就假失败了。
 */
function replaceWord(text: string, from: string, to: string): string {
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc(from)}(?![A-Za-z0-9])`, 'g')
  return text.replace(re, to)
}
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Case {
  label: string
  root: number
  file: string
  from: string
  to: string
  src: string
  out: string
}

function check(c: Case, bad: string[]): void {
  // 反向替换必须逐字节还原 —— 这一条足以证明"除改名外没动任何其他字节":
  // 多一个空格、吞掉一个注释、改错一处缩进,都会被它抓出来。
  const back = replaceWord(c.out, c.to, c.from)
  if (back !== c.src) {
    bad.push(`${c.label} ${c.file}: 反向替换不匹配(有附带损伤)`)
  }
}

function collectCases(patches: FilePatch[], pairs: { from: string; to: string }[]): Case[] {
  const out: Case[] = []
  for (const p of patches) {
    const src = readFileSync(join(g.roots[p.root].path, p.file), 'utf8')
    for (const pair of pairs) {
      out.push({ label: '', root: p.root, file: p.file, from: pair.from, to: pair.to, src, out: p.text })
    }
  }
  return out
}

if (cmd === 'rename') {
  // 取所有"被 scripted_gui 引用过的 gui_element" —— 这些是联动的真实战场
  const targets: { def: (typeof g.defs)[number]; refs: number }[] = []
  const seen = new Set<string>()
  for (const r of g.refs) {
    if (r.target !== 'gui_element') continue
    if (seen.has(r.name)) continue
    seen.add(r.name)
    const def = defsOf(g, 'gui_element', r.name)[0]
    if (!def) continue
    const n = refsOf(g, 'gui_element', r.name).length
    targets.push({ def, refs: n })
  }
  targets.sort((a, b) => b.refs - a.refs)

  console.log(`可重命名目标 ${targets.length} 个(按引用数排序),取前 ${limit === Infinity ? '全部' : limit} 个\n`)
  let ok = 0
  let guardFail = 0
  let warn = 0
  const bad: string[] = []
  let changed = 0
  let withNotes = 0
  const noteSamples: string[] = []
  const t0 = Date.now()

  let n = 0
  for (const t of targets) {
    if (n++ >= limit) break
    const from = t.def.name
    const to = from + '_ren'
    const patches = planRename(g, t.def, to)
    // 每个文件应该改动:该文件里的引用数 + (定义在这文件里 ? 1 : 0)
    const perFile = new Map<string, number>()
    for (const r of refsOf(g, 'gui_element', from)) {
      const k = `${r.root}|${r.file}`
      perFile.set(k, (perFile.get(k) ?? 0) + 1)
    }
    const defK = `${t.def.root}|${t.def.file}`
    perFile.set(defK, (perFile.get(defK) ?? 0) + 1)

    for (const p of patches) {
      if (!p.guard.ok) {
        guardFail++
        bad.push(`守卫失败 ${g.roots[p.root].name}:${p.file} — ${p.guard.message}`)
        continue
      }
      if (p.warnings.length) {
        warn++
        bad.push(`警告 ${g.roots[p.root].name}:${p.file} — ${p.warnings.join('; ')}`)
      }
      const expect = perFile.get(`${p.root}|${p.file}`) ?? 0
      if (p.details.length !== expect) {
        bad.push(`${from} ${p.file}: 改动 ${p.details.length} 处,预期 ${expect} 处`)
      }
      if (p.notes.length) {
        withNotes++
        if (noteSamples.length < 6) noteSamples.push(`${from} → ${p.file} ${p.notes[0]}`)
      }
      changed += p.details.length
      // 定义处改的是 name 值;引用处可能带后缀(key)或整名(value)
      const cases = collectCases([p], [{ from, to }])
      for (const c of cases) {
        c.label = `rename ${from}`
        check(c, bad)
      }
      ok++
    }
  }
  console.log(`重命名用例: ${targets.slice(0, Math.min(n, limit)).length} 个符号`)
  console.log(`  文件补丁 ${ok} 个,改动 ${changed} 处`)
  console.log(`  守卫失败 ${guardFail} / 警告 ${warn}`)
  console.log(`  ${withNotes} 个文件存在"同名但未被联动"的文本(已提示,未自动改)`)
  for (const s of noteSamples) console.log(`    例: ${s}`)
  console.log(`  耗时 ${Date.now() - t0} ms`)
  report(bad)
} else if (cmd === 'xy') {
  // properties.<元素> = { x= y= } 覆盖:模拟"拖动元素后同步坐标"
  const ovs = g.refs.filter((r) => r.override?.x !== undefined || r.override?.y !== undefined)
  const force = args.includes('--force')
  console.log(`位置覆盖 ${ovs.length} 处${force ? '(force: 允许覆盖动态绑定)' : ''}\n`)
  const bad: string[] = []
  let ok = 0
  let changed = 0
  let guardFail = 0
  let dynamic = 0
  for (const ov of ovs.slice(0, limit)) {
    const cur = { x: parseFloat(ov.override?.x ?? '0'), y: parseFloat(ov.override?.y ?? '0') }
    const nx = Number.isFinite(cur.x) ? cur.x + 7 : 7
    const ny = Number.isFinite(cur.y) ? cur.y + 13 : 13
    const patches = planXySync(g, [{ ref: ov, x: nx, y: ny, force }])
    for (const p of patches) {
      if (!p.guard.ok) {
        guardFail++
        bad.push(`守卫失败 ${p.file}: ${p.guard.message}\n${p.diff}`)
        continue
      }
      // 非 force 下"绑定了动态值"是预期行为,只统计、不算失败
      dynamic += p.warnings.filter((w) => w.includes('动态值')).length
      if (!force) {
        const real = p.warnings.filter((w) => !w.includes('动态值'))
        if (real.length) bad.push(`警告 ${p.file}: ${real.join('; ')}`)
      }
      changed += p.details.length
      // 行级反向替换:把被改的那一行换回原值,整文应逐字节等于原文。
      // 数字不能做全文替换(会误伤同值的其他字段),所以只动改动行。
      const src = readFileSync(join(g.roots[p.root].path, p.file), 'utf8')
      const srcLines = src.split('\n')
      const outLines = p.text.split('\n')
      let inserted = 0
      for (const d of p.details) {
        if (d.from === '(缺失)') {
          inserted++
          continue
        }
        const i = d.line - 1
        if (i >= 0 && i < outLines.length) outLines[i] = replaceWord(outLines[i], d.to, d.from)
      }
      if (!inserted && srcLines.length === outLines.length && outLines.join('\n') !== src) {
        bad.push(`${ov.name} ${p.file}: 行级反向替换不匹配(有附带损伤)`)
      }
      const diffLines = p.diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'))
      if (diffLines.length > p.details.length * 2) {
        bad.push(`${ov.name} ${p.file}: 差异行数 ${diffLines.length} 超过预期 ${p.details.length * 2}`)
      }
      ok++
    }
  }
  console.log(`  文件补丁 ${ok} 个,改动 ${changed} 处,守卫失败 ${guardFail}`)
  console.log(`  动态绑定拦截 ${dynamic} 处${force ? '(已 force 覆盖)' : '(拒绝写入,仅提示)'}`)
  report(bad)
} else {
  console.error(`未知命令: ${cmd}`)
  process.exit(1)
}

function report(bad: string[]): void {
  if (!bad.length) {
    console.log('\n✅ 全部通过:反向替换逐字节还原,无守卫失败、无附带损伤')
    return
  }
  console.log(`\n❌ ${bad.length} 个问题:`)
  for (const b of bad.slice(0, 25)) console.log(`  ${b}`)
  if (bad.length > 25) console.log(`  … 还有 ${bad.length - 25} 条`)
  process.exitCode = 1
}
