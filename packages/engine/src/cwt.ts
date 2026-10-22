/**
 * CWTools `.cwt` 规则文件解析器 —— 把声明式校验规则读成内存规则库。
 *
 * ## 为什么要移植(CWTools 对标)
 *
 * 我们原有的 `validate.ts` 是**硬编码检查项**:语法错误、括号、重复定义、
 * 悬空 sprite/loc 键、国策 shared_focus 崩溃规则。每加一类内容就要改一次代码,
 * 且只能覆盖我们已经 specialsized 过的几个域。
 *
 * CWTools 走的是另一条路:把校验知识全部写成**声明式规则文件**(113 个 `.cwt`,
 * 1962 条 alias),引擎只负责"规则 + 泛型匹配"。新增一条校验 = 新增一段规则文本,
 * 零代码改动。本模块就是那层引擎的前半段(解析),后半段在 `cwt-check.ts`。
 *
 * ## 为什么不能直接复用 `parser/src/parser.ts`
 *
 * Paradox 脚本与 `.cwt` 表面同形(`key = value` / `key = { }` / `## 指令` / `# 注释`),
 * 但有两处 token 语义完全不同,直接喂给游戏解析器会产生 574 条假错误(实测):
 *
 *   1. **`<` `>` 是交叉引用标记,不是比较运算符**
 *      `alias[effect:<scripted_effect>] = yes` 里 `<scripted_effect>` 是一个整体,
 *      而 Paradox 脚本里 `<` 是"小于"。游戏解析器报 `无法识别的 token ">"`。
 *   2. **`[ ]` `|` 是类型表达式的一部分**
 *      `alias[effect:X]` 的 key 本身带方括号;`character_name|<character>` 的
 *      value 是"先求值 `<character>` 再喂给 character_name 命令"的管道。
 *      游戏解析器会把 `alias[effect:` / `]` 拆成两个 key。
 *
 * 所以这里写一个**专用的小解析器**。它只需要覆盖 `.cwt` 的语法子集,
 * 比通用解析器简单得多,也更好维护。
 *
 * ## `.cwt` 的语法子集(实测 113 个文件归纳)
 *
 * ```
 * #  普通注释(整行或行尾)          —— 丢弃
 * ### 文档注释(整行)               —— 取为该条规则的 description(hover 用)
 * ##  指令注释(整行)               —— 作用于**紧随其后的**那条声明
 * ##  scope = { country state }     —— 前置守卫作用域(OR 集合)
 * ##  cardinality = 0..1            —— 出现次数约束(~ 前缀 = 软约束)
 * ##  severity = error|warning|info —— 诊断级别
 * ##  push_scope = country          —— 执行后作用域变化
 * ##  replace_scope = { ... }       —— 整体替换作用域栈
 * ##  error_if_only_match = 文案    —— 自带诊断文案(规则即消息)
 * ##  unique = yes                  —— 全局唯一
 * key = value                       —— 声明
 * key = { ... }                     —— 块形态
 * ```
 *
 * 六类顶层声明原语:
 *   alias[ns:key]        规则条目(主力,1962 处)
 *   single_alias[name]   具名内联块模板(值处用 `single_alias_right[X]` 引用)
 *   types = { type[X] }  文件路径 → 块结构的绑定
 *   enums = { ... }      enum[X] 字面量枚举 / complex_enum[X] 反向采集
 *   links = { ... }      作用域跃迁与带前缀的数据引用
 *   scopes = { ... }     作用域分类与继承
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

/* ════════════════════════════════════════════════════════════════════
 * 一、Tokenizer
 * ════════════════════════════════════════════════════════════════════ */

export type TokKind = 'ident' | 'string' | 'assign' | 'lbrace' | 'rbrace' | 'angle' | 'directive' | 'doc' | 'eof'

export interface Tok {
  kind: TokKind
  /** 规范化文本(ident 原样;string 去引号;angle 含尖括号如 `<state>`);directive 为 `key = value` 原文 */
  text: string
  line: number
  /** 行尾注释(`#` 之后的部分,已 trim)—— `.cwt` 允许行尾注释 */
  trailing?: string
}

/**
 * `.cwt` 的注释分三级,语义完全不同:
 *   `#`   普通注释,丢弃
 *   `###` 文档注释 → description(hover 提示文本)
 *   `##`  指令注释 → 作用于**紧随其后的**那条声明
 *
 * 区分点是 `#` 后面紧跟的第二个字符。`###` 必须先判,否则会被 `##` 吃掉。
 * 注意 `####...` 也归文档注释(实测规则文件里有)。
 *
 * ★ 设计决策:指令/文档注释**产出为独立 token**(而非塞进 trailing),
 *   这样 parser 只要在读到 directive/doc token 时更新 pending 缓冲,
 *   「`##` 作用于紧随其后的声明」就是天然的顺序语义,不需要行号比对。
 *   若改成挂 trailing,就得反查"这个 token 后面第一个声明是哪行",容易出错。
 */
interface CommentState {
  /** 待挂到下一条声明的指令 */
  directives: Directive[]
  /** 待挂到下一条声明的文档 */
  descLines: string[]
}

export interface Directive {
  key: string
  value: string
  line: number
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const n = src.length

  const push = (kind: TokKind, text: string) => {
    toks.push({ kind, text, line })
  }

  while (i < n) {
    const c = src[i]

    /* 换行 */
    if (c === '\n') {
      line++
      i++
      continue
    }
    /* 空白 */
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }

    /* 注释 */
    if (c === '#') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      const body = src.slice(i, j)
      i = j

      // 判别层级:`###` 及以上 = 文档,`##` = 指令,单个 `#` = 普通注释
      let hashes = 0
      while (hashes < body.length && body[hashes] === '#') hashes++
      const inner = body.slice(hashes).trim()

      if (hashes >= 3) {
        // 文档注释:多行拼接(实测文档说明常跨好几行)
        push('doc', inner)
      } else if (hashes === 2) {
        // 指令:`## key = value`,也允许 `## key`(无值,如 `## primary`)
        const eq = inner.indexOf('=')
        if (eq < 0) push('directive', `${inner}=`)
        else push('directive', `${inner.slice(0, eq).trim()}=${inner.slice(eq + 1).trim()}`)
      } else {
        // 普通注释:是行内注释就挂到上一个 token,否则丢弃
        const last = toks[toks.length - 1]
        if (last && last.line === line && !last.trailing) last.trailing = inner
      }
      continue
    }

    /* 字符串:双引号,支持 \" 转义 */
    if (c === '"') {
      let j = i + 1
      let out = ''
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          out += src[j + 1]
          j += 2
          continue
        }
        if (src[j] === '\n') line++
        out += src[j]
        j++
      }
      push('string', out)
      i = j + 1
      continue
    }

    /* 赋值 */
    if (c === '=') {
      push('assign', '=')
      i++
      continue
    }

    /* 左花括号 */
    if (c === '{') {
      push('lbrace', '{')
      i++
      continue
    }

    /* 右花括号 */
    if (c === '}') {
      push('rbrace', '}')
      i++
      continue
    }

    /* 尖括号:`<state>` / `<event.country_event>` / `<scripted_effect>` 整体一个 token。
     * 这是 `.cwt` 与 Paradox 脚本最大的 token 差异 —— 交叉引用不是比较表达式。*/
    if (c === '<') {
      let j = i + 1
      while (j < n && src[j] !== '>' && src[j] !== '\n') j++
      const inner = src.slice(i + 1, j).trim()
      push('angle', '<' + inner + '>')
      i = j < n && src[j] === '>' ? j + 1 : j
      continue
    }

    /* 标识符 / 带括号下标的键。
     *
     * ★ 关键难点(踩了两轮才对):`alias[effect:<scripted_effect>] = yes` 里,
     *   `<` 与 `>` 出现在**键的内部**。
     *
     *   第一版错法:先判 `<` 再判 ident → 键被截成 `alias[effect:`,
     *     `alias[ns:key]` 的方括号并入逻辑根本没机会跑(扫描已在 `<` 停),
     *     1962 条 alias 全丢。
     *
     *   第二版错法:先吃 ident 再并入 `[...]` → 但扫描阶段就在 `<` 停了,
     *     `end` 指向 `<` 而非 `[`,并入循环不执行,同样截断。
     *
     *   正解:一旦**起始字符是字母/下划线**,就把整段连续的非空白字符全部吃下
     *     (含 `[ ] < > : | . ~ , @ ^`),再从尾部剥掉真正属于语法分隔的部分。
     *     因为键里不会出现空格,整段吞下后再回退不会误吞下一个 token。
     *     而 `<` 只在**值位置**才是独立的交叉引用标记,那种情况前面一定
     *     是 `=` 或 `{`,起始字符是 `<`,会走下面的 angle 分支。*/
    {
      const isWordStart = /[A-Za-z_]/.test(c)
      if (!isWordStart) {
        i++
        continue
      }
      // 整段吃到行尾/分隔符
      let end = i
      while (end < n && !' \t\r\n='.includes(src[end]) && !(src[end] === '"')) {
        // `{` 只在键末尾出现时才终止(如 `key {`);键内不会有裸 `{`
        if (src[end] === '{') break
        end++
      }
      push('ident', src.slice(i, end))
      i = end
      continue
    }
  }
  push('eof', '')
  return toks
}

/* ════════════════════════════════════════════════════════════════════
 * 二、语法树
 * ════════════════════════════════════════════════════════════════════ */

/** 一个值位置的声明形态 */
export type ValueSpec =
  | { t: 'scalar'; name: string } // 具名形态:localisation / bool / int / scalar / yes ...
  | { t: 'range'; base: string; min: number; max: number } // int[0..100] / float[0..1]
  | { t: 'enum'; name: string } // enum[phases]
  | { t: 'link'; name: string } // <state> / <event.country_event>
  | { t: 'pipe'; cmd: string; arg: string } // character_name|<character>
  | { t: 'scope'; scope: string; inner?: ValueSpec } // scope[state] / scope[country].value[array]
  | { t: 'value'; name: string } // value[variable] / value_set[country_flag]
  | { t: 'single'; name: string } // single_alias_right[bindable_loc]
  | { t: 'set'; name: string } // value_set[event_target]
  | { t: 'list'; items: ValueSpec[] } // 逗号/多值列表(罕见)
  | { t: 'block'; entries: SpecEntry[] } // { ... }
  | { t: 'any' } // alias_name[trigger] 等通配

/** 一条 `key = value` / `key = { ... }` */
export interface SpecEntry {
  key: string
  spec: ValueSpec
  directives: Directive[]
  desc?: string
  line: number
}

/** alias 条目:alias[ns:key] = spec */
export interface AliasRule {
  ns: string
  key: string
  spec: ValueSpec
  directives: Directive[]
  desc?: string
  file: string
  line: number
}

/** single_alias[name] = spec */
export interface SingleAlias {
  name: string
  spec: ValueSpec
  directives: Directive[]
  file: string
  line: number
}

/** type[X] = { path=... , ...结构 } */
export interface TypeRule {
  name: string
  /** 目录路径,如 "game/common/technologies" */
  path: string[]
  pathExtension?: string
  skipRootKey?: string
  typeKeyFilter?: string[]
  startsWith?: string
  /** 用哪个字段当唯一标识 */
  nameField?: string
  unique?: boolean
  typePerFile?: boolean
  onlyIfNot?: string[]
  pushScope?: string
  /** 结构定义(块内的条目) */
  entries: SpecEntry[]
  /** subtype[xxx] —— 含各自的顶层键过滤器与作用域 */
  subtypes: Record<string, SubtypeRule>
  directives: Directive[]
  desc?: string
  file: string
  line: number
}

/**
 * subtype 声明:`subtype[country_event] = { ... }`
 *
 * 关键字段 `typeKeyFilter` —— 该 subtype 对应文件里的哪个顶层 key
 * (`country_event` / `state_event` / `news_event` …)。
 * 规则原文把它写成**指令注释**而非字段,所以必须从 directives 里取。
 */
export interface SubtypeRule {
  name: string
  entries: SpecEntry[]
  typeKeyFilter: string[]
  pushScope?: string
  directives: Directive[]
  line: number
}

/** 从指令列表里取 `type_key_filter` 的值(多个值用 `{ a b }` 或空格分隔) */
function dirsOfTypeKeyFilter(dirs: Directive[]): string[] {
  for (const d of dirs) {
    if (d.key === 'type_key_filter') {
      return d.value
        .replace(/[{}]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    }
  }
  return []
}

/** 从指令列表里取标量值 */
function dirVal(dirs: Directive[], key: string): string {
  for (const d of dirs) if (d.key === key) return d.value
  return ''
}

/** enum[X] = { a b c } —— 字面量枚举 */
export interface LiteralEnum {
  name: string
  values: string[]
}

/** complex_enum[X] = { path=... name={...} unique=yes } —— 反向采集 */
export interface ComplexEnum {
  name: string
  path: string[]
  startFromRoot?: boolean
  unique?: boolean
  /** 采集路径描述,如 `{ enum_name = scalar }` / `{ provinces = { enum_name } }` */
  namePath: SpecEntry[]
  file: string
  line: number
}

/** links[name] = { output_scope input_scopes prefix data_source ... } */
export interface LinkRule {
  name: string
  outputScope?: string
  inputScopes?: string[]
  prefix?: string
  fromData?: boolean
  dataSource?: ValueSpec
  type?: string
  desc?: string
  file: string
  line: number
}

/** scopes[Name] = { aliases={} is_subscope_of={} } */
export interface ScopeDef {
  label: string
  aliases: string[]
  isSubscopeOf: string[]
}

/** modifier_categories[name] = { supported_scopes = {} } */
export interface ModifierCategory {
  name: string
  supportedScopes: string[]
}

/**
 * 顶层裸结构声明:`focus_tree = { id = localisation country = { ... } }`
 *
 * 这是「一个实体类型的内部结构」定义 —— 块级校验的唯一依据。
 * 与 alias 的分工:
 *   alias  = 值级规则(这个键允许什么值)
 *   本项    = 块级规则(这个实体里有哪些键、每个键什么类型)
 */
export interface StructDef {
  name: string
  entries: SpecEntry[]
  subtypes: Record<string, SpecEntry[]>
  directives: Directive[]
  desc?: string
  /** 可能有多个文件各自贡献一部分(如 technology 被多个 DLC 文件声明) */
  files: string[]
  file: string
  line: number
}

/* ════════════════════════════════════════════════════════════════════
 * 三之二、struct 的 subtype 展开(多形态声明)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 把结构定义里的 `subtype[X] = { ... }` **就地展开**成与同级字段并列的条目。
 *
 * ★ 为什么必须展开(这是 CWTools 校验能覆盖全字段的前提):
 *   `events.cwt:39-69` 的 `event` 结构里,`title` / `desc` **只**写在
 *   `subtype[hidden]` 与 `subtype[visible]` 内部,顶层一个都没有:
 *     ```
 *     event = {
 *       id = scalar
 *       subtype[hidden]  = { title = scalar        desc = scalar }
 *       subtype[visible] = { title = localisation  desc = localisation
 *                            title = { trigger = {...} text = localisation }
 *                            desc  = { trigger = {...} text = localisation } }
 *       picture = <spriteType>
 *       ...
 *     }
 *     ```
 *   不展开的话 `struct.event.entries` 里只有 `subtype[hidden]` / `subtype[visible]`
 *   两个**根本不存在的键**,而 `title` / `desc` 一个都没有 ——
 *   后果是 `country_event = { id = x  title = x.t  desc = x.d }` 里
 *   两个完全合法的键被报成「不在此结构的定义里」(实测 3 条误报)。
 *
 * ★ 语义依据:CWTools 的 subtype 表示**同一实体的不同形态**(多形态声明),
 *   任一形态提供该键即算合法,所以是**并集**而非覆盖。同名键的多条声明
 *   交给引擎侧的 `mergeSpecEntries` 合并(任一形态匹配即通过)。
 *
 * ★ 保留 `subtype[X]` 这个条目本身:诊断里要能显示「该键由 subtype 提供」,
 *   且 `push_scope` 等 subtype 级指令仍挂在它上面。
 */
function expandStructSubtypes(structs: Map<string, StructDef>): void {
  for (const st of structs.values()) st.entries = expandEntries(st.entries, st.subtypes)
}

/** 返回展平后的 entries(原地改+ 返回同一数组,便于递归赋值) */
function expandEntries(entries: SpecEntry[], into?: Record<string, SpecEntry[]>): SpecEntry[] {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.spec.t !== 'block') continue
    const inner = e.spec.entries
    e.spec.entries = expandEntries(inner, into)
    /* 键名形如 `subtype[visible]` */
    const m = /^subtype\[([^\]]*)\]$/.exec(e.key)
    if (!m) continue
    if (into) into[m[1]] = inner
    /* 内层字段并入父级:插在 subtype 条目**之后**,保持原文顺序 */
    entries.splice(i + 1, 0, ...inner.map((x) => ({ ...x })))
    i += inner.length
  }
  return entries
}

/* ════════════════════════════════════════════════════════════════════
 * 三、Parser
 * ════════════════════════════════════════════════════════════════════ */

/** 把 `int[0..100]` / `float[0.0..30.9]` / `int[1..inf]` 解析成 range */
function parseRange(text: string): { base: string; min: number; max: number } | null {
  const m = /^([a-z_]+)\[\s*(-?[\d.]+)?\s*\.\.\s*(-?[\d.]+)?\s*\]$/.exec(text)
  if (!m) return null
  const base = m[1]
  const min = m[2] === undefined || m[2] === '' ? -Infinity : parseFloat(m[2])
  const maxRaw = m[3] === undefined || m[3] === '' ? Infinity : m[3]
  const max = maxRaw === 'inf' ? Infinity : parseFloat(maxRaw)
  if (Number.isNaN(min) || Number.isNaN(max)) return null
  return { base, min, max }
}

/**
 * 把一个值 token(或 token 序列)转成 ValueSpec。
 *
 * 形态判定顺序有讲究 —— 先试最具体的:
 *   `<...>` → range → enum[...] → scope[...] → value_set[...] → value[...]
 *   → single_alias_right[...] → 管道(多个 ident 用 | 连) → 具名
 * 因为 `scope[country].value[array]` 是点号连接的两段,得整体识别。
 */
function parseValue(toks: Tok[], ctx: ParseCtx): ValueSpec {
  // 管道:`a|b|c` —— 最后一段是交叉引用,前面是命令名
  if (toks.length > 1) {
    const texts = toks.map((t) => t.text)
    if (texts.every((t) => t === '|' || t === 'ident' || t === 'angle')) {
      // 拆出管道段
      const segs: Tok[][] = [[]]
      for (const t of toks) {
        if (t.text === '|') segs.push([])
        else segs[segs.length - 1].push(t)
      }
      const last = segs[segs.length - 1]
      const cmd = segs
        .slice(0, -1)
        .map((s) => s.map((t) => t.text).join(''))
        .filter(Boolean)
        .join('|')
      if (last.length === 1 && last[0].kind === 'angle') {
        return { t: 'pipe', cmd, arg: last[0].text }
      }
    }
  }

  const t = toks[0]
  if (!t) return { t: 'any' }

  if (t.kind === 'angle') {
    // `<state>` 或 `<event.country_event>`
    return { t: 'link', name: t.text.slice(1, -1) }
  }

  /* 管道:`a|b` / `cmd|<type>`。
   * 管道整体被 ident 扫描器吃成一个 token(内部无空格),先拆开。
   * 单独一个 string 不是管道 —— `path = "game/x"` 走下面的普通路径。*/
  if (t.kind === 'ident' && t.text.includes('|')) {
    const segs = t.text.split('|').filter((s) => s.length > 0)
    if (segs.length >= 2) {
      const last = segs[segs.length - 1]
      const cmd = segs.slice(0, -1).join('|')
      if (last.startsWith('<') && last.endsWith('>')) {
        return { t: 'pipe', cmd, arg: last }
      }
      // 非交叉引用的管道(如 `a|b`):当作命令名序列
      return { t: 'pipe', cmd, arg: last }
    }
  }

  const txt = t.text

  const r = parseRange(txt)
  if (r) return { t: 'range', ...r }

  let m = /^enum\[([^\]]+)\]$/.exec(txt)
  if (m) return { t: 'enum', name: m[1] }

  m = /^scope\[([^\]]+)\]/.exec(txt)
  if (m) {
    // `scope[country].value[array]` —— 后半段是作用域下的值引用
    const rest = txt.slice(m[0].length)
    const inner = rest ? parseValue([{ kind: 'ident', text: rest.replace(/^\./, ''), line: t.line }], ctx) : undefined
    return { t: 'scope', scope: m[1], inner }
  }

  m = /^value_set\[([^\]]+)\]$/.exec(txt)
  if (m) return { t: 'set', name: m[1] }

  m = /^value\[([^\]]+)\]$/.exec(txt)
  if (m) return { t: 'value', name: m[1] }

  m = /^single_alias_right\[([^\]]+)\]$/.exec(txt)
  if (m) return { t: 'single', name: m[1] }

  // 通配:`alias_name[trigger]` / `alias_match_left[trigger]` / `alias_match_right[trigger]`
  m = /^alias_(?:name|match_left|match_right)\[([^\]]+)\]$/.exec(txt)
  if (m) return { t: 'any' }

  // `character_name|<character>` 的裸命令名(无管道时)
  return { t: 'scalar', name: txt }
}

interface ParseCtx {
  file: string
}

/**
 * 解析 `.cwt` 文本为四类规则 + 辅助表。
 *
 * 顶层 key 只有 6 种(`alias` / `single_alias` / `types` / `enums` / `links` / `scopes`
 * / `modifier_categories` / `values` / `localisation_commands` / 其他忽略),
 * 所以这里用一个"看下一个 ident 决定怎么读"的分派。
 */
export function parseCwt(src: string, file: string): CwtFile {
  const toks = tokenize(src)
  const ctx: ParseCtx = { file }

  const out: CwtFile = {
    file,
    aliases: [],
    singleAliases: [],
    types: [],
    enums: new Map(),
    links: new Map(),
    scopes: new Map(),
    modifierCategories: new Map(),
    values: new Map(),
    localisationCommands: new Set(),
    structs: new Map(),
    errors: [],
  }

  /* 顶层裸结构声明累积器(`focus_tree = { ... }` 等) */
  const structs = new Map<string, StructDef>()

  // 游标
  let p = 0
  const peek = (k = 0): Tok => toks[Math.min(p + k, toks.length - 1)]
  const next = (): Tok => toks[Math.min(p++, toks.length - 1)]
  const at = (kind: TokKind, text?: string): boolean => {
    const t = peek()
    return t.kind === kind && (text === undefined || t.text === text)
  }
  const expect = (kind: TokKind, what: string): Tok => {
    if (!at(kind)) {
      const t = peek()
      out.errors.push({ file, line: t.line, error: `期望 ${what},实际得到 "${t.text}"` })
      return t
    }
    return next()
  }

  /* 指令/文档缓冲:`##` 与 `###` 产出为 token,按出现顺序挂到紧随其后的声明上 */
  let pendingDirs: Directive[] = []
  let pendingDoc: string[] = []

  function clearPending(): void {
    pendingDirs = []
    pendingDoc = []
  }
  const curDesc = (): string | undefined => (pendingDoc.length ? pendingDoc.join(' ') : undefined)

  /* 主循环 */
  while (!at('eof')) {
    const t = peek()

    /* 指令注释:`## key = value` */
    if (t.kind === 'directive') {
      next()
      const eq = t.text.indexOf('=')
      pendingDirs.push({ key: t.text.slice(0, eq).trim(), value: t.text.slice(eq + 1).trim(), line: t.line })
      continue
    }

    /* 文档注释:`### 说明`(多行拼接) */
    if (t.kind === 'doc') {
      next()
      if (t.text) pendingDoc.push(t.text)
      continue
    }

    if (t.kind === 'rbrace') {
      next()
      clearPending()
      continue
    }
    if (t.kind !== 'ident') {
      next()
      continue
    }

    const head = t.text

    /* 聚合块:`types = { ... }` / `enums = { ... }` / `links = { ... }` 等。
     *
     * ★★ 必须用**白名单**而不是「裸标识符 + assign」的反向判断。
     *
     *   踩过的坑(两轮):
     *     第一版:条件是「不含 `[` 且后面跟 assign」→ `focus_tree = { ... }`
     *       也满足,掉进 default 被 skipBlock() 吞掉,结构定义全丢(实测 structs=0)。
     *     第二版:把结构声明分支加在聚合块之后 → 永远轮不到,同样 structs=0。
     *
     *   正解:只有下列这几个 key 是聚合块,其余裸标识符都是**实体结构声明**
     *   (`focus_tree` / `technology` / `event` / `state` / `country_file` …),
     *   必须走结构分支。*/
    const AGGREGATE_BLOCKS = new Set([
      'types',
      'enums',
      'links',
      'scopes',
      'modifier_categories',
      'values',
      'localisation_commands',
      'modifiers',
      'modifier',
      'folders',
      'links.documentation',
    ])

    if (AGGREGATE_BLOCKS.has(head) && peek(1).kind === 'assign') {
      switch (head) {
        case 'types':
          next()
          next()
          parseTypesBlock(out, expect('lbrace', '{').line)
          continue
        case 'enums':
          next()
          next()
          parseEnumsBlock(out)
          continue
        case 'links':
          next()
          next()
          parseLinksBlock(out)
          continue
        case 'scopes':
          next()
          next()
          parseScopesBlock(out)
          continue
        case 'modifier_categories':
          next()
          next()
          parseModifierCategoriesBlock(out)
          continue
        case 'values':
          next()
          next()
          parseValuesBlock(out)
          continue
        case 'localisation_commands':
          next()
          next()
          // `localisation_commands = { GetName = any ... }` —— 只收键名
          parseLocCommandBlock(out)
          continue
        default:
          // 未知聚合块,跳过其内容
          next()
          next()
          skipBlock()
          continue
      }
    }

    // `alias[ns:key] = spec`
    if (/^alias\[/.test(head)) {
      next()
      if (!at('assign')) {
        out.errors.push({ file, line: t.line, error: `alias 声明缺少 "="` })
        continue
      }
      next()
      /* ★ 必须在 readSpec() **之前**快照指令/文档。
       *   readSpec 读块时会 clearPending(),把变量指向新数组;
       *   若之后再读 pendingDirs,拿到的是已被清空的空数组
       *   —— 表现为「第一条规则有指令、后续全丢」的诡异现象。
       *
       * ★ 而且必须**拷贝**(.slice())而不是只存引用:
       *   clearPending 是「重新赋值」,但 readSpec 在遇到块内第一条子条目
       *   之前,还会往**当前**那个数组里 push 块内的 `## cardinality`。
       *   只存引用的话,alias 自己的 directives 会把块内首条目的
       *   cardinality 一并吞进去(实测:
       *   `## scope = any` + 块内 `## cardinality = 0..1`
       *   → alias.directives 变成 ["scope","cardinality"],多出一条)。*/
      const myDirs = pendingDirs.slice()
      const myDesc = curDesc()
      const spec = readSpec(true)
      out.aliases.push({
        ns: nsOf(head),
        key: keyOf(head),
        spec,
        directives: myDirs,
        desc: myDesc,
        file,
        line: t.line,
      })
      clearPending()
      continue
    }

    // `single_alias[name] = spec`
    if (/^single_alias\[/.test(head)) {
      next()
      if (!at('assign')) {
        out.errors.push({ file, line: t.line, error: `single_alias 声明缺少 "="` })
        continue
      }
      next()
      const myDirs = pendingDirs
      const spec = readSpec(true)
      out.singleAliases.push({
        name: bracketOf(head),
        spec,
        directives: myDirs,
        file,
        line: t.line,
      })
      clearPending()
      continue
    }

    /* ── 顶层裸结构声明:`focus_tree = { id = localisation ... }`
     *
     * ★ 这是**结构校验的唯一依据**,漏了它等于规则库只懂 effect/trigger,
     *   完全不知道「一个国策块里该有哪些键、每个键是什么类型」。
     *
     *   它和 `alias[...]` 的区别:
     *     alias  —— 声明**某个键在某个命名空间下**允许什么值(值级规则)
     *     顶层裸 —— 声明**某个实体类型(文件类型)的结构**(块级规则)
     *
     *   位置上:紧跟在 `types = { ... }` 块之后,以裸 `key = { }` 出现
     *   (实测 national_focus.cwt:63、technologies.cwt:28、events.cwt:39)。
     *   同一文件里可能有多个(technology + tech_sharing_group)。
     */
  /* 注意:此时 head 这个 ident **还没被消费**,游标仍停在它上面。
     *   所以要先 next() 消费 head,再判 assign/lbrace。*/
    if (!head.includes('[') && !head.includes('|') && !head.includes('.') && !head.includes('>')) {
      next()
      if (at('assign')) {
        next()
        if (at('lbrace')) {
          /* ★★★ 坑在这里:**不要**在这里 next() 吃掉块首 `{`。
           *
           * readSpec() 的块分支自己第一件事就是 `if (at('lbrace')) next()`
           * (见 799-801 行),调用方必须把游标**停在 `{` 上**。
           *
           * 这里多 next() 一次的后果(实测,最小样本即可复现):
           *   游标被推到 `{` **之后**的第一条子条目 `id` 上 → readSpec 的
           *   `at('lbrace')` 判定为 false → 走 886 行的「非块值」分支,
           *   把 `id` / `country` / `focus` 当成普通值 token 收集。
           *   紧接着 918 行的「ident 后跟 assign 就 break」救了第一键
           *   (`id = ` 处停下),于是 `id` 被当成值、`country`/`focus` 被
           *   弹回主循环当成**新的顶层裸结构**重新登记 —— 表现为
           *   structs 里多出 `country`/`focus` 两个本不该存在的结构,
           *   且所有结构的 entries 全空。
           *
           * 为什么 alias 路径没这个毛病:alias 分支(659-665 行)在
           * `next()` 掉 assign 之后**直接** readSpec(true),从不吃 lbrace。
           * 两条路径的差异仅此一处,alias 块能提取正是因为它没多这一步。*/
          /* ★ 必须在 readSpec() **之前**快照指令/文档 —— 与上面 alias 分支(659-662)
           *   完全同一个坑,这里也踩了。
           *
           *   readSpec() 读块时会在内部 clearPending(),而 clearPending 是
           *   **重新赋值**(`pendingDirs = []`)而非清空原数组。所以调用返回后
           *   再读 pendingDirs 拿到的是块内最后一条子条目结算后的空数组。
           *
           *   实测症状(真实文件 technologies.cwt:27 / states.cwt:12 /
           *   national_focus.cwt:591、819):
           *     `## replace_scope = { this = country root = country }`
           *     写在 `technology = { ... }` **上方**,本属这条结构声明,
           *     解析后 struct.directives = [],而这条 replace_scope
           *     反而被挂到了块内**第一条**子条目(doctrine_name)的 directives 上。
           *
           *   为什么块内第一条会拿到它:进入本函数时 pendingDirs 里装的正是
           *   结构声明自己的指令,而当时 keepOuterPending=false 让块内首条目
           *   无条件正常结算,把这段前缀一起吞了。
           *   (最初靠 skipFirst 启发式修,现已改为 readSpec 内
           *    「按进入时长度切片」的确定做法,不再依赖任何猜测。)
           *   所以快照必须前置,且要 .slice() 拷贝 —— 与 alias 分支同一个理由:
           *   readSpec 会往当前 pending 数组里 push 块内首条目的 `## cardinality`,
           *   只存引用会让结构自己的 directives 把它一并吞掉。*/
          const dirs = pendingDirs.slice()
          const desc = curDesc()
          /* 与 alias 分支同理传 true:结构声明自己上方可能带
           * `## replace_scope = { ... }`(实测 technologies.cwt:27、
           * states.cwt:12、national_focus.cwt:591/819),传 false 会让
           * 这段前缀漏进块内第一条子条目。*/
          const spec = readSpec(true)
          clearPending()
          const exist = structs.get(head)
          if (exist) {
            // 同名结构定义(如 technology 在多个 DLC 文件里各声明一部分)→ 合并
            if (spec.t === 'block') {
              exist.entries.push(...spec.entries)
              for (const [sk, sv] of Object.entries((spec as { subtypes?: Record<string, SubtypeRule> }).subtypes ?? {})) {
                exist.subtypes[sk] = sv
              }
            }
            if (!exist.files.includes(file)) exist.files.push(file)
            if (!exist.desc) exist.desc = desc
          } else {
            structs.set(head, {
              name: head,
              entries: spec.t === 'block' ? spec.entries : [],
              subtypes: {},
              directives: dirs,
              desc,
              files: [file],
              file,
              line: t.line,
            })
          }
          continue
        }
        // 标量形态(`xxx = yes`):不是结构定义,跳过它的值
        readSpec()
        clearPending()
        continue
      }
      // 裸键(无= ),跳过即可
      clearPending()
      continue
    }

  // 其他顶层声明(如 `modifiers = { ... }`、`folders = { ... }`)—— 跳过
    next()
    if (at('assign')) {
      next()
      readSpec()
    }
    clearPending()
  }

  // 顶层结构定义收集完毕,挂回结果
  expandStructSubtypes(structs)
  out.structs = structs

  return out

  /* ── 局部辅助(闭包捕获上面的游标) ── */

  /** 跳过一个 `{ ... }` 块 */
  function skipBlock(): void {
    if (!at('lbrace')) return
    let depth = 0
    do {
      const tk = next()
      if (tk.kind === 'lbrace') depth++
      else if (tk.kind === 'rbrace') depth--
      else if (tk.kind === 'eof') return
    } while (depth > 0)
  }

/**
   * 读一个「值」:可能是 `{ ... }` 块,也可能是 token 序列。
   *
   * @param keepOuterPending
   *   true  = 调用方(顶层 alias / 顶层裸结构声明)自己就带指令 ——
   *           进入本函数时 pendingDirs 里装的是**调用方那条声明自己的**
   *           `## scope = any` / `## replace_scope = { ... }`,
   *           块内第一条子条目不得把它消费掉。
   *   false = 调用方(如 types/enums/links 聚合块、subtype)不带指令,
   *           块内每条子条目都正常结算自己的 `## cardinality` / `## scope`。
   *
   * ★ 踩坑记录(三次才对):
   *   1) 用 `entries.length === 0` 判「首条目」→ `links = { owner = {...} }`
   *      这类嵌套里误判,实测把 links 从 17 打到 1。
   *   2) 改用「块内有没有消费过注释(sawInnerComment)」→ 顶层结构块虽然
   *      entries 出来了,但结构自己上方的 `## replace_scope` 会漏进块内
   *      **第一条**子条目(struct.directives 同时也是空的)。
   *   3) 正解:**按进入块时的长度切片**。进入块那一刻把 pending 的长度
   *      记下来,首条目结算时只取「进入块之后新增的那一段」,前缀整段留给调用方。
   *      这个做法不依赖任何关于块内长什么样的猜测,对两层都成立。
   */
  function readSpec(keepOuterPending = false): ValueSpec {
    if (at('lbrace')) {
      next()
      const entries: SpecEntry[] = []
      /* 进入块时 pending 的长度 —— 即「属于调用方那条声明」的指令前缀长度。
       * 块内第一条子条目结算时只取 pendingDirs.slice(outerDirCount),
       * 把这段前缀原封不动留给调用方。*/
      const outerDirCount = pendingDirs.length
      const outerDocCount = pendingDoc.length
      // 块内每条子条目各自有一组 pending 指令/文档,遇到下一个 key 时才结算
      while (!at('rbrace') && !at('eof')) {
        /* ★ 指令/文档 token 必须在这里被**累积**,不能像其它 token 那样跳过。
         *   `## cardinality = 0..1` 就写在块内子条目的上方,
         *   若在这里 next() 掉,所有块内子条目都会丢掉 cardinality /
         *   scope / severity —— 而这些恰恰是校验的核心依据。
         *
         * 块自身的指令在进入本函数前就已由外层主循环累积进 pendingDirs;
         * 但进入块时**不能** clearPending —— 外层要拿它当自己的 directives。
         * 所以这里只在「已确定要开始一条子条目」时才结算。*/
        const kt0 = peek()
        if (kt0.kind === 'directive') {
          next()
          const eq = kt0.text.indexOf('=')
          pendingDirs.push({ key: kt0.text.slice(0, eq).trim(), value: kt0.text.slice(eq + 1).trim(), line: kt0.line })
          continue
        }
        if (kt0.kind === 'doc') {
          next()
          if (kt0.text) pendingDoc.push(kt0.text)
          continue
        }
        /* ★★ `angle` 也必须能当键,不能当噪声跳过!
         *
         * 真实规则里有这种写法(national_focus.cwt:164-174):
         *     icon = {
         *         ## cardinality = ~1..inf
         *         ## replace_scope = { root = country this = country }
         *         <spriteType> = { alias_name[trigger] = ... }
         *         <spriteType> = yes
         *     }
         * 交叉引用标记 `<spriteType>` 在这里是**键**,不是值。
         *
         * 只收ident 的后果(实测):`<spriteType>` 被 next() 掉当成噪声,
         * 后面的 assign 也被 next() 掉,再后面的 `{` 同样被跳过 ——
         * 于是这个内层块的两个花括号「凭空消失」,块在 `}` 处提前闭合,
         * `cost` / `prerequisite` 等后续键**溢出**到父结构去。
         * 表现:structs 里凭空多出 `focus`/`offset`/`prerequisite` 等
         * 本该只是**内层键**的结构,父结构 entries 里混进子结构的键。
         *
         * 与 parseLocCommandBlock(见下)同一个坑,那里已经踩过一次。
         *
         * ★ `string` 同样要能当键:`"---" = { ... }`(bookmarks.cwt:90)。
         *   只收 ident/angle 的话,这个带引号的键会被 next() 掉当噪声,
         *   后面的 assign 和 `{` 也跟着被跳过 → 块提前闭合,
         *   里面的 `effect = { ... }` 溢出到主循环,被误登记成
         *   一个顶层结构 `effect`(实测 structs 里凭空多出 effect)。
         *   与 readDeclHead(见下)收录 string 键是同一个坑,那里已踩过一次。*/
        if (kt0.kind !== 'ident' && kt0.kind !== 'angle' && kt0.kind !== 'string') {
          next()
          continue
        }
        /* 结算本条子条目:只取属于**块内**的那一段指令/文档。
         *
         * keepOuterPending=true 时,前 outerDirCount / outerDocCount 个是
         * 调用方的,跳过它们;调用方已在自己那边快照过,不会丢。*/
        let myDirs: Directive[]
        let myDesc: string | undefined
        if (keepOuterPending && entries.length === 0) {
          myDirs = pendingDirs.slice(outerDirCount)
          const inner = pendingDoc.slice(outerDocCount)
          myDesc = inner.length ? inner.join(' ') : undefined
        } else {
          myDirs = pendingDirs
          myDesc = curDesc()
        }
        clearPending()
        const kt = kt0
        next()
        if (!at('assign')) {
          // `int` / `scalar` 这类裸形态(无 key 无 =)
          entries.push({
            key: kt.text,
            spec: { t: 'scalar', name: kt.text },
            directives: myDirs,
            line: kt.line,
          })
          continue
        }
        next()
        /* 递归时一律传 false:嵌套块有自己的 pending 前缀要处理,
         * 不能把本块(可能属于外层调用方)的前缀语义再传下去。*/
        const v = readSpec(false)
        entries.push({
          key: kt.text,
          spec: v,
          directives: myDirs,
          desc: myDesc,
          line: kt.line,
        })
      }
      if (at('rbrace')) next()
      return { t: 'block', entries }
    }
    /* 非块值:收集 token 序列(如 `int[0..1]` / `enum[phases]` / `character_name|<character>`)
     *
     * ★ 必须把 directive/doc 当作**终止符**。
     *   上一版没判它们,导致 `alias[X] = variable_field` 之后紧跟的
     *   `## scope = country` + `### 说明` + `alias[effect:add_stability]`
     *   被当成上一个值的一部分吞进 `vs`,于是**第二条起的规则全都丢指令**。
     *   表现是「第一条 dirs 正确、后续全空」—— 极难定位。*/
    const vs: Tok[] = []
    while (!at('eof') && !at('assign') && !at('lbrace') && !at('rbrace')) {
      const tk = peek()
      // 注释 token 属于下一条声明,不属于当前值
      if (tk.kind === 'directive' || tk.kind === 'doc') break
      /* 一个 string 就是完整值本身(`path = "game/common/technologies"`),
       * 收下它之后必须**立刻停止** —— 否则会连带吞掉紧随其后的
       * `subtype[...]` / 下一个键。实测导致 type[technology].path 解析为空。*/
      if (tk.kind === 'string') {
        vs.push(next())
        break
      }
      /* ★★★ 本解析器最核心的终止条件:`ident|angle` 后面紧跟 `assign`
       *   说明当前 token 是**下一条声明的键**,不是本条的值,必须在此停。
       *
       *   缺了它的塌方点(实测):
       *     1) `skip_root_key = technologies` + `path = "..."` 被读成
       *        skip_root_key = [technologies, path] → type[technology].path 为空
       *     2) `output_scope = country` + `input_scopes = {...}` → links 17 条只剩 1 条
       *     3) 相邻两条 alias 中间只有 `#` 普通注释(不产出 token)时,后一条被整条吞掉
       *        → alias 少 106 条(集中在 temp_modifiers.cwt / interface/gui.cwt)
       *
       *   为什么这样判是安全的:值位置前面必然是 `=` 或 `{`,所以真值的 token 前面
       *   不可能紧跟 `assign`;而键后面必然跟 `=`。这正好把「键」与「值」区分开。
       *   已验证不误伤 `position = { x = float  y = float }`(`float` 后是 `y` 非 `=`)。*/
      if ((tk.kind === 'ident' || tk.kind === 'angle') && peek(1).kind === 'assign') break
      if (tk.kind === 'ident' || tk.kind === 'angle') {
        vs.push(next())
        continue
      }
      break
    }
    if (vs.length === 0) return { t: 'any' }
    return parseValue(vs, ctx)
  }

  /* 聚合块解析器 */
  function parseTypesBlock(o: CwtFile, line: number): void {
    // `{ type[X] = { ... } ... }`
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      if (!/^type\[/.test(h.key)) continue
      if (!at('assign')) continue
      next()
      const name = bracketOf(h.key)
      /* type[X] 的块里既有指令字段(path=... )也有结构定义(子条目)。
       * 靠「有没有 =」区分:`path = "..."` 是指令,`technology = { ... }` 是结构。*/
      const fields: Record<string, SpecEntry> = {}
      const structEntries: SpecEntry[] = []
      const subtypes: Record<string, SpecEntry[]> = {}
      if (at('lbrace')) {
        next()
        while (!at('rbrace') && !at('eof')) {
          const h2 = readDeclHead()
          if (!h2) break
          if (/^subtype\[/.test(h2.key)) {
            if (!at('assign')) continue
            next()
            const sname = bracketOf(h2.key)
            const sSpec = readSpec()
            const sEntries = sSpec.t === 'block' ? sSpec.entries : []
            /* ★ subtype 的顶层键过滤器藏在**它自己的指令注释**里:
             *   ```
             *   ## type_key_filter = country_event     ← 注释形式
             *   ## push_scope = country
             *   subtype[country_event] = { }
             *   ```
             *   不是写成 `subtype = { type_key_filter = ... }` 的字段。
             *   漏读它会导致「事件类型 → 实体 id」的映射表全空,
             *   连带 `<event.country_event>` 交叉引用与 unique 检查全部失效
             *   (实测 entity 映射为 0)。
             *   同时兼容字段形式,以防将来规则改成显式字段。*/
            const dirFilter = dirsOfTypeKeyFilter(h2.dirs)
            const fieldFilter = strList(sEntries.find((e) => e.key === 'type_key_filter'))
            const filter = fieldFilter.length ? fieldFilter : dirFilter
            subtypes[sname] = {
              name: sname,
              entries: sEntries,
              typeKeyFilter: filter,
              pushScope: strOf({ key: 'push_scope', spec: { t: 'scalar', name: dirVal(h2.dirs, 'push_scope') }, directives: h2.dirs, line: h2.line }),
              directives: h2.dirs,
              line: h2.line,
            }
            continue
          }
          if (at('assign')) {
            next()
            const v = readSpec()
            fields[h2.key] = { key: h2.key, spec: v, directives: h2.dirs, desc: h2.desc, line: h2.line }
          } else {
            structEntries.push({
              key: h2.key,
              spec: { t: 'scalar', name: h2.key },
              directives: h2.dirs,
              line: h2.line,
            })
          }
        }
        if (at('rbrace')) next()
      }
      o.types.push({
        name,
        path: strList(fields['path']),
        pathExtension: strOf(fields['path_extension']),
        skipRootKey: strOf(fields['skip_root_key']),
        typeKeyFilter: strList(fields['type_key_filter']),
        startsWith: strOf(fields['starts_with']),
        nameField: strOf(fields['name_field']),
        unique: boolOf(fields['unique']),
        typePerFile: boolOf(fields['type_per_file']),
        onlyIfNot: strList(fields['only_if_not']),
        pushScope: strOf(fields['push_scope']),
        entries: structEntries,
        subtypes,
        directives: h.dirs,
        desc: h.desc,
        file,
        line: h.line || line,
      })
    }
    if (at('rbrace')) next()
  }

  /* ── 聚合块解析器的共用前置 ──
   *
   * ★ 统一收口 directive/doc token 的处理。
   *   各聚合块(links/enums/scopes/...)的循环若只判 `kind !== 'ident'` 就 next(),
   *   会把块内的 `##` `###` 注释**直接丢掉**,导致该条目的指令/文档为空,
   *   且 clearPending 后状态错乱(实测 links 17→1、alias 1962→1856)。
   *
   *   用一个共享函数返回「本条声明的键 + 它自己的指令/文档」,
   *   五个解析器就不会各自漏判。
   */
interface DeclHead {
  key: string
  line: number
  dirs: Directive[]
  desc?: string
}

  /**
   * 跳过 directive/doc/裸噪声,直到遇到一个真ident 并消费它。
   * 返回 null 表示已到块尾(右花括号/EOF)。
   * 指令/文档在**遇到 ident 的那一刻**结算 —— 这正是 `.cwt` 的语义:
   * 注释作用于紧随其后的声明。
   */
  function readDeclHead(): DeclHead | null {
    while (!at('rbrace') && !at('eof')) {
      const tk = peek()
      if (tk.kind === 'directive') {
        next()
        const eq = tk.text.indexOf('=')
        pendingDirs.push({ key: tk.text.slice(0, eq).trim(), value: tk.text.slice(eq + 1).trim(), line: tk.line })
        continue
      }
      if (tk.kind === 'doc') {
        next()
        if (tk.text) pendingDoc.push(tk.text)
        continue
      }
      /* ★ string 也要能当键:`scopes = { "Unit Leader" = { ... } }`(scopes.cwt:96)。
       *   只收ident 会把 8 个引号键 next() 掉,scopes 只剩 4 条。*/
      if (tk.kind !== 'ident' && tk.kind !== 'string') {
        next()
        continue
      }
      // 命中 ident/string:结算本条声明的指令/文档
      const key = tk.text
      const lineNo = tk.line
      const dirs = pendingDirs
      const desc = curDesc()
      clearPending()
      next()
      return { key, line: lineNo, dirs, desc }
    }
    return null
  }

  function parseEnumsBlock(o: CwtFile): void {
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      const kt = { text: h.key, line: h.line }
      if (/^complex_enum\[/.test(h.key)) {
        if (!at('assign')) continue
        next()
        const name = bracketOf(h.key)
        const spec = readSpec()
        const entries = spec.t === 'block' ? spec.entries : []
        const f = (k: string) => entries.find((e) => e.key === k)
        o.enums.set(name, {
          name,
          path: strList(f('path')),
          startFromRoot: boolOf(f('start_from_root')),
          unique: boolOf(f('unique')),
          namePath: f('name')?.spec.t === 'block' ? (f('name')!.spec as { entries: SpecEntry[] }).entries : [],
          file,
          line: kt.line,
        } as ComplexEnum)
        continue
      }
      if (/^enum\[/.test(h.key)) {
        if (!at('assign')) continue
        next()
        const name = bracketOf(h.key)
        const spec = readSpec()
        const values =
          spec.t === 'block'
            ? spec.entries.map((e) => (e.spec.t === 'scalar' ? e.spec.name : e.key))
            : spec.t === 'scalar'
              ? [spec.name]
              : []
        o.enums.set(name, { name, values } as LiteralEnum)
        continue
      }
      // 其它键,跳过其值
      if (at('assign')) {
        next()
        readSpec()
      }
    }
    if (at('rbrace')) next()
  }

  function parseLinksBlock(o: CwtFile): void {
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      if (!at('assign')) continue
      next()
      const spec = readSpec()
      const entries = spec.t === 'block' ? spec.entries : []
      const f = (k: string) => entries.find((e) => e.key === k)
      o.links.set(h.key, {
        name: h.key,
        outputScope: strOf(f('output_scope')),
        inputScopes: identList(f('input_scopes')),
        prefix: strOf(f('prefix')),
        fromData: boolOf(f('from_data')),
        dataSource: f('data_source')?.spec,
        type: strOf(f('type')),
        desc: strOf(f('desc')) ?? h.desc,
        file,
        line: h.line,
      })
    }
    if (at('rbrace')) next()
  }

  function parseScopesBlock(o: CwtFile): void {
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      const label = h.key
      let aliases: string[] = []
      let subs: string[] = []
      if (at('assign')) {
        next()
        const spec = readSpec()
        if (spec.t === 'block') {
          const al = spec.entries.find((e) => e.key === 'aliases')
          const is = spec.entries.find((e) => e.key === 'is_subscope_of')
          aliases = al?.spec.t === 'block' ? al.spec.entries.map((e) => (e.spec.t === 'scalar' ? e.spec.name : e.key)) : []
          subs = is?.spec.t === 'block' ? is.spec.entries.map((e) => (e.spec.t === 'scalar' ? e.spec.name : e.key)) : []
        }
      }
      o.scopes.set(label, { label, aliases, isSubscopeOf: subs })
    }
  }

  function parseModifierCategoriesBlock(o: CwtFile): void {
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      let scopes: string[] = []
      if (at('assign')) {
        next()
        const spec = readSpec()
        if (spec.t === 'block') {
          const ss = spec.entries.find((e) => e.key === 'supported_scopes')
          scopes = ss?.spec.t === 'block' ? ss.spec.entries.map((e) => (e.spec.t === 'scalar' ? e.spec.name : e.key)) : []
        }
      }
      o.modifierCategories.set(h.key, { name: h.key, supportedScopes: scopes })
    }
  }

  function parseValuesBlock(o: CwtFile): void {
    // `values = { value[variable] = { <声明> } }`
    while (!at('rbrace') && !at('eof')) {
      const h = readDeclHead()
      if (!h) break
      if (!at('assign')) continue
      next()
      const spec = readSpec()
      if (/^value\[/.test(h.key)) {
        o.values.set(h.key, spec.t === 'block' ? spec.entries : [])
      }
    }
  }

  function parseLocCommandBlock(o: CwtFile): void {
    if (!at('lbrace')) return
    next()
    while (!at('rbrace') && !at('eof')) {
      const kt = peek()
      if (kt.kind === 'rbrace') {
        next()
        continue
      }
      /* ★ angle 也要能当键:`<scripted_loc> = any`(localisation.cwt:92)。
       *   只收 ident 会把 `<scripted_loc>` next() 掉,后面的值 `any`
       *   反被当成一个"命令名"收进去 —— 实测多出伪命令 `any`。*/
      if (kt.kind !== 'ident' && kt.kind !== 'angle') {
        next()
        continue
      }
      o.localisationCommands.add(kt.text)
      next()
      if (at('assign')) {
        next()
        readSpec()
      }
    }
    if (at('rbrace')) next()
  }

  return out
}

/* 从 `alias[effect:add_stability]` 取 ns 与 key */
function nsOf(text: string): string {
  const inner = bracketOf(text)
  const i = inner.indexOf(':')
  return i < 0 ? inner : inner.slice(0, i)
}
function keyOf(text: string): string {
  const inner = bracketOf(text)
  const i = inner.indexOf(':')
  return i < 0 ? '' : inner.slice(i + 1)
}
function bracketOf(text: string): string {
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a < 0 || b < 0) return text
  return text.slice(a + 1, b)
}

/** 取条目的字符串值 —— `path = "game/common/x"` 的引号已由 tokenizer 去掉。 */
function strOf(e: SpecEntry | undefined): string | undefined {
  if (!e) return undefined
  if (e.spec.t === 'scalar') return e.spec.name
  return undefined
}
/** 取条目的多值(块内裸词 / 重复键) */
function strList(e: SpecEntry | undefined): string[] {
  if (!e) return []
  if (e.spec.t === 'block') return e.spec.entries.map((x) => (x.spec.t === 'scalar' ? x.spec.name : x.key))
  if (e.spec.t === 'scalar') return [e.spec.name]
  return []
}
function identList(e: SpecEntry | undefined): string[] {
  return strList(e)
}
function boolOf(e: SpecEntry | undefined): boolean | undefined {
  if (!e) return undefined
  if (e.spec.t === 'scalar' && (e.spec.name === 'yes' || e.spec.name === 'no')) return e.spec.name === 'yes'
  return undefined
}

export interface CwtFile {
  file: string
  aliases: AliasRule[]
  singleAliases: SingleAlias[]
  types: TypeRule[]
  enums: Map<string, LiteralEnum | ComplexEnum>
  links: Map<string, LinkRule>
  scopes: Map<string, ScopeDef>
  modifierCategories: Map<string, ModifierCategory>
  values: Map<string, SpecEntry[]>
  localisationCommands: Set<string>
  /** 顶层裸结构声明(实体类型的内部结构) */
  structs: Map<string, StructDef>
  errors: { file: string; line: number; error: string }[]
}

/* ════════════════════════════════════════════════════════════════════
 * 四、加载整个规则目录
 * ════════════════════════════════════════════════════════════════════ */

export interface CwtRules {
  /** 合并后的 alias 索引:`ns:key` → 多条候选形态 */
  aliasIndex: Map<string, AliasRule[]>
  singleAliases: Map<string, SingleAlias>
  types: TypeRule[]
  enums: Map<string, LiteralEnum | ComplexEnum>
  links: Map<string, LinkRule>
  scopes: Map<string, ScopeDef>
  modifierCategories: Map<string, ModifierCategory>
  values: Map<string, SpecEntry[]>
  localisationCommands: Set<string>
  /** 顶层裸结构声明(实体类型的内部结构)—— 合并全库同名定义 */
  structs: Map<string, StructDef>
  files: string[]
  errors: { file: string; line: number; error: string }[]
}

export function isComplexEnum(e: LiteralEnum | ComplexEnum): e is ComplexEnum {
  return (e as ComplexEnum).path !== undefined
}

export function loadCwtRules(dir: string): CwtRules {
  const aliasIndex = new Map<string, AliasRule[]>()
  const singleAliases = new Map<string, SingleAlias>()
  const types: TypeRule[] = []
  const enums = new Map<string, LiteralEnum | ComplexEnum>()
  const links = new Map<string, LinkRule>()
  const scopes = new Map<string, ScopeDef>()
  const modifierCategories = new Map<string, ModifierCategory>()
  const values = new Map<string, SpecEntry[]>()
  const localisationCommands = new Set<string>()
  const structs = new Map<string, StructDef>()
  const files: string[] = []
  const errors: { file: string; line: number; error: string }[] = []

  const walkAll = (d: string): string[] => {
    const out: string[] = []
    let items: string[]
    try {
      items = readdirSync(d)
    } catch {
      return out
    }
    for (const nm of items) {
      const p = join(d, nm)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) out.push(...walkAll(p))
      else if (nm.endsWith('.cwt')) out.push(p)
    }
    return out
  }

  for (const abs of walkAll(dir).sort()) {
    const rel = relative(dir, abs).replace(/\\/g, '/')
    let src = ''
    try {
      src = readFileSync(abs, 'utf8')
    } catch (e) {
      errors.push({ file: rel, line: 0, error: `读取失败: ${String(e)}` })
      continue
    }
    const parsed = parseCwt(src, rel)
    files.push(rel)
    errors.push(...parsed.errors)
    for (const a of parsed.aliases) {
      const k = `${a.ns}:${a.key}`
      const arr = aliasIndex.get(k)
      if (arr) arr.push(a)
      else aliasIndex.set(k, [a])
    }
    for (const sa of parsed.singleAliases) singleAliases.set(sa.name, sa)
    for (const ty of parsed.types) types.push(ty)
    for (const [k, v] of parsed.enums) {
      /* complex_enum 同名时**合并 path**而非覆盖 —— 这是 CWTools 的语义。
       * `country_tags` 在 common/countries.cwt 与 common/country_tag_aliases.cwt
       * 各定义一次,后者注释明写 "this adds to the enum from countries.cwt";
       * 直接覆盖会丢掉 game/common/country_tags,导致国家 tag 校验全错。*/
      const prev = enums.get(k)
      if (prev && isComplexEnum(prev) && isComplexEnum(v)) {
        enums.set(k, {
          ...prev,
          path: [...new Set([...prev.path, ...v.path])],
          startFromRoot: prev.startFromRoot ?? v.startFromRoot,
          unique: prev.unique ?? v.unique,
          namePath: prev.namePath.length ? prev.namePath : v.namePath,
        } as ComplexEnum)
      } else {
        enums.set(k, v)
      }
    }
    for (const [k, v] of parsed.links) links.set(k, v)
    for (const [k, v] of parsed.scopes) scopes.set(k, v)
    for (const [k, v] of parsed.modifierCategories) modifierCategories.set(k, v)
    for (const [k, v] of parsed.values) values.set(k, v)
    for (const c of parsed.localisationCommands) localisationCommands.add(c)
    // 顶层结构定义跨文件合并(technology 在多个 DLC 文件里各声明一部分)
    for (const [k, v] of parsed.structs) {
      const prev = structs.get(k)
      if (prev) {
        prev.entries.push(...v.entries)
        if (!prev.desc) prev.desc = v.desc
        if (!prev.files.includes(v.file)) prev.files.push(v.file)
      } else {
        structs.set(k, v)
      }
    }
  }

  return {
    aliasIndex,
    singleAliases,
    types,
    enums,
    links,
    scopes,
    modifierCategories,
    values,
    localisationCommands,
    structs,
    files,
    errors,
  }
}

/* 便捷:定位规则库目录(相对本文件,保证 GitHub 可移植) */
export function defaultCwtDir(): string {
  // packages/engine/src/cwt.ts → packages/engine/cwt
  // ★ Windows 中文路径坑:import.meta.url 是 file:///D:/%E6%9D%82%E9%A1%B9/...,
  //   直接取 pathname 会拿到百分号编码路径,读目录必然失败(实测输出
  //   D:\%E6%9D%82\E9%A1%B9\...),必须 decodeURIComponent 还原。
  const here = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  return join(here, '..', 'cwt')
}

export { basename, existsSync }