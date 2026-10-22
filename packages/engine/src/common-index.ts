/**
 * common/ 通用索引器 —— 执行 common-rules.ts 里的规则表。
 *
 * 与 indexer.ts 的不同:indexer 是"每种目录写一段提取代码",这里是"一份代码跑全部规则"。
 * 新增目录支持 = 往规则表加一行,不动本文件。
 *
 * 额外产出:
 *   - 覆盖度报告:哪些目录有规则、哪些没有(新 DLC 的目录会暴露在这里)
 *   - 图标/本地化引用:按规则的 iconKeys/locKeys 抽取,供悬空检查
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, extname, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, lineOf, valueText } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'
import { COMMON_RULES, EXTRA_RULES_FILE, type CommonRule } from './common-rules.ts'

export interface Definition {
  kind: string
  id: string
  file: string
  line: number
  /** 上层作用域:类别 / 分组 / 国家 TAG */
  scope?: string
  /** 来源规则所在 root 序号 */
  root: number
}

export interface SymRef {
  /** 引用的目标种类 */
  target: 'gfx_sprite' | 'loc_key'
  name: string
  file: string
  line: number
  /** 引用出自哪个定义 */
  owner?: string
  ownerKind?: string
  /**
   * ★ MOD_SCOPE_V1:引用出自哪个 root(与 Definition.root 同义)。
   *   模组级体检只报目标模组的问题时,靠它把「问题出在 KR」和
   *   「问题出在 vanilla」分开 —— 之前 ref 完全没有来源归属。
   */
  root: number
}

export interface RootSpec {
  name: string
  path: string
}

export interface Coverage {
  /** 目录 → 规则数 */
  ruled: Map<string, number>
  /** 存在但没有任何规则的目录 */
  unruled: string[]
  /** 有规则但目录在所有 root 里都不存在(可能已改名/被移除) */
  missing: string[]
  /** 目录 → 文件数 */
  fileCount: Map<string, number>
}

export interface CommonIndex {
  defs: Definition[]
  /** kind:id → 全部定义位置 */
  byId: Map<string, Definition[]>
  refs: SymRef[]
  coverage: Coverage
  /** 目录 → 该文件解析失败数 */
  errors: { file: string; error: string }[]
  stats: { files: number; dirs: number; defs: number; kinds: number; dup: number }
}

/* ── 文件遍历 ── */

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  let items: string[] = []
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }
  for (const it of items) {
    const p = join(dir, it)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

/** 从相对路径里取出 common/<dir>/ 的 dir */
export function dirOf(rel: string): string | undefined {
  const parts = rel.split(/[\\/]/)
  const i = parts.findIndex((p) => p.toLowerCase() === 'common')
  if (i < 0 || i + 1 >= parts.length) return undefined
  return parts[i + 1]
}

/* ── 规则执行 ── */

function childValue(doc: Document, b: Block, key: string): string | undefined {
  const e = b.entries.find((x) => keyText(doc, x)?.toLowerCase() === key.toLowerCase())
  return e ? valueText(doc, e) : undefined
}

/** 按嵌套路径取值:`default = { tag = USA }` → idPath ['default','tag'] → 'USA' */
function pathValue(doc: Document, b: Block, path: string[]): string | undefined {
  let cur: Block = b
  for (let i = 0; i < path.length; i++) {
    const step = path[i]
    const e = cur.entries.find((x) => keyText(doc, x)?.toLowerCase() === step.toLowerCase())
    if (!e) return undefined
    if (i === path.length - 1) return valueText(doc, e)
    if (!e.block) return undefined
    cur = e.block
  }
  return undefined
}

/** 决定一个块的 id:优先 idPath,其次 idKey,最后回退键名 */
function idOf(doc: Document, b: Block, rule: CommonRule, fallback: string): string {
  if (rule.idPath) {
    const v = pathValue(doc, b, rule.idPath)
    if (v) return v
  }
  if (rule.idKey) return childValue(doc, b, rule.idKey) ?? fallback
  return fallback
}

function skipped(rule: CommonRule, key: string): boolean {
  if (rule.skipKeyPrefix?.some((p) => key.startsWith(p))) return true
  if (rule.skipKeys?.includes(key)) return true
  return false
}

/** 纯行列表文件:每行一个 token,跳过空行与 # 注释 */
function lineListDefs(text: string, kind: string, file: string, rootIdx: number): Definition[] {
  const out: Definition[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/#.*$/, '').trim()
    if (!t) continue
    out.push({ kind, id: t, file, line: i + 1, root: rootIdx })
  }
  return out
}

function rootBlocks(doc: Document, root: string[] | '*'): Block[] {
  if (root === '*') return [doc.root]
  const out: Block[] = []
  for (const e of doc.root.entries) {
    const k = keyText(doc, e)
    if (k && root.includes(k) && e.block) out.push(e.block)
  }
  return out
}

/** 在一个"定义块"内抽取图标/本地化引用 */
function collectRefs(
  doc: Document,
  b: Block,
  rule: CommonRule,
  id: string,
  file: string,
  out: SymRef[],
  rootIdx: number,
): void {
  const keys = rule.iconKeys ?? []
  const locs = rule.locKeys ?? []
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const low = k.toLowerCase()
    if (e.value >= 0) {
      const v = valueText(doc, e)
      if (!v) continue
      if (keys.includes(low)) {
        out.push({ target: 'gfx_sprite', name: v, file, line: lineOf(doc, e), owner: id, ownerKind: rule.kind, root: rootIdx })
      } else if (locs.includes(low)) {
        out.push({ target: 'loc_key', name: v, file, line: lineOf(doc, e), owner: id, ownerKind: rule.kind, root: rootIdx })
      }
    }
  }
}

interface RuleOut {
  defs: Definition[]
  refs: SymRef[]
}

function applyRule(doc: Document, text: string, file: string, rule: CommonRule, rootIdx: number): RuleOut {
  const out: RuleOut = { defs: [], refs: [] }
  const rel = file

  // 纯行列表:没有 key=value 结构,按行取
  if (rule.lineList) {
    out.defs.push(...lineListDefs(text, rule.kind, rel, rootIdx))
    return out
  }

  // id 取自文件名(countries/ 没有 id 键)
  if (rule.idFromFile) {
    const id = basename(rel, extname(rel))
    if (id) out.defs.push({ kind: rule.kind, id, file: rel, line: 1, root: rootIdx })
    return out
  }

  // 按块名精确抓取(如国策的 focus/focus_tree/shared_focus/... 等多种块)
  if (rule.matchKeys) {
    const mk = new Set(rule.matchKeys.map((s) => s.toLowerCase()))
    const consider = (e: typeof doc.root.entries[number]) => {
      if (!e.block) return
      const k = keyText(doc, e)?.toLowerCase()
      if (!k || !mk.has(k)) return
      const id = idOf(doc, e.block, rule, k)
      if (!id) return
      out.defs.push({ kind: rule.kind, id, file: rel, line: lineOf(doc, e), root: rootIdx })
      if (rule.iconKeys || rule.locKeys) collectRefs(doc, e.block, rule, id, rel, out.refs, rootIdx)
    }
    for (const e of doc.root.entries) consider(e)
    // focus_tree 容器内部的 focus 块也视为定义
    for (const e of doc.root.entries) {
      if (e.block && keyText(doc, e)?.toLowerCase() === 'focus_tree') {
        for (const e2 of e.block.entries) consider(e2)
      }
    }
    return out
  }

  for (const rb of rootBlocks(doc, rule.root)) {
    for (const e1 of rb.entries) {
      const k1 = keyText(doc, e1)
      if (!k1 || skipped(rule, k1)) continue

      if (rule.depth === 1) {
        if (!e1.block) {
          // 简单值条目:只有 allowValue 才算定义(country_tags: GER = "countries/...")
          if (!rule.allowValue) continue
          if (!valueText(doc, e1)) continue
          out.defs.push({ kind: rule.kind, id: k1, file: rel, line: lineOf(doc, e1), root: rootIdx })
          continue
        }
        const id = idOf(doc, e1.block, rule, k1)
        if (!id) continue
        out.defs.push({ kind: rule.kind, id, file: rel, line: lineOf(doc, e1), root: rootIdx })
        if (rule.iconKeys || rule.locKeys) collectRefs(doc, e1.block, rule, id, rel, out.refs, rootIdx)
      } else {
        if (!e1.block) continue
        for (const e2 of e1.block.entries) {
          const k2 = keyText(doc, e2)
          if (!k2 || !e2.block || skipped(rule, k2)) continue
          const id = idOf(doc, e2.block, rule, k2)
          if (!id) continue
          out.defs.push({ kind: rule.kind, id, file: rel, line: lineOf(doc, e2), scope: k1, root: rootIdx })
          if (rule.iconKeys || rule.locKeys) collectRefs(doc, e2.block, rule, id, rel, out.refs, rootIdx)
        }
      }
    }
  }
  return out
}

/* ── 主入口 ── */

export function buildCommonIndex(
  roots: RootSpec[],
  opts: { extraRules?: CommonRule[]; dirs?: string[]; exts?: string[] } = {},
): CommonIndex {
  const rules = [...COMMON_RULES, ...(opts.extraRules ?? [])]
  const exts = opts.exts ?? ['.txt']

  // 目录 → 规则
  const byDir = new Map<string, CommonRule[]>()
  for (const r of rules) {
    const l = byDir.get(r.dir) ?? []
    l.push(r)
    byDir.set(r.dir, l)
  }

  const defs: Definition[] = []
  const refs: SymRef[] = []
  const errors: { file: string; error: string }[] = []
  const fileCount = new Map<string, number>()
  let files = 0

  roots.forEach((root, ri) => {
    const commonDir = join(root.path, 'common')
    if (!existsSync(commonDir)) return
    const wanted = opts.dirs
    for (const abs of walk(commonDir, exts)) {
      const rel = relative(root.path, abs).replace(/\\/g, '/')
      const d = dirOf(rel)
      if (!d) continue
      if (wanted && !wanted.includes(d)) continue
      fileCount.set(d, (fileCount.get(d) ?? 0) + 1)
      files++

      const rs = byDir.get(d)
      if (!rs || !rs.length) continue

      let src = ''
      let doc: Document
      try {
        src = readFileSync(abs, 'utf8')
        doc = parse(src)
      } catch (e) {
        errors.push({ file: rel, error: String(e) })
        continue
      }

      for (const rule of rs) {
        if (rule.exclude && new RegExp(rule.exclude, 'i').test(rel)) continue
        if (rule.include && !new RegExp(rule.include, 'i').test(rel)) continue
        const got = applyRule(doc, src, rel, rule, ri)
        defs.push(...got.defs)
        refs.push(...got.refs)
      }
    }
  })

  // kind:id → 位置
  const byId = new Map<string, Definition[]>()
  for (const d of defs) {
    const k = `${d.kind}:${d.id}`
    const l = byId.get(k) ?? []
    l.push(d)
    byId.set(k, l)
  }

  // 覆盖度
  const ruled = new Map<string, number>()
  for (const [d, rs] of byDir) ruled.set(d, rs.length)
  const present = new Set(fileCount.keys())
  const unruled = [...present].filter((d) => !ruled.has(d)).sort()
  const missing = [...ruled.keys()].filter((d) => !present.has(d)).sort()

  const kinds = new Set(defs.map((d) => d.kind))
  let dup = 0
  for (const [, l] of byId) if (l.length > 1) dup++

  return {
    defs,
    byId,
    refs,
    coverage: { ruled, unruled, missing, fileCount },
    errors,
    stats: { files, dirs: present.size, defs: defs.length, kinds: kinds.size, dup },
  }
}

/* ── 外挂扩展加载 ── */

/**
 * 加载 common-rules.extra.json —— 为新 DLC 添加支持而不用改代码。
 * 查找顺序:显式传入的 extraPath → 各 root 根目录 → toolkit 根目录。
 */
export function loadExtraRules(extraPath?: string, roots: RootSpec[] = []): CommonRule[] {
  const candidates = [
    ...(extraPath ? [extraPath] : []),
    ...roots.map((r) => join(r.path, EXTRA_RULES_FILE)),
    join(process.cwd(), EXTRA_RULES_FILE),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
      if (!Array.isArray(raw)) continue
      const out = raw.filter((x): x is CommonRule => !!x && typeof (x as CommonRule).dir === 'string' && typeof (x as CommonRule).kind === 'string')
      if (out.length) {
        console.error(`[common] 已加载外挂规则 ${out.length} 条:${p}`)
        return out.map((r) => ({ ...r, source: r.source ?? 'user' }))
      }
    } catch (e) {
      console.error(`[common] 外挂规则解析失败 ${p}:${String(e)}`)
    }
  }
  return []
}
