/**
 * OWNERSHIP_V1 —— 全工作台统一的「原版 / 模组」覆盖语义。
 *
 * ══ 游戏(HOI4)的真实规则 ══
 *   载入顺序:基础游戏 → DLC → 模组(数组靠后的优先级更高)。
 *   · **同名 → 后者完全替换前者**(不是叠加、不是合并)。
 *     先载入的那份从此失效,既不参与统计,也不该在界面上冒充"还存在的内容"。
 *   · **不同名 → 共存**,后者属于新增内容。
 *
 *   这里"同名"有两个层次,工作台两处都要按这个规则走:
 *     · 文件级:common/ 下同【相对路径】的文件 → 模组整文件替换原版。
 *     · 条目级:同一命名空间下同【id】的条目(决议 / 科技 / 国策 / 军工机构 / 事件 …)
 *             → 模组替换原版,与它写在哪个文件里无关。
 *
 * ══ Wiki 求值序备注(2026-10 快照)══
 *   Wiki:"The order of loading doesn't matter during evaluation"——条目级重复
 *   由求值序(文件按 ASCII 字符 ID 排序)决定,且各域处理不同:
 *   · states 类:先创建者胜(原版 123-ABC.txt 胜于模组 123-XYZ.txt)
 *   · sprite 类:后求值者胜
 *   · 国策重复会破坏前置行生成(应避免)
 *   本模块统一按"同 id 载入序靠后者胜"近似判定,适用于多数域;个别域
 *   (states 等)实际行为相反,调用方展示时已注明该近似。
 * ══ 因此每个实体只有三种归属 ══
 *   vanilla  —— 基础游戏有,且没有更高优先级来源改写它(最终生效的就是原版那份)
 *   override —— 基础游戏有,但被模组同名替换(最终生效的是模组那份;原版那份 = 影子)
 *   new      —— 基础游戏没有,模组新增
 *
 * ══ 统计口径必须是「生效集」══
 *   每个 key 只计一次:总数 = vanilla + override + new。
 *   把原版一份、模组一份都算进总数(266 + 44 这种)就是典型的"同名当增加",
 *   得到的数字游戏里根本不存在。
 *
 * 本文件是全工作台唯一的所有权判定入口 —— 各域不要再自己写 `root === 0` 之类的判据。
 */

/** 归属三态 */
export type Ownership = 'vanilla' | 'override' | 'new'

/** 一个定义现场(条目在哪个来源、哪个文件的哪一行) */
export interface DefSite {
  root: number
  file: string
  line: number
}

/** 归属判定结果 */
export interface OwnInfo {
  /** 三态归属 —— UI 徽标与筛选器直接用它 */
  own: Ownership
  /** 兼容旧字段:原版本来有没有这个东西 */
  origin: 'vanilla' | 'mod'
  /** 兼容旧字段:最终生效的那份来自只读 root(基础游戏)吗 */
  base: boolean
  /** 兼容旧字段:原版有、但最终被模组改写 */
  overridden: boolean
  /** 最终生效版本所在 root(覆盖链里优先级最高的那个) */
  effective: number
  /** 被覆盖而失效的 root(按载入序)—— 这些是"影子",不参与统计 */
  shadowed: number[]
  /** 全部定义所在 root(按载入序) */
  chain: number[]
}

/** 只读 root 判定器:由调用方传入(工作台里 = `!ROOTS[i].writable`) */
export type IsBase = (root: number) => boolean

/**
 * 核心判定:给一条覆盖链(按载入序),算出归属。
 *
 * @param sites 该 key 的全部定义现场,**必须按载入序**(先 base 后 mod)
 * @param isBase 该 root 是否属于基础游戏(只读)
 */
export function ownOf(sites: { root: number }[], isBase: IsBase): OwnInfo {
  if (!sites.length) {
    return {
      own: 'new',
      origin: 'mod',
      base: false,
      overridden: false,
      effective: 0,
      shadowed: [],
      chain: [],
    }
  }
  const chain = sites.map((s) => s.root)
  // ★ 优先级 = 数组顺序,最后一个最高(后载入者覆盖先载入者)
  const effective = chain[chain.length - 1]
  const hasBase = chain.some((r) => isBase(r))
  const base = isBase(effective)
  const own: Ownership = !hasBase ? 'new' : base ? 'vanilla' : 'override'
  const shadowed = chain.slice(0, -1)
  return {
    own,
    origin: hasBase ? 'vanilla' : 'mod',
    base,
    overridden: own === 'override',
    effective,
    shadowed,
    chain,
  }
}

/** 生效集统计 —— 唯一正确的总数口径 */
export interface OwnStats {
  /** 原版内容(未被改写) */
  vanilla: number
  /** 模组改写(原版有,生效的是模组版本) */
  override: number
  /** 模组新增(原版没有) */
  new: number
  /** 生效总数 = 上面三项之和,游戏里真实存在的条数 */
  effective: number
  /** 因被覆盖而失效的旧版本数(影子,不计入 effective) */
  shadowed: number
}

export function ownStatsOf<T>(items: Iterable<T>, ownOfItem: (t: T) => Ownership, shadowCount = 0): OwnStats {
  let vanilla = 0
  let override = 0
  let neu = 0
  for (const it of items) {
    const o = ownOfItem(it)
    if (o === 'vanilla') vanilla++
    else if (o === 'override') override++
    else neu++
  }
  return { vanilla, override, new: neu, effective: vanilla + override + neu, shadowed: shadowCount }
}

/**
 * 通用生效集构建器 —— 把「一堆带 root 的条目」解析成:
 *   effective —— 每个 key 只留优先级最高的那一条(游戏里真正生效的)
 *   shadowed  —— 被覆盖掉的旧版本(默认是隐藏的,界面可按需单独展示)
 *   chain     —— key → 全部定义现场(供"谁覆盖了它"面板)
 *
 * @param items  全部条目(可含重复 key)
 * @param key    条目唯一标识
 * @param root   条目所在来源序号
 * @param isBase 只读 root 判定
 */
export function effectiveSet<T>(
  items: T[],
  key: (t: T) => string,
  root: (t: T) => number,
  isBase: IsBase,
): {
  effective: T[]
  shadowed: T[]
  chain: Map<string, T[]>
  own: Map<string, OwnInfo>
} {
  // 载入序分组:同 key 的按来源序号升序(序号大 = 后载入 = 优先)
  const byKey = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = byKey.get(k)
    if (arr) arr.push(it)
    else byKey.set(k, [it])
  }
  const effective: T[] = []
  const shadowed: T[] = []
  const own = new Map<string, OwnInfo>()
  for (const [k, arr] of byKey) {
    arr.sort((a, b) => root(a) - root(b))
    const info = ownOf(arr.map((x) => ({ root: root(x) })), isBase)
    own.set(k, info)
    // 生效的 = 优先级最高的那条;其余全是影子
    effective.push(arr[arr.length - 1])
    for (let i = 0; i < arr.length - 1; i++) shadowed.push(arr[i])
  }
  return { effective, shadowed, chain: byKey, own }
}

/* ── UI 文案(前后端共用一份,避免各页各写一套) ── */

export const OWN_LABEL: Record<Ownership, string> = {
  vanilla: '原版',
  override: '模组改写',
  new: '模组新增',
}

export const OWN_HINT: Record<Ownership, string> = {
  vanilla: '基础游戏原本就有,模组没有同名内容覆盖它 —— 最终生效的就是原版这一份',
  override: '基础游戏有同名内容,但被模组【整份替换】了 —— 原版那份已失效,生效的是模组版本',
  new: '基础游戏没有这个内容 —— 模组新增,与原版内容共存',
}

/** 来源筛选器的标准取值(各页 src 参数统一) */
export const OWN_FILTERS = ['', 'base', 'mod', 'vanilla', 'override', 'new'] as const
