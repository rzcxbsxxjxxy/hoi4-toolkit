/* ══════════════════════════════════════════════════════════════════
 * 官方文档 / common 文档 的解析与索引
 *
 * 【实时】是这两个功能的硬要求:不做预生成快照,每次请求都从磁盘现读现解析。
 * 文档文件很少(vanilla 11 + common 39),最大的 effects_documentation.md 也只有
 * 240KB,解析一次几毫秒 —— 缓存只会带来"改了文件看不到"的困惑,得不偿失。
 * 唯一缓存的是"哪些文件存在"的扫描结果,且带 mtime 校验,文件一改立即失效。
 *
 * 两类文档形态完全不同,不要试图用一套解析器硬套:
 *
 *   1) <root>/documentation/*.md —— 条目式参考手册
 *        # Effects
 *        ## Table of Content
 *        * [CHARACTER](#effects-for-scope-character)
 *        ## Effects for scope CHARACTER      ← 类别(category)
 *        * [add_attack](#add_attack)
 *        ## add_attack                        ← 条目(entry)
 *        * Supported Scopes: CHARACTER
 *        * Supported Targets: none
 *        ```
 *        Adds attack skill to a character
 *        Example: add_attack = 1
 *        ```
 *
 *   2) <root>/common/<子目录>/_documentation.md —— 散文式说明
 *        没有条目结构,就是普通 markdown。用户明确要求【按文件夹索引】,
 *        所以左侧树的第一层是 common/ 下的目录路径。
 * ══════════════════════════════════════════════════════════════════ */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'

/* ─────────────────────────── 类型 ─────────────────────────── */

export interface DocFile {
  /** 稳定 id:`rootIdx:relPath`,前端直接拿它请求 */
  id: string
  rootIdx: number
  rootName: string
  /** 相对该 root 的路径(统一用 / ) */
  rel: string
  /** 显示名(去掉 _documentation 前缀) */
  name: string
  /** 一级标题 */
  title: string
  /** 所属分类:official = 手册名;common = common/ 下的目录路径 */
  group: string
  size: number
  mtime: number
  /** 同名的 .html 是否存在(官方手册 md/html 成对发布) */
  hasHtml: boolean
}

export interface DocEntry {
  id: string
  name: string
  /** `* Supported Scopes:` 的值 */
  scopes: string
  /** `* Supported Targets:` 的值 */
  targets: string
  /** 正文(原始 markdown) */
  body: string
}

export interface DocCategory {
  id: string
  /** 类别显示名,如 "Effects for scope CHARACTER" */
  name: string
  /** scope 值,如 CHARACTER;非 scope 类别为空 */
  scope: string
  entries: DocEntry[]
}

export interface OfficialDoc {
  file: DocFile
  title: string
  /** 一级标题下的引言 */
  intro: string
  categories: DocCategory[]
  /** 全部条目的扁平表,供搜索 */
  flat: DocEntry[]
}

export interface MdSection {
  id: string
  level: number
  title: string
  /** 该标题下的原始 markdown */
  body: string
}

export interface CommonDoc {
  file: DocFile
  title: string
  sections: MdSection[]
}

/* ─────────────────── 文件扫描(mtime 校验缓存) ─────────────────── */

interface DirStamp {
  mtime: number
  count: number
  files: DocFile[]
}
const scanCache = new Map<string, DirStamp>()

function walkMd(dir: string, out: string[] = []): string[] {
  let ents: any[]
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkMd(p, out)
    else if (extname(e.name).toLowerCase() === '.md') out.push(p)
  }
  return out
}

/** 目录指纹:直接子条目数与最新 mtime。任一变化就重扫。 */
function fingerprint(dir: string): { mtime: number; count: number } {
  let mtime = 0
  let count = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      count++
      if (e.isDirectory()) continue // 只看一层,深层改动由 dirStamp 的 count 兜不住,故再取顶层 md
      try { mtime = Math.max(mtime, statSync(join(dir, e.name)).mtimeMs) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { mtime, count }
}

/**
 * 一级标题。
 * ⚠ 有些 md 的第一个 `#` 是 ASCII 艺术字(special_projects_documentation.md 的
 *   标题行是 "#  # #   #  #  #  #  # #"),直接拿来当标题会显示成一堆井号。
 *   判据很朴素:含 # = * _ 或字母少于 3 个,就退回文件名美化版。
 */
function titleOf(src: string, fallback: string): string {
  const m = src.match(/^#\s+(.+?)\s*$/m)
  const raw = m ? m[1].trim() : ''
  const letters = (raw.match(/[A-Za-z一-龥]/g) ?? []).length
  if (!raw || /[#=*_|]/.test(raw) || letters < 3) return pretty(fallback)
  return raw
}

/** 文件名 → 可读名:`special_projects_documentation` → `Special Projects` */
function pretty(s: string): string {
  return s
    .replace(/\.md$/i, '')
    .replace(/^_+|_+$/g, '')
    .replace(/_?documentation$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * 扫描【官方文档】(<root>/documentation/*.md)。
 * 手册名从文件名推断:xxx_documentation.md → xxx。
 */
export function scanOfficial(roots: { path: string; name: string }[]): DocFile[] {
  const out: DocFile[] = []
  roots.forEach((r, i) => {
    const dir = join(r.path, 'documentation')
    if (!existsSync(dir)) return
    const fp = fingerprint(dir)
    const hit = scanCache.get('o:' + dir)
    if (hit && hit.mtime === fp.mtime && hit.count === fp.count) { out.push(...hit.files); return }
    const files: DocFile[] = []
    for (const abs of walkMd(dir)) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      let st: any
      try { st = statSync(abs) } catch { continue }
      let src = ''
      try { src = readFileSync(abs, 'utf8') } catch { continue }
      const base = basename(abs, '.md')
      const title = titleOf(src, base.replace(/_?documentation$/i, ''))
      files.push({
        id: `${i}:${rel}`,
        rootIdx: i,
        rootName: r.name,
        rel,
        name: title,
        title,
        group: r.name,
        size: st.size,
        mtime: st.mtimeMs,
        hasHtml: existsSync(abs.replace(/\.md$/i, '.html')),
      })
    }
    files.sort((a, b) => a.name.localeCompare(b.name))
    scanCache.set('o:' + dir, { mtime: fp.mtime, count: fp.count, files })
    out.push(...files)
  })
  return out
}

/**
 * 扫描【common 文档】(<root>/common/**\/*.md)。
 * ⚠ 用户要求【按文件夹索引】:group = common/ 下的相对目录(顶层就是 "." ),
 * 而不是按文件名排序 —— 因为同一个子系统(如 special_projects)下会有多个 md。
 */
export function scanCommon(roots: { path: string; name: string }[]): DocFile[] {
  const out: DocFile[] = []
  roots.forEach((r, i) => {
    const dir = join(r.path, 'common')
    if (!existsSync(dir)) return
    const fp = fingerprint(dir)
    const hit = scanCache.get('c:' + dir)
    if (hit && hit.mtime === fp.mtime && hit.count === fp.count) { out.push(...hit.files); return }
    const files: DocFile[] = []
    for (const abs of walkMd(dir)) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      let st: any
      try { st = statSync(abs) } catch { continue }
      let src = ''
      try { src = readFileSync(abs, 'utf8') } catch { continue }
      const title = titleOf(src, basename(abs, '.md').replace(/^_+|_+$/g, ''))
      const group = dirname(rel).replace(/\\/g, '/')
      files.push({
        id: `${i}:${rel}`,
        rootIdx: i,
        rootName: r.name,
        rel,
        name: title,
        title,
        group,
        size: st.size,
        mtime: st.mtimeMs,
        hasHtml: false,
      })
    }
    files.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    scanCache.set('c:' + dir, { mtime: fp.mtime, count: fp.count, files })
    out.push(...files)
  })
  return out
}

/* ─────────────────── 官方文档:条目式解析 ─────────────────── */

const CAT_RE = /^(.*?)\s+for scope\s+(\S+)\s*$/i

/** 把 `## ` 级别切成的块解析成 类别 → 条目 */
export function parseOfficial(src: string, file: DocFile): OfficialDoc {
  const lines = src.split(/\r?\n/)
  const title = titleOf(src, file.name)
  const cats: DocCategory[] = []
  const flat: DocEntry[] = []

  // 切块:记录【层级】。官方手册不统一 ——
  //   effects / triggers / modifiers : 类别 `##`、条目 `##`(同级,靠 TOC 归组)
  //   dynamic_variables             : 类别 `##`、条目 `###`
  // 所以条目层级要自适应:文件里出现 `###` 就用 3,否则用 2。
  interface Block { level: number; h: string; body: string[] }
  const blocks: Block[] = []
  let cur: Block | null = null
  const top: string[] = []
  for (const ln of lines) {
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (m) {
      cur = { level: m[1].length, h: m[2].trim(), body: [] }
      blocks.push(cur)
      continue
    }
    if (!cur) top.push(ln)
    else cur.body.push(ln)
  }
  const intro = top.join('\n').trim()
  /* ★ 条目层级不能靠"文件里有没有 ###"猜 —— effects 里恰好有 6 个 ###,
   *   猜成 3 就只剩 6 个条目(602 → 6)。正确做法:
   *   【用目录表点名的成员反推层级】—— 取成员名出现最多的那个层级。 */
  const isTOC = (b: Block) => /^table of content$/i.test(b.h)
  const bullets = (b: Block) =>
    [...b.body.join('\n').matchAll(/^\s*\*\s*\[([^\]]+)\]/gm)].map((x) => x[1].trim())

  const lvl2 = blocks.filter((b) => b.level === 2 && !isTOC(b))
  const scopeCats = lvl2.filter((b) => CAT_RE.test(b.h))
  const hasScope = scopeCats.length > 0
  const memberNames = new Set<string>(scopeCats.flatMap(bullets))

  let entryLevel = 2
  if (memberNames.size) {
    const cnt = new Map<number, number>()
    for (const b of blocks) if (memberNames.has(b.h)) cnt.set(b.level, (cnt.get(b.level) ?? 0) + 1)
    entryLevel = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2
  } else if (blocks.some((b) => b.level === 3)) {
    // 类别块里没有目录列表(dynamic_variables 就是:`## ... for scope X` 之后
    // 直接跟 `###` 条目),此时只能靠层级判断:有 `###` 就用 3。
    entryLevel = 3
  }

  const catSet = new Set(scopeCats.map((b) => b.h))
  /**
   * 抓 `* Supported Scopes: X`。
   * ⚠ 官方手册里该行【可能整行为空】(实测 effects 有 15 处,例如
   *   add_divisional_commander_xp 的原文就是 `* Supported Scopes: ` 后直接换行)。
   *   正则必须要求 X 非空白,否则 `\s*` 会跨行把下一行 `* Supported Targets: none`
   *   的 "none" 当成 scope 值 —— 实测污染 15 条,会产生"作用域=none"的脏数据。
   */
  const makeEntry = (b: Block): DocEntry => {
    const body = b.body.join('\n')
    return {
      id: slug(b.h),
      name: b.h,
      scopes: (body.match(/^\*\s*Supported Scopes:[ \t]*(\S.*?)[ \t]*$/im)?.[1] ?? '').trim(),
      targets: (body.match(/^\*\s*Supported Targets:[ \t]*(\S.*?)[ \t]*$/im)?.[1] ?? '').trim(),
      body: stripMeta(body).trim(),
    }
  }

  const entryByName = new Map<string, DocEntry>()
  for (const b of blocks) {
    if (isTOC(b)) continue
    // 有 scope 类别:条目在 entryLevel 层,且要排除类别标题自身
    if (hasScope) {
      if (b.level !== entryLevel || catSet.has(b.h)) continue
    } else if (b.level !== 2) continue
    entryByName.set(b.h, makeEntry(b))
  }

  if (!hasScope) {
    // 没有 scope 分类的手册(console_commands / loc_formatter / script_* 等):
    // 不做假分类,统一放在一个组里,按条目名排序方便查找。
    const list = [...entryByName.values()].sort((a, b) => a.name.localeCompare(b.name))
    cats.push({ id: 'all', name: '全部条目', scope: '', entries: list })
  } else if (!memberNames.size) {
    // 类别没有目录列表 → 按【出现位置】归组:条目归属它前面最近的那个类别标题。
    // 判据:dynamic_variables_documentation.md(375 个 `###` 条目分 6 个 scope)。
    const byName = new Map<string, DocEntry[]>()
    let curCat = ''
    const order: string[] = []
    for (const b of blocks) {
      if (isTOC(b)) continue
      if (b.level === 2 && catSet.has(b.h)) {
        curCat = b.h
        if (!byName.has(curCat)) { byName.set(curCat, []); order.push(curCat) }
        continue
      }
      if (b.level !== entryLevel) continue
      if (!curCat) continue
      byName.get(curCat)!.push(makeEntry(b))
    }
    for (const nm of order) {
      cats.push({ id: slug(nm), name: nm, scope: nm.match(CAT_RE)![2], entries: byName.get(nm)! })
    }
  } else {
    // ── 按目录表把条目挂到类别下 ──
    const claimed = new Set<string>()
    for (const c of scopeCats) {
      const list: DocEntry[] = []
      for (const nm of bullets(c)) {
        const e = entryByName.get(nm)
        if (!e) continue // 目录表点名但正文没有对应块(官方 TOC 有少量错链)
        list.push(e)
        claimed.add(nm)
      }
      cats.push({ id: slug(c.h), name: c.h, scope: c.h.match(CAT_RE)![2], entries: list })
    }
    // 目录表没点名的条目(官方 TOC 偶有遗漏)归到"其它"
    const rest = [...entryByName.values()].filter((e) => !claimed.has(e.name))
    if (rest.length) cats.push({ id: 'other', name: '其它 / 未归类', scope: '', entries: rest })
  }
  for (const c of cats) for (const e of c.entries) flat.push(e)

  return { file, title, intro, categories: cats, flat }
}

/** 去掉 Supported Scopes/Targets 两行,正文只留说明与示例 */
function stripMeta(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\*\s*Supported (Scopes|Targets):/i.test(l))
    .join('\n')
}

/* ─────────────────── common 文档:按标题切段 ─────────────────── */

export function parseCommon(src: string, file: DocFile): CommonDoc {
  const lines = src.split(/\r?\n/)
  const sections: MdSection[] = []
  let cur: MdSection | null = null
  for (const ln of lines) {
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (m) {
      if (cur) sections.push(cur)
      cur = { id: slug(m[2]), level: m[1].length, title: m[2], body: '' }
    } else if (cur) cur.body += ln + '\n'
    else if (ln.trim()) {
      if (!cur) cur = { id: 'top', level: 0, title: '', body: '' }
      cur.body += ln + '\n'
    }
  }
  if (cur) sections.push(cur)
  return { file, title: titleOf(src, file.name), sections }
}

/* ─────────────────── 极简 markdown → HTML ─────────────────── */

/**
 * 零依赖的够用版:标题 / 列表 / 围栏代码块 / 行内 code / 粗体 / 链接 / 表格分隔。
 * 官方手册里的"代码块"其实装的是说明文字与 Example,所以代码块原样输出。
 */
export function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)(https?:\/\/\S+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')

  const out: string[] = []
  const lines = md.split(/\r?\n/)
  let i = 0
  let inCode = false
  let listLevel = 0
  const closeList = () => { while (listLevel > 0) { out.push('</ul>'); listLevel-- } }

  while (i < lines.length) {
    const ln = lines[i]
    if (/^\s*```/.test(ln)) {
      closeList()
      if (!inCode) { out.push('<pre><code>'); inCode = true }
      else { out.push('</code></pre>'); inCode = false }
      i++
      continue
    }
    if (inCode) { out.push(esc(ln)); i++; continue }

    const h = ln.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (h) {
      closeList()
      const lv = Math.min(6, h[1].length)
      out.push(`<h${lv} id="${slug(h[2])}">${inline(h[2])}</h${lv}>`)
      i++
      continue
    }
    const li = ln.match(/^(\s*)[-*+]\s+(.*)$/)
    if (li) {
      const indent = Math.floor(li[1].replace(/\t/g, '  ').length / 2)
      while (listLevel < indent + 1) { out.push('<ul>'); listLevel++ }
      while (listLevel > indent + 1) { out.push('</ul>'); listLevel-- }
      out.push(`<li>${inline(li[2])}</li>`)
      i++
      continue
    }
    if (!ln.trim()) { closeList(); i++; continue }
    closeList()
    out.push(`<p>${inline(ln)}</p>`)
    i++
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('\n')
}

/* ─────────────────── 工具 ─────────────────── */

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^\w一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}

/** 只允许 <root>/documentation 与 <root>/common 下的 .md,防目录穿越 */
export function safeDocPath(rootPath: string, rel: string, kind: 'official' | 'common'): string | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (norm.includes('..')) return null
  if (!norm.toLowerCase().endsWith('.md')) return null
  const ok = kind === 'official'
    ? /^documentation\//i.test(norm)
    : /^common\//i.test(norm)
  if (!ok) return null
  const abs = join(rootPath, norm)
  return existsSync(abs) ? abs : null
}
