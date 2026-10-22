import type { Token } from './tokenizer.ts'

/** 块。open/close 为 token 下标,-1 表示根块(无花括号) */
export interface Block {
  open: number
  close: number
  entries: Entry[]
}

export interface Entry {
  /** key 的 token 下标,-1 表示裸值(无 key) */
  key: number
  /** 运算符 token 下标,-1 表示无 */
  op: number
  /** 简单值的 token 下标,-1 表示无值或值为块 */
  value: number
  /** 值为块时的块结构 */
  block?: Block
  /** 本 entry 覆盖的 token 区间 [start, end),含前导与尾随的空白/注释 */
  start: number
  end: number
}

export interface Document {
  source: string
  tokens: Token[]
  root: Block
  /** 解析过程中的异常,不代表失败——parser 必须永不崩溃 */
  errors: string[]
}
