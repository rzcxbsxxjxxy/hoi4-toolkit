/**
 * DLCSRC_V1 —— DLC 作为**可选来源层**,以及 DLC 门控的识别。
 *
 * ══ 实测结论(2026-10-07,本机 1.19.3 "Operation Postern")══
 *  30 个 `dlc/dlcNNN_*` 目录 + 4 个 `integrated_dlc/*` 目录里,
 *  **只有 gfx/interface/music/sound/portraits/thumbnail.png** ——
 *  `find -name "*.txt" -o -name "*.lua"` 全 DLC 目录只命中 54 个文件,
 *  而且**没有一个在 history/ 或 common/ 下**。
 *  `find <game> -type d -name states` 全盘只命中 1 个:`<game>/history/states`。
 *  → 本机安装的 DLC **不带数据目录**,DLC 内容已由本体承担。
 *
 *  但机制不能因此就不做:
 *   ① 别的安装(以及旧版本 / 玩家手动解压的 DLC)确实会出现
 *      `dlc/dlc049_no_compromise_no_surrender/history/states/*.txt`。
 *      游戏加载器把 DLC 目录当作**插在本体之后、模组之前**的来源层,
 *      DLC 的同名 state 直接覆盖本体 —— 这正是用户说的
 *      「地图归属会随 DLC 变化」的机制来源。
 *   ② 即使数据已并入本体,**门控仍然真实存在**:实测 77 个 state 文件含
 *      `has_dlc = "..."`(如 1021 新加坡的 naval_headquarters)。
 *      没买 DLC 时那些格子在游戏里是空的 —— 工具必须标出来,
 *      否则会让人以为"这个国家海军 HQ 不存在"。
 *
 * ══ 两条机制的处理══
 *   A. DLC 来源层:扫描 gameRoot 下的 dlc 与 integrated_dlc 两个容器目录,
 *      凡含 history/states 或 map 的目录,登记为候选来源(默认不启用,
 *      由用户在地图页勾选)。启用后插入到「本体之后、模组之前」。
 *   B. has_dlc 门控:由 mapmodel 解析 state 时收集 dlcGated,
 *      本模块负责「DLC 名 → 是否启用」的判定,并从 .dlc 描述符取正式名。
 *
 * `.dlc` 描述符格式(实测 dlc049.dlc):
 *   name = "No Compromise, No Surrender"
 *   path = dlc/dlc049_no_compromise_no_surrender/
 *   steam_id = "3796260"
 *   affects_checksum = yes
 * ⚠ `name` 才是游戏里 has_dlc 用的名字,与目录名 dlc049_... 无关,
 *   也与 dlc_metadata/dlc_info/00_dlc_info.txt 里的写法一致。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** DLC 描述符(解析自 <dlcDir>/<name>.dlc) */
export interface DlcDescriptor {
  /** 目录名,如 dlc049_no_compromise_no_surrender */
  dir: string
  /** .dlc 里的 name —— ★ has_dlc 比对用的就是它 */
  name: string
  /** .dlc 里的 path(相对 gameRoot) */
  path?: string
  steamId?: string
  /** 目录绝对路径 */
  abs: string
  /** 该 DLC 是否带数据目录(history/states 或 map)—— 实测本机 30 个全为 false */
  hasData: boolean
  /** 带数据时的 states 文件数 / map 资产数 */
  statesCount: number
  mapAssetsCount: number
  /** 扫描时发现的其它子目录名(gfx/interface/music…) */
  subdirs: string[]
  /** 读取 .dlc 失败时的原因 */
  warn?: string
}

/** 一条 DLC 归属变化线索 */
export interface DlcGateRef {
  /** 出现门控的 state id */
  stateId: number
  stateName: string
  /** 门控的 DLC 名(原文) */
  dlc: string
  /** 被门控的对象类型 */
  kind: 'building' | 'victory_point' | 'other'
  /** 对象标识(建筑名 / 省份 id) */
  what: string
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function countFiles(dir: string, exts: readonly string[]): number {
  let n = 0
  for (const f of safeReaddir(dir)) {
    const lower = f.toLowerCase()
    if (exts.some((e) => lower.endsWith(e))) n++
  }
  return n
}

/** 解析 .dlc 描述符(键 = 行首 key = value,注释 # 与 -- 都要剥) */
function parseDlcDescriptor(dir: string, abs: string, subdirs: string[]): DlcDescriptor {
  const base = dir.split(/[\\/]/).pop() ?? dir
  const out: DlcDescriptor = { dir: base, name: base, abs, hasData: false, statesCount: 0, mapAssetsCount: 0, subdirs }
  // 描述符文件名通常与目录同名前缀:`dlc049.dlc` vs `dlc049_no_compromise_no_surrender`
  const cands = safeReaddir(abs).filter((f) => f.toLowerCase().endsWith('.dlc'))
  if (!cands.length) {
    out.warn = '目录内没有 .dlc 描述符'
    return out
  }
  const file = join(abs, cands[0])
  let txt = ''
  try {
    txt = readFileSync(file, 'utf8')
  } catch (e) {
    out.warn = '读取失败:' + (e as Error).message
    return out
  }
  for (const line of txt.split(/\r?\n/)) {
    const t = line.replace(/(^|[^"])#.*$/, (m, p1) => p1).replace(/\s*--.*$/, '').trim()
    const m = /^([A-Za-z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(t)
    if (!m) continue
    const k = m[1]
    const v = m[2].trim()
    if (k === 'name' && v) out.name = v
    else if (k === 'path' && v) out.path = v
    else if (k === 'steam_id' && v) out.steamId = v
  }
  return out
}

/**
 * 扫描 gameRoot 下的所有 DLC 目录。
 *
 * @param gameRoot 游戏根目录(只读来源的 path)
 * @param dirs     要扫的容器目录,默认 ['dlc','integrated_dlc']
 *        ⚠ 两个容器都要扫:实测本机 `integrated_dlc/` 里还有 4 个 DLC
 *          (tfv / dod / wtt / mtg),它们不在 dlc/ 下,漏了会少一半。
 */
export function scanDlcDirs(gameRoot: string, dirs: readonly string[] = ['dlc', 'integrated_dlc']): DlcDescriptor[] {
  const out: DlcDescriptor[] = []
  for (const container of dirs) {
    const cdir = join(gameRoot, container)
    if (!existsSync(cdir)) continue
    for (const name of safeReaddir(cdir)) {
      const abs = join(cdir, name)
      try {
        if (!statSync(abs).isDirectory()) continue
      } catch {
        continue
      }
      const subdirs = safeReaddir(abs).filter((f) => {
        try {
          return statSync(join(abs, f)).isDirectory()
        } catch {
          return false
        }
      })
      const d = parseDlcDescriptor(name, abs, subdirs)
      // ★ 只有带数据的 DLC 才是"来源层"。30 个纯资源 DLC 一律 hasData=false,
      //   不参与地图合成 —— 否则会给每张图挂 30 个空来源。
      const statesDir = join(abs, 'history', 'states')
      const mapDir = join(abs, 'map')
      const hasStates = existsSync(statesDir)
      const hasMap = existsSync(mapDir)
      if (hasStates || hasMap) {
        d.hasData = true
        d.statesCount = hasStates ? countFiles(statesDir, ['.txt']) : 0
        d.mapAssetsCount = hasMap ? countFiles(mapDir, ['.bmp', '.csv', '.txt']) : 0
      }
      out.push(d)
    }
  }
  return out
}

/** 汇总:有多少 DLC 带数据、带 states、带 map */
export function summarizeDlc(list: readonly DlcDescriptor[]) {
  return {
    total: list.length,
    withData: list.filter((d) => d.hasData).length,
    withStates: list.filter((d) => d.statesCount > 0).length,
    withMap: list.filter((d) => d.mapAssetsCount > 0).length,
    /** 缺描述符的目录(名字只能取目录名,has_dlc 比对会对不上) */
    unnamed: list.filter((d) => d.name === d.dir).map((d) => d.dir),
    /** 有数据但没描述符 → 没法按正式名门控,必须报出来 */
    dataNoDesc: list.filter((d) => d.hasData && d.name === d.dir).map((d) => d.dir),
  }
}

/**
 * DLC 名匹配:把 has_dlc 写的名字对上 DLC 描述符。
 *
 * ⚠ 实测坑:目录名 ≠ DLC 名。
 *   目录 `dlc049_no_compromise_no_surrender` → 正式名 `No Compromise, No Surrender`
 *   has_dlc 里写的是**正式名**。所以门控判定必须查描述符的 name,
 *   拿目录名去比对会 100% 失配 → 所有 DLC 门控都被当成"未拥有"。
 */
export function matchDlc(gateName: string, list: readonly DlcDescriptor[]): DlcDescriptor | null {
  const g = gateName.trim().toLowerCase()
  if (!g) return null
  for (const d of list) if (d.name.toLowerCase() === g) return d
  // 退化:忽略标点与空格再比一次(实测手写常有细微差异)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const d of list) if (norm(d.name) === norm(g)) return d
  return null
}

/**
 * 把 state 里收集到的门控整理成可展示的清单。
 *
 * @param states      mapmodel 解析出的 state(含 buildings[].dlc)
 * @param dlcs        扫描到的 DLC 列表
 * @param enabledDlc  用户勾选启用的 DLC **目录名**集合(不是正式名)
 */
export function collectDlcGates(
  states: readonly {
    id: number
    name: string
    buildings?: { id: string; level: number; dlc?: string }[]
    victoryPoints?: [number, number][]
    dlcGated?: string[]
  }[],
  dlcs: readonly DlcDescriptor[],
  enabledDlc: ReadonlySet<string> = new Set(),
): { refs: DlcGateRef[]; byDlc: Record<string, { name: string; dir?: string; count: number; active: boolean }> } {
  const refs: DlcGateRef[] = []
  const byDlc: Record<string, { name: string; dir?: string; count: number; active: boolean }> = {}
  const bump = (g: string) => {
    const hit = matchDlc(g, dlcs)
    if (!byDlc[g]) byDlc[g] = { name: g, dir: hit?.dir, count: 0, active: enabledDlc.has(hit?.dir ?? '') }
    byDlc[g].count++
  }
  for (const st of states) {
    const local = new Set<string>()
    for (const b of st.buildings ?? []) {
      if (!b.dlc) continue
      refs.push({ stateId: st.id, stateName: st.name, dlc: b.dlc, kind: 'building', what: b.id })
      local.add(b.dlc)
    }
    // state 里有门控但没挂到具体建筑上(如 allowed{} 出现在别处)
    for (const g of st.dlcGated ?? []) {
      if (local.has(g)) continue
      refs.push({ stateId: st.id, stateName: st.name, dlc: g, kind: 'other', what: '(未定位到具体对象)' })
      local.add(g)
    }
    for (const g of local) bump(g)
  }
  return { refs, byDlc }
}
