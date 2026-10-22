/**
 * 单位与装备模型 —— 解析 common/units 下各类 txt,按文件组织单位/装备/要害/修正/命名池。
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计参照 characters.ts:两遍构建(先收集 defs 链,再组装文件与条目)。
 * 来源归属 OWNERSHIP_V1:文件级同【相对路径】整文件替换;条目级同【kind:id】后载入者胜。
 * ══════════════════════════════════════════════════════════════════
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import { ownOf, type OwnInfo, type DefSite } from './ownership.ts'

export type UnitKind = 'units' | 'equipment' | 'critical_parts' | 'unit_modifiers' | 'names'
export interface UnitsRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

export interface UnitEntry {
  id: string; line: number; file: string; root: number; base: boolean
  own: OwnInfo; stale: boolean; defs: DefSite[]
  kind: UnitKind
  fields: [string, string][]
  /* unit */
  abbreviation?: string; sprite?: string; mapIconCategory?: string; category?: string
  type?: string[]; group?: string; morphGroup?: string; categories?: string[]
  active?: string; priority?: number; aiPriority?: number; combatWidth?: number
  manpower?: number; maxStrength?: number; maxOrg?: number; defaultMorale?: number
  trainingTime?: number; suppression?: number; weight?: number; supplyConsumption?: number
  maxSpeed?: number; recon?: number
  need?: [string, number][]
  specialForces?: string; marines?: string; affectsSpeed?: string; regimental?: string; canBeParachuted?: string
  casualtyTrickleback?: number; experienceLossFactor?: number; supplyConsumptionFactor?: number
  criticalParts?: string[]; criticalPartDamageChanceMult?: number; hitProfileMult?: number
  terrain?: [string, [string, string][]][]
  /* equipment */
  year?: number; isArchetype?: string; archetype?: string; parent?: string
  isBuildable?: string; canBeProduced?: string
  picture?: string; folder?: string; equipName?: string
  equipType?: string; groupBy?: string; interfaceCategory?: string
  visualLevel?: number; buildCostIc?: number; powerCostAdd?: number
  resources?: [string, number][]
  reliability?: number; defense?: number; breakthrough?: number; hardness?: number; armorValue?: number
  softAttack?: number; hardAttack?: number; apAttack?: number; airAttack?: number
  lendLeaseCost?: number; maxSpeedEq?: number
  moduleSlots?: string[]; upgrades?: string[]
  /* critical_part */
  icon?: string; frame?: number; chance?: number
  /* names */
  poolParent?: string; prefix?: string; fallbackName?: string; poolType?: string
  forCountries?: string[]; genericCount?: number; uniqueCount?: number; orderedCount?: number
  /* unit Wiki补充 */
  cavalry?: string; canExfiltrateFromCoast?: string; mountaineers?: string; transport?: string
  essential?: string[]; attack?: number; entrenchment?: number; initiative?: number
  suppressionFactor?: number; reliabilityFactor?: number; movement?: number
  /* equipment Wiki补充 */
  canBeLendLeased?: string; isConvertable?: string; canLicense?: string; isFrame?: string
  maxMilitaryFactories?: number; maxDockyardFactories?: number
  navalSpeed?: number; fireRange?: number; lgArmorPiercing?: number; lgAttack?: number
  hgArmorPiercing?: number; hgAttack?: number; torpedoAttack?: number; antiAirAttack?: number
  shoreBombardment?: number; evasion?: number; surfaceDetection?: number; subAttack?: number
  subDetection?: number; surfaceVisibility?: number; subVisibility?: number; navalRange?: number
  portCapacityUsage?: number; searchAndDestroyCoordination?: number; convoyRaidingCoordination?: number
  airDefence?: number; airRange?: number; airAgility?: number; airGroundAttack?: number
  airBombing?: number; airSuperiority?: number; navalStrikeAttack?: number; navalStrikeTargetting?: number
  carrierSize?: number; defaultCarrierCompositionWeight?: number; carrierCapable?: string
  variantName?: string
}
export interface UnitFile {
  rel: string; group: string; kind: UnitKind
  root: number; rootName: string; base: boolean; own: OwnInfo; stale: boolean
  entries: UnitEntry[]
}
export interface UnitsModel {
  roots: UnitsRoot[]; files: UnitFile[]; defs: Map<string, DefSite[]>
  stats: { files: number; rawEntries: number; entries: number; overridden: number; modNew: number
           units: number; equipment: number; criticalParts: number; unitModifiers: number; namePools: number; ms: number }
}

/* ── 通用工具 ─────────────────────────────────────────────────────── */

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk && e.block) return e.block
  return undefined
}
function childValue(doc: Document, b: Block, key: string): string | undefined {
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk && e.value >= 0) return valueText(doc, e)
  return undefined
}
/** 数值解析失败(NaN)时保留原始字符串 */
function num(v: string | undefined): any {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isNaN(n) ? v : n
}
/** 块内裸 token 列表(无 key 的值) */
function bareTokens(doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) {
    if (e.key < 0 && e.value >= 0) {
      const v = valueText(doc, e)
      if (v !== undefined && v !== '') out.push(v)
    }
  }
  return out
}
/** 块内 k=v 叶子对(值转 number,失败保留字符串) */
function blockKV(doc: Document, b: Block): [string, number][] {
  const out: [string, number][] = []
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (k && e.value >= 0) {
      const v = valueText(doc, e)
      const n = Number(v)
      out.push([k, Number.isNaN(n) ? (v as any) : n])
    }
  }
  return out
}
/** 块内子块的 key 列表 */
function blockKeys(doc: Document, b: Block): string[] {
  const out: string[] = []
  for (const e of b.entries) {
    if (e.block) {
      const k = keyText(doc, e)
      if (k) out.push(k)
    }
  }
  return out
}

/** 块摘要:无 k=v 叶子时输出 {裸值数};否则输出 {k=v,..}(最多 3 对,超出 …) */
function blockSummary(doc: Document, b: Block): string {
  const pairs: string[] = []
  let bare = 0
  for (const e of b.entries) {
    if (e.block) { bare++; continue }
    const k = keyText(doc, e)
    if (k && e.value >= 0) pairs.push(k + '=' + (valueText(doc, e) ?? '').trim())
    else if (e.value >= 0) bare++
  }
  if (!pairs.length) return '{' + bare + '}'
  const shown = pairs.slice(0, 3).join(',')
  return '{' + (pairs.length > 3 ? shown + ',…' : shown) + '}'
}

/** fields 扁平化:深度≤2;叶子 [k,v];块 [k, {…}];裸 token [token, ""] */
function fieldsOf(doc: Document, b: Block): [string, string][] {
  const out: [string, string][] = []
  for (const e of b.entries) {
    if (e.block) {
      const k = keyText(doc, e)
      out.push([k ?? '', blockSummary(doc, e.block)])
    } else if (e.value >= 0) {
      const v = (valueText(doc, e) ?? '').trim()
      const k = keyText(doc, e)
      if (k) out.push([k, v])
      else out.push([v, ''])
    }
  }
  return out
}

/* ── group / kind 判定 ───────────────────────────────────────────── */

function groupOf(rel: string): { group: string; kind: UnitKind } {
  const PREFIX = 'common/units/'
  let sub = rel
  if (sub.startsWith(PREFIX)) sub = sub.slice(PREFIX.length)
  const first = sub.split('/')[0]
  if (first === 'equipment') return { group: 'equipment', kind: 'equipment' }
  if (first === 'critical_parts') return { group: 'critical_parts', kind: 'critical_parts' }
  if (first === 'unit_modifiers') return { group: 'unit_modifiers', kind: 'unit_modifiers' }
  if (first === 'names' || first === 'names_divisions' || first === 'names_railway_guns'
    || first === 'names_ships' || first === 'codenames_operatives') return { group: first, kind: 'names' }
  return { group: 'root', kind: 'units' }
}

/** 各 kind 的根容器 wrapper 键(找不到则退回 doc.root) */
const WRAPPERS: Record<string, string[]> = {
  units: ['sub_units'],
  equipment: ['equipments', 'upgrades', 'equipment_modules', 'modules'],
  critical_parts: ['critical_parts'],
}
function findContainer(doc: Document, kind: UnitKind): Block | undefined {
  const ws = WRAPPERS[kind]
  if (!ws) return undefined
  for (const e of doc.root.entries) {
    if (!e.block) continue
    const k = keyText(doc, e)
    if (k && ws.includes(k.toLowerCase())) return e.block
  }
  return undefined
}

/** names 池块叶子键集合(用于双形态判定) */
const POOL_LEAF_KEYS = new Set([
  'prefix', 'generic', 'unique', 'ordered', 'fallback_name',
  'name', 'for_countries', 'type', 'ship_types',
])
/** 直接子块内是否出现池叶子键 */
function childLooksLikePool(doc: Document, b: Block): boolean {
  for (const c of b.entries) {
    if (!c.block) continue
    for (const cc of c.block.entries) {
      const cck = keyText(doc, cc)
      if (cck && POOL_LEAF_KEYS.has(cck.toLowerCase())) return true
    }
  }
  return false
}

/* ── 递归遍历 ─────────────────────────────────────────────────────── */

function walk(dir: string, exts = ['.txt']): string[] {
  const out: string[] = []
  let items: string[] = []
  try { items = readdirSync(dir) } catch { return out }
  for (const it of items) {
    const p = join(dir, it)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

/* ── typed 字段提取 ─────────────────────────────────────────────── */

function extractTyped(doc: Document, b: Block, kind: UnitKind, e: UnitEntry, parentKey?: string): void {
  const cv = (key: string) => childValue(doc, b, key)
  const cn = (key: string) => num(cv(key))

  if (kind === 'units') {
    const tb = childBlock(doc, b, 'type'); if (tb) e.type = bareTokens(doc, tb)
    const cb = childBlock(doc, b, 'categories'); if (cb) e.categories = bareTokens(doc, cb)
    const cp = childBlock(doc, b, 'critical_parts'); if (cp) e.criticalParts = bareTokens(doc, cp)
    const nb = childBlock(doc, b, 'need'); if (nb) e.need = blockKV(doc, nb)
    e.abbreviation = cv('abbreviation'); e.sprite = cv('sprite')
    e.mapIconCategory = cv('map_icon_category'); e.category = cv('category')
    e.group = cv('group'); e.morphGroup = cv('morph_group')
    e.active = cv('active')
    e.priority = cn('priority'); e.aiPriority = cn('ai_priority')
    e.combatWidth = cn('combat_width'); e.manpower = cn('manpower')
    e.maxStrength = cn('max_strength'); e.maxOrg = cn('max_organisation')
    e.defaultMorale = cn('default_morale'); e.trainingTime = cn('training_time')
    e.suppression = cn('suppression'); e.weight = cn('weight')
    e.supplyConsumption = cn('supply_consumption'); e.maxSpeed = cn('maximum_speed')
    e.recon = cn('recon')
    e.specialForces = cv('special_forces'); e.marines = cv('marines')
    e.affectsSpeed = cv('affects_speed'); e.regimental = cv('regimental')
    e.canBeParachuted = cv('can_be_parachuted')
    e.casualtyTrickleback = cn('casualty_trickleback')
    e.experienceLossFactor = cn('experience_loss_factor')
    e.supplyConsumptionFactor = cn('supply_consumption_factor')
    e.criticalPartDamageChanceMult = cn('critical_part_damage_chance_mult')
    e.hitProfileMult = cn('hit_profile_mult')
    // 地形块:非已知元数据块且内层全为 k=v 叶子
    const KNOWN = new Set(['type', 'categories', 'need', 'critical_parts'])
    const terr: [string, [string, string][]][] = []
    for (const cb of b.entries) {
      if (!cb.block) continue
      const cbk = keyText(doc, cb)
      if (!cbk || KNOWN.has(cbk.toLowerCase())) continue
      const pairs: [string, string][] = []
      let allKV = true
      for (const inner of cb.block.entries) {
        if (inner.block) { allKV = false; break }
        const ik = keyText(doc, inner)
        if (ik && inner.value >= 0) pairs.push([ik, (valueText(doc, inner) ?? '').trim()])
      }
      if (allKV && pairs.length) terr.push([cbk, pairs])
    }
    if (terr.length) e.terrain = terr
        e.cavalry = cv('cavalry'); e.canExfiltrateFromCoast = cv('can_exfiltrate_from_coast')
    e.mountaineers = cv('mountaineers'); e.transport = cv('transport')
    const es = childBlock(doc, b, 'essential'); if (es) e.essential = bareTokens(doc, es)
    e.attack = cn('attack'); e.softAttack = cn('soft_attack'); e.hardAttack = cn('hard_attack')
    e.airAttack = cn('air_attack'); e.apAttack = cn('ap_attack'); e.breakthrough = cn('breakthrough')
    e.defense = cn('defense') ?? cn('defence')
    e.armorValue = cn('armor_value'); e.hardness = cn('hardness')
    e.entrenchment = cn('entrenchment'); e.initiative = cn('initiative')
    e.reliability = cn('reliability'); e.suppressionFactor = cn('suppression_factor')
    e.reliabilityFactor = cn('reliability_factor'); e.movement = cn('movement')
  } else if (kind === 'equipment') {
    e.year = cn('year'); e.isArchetype = cv('is_archetype')
    e.archetype = cv('archetype'); e.parent = cv('parent')
    e.isBuildable = cv('is_buildable')
    if (childBlock(doc, b, 'can_be_produced')) e.canBeProduced = 'yes'
    e.picture = cv('picture'); e.folder = cv('folder'); e.equipName = cv('name')
    e.equipType = cv('type'); e.groupBy = cv('group_by')
    e.interfaceCategory = cv('interface_category')
    e.visualLevel = cn('visual_level'); e.buildCostIc = cn('build_cost_ic')
    e.powerCostAdd = cn('power_cost_add')
    e.reliability = cn('reliability'); e.defense = cn('defense')
    e.breakthrough = cn('breakthrough'); e.hardness = cn('hardness')
    e.armorValue = cn('armor_value')
    e.softAttack = cn('soft_attack'); e.hardAttack = cn('hard_attack')
    e.apAttack = cn('ap_attack'); e.airAttack = cn('air_attack')
    e.lendLeaseCost = cn('lend_lease_cost'); e.maxSpeedEq = cn('maximum_speed')
    const res = childBlock(doc, b, 'resources'); if (res) e.resources = blockKV(doc, res)
    const ms = childBlock(doc, b, 'module_slots'); if (ms) e.moduleSlots = blockKeys(doc, ms)
    const up = childBlock(doc, b, 'upgrades'); if (up) e.upgrades = blockKeys(doc, up)
        e.priority = cn('priority'); e.active = cv('active')
    e.canBeLendLeased = cv('can_be_lend_leased'); e.isConvertable = cv('is_convertable')
    e.canLicense = cv('can_license'); e.isFrame = cv('is_frame')
    e.maxMilitaryFactories = cn('max_military_factories')
    e.maxDockyardFactories = cn('max_dockyard_factories')
    e.manpower = cn('manpower'); e.maxStrength = cn('max_strength')
    e.entrenchment = cn('entrenchment'); e.recon = cn('recon')
    e.navalSpeed = cn('naval_speed'); e.fireRange = cn('fire_range')
    e.lgArmorPiercing = cn('lg_armor_piercing'); e.lgAttack = cn('lg_attack')
    e.hgArmorPiercing = cn('hg_armor_piercing'); e.hgAttack = cn('hg_attack')
    e.torpedoAttack = cn('torpedo_attack'); e.antiAirAttack = cn('anti_air_attack')
    e.shoreBombardment = cn('shore_bombardment'); e.evasion = cn('evasion')
    e.surfaceDetection = cn('surface_detection'); e.subAttack = cn('sub_attack')
    e.subDetection = cn('sub_detection'); e.surfaceVisibility = cn('surface_visibility')
    e.subVisibility = cn('sub_visibility'); e.navalRange = cn('naval_range')
    e.portCapacityUsage = cn('port_capacity_usage')
    e.searchAndDestroyCoordination = cn('search_and_destroy_coordination')
    e.convoyRaidingCoordination = cn('convoy_raiding_coordination')
    e.airDefence = cn('air_defence'); e.airRange = cn('air_range')
    e.airAgility = cn('air_agility'); e.airGroundAttack = cn('air_ground_attack')
    e.airBombing = cn('air_bombing'); e.airSuperiority = cn('air_superiority')
    e.navalStrikeAttack = cn('naval_strike_attack')
    e.navalStrikeTargetting = cn('naval_strike_targetting')
    e.carrierSize = cn('carrier_size')
    e.defaultCarrierCompositionWeight = cn('default_carrier_composition_weight')
    e.carrierCapable = cv('carrier_capable'); e.variantName = cv('variant_name')
    const ecp = childBlock(doc, b, 'critical_parts'); if (ecp) e.criticalParts = bareTokens(doc, ecp)
  } else if (kind === 'critical_parts') {
    e.icon = cv('icon'); e.frame = cn('frame'); e.chance = cn('chance')
  } else if (kind === 'names') {
    e.poolParent = parentKey
    e.prefix = cv('prefix'); e.fallbackName = cv('fallback_name'); e.poolType = cv('type')
    const fc = childBlock(doc, b, 'for_countries'); if (fc) e.forCountries = bareTokens(doc, fc)
    const g = childBlock(doc, b, 'generic'); if (g) e.genericCount = g.entries.length
    const u = childBlock(doc, b, 'unique'); if (u) e.uniqueCount = u.entries.length
    const o = childBlock(doc, b, 'ordered'); if (o) e.orderedCount = o.entries.length
  }
}

/* ── 原始记录 ────────────────────────────────────────────────────── */

interface Raw {
  root: number; file: string; kind: UnitKind; id: string; line: number
  doc: Document; b?: Block; parentKey?: string
}

/* ── 构建模型 ────────────────────────────────────────────────────── */

export function buildUnitsModel(roots: UnitsRoot[], isBase: (r: number) => boolean): UnitsModel {
  const t0 = Date.now()
  const defs = new Map<string, DefSite[]>()
  const fileDefs = new Map<string, DefSite[]>()
  const raw: Raw[] = []

  /* ★ 文件级替换(游戏规则):同相对路径 + 同文件名的文件,载入序靠后的来源整份替换靠前的。
   *   基础游戏与模组同名文件若同时读取,单位/装备会出现重复定义;只保留最终生效那份。 */
  const effFiles = new Map<string, { root: number; abs: string; rel: string }>()
  roots.forEach((r, root) => {
    for (const abs of walk(join(r.path, 'common', 'units'))) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      if (isUnloadedByLaterReplacePath(roots, root, rel)) continue
      effFiles.set(rel.toLowerCase(), { root, abs, rel })
    }
  })

  roots.forEach((r, root) => {
    const base = join(r.path, 'common', 'units')
    for (const abs of walk(base)) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, root, rel)) continue
      const eff = effFiles.get(rel.toLowerCase())
      if (!eff || eff.root !== root) continue  // ★ 文件级替换:被更高优先级同名文件覆盖的不加载
      const fd = fileDefs.get(rel) ?? []
      fd.push({ root, file: rel, line: 1 })
      fileDefs.set(rel, fd)
      let doc: Document
      try { doc = parse(readFileSync(abs, 'utf8')) } catch { continue }

      const { group, kind } = groupOf(rel)

      if (kind === 'unit_modifiers') {
        let umb = findContainer(doc, 'unit_modifiers')
        if (!umb) for (const e of doc.root.entries) {
          if (e.block && keyText(doc, e)?.toLowerCase() === 'sub_unit_modifiers') { umb = e.block; break }
        }
        const scope = umb ?? doc.root
        for (const e of scope.entries) {
          if (e.key >= 0) continue
          const v = valueText(doc, e)
          if (!v) continue
          const dkey = 'unit_modifiers:' + v
          const dd = defs.get(dkey) ?? []
          dd.push({ root, file: rel, line: lineOf(doc, e) })
          defs.set(dkey, dd)
          raw.push({ root, file: rel, kind, id: v, line: lineOf(doc, e), doc })
        }
        continue
      }

      if (kind === 'names') {
        for (const e of doc.root.entries) {
          const k = keyText(doc, e)
          if (!k) continue
          if (!e.block) {
            const v = valueText(doc, e) ?? k
            const dkey = 'names:' + v
            const dd = defs.get(dkey) ?? []
            dd.push({ root, file: rel, line: lineOf(doc, e) })
            defs.set(dkey, dd)
            raw.push({ root, file: rel, kind, id: v, line: lineOf(doc, e), doc })
            continue
          }
          if (childLooksLikePool(doc, e.block)) {
            for (const c of e.block.entries) {
              if (!c.block) continue
              const ck = keyText(doc, c)
              if (!ck) continue
              const id = k + ':' + ck
              const dkey = 'names:' + id
              const dd = defs.get(dkey) ?? []
              dd.push({ root, file: rel, line: lineOf(doc, c) })
              defs.set(dkey, dd)
              raw.push({ root, file: rel, kind, id, line: lineOf(doc, c), doc, b: c.block, parentKey: k })
            }
          } else {
            const dkey = 'names:' + k
            const dd = defs.get(dkey) ?? []
            dd.push({ root, file: rel, line: lineOf(doc, e) })
            defs.set(dkey, dd)
            raw.push({ root, file: rel, kind, id: k, line: lineOf(doc, e), doc, b: e.block })
          }
        }
        continue
      }

      // units / equipment / critical_parts
      const container = findContainer(doc, kind) ?? doc.root
      for (const e of container.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block) continue
        const dkey = kind + ':' + k
        const dd = defs.get(dkey) ?? []
        dd.push({ root, file: rel, line: lineOf(doc, e) })
        defs.set(dkey, dd)
        raw.push({ root, file: rel, kind, id: k, line: lineOf(doc, e), doc, b: e.block })
      }
    }
  })

  // 第二遍:组装文件 + 条目
  const filesByRel = new Map<string, UnitFile>()
  for (const site of raw) {
    const dkey = site.kind + ':' + site.id
    const cdefs = defs.get(dkey) ?? [{ root: site.root, file: site.file, line: site.line }]
    const own = ownOf(cdefs, isBase)
    const last = cdefs[cdefs.length - 1]
    // stale = 本条目不是其 defs 链最后一条(后载入者胜;影子副本标记 stale)
    const stale = !(site.root === last.root && site.file === last.file && site.line === last.line)
    const e: UnitEntry = {
      id: site.id, line: site.line, file: site.file, root: site.root,
      base: own.base, own, stale, defs: cdefs, kind: site.kind,
      fields: site.b ? fieldsOf(site.doc, site.b) : [],
    }
    if (site.b) extractTyped(site.doc, site.b, site.kind, e, site.parentKey)

    let f = filesByRel.get(site.file)
    if (!f) {
      const { group, kind } = groupOf(site.file)
      const fdefs = fileDefs.get(site.file) ?? [{ root: site.root, file: site.file, line: 1 }]
      const fo = ownOf(fdefs, isBase)
      const fr = fdefs[fdefs.length - 1]?.root ?? site.root
      f = {
        rel: site.file, group, kind,
        root: fr, rootName: roots[fr]?.name ?? '', base: isBase(fr),
        own: fo, stale: fdefs[fdefs.length - 1]?.root !== fo.effective,
        entries: [],
      }
      filesByRel.set(site.file, f)
    }
    f.entries.push(e)
  }

  const files = [...filesByRel.values()]
  files.sort((a, b) => (a.root - b.root) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const f of files) f.entries.sort((a, b) => a.line - b.line)

  let rawCount = 0, effCount = 0, overridden = 0, modNew = 0
  let nUnits = 0, nEquip = 0, nCrit = 0, nUm = 0, nNames = 0
  for (const f of files) {
    rawCount += f.entries.length
    for (const en of f.entries) {
      if (en.stale) continue
      effCount++
      if (en.own.own === 'override') overridden++
      else if (en.own.own === 'new') modNew++
      if (en.kind === 'units') nUnits++
      else if (en.kind === 'equipment') nEquip++
      else if (en.kind === 'critical_parts') nCrit++
      else if (en.kind === 'unit_modifiers') nUm++
      else nNames++
    }
  }

  return {
    roots, files, defs,
    stats: {
      files: files.length, rawEntries: rawCount, entries: effCount,
      overridden, modNew,
      units: nUnits, equipment: nEquip, criticalParts: nCrit,
      unitModifiers: nUm, namePools: nNames,
      ms: Date.now() - t0,
    },
  }
}