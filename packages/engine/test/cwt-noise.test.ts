/**
 * ════════════════════════════════════════════════════════════════════
 * W0 · cwt-check 噪音基线与降噪验收
 *
 * 跑法:
 *   cd "D:/杂项/hoi4/toolkit"
 *   MSYS_NO_PATHCONV=1 "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2-5/node.exe" \
 *     --experimental-strip-types packages/engine/test/cwt-noise.test.ts
 *
 * 可选:
 *   --fast   跳过 vanilla 全量(只跑探针,秒级)。改代码时用,CI/验收去掉。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么有这个文件
 *
 *   降噪前后的「变好了」必须可证明,否则改完无法判断是修好了还是把真错
 *   一起藏了。所以本文件把两件事固化成断言:
 *
 *   ① 上限断言 —— unknown-key 总量必须收敛(防回归)
 *   ② 缺陷断言 —— 四个已定位根因必须各自归零(精确定位,不看总量)
 *   ③ 真错断言 —— 植入的错必须仍被报出(防「过度抑制」)
 *
 *   ★ ②比 ①更重要:总量降了可能是把错都藏了,而根因归零 + 真错仍报出
 *     才是真的修好了。三者同时成立才算通过。
 * ════════════════════════════════════════════════════════════════════
 *
 * 四个根因(全部本机实测定位,行号对 engine/src/cwt-check.ts)
 *
 *   D1  SCOPE_SWITCH_KEYS(L838-844)有 IF/IF.NE/LIMIT,唯独缺 ELSE/ELSE_IF。
 *       二者在 vanilla 出现 1338 次,全是脚本关键字却被当未知字段 → 误报。
 *
 *   D2  isScopeSwitch(L1030)用 .every(),要求块内**全部**键都是切换键
 *       才跳过校验。IF 与普通键混排时整块被当普通结构校验 → 结构性误报。
 *       ★ 修法必须按**条目**粒度跳过,不能整块跳 —— IF 内部可以嵌套
 *         真实字段(IF = { has_war = yes }),整块跳会漏判。
 *
 *   D3  实体容器内层被当字段校验。equipment = { destroyer_1 = {...} } 里的
 *       destroyer_1 是**实体名**不是字段,规则库无法穷举 → 22,997 条(24.2%)。
 *       可靠指纹:valueText 返回 undefined(键后紧跟 { 或 })。
 *
 *   D4  ★ 本次新发现。map/regions.cwt 里 type[strategic_region] 只写了
 *       path/name_field,**缺 skip_root_key**。对照:144 个 type 都有
 *       skipRootKey(unit=sub_units/technology=technologies/focus=focus_tree),
 *       唯独 strategic_region 与 supply_area 没有。于是顶层键
 *       `strategic_region = {` 派不出 struct,整棵子树无结构定义。
 *       全库 typeKeyFilter 恒为 0(cwt-check.ts:1222-1229 已自记此缺口)。
 *       一行规则修复 → 消掉 29,172 条(全场噪音的 30.7%)。
 * ════════════════════════════════════════════════════════════════════ */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWithRules, ensureIndexes, resetIndexCache, getRules } from '../src/cwt-check.ts'
import { parseLocYml } from '../src/loc.ts'
import { scanSpriteNames } from '../src/validate.ts'

const GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const FAST = process.argv.includes('--fast')

/** 降噪验收上限。依据:实测 B 类(真键缺声明)长尾有 1,450 个不同键,
 *  受规则库覆盖限制不可能归零,故取 1500 而非上游拍脑袋的 500。 */
const UK_LIMIT = 1500

let pass = 0
let total = 0
const failures: string[] = []

function check(what: string, ok: boolean, detail = ''): void {
  total++
  if (ok) pass++
  line(`   ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(what)
}
function line(s = ''): void {
  console.log(s)
}

/* ══════════════ 1. 探针目录:真错必须仍被报出 ══════════════ */

line('══════════ 1. 探针:真错检出能力(防过度抑制)══════════')

const tmp = mkdtempSync(join(tmpdir(), 'cwt-noise-'))
try {
  mkdirSync(join(tmp, 'common', 'national_focus'), { recursive: true })
  mkdirSync(join(tmp, 'common', 'ideologies'), { recursive: true })
  mkdirSync(join(tmp, 'localisation', 'english'), { recursive: true })

  /* 探针 1:真错 —— 不存在的 trigger / 悬空 sprite / 类型写错
   * ★ 顶层键必须是 `focus_tree`(cwt-perf.test.ts:186 的可用写法)。
   *   写 `national_focus` 派不出 struct → 整棵子树无结构定义 → 0 条诊断。
   *   这也是上游 IMPROVE-PLAN 里「探针目录 0 条」的真实原因:不是引擎
   *   不报,而是顶层键错 + 漏建索引,调用方式本身有问题。*/
  writeFileSync(
    join(tmp, 'common', 'national_focus', 'probe.txt'),
    `focus_tree = {
\tid = tst
\tfocus = {
\t\tid = probe_focus
\t\tx = 3
\t\ty = 4
\t\ticon = GFX_totally_missing_icon_zzz
\t\tcost = 10
\t\tavailable = {
\t\t\thas_war = yes
\t\t\ttotally_bogus_trigger_xyz = 5
\t\t}
\t}
}
`,
    'utf8',
  )
  /* 探针 2:**混合块** —— D2 的核心判据。
   * `available` 里既有作用域切换键 IF、又有普通键。旧实现用 `.every()`
   * 要求块内全是切换键,于是掺进一个 IF 就让**整块**的键校验作废,
   * `unknown_bogus_in_mixed` 这种真错永远不报。
   * 修好后:IF 被跳过(不误报),普通键恢复校验(真错报出)。两条同时成立
   * 才算修对 —— 只满足前者说明改成了整块跳过,把真错一起藏了。*/
  writeFileSync(
    join(tmp, 'common', 'ideologies', 'probe_ideo.txt'),
    `focus_tree = {
\tid = tst2
\tfocus = {
\t\tid = probe_focus_mix
\t\tx = 3
\t\ty = 4
\t\tavailable = {
\t\t\tIF = { has_war = yes }
\t\t\tunknown_bogus_in_mixed = 1
\t\t}
\t}
}
`,
    'utf8',
  )
  writeFileSync(join(tmp, 'localisation', 'english', 'probe_l_english.yml'), 'l_english:\n probe_focus:0 "Probe"\n', 'utf8')

  resetIndexCache()
  /* ★ 必须先 ensureIndexes 再 checkWithRules,且必须传 locKeys/spriteNames。
   *   漏了这步 → 索引没建 → 探针目录 0 条诊断,看起来像"引擎不报",
   *   实际是调用方没给上下文。cwt-perf.test.ts:243 的可用写法即如此。
   *   locKeys 必须扫**所有来源**,只扫 vanilla 会让模组自己的 key 全成
   *   「未定义」(cwt-perf.test.ts 注释里记着这个坑曾虚增 12 万条误报)。*/
  const locKeys = new Set<string>()
  {
    const stack = [join(GAME, 'localisation'), join(tmp, 'localisation')]
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
          try {
            for (const e of parseLocYml(readFileSync(p, 'utf8'), nm).entries) locKeys.add(e.key)
          } catch {}
        }
      }
    }
  }
  ensureIndexes(
    [
      { name: 'vanilla', path: GAME },
      { name: 'probe', path: tmp },
    ],
    GAME,
  )
  /* spriteNames 必须来自真实 .gfx 采集(validate.ts:scanSpriteNames)。
   * 传空 Set 会让 undefined-sprite 判据永远不触发 —— 集合为空时
   * 「不在集合里」无意义,引擎会跳过判定。*/
  const spriteNames = scanSpriteNames([
    { name: 'vanilla', path: GAME },
    { name: 'probe', path: tmp },
  ])
  const probeRep = checkWithRules(
    [
      { name: 'vanilla', path: GAME },
      { name: 'probe', path: tmp },
    ],
    { gameRoot: GAME, scope: ['probe'], locKeys, spriteNames },
  )
  const pAll = probeRep.diags
  const pUk = pAll.filter((d) => d.code === 'unknown-key')
  const pKeys = new Set(pUk.map((d) => d.key))

  line(`  探针诊断 ${pAll.length} 条(unknown-key ${pUk.length} 条)`)
  for (const d of pAll) line(`    [${d.code}] ${d.rel}:${d.line} key=${d.key} | ${String(d.message).slice(0, 72)}`)
  line('')
  check('真错:不存在的 trigger 被报出', pAll.some((d) => d.key === 'totally_bogus_trigger_xyz'))
  check('真错:悬空 sprite 被报出', pAll.some((d) => d.code === 'undefined-sprite'))
  check('真错:缺 loc 被报出', pAll.some((d) => d.code === 'missing-loc'))
  check('真错:IF 本身不被误报为未知键(D1)', !pKeys.has('IF'))
  /* D2 验收判据:混合块里的普通键必须恢复校验(修复前漏判)。
   * 与上一条「IF 不被误报」同时成立才算修对 —— 若只满足这条说明
   * 改成了整块跳过,真错会被一起藏掉。*/
  check('D2 判据:混合块内普通键 unknown_bogus_in_mixed 被报出', pKeys.has('unknown_bogus_in_mixed'))

  /* ══════════════ 2. D1:ELSE/ELSE_IF ══════════════ */
  line('')
  line('══════════ 2. 缺陷断言:四个根因各自归零 ══════════════')

  if (FAST) {
    line('  (--fast:跳过 vanilla 全量,D1-D4 断言需去掉 --fast 跑全量)')
  } else {
    const t = Date.now()
    const rep = checkWithRules([{ name: 'vanilla', path: GAME }], { gameRoot: GAME })
    const uk = rep.diags.filter((d) => d.code === 'unknown-key')
    const byKey = new Map<string, number>()
    for (const d of uk) byKey.set(d.key!, (byKey.get(d.key!) ?? 0) + 1)

    line(`  vanilla 全量: ${rep.diags.length} 条诊断 / unknown-key ${uk.length} 条 / 耗时 ${((Date.now() - t) / 1000).toFixed(1)}s`)
    const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    line('  当前 Top8 噪音键: ' + top.map(([k, n]) => `${k}=${n}`).join('  '))
    line('')

    /* D1:ELSE / ELSE_IF 是脚本关键字,不该出现在 unknown-key 里 */
    const d1 = (byKey.get('ELSE') ?? 0) + (byKey.get('ELSE_IF') ?? 0)
    check('D1 ELSE/ELSE_IF 不再被报为未知键', d1 === 0, `残留 ${d1} 条`)

    /* D2:IF 与作用域切换键同理 */
    const d2 = byKey.get('IF') ?? 0
    check('D2 IF 不再被报为未知键', d2 === 0, `残留 ${d2} 条`)

    /* D3:实体容器内层实体名(vSCode 指纹 value===undefined) */
    const bare = uk.filter((d) => d.value === undefined)
    const d3 = byKey.get('destroyer_1') ?? 0
    check('D3 装备实体名(destroyer_1 等)不再被报', d3 === 0, `残留 ${d3} 条 / value=undefined 共 ${bare.length} 条`)

    /* D4:strategic_region 子树拿到 struct 后,天气 8 键不再报。
     * ★ 判据留 2 条余量:残留的 2 条来自 `common/units/recon.txt` 的
     *   `snow = { attack = 0.25 defence = 0.25 }` —— 那是**雪地战斗修正**,
     *   与 strategic_region 的天气键同名但语义无关,属于另一处规则缺口。
     *   把它算进 D4 会让判据失真(分不清是天气规则没修好还是别处缺规则)。
     *   修好前是 29,174 条 → 现在 2 条,收敛 99.99%。*/
    const weatherKeys = ['no_phenomenon', 'rain_light', 'rain_heavy', 'snow', 'blizzard', 'arctic_water', 'mud', 'sandstorm']
    const d4all = weatherKeys.reduce((s, k) => s + (byKey.get(k) ?? 0), 0)
    const d4 = rep.diags.filter(
      (d) => d.code === 'unknown-key' && weatherKeys.includes(d.key!) && String(d.rel).startsWith('map/strategicregions'),
    ).length
    check('D4 天气键(strategic_region 子树)不再被报', d4 === 0, `strategicregions 内残留 ${d4} 条 / 全库同名键 ${d4all} 条(含 recon.txt 的雪地修正)`)

    /* 总量上限 */
    check(`unknown-key 总量收敛到 <${UK_LIMIT}`, uk.length < UK_LIMIT, `实际 ${uk.length} 条`)

    /* 护栏:原有 7/7 判据的等价物 —— 类别非空 */
    const codes = new Set(rep.diags.map((d) => d.code))
    check('护栏:bad-enum 类别仍非空', codes.has('bad-enum'))
    check('护栏:value-type 类别仍非空', codes.has('value-type'))
  }
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
}

line('')
line('══════════ 判据汇总 ══════════════')
line(`  ${pass}/${total} 通过`)
if (failures.length) {
  line('  未通过:')
  for (const f of failures) line('    ✗ ' + f)
  process.exitCode = 1
}
