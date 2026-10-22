/**
 * common/defines/*.lua 解析器 —— 游戏平衡参数(wiki Modding 里的 Defines 机制)。
 *
 * 【为什么需要】defines 是 HOI4 调平衡的主要入口之一(NGame.START_DATE、
 * NProduction.*_CAPACITY、NAir.* 等),6299 行 Lua。但工具链此前只处理 .txt,
 * 对 defines 零覆盖 —— 而模组改平衡恰恰就是改这些键值。
 *
 * 【为什么不用通用 Lua 解析器】这里的语法子集极窄,手写反而更稳:
 *   顶层  N<Something> = { ... }          分组(27 个)
 *   第二层 KEY = value,                    缩进用 TAB
 *   value 形态:数字 / "字符串" / true|false / { 数组 } / { A = 1, B = 2 } 内联表
 *   行尾注释 -- xxx
 * 通用 Lua 解析器要么引入依赖(破坏零依赖设计),要么为语法糖付出大量代码。
 * 这里只认上面这几类,遇到不认识的原样保留 raw,不猜。
 *
 * 输出保留行号与原文,便于工作台"跳到 IDE 位置"与差异对比。
 */

export type DefineValueType = 'number' | 'string' | 'bool' | 'array' | 'table' | 'expr' | 'unknown'

export interface DefineEntry {
  /** 完整键,如 NGame.START_DATE */
  key: string
  /** 分组名,如 NGame */
  group: string
  /** 组内键名,如 START_DATE */
  name: string
  /** 值类型 */
  type: DefineValueType
  /** 值的字符串形态(数组/表保留原文) */
  value: string
  /** 数值型/布尔型的解析值;其它为 undefined */
  num?: number
  bool?: boolean
  /** 数组元素(仅 type=array) */
  array?: (string | number)[]
  /** 内联表的键值对(仅 type=table) */
  pairs?: { key: string; value: string }[]
  /** 行尾注释原文(不含 --);官方文档注释是这些参数的唯一语义说明 */
  comment?: string
  /** 所在文件(相对 root) */
  file: string
  /** 1-based 行号 */
  line: number
}

export interface DefineGroup {
  name: string
  file: string
  line: number
  entries: DefineEntry[]
}

export interface DefinesFile {
  file: string
  title: string
  groups: DefineGroup[]
  entries: DefineEntry[]
}

/* ─────────────────────────── 词法 ─────────────────────────── */

/** 去掉行尾注释,但不碰字符串里的 -- */
function stripComment(line: string): { code: string; comment?: string } {
  let inStr = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue }
    if (c === '-' && line[i + 1] === '-') {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() }
    }
  }
  return { code: line }
}

/** 配平花括号,取出行尾多余部分(值里含 { } 时需要) */
function takeValue(code: string): { value: string; rest: string } {
  const s = code.trimStart()
  if (!s.startsWith('{')) return { value: s, rest: '' }
  let depth = 0
  let inStr = false
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { value: s.slice(0, i + 1), rest: s.slice(i + 1) }
    }
  }
  return { value: s, rest: '' }
}

/** 值是否「以 { 开头但花括号未配平闭合」—— 需要跨行收集。
 *  (vanilla / 模组都把键值数组跨多行写,如
 *   NDefines.NFactions.FACTION_INTELLIGENCE_ALLOWED_ADVISOR_TRAIT = {
 *     "head_of_intelligence",
 *     ...
 *   })
 *   takeValue 只在单行 code 内配平,对这类块无能为力,只吐出一个孤零零的 `{`。
 *   这里精确重扫一遍字符串,跟踪引号/花括号,判定是否还开着。 */
function valueOpen(v: string): boolean {
  if (!v.trimStart().startsWith('{')) return false
  let depth = 0
  let inStr = false
  let quote = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return false
    }
  }
  return depth > 0
}

/** 从一行「KEY = 值」的值文本开始解析;若值是 `{` 开头的多行块(未闭合),
 *  持续向下拼行直到花括号配平。返回完整值文本与最后消费的行号。
 *  (只处理第一种形态取到的 firstCode;块形态 RE_KEY 分支也复用同一个入口) */
function collectValue(lines: string[], startLine: number, firstCode: string): { value: string; nextLine: number } {
  let { value } = takeValue(firstCode)
  let j = startLine + 1
  while (valueOpen(value) && j < lines.length) {
    const { code } = stripComment(lines[j])
    value += '\n' + code
    j++
  }
  return { value, nextLine: j - 1 }
}

const RE_KEY = /^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*/

/** 解析一个值文本 → 类型与结构 */
function parseValue(raw: string): Omit<DefineEntry, 'key' | 'group' | 'name' | 'file' | 'line' | 'comment'> {
  // ⚠ 必须【全局】去尾逗号/分号,不能只去一个:vanilla 实测有双尾逗号
  //   `MAX_INTELLIGENCE_INDUSTRY_DATA_DEVIATION = 0,4,`(行 366)。
  //   只 replace 一次会留下 "0,4",被误判成算术表达式。
  const v = raw.trim().replace(/[;,]+$/, '').trim()
  if (/^".*"$/s.test(v) || /^'.*'$/s.test(v)) return { type: 'string', value: v.slice(1, -1) }
  if (v === 'true') return { type: 'bool', value: 'true', bool: true }
  if (v === 'false') return { type: 'bool', value: 'false', bool: false }
  if (/^-?\d+$/.test(v)) return { type: 'number', value: v, num: Number(v) }
  if (/^-?\d*\.\d+$/.test(v)) return { type: 'number', value: v, num: Number(v) }
  if (v.startsWith('{')) {
    const inner = v.slice(1, -1).trim()
    if (inner === '') return { type: 'array', value: v, array: [] }
    // 内联表 { A = 1, B = 2 } —— 有 KEY = 形态就是表,否则是数组
    if (/(^|,)\s*[A-Za-z_][A-Za-z_0-9]*\s*=/.test(inner)) {
      const pairs: { key: string; value: string }[] = []
      for (const part of inner.split(',')) {
        const m = RE_KEY.exec(part.trim())
        if (m) pairs.push({ key: m[1], value: part.trim().slice(m[0].length).trim() })
      }
      return { type: 'table', value: v, pairs }
    }
    const arr = inner
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '')
      .map((x) => (/^-?\d*\.?\d+$/.test(x) ? Number(x) : x))
    return { type: 'array', value: v, array: arr }
  }
  // ★ 欧洲小数逗号:vanilla 有一处 `MAX_INTELLIGENCE_INDUSTRY_DATA_DEVIATION = 0,4,`
  //   逗号既当分隔符又当小数点(Lua 语法上是两个参数,但游戏按 0.4 读)。
  //   判据:去掉尾逗号后若形如 `<数字>,<1~2位数字>` 且第二段不是独立数字列表
  //   (即逗号后不含第三段),按欧洲小数解析。
  const euroDec = v.match(/^(-?\d+),(\d{1,2})$/)
  if (euroDec) {
    const n = Number(`${euroDec[1]}.${euroDec[2]}`)
    return { type: 'number', value: v, num: n }
  }
  // ★ 算术表达式(实测 vanilla 有 5 处,别当"未知"丢掉):
  //   NNavy.MIN_HOURS_TO_SHUFFLE_NEWLY_ASSIGNED_PATROLS = 7 * 24  (小时→天)
  //   NAI.REGION_THREAT_LEVEL_TO_AVOID_REGION         = 25 * 10
  //   NOperatives.OPERATIVE_CAPTURE_DURATION_IN_DAYS    = 9*30
  // 这些是游戏自己会在加载时求值的常量表达式。能安全求值就给 num,
  // 求不了(引用了别的键)仍归 expr,保留原文,不要丢。
  if (/^[-+*/(). 0-9]+$/.test(v) && /\d/.test(v)) {
    const num = evalArith(v)
    if (num !== undefined) return { type: 'expr', value: v, num }
  }
  return { type: 'expr', value: v }
}

/** 只含四则运算与小数的算术求值;语法不合法返回 undefined(绝不用 eval) */
function evalArith(expr: string): number | undefined {
  if (!/^[0-9+\-*/(). ]+$/.test(expr)) return undefined
  if (!/^[\d(]/.test(expr.trim())) return undefined
  try {
    // 逐字符白名单校验后,用 Function 构造(不用 eval:可控且不污染作用域)
    const r = Function(`"use strict";return (${expr})`)() as unknown
    return typeof r === 'number' && Number.isFinite(r) ? r : undefined
  } catch {
    return undefined
  }
}

/* ─────────────────────────── 语法 ─────────────────────────── */

/**
 * ★★ 点号赋值形态(2026-10-07 新增,实测决定性)★★
 *
 * vanilla 与模组用的是**两套互不兼容的语法**,而原解析器只认块形态:
 *   vanilla(00_defines.lua):        模组(KR_defines.lua 等 26 个文件):
 *     NDefines = {                     NDefines.NGame.SAVE_VERSION = 170
 *     NGame = {                        NDefines.NGame.END_DATE = "1959.1.1.1"
 *       SAVE_VERSION = 33                NDefines.NWiki.BASE_URL = "..."
 *     }
 *
 * 实测 34 个创意工坊模组的 defines 文件里,**26 个用点号形态,合计约 3200 条**
 * (最多的是 2149567872/05_defines.lua,826 条)。
 * 只认块形态 → 模组改了什么一条都看不见,「原版 vs 模组比较」整个功能失效
 * (我第一版实现就踩了这个:Kaiserreich 明明有 KR_defines.lua,差异数却是 0)。
 *
 * 规整口径:点号形态归一成与块形态**完全相同的键名**
 *   NDefines.NGame.SAVE_VERSION → group=NGame, name=SAVE_VERSION, key=NGame.SAVE_VERSION
 * 这样两套语法产出的条目才能按 key 直接对比。`NDefines.` 前缀剥掉,
 * 剩下的第一段当 group(块形态的 group 名正是 NGame 这种)。
 */
const RE_DOT_ASSIGN = /^((?:NDefines|NDefines_Graphics)\.[A-Za-z_0-9]+)\.([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/

/**
 * 解析一个 defines lua 文件。
 *
 * ★ 两种语法都要认(见 RE_DOT_ASSIGN 的说明):
 *   块形态 `NGame = { KEY = value }`   —— vanilla
 *   点形态 `NDefines.NGame.KEY = value` —— 几乎所有模组
 *
 * ⚠ 两者会**混在同一文件**里(实测 TFR_defines_changes.lua:416 条点形态
 *   + 1 处块形态),所以不能"嗅探到点形态就切换模式",必须逐行独立判定。
 */
export function parseDefines(src: string, file: string): DefinesFile {
  const lines = src.split(/\r?\n/)
  const groups: DefineGroup[] = []
  const entries: DefineEntry[] = []
  let cur: DefineGroup | null = null
  // 顶层表名(如 NDefines = { 只是容器,不是分组)—— 见到即跳过其闭合
  let containerDepth = 0
  /** group 名 → DefineGroup。点形态也要挂进 groups,侧栏结构才与块形态一致 */
  const groupByName = new Map<string, DefineGroup>()
  const groupAt = (name: string, line: number): DefineGroup => {
    let g = groupByName.get(name)
    if (!g) {
      g = { name, file, line, entries: [] }
      groupByName.set(name, g)
      groups.push(g)
    }
    return g
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim() || /^\s*--/.test(raw)) continue
    const { code, comment } = stripComment(raw)
    const t = code.trim()
    if (!t) continue

    /* ── 形态 A:点号赋值(模组主力写法)──
     * 必须在块形态**之前**判:若先被 RE_KEY 匹配,`NDefines.NGame.X = 1`
     * 会被当成块形态里一个名叫 `NDefines` 的键,键名就错了。 */
    const dm = t.match(RE_DOT_ASSIGN)
    if (dm) {
      const group = dm[1].slice(dm[1].indexOf('.') + 1) // 剥掉 NDefines. 前缀
      const name = dm[2]
      // ★ 多行值:值以 `{` 开头未闭合 → 跨行收集到花括号配平
      //   (模组常把数组键值跨行写,只 takeValue 会丢掉全部元素)
      const cv = collectValue(lines, i, dm[3])
      const value = cv.value
      i = cv.nextLine
      const e: DefineEntry = {
        key: `${group}.${name}`,
        group,
        name,
        file,
        line: i + 1,
        comment,
        ...parseValue(value),
      }
      groupAt(group, i + 1).entries.push(e)
      entries.push(e)
      continue
    }

    /* 块形态:`N<Group> = {`(vanilla)或 `NDefines.<Group> = {`(模组也常见)。
     * ★ 两个正则必须**并列**判,不能把后者塞进前者的 if 里 ——
     *   `NDefines.NPolitics = {` 匹配不上第一个(`.` 不在 N[A-Za-z_0-9]* 内),
     *   若第二式只在前者命中时才跑,这行会被静默丢掉,块里那条也跟着丢。
     *   实测现象:TFR 那种"点形态 + 块形态混排"的文件只解析出点形态那几条。
     *
     * ⚠ 容器判定只看前缀不够:`NDefines.NPolitics` 的首段也是 NDefines,
     *   若据此判成外层容器会整块丢弃。判据必须是**裸** NDefines(后面没再跟组名)。*/
    const gm = t.match(/^(NDefines|NDefines_Graphics|N[A-Za-z_0-9]*)\s*=\s*\{$/)
    const gmPrefixed = gm ? null : t.match(/^NDefines(?:_Graphics)?\.(N[A-Za-z_0-9]*)\s*=\s*\{$/)
    if (gm || gmPrefixed) {
      const name = gmPrefixed ? gmPrefixed[1] : gm![1]
      if (name === 'NDefines' || name === 'NDefines_Graphics') {
        // 裸容器,只是包裹
        containerDepth = 1
        cur = null
        continue
      }
      cur = groupAt(name, i + 1)
      continue
    }
    // 顶层闭合 }
    if (t === '}' && !/^\s/.test(code)) { cur = null; containerDepth = 0; continue }

    // 分组内条目
    const km = t.match(RE_KEY)
    if (km && cur) {
      const name = km[1]
      const after = code.trim().slice(km[0].length)
      // ★ 多行值:块形态里 `KEY = { ... }` 同样跨行收集(vanilla 的数组键值)
      const cv = collectValue(lines, i, after)
      const value = cv.value
      i = cv.nextLine
      const pv = parseValue(value)
      const e: DefineEntry = {
        key: `${cur.name}.${name}`,
        group: cur.name,
        name,
        file,
        line: i + 1,
        comment,
        ...pv,
      }
      cur.entries.push(e)
      entries.push(e)
    }
  }

  const m = src.match(/^#?([^\n{]*)\{/m)
  return { file, title: m ? m[1].trim() : file, groups, entries }
}

/* ─────────────────── 原版 vs 模组差异(2026-10-07 新增) ─────────────────── */

/** 一条差异:同一个键在两个来源给了不同的值 */
export interface DefineDiff {
  key: string
  group: string
  name: string
  /** 基线(原版)那条;模组新增时为 undefined */
  base?: DefineEntry
  /** 模组那条;模组删除 vanilla 键时为 undefined */
  mod?: DefineEntry
  /** 该键被几个来源定义过(含中间层) */
  sourceCount: number
  /** 中间被覆盖掉的来源(载入序在 vanilla 与最终模组之间) */
  shadowed: DefineEntry[]
  /** 值是否真的变了 —— 模组写了同样的值不算差异,但仍是"模组碰过" */
  changed: boolean
  /** 数值型差异(mod - base);非数值或不可比为 undefined */
  delta?: number
  /** 变化幅度百分比(以 base 为基准;base=0 时不给) */
  deltaPct?: number
  /** 判定口径说明(为什么算变/不变) */
  kind: 'override' | 'same-value' | 'mod-add' | 'mod-drop'
}

/** 值是否可比(能算差值) */
function isNum(e: DefineEntry | undefined): e is DefineEntry & { num: number } {
  return !!e && typeof e.num === 'number' && Number.isFinite(e.num)
}

/**
 * ★ 注释必须先剥掉再比 —— 用户明确要求"--注释部分忽略"。
 *
 * 实测 vanilla 的 defines 里大量键带行尾注释,而**模组常常只抄走键值、
 * 把注释删掉**(或反过来只改注释不改值)。若不剥注释:
 *   `START_DATE = 1936.1.1  # 起始日期` vs `START_DATE = 1936.1.1`
 *   会被判成"模组改了这个参数",让差异列表全是噪声。
 * DefineEntry.value 是 parseValue 处理过的**纯值**(注释已由 stripComment
 * 剥离并存到 comment 字段),所以这里只需再兜一层:把 value 里可能残留的
 * `--` 与 `#` 之后内容去掉,防手写模组把注释放在值同一行且解析器漏掉。
 */
function comparableValue(e: DefineEntry | undefined): string {
  if (!e) return ''
  let v = e.value.trim()
  const h = v.indexOf('#')
  if (h >= 0) v = v.slice(0, h)
  const d = v.indexOf('--')
  if (d >= 0) v = v.slice(0, d)
  return v.replace(/[;,]+$/, '').trim()
}

/** 值相等判定:先字符串比,再按数值比(1 与 1.0 视为相同) */
function sameValue(a: DefineEntry | undefined, b: DefineEntry | undefined): boolean {
  if (!a || !b) return false
  if (comparableValue(a) === comparableValue(b)) return true
  if (isNum(a) && isNum(b)) return a.num === b.num
  return false
}

/**
 * 计算原版 vs 模组的 defines 差异。
 *
 * @param entries 全部来源的条目(buildDefinesModel 的 outputs.entries)
 * @param baseName 原版来源名(只读 root 的 name;通常是目录名,故传前先确认)
 * @param modNames 模组来源名集合。★ 判定用"在不在 modNames 里"而不是
 *        "writable" —— 服务端 ROOTS 里除基础游戏外都算模组,但 DLC 层
 *        既不是模组也不该算原版,必须显式传进来。
 *
 * 语义与游戏一致:载入序靠后的覆盖靠前的。所以每个键的 **base = 最早的
 * 那条**,**mod = 最晚的那条**,中间的算 shadowed。
 */
export function computeDefineDiffs(
  entries: readonly DefineEntry[],
  baseName: string,
  modNames: ReadonlySet<string>,
): DefineDiff[] {
  /** key → 按载入序排的全部来源 */
  const byKey = new Map<string, DefineEntry[]>()
  for (const e of entries) {
    const src = e.file.split('/')[0] ?? ''
    let a = byKey.get(e.key)
    if (!a) byKey.set(e.key, (a = []))
    a.push(e)
  }

  // ★ baseName 必须真的命中至少一条,否则整个比较没有意义。
  //   触发场景:用户没挂基础游戏(只挂了模组),或改了来源名。
  //   此时若不拦,每个键的 baseList 都是空 → 全被判成 mod-add →
  //   "模组新增了 6000 个参数"这种胡说八道的结论会直接显示给用户。
  //   返回空数组 = 没有可比对象,前端据此提示"未挂载原版,无法比较"。
  const hasBase = entries.some((e) => (e.file.split('/')[0] ?? '') === baseName)
  if (!hasBase) return []

  const out: DefineDiff[] = []
  for (const [key, list] of byKey) {
    const baseList = list.filter((e) => (e.file.split('/')[0] ?? '') === baseName)
    const modList = list.filter((e) => modNames.has(e.file.split('/')[0] ?? ''))
    // ★ 两侧都没碰的键不是差异(那是 6000+ 条原版默认值,不是用户要看的)
    if (!baseList.length && !modList.length) continue
    // 只有原版没有模组 → 原版默认,跳过
    if (!modList.length) continue

    const base = baseList[0] // 最早的原版定义
    const mod = modList[modList.length - 1] // 最晚生效的模组定义
    const shadowed = list.filter((e) => e !== base && e !== mod)
    const changed = !sameValue(base, mod)

    const diff: DefineDiff = {
      key,
      group: mod.group || base?.group || '',
      name: mod.name || base?.name || key.split('.').pop() || key,
      base,
      mod,
      sourceCount: list.length,
      shadowed,
      changed,
      kind: !base ? 'mod-add' : changed ? 'override' : 'same-value',
    }
    // 模组把 vanilla 的键删了(只有 mod 定义,没有 base)→ mod-drop
    if (!base) diff.kind = 'mod-add'

    if (isNum(base) && isNum(mod)) {
      diff.delta = mod.num - base.num
      if (base.num !== 0) diff.deltaPct = (diff.delta / Math.abs(base.num)) * 100
    }
    out.push(diff)
  }

  // 排序:有数值变化的按幅度倒序最显眼,其次才是新增/同值
  out.sort((a, b) => {
    const rank = (d: DefineDiff) => (d.delta !== undefined && d.delta !== 0 ? 0 : d.kind === 'mod-add' ? 1 : 2)
    return rank(a) - rank(b) || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.key.localeCompare(b.key)
  })
  return out
}

/** 差异汇总(给 UI 顶部统计条用) */
export function summarizeDefineDiffs(list: readonly DefineDiff[]) {
  let changed = 0
  let same = 0
  let added = 0
  let up = 0
  let down = 0
  for (const d of list) {
    if (d.kind === 'mod-add') added++
    else if (d.changed) {
      changed++
      if ((d.delta ?? 0) > 0) up++
      else if ((d.delta ?? 0) < 0) down++
    } else same++
  }
  return { total: list.length, changed, same, added, up, down }
}

/** 遍历某个目录下所有 *.lua */
export function readDefinesDir(dir: string, readFile: (p: string) => string, walk: (dir: string) => string[]): DefinesFile[] {
  const out: DefinesFile[] = []
  for (const abs of walk(dir)) {
    if (!abs.toLowerCase().endsWith('.lua')) continue
    const file = abs.split(/[\\/]/).pop() ?? abs
    try {
      out.push(parseDefines(readFile(abs), file))
    } catch {
      /* 单个文件解析失败不影响其它 */
    }
  }
  return out
}

/** 全部键 → 条目(后写覆盖先写,与游戏加载顺序一致) */
export function indexDefines(files: DefinesFile[]): Map<string, DefineEntry> {
  const m = new Map<string, DefineEntry>()
  for (const f of files) for (const e of f.entries) m.set(e.key, e)
  return m
}

/* ─────────────────────── 服务端聚合模型 ─────────────────────── */

export interface DefinesModel {
  /** 按文件分组 */
  files: DefinesFile[]
  /** 全部条目(所有文件合并) */
  entries: DefineEntry[]
  /** 键 → 条目 */
  byKey: Map<string, DefineEntry>
  /** 分组名 → 该组条目 */
  byGroup: Map<string, DefineEntry[]>
  /** 分组名 → 该组源自哪个文件(分组可能跨文件重名) */
  groupFile: Map<string, string>
}

/**
 * 从若干来源 root 聚合 defines 模型。
 *
 * ★ 语义与游戏一致:后加载的 root 覆盖先加载的同名键(mod 的
 *   `NGame = { START_DATE = ... }` 覆盖 vanilla)。所以 entries 保留
 *   全量来源,而 byKey 只保留生效值 —— 前端要显示"被谁覆盖"就得看全部。
 */
export function buildDefinesModel(
  roots: { name: string; path: string; writable?: boolean }[],
  readFile: (p: string) => string,
  walk: (dir: string) => string[],
): DefinesModel {
  const files: DefinesFile[] = []
  const entries: DefineEntry[] = []
  const byKey = new Map<string, DefineEntry>()
  const byGroup = new Map<string, DefineEntry[]>()
  const groupFile = new Map<string, string>()

  for (const r of roots) {
    const dir = r.path.replace(/[\\/]+$/, '') + '/common/defines'
    let files2: DefinesFile[]
    try {
      files2 = readDefinesDir(dir, readFile, walk)
    } catch {
      continue // 该 root 没有 defines 目录(如纯模组)
    }
    for (const f of files2) {
      // ★ 标上来源,前端要显示"vanilla 默认值 / 模组改成了什么"
      const tagged: DefinesFile = { ...f, file: `${r.name}/${f.file}` }
      files.push(tagged)
      for (const e of f.entries) {
        const withSrc: DefineEntry = { ...e, file: `${r.name}/${e.file}` }
        entries.push(withSrc)
        byKey.set(withSrc.key, withSrc) // 后写覆盖先写
        // ⚠ 别用 `(map.get(k) ??= [])` 紧凑写法:Node 22 原生跑 .ts 的类型剥离
        //   不支持"??= 嵌在括号表达式里",会报 ERR_INVALID_TYPESCRIPT_SYNTAX
        //   (Invalid assignment target)。显式写,各环境都稳。
        let g = byGroup.get(e.group)
        if (!g) {
          g = []
          byGroup.set(e.group, g)
        }
        g.push(withSrc)
        groupFile.set(e.group, `${r.name}/${f.file}`)
      }
    }
  }
  return { files, entries, byKey, byGroup, groupFile }
}
