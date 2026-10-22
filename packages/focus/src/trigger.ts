/* ══════════════════════════════════════════════════════════════════
 * trigger.ts —— 国策/科技条件表达式与求值(TRIGGERS_V1, 忠实移植 HOI4 Mod Utilities 0.18.1)
 *
 * 直接采用 MU 的条件模型(dist/extension.js 的 F() 与 static/common.js 的 QV):
 *   - 每个条件叶子被【规范化】成 {scopeName:'', nodeContent:'key = value'} 对,
 *     nodeContent 就是 `has_completed_focus = AFG_x` / `has_dlc = Man the Guns`
 *     这种可直接读的字符串(字符串值去掉两侧引号)。
 *   - QV(cond, scopes):求值 =【按相等匹配】—— 叶子在「用户选中的条件集合」里
 *     命中原样字符串即 true,否则 false。MU 没有"未知"态。
 *   - and / or / andnot / ornot / count 按 MU 的真值表组合。
 *   - scope = 用户选中的那组 nodeContent 的集合(Set<string>)。国策/科技 allow_branch
 *     的 scopeName 恒 ''(国家作用域),故直接用字符串集合。
 *
 * ── 与旧版(近似)的本质区别 ──
 *   旧版:按 arity 分类(flag/focus/tech/gamerule/tag)+ 三态(true/false/null 灰显)。
 *   本版:不再猜键的"语义类别",一切按规范化字符串相等匹配 —— 与 MU 一致,
 *         分支显隐不再有「未知灰显」这种 MU 没有的行为。
 * ══════════════════════════════════════════════════════════════════ */

/** 表达式节点 */
export type TrigNode =
  | { type: 'and'; items: TrigNode[] }
  | { type: 'or'; items: TrigNode[] }
  | { type: 'not'; items: TrigNode[] }
  | { type: 'andnot'; items: TrigNode[] }
  | { type: 'ornot'; items: TrigNode[] }
  | { type: 'count'; amount: number; items: TrigNode[] }
  | { type: 'bool'; value: boolean }
  /** 叶子:nodeContent 是规范化字符串(如 has_dlc = Man the Guns) */
  | { type: 'leaf'; key: string; value: string; nodeContent: string; raw: string }

/** scope = 用户选中的那组 nodeContent 的集合(MU 的 scopes 数组的简化) */
export type ConditionScope = Set<string>

export function emptyScope(): ConditionScope {
  return new Set()
}

/** 规范化叶子条件:key = value(去掉字符串两侧引号) */
export function canonicalCondition(key: string, value: string): string {
  const k = (key || '').trim()
  const v = (value || '').trim().replace(/^"(.*)"$/, '$1')
  return `${k} = ${v}`
}

/**
 * ★ 求值入口 —— 照搬 MU 0.18.1 的 QV(static/common.js module 292):
 *   leaf(无 items)→ 在 scopes 里按相等命中;否则 false(两态)。
 *   count → 命中数 ≥ amount。
 *   and / or / andnot / ornot → 按 MU 真值表短路:
 *     and    : 任一子项 false → false;否则 true
 *     or     : 任一子项 true  → true; 否则 false
 *     andnot : 任一子项 false → true; 否则 false   (= NAND)
 *     ornot  : 任一子项 true  → false;否则 true    (= NOR)
 *   not     : 取反(单个子项)
 * @returns true / false —— 未命中一律 false,分支按此显隐。
 */
export function evalTrigger(node: TrigNode | boolean | undefined | null, scope: ConditionScope): boolean {
  if (node == null) return false
  if (typeof node === 'boolean') return node
  switch (node.type) {
    case 'bool':
      return node.value
    case 'leaf':
      return scope.has(node.nodeContent)
    case 'not': {
      const inner = node.items[0]
      return !evalTrigger(inner, scope)
    }
    case 'count': {
      let hit = 0
      for (const it of node.items) if (evalTrigger(it, scope)) hit++
      return hit >= node.amount
    }
    case 'and': {
      for (const it of node.items) if (!evalTrigger(it, scope)) return false
      return true
    }
    case 'or': {
      for (const it of node.items) if (evalTrigger(it, scope)) return true
      return false
    }
    case 'andnot': {
      for (const it of node.items) if (!evalTrigger(it, scope)) return true
      return false
    }
    case 'ornot': {
      for (const it of node.items) if (evalTrigger(it, scope)) return false
      return true
    }
  }
}

/** 逻辑/不可开关键 —— 不进条件面板,也不作为可判定叶子 */
const NON_SWITCHABLE = new Set(['if', 'limit', 'else_if', 'else', 'custom_trigger_tooltip', 'hidden_trigger'])

/** 条件面板的一项 */
export interface ConditionLeaf {
  nodeContent: string
  key: string
  count: number
}

/** 收集树上所有【唯一】条件叶子(nodeContent 去重),附出现次数。对齐 MU 的 U()。 */
export function collectConditions(node: TrigNode | boolean | undefined | null, out: Map<string, ConditionLeaf> = new Map()): Map<string, ConditionLeaf> {
  if (node == null || typeof node === 'boolean') return out
  if (node.type === 'leaf') {
    const k = node.key.toLowerCase().trim()
    if (!NON_SWITCHABLE.has(k)) {
      const nc = node.nodeContent
      const cur = out.get(nc)
      if (cur) cur.count++
      else out.set(nc, { nodeContent: nc, key: node.key, count: 1 })
    }
    return out
  }
  if (node.type === 'bool') return out // bool 无 items
  for (const it of node.items) collectConditions(it, out)
  return out
}

/** 把表达式树转成可读单行(检查器「显示详情」用) */
export function formatTrigger(node: TrigNode | boolean | undefined | null): string {
  if (node == null) return ''
  if (typeof node === 'boolean') return String(node)
  switch (node.type) {
    case 'leaf':
      return node.nodeContent || node.raw
    case 'bool':
      return node.value ? 'always = yes' : 'always = no'
    case 'not':
      return 'NOT ' + node.items.map(formatTrigger).filter(Boolean).join(' ')
    case 'and':
      return node.items.map(formatTrigger).filter(Boolean).join(' AND ')
    case 'or':
      return node.items.map(formatTrigger).filter(Boolean).join(' OR ')
    case 'andnot':
      return 'ANDNOT ' + node.items.map(formatTrigger).filter(Boolean).join(' ')
    case 'ornot':
      return 'ORNOT ' + node.items.map(formatTrigger).filter(Boolean).join(' ')
    case 'count':
      return `AT_LEAST(${node.amount} of ${node.items.length}) ` + node.items.map(formatTrigger).filter(Boolean).join(' / ')
  }
}