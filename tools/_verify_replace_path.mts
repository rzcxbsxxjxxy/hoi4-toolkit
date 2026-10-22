/**
 * _verify_replace_path.mts —— REPLACE_PATH_ALL_V1 冒烟测试(临时,验证后按需保留)
 *
 * ① 共享工具 collectDirRecursive 的确定性单元测试(合成微型来源)
 * ② isUnloadedByLaterReplacePath 逐来源卸载规则(游戏精确规则)
 * ③ 实机:base + Kaiserreich,断言 common/technologies 被 replace_path 卸载
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const E = (p) => pathToFileURL(join(ROOT, 'packages', 'engine', 'src', p)).href

const { collectDirRecursive, isUnloadedByLaterReplacePath } = await import(E('assetsrc.ts'))
const { parseModDescriptor } = await import(E('modmeta.ts'))
const { buildTechGraph } = await import(E('tech.ts'))

let fails = 0
function check(name, cond, detail) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (detail !== undefined ? '  ' + String(detail) : ''))
  if (!cond) fails++
}

/* ═══ ① 合成微型来源的单元测试 ═══ */
const td = join(tmpdir(), 'hoi4tk_rp_unit_' + Date.now())
const a = join(td, 'vanilla')
const b = join(td, 'modA')
mkdirSync(join(a, 'common/technologies'), { recursive: true })
mkdirSync(join(b, 'common/technologies'), { recursive: true })
writeFileSync(join(a, 'common/technologies/base_only.txt'), 'technologies = { }\n')
writeFileSync(join(a, 'common/technologies/shared.txt'), 'technologies = { }\n')
writeFileSync(join(b, 'common/technologies/shared.txt'), 'technologies = { }\n')
writeFileSync(join(b, 'common/technologies/mod_new.txt'), 'technologies = { }\n')
// modB 声明 replace_path = "common/technologies" 且不提供任何文件
const c = join(td, 'modB')
mkdirSync(join(c, 'common/technologies'), { recursive: true })
writeFileSync(join(c, 'descriptor.mod'), 'name="modB"\nreplace_path="common/technologies"\n')
// modC 声明 replace_path 且提供 shared.txt(更高优先级,覆盖 modA)
const d = join(td, 'modC')
mkdirSync(join(d, 'common/technologies'), { recursive: true })
writeFileSync(join(d, 'descriptor.mod'), 'name="modC"\nreplace_path="common/technologies"\n')
writeFileSync(join(d, 'common/technologies/shared.txt'), 'technologies = { }\n')

{
  const roots = [
    { name: 'vanilla', path: a, writable: false },
    { name: 'modA', path: b, writable: true },
    { name: 'modB', path: c, writable: true, replacePaths: parseModDescriptor(c).replacePaths },
    { name: 'modC', path: d, writable: true, replacePaths: parseModDescriptor(d).replacePaths },
  ]
  const r = collectDirRecursive(roots, 'common/technologies', { exts: ['.txt'] })
  console.log('  ① collectDirRecursive stats:', JSON.stringify(r.stats))
  check('collect: base_only.txt 游戏里不存在(gap)', r.byRel.get('common/technologies/base_only.txt')?.gap === true,
    'own=' + r.byRel.get('common/technologies/base_only.txt')?.own)
  check('collect: shared.txt 生效来源 = modC(override)', r.byRel.get('common/technologies/shared.txt')?.effective === 3,
    'effective=' + r.byRel.get('common/technologies/shared.txt')?.effective + ' own=' + r.byRel.get('common/technologies/shared.txt')?.own)
  check('collect: mod_new.txt 被 modB/modC 卸载(gap)', r.byRel.get('common/technologies/mod_new.txt')?.gap === true,
    'own=' + r.byRel.get('common/technologies/mod_new.txt')?.own)
  check('collect: stats 口径 total=3 gap=2 override=1', r.stats.total === 3 && r.stats.gap === 2 && r.stats.override === 1, JSON.stringify(r.stats))

  console.log('  ② isUnloadedByLaterReplacePath(逐来源加载规则):')
  check('per-source: root0/shared.txt 被卸载(有更高优先级声明者)', isUnloadedByLaterReplacePath(roots, 0, 'common/technologies/shared.txt') === true)
  check('per-source: root1/mod_new.txt 被卸载(modB/modC 在后)', isUnloadedByLaterReplacePath(roots, 1, 'common/technologies/mod_new.txt') === true)
  check('per-source: root1/shared.txt 被卸载(modC 在后)', isUnloadedByLaterReplacePath(roots, 1, 'common/technologies/shared.txt') === true)
  check('per-source: root3/shared.txt 不被卸载(自己最高)', isUnloadedByLaterReplacePath(roots, 3, 'common/technologies/shared.txt') === false)
  check('per-source: root0/other.txt 不被卸载(无覆盖)', isUnloadedByLaterReplacePath(roots, 0, 'common/ideas/other.txt') === false)
  check('per-source: 无 replacePaths 时全部加载', isUnloadedByLaterReplacePath([roots[0], roots[1]], 0, 'common/technologies/shared.txt') === false)
}

/* ═══ ③ 实机:base + Kaiserreich ═══ */
const s = JSON.parse(readFileSync(resolve(ROOT, 'gui-settings.json'), 'utf8'))
const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
const GAME = s.base
const krRoot = { name: 'kaiserreich', path: KR, writable: true, replacePaths: parseModDescriptor(KR).replacePaths }
const baseRoot = { name: 'vanilla', path: GAME, writable: false }
{
  const r = collectDirRecursive([baseRoot, krRoot], 'common/technologies', { exts: ['.txt'] })
  console.log('  ③ KR technologies stats:', JSON.stringify(r.stats))
  const naval = r.byRel.get('common/technologies/naval.txt')
  check('KR: naval.txt(仅 base 有)被卸载 gap', naval?.gap === true, 'own=' + naval?.own + ' effective=' + naval?.effective)
  check('KR: base 的 12 个共享文件全部被逐来源卸载', isUnloadedByLaterReplacePath([baseRoot, krRoot], 0, 'common/technologies/infantry.txt') === true)
}

const t0 = Date.now()
const gBase = buildTechGraph([{ name: 'vanilla', path: GAME }])
const t1 = Date.now()
const gKR = buildTechGraph([baseRoot, krRoot])
const t2 = Date.now()
console.log('  tech图构建: base ' + (t1 - t0) + 'ms(' + gBase.nodes.size + '节点) / base+KR ' + (t2 - t1) + 'ms(' + gKR.nodes.size + '节点)')
{
  const baseRoots = [...gBase.nodes.values()].filter((n) => n.root === 0).length
  check('KR: 无 replace_path 时 base 科技节点存在(root=0)', baseRoots > 0, baseRoots + ' 个 root=0')
  const krRoots = [...gKR.nodes.values()].filter((n) => n.root === 1).length
  const krZero = [...gKR.nodes.values()].filter((n) => n.root === 0).length
  check('KR: replace_path 后 base 科技文件不再加载(无 root=0 节点)', krZero === 0 && krRoots > 0, 'root=0: ' + krZero + ' / root=1: ' + krRoots)
}
/* 回归:roots 不带 replacePaths 时行为与现在完全一致(base 文件仍加载) */
{
  const gNoRp = buildTechGraph([{ name: 'vanilla', path: GAME }, { name: 'kaiserreich', path: KR }])
  const zero = [...gNoRp.nodes.values()].filter((n) => n.root === 0).length
  check('回归: roots 不带 replacePaths 时 base 文件仍加载(root=0 存在)', zero > 0, 'root=0: ' + zero)
}

rmSync(td, { recursive: true, force: true })
console.log(fails === 0 ? '═══ 冒烟测试全部通过 ═══' : '═══ 冒烟测试失败 ' + fails + ' 项 ═══')
process.exit(fails === 0 ? 0 : 1)
