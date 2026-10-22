/**
 * 从游戏自带 <root>/documentation/*.md 抽取【全量】官方机制条目,
 * 生成 packages/engine/src/official-docs.gen.ts。
 *
 * 【为什么需要】原先 official-docs.ts 是 325 条手写种子,而游戏目录里躺着
 * 26510 行官方手册,实测可解析出 3256 条带作用域标注的真实条目。手写种子
 * 覆盖率不到 10%,且无法回答"这个 effect 能在哪些作用域用"这个模组作者
 * 最常问的问题。
 *
 * 复用 packages/gui/src/docs.ts 的 parseOfficial —— 它已经把
 * `## Effects for scope COUNTRY` / `## add_ace` / `Supported Scopes:` 全解析好了,
 * 不必再造一套 markdown 解析器(踩坑经验:同一个格式写两遍必有一遍是错的)。
 *
 * 用法:
 *   node gen_official_docs.ts
 *   node gen_official_docs.ts --check     # 只校验不写盘(供 CI/验收)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { scanOfficial, parseOfficial } from '../packages/gui/src/docs.ts'

const GAME_DIR =
  process.argv.find((a) => a.startsWith('--game='))?.slice(7) ??
  'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const OUT = 'packages/engine/src/official-docs.gen.ts'
const CHECK_ONLY = process.argv.includes('--check')

/** 手册名 → 条目类型。docs.ts 只管解析,语义归类在这里定。 */
const KIND_OF: Record<string, 'effect' | 'trigger' | 'scope' | 'modifier' | 'other'> = {
  Effects: 'effect',
  Triggers: 'trigger',
  Modifiers: 'modifier',
  'Dynamic Variables': 'scope',
  'Script Math Functions': 'other',
  'Console Commands': 'other',
  'Localization Formatters': 'other',
  'Localization Objects': 'other',
  'Script Collection Input': 'other',
  'Script Collection Operator': 'other',
  'Script Concepts': 'other',
}

interface Row {
  name: string
  type: string
  /** 该条目在官方手册里声明的适用作用域(逗号分隔),无则空 */
  scopes: string[]
  /** 一句话摘要(正文第一行) */
  summary: string
  /** 出处手册名 */
  book: string
}

/** 正文 → 一句话摘要:优先取首个围栏代码块外的首行,否则取围栏内首行 */
function summarize(body: string): string {
  let t = body
    .replace(/^```[\s\S]*?^```/m, '') // 去掉完整围栏块
    .replace(/```[a-z]*\n?/g, ' ') // 去掉残余围栏标记
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/^\s*\*.*$/gm, ' ')
    .replace(/^\s*\|.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) {
    t = body
      .replace(/```[a-z]*\n?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (t.length > 110) t = t.slice(0, 108).trimEnd() + '…'
  return t
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')
}

function main(): void {
  if (!existsSync(GAME_DIR)) {
    console.error('✗ 找不到游戏目录:', GAME_DIR)
    process.exit(1)
  }
  const roots = [{ path: GAME_DIR, name: 'vanilla' }]
  const files = scanOfficial(roots)
  if (!files.length) {
    console.error('✗ 未找到 documentation/*.md,游戏路径可能不对:', GAME_DIR)
    process.exit(1)
  }

  // name(小写) → Row,同名条目跨手册合并(Scopes/Targets 求并集)
  const byName = new Map<string, Row & { bookSet: Set<string> }>()
  const perBook: Record<string, number> = {}
  const perType: Record<string, number> = {}

  for (const f of files) {
    const src = readFileSync(join(GAME_DIR, f.rel), 'utf8')
    const doc = parseOfficial(src, f)
    const type = KIND_OF[f.name] ?? 'other'
    perBook[f.name] = doc.flat.length
    for (const e of doc.flat) {
      // 条目名可能是 `limit = PAYLOAD` 这类占位形态,或 <Building>_max_level_terrain_limit
      // 这类模板形态。占位形态无法直接用于补全前缀匹配,保留但只作展示。
      const name = e.name.trim()
      if (!name) continue
      const key = name.toLowerCase()
      const scopeList = e.scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const row = byName.get(key)
      if (row) {
        for (const s of scopeList) if (!row.scopes.includes(s)) row.scopes.push(s)
        row.bookSet.add(f.name)
        if (!row.summary) row.summary = summarize(e.body)
      } else {
        byName.set(key, {
          name,
          type,
          scopes: scopeList,
          summary: summarize(e.body),
          book: f.name,
          bookSet: new Set([f.name]),
        })
        perType[type] = (perType[type] ?? 0) + 1
      }
    }
  }

  const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))

  console.log('── 手册条目数 ──')
  for (const [k, v] of Object.entries(perBook).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`)
  }
  console.log('── 去重后按类型 ──')
  for (const [k, v] of Object.entries(perType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`)
  }
  const withScopes = rows.filter((r) => r.scopes.length).length
  console.log(`合计 ${rows.length} 条,其中带作用域标注 ${withScopes} 条`)
  console.log('出处分布:', [...new Set(rows.flatMap((r) => [...r.bookSet]))].join(' | '))

  const gen = render(rows, perBook)
  if (CHECK_ONLY) {
    let old = ''
    try { old = readFileSync(OUT, 'utf8') } catch { /* 视为不一致 */ }
    if (old !== gen) {
      console.error('✗ 生成的 official-docs.gen.ts 与磁盘不一致,需重新运行生成器')
      process.exit(1)
    }
    console.log('✓ 生成物与磁盘一致')
    return
  }
  writeFileSync(OUT, gen, 'utf8')
  console.log('✓ 已写入', OUT, `(${(gen.length / 1024).toFixed(1)} KB)`)
}

function render(rows: (Row & { bookSet: Set<string> })[], perBook: Record<string, number>): string {
  const L: string[] = []
  L.push('/**')
  L.push(' * 全量官方机制关键字 —— 【自动生成,请勿手改】')
  L.push(' *')
  L.push(' * 数据源:游戏本体 <root>/documentation/*.md(Paradox 随游戏发布的官方手册)。')
  L.push(' * 由 gen_official_docs.ts 抽取,重新生成:')
  L.push(' *   node gen_official_docs.ts')
  L.push(' *')
  L.push(' * 与手写 official-docs.ts 的关系:')
  L.push(' *   本文件是【全量数据】,由官方手册逐条解析而来,带作用域标注;')
  L.push(' *   official-docs.ts 保留少量手写条目作为兜底(手册缺项时的补充)。')
  L.push(' *')
  L.push(' * 各手册解析出的原始条目数:')
  for (const [k, v] of Object.entries(perBook).sort((a, b) => b[1] - a[1])) {
    L.push(` *   ${k.padEnd(28)} ${v}`)
  }
  L.push(' */')
  L.push('')
  L.push('export type GenOfficialType =')
  L.push("  | 'effect'")
  L.push("  | 'trigger'")
  L.push("  | 'scope'")
  L.push("  | 'modifier'")
  L.push("  | 'other'")
  L.push('')
  L.push('export interface GenOfficialEntry {')
  L.push('  name: string')
  L.push('  type: GenOfficialType')
  L.push('  /** 官方声明的适用作用域;空数组表示手册未标注 */')
  L.push('  scopes: string[]')
  L.push('  summary: string')
  L.push('  /** 出处手册名(同名条目可能多本) */')
  L.push('  books: string[]')
  L.push('}')
  L.push('')
  const byType: Record<string, (Row & { bookSet: Set<string> })[]> = {}
  for (const r of rows) (byType[r.type] ??= []).push(r)
  for (const t of ['effect', 'trigger', 'scope', 'modifier', 'other'] as const) {
    const list = byType[t] ?? []
    L.push(`export const GEN_${t.toUpperCase()}S: GenOfficialEntry[] = [`)
    for (const r of list) {
      L.push(
        `  { name: '${esc(r.name)}', type: '${t}', scopes: [${r.scopes
          .map((s) => `'${esc(s)}'`)
          .join(', ')}], summary: '${esc(r.summary)}', books: [${[...r.bookSet]
          .map((b) => `'${esc(b)}'`)
          .join(', ')}] },`,
      )
    }
    L.push(']')
    L.push('')
  }
  L.push('export const GEN_OFFICIAL_ALL: GenOfficialEntry[] = [')
  L.push('  ...GEN_EFFECTS,')
  L.push('  ...GEN_TRIGGERS,')
  L.push('  ...GEN_SCOPES,')
  L.push('  ...GEN_MODIFIERS,')
  L.push('  ...GEN_OTHERS,')
  L.push(']')
  L.push('')
  return L.join('\n')
}

main()
