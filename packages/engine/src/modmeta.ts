/**
 * MODMETA_V1 —— 模组描述符(`.mod`)的**权威解析入口**。
 *
 * ══ 为什么必须独立成模块,而不能在各处 `readFileSync` + 正则 ══
 * 之前 `.mod` 只在「创意工坊列表」里被读,而且只取三个字段当装饰
 * (`name` / `tags` / `replace_path` 的**条数**)。但实际上这三个字段
 * 各自都藏着会让整张地图/依赖图算错的语义,必须集中判一次:
 *
 *  ① **`replace_path` 不是"覆盖这几个文件",而是"删掉这个目录下的原版内容"**
 *     实测本机 36 个创意工坊模组共 745 条 replace_path,形态统计:
 *       · 745/745 全是小写 + 正斜杠 + 无首尾斜杠(所以规范化很便宜,但仍做)
 *       · 235 条是三段及更深(`common/decisions/categories`),
 *         所以**不能只按两段前缀匹配**
 *       · 父子共存是常态(10/11 个有 map 的模组同时写了 `map` 和 `map/terrain`)
 *         → 重复声明无害,判定时取并集即可
 *     真实杀伤力实测(见 `_probe_gap.ts`):
 *       · `replace_path="map"` 的模组,vanilla map/ 下 115 个文件它没提供
 *         → 那些文件在游戏里**直接消失**(引擎不回退原版)
 *       · `replace_path="history/states"` 的 11 个模组,vanilla 1081 个 state
 *         有 196~1081 个被丢弃,例如 Kaiserreich(1521695605)把 1081 个全丢了
 *     所以 replace_path 必须在**资产归属判定**里参与,不能只是"改了多少的计数"。
 *
 *  ② **`dependencies` 块必须精确截断**
 *     宽松正则 `/dependencies\s*=\s*\{([^}]*)\}/s` 在本机 36 个模组上碰巧
 *     与精确块解析结果一致(实测已验证),但那是因为这些文件的 `dependencies`
 *     恰好不在别的块之后。`+JP:kaiserreich` 这类 launcher 前缀写法、
 *     以及 dependencies 里引用未安装的子模组(实测 36 条悬空)都必须如实保留。
 *
 *  ③ **`dependencies` 引用的是模组 name,不是 remote_file_id**
 *     实测 36/36 name 全局唯一,所以按 name(小写)索引是可靠的;
 *     但仍保留 id 作为回退索引,因为自建模组常常 name 写得很随意。
 *
 * ══ 与 HOI4 Modding Wiki(2026-10 快照)的对照 ══
 *  · replace_path 只卸载声明目录内的**直接**文件,子文件夹不受影响
 *    (Wiki:"This only applies to files directly within that folder,
 *      any sub-folders will left untouched.")——本工具按子树语义判定
 *      (超集,保守不遗漏),展示层会按此口径分层标注。
 *  · dependencies 只是**排序提示**,不是运行必需:
 *    (Wiki:"This doesn't make this mod require the listed mods to work.")
 *    悬空依赖仅意味着无法确定相对载入序,不表示模组会失效。
 *  · 条目级重复由**求值序**(文件 ASCII 排序)决定,且各域不同
 *    (states 先建者胜 / sprite 后建者胜 / 国策重复破坏前置行);
 *    ownership.ts 按载入序近似判定,展示层已注明该近似。
 * ══ 与 ownership.ts 的分工 ══
 *   ownership.ts 判**条目级**覆盖(同 id 谁生效),按 root 载入序;
 *   本模块判**文件/目录级**的来源可见性(replace_path 会让原版文件"消失",
 *   这比"被更高优先级覆盖"更强 —— 覆盖还有影子可见,删除是彻底没了)。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 规范化后的 replace_path 一项 */
export type NormPath = string

/**
 * 路径规范化:统一成「小写 / 正斜杠 / 无首尾斜杠」。
 * 实测 745/745 本来就合规,这里是防御 —— 自建模组里 `Map/Terrain\` 这种写法很常见,
 * 而它一旦不匹配就会让 replace_path **静默失效**,变成"新增"而非"替换"。
 */
export function normRelPath(p: string): NormPath {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * `replace_paths` 是否覆盖 `rel`。
 *
 * 判定必须是**目录语义**:声明 `common/abilities` 要能盖住
 * `common/abilities/foo.txt`,但**不能**盖住 `common/abilities_extra/x.txt`
 * (前缀相同却是兄弟目录)。所以比较时补 `/` 边界。
 */
export function replacePathCovers(replacePaths: readonly NormPath[], rel: string): boolean {
  const p = normRelPath(rel)
  if (!p) return false
  for (const rp of replacePaths) {
    if (!rp) continue
    if (p === rp) return true
    if (p.startsWith(rp + '/')) return true
  }
  return false
}

/** 找出覆盖 `rel` 的那几条 replace_path(用于 UI 说明"是谁替换的") */
export function replacePathsHitting(replacePaths: readonly NormPath[], rel: string): NormPath[] {
  const p = normRelPath(rel)
  const out: NormPath[] = []
  for (const rp of replacePaths) {
    if (!rp) continue
    if (p === rp || p.startsWith(rp + '/')) out.push(rp)
  }
  return out
}

/** 模组描述符 —— 一个 `.mod` 文件的全部有用信息 */
export interface ModDescriptor {
  /** 模组根目录(绝对路径) */
  dir: string
  /** 实际读到的 .mod 文件名;无 .mod 时为 undefined */
  modFile?: string
  /** 是否检到 .mod 文件 —— 模组身份主判据 */
  hasModFile: boolean
  /** 无 .mod 时靠目录结构推断 */
  inferred: boolean

  name: string
  /** remote_file_id(创意工坊 item id);自建模组通常没有 */
  remoteFileId?: string
  version: string
  supportedVersion: string
  tags: string[]
  picture?: string
  /** .mod 里写了 path= —— 创意工坊下是作者本机残留,绝不参与路径决策 */
  stalePath?: string

  /** ★ 规范化后的完整 replace_path 列表(不是条数) */
  replacePaths: NormPath[]
  /** replace_path 原文(保留大小写与原样,供 UI 回显) */
  replacePathsRaw: string[]
  /** ★ 完整依赖列表(不截断) */
  dependencies: string[]
  /** ★ 依赖解析结果(见 buildDepGraph) */
  depKeys: string[]

  /** 解析告警(不抛错,坏文件不该拖垮整批扫描) */
  warnings: string[]
}

/**
 * 找一个目录下的 .mod 文件 —— 模组身份判据。
 * 优先 descriptor.mod(实测创意工坊 36/36 都是这个名字),
 * 其次根层第一个 *.mod(自建模组常叫 `<模组名>.mod`)。
 * 只看根层,不递归(避免把子模组目录里的 .mod 误认成主描述文件)。
 */
export function findModFile(dir: string): string | undefined {
  if (existsSync(join(dir, 'descriptor.mod'))) return 'descriptor.mod'
  try {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mod'))
    // 多个时取最短:主描述文件通常最短最规范,子模组往往是 `<主名>_<子模块>`
    files.sort((a, b) => a.length - b.length)
    return files[0]
  } catch {
    /* 读不到目录:当作无 .mod */
  }
  return undefined
}

/**
 * 精确取 `key={ ... }` 的块体。
 *
 * 不用 `/key\s*=\s*\{([^}]*)\}/` 的原因:块内若出现嵌套 `{}` 会提前截断,
 * 而宽松的 `[\s\S]*?` 又会在块内含 `}` 时截断错位。做法是从 `{` 之后
 * 扫到**第一个独占一行的 `}`**(`.mod` 的块收尾就是这么写的,实测 36/36 命中)。
 */
export function modBlock(txt: string, key: string): string | null {
  const re = new RegExp('^[ \\t]*' + key + '[ \\t]*=[ \\t]*\\{', 'm')
  const m = txt.match(re)
  if (!m) return null
  const start = m.index! + m[0].length
  // 优先找独占一行的收尾
  const lineEnd = txt.indexOf('\n}', start)
  if (lineEnd >= 0) return txt.slice(start, lineEnd)
  // 退化:同花括号在同一行内
  const inline = txt.indexOf('}', start)
  return inline >= 0 ? txt.slice(start, inline) : txt.slice(start)
}

/**
 * 解析一个模组目录的 `.mod`。**永不抛错** —— 扫描列表时一个坏文件
 * 不能拖垮整批;问题记进 `warnings`。
 */
export function parseModDescriptor(dir: string): ModDescriptor {
  const out: ModDescriptor = {
    dir,
    hasModFile: false,
    inferred: false,
    name: '',
    version: '',
    supportedVersion: '',
    tags: [],
    replacePaths: [],
    replacePathsRaw: [],
    dependencies: [],
    depKeys: [],
    warnings: [],
  }
  const mf = findModFile(dir)
  if (!mf) {
    out.inferred = existsSync(join(dir, 'interface')) || existsSync(join(dir, 'common'))
    return out
  }
  out.hasModFile = true
  out.modFile = mf
  let txt = ''
  try {
    txt = readFileSync(join(dir, mf), 'utf8')
  } catch (e: any) {
    out.warnings.push(`读取 ${mf} 失败:${e?.message ?? e}`)
    return out
  }

  // 每个字段锚在行首,只匹配不带前缀的那个键:
  //   ^\s*name 不会误吃 supported_version / remote_file_id,
  //   ^\s*path 不会误吃 replace_path。
  const str = (re: RegExp): string => {
    const m = txt.match(re)
    return m && m[1] ? m[1].trim() : ''
  }
  out.name = str(/^[ \t]*name[ \t]*=[ \t]*"([^"]*)"/m)
  out.version = str(/^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m)
  out.supportedVersion = str(/^[ \t]*supported_version[ \t]*=[ \t]*"([^"]*)"/m)
  out.picture = str(/^[ \t]*picture[ \t]*=[ \t]*"([^"]*)"/m) || undefined
  out.remoteFileId = str(/^[ \t]*remote_file_id[ \t]*=[ \t]*"([^"]*)"/m) || undefined
  out.stalePath = str(/^[ \t]*path[ \t]*=[ \t]*"([^"]*)"/m) || undefined

  const tb = modBlock(txt, 'tags')
  if (tb) out.tags = [...tb.matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean)

  const db = modBlock(txt, 'dependencies')
  if (db) {
    out.dependencies = [...db.matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean)
    // ★ launcher 前缀(`+JP:kaiserreich` 是 Paradox 的本地化前缀语法)先剥掉,
    // 否则按 name 索引一定匹配不上,悬空依赖会被误报。
    out.depKeys = out.dependencies.map(modDepKey)
  }

  out.replacePathsRaw = [...txt.matchAll(/^[ \t]*replace_path[ \t]*=[ \t]*"([^"]*)"/gm)]
    .map((x) => x[1].trim())
  const seen = new Set<NormPath>()
  for (const raw of out.replacePathsRaw) {
    const n = normRelPath(raw)
    if (!n) {
      // 空声明不是无害的:`replace_path=""` 在游戏里等于「删掉整个当前目录」,
      // 语义非常危险,必须报出来而不是被 .filter(Boolean) 静默吞掉。
      out.warnings.push(`replace_path 为空或仅斜杠:"${raw}" —— 游戏里相当于替换整个当前目录`)
      continue
    }
    if (seen.has(n)) continue
    seen.add(n)
    out.replacePaths.push(n)
  }

  if (!out.name) out.warnings.push('.mod 缺少 name=,依赖关系将无法按名索引')
  return out
}

/**
 * 依赖项的索引键。
 * `+JP:kaiserreich` / `+JA:` 这类是 launcher 的「按语言前缀」语法,
 * 去掉前缀后才是真正的模组名。
 */
export function modDepKey(dep: string): string {
  return dep
    .trim()
    .replace(/^\+[A-Za-z0-9_]{2,4}:/, '')
    .trim()
    .toLowerCase()
}

/** 依赖图里的一个节点 */
export interface DepNode {
  /** 索引键(小写 name,回退 remote_file_id) */
  key: string
  name: string
  /** ★ 展示名:只读来源没有 .mod name,用它容易被显示成 "hearts of iron iv" */
  display: string
  dir: string
  id?: string
  /** 原始依赖条目(UI 回显用) */
  deps: string[]
  /** 已解析到的依赖节点 key */
  depKeys: string[]
  /** ★ 悬空依赖:写了这个依赖,但已加载的模组里找不到(实测本机 36 条) */
  missingDeps: string[]
  /** ★ 环:出现在自己的依赖链上 */
  cyclic: boolean
}

export interface DepIssue {
  kind: 'missing' | 'self' | 'cycle'
  modKey: string
  modName: string
  dep: string
  msg: string
}

export interface ModDepGraph {
  nodes: Map<string, DepNode>
  /** 按目录索引 → key */
  byDir: Map<string, string>
  /** 全部依赖问题 */
  issues: DepIssue[]
  /** ★ 载入序(拓扑序):被依赖的在前。循环时退化为原序并记 cycle issue */
  order: string[]
  /** 载入序里检测到环的节点 */
  cyclic: Set<string>
  stats: {
    mods: number
    withDeps: number
    edges: number
    missing: number
    self: number
    cycles: number
  }
}

/**
 * 建模组依赖图。
 *
 * @param mods 已启用的模组描述符(顺序 = 用户 playset 顺序,只用于平局兜底)
 *
 * 语义要点:
 *  · 依赖按 **name 小写** 索引;找不到再按 remote_file_id / 目录名回退
 *    (自建模组常把 name 写成和目录名不一致)
 *  · **自依赖**(把自己写进 dependencies)不静默吞掉 —— 那是 .mod 写错,
 *    游戏里也会提示,工具必须报
 *  · 环不抛错:返回 order 为可用的退化序(按 playset),并把节点标 cyclic
 */
export function buildDepGraph(mods: readonly ModDescriptor[], opts?: { isGame?: (m: ModDescriptor) => boolean }): ModDepGraph {
  const nodes = new Map<string, DepNode>()
  const byDir = new Map<string, string>()
  const issues: DepIssue[] = []
  const isGame = opts?.isGame ?? (() => false)

  // ── 建索引:name 小写 → key;同时建 id / 目录名回退索引
  const byId = new Map<string, string>()
  const byDirName = new Map<string, string>()
  for (const m of mods) {
    const game = isGame(m)
    const key = (m.name || '').trim().toLowerCase() || (m.remoteFileId || '').toLowerCase() || basenameKey(m.dir)
    if (nodes.has(key)) {
      // name撞车:保留先注册的那个,把后来的挂到目录名 key 下,
      // 免得整个模组在图里凭空消失(实测本机无撞车,这是防御)
      const alt = basenameKey(m.dir)
      if (!nodes.has(alt)) {
        nodes.set(alt, mkNode(m, alt, game))
        byDir.set(normDir(m.dir), alt)
      }
      continue
    }
    nodes.set(key, mkNode(m, key, game))
    byDir.set(normDir(m.dir), key)
    if (m.remoteFileId) byId.set(m.remoteFileId.toLowerCase(), key)
    byDirName.set(basenameKey(m.dir), key)
  }

  const lookup = (dep: string): string | undefined => {
    const k = modDepKey(dep)
    if (nodes.has(k)) return k
    if (byId.has(k)) return byId.get(k)
    if (byDirName.has(k)) return byDirName.get(k)
    // 前缀匹配兜底:「Kaiserreich」应能命中「Kaiserreich Music」吗?**不能** ——
    // 那会造成假依赖。所以只做完全匹配,不做前缀。
    return undefined
  }

  let edges = 0
  for (const n of nodes.values()) {
    for (const dep of n.deps) {
      const raw = dep
      if (modDepKey(dep) === n.key || modDepKey(dep) === (basenameKey(n.dir) as string)) {
        n.missingDeps.push(raw)
        issues.push({
          kind: 'self',
          modKey: n.key,
          modName: n.name,
          dep: raw,
          msg: `「${n.name}」的 dependencies 里写了自己`,
        })
        continue
      }
      const k = lookup(raw)
      if (k === undefined) {
        n.missingDeps.push(raw)
        issues.push({
          kind: 'missing',
          modKey: n.key,
          modName: n.name,
          dep: raw,
          msg: `「${n.name}」依赖的「${raw}」不在已加载模组里`,
        })
        continue
      }
      if (!n.depKeys.includes(k)) n.depKeys.push(k)
      edges++
    }
  }

  // ── 拓扑排序(依赖在前)。有环时用 DFS 染色,回边处记 cycle 并继续
  const cyclic = new Set<string>()
  const order: string[] = []
  const state = new Map<string, 0 | 1 | 2>() // 0未访 1在栈 2完成
  const visit = (k: string): void => {
    const st = state.get(k)
    if (st === 2) return
    if (st === 1) {
      cyclic.add(k)
      return
    }
    state.set(k, 1)
    for (const d of nodes.get(k)?.depKeys ?? []) visit(d)
    state.set(k, 2)
    order.push(k)
  }
  // 先按 playset 顺序起手,保证输出稳定(可复现)
  const startOrder = [...nodes.keys()].filter((k) => nodes.get(k)?.dir)
  const seeded = new Set<string>()
  for (const m of mods) {
    const k = byDir.get(normDir(m.dir))
    if (k && !seeded.has(k)) { seeded.add(k); visit(k) }
  }
  for (const k of startOrder) visit(k)
  for (const k of cyclic) {
    const n = nodes.get(k)
    if (!n) continue
    issues.push({
      kind: 'cycle',
      modKey: k,
      modName: n.name,
      dep: n.deps.join(', '),
      msg: `「${n.name}」处在依赖环里,载入顺序无法确定`,
    })
  }

  return {
    nodes,
    byDir,
    issues,
    order,
    cyclic,
    stats: {
      mods: nodes.size,
      withDeps: [...nodes.values()].filter((n) => n.deps.length).length,
      edges,
      missing: issues.filter((i) => i.kind === 'missing').length,
      self: issues.filter((i) => i.kind === 'self').length,
      cycles: cyclic.size,
    },
  }
}

/**
 * 节点展示名。
 *
 * ⚠ 基础游戏(只读 root)没有 .mod,其"名字"只能取目录名 —— 直接用目录名的话
 *   界面上会出现 "hearts of iron iv" 这种难看的节点(实测就是这样)。
 *   所以只读来源统一显示成「基础游戏」,并把真实目录名放进 dir 供排查。
 */
function mkNode(m: ModDescriptor, key: string, isGame = false): DepNode {
  return {
    key,
    name: m.name || basenameKey(m.dir),
    display: m.name || (isGame ? '基础游戏' : basenameKey(m.dir)),
    dir: m.dir,
    id: m.remoteFileId,
    deps: m.dependencies,
    depKeys: [],
    missingDeps: [],
    cyclic: false,
  }
}

function basenameKey(dir: string): string {
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return (parts[parts.length - 1] || dir).toLowerCase()
}

function normDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 通配符版本匹配(与 server.ts 既有实现同语义,抽出来供引擎侧独立使用)。
 * 模组写 1.19.* / 1.19.3.*,游戏是 1.19.3.0;遇 `*` 直接通过。
 */
export function versionMatches(pattern: string, actual: string): boolean {
  if (!pattern || !actual) return true
  if (pattern === actual) return true
  const p = pattern.trim().split('.')
  const a = actual.trim().split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') return true
    if (a[i] === undefined) return false
    if (p[i] !== a[i]) return false
  }
  return true
}

/** 目录是否存在且是目录(读 replace_path 覆盖情况时会用到) */
export function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}