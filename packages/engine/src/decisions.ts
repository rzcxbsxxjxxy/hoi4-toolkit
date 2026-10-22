/**
 * 决议模型(common/decisions)。
 *
 * 文件结构:
 *   category_id = {                         ← 分类块(常以 _category 结尾)
 *     AFG_propose_oil_concession_deal = {   ← 决议块,键即 id
 *       icon = GFX_decision_oil
 *       available = { ... }
 *       allow = { ... }
 *       effect = { ... }
 *       complete_effect = { ... }
 *       visible = { ... }
 *       cost = 0
 *       days_remove = 30
 *     }
 *   }
 *
 * 决议之间没有原生"前置"边(靠 available/allow 里的 flag 间接控制),
 * 所以可视化按"分类"分组陈列,带详细面板;坐标由分类列 + 决议序计算。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'

export interface DecRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

export interface DecisionNode {
  id: string
  icon: string
  cost: number
  days: number
  hasAvailable: boolean
  hasAllow: boolean
  /** ★ 是否有效果类块。原先只查 `effect`(实测 0 处,恒 false)→ 改查真实效果字段 */
  hasEffect: boolean
  hasVisible: boolean
  hasComplete: boolean
  /* ★ 脚本块原文(检查器"显示详情"用)。原先 5 个块只存布尔,内容全丢。
   * ★ 真实字段名(实测 vanilla 5467 决议,`effect = {` 出现 **0** 次,别再写它):
   *   条件类 available 3803 / visible 3785 / allowed 2513 / target_trigger 725 / ai_will_do 3071
   *   效果类 complete_effect 3237 / remove_effect 2064 / hidden_effect 2113 / modifier 5913 */
  availableRaw?: string
  allowRaw?: string
  visibleRaw?: string
  completeRaw?: string
  removeEffectRaw?: string
  hiddenEffectRaw?: string
  modifierRaw?: string
  targetTriggerRaw?: string
  aiWillDoRaw?: string
  /* ═ WIKI_DEC_V1:按 Wiki 补的字段(见 Decision modding 各节) ═ */
  /** days_re_enable:再次可选取的冷却天数 */
  daysReEnable?: number
  /** fire_only_once = yes:只触发一次 */
  fireOnlyOnce?: boolean
  /** priority(决策级,短形式) */
  priority?: number
  /** custom_cost_trigger / custom_cost_text / ai_hint_pp_cost:自定义成本 */
  customCostTriggerRaw?: string
  customCostText?: string
  aiHintPpCost?: number
  /** remove_trigger:触发即时移除(并触发 remove_effect) */
  removeTriggerRaw?: string
  /** cancel_trigger / cancel_if_not_visible / cancel_effect:提前取消 */
  cancelTriggerRaw?: string
  cancelIfNotVisible?: boolean
  cancelEffectRaw?: string
  /** war_with_on_remove / war_with_on_complete:战争预告 */
  warWithOnRemove?: string
  warWithOnComplete?: string
  /** fixed_random_seed:固定随机种子(默认 yes → true) */
  fixedRandomSeed?: boolean
  /** highlight_states = { ... } 州/省高亮原文 */
  highlightRaw?: string
  /** targeted_modifier = { ... } 目标修正原文 */
  targetedModifierRaw?: string
  file: string
  line: number
  category: string
  root: number
}

export interface DecisionCategory {
  id: string
  icon: string
  decisions: DecisionNode[]
  /* ★ 决议类自身的出现条件(allow / visible / available / target_trigger / ai_will_do)——
   *   这些是控制「决议类是否出现」的块,不是决议。单独捕获原文供前端展示。 */
  allowRaw?: string
  visibleRaw?: string
  availableRaw?: string
  targetTriggerRaw?: string
  aiWillDoRaw?: string
  priority?: number
  picture?: string
  cost?: number
  daysRemove?: number
  isAlert?: string
  /* ═ WIKI_DEC_V1:按 Wiki 补的类字段 ═ */
  /** visible_when_empty = yes:无可见决议也显示类 */
  visibleWhenEmpty?: boolean
  /** on_map_area = { ... } 地图区域原文 */
  onMapAreaRaw?: string
  /** scripted_gui = X:类内嵌脚本 GUI */
  scriptedGui?: string
  /** highlight_states = { ... } 州/省高亮原文 */
  highlightRaw?: string
}

export interface DecisionGraph {
  roots: DecRoot[]
  categories: Map<string, DecisionCategory>
  nodes: Map<string, DecisionNode>
  /** 分类 id → 列号(可视化用) */
  column: Map<string, number>
  /** id → 全部定义位置(后加载的覆盖先加载的,但要记住链条才能区分"模组新增"与"模组改写") */
  defs: Map<string, { root: number; file: string; line: number }[]>
  /** 分类 id → 全部定义位置 */
  catDefs: Map<string, { root: number; file: string; line: number }[]>
}

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

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  return undefined
}
function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  return undefined
}
/** 找子 Entry(含块),用于无损还原原始文本 */
function childEntry(doc: Document, b: Block, key: string): Entry | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return e
  return undefined
}
/**
 * ★ 无损还原一个 Entry 的原始文本(含 `key =` 与整块)。
 *   决议的 5 个脚本块(available/allowed/effect/visible/complete_effect)原先只存
 *   布尔存在性,检查器只能显示一个标签,看不到条件与效果的具体内容。
 *   沿用国策模型(model.ts)的同款做法:按 token 区间切片,不持 AST。
 */
function entryText(doc: Document, e: Entry): string {
  let s = ''
  for (let i = e.start; i < e.end; i++) s += doc.tokens[i].text
  return s.trim()
}
/** 取子块原文(不存在则 undefined) */
function rawOf(doc: Document, b: Block, key: string): string | undefined {
  const e = childEntry(doc, b, key)
  return e ? entryText(doc, e) : undefined
}
/**
 * ★ hidden_effect 是【嵌套】在 complete_effect / remove_effect 内部的(实测 AFG.txt:48/130),
 *   不是决议块的直接子键 —— 只查顶层会一条都抓不到(第一版就踩了这个坑)。
 *   所以先查顶层,再查两个常见父块内部。
 */
function hiddenEffectOf(doc: Document, b: Block): string | undefined {
  const top = rawOf(doc, b, 'hidden_effect')
  if (top) return top
  for (const parent of ['complete_effect', 'remove_effect']) {
    const blk = childBlock(doc, b, parent)
    if (!blk) continue
    const inner = rawOf(doc, blk, 'hidden_effect')
    if (inner) return `${parent} 内:\n${inner}`
  }
  return undefined
}
function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : undefined
}

/** 决议类块内的「控制键」:这些不是决议,而是决议类自身的属性/出现条件 */
const CAT_CONTROL = new Set([
  'id', 'icon', 'picture', 'priority', 'is_alert', 'default', 'days_remove', 'cost', 'group', 'decision',
  'allow', 'visible', 'available', 'target_trigger', 'ai_will_do', 'visible_if_invisible', 'allow_ai',
  'custom_cost_trigger', 'generic', 'type',
  'remove_effect', 'complete_effect', 'hidden_effect', 'modifier',
  'visible_when_empty', 'on_map_area', 'scripted_gui', 'highlight_states', 'highlight_provinces',
])

export function buildDecisionGraph(roots: DecRoot[]): DecisionGraph {
  const g: DecisionGraph = {
    roots,
    categories: new Map(),
    nodes: new Map(),
    column: new Map(),
    defs: new Map(),
    catDefs: new Map(),
  }
  let col = 0

  roots.forEach((r, ri) => {
    const dir = join(r.path, 'common', 'decisions')
    for (const abs of walk(dir, ['.txt'])) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const ck = keyText(doc, e)
        if (!ck || !e.block) continue
        const cb = e.block
        const categoryId = childValue(doc, cb, 'id') ?? ck
        let cat = g.categories.get(categoryId)
        if (!cat) {
          cat = { id: categoryId, icon: childValue(doc, cb, 'icon') ?? '', decisions: [] }
          g.categories.set(categoryId, cat)
          g.column.set(categoryId, col++)
        }
        // 分类也可能被模组覆盖/新增,记下定义链
        const cdl = g.catDefs.get(categoryId) ?? []
        cdl.push({ root: ri, file, line: lineOf(doc, e) })
        g.catDefs.set(categoryId, cdl)
        // 决议块:可能是直接子块,或 decision = { id = ... }
        for (const de of cb.entries) {
          const dk = keyText(doc, de)
          if (!dk || !de.block) continue
          const db = de.block
          const dkLower = dk.toLowerCase()
          /* ★ CATCONTROL_V1:决议类的控制键(allow / visible / available / target_trigger /
           *   ai_will_do / priority…)是「决议类是否出现」的条件,不是决议 ——
           *   存为分类属性,不作为决议解析,避免 `visible`/`priority` 等混进决议列表。 */
          if (CAT_CONTROL.has(dkLower)) {
            if (dkLower === 'allow') cat.allowRaw = entryText(doc, de)
            else if (dkLower === 'visible') cat.visibleRaw = entryText(doc, de)
            else if (dkLower === 'available') cat.availableRaw = entryText(doc, de)
            else if (dkLower === 'target_trigger') cat.targetTriggerRaw = entryText(doc, de)
            else if (dkLower === 'ai_will_do') cat.aiWillDoRaw = entryText(doc, de)
            else if (dkLower === 'priority') cat.priority = num(childValue(doc, cb, 'priority'))
            else if (dkLower === 'picture') cat.picture = childValue(doc, cb, 'picture')
            else if (dkLower === 'cost') cat.cost = num(childValue(doc, cb, 'cost'))
            else if (dkLower === 'days_remove') cat.daysRemove = num(childValue(doc, cb, 'days_remove'))
            else if (dkLower === 'is_alert') cat.isAlert = childValue(doc, cb, 'is_alert')
            else if (dkLower === 'visible_when_empty') cat.visibleWhenEmpty = /^\s*(yes|true)\s*$/i.test(entryText(doc, de) ?? '') || undefined
            else if (dkLower === 'on_map_area') cat.onMapAreaRaw = entryText(doc, de)
            else if (dkLower === 'scripted_gui') cat.scriptedGui = childValue(doc, cb, 'scripted_gui')
            else if (dkLower === 'highlight_states') cat.highlightRaw = entryText(doc, de)
            continue
          }
          let decId: string | undefined
          let decBlock = db
          if (dkLower === 'decision') {
            decId = childValue(doc, db, 'id')
          } else {
            decId = childValue(doc, db, 'id') ?? dk
          }
          if (!decId) continue
          // 个别写法里 decision = { id = X } 而真正内容在 grandson?这里直接取 decBlock
          const node: DecisionNode = {
            id: decId,
            icon: childValue(doc, decBlock, 'icon') ?? '',
            cost: num(childValue(doc, decBlock, 'cost')) ?? 0,
            days: num(childValue(doc, decBlock, 'days_remove')) ?? 0,
            hasAvailable: childBlock(doc, decBlock, 'available') !== undefined,
            hasAllow: childBlock(doc, decBlock, 'allow') !== undefined || childBlock(doc, decBlock, 'allowed') !== undefined,
            // ★ 效果类字段用真实的四个,不再查不存在的 `effect`
            hasEffect:
              childBlock(doc, decBlock, 'complete_effect') !== undefined ||
              childBlock(doc, decBlock, 'remove_effect') !== undefined ||
              childBlock(doc, decBlock, 'hidden_effect') !== undefined ||
              childBlock(doc, decBlock, 'modifier') !== undefined,
            hasVisible: childBlock(doc, decBlock, 'visible') !== undefined,
            hasComplete: childBlock(doc, decBlock, 'complete_effect') !== undefined,
            // ★ 脚本块原文(available/allowed 两种拼写都认,游戏两种都出现过)
            availableRaw: rawOf(doc, decBlock, 'available'),
            allowRaw: rawOf(doc, decBlock, 'allow') ?? rawOf(doc, decBlock, 'allowed'),
            visibleRaw: rawOf(doc, decBlock, 'visible'),
            completeRaw: rawOf(doc, decBlock, 'complete_effect'),
            removeEffectRaw: rawOf(doc, decBlock, 'remove_effect'),
            hiddenEffectRaw: hiddenEffectOf(doc, decBlock),
            modifierRaw: rawOf(doc, decBlock, 'modifier'),
            targetTriggerRaw: rawOf(doc, decBlock, 'target_trigger'),
            aiWillDoRaw: rawOf(doc, decBlock, 'ai_will_do'),
            daysReEnable: num(childValue(doc, decBlock, 'days_re_enable')),
            fireOnlyOnce: /^\s*(yes|true)\s*$/i.test(childValue(doc, decBlock, 'fire_only_once') ?? '') || undefined,
            priority: num(childValue(doc, decBlock, 'priority')),
            customCostTriggerRaw: rawOf(doc, decBlock, 'custom_cost_trigger'),
            customCostText: childValue(doc, decBlock, 'custom_cost_text') || undefined,
            aiHintPpCost: num(childValue(doc, decBlock, 'ai_hint_pp_cost')),
            removeTriggerRaw: rawOf(doc, decBlock, 'remove_trigger'),
            cancelTriggerRaw: rawOf(doc, decBlock, 'cancel_trigger'),
            cancelIfNotVisible: /^\s*(yes|true)\s*$/i.test(childValue(doc, decBlock, 'cancel_if_not_visible') ?? '') || undefined,
            cancelEffectRaw: rawOf(doc, decBlock, 'cancel_effect'),
            warWithOnRemove: childValue(doc, decBlock, 'war_with_on_remove') || undefined,
            warWithOnComplete: childValue(doc, decBlock, 'war_with_on_complete') || undefined,
            fixedRandomSeed: /^\s*(no|false)\s*$/i.test(childValue(doc, decBlock, 'fixed_random_seed') ?? '') ? false : true,
            highlightRaw: rawOf(doc, decBlock, 'highlight_states'),
            targetedModifierRaw: rawOf(doc, decBlock, 'targeted_modifier'),
            file,
            line: lineOf(doc, de),
            category: categoryId,
            root: ri,
          }
          /* ★ OWNERSHIP_V1:同名决议由【后加载的模组整份替换】先加载的那份。
           *   旧代码 `if (!g.nodes.has(decId))` = 先出现的赢,模组改决议永远不生效,
           *   而界面还把它标成"原版"—— 与游戏语义相反。
           *   分类列表里同步换掉引用,避免 UI 拿到已被覆盖的旧对象。 */
          const prevDec = g.nodes.get(decId)
          g.nodes.set(decId, node)
          if (!prevDec) cat.decisions.push(node)
          else {
            const at = cat.decisions.findIndex((x) => x.id === decId)
            if (at >= 0) cat.decisions[at] = node
            else cat.decisions.push(node)
          }
          // 每一次定义都记进链条(供归属三态与"覆盖链"面板)
          const dl = g.defs.get(decId) ?? []
          dl.push({ root: ri, file, line: lineOf(doc, de) })
          g.defs.set(decId, dl)
        }
      }
    }
  })

  return g
}
