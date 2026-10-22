/**
 * ASSETSRC_V1 —— 「某个文件最终由哪个来源提供」的**唯一判定入口**。
 *
 * ══ 判定的三条规则(与 HOI4 加载器一致)══
 *
 *  ① **文件级覆盖**:同相对路径,载入序靠后的来源整份替换靠前的。
 *     这条 ownership.ts 已经用 `effectiveSet` 表达了(条目级),本模块处理文件级。
 *
 *  ② **目录级删除(replace_path)**:模组写了 `replace_path="X"` 时,
 *     **所有低优先级来源在 X 目录下的文件整体失效** —— 不是被覆盖,是**不存在**。
 *     区别很实际:被覆盖的原版文件还能在"覆盖链"里看到影子;
 *     被 replace_path 删掉的原版文件在游戏里彻底没了,工具若还显示它就是**假象**。
 *
 *     ⚠ 陷阱:replace_path 的删除**不要求模组自己提供同名文件**。
 *     实测(36 个创意工坊模组 / 745 条 replace_path):
 *       · `replace_path="map"`(BlackICE 1137372539)→ vanilla map/ 下 115 个文件消失
 *       · `replace_path="history/states"`(Kaiserreich 1521695605)→ 1081 个 state **全被丢弃**
 *     也就是说:声明了 replace_path 又没提供文件 = 制造缺口。
 *     本模块把这类缺口算成 `gap`,让 UI 能报出来。
 *
 *  ③ **新增**:文件只存在于高优先级来源,低优先级没有 → 纯新增。
 *
 * ══ Wiki 口径备注(2026-10 快照)══
 *   Wiki 称 replace_path "only applies to files directly within that folder,
 *   any sub-folders will left untouched" —— 即只卸载声明目录下的**直接**文件。
 *   本模块的 replacePathCovers 按子树匹配(超集,保守不遗漏):UI 展示缺口时
 *   会把"子文件夹文件"单独标注,说明在 Wiki 口径下可能未受影响。
 * ══ 与 ownership.ts 的边界 ══
 *   ownership.ts:条目级(决议/科技/国策 …),键是 id
 *   本模块:文件级 + 目录级,键是相对路径
 *   两者对"覆盖"的定义一致(载入序靠后者胜),本模块额外处理 replace_path 删除。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normRelPath, replacePathCovers, replacePathsHitting, type NormPath } from './modmeta.ts'

/** 参与判定的来源(与 server.ts 的 Root 对齐) */
export interface SrcRoot {
  name: string
  path: string
  /** 只读=基础游戏。**覆盖优先级的唯一判据是载入序(数组下标),不是这个** */
  writable: boolean
  /** 该来源 .mod 里规范化后的 replace_path 列表 */
  replacePaths?: readonly NormPath[]
}

/** 参与判定的来源的宽松形态:功能模块的 Root 只需 name/path,可带 writable/replacePaths。
 *  writable 缺省时按「基础游戏」处理(只影响 own 分类,不影响 replace_path 卸载判定)。 */
export interface SrcRootLike {
  name: string
  path: string
  writable?: boolean
  replacePaths?: readonly NormPath[]
}

export type FileOwn = 'vanilla' | 'override' | 'new' | 'gap'

/** 单个相对路径的解析结果 */
export interface AssetRef {
  /** 规范化相对路径,如 `map/provinces.bmp` */
  path: string
  /** 最终生效的来源下标;gap 时为 -1 */
  effective: number
  /** 三态归属 */
  own: FileOwn
  /** 提供该文件的所有来源下标(按载入序,含被 replace_path 删掉的) */
  chain: number[]
  /** 被更高优先级同名文件覆盖掉的来源(影子) */
  shadowed: number[]
  /** ★ 因更高优先级来源声明了 replace_path 而失效的来源(不是影子,是删除) */
  deletedBy: number[]
  /** ★ 声明 replace_path 导致该文件在游戏里彻底缺失(=真缺陷) */
  gap: boolean
  /** 造成 gap 的那些 replace_path 声明(用于报错文案) */
  gapBy: { root: number; replacePath: NormPath }[]
}

export interface AssetResolution {
  refs: Map<string, AssetRef>
  /** 统计 */
  stats: {
    total: number
    vanilla: number
    override: number
    new: number
    /** ★ 声明 replace_path 却没提供文件 → 游戏里真的缺东西 */
    gap: number
  }
  /** 全部缺口明细(按来源分组,便于 UI 直接渲染) */
  gaps: AssetRef[]
}

/** 读一个来源下的文件是否存在 */
function hasFile(root: SrcRoot, rel: string): boolean {
  try {
    return existsSync(join(root.path, rel))
  } catch {
    return false
  }
}

/**
 * ★ 单个相对路径的逐来源判定(唯一核心)。
 *
 * resolveAssets / resolveDir / collectDirRecursive 共用这一份口径,
 * 保证 replace_path 的删除语义在「文件级 / 目录级 / 递归收集」三处完全一致。
 *
 * @param roots  已加载来源,**顺序即载入序**(基础游戏在前,模组在后,靠后者优先)
 * @param rel    规范化后的相对路径
 * @param exists 判定某来源是否提供该文件
 */
function resolveOneRel(roots: readonly SrcRootLike[], rel: string, exists: (i: number, rel: string) => boolean): AssetRef {
  // 提供该文件的所有来源(按载入序)
  const chain: number[] = []
  for (let i = 0; i < roots.length; i++) if (exists(i, rel)) chain.push(i)

  // 被 replace_path 删除的来源:存在 j > i 且 j 声明了覆盖 rel 的 replace_path
  const deletedBy: number[] = []
  for (let i = 0; i < roots.length; i++) {
    if (chain.includes(i)) continue
    if (!roots[i].replacePaths?.length) continue
    if (replacePathCovers(roots[i].replacePaths!, rel)) deletedBy.push(i)
  }

  // ★ 缺口:最高优先级的那个 replace_path 声明者**自己不提供**这个文件
  //   → 游戏里该文件不存在。这是真缺陷,必须报。
  let gap = false
  const gapBy: { root: number; replacePath: NormPath }[] = []
  if (deletedBy.length) {
    const top = Math.max(...deletedBy)
    const hits = replacePathsHitting(roots[top].replacePaths!, rel)
    // 在 top 之下、且比 top 更优先的其它声明者也可能造成缺口 —— 一并记录
    for (const j of deletedBy) {
      for (const rp of replacePathsHitting(roots[j].replacePaths!, rel)) gapBy.push({ root: j, replacePath: rp })
    }
    // 只有当「所有声明者都不提供」时才是缺口。
    // 若某个声明者自己提供了文件,那它就是生效来源(见下)。
    gap = !chain.some((i) => i >= top)
    if (!hits.length) gapBy.length = 0
  }

  // 生效来源 = 提供该文件的最高优先级者(载入序最大)
  let effective = -1
  let own: FileOwn = 'gap'
  if (chain.length) {
    effective = chain[chain.length - 1]
    const hasBase = chain.some((i) => !roots[i].writable)
    own = !hasBase ? 'new' : !roots[effective].writable ? 'vanilla' : 'override'
    // ★ 但如果生效来源**低于**某个 replace_path 声明者,那它本该被删除。
    //   这种情况只在「声明者自己没提供、而更低的来源提供了」时出现,
    //   游戏里该文件其实不存在 → 仍算 gap。
    if (deletedBy.length && effective < Math.max(...deletedBy)) {
      own = 'gap'
      effective = -1
      gap = true
    }
  }

  return {
    path: rel,
    effective,
    own,
    chain,
    shadowed: effective >= 0 ? chain.filter((i) => i !== effective) : chain,
    deletedBy,
    gap,
    gapBy,
  }
}

/**
 * 判定一批相对路径的来源。
 *
 * @param roots  已加载来源,**顺序即载入序**(基础游戏在前,模组在后,靠后者优先)
 * @param paths  要判定的相对路径集合(大小写/斜杠不敏感,内部会规范化)
 */
export function resolveAssets(roots: readonly SrcRoot[], paths: Iterable<string>, fileExists?: (rootIdx: number, rel: string) => boolean): AssetResolution {
  const exists = fileExists ?? ((i: number, rel: string) => hasFile(roots[i], rel))
  const normed = new Set<string>()
  for (const p of paths) {
    const n = normRelPath(p)
    if (n) normed.add(n)
  }

  const refs = new Map<string, AssetRef>()
  const gaps: AssetRef[] = []
  let nVanilla = 0, nOverride = 0, nNew = 0, nGap = 0

  for (const rel of normed) {
    // ★ 逐 rel 判定走唯一核心(与 collectDirRecursive 同一份逻辑)
    const ref = resolveOneRel(roots, rel, exists)
    refs.set(rel, ref)
    if (ref.own === 'gap') { nGap++; gaps.push(ref) }
    else if (ref.own === 'vanilla') nVanilla++
    else if (ref.own === 'override') nOverride++
    else nNew++
  }

  return {
    refs,
    stats: { total: refs.size, vanilla: nVanilla, override: nOverride, new: nNew, gap: nGap },
    gaps,
  }
}

/**
 * ★ 目录级判定:`dir` 这个目录在每个来源下"实际还有效"的相对文件列表。
 *
 * 用于 `history/states`、`map/strategicregions` 这类
 * 「每个文件是一个实体、实体之间靠文件名区分」的目录:
 * 文件级覆盖在这里就是**同文件名整份替换**,语义与 replace_path 无关。
 *
 * @param relDir 规范化后的目录,如 `history/states`
 * @returns 生效文件列表(按文件名) + 每个文件的归属
 */
export interface DirAsset {
  /** 文件名(含扩展名,如 `1-france.txt`) */
  name: string
  /** 相对路径 */
  path: string
  own: FileOwn
  effective: number
  /** 提供它的所有来源(载入序) */
  chain: number[]
  /** 因 replace_path 被删除的来源 */
  deletedBy: number[]
}

export interface DirResolution {
  /** 生效文件(游戏里真实存在的) */
  effective: DirAsset[]
  /** 因 replace_path 声明而从原版删掉的文件(游戏里不存在,但原版磁盘上有) */
  dropped: DirAsset[]
  stats: {
    effective: number
    vanilla: number
    override: number
    new: number
    dropped: number
  }
}

/**
 * 判定一个「一文件一实体」目录。
 *
 * 与 `resolveAssets` 的区别:这里主动**枚举**磁盘上的全部文件名
 * (union 所有来源),而不是让调用方给路径列表 —— 因为 `history/states`
 * 有上千个文件,没人会手写清单。
 */
export function resolveDir(roots: readonly SrcRoot[], relDirRaw: string): DirResolution {
  const relDir = normRelPath(relDirRaw)
  // 各来源下的文件名集合
  const byRoot: string[][] = roots.map((r) => listNames(join(r.path, relDir)))
  const allNames = new Map<string, string>() // 小写名 → 原名(取首个来源的写法)
  for (const list of byRoot) {
    for (const nm of list) {
      const k = nm.toLowerCase()
      if (!allNames.has(k)) allNames.set(k, nm)
    }
  }

  const effective: DirAsset[] = []
  const dropped: DirAsset[] = []
  let nVanilla = 0, nOverride = 0, nNew = 0

  for (const [k, name] of allNames) {
    const rel = relDir ? `${relDir}/${k}` : k
    const chain: number[] = []
    for (let i = 0; i < roots.length; i++) if (byRoot[i].some((x) => x.toLowerCase() === k)) chain.push(i)
    const deletedBy: number[] = []
    for (let i = 0; i < roots.length; i++) {
      if (chain.includes(i)) continue
      if (!roots[i].replacePaths?.length) continue
      if (replacePathCovers(roots[i].replacePaths!, rel)) deletedBy.push(i)
    }

    // ★ 无任何来源提供 + 有 replace_path 声明 → 游戏里这个实体不存在
    if (!chain.length) {
      if (deletedBy.length) dropped.push({ name, path: rel, own: 'gap', effective: -1, chain: [], deletedBy })
      continue
    }

    const eff = chain[chain.length - 1]
    const hasBase = chain.some((i) => !roots[i].writable)
    // 有更高优先级的来源用 replace_path 删掉了它,且删除者自己不提供 → 也不存在
    const killed = deletedBy.length ? Math.max(...deletedBy) : -1
    if (killed >= 0 && eff < killed) {
      dropped.push({ name, path: rel, own: 'gap', effective: -1, chain, deletedBy })
      continue
    }

    const own: FileOwn = !hasBase ? 'new' : !roots[eff].writable ? 'vanilla' : 'override'
    if (own === 'vanilla') nVanilla++
    else if (own === 'override') nOverride++
    else nNew++
    effective.push({ name, path: rel, own, effective: eff, chain, deletedBy })
  }

  return {
    effective,
    dropped,
    stats: { effective: effective.length, vanilla: nVanilla, override: nOverride, new: nNew, dropped: dropped.length },
  }
}

function listNames(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    return readdirSync(dir).filter((f) => {
      try { return statSync(join(dir, f)).isFile() } catch { return false }
    })
  } catch {
    return []
  }
}

/** 列出某个来源下某个目录的全部相对文件路径(递归) */
export function listFiles(root: SrcRoot, relDirRaw: string, out: string[] = []): string[] {
  const relDir = normRelPath(relDirRaw)
  const abs = join(root.path, relDir)
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

/* ══════════════════════════════════════════════════════════════════
 * REPLACE_PATH_ALL_V1(2026-10-18):共享的「递归目录收集 + 逐 rel 判定」工具。
 *
 * 各功能模块(focus / tech / events / decisions / characters / units /
 * aibehave / doctrines / mio / music / loc)原来各自写一套 walk() 递归扫描,
 * 均未应用 replace_path —— 模组声明 replace_path 后,被覆盖目录下的基础游戏
 * 文件仍会被这些模块加载,与游戏行为不一致。本工具统一:
 *
 *   ① 递归枚举各来源目录下的全部文件(union 相对路径,大小写/斜杠不敏感);
 *   ② 对每个 rel 走 resolveOneRel(与 resolveAssets 同一核心)判定
 *      chain / effective / deletedBy / gap —— replace_path 卸载立即生效;
 *   ③ 返回 byRel 供模块在各自的 walk 里过滤(gap=true 的文件不加载),
 *      以及 effective / dropped / stats 供统计与缺口展示。
 *
 * 口径与 assetsrc 完全一致:子树超集匹配(replacePathCovers)、
 * gap = 声明者自己不提供且无更高优先级来源提供。
 * ══════════════════════════════════════════════════════════════════ */

/** collectDirRecursive 的选项 */
export interface CollectDirOptions {
  /** 只收集这些扩展名的文件(小写比较,如 '.txt';默认收集全部文件) */
  exts?: readonly string[]
  /** 是否递归子目录(默认 true) */
  recursive?: boolean
  /** 递归时的最大子目录深度(0 = 只扫 relDir 直接文件;默认不限) */
  maxDepth?: number
}

/** collectDirRecursive 的返回:逐 rel 判定 + 生效/缺口分组 + 统计 */
export interface CollectDirResult {
  /**
   * rel(规范化)→ 逐 rel 判定(与 resolveAssets 同一核心)。
   * gap=true 的 rel 在游戏里不存在 —— 模块 walk 时据此跳过。
   */
  byRel: Map<string, AssetRef>
  /** 生效文件(own !== 'gap'),按 rel 字典序 */
  effective: AssetRef[]
  /** 缺口(own === 'gap'):因 replace_path 被卸载、游戏里不存在的文件 */
  dropped: AssetRef[]
  stats: { total: number; vanilla: number; override: number; new: number; gap: number }
}

/** 递归列出 absDir 下的全部相对文件(可指定只递归/最大深度) */
function listRelFiles(absDir: string, relPrefix: string, opts: Required<CollectDirOptions>, depth: number, out: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (opts.recursive && (opts.maxDepth < 0 || depth < opts.maxDepth)) {
        listRelFiles(join(absDir, e.name), rel, opts, depth + 1, out)
      }
    } else if (e.isFile()) out.push(rel)
  }
}

/**
 * ★ 递归目录收集 + replace_path 判定(功能模块统一入口)。
 *
 * @param roots     已加载来源,**顺序即载入序**(基础游戏在前,模组在后,靠后者优先)。
 *                  功能模块的 Root 只需满足 SrcRootLike(带不带 writable 均可)
 * @param relDirRaw 目标目录,如 `common/technologies`、`events`、`music`
 * @param opts      exts 只收集这些扩展名(小写比较);recursive 是否递归;maxDepth 递归深度上限
 * @returns byRel 供模块过滤,effective/dropped/stats 供统计与缺口展示
 */
export function collectDirRecursive(
  roots: readonly SrcRootLike[],
  relDirRaw: string,
  opts?: CollectDirOptions,
): CollectDirResult {
  const relDir = normRelPath(relDirRaw)
  const o: Required<CollectDirOptions> = {
    exts: opts?.exts?.map((e) => e.toLowerCase()) ?? [],
    recursive: opts?.recursive ?? true,
    maxDepth: opts?.maxDepth ?? -1,
  }

  // ① 各来源下该目录的全部相对文件(按扩展名过滤)
  const byRoot: string[][] = []
  for (const r of roots) {
    const list: string[] = []
    listRelFiles(join(r.path, relDir), relDir, o, 0, list)
    if (o.exts.length) byRoot.push(list.filter((rel) => o.exts.some((e) => rel.toLowerCase().endsWith(e))))
    else byRoot.push(list)
  }

  // ② union 相对路径(大小写不敏感:取首个来源的写法)
  const firstOf = new Map<string, string>() // 小写 rel → 首个来源的 rel 写法
  const lowerSet = new Set<string>()
  for (const list of byRoot) {
    for (const rel of list) {
      const k = rel.toLowerCase()
      if (!lowerSet.has(k)) {
        lowerSet.add(k)
        firstOf.set(k, rel)
      }
    }
  }
  const byRootLower: Set<string>[] = byRoot.map((list) => new Set(list.map((x) => x.toLowerCase())))

  // ③ 逐 rel 判定(与 resolveAssets 同一核心)
  const byRel = new Map<string, AssetRef>()
  const effective: AssetRef[] = []
  const dropped: AssetRef[] = []
  let nVanilla = 0, nOverride = 0, nNew = 0, nGap = 0
  for (const k of lowerSet) {
    const rel = normRelPath(firstOf.get(k)!)
    const ref = resolveOneRel(roots, rel, (i) => byRootLower[i].has(k))
    byRel.set(rel, ref)
    if (ref.own === 'gap') {
      nGap++
      dropped.push(ref)
    } else {
      if (ref.own === 'vanilla') nVanilla++
      else if (ref.own === 'override') nOverride++
      else nNew++
      effective.push(ref)
    }
  }
  const byPath = (a: AssetRef, b: AssetRef): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  effective.sort(byPath)
  dropped.sort(byPath)

  return {
    byRel,
    effective,
    dropped,
    stats: { total: byRel.size, vanilla: nVanilla, override: nOverride, new: nNew, gap: nGap },
  }
}

/**
 * ★ 逐来源加载判定(与游戏加载器完全一致的规则):来源 rootIdx 的文件 rel
 * 是否被【更高优先级来源】的 replace_path 卸载。
 *
 * 判定规则:`∃ j > rootIdx 且 j 声明了覆盖 rel 的 replace_path`。
 * 依据 wiki:replace_path 卸载「此前已加载的所有文件」—— 声明者 j 加载时,
 * 载入序在它之前的来源(含 rootIdx)在该目录下的文件全部失效;
 * 而 rootIdx 自己的文件随 rootIdx 加载,不受它自己声明的 replace_path 影响。
 *
 * 各功能模块在 walk 时对每个文件调用本函数:返回 true 就跳过不解析 ——
 * 游戏里这个文件根本不存在,解析出来只会制造假象。
 *
 * 与 resolveOneRel 的关系:本函数是「逐来源」判定(某来源的某文件是否被卸载),
 * resolveOneRel 是「逐文件」判定(该 rel 在游戏里最终是否存在、由谁生效)。
 * 两者同源同口径(都用 replacePathCovers 的子树超集匹配)。
 */
export function isUnloadedByLaterReplacePath(
  roots: readonly SrcRootLike[],
  rootIdx: number,
  relRaw: string,
): boolean {
  for (let j = rootIdx + 1; j < roots.length; j++) {
    const rps = roots[j].replacePaths
    if (rps?.length && replacePathCovers(rps, relRaw)) return true
  }
  return false
}