/**
 * 跨域符号引用图(symbol reference graph)。
 *
 * 为什么需要它:HOI4 的界面不是孤立的。一个 interface/*.gui 里的元素名,
 * 会被这些地方引用:
 *
 *   common/scripted_guis/*.txt
 *     window_name / parent_window_name / parent_window_window → 容器名
 *     properties.<元素名>            → 可覆盖 image / frame / **x / y**
 *     effects.<元素名>_click         → 点击效果
 *     triggers.<元素名>_visible      → 可见性
 *     dynamic_lists.<元素名>         → 动态列表,entry_container → 容器名
 *     ai_weights.<元素名>_click      → AI 权重
 *     parent_scripted_gui           → 另一个 scripted_gui
 *   common/focus_inlay_windows/*.txt
 *     window_name / scripted_images / scripted_buttons / scripted_progressbars
 *   common/decisions/categories/*.txt
 *     scripted_gui = <scripted_gui 名>
 *   common/national_focus/*.txt
 *     inlay_window = { id = <inlay_window 名> }
 *   interface/*.gfx ↔ interface/*.gui 的 spriteType
 *
 * 于是"改一个元素名"是一件牵一发动全身的事,而"拖一个元素"也可能因为
 * scripted_gui 里写了 x/y 覆盖而完全不生效 —— 这两件事正是本模块要解决的。
 *
 * 设计原则与 parser 一致:只存"位置"(文件 + 键路径 + 行号),不持有 AST 对象。
 * 重命名时按位置重新解析、重新定位,避免跨调用的对象失效。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'

export type SymKind = 'gui_element' | 'gfx_sprite' | 'scripted_gui' | 'inlay_window' | 'gui_var'

export type RefKind =
  | 'window_name'
  | 'parent_window'
  | 'parent_scripted_gui'
  | 'property'
  | 'property_xy'
  | 'effect'
  | 'trigger'
  | 'ai_weight'
  | 'dynamic_list'
  | 'entry_container'
  | 'inlay_child'
  | 'sprite'
  | 'scripted_gui_use'
  | 'inlay_use'

export interface LinkRoot {
  name: string
  path: string
}

export interface SymDef {
  kind: SymKind
  name: string
  root: number
  file: string
  line: number
  /** 额外说明,如元素类型 containerWindowType */
  detail?: string
  /** 键路径,重命名时用来重新定位(不持有 AST 对象) */
  path: string[]
}

export interface SymRef {
  kind: RefKind
  target: SymKind
  /** 被引用的名字(已剥离 _click 等后缀) */
  name: string
  /** 文件里写的原始文本 */
  raw: string
  suffix?: string
  /** 改的是键还是值 —— 重命名时决定改哪个 token */
  slot: 'key' | 'value'
  root: number
  file: string
  line: number
  /** 键路径,如 ['scripted_gui','usa_congress_decision_ui','properties'] */
  path: string[]
  /** 所属上下文名(scripted_gui 名 / inlay window 名 / gui 元素名) */
  ctx: string
  /** properties 里的覆盖值 —— 拖拽联动的关键 */
  override?: { x?: string; y?: string; frame?: string; image?: string }
  /** 覆盖值里出现的变量/作用域名,如 owner:state_of_interest_icon_x?40 → ['owner','state_of_interest_icon_x'] */
  vars?: string[]
}

export interface LinkGraph {
  roots: LinkRoot[]
  defs: SymDef[]
  refs: SymRef[]
  defIndex: Map<string, SymDef[]>
  refIndex: Map<string, SymRef[]>
  dangling: SymRef[]
  stats: {
    files: number
    defs: number
    refs: number
    dangling: number
    byKind: Record<string, number>
    ms: number
  }
}

/**
 * effects / triggers / ai_weights 的键形如 `元素名_click_enabled`。
 * 后缀由固定词表用下划线拼成,而不是任意字符串 —— 否则 `a` 会被误判成
 * `a_b_c` 的前缀,产生一堆假引用。
 *
 * 词表依据官方 scripted_guis/_documentation.md:「you can add right, alt, control and shift」,
 * 实测还出现 double / over / tooltip 等。
 */
const SUFFIX_RE =
  /^(?:_(?:click|right|middle|left|alt|control|ctrl|shift|double|enabled|visible|over|down|up|hover|tooltip|drag|move|enter|leave|scroll))+$/

export function symKey(kind: SymKind, name: string): string {
  return `${kind}:${name}`
}

/* ── 遍历辅助 ── */

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    const p = join(dir, n)
    try {
      const st = statSync(p)
      if (st.isDirectory()) walk(p, exts, out)
      else if (exts.some((e) => n.toLowerCase().endsWith(e))) out.push(p)
    } catch {
      /* 跳过无权限/坏链接 */
    }
  }
  return out
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  }
  return undefined
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  const e = childEntry(doc, b, key)
  return e ? valueText(doc, e) : undefined
}

function childEntry(doc: Document, b: Block, key: string): Entry | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && !e.block) return e
  }
  return undefined
}

/* ── 构建 ── */

export interface BuildOptions {
  /** 是否把 .gfx sprite 也纳入(会多扫一批文件) */
  sprites?: boolean
  /** 是否扫 national_focus(文件较多) */
  focus?: boolean
  onProgress?: (msg: string) => void
}

export function buildLinkGraph(roots: LinkRoot[], opts: BuildOptions = {}): LinkGraph {
  const t0 = Date.now()
  const defs: SymDef[] = []
  const refs: SymRef[] = []
  let files = 0

  const rel = (root: number, abs: string): string => relative(roots[root].path, abs).replace(/\\/g, '/')

  /* ── 定义:interface/*.gui 元素 + .gfx sprite ── */
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'interface'), ['.gui', '.gfx'])) {
      if (!abs.toLowerCase().endsWith('.gui')) continue
      files++
      const src = readFileSync(abs, 'utf8')
      const doc = parse(src)
      const file = rel(ri, abs)
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block || k.toLowerCase() !== 'guitypes') continue
        collectGuiElements(doc, e.block, [k], ri, file, defs)
      }
      // @变量:.gui 顶部常见的 `@lon_we_1_icon_x = 20`。
      // 元素的坐标常被 scripted_gui 绑到这类变量上,拖拽时得顺着它溯源。
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !k.startsWith('@') || e.block) continue
        defs.push({
          kind: 'gui_var',
          name: k.slice(1),
          root: ri,
          file,
          line: lineOf(doc, e),
          detail: valueText(doc, e),
          path: [k],
        })
      }
      // spriteType 引用(关闭 sprites 时一并跳过,否则悬空统计全是假警报)
      if (opts.sprites !== false) {
        for (const e of doc.root.entries) {
          if (!e.block) continue
          const k = keyText(doc, e) ?? '?'
          collectSpriteRefs(doc, e.block, [k], ri, file, '', refs)
        }
      }
    }
  })

  if (opts.sprites !== false) {
    roots.forEach((r, ri) => {
      for (const abs of walk(join(r.path, 'interface'), ['.gfx'])) {
        files++
        const doc = parse(readFileSync(abs, 'utf8'))
        const file = rel(ri, abs)
        // 结构通常是 spriteTypes > spriteType > { name = ... },
        // 必须递归 —— 只看根级子块会一条都收不到(第一版就交了 0 条的白卷)。
        collectGfxDefs(doc, doc.root, [], ri, file, defs)
      }
    })
  }

  /* ── 定义 + 引用:scripted_guis ── */
  // 元素名集合用于 effects/triggers 键的后缀消歧(见 splitSuffix)
  const guiNames = new Set<string>()
  for (const d of defs) if (d.kind === 'gui_element') guiNames.add(d.name)
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'scripted_guis'), ['.txt'])) {
      files++
      const doc = parse(readFileSync(abs, 'utf8'))
      const file = rel(ri, abs)
      const top = childBlock(doc, doc.root, 'scripted_gui')
      if (!top) continue
      for (const e of top.entries) {
        const gname = keyText(doc, e)
        if (!gname || !e.block) continue
        defs.push({
          kind: 'scripted_gui',
          name: gname,
          root: ri,
          file,
          line: lineOf(doc, e),
          path: ['scripted_gui', gname],
        })
        collectScriptedGuiRefs(doc, e.block, ['scripted_gui', gname], gname, ri, file, refs, guiNames)
      }
    }
  })

  /* ── 定义 + 引用:focus_inlay_windows ── */
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'focus_inlay_windows'), ['.txt'])) {
      files++
      const doc = parse(readFileSync(abs, 'utf8'))
      const file = rel(ri, abs)
      for (const e of doc.root.entries) {
        const iname = keyText(doc, e)
        if (!iname || !e.block) continue
        defs.push({ kind: 'inlay_window', name: iname, root: ri, file, line: lineOf(doc, e), path: [iname] })
        // window_name 的行号必须记它自己那一行,不能记定义块的行号。
        // 记错的话重命名时"行号漂移"检查会把它全部跳过(inlay window 一次全灭)。
        const wnEntry = childEntry(doc, e.block, 'window_name')
        const wn = wnEntry ? valueText(doc, wnEntry) : undefined
        if (wn && wnEntry) {
          refs.push({
            kind: 'window_name',
            target: 'gui_element',
            name: wn,
            raw: wn,
            slot: 'value',
            root: ri,
            file,
            line: lineOf(doc, wnEntry),
            path: [iname, 'window_name'],
            ctx: iname,
          })
        }
        for (const sub of ['scripted_images', 'scripted_buttons', 'scripted_progressbars']) {
          const b = childBlock(doc, e.block, sub)
          if (!b) continue
          for (const c of b.entries) {
            const cn = keyText(doc, c)
            if (!cn) continue
            refs.push({
              kind: 'inlay_child',
              target: 'gui_element',
              name: cn,
              raw: cn,
              slot: 'key',
              root: ri,
              file,
              line: lineOf(doc, c),
              path: [iname, sub, cn],
              ctx: iname,
            })
          }
        }
      }
    }
  })

  /* ── 引用:decisions/categories → scripted_gui ── */
  for (const sub of ['decisions', 'scripted_diplomatic_actions', 'diplomatic_actions']) {
    roots.forEach((r, ri) => {
      for (const abs of walk(join(r.path, 'common', sub), ['.txt'])) {
        const doc = parse(readFileSync(abs, 'utf8'))
        const file = rel(ri, abs)
        scanSimpleKey(doc, doc.root, [], 'scripted_gui', (v, e, path) => {
          refs.push({
            kind: 'scripted_gui_use',
            target: 'scripted_gui',
            name: v,
            raw: v,
            slot: 'value',
            root: ri,
            file,
            line: lineOf(doc, e),
            path,
            ctx: path[path.length - 2] ?? '',
          })
        })
      }
    })
  }

  /* ── 引用:national_focus → inlay_window ── */
  if (opts.focus !== false) {
    roots.forEach((r, ri) => {
      for (const abs of walk(join(r.path, 'common', 'national_focus'), ['.txt'])) {
        const doc = parse(readFileSync(abs, 'utf8'))
        const file = rel(ri, abs)
        scanInlayWindows(doc, doc.root, [], ri, file, refs)
      }
    })
  }

  /* ── 索引 + 悬空判定 ── */
  const defIndex = new Map<string, SymDef[]>()
  for (const d of defs) {
    const k = symKey(d.kind, d.name)
    const arr = defIndex.get(k)
    if (arr) arr.push(d)
    else defIndex.set(k, [d])
  }

  // 同名定义以"更靠后的 root"为准(模组覆盖本体),但全部保留以便跳转
  const refIndex = new Map<string, SymRef[]>()
  const dangling: SymRef[] = []
  const byKind: Record<string, number> = {}
  for (const r of refs) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    const exact = defIndex.has(symKey(r.target, r.name))
    if (!exact) dangling.push(r)
    const k = symKey(r.target, r.name)
    const arr = refIndex.get(k)
    if (arr) arr.push(r)
    else refIndex.set(k, [r])
  }

  return {
    roots,
    defs,
    refs,
    defIndex,
    refIndex,
    dangling,
    stats: {
      files,
      defs: defs.length,
      refs: refs.length,
      dangling: dangling.length,
      byKind,
      ms: Date.now() - t0,
    },
  }
}

/** .gfx 递归收集所有带 name 的块(spriteType / progressbartype / corneredtiletype …) */
function collectGfxDefs(
  doc: Document,
  b: Block,
  path: string[],
  root: number,
  file: string,
  defs: SymDef[],
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k || !e.block) continue
    const nm = childValue(doc, e.block, 'name')
    if (nm) {
      defs.push({
        kind: 'gfx_sprite',
        name: nm,
        root,
        file,
        line: lineOf(doc, e),
        path: [...path, k],
      })
    }
    collectGfxDefs(doc, e.block, [...path, k], root, file, defs)
  }
}

/** 从 `owner:state_of_interest_icon_x?40` 这类表达式里抽出标识符,用于溯源 */
const VAR_SKIP = new Set(['var', 'global', 'owner', 'state', 'country', 'root', 'prev', 'from', 'yes', 'no'])
function extractVars(expr: string): string[] | undefined {
  if (!expr) return undefined
  const out = new Set<string>()
  for (const m of expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0]
    if (w.length < 3 || VAR_SKIP.has(w.toLowerCase())) continue
    out.add(w)
  }
  return out.size ? [...out] : undefined
}

/** 递归收集 guiTypes 下所有带 name 的块(不限元素类型,避免漏掉新增类型) */
function collectGuiElements(
  doc: Document,
  b: Block,
  path: string[],
  root: number,
  file: string,
  defs: SymDef[],
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k || !e.block) continue
    const nm = childValue(doc, e.block, 'name')
    if (nm) {
      defs.push({
        kind: 'gui_element',
        name: nm,
        root,
        file,
        line: lineOf(doc, e),
        detail: k,
        path: [...path, k],
      })
    }
    // 子元素也要登记:properties 引用的往往是深层 icon
    collectGuiElements(doc, e.block, [...path, k], root, file, defs)
  }
}

/** .gui 里的 spriteType / background.spriteType → gfx_sprite */
function collectSpriteRefs(
  doc: Document,
  b: Block,
  path: string[],
  root: number,
  file: string,
  ctx: string,
  refs: SymRef[],
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const lk = k.toLowerCase()
    if ((lk === 'spritetype' || lk === 'sprite') && !e.block) {
      const v = valueText(doc, e)
      if (!v || v.startsWith('GFX_') === false) {
        // GFX_ 前缀的常见,但也有裸名;一律收录,悬空判定由索引负责
      }
      if (v) {
        refs.push({
          kind: 'sprite',
          target: 'gfx_sprite',
          name: v,
          raw: v,
          slot: 'value',
          root,
          file,
          line: lineOf(doc, e),
          path: [...path, k],
          ctx,
        })
      }
      continue
    }
    if (e.block) {
      const nm = !path.length ? (childValue(doc, e.block, 'name') ?? ctx) : ctx
      collectSpriteRefs(doc, e.block, [...path, k], root, file, nm, refs)
    }
  }
}

function collectScriptedGuiRefs(
  doc: Document,
  b: Block,
  path: string[],
  guiName: string,
  root: number,
  file: string,
  refs: SymRef[],
  guiNames?: Set<string>,
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const lk = k.toLowerCase()

    // window_name / parent_window_name / parent_window_window / parent_scripted_gui
    if (
      (lk === 'window_name' || lk === 'parent_window_name' || lk === 'parent_window_window') &&
      !e.block
    ) {
      const v = valueText(doc, e)
      if (v) {
        refs.push({
          kind: lk === 'window_name' ? 'window_name' : 'parent_window',
          target: 'gui_element',
          name: v,
          raw: v,
          slot: 'value',
          root,
          file,
          line: lineOf(doc, e),
          path: [...path, k],
          ctx: guiName,
        })
      }
      continue
    }
    if (lk === 'parent_scripted_gui' && !e.block) {
      const v = valueText(doc, e)
      if (v) {
        refs.push({
          kind: 'parent_scripted_gui',
          target: 'scripted_gui',
          name: v,
          raw: v,
          slot: 'value',
          root,
          file,
          line: lineOf(doc, e),
          path: [...path, k],
          ctx: guiName,
        })
      }
      continue
    }

    // properties.<元素名> = { image/frame/x/y }
    if (lk === 'properties' && e.block) {
      for (const c of e.block.entries) {
        const cn = keyText(doc, c)
        if (!cn) continue
        const ov = c.block
          ? {
              x: childValue(doc, c.block, 'x'),
              y: childValue(doc, c.block, 'y'),
              frame: childValue(doc, c.block, 'frame'),
              image: childValue(doc, c.block, 'image'),
            }
          : undefined
        const hasXY = !!(ov?.x !== undefined || ov?.y !== undefined)
        refs.push({
          kind: hasXY ? 'property_xy' : 'property',
          target: 'gui_element',
          name: cn,
          raw: cn,
          slot: 'key',
          root,
          file,
          line: lineOf(doc, c),
          path: [...path, k, cn],
          ctx: guiName,
          override: ov && (ov.x !== undefined || ov.y !== undefined || ov.frame || ov.image) ? ov : undefined,
          vars: extractVars([ov?.x, ov?.y].filter(Boolean).join(' ')),
        })
      }
      continue
    }

    // effects / triggers / ai_weights / dynamic_lists:<元素名>[_后缀]
    if ((lk === 'effects' || lk === 'triggers' || lk === 'ai_weights' || lk === 'dynamic_lists') && e.block) {
      const kind: RefKind =
        lk === 'effects' ? 'effect' : lk === 'triggers' ? 'trigger' : lk === 'ai_weights' ? 'ai_weight' : 'dynamic_list'
      for (const c of e.block.entries) {
        const cn = keyText(doc, c)
        if (!cn) continue
        const split = splitSuffix(cn, guiNames)
        refs.push({
          kind,
          target: 'gui_element',
          name: split.base,
          raw: cn,
          suffix: split.suffix || undefined,
          slot: 'key',
          root,
          file,
          line: lineOf(doc, c),
          path: [...path, k, cn],
          ctx: guiName,
        })
        // entry_container 有 country_scope_ / state_scope_ 变体,path 必须记真实的键名,
        // 行号也要记它自己那一行 —— 记父块的行号会让重命名时的漂移检查把它整批跳过。
        const ecKey = ['entry_container', 'country_scope_entry_container', 'state_scope_entry_container'].find(
          (kk) => !!childEntry(doc, c.block, kk),
        )
        const ecEntry = ecKey ? childEntry(doc, c.block, ecKey) : undefined
        if (ecKey && ecEntry) {
          const ec = valueText(doc, ecEntry)
          if (ec) {
            refs.push({
              kind: 'entry_container',
              target: 'gui_element',
              name: ec,
              raw: ec,
              slot: 'value',
              root,
              file,
              line: lineOf(doc, ecEntry),
              path: [...path, k, cn, ecKey],
              ctx: guiName,
            })
          }
        }
      }
      continue
    }
  }
}

/**
 * 拆 `button_name_click_enabled` → { base, suffix }。
 *
 * 难点:元素名本身可以带下划线(tab_1),后缀也是下划线拼的(_click_enabled)。
 * 纯靠词表从右往左贪心会切成 { tab_1_click, _enabled } —— 于是明明存在的
 * `tab_1` 被判成悬空(KR 的 intro_screen.gui 就是这样,一次误报 100+ 条)。
 *
 * 所以改成两步:先枚举所有"合法后缀"切分,优先选 base 在已知元素名集合里的那个;
 * 一个都不认识时才退化为最长后缀。
 */
export function splitSuffix(raw: string, known?: Set<string>): { base: string; suffix: string } {
  const cuts: { base: string; suffix: string }[] = []
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] !== '_') continue
    const suffix = raw.slice(i)
    if (SUFFIX_RE.test(suffix)) cuts.push({ base: raw.slice(0, i), suffix })
  }
  if (!cuts.length) return { base: raw, suffix: '' }
  if (known) {
    // cuts 是从右往左生成的,suffix 由短到长;命中集合即采用
    const hit = cuts.find((c) => known.has(c.base))
    if (hit) return hit
  }
  return cuts[cuts.length - 1]
}

/** 递归找 key === target 的简单值 entry */
function scanSimpleKey(
  doc: Document,
  b: Block,
  path: string[],
  target: string,
  cb: (v: string, e: Entry, path: string[]) => void,
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const p = [...path, k]
    if (k.toLowerCase() === target.toLowerCase() && !e.block && e.value >= 0) {
      const v = valueText(doc, e)
      if (v !== undefined) cb(v, e, p)
    }
    if (e.block) scanSimpleKey(doc, e.block, p, target, cb)
  }
}

function scanInlayWindows(
  doc: Document,
  b: Block,
  path: string[],
  root: number,
  file: string,
  refs: SymRef[],
): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (k.toLowerCase() === 'inlay_window' && e.block) {
      const id = childValue(doc, e.block, 'id')
      if (id) {
        refs.push({
          kind: 'inlay_use',
          target: 'inlay_window',
          name: id,
          raw: id,
          slot: 'value',
          root,
          file,
          line: lineOf(doc, e),
          path: [...path, k, 'id'],
          ctx: path[path.length - 1] ?? '',
        })
      }
      continue
    }
    if (e.block) scanInlayWindows(doc, e.block, [...path, k], root, file, refs)
  }
}

/* ── 查询 ── */

/** 某个符号被谁引用了 */
export function refsOf(graph: LinkGraph, kind: SymKind, name: string): SymRef[] {
  return graph.refIndex.get(symKey(kind, name)) ?? []
}

/** 某个符号的定义在哪(模组覆盖本体时可能有多处) */
export function defsOf(graph: LinkGraph, kind: SymKind, name: string): SymDef[] {
  return graph.defIndex.get(symKey(kind, name)) ?? []
}

/** 元素是否被 scripted_gui 的 properties 覆盖了位置 —— 拖拽不生效的元凶 */
export function positionOverrides(graph: LinkGraph, name: string): SymRef[] {
  return refsOf(graph, 'gui_element', name).filter((r) => r.override?.x !== undefined || r.override?.y !== undefined)
}

export function readFile(root: LinkRoot, file: string): string {
  return readFileSync(join(root.path, file), 'utf8')
}

export function absPath(root: LinkRoot, file: string): string {
  return join(root.path, file)
}
