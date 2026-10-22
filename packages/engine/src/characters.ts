/**
 * 人物角色模型 —— 解析 common/characters/*.txt,按文件组织人物。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 设计要点
 * ══════════════════════════════════════════════════════════════════
 * HOI4 的 common/characters 每文件按国家(或用途)放一批人物块,格式:
 *   characters = {
 *     GER_xxx = {
 *       name = "GER_xxx"                    # 本地化键
 *       gender = female
 *       portraits = { civilian = { large = GFX_xxx, small = GFX_xxx_small } }
 *       allowed_civil_war = { has_government = fascism }   # 条件块:内战可用
 *       country_leader = { ... }            # 职务块:有块即该人物担此职
 *       field_marshal = { ... }
 *       corps_commander = { ... }
 *       advisor = { slot = political_advisor, ... }
 *       scientist = { traits = { ... } }
 *       instance = {                        # 条件变体(DLC 门控常见)
 *         allowed = { has_dlc = "La Resistance" }
 *         name = ...
 *         portraits = { ... }
 *         advisor = { ... }
 *       }
 *     }
 *   }
 *
 * 本模块按「文件 → 人物 → 检查器」三层组织(前端三栏布局对应):
 *   左栏  = 文件清单(common/characters/xxx.txt)
 *   中栏  = 该文件下的人物(头像 + 人名 + 职务徽标)
 *   右栏  = 选中人物的检查器(肖像 / allowed_civil_war / 职务 / instance+DLC门控 / 来源)
 *
 * ══ 来源归属(OWNERSHIP_V1,全工作台统一语义)══
 *   载入顺序 基础游戏 → DLC → 模组,后者优先。
 *   · 文件级:同【相对路径】文件被模组整文件替换。
 *   · 条目级:同【人物 id】(characters 是全局命名空间,跨文件)被模组替换。
 *   两者都走 engine/src/ownership.ts 的 ownOf —— 只读 root 判定由调用方喂入。
 *
 * ══ 实例(instance)与 DLC 门控 ══
 *   同一个 id 可有多个 instance 块,各自带 `allowed = {...}`(常见 has_dlc)。
 *   前端据此把实例按 DLC 开关显示:勾选某 DLC → 对应实例可见。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'
import { ownOf, type OwnInfo, type DefSite } from './ownership.ts'

export interface CharRoot {
  name: string
  path: string
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/* ══════════════════════════════════════════════════════════════════
 * 一、通用工具(与 dlc.ts 同风格)
 * ══════════════════════════════════════════════════════════════════ */

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
function childBlocks(doc: Document, b: Block, key: string): Block[] {
  const out: Block[] = []
  const lk = key.toLowerCase()
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === lk && e.block) out.push(e.block)
  return out
}
/** 递归收集块内所有 `has_dlc = "X"` 的 X —— DLC 门控判据 */
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

/** 块内的叶子条件摘要 —— 收集 trigger 叶子赋值,把脚本结构(if/OR/limit)压平成扁平键值 */
function condSummary(doc: Document, b: Block, depth = 0): string[] {
  const out: string[] = []
  if (depth > 4) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const lk = k.toLowerCase()
    if (e.block) {
      if (lk === 'or' || lk === 'and' || lk === 'not' || lk === 'if' || lk === 'limit' || lk === 'elseif') {
        const inner = condSummary(doc, e.block, depth + 1)
        const t = lk.toUpperCase()
        out.push(inner.length ? t + '(' + inner.slice(0, 4).join(' & ') + ')' : t)
      } else {
        out.push(e.block.entries.length ? k + '{' + e.block.entries.length + '}' : k)
      }
    } else if (e.value >= 0) {
      const v = valueText(doc, e)
      if (v !== undefined) out.push(k + '=' + v)
    }
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════
 * 二、职务块识别
 * ══════════════════════════════════════════════════════════════════
 * 人物块里「有 block 就说明担该职」的顶层键,除了这些元数据键,其余全是职务块。
 */
const META_KEYS = new Set([
  'name', 'gender', 'portraits', 'allowed_civil_war', 'instance',
  'if', 'elseif', 'else', 'limit', 'trigger', 'effect', 'ai_will_do',
])

const ROLE_CN: Record<string, string> = {
  country_leader: '国家领袖',
  field_marshal: '元帅',
  corps_commander: '军团指挥官',
  army_leader: '陆军将领',
  navy_leader: '海军将领',
  air_leader: '空军将领',
  advisor: '顾问',
  scientist: '科学家',
  operative_leader: '特工主管',
  military_high_command: '最高指挥部',
  military_staff: '参谋',
  political_advisor: '政治顾问',
  general: '将领',
  admiral: '海军上将',
  marshal: '元帅',
  minister: '部长',
  high_command: '指挥部',
  strategist: '战略家',
}

/** 识别人物块里的职务块 key → 中文名(不认识则用英文 key) */
function roleLabel(key: string): { key: string; cn: string } {
  return { key, cn: ROLE_CN[key] ?? key }
}

/** 职务块内部字段摘要 —— 收集叶子键值 + 一层子块的扁平汇总 */
function roleFields(doc: Document, b: Block, depth = 0): string[] {
  const out: string[] = []
  if (depth > 1) return out
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    if (e.value >= 0) {
      const v = valueText(doc, e)
      if (v !== undefined && v !== '') out.push(k + '=' + v)
    } else if (e.block) {
      if (depth === 0) {
        const inner = roleFields(doc, e.block, depth + 1)
        out.push(inner.length ? k + '{' + inner.slice(0, 8).join(', ') + (inner.length > 8 ? '…' : '') + '}' : k + '{}')
      } else {
        out.push(k + '{}')
      }
    }
  }
  return out
}

/** WIKI_CHAR_V1:按 Wiki《Character modding》细分职务块关键字段
 *  (traits / ideology / slot / ledger / 各类 skill / 专长 skills / desc / expire 等)。
 *  提取不到返回空对象,由调用方展开到 CharRole(保留 fields 摘要作后备)。 */
function parseRoleDetail(doc: Document, b: Block): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  const traits = childBlock(doc, b, 'traits')
  if (traits) {
    const t: string[] = []
    for (const e of traits.entries) {
      const v = valueText(doc, e)
      if (v && v !== '') t.push(v)
    }
    if (t.length) o.traits = t
  }
  const scalar = (key: string) => childValue(doc, b, key)
  const num = (key: string) => {
    const v = childValue(doc, b, key)
    return v !== undefined ? Number(v) : undefined
  }
  o.ideology = scalar('ideology')
  o.slot = scalar('slot')
  o.ideaToken = scalar('idea_token')
  o.ledger = scalar('ledger')
  o.desc = scalar('desc')
  o.expire = scalar('expire')
  o.legacyId = scalar('legacy_id')
  o.canBeFired = scalar('can_be_fired')
  o.cost = num('cost')
  o.skill = num('skill')
  o.attackSkill = num('attack_skill')
  o.defenseSkill = num('defense_skill')
  o.planningSkill = num('planning_skill')
  o.logisticsSkill = num('logistics_skill')
  o.maneuveringSkill = num('maneuvering_skill')
  o.coordinationSkill = num('coordination_skill')
  const sb = childBlock(doc, b, 'skills')
  if (sb) {
    const s: Record<string, number> = {}
    for (const e of sb.entries) {
      const k = keyText(doc, e)
      if (k) s[k] = e.value >= 0 ? Number(valueText(doc, e)) : 0
    }
    o.skills = s
  }
  o.hasAllowed = !!childBlock(doc, b, 'allowed')
  o.hasAvailable = !!childBlock(doc, b, 'available')
  o.hasVisible = !!childBlock(doc, b, 'visible')
  o.hasOnAdd = !!childBlock(doc, b, 'on_add')
  o.hasOnRemove = !!childBlock(doc, b, 'on_remove')
  return o
}
/* ══════════════════════════════════════════════════════════════════
 * 三、数据类型
 * ══════════════════════════════════════════════════════════════════ */

export interface CharPortrait {
  role: string
  kind: 'large' | 'small'
  tex: string
}

export interface CharRole {
  key: string
  cn: string
  line: number
  fields: string[]
  /* WIKI_CHAR_V1:按 Wiki《Character modding》细分的职务字段 */
  traits?: string[]
  ideology?: string
  slot?: string
  ideaToken?: string
  ledger?: string
  desc?: string
  expire?: string
  legacyId?: string
  cost?: number
  skill?: number
  attackSkill?: number
  defenseSkill?: number
  planningSkill?: number
  logisticsSkill?: number
  maneuveringSkill?: number
  coordinationSkill?: number
  skills?: Record<string, number>
  hasAllowed?: boolean
  hasAvailable?: boolean
  hasVisible?: boolean
  hasOnAdd?: boolean
  hasOnRemove?: boolean
  canBeFired?: string
}

export interface CharInstance {
  hasDlc: string[]
  cond: string[]
  name?: string
  portraits: CharPortrait[]
  roles: CharRole[]
  line: number
}

export interface Character {
  id: string
  name?: string
  gender?: string
  portraits: CharPortrait[]
  roles: CharRole[]
  allowedCivilWar?: string[]
  instances: CharInstance[]
  hasDlcAll: string[]
  own: OwnInfo
  stale: boolean
  defs: DefSite[]
  file: string
  line: number
  root: number
  base: boolean
}

export interface CharacterFile {
  rel: string
  root: number
  rootName: string
  base: boolean
  own: OwnInfo
  stale: boolean
  characters: Character[]
}

export interface CharactersModel {
  roots: CharRoot[]
  files: CharacterFile[]
  defs: Map<string, DefSite[]>
  stats: {
    files: number
    rawCharacters: number
    characters: number
    overridden: number
    modNew: number
    withDlcInstance: number
    ms: number
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 四、单文件解析
 * ══════════════════════════════════════════════════════════════════ */

/** 提取 portraits 块内所有 large/small 叶子贴图(含深层 male/female 嵌套) */
function extractPortraits(doc: Document, pb: Block, out: CharPortrait[], pathRole: string): void {
  for (const e of pb.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const lk = k.toLowerCase()
    if (e.value >= 0) {
      if (lk === 'large' || lk === 'small') {
        const v = valueText(doc, e)
        if (v) out.push({ role: pathRole || lk, kind: lk, tex: v })
      }
    } else if (e.block) {
      const sub = lk === 'male' || lk === 'female' ? lk : pathRole || lk
      extractPortraits(doc, e.block, out, sub)
    }
  }
}

/** 解析一个人物块(characters 根块里的一个 entry) */
function parseCharacterBlock(
  doc: Document,
  id: string,
  b: Block,
  line: number,
  file: string,
  root: number,
  own: OwnInfo,
  stale: boolean,
  defs: DefSite[],
): Character {
  const portraits: CharPortrait[] = []
  const roles: CharRole[] = []
  const instances: CharInstance[] = []
  const allDlc = new Set<string>()

  const pb = childBlock(doc, b, 'portraits')
  if (pb) extractPortraits(doc, pb, portraits, '')

  for (const e of b.entries) {
    if (!e.block) continue
    const k = keyText(doc, e)
    if (!k) continue
    const lk = k.toLowerCase()
    if (META_KEYS.has(lk)) continue
    const { cn } = roleLabel(k)
    roles.push({ key: k, cn, line: lineOf(doc, e), fields: roleFields(doc, e.block), ...parseRoleDetail(doc, e.block) })
  }

  let allowedCivilWar: string[] | undefined
  const aw = childBlock(doc, b, 'allowed_civil_war')
  if (aw) {
    allowedCivilWar = condSummary(doc, aw)
    collectHasDlc(doc, aw, allDlc)
  }

  for (const ib of childBlocks(doc, b, 'instance')) {
    const instDlc = new Set<string>()
    let instCond: string[] = []
    const al = childBlock(doc, ib, 'allowed')
    if (al) {
      collectHasDlc(doc, al, instDlc)
      instCond = condSummary(doc, al)
      for (const d of instDlc) allDlc.add(d)
    }
    const instPortraits: CharPortrait[] = []
    const ipb = childBlock(doc, ib, 'portraits')
    if (ipb) extractPortraits(doc, ipb, instPortraits, '')
    const instRoles: CharRole[] = []
    for (const e of ib.entries) {
      if (!e.block) continue
      const k = keyText(doc, e)
      if (!k) continue
      const lk = k.toLowerCase()
      if (lk === 'name' || lk === 'portraits' || lk === 'allowed' || lk === 'gender' || META_KEYS.has(lk)) continue
      const { cn } = roleLabel(k)
      instRoles.push({ key: k, cn, line: lineOf(doc, e), fields: roleFields(doc, e.block), ...parseRoleDetail(doc, e.block) })
    }
    instances.push({
      hasDlc: [...instDlc],
      cond: instCond,
      name: childValue(doc, ib, 'name'),
      portraits: instPortraits,
      roles: instRoles,
      line: lineOf(doc, ib.open >= 0 ? ib.entries[0] ?? ({} as Entry) : ({} as Entry)),
    })
  }

  return {
    id,
    name: childValue(doc, b, 'name'),
    gender: childValue(doc, b, 'gender'),
    portraits,
    roles,
    allowedCivilWar,
    instances,
    hasDlcAll: [...allDlc],
    own,
    stale,
    defs,
    file,
    line,
    root,
    base: own.base,
  }
}

/** 该 id 这条覆盖链的归属 + 是否影子(stale) */
function ownOfCharacter(defs: DefSite[], isBase: (r: number) => boolean): { own: OwnInfo; stale: boolean } {
  const o = ownOf(defs, isBase)
  return { own: o, stale: defs[defs.length - 1]?.root !== o.effective }
}

/* ══════════════════════════════════════════════════════════════════
 * 五、构建模型
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

/**
 * 构建人物模型。
 * @param roots  按载入序的来源(基础游戏在前,模组在后)
 * @param isBase 该来源是否只读(基础游戏)
 */
export function buildCharactersModel(roots: CharRoot[], isBase: (r: number) => boolean): CharactersModel {
  const t0 = Date.now()
  const defs = new Map<string, DefSite[]>()
  const fileDefs = new Map<string, DefSite[]>()

  // 第一遍:收集全部定义现场 + 解析人物块
  const raw: { root: number; file: string; id: string; b: Block; doc: Document; line: number }[] = []
  roots.forEach((r, root) => {
    const base = join(r.path, 'common', 'characters')
    for (const abs of walk(base)) {
      const rel = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, root, rel)) continue
      const fd = fileDefs.get(rel) ?? []
      fd.push({ root, file: rel, line: 1 })
      fileDefs.set(rel, fd)
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k || !e.block) continue
        // 根级人物容器有两种写法:
        //   a) 直接 characters = { id = {...} ... }
        //   b) 根级 key = 人物 id,块即人物(无 characters 包裹,较少见)
        const container = k.toLowerCase() === 'characters' ? e.block : doc.root
        const scope = k.toLowerCase() === 'characters' ? e.block.entries : doc.root.entries
        for (const pe of scope) {
          const pk = keyText(doc, pe)
          if (!pk || !pe.block) continue
          const dd = defs.get(pk) ?? []
          dd.push({ root, file: rel, line: lineOf(doc, pe) })
          defs.set(pk, dd)
          raw.push({ root, file: rel, id: pk, b: pe.block, doc, line: lineOf(doc, pe) })
        }
      }
    }
  })

  // 第二遍:组装文件 + 人物
  const filesByRel = new Map<string, CharacterFile>()
  for (const site of raw) {
    const cdefs = defs.get(site.id) ?? [{ root: site.root, file: site.file, line: site.line }]
    const { own, stale } = ownOfCharacter(cdefs, isBase)
    const ch = parseCharacterBlock(site.doc, site.id, site.b, site.line, site.file, site.root, own, stale, cdefs)
    let f = filesByRel.get(site.file)
    if (!f) {
      const fdefs = fileDefs.get(site.file) ?? [{ root: site.root, file: site.file, line: 1 }]
      const fo = ownOf(fdefs, isBase)
      const fr = fdefs[fdefs.length - 1]?.root ?? site.root
      f = {
        rel: site.file,
        root: fr,
        rootName: roots[fr]?.name ?? '',
        base: isBase(fr),
        own: fo,
        stale: fdefs[fdefs.length - 1]?.root !== fo.effective,
        characters: [],
      }
      filesByRel.set(site.file, f)
    }
    f.characters.push(ch)
  }

  const files = [...filesByRel.values()]
  files.sort((a, b) => (a.root - b.root) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const f of files) f.characters.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let rawCount = 0
  let effCount = 0
  let overridden = 0
  let modNew = 0
  let withDlc = 0
  for (const f of files) {
    rawCount += f.characters.length
    for (const c of f.characters) {
      if (!c.stale) {
        effCount++
        if (c.own.own === 'override') overridden++
        if (c.own.own === 'new') modNew++
      }
      if (c.hasDlcAll.length) withDlc++
    }
  }

  return {
    roots,
    files,
    defs,
    stats: {
      files: files.length,
      rawCharacters: rawCount,
      characters: effCount,
      overridden,
      modNew,
      withDlcInstance: withDlc,
      ms: Date.now() - t0,
    },
  }
}
