/**
 * 符号注册表 —— LSP 补全/跳转 与 Web 补全 共用的"全局符号库"。
 *
 * 数据来源(全部基于已有的无损解析,零额外规则):
 *   - common-index:common/ 全部目录的定义(id → 位置)
 *   - loc.ts:localisation 的本地化键
 *   - interface/*.gfx:spriteType 的 name(图标)
 *   - links.ts(可选):gui_element / scripted_gui / inlay_window
 *
 * 这是本项目相对 CWTools 的差异点:CWTools 靠手写 rules 才能补全/跳转,
 * 我们用数据驱动的 common 索引 + 跨域链接图自动获得同样能力,且覆盖 95 个目录。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import { buildCommonIndex, type RootSpec } from './common-index.ts'
import { parseLocYml, buildLocIndex } from './loc.ts'
import { OFFICIAL_ALL, type OfficialType } from './official-docs.ts'

export interface SymbolDef {
  kind: string
  name: string
  file: string
  line: number
  root: number
  /** 该符号所属来源(模组)名,用于补全时显示"出处" */
  rootName?: string
}

export interface SymbolRef {
  target: string
  name: string
  file: string
  line: number
  ctx?: string
  root?: number
}

export interface CompletionItem {
  label: string
  kind: string
  detail: string
  /** 出处:官方文档 / 具体文件(含来源名) */
  source: string
}

/** 作用域 → 包含的 kind。common 是"除下列特例外的所有 common 定义"。 */
const SCOPED_KINDS: Record<string, string[]> = {
  official: ['official'],
  scripted_effect: ['scripted_effect'],
  scripted_trigger: ['scripted_trigger'],
  loc: ['loc_key'],
  gfx: ['gfx_sprite'],
  gui: ['gui_element', 'scripted_gui', 'inlay_window'],
}
const SPECIAL_KINDS = new Set(Object.values(SCOPED_KINDS).flat())
/** kind → 所属作用域(特例之外的都归 common) */
function kindToScope(kind: string): string {
  for (const [s, ks] of Object.entries(SCOPED_KINDS)) if (ks.includes(kind)) return s
  return 'common'
}

const OFFICIAL_TYPE_LABEL: Record<OfficialType, string> = {
  effect: 'effect',
  trigger: 'trigger',
  scope: 'scope',
  modifier: 'modifier',
  other: 'other',
}

function walkDir(dir: string, exts: string[]): string[] {
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
    if (st.isDirectory()) out.push(...walkDir(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

export class SymbolRegistry {
  private byName = new Map<string, SymbolDef[]>()
  private byKey = new Map<string, SymbolDef[]>()
  private refs: SymbolRef[] = []
  private refIndex = new Map<string, SymbolRef[]>()
  stats = { files: 0, defs: 0, refs: 0, built: false }

  private addDef(d: SymbolDef): void {
    // 同 (kind,name,file) 去重,避免 gfx 递归重复登记
    const exist = this.byKey.get(`${d.kind}:${d.name}`)
    if (exist?.some((x) => x.file === d.file && x.line === d.line)) return
    let arr = this.byName.get(d.name)
    if (!arr) {
      arr = []
      this.byName.set(d.name, arr)
    }
    arr.push(d)
    const k = `${d.kind}:${d.name}`
    let ka = this.byKey.get(k)
    if (!ka) {
      ka = []
      this.byKey.set(k, ka)
    }
    ka.push(d)
  }

  /** 官方文档关键字(effect/trigger/scope),来源统一为"官方文档" */
  private official: CompletionItem[] = []

  private addRef(r: SymbolRef): void {
    this.refs.push(r)
    const k = `${r.target}:${r.name}`
    let arr = this.refIndex.get(k)
    if (!arr) {
      arr = []
      this.refIndex.set(k, arr)
    }
    arr.push(r)
  }

  /** 构建 common + loc + gfx 索引(快速,不含 link graph) */
  buildFast(rootSpecs: RootSpec[]): void {
    const rootNames = rootSpecs.map((r) => r.name)
    // common 定义
    const idx = buildCommonIndex(rootSpecs, { exts: ['.txt'] })
    for (const d of idx.defs) {
      this.addDef({ kind: d.kind, name: d.id, file: d.file, line: d.line, root: d.root, rootName: rootNames[d.root] })
    }
    for (const r of idx.refs) {
      this.addRef({ target: r.target, name: r.name, file: r.file, line: r.line, ctx: r.owner, root: r.root ?? 0 })
    }

    // 本地化键
    const locResults = []
    for (let ri = 0; ri < rootSpecs.length; ri++) {
      const locDir = join(rootSpecs[ri].path, 'localisation')
      for (const abs of walkDir(locDir, ['.yml', '.yaml'])) {
        const file = relative(rootSpecs[ri].path, abs).replace(/\\/g, '/')
        try {
          const r = parseLocYml(readFileSync(abs, 'utf8'), file)
          locResults.push(r)
        } catch {
          /* 跳过坏文件 */
        }
      }
    }
    if (locResults.length) {
      const li = buildLocIndex(locResults)
      for (const [keyId, entries] of li.keyToFile) {
        const lang = keyId.split(':')[0]
        const key = keyId.split(':')[1]
        const first = entries.values().next().value as string
        this.addDef({ kind: 'loc_key', name: key, file: first, line: 1, root: 0 })
        void lang
      }
    }

    // gfx 精灵名(interface/*.gfx)
    for (let ri = 0; ri < rootSpecs.length; ri++) {
      const ifaceDir = join(rootSpecs[ri].path, 'interface')
      for (const abs of walkDir(ifaceDir, ['.gfx'])) {
        const file = relative(rootSpecs[ri].path, abs).replace(/\\/g, '/')
        try {
          const doc = parse(readFileSync(abs, 'utf8'))
          this.scanGfxNames(doc.root, doc, file, ri, rootNames[ri])
        } catch {
          /* 跳过 */
        }
      }
    }

    // 官方文档关键字(effect/trigger/scope/modifier,2836 条全量)
    // detail 里带上【作用域】—— 官方手册明确标注的适用作用域,是模组作者
    // 判断"这个 effect 能不能在这里用"的最直接依据(游戏对作用域不符的
    // effect 静默忽略,不报错,只能靠文档避免)。
    this.official = OFFICIAL_ALL.map((e) => {
      const sc = e.scopes && e.scopes.length ? e.scopes.join('/') : ''
      const detail = sc
        ? `${OFFICIAL_TYPE_LABEL[e.type]} · 作用域 ${sc} · ${e.summary}`
        : `${OFFICIAL_TYPE_LABEL[e.type]} · ${e.summary}`
      return { label: e.name, kind: 'official', detail, source: '官方文档' }
    })

    this.stats.files = idx.stats.files + locResults.length
    this.stats.defs = this.byName.size
    this.stats.refs = this.refs.length
    this.stats.built = true
  }

  private scanGfxNames(b: import('../../parser/src/ast.ts').Block, doc: import('../../parser/src/ast.ts').Document, file: string, ri: number, rootName?: string): void {
    for (const e of b.entries) {
      const k = keyText(doc, e)?.toLowerCase()
      if (k === 'spritetype' || k === 'sprite') {
        if (e.value >= 0) {
          const v = valueText(doc, e)
          if (v) this.addDef({ kind: 'gfx_sprite', name: v, file, line: 1, root: ri, rootName })
        } else if (e.block) {
          const c = this.childName(doc, e.block)
          if (c) this.addDef({ kind: 'gfx_sprite', name: c, file, line: 1, root: ri, rootName })
        }
      } else if (e.block) {
        const c = this.childName(doc, e.block)
        if (c) this.addDef({ kind: 'gfx_sprite', name: c, file, line: 1, root: ri, rootName })
      }
      if (e.block) this.scanGfxNames(e.block, doc, file, ri, rootName)
    }
  }

  private childName(doc: import('../../parser/src/ast.ts').Document, b: import('../../parser/src/ast.ts').Block): string | undefined {
    for (const e of b.entries) {
      if (keyText(doc, e)?.toLowerCase() === 'name' && e.value >= 0) return valueText(doc, e)
    }
    return undefined
  }

  /** 合并 link graph(gui_element / scripted_gui / inlay_window) */
  mergeLinkGraph(g: {
    defs: { kind: string; name: string; root: number; file: string; line: number }[]
    refs: { target: string; name: string; file: string; line: number; ctx?: string }[]
  }): void {
    for (const d of g.defs) {
      if (d.kind === 'gui_element' || d.kind === 'scripted_gui' || d.kind === 'inlay_window') {
        this.addDef({ kind: d.kind, name: d.name, file: d.file, line: d.line, root: d.root })
      }
    }
    for (const r of g.refs) this.addRef({ target: r.target, name: r.name, file: r.file, line: r.line, ctx: r.ctx, root: r.root })
  }

  /** 查找某符号的定义位置(自动判别种类) */
  definition(name: string): SymbolDef[] {
    if (!name) return []
    // 精确 byKey:gfx / loc / gui
    const exact = this.byKey.get(`gfx_sprite:${name}`) ??
      this.byKey.get(`loc_key:${name}`) ??
      this.byKey.get(`gui_element:${name}`) ??
      this.byKey.get(`scripted_gui:${name}`) ??
      this.byKey.get(`inlay_window:${name}`)
    if (exact) return exact
    // 否则按名字搜所有 common 定义
    return this.byName.get(name) ?? []
  }

  references(name: string): SymbolRef[] {
    if (!name) return []
    const k =
      this.byKey.has(`gfx_sprite:${name}`)
        ? `gfx_sprite:${name}`
        : this.byKey.has(`loc_key:${name}`)
          ? `loc_key:${name}`
          : this.byKey.has(`gui_element:${name}`)
            ? `gui_element:${name}`
            : this.byKey.has(`scripted_gui:${name}`)
              ? `scripted_gui:${name}`
              : this.byKey.has(`inlay_window:${name}`)
                ? `inlay_window:${name}`
                : ''
    if (k) return this.refIndex.get(k) ?? []
    // 通用:名字匹配
    return this.refs.filter((r) => r.name === name)
  }

  /**
   * 补全:按已输入前缀 + 作用域过滤,返回有限候选项。
   * @param scopes 允许的作用域集合(见 SCOPED_KINDS 的键)。为空/未给 = 全部。
   * @param limit  最大返回条数
   */
  completions(prefix: string, scopes?: string[], limit = 200): CompletionItem[] {
    const p = (prefix || '').toLowerCase()
    const scopeSet = scopes && scopes.length ? new Set(scopes) : null
    const inScope = (kind: string): boolean => {
      if (!scopeSet) return true
      return scopeSet.has(kindToScope(kind))
    }
    const out: CompletionItem[] = []
    const seen = new Set<string>()

    // 1) 官方文档关键字
    if (!scopeSet || scopeSet.has('official')) {
      for (const o of this.official) {
        if (p && !o.label.toLowerCase().startsWith(p)) continue
        if (seen.has(o.label)) continue
        seen.add(o.label)
        out.push(o)
      }
    }

    // 2) 数据驱动的符号(common / scripted_* / loc / gfx / gui)
    for (const [name, defs] of this.byName) {
      if (p && !name.toLowerCase().startsWith(p)) continue
      if (seen.has(name)) continue
      // 作用域过滤:取该名字下任一枚符合作用域的定义
      const hit = defs.find((d) => inScope(d.kind))
      if (!hit) continue
      seen.add(name)
      const src = hit.rootName ? `${hit.rootName}:${hit.file}:${hit.line}` : `${hit.file}:${hit.line}`
      out.push({
        label: name,
        kind: hit.kind,
        detail: `${hit.kind} · ${hit.file}:${hit.line}`,
        source: src,
      })
      if (out.length >= limit) break
    }
    // 排序:GFX_ 优先,其余按名字
    out.sort((a, b) => {
      const ga = a.label.startsWith('GFX_') ? 0 : 1
      const gb = b.label.startsWith('GFX_') ? 0 : 1
      return ga - gb || a.label.localeCompare(b.label)
    })
    return out.slice(0, limit)
  }
}
