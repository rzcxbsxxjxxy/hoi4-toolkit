/* ══════════════════════════════════════════════════════════════════
 * trigger-parse.ts —— 条件块 AST → TrigNode 表达式树
 *
 * ★ 忠实移植 HOI4 Mod Utilities 0.18.1 的解析器(dist/web-extension.js):
 *   D(e,t,n,r,i)   —— 递归构建:遍历 block entries,按 key 分类
 *                     and/hidden_trigger→and; or→or; not→ornot;
 *                     if/else_if/else→$ B j 展开成 or-of-andnot 链;
 *                     count_triggers→count; always→布尔; M()→嵌套作用域递归;
 *                     其余→leaf {scopeName, nodeContent:b(e)}
 *   b(e)/x(e)      —— nodeContent 序列化:[key, op, x(value)].join(' ')
 *                     (字符串值保留引号,块值 "{ e1 e2 }" 单空格)
 *   M(e,stack)     —— 嵌套作用域判定( tag/角色/mio/sp/省份/this/root/prev/from/
 *                     作用域化触发键 )
 *   U(e)           —— 布尔化简(恒真/恒假/单子折叠/andnot·ornot 重写)
 *   L/N            —— 单块 / 列表构建入口
 *
 * 与旧版的差异:旧版把 IF/limit/else_if/else 保留为不可开关键(opaque leaf),
 *   求值一律 false —— 导致"过时分支"(has_game_rule HIDE)显隐与 MU 不同。
 *   本版按 MU 展开,效果与 MU 一致。
 * ══════════════════════════════════════════════════════════════════ */
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import type { TrigNode } from './trigger.ts'

interface Scope {
  scopeName: string
  scopeType: string
}
const BASE_SCOPE: Scope = { scopeName: '', scopeType: 'country' }

/* ── b()/x():nodeContent 序列化(MU 同款)──────────────────
 *   leaf nodeContent = [key, op, x(value)].join(' ')
 *   x(value): 块 → "{ " + entries.map(b).join(' ') + " }";
 *             简单值 → 原始 token 文本(字符串值保留引号,标识符/数字不带) */
function rawTokens(doc: Document, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s += doc.tokens[i].text
  return s
}
function b(doc: Document, e: Entry): string {
  const parts: string[] = []
  if (e.key >= 0) parts.push(doc.tokens[e.key].text)
  if (e.op >= 0) parts.push(doc.tokens[e.op].text)
  if (e.block) {
    const inner = e.block.entries.map((c) => b(doc, c)).join(' ')
    parts.push(inner ? '{ ' + inner + ' }' : '{}')
  } else if (e.value >= 0) {
    parts.push(doc.tokens[e.value].text)
  }
  return parts.join(' ')
}

/* ── M(e,stack):嵌套作用域判定(MU 同款)────────────────── */
/** 常见作用域化触发键 → {from, to}。整理自 MU web-extension.js 的 F 注册表。 */
const SCOPE_TRIGGERS: Record<string, { from: string; to: string }> = {
  any_country: { from: '*', to: 'country' }, all_country: { from: '*', to: 'country' },
  any_possible_country: { from: '*', to: 'country' }, all_possible_country: { from: '*', to: 'country' },
  every_country: { from: '*', to: 'country' }, random_country: { from: '*', to: 'country' },
  any_country_with_original_tag: { from: '*', to: 'country' }, all_country_with_original_tag: { from: '*', to: 'country' },
  every_country_with_original_tag: { from: '*', to: 'country' }, random_country_with_original_tag: { from: '*', to: 'country' },
  any_allied_country: { from: 'country', to: 'country' }, all_allied_country: { from: 'country', to: 'country' },
  every_allied_country: { from: 'country', to: 'country' }, random_allied_country: { from: 'country', to: 'country' },
  any_enemy_country: { from: 'country', to: 'country' }, all_enemy_country: { from: 'country', to: 'country' },
  every_enemy_country: { from: 'country', to: 'country' }, random_enemy_country: { from: 'country', to: 'country' },
  any_other_country: { from: 'country', to: 'country' }, all_other_country: { from: 'country', to: 'country' },
  every_other_country: { from: 'country', to: 'country' }, random_other_country: { from: 'country', to: 'country' },
  any_neighbor_country: { from: 'country', to: 'country' }, all_neighbor_country: { from: 'country', to: 'country' },
  every_neighbor_country: { from: 'country', to: 'country' }, random_neighbor_country: { from: 'country', to: 'country' },
  any_guaranteed_country: { from: 'country', to: 'country' }, all_guaranteed_country: { from: 'country', to: 'country' },
  any_occupied_country: { from: 'country', to: 'country' }, all_occupied_country: { from: 'country', to: 'country' },
  any_subject_country: { from: 'country', to: 'country' }, all_subject_country: { from: 'country', to: 'country' },
  every_subject_country: { from: 'country', to: 'country' }, random_subject_country: { from: 'country', to: 'country' },
  any_country_of: { from: '*', to: 'country' }, all_country_of: { from: '*', to: 'country' },
  any_state: { from: '*', to: 'state' }, all_state: { from: '*', to: 'state' },
  every_state: { from: '*', to: 'state' }, random_state: { from: '*', to: 'state' },
  any_state_in: { from: '*', to: 'state' }, all_state_in: { from: '*', to: 'state' },
  any_owned_state: { from: 'country', to: 'state' }, all_owned_state: { from: 'country', to: 'state' },
  every_owned_state: { from: 'country', to: 'state' }, random_owned_state: { from: 'country', to: 'state' },
  any_controlled_state: { from: 'country', to: 'state' }, all_controlled_state: { from: 'country', to: 'state' },
  every_controlled_state: { from: 'country', to: 'state' }, random_controlled_state: { from: 'country', to: 'state' },
  any_neighbor_state: { from: 'state', to: 'state' }, all_neighbor_state: { from: 'state', to: 'state' },
  any_core_state: { from: 'country', to: 'state' }, all_core_state: { from: 'country', to: 'state' },
  every_core_state: { from: 'country', to: 'state' }, random_core_state: { from: 'country', to: 'state' },
  owner: { from: 'state', to: 'country' }, controller: { from: 'state', to: 'country' },
  capital_scope: { from: 'country', to: 'state' }, overlord: { from: 'country', to: 'country' },
  faction_leader: { from: 'country', to: 'country' }, any_state_of: { from: '*', to: 'state' },
  any_character: { from: 'country', to: 'character' }, all_character: { from: 'country', to: 'character' },
  every_character: { from: 'country', to: 'character' }, random_character: { from: 'country', to: 'character' },
}

function scopePush(doc: Document, e: Entry, stack: Scope[]): boolean {
  if (e.key < 0 || !e.block) return false
  let a = doc.tokens[e.key].text.trim()
  if (/^[A-Z][A-Z0-9]{2}$/.test(a)) { stack.push({ scopeName: a, scopeType: 'country' }); return true }
  if (/^[A-Z][A-Z0-9]{2}_/.test(a)) { stack.push({ scopeName: a, scopeType: 'character' }); return true }
  if (/^mio:/.test(a)) { stack.push({ scopeName: a.slice(4), scopeType: 'mio' }); return true }
  if (/^sp:/.test(a)) { stack.push({ scopeName: a.slice(3), scopeType: 'specialProject' }); return true }
  if (/^[0-9]+$/.test(a)) { stack.push({ scopeName: a, scopeType: 'state' }); return true }
  const s = a
  a = a.toLowerCase()
  const l = stack[stack.length - 1]
  if (a === 'this') { stack.push(l); return true }
  if (a === 'root') { stack.push(stack[0]); return true }
  if (/^prev(?:\.prev)*$/.test(a)) {
    const depth = a.split('.').length
    stack.push(stack[Math.max(0, stack.length - 1 - depth)] || l)
    return true
  }
  if (a === 'from' && l?.scopeType === 'mio') { stack.push({ scopeName: s, scopeType: 'country' }); return true }
  if (/^from(?:\.from)*$/.test(a)) { stack.push({ scopeName: s, scopeType: 'unknown' }); return true }
  // var: / global_event_target: / event_target:
  const v = /^(var|global_event_target|event_target):(.*)$/i.exec(a)
  if (v) {
    const sc = v[2].toLowerCase()
    const globalish = v[1] === 'global_event_target' || /^(?:[a-z][a-z0-9]{2}|\d+)(?:$|\.)/.test(sc) || sc.startsWith('global')
    stack.push({ scopeName: globalish ? '{' + a + '}' : (l?.scopeName ?? '') + '.{' + a + '}', scopeType: 'unknown' })
    return true
  }
  const u = SCOPE_TRIGGERS[a]
  if (u) {
    if (u.from === '*') { stack.push({ scopeName: u.to === 'country' ? '' : u.to, scopeType: u.to }); return true }
    if (u.from === l?.scopeType || l?.scopeType === 'unknown') {
      stack.push({ scopeName: l?.scopeName ? l.scopeName + '.' + u.to : u.to, scopeType: u.to })
      return true
    }
  }
  return false
}

/* ── D(e, stack, type, excluded, amount):递归构建 ── */
function D(doc: Document, entries: Entry[], stack: Scope[], type: string = 'and', excluded: string[] = [], amount = 0): TrigNode {
  if (!Array.isArray(entries)) return type === 'count' ? { type: 'count', amount, items: [] } : { type, items: [] }
  const a: TrigNode[] = []
  const s = stack[stack.length - 1] ?? BASE_SCOPE
  let l: TrigNode | null = null // 待冲刷的 IF 链(or 节点)
  let midChain = false // 正处于 else_if 链中(e 标志)
  let hasElse = false // c 标志:已见 else
  for (const e of entries) {
    const i = e.key >= 0 ? doc.tokens[e.key].text.toLowerCase().trim() : ''
    if (excluded.includes(i)) continue
    if (i === 'and' || i === 'hidden_trigger') {
      a.push(D(doc, e.block?.entries ?? [], stack))
    } else if (i === 'custom_trigger_tooltip') {
      a.push(D(doc, e.block?.entries ?? [], stack, 'and', ['tooltip']))
    } else if (i === 'or') {
      a.push(D(doc, e.block?.entries ?? [], stack, 'or'))
    } else if (i === 'not') {
      /* MU:not 编译进 ornot */
      a.push(D(doc, e.block?.entries ?? [], stack, 'ornot'))
    } else if (i === 'if') {
      if (e.block) {
        const lim = e.block.entries.find((x) => (x.key >= 0 ? doc.tokens[x.key].text.toLowerCase().trim() : '') === 'limit')
        if (lim) {
          l = openIf(doc, lim, stack)
          midChain = true
          hasElse = false
          const elseIfs = e.block.entries.filter((x) => (x.key >= 0 ? doc.tokens[x.key].text.toLowerCase().trim() : '') === 'else_if')
          for (const x of elseIfs) { addElseIf(doc, x, l, stack); midChain = false }
          const els = e.block.entries.find((x) => (x.key >= 0 ? doc.tokens[x.key].text.toLowerCase().trim() : '') === 'else')
          if (els) { addElse(doc, els, l, stack); midChain = false; hasElse = true }
        }
      }
    } else if (i === 'else_if') {
      if (l) { addElseIf(doc, e, l, stack); midChain = true }
    } else if (i === 'else') {
      if (l) { addElse(doc, e, l, stack); midChain = false; hasElse = true }
    } else if (i === 'always') {
      const v = (valueText(doc, e) ?? '').trim().toLowerCase()
      a.push(v === 'yes' || v === '')
    } else if (i === 'count_triggers') {
      if (e.block) {
        const amt = e.block.entries.find((x) => (x.key >= 0 ? doc.tokens[x.key].text.toLowerCase().trim() : '') === 'amount')
        const n = amt && amt.value >= 0 ? parseInt(doc.tokens[amt.value].text, 10) : 0
        a.push(D(doc, e.block.entries, stack, 'count', ['amount'], Number.isFinite(n) ? n : 0))
      }
    } else {
      /* 叶子或嵌套作用域 */
      if (scopePush(doc, e, stack)) {
        a.push(D(doc, e.block?.entries ?? [], stack))
        stack.pop()
      } else {
        a.push({ type: 'leaf', key: e.key >= 0 ? doc.tokens[e.key].text : '', value: b(doc, e), nodeContent: b(doc, e), raw: rawTokens(doc, e.start, e.end).trim() })
      }
    }
    /* 冲刷 IF 链:若不在 else_if 链中,把攒好的 l(or 链)收进 a。
       MU:若该链没有 else,用 j(null) 关尾(把末支改成 andnot 表示"都不满足")。 */
    if (!midChain && l) {
      if (!hasElse) addElse(doc, null, l, stack)
      a.push(l)
      l = null
    }
  }
  if (l) a.push(l)
  return type === 'count' ? { type: 'count', amount, items: a } : { type, items: a }
}

/* ── IF/else_if/else 展开(MU 的 $ / B / j)────────────────── */
function openIf(doc: Document, lim: Entry, stack: Scope[]): TrigNode {
  return { type: 'or', items: [{ type: 'and', items: [D(doc, [], stack), D(doc, lim.block?.entries ?? [], stack, 'and', ['limit', 'else_if', 'else'])] }] }
}
function addElseIf(doc: Document, e: Entry, node: TrigNode, stack: Scope[]): void {
  if (!e.block) return
  const lim = e.block.entries.find((x) => (x.key >= 0 ? doc.tokens[x.key].text.toLowerCase().trim() : '') === 'limit')
  if (!lim) return
  const or = node as { items: { type: string; items: TrigNode[] }[] }
  const last = or.items[or.items.length - 1]
  const its = last.items
  const o = [
    ...its.slice(0, its.length - 2),
    { ...(its[its.length - 2] as any), type: 'andnot' },
    D(doc, lim.block?.entries ?? [], stack, 'and'),
    D(doc, e.block.entries, stack, 'and', ['limit', 'else_if', 'else']),
  ]
  or.items.push({ type: 'and', items: o })
}
function addElse(doc: Document, e: Entry | null, node: TrigNode, stack: Scope[]): void {
  if (e !== null && !e.block) return
  const or = node as { items: { type: string; items: TrigNode[] }[] }
  const last = or.items[or.items.length - 1]
  const its = last.items
  const i = [
    ...its.slice(0, its.length - 2),
    { ...(its[its.length - 2] as any), type: 'andnot' },
  ]
  if (e !== null) i.push(D(doc, e.block!.entries, stack, 'and', ['limit', 'else_if', 'else']))
  or.items.push({ type: 'and', items: i })
}

/* ── U(e):布尔化简(MU 同款)────────────────────────── */
export function simplify(node: TrigNode): TrigNode {
  if (typeof node === 'boolean' || !('items' in node)) return node
  const items: TrigNode[] = []
  let n = node.type === 'count' ? node.amount : 0
  for (const r of node.items) {
    const i = simplify(r)
    if (typeof i === 'boolean') {
      if (i) {
        if (node.type === 'or') return true
        if (node.type === 'ornot') return false
        if (node.type === 'count') n--
      } else {
        if (node.type === 'and') return false
        if (node.type === 'andnot') return true
      }
    } else items.push(i)
  }
  if (items.length === 0) return node.type === 'and' || node.type === 'ornot'
  if (node.type === 'count') {
    if (n <= 0) return true
    if (n > items.length) return false
    if (n === items.length) return simplify({ type: 'and', items })
  }
  if (items.length === 1) {
    if (node.type === 'and' || node.type === 'or') return simplify(items[0])
    if (node.type === 'andnot') return simplify({ type: 'ornot', items })
    if (node.type === 'ornot') {
      const e = items[0]
      if (typeof e === 'object' && e !== null && 'items' in e && (e.type === 'andnot' || e.type === 'ornot')) {
        return simplify({ type: e.type === 'andnot' ? 'and' : 'or', items: e.items })
      }
    }
  }
  return node.type === 'count' ? { type: 'count', amount: n, items } : { type: node.type, items }
}

/* ── 入口 ─────────────────────────────────────── */
/** 解析一个条件块 → 化简后的条件树(等价 MU 的 L/N:U(D(block))) */
export function parseTriggerBlock(doc: Document, b: Block): TrigNode {
  return simplify(D(doc, b.entries, [BASE_SCOPE]))
}

/** 抽取 focus 块里所有名为 blockKey 的条件块(逐个解析,allow_branch 可多条) */
export function parseTriggerBlocks(doc: Document, focus: Block, blockKey: string): TrigNode[] {
  const out: TrigNode[] = []
  for (const e of focus.entries) {
    if ((e.key >= 0 ? doc.tokens[e.key].text.toLowerCase().trim() : '') !== blockKey) continue
    if (e.block) out.push(parseTriggerBlock(doc, e.block))
  }
  return out
}

/* offset 列表(每个 offset 带自己的 trigger) */
export interface OffsetRule {
  x: number
  y: number
  trigger: TrigNode | null
  raw: string
}
export function parseOffsets(doc: Document, focus: Block): OffsetRule[] {
  const out: OffsetRule[] = []
  for (const e of focus.entries) {
    if ((e.key >= 0 ? doc.tokens[e.key].text.toLowerCase().trim() : '') !== 'offset') continue
    const b = e.block
    if (!b) {
      const v = valueText(doc, e)
      const n = parseFloat(v ?? '')
      if (Number.isFinite(n)) out.push({ x: n, y: 0, trigger: null, raw: rawTokens(doc, e.start, e.end).trim() })
      continue
    }
    let x = 0
    let y = 0
    let trig: TrigNode | null = null
    for (const it of b.entries) {
      const k = it.key >= 0 ? doc.tokens[it.key].text.toLowerCase().trim() : ''
      if (k === 'x') x = parseFloat(valueText(doc, it) ?? '') || 0
      else if (k === 'y') y = parseFloat(valueText(doc, it) ?? '') || 0
      else if (k === 'trigger') {
        if (it.block) trig = parseTriggerBlock(doc, it.block)
        else {
          const v = (valueText(doc, it) ?? '').trim().toLowerCase()
          trig = v === 'yes' || v === ''
        }
      }
    }
    out.push({ x, y, trigger: trig, raw: rawTokens(doc, e.start, e.end).trim() })
  }
  return out
}