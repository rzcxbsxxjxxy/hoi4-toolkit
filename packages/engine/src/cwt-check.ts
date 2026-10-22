/**
 * CWTools 规则执行引擎 —— 把 `.cwt` 声明的规则应用到实际脚本上,产出诊断。
 *
 * ## 与既有 validate.ts 的分工(为什么不把规则塞进 validate.ts)
 *
 * `validate.ts` 是**硬编码检查项**:语法、括号、重复定义、悬空 sprite/loc 键。
 * 它快(全量 48 s)、无外部依赖,但每加一类内容就要改代码,只覆盖我们specialsize过的几个域。
 *
 * 本模块是**声明式规则驱动**:校验知识全在 `packages/engine/cwt/` 的 111 个规则文件里
 * (1962 条 alias + 120 个结构定义 + 152 个枚举),引擎只写「规则 + 泛型匹配」。
 * 新增一类校验 = 新增一段规则文本,零代码改动。
 *
 * ## 实现的校验类别
 *
 *  1. **存在性**:effect / trigger / modifier / gui 元素拼错 → 最高频的模组错误
 *  2. **值域**:`float[0..1]` 写成 5.0、`int[0..20]` 写成 30
 *  3. **枚举**:`enum[phase]` 的值不在集合内
 *  4. **交叉引用**:`<state>` / `<technology>` / `<spriteType>` 指向不存在的条目
 *  5. **本地化键缺失**:`= localisation` 形态的位置引用了没定义的 key
 *  6. **重复定义**:`unique = yes` 的 id 重复
 *  7. **未知键**(保守):块内出现结构定义里没有的键
 *
 * ## ★ 性能:唯一瓶颈是「同一份字节被反复 parse」
 *
 * 优化前的实测(vanilla,`ensureIndexes([{vanilla}], GAME)`):
 *   `collectEnums` 33 s+ `buildTypeIndex` 30 s,合计 >500 s 才跑完(叠加目录树遍历)。
 *   根因不是目录遍历(实测 walkTxt 全部加起来只有 4.2 s),而是:
 *   104 个 type path 互相父子重叠(`game/common` ⊃ `game/common/ideas` …),
 *   29 个 complex_enum 又有各自的 path,于是磁盘上4759 个唯一文件 /
 *   132 MB 被展开成 **21799 次 parse / 525 MB** —— 同一份内容最多被 parse 4 次。
 *
 * 现在的做法(`buildIndexes`):
 *   1. root 去重(顺带修掉「同一目录扫两遍」产生的 387 条假 duplicate-id)
 *   2. 目录清单按绝对目录缓存
 *   3. **path → 文件 → 消费者** 两段展开:一个文件只 `readFileSync`+`parse` 一次,
 *      命中的所有 type 与所有枚举都喂给这同一个 `Document`
 *   4. parse 前用 `String.includes` 做子串预筛(枚举采集路径全是字面量 key,足够判定)
 *   5. subtype 查表预编译,不在热循环里反复 `Object.entries`
 *   6. 不存在的 path 直接跳过并计数
 *
 * 实测:vanilla 全量建索引 63 s → 6 s 量级(见 `_acc_rules_perf.ts`)。
 * 对外 API 语义不变,`resetIndexCache()` / `resetRulesCache()` 保留。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf, operator } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import {
  loadCwtRules,
  defaultCwtDir,
  isComplexEnum,
  type CwtRules,
  type AliasRule,
  type ValueSpec,
  type SpecEntry,
  type Directive,
  type ComplexEnum,
  type LiteralEnum,
  type StructDef,
  type TypeRule,
} from './cwt.ts'

/* ════════════════════════════════════════════════════════════════════
 * 一、诊断类型
 * ════════════════════════════════════════════════════════════════════ */

export type Severity = 'error' | 'warning' | 'info'

export interface Diag {
  /** 诊断类别(前端分组筛选用) */
  code: string
  severity: Severity
  root: string
  file: string
  rel: string
  line?: number
  /** 一句话说明(中文,面向用户) */
  message: string
  key?: string
  value?: string
  /** 规则出处,便于回答「为什么报这条」 */
  rule?: { file: string; line: number; desc?: string }
}

export interface RuleCheckRoot {
  name: string
  path: string
}

export interface RuleCheckReport {
  diags: Diag[]
  stats: { error: number; warning: number; info: number; byCode: Record<string, number> }
  ruleErrors: { file: string; line: number; error: string }[]
  ruleCount: { aliases: number; structs: number; types: number; enums: number }
}

export interface RuleCheckOpts {
  /** 只报这些来源的问题;不传=全报。判定上下文仍含全部来源 + vanilla。 */
  scope?: string[]
  /** 游戏根目录(vanilla) */
  gameRoot: string
  /** 本地化键集合(全来源合并) */
  locKeys?: Set<string>
  /** sprite 名集合(全来源合并) */
  spriteNames?: Set<string>
  /** 进度回调(done/total 未知时 total=0) */
  onProgress?: (done: number, total: number, phase: string) => void
}

/* ════════════════════════════════════════════════════════════════════
 * 二、规则库加载(进程内缓存)
 * ════════════════════════════════════════════════════════════════════ */

let CACHED_RULES: CwtRules | null = null

/** 规则库只与文件内容有关,111 个文件约 150 ms,进程内缓存即可 */
export function getRules(): CwtRules {
  if (!CACHED_RULES) CACHED_RULES = loadCwtRules(defaultCwtDir())
  return CACHED_RULES
}
/** 规则库文件变更后调用(开发期用) */
export function resetRulesCache(): void {
  CACHED_RULES = null
  INDEX_CACHE = null
  TOPKEY_STRUCT = null
}

/* ════════════════════════════════════════════════════════════════════
 * 三、索引:枚举反向采集 / 类型实体名 / sprite
 * ════════════════════════════════════════════════════════════════════ */

export interface EnumIndex {
  /** 枚举名 → 合法值集合(complex_enum 从真实数据反向采集) */
  values: Map<string, Set<string>>
  /** 字面量枚举的声明(用于错误提示里列可选值) */
  declared: Map<string, LiteralEnum>
}

/** 建索引过程的统计(**附加信息,不参与任何判定**,便于验收与排查性能) */
export interface IndexStats {
  /** 唯一文件数 = 实际 readFileSync 次数 = 实际 parse 次数 */
  filesScanned: number
  /** 参与扫描的 root 数(已剔除与 gameRoot / 前序 root 重复的) */
  rootsScanned: number
  /** 被去重掉的 root(与前面的 root 指向同一物理目录) */
  rootsDeduped: string[]
  /** 去重后的目标 path 数(type 与 complex_enum 的 path 并集) */
  pathTotal: number
  /** 因路径不存在而整体跳过的目标数 */
  pathMissing: number
  /** 目录清单缓存命中次数(省下的 readdir 次数) */
  dirCacheHits: number
  /** 现状会做但被合并掉的「文件 × path」冗余对数 */
  redundantPathPairs: number
  /** 被子串预筛跳过的「文件 × 枚举」组合数 */
  enumPreSkips: number
  /** parse 总耗时(ms) */
  parseMs: number
  /** 扫描(遍历 AST)总耗时(ms) */
  scanMs: number
}

/**
 * 采集 complex_enum —— **从用户真实数据反向采集**,不硬编码。
 *
 * 这是 CWTools 最值得移植的设计:枚举值来自 mod/vanilla 的实际文件,
 * 所以天然适配任意模组,而不是只认原版那一套。
 *
 * ★ 性能:见 `buildIndexes` 的说明。核心是**一个文件只 parse 一次**,
 *   命中的所有枚举 / type 全部喂给同一个 Document。
 */
export function collectEnums(rules: CwtRules, gameRoot: string, roots: string[]): EnumIndex {
  return buildIndexes(rules, roots.map((p) => ({ name: '', path: p })), gameRoot, {
    enums: true,
    types: false,
  }).enums
}

/* ── 目录清单缓存:同一次建索引内,每个物理目录只 readdir 一次 ── */

/**
 * 为什么快:vanilla 的 100 个 type path 存在大量**父子重叠**
 * (`game/common` ⊃ `game/common/ideas`、`game/map` ⊃ `game/map/strategicregions` …)。
 * 实测 104 个 path 覆盖 4759 个唯一 .txt,却展开出 7472 个「文件 × path」对,
 * 其中 2431 个文件被 ≥2 个 path 覆盖(单文件最多被重复扫 4 次)。
 * 不缓存时同一棵目录树会被 readdir 若干遍 —— 光 `game/gfx` 一次 walk 就要 1.4 s。
 *
 * 缓存键是**绝对目录**,深度上限相对入口目录计算,因此同目录复用结果始终等价。
 */
class DirScan {
  private cache = new Map<string, string[]>()
  private maxDepth: number
  hits = 0

  constructor(maxDepth = 6) {
    this.maxDepth = maxDepth
  }

  walk(dir: string, depth = 0): string[] {
    if (depth > this.maxDepth) return []
    const hit = this.cache.get(dir)
    if (hit) {
      this.hits++
      return hit
    }
    const out: string[] = []
    let items: string[]
    try {
      items = readdirSync(dir)
    } catch {
      this.cache.set(dir, out)
      return out
    }
    for (const nm of items) {
      const p = join(dir, nm)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) out.push(...this.walk(p, depth + 1))
      else if (nm.toLowerCase().endsWith('.txt')) out.push(p)
    }
    this.cache.set(dir, out)
    return out
  }
}

/* ── 子串预筛:在 parse 之前判断「这个文件有没有可能命中这个枚举」── */

/**
 * `harvestNames` 全程用 `keyText(doc, e) !== step.key` 做**字面量**比较,
 * 所以「文件文本里根本不出现这个 key」⇒ 必然采集不到任何值。
 * 于是 parse 前一次 `String.includes` 就能把整个文件跳过。
 *
 * 为什么值得做(vanilla 实测):最贵的 6 个 complex_enum 全部挂在 `game/common`
 * —— 2218 个文件 / 62 MB,每个枚举各扫一遍 = 6 × 62 MB ≈ **26 s**。
 * 而它们的 namePath 首段是 `phases` / `script_enum_advisor_slot_type` /
 * `script_enum_equipment_category` / `script_enum_equipment_bonus_type` /
 * `script_enum_production_stat` / `script_enum_equipment_stat`,
 * 这些 key 只出现在 `common/script_constants.txt` 等极少数文件里。
 * 预筛把这 6 个枚举的 13308 次 parse 压到个位数。
 *
 * 返回 null = 不做预筛(保守,一律 parse)。
 */
function enumGuard(def: ComplexEnum): string[] | null {
  if (def.namePath.length === 0) return null
  const segs: string[] = []
  for (const s of def.namePath) {
    if (!s.key) return null
    segs.push(s.key)
  }
  return segs
}

/** type 的预编译产物 */
interface TypePlan {
  ty: TypeRule
  /**
   * key → subtype 名。
   *
   * 原实现在**每个 entry 的循环里**重建 `Object.entries(ty.subtypes)` 并 linear 查找
   * —— 对 `combat_tactic` 这种无 skipRootKey、需深递归全树的 type,
   * 会在 62 MB / 数百万个 entry 上反复分配数组。这里一次算好。
   */
  subOf: Map<string, string>
}

function planType(ty: TypeRule): TypePlan {
  const subOf = new Map<string, string>()
  /* ★ subtype 现在自带 `typeKeyFilter`(解析器已从指令注释里读出),
   * 直接用即可 —— 规则原文就是这么写的:
   *   ## type_key_filter = country_event
   *   subtype[country_event] = { }
   * 以前这里找不到过滤器(它是指令不是字段),导致「事件类型 → 实体 id」
   * 映射表全空,连带 `<event.country_event>` 交叉引用与 unique 检查失效。*/
  for (const [sname, sdef] of Object.entries(ty.subtypes ?? {})) {
    for (const k of sdef.typeKeyFilter ?? []) {
      // 按 subtypes 声明顺序,第一个命中者胜出(与旧实现同序)
      if (k && !subOf.has(k)) subOf.set(k, sname)
    }
  }
  return { ty, subOf }
}

/* ── 统一扫描:一个文件只 parse 一次,喂给所有命中的 type 与枚举 ── */

interface FileConsumers {
  /** 归属 root 名(用于 duplicate-id 的定位与 scope 过滤) */
  rootName: string
  /** `rootName/相对路径`(诊断里展示) */
  label: string
  types: TypePlan[]
  enums: { name: string; def: ComplexEnum }[]
}

export interface IndexDeps extends RuleCheckDeps {
  stats: IndexStats
}

/**
 * ★ 本模块的性能核心。
 *
 * ## 为什么原来的写法跑不完
 *
 * 现状(实测,vanilla):
 *   - `collectEnums` 33 s:29 个 complex_enum 各自 walkTxt + parse,
 *     其中 6 个挂在 `game/common`(2218 文件 / 62 MB)→ 光这一项 26 s。
 *   - `buildTypeIndex` 30 s:按 path 分组已经避免了「229 个 type 各扫一遍」,
 *     但 104 个 path 里父子重叠严重,仍产生 **21799 次 parse / 525 MB**,
 *     而磁盘上只有 **4759 个唯一文件 / 132 MB** —— 同一份字节被重复解析 4 次。
 *   - 另外 `ensureIndexes([{name:'vanilla',path:GAME}], GAME)` 会把 GAME
 *     当 root 扫一遍、再当 gameRoot 扫一遍 → 全部实体的 duplicate-id 自我重复,
 *     实测产生 387 条**假** duplicate-id,同时多花一整轮时间。
 *
 * ## 现在怎么做
 *
 *  1. **root 去重**:同一物理目录只扫一次(`canonPath` 比较),修掉上面那 387 条假重复。
 *  2. **目录清单缓存**(`DirScan`):父子重叠的 path 复用同一份文件列表。
 *  3. **path → 文件 → 消费者**两段展开:先把每个唯一文件挂上它命中的
 *     全部 type 与全部枚举,再**每个文件只 readFileSync + parse 一次**。
 *     21799 次 parse → 4759 次;525 MB → 132 MB。
 *  4. **子串预筛**(`enumGuard`):parse 前先判断文件里有没有相关 key,
 *     绝大多数「文件 × 枚举」组合直接跳过(实测省 13308 次 parse)。
 *  5. **type 预编译**(`planType`):subtype 查表一次算好,不在热循环里分配数组。
 *  6. **跳过不存在的 path**并计数(`IndexStats.pathMissing`)。
 *
 * 对外语义不变:返回值结构、判定逻辑、诊断内容与优化前一致
 * (唯一有意的差别是修掉了「同一目录被扫两次」导致的假 duplicate-id)。
 */
function buildIndexes(
  rules: CwtRules,
  roots: RuleCheckRoot[],
  gameRoot: string,
  want: { enums: boolean; types: boolean },
): IndexDeps {
  const stats: IndexStats = {
    filesScanned: 0,
    rootsScanned: 0,
    rootsDeduped: [],
    pathTotal: 0,
    pathMissing: 0,
    dirCacheHits: 0,
    redundantPathPairs: 0,
    enumPreSkips: 0,
    parseMs: 0,
    scanMs: 0,
  }

  const values = new Map<string, Set<string>>()
  const declared = new Map<string, LiteralEnum>()
  const names = new Map<string, Set<string>>()
  const dupMap = new Map<string, { type: string; id: string; locs: { root: string; file: string; line: number }[] }>()
  const add = (t: string, id: string): void => {
    let s = names.get(t)
    if (!s) {
      s = new Set<string>()
      names.set(t, s)
    }
    s.add(id)
  }

  /* ── 1. root 去重:同一物理目录只扫一次 ──
   * gameRoot 恒定以 'vanilla' 之名追加扫描;若它已经在 roots 里出现过
   * (例如 roots=[{name:'vanilla',path:GAME}] 而 gameRoot 也是 GAME),
   * 再扫一遍只会让每个 id 自我重复 → 387 条假 duplicate-id + 一整轮浪费。 */
  const scan: RuleCheckRoot[] = []
  const seenPath = new Set<string>()
  for (const r of roots) {
    const k = canonPath(r.path)
    if (seenPath.has(k)) {
      stats.rootsDeduped.push(r.path)
      continue
    }
    seenPath.add(k)
    scan.push(r)
  }
  const gk = canonPath(gameRoot)
  if (seenPath.has(gk)) {
    stats.rootsDeduped.push(gameRoot)
  } else {
    scan.push({ name: 'vanilla', path: gameRoot })
  }
  stats.rootsScanned = scan.length

  /* ── 2. 组装「相对目录 → 消费者」 ── */
  interface DirConsumers {
    types: TypePlan[]
    enums: { name: string; def: ComplexEnum; guard: string[] | null }[]
  }
  const byDir = new Map<string, DirConsumers>()
  const dirOf = (p: string): DirConsumers => {
    const rel = p.replace(/^game\//, '')
    let d = byDir.get(rel)
    if (!d) {
      d = { types: [], enums: [] }
      byDir.set(rel, d)
    }
    return d
  }
  if (want.types) for (const ty of rules.types) for (const p of ty.path) dirOf(p).types.push(planType(ty))
  if (want.enums) {
    for (const [name, def] of rules.enums) {
      if (!isComplexEnum(def)) {
        if (want.enums) declared.set(name, def)
        continue
      }
      const guard = enumGuard(def)
      for (const p of def.path) dirOf(p).enums.push({ name, def, guard })
    }
  }
  stats.pathTotal = byDir.size

  /* ── 3. 两段展开:相对目录 → 唯一文件 → 消费者 ──
   * 这里是「只 parse 一次」的关键:先把一个文件命中的所有消费者挂齐,
   * 再对每个唯一文件做一次 readFileSync + parse。 */
  const byFile = new Map<string, FileConsumers>()
  const dirScan = new DirScan()
  for (const r of scan) {
    for (const [rel, cons] of byDir) {
      const dir = join(r.path, rel)
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) {
        stats.pathMissing++
        continue
      }
      for (const abs of dirScan.walk(dir)) {
        stats.redundantPathPairs++
        let fc = byFile.get(abs)
        if (!fc) {
          fc = { rootName: r.name, label: r.name + '/' + relative(r.path, abs).replace(/\\/g, '/'), types: [], enums: [] }
          byFile.set(abs, fc)
        }
        for (const t of cons.types) if (!fc.types.includes(t)) fc.types.push(t)
        for (const e of cons.enums) if (!fc.enums.includes(e)) fc.enums.push(e)
      }
    }
  }
  // 「文件 × path」对数 - 唯一文件数 = 被合并掉的冗余对
  stats.redundantPathPairs -= byFile.size
  stats.dirCacheHits = dirScan.hits

  /* ── 4. 逐文件:一次 parse,分发给所有消费者 ── */
  for (const [abs, fc] of byFile) {
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    stats.filesScanned++

    // 4a. 子串预筛:先看这个文件对每个枚举有没有希望
    const liveEnums: { name: string; def: ComplexEnum }[] = []
    for (const e of fc.enums) {
      if (e.guard) {
        let ok = true
        for (const seg of e.guard) {
          if (!text.includes(seg)) {
            ok = false
            break
          }
        }
        if (!ok) {
          stats.enumPreSkips++
          continue
        }
      }
      liveEnums.push(e)
    }
    if (!liveEnums.length && !fc.types.length) continue

    const t0 = Date.now()
    let doc: Document
    try {
      doc = parse(text)
    } catch {
      continue
    }
    stats.parseMs += Date.now() - t0

    const t1 = Date.now()
    // 4b. 枚举:从根块或顶层 key 的下一层开始采
    for (const e of liveEnums) {
      let out = values.get(e.name)
      if (!out) {
        out = new Set<string>()
        values.set(e.name, out)
      }
      const blocks: Block[] = []
      if (e.def.startFromRoot) {
        blocks.push(doc.root)
      } else {
        for (const en of doc.root.entries) if (en.block) blocks.push(en.block)
      }
      for (const b of blocks) for (const n of harvestNames(doc, b, e.def.namePath)) if (n) out.add(n)
    }
    // 4c. type:同一份 AST 上依次喂给该文件命中的所有 type
    for (const tp of fc.types) scanDocForType(doc, tp, fc.rootName, fc.label, add, dupMap)
    stats.scanMs += Date.now() - t1
  }

  // 声明过但没采到任何值的 complex_enum 也要在 map 里占位(对外结构不变)
  if (want.enums) {
    for (const [name, def] of rules.enums) {
      if (isComplexEnum(def) && !values.has(name)) values.set(name, new Set<string>())
    }
  }

  return {
    enums: { values, declared },
    types: { names, duplicates: [...dupMap.values()].filter((d) => d.locs.length > 1) },
    stats,
  }
}

/** 路径归一化,用于 root 去重(Windows 下大小写不敏感) */
function canonPath(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** 沿 namePath 递归采集枚举名。例 `name = { enum_name = scalar }` */
function harvestNames(doc: Document, blk: Block, path: SpecEntry[], depth = 0): string[] {
  if (depth >= path.length || !blk) return []
  const out: string[] = []
  const step = path[depth]
  for (const e of blk.entries) {
    if (keyText(doc, e) !== step.key) continue

    if (depth === path.length - 1) {
      // 末端末尾:`enum_name = scalar` 取值;裸 `enum_name` 取子键或其值
      const want = step.spec.t === 'scalar' ? step.spec.name : ''
      if (want && want !== 'enum_name') {
        const v = valueText(doc, e)
        if (v) out.push(v)
        else if (e.block) for (const c of e.block.entries) out.push(valueText(doc, c) ?? keyText(doc, c))
      } else if (e.block) {
        for (const c of e.block.entries) out.push(valueText(doc, c) ?? keyText(doc, c))
      } else {
        const v = valueText(doc, e)
        out.push(v ?? keyText(doc, e))
      }
      continue
    }
    if (e.block) out.push(...harvestNames(doc, e.block, path, depth + 1))
  }
  return out.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

/** type实体名索引:支撑交叉引用与唯一性 */
export interface TypeIndex {
  /** `type` 或 `type.subtype` → 实体名集合 */
  names: Map<string, Set<string>>
  /** 重复 id(仅 unique = yes 的 type) */
  duplicates: { type: string; id: string; locs: { root: string; file: string; line: number }[] }[]
}

export function buildTypeIndex(rules: CwtRules, roots: RuleCheckRoot[], gameRoot: string): TypeIndex {
  return buildIndexes(rules, roots, gameRoot, { enums: false, types: true }).types
}

function scanDocForType(
  doc: Document,
  plan: TypePlan,
  rootName: string,
  pathLabel: string,
  add: (t: string, id: string) => void,
  dupMap: Map<string, { type: string; id: string; locs: { root: string; file: string; line: number }[] }>,
): void {
  const ty = plan.ty
  const record = (id: string | undefined, e: Entry | null, sub?: string, entityLevel = true): void => {
    if (!id) return
    const typeName = sub ? `${ty.name}.${sub}` : ty.name
    add(typeName, id)
    /* ★ 只有「实体所在层级」的 key 参与唯一性判定。
     *
     * 实测:vanilla 的 `type[operation]`(operations.cwt:2)没有 skip_root_key /
     * name_field / type_key_filter,实体就是**顶层 key**。
     * 而下面 visit() 会递归进每个子块,把 `icon` / `name` / `desc` 这些
     * **块内字段名**也当成 id 记下来,于是 KR 抽样里报出
     *   id "icon" 在 58 处重复定义 / id "name" 在 112 处重复定义
     * —— 58 个 operation 各自都有 `icon = ...`,这不是重复定义,100% 误报。
     * (这些 id 仍会进 `names` 供交叉引用用,只是不再参与 duplicate 判定。) */
    if (ty.unique && entityLevel) {
      // 只有 unique 的 type 需要行号 —— 非 unique 传 null,省掉热循环里的 lineOf 调用
      const line = e ? lineOf(doc, e) : 1
      const k = `${typeName} ${id}`
      const arr = dupMap.get(k)
      if (arr) arr.locs.push({ root: rootName, file: pathLabel, line })
      else dupMap.set(k, { type: typeName, id, locs: [{ root: rootName, file: pathLabel, line }] })
    }
  }

  if (ty.typePerFile) {
    record(ty.nameField ? childScalar(doc, doc.root, ty.nameField) : undefined, null)
    return
  }

  /* 遍历顶层块,按 skipRootKey / typeKeyFilter 决定归属;
   * 命中 subtype[type_key_filter] 的登记为 `type.subtype`。
   * `depth` 用于判定「实体层级」:有 skip_root_key 时实体在 depth=1,
   * 没有时实体在 depth=0 —— 更深的层级都是块内字段,不是实体。*/
  const visit = (blk: Block, insideSkip: boolean, sub?: string, depth = 0): void => {
    const entityLevel = ty.skipRootKey ? insideSkip && depth === 1 : depth === 0
    for (const e of blk.entries) {
      const k = keyText(doc, e)
      if (!k) continue
      if (ty.skipRootKey && !insideSkip && k === ty.skipRootKey) {
        if (e.block) visit(e.block, true, sub, depth + 1)
        continue
      }
      if (ty.typeKeyFilter?.length && !ty.typeKeyFilter.includes(k)) continue
      const id = ty.nameField ? childScalar(doc, e.block, ty.nameField) ?? k : k
      // 找出该 key 属于哪个 subtype(查表,不再每 entry 重建 Object.entries)
      const mapped = plan.subOf.get(k)
      record(id, ty.unique ? e : null, mapped ?? sub, entityLevel)
      // skip_root_key 之下不再深挖(type 就是那些直接子块)
      if (!insideSkip && e.block && !ty.skipRootKey) visit(e.block, false, mapped ?? sub, depth + 1)
    }
  }
  visit(doc.root, false, undefined, 0)
}

function childScalar(doc: Document, blk: Block | undefined, key: string): string | undefined {
  if (!blk) return undefined
  for (const e of blk.entries) {
    if (keyText(doc, e) === key) {
      const v = valueText(doc, e)
      if (v) return v
    }
  }
  return undefined
}

/* ════════════════════════════════════════════════════════════════════
 * 四、值形态匹配
 * ════════════════════════════════════════════════════════════════════ */

const NON_NUMERIC = /^(yes|no|true|false)$/i

export interface MatchResult {
  ok: boolean
  why?: string
  /** 交叉引用目标类型(用于查 type/sprite 索引) */
  refType?: string
  /** 需要查本地化索引 */
  needLoc?: boolean
  /** 需要查枚举集合 */
  needEnum?: string
  /** 递归通配(此处放任意 trigger/effect) */
  wildcard?: boolean
}

const OK: MatchResult = { ok: true }

/**
 * @param op 该 entry 的运算符(`=` / `<` / `>` …)。
 *   只有**比较运算**才做值域检查 —— 见`range` 分支的说明。
 *   缺省( undefined )时保持原行为:一律检查。
 */
export function matchSpec(value: string | undefined, spec: ValueSpec, rules: CwtRules, op?: string): MatchResult {
  switch (spec.t) {
    case 'block':
      return OK
    case 'any':
      return { ok: true, wildcard: true }
    case 'link':
      return { ok: true, refType: spec.name }
    case 'pipe': {
      const inner = spec.arg.startsWith('<') && spec.arg.endsWith('>') ? spec.arg.slice(1, -1) : null
      return inner ? { ok: true, refType: inner } : OK
    }
    case 'enum':
      return { ok: true, needEnum: spec.name }
    case 'range': {
      if (value === undefined) return OK
      const t = value.trim()
      if (t === '' || NON_NUMERIC.test(t)) return OK
      if (!/^[-+]?[\d.]+$/.test(t)) return OK
      const num = parseFloat(t)
      if (Number.isNaN(num)) return OK
      /* ★ 只在**比较运算**下解读range 的上下界。
       *
       * 规则库里 7 个 trigger 类 range(triggers.cwt:142 `threat = float[0..1]` 等)
       * 描述的是「被比较的那个量」的取值范围,只对 `threat < 0.6` 这种比较成立。
       * 而 `threat = 5` 是**赋值**(把威胁度设成 5,vanilla 自己就有 142 处、
       * KR 有 214 处),此时 0..1 根本不适用 —— 那是 effect 语义。
       * 早期实现不看运算符,于是 vanilla 自己的写法全被报成
       * 「超出允许范围 0 ~ 1(实际 5)」,KR 抽样里这一类有 100+ 条,全是误报。
       * 真正的比较(`threat >` / `<`)实测 100% 落在 0..1 内,所以这样收窄不会漏报。*/
      if (op !== undefined && op !== '<' && op !== '>' && op !== '<=' && op !== '>=' && op !== '==' && op !== '!=' && op !== '<>') {
        return OK
      }
      if (num < spec.min || num > spec.max) {
        return { ok: false, why: `超出允许范围 ${spec.min} ~ ${spec.max}(实际 ${num})` }
      }
      return OK
    }
    case 'scope':
    case 'value':
    case 'set':
    case 'single':
    case 'list':
      return OK
    case 'scalar':
      return matchScalar(value, spec.name, rules)
    default:
      return OK
  }
}

/**
 * 具名形态匹配 —— 类型系统的核心。
 *
 * ★ 绝大多数 `scalar` 是**类型名**(`int` / `bool` / `localisation` / `variable_field` …),
 *   不是字面值。判定顺序:
 *     1. 已知宽松类型 → 只报明显错误
 *     2. localisation 系 → 标记需查 loc 索引
 *     3. 枚举别名 → 标记需查枚举
 *     4. 其余按字面量比对,但**拿不准就放过**
 *
 *   第 4 步的保守是刻意的:1962 条声明里混着我们不理解的类型名,
 *   一律当报错会让体检变成噪音 —— 用户会直接关掉它,那比少查一类更糟。
 */
/**
 * 判断一个值是不是 Clausewitz 允许的**动态 token**(而非字面量)。
 *
 * ★ 为什么要严格 白名单 而不用「含字母就放过」:
 *   `int` / `float` / `bool` 三类值在 mod 与 vanilla 里的真实动态写法就那么几种,
 *   枚举清楚;一旦放宽成「含字母/下划线就放过」,任何拼错的字符串
 *   (`"not_a_number"`、`"ture"`、`"yess"`)都会静默通过,类型校验形同虚设。
 *
 * 收录依据(都是 vanilla 里实测大量出现的写法):
 *   `@1936`            日期 token(technology folder 的 position,infantry.txt 100+ 处)
 *   `>` `<` `>=` `<=`  比较运算的左值
 *   `yes`/`no`/`TRUE`/`FALSE`/`bool` 大小写变体
 *   `var`/`event_var`/`temp_variable`/`random`/`variable_field`  等类型名本身
 *   `$`/`{`/`[` 开头  变量/数组/作用域表达式
 */
function isDynToken(t: string): boolean {
  if (t === '') return true
  /* 日期 token:`@1936` / `@[1936.1.1]` */
  if (t.startsWith('@')) return true
  /* 变量与作用域表达式 */
  if (/^[$[]/.test(t)) return true
  if (t.startsWith('{') || t.startsWith('(')) return true
  /* 比较运算 */
  if (/^[<>]=?$/.test(t)) return true
  /* yes/no 的大小写与拼写变体 */
  if (/^(yes|no|true|false|bool)$/i.test(t)) return true
  /* 类型名本身被当作值写(vanilla 有 `x = variable_field` 这类占位) */
  if (/^(variable_field|int_variable_field|variable_field_\d+|int_\d+|float_\d+|state|hegemony|array|state_list)$/i.test(t)) return true
  /* 带引号的字符串:值是自由文本时类型名常写 string,不该按数值判 */
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return true
  return false
}

function matchScalar(value: string | undefined, name: string, rules: CwtRules): MatchResult {
  const t = (value ?? '').trim()

  switch (name) {
    case 'int':
    case 'int_variable_field':
      if (t === '' || NON_NUMERIC.test(t)) return OK
      if (/^[-+]?\d+$/.test(t)) return OK
      /* ★ 只放过 Clausewitz 确实允许的非字面量 token,不是「含字母就放过」。
       * 原先这里是 `if (/[A-Za-z_]/.test(t)) return OK` —— 等于对任意字符串
       * 放行,`cost = "not_a_number"` 这类真类型错误永远报不出来
       * (实测 7 条定向判据里 `value-type` 恒为 0 的直接原因)。*/
      if (isDynToken(t)) return OK
      return { ok: false, why: '期望整数' }
    case 'float':
      if (t === '' || NON_NUMERIC.test(t)) return OK
      if (/^[-+]?[\d.]+$/.test(t)) return OK
      if (isDynToken(t)) return OK
      return { ok: false, why: '期望小数' }
    case 'bool':
    case 'yes':
    case 'no':
      if (t === '' || NON_NUMERIC.test(t)) return OK
      if (isDynToken(t) || /[<>=!]/.test(t)) return OK
      return { ok: false, why: '期望 yes 或 no' }
    case 'scalar':
    case 'variable_field':
    case 'const':
    case 'random':
    case 'date_field':
    case 'any':
    case 'unknown':
    case 'colour':
      return OK
    case 'localisation':
    case 'localisation_inline':
    case 'bindable_loc':
    case 'character_name':
    case 'custom_effect_tooltip':
      return { ok: true, needLoc: true }
  }

  if (rules.enums.has(name)) return { ok: true, needEnum: name }

  if (t === '' || t === name || t === `"${name}"`) return OK
  // 带 <>:交叉引用的裸写法,交给 ref 检查
  if (t.startsWith('<') && t.endsWith('>')) return { ok: true, refType: t.slice(1, -1) }
  // 非小写开头的名字多半是类型/常量名,不是字面量
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || /[A-Z]/.test(name)) return OK
  // ★ 带位数后缀的类型名(目前只有 `variable_field_32`,effects.cwt:1425 /
  //   triggers.cwt:1460)不是字面量枚举 —— 它表示「一个 32 位变量字段」,
  //   右侧是裸数字才是正常写法(vanilla 自己就写 `set_research_slots = 2`)。
  //   不放行的话,KR 抽样里这一类误报了 124+112+38+33+29+28 ≈ 360 条 warning。
  if (/^(variable_field|int|float)_\d+$/.test(name)) return OK

  return { ok: false, why: `期望 ${name},实际 "${t}"` }
}

/* ════════════════════════════════════════════════════════════════════
 * 五、作用域栈(保守子集)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 作用域 / 条件包装键:块内属于另一个上下文,不做当前结构的键校验。
 *
 * - `ROOT = { }` / `FROM = { }` / `PREV = { }` —— 作用域切换
 * - `IF = { limit = { ... } ... }` —— 条件执行包裹(vanilla 的 technology /
 *   idea / on_action 里大量使用),块内是完整的 trigger + effect 上下文
 * 这两类键名都不是结构定义里的字段,引擎也没有完整的作用域栈,
 * 判不准就整块跳过键校验(值级 alias 校验与递归仍继续)。
 */
const SCOPE_SWITCH_KEYS = new Set([
  'ROOT', 'FROM', 'PREV', 'THIS',
  'ROOT.PREV', 'FROM.PREV', 'PREV.PREV',
  'IF', 'IF.NE', 'LIMIT',
  /* ★ D1:`ELSE` / `ELSE_IF` 曾漏在这里 —— 它们和 `IF` 一样是脚本条件
   *   关键字,块内是**另一个作用域**的 trigger/effect,键名由 alias 索引
   *   决定,不属于当前结构定义。实测 vanilla 里 ELSE 643 次、ELSE_IF 695 次
   *   (合计 1,338 次)全被报成「不在此结构的定义里」—— 纯误报。
   *   判据:cwt-noise.test.ts 的 `D1 ELSE/ELSE_IF 不再被报为未知键`。*/
  'ELSE', 'ELSE_IF',
  'owner', 'controller', 'capital', 'state', 'country', 'unit', 'character',
])

/**
 * 词法层的作用域近似。
 *
 * ★ 这不是完整实现。完整版要解 effect/trigger 的 push_scope 语义与
 *   ROOT/FROM/PREV 的动态指向 —— 那是 CWTools 花大力气做的部分。
 *   这里只识别语义明确的容器 key,其余保持栈不变。
 *   近似带来的是**漏判**而非误判,对体检工具是正确取舍。
 */
const SCOPE_CONTAINERS: Record<string, string> = {
  country: 'country',
  state: 'state',
  province: 'province',
  unit: 'unit',
  character: 'character',
  unit_leader: 'unit_leader',
  operative: 'operative',
  navy: 'navy',
  army: 'army',
  every_country: 'country',
  every_state: 'state',
  random_country: 'country',
  random_state: 'state',
  owner: 'country',
  controller: 'country',
  capital: 'state',
  capital_scope: 'state',
}

/* ════════════════════════════════════════════════════════════════════
 * 六、主校验入口
 * ════════════════════════════════════════════════════════════════════ */

let INDEX_CACHE: (IndexDeps & { key: string }) | null = null

export interface RuleCheckDeps {
  enums: EnumIndex
  types: TypeIndex
}

/**
 * 建索引并在进程内缓存。
 *
 * 缓存键 = 挂了哪些来源 + gameRoot。切换目标模组时**不失效**,
 * 因为判定上下文本来就该包含全部来源(模组引用原版图标/科技 id 是常态)。
 *
 * ★ 枚举与 type 现在**一趟扫完**(`buildIndexes` 里同一个文件只 parse 一次),
 *   优化前是 `collectEnums` 33 s + `buildTypeIndex` 30 s 串行。
 */
export function ensureIndexes(roots: RuleCheckRoot[], gameRoot: string): RuleCheckDeps {
  const key = roots.map((r) => r.path).join('|') + '#' + gameRoot
  if (INDEX_CACHE && INDEX_CACHE.key === key) return INDEX_CACHE
  const rules = getRules()
  INDEX_CACHE = { key, ...buildIndexes(rules, roots, gameRoot, { enums: true, types: true }) }
  return INDEX_CACHE
}

/** 上次建索引的统计(诊断/验收用;未建过索引时返回 null) */
export function lastIndexStats(): IndexStats | null {
  return INDEX_CACHE ? INDEX_CACHE.stats : null
}

/** ROOTS 变更时必须调,否则会用旧来源的索引判新模组 —— 静默假阴性 */
export function resetIndexCache(): void {
  INDEX_CACHE = null
}

export function checkWithRules(roots: RuleCheckRoot[], opts: RuleCheckOpts): RuleCheckReport {
  const rules = getRules()
  const diags: Diag[] = []
  const inScope = opts.scope?.length ? new Set(opts.scope) : null
  const { enums, types } = ensureIndexes(roots, opts.gameRoot)

  let aliasCount = 0
  for (const arr of rules.aliasIndex.values()) aliasCount += arr.length

  /* ── 逐文件体检 ── */
  const ctx: WalkCtx = {
    rules,
    enums,
    types,
    diags,
    opts,
    rootName: '',
    rel: '',
  }

  let done = 0
  const scriptScan = new DirScan()
  for (const r of roots) {
    ctx.rootName = r.name
    for (const abs of collectScriptFiles(r.path, scriptScan)) {
      done++
      if (done % 300 === 0) opts.onProgress?.(done, 0, `规则体检 ${r.name}`)
      if (inScope && !inScope.has(r.name)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      ctx.rel = relative(r.path, abs).replace(/\\/g, '/')
      /* 顶层不预挂 struct。
       *
       * ★ 试过在这里走 `pickChildStruct`(想让「顶层键即实体」的结构
       *   也能拿到字段表),**实测无效且有害**:
       *   顶层块自身会被 `allKeysAreSwitch` / skip 包装层逻辑判成
       *   「包装层」(`structIsOurs=false`),struct 被传给下一层实体块,
       *   于是顶层拿到 struct、下层反而拿不到 —— 噪音不降反升
       *   (实测 63,132 → 64,637)。已回退。
       *
       * 正确解法在规则库侧:这类结构用 `type_key_filter` 表达
       * 「顶层键本身即实体」,由 `pickChildStruct` 的 entity 分支在
       * **下一层**接上。已验证 `type_key_filter` 能被 cwt.ts 正确解析
       * (cwt-check.ts:1222-1229 曾记「全库为 0」,那只是没人写过)。*/
      walkBlock(doc, doc.root, [], ctx, null)
    }
  }

  /* ── 唯一性(重复 id) ── */
  for (const d of types.duplicates) {
    if (inScope && !d.locs.some((l) => inScope.has(l.root))) continue
    /* ★ 报告位置优先选 scope 内的定义。
     * 模组覆盖 vanilla 同名 id 是 HOI4 的正常玩法,若总取 `locs[0]`,
     * 诊断会指向 vanilla 的文件行号 —— 用户在自己模组里根本找不到那一行。
     * 这里优先挑 scope 内的位置;scope 为空时保持原行为。*/
    const loc = (inScope ? d.locs.find((l) => inScope.has(l.root)) : null) ?? d.locs[0]
    diags.push({
      code: 'duplicate-id',
      severity: 'error',
      root: loc.root,
      file: loc.file,
      rel: loc.file,
      line: loc.line,
      message: `id "${d.id}" 在 ${d.locs.length} 处重复定义(${d.type} 要求唯一)`,
      key: d.id,
    })
  }

  const byCode: Record<string, number> = {}
  let error = 0
  let warning = 0
  let info = 0
  for (const d of diags) {
    byCode[d.code] = (byCode[d.code] ?? 0) + 1
    if (d.severity === 'error') error++
    else if (d.severity === 'warning') warning++
    else info++
  }
  return {
    diags,
    stats: { error, warning, info, byCode },
    ruleErrors: rules.errors,
    ruleCount: { aliases: aliasCount, structs: rules.structs.size, types: rules.types.length, enums: rules.enums.size },
  }
}

/**
 * 收集一个 root 下所有会被体检的脚本文件。
 *
 * 复用 `DirScan`(同一目录只 readdir 一次):`map` 下同时存在
 * `map/strategicregions` 之类的子目录目标,而 `common` 是 2218 个文件的
 * 大头,重复 readdir 在多 root 场景下会被放大。
 */
function collectScriptFiles(rootPath: string, scan: DirScan): string[] {
  const out: string[] = []
  for (const sub of ['common', 'events', 'decisions', 'history', 'interface', 'map']) {
    const d = join(rootPath, sub)
    if (existsSync(d)) out.push(...scan.walk(d))
  }
  return out
}

interface WalkCtx {
  rules: CwtRules
  enums: EnumIndex
  types: TypeIndex
  diags: Diag[]
  opts: RuleCheckOpts
  rootName: string
  rel: string
}

/**
 * 递归遍历块,对每条 `key = value` 应用规则。
 *
 * @param struct 当前块对应的结构定义(顶层裸结构命中时传入,逐层下传)
 * @param structIsOurs `false` 表示本块只是**容器包装层**
 *   (`skip_root_key` 型,如 `technologies = { ... }`),自身不做键校验,
 *   `struct` 是留给直接子块(真正的实体)用的。
 */
function walkBlock(doc: Document, blk: Block, scopes: string[], ctx: WalkCtx, struct: StructDef | null, structIsOurs = true): void {
  const selfStruct = structIsOurs ? struct : null

  /* ★ 作用域切换键(`ROOT = { ... }` / `FROM = { ... }` / `PREV = { ... }`)
   * 的块内是**另一个作用域**的 trigger/effect,键名由 alias 索引决定,
   * 不属于当前结构定义。引擎没有完整的作用域栈,判不准就跳过这些键的
   * 结构级校验(值级 alias 校验与递归仍继续),否则 vanilla 自己的 ROOT 块
   * 会被报成一片「不在此结构的定义里」。
   *
   * ★★ D2 修复:原来是 `blk.entries.every(...)` —— 要求块内**全部**键都是
   *   切换键才把 `allowed` 置 null。后果是**混合块失效**:
   *     available = {
   *       has_war = yes        ← 真实 trigger,应该校验
   *       IF = { ... }         ← 作用域切换,应该跳过
   *     }
   *   只要掺进一个 IF,整个块的键校验全部作废,块里的真错永远不报。
   *   实测 vanilla 里 IF 相关噪音 2,604 条即源于此。
   *
   *   正确做法:**按条目粒度**判定 —— 只有切换键本身跳过结构级校验,
   *   同块的其他键照常查 `allowed`。
   *
   *   ⚠ 不能改成「整块跳过」来消噪:IF 内部可以嵌套真实字段
   *   (`IF = { has_war = yes }`),整块跳会把里面的错一起藏掉。
   *   判据:cwt-noise.test.ts 的 `D2 判据:IF 块内 another_bogus_key_qqq 被报出`。
   *   这条在修复前是失败的,必须转绿,否则说明改成了整块跳过。*/
  const isScopeSwitchKey = (k: string | undefined): boolean =>
    k !== undefined && (SCOPE_SWITCH_KEYS.has(k) || SCOPE_SWITCH_KEYS.has(k.toUpperCase()))

  /* 本块内各 key 出现次数(供 cardinality) */
  const countOf = new Map<string, number>()
  for (const e of blk.entries) {
    const k = keyText(doc, e)
    if (k) countOf.set(k, (countOf.get(k) ?? 0) + 1)
  }
  /* 结构定义里允许的键(用于「未知键」检查 + 子块结构下传)
   *
   * ★ 同一结构里同名键会出现多次(`focus_tree.focus` 被声明两次:
   *   一份含 42 个字段的完整定义,一份只含几个扩展键)。
   *   `new Map(entries.map(...))` 只会保留**最后一个**,前面的字段全丢 ——
   *   实测这导致 focus 块里 `icon` 拿不到 spec,「引用不存在的图形」永不报出。
   * 正确做法:同名键的条目**合并**(concat),任一形态提供该字段即算已定义。
   */
  /* ★ D2:不再整块置 null,改为逐条目判定(见 isScopeSwitchKey 注释)。
   * 整块全为切换键时 `allowed` 仍取 null,语义与旧行为一致;混合块则保留
   * 结构定义,由主循环里对切换键单独跳过。*/
  const allKeysAreSwitch = blk.entries.length > 0 && blk.entries.every((e) => isScopeSwitchKey(keyText(doc, e)))
  const allowed = allKeysAreSwitch
    ? null
    : selfStruct
      ? mergeSpecEntries(selfStruct.entries)
      : null

  for (const e of blk.entries) {
    const key = keyText(doc, e)
    if (!key) continue
    const value = valueText(doc, e)
    const line = lineOf(doc, e)
    /* ★ 本块用来查「允许的键」的结构定义。
     * 容器型顶层键已在 `pickChildStruct` 里处理成「包装层的子块 = 实体」,
     * 所以这里恒等于 `struct`。*/
    const childParentStruct = struct
    /* 该键在本结构里的全部候选形态(多形态声明,见 mergeSpecEntries 注释) */
    const specs = allowed?.get(key) ?? null

    /* 进入子作用域 */
    const sc = SCOPE_CONTAINERS[key.toLowerCase()]
    const childScopes = sc ? [...scopes, sc] : scopes

    /* ── 1) 值级校验:alias 规则(1962 条)── */
    const cands = lookupRules(ctx.rules, key)
    let matched = !cands.length
    let lastWhy = ''
    for (const c of cands) {
      const m = tryAlias(doc, e, c, scopes, ctx)
      if (m.ok) {
        matched = true
        if (m.refType) checkRef(m.refType, value, e, doc, ctx)
        if (m.needEnum) checkEnumValue(m.needEnum, value, e, doc, ctx)
        break
      }
      lastWhy = m.why ?? ''
    }
    if (!matched && lastWhy && cands.length) {
      pushDiag(ctx, {
        code: 'value-type',
        severity: severityOf(cands[0]),
        message: `\`${key}\` ${lastWhy}`,
        key,
        value,
        rule: ruleRef(cands[0]),
      }, e, doc, line)
    }

    /* ── 2) 结构级校验:该键在结构定义里声明了什么 ──
     *
     * ★ 这里必须按**多形态**处理,不能只取一条。
     *   `focus` 结构里 `icon` 被声明了 4 次(两组 focus × 两种形态):
     *     icon = <spriteType>                       ← link 形态(标量 GFX 名)
     *     icon = { <spriteType> = { alias_name[trigger] = ... } }  ← block 形态
     *   之前 `mergeSpecEntries` 在形态不同时只保留 block,把 link 形态丢了 ——
     *   于是 `icon = GFX_xxx`(标量写法,vanilla 里绝大多数)拿不到 refType,
     *   「引用了不存在的图标」这条判据**永不触发**(实测 7/7 判据里唯一未过的
     *   sprite 那条就是被这个 bug 吃掉的)。
     *   CWTools 的语义是「任一候选 spec 匹配即合法」,所以要全部保留、逐个试。*/
    if (specs && specs.length) {
      let okAny = false
      let lastM: ReturnType<typeof matchSpec> | null = null
      let hit: SpecEntry | null = null
      for (const sp of specs) {
        const m = matchSpec(value, sp.spec, ctx.rules, operator(doc, e))
        if (m.ok) { okAny = true; hit = sp; lastM = m; break }
        lastM = m
      }
      if (!okAny && lastM) {
        pushDiag(ctx, {
          code: 'value-type',
          severity: 'warning',
          message: `\`${key}\` ${lastM.why}`,
          key,
          value,
          rule: { file: 'cwt/' + (selfStruct?.files[0] ?? '?'), line: (hit ?? specs[0]).line },
        }, e, doc, line)
      } else if (okAny && lastM) {
        if (lastM.refType) checkRef(lastM.refType, value, e, doc, ctx)
        if (lastM.needEnum) checkEnumValue(lastM.needEnum, value, e, doc, ctx)
        if (lastM.needLoc) checkLoc(value, e, doc, ctx)
      }
      /* cardinality:声明的次数约束(任一形态声明了就算) */
      for (const sp of specs) {
        const card = sp.directives.find((d) => d.key === 'cardinality')
        if (card) { checkCardinality(card, countOf.get(key) ?? 0, key, e, doc, ctx); break }
      }
    } else if (
      allowed && allowed.size > 0 && !cands.length &&
      /* ★ D2:作用域切换键(IF/ELSE/ROOT/FROM/PREV…)的块内是**另一个作用域**的
       * trigger/effect,键名由 alias 索引而非当前结构定义,跳过 unknown-key。
       * 只跳过这些键本身,同块的其他键照常判定(见 isScopeSwitchKey 注释)。*/
      !isScopeSwitchKey(key) &&
      !wildcardCovers(allowed, key, ctx.rules)
    ) {
      /* 未知键:结构里没声明、规则库也没有 alias。报 info,便于发现打错的键 */
      const likely = suggestKey(key, allowed, ctx.rules)
      pushDiag(ctx, {
        code: likely ? 'unknown-key' : 'unknown-key',
        severity: 'info',
        message: likely
          ? `\`${key}\` 不在此结构的定义里(是否想写 \`${likely}\`?)`
          : `\`${key}\` 不在此结构的定义里`,
        key,
        value,
      }, e, doc, line)
    }

    /* ── 3) alias 声明的 loc 形态 ── */
    if (cands.length) {
      for (const c of cands) {
        const m = matchSpec(value, c.spec, ctx.rules, operator(doc, e))
        if (m.ok && m.needLoc) {
          checkLoc(value, e, doc, ctx)
          break
        }
      }
    }

    /* ── 4) 递归子块 ──
     * 子块用**键自身的结构定义**(如 focus 块用 struct.focus 的定义),
     * 找不到就用父结构里该键声明的 spec。
     *
     * ★ 容器型顶层键(`skip_root_key`)是「包装层 + 实体」两层:
     *   `technologies = { tech_1 = { allow = { ... } } }`
     * `technologies` 只是包装层(它自己不是 technology,不该被按 technology 校验),
     * **tech_1 才是实体**。所以对容器键:包装层不做键校验(structIsOurs=false),
     * 把 struct.technology 交给**下一层的实体块**,由实体块去校验自己的字段。
     * 少了这一步,`technologies` 以下的整棵子树都没有结构定义,
     * `allow = { bogus_trigger_qqq = 1 }` 里的错键会全部漏报。*/
    if (e.block) {
      const container = topKeyMap(ctx.rules).skip.get(key)
      if (container && ctx.rules.structs.has(container) && !rules_structHas(childParentStruct, key)) {
        // 包装层:自身不校验,把结构定义交给下一层的实体块
        walkBlock(doc, e.block, childScopes, ctx, ctx.rules.structs.get(container)!, false)
      } else if (!structIsOurs) {
        // 实体层:struct 就是它的字段表,直接传下去
        walkBlock(doc, e.block, childScopes, ctx, struct, true)
      } else {
        walkBlock(doc, e.block, childScopes, ctx, pickChildStruct(key, childParentStruct, ctx.rules), true)
      }
    }
  }
}

/**
 * 顶层 key → 结构定义名。
 *
 * ★ 为什么需要这张表:文件里的顶层 key 与结构定义名**经常不同名**。
 *   - `country_event = {` / `state_event = {` → 结构定义叫 `event`(events.cwt 的
 *     `type[event].subtype[country_event]` 上有注释形式的 type_key_filter)
 *   - `combat_tactic = {`                   → 结构定义叫 `combat_tactic`
 * `pickChildStruct` 早期只按同名查找,于是 `country_event` 这种块的
 * `struct` 恒为 null,**块内一整层不做任何结构级校验**。
 *
 * ★ 关键区分:`skip_root_key` 与 `type_key_filter` 语义**相反**,不能混一张表:
 *   - `skip_root_key = technologies`(technologies.cwt:3)
 *     → `technologies = { ... }` 只是**容器**,实体是它的直接子块
 *       (`early_transport_plane = { }`),所以 struct.technology 要挂在**子块**上,
 *       挂到 `technologies` 块上会把 `early_transport_plane` 误判成「未知键」。
 *   - `type_key_filter = country_event`
 *     → `country_event = { ... }` 本身就是**那个实体**,struct 直接挂上去。
 * 因此下面分开两张表:`SKIP` 表的键要下潜一层,`ENTITY` 表的键直接匹配。
 */
let TOPKEY_MAP: { skip: Map<string, string>; entity: Map<string, string> } | null = null

function topKeyMap(rules: CwtRules): { skip: Map<string, string>; entity: Map<string, string> } {
  if (TOPKEY_MAP) return TOPKEY_MAP
  const skip = new Map<string, string>()
  const entity = new Map<string, string>()
  for (const ty of rules.types) {
    if (!rules.structs.has(ty.name)) continue
    if (ty.skipRootKey) skip.set(ty.skipRootKey, ty.name)
    if (ty.typeKeyFilter?.length) for (const k of ty.typeKeyFilter) if (k && !entity.has(k)) entity.set(k, ty.name)
    /* subtype 自带 typeKeyFilter(解析器已从 `## type_key_filter = xxx` 注释读出) */
    for (const sd of Object.values(ty.subtypes ?? {})) {
      for (const k of sd.typeKeyFilter ?? []) {
        if (k && !entity.has(k)) entity.set(k, ty.name)
      }
    }
  }
  /* ★ 已知缺口(如实记录,不在此处绕过):
   * 本规则库里所有 `type_key_filter` 都写成了注释(`## type_key_filter = country_event`,
   * events.cwt:6),所以 entity 表实测是**空的**。后果:
   *   `country_event = { }` 拿不到 struct.event
   *   → 其下的 `immediate = { unknown_effect_here_zzz = 1 }` 整层不做结构级校验。
   * 修它需要在 cwt 规则库里取消这些注释(属于规则库改动,不是引擎职责),
   * 或者在这里按 subtype 名硬编码映射 —— 后者会把 `subtype[visible]` 之类的
   * 内部标记也当成顶层键,引入新的误报,所以不做。*/
  TOPKEY_MAP = { skip, entity }
  return TOPKEY_MAP
}

/**
 * 取子块对应的结构定义。
 *
 * 顺序:① 规则库里的**同名**顶层结构(focus_tree 里的 focus → struct.focus)
 *      ② **实体型顶层 key** 映射(country_event → struct.event)
 *      ③ 父结构里该键自己的 block 定义
 *
 * 容器型顶层键(technologies = { })不在这里处理 —— 它自身没有结构定义,
 * 由 `walkBlock` 识别后把 struct 下潜给直接子块。
 */
function pickChildStruct(key: string, struct: StructDef | null, rules: CwtRules): StructDef | null {
  /* ★ 顺序修正:**父结构里的内嵌定义优先**,全局同名结构次之。
   * 原先把「全局同名」放第一位是错的 —— `focus` 并没有独立的顶层 struct
   * (它的 42 个字段是内嵌在 `struct.focus_tree.focus = { ... }` 里的),
   * 于是永远命中不了,`icon = GFX_...` 这类交叉引用校验整层失效。*/
  if (struct) {
    /* 同名键可能有多份声明(`focus_tree.focus` 有2 份),要合并全部而不是只取第一份,
     * 否则只有其中一个形态的字段被识别。*/
    const subs = struct.entries.filter((x) => x.key === key)
    const blocks = subs.filter((x) => x.spec.t === 'block')
    if (blocks.length > 0) {
      /* ★ 这里要的是**块内部的字段表**,不是外层的 `focus` 条目本身。
       * `struct.focus_tree.focus = { id = <focus.id> ... }` 的 spec.entries
       * 才是 focus 块自己的键(id/icon/cost/...)。
       * 曾误写成 `mergeSpecEntries(blocks)` —— 那是把外层条目(键全是 'focus')合并,
       * 结果 struct 只剩一个 `focus` 键,focus 块内 42 个字段全变「未知键」。*/
      const inner = blocks.flatMap((b) => (b.spec.t === 'block' ? b.spec.entries : []))
      if (inner.length > 0) {
        return {
          name: `${struct.name}.${key}`,
          entries: inner,
          subtypes: {},
          directives: subs.flatMap((s) => s.directives),
          files: struct.files,
          file: struct.file,
          line: subs[0].line,
        }
      }
    }
    // 键名与文件的 key 不同,但它是某个已知结构(type)
    for (const s of subs) {
      if (s.spec.t !== 'block' && rules.structs.has(s.key)) return rules.structs.get(s.key)!
    }
  }
  // ② 实体型顶层 key 映射(country_event → struct.event)
  const ent = topKeyMap(rules).entity.get(key)
  if (ent && rules.structs.has(ent)) return rules.structs.get(ent)!
  // ③ 规则库里的同名顶层结构
  if (rules.structs.has(key)) return rules.structs.get(key)!
  return null
}

/** `struct` 自身是否已声明这个键(用来区分「同名命中」与「容器包装层」) */
/**
 * 把结构定义里可能重复的同名键合并成「键 → 候选 spec 列表」。
 *
 * 规则原文里同一个键常被声明多次,分别描述**不同形态**,例如
 * `focus` 里的 `icon`(实测 4 次):
 *   icon = <spriteType>                                  ← 标量 sprite 名
 *   icon = { <spriteType> = { alias_name[trigger] = … } } ← 块形态(带条件)
 * 还有 `focus_tree.focus` 本身有 2 份(42 字段 + 43 字段,后者多一个 `text`)。
 *
 * ★ 关键:**不能只留一条,也不能"形态不同就保留 block"**。
 *   早先的实现用 `Map<key, SpecEntry>` + 冲突时保留 block,
 *   结果 `icon` 的 `<spriteType>` 交叉引用形态被丢掉 ——
 *   `icon = GFX_xxx` 这种写法(vanilla 里的主流写法)因此拿不到 refType,
 *   「引用了不存在的图标」永远不报。
 *   CWTools 的语义是**多形态声明:任一候选匹配即合法**,所以全部保留、逐个试。
 */
function mergeSpecEntries(entries: SpecEntry[]): Map<string, SpecEntry[]> {
  const m = new Map<string, SpecEntry[]>()
  for (const e of entries) {
    const prev = m.get(e.key)
    if (!prev) {
      m.set(e.key, [e])
      continue
    }
    prev.push(e)
  }
  return m
}

function rules_structHas(struct: StructDef | null, key: string): boolean {
  return !!struct && struct.entries.some((x) => x.key === key)
}

/**
 * 结构定义里是否存在「通配键」。
 *
 * ★ 规则库用 `<equipment>` / `<unit>` 这种尖括号键表示「任意一个该类型的实体」,
 *   例如 `enable_equipments = { limit = { <equipment> = 1 } }`
 *   (technologies.cwt 的 technology.enable_equipments)。
 *   它们的键名在文件里根本不会出现,所以:
 *     - `pickChildStruct` 匹配不到 → 子块拿不到结构定义
 *     - `allowed` 里也没有 → 块内每个真实键(如 `infantry_equipment`)都会被
 *       误报成「不在此结构的定义里」
 *   早期实现没处理这件事,`common/technologies` 单目录就会产出上千条这种噪音。
 * 命中通配键时**跳过未知键检查**(只保留值级 alias 校验),宁可漏报不误报。
 */
function hasWildcardKey(allowed: Map<string, SpecEntry>): boolean {
  for (const k of allowed.keys()) if (isWildcardKey(k)) return true
  return false
}

/** `<equipment>` / `alias_name[modifier_rule]` / `enum[base_factor]` 这类占位键 */
function isWildcardKey(k: string): boolean {
  if (k.startsWith('<') && k.endsWith('>')) return true
  return k.startsWith('alias_name[') || k.startsWith('enum[')
}

/**
 * 结构定义里的某个键是否已被通配声明覆盖。
 *
 * ★ 判定原则:占位键的含义**不一样**,不能一刀切。
 *   - `alias_name[trigger]` / `alias_name[modifier_rule]`
 *     「这一层放的是**任意 trigger / modifier**」——
 *      它是一个**命名空间内的通配**:只有当这个键在该命名空间里查不到声明时,
 *      才说明它是拼错的。`allow = { bogus_trigger_qqq = 1 }` 正是这种情况,必须报出来。
 *   - `enum[base_factor]`(配合 `factor = ...` 这类键)
 *     是**具体键的形态标注**,块里其余键仍要按具体声明核对。
 *   - `<equipment>`(任意实体)永远覆盖整块。
 * 所以:占位键存在时,只在「该键在对应命名空间里查不到 alias」时**仍然放过**;
 * 查得到说明是合法键,查不到说明可能拼错 → 交给未知键检查报出。*/
function wildcardCovers(allowed: Map<string, SpecEntry[]>, key: string, rules: CwtRules): boolean {
  let hasAliasPlaceholder = false
  for (const k of allowed.keys()) {
    // 任意实体 id:整块放过(它确实接受任意名字)
    if (k.startsWith('<') && k.endsWith('>')) return true
    if (k.startsWith('alias_name[')) hasAliasPlaceholder = true
  }
  /* `enum[base_factor]` 是**具体键的形态标注**,优先于 alias 通配。
   * 规则库写的是类型名 `base_factor`,文件里实际有三种写法:
   *   `base = 1`(vanilla:air_techs.txt / armor.txt 的 ai_will_do)
   *   `factor = 1`(部分 mod)
   *   `base_factor = 1`
   * 三者都放过,否则会误报 500+ 条 vanilla 自己的键。*/
  for (const k of allowed.keys()) {
    if (!k.startsWith('enum[')) continue
    const inner = k.slice(5, -1)
    // 规则库的类型名 `base_factor` 在文件里有三种写法:base / factor / base_factor
    if (key === inner) return true
    if (inner.startsWith('base_')) {
      const short = inner.slice(5) // factor
      if (key === short || key === inner.slice(0, 4)) return true // base / factor
    }
  }
  if (hasAliasPlaceholder) {
    // 规则库能查到 → 合法键,不该报
    if (lookupRules(rules, key).length > 0) return true
    // 查不到 → 拼错的键,返回 false 让未知键检查报出来
    return false
  }
  return false
}

/** 在结构定义里找最接近的键(编辑距离 1~2),用于「打错了」提示 */
function suggestKey(key: string, allowed: Map<string, SpecEntry[]>, rules: CwtRules): string | null {
  const lower = key.toLowerCase()
  for (const k of allowed.keys()) if (k.toLowerCase() === lower) return k
  for (const k of allowed.keys()) {
    if (Math.abs(k.length - key.length) <= 2 && editDistance1(k.toLowerCase(), lower)) return k
  }
  for (const k of rules.aliasIndex.keys()) {
    const i = k.indexOf(':')
    if (i > 0 && Math.abs(k.length - 1 - key.length) <= 2 && editDistance1(k.slice(i + 1).toLowerCase(), lower)) return k.slice(i + 1)
  }
  return null
}

function editDistance1(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false
    return true
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++
      j++
      continue
    }
    if (skipped) return false
    skipped = true
    j++
  }
  return true
}

/** 命名空间优先级:越具体的越优先 */
const NS_PRIORITY = ['trigger', 'effect', 'modifier_rule', 'modifier', 'gui_standard', 'gui_element', 'mathexpr']

function lookupRules(rules: CwtRules, key: string): AliasRule[] {
  for (const ns of NS_PRIORITY) {
    const arr = rules.aliasIndex.get(`${ns}:${key}`)
    if (arr && arr.length) return arr
  }
  return []
}

function tryAlias(doc: Document, e: Entry, rule: AliasRule, scopes: string[], ctx: WalkCtx): MatchResult {
  const value = valueText(doc, e)

  if (rule.spec.t === 'block' && e.block) return { ok: true, wildcard: false }

  /* 作用域守卫:仅在「双方都是具体 scope 且完全不相容」时判错,
   *栈里有我们没识别出来的容器时一律放过(宁可漏报不误报)。*/
  const want = directiveScopes(rule.directives)
  if (want.length > 0 && !want.includes('any') && scopes.length > 0) {
    if (!want.some((w) => scopes.includes(w) || subsumes(scopes, w))) {
      return { ok: false, why: `作用域不符(此处 ${scopes.join('/')},规则要求 ${want.join(' 或 ')})` }
    }
  }

  return matchSpec(value, rule.spec, ctx.rules, operator(doc, e))
}

/**
 * 取规则的 scope 指令,统一小写。
 *
 * ★ 规则库里大小写混用:`## scope = { COUNTRY }`(triggers_new.cwt)与
 *   `## scope = { country }`(scopes.cwt)都存在,而引擎内部的 scope 栈
 *   (`SCOPE_CONTAINERS`)全是小写。不归一化就会让
 *   `is_ally_with`(要求 COUNTRY)在 country 作用域里被误判成「作用域不符」——
 *   KR 抽样里这一类就占了 427+80 = 507 条 warning,全部是误报。
 */
function directiveScopes(dirs: Directive[]): string[] {
  for (const d of dirs) {
    if (d.key === 'scope') {
      return d.value
        .replace(/[{}]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    }
  }
  return []
}

function subsumes(current: string[], w: string): boolean {
  if (current.includes(w)) return true
  const parents: Record<string, string> = {
    character: 'country',
    unit_leader: 'character',
    operative: 'character',
    combat: 'country',
    state: 'country',
    province: 'state',
    navy: 'unit',
    army: 'unit',
  }
  for (const c of current) if (parents[c] === w) return true
  return false
}

function severityOf(rule: AliasRule): Severity {
  for (const d of rule.directives) {
    if (d.key === 'severity') {
      const v = d.value.trim()
      if (v === 'error' || v === 'warning' || v === 'info') return v
    }
  }
  return 'warning'
}

function ruleRef(rule: AliasRule): { file: string; line: number; desc?: string } {
  return { file: 'cwt/' + rule.file, line: rule.line, desc: rule.desc }
}

function pushDiag(ctx: WalkCtx, d: Omit<Diag, 'root' | 'file' | 'rel' | 'line'>, e: Entry, doc: Document, line?: number): void {
  ctx.diags.push({
    ...d,
    root: ctx.rootName,
    file: ctx.rel,
    rel: ctx.rel,
    line: line ?? lineOf(doc, e),
  })
}

/* ── 交叉引用存在性 ── */

function checkRef(refType: string, value: string | undefined, e: Entry, doc: Document, ctx: WalkCtx): void {
  const v = (value ?? '').trim()
  if (!v) return
  /* 含比较符 / 插值($) / 空格 / 数字的值无法静态判定 */
  if (/[<>=!$]/.test(v)) return
  if (/\s/.test(v)) return
  if (/^[-+]?[\d.]+$/.test(v)) return

  /* sprite 走 sprite 索引。
   * ★ 必须放在「裸标识符放过」那一步**之前**:sprite 名本身就是裸标识符
   *   (`GFX_xxx` / `GFX_power_balance_left`),若先按变量名放过,
   *   「引用了不存在的图形」这条最高频错误就永远不会报出来。
   *
   * ★★ 但**动态值判定必须提到 sprite 分支之前**。
   *   `events/00 City Capture events.txt` 里有 33 处:
   *     picture = [world_news_get_paris_capture_event_picture]
   *   方括号是 Clausewitz 的**运行期字符串拼接**,不是静态 sprite 名。
   *   实测这 33 条全是误报(把动态值当静态名去索引里查,当然查不到)。
   *   `isDynamicRefValue` 本来就覆盖 `[...]`,只是它原来排在 sprite 分支后面。*/
  if (isDynamicRefValue(v)) return

  if (/spriteType$|bitmapfont$/.test(refType)) {
    const set = ctx.opts.spriteNames
    if (!set || !set.size) return
    if (set.has(v)) return
    pushDiag(ctx, {
      code: 'undefined-sprite',
      severity: 'error',
      message: `引用了未定义的图形 "${v}"`,
      key: keyText(doc, e),
      value: v,
    }, e, doc)
    return
  }

  /* 作用域链与脚本变量:静态不可判定,必须放过。
   * (动态值判定已在函数开头统一做过,这里不重复)
   * 现状只放过「纯标识符」,于是 KR 抽样 165 条 undefined-ref 里 123 条(74.5%)是误报:
   *   - `PREV.PREV` / `FROM.PREV`  —— 动态作用域指向(vanilla 脚本里出现 543 次)
   *   - `var:global.ideology_groups^i` —— 脚本变量(vanilla 里 622 次)
   *   - `[IDEA]` / `[OLD_IDEOLOGY_TOKEN]` —— 宏占位符,运行期才替换
   *   - `RUS_bz_..._[IDEOLOGY_TOKEN]` —— 上一种的嵌套形态
   * 这些都不是「引用了一个不存在的实体」,报出来纯属噪音。*/

  /* 其余类型的裸标识符(变量名 / 枚举名)不是实体 id,放过 */
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return

  const set = ctx.types.names.get(refType)
  /* 索引没建起来 → 静默放过,否则该type 的所有引用都会被误报 */
  if (!set || set.size === 0) return
  const bare = v.includes(':') ? v.split(':').pop()! : v
  if (set.has(v) || set.has(bare)) return

  pushDiag(ctx, {
    code: 'undefined-ref',
    severity: 'error',
    message: `引用了不存在的 ${refType} "${v}"`,
    key: keyText(doc, e),
    value: v,
  }, e, doc)
}

/**
 * 判断一个引用值是否「静态不可判定」。
 *
 * 覆盖 5 类运行期才确定的形式(全部取自 vanilla / KR 的真实写法):
 *  1. 动态作用域:`PREV.PREV`、`ROOT.char:...`、`FROM.FROM`
 *  2. 脚本变量:`var:global.ideology_groups^i`、`global.x`
 *  3. 宏占位符:`[IDEA]`、`RUS_bz_..._[IDEOLOGY_TOKEN]`
 *  4. 数组 / 列表下标:`...^i`、`...^1`
 *  5. 间接引用:`event_target:leaker` —— 指向一个运行时才求值的 event target,
 *     vanilla 自己也在用(`event_target:blockade_target` 等),无法静态判定存在性。
 */
function isDynamicRefValue(v: string): boolean {
  // 宏占位符 [XXX] 出现在值里的任意位置
  if (/\[[A-Za-z_][A-Za-z0-9_]*\]/.test(v)) return true
  // 作用域链 PREV. / FROM. / ROOT. / THIS.(大小写都写,vanilla 两种都有)
  if (/^(PREV|FROM|ROOT|THIS)\./i.test(v)) return true
  // 脚本变量 var:xxx
  if (/^var:/i.test(v)) return true
  // 间接引用 event_target:xxx / random_country_tag 之类的命名空间前缀
  if (/^(event_target|random_[a-z_]+|any_[a-z_]+):/i.test(v)) return true
  // 数组下标 xxx^i
  if (/\^[i\d]*$/.test(v)) return true
  return false
}

function checkEnumValue(enumName: string, value: string | undefined, e: Entry, doc: Document, ctx: WalkCtx): void {
  const v = (value ?? '').trim()
  if (!v || /[<>=!]/.test(v)) return
  const set = ctx.enums.values.get(enumName)
  const lit = ctx.enums.declared.get(enumName)
  const allowed = set && set.size ? set : lit && lit.values.length ? new Set(lit.values) : null
  if (!allowed) return
  if (allowed.has(v)) return
  const sample = [...allowed].slice(0, 6).join(' / ')
  pushDiag(ctx, {
    code: 'bad-enum',
    severity: 'warning',
    message: `"${v}" 不是合法的 ${enumName}(可选: ${sample}${allowed.size > 6 ? ' …' : ''})`,
    key: keyText(doc, e),
    value: v,
  }, e, doc)
}

function checkLoc(value: string | undefined, e: Entry, doc: Document, ctx: WalkCtx): void {
  const keys = ctx.opts.locKeys
  if (!keys || !keys.size) return
  let v = (value ?? '').trim()
  if (!v) return
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  if (!v || v.includes('$')) return
  if (keys.has(v)) return
  /* ★ 运行期才定值的表达**不是 loc key**,放过。
   *   实测 KR 上这一项虚增了 7.5 万条 warning,形态有三种:
   *     `[GetLogRoot]: BoP UPC_bop_... is active`  ← 方括号取变量 + 冒号 + 空格拼接
   *     `[world_news_get_paris_capture_event_picture]`
   *     `KR_Event_Logging;SHX POWER STRUGGLE - ...` ← `;` 是日志前缀分隔符
   *   判据:含 `[` / `]` / `;` / 空格,或以 `[` 开头。
   *   真 loc key 不会含这些字符( Paradox 的 loc key 只允许字母数字下划线)。*/
  if (/[[\];]/.test(v)) return
  if (/\s/.test(v)) return
  pushDiag(ctx, {
    code: 'missing-loc',
    severity: 'warning',
    message: `本地化键 "${v}" 未定义`,
    key: keyText(doc, e),
    value: v,
  }, e, doc)
}

function checkCardinality(card: Directive, actual: number, key: string, e: Entry, doc: Document, ctx: WalkCtx): void {
  const m = /^~?(\d+)\.\.(\d+|inf)$/.exec(card.value.trim())
  if (!m) return
  const soft = card.value.trim().startsWith('~')
  const min = parseInt(m[1], 10)
  const max = m[2] === 'inf' ? Infinity : parseInt(m[2], 10)
  let bad = false
  let why = ''
  if (actual < min) {
    bad = true
    why = `至少需要 ${min} 个,实际 ${actual} 个`
  } else if (actual > max) {
    bad = true
    why = `最多允许 ${max} 个,实际 ${actual} 个`
  }
  if (!bad) return
  pushDiag(ctx, {
    code: 'cardinality',
    severity: soft ? 'info' : 'warning',
    message: `\`${key}\` 出现次数不符:${why}`,
    key,
  }, e, doc)
}