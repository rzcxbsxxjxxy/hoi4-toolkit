/**
 * 内容生成脚手架(无损、round-trip 安全)。
 *
 * 设计:内部用一棵简单的 GNode 树表达 Clausewitz 文档,printNodes() 把它
 * 渲染成规范化的 .txt。生成结果保证能被 parse() 原样解析(会自校验并报告)。
 *
 * 与 hoi4modding.com 的区别:它不仅生成,还顺带产出本地化文件、做 round-trip
 * 校验,并且所有产物都是"可被本工具链继续编辑"的合法文件(无损解析友好)。
 */

import { parse } from '../../parser/src/parser.ts'
import type { FieldStats } from './fieldstats.ts'
import { validateGenFile, crossValidate, type SemIssue } from './genvalidate.ts'

/* ── 文档模型 ── */

export interface GNode {
  /** 带键的 entry 有 key;裸值(列表项)没有 */
  key?: string
  /** 简单值 */
  value?: string
  op?: '=' | '<'
  /** 值为块 */
  block?: GNode[]
  /** 前置注释 */
  comment?: string
}

export function kv(key: string, value: string, op: '=' | '<' = '='): GNode {
  return { key, value, op }
}
export function blk(key: string, children: GNode[]): GNode {
  return { key, block: children }
}
export function bare(value: string): GNode {
  return { value }
}
export function comment(text: string): GNode {
  return { comment: text }
}

/* ── 渲染 ── */

function pad(n: number): string {
  return '\t'.repeat(n)
}

function printEntry(n: GNode, depth: number): string {
  const ind = pad(depth)
  if (n.comment !== undefined) return `${ind}# ${n.comment}`
  if (n.block) {
    const head = n.key !== undefined ? `${ind}${n.key} = {` : `${ind}{`
    if (!n.block.length) return `${head} }`
    const inner = n.block.map((c) => printEntry(c, depth + 1)).join('\n')
    return `${head}\n${inner}\n${ind}}`
  }
  const v = n.value ?? ''
  return n.key !== undefined ? `${ind}${n.key} ${n.op ?? '='} ${v}` : `${ind}${v}`
}

/** 渲染根级文档(顶层无缩进) */
export function printNodes(nodes: GNode[]): string {
  return nodes.map((n) => printEntry(n, 0)).join('\n') + '\n'
}

/* ── 本地化渲染(UTF-8 + BOM) ── */

export function printLocYml(entries: { key: string; value: string; index?: number }[]): string {
  const lines = ['l_english:']
  for (const e of entries) {
    const idx = e.index !== undefined ? `:${e.index}` : ''
    const v = e.value.replace(/"/g, '""')
    lines.push(` ${e.key}${idx}: "${v}"`)
  }
  return '﻿' + lines.join('\n') + '\n'
}

/* ── 生成结果 ── */

export interface GenFile {
  /** 相对模组根的路径 */
  path: string
  content: string
}

export interface GenResult {
  files: GenFile[]
  warnings: string[]
  /** ★ 语义校验的错误项(warning 不算)。UI 应当显著提示并阻止"无脑保存"。 */
  errors?: SemIssue[]
}

interface GenCtx {
  mod: string
  lang: string
  locEntries: { key: string; value: string; index?: number }[]
  warnings: string[]
  errors: SemIssue[]
}

function pushLoc(ctx: GenCtx, key: string, value: string): void {
  ctx.locEntries.push({ key, value })
}

/**
 * GEN_VALIDATE_V1:校验上下文。
 * 由 GUI 层在启动时用 fieldstats 扫真实数据建好后注入(setValidation);
 * 没有注入时退化为旧的"只看语法"模式(仍可用,但会提示校验未开启)。
 */
let VALIDATION: ValidationCtx | null = null

export interface ValidationCtx {
  stats: FieldStats
  scriptKeys: Set<string>
}

export function setValidation(ctx: ValidationCtx | null): void {
  VALIDATION = ctx
}

export function getValidation(): ValidationCtx | null {
  return VALIDATION
}

function finalize(ctx: GenCtx, files: GenFile[], kind?: GenKind): GenResult {
  if (ctx.locEntries.length) {
    files.push({
      path: `localisation/${ctx.lang}/${ctx.mod}_${ctx.lang}.yml`,
      content: printLocYml(ctx.locEntries),
    })
  }

  /* ── 校验 ──
   * 旧版只查语法(下else 分支),那是"假的安全感":
   * `equipment = {}` 语法 100% 合法但游戏不加载。
   * 现在优先跑语义校验(genvalidate.ts),判据来自实测扫描的真实数据。 */
  if (VALIDATION && kind) {
    try {
      const issues: SemIssue[] = []
      for (const f of files) {
        issues.push(...validateGenFile(f.path, f.content, kind, VALIDATION.stats, VALIDATION.scriptKeys))
      }
      crossValidate(files, issues)
      for (const is of issues) {
        // warn 只进 warnings(不阻止保存),error 进 errors(UI 会显著提示)
        if (is.severity === 'error') ctx.errors.push(is)
        else ctx.warnings.push(`${is.path} · ${is.where}:${is.message}`)
      }
    } catch (e) {
      ctx.warnings.push(`语义校验异常(已跳过): ${String(e)}`)
    }
  } else {
    // 未注入真实数据:只查语法,并明确告知这不是完整校验
    for (const f of files) {
      if (!f.path.endsWith('.txt')) continue
      try {
        const doc = parse(f.content)
        if (doc.errors.length) ctx.warnings.push(`${f.path}: 解析告警 ${doc.errors.length} 条`)
      } catch (e) {
        ctx.warnings.push(`${f.path}: 生成内容无法解析 —— ${String(e)}`)
      }
    }
    ctx.warnings.push('(仅做了语法检查:未加载真实字段数据,无法验证键名/层级是否被游戏识别)')
  }
  return { files, warnings: ctx.warnings, errors: ctx.errors }
}

function str(v: unknown, d = ''): string {
  return v === undefined || v === null ? d : String(v)
}
function num(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(str(v))
  return Number.isFinite(n) ? n : d
}
function bool(v: unknown, d = false): boolean {
  if (typeof v === 'boolean') return v
  return /^(yes|true|1)$/i.test(str(v, d ? 'yes' : 'no'))
}

/** 取多行原文:用户填了就用用户的,没填才给注释占位(结构键名仍由生成器负责) */
function rawBlock(key: string, raw: string, placeholder: string): GNode[] {
  const text = str(raw, '').trim()
  if (!text) return [comment(placeholder)]
  // 允许用户直接填整块内容(含嵌套);非法缩进交给 finalize 的语义校验报错
  const lines = text.split(/\r?\n/)
  return lines.map((ln) => (ln.trim() ? { value: ln } : { value: '' }))
}

/* ── 生成器:国策 ── */

export function genFocus(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const treeId = str(o.treeId, str(o.tag, 'MY') + '_focus_tree')
  const id = str(o.id, 'my_focus')
  const tag = str(o.tag, 'MY')
  const icon = str(o.icon, 'GFX_decision_generic')
  const x = num(o.x, 0)
  const y = num(o.y, 0)
  const cost = num(o.cost, 10)
  const rel = str(o.relativeId, '')
  const prereq = str(o.prerequisite, '')
  const title = str(o.title, '我的国策')
  const desc = str(o.desc, '国策描述')
  const reward = str(o.reward, '')
  const searchFilters = str(o.searchFilters, '')
  const availCapitulated = bool(o.availableIfCapitulated, false)
  const cancelInvalid = bool(o.cancelIfInvalid, false)
  const mutually = str(o.mutuallyExclusive, '')
  const bypass = str(o.bypassIf, '')

  const focusChildren: GNode[] = [
    kv('id', id),
    kv('icon', icon),
    kv('x', String(x)),
    kv('y', String(y)),
    kv('cost', String(cost)),
  ]
  if (rel) focusChildren.push(kv('relative_position_id', rel))
  if (prereq) {
    // Wiki(National_focus_modding):同个 prerequisite 块内是 OR(任一满足即可)。
    // 支持多行:每行一个前置国策(可带 focus = 前缀)。
    const ids = prereq.split(/\r?\n/).map((s) => s.trim().replace(/^focus\s*=\s*/, '')).filter(Boolean)
    focusChildren.push(blk('prerequisite', ids.map((pp) => kv('focus', pp))))
  }
  focusChildren.push(blk('available', rawBlock('available', str(o.available, ''), '在此填写可见/可用条件')))
  if (searchFilters) {
    focusChildren.push(blk('search_filters', searchFilters.split(/[\s,]+/).filter(Boolean).map((s) => ({ value: s }))))
  }
  if (availCapitulated) focusChildren.push(kv('available_if_capitulated', 'yes'))
  if (cancelInvalid) focusChildren.push(kv('cancel_if_invalid', 'yes'))
  if (mutually) focusChildren.push(blk('mutually_exclusive', [{ value: mutually }]))
  if (bypass) focusChildren.push(blk('bypass_if', rawBlock('bypass_if', bypass, '旁路条件(满足则跳过该国策)')))
  focusChildren.push(blk('completion_reward', reward ? [kv('political_power', reward)] : [comment('在此填写完成奖励')]))
  if (str(o.aiWillDo, '')) focusChildren.push(blk('ai_will_do', [{ value: str(o.aiWillDo, '') }]))

  const factorRaw = str(o.countryFactor, '').trim()
  const hasTagGate = !!str(o.tag, '').trim()
  const factor = factorRaw || (hasTagGate ? '0' : '1')
  const countryChildren: GNode[] = [kv('factor', factor)]
  if (hasTagGate) countryChildren.push(blk('modifier', [kv('add', str(o.countryAdd, '1')), kv('tag', tag)]))

  const treeChildren: GNode[] = [
    kv('id', treeId),
    blk('country', countryChildren),
    blk('focus', focusChildren),
  ]

  const files: GenFile[] = [
    { path: `common/national_focus/${tag}_${id}.txt`, content: printNodes([blk('focus_tree', treeChildren)]) },
  ]
  pushLoc(ctx, id, title)
  pushLoc(ctx, `${id}_desc`, desc)
  return finalize(ctx, files, 'focus')
}

/* ── 生成器:事件 ── */



export function genEvent(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const type = str(o.type, 'country_event')
  const id = str(o.id, 'my_event')
  const pic = str(o.picture, 'GFX_report_event')
  const title = str(o.title, '我的事件')
  const desc = str(o.desc, '事件描述')
  const triggered = bool(o.isTriggeredOnly, false)
  const once = bool(o.fireOnlyOnce, false)
  const major = bool(o.major, false)
  const hidden = bool(o.hidden, false)
  const minorFlavor = bool(o.minorFlavor, false)
  const timeout = str(o.timeoutDays, '')
  const after = str(o.after, '')
  const showMajor = str(o.showMajor, '')
  const addNs = str(o.addNamespace, '')
  const optCount = Math.max(1, Math.min(5, num(o.options, 2)))

  const ev: GNode[] = [
    kv('id', id),
    kv('title', `${id}_title`),
    kv('desc', `${id}_desc`),
    kv('picture', pic),
  ]
  if (hidden) ev.push(kv('hidden', 'yes'))
  if (triggered) ev.push(kv('is_triggered_only', 'yes'))
  if (once) ev.push(kv('fire_only_once', 'yes'))
  if (major) ev.push(kv('major', 'yes'))
  if (minorFlavor) ev.push(kv('minor_flavor', 'yes'))
  if (timeout) ev.push(kv('timeout_days', timeout))
  ev.push(blk('trigger', rawBlock('trigger', str(o.trigger, ''), '触发条件')))
  ev.push(blk('immediate', rawBlock('immediate', str(o.immediate, ''), '立即效果(仅 triggered_only)')))
  for (let i = 1; i <= optCount; i++) {
    const aiRaw = str(o[`optionAi${i}`], '').trim()
    ev.push(
      blk('option', [
        kv('name', `${id}_o${i}`),
        ...rawBlock('trigger', str(o[`optionTrigger${i}`], ''), '选项可见条件'),
        ...rawBlock('effect', str(o[`optionEffect${i}`], ''), '选项效果'),
        blk('ai_chance', aiRaw ? [{ value: aiRaw }] : [kv('base', '1')]),
      ]),
    )
  }
  if (after) ev.push(blk('after', rawBlock('after', after, '玩家选完选项后执行的效果')))
  if (showMajor) ev.push(blk('show_major', rawBlock('show_major', showMajor, 'major 事件里对其它国家的显示条件')))

  const top: GNode[] = []
  if (addNs) top.push(kv('add_namespace', addNs))
  const files: GenFile[] = [
    { path: `events/${type}_${id}.txt`, content: printNodes([...top, blk(type, ev)]) },
  ]
  pushLoc(ctx, `${id}_title`, title)
  pushLoc(ctx, `${id}_desc`, desc)
  for (let i = 1; i <= optCount; i++) pushLoc(ctx, `${id}_o${i}`, `选项 ${i}`)
  return finalize(ctx, files, 'event')
}

/* ── 生成器:决议 ── */

export function genDecision(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const catId = str(o.category, str(o.id, 'my_decision') + '_category')
  const id = str(o.id, 'my_decision')
  const icon = str(o.icon, 'GFX_decision_generic')
  const cost = num(o.cost, 0)
  const days = num(o.daysRemove, 30)
  const ai = num(o.aiWillDo, 40)
  const title = str(o.title, '我的决议')
  const desc = str(o.desc, '决议描述')

  /* ★★ fix#1:决议条目层**不存在** `effect` 和 `allow`。
   * 证据(vanilla 决议条目层按缩进统计):
   *   icon 4121 / visible 3766 / available 3753 / complete_effect 3183 / ai_will_do 3032
   *   / cost 2820 / allowed 2494 / fire_only_once 2452 / days_remove 2106 / remove_effect 2044
   *   / modifier 1176 / target_trigger 664 / cancel_trigger 628
   *   `effect = {` 全库 0 处;是 `allowed`(带 d)不是 `allow`。
   * 写错的后果:决议能显示但点了什么都不发生。 */
  const decision: GNode[] = [kv('icon', icon), kv('cost', String(cost)), kv('days_remove', String(days))]
  decision.push(blk('visible', rawBlock('visible', str(o.visible, ''), '在此填写可见条件')))
  decision.push(blk('available', rawBlock('available', str(o.available, ''), '在此填写可用条件')))
  decision.push(blk('allowed', rawBlock('allowed', str(o.allowed, ''), '在此填写允许条件(权限/条件限制)')))
  if (str(o.targetTrigger, '')) decision.push(blk('target_trigger', rawBlock('target_trigger', str(o.targetTrigger, ''), '目标国家条件')))
  decision.push(blk('complete_effect', rawBlock('complete_effect', str(o.completeEffect, ''), '在此填写执行效果')))
  if (str(o.removeEffect, '')) decision.push(blk('remove_effect', rawBlock('remove_effect', str(o.removeEffect, ''), '在此填写移除后效果')))
  if (str(o.modifier, '')) decision.push(blk('modifier', rawBlock('modifier', str(o.modifier, ''), '在此填写持续修正器')))
  if (bool(o.fireOnlyOnce, false)) decision.push(kv('fire_only_once', 'yes'))
  decision.push(blk('ai_will_do', [kv('base', String(ai))]))
  const files: GenFile[] = [
    { path: `common/decisions/${id}.txt`, content: printNodes([blk(catId, [blk(id, decision)])]) },
  ]
  pushLoc(ctx, id, title)
  pushLoc(ctx, `${id}_desc`, desc)
  return finalize(ctx, files, 'decision')
}

/* ── 生成器:科技 ── */

export function genTechnology(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const id = str(o.id, 'my_tech')
  const cost = num(o.cost, 10)
  const year = num(o.year, 1936)
  const x = num(o.x, 0)
  const y = num(o.y, 0)
  /* ★ 旧默认值是 'land_doctrine' —— 实测原版 105 个 categories 取值里**没有**它,
   * 生成出来必然落在科技树上无处显示。industry 是真实取值(43 处)。 */
  const area = str(o.area, 'industry')
  const enables = str(o.enables, '')
  const ai = num(o.aiWillDo, 1)
  const folderName = str(o.folder, `${id}_folder`)

  /* ★ 科技的真实结构(证据 vanilla common/technologies/air_techs.txt):
   *   technologies = { <id> = { research_cost / start_year / folder{name,position{x,y}}
   *                                 / categories = { <area> }
   *                                 / path = { leads_to_tech = X }
   *                                 / enable_equipments = { <装备> }
   *                                 / ai_will_do = { factor = N modifier{...} } } }
   * `icon` 原版只有 1 处,不是必备字段;不写反而更安全。 */
  const tech: GNode[] = [
    kv('research_cost', String(cost)),
    kv('start_year', String(year)),
    blk('folder', [kv('name', folderName), blk('position', [kv('x', String(x)), kv('y', String(y))])]),
    blk('categories', [{ value: area }]),
    // ai_will_do 在科技里是 factor(不是决议的 base)—— 原版 air_techs.txt 实证
    blk('ai_will_do', [kv('factor', String(ai))]),
  ]
  if (enables) tech.push(blk('path', [kv('leads_to_tech', enables)]))
  const eqList = str(o.enableEquipments, '')
  if (eqList) {
    tech.push(
      blk('enable_equipments', eqList.split(/[\s,]+/).filter(Boolean).map((s) => ({ value: s }))),
    )
  }
  const files: GenFile[] = [
    { path: `common/technologies/${id}.txt`, content: printNodes([blk('technologies', [blk(id, tech)])]) },
  ]
  return finalize(ctx, files, 'technology')
}

/* ── 生成器:理念 ── */

export function genIdea(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const id = str(o.id, 'my_idea')
  const icon = str(o.icon, 'GFX_idea_generic')
  const title = str(o.title, '我的理念')
  const desc = str(o.desc, '理念描述')

  const idea: GNode[] = [kv('picture', icon)]
  idea.push(blk('allowed', rawBlock('allowed', str(o.allowed, ''), '适用条件,例:tag = MY')))
  idea.push(blk('modifier', rawBlock('modifier', str(o.modifier, ''), '修正,例:stability_factor = 0.1')))
  if (str(o.allowedCivilWar, '')) idea.push(blk('allowed_civil_war', rawBlock('allowed_civil_war', str(o.allowedCivilWar, ''), '内战适用条件')))
  if (str(o.removeModifier, '')) idea.push(blk('remove_modifier', rawBlock('remove_modifier', str(o.removeModifier, ''), '移除本理念的条件')))
  if (str(o.cancelIfInvalid, '')) idea.push(blk('cancel_if_invalid', rawBlock('cancel_if_invalid', str(o.cancelIfInvalid, ''), '条件失效则取消理念')))
  if (str(o.traits, '')) idea.push(blk('traits', rawBlock('traits', str(o.traits, ''), '特性列表')))
  idea.push(blk('ai_will_do', [kv('factor', '1')]))

  const fileName = str(o.category, 'my_ideas')
  const files: GenFile[] = [
    { path: `common/ideas/${fileName}.txt`, content: printNodes([blk('ideas', [blk('country', [blk(id, idea)])])]) },
  ]
  pushLoc(ctx, id, title)
  pushLoc(ctx, `${id}_desc`, desc)
  return finalize(ctx, files, 'idea')
}

/* ── 生成器:装备/单位 ── */

export function genEquipment(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const type = str(o.eqType, 'land_equipment')
  const id = str(o.id, 'my_equipment')
  const name = str(o.name, '我的装备')
  const year = num(o.year, 1936)
  const ic = num(o.ic, 2)

  /* ★★ fix#2 + #5:顶层键是**复数** `equipments`(vanilla 41 处全是复数,
   * 写成 `equipment` 整个文件不加载);且原先那套
   *   active = { block = no } / air = { block = no } / armor = { block = no }
   * 全是虚构字段 —— 真实 `active` 是**标量** yes/no(13 处),
   * air/armor/artillery 作为块根本不存在。
   * 真实装备条目层有 89 种字段(实测),这里给出最常用的一批,
   * 全部按原版键名;attributes 里的键由语义校验核对。 */
  const eq: GNode[] = [kv('year', String(year)), kv('build_cost_ic', String(ic))]
  /* 可选标量:只有用户真填了才写。
   * ⚠ 判定必须用 `=== undefined` 之外还查空串 —— 未提供的键是 undefined,
   *   但 `str()` 会把 undefined 变成 '' 再 String() 又变成 'undefined' 文本,
   *   曾经导致生成出 `picture = picture` 这种自指垃圾行。 */
  const optScalars: [string, unknown][] = [
    ['picture', o.picture],
    ['reliability', o.reliability],
    ['maximum_speed', o.maxSpeed],
    ['hardness', o.hardness],
    ['armor_value', o.armorValue],
    ['breakthrough', o.breakthrough],
    ['soft_attack', o.softAttack],
    ['hard_attack', o.hardAttack],
    ['defense', o.defense],
    ['ap_attack', o.apAttack],
    ['air_attack', o.airAttack],
    ['manpower', o.manpower],
    ['fuel_consumption', o.fuelConsumption],
    ['lend_lease_cost', o.lendLeaseCost],
    ['priority', o.priority],
    ['resources', o.resources],
    ['naval_range', o.navalRange],
    ['air_range', o.airRange],
    ['sub_detection', o.subDetection],
    ['surface_detection', o.surfaceDetection],
  ]
  for (const [key, val] of optScalars) {
    if (val === undefined || val === null) continue
    const s = String(val).trim()
    if (s === '' || s === 'undefined') continue
    eq.push(kv(key, s))
  }
  // active / is_buildable 有默认值(装备默认可用、可建),用 bool() 显式判定
  if (o.active !== undefined) eq.push(kv('active', bool(o.active, true) ? 'yes' : 'no'))
  if (o.isBuildable !== undefined) eq.push(kv('is_buildable', bool(o.isBuildable, true) ? 'yes' : 'no'))
  /*装备类型:原版 type 是**单值块**,取值只有 13 种具体类型
   * (实测:anti_air 8 / infantry 8 / motorized 7 / screen_ship 7 / artillery 5 /
   *  support 4 / mechanized 2 / rocket 2 / anti_tank / strategic_bomber /
   *  fighter / submarine / carrier 各 1)——**没有 `land` 这种泛称**。
   * 之前默认填 'land' 会让新装备匹配不到任何东西。 */
  const slot = str(o.equipmentSlot, 'infantry')
  eq.push(blk('type', [{ value: slot }]))
  if (str(o.interfaceCategory, '')) eq.push(kv('interface_category', str(o.interfaceCategory, '')))
  /* archetype 是**标量**,值是父装备 id(证据 common/units/equipment/infantry.txt:
   *   infantry_equipment_1 = { archetype = infantry_equipment  parent = infantry_equipment_0 … }
   * 之前写成 `archetype = { infantry_equipment }` 是错的。 */
  const parent = str(o.parent, '')
  if (parent) eq.push(kv('archetype', parent))

  const files: GenFile[] = [
    { path: `common/units/equipment/${type}.txt`, content: printNodes([blk('equipments', [blk(id, eq)])]) },
  ]
  pushLoc(ctx, id, name)
  return finalize(ctx, files, 'equipment')
}

/* ── 分派 ── */

export type GenKind = 'focus' | 'event' | 'decision' | 'technology' | 'idea' | 'equipment' | 'country'

/* ── 生成器:国家(Country_creation)── */

export function genCountry(o: Record<string, unknown>): GenResult {
  const ctx: GenCtx = { mod: str(o.mod, 'my_mod'), lang: str(o.lang, 'l_english'), locEntries: [], warnings: [], errors: [] }
  const tag = str(o.tag, 'MY').toUpperCase()
  const name = str(o.name, '我的国家')
  const adj = str(o.adj, '我的')
  const focus = str(o.nationalFocus, '')
  const ideas = str(o.ideas, '')
  const rulingParty = str(o.rulingParty, 'neutrality')
  const electionFreq = str(o.electionFrequency, '')
  const lastElection = str(o.lastElection, '1936.1.1')
  const electionsAllowed = bool(o.electionsAllowed, true)
  const popularities = str(o.popularities, 'neutrality = 100')
  const coreStates = str(o.coreStates, '')
  const capital = str(o.capital, '')
  const officialLang = str(o.officialLanguage, '')

  const rows: GNode[] = []
  if (focus) rows.push(kv('national_focus', focus))
  if (ideas) rows.push(blk('add_ideas', ideas.split(/[\s,]+/).filter(Boolean).map((s) => ({ value: s }))))
  const pol: GNode[] = [kv('ruling_party', rulingParty), kv('last_election', lastElection)]
  if (electionFreq) pol.push(kv('election_frequency', electionFreq))
  pol.push(kv('elections_allowed', electionsAllowed ? 'yes' : 'no'))
  rows.push(blk('set_politics', pol))
  rows.push(blk('set_popularities', rawBlock('set_popularities', popularities, '四党受欢迎度,每行一党,如 neutrality = 100 / fascism = 20')))
  if (coreStates) rows.push(blk('add_core_of', coreStates.split(/[\s,]+/).filter(Boolean).map((s) => ({ value: s }))))
  if (capital) rows.push(kv('set_capital', capital))
  if (officialLang) rows.push(kv('set_official_language', officialLang))

  const files: GenFile[] = [
    { path: `history/countries/${tag} - ${name}.txt`, content: printNodes(rows) },
  ]
  pushLoc(ctx, tag, name)
  pushLoc(ctx, `${tag}_ADJ`, adj)
  return finalize(ctx, files, 'country')
}


export function generate(kind: GenKind, o: Record<string, unknown>): GenResult {
  switch (kind) {
    case 'focus':
      return genFocus(o)
    case 'event':
      return genEvent(o)
    case 'decision':
      return genDecision(o)
    case 'technology':
      return genTechnology(o)
    case 'idea':
      return genIdea(o)
    case 'equipment':
    case 'country':
      return genCountry(o)
      return genEquipment(o)
    default:
      return { files: [], warnings: [`未知生成类型: ${kind}`] }
  }
}


/* ══════════════════════════════════════════════════════════════════
 * GEN_FIELDS —— 内容生成器的**唯一字段定义源**(GEN_SCHEMA_V1)
 *
 * ★ 为什么要换掉旧的三份手写镜像:
 *   以前 gen.ts 一份、create.js 一份、各 genXxx() 里实际读取的键又是一份,
 *   三处各写一遍且**已经不同步** ——
 *     focus 引擎读 available / reward,表单里没有 → 填不了
 *     decision 与 technology 引擎读 aiWillDo,表单里没有
 *     event 引擎读 isTriggeredOnly / fireOnlyOnce,表单里没有
 *   现在这份表是唯一定义,前端通过 /api/gen/schema 拿,
 *   改这里就同时改了表单与校验,不会再漂移。
 *
 * 字段类型:
 *   text/number  普通输入
 *   select       下拉,values 来自 fieldstats 实测的真实枚举
 *   bool         yes/no 勾选
 *   script       多行脚本框(条件/效果块),旁边挂真实键提示可点插入
 * 每一项的 hint 说明"填什么会影响游戏里的什么",这是给新手的。
 */
export interface GenField {
  key: string
  label: string
  type?: 'text' | 'number' | 'select' | 'bool' | 'script'
  /** 分组标题(同组共用一个小标题),便于长表单分区 */
  group?: string
  /** 占位提示 */
  placeholder?: string
  /** 默认值(「填示例」按钮用) */
  def?: string
  /** type=select 时的取值来源:到 fieldstats 的 enums 里取 */
  enumFrom?: string
  /** type=select 时的静态取值 */
  values?: string[]
  /** 该字段对应的游戏内块名(用于 script 类型的键提示) */
  block?: string
  /** 帮助说明 */
  hint?: string
  /** 默认展开(script 类型默认折叠) */
  defOpen?: boolean
}

export interface GenSchema {
  kind: GenKind
  label: string
  /** 产物文件路径预览 */
  pathHint: string
  fields: GenField[]
}

export const GEN_SCHEMA: Record<GenKind, GenSchema> = {
  focus: {
    kind: 'focus',
    label: '国策',
    pathHint: 'common/national_focus/<TAG>_<id>.txt',
    fields: [
      { key: 'id', label: '国策 ID', group: '标识', placeholder: 'my_focus', def: 'my_focus', hint: '树内唯一,被 prerequisite / allow_branch 引用' },
      { key: 'tag', label: '国家 TAG', group: '标识', placeholder: 'MY', def: 'MY', hint: '决定这棵树属于谁' },
      { key: 'treeId', label: '国策树 ID', group: '标识', placeholder: 'MY_focus_tree', def: 'MY_focus_tree' },
      { key: 'x', label: 'X 坐标', type: 'number', group: '布局', def: '0', hint: '一格约 1.0,横向' },
      { key: 'y', label: 'Y 坐标', type: 'number', group: '布局', def: '0', hint: '纵向,向下为正' },
      { key: 'icon', label: '图标 GFX', group: '外观', placeholder: 'GFX_decision_generic', def: 'GFX_decision_generic' },
      { key: 'cost', label: '花费(政治点数)', type: 'number', group: '数值', def: '10', hint: '完成所需政治点数' },
      { key: 'relativeId', label: '相对位置 ID', group: '布局', placeholder: '可留空', hint: '填了就用相对坐标,与 x/y 二选一' },
      { key: 'prerequisite', label: '前置国策 ID', type: 'script', block: 'prerequisite', group: '依赖', placeholder: '可留空,每行一个 focus = X', hint: '同个 prerequisite 块内任一满足即可(OR)' },
      {
        key: 'available', label: '可用条件', type: 'script', block: 'available', group: '逻辑',
        defOpen: true, hint: '不满足则灰显。每行一句,如 has_war = yes',
      },
      { key: 'reward', label: '完成奖励', group: '逻辑', placeholder: 'political_power 的值', def: '10', hint: '简写形式,直接给政治点数' },
      { key: 'aiWillDo', label: 'AI 权重', type: 'script', block: 'ai_will_do', group: '逻辑', placeholder: '如 factor = 1', hint: '留空则不写这���' },
      { key: 'title', label: '国策标题', group: '本地化', def: '我的国策' },
      { key: 'desc', label: '国策描述', group: '本地化', def: '国策描述' },
      { key: 'searchFilters', label: '搜索过滤', group: '外观', placeholder: '如 FOCUS_FILTER_POLITICAL,多个逗号分隔', hint: 'search_filters,决定在搜索下拉里的分类' },
      { key: 'availableIfCapitulated', label: '投降后仍可用', type: 'bool', group: '逻辑', hint: 'available_if_capitulated = yes' },
      { key: 'cancelIfInvalid', label: '失效即取消', type: 'bool', group: '逻辑', hint: 'cancel_if_invalid = yes' },
      { key: 'mutuallyExclusive', label: '互斥国策 ID', group: '依赖', placeholder: '可留空', hint: 'mutually_exclusive,与此国策互斥' },
      { key: 'bypassIf', label: '旁路条件', type: 'script', block: 'bypass_if', group: '逻辑', hint: '满足则跳过该国策' },
    ],
  },
  event: {
    kind: 'event',
    label: '事件',
    pathHint: 'events/<type>_<id>.txt',
    fields: [
      {
        key: 'type', label: '事件类型', type: 'select', group: '标识',
        values: ['country_event', 'news_event', 'unit_leader_event', 'operative_leader_event', 'state_event'],
        def: 'country_event', hint: '原版实测:country_event 4830 / news_event 648 / unit_leader_event 31',
      },
      { key: 'id', label: '事件 ID', group: '标识', placeholder: 'my_event.1', def: 'my_event' },
      { key: 'picture', label: '图片 GFX', group: '外观', placeholder: 'GFX_report_event', def: 'GFX_report_event' },
      { key: 'title', label: '标题', group: '本地化', def: '我的事件' },
      { key: 'desc', label: '描述', group: '本地化', def: '事件描述' },
      { key: 'isTriggeredOnly', label: '仅由脚本触发', type: 'bool', group: '触发', def: 'yes', hint: '原版 8757/9183 个事件都是这个模式' },
      { key: 'fireOnlyOnce', label: '只触发一次', type: 'bool', group: '触发' },
      { key: 'meanTimeToHappen', label: '平均触发间隔(月)', type: 'number', group: '触发', hint: '仅非 triggered_only 时有效' },
      { key: 'trigger', label: '触发条件', type: 'script', block: 'trigger', group: '逻辑', defOpen: true, hint: '每行一句,如 has_government = fascism' },
      { key: 'immediate', label: '立即效果', type: 'script', block: 'immediate', group: '逻辑', hint: '事件触发瞬间执行,只对 triggered_only 有意义' },
      { key: 'options', label: '选项数', type: 'number', group: '选项', def: '2', hint: '1~5,超出会被夹到范围内' },
      { key: 'optionTrigger1', label: '选项 1 可见条件', type: 'script', block: 'trigger', group: '选项', defOpen: true },
      { key: 'optionEffect1', label: '选项 1 效果', type: 'script', block: 'effect', group: '选项', defOpen: true, hint: '每个选项可以给不同效果' },
      { key: 'optionTrigger2', label: '选项 2 可见条件', type: 'script', block: 'trigger', group: '选项' },
      { key: 'optionEffect2', label: '选项 2 效果', type: 'script', block: 'effect', group: '选项' },
      { key: 'optionTrigger3', label: '选项 3 可见条件', type: 'script', block: 'trigger', group: '选项' },
      { key: 'optionEffect3', label: '选项 3 效果', type: 'script', block: 'effect', group: '选项' },
      { key: 'addNamespace', label: '命名空间', group: '标识', placeholder: '如 my_event', hint: 'add_namespace,须在事件外声明;id 才能用 namespace.整数 格式' },
      { key: 'major', label: '所有国家收到(major)', type: 'bool', group: '触发', hint: 'news_event 必备;所有国家都会收到' },
      { key: 'showMajor', label: 'major 显示条件', type: 'script', block: 'show_major', group: '触发', hint: 'major 事件里,控制对其它国家是否显示' },
      { key: 'hidden', label: '隐藏事件', type: 'bool', group: '触发', hint: 'hidden = yes,自动选第一个选项,无需标题/描述' },
      { key: 'minorFlavor', label: '次要风味', type: 'bool', group: '触发', hint: 'minor_flavor = yes,可在决议菜单关闭弹窗' },
      { key: 'timeoutDays', label: '超时天数', type: 'number', group: '选项', hint: '默认 13 天,到期自动选第一项' },
      { key: 'after', label: '选定后效果(after)', type: 'script', block: 'after', group: '选项', hint: '玩家选完选项后执行' },
      { key: 'optionAi1', label: '选项 1 AI 权重', type: 'script', block: 'ai_chance', group: '选项', placeholder: '如 base = 10', hint: '留空则 base = 1' },
      { key: 'optionAi2', label: '选项 2 AI 权重', type: 'script', block: 'ai_chance', group: '选项' },
      { key: 'optionAi3', label: '选项 3 AI 权重', type: 'script', block: 'ai_chance', group: '选项' },
    ],
  },
  decision: {
    kind: 'decision',
    label: '决议',
    pathHint: 'common/decisions/<id>.txt',
    fields: [
      { key: 'id', label: '决议 ID', group: '标识', placeholder: 'my_decision', def: 'my_decision' },
      { key: 'category', label: '分类 ID', group: '标识', placeholder: '留空则用 <id>_category', hint: '这是分类块的键名,原版常用 xxx_category' },
      { key: 'icon', label: '图标 GFX', group: '外观', placeholder: 'GFX_decision_generic', def: 'GFX_decision_generic' },
      { key: 'cost', label: '花费(政治点数)', type: 'number', group: '数值', def: '0' },
      { key: 'daysRemove', label: '移除天数', type: 'number', group: '数值', def: '30', hint: '决议完成多少天后消失;填 no 表示不消失' },
      { key: 'priority', label: '排序权重', type: 'number', group: '数值', hint: '决定在列表里的位置' },
      { key: 'aiWillDo', label: 'AI 基础权重', type: 'number', group: '数值', def: '40', hint: '原版最常用 base,通常 20~60' },
      { key: 'fireOnlyOnce', label: '只执行一次', type: 'bool', group: '行为', hint: '原版 2619/5499 个决议开启' },
      {
        key: 'visible', label: '可见条件', type: 'script', block: 'visible', group: '条件类', defOpen: true,
        hint: '不满足则完全不显示。原版 3954/5499 个决议有',
      },
      {
        key: 'available', label: '可用条件', type: 'script', block: 'available', group: '条件类', defOpen: true,
        hint: '显示了但不能点。原版 3934 个',
      },
      {
        key: 'allowed', label: '允许条件', type: 'script', block: 'allowed', group: '条件类',
        hint: '额外的权限/条件限制。★ 原版是 allowed(带 d),不是 allow',
      },
      { key: 'targetTrigger', label: '目标国条件', type: 'script', block: 'target_trigger', group: '条件类', hint: '带目标的决议才需要' },
      {
        key: 'completeEffect', label: '执行效果', type: 'script', block: 'complete_effect', group: '效果类', defOpen: true,
        hint: '★ 这才是决议真正的效果块。顶层 effect 原版 0 处,别写',
      },
      { key: 'removeEffect', label: '移除后效果', type: 'script', block: 'remove_effect', group: '效果类', hint: '决议过期消失时执行' },
      { key: 'modifier', label: '持续修正器', type: 'script', block: 'modifier', group: '效果类', hint: '如 civilian_factory_use = 0.5' },
    ],
  },
  technology: {
    kind: 'technology',
    label: '科技',
    pathHint: 'common/technologies/<id>.txt',
    fields: [
      { key: 'id', label: '科技 ID', group: '标识', placeholder: 'my_tech', def: 'my_tech' },
      {
        key: 'area', label: '领域', type: 'select', group: '标识', enumFrom: 'categories',
        def: 'industry', hint: '105 个真实取值,原版最多的是 naval_equipment(116)、armor(83)、air_equipment(73)',
      },
      { key: 'cost', label: '研究花费', type: 'number', group: '数值', def: '10' },
      { key: 'year', label: '起始年份', type: 'number', group: '数值', def: '1936' },
      { key: 'x', label: 'X 坐标', type: 'number', group: '布局', def: '0' },
      { key: 'y', label: 'Y 坐标', type: 'number', group: '布局', def: '0' },
      { key: 'folder', label: '文件夹名', group: '布局', placeholder: '留空则用 <id>_folder', hint: '同一文件夹的科技会排在一起' },
      { key: 'enables', label: '解锁的科技 ID', group: '依赖', placeholder: '可留空', hint: '填了生成 path { leads_to_tech = X }' },
      { key: 'enableEquipments', label: '解锁的装备', group: '依赖', placeholder: '多个用逗号分隔', hint: '如 infantry_equipment_1' },
      { key: 'aiWillDo', label: 'AI 权重', type: 'number', group: '数值', def: '1', hint: '科技用 factor(不是决议的 base)' },
    ],
  },
  idea: {
    kind: 'idea',
    label: '理念',
    pathHint: 'common/ideas/<category>.txt',
    fields: [
      { key: 'id', label: '理念 ID', group: '标识', placeholder: 'my_idea', def: 'my_idea' },
      { key: 'category', label: '文件名', group: '标识', placeholder: 'my_ideas', def: 'my_ideas', hint: '只是文件名,不进块结构 —— 结构固定是 ideas > country > <id>' },
      { key: 'icon', label: '图标 GFX', group: '外观', placeholder: 'GFX_idea_generic', def: 'GFX_idea_generic' },
      { key: 'title', label: '标题', group: '本地化', def: '我的理念' },
      { key: 'desc', label: '描述', group: '本地化', def: '理念描述' },
      {
        key: 'allowed', label: '适用条件', type: 'script', block: 'allowed', group: '逻辑', defOpen: true,
        hint: '如 tag = MY。原版 3972/4112 个理念都有',
      },
      {
        key: 'modifier', label: '修正器', type: 'script', block: 'modifier', group: '逻辑', defOpen: true,
        hint: '如 stability_factor = 0.1',
      },
      { key: 'traits', label: '特性', type: 'script', block: 'traits', group: '逻辑', placeholder: '可留空' },
      { key: 'allowedCivilWar', label: '内战适用条件', type: 'script', block: 'allowed_civil_war', group: '逻辑', hint: '内战(叛军政府)时也适用' },
      { key: 'removeModifier', label: '移除条件', type: 'script', block: 'remove_modifier', group: '逻辑', hint: '满足则移除本理念' },
      { key: 'cancelIfInvalid', label: '失效取消条件', type: 'script', block: 'cancel_if_invalid', group: '逻辑', hint: '条件失效则取消理念' },
    ],
  },
  equipment: {
    kind: 'equipment',
    label: '装备',
    pathHint: 'common/units/equipment/<eqType>.txt',
    fields: [
      { key: 'id', label: '装备 ID', group: '标识', placeholder: 'my_equipment', def: 'my_equipment' },
      { key: 'eqType', label: '文件名', group: '标识', placeholder: 'land_equipment', def: 'land_equipment', hint: '原版按装备种类分文件(共 42 个)' },
      { key: 'name', label: '显示名', group: '本地化', def: '我的装备' },
      {
        key: 'equipmentSlot', label: '装备类型', type: 'select', group: '标识', enumFrom: 'type',
        def: 'infantry', hint: '13 个真实取值。★ 没有 land 这种泛称,必须具体:infantry/screen_ship/fighter…',
      },
      { key: 'parent', label: '基础装备 ID', group: '依赖', placeholder: '可留空', hint: '★这是标量,不是块。填 infantry_equipment 就挂到它下面升级' },
      { key: 'year', label: '年份', type: 'number', group: '数值', def: '1936' },
      { key: 'ic', label: '建造 IC', type: 'number', group: '数值', def: '2' },
      { key: 'priority', label: '排序权重', type: 'number', group: '数值' },
      { key: 'reliability', label: '可靠性', type: 'number', group: '属性', placeholder: '0.9' },
      { key: 'maximumSpeed', label: '最大速度', type: 'number', group: '属性', placeholder: '4' },
      { key: 'hardness', label: '硬度', type: 'number', group: '属性' },
      { key: 'armorValue', label: '装甲', type: 'number', group: '属性' },
      { key: 'breakthrough', label: '突破', type: 'number', group: '属性' },
      { key: 'softAttack', label: '软攻', type: 'number', group: '属性' },
      { key: 'hardAttack', label: '硬攻', type: 'number', group: '属性' },
      { key: 'defense', label: '防御', type: 'number', group: '属性' },
      { key: 'apAttack', label: '穿甲', type: 'number', group: '属性' },
      { key: 'airAttack', label: '对空', type: 'number', group: '属性' },
      { key: 'manpower', label: '人力', type: 'number', group: '属性' },
      { key: 'fuelConsumption', label: '燃料消耗', type: 'number', group: '属性' },
      { key: 'active', label: '启用', type: 'bool', group: '开关', def: 'yes', hint: '★是标量 yes/no,不是块' },
      { key: 'isBuildable', label: '可建造', type: 'bool', group: '开关', def: 'yes' },
      { key: 'interfaceCategory', label: '界面分类', type: 'select', group: '外观', enumFrom: 'interface_category', placeholder: '可留空' },
      { key: 'picture', label: '图片 GFX', group: '外观', placeholder: '可留空' },
    ],
  },
  country: {
    kind: 'country',
    label: '国家',
    pathHint: 'history/countries/<TAG> - <国名>.txt',
    fields: [
      { key: 'tag', label: '国家 TAG', group: '标识', placeholder: 'MY', def: 'MY' },
      { key: 'name', label: '国名', group: '本地化', def: '我的国家' },
      { key: 'adj', label: '形容词', group: '本地化', def: '我的', hint: '如 GER_ADJ = German' },
      { key: 'nationalFocus', label: '国策树 ID', group: '关联', placeholder: '可留空', hint: 'national_focus = <树 id>' },
      { key: 'ideas', label: '国家精神', group: '关联', placeholder: '多个逗号分隔', hint: 'add_ideas = { <id> }' },
      { key: 'rulingParty', label: '执政党', type: 'select', group: '政治', values: ['democratic', 'fascism', 'communism', 'neutrality'], def: 'neutrality' },
      { key: 'electionsAllowed', label: '允许选举', type: 'bool', group: '政治', def: 'yes' },
      { key: 'electionFrequency', label: '选举频率(年)', type: 'number', group: '政治', def: '4' },
      { key: 'lastElection', label: '上次选举日期', group: '政治', def: '1936.1.1' },
      { key: 'popularities', label: '四党受欢迎度', type: 'script', block: 'set_popularities', group: '政治', defOpen: true, def: 'neutrality = 100', hint: '每行一党,如 neutrality = 100 / fascism = 20' },
      { key: 'coreStates', label: '核心州', group: '领土', placeholder: '多个逗号分隔', hint: 'add_core_of = { <state id> }' },
      { key: 'capital', label: '首都州 ID', group: '领土', placeholder: '如 1', hint: 'set_capital = <state id>' },
      { key: 'officialLanguage', label: '官方语言', group: '文化', placeholder: '如 MY', hint: 'set_official_language' },
    ],
  },
}
/** 兼容旧名(前端与测试曾引用 GEN_FIELDS) */
export const GEN_FIELDS: Record<GenKind, GenField[]> = Object.fromEntries(
  Object.entries(GEN_SCHEMA).map(([k, v]) => [k, v.fields]),
) as Record<GenKind, GenField[]>

/** 中文名映射(旧代码用) */
export const GEN_KIND_LABEL: Record<GenKind, string> = Object.fromEntries(
  Object.entries(GEN_SCHEMA).map(([k, v]) => [k, v.label]),
) as Record<GenKind, string>
