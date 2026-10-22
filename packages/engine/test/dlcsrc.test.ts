/**
 * DLC 来源层与门控的语义单测。
 *
 * 夹具模拟两种实测到的安装形态:
 *   A. 带数据的老式 DLC(dlc/dlcXXX/history/states/*.txt)—— 覆盖本体同名 state
 *   B. 纯资源 DLC(本机 30 个的真实形态,只有 gfx/interface/…)
 * 以及 ★ 目录名 ≠ 正式名 这个真陷阱。
 */
import { scanDlcDirs, summarizeDlc, matchDlc, collectDlcGates, type DlcDescriptor } from '../src/dlcsrc.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
const fails: string[] = []
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
  } catch (e) {
    fails.push(name + ' :: ' + (e as Error).message)
  }
}
function eq(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n  期望 ${JSON.stringify(b)}\n  实际 ${JSON.stringify(a)}`)
}
function ok(v: unknown, msg = '') {
  if (!v) throw new Error(msg || '期望为真')
}

const sandbox = mkdtempSync(join(tmpdir(), 'hoi4-dlc-'))

/** 造一个 DLC 目录:desc 为 .dlc 原文,files 为要建的相对路径 */
function mkDlc(container: string, dirName: string, desc: string | null, files: readonly string[]) {
  const abs = join(sandbox, container, dirName)
  mkdirSync(abs, { recursive: true })
  for (const f of files) {
    const p = join(abs, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, 'x')
  }
  if (desc !== null) {
    const id = (dirName.match(/^dlc\d+/) || ['dlc'])[0]
    writeFileSync(join(abs, id + '.dlc'), desc)
  }
}

/* 形态 A:带数据的老式 DLC(目录名≠正式名,这是真陷阱) */
mkDlc('dlc', 'dlc049_no_compromise_no_surrender',
  'name = "No Compromise, No Surrender"\npath = dlc/dlc049_no_compromise_no_surrender/\nsteam_id = "3796260"\naffects_checksum = yes\n',
  ['history/states/1021 - Actual Singapore.txt', 'history/states/999-Sea.txt', 'map/provinces.bmp', 'map/definition.csv', 'gfx/x.dds'])
/* 形态 B:纯资源 DLC —— 本机 30 个的真实形态 */
mkDlc('dlc', 'dlc003_rocket_launcher_unit_pack',
  'name = "Rocket Launcher Unit Pack"\npath = dlc/dlc003_rocket_launcher_unit_pack/\n',
  ['gfx/a.dds', 'interface/b.gfx', 'music/c.asset', 'thumbnail.png'])
/* integrated_dlc 容器 —— 实测本机还有 4 个 DLC 在这里,漏扫会少一半 */
mkDlc('integrated_dlc', 'dlc018_together_for_victory',
  'name = "Together for Victory"\npath = dlc/dlc018_together_for_victory/\n',
  ['history/states/111-Tfstates.txt'])
/* 无描述符但有数据 → 必须报出来(否则没法按正式名门控) */
mkDlc('dlc', 'dlc999_nodoc', null, ['history/states/1-x.txt'])

try {
  const list = scanDlcDirs(sandbox)

  t('扫到全部 4 个 DLC(含 integrated_dlc 容器)', () => {
    eq(list.length, 4, '目录: ' + list.map((d) => d.dir).join(','))
  })

  t('★ 目录名 ≠ 正式名:正式名从 .dlc 的 name 取', () => {
    const d = list.find((x) => x.dir === 'dlc049_no_compromise_no_surrender')!
    eq(d.name, 'No Compromise, No Surrender')
  })

  t('★ 带数据的 DLC 被标 hasData 并计出 states/map 数量', () => {
    const d = list.find((x) => x.dir === 'dlc049_no_compromise_no_surrender')!
    ok(d.hasData)
    eq(d.statesCount, 2)
    ok(d.mapAssetsCount >= 2, 'map 资产应 ≥2,实际 ' + d.mapAssetsCount)
  })

  t('纯资源 DLC → hasData=false(不能挂成空来源)', () => {
    const d = list.find((x) => x.dir === 'dlc003_rocket_launcher_unit_pack')!
    eq(d.hasData, false)
    eq(d.statesCount, 0)
  })

  t('★ integrated_dlc 容器也被扫到(TFV 在这里,不在 dlc/)', () => {
    const d = list.find((x) => x.dir === 'dlc018_together_for_victory')!
    ok(d, 'TFV 未被扫到')
    ok(d.hasData)
    eq(d.statesCount, 1)
  })

  t('★ 无描述符但有数据 → 计入 dataNoDesc', () => {
    const s = summarizeDlc(list)
    eq(s.total, 4)
    eq(s.withData, 3, 'dlc049 + dlc018 + dlc999')
    eq(s.withStates, 3)
    ok(s.dataNoDesc.includes('dlc999_nodoc'), 'dataNoDesc=' + JSON.stringify(s.dataNoDesc))
  })

  t('★ matchDlc 用正式名匹配(拿目录名比对会 100% 失配)', () => {
    const hit = matchDlc('No Compromise, No Surrender', list)
    ok(hit, '正式名应能匹配上')
    eq(hit!.dir, 'dlc049_no_compromise_no_surrender')
  })

  t('matchDlc 容忍标点/空格差异', () => {
    ok(matchDlc('No Compromise  No Surrender', list), '双空格应仍能匹配')
    ok(matchDlc('no-compromise,-no-surrender', list), '连字符/逗号差异应仍能匹配')
  })

  t('matchDlc 未命中返回 null(而不是回退到目录名瞎猜)', () => {
    eq(matchDlc('Some Other Game', list), null)
  })

  t('★ collectDlcGates:门控挂到具体建筑上并按 DLC 归并', () => {
    const states = [
      {
        id: 1021, name: 'Actual Singapore',
        buildings: [
          { id: 'naval_base', level: 8 },
          { id: 'naval_headquarters', level: 1, dlc: 'No Compromise, No Surrender' },
        ],
        victoryPoints: [[12299, 10]] as [number, number][],
        dlcGated: ['No Compromise, No Surrender'],
      },
    ]
    const r = collectDlcGates(states, list, new Set())
    eq(r.refs.length, 1, '只应报出门控的那一个,未门控的 naval_base 不报')
    eq(r.refs[0].what, 'naval_headquarters')
    eq(r.refs[0].kind, 'building')
    // ★ 关键:未门控的建筑不能被算进门控清单(否则 8 级海军基地会显示成需要 DLC)
    eq(r.byDlc['No Compromise, No Surrender'].count, 1)
    eq(r.byDlc['No Compromise, No Surrender'].dir, 'dlc049_no_compromise_no_surrender')
    eq(r.byDlc['No Compromise, No Surrender'].active, false, '未勾选时应为 inactive')
  })

  t('勾选启用后 active=true', () => {
    const states = [{ id: 1, name: 'x', buildings: [{ id: 'hq', level: 1, dlc: 'No Compromise, No Surrender' }], dlcGated: ['No Compromise, No Surrender'] }]
    const r = collectDlcGates(states, list, new Set(['dlc049_no_compromise_no_surrender']))
    eq(r.byDlc['No Compromise, No Surrender'].active, true)
  })

  t('门控存在但定位不到对象 → kind=other,不静默丢弃', () => {
    const r = collectDlcGates([{ id: 7, name: 'y', buildings: [], dlcGated: ['Some Dlc'] }], list)
    eq(r.refs.length, 1)
    eq(r.refs[0].kind, 'other')
  })

  t('无门控的 state 不产生任何条目', () => {
    const r = collectDlcGates([{ id: 3, name: 'z', buildings: [{ id: 'a', level: 1 }], dlcGated: [] }], list)
    eq(r.refs.length, 0)
    eq(Object.keys(r.byDlc).length, 0)
  })

  t('不存在 dlc/ 目录时返回空数组而不是抛错', () => {
    eq(scanDlcDirs(join(sandbox, 'nonexistent')), [])
  })
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\nDLC 来源层: ${pass}/${pass + fails.length} 通过`)
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
