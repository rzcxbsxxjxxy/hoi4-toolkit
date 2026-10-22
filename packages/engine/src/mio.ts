/**
 * 军工机构(MIO)特质树 —— 链状结构提取。
 *
 * ── 数据结构(实测自 vanilla common/military_industrial_organization/)──
 *
 * 一个 organization 文件形如:
 *   GER_porsche_organization = {
 *       include = generic_heavy_tank_organization     ← 继承另一个机构的【整个网格】
 *       icon = GFX_idea_porsche
 *       allowed = { ... }                             ← DLC 门控(靠 NOR_AAT 宏)
 *       tree_header_text = { text = mio_header_chassis  x = 4 }   ← 列标题,x = 网格列坐标
 *       override_trait = { token = generic_mio_trait_wide_tracks
 *                          position = { x = 0 y = 0 } }          ← 改写继承来的节点位置
 *       add_trait = { token = GER_mio_trait_multi_role_tanks
 *                      position = { x = 2 y = 0 }
 *                      all_parents = { A B }        ← 全部父节点都满足才解锁
 *                      any_parent  = { A B }         ← 任一父节点满足即解锁
 *                      relative_position_id = A      ← position 的网格基准节点
 *                      equipment_bonus = { breakthrough = 0.05 ... }
 *                      ... }
 *   }
 *
 * ★ 三个关键点(决定了能不能画出正确的链):
 *
 *  1) **position 是网格坐标,不是像素**。x = 列(受 tree_header_text 的 x 分列),
 *     y = 行。行可以往下延伸(0,1,2,3,4 都出现),列也可以往左(-2 ~ 9)。
 *     @var 参与坐标:`position = { x = @tank_hoesch_X y = @tank_hoesch_Y }`。
 *
 *  2) **relative_position_id 决定 position 的基准**。
 *     缺省 = 相对【本树的原点】;写了 = 相对【那个节点的格子】。
 *     所以同一个 position={x=1 y=1} 在不同 relative_position_id 下落在不同格子。
 *     ⚠ 这是最容易画错的地方 —— 不解析它,整棵树会错位。
 *
 *  3) **include 是整树继承**。25 个 generic_*_organization 提供"底盘",
 *     各国 organization 在其上 add(加节点)/ override(改位置)。
 *     所以要把 generic 与 country 两层【合并】成一棵树,而不是各画各的。
 *     override_trait 只改 position,不改 token 本身。
 *
 * ── 为什么不用通用的 dlc.ts 提取器 ──
 * dlc.ts 走"根级条目 = 一个 organization"的模型,给的是 flat 列表。
 * MIO 要的是【一张网格图 + 连线】,必须保留 parent/position/relative_position_id,
 * 还得做 include 合并 —— 是完全不同的数据形状。故独立成文件。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf, walk } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'

export interface MioTrait {
  /** token 全局唯一标识(同一 token 可能在多个机构里出现) */
  token: string
  /** 所属 organization id(合并后) */
  org: string
  /** 网格列 / 行(已按 relative_position_id 解析成绝对格) */
  gx: number
  gy: number
  /**
   * 网格基准节点 = relative_position_id。
   * null = 相对本树原点。
   */
  relTo: string | null
  /** ★ 边的语义,决定连线画法 */
  links: { type: 'all' | 'any'; parents: string[] }[]
  icon?: string
  /** 只在某种装备类型下生效(裸值列表) */
  limitTo: string[]
  /** equipment_bonus 里的叶子(加法/乘法分开在这里体现:键名自带语义) */
  bonus: Record<string, number>
  productionBonus: Record<string, number>
  /** 该节点是否被某个 DLC 门控(allowed 块里出现 has_dlc / NOR_AAT 之类) */
  hasDlc: string[]
  /** 该节点是否为 special_trait_background(特殊底色) */
  specialBg: boolean
  file: string
  line: number
  root: number
  /** 来自 generic 层(include 继承)还是本国 add */
  fromGeneric: boolean
  /**
   * ★ 起始特质(`initial_trait = { name = ... }`,2026-10-06 加)。
   *   它是 MIO 树的**第一格**,没有 `token` 也没有前置 —— 名字写在 `name` 上。
   *   没有这个标记时,「只有 initial_trait、没有 add_trait」的机构整棵树为空,
   *   前端看起来就像"这个机构没被识别出来"。
   */
  initial?: boolean
  /** 本地化键(很多 trait 写 name,不只是 token) */
  name?: string
  /** 互斥特质(mutually_exclusive):选了这个就不能选那些 token */
  mutuallyExclusive?: string[]
  /** on_complete 事件块是否存在 */
  onComplete?: boolean
  /** organization_modifier 里的 boni(影响 MIO 自身) */
  organizationModifier?: Record<string, number>
  /** ai_will_do 自定义权重原文 */
  aiWillDo?: string
  /** 是否有 visible / available 条件 */
  hasVisible?: boolean
  hasAvailable?: boolean
  /** ★ MIO_WIKI_V1:include/override 时 delete_included_values 要清空的字段(文档:用默认值覆盖) */
  deleteIncluded?: string[]
  /** ★ MIO_WIKI_V1:parent 块形式 —— 至少 numNeeded 个满足 traits 列表(标量 parent 仍走 links) */
  parentNum?: { traits: string[]; numNeeded: number }
  /** ★ MIO_WIKI_V1:on_complete 块内容摘要(onComplete 布尔保留) */
  onCompleteText?: string
  /** ★ MIO_WIKI_V1:allowed/visible/available 条件摘要 */
  gates?: { visible?: string; available?: string; allowed?: string }
}

export interface MioTree {
  /** organization id → 该机构的树 */
  orgs: Map<string, {
    id: string
    label?: string
    icon?: string
    /** include 了哪些 generic 树(按声明顺序) */
    includes: string[]
    /** 列标题:{ x: 列号, text: 标题 } */
    headers: { x: number; text: string }[]
    hasDlc: string[]
    gated: boolean
    name?: string
    /** Wiki:equipment_type(受影响的装备类型) */
    equipmentType?: string[]
    /** Wiki:research_categories(受影响的研究类别) */
    researchCategories?: string[]
    /** Wiki:research_bonus(默认研究加成,默认 0.2) */
    researchBonus?: number
    /** Wiki:task_capacity(并行任务数) */
    taskCapacity?: number
    /** Wiki:ai_will_do 原文 */
    aiWillDo?: string
    /** ★ MIO_WIKI_V1:background = GFX key */
    background?: string
    /** ★ MIO_WIKI_V1:allowed/visible/available 条件摘要 */
    gates?: { allowed?: string; visible?: string; available?: string }
    /** ★ MIO_WIKI_V1:存在的 org 级事件键(on_design_team_* / on_industrial_* / on_tech_research_*) */
    orgEvents?: string[]
    /** ★ MIO_WIKI_V1:initial_trait 块的 name */
    initialTrait?: string
    /** ★ MIO_WIKI_V1:remove_trait 的 token(只解析展示,不实现删除节点语义) */
    removeTraits?: string[]
    /** ★ MIO_WIKI_V1:include 时 delete_included_values 清空的字段(文档:除 trait 外均可) */
    deleteIncluded?: string[]
    file: string
    line: number
    root: number
  }>
  /** token → trait */
  traits: Map<string, MioTrait>
  /** 合并后仍存在的 organization id(按文件顺序) */
  order: string[]
  /**
   * ★ OWNERSHIP_V1:机构 id → 全部定义现场(按载入序)。
   *   orgs 这个 Map 本来就是"后加载覆盖先加载",但覆盖的同时把原版那份丢了,
   *   于是无从判断"这个机构是模组新增的还是改写了原版的"。这里把链留下来。
   */
  orgVersions: Map<string, { root: number; file: string; line: number }[]>
  /** ★ OVERRIDE_V2:机构 override_trait 对其继承节点的完整覆盖记录(org#token → 覆盖字段) */
  overrides: Map<string, { pos?: { x: number; y: number }; bonus?: Record<string, number>; productionBonus?: Record<string, number>; organizationModifier?: Record<string, number>; name?: string; icon?: string; mutuallyExclusive?: string[]; deleteIncluded?: string[]; gates?: { visible?: string; available?: string; allowed?: string }; hasAvailable?: boolean; hasVisible?: boolean; file: string; line: number; root: number }>
  /** ★ POLICY_V2:全局政策(玩家可为机构附加 1 个;bonus 按装备类型嵌套) */
  policies: MioPolicy[]
  issues: { kind: string; detail: string; file: string; line: number }[]
  ms: number
}

interface Ctx {
  root: number
  file: string
  doc: Document
  vars: Map<string, number>
}

/* ── AST 小工具(与 dlc.ts 同款,自成一体避免耦合) ── */

function childBlock (doc: Document, b: Block, key: string): Block | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === lk && e.block) return e.block
  }
  return undefined
}
function childBlocks (doc: Document, b: Block, key: string): Block[] {
  const lk = key.toLowerCase()
  const out: Block[] = []
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === lk && e.block) out.push(e.block)
  }
  return out
}
function childValue (doc: Document, b: Block, key: string): string | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() === lk) return valueText(doc, e)
  }
  return undefined
}
/**
 * 块里的【裸值】列表(无键的 entry)。
 * 判据 = `e.key < 0`(有键就不是裸值),与 dlc.ts 同款。
 * walk() 的签名是 (doc, visit) 从 doc.root 起遍历,不能拿它遍历单个块。
 */
function bareValues (doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) if (e.key < 0 && e.value >= 0) out.push(valueText(doc, e) ?? '')
  return out.filter((x) => x.trim())
}
/** 递归收集所有叶子数值(键 → 数字) */
function leafNums (doc: Document, b: Block, d = 0): Record<string, number> {
  const out: Record<string, number> = {}
  if (d > 4) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (e.block) {
      const n = Number(valueText(doc, e) ?? NaN)
      if (Number.isFinite(n)) { out[k] = n; continue }
      Object.assign(out, leafNums(doc, e.block, d + 1))
    } else {
      const n = Number(valueText(doc, e))
      if (Number.isFinite(n)) out[k] = n
    }
  }
  return out
}
function collectHasDlc (doc: Document, b: Block, d = 0): Set<string> {
  const out = new Set<string>()
  if (d > 5) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (k?.toLowerCase() === 'has_dlc') {
      const v = valueText(doc, e)
      if (v) out.add(unq(v))
      continue
    }
    if (e.block) for (const x of collectHasDlc(doc, e.block, d + 1)) out.add(x)
  }
  return out
}
function unq (s: string): string {
  const t = s.trim()
  return t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))
    ? t.slice(1, -1)
    : t
}
function num (v: string | undefined, vars: Map<string, number>): number {
  if (v === undefined) return 0
  const t = v.trim()
  const n = Number(t)
  if (Number.isFinite(n)) return n
  if (t.startsWith('@')) return vars.get(t) ?? vars.get(t.toLowerCase()) ?? 0
  return 0
}
/** 全文收集 @var 定义(MIO 坐标里大量用 @var,如 `x = @tank_hoesch_X`) */
function collectVars (doc: Document): Map<string, number> {
  const vars = new Map<string, number>()
  walk(doc, (e) => {
    if (e.block) return
    const k = keyText(doc, e)
    if (!k || !k.startsWith('@')) return
    const n = Number(valueText(doc, e))
    if (Number.isFinite(n)) vars.set(k.toLowerCase(), n)
  })
  return vars
}
/** 取 position = { x = .. y = .. },支持 @var */
function readPos (doc: Document, b: Block, vars: Map<string, number>): { x: number; y: number } | undefined {
  const p = childBlock(doc, b, 'position')
  if (!p) return undefined
  const x = childValue(doc, p, 'x')
  const y = childValue(doc, p, 'y')
  if (x === undefined && y === undefined) return undefined
  return { x: num(x, vars), y: num(y, vars) }
}
/** 判据:块里除 always/never 外还有别的键 → 算真有条件 */
function hasRealGate (doc: Document, b: Block, keys: string[]): boolean {
  for (const key of keys) {
    const bb = childBlock(doc, b, key)
    if (!bb) continue
    for (const e of bb.entries) {
      const k = (keyText(doc, e) ?? '').toLowerCase()
      if (!k || k === 'always' || k === 'never') continue
      return true
    }
  }
  return false
}


/**
 * ★ MIO_WIKI_V1:条件块第一层摘要文本(用于右侧检查器展示 allowed/visible/available/on_complete 的内容)。
 *   逐 entry:
 *     · 块形式(owner = { ... }) → `key{内层第一层 key 列表(最多2个;无 key 取裸值)}`
 *     · 标量(has_dlc = "X")   → `key = value`
 *     · 裸值(A B ...)          → 直接取裸值
 *   join(', '),超 maxLen 截断保留前几项。
 *   例:`allowed = { has_dlc = "Arms Against Tyranny" is_debug = yes }`
 *       → `has_dlc = "Arms Against Tyranny", is_debug = yes`
 *      `visible = { owner = { has_country_flag = X } }`
 *       → `owner{has_country_flag}`
 */
function summCond (doc: Document, b: Block, maxLen = 80): string {
  const parts: string[] = []
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (e.block) {
      if (!k) { const v = valueText(doc, e); if (v) parts.push(v); continue }
      const innerKeys: string[] = []
      const innerBare: string[] = []
      for (const ie of e.block.entries) {
        const ik = keyText(doc, ie)
        if (ik) innerKeys.push(ik)
        else if (ie.value >= 0) innerBare.push(valueText(doc, ie) ?? '')
      }
      const innerLabel = innerKeys.length ? innerKeys.slice(0, 2).join(', ') : innerBare.slice(0, 2).join(', ')
      parts.push(innerLabel ? `${k}{${innerLabel}}` : k)
    } else if (k) {
      const v = valueText(doc, e) ?? ''
      parts.push(v !== '' ? `${k} = ${v}` : k)
    } else {
      const v = valueText(doc, e)
      if (v) parts.push(v)
    }
  }
  let s = parts.join(', ')
  if (s.length > maxLen) {
    let acc = ''
    for (const p of parts) {
      const next = acc ? acc + ', ' + p : p
      if (next.length > maxLen) break
      acc = next
    }
    s = acc ? acc + '…' : (parts[0]?.slice(0, maxLen) ?? '')
  }
  return s
}

/** 汇总一个块(机构或特质)上的 allowed/visible/available 条件摘要;全空返回 undefined */
function summGates (doc: Document, b: Block): { visible?: string; available?: string; allowed?: string } | undefined {
  const out: { visible?: string; available?: string; allowed?: string } = {}
  const vb = childBlock(doc, b, 'visible')
  if (vb) out.visible = summCond(doc, vb)
  const ab = childBlock(doc, b, 'available')
  if (ab) out.available = summCond(doc, ab)
  const alb = childBlock(doc, b, 'allowed')
  if (alb) out.allowed = summCond(doc, alb)
  return out.visible || out.available || out.allowed ? out : undefined
}
/* ── 主构建 ── */

/**
 * 判断一个顶层块是不是「一个 MIO 机构的定义块」。
 *
 * ★★ 不能只认美式 `_organization` 后缀(2026-10-06 修):
 *   MIO 的 id 是**脚本 id,作者爱怎么起就怎么起**,不存在强制命名约定。
 *   实测模组 `(Beta)Kaiserreich` 的 34 个机构里:
 *     · 美式 `_organization`   6 个  (vanilla 全部 512 个都是这个,所以早期缺陷没暴露)
 *     · 英式 `_organisation`  27 个  ← 拼写变体,老实现整批漏掉
 *     · 复数 `_organizations`   1 个  (`new_gameplay_custom_mio_wunderwaffen_organizations`)
 *     · `_MIO` 结尾            1 个  (`challenge_mode_AI_land_cruiser_MIO`)
 *   只认一种 → 34 个里只认出 6 个,表现为「DLC 页的军工机构看不到模组内容」。
 *
 * 判据改为**后缀白名单 + 块内特征兜底**:
 *   ① 后缀白名单(美式/英式/复数/_mio,大小写不敏感)—— 覆盖绝大多数;
 *   ② 后缀不认识时,查**块内**有没有 MIO 专属键兜底 —— 短文件
 *      (如 33 行的 `challenge_mode_organization.txt` 只有 1 个顶层块)只能靠这条认出。
 *
 * 保守性:特征判据要求块内含 MIO 专属键,不会把 `technology` / `focus_tree` /
 * `state` 这类同为「顶层块」的结构误收 —— 它们不含下面任何一个键。
 */
const MIO_SUFFIX = /_org[ai]nisations?$|_mio$/
/** MIO 机构块内专属键(其他顶层结构不会有) */
const MIO_BLOCK_HINT = /^[ \t]*(add_trait|override_trait|initial_trait|tree_header_text|tree_header_texts)[ \t]*=/m

function looksLikeMioOrg (k: string, blockSrc: string): boolean {
  if (MIO_SUFFIX.test(k.toLowerCase())) return true
  return MIO_BLOCK_HINT.test(blockSrc)
}

export function buildMioTrees (roots: { name: string; path: string }[]): MioTree {
  const t0 = Date.now()
  const orgs = new Map<string, {
    id: string; name?: string; label?: string; icon?: string; includes: string[]
    headers: { x: number; text: string }[]
    hasDlc: string[]; gated: boolean; file: string; line: number; root: number
  }>()
  const traits = new Map<string, MioTrait>()
  const order: string[] = []
  /** ★ OWNERSHIP_V1:机构 id → 全部定义现场(按载入序) */
  const orgVersions = new Map<string, { root: number; file: string; line: number }[]>()
  const overrides = new Map<string, { pos?: { x: number; y: number }; bonus?: Record<string, number>; productionBonus?: Record<string, number>; organizationModifier?: Record<string, number>; name?: string; icon?: string; mutuallyExclusive?: string[]; deleteIncluded?: string[]; gates?: { visible?: string; available?: string; allowed?: string }; hasAvailable?: boolean; hasVisible?: boolean; file: string; line: number; root: number }>()
  const issues: { kind: string; detail: string; file: string; line: number }[] = []
  /** generic 层:<orgId> → 原始块顺序,合并时用 */
  const rawByOrg = new Map<string, { ctx: Ctx; block: Block; line: number }[]>()

  for (const [ri, r] of roots.entries()) {
    const dir = joinPath(r.path, 'common', 'military_industrial_organization', 'organizations')
    let files: string[]
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.txt')) continue
      const rel = 'common/military_industrial_organization/organizations/' + f
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
      const abs = joinPath(dir, f)
      let src: string
      try { src = readFileSync(abs, 'utf8') } catch { continue }
      let doc: Document
      try { doc = parse(src) } catch { continue }
      const ctx: Ctx = { root: r.name === roots[0]?.name ? 0 : 1, file: abs, doc, vars: collectVars(doc) }

      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block) continue
        /* 用 token 区间切出本块的原文,供 looksLikeMioOrg 的特征判据用。
         * Token 只有起始 offset,结束位置用后一个 token 的 offset 兜底。 */
        const t0 = doc.tokens[e.start]
        const t1 = doc.tokens[Math.min(doc.tokens.length - 1, Math.max(0, e.end - 1))]
        if (t0 && t1 && looksLikeMioOrg(k, doc.source.slice(t0.offset, t1.offset + t1.text.length))) {
          const list = rawByOrg.get(k) ?? []
          list.push({ ctx, block: e.block, line: lineOf(doc, e) })
          rawByOrg.set(k, list)
          if (!order.includes(k)) order.push(k)
        }
      }
    }
  }

  /* 第一遍:登记 org 元信息 + 收集 generic 层 */
  for (const [oid, list] of rawByOrg) {
    for (const { ctx, block, line } of list) {
      const { doc } = ctx
      const includes: string[] = []
      for (const inc of childBlocks(doc, block, 'include')) {
        // include = xxx 是标量,不是块
        void inc
      }
      for (const e of block.entries) {
        if (keyText(doc, e)?.toLowerCase() === 'include') {
          const v = valueText(doc, e)
          if (v) includes.push(unq(v))
        }
      }
      const headers: { x: number; text: string }[] = []
      for (const hb of childBlocks(doc, block, 'tree_header_text')) {
        headers.push({ x: num(childValue(doc, hb, 'x'), ctx.vars), text: childValue(doc, hb, 'text') ?? '' })
      }
      const hd = new Set<string>()
      for (const key of ['allowed', 'available', 'visible']) {
        const bb = childBlock(doc, block, key)
        if (bb) for (const x of collectHasDlc(doc, bb)) hd.add(x)
      }
      /* ★ MIO_WIKI_V1:机构级 Wiki 字段计算(background/gates/orgEvents/initialTrait/removeTraits) */
      const orgGates = summGates(doc, block)
      const EVT_KEYS = ['on_design_team_assigned_to_tech', 'on_design_team_assigned_to_variant', 'on_industrial_manufacturer_assigned', 'on_industrial_manufacturer_unassigned', 'on_tech_research_cancelled', 'on_tech_research_completed']
      const orgEvents: string[] = []
      for (const ek of EVT_KEYS) if (childBlock(doc, block, ek)) orgEvents.push(ek)
      const ib0 = childBlock(doc, block, 'initial_trait')
      const rtSet = new Set<string>()
      for (const rb of childBlocks(doc, block, 'remove_trait')) for (const x of bareValues(doc, rb)) rtSet.add(unq(x))
      const rt0 = childValue(doc, block, 'remove_trait')
      if (rt0) rtSet.add(unq(rt0))
      const prev = orgs.get(oid)
      // ★ OWNERSHIP_V1:后加载的【整份替换】先加载的(与游戏语义一致)。
      //   同时把每一次定义记进 orgVersions,供归属三态(vanilla / 模组改写 / 模组新增)判定。
      const ov = orgVersions.get(oid) ?? []
      ov.push({ root: ctx.root, file: ctx.file, line })
      orgVersions.set(oid, ov)
      orgs.set(oid, {
        id: oid,
        name: childValue(doc, block, 'name') ?? prev?.name,
        label: childValue(doc, block, 'name') ?? prev?.label,
        icon: childValue(doc, block, 'icon') ?? prev?.icon,
        includes,
        headers,
        hasDlc: [...hd],
        gated: hasRealGate(doc, block, ['allowed', 'available', 'visible']),
        equipmentType: childBlock(doc, block, 'equipment_type') ? bareValues(doc, childBlock(doc, block, 'equipment_type')!) : undefined,
        researchCategories: childBlock(doc, block, 'research_categories') ? bareValues(doc, childBlock(doc, block, 'research_categories')!) : undefined,
        researchBonus: childValue(doc, block, 'research_bonus') !== undefined ? num(childValue(doc, block, 'research_bonus'), ctx.vars) : undefined,
        taskCapacity: childValue(doc, block, 'task_capacity') !== undefined ? num(childValue(doc, block, 'task_capacity'), ctx.vars) : undefined,
        aiWillDo: childValue(doc, block, 'ai_will_do'),
        background: childValue(doc, block, 'background') ?? prev?.background,
        gates: orgGates ?? prev?.gates,
        orgEvents: orgEvents.length ? orgEvents : prev?.orgEvents,
        initialTrait: (ib0 ? childValue(doc, ib0, 'name') : undefined) ?? prev?.initialTrait,
        removeTraits: rtSet.size ? [...rtSet] : prev?.removeTraits,
        deleteIncluded: (() => { const db = childBlock(doc, block, 'delete_included_values'); return db ? bareValues(doc, db) : undefined })(),
        file: ctx.file,
        line,
        root: ctx.root,
      })
    }
  }

  /* 第二遍:把 add_trait / override_trait 摊平成节点表 */
  /* ★ 待应用的坐标覆盖:`org#token` → override_trait 写的 position。
     第二遍跑在 include 展开(第三遍)之前,所以 override 声明时目标节点还不存在,
     这里先记下来,第三遍复制 generic 节点时套用。 */
  const overridePos = new Map<string, { pos: { x: number; y: number }; file: string; line: number; root: number }>()
  for (const [oid, list] of rawByOrg) {
    const isGeneric = /^(generic_|00_)/.test(oid) || oid.startsWith('generic')
    for (const { ctx, block, line } of list) {
      const { doc } = ctx
      const orgHd = orgs.get(oid)?.hasDlc ?? []
      const seen = new Set<string>()
      for (const e of block.entries) {
        // ★★★ 三个块名都算"节点声明",少一个整棵树就散:
        //   trait      —— generic 层用这个(00_generic_organization.txt 里 29 个机构全是)
        //   add_trait  —— 各国 organization 用这个,在 generic 底盘上加
        //   override_trait —— 只改 position(覆盖继承来的节点),不产生新节点
        // 早先只认 add_trait/override_trait → generic 层一个节点都没解析出来,
        // 于是 include 继承合并全空(GER_porsche 只剩 8 个 override 出来的节点)。
        const k = keyText(doc, e)?.toLowerCase()
        /* ★ `initial_trait` 也是节点(2026-10-06 补):它是 MIO 的**起始特质**,
         *   游戏里占树的第一格。没有 add_trait 的机构(实测模组的
         *   `challenge_mode_AI_land_cruiser_MIO` 就是)整棵树会空掉 ——
         *   前端渲染成"这个机构没有节点",看着像没识别出来。
         *   它没有 `token` 键(名字在 `name` 上),所以单开一支处理。 */
        if (k === 'initial_trait') {
          if (!e.block) continue
          const ib = e.block
          const nm = childValue(doc, ib, 'name')
          if (!nm) continue
          const tk0 = unq(nm)
          /* 起始特质的 token 用 name;若与已有节点同名则不重复建 */
          if (traits.has(`${oid}#${tk0}`)) continue
          const ielt = childBlock(doc, ib, 'limit_to_equipment_type')
          const ieb = childBlock(doc, ib, 'equipment_bonus')
          const ipb = childBlock(doc, ib, 'production_bonus')
          const ihd = new Set<string>(orgHd)
          for (const kk of ['available', 'visible', 'allowed']) {
            const bb = childBlock(doc, ib, kk)
            if (bb) for (const x of collectHasDlc(doc, bb)) ihd.add(x)
          }
          traits.set(`${oid}#${tk0}`, {
            token: tk0,
            org: oid,
            gx: 0,
            gy: 0,
            relTo: null,
            links: [],
            icon: childValue(doc, ib, 'icon'),
            limitTo: ielt ? bareValues(doc, ielt) : [],
            bonus: ieb ? leafNums(doc, ieb) : {},
            productionBonus: ipb ? leafNums(doc, ipb) : {},
            hasDlc: [...ihd],
            specialBg: false,
            file: ctx.file,
            line: lineOf(doc, e),
            root: ctx.root,
            fromGeneric: false,
            /* 起始特质 = 树的根,前端据此知道它没有前置 */
            initial: true,
            name: nm,
            mutuallyExclusive: (() => { const out = []; for (const b of childBlocks(doc, ib, 'mutually_exclusive')) for (const v of bareValues(doc, b)) out.push(unq(v)); return out })(),
            onComplete: !!childBlock(doc, ib, 'on_complete'),
            onCompleteText: (() => { const b = childBlock(doc, ib, 'on_complete'); return b ? summCond(doc, b) : undefined })(),
            organizationModifier: (() => { const b = childBlock(doc, ib, 'organization_modifier'); return b ? leafNums(doc, b) : {} })(),
            aiWillDo: childValue(doc, ib, 'ai_will_do'),
            gates: summGates(doc, ib),
            hasVisible: !!childBlock(doc, ib, 'visible'),
            hasAvailable: !!childBlock(doc, ib, 'available'),
            deleteIncluded: (() => { const db = childBlock(doc, ib, 'delete_included_values'); return db ? bareValues(doc, db) : undefined })(),
          } as MioTrait)
          seen.add(tk0)
          continue
        }
        if (k !== 'add_trait' && k !== 'override_trait' && k !== 'trait') continue
        if (!e.block) continue
        const tb = e.block
        const token = childValue(doc, tb, 'token')
        if (!token) continue
        const tk = unq(token)
        const isOverride = k === 'override_trait'
        // ★★ 节点表必须按 `org#token` 存,不能只用 token。
        //   实测 GER_mio_trait_hoesch_facilities 被 5 个机构共用
        //   (GER_organization.txt 第 105/364/552/698/970 行,分别在
        //   porsche / daimler / hanomag / steyr / vomag 底下),
        //   只用 token 索引会让【最后一个】机构(line 964)覆盖前面所有,
        //   于是 porsche 树少了 2 个节点,依赖它的 involve_porsche 也因
        //   relative_position_id 基准丢失而整条被丢掉(17 个只出 16)。
        //   游戏语义也正是"每个机构各有一份自己的节点",所以按 org 分开才对。
        const key = `${oid}#${tk}`
        if (isOverride) {
          // ★★★ override_trait 的真实语义(文档:通常 trait API,可覆盖【任意字段】,
          //   不只 position)。解析全部覆盖字段存进 overrides;position 套用逻辑保留。
          const ov: { pos?: { x: number; y: number }; bonus?: Record<string, number>; productionBonus?: Record<string, number>; organizationModifier?: Record<string, number>; name?: string; icon?: string; mutuallyExclusive?: string[]; deleteIncluded?: string[]; gates?: { visible?: string; available?: string; allowed?: string }; hasAvailable?: boolean; hasVisible?: boolean; file: string; line: number; root: number } = { file: ctx.file, line: lineOf(doc, e), root: ctx.root }
          const pos = readPos(doc, tb, ctx.vars)
          if (pos) ov.pos = pos
          const _eb = childBlock(doc, tb, 'equipment_bonus')
          if (_eb) ov.bonus = leafNums(doc, _eb)
          const _pb = childBlock(doc, tb, 'production_bonus')
          if (_pb) ov.productionBonus = leafNums(doc, _pb)
          const _omb = childBlock(doc, tb, 'organization_modifier')
          if (_omb) ov.organizationModifier = leafNums(doc, _omb)
          const _nm = childValue(doc, tb, 'name')
          if (_nm) ov.name = unq(_nm)
          const _ic = childValue(doc, tb, 'icon')
          if (_ic) ov.icon = unq(_ic)
          const _me: string[] = []
          for (const b of childBlocks(doc, tb, 'mutually_exclusive')) for (const v of bareValues(doc, b)) _me.push(unq(v))
          if (_me.length) ov.mutuallyExclusive = _me
          const _di = childBlock(doc, tb, 'delete_included_values')
          if (_di) ov.deleteIncluded = bareValues(doc, _di)
          const _g = summGates(doc, tb)
          if (_g) ov.gates = _g
          if (childBlock(doc, tb, 'available') || childBlock(doc, tb, 'is_available')) ov.hasAvailable = true
          if (childBlock(doc, tb, 'visible')) ov.hasVisible = true
          overrides.set(`${oid}#${tk}`, ov)
          if (pos) {
            const prev = traits.get(key)
            if (prev) {
              prev.gx = pos.x
              prev.gy = pos.y
              prev.file = ctx.file
              prev.line = lineOf(doc, e)
            } else {
              overridePos.set(key, { pos, file: ctx.file, line: lineOf(doc, e), root: ctx.root })
            }
          }
          seen.add(tk)
          continue
        }

        const pos = readPos(doc, tb, ctx.vars)
        const relTo = childValue(doc, tb, 'relative_position_id')
        const links: { type: 'all' | 'any'; parents: string[] }[] = []
        /* ★ MULTI_PARENT_BLOCKS:同一特质块可出现【多个】all_parents / any_parent 子块
           (实测 toz 树:`any_parent = {...}` 连写两段)。必须用 childBlocks 收集全部;
           childBlock 只取第一个会让后续 any_parent 的父节点全丢。 */
        for (const ap of childBlocks(doc, tb, 'all_parents')) links.push({ type: 'all', parents: bareValues(doc, ap) })
        for (const yp of childBlocks(doc, tb, 'any_parent')) links.push({ type: 'any', parents: bareValues(doc, yp) })
        const pp = childValue(doc, tb, 'parent')
        if (pp) links.push({ type: 'all', parents: [unq(pp)] })

        /* ★ MIO_WIKI_V1:parent 块形式(parent = { traits = { A B } num_parents_needed = 2 })。
         *   标量 parent 的上面 pp 逻辑保留不动;块形式单独解析成 parentNum 供前端画"至少 N 个"虚线。 */
        /* 多个 parent 块(至少 N 个)也合并:traits 取并集、num_parents_needed 求和 */
        const pnbs = childBlocks(doc, tb, 'parent')
        let parentNum: { traits: string[]; numNeeded: number } | undefined
        if (pnbs.length) {
          const pTraits: string[] = []
          let pNeed = 0
          for (const pnb of pnbs) {
            const tnb = childBlock(doc, pnb, 'traits')
            if (tnb) for (const t of bareValues(doc, tnb)) pTraits.push(unq(t))
            const nps = childValue(doc, pnb, 'num_parents_needed')
            pNeed += nps !== undefined ? (num(nps, ctx.vars) || 1) : 1
          }
          parentNum = { traits: pTraits, numNeeded: pNeed || 1 }
        }
        const ocb = childBlock(doc, tb, 'on_complete')
        const onCompleteText = ocb ? summCond(doc, ocb) : undefined
        const tbGates = summGates(doc, tb)

        const lt = childBlock(doc, tb, 'limit_to_equipment_type')
        const limBlk = childBlock(doc, tb, 'limit_to_equipment_type_list')
        const eb = childBlock(doc, tb, 'equipment_bonus')
        const pb = childBlock(doc, tb, 'production_bonus')
        const hd = new Set<string>(orgHd)
        for (const key of ['available', 'visible', 'allowed']) {
          const bb = childBlock(doc, tb, key)
          if (bb) for (const x of collectHasDlc(doc, bb)) hd.add(x)
        }
        traits.set(key, {
          token: tk,
          org: oid,
          gx: pos?.x ?? 0,
          gy: pos?.y ?? 0,
          relTo: relTo ? unq(relTo) : null,
          links,
          icon: childValue(doc, tb, 'icon'),
          limitTo: lt ? bareValues(doc, lt) : limBlk ? bareValues(doc, limBlk) : [],
          bonus: eb ? leafNums(doc, eb) : {},
          productionBonus: pb ? leafNums(doc, pb) : {},
          hasDlc: [...hd],
          specialBg: /^\s*(yes|true)\s*$/i.test(childValue(doc, tb, 'special_trait_background') ?? ''),
          name: childValue(doc, tb, 'name'),
          mutuallyExclusive: (() => { const out = []; for (const b of childBlocks(doc, tb, 'mutually_exclusive')) for (const v of bareValues(doc, b)) out.push(unq(v)); return out })(),
          onComplete: !!ocb,
          onCompleteText,
          parentNum,
          gates: tbGates,
          organizationModifier: (() => { const b = childBlock(doc, tb, 'organization_modifier'); return b ? leafNums(doc, b) : {} })(),
          aiWillDo: childValue(doc, tb, 'ai_will_do'),
          hasVisible: !!childBlock(doc, tb, 'visible'),
          hasAvailable: !!childBlock(doc, tb, 'available'),
          deleteIncluded: (() => { const db = childBlock(doc, tb, 'delete_included_values'); return db ? bareValues(doc, db) : undefined })(),
          file: ctx.file,
          line: lineOf(doc, e),
          root: ctx.root,
          fromGeneric: isGeneric,
        })
        seen.add(tk)
      }
    }
  }

  /* 第三遍:按 include 关系把 generic 节点归到各国 organization 下 */
  // 目的:generic_* 树是"底盘",被 include 的国家树要能看到它们
  const inheritOf = new Map<string, string[]>()   // org → 递归展开的 include 列表
  for (const [oid, o] of orgs) {
    const acc = new Set<string>()
    const stack = [...o.includes]
    let guard = 0
    while (stack.length && guard++ < 32) {
      const inc = stack.pop()!
      if (acc.has(inc)) continue
      acc.add(inc)
      const pio = orgs.get(inc)
      if (pio) for (const g of pio.includes) if (!acc.has(g)) stack.push(g)
    }
    inheritOf.set(oid, [...acc])
  }

  // org → 它自己声明的节点键(键已是 `org#token`,所以直接按前缀归组)
  const byOrg = new Map<string, string[]>()
  for (const [key, t] of traits) {
    const arr = byOrg.get(t.org) ?? []
    arr.push(key)
    byOrg.set(t.org, arr)
  }
  // 把 generic 节点复制进每个 include 了它的 org(以 `org#token` 为键,避免覆盖)
  const merged = new Map<string, MioTrait>(traits)
  for (const [oid, incs] of inheritOf) {
    for (const inc of incs) {
      for (const srcKey of byOrg.get(inc) ?? []) {
        const t = traits.get(srcKey)!
        if (t.org === oid) continue
        const key = `${oid}#${t.token}`
        if (merged.has(key)) continue
        // ★ 套用该机构 override_trait 声明的坐标(其余字段沿用 generic 树)
        const ov = overridePos.get(key)
        const ova = overrides.get(key)
        merged.set(
          key,
          ov || ova
            ? {
                ...t, org: oid,
                gx: ov ? ov.pos.x : t.gx, gy: ov ? ov.pos.y : t.gy,
                ...(ova?.name ? { name: ova.name } : {}),
                ...(ova?.icon ? { icon: ova.icon } : {}),
                ...(ova?.bonus ? { bonus: ova.bonus } : {}),
                ...(ova?.productionBonus ? { productionBonus: ova.productionBonus } : {}),
                ...(ova?.organizationModifier ? { organizationModifier: ova.organizationModifier } : {}),
                ...(ova?.mutuallyExclusive ? { mutuallyExclusive: ova.mutuallyExclusive } : {}),
                ...(ova?.deleteIncluded ? { deleteIncluded: ova.deleteIncluded } : {}),
                ...(ova?.gates ? { gates: ova.gates } : {}),
                ...(ova?.hasAvailable ? { hasAvailable: true } : {}),
                ...(ova?.hasVisible ? { hasVisible: true } : {}),
                file: ov?.file ?? ova?.file ?? t.file, line: ov?.line ?? ova?.line ?? t.line, root: ov?.root ?? ova?.root ?? t.root,
                fromGeneric: true,
              }
            : { ...t, org: oid, fromGeneric: true },
        )
      }
    }
  }
  // override 指向的 token 在任何 generic 树里都不存在 → 记诊断(而不是静默丢节点)
  for (const [key, ov] of overridePos) {
    if (merged.has(key)) continue
    const tk = key.slice(key.indexOf('#') + 1)
    issues.push({
      kind: 'orphanOverride',
      detail: `override_trait = ${tk} 覆盖了一个不存在的节点(include 的 generic 树里没有它),已忽略该覆盖`,
      file: ov.file, line: ov.line,
    })
  }

  // ★ 悬空 include 诊断(2026-10-06 加):`include = X` 的 X 在**任何来源**都没有定义。
  //   实测模组 `(Beta)Kaiserreich` 的 Acquired_KR_custom_organization.txt 里
  //   3 个机构(USA_boeing / USA_remington / RUS_av 的 _acquired 版)include 了
  //   同名但**不存在的**底盘机构 —— 原来引擎静默产出空树,前端显示成
  //   「这个机构没有节点」,与「模组内容没被识别」症状完全一样,极难区分。
  //   现在明确报出来:kind=danglingInclude。
  for (const [oid, o] of orgs) {
    for (const inc of o.includes) {
      if (orgs.has(inc)) continue
      issues.push({
        kind: 'danglingInclude',
        detail: `${oid} 的 include = ${inc} 指向一个不存在的机构(所有来源都没有定义它)—— 该树为空`,
        file: o.file, line: o.line,
      })
    }
  }

  // 校验:父节点是否解析得到
  for (const t of merged.values()) {
    for (const lk of t.links) {
      for (const p of lk.parents) {
        if (!merged.has(`${t.org}#${p}`) && !merged.has(p)) {
          issues.push({
            kind: 'unknownParent',
            detail: `${t.token} 的 ${lk.type === 'all' ? 'all_parents' : 'any_parent'} 引用了不存在的 ${p}`,
            file: t.file, line: t.line,
          })
        }
      }
    }
    if (t.parentNum) {
      for (const p of t.parentNum.traits) {
        if (!merged.has(`${t.org}#${p}`) && !merged.has(p)) {
          issues.push({
            kind: 'unknownParent',
            detail: `${t.token} 的 parent(至少 ${t.parentNum.numNeeded} 个)引用了不存在的 ${p}`,
            file: t.file, line: t.line,
          })
        }
      }
    }
    if (t.relTo && !merged.has(`${t.org}#${t.relTo}`) && !merged.has(t.relTo)) {
      issues.push({
        kind: 'unknownRelTo',
        detail: `${t.token} 的 relative_position_id = ${t.relTo} 不存在(基准丢失 → 该节点会画在错误格子)`,
        file: t.file, line: t.line,
      })
    }
  }

  return { orgs, traits: merged, order, orgVersions, overrides, policies: buildMioPolicies(roots), issues, ms: Date.now() - t0 }
}

/**
 * 布局:把网格坐标解成像素,并按 relative_position_id 累加。
 * 节点像素坐标 = 基准节点的像素 + 本节点的网格偏移(× 格子尺寸)。
 */
export interface MioLayout {
  /** token → {x,y}(像素,未含画布平移) */
  pos: Map<string, { x: number; y: number }>
  /** 画布尺寸 */
  w: number
  h: number
  /** 列号 → 表头 x(像素) */
  columns: { x: number; text: string }[]
  cell: number
}

/** 格子边长(像素)。游戏里一格大约这个尺度,取整便于对齐。 */
export const MIO_CELL = 96

export function layoutMioTree (t: MioTree, org: string): MioLayout {
  const pos = new Map<string, { x: number; y: number }>()
  const own = [...t.traits.values()].filter((x) => x.org === org)
  // ⚠ merged 的 Map 键有两类:本机构原生节点用 `org#token`、
  //   继承来的也用 `org#token`(第三遍统一)。这里一律按【值里的 token】建索引,
  //   两种来源都能查到(否则继承节点一律"找不到",只剩国家层 8 个节点)。
  const byToken = new Map<string, MioTrait>()
  for (const x of own) byToken.set(x.token, x)
  /**
   * 迭代求解 relative_position_id 链。
   * ⚠ 必须防三种坏输入,否则整张图变 NaN:
   *   ① 环(A 的基准是 B、B 的基准是 A)→ depth 上限 + 失败返回原点
   *   ② relTo 指向不存在的 token → 同上(诊断里会报 unknownRelTo)
   *   ③ gx/gy 本身是 NaN(@var 解析不到)→ 兜底 0
   */
  const solve = (tok: string, depth = 0): { x: number; y: number } | undefined => {
    const cached = pos.get(tok)
    if (cached) return cached
    const n = byToken.get(tok)
    if (!n || depth > 32) return undefined
    const base = (n.relTo ? solve(n.relTo, depth + 1) : { x: 0, y: 0 }) || { x: 0, y: 0 }
    if (!base) return undefined
    const gx = Number.isFinite(n.gx) ? n.gx : 0
    const gy = Number.isFinite(n.gy) ? n.gy : 0
    const p = { x: base.x + gx * MIO_CELL, y: base.y + gy * MIO_CELL }
    pos.set(tok, p)
    return p
  }
  // 先解无 relTo 的,再解其余(保证基准先算)
  for (const n of own) if (!n.relTo) solve(n.token)
  for (const n of own) if (n.relTo) solve(n.token)

  const o = t.orgs.get(org)
  // ⚠ Math.min(...空数组) = Infinity、Math.max(...空数组) = -Infinity,
  //   与 0 取 min/max 虽能兜住,但 xs/ys 里一旦有 NaN 会把整个结果污染成 NaN
  //   (实测 headers 的 x 可能是 0.5 这种小数,列标题换算时必须先规整)。
  const xs = [...pos.values()].map((p) => p.x).filter((v) => Number.isFinite(v))
  const ys = [...pos.values()].map((p) => p.y).filter((v) => Number.isFinite(v))
  const minX = xs.length ? Math.min(0, ...xs) : 0
  const minY = ys.length ? Math.min(0, ...ys) : 0
  // 归一化到 (0,0) 起
  for (const [k, p] of pos) pos.set(k, { x: p.x - minX, y: p.y - minY })
  const allX = [...pos.values()].map((p) => p.x)
  const allY = [...pos.values()].map((p) => p.y)
  const w = Math.max(MIO_CELL, (allX.length ? Math.max(...allX) : 0) + MIO_CELL)
  const h = Math.max(MIO_CELL, (allY.length ? Math.max(...allY) : 0) + MIO_CELL)
  // 列标题 x 是【网格列号】(可能是 0.5 / 4 / 7 这种),换算成像素后与节点列对齐。
  // 减去 minX/MIO_CELL 是因为坐标已按 minX 归一化(节点列号 = gx + relTo 累加)。
  const columns = (o?.headers ?? []).map((hd) => ({
    x: Math.round((hd.x - minX / MIO_CELL) * MIO_CELL),
    text: hd.text,
  }))
  return { pos, w, h, columns, cell: MIO_CELL }
}

/** 该 organization 可见的节点(含 include 继承) */
export function orgTraits (t: MioTree, org: string): MioTrait[] {
  return [...t.traits.values()].filter((x) => x.org === org)
}


/* ══════════════════════════════════════════════════════════════════
 * ★★★ POLICY_V2:MIO 政策解析(common/military_industrial_organization/policies/_documentation.md)
 * 玩家可为每个 MIO 附加 1 个政策(类似 1 个 trait)。
 * 与 trait 的 equipment_bonus 不同:政策需按【装备类型】嵌套
 *   equipment_bonus = { infantry_equipment = { reliability=0.2 ... } armor = {...} same_as_mio = {...} }
 * 字段:name/icon/cost/cooldown/allowed/visible/available/
 *      equipment_bonus/production_bonus/organization_modifier/on_add/on_remove/ai_will_do
 * ══════════════════════════════════════════════════════════════════ */
export interface MioPolicy {
  token: string
  name?: string        // loc_key(可选)
  icon?: string        // GFX_key(可选)
  cost?: number        // 默认 DEFAULT_INITIAL_POLICY_ATTACH_COST
  cooldown?: number    // 默认 DEFAULT_INITIAL_ATTACH_POLICY_COOLDOWN
  gates?: { allowed?: string; visible?: string; available?: string }
  /** 装备加成(按装备 group/category/archetype/type 嵌套 → stat → 值;same_as_mio 等关键字保留) */
  equipmentBonus?: Record<string, Record<string, number>>
  /** 生产加成(同嵌套结构) */
  productionBonus?: Record<string, Record<string, number>>
  /** 组织加成(仅 7 个 MIO 专属 modifier) */
  organizationModifier?: Record<string, number>
  onAdd?: string
  onRemove?: string
  aiWillDo?: string
  file: string
  line: number
  root: number
  hasDlc: string[]
}

/** 嵌套 bonus(装备类型 → stat → 值) */
function nestedPolicyBonus (doc: Document, b: Block, key: string): Record<string, Record<string, number>> | undefined {
  const blk = childBlock(doc, b, key)
  if (!blk) return undefined
  const r: Record<string, Record<string, number>> = {}
  for (const t of blk.entries) {
    const k = keyText(doc, t)
    if (!k || !t.block) continue
    const inner: Record<string, number> = {}
    for (const lt of t.block.entries) {
      const lk = keyText(doc, lt)
      if (lk) { const v = Number(valueText(doc, lt)); if (Number.isFinite(v)) inner[lk] = v }
    }
    r[k] = inner
  }
  return r
}

/** 特效/条件块 → 简文本 */
function blockShortText (doc: Document, b: Block, max = 60): string {
  const parts: string[] = []
  for (const x of (b.entries || [])) {
    const k = keyText(doc, x)
    if (!k) continue
    parts.push(x.block ? k + ' {…}' : (x.value != null ? k + ' = ' + x.value : k))
  }
  return parts.join(' ').slice(0, max)
}

/** 读全部已启用来源的 policies/*.txt,解析每个 policy 的完整字段 */
export function buildMioPolicies (roots: DlcRoot[]): MioPolicy[] {
  const out: MioPolicy[] = []
  /* ★ 文件级替换(游戏规则):同相对路径 + 同文件名的文件,载入序靠后的来源整份替换靠前的。
   *   基础游戏与模组同名文件若同时读取会合并,导致政策重复;
   *   现改为只读取最终生效那份(模组同名文件整份覆盖基础游戏)。 */
  const fileSeen = new Map<string, { ri: number; abs: string; rel: string }>()
  for (let ri = 0; ri < roots.length; ri++) {
    const root = roots[ri]
    const dir = joinPath(root.path, 'common', 'military_industrial_organization', 'policies')
    let files: string[]
    try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt')) } catch { continue }
    for (const f of files) {
      const rel = 'common/military_industrial_organization/policies/' + f
      fileSeen.set(rel.toLowerCase(), { ri, abs: joinPath(dir, f), rel })
    }
  }
  for (const { ri, abs, rel } of fileSeen.values()) {
    let doc: Document
    try { doc = parse(readFileSync(abs, 'utf8')) } catch { continue }
    for (const e of doc.root.entries) {
      const tk = keyText(doc, e)
      if (!tk || !e.block || tk.startsWith('@')) continue
      const b = e.block
      const pol: MioPolicy = {
        token: tk, file: rel, line: lineOf(doc, e), root: ri, hasDlc: [],
      }
      const hd = new Set<string>()
      collectHasDlc(doc, b, hd)
      pol.hasDlc = [...hd]
      const nm = childValue(doc, b, 'name'); if (nm) pol.name = unq(nm)
      const ic = childValue(doc, b, 'icon'); if (ic) pol.icon = unq(ic)
      const cs = childValue(doc, b, 'cost'); if (cs && /^-?\d/.test(cs)) pol.cost = Number(cs)
      const cd = childValue(doc, b, 'cooldown'); if (cd && /^-?\d/.test(cd)) pol.cooldown = Number(cd)
      const eb = nestedPolicyBonus(doc, b, 'equipment_bonus'); if (eb) pol.equipmentBonus = eb
      const pb = nestedPolicyBonus(doc, b, 'production_bonus'); if (pb) pol.productionBonus = pb
      const omb = childBlock(doc, b, 'organization_modifier'); if (omb) pol.organizationModifier = leafNums(doc, omb)
      const g = summGates(doc, b); if (g) pol.gates = g
      const oa = childBlock(doc, b, 'on_add'); if (oa) pol.onAdd = blockShortText(doc, oa)
      const or = childBlock(doc, b, 'on_remove'); if (or) pol.onRemove = blockShortText(doc, or)
      const ai = childBlock(doc, b, 'ai_will_do'); if (ai) pol.aiWillDo = blockShortText(doc, ai)
      out.push(pol)
    }
  }
  /* 不同文件偶发同 token 时兜底去重(保留最后加载=模组/最新生效版本) */
  const seen = new Map<string, MioPolicy>()
  for (const p of out) seen.set(p.token, p)
  return [...seen.values()]
}
