/**
 * 无损回写。
 *
 * 原理:AST 只存 token 下标,序列化就是按序拼接 token.text。
 * 所以"改一个坐标"= 找到那个数字 token,只替换它的 text —— 其余字节一个不动,
 * 注释、缩进、空行、行内 # 全部原样保留。
 *
 * 三道闸:
 *  1. 只改预期的 token(value token),不重建文本;
 *  2. 行级校验:输出的差异必须全部落在被改节点所在的行区间内;
 *  3. 写盘前备份,且提供 diff 预览。
 */

import { serialize, keyText, valueText } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import type { Token as Tk } from '../../parser/src/tokenizer.ts'
import { buildLayout, type Layout } from './model.ts'

export interface NodeEdit {
  id: string
  x?: number
  y?: number
  w?: number
  h?: number
}

export interface EditDetail {
  id: string
  field: string
  from: string
  to: string
  line: number
  mode: 'replace' | 'insert'
}

export interface EditOutcome {
  text: string
  details: EditDetail[]
  warnings: string[]
  /** 行级校验结果 */
  guard: { ok: boolean; range: [number, number] | null; message: string }
}

export function applyEdits(layout: Layout, edits: NodeEdit[]): EditOutcome {
  const original = layout.source
  const details: EditDetail[] = []
  const warnings: string[] = []
  const touchedLines: number[] = []

  // doc / entries 会在"插入新块"后失效(需重新解析),所以用可变变量跟踪。
  //
  // 分两阶段执行,顺序很关键:
  //   阶段一 只补缺失的块,阶段二 只写数值。
  // 若边插边写,后面插入的新块会把已改动的行整体下移,先前记录的 touchedLines
  // 就成了过期行号,守卫会误判(实测 120 个文件里误报 20 个)。
  // 先把所有结构性插入做完,再统一写值,行号就始终是新鲜的。
  let doc = layout.doc
  let entries: Map<string, { doc: Document; entry: Entry }> = new Map(layout.entries)

  // ── 阶段一:补齐缺失的 position / size 块 ──
  let inserted = false
  for (const ed of edits) {
    const ref = entries.get(ed.id)
    if (!ref || !ref.entry.block) continue
    const b = ref.entry.block
    const needPos = (ed.x !== undefined || ed.y !== undefined) && !hasBlock(doc, b, 'position')
    const needSize = (ed.w !== undefined || ed.h !== undefined) && !hasBlock(doc, b, 'size')
    if (!needPos && !needSize) continue
    // 插入后必须重新解析:splice 只动 token,AST 的 entries 不会自动新增条目,
    // 继续按 key 查找会落空(第一版就栽在这,还把文件写坏了)。
    if (needPos) insertBlockShell(doc, b, 'position', ['x', 'y'])
    if (needSize) insertBlockShell(doc, b, 'size', ['width', 'height'])
    const rebuilt = buildLayout(serialize(doc), layout.file)
    doc = rebuilt.doc
    entries = rebuilt.entries
    inserted = true
  }
  // 重建后 sprite 相关尺寸没有了(未传 sprites),不影响坐标写入

  // ── 阶段二:写数值 ──
  for (const ed of edits) {
    const ref = entries.get(ed.id)
    if (!ref) {
      warnings.push(`节点不存在: ${ed.id}`)
      continue
    }
    if (!ref.entry.block) {
      warnings.push(`节点无块: ${ed.id}`)
      continue
    }

    if (ed.x !== undefined || ed.y !== undefined) {
      const pos = blockOf(doc, ref.entry.block, 'position')
      if (!pos) warnings.push(`${ed.id}: 找不到 position 块`)
      else {
        if (ed.x !== undefined) writeNum(doc, pos, 'x', ed.x, ed.id, details, touchedLines)
        if (ed.y !== undefined) writeNum(doc, pos, 'y', ed.y, ed.id, details, touchedLines)
      }
    }
    if (ed.w !== undefined || ed.h !== undefined) {
      const sz = blockOf(doc, ref.entry.block, 'size')
      if (!sz) warnings.push(`${ed.id}: 找不到 size 块`)
      else {
        if (ed.w !== undefined) writeNum(doc, sz, 'width', ed.w, ed.id, details, touchedLines)
        if (ed.h !== undefined) writeNum(doc, sz, 'height', ed.h, ed.id, details, touchedLines)
      }
    }
  }
  void inserted

  const text = serialize(doc)
  const guard = verify(original, text, touchedLines, details)
  return { text, details, warnings, guard }
}

function hasBlock(doc: Document, b: Block, key: string): boolean {
  return !!blockOf(doc, b, key)
}

function blockOf(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key && e.block) return e.block
  }
  return undefined
}

/**
 * 新条目的插入点:最后一条内容的末尾(而不是 block.close)。
 *
 * 坑:parser 的 backfillEnds 把最后一条 entry 的 end 设成了 `}` 的下标,
 * 直接插在那里会得到 `position = { x=0 y=0 }}` —— 语法没错但很难看,
 * 而且会让 `}` 失去原本的换行。插在内容末尾、尾部空白之前才对。
 */
function insertionIndex(parent: Block): number {
  const last = parent.entries[parent.entries.length - 1]
  if (!last) return parent.close >= 0 ? parent.close : parent.open + 1
  if (last.block && last.block.close >= 0) return last.block.close + 1
  if (last.value >= 0) return last.value + 1
  if (last.key >= 0) return last.key + 1
  return last.end
}

/** 插入一个占位块(值先填 0),随后由 writeNum 写入真实值 */
function insertBlockShell(doc: Document, parent: Block, key: string, childKeys: string[]): void {
  // 插在 `}` 之前,并且把换行放在**尾部**而不是头部。
  // 若把换行放头部(插在最后一条内容之后),会插到"内容与行尾注释"之间,
  // 把 `foo = 1 # 说明` 的注释挤到新插入的那一行上 —— 注释的含义就变了。
  const at = parent.close >= 0 ? parent.close : insertionIndex(parent)
  if (at < 0 || at > doc.tokens.length) return
  const line = lineAt(doc, at)
  const indent = guessIndent(doc, parent)
  // 收尾缩进必须在改动 prevB 之前取:closingIndent 读的正是 prevB 本身
  const ciB = closingIndent(doc, parent)
  // 行首插入时复用既有换行并改用子级缩进,否则新块会少一级缩进
  const prevB = at > 0 ? doc.tokens[at - 1] : undefined
  const solB = !!prevB && prevB.type === 'ws' && prevB.text.includes('\n')
  if (solB) {
    const i = prevB!.text.lastIndexOf('\n')
    prevB!.text = prevB!.text.slice(0, i + 1) + indent
  }
  const lead: Tk[] = solB ? [] : [mk('ws', ' ', line)]
  const toks: Tk[] = [...lead, mk('word', key, line), mk('ws', ' ', line), mk('punct', '=', line), mk('ws', ' ', line), mk('punct', '{', line), mk('ws', ' ', line)]
  childKeys.forEach((k, i) => {
    if (i > 0) toks.push(mk('ws', ' ', line))
    toks.push(mk('word', k, line), mk('punct', '=', line), mk('word', '0', line))
  })
  // 尾部补换行 + 缩进,让原本的 `}` 保持在自己那一行。
  // 缩进必须取 `}` 自己那一行的(closingIndent),不能用子元素的缩进,
  // 否则 `}` 会莫名多一级缩进,被守卫判成多余改动。
  toks.push(mk('ws', ' ', line), mk('punct', '}', line), mk('ws', '\n' + ciB, line))
  spliceTokens(doc, at, 0, toks)
}

/** `}` 所在行的缩进 */
function closingIndent(doc: Document, parent: Block): string {
  const ci = parent.close
  if (ci > 0) {
    const t = doc.tokens[ci - 1]
    if (t && t.type === 'ws') {
      const idx = t.text.lastIndexOf('\n')
      if (idx >= 0) return t.text.slice(idx + 1)
    }
  }
  return guessIndent(doc, parent)
}

function writeNum(
  doc: Document,
  block: Block,
  key: string,
  value: number,
  nodeId: string,
  details: EditDetail[],
  touchedLines: number[],
): void {
  // 别名:部分元素的 size 用 x/y 表示宽高(listboxType 等),
  // 直接插 width/height 会变成 `size = { x=320 y=300 width=30 }` 这种四不像。
  const real = resolveKey(doc, block, key)
  for (const e of block.entries) {
    if (keyText(doc, e) !== real) continue
    if (e.value < 0) return
    const tok = doc.tokens[e.value]
    const wasQuoted = tok.type === 'string'
    const from = valueText(doc, e) ?? tok.text
    const to = fmtNum(value)
    // 先登记行号再判等:插入的占位值可能恰好等于目标值(如 x=0),
    // 此时虽然没有产生新改动,但"补块"这件事本身已经改了文件,
    // 必须把这一行算进预期范围,否则守卫会把它当成意外改动。
    touchedLines.push(tok.line)
    if (from === to) return
    tok.text = wasQuoted ? `"${to}"` : to
    details.push({ id: nodeId, field: key, from, to, line: tok.line, mode: 'replace' })
    touchedLines.push(tok.line)
    return
  }
  // key 不存在 → 插入到块末尾
  const at = block.close >= 0 ? block.close : insertionIndex(block)
  if (at < 0) return
  const line = lineAt(doc, at)
  const indN = guessIndent(doc, block)
  const prevN = at > 0 ? doc.tokens[at - 1] : undefined
  const solN = !!prevN && prevN.type === 'ws' && prevN.text.includes('\n')
  if (solN) {
    const i = prevN!.text.lastIndexOf('\n')
    prevN!.text = prevN!.text.slice(0, i + 1) + indN
  }
  const toks: Tk[] = []
  if (!solN) toks.push(mk('ws', ' ', line))
  toks.push(mk('word', real, line), mk('punct', '=', line), mk('word', fmtNum(value), line))
  spliceTokens(doc, at, 0, toks)
  details.push({ id: nodeId, field: key, from: '(缺失)', to: fmtNum(value), line, mode: 'insert' })
  touchedLines.push(line)
}

/** 块里若没有目标 key,但有等价别名(size 的 width↔x、height↔y),就用别名 */
function resolveKey(doc: Document, block: Block, key: string): string {
  for (const e of block.entries) if (keyText(doc, e) === key) return key
  const alias = key === 'width' ? 'x' : key === 'height' ? 'y' : undefined
  if (!alias) return key
  for (const e of block.entries) if (keyText(doc, e) === alias) return alias
  return key
}

/* ── token 层操作 ── */

function mk(type: Tk['type'], text: string, line: number): Tk {
  return { type, text, offset: -1, line, col: 1 }
}

function lineAt(doc: Document, idx: number): number {
  if (idx >= 0 && idx < doc.tokens.length) return doc.tokens[idx].line
  return doc.tokens.length ? doc.tokens[doc.tokens.length - 1].line : 1
}

function lastEntryEnd(b: Block): number {
  if (!b.entries.length) return b.open >= 0 ? b.open + 1 : -1
  return Math.max(...b.entries.map((e) => e.end))
}

/**
 * 插入/删除 token 并重排所有下标。
 * AST 里 key/op/value/start/end/open/close 全是下标,必须整体平移。
 */
function spliceTokens(doc: Document, at: number, del: number, newToks: Tk[]): void {
  const delta = newToks.length - del
  if (delta === 0 && newToks.length === 0) return
  const bump = (i: number) => (i >= at ? i + delta : i)
  const visit = (b: Block) => {
    if (b.open >= 0) b.open = bump(b.open)
    if (b.close >= 0) b.close = bump(b.close)
    for (const e of b.entries) {
      if (e.key >= 0) e.key = bump(e.key)
      if (e.op >= 0) e.op = bump(e.op)
      if (e.value >= 0) e.value = bump(e.value)
      e.start = bump(e.start)
      e.end = bump(e.end)
      if (e.block) visit(e.block)
    }
  }
  visit(doc.root)
  doc.tokens.splice(at, del, ...newToks)
  reindex(doc)
}

/** 重算 token 的 offset / line(插入后保持自洽) */
function reindex(doc: Document): void {
  let off = 0
  let line = 1
  for (const t of doc.tokens) {
    t.offset = off
    t.line = line
    off += t.text.length
    for (let i = 0; i < t.text.length; i++) if (t.text[i] === '\n') line++
  }
}

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v)
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** 猜块的缩进:取块内第一条 entry 的前导空白 */
function guessIndent(doc: Document, b: Block): string {
  const first = b.entries[0]
  if (!first) return '\t\t'
  // start 含前导 trivia,往前扫到本行开头
  let i = first.start
  let indent = ''
  while (i < first.key && i >= 0) {
    const t = doc.tokens[i]
    if (t.type === 'ws') {
      const m = t.text.match(/[ \t]*$/)
      if (m) indent = m[0]
      if (t.text.includes('\n')) break
    }
    i++
  }
  return indent || '\t\t'
}

/* ── 行级 diff 与校验 ── */

interface DiffOp {
  op: 'eq' | 'del' | 'add'
  a?: number
  b?: number
}

/**
 * Myers O(ND) 行级 diff。
 *
 * 为什么不用"公共前缀 + 公共后缀":两处改动相距较远时,它会把中间整段
 * 都标成改动,diff 面板直接没法看。Myers 在改动很少时(D 小)极快。
 */
function myersDiff(a: string[], b: string[]): DiffOp[] | null {
  const N = a.length
  const M = b.length
  if (N + M > 60000) return null // 过大就交给调用方降级
  const MAXD = Math.min(N + M, 2000)
  const off = N + M
  let V = new Int32Array(2 * off + 1)
  const trace: Int32Array[] = []
  let D = 0
  let done = false
  for (D = 0; D <= MAXD; D++) {
    trace.push(V.slice())
    for (let k = -D; k <= D; k += 2) {
      let x: number
      if (k === -D || (k !== D && V[off + k - 1] < V[off + k + 1])) x = V[off + k + 1]
      else x = V[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[x] === b[y]) {
        x++
        y++
      }
      V[off + k] = x
      if (x >= N && y >= M) {
        done = true
        break
      }
    }
    if (done) break
  }
  if (!done) return null

  const ops: DiffOp[] = []
  let x = N
  let y = M
  for (let d = D; d > 0; d--) {
    const Vp = trace[d]
    const k = x - y
    let pk: number
    if (k === -d || (k !== d && Vp[off + k - 1] < Vp[off + k + 1])) pk = k + 1
    else pk = k - 1
    const px = Vp[off + pk]
    const py = px - pk
    while (x > px && y > py) {
      ops.push({ op: 'eq', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === px) ops.push({ op: 'add', b: y - 1 })
      else ops.push({ op: 'del', a: x - 1 })
      if (x === px) y--
      else x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'eq', a: x - 1, b: y - 1 })
    x--
    y--
  }
  return ops.reverse()
}

/** 朴素降级:公共前缀 + 公共后缀 */
function naiveOps(a: string[], b: string[]): DiffOp[] {
  const out: DiffOp[] = []
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let sa = a.length - 1
  let sb = b.length - 1
  while (sa >= p && sb >= p && a[sa] === b[sb]) {
    sa--
    sb--
  }
  for (let i = 0; i < p; i++) out.push({ op: 'eq', a: i, b: i })
  for (let i = p; i <= sa; i++) out.push({ op: 'del', a: i })
  for (let i = p; i <= sb; i++) out.push({ op: 'add', b: i })
  for (let i = sb + 1; i < b.length; i++) out.push({ op: 'eq', a: i - sb + sa, b: i })
  return out
}

function diffOps(before: string, after: string): DiffOp[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // 比较时用"去行尾空白"的版本。
  // 原因:插入新条目会把上一行行尾的空白挤到下一行,内容一字未变,
  // 但不归一的话守卫会把它当成意外改动而误报(实测 120 文件误报 20 个)。
  // 渲染仍用原始文本,所以 diff 面板上这类空白变化依然可见。
  const an = a.map((s) => s.replace(/\s+$/, ''))
  const bn = b.map((s) => s.replace(/\s+$/, ''))
  // 行数没变 = 只改了值、没增删行,逐行比对就能得到精确结果。
  // 必须走这条路:Myers 在 N+M>60000 时会返回 null(国策文件动辄 3~4 万行),
  // 降级到 naive 的前缀/后缀比较会把"首个改动行到最后一个改动行"之间的
  // 所有行都判成改动 —— 改一处 x 却报 77 行异常,守卫直接误杀。
  if (a.length === b.length) {
    const ops: DiffOp[] = []
    for (let i = 0; i < a.length; i++) {
      if (an[i] === bn[i]) ops.push({ op: 'eq', a: i, b: i })
      else {
        ops.push({ op: 'del', a: i })
        ops.push({ op: 'add', b: i })
      }
    }
    return ops
  }
  return myersDiff(an, bn) ?? naiveOps(an, bn)
}

/**
 * 对外的校验入口:给定原文、新文和"预期被改动的行",判断差异是否全部落在预期内。
 * 供服务端在写盘前做二次确认,也用于测试守卫本身的检出能力。
 */
export function verifyEdit(original: string, text: string, touchedLines: number[]): EditOutcome['guard'] {
  return verify(original, text, touchedLines, touchedLines.length ? [{ id: '', field: '', from: '', to: '', line: touchedLines[0], mode: 'replace' }] : [])
}

/** 生成统一 diff 文本,供审查 */
export function makeDiff(before: string, after: string, context = 2): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const ops = diffOps(before, after)
  const out: string[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].op === 'eq') {
      // 只在改动附近输出上下文
      const near = ops.slice(Math.max(0, i - context), i + context + 1).some((o) => o.op !== 'eq')
      if (near) out.push(`  ${(ops[i].a ?? 0) + 1}| ${a[ops[i].a!]}`)
      i++
      continue
    }
    // 连续一段非 eq
    let j = i
    while (j < ops.length && ops[j].op !== 'eq') j++
    for (let k = i; k < j; k++) {
      const o = ops[k]
      if (o.op === 'del') out.push(`- ${o.a! + 1}| ${a[o.a!]}`)
      else out.push(`+ ${(o.b ?? 0) + 1}| ${b[o.b!]}`)
    }
    i = j
  }
  return out.join('\n')
}

/**
 * 精确校验:
 *  - 每一行被删除的行,行号必须落在被改 token 所在的行上;
 *  - 每一行新增的行,其"锚点"(前面最近一条未改动的行)必须落在改动区间内。
 * 这样任何"改动跑到了预期之外"的情况都会被拦下。
 */
function verify(
  original: string,
  now: string,
  touchedLines: number[],
  details: EditDetail[],
): EditOutcome['guard'] {
  if (!details.length) return { ok: true, range: null, message: '无改动' }
  if (now === original) return { ok: true, range: null, message: '内容未变化' }

  const touched = new Set(touchedLines)
  const ops = diffOps(original, now)
  if (!ops) return { ok: false, range: null, message: '文件过大,无法精确校验差异' }

  // 行号有两套:diff 的删除项用旧文本行号,touchedLines 记的是 token 的当前行号。
  // 一旦插入过新块,两者就整体错开 —— 用每段前面最近的 eq 对算出局部偏移来对齐,
  // 否则会大量误报(实测 120 文件里误报 20 个全是这个原因)。
  let lastEqA = 0
  let lastEqB = 0
  const badLines: number[] = []
  let changed = 0
  let firstCh = Infinity
  let lastCh = -Infinity
  for (const o of ops) {
    if (o.op === 'eq') {
      lastEqA = (o.a ?? 0) + 1
      lastEqB = (o.b ?? 0) + 1
      continue
    }
    changed++
    const shift = lastEqB - lastEqA
    if (o.op === 'del') {
      const old = (o.a ?? 0) + 1
      firstCh = Math.min(firstCh, old)
      lastCh = Math.max(lastCh, old)
      if (!touched.has(old) && !touched.has(old + shift)) badLines.push(old)
    } else {
      const cur = (o.b ?? 0) + 1
      firstCh = Math.min(firstCh, cur)
      lastCh = Math.max(lastCh, cur)
      if (!touched.has(cur) && !touched.has(cur - shift)) badLines.push(-cur)
    }
  }

  if (badLines.length) {
    return {
      ok: false,
      range: [firstCh, lastCh],
      message: `改动落在预期之外(预期行: ${[...touched].slice(0, 8).join(',')}${touched.size > 8 ? '…' : ''}):${badLines.slice(0, 5).join(', ')}`,
    }
  }
  return { ok: true, range: [firstCh, lastCh], message: `${changed} 行变化,全部落在预期内` }
}

/* ── VS 式所见即所得:增 / 删 / 改属性 ──
 *
 * 与 applyEdits 同源的"无损回写"保证:依旧只动 token,行级守卫兜底。
 * 三类操作各自独立成 op,前端每次发一个(结构变动后立即重载布局),
 * 避免多 pass 重解析导致行号错位的守卫误报。
 */

import { parse } from '../../parser/src/parser.ts'

/** 写进文件时需要加引号的属性(key 小写匹配) */
const QUOTE_PROPS = new Set([
  'name', 'spriteType', 'quadTextureSprite', 'text', 'buttonText', 'buttonFont',
  'font', 'hint_tag', 'pdx_tooltip', 'pdx_tooltip_delayed', 'web_link',
])

export type GuiOp =
  | { kind: 'set'; id: string; key: string; value: string }
  | {
      kind: 'add'
      parentId: string | null
      type: string
      name: string
      x?: number
      y?: number
      w?: number
      h?: number
      spriteType?: string
      text?: string
      orientation?: string
    }
  | { kind: 'del'; id: string }

export interface GuiEditResult {
  outcome: EditOutcome
  newId?: string
}

export function applyGuiOp(layout: Layout, op: GuiOp): GuiEditResult {
  if (op.kind === 'set') return opSet(layout, op)
  if (op.kind === 'add') return opAdd(layout, op)
  return opDel(layout, op)
}

function opSet(layout: Layout, op: Extract<GuiOp, { kind: 'set' }>): GuiEditResult {
  const ref = layout.entries.get(op.id)
  if (!ref || !ref.entry.block) {
    return {
      outcome: {
        text: layout.source,
        details: [],
        warnings: [`节点不存在: ${op.id}`],
        guard: { ok: false, range: null, message: '节点不存在' },
      },
    }
  }
  const doc = layout.doc
  const b = ref.entry.block
  const touched: number[] = []
  const details: EditDetail[] = []

  // 点号路径:borderSize.x / margin.left / slotSize.width …
  // 真实语法里这些几何参数都写在子块内,只能一层一层定位进去改,
  // 不支持的话属性网格就只能看着这些高频属性干瞪眼。
  const seg = op.key.split(".")
  let target: Block = b
  // 一路向下定位中间块;第一个缺失的中间块即开始自动补建(其后所有中间块必然也缺)。
  let missingFrom = -1
  for (let i = 0; i < seg.length - 1; i++) {
    let sub: Block | undefined
    for (const e of target.entries) {
      if (!e.block) continue
      const kk = keyText(doc, e)
      if (kk && kk.toLowerCase() === seg[i].toLowerCase()) { sub = e.block; break }
    }
    if (!sub) { missingFrom = i; break }
    target = sub
  }
  if (missingFrom >= 0) {
    // 中间块缺失 → 自动补建嵌套块壳并把叶子值一并写入(token 级无损:只加新 token)。
    insertNestedPropsBlock(doc, target, seg.slice(missingFrom, seg.length - 1), seg[seg.length - 1], op.value, op.id, details, touched)
  } else {
    writeScalar(doc, target, seg[seg.length - 1], op.value, op.id, details, touched)
  }
  const text = serialize(doc)
  const guard = verify(layout.source, text, touched, details)
  return { outcome: { text, details, warnings: [], guard } }
}

/**
 * 在块内写(或插入)一个标量属性 key = value。
 * 复用 writeNum 的插入逻辑:缺失时插到 `}` 之前并独占一行,
 * 行尾补换行+父块缩进,让原本的 `}` 留在自己那一行。
 */
function writeScalar(
  doc: Document,
  block: Block,
  key: string,
  value: string,
  nodeId: string,
  details: EditDetail[],
  touched: number[],
): void {
  const quoted = QUOTE_PROPS.has(key.toLowerCase())
  for (const e of block.entries) {
    if (keyText(doc, e) === key && !e.block) {
      if (e.value < 0) return
      const tok = doc.tokens[e.value]
      const from = valueText(doc, e) ?? tok.text
      const to = quoted ? `"${value}"` : value
      touched.push(tok.line)
      if (from === to) return
      tok.text = to
      details.push({ id: nodeId, field: key, from, to, line: tok.line, mode: 'replace' })
      touched.push(tok.line)
      return
    }
  }
  const at = block.close >= 0 ? block.close : insertionIndex(block)
  if (at < 0) return
  const ci = closingIndent(doc, block)
  // 插入点若已在行首(前一个 token 是含换行的空白),复用那个换行并把缩进换成子级缩进;
  // 否则只补一个空格做行内追加。原实现只补空格,导致新属性比同级元素少一级缩进。
  const ind = guessIndent(doc, block)
  const prevS = at > 0 ? doc.tokens[at - 1] : undefined
  const solS = !!prevS && prevS.type === 'ws' && prevS.text.includes('\n')
  if (solS) {
    const i = prevS!.text.lastIndexOf('\n')
    prevS!.text = prevS!.text.slice(0, i + 1) + ind
  }
  const vt: Tk = quoted ? mk('string', `"${value}"`) : mk('word', value)
  const toks: Tk[] = []
  if (!solS) toks.push(mk('ws', ' '))
  toks.push(mk('word', key), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), vt, mk('ws', '\n' + ci))
  spliceTokens(doc, at, 0, toks)
  details.push({ id: nodeId, field: key, from: '(缺失)', to: quoted ? `"${value}"` : value, line: doc.tokens[at].line, mode: 'insert' })
  for (let i = at; i < at + toks.length; i++) touched.push(doc.tokens[i].line)
}

/**
 * opSet 点号路径补建:在 parent(已定位到的存在块)末尾插入一条嵌套块,
 * pathSegs 为缺失的中间块(如 ['margin'] 或 ['size','min']),叶子 key=value 一并写入。
 * 输出单行嵌套块:margin = { top = 10 };size = { min = { width = 100 } }。
 * 只新增 token、不动既有 token(prevB 仅在行首复用时截断尾部空白,与 insertBlockShell 同法),
 * 行级守卫照常覆盖新插入的全部行。
 */
function insertNestedPropsBlock(
  doc: Document,
  parent: Block,
  pathSegs: string[],
  leafKey: string,
  value: string,
  nodeId: string,
  details: EditDetail[],
  touched: number[],
): void {
  const at = parent.close >= 0 ? parent.close : insertionIndex(parent)
  if (at < 0 || !pathSegs.length) return
  const line = lineAt(doc, at)
  const indent = guessIndent(doc, parent)
  const ci = closingIndent(doc, parent)
  const prevB = at > 0 ? doc.tokens[at - 1] : undefined
  const solB = !!prevB && prevB.type === 'ws' && prevB.text.includes('\n')
  if (solB) {
    const i = prevB!.text.lastIndexOf('\n')
    prevB!.text = prevB!.text.slice(0, i + 1) + indent
  }
  const quoted = QUOTE_PROPS.has(leafKey.toLowerCase())
  const toks: Tk[] = []
  if (!solB) toks.push(mk('ws', ' ', line))
  for (let k = 0; k < pathSegs.length; k++) {
    if (k > 0) toks.push(mk('ws', ' ', line))
    toks.push(mk('word', pathSegs[k], line), mk('ws', ' ', line), mk('punct', '=', line), mk('ws', ' ', line), mk('punct', '{', line), mk('ws', ' ', line))
  }
  toks.push(
    mk('word', leafKey, line), mk('punct', '=', line),
    quoted ? mk('string', `"${value}"`, line) : mk('word', value, line),
  )
  for (let k = 0; k < pathSegs.length; k++) {
    toks.push(mk('ws', ' ', line), mk('punct', '}', line))
  }
  toks.push(mk('ws', '\n' + ci, line))
  spliceTokens(doc, at, 0, toks)
  for (let i = at; i < at + toks.length; i++) touched.push(doc.tokens[i].line)
  const lastTok = doc.tokens[at + toks.length - 1]
  if (lastTok && lastTok.text.includes('\n')) touched.push(lastTok.line + 1)
  details.push({ id: nodeId, field: pathSegs.concat([leafKey]).join('.'), from: '(缺失)', to: quoted ? `"${value}"` : value, line: doc.tokens[at].line, mode: 'insert' })
}

function topContainer(doc: Document): Block | undefined {
  for (const e of doc.root.entries) {
    if (keyText(doc, e)?.toLowerCase() === 'guitypes' && e.block) return e.block
  }
  return doc.root
}

function opAdd(layout: Layout, op: Extract<GuiOp, { kind: 'add' }>): GuiEditResult {
  const doc = layout.doc
  let parentBlock: Block | undefined
  if (op.parentId) {
    const ref = layout.entries.get(op.parentId)
    parentBlock = ref?.entry.block
  } else {
    parentBlock = topContainer(doc)
  }
  if (!parentBlock) {
    return {
      outcome: {
        text: layout.source,
        details: [],
        warnings: ['找不到父容器'],
        guard: { ok: false, range: null, message: '找不到父容器' },
      },
    }
  }
  const at = parentBlock.close >= 0 ? parentBlock.close : insertionIndex(parentBlock)
  if (at < 0) {
    return {
      outcome: { text: layout.source, details: [], warnings: ['插入点无效'], guard: { ok: false, range: null, message: '插入点无效' } },
    }
  }

  const child = guessIndent(doc, parentBlock) || '\t'
  // 收尾缩进必须在动 prev 之前取:closingIndent 读的正是 close 前一个 token,
  // 若先改了它,取到的就是子元素缩进,`}` 会多缩进一级然后被守卫判为意外改动。
  const tail = closingIndent(doc, parentBlock)
  // 插入点前一个 token 若已含换行,说明光标已经在行首 —— 复用这个换行即可,
  // 不能再补一个。无条件补会让每个新增元素前面多出一个空行(实测 40 个文件全部命中)。
  const prev = at > 0 ? doc.tokens[at - 1] : undefined
  const atLineStart = !!prev && prev.type === 'ws' && prev.text.includes('\n')
  if (atLineStart) {
    const i = prev!.text.lastIndexOf('\n')
    prev!.text = prev!.text.slice(0, i + 1) + child
  }
  const NL = (ind: string) => mk('ws', '\n' + ind)
  const t: Tk[] = []
  if (!atLineStart) t.push(NL(child))
  t.push(mk('word', op.type), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('punct', '{'))
  t.push(NL(child + '\t'))
  t.push(mk('word', 'name'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('string', `"${op.name}"`))
  if (op.orientation) {
    t.push(NL(child + '\t'))
    t.push(mk('word', 'orientation'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('word', op.orientation))
  }
  if (op.x !== undefined || op.y !== undefined) {
    t.push(NL(child + '\t'))
    t.push(
      mk('word', 'position'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('punct', '{'), mk('ws', ' '),
      mk('word', 'x'), mk('punct', '='), mk('word', String(op.x ?? 0)), mk('ws', ' '),
      mk('word', 'y'), mk('punct', '='), mk('word', String(op.y ?? 0)), mk('ws', ' '), mk('punct', '}'),
    )
  }
  if (op.w !== undefined || op.h !== undefined) {
    t.push(NL(child + '\t'))
    t.push(
      mk('word', 'size'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('punct', '{'), mk('ws', ' '),
      mk('word', 'width'), mk('punct', '='), mk('word', String(op.w ?? 0)), mk('ws', ' '),
      mk('word', 'height'), mk('punct', '='), mk('word', String(op.h ?? 0)), mk('ws', ' '), mk('punct', '}'),
    )
  }
  if (op.spriteType) {
    t.push(NL(child + '\t'))
    t.push(mk('word', 'spriteType'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('string', `"${op.spriteType}"`))
  }
  if (op.text) {
    t.push(NL(child + '\t'))
    t.push(mk('word', 'text'), mk('ws', ' '), mk('punct', '='), mk('ws', ' '), mk('string', `"${op.text}"`))
  }
  t.push(NL(child))
  t.push(mk('punct', '}'))
  t.push(NL(tail))

  spliceTokens(doc, at, 0, t)
  // 把插入产生的每一行都算进守卫预期,绝不会误报
  const touched = new Set<number>()
  for (let i = at; i < at + t.length; i++) touched.add(doc.tokens[i].line)
  // 末尾那个换行会把原本的闭合括号顶到下一行,那一行同样属于预期改动
  const lastTok = doc.tokens[at + t.length - 1]
  if (lastTok && lastTok.text.includes('\n')) touched.add(lastTok.line + 1)
  const rebuilt = buildLayout(serialize(doc), layout.file)
  let newId: string | undefined
  for (const n of rebuilt.flat) if (n.name === op.name) { newId = n.id; break }
  const text = serialize(doc)
  const details: EditDetail[] = [
    { id: newId ?? '', field: 'add', from: '(无)', to: op.type, line: Math.min(...touched), mode: 'insert' },
  ]
  const guard = verify(layout.source, text, [...touched], details)
  return { outcome: { text, details, warnings: [], guard }, newId }
}

function opDel(layout: Layout, op: Extract<GuiOp, { kind: 'del' }>): GuiEditResult {
  const ref = layout.entries.get(op.id)
  if (!ref || !ref.entry.block) {
    return {
      outcome: {
        text: layout.source,
        details: [],
        warnings: [`节点不存在: ${op.id}`],
        guard: { ok: false, range: null, message: '节点不存在' },
      },
    }
  }
  const doc = layout.doc
  const e = ref.entry
  const start = e.key >= 0 ? e.key : e.start
  const end = e.block ? e.block.close : e.value
  if (start < 0 || end < 0) {
    return {
      outcome: { text: layout.source, details: [], warnings: ['无法定位元素块'], guard: { ok: false, range: null, message: '无法定位元素块' } },
    }
  }
  // 连前面的换行空白一起删,避免留下空行
  const preWs = start - 1
  const removeFrom =
    preWs >= 0 && doc.tokens[preWs].type === 'ws' && doc.tokens[preWs].text.includes('\n') ? preWs : start
  let minL = Infinity
  let maxL = -Infinity
  const touched = new Set<number>()
  for (let i = removeFrom; i <= end; i++) {
    const ln = doc.tokens[i].line
    touched.add(ln)
    if (ln < minL) minL = ln
    if (ln > maxL) maxL = ln
  }
  // 删除的是一段连续行;把中间每一行都算进预期,避免个别 token 的 .line 归属
  // 落在相邻行而被守卫误判(实测会漏报 1 行)。
  for (let L = minL; L <= maxL; L++) touched.add(L)
  spliceTokens(doc, removeFrom, end - removeFrom + 1, [])
  const text = serialize(doc)
  const details: EditDetail[] = [
    { id: op.id, field: 'delete', from: op.id, to: '(删除)', line: Math.min(...touched), mode: 'replace' },
  ]
  const guard = verify(layout.source, text, [...touched], details)
  return { outcome: { text, details, warnings: [], guard } }
}
