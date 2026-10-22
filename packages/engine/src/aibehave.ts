/**
 * AI 行为模型(common/ai_*)。
 *
 * ★ 为什么单独做一个模块:
 *   HOI4 的 AI 内容不是"一种数据结构",而是散落在 common/ 下若干个以 `ai_`
 *   开头的目录/文件里,每个目录的字段语义完全不同(战略 / 计划 / 师模板 /
 *   舰队 / 态度 / 性格 …)。模组制作者要排查"AI 为什么这么打"时,第一步永远是
 *   "这个目录里有哪些文件、每个文件写了什么"——所以本模块按
 *   **方面(目录) → 文件 → 条目** 三级归纳,而不是硬编码某一套字段。
 *
 * 三级结构:
 *   aspect  ai_strategy / ai_strategy_plans / ai_templates / ai_navy … (含子目录)
 *   file    逐个文件(用户明确要求"一般以逐个文件的方式归纳")
 *   entry   文件内的顶层条目(或容器内的条目,如 ai_areas 的 areas = { … })
 *
 * 设计取舍:
 *  - 字段语义**不做硬编码校验**(那是 cwt-check 的活),这里只统计"出现了什么"
 *    并给出该方面的字段画像 —— 画像本身就是"这个目录通常怎么写"的答案;
 *  - 容器(container)只按白名单下钻一层,避免把 `ai_strategy = { type= … }`
 *    这类重复子块误当成条目;
 *  - 同名条目跨来源的定义链要全记住,才能区分"模组新增"与"模组改写"。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'

export interface AiRootRef {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/** 条目内的标量字段(展示用,顺序即优先级) */
export interface AiScalar {
  k: string
  v: string
}

/** 字段画像:某个方面里各字段的出现情况 */
export interface AiProfileRow {
  k: string
  /** 出现过该字段的**条目数**(不是出现总次数 —— 后者会被重复子块刷爆) */
  n: number
  scalar: number
  block: number
}

/** 一个条目(AI 策略 / 计划 / 模板 / 舰队 … 的最小可读单元) */
export interface AiEntry {
  id: string
  /** 条目类型:容器键名(如 areas)或子目录名(如 fleet),根目录下为空 */
  kind: string
  file: string
  line: number
  root: number
  rootName: string
  scalars: AiScalar[]
  /** 子块名 → 出现次数(同名重复块,如多次 ai_strategy = {}) */
  blocks: { k: string; n: number }[]
  /** 标志性脚本块(allowed / enable / ai_will_do …) */
  flags: string[]
  /** 本地化 key(name / desc / 标题类的纯 key 值) */
  loc: string
  /** ★ 顶层块 → 其直接子字段(一层),给"显示详情"用:知道每个块里到底填了什么 */
  subs: AiSubBlock[]
  /** ★ RAWS_V1:顶层块的**完整原文**(逐块,重复块各占一条,如多次 ai_strategy = {…})。
   *   前端详情直接展示 allowed / enable / abort / ai_strategy 等块的实际内容。 */
  raws: { k: string; text: string }[]
}

/** 一个子块里的一条字段 */
export interface AiSubField {
  k: string
  /** 标量值(块条目此字段为空) */
  v: string
  /** true = 该字段本身又是一个块(嵌套),详情里只列名字 */
  isBlock: boolean
}

/** 一个顶层块(如 ai_strategy)及其直接子字段 */
export interface AiSubBlock {
  k: string
  /** 该块在条目中出现的次数(同名重复块,如多次 ai_strategy = {}) */
  n: number
  /** 直接子字段(标量在前,块在后),已裁剪到 MAX_SUBFIELDS */
  items: AiSubField[]
}

/** 一个文件 */
export interface AiFileRec {
  /** 相对来源根的路径(正斜杠) */
  file: string
  root: number
  rootName: string
  /** 相对**方面目录**的子目录(ai_navy/fleet → 'fleet') */
  sub: string
  entries: AiEntry[]
  lines: number
  bytes: number
  /** 顶层键分布(该文件定义了哪些类型的条目) */
  topKeys: { k: string; n: number }[]
  parseError?: string
}

/** 一个方面(= common/ 下一个 ai_ 开头的目录,或一个 ai_*.txt 文件) */
export interface AiAspect {
  key: string
  label: string
  desc: string
  /** 散文件方面(ai_attitudes.txt)为 true,目录方面为 false */
  isFile: boolean
  files: AiFileRec[]
  entries: number
  /** 字段画像,按出现频次降序 */
  profile: AiProfileRow[]
  /** 官方说明文档(若 vanilla 目录里带了 _documentation.md) */
  docFile?: string
}

export interface AiBehaviorModel {
  aspects: AiAspect[]
  files: number
  entries: number
  /** 条目定义链:`方面/类型/id` → 所有定义位置(后加载的覆盖先加载的) */
  defs: Map<string, AiDef[]>
  /** 文件定义链:`方面/相对路径` → 哪些来源有同名文件(整文件覆盖) */
  fileDefs: Map<string, AiDef[]>
  ms: number
}

export interface AiDef {
  root: number
  file: string
  line: number
}

/* ══════════════════════════════════════════════════════════════════
 * 方面说明 —— 中文名 + 一句话释义。
 *
 * 只覆盖原版已知的 10 个方面;模组自己加的 ai_xxx 目录走通用兜底
 * (label 用目录名,desc 说明它是自定义目录),零硬编码失败。
 * ══════════════════════════════════════════════════════════════════ */
const AI_ASPECT_DOCS: Record<string, { label: string; desc: string }> = {
  ai_areas: {
    label: '战略区域组',
    desc: '把若干战略地区打包成一个「区域」(areas = { … }),供 AI 判断战场归属与兵力分配。',
  },
  ai_equipment: {
    label: '装备设计',
    desc: 'AI 的装备设计变体(坦克 / 飞机 / 舰船):分类 category、可用国家、角色 roles 与优先级 priority。',
  },
  ai_faction_theaters: {
    label: '阵营战区',
    desc: '阵营层面的战区划分:包含哪些战略地区 regions,以及何时 cancel 放弃该战区。',
  },
  ai_focuses: {
    label: '研究侧重',
    desc: 'AI 的国家侧重点(防守 / 进攻 / 战争生产 …),用 research 里的权重影响科技选择。',
  },
  ai_navy: {
    label: '海军行为',
    desc: '三个子目录:fleet 舰队模板(需要/可选哪些特遣队)、goals 海军目标、taskforce 特遣队编成。',
  },
  ai_strategy: {
    label: 'AI 战略',
    desc: '按国家写的策略条目(allowed / enable / abort 门控 + 一串 ai_strategy 子块),控制生产比例、部队角色、外交倾向。',
  },
  ai_strategy_plans: {
    label: '战略计划',
    desc: '完整的 AI 行为剧本:name / desc + allowed / enable / abort 条件 + 一系列目标(进攻谁、何时停)。',
  },
  ai_templates: {
    label: '师级模板',
    desc: 'AI 组建师的模板:role 角色、blocked_for 排除国家、upgrade_prio 升级优先级、编制构成。',
  },
  ai_attitudes: {
    label: 'AI 态度',
    desc: 'AI 对另一个国家可采取的态度,由 antagonize / annex / ally / ignore 等 flag 组合而成。',
  },
  ai_personalities: {
    label: 'AI 性格',
    desc: 'AI 性格总开关,用子块组合各类行为倾向(空块 = 完全默认)。',
  },
  ai_peace: {
    label: '和平会议',
    desc: '和平会议中 AI 对和谈选项(吞并 / 解放 / 傀儡 / 割地 / 改政体)的取舍。1.12 起在 common/peace_conference/ai_peace,旧版在 common/ai_peace。',
  },
}

/**
 * 容器白名单:这些键是一个"装着条目的盒子",要下钻一层才算条目。
 * ⚠ 只在**文件顶层恰好只有这一个 block** 时才下钻 —— 否则
 *   `ai_strategy = { type = role_ratio }` 这类重复子块会被误当条目。
 */
const CONTAINERS = new Set([
  'areas',
  'templates',
  'fleet_templates',
  'taskforce_templates',
  'taskforces',
  'goals',
  'strategies',
  'strategy_plans',
  'plans',
  'attitudes',
  'personalities',
  'ai_areas',
  'ai_templates',
  'peace_ai_desires',
])

/** 标志性脚本块:出现就值得在卡片上标一个 chip */
const FLAG_KEYS = [
  'allowed',
  'enable',
  'abort',
  'available',
  'available_for',
  'blocked_for',
  'ai_will_do',
  'ai_strategy',
  'modifier',
  'priority',
  'research',
  'cancel',
  'required_taskforces',
  'optional_taskforces',
]

/** 摘要里优先展示的标量字段(其余按出现顺序补齐) */
const SCALAR_PRIORITY = [
  'name',
  'desc',
  'type',
  'category',
  'role',
  'objective_type',
  'value',
  'factor',
  'priority',
  'min_priority',
  'max_priority',
  'keep_updated',
  'id',
]

const MAX_SCALARS = 10
const MAX_BLOCKS = 6
const MAX_SUBFIELDS = 10
const MAX_PROFILE = 12

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  const k = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === k && e.block) return e.block
  return undefined
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  const k = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === k) return valueText(doc, e)
  return undefined
}

/** valueText 对块条目返回 undefined,正好用来区分标量 / 块 */
function isScalarEntry(doc: Document, e: Entry): boolean {
  return !e.block && valueText(doc, e) !== undefined
}

/** 无损还原一个 Entry 的原文(含 `key =` 与整块),用于详情展示脚本块内容 */
function entryText(doc: Document, e: Entry): string {
  let s = ''
  for (let i = e.start; i < e.end; i++) s += doc.tokens[i].text
  return s.trim()
}

/**
 * 从条目块里归纳要点。
 * 只做统计与摘要,不判合法性 —— 同一份数据还要喂给 cwt-check,
 * 这里重复校验只会让两处规则漂移。
 */
function summarize(doc: Document, b: Block): {
  scalars: AiScalar[]
  blocks: { k: string; n: number }[]
  flags: string[]
  loc: string
  subs: AiSubBlock[]
  raws: { k: string; text: string }[]
} {
  const scalars: AiScalar[] = []
  const counts = new Map<string, number>()
  const flags: string[] = []
  const seenScalar = new Set<string>()
  let loc = ''

  const raws: { k: string; text: string }[] = []
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (e.block) {
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (FLAG_KEYS.includes(k.toLowerCase()) && !flags.includes(k)) flags.push(k)
      // RAWS_V1:逐块保留完整原文(重复块各占一条),供前端详情直接展示
      raws.push({ k, text: entryText(doc, e) })
      continue
    }
    const v = valueText(doc, e)
    if (v === undefined) continue
    if (seenScalar.has(k)) continue
    seenScalar.add(k)
    scalars.push({ k, v })
    if (!loc && (k.toLowerCase() === 'name' || k.toLowerCase() === 'desc') && !/[\s]/.test(v)) loc = v
  }

  // 标量按优先级排序,保证 name/desc/type 这些"一眼能认出"的排在前面
  const rank = (k: string) => {
    const i = SCALAR_PRIORITY.indexOf(k.toLowerCase())
    return i < 0 ? SCALAR_PRIORITY.length : i
  }
  scalars.sort((a, b2) => rank(a.k) - rank(b2.k))
  const blocks = [...counts.entries()]
    .map(([k, n]) => ({ k, n }))
    .sort((a, b2) => b2.n - a.n || a.k.localeCompare(b2.k))

  // 顶层块 → 直接子字段(一层):让"显示详情"能看到每个块里具体填了什么值。
  // 标量字段与嵌套块都列出来,同一字段只取第一次出现(与 scalars 同口径,避免重复块刷爆)。
  const subs: AiSubBlock[] = []
  for (const { k, n } of blocks) {
    const blk = childBlock(doc, b, k)
    const items: AiSubField[] = []
    if (blk) {
      const seen = new Set<string>()
      for (const ce of blk.entries) {
        const ck = keyText(doc, ce)
        if (ce.block) {
          // 嵌套块(如 allowed = { ... })—— 只列名字
          const name = ck || '(块)'
          if (seen.has('#' + name)) continue
          seen.add('#' + name)
          items.push({ k: name, v: '', isBlock: true })
        } else {
          const cv = valueText(doc, ce)
          if (cv === undefined) continue
          // 列表式块(如 strategic_regions = { 10638 10639 })没有键,值是裸 token —— 直接列出值
          const name = ck || cv
          if (seen.has(name)) continue
          seen.add(name)
          items.push({ k: name, v: ck ? cv : '', isBlock: false })
        }
        if (items.length >= MAX_SUBFIELDS) break
      }
    }
    subs.push({ k, n, items: items.slice(0, MAX_SUBFIELDS) })
  }

  return {
    scalars: scalars.slice(0, MAX_SCALARS),
    blocks: blocks.slice(0, MAX_BLOCKS),
    flags,
    loc,
    subs,
    raws,
  }
}

/** 递归收集 .txt(跳过 _documentation.md 之类的说明文件由调用方处理) */
function walkTxt(dir: string): string[] {
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
    if (st.isDirectory()) out.push(...walkTxt(p))
    else if (it.toLowerCase().endsWith('.txt')) out.push(p)
  }
  return out
}

export function buildAiBehavior(roots: AiRootRef[]): AiBehaviorModel {
  const t0 = Date.now()
  const aspects = new Map<string, AiAspect>()
  const defs = new Map<string, AiDef[]>()
  const fileDefs = new Map<string, AiDef[]>()
  let fileCount = 0
  let entryCount = 0

  const getAspect = (key: string, isFile: boolean): AiAspect => {
    let a = aspects.get(key)
    if (!a) {
      const d = AI_ASPECT_DOCS[key]
      a = {
        key,
        label: d?.label ?? key,
        desc: d?.desc ?? `以 ai_ 开头的${isFile ? '配置' : '内容'}目录(模组自定义方面),按文件归纳其中的条目。`,
        isFile,
        files: [],
        entries: 0,
        profile: [],
      }
      aspects.set(key, a)
    }
    return a
  }

  /**
   * 字段画像累加器:方面 → 字段名 → { 条目数, 标量次数, 块次数 }
   *
   * ⚠ 三个数的口径不同,别合并:
   *   n      = 有多少个**条目**用了这个字段(判断"这是不是该方面的常规字段")
   *   scalar = 标量写法的总次数
   *   block  = 块写法的总次数(如一个条目里写 12 次 ai_strategy = {})
   * 若把 block 次数也算进 n,单个"大条目"就能把画像刷爆(ai_strategy 亲测 4274)。
   */
  const profileAcc = new Map<string, Map<string, AiProfileRow>>()
  const bump = (aspectKey: string, k: string, scalar: number, block: number) => {
    let m = profileAcc.get(aspectKey)
    if (!m) {
      m = new Map()
      profileAcc.set(aspectKey, m)
    }
    let row = m.get(k)
    if (!row) {
      row = { k, n: 0, scalar: 0, block: 0 }
      m.set(k, row)
    }
    row.n++
    row.scalar += scalar
    row.block += block
  }

  /**
   * 解析并归纳单个文件。
   * ⚠ 声明在 roots.forEach **之前**:顶层语句不要依赖文件后部的声明。
   */
  const addFile = (aspect: AiAspect, r: AiRootRef, ri: number, abs: string, rel: string, subDir: string) => {
    // 文件级覆盖链:HOI4 同名相对路径是整文件替换,所以按 方面/路径 记
    const fk = `${aspect.key}/${rel}`
    const fdl = fileDefs.get(fk) ?? []
    fdl.push({ root: ri, file: rel, line: 1 })
    fileDefs.set(fk, fdl)
    let src = ''
    try {
      src = readFileSync(abs, 'utf8')
    } catch {
      return
    }
    // BOM 会让第一个 key 变成 "\uFEFFxxx"
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
    let doc: Document
    try {
      doc = parse(src)
    } catch (e) {
      aspect.files.push({
        file: rel,
        root: ri,
        rootName: r.name,
        sub: subDir,
        entries: [],
        lines: src.split('\n').length,
        bytes: src.length,
        topKeys: [],
        parseError: String(e),
      })
      fileCount++
      return
    }

    const rec: AiFileRec = {
      file: rel,
      root: ri,
      rootName: r.name,
      sub: subDir,
      entries: [],
      lines: src.split('\n').length,
      bytes: src.length,
      topKeys: [],
    }

    /* 容器下钻:文件顶层恰好只有一个 block,且键名在容器白名单里。
     * ai_areas/default.txt 的 areas = { scandinavia = { … } } 就是这种情况。 */
    let scope: Block = doc.root
    let containerKey = ''
    const topBlocks = doc.root.entries.filter((e) => e.block)
    if (topBlocks.length === 1) {
      const ck = keyText(doc, topBlocks[0])
      if (ck && CONTAINERS.has(ck.toLowerCase())) {
        scope = topBlocks[0].block!
        containerKey = ck
      }
    }

    const topCounts = new Map<string, number>()
    for (const e of scope.entries) {
      const k = keyText(doc, e)
      if (!k) continue
      topCounts.set(k, (topCounts.get(k) ?? 0) + 1)
      if (!e.block) continue
      const b = e.block!
      const { scalars, blocks, flags, loc, subs, raws } = summarize(doc, b)
      const id = childValue(doc, b, 'id') ?? k
      const kind = containerKey || subDir || ''
      rec.entries.push({
        id,
        kind,
        file: rel,
        line: lineOf(doc, e),
        root: ri,
        rootName: r.name,
        scalars,
        blocks,
        flags,
        loc,
        subs,
        raws,
      })
      // 条目级覆盖链:同 id 跨来源多次定义 ⇒ 能区分"模组新增"与"模组改写"
      const ek = `${aspect.key}/${kind}/${id}`
      const dl = defs.get(ek) ?? []
      dl.push({ root: ri, file: rel, line: lineOf(doc, e) })
      defs.set(ek, dl)
      // 字段画像:先在本条目内按字段名聚合,再并入方面 —— n 才是"条目数"
      const fieldAcc = new Map<string, { s: number; b: number }>()
      for (const fe of b.entries) {
        const fk2 = keyText(doc, fe)
        if (!fk2) continue
        const cur = fieldAcc.get(fk2) ?? { s: 0, b: 0 }
        if (fe.block) cur.b++
        else cur.s++
        fieldAcc.set(fk2, cur)
      }
      for (const [fk2, c] of fieldAcc) bump(aspect.key, fk2, c.s, c.b)
      entryCount++
    }
    rec.topKeys = [...topCounts.entries()]
      .map(([k, n]) => ({ k, n }))
      .sort((a, b2) => b2.n - a.n || a.k.localeCompare(b2.k))
      .slice(0, 6)
    aspect.files.push(rec)
    aspect.entries += rec.entries.length
    fileCount++
  }

  roots.forEach((r, ri) => {
    const commonDir = join(r.path, 'common')
    let entries: string[] = []
    try {
      entries = readdirSync(commonDir)
    } catch {
      return
    }

    /* ① 目录方面:common/ai_xxx/(递归子目录归入同一方面) */
    for (const it of entries) {
      if (!it.toLowerCase().startsWith('ai_')) continue
      const absDir = join(commonDir, it)
      let st
      try {
        st = statSync(absDir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const aspect = getAspect(it, false)
      // 官方自带的 _documentation.md 挂到方面上,供页面跳转
      const docAbs = join(absDir, '_documentation.md')
      if (!aspect.docFile) {
        try {
          if (statSync(docAbs).isFile()) aspect.docFile = relative(r.path, docAbs).replace(/\\/g, '/')
        } catch {
          /* 没有就算了 */
        }
      }
      for (const abs of walkTxt(absDir)) {
        const rel = relative(r.path, abs).replace(/\\/g, '/')
        // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
        if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
        const sub = relative(absDir, abs).replace(/\\/g, '/')
        const subDir = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : ''
        addFile(aspect, r, ri, abs, rel, subDir)
      }
    }

    /* ② 和平会议 AI(1.12+):common/peace_conference/ai_peace/*.txt ——
     * 不在 common 顶层,不能走 ① 的 ai_ 目录扫描,单独补上。 */
    try {
      const pcDir = join(commonDir, 'peace_conference', 'ai_peace')
      if (statSync(pcDir).isDirectory()) {
        const aspect = getAspect('ai_peace', false)
        const docAbs = join(pcDir, '_documentation.md')
        if (!aspect.docFile) {
          try {
            if (statSync(docAbs).isFile()) aspect.docFile = relative(r.path, docAbs).replace(/\\/g, '/')
          } catch { /* 没有就算了 */ }
        }
        for (const abs of walkTxt(pcDir)) {
          const rel = relative(r.path, abs).replace(/\\/g, '/')
          // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
          if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
          addFile(aspect, r, ri, abs, rel, 'peace_conference/ai_peace')
        }
      }
    } catch { /* 老版本没有这个目录 */ }
    /* ② 散文件方面:common/ai_attitudes.txt 之类 */
    for (const it of entries) {
      if (!it.toLowerCase().startsWith('ai_') || !it.toLowerCase().endsWith('.txt')) continue
      const abs = join(commonDir, it)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      const key = it.replace(/\.txt$/i, '')
      const aspect = getAspect(key, true)
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
      addFile(aspect, r, ri, abs, rel, '')
    }
  })


  /* 方面排序:已知的按表内顺序(更有讲解性),未知的按条目数降序 */
  const knownOrder = Object.keys(AI_ASPECT_DOCS)
  const list = [...aspects.values()].sort((a, b) => {
    const ia = knownOrder.indexOf(a.key)
    const ib = knownOrder.indexOf(b.key)
    if (ia >= 0 && ib >= 0) return ia - ib
    if (ia >= 0) return -1
    if (ib >= 0) return 1
    return b.entries - a.entries || a.key.localeCompare(b.key)
  })
  for (const a of list) {
    const m = profileAcc.get(a.key)
    a.profile = m
      ? [...m.values()].sort((x, y) => y.n - x.n || x.k.localeCompare(y.k)).slice(0, MAX_PROFILE)
      : []
    // 文件内按路径排序,模组追加的文件排在后面也符合直觉
    a.files.sort((x, y) => x.file.localeCompare(y.file))
  }

  return {
    aspects: list.filter((a) => a.files.length > 0),
    files: fileCount,
    entries: entryCount,
    defs,
    fileDefs,
    ms: Date.now() - t0,
  }
}
