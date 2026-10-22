/**
 * 字段真实统计 —— 内容生成器的判据来源。
 *
 * ★ 为什么要有这个模块:生成器的字段列表以前是手写镜像,和游戏真实结构对不上,
 *   已经出过 5 处静默失效的硬错误(见 gen.ts 里fix#1..#5 的注释与证据)。
 *   这里的每个键、每个枚举取值都来自**实际扫描原版 + 模组**,
 *   原版更新后重新统计即可,不会像手写表那样悄悄漂移。
 *
 * 输出两类东西:
 *   ① entries —— 每个内容类型下"条目层"允许出现的键 + 频次(决定结构合法性)
 *   ② enums   —— 少量适合枚举的字段的真实取值(area / type / category 等),
 *               给表单做下拉,新手不用猜
 *
 * 层级约定(按 vanilla 缩进实测,见 gen.ts 注释):
 *   focus      focus_tree > country | focus     → 条目层 = focus_tree 下的 focus
 *   decision   category > decision              → 条目层 = category 下的直接块
 *   technology technologies > <id>              → 条目层 = technologies 下的直接块
 *   idea       ideas > country > <id>           → 条目层 = country 下的直接块
 *   equipment  equipments > <id>                → 条目层 = equipments 下的直接块
 *   event      <type> > <id>                    → 条目层 = type 下的直接块
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

export interface StatRoot {
  name: string
  path: string
}

export type GenKind = 'focus' | 'event' | 'decision' | 'technology' | 'idea' | 'equipment' | 'country'

export interface FieldStat {
  key: string
  /** 出现该键的条目数 */
  n: number
  /** 是块(而非标量) */
  isBlock?: boolean
  /** 是标量(而非块)。两者皆true = 原版两种形态都出现过 */
  isScalar?: boolean
  /** 该键的原版取值样本(标量键),最多 3 个,用于提示合法写法 */
  samples?: string[]
}

export interface EnumStat {
  key: string
  /** 真实取值全集(按频次降序)。校验用全量,UI 只展示前若干个。 */
  values: string[]
  /** 取值总数 */
  total: number
}

export interface KindStat {
  kind: GenKind
  /** 条目总数 */
  entries: number
  /** 条目层允许的键 */
  fields: FieldStat[]
  /** 顶层键(用于校验生成器的最外层块名) */
  topKeys: string[]
  /** 适合枚举的字段取值 */
  enums: Record<string, EnumStat>
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
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
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

/** 枚举统计白名单:只有这些键收集取值(其余键取值是自由文本,收集没意义) */
const ENUM_KEYS = new Set([
  'area',
  'type',
  'group_by',
  'interface_category',
  'technology',
  'slot',
])

/**
 * ★ 科技领域名的真实位置是 `categories = { <名字> }` —— 裸值列表,
 *   键名是 categories 而不是 area(area 是 UI 侧的叫法)。
 *   实测 105 个取值:naval_equipment 116 / armor 83 / air_equipment 73 / industry 43 …
 *   所以要按"块内裸值"单独收集,ENUM_KEYS 那套(按键名)抓不到它。
 */
const BARE_VALUE_KEYS = new Set(['categories'])

/** 每个类型的目录与"进入条目层"的路径(相对于顶层块) */
const LAYOUT: Record<
  GenKind,
  { dirs: string[]; /** 顶层块名候选,null 表示顶层块名本身是变量(如事件 type) */ topKeys: string[]; /** 从顶层块往下钻几层到条目层 */ drill: string[] }
> = {
  focus: { dirs: ['common/national_focus'], topKeys: ['focus_tree', 'shared_focus'], drill: [] },
  decision: { dirs: ['common/decisions'], topKeys: [], drill: [] },
  technology: { dirs: ['common/technologies'], topKeys: ['technologies'], drill: [] },
  idea: { dirs: ['common/ideas'], topKeys: ['ideas'], drill: ['country'] },
  equipment: { dirs: ['common/units/equipment'], topKeys: ['equipments'], drill: [] },
  event: { dirs: ['events'], topKeys: [], drill: [] },
}

interface Acc {
  entries: number
  fields: Map<string, { n: number; isBlock: boolean; isScalar: boolean; samples: string[] }>
  topKeys: Map<string, number>
  enums: Map<string, Map<string, number>>
}

/** 在条目层里收集字段 */
function scanEntryBlock(doc: Document, b: Block, acc: Acc): void {
  acc.entries++
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue // 裸值(列表项),不是字段名
    const isBlock = !!e.block
    const prev = acc.fields.get(k)
    if (prev) {
      prev.n++
      prev.isBlock = prev.isBlock || isBlock
      prev.isScalar = prev.isScalar || !isBlock
    } else {
      acc.fields.set(k, { n: 1, isBlock, isScalar: !isBlock, samples: [] })
    }
    // ★ 记标量取值样本:用来判"键名对但形态错"(如 active 该是 yes/no 却被写成块)
    if (!isBlock) {
      const rec = acc.fields.get(k)!
      if (rec.samples.length < 3) {
        const v = valueText(doc, e).trim()
        if (v && v.length <= 30) rec.samples.push(v)
      }
    }
    if (ENUM_KEYS.has(k) || BARE_VALUE_KEYS.has(k)) {
      // 只收"块的裸值列表"(如 categories = { land_doctrine }),或标量值
      if (e.block) {
        let m = acc.enums.get(k)
        if (!m) acc.enums.set(k, (m = new Map()))
        for (const c of e.block.entries) {
          const v = keyText(doc, c) ?? valueText(doc, c)
          if (v) m.set(v, (m.get(v) ?? 0) + 1)
        }
      } else if (ENUM_KEYS.has(k)) {
        const v = valueText(doc, e)
        if (v && v.length < 40) {
          let m = acc.enums.get(k)
          if (!m) acc.enums.set(k, (m = new Map()))
          m.set(v, (m.get(v) ?? 0) + 1)
        }
      }
    }
  }
}

function scanKind(kind: GenKind, roots: StatRoot[]): Acc {
  const acc: Acc = { entries: 0, fields: new Map(), topKeys: new Map(), enums: new Map() }
  const lay = LAYOUT[kind]
  for (const r of roots) {
    for (const d of lay.dirs) {
      for (const file of walk(join(r.path, d), ['.txt'])) {
        let doc: Document
        try {
          doc = parse(readFileSync(file, 'utf8'))
        } catch {
          continue
        }
        for (const top of doc.root.entries) {
          const tk = keyText(doc, top)
          if (!tk) continue
          acc.topKeys.set(tk, (acc.topKeys.get(tk) ?? 0) + 1)

          if (lay.topKeys.length && !lay.topKeys.includes(tk)) continue

          // 事件:顶层块名是变量(type),直接就是条目层
          if (kind === 'event') {
            if (top.block) scanEntryBlock(doc, top.block, acc)
            continue
          }
          if (kind === 'decision') {
            // category > decision
            if (!top.block) continue
            for (const cat of top.block.entries) {
              if (cat.block) scanEntryBlock(doc, cat.block, acc)
            }
            continue
          }
          if (!top.block) continue

          // 需要继续 drill 的类型(idea: ideas > country > <id>)
          if (lay.drill.length) {
            let cur: Block | undefined = top.block
            for (const step of lay.drill) {
              const f = cur.entries.find((x) => keyText(doc, x) === step)
              cur = f?.block
              if (!cur) break
            }
            if (!cur) continue
            for (const e of cur.entries) if (e.block) scanEntryBlock(doc, e.block, acc)
            continue
          }

          // 其余类型:顶层块下直接就是条目层
          for (const e of top.block.entries) if (e.block) scanEntryBlock(doc, e.block, acc)
        }
      }
    }
  }
  return acc
}

function toKindStat(kind: GenKind, acc: Acc): KindStat {
  const fields: FieldStat[] = [...acc.fields.entries()]
    .map(([key, v]) => ({
      key,
      n: v.n,
      isBlock: v.isBlock,
      isScalar: v.isScalar,
      samples: v.samples.length ? v.samples : undefined,
    }))
    .sort((a, b) => b.n - a.n)
  const enums: Record<string, EnumStat> = {}
  for (const [key, m] of acc.enums) {
    /* ⚠ 截断会造成**假报错**:实测equipment 的 type 真实取值 30+ 个,
     *   若只留频次前 60 名(更长的列表会被砍),用户填一个真实但冷门的值
     *   就会被判"不在原版取值里"。所以:
     *   保留全部取值,并另存 total —— UI 展示前 N 个,校验用全量。 */
    const values = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
    if (values.length) enums[key] = { key, values, total: values.length }
  }
  return {
    kind,
    entries: acc.entries,
    fields,
    topKeys: [...acc.topKeys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
    enums,
  }
}

export interface FieldStats {
  /** 每个内容类型的统计 */
  kinds: Record<string, KindStat>
  /** 扫描了多少文件 */
  files: number
  /** 扫描耗时毫秒 */
  ms: number
}

export function buildFieldStats(roots: StatRoot[]): FieldStats {
  const t0 = Date.now()
  const kinds: Record<string, KindStat> = {}
  let files = 0
  for (const kind of Object.keys(LAYOUT) as GenKind[]) {
    kinds[kind] = toKindStat(kind, scanKind(kind, roots))
  }
  for (const kind of Object.keys(LAYOUT) as GenKind[]) {
    for (const d of LAYOUT[kind].dirs) for (const r of roots) files += walk(join(r.path, d), ['.txt']).length
  }
  return { kinds, files, ms: Date.now() - t0 }
}