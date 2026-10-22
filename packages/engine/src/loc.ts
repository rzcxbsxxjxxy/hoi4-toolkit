/**
 *  Paradox 本地化 YML 解析。
 *
 * 格式要点:
 *   - 文件必须 UTF-8 with BOM
 *   - 首行是语言头:l_english: / l_simp_chinese: 等
 *   - 条目:KEY: "值"   或   KEY:0 "多行文本第 0 行"
 *   - 值内双引号用 "" 转义
 *   - # 为注释
 */
export interface LocEntry {
  key: string
  /** KEY:0 中的序号,多行文本用;单行则无 */
  index: number | null
  value: string
  file: string
  line: number
  lang: string
}

export interface LocFileResult {
  file: string
  lang: string | null
  entries: LocEntry[]
  errors: string[]
  hasBom: boolean
  /**
   * ★ MOD_SCOPE_V1:该文件属于哪个 root 的**名字**(不是序号)。
   *   模组级体检要能只报目标模组的本地化问题,而 loc 索引是
   *   所有来源合并的 —— 没这个字段就分不清「谁的问题」。
   *   外部构造(测试/CLI)时可省略,视为唯一来源。
   */
  root?: string
}

const LANG_RE = /^\s*(l_[a-z_]+)\s*:\s*(?:#.*)?$/
// KEY 或 KEY:123,后跟可选空白与值
//
// ★ 2026-10 修:原来 `(?::(\d+))?` 只在冒号后是数字时才消费冒号,
//   于是最常见的单行写法 `KEY: "value"` 里那个冒号留在 rest 里,
//   值变成 `: "value"` —— 所有单行本地化都带一个多余的 ": " 前缀。
//   现在冒号无条件消费(:123 是多行序号,不消费掉它 KEY:123 会被当成 key)。
const ENTRY_RE = /^\s*([^\s:]+)\s*(?::(\d+))?\s*:?\s*(.*)$/

export function parseLocYml(src: string, file: string): LocFileResult {
  const errors: string[] = []
  const entries: LocEntry[] = []
  const raw = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
  const hasBom = src.charCodeAt(0) === 0xfeff

  let lang: string | null = null
  const lines = raw.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const lineNo = i + 1

    // 去注释(引号外)
    let inQ = false
    let code = ''
    for (const ch of rawLine) {
      if (ch === '"') inQ = !inQ
      if (ch === '#' && !inQ) break
      code += ch
    }
    if (!code.trim()) continue

    const lm = code.match(LANG_RE)
    if (!lang && lm) {
      lang = lm[1]
      continue
    }
    // 已进入语言头后仍出现 lang 行 -> 多语言混在一个文件,记异常
    if (lm) {
      errors.push(`第 ${lineNo} 行:文件内出现第二个语言头 ${lm[1]}`)
      continue
    }

    const em = code.match(ENTRY_RE)
    if (!em) {
      errors.push(`第 ${lineNo} 行:无法解析 "${rawLine.trim().slice(0, 60)}"`)
      continue
    }
    const [, key, idx, rest] = em
    let value = rest.trim()
    if (value.startsWith('"')) {
      // 去掉首尾引号,并把 "" 还原为 "
      value = value.replace(/^"(.*)"$/, '$1').replace(/""/g, '"')
    }
    entries.push({
      key,
      index: idx === undefined ? null : Number(idx),
      value,
      file,
      line: lineNo,
      lang: lang ?? 'unknown',
    })
  }

  return { file, lang, entries, errors, hasBom }
}

export interface LocIndex {
  files: number
  entries: number
  byLang: Map<string, number>
  /** 同一语言内重复定义的 key(+index) */
  duplicates: Map<string, LocEntry[]>
  /** 无 BOM 的文件(游戏要求 BOM) */
  missingBom: string[]
  /** 解析异常的文件 */
  errorFiles: { file: string; count: number; first: string }[]
  /** (lang:key) -> 出现的文件列表(跨文件重复)。同一 key 在不同语言属正常,必须按语言分组 */
  keyToFile: Map<string, Set<string>>
}

export function buildLocIndex(results: LocFileResult[]): LocIndex {
  const byLang = new Map<string, number>()
  const seen = new Map<string, LocEntry[]>()
  const keyToFile = new Map<string, Set<string>>()
  const missingBom: string[] = []
  const errorFiles: LocIndex['errorFiles'] = []
  let entries = 0

  for (const r of results) {
    if (!r.hasBom) missingBom.push(r.file)
    if (r.errors.length) errorFiles.push({ file: r.file, count: r.errors.length, first: r.errors[0] })
    for (const e of r.entries) {
      entries++
      if (r.lang) byLang.set(r.lang, (byLang.get(r.lang) ?? 0) + 1)
      const id = `${e.lang}:${e.key}:${e.index ?? ''}`
      const arr = seen.get(id)
      if (arr) arr.push(e)
      else seen.set(id, [e])
      // 按 语言+key 分组:同一 key 在各语言目录下存在是正常的
      const s = keyToFile.get(`${e.lang}:${e.key}`) ?? new Set<string>()
      s.add(e.file)
      keyToFile.set(`${e.lang}:${e.key}`, s)
    }
  }

  const duplicates = new Map<string, LocEntry[]>()
  for (const [id, arr] of seen) if (arr.length > 1) duplicates.set(id, arr)

  return {
    files: results.length,
    entries,
    byLang,
    duplicates,
    missingBom,
    errorFiles,
    keyToFile,
  }
}
