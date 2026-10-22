/**
 * MODMETA / ASSETSRC / MAPMODEL 的语义回归测试
 *
 * 判据全部来自本机实测(36 个创意工坊模组 / 745 条 replace_path),
 * 不是拍脑袋的期望值:
 *  · replace_path 745/745 是小写正斜杠无首尾斜杠,但仍要能吃下 "Map/Terrain\" 这种写法
 *  · 235 条是三段及更深 → 不能只按两段匹配
 *  · 父子共存(map 与 map/terrain 同时声明)是常态 → 取并集,重复无害
 *  · dependencies 引用的是 name(36/36 唯一),且有 36 条悬空 + launcher 前缀 "+JP:"
 *  · history/states 是被 replace_path 改得最狠的目录(11 个模组都声明)
 *
 * 运行: node --experimental-strip-types packages/engine/test/modmeta-mapmodel.test.ts
 */
import { strict as A } from 'node:assert'
import {
  normRelPath,
  replacePathCovers,
  replacePathsHitting,
  parseModDescriptor,
  modBlock,
  modDepKey,
  buildDepGraph,
  versionMatches,
  type ModDescriptor,
} from '../src/modmeta.ts'
import { resolveAssets, resolveDir, type SrcRoot } from '../src/assetsrc.ts'
import { buildMapModel, parseStateFileForTest, MAP_ASSETS, auditReplacePaths } from '../src/mapmodel.ts'

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails: string[] = []
function t(name: string, fn: () => void): void {
  try {
    fn()
    pass++
  } catch (e: any) {
    fails.push(`${name}: ${e?.message ?? e}`)
  }
}

/* ══ 1. 路径规范化与 replace_path 判定 ══ */

t('normRelPath 处理反斜杠/首尾斜杠/重复斜杠/大小写', () => {
  A.equal(normRelPath('  Map/Terrain\\ '), 'map/terrain')
  A.equal(normRelPath('/common//abilities/'), 'common/abilities')
  A.equal(normRelPath('common\\abilities'), 'common/abilities')
})

t('replace_path 是目录语义:能盖子文件,不能盖兄弟目录', () => {
  const rp = ['common/abilities']
  A.ok(replacePathCovers(rp, 'common/abilities'))
  A.ok(replacePathCovers(rp, 'common/abilities/foo.txt'))
  A.ok(replacePathCovers(rp, 'common/abilities/sub/bar.txt'), '三段路径必须能命中')
  A.equal(replacePathCovers(rp, 'common/abilities_extra/x.txt'), false, '兄弟目录不能命中')
  A.equal(replacePathCovers(rp, 'common/ab'), false, '部分前缀不能命中')
})

t('replace_path 支持三段及更深(实测 235 条)', () => {
  const rp = ['common/decisions/categories']
  A.ok(replacePathCovers(rp, 'common/decisions/categories/a.txt'))
  A.equal(replacePathCovers(rp, 'common/decisions/catalogues/a.txt'), false)
})

t('父子共存取并集,重复声明无害(实测 10/11 个模组如此)', () => {
  const rp = ['map', 'map/strategicregions', 'map/supplyareas', 'map/terrain']
  A.ok(replacePathCovers(rp, 'map/provinces.bmp'))
  A.ok(replacePathCovers(rp, 'map/terrain/terrain.dds'))
  A.ok(replacePathCovers(rp, 'map/supplyareas/1-supplyarea.txt'))
  A.equal(replacePathCovers(rp, 'history/states/1-france.txt'), false, 'map 不该盖住 history')
  A.deepEqual(replacePathsHitting(rp, 'map/terrain/x.dds').sort(), ['map', 'map/terrain'], '命中项应含父目录')
})

/* ══ 2. .mod 解析 ══ */

t('modBlock 精确截断,不越界到下一个块', () => {
  const txt = ['dependencies={', '\t"A"', '\t"B"', '}', 'tags={', '\t"Sound"', '}'].join('\n')
  const b = modBlock(txt, 'dependencies')!
  A.ok(b.includes('"A"') && b.includes('"B"'))
  A.equal(b.includes('Sound'), false, '不能吃到 tags 块')
  A.equal(modBlock(txt, 'nonexistent'), null)
})

t('modBlock 兼容同行收尾', () => {
  A.equal(modBlock('dependencies={ "X" }', 'dependencies')!.trim(), '"X"')
})

t('modDepKey 剥掉 launcher 语言前缀', () => {
  A.equal(modDepKey('+JP:kaiserreich'), 'kaiserreich')
  A.equal(modDepKey('+JA:foo'), 'foo')
  A.equal(modDepKey('  Kaiserreich  '), 'kaiserreich')
  A.equal(modDepKey('Normal Name'), 'normal name')
})

t('versionMatches 通配符', () => {
  A.ok(versionMatches('1.19.*', '1.19.3.0'))
  A.ok(versionMatches('1.19.3.0', '1.19.3.0'))
  A.ok(versionMatches('1.*', '1.19.3.0'))
  A.equal(versionMatches('1.19.2.0', '1.19.3.0'), false)
  A.ok(versionMatches('', '1.19.3.0'), '空模式不判不兼容')
})

/* ── 造临时模组目录做端到端 ── */
const tmp = mkdtempSync(join(tmpdir(), 'modmeta-'))
function mkMod(name: string, files: Record<string, string>, modText?: string): string {
  const d = join(tmp, name)
  mkdirSync(d, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const p = join(d, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  if (modText !== undefined) writeFileSync(join(d, 'descriptor.mod'), modText)
  return d
}

const DESCR = (name: string, extra = '') =>
  [`name="${name}"`, 'version="1.0"', 'supported_version="1.19.*"', 'remote_file_id="999"', extra].join('\n')

t('parseModDescriptor 提取完整 replace_path / dependencies', () => {
  const d = mkMod(
    'ma',
    {
      'descriptor.mod':
        DESCR('ModA', 'replace_path="map"\nreplace_path="map/terrain"\nreplace_path="history/states"\ndependencies={\n\t"ModB"\n\t"+JP:ModB"\n}\ntags={\n\t"Sound"\n}\npicture="a.jpg"'),
    },
  )
  const m = parseModDescriptor(d)
  A.equal(m.hasModFile, true)
  A.equal(m.name, 'ModA')
  A.equal(m.remoteFileId, '999')
  A.deepEqual(m.replacePaths, ['map', 'map/terrain', 'history/states'])
  A.equal(m.replacePathsRaw.length, 3, '原文也要留一份')
  A.deepEqual(m.dependencies, ['ModB', '+JP:ModB'])
  A.deepEqual(m.depKeys, ['modb', 'modb'])
  A.deepEqual(m.tags, ['Sound'])
  A.equal(m.picture, 'a.jpg')
})

t('parseModDescriptor 无 .mod 时退化为推断,不抛错', () => {
  const d = mkMod('mb_nomod', { 'common/x.txt': 'y' })
  const m = parseModDescriptor(d)
  A.equal(m.hasModFile, false)
  A.equal(m.inferred, true)
  A.deepEqual(m.replacePaths, [])
})

t('parseModDescriptor 坏文件记 warning 不抛', () => {
  const d = mkMod('mc_bad', { 'descriptor.mod': DESCR('') + '\nreplace_path=""\n' })
  const m = parseModDescriptor(d)
  A.ok(m.warnings.some((w) => w.includes('replace_path')), `应记录空 replace_path,实际:${JSON.stringify(m.warnings)}`)
  A.ok(m.warnings.some((w) => w.includes('name')), '应记录缺 name')
})

/* ══ 3. 依赖图 ══ */

function descOf(dir: string, name: string, deps: string[], rps: string[] = []): ModDescriptor {
  return {
    dir,
    hasModFile: true,
    inferred: false,
    name,
    version: '1',
    supportedVersion: '',
    tags: [],
    replacePaths: rps,
    replacePathsRaw: rps,
    dependencies: deps,
    depKeys: deps.map(modDepKey),
    warnings: [],
  }
}

t('依赖图:只读来源展示名为「基础游戏」而非目录名', () => {
  // 实测踩过的坑:基础游戏没有 .mod(hasModFile=false),name 只能取目录名
  // → 界面显示 "hearts of iron iv"。这里按真实形态构造:无 .mod、无 name。
  const gv: ModDescriptor = {
    dir: '/g/Hearts of Iron IV',
    hasModFile: false,
    inferred: true,
    name: '',
    version: '',
    supportedVersion: '',
    tags: [],
    replacePaths: [],
    replacePathsRaw: [],
    dependencies: [],
    depKeys: [],
    warnings: [],
  }
  const g = buildDepGraph([gv, descOf('/m/kr', 'Kaiserreich', [])], { isGame: (m) => !m.hasModFile })
  const game = [...g.nodes.values()].find((n) => n.dir.includes('Hearts of Iron IV'))!
  A.equal(game.display, '基础游戏')
  A.ok(!/hearts of iron iv/i.test(game.display), `展示名不该是目录名,实际 ${game.display}`)
  const kr = [...g.nodes.values()].find((n) => n.name === 'Kaiserreich')!
  A.equal(kr.display, 'Kaiserreich', '有 .mod name 的仍用 name')
})

t('依赖图:按 name 索引 + 拓扑排序(依赖在前)', () => {
  const a = descOf('/m/base', 'Base', [])
  const b = descOf('/m/ka', 'Kaiserreich', [])
  const c = descOf('/m/tech', 'KR Tech Extension', ['Kaiserreich'])
  const g = buildDepGraph([a, b, c])
  A.equal(g.nodes.size, 3)
  A.equal(g.stats.edges, 1)
  A.equal(g.order.indexOf('kaiserreich') < g.order.indexOf('kr tech extension'), true)
})

t('依赖图:悬空依赖被记录而不是静默吞掉', () => {
  const g = buildDepGraph([descOf('/m/x', 'X', ['NotInstalled', '+JP:AlsoMissing'])])
  A.equal(g.stats.missing, 2)
  A.ok(g.issues.every((i) => i.kind === 'missing'))
  A.deepEqual(g.nodes.get('x')!.missingDeps, ['NotInstalled', '+JP:AlsoMissing'])
})

t('依赖图:自依赖被识别', () => {
  const g = buildDepGraph([descOf('/m/s', 'Self', ['Self'])])
  A.equal(g.stats.self, 1)
})

t('依赖图:环被标记且不抛错', () => {
  const g = buildDepGraph([descOf('/m/a', 'A', ['B']), descOf('/m/b', 'B', ['A'])])
  A.ok(g.stats.cycles >= 1, `应检出环,实际 ${g.stats.cycles}`)
  A.equal(g.issues.some((i) => i.kind === 'cycle'), true)
  A.ok(g.order.length >= 1, '环时仍要给出可用的退化序')
})

t('依赖图:name 撞车不导致模组消失', () => {
  const g = buildDepGraph([descOf('/x/dup', 'Same', []), descOf('/x/dup2', 'Same', [])])
  A.ok(g.nodes.size >= 2, `撞车时两个模组都要在图里,实际 ${g.nodes.size}`)
})

/* ══ 4. 资产归属(文件级) ══ */

const sandbox = mkdtempSync(join(tmpdir(), 'assetsrc-'))
function mkTree(root: string, files: string[]): void {
  for (const f of files) {
    const p = join(root, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, 'x')
  }
}
const baseTree = mkTree(join(sandbox, 'base'), [
  'map/provinces.bmp',
  'map/definition.csv',
  'map/strategicregions/1-england.txt',
  'map/supplyareas/1-sa.txt',
  'history/states/1-france.txt',
  'history/states/2-germany.txt',
  'history/states/3-poland.txt',
])
const modTree = join(sandbox, 'modA')
mkTree(modTree, [
  // 只提供 provinces.bmp,不提供 definition.csv → 后者仍是原版的
  'map/provinces.bmp',
  'history/states/1-france.txt',
  'history/states/9-newland.txt',
])
const modRTree = mkTree(join(sandbox, 'modR'), [
  // 声明 replace_path="map" 但只提供 terrain → 原版 map/* 全被删
  'map/terrain/terrain.dds',
])

const R: SrcRoot[] = [
  { name: 'vanilla', path: join(sandbox, 'base'), writable: false, replacePaths: [] },
  { name: 'modA', path: join(sandbox, 'modA'), writable: true, replacePaths: [] },
  { name: 'modR', path: join(sandbox, 'modR'), writable: true, replacePaths: ['map'] },
]
/** 只含 vanilla + modA(不带 replace_path 声明者)—— 用于验基础覆盖语义 */
const R_PLAIN: SrcRoot[] = R.slice(0, 2)

t('文件级:同名由高优先级来源整份替换 → override', () => {
  const r = resolveAssets(R_PLAIN, ['map/provinces.bmp'])
  const ref = r.refs.get('map/provinces.bmp')!
  A.equal(ref.effective, 1)
  A.equal(ref.own, 'override')
  A.deepEqual(ref.chain, [0, 1])
  A.deepEqual(ref.shadowed, [0])
})

t('文件级:模组独有文件 → new;原版独有且无人替换 → vanilla', () => {
  const r = resolveAssets(R_PLAIN, ['history/states/9-newland.txt', 'map/definition.csv'])
  A.equal(r.refs.get('history/states/9-newland.txt')!.own, 'new')
  A.equal(r.refs.get('map/definition.csv')!.own, 'vanilla')
})

t('★ replace_path 声明了却没提供文件 → gap(游戏里真缺)', () => {
  // modR 声明 replace_path="map",但只提供了 map/terrain/terrain.dds
  const r = resolveAssets(R, ['map/definition.csv', 'map/supplyareas/1-sa.txt', 'map/provinces.bmp'])
  // modR 声明替换整个 map 却不提供 definition.csv → 缺口
  A.equal(r.refs.get('map/definition.csv')!.own, 'gap')
  A.equal(r.refs.get('map/definition.csv')!.effective, -1)
  A.equal(r.stats.gap >= 1, true)
  const sa = r.refs.get('map/supplyareas/1-sa.txt')!
  A.equal(sa.own, 'gap', 'map/supplyareas 下的原版文件也被 map 替换掉')
  const px = r.refs.get('map/provinces.bmp')!
  // 语义:replace_path="map" = **替换该文件夹的全部内容**,不只是替换原版的。
  // modR 排在 modA 之后且未提供 provinces.bmp → modA 那份也一并失效 → gap。
  // (这与用户给定的口径一致:有 replace_path 就是替换整个文件夹)
  A.equal(px.own, 'gap')
  A.equal(px.effective, -1)
  A.deepEqual(px.deletedBy, [2], '失效原因是 modR 的 replace_path 声明')
})

t('replace_path 之后加载的模组仍可提供文件(载入序优先)', () => {
  // modR 声明 replace_path="map",modAfter 排在它之后并提供了 definition.csv
  const pAfter = join(sandbox, 'modAfter')
  mkTree(pAfter, ['map/definition.csv'])
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(sandbox, 'base'), writable: false, replacePaths: [] },
    { name: 'modR', path: join(sandbox, 'modR'), writable: true, replacePaths: ['map'] },
    { name: 'modAfter', path: pAfter, writable: true, replacePaths: [] },
  ]
  const r = resolveAssets(roots, ['map/definition.csv'])
  const ref = r.refs.get('map/definition.csv')!
  A.equal(ref.own, 'override', '原版有 definition.csv,模组改写了它 → override(不是 new)')
  A.equal(ref.effective, 2, '生效的是载入序最后的提供者')
})

t('replace_path 声明者自己提供了文件 → 不是 gap,而是 override', () => {
  // modR2 声明 replace_path="map" 且真的提供了 definition.csv → 无缺口
  const p = join(sandbox, 'modR2')
  mkTree(p, ['map/definition.csv', 'map/provinces.bmp'])
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(sandbox, 'base'), writable: false, replacePaths: [] },
    { name: 'modR2', path: p, writable: true, replacePaths: ['map'] },
  ]
  const r = resolveAssets(roots, ['map/definition.csv'])
  const ref = r.refs.get('map/definition.csv')!
  A.equal(ref.own, 'override')
  A.equal(ref.effective, 1)
  // 但它没提供的 map/supplyareas 仍然是缺口
  const r2 = resolveAssets(roots, ['map/supplyareas/1-sa.txt'])
  A.equal(r2.refs.get('map/supplyareas/1-sa.txt')!.own, 'gap')
})

t('目录级:history/states 同名替换,replace_path 决定原版哪些被丢弃', () => {
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(sandbox, 'base'), writable: false, replacePaths: [] },
    { name: 'modA', path: join(sandbox, 'modA'), writable: true, replacePaths: ['history/states'] },
  ]
  const res = resolveDir(roots, 'history/states')
  // 原版 3 个(1-france/2-germany/3-poland),modA 2 个(1-france 同名 + 9-newland 新增)
  // 声明 replace_path 后:原版仅 1-france 被 modA 补回,2/3 无人生效 → dropped
  A.equal(res.stats.effective, 2, `只应剩 modA 的 2 个,实际 ${res.stats.effective}`)
  A.equal(res.stats.dropped, 2, `原版 2-germany/3-poland 被丢弃,1-france 已由模组补回,实际 ${res.stats.dropped}`)
  const names = res.effective.map((x) => x.name.toLowerCase()).sort()
  A.deepEqual(names, ['1-france.txt', '9-newland.txt'])
  const droppedNames = res.dropped.map((x) => x.name.toLowerCase()).sort()
  A.deepEqual(droppedNames, ['2-germany.txt', '3-poland.txt'])
})

t('目录级:无 replace_path 时原版 state 保留(仅同名被替换)', () => {
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(sandbox, 'base'), writable: false, replacePaths: [] },
    { name: 'modA', path: join(sandbox, 'modA'), writable: true, replacePaths: [] },
  ]
  const res = resolveDir(roots, 'history/states')
  A.equal(res.stats.effective, 4, `1-france 替换 + 2,3 原版保留 + 9 新增 = 4,实际 ${res.stats.effective}`)
  A.equal(res.stats.dropped, 0)
  const f = res.effective.find((x) => x.name.toLowerCase() === '1-france.txt')!
  A.equal(f.own, 'override')
  A.equal(f.effective, 1)
})

/* ══ 5. states 文件解析 ══ */

t('parseStateFile 取 id/name/owner/provinces', () => {
  const info = parseStateFileForTest('123-somewhere.txt', 'state = {\n  id = 123\n  owner = ENG\n  provinces = { 1 2 30 }\n}')
  A.equal(info.id, 123)
  A.equal(info.name, 'somewhere')
  A.equal(info.owner, 'ENG')
  A.deepEqual(info.provinces, [1, 2, 30])
})

t('parseStateFile 对无 provinces 块不抛错', () => {
  const info = parseStateFileForTest('7-x.txt', 'state = { id = 7 }')
  A.deepEqual(info.provinces, [])
  A.equal(info.owner, '')
})

t('parseStateFile 支持带引号 owner 与多行 provinces', () => {
  const info = parseStateFileForTest('9-y.txt', 'state = {\n owner = "GER"\n provinces = {\n  5\n  6\n }\n}')
  A.equal(info.owner, 'GER')
  A.deepEqual(info.provinces, [5, 6])
})

/* ══ 6. buildMapModel 多来源合成 ══ */

/** 造一张 2x2 的假 provinces.bmp 数据:颜色 0x010101 → id 1,0x020202 → id 2 */
function fakeBitmap() {
  const w = 2, h = 2
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < 4; i++) {
    const c = i < 2 ? 1 : 2
    rgba[i * 4] = c
    rgba[i * 4 + 1] = c
    rgba[i * 4 + 2] = c
    rgba[i * 4 + 3] = 255
  }
  return { w, h, rgba }
}
const CSV = '1;1;1;1;land\n2;2;2;2;land\n'

function statesTxt(id: number, owner: string, provs: number[]): string {
  return `state = {\n  id = ${id}\n  owner = ${owner}\n  provinces = { ${provs.join(' ')} }\n}\n`
}

const mapRoot = mkdtempSync(join(tmpdir(), 'mapmodel-'))
mkTree(join(mapRoot, 'base'), [
  'map/provinces.bmp',
  'map/definition.csv',
  'common/countries/ENG.txt',
  'common/countries/GER.txt',
  'history/states/1-france.txt',
])
writeFileSync(join(mapRoot, 'base', 'history/states/1-france.txt'), statesTxt(1, 'ENG', [1]))
writeFileSync(join(mapRoot, 'base', 'common/countries/ENG.txt'), 'country = { color = { 0.1 0.2 0.3 } }')
writeFileSync(join(mapRoot, 'base', 'common/countries/GER.txt'), 'country = { color = { 200 100 50 } }')

t('buildMapModel:单来源时省份质心与归属正确', () => {
  const roots: SrcRoot[] = [{ name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] }]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  A.equal(m.ready, true)
  A.equal(m.stats.provinces, 2)
  const p1 = m.provinces.find((p) => p.id === 1)!
  A.equal(p1.owner, 'ENG')
  // 假位图:像素 0,1 属省 1 → 占 (0,0) 与 (1,0) → 质心 x=(0+1)/2=0.5 → round=1
  A.equal(p1.x, 1)
  A.equal(p1.y, 0)
  A.equal(m.countries.length, 2)
  // 0.1/0.2/0.3 应归一化成 0..255
  const eng = m.countries.find((c) => c.tag === 'ENG')!
  A.deepEqual(eng.color, [26, 51, 77])
  const ger = m.countries.find((c) => c.tag === 'GER')!
  A.deepEqual(ger.color, [200, 100, 50])
})

t('buildMapModel:模组新增 state 带来新省份归属与 new 标记', () => {
  mkTree(join(mapRoot, 'modAdd'), ['history/states/2-newland.txt', 'common/countries/NEW.txt'])
  writeFileSync(join(mapRoot, 'modAdd', 'history/states/2-newland.txt'), statesTxt(2, 'NEW', [2]))
  writeFileSync(join(mapRoot, 'modAdd', 'common/countries/NEW.txt'), 'country = { color = { 10 20 30 } }')
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modAdd', path: join(mapRoot, 'modAdd'), writable: true, replacePaths: [] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  A.equal(m.stats.states, 2)
  const p2 = m.provinces.find((p) => p.id === 2)!
  A.equal(p2.owner, 'NEW')
  A.equal(p2.own, 'new')
  A.equal(m.sources[1].states, 1)
  A.equal(m.countries.length, 3)
})

t('buildMapModel:模组 state 同名替换 → override,原版失去归属', () => {
  mkTree(join(mapRoot, 'modRep'), ['history/states/1-france.txt', 'common/countries/ENG.txt'])
  writeFileSync(join(mapRoot, 'modRep', 'history/states/1-france.txt'), statesTxt(1, 'GER', [1]))
  writeFileSync(join(mapRoot, 'modRep', 'common/countries/ENG.txt'), 'country = { color = { 1 2 3 } }')
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modRep', path: join(mapRoot, 'modRep'), writable: true, replacePaths: [] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  const s = m.states.find((x) => x.id === 1)!
  A.equal(s.own, 'override')
  A.equal(s.owner, 'GER')
  A.equal(m.provinces.find((p) => p.id === 1)!.owner, 'GER')
})

t('★ buildMapModel:replace_path 清空 states → 报 states-missing 且无归属', () => {
  mkTree(join(mapRoot, 'modDrop'), ['map/provinces.bmp'])
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modDrop', path: join(mapRoot, 'modDrop'), writable: true, replacePaths: ['history/states'] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  A.equal(m.states.length, 0)
  A.equal(m.stats.statesDropped, 1, '原版 1 个 state 应记为被丢弃')
  A.ok(m.issues.some((i) => i.kind === 'states-missing'), '必须报 states-missing')
  A.ok(m.issues.some((i) => i.kind === 'state-dropped'))
  A.equal(m.provinces.every((p) => p.owner === ''), true, '没有 state 就没有归属')
})

t('buildMapModel:owner 无国家定义 → 报 owner-unknown', () => {
  mkTree(join(mapRoot, 'modU'), ['history/states/3-x.txt'])
  writeFileSync(join(mapRoot, 'modU', 'history/states/3-x.txt'), statesTxt(3, 'ZZZ', [1]))
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modU', path: join(mapRoot, 'modU'), writable: true, replacePaths: [] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  A.ok(m.issues.some((i) => i.kind === 'owner-unknown' && i.msg.includes('ZZZ')))
})

t('★ tag 必须来自 common/country_tags,不能拿文件名当 tag', () => {
  // 复刻真实结构:common/countries 存国家全名,tag 在 country_tags 里
  const r2 = mkdtempSync(join(tmpdir(), 'maptag-'))
  mkTree(join(r2, 'base'), [
    'common/countries/United Kingdom.txt',
    'common/countries/Soviet Union.txt',
    'common/countries/France.txt',
    'common/country_tags/00_countries.txt',
  ])
  writeFileSync(join(r2, 'base', 'common/country_tags/00_countries.txt'),
    ['ENG = "countries/United Kingdom.txt"', 'SOV = "countries/Soviet Union.txt"', 'FRA\t= "countries/France.txt"'].join('\n'))
  writeFileSync(join(r2, 'base', 'common/countries/United Kingdom.txt'), 'color = { 10 20 30 }')
  writeFileSync(join(r2, 'base', 'common/countries/Soviet Union.txt'), 'color = { 40 50 60 }')
  writeFileSync(join(r2, 'base', 'common/countries/France.txt'), 'color = { 57 113 228 }')
  const roots: SrcRoot[] = [{ name: 'vanilla', path: join(r2, 'base'), writable: false, replacePaths: [] }]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  const tags = m.countries.map((c) => c.tag).sort()
  A.deepEqual(tags, ['ENG', 'FRA', 'SOV'], `tag 应来自 country_tags,实际 ${JSON.stringify(tags)}`)
  const eng = m.countries.find((c) => c.tag === 'ENG')!
  A.deepEqual(eng.color, [10, 20, 30])
  // 文件名全名不应成为 tag
  A.equal(m.countries.some((c) => c.tag === 'UNITED KINGDOM'), false, '不能把文件名当 tag')
  rmSync(r2, { recursive: true, force: true })
})

t('★ 模组国家文件用文件内 tag= 也能识别(自建小国常见)', () => {
  const r3 = mkdtempSync(join(tmpdir(), 'mapinner-'))
  mkTree(join(r3, 'base'), ['common/countries/base.txt'])
  writeFileSync(join(r3, 'base', 'common/countries/base.txt'), 'color = { 1 2 3 }')
  mkTree(join(r3, 'mod'), ['common/countries/myland.txt'])
  writeFileSync(join(r3, 'mod', 'common/countries/myland.txt'), 'tag = MLD\ncolor = { 9 8 7 }')
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(r3, 'base'), writable: false, replacePaths: [] },
    { name: 'mod', path: join(r3, 'mod'), writable: true, replacePaths: [] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  const mld = m.countries.find((c) => c.tag === 'MLD')
  A.ok(mld, `应识别文件内 tag=MLD,实际 ${JSON.stringify(m.countries.map((c) => c.tag))}`)
  A.deepEqual(mld!.color, [9, 8, 7])
  rmSync(r3, { recursive: true, force: true })
})

t('country_tags 缺失时不得静默把文件名当 tag 而不报警', () => {
  const r4 = mkdtempSync(join(tmpdir(), 'mapnotag-'))
  mkTree(join(r4, 'base'), ['common/countries/Germany.txt'])
  writeFileSync(join(r4, 'base', 'common/countries/Germany.txt'), 'color = { 1 1 1 }')
  const roots: SrcRoot[] = [{ name: 'vanilla', path: join(r4, 'base'), writable: false, replacePaths: [] }]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  // 没有 country_tags 也没有文件内 tag → 必须给 warn(而不是静默错 tag)
  A.ok(
    m.issues.some((i) => i.msg.includes('Germany.txt') && i.msg.includes('tag')),
    `缺 tag 来源应报警,实际 issues=${JSON.stringify(m.issues.map((i) => i.msg))}`,
  )
  rmSync(r4, { recursive: true, force: true })
})

t('buildMapModel:资产缺口进 issues 且 sources.gaps 计数正确', () => {
  mkTree(join(mapRoot, 'modGap'), ['map/terrain/x.dds'])
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modGap', path: join(mapRoot, 'modGap'), writable: true, replacePaths: ['map'] },
  ]
  const m = buildMapModel({ roots, bitmap: fakeBitmap(), definitionCsv: CSV })
  A.ok(m.stats.assetGaps >= 1, `应有缺口,实际 ${m.stats.assetGaps}`)
  A.ok(m.issues.some((i) => i.kind === 'asset-gap'), '必须报 asset-gap')
  A.equal(m.sources[1].gaps >= 1, true)
})

t('auditReplacePaths:报出 replace_path 造成的原版文件缺口', () => {
  const roots: SrcRoot[] = [
    { name: 'vanilla', path: join(mapRoot, 'base'), writable: false, replacePaths: [] },
    { name: 'modR', path: modTree, writable: true, replacePaths: ['map'] },
  ]
  const r = auditReplacePaths(roots, [descOf(modTree, 'ModR', [], ['map'])])
  A.ok(r.gaps.length >= 1, `应报缺口,实际 ${JSON.stringify(r.gaps)}`)
  A.equal(r.gaps[0].replacePath, 'map')
  A.ok(r.gaps[0].missing.length > 0)
})

t('MAP_ASSETS 覆盖地图关键文件', () => {
  A.ok(MAP_ASSETS.includes('map/provinces.bmp' as never))
  A.ok(MAP_ASSETS.includes('map/definition.csv' as never))
  A.ok(MAP_ASSETS.includes('map/adjacencies.csv' as never))
})

/* ══ 收尾 ══ */
try {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(mapRoot, { recursive: true, force: true })
} catch {
  /* 清理失败不影响判定 */
}

console.log(`modmeta-mapmodel: ${pass} 通过, ${fails.length} 失败(共 ${pass + fails.length})`)
for (const f of fails) console.log(`  ✗ ${f}`)
if (fails.length) process.exitCode = 1