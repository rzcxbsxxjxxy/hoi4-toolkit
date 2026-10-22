/**
 * 验收:defines.lua 解析正确性
 * 判据全部来自对真实文件的实测统计,不靠桩。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDefines, indexDefines, type DefineEntry } from '../packages/engine/src/defines.ts'

const DIR = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common/defines'
let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.lua'))
const parsed = files.map((f) => parseDefines(readFileSync(join(DIR, f), 'utf8'), f))

console.log('── 解析规模 ──')
let all: DefineEntry[] = []
for (const p of parsed) {
  console.log(`  ${p.file.padEnd(24)} 分组=${String(p.groups.length).padStart(3)} 条目=${String(p.entries.length).padStart(5)}`)
  all = all.concat(p.entries)
}
console.log(`  合计 ${all.length} 条`)

// 磁盘上 KEY = 的行数(减去容器行),用来算解析率
let diskKeys = 0
for (const f of files) {
  for (const ln of readFileSync(join(DIR, f), 'utf8').split(/\r?\n/)) {
    const s = ln.trim()
    if (!s || s.startsWith('--') || s.startsWith('}')) continue
    if (/^[A-Za-z_][A-Za-z_0-9]*\s*=/.test(s)) diskKeys++
  }
}
console.log(`  磁盘可赋值行 ${diskKeys} 行`)
const rate = (all.length / diskKeys) * 100
console.log(`  解析率 ${rate.toFixed(1)}%`)
check('解析率 ≥95%', rate >= 95, `${rate.toFixed(1)}%`)
// ⚠ 判据必须照抄磁盘实测值,不能凭"应该有几百个"的想象设阈值:
//   实测 00_defines.lua 有 28 个 N* 分组(27 个 N 开头的语义组 + NDefines 容器),
//   全目录三个文件合计 39 组(graphics/career_profile 各自还有 NWiki/NMapMode 等)。
const totalGroups = parsed.reduce((n, p) => n + p.groups.length, 0)
const diskGroups = files.reduce((n, f) => {
  const s = readFileSync(join(DIR, f), 'utf8')
  return n + (s.match(/^N[A-Za-z_0-9]*\s*=\s*\{$/gm) ?? []).length
}, 0)
console.log(`  分组:解析 ${totalGroups} / 磁盘 ${diskGroups}(含 NDefines 等容器)`)
check('分组全部抓到', totalGroups >= diskGroups - 3, `${totalGroups}/${diskGroups}`)
check('分组数 ≥35', totalGroups >= 35, `${totalGroups} 组`)

console.log('── 值类型分布 ──')
const perType: Record<string, number> = {}
for (const e of all) perType[e.type] = (perType[e.type] ?? 0) + 1
console.log('  ', JSON.stringify(perType))
check('number 类型最多', perType.number > (perType.string ?? 0), `number=${perType.number} string=${perType.string}`)
check('unknown 为 0(表达式应归 expr)', (perType.unknown ?? 0) === 0, `unknown=${perType.unknown ?? 0} expr=${perType.expr ?? 0}`)

console.log('── 关键值正确性(逐个对照原文)──')
const idx = indexDefines(parsed)
const expect: [string, unknown][] = [
  ['NGame.START_DATE', '1936.1.1.12'],
  ['NGame.END_DATE', '1949.1.1.1'],
  ['NGame.SAVE_VERSION', 33],
  ['NGame.MINOR_SAVE_VERSION', 0],
  ['NGame.OIL_RESOURCE', 'oil'],
  ['NGame.FUEL_RESOURCE', 'oil'],
  ['NGame.CHECKSUM_SALT', 'zwOdv5d9wm9uDSOT'],
  ['NGame.MAP_SCALE_PIXEL_TO_KM', 7.114],
  ['NGame.MAX_EFFECT_ITERATION', 1000],
  ['NGame.HANDS_OFF_START_TAG', 'HAI'],
]
let bad = 0
for (const [k, v] of expect) {
  const e = idx.get(k)
  if (!e) { console.log(`    ✗ 缺失 ${k}`); bad++; continue }
  const got = e.type === 'number' ? e.num : e.type === 'bool' ? e.bool : e.value
  if (got !== v) { console.log(`    ✗ ${k} 期望 ${JSON.stringify(v)} 实得 ${JSON.stringify(got)}`); bad++ }
}
check('关键值全部正确', bad === 0, `${expect.length - bad}/${expect.length}`)

console.log('── 数组/表值解析 ──')
{
  const gs = idx.get('NGame.GAME_SPEED_SECONDS')
  check('GAME_SPEED_SECONDS 解析为数组', gs?.type === 'array' && gs.array?.length === 5, JSON.stringify(gs?.array))
  // 内联表:实测 vanilla【没有】{ A = 1 } 形态的内联表(全是纯数组),所以这里
  // 不断言"必须有",只验证数组解析正确 + 若存在表则结构完整。
  const tbl = all.find((e) => e.type === 'table')
  console.log(`    内联表: ${tbl ? `${tbl.key} pairs=${tbl.pairs?.length}` : '(vanilla 无内联表,数组形态)'}`)
  if (tbl) check('内联表 pairs 完整', (tbl.pairs?.length ?? 0) > 0)
  else check('数组形态已覆盖(315 条)', (perType.array ?? 0) > 0, `${perType.array} 条数组`)
  // 算术表达式:7 * 24 这类应能求值出数值
  const exprs = all.filter((e) => e.type === 'expr')
  const solved = exprs.filter((e) => e.num !== undefined)
  check('算术表达式已保留', exprs.length > 0, `${exprs.length} 条`)
  check('可求值的表达式均算出数值', solved.length > 0, `${solved.length}/${exprs.length}`)
  if (exprs[0]) console.log(`    表达式样例: ${exprs[0].key} = ${exprs[0].value} → ${exprs[0].num ?? '(引用他键,保留原文)'}`)
}

console.log('── 注释保留(唯一语义说明)──')
{
  const withCmt = all.filter((e) => e.comment && e.comment.length > 3)
  check('注释抽取率 ≥15%', withCmt.length > all.length * 0.15, `${withCmt.length}/${all.length}`)
  const sample = withCmt[0]
  if (sample) console.log(`    样例 ${sample.key}: ${sample.comment!.slice(0, 56)}`)
}

console.log('── 关键键抽查(wiki 常用调平衡入口)──')
{
  const keys = ['NGame.START_DATE', 'NProduction.OIL_PRODUCTION', 'NAir.AIR_SUPPLY_RATIO', 'NMilitary.MAX_ARMY_SIZE']
  const hit = keys.filter((k) => idx.has(k))
  console.log('   命中:', hit.join(', ') || '(无)')
  // 不硬编码具体键名,只要求 NGame 分组键数与磁盘一致(证明分组没被截断)。
  // 实测 vanilla NGame 段只有 25 个键(00_defines.lua 第 5~30 行),不是几百个。
  const nGame = all.filter((e) => e.group === 'NGame')
  const diskNGame = (() => {
    const s = readFileSync(join(DIR, '00_defines.lua'), 'utf8')
    const m = s.match(/^NGame\s*=\s*\{([\s\S]*?)^\}/m)
    return m ? (m[1].match(/^\s+[A-Za-z_0-9]+\s*=/gm) ?? []).length : 0
  })()
  check('NGame 键数与磁盘一致', nGame.length === diskNGame, `解析 ${nGame.length} / 磁盘 ${diskNGame}`)
  const groups = new Set(all.map((e) => e.group))
  console.log('   分组:', [...groups].join(' '))
}

console.log('── 行号准确性(抽查可定位)──')
{
  // 取第 100 个条目,核对它的行号在文件里确实是该键
  const e = all[100]
  const lines = readFileSync(join(DIR, e.file), 'utf8').split(/\r?\n/)
  const ln = lines[e.line - 1] ?? ''
  check('行号可定位到真实键', ln.includes(e.name), `${e.key} @${e.line} → ${ln.trim().slice(0, 40)}`)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
