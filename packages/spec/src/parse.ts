/**
 * 官方 Markdown 文档 → 结构化规格库
 *
 * 支持三种文档体例:
 *   effects / triggers : `## name` + Supported Scopes/Targets + 示例代码块
 *   modifiers          : `## name` + Number with N decimal places + Categories
 *
 * 设计原则:
 *   1. 只做提取,不做猜测。缺字段就留空,允许上层用本地补丁覆盖。
 *   2. 章节标题(## Modifiers for scope xxx)必须剔除,否则会被当成条目。
 *   3. 支持 `<span id=".."></span><Building>_xxx` 这种带锚点与占位符的条目名。
 */

export type SpecKind = 'effect' | 'trigger' | 'modifier'

export interface SpecEntry {
  /** 条目名,已剥离 HTML 锚点 */
  name: string
  kind: SpecKind
  /** 支持的作用域,如 COUNTRY / STATE / CHARACTER */
  scopes: string[]
  /** 支持的 target,如 none / yes / no / state */
  targets: string[]
  /** 说明文字(effects/triggers) */
  description?: string
  /** 示例代码(effects/triggers) */
  example?: string
  /** 小数位(modifiers) */
  decimals?: number
  /** 分类标签(modifiers) */
  categories?: string[]
  /** 占位符,如 <Building> —— 表示这是模板型条目 */
  placeholders?: string[]
  /** 源文档与行号,便于溯源与打本地补丁 */
  source: { file: string; line: number }
}

export interface SpecDoc {
  kind: SpecKind
  file: string
  entries: SpecEntry[]
  /** 被识别为"章节标题"而非条目的行数,用于自检 */
  sectionHeaders: number
  /** 未能识别任何字段的可疑条目 */
  suspicious: string[]
}

/** 剥离 `<span id="x"></span>` 之类的 HTML 锚点 */
function stripAnchors(raw: string): string {
  return raw.replace(/<span[^>]*>\s*<\/span>/gi, '').trim()
}

/** 抽取 `<Building>` 这类占位符 */
function extractPlaceholders(name: string): string[] {
  const out: string[] = []
  for (const m of name.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>/g)) out.push(m[1])
  return out
}

/** 判断是否为"章节标题"(形如 `## Modifiers for scope country`) */
function isSectionHeader(title: string): boolean {
  return /\s(for\s+scope|scope)\s+/i.test(title) && !/^[^a-z]*$/i.test(title) && /\b(scope)\b/i.test(title) && title.split(/\s+/).length <= 6
}

function parseScopes(v: string): string[] {
  return v
    .split(/[,]/)
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'none')
}

function parseTargets(v: string): string[] {
  return v
    .split(/[,]/)
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'none')
}

/** 解析 effects / triggers 文档 */
function parseScriptDoc(src: string, kind: SpecKind, file: string): SpecDoc {
  const lines = src.split(/\r?\n/)
  const entries: SpecEntry[] = []
  const suspicious: string[] = []
  let sectionHeaders = 0

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const raw = m[1]
    const name = stripAnchors(raw)
    const startLine = i + 1

    if (isSectionHeader(name)) {
      sectionHeaders++
      i++
      continue
    }

    // 收集条目体:直到下一个 ## 或文件末尾
    let j = i + 1
    const body: string[] = []
    while (j < lines.length && !/^##\s+/.test(lines[j])) {
      body.push(lines[j])
      j++
    }

    const entry: SpecEntry = {
      name,
      kind,
      scopes: [],
      targets: [],
      placeholders: extractPlaceholders(name),
      source: { file, line: startLine },
    }

    let filled = false
    for (const b of body) {
      const sm = /^\*\s*Supported Scopes\s*:\s*(.+)$/i.exec(b)
      if (sm) {
        entry.scopes = parseScopes(sm[1])
        filled = true
        continue
      }
      const tm = /^\*\s*Supported Targets\s*:\s*(.+)$/i.exec(b)
      if (tm) {
        entry.targets = parseTargets(tm[1])
        filled = true
        continue
      }
    }

    // 代码块:优先 ``` 包裹
    const fence = /```[a-zA-Z]*\r?\n([\s\S]*?)```/.exec(body.join('\n'))
    if (fence) {
      const text = fence[1].replace(/\s+$/, '')
      // effects/triggers 文档里代码块通常既是描述又是示例
      entry.description = text
      // 含 `=` 视为示例
      if (/=/.test(text)) entry.example = text
      filled = true
    }

    if (!filled) suspicious.push(`${name} (${file}:${startLine})`)

    entries.push(entry)
    i = j
  }

  return { kind, file, entries, sectionHeaders, suspicious }
}

/** 解析 modifiers 文档 */
function parseModifierDoc(src: string, file: string): SpecDoc {
  const lines = src.split(/\r?\n/)
  const entries: SpecEntry[] = []
  const suspicious: string[] = []
  let sectionHeaders = 0

  let i = 0
  while (i < lines.length) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    const name = stripAnchors(m[1])
    const startLine = i + 1

    if (/^Modifiers for scope\s+/i.test(name)) {
      sectionHeaders++
      i++
      continue
    }

    let j = i + 1
    const body: string[] = []
    while (j < lines.length && !/^##\s+/.test(lines[j])) {
      body.push(lines[j])
      j++
    }

    const entry: SpecEntry = {
      name,
      kind: 'modifier',
      scopes: [],
      targets: [],
      placeholders: extractPlaceholders(name),
      source: { file, line: startLine },
    }

    let filled = false
    for (const b of body) {
      const dm = /^\*\s*Number with\s+(\d+)\s+decimal places/i.exec(b)
      if (dm) {
        entry.decimals = parseInt(dm[1], 10)
        filled = true
        continue
      }
      const cm = /^\*\s*\*\*Categories\*\*\s*:\s*(.+)$/i.exec(b)
      if (cm) {
        entry.categories = cm[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        filled = true
        continue
      }
    }

    if (!filled) suspicious.push(`${name} (${file}:${startLine})`)
    entries.push(entry)
    i = j
  }

  return { kind: 'modifier', file, entries, sectionHeaders, suspicious }
}

export function parseSpecFile(src: string, kind: SpecKind, file: string): SpecDoc {
  return kind === 'modifier' ? parseModifierDoc(src, file) : parseScriptDoc(src, kind, file)
}

/* ────────────────── 作用域倒排索引(补全的核心) ────────────────── */

export interface ScopeIndex {
  /** scope -> 该 scope 下可用的条目名 */
  byScope: Map<string, Set<string>>
  /** 条目名 -> 规格(可能多名重复,取首个) */
  byName: Map<string, SpecEntry>
  /** 所有出现过的 scope */
  scopes: string[]
}

export function buildScopeIndex(docs: SpecDoc[]): ScopeIndex {
  const byScope = new Map<string, Set<string>>()
  const byName = new Map<string, SpecEntry>()

  for (const doc of docs) {
    for (const e of doc.entries) {
      if (!byName.has(e.name)) byName.set(e.name, e)
      for (const s of e.scopes) {
        const set = byScope.get(s) ?? new Set<string>()
        set.add(e.name)
        byScope.set(s, set)
      }
    }
  }

  return {
    byScope,
    byName,
    scopes: [...byScope.keys()].sort(),
  }
}

/** 合并多个文档,输出统计摘要 */
export interface SpecStats {
  docs: { file: string; kind: SpecKind; entries: number; sections: number; suspicious: number }[]
  total: number
  byKind: Record<string, number>
  scopes: string[]
  /** scope -> 可用条目数(top N) */
  topScopes: [string, number][]
}

export function summarize(docs: SpecDoc[], index: ScopeIndex): SpecStats {
  const byKind: Record<string, number> = {}
  for (const d of docs) byKind[d.kind] = (byKind[d.kind] ?? 0) + d.entries.length
  const topScopes = [...index.byScope.entries()]
    .map(([s, v]) => [s, v.size] as [string, number])
    .sort((a, b) => b[1] - a[1])
  return {
    docs: docs.map((d) => ({
      file: d.file,
      kind: d.kind,
      entries: d.entries.length,
      sections: d.sectionHeaders,
      suspicious: d.suspicious.length,
    })),
    total: docs.reduce((n, d) => n + d.entries.length, 0),
    byKind,
    scopes: index.scopes,
    topScopes,
  }
}
