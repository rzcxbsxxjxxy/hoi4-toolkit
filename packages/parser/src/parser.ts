import { isOp, tokenize, type Token } from './tokenizer.ts'
import type { Block, Document, Entry } from './ast.ts'

/**
 * Clausewitz 脚本解析器。
 *
 * 设计原则:
 * 1. 永不崩溃——任何意外语法都记录到 errors 并尽量跳过。
 * 2. 不持有文本副本——AST 只存 token 下标,序列化靠 token 流拼接,因此无损。
 */

function skipTrivia(tokens: Token[], i: number, to: number): number {
  while (i < to && (tokens[i].type === 'ws' || tokens[i].type === 'comment')) i++
  return i
}

interface EntryResult {
  entry: Omit<Entry, 'start' | 'end'>
  next: number
}

function parseBlock(tokens: Token[], i: number, to: number, errors: string[]): { block: Block; next: number } {
  const open = i // 指向 '{'
  i++
  const entries: Entry[] = []
  let close = -1

  while (i < to) {
    const k = skipTrivia(tokens, i, to)
    if (k >= to) break
    if (tokens[k].type === 'punct' && tokens[k].text === '}') {
      close = k
      i = k + 1
      break
    }
    const start = i // 含前导 trivia
    const r = parseEntry(tokens, k, to, errors)
    if (!r) {
      i = k + 1
      continue
    }
    entries.push({ ...r.entry, start, end: r.next })
    i = r.next
  }

  backfillEnds(entries, close >= 0 ? close : to)
  return { block: { open, close, entries }, next: close >= 0 ? close + 1 : to }
}

/** 尾部 trivia 归入前一个 entry,保证区间完整覆盖且不重叠 */
function backfillEnds(entries: Entry[], fallbackEnd: number): void {
  for (let m = 0; m < entries.length; m++) {
    entries[m].end = m + 1 < entries.length ? entries[m + 1].start : fallbackEnd
  }
}

function parseEntry(tokens: Token[], k: number, to: number, errors: string[]): EntryResult | null {
  const t = tokens[k]

  if (t.type === 'word' || t.type === 'string') {
    const j = skipTrivia(tokens, k + 1, to)

    if (j < to && tokens[j].type === 'punct' && isOp(tokens[j].text)) {
      const op = j
      const v = skipTrivia(tokens, j + 1, to)

      if (v < to) {
        if (tokens[v].type === 'punct' && tokens[v].text === '{') {
          const r = parseBlock(tokens, v, to, errors)
          return { entry: { key: k, op, value: -1, block: r.block }, next: r.next }
        }
        if (tokens[v].type === 'word' || tokens[v].type === 'string') {
          return { entry: { key: k, op, value: v, block: undefined }, next: v + 1 }
        }
        // key = } / key = = 之类异常
        errors.push(`第 ${t.line} 行:运算符后出现异常 token "${tokens[v].text}"`)
        return { entry: { key: k, op, value: -1 }, next: j + 1 }
      }

      return { entry: { key: k, op, value: -1 }, next: j + 1 }
    }

    // 无运算符:裸值(列表元素,如 traits = { a b c })
    return { entry: { key: -1, op: -1, value: k }, next: k + 1 }
  }

  if (t.type === 'punct' && t.text === '{') {
    const r = parseBlock(tokens, k, to, errors)
    return { entry: { key: -1, op: -1, value: -1, block: r.block }, next: r.next }
  }

  errors.push(`第 ${t.line} 行:无法识别的 token "${t.text}"`)
  return null
}

export function parse(source: string): Document {
  const tokens = tokenize(source)
  const errors: string[] = []
  const root: Block = { open: -1, close: -1, entries: [] }

  let i = 0
  const to = tokens.length
  while (i < to) {
    const k = skipTrivia(tokens, i, to)
    if (k >= to) break
    const start = i
    const r = parseEntry(tokens, k, to, errors)
    if (!r) {
      i = k + 1
      continue
    }
    root.entries.push({ ...r.entry, start, end: r.next })
    i = r.next
  }
  backfillEnds(root.entries, to)

  return { source, tokens, root, errors }
}
