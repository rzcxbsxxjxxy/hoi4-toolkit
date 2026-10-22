/**
 * 无损 tokenizer。
 *
 * 唯一硬性契约:所有 token 的 text 按序拼接,必须逐字节等于原文。
 * 这是 round-trip 无损的基础,任何改动都不能破坏它。
 */

export type TokenType = 'ws' | 'comment' | 'string' | 'word' | 'punct'

export interface Token {
  type: TokenType
  text: string
  /** 在原文中的字符偏移 */
  offset: number
  line: number
  col: number
}

const WS_CHARS = new Set([' ', '\t', '\r', '\n', '\uFEFF', '\f', '\v'])

function isWs(c: string): boolean {
  return WS_CHARS.has(c)
}

/** 会终结一个 word 的字符 */
function isWordBreak(c: string): boolean {
  if (isWs(c)) return true
  return c === '#' || c === '"' || c === '{' || c === '}' || c === '=' || c === '<' || c === '>' || c === '!'
}

/** 运算符:单字符或双字符 */
const OPS = new Set(['=', '==', '!=', '<>', '>', '<', '>=', '<='])

export function isOp(text: string): boolean {
  return OPS.has(text)
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  const n = src.length
  let i = 0
  let line = 1
  let col = 1

  const push = (type: TokenType, start: number, end: number) => {
    tokens.push({ type, text: src.slice(start, end), offset: start, line, col })
    for (let k = start; k < end; k++) {
      if (src[k] === '\n') {
        line++
        col = 1
      } else {
        col++
      }
    }
  }

  while (i < n) {
    const c = src[i]

    if (isWs(c)) {
      let j = i
      while (j < n && isWs(src[j])) j++
      push('ws', i, j)
      i = j
      continue
    }

    // 注释:# 直到行尾(CRLF 与 LF 都算结束)
    if (c === '#') {
      let j = i
      while (j < n && src[j] !== '\n' && src[j] !== '\r') j++
      push('comment', i, j)
      i = j
      continue
    }

    // 字符串:支持 \" 转义,容忍跨行
    if (c === '"') {
      let j = i + 1
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') j++
        j++
      }
      if (j < n) j++ // 吃掉闭合引号
      push('string', i, Math.min(j, n))
      i = Math.min(j, n)
      continue
    }

    if (c === '{' || c === '}') {
      push('punct', i, i + 1)
      i++
      continue
    }

    if (c === '=' || c === '<' || c === '>' || c === '!') {
      const two = src.slice(i, i + 2)
      if (two === '==' || two === '!=' || two === '<>' || two === '>=' || two === '<=') {
        push('punct', i, i + 2)
        i += 2
        continue
      }
      push('punct', i, i + 1)
      i++
      continue
    }

    let j = i
    while (j < n && !isWordBreak(src[j])) j++
    if (j === i) j = i + 1 // 兜底,保证永远前进
    push('word', i, j)
    i = j
  }

  return tokens
}
