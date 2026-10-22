/**
 * 层06 —— 模组替换规则专项 (06_mod_replace)
 *
 * 【A. 复用】_verify_replace_path_all.mts 的全部 11 模块 REPLACE_PATH 断言原样移植:
 *         国策/科技/事件/决议/人物/单位/AI/学说/MIO/音乐/本地化。
 *         口径:启用带 replace_path 的模组(KR)后,被覆盖目录下的基础游戏文件
 *               不再加载(root=0 消失);不带 replacePaths 时行为一致(回归)。
 * 【B. 新增核心断言】除 replace_path 外,「同相对路径 + 同名文件」也替换:
 *         防止装备/单位/MIO 政策等因同名文件重复加载而重复生效。
 *         去重算法:按规范化 rel 分组 → chain=所有提供该 rel 的来源 →
 *         effective=未被更高优先级 replace_path 声明者删除的最高优先级来源;
 *         其余 chain 成员记为 shadowed。最终 effective 清单里每个 rel 只出现一次。
 *
 * 契约:每断言打印 [PASS]/[FAIL]/[EXEMPT];结果 JSON 写入 --out;
 *       退出码 0=全过,1=有失败。本层进程内跑,不依赖 dev server。
 * 临时目录用完即删,不污染项目。
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

/* ═══ 自举:本入口是 .mjs,runner 不会自动加 --experimental-strip-types;
 *      但下面要动态 import 引擎侧 .ts 源码,必须在带 strip-types 的进程里跑。
 *      没带就自己重执行一次(幂等)。 ═══ */
if (!process.execArgv.includes('--experimental-strip-types')) {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', import.meta.filename, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(r.status ?? 1)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..') // tools/qa_runner/layers → 项目根
const E = (...segs) => pathToFileURL(join(ROOT, ...segs)).href

/* ── 命令行参数 ── */
const argv = process.argv.slice(2)
const pick = (key, def) => {
  const hit = argv.find((a) => a.startsWith(key + '='))
  return hit ? hit.split('=').slice(1).join('=') : def
}
const BASE = pick('--base', 'http://127.0.0.1:5175') // 本层不依赖,仅记录
const OUT = pick('--out', join(ROOT, 'tools', 'qa_runner', 'results', '06_mod_replace.json'))

/* ── 用例收集 ── */
const cases = []
function rec(name, pass, detail, opts = {}) {
  const c = { name, pass: !!pass, detail: detail ?? '', exempt: !!opts.exempt, exemptReason: opts.exemptReason ?? null }
  cases.push(c)
  const tag = c.exempt ? '[EXEMPT]' : pass ? '[PASS]' : '[FAIL]'
  console.log('  ' + tag + ' ' + name + (detail !== undefined && detail !== '' ? '  → ' + String(detail) : ''))
}
function check(name, cond, detail) { rec(name, !!cond, detail) }
function exempt(name, reason, detail) { rec(name, true, detail, { exempt: true, exemptReason: reason }) }
function countRoot0(vals) {
  let n = 0
  for (const v of vals) if (v && typeof v === 'object' && 'root' in v && v.root === 0) n++
  return n
}

/* ── 临时目录(本层自建,用完即删) ── */
const TD = join(tmpdir(), 'hoi4tk_qa06_' + process.pid)
const SYNTH = join(TD, 'rp_synth') // 学说/音乐/本地化 replace_path 合成模组
const REPRO = join(TD, 'repro')    // 同路径同名去重最小复现
mkdirSync(SYNTH, { recursive: true })
mkdirSync(REPRO, { recursive: true })

let exitCode = 0
try {
  /* ═══ 动态 import 引擎源码(进程内,与 _verify_replace_path_all 同模式) ═══ */
  const { parseModDescriptor } = await import(E('packages', 'engine', 'src', 'modmeta.ts'))
  const { collectDirRecursive, isUnloadedByLaterReplacePath } = await import(E('packages', 'engine', 'src', 'assetsrc.ts'))
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

  /* ── 合成模组 descriptor ── */
  writeFileSync(
    join(SYNTH, 'descriptor.mod'),
    'name="rp_synth"\nreplace_path="common/doctrines"\nreplace_path="music"\nreplace_path="localisation"\n',
  )

  const GAME = JSON.parse(readFileSync(join(ROOT, 'gui-settings.json'), 'utf8')).base
  const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
  const base = { name: 'vanilla', path: GAME, writable: false }
  const krRp = { name: 'kaiserreich', path: KR, writable: true, replacePaths: parseModDescriptor(KR).replacePaths }
  const krNoRp = { name: 'kaiserreich', path: KR, writable: true }
  const synthRp = { name: 'rp_synth', path: SYNTH, writable: true, replacePaths: parseModDescriptor(SYNTH).replacePaths }
  const isBase = (r) => r === 0

  console.log('═══ A. 11 模块 REPLACE_PATH 语义(root=0 消失 / 回归一致) ═══')

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
    check('focus: KR 覆盖 common/national_focus → 无 root=0 节点/树', countRoot0(g.nodes.values()) === 0 && countRoot0(g.trees) === 0, 'nodes.root0=' + countRoot0(g.nodes.values()) + ' trees.root0=' + countRoot0(g.trees))
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
  /* ⑦ AI aibehave */
  {
    const m = buildAiBehavior([base, krRp])
    const mNo = buildAiBehavior([base, krNoRp])
    const covered = ['common/ai_areas/', 'common/ai_equipment/', 'common/ai_focuses/', 'common/ai_navy/', 'common/ai_strategy', 'common/ai_templates/', 'common/peace_conference/ai_peace/']
    const coveredR0 = [...m.defs.values()].flat().filter((d) => covered.some((c) => d.file.startsWith(c)) && d.root === 0).length
    const keep = ['common/ai_faction_theaters/', 'common/ai_attitudes.txt', 'common/ai_personalities.txt']
    const keepR0 = [...m.defs.values()].flat().filter((d) => keep.some((c) => d.file.startsWith(c)) && d.root === 0).length
    check('ai: 被 KR 覆盖的 ai_* 目录 root=0 条目为 0', coveredR0 === 0, 'coveredR0=' + coveredR0 + ' entries=' + m.entries)
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
    check('doctrines: 回归(base 单源)root=0 存在', countRoot0(totalNo) > 0, 'root0=' + countRoot0(totalNo))
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
  /* ⑩ 音乐 music —— 合成模组 replace_path=music;dlc 子目录不受影响 */
  {
    const mi = buildMusicIndex([base, synthRp])
    const miNo = buildMusicIndex([base])
    const rootMusicVanilla = mi.songs.filter((s) => s.source === 'vanilla' && !s.rel.startsWith('dlc/')).length
    check('music: 根 music/ 下 vanilla 歌曲为 0(replace_path=music 卸载)', rootMusicVanilla === 0, 'rootMusicVanilla=' + rootMusicVanilla + ' songs=' + mi.songs.length)
    check('music: 回归(base 单源)vanilla 歌曲存在', miNo.songs.filter((s) => s.source === 'vanilla').length > 0, 'vanilla=' + miNo.songs.filter((s) => s.source === 'vanilla').length)
  }
  /* ⑪ 本地化 loc —— 合成模组 replace_path=localisation */
  {
    const jobs = planLocBatches([base, synthRp])
    const jobsNo = planLocBatches([base])
    check('loc: replace_path=localisation → 无 root=0 批次', jobs.every((j) => j.rootIdx !== 0), 'jobs=' + jobs.length)
    check('loc: 回归(base 单源)全 root=0', jobsNo.length > 0 && jobsNo.every((j) => j.rootIdx === 0), 'jobs=' + jobsNo.length)
  }

  /* ════════════════════════════════════════════════════════════════
   * B. 同相对路径 + 同名文件去重(防重复生效)
   * 去重算法(assetsrc/collectDirRecursive 口径):
   *   1) union 各来源相对路径(小写归一),按 rel 分桶;
   *   2) chain = 物理提供该 rel 的所有来源(按载入序);
   *   3) effective = 未被更高优先级 replace_path 声明者删除的 chain 最大下标;
   *      其余 chain 成员记 shadowed(被覆盖的影子),不进最终清单;
   *   4) 最终 effective 清单每个归一 rel 恰好出现一次 → 无重复生效。
   * ════════════════════════════════════════════════════════════════ */
  console.log('\n═══ B. 同路径同名去重(后加载覆盖前者,不重复生效) ═══')

  /* 构造最小复现:vanilla / modA / modB 三方都放 common/equipment/weapons.txt(同名同 rel) */
  const eqDir = 'common/equipment'
  for (const d of [join(REPRO, 'vanilla', eqDir), join(REPRO, 'modA', eqDir), join(REPRO, 'modB', eqDir)]) mkdirSync(d, { recursive: true })
  writeFileSync(join(REPRO, 'vanilla', eqDir, 'weapons.txt'), 'vanilla weapons\n')
  writeFileSync(join(REPRO, 'modA', eqDir, 'weapons.txt'), 'modA weapons\n')
  writeFileSync(join(REPRO, 'modA', eqDir, 'moda_only.txt'), 'modA only\n')
  writeFileSync(join(REPRO, 'modB', eqDir, 'weapons.txt'), 'modB weapons\n')
  // modC 声明 replace_path=common/equipment,自己也提供 weapons.txt
  const modC = join(REPRO, 'modC')
  mkdirSync(join(modC, eqDir), { recursive: true })
  writeFileSync(join(modC, 'descriptor.mod'), 'name="modC"\nreplace_path="common/equipment"\n')
  writeFileSync(join(modC, eqDir, 'weapons.txt'), 'modC weapons\n')

  const rVanilla = { name: 'vanilla', path: join(REPRO, 'vanilla'), writable: false }
  const rModA = { name: 'modA', path: join(REPRO, 'modA'), writable: true }
  const rModB = { name: 'modB', path: join(REPRO, 'modB'), writable: true }
  const rModC = { name: 'modC', path: modC, writable: true, replacePaths: parseModDescriptor(modC).replacePaths }

  /* B1:三方同名、无 replace_path → 后加载(modB)覆盖,且 effective 仅 1 条 */
  {
    const res = collectDirRecursive([rVanilla, rModA, rModB], eqDir, { exts: ['.txt'] })
    const rel = 'common/equipment/weapons.txt'
    const ref = res.byRel.get(rel)
    check('B1[repro] 同名文件 effective 清单仅 1 条(无重复加载)', res.effective.filter((x) => x.path === rel).length === 1, 'effective命中=' + res.effective.filter((x) => x.path === rel).length)
    check('B1[repro] 后加载 modB(下标2)为生效来源', ref && ref.effective === 2, 'effective=' + (ref && ref.effective) + ' chain=' + JSON.stringify(ref && ref.chain))
    check('B1[repro] 三方都提供但仅 modB 生效,vanilla/modA 入 shadowed', ref && ref.chain.length === 3 && ref.shadowed.length === 2, 'chain=' + JSON.stringify(ref && ref.chain) + ' shadowed=' + JSON.stringify(ref && ref.shadowed))
    check('B1[repro] moda_only.txt(仅 modA)不被同名影响,正常生效', res.byRel.get('common/equipment/moda_only.txt')?.effective === 1, 'effective=' + res.byRel.get('common/equipment/moda_only.txt')?.effective)
  }

  /* B2:modC replace_path=common/equipment → weapons.txt 由 modC 生效;moda_only 被卸载 */
  {
    const res = collectDirRecursive([rVanilla, rModA, rModC], eqDir, { exts: ['.txt'] })
    const w = res.byRel.get('common/equipment/weapons.txt')
    check('B2[repro] replace_path 声明者 modC 自己提供 weapons.txt → 生效且非 gap', w && w.effective === 2 && w.gap === false, 'effective=' + (w && w.effective) + ' gap=' + (w && w.gap))
    const droppedModa = res.dropped.some((x) => x.path === 'common/equipment/moda_only.txt')
    check('B2[repro] moda_only.txt 被 modC 的 replace_path 卸载(dropped,游戏里不存在)', droppedModa, 'dropped=' + res.dropped.map((x) => x.path).join(','))
    check('B2[repro] isUnloadedByLaterReplacePath(root1 moda_only)=true', isUnloadedByLaterReplacePath([rVanilla, rModA, rModC], 1, 'common/equipment/moda_only.txt') === true)
  }

  /* B3:实机(gui-settings 模组组合)在 装备/单位/MIO政策 三类目录上,断言 effective 集无重复 rel */
  {
    const dirs = [
      ['equipment', 'common/units/equipment'],
      ['units', 'common/units'],
      ['mio_policy', 'common/military_industrial_organization/policies'],
    ]
    for (const [label, dir] of dirs) {
      const res = collectDirRecursive([base, krRp], dir, { exts: ['.txt'] })
      // 不变式 1:effective 里归一 rel 唯一
      const uniq = new Set(res.effective.map((x) => x.path.toLowerCase()))
      check(`B3[real] ${label}(${dir}) effective 清单 rel 唯一(无重复生效)`, uniq.size === res.effective.length, 'effective=' + res.effective.length + ' uniq=' + uniq.size)
      // 不变式 2:凡同名多源(chain>1)的 rel,effective 必为 chain 最大且仅一条
      let multi = 0, bad = 0
      for (const ref of res.byRel.values()) {
        if (ref.chain.length > 1 && !ref.gap) {
          multi++
          if (ref.effective !== Math.max(...ref.chain)) bad++
        }
      }
      check(`B3[real] ${label} 同名多源 rel 均收敛到最高优先级来源`, bad === 0, 'multiSourceRels=' + multi + ' bad=' + bad)
      // 顺带统计缺口,仅作信息(KR 制造 gap 是预期,不报失败)
      console.log('        · ' + label + ': total=' + res.stats.total + ' override=' + res.stats.override + ' new=' + res.stats.new + ' gap=' + res.stats.gap)
    }
  }
} catch (e) {
  rec('层06 运行异常', false, String(e && e.stack || e))
} finally {
  rmSync(TD, { recursive: true, force: true })
}

/* ── 汇总写 JSON ── */
const summary = {
  total: cases.length,
  pass: cases.filter((c) => c.pass && !c.exempt).length,
  fail: cases.filter((c) => !c.pass && !c.exempt).length,
  exempt: cases.filter((c) => c.exempt).length,
}
mkdirSync(dirname(OUT), { recursive: true })
const doc = { layer: '06_mod_replace', base: BASE, ts: new Date().toISOString(), summary, cases }
writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8')

console.log('\n═══ 层06 汇总: total=' + summary.total + ' pass=' + summary.pass + ' fail=' + summary.fail + ' exempt=' + summary.exempt + ' ═══')
console.log('结果 JSON: ' + OUT)
process.exit(summary.fail === 0 ? 0 : 1)
