/**
 * state 全字段解析的语义单测(2026-10-07)。
 *
 * 夹具全部是**本机真实文件内容**,不是编的:
 *   1-France.txt        → 多胜利点块 + 省级建筑块(3838 = { naval_base })
 *   1021 - Actual Singapore.txt → 嵌套 naval_headquarters + has_dlc 门控
 *   327-Philippines.txt → resources 块 + 多 add_core_of
 * 凭想象写的用例会漏掉配平与嵌套的坑,所以这里逐字照抄。
 */
import { parseStateFileForTest as P } from '../src/mapmodel.ts'

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
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  if (ja !== jb) throw new Error(`${msg}\n  期望 ${jb}\n  实际 ${ja}`)
}
function ok(v: unknown, msg = '') {
  if (!v) throw new Error(msg || '期望为真')
}

/* ── 夹具 1:本机 1-France.txt 原文 ── */
const FRANCE = `state = {
\tid=1
\tname="STATE_1" # Corsica
\tmanpower = 322900
\t
\tstate_category = town

\thistory={
\t\towner = FRA
\t\tvictory_points = { 3838 1 }
\t\tbuildings = {
\t\t\tinfrastructure = 2
\t\t\tindustrial_complex = 1
\t\t\tair_base = 1
\t\t\t3838 = {
\t\t\t\tnaval_base = 3
\t\t\t}
\t\t}
\t\tadd_core_of = COR
\t\tadd_core_of = FRA
\t}

\tprovinces={
\t\t3838 9851 11804 
\t}

\tlocal_supplies=0.0 
}
`

/* ── 夹具 2:本机 1021 - Actual Singapore.txt 原文(嵌套 + DLC 门控)── */
const SINGAPORE = `state = {
\tid = 1021
\tname = "STATE_1021"
\tmanpower = 557745
\t
\tstate_category = large_town
\t
\tresources = {
\t\tsteel = 10
\t\ttungsten =29
\t\taluminium = 5
\t}

\thistory = {

\t\towner = ENG
\t\tadd_core_of = MAL
\t\tadd_core_of = SNG

\t\tvictory_points = {
\t\t\t12299 10 # Singapore
\t\t}

\t\tbuildings = {

\t\t\tinfrastructure = 2
\t\t\tindustrial_complex = 1
\t\t\tair_base = 6

\t\t\t12299 = {
\t\t\t\tnaval_base = 8
\t\t\t\tcoastal_bunker = 3
\t\t\t\tnaval_supply_hub = 1
\t\t\t\tnaval_headquarters = {
\t\t\t\t\tlevel = 1
\t\t\t\t\tallowed = {
\t\t\t\t\t\thas_dlc = "No Compromise, No Surrender"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}

\t\t}
\t\t
\t}

\tprovinces = {
\t\t12299
\t}

\tlocal_supplies = 0.0 
}
`

/* ── 夹具 3:本机 327-Philippines.txt(多 victory_points 块 + resources) ── */
const PHILI = `state = {
\tid = 327
\tname = "STATE_327" # Manila
\tmanpower = 2277042 

\tresources = {
\t\tcoal = 1 #initial distribution
\t}
\t
\tstate_category = large_town

\thistory = {
\t\towner = PHI
\t\tadd_core_of = PHI
\t\tbuildings = {
\t\t\tinfrastructure = 3 #was: 5
\t\t\tindustrial_complex = 3
\t\t\tdockyard = 1 #was: 0
\t\t\tair_base = 6
\t\t\t10265 = {
\t\t\t\tnaval_base = 5
\t\t\t}
\t\t}
\t\tvictory_points = {
\t\t\t10265 15 # Manila
\t\t}
\t\tvictory_points = {
\t\t\t1221 1 # Batangas
\t\t}
\t\tvictory_points = {
\t\t\t4288 1 # Calapan
\t\t}
\t}
\tprovinces = {
\t\t1221 1288 1388 4233 4288 7323 10236 10265 10272 12236 
\t}
\tlocal_supplies = 0.0 
}
`

t('法国 state:基础字段(id/name/owner/provinces)', () => {
  const r = P('1-France.txt', FRANCE)
  eq(r.id, 1)
  eq(r.name, 'France')
  eq(r.owner, 'FRA')
  eq(r.provinces, [3838, 9851, 11804])
})

t('法国 state:人力/分类/补给', () => {
  const r = P('1-France.txt', FRANCE)
  eq(r.manpower, 322900)
  eq(r.stateCategory, 'town')
  eq(r.localSupplies, 0)
})

t('法国 state:核心国 add_core_of 两条都在', () => {
  const r = P('1-France.txt', FRANCE)
  eq(r.cores, ['COR', 'FRA'])
})

t('★ 法国 state:省级建筑块 3838={naval_base=3} 能展开(非配平正则会截断)', () => {
  const r = P('1-France.txt', FRANCE)
  const ids = r.buildings.map((b) => b.id)
  ok(ids.includes('infrastructure'), '缺 infrastructure:' + JSON.stringify(r.buildings))
  ok(ids.includes('industrial_complex'), '缺 industrial_complex')
  ok(ids.includes('air_base'), '缺 air_base')
  ok(ids.includes('naval_base'), '缺 naval_base:' + JSON.stringify(r.buildings))
  const nb = r.buildings.find((b) => b.id === 'naval_base')!
  eq(nb.level, 3, 'naval_base 层级应为 3')
})

t('★ 新加坡:resources 三项(注意 tungsten =29 无空格)', () => {
  const r = P('1021 - Actual Singapore.txt', SINGAPORE)
  eq(r.resources, [
    { id: 'steel', amount: 10 },
    { id: 'tungsten', amount: 29 },
    { id: 'aluminium', amount: 5 },
  ])
})

t('★ 新加坡:嵌套 naval_headquarters 展开成 level=1', () => {
  const r = P('1021 - Actual Singapore.txt', SINGAPORE)
  const hq = r.buildings.find((b) => b.id === 'naval_headquarters')
  ok(hq, '缺 naval_headquarters:' + JSON.stringify(r.buildings.map((b) => b.id)))
  eq(hq!.level, 1)
})

t('★ 新加坡:has_dlc 门控被记录下来(77 个 state 文件都有这类)', () => {
  const r = P('1021 - Actual Singapore.txt', SINGAPORE)
  eq(r.dlcGated, ['No Compromise, No Surrender'])
  const hq = r.buildings.find((b) => b.id === 'naval_headquarters')!
  eq(hq!.dlc, 'No Compromise, No Surrender', '门控 DLC 名应挂在该建筑上')
})

t('★ 新加坡:owner 仍取 ENG —— DLC 不改变归属,只改变建筑可用性', () => {
  const r = P('1021 - Actual Singapore.txt', SINGAPORE)
  eq(r.owner, 'ENG', 'owner 必须不受 DLC 门控影响,否则谎报归属')
})

t('菲律宾:三个 victory_points 块全部累计', () => {
  const r = P('327-Philippines.txt', PHILI)
  eq(r.victoryPoints, [
    [10265, 15],
    [1221, 1],
    [4288, 1],
  ])
})

t('菲律宾:注释(# Manila / #was: 5)不影响解析', () => {
  const r = P('327-Philippines.txt', PHILI)
  eq(r.owner, 'PHI')
  eq(r.cores, ['PHI'])
  // #was: 5 这类注释里的数字不能被当成值
  const inf = r.buildings.find((b) => b.id === 'infrastructure')!
  eq(inf.level, 3, 'infrastructure 应为 3 而不是注释里的 5')
})

t('菲律宾:provinces 10 个', () => {
  const r = P('327-Philippines.txt', PHILI)
  // 逐个数过:1221 1288 1388 4233 4288 7323 10236 10265 10272 12236
  eq(r.provinces, [1221, 1288, 1388, 4233, 4288, 7323, 10236, 10265, 10272, 12236])
})

t('资源与胜利点为空时给空数组,不报 undefined', () => {
  const r = P('999-x.txt', 'state={\n\tid=999\n\tname="X"\n\tprovinces={\n\t\t1 2\n\t}\n}\n')
  eq(r.resources, [])
  eq(r.victoryPoints, [])
  eq(r.buildings, [])
  eq(r.cores, [])
  eq(r.manpower, undefined)
})

t('文件名不含数字 → id=NaN(由调用方报诊断,不在此吞掉)', () => {
  const r = P('notanumber.txt', 'state={\n\tid=1\n}\n')
  ok(Number.isNaN(r.id), '应为 NaN 让上层报警')
})

console.log(`\nstate 解析: ${pass}/${pass + fails.length} 通过`)
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
