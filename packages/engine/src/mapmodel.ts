/**
 * MAPMODEL_V1 —— 世界地图的**多来源合成模型**。
 *
 * ══ 原实现的三个硬编码(已实测确认全是错的)══
 *  ① `const root = ROOTS.find((r) => !r.writable) ?? ROOTS[0]`
 *     → **只读基础游戏的 map/**。但实测 36 个创意工坊模组里 **11 个自带 map/**,
 *       其中 1 个(Kaiserreich 1521695605)连 `provinces.bmp`+`definition.csv` 都换了。
 *       只看原版 = 地图预览跟游戏里看到的完全不是一张图。
 *  ② states 只从 `<base>/history/states` 读
 *     → 但 `history/states` 恰恰是被 replace_path 改得最狠的目录
 *       (实测 11 个模组都声明 replace_path="history/states")。
 *  ③ 省份归属只认 `owner`,认了也不管该 owner 是否来自模组
 *     → 模组新增的 tag 在 `common/countries` 里可能没有对应文件,颜色就丢了。
 *
 * ══ 合成口径 ══
 *   地图资产(位图/csv/地形…)按**文件级**归属解析(assetsrc.resolveAssets)
 *   states 按**目录级**归属解析(assetsrc.resolveDir)—— 一文件一 state,
 *   同名即整份替换,replace_path 决定原版哪些被删除。
 *   归属国家 → 颜色,取「生效的 countries 定义」,模组新增 tag 也要有颜色。
 *
 * 本模块**不碰 BMP 解码**(那是 gui 层 dds.ts 的事),只接收已解码的 RGBA。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normRelPath, type ModDescriptor } from './modmeta.ts'
import { resolveAssets, resolveDir, type DirAsset, type SrcRoot, type AssetResolution } from './assetsrc.ts'

/** 地图关键资产 —— 全部按文件级归属判定 */
export const MAP_ASSETS = [
  'map/provinces.bmp',
  'map/definition.csv',
  'map/adjacencies.csv',
  'map/adjacency_rules.txt',
  'map/terrain.bmp',
  'map/heightmap.bmp',
  'map/rivers.bmp',
  'map/trees.bmp',
  'map/cities.bmp',
  'map/buildings.txt',
  'map/supply_nodes.txt',
  'map/railways.txt',
  'map/continent.txt',
  'map/default.map',
] as const

/** states 目录(相对路径,各模组同名 → 目录级判定) */
export const STATES_DIR = 'history/states'

/** 战略区域目录(相对路径;注意目录名无下划线 = strategicregions)。
 *  与 states 同款的「一文件一实体」目录级判定;KR 用 replace_path 整体替换过。 */
export const STRATEGIC_REGIONS_DIR = 'map/strategicregions'

/** 一栋建筑(挂在省或 state 上) */
export interface BuildingInfo {
  /** 建筑 id,如 infrastructure / naval_base / 3838(省级 VP 点建筑) */
  id: string
  /** 层级;0 = 直接写在 state 的 buildings 里(省级) */
  level: number
  /** 该建筑受 DLC 门控时,门控的 DLC 名 */
  dlc?: string
}

/** 一个资源(实测键名:coal / steel / tungsten / aluminium / oil / rubber / chrome) */
export interface ResourceInfo {
  id: string
  amount: number
}

/**
 * 解析 state 文件的**全部**字段(2026-10-07 扩)。
 *
 * ★ 原实现只取 id/name/owner/provinces 四个字段,页面上只能显示"谁占的",
 *   但用户实际要判断的是"这地方值不值得抢" —— 人力、分类、资源、建筑、
 *   核心国、胜利点都得看到。实测 1-France.txt 一个 state 里就有
 *   manpower / state_category / resources / victory_points / buildings /
 *   add_core_of / local_supplies 七类信息,漏掉就没法判断。
 *
 * ★ DLC 门控必须原样保留:实测 77 个 state 文件含 `has_dlc = "..."`
 *   (如 1021 新加坡的 naval_headquarters 受 NCNS 门控)。
 *   游戏里 ownership 本身不受 DLC 影响,但**建筑/胜利点受门控** ——
 *   没 DLC 时那些格子是空的。所以门控只标在 buildings/victory_points 上,
 *   不去改 owner(改了就等于谎报归属)。
 */
export interface StateDetail {
  manpower?: number
  stateCategory?: string
  resources: ResourceInfo[]
  /** victory_points = { 10265 15 } → [[provinceId, level]] */
  victoryPoints: [number, number][]
  buildings: BuildingInfo[]
  /** history.add_core_of 列表(核心国) */
  cores: string[]
  /** history.owner 之外的其它历史键(极少见到,保留原文) */
  extraHistory: { key: string; value: string }[]
  localSupplies?: number
  /** history.add_claim_by 列表(宣称国;与 cores 核心国区分) */
  claims: string[]
  /** state 顶层 impassable = yes/no(不可通行州)。是 yes/no 标量,不是 0/1 */
  impassable: boolean
  /** state 顶层 buildings_max_level_factor = float(建筑槽乘数),缺失为 null */
  buildingsMaxLevelFactor: number | null
  /** 该 state 含 DLC 门控项时的 DLC 名集合 */
  dlcGated: string[]
  /** 文件内 state 块之外的顶层键(实测极少) */
  unknownKeys: string[]
}

/** 一个 state(来自 history/states/<id>-<name>.txt) */
export interface StateInfo extends StateDetail {
  /** 文件名里的数字前缀 = state id */
  id: number
  /** 文件名里的名称部分 */
  name: string
  /** 文件名(原样) */
  file: string
  /** 相对路径 */
  path: string
  /** owner tag(可能为空) */
  owner: string
  /** 该 state 含的省份 id 列表 */
  provinces: number[]
  /** 归属:原版/模组改写/模组新增 */
  own: 'vanilla' | 'override' | 'new'
  /** 生效来源下标 */
  root: number
  /** 提供它的所有来源(覆盖链) */
  chain: number[]
  /** 被 replace_path 从原版删掉但自己没补的同类 state(诊断用) */
  dropped: boolean
}

/**
 * 一个天气时段(weather.period 块)。格式见 Wiki《Strategic region modding》/《Map modding》:
 * between/temperature 各取两个数;其余键(no_phenomenon/rain_light/rain_heavy/snow/
 * blizzard/arctic_water/mud/sandstorm/min_snow_level)是现象权重 float,按出现顺序保留。
 */
export interface WeatherPeriodInfo {
  /** 起止日(between={a b} 原样保留,可能含小数;日/月从 0 起计) */
  between: [number, number]
  /** 温度区间(temperature={lo hi},可负),缺失为 null */
  temperature: [number, number] | null
  /** 其余现象键(float),按出现顺序 */
  fields: { key: string; value: number }[]
}

/**
 * 一个战略区域(map/strategicregions/<id>-<name>.txt)。
 * 归属字段(own/root/chain/dropped)与 StateInfo 完全对齐,复用同一套目录级判定。
 */
export interface StrategicRegionInfo {
  id: number
  /** name="..." 引号内原文(通常是本地化键如 STRATEGICREGION_78) */
  name: string
  /** 文件名(原样) */
  file: string
  /** 相对路径 */
  path: string
  /** 该区含的省份 id 列表 */
  provinces: number[]
  weather: WeatherPeriodInfo[]
  /** naval_terrain 裸标识符(无引号),如 water_deep_ocean / water_shallow_sea;陆地区没有 */
  navalTerrain: string | null
  /** static_modifiers = { KEY = VALUE };VALUE 实测恒为字符串 'always',按字符串解析 */
  staticModifiers: { key: string; value: string }[]
  /** 归属:原版/模组改写/模组新增 */
  own: 'vanilla' | 'override' | 'new'
  /** 生效来源下标 */
  root: number
  /** 提供它的所有来源(覆盖链) */
  chain: number[]
  /** 被 replace_path 删除(诊断用;生效条目恒为 false) */
  dropped: boolean
}

export interface ProvinceOwnerInfo {
  /** 省份 id */
  id: number
  /** 归属 tag(空 = 无主) */
  owner: string
  /** 该省份归属来自哪个 state / 哪个来源 */
  stateId: number
  root: number
  own: 'vanilla' | 'override' | 'new'
}

export interface CountryDef {
  tag: string
  name: string
  color: [number, number, number]
  /** 生效来源 */
  root: number
  own: 'vanilla' | 'override' | 'new'
  /** 国家文件相对路径(如 common/countries/United Kingdom.txt)—— 右键定位用 */
  path: string
  /** history/countries 下的国家历史文件(如 history/countries/ALB - Albania.txt)。
   *  HOI4 的国家内容分两处:common/countries 是「定义」(配色/文化),
   *  history/countries 是「历史」(开局科技/政治/生产线)。「用 VS Code 打开国家」
   *  优先定位历史文件;没有历史文件(部分 tag 只有定义)时为 null。 */
  hist: { root: number; path: string } | null
}

/** 一张地图的完整合成结果 */
export interface MapModel {
  ready: boolean
  error?: string
  /** 位图宽高(来自生效的 provinces.bmp) */
  w: number
  h: number
  /** 省份质心(位图坐标系);附带 definition.csv 第 5-8 列 + 所属战略区 */
  provinces: {
    id: number
    x: number
    y: number
    owner: string
    stateId: number
    own: string
    /** 省份类型(definition.csv 第 5 列):陆地/海/湖 */
    type: 'land' | 'sea' | 'lake'
    /** 海岸状态(第 6 列 true/false;游戏里与位图冲突时以位图为准) */
    coastal: boolean
    /** 地形内部名(第 7 列,如 plains/forest/ocean;空为 null) */
    terrain: string | null
    /** 大陆名(第 8 列数字经 map/continent.txt 映射;0/缺失为 null) */
    continent: string | null
    /** 所属战略区域 id(由 strategicregions 省份清单推导;无归属为 null) */
    strategicRegionId: number | null
  }[]
  /** 生效国家定义(用于图例着色) */
  countries: CountryDef[]
  /** 生效 states */
  states: StateInfo[]
  /** ★ 省份 → 归属(完整表,含没有质心的) */
  ownerOf: Map<number, ProvinceOwnerInfo>
  /** 生效战略区域 */
  strategicRegions: StrategicRegionInfo[]

  /** 地图资产归属判定结果 */
  assets: AssetResolution
  /** states 目录判定结果 */
  statesDir: {
    effective: DirAsset[]
    dropped: DirAsset[]
    stats: { effective: number; vanilla: number; override: number; new: number; dropped: number }
  }
  /** 战略区域目录判定结果(结构与 statesDir 对齐) */
  strategicRegionsDir: {
    effective: DirAsset[]
    dropped: DirAsset[]
    stats: { effective: number; vanilla: number; override: number; new: number; dropped: number }
  }

  /** 各来源在本次合成里的贡献 */
  sources: {
    index: number
    name: string
    path: string
    writable: boolean
    replacePaths: string[]
    /** 该来源覆盖的地图资产数(own=override/new 且 effective=自己) */
    mapAssets: number
    /** 该来源生效的 states 数 */
    states: number
    /** 该来源生效的战略区域数 */
    strategicRegions: number
    /** 该来源生效的国家定义数 */
    countries: number
    /** 声明了 replace_path 但没提供文件 → 缺口数 */
    gaps: number
  }[]

  stats: {
    provinces: number
    owners: number
    states: number
    assetsVanilla: number
    assetsOverride: number
    assetsNew: number
    assetGaps: number
    statesDropped: number
  }

  /** ★ 诊断:声明 replace_path 却没提供文件 / 依赖缺失等 */
  issues: MapIssue[]
}

export interface MapIssue {
  kind: 'asset-gap' | 'state-dropped' | 'owner-unknown' | 'states-missing' | 'no-province-owner'
  severity: 'error' | 'warn'
  msg: string
  /** 涉及的来源下标 */
  roots: number[]
  /** 涉及的相对路径 */
  paths: string[]
}

/**
 * 配平花括号,取出一个块的内容(不含外层 {})。
 * ★ 不能用 `/\{([^}]*)\}/` —— state 文件里 buildings 内部还有
 *   `10265 = { naval_base = 5 }` 这种嵌套块,非配平正则会在第一个 `}` 截断
 *   (实测 1021 新加坡就是这种)。必须逐字符数深度。
 */
function takeBlock(text: string, from: number): { body: string; end: number } | null {
  let i = text.indexOf('{', from)
  if (i < 0) return null
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { body: text.slice(i + 1, j), end: j + 1 }
    }
  }
  return null
}

/** 去掉注释(块内也不该有行注释影响取值,但保险起见按行剥) */
function stripHashComments(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^"])#.*$/, (m, p1) => p1))
    .join('\n')
}

/** 顶层块内找 `KEY = {` 的位置(只看块的第一层,避免撞上嵌套键) */
function findKeyBlock(body: string, key: string): { body: string; inner: string } | null {
  const re = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*\\{`, 'm')
  const m = re.exec(body)
  if (!m) return null
  const start = m.index + m[0].length
  const blk = takeBlock(body, start - 1)
  if (!blk) return null
  return { body: body.slice(0, m.index), inner: blk.body }
}

/** 收集 `has_dlc = "xxx"` 出现的 DLC 名 */
function collectDlcGates(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/has_dlc\s*=\s*"([^"]+)"/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 解析 state 文件的全部字段 */
export function parseStateFileFull(file: string, text: string): StateDetail & { id: number; name: string; owner: string; provinces: number[] } {
  const base = file.replace(/\.txt$/i, '')
  const idm = base.match(/^(\d+)[-\s]*(.*)$/)
  const id = idm ? parseInt(idm[1], 10) : NaN
  const name = idm ? idm[2] : base
  const owner = (text.match(/^\s*owner\s*=\s*"?([A-Za-z0-9_]+)"?/m) || [])[1] || ''

  // 去掉整文件注释后,再取第一层块作为 state 的全部内容 ——
  // 这样 name= / manpower= 无论写在 state 外还是 state 内都能取到。
  const clean = stripHashComments(text)
  const stateBlk = takeBlock(clean, clean.indexOf('{') >= 0 ? clean.indexOf('{') : 0)
  const scope = stateBlk ? stateBlk.body : clean

  const pm = /(^|\n)\s*provinces\s*=\s*\{/.exec(scope)
  let provinces: number[] = []
  if (pm) {
    const blk = takeBlock(scope, pm.index + pm[0].length - 1)
    if (blk) provinces = (blk.body.match(/-?\d+/g) || []).map(Number).filter((n) => Number.isFinite(n))
  }

  const manpower = (() => {
    const m = /(^|\n)\s*manpower\s*=\s*(-?[\d.]+)/.exec(scope)
    return m ? Number(m[2]) : undefined
  })()
  const stateCategory = (() => {
    const m = /(^|\n)\s*state_category\s*=\s*"?([A-Za-z_0-9]+)"?/.exec(scope)
    return m ? m[2] : undefined
  })()
  const localSupplies = (() => {
    const m = /(^|\n)\s*local_supplies\s*=\s*(-?[\d.]+)/.exec(scope)
    return m ? Number(m[2]) : undefined
  })()

  // resources = { coal = 1 } —— 也可能在 history 内,两处都扫
  const resources: ResourceInfo[] = []
  const resSeen = new Set<string>()
  for (const src of [scope, findKeyBlock(scope, 'history')?.inner ?? '']) {
    const rb = /(^|\n)\s*resources\s*=\s*\{/.exec(src)
    if (!rb) continue
    const blk = takeBlock(src, rb.index + rb[0].length - 1)
    if (!blk) continue
    for (const m of blk.body.matchAll(/(?:^|[\s,{])([A-Za-z_0-9]+)\s*=\s*(-?[\d.]+)/g)) {
      if (resSeen.has(m[1])) continue
      resSeen.add(m[1])
      resources.push({ id: m[1], amount: Number(m[2]) })
    }
  }

  const histBlk = findKeyBlock(scope, 'history')
  const hist = histBlk ? histBlk.inner : ''

  // victory_points 可以出现多次(实测一个 state 里 3 个块),逐块累计
  const victoryPoints: [number, number][] = []
  for (const m of hist.matchAll(/(?:^|\n)[\s\t]*victory_points\s*=\s*\{/g)) {
    const blk = takeBlock(hist, m.index + m[0].length - 1)
    if (!blk) continue
    // 形如 `10265 15 # Manila` → 逐行取「省 id + 等级」两数
    for (const line of blk.body.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, '').trim()
      if (!t) continue
      const nums = t.match(/-?\d+(?:\.\d+)?/g)
      if (!nums || nums.length < 2) continue
      victoryPoints.push([Number(nums[0]), Number(nums[1])])
    }
  }

  // buildings:顶层键=建筑 id,值=层级;还可能有 `1234 = { ... }` 省级块
  const buildings: BuildingInfo[] = []
  const bSeen = new Set<string>()
  const addB = (id: string, level: number, dlc?: string) => {
    const k = id + '@' + level
    if (bSeen.has(k)) return
    bSeen.add(k)
    buildings.push(dlc ? { id, level, dlc } : { id, level })
  }
  const bBlk = findKeyBlock(hist, 'buildings')
  if (bBlk) {
    const bb = bBlk.inner
    // 按行/按块扫:顶层 `infrastructure = 2` 与 `10265 = { naval_base = 5 }`
    const re = /(?:^|\n)([\s\t]*)([A-Za-z_0-9]+)\s*=\s*(\{|-?\d+(?:\.\d+)?)/g
    for (const m of bb.matchAll(re)) {
      const indent = m[1].replace(/\t/g, '\t').length
      const id = m[2]
      if (/^\d+$/.test(id)) {
        // 省级块:展开里面的建筑
        const blk = takeBlock(bb, m.index + m[0].length - 1)
        if (!blk) continue
        const gates = collectDlcGates(blk.body)
        for (const b of blk.body.matchAll(/([A-Za-z_0-9]+)\s*=\s*(-?\d+)/g)) {
          addB(b[1], Number(b[2]), gates[0])
        }
        // naval_headquarters = { level = 1 allowed = { has_dlc = ... } }
        for (const b of blk.body.matchAll(/([A-Za-z_0-9]+)\s*=\s*\{/g)) {
          const inner = takeBlock(blk.body, b.index + b[0].length - 1)
          if (!inner) continue
          const lv = /level\s*=\s*(\d+)/.exec(inner.body)
          addB(b[1], lv ? Number(lv[1]) : 1, collectDlcGates(inner.body)[0])
        }
      } else {
        addB(id, Number(m[3]) || 0, gatesHint(bb, m.index))
      }
    }
  }

  // add_core_of 可重复
  const cores: string[] = []
  for (const m of hist.matchAll(/add_core_of\s*=\s*([A-Za-z0-9_]+)/g)) if (!cores.includes(m[1])) cores.push(m[1])

  // add_claim_by 可重复(与 add_core_of 同款,history 块内;实测 43 个原版 state 有)
  const claims: string[] = []
  for (const m of hist.matchAll(/add_claim_by\s*=\s*([A-Za-z0-9_]+)/g)) if (!claims.includes(m[1])) claims.push(m[1])

  // impassable = yes/no(state 顶层标量布尔;注意是 yes/no 不是 0/1)
  const impassable = (() => {
    const m = /(?:^|\n)\s*impassable\s*=\s*(yes|no)\b/.exec(scope)
    return m ? m[1] === 'yes' : false
  })()

  // buildings_max_level_factor = 1.000(state 顶层 float;缺失为 null)
  const buildingsMaxLevelFactor = (() => {
    const m = /(?:^|\n)\s*buildings_max_level_factor\s*=\s*(-?[\d.]+)/.exec(scope)
    return m ? Number(m[1]) : null
  })()

  // history 里除已知键外的其它键
  const known = new Set(['owner', 'victory_points', 'buildings', 'add_core_of', 'add_claim_by', 'resources', 'owner'])
  const extraHistory: { key: string; value: string }[] = []
  for (const line of hist.split(/\r?\n/)) {
    const t = line.replace(/#.*$/, '').trim()
    const m = /^([A-Za-z_0-9]+)\s*=\s*"?([A-Za-z0-9_.]+)"?$/.exec(t)
    if (m && !known.has(m[1])) extraHistory.push({ key: m[1], value: m[2] })
  }

  const unknownKeys: string[] = []
  for (const m of scope.matchAll(/(?:^|\n)([\t ]+)([A-Za-z_0-9]+)\s*=/g)) {
    const k = m[2]
    if (['manpower', 'name', 'state_category', 'local_supplies', 'id', 'resources', 'history', 'provinces', 'impassable', 'buildings_max_level_factor'].includes(k)) continue
    if (!unknownKeys.includes(k)) unknownKeys.push(k)
  }

  return {
    id,
    name,
    owner,
    provinces,
    manpower,
    stateCategory,
    resources,
    victoryPoints,
    buildings,
    cores,
    claims,
    impassable,
    buildingsMaxLevelFactor,
    extraHistory,
    localSupplies,
    dlcGated: collectDlcGates(scope),
    unknownKeys,
  }
}

/** 该行所属块里最近的 has_dlc(用于给顶层建筑标 DLC 门控) */
function gatesHint(block: string, at: number): string | undefined {
  const gates = collectDlcGates(block)
  return gates.length ? gates[gates.length - 1] : undefined
}

/** 读生效的 states(目录级归属) */
function buildStates(
  roots: readonly SrcRoot[],
  res: ReturnType<typeof resolveDir>,
): { states: StateInfo[]; ownerOf: Map<number, ProvinceOwnerInfo>; issues: MapIssue[] } {
  const issues: MapIssue[] = []
  const states: StateInfo[] = []
  const ownerOf = new Map<number, ProvinceOwnerInfo>()
  // 同一省份被多个 state 声明 → 游戏里后者(载入序靠后)赢,这里按数组序覆盖
  const dupProv: Map<number, StateInfo[]> = new Map()

  for (const da of res.effective) {
    const abs = join(roots[da.effective].path, da.path)
    let text = ''
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      issues.push({
        kind: 'state-dropped',
        severity: 'error',
        msg: `state 文件读取失败:${da.path}`,
        roots: [da.effective],
        paths: [da.path],
      })
      continue
    }
    const info = parseStateFileFull(da.name, text)
    if (!Number.isFinite(info.id)) {
      issues.push({
        kind: 'state-dropped',
        severity: 'warn',
        msg: `state 文件名不以数字开头,无法取 state id:${da.name}`,
        roots: [da.effective],
        paths: [da.path],
      })
      continue
    }
    const st: StateInfo = {
      id: info.id,
      name: info.name,
      file: da.name,
      path: da.path,
      owner: info.owner,
      provinces: info.provinces,
      own: da.own as StateInfo['own'],
      root: da.effective,
      chain: da.chain,
      dropped: false,
      // 2026-10-07:全字段透传(人力/分类/资源/建筑/核心国/胜利点/DLC 门控)
      manpower: info.manpower,
      stateCategory: info.stateCategory,
      resources: info.resources,
      victoryPoints: info.victoryPoints,
      buildings: info.buildings,
      cores: info.cores,
      claims: info.claims,
      impassable: info.impassable,
      buildingsMaxLevelFactor: info.buildingsMaxLevelFactor,
      extraHistory: info.extraHistory,
      localSupplies: info.localSupplies,
      dlcGated: info.dlcGated,
      unknownKeys: info.unknownKeys,
    }
    states.push(st)
    for (const p of info.provinces) {
      const ex = dupProv.get(p)
      if (ex) ex.push(st)
      else dupProv.set(p, [st])
      if (!ownerOf.has(p)) {
        ownerOf.set(p, { id: p, owner: info.owner, stateId: info.id, root: da.effective, own: st.own })
      } else {
        // 载入序靠后的 state 覆盖(与游戏一致)
        const prev = ownerOf.get(p)!
        if (da.effective >= prev.root) ownerOf.set(p, { id: p, owner: info.owner, stateId: info.id, root: da.effective, own: st.own })
      }
    }
  }

  // 重复声明诊断(同一省份被多个 state 认领)
  let dupCount = 0
  const dupSamples: string[] = []
  for (const [pid, list] of dupProv) {
    if (list.length > 1) {
      dupCount++
      if (dupSamples.length < 8) dupSamples.push(`省份 ${pid} 被 ${list.map((s) => `${s.id}-${s.name}`).join(' / ')} 同时声明`)
    }
  }
  if (dupCount) {
    issues.push({
      kind: 'owner-unknown',
      severity: 'warn',
      msg: `${dupCount} 个省份被多个 state 同时声明(游戏里取载入序靠后者),例:${dupSamples.join('; ')}`,
      roots: [],
      paths: [],
    })
  }

  return { states, ownerOf, issues }
}

/**
 * 解析一个战略区域文件(strategic_region = { ... })的全部字段。
 * 复用 state 解析同款工具(stripHashComments/takeBlock/findKeyBlock)。
 * 文件格式见 recon B1 节原样样本:id/name/provinces/naval_terrain/static_modifiers/weather。
 */
export function parseStrategicRegionFile(
  file: string,
  text: string,
): { id: number; name: string; provinces: number[]; weather: WeatherPeriodInfo[]; navalTerrain: string | null; staticModifiers: { key: string; value: string }[] } {
  // 文件名数字前缀作为 id 的兜底(id= 缺失时)
  const base = file.replace(/\.txt$/i, '')
  const idm = base.match(/^(\d+)[-\s]*(.*)$/)
  const fallbackId = idm ? parseInt(idm[1], 10) : NaN

  const clean = stripHashComments(text)
  const firstBrace = clean.indexOf('{')
  const srBlk = takeBlock(clean, firstBrace >= 0 ? firstBrace : 0)
  const scope = srBlk ? srBlk.body : clean

  // id = 78(文件内为准)
  let id = NaN
  const idScoped = /(?:^|\n)\s*id\s*=\s*(-?\d+)/.exec(scope)
  if (idScoped) id = Number(idScoped[1])
  if (!Number.isFinite(id)) id = fallbackId

  // name = "STRATEGICREGION_78"(引号原文)
  const name = (/(?:^|\n)\s*name\s*=\s*"([^"]*)"/.exec(scope) || [])[1] ?? idm?.[2] ?? base

  // provinces = { 2712 2736 ... }
  let provinces: number[] = []
  const pm = /(?:^|\n)\s*provinces\s*=\s*\{/.exec(scope)
  if (pm) {
    const blk = takeBlock(scope, pm.index + pm[0].length - 1)
    if (blk) provinces = (blk.body.match(/-?\d+/g) || []).map(Number).filter((n) => Number.isFinite(n))
  }

  // naval_terrain = water_deep_ocean(裸标识符,无引号)
  const navalTerrain = (/(?:^|\n)\s*naval_terrain\s*=\s*([A-Za-z0-9_]+)/.exec(scope) || [])[1] ?? null

  // static_modifiers = { KEY = VALUE };VALUE 实测恒为 'always' 这类标识符,按字符串保留
  const staticModifiers: { key: string; value: string }[] = []
  const smBlk = findKeyBlock(scope, 'static_modifiers')
  if (smBlk) {
    for (const line of smBlk.inner.split(/\r?\n/)) {
      const l2 = line.replace(/#.*$/, '').trim()
      const m = /^([A-Za-z_0-9]+)\s*=\s*"?([A-Za-z0-9_.]+)"?$/.exec(l2)
      if (m) staticModifiers.push({ key: m[1], value: m[2] })
    }
  }

  // weather = { period = { ... } × N }(实测固定 12 个 period)
  const weather: WeatherPeriodInfo[] = []
  const wBlk = findKeyBlock(scope, 'weather')
  if (wBlk) {
    const w = wBlk.inner
    const periodRe = /(?:^|\n)\s*period\s*=\s*\{/g
    let pm2: RegExpExecArray | null
    while ((pm2 = periodRe.exec(w))) {
      const blk = takeBlock(w, pm2.index + pm2[0].length - 1)
      if (!blk) continue
      const inner = blk.body

      // between = { a b }(两数,原样保留小数)
      let between: [number, number] = [NaN, NaN]
      const bm = /(?:^|\n)\s*between\s*=\s*\{/.exec(inner)
      if (bm) {
        const bb = takeBlock(inner, bm.index + bm[0].length - 1)
        if (bb) {
          const nums = (bb.body.match(/-?[\d.]+/g) || []).map(Number).filter((n) => Number.isFinite(n))
          if (nums.length >= 2) between = [nums[0], nums[1]]
        }
      }

      // temperature = { lo hi }(可负;缺失为 null)
      let temperature: [number, number] | null = null
      const tm = /(?:^|\n)\s*temperature\s*=\s*\{/.exec(inner)
      if (tm) {
        const tb = takeBlock(inner, tm.index + tm[0].length - 1)
        if (tb) {
          const nums = (tb.body.match(/-?[\d.]+/g) || []).map(Number).filter((n) => Number.isFinite(n))
          if (nums.length >= 2) temperature = [nums[0], nums[1]]
        }
      }

      // 其余 KEY = float(现象权重),按出现顺序;between/temperature 已单独取走
      const fields: { key: string; value: number }[] = []
      for (const m of inner.matchAll(/(?:^|\n)\s*([A-Za-z_0-9]+)\s*=\s*(-?[\d.]+)/g)) {
        const k = m[1]
        if (k === 'between' || k === 'temperature') continue
        fields.push({ key: k, value: Number(m[2]) })
      }

      weather.push({ between, temperature, fields })
    }
  }

  return { id, name, provinces, weather, navalTerrain, staticModifiers }
}

/**
 * 读生效的战略区域(目录级归属,机制与 buildStates 完全同款)。
 * 同时产出「省份 → 战略区域 id」映射:同一省被多个区声明时,
 * 按 effective 数组序后者覆盖(与游戏载入序一致),冲突只做诊断不阻断。
 */
export function buildStrategicRegions(
  roots: readonly SrcRoot[],
  res: ReturnType<typeof resolveDir>,
): { regions: StrategicRegionInfo[]; provToRegion: Map<number, number>; issues: MapIssue[] } {
  const issues: MapIssue[] = []
  const regions: StrategicRegionInfo[] = []
  const provToRegion = new Map<number, number>()
  const dupProv: Map<number, number[]> = new Map()

  for (const da of res.effective) {
    const abs = join(roots[da.effective].path, da.path)
    let text = ''
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      issues.push({
        kind: 'state-dropped',
        severity: 'error',
        msg: `战略区域文件读取失败:${da.path}`,
        roots: [da.effective],
        paths: [da.path],
      })
      continue
    }
    const parsed = parseStrategicRegionFile(da.name, text)
    if (!Number.isFinite(parsed.id)) {
      issues.push({
        kind: 'state-dropped',
        severity: 'warn',
        msg: `战略区域文件名/文件内 id 都取不到数字 id:${da.name}`,
        roots: [da.effective],
        paths: [da.path],
      })
      continue
    }
    const info: StrategicRegionInfo = {
      id: parsed.id,
      name: parsed.name,
      file: da.name,
      path: da.path,
      provinces: parsed.provinces,
      weather: parsed.weather,
      navalTerrain: parsed.navalTerrain,
      staticModifiers: parsed.staticModifiers,
      own: da.own as StrategicRegionInfo['own'],
      root: da.effective,
      chain: da.chain,
      dropped: false,
    }
    regions.push(info)
    for (const p of parsed.provinces) {
      const ex = dupProv.get(p)
      if (ex) ex.push(info.id)
      else dupProv.set(p, [info.id])
      // 后定义覆盖(数组序靠后 = 载入序靠后)
      provToRegion.set(p, info.id)
    }
  }

  const dupCount = [...dupProv.values()].filter((v) => v.length > 1).length
  if (dupCount) {
    issues.push({
      kind: 'owner-unknown',
      severity: 'warn',
      msg: `${dupCount} 个省份被多个战略区域同时声明(取数组序靠后者)`,
      roots: [],
      paths: [STRATEGIC_REGIONS_DIR],
    })
  }

  return { regions, provToRegion, issues }
}

/**
 * 读生效的国家定义。
 *
 * ══ ★ 这里曾经有个静默错误,实测才发现 ══
 * 旧实现按**文件名**当 tag:`Abkhazia.txt → ABKHAZIA`。
 * 但 HOI4 的 `common/countries/` 里存的是**国家全名**,442 个文件里
 * 0 个含顶层 `tag=` 字段。tag 的权威来源是
 *   `common/country_tags/*.txt`:`ENG = "countries/United Kingdom.txt"`
 * 于是旧实现 442 个 tag 全错 → 地图上 89 个真实国家(SOV 2414 个省份、
 * FRA 618、ENG 440 …)**全都无法着色**,而界面一声不响。
 *
 * 现在:① 先读 country_tags 建 tag→国家文件映射(目录级归属判定)
 *      ② country_tags 里没有的,回退到文件内 `tag =`(模组常这么写,
 *         尤其自建小国);③ 都没有才用文件名(会明确标 own 并可诊断)
 */
/** 取不到颜色时的占位灰。用具名常量而不是散落的字面量,
 *  便于诊断时精确识别"这批国家是没配色的"。*/
const GREY: [number, number, number] = [128, 128, 128]

function buildCountries(roots: readonly SrcRoot[]): { countries: CountryDef[]; issues: MapIssue[] } {
  const issues: MapIssue[] = []
  // ── ① tag → 相对路径(如 countries/United Kingdom.txt)
  const tagMap = new Map<string, string>()
  const tagDir = resolveDir(roots, 'common/country_tags')
  for (const da of tagDir.effective) {
    let text = ''
    try {
      text = readFileSync(join(roots[da.effective].path, da.path), 'utf8')
    } catch {
      continue
    }
    // `ENG = "countries/United Kingdom.txt"` —— 允许 tab / 多空格 / 路径含空格
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]+)"/)
      if (!m) continue
      const tag = m[1].toUpperCase()
      const rel = m[2].trim().toLowerCase()
      if (!tag || !rel) continue
      // 后载入的覆盖先载入的(与游戏一致)
      tagMap.set(tag, rel)
    }
  }

  // ── ② 逐个国家文件取颜色
  const cDir = resolveDir(roots, 'common/countries')
  // 相对路径 → 该文件对应的 tag(可能有多个 tag 指向同一国家,如 dynamic)
  const tagsByFile = new Map<string, string[]>()
  for (const [tag, rel] of tagMap) {
    const key = rel.replace(/^countries\//, '')
    const arr = tagsByFile.get(key)
    if (arr) arr.push(tag)
    else tagsByFile.set(key, [tag])
  }

  const countries: CountryDef[] = []
  const seenTag = new Set<string>()

  /* ★★★ 第三处颜色来源:集中式色彩表(2026-10-07 抓到, Kaiserreich 就是这样)
   *
   * HOI4 的国家颜色有两种完全不同的写法,必须都认:
   *
   *  A) 每国一个文件,单行 color = { r g b }
   *     原版 Germany.txt:  color = { 106 119 89 } # { 76 97 121 }
   *
   *  B) 所有国家挤在一个 colors.txt 里,块形态 + rgb 包装
   *     Kaiserreich common/countries/colors.txt(1039 行):
   *         ALB = {
   *             color = rgb { 168 28 35 }
   *             color_ui = rgb { 168 28 35 }
   *         }
   *
   * 旧实现只认 A,于是 B 型模组 **260/261 个国家全是灰默认色**,而界面一声不响。
   * 而且模组的 countries/ 目录里往往只有 WestEur.txt 这种**文化分组文件**
   * (只有 graphical_culture,没有 color),真正的颜色全在 colors.txt 里 ——
   * 靠"逐国家文件找 color"永远找不到。
   *
   * key 用大写 tag;后载入的覆盖先载入的(与游戏一致)。
   * 只取 color,不取 color_ui(后者是 UI 专用色,和地图色可能不同)。*/
  const palette = new Map<string, [number, number, number]>()

  /* ── ③.5 history/countries:国家历史文件(「用 VS Code 打开国家」定位用)──
   * 文件名形如 `ALB - Albania.txt`(前段即 tag)或 `ALB.txt`。
   * 用户报的需求:"定位国家应该打开 history\countries 中的对应内容" ——
   * 国家的开局科技/政党/军队都在那里,common/countries 只有配色。
   * effective 的遍历顺序 = 来源顺序(原版在前、模组在后),后写覆盖先写,
   * 与游戏加载顺序一致(最后一个提供同名/同 tag 文件的来源生效)。 */
  const histDir = resolveDir(roots, 'history/countries')
  const histByTag = new Map<string, { root: number; path: string }>()
  for (const da of histDir.effective) {
    const m = da.name.match(/^([A-Za-z0-9_]{2,5})\s*[-–—]/) || da.name.match(/^([A-Za-z0-9_]{2,5})\.txt$/i)
    if (!m) continue
    histByTag.set(m[1].toUpperCase(), { root: da.effective, path: `history/countries/${da.name}` })
  }

  /* ── ③ 先扫「集中色彩表」:任意 countries/*.txt 里的块形态 TAG = { color = rgb {...} } ──
   * 用配平花括号提取(不能用非配平正则 —— 块内还嵌着 rgb { })。*/
  for (const da of cDir.effective) {
    let text = ''
    try {
      text = readFileSync(join(roots[da.effective].path, da.path), 'utf8')
    } catch {
      continue
    }
    // 只在含 "rgb {" 的文件上做块扫描,避免对 442 个原版单行文件做无谓的括号配平
    if (!text.includes('rgb')) continue
    const re = /^\s*([A-Za-z0-9_]+)\s*=\s*\{/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const body = takeBlock(text, m.index + m[0].length - 1)
      if (!body) continue
      const c = body.body.match(/color\s*=\s*rgb\s*\{([^}]*)\}/)
      if (!c) continue
      const nums = (c[1].match(/-?[\d.]+/g) || []).map(Number).filter((n) => Number.isFinite(n))
      if (nums.length < 3) continue
      const mx = Math.max(...nums.slice(0, 3))
      const scale = mx > 0 && mx <= 1 ? 255 : 1
      palette.set(m[1].toUpperCase(), [
        Math.max(0, Math.min(255, Math.round(nums[0] * scale))),
        Math.max(0, Math.min(255, Math.round(nums[1] * scale))),
        Math.max(0, Math.min(255, Math.round(nums[2] * scale))),
      ])
    }
  }

  for (const da of cDir.effective) {
    const key = da.name.toLowerCase()
    // ★ colors.txt 是集中式色彩表(类型 B),颜色已在上面 step③ 扫进 palette,
    //   它本身不是一个国家文件:没有 country_tags 映射、也没有内部 tag=,
    //   落到回退分支会把文件名当 tag → 凭空造出假的「COLORS」国家。直接跳过。
    if (key === 'colors.txt') continue
    let text = ''
    try {
      text = readFileSync(join(roots[da.effective].path, da.path), 'utf8')
    } catch {
      continue
    }
    // ★ 配色优先级:① 集中色彩表里该 tag 的颜色(B 型模组唯一来源)
    //            ② 本文件里的单行 color = { ... }(原版 A 型)
    //            ③ 灰默认 —— 下面统一判一次,避免两处各判一遍漏掉
    let color: [number, number, number] | null = null
    const cm = text.match(/color\s*=\s*\{([^}]*)\}/)
    if (cm) {
      const nums = (cm[1].match(/-?[\d.]+/g) || []).map(Number).filter((n) => Number.isFinite(n))
      if (nums.length >= 3) {
        const mx = Math.max(...nums.slice(0, 3))
        const scale = mx > 0 && mx <= 1 ? 255 : 1
        color = [
          Math.max(0, Math.min(255, Math.round(nums[0] * scale))),
          Math.max(0, Math.min(255, Math.round(nums[1] * scale))),
          Math.max(0, Math.min(255, Math.round(nums[2] * scale))),
        ]
      }
    }
    // ★ 注释里的 `{ 76 97 121 }` 不能当成颜色 —— 正则只取 color = 后的第一组,已规避
    const nameField = (text.match(/^\s*name\s*=\s*"([^"]*)"/m) || [])[1] || da.name.replace(/\.txt$/i, '')
    const own = da.own as CountryDef['own']

    const tags = tagsByFile.get(key)
    if (tags?.length) {
      for (const tag of tags) {
        if (seenTag.has(tag)) continue
        seenTag.add(tag)
        // 同一国家文件可能对应多个 tag(如 IMP/NFA 都指向 WestEur.txt),
        // 但它们各有自己的颜色 —— 必须**逐 tag** 查色彩表,不能用文件级 color 兜一个
        countries.push({ tag, name: nameField, color: palette.get(tag) ?? color ?? GREY, root: da.effective, own, path: da.path, hist: histByTag.get(tag) ?? null })
      }
      continue
    }
    // 回退:文件内 tag =(模组常这么写)
    const inner = (text.match(/^\s*tag\s*=\s*"?([A-Za-z0-9_]+)"?/m) || [])[1]
    const tag = (inner || da.name.replace(/\.txt$/i, '')).toUpperCase()
    if (seenTag.has(tag)) continue
    seenTag.add(tag)
    countries.push({ tag, name: nameField, color: palette.get(tag) ?? color ?? GREY, root: da.effective, own, path: da.path, hist: histByTag.get(tag) ?? null })
    if (!inner && !tagsByFile.size) {
      issues.push({
        kind: 'owner-unknown',
        severity: 'warn',
        msg: `国家文件 ${da.name} 既不在 common/country_tags 里、文件内也没有 tag=,tag 只能取文件名「${tag}」—— 很可能对不上`,
        roots: [da.effective],
        paths: [da.path],
      })
    }
  }
  return { countries, issues }
}

/** 未配色的国家(占位灰)。这类国家在地图上是一片灰,是最容易被当成
 *  「工具坏了」的现象 —— 必须能在诊断里看到具体是哪些 tag。*/
function countriesWithoutColor(countries: CountryDef[]): CountryDef[] {
  return countries.filter((c) => c.color[0] === 128 && c.color[1] === 128 && c.color[2] === 128)
}

/** 某 tag 拥有多少省份(用于诊断排序:省份最多的国家最显眼) */
function ownerOfOfTag(ownerOf: Map<number, { owner?: string }>, tag: string): number {
  let n = 0
  for (const p of ownerOf.values()) if (p.owner && p.owner.toUpperCase() === tag) n++
  return n
}

export interface BuildMapModelInput {
  roots: readonly SrcRoot[]
  /** 各来源的 .mod 描述符(用于 replace_path;索引与 roots 对齐) */
  mods?: readonly ModDescriptor[]
  /** 已解码的 provinces.bmp(生效来源的那份) */
  bitmap: { w: number; h: number; rgba: Uint8Array }
  /** 生效 definition.csv 的文本 */
  definitionCsv: string
}

/** 测试导出:states 文件解析(语义单测需要直接打这一个函数) */
export function parseStateFileForTest(file: string, text: string): ReturnType<typeof parseStateFileFull> {
  return parseStateFileFull(file, text)
}

/**
 * 合成地图模型。
 *
 * @param bitmap 必须来自**生效**的 provinces.bmp(调用方先用 resolveAssets 判定),
 *               否则颜色→省份 id 的映射与位图来自不同来源,质心会全错。
 */
export function buildMapModel(input: BuildMapModelInput): MapModel {
  const roots = input.roots
  const issues: MapIssue[] = []

  // ① 地图资产归属(文件级)
  const assets = resolveAssets(roots, MAP_ASSETS as readonly string[])

  // ② definition.csv:颜色 → 省份 id;同时解析全部 8 列
  //    (id;r;g;b;type;coastal;terrain;continent)。type=land/sea/lake、
  //    coastal=true/false、terrain=内部名、continent=数字(0-7,0=无大陆)。
  const colorToId = new Map<number, number>()
  const provDef = new Map<number, { type: 'land' | 'sea' | 'lake'; coastal: boolean; terrain: string | null; continent: string | null }>()

  // 生效来源的 map/continent.txt(文件级资产已在 MAP_ASSETS 里)→ 数字到大陆名。
  //   顺序即大陆 id:第 1 个 = 1 … 第 7 个 = 7;definition.csv 里 0 → 无大陆。
  const continentNames: string[] = []
  const contRef = assets.refs.get('map/continent.txt')
  if (contRef && contRef.effective >= 0) {
    try {
      const ctext = readFileSync(join(roots[contRef.effective].path, contRef.path), 'utf8')
      const cm = /continents\s*=\s*\{([^}]*)\}/.exec(ctext)
      if (cm) for (const tok of cm[1].split(/\s+/)) if (tok) continentNames.push(tok)
    } catch {
      // 读不到就全部置 null,不阻断
    }
  }
  const continentNameOf = (ci: number): string | null => {
    if (!Number.isFinite(ci) || ci <= 0) return null
    return continentNames[ci - 1] ?? null
  }

  for (const line of input.definitionCsv.split('\n')) {
    const pp = line.split(';')
    if (pp.length < 4) continue
    const id = parseInt(pp[0], 10)
    const r = parseInt(pp[1], 10), g = parseInt(pp[2], 10), b = parseInt(pp[3], 10)
    if (!Number.isFinite(id) || !Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue
    colorToId.set((r << 16) | (g << 8) | b, id)
    if (pp.length >= 5) {
      const typeRaw = (pp[4] || '').trim()
      const type: 'land' | 'sea' | 'lake' = typeRaw === 'sea' || typeRaw === 'lake' ? typeRaw : 'land'
      const coastal = (pp[5] || '').trim() === 'true'
      const terrainRaw = (pp[6] || '').trim()
      const terrain = terrainRaw || null
      const ci = parseInt((pp[7] || '0').trim(), 10)
      provDef.set(id, { type, coastal, terrain, continent: continentNameOf(ci) })
    }
  }

  // ③ 质心:一次遍历按颜色聚合(positions.txt 在 vanilla 安装里是空文件)
  const { w, h, rgba } = input.bitmap
  const sx = new Map<number, number>(), sy = new Map<number, number>(), cnt = new Map<number, number>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const pid = colorToId.get((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2])
      if (pid === undefined) continue
      sx.set(pid, (sx.get(pid) || 0) + x)
      sy.set(pid, (sy.get(pid) || 0) + y)
      cnt.set(pid, (cnt.get(pid) || 0) + 1)
    }
  }

  // ④ states(目录级)
  const statesDir = resolveDir(roots, STATES_DIR)
  if (statesDir.effective.length === 0) {
    issues.push({
      kind: 'states-missing',
      severity: 'error',
      msg: `生效的 ${STATES_DIR} 为空 —— 省份归属无从判定(检查 replace_path 是否把原版 states 全删了)`,
      roots: [],
      paths: [STATES_DIR],
    })
  }
  const { states, ownerOf, issues: stIssues } = buildStates(roots, statesDir)
  issues.push(...stIssues)
  if (statesDir.dropped.length) {
    // 按声明者分组;采样只用于列例,**真实总数必须取全量**(曾经错写成 samples.length)
    const byRoot = new Map<number, string[]>()
    for (const d of statesDir.dropped) {
      const r = d.deletedBy.length ? Math.max(...d.deletedBy) : -1
      const arr = byRoot.get(r)
      if (arr) arr.push(d.name)
      else byRoot.set(r, [d.name])
    }
    for (const [r, names] of byRoot) {
      const rn = r >= 0 ? roots[r]?.name : '?'
      issues.push({
        kind: 'state-dropped',
        severity: 'warn',
        msg: `「${rn}」声明了 replace_path 覆盖 ${STATES_DIR},导致原版 ${names.length} 个 state 在游戏里不存在(例:${names.slice(0, 5).join(', ')})`,
        roots: r >= 0 ? [r] : [],
        paths: [STATES_DIR],
      })
    }
  }

  // ④b 战略区域(目录级,与 states 同款)→ regions 列表 + 省份→区域映射
  const srDir = resolveDir(roots, STRATEGIC_REGIONS_DIR)
  const { regions: strategicRegions, provToRegion, issues: srIssues } = buildStrategicRegions(roots, srDir)
  issues.push(...srIssues)
  if (srDir.dropped.length) {
    // 与 states 同款:按 replace_path 声明者分组报
    const byRoot = new Map<number, string[]>()
    for (const d of srDir.dropped) {
      const r = d.deletedBy.length ? Math.max(...d.deletedBy) : -1
      const arr = byRoot.get(r)
      if (arr) arr.push(d.name)
      else byRoot.set(r, [d.name])
    }
    for (const [r, names] of byRoot) {
      const rn = r >= 0 ? roots[r]?.name : '?'
      issues.push({
        kind: 'state-dropped',
        severity: 'warn',
        msg: `「${rn}」声明了 replace_path 覆盖 ${STRATEGIC_REGIONS_DIR},导致原版 ${names.length} 个战略区域在游戏里不存在(例:${names.slice(0, 5).join(', ')})`,
        roots: r >= 0 ? [r] : [],
        paths: [STRATEGIC_REGIONS_DIR],
      })
    }
  }

  // ⑤ 国家定义 → 颜色
  const { countries, issues: cIssues } = buildCountries(roots)
  issues.push(...cIssues)
  const countryTagSet = new Set(countries.map((c) => c.tag))

  // ⑥ 无主省份诊断:state 里有、但 countries 里没有这个 tag
  const unknownOwners = new Map<string, number>()
  for (const p of ownerOf.values()) {
    if (p.owner && !countryTagSet.has(p.owner.toUpperCase())) unknownOwners.set(p.owner, (unknownOwners.get(p.owner) || 0) + 1)
  }
  if (unknownOwners.size) {
    const rows = [...unknownOwners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    issues.push({
      kind: 'owner-unknown',
      severity: 'warn',
      msg: `${unknownOwners.size} 个 owner 在生效的 common/countries 里没有定义(无法着色),例:${rows.map(([t, n]) => `${t}(${n})`).join(', ')}`,
      roots: [],
      paths: ['common/countries'],
    })
  }

  // ⑦ 未配色国家诊断(灰默认色 = 地图上是一片灰)
  //    ★ 这条与 ⑥ 的区别:⑥ 是"这个 tag 连国家定义都没有";
  //      ⑦ 是"国家定义在,但 color 字段取不到" —— 病因完全不同
  //      (典型:模组用 colors.txt 集中配色,旧解析器只认单行 color = { })
  const colorless = countriesWithoutColor(countries)
  if (colorless.length) {
    const rows = colorless
      .map((c) => ({ c, n: ownerOfOfTag(ownerOf, c.tag) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
    issues.push({
      kind: 'owner-unknown',
      severity: colorless.length > countries.length / 2 ? 'error' : 'warn',
      msg:
        `${colorless.length}/${countries.length} 个国家没取到 color(地图上显示为灰色)。` +
        `占省份最多的:${rows.map((r) => `${r.c.tag}(${r.n} 省)`).join(', ')}。` +
        `常见病因:模组把颜色集中在 colors.txt 里用块形态 color = rgb { r g b } 书写。`,
      roots: [],
      paths: ['common/countries'],
    })
  }

  // ⑧ 资产缺口诊断(replace_path 声明了却没提供文件)
  for (const g of assets.gaps) {
    const by = new Map<number, string[]>()
    for (const x of g.gapBy) {
      const arr = by.get(x.root) || []
      arr.push(x.replacePath)
      by.set(x.root, arr)
    }
    const who = [...by.entries()].map(([r, rps]) => `「${roots[r]?.name ?? '?'}」的 replace_path="${rps.join('","')}"`).join('、')
    issues.push({
      kind: 'asset-gap',
      severity: 'error',
      msg: `${who} 声明替换 ${g.path},但没提供该文件 → 游戏里这个文件不存在`,
      roots: [...by.keys()],
      paths: [g.path],
    })
  }

  // ⑧ 省份列表(带质心 + 归属 + definition.csv 全字段 + 所属战略区)
  const provinces = [...cnt.entries()].map(([pid, c]) => {
    const oi = ownerOf.get(pid)
    const pd = provDef.get(pid)
    return {
      id: pid,
      x: Math.round(sx.get(pid)! / c),
      y: Math.round(sy.get(pid)! / c),
      owner: oi?.owner ?? '',
      stateId: oi?.stateId ?? -1,
      own: oi?.own ?? 'vanilla',
      type: pd?.type ?? 'land' as const,
      coastal: pd?.coastal ?? false,
      terrain: pd?.terrain ?? null,
      continent: pd?.continent ?? null,
      strategicRegionId: provToRegion.get(pid) ?? null,
    }
  })
  provinces.sort((a, b) => a.id - b.id)

  // ⑨ 各来源贡献
  const sources = roots.map((r, i) => {
    let mapAssets = 0, st = 0, co = 0, sr = 0
    for (const ref of assets.refs.values()) if (ref.effective === i) mapAssets++
    for (const s of states) if (s.root === i) st++
    for (const s of strategicRegions) if (s.root === i) sr++
    for (const c of countries) if (c.root === i) co++
    let gaps = 0
    for (const g of assets.gaps) if (g.gapBy.some((x) => x.root === i)) gaps++
    return {
      index: i,
      name: r.name,
      path: r.path,
      writable: r.writable,
      replacePaths: [...(r.replacePaths ?? [])],
      mapAssets,
      states: st,
      strategicRegions: sr,
      countries: co,
      gaps,
    }
  })

  const owners = new Set<string>()
  for (const p of provinces) if (p.owner) owners.add(p.owner)

  return {
    ready: true,
    w,
    h,
    provinces,
    countries,
    states,
    ownerOf,
    strategicRegions,
    assets,
    statesDir: { effective: statesDir.effective, dropped: statesDir.dropped, stats: statesDir.stats },
    strategicRegionsDir: { effective: srDir.effective, dropped: srDir.dropped, stats: srDir.stats },
    sources,
    stats: {
      provinces: provinces.length,
      owners: owners.size,
      states: states.length,
      assetsVanilla: assets.stats.vanilla,
      assetsOverride: assets.stats.override,
      assetsNew: assets.stats.new,
      assetGaps: assets.stats.gap,
      statesDropped: statesDir.stats.dropped,
    },
    issues,
  }
}

/**
 * ★ 诊断:检查一组模组声明的 replace_path 是否造成缺口(不构建地图,纯静态检查)。
 * 供 `/api/modmeta` 用 —— 用户挂载模组后立刻能看到"这个模组会让哪些原版文件消失"。
 */
export function auditReplacePaths(roots: readonly SrcRoot[], mods: readonly ModDescriptor[]): {
  gaps: { mod: string; replacePath: string; missing: string[] }[]
  droppedStates: { mod: string; count: number }[]
} {
  const gaps: { mod: string; replacePath: string; missing: string[] }[] = []
  const droppedStates: { mod: string; count: number }[] = []

  for (let i = 0; i < roots.length; i++) {
    const rps = roots[i].replacePaths
    if (!rps?.length) continue
    const mod = mods.find((m) => m.dir === roots[i].path)
    const modName = mod?.name || roots[i].name
    for (const rp of rps) {
      // 只审 map/ 与 history/states —— 其它目录(628 条 common/*)由 cwt 规则覆盖,
      // 逐目录比对成本高且收益低,地图与 states 才是当前主诉求。
      if (!rp.startsWith('map') && !rp.startsWith('history/states')) continue
      const abs = join(roots[i].path, rp)
      // 原版侧存在的文件
      const baseIdx = roots.findIndex((x) => !x.writable)
      if (baseIdx < 0 || baseIdx === i) continue
      const baseFiles = listFilesOf(roots[baseIdx].path, rp)
      if (!baseFiles.length) continue
      const own = new Set(listFilesOf(roots[i].path, rp).map((x) => x.toLowerCase()))
      const missing = baseFiles.filter((f) => !own.has(f.toLowerCase()))
      if (missing.length) {
        gaps.push({ mod: modName, replacePath: rp, missing: missing.slice(0, 30) })
      }
      if (rp === 'history/states' || rp.startsWith('history/states/')) {
        if (missing.length) droppedStates.push({ mod: modName, count: missing.length })
      }
    }
  }
  return { gaps, droppedStates }
}

function listFilesOf(rootPath: string, relDirRaw: string): string[] {
  const relDir = normRelPath(relDirRaw)
  const abs = join(rootPath, relDir)
  const out: string[] = []
  const walk = (d: string, pre: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = pre ? `${pre}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else out.push(rel)
    }
  }
  walk(abs, relDir)
  return out
}