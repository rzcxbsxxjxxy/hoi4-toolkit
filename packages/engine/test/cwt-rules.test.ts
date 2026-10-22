/**
 * 规则引擎验收:定向用例(已知错误 → 必须精确报出)+ 性能。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { checkWithRules, ensureIndexes, resetIndexCache, getRules } from '../src/cwt-check.ts'
import { parseLocYml } from '../src/loc.ts'

const GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const rules = getRules()
let aliasCount = 0
for (const a of rules.aliasIndex.values()) aliasCount += a.length
console.log(`规则库 ${aliasCount} alias / ${rules.structs.size} structs / ${rules.types.length} type / ${rules.enums.size} enum; 错误 ${rules.errors.length}`)

// 本地化键(只扫 vanilla 的 localisation,够了)
console.log('\n扫本地化…')
const locKeys = new Set<string>()
{
  const stack = [join(GAME,'localisation')]
  let files = 0
  while (stack.length) {
    const d = stack.pop()!
    let items: string[]
    try { items = readdirSync(d) } catch { continue }
    for (const nm of items) {
      const p = join(d, nm)
      let s: any
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) stack.push(p)
      else if (nm.endsWith('.yml')) {
        files++
        try { for (const e of parseLocYml(readFileSync(p,'utf8'), nm).entries) locKeys.add(e.key) } catch {}
      }
    }
  }
  console.log(` ${files} 个 yml,${locKeys.size} 个键`)
}

// sprite 名
console.log('扫 sprite…')
const spriteNames = new Set<string>()
{
  const walk = (d: string, depth=0): string[] => {
    if (depth>3) return []
    const out: string[] = []
    let items: string[]
    try { items = readdirSync(d) } catch { return out }
    for (const nm of items) {
      const p = join(d, nm)
      let s: any
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) out.push(...walk(p, depth+1))
      else if (nm.endsWith('.gfx')) out.push(p)
    }
    return out
  }
  for (const base of [join(GAME,'interface'), join(GAME,'gfx')]) {
    for (const abs of walk(base)) {
      const txt = readFileSync(abs,'utf8')
      for (const m of txt.matchAll(/name\s*=\s*"([^"]+)"/g)) spriteNames.add(m[1])
    }
  }
  console.log(` ${spriteNames.size} 个 sprite 名`)
}

/* ── 建索引(计时)── */
console.log('\n建索引(枚举反向采集 + type 索引)…')
resetIndexCache()
const t0 = Date.now()
const deps = ensureIndexes([{ name: 'vanilla', path: GAME }], GAME)
console.log(` 耗时 ${Math.round((Date.now()-t0)/1000)}s`)
for (const n of ['country_tags','provinces','tech_folder','resource']) {
  const s = deps.enums.values.get(n)
  console.log(`  enum ${n.padEnd(14)} ${s? s.size+' 值':'未采到'}`)
}
let entTotal = 0
for (const s of deps.types.names.values()) entTotal += s.size
console.log(`  type 索引 ${deps.types.names.size} 类型 / ${entTotal} 实体 / ${deps.types.duplicates.length} 重复`)

/* ── 定向用例 ── */
console.log('\n=== 定向用例:写错的内容能否被精确报出 ===')
const tmp = mkdtempSync(join(tmpdir(),'cwtacc-'))
mkdirSync(join(tmp,'common','national_focus'), {recursive:true})
mkdirSync(join(tmp,'common','technologies'), {recursive:true})
mkdirSync(join(tmp,'events'), {recursive:true})
mkdirSync(join(tmp,'common','ideology'), {recursive:true})

writeFileSync(join(tmp,'common','national_focus','f.txt'), `focus_tree = {
	id = tst
	country = {
		focus = {
			id = my_focus
			x = 3
			y = 4
			icon = GFX_definitely_missing_icon_zzz
			cost = 10
			prerequisite = { focus = other_focus }
			available = {
				has_war = yes
				totally_bogus_trigger_xyz = 5
			}
		}
	}
}
`, 'utf8')

writeFileSync(join(tmp,'common','technologies','t.txt'), `technologies = {
	tech_1 = {
		path = { leads_to_tech = tech_2 }
		enable_equipments = { infantry_equipment = 1 }
		allow = { always = no bogus_trigger_qqq = 1 }
		xor = { tech_2 }
		folder = { name = infantry_folder position = { x = 1 y = 1 } }
	}
}
`, 'utf8')

writeFileSync(join(tmp,'events','e.txt'), `country_event = {
	id = my_event.1
	title = my_event.1.t
	desc = my_event.1.d
	is_triggered_only = yes
	fire_only_once = yes
	mean_time_to_happen = { days = 30 }
	option = {
		name = opt_a
		add_stability = 5
		completely_made_up_effect = yes
	}
	immediate = {
		unknown_effect_here_zzz = 1
	}
}
`, 'utf8')

const t1 = Date.now()
const rep = checkWithRules([{ name:'vanilla', path: GAME }, { name:'test', path: tmp }], {
  gameRoot: GAME, scope: ['test'], locKeys, spriteNames,
})
console.log(`耗时 ${Date.now()-t1}ms;诊断 ${rep.diags.length} 条 error=${rep.stats.error} warning=${rep.stats.warning} info=${rep.stats.info}`)
console.log('规则规模:', JSON.stringify(rep.ruleCount))
console.log('按类别:', JSON.stringify(rep.stats.byCode))
console.log('\n--- 全部诊断 ---')
for (const d of rep.diags) console.log(` [${d.severity}] ${d.code} ${d.rel}:${d.line} — ${d.message}`)

console.log('\n--- 判据核对 ---')
const must = [
  ['undefined-sprite', 'GFX_definitely_missing_icon_zzz'],
  ['value-type', 'bogus trigger(值域/枚举不合法)'],
  ['unknown-key', '结构里没有的键'],
]
for (const [code, what] of must) {
  const n = rep.diags.filter(d=>d.code===code).length
  console.log(` ${n>0?'✓':'✗'} ${code} — ${what}(报出 ${n} 条)`)
}
try { rmSync(tmp,{recursive:true,force:true}) } catch {}
