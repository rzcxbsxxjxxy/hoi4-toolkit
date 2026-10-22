import type { Block, Document, Entry } from './ast.ts'

/**
 * 序列化:按 token 流顺序拼接原文。
 * 只要 token.text 未被修改,输出必然与输入逐字节一致。
 */
export function serialize(doc: Document): string {
  let out = ''
  for (const t of doc.tokens) out += t.text
  return out
}

/** 取 key 文本(不含引号)。无 key 返回 undefined */
export function keyText(doc: Document, e: Entry): string | undefined {
  if (e.key < 0) return undefined
  return unquote(doc.tokens[e.key].text)
}

/** 取简单值文本(不含引号)。块值或无值返回 undefined */
export function valueText(doc: Document, e: Entry): string | undefined {
  if (e.value < 0) return undefined
  return unquote(doc.tokens[e.value].text)
}

export function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1)
  return s
}

export function operator(doc: Document, e: Entry): string | undefined {
  if (e.op < 0) return undefined
  return doc.tokens[e.op].text
}

export function lineOf(doc: Document, e: Entry): number {
  const idx = e.key >= 0 ? e.key : e.value >= 0 ? e.value : e.start
  return idx >= 0 ? doc.tokens[idx].line : 1
}

/** 深度优先遍历所有 entry */
export function walk(doc: Document, visit: (e: Entry, path: string[], block: Block) => void): void {
  const rec = (block: Block, path: string[]) => {
    for (const e of block.entries) {
      const k = keyText(doc, e)
      visit(e, k ? [...path, k] : path, block)
      if (e.block) rec(e.block, k ? [...path, k] : path)
    }
  }
  rec(doc.root, [])
}

/** 遍历所有块 */
export function walkBlocks(doc: Document, visit: (b: Block, path: string[]) => void): void {
  const rec = (block: Block, path: string[]) => {
    visit(block, path)
    for (const e of block.entries) {
      if (!e.block) continue
      const k = keyText(doc, e)
      rec(e.block, k ? [...path, k] : path)
    }
  }
  rec(doc.root, [])
}

/** 按路径查找,如 ['ideas','GER','my_idea'] */
export function findPath(doc: Document, path: string[]): Entry | undefined {
  let block = doc.root
  let found: Entry | undefined
  for (const seg of path) {
    found = block.entries.find((e) => keyText(doc, e) === seg)
    if (!found) return undefined
    if (!found.block) return found
    block = found.block
  }
  return found
}

/** 收集所有裸值(列表元素) */
export function bareValues(doc: Document, e: Entry): string[] {
  if (!e.block) return []
  const out: string[] = []
  for (const c of e.block.entries) {
    if (c.key < 0 && c.value >= 0) {
      const v = valueText(doc, c)
      if (v !== undefined) out.push(v)
    }
  }
  return out
}
