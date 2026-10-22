/**
 * 国策树模型(national_focus)。
 *
 * 官方没有 national_focus.md 文档,本模块的 schema 是从 vanilla + KR + RT56 统计出来的
 * (见 cli/src/diag-focus.ts 与 diag-focus2.ts):
 *
 *   文件根级可以出现四种块:
 *     focus_tree = { ... }      448 棵
 *     shared_focus = { ... }    3077 个 ← 多国共享国策的"定义"
 *     joint_focus = { ... }      568 个 ← 联合国策(北欧/刚果/萨达巴德…)
 *     style = { ... }             24 个 ← 标题栏贴图
 *
 *   focus_tree 里:
 *     focus = { ... }           49961 个
 *     shared_focus = <id>         756 个 ← 注意:这里是"引用",是个简单值不是块
 *     shortcut / inlay_window / continuous_focus_position / initial_show_position
 *
 *   focus 里 100% 存在的键: id icon completion_reward cost x y
 *   94% 有 relative_position_id  ← 坐标是"相对另一个国策"的偏移
 *   108% 有 prerequisite         ← 平均 1.09 个,一个块里可写多个 focus = xxx
 *
 *   joint_focus 额外有:text_icon(100%) completion_reward_joint_originator(93%)
 *   completion_reward_joint_member(84%) joint_trigger(47%) dynamic(36%)
 *
 * 两个必须正确处理的坑:
 *  1) x/y 默认不是绝对坐标。x = -3 y = 1 relative_position_id = GER_x 意味着
 *     "相对 GER_x 再往左 3、往下 1"。要画出正确的图必须递归展开成绝对坐标,
 *     并且要防环(A 相对 B、B 相对 A)。
 *  2) focus_tree 里的 shared_focus = XXX 只是一个 id,真正的定义在别处——
 *     通常是另一个文件的根级 shared_focus 块。不处理根级定义,画布上就是空框。
 *
 * 与 parser 一致的原则:只存位置(文件 + 键路径 + 行号),不持有 AST 对象。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import type { TrigNode } from './trigger.ts'
import { collectConditions } from './trigger.ts'
import { parseOffsets, parseTriggerBlocks, parseTriggerBlock, type OffsetRule } from './trigger-parse.ts'
import { isUnloadedByLaterReplacePath } from '../../engine/src/assetsrc.ts'
import { type NormPath } from '../../engine/src/modmeta.ts'

export interface FocusRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

export type FocusKind = 'focus' | 'shared' | 'joint'

export interface FocusNode {
  /** focus id */
  id: string
  /** focus(树内) / shared(根级共享定义) / joint(根级联合国策) */
  kind: FocusKind
  icon: string
  /** ★ 条件图标 icon = { GFX_a={cond} GFX_b={cond} } → [{tex, trig}]，前端按条件选当前 */
  iconList?: { tex: string; trig: TrigNode | null }[]
  /** joint_focus 的 text_icon —— 与 icon 常成对出现 */
  textIcon?: string
  /** 声明的 x/y(可能是相对值) */
  x: number
  y: number
  /** relative_position_id —— 有则 x/y 是相对它的偏移 */
  rel?: string
  /** 解析后的绝对坐标 */
  ax: number
  ay: number
  /** offset 条件偏移生效时的坐标 —— offset 形如 { x y trigger },
   *  trigger 命中才生效,所以"主坐标"必须是不含 offset 的那一份 */
  axOff?: number
  ayOff?: number
  cost: number
  /** prerequisite / mutually_exclusive 里的 focus 列表 */
  prereq: string[]
  /** mutually_exclusive 里的 focus 列表 */
  mutex: string[]
  /**
   * ★ OR_V1:保留"且 / 或"的原始结构(2026-10-07 新增)。
   *
   * 旧版把 `OR = { focus = X }` 里的 X 直接丢弃,导致:
   *   - 只写了 OR 的前置(实测模组里常见)→ 画成"无前置",连线缺失;
   *   - 写了 focus 又写了 OR 的 → 画成"全都要",连线多出一堆。
   * 两者都是"连错/连不上"的直接成因。
   *
   * 语义:prereqGroups[].focus 是**全部都要**;
   *      prereqGroups[].or 是**任选其一**(每个内层数组是一组候选)。
   */
  prereqGroups?: { focus: string[]; or: string[][] }[]
  /** 同上,互斥 */
  mutexGroups?: { focus: string[]; or: string[][] }[]
  /** allow_branch 里的 focus / has_completed_focus 列表(决定该国策何时显形) */
  branch: string[]
  /** allow_branch 块原始文本(条件原文,供检查器"显示详情";实测块内是 trigger 组合而非 focus) */
  branchRaw?: string
  /** will_lead_to_war_with */
  warWith?: string
  /* ══════════════ TRIGGERS_V1(2026-10-07)══════════════════════════
   * 旧版这里只有一个 `offset?: {x,y}`,而实测原版 offset 是【列表】且每条
   * 带自己的 trigger(czechoslovakia_mu.txt 98 个 offset / hungary_wuw.txt 84 个)——
   * 命中哪条就显示在对应位置。旧版只取第一条且丢掉 trigger = 只认一种布局。
   */
  /** 全部 offset 规则(逐条带自己的 trigger),求值命中的全部叠加 */
  offsetRules?: OffsetRule[]
  /** offset = { x y trigger } 条件偏移 */
  offset?: { x: number; y: number }
  /* ★ allow_branch 的完整条件表达式树(MU 语义)。
   * 旧版只grep has_completed_focus 当门控,实测原版 553 个 allow_branch 块里
   * has_dlc 122 个 / has_game_rule 241 个,块内几乎没有 focus =(仅 1 处)
   * —— 这些最主要的分支开关全被丢掉了。 */
  allowBranchTrig?: TrigNode
  /** available = { ... } 完整条件树 */
  availableTrig?: TrigNode
  /** 该国策树上出现过的、可做成 UI 开关的条件 key(去重) */
  trigKeys?: string[]
  /** 有 available 块 */
  hasAvailable: boolean
  /** 有 bypass */
  hasBypass: boolean
  /** 有 continue_if_invalid / cancel_if_invalid */
  continuous: boolean
  /** joint_focus 独有:联合发起者 / 成员奖励块 */
  jointOriginator: boolean
  jointMember: boolean
  /** joint_focus:dynamic = yes(动态生成) */
  dynamic: boolean
  /** offset = { x y trigger } 条件偏移(原始块文本,含 trigger) */
  offsetRaw?: string
  /** available 块原始文本(出现条件) */
  available?: string
  /** ai_will_do 块原始文本(AI 完成意愿) */
  aiWillDo?: string
  /** completion_reward 块原始文本(完成奖励) */
  completionReward?: string
  /** search_filters 块原始文本(搜索过滤标签) */
  searchFilters?: string
  /** complete_tooltip 块原始文本(完成奖励提示,effect 块) */
  completeTooltip?: string
  /** select_effect 块原始文本(选择时效果,无 tooltip) */
  selectEffect?: string
  /** bypass_effect 块原始文本(跳过时效果) */
  bypassEffect?: string
  /** cancel_effect 块原始文本(取消时效果,连续国策) */
  cancelEffect?: string
  /** joint_trigger 块原始文本(joint_focus 联合条件) */
  jointTrigger?: string
  /** enable_automatic_bypass = no(禁止自动跳过) */
  autoBypassDisabled?: boolean
  /** bypass_if_unavailable = yes(条件不满足自动跳过) */
  bypassIfUnavailable?: boolean
  /** bypass 块原始文本(跳过条件) */
  bypass?: string
  /** 所属 focus_tree id;shared/joint 为空串(它们不属于任何一棵树) */
  tree: string
  root: number
  file: string
  line: number
  /** 键路径,定位用 */
  path: string[]
}

export interface FocusTree {
  id: string
  root: number
  file: string
  line: number
  /** country 块里的 tag 列表 */
  tags: string[]
  default: boolean
  resetOnCivilwar: boolean
  /** focus id 列表(按文件顺序) */
  nodes: string[]
  /** shared_focus 引用 */
  shared: string[]
  /** continuous_focus_position */
  cfp?: { x: number; y: number }
  /** initial_show_position —— 打开树时镜头初始位置 */
  isp?: { x: number; y: number }
  /** shortcut = { name target scroll_wheel_factor } */
  shortcuts: { name: string; target: string; factor?: number }[]
  /** inlay_window 名(与 interface 联动) */
  inlayWindows: string[]
  /**
   * ★★★ INLAY_SLOT_V1:inlay_window 的【槽位坐标】(国策树坐标系)。
   *
   * 官方 documentation.md 原文:
   *   ```
   *   inlay_window = {
   *       id = inlay_window_id
   *       position = { x = XXX y = YYY }   # same syntax and scale as continuous focus position
   *   }
   *   ```
   * 即 inlay 组件【摆放在国策树的坐标系里】,和 continuous focus 同一套坐标,
   * **不是**屏幕 1920×1080 坐标。vanilla 的 ger_inner_circle_inlay_window
   * 被摆在 `position = { x = 4500 y = 1150 }` —— 离屏很远,按屏幕定位必然错。
   *
   * 之前只存了 `inlayWindows: string[]`(名字),把 position 丢了,
   * 导致 designer 只能把这个窗口当普通屏幕窗口画,于是"位置错误"。
   * 这里补上,供 gui 侧还原真实槽位。
   */
  inlaySlots: { id: string; x: number; y: number }[]
  /** continuous 区块里的 focus(循环国策) */
  continuousIds: string[]
}

export interface FocusGraph {
  roots: FocusRoot[]
  trees: FocusTree[]
  /** id → 节点(跨所有 root;后者覆盖前者,与游戏覆盖语义一致) */
  nodes: Map<string, FocusNode>
  /** tree id → 最终生效的那份(后加载的覆盖先加载的,与 g.nodes 语义一致) */
  byId: Map<string, FocusTree>
  /** tree id → 所有版本(谁覆盖了谁),供 UI 展示覆盖链 */
  versions: Map<string, { root: number; file: string; line: number }[]>
  /** 每个 id 的定义位置(可能多份:vanilla 定义 + mod 覆盖) */
  defs: Map<string, { root: number; file: string; line: number }[]>
  /** 根级 shared_focus / joint_focus 定义的 id(不属于任何树) */
  sharedIds: string[]
  jointIds: string[]
  /** 解析坐标时发现的环 */
  cycles: string[][]
  /** relative_position_id 指向不存在的 focus;via 是相对链,便于回溯 */
  danglingRel: { id: string; rel: string; file: string; line: number; via: string[] }[]
  /** prerequisite / mutex 指向不存在的 focus */
  danglingLink: { id: string; target: string; kind: string; file: string; line: number }[]
}

export function walkFocusFiles(dir: string): string[] {
  const out: string[] = []
  let ents: string[] = []
  try {
    ents = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of ents) {
    const p = join(dir, e)
    let st: { isDirectory(): boolean }
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walkFocusFiles(p))
    else if (e.toLowerCase().endsWith('.txt')) out.push(p)
  }
  return out
}

export function buildFocusGraph(roots: FocusRoot[]): FocusGraph {
  const g: FocusGraph = {
    roots,
    trees: [],
    nodes: new Map(),
    byId: new Map(),
    versions: new Map(),
    defs: new Map(),
    sharedIds: [],
    jointIds: [],
    cycles: [],
    danglingRel: [],
    danglingLink: [],
  }

  roots.forEach((r, ri) => {
    for (const abs of walkFocusFiles(join(r.path, 'common', 'national_focus'))) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      const fvars = scanFileVars(doc)
      for (const e of doc.root.entries) {
        const k = keyText(doc, e) ?? '?'
        const low = k.toLowerCase()
        // focus_tree 内的定义
        if (low === 'focus_tree' && e.block) {
          readTree(doc, e.block, ri, file, lineOf(doc, e), g, fvars)
          continue
        }
        // 根级定义:shared_focus / joint_focus。它们不属于任何一棵树,
        // 靠 focus_tree 里的 `shared_focus = <id>` 引用进来。
        if ((low === 'shared_focus' || low === 'joint_focus') && e.block) {
          const kind: FocusKind = low === 'joint_focus' ? 'joint' : 'shared'
          const n = readFocus(doc, e.block, ri, file, '', [low], kind, lineOf(doc, e), fvars)
          if (!n) continue
          register(g, n)
          if (kind === 'joint') {
            if (!g.jointIds.includes(n.id)) g.jointIds.push(n.id)
          } else if (!g.sharedIds.includes(n.id)) g.sharedIds.push(n.id)
        }
      }
    }
  })

  resolvePositions(g)
  checkLinks(g)
  return g
}

/** 登记一个定义:后者覆盖前者(游戏加载顺序即覆盖顺序) */
function register(g: FocusGraph, n: FocusNode): void {
  g.nodes.set(n.id, n)
  const list = g.defs.get(n.id) ?? []
  list.push({ root: n.root, file: n.file, line: n.line })
  g.defs.set(n.id, list)
}

function readTree(doc: Document, b: Block, ri: number, file: string, line: number, g: FocusGraph, fvars: Map<string, number>): void {
  const id = childValue(doc, b, 'id') ?? '(anonymous)'
  const tree: FocusTree = {
    id,
    root: ri,
    file,
    line,
    tags: [],
    default: /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'default') ?? ''),
    resetOnCivilwar: /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'reset_on_civilwar') ?? ''),
    nodes: [],
    shared: [],
    shortcuts: [],
    inlayWindows: [],
    inlaySlots: [],
    continuousIds: [],
  }

  for (const cb of childBlocks(doc, b, 'country')) {
    // country = { factor = 0 modifier = { add = 10 tag = GER } }
    for (const m of childBlocks(doc, cb, 'modifier')) {
      const t = childValue(doc, m, 'tag')
      if (t) tree.tags.push(t)
    }
  }
  const cfp = childBlock(doc, b, 'continuous_focus_position')
  if (cfp) {
    const x = resolveNum(childValue(doc, cfp, 'x'), fvars)
    const y = resolveNum(childValue(doc, cfp, 'y'), fvars)
    if (x !== undefined && y !== undefined) tree.cfp = { x, y }
  }
  const isp = childBlock(doc, b, 'initial_show_position')
  if (isp) {
    const x = resolveNum(childValue(doc, isp, 'x'), fvars)
    const y = resolveNum(childValue(doc, isp, 'y'), fvars)
    if (x !== undefined && y !== undefined) tree.isp = { x, y }
  }
  for (const s of childBlocks(doc, b, 'shortcut')) {
    const name = childValue(doc, s, 'name')
    const target = childValue(doc, s, 'target')
    if (!name || !target) continue
    const f = num(childValue(doc, s, 'scroll_wheel_factor'))
    tree.shortcuts.push({ name, target, factor: f })
  }
  for (const iw of childBlocks(doc, b, 'inlay_window')) {
    const wid = childValue(doc, iw, 'id')
    if (!wid) continue
    if (!tree.inlayWindows.includes(wid)) tree.inlayWindows.push(wid)
    // ★★★ INLAY_SLOT_V1:连槽位坐标一起存(国策树坐标系,非屏幕坐标)。
    //   官方 documentation.md 明确写 "same syntax and scale as continuous focus position"。
    //   缺 position 时按 {0,0} 记(国策树左上角),与游戏"未指定即原点"一致。
    const pb = childBlock(doc, iw, 'position')
    const ix = pb ? resolveNum(childValue(doc, pb, 'x'), fvars) : undefined
    const iy = pb ? resolveNum(childValue(doc, pb, 'y'), fvars) : undefined
    tree.inlaySlots.push({ id: wid, x: ix ?? 0, y: iy ?? 0 })
  }

  for (const e of b.entries) {
    const k = keyText(doc, e) ?? '?'
    const low = k.toLowerCase()
    if (low === 'focus' && e.block) {
      const n = readFocus(doc, e.block, ri, file, id, ['focus_tree', id, 'focus'], 'focus', lineOf(doc, e), fvars)
      if (!n) continue
      register(g, n)
      if (!tree.nodes.includes(n.id)) tree.nodes.push(n.id)
      if (n.continuous) tree.continuousIds.push(n.id)
    } else if (low === 'shared_focus') {
      // 树内的 shared_focus = <id> 是引用(简单值),定义通常在别的文件
      const sid = valueText(doc, e)
      if (!sid) continue
      if (!tree.shared.includes(sid)) tree.shared.push(sid)
    }
  }

  g.trees.push(tree)
  // 同名树:后加载的整体覆盖先加载的(节点坐标取最终生效版本,否则会把
  // vanilla 的节点列表和 mod 的坐标混在一起,制造出根本不存在的"重叠")
  g.byId.set(id, tree)
  const vs = g.versions.get(id) ?? []
  vs.push({ root: ri, file, line })
  g.versions.set(id, vs)
}

function readFocus(
  doc: Document,
  b: Block,
  ri: number,
  file: string,
  tree: string,
  basePath: string[],
  kind: FocusKind,
  line: number,
  fvars: Map<string, number>,
): FocusNode | undefined {
  const id = childValue(doc, b, 'id')
  if (!id) return undefined
  const x = resolveNum(childValue(doc, b, 'x'), fvars) ?? 0
  const y = resolveNum(childValue(doc, b, 'y'), fvars) ?? 0
  /* ★ TRIGGERS_V1:offset 是【列表】,每条带自己的 trigger。
   * 旧版 childBlock() 只取第一个 → 只认一种布局,分支位置全错
   * (实测 czechoslovakia_mu.txt 一棵树里就有 98 个 offset)。 */
  const offsetRules = parseOffsets(doc, b)
  const off = offsetRules.length ? offsetRules[0] : undefined
  const offset = off ? { x: off.x, y: off.y } : undefined
  const node: FocusNode = {
    id,
    kind,
    icon: childValue(doc, b, 'icon') ?? '',
    iconList: parseIconList(doc, b),
    textIcon: childValue(doc, b, 'text_icon'),
    x,
    y,
    rel: childValue(doc, b, 'relative_position_id'),
    ax: x,
    ay: y,
    cost: num(childValue(doc, b, 'cost')) ?? 0,
    prereq: [],
    mutex: [],
    branch: [],
    warWith: childValue(doc, b, 'will_lead_to_war_with'),
    offset,
    offsetRules: offsetRules.length ? offsetRules : undefined,
    hasAvailable: childBlock(doc, b, 'available') !== undefined,
    hasBypass: childBlock(doc, b, 'bypass') !== undefined,
    continuous:
      childValue(doc, b, 'continue_if_invalid') !== undefined ||
      childValue(doc, b, 'cancel_if_invalid') !== undefined,
    jointOriginator: childBlock(doc, b, 'completion_reward_joint_originator') !== undefined,
    jointMember: childBlock(doc, b, 'completion_reward_joint_member') !== undefined,
    dynamic: /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'dynamic') ?? ''),
    tree,
    root: ri,
    file,
    line,
    path: [...basePath, id],
  }
  /* ★★★ OR_V1:prerequisite / mutually_exclusive 的 focus 与 OR 必须分开(2026-10-07)。
   *
   * HOI4 的语义:
   *   prerequisite = { focus = A  focus = B }        → A 且 B 都要完成
   *   prerequisite = { OR = { focus = A } OR = { focus = B } }
   *                                              → A 或 B 完成其一即可
   *
   * 旧代码只抓 `focus`,把 OR 里的 focus **整个丢掉** → 前置少的节点
   * 画出来是"谁都不要"(实际是"任选其一"),前置多的画成"全都要"。
   * 这就是国策树连线"有的连错、有的连不上"的主因之一 ——
   * 连线少了一截,看起来像断链。
   *
   * 保留 prereq/mutex 扁平字段不动(向后兼容:检查器列表、检查器明细、
   * shared_focus 子树推导都在用),新增结构化字段表达"且/或"。
   * 前端据此把 OR 边画成另一种线型,一眼看出是二选一。
   */
  const prereqGroups: { focus: string[]; or: string[][] }[] = []
  for (const p of childBlocks(doc, b, 'prerequisite')) {
    const focusPart = allValues(doc, p, 'focus')
    const orParts: string[][] = []
    for (const o of childBlocks(doc, p, 'OR')) {
      const ids = allValues(doc, o, 'focus')
      if (ids.length) orParts.push(ids)
    }
    if (focusPart.length || orParts.length) prereqGroups.push({ focus: focusPart, or: orParts })
    for (const v of focusPart) node.prereq.push(v)
    for (const grp of orParts) for (const v of grp) node.prereq.push(v)
  }
  if (prereqGroups.length) node.prereqGroups = prereqGroups

  const mutexGroups: { focus: string[]; or: string[][] }[] = []
  for (const m of childBlocks(doc, b, 'mutually_exclusive')) {
    const focusPart = allValues(doc, m, 'focus')
    const orParts: string[][] = []
    for (const o of childBlocks(doc, m, 'OR')) {
      const ids = allValues(doc, o, 'focus')
      if (ids.length) orParts.push(ids)
    }
    if (focusPart.length || orParts.length) mutexGroups.push({ focus: focusPart, or: orParts })
    for (const v of focusPart) node.mutex.push(v)
    for (const grp of orParts) for (const v of grp) node.mutex.push(v)
  }
  if (mutexGroups.length) node.mutexGroups = mutexGroups
  /* ══════════════ TRIGGERS_V1:allow_branch 保留完整条件树 ══════════════
   * 实测原版 553 个 allow_branch 块:块内几乎没有 focus =(仅 1 处),
   * 它是"分支显形条件"——has_completed_focus(370) / has_dlc(122) /
   * has_game_rule(241) / has_country_flag / original_tag / NOT / OR / IF 的组合。
   * 旧版只 grep has_completed_focus,其余门控全丢 → DLC 分支开关不生效。
   * 现在:条件树(可求值)+ branch[] 兼容字段(只留 focus 类,给旧前端用)。 */
  const abTrigs = parseTriggerBlocks(doc, b, 'allow_branch')
  if (abTrigs.length === 1) node.allowBranchTrig = abTrigs[0]
  else if (abTrigs.length > 1) node.allowBranchTrig = { type: 'and', items: abTrigs }
  const avTrigs = parseTriggerBlocks(doc, b, 'available')
  if (avTrigs.length === 1) node.availableTrig = avTrigs[0]
  else if (avTrigs.length > 1) node.availableTrig = { type: 'and', items: avTrigs }
  if (node.allowBranchTrig || node.availableTrig) {
    /* 该国策自身条件树的唯一条件(nodeContent 列表,检查器展示;面板用的是服务端全树 conditions) */
    const conds = collectConditions(node.allowBranchTrig)
    collectConditions(node.availableTrig, conds)
    if (conds.size) node.trigKeys = [...conds.values()].map((c) => c.nodeContent)
  }
  for (const a of childBlocks(doc, b, 'allow_branch')) {
    for (const v of allValues(doc, a, 'focus')) node.branch.push(v)
    for (const v of allValues(doc, a, 'has_completed_focus')) node.branch.push(v)
    for (const nested of a.entries) {
      if (nested.block) for (const v of allValues(doc, nested.block, 'has_completed_focus')) node.branch.push(v)
    }
  }
  // 去重(同一 focus 可能既 focus= 又 has_completed_focus=)
  if (node.branch.length > 1) node.branch = [...new Set(node.branch)]
  const brE = childEntry(doc, b, 'allow_branch')
  if (brE) node.branchRaw = entryText(doc, brE)
  // ★ 无损还原"条件类"块原始文本,供检查器"显示详情"直接展示游戏原文
  //   (available / ai_will_do / completion_reward / search_filters / bypass / offset)。
  //   只存文本、不持 AST,符合本模块"只存位置"的原则;前端按原样高亮即可。
  const avE = childEntry(doc, b, 'available'); if (avE) node.available = entryText(doc, avE)
  const awE = childEntry(doc, b, 'ai_will_do'); if (awE) node.aiWillDo = entryText(doc, awE)
  const crE = childEntry(doc, b, 'completion_reward'); if (crE) node.completionReward = entryText(doc, crE)
  const sfE = childEntry(doc, b, 'search_filters'); if (sfE) node.searchFilters = entryText(doc, sfE)
  const bpE = childEntry(doc, b, 'bypass'); if (bpE) node.bypass = entryText(doc, bpE)
  const offE = childEntry(doc, b, 'offset'); if (offE) node.offsetRaw = entryText(doc, offE)
  /* ★ WIKI_FIELDS_V1:Wiki《National focus modding》定义的补充效果/条件块,检查器按 Wiki 语义分组展示。 */
  const ctE = childEntry(doc, b, 'complete_tooltip'); if (ctE) node.completeTooltip = entryText(doc, ctE)
  const selE = childEntry(doc, b, 'select_effect'); if (selE) node.selectEffect = entryText(doc, selE)
  const bpEff = childEntry(doc, b, 'bypass_effect'); if (bpEff) node.bypassEffect = entryText(doc, bpEff)
  const ceE = childEntry(doc, b, 'cancel_effect'); if (ceE) node.cancelEffect = entryText(doc, ceE)
  const jtE = childEntry(doc, b, 'joint_trigger'); if (jtE) node.jointTrigger = entryText(doc, jtE)
  node.autoBypassDisabled = /^\s*(no|false)\s*\$/i.test(childValue(doc, b, 'enable_automatic_bypass') ?? '')
  node.bypassIfUnavailable = /^\s*(yes|true)\s*\$/i.test(childValue(doc, b, 'bypass_if_unavailable') ?? '')
  return node
}

/** 递归展开相对坐标 → 绝对坐标;带环检测 */
function resolvePositions(g: FocusGraph): void {
  for (const n of g.nodes.values()) {
    if (!n.rel) {
      n.ax = n.x
      n.ay = n.y
    } else {
      const chain: string[] = [n.id]
    const seen = new Set<string>([n.id])
    let cur = n
    let ax = n.x
    let ay = n.y
    let depth = 0
    while (cur.rel) {
      if (depth++ > 64) break
      const p = g.nodes.get(cur.rel)
      if (!p) {
        // 缺的是链尾 cur.rel;受影响的是起点 n.id
        g.danglingRel.push({ id: n.id, rel: cur.rel, file: cur.file, line: cur.line, via: [...chain] })
        break
      }
      if (seen.has(p.id)) {
        g.cycles.push([...chain, p.id])
        break
      }
      seen.add(p.id)
      chain.push(p.id)
      ax += p.x
      ay += p.y
      cur = p
    }
      n.ax = ax
      n.ay = ay
    }
    if (n.offset) {
      n.axOff = n.ax + n.offset.x
      n.ayOff = n.ay + n.offset.y
    }
  }
}

function checkLinks(g: FocusGraph): void {
  for (const n of g.nodes.values()) {
    for (const t of n.prereq) {
      if (!g.nodes.has(t)) g.danglingLink.push({ id: n.id, target: t, kind: 'prerequisite', file: n.file, line: n.line })
    }
    for (const t of n.mutex) {
      if (!g.nodes.has(t)) g.danglingLink.push({ id: n.id, target: t, kind: 'mutually_exclusive', file: n.file, line: n.line })
    }
    for (const t of n.branch) {
      if (!g.nodes.has(t)) g.danglingLink.push({ id: n.id, target: t, kind: 'allow_branch', file: n.file, line: n.line })
    }
  }
}

/* ── 小工具 ── */

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : undefined
}

/* ★ @常量按【文件】作用域(游戏特性):`@名 = 值` 定义、`变量 = @名` 使用,
   且仅本文件可见 —— 各文件同名常量数值可不同(实测 tech 文件 infantry @1936=2、
   NSB_armor @1936=4)。不能在文件间串味。 */
function scanFileVars(doc: Document): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (b: Block): void => {
    for (const e of b.entries) {
      const k = keyText(doc, e)
      if (k?.startsWith('@') && e.value >= 0) {
        const v = num(valueText(doc, e))
        if (v !== undefined) m.set(k.slice(1), v)
      }
      if (e.block) walk(e.block)
    }
  }
  walk(doc.root)
  return m
}
function resolveNum(s: string | undefined, vars: Map<string, number>): number | undefined {
  if (s === undefined) return undefined
  if (s.startsWith('@')) return vars.get(s.slice(1))
  return num(s)
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  }
  return undefined
}

function childBlocks(doc: Document, b: Block, key: string): Block[] {
  const out: Block[] = []
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) out.push(e.block)
  }
  return out
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  }
  return undefined
}
/** ★ ICON_COND_V1:icon = { GFX_a = { 条件 } GFX_b = { 条件 } } 条件图标。
 *  解析成 [{tex, trig}]，前端按条件求值选当前图标；标量 icon 返回 undefined。 */
function parseIconList(doc: Document, b: Block): { tex: string; trig: TrigNode | null }[] | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() !== 'icon') continue
    if (!e.block) return undefined
    const blk = e.block
    const out: { tex: string; trig: TrigNode | null }[] = []
    for (const se of blk.entries) {
      const tex = keyText(doc, se)
      if (!tex) continue
      const low = tex.toLowerCase()
      if (low === 'days' || low === 'traditions' || low === 'idle') continue
      let trig: TrigNode | null = null
      if (se.block) {
        try { trig = parseTriggerBlock(doc, se.block) } catch { trig = null }
      }
      out.push({ tex, trig })
    }
    return out.length ? out : undefined
  }
  return undefined
}

/** 块内所有同名键的值 —— prerequisite = { focus = A focus = B } */
function allValues(doc: Document, b: Block, key: string): string[] {
  const out: string[] = []
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() !== key.toLowerCase()) continue
    const v = valueText(doc, e)
    if (v) out.push(v)
  }
  return out
}

/** 取某个键对应的 Entry(含块),用于无损还原其原始文本 */
function childEntry(doc: Document, b: Block, key: string): Entry | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return e
  }
  return undefined
}

/** 无损还原一个 Entry 的原始文本(含 `key =` 与整块),供检查器"显示详情"展示游戏原文 */
function entryText(doc: Document, e: Entry): string {
  let s = ''
  for (let i = e.start; i < e.end; i++) s += doc.tokens[i].text
  return s.trim()
}

/**
 * ★★★ 共享国策树要连【整棵子树】一起加载(SHARED_SUBTREE_V1)。
 *
 * 游戏语义(实测 vanilla,不要凭直觉简化):
 *   `focus_tree = { shared_focus = SMB_army }` 引的是**一个共享分支的根**,
 *   游戏会把该根**及其全部子孙**都挂进这棵树。子孙关系由 `prerequisite` 表达:
 *     shared_focus = { id = SMB_military_facilities
 *                      relative_position_id = SMB_army
 *                      prerequisite = { focus = SMB_army } }
 *   `relative_position_id` 只管坐标,`prerequisite` 才管"挂在谁后面"。
 *
 * 反面教材:argentine.txt 第 36-38 行只引了 SMB_army / SMB_air_force / SMB_navy 三个 id,
 * 而 toa_shared_military_branch.txt 里这三个根下共有 **76 个** shared_focus 节点。
 * 只按 `tree.shared` 直取 → 树里凭空少了 73 个节点,坐标范围也小了一圈。
 *
 * 所以这里:先把 sharedIds/jointIds 全量建成"父 → 子"索引,再从引用点广度优先展开。
 * 深度上限防环(理论上 prerequisite 不该成环,实测 mod 里可能有)。
 */
export function treeNodes(g: FocusGraph, tree: FocusTree): FocusNode[] {
  /* 子索引:prereq 指向 parentId 的所有 shared/joint 节点 */
  const childrenOf = new Map<string, string[]>()
  for (const id of [...g.sharedIds, ...g.jointIds]) {
    const n = g.nodes.get(id)
    if (!n) continue
    for (const p of n.prereq) {
      const arr = childrenOf.get(p) ?? []
      arr.push(id)
      childrenOf.set(p, arr)
    }
  }

  const out: FocusNode[] = []
  const seen = new Set<string>()
  const queue: string[] = [...tree.nodes, ...tree.shared]
  /**
   * ★ expand 要【传播】:被引用的根要展开子树,而子树里的节点自己也要展开
   *   (SMB_army → SMB_military_facilities → SMB_motorized → SMB_tank_warfare …)。
   *   只展开第一层的话,76 个共享节点只会拉进来 13 个 —— 实测踩过这个坑。
   */
  const expand = new Set(tree.shared)

  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    if (seen.has(id)) continue
    seen.add(id)
    const n = g.nodes.get(id)
    if (!n) continue
    out.push(n)
    if (!expand.has(id)) continue
    for (const c of childrenOf.get(id) ?? []) {
      if (seen.has(c)) continue
      // 子节点也是共享树的一部分 → 继续向下展开
      expand.add(c)
      queue.push(c)
    }
    if (head > 200_000) break
  }
  return out
}

/**
 * shortcut 明细(供 UI 展示跳转点)。
 *
 * `ids` 直接传 treeNodes 的结果(节点上千个,别为了一个判存在重跑整棵树展开)。
 * `inTree=false` 表示 target 不在本树可见集合里 —— 游戏里这种快捷方式点了会跳空,
 * 属于模组数据错误,UI 要标出来而不是默默画一条指向虚空的线。
 */
export function shortcutJson(
  tree: FocusTree,
  ids: Set<string>,
): { name: string; target: string; factor?: number; inTree: boolean }[] {
  return tree.shortcuts.map((s) => ({ ...s, inTree: ids.has(s.target) }))
}
