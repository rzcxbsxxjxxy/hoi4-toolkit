/* TRIGGERS_V1 科技树条件验证(忠实 MU 版):对真实原版文件跑
 *  ① allow_branch 完整条件树解析
 *  ② DLC 门控求值(未命中 false / 面板勾选后 true)
 * 用法:node --experimental-strip-types tools/verify_tech_triggers.ts */
import { buildTechGraph, type TechRoot } from '../packages/engine/src/tech.ts'
import { emptyScope, evalTrigger, formatTrigger, collectConditions, type TrigNode } from '../packages/focus/src/trigger.ts'

const GAME = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const roots: TechRoot[] = [{ name: 'vanilla', path: GAME }]
let fail = 0
function ok(c: boolean, label: string, extra = '') {
  console.log((c ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''))
  if (!c) fail++
}
const g = buildTechGraph(roots)
const nodes = [...g.nodes.values()]
const withTrig = nodes.filter((n) => n.allowBranchTrig)
console.log('=== ① allow_branch 完整条件树 ===')
console.log(`  ${nodes.length} 个科技,其中 ${withTrig.length} 个带 allowBranchTrig(旧版只提 dlcs+单个 completedTech)`)
ok(withTrig.length > 0, '存在带 allowBranchTrig 的科技')
const dlcGated = withTrig.filter((n) => (n.allowBranchDlcs ?? []).length)
ok(dlcGated.length > 0, 'has_dlc 门控科技存在', `${dlcGated.length} 个`)
const keyFreq = new Map<string, number>()
for (const n of withTrig) for (const c of collectConditions(n.allowBranchTrig).values()) keyFreq.set(c.key, (keyFreq.get(c.key) ?? 0) + 1)
console.log('  条件键频次:', [...keyFreq.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ') || '(无)')

console.log('\n=== ② 两态求值(对齐 MU QV) ===')
const sc = emptyScope()
const sample = dlcGated[0]
if (sample) {
  console.log(`  样本: ${sample.id}  allow_branch = ${formatTrigger(sample.allowBranchTrig)?.slice(0, 80)}`)
  // 找第一片 has_dlc 叶子,按其规范化 nodeContent 命中
  const nc = (n: TrigNode | undefined | null): string | null => {
    if (!n || typeof n === 'boolean') return null
    if (n.type === 'leaf') return n.key.toLowerCase() === 'has_dlc' ? n.nodeContent : null
    for (const it of n.items) { const r = nc(it); if (r) return r }
    return null
  }
  const dlcNc = nc(sample.allowBranchTrig)
  ok(evalTrigger(sample.allowBranchTrig, sc) === false, `未勾选 DLC → false(分支隐藏)`)
  if (dlcNc) {
    const sc2 = emptyScope()
    sc2.add(dlcNc)
    ok(evalTrigger(sample.allowBranchTrig, sc2) === true, `勾选 ${dlcNc} → true(分支显形)`)
  } else {
    ok(false, '样本没找到 has_dlc 叶子(异常)')
  }
}
// 无条件的科技恒显形(前端 nodeVisState 对无 allowBranchTrig 兜底为 v=true)
const uncond = nodes.find((n) => !n.allowBranchTrig)
if (uncond) ok(uncond.allowBranchTrig == null, '无条件科技无 allowBranchTrig → 前端恒显形')

console.log('\n=== ③ conditions 清单口径(对齐服务端 collectConditions) ===')
const conds = new Map<string, number>()
for (const n of withTrig) for (const c of collectConditions(n.allowBranchTrig).values()) conds.set(c.nodeContent, (conds.get(c.nodeContent) ?? 0) + c.count)
console.log(`  唯一条件叶子(nodeContent 去重): ${conds.size} 条`)
console.log('  样例:', [...conds.keys()].slice(0, 6).join(' , '))
ok(conds.size > 0, '有唯一条件清单供面板渲染')

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail ? 1 : 0)