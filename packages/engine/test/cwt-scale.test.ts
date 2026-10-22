/**
 * cwt.ts 解析器验收:加载真实规则库,核对解析出来的规则数量。
 * 判据 = 报告里 CWTools 实测的量级(alias 1962 处 / 113 文件 / 45 顶层)。
 */
import { loadCwtRules, defaultCwtDir, isComplexEnum } from '../src/cwt.ts'

const dir = process.argv[2] || defaultCwtDir()
console.log('规则库目录:', dir)

const t0 = Date.now()
const R = loadCwtRules(dir)
const ms = Date.now() - t0

let aliasCount = 0
for (const arr of R.aliasIndex.values()) aliasCount += arr.length

console.log('\n=== 解析结果 ===')
console.log('耗时:', ms, 'ms')
console.log('文件数:', R.files.length)
console.log('alias 声明总数:', aliasCount)
console.log('alias 索引键数:', R.aliasIndex.size)
console.log('single_alias:', R.singleAliases.size)
console.log('type 声明:', R.types.length)
console.log('enum 总数:', R.enums.size, '(其中 complex_enum:', [...R.enums.values()].filter(isComplexEnum).length, ')')
console.log('links:', R.links.size)
console.log('scopes:', R.scopes.size)
console.log('modifier_categories:', R.modifierCategories.size)
console.log('values:', R.values.size)
console.log('localisation_commands:', R.localisationCommands.size)
console.log('解析错误:', R.errors.length)
for (const e of R.errors.slice(0, 8)) console.log('   ', e.file + ':' + e.line, e.error)

console.log('\n=== 命名空间分布(前12) ===')
const nsCount = new Map<string, number>()
for (const arr of R.aliasIndex.values()) for (const a of arr) nsCount.set(a.ns, (nsCount.get(a.ns) ?? 0) + 1)
for (const [ns, c] of [...nsCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ', ns.padEnd(24), c)
}

console.log('\n=== 抽查:add_stability 的声明与指令 ===')
for (const a of R.aliasIndex.get('effect:add_stability') ?? []) {
  console.log('  spec=', JSON.stringify(a.spec))
  console.log('  directives=', JSON.stringify(a.directives.map((d) => d.key + '=' + d.value)))
  console.log('  desc=', (a.desc ?? '').slice(0, 90))
}

console.log('\n=== 抽查:值域 int[a..b] ===')
let ranges = 0
for (const arr of R.aliasIndex.values()) for (const a of arr) if (a.spec.t === 'range') ranges++
console.log('  值域声明总数:', ranges)

console.log('\n=== 抽查:交叉引用 <type> ===')
let links2 = 0
for (const arr of R.aliasIndex.values()) for (const a of arr) if (a.spec.t === 'link') links2++
console.log('  交叉引用声明总数:', links2)

console.log('\n=== 抽查:递归通配 alias_name[X] ===')
let anySpec = 0
for (const arr of R.aliasIndex.values()) for (const a of arr) if (a.spec.t === 'any') anySpec++
console.log('  通配声明总数:', anySpec)

console.log('\n=== 抽查:type[technology] ===')
for (const t of R.types.filter((x) => ['technology', 'event', 'state', 'scripted_effect'].includes(x.name))) {
  console.log(' ', t.name, '| path=', JSON.stringify(t.path), '| nameField=', t.nameField, '| unique=', t.unique, '| structEntries=', t.entries.length, '| subtypes=', Object.keys(t.subtypes).join(','))
}

console.log('\n=== 抽查:complex_enum[country_tags] ===')
const ce = R.enums.get('country_tags')
if (ce && isComplexEnum(ce)) {
  console.log('  path=', JSON.stringify(ce.path), 'startFromRoot=', ce.startFromRoot, 'unique=', ce.unique)
  console.log('  namePath=', JSON.stringify(ce.namePath.map((e) => e.key + '=' + JSON.stringify(e.spec))))
} else {
  console.log('  未找到或非 complex_enum')
}

console.log('\n=== 抽查:links ===')
for (const nm of ['owner', 'controller', 'state', 'country']) {
  const l = R.links.get(nm)
  if (l) console.log(' ', nm, '→ out=', l.outputScope, '| in=', JSON.stringify(l.inputScopes), '| prefix=', l.prefix)
}