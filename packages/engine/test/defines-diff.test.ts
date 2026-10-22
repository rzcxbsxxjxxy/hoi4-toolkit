/**
 * defines 原版 vs 模组差异的语义单测。
 *
 * 重点验证用户明确提的判据:**-- 注释部分忽略**
 * (模组常把 vanilla 的行尾注释删掉,若不剥注释会把"只删注释"误报成改动)。
 *
 * ★★ 写这个夹具踩了两个坑,改之前先读:
 *  1. parseDefines 靠**缩进**判层级,而 vanilla 的真实形态是
 *     「分组行顶格 + 条目缩进一个 TAB」(实测 00_defines.lua)。
 *     写成嵌套缩进(分组行也缩进)→ 一条都吐不出来,entries=0。
 *  2. buildDefinesModel 传给 walk 的 dir 是 `<root.path>/common/defines`,
 *     read 收到的 p 是 `<root.path>/common/defines/xx.lua`。
 *     判断来源必须按 **root.path 前缀**,不能按 'vanilla' 字样 ——
 *     原版路径形如 '/g/Hearts of Iron IV',里面没有 'vanilla' 两字,
 *     按字样判会让两个来源读到同一份数据,差异恒为 0。
 */
import { computeDefineDiffs, summarizeDefineDiffs, parseDefines, buildDefinesModel } from '../src/defines.ts'

let pass = 0
const fails: string[] = []
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
  } catch (e) {
    fails.push(name + ' :: ' + (e as Error).message)
  }
}
function eq(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n  期望 ${JSON.stringify(b)}\n  实际 ${JSON.stringify(a)}`)
  }
}
function ok(v: unknown, msg = '') {
  if (!v) throw new Error(msg || '期望为真')
}

/**
 * 生成 vanilla 形态的 defines 文本。
 * 分组行必须顶格,条目缩进一个**真实 TAB**(用 \t 在普通字符串里写真 TAB)。
 */
function defs(groups: Record<string, string>): string {
  let s = 'NDefines = {\n'
  for (const [g, body] of Object.entries(groups)) s += '\n' + g + ' = {\n' + body + '\t}\n'
  return s + '}\n'
}

const VANILLA = defs({
  NGame: '\tSTART_DATE = "1936.1.1"       -- 游戏起始日期\n\tMANPOWER_PER_MILLION = 1000\n\tRESEARCH_SPEED = 1\n',
  NProduction: '\tOIL_CAPACITY_BASE = 100\n',
})

const MOD = defs({
  NGame: '\tSTART_DATE = "1936.1.1"\n\tMANPOWER_PER_MILLION = 1500\n',
  NProduction: '\tOIL_CAPACITY_BASE = 100 -- 模组自己写的注释,和 vanilla 不同\n',
  NDiplomacy: '\tNEW_KEY = 42\n',
})

const roots = [
  { name: 'vanilla', path: '/g/Hearts of Iron IV', writable: false },
  { name: 'mymod', path: '/m/mymod', writable: true },
]
const MODS = new Set(['mymod'])

function mkModel(rts = roots, contents?: Record<string, string>) {
  const walk = (dir: string) => [dir + '/00_defines.lua']
  const read = (p: string) => {
    const hit = rts.find((r) => p.startsWith(r.path))
    if (!hit) return ''
    if (contents) return contents[hit.name] ?? ''
    return hit.name === 'vanilla' ? VANILLA : MOD
  }
  return buildDefinesModel(rts, read, walk)
}

t('buildDefinesModel:两来源各 4 条,entries 保留全量来源', () => {
  const m = mkModel()
  eq(m.entries.length, 8, '原版 4 + 模组 4')
  eq(m.entries.filter((e) => e.file.startsWith('vanilla/')).length, 4)
  eq(m.entries.filter((e) => e.file.startsWith('mymod/')).length, 4)
})

t('★ -- 注释被忽略:模组删掉行尾注释不算改动', () => {
  const d = computeDefineDiffs(mkModel().entries, 'vanilla', MODS)
  const start = d.find((x) => x.key === 'NGame.START_DATE')!
  ok(start, '未找到 START_DATE 差异项')
  eq(start.changed, false, '值相同就不该算改动')
  eq(start.kind, 'same-value')
  eq(start.base!.value, '1936.1.1', 'string 类型 value 不含引号(parseValue 已剥)')
  eq(start.mod!.value, '1936.1.1')
})

t('★ 模组改了注释但值相同 → 仍是 same-value', () => {
  const d = computeDefineDiffs(mkModel().entries, 'vanilla', MODS)
  const oil = d.find((x) => x.key === 'NProduction.OIL_CAPACITY_BASE')!
  ok(oil, '未找到 OIL_CAPACITY_BASE')
  eq(oil.changed, false, 'OIL_CAPACITY_BASE 值都是 100,不该算改动')
  eq(oil.kind, 'same-value')
  // 注释确实不同 → 说明解析器把注释分离到 comment 字段,没混进 value
  ok(oil.base!.comment !== oil.mod!.comment, '两侧注释应各自保留')
})

t('★ 真改动:数值差异 + 百分比', () => {
  const d = computeDefineDiffs(mkModel().entries, 'vanilla', MODS)
  const mp = d.find((x) => x.key === 'NGame.MANPOWER_PER_MILLION')!
  eq(mp.changed, true)
  eq(mp.kind, 'override')
  eq(mp.delta, 500, '1500 - 1000 = 500')
  eq(mp.deltaPct, 50)
})

t('模组新增键 → kind=mod-add,base 为 undefined', () => {
  const d = computeDefineDiffs(mkModel().entries, 'vanilla', MODS)
  const nk = d.find((x) => x.key === 'NDiplomacy.NEW_KEY')!
  ok(nk, '未找到 NEW_KEY')
  eq(nk.kind, 'mod-add')
  eq(nk.base, undefined)
  eq(nk.mod!.num, 42)
})

t('★ 模组没碰过的原版默认键不进入差异列表', () => {
  const d = computeDefineDiffs(mkModel().entries, 'vanilla', MODS)
  eq(d.find((x) => x.key === 'NGame.RESEARCH_SPEED'), undefined, '模组没碰的键不该出现')
  eq(d.length, 4, '实际 ' + d.map((x) => x.key).join(','))
})

t('baseName 不匹配任何来源 → 不产出差异(而非全部误报)', () => {
  eq(computeDefineDiffs(mkModel().entries, '不存在的来源', MODS).length, 0)
})

t('modNames 为空 → 无差异', () => {
  eq(computeDefineDiffs(mkModel().entries, 'vanilla', new Set()).length, 0)
})

t('★ 同键被两个模组先后覆盖:base=原版, mod=最晚生效, 中间进 shadowed', () => {
  const A = defs({ NGame: '\tMANPOWER_PER_MILLION = 1200\n' })
  const B = defs({ NGame: '\tMANPOWER_PER_MILLION = 1800\n' })
  const rts = [
    { name: 'vanilla', path: '/g/g', writable: false },
    { name: 'modA', path: '/m/a', writable: true },
    { name: 'modB', path: '/m/b', writable: true },
  ]
  const m = mkModel(rts, { vanilla: VANILLA, modA: A, modB: B })
  const d = computeDefineDiffs(m.entries, 'vanilla', new Set(['modA', 'modB']))
  const mp = d.find((x) => x.key === 'NGame.MANPOWER_PER_MILLION')!
  ok(mp, '未找到该键')
  eq(mp.mod!.file.split('/')[0], 'modB', '生效值应来自最后加载的 modB')
  eq(mp.mod!.num, 1800)
  eq(mp.delta, 800)
  eq(mp.shadowed.length, 1, 'modA 应进 shadowed')
  eq(mp.shadowed[0].file.split('/')[0], 'modA')
  eq(mp.sourceCount, 3)
})

t('★ 数值相同但写法不同(100 vs 100.0)→ 不算改动', () => {
  const m = mkModel(roots, { vanilla: defs({ NGame: '\tX = 100\n' }), mymod: defs({ NGame: '\tX = 100.0\n' }) })
  const d = computeDefineDiffs(m.entries, 'vanilla', MODS)
  eq(d[0].changed, false, '100 与 100.0 数值相同')
})

t('★ 值里残留注释(手写模组把 -- 放值后)也被剥掉', () => {
  const m = mkModel(roots, {
    vanilla: defs({ NGame: '\tY = 5 -- 原版注释\n' }),
    mymod: defs({ NGame: '\tY = 5   -- 模组注释\n' }),
  })
  const d = computeDefineDiffs(m.entries, 'vanilla', MODS)
  eq(d[0].changed, false)
  eq(d[0].kind, 'same-value')
})

t('summarizeDefineDiffs 统计正确(含升降方向)', () => {
  const s = summarizeDefineDiffs(computeDefineDiffs(mkModel().entries, 'vanilla', MODS))
  eq(s.total, 4)
  eq(s.changed, 1, '只有 MANPOWER 真变了')
  eq(s.same, 2)
  eq(s.added, 1)
  eq(s.up, 1)
  eq(s.down, 0)
})

t('★ 排序:数值变化最显著的排最前', () => {
  const m = mkModel(roots, {
    vanilla: defs({ NGame: '\tBIG = 1\n\tSMALL = 1\n' }),
    mymod: defs({ NGame: '\tBIG = 1000\n\tSMALL = 2\n' }),
  })
  const d = computeDefineDiffs(m.entries, 'vanilla', MODS)
  eq(d[0].key, 'NGame.BIG', 'delta 999 应排最前')
  eq(d[1].key, 'NGame.SMALL')
})

t('parseDefines:注释只在 comment 字段,绝不混进 value', () => {
  const f = parseDefines(VANILLA, 'x.lua')
  const e = f.entries.find((x) => x.name === 'START_DATE')!
  eq(e.value, '1936.1.1', 'string 类型剥引号是既有约定')
  eq(e.comment, '游戏起始日期')
})

/* ══ 双语法(2026-10-07 实测加的)══
 * vanilla 是块形态 `NGame = { KEY = v }`,模组几乎全是点形态
 * `NDefines.NGame.KEY = v`。实测 34 个模组 defines 文件里 26 个用点形态、
 * 约 3200 条 —— 只认块形态的话「模组改了什么」一条都看不见。
 * 夹具用的是 Kaiserreich KR_defines.lua 的真实行。*/

t('★ 点号形态被解析,且键名与块形态对齐', () => {
  const src =
    'NDefines.NWiki.BASE_URL = "https://kaiserreich.wiki"\n' +
    '-- Vanilla is "http://www.hoi4wiki.com/"\n' +
    '\n' +
    'NDefines.NGame.SAVE_VERSION = 170\t\t-- Vanilla is 30\n' +
    'NDefines.NGame.END_DATE = "1959.1.1.1"\t-- Vanilla is 1949.1.1.1\n'
  const f = parseDefines(src, 'KR_defines.lua')
  eq(f.entries.length, 3, '实际 ' + JSON.stringify(f.entries.map((e) => e.key)))
  const sv = f.entries.find((e) => e.key === 'NGame.SAVE_VERSION')!
  ok(sv, '键名应规整成 NGame.SAVE_VERSION,实际 ' + JSON.stringify(f.entries.map((e) => e.key)))
  eq(sv.group, 'NGame')
  eq(sv.num, 170)
  eq(sv.comment, 'Vanilla is 30', '注释要剥离但保留')
  const w = f.entries.find((e) => e.key === 'NWiki.BASE_URL')!
  eq(w.type, 'string')
  eq(w.value, 'https://kaiserreich.wiki')
})

t('★ 点号形态的键能与 vanilla 块形态对上(跨语法比较的前提)', () => {
  const vanilla = defs({ NGame: '\tSAVE_VERSION = 33\n\tEND_DATE = "1949.1.1.1"\n' })
  const mod = 'NDefines.NGame.SAVE_VERSION = 170\nNDefines.NGame.END_DATE = "1959.1.1.1"\n'
  const rts = [
    { name: 'vanilla', path: '/g/g', writable: false },
    { name: 'KR', path: '/m/kr', writable: true },
  ]
  const m = mkModel(rts, { vanilla, KR: mod })
  const d = computeDefineDiffs(m.entries, 'vanilla', new Set(['KR']))
  eq(d.length, 2, '应产出 2 条差异,实际 ' + JSON.stringify(d.map((x) => x.key)))
  const sv = d.find((x) => x.key === 'NGame.SAVE_VERSION')!
  eq(sv.changed, true)
  eq(sv.base!.num, 33)
  eq(sv.mod!.num, 170)
  eq(sv.delta, 137)
  // 字符串值也能比出「变了」
  const ed = d.find((x) => x.key === 'NGame.END_DATE')!
  eq(ed.changed, true)
  eq(ed.base!.value, '1949.1.1.1')
  eq(ed.mod!.value, '1959.1.1.1')
})

t('★ 同文件内两种语法混用各自都认', () => {
  const src =
    'NDefines.NGame.SAVE_VERSION = 170\n' +
    '\n' +
    'NDefines.NPolitics = {\n' +
    '\tBASE_POLITICAL_POWER_INCREASE = 1.5\n' +
    '}\n' +
    'NDefines.NGame.END_DATE = "1959.1.1.1"\n'
  const f = parseDefines(src, 'mixed.lua')
  eq(f.entries.length, 3, '实际 ' + JSON.stringify(f.entries.map((e) => e.key + '=' + e.value)))
  // 块形态带 NDefines. 前缀时也要认 —— 原来正则不含点号,整块被静默丢掉
  const pol = f.entries.find((e) => e.key === 'NPolitics.BASE_POLITICAL_POWER_INCREASE')!
  ok(pol, '块形态那条应被解析')
  eq(pol.num, 1.5)
  eq(f.entries.filter((e) => e.group === 'NGame').length, 2)
})

t('外层容器 NDefines_Graphics = { 不产出条目', () => {
  const src = 'NDefines_Graphics = {\n\tSOMETHING = 1\n}\n'
  const f = parseDefines(src, 'g.lua')
  eq(f.entries.length, 0, '容器本身不是分组,不该产出键')
})

t('点号形态不误伤:普通 NDefines 前缀但只有一段的不认', () => {
  const f = parseDefines('NDefines.SOMETHING = 1\n', 'x.lua')
  eq(f.entries.length, 0, '只有一段时无法确定 group,应跳过而非造出假键')
})

console.log(`\ndefines 差异: ${pass}/${pass + fails.length} 通过`)
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
