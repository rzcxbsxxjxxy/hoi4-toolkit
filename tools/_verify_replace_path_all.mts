/**
 * _verify_replace_path_all.mts —— REPLACE_PATH_ALL_V1 全模块综合验证
 * 覆盖:国策/科技/事件/决议/人物/单位/AI/学说/MIO/音乐/本地化 11 个功能模块。
 * 断言口径:启用带 replace_path 的模组(KR/synth)后,被覆盖目录下的基础游戏文件
 *         不再被加载(root=0 消失);不带 replacePaths 时行为与改动前一致(回归)。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const E = (...segs) => pathToFileURL(join(ROOT, ...segs)).href
const SY = (p) => pathToFileURL(join(p, ...[])).href

const { parseModDescriptor } = await import(E('packages', 'engine', 'src', 'modmeta.ts'))
const { isUnloadedByLaterReplacePath } = await import(E('packages', 'engine', 'src', 'assetsrc.ts'))
const { buildTechGraph } = await import(E('packages', 'engine', 'src', 'tech.ts'))
const { buildEventIndex } = await import(E('packages', 'engine', 'src', 'events.ts'))
const { buildDecisionGraph } = await import(E('packages', 'engine', 'src', 'decisions.ts'))
const { buildCharactersModel } = await import(E('packages', 'engine', 'src', 'characters.ts'))
const { buildUnitsModel } = await import(E('packages', 'engine', 'src', 'units.ts'))
const { buildAiBehavior } = await import(E('packages', 'engine', 'src', 'aibehave.ts'))
const { buildDoctrineGraph, layoutDoctrines } = await import(E('packages', 'engine', 'src', 'doctrines.ts'))
const { buildMioTrees } = await import(E('packages', 'engine', 'src', 'mio.ts'))
const { buildMusicIndex } = await import(E('packages', 'engine', 'src', 'music.ts'))
const { planLocBatches } = await import(E('packages', 'gui', 'src', 'locsrv.ts'))
const { buildFocusGraph } = await import(E('packages', 'focus', 'src', 'model.ts'))

let fails = 0
function check(name, cond, detail) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (detail !== undefined ? '  → ' + String(detail) : ''))
  if (!cond) fails++
}
function countRoot0(vals) {
  let n = 0
  for (const v of vals) {
    if (v && typeof v === 'object' && 'root' in v && v.root === 0) n++
  }
  return n
}

const GAME = JSON.parse(readFileSync(join(ROOT, 'gui-settings.json'), 'utf8')).base
const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
const SYNTH = join(tmpdir(), 'hoi4tk_rp_synth')
const base = { name: 'vanilla', path: GAME, writable: false }
const krRp = { name: 'kaiserreich', path: KR, writable: true, replacePaths: parseModDescriptor(KR).replacePaths }
const krNoRp = { name: 'kaiserreich', path: KR, writable: true }
const synthRp = { name: 'rp_synth', path: SYNTH, writable: true, replacePaths: parseModDescriptor(SYNTH).replacePaths }
const isBase = (r) => r === 0

/* ① 科技 tech */
{
  const g = buildTechGraph([base, krRp])
  const gNo = buildTechGraph([base, krNoRp])
  check('tech: KR 覆盖 common/technologies → root=0 节点为 0', countRoot0(g.nodes.values()) === 0, 'root0=' + countRoot0(g.nodes.values()) + ' total=' + g.nodes.size)
  check('tech: 回归(无 replacePaths)root=0 存在', countRoot0(gNo.nodes.values()) > 0, 'root0=' + countRoot0(gNo.nodes.values()))
}
/* ② 国策 focus */
{
  const g = buildFocusGraph([base, krRp])
  const gNo = buildFocusGraph([base, krNoRp])
  check('focus: KR 覆盖 common/national_focus → 无 root=0 节点/树', countRoot0(g.nodes.values()) === 0 && countRoot0(g.trees) === 0, 'nodes.root0=' + countRoot0(g.nodes.values()) + ' trees.root0=' + countRoot0(g.trees) + ' nodes=' + g.nodes.size)
  check('focus: 回归(无 replacePaths)root=0 存在', countRoot0(gNo.nodes.values()) > 0, 'root0=' + countRoot0(gNo.nodes.values()))
}
/* ③ 事件 events */
{
  const g = buildEventIndex([base, krRp])
  const gNo = buildEventIndex([base, krNoRp])
  check('events: KR 覆盖 events → 无 root=0 事件', countRoot0(g.events.values()) === 0, 'root0=' + countRoot0(g.events.values()) + ' total=' + g.events.size)
  check('events: 回归(无 replacePaths)root=0 存在', countRoot0(gNo.events.values()) > 0, 'root0=' + countRoot0(gNo.events.values()))
}
/* ④ 决议 decisions */
{
  const g = buildDecisionGraph([base, krRp])
  const gNo = buildDecisionGraph([base, krNoRp])
  check('decisions: KR 覆盖 common/decisions(+categories) → 无 root=0', countRoot0(g.nodes.values()) === 0, 'root0=' + countRoot0(g.nodes.values()) + ' total=' + g.nodes.size)
  check('decisions: 回归(无 replacePaths)root=0 存在', countRoot0(gNo.nodes.values()) > 0, 'root0=' + countRoot0(gNo.nodes.values()))
}
/* ⑤ 人物 characters */
{
  const m = buildCharactersModel([base, krRp], isBase)
  const mNo = buildCharactersModel([base, krNoRp], isBase)
  check('characters: KR 覆盖 common/characters → 无 root=0 文件', countRoot0(m.files) === 0, 'root0=' + countRoot0(m.files) + ' files=' + m.files.length)
  check('characters: 回归(无 replacePaths)root=0 存在', countRoot0(mNo.files) > 0, 'root0=' + countRoot0(mNo.files))
}
/* ⑥ 单位 units —— KR 只覆盖 common/units 的 5 个子目录 */
{
  const m = buildUnitsModel([base, krRp], isBase)
  const mNo = buildUnitsModel([base, krNoRp], isBase)
  const covered = ['codenames_operatives', 'names', 'names_divisions', 'names_railway_guns', 'names_ships']
  const coveredR0 = m.files.filter((f) => covered.some((c) => f.rel.startsWith('common/units/' + c)) && f.root === 0).length
  const otherR0 = m.files.filter((f) => !covered.some((c) => f.rel.startsWith('common/units/' + c)) && f.root === 0).length
  check('units: 被 replace_path 覆盖的 5 个子目录 root=0 文件为 0', coveredR0 === 0, 'coveredR0=' + coveredR0 + ' files=' + m.files.length)
  check('units: 未覆盖子目录的 base 文件保留 root=0', otherR0 > 0, 'otherR0=' + otherR0)
  check('units: 回归(无 replacePaths)被覆盖子目录 root=0 存在', mNo.files.filter((f) => covered.some((c) => f.rel.startsWith('common/units/' + c)) && f.root === 0).length > 0)
}
/* ⑦ AI aibehave —— KR 覆盖大部分 ai_* 目录,不覆盖 ai_faction_theaters / ai_attitudes.txt / ai_personalities.txt */
{
  const m = buildAiBehavior([base, krRp])
  const mNo = buildAiBehavior([base, krNoRp])
  const covered = ['common/ai_areas/', 'common/ai_equipment/', 'common/ai_focuses/', 'common/ai_navy/', 'common/ai_strategy', 'common/ai_templates/', 'common/peace_conference/ai_peace/']
  const coveredR0 = [...m.defs.values()].flat().filter((d) => covered.some((c) => d.file.startsWith(c)) && d.root === 0).length
  const keep = ['common/ai_faction_theaters/', 'common/ai_attitudes.txt', 'common/ai_personalities.txt']
  const keepR0 = [...m.defs.values()].flat().filter((d) => keep.some((c) => d.file.startsWith(c)) && d.root === 0).length
  check('ai: 被 KR 覆盖的 ai_* 目录 root=0 条目为 0', coveredR0 === 0, 'coveredR0=' + coveredR0 + ' files=' + m.files + ' entries=' + m.entries)
  check('ai: 未覆盖方面(ai_faction_theaters/attitudes/personalities)保留 root=0', keepR0 > 0, 'keepR0=' + keepR0)
  check('ai: 回归(无 replacePaths)files 数量更大', mNo.files > m.files, 'base+KR files=' + m.files + ' 回归=' + mNo.files)
}
/* ⑧ 学说 doctrines —— KR 未覆盖,用合成模组 */
{
  const g = buildDoctrineGraph([base, synthRp])
  const gNo = buildDoctrineGraph([base])
  const total = [...g.folders.values(), ...g.grand.values(), ...g.tracks.values(), ...g.subdoctrines.values()]
  const totalNo = [...gNo.folders.values(), ...gNo.grand.values(), ...gNo.tracks.values(), ...gNo.subdoctrines.values()]
  check('doctrines: 合成模组 replace_path=common/doctrines → 无 root=0 条目', countRoot0(total) === 0, 'root0=' + countRoot0(total) + ' total=' + total.length)
  check('doctrines: 回归(base 单源)root=0 存在', countRoot0(totalNo) > 0, 'root0=' + countRoot0(totalNo) + ' total=' + totalNo.length)
  check('doctrines: layout 不抛错', (() => { try { layoutDoctrines(g); return true } catch { return false } })())
}
/* ⑨ MIO 军工机构 —— KR 覆盖 organizations 目录 */
{
  const m = buildMioTrees([base, krRp])
  const mNo = buildMioTrees([base])
  const orgsR0 = [...m.orgs.values()].filter((o) => o.root === 0).length
  const orgsNoR0 = [...mNo.orgs.values()].filter((o) => o.root === 0).length
  check('mio: KR 覆盖 organizations → org root=0 为 0', orgsR0 === 0, 'orgs=' + m.orgs.size + ' root0=' + orgsR0)
  check('mio: 回归(base 单源)org root=0 存在', orgsNoR0 > 0, 'orgs=' + mNo.orgs.size + ' root0=' + orgsNoR0)
}
/* ⑩ 音乐 music —— 合成模组 replace_path=music;dlc 子目录下的 music 前缀不受影响(游戏规则) */
{
  const mi = buildMusicIndex([base, synthRp])
  const miNo = buildMusicIndex([base])
  const rootMusicVanilla = mi.songs.filter((s) => s.source === 'vanilla' && !s.rel.startsWith('dlc/')).length
  check('music: 根 music/ 下 vanilla 歌曲为 0(replace_path=music 卸载)', rootMusicVanilla === 0, 'rootMusicVanilla=' + rootMusicVanilla + ' songs=' + mi.songs.length + ' (dlc/*/music 保留=' + mi.songs.filter((s) => s.source === 'vanilla' && s.rel.startsWith('dlc/')).length + ')')
  check('music: 回归(base 单源)vanilla 歌曲存在', miNo.songs.filter((s) => s.source === 'vanilla').length > 0, 'vanilla=' + miNo.songs.filter((s) => s.source === 'vanilla').length)
}
/* ⑪ 本地化 loc —— 合成模组 replace_path=localisation */
{
  const jobs = planLocBatches([base, synthRp])
  const jobsNo = planLocBatches([base])
  check('loc: replace_path=localisation → 无 root=0 批次', jobs.every((j) => j.rootIdx !== 0), 'jobs=' + jobs.length + ' rootIdx分布=' + JSON.stringify(jobs.reduce((a, j) => ((a[j.rootIdx] = (a[j.rootIdx] ?? 0) + 1), a), {})))
  check('loc: 回归(base 单源)全 root=0', jobsNo.length > 0 && jobsNo.every((j) => j.rootIdx === 0), 'jobs=' + jobsNo.length)
}

console.log(fails === 0 ? '═══ 全模块综合验证通过 ═══' : '═══ 全模块综合验证失败 ' + fails + ' 项 ═══')
process.exit(fails === 0 ? 0 : 1)
