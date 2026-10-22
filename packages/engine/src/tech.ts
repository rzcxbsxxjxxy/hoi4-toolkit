/**
 * 科技树模型(common/technologies + common/technology_tags)。
 *
 * 文件结构:
 *   technologies = {
 *     @1918 = 0 ...                  ← 文件级 @变量(fix 里 y = @1936 要解析)
 *     infantry_weapons = {           ← 科技块,键即 id
 *       research_cost = 1.5
 *       start_year = 1918
 *       folder = { name = ... position = { x = 0 y = @1936 } }  ← 坐标在这
 *       categories = { infantry_weapons }                         ← 领域
 *       path = { leads_to_tech = infantry_weapons1 }             ← 解锁下一级
 *       enable_technologies = { ... }                            ← 同级解锁
 *       enable_equipments = { ... }
 *     }
 *   }
 *
 * 与 focus 不同,科技没有"相对坐标",x/y 就是绝对网格坐标;边来自
 * leads_to_tech / enable_technologies。
 *
 * ── 分类体系(2026-10 新增,从 vanilla 00_technology.txt 全量统计得出)──
 *
 * ⚠ 科技树在游戏里是**两级**结构,之前只实现了「一层 categories」,导致
 *   画出来是一张没有分区的散点图。真实结构:
 *
 *   common/technology_tags/00_technology.txt 里有两个块:
 *     technology_categories = { ... }   134 个裸 id —— 只是【顺序表】,决定图上左右次序
 *     technology_folders    = { ... }   16 个块 —— 真正的【显示分组】
 *        xxx_folder = {
 *          ledger = army | air | navy | civilian | hidden
 *          doctrine = yes
 *          available = { ... }     ← DLC 门控
 *        }
 *
 *   科技通过 `folder = { name = <folder_id> }` 挂到文件夹上,
 *   通过 `categories = { <category_id> ... }` 声明领域(可多个,实测 434 个科技是多分类)。
 *
 *   三个关键事实(全部实测,勿凭印象改):
 *   1) 隐藏科技有两层含义,都要处理:
 *      a) **无 categories 的科技**:实测 552 个里 73 个没有 categories 块
 *         (suicide_craft / jungle_heavy_tanks / mountain_gun / *_training_tech …)。
 *         它们在游戏的科技树上是"没有标题栏的散项",必须单独归组显示,
 *         混在主分类里会让人以为漏了内容。
 *      b) **ledger = hidden 的文件夹**:16 个 folder 里 1 个
 *         (special_forces_doctrine_folder,注释写 "For now")。
 *         游戏里默认不显示该页签,要在 UI 上标出来。
 *   2) 28 个 category 在表里但没被任何科技引用(land_doctrine / air_doctrine /
 *      naval_doctrine / *_tree 系列)—— 这些是 doctrine 的"树容器"标记,
 *      由 script 动态填充科技。UI 上应显示为空分类而不是隐藏。
 *   3) 一个 category 会横跨多个 folder(实测 49 个,如 air_equipment 同时属于
 *      air_techs_folder 与 bba_air_techs_folder)—— 那是 DLC 互斥版本,
 *      所以【文件夹是显示维度,category 是排序维度】,两者要分别呈现。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'
import { parseTriggerBlocks } from '../../focus/src/trigger-parse.ts'
import { collectConditions, type TrigNode } from '../../focus/src/trigger.ts'

export interface TechRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/** technology_folders 里的一个显示分组 */
export interface TechFolder {
  id: string
  /** ledger = army / air / navy / civilian / hidden */
  ledger?: string
  /** doctrine = yes(Doctrine 页签) */
  doctrine?: boolean
  /** 带 available 条件(DLC 门控)—— UI 上标注 */
  dlcGated?: boolean
  root: number
  file: string
  line: number
}

export interface TechNode {
  id: string
  x: number
  y: number
  cost: number
  year: number
  /** 第一个 category(兼容旧字段;完整列表在 categories) */
  area: string
  /** categories = { ... } 里的全部 id(实测 434 个科技是多分类) */
  categories: string[]
  /** folder = { name = ... } —— 显示分组 id(主 folder,取首个块) */
  folder?: string
  /**
   * ★ 多 folder 科技:该科技在【每个】folder 里的独立坐标。
   *   对齐 HOI4 MU `tech.folders[当前folder].x/.y`。实测原版 12 个科技多 folder
   *   (radio → electronics_folder + support_folder;motorised_infantry → infantry_folder +
   *   support_folder;sp_centrifugal_jet_tech → bba_air_techs_folder + air_techs_folder …)。
   *   每个 folder 块独立 name + position;主 folder/x/y 取首个块。
   */
  folders: Record<string, { x: number; y: number }>
  /**
   * ⚠ 无 categories 的科技(实测 73 个)。游戏里它们没有标题栏,
   *   单独归组显示,见文件头说明 1a。
   */
  hidden?: boolean
  /** 通过 path.leads_to_tech 解锁的科技 */
  leads: string[]
  /** 通过 enable_technologies 解锁的科技 */
  enables: string[]
  /** 本科技依赖的(id 在前面、或 enable 指向本科技)—— 由图构建时反推 */
  requires: string[]
  file: string
  line: number
  root: number
  /** 科技图标 GFX 名(tech 块上的 icon 字段,如 GFX_tech_land_doctrine)。可能为空 */
  icon?: string
  /** show_equipment_icon = yes → 游戏显示该科技的装备图标(即"默认科技图标"的真实语义) */
  showEquipmentIcon?: boolean
  /** 该科技对应的装备名(用于解析其图标 GFX;无显式 icon 时回退用) */
  equipment?: string
  /** enable_equipments 里的全部装备名(一个科技可能对应多个装备) */
  equipList?: string[]
  /**
   * ★ 坐标是否在文件里显式写过(faithful 解析结果)。
   *   实测 552 个科技里有 149 个【没写 folder.position】(多为隐藏科技 /
   *   CV 模组科技 / 只有 path 没有格子),解析后 x=y=0 —— 直接画会全部堆在原点,
   *   表现为"横纵向分布错误"。这些由 autoLayoutPositions() 按文件夹补齐网格位。
   *   显式写了的坐标【绝不改动】,保证与游戏一致。
   */
  posDeclared?: boolean
  /* ══════════════ TECHGRAPH_V1(2026-10-07,对齐 HOI4 MU 0.18.1)══════════════
   * 旧版只读了 path/enable,把 HOI4 MU 用来决定【科技树可见结构】的四个字段
   * 全丢了,导致:① xor 互斥科技被画成普通并行线;② allow_branch 分支科技
   * 恒显形;③ subTechnologies 子科技被当独立科技;④ 页签按 folder 切,
   * 而游戏是按 startTechnology 组切 —— 视觉与游戏内对不上。
   */
  /** xor = { ... }:与本科技【互斥不可同时研究】的科技 id(游戏用 ⊻ 菱形标记) */
  xor: string[]
  /**
   * allow_branch = { ... } 的完整判定条件。
   *
   * ⚠ 科技里的 allow_branch 与国策**语义不同**(实测原版 technologies/*.txt):
   *   allow_branch = { has_dlc = "Gotterdammerung" }   ← 科技(几乎全是这个)
   *   allow_branch = { has_completed_tech = X }        ← 理论上少数/模组
   * 所以不能只读 has_completed_tech —— 实测原版 11 个文件里全是 has_dlc,
   * 旧写法会静默解析出 0 条。下面按 DLC 列表 + 条件科技分开存。
   */
  allowBranch?: { dlcs: string[]; completedTech?: string; raw: string }
  /**
   * ★ inAllowBranch = allow_branch 的【传递闭包】,不止本科技直接写的那个。
   *   HOI4 MU 用不动点迭代算:若 A.allow_branch=X,且 X.leadsToTechs 含 B,
   *   则 B 也继承 X 这个门。旧版只看直接字段 → 分支的下游科技全部常显。
   *   仅当条件是 completedTech 时才传递(has_dlc 是全局门,不随 leads 传播)。
   */
  inAllowBranch: string[]
  /** allow_branch 里的 has_dlc 列表(实测原版主力用法) */
  allowBranchDlcs?: string[]
  /** allow_branch 原文(检查器展示用) */
  allowBranchRaw?: string
  /** ═ TRIGGERS_V1:allow_branch 完整条件树(对齐 focus 的 trigger.ts),前端三态求值判显隐 */
  allowBranchTrig?: TrigNode
  /** ═ TRIGGERS_V1:本科技 allow_branch 里可做成 UI 开关的条件 key(去重) */
  trigKeys?: string[]
  /** sub_technologies = { ... }:挂在本科技下的子科技 id(游戏画在父科技格内) */
  subTechnologies: string[]
  /** force_use_small_tech_layout = yes:强制用小布局(前端据此换排版) */
  forceUseSmallTechLayout?: boolean
  /** enable_subunits = { ... }:解锁的 sub-unit 名列表 */
  enableSubunits?: string[]
  /** enable_equipment_modules = { ... }:解锁的装备模块名列表 */
  enableEquipmentModules?: string[]
  /** enable_building = { building = X level = N }:解锁的建筑(一个科技可多个) */
  enableBuildings?: { building: string; level: number }[]
  /** enable_tactic = X:解锁的战斗战术 */
  enableTactic?: string
  /** dependencies = { tech = 1 ... }:AND 依赖(需全部研究,不画 path 线) */
  dependencies?: string[]
  /** sub_tech_index = N:子科技容器索引(覆盖) */
  subTechIndex?: number
  /** doctrine = yes / doctrine_name = X:学说标记与分支名 */
  doctrine?: boolean
  doctrineName?: string
  /** show_effect_as_desc = yes:修正/效果显示在描述而非 tooltip */
  showEffectAsDesc?: boolean
  /** desc = KEY:悬停额外描述 localisation key */
  extraDesc?: string
  /** ai_will_do = { ... }:AI 研究权重原文 */
  aiWillDo?: string
  /** ai_research_weights = { ... }:AI 侧重原文 */
  aiResearchWeights?: string
  /** path 详情:leads_to_tech + research_cost_coeff + ignore_for_layout */
  pathDetails?: { leads: string; costCoeff?: number; ignoreForLayout?: boolean }[]
  /** ★ MU 语义:本科技所属的 startTechnology 组(见 TechGraph.techTrees) */
  startTechnology?: string
  /** ═ TECHLAYOUT_GUI_V1:该科技在各 folder 下所属的 gridbox 子树名(键=folder id;仅当该 folder 有 gui 布局)。
   *   归属由 assignGridboxes() 按名字分层 + 家族 + 边亲和判定(见该函数注释)。 */
  gb?: Record<string, string>
  /** ═ TECHLAYOUT_GUI_V1:该科技在各 folder 下的 gui 像素坐标(键=folder id)。
   *   = gridbox 原点 + folder.position × slotsize(轴交换已在引擎侧:x=纵向行、y=横向列),
   *   与 countrytechtreeview.gui 的网格一致;无 gui 布局的 folder 用 70×70 兜底。 */
  px?: Record<string, { x: number; y: number }>
  /* ══════════════ TECHEFFECT_V1(2026-10-09,研究完成效果)══════════════
   * 之前只解析 research_cost / start_year,把「研究完给什么」全丢了 ——
   * 检查器只能显示属性,看不到效果。这里把 HOI4 科技的效果字段收进来:
   *   modifiers = { ... }                  研究完的国家修正(blockText 原文)
   *   research_bonus / equipment_bonus     研究/装备加成(blockText 原文)
   *   research_speed_bonus / start_research_skill / start_xp = 数值
   *   instant = yes                        立即完成
   * 数值类直接给数,复杂块给原文(前端以代码块展示)。 */
  effects?: {
    /** modifiers = { ... } 原始块文本 */
    modifiers?: string
    /** research_bonus = { ... } 原始块文本 */
    researchBonus?: string
    /** equipment_bonus = { ... } 原始块文本 */
    equipmentBonus?: string
    /** research_speed_bonus = 数值 */
    researchSpeed?: number
    /** start_research_skill = 数值 */
    startResearchSkill?: number
    /** start_xp = 数值 */
    startXp?: number
    /** instant = yes */
    instant?: boolean
    /** on_research_complete = { ... } 研究完成效果块原文(vanilla 最常见效果) */
    onComplete?: string
    /** on_research_complete_limit = { ... } 效果触发条件原文 */
    onCompleteLimit?: string
    /** path = { research_speed = { ... } } 研究速度块原文 */
    pathResearchSpeed?: string
    /** XP 加成:xp_research_type / xp_boost_cost / xp_research_bonus */
    xpType?: string
    xpCost?: number
    xpBonus?: number
    /** xp_unlock_cost = 数值:经验直接解锁整个科技(旧学派做法) */
    xpUnlockCost?: number
  }
}

/**
 * ★ TECHGRAPH_V1:HOI4 MU `$s()` 的等价物 —— 【起始科技树】分组。
 *
 * 游戏科技树页签不是按 technology_folders 切的,而是按"从哪个科技起手"
 * 把可达的一整棵树合成一个页签。原版实测:naval_folder 里有 30+ 科技,
 * 但页签只有「early_naval_theory / naval_base / ...」若干棵树。
 * 照抄可达性合并逻辑,页签结构才和游戏一致。
 */
export interface TechTree {
  /** 该树的起始科技 id(= 页签名) */
  startTechnology: string
  /** 所属 folder(仅用于回退分组与配色) */
  folder: string
  /** 树内全部科技 id(含起始科技),按可达顺序 */
  technologies: string[]
  /** ★ xor 分组:id 落在同一组内表示互斥,前端画 ⊻ 中转点 */
  xorGroups: string[][]
}

export interface TechEdge {
  from: string
  to: string
  kind: 'leads' | 'enable'
}

/**
 * ★ 同一 folder 内【坐标完全相同】的一组科技(实测 58 组)。
 *
 * ⚠ 这不是数据错误,而是游戏的真实排布:同一格里塞了多条互斥/DLC 替代科技。
 *   最典型 naval_folder@(0,1) = early_destroyer / transport / early_carrier /
 *   early_submarine —— 4 条船在同一格;游戏靠图标本身区分(横向错开一格显示)。
 *   实测单格最多 7 条(bba_air_techs_folder@(0,2))。
 *
 * 前端必须按 slot 顺序横向错开,否则 58 组节点会完全重叠成一坨,
 * 看上去就是"横纵向分布有误"。这里只负责把分组算好下发,渲染在前端。
 */
export interface TechSlot {
  folder: string
  x: number
  y: number
  /** ★ TECHLAYOUT_GUI_V1:该格所属的 gridbox 子树名(无布局为空)。
   *   堆叠必须按 gridbox 分组:不同子树的同坐标格不是同一格
   *   (实测 transport_tree 与 naval_folder 的 mb 系列子树有同 (0,1) 格)。 */
  gb?: string
  /** 组内科技 id,按源文件出现顺序 */
  ids: string[]
}

/** ══════════════ TECHLAYOUT_GUI_V1(2026-10-08,科技树布局对齐游戏 GUI)══════════════
 * countrytechtreeview.gui 决定科技树页面上每个科技的真实位置:游戏把 folder.position
 * (x=分支行、y=年份索引)套进 folder 容器内的 gridboxtype 网格(gridbox 原点 + position×slotsize)。
 * 解析该 gui 文件供 buildTechGraph 计算每个科技最终像素位置。
 * slotsize 实测:绝大多数 70×70;空军 60×70;电子 60×60;舰炮(basic_battery)70×35。 */
export interface TechLayoutGridbox {
  /** gridbox 名(原名如 support_weapons_tree;去 _tree 后缀即子树名) */
  name: string
  /** 网格原点 x(像素) */
  x: number
  /** 网格原点 y(像素) */
  y: number
  /** 格宽(像素;游戏 slotsize.width) */
  slotW: number
  /** 格高(像素;游戏 slotsize.height) */
  slotH: number
}
export interface TechLayoutFolder {
  /** folder 容器 id(如 infantry_folder) */
  id: string
  /** 容器 position.x(像素;百分比按 GUI_REFW=1400 折算) */
  posX: number
  /** 容器 position.y(像素;百分比按 GUI_REFH=1275 折算) */
  posY: number
  /** 容器内全部 gridbox(按声明顺序) */
  gridboxes: TechLayoutGridbox[]
}

export interface TechGraph {
  roots: TechRoot[]
  nodes: Map<string, TechNode>
  edges: TechEdge[]
  /** technology_categories 的顺序表(决定左右次序),134 项 */
  categories: string[]
  /** category 顺序索引,便于排序 */
  catIndex: Map<string, number>
  /** technology_folders 的显示分组,16 项 */
  folders: Map<string, TechFolder>
  /** folder 声明顺序 */
  folderOrder: string[]
  /**
   * ★ OWNERSHIP_V1:科技 id → 该 id 的**全部**定义现场(按载入序)。
   *   同名科技是【后者整份替换前者】,但先载入的那份必须留档,否则无法回答
   *   "这条科技原版有吗 / 被哪个模组改写了"。界面与统计只认最后一条(生效集)。
   */
  versions: Map<string, { root: number; file: string; line: number }[]>
  /** 同上:technology_folders 的定义链 */
  folderVersions: Map<string, { root: number; file: string; line: number }[]>
  /** 解析出的 @变量(全局并集,兜底用) */
  vars: Map<string, number>
  /** ★ @变量按【文件】作用域:各文件在同名常量上数值可不同
      (实测 infantry.txt @1936=2,而 NSB_armor.txt @1936=4)。
      全局表后加载者覆盖会串味 → 必须按文件收集/解析。 */
  fileVars: Map<string, Map<string, number>>
  /** 解析不到的 @引用 */
  danglingVar: { tech: string; ref: string }[]
  /** 边指向不存在的科技 */
  danglingEdge: { from: string; to: string; kind: string }[]
  /** 科技引用了但 technology_categories 表里没有的 category */
  unknownCategories: string[]
  /** folder.name 引用了但 technology_folders 没声明的 */
  unknownFolders: string[]
  /** ★ 同 folder 同坐标的分组(58 组),前端据此横向错开 */
  slots: TechSlot[]
  /** ★ TECHLAYOUT_GUI_V1:countrytechtreeview.gui 的科技树布局(folder 容器 → gridbox 列表) */
  layout: TechLayoutFolder[]
  /** ★ TECHGRAPH_V1:起始科技树分组(MU `$s()` 等价),页签按它切 */
  techTrees: TechTree[]
  /** ★ 逐节点的 xor 关系(对称补全),前端画 ⊻ 用 */
  xorPairs: { a: string; b: string; folder: string }[]
}

function walk(dir: string, exts: string[]): string[] {
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
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  return undefined
}
function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  return undefined
}
function childBlocks(doc: Document, b: Block, key: string): Block[] {
  const out: Block[] = []
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) out.push(e.block)
  return out
}
function bareValues(doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) if (e.key < 0 && e.value >= 0) out.push(valueText(doc, e) ?? '')
  return out.filter(Boolean)
}
/** 取一个块的原文(检查器「显示详情」用)。
 *  ⚠ Block 用的是 open/close token 下标,不是 start/end(那是 Entry 的)。 */
function blockText(doc: Document, b: Block): string {
  let s = ''
  for (let i = b.open; i <= b.close && i < doc.tokens.length; i++) s += doc.tokens[i].text
  return s.trim()
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : undefined
}

/**
 * 读 technology_tags:返回「分类顺序表」与「显示分组」。
 * ⚠ 允许目录缺失(纯 vanilla 一定有,但模组可能没有这一层),
 *   缺失时返回空表,由调用方降级为"只用 categories 字段"。
 */
function readTechTags(
  roots: TechRoot[],
  g: { categories: string[]; folders: Map<string, TechFolder>; folderOrder: string[] },
): void {
  roots.forEach((r, ri) => {
    const dir = join(r.path, 'common', 'technology_tags')
    for (const abs of walk(dir, ['.txt'])) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      // technology_categories = { a b c } —— 裸 id 列表,决定左右次序
      const cats = childBlock(doc, doc.root, 'technology_categories')
      if (cats) for (const c of bareValues(doc, cats)) if (!g.categories.includes(c)) g.categories.push(c)
      // technology_folders = { xxx_folder = { ledger = ... doctrine = yes } }
      const fds = childBlock(doc, doc.root, 'technology_folders')
      if (fds) {
        for (const e of fds.entries) {
          const k = keyText(doc, e)
          if (!k || !e.block) continue
          // ★ OWNERSHIP_V1:同名 folder 由【后加载的模组整份替换】(原来写的是
          //   "后加载的不覆盖先加载的",与游戏语义相反 —— 模组改 folder 会不生效)。
          //   顺序表只在首次出现时登记,避免同一 folder 重复占位。
          const fv = g.folderVersions.get(k) ?? []
          fv.push({ root: ri, file, line: lineOf(doc, e) })
          g.folderVersions.set(k, fv)
          if (!g.folders.has(k)) g.folderOrder.push(k)
          g.folders.set(k, {
            id: k,
            ledger: childValue(doc, e.block, 'ledger'),
            doctrine: /^\s*(yes|true)\s*$/i.test(childValue(doc, e.block, 'doctrine') ?? ''),
            dlcGated: childBlock(doc, e.block, 'available') !== undefined,
            root: ri,
            file,
            line: lineOf(doc, e),
          })
        }
      }
    }
  })
}

export function buildTechGraph(roots: TechRoot[]): TechGraph {
  const g: TechGraph = {
    roots,
    nodes: new Map(),
    edges: [],
    categories: [],
    catIndex: new Map(),
    folders: new Map(),
    folderOrder: [],
    versions: new Map(),
    folderVersions: new Map(),
    vars: new Map(),
    fileVars: new Map(),
    danglingVar: [],
    danglingEdge: [],
    unknownCategories: [],
    unknownFolders: [],
    slots: [],
    layout: [],
    techTrees: [],
    xorPairs: [],
  }

  // 第 0 遍:读分类与文件夹(顺序表要在给科技归类之前拿到)
  readTechTags(roots, g)
  g.categories.forEach((c, i) => g.catIndex.set(c, i))
  // ★ TECHLAYOUT_GUI_V1(第 0.5 遍):读 countrytechtreeview.gui 的科技树布局
  g.layout = readTechLayout(roots)

  // 第一遍:收集所有 @变量(可能跨文件定义,如 00_technology.txt 统一定义年份;
  // 定义常写在 technologies = { } 内部,必须递归扫描)
  const allDocs: { ri: number; file: string; doc: Document }[] = []
  roots.forEach((r, ri) => {
    const dir = join(r.path, 'common', 'technologies')
    for (const abs of walk(dir, ['.txt'])) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      allDocs.push({ ri, file, doc })
      const fvars = new Map<string, number>()
      g.fileVars.set(file, fvars)
      const scanVars = (b: Block): void => {
        for (const e of b.entries) {
          const k = keyText(doc, e)
          if (k?.startsWith('@') && e.value >= 0) {
            const v = num(valueText(doc, e))
            if (v !== undefined) {
              fvars.set(k.slice(1), v)
              g.vars.set(k.slice(1), v)
            }
          }
          if (e.block) scanVars(e.block)
        }
      }
      scanVars(doc.root)
    }
  })

  // 第二遍:解析科技块。@变量按【文件】作用域解析(infantry @1936=2、
  // NSB_armor @1936=4 同名不同值 → 必须用本文件自己的常量表)。
  for (const { ri, file, doc } of allDocs) {
    const fvars = g.fileVars.get(file) ?? new Map()
    const resolve = (s: string | undefined): number | undefined => {
      if (s === undefined) return undefined
      if (s.startsWith('@')) {
        const v = fvars.get(s.slice(1))
        if (v !== undefined) return v
        return g.vars.get(s.slice(1))
      }
      return num(s)
    }
    // 找到 technologies 包裹块,否则用根块
    let container = doc.root
    const tw = childBlock(doc, doc.root, 'technologies')
    if (tw) container = tw

    for (const e of container.entries) {
      const k = keyText(doc, e)
      if (!k || !e.block || k.startsWith('@')) continue
      const b = e.block
      // 坐标:folder.position —— ★ 多 folder 科技每个 folder 独立 name+position,
      //   全部读入 folders(对齐 HOI4 MU `tech.folders[当前folder].x/.y`)。
      let x = 0
      let y = 0
      let posDeclared = false
      const posTech = childBlock(doc, b, 'position')
      const folderBlks = childBlocks(doc, b, 'folder')
      const foldersRec: Record<string, { x: number; y: number }> = {}
      // 位置来源:tech 块直接 position → 该块自己的 position → 退回直接 x/y
      const posOf = (src: Block | undefined): { x: number; y: number } | undefined => {
        const p = posTech || (src ? childBlock(doc, src, 'position') : undefined)
        if (!p) return undefined
        const rx = resolve(childValue(doc, p, 'x'))
        const ry = resolve(childValue(doc, p, 'y'))
        return rx === undefined && ry === undefined ? undefined : { x: rx ?? 0, y: ry ?? 0 }
      }
      // 每个 folder 块都算上(多 folder 科技:radio / motorised_infantry / sp_centrifugal_jet_tech …)
      for (const fb of folderBlks) {
        const nm = childValue(doc, fb, 'name')
        if (!nm) continue
        foldersRec[nm] = posOf(fb) ?? { x: 0, y: 0 }
      }
      // 主坐标:首个 folder 的位置;无 folder 则直接 position / 直接 x/y
      const primary = folderBlks.length ? posOf(folderBlks[0]) : posOf(undefined)
      if (primary) {
        x = primary.x
        y = primary.y
        posDeclared = true
      } else {
        const rx = resolve(childValue(doc, b, 'x'))
        const ry = resolve(childValue(doc, b, 'y'))
        x = rx ?? 0
        y = ry ?? 0
        posDeclared = rx !== undefined || ry !== undefined
      }
      // @引用解析不到 → 记录(主坐标)
      const rawSrc = folderBlks.length ? (posTech ?? childBlock(doc, folderBlks[0], 'position')) : (posTech ?? b)
      const rawY = childValue(doc, rawSrc, 'y')
      if (rawY?.startsWith('@') && resolve(rawY) === undefined) g.danglingVar.push({ tech: k, ref: rawY })

      // categories —— 完整列表(实测 434 个科技是多分类)
      const cats = childBlock(doc, b, 'categories')
      const catList = cats ? bareValues(doc, cats) : []
      for (const c of catList) {
        if (g.catIndex.size && !g.catIndex.has(c) && !g.unknownCategories.includes(c)) g.unknownCategories.push(c)
      }
      // folder = { name = xxx_folder } —— 显示分组(多 folder 全部检查)
      const folderName = folderBlks.length ? childValue(doc, folderBlks[0], 'name') : undefined
      for (const fnm of Object.keys(foldersRec)) {
        if (g.folders.size && !g.folders.has(fnm) && !g.unknownFolders.includes(fnm)) {
          g.unknownFolders.push(fnm)
        }
      }

      const cost = num(childValue(doc, b, 'research_cost')) ?? 0
      const year = num(childValue(doc, b, 'start_year')) ?? 0
      const icon = childValue(doc, b, 'icon') ?? ''
      // ★ 游戏"默认科技图标"语义(实测 vanilla/模组):科技块上没有 icon 时,
      //   若 show_equipment_icon = yes,游戏画的是【该科技 enable_equipments 的装备图标】。
      //   ⚠ 装备名不来自 `equipment =`(全库 0 处),而来自同块的 enable_equipments 裸值,
      //   例:NSB_armor 的 gwtank_chassis、naval.txt 的多项装备。
      const showEquipmentIcon = /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'show_equipment_icon') ?? '')
      const equipBlock = childBlock(doc, b, 'enable_equipments')
      const equipList = equipBlock ? bareValues(doc, equipBlock).filter((v) => v && !v.startsWith('@')) : []
      // 显式 equipment = 优先(模组可能这么写);否则取 enable_equipments 首个
      const equipment = childValue(doc, b, 'equipment') ?? equipList[0]
      const _esu = childBlock(doc, b, 'enable_subunits')
      const enableSubunits = _esu ? bareValues(doc, _esu).filter((v) => v && !v.startsWith('@')) : undefined
      const _eem = childBlock(doc, b, 'enable_equipment_modules')
      const enableEquipmentModules = _eem ? bareValues(doc, _eem).filter((v) => v && !v.startsWith('@')) : undefined
      const ebB = childBlocks(doc, b, 'enable_building')
      const enableBuildings = ebB.length ? ebB.map((bl) => ({ building: childValue(doc, bl, 'building') ?? '', level: num(childValue(doc, bl, 'level')) ?? 0 })).filter((x) => x.building) : undefined
      const enableTactic = childValue(doc, b, 'enable_tactic') || undefined

      const leads: string[] = []
      const pathDetails: { leads: string; costCoeff?: number; ignoreForLayout?: boolean }[] = []
      for (const p of childBlocks(doc, b, 'path')) {
        const t = childValue(doc, p, 'leads_to_tech')
        if (t) {
          leads.push(t)
          const pd: { leads: string; costCoeff?: number; ignoreForLayout?: boolean } = { leads: t }
          const _cc = num(childValue(doc, p, 'research_cost_coeff'))
          if (_cc !== undefined) pd.costCoeff = _cc
          if (/^\s*(yes|true)\s*$/i.test(childValue(doc, p, 'ignore_for_layout') ?? '')) pd.ignoreForLayout = true
          pathDetails.push(pd)
        }
      }
      const pathDetailsOut = pathDetails.length ? pathDetails : undefined
      const enables: string[] = []
      const et = childBlock(doc, b, 'enable_technologies')
      if (et) enables.push(...bareValues(doc, et))

      /* ══════════════ TECHGRAPH_V1:HOI4 MU 0.18.1 的 Fs() 字段 ══════════════
       * xor = { ... }                互斥科技(MU: e.xor)
       * allow_branch = { has_completed_tech = X }  显形门(MU: e.allowBranch)
       * sub_technologies = { ... }   子科技(MU: e.subTechnologies)
       * force_use_small_tech_layout = yes        (MU: e.forceUseSmallTechLayout)
       * 这四个以前全丢,导致 xor 画成并行线、allow_branch 恒显形。 */
      const xorBlk = childBlock(doc, b, 'xor')
      const xor = xorBlk ? bareValues(doc, xorBlk).filter((v) => v && !v.startsWith('@')) : []
      const abBlk = childBlock(doc, b, 'allow_branch')
      let allowBranch: { dlcs: string[]; completedTech?: string; raw: string } | undefined
      if (abBlk) {
        /* ⚠ has_dlc 写成 `has_dlc = "Gotterdammerung"`(key=value),
         *   不是裸值 —— 用 bareValues 会静默取到空数组(实测踩过:
         *   allowBranch 数对但 DLC 列表全空)。这里遍历全部带 key 的条目取 value。 */
        const dlcs: string[] = []
        for (const e of abBlk.entries) {
          if (e.key < 0 || e.value < 0) continue
          const k = keyText(doc, e)?.toLowerCase()
          if (k !== 'has_dlc') continue
          const v = valueText(doc, e) ?? ''
          const t = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
          if (t) dlcs.push(t)
        }
        for (const v of bareValues(doc, abBlk)) {
          const t = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
          if (t) dlcs.push(t)
        }
        const ct = childValue(doc, abBlk, 'has_completed_tech')
        allowBranch = { dlcs, completedTech: ct, raw: blockText(doc, abBlk) }
      }
      /* ═ TRIGGERS_V1:allow_branch 解析成完整条件树(对齐 focus 的 trigger-parse.ts)。
         * 旧版只提 dlcs + 单个 has_completed_tech,其余门控(OR/NOT/flag/gamerule)全丢,
         * 分支显隐无法精确。现在下发条件树,前端 Trig.evalTrig 三态求值判显隐。 */
      const abTrigs = parseTriggerBlocks(doc, b, 'allow_branch')
      let allowBranchTrig: TrigNode | undefined
      if (abTrigs.length === 1) allowBranchTrig = abTrigs[0]
      else if (abTrigs.length > 1) allowBranchTrig = { type: 'and', items: abTrigs }
      const trigKeys = new Set<string>()
      if (allowBranchTrig) for (const c of collectConditions(allowBranchTrig).values()) trigKeys.add(c.nodeContent)
      const stBlk = childBlock(doc, b, 'sub_technologies')
      const subTechnologies = stBlk ? bareValues(doc, stBlk).filter((v) => v && !v.startsWith('@')) : []
      const forceUseSmallTechLayout =
        /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'force_use_small_tech_layout') ?? '') || undefined
      const doctrine = /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'doctrine') ?? '') || undefined
      const doctrineName = childValue(doc, b, 'doctrine_name') || undefined
      const showEffectAsDesc = /^\s*(yes|true)\s*$/i.test(childValue(doc, b, 'show_effect_as_desc') ?? '') || undefined
      const extraDesc = childValue(doc, b, 'desc') || undefined
      const _sti = num(childValue(doc, b, 'sub_tech_index'))
      const depB = childBlock(doc, b, 'dependencies')
      const dependencies: string[] = []
      if (depB) for (const de of depB.entries) { const kk = keyText(doc, de); if (kk && !kk.startsWith('@')) dependencies.push(kk) }
      const dependenciesOut = dependencies.length ? dependencies : undefined
      const awdBlk = childBlock(doc, b, 'ai_will_do')
      const aiWillDo = awdBlk ? blockText(doc, awdBlk) : undefined
      const arwBlk = childBlock(doc, b, 'ai_research_weights')
      const aiResearchWeights = arwBlk ? blockText(doc, arwBlk) : undefined
      /* ═ TECHEFFECT_V1:研究完成效果(见 TechNode.effects 注释)。
       * 数值字段直接取;复杂块(modifiers/research_bonus/equipment_bonus)存原文,
       * 前端以 <pre> 代码块展示。effect 块为空时整体不生成字段。 */
      const eff: NonNullable<TechNode['effects']> = {}
      const modBlk = childBlock(doc, b, 'modifiers')
      if (modBlk) eff.modifiers = blockText(doc, modBlk)
      const rbBlk = childBlock(doc, b, 'research_bonus')
      if (rbBlk) eff.researchBonus = blockText(doc, rbBlk)
      const ebBlk = childBlock(doc, b, 'equipment_bonus')
      if (ebBlk) eff.equipmentBonus = blockText(doc, ebBlk)
      const _rs = childValue(doc, b, 'research_speed_bonus')
      if (_rs !== undefined) { const _n = num(_rs); if (_n !== undefined) eff.researchSpeed = _n }
      const _ss = childValue(doc, b, 'start_research_skill')
      if (_ss !== undefined) { const _n = num(_ss); if (_n !== undefined) eff.startResearchSkill = _n }
      const _sx = childValue(doc, b, 'start_xp')
      if (_sx !== undefined) { const _n = num(_sx); if (_n !== undefined) eff.startXp = _n }
      const _inst = childValue(doc, b, 'instant')
      if (_inst && /^\s*(yes|true)\s*$/i.test(_inst)) eff.instant = true
      /* TECHEFFECT_V1:vanilla 科技最普遍的效果是 on_research_complete 与 XP 加成,
       * 另外 path 内的 research_speed 块也是研究效果 —— 一并收进来,检查器/隐藏页展示。 */
      const ocBlk = childBlock(doc, b, 'on_research_complete')
      if (ocBlk) eff.onComplete = blockText(doc, ocBlk)
      const _xpt = childValue(doc, b, 'xp_research_type')
      if (_xpt) eff.xpType = _xpt
      const _xpc = num(childValue(doc, b, 'xp_boost_cost'))
      if (_xpc !== undefined) eff.xpCost = _xpc
      const _xpb = num(childValue(doc, b, 'xp_research_bonus'))
      if (_xpb !== undefined) eff.xpBonus = _xpb
      const _xpu = num(childValue(doc, b, 'xp_unlock_cost'))
      if (_xpu !== undefined) eff.xpUnlockCost = _xpu
      const orcL = childBlock(doc, b, 'on_research_complete_limit')
      if (orcL) eff.onCompleteLimit = blockText(doc, orcL)
      const pathBlk = childBlock(doc, b, 'path')
      if (pathBlk) {
        const rsBlk = childBlock(doc, pathBlk, 'research_speed')
        if (rsBlk) eff.pathResearchSpeed = blockText(doc, rsBlk)
      }
      const effects = Object.keys(eff).length ? eff : undefined

      /* ★ OWNERSHIP_V1:同名科技【后加载的模组整份替换先加载的】。
       *   旧代码是 `if (!g.nodes.has(k))` —— 先出现的赢,等于模组改科技永远不生效,
       *   而且界面还显示成原版那份(来源标 vanilla)。与游戏语义正好相反。
       *   替换的同时把每个定义现场存进 versions,供"谁改写了它"与归属三态使用。 */
      const vs = g.versions.get(k) ?? []
      vs.push({ root: ri, file, line: lineOf(doc, e) })
      g.versions.set(k, vs)
      g.nodes.set(k, {
        id: k,
        x,
        y,
        cost,
        year,
        area: catList[0] ?? '',
        categories: catList,
        folder: folderName,
        folders: foldersRec,
        // ⚠ 无 categories → 游戏里没有标题栏,单独归组(实测 73 个)
        hidden: catList.length === 0,
        leads,
        enables,
        requires: [],
        file,
        line: lineOf(doc, e),
        root: ri,
        posDeclared,
        icon,
        showEquipmentIcon,
        equipment,
        equipList,
        xor,
        allowBranch,
        inAllowBranch: allowBranch?.completedTech ? [allowBranch.completedTech] : [],
        allowBranchDlcs: allowBranch?.dlcs.length ? allowBranch.dlcs : undefined,
        allowBranchRaw: allowBranch?.raw,
        allowBranchTrig,
        trigKeys: trigKeys.size ? [...trigKeys] : undefined,
        subTechnologies,
        forceUseSmallTechLayout,
        effects,
        enableSubunits,
        enableEquipmentModules,
        enableBuildings,
        enableTactic,
        dependencies: dependenciesOut,
        subTechIndex: _sti,
        doctrine,
        doctrineName,
        showEffectAsDesc,
        extraDesc,
        aiWillDo,
        aiResearchWeights,
        pathDetails: pathDetailsOut,
      })
    }
  }

  // 由 leads/enables 反推 requires + 构建边
  for (const n of g.nodes.values()) {
    // Wiki:dependencies = { ... } 是 AND 依赖(需全部研究),但不画 path 连线,只进 requires
    if (n.dependencies) for (const dep of n.dependencies) {
      if (g.nodes.has(dep) && !n.requires.includes(dep)) n.requires.push(dep)
    }
    for (const t of n.leads) {
      g.edges.push({ from: n.id, to: t, kind: 'leads' })
      const target = g.nodes.get(t)
      if (target) {
        if (!target.requires.includes(n.id)) target.requires.push(n.id)
      } else {
        g.danglingEdge.push({ from: n.id, to: t, kind: 'leads' })
      }
    }
    for (const t of n.enables) {
      g.edges.push({ from: n.id, to: t, kind: 'enable' })
      const target = g.nodes.get(t)
      if (target) {
        if (!target.requires.includes(n.id)) target.requires.push(n.id)
      } else {
        g.danglingEdge.push({ from: n.id, to: t, kind: 'enable' })
      }
    }
  }

  // ★ TECHGRAPH_V1:allow_branch 传递闭包(照抄 HOI4 MU Fs() 的不动点循环)
  //   「若 A.allow_branch = X,且 X.leadsToTechs 含 B,则 B 也继承 X 这道门」。
  //   旧版只认本科技直接写的字段 → 分支的下游科技在游戏里未显形,这里却常显。
  const leadsFwd = new Map<string, string[]>()
  for (const n of g.nodes.values()) {
    if (!n.leads.length) continue
    const arr = leadsFwd.get(n.id)
    if (arr) for (const t of n.leads) arr.push(t)
    else leadsFwd.set(n.id, n.leads.slice())
  }
  for (let round = 0; round < 64; round++) {
    let changed = false
    for (const n of g.nodes.values()) {
      if (!n.inAllowBranch.length) continue
      for (const t of n.leads) {
        const child = g.nodes.get(t)
        if (!child) continue
        for (const gate of n.inAllowBranch) {
          if (!child.inAllowBranch.includes(gate)) {
            child.inAllowBranch.push(gate)
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }

  // ★ xor 对称补全:HOI4 MU 只在 xorGroups 里标"互为 XOR 的科技",
  //   边的方向靠 ⊻ 中转点,不画实线。这里同样只收集对,方向由前端定。
  const xorPairs: { a: string; b: string; folder: string }[] = []
  const xorSeen = new Set<string>()
  for (const n of g.nodes.values()) {
    for (const o of n.xor) {
      if (!g.nodes.has(o)) continue
      const k = n.id < o ? n.id + '|' + o : o + '|' + n.id
      if (xorSeen.has(k)) continue
      xorSeen.add(k)
      xorPairs.push({ a: n.id, b: o, folder: n.folder ?? '' })
    }
  }
  g.xorPairs = xorPairs

  autoLayoutPositions(g)
  /* ★ TECHLAYOUT_GUI_V1:gui 布局归属 + 像素坐标。
   * 必须在 edges(边亲和依赖)与 autoLayout(未声明科技补位)之后、
   * collectSlots 之前(堆叠按 gridbox 分组需要 gb 已算好)。 */
  assignGridboxes(g)
  collectSlots(g)
  g.techTrees = buildTechTrees(g)
  return g
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ TECHGRAPH_V1:HOI4 MU `$s(e)` 的等价实现 —— 起始科技树分组。
 *
 * MU 做法:遍历 folder 内科技,若该科技还没被任何组收走,就以它为
 * `startTechnology` 做一次 leadsToTechs 可达性 BFS,收进一个组;重复直到
 * 该 folder 收完。同 folder 里"互不可达"的科技自然分成多棵树。
 *
 * 我们额外做两件 MU 靠前端做的事:
 *   ① xorGroups:把互为 xor 的科技收拢(前端画 ⊻ 中转点而不是长实线)
 *   ② 排序稳定:起始科技按 (y,x,源文件序) 排,保证页签顺序稳定可复现
 */
/** 一个科技所属的全部 folder(多 folder 科技返回多个;空 folder 记为 '') */
function folderKeysOf(n: TechNode): string[] {
  if (n.folders && Object.keys(n.folders).length) return Object.keys(n.folders)
  return n.folder ? [n.folder] : ['']
}
/** 某科技是否属于 folder f(多 folder 按 folders 成员判断) */
function nodeInFolder(n: TechNode, f: string): boolean {
  if (f === '') return (n.folder ?? '') === ''
  if (n.folders && f in n.folders) return true
  return (n.folder ?? '') === f
}
/** 科技在 folder f 下的坐标(多 folder 用 folders[f],否则主 x/y) */
function posInFolder(n: TechNode, f: string): { x: number; y: number } {
  if (n.folders && f in n.folders) return n.folders[f]
  return { x: n.x, y: n.y }
}

function buildTechTrees(g: TechGraph): TechTree[] {
  const out: TechTree[] = []
  // 收集 folder → 科技 id(按源文件顺序,保证确定性)
  const byFolder = new Map<string, string[]>()
  const order = new Map<string, number>()
  let seq = 0
  for (const n of g.nodes.values()) {
    order.set(n.id, seq++)
    for (const f of folderKeysOf(n)) {
      const arr = byFolder.get(f)
      if (arr) arr.push(n.id)
      else byFolder.set(f, [n.id])
    }
  }
  const xorOf = new Map<string, string[]>()
  for (const p of (g.xorPairs ?? [])) {
    const a = xorOf.get(p.a)
    if (a) a.push(p.b)
    else xorOf.set(p.a, [p.b])
    const b = xorOf.get(p.b)
    if (b) b.push(p.a)
    else xorOf.set(p.b, [p.a])
  }

  for (const [folder, ids] of byFolder) {
    const taken = new Set<string>()
    const sorted = ids.slice().sort((p, q) => {
      const a = g.nodes.get(p)!
      const b = g.nodes.get(q)!
      return (a.y - b.y) || (a.x - b.x) || (order.get(p)! - order.get(q)!)
    })
    for (const seed of sorted) {
      if (taken.has(seed)) continue
      // 可达性 BFS:沿 leadsToTechs 前进,不跨出本 folder(MU 也按 folder 分组)
      const reach: string[] = []
      const seen = new Set<string>()
      const q: string[] = [seed]
      seen.add(seed)
      while (q.length) {
        const cur = q.shift()!
        reach.push(cur)
        taken.add(cur)
        const n = g.nodes.get(cur)
        if (!n) continue
        for (const t of n.leads) {
          const tn = g.nodes.get(t)
          if (!tn || seen.has(t)) continue
          if (!nodeInFolder(tn, folder)) continue
          seen.add(t)
          q.push(t)
        }
      }
      // xor 分组:树内互为 xor 的两两成组
      const xg: string[][] = []
      const inTree = new Set(reach)
      for (const cur of reach) {
        for (const o of xorOf.get(cur) || []) {
          if (!inTree.has(o)) continue
          const k = cur < o ? cur + '|' + o : o + '|' + cur
          if (xg.some((s) => s.includes(cur) || s.includes(o))) continue
          xg.push(cur < o ? [cur, o] : [o, cur])
          void k
        }
      }
      out.push({ startTechnology: seed, folder, technologies: reach, xorGroups: xg })
    }
  }
  // 排序:先按 folder 声明顺序,再按起始科技 (y,x,序)
  const fOrder = new Map<string, number>()
  g.folderOrder.forEach((f, i) => fOrder.set(f, i))
  out.sort((a, b) => {
    const fa = fOrder.get(a.folder) ?? 999
    const fb = fOrder.get(b.folder) ?? 999
    if (fa !== fb) return fa - fb
    const na = g.nodes.get(a.startTechnology)
    const nb = g.nodes.get(b.startTechnology)
    return ((na?.y ?? 0) - (nb?.y ?? 0)) || ((na?.x ?? 0) - (nb?.x ?? 0)) ||
      ((order.get(a.startTechnology) ?? 0) - (order.get(b.startTechnology) ?? 0))
  })
  // 回填 startTechnology 字段,供单节点查询
  for (const t of out) {
    const n = g.nodes.get(t.startTechnology)
    if (n) n.startTechnology = t.startTechnology
  }
  return out
}

/**
 * ★ 收集「同 folder 同坐标」的科技分组。
 * 只收 2 条以上的组(单条的本来就是独立格子),供前端横向错开渲染。
 *
 * ★ TECHLAYOUT_GUI_V1:分组键带 gridbox —— 同一 folder 里【不同子树】的同坐标格
 * 不是同一格(实测 naval_folder 的 transport_tree 与 mb 各子树存在同 (0,1) 格;
 * airsweep_mines / airdrop_mines 与其 bba 变体同格但属于同树,仍正确合并)。
 */
function collectSlots(g: TechGraph): void {
  const m = new Map<string, TechSlot>()
  for (const n of g.nodes.values()) {
    for (const f of folderKeysOf(n)) {
      const p = posInFolder(n, f)
      const gb = (n.gb && n.gb[f]) || ''
      const key = `${f}|${gb}|${p.x},${p.y}`
      let s = m.get(key)
      if (!s) {
        s = { folder: f, x: p.x, y: p.y, gb: gb || undefined, ids: [] }
        m.set(key, s)
      }
      s.ids.push(n.id)
    }
  }
  g.slots = [...m.values()].filter((s) => s.ids.length > 1)
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ TECHLAYOUT_GUI_V1:countrytechtreeview.gui 解析 + tech→gridbox 归属。
 *
 * 游戏科技树页面布局 = folder 容器(infantry_folder 等)内的 gridboxtype 网格:
 *   每个 gridbox 只有【原点 + slotsize】(如 {140,210} + 70×70),没有范围属性;
 *   科技归属哪个子树由游戏内部按名字/分类推断,这里用同样的推断:
 *
 *   ① 名字分层(nameScore):完全相等 100 / 前缀+下划线 90 / 前缀 80 /
 *      去数字前缀 85(如 damage_control_2 ← damage_control_1)/ 去噪声核心相等 60;
 *      同分取【去数字核心更长】(修 jet_strategic_bomber1 被 early_bomber 拉走)。
 *   ② 边亲和优先:无名字匹配的科技,若其 leads/enable 边【只指向一个 box】
 *      的名字匹配成员 → 直接归它(修 infantry_at 循前置 improved_infantry_weapons
 *      归 infantry_weapons_tree;excavation 循 construction 归 construction1_tree)。
 *   ③ 家族回退:科技分类与各 box 名字匹配成员分类的并集按【分类去重】取权
 *      (非 mio 分类 1.0 / mio 0.25 —— mio_cat_* 是装甲/舰船家族噪声),另加
 *      边亲和 0.5/条;mio 分类仅在该科技没有非 mio 分类时兜底;平局取核心更长、
 *      再平局按 gui 声明顺序取首个;全部 0 分 → 兜底该 folder 首个 box。
 *
 * 五轮原型(v1~v5)全量验证后,本版(v6)新增:boxW 分类去重(修大箱权重虚高)、
 * 边亲和优先(修家族签名被污染)、核心更长平局(修 jet)。最终 0 unmatched、
 * 0 错误兜底、max_stack=2,与游戏直观布局一致(见 CHANGELOG 0.2.8)。
 */
const GUI_REFW = 1400
const GUI_REFH = 1275
const GUI_DEFAULT_SLOT = 70
/** 名字分层时剔除的噪声词(等级/年代/体系前缀,不参与核心匹配) */
const GUI_NOISE = new Set(['iw', 'bba', 'early', 'interwar', 'basic', 'improved', 'advanced', 'modern', 'tech', 'gw', 'gwtank', 'experimental', 'jet'])

/** 坐标轴模式:true=轴交换(文件 position.y=年份索引 → 画布 X、position.x=分支列 → 画布 Y)。
 * 依据 countrytechtreeview.gui 各 folder 的年份标签方向:年份标签【横排】→ 年份沿画布横轴走 → 交换;
 * 年份标签【竖排】→ 年份仍沿画布竖轴走 → 不交换。
 * 0.2.9 修正:装甲/装甲NSB/火炮/空军/空军BBA/工业/电子 的年份标签为竖排,此前被无条件轴交换画歪;
 * 步兵/支援/海军/海军MTG/海军支援(MTG) 年份标签为横排,维持交换(用户实测已对,不得反转)。 */
const SWAP_AXIS_FOLDERS = new Set([
  'infantry_folder', 'support_folder', 'naval_folder', 'mtgnavalfolder', 'mtgnavalsupportfolder',
])

function guiNum(doc: Document, b: Block | undefined, key: string, ref: number): number | undefined {
  const v = b ? childValue(doc, b, key) : undefined
  if (v === undefined) return undefined
  const s = v.trim()
  if (s.endsWith('%')) {
    const f = parseFloat(s)
    return Number.isFinite(f) ? Math.round((f / 100) * ref) : undefined
  }
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

/** 读 interface/countrytechtreeview.gui:递归找 name 以 folder 结尾的容器,
 *  收集其内全部 gridboxtype(原点 + slotsize)。多 root 后加载者覆盖(模组语义)。 */
function readTechLayout(roots: TechRoot[]): TechLayoutFolder[] {
  const byId = new Map<string, TechLayoutFolder>()
  for (const r of roots) {
    const abs = join(r.path, 'interface', 'countrytechtreeview.gui')
    let doc: Document
    try {
      doc = parse(readFileSync(abs, 'utf8'))
    } catch {
      continue
    }
    const scan = (b: Block): void => {
      for (const e of b.entries) {
        if (!e.block) continue
        const nm = childValue(doc, e.block, 'name')
        if (nm && nm.endsWith('folder')) {
          const gbs: TechLayoutGridbox[] = []
          const gscan = (gb: Block): void => {
            for (const ge of gb.entries) {
              if (!ge.block) continue
              const gn = childValue(doc, ge.block, 'name')
              if (gn && gn.endsWith('_tree')) {
                const pos = childBlock(doc, ge.block, 'position')
                const ss = childBlock(doc, ge.block, 'slotsize')
                gbs.push({
                  name: gn,
                  x: guiNum(doc, pos, 'x', GUI_REFW) ?? 0,
                  y: guiNum(doc, pos, 'y', GUI_REFH) ?? 0,
                  slotW: guiNum(doc, ss, 'width', GUI_REFW) ?? GUI_DEFAULT_SLOT,
                  slotH: guiNum(doc, ss, 'height', GUI_REFH) ?? GUI_DEFAULT_SLOT,
                })
              }
              gscan(ge.block)
            }
          }
          gscan(e.block)
          const fpos = childBlock(doc, e.block, 'position')
          byId.set(nm, {
            id: nm,
            posX: guiNum(doc, fpos, 'x', GUI_REFW) ?? 0,
            posY: guiNum(doc, fpos, 'y', GUI_REFH) ?? 0,
            gridboxes: gbs,
          })
        } else {
          scan(e.block)
        }
      }
    }
    scan(doc.root)
  }
  return [...byId.values()]
}

/** 去噪声核心:剔 NOISE 词与纯数字 token,再去尾部数字(供 60 档子串比较与平局取长) */
function guiNormCore(id: string): string {
  return id
    .split('_')
    .filter((t) => t && !GUI_NOISE.has(t) && !/^\d+$/.test(t))
    .join('_')
    .replace(/\d+$/, '')
}

/** 名字分层打分(见 assignGridboxes 注释) */
function guiNameScore(techId: string, stem: string): number {
  if (techId === stem) return 100
  if (techId.startsWith(stem + '_')) return 90
  if (techId.startsWith(stem)) return 80
  const s2 = stem.replace(/\d+$/, '')
  if (s2 !== stem && techId.startsWith(s2)) return 85
  const c1 = guiNormCore(techId)
  const c2 = guiNormCore(stem)
  if (c1 && c2 && c1 === c2) return 60
  return 0
}

/** 给每个科技算 gui 归属(gridbox 名)与像素坐标,写入 n.gb / n.px。 */
function assignGridboxes(g: TechGraph): void {
  const layout = new Map<string, TechLayoutFolder>()
  for (const lf of g.layout) layout.set(lf.id, lf)
  // folder → 科技 id(按载入序)
  const byFolder = new Map<string, string[]>()
  for (const n of g.nodes.values()) {
    for (const f of folderKeysOf(n)) {
      const arr = byFolder.get(f)
      if (arr) arr.push(n.id)
      else byFolder.set(f, [n.id])
    }
  }
  // 邻接表(leads/enable 双向),供边亲和
  const adj = new Map<string, Set<string>>()
  for (const e of g.edges) {
    let a = adj.get(e.from)
    if (!a) { a = new Set(); adj.set(e.from, a) }
    a.add(e.to)
    let b = adj.get(e.to)
    if (!b) { b = new Set(); adj.set(e.to, b) }
    b.add(e.from)
  }

  for (const [fid, ids] of byFolder) {
    const lf = layout.get(fid)
    if (!lf || !lf.gridboxes.length) {
      // 无 gui 布局的 folder(含自动补位科技):70×70 兜底网格
      for (const id of ids) {
        const n = g.nodes.get(id)!
        const p = posInFolder(n, fid)
        const px = n.px ?? {}
        px[fid] = { x: p.y * GUI_DEFAULT_SLOT, y: p.x * GUI_DEFAULT_SLOT }
        n.px = px
      }
      continue
    }
    const boxes = lf.gridboxes
    const stems = boxes.map((b) => b.name.replace(/_tree$/, ''))
    // ① 名字匹配(≥60 归属;平局取去数字核心更长)
    const boxTechs: string[][] = boxes.map(() => [])
    const named = new Set<string>()
    for (const id of ids) {
      let bi = -1
      let bs = 0
      let bc = ''
      boxes.forEach((box, i) => {
        const s = guiNameScore(id, stems[i])
        const c = guiNormCore(stems[i])
        if (s > bs || (s === bs && s > 0 && c.length > bc.length)) { bi = i; bs = s; bc = c }
      })
      if (bs >= 60) {
        named.add(id)
        boxTechs[bi].push(id)
      }
    }
    // 各 box 名字匹配成员的分类并集(按分类去重:非 mio 1.0 / mio 0.25)
    const boxW: Map<string, number>[] = boxes.map(() => new Map())
    boxTechs.forEach((mem, i) => {
      for (const id of mem) {
        for (const c of g.nodes.get(id)!.categories ?? []) {
          const nv = c.startsWith('mio_') ? 0.25 : 1
          const w = boxW[i]
          if (nv > (w.get(c) ?? 0)) w.set(c, nv)
        }
      }
    })
    // ② 名字未命中的科技:边亲和优先 → 家族回退
    for (const id of ids) {
      if (named.has(id)) continue
      const n = g.nodes.get(id)!
      const nd = adj.get(id)
      const edgeBoxes: number[] = []
      if (nd) {
        boxes.forEach((_, i) => {
          if (boxTechs[i].some((m) => nd!.has(m))) edgeBoxes.push(i)
        })
      }
      if (edgeBoxes.length === 1) {
        boxTechs[edgeBoxes[0]].push(id)
        continue
      }
      const cat = n.categories ?? []
      const mio = cat.filter((c) => c.startsWith('mio_'))
      const nonMio = cat.filter((c) => !c.startsWith('mio_'))
      const use = nonMio.length ? nonMio : mio
      if (!use.length) {
        boxTechs[0].push(id)
        continue
      }
      let bi = -1
      let bsc = -1
      let bc = ''
      boxes.forEach((_, i) => {
        if (!boxTechs[i].length) return
        let sc = 0
        const w = boxW[i]
        for (const c of use) sc += w.get(c) ?? 0
        if (sc <= 0) return
        if (nd) {
          let e = 0
          for (const m of boxTechs[i]) if (nd.has(m)) e++
          sc += e * 0.5
        }
        const c = guiNormCore(stems[i])
        if (sc > bsc || (sc === bsc && c.length > bc.length)) { bi = i; bsc = sc; bc = c }
      })
      if (bi < 0) bi = 0
      boxTechs[bi].push(id)
    }
    // ③ 写回像素坐标 + gridbox 名(轴方向按 folder 年份标签方向定,见 SWAP_AXIS_FOLDERS)
    const axisSwap = SWAP_AXIS_FOLDERS.has(fid)
    boxTechs.forEach((mem, i) => {
      for (const id of mem) {
        const n = g.nodes.get(id)!
        const p = posInFolder(n, fid)
        const b = boxes[i]
        const px = n.px ?? {}
        px[fid] = axisSwap
          ? { x: b.x + p.y * b.slotW, y: b.y + p.x * b.slotH }
          : { x: b.x + p.x * b.slotW, y: b.y + p.y * b.slotH }
        n.px = px
        const gbm = n.gb ?? {}
        gbm[fid] = stems[i]
        n.gb = gbm
      }
    })
  }
}

/**
 * ★ 给【没写 folder.position】的科技补网格位(横纵向分布修正)。
 *
 * 为什么要补:游戏里每个科技都占科技树的一格,坐标写在 folder.position。
 * 但实测 552 个科技中有 141 个【没写】(隐藏科技、CV 模组科技、只声明 path 的)。
 * 忠实解析的结果是 x=y=0 —— 直接渲染这 141 个会全部叠在原点,
 * 看上去就是"横纵坐标分布错了"。
 *
 * ⚠ v2 修正(实测发现的三个坑):
 *   ① 【不能排成单列】旧版把同一 folder 的未声明科技全部塞进 x=0 一列、
 *      y 顺延 —— `(无)` folder 那 141 个直接拉出 y=0~140 的长条,
 *      画布纵向被撑到 140 格而其余 folder 只有 20 格,观感就是"纵向分布错误"。
 *      v2 改为**按首个 category 聚簇 + 每簇多列网格**。
 *   ② 【不能只按 folder 分组】无 folder 的 141 个里,73 个连 categories 都没有,
 *      剩下的是 MIO/装备模块类(armor / naval_air / rocketry …)。
 *      按 category 聚簇后每簇独立成行,簇内 5 列,纵向只有 ~(141/5+簇数) ≈ 40 格。
 *   ③ 【不能压到已声明坐标上】簇的起点 y 取该 folder 已声明科技的最大 y + 2,
 *      并逐格探测空位,撞了就继续往下。
 *
 * 规则(尽量贴近游戏的行列网格):
 *   ① 显式写了坐标的【一个都不动】—— 与游戏一致是最高优先级。
 *      ⚠ 同 folder 同坐标重叠(实测 58 组,如 naval_folder@0,1 有 4 个科技)
 *      是【真实的互斥/DLC 替代数据】,不是 bug,保持原样,由前端错位显示并标注。
 *   ② 未声明的按「首个 category」聚簇;无 category 的归到 '(无领域)' 簇。
 *   ③ 每簇内按 5 列网格从左到右、从上到下填充;簇与簇之间纵向留 1 行空隙。
 *   ④ 起点 y = 该 folder 已声明科技的最大 y + 2;撞坐标则整簇下移。
 */
function autoLayoutPositions(g: TechGraph): void {
  /** folder → 已占用的坐标 key */
  const taken = new Map<string, Set<string>>()
  /** folder → 已声明科技的最大 y */
  const maxY = new Map<string, number>()
  /** folder → 未声明科技 */
  const buckets = new Map<string, TechNode[]>()

  // ★★ 全局已占坐标:【所有 folder 显式声明的格子】。
  // 自动补位的科技必须避开这些 —— 否则会撞到别的 folder 的真实科技上。
  // (实测踩坑:只按自己 folder 探测,141 个无 folder 的科技会精准压在
  //  bba_air_techs_folder@(0,2) 的 7 条真实科技上 → 像素重叠 1310 处。)
  const globalTaken = new Set<string>()

  for (const n of g.nodes.values()) {
    const key = n.folder ?? ''
    if (!taken.has(key)) taken.set(key, new Set())
    if (n.posDeclared) {
      taken.get(key)!.add(`${n.x},${n.y}`)
      globalTaken.add(`${key}|${n.x},${n.y}`)
      const cur = maxY.get(key)
      if (cur === undefined || n.y > cur) maxY.set(key, n.y)
      // 多 folder:非主 folder 的声明坐标也计入全局占用,避免补位科技撞上
      for (const f of folderKeysOf(n)) {
        const p = posInFolder(n, f)
        globalTaken.add(`${f}|${p.x},${p.y}`)
      }
    } else {
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(n)
    }
  }

  const COLS = 5
  for (const [key, list] of buckets) {
    const used = taken.get(key)!
    // ① 按首个 category 聚簇(同簇的科技在游戏里是同一领域,排一起更易读)
    const clusters = new Map<string, TechNode[]>()
    for (const n of list) {
      const ck = n.categories?.[0] ?? '(无领域)'
      if (!clusters.has(ck)) clusters.set(ck, [])
      clusters.get(ck)!.push(n)
    }
    // ② 起点:该 folder 已声明科技的最下方 + 2 行(留空隙)
    let baseY = (maxY.get(key) ?? -1) + 2
    /** 该格是否被【任意】folder 占用 */
    const busy = (cx: number, cy: number) => used.has(`${cx},${cy}`) || globalTaken.has(`${cx},${cy}`)

    for (const [, items] of clusters) {
      // ③ 簇内 5 列网格填充,逐格探测空位(既避开本 folder,也避开所有 folder)
      items.forEach((n, i) => {
        const cx = i % COLS
        let cy = baseY + Math.floor(i / COLS)
        let g2 = 0
        while (busy(cx, cy) && g2++ < 6000) cy++
        n.x = cx
        n.y = cy
        used.add(`${cx},${cy}`)
        globalTaken.add(`${key}|${cx},${cy}`)
      })
      // 下一簇从本簇底部再空一行开始
      baseY += Math.ceil(items.length / COLS) + 1
    }
  }
}
