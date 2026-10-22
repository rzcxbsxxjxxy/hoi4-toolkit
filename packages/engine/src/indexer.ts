import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import { tokenize } from '../../parser/src/tokenizer.ts'
import { keyText, lineOf, valueText } from '../../parser/src/serialize.ts'

export interface Definition {
  kind: string
  id: string
  file: string
  line: number
  /** 上层作用域,如国家 TAG、科技树名 */
  scope?: string
}

export interface FileStat {
  file: string
  bytes: number
  lines: number
  entries: number
  blocks: number
  maxDepth: number
  /** 括号诊断 */
  bracket: 'ok' | 'unclosed' | 'extra-close'
  issue: BracketIssue
  errors: string[]
}

export interface IndexResult {
  files: FileStat[]
  definitions: Definition[]
  /** kind:id -> 所有定义位置 */
  duplicates: Map<string, Definition[]>
  /** 出现频率最高的 key */
  keyFreq: Map<string, number>
}

export interface DefRule {
  kind: string
  dir: RegExp
  /** 命中但需排除的路径,优先级高于 dir */
  exclude?: RegExp
  extract: (doc: Document, file: string) => Definition[]
}

/** 根级中指定 key 的所有块 */
function docRootBlocks(doc: Document, keys: string[]): Block[] {
  return doc.root.entries.filter((e) => e.block && keys.includes(keyText(doc, e) ?? '')).map((e) => e.block!) as Block[]
}

/** 取某 key 下的子块 */
function childBlock(doc: Document, block: Block, key: string): Block | undefined {
  const e = block.entries.find((x) => keyText(doc, x) === key)
  return e?.block
}

/** 在块内找 key 的简单值 */
function childValue(doc: Document, block: Block, key: string): string | undefined {
  const e = block.entries.find((x) => keyText(doc, x) === key)
  return e ? valueText(doc, e) : undefined
}

/**
 * 按「根键 → 若干层」提取定义。
 * rootKeys 为 '*' 时表示文件根级。
 * depth=1:根键下第一层为 id;depth=2:第二层为 id,第一层记作 scope(类别/分组)。
 */
function nestedDefs(
  doc: Document,
  file: string,
  kind: string,
  rootKeys: string[] | '*',
  depth: 1 | 2,
): Definition[] {
  const roots: Block[] =
    rootKeys === '*'
      ? [doc.root]
      : (doc.root.entries.filter((e) => e.block && rootKeys.includes(keyText(doc, e) ?? '')).map((e) => e.block!) as Block[])

  const out: Definition[] = []
  for (const r of roots) {
    for (const e1 of r.entries) {
      const id1 = keyText(doc, e1)
      if (!id1 || !e1.block) continue
      if (depth === 1) {
        out.push({ kind, id: id1, file, line: lineOf(doc, e1) })
      } else {
        for (const e2 of e1.block.entries) {
          const id2 = keyText(doc, e2)
          if (!id2 || !e2.block) continue
          out.push({ kind, id: id2, file, line: lineOf(doc, e2), scope: id1 })
        }
      }
    }
  }
  return out
}

export const DEF_RULES: DefRule[] = [
  // ideas = { <类别> = { <idea_id> = {...} } }
  { kind: 'idea', dir: /common[\\/]ideas/i, extract: (d, f) => nestedDefs(d, f, 'idea', ['ideas'], 2) },
  // characters = { <角色token> = {...} } —— 注意没有 TAG 中间层
  { kind: 'character', dir: /common[\\/]characters/i, extract: (d, f) => nestedDefs(d, f, 'character', ['characters'], 1) },
  { kind: 'sub_unit', dir: /common[\\/]units/i, extract: (d, f) => nestedDefs(d, f, 'sub_unit', ['sub_units'], 1) },
  { kind: 'equipment', dir: /common[\\/]units/i, extract: (d, f) => nestedDefs(d, f, 'equipment', ['equipments'], 1) },
  { kind: 'building', dir: /common[\\/]buildings/i, extract: (d, f) => nestedDefs(d, f, 'building', ['buildings'], 1) },
  // decisions/<分类文件>.txt:根级是分类,分类下是 decision。categories/ 是分类定义,排除
  {
    kind: 'decision',
    dir: /common[\\/]decisions/i,
    exclude: /[\\/]categories[\\/]/i,
    extract: (d, f) => nestedDefs(d, f, 'decision', '*', 2),
  },
  { kind: 'technology', dir: /common[\\/]technologies/i, extract: (d, f) => nestedDefs(d, f, 'technology', ['technologies'], 2) },
  { kind: 'scripted_effect', dir: /common[\\/]scripted_effects/i, extract: (d, f) => nestedDefs(d, f, 'scripted_effect', '*', 1) },
  { kind: 'scripted_trigger', dir: /common[\\/]scripted_triggers/i, extract: (d, f) => nestedDefs(d, f, 'scripted_trigger', '*', 1) },
  {
    // defined_text = { name = <键名>  text = {...} text = {...} }
    // 键名在 name 里,text 是候选文本块,不能当定义
    kind: 'scripted_loc',
    dir: /common[\\/]scripted_localisation/i,
    extract: (d, f) => {
      const out: Definition[] = []
      for (const e of docRootBlocks(d, ['defined_text'])) {
        const name = childValue(d, e, 'name')
        if (name) out.push({ kind: 'scripted_loc', id: name, file: f, line: lineOf(d, e) })
      }
      return out
    },
  },
  { kind: 'on_action', dir: /common[\\/]on_actions/i, extract: (d, f) => nestedDefs(d, f, 'on_action', ['on_actions'], 1) },
  { kind: 'dynamic_modifier', dir: /common[\\/]dynamic_modifiers/i, extract: (d, f) => nestedDefs(d, f, 'dynamic_modifier', '*', 1) },
  { kind: 'country_tag', dir: /common[\\/]country_tags/i, extract: (d, f) => nestedDefs(d, f, 'country_tag', '*', 1) },
  { kind: 'mio_organization', dir: /common[\\/]military_industrial_organization/i, extract: (d, f) => nestedDefs(d, f, 'mio_organization', '*', 1) },
  {
    kind: 'focus',
    dir: /common[\\/]national_focus/i,
    extract: (d, f) => {
      const out: Definition[] = []
      const rec = (b: Block, tree: string | undefined) => {
        for (const e of b.entries) {
          const k = keyText(d, e)
          if (!k || !e.block) continue
          if (k === 'focus_tree') {
            rec(e.block, childValue(d, e.block, 'id') ?? undefined)
          } else if (k === 'focus' || k === 'shared_focus' || k === 'joint_focus' || k === 'continuous_focus') {
            const id = childValue(d, e.block, 'id')
            if (id) out.push({ kind: 'focus', id, file: f, line: lineOf(d, e), scope: tree })
          }
        }
      }
      rec(d.root, undefined)
      return out
    },
  },
]

export interface BracketIssue {
  /** 未闭合的 '{' 所在行 */
  unclosedAt: number[]
  /** 多出的 '}' 所在行 */
  extraCloseAt: number[]
}

/** 括号平衡与深度统计,并定位具体行号 */
export function analyzeStructure(doc: Document): {
  maxDepth: number
  bracket: FileStat['bracket']
  issue: BracketIssue
} {
  const unclosedAt: number[] = []
  const extraCloseAt: number[] = []
  const stack: number[] = []
  let maxDepth = 0
  for (const t of doc.tokens) {
    if (t.type !== 'punct') continue
    if (t.text === '{') {
      stack.push(t.line)
      if (stack.length > maxDepth) maxDepth = stack.length
    } else if (t.text === '}') {
      if (stack.length) stack.pop()
      else extraCloseAt.push(t.line)
    }
  }
  unclosedAt.push(...stack)
  const bracket: FileStat['bracket'] = extraCloseAt.length ? 'extra-close' : unclosedAt.length ? 'unclosed' : 'ok'
  return { maxDepth, bracket, issue: { unclosedAt, extraCloseAt } }
}

export function countEntries(doc: Document): { entries: number; blocks: number } {
  let entries = 0
  let blocks = 0
  const rec = (b: Block) => {
    for (const e of b.entries) {
      entries++
      if (e.block) {
        blocks++
        rec(e.block)
      }
    }
  }
  rec(doc.root)
  return { entries, blocks }
}

export function collectKeyFreq(doc: Document, into: Map<string, number>): void {
  const rec = (b: Block) => {
    for (const e of b.entries) {
      const k = keyText(doc, e)
      if (k) into.set(k, (into.get(k) ?? 0) + 1)
      if (e.block) rec(e.block)
    }
  }
  rec(doc.root)
}
