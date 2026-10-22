/**
 * 跨文件无损重命名 / 坐标同步。
 *
 * 与 gui/edit.ts 同一套三道闸,但作用域从"一个文件里的若干坐标"扩到
 * "若干个文件里的若干个键/值":
 *   1. 只改定位到的那一个 token —— 其余字节不动;
 *   2. 每个文件独立做行级守卫,改动必须落在预期行内;
 *   3. 只产出补丁(plan),写盘与备份交给调用方(server / CLI)。
 *
 * 全程不持有 AST 对象:每个文件重新解析、按 (键路径 + 行号) 重新定位。
 * 这样即使图是上一次构建的、文件已被改过,也不会写到错地方(行号对不上就报未命中)。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { serialize, keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Document, Entry, Block } from '../../parser/src/ast.ts'
import { verifyEdit, makeDiff } from '../../gui/src/edit.ts'
import { refsOf, symKey, type LinkGraph, type SymDef, type SymRef, type RefKind } from './links.ts'

export interface RenameDetail {
  line: number
  from: string
  to: string
  kind: 'def' | RefKind
  /** 改动落在键还是值上 */
  slot: 'key' | 'value'
}

export interface FilePatch {
  root: number
  file: string
  text: string
  details: RenameDetail[]
  warnings: string[]
  /**
   * 同文件里"也叫这个名字、但没被自动改"的地方。
   * 实测两类:
   *   @lon_we_1_icon_x = 20        —— 元素名参与了脚本变量命名
   *   AST_uap_campaign_focus_cost  —— 派生元素以前缀方式命名
   * 它们不在引用图里,自动改容易误伤,所以只提示、由人决定。
   */
  notes: string[]
  guard: { ok: boolean; range: [number, number] | null; message: string }
  diff: string
}

/** 找出改名后仍然残留旧名的行 —— 通常是变量或派生名,不该自动改,但必须让人看见 */
function leftoverOccurrences(src: string, name: string, changedLines: number[], limit = 8): string[] {
  const out: string[] = []
  const lines = src.split('\n')
  const done = new Set(changedLines)
  for (let i = 0; i < lines.length; i++) {
    if (done.has(i + 1)) continue
    const l = lines[i]
    if (!l.includes(name)) continue
    out.push(`L${i + 1}: ${l.trim().slice(0, 100)}`)
    if (out.length >= limit) break
  }
  return out
}

/* ── 定位 ── */

/** 沿键路径找候选 entry(同名 key 可能有多条),再用行号收敛 */
function locate(doc: Document, path: string[], line: number): Entry | undefined {
  let level: Entry[] = doc.root.entries
  let cur: Entry[] = []
  for (const seg of path) {
    cur = level.filter((e) => keyText(doc, e) === seg)
    if (!cur.length) return undefined
    level = cur.flatMap((e) => (e.block ? e.block.entries : []))
  }
  if (cur.length === 1) return cur[0]
  const hit = cur.find((e) => lineOf(doc, e) === line)
  return hit ?? cur[0]
}

function blockOf(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  }
  return undefined
}

/** 取块内某键的当前文本值 */
function currentValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() !== key.toLowerCase()) continue
    return e.value >= 0 ? (valueText(doc, e) ?? doc.tokens[e.value].text) : '(块)'
  }
  return undefined
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)))
}

/** 写文本:保留原有的引号风格 —— 原来带引号就带引号,原来裸写就裸写 */
function writeToken(doc: Document, idx: number, text: string): void {
  const t = doc.tokens[idx]
  const quoted = t.type === 'string' || (t.text.startsWith('"') && t.text.endsWith('"'))
  t.text = quoted ? `"${text}"` : text
}

/* ── 重命名 ── */

export interface RenameOptions {
  /** 连带改定义处(默认 true) */
  includeDef?: boolean
}

export function planRename(graph: LinkGraph, def: SymDef, newName: string, opts: RenameOptions = {}): FilePatch[] {
  const wantDef = opts.includeDef !== false
  const refs = refsOf(graph, def.kind, def.name)

  // 按文件分组
  const groups = new Map<string, { root: number; file: string; refs: SymRef[]; def?: SymDef }>()
  const key = (root: number, file: string) => `${root}|${file}`
  if (wantDef) {
    groups.set(key(def.root, def.file), { root: def.root, file: def.file, refs: [], def })
  }
  for (const r of refs) {
    const k = key(r.root, r.file)
    const g = groups.get(k)
    if (g) g.refs.push(r)
    else groups.set(k, { root: r.root, file: r.file, refs: [r] })
  }

  const patches: FilePatch[] = []
  for (const g of groups.values()) {
    const root = graph.roots[g.root]
    if (!root) continue
    let src: string
    try {
      src = readText(root.path, g.file)
    } catch (e) {
      patches.push({
        root: g.root,
        file: g.file,
        text: '',
        details: [],
        warnings: [`读取失败: ${String(e)}`],
        notes: [],
        guard: { ok: false, range: null, message: '读取失败' },
        diff: '',
      })
      continue
    }
    const doc = parse(src)
    const details: RenameDetail[] = []
    const warnings: string[] = []
    const touched: number[] = []

    if (g.def) applyDef(doc, g.def, newName, details, warnings, touched)
    for (const r of g.refs) applyRef(doc, r, newName, details, warnings, touched)

    const text = serialize(doc)
    const guard = verifyEdit(src, text, touched)
    const notes =
      g.def && g.def.kind !== 'gfx_sprite'
        ? leftoverOccurrences(src, g.def.name, details.map((d) => d.line))
        : []
    patches.push({
      root: g.root,
      file: g.file,
      text,
      details,
      warnings,
      notes,
      guard,
      diff: makeDiff(src, text),
    })
  }
  return patches
}

function applyDef(
  doc: Document,
  def: SymDef,
  newName: string,
  details: RenameDetail[],
  warnings: string[],
  touched: number[],
): void {
  const e = locate(doc, def.path, def.line)
  if (!e) {
    warnings.push(`定义处未命中: ${def.file}:${def.line} ${def.path.join('>')}`)
    return
  }
  // gui_element / gfx_sprite:名字写在块内的 name = "..."
  if (def.kind === 'gui_element' || def.kind === 'gfx_sprite') {
    if (!e.block) {
      warnings.push(`定义处无块: ${def.path.join('>')}`)
      return
    }
    // name = "senate_icon" 是简单值,不是块 —— 别用 blockOf 去找子块(找了就永远 undefined)
    const target = e.block.entries.find((c) => keyText(doc, c)?.toLowerCase() === 'name' && !c.block)
    if (!target || target.value < 0) {
      warnings.push(`定义处找不到 name: ${def.path.join('>')}`)
      return
    }
    const from = valueText(doc, target) ?? doc.tokens[target.value].text
    touched.push(doc.tokens[target.value].line)
    if (from !== newName) {
      writeToken(doc, target.value, newName)
      details.push({ line: doc.tokens[target.value].line, from, to: newName, kind: 'def', slot: 'value' })
    }
    return
  }
  // scripted_gui / inlay_window:名字本身就是键
  if (e.key < 0) {
    warnings.push(`定义处无键: ${def.path.join('>')}`)
    return
  }
  const from = keyText(doc, e) ?? doc.tokens[e.key].text
  touched.push(doc.tokens[e.key].line)
  if (from !== newName) {
    writeToken(doc, e.key, newName)
    details.push({ line: doc.tokens[e.key].line, from, to: newName, kind: 'def', slot: 'key' })
  }
}

function applyRef(
  doc: Document,
  r: SymRef,
  newName: string,
  details: RenameDetail[],
  warnings: string[],
  touched: number[],
): void {
  const e = locate(doc, r.path, r.line)
  if (!e) {
    warnings.push(`引用未命中: ${r.file}:${r.line} ${r.path.join('>')}`)
    return
  }
  const idx = r.slot === 'value' ? e.value : e.key
  if (idx < 0) {
    warnings.push(`引用处无${r.slot === 'value' ? '值' : '键'}: ${r.path.join('>')}`)
    return
  }
  const from = r.slot === 'value' ? (valueText(doc, e) ?? doc.tokens[idx].text) : (keyText(doc, e) ?? doc.tokens[idx].text)
  // 行号漂移(文件被外部改过)就拒绝,避免写错地方
  if (doc.tokens[idx].line !== r.line) {
    warnings.push(`行号已漂移(图 ${r.line} / 实际 ${doc.tokens[idx].line}),跳过: ${r.path.join('>')}`)
    return
  }
  const to = r.slot === 'key' ? `${newName}${r.suffix ?? ''}` : newName
  touched.push(doc.tokens[idx].line)
  if (from === to) return
  writeToken(doc, idx, to)
  details.push({ line: r.line, from, to, kind: r.kind, slot: r.slot })
}

/* ── 坐标同步:把拖拽结果写进 scripted_gui 的 properties.x/y ── */

export interface XySync {
  ref: SymRef
  x?: number
  y?: number
  /** 明确要覆盖动态绑定(变量/表达式)。默认拒绝,因为那会毁掉运行时定位 */
  force?: boolean
}

const NUMERIC = /^-?\d+(\.\d+)?$/

function isNumeric(v: string | undefined): boolean {
  return v !== undefined && NUMERIC.test(v.trim())
}

/**
 * scripted_gui 的 properties.<元素> = { x = ... y = ... } 会覆盖 .gui 里的 position。
 * 所以在画布上拖动元素后,若不同步这里,游戏里根本不会变 —— 这是"所见非所得"的元凶。
 */
export function planXySync(graph: LinkGraph, syncs: XySync[]): FilePatch[] {
  const groups = new Map<string, { root: number; file: string; items: XySync[] }>()
  for (const s of syncs) {
    const k = `${s.ref.root}|${s.ref.file}`
    const g = groups.get(k)
    if (g) g.items.push(s)
    else groups.set(k, { root: s.ref.root, file: s.ref.file, items: [s] })
  }

  const patches: FilePatch[] = []
  for (const g of groups.values()) {
    const root = graph.roots[g.root]
    if (!root) continue
    const src = readText(root.path, g.file)
    const doc = parse(src)
    const details: RenameDetail[] = []
    const warnings: string[] = []
    const touched: number[] = []

    for (const s of g.items) {
      const e = locate(doc, s.ref.path, s.ref.line)
      if (!e || !e.block) {
        warnings.push(`properties 块未命中: ${s.ref.file}:${s.ref.line}`)
        continue
      }
      for (const axis of ['x', 'y'] as const) {
        const want = axis === 'x' ? s.x : s.y
        if (want === undefined) continue
        const cur = currentValue(doc, e.block, axis)
        // 实测:35 处 properties 覆盖里 **没有一处是纯数字**,全是
        // var:ROOT.r56_dockyard_x / owner:xxx_x?40 / array_x^idx 这类动态绑定。
        // 直接写数字会把运行时定位改成死坐标,所以默认拒绝并说清原因。
        if (cur !== undefined && !isNumeric(cur) && !s.force) {
          warnings.push(
            `${s.ref.name}.${axis} 绑定的是动态值 "${cur}",${s.ref.vars?.length ? `变量 ${s.ref.vars.join('/')} ` : ''}拖拽不会生效(改变量或用 force 覆盖)`,
          )
          continue
        }
        setNum(doc, e.block, axis, want, s.ref.name, details, warnings, touched)
      }
    }

    const text = serialize(doc)
    patches.push({
      root: g.root,
      file: g.file,
      text,
      details,
      warnings,
      notes: [],
      guard: verifyEdit(src, text, touched),
      diff: makeDiff(src, text),
    })
  }
  return patches
}

/** 改块内数值;key 不存在则插到块末尾(与 gui/edit.ts 的 writeNum 同策略) */
function setNum(
  doc: Document,
  b: Block,
  key: string,
  value: number,
  ctx: string,
  details: RenameDetail[],
  warnings: string[],
  touched: number[],
): void {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() !== key.toLowerCase()) continue
    if (e.value < 0) {
      warnings.push(`${ctx}: ${key} 是块,无法写入`)
      return
    }
    const tok = doc.tokens[e.value]
    const from = valueText(doc, e) ?? tok.text
    const to = fmt(value)
    touched.push(tok.line)
    if (from === to) return
    writeToken(doc, e.value, to)
    details.push({ line: tok.line, from, to, kind: 'property_xy', slot: 'value' })
    return
  }
  const at = b.close >= 0 ? b.close : b.entries.length ? b.entries[b.entries.length - 1].end : b.open + 1
  if (at < 0 || at > doc.tokens.length) {
    warnings.push(`${ctx}: 无法插入 ${key}`)
    return
  }
  const line = doc.tokens[Math.min(at, doc.tokens.length - 1)]?.line ?? 1
  const mk = (type: 'word' | 'punct' | 'ws', text: string) => ({ type, text, offset: -1, line, col: 1 }) as const
  doc.tokens.splice(
    at,
    0,
    mk('ws', ' '),
    mk('word', key),
    mk('punct', '='),
    mk('word', fmt(value)),
  )
  details.push({ line, from: '(缺失)', to: fmt(value), kind: 'property_xy', slot: 'value' })
  touched.push(line)
  reindex(doc)
}

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

function readText(rootPath: string, file: string): string {
  return readFileSync(join(rootPath, file), 'utf8')
}

export { symKey }
