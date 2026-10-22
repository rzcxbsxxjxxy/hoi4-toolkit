/**
 * 验收:common/ 目录覆盖对账(数据驱动,不写死清单)
 *
 * 做法:直接用 common-index 自带的 coverage.unruled —— 那是引擎自己算出的
 * "磁盘上存在 common/ 子目录,但没有任何规则覆盖"的目录。比人工维护一张
 * 期望清单可靠:新 DLC 加目录时,这个脚本会自己变红。
 *
 * 对账两边:
 *   - 磁盘:vanilla + 模组(KR) 的 common/ 实际子目录
 *   - 规则:COMMON_RULES 注册的 dir
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { COMMON_RULES } from '../packages/engine/src/common-rules.ts'
import { buildCommonIndex } from '../packages/engine/src/common-index.ts'

const VANILLA = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const MODS = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/workshop/content/394360'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

/**
 * common/ 下"数据目录"的判定。
 * ⚠ 不能只看有没有 .txt:实测 `map_modes/` 只有 documentation.md(无 .txt),
 *   但它仍是引擎认识的目录(规则里注册了 map_mode kind)。所以这里放宽为
 *   "目录下有任何文件"就算数据目录,否则会把 map_modes 误报成未覆盖。
 * 而 `achievements` 是【.txt 文件】不是目录,由 dir: 'achievements.txt' 规则覆盖,
 *   故另加 .txt 文件判定,免得反向检查把它误报成失效规则。
 */
function commonDirs(root: string): string[] {
  const dir = join(root, 'common')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      let hasAny = false
      try { hasAny = readdirSync(join(dir, e.name)).length > 0 } catch { /* ignore */ }
      if (hasAny) out.push(e.name)
    } else if (/\.txt$/i.test(e.name)) {
      out.push(e.name) // 形如 achievements.txt
    }
  }
  return out.sort()
}

const ruledDirs = new Set(COMMON_RULES.map((r) => r.dir))

console.log('── vanilla common/ 覆盖对账 ──')
const vDirs = commonDirs(VANILLA)
const unruled = vDirs.filter((d) => !ruledDirs.has(d))
console.log(`  磁盘目录 ${vDirs.length} 个,规则覆盖 ${vDirs.length - unruled.length} 个`)
check('无未覆盖目录', unruled.length === 0, unruled.length ? `未覆盖: ${unruled.join(', ')}` : '')

// 反向:规则里有没有指向不存在目录的(改名/移除的残留)
const stale = [...ruledDirs].filter((d) => !vDirs.includes(d) && !d.includes('.txt'))
check('无失效规则', stale.length === 0, stale.length ? `失效: ${stale.join(', ')}` : '')

console.log('── 规则定义自身健康度 ──')
{
  const dirs = new Map<string, number>()
  for (const r of COMMON_RULES) dirs.set(r.dir, (dirs.get(r.dir) ?? 0) + 1)
  const multi = [...dirs.entries()].filter(([, n]) => n > 1)
  console.log(`  注册目录 ${dirs.size} 个,规则 ${COMMON_RULES.length} 条,多规则目录 ${multi.length} 个`)
  check('规则总数与目录数匹配', COMMON_RULES.length >= dirs.size, `${COMMON_RULES.length} ≥ ${dirs.size}`)
  // 每条规则都要有 note,便于工作台展示语义
  const noNote = COMMON_RULES.filter((r) => !r.note)
  check('规则均有 note', noNote.length === 0, noNote.length ? `${noNote.length} 条缺 note` : '')
  // root 不能为空(除非是 matchKeys 模式)
  const badRoot = COMMON_RULES.filter((r) => !r.matchKeys && (!r.root || (Array.isArray(r.root) && !r.root.length)))
  check('root 配置有效', badRoot.length === 0, badRoot.length ? `${badRoot.length} 条异常` : '')
}

console.log('── 全量索引连通性(vanilla 全域)──')
{
  const idx = buildCommonIndex([{ name: 'vanilla', path: VANILLA }])
  console.log(`  索引定义 ${idx.defs.length} 条,引用 ${idx.refs.length} 条,文件 ${idx.stats.files} 个`)
  check('索引产出非空', idx.defs.length > 10000, `${idx.defs.length} 条`)
  check('无解析错误', idx.errors.length === 0, idx.errors.length ? `${idx.errors.length} 个错误: ${idx.errors[0]?.error?.slice(0, 60)}` : '')
  const kinds = new Map<string, number>()
  for (const d of idx.defs) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1)
  console.log(`  覆盖 kind ${kinds.size} 种,前 8:`, [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(' '))
  check('kind 种类充分(≥60)', kinds.size >= 60, `${kinds.size} 种`)
  const cf = idx.defs.filter((d) => d.kind === 'continuous_focus')
  check('continuous_focus 已进全量索引', cf.length > 0, `${cf.length} 条`)
}

console.log('── 创意工坊模组目录(若有)──')
{
  let mods: string[] = []
  try { mods = readdirSync(MODS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { /* ignore */ }
  if (!mods.length) {
    console.log('  (未发现模组目录,跳过)')
  } else {
    const krs = mods.filter((m) => m === '1521695605')
    if (krs.length) {
      const krDirs = commonDirs(join(MODS, '1521695605'))
      const krUnruled = krDirs.filter((d) => !ruledDirs.has(d))
      console.log(`  KR 模组目录 ${krDirs.length} 个`)
      check('KR 模组新增目录均被规则覆盖', krUnruled.length === 0, krUnruled.length ? `未覆盖: ${krUnruled.join(', ')}` : '')
    } else {
      console.log('  (KR 目录不存在,跳过)')
    }
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
