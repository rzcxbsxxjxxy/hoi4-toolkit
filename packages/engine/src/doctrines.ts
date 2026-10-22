/**
 * 学说系统模型(common/doctrines)。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四层结构(官方 _documentation.md 的定义,实测 vanilla 完全吻合)
 * ══════════════════════════════════════════════════════════════════
 *   Folder(页签,land/naval/air/special_forces)
 *     └─ Grand Doctrine(互斥根,用 XP 解锁)
 *          └─ Track(轨道/槽位,含 mastery 规则)
 *               └─ Subdoctrine(可插入该槽位的根)
 *                    └─ Mastery(槽内进度 → 加成)
 *                         └─ Reward(挂在某个 subdoctrine 上的奖励)
 *
 *   文件分布:
 *     folders/doctrine_folders.txt              → Folder      (4 个,带 ledger / DLC 门控)
 *     grand_doctrines/*_grand_doctrines.txt     → Grand Doctrine(12 个)
 *     tracks/*_doctrine_tracks.txt              → Track       (14 个)
 *     subdoctrines/{land,sea,air,special_forces}/*.txt → Subdoctrine
 *
 * ── 两个必须注意的解析细节(实测踩过)──
 *  ① milestones 是【无名块列表】:
 *       milestones = { { a=1 b=2 } { a=3 } ... }
 *     在 AST 里表现为 key=-1 / value=-1 且带 block。不能按 key 取,
 *     要按 block.entries 的顺序读。
 *  ② subdoctrine 的 rewards 是【具名块】:
 *       rewards = { cavalry_charge = { ... } combined_arms_planning = { ... } }
 *     每个 reward id 本身就是键。
 *
 * ── ★ 第三种形态:track 可以是【块】(实测踩过,一开始误判成 bug)──
 *   特种部队的 8 个 subdoctrine 写的是:
 *       track = { special_forces_first special_forces_second }
 *   即"同时属于两个轨道"(可解锁第二轨道后两条都用)。
 *   而且它们【自带 mastery 覆盖轨道】:
 *       mountaineers_1 = { track = {...}  mastery = { multiplier=6
 *                         categories = { category_mountaineers } } }
 *   文件注释写明:"SF mastery is sourced per-subdoctrine...the subdoctrine
 *   override replaces these track conditions" —— 所以特种部队的最终加成
 *   要看 subdoctrine 自己的 mastery,不是 track 的。
 *   ⚠ 所以 track 字段必须支持"标量或块"两种写法,mastery 也要两边都抽。
 *
 * ── ★ xor 字段:同一 track 内的互斥关系 ──
 *   特种部队用 `xor = { mountaineers_2 }` 显式声明互斥,
 *   其余 folder 靠"同 track 即互斥"。两种都要记,前端才画得出互斥线。
 *
 * ── Track 没有"归属 folder"字段 ──
 *   tracks/land_doctrine_tracks.txt 里的 infantry 属于哪个 folder,
 *   是靠 grand_doctrines 的 `tracks = { infantry combat_support ... }`
 *   反推的(实测每个 track 恰好被一个 grand doctrine 引用)。
 *   ⚠ 所以解析顺序必须是:先读 grand_doctrines 拿到 track→folder 映射,
 *   再读 tracks/ 补细节。否则 tracks 全是孤儿。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

export interface DocRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/* ── 类型 ── */

/* ══════════════════════════════════════════════════════════════════
 * ★★★ DOCTRINE_CN_V2:三层展示结构 + 中文映射
 *
 * 数据本身已经是 folder → grand → track → sub 四层(见文件头),
 * 但【展示】不该按四层树展开 —— 用户看游戏里的学说界面是三层:
 *
 *   类别(陆/海/空/特种)
 *     └─ 主要学说(互斥根,XP 解锁)陆军 4 个 / 海军 ? 个
 *          └─ 分支(track 槽位)步兵 / 炮兵战斗支援 / 装甲 / 作战
 *
 * 关键事实(实测 vanilla 全部吻合):
 *   **同一个 folder 下,所有主要学说共享同一组分支**。
 *   land 的 4 个主要学说(new_mobile_warfare / superior_firepower /
 *   grand_battleplan / mass_assault)都写
 *       tracks = { infantry  combat_support  armor  operations }
 *   所以"分支"是【folder 级】实体,不是主要学说的子节点。
 *   —— 之前按四层树渲染,把 4 个主要学说各挂一份相同的分支,
 *      等于把同样的内容重复四遍,正是"没必要对主要学说展开次要学说"的意思。
 *
 * 因此正确的信息架构是:
 *   category(类别)  →  branch(分支,folder 级唯一)  →  subdoctrine(分支学说)
 *                        grand(主要学说)只作为【互斥根的清单】单独一栏,
 *                        选中某个主要学说 = 在同一组分支上换一套 root。
 * ══════════════════════════════════════════════════════════════════ */

/** 类别(页签)中文名 */
export const FOLDER_CN: Record<string, string> = {
  land: '陆军',
  naval: '海军',
  air: '空军',
  special_forces: '特种部队',
}

/** 类别简称(紧凑标签用) */
export const FOLDER_CN_SHORT: Record<string, string> = {
  land: '陆',
  naval: '海',
  air: '空',
  special_forces: '特',
}

/**
 * 分支(track)中文名。
 * ⚠ 只覆盖 vanilla 全部 14 个 track;模组新增的 track 会回退到本地化,
 *   都没有时显示 id(不猜、不瞎翻)。
 */
export const TRACK_CN: Record<string, string> = {
  // ── 陆军(本地化原文:Infantry / Artillery & Combat Support / Armor / Operations)
  infantry: '步兵',
  combat_support: '炮兵战斗支援',
  armor: '装甲',
  operations: '作战',
  // ── 海军(Capital Ships / Carriers / Screens / Submarines)
  capital_ships: '主力舰',
  carriers: '航空母舰',
  screens: '护航',
  submarines: '潜艇',
  // ── 空军(Fighter / Strike / Medium / Heavy Aircraft)
  fighter_aircraft: '战斗机',
  strike_aircraft: '攻击机',
  medium_aircraft: '中型飞机',
  heavy_aircraft: '重型飞机',
  // ── 特种部队(Special Forces;两个轨道共用同一个 loc 键)
  special_forces_first: '特种部队',
  special_forces_second: '特种部队',
}

/** 主要学说(grand doctrine)中文名 */
export const GRAND_CN: Record<string, string> = {
  // ── 陆军(Mobile Warfare / Superior Firepower / Grand Battleplan / Mass Assault)
  new_mobile_warfare: '机动作战',
  superior_firepower: '火力优势',
  grand_battleplan: '大计划',
  mass_assault: '密集突击',
  // ── 海军(Fleet in Being / Trade Interdiction / Base Strike)
  //   ⚠ new_convoy_raiding 的本地化原文是 "Trade Interdiction"(贸易封锁),
  //   不是 id 字面的"护航突击"——按 id 直译会误导。
  new_fleet_in_being: '既存舰队',
  new_convoy_raiding: '贸易封锁',
  new_base_strike: '基地打击',
  // ── 空军(Strategic Destruction / Battlefield Support / Operational Integrity)
  new_strategic_destruction: '战略打击',
  new_battlefield_support: '战场支援',
  new_operational_integrity: '作战完整性',
  // ── 特种部队(Expanded / Elite Special Forces)
  special_forces_quantity: '扩编特种部队',
  special_forces_quality: '精英特种部队',
}

/** 分支 → 该分支下可选的次要学说数(前端提示用;运行时统计,勿硬编码) */
export function trackLabelCn (t: { id: string; loc?: string }): string {
  return TRACK_CN[t.id] ?? (t.loc && t.loc !== t.id ? t.loc : t.id)
}

export interface DoctrineFolder {
  id: string
  /** 本地化键,如 land_doctrine_folder */
  loc?: string
  /** ledger = army / air / navy */
  ledger?: string
  ledgerGfx?: string
  tabGfx?: string
  colorFrame?: number
  sound?: string
  /** 带 allowed 条件(DLC 门控) */
  dlcGated: boolean
  /** 该 folder 下的 has_dlc 值 */
  hasDlc: string[]
  file: string
  line: number
  root: number
}

export interface GrandDoctrine {
  id: string
  folder: string
  loc?: string
  descLoc?: string
  icon?: string
  xpCost: number
  xpType: string
  /** 声明的 track id 列表(顺序有意义) */
  tracks: string[]
  /** milestones = { {...} {...} } —— 无名块,按顺序 */
  milestones: { index: number; keys: string[]; effect?: Record<string, string> }[]
  /** 顶层直接写的效果键(不在任何子块里的叶子) */
  effects: Record<string, string>
  /** 有 available 条件 */
  gated: boolean
  file: string
  line: number
  root: number
}

export interface DoctrineTrack {
  id: string
  /** 由 grand_doctrines 反推的所属 folder */
  folder: string
  loc?: string
  icon?: string
  background?: string
  iconFrame?: string
  /** mastery.multiplier */
  masteryMultiplier?: number
  /** mastery.categories —— 加成作用的目标类别 */
  masteryCategories: string[]
  /** mastery.sub_units */
  masterySubUnits: string[]
  file: string
  line: number
  root: number
}

export interface Subdoctrine {
  id: string
  /** 挂在哪些 track 上(实测最多 2 个:special_forces 走块写法) */
  tracks: string[]
  /** 主 track(tracks[0]),布局与筛选用 */
  track: string
  /** 由 track 反推的 folder */
  folder: string
  loc?: string
  descLoc?: string
  icon?: string
  xpCost: number
  xpType: string
  /** rewards = { reward_id = { ... } } */
  rewards: { id: string; keys: string[] }[]
  /** xor = { 其它 subdoctrine } —— 显式互斥 */
  xor: string[]
  /** ★ 自带 mastery(特种部队用来覆盖 track 的 mastery) */
  mastery?: { multiplier?: number; categories: string[]; subUnits: string[] }
  /** 顶层效果(enable_tactic / category_xxx = { ... }) */
  effects: Record<string, string>
  /** effect = { add_tech_bonus = ... } 这类脚本块的存在标记 */
  hasEffectScript: boolean
  hasAiWillDo: boolean
  gated: boolean
  hasDlc: string[]
  file: string
  line: number
  root: number
}

export interface DoctrineGraph {
  roots: DocRoot[]
  folders: Map<string, DoctrineFolder>
  folderOrder: string[]
  grand: Map<string, GrandDoctrine>
  tracks: Map<string, DoctrineTrack>
  subdoctrines: Map<string, Subdoctrine>
  /** subdoctrine id → 同 track 内的其它候选(互斥关系) */
  siblings: Map<string, string[]>
  /**
   * ★ OWNERSHIP_V1:doctrine 各层 id(folder / grand / track / subdoctrine)
   *   → 全部定义现场(按载入序)。
   *   游戏语义是同名【后者整份替换前者】,旧代码却是"先出现的赢"
   *   (`if (g.folders.has(k)) continue`),模组改学说根本不生效。
   */
  versions: Map<string, { root: number; file: string; line: number }[]>
  /** 诊断 */
  issues: {
    kind: 'orphanTrack' | 'unknownTrack' | 'unknownFolder' | 'noGrandDoctrine' | 'noSubdoctrine'
    id: string
    detail: string
    file?: string
    line?: number
  }[]
  ms: number
}

/* ── 工具 ── */

function walk(dir: string): string[] {
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
    if (st.isDirectory()) out.push(...walk(p))
    else if (it.toLowerCase().endsWith('.txt')) out.push(p)
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
function bareValues(doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) if (e.key < 0 && e.value >= 0) out.push(valueText(doc, e) ?? '')
  return out.filter(Boolean)
}
function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : undefined
}
function unq(s: string | undefined): string | undefined {
  if (!s) return undefined
  const v = s.trim().replace(/^"|"$/g, '')
  return v || undefined
}
function collectHasDlc(doc: Document, b: Block, into: Set<string>): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (k && k.toLowerCase() === 'has_dlc' && e.value >= 0) {
      const v = unq(valueText(doc, e))
      if (v) into.add(v)
    }
    if (e.block) collectHasDlc(doc, e.block, into)
  }
}
/**
 * 收集"顶层直接写的效果键" —— 即不在任何子块里、也不在白名单里的叶子赋值。
 * 学说的效果是 `planning_speed = 0.2` 这种散在顶层的裸键,没有统一容器,
 * 所以只能靠"排除已知结构键"来反推。
 */
const STRUCT_KEYS = new Set([
  'folder', 'name', 'description', 'icon', 'xp_cost', 'xp_type', 'available',
  'ai_will_do', 'tracks', 'milestones', 'rewards', 'track', 'effect',
  'mastery', 'background', 'icon_frame', 'allowed', 'ledger', 'ledger_gfx',
  'tab_gfx', 'color_frame', 'sound', 'keep', 'group', 'active', 'visible',
  'xor', // ★ 特种部队的显式互斥声明 —— 不是效果
])
function topEffects(doc: Document, b: Block): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k || e.block) continue
    if (STRUCT_KEYS.has(k.toLowerCase())) continue
    const v = valueText(doc, e)
    if (v !== undefined) out[k] = v
  }
  return out
}
/**
 * 读一个「标量或块皆可」的字段,统一返回字符串列表。
 * ★ 必需:实测 subdoctrine 的 track 字段有两种写法 ——
 *   常规:  track = infantry                              (标量)
 *   特种:  track = { special_forces_first special_forces_second }  (块)
 * 只按标量读会把 8 个特种部队 subdoctrine 全部判成"无归属"。
 */
function scalarOrBlock(doc: Document, b: Block, key: string): string[] {
  const lk = key.toLowerCase()
  for (const e of b.entries) {
    if (keyText(doc, e)?.toLowerCase() !== lk) continue
    if (e.block) return bareValues(doc, e.block)
    const v = valueText(doc, e)
    return v ? [v.trim()] : []
  }
  return []
}
/** 抽 mastery = { multiplier categories sub_units } */
function readMastery(doc: Document, b: Block): Subdoctrine['mastery'] {
  const mb = childBlock(doc, b, 'mastery')
  if (!mb) return undefined
  const cats = childBlock(doc, mb, 'categories')
  const subs = childBlock(doc, mb, 'sub_units')
  return {
    multiplier: num(childValue(doc, mb, 'multiplier')),
    categories: cats ? bareValues(doc, cats) : [],
    subUnits: subs ? bareValues(doc, subs) : [],
  }
}
/**
 * 判「有没有真正的可用性条件」——同 dlc.ts 的口径。
 * ⚠ 实测 12 个 grand doctrine 全都写了 `available = { always = yes }`,
 *   按"块存在"判会得到 12/12 全有条件,等于没标。这里排除 always/never。
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
/** 块里所有叶子键名(用于 rewards / milestones 的效果清单) */
function leafKeys(doc: Document, b: Block, depth = 0): string[] {
  const out: string[] = []
  if (depth > 2) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (e.block) out.push(...leafKeys(doc, e.block, depth + 1))
    else out.push(k)
  }
  return out
}
function blockScalars(doc: Document, b: Block, depth = 0): Record<string, string> {
  const out: Record<string, string> = {}
  if (depth > 2) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (e.block) {
      if (/^(effect|available|allowed|visible|trigger)$/i.test(k)) continue
      Object.assign(out, blockScalars(doc, e.block, depth + 1))
    } else {
      const v = valueText(doc, e)
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

/* ── 主构建 ── */

export function buildDoctrineGraph(roots: DocRoot[]): DoctrineGraph {
  const t0 = Date.now()
  const g: DoctrineGraph = {
    roots,
    folders: new Map(),
    folderOrder: [],
    grand: new Map(),
    tracks: new Map(),
    subdoctrines: new Map(),
    siblings: new Map(),
    versions: new Map(),
    issues: [],
    ms: 0,
  }
  /** 记录某 id 的一次定义现场(供归属三态判定) */
  const chain = (k: string, ri: number, file: string, line: number): void => {
    const a = g.versions.get(k) ?? []
    a.push({ root: ri, file, line })
    g.versions.set(k, a)
  }

  const base = join(roots[0]?.path ?? '', 'common', 'doctrines')
  const empty = { roots, folders: g.folders, folderOrder: g.folderOrder, grand: g.grand, tracks: g.tracks, subdoctrines: g.subdoctrines, siblings: g.siblings, issues: g.issues, ms: 0 }
  void empty
  if (!roots.length) {
    g.ms = Date.now() - t0
    return g
  }

  /* ① folders */
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'doctrines', 'folders'))) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block || k.startsWith('@')) continue
        const b = e.block
        // ★ OWNERSHIP_V1:同名 folder 由后加载的模组整份替换(原来是 `continue` 跳过)
        chain(k, ri, file, lineOf(doc, e))
        if (!g.folders.has(k)) g.folderOrder.push(k)
        const hd = new Set<string>()
        collectHasDlc(doc, b, hd)
        g.folders.set(k, {
          id: k,
          loc: unq(childValue(doc, b, 'name')),
          ledger: unq(childValue(doc, b, 'ledger')),
          ledgerGfx: unq(childValue(doc, b, 'ledger_gfx')),
          tabGfx: unq(childValue(doc, b, 'tab_gfx')),
          colorFrame: num(childValue(doc, b, 'color_frame')),
          sound: unq(childValue(doc, b, 'sound')),
          // ⚠ 判据是「allowed 块里有没有 has_dlc」,不是「有没有 allowed 块」。
          //   实测 4 个 folder 全都写了 allowed,但 land/naval/air 里是
          //   `always = yes`(无条件),只有 special_forces 才是真 DLC 门控。
          //   早先按"有 allowed 块"判会得到 4/4 全门控 —— 错的。
          dlcGated: hd.size > 0,
          hasDlc: [...hd],
          file,
          line: lineOf(doc, e),
          root: ri,
        })
      }
    }
  })

  /* ② grand_doctrines —— 必须先读,靠它的 tracks 列表建立 track→folder 映射 */
  const trackFolder = new Map<string, string>()
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'doctrines', 'grand_doctrines'))) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block || k.startsWith('@')) continue
        const b = e.block
        const folder = childValue(doc, b, 'folder') ?? ''
        if (folder && g.folders.size && !g.folders.has(folder)) {
          g.issues.push({
            kind: 'unknownFolder',
            id: k,
            detail: `grand doctrine 引用了未声明的 folder「${folder}」`,
            file,
            line: lineOf(doc, e),
          })
        }
        const tb = childBlock(doc, b, 'tracks')
        const tracks = tb ? bareValues(doc, tb) : []
        for (const t of tracks) {
          if (!trackFolder.has(t)) trackFolder.set(t, folder)
        }
        // milestones 是无名块列表:key=-1 且带 block
        const milestones: GrandDoctrine['milestones'] = []
        const mb = childBlock(doc, b, 'milestones')
        if (mb) {
          mb.entries.forEach((x, i) => {
            if (!x.block) return
            milestones.push({
              index: i,
              keys: leafKeys(doc, x.block),
              effect: blockScalars(doc, childBlock(doc, x.block, 'effect') ?? x.block),
            })
          })
        }
        // ★ OWNERSHIP_V1:同名 grand doctrine 由后加载的模组整份替换(原来是 `continue`)
        chain(k, ri, file, lineOf(doc, e))
        g.grand.set(k, {
          id: k,
          folder,
          loc: unq(childValue(doc, b, 'name')),
          descLoc: unq(childValue(doc, b, 'description')),
          icon: unq(childValue(doc, b, 'icon')),
          xpCost: num(childValue(doc, b, 'xp_cost')) ?? 0,
          xpType: childValue(doc, b, 'xp_type') ?? '',
          tracks,
          milestones,
          effects: topEffects(doc, b),
          gated: hasRealGate(doc, b, ["available", "visible"]),
          file,
          line: lineOf(doc, e),
          root: ri,
        })
      }
    }
  })

  /* ③ tracks —— folder 由 ② 反推 */
  const seenTrack = new Set<string>()
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'doctrines', 'tracks'))) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block || k.startsWith('@')) continue
        const b = e.block
        // ★ OWNERSHIP_V1:同名 track 由后加载的模组整份替换(原来是 `continue`)。
        //   seenTrack 只用来抑制"重复声明"的诊断,不再阻止覆盖。
        const isRedeclare = seenTrack.has(k)
        if (!isRedeclare) seenTrack.add(k)
        chain(k, ri, file, lineOf(doc, e))
        const folder = trackFolder.get(k) ?? ''
        // 诊断只在首次声明时给出:同名重复声明本身就是"覆盖",不该重复报。
        if (!folder) {
          if (!isRedeclare) g.issues.push({
            kind: 'orphanTrack',
            id: k,
            detail: '没有任何 grand doctrine 通过 tracks 列表引用它,无法确定所属 folder',
            file,
            line: lineOf(doc, e),
          })
        } else if (g.folders.size && !g.folders.has(folder)) {
          if (!isRedeclare) g.issues.push({
            kind: 'unknownFolder',
            id: k,
            detail: `反推出的 folder「${folder}」未声明`,
            file,
            line: lineOf(doc, e),
          })
        }
        const ms = readMastery(doc, b)
        g.tracks.set(k, {
          id: k,
          folder,
          loc: unq(childValue(doc, b, 'name')),
          icon: unq(childValue(doc, b, 'icon')),
          background: unq(childValue(doc, b, 'background')),
          iconFrame: unq(childValue(doc, b, 'icon_frame')),
          masteryMultiplier: ms?.multiplier,
          masteryCategories: ms?.categories ?? [],
          masterySubUnits: ms?.subUnits ?? [],
          file,
          line: lineOf(doc, e),
          root: ri,
        })
      }
    }
  })
  // grand doctrine 引用了但 tracks/ 里没有定义的
  for (const gd of g.grand.values()) {
    for (const t of gd.tracks) {
      if (!g.tracks.has(t)) {
        g.issues.push({
          kind: 'unknownTrack',
          id: gd.id,
          detail: `引用了未定义的 track「${t}」`,
          file: gd.file,
          line: gd.line,
        })
      }
    }
  }

  /* ④ subdoctrines —— track 反查 folder */
  const trackToFolder = new Map<string, string>()
  for (const [tid, tr] of g.tracks) trackToFolder.set(tid, tr.folder)
  const byTrack = new Map<string, string[]>()
  roots.forEach((r, ri) => {
    for (const abs of walk(join(r.path, 'common', 'doctrines', 'subdoctrines'))) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block || k.startsWith('@')) continue
        const b = e.block
        // ★ track 可能是标量也可能是块(特种部队),两种都要吃
        const tracks = scalarOrBlock(doc, b, 'track')
        if (!tracks.length) {
          g.issues.push({
            kind: 'orphanTrack',
            id: k,
            detail: 'subdoctrine 缺少 track 字段,无法确定归属',
            file,
            line: lineOf(doc, e),
          })
        }
        for (const t of tracks) {
          if (!g.tracks.has(t)) {
            g.issues.push({
              kind: 'unknownTrack',
              id: k,
              detail: `引用了未定义的 track「${t}」`,
              file,
              line: lineOf(doc, e),
            })
          }
        }
        // rewards = { reward_id = { ... } } —— 具名块
        const rewards: Subdoctrine['rewards'] = []
        const rb = childBlock(doc, b, 'rewards')
        if (rb) {
          for (const re of rb.entries) {
            const rk = keyText(doc, re)
            if (!rk || !re.block) continue
            rewards.push({ id: rk, keys: leafKeys(doc, re.block) })
          }
        }
        const hd = new Set<string>()
        collectHasDlc(doc, b, hd)
        // ★ OWNERSHIP_V1:同名 subdoctrine 由后加载的模组整份替换(原来是 `if (!has)`)
        chain(k, ri, file, lineOf(doc, e))
        {
          // folder 取任一已知 track 的 folder(多 track 时它们应属同一 folder)
          const folder = tracks.map((t) => trackToFolder.get(t) ?? '').find(Boolean) ?? ''
          g.subdoctrines.set(k, {
            id: k,
            tracks,
            track: tracks[0] ?? '',
            folder,
            loc: unq(childValue(doc, b, 'name')),
            descLoc: unq(childValue(doc, b, 'description')),
            icon: unq(childValue(doc, b, 'icon')),
            xpCost: num(childValue(doc, b, 'xp_cost')) ?? 0,
            xpType: childValue(doc, b, 'xp_type') ?? '',
            rewards,
            xor: scalarOrBlock(doc, b, 'xor'),
            mastery: readMastery(doc, b),
            effects: topEffects(doc, b),
            hasEffectScript: childBlock(doc, b, 'effect') !== undefined,
            hasAiWillDo: childBlock(doc, b, 'ai_will_do') !== undefined,
            gated: hasRealGate(doc, b, ["available", "visible"]),
            hasDlc: [...hd],
            file,
            line: lineOf(doc, e),
            root: ri,
          })
        }
        // ★ 一个 subdoctrine 可挂多条轨道,每条都要登记互斥关系
        for (const track of tracks) {
          const l = byTrack.get(track) ?? []
          if (!l.includes(k)) l.push(k)
          byTrack.set(track, l)
        }
      }
    }
  })
  // siblings:同 track 的 subdoctrine 互斥
  for (const [tid, list] of byTrack) {
    for (const id of list) g.siblings.set(id, list.filter((x) => x !== id))
    if (!g.tracks.has(tid)) {
      g.issues.push({ kind: 'unknownTrack', id: tid, detail: '有 subdoctrine 挂在这个未定义的 track 上' })
    }
  }
  // 没有 grand doctrine 的 folder / 没有 subdoctrine 的 track
  for (const fid of g.folderOrder) {
    if (![...g.grand.values()].some((x) => x.folder === fid)) {
      g.issues.push({ kind: 'noGrandDoctrine', id: fid, detail: '该 folder 下没有任何 grand doctrine' })
    }
  }
  for (const [tid, tr] of g.tracks) {
    if (!byTrack.has(tid)) {
      g.issues.push({ kind: 'noSubdoctrine', id: tid, detail: '该 track 下没有任何 subdoctrine', file: tr.file, line: tr.line })
    }
  }

  g.ms = Date.now() - t0
  return g
}

/* ══════════════════════════════════════════════════════════════════
 * 坐标布局 —— 学说没有坐标字段,按「folder 列 → grand doctrine 行 →
 * track 列 → subdoctrine 行」生成网格。
 *
 * 参照 tech.ts 的 autoLayoutPositions 思路:
 *   ① 已声明的一律不动(学说是全部生成,所以只标注 declared=false)
 *   ② 同一父节点下按声明顺序排列,不重叠
 * ══════════════════════════════════════════════════════════════════ */
export interface DoctrineLayout {
  /** folder id → 列号 */
  folderCol: Map<string, number>
  /** grand id → { col, row } */
  grandPos: Map<string, { col: number; row: number }>
  /** track id → { col, row } */
  trackPos: Map<string, { col: number; row: number }>
  /** subdoctrine id → { col, row } */
  subPos: Map<string, { col: number; row: number }>
}

export function layoutDoctrines(g: DoctrineGraph): DoctrineLayout {
  const L: DoctrineLayout = {
    folderCol: new Map(),
    grandPos: new Map(),
    trackPos: new Map(),
    subPos: new Map(),
  }
  const COL_W = 300
  const TRACK_W = 190

  g.folderOrder.forEach((fid, ci) => {
    L.folderCol.set(fid, ci)
    const gds = [...g.grand.values()].filter((x) => x.folder === fid)
    gds.forEach((gd, ri) => {
      // grand doctrine 占一整行的左侧,tracks 从第 1 列开始横向铺
      L.grandPos.set(gd.id, { col: ci * 1000, row: ri })
      gd.tracks.forEach((tid, ti) => {
        const tr = g.tracks.get(tid)
        const trRow = tr ? Math.max(ri, ...[...L.trackPos.values()].filter((p) => p.col === ci * 1000 + ti * TRACK_W).map((p) => p.row), ri) : ri
        L.trackPos.set(tid, { col: ci * 1000 + ti * TRACK_W, row: trRow })
        const subs = [...g.subdoctrines.values()].filter((s) => s.track === tid)
        subs.forEach((s, si) => {
          L.subPos.set(s.id, { col: ci * 1000 + ti * TRACK_W, row: trRow + si + 1 })
        })
      })
    })
  })
  void COL_W
  return L
}
