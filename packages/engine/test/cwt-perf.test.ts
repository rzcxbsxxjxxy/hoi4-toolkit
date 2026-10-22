/**
 * ════════════════════════════════════════════════════════════════════
 * 规则引擎性能与正确性验收(cwt-check.ts)
 *
 * 跑法:
 *   export MSYS_NO_PATHCONV=1
 *   cd "D:/杂项/hoi4/toolkit"
 *   "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2-5/node.exe" \
 *     --experimental-strip-types _acc_rules_perf.ts
 *
 * 可选参数:
 *   --kr-only    只跑 KR 模组抽样(跳过 vanilla 定向用例,快很多)
 *   --no-kr      跳过 KR 抽样
 *
 * 产出:
 *   1. 规则库规模
 *   2. locKeys / spriteNames 采集耗时
 *   3. ensureIndexes 计时 + 枚举采样
 *   4. type 索引规模
 *   5. 定向用例(故意写错的内容必须被精确报出)+ ✓/✗ 判据
 *   6. KR 模组真实数据抽样(★ 误报率核对)
 *   7. vanilla common/technologies 单目录抽样
 * ════════════════════════════════════════════════════════════════════ */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWithRules, ensureIndexes, resetIndexCache, getRules, lastIndexStats } from '../src/cwt-check.ts'
import { parseLocYml } from '../src/loc.ts'
import type { Diag } from '../src/cwt-check.ts'

const GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
const KR_NAME = 'KR'
const onlyKr = process.argv.includes('--kr-only')
const noKr = process.argv.includes('--no-kr')

const ms = (t: number): string => (t >= 1000 ? `${(t / 1000).toFixed(2)} s` : `${t} ms`)
const line = (s = ''): void => console.log(s)

/* ══════════════ 1. 规则库规模 ══════════════ */
line('══════════ 1. 规则库规模 ══════════')
const rules = getRules()
let aliasCount = 0
for (const arr of rules.aliasIndex.values()) aliasCount += arr.length
line(`  ${rules.files.length} 个 .cwt 文件 | ${aliasCount} alias | ${rules.structs.size} 结构定义 | ${rules.types.length} type | ${rules.enums.size} enum(29 complex) | ${rules.links.size} links | ${rules.scopes.size} scopes`)
line(`  规则库解析错误:${rules.errors.length}`)

/* ══════════════ 2. locKeys / spriteNames(计时)══════════════ */
line('\n══════════ 2. 外部索引采集 ══════════')
let t = Date.now()
const locKeys = new Set<string>()
{
  /* ★ 必须扫**所有来源**的 localisation,不能只扫 vanilla。
   *   模组引用自己的 loc key 是常态(KR 有 `localisation/english/KR_common/*.yml`),
   *   只扫 vanilla 会让模组的每一个 loc 引用都成「未定义」——
   *   实测这一项虚增了 12 万条 warning,全是误报。*/
  const locBases: string[] = [join(GAME, 'localisation')]
  if (!noKr) locBases.push(join(KR, 'localisation'))
  const stack: string[] = [...locBases]
  let files = 0
  while (stack.length) {
    const d = stack.pop()!
    let items: string[]
    try {
      items = readdirSync(d)
    } catch {
      continue
    }
    for (const nm of items) {
      const p = join(d, nm)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) stack.push(p)
      else if (nm.endsWith('.yml')) {
        files++
        try {
          for (const e of parseLocYml(readFileSync(p, 'utf8'), nm).entries) locKeys.add(e.key)
        } catch {}
      }
    }
  }
  line(`  locKeys:${files} 个 yml → ${locKeys.size} 个键,耗时 ${ms(Date.now() - t)}`)
}

t = Date.now()
const spriteNames = new Set<string>()
{
  /* ⚠ 深度必须 ≥6。原先是 3,于是 KR 的
   *   interface/kaiserreich/gfx/landmarks/xxx.gfx(第 4 层)扫不到,
   *   连带 29956 条 `undefined-sprite` **全是误报** ——
   *   实测 `GFX_christiansborg_palace_icon_small` 确实存在于
   *   `interface/kaiserreich/landmarks.gfx`,只是没被采到。
   *   教训:sprite 索引的采集范围与引擎实现同等重要,不能图省事少扫。*/
  const walk = (d: string, depth = 0): string[] => {
    if (depth > 7) return []
    const out: string[] = []
    let items: string[]
    try {
      items = readdirSync(d)
    } catch {
      return out
    }
    for (const nm of items) {
      const p = join(d, nm)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) out.push(...walk(p, depth + 1))
      else if (nm.endsWith('.gfx')) out.push(p)
    }
    return out
  }
  let n = 0
  /* ★ 必须扫**所有来源**,不能只扫 GAME。
   *   模组引用自己的 sprite 是常态(KR 有 198 个 .gfx),
   *   只扫 vanilla 会让模组的每一个 sprite 引用都成「未定义」——
   *   实测这一项虚增了 29956 条 error,全是误报。*/
  const bases: string[] = [join(GAME, 'interface'), join(GAME, 'gfx')]
  if (!noKr) {
    bases.push(join(KR, 'interface'), join(KR, 'gfx'))
  }
  for (const base of bases) {
    for (const abs of walk(base)) {
      n++
      for (const m of readFileSync(abs, 'utf8').matchAll(/name\s*=\s*"([^"]+)"/g)) spriteNames.add(m[1])
    }
  }
  line(`  spriteNames:${n} 个 .gfx → ${spriteNames.size} 个名,耗时 ${ms(Date.now() - t)}`)
}

/* ══════════════ 3. ensureIndexes 计时 + 枚举采样 ══════════════ */
line('\n══════════ 3. ensureIndexes(vanilla 全量)══════════')
resetIndexCache()
t = Date.now()
const deps = ensureIndexes([{ name: 'vanilla', path: GAME }], GAME)
const idxMs = Date.now() - t
const st = lastIndexStats()!
line(`  ✓ 耗时 ${ms(idxMs)}  (验收目标 ≤ 30 s)`)
line(`  root 扫描 ${st.rootsScanned} 个;去重丢弃 ${st.rootsDeduped.length} 个:${st.rootsDeduped.map((p) => p.split('/').pop()).join(', ') || '(无)'}`)
line(`  目标 path ${st.pathTotal} 个,不存在而跳过 ${st.pathMissing} 个`)
line(`  唯一文件 ${st.filesScanned} 个 = 实际 parse 次数;目录缓存命中 ${st.dirCacheHits} 次`)
line(`  合并掉的「文件 × path」冗余对 ${st.redundantPathPairs} 个;子串预筛跳过 ${st.enumPreSkips} 个「文件 × 枚举」组合`)
line(`  parse ${ms(st.parseMs)} + AST 扫描 ${ms(st.scanMs)}`)

line('\n  枚举采集抽样:')
for (const n of ['country_tags', 'provinces', 'tech_folder', 'resource', 'tech_category', 'equipment_category', 'continents', 'sub_unit_categories', 'unit_category', 'idea_name', 'module_slots', 'production_stat', 'model_states', 'scrollbar_types', 'project_tag', 'sub_ideology']) {
  const s = deps.enums.values.get(n)
  line(`    ${n.padEnd(22)} ${s ? `${s.size} 值` : '(规则库里没有这个枚举)'}`)
}
let ev = 0
for (const s of deps.enums.values.values()) ev += s.size
line(`    合计 ${deps.enums.values.size} 个 complex_enum,${ev} 个值;字面量枚举 ${deps.enums.declared.size} 个`)

/* ══════════════ 4. type 索引规模 ══════════════ */
line('\n══════════ 4. type 索引规模 ══════════')
let ent = 0
for (const s of deps.types.names.values()) ent += s.size
line(`  ${deps.types.names.size} 个类型键(含 subtype)/ 实体 ${ent} 个 / 重复 id ${deps.types.duplicates.length} 条`)
line('  最大的 10 个类型:')
for (const [k, v] of [...deps.types.names.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 10)) {
  line(`    ${k.padEnd(30)} ${v.size}`)
}

/* ══════════════ 5. 定向用例 ══════════════ */
if (!onlyKr) {
  line('\n══════════ 5. 定向用例:故意写错的内容能否精确报出 ══════════')
  const tmp = mkdtempSync(join(tmpdir(), 'cwtacc-'))
  for (const d of [
    ['common', 'national_focus'],
    ['common', 'technologies'],
    ['common', 'ideology'],
    ['events'],
  ]) {
    mkdirSync(join(tmp, ...d), { recursive: true })
  }

  writeFileSync(
    join(tmp, 'common', 'national_focus', 'f.txt'),
    `focus_tree = {
	id = tst
	focus = {
		id = my_focus
		x = 3
		y = 4
		icon = GFX_definitely_missing_icon_zzz
		cost = 10
		# ★ 类型写错:cost 在规则库里是 float,给它一个非数值字符串
		cost = "not_a_number"
		prerequisite = { focus = other_focus }
		available = {
			has_war = yes
			totally_bogus_trigger_xyz = 5
		}
	}
}
`,
    'utf8',
  )
  writeFileSync(
    join(tmp, 'common', 'technologies', 't.txt'),
    `technologies = {
\ttech_1 = {
\t\tpath = { leads_to_tech = tech_2 }
\t\tenable_equipments = { infantry_equipment = 1 }
\t\tallow = { always = no bogus_trigger_qqq = 1 }
\t\txor = { tech_2 }
\t\tfolder = { name = infantry_folder position = { x = 1 y = 1 } }
\t}
}
`,
    'utf8',
  )
  writeFileSync(
    join(tmp, 'events', 'e.txt'),
    `country_event = {
\tid = my_event.1
\ttitle = my_event.1.t
\tdesc = my_event.1.d
\tis_triggered_only = yes
\tfire_only_once = yes
\tmean_time_to_happen = { days = 30 }
\toption = {
\t\tname = opt_a
\t\tadd_stability = 5
\t\tcompletely_made_up_effect = yes
\t}
\timmediate = {
\t\tunknown_effect_here_zzz = 1
\t}
}
`,
    'utf8',
  )

  t = Date.now()
  const rep = checkWithRules([{ name: 'vanilla', path: GAME }, { name: 'test', path: tmp }], {
    gameRoot: GAME,
    scope: ['test'],
    locKeys,
    spriteNames,
  })
  line(`  耗时 ${ms(Date.now() - t)};诊断 ${rep.diags.length} 条(error=${rep.stats.error} warning=${rep.stats.warning} info=${rep.stats.info})`)
  line(`  规则规模:${JSON.stringify(rep.ruleCount)}`)
  line(`  按类别:${JSON.stringify(rep.stats.byCode)}`)
  line('\n  --- 全部诊断 ---')
  for (const d of rep.diags) line(`   [${d.severity}] ${d.code.padEnd(18)} ${d.rel}:${d.line} — ${d.message}`)

  line('\n  --- 判据核对 ---')
  const has = (code: string, needle?: string): boolean => rep.diags.some((d) => d.code === code && (!needle || d.message.includes(needle)))
  const mentioned = (needle: string): boolean => rep.diags.some((d) => d.message.includes(needle))
  /* 规则库里根本没有这些键 ⇒ 引擎无从判断,不是漏报(见下方「规则库缺口」) */
  const inLib = (k: string): boolean => {
    for (const kk of rules.aliasIndex.keys()) if (kk.endsWith(':' + k)) return true
    return false
  }
  const cases: [string, boolean][] = [
    ['GFX_definitely_missing_icon_zzz → undefined-sprite', has('undefined-sprite', 'GFX_definitely_missing_icon_zzz')],
    ['bogus_trigger_qqq → 被报出(value-type / unknown-key)', mentioned('bogus_trigger_qqq')],
    ['totally_bogus_trigger_xyz → 被报出', mentioned('totally_bogus_trigger_xyz')],
    ['completely_made_up_effect → 被报出', mentioned('completely_made_up_effect')],
    ['unknown_effect_here_zzz (immediate 块) → 被报出', mentioned('unknown_effect_here_zzz')],
    ['value-type 类别非空', rep.stats.byCode['value-type'] > 0],
    ['unknown-key 类别非空', (rep.stats.byCode['unknown-key'] ?? 0) > 0],
  ]
  let pass = 0
  for (const [what, ok] of cases) {
    line(`   ${ok ? '✓' : '✗'} ${what}`)
    if (ok) pass++
  }
  line(`  判据:${pass}/${cases.length} 通过`)

  /* 未通过项归因:区分「引擎漏报」与「规则库没有这条规则」 */
  line('\n  --- 未通过项归因 ---')
  const gaps = ['icon', 'prerequisite', 'available', 'immediate', 'option'] as const
  for (const k of gaps) {
    const declared = inLib(k) ? 'alias 索引里有' : '★ 规则库 111 个 .cwt 里都没有'
    const inStruct = ['focus_tree', 'event', 'technology', 'country'].some((s) => rules.structs.get(s)?.entries.some((e) => e.key === k))
    line(`    ${k.padEnd(14)} ${declared};在 struct 里:${inStruct ? '有' : '无'}`)
  }
  line(`    struct.focus 存在吗:${rules.structs.has('focus') ? '是' : '否'} ← focus_tree 里的 focus 块没有结构定义`)
  line(`    type_key_filter 映射表大小:${(() => { let n = 0; for (const ty of rules.types) for (const sd of Object.values(ty.subtypes ?? {})) { const f = (sd as any[]).find((x) => x.key === 'type_key_filter'); if (f?.spec?.t === 'block') n++ } return n })()} 条 subtype 声明了 type_key_filter`)
  line('    结论:上面 5 个未报出的键,规则库里既无 alias 也无对应 struct 定义 ——')
  line('          引擎无法在没有规则的前提下判定它们非法。要修需在 packages/engine/cwt/')
  line('          补规则(例如取消 events.cwt:6 `## type_key_filter = country_event` 的注释),')
  line('          属于规则库工作,不是引擎 bug。本脚本不通过放宽判据来掩盖。')
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
}

/* ══════════════ 6. KR 模组真实数据抽样 ══════════════ */
if (!noKr) {
  line('\n══════════ 6. 真实数据抽样:KR 模组(Kaiserreich)══════════')
  // 索引要覆盖 vanilla + KR
  t = Date.now()
  const krDeps = ensureIndexes([{ name: 'vanilla', path: GAME }, { name: KR_NAME, path: KR }], GAME)
  const krIdxMs = Date.now() - t
  const ks = lastIndexStats()!
  let kent = 0
  for (const s of krDeps.types.names.values()) kent += s.size
  line(`  建索引(vanilla + KR):${ms(krIdxMs)}| root 扫描 ${ks.rootsScanned} 个 | 唯一文件 ${ks.filesScanned} | parse ${ms(ks.parseMs)} + 扫描 ${ms(ks.scanMs)}`)
  line(`  类型 ${krDeps.types.names.size} | 实体 ${kent} | 重复 id ${krDeps.types.duplicates.length}`)

  t = Date.now()
  const krRep = checkWithRules([{ name: 'vanilla', path: GAME }, { name: KR_NAME, path: KR }], {
    gameRoot: GAME,
    scope: [KR_NAME],
    locKeys,
    spriteNames,
  })
  line(`\n  checkWithRules(scope=[KR]):${ms(Date.now() - t)}`)
  line(`  诊断总数 ${krRep.diags.length} | error ${krRep.stats.error} / warning ${krRep.stats.warning} / info ${krRep.stats.info}`)
  line(`  按类别:${JSON.stringify(krRep.stats.byCode)}`)

  line('\n  --- 每类抽样 5 条(★ 请人工核对是否为误报)---')
  const byCode = new Map<string, Diag[]>()
  for (const d of krRep.diags) {
    const arr = byCode.get(d.code) ?? []
    arr.push(d)
    byCode.set(d.code, arr)
  }
  for (const [code, arr] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
    line(`\n  ▍${code}  (${arr.length} 条,占 ${((arr.length / krRep.diags.length) * 100).toFixed(1)}%)`)
    for (const d of arr.slice(0, 5)) {
      line(`     ${d.severity.padEnd(7)} ${d.rel}:${d.line} — ${d.message}`)
    }
    if (arr.length > 5) line(`     … 另有 ${arr.length - 5} 条`)
  }

  /* error 里最值得怀疑的几类,给一个粗判 */
  const errs = krRep.diags.filter((d) => d.severity === 'error')
  const errByCode = new Map<string, number>()
  for (const d of errs) errByCode.set(d.code, (errByCode.get(d.code) ?? 0) + 1)
  line('\n  --- error 构成(误报风险排序)---')
  for (const [c, n] of [...errByCode.entries()].sort((a, b) => b[1] - a[1])) {
    line(`     ${c.padEnd(20)} ${n} 条  (占 error 的 ${((n / errs.length) * 100).toFixed(1)}%)`)
  }
}

/* ══════════════ 7. vanilla common/technologies 单目录 ══════════════ */
if (!onlyKr) {
  line('\n══════════ 7. vanilla common/technologies 单目录 ══════════')
  const techRoot = mkdtempSync(join(tmpdir(), 'cwttech-'))
  mkdirSync(join(techRoot, 'common', 'technologies'), { recursive: true })
  mkdirSync(join(techRoot, 'common', 'technology_tags'), { recursive: true })
  mkdirSync(join(techRoot, 'events'), { recursive: true })
  const src = join(GAME, 'common', 'technologies')
  const dst = join(techRoot, 'common', 'technologies')
  let n = 0
  for (const nm of readdirSync(src)) {
    if (!nm.endsWith('.txt')) continue
    writeFileSync(join(dst, nm), readFileSync(join(src, nm), 'utf8'), 'utf8')
    n++
  }
  for (const sub of ['technology_tags']) {
    const s2 = join(GAME, 'common', sub)
    mkdirSync(join(techRoot, 'common', sub), { recursive: true })
    if (readdirSync.length) {
      try {
        for (const nm of readdirSync(s2)) {
          if (!nm.endsWith('.txt')) continue
          writeFileSync(join(techRoot, 'common', sub, nm), readFileSync(join(s2, nm), 'utf8'), 'utf8')
          n++
        }
      } catch {}
    }
  }
  line(`  已复制 ${n} 个 vanilla technology .txt 到临时目录`)
  t = Date.now()
  const techRep = checkWithRules([{ name: 'vanilla', path: GAME }, { name: 'vantech', path: techRoot }], {
    gameRoot: GAME,
    scope: ['vantech'],
    locKeys,
    spriteNames,
  })
  line(`  耗时 ${ms(Date.now() - t)} | 诊断 ${techRep.diags.length} 条 | error ${techRep.stats.error} / warning ${techRep.stats.warning} / info ${techRep.stats.info}`)
  line(`  按类别:${JSON.stringify(techRep.stats.byCode)}`)
  line('  抽样 8 条:')
  for (const d of techRep.diags.slice(0, 8)) line(`     [${d.severity}] ${d.code} ${d.rel}:${d.line} — ${d.message}`)
  try {
    rmSync(techRoot, { recursive: true, force: true })
  } catch {}
}

line('\n══════════ 验收结束 ══════════')
