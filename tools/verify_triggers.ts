/* TRIGGERS_V1 条件机制测试(忠实 MU 版):直接对真实原版文件跑
 *  ① offset 列表解析(多trigger)
 *  ② allow_branch 完整条件树 + IF/else_if/else 展开
 *  ③ 两态求值(true/false,对齐 MU QV)
 * 用法:node --experimental-strip-types tools/verify_triggers.ts */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../packages/parser/src/parser.ts'
import { keyText } from '../packages/parser/src/serialize.ts'
import type { Block, Document } from '../packages/parser/src/ast.ts'
import { parseOffsets, parseTriggerBlocks, parseTriggerBlock } from '../packages/focus/src/trigger-parse.ts'
import { emptyScope, evalTrigger, formatTrigger, collectConditions, type TrigNode } from '../packages/focus/src/trigger.ts'

const GAME = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const NF = join(GAME, 'common', 'national_focus')

let fail = 0
function ok(cond: boolean, label: string, extra = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''))
  if (!cond) fail++
}

function focusBlocks(doc: Document): { id: string; b: Block }[] {
  const out: { id: string; b: Block }[] = []
  const fbs = doc.root.entries.filter((e) => keyText(doc, e) === 'focus_tree' && e.block)
  const target = fbs[fbs.length - 1]?.block
  if (!target) return out
  for (const e of target.entries) {
    const k = keyText(doc, e)
    if (!k || !e.block) continue
    if (!/shared_focus|shared_military_focus|joint_focus/.test(k)) {
      out.push({ id: k, b: e.block })
      continue
    }
    for (const sub of e.block.entries) {
      const sk = keyText(doc, sub)
      if (sk && sub.block) out.push({ id: sk, b: sub.block })
    }
  }
  return out
}

console.log('=== ① offset 列表解析(旧版只取第一条) ===')
{
  const doc = parse(readFileSync(join(NF, 'czechoslovakia_mu.txt'), 'utf8'))
  const fbs = focusBlocks(doc)
  const multi = fbs.map((f) => ({ id: f.id, rules: parseOffsets(doc, f.b) })).filter((x) => x.rules.length > 1)
  console.log(`  czechoslovakia_mu.txt: ${fbs.length} 个国策,其中 ${multi.length} 个有多条 offset`)
  ok(multi.length > 0, '存在多条 offset 的国策(旧版会丢掉第2条起)')
  const withTrig = multi.filter((m) => m.rules.some((r) => r.trigger))
  ok(withTrig.length > 0, '其中带 trigger 的', `${withTrig.length} 个`)
  const sample = multi.sort((a, b) => b.rules.length - a.rules.length)[0]
  console.log(`  最多的一条: ${sample.id} → ${sample.rules.length} 条`)
  for (const r of sample.rules.slice(0, 3)) {
    console.log(`    (${r.x},${r.y})  ${r.trigger ? formatTrigger(r.trigger).slice(0, 90) : '(无条件)'}`)
  }
}

console.log('\n=== ② allow_branch 完整条件树 + IF/else_if/else 展开 ===')
{
  const files = ['generic_focus.txt', 'czechoslovakia_mu.txt', 'hungary_wuw.txt', 'usa.txt', 'germany.txt']
  let total = 0
  let withTrig = 0
  let expandedIf = 0
  const keyFreq = new Map<string, number>()
  const dlcs = new Set<string>()
  const gamerules = new Set<string>()
  const walkHasOrAndnot = (n: TrigNode): boolean => {
    if (typeof n !== 'object' || !n) return false
    if (n.type === 'or' || n.type === 'andnot' || n.type === 'ornot') return true
    if (n.type === 'leaf' || n.type === 'bool') return false
    return (n.items ?? []).some(walkHasOrAndnot)
  }
  for (const f of files) {
    let txt: string
    try { txt = readFileSync(join(NF, f), 'utf8') } catch { continue }
    const doc = parse(txt)
    for (const fb of focusBlocks(doc)) {
      const trigs = parseTriggerBlocks(doc, fb.b, 'allow_branch')
      if (!trigs.length) continue
      total++
      withTrig++
      const root: TrigNode = trigs.length === 1 ? trigs[0] : { type: 'and', items: trigs }
      for (const c of collectConditions(root).values()) keyFreq.set(c.key, (keyFreq.get(c.key) ?? 0) + 1)
      if (walkHasOrAndnot(root)) expandedIf++
      const scan = (n: TrigNode) => {
        if (typeof n !== 'object' || !n) return
        if (n.type === 'leaf') {
          const k = n.key.toLowerCase()
          if (k === 'has_dlc') dlcs.add(n.value.replace(/^"(.*)"$/, '$1'))
          if (k === 'has_game_rule') gamerules.add(n.nodeContent.replace(/\s+/g, ' '))
          return
        }
        for (const it of n.items ?? []) scan(it)
      }
      scan(root)
    }
  }
  console.log(`  ${files.length} 个文件里${total} 个国策带 allow_branch`)
  console.log('  条件键频次:', [...keyFreq.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '))
  console.log('  DLC 门控:', [...dlcs].join(', ') || '(无)')
  console.log('  游戏规则门控(nodeContent 规范化后去重):')
  for (const g of gamerules) console.log('    ', g.slice(0, 70))
  ok(keyFreq.has('has_dlc') || dlcs.size > 0, 'has_dlc 门控被解析出来(旧版会丢)')
  ok(gamerules.size > 0, 'has_game_rule 门控被解析出来(旧版会丢)', `${gamerules.size} 种规范化文本`)
  ok(expandedIf > 0, 'IF/else_if/else 被展开成 or/andnot 链(MU 语义,旧版是 opaque leaf)', `${expandedIf} 个`)

  // 真实 allow_branch:勾选 has_game_rule 门控后分支显隐必须改变(MU IF 展开生效)
  let ifEvalChecked = false
  outer: for (const f of files) {
    let txt: string
    try { txt = readFileSync(join(NF, f), 'utf8') } catch { continue }
    const doc = parse(txt)
    for (const fb of focusBlocks(doc)) {
      for (const t of parseTriggerBlocks(doc, fb.b, 'allow_branch')) {
        if (!walkHasOrAndnot(t)) continue
        const conds = collectConditions(t)
        const hide = [...conds.values()].find((c) => c.key.toLowerCase() === 'has_game_rule')
        if (!hide) continue
        const b0 = evalTrigger(t, emptyScope())
        const sc = emptyScope()
        sc.add(hide.nodeContent)
        const b1 = evalTrigger(t, sc)
        if (b0 !== b1) {
          ok(true, '真实 allow_branch:勾选 has_game_rule 门控改变分支显隐(MU IF 展开生效)', `empty=${b0} → +gate=${b1}`)
          ifEvalChecked = true
          break outer
        }
      }
    }
  }
  if (!ifEvalChecked) ok(false, '未找到勾选 has_game_rule 后显隐变化的 IF 样本')
}

console.log('\n=== ③ 两态求值(对齐 MU QV) ===')
{
  const t = (src: string, scope = emptyScope()) => {
    const doc = parse(src)
    let got: TrigNode | boolean | undefined = undefined
    const walk = (b: Block) => {
      for (const e of b.entries) if (e.block) {
        if (got === undefined) got = parseTriggerBlock(doc, e.block)
        if (got === undefined) walk(e.block)
      }
    }
    walk(doc.root)
    return got === undefined ? '(未解析)' : evalTrigger(got, scope)
  }

  const sc = emptyScope()
  ok(t('trigger = { has_completed_focus = abc }') === false, '未完成的 focus → false')
  sc.add('has_completed_focus = abc')
  ok(t('trigger = { has_completed_focus = abc }', sc) === true, '已完成的 focus → true')

  const sc2 = emptyScope()
  ok(t('trigger = { has_dlc = "SomePack" }', sc2) === false, 'has_dlc 未命中 → false')
  sc2.add('has_dlc = "SomePack"')
  ok(t('trigger = { has_dlc = "SomePack" }', sc2) === true, 'has_dlc 命中(字符串值带引号,MU b()) → true')
  ok(t('trigger = { NOT = { has_completed_focus = abc } }', sc2) === true, 'NOT(未命中) → true(MU 编译成 ornot)')
  ok(t('trigger = { NOT = { has_completed_focus = abc } }', sc) === false, 'NOT(命中) → false')

  const sc3 = emptyScope()
  ok(t('trigger = { OR = { has_completed_focus = a has_completed_focus = b } }', sc3) === false, 'OR 都未命中 → false')
  sc3.add('has_completed_focus = b')
  ok(t('trigger = { OR = { has_completed_focus = a has_completed_focus = b } }', sc3) === true, 'OR 其一命中 → true')

  ok(t('trigger = { some_mod_custom_trigger = { a = 1 } }') === false, '未登记键未命中 → false(MU 两态)')
  ok(t('trigger = { AND = { has_completed_focus = abc some_unknown = x } }') === false, 'AND 含未命中 → false')

  const sc4 = emptyScope()
  const HIDE = 'has_game_rule = { rule = obsolete_focus_branches_visibility option = HIDE }'
  sc4.add(HIDE)
  ok(t('trigger = { has_game_rule = { rule = obsolete_focus_branches_visibility option = HIDE } }', sc4) === true,
    'has_game_rule 块值按 b() 规范化字符串命中 → true')
  ok(t('trigger = { has_game_rule = { rule = obsolete_focus_branches_visibility option = SHOW } }', sc4) === false,
    'has_game_rule 不同 option → false')

  const sc5 = emptyScope()
  sc5.add('has_country_flag = my_flag')
  ok(t('trigger = { has_country_flag = my_flag }', sc5) === true, 'has_country_flag 命中 → true')
  ok(t('trigger = { has_country_flag = other }', sc5) === false, 'has_country_flag 未命中 → false')

  // IF = { limit = {...} body }:MU 展开为 or/andnot 链
  ok(t('trigger = { IF = { limit = { has_game_rule = { rule = obsolete_focus_branches_visibility option = HIDE } } has_completed_focus = abc } }') === false,
    'IF 分支:limit 未命中(HIDE 未勾) → false')
  const sc6 = emptyScope()
  sc6.add(HIDE)
  ok(t('trigger = { IF = { limit = { has_game_rule = { rule = obsolete_focus_branches_visibility option = HIDE } } has_completed_focus = abc } }', sc6) === true,
    'IF 分支:limit 命中(HIDE 已勾) → true')

  // always 化简
  ok(t('trigger = { always = yes }') === true, 'always = yes → true(化简为布尔)')
  ok(t('trigger = { always = no }') === false, 'always = no → false(化简为布尔)')
  ok(t('trigger = { AND = { always = yes has_completed_focus = abc } }') === false, 'AND 含 always=yes + 未命中 → false')
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail ? 1 : 0)