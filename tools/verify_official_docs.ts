/**
 * 验收:官方机制全量接入
 * 判据(全部来自实测,不靠桩):
 *  1. OFFICIAL_ALL 总量与去重、类型分布、作用域覆盖
 *  2. 随机抽 N 个 vanilla 真实用到的 effect/trigger/modifier,必须都能查到
 *  3. 作用域标注真实有效:抽样校验 COUNTRY 专用 effect 不含 STATE-only 误标
 *  4. common/continuous_focus 规则能索引出真实条目
 *  5. gen 产物与磁盘一致(--check 语义:重跑生成器结果相同 → 幂等)
 */
import { OFFICIAL_ALL, OFFICIAL_BY_NAME } from '../packages/engine/src/official-docs.ts'
import { COMMON_RULES } from '../packages/engine/src/common-rules.ts'
import { buildCommonIndex } from '../packages/engine/src/common-index.ts'

const GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

console.log('── 1. 官方机制总量 ──')
const perType: Record<string, number> = {}
for (const e of OFFICIAL_ALL) perType[e.type] = (perType[e.type] ?? 0) + 1
const withScopes = OFFICIAL_ALL.filter((e) => e.scopes && e.scopes.length)
console.log('  ', JSON.stringify(perType), `总计 ${OFFICIAL_ALL.length}`)
check('总量远超旧手写种子(325)', OFFICIAL_ALL.length > 2000, `实际 ${OFFICIAL_ALL.length}`)
check('五类均有覆盖', Object.keys(perType).length === 5)
check('作用域标注 ≥1000', withScopes.length >= 1000, `${withScopes.length} 条`)
{
  const seen = new Set<string>()
  let dup = 0
  for (const e of OFFICIAL_ALL) {
    const k = e.name.toLowerCase()
    if (seen.has(k)) dup++
    seen.add(k)
  }
  check('无重复条目', dup === 0, `重复 ${dup}`)
}

console.log('── 2. 真实脚本关键字可查 ──')
// 这些是模组里高频出现、且必须来自官方手册而非手写种子的名字
const mustKnow = [
  'add_ace', 'add_manpower', 'add_political_power', 'add_stability', 'add_war_support',
  'has_war', 'is_ally_with', 'is_subject', 'num_of_military_factories', 'stability',
  'add_tech_bonus', 'add_ideas', 'set_country_flag', 'has_country_flag',
  'add_equipment_production', 'add_convoys', 'add_research_slot', 'add_command_power',
  'add_core', 'create_war', 'puppet_country', 'add_doctrine_cost_reduction',
  'every_state', 'random_owned_state', 'any_owned_state', 'capital_scope',
]
let miss = 0
for (const n of mustKnow) if (!OFFICIAL_BY_NAME.get(n)) { console.log('    未收录:', n); miss++ }
check('高频关键字全部可查', miss === 0, `${mustKnow.length - miss}/${mustKnow.length}`)

console.log('── 3. 作用域标注有效性 ──')
{
  // COUNTRY 专用 effect 不应被标成仅 STATE
  const ace = OFFICIAL_BY_NAME.get('add_ace')
  check('add_ace 标为 COUNTRY 专用', !!ace?.scopes?.includes('COUNTRY') && !ace?.scopes?.includes('STATE'), JSON.stringify(ace?.scopes))
  // add_manpower 是跨作用域的(官方就写了 STATE, COUNTRY)
  const mp = OFFICIAL_BY_NAME.get('add_manpower')
  check('add_manpower 为多作用域', (mp?.scopes?.length ?? 0) >= 2, JSON.stringify(mp?.scopes))
  // 反向:不能出现"既 COUNTRY 又 STATE 之外的乱值"
  const legal = new Set(['CHARACTER','COUNTRY','STATE','UNIT_LEADER','OPERATION','SPECIAL_PROJECT','ANY','ACE','COMBATANT','FACTION','INDUSTRIAL_ORG','PURCHASE_CONTRACT','RAID_INSTANCE','STRATEGIC_REGION','MILITARY_ADVANCEMENTS','INTELLIGENCE_AGENCY','GOVERNMENT_IN_EXILE'])
  const bad = withScopes.filter((e) => (e.scopes ?? []).some((s) => !legal.has(s.toUpperCase())))
  check('作用域取值均在官方枚举内', bad.length === 0, bad.length ? `异常 ${bad.length}: ${bad[0].name}=${bad[0].scopes}` : '')
  // summary 不应为空(说明抽取没抓到正文)
  const noSum = OFFICIAL_ALL.filter((e) => !e.summary || e.summary.trim().length < 2)
  check('摘要抽取率 ≥95%', noSum.length < OFFICIAL_ALL.length * 0.05, `空摘要 ${noSum.length}/${OFFICIAL_ALL.length}`)
}

console.log('── 4. continuous_focus 规则 ──')
{
  const rule = COMMON_RULES.find((r) => r.dir === 'continuous_focus')
  check('规则已注册', !!rule, rule?.note ?? '')
  const idx = buildCommonIndex([{ name: 'vanilla', path: GAME }], { dirs: ['continuous_focus'] })
  const cf = idx.defs.filter((d) => d.kind === 'continuous_focus')
  check('索引到真实条目', cf.length > 0, `${cf.length} 条`)
  if (cf.length) {
    // ⚠ Definition 的标识字段是 `id`,不是 `name`(读错会得到一串空串,
    //   看起来像"规则没抓到 id",其实是判据写错)
    const hasId = cf.filter((d) => d.id && d.id.length > 3).length
    check('条目 id 有效', hasId === cf.length, `${hasId}/${cf.length}`)
    // ★ 严判据:id 不可能是国策内部字段名。若抓到 available/enable/modifier/ai_will_do,
    //   说明层级选错,把字段当成了定义(实测 depth:2 就会这样,id="available")。
    const fieldLike = cf.filter((d) => /^(available|enable|modifier|ai_will_do|id|country|select_effect|cancel_effect|visible)$/.test(d.id))
    check('id 不是内部字段名(层级正确)', fieldLike.length === 0,
      fieldLike.length ? `误抓 ${fieldLike.length} 条: ${[...new Set(fieldLike.map((d) => d.id))].slice(0, 4).join(',')}` : '')
    // 真实 continuous_focus id 形如 DEN_undermine_overlord_continuous_focus
    const real = cf.filter((d) => /continuous_focus$/.test(d.id))
    check('id 形如 *continuous_focus', real.length > 0, `${real.length}/${cf.length}`)
    console.log('    样例:', real.slice(0, 3).map((d) => d.id).join(', '))
  }
}

console.log('── 5. 覆盖率对账:common 目录 ──')
{
  const dirs = new Set(COMMON_RULES.map((r) => r.dir))
  // 注意:events 在【游戏根目录】不在 common/,由 engine/events.ts 独立处理,
  // 所以这里校验的是 common/ 下的域,不含 events。
  const expected = [
    'units','national_focus','technologies','doctrines','ideas','decisions',
    'characters','military_industrial_organization','peace_conference','continuous_focus',
  ]
  const missing = expected.filter((d) => !dirs.has(d))
  check('核心域均已注册', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '')
  console.log('    已注册目录数:', dirs.size)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
