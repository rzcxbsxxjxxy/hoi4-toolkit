/**
 * 模组整体体检(validate)—— 把分散在各处的检查汇总成一个报告。
 *
 * 这是对标同类工具(如 PDX Tools/pdxu、Rakaly 的"查错",或 CWTools 的校验)的核心能力,
 * 但比它们更"语义化":
 *   - pdxu/Rakaly 只在**文件级**报语法错误,看不到"这个图标被谁引用、引用是否悬空";
 *   - CWTools 靠手写 rules 做作用域校验,覆盖不到 common/ 全部 95 个目录;
 *   - hoi4modding.com 只生成内容、完全不校验。
 * 本模块复用我们已经建好的三套索引(无损解析 / 跨文件 common 索引 / 本地化索引),
 * 给出一份跨文件、跨语言、可定位行号的体检报告。
 *
 * 检查项:
 *   1. 语法错误(parse 的 errors + 致命异常)
 *   2. 括号结构(多 } / 缺 })
 *   3. 重复定义(同名同 kind 在多处;区分"同 root 内真重复"与"跨 root 覆盖")
 *   4. 悬空引用:图标(gfx_sprite 在 sprite 索引里找不到) / 本地化键(任何语言都没有)
 *   5. 本地化完整性:BOM 缺失、跨文件重复键、定义引用了但没有任何语言提供的本地化键
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { walk, keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import { analyzeStructure } from './indexer.ts'
import { buildCommonIndex, type CommonIndex } from './common-index.ts'
import { parseLocYml, buildLocIndex, type LocFileResult, type LocIndex } from './loc.ts'
import { parseModDescriptor, type ModDescriptor } from './modmeta.ts'
import { auditReplacePaths } from './mapmodel.ts'
import { runMapCheck, type MapCheckIssue, type MapCheckResult } from './mapcheck.ts'

export interface CheckRoot {
  name: string
  path: string
}

export interface SyntaxIssue {
  root: string
  file: string
  /** 相对 root 的路径 */
  rel: string
  line?: number
  error: string
}

export interface BracketIssue {
  root: string
  rel: string
  kind: 'unclosed' | 'extra-close'
  lines: number[]
}

export interface DupGroup {
  kind: string
  id: string
  count: number
  /** 是否全部落在同一文件内(真重复嫌疑);跨文件多半是共享/覆盖 */
  sameFile: boolean
  locs: { root: string; file: string; line: number }[]
}

export interface DanglingRef {
  target: 'gfx_sprite' | 'loc_key'
  name: string
  file: string
  line: number
  owner?: string
  ownerKind?: string
  /** 若 target=loc_key 且某些语言有、但主语言(english)缺失 */
  missingInPrimary?: boolean
  /** ★ MOD_SCOPE_V1:这条引用出自哪个来源(只报目标模组时用来过滤) */
  root?: string
}

/**
 * 国策树一致性体检(对齐游戏加载期崩溃规则,来源 paradoxwikis National_focus_modding):
 *   - shared_focus 指向不存在的 focus → 游戏加载主菜单时崩溃;
 *   - focus_tree 只含 shared_focus、无任何非共享 focus → 同样崩溃。
 * 这些是游戏会在加载阶段直接崩的硬错误,体检必须提前报出来。
 */
export interface FocusIssue {
  root: string
  file: string
  line?: number
  error: string
}

/** 跨文件引用悬空:引用了一个在全部来源中都不存在的定义 id */
export interface CrossRefIssue {
  kind: string
  name: string
  file: string
  line: number
  root: string
}

export interface ReplacePathIssue {
  root: string
  replacePath: string
  kind: 'dir-missing' | 'dir-empty' | 'gap'
  msg: string
}

export interface DlcDepIssue {
  root: string
  dir: string
  dlc: string
  declared: boolean
  msg: string
}

export interface LocReport {
  files: number
  /** 无 BOM 的文件(游戏要求 UTF-8 BOM,否则中文乱码) */
  noBom: string[]
  /** 同一 (lang:key) 在多个文件重复定义 */
  dupKeys: { id: string; files: string[] }[]
  /** 解析异常文件 */
  errorFiles: { file: string; count: number; first: string }[]
  /** ★ MOD_SCOPE_V1:本次本地化检查覆盖的来源名(多来源合并索引) */
  roots?: string[]
}

export interface ValidationReport {
  roots: string[]
  /** ★ MOD_SCOPE_V1:实际只报了哪些来源的问题;空数组 = 全报 */
  scope: string[]
  /** ★ MOD_SCOPE_V1:作为上下文参与解析、但没被报问题的来源 */
  contextOnly: string[]
  scanned: { files: number; bytes: number; locFiles: number }
  syntax: SyntaxIssue[]
  brackets: BracketIssue[]
  duplicates: DupGroup[]
  danglingRefs: DanglingRef[]
  loc: LocReport
  /** 国策树一致性(shared_focus 崩溃规则) */
  focusConsistency: FocusIssue[]  /** 跨文件引用悬空(引用了不存在的定义 id) */
  crossRefs: CrossRefIssue[]
  /** replace_path 缺口/鲁莽清空(Wiki:元凶之首) */
  replacePaths: ReplacePathIssue[]
  /** DLC 目录但 .mod 未声明 dependencies */
  dlcDeps: DlcDepIssue[]
  /** 地图一致性(mapcheck) */
  map: MapCheckIssue[]
  /** 主语言(用于"缺失主语言本地化"的次级告警);没有英文则 undefined */
  primaryLang?: string
  stats: {
    errors: number
    warnings: number
    defs: number
    refs: number
  }
}

export interface ValidateOpts {
  /** 只扫这些 common 子目录(同名匹配路径片段),不传=全扫 */
  dirs?: string[]
  /** 文本扩展名,默认 .txt */
  exts?: string[]
  /** 外部注入的 sprite 名称集合(服务端已建好 SpriteIndex 时复用,避免重复扫) */
  spriteNames?: Set<string>
  /** 主语言,默认 l_english */
  primaryLang?: string
  /**
   * ★ 进度回调(每 200 个文件 / 每个目录报一次)。
   *   全量体检要扫几万个文件、耗时 ~30 秒,服务端把它挪到异步任务里,
   *   靠这个回调给前端画进度条,避免"白屏干等"被误认为卡死。
   */
  onProgress?: (done: number, total: number, phase: string) => void
  /**
   * ★ MOD_SCOPE_V1 —— 只报这些来源(root.name)的问题。
   *
   * 「限定范围」有两层,别只理解成过滤输出:
   *   1. **语法 / 括号**:只解析 scope 内的 root。scope 外的文件连读都不读,
   *      所以限定单模组时这一步是秒级,而不是全量体检的 33 秒。
   *   2. **悬空引用 / 重复定义 / 本地化**:roots 里的每个来源照常参与解析,
   *      但只输出 scope 内的条目。
   *
   * 为什么 vanilla 必须留在上下文里(第 2 点):
   *   模组引用原版图标(`picture = GFX_...`)、原版本地化键、原版科技 id
   *   是**常态**。若不把 vanilla 纳入判定集合,模组里每一个引用都会被误判成悬空,
   *   报告全是假警报 —— 那等于功能不可用。
   *
   * 不传 = 全报(原行为,CLI 与 smoke 都走这条)。
   */
  scope?: string[]
}

/* ── 文件遍历(仅本 root 下) ── */

function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let items: string[]
    try {
      items = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of items) {
      const p = join(cur, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (exts.some((x) => name.toLowerCase().endsWith(x))) out.push(p)
    }
  }
  return out
}

function safeParse(abs: string): { doc: Document; fatal?: string } {
  try {
    const doc = parse(readFileSync(abs, 'utf8'))
    return { doc }
  } catch (e) {
    return { doc: null as unknown as Document, fatal: String(e) }
  }
}

/* ── sprite 名称集合(图标引用悬空判定用) ──
 * 复用 sprites.ts 的判定思路:任何带 name= 的块都算"可被引用命名资源"。
 * 默认扫 gfx/ 与 interface/。这是 best-effort,可能漏掉纯代码生成的 sprite,
 * 但只会"少报悬空"、不会"误报悬空",安全性优先。
 */
export function scanSpriteNames(roots: CheckRoot[]): Set<string> {
  const set = new Set<string>()
  for (const r of roots) {
    for (const sub of ['gfx', 'interface']) {
      const dir = join(r.path, sub)
      if (!existsSync(dir)) continue
      for (const abs of walkFiles(dir, ['.gfx', '.gui'])) {
        const { doc } = safeParse(abs)
        if (!doc) continue
        walk(doc, (e: Entry) => {
          if (!e.block) return
          const n = childValue(doc, e.block, 'name')
          if (n) set.add(n)
        })
      }
    }
  }
  return set
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key) return valueText(doc, e)
  }
  return undefined
}

/* ── MOD_SCOPE_V1 · 每来源蒸馏结果 ──
 *
 * 为什么要「按来源」而不是「按整库」缓存:
 *   体检报告是**按来源拼装**的(语法问题来自谁、悬空引用出自谁、本地化文件属于谁),
 *   而用户会来回切目标模组。若只缓存整库结果,切一次模组就得把
 *   所有来源重新扫一遍(实测 20 s,其中模组自己 12 s)。
 *   按来源缓存后,切换只是**拼装**,实测降到百毫秒级。
 *
 * 蒸馏 = 只保留报告需要的形态,丢掉中间产物:
 *   - 语法/括号:本来就是最终形态,直接留
 *   - 本地化:**只留** lang+key → 文件 的映射(用于跨文件重复键判定)+
 *     键集合 + noBom/解析异常清单。entries[] 全部丢弃 ——
 *     vanilla 那 152 MB yml 展开后是几十万个大对象,留着就是几百 MB 常驻。
 */

interface RootLocDistilled {
  /** 该来源出现的全部本地化键(任意语言) */
  anyKeys: Set<string>
  /** 主语言(l_english)的键 */
  primaryKeys: Set<string>
  primaryExists: boolean
  /**
   * `lang:key` → 出现次数 > 1 的条目列表(重复键判定用)。
   * 值里带 file 与 line,所以同文件内重复和跨文件重复都能报出来 ——
   * 这与 buildLocIndex 的 `duplicates` 口径一致(它按 `lang:key:index` 分组、
   * 出现 >1 次即算重复)。
   */
  dupEntries: Map<string, { file: string; line: number }[]>
  noBom: string[]
  errorFiles: { file: string; count: number; first: string }[]
  files: number
}

interface RootScan {
  name: string
  files: number
  bytes: number
  syntax: SyntaxIssue[]
  brackets: BracketIssue[]
  loc: RootLocDistilled
  refs: CrossRefRef[]
}

/** 脚本里抽到的"引用了某个定义 id"的原始条目(存在性判定在 validateRoots 里做) */
interface CrossRefRef {
  kind: string
  name: string
  file: string
  line: number
}

/**
 * 高置信"引用定义 id"的键清单(误报控制)。
 * 只收设计文档点名的键;块值(如 `focus = {...}`)不查,只查单值标量。
 *
 * ⚠ 实测修剪(全量 vanilla+KR 验证):
 *   - ideology 已剔除:索引只抽顶层 ideology 组(democratic/...),subtype 永远查不到 → 8469 假 error。
 *   - character 已剔除:脚本里 `character = X` 几乎都是作用域参数
 *     (has_country_leader/create_country_leader 等),不是定义引用。
 *   - idea 已剔除:ideas 索引 depth:2 只抓"类别下的具体理念"(AFG_xxx),
 *     顶层设计公司理念(tank_manufacturer 等)不索引 → 系统性假警报。
 *   - equipment 已剔除:special_projects 等文件的 `equipment = X` 引用 script_enums
 *     枚举而非 units/equipment 定义 → 假警报。
 *   键匹配为**精确小写**:`DECISION = X`(tooltip 覆盖参数)不得匹配 decision。
 */
const REF_KINDS: Record<string, string> = {
  focus: 'focus', technology: 'technology', decision: 'decision',
  doctrine: 'doctrine', operation: 'operation',
  ability: 'ability', on_action: 'on_action', scripted_effect: 'scripted_effect',
  scripted_trigger: 'scripted_trigger', scripted_loc: 'scripted_loc',
  terrain: 'terrain', building: 'building',
  state_category: 'state_category', sub_unit: 'sub_unit',
  continuous_focus: 'continuous_focus',
}

const LOC_SUBDIRS = ['localisation', 'localisation_synced', 'localisation_synced_mod']

/**
 * 缓存键 / 分组键的分隔符。
 * 源码里写 '\u0001' 转义而不是直接落控制字符 —— 裸控制字符会让
 * 编辑器与 grep 判定文件是二进制,排查时非常难熬(本项目踩过)。
 */
const SEP = '\u0001'

/** 扫一个来源的本地化,产出蒸馏结果(不保留 entries) */
function distillLoc(root: CheckRoot, primary: string): RootLocDistilled {
  const anyKeys = new Set<string>()
  const primaryKeys = new Set<string>()
  const seen = new Map<string, { file: string; line: number }[]>()
  const noBom: string[] = []
  const errorFiles: RootLocDistilled['errorFiles'] = []
  let primaryExists = false
  let files = 0
  for (const sub of LOC_SUBDIRS) {
    const dir = join(root.path, sub)
    if (!existsSync(dir)) continue
    for (const abs of walkFiles(dir, ['.yml', '.yaml'])) {
      files++
      const rel = relative(root.path, abs).replace(/\\/g, '/')
      let parsed: LocFileResult
      try {
        parsed = parseLocYml(readFileSync(abs, 'utf8'), rel)
      } catch (e) {
        parsed = { file: rel, lang: null, entries: [], errors: [`读取/解析失败: ${String(e)}`], hasBom: false }
      }
      if (!parsed.hasBom) noBom.push(rel)
      if (parsed.errors.length) errorFiles.push({ file: rel, count: parsed.errors.length, first: parsed.errors[0] })
      if (parsed.lang === primary) primaryExists = true
      for (const e of parsed.entries) {
        anyKeys.add(e.key)
        if (parsed.lang === primary) primaryKeys.add(e.key)
        /* 重复键分组:沿用 buildLocIndex 的口径 —— 按 `lang:key:index` 分组,
         * 出现 >1 次即重复。这样**多行条目**(KEY:0 / KEY:1)不会被误判,
         * 而同一文件里把同一个键写两遍(真 bug)照样能报出来。
         *
         * ⚠ 按来源独立统计(distillLoc 每个 root 调一次),
         *   合并时也不能跨来源 —— 模组改写原版同一个键是**覆盖**,不是重复,
         *   那类问题归 common 索引的 duplicates 管。 */
        const k = `${e.lang}:${e.key}:${e.index ?? ''}`
        const arr = seen.get(k)
        if (arr) arr.push({ file: rel, line: e.line })
        else seen.set(k, [{ file: rel, line: e.line }])
      }
    }
  }
  return { anyKeys, primaryKeys, primaryExists, dupEntries: seen, noBom, errorFiles, files }
}

/** 扫一个来源的脚本(语法 + 括号 + 字节数) */
function scanScripts(root: CheckRoot, scriptSubs: string[], exts: string[], dirs: string[] | undefined, onTick?: (done: number, phase: string) => void): { files: number; bytes: number; syntax: SyntaxIssue[]; brackets: BracketIssue[]; refs: CrossRefRef[] } {
  let files = 0
  let bytes = 0
  const syntax: SyntaxIssue[] = []
  const brackets: BracketIssue[] = []
  const refs: CrossRefRef[] = []
  let inDir = 0
  for (const sub of scriptSubs) {
    const dir = join(root.path, sub)
    if (!existsSync(dir)) continue
    for (const abs of walkFiles(dir, exts)) {
      const rel = relative(root.path, abs).replace(/\\/g, '/')
      if (dirs && !dirs.some((d) => rel.toLowerCase().includes(`/${d.toLowerCase()}/`) || rel.toLowerCase().startsWith(d.toLowerCase() + '/'))) continue
      files++
      inDir++
      if (onTick && inDir % 200 === 0) onTick(inDir, `扫描 ${sub}/${root.name}`)
      try {
        bytes += statSync(abs).size
      } catch {
        /* ignore */
      }
      const { doc, fatal } = safeParse(abs)
      if (fatal) {
        syntax.push({ root: root.name, file: abs, rel, error: `解析致命异常: ${fatal.slice(0, 120)}` })
        continue
      }
      for (const err of doc.errors) syntax.push({ root: root.name, file: abs, rel, error: err })
      const { bracket, issue } = analyzeStructure(doc)
      if (bracket !== 'ok') {
        brackets.push({
          root: root.name,
          rel,
          kind: bracket,
          lines: bracket === 'unclosed' ? issue.unclosedAt : issue.extraCloseAt,
        })
      }
      // crossRefs:只收高置信"引用定义 id"的标量键(块值不查)
      // ⚠ 参数绑定类文件整体跳过:scripted_triggers/effects 里的 focus/character 等键
      //   是作用域参数,ai_* 里是策略参数 —— 全量实测全是假警报,不参与引用完整性。
      if (/^(scripted_triggers|scripted_effects|ai_strategy|ai_equipment)\//.test(rel)) {
        /* skip:参数绑定语义文件 */
      } else {
        walk(doc, (e: Entry) => {
          if (e.value < 0) return
          const k = keyText(doc, e)
          if (!k) return
          if (!(k in REF_KINDS)) return
          const v = (valueText(doc, e) ?? '').trim()
          // 值过滤:模板变量/方括号 token/注释引用/纯数字/布尔/含空白 → 跳过
          if (!v || v.startsWith('@') || v.startsWith('var:') || v.startsWith('token:') || v.startsWith('#') || v.includes('[') || v.includes(']') || /^\d+$/.test(v) || /^(yes|no|on|off)$/.test(v) || /\s/.test(v)) return
          refs.push({ kind: REF_KINDS[k], name: v, file: rel, line: lineOf(doc, e) })
        })
      }
    }
  }
  return { files, bytes, syntax, brackets, refs }
}

/* ── MOD_SCOPE_V1 · 上下文缓存 ──
 *
 * 三层缓存,各自按"什么变了就失效":
 *   1. **每来源蒸馏结果**(RootScan):切体检目标时复用 → 省掉模组重扫
 *      签名 = root 路径 + dirs/exts + 主语言
 *   2. **sprite 名称集合**:只跟"挂了哪些来源"有关 → 省 10.7 s
 *   3. **公共索引**(定义/引用):只跟"挂了哪些来源"有关 → 省 11.7 s
 *
 * 服务端在 ROOTS 变更时必须调 resetValidateCache(),否则会拿旧来源的
 * sprite 名 / loc 键去判定新挂载的模组 —— 那是**静默的假阴性**。
 */

/** 来源扫描签名:路径 + 作用域参数 */
function rootScanKey(r: CheckRoot, opts: ValidateOpts, primary: string): string {
  // 用 | 而不是控制字符做分隔:路径本身可能含各种字符,可读性也更好
  return [
    r.path,
    'dirs=' + (opts.dirs?.join(',') ?? ''),
    'exts=' + (opts.exts?.join(',') ?? ''),
    'primary=' + primary,
  ].join('|')
}

/** 整库签名:所有来源 + 作用域参数(顺序敏感,覆盖语义依赖顺序) */
function rootsKey(roots: CheckRoot[], opts: ValidateOpts, primary: string): string {
  return roots.map((r) => rootScanKey(r, opts, primary)).join('#')
}

/** 整库上下文缓存的值(定义索引 / sprite 名 / 本地化键 / 地图检查) */
interface ValidateCtx {
  anyLangKeys: Set<string>
  primaryKeys: Set<string>
  primaryExists: boolean
  spriteNames: Set<string>
  idx: CommonIndex
  mapCheck: MapCheckResult
}

const ROOT_CACHE = new Map<string, RootScan>()
let CTX_CACHE: { key: string; val: ValidateCtx } | null = null

/** 上下文缓存清理(ROOTS 变更时必须调) */
export function resetValidateCache(): void {
  ROOT_CACHE.clear()
  CTX_CACHE = null
}

/* ── 国策树一致性:对齐游戏加载期崩溃规则 ──
 *
 * paradoxwikis National_focus_modding 明确记载两条会直接让游戏在主菜单崩溃的规则:
 *   1. focus_tree 里的 `shared_focus = X` 若指向一个不存在的 focus → 崩溃;
 *   2. 一棵 focus_tree 只挂了 shared_focus、自身却没有任何非共享 focus → 崩溃。
 * 游戏加载时崩,模组作者自己跑游戏才能发现;体检提前查出来,等于把"加载即崩"
 * 这类最隐蔽的问题前置暴露。
 *
 * 存在性判定用**全来源**的 focus id 集合(模组引用原版 shared_focus 是常态),
 * 但**问题归属**只报 scope 内的来源(与悬空引用的口径一致)。 */
export function checkFocusConsistency(roots: CheckRoot[], idx: CommonIndex, scope: Set<string> | null): FocusIssue[] {
  const focusIds = new Set<string>()
  for (const d of idx.defs) if (d.kind === 'focus') focusIds.add(d.id)

  const out: FocusIssue[] = []
  for (const r of roots) {
    if (scope && !scope.has(r.name)) continue
    const dir = join(r.path, 'common', 'national_focus')
    if (!existsSync(dir)) continue
    for (const abs of walkFiles(dir, ['.txt'])) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      const { doc } = safeParse(abs)
      if (!doc) continue
      for (const e of doc.root.entries) {
        if (keyText(doc, e)?.toLowerCase() !== 'focus_tree' || !e.block) continue
        const tb = e.block
        const shared: { id: string; line: number }[] = []
        let focusCount = 0
        for (const e2 of tb.entries) {
          const k = keyText(doc, e2)?.toLowerCase()
          if (k === 'shared_focus') {
            const v = valueText(doc, e2)
            if (v) shared.push({ id: v, line: lineOf(doc, e2) })
          } else if (k === 'focus' && e2.block) {
            focusCount++
          }
        }
        for (const s of shared) {
          if (!focusIds.has(s.id)) {
            out.push({
              root: r.name,
              file: rel,
              line: s.line,
              error: `shared_focus 指向不存在的国策 "${s.id}" —— 游戏加载主菜单时会崩溃`,
            })
          }
        }
        if (shared.length > 0 && focusCount === 0) {
          out.push({
            root: r.name,
            file: rel,
            line: lineOf(doc, e),
            error: '国策树仅含 shared_focus 而无任何非共享 focus —— 游戏会崩溃',
          })
        }
      }
    }
  }
  return out
}

/* ── 主入口 ── */

export function validateRoots(roots: CheckRoot[], opts: ValidateOpts = {}): ValidationReport {
  const exts = opts.exts ?? ['.txt']
  const primary = opts.primaryLang ?? 'l_english'

  /* ★ MOD_SCOPE_V1 —— 限定「报哪些来源的问题」。
   *
   * 两个必须分清的层次:
   *   - **判定上下文**必须包含 vanilla:模组引用原版图标 / 本地化键 / 科技 id
   *     是常态,判定集合少了 vanilla 会把正常引用全判成悬空 —— 报告全是假警报。
   *   - **问题归属**只算 scope 内的来源。
   *
   * 实现上,每个来源的扫描结果按 rootScanKey 缓存,
   * 所以来回切目标模组只是拼装,不再重扫(实测 48 s → <1 s)。*/
  const scope = opts.scope?.length ? new Set(opts.scope) : null
  const inScope = (rootName: string): boolean => !scope || scope.has(rootName)

  // 只扫常见脚本目录;指定 --dirs 时聚焦 common 下对应子目录,避免扫全库
  const scriptSubs = opts.dirs ? ['common'] : ['common', 'events', 'decisions', 'history', 'interface', 'map', 'flags', 'ai']

  /* 1) 逐来源扫描(带缓存)
   *
   * scope 外的来源**也要扫**(本地化键 / 定义要进判定上下文),
   * 但它们的语法问题不会进报告。扫描结果按来源缓存,切换目标时复用。*/
  const progress = opts.onProgress
  const totalUnits = roots.length * (scriptSubs.length + LOC_SUBDIRS.length)
  let unit = 0
  const scans: RootScan[] = []
  for (const r of roots) {
    const key = rootScanKey(r, opts, primary)
    let sc = ROOT_CACHE.get(key)
    if (!sc) {
      const s = scanScripts(r, scriptSubs, exts, opts.dirs, (_done, phase) => progress?.(unit, totalUnits, phase))
      const loc = distillLoc(r, primary)
      sc = { name: r.name, files: s.files, bytes: s.bytes, syntax: s.syntax, brackets: s.brackets, loc, refs: s.refs }
      ROOT_CACHE.set(key, sc)
    } else if (progress) {
      progress(unit, totalUnits, `复用缓存 ${r.name}`)
    }
    unit++
    scans.push(sc)
  }

  // 汇总:文件数/字节数覆盖全部来源(它们确实被扫了),问题条目只取 scope 内
  let files = 0
  let bytes = 0
  const syntax: SyntaxIssue[] = []
  const brackets: BracketIssue[] = []
  const refs: CrossRefRef[] = []
  let locFiles = 0
  for (const sc of scans) {
    files += sc.files
    bytes += sc.bytes
    if (!inScope(sc.name)) continue
    syntax.push(...sc.syntax)
    brackets.push(...sc.brackets)
    locFiles += sc.loc.files
  }

  /* 2~4) 上下文:公共索引 / sprite 名 / 本地化键
   *
   * ★ 性能核心。这三样只取决于"挂了哪些来源",与"这次体检哪个模组"无关,
   * 故按 roots 签名整体缓存复用。*/
  const ck = rootsKey(roots, opts, primary)
  const hit = CTX_CACHE && CTX_CACHE.key === ck ? CTX_CACHE.val : null

  // 公共索引(定义 + 引用)
  const idx: CommonIndex =
    hit?.idx ?? buildCommonIndex(roots.map((r) => ({ name: r.name, path: r.path })), { dirs: opts.dirs, exts })

  // sprite 名称
  const spriteNames: Set<string> = hit?.spriteNames ?? opts.spriteNames ?? scanSpriteNames(roots)

  // 本地化:键集合取**全来源**(判定用),报告取 scope 内
  const anyLangKeys = new Set<string>()
  const primaryKeys = new Set<string>()
  let primaryExists = false
  /* 重复键报告:只统计 scope 内来源,且**每个来源独立成组**。
   * 跨来源同键 = 覆盖(正常),不算重复 —— 所以这里不能把不同来源的
   * 同名键合到一组,否则 vanilla 的每个键都会被模组的同名键算成重复。*/
  const repDup = new Map<string, { file: string; line: number }[]>()
  const noBom: string[] = []
  const errorFiles: LocReport['errorFiles'] = []
  for (const sc of scans) {
    for (const k of sc.loc.anyKeys) anyLangKeys.add(k)
    for (const k of sc.loc.primaryKeys) primaryKeys.add(k)
    if (sc.loc.primaryExists) primaryExists = true
    if (!inScope(sc.name)) continue
    noBom.push(...sc.loc.noBom)
    errorFiles.push(...sc.loc.errorFiles)
    for (const [k, arr] of sc.loc.dupEntries) {
      // 组名带上来源,避免不同来源的同名键被合并
      const gk = sc.name + SEP + k
      const cur = repDup.get(gk)
      if (cur) cur.push(...arr)
      else repDup.set(gk, arr.slice())
    }
  }
  // 出现 >1 次 = 重复(同文件内重复与跨文件重复都算,与原口径一致)
  const dupKeys = [...repDup.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([gk, arr]) => ({ id: gk.slice(gk.indexOf(SEP) + 1), files: [...new Set(arr.map((e) => e.file))] }))
  CTX_CACHE = { key: ck, val: { anyLangKeys, primaryKeys, primaryExists, spriteNames, idx, mapCheck: hit?.mapCheck ?? runMapCheck(roots) } }

  // 5) 悬空引用
  // 图标引用只把"显式 GFX_ 前缀"的当硬错误 —— 大量 `picture = attack` 这类裸名是
  // 战术/理念简写,引擎另有解析路径,且 vanilla 自身就有上万处,列为硬错误会淹没真实问题。
  const gfxNameRe = /gfx/i
  const danglingRefs: DanglingRef[] = []
  for (const ref of idx.refs) {
    // ★ MOD_SCOPE_V1:只报目标模组里写出来的引用。判定用的
    //   spriteNames / anyLangKeys / primaryKeys 仍然是全量上下文。
    const refRoot = roots[ref.root]?.name ?? ''
    if (scope && !inScope(refRoot)) continue
    if (ref.target === 'gfx_sprite') {
      if (!gfxNameRe.test(ref.name)) continue
      if (!spriteNames.has(ref.name)) {
        danglingRefs.push({
          target: 'gfx_sprite',
          name: ref.name,
          file: ref.file,
          line: ref.line,
          owner: ref.owner,
          ownerKind: ref.ownerKind,
          root: refRoot,
        })
      }
    } else if (ref.target === 'loc_key') {
      const hasAny = anyLangKeys.has(ref.name)
      const missingInPrimary = primaryExists && !primaryKeys.has(ref.name)
      if (!hasAny || missingInPrimary) {
        danglingRefs.push({
          target: 'loc_key',
          name: ref.name,
          file: ref.file,
          line: ref.line,
          owner: ref.owner,
          ownerKind: ref.ownerKind,
          missingInPrimary,
          root: refRoot,
        })
      }
    }
  }

  // 6) 重复定义(区分"同文件真重复"(疑似 bug) vs "跨文件共享/覆盖"(通常正常))
  /* ★ MOD_SCOPE_V1:只保留**至少有一处**落在 scope 内的组。
   *   否则纯 vanilla 的重复(原版自己就有几千条)会淹没模组报告。*/
  const duplicates: DupGroup[] = []
  for (const [key, arr] of idx.byId) {
    if (arr.length < 2) continue
    if (scope && !arr.some((d) => inScope(roots[d.root]?.name ?? ''))) continue
    const [kind, id] = key.split(':')
    /* ⚠ sameFile 必须按 **root + file** 判,不能只比 file。
     *
     *   `file` 是**相对各自 root** 的路径,所以
     *   vanilla 的 common/technologies/nsb_armor.txt 与
     *   模组的 common/technologies/nsb_armor.txt
     *   在字符串上**完全相同** —— 只比 file 会把「模组覆盖原版」
     *   误判成「同文件真重复」。
     *
     *   实测(vanilla + KR + Blackice 三来源):
     *     修复前 sameFile 组 = 7009,其中 **6697 组是跨来源误判**;
     *     修复后 = 312,且跨来源的剩 0 组。
     *   而 sameFile 直接决定 errors 计数(见下方 stats),
     *   也就是说修复前 7009 个"错误"里 6697 个是假的 ——
     *   报告几乎全是误报,真实问题会被彻底淹没。
     */
    const sameFile = arr.every((d) => d.root === arr[0].root && d.file === arr[0].file)
    duplicates.push({
      kind,
      id,
      count: arr.length,
      sameFile,
      locs: arr.map((d) => ({ root: roots[d.root]?.name ?? '', file: d.file, line: d.line })),
    })
  }
  duplicates.sort((a, b) => (b.sameFile === a.sameFile ? b.count - a.count : b.sameFile ? 1 : -1))

  // 8) 国策树一致性(shared_focus 崩溃规则)
  const focusConsistency: FocusIssue[] = checkFocusConsistency(roots, idx, scope)

  // 7) 本地化报告
  /* ★ MOD_SCOPE_V1:noBom / dupKeys / errorFiles 只含 scope 内来源的文件(报告用);
   *   anyLangKeys / primaryKeys 是全量(悬空判定用)。两者用途不同,别混用。*/
  const loc: LocReport = {
    files: locFiles,
    noBom,
    dupKeys,
    errorFiles,
    roots: scope ? roots.filter((r) => inScope(r.name)).map((r) => r.name) : roots.map((r) => r.name),
  }

  /* 9) 跨文件引用悬空(crossRefs)。判定上下文全量(idx 是全来源索引),
   *    与 danglingRefs 同口径:只输出 scope 内 root 的 refs。 */
  const crossRefs: CrossRefIssue[] = []
  for (const sc of scans) {
    if (!inScope(sc.name)) continue
    for (const ref of sc.refs) {
      if (!idx.byId.has(`${ref.kind}:${ref.name}`)) {
        crossRefs.push({ kind: ref.kind, name: ref.name, file: ref.file, line: ref.line, root: sc.name })
      }
    }
  }

  /* 10) replace_path 检查(Wiki:元凶之首——鲁莽清空目录) */
  const descs: ModDescriptor[] = roots.map((r) => parseModDescriptor(r.path))
  const replacePaths: ReplacePathIssue[] = []
  const dirHasFile = (abs: string): boolean => {
    const stack = [abs]
    while (stack.length) {
      const cur = stack.pop()!
      let items: string[]
      try {
        items = readdirSync(cur)
      } catch {
        break
      }
      for (const nm of items) {
        const pp = join(cur, nm)
        let stt
        try {
          stt = statSync(pp)
        } catch {
          continue
        }
        if (stt.isDirectory()) stack.push(pp)
        else return true
      }
    }
    return false
  }
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i]
    if (!inScope(r.name)) continue
    for (const rp of descs[i].replacePaths) {
      const dir = join(r.path, rp)
      if (!existsSync(dir)) {
        replacePaths.push({
          root: r.name,
          replacePath: rp,
          kind: 'dir-missing',
          msg: `声明 replace_path="${rp}" 但模组内没有该目录 —— 游戏会删除原版该目录全部内容且不回退`,
        })
        continue
      }
      if (!dirHasFile(dir)) {
        replacePaths.push({
          root: r.name,
          replacePath: rp,
          kind: 'dir-empty',
          msg: `声明 replace_path="${rp}" 但该目录在模组内为空 —— 等于清空原版该目录`,
        })
      }
    }
  }
  try {
    const audit = auditReplacePaths(
      roots.map((r, i) => ({ name: r.name, path: r.path, writable: r.name !== 'vanilla', replacePaths: descs[i].replacePaths })),
      descs,
    )
    for (const g of audit.gaps) {
      const ownerIdx = descs.findIndex((d) => d.name && d.name === g.mod)
      const rootName = ownerIdx >= 0 ? roots[ownerIdx]?.name ?? g.mod : g.mod
      if (!inScope(rootName)) continue
      replacePaths.push({
        root: rootName,
        replacePath: g.replacePath,
        kind: 'gap',
        msg: `replace_path="${g.replacePath}" 使原版 ${g.missing.length} 个文件被丢弃,未提供的有:${g.missing.slice(0, 10).join('、')}${g.missing.length > 10 ? ' …' : ''}`,
      })
    }
  } catch {
    /* audit 失败不拖垮体检 */
  }

  /* 11) DLC 依赖声明检查(common/<DLC专属目录> 有内容但未声明 dependencies) */
  const DLC_DIRS: Record<string, string> = {
    military_industrial_organization: 'Gotterdammerung',
    raids: 'By Blood Alone',
    technology_sharing: 'Graveyard of Empires',
  }
  const dlcDeps: DlcDepIssue[] = []
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i]
    if (!inScope(r.name)) continue
    // 基础游戏没有 .mod:它自己就带着 DLC 目录,不存在"声明 dependencies"一说
    if (!descs[i].hasModFile) continue
    for (const dir of Object.keys(DLC_DIRS)) {
      if (!dirHasFile(join(r.path, 'common', dir))) continue
      const dlc = DLC_DIRS[dir]
      const declared = descs[i].dependencies.some((d) => d.toLowerCase().includes(dlc.toLowerCase()))
      if (!declared) {
        dlcDeps.push({
          root: r.name,
          dir: `common/${dir}`,
          dlc,
          declared: false,
          msg: `目录 common/${dir} 的内容需要 DLC「${dlc}」,但 .mod 未在 dependencies 中声明 —— 无该 DLC 的玩家加载时会报错/内容缺失`,
        })
      }
    }
  }

  /* 12) 地图一致性(mapcheck,按整库缓存);scope 过滤按 files 归属 */
  const mapAll: MapCheckResult = CTX_CACHE && CTX_CACHE.key === ck ? CTX_CACHE.val.mapCheck : runMapCheck(roots)
  const map: MapCheckIssue[] = scope ? mapAll.issues.filter((it) => it.files.some((f) => scope.has(f.root))) : mapAll.issues

  const gfxDangling = danglingRefs.filter((d) => d.target === 'gfx_sprite').length
  const locMissing = danglingRefs.filter((d) => d.target === 'loc_key' && !d.missingInPrimary).length
  // 括号检查基于 token 计数,对部分合法写法会误报(如带空格文件名的 history 文件),
  // 因此只作"提示"计入警告,不计入硬错误。
  const mapErrors = map.filter((m) => m.severity === 'error').length
  const mapWarns = map.filter((m) => m.severity === 'warn').length
  const errors =
    syntax.length + locMissing + duplicates.filter((d) => d.sameFile).length + loc.errorFiles.length +
    focusConsistency.length + crossRefs.length + mapErrors + replacePaths.length
  const warnings =
    danglingRefs.filter((d) => d.missingInPrimary).length +
    duplicates.filter((d) => !d.sameFile).length +
    loc.noBom.length +
    loc.dupKeys.length +
    gfxDangling +
    brackets.length +
    mapWarns +
    dlcDeps.length

  return {
    roots: roots.map((r) => r.name),
    scope: scope ? [...scope] : [],
    contextOnly: scope ? roots.filter((r) => !inScope(r.name)).map((r) => r.name) : [],
    scanned: { files, bytes, locFiles },
    syntax,
    brackets,
    duplicates,
    danglingRefs,
    loc,
    focusConsistency,
    crossRefs,
    replacePaths,
    dlcDeps,
    map,
    primaryLang: primaryExists ? primary : undefined,
    stats: {
      errors,
      warnings,
      defs: idx.defs.length,
      refs: idx.refs.length,
    },
  }
}
