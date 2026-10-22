/**
 * DLC 内容模型 —— 「一个 DLC 往 common/ 里加了哪套新玩法」的提取与分析。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 设计要点:声明式注册表,不是硬编码三个 DLC
 * ══════════════════════════════════════════════════════════════════
 * HOI4 每隔一段时间就加新 DLC,每个 DLC 往 common/ 里塞一套新玩法目录:
 *   dlc038 Arms Against Tyranny   → common/military_industrial_organization/  军工机构
 *   dlc043 Götterdämmerung        → common/special_projects/                   特殊工程
 *   dlc049 No Compromise No Surr. → common/factions/                           阵营系统
 * 如果把这些目录写死在代码里,每出一个新 DLC 就得改一遍。所以这里拆成两层:
 *
 *   ① DLC_FEATURE_REGISTRY(本文件末尾的常量表)
 *      一条记录 = 「DLC 叫什么 + 它的玩法数据在哪个 common 子目录 + 怎么提取」。
 *      新 DLC 来了【只加一条记录】,不改任何逻辑代码。
 *
 *   ② 通用提取器 extractFeature()
 *      按注册表描述遍历目录 → 解析 → 收集条目,不认识的字段一律塞进 raw。
 *
 * 另有一层【自动发现】discoverDirGating() 与 readInstalledDlc():
 *   读 <game>/dlc 下的各 *.dlc 描述文件取出全部 DLC 名,
 *   再扫 common/ 各子目录里出现的 `has_dlc = "..."`,统计「哪个 DLC 门控了哪个目录」。这份清单能直接
 *   告诉你:注册表里还缺哪些 DLC / 有没有被漏掉的目录。
 *   ⚠ 这是"为新 DLC 提示该注册什么"的关键 —— 不要靠翻文档猜。
 *
 * ── DLC 归属的三种判据(优先级从高到低)──
 *   1. 条目自身的 has_dlc —— 最精确,如 special_projects 每个 project 都写
 *      `allowed = { has_dlc = "Gotterdammerung" }`。
 *   2. 目录整体归属 —— MIO 的 organizations/*.txt 靠 `NOR_AAT = yes` 这类
 *      专用宏表达,不写 has_dlc,只能靠目录归属。
 *   3. 注册表声明 —— 前两条都没有时(纯 vanilla 目录被 DLC 改写),用注册表。
 *
 * ── 已实测的规模(vanilla 1.17,供对账)──
 *   military_industrial_organization: organizations 56 文件 / policies 5 / ai_bonus_weights 1
 *   special_projects: projects 6 类 / specialization 1 / project_tags 1 / prototype_rewards 5
 *   factions: goals 4(共 14918 行!) / upgrades 1(空) / member_upgrades 2 / templates 10 / rules 11
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { replacePathCovers, type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

export interface DlcRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/** ★ 文件被更高优先级来源的 replace_path 卸载(游戏规则):低优先级来源该目录下文件整体失效 */
function isDlcFileUnloaded(roots: readonly DlcRoot[], ri: number, rel: string): boolean {
  for (let j = ri + 1; j < roots.length; j++) {
    const rp = roots[j].replacePaths
    if (rp && rp.length && replacePathCovers(rp, rel)) return true
  }
  return false
}

/* ══════════════════════════════════════════════════════════════════
 * 一、通用工具
 * ══════════════════════════════════════════════════════════════════ */

function walk(dir: string, exts = ['.txt']): string[] {
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
    if (st.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk && e.block) return e.block
  return undefined
}
function childValue(doc: Document, b: Block, key: string): string | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk) return valueText(doc, e)
  return undefined
}
function childBlocks(doc: Document, b: Block, key: string): Block[] {
  const out: Block[] = []
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk && e.block) out.push(e.block)
  return out
}
/** 块内的裸值列表(project_tags / tracks / rewards 这类) */
function bareValues(doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) if (e.key < 0 && e.value >= 0) out.push(valueText(doc, e) ?? '')
  return out.filter(Boolean)
}
/** 递归收集块里所有 `has_dlc = "X"` 的 X —— DLC 门控判据 */
function collectHasDlc(doc: Document, b: Block, into: Set<string>): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (k && k.toLowerCase() === 'has_dlc' && e.value >= 0) {
      const v = (valueText(doc, e) ?? '').replace(/^"|"$/g, '').trim()
      if (v) into.add(v)
    }
    if (e.block) collectHasDlc(doc, e.block, into)
  }
}
/** 收集块里所有 `NOR_XXX` / `XXX_AAT` 之类的 DLC 专用宏键名 */
function collectDlcMacros(doc: Document, b: Block, into: Set<string>): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    // 形如 NOR_AAT = yes / AAT = yes —— 键名含 DLC 缩写
    if (k && e.value >= 0 && /_AAT$|^AAT$|_GD$|_NCNS$/.test(k)) into.add(k)
    if (e.block) collectDlcMacros(doc, e.block, into)
  }
}
/** 块内所有「叶子赋值」键值对(深度不限),用于把不认识的内容塞进 raw */
function flatScalars(doc: Document, b: Block, depth = 0, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (depth > 3) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const kk = prefix ? `${prefix}.${k}` : k
    if (e.block) {
      // 只收"看起来是数据"的块(非 if/limit/effect 这类脚本),避免把脚本塞进 raw
      const lk = k.toLowerCase()
      if (/^(if|limit|effect|trigger|visible|available|allowed|ai_will_do|options)$/.test(lk)) continue
      Object.assign(out, flatScalars(doc, e.block, depth + 1, kk))
    } else if (e.value >= 0) {
      const v = valueText(doc, e)
      if (v !== undefined) out[kk] = v
    }
  }
  return out
}
/**
 * 判「这个条目有没有真正的可用性条件」。
 * ⚠ 不能只看 available/visible/allowed 块在不在 —— vanilla 里
 *   `available = { always = yes }` 满地都是(special_projects 的 49 个 project
 *   几乎每个都有),按"块存在"判会让几乎所有条目都标上"有条件",等于没标。
 * 这里改成:块里除了 always = yes / never = no 之外还有别的键,才算有条件。
 */
function hasRealGate(doc: Document, b: Block, keys: string[]): boolean {
  for (const key of keys) {
    const bb = childBlock(doc, b, key)
    if (!bb) continue
    for (const e of bb.entries) {
      const k = (keyText(doc, e) ?? '').toLowerCase()
      if (!k) continue
      if (k === 'always' || k === 'never') continue
      return true
    }
  }
  return false
}
function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : undefined
}

/* ══════════════════════════════════════════════════════════════════
 * 二、数据类型
 * ══════════════════════════════════════════════════════════════════ */

/** 注册表里的一条记录 = 一个 DLC 的一项玩法 */
export interface DlcFeatureSpec {
  /** 机器 id(URL/前端筛选用),如 'mio' */
  id: string
  /** 中文名 */
  label: string
  /** 归属 DLC 的英文名(与 .dlc 文件里的 name = 一致) */
  dlc: string
  /** common/ 下的相对目录 */
  dir: string
  /** 只取这些子目录(留空 = 整个 dir);用于一个玩法横跨多子目录时精确控制 */
  subdirs?: string[]
  /**
   * 条目键怎么取:
   *  'root'   —— 根级块即条目(多数情况)
   *  'wrapped:<包裹键>' —— 根级是包裹键,取其子块
   */
  entry: 'root' | `wrapped:${string}`
  /**
   * 分组维度。可多级,合成 `a/b` 形式的分组值:
   *   '_subdir' —— 按注册表 subdirs 的那一层(如 factions 的 goals / templates / rules)
   *   '_file'   —— 按文件名去后缀(如 GER_organization.txt → GER)
   *   其它      —— 条块里的字段名(如 special_projects 的 specialization)
   * ⚠ 必须包含 '_subdir':否则同一目录下混着多种形态的条目
   *   (实测 factions 的 goals 有 category、templates/rules 完全没有,
   *   不按子目录分开就会出现一个 194 条的"(无)"巨组)。
   */
  groupBy: string[]
  /** 分组值的中文映射(按完整分组值或末段匹配) */
  groupCn?: Record<string, string>
  /** 图标字段名(可多个,取第一个非空的) */
  iconKeys?: string[]
  /** 名称/描述的本地化键字段 */
  nameKeys?: string[]
  /** 数值字段(如 xp_cost) */
  numKeys?: string[]
  /**
   * 枚举/字符串字段(如 complexity = sp_complexity.medium、
   * prototype_time = sp_time.prototype.long)—— 是带前缀的 token 不是数字,
   * 放进 numKeys 会被 parseFloat 吃掉变成空,必须单列。
   */
  strKeys?: string[]
  /**
   * 块型数值字段(如 breakthrough_cost = { specialization_air = 1 })——
   * 值在块里,取块内所有叶子数字之和。
   */
  blockNumKeys?: string[]
  /** 要抽的列表字段(如 project_tags / tracks / rewards),值存到 `tags` */
  listKeys?: string[]
  /** 覆盖链:id → 全部定义位置 */
  defs: Map<string, { root: number; file: string; line: number }[]>
}

/** 提取出来的一条内容 */
export interface DlcItem {
  id: string
  /** 所属玩法(注册表 id) */
  feature: string
  /** 所属玩法中文名 */
  featureLabel: string
  /** 归属 DLC 英文名 */
  dlc: string
  /** 分组值(未分组则空串) */
  group: string
  /** 本地化名称键 */
  loc?: string
  descLoc?: string
  icon?: string
  /** 数值字段(键=注册表 numKeys / blockNumKeys) */
  nums: Record<string, number>
  /** 枚举字符串字段(键=注册表 strKeys) */
  strs: Record<string, string>
  /** 列表字段(键=注册表 listKeys) */
  tags: Record<string, string[]>
  /** 该条目来自哪个 common 子目录(取自 subdirs 那一层) */
  subdir: string
  /** 该条目自身声明的 has_dlc(判据 1) */
  hasDlc: string[]
  /** 该条目用到的 DLC 专用宏(判据 2 的辅助) */
  macros: string[]
  /** 有 available / visible / allowed 条件 */
  gated: boolean
  /** 没被注册表识别的叶子字段 */
  raw: Record<string, string>
  file: string
  line: number
  root: number
  /** 最终生效的那份来自哪个来源 */
  effectiveRoot: number
}

export interface DlcGroup {
  /** 分组值 */
  id: string
  /** 中文名(注册表 groupCn 命中则中文) */
  label: string
  items: DlcItem[]
}

export interface DlcFeature {
  id: string
  label: string
  dlc: string
  dir: string
  /** 该玩法是否在挂载的来源里实际存在(模组可覆盖/新增) */
  present: boolean
  groups: Map<string, DlcGroup>
  items: Map<string, DlcItem>
  /** 分组声明顺序 */
  groupOrder: string[]
  /** 覆盖链 */
  defs: Map<string, { root: number; file: string; line: number }[]>
  stats: {
    items: number
    groups: number
    files: number
    /** 自身带 has_dlc 的条目数 —— 归属判据 1 的覆盖率 */
    withHasDlc: number
    /** 被多个来源重复定义(模组覆盖原版)的 id */
    overridden: number
    /** 模组新增(原版没有)的 id */
    modNew: number
  }
}

export interface DlcModel {
  roots: DlcRoot[]
  features: Map<string, DlcFeature>
  featureOrder: string[]
  /** 扫 dlc/*.dlc 得到的全部 DLC(名字 + 目录) */
  installedDlc: { name: string; dir: string; category?: string }[]
  /** 自动发现:某 DLC 门控了哪些 common 子目录(has_dlc 统计) */
  dirGating: { dir: string; dlcs: string[]; hits: number }[]
  /** 注册表里声明了、但 common 目录不存在的(可能是 DLC 未购买) */
  missing: string[]
}

/* ══════════════════════════════════════════════════════════════════
 * 三、注册表 —— ★ 新增 DLC 只需在这里加一条记录
 * ══════════════════════════════════════════════════════════════════ */
export const DLC_FEATURE_REGISTRY: Omit<DlcFeatureSpec, 'defs'>[] = [
  {
    id: 'mio',
    label: '军工机构',
    dlc: 'Arms Against Tyranny',
    dir: 'military_industrial_organization',
    subdirs: ['organizations', 'policies', 'ai_bonus_weights'],
    entry: 'root',
    // 第一级用 _subdir 天然分开 organizations(按国家)与 policies(全局);
    // 第二级 _file 只对 organizations 有意义。⚠ 'sub' 段本身不进分组值 ——
    // 否则 58 个国家全叫 "organizations / XXX",前缀纯属噪声。
    groupBy: ['_file'],
    groupCn: { policies: '全局政策', ai_bonus_weights: 'AI 权重' },
    iconKeys: ['icon'],
    nameKeys: ['name'],
    numKeys: ['initial_research_time', 'available_icon_slot'],
    blockNumKeys: ['equipment_bonus'],
    listKeys: ['equipment_types', 'allowed'],
  },
  {
    id: 'special_projects',
    label: '特殊工程',
    dlc: 'Gotterdammerung',
    dir: 'special_projects',
    subdirs: ['projects'],
    entry: 'root',
    groupBy: ['specialization'],
    groupCn: {
      specialization_air: '空军',
      specialization_land: '陆军',
      specialization_naval: '海军',
      specialization_nuclear: '核',
    },
    iconKeys: ['icon'],
    nameKeys: ['name'],
    // ⚠ complexity / prototype_time 是 sp_complexity.medium 这类枚举 token,
    //   不是数字 —— 放 numKeys 会被 parseFloat 吃掉。必须走 strKeys。
    strKeys: ['complexity', 'prototype_time'],
    blockNumKeys: ['breakthrough_cost', 'resource_cost'],
    listKeys: ['project_tags', 'generic_prototype_rewards'],
  },
  {
    id: 'factions',
    label: '阵营系统',
    dlc: 'No Compromise, No Surrender',
    dir: 'factions',
    // ⚠ 第一级必须 _subdir:goals 有 category 字段(短期/中期/长期),
    //   而 templates / rules / member_upgrades 完全没有 —— 混在一起会出 194 条空组。
    subdirs: ['goals', 'templates', 'rules', 'member_upgrades'],
    entry: 'root',
    groupBy: ['_subdir', 'category'],
    groupCn: {
      goals: '阵营目标',
      templates: '阵营模板',
      rules: '阵营规则',
      member_upgrades: '成员升级',
      short_term: '短期',
      medium_term: '中期',
      long_term: '长期',
    },
    iconKeys: ['icon'],
    /* 参考 factions/_documentation.md:
     *   goals: name/description/category + visible/available/completed/group...
     *   rules: type/modifier/ai_will_do...; rule_groups: default_rule/rules
     *   templates: name/manifest/goals/default_rules; member_upgrades: name/desc/icon/upgrade_cost/bonus */
    nameKeys: ['name', 'description', 'desc'],   // name→loc, description/desc→descLoc(本地化)
    strKeys: ['type', 'manifest'],               // rules 的 type(token), templates 的 manifest
    numKeys: ['bonus', 'days', 'upgrade_cost'],
    listKeys: ['rules', 'goals', 'default_rules'],
  },
  {
    id: 'doctrines',
    label: '学说',
    dlc: '(多 DLC)',
    dir: 'doctrines',
    // 学说本体在 doctrines.ts 里建模;这里只登记归属,让 DLC 页能列出它。
    // 4 个 folder 全部来自同一个文件,按 _file 分组正好是"学说页签"这一组。
    subdirs: ['folders'],
    entry: 'root',
    groupBy: ['_file'],
    groupCn: { doctrine: '学说页签' },
    iconKeys: ['ledger_gfx', 'tab_gfx'],
    nameKeys: ['name'],
    numKeys: ['color_frame'],
    listKeys: [],
  },
]

/** 拿到完整 spec(含 defs 容器) */
function specOf(id: string): DlcFeatureSpec | undefined {
  const base = DLC_FEATURE_REGISTRY.find((s) => s.id === id)
  return base ? { ...base, defs: new Map() } : undefined
}

/* ══════════════════════════════════════════════════════════════════
 * 四、通用提取器
 * ══════════════════════════════════════════════════════════════════ */

function extractFeature(roots: DlcRoot[], spec: DlcFeatureSpec): DlcFeature {
  const feat: DlcFeature = {
    id: spec.id,
    label: spec.label,
    dlc: spec.dlc,
    dir: spec.dir,
    present: false,
    groups: new Map(),
    items: new Map(),
    groupOrder: [],
    defs: new Map(),
    stats: { items: 0, groups: 0, files: 0, withHasDlc: 0, overridden: 0, modNew: 0 },
  }

  const knownNum = new Set(spec.numKeys ?? [])
  const knownStr = new Set(spec.strKeys ?? [])
  const knownBlockNum = new Set(spec.blockNumKeys ?? [])
  const knownList = new Set(spec.listKeys ?? [])
  const knownIcon = new Set(spec.iconKeys ?? [])
  const knownName = new Set(spec.nameKeys ?? [])
  const knownAll = new Set([...knownNum, ...knownStr, ...knownBlockNum, ...knownList, ...knownIcon, ...knownName])
  const groupBy = spec.groupBy ?? []

  /* ★ 文件级替换 + replace_path(游戏规则):
   *   ① 同相对路径 + 同文件名,载入序靠后的来源整份覆盖靠前的(基础被模组同名文件替换)。
   *   ② 更高优先级来源 replace_path 了该目录时,低优先级来源文件整份卸载(不加载)。
   *   只读取最终生效那份,避免条目重复。 */
  const effFiles = new Map<string, { ri: number; rel: string }>()
  roots.forEach((r, ri) => {
    for (const sub of spec.subdirs ?? ['']) {
      const abs = join(r.path, 'common', spec.dir, sub)
      if (!existsSync(abs)) continue
      const files = statSync(abs).isDirectory() ? walk(abs) : [abs]
      for (const f of files) {
        const rel = relative(r.path, f).replace(/\\/g, '/')
        if (isDlcFileUnloaded(roots, ri, rel)) continue
        effFiles.set(rel.toLowerCase(), { ri, rel })
      }
    }
  })

  roots.forEach((r, ri) => {
    for (const sub of spec.subdirs ?? ['']) {
      const abs = join(r.path, 'common', spec.dir, sub)
      if (!existsSync(abs)) continue
      const files = statSync(abs).isDirectory() ? walk(abs) : [abs]
      for (const f of files) {
        const rel = relative(r.path, f).replace(/\\/g, '/')
        const eff = effFiles.get(rel.toLowerCase())
        if (!eff || eff.ri !== ri) continue  // 被更高优先级同名文件覆盖 / replace_path 卸载 → 跳过
        const file = rel
        feat.present = true
        feat.stats.files++
        let doc: Document
        try {
          doc = parse(readFileSync(f, 'utf8'))
        } catch {
          continue
        }

        // 定位条目所在层级
        let container: Block = doc.root
        if (spec.entry.startsWith('wrapped:')) {
          const wb = childBlock(doc, doc.root, spec.entry.slice(8))
          if (!wb) continue
          container = wb
        }

        for (const e of container.entries) {
          const k = keyText(doc, e)
          if (!k || !e.block || k.startsWith('@')) continue
          const b = e.block

          const hasDlc = new Set<string>()
          collectHasDlc(doc, b, hasDlc)
          const macros = new Set<string>()
          collectDlcMacros(doc, b, macros)

          // 分组:多级合成 'subdir/field'。空段直接跳过(不产生 'a//b')
          const segs: string[] = []
          for (const key of groupBy) {
            if (key === '_subdir') {
              if (sub) segs.push(sub)
            } else if (key === '_file') {
              const base = file.split('/').pop() ?? ''
              // 剥掉 _organization / _policies(军工机构约定)与 _folders(学说约定)
              const tag = base
                .replace(/\.txt$/i, '')
                .replace(/[_-]?(organization|organisations|policies|policy|folders)$/i, '')
              if (tag) segs.push(tag)
            } else {
              const v = childValue(doc, b, key)
              if (v) segs.push(v)
            }
          }
          const group = segs.join('/')

          // 字段抽取
          const nums: Record<string, number> = {}
          const strs: Record<string, string> = {}
          const tags: Record<string, string[]> = {}
          const raw: Record<string, string> = {}
          let icon: string | undefined
          let loc: string | undefined
          let descLoc: string | undefined
          for (const c of b.entries) {
            const ck = keyText(doc, c)
            if (!ck) continue
            const lck = ck.toLowerCase()
            if (knownIcon.has(lck)) {
              const v = valueText(doc, c)
              if (v && !icon) icon = v.replace(/^"|"$/g, '')
              continue
            }
            if (knownName.has(lck)) {
              const v = valueText(doc, c)
              if (v) {
                if (lck === 'name' && !loc) loc = v
                else if ((lck === 'description' || lck === 'desc') && !descLoc) descLoc = v
              }
              continue
            }
            if (knownNum.has(lck)) {
              const v = num(valueText(doc, c))
              if (v !== undefined) nums[ck] = v
              continue
            }
            if (knownStr.has(lck)) {
              // 枚举 token 原样保留(sp_complexity.medium 不能当数字)
              const v = valueText(doc, c)
              if (v) strs[ck] = v
              continue
            }
            if (knownBlockNum.has(lck)) {
              // 块里的叶子数字求和(breakthrough_cost = { spec = 1 })
              if (c.block) {
                let sum = 0
                let found = false
                const walkNum = (bb: Block): void => {
                  for (const x of bb.entries) {
                    if (x.block) {
                      walkNum(x.block)
                      continue
                    }
                    const v = num(valueText(doc, x))
                    if (v !== undefined) {
                      sum += v
                      found = true
                    }
                  }
                }
                walkNum(c.block)
                if (found) nums[ck] = sum
              }
              continue
            }
            if (knownList.has(lck)) {
              if (c.block) tags[ck] = bareValues(doc, c.block)
              continue
            }
          }
          // 未识别的叶子字段 → raw(供前端"其它字段"展示,便于模组作者对照)
          for (const [kk, vv] of Object.entries(flatScalars(doc, b))) {
            const leaf = kk.split('.').pop() ?? kk
            if (knownAll.has(leaf.toLowerCase())) continue
            raw[kk] = vv
          }

          const gated = hasRealGate(doc, b, ['available', 'visible', 'allowed'])

          const item: DlcItem = {
            id: k,
            feature: spec.id,
            featureLabel: spec.label,
            dlc: spec.dlc,
            group,
            loc,
            descLoc,
            icon,
            nums,
            strs,
            tags,
            subdir: sub,
            hasDlc: [...hasDlc],
            macros: [...macros],
            gated,
            raw,
            file,
            line: lineOf(doc, e),
            root: ri,
            effectiveRoot: ri,
          }
          if (hasDlc.size) feat.stats.withHasDlc++

          // 先加载的胜出(与 Clausewitz 覆盖语义一致),但覆盖链全记
          if (!feat.items.has(k)) {
            feat.items.set(k, item)
            let g = feat.groups.get(group)
            if (!g) {
              // 多级分组逐段翻译;查不到的原样显示,合成 '陆军 / 步兵'
              const label =
                group
                  .split('/')
                  .map((s) => spec.groupCn?.[s] ?? s)
                  .join(' / ') || '(未分组)'
              g = { id: group, label, items: [] }
              feat.groups.set(group, g)
              feat.groupOrder.push(group)
            }
            g.items.push(item)
          } else {
            item.effectiveRoot = feat.items.get(k)!.root
          }
          const dl = feat.defs.get(k) ?? []
          dl.push({ root: ri, file, line: lineOf(doc, e) })
          feat.defs.set(k, dl)
        }
      }
    }
  })

  feat.stats.items = feat.items.size
  feat.stats.groups = feat.groups.size
  for (const [id, dl] of feat.defs) {
    if (dl.length < 2) continue
    const first = dl[0].root
    const last = dl[dl.length - 1].root
    const eff = feat.items.get(id)?.root ?? first
    if (eff !== first) feat.stats.overridden++
    else if (first !== 0 && eff === first) feat.stats.modNew++
  }
  return feat
}

/* ══════════════════════════════════════════════════════════════════
 * 五、DLC 清单 + 目录门控自动发现
 * ══════════════════════════════════════════════════════════════════ */

/** 扫 <game>/dlc 下各子目录里的 *.dlc 描述文件,读出全部 DLC 名 —— 新 DLC 自动出现在清单里 */
export function readInstalledDlc(gameDir: string): DlcModel['installedDlc'] {
  const out: DlcModel['installedDlc'] = []
  const dlcDir = join(gameDir, 'dlc')
  let dirs: string[] = []
  try {
    dirs = readdirSync(dlcDir)
  } catch {
    return out
  }
  for (const d of dirs) {
    const sub = join(dlcDir, d)
    let files: string[] = []
    try {
      files = readdirSync(sub)
    } catch {
      continue
    }
    const meta = files.find((f) => /^[a-z0-9_-]+\.dlc$/i.test(f))
    if (!meta) continue
    let txt: string
    try {
      txt = readFileSync(join(sub, meta), 'utf8')
    } catch {
      continue
    }
    const name = txt.match(/^\s*name\s*=\s*"([^"]*)"/m)?.[1]
    const category = txt.match(/^\s*category\s*=\s*"([^"]*)"/m)?.[1]
    if (name) out.push({ name, dir: d, category })
  }
  return out
}

/**
 * 扫 common/ 各子目录,统计每个目录里 `has_dlc = "X"` 引用了哪些 DLC。
 *
 * ★ 这就是"为新 DLC 扩展"的提示器:新 DLC 一上线,它的 has_dlc 会出现在
 *   某些 common 子目录里;这份清单能直接告诉开发者"该目录需要注册一个玩法"。
 *   只扫一层子目录(recursive),文件数控制住,避免把 9945 个文件全读一遍。
 */
export function discoverDirGating(
  roots: DlcRoot[],
  knownDirs: string[],
): DlcModel['dirGating'] {
  const out: DlcModel['dirGating'] = []
  const readOnly = roots.find((r) => /Hearts of Iron IV/i.test(r.path)) ?? roots[0]
  if (!readOnly) return out
  for (const dir of knownDirs) {
    const abs = join(readOnly.path, 'common', dir)
    if (!existsSync(abs)) continue
    const counts = new Map<string, number>()
    for (const f of walk(abs)) {
      let txt: string
      try {
        txt = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      // 纯文本正则即可 —— 这里只要统计出现次数,不需要 AST
      for (const m of txt.matchAll(/has_dlc\s*=\s*"([^"]+)"/g)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
      }
    }
    if (!counts.size) continue
    out.push({
      dir,
      dlcs: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      hits: [...counts.values()].reduce((a, b) => a + b, 0),
    })
  }
  return out.sort((a, b) => b.hits - a.hits)
}

/* ══════════════════════════════════════════════════════════════════
 * 六、对外入口
 * ══════════════════════════════════════════════════════════════════ */

export function buildDlcModel(roots: DlcRoot[], gameDir: string): DlcModel {
  const model: DlcModel = {
    roots,
    features: new Map(),
    featureOrder: [],
    installedDlc: readInstalledDlc(gameDir),
    dirGating: [],
    missing: [],
  }
  const dirSet = new Set<string>()
  for (const spec of DLC_FEATURE_REGISTRY) {
    const full = specOf(spec.id)
    if (!full) continue
    const feat = extractFeature(roots, full)
    model.features.set(feat.id, feat)
    model.featureOrder.push(feat.id)
    dirSet.add(spec.dir)
    if (!feat.present) model.missing.push(spec.label)
  }
  // 门控统计只覆盖注册表已知的目录 —— 未注册的目录由 common-discover 负责
  model.dirGating = discoverDirGating(roots, [...dirSet])
  return model
}

/** 把一条 DlcItem 转成前端 JSON(数值/枚举/列表拍平,raw 只留前 N 条) */
export function dlcItemJson(it: DlcItem, rawLimit = 24) {
  return {
    id: it.id,
    group: it.group,
    subdir: it.subdir,
    loc: it.loc || it.id || '',
    descLoc: it.descLoc ?? '',
    icon: it.icon ?? '',
    nums: it.nums,
    strs: it.strs,
    tags: it.tags,
    hasDlc: it.hasDlc,
    macros: it.macros,
    gated: it.gated,
    raw: Object.fromEntries(Object.entries(it.raw).slice(0, rawLimit)),
    rawTotal: Object.keys(it.raw).length,
    file: it.file,
    line: it.line,
    root: it.root,
    effectiveRoot: it.effectiveRoot,
  }
}

