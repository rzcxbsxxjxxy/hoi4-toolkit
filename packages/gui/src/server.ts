/**
 * GUI 工作台服务端(零依赖,node:http)。
 *
 * 设计要点:
 *  - 只读 root(游戏本体)与可写 root(模组)分开,避免误改 vanilla;
 *  - 贴图按需解码 + PNG 压缩 + 内存缓存,不一次性传全量;
 *  - 保存前强制备份,并先返回 diff 供审查;
 *  - 所有写操作都经过 edit.ts 的行级守卫。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync, rmSync, createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, relative, dirname, extname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SpriteIndex, walkFiles, type SpriteDef } from './sprites.ts'
import { buildLayout, refreshInlayNames, type GuiNode, type Layout } from './model.ts'
import { applyEdits, makeDiff, applyGuiOp } from './edit.ts'
import { decodeImage, decodeBmp, readDdsSize } from './dds.ts'
import { encodePng, downscaleIfNeeded } from './png.ts'
import { buildFocusGraph, treeNodes, shortcutJson, type FocusGraph, type FocusNode, type FocusTree } from '../../focus/src/model.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, walkBlocks } from '../../parser/src/serialize.ts'
import { lintFocus } from '../../focus/src/lint.ts'
import { collectConditions } from '../../focus/src/trigger.ts'
import { planFocusMove, type FocusMove } from '../../focus/src/edit.ts'
import {
  buildLinkGraph,
  refsOf,
  defsOf,
  positionOverrides,
  type LinkGraph,
  type SymKind,
  type SymRef,
} from '../../engine/src/links.ts'
import { planRename, planXySync, type FilePatch } from '../../engine/src/rename.ts'
import { validateRoots, resetValidateCache, scanSpriteNames, type CheckRoot, type ValidationReport } from '../../engine/src/validate.ts'
/* PARALLEL_V2(2026-10-17):buildTechGraph 已搬进 worker(job-builders 的 'tech'),
 * 主线程不再直接调用 —— 所以这里只留类型。 */
import { type TechGraph } from '../../engine/src/tech.ts'
import {
  ownOf as ownOfSites,
  ownStatsOf,
  OWN_LABEL,
  type OwnInfo,
  type Ownership,
} from '../../engine/src/ownership.ts'
/* PARALLEL_V2:buildDecisionGraph / buildAiBehavior 已搬进 worker,只留类型。 */
import { type DecisionGraph } from '../../engine/src/decisions.ts'
import { type AiBehaviorModel } from '../../engine/src/aibehave.ts'
/* PARALLEL_V2:buildDlcModel 已搬进 worker,只留类型与投影函数。 */
import { dlcItemJson, type DlcModel } from '../../engine/src/dlc.ts'
/* PARALLEL_V2:buildDefinesModel 已搬进 worker。 */
import { computeDefineDiffs, summarizeDefineDiffs, type DefinesModel } from '../../engine/src/defines.ts'
import { scanDlcDirs, summarizeDlc, collectDlcGates, type DlcDescriptor } from '../../engine/src/dlcsrc.ts'
import { buildCharactersModel, type CharactersModel } from '../../engine/src/characters.ts'
import { buildUnitsModel, type UnitsModel } from '../../engine/src/units.ts'
/* PARALLEL_V2:buildDoctrineGraph / layoutDoctrines 都搬进了 worker
 * (job-builders 的 'doctrines' 里一起做),主线程只留类型。 */
import { type DoctrineGraph, type DoctrineLayout } from '../../engine/src/doctrines.ts'
/* PARALLEL_V2:buildMioTrees 已搬进 worker。 */
import { layoutMioTree, orgTraits, MIO_CELL, type MioTree } from '../../engine/src/mio.ts'
import {
  generate,
  setValidation,
  getValidation,
  GEN_SCHEMA,
  type GenKind,
  type GenSchema,
} from '../../engine/src/gen.ts'
import { buildFieldStats, type FieldStats } from '../../engine/src/fieldstats.ts'
import { buildScriptKeyWhitelist } from '../../engine/src/genvalidate.ts'
/* PARALLEL_V2:buildMusicIndex 已搬进 worker。 */
import { type MusicIndex, type MusicSong } from '../../engine/src/music.ts'
import {
  scanOfficial, scanCommon, parseOfficial, parseCommon, mdToHtml, safeDocPath,
  type DocFile,
} from './docs.ts'
import { SymbolRegistry } from '../../engine/src/completion.ts'
/* PARALLEL_V2:buildLocIndex(同步全量)也搬进了 worker ——
 * 主线程侧要流式(runLocStream),降级路径要分片(buildLocIndexAsync)。 */
import { buildLocIndexAsync, joinHits, saveLocValue, appendLocEntry, lookupKeys, lookupPair, langLabel, type LocIndex, type LocHit } from './locsrv.ts'
import { loadCache, saveCache, clearCache, cacheFiles, appCacheDirs, dirSig, dirSigAsync, strSig, serMap, deMap, DATA_ROOT, listTempJunk, clearTempExpired, listTrackerStale, clearTrackerStale } from './cache.ts'
/* PARALLEL_V1(2026-10-17):接线并行的两块基础设施 ——
 * worker-pool 提供 runInWorker/initPool(实际执行 + 主线程降级),
 * cpu-probe 提供 decideConcurrency(实测加速比定并发度,而不是拍脑袋取 CPU 数)。*/
import { initPool, runInWorker, runLocStream, type JobKind } from './worker-pool.ts'
import { decideConcurrency } from './cpu-probe.ts'
/* PARALLEL_V2:buildEventIndex 已搬进 worker,只留类型。 */
import { type EventIndex } from '../../engine/src/events.ts'
/* MODMETA_V1 / ASSETSRC_V1 / MAPMODEL_V1 —— 模组元数据 + replace_path 归属判定 + 多来源地图合成 */
import {
  parseModDescriptor,
  buildDepGraph,
  versionMatches as modVersionMatches,
  type ModDescriptor,
  type ModDepGraph,
} from '../../engine/src/modmeta.ts'
import { resolveAssets, resolveDir, type SrcRoot, type AssetResolution } from '../../engine/src/assetsrc.ts'
import { buildMapModel, auditReplacePaths, MAP_ASSETS, STATES_DIR, type MapModel } from '../../engine/src/mapmodel.ts'
import { buildBaseline as trBuildBaseline, checkUpdate as trCheckUpdate, getDiff as trGetDiff, listHistory as trListHistory, listHistorySummary as trListHistorySummary, getHistoryEntry as trGetHistoryEntry, trackerStatus as trStatus, clearTracker as trClear, clearRoot as trClearRoot, gcBlobs as trGc, deleteHistory as trDeleteHistory, rootKey as trRootKey, type TrackRoot, type TrackRootStatus } from '../../engine/src/tracker.ts'
import {
  AI_PROVIDERS,
  defaultAiConfig,
  listModels as aiListModels,
  runChat,
  redactKey,
  getPreview,
  dropPreview,
  type AiConfig,
  type AiDeps,
  type ChatMessage,
  type SseEvent,
} from './ai.ts'
import { lineOf } from '../../parser/src/serialize.ts'
import type { Block, Document } from '../../parser/src/ast.ts'

interface Root {
  name: string
  path: string
  writable: boolean
}

let ROOTS: Root[] = []
let PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5173
let READONLY = false
/** run-gui.bat 双击启动时带 --open:初始化完成后用默认浏览器打开工作台 */
let AUTO_OPEN = false

/* ── 打包态(Electron / 安装版)根目录契约 ──
 * HOI4TK_ROOT : 只读资源根(前端 public、VERSION、version.json 等),由主进程注入。
 * HOI4TK_DATA : 可写数据根(gui-settings.json、tracker 基线),默认 = ROOT。
 *   安装版必须把可写数据重定向到 userData,否则写 Program Files 会失败。
 * 未注入时回退到源码推导(浏览器/开发态完全等价于原有行为)。*/
const KIT_ROOT = process.env.HOI4TK_ROOT ?? join(import.meta.dirname ?? '.', '..', '..', '..')
const KIT_DATA = process.env.HOI4TK_DATA ?? KIT_ROOT

/* ══════════════════════════════════════════════════════════════════
 * VS Code 安装探测(VSCODEDETECT_V1,2026-10-05)
 *
 * 用户报:"右键用 VScode 打开时秒闪退 / 打开的文件明显是错误的",
 * 并要求"应该先检测 VSCode 是否安装以及安装路径"。
 *
 * 探测要解决的三个现实坑(都在本机实测到):
 *
 * ① **bin/ 下同时存在 code.cmd 与 new_code.cmd**,两者分别指向
 *    resources/app/out/ 下**不同的 hash 目录**(本机实测 04c0d99f4f vs 07f806f999)。
 *    new_code.* 是新版 CLI 留下的,内容相同但 hash 目录更新。
 *    只认 code.cmd 会一直用旧 CLI → 与当前 Code.exe 版本不匹配 → 开错窗口/错文件。
 *    → 排序:new_code.* 优先于 code.*。
 *
 * ② **.cmd 必须带 shell 执行**。Node 的 execFile/spawn 直接跑 .cmd 报 EINVAL
 *    (Windows 只允许 CreateProcess 跑 .exe/.com;这是 Node 的安全限制,不是 bug)。
 *    → 每个候选带 `shell` 标志,true 才加 shell:true。
 *
 * ③ **Code.exe 兜底**:便携版/自定义目录装的时候 bin/ 下可能没有 CLI,
 *    只有上一层的 Code.exe。直接 spawn .exe 不需要 shell。
 *
 * 另:同目录下的 `code` / `new_code` 是 **sh 脚本**(给 Git Bash 用的),
 * 在 Windows + Node 里跑不了,不要收进候选(否则每次都白等一次超时)。
 * ══════════════════════════════════════════════════════════════════ */
interface VscodeBin {
  path: string
  shell: boolean
}
interface VscodeDetect {
  found: boolean
  kind: 'stable' | 'insiders' | 'vscodium' | 'portable' | 'none'
  version: string | null
  /** true = 安装目录里有 updating_version,VS Code 正在更新中。
   *  更新期间新旧资源目录并存,旧 CLI 拉起的实例会秒退 —— 必须提示用户。 */
  updating: boolean
  candidates: VscodeBin[]
  searched: string[]
}

/** 探测结果缓存:安装位置不会频繁变,免得每次右键都扫一遍盘 */
let vscodeCache: { at: number; val: VscodeDetect } | null = null

function detectVSCode(force = false): VscodeDetect {
  if (!force && vscodeCache && Date.now() - vscodeCache.at < 60_000) return vscodeCache.val
  const searched: string[] = []
  const candidates: VscodeBin[] = []
  const localApp = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const dirs = [
    // ① 用户级安装(最常见,新版 CLI 也在这)
    { base: join(localApp, 'Programs', 'Microsoft VS Code'), kind: 'stable' as const },
    { base: join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft VS Code'), kind: 'stable' as const },
    {
      base: join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft VS Code'),
      kind: 'stable' as const,
    },
    { base: join(localApp, 'Programs', 'Microsoft VS Code Insiders'), kind: 'insiders' as const },
    { base: join(localApp, 'Programs', 'VSCodium'), kind: 'vscodium' as const },
  ]
  for (const d of dirs) {
    searched.push(d.base)
    const stem = d.kind === 'insiders' ? 'code-insiders' : d.kind === 'vscodium' ? 'codium' : 'code'
    // ⚠ 顺序即优先级:new_code.* 必须在 code.* 之前(见文件头 ①)
    for (const f of [
      join(d.base, 'bin', `new_${stem}.cmd`),
      join(d.base, 'bin', `${stem}.cmd`),
      join(d.base, 'Code.exe'), // 兜底:便携版只有 exe
      join(d.base, `${stem}.exe`),
    ]) {
      if (existsSync(f) && !candidates.some((c) => c.path === f))
        candidates.push({ path: f, shell: f.endsWith('.cmd') })
    }
  }
  const first = candidates[0]
  let version: string | null = null
  let updating = false
  if (first) {
    const base = dirname(dirname(first.path)) // .../Microsoft VS Code
    // ⚠ 更新未完成时(安装目录下有 updating_version)两个资源目录并存:
    //   实测本机 1.139.1(04c0d99f4f) 正更新到 1.140.0(07f806f999),
    //   旧 code.cmd 仍指向旧目录 → 拉起即崩,这就是用户报的"秒闪退"。
    //   这时要告诉用户"先等更新完/重启一次 VS Code",而不是闷头重试。
    try {
      updating = existsSync(join(base, 'updating_version'))
    } catch {
      /* 忽略 */
    }
    // 版本从 resources/app/package.json 取。注意路径是 <base>/<hash>/resources/app/,
    //   不能想当然写 <base>/resources/app —— 新版 VS Code 改成了 hash 目录布局。
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const f = join(base, d.name, 'resources', 'app', 'package.json')
      if (!existsSync(f)) continue
      try {
        const v = (JSON.parse(readFileSync(f, 'utf8')) as { version?: string }).version
        if (v && v > (version ?? '')) version = v
      } catch {
        /* 单个文件坏了不影响其它 */
      }
    }
  }
  const kind: VscodeDetect['kind'] = !candidates.length
    ? 'none'
    : dirs.find((d) => candidates[0].path.startsWith(d.base))?.kind ?? 'portable'
  const val: VscodeDetect = { found: candidates.length > 0, kind, version, updating, candidates, searched }
  vscodeCache = { at: Date.now(), val }
  return val
}

/* ★ CLI 显式给出的来源(CLI_STICKY_ROOTS_V1):
 * 之前 --mod 只 push 进 ROOTS、不写进 gui-settings.json,于是任何一次
 * 「重建来源」(设置页保存 / 模组开关 / AI 配置保存)都会用设置文件重算,
 * 把命令行传进来的模组**静默丢掉** —— 症状是"跑完一遍自检,模组全没了"。
 * 这里把 CLI 来源单独记一份,applySettings 重建后补回去(优先级最高)。 */
const CLI_ROOTS: Root[] = []
function parseArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') ROOTS.push({ name: 'vanilla', path: argv[++i], writable: false })
    else if (a === '--mod') {
      const p = argv[++i]
      ROOTS.push({ name: basename(p), path: p, writable: true })
      CLI_ROOTS.push({ name: basename(p), path: p, writable: true })
    } else if (a === '--writable-root') {
      const n = parseInt(argv[++i], 10)
      if (ROOTS[n]) ROOTS[n].writable = true
    } else if (a === '--port') PORT = parseInt(argv[++i], 10)
    else if (a === '--readonly') READONLY = true
    else if (a === '--open') AUTO_OPEN = true
  }
}

parseArgs(process.argv.slice(2))
if (!ROOTS.length) {
  ROOTS.push({
    name: 'vanilla',
    path: 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV',
    writable: false,
  })
}
if (READONLY) for (const r of ROOTS) r.writable = false
// 基础游戏为必需项:未显式给出 --base 时补上默认安装路径。
// 置于首位 —— spriteIdx / scanEntries 均以 ROOTS[0] 为基准。
if (!ROOTS.some((r) => !r.writable)) {
  ROOTS.unshift({
    name: 'vanilla',
    path: "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV",
    writable: false,
  })
}
/* 启动时套用 gui-settings.json。
 * 显式给了 --base / --mod / --writable-root 时命令行优先,设置文件不接管;
 * 否则让设置文件重建来源,实现「设置一次、以后开机就生效」。
 *
 * ⚠ SETTINGS_TDZ:必须由文件末尾显式调用,不能留在这里当顶层语句。
 *   本段会间接触发一串模块级状态(DEFAULT_DISPLAY / GAME_VERSION_TRIED 等 const/let),
 *   而它们声明在本文件后部 —— 顶层执行会落进 TDZ 抛 ReferenceError。
 *   症状曾经是"设置文件明明存在,启动日志却永远读不到"。 */
function applySavedSettingsAtBoot(): void {
  if (process.argv.slice(2).some((a) => a === '--base' || a === '--mod' || a === '--writable-root')) return
  const _s = loadSettings()
  if (!_s || !_s.base || !existsSync(_s.base)) return
  try {
    const _all = normalizeMods(_s.mods)
    const _mods = _all.filter((m) => m.enabled && existsSync(m.path))
    const _r: Root[] = [{ name: 'vanilla', path: _s.base, writable: false }]
    for (const m of _mods) {
      const d = readDescriptor(m.path)
      _r.push({ name: d.name || basename(m.path), path: m.path, writable: true })
    }
    if (READONLY) for (const r of _r) r.writable = false
    ROOTS.length = 0
    for (const r of _r) ROOTS.push(r)
    const _off = _all.filter((m) => !m.enabled).length
    console.log(
      '  已从 gui-settings.json 载入设置:' + ROOTS.length + ' 个来源' +
        (_off ? `(${_off} 个模组已关闭)` : ''),
    )
  } catch (e) {
    console.log('  [警告] 载入 gui-settings.json 失败,改用默认来源: ' + e)
  }
}

/* ── sprite 索引(按 root 顺序扫描,后扫覆盖先扫) ── */
function buildScanEntries(): { dir: string; gameRoot: string; texRoot?: string }[] {
  const out: { dir: string; gameRoot: string; texRoot?: string }[] = []
  for (let i = 0; i < ROOTS.length; i++) {
    const r = ROOTS[i]
    if (i === 0) {
      if (existsSync(join(r.path, 'interface'))) out.push({ dir: join(r.path, 'interface'), gameRoot: r.path })
      try {
        const dlcs = scanDlcDirs(r.path)
        DLC_DIRS = dlcs.map((d) => d.abs)
        for (const d of dlcs) {
          const di = join(d.abs, 'interface')
          if (existsSync(di)) out.push({ dir: di, gameRoot: r.path, texRoot: d.abs })
        }
      } catch { /* DLC 扫描失败不阻断 */ }
    } else if (existsSync(join(r.path, 'interface'))) {
      out.push({ dir: join(r.path, 'interface'), gameRoot: r.path })
    }
  }
  return out
}
let spriteIdx = new SpriteIndex(ROOTS[0].path)
let scanEntries = buildScanEntries()
const t0 = Date.now()

const DEFAULT_GAME_DIR = "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV"

function rebuildIndexes() {
  RESP_CACHE.clear()
  bumpApiCache()
  scanEntries = buildScanEntries()
  spriteIdx = new SpriteIndex(ROOTS[0] && ROOTS[0].path ? ROOTS[0].path : '')
  // ★★★ TEX_CANDIDATE_FN_V1(2026-10-22):把多 root + 扩展名回退链注入 spriteIdx。
  //   缺了它,texturePath 只按 def.gameRoot 解析 —— 模组重定义 sprite 但贴图文件
  //   没跟着进模组目录时(KR 的 gui_india.gfx 重定义 GFX_fuhrer_name_ribbon 等,
  //   指向 gfx/interface/inner_circle/*.dds 而 KR 只带了 2 个 png),readFileSync
  //   必失败 → naturalSize 返回 null → sizeUnknown → 节点 drawW/drawH = 0。
  //   实测 GER_inner_circle:11 个节点(3×顾问框/名称条/特质条 + 元首缎带/特质框)
  //   因此渲染成 0×0 空框,与游戏内" ornate frame + 名称条"完全不符。
  //   /api/tex 显示链一直是 texCandidates(模组逆序→DLC→原版,扩展名回退),
  //   注入后"图显示正常但尺寸推断失败"的割裂被消除。
  spriteIdx.candidateFn = (tf: string) => texCandidates(tf)
  if (ROOTS.length) spriteIdx.scanAll(scanEntries)
  // ★★★ INLAY_V4:国策内嵌组件名册。名单里的根容器按【槽位】定位而非屏幕,
  //   不加载的话这 6 个 .gui 会被当成普通屏幕窗口,整棵子树错位(判例 GER 曾整体出屏)。
  const inlayN = refreshInlayNames(ROOTS)
  if (inlayN) console.log(`  inlay 内嵌组件名册: ${inlayN} 条`)
  texIds.clear(); texTable.clear(); texCache.clear()
  layoutCache.clear()
  LINK = null; LINK_ERR = ''; LINK_BUSY = false
  SYM = null; SYM_ERR = ''; SYM_BUSY = false
  FG = null; FG_ERR = ''; FG_BUSY = false
  CHECK = null; CHECK_ERR = ''; CHECK_BUSY = false
  /* MOD_SCOPE_V1:ROOTS 变了,引擎侧按来源缓存的扫描结果就过期了。
   * 不清的话会拿旧来源的 sprite 名 / loc 键去判定新挂载的模组 ——
   * 那是**静默的假阴性**(少报问题),比报错更难查。*/
  resetValidateCache()
  rebuildCheckRoots()
  /* MODMETA_V1:地图是按「载入序 + replace_path」合成的,ROOTS 一变,
   * 生效的 provinces.bmp / definition.csv / states 就可能换人 ——
   * 不清缓存会继续给用户看旧模组的地图(静默错图)。*/
  invalidateWorldMap()
  TG = null; TG_ERR = ''; TG_BUSY = false
  DG = null; DG_ERR = ''; DG_BUSY = false
  CG = null; UG = null
  AB = null; AB_ERR = ''; AB_BUSY = false
  DM = null; DM_ERR = ''; DM_BUSY = false
  DGR = null; DGR_LAYOUT = null; DGR_ERR = ''; DGR_BUSY = false
  MT = null; MT_ERR = ''; MT_BUSY = false
  LOC = null; LOC_ERR = ''; LOC_BUSY = false
  MUSIC = null; MUSIC_BUSY = false
  EV = null; EV_ERR = ''; EV_BUSY = false
  DF = null; DF_ERR = ''; DF_BUSY = false
  console.log('  已重建索引: ' + ROOTS.length + ' 个来源')
  for (const r of ROOTS) console.log('    ' + (r.writable ? '[可写·模组]' : '[只读·游戏]') + ' ' + r.name + '  ' + r.path)
}

/**
 * MAKE_MOD_V1:写盘之后的【软失效】。
 *
 * 全量 rebuildIndexes() 要重扫贴图名册 + 重建全部图,几十秒级 —— 用户刚点
 * "保存到模组"就被卡住是不可接受的,而这个工作台本身就是给人边做边看的。
 * 这里只把"内容图"的缓存置空(下次访问由各自的 ensure* 异步重建,页面本来
 * 就轮询 ready:false),并把刚改动的文件的 layout 缓存丢掉。
 *
 * 贴图名册刻意不动:新增 .dds 是小概率事件,真需要时用 /api/reload 全量重建。
 */
function softInvalidate(changedAbs: string[] = [], light = false): void {
  bumpApiCache()
  for (const abs of changedAbs) layoutCache.delete(abs)
  LINK = null; LINK_ERR = ''; LINK_BUSY = false
  CHECK = null; CHECK_ERR = ''; CHECK_BUSY = false; CHECK_GEN++
  /* 改 map/ 或 history/states 里的文件 → 地图归属与省份归属都变了 */
  if (changedAbs.some((a) => /[\\/]map[\\/]|[\\/]history[\\/]states[\\/]/.test(a))) invalidateWorldMap()
  // light:设计器改的多半是 .gui,与内容图无关,不必让国策/科技/DLC 全部重来
  if (light) return
  SYM = null; SYM_ERR = ''; SYM_BUSY = false
  FG = null; FG_ERR = ''; FG_BUSY = false
  TG = null; TG_ERR = ''; TG_BUSY = false
  DG = null; DG_ERR = ''; DG_BUSY = false
  CG = null; UG = null
  AB = null; AB_ERR = ''; AB_BUSY = false
  DM = null; DM_ERR = ''; DM_BUSY = false
  DGR = null; DGR_LAYOUT = null; DGR_ERR = ''; DGR_BUSY = false
  MT = null; MT_ERR = ''; MT_BUSY = false
  LOC = null; LOC_ERR = ''; LOC_BUSY = false
  MUSIC = null; MUSIC_BUSY = false
  EV = null; EV_ERR = ''; EV_BUSY = false
  DF = null; DF_ERR = ''; DF_BUSY = false
  resetValidateCache()
}

/**
 * ★ 基础游戏的判据是【存在 hoi4.exe】,不是"有没有 interface/"。
 *
 * 之前用 `interface/ + common/` 当判据,后果是:任何把游戏目录复制一半、
 * 或只放了 common/ 的目录都会被当成合法游戏目录,加载后文件列表空、
 * 贴图全挂,而页面还显示"可用"。exe 是唯一不会误判的强特征。
 * (interface/ common/ 降级为辅助信息,只在详情里显示,不参与判定。)
 */
const GAME_EXE = ['hoi4.exe', 'hoi4', 'HeartsofIronIV.exe']

interface DirInfo {
  /** 目录本身是否存在 */
  exists: boolean
  /** ★ 主判据:是否含 hoi4.exe */
  hasExe: boolean
  exe?: string
  hasInterface: boolean
  hasCommon: boolean
  /** ★ 模组主判据:是否含 .mod 文件 */
  hasModFile: boolean
  modFile?: string
}

function dirInfo(p: string): DirInfo {
  const out: DirInfo = {
    exists: false, hasExe: false, hasInterface: false, hasCommon: false, hasModFile: false,
  }
  try {
    if (!existsSync(p) || !statSync(p).isDirectory()) return out
  } catch {
    return out
  }
  out.exists = true
  for (const e of GAME_EXE) {
    if (existsSync(join(p, e))) { out.hasExe = true; out.exe = e; break }
  }
  out.hasInterface = existsSync(join(p, 'interface'))
  out.hasCommon = existsSync(join(p, 'common'))
  const mf = findModFile(p)
  if (mf) { out.hasModFile = true; out.modFile = mf }
  return out
}

/** 是否像一个 HoI4 安装目录：★ 以 hoi4.exe 为准（保留旧函数以兼容其它调用点） */
function looksLikeGameDir(p: string): boolean {
  return dirInfo(p).hasExe
}

/** Steam 根的常见安装位置(按盘符展开)。命中即可跳过注册表 */
const STEAM_COMMON = (() => {
  const out: string[] = []
  for (const d of ['C', 'D', 'E', 'F', 'G', 'H']) {
    out.push(d + ':/Program Files (x86)/Steam')
    out.push(d + ':/Program Files/Steam')
    out.push(d + ':/Steam')
  }
  return out
})()

/** 常见位置里是否已存在一个像样的 Steam 根(含 steamapps 目录) */
function steamRootFoundByFS(): boolean {
  for (const p of STEAM_COMMON) {
    try {
      if (existsSync(join(p, 'steamapps'))) return true
    } catch {
      /* 盘不存在/无权限:忽略 */
    }
  }
  return false
}

/**
 * 从注册表读 Steam 根目录(仅 Windows;失败返回空数组)
 *
 * ★ 三重保护,起因是踩过的坑:
 *   某些受限环境(如沙箱)把 reg.exe 列入程序黑名单,启动子进程会被
 *   **直接杀掉宿主进程** —— try/catch 拦不住(不是抛异常,是进程直接没了)。
 *   而 detectGameDirs() / allSteamRoots() 在切换模组、重扫创意工坊时会被反复
 *   调用,等于反复举刀 —— 实测服务能正常跑 6 分钟,然后死在一次模组开关切换上。
 *   ① 先用文件系统探常见安装位置,命中就完全不 spawn reg.exe(绝大多数情况)
 *   ② 结果进程内缓存,最多只 spawn 一轮(3 个键)
 *   ③ HOI4_NO_REG=1 可彻底禁用,走常见路径兜底
 * 注意:即使注册表完全读不到,常见路径兜底仍会给出 Steam 根,创意工坊不会空。
 */
let steamRootsCache: string[] | null = null
function steamRoots(): string[] {
  if (steamRootsCache) return steamRootsCache
  const out: string[] = []
  if (process.env.HOI4_NO_REG === '1' || steamRootFoundByFS()) {
    // ①/③ 文件系统已能定位(或被显式禁用)→ 不 spawn 任何子进程
    steamRootsCache = out
    return out
  }
  const keys: [string, string][] = [
        ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
        ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
        ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
      ]
  for (const kv of keys) {
    try {
      const txt = execFileSync('reg', ['query', kv[0], '/v', kv[1]], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      })
      const m = txt.match(new RegExp(kv[1] + '\\s+REG_SZ\\s+(.+)'))
      if (m && m[1]) out.push(m[1].trim().replace(/\\/g, '/'))
    } catch {
      /* 非 Windows / 无 reg / 无该键:忽略 */
    }
  }
  steamRootsCache = out
  return out
}

/**
 * 列出 HoI4 安装目录候选:默认路径 → Steam 注册表 → Steam 各游戏库
 * (含 libraryfolders.vdf 指向其它盘的库)→ 各盘常见安装位置。
 * ok=true 表示该目录下确实有 interface/ 与 common/。
 */
function detectGameDirs(): GameDirCandidate[] {
  const seen = new Set<string>()
  const out: GameDirCandidate[] = []
  const add = (raw: string, source: string) => {
    if (!raw) return
    const p = raw.replace(/\\/g, '/').replace(/\/+$/, '')
    const k = p.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    const di = dirInfo(p)
    out.push({
      path: p,
      // ★ ok 就是"有 hoi4.exe"。目录都不存在时 ok=false,前端标灰
      ok: di.hasExe,
      source,
      hasExe: di.hasExe,
      hasInterface: di.hasInterface,
      hasCommon: di.hasCommon,
    })
  }
  const GAME = 'Hearts of Iron IV'
  add(DEFAULT_GAME_DIR, '默认路径')
  for (const s of steamRoots()) {
    add(join(s, 'steamapps', 'common', GAME), 'Steam 注册表')
    try {
      const vdf = readFileSync(join(s, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      const re = /"path"\s+"([^"]+)"/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(vdf))) {
        add(join(mm[1], 'steamapps', 'common', GAME), 'Steam 游戏库')
      }
    } catch {
      /* 无 vdf 或读不到:忽略 */
    }
  }
  for (const s of STEAM_COMMON) {
    add(join(s, 'steamapps', 'common', GAME), '常见路径')
  }
  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))
  return out
}

/** 基础游戏候选。ok 的准绳是 hoi4.exe,不是目录结构 */
interface GameDirCandidate {
  path: string
  ok: boolean
  source: string
  hasExe: boolean
  hasInterface: boolean
  hasCommon: boolean
}

/* ── Steam 创意工坊模组发现 + .mod 元信息提取(SETTINGS_V1 / MODINFO_V1) ──
 *
 * HoI4 的 appid 是 394360,创意工坊模组解压后落在
 *   <Steam根>/steamapps/workshop/content/394360/<workshopItemId>/
 * 目录名是纯数字 ID,手填路径极难用。本函数把各 Steam 库下的该目录全扫一遍,
 * 读 .mod 的 name/tags/version 把 ID 翻译成模组名,并统计 .gui 数量
 * (用户真正在意的是"这个模组有没有改界面",而不是它有多少张贴图)。
 */
const HOI4_APPID = "394360"

/* ── 以 .mod 文件为特征的模组识别 ──
 *
 * 判据:**目录下存在 .mod 文件即视为模组**,而不是靠"有没有 interface/"。
 * 依据(实测本机 workshop/content/394360 共 36 个模组):
 *   - 36/36 都有 descriptor.mod,且**全部命名为 descriptor.mod**,无一例外
 *   - 29/36 含 interface/,7 个只改 common/ localisation/ events/ 等(纯数据模组)
 *     → 用 interface/ 当判据会漏掉 7 个合法模组;用 .mod 当判据才准
 *   - 反过来,用户自建的本地模组(放在任意目录、**没有 .mod 文件**)
 *     → 所以 .mod 是"有则更准"的强特征,不能当唯一必要条件。
 *       无 .mod 时退化为"有 interface/ 或 common/"的推断判定(inferred=true)。
 *
 * descriptor.mod 顶层字段实测频次(36 个模组):
 *   replace_path 745  tags 36  name 36  supported_version 36
 *   remote_file_id 36  version 34  picture 22  dependencies 15  path 9
 *
 * **path= 是陷阱**:9 个模组写了 path=,实测值全都指向作者的机器,例如
 *   1360299796 Kaiserreich Musicpath="C:/Users/mw/Documents/Paradox Interactive/..."
 *   3105210203 KR Tech Extensionpath="C:/Users/sirip/OneDrive/Documents/..."
 * 创意工坊场景下这是**残留的作者本地路径**,绝不能拿来当模组根目录。
 * 故只作为"需人工确认"的信号返回(stalePath),不参与任何路径决策。
 */
interface ModInfo {
  /** 是否检到 .mod 文件 —— 模组身份的主判据 */
  hasModFile: boolean
  /** 实际读到的 .mod 文件名(descriptor.mod / 任意 *.mod) */
  modFile?: string
  /** 无 .mod 时靠目录结构推断(有 interface/ 或 common/) */
  inferred: boolean
  name: string
  /** 模组自身版本号 */
  version: string
  /** 游戏版本要求,如 1.19.* —— 与当前游戏版本比对得出兼容性 */
  supportedVersion: string
  /** supported_version 与当前游戏版本是否匹配 */
  versionOk?: boolean
  tags: string[]
  dependencies: string[]
  picture?: string
  remoteFileId?: string
  /** replace_path 条数 —— 反映模组改动覆盖面 */
  replacePathCount: number
  /** .mod 里写了 path= —— 创意工坊下通常是作者本机残留路径,需人工确认 */
  stalePath?: string
}

/** 列出所有 Steam 根(含 libraryfolders.vdf 指向的额外游戏库) */
function allSteamRoots(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    if (!raw) return
    const p = raw.replace(/\\/g, "/").replace(/\/+$/, "")
    const k = p.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(p)
  }
  for (const s of steamRoots()) {
    push(s)
    try {
      const vdf = readFileSync(join(s, "steamapps", "libraryfolders.vdf"), "utf8")
      const re = /"path"\s+"([^"]+)"/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(vdf))) push(mm[1])
    } catch {
      /* 无 vdf:忽略 */
    }
  }
  // 注册表读不到时的兜底:直接探常见安装位置。
  // steamRoots() 内部走 reg.exe,在受限环境 / 非标准安装下会返回空,
  // 那时若不兜底,创意工坊列表会整个空掉且前端只显示"没找到模组",
  // 用户根本分不清是"没装模组"还是"没找到 Steam"。
  for (const s of STEAM_COMMON) push(s)
  return out
}

interface WorkshopMod extends ModInfo {
  id: string
  path: string
  hasInterface: boolean
  guiCount: number
}

let GAME_VERSION = ""
let GAME_VERSION_TRIED = false
/**
 * 读游戏版本(launcher-settings.json 的 rawVersion,本机实测 1.19.3.0)。
 * 顺序:已加载的只读 root(即基础游戏)→ 自动检测到的可用安装目录 → 默认路径。
 * 只读 root 排在最前,保证用户实际在编辑的那个游戏版本被读到。
 */
function readGameVersion(): string {
  if (GAME_VERSION_TRIED) return GAME_VERSION
  GAME_VERSION_TRIED = true
  const cands: string[] = []
  for (const r of ROOTS) if (!r.writable) cands.push(r.path)
  try {
    for (const c of detectGameDirs()) if (c.ok) cands.push(c.path)
  } catch {
    /* 检测失败就只用手上的 ROOTS */
  }
  cands.push(DEFAULT_GAME_DIR)
  const seen = new Set<string>()
  for (const r of cands) {
    const k = r.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    try {
      const txt = readFileSync(join(r, "launcher-settings.json"), "utf8")
      const m = txt.match(/"rawVersion"\s*:\s*"([^"]*)"/)
      if (m && m[1]) {
        GAME_VERSION = m[1].trim()
        return GAME_VERSION
      }
    } catch {
      /* 试下一个 */
    }
  }
  return GAME_VERSION
}

/**
 * 通配符版本匹配:模组写 1.19.* / 1.19.3.* / 1.19.3.0,游戏是 1.19.3.0。
 * 逐段比较,遇 * 直接通过;pattern 段数少于 actual 时,多出来的段只在
 * pattern 末段是 * 才通过(否则视为不兼容,宁可提醒别静默)。
 */
function versionMatches(pattern: string, actual: string): boolean {
  if (!pattern || !actual) return true
  if (pattern === actual) return true
  const p = pattern.trim().split(".")
  const a = actual.trim().split(".")
  for (let i = 0; i < p.length; i++) {
    const ps = p[i]
    const as = a[i]
    if (ps === "*") return true
    if (as === undefined) return false
    if (ps !== as) return false
  }
  return true
}

/**
 * 找一个目录下的 .mod 文件 —— 模组身份判据。
 * 优先 descriptor.mod(创意工坊 36/36 都是这个名字);
 * 其次取根层第一个 *.mod(自建模组常叫 <模组名>.mod)。
 * 只看根层,不递归 —— 避免把子模组/子目录里的 .mod 误认成主描述文件。
 */
function findModFile(dir: string): string | undefined {
  if (existsSync(join(dir, "descriptor.mod"))) return "descriptor.mod"
  try {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".mod"))
    // 多个 .mod 时取最短的那个:主描述文件通常最短最规范,
    // 子模组的名字往往是 "<主名>_<子模块>" 这种更长的一串。
    files.sort((a, b) => a.length - b.length)
    return files[0]
  } catch {
    /* 读不到目录:当作无 .mod */
  }
  return undefined
}

/**
 * 解析 .mod,提取模组元信息。以 **.mod 文件存在** 作为模组身份判据。
 * 任何字段缺失都退回空串,绝不抛错 —— 扫描列表时一个坏文件不能拖垮整批。
 */
function readModInfo(dir: string): ModInfo {
  const out: ModInfo = {
    hasModFile: false,
    inferred: false,
    name: "",
    version: "",
    supportedVersion: "",
    tags: [],
    dependencies: [],
    replacePathCount: 0,
  }
  const mf = findModFile(dir)
  if (!mf) {
    // 无 .mod:退化为结构推断,让自建/第三方模组也能被认出来
    out.inferred = existsSync(join(dir, "interface")) || existsSync(join(dir, "common"))
    return out
  }
  out.hasModFile = true
  out.modFile = mf
  let txt = ""
  try {
    txt = readFileSync(join(dir, mf), "utf8")
  } catch {
    return out
  }
  // 每个字段都锚在行首 + 只匹配不带前缀的那个键:
  //   ^\s*name 不会误吃 supported_version / remote_file_id,
  //   ^\s*path 不会误吃 replace_path。
  const str = (re: RegExp): string => {
    const m = txt.match(re)
    return m && m[1] ? m[1].trim() : ""
  }
  out.name = str(/^[ \t]*name[ \t]*=[ \t]*"([^"]*)"/m)
  out.version = str(/^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m)
  out.supportedVersion = str(/^[ \t]*supported_version[ \t]*=[ \t]*"([^"]*)"/m)
  out.picture = str(/^[ \t]*picture[ \t]*=[ \t]*"([^"]*)"/m) || undefined
  out.remoteFileId = str(/^[ \t]*remote_file_id[ \t]*=[ \t]*"([^"]*)"/m) || undefined
  out.stalePath = str(/^[ \t]*path[ \t]*=[ \t]*"([^"]*)"/m) || undefined
  const tm = txt.match(/tags[ \t]*=[ \t]*\{([\s\S]*?)\}/)
  if (tm) out.tags = [...tm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean).slice(0, 6)
  const dm = txt.match(/dependencies[ \t]*=[ \t]*\{([\s\S]*?)\}/)
  if (dm) out.dependencies = [...dm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean).slice(0, 8)
  out.replacePathCount = (txt.match(/^[ \t]*replace_path[ \t]*=/gm) || []).length
  const gv = readGameVersion()
  if (out.supportedVersion && gv) out.versionOk = versionMatches(out.supportedVersion, gv)
  return out
}

/** 兼容旧调用:只要 name 的轻量版 */
function readDescriptor(dir: string): { name: string; version: string; tags: string[] } {
  const m = readModInfo(dir)
  return { name: m.name, version: m.version, tags: m.tags }
}

// SETTINGS_V1

/* ── 设置持久化(SETTINGS_V1)──────────────────────────────
 *
 * gui-settings.json 落在 toolkit 根目录(与 packages/ 平级)。
 * 路径用 function 而不是 const 存,是为了让「启动时套用设置」那段
 * 能安全提前调用(函数声明会提升,const 会在 TDZ 里抛错)。
 */
interface DisplayOpts {
  showTex: boolean
  showNames: boolean
  snap: boolean
  grid: number
  defaultZoom: number
}

interface ModEntry {
  /** 模组目录绝对路径 */
  path: string
  /** 是否参与索引/渲染。关闭的模组保留在设置里但不进 ROOTS */
  enabled: boolean
}

interface Settings {
  base: string
  mods: ModEntry[]
  display: DisplayOpts
  /** AIDE_V1:AI 开发接口配置。apiKey 只在用户显式填写时才有,落 gui-settings.json(已 gitignore) */
  ai?: AiConfig
  /** 桌面程序图标(data URL)。用户在「设置」页上传自定义图标后落盘,Electron 壳据此替换窗口/任务栏/EXE 图标 */
  icon?: string
}

/** 兼容旧版 settings.json 的 mods: string[] —— 全部视为启用。MOD_TOGGLE_V1 */
function normalizeMods(raw: unknown): ModEntry[] {
  const out: ModEntry[] = []
  const push = (p: unknown, en: unknown) => {
    if (typeof p !== 'string') return
    const t = p.trim()
    if (!t) return
    out.push({ path: t, enabled: en === undefined ? true : !!en })
  }
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (typeof m === 'string') push(m, true)
      else if (m && typeof m === 'object') push((m as any).path, (m as any).enabled)
    }
  }
  return out
}

// ⚠ SETTINGS_TDZ:本块声明在文件后部,但启动段(本文件顶部)会调用 loadSettings()。
//   DEFAULT_DISPLAY 是 const,启动段执行时它还在 TDZ,展开运算符会抛 ReferenceError,
//   被 loadSettings 的 catch 吞成 null —— 症状是"设置文件存在却永远不生效"。
//   故这里用惰性函数而不是常量。
function defaultDisplay(): DisplayOpts {
  return { showTex: true, showNames: false, snap: false, grid: 5, defaultZoom: 1 }
}
const DEFAULT_DISPLAY: DisplayOpts = defaultDisplay()

function settingsPath(): string {
  return join(KIT_DATA, 'gui-settings.json')
}

function loadSettings(): Settings | null {
  const p = settingsPath()
  try {
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j || typeof j !== 'object') return null
    return {
      base: typeof j.base === 'string' ? j.base : '',
      mods: normalizeMods(j.mods),
      display: { ...defaultDisplay(), ...(j.display ?? {}) },
      /* ★ apiKey 不做持久化回显:读出来是为了继续用,但 /api/ai/config 回给前端时会被抹掉 */
      ai: j.ai ? { ...defaultAiConfig(), ...(j.ai as object) } : undefined,
      /* ★ APP_ICON_V1:桌面程序图标(data URL)。只在用户显式设置时才有 */
      icon: typeof j.icon === 'string' && j.icon ? j.icon : undefined,
    }
  } catch (e) {
    console.log('  [警告] 解析设置文件失败(' + p + '):' + e)
    return null
  }
}

function saveSettings(s: Settings): void {
  const p = settingsPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ ...s, savedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch (e) {
    console.log('  [警告] 无法写入 gui-settings.json: ' + e)
  }
}

/** 用设置重建来源列表。返回没有 interface/ 的目录(不阻断,只提示)。 */
function applySettings(s: Settings): { roots: Root[]; warnNoInterface: string[]; disabled: string[] } {
  const base = s.base.trim()
  if (!base) throw new Error('基础游戏路径为必填项')
  if (!existsSync(base)) throw new Error(`基础游戏路径不存在: ${base}`)
  const all = normalizeMods(s.mods)
  for (const m of all) if (!existsSync(m.path)) throw new Error(`模组路径不存在: ${m.path}`)
  const on = all.filter((m) => m.enabled)
  const roots: Root[] = [{ name: 'vanilla', path: base, writable: false }]
  for (const m of on) {
    const d = readDescriptor(m.path)
    roots.push({ name: d.name || basename(m.path), path: m.path, writable: true })
  }
  if (READONLY) for (const r of roots) r.writable = false
  /* ★ CLI_STICKY_ROOTS_V1:命令行传进来的模组不写在设置里,重建后必须补回 ——
   *   否则用户在 run-gui.bat 里带的 --mod 会在第一次保存设置/开关模组时消失。
   *   追加到末尾 = 优先级最高(与游戏"后载入者覆盖"一致)。 */
  for (const cr of CLI_ROOTS) {
    if (!roots.some((r) => samePath(r.path, cr.path))) {
      roots.push({ name: cr.name, path: cr.path, writable: cr.writable })
    }
  }
  ROOTS.length = 0
  for (const r of roots) ROOTS.push(r)
  rebuildIndexes()
  return {
    roots,
    warnNoInterface: on.filter((m) => !existsSync(join(m.path, 'interface'))).map((m) => m.path),
    disabled: all.filter((m) => !m.enabled).map((m) => m.path),
  }
}

/** 递归数 .gui 数量。限制深度与文件数,避免超大模组把请求拖死。 */
function countGuiFiles(root: string, cap = 4000): number {
  let n = 0
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length && n < cap) {
    const cur = stack.pop()!
    if (cur.depth > 6) continue
    let items: import("node:fs").Dirent[]
    try {
      items = readdirSync(cur.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const it of items) {
      if (n >= cap) break
      if (it.isDirectory()) stack.push({ dir: join(cur.dir, it.name), depth: cur.depth + 1 })
      else if (it.name.toLowerCase().endsWith(".gui")) n++
    }
  }
  return n
}

/** 把一个目录组装成 WorkshopMod —— 创意工坊与手填目录共用同一套 .mod 提取 */
function describeModDir(dir: string, id: string): WorkshopMod {
  const mi = readModInfo(dir)
  const hasIface = existsSync(join(dir, "interface"))
  return {
    ...mi,
    id,
    // 读不到 name 就退回 ID,总比空字符串强
    name: mi.name || id,
    path: dir,
    hasInterface: hasIface,
    guiCount: hasIface ? countGuiFiles(join(dir, "interface")) : 0,
  }
}

function scanWorkshopMods(): { roots: string[]; mods: WorkshopMod[] } {
  const roots: string[] = []
  const mods: WorkshopMod[] = []
  const seenPath = new Set<string>()
  for (const sr of allSteamRoots()) {
    const wc = join(sr, "steamapps", "workshop", "content", HOI4_APPID)
    let ids: string[]
    try {
      ids = readdirSync(wc).filter((d) => /^\d+$/.test(d))
    } catch {
      continue
    }
    if (!ids.length) continue
    roots.push(wc)
    for (const id of ids) {
      const dir = join(wc, id)
      const key = dir.toLowerCase()
      if (seenPath.has(key)) continue
      seenPath.add(key)
      mods.push(describeModDir(dir, id))
    }
  }
  // 排序:有界面的排前面 → 版本兼容的排前面 → .gui 数量降序。
  // 用户一般只关心改过界面且当前游戏版本能跑的模组。
  mods.sort(
    (a, b) =>
      (a.hasInterface === b.hasInterface ? 0 : a.hasInterface ? -1 : 1) ||
      (a.versionOk === b.versionOk ? 0 : a.versionOk ? -1 : 1) ||
      b.guiCount - a.guiCount,
  )
  return { roots, mods }
}
spriteIdx.scanAll(scanEntries)
console.log(`  sprite ${spriteIdx.stats.sprites} 个(带贴图 ${spriteIdx.stats.withTexture}),${Date.now() - t0} ms`)

/* ── 贴图表:texId → 候选路径(模组优先) ── */
const texIds = new Map<string, string>()
const texTable = new Map<
  string,
  { rel: string; candidates: string[]; sprite?: string; noOfFrames?: number; type?: string }
>()
const texCache = new Map<
  string,
  | { w: number; h: number; png: string; scaled: boolean; format?: string; frames?: number; sprite?: string; rel?: string }
  | { error: string }
>()

/* 工作台默认应用图标(HOI4_icon.bmp 解码后的 PNG,懒加载缓存) */
let APPICON_PNG: Buffer | null = null

/* ★★★ TEX_ID_STABLE_V2:贴图内部 id 不再用 't' + texIds.size(依赖扫描顺序),
 *   改为按归一化路径做 sha1 截断哈希。原因:旧 id 是首见序号,后端重启 /
 *   rebuildIndexes 清空 texTable 后,磁盘缓存(tech_graph / dec_graph_*)
 *   里嵌的旧序号 id 与新表完全失配 → /api/tex?id=tXXX 全部 404,图标空白。
 *   哈希 id 只取决于贴图路径本身,跨重启 / 跨索引重建稳定。改这个版本号
 *   会让下面两个 graph 缓存签名变化 → 旧缓存自动失效重建。 */
const TEX_SCHEME = 'v2'

/* 由贴图归一化路径算出稳定 id(sha1 截断 12 位 hex)。
 *  同一物理贴图无论走 sprite 引用(texIdFor)还是前端直传路径(resolveTexId),
 *  归一化后 key 相同 → id 相同。 */
function texHash(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 12)
}

/* 磁盘缓存 hydrate 双恢复(TEX_HYDRATE_V1):graph 响应里嵌的内部 tex id(t<hash>)在重建阶段
 *   由 texIdFor 写入 texTable。但 tech/dec 的磁盘缓存 hydrate 走早返回、跳过重建,
 *   texTable 是空的 → /api/tex?id=<id> 全部 404(图标空白)。修复:把本 graph 响应
 *   实际引用到的 texTable 条目随缓存一起存,hydrate 时恢复 → 热重启后每个 t<hash> 都能命中。
 *   条目含 rel/candidates/sprite/noOfFrames/type(首见者优先),帧动画信息不丢。 */
type TexEntry = { rel: string; candidates: string[]; sprite?: string; noOfFrames?: number; type?: string }

/** 从 graph 响应 JSON 收集被引用的内部 tex id → texTable 条目(去重,首见者优先)。 */
function collectTexEntries(out: string): Record<string, TexEntry> {
  const map: Record<string, TexEntry> = {}
  const re = /"tex":"(t[0-9a-f]{12})"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) {
    const id = m[1]
    if (map[id]) continue
    const e = texTable.get(id)
    if (e) map[id] = e
  }
  return map
}

/** hydrate 时把收集到的条目写回 texTable(与重建阶段产物一致)。 */
function restoreTexEntries(tex?: Record<string, TexEntry>): void {
  if (!tex) return
  for (const [id, e] of Object.entries(tex)) texTable.set(id, e)
}

function texIdFor(def: SpriteDef): string | undefined {
  const tf = def.texturefile ?? def.textureFile1 ?? def.textureFile2
  if (!tf) return undefined
  const key = tf.toLowerCase()
  let id = texIds.get(key)
  if (!id) {
    id = 't' + texHash(key)
    texIds.set(key, id)
    texTable.set(id, {
      rel: tf,
      candidates: texCandidates(tf),
      // ★ 帧动画切帧要靠这两个字段:同一张贴图被不同 sprite 引用时,
      //   noOfFrames 可能不同(比如 GFX_foo 是 4 帧条,GFX_bar 引用同一图但只当 1 帧用)。
      //   所以帧信息挂在 texId 上时优先用 sprite 自己的,查不到再回退。
      sprite: def.name,
      noOfFrames: def.noOfFrames,
      type: def.type,
    })
  }
  return id
}

/**
 * ★★★ TEX_RESOLVE_V2:把前端传来的任意"贴图引用"解析成 texId。
 *
 * 背景(实测踩出来的):`/api/tex?id=` 原本只认 `t0/t1/...` 这种内部 id,
 * 而 designer 之外的页面(focus / tech / doctrines / dlc / decisions / mio)
 * 都是直接把数据文件里的 `GFX_xxx` 贴图名塞进 URL 的 —— 于是全部 404,
 * 图标一片空白。三个前端页面各自维护一份 loadTex 懒加载器,却都打不出一张图。
 *
 * 现在三种形态全部接受:
 *   1. `t123`            内部 id(designer / 属性网格用)
 *   2. `GFX_xxx`         sprite 名 → 查 spriteIdx 拿 texturefile
 *   3. `gfx/.../foo.dds` 原始贴图路径 → 直接建候选(即使它没被任何 sprite 引用)
 *
 * 另加 `name=` 别名:让 /api/tex 与"贴图名清单"共用一个查询参数名。
 */
function resolveTexId(raw: string): string | undefined {
  const id = raw.trim()
  if (!id) return undefined
  // 1) 已是内部 id
  if (texTable.has(id)) return id
  // 2) sprite 名
  const def = spriteIdx.get(id)
  if (def) {
    const t = texIdFor(def)
    if (t) return t
  }
  // 3) 原始贴图路径(含扩展名,或像 gfx/xxx/yyy 这样的目录形式)
  if (/[\\/]/.test(id) || /\.(dds|tga|png)$/i.test(id)) {
    // 去掉前导斜杠与 interface/ 前缀 —— .gfx 里写的是相对游戏根的路径,
    // 但前端有时会拼成 interface/gfx/... ;两种都归一化成同一个 key
    let tf = id.replace(/\\/g, '/').replace(/^\/+/, '')
    tf = tf.replace(/^interface\//i, '')
    if (!tf) return undefined
    const key = tf.toLowerCase()
    let tid = texIds.get(key)
    if (!tid) {
      tid = 't' + texHash(key)
      texIds.set(key, tid)
      texTable.set(tid, { rel: tf, candidates: texCandidates(tf) })
    }
    return tid
  }
  return undefined
}

/**
 * 同一路径的候选扩展名(TEX_EXT_FALLBACK_V1)。
 *
 * HOI4 的 texturefile 声明与实际文件扩展名不必一致:模组常把 vanilla 的
 * `foo.dds` 直接换成 `foo.png`(体积小得多),声明却照抄不改成 .png。
 * 引擎按 stem 找文件,dds/tga/png 都能命中 —— 之前我们只试声明的那个扩展名,
 * 于是这类替换的贴图 100% 加载失败(KR 的 aces 系列全是这种情况:
 * 声明 gfx/aces/ace_none.dds,模组只提供 CAN_ace_*.png)。
 *
 * 顺序:先按声明的原扩展名(尊重作者显式指定),再 dds → tga → png。
 * 外层再叠 root 顺序(模组优先),两层顺序相乘得到完整优先级。
 */
const TEX_EXTS = ['.dds', '.tga', '.png'] as const

/** DLC 目录(含 interface),texCandidates 把它们当基础游戏后的覆盖层 */
let DLC_DIRS: string[] = []

function texCandidates(tf: string): string[] {
  const dot = tf.lastIndexOf('.')
  const stem = dot > 0 ? tf.slice(0, dot) : tf
  const declared = dot > 0 ? tf.slice(dot).toLowerCase() : ''
  const exts = TEX_EXTS.includes(declared as (typeof TEX_EXTS)[number])
    ? [declared, ...TEX_EXTS.filter((e) => e !== declared)]
    : [...TEX_EXTS]
  const out: string[] = []
  for (let i = ROOTS.length - 1; i >= 1; i--) {
    for (const e of exts) out.push(join(ROOTS[i].path, stem + e))
  }
  for (const d of DLC_DIRS) for (const e of exts) out.push(join(d, stem + e))
  if (ROOTS.length) for (const e of exts) out.push(join(ROOTS[0].path, stem + e))
  return out
}

/* ── 跨域引用图(interface ↔ scripted_guis / focus_inlay_windows / decisions …) ──
 * 构建要扫几千个文件,放在监听之后异步做,避免启动被卡住。
 */
let LINK: LinkGraph | null = null
let LINK_ERR = ''
let LINK_BUSY = false

/* ★ PERF_V3:/api/stats 的 .gui 计数缓存(见 /api/stats 处的说明) */
let GUI_COUNT = -1
let GUI_COUNT_KEY = ''

/* ★ PERF_V3(2026-10-05):重活串行队列。
 *
 * 起因(实测):启动/重载时 8 个 ensure* 一起点火,每个都是秒级同步长任务,
 * 大家一起挤在 setImmediate 队列里互相抢 CPU —— 单个从真实 1.7s 被拖到
 * 8~13s,而且期间 HTTP 请求成批超时(探活 /api/stats 连续 5 秒拿不到响应),
 * 就是用户说的"运行时比较卡顿"。
 *
 * 做法:所有重活排成一条队,一次只跑一个,任务之间用 setImmediate 让出主线程。
 * 总 CPU 时间不变,但①单个任务回到真实耗时 ②任务之间留出响应窗口,
 * 点击导航/外观/设置这类轻请求能插进来。 */
/* ★★ BOOT_GATE_V1:全局加载进度(前端"进度圈遮罩"轮询 /api/status)。
 * 由 runHeavy 队列驱动:总任务数 total 累计,完成的计 done,队列清空即 ready。 */
/* ★★ BOOT_STAGE_V2(2026-10-18,优化3):BUILD 上加阶段维度。
 * 旧字段 building/phase/done/total/since 全部保留(splash 旧逻辑照常用);
 * 新增 stages:forceBuildAll 把构建任务按阶段分组登记,/api/status 据此
 * 回报「阶段 i/N:名称」+ 当前阶段子进度。并行任务在登记时记下自己属于哪个阶段,
 * 与"哪个先跑完"无关 —— 并行不影响阶段归属。 */
interface BuildStage { name: string; done: number; total: number }
const BUILD: { building: boolean; phase: string; done: number; total: number; since: number; stages: BuildStage[] } =
  { building: false, phase: '', done: 0, total: 0, since: 0, stages: [] }
/* 当前正在登记的阶段下标;forceBuildAll 用 beginStage 切换。-1 = 不在任何阶段里
 * (运行期按需触发的 ensure* 不计入启动阶段,只动旧的 done/total)。 */
let CUR_STAGE_IDX = -1
/** 开启一个新的构建阶段;之后登记的任务都计入它,直到下次 beginStage。 */
function beginStage(name: string): void {
  CUR_STAGE_IDX = BUILD.stages.length
  BUILD.stages.push({ name, done: 0, total: 0 })
}

const HEAVY_Q: { name: string; fn: () => void | Promise<void> }[] = []
let HEAVY_RUNNING = false

/**
 * ★★ PARALLEL_V2(2026-10-17):重活分两类队列。
 *
 *   runHeavy    (串行):任务体真的在主线程跑同步大循环(体检、符号库、字段统计…),
 *                同时只能有一个 —— 队列存在的全部意义就是别让它们互相抢 CPU。
 *   runHeavyPar (并行):任务体只是【等一个 worker 回话】,主线程全程空闲,
 *                它们之间没有资源冲突,串行反而是纯浪费。
 *
 * 为什么以前不区分:那时所有 ensure* 都是主线程同步任务,只能串行。
 * 搬进 worker 后如果还串行,worker 池就是摆设 ——
 * 引用图(5.6s)会挡住科技图(0.4s),总时间一点不省。
 * 这就是"全部搬进 worker"必须同时改队列的原因:只改一半等于没改。
 *
 * 旧注释里"并行化曾把本地化从 7.5s 拖到 27s"那条教训依然成立,
 * 但它的根因是【两个分片任务在主线程上交错】(都抢同一个线程)。
 * 现在本地化唯一的重活(合并)在主线程、且严格按批号顺序执行,
 * 读+解析在 worker —— 那条教训的前提已不复存在。
 */
function runHeavy(name: string, fn: () => void | Promise<void>): void {
  BUILD.total++
  HEAVY_Q.push({ name, fn })
  void pumpHeavy()
}

/** 正在飞的并行任务数 */
let PAR_INFLIGHT = 0

/** 并行任务全部收工、串行队列也空了,才允许把 BUILD 复位 */
function maybeFinishBuild(): void {
  if (HEAVY_Q.length || HEAVY_RUNNING || PAR_INFLIGHT > 0) return
  BUILD.building = false
  BUILD.phase = ''
  BUILD.done = 0
  BUILD.total = 0
  BUILD.stages = []
  CUR_STAGE_IDX = -1
}

/** 并行点火:立刻开跑,不排队、不等前一个(主线程不参与,无冲突)。 */
function runHeavyPar(name: string, fn: () => void | Promise<void>): void {
  BUILD.total++
  PAR_INFLIGHT++
  if (!BUILD.building) {
    BUILD.building = true
    BUILD.since = Date.now()
  }
  /* 登记那一刻记下阶段下标 —— 与该任务将来何时完成无关 */
  const si = CUR_STAGE_IDX
  if (si >= 0 && BUILD.stages[si]) BUILD.stages[si].total++
  void (async () => {
    try {
      BUILD.phase = name
      console.log('  开始构建(并行): ' + name)
      await fn()
    } catch (e) {
      console.log(`  [警告] ${name} 构建异常: ${e}`)
    }
    BUILD.done++
    if (si >= 0 && BUILD.stages[si]) BUILD.stages[si].done++
    /* ★ 收敛条件比串行队列复杂:并行任务不占 HEAVY_Q,
     *   所以「队列空了」不等于「都跑完了」。用 PAR_INFLIGHT 兜底,
     *   否则前端进度圈会在还有任务在跑时提前撤掉。 */
    PAR_INFLIGHT--
    maybeFinishBuild()
  })()
}

/** 队列泵:一次只跑一个主线程任务,跑完(await 到底)再取下一个。 */
async function pumpHeavy(): Promise<void> {
  if (HEAVY_RUNNING) return
  HEAVY_RUNNING = true
  BUILD.building = true
  BUILD.since = Date.now()
  if (BUILD.total <= 0) BUILD.total = 0
  // 先让出一轮:确保点火它的那个 HTTP 响应(ready:false,busy:true)已经发出去了
  await new Promise<void>((done) => setImmediate(done))
  try {
    while (HEAVY_Q.length) {
      const job = HEAVY_Q.shift()!
      BUILD.phase = job.name
      try {
        console.log('  开始构建: ' + job.name)
        // ★ 必须 await:主线程任务可能是 async 分片,不 await 它刚让出主线程
        //   队列就认为"做完了"接着跑下一个 —— 实测两大任务交错把本地化
        //   从 7.5s 拖到 27s。串行队列的语义是「一次一个,跑完再下一个」。
        await job.fn()
      } catch (e) {
        console.log(`  [警告] ${job.name} 构建异常: ${e}`)
      }
      BUILD.done++
      await new Promise<void>((done) => setImmediate(done))
    }
  } finally {
    HEAVY_RUNNING = false
    BUILD.phase = ''
    maybeFinishBuild()
  }
}

/* ★★ BOOT_GATE_V1:主动触发"全量加载" —— 模组开关/导入模组/冷启动后,
 * 把核心图全部排入 HEAVY 队列一次构建完;期间前端进度圈遮罩挡住工作台,
 * 队列清空(ready)才放行。体检(ensureCheck)与地图按需懒建,不在此列。 */
function forceBuildAll(): void {
  /* BOOT_STAGE_V2:阶段分组。本地化是启动期最慢的一块(实测 ~6s),
   * 单独成第一阶段;其余 11 张内容图互不依赖、一起进 worker 池并行,
   * 归「内容图构建」一个阶段。 */
  beginStage('本地化索引')
  ensureLoc(true)
  beginStage('内容图构建')
  ensureEvents(); ensureFocus(); ensureTech(); ensureDecisions(); ensureDoctrines()
  ensureDlc(); ensureAiBehavior(); ensureDefines(); ensureMio()
  ensureMusic()
  /* ★ 引用图(ensureLinks)移出启动队列(2026-10-20):其 sig 每次重扫 interface+gfx
   * 实测 ~15s,会把 /api/status 的 ready 拖到 15s+,导致主窗口加载动画等太久。
   * 改为懒建(首次访问引用图接口时 ensure+busy 提示,前端已有 !ready→轮询),
   * 与符号库同理 —— 用户日常不点引用图,不应为它等 15 秒。 */
  // ensureLinks()
  /* ★★ 符号库【不】在启动队列里点火(2026-10-10)。
   * 它实测要 88 秒(507376 定义),而且是同步大循环 —— 期间 Node 事件循环
   * 被占满,/api/status 连续 5 秒超时无响应,整个工作台"点什么都没反应"。
   * 它只服务 IDE 的补全/跳转(/api/complete、/api/symbols),这两处本来就有
   * ensureSymbols() 按需点火 + building 提示,挪出去不影响任何功能,
   * 只是把 88 秒的等待从"每次启动都卡住全站"变成"用补全时才等一次"。 */
}

/* PERF_ASYNC_V1(2026-10-04):以下所有 ensure* 与 ensureCheck 同一模式 ——
 * 重活放进 setImmediate,先让 HTTP 响应(ready:false,busy:true)出去。
 * 原来是同步构建:首个访问某页的请求会把事件循环堵住几秒,
 * 期间导航/外观/设置/贴图等所有接口一起超时(用户报"整体响应慢")。
 * 前端各页本来就有 !d.ready → setTimeout 轮询的逻辑(与体检页同一套),无需改。 */
function ensureLinks(): LinkGraph | null {
  if (LINK) return LINK
  if (LINK_BUSY) return null
  LINK_BUSY = true
  /* ★ CACHE_V1(2026-10-09):磁盘缓存免冷启动重建 —— 引用图是冷启动大块。
   * 签名扫描与 hydrate 都放 runHeavy(await 让出主线程),首个请求返回 busy,
   * 前端已有 !ready→轮询 机制。签名用 dirSigAsync(并行 stat)把 16.5s 压下来。 */
  runHeavyPar('引用图', async () => {
    const t = Date.now()
    try {
      const _ts0 = Date.now()
      const sig = await linkCacheSigAsync()
      const _ts1 = Date.now()
      const cached = loadCache<{ roots: LinkRoot[]; defs: SymDef[]; refs: SymRef[]; defIndex: [string, SymDef[]][]; refIndex: [string, SymRef[]][]; dangling: SymRef[]; stats: LinkGraph['stats'] }>('links', sig)
      const _ts2 = Date.now()
      if (cached) {
        LINK = {
          roots: cached.roots,
          defs: cached.defs,
          refs: cached.refs,
          defIndex: deMap(cached.defIndex),
          refIndex: deMap(cached.refIndex),
          dangling: cached.dangling,
          stats: cached.stats,
        }
        const _ts3 = Date.now()
        console.log(`  引用图(缓存命中): ${LINK.stats.defs} 定义 / ${LINK.stats.refs} 引用,hydrate ${Date.now() - t} ms(sig ${_ts1 - _ts0}ms load ${_ts2 - _ts1}ms demap ${_ts3 - _ts2}ms)`)
      } else {
        /* PARALLEL_V2(2026-10-17):改走 worker 池。
         * 引用图是启动阶段第二大的块(实测 5609ms 主线程 / 20.0MB / 克隆 135ms),
         * 而且【必须在符号库之前建好】—— 符号库要 mergeLinkGraph。
         * 搬进 worker 后主线程不再被堵 5.6 秒,音乐取流与 /api/status 全程有响应。
         *
         * ★ 缓存逻辑(签名/hydrate/落盘)仍留在主线程:它摸的是 cache.ts 的磁盘
         *   状态,搬进 worker 会让「构建」与「缓存」两个关注点耦在一起,
         *   且 cache 目录是运行期才有的(DATA_ROOT 由环境变量注入)。 */
        const r = await runInWorker({ kind: 'links', roots: srcRoots() })
        const g = r.data as unknown as LinkGraph
        LINK = g
        if (r.where === 'main') console.log('  [并行] worker 不可用,引用图回落主线程')
        saveCache('links', sig, {
          roots: g.roots,
          defs: g.defs,
          refs: g.refs,
          defIndex: serMap(g.defIndex),
          refIndex: serMap(g.refIndex),
          dangling: g.dangling,
          stats: g.stats,
        })
        console.log(
          `  引用图就绪: ${LINK.stats.defs} 定义 / ${LINK.stats.refs} 引用 / ${LINK.stats.dangling} 悬空,${Date.now() - t} ms(已写缓存,${r.where})`,
        )
      }
    } catch (e) {
      LINK_ERR = String(e)
      console.log(`  引用图构建失败: ${LINK_ERR}`)
    }
    LINK_BUSY = false
  })
  return null
}

/** 引用图来源签名:扫描各来源 interface + gfx 目录(引用图输入就是这些),并行 stat */
async function linkCacheSigAsync(): Promise<string> {
  const dirs: string[] = []
  for (const r of ROOTS) {
    dirs.push(join(r.path, 'interface'))
    dirs.push(join(r.path, 'gfx'))
  }
  return dirSigAsync(dirs)
}

/* ★ IMAGE_ASSET_V1:图像素材识别。
 *
 * IDE 原来只把文件当 UTF-8 文本打开,于是点开 interface/gfx/**.dds
 * 得到的是一堆乱码(还可能因为 0x00 字节被浏览器替换成 U+FFFD),
 * 用户诉求"IDE 下应该也能读取图像素材"就是这个。
 *
 * HOI4 的贴图实测只有三种格式(见 TEX_EXTS),外加 .bmp/.jpg 便于
 * 模组作者放参考图。这里只做识别与路由,**不新增解码器** ——
 * dds.ts / png.ts 已经在 /api/tex 链路上跑通了,直接复用。
 */
const IMAGE_EXTS = new Set(['.dds', '.tga', '.png', '.bmp', '.jpg', '.jpeg'])
function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext)
}
function typeOf(ext: string): string {
  if (ext === '.gui') return 'gui'
  if (ext === '.gfx') return 'gfx'
  if (ext === '.txt') return 'txt'
  if (ext === '.yml' || ext === '.yaml') return 'yml'
  if (ext === '.csv') return 'csv'
  if (ext === '.lua') return 'lua'
  // ★ IMAGE_ASSET_V1:图像单独一类,前端据此切到预览而不是文本视图
  if (isImageExt(ext)) return 'img'
  return 'other'
}
function langOf(ext: string): string {
  if (ext === '.gui' || ext === '.gfx' || ext === '.txt') return 'clausewitz'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  if (ext === '.lua') return 'lua'
  if (isImageExt(ext)) return 'image'
  return 'text'
}

/* ── IMAGE_ASSET_V1:把图像文件读成可直接 <img src> 的 data URL ──
 *
 * 复用 /api/tex 的解码链路(dds.ts 的 decodeImage + png.ts 的 encodePng),
 * 不另写一套解码 —— 两处格式支持若有分叉,必然出现"IDE 里能看、图标却裂"。
 *
 * 两个实战取舍:
 *  ① dds 的宽高在**文件头**(offset 12/16)就能读到,不必完整解码。
 *    4096×4096 的贴图解码一次要几百毫秒,IDE 里连续点开多张会明显卡。
 *    所以先用 readDdsSize 快速拿尺寸,让 UI 能先把占位框画出来。
 *  ② 超大图按 2M 像素降采样(与 /api/tex 同一阈值),避免把 64MB 的
 *    base64 塞进 JSON —— 那会让一次点击卡住整个标签页。
 */
function readImageAsset(abs: string, rel: string): {
  format: string
  w: number
  h: number
  frames: number
  png: string | null
  error?: string
} {
  const ext = extname(abs).toLowerCase()
  let buf: Buffer
  try {
    buf = readFileSync(abs)
  } catch (e) {
    return { format: ext.replace(/^\./, ''), w: 0, h: 0, frames: 1, png: null, error: `读取失败: ${String(e)}` }
  }
  // jpg/jpeg 浏览器原生能显示,不必解码重编码 —— 直接回 data URL
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
    return {
      format: ext.replace(/^\./, ''),
      w: 0,
      h: 0,
      frames: 1,
      png: buf.toString('base64'),
    }
  }
  let quick: { w: number; h: number } | null = null
  if (ext === '.dds') {
    try {
      quick = readDdsSize(buf)
    } catch {
      quick = null
    }
  }
  try {
    const r = decodeImage(buf, ext)
    if (!r.ok || !r.bitmap) {
      return {
        format: r.format,
        w: quick?.w ?? 0,
        h: quick?.h ?? 0,
        frames: 1,
        png: null,
        error: r.error ?? `解码失败(${rel})`,
      }
    }
    const src = r.bitmap
    const ds = downscaleIfNeeded(src.rgba, src.w, src.h, 2_000_000)
    const png = encodePng(ds.rgba, ds.w, ds.h)
    return {
      format: r.format,
      w: src.w,
      h: src.h,
      frames: 1,
      png: png.toString('base64'),
    }
  } catch (e) {
    return {
      format: ext.replace(/^\./, ''),
      w: quick?.w ?? 0,
      h: quick?.h ?? 0,
      frames: 1,
      png: null,
      error: `解码异常: ${String(e)}`,
    }
  }
}
/**
 * 归一化「文件操作」入参:挡住 join(path, null) 触发的 ERR_INVALID_ARG_TYPE。
 *  - root 必须是 ROOTS 的合法下标(「全部来源」的 -1 在此被拒绝);
 *  - file 必须是非空字符串,且必须落在该 root 之内。
 * 返回 null 表示合法,否则返回可直接回给前端的错误信息。
 */
function badFileReq(rootIdx: unknown, file: unknown): string | null {
  if (typeof rootIdx !== 'number' || !Number.isInteger(rootIdx) || rootIdx < 0 || rootIdx >= ROOTS.length) {
    return '无效的来源序号:请先在上方选择一个具体的游戏或模组目录(不能是「全部来源」)'
  }
  if (typeof file !== 'string' || !file.trim()) {
    return '尚未载入文件:请先在文件下拉框里选择一个 .gui 文件,再进行编辑'
  }
  if (!safeJoin(ROOTS[rootIdx].path, file)) return '文件路径超出该来源目录范围'
  const abs = join(ROOTS[rootIdx].path, file)
  if (!existsSync(abs)) return `文件不存在: ${file}`
  return null
}

/** 同 badFileReq,但允许文件**尚不存在**(新建文件场景) */
function badFileReqNoExist(rootIdx: unknown, file: unknown): string | null {
  if (typeof rootIdx !== 'number' || !Number.isInteger(rootIdx) || rootIdx < 0 || rootIdx >= ROOTS.length) {
    return '无效的来源序号:请选择一个具体的游戏或模组目录'
  }
  if (typeof file !== 'string' || !file.trim()) return '缺少文件路径'
  if (!safeJoin(ROOTS[rootIdx].path, file)) return '文件路径超出该来源目录范围'
  return null
}

/** 路径穿越防护:rel 必须落在 rootPath 之内 */
function safeJoin(rootPath: string, rel: string): string | null {
  const abs = join(rootPath, rel)
  const norm = abs.replace(/\\/g, '/')
  const rootNorm = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  if (norm !== rootNorm && !norm.startsWith(rootNorm + '/')) return null
  return abs
}
function blockType(doc: Document, block: Block): string {
  for (const e of block.entries) {
    const k = keyText(doc, e)
    if (k && e.value < 0 && !e.block) return k
  }
  return 'block'
}

let SYM: SymbolRegistry | null = null
let SYM_BUSY = false
let SYM_ERR = ''
function ensureSymbols(): SymbolRegistry | null {
  if (SYM) return SYM
  if (SYM_BUSY) return null
  SYM_BUSY = true
  const t = Date.now()
  runHeavy('符号库', () => {
    try {
      const reg = new SymbolRegistry()
      reg.buildFast(srcRoots())
      /* 符号库依赖引用图;ensureLinks 现在是异步的(拿不到就返回 null),
       * 所以这里需要时直接现建 —— 反正 LINK 为空说明它还没被建过。 */
      if (!LINK) {
        try {
          LINK = buildLinkGraph(srcRoots(), { sprites: false })
        } catch { /* 引用图失败不拦着符号库 */ }
      }
      if (LINK) reg.mergeLinkGraph(LINK)
      SYM = reg
      console.log(`  符号库就绪: ${SYM.stats.defs} 定义 / ${SYM.stats.refs} 引用, ${Date.now() - t} ms`)
    } catch (e) {
      SYM_ERR = String(e)
      console.log(`  符号库构建失败: ${SYM_ERR}`)
    }
    SYM_BUSY = false
  })
  return null
}

/* ── 国策树图 ──
 * 同样要扫几千个文件,异步构建。
 */
let FG: FocusGraph | null = null
let FG_ERR = ''
let FG_BUSY = false

function ensureFocus(): FocusGraph | null {
  if (FG) return FG
  if (FG_BUSY) return null
  FG_BUSY = true
  const t = Date.now()
  /* ★ CACHE_V1(2026-10-09):国策图 1.7s 是冷启动次大块,来源签名没变直接 hydrate 缓存。 */
  const sig = focusCacheSig()
  const cached = loadCache<FocusCacheData>('focus', sig)
  if (cached) {
    FG = {
      roots: cached.roots,
      trees: cached.trees,
      nodes: deMap(cached.nodes),
      byId: deMap(cached.byId),
      versions: deMap(cached.versions),
      defs: deMap(cached.defs),
      sharedIds: cached.sharedIds,
      jointIds: cached.jointIds,
      cycles: cached.cycles,
      danglingRel: cached.danglingRel,
      danglingLink: cached.danglingLink,
    }
    console.log(`  国策图(缓存命中): ${FG.trees.length} 树 / ${FG.nodes.size} 国策,hydrate ${Date.now() - t} ms`)
    FG_BUSY = false
    return FG
  }
  runHeavyPar('国策图', async () => {
    try {
      /* PARALLEL_V1(2026-10-17):改走 worker 池。
       * 原来在这里直接调 buildFocusGraph —— 它是同步大循环,会把 server 主线程
       * 占满。而音乐播放是 `audio.src='/api/music/audio'` 从本后端取流,
       * 主线程被占住 → 音频请求排不上队 → 缓冲断流 → 「加载国策树时音乐卡住」。
       * 放进 worker 后主线程全程可响应 HTTP,UI 与音频都不再被堵。 */
      const r = await runInWorker({ kind: 'focus', roots: srcRoots() })
      FG = r.data as unknown as FocusGraph
      if (r.where === 'main') console.log('  [并行] worker 不可用,国策图回落主线程')
      saveCache('focus', sig, {
        roots: FG.roots,
        trees: FG.trees,
        nodes: serMap(FG.nodes),
        byId: serMap(FG.byId),
        versions: serMap(FG.versions),
        defs: serMap(FG.defs),
        sharedIds: FG.sharedIds,
        jointIds: FG.jointIds,
        cycles: FG.cycles,
        danglingRel: FG.danglingRel,
        danglingLink: FG.danglingLink,
      })
      console.log(
        `  国策图就绪: ${FG.trees.length} 树 / ${FG.nodes.size} 国策(共享 ${FG.sharedIds.length} 联合 ${FG.jointIds.length}),${Date.now() - t} ms(已写缓存)`,
      )
    } catch (e) {
      FG_ERR = String(e)
      console.log(`  国策图构建失败: ${FG_ERR}`)
    }
    FG_BUSY = false
  })
  return null
}

/** 国策图来源签名:扫描各来源 common/national_focus */
function focusCacheSig(): string {
  const dirs: string[] = []
  for (const r of ROOTS) dirs.push(join(r.path, 'common', 'national_focus'))
  return dirSig(dirs)
}

/** FocusGraph 序列化载荷(所有 Map 已转 entries,hydrate 时 deMap 还原) */
interface FocusCacheData {
  roots: FocusRoot[]
  trees: FocusTree[]
  nodes: [string, FocusNode][]
  byId: [string, FocusTree][]
  versions: [string, { root: number; file: string; line: number }[]][]
  defs: [string, { root: number; file: string; line: number }[]][]
  sharedIds: string[]
  jointIds: string[]
  cycles: string[][]
  danglingRel: { id: string; rel: string; file: string; line: number; via: string[] }[]
  danglingLink: { id: string; target: string; kind: string; file: string; line: number }[]
}

/* ── 游戏规则默认值(GAMERULE_DEFAULT_V1)──
 * has_game_rule 叶子求值要按各规则的「默认选项」:如 obsolete_focus_branches_visibility
 * 的默认是 HIDE,那 allow_branch = has_game_rule ... HIDE 默认应判 true(国策该显示),
 * 但旧版把"未勾选的游戏规则"一律判 false → 这类国策被误隐藏。
 * 解析 ROOTS(基础+模组,后挂载覆盖前)下 common/game_rules/*.txt 的 default 块。 */
let GR_DEFAULTS: Record<string, string> | null = null
function loadGameRuleDefaults(): Record<string, string> {
  if (GR_DEFAULTS) return GR_DEFAULTS
  const out: Record<string, string> = {}
  for (const root of ROOTS) {
    const dir = join(root.path, 'common', 'game_rules')
    if (!existsSync(dir)) continue
    let files: string[]
    try { files = readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.txt')) } catch { continue }
    for (const f of files) {
      let doc: Document
      try { doc = parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
      walkBlocks(doc, (b, path) => {
        if (path.length !== 1) return
        const def = b.entries.find((e) => keyText(doc, e) === 'default' && e.block)
        if (!def || !def.block) return
        const nm = def.block.entries.find((e) => keyText(doc, e) === 'name')
        if (!nm) return
        const v = valueText(doc, nm)
        if (v) out[path[0]] = v
      })
    }
  }
  GR_DEFAULTS = out
  return out
}

/* ── 模组体检报告(validate)──
 * 复用已建好的 spriteIdx 作为图标名集合,避免重复扫 gfx/interface。
 * 首次请求时异步计算并缓存。
 */
let CHECK: ValidationReport | null = null
let CHECK_ERR = ''
let CHECK_BUSY = false

let CHECK_PROGRESS = { done: 0, total: 0, phase: '' }

/* ── MOD_SCOPE_V1 · 体检目标 ──
 *
 * 用户诉求:「体检」要能只检查某一个模组,而不是每次都出 vanilla+全部模组的报告。
 *
 * 目标怎么表达:**用来源名(root.name)**,不用路径。
 *   - validateRoots 的 scope 是按 root.name 过滤问题归属的
 *   - 路径是用户可见的、但会随移动/重装变化;名字来自 .mod 的 name 字段,稳定
 *   - 重复的 name 会被拒绝(见 setCheckTarget),否则报告范围会含混
 *
 * 为什么目标模组**不在 ROOTS 里也能查**:
 *   ROOTS 是"工作台当前挂载的来源",用于跨文件导航 / 写回。
 *   体检是**只读**操作,用户完全可能想查一个没挂载的模组
 *   (比如刚下载还没决定要不要用)。所以体检维护自己的一份 root 列表:
 *   `CHECK_ROOTS = ROOTS + 目标模组`,不污染 ROOTS、不影响写回与索引。
 *
 * ⚠ CHECK_ROOTS 与 ROOTS 不同步的**已知取舍**:切目标只重建 CHECK_ROOTS,
 *   不重建 ROOTS —— 挂载列表变了走 rebuildIndexes()(那里会 resetValidateCache)。
 *   代价:目标模组若是"刚被挂载的同一个目录",两处都会用到它,
 *   但 rebuildCheckRoots 会先按路径去重,不会重复扫描。
 */
interface CheckRootSpec {
  name: string
  path: string
  /** 是否已挂载(未挂载的目标模组只参与体检,不进工作台索引) */
  mounted: boolean
  /** 元信息(仅目标模组会带,用于前端展示) */
  info?: ModInfo
}

let CHECK_ROOTS: CheckRootSpec[] = []
/** 当前体检目标;null = 全量体检(所有已挂载来源) */
let CHECK_TARGET: CheckRootSpec | null = null
/** 目标选择出错时的提示(路径不存在 / 名字冲突等) */
let CHECK_TARGET_ERR = ''

/**
 * ★ 世代号:防止过期任务覆盖新结果。
 *
 *   换目标时如果上一轮体检还在跑(全量要 30 秒,而用户很可能立刻换目标),
 *   旧任务完成时会把 `CHECK` 写成**旧目标**的报告,而 `CHECK_BUSY` 还为 true,
 *   于是 ensureCheck() 直接返回那份过期报告 —— 页面显示的是上一个模组的体检。
 *   而且因为 CHECK 非 null,再也不会重算,这个错误会一直挂着。
 *
 *   做法:每次重算领一个世代号,写回前先核对还是不是当前世代。
 */
let CHECK_GEN = 0

/** 路径等价比较(Windows 友好)。
 *
 * ⚠ 不能直接 `a.toLowerCase() === b.toLowerCase()`:
 *   resolve() 会把 `C:/foo/bar` 规范成 `C:\foo\bar`(分隔符变了),
 *   而 ROOTS 里的路径是按用户输入原样存的(可能是正斜杠)。
 *   实测踩过:已挂载的 Kaiserreich 被当成"另一个模组"重复加了一份,
 *   体检范围里同时出现 `Kaiserreich` 和 `Kaiserreich (1521695605)`。
 *
 * 所以统一:转小写 + 分隔符归一 + 去掉尾部斜杠。
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/** 目标路径 → 体检 root 名,避免同名导致报告范围含混 */
function checkRootNameFor(dir: string): string | null {
  const mi = readModInfo(dir)
  const raw = (mi.name || basename(dir)).trim()
  if (!raw) return null
  // 与已有来源重名 → 加目录名后缀;仍冲突就加序号,保证唯一
  let name = raw
  const taken = new Set(CHECK_ROOTS.map((r) => r.name))
  if (taken.has(name)) {
    const withDir = `${raw} (${basename(dir)})`
    name = withDir
    for (let i = 2; taken.has(name); i++) name = `${withDir} #${i}`
  }
  return name
}

/** 重建体检的来源列表 = 已挂载来源 + 目标模组(未挂载时),按路径去重 */
function rebuildCheckRoots(): void {
  const out: CheckRootSpec[] = []
  const seen = new Set<string>()
  const key = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase()
  for (const r of ROOTS) {
    const k = key(r.path)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ name: r.name, path: r.path, mounted: true })
  }
  if (CHECK_TARGET && !seen.has(key(CHECK_TARGET.path))) out.push(CHECK_TARGET)
  CHECK_ROOTS = out
}

/** 设定 / 清除体检目标 */
function setCheckTarget(dir: string | null): { ok: boolean; error?: string; target?: CheckRootSpec | null } {
  CHECK_ERR = ''
  CHECK_TARGET_ERR = ''
  if (!dir) {
    CHECK_TARGET = null
    rebuildCheckRoots()
    resetCheckReport()
    return { ok: true, target: null }
  }
  const abs = resolve(dir)
  if (!existsSync(abs)) {
    CHECK_TARGET_ERR = `目录不存在: ${abs}`
    return { ok: false, error: CHECK_TARGET_ERR }
  }
  if (!statSync(abs).isDirectory()) {
    CHECK_TARGET_ERR = `不是目录: ${abs}`
    return { ok: false, error: CHECK_TARGET_ERR }
  }
  const info = readModInfo(abs)
  // 一个模组目录至少得有 common/ 或 interface/ 或 localisation/ 之一,
  // 否则大概率是选错了(比如选到了 .mod 文件本身或某个子目录)
  const looksLikeMod =
    info.hasModFile ||
    existsSync(join(abs, 'common')) ||
    existsSync(join(abs, 'interface')) ||
    existsSync(join(abs, 'localisation'))
  if (!looksLikeMod) {
    CHECK_TARGET_ERR = `该目录不像模组(没有 .mod,也没有 common/ interface/ localisation/): ${abs}`
    return { ok: false, error: CHECK_TARGET_ERR }
  }
  const name = checkRootNameFor(abs)
  if (!name) {
    CHECK_TARGET_ERR = `无法确定模组名(目录名为空): ${abs}`
    return { ok: false, error: CHECK_TARGET_ERR }
  }
  // 已经挂载了 → 直接把它设为目标,不重复加一份
  const mounted = ROOTS.find((r) => samePath(r.path, abs))
  CHECK_TARGET = {
    name: mounted ? mounted.name : name,
    path: abs,
    mounted: !!mounted,
    info,
  }
  rebuildCheckRoots()
  resetCheckReport()
  return { ok: true, target: CHECK_TARGET }
}

/** 清掉已算好的报告,让下次 /api/check 重算。
 *  同时作废在途任务(靠世代号),避免旧目标的结果覆盖新目标。*/
function resetCheckReport(): void {
  CHECK = null
  CHECK_ERR = ''
  CHECK_BUSY = false
  CHECK_PROGRESS = { done: 0, total: 0, phase: '' }
  CHECK_GEN++
}

/**
 * ★ 体检改为【异步 + 进度回报】。
 *   实测 validateRoots(vanilla) 要 **33 秒**,原来同步跑 ——
 *   首个 /api/check 会把整个 Node 事件循环堵死 33 秒,期间导航/外观/设置
 *   等所有接口一起超时,表现就是"打开工程 / 体检特别卡"。
 *   现在:立刻返回 busy 让前端不被拖住,重活放到 setImmediate 里做。
 *
 * ★ MOD_SCOPE_V1:限定目标模组时,validateRoots 只报该模组的问题,
 *   但 vanilla 仍作为判定上下文(否则模组引用原版图标会全判悬空)。
 *   引擎侧按来源缓存扫描结果,切目标基本是拼装(实测 <1.5 s)。
 *
 * ★ 世代号:换目标时上一轮可能还在跑。写回结果前先核对世代,
 *   过期就直接丢弃 —— 否则旧目标的报告会被当成新目标的返回(见 CHECK_GEN 注释)。
 */
function ensureCheck(): ValidationReport | null {
  if (CHECK) return CHECK
  if (CHECK_BUSY) return null
  if (!CHECK_ROOTS.length) rebuildCheckRoots()
  CHECK_BUSY = true
  const t = Date.now()
  const myGen = ++CHECK_GEN
  // 快照:任务跑的这几十秒里用户完全可能换目标,不能到时候再读全局
  const scope = CHECK_TARGET ? [CHECK_TARGET.name] : undefined
  const targetName = CHECK_TARGET?.name
  const rootsSnap: CheckRoot[] = CHECK_ROOTS.map((r) => ({ name: r.name, path: r.path }))
  /* sprite 名集合必须覆盖**所有**参与判定的来源,包括未挂载的目标模组。
   *
   * spriteIdx 只扫了 ROOTS(= vanilla + 已挂载模组)的 interface/。
   * 目标模组若是**未挂载**的(体检支持查没挂载的模组),它的贴图不在里面,
   * 于是它自己定义的 GFX_xxx 会被判成悬空 —— 实测 Blackice 2876 条全是这种假警报。
   * 修法:目标未挂载时,额外扫它的 interface/ 并并进集合。
   * 已挂载的目标不用扫(spriteIdx 里已经有了)。*/
  const spriteSnap = new Set(spriteIdx.byName.keys())
  if (CHECK_TARGET && !CHECK_TARGET.mounted) {
    for (const n of scanSpriteNames([{ name: CHECK_TARGET.name, path: CHECK_TARGET.path }])) {
      spriteSnap.add(n)
    }
  }
  // 先把 HTTP 响应发出去(ready:false,busy:true),再开始重活
  runHeavy('体检', () => {
    // 世代已被换掉 → 有更新的任务在跑或即将跑,本轮结果作废
    if (myGen !== CHECK_GEN) {
      console.log(`  体检任务已作废(目标已切换):${targetName || '全量'}`)
      return
    }
    try {
      CHECK_PROGRESS = { done: 0, total: rootsSnap.length, phase: '扫描中' }
      const rep = validateRoots(rootsSnap, {
        spriteNames: spriteSnap,
        // 只限定时传 scope;全量体检不传,保持原行为
        ...(scope ? { scope } : {}),
        onProgress: (done: number, total: number, phase: string) => {
          // 进度也要核世代:换目标后不该再刷旧任务的进度
          if (myGen === CHECK_GEN) CHECK_PROGRESS = { done, total, phase }
        },
      })
      // 算的这几十秒里用户可能又换了目标 —— 结果作废,别写回
      if (myGen !== CHECK_GEN) {
        console.log(`  体检结果已作废(计算期间目标被切换):${targetName || '全量'}`)
        return
      }
      CHECK = rep
      console.log(
        `  体检报告就绪${targetName ? `[目标:${targetName}]` : '[全量]'}: ` +
          `${rep.stats.errors} 错误 / ${rep.stats.warnings} 告警,${Date.now() - t} ms`,
      )
    } catch (e) {
      if (myGen === CHECK_GEN) {
        CHECK_ERR = String(e)
        console.log(`  体检报告生成失败: ${CHECK_ERR}`)
      }
    }
    // 只有仍是当前世代才清 busy,否则会把新任务的 busy 抹掉
    if (myGen === CHECK_GEN) CHECK_BUSY = false
  })
  return null
}

/** 图标名 → /api/tex 的 id(复用已有的 dds 解码 + PNG 编码链路) */
function iconTexId(name: string): string | undefined {
  const def = spriteIdx.get(name)
  if (!def) return undefined
  return texIdFor(def)
}

/**
 * ★ TECHLAYOUT_GUI_V1:装备名 → 科技树图标贴图。
 *
 * 游戏里科技块无显式 icon 且 show_equipment_icon 时,按【当前国家】画装备图标:
 * interface/Technologies.gfx 里 spriteType 命名按国家(如 GFX_GER_infantry1_medium →
 * gfx/interface/technologies/GER_infantry_equipment_1.dds,SOV/FIN/ENG 同构)。
 * 工具无法覆盖全国家,固定用 GER 变体(与游戏默认国家一致)。
 *
 * 匹配规则:在全部 sprite 里找 texturefile 文件名以装备名为【完整段】(下划线边界)
 * 者;打分偏好:GER > SOV > 其他国家;路径含 technologies/tech 段;medium 变体。
 * 命中才返回,否则交给默认科技图标回退。
 */
function equipTexId(id: string, n: { equipList?: string[]; equipment?: string }): string | undefined {
  const names = new Set<string>()
  if (n.equipList) for (const e of n.equipList) if (e) names.add(e)
  if (n.equipment) names.add(n.equipment)
  if (id) names.add(id) // ★ 舰船/部分飞机:精灵按【科技 id】命名(GFX_early_destroyer_medium / GER_early_fighter)
  if (!names.size) return undefined
  let best: { score: number; def?: SpriteDef } | undefined
  for (const name of names) {
    const key = name.toLowerCase()
    if (!/^[a-z0-9_]+$/.test(key)) continue
    // 装备名常带版本号(light_tank_equipment_1 → 国家/通用变体只到 archetype_light_tank_equipment):
    // 依次尝试【原名 / 去尾版本号 / 再去 _equipment|_module】三段基准
    const bases = new Set<string>([key])
    const noNum = key.replace(/_\d+$/, '')
    if (noNum !== key) bases.add(noNum)
    const noEq = noNum.replace(/_(equipment|module)$/, '')
    if (noEq !== noNum) bases.add(noEq)
    const regexes = [...bases].map((b) => new RegExp('(^|_)' + b + '(_|$)'))
    const idKey = (id || '').toLowerCase()
    for (const [gfxName, def] of spriteIdx.byName) {
      const gn = gfxName.toLowerCase()
      // ★ 权威名是 sprite 名(GFX_xxx 去 gfx_ 前缀):贴图 basename 常是任意别名
      //   (GFX_GER_iw_small_airframe_medium → GER_early_fighter.dds;GFX_early_ship_hull_light_medium
      //   → early_destroyer.dds),游戏按 GFX 名查,故先匹配 gnCore,再匹配贴图 basename 兜底。
      const gnCore = gn.replace(/^gfx_/, '')
      const tf = (def.texturefile ?? def.textureFile1 ?? def.textureFile2 ?? '').toLowerCase()
      const seg = tf ? (tf.split('/').pop() ?? '').replace(/\.(dds|tga|png|bmp|jpg)$/, '') : ''
      let hit = false
      for (const re of regexes) if (re.test(gnCore) || (seg && re.test(seg))) { hit = true; break }
      if (!hit) continue
      let score = 0
      if (gn.startsWith('gfx_ger')) score += 6
      else if (gn.startsWith('gfx_sov')) score += 4
      else if (/^gfx_(fin|eng|fra|usa|ita|jap|pol|rom|spr|hun|swe|czl)/.test(gn)) score += 2
      else score += 1
      // 精灵名恰为 GFX_<科技id>_medium / GFX_GER_<科技id>_medium(舰船 hull / 飞机国家艺术):最高优先。
      // 精确形式(ger_fighter1_medium)才给 +3,避免 fighter1 平局误中 heavy_fighter1
      if (idKey && key === idKey && (gnCore === key + '_medium' || gnCore === 'ger_' + key + '_medium' || gnCore === 'sov_' + key + '_medium' || gnCore === key)) score += 3
      if (/technologies|_tech\//.test(tf)) score += 2
      if (/medium/.test(gn) || /medium/.test(seg)) score += 2
      if (gnCore.startsWith(key + '_') || gnCore.endsWith('_' + key) || seg.startsWith(key + '_') || seg.endsWith('_' + key)) score += 1
      if (!best || score > best.score) best = { score, def }
    }
  }
  if (!best?.def) return undefined
  return texIdFor(best.def)
}

/* ── 科技树图 ── */
let TG: TechGraph | null = null
let TG_ERR = ''
let TG_BUSY = false
function ensureTech(): TechGraph | null {
  if (TG) return TG
  if (TG_BUSY) return null
  TG_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2(2026-10-17):改走 worker 池。实测构建 357ms / 载荷 2.0MB /
   * 克隆 13ms —— 克隆远小于构建,搬过去净赚。 */
  runHeavyPar('科技图', async () => {
    try {
      const r = await runInWorker({ kind: 'tech', roots: srcRoots() })
      TG = r.data as unknown as TechGraph
      if (r.where === 'main') console.log('  [并行] worker 不可用,科技图回落主线程')
      console.log(`  科技图就绪: ${TG.nodes.size} 科技 / ${TG.edges.length} 边,${Date.now() - t} ms(${r.where})`)
    } catch (e) {
      TG_ERR = String(e)
      console.log(`  科技图构建失败: ${TG_ERR}`)
    }
    TG_BUSY = false
  })
  return null
}

/**
 * ★ 游戏内素材的「默认科技图标」精灵名(HOI4 真实默认值)。
 *   证据:interface/countrytechtreeview.gfx:1299
 *     spriteType = { name = "GFX_technology_medium"  textureFile = "gfx//interface//technologies//tank_icon.dds" }
 *   科技块上没有 icon 时,游戏科技树就是画这个精灵(实测 76x42)。
 *   ⚠ 曾尝试按 show_equipment_icon 解析装备图标,但 common/units/equipment/*.txt 里
 *     【没有 icon 字段】(45 个文件全查过),装备图标由游戏内部按 type 硬编码,无法从数据侧取到,
 *     故改为直接用这个真实存在的默认精灵。全库仅 5 文件 7 处用 show_equipment_icon,覆盖极低。
 */
const TECH_DEFAULT_ICON = 'GFX_technology_medium'


/* ── GEN_STATS_V1:内容生成器的真实字段统计(单一数据源的下游) ──
 *旧实现里生成器的字段表是手写镜像,和游戏真实结构漂移出5 处静默失效的硬错误
 * (equipment 少 s / decision 写不存在的 effect / ideas 缺 country 层 /
 *  country 的 factor 该 0 却写1 / 装备虚构 active={block=no})。
 * 现在判据来自实测扫描,所以这一段只做两件事:
 *   ①惰性建统计并注入 gen.setValidation() —— 让生成后能跑语义校验
 *   ②把 GEN_SCHEMA + 真实枚举下发前端 —— 表单不再自带镜像
 * 统计本身要扫 686 个文件 / 约 1.6 秒,所以懒加载 +缓存,不用则不建。 */
let FS: FieldStats | null = null
let FS_ERR = ''
let FS_BUSY = false

function ensureFieldStats(): FieldStats | null {
  if (FS) return FS
  if (FS_BUSY) return null
  FS_BUSY = true
  try {
    FS = buildFieldStats(srcRoots())
    setValidation({ stats: FS, scriptKeys: buildScriptKeyWhitelist(FS) })
    const summary = Object.entries(FS.kinds)
      .map(([k, v]) => `${k} ${v.entries}`)
      .join(' / ')
    console.log(`  生成器字段统计就绪: ${FS.files} 文件 / ${summary},${FS.ms} ms`)
  } catch (e) {
    FS_ERR = String(e)
    console.log(`  生成器字段统计失败(生成器将退化为只查语法): ${FS_ERR}`)
  } finally {
    FS_BUSY = false
  }
  return FS
}

/** 下发给前端的字段表:把 fieldstats 的真实枚举填进 schema 的 select 项 */
function genSchemaJson(): Record<string, unknown> {
  const stats = ensureFieldStats()
  const out: Record<string, unknown> = {}
  for (const [kind, sc] of Object.entries(GEN_SCHEMA) as [GenKind, GenSchema][]) {
    const ks = stats?.kinds[kind]
    const fields = sc.fields.map((f) => {
      const o: Record<string, unknown> = { ...f }
      // select 且来自真实枚举 → 填入实测取值(UI 展示前 60,total 给总数)
      if (f.type === 'select' && f.enumFrom && ks?.enums?.[f.enumFrom]) {
        const es = ks.enums[f.enumFrom]
        o.values = es.values.slice(0, 60)
        o.valueTotal = es.total
      }
      // 附带该类型条目层的真实字段表,供前端提示"这层还能写什么"
      if (ks) {
        o.realFields = ks.fields.slice(0, 40).map((x) => ({ key: x.key, n: x.n, block: !!x.isBlock, scalar: !!x.isScalar }))
      }
      return o
    })
    out[kind] = { ...sc, fields }
  }
  return out
}


/* ── 决议树图 ── */
let DG: DecisionGraph | null = null
let DG_ERR = ''
let DG_BUSY = false
function ensureDecisions(): DecisionGraph | null {
  if (DG) return DG
  if (DG_BUSY) return null
  DG_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 1705ms / 载荷 40.7MB / 克隆 166ms —— 搬得动。 */
  runHeavyPar('决议图', async () => {
    try {
      const r = await runInWorker({ kind: 'decisions', roots: srcRoots() })
      DG = r.data as unknown as DecisionGraph
      if (r.where === 'main') console.log('  [并行] worker 不可用,决议图回落主线程')
      console.log(`  决议图就绪: ${DG.categories.size} 分类 / ${DG.nodes.size} 决议,${Date.now() - t} ms(${r.where})`)
    } catch (e) {
      DG_ERR = String(e)
      console.log(`  决议图构建失败: ${DG_ERR}`)
    }
    DG_BUSY = false
  })
  return null
}

/* ── AI 行为(common/ai_*,AI_BEHAVE_V1)──
 * 与决议图同构:懒加载 + runHeavy。挂模组时文件数上千(实测 vanilla+KR 约 400
 * 文件 / 3000 条目),构建 0.3s,没必要预建。
 */
let AB: AiBehaviorModel | null = null
let AB_ERR = ''
let AB_BUSY = false
function ensureAiBehavior(): AiBehaviorModel | null {
  if (AB) return AB
  if (AB_BUSY) return null
  AB_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 986ms / 载荷 21.3MB / 克隆 166ms —— 搬得动。 */
  runHeavyPar('AI 行为', async () => {
    try {
      const r = await runInWorker({ kind: 'aibehave', roots: srcRoots() })
      AB = r.data as unknown as AiBehaviorModel
      if (r.where === 'main') console.log('  [并行] worker 不可用,AI 行为回落主线程')
      console.log(
        `  AI 行为就绪: ${AB.aspects.length} 方面 / ${AB.files} 文件 / ${AB.entries} 条目,${Date.now() - t} ms(${r.where})`,
      )
    } catch (e) {
      AB_ERR = String(e)
      console.log(`  AI 行为构建失败: ${AB_ERR}`)
    }
    AB_BUSY = false
  })
  return null
}

/* ── DLC 内容(DLC_V1)──
 * 四个玩法(军工机构/特殊工程/阵营/学说)统一懒加载。换来源时由 rebuildIndexes() 作废。
 * 架构在 engine/src/dlc.ts —— 声明式注册表,新 DLC 只需加一条记录。
 */
let DM: DlcModel | null = null
let DM_ERR = ''
let DM_BUSY = false
function ensureDlc(): DlcModel | null {
  if (DM) return DM
  if (DM_BUSY) return null
  DM_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 664ms / 载荷 4.1MB / 克隆 27ms。
   * ★ 它原来是启动阶段最长的【主线程】任务(端到端实测 4696ms),
   *   因为串行队列里它排在最前,且期间 8 个 worker 正在抢 CPU。搬走后不再挡路。 */
  runHeavyPar('DLC 内容', async () => {
    try {
      const gameDir = (ROOTS.find((r) => !r.writable) ?? ROOTS[0]).path
      const r = await runInWorker({
        kind: 'dlc',
        roots: srcRoots(),
        gameDir,
      })
      DM = r.data as unknown as DlcModel
      if (r.where === 'main') console.log('  [并行] worker 不可用,DLC 内容回落主线程')
      const parts = DM.featureOrder
        .map((id) => { const f = DM!.features.get(id)!; return `${f.label} ${f.stats.items}` })
        .join(' / ')
      console.log(`  DLC 内容就绪: ${parts},共 ${DM.installedDlc.length} 个 DLC,${Date.now() - t} ms(${r.where})`)
    } catch (e) {
      DM_ERR = String(e)
      console.log(`  DLC 内容构建失败: ${DM_ERR}`)
    }
    DM_BUSY = false
  })
  return null
}

/* ── defines(游戏平衡参数,Lua)── */
let DF: DefinesModel | null = null
let DF_ERR = ''
let DF_BUSY = false
function ensureDefines(): DefinesModel | null {
  if (DF) return DF
  if (DF_BUSY) return null
  DF_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 54ms / 载荷 5.8MB / 克隆 32ms。两者同量级但都极小,
   * 搬走主要是为了不给主线程留任何同步块。 */
  runHeavyPar('defines 参数', async () => {
    try {
      const r = await runInWorker({
        kind: 'defines',
        roots: srcRoots(),
      })
      DF = r.data as unknown as DefinesModel
      if (r.where === 'main') console.log('  [并行] worker 不可用,defines 回落主线程')
      console.log(
        `  defines 就绪: ${DF.entries.length} 条键值 / ${DF.byGroup.size} 个分组 / ${DF.files.length} 个文件, ${Date.now() - t} ms(${r.where})`,
      )
    } catch (e) {
      DF_ERR = String(e)
      console.log(`  defines 构建失败: ${DF_ERR}`)
    }
    DF_BUSY = false
  })
  return null
}

/* ── 学说系统(DOCTRINE_V1)── */
let DGR: DoctrineGraph | null = null
let DGR_LAYOUT: DoctrineLayout | null = null
let DGR_ERR = ''
let DGR_BUSY = false
function ensureDoctrines(): { g: DoctrineGraph; layout: DoctrineLayout } | null {
  if (DGR && DGR_LAYOUT) return { g: DGR, layout: DGR_LAYOUT }
  if (DGR_BUSY) return null
  DGR_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 125ms / 载荷 0.6MB / 克隆 5ms。
   * layoutDoctrines 也在 worker 里做 —— 它是纯排布计算,没理由留在主线程。 */
  runHeavyPar('学说', async () => {
    try {
      const r = await runInWorker({ kind: 'doctrines', roots: srcRoots() })
      const p = r.data as { g: DoctrineGraph; layout: DoctrineLayout }
      DGR = p.g
      DGR_LAYOUT = p.layout
      if (r.where === 'main') console.log('  [并行] worker 不可用,学说回落主线程')
      console.log(
        `  学说就绪: ${DGR.folders.size} 页签 / ${DGR.grand.size} 宏学说 / ${DGR.tracks.size} 轨道 / ${DGR.subdoctrines.size} 分支学说,${DGR.issues.length} 诊断,${Date.now() - t} ms(${r.where})`,
      )
    } catch (e) {
      DGR_ERR = String(e)
      console.log(`  学说构建失败: ${DGR_ERR}`)
    }
    DGR_BUSY = false
  })
  return null
}

/* ── 军工机构特质树(MIO_TREE_V1)── */
let MT: MioTree | null = null
let MT_ERR = ''
let MT_BUSY = false
function ensureMio(): MioTree | null {
  if (MT) return MT
  if (MT_BUSY) return null
  MT_BUSY = true
  const t = Date.now()
  /* PARALLEL_V2:实测构建 511ms / 载荷 30.6MB / 克隆 129ms —— 克隆占 1/4,
   * 仍有净赚(而且主线程那段 511ms 是连续同步的)。 */
  runHeavyPar('军工机构', async () => {
    try {
      const r = await runInWorker({ kind: 'mio', roots: srcRoots() })
      MT = r.data as unknown as MioTree
      if (r.where === 'main') console.log('  [并行] worker 不可用,军工机构回落主线程')
      console.log(
        `  军工机构就绪: ${MT.orgs.size} 机构 / ${MT.traits.size} 特质节点,${MT.issues.length} 诊断,${MT.ms} ms (总 ${Date.now() - t} ms,${r.where})`,
      )
    } catch (e) {
      MT_ERR = String(e)
      console.log(`  军工机构构建失败: ${MT_ERR}`)
    }
    MT_BUSY = false
  })
  return null
}

/* ── 本地化索引(LOCALISATION_V1)──
 * 语言多、文件多(vanilla 10 语言 × ~207 文件),所以跟其它图一样懒加载 + 缓存,
 * 换来源时由 rebuildIndexes() 作废。
 * ⚠ 不做"预生成快照":文件改了要能立刻看到,符合"实时"要求。
 */
let LOC: LocIndex | null = null

/* MUSIC_V1: build music index from all enabled sources' music dirs */
let MUSIC: MusicIndex | null = null
let MUSIC_BUSY = false
function ensureMusic(): MusicIndex | null {
  if (MUSIC) return MUSIC
  if (MUSIC_BUSY) return null
  MUSIC_BUSY = true
  /* PARALLEL_V2:实测构建 698ms / 载荷 0.9MB / 克隆 3ms —— 全场最划算的一档。
   * ★ 音乐索引尤其该搬:音乐播放走 /api/music/audio 从本后端取流,
   *   主线程被建索引占住 → 音频请求排不上队 → 「加载时音乐卡住」。 */
  runHeavyPar('MusicIndex', async () => {
    try {
      const r = await runInWorker({ kind: 'music', roots: srcRoots() })
      MUSIC = r.data as unknown as MusicIndex
      if (r.where === 'main') console.log('  [并行] worker 不可用,music index 回落主线程')
      console.log('  music index ready: ' + MUSIC.songs.length + ' songs / ' + MUSIC.stations.length + ' stations / ' + MUSIC.files + ' files, ' + MUSIC.ms + ' ms (' + r.where + ')')
    } catch (e) {
      console.error('  music index failed: ' + (e instanceof Error ? e.message : e))
    } finally {
      MUSIC_BUSY = false
    }
  })
  return MUSIC
}
/* music song title per-language: key = song name; strip l_ prefix */
function locTitles(idx: LocIndex, key: string, langs: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const lang of langs) {
    const hits = idx.byLang.get(lang)?.get(key)
    out[lang.replace(/^l_/, '')] = hits && hits.length ? hits.map((h) => h.value).join('\n') : null
  }
  return out
}
let LOC_ERR = ''
let LOC_BUSY = false
function ensureLoc(rebuild = false): LocIndex | null {
  if (LOC && !rebuild) return LOC
  if (LOC_BUSY) return null
  LOC_BUSY = true
  markLocBuild()
  /* ★★ PARALLEL_V2(2026-10-17):改走【流式】worker。
   *
   * 原来这里是分片协作式(主线程 read+parse+merge 三段一起,每 60 文件让出一次,
   * 实测占住主线程 18.9 秒)。用户症状是「加载时音乐卡住」——
   * 因为音乐走 audio.src='/api/music/audio' 从本后端取流,
   * 主线程一直被占,音频请求只能挤在分片的缝里。
   *
   * 实测三段的占比(vanilla + 4 模组 / 3252 个 yml):
   *   read+parse 12.1s (64%) → 搬进 worker
   *   合并       6.8s (36%) → 结果必须活在本线程,留主线程
   * 为什么不整体搬迁:裸对象载荷 381MB / 595 万节点,deserialize 单趟 2671ms
   * —— 主线程会被连续堵 2.7 秒,比现状更糟。流式每批几十 KB,主线程尖峰可忽略。
   *
   * 降级:任一条 worker 链失败或批次不全 → runLocStream 内部自动改走
   * buildLocIndexAsync(主线程分片),功能不受影响。 */
  void (async () => {
    const t0 = Date.now()
    try {
      // ★ PERF:默认只构建 英文+简体中文(用户常用),其余语言按需 ensureLocLang/ensureLocFull 补全,常驻内存大幅下降
      const wantLangs = new Set(['l_english', 'l_simp_chinese'])
      const r = await runLocStream(
        srcRoots(),
        wantLangs,
      )
      LOC = r.index as LocIndex
      const s = r.stats
      console.log(
        `  本地化就绪: ${LOC.stats.files} 文件 / ${LOC.stats.entries} 条目 / ${LOC.langs.length} 语言,` +
        `合并 ${s.mergeMs} ms / 总 ${Date.now() - t0} ms(${s.chains} 链${s.fallback ? ',已降级' : ''})`,
      )
    } catch (e) {
      LOC_ERR = String(e)
      console.log(`  本地化索引失败: ${LOC_ERR}`)
    }
    LOC_BUSY = false
    /* ★ 本地化必须计入 BUILD 进度 —— 它现在是启动阶段最慢的一块(实测 6s),
     *   而它原本是 runHeavy 之外的"孤儿 async"(没进队列)。
     *   不计数的话 /api/status 会在本地化还在建时就报 ready,
     *   前端进度圈提前撤掉,用户进页面发现名字全是 key —— 而且没有任何报错。 */
    LOC_BUILD_TICK()
  })()
  return null
}

/** 本地化的 BUILD 计数配对(与 markLocBuild 配对使用) */
let LOC_BUILD_TICK = (): void => { /* 未登记时是空操作 */ }
/** 登记本地化这一轮开始:占住 BUILD.total,避免提前 ready */
function markLocBuild(): void {
  BUILD.total++
  PAR_INFLIGHT++
  if (!BUILD.building) {
    BUILD.building = true
    BUILD.since = Date.now()
  }
  const si = CUR_STAGE_IDX
  if (si >= 0 && BUILD.stages[si]) BUILD.stages[si].total++
  LOC_BUILD_TICK = () => {
    LOC_BUILD_TICK = () => {}
    BUILD.done++
    if (si >= 0 && BUILD.stages[si]) BUILD.stages[si].done++
    PAR_INFLIGHT--
    maybeFinishBuild()
  }
}

let LOC_EXT_BUSY = false
async function ensureLocLang(lang: string): Promise<boolean> {
  if (!LOC) return false
  const lk = lang.startsWith('l_') ? lang : 'l_' + lang
  if (LOC.byLang.has(lk)) return true
  if (LOC_EXT_BUSY) return false
  LOC_EXT_BUSY = true
  try {
    const sub = await buildLocIndexAsync(ROOTS, { wantLangs: new Set([lk]) })
    const m = sub.byLang.get(lk)
    if (m) { LOC.byLang.set(lk, m); if (!LOC.langs.includes(lk)) LOC.langs.push(lk) }
    return true
  } catch (e) { LOC_ERR = String(e) } finally { LOC_EXT_BUSY = false }
  return false
}
async function ensureLocFull(): Promise<boolean> {
  if (!LOC) return false
  if (LOC.langs.length >= 8) return true
  if (LOC_EXT_BUSY) return false
  LOC_EXT_BUSY = true
  try {
    const sub = await buildLocIndexAsync(ROOTS)
    LOC.byLang = sub.byLang; LOC.langs = sub.langs; LOC.stats = sub.stats; LOC.files = sub.files
    console.log(`  本地化补全(全语言): ${sub.langs.length} 语言`)
    return true
  } catch (e) { LOC_ERR = String(e) } finally { LOC_EXT_BUSY = false }
  return false
}

/** 本地化条目 → 前端行。src 用 root 名,便于筛选"哪些是模组改的" */
function locRowJson(key: string, hits: LocHit[]) {
  const parts = [...hits].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const top = parts[0]
  return {
    key,
    value: parts.map((h) => h.value).join('\n'),
    multi: parts.length > 1,
    // 多行条目逐段定位:改写时要按 index 分别写回各自的行
    parts: parts.map((h) => ({ index: h.index, value: h.value, file: h.file, line: h.line, rootIdx: h.rootIdx })),
    rootIdx: top.rootIdx,
    src: ROOTS[top.rootIdx]?.name ?? '',
    file: top.file,
    line: top.line,
    writable: !!ROOTS[top.rootIdx]?.writable,
  }
}

/* ── 事件图(EVENTS_V1)── */
let EV: EventIndex | null = null
let EV_ERR = ''
let EV_BUSY = false
function ensureEvents(): EventIndex | null {
  if (EV) return EV
  if (EV_BUSY) return null
  EV_BUSY = true
  const t = Date.now()
  /* CACHE_EVENTS_V1(2026-10-18,优化5):事件图冷启动实测 ~8s(26949 事件),
   * 是除引用图/本地化外最大的一块。按 focus 同款模式补磁盘缓存:
   * 签名扫各来源 events/,没变就 hydrate,跳过 worker 重建。 */
  const _evDirs: string[] = []
  for (const r of ROOTS) _evDirs.push(join(r.path, 'events'))
  const _evSig = dirSig(_evDirs) + "|rp:" + replacePathsSig()
  const _evC = loadCache<any>('events', _evSig)
  if (_evC) {
    EV = { roots: _evC.roots, events: deMap(_evC.events), namespaces: deMap(_evC.namespaces), files: _evC.files, ms: 0 } as unknown as EventIndex
    console.log(`  事件图(缓存命中): ${EV.events.size} 事件 / ${EV.files.length} 文件,hydrate ${Date.now() - t} ms`)
    EV_BUSY = false
    return EV
  }
  runHeavyPar('事件图', async () => {
    try {
      const r = await runInWorker({
        kind: 'events',
        roots: srcRoots(),
      })
      EV = r.data as unknown as EventIndex
      if (r.where === 'main') console.log('  [并行] worker 不可用,事件图回落主线程')
      saveCache('events', _evSig, { roots: EV.roots, events: serMap(EV.events), namespaces: serMap(EV.namespaces), files: EV.files })
      console.log(`  事件图就绪: ${EV.events.size} 事件 / ${EV.files.length} 文件,${EV.ms} ms(${r.where},已写缓存)`)
    } catch (e) {
      EV_ERR = String(e)
      console.log(`  事件图构建失败: ${EV_ERR}`)
    }
    EV_BUSY = false
  })
  return null
}

/* ── 来源(root)元信息 ──
 * 「基础游戏 vs 模组」的唯一判据是 Root.writable:parseArgs 里 --base 进来的一律
 * 只读,--mod 进来的一律可写,设置页重建来源时同样遵守。所以不需要额外字段。
 * 前端拿到 sources 后自己拼「全部 / 仅原版 / 仅模组 / 具体某个模组」的下拉。
 */
function sourcesJson(): { i: number; name: string; path: string; base: boolean; writable: boolean }[] {
  /* writable 显式下发,不让前端靠 base 反推 —— 两者今天等价,
   * 但一旦出现「只读挂载的模组」(以后会加)就会分叉,前端静默写失败很难查。 */
  return ROOTS.map((r, i) => ({ i, name: r.name, path: r.path, base: !r.writable, writable: !!r.writable }))
}

/** 绝对文件路径 → 所属来源名(MIO 机构按模组筛选用;前缀匹配须归一化分隔符) */
function rootNameOf(absFile: string): string {
  const norm = absFile.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < ROOTS.length; i++) {
    const rp = ROOTS[i].path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (norm === rp || norm.startsWith(rp + '/')) return ROOTS[i].name
  }
  return ROOTS[0]?.name ?? ''
}

/**
 * `rootNameOf` 的逆操作:绝对路径 → **来源序号**。
 *
 * ★★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开基础游戏文件」):
 *   很多内容索引(focus / tech / mio / doctrines / events …)的节点只带
 *   `file`(绝对路径),不带 `root`(来源序号)。前端要调
 *   `/api/open-external?root=N&file=…`,拿不到 N 就只能硬编码 `root: 0`
 *   —— 而 0 永远是 vanilla,于是「右键打开模组里的文件」会定位到
 *   基础游戏的同名文件,或直接报"文件不存在"。
 *
 *   归一化两侧再比(Windows 上 `resolve()` 会把 `/` 换成 `\`,
 *   与配置里存的正斜杠不一致 —— 这就是 PATH_GUARD_V2 踩过的坑)。
 *   匹配不到时返回 -1,让调用方决定是隐藏菜单项还是回退 0。
 */
function rootIdxOfFile(absFile: string): number {
  const norm = absFile.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < ROOTS.length; i++) {
    const rp = ROOTS[i].path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (norm === rp || norm.startsWith(rp + '/')) return i
  }
  return -1
}

/** 投影用:来源序号 + 来源名一次给全(前端右键菜单两个都要) */
function rootOf(absFile: string): { root: number; rootName: string } {
  const i = rootIdxOfFile(absFile)
  return i < 0 ? { root: -1, rootName: '' } : { root: i, rootName: ROOTS[i].name }
}

/* ── 文档清单 TTL 缓存:目录扫描(几千文件 stat)不必每次请求重做;
 *    内容仍实时读,清单缓存 10 秒。 ── */
const DOCS_TTL_MS = 10_000
const DOCS_LIST_CACHE = new Map<string, { at: number; files: DocFile[] }>()
function scanDocsCached(kind: 'official' | 'common'): DocFile[] {
  const hit = DOCS_LIST_CACHE.get(kind)
  if (hit && Date.now() - hit.at < DOCS_TTL_MS) return hit.files
  const files = kind === 'common' ? scanCommon(ROOTS) : scanOfficial(ROOTS)
  DOCS_LIST_CACHE.set(kind, { at: Date.now(), files })
  return files
}

/**
 * AIDE_V1:按用户给的路径读官方文档。
 *
 * 模型往往只写 `effects_documentation.md` 或 `common/national_focus` 这种简写,
 * 而 scanDocs 里的 rel 一律是 `documentation/xxx.md` / `common/xxx.md`。
 * 所以这里做**逐级放宽**匹配:精确 → 补前缀 → 按文件名后缀 → 去扩展名。
 * 匹配到多份时取第一份(官方文档优先级高于模组自带文档)。
 */
function readDocSafe(rel: string): { text: string } | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '')
  const list = scanDocsCached('official')
  const hit =
    list.find((f) => f.rel.replace(/\.md$/i, '') === norm) ??
    list.find((f) => f.rel.replace(/\.md$/i, '').endsWith('/' + norm)) ??
    list.find((f) => basename(f.rel).replace(/\.md$/i, '') === norm) ??
    list.find((f) => basename(f.rel).replace(/\.md$/i, '').includes(norm)) ??
    list.find((f) => f.rel.includes(norm))
  if (!hit) return null
  const root = ROOTS[hit.rootIdx]
  if (!root) return null
  const abs = safeDocPath(root.path, hit.rel, 'official')
  if (!abs) return null
  try {
    return { text: readFileSync(abs, 'utf8') }
  } catch {
    return null
  }
}

/** 按来源统计"最终生效"的实体数 —— 用于来源筛选器的计数徽标 */
function focusSourceStats(g: FocusGraph): Record<string, { trees: number; nodes: number }> {
  const out: Record<string, { trees: number; nodes: number }> = {}
  for (const r of ROOTS) out[r.name] = { trees: 0, nodes: 0 }
  for (const t of g.byId.values()) {
    const k = ROOTS[t.root]?.name
    if (out[k]) out[k].trees++
  }
  for (const n of g.nodes.values()) {
    const k = ROOTS[n.root]?.name
    if (out[k]) out[k].nodes++
  }
  return out
}

/** 另一维度:按"原版内容 / 模组新增 / 模组改写"三分类统计 —— 模组全覆盖原版时这才是有用的口径 */
function focusOriginStats(g: FocusGraph): { vanilla: number; modNew: number; overridden: number } {
  let vanilla = 0
  let modNew = 0
  let overridden = 0
  for (const t of g.byId.values()) {
    const { origin, overridden: ov } = originOf((g.versions.get(t.id) ?? [{ root: t.root }]).map((v) => v.root))
    if (origin === 'vanilla') {
      if (ov) overridden++
      else vanilla++
    } else modNew++
  }
  return { vanilla, modNew, overridden }
}

/* ── 来源三层语义 ──
 * 只看"最终生效版本来自哪里"是不够的:模组通常把原版树整棵覆盖掉,于是
 * "仅基础游戏"会筛出 0 棵树,筛选器就废了。所以要同时给出:
 *   base  —— 最终生效的那份来自原版吗
 *   origin—— 这东西原版本来就有吗(看覆盖链里有没有只读 root)
 *   overridden —— 最终生效的那份来自模组、且原版本来就有
 * 三者组合起来才能表达"原版内容 / 模组新增 / 模组改写"这三种用户真正关心的分类。
 */
/* ── OWNERSHIP_V1:全工作台统一的「原版 / 模组」归属判定 ──
 *
 * 游戏语义:载入顺序 基础游戏 → DLC → 模组,后者优先。
 *   · 同名(同 id / 同相对路径文件)→ 后者【整份替换】前者,先载入的那份失效(影子)。
 *   · 不同名 → 共存,后者是新增。
 * 所以每个实体只有三种归属,统计只算生效集(每个 key 一次):
 *   vanilla  原版有且没被改写        override 原版有但被模组替换      new 原版没有、模组新增
 *
 * ⚠ 之前各页自己用 `root === 0` / 「先出现的赢」判来源,于是出现两类错:
 *   ① 模组改内容不生效(界面还显示原版那份);② 同名被当成增加,总数虚高。
 *   现在统一走 engine/src/ownership.ts,本文件只是把 ROOTS 的只读判定喂进去。
 */
/** 只读 root = 基础游戏(原版 + DLC);可写 root = 模组 */
const isBaseRoot = (r: number): boolean => !ROOTS[r]?.writable

function ownOf(rootIdxs: (number | { root: number })[]): OwnInfo {
  return ownOfSites(
    rootIdxs.map((x) => (typeof x === 'number' ? { root: x } : { root: x.root })),
    isBaseRoot,
  )
}

/** 兼容旧调用点(focus/events 等在用的二字段口径) */
function originOf(rootIdxs: number[]): { origin: 'vanilla' | 'mod'; overridden: boolean } {
  const o = ownOf(rootIdxs)
  return { origin: o.origin, overridden: o.overridden }
}

/** 统一下发给前端的归属字段(各 API 都带上,前端不用再自己推) */
let CG: CharactersModel | null = null
let CG_ERR = ''
let CG_BUSY = false
function ensureCharacters(): CharactersModel | null {
  if (CG) return CG
  if (CG_BUSY) return null
  CG_BUSY = true
  CG_ERR = ''
  try {
    CG = buildCharactersModel(srcRoots(), isBaseRoot)
  } catch (e) { CG_ERR = String(e) } finally { CG_BUSY = false }
  return CG
}

let UG: UnitsModel | null = null
let UG_ERR = ''
let UG_BUSY = false
function ensureUnits(): UnitsModel | null {
  if (UG) return UG
  if (UG_BUSY) return null
  UG_BUSY = true
  UG_ERR = ''
  try {
    UG = buildUnitsModel(srcRoots(), isBaseRoot)
  } catch (e) { UG_ERR = String(e) } finally { UG_BUSY = false }
  return UG
}

function ownJson(o: OwnInfo): Record<string, unknown> {
  return {
    own: o.own,
    ownLabel: OWN_LABEL[o.own],
    origin: o.origin,
    base: o.base,
    overridden: o.overridden,
    /** 最终生效版本所在来源序号 */
    effectiveRoot: o.effective,
    /** 被覆盖而失效的来源序号(影子) */
    shadowedRoots: o.shadowed,
  }
}

/** 生效集统计 —— 总数 = vanilla + override + new,不含影子 */
function ownStatsJson(list: { own: Ownership }[], shadowed = 0): Record<string, number> {
  const s = ownStatsOf(list, (x) => x.own, shadowed)
  return {
    vanilla: s.vanilla,
    override: s.override,
    new: s.new,
    effective: s.effective,
    shadowed: s.shadowed,
  }
}

function decisionSourceStats(g: DecisionGraph): Record<string, { cats: number; nodes: number }> {
  const out: Record<string, { cats: number; nodes: number }> = {}
  for (const r of ROOTS) out[r.name] = { cats: 0, nodes: 0 }
  for (const n of g.nodes.values()) {
    const k = ROOTS[n.root]?.name
    if (out[k]) out[k].nodes++
  }
  // 分类归属:看 catDefs 的最后一条 —— 那才是最终生效的定义(与 game 覆盖顺序一致)。
  // 不能用"成员里 root 最大的那个"——一个分类里可能混着不同来源的决议,那样算出来的
  // 分类来源是假的。
  for (const defs of g.catDefs.values()) {
    const last = defs[defs.length - 1]
    const k = last ? ROOTS[last.root]?.name : undefined
    if (k && out[k]) out[k].cats++
  }
  return out
}

function focusNodeJson(n: FocusNode, g: FocusGraph): Record<string, unknown> {
  // 该 id 的全部定义位置(vanilla 定义 + 各模组覆盖)—— 决定 origin/overridden
  const allDefs = g.defs.get(n.id) ?? [{ root: n.root }]
  const { origin, overridden } = originOf(allDefs.map((d) => d.root))
  return {
    id: n.id,
    kind: n.kind,
    icon: n.icon,
    iconList: n.iconList ?? null,
    tex: iconTexId(n.icon),
    x: n.ax,
    y: n.ay,
    xOff: n.axOff,
    yOff: n.ayOff,
    rx: n.x,
    ry: n.y,
    rel: n.rel ?? null,
    cost: n.cost,
    prereq: n.prereq,
    mutex: n.mutex,
    /* ★ OR_V1:保留"且 / 或"结构,前端据此把 OR 边画成点线、检查器分组显示 */
    prereqGroups: n.prereqGroups ?? null,
    mutexGroups: n.mutexGroups ?? null,
    branch: n.branch,
    continuous: n.continuous,
    dynamic: n.dynamic,
    joint: n.jointOriginator || n.jointMember,
    tree: n.tree,
    root: n.root,
    rootName: g.roots[n.root]?.name ?? '?',
    base: !ROOTS[n.root]?.writable,
    origin,
    overridden,
    /** ★ OWNERSHIP_V1:三态归属(own),与全工作台同口径 */
    own: origin === 'vanilla' ? (overridden ? 'override' : 'vanilla') : 'new',
    ownLabel: overridden ? '模组改写' : origin === 'mod' ? '模组新增' : '原版',
    /** 这份定义自己是不是已被覆盖失效的旧版本 */
    stale: n.root !== (g.defs.get(n.id) ?? [{ root: n.root }]).slice(-1)[0].root,
    /** 全部定义位置(覆盖链),供 UI 展示"谁改写了它" */
    defs: allDefs.map((d) => ({
      root: d.root,
      rootName: g.roots[d.root]?.name ?? '?',
      base: !ROOTS[d.root]?.writable,
      file: d.file,
      line: d.line,
    })),
    file: n.file,
    line: n.line,
    available: n.available ?? '',
    bypass: n.bypass ?? '',
    aiWillDo: n.aiWillDo ?? '',
    completionReward: n.completionReward ?? '',
    searchFilters: n.searchFilters ?? '',
    offsetRaw: n.offsetRaw ?? '',
    branchRaw: n.branchRaw ?? '',
    /* ══════════════ TRIGGERS_V1 ══════════════
     * 下发完整条件表达式树 + 全部 offset 规则。
     * 旧版只给 offsetRaw 一段文本、branchRaw 一段文本,
     * 前端既无法判断条件真值,也无法换算多offset 的叠加位置。 */
    allowBranchTrig: n.allowBranchTrig ?? null,
    availableTrig: n.availableTrig ?? null,
    offsetRules: (n.offsetRules ?? []).map((r) => ({
      x: r.x,
      y: r.y,
      trigger: r.trigger ?? null,
      raw: r.raw,
    })),
    trigKeys: n.trigKeys ?? [],
  }
}

function focusTreeJson(g: FocusGraph, t: FocusTree): Record<string, unknown> {
  const ver = g.versions.get(t.id) ?? [{ root: t.root, file: t.file, line: t.line }]
  const { origin, overridden } = originOf(ver.map((v) => v.root))
  return {
    id: t.id,
    tags: t.tags,
    default: t.default,
    root: t.root,
    rootName: g.roots[t.root]?.name ?? '?',
    /** true = 最终生效的那份来自基础游戏 */
    base: !ROOTS[t.root]?.writable,
    /** 'vanilla' = 原版本来就有;'mod' = 模组新增 */
    origin,
    /** 原版有、但最终被模组改写了 */
    overridden,
    /** ★ OWNERSHIP_V1:三态归属,与全工作台同口径 */
    own: origin === 'vanilla' ? (overridden ? 'override' : 'vanilla') : 'new',
    ownLabel: overridden ? '模组改写' : origin === 'mod' ? '模组新增' : '原版',
    /** 这棵树的定义是不是已被更高优先级来源整份替换(影子) */
    stale: t.root !== ver[ver.length - 1].root,
    file: t.file,
    line: t.line,
    nodes: t.nodes.length,
    shared: t.shared.length,
    cfp: t.cfp ?? null,
    isp: t.isp ?? null,
    shortcuts: t.shortcuts.length,
    inlayWindows: t.inlayWindows,
    versions: ver.map((v) => ({
      root: v.root,
      rootName: g.roots[v.root]?.name ?? '?',
      base: !ROOTS[v.root]?.writable,
      file: v.file,
      // ★ line 一并下发(2026-10-05):右键菜单的"复制覆盖链"要逐条给出 file:line,
      //   少了行号只能定位到文件,覆盖链一大就不好用了。ver 的类型本来就带 line。
      line: v.line,
    })),
  }
}

function refJson(r: SymRef): Record<string, unknown> {
  return {
    kind: r.kind,
    target: r.target,
    name: r.name,
    raw: r.raw,
    suffix: r.suffix,
    slot: r.slot,
    root: r.root,
    rootName: ROOTS[r.root]?.name ?? '?',
    file: r.file,
    line: r.line,
    path: r.path,
    ctx: r.ctx,
    override: r.override,
  }
}

/** 写盘 + 备份。只读 root 一律拒绝,绝不越界 */
function commitPatch(p: FilePatch, stamp: string): { written: boolean; backup?: string; reason?: string } {
  const root = ROOTS[p.root]
  if (!root) return { written: false, reason: 'root 不存在' }
  if (!root.writable) return { written: false, reason: `「${root.name}」是只读目录` }
  if (!p.guard.ok) return { written: false, reason: `守卫失败: ${p.guard.message}` }
  // 什么都没改就不写:坐标被动态绑定拦下时常常产出空补丁,
  // 写盘只会留下一堆内容相同的备份。
  if (!p.details.length) return { written: false, reason: '无需改动(可能被动态绑定拦截)' }
  const abs = join(root.path, p.file)
  const backupDir = join(root.path, '.hoi4gui', 'backups', stamp)
  const backupRel = relative(root.path, join(backupDir, p.file)).replace(/\\/g, '/')
  mkdirSync(dirname(join(backupDir, p.file)), { recursive: true })
  writeFileSync(join(backupDir, p.file), readFileSync(abs, 'utf8'), 'utf8')
  writeFileSync(abs, p.text, 'utf8')
  layoutCache.delete(abs)
  return { written: true, backup: backupRel }
}

/* ── 布局缓存 ── */
const layoutCache = new Map<string, { mtime: number; src: string; layout: Layout }>()

function getLayout(rootIdx: number, file: string): { src: string; layout: Layout } {
  const abs = join(ROOTS[rootIdx].path, file)
  const mtime = statSync(abs).mtimeMs
  const hit = layoutCache.get(abs)
  if (hit && hit.mtime === mtime) return { src: hit.src, layout: hit.layout }
  const src = readFileSync(abs, 'utf8')
  const layout = buildLayout(src, file, spriteIdx)
  layoutCache.set(abs, { mtime, src, layout })
  return { src, layout }
}

/**
 * 任何会改写 layout.doc 的操作之前都必须调用。
 *
 * applyEdits / applyGuiOp 是**原地**改 token 的(直接 splice 进 layout.doc)。
 * 而缓存只在"成功写盘"后才失效 —— 若是预览或只读 root,文件 mtime 不变,
 * 缓存里那个 layout 的 doc 已经被改过、src 却还是旧串。下一次请求命中它,
 * 守卫就拿旧串去比对改动后的 doc,从第二次操作起必然误判失败;可写 root 下
 * 更危险:会以被污染的 doc 为基准写出文件。
 */
function dropLayout(rootIdx: number, file: string): void {
  layoutCache.delete(join(ROOTS[rootIdx].path, file))
}

function nodeJson(n: GuiNode): Record<string, unknown> {
  const def = n.sprite ? spriteIdx.get(n.sprite) : undefined
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    // children 必须递归输出 —— 漏了它前端只能看到顶层容器,
    // 一个 5 元素的文件在画布上就只剩 1 个框(之前一直是这样)。
    children: n.children.map(nodeJson),
    x: n.relX,
    y: n.relY,
    // 相对父级的最终像素偏移(已含 orientation 锚点 + origo/centerposition 折算)。
    // 渲染嵌套 DOM 必须用 offX/offY:用 x/y 会漏掉锚点 —— 这正是"看不出相对位置"的根因。
    offX: n.offX,
    offY: n.offY,
    w: n.w,
    h: n.h,
    absX: n.absX,
    absY: n.absY,
    drawW: n.drawW,
    drawH: n.drawH,
    /** 已折算为像素的 margin;子元素父级坐标系 = 绘制尺寸扣掉 margin,渲染需整体平移(margin.left, margin.top)。MU 的 containerwindowChildren div 即此。 */
    margin: n.margin,
    sprite: n.sprite,
    bgSprite: n.bgSprite,
    texId: def ? texIdFor(def) : undefined,
    bgTexId: n.bgSprite ? (spriteIdx.get(n.bgSprite) ? texIdFor(spriteIdx.get(n.bgSprite)!) : undefined) : undefined,
    // ★ BG_LAYERS_V1:附加 background 层(带 position 的),含已算好的几何与贴图 id
    bgLayers: (n.bgLayers ?? []).map((L) => ({
      sprite: L.sprite,
      x: L.x,
      y: L.y,
      orientation: L.orientation,
      origo: L.origo,
      centerPosition: !!L.centerPosition,
      scale: L.scale,
      offX: L.offX,
      offY: L.offY,
      drawW: L.drawW,
      drawH: L.drawH,
      texId: L.sprite && spriteIdx.get(L.sprite) ? texIdFor(spriteIdx.get(L.sprite)!) : undefined,
    })),
    spriteMissing: !!n.spriteMissing,
    sizeInferred: n.sizeInferred,
    sizeUnknown: !!n.sizeUnknown,
    posMissing: n.posMissing,
    depth: n.depth,
    parentId: n.parentId,
    line: n.line,
    text: n.props['text'],
    // 走 model 解析后的字段:原写法取原始标量,带引号的 orientation = "CENTER"
    // 会让属性网格下拉选不中;大小写混用(LOWER_RIGHT / lower_RIGHT)也需统一。
    orientation: n.orientation ?? '',
    origo: n.origo ?? '',
    centerPosition: !!n.centerPosition,
    // 继承后的实际锚点:自身没写 orientation 时等于父级的值(Wiki 规定继承)。
    // 前端据此提示"锚点 X —— 继承自父级",避免误以为没写 orientation 就是左上角。
    effectiveOrientation: n.effectiveOrientation ?? '', // WIKI_LAYOUT_V3
    // 自身对齐点(已含 origo / centerposition 折算)。暴露出来便于自查渲染基准。
    alignX: n.alignX,
    alignY: n.alignY,
    clipping: n.props['clipping'],
    moveable: n.props['moveable'],
    /** 全部标量属性,供属性网格编辑 */
    props: n.props,
    propBlocks: n.propBlocks,
    sizePct: !!n.sizePct,
    sizeAuto: !!n.sizeAuto,
    varRefs: n.varRefs,
  }
}

/* ── HTTP ──
 * PERF_V2(2026-10-05):两条通用优化都收在 send() 里,17 个页面自动受益。
 *
 * ① gzip:decisions/graph 原始 3.2MB、dlc/content 1.3MB —— 本地环路不觉得,
 *    一旦走网卡/远程就是秒级等待。压缩后约 1/10。
 *    阈值 2KB:小响应压了反而慢(还要算 crc + adler)。
 *    已经是压缩格式的(png/jpeg/zip…)不压,压了也不会变小。
 *
 * ② ETag + 304:静态资源(theme.css / 各页 js)每次导航都重下一遍。
 *    现在给它 sha1 指纹,浏览器带 If-None-Match 就回 304,body 不传。
 *    用 no-cache(必须回源校验)而不是 max-age —— 改了文件要立刻生效。
 */
const GZIP_MIN = 2048
const GZIP_SKIP = /^(image\/(png|jpeg|jpg|gif|webp|bmp)|application\/(zip|pdf|gzip))/

function send(res: ServerResponse, code: number, body: string | Buffer, type = 'application/json', preGz = false): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const req: IncomingMessage | undefined = (res as unknown as { req?: IncomingMessage }).req
  const hdr: Record<string, string | number> = { 'Content-Type': type }

  // 静态资源(html/js/css)走 ETag;JSON 一律 no-store(数据随时在变)
  const isStatic = !type.includes('json')
  if (isStatic) {
    const etag = '"' + createHash('sha1').update(buf).digest('base64url').slice(0, 27) + '"'
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    hdr.ETag = etag
    hdr['Cache-Control'] = 'no-cache'
  } else {
    hdr['Cache-Control'] = 'no-store'
  }

  const ae = req ? String(req.headers['accept-encoding'] ?? '') : ''
  if (buf.length >= GZIP_MIN && !GZIP_SKIP.test(type) && /\bgzip\b/.test(ae)) {
    if (preGz) {
      // RESP_CACHE:body 已是 gzip(来自响应缓存),直接发,不再二次压缩
      hdr['Content-Encoding'] = 'gzip'
      hdr['Content-Length'] = buf.length
      hdr.Vary = 'Accept-Encoding'
      res.writeHead(code, hdr)
      res.end(buf)
      return
    }
    try {
      const gz = gzipSync(buf, { level: 6 })
      // 压不动(高熵内容)就别浪费 CPU
      if (gz.length < buf.length * 0.95) {
        hdr['Content-Encoding'] = 'gzip'
        hdr['Content-Length'] = gz.length
        hdr.Vary = 'Accept-Encoding'
        res.writeHead(code, hdr)
        res.end(gz)
        return
      }
    } catch {
      /* 压缩失败就按原样发 */
    }
  }
  hdr['Content-Length'] = buf.length
  res.writeHead(code, hdr)
  res.end(buf)
}

/* ── RESP_CACHE:graph 大接口响应缓存(PERF_V3)──
 * tech/graph / decisions/graph 每次请求都重新遍历+JSON.stringify+gzipSync,
 * 缓存命中(按 src)直接返回,序列化+gzip 一次搞定。rebuildIndexes 清空。 */
const RESP_CACHE = new Map<string, { raw: Buffer; gz: Buffer; at: number }>()
/* MEM_LIMIT_V1(2026-10-18,优化6):响应缓存加条数上限,防常驻内存无限涨。
 * RESP_CACHE 每条存 gzip 后的大 Buffer(科技图 ~10MB、决议图 ~20MB);
 * apiCache 每条存整段 JSON 字符串。它们原本只在 rebuildIndexes 时清空,
 * 一次长会话里 loc/search 的不同查询串会往 apiCache 里无限塞。这里给两者
 * 都加上限:超了就按插入顺序淘汰最旧一条(Map 天然按插入序)。这是安全阀,
 * 不是热路径 —— 命中逻辑不变,只是防止极端情况把常驻堆吃光。 */
const RESP_CACHE_MAX = 32
function trimRespCache(): void {
  while (RESP_CACHE.size > RESP_CACHE_MAX) {
    const k = RESP_CACHE.keys().next().value
    if (k === undefined) break
    RESP_CACHE.delete(k)
  }
}
function graphCacheSet(key: string, rawStr: string): void {
  const raw = Buffer.from(rawStr, 'utf8')
  let gz = raw
  try { const g = gzipSync(raw, { level: 6 }); if (g.length < raw.length * 0.95) gz = g } catch { /* 原样 */ }
  RESP_CACHE.set(key, { raw, gz, at: Date.now() })
  trimRespCache()
}
/** 命中则直接发缓存并返回 true;未命中返回 false(调用方继续构建) */
function graphCacheSend(res: ServerResponse, key: string, type = 'application/json'): boolean {
  const c = RESP_CACHE.get(key)
  if (!c) return false
  const req = (res as unknown as { req?: IncomingMessage }).req
  const ae = req ? String(req.headers['accept-encoding'] ?? '') : ''
  const wantGz = /\bgzip\b/.test(ae)
  // ★ gz 与 raw 同一引用 = 当初 gzip 没压到(<95%),gz 实际是原文。
  //   此时即便客户端要 gzip,也不能把原文当 gzip 发(会被当压缩流解压失败)。
  const gzIsReal = c.gz !== c.raw
  send(res, 200, wantGz && gzIsReal ? c.gz : c.raw, type, wantGz && gzIsReal)
  return true
}

/* ── API_RESP_CACHE:重接口响应级缓存(PERF_D / Electron 化地基)──
 * 慢接口(worldmap/meta·characters/graph·units·events/list·loc/search)的瓶颈有两层:
 *  ① worldmap 的 buildWorldMap() 每次请求都重算;
 *  ② characters/events/loc 在 ensure* 之后还要对全量数据 .map/.filter/.sort,
 *     loc/search 更每次遍历全部 key。
 * 这里按「路径 + 查询串 + 数据版本号」命中,命中则跳过 build()+JSON.stringify,
 * 直接复用已序列化字符串(仍由 send 正常 gzip)。
 * 失效:数据一变(rebuildIndexes / softInvalidate)就 bump 版本并清空,与现有
 * 模块缓存(CG/UG/EV/LOC…)同源失效,不会引入静默错数据。*/
let apiDataVersion = 0
const apiCache = new Map<string, { v: number; json: string }>()
const API_CACHE_MAX = 256
function trimApiCache(): void {
  while (apiCache.size > API_CACHE_MAX) {
    const k = apiCache.keys().next().value
    if (k === undefined) break
    apiCache.delete(k)
  }
}
function bumpApiCache(): void { apiDataVersion++; apiCache.clear() }
function cacheSend(res: ServerResponse, key: string, build: () => unknown, isUncacheable?: (p: unknown) => boolean): void {
  const hit = apiCache.get(key)
  if (hit && hit.v === apiDataVersion) { send(res, 200, hit.json); return }
  const payload = build()
  if (isUncacheable && isUncacheable(payload)) { send(res, 200, JSON.stringify(payload)); return }
  const json = JSON.stringify(payload)
  apiCache.set(key, { v: apiDataVersion, json })
  trimApiCache()
  send(res, 200, json)
}

const TRACKER_DIR = KIT_DATA
let trBusy = false
let trErr = ''
function trackerRoots(): TrackRoot[] {
  return ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable }))
}
// 打包态(asar:false) app 文件在 resources/app,public 直接在其根;
// 开发态 public 在 packages/gui/public。两者都可能存在,以实际存在者为准。
const PUBLIC = existsSync(join(KIT_ROOT, 'public'))
  ? join(KIT_ROOT, 'public')
  : join(KIT_ROOT, 'packages', 'gui', 'public')

// SEC_HDRS_V1(2026-10-22):统一安全响应头。
// 威胁面:mod 的本地化/文件名/脚本内容会进 innerHTML(CWT 解析、designer、
// loc 页),页面一旦被注入,最值钱的两种外联是「加载远程脚本常驻」和
// 「把读到的 mod 源码 POST 出去」。CSP 的 connect-src/script-src 就是堵这两个。
// 其余是常规加固。注意:
//   · script-src/style-src 必须保留 'unsafe-inline' —— 现存 4 处内联脚本
//     (home×2 / shell×1 / studio×1)与全部 <style>/style= 属性都依赖它;
//     先把这些外移再收紧(见 MIGRATE_INLINE 计划)。
//   · media-src data:/blob: —— 音乐播放器 audio.src=/api/music/audio(同源),
//     data:/blob: 是给导出声明的兜底,不影响主路径。
const SEC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const server = createServer((req, res) => {
  // SEC_HDRS_V1:所有响应(含 304/静态/纹理/JSON)都带头;writeHead 不会清掉 setHeader 的值
  res.setHeader('Content-Security-Policy', SEC_CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname

  try {
    // 前端打包产物: /bundles/<name>.bundle.js/.mjs (静态;安全白名单,防目录穿越)
    if (p.startsWith('/bundles/')) {
      const rel = p.slice('/bundles/'.length)
      if (/^[\w.-]+\.bundle\.(js|mjs)$/.test(rel)) {
        const fp = join(PUBLIC, 'bundles', rel)
        if (existsSync(fp)) { res.setHeader('Cache-Control', 'no-cache'); return send(res, 200, readFileSync(fp, 'utf8'), 'application/javascript; charset=utf-8') }
      }
      return send(res, 404, 'not found', 'text/plain; charset=utf-8')
    }
    if (p === '/' || p === '/index.html' || p === '/shell' || p === '/shell.html') {
      // ★ 统一外壳: / 与 /shell 返回壳(shell.html)
      const html = readFileSync(join(PUBLIC, 'shell.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/home' || p === '/home.html') {
      // 首页作为壳的 iframe 子页:恒返回 home.html
      // (壳内由 nav.js window!==top 隐藏导航,不层射递归)
      const html = readFileSync(join(PUBLIC, 'home.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/studio' || p === '/studio.html') {
      const html = readFileSync(join(PUBLIC, 'studio.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/app.js') {
      const js = readFileSync(join(PUBLIC, 'app.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/bootgate.js') {
      const js = readFileSync(join(PUBLIC, 'bootgate.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/loadgate.js') {
      const js = readFileSync(join(PUBLIC, 'loadgate.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/focus' || p === '/focus.html') {
      const html = readFileSync(join(PUBLIC, 'focus.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/focus.js') {
      const js = readFileSync(join(PUBLIC, 'focus.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/check' || p === '/check.html') {
      const html = readFileSync(join(PUBLIC, 'check.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/check.js') {
      const js = readFileSync(join(PUBLIC, 'check.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/tracker' || p === '/tracker.html') {
      const html = readFileSync(join(PUBLIC, 'tracker.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/tracker.js') {
      const js = readFileSync(join(PUBLIC, 'tracker.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/tech' || p === '/tech.html') {
      const html = readFileSync(join(PUBLIC, 'tech.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/tech.js') {
      const js = readFileSync(join(PUBLIC, 'tech.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/decisions' || p === '/decisions.html') {
      const html = readFileSync(join(PUBLIC, 'decisions.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/decisions.js') {
      const js = readFileSync(join(PUBLIC, 'decisions.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/aibehave' || p === '/aibehave.html') {
      const html = readFileSync(join(PUBLIC, 'aibehave.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/aibehave.js') {
      const js = readFileSync(join(PUBLIC, 'aibehave.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/dlc' || p === '/dlc.html') {
      const html = readFileSync(join(PUBLIC, 'dlc.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/dlc.js') {
      const js = readFileSync(join(PUBLIC, 'dlc.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/worldmap' || p === '/worldmap.html') {
      const html = readFileSync(join(PUBLIC, 'worldmap.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/worldmap.js') {
      const js = readFileSync(join(PUBLIC, 'worldmap.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* 模组关系(MODMETA_V1):依赖图 + replace_path 缺口 */
    if (p === '/modrel' || p === '/modrel.html') {
      const html = readFileSync(join(PUBLIC, 'modrel.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/modrel.js') {
      const js = readFileSync(join(PUBLIC, 'modrel.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/defines' || p === '/defines.html') {
      const html = readFileSync(join(PUBLIC, 'defines.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/defines.js') {
      const js = readFileSync(join(PUBLIC, 'defines.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/doctrines' || p === '/doctrines.html') {
      const html = readFileSync(join(PUBLIC, 'doctrines.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/doctrines.js') {
      const js = readFileSync(join(PUBLIC, 'doctrines.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/create' || p === '/create.html') {
      const html = readFileSync(join(PUBLIC, 'create.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/create.js') {
      const js = readFileSync(join(PUBLIC, 'create.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/ide' || p === '/ide.html') {
      const html = readFileSync(join(PUBLIC, 'ide.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/ide.js') {
      const js = readFileSync(join(PUBLIC, 'ide.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/designer' || p === '/designer.html') {
      const html = readFileSync(join(PUBLIC, 'designer.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/characters' || p === '/characters.html') {
      const html = readFileSync(join(PUBLIC, 'characters.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/characters.js') {
      const js = readFileSync(join(PUBLIC, 'characters.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/units' || p === '/units.html') {
      const html = readFileSync(join(PUBLIC, 'units.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/units.js') {
      const js = readFileSync(join(PUBLIC, 'units.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* 静态资源:theme-vars.css / theme.css / nav.js 供所有页面共用。
     * 之前每个页面各自复制一份 :root 变量和"⚙ 设置"内联按钮,加一个入口要改 6 个文件。
     * ★ theme-vars.css 是纯变量层(无布局),theme.css 在其上叠加应用骨架;
     *   体检页 / 打开工程页有自己的布局,只引变量层 → 配色同样跟随设置中的主题。 */
    if (p === '/theme-vars.css') {
      const css = readFileSync(join(PUBLIC, 'theme-vars.css'), 'utf8')
      return send(res, 200, css, 'text/css; charset=utf-8')
    }
    if (p === '/theme.css') {
      const css = readFileSync(join(PUBLIC, 'theme.css'), 'utf8')
      return send(res, 200, css, 'text/css; charset=utf-8')
    }
    if (p === '/nav.js') {
      const js = readFileSync(join(PUBLIC, 'nav.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/music.js') {
      const js = readFileSync(join(PUBLIC, 'music.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* sizer.js(面板宽度可调) / locclient.js(本地化客户端) / tex.js(贴图加载)——
     * 三个都是跨页公共件,与 nav.js 同性质。各页 HTML 已统一 <script src> 引入。 */
    if (p === '/sizer.js') {
      const js = readFileSync(join(PUBLIC, 'sizer.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* edgepath.js(圆角折线连线,2026-10-04 新增跨页公共件):
     * focus/tech/dlc(MIO 树)三页共用 edgePathD(),线条统一成"略微弯曲的折线"。 */
    if (p === '/edgepath.js') {
      const js = readFileSync(join(PUBLIC, 'edgepath.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* gridwire.js(网格正交布线,GRIDWIRE_V1):移植 HOI4 Mod Utilities 的
     * GridBox 连线算法。focus / tech 两页引入 —— 把原来的"中心到中心曲线"
     * 换成游戏真实用的"格子轨道正交折线 + 冲突避让"。
     * ⚠ 新增静态资源必须在这里手工加路由(没有自动 glob)。 */
    if (p === '/gridwire.js') {
      const js = readFileSync(join(PUBLIC, 'gridwire.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* trig.js(国策条件求值公共件,TRIGGERS_V1):三态求值(true/false/未知)
     * + Scope(已完成的国策/旗标/游戏规则/标签)管理。focus 页引入 ——
     * allow_branch 显隐与 offset 条件偏移都靠它算。 */
    if (p === '/trig.js') {
      const js = readFileSync(join(PUBLIC, 'trig.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* target.js(目标模组选择器,MAKE_MOD_V1):写盘类操作共用的"写到哪儿"下拉,
     * 只列可写来源并记住上次选择。create / ide 两页引入。 */
    /* incr.js(增量渲染,PERF_V2):大列表分批建 DOM,滚到哨兵才追加下一批。
     * 决议页 3000+ 卡片一次建完会让主线程卡住几百毫秒 —— 本件是解药。 */
    if (p === '/incr.js') {
      const js = readFileSync(join(PUBLIC, 'incr.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* toolbar.js(顶栏筛选器折叠,UI_SLIM_V1):把标了 data-collapse 的
     * .tgroup 收进一个「筛选」开关,dlc/tech/doctrines/decisions 等页引入。 */
    if (p === '/toolbar.js') {
      const js = readFileSync(join(PUBLIC, 'toolbar.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/target.js') {
      const js = readFileSync(join(PUBLIC, 'target.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* ctx.js(全站右键菜单,RIGHTCLICK_V1)+ keys.js(全站快捷键 + F1 速查表,KEYS_V1)
     * + keymap.js(快捷键目录,全站唯一数据源,KEYMAP_V1)
     * + fullscreen.js(全站全屏,FULLSCREEN_V1)+ ctxwire.js(右键/快捷键接线骨架,RIGHTCLICK_V2)
     * —— 都是内容页共用的公共件,样式自注入,各页面只需加一行 <script>。
     * ⚠ 加载顺序有依赖:keymap.js 必须在 keys.js 之前,
     *    否则 keys.js 在 boot() 里 bind('global.sheet') 时读不到目录。 */
    if (p === '/ctx.js' || p === '/keys.js' || p === '/keymap.js' || p === '/fullscreen.js' || p === '/ctxwire.js' || p === '/resize.js') {
      const js = readFileSync(join(PUBLIC, p.slice(1)), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* OWNERSHIP_V1:统一的归属徽标公共件(各内容页都要引) */
    if (p === '/ownchip.js') {
      const js = readFileSync(join(PUBLIC, 'ownchip.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/locclient.js') {
      const js = readFileSync(join(PUBLIC, 'locclient.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* tex.js 用 ES module export,必须按 module 发 MIME,否则浏览器拒绝执行 */
    if (p === '/tex.js') {
      const js = readFileSync(join(PUBLIC, 'tex.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/designer.js') {
      const js = readFileSync(join(PUBLIC, 'designer.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* AIDE_V1:AI 面板前端(同样要 module MIME) */
    if (p === '/ai.js') {
      const js = readFileSync(join(PUBLIC, 'ai.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/open' || p === '/open.html') {
      const html = readFileSync(join(PUBLIC, 'open.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/open.js') {
      const js = readFileSync(join(PUBLIC, 'open.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/settings' || p === '/settings.html') {
      const html = readFileSync(join(PUBLIC, 'settings.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/settings.js') {
      const js = readFileSync(join(PUBLIC, 'settings.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* 使用教程:纯静态页,内容写在 docs.html 里(不需要后端数据) */
    if (p === '/docs' || p === '/docs.html') {
      const html = readFileSync(join(PUBLIC, 'docs.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    /* 本地化工具 */
    if (p === '/loc' || p === '/loc.html') {
      const html = readFileSync(join(PUBLIC, 'loc.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/loc.js') {
      const js = readFileSync(join(PUBLIC, 'loc.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* 事件制作 */
    if (p === '/events' || p === '/events.html') {
      const html = readFileSync(join(PUBLIC, 'events.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/events.js') {
      const js = readFileSync(join(PUBLIC, 'events.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    if (p === '/appearance.js') {
      const js = readFileSync(join(PUBLIC, 'appearance.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* I18N_V1(2026-10-07):中英双语。经典脚本(无 export),由 nav.js 之外的
     * 各页面普通 <script> 直接用,所以 nav.js 从 window.I18N 取。
     * ⚠ 静态资源必须在这里手工加路由 —— 否则 404,而页面会静默退回
     *   硬编码文案(全英文界面里混中文,或反之),没有任何报错提示。*/
    if (p === '/i18n.js') {
      const js = readFileSync(join(PUBLIC, 'i18n.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* I18N_DICT(2026-10-07):10 个原文键字典合成**一个**响应。
     * ★ 为什么不一条字典一个路由:那要让21 个页面各加10 个 <script>,
     *   漏一个就静默少一批翻译(没有报错,只是英文界面里冒中文)。
     *   这里在服务端按文件名排序拼接,页面只需加一行
     *   <script src="/i18n-dict.js"></script>,漏加同样会 warn,
     *   但至少加载顺序与完整性只由这一处保证。
     *   文件名排序 = 加载顺序,同一键后者覆盖前者(目前无重叠)。*/
    if (p === '/i18n-dict.js') {
      const dir = PUBLIC
      const files = readdirSync(dir)
        .filter((f: string) => /^i18n-dict-.*\.js$/.test(f))
        .sort()
      const body = files
        .map((f: string) => `/* ---- ${f} ---- */\n` + readFileSync(join(dir, f), 'utf8'))
        .join('\n')
      return send(res, 200, body, 'application/javascript; charset=utf-8')
    }
    /* PROGRESS_V1(2026-10-07):全站加载进度条。同 i18n.js,必须手工加路由。*/
    if (p === '/progress.js') {
      const js = readFileSync(join(PUBLIC, 'progress.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* 文档查阅:官方手册 /ref、common 文档 /commondocs。
     * 两个页面共用 ref.js(靠 pathname 区分 kind),HTML 各一份只为路由清晰。 */
    if (p === '/ref' || p === '/ref.html' || p === '/commondocs' || p === '/commondocs.html') {
      const html = readFileSync(join(PUBLIC, 'ref.html'), 'utf8')
      return send(res, 200, html, 'text/html; charset=utf-8')
    }
    if (p === '/ref.js') {
      const js = readFileSync(join(PUBLIC, 'ref.js'), 'utf8')
      return send(res, 200, js, 'application/javascript; charset=utf-8')
    }
    /* ── 文档查阅(实时:每次请求现扫现解析,见 docs.ts 文件头)──
     * PERF_DOCS_CACHE:目录扫描本身(几千文件 stat)每次请求都重做很浪费;
     * 内容仍是实时读的,只有"文件清单"按 TTL 缓存 10 秒 —— 新增/删除文档最多延迟 10 秒可见。 */
    if (p === '/api/docs/list') {
      const kind = url.searchParams.get('kind') === 'common' ? 'common' : 'official'
      const files = scanDocsCached(kind)
      /* 按 group 折叠:official 的 group 是来源名,common 的 group 是 common/ 下的目录 */
      const groups = new Map<string, DocFile[]>()
      for (const f of files) {
        const g = groups.get(f.group) ?? []
        g.push(f)
        groups.set(f.group, g)
      }
      return send(res, 200, JSON.stringify({
        ready: ROOTS.length > 0,
        kind,
        total: files.length,
        groups: [...groups.entries()].map(([name, items]) => ({ name, items })),
      }))
    }
    if (p === '/api/docs/read') {
      const kind = url.searchParams.get('kind') === 'common' ? 'common' : 'official'
      const id = url.searchParams.get('id') ?? ''
      const qi = id.indexOf(':')
      const rootIdx = parseInt(id.slice(0, qi), 10)
      const rel = id.slice(qi + 1)
      const root = ROOTS[rootIdx]
      if (!root || !rel) return send(res, 400, JSON.stringify({ error: '参数不合法' }))
      const abs = safeDocPath(root.path, rel, kind)
      if (!abs) return send(res, 404, JSON.stringify({ error: '文档不在允许范围内' }))
      try {
        const src = readFileSync(abs, 'utf8')
        const list = scanDocsCached(kind)
        const meta = list.find((f) => f.id === id)
          ?? { id, rootIdx, rootName: root.name, rel, name: rel, title: rel, group: '', size: src.length, mtime: 0, hasHtml: false } as DocFile
        if (kind === 'common') {
          const doc = parseCommon(src, meta)
          return send(res, 200, JSON.stringify({
            kind, file: meta, title: doc.title,
            sections: doc.sections.map((s) => ({ ...s, html: mdToHtml(s.body) })),
          }))
        }
        const doc = parseOfficial(src, meta)
        return send(res, 200, JSON.stringify({
          kind, file: meta, title: doc.title, intro: mdToHtml(doc.intro),
          categories: doc.categories.map((c) => ({
            id: c.id, name: c.name, scope: c.scope,
            entries: c.entries.map((e) => ({ ...e, html: mdToHtml(e.body) })),
          })),
        }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    }
    /* ── MOD_SCOPE_V1:体检目标选择 ──
     *
     * GET  /api/check/target          读当前目标 + 候选模组清单
     * POST /api/check/target {path}   设定目标(传 null / 空串 = 恢复全量)
     *
     * 候选清单合并三个来源,前端一个下拉就够用:
     *   1. 已挂载来源(ROOTS)—— 绝大多数情况直接够用
     *   2. 创意工坊已订阅模组(scanWorkshopMods)
     *   3. 手动输入路径(POST 时的 path)—— 前端的目录选择器走这条
     */
    if (p === '/api/check/target') {
      const describe = (r: CheckRootSpec) => ({
        name: r.name,
        path: r.path,
        mounted: r.mounted,
        isTarget: !!CHECK_TARGET && samePath(CHECK_TARGET.path, r.path),
        modFile: r.info?.modFile,
        modVersion: r.info?.version,
        supportedVersion: r.info?.supportedVersion,
        versionOk: r.info?.versionOk,
        tags: r.info?.tags ?? [],
        hasModFile: r.info?.hasModFile ?? false,
      })
      // 创意工坊候选(只补 ROOTS 里没有的)
      let workshop: ReturnType<typeof describe>[] = []
      try {
        workshop = scanWorkshopMods().mods
          .filter((m) => !ROOTS.some((r) => samePath(r.path, m.path)))
          .map((m) => {
            const mi = readModInfo(m.path)
            return {
              name: mi.name || basename(m.path),
              path: m.path,
              mounted: false,
              isTarget: !!CHECK_TARGET && samePath(CHECK_TARGET.path, m.path),
              modFile: mi.modFile,
              modVersion: mi.version,
              supportedVersion: mi.supportedVersion,
              versionOk: mi.versionOk,
              tags: mi.tags,
              hasModFile: mi.hasModFile,
            }
          })
      } catch {
        workshop = [] // 读不到 Steam 目录不影响已挂载来源
      }

      if (req.method === 'POST') {
        let body = ''
        req.on('data', (c) => {
          body += c
          if (body.length > 200000) req.destroy()
        })
        req.on('end', () => {
          let path: string | null = null
          try {
            const j0 = JSON.parse(body || '{}')
            path = typeof j0.path === 'string' && j0.path.trim() ? j0.path.trim() : null
          } catch {
            /* 空 body = 清除目标 */
          }
          try {
            const r = setCheckTarget(path)
            if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }))
            return send(
              res,
              200,
              JSON.stringify({
                target: CHECK_TARGET ? describe(CHECK_TARGET) : null,
                candidates: CHECK_ROOTS.map(describe),
              }),
            )
          } catch (e) {
            return send(res, 500, JSON.stringify({ error: String(e) }))
          }
        })
        return
      }

      return send(
        res,
        200,
        JSON.stringify({
          target: CHECK_TARGET ? describe(CHECK_TARGET) : null,
          candidates: CHECK_ROOTS.map(describe),
          workshop,
          error: CHECK_TARGET_ERR || undefined,
        }),
      )
    }
    if (p === '/api/check') {
      const rep = ensureCheck()
      if (!rep)
        return send(
          res,
          200,
          JSON.stringify({
            ready: false,
            busy: CHECK_BUSY,
            error: CHECK_ERR,
            progress: CHECK_PROGRESS,
            target: CHECK_TARGET ? { name: CHECK_TARGET.name, path: CHECK_TARGET.path } : null,
          }),
        )
      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          report: rep,
          target: CHECK_TARGET ? { name: CHECK_TARGET.name, path: CHECK_TARGET.path } : null,
        }),
      )
    }
    /* ── defines(游戏平衡参数)── */
    /* ── defines 原版 vs 模组差异(DEFDIFF_V1,2026-10-07)──
     * 用户诉求:「模组可以修改 defines.lua 里的数值,新的 .lua 中的数值
     * 可替换掉原来的数值,对此做出原版与模组的比较(-- 注释部分忽略)」。
     *
     * ★ 判据要点(全部在 engine/src/defines.ts 的 computeDefineDiffs 里):
     *   - 只有「模组碰过的键」进列表;6000+ 条原版默认值不算差异
     *   - 注释由 parseValue 剥离到 comment 字段,比较只看 value
     *     → 模组只删/改注释不算数值改动(否则噪声爆炸)
     *   - 值相同但被模组重写 → kind=same-value,单独计数
     *   - baseName 必须在来源里真的存在,否则返回空 + 明确提示
     *     (只挂模组没挂原版时,不能谎报"新增 6000 个参数")
     */
    if (p === '/api/defines/diff') {
      const m = ensureDefines()
      if (!m) return send(res, 200, JSON.stringify({ ready: false, busy: DF_BUSY, error: DF_ERR }))
      const base = ROOTS.find((r) => !r.writable)
      const modNames = new Set(ROOTS.filter((r) => r.writable).map((r) => r.name))
      const baseName = base?.name ?? ''
      if (!baseName) {
        return send(res, 200, JSON.stringify({
          ready: true, diffs: [], sum: { total: 0, changed: 0, same: 0, added: 0, up: 0, down: 0 },
          error: '没有挂载只读的基础游戏,无法比较原版与模组',
        }))
      }
      const diffs = computeDefineDiffs(m.entries, baseName, modNames)
      const sum = summarizeDefineDiffs(diffs)
      const q = (url.searchParams.get('q') ?? '').toLowerCase().trim()
      const kind = url.searchParams.get('kind') ?? ''
      let list = diffs
      if (q) list = list.filter((d) => d.key.toLowerCase().includes(q) || (d.mod?.comment ?? '').toLowerCase().includes(q))
      if (kind === 'changed') list = list.filter((d) => d.changed)
      else if (kind === 'same') list = list.filter((d) => !d.changed && d.kind !== 'mod-add')
      else if (kind === 'added') list = list.filter((d) => d.kind === 'mod-add')
      return send(res, 200, JSON.stringify({
        ready: true,
        baseName,
        modNames: [...modNames],
        sum,
        matched: list.length,
        diffs: list.slice(0, 3000).map((d) => ({
          key: d.key, group: d.group, name: d.name,
          changed: d.changed, kind: d.kind,
          delta: d.delta, deltaPct: d.deltaPct,
          sourceCount: d.sourceCount,
          base: d.base && { value: d.base.value, num: d.base.num, type: d.base.type, file: d.base.file, line: d.base.line, comment: d.base.comment },
          mod: d.mod && { value: d.mod.value, num: d.mod.num, type: d.mod.type, file: d.mod.file, line: d.mod.line, comment: d.mod.comment },
          shadowed: d.shadowed.map((s) => ({ file: s.file, line: s.line, value: s.value })),
        })),
      }))
    }
    if (p === '/api/defines' || p === '/api/defines/item') {
      const m = ensureDefines()
      if (!m) return send(res, 200, JSON.stringify({ ready: false, busy: DF_BUSY, error: DF_ERR }))
      // 单条查询:?key=NGame.START_DATE —— 前端从清单跳到详情用
      if (p === '/api/defines/item') {
        const key = url.searchParams.get('key') ?? ''
        const e = m.byKey.get(key)
        if (!e) return send(res, 404, JSON.stringify({ error: '未找到该 defines 键', key }))
        // 同键多来源:mod 覆盖 vanilla 时要能看到差异
        const all = m.entries.filter((x) => x.key === key)
        return send(res, 200, JSON.stringify({ ready: true, entry: e, sources: all }))
      }
      /* 筛选参数:
       *   group=NGame     限定分组
       *   q=xxx           名称/说明模糊搜索(前缀优先)
       *   type=number     限定值类型(number/string/bool/array/table/expr)
       *   src=vanilla|mod 源筛选(base/mod/vanilla/modNew/overridden 同其它页语义)
       */
      const group = url.searchParams.get('group') ?? ''
      const q = (url.searchParams.get('q') ?? '').toLowerCase().trim()
      const typeF = url.searchParams.get('type') ?? ''
      const src = url.searchParams.get('src') ?? ''
      let list = m.entries
      if (group) list = list.filter((e) => e.group === group)
      if (typeF) list = list.filter((e) => e.type === typeF)
      if (src) {
        list = list.filter((e) => {
          const isMod = e.file.startsWith((ROOTS.find((r) => r.writable)?.name ?? '\u0000') + '/')
          if (src === 'vanilla') return !isMod
          if (src === 'mod') return isMod
          return true
        })
      }
      if (q) {
        list = list.filter(
          (e) => e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q) ||
            (e.comment ?? '').toLowerCase().includes(q),
        )
        // 前缀命中排前面(用户输入的一般是键名前缀)
        list = [...list].sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
          return ap - bp || a.name.localeCompare(b.name)
        })
      }
      return send(res, 200, JSON.stringify({
        ready: true,
        total: m.entries.length,
        matched: list.length,
        // 分组清单带条目数,前端左侧树直接用
        groups: [...m.byGroup.entries()]
          .map(([name, es]) => ({
            name,
            file: m.groupFile.get(name) ?? '',
            count: es.length,
            // 分组内有多少条被模组覆盖过(改平衡的高频入口)
            overridden: es.filter((e) => e.file.startsWith((ROOTS.find((r) => r.writable)?.name ?? '\u0000') + '/')).length,
          }))
          .sort((a, b) => b.count - a.count),
        types: [...new Set(m.entries.map((e) => e.type))],
        entries: list.slice(0, 4000),
      }))
    }
    if (p === '/api/tech/graph') {
      const _gk = '/api/tech/graph'
      // PERF_DISK_V2(2026-10-10):tech/graph 磁盘缓存(重启免 32s 重建),与 decisions 同款签名
      if (!RESP_CACHE.has(_gk)) {
        const _tgSig = () => strSig([TEX_SCHEME, dirSig(ROOTS.map((r) => join(r.path, 'common/technologies'))) + '|rp:' + replacePathsSig()])
        const _c = loadCache<{ raw: string; gz: string; tex?: Record<string, TexEntry> }>('tech_graph', _tgSig())
        if (_c) { RESP_CACHE.set(_gk, { raw: Buffer.from(_c.raw, 'base64'), gz: Buffer.from(_c.gz, 'base64'), at: Date.now() }); restoreTexEntries(_c.tex) }; trimRespCache()
      }
      if (graphCacheSend(res, _gk)) return
      const _gt0 = Date.now()
      const g = ensureTech()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: TG_BUSY, error: TG_ERR }))
      // ⚠ 分类体系(2026-10 新增):technology_tags 里有两块 ——
      //   technology_categories(134 项顺序表,决定左右次序)
      //   technology_folders(16 个显示分组,带 ledger / doctrine / DLC 门控)
      // 科技通过 categories 归类、通过 folder.name 归组。两者都要下发,
      // 前端才能画出分区 + 单独的"隐藏科技"分组。
      const catUse = new Map<string, number>()
      for (const n of g.nodes.values()) for (const c of n.categories) catUse.set(c, (catUse.get(c) ?? 0) + 1)
      const areas = g.categories.filter((c) => catUse.has(c))
      // 顺序表里有但没科技引用的(实测 28 个 doctrine 树容器)也列出来,标 empty
      const catList = g.categories.map((c, i) => ({
        id: c,
        order: i,
        count: catUse.get(c) ?? 0,
      }))
      const folderList = g.folderOrder.map((id) => {
        const f = g.folders.get(id)!
        const techs = [...g.nodes.values()].filter((n) => n.folder === id)
        return {
          id,
          ledger: f.ledger ?? '',
          doctrine: !!f.doctrine,
          dlcGated: !!f.dlcGated,
          count: techs.length,
          file: f.file,
          line: f.line,
          root: f.root,
          rootName: ROOTS[f.root]?.name ?? '',
          ...ownJson(ownOf(g.folderVersions.get(id) ?? [{ root: f.root }])),
        }
      })
      /* ★ OWNERSHIP_V1:逐条科技算归属三态。
       *   口径是【生效集】:nodes 这个 Map 已经是同名后者替换前者(与游戏一致),
       *   所以总数就是游戏里真实存在的科技数,不需要再"原版 + 模组"相加。 */
      const techOwn = new Map<string, OwnInfo>()
      for (const n of g.nodes.values()) {
        techOwn.set(n.id, ownOf(g.versions.get(n.id) ?? [{ root: n.root }]))
      }
      const ownList = [...techOwn.values()]

      /* TRIGGERS_V1: 全树唯一条件清单(对齐 MU 的 conditionExprs)。
       * 一个条件叶子一条(nodeContent 规范化字符串),带出现次数;面板列的就是它。 */
      const techConds = new Map<string, { nodeContent: string; key: string; count: number }>()
      for (const n of g.nodes.values()) {
        collectConditions(n.allowBranchTrig, techConds)
      }
      const _out = JSON.stringify({
          ready: true,
          nodes: [...g.nodes.values()].map((n) => ({
            id: n.id,
            x: n.x,
            y: n.y,
            cost: n.cost,
            year: n.year,
            area: n.area,
            categories: n.categories,
            folder: n.folder ?? '',
            // ★ 多 folder 科技:该科技在【每个】folder 的独立坐标
            //   (对齐 HOI4 MU tech.folders;前端按当前 folder 取位置)
            folders: n.folders ?? {},
            // ★ TECHLAYOUT_GUI_V1:gui 布局归属(gb=gridbox 子树名)与像素坐标(前端直接按像素画,
            //   不再用自定 XU/YU 间距);无 gui 布局的 folder 为 70×70 兜底
            gb: n.gb ?? {},
            px: n.px ?? {},
            hidden: !!n.hidden,
            // ★ 科技图标三段回退(与游戏 countrytechtreeview.gfx 的真实语义一致):
            //   1) tech 块显式 icon = GFX_xxx
            //   2) 无 icon → 游戏默认科技图标 GFX_technology_medium(= gfx/interface/technologies/tank_icon.dds,
            //      实测 76x42,科技树节点无自定义图标时游戏就是画它)
            //   3) 该精灵也缺失 → tex 留空,前端回退内置齿轮 data URI(永不破图)
            icon: n.icon ?? '',
            showEquipmentIcon: !!n.showEquipmentIcon,
            equipment: n.equipment ?? '',
            equipList: n.equipList ?? [],
            /* ★ TECHLAYOUT_GUI_V1:图标三段回退补上【装备→GFX】—— 科技无显式 icon 时,
               游戏按当前国家画装备图标(interface/Technologies.gfx 的 GFX_GER_infantry1_medium
               → GER_infantry_equipment_1.dds,SOV/FIN 同构);工具侧固定用 GER 变体。
               命中装备 GFX 才用,否则才落到默认科技图标(不破图)。 */
            tex: iconTexId(n.icon ?? '') || equipTexId(n.id, n) || iconTexId(TECH_DEFAULT_ICON),
            leads: n.leads,
            enables: n.enables,
            /* ★ TECHGRAPH_V1:HOI4 MU 0.18.1 的四个结构字段(以前全丢)。
             *   xor              —— 互斥科技,前端画 ⊻ 中转点而非并行实线
             *   allowBranch      —— 本科技显形需先完成的科技
             *   inAllowBranch    —— 上述门的【传递闭包】,分支下游科技据此判断显形
             *   subTechnologies  —— 父科技格内的子科技
             *   startTechnology  —— 所属"起始科技树"页签 */
            xor: n.xor ?? [],
            allowBranch: n.allowBranch?.completedTech ?? '',
            allowBranchDlcs: n.allowBranchDlcs ?? [],
            allowBranchRaw: n.allowBranchRaw ?? '',
            hasAllowBranch: !!n.allowBranch,
            inAllowBranch: n.inAllowBranch ?? [],
            /* TRIGGERS_V1: allow_branch 完整条件树 + 可开关 key(科技树条件面板用) */
            allowBranchTrig: n.allowBranchTrig ?? null,
            trigKeys: n.trigKeys ?? [],
            subTechnologies: n.subTechnologies ?? [],
            forceUseSmallTechLayout: !!n.forceUseSmallTechLayout,
            startTechnology: n.startTechnology ?? '',
            // TECHEFFECT_V1: 研究完成效果(modifiers/research_speed/instant 等)
            effects: n.effects ?? null,
            file: n.file,
            line: n.line,
            // ★ RIGHTCLICK_ROOT_V1:tech 节点原本不带 root,前端只能硬编码 0
            //   (= vanilla),右键打开模组科技文件时定位到基础游戏同名文件。
            root: n.root,
            rootName: ROOTS[n.root]?.name ?? '',
            // ★ false = 文件里没写 folder.position,坐标是自动补的网格位(前端要标出来)
            posDeclared: n.posDeclared !== false,
            // ★ OWNERSHIP_V1:三态归属 + 覆盖链
            ...ownJson(techOwn.get(n.id)!),
            defs: (g.versions.get(n.id) ?? []).map((d) => ({
              root: d.root,
              rootName: ROOTS[d.root]?.name ?? '',
              base: isBaseRoot(d.root),
              file: d.file,
              line: d.line,
            })),
          })),
          edges: g.edges,
          /** TRIGGERS_V1: 本树唯一条件清单(前端条件面板用,对齐 MU conditionExprs) */
          conditions: [...techConds.values()].sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count),
          /** GAMERULE_DEFAULT_V1:各游戏规则默认选项(科技 has_game_rule 求值基准,与国策同源) */
          gameRules: loadGameRuleDefaults(),
          areas,
          categories: catList,
          folders:           folderList,
          // ★ TECHLAYOUT_GUI_V1:countrytechtreeview.gui 布局(folder → gridbox 列表),前端据此画网格/算卡宽
          layout: g.layout ?? [],
          // ★ 同 folder 同坐标的分组(实测 58 组,最多一格 7 条)—— 前端据此横向错开,
          //   否则这些节点会完全重叠成一坨。
          slots: g.slots,
          /* ★ TECHGRAPH_V1:起始科技树分组(MU `$s()` 等价)—— 游戏页签按它切,
             不是按 technology_folders 切。前端优先用 techTrees 建页签,
             folders 退回只做分区标题与统计。 */
          techTrees: g.techTrees,
          xorPairs: g.xorPairs,
          unknownCategories: g.unknownCategories,
          unknownFolders: g.unknownFolders,
          danglingEdge: g.danglingEdge,
          /** 归属三态统计:effective = 游戏里真实生效的科技数(同名只算一次) */
          own: ownStatsJson(
            ownList,
            [...g.versions.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
          ),
          sources: sourcesJson(),
          stats: {
            nodes: g.nodes.size,
            edges: g.edges.length,
            areas: areas.length,
            catsDeclared: g.categories.length,
            catsEmpty: g.categories.length - areas.length,
            folders: g.folders.size,
            hiddenTechs: [...g.nodes.values()].filter((n) => n.hidden).length,
            hiddenFolders: folderList.filter((f) => f.ledger === 'hidden').length,
            // ★ 坐标分布统计:前端用来提示"横纵向分布"是否合理
            coordMinX: Math.min(...[...g.nodes.values()].map((n) => n.x)),
            coordMaxX: Math.max(...[...g.nodes.values()].map((n) => n.x)),
            coordMinY: Math.min(...[...g.nodes.values()].map((n) => n.y)),
            coordMaxY: Math.max(...[...g.nodes.values()].map((n) => n.y)),
            autoPositioned: [...g.nodes.values()].filter((n) => n.posDeclared === false).length,
            overlapSlots: g.slots.length,
            overlapTechs: g.slots.reduce((a, s) => a + s.ids.length, 0),
            // ★ TECHGRAPH_V1 统计
            techTrees: g.techTrees.length,
            xorPairs: g.xorPairs.length,
            allowBranchTechs: [...g.nodes.values()].filter((n) => n.allowBranch).length,
            allowBranchDlc: [...g.nodes.values()].filter((n) => (n.allowBranchDlcs ?? []).length).length,
            allowBranchGated: [...g.nodes.values()].filter((n) => (n.inAllowBranch ?? []).length > 1).length,
            subTechs: [...g.nodes.values()].reduce((a, n) => a + (n.subTechnologies?.length ?? 0), 0),
          },
        });
      console.log('graph ms=' + (Date.now() - _gt0) + ' len=' + _out.length)
      graphCacheSet(_gk, _out)
      const _te = RESP_CACHE.get(_gk)
      if (_te) { try { saveCache('tech_graph', strSig([TEX_SCHEME, dirSig(ROOTS.map((r) => join(r.path, 'common/technologies')))]), { raw: _te.raw.toString('base64'), gz: _te.gz.toString('base64'), tex: collectTexEntries(_out) }) } catch {} }
      // 命中响应缓存(刚 set 进去):直接发缓存,避免对同一 JSON 再 gzip 一次
      if (graphCacheSend(res, _gk)) return
      return send(res, 200, _out)
    }
    if (p === '/api/dlc/content') {
      const m = ensureDlc()
      if (!m) return send(res, 200, JSON.stringify({ ready: false, busy: DM_BUSY, error: DM_ERR }))
      /* src 取值与 focus/decisions 一致:
       *   '' / 'base' / 'mod' / 'vanilla' / 'modNew' / 'overridden' / 具体来源名
       * DLC 特有的两个筛选:
       *   feature —— 限定某个玩法(军工机构/特殊工程/阵营/学说)
       *   dlc    —— 限定某个 DLC(按条目自身 has_dlc 或注册表归属匹配)
       */
      const src = url.searchParams.get('src') ?? ''
      const feature = url.searchParams.get('feature') ?? ''
      const dlcF = url.searchParams.get('dlc') ?? ''
      const keep = (id: string, root: number, defs: { root: number }[] | undefined): boolean => {
        if (src) {
          if (src === 'base' && ROOTS[root]?.writable) return false
          if (src === 'mod' && !ROOTS[root]?.writable) return false
          if (src !== 'base' && src !== 'mod') {
            const o = ownOf((defs ?? [{ root }]).map((d) => d.root))
            if (src === 'vanilla' && o.own !== 'vanilla') return false
            if ((src === 'new' || src === 'modNew') && o.own !== 'new') return false
            if ((src === 'override' || src === 'overridden') && o.own !== 'override') return false
            if (!['vanilla', 'new', 'modNew', 'override', 'overridden'].includes(src) && ROOTS[root]?.name !== src) {
              return false
            }
          }
        }
        void id
        return true
      }
      const features = m.featureOrder
        .filter((id) => !feature || id === feature)
        .map((id) => {
          const f = m.features.get(id)!
          const groups = f.groupOrder.map((gid) => {
            const grp = f.groups.get(gid)!
            const items = grp.items.filter((it) => {
              if (!keep(it.id, it.root, f.defs.get(it.id))) return false
              if (dlcF && !it.hasDlc.includes(dlcF) && it.dlc !== dlcF) return false
              return true
            })
            return {
              id: gid,
              label: grp.label,
              count: items.length,
              items: items.map((it) => ({
                ...dlcItemJson(it),
                // ★ OWNERSHIP_V1:三态归属(生效集口径,同名条目只留优先级最高那份)
                ...ownJson(ownOf(f.defs.get(it.id) ?? [{ root: it.root }])),
              })),
            }
          })
          const total = groups.reduce((a, x) => a + x.count, 0)
          return {
            id: f.id,
            label: f.label,
            dlc: f.dlc,
            dir: f.dir,
            present: f.present,
            count: total,
            stats: f.stats,
            /** 该玩法下条目的三态统计 */
            own: ownStatsJson(
              [...f.items.keys()].map((id) => ownOf(f.defs.get(id) ?? [{ root: 0 }])),
              [...f.defs.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
            ),
            groups,
          }
        })
      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          features,
          sources: sourcesJson(),
          installedDlc: m.installedDlc,
          dirGating: m.dirGating,
          missing: m.missing,
          totals: {
            features: features.length,
            items: features.reduce((a, f) => a + f.count, 0),
            groups: features.reduce((a, f) => a + f.groups.length, 0),
            dlcs: m.installedDlc.length,
          },
          /** 全局三态统计(全部玩法合计,生效集口径) */
          own: ownStatsJson(
            m.featureOrder.flatMap((fid) => {
              const f = m.features.get(fid)!
              return [...f.items.keys()].map((id) => ownOf(f.defs.get(id) ?? [{ root: 0 }]))
            }),
            m.featureOrder.reduce((a, fid) => {
              const f = m.features.get(fid)!
              return a + [...f.defs.values()].reduce((x, v) => x + Math.max(0, v.length - 1), 0)
            }, 0),
          ),
        }),
      )
    }
    if (p === '/api/mio/tree') {
      const T = ensureMio()
      if (!T) return send(res, 200, JSON.stringify({ ready: false, busy: MT_BUSY, error: MT_ERR }))
      const org = url.searchParams.get('org') ?? ''
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const onlyDlc = url.searchParams.get('onlyDlc') === '1'

      // 机构清单(不指定 org 时只回清单,前端据此渲染左栏)
      if (!org) {
        const list: Record<string, unknown>[] = []
        for (const id of T.order) {
          const o = T.orgs.get(id)
          if (!o) continue
          const nodes = orgTraits(T, id)
          if (q && !id.toLowerCase().includes(q)) continue
          if (onlyDlc && !o.hasDlc.length) continue
          /* ★ OWNERSHIP_V1:机构归属三态(原版 / 模组改写 / 模组新增)。
           *   注意 own 这个字段名原本是"自有特质数",这里改叫 ownTraits,
           *   把 own 留给统一的三态归属(全工作台同义)。 */
          const info = ownOf(T.orgVersions.get(id) ?? [{ root: o.root }])
          list.push({
            id, icon: o.icon, includes: o.includes,
            // ★ LOC_NAME_V1:本地化 key 优先取 name 属性(机构 name 即本地化键,如 kohat_armaments),无 name 用 id
            loc: o.name ?? id, // name 优先,回退 id
            hasDlc: o.hasDlc, gated: o.gated,
            count: nodes.length,
            ownTraits: nodes.filter((n) => !n.fromGeneric).length,
            ...ownJson(info),
            defs: (T.orgVersions.get(id) ?? []).map((d) => ({
              root: d.root, rootName: ROOTS[d.root]?.name ?? '', base: isBaseRoot(d.root),
              file: d.file, line: d.line,
            })),
            // 模组/tag 筛选(MIO_FILTER_V1):来源名 + 文件名推导的国家 tag
            ...rootOf(o.file),
            file: o.file, line: o.line,
          })
        }
        const orgOwn = T.order
          .map((id) => ownOf(T.orgVersions.get(id) ?? [{ root: T.orgs.get(id)?.root ?? 0 }]))
        return send(res, 200, JSON.stringify({
          ready: true, cell: MIO_CELL, issues: T.issues.slice(0, 200),
          stats: {
            // orgs = 生效集(同名机构已被模组替换,不重复计)
            orgs: T.orgs.size, traits: T.traits.size,
            issues: T.issues.length, ms: T.ms,
          },
          own: ownStatsJson(
            orgOwn,
            [...T.orgVersions.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
          ),
          sources: sourcesJson(),
          orgs: list,
        }))
      }

      // 单棵树的完整图数据
      const o = T.orgs.get(org)
      if (!o) return send(res, 404, JSON.stringify({ error: `未知机构 ${org}` }))
      const L = layoutMioTree(T, org)
      const nodes = orgTraits(T, org)
      const out: Record<string, unknown>[] = []
      for (const n of nodes) {
        if (q && !n.token.toLowerCase().includes(q) && !(n.icon ?? '').toLowerCase().includes(q)) continue
        if (onlyDlc && !n.hasDlc.length) continue
        const p = L.pos.get(n.token)
        if (!p) continue
        out.push({
          token: n.token, org: n.org,
          x: p.x, y: p.y, gx: n.gx, gy: n.gy, relTo: n.relTo,
          links: n.links, icon: n.icon, limitTo: n.limitTo,
          bonus: n.bonus, productionBonus: n.productionBonus,
          organizationModifier: n.organizationModifier,
          name: n.name,
          onComplete: n.onComplete, onCompleteText: n.onCompleteText,
          gates: n.gates, hasVisible: n.hasVisible, hasAvailable: n.hasAvailable,
          deleteIncluded: n.deleteIncluded, aiWillDo: n.aiWillDo,
          hasDlc: n.hasDlc, specialBg: n.specialBg,
          fromGeneric: n.fromGeneric,
          parentNum: n.parentNum, mutuallyExclusive: n.mutuallyExclusive,
          // ★ RIGHTCLICK_ROOT_V1:补来源序号,右键才能定位到模组里的文件
          ...rootOf(n.file),
          // 起始特质标记(引擎 2026-10-06 加):它是树的第一格,无前置
          initial: !!n.initial,
          file: n.file, line: n.line,
        })
      }
      return send(res, 200, JSON.stringify({
        ready: true, org,
        icon: o.icon, includes: o.includes, hasDlc: o.hasDlc, gated: o.gated,
        headers: o.headers, columns: L.columns, cell: L.cell,
        w: L.w, h: L.h,
        nodes: out,
        total: nodes.length,
        overrides: [...T.overrides.entries()]
          .filter(([k]) => k.startsWith(org + '#'))
          .map(([k, v]) => ({ token: k.slice(org.length + 1), ...v })),
        issues: T.issues.filter((i) => i.file === o.file).slice(0, 50),
      }))
    }

    if (p === '/api/mio/policies') {
      const T = ensureMio()
      if (!T) return send(res, 200, JSON.stringify({ ready: false, busy: MT_BUSY, error: MT_ERR }))
      return send(res, 200, JSON.stringify({ ready: true, policies: T.policies, total: T.policies.length }))
    }

    if (p === '/api/doctrines/graph') {
      const d = ensureDoctrines()
      if (!d) return send(res, 200, JSON.stringify({ ready: false, busy: DGR_BUSY, error: DGR_ERR }))
      const g = d.g
      const L = d.layout
      /* ★ OWNERSHIP_V1:学说也有覆盖 —— 模组改 folder / grand / track / subdoctrine
       *   同样是"同名整份替换"。旧代码注释写着"学说没有覆盖链概念",于是模组改的
       *   学说一律被判成原版。现在按 g.versions 逐条算三态。 */
      const src = url.searchParams.get('src') ?? ''
      const ownKeep = (id: string): OwnInfo => ownOf(g.versions.get(id) ?? [{ root: 0 }])
      const folderKeep = (r: number, id: string): boolean => {
        if (!src) return true
        if (src === 'base') return isBaseRoot(r)
        if (src === 'mod') return !isBaseRoot(r)
        if (src === 'vanilla') return ownKeep(id).own === 'vanilla'
        if (src === 'override') return ownKeep(id).own === 'override'
        if (src === 'new') return ownKeep(id).own === 'new'
        return ROOTS[r]?.name === src
      }
      const folders = g.folderOrder.filter((id) => folderKeep(g.folders.get(id)!.root, id))
      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          folders: folders.map((id) => {
            const f = g.folders.get(id)!
            const gds = [...g.grand.values()].filter((x) => x.folder === id)
            return {
              id: f.id,
              loc: f.loc ?? '',
              ledger: f.ledger ?? '',
              ledgerGfx: f.ledgerGfx ?? '',
              tabGfx: f.tabGfx ?? '',
              colorFrame: f.colorFrame ?? 0,
              dlcGated: f.dlcGated,
              hasDlc: f.hasDlc,
              count: gds.length,
              file: f.file,
              line: f.line,
              // ★ RIGHTCLICK_ROOT_V1:补来源序号(前端原本硬编码 0 = vanilla,
              //   导致右键「用 VS Code 打开」只会打开基础游戏的学说文件)
              root: f.root,
              rootName: ROOTS[f.root]?.name ?? '',
              ...ownJson(ownKeep(f.id)),
            }
          }),
          grand: [...g.grand.values()].map((x) => ({
            id: x.id,
            folder: x.folder,
            loc: x.loc ?? '',
            descLoc: x.descLoc ?? '',
            icon: x.icon ?? '',
            tex: iconTexId(x.icon ?? ''),
            xpCost: x.xpCost,
            xpType: x.xpType,
            tracks: x.tracks,
            milestones: x.milestones,
            effects: x.effects,
            gated: x.gated,
            pos: L.grandPos.get(x.id) ?? { col: 0, row: 0 },
            file: x.file,
            line: x.line,
            root: x.root,
            rootName: ROOTS[x.root]?.name ?? '',
            ...ownJson(ownKeep(x.id)),
          })),
          tracks: [...g.tracks.values()].map((x) => ({
            id: x.id,
            folder: x.folder,
            loc: x.loc ?? '',
            icon: x.icon ?? '',
            tex: iconTexId(x.icon ?? ''),
            background: x.background ?? '',
            iconFrame: x.iconFrame ?? '',
            masteryMultiplier: x.masteryMultiplier ?? null,
            masteryCategories: x.masteryCategories,
            masterySubUnits: x.masterySubUnits,
            pos: L.trackPos.get(x.id) ?? { col: 0, row: 0 },
            file: x.file,
            line: x.line,
            root: x.root,
            rootName: ROOTS[x.root]?.name ?? '',
            ...ownJson(ownKeep(x.id)),
          })),
          subdoctrines: [...g.subdoctrines.values()].map((x) => ({
            id: x.id,
            tracks: x.tracks,
            track: x.track,
            folder: x.folder,
            loc: x.loc ?? '',
            descLoc: x.descLoc ?? '',
            icon: x.icon ?? '',
            tex: iconTexId(x.icon ?? ''),
            xpCost: x.xpCost,
            xpType: x.xpType,
            rewards: x.rewards,
            xor: x.xor,
            siblings: g.siblings.get(x.id) ?? [],
            mastery: x.mastery ?? null,
            effects: x.effects,
            hasEffectScript: x.hasEffectScript,
            hasAiWillDo: x.hasAiWillDo,
            gated: x.gated,
            hasDlc: x.hasDlc,
            pos: L.subPos.get(x.id) ?? { col: 0, row: 0 },
            file: x.file,
            line: x.line,
            root: x.root,
            rootName: ROOTS[x.root]?.name ?? '',
            ...ownJson(ownKeep(x.id)),
          })),
          issues: g.issues,
          stats: {
            folders: g.folders.size,
            grand: g.grand.size,
            tracks: g.tracks.size,
            subdoctrines: g.subdoctrines.size,
            rewards: [...g.subdoctrines.values()].reduce((a, s) => a + s.rewards.length, 0),
            milestones: [...g.grand.values()].reduce((a, x) => a + x.milestones.length, 0),
            multiTrack: [...g.subdoctrines.values()].filter((s) => s.tracks.length > 1).length,
            xorDecl: [...g.subdoctrines.values()].filter((s) => s.xor.length > 0).length,
            ownMastery: [...g.subdoctrines.values()].filter((s) => !!s.mastery).length,
            dlcGatedFolders: [...g.folders.values()].filter((f) => f.dlcGated).length,
            issues: g.issues.length,
            ms: g.ms,
          },
          /** 归属三态:以 subdoctrine(层级最细、数量最多)为口径统计 */
          own: ownStatsJson(
            [...g.subdoctrines.keys()].map((id) => ownKeep(id)),
            [...g.versions.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
          ),
          sources: sourcesJson(),
        }),
      )
    }
    if (p === '/api/characters/graph') {
      return cacheSend(res, '/api/characters/graph' + (url.search ?? ''), () => {
        const g = ensureCharacters()
        if (!g) return { ready: false, busy: CG_BUSY, error: CG_ERR }
        const src = url.searchParams.get('src') ?? ''
        const keepOwn = (o: OwnInfo): boolean => {
          if (!src) return true
          if (src === 'base') return o.base
          if (src === 'mod') return !o.base
          if (src === 'vanilla') return o.own === 'vanilla'
          if (src === 'new' || src === 'modNew') return o.own === 'new'
          if (src === 'override' || src === 'overridden') return o.own === 'override'
          return true
        }
        const files = g.files
          .map((f) => ({
            rel: f.rel, root: f.root, rootName: f.rootName, base: f.base,
            own: ownJson(f.own), stale: f.stale,
            characters: f.characters
              .filter((c) => keepOwn(c.own))
              .map((c) => ({
                id: c.id, name: c.name, gender: c.gender,
                own: ownJson(c.own), stale: c.stale, base: c.base,
                portraits: c.portraits, roles: c.roles, instances: c.instances,
                allowedCivilWar: c.allowedCivilWar, hasDlcAll: c.hasDlcAll,
                file: c.file, line: c.line, root: c.root,
              })),
          }))
          .filter((f) => f.characters.length)
        const allChars = g.files.flatMap((f) => f.characters)
        const shownChars = files.flatMap((f) => f.characters)
        return {
          ready: true,
          files,
          sources: ROOTS.map((r) => ({ name: r.name, path: r.path, base: !r.writable })),
          own: ownStatsJson(allChars, allChars.filter((c) => c.stale).length),
          stats: {
            files: g.files.length, shownFiles: files.length,
            rawCharacters: g.stats.rawCharacters,
            characters: allChars.filter((c) => !c.stale).length,
            shownCharacters: shownChars.length,
            ms: g.stats.ms,
          },
        }
      }, (pl) => (pl as { ready?: boolean }).ready !== true)
    }
    if (p === '/api/units') {
      return cacheSend(res, '/api/units' + (url.search ?? ''), () => {
        const g = ensureUnits()
        if (!g) return { ready: false, busy: UG_BUSY, error: UG_ERR }
        const src = url.searchParams.get('src') ?? ''
        const keepOwn = (o: OwnInfo): boolean => {
          if (!src) return true
          if (src === 'base') return o.base
          if (src === 'mod') return !o.base
          if (src === 'vanilla') return o.own === 'vanilla'
          if (src === 'new' || src === 'modNew') return o.own === 'new'
          if (src === 'override' || src === 'overridden') return o.own === 'override'
          return true
        }
        const files = g.files
          .filter((f) => f.entries.some((e) => keepOwn(e.own)))
          .map((f) => ({
            rel: f.rel, group: f.group, kind: f.kind,
            root: f.root, rootName: f.rootName, base: f.base,
            own: ownJson(f.own), stale: f.stale,
            entries: f.entries.filter((e) => keepOwn(e.own)).map((e) => {
              const o: Record<string, unknown> = { ...e }
              o.own = ownJson(e.own)
              o.rootName = f.rootName
              o.defs = (e.defs || []).map((d) => ({ ...d, base: isBaseRoot(d.root) }))
              return o
            }),
          }))
        const groups: { key: string; files: typeof files }[] = []
        for (const f of files) {
          let gr = groups.find((x) => x.key === f.group)
          if (!gr) { gr = { key: f.group, files: [] }; groups.push(gr) }
          gr.files.push(f)
        }
        const allEntries = g.files.flatMap((f) => f.entries)
        const shownEntries = files.flatMap((f) => f.entries)
        return {
          ready: true,
          groups,
          sources: ROOTS.map((r) => ({ name: r.name, path: r.path, base: !r.writable })),
          own: ownStatsJson(allEntries, allEntries.filter((e) => e.stale).length),
          stats: {
            files: g.files.length, shownFiles: files.length,
            entries: allEntries.filter((e) => !e.stale).length, shownEntries: shownEntries.length,
            ms: g.stats.ms,
          },
        }
      }, (pl) => (pl as { ready?: boolean }).ready !== true)
    }
    if (p === '/api/decisions/graph') {
      const _gk = '/api/decisions/graph?src=' + (url.searchParams.get('src') ?? '')
      // PERF_DISK_V1(2026-10-10):decisions/graph 磁盘缓存(重启免 4s 重建)
      const _dSrc = url.searchParams.get('src') ?? ''
      const _dgSig = () => strSig([TEX_SCHEME, dirSig(ROOTS.map((r) => join(r.path, 'common/decisions'))) + '|rp:' + replacePathsSig()])
      if (!RESP_CACHE.has(_gk)) {
        const _c = loadCache<{ raw: string; gz: string; tex?: Record<string, TexEntry> }>('dec_graph_' + _dSrc, _dgSig())
        if (_c) { RESP_CACHE.set(_gk, { raw: Buffer.from(_c.raw, 'base64'), gz: Buffer.from(_c.gz, 'base64'), at: Date.now() }); restoreTexEntries(_c.tex) }; trimRespCache()
      }
      if (graphCacheSend(res, _gk)) return
      const g = ensureDecisions()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: DG_BUSY, error: DG_ERR }))
      /* src 取值与 focus 一致(另加 OWNERSHIP_V1 的三态):
       *   '' / 'base' / 'mod' / 'vanilla' / 'override' / 'new' / 具体来源名
       *   ('modNew' 继续兼容,等价于 'new')
       */
      const src = url.searchParams.get('src') ?? ''
      const nodeOwn = (d: { id: string; root: number }) =>
        ownOf(g.defs.get(d.id) ?? [{ root: d.root }])
      const catOwn = (id: string) => ownOf(g.catDefs.get(id) ?? [{ root: 0 }])
      const keep = (d: { id: string; root: number }): boolean => {
        if (!src) return true
        if (src === 'base') return !ROOTS[d.root]?.writable
        if (src === 'mod') return !!ROOTS[d.root]?.writable
        const o = nodeOwn(d)
        if (src === 'vanilla') return o.own === 'vanilla'
        if (src === 'new' || src === 'modNew') return o.own === 'new'
        if (src === 'override' || src === 'overridden') return o.own === 'override'
        return ROOTS[d.root]?.name === src
      }
      const cats = [...g.categories.values()]
        .map((c) => {
          /* ★ DECFILE_V1:三级「文件 → 决议类 → 决议」需要分类归属到它【生效定义所在文件】。
           *   catDefs 链末位 = 最高优先级来源的分类块所在文件(与游戏生效一致)。
           *   注意:分类内的决议各自的 file 可能≠分类的 file,须分别下发(前端据此标注)。 */
          const cd = g.catDefs.get(c.id) ?? []
          const eff = cd[cd.length - 1]
          return {
          id: c.id,
          icon: c.icon,
          column: g.column.get(c.id) ?? 0,
          tex: iconTexId(c.icon),
          file: eff?.file ?? '',
          root: eff?.root ?? 0,
          rootName: eff ? (g.roots[eff.root]?.name ?? '?') : '?',
          /* ★ CATCONTROL_V1:决议类自身的出现条件(allow/visible/…),不是决议
           *  graph 只下发「是否有该条件」,原文点决议类时走 /api/decisions/catdetail 拉取 */
          hasAllow: !!c.allowRaw,
          hasVisible: !!c.visibleRaw,
          hasAvailable: !!c.availableRaw,
          hasTargetTrigger: !!c.targetTriggerRaw,
          hasAiWillDo: !!c.aiWillDoRaw,
          priority: c.priority,
          picture: c.picture,
          cost: c.cost,
          daysRemove: c.daysRemove,
          isAlert: c.isAlert,
          ...(catOwn(c.id).own === 'new' ? { origin: 'mod' as const, overridden: false } : { origin: 'vanilla' as const, overridden: catOwn(c.id).own === 'override' }),
          ...ownJson(catOwn(c.id)),
          decisions: c.decisions
            .filter(keep)
            .map((d) => ({
              id: d.id,
              icon: d.icon,
              tex: iconTexId(d.icon),
              cost: d.cost,
              days: d.days,
              hasAvailable: d.hasAvailable,
              hasAllow: d.hasAllow,
              hasEffect: d.hasEffect,
              hasVisible: d.hasVisible,
              hasComplete: d.hasComplete,
              // ★ 脚本块原文已裁剪(182MB 主因):检查器点击时走 /api/decisions/detail 拉取
              file: d.file,
              line: d.line,
              root: d.root,
              rootName: g.roots[d.root]?.name ?? '?',
              base: !ROOTS[d.root]?.writable,
              ...nodeOwn(d),
            })),
          }
        })
        .filter((c) => c.decisions.length > 0 || !src)
      const keptDecisions = cats.reduce((a, c) => a + c.decisions.length, 0)
      /* 三态计数(不受 src 影响),给筛选器做角标。
       * ★ 口径是生效集:g.nodes 已是"同名后者替换前者",每个 id 只计一次,
       *   shadowed 是因此失效的旧版本数(只作展示,不进 effective)。 */
      const ownList = [...g.nodes.values()].map((n) => nodeOwn(n))
      const shadowed = [...g.defs.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0)
      const _outD = JSON.stringify({
          ready: true,
          sources: sourcesJson(),
          sourceStats: decisionSourceStats(g),
          originStats: { vanilla: ownList.filter((o) => o.own === 'vanilla').length, modNew: ownList.filter((o) => o.own === 'new').length, overridden: ownList.filter((o) => o.own === 'override').length },
          own: ownStatsJson(ownList, shadowed),
          categories: cats,
          stats: {
            categories: g.categories.size,
            nodes: g.nodes.size,
            shownCategories: cats.length,
            shownDecisions: keptDecisions,
          },
        })
      graphCacheSet(_gk, _outD)
      const _e = RESP_CACHE.get(_gk)
      if (_e) saveCache('dec_graph_' + _dSrc, _dgSig(), { raw: _e.raw.toString('base64'), gz: _e.gz.toString('base64'), tex: collectTexEntries(_outD) })
      // 命中响应缓存(刚 set 进去):直接发缓存,避免对同一 JSON 再 gzip 一次
      if (graphCacheSend(res, _gk)) return
      return send(res, 200, _outD)
    }
    /* ── 决议详情(DECISION_DETAIL_V1)──
     * graph 已裁剪决议 raw,检查器点击某决议时按 id 拉完整脚本块原文。不缓存(动态点查)。 */
    if (p === '/api/decisions/detail') {
      const g = ensureDecisions()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: DG_BUSY, error: DG_ERR }))
      const id = url.searchParams.get('id') ?? ''
      let found: any = null
      for (const c of g.categories.values()) {
        const d = c.decisions.find((x) => x.id === id)
        if (d) { found = d; break }
      }
      if (!found) return send(res, 200, JSON.stringify({ ready: true, found: false }))
      const defs = (g.defs.get(id) ?? []).map((x) => ({
        root: x.root, rootName: g.roots[x.root]?.name ?? '?', base: isBaseRoot(x.root), file: x.file, line: x.line,
      }))
      return send(res, 200, JSON.stringify({ ready: true, found: true, node: {
        id, icon: found.icon, cost: found.cost, days: found.days,
        hasAvailable: found.hasAvailable, hasAllow: found.hasAllow, hasEffect: found.hasEffect,
        hasVisible: found.hasVisible, hasComplete: found.hasComplete,
        availableRaw: (found as any).availableRaw ?? '',
        allowRaw: (found as any).allowRaw ?? '',
        visibleRaw: (found as any).visibleRaw ?? '',
        completeRaw: (found as any).completeRaw ?? '',
        removeEffectRaw: (found as any).removeEffectRaw ?? '',
        hiddenEffectRaw: (found as any).hiddenEffectRaw ?? '',
        modifierRaw: (found as any).modifierRaw ?? '',
        targetTriggerRaw: (found as any).targetTriggerRaw ?? '',
        aiWillDoRaw: (found as any).aiWillDoRaw ?? '',
        file: found.file, line: found.line, root: found.root,
      }}))
    }
    /* ── 决议类详情(CATDETAIL_V1)── 分类条件原文按需拉取 */
    if (p === '/api/decisions/catdetail') {
      const g = ensureDecisions()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: DG_BUSY, error: DG_ERR }))
      const id = url.searchParams.get('id') ?? ''
      const c = g.categories.get(id)
      if (!c) return send(res, 200, JSON.stringify({ ready: true, found: false }))
      return send(res, 200, JSON.stringify({ ready: true, found: true, node: {
        allowRaw: (c as any).allowRaw ?? '',
        visibleRaw: (c as any).visibleRaw ?? '',
        availableRaw: (c as any).availableRaw ?? '',
        targetTriggerRaw: (c as any).targetTriggerRaw ?? '',
        aiWillDoRaw: (c as any).aiWillDoRaw ?? '',
      }}))
    }
    /* ── AI 行为(AI_BEHAVE_V1)──
     * common/ai_* 按「方面(目录) → 文件 → 条目」三级下发,供页面逐个文件归纳。
     * src 语义与 decisions 完全一致,复用 originOf 判"模组新增/改写"。 */
    if (p === '/api/aibehave/graph') {
      const g = ensureAiBehavior()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: AB_BUSY, error: AB_ERR }))
      const src = url.searchParams.get('src') ?? ''

      /* ★ OWNERSHIP_V1:文件级(同名相对路径 = 整文件替换)与条目级(同 id = 替换)
       *   都走统一的三态判定。被替换掉的那份是"影子"(stale),默认不展示。 */
      const fileOwn = (aspectKey: string, file: string, root: number) =>
        ownOf(g.fileDefs.get(`${aspectKey}/${file}`) ?? [{ root }])
      const entryOwn = (aspectKey: string, kind: string, id: string, root: number) =>
        ownOf(g.defs.get(`${aspectKey}/${kind}/${id}`) ?? [{ root }])

      /** shadowed=1 时才把"被覆盖失效的旧版本"也列出来(默认只列生效集) */
      const wantShadowed = url.searchParams.get('shadowed') === '1'
      const keep = (o: OwnInfo): boolean => {
        if (!src) return true
        if (src === 'base') return o.base
        if (src === 'mod') return !o.base
        if (src === 'vanilla') return o.own === 'vanilla'
        if (src === 'new' || src === 'modNew') return o.own === 'new'
        if (src === 'override' || src === 'overridden') return o.own === 'override'
        return ROOTS[o.effective]?.name === src
      }
      /** 当前这份是不是已被更高优先级来源整份替换的旧版本 */
      const isStale = (root: number, o: OwnInfo): boolean => root !== o.effective

      const sourceStats: Record<string, { files: number; entries: number }> = {}
      for (const r of ROOTS) sourceStats[r.name] = { files: 0, entries: 0 }
      const fileOwnList: OwnInfo[] = []
      const entryOwnList: OwnInfo[] = []
      let shadowFiles = 0
      let shownFiles = 0
      let shownEntries = 0

      const aspects = g.aspects.map((a) => {
        // 生效集统计:每个 (方面/文件) 只计一次,每个 (方面/条目) 只计一次
        for (const f of a.files) {
          const fo = fileOwn(a.key, f.file, f.root)
          if (isStale(f.root, fo)) shadowFiles++
          else {
            fileOwnList.push(fo)
            const st = sourceStats[f.rootName]
            if (st) {
              st.files++
              st.entries += f.entries.length
            }
          }
        }
        for (const f of a.files) {
          if (isStale(f.root, fileOwn(a.key, f.file, f.root))) continue
          for (const e of f.entries) {
            const eo = entryOwn(a.key, e.kind, e.id, e.root)
            if (!isStale(e.root, eo)) entryOwnList.push(eo)
          }
        }

        const files = a.files
          .map((f) => {
            const fo = fileOwn(a.key, f.file, f.root)
            const stale = isStale(f.root, fo)
            const entries = f.entries
              .map((e) => {
                const eo = entryOwn(a.key, e.kind, e.id, e.root)
                return {
                  ...e,
                  base: !ROOTS[e.root]?.writable,
                  ...ownJson(eo),
                  stale: isStale(e.root, eo),
                }
              })
              .filter((e) => keep(entryOwn(a.key, e.kind, e.id, e.root)) && (wantShadowed || !e.stale))
            const fdefs = g.fileDefs.get(`${a.key}/${f.file}`) ?? [{ root: f.root, file: f.file, line: 1 }]
            return {
              ...f,
              entries,
              ...ownJson(fo),
              stale,
              base: !ROOTS[f.root]?.writable,
              defs: fdefs.map((d: { root: number; file: string; line: number }) => ({
                ...d,
                rootName: ROOTS[d.root]?.name ?? '',
                base: isBaseRoot(d.root),
              })),
            }
          })
          .filter((f) => keep(fileOwn(a.key, f.file, f.root)) && (wantShadowed || !f.stale))

        shownFiles += files.length
        shownEntries += files.reduce((s, f) => s + f.entries.length, 0)
        return {
          key: a.key,
          label: a.label,
          desc: a.desc,
          isFile: a.isFile,
          docFile: a.docFile ?? '',
          profile: a.profile,
          files,
          stats: {
            files: files.length,
            entries: files.reduce((s, f) => s + f.entries.length, 0),
            // allFiles/allEntries 仍是原始(含影子)计数,只在对账时用
            allFiles: a.files.length,
            allEntries: a.entries,
            modFiles: a.files.filter((f) => !!ROOTS[f.root]?.writable).length,
          },
        }
      })

      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          sources: sourcesJson(),
          sourceStats,
          originStats: {
            vanilla: fileOwnList.filter((o) => o.own === 'vanilla').length,
            modNew: fileOwnList.filter((o) => o.own === 'new').length,
            overridden: fileOwnList.filter((o) => o.own === 'override').length,
          },
          own: ownStatsJson(fileOwnList, shadowFiles),
          ownEntries: ownStatsJson(
            entryOwnList,
            [...g.defs.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
          ),
          aspects,
          stats: {
            aspects: g.aspects.length,
            /** 生效口径:文件数 / 条目数(同名只算一次) */
            files: fileOwnList.length,
            entries: entryOwnList.length,
            /** 原始口径(含被覆盖失效的旧版本),仅用于对账 */
            rawFiles: g.files,
            rawEntries: g.entries,
            shownFiles,
            shownEntries,
            ms: g.ms,
          },
        }),
      )
    }
    /* ── 内容生成器(GEN_STATS_V1)──────────────────────────────
     * /api/gen/schema  字段表(唯一数据源)+ 真实枚举取值 —— 前端表单照它渲染,
     *                不再自带手写镜像(以前三处各写一份,已经不同步)。
     * /api/gen/keys    条件/效果块可用的真实键(按频次)—— 挂在脚本框旁边,
     *                点一下就插入,新手不用猜 has_ 开头那些键叫什么。 */
    if (p === '/api/gen/schema') {
      const stats = ensureFieldStats()
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          ready: !!stats,
          error: FS_ERR,
          files: stats?.files ?? 0,
          ms: stats?.ms ?? 0,
          schema: genSchemaJson(),
        }),
      )
    }
    if (p === '/api/gen/keys') {
      const stats = ensureFieldStats()
      const v = getValidation()
      if (!stats || !v) return send(res, 200, JSON.stringify({ ok: false, error: FS_ERR || '统计未就绪', keys: [] }))
      // 脚本块内可用键 = 真实键白名单 ∩ 各类型的真实字段,按频次排序
      const all = new Map<string, number>()
      for (const k of Object.keys(stats.kinds)) {
        for (const f of stats.kinds[k].fields) all.set(f.key, (all.get(f.key) ?? 0) + f.n)
      }
      const keys = [...v.scriptKeys]
        .map((key) => ({ key, n: all.get(key) ?? 0 }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 300)
      return send(res, 200, JSON.stringify({ ok: true, keys }))
    }

    if (p === '/api/create') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 5_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const kind = (b.kind ?? 'focus') as GenKind
          const opts = (b.opts ?? {}) as Record<string, unknown>
          ensureFieldStats() // 首次生成时才建统计(约 1.6s),之后走缓存
          const r = generate(kind, opts)
          const files = r.files.map((f) => ({ path: f.path, content: f.content }))
          return send(
            res,
            200,
            JSON.stringify({
              ok: (r.warnings.length === 0) && !(r.errors?.length ?? 0),
              files,
              warnings: r.warnings,
              errors: r.errors ?? [],
            }),
          )
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    /* ══════════════════════════════════════════════════════════════
     * 制作闭环(MAKE_MOD_V1,2026-10-05)
     *
     * 之前这个工作台只能"看":脚手架(/api/create)生成的内容只回文本、
     * IDE 是只读的、也没有"新建模组"入口 —— 于是怎么也做不出模组。
     * 这里补齐三件事,让「建工程 → 产出内容 → 落盘 → 校验」成一条主线:
     *   /api/fs/write  整文件写(先备份 .bak),供 IDE 保存与脚手架落盘
     *   /api/mod/new   建模组骨架(descriptor.mod + .mod + 常用目录)并挂为可写来源
     *   /api/gen/save  脚手架生成后直接写进目标模组
     * ══════════════════════════════════════════════════════════════ */
    if (p === '/api/fs/write' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 20_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const rootIdx = Number(b.rootIdx)
          const file = String(b.file ?? '')
          const content = String(b.content ?? '')
          if (!ROOTS[rootIdx]) return send(res, 400, JSON.stringify({ error: '无效的来源序号' }))
          if (!file.trim()) return send(res, 400, JSON.stringify({ error: '缺少文件路径' }))
          const bad = badFileReqNoExist(rootIdx, file)
          if (bad) return send(res, 400, JSON.stringify({ error: bad }))
          const root = ROOTS[rootIdx]
          if (!root.writable) return send(res, 403, JSON.stringify({ error: `「${root.name}」是只读目录,拒绝写入` }))
          const abs = join(root.path, file)
          const isNew = !existsSync(abs)
          if (!isNew) {
            try { writeFileSync(abs + '.bak', readFileSync(abs)) } catch { /* 备份失败不阻断 */ }
          } else {
            mkdirSync(dirname(abs), { recursive: true })
          }
          writeFileSync(abs, content, 'utf8')
          softInvalidate([abs])
          console.log(`  写入文件[${root.name}] ${file} (${content.length} 字符)${isNew ? ' [新建]' : ' [覆盖+备份]'}`)
          return send(res, 200, JSON.stringify({ ok: true, file, created: isNew, backup: !isNew }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    /* ── 文件树操作:新建目录 / 重命名 / 删除(MAKE_MOD_V1 的"能改"闭环)── */
    const handleFsOp = (op: 'mkdir' | 'rename' | 'delete') => {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const rootIdx = Number(b.rootIdx)
          if (!ROOTS[rootIdx]) return send(res, 400, JSON.stringify({ error: '无效的来源序号' }))
          const root = ROOTS[rootIdx]
          if (!root.writable) return send(res, 403, JSON.stringify({ error: `「${root.name}」是只读目录,拒绝写入` }))
          if (READONLY) return send(res, 403, JSON.stringify({ error: '当前是只读模式,拒绝写入' }))

          if (op === 'mkdir') {
            const dir = String(b.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            if (!dir.trim()) return send(res, 400, JSON.stringify({ error: '缺少目录路径' }))
            const bad = badFileReqNoExist(rootIdx, dir)
            if (bad) return send(res, 400, JSON.stringify({ error: bad }))
            const abs = join(root.path, dir)
            if (existsSync(abs)) return send(res, 400, JSON.stringify({ error: '该目录已存在' }))
            mkdirSync(abs, { recursive: true })
            softInvalidate([abs])
            console.log(`  新建目录[${root.name}] ${dir}`)
            return send(res, 200, JSON.stringify({ ok: true, dir, abs }))
          }

          if (op === 'rename') {
            const from = String(b.from ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            const to = String(b.to ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            if (!from.trim() || !to.trim()) return send(res, 400, JSON.stringify({ error: '缺少 from/to' }))
            const badFrom = badFileReqNoExist(rootIdx, from)
            if (badFrom) return send(res, 400, JSON.stringify({ error: badFrom }))
            const badTo = badFileReqNoExist(rootIdx, to)
            if (badTo) return send(res, 400, JSON.stringify({ error: badTo }))
            const absFrom = join(root.path, from)
            const absTo = join(root.path, to)
            if (!existsSync(absFrom)) return send(res, 400, JSON.stringify({ error: '源路径不存在' }))
            if (existsSync(absTo)) return send(res, 400, JSON.stringify({ error: '目标路径已存在,拒绝覆盖' }))
            // 同目录内重命名(改文件名);跨目录则移动
            mkdirSync(dirname(absTo), { recursive: true })
            renameSync(absFrom, absTo)
            softInvalidate([absFrom, absTo])
            console.log(`  重命名[${root.name}] ${from} → ${to}`)
            return send(res, 200, JSON.stringify({ ok: true, from, to, abs: absTo }))
          }

          if (op === 'delete') {
            const path = String(b.path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            if (!path.trim()) return send(res, 400, JSON.stringify({ error: '缺少路径' }))
            const bad = badFileReqNoExist(rootIdx, path)
            if (bad) return send(res, 400, JSON.stringify({ error: bad }))
            const abs = join(root.path, path)
            if (!existsSync(abs)) return send(res, 400, JSON.stringify({ error: '路径不存在' }))
            // 防呆:禁止删根目录本身
            if (relative(root.path, abs).replace(/\\/g, '/') === '') {
              return send(res, 400, JSON.stringify({ error: '不能删除来源根目录' }))
            }
            const isDir = statSync(abs).isDirectory()
            rmSync(abs, { recursive: true, force: false })
            softInvalidate([abs])
            console.log(`  删除[${root.name}] ${path} (${isDir ? '目录' : '文件'})`)
            return send(res, 200, JSON.stringify({ ok: true, path, isDir }))
          }
          return send(res, 400, JSON.stringify({ error: '未知操作' }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/fs/mkdir' && req.method === 'POST') return handleFsOp('mkdir')
    if (p === '/api/fs/rename' && req.method === 'POST') return handleFsOp('rename')
    if (p === '/api/fs/delete' && req.method === 'POST') return handleFsOp('delete')

    if (p === '/api/mod/new' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          if (READONLY) return send(res, 403, JSON.stringify({ error: '当前是只读模式(--readonly),不能新建模组' }))
          const parent = String(b.parent ?? '').trim()
          const name = String(b.name ?? '').trim()
          if (!parent) return send(res, 400, JSON.stringify({ error: '缺少父目录' }))
          if (!name) return send(res, 400, JSON.stringify({ error: '缺少模组名' }))
          if (!existsSync(parent) || !statSync(parent).isDirectory()) {
            return send(res, 400, JSON.stringify({ error: '父目录不存在: ' + parent }))
          }
          const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim()
          if (!safe) return send(res, 400, JSON.stringify({ error: '模组名不合法' }))
          // 光替换分隔符不够:"..\\..\\evil" 会变成 ".._.._evil",虽不穿越但落个怪目录。
          // 名里带 ".." 一律拒绝,别替用户猜他想要什么。
          if (safe.includes('..')) return send(res, 400, JSON.stringify({ error: '模组名不能包含 ".."' }))
          const dir = join(parent, safe)
          if (existsSync(dir)) return send(res, 400, JSON.stringify({ error: '该目录已存在: ' + dir }))
          const version = String(b.version ?? '1.0').trim() || '1.0'
          const supported = String(b.supportedVersion ?? readGameVersion()).trim() || '1.16'
          const tags = Array.isArray(b.tags) ? b.tags.filter((t: unknown) => typeof t === 'string') : []
          const SKEL = [
            'common/national_focus', 'common/decisions', 'common/technologies', 'common/ideas',
            'common/events', 'common/countries', 'common/units/equipment',
            'events', 'localisation/english', 'interface', 'gfx/interface', 'history/countries',
          ]
          for (const d of SKEL) mkdirSync(join(dir, d), { recursive: true })
          const desc =
            `name = "${safe}"\n` +
            `version = "${version}"\n` +
            `supported_version = "${supported}"\n` +
            `path = "${dir.replace(/\\/g, '/')}"\n` +
            (tags.length ? `tags = { ${tags.join(' ')} }\n` : '')
          writeFileSync(join(dir, 'descriptor.mod'), desc, 'utf8')
          // 同名 .mod 放在父目录 —— 复制到 HOI4 的 mod 目录即可在启动器里勾上
          const modFile = join(parent, safe + '.mod')
          writeFileSync(modFile, desc, 'utf8')
          // 挂成可写来源并写进设置(下次启动仍在)
          ROOTS.push({ name: safe, path: dir, writable: true })
          try {
            const s = loadSettings() ?? { base: (ROOTS.find((r) => !r.writable) ?? ROOTS[0]).path, mods: [], display: defaultDisplay() }
            s.mods = normalizeMods(s.mods).filter((m) => !samePath(m.path, dir))
            s.mods.push({ path: dir, enabled: true })
            saveSettings(s)
          } catch (e) {
            console.log('  [警告] 新模组写入设置失败(不影响已创建的目录): ' + e)
          }
          rebuildIndexes()
          console.log(`  新建模组: ${dir} (${SKEL.length} 个目录 + descriptor.mod)`)
          return send(res, 200, JSON.stringify({
            ok: true, dir, modFile, name: safe,
            rootIdx: ROOTS.length - 1, descriptor: desc, files: SKEL.length,
          }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    if (p === '/api/gen/save' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 20_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const kind = (b.kind ?? 'focus') as GenKind
          const opts = (b.opts ?? {}) as Record<string, unknown>
          const rootIdx = Number(b.rootIdx)
          const root = ROOTS[rootIdx]
          if (!root) return send(res, 400, JSON.stringify({ error: '目标来源不存在,请先挂载一个可写模组' }))
          if (!root.writable) return send(res, 403, JSON.stringify({ error: `「${root.name}」是只读目录,拒绝写入` }))
          const r = generate(kind, opts)
          const written: { path: string; created: boolean; size: number }[] = []
          const changed: string[] = []
          for (const f of r.files) {
            const rel = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '')
            if (!safeJoin(root.path, rel)) return send(res, 400, JSON.stringify({ error: '生成路径越界: ' + rel }))
            const abs = join(root.path, rel)
            const isNew = !existsSync(abs)
            if (!isNew) {
              try { writeFileSync(abs + '.bak', readFileSync(abs)) } catch { /* 备份失败不阻断 */ }
            } else {
              mkdirSync(dirname(abs), { recursive: true })
            }
            writeFileSync(abs, f.content, 'utf8')
            written.push({ path: rel, created: isNew, size: f.content.length })
            changed.push(abs)
          }
          softInvalidate(changed)
          console.log(`  脚手架落盘[${root.name}]: ${kind} → ${written.length} 个文件`)
          return send(res, 200, JSON.stringify({ ok: true, rootName: root.name, written, warnings: r.warnings }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    /* 全量重建索引(新建模组 / 手工往目录里扔文件之后用)。
     * 与写盘后的 softInvalidate 区别:这里会重扫贴图名册,慢但彻底。 */
    if (p === '/api/reload' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const t = Date.now()
          rebuildIndexes()
          return send(res, 200, JSON.stringify({ ok: true, ms: Date.now() - t, sources: sourcesJson() }))
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }

    /* ══════════════════════════════════════════════════════════════
     * AIDE_V1 —— AI 开发接口
     *
     *  GET  /api/ai/config    读配置(**永不返回 apiKey 本体**,只给 hasKey + 打码预览)
     *  POST /api/ai/config    写配置
     *  POST /api/ai/models    拉上游模型列表
     *  POST /api/ai/chat      SSE 流式对话(含工具调用循环)
     *  POST /api/ai/apply     把某个预览 diff 真正落盘(用户点了「应用」才走)
     *  POST /api/ai/preview   按 id 取回预览(diff 刷新页面后仍可应用)
     * ══════════════════════════════════════════════════════════════ */
    if (p.startsWith('/api/ai/')) {
      const deps: AiDeps = {
        roots: () => ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })),
        safeJoin,
        links: () => ensureLinks(),
        check: () => ensureCheck(),
        loc: () => ensureLoc(),
        readDoc: (rel: string) => {
          /* 文档有两个来源:official(引擎自带 md)与 common(模组/游戏里的 md)。
           * 依次试,与 /api/docs/list 的 kind 语义一致。*/
          const official = readDocSafe(rel)
          if (official) return official
          for (let ri = 0; ri < ROOTS.length; ri++) {
            const abs = safeDocPath(ROOTS[ri].path, rel, 'common')
            if (!abs) continue
            try {
              return { text: readFileSync(abs, 'utf8') }
            } catch { /* 试下一个来源 */ }
          }
          return null
        },
        listDocs: () => ({
          files: [
            ...scanDocsCached('official').map((f) => ({ path: f.rel, title: f.title })),
            ...scanDocsCached('common').map((f) => ({ path: f.rel, title: f.title })),
          ],
        }),
        writeFile: (rootIdx, rel, content) => {
          const root = ROOTS[rootIdx]
          if (!root) return { ok: false, error: '来源不存在' }
          if (!root.writable) return { ok: false, error: `「${root.name}」是只读来源,拒绝写入` }
          const abs = safeJoin(root.path, rel)
          if (!abs) return { ok: false, error: '路径越界' }
          const isNew = !existsSync(abs)
          if (!isNew) {
            try { writeFileSync(abs + '.bak', readFileSync(abs)) } catch { /* 备份失败不阻断 */ }
          } else {
            mkdirSync(dirname(abs), { recursive: true })
          }
          writeFileSync(abs, content, 'utf8')
          softInvalidate([abs])
          return { ok: true, backup: !isNew, created: isNew }
        },
        invalidate: (abs) => softInvalidate([abs]),
      }

      /* ── GET /api/ai/config ── */
      if (p === '/api/ai/config' && req.method === 'GET') {
        const s = loadSettings()
        const cfg = { ...defaultAiConfig(), ...(s?.ai ?? {}) } as AiConfig
        const prov = AI_PROVIDERS.find((x) => x.id === cfg.provider) ?? AI_PROVIDERS[0]
        /* 密钥来源标注:让用户知道 key 到底从哪来(文件 or 环境变量) */
        const envNames = [`HOI4_AI_KEY_${cfg.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, 'HOI4_AI_KEY']
        const fromEnv = envNames.find((n) => process.env[n]?.trim())
        return send(res, 200, JSON.stringify({
          config: {
            provider: cfg.provider,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            allowWrite: cfg.allowWrite,
            allowHeavy: cfg.allowHeavy,
          },
          /* ★ 绝不下发 key 本体 */
          hasKey: !!(cfg.apiKey?.trim()) || !!fromEnv,
          keySource: fromEnv ? 'env' : cfg.apiKey?.trim() ? 'file' : 'none',
          keyPreview: cfg.apiKey?.trim() ? redactKey(cfg.apiKey.trim()) : '',
          needsKey: prov.needsKey,
          providers: AI_PROVIDERS.map((x) => ({ id: x.id, label: x.label, protocol: x.protocol, baseUrl: x.baseUrl, models: x.models, needsKey: x.needsKey, tag: x.tag ?? '' })),
        }))
      }

      /* ── POST /api/ai/config ── */
      if (p === '/api/ai/config' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy() })
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}') as Partial<AiConfig> & { clearKey?: boolean }
            const s = loadSettings() ?? { base: ROOTS[0]?.path ?? '', mods: [], display: defaultDisplay() }
            const prev = { ...defaultAiConfig(), ...(s.ai ?? {}) } as AiConfig
            const next: AiConfig = {
              provider: typeof b.provider === 'string' && AI_PROVIDERS.some((x) => x.id === b.provider) ? b.provider : prev.provider,
              baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl.trim() : prev.baseUrl,
              model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : prev.model,
              temperature: typeof b.temperature === 'number' ? Math.max(0, Math.min(2, b.temperature)) : prev.temperature,
              maxTokens: typeof b.maxTokens === 'number' ? Math.max(256, Math.min(131072, b.maxTokens)) : prev.maxTokens,
              allowWrite: typeof b.allowWrite === 'boolean' ? b.allowWrite : prev.allowWrite,
              allowHeavy: typeof b.allowHeavy === 'boolean' ? b.allowHeavy : prev.allowHeavy,
              apiKey: b.clearKey ? '' : typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : prev.apiKey,
            }
            s.ai = next
            saveSettings(s)
            /* 日志只打 provider/model 与「有没有 key」,绝不打 key 本身 */
            console.log(`  [AI] 配置已更新:${next.provider} / ${next.model} | 写权限:${next.allowWrite ? '开' : '关'}`)
            return send(res, 200, JSON.stringify({ ok: true, hasKey: !!next.apiKey?.trim() }))
          } catch (e) {
            return send(res, 400, JSON.stringify({ error: String(e) }))
          }
        })
        return
      }

      /* ── POST /api/ai/models ── */
      if (p === '/api/ai/models' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy() })
        req.on('end', () => {
          void (async () => {
            try {
              const b = JSON.parse(body || '{}') as Partial<AiConfig>
              const s = loadSettings()
              const cfg = { ...defaultAiConfig(), ...(s?.ai ?? {}), ...b } as AiConfig
              const r = await aiListModels(cfg)
              return send(res, 200, JSON.stringify(r))
            } catch (e) {
              return send(res, 400, JSON.stringify({ error: String(e) }))
            }
          })()
        })
        return
      }

      /* ── POST /api/ai/preview:取回预览 ── */
      if (p === '/api/ai/preview' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy() })
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}') as { id?: string }
            const it = getPreview(String(b.id ?? ''))
            if (!it) return send(res, 404, JSON.stringify({ error: '预览已过期,重新让 AI 生成一次' }))
            return send(res, 200, JSON.stringify(it))
          } catch (e) {
            return send(res, 400, JSON.stringify({ error: String(e) }))
          }
        })
        return
      }

      /* ── POST /api/ai/apply:把预览落盘 ── */
      if (p === '/api/ai/apply' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 20_000_000) req.destroy() })
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}') as { id?: string }
            const id = String(b.id ?? '')
            const it = getPreview(id)
            if (!it) return send(res, 404, JSON.stringify({ error: '预览已过期,重新让 AI 生成一次' }))
            const s = loadSettings()
            const cfg = { ...defaultAiConfig(), ...(s?.ai ?? {}) } as AiConfig
            /* ★ 二次校验:预览是 allowWrite=false 时生成的,不许事后落盘 */
            if (!cfg.allowWrite) return send(res, 403, JSON.stringify({ error: '写权限已关闭,拒绝应用' }))
            const r = deps.writeFile(it.rootIdx, it.file, it.after)
            if (!r.ok) return send(res, 400, JSON.stringify({ error: r.error }))
            dropPreview(id)
            console.log(`  [AI] 已应用改动[${it.rootName}] ${it.file} (${it.bytes} 字符)${r.created ? ' [新建]' : ' [备份 .bak]'}`)
            return send(res, 200, JSON.stringify({ ok: true, file: it.file, root: it.rootName, ...r }))
          } catch (e) {
            return send(res, 400, JSON.stringify({ error: String(e) }))
          }
        })
        return
      }

      /* ── POST /api/ai/chat:SSE 流式 ── */
      if (p === '/api/ai/chat' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 8_000_000) req.destroy() })
        req.on('end', () => {
          void (async () => {
            let msgs: ChatMessage[] = []
            let curFile = ''
            try {
              const b = JSON.parse(body || '{}') as { messages?: ChatMessage[]; curFile?: string }
              msgs = Array.isArray(b.messages) ? b.messages : []
              curFile = typeof b.curFile === 'string' ? b.curFile : ''
            } catch {
              /* 解析失败按空消息处理,下面统一报「消息为空」 */
            }
            const s = loadSettings()
            const cfg = { ...defaultAiConfig(), ...(s?.ai ?? {}) } as AiConfig
            if (!msgs.length) {
              return send(res, 400, JSON.stringify({ error: '消息为空' }))
            }
            const prov = AI_PROVIDERS.find((x) => x.id === cfg.provider) ?? AI_PROVIDERS[0]
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            let alive = true
            /** 断连回调:由 runChat 通过 onDisconnect 注册,res 关闭时触发 */
            let onCloseHook: (() => void) | null = null
            /* ★★ 必须监听 **res** 的 close,不能监听 req 的。
             *   Node 16+ 的 `req` 在「请求体读完」后就会触发 `close`,
             *   跟客户端是否断开**无关** —— 挂在 req 上的话,第一个事件刚发
             *   就被判成「客户端已走」,SSE 流全被吞掉(症状:响应头正常但
             *   流里一个字节都没有,curl --max-time 到点才返回)。
             *   真正的断开信号是 res/socket 的 close。*/
            res.on('close', () => { alive = false; try { onCloseHook?.() } catch { /* 忽略 */ } })
            const onEvent = (e: SseEvent): boolean => {
              if (!alive) return false
              try {
                res.write(`data: ${JSON.stringify(e)}\n\n`)
                /* Node 的 socket 写缓冲可能堆积,主动 flush 让 token 立刻到浏览器 */
                ;(res as unknown as { flush?: () => void }).flush?.()
                return true
              } catch {
                return false
              }
            }
            /* done 只发一次:runChat 正常收尾时自己会发,这里兜底补发
             * (它只在「抛异常」或「没发过」时才需要)。*/
            let doneSent = false
            const emit = (e: SseEvent): boolean => {
              if (e.type === 'done') doneSent = true
              return onEvent(e)
            }
            try {
              await runChat(deps, cfg, msgs, {
                curFile,
                onEvent: emit,
                /* ★ 客户端断开时通知 runner 中止 fetch ——
                 * 否则用户关掉面板,上游还在按 maxTokens 烧 token。*/
                onDisconnect: (fn) => { onCloseHook = fn },
              })
            } catch (e) {
              emit({ type: 'error', text: String(e) })
            }
            if (!doneSent) emit({ type: 'done' })
            try { res.end() } catch { /* 客户端已断 */ }
            void prov
          })()
        })
        return
      }

      /* 未知 /api/ai/* 子路由 */
      return send(res, 404, JSON.stringify({ error: `未知的 AI 接口 ${p}` }))
    }

    if (p === '/api/focus/graph') {
      const g = ensureFocus()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: FG_BUSY, error: FG_ERR }))
      const tag = url.searchParams.get('tag') ?? ''
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      /* src 取值:
       *   ''       全部
       *   'base'   最终生效版本来自基础游戏
       *   'mod'    最终生效版本来自模组(任一)
       *   'vanilla'  原版内容(模组没有同名覆盖它)
       *   'override' 原版有但被模组改写(= 旧的 'overridden')
       *   'new'      模组新增(原版没有这棵树,= 旧的 'modNew')
       *   其他     指定来源名
       */
      const src = url.searchParams.get('src') ?? ''
      const treeOwn = (t: { id: string; root: number }) => ownOf(g.versions.get(t.id) ?? [{ root: t.root }])
      let list = [...g.byId.values()]
      if (src) {
        list = list.filter((t) => {
          const o = treeOwn(t)
          if (src === 'base') return !ROOTS[t.root]?.writable
          if (src === 'mod') return !!ROOTS[t.root]?.writable
          if (src === 'vanilla') return o.own === 'vanilla'
          if (src === 'new' || src === 'modNew') return o.own === 'new'
          if (src === 'override' || src === 'overridden') return o.own === 'override'
          return ROOTS[t.root]?.name === src
        })
      }
      if (tag) list = list.filter((t) => t.tags.includes(tag))
      if (q) list = list.filter((t) => t.id.toLowerCase().includes(q) || t.tags.some((x) => x.toLowerCase().includes(q)))
      list.sort((a, b) => a.id.localeCompare(b.id))
      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          sources: sourcesJson(),
          sourceStats: focusSourceStats(g),
          originStats: focusOriginStats(g),
          own: ownStatsJson(
            [...g.byId.values()].map((t) => treeOwn(t)),
            [...g.versions.values()].reduce((a, v) => a + Math.max(0, v.length - 1), 0),
          ),
          trees: list.map((t) => focusTreeJson(g, t)),
          stats: {
            trees: g.trees.length,
            unique: g.byId.size,
            shown: list.length,
            nodes: g.nodes.size,
            shared: g.sharedIds.length,
            joint: g.jointIds.length,
          },
        }),
      )
    }
    if (p === '/api/focus/tree') {
      const id = url.searchParams.get('id') ?? ''
      // 画布内的节点级过滤:空 = 全部;'base'/'mod'/来源名 同上。
      // 只影响"显示",bbox 仍用全量节点算,避免筛选后画布缩放跳动。
      const src = url.searchParams.get('src') ?? ''
      const g = ensureFocus()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: FG_BUSY, error: FG_ERR }))
      const t = g.byId.get(id)
      if (!t) return send(res, 404, JSON.stringify({ error: `找不到树 ${id}` }))
      const all = treeNodes(g, t)
      const keep = (n: FocusNode): boolean => {
        if (!src) return true
        const { origin, overridden } = originOf((g.defs.get(n.id) ?? [{ root: n.root }]).map((d) => d.root))
        if (src === 'base') return !ROOTS[n.root]?.writable
        if (src === 'mod') return !!ROOTS[n.root]?.writable
        if (src === 'vanilla') return origin === 'vanilla'
        if (src === 'modNew') return origin === 'mod'
        if (src === 'overridden') return overridden
        return ROOTS[n.root]?.name === src
      }
      const ns = src ? all.filter(keep) : all
      const inTree = new Set(ns.map((n) => n.id))
      /* 连线:前置(实线)/ 互斥(虚线)/ 或选(点线);只画两端都在本树的。
       *
       * ★★★ OR_V1(2026-10-07,对齐 HOI4 Mod Utilities):
       *   ① `OR = { focus = X }` 的边**必须单列成一种线型**(kind='or')。
       *      旧版把它并进 prereq(实线),看图的人以为"两者都要完成",
       *      实际是"任选其一" —— 判断依据就错了。
       *   ② allow_branch 是**传递门控**:若 A 的 allow_branch 要求 B 完成,
       *      而 A 是 C 的前置,那么 C 也间接需要 B 完成。
       *      游戏里这条链是隐式的,不画出来就会出现
       *      "勾了 B,C 还是灰的"这种"点了没反应"。
       */
      type FEdge = { from: string; to: string; kind: 'prereq' | 'mutex' | 'branch' | 'or' }
      const edges: FEdge[] = []
      const seenEdge = new Set<string>()
      const push = (from: string, to: string, kind: FEdge['kind']) => {
        if (!inTree.has(from) || !inTree.has(to)) return
        const k = kind + '|' + from + '|' + to
        if (seenEdge.has(k)) return
        seenEdge.add(k)
        edges.push({ from, to, kind })
      }
      for (const n of ns) {
        for (const p2 of n.prereq) push(p2, n.id, 'prereq')
        for (const m of n.mutex) if (n.id < m) push(n.id, m, 'mutex')
        for (const b of n.branch) push(n.id, b, 'branch')
        // OR 边:与 prereq 同源,但线型不同
        for (const grp of n.prereqGroups || []) {
          for (const or of grp.or) for (const o of or) push(o, n.id, 'or')
        }
        for (const grp of n.mutexGroups || []) {
          for (const or of grp.or) for (const o of or) if (n.id < o) push(n.id, o, 'or')
        }
      }
      /* ★ allow_branch 传递闭包(见上②)。
       * 算法:反复扫描 —— 若 X 已隐式依赖 B(在 B 的传递闭包里),
       * 而某节点 N 的前置是 X,则 N 也要依赖 B。
       * 用不动点迭代:每轮把新学到的门控沿前置边下推,直到没有新增。
       * 深度上限 32 层防御脏数据成环(prerequisite 理论上不该成环)。 */
      const gateOf = new Map<string, Set<string>>()
      for (const n of ns) {
        const s = new Set<string>()
        for (const b of n.branch) if (inTree.has(b)) s.add(b)
        if (s.size) gateOf.set(n.id, s)
      }
      if (gateOf.size) {
        const fwd = new Map<string, string[]>() // 前置 → 依赖它的节点
        for (const e of edges) {
          if (e.kind !== 'prereq') continue
          const arr = fwd.get(e.from)
          if (arr) arr.push(e.to)
          else fwd.set(e.from, [e.to])
        }
        for (let round = 0; round < 32; round++) {
          let changed = false
          for (const [id, gates] of gateOf) {
            for (const child of fwd.get(id) || []) {
              let cg = gateOf.get(child)
              if (!cg) { gateOf.set(child, (cg = new Set())); changed = true }
              for (const g of gates) {
                if (!cg.has(g)) { cg.add(g); changed = true }
              }
            }
          }
          if (!changed) break
        }
        for (const [id, gates] of gateOf) {
          for (const g of gates) if (g !== id) push(g, id, 'branch')
        }
      }
      const xs = all.map((n) => n.ax)
      const ys = all.map((n) => n.ay)
      /* ★ TRIGGERS_V1:汇总本树所有「可做成 UI 开关」的条件。
       * 对齐 MU 的 allowBranchOptions —— 它把这批 key 渲染成
       * #allowbranch-container 里的一排多选框,用户勾选哪些分支,
       * 页面就按那组scope 重算显隐与 offset。
       * 【口径】每个条件【叶子】一条,不是每个国策一条 ——
       *   UI 上要显示的是"要不要 DLC X""已完成 focus Y"这些具体条件,
       *   而"某个国策有哪些条件"是检查器的事。 */
      /* TRIGGERS_V1: 全树唯一条件清单(对齐 MU 的 conditionExprs)。
       * ★ 口径照搬 MU web-extension.js 的 yg():只收 allow_branch + offset.trigger
       *   (+ MU 还收 icon.condition,本项目科技/国策暂不追踪 icon 条件,略)。
       *   【不含】available / visible —— 那是显形/可用性判断,不是"分支显形开关",
       *   混进来会出现 1003 = { is_owned_and_controlled_by = ROOT } 这类省份键,
       *   把面板淹成噪音。nodeContent 去重。 */
      const conds = new Map<string, { nodeContent: string; key: string; count: number }>()
      for (const n of all) {
        collectConditions(n.allowBranchTrig, conds)
        for (const r of n.offsetRules ?? []) collectConditions(r.trigger, conds)
      }
      return send(
        res,
        200,
        JSON.stringify({
          ready: true,
          tree: focusTreeJson(g, t),
          nodes: ns.map((n) => focusNodeJson(n, g)),
          totalNodes: all.length,
          edges,
          /** GAMERULE_DEFAULT_V1:各游戏规则默认选项(has_game_rule 求值基准) */
          gameRules: loadGameRuleDefaults(),
          /** TRIGGERS_V1:本树唯一条件清单(前端渲染条件面板用,对齐 MU conditionExprs) */
          conditions: [...conds.values()].sort(
            (a, b) => a.key.localeCompare(b.key) || b.count - a.count,
          ),
          /** shortcut 明细:画布上画跳转线 + 检查器列表。inTree=false = target 不在本树(模组数据错) */
          shortcuts: shortcutJson(t, new Set(all.map((n) => n.id))),
          bbox: {
            minX: xs.length ? Math.min(...xs) : 0,
            maxX: xs.length ? Math.max(...xs) : 0,
            minY: ys.length ? Math.min(...ys) : 0,
            maxY: ys.length ? Math.max(...ys) : 0,
          },
        }),
      )
    }
    if (p === '/api/focus/save' || p === '/api/focus/preview') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 20_000_000) req.destroy()
      })
      req.on('end', () => {
      try {
        const g = ensureFocus()
        if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: FG_BUSY, error: FG_ERR }))
        let req0: { moves?: FocusMove[]; apply?: boolean } = {}
        try {
          req0 = JSON.parse(body || '{}')
        } catch {
          return send(res, 400, JSON.stringify({ error: '请求体不是合法 JSON' }))
        }
        const moves = (req0.moves ?? []).filter((m) => m.x !== undefined || m.y !== undefined)
        if (!moves.length) return send(res, 200, JSON.stringify({ ready: true, written: false, results: [], reason: '没有改动' }))
        const patches = planFocusMove(g, moves)
        const dry = p === '/api/focus/preview' || !req0.apply
        const results: unknown[] = []
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        for (const pt of patches) {
          const base = patchJson(pt)
          if (!pt.guard.ok) {
            results.push({ file: pt.file, written: false, reason: `守卫失败: ${pt.guard.message}`, ...base })
            continue
          }
          if (!pt.details.length) {
            results.push({ file: pt.file, written: false, reason: '无实际改动', ...base })
            continue
          }
          if (dry) {
            results.push({ file: pt.file, written: false, reason: '预览', ...base })
            continue
          }
          results.push({ file: pt.file, ...commitPatch(pt, stamp), ...base })
        }
        return send(res, 200, JSON.stringify({ ready: true, written: !dry, results }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
      })
      return
    }
    if (p === '/api/focus/lint') {
      const id = url.searchParams.get('id') ?? ''
      const g = ensureFocus()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: FG_BUSY, error: FG_ERR }))
      const issues = lintFocus(g, {
        tree: id || undefined,
        hasSprite: (n: string) => spriteIdx.get(n) !== undefined,
      })
      return send(res, 200, JSON.stringify({ ready: true, issues }))
    }
    /* ══════════════════════════════════════════════════════════════════
     * World Map preview(参考 HOI4 Mod Utilities 的世界地图预览)
     *
     * ★ 多来源合成(MAPMODEL_V1),不再是「只读基础游戏」——
     *   实测本机 36 个创意工坊模组里 11 个自带 map/,`history/states`
     *   更是 11 个模组都用 replace_path 改过。所以必须按载入序 + replace_path
     *   逐个资产判归属,再合成。详见 buildWorldMap 的注释。
     *
     * 数据来源:
     *   - map/provinces.bmp    :每像素颜色 = 省份 id(由 definition.csv 映射)
     *   - map/definition.csv   :province id → (r,g,b) 颜色
     *   - history/states/*.txt :state → provinces + owner(国家 tag)  ★ 目录级判定
     *   - common/countries/*.txt:tag → color                        ★ 目录级判定
     * 省份质心不读 positions.txt(vanilla 安装里它是空文件),改为遍历
     * provinces.bmp 按颜色聚合求质心 —— 与 HOI4 Mod Utilities 一致。
     *
     * ★ bmp 与 definition.csv 必须同源,否则颜色映射整体错位;
     *   不同源时 buildWorldMap 直接抛错并在这里回传,不会静默出一张错图。
     * ═════════════════════════════════════════════════════════════════ */
    /* DLC 勾选(DLC_TOGGLE_V1,2026-10-07)
     * POST body: { on: ["dlc049_no_compromise_no_surrender", ...] }
     * ★ 传的是**目录名**,不是 .dlc 里的正式名 —— 因为 enabled 判定要落到
     *   扫描结果上;正式名(has_dlc 用的那个)由引擎 matchDlc 负责对上。*/
    if (p === '/api/worldmap/dlc' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy() })
      req.on('end', () => {
        let on: string[] = []
        try {
          const j = JSON.parse(body || '{}')
          if (Array.isArray(j.on)) on = j.on.filter((x) => typeof x === 'string')
        } catch {
          return send(res, 400, JSON.stringify({ error: 'body 不是合法 JSON' }))
        }
        try {
          WM_DLC_ON = new Set(on)
          invalidateWorldMap()
          const m = buildWorldMap()
          return send(res, 200, JSON.stringify({
            ok: true,
            enabled: [...WM_DLC_ON],
            gates: m?.dlc.gates.byDlc ?? {},
            gateTotal: m?.dlc.gates.refs.length ?? 0,
          }))
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/worldmap/meta') {
      return cacheSend(res, '/api/worldmap/meta', () => {
        const m = buildWorldMap()
        if (!m) return { ready: false, error: WM_ERR || '构建中' }
        return {
          ready: true,
          w: m.w,
          h: m.h,
          provinces: m.provinces,
          // 图例用「地图里真正出现的国家」,不是全部 countries 定义
          owners: m.countries,
          // 国家抽屉(左侧 Tag 检视器)需要全部国家定义(含未上图的),与 owners 同源
          countries: m.countries,
          stats: m.stats,
          issues: m.issues,
          sources: m.sources,
          // 生效位图/csv 的来源,前端要显式展示,否则用户不知道在看谁的地图
          bitmapRoot: m.bitmapRoot,
          definitionRoot: m.definitionRoot,
          // 地图资产逐项归属(原版/模组改写/模组新增/缺口)
          assets: [...m.assets.refs.values()].map((r) => ({
            path: r.path,
            own: r.own,
            effective: r.effective,
            chain: r.chain,
            deletedBy: r.deletedBy,
            gapBy: r.gapBy,
          })),
          statesDir: {
            stats: m.statesDir.stats,
            effective: m.statesDir.effective,
            dropped: m.statesDir.dropped.slice(0, 200),
          },
          /* STATE_DETAIL(2026-10-07):state 全字段。
           * 原来只下发 owner/provinces,页面上只能显示"谁占的";
           * 用户要判断的是"这地方值不值得抢" —— 人力/分类/资源/建筑/
           * 核心国/胜利点都得能看到。逐 state 下发,由前端按 id 建索引。*/
          states: m.states.map((s) => ({
            id: s.id,
            name: s.name,
            owner: s.owner,
            provinces: s.provinces,
            own: s.own,
            root: s.root,
            file: s.file,
            manpower: s.manpower,
            stateCategory: s.stateCategory,
            localSupplies: s.localSupplies,
            resources: s.resources,
            victoryPoints: s.victoryPoints,
            buildings: s.buildings,
            cores: s.cores,
            dlcGated: s.dlcGated,
          })),
          /* 战略区域(全字段):右键定位 / 点击详情 / 左侧战略区域抽屉都依赖 meta.strategicRegions */
          strategicRegions: m.strategicRegions.map((r) => ({
            id: r.id,
            name: r.name,
            file: r.file,
            path: r.path,
            provinces: r.provinces,
            weather: r.weather,
            navalTerrain: r.navalTerrain,
            staticModifiers: r.staticModifiers,
            own: r.own,
            root: r.root,
          })),
          strategicRegionsDir: { stats: m.strategicRegionsDir?.stats || null, effective: m.strategicRegionsDir?.effective || [] },
          /* DLC 层(2026-10-07):见 engine/src/dlcsrc.ts 的实测结论 ——
           * 本机 30 个 DLC 全是纯资源目录(带数据 0 个),所以 hasData 全 false。
           * 但门控是真实存在的(77 个 state 含 has_dlc),必须下发。*/
          dlc: {
            list: m.dlc.list.map((d) => ({
              dir: d.dir, name: d.name, hasData: d.hasData,
              statesCount: d.statesCount, mapAssetsCount: d.mapAssetsCount,
            })),
            summary: m.dlc.summary,
            gates: m.dlc.gates.byDlc,
            gateRefs: m.dlc.gates.refs.slice(0, 500),
            gateTotal: m.dlc.gates.refs.length,
          },
        }
      }, (pl) => (pl as { ready?: boolean }).ready === false)
    }
    if (p === '/api/worldmap/img') {
      const m = buildWorldMap()
      if (!m) return send(res, 200, JSON.stringify({ ready: false, error: WM_ERR || '构建中' }))
      const mode = url.searchParams.get('mode') || 'base'
      if (!WM_IMG.has(mode)) {
        // ★ 读**生效来源**的那份位图(与 meta 同源),不是基础游戏的
        const dec = decodeBmp(readFileSync(join(ROOTS[m.bitmapRoot].path, 'map', 'provinces.bmp')))
        if (!dec.ok || !dec.bitmap) return send(res, 500, JSON.stringify({ error: dec.error || 'decode failed' }))
        let rgba: Uint8Array
        if (mode === 'owner') rgba = recolorByOwner(m, dec.bitmap.rgba, dec.bitmap.w, dec.bitmap.h)
        else if (mode === 'terrain') rgba = recolorByTerrain(m, dec.bitmap.rgba, dec.bitmap.w, dec.bitmap.h)
        else if (mode === 'state') rgba = recolorByState(m, dec.bitmap.rgba, dec.bitmap.w, dec.bitmap.h)
        else if (mode === 'sr') rgba = recolorBySR(m, dec.bitmap.rgba, dec.bitmap.w, dec.bitmap.h)
        else rgba = dec.bitmap.rgba
        WM_IMG.set(mode, encodePng(rgba, dec.bitmap.w, dec.bitmap.h))
      }
      const png = WM_IMG.get(mode)!
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=3600' })
      return res.end(png)
    }
    /* ★ 河流叠加 PNG:河流像素 → 半透明蓝,其余全透明。
     *   前端在底图/地形图上叠加这一层,即可看到河流走向(state/战略区域/tag
     *   的地形叠加需求也顺便满足)。 rivers.bmp 与 provinces.bmp 同分辨率。 */
    if (p === '/api/worldmap/img-rivers') {
      const m = buildWorldMap()
      if (!m) return send(res, 404, JSON.stringify({ error: WM_ERR || '构建中' }))
      const rp = join(ROOTS[m.bitmapRoot].path, 'map', 'rivers.bmp')
      if (!existsSync(rp)) return send(res, 404, JSON.stringify({ error: 'no rivers.bmp' }))
      const dec = decodeBmp(readFileSync(rp))
      if (!dec.ok || !dec.bitmap) return send(res, 500, JSON.stringify({ error: dec.error || 'decode failed' }))
      const rgba = new Uint8Array(dec.bitmap.rgba.length)
      for (let i = 0; i < dec.bitmap.rgba.length; i += 4) {
        const r = dec.bitmap.rgba[i], g = dec.bitmap.rgba[i + 1], b = dec.bitmap.rgba[i + 2]
        // ★ 河流判定(实测 KR 与原版 rivers.bmp 一致):背景是**灰(122,122,122)**
        //   与**白(255,255,255)**两种索引色(合计 ~99% 像素),河流是**蓝色/青色**
        //   少数像素(索引 3/4/6/7/9/11,如 (0,225,255)/(0,0,100)/(0,100,255))。
        //   旧判定 r+g+b>30 把灰白底也当河流 → 整张图染蓝(用户报的"显示河流出错")。
        //   改用「蓝色主导」:b 严格大于 r 与 g。灰/白 b==r==g 自然排除,河流蓝命中。
        if (b > r && b > g) { rgba[i] = 70; rgba[i + 1] = 130; rgba[i + 2] = 220; rgba[i + 3] = 200 }
        else rgba[i + 3] = 0
      }
      const png = encodePng(rgba, dec.bitmap.w, dec.bitmap.h)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=3600' })
      return res.end(png)
    }
    /* ── 地图右键定位:把逻辑目标解析成「来源下标 + 相对文件路径 + 行号」 ──
     *   前端拿到后交给 /api/open-external(已含 VS Code 探测 / --goto 行号 / 系统默认回退)。
     *   四类:province(归属 state 文件内该省份那一行)/ state / sr / tag。 */
    if (p === '/api/worldmap/locate') {
      try {
        const m = buildWorldMap()
        if (!m) return send(res, 200, JSON.stringify({ ok: false, error: WM_ERR || '构建中' }))
        const kind = url.searchParams.get('kind') || 'province'
        const q = url.searchParams.get('id') || url.searchParams.get('tag') || ''
        let root = 0, file = '', line = 1, name = ''

        const findLineIn = (text: string, test: (l: string) => boolean): number | null => {
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) if (test(lines[i])) return i + 1
          return null
        }
        const readRel = (r: number, f: string): string | null => {
          try { return readFileSync(join(ROOTS[r].path, f), 'utf8') } catch { return null }
        }

        if (kind === 'state') {
          const s = m.states.find((x) => String(x.id) === q)
          if (!s) return send(res, 404, JSON.stringify({ ok: false, error: 'state 不存在: ' + q }))
          root = s.root; file = s.path; line = 1; name = s.name
        } else if (kind === 'sr') {
          const r = m.strategicRegions.find((x) => String(x.id) === q)
          if (!r) return send(res, 404, JSON.stringify({ ok: false, error: '战略区域不存在: ' + q }))
          root = r.root; file = r.path; line = 1; name = r.name
        } else if (kind === 'tag') {
          const c = m.countries.find((x) => x.tag === q.toUpperCase())
          if (!c) return send(res, 404, JSON.stringify({ ok: false, error: 'tag 不存在: ' + q }))
          /* ★ 2026-10-21 用户需求:"定位国家"应打开 history/countries 里的对应内容。
           * 国家内容分两处:common/countries = 定义(配色/文化),
           * history/countries = 历史(开局科技/政党/军队)—— 后者才是"这个国家"的本体。
           * 优先历史文件;没有历史文件的 tag 才回退 common/countries 定义文件。 */
          if (c.hist) {
            root = c.hist.root; file = c.hist.path; name = c.name || c.tag
            const txt = readRel(root, file)
            if (txt != null) {
              // 行号:优先 oob = "TAG"(国家文件的身份行),其次 capital =,最后第 1 行
              line = findLineIn(txt, (l) => new RegExp('^\\s*oob\\s*=\\s*"?' + c.tag + '"?', 'i').test(l))
                ?? findLineIn(txt, (l) => /^\s*capital\s*=/.test(l))
                ?? 1
            }
          } else {
            root = c.root; file = c.path; name = c.name
            const txt = readRel(root, file)
            if (txt != null) {
              line = findLineIn(txt, (l) => /^\s*color\s*=/.test(l))
                ?? findLineIn(txt, (l) => /^\s*name\s*=/.test(l))
                ?? 1
            }
          }
        } else {
          // province:优先定位到所属 state 文件内该省份那一行;无 state(海/湖)则定位 definition.csv
          const pid = Number(q)
          const prov = m.provinces.find((x) => x.id === pid)
          if (!prov) return send(res, 404, JSON.stringify({ ok: false, error: '省份不存在: ' + q }))
          if (prov.stateId >= 0) {
            const s = m.states.find((x) => x.id === prov.stateId)
            if (s) {
              root = s.root; file = s.path; name = `省份 ${pid} → state ${s.id}`
              const txt = readRel(root, file)
              if (txt != null) {
                const lines = txt.split(/\r?\n/)
                let inProv = false
                let found: number | null = null
                for (let i = 0; i < lines.length; i++) {
                  const l = lines[i]
                  if (/^\s*provinces\s*=\s*\{/.test(l)) { inProv = true; continue }
                  if (inProv) {
                    if (/^\s*\}/.test(l)) break
                    if (new RegExp(`(^|[^\\d])${pid}([^\\d]|$)`).test(l)) { found = i + 1; break }
                  }
                }
                line = found ?? findLineIn(txt, (l) => new RegExp(`(^|[^\\d])${pid}([^\\d]|$)`).test(l)) ?? 1
              }
            }
          }
          if (!file) {
            root = prov.root; file = 'map/definition.csv'; name = `省份 ${pid}`
            const txt = readRel(root, file)
            if (txt != null) line = findLineIn(txt, (l) => l.trim().startsWith(pid + ';')) ?? 1
          }
        }
        if (!file) return send(res, 404, JSON.stringify({ ok: false, error: '无法解析文件路径' }))
        return send(res, 200, JSON.stringify({ ok: true, root, file, line, name }))
      } catch (e: any) {
        return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    }
    /* 模组元数据 + 依赖图 + replace_path 缺口审计
     * 前端「模组关系」面板与地图页的诊断抽屉都读这个。 */
    if (p === '/api/modmeta') {
      try {
        const roots = srcRoots()
        const mods = modDescriptors()
        // 只读 root = 基础游戏(没有 .mod),展示名不能取目录名(会显示成 "hearts of iron iv")
        const graph = buildDepGraph(mods, { isGame: (m) => !m.hasModFile })
        const audit = auditReplacePaths(roots, mods)
        const gv = readGameVersion()
        return send(
          res,
          200,
          JSON.stringify({
            gameVersion: gv,
            mods: mods.map((m, i) => ({
              index: i,
              name: m.name,
              dir: m.dir,
              hasModFile: m.hasModFile,
              inferred: m.inferred,
              modFile: m.modFile,
              remoteFileId: m.remoteFileId,
              version: m.version,
              supportedVersion: m.supportedVersion,
              versionOk: m.supportedVersion ? modVersionMatches(m.supportedVersion, gv) : undefined,
              tags: m.tags,
              stalePath: m.stalePath,
              replacePaths: m.replacePaths,
              replacePathCount: m.replacePaths.length,
              dependencies: m.dependencies,
              warnings: m.warnings,
            })),
            graph: {
              order: graph.order,
              issues: graph.issues,
              cyclic: [...graph.cyclic],
              stats: graph.stats,
              nodes: [...graph.nodes.values()].map((n) => ({
                key: n.key,
                name: n.name,
                display: n.display,
                id: n.id,
                deps: n.deps,
                depKeys: n.depKeys,
                missingDeps: n.missingDeps,
              })),
            },
            audit,
          }),
        )
      } catch (e: any) {
        return send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }))
      }
    }
    if (p === '/api/workshop') {
      try {
        const { roots, mods } = scanWorkshopMods()
        // gameVersion 一并回传,前端才能判断 supported_version 匹不匹配
        return send(
          res,
          200,
          JSON.stringify({ appid: HOI4_APPID, gameVersion: readGameVersion(), roots, mods }),
        )
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
    }
    if (p === '/api/modinfo') {
      // 单目录探测:设置页手填的本地模组目录用它显示名称 / 版本 / 兼容性。
      // 支持重复 ?dir= 一次探测多个(前端一次请求问完所有手填行)。
      try {
        const dirs = url.searchParams.getAll('dir').filter((d) => d.trim())
        const out = dirs.map((d) => {
          const dir = d.trim().replace(/\\/g, "/").replace(/\/+$/, "")
          if (!existsSync(dir)) return { path: dir, exists: false }
          try {
            if (!statSync(dir).isDirectory()) return { path: dir, exists: false, notDir: true }
          } catch {
            return { path: dir, exists: false }
          }
          return { exists: true, ...describeModDir(dir, basename(dir)) }
        })
        return send(res, 200, JSON.stringify({ gameVersion: readGameVersion(), mods: out }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
    }
    /* ── 事件 API(EVENTS_V1)── */
    if (p === '/api/events/list') {
      return cacheSend(res, '/api/events/list' + (url.search ?? ''), () => {
        const g = ensureEvents()
        if (!g) return { ready: false, busy: EV_BUSY, error: EV_ERR }
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const ns = url.searchParams.get('ns') ?? ''
        const type = (url.searchParams.get('type') ?? '').toLowerCase()
        const src = url.searchParams.get('src') ?? ''
        const origin = url.searchParams.get('origin') ?? ''
        // ★ file 过滤:值为 `${root}|${相对路径}`,精确区分不同 root 下同名文件
        const fileParam = url.searchParams.get('file') ?? ''
        const fileRoot = fileParam ? Number(fileParam.slice(0, fileParam.indexOf('|'))) : -1
        const filePath = fileParam.indexOf('|') >= 0 ? fileParam.slice(fileParam.indexOf('|') + 1) : ''
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 10000)
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

        const all = [...g.events.values()]
        const hit = (e: (typeof all)[number]) => {
          if (ns && e.namespace !== ns) return false
          if (type && e.type !== type) return false
          if (src && e.rootName !== src) return false
          if (fileParam) { if (e.root !== fileRoot || e.file !== filePath) return false }
          // ★ OWNERSHIP_V1 归属三态:vanilla=原版未被改写 / override=被模组替换 / new=模组新增
          //   (兼容旧取值 base / mod / overridden)
          if (origin === 'base' || origin === 'vanilla') { if (!(e.origin === 'vanilla' && !e.overridden)) return false }
          else if (origin === 'mod') { if (!(e.origin === 'mod' || e.overridden)) return false }
          else if (origin === 'override' || origin === 'overridden') { if (!e.overridden) return false }
          else if (origin === 'new' || origin === 'modNew') { if (e.origin !== 'mod') return false }
          else if (origin && e.origin !== origin) return false
          if (q) {
            if (e.id.toLowerCase().includes(q)) return true
            if (e.title.toLowerCase().includes(q)) return true
            if (e.desc.toLowerCase().includes(q)) return true
            if (e.picture.toLowerCase().includes(q)) return true
            for (const o of e.options) {
              if (o.name.toLowerCase().includes(q)) return true
              if (o.effects.some((x) => x.toLowerCase().includes(q))) return true
            }
            if (e.trigger.toLowerCase().includes(q)) return true
            if (e.immediate.toLowerCase().includes(q)) return true
            return false
          }
          return true
        }
        const matched = all.filter(hit).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
        const rows = matched.slice(offset, offset + limit).map((e) => ({
          id: e.id, type: e.type, namespace: e.namespace,
          title: e.title, desc: e.desc, picture: e.picture,
          options: e.options.length,
          isTriggeredOnly: e.isTriggeredOnly, fireOnlyOnce: e.fireOnlyOnce,
          hidden: e.hidden, major: e.major,
          file: e.file, line: e.line,
          root: e.root, src: e.rootName, writable: e.writable,
          origin: e.origin, overridden: e.overridden,
          /** ★ OWNERSHIP_V1:三态归属,与全工作台同口径 */
          own: e.origin === 'vanilla' ? (e.overridden ? 'override' : 'vanilla') : 'new',
          ownLabel: e.overridden ? '模组改写' : e.origin === 'mod' ? '模组新增' : '原版',
          // (events 的 g.events 已是"同名后者替换前者"的生效集,不存在影子条目)
          hasTrigger: !!e.trigger, hasImmediate: !!e.immediate,
        }))
        // ★ 级联筛选(EVENTS_FILTER_V1):下拉选项随上级选择收窄
        //   src(原版/模组) → file(事件文件) → ns(命名空间);type 为辅助维度。
        //   都只按 src / file 过滤,ns / type 不参与下拉生成(避免越级联动)。
        const srcFileFiltered = all.filter((e) => {
          if (src && e.rootName !== src) return false
          if (fileParam) { if (e.root !== fileRoot || e.file !== filePath) return false }
          return true
        })
        const nsMap = new Map<string, number>()
        for (const e of srcFileFiltered) if (e.namespace) nsMap.set(e.namespace, (nsMap.get(e.namespace) ?? 0) + 1)
        const nsArr = [...nsMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
        const types = [...new Set(srcFileFiltered.map((e) => e.type))].sort()
        return {
          ready: true,
          total: matched.length, rows, offset, limit,
          namespaces: nsArr,
          types,
          files: g.files.length,
          // ★ 事件文件清单(按所选来源收窄),供"文件"筛选下拉。file 过滤值 = `${root}|${file}`
          fileList: g.files.filter((f) => !src || f.rootName === src).map((f) => ({ root: f.root, rootName: f.rootName, file: f.file, events: f.events })),
          ms: g.ms,
          sources: sourcesJson(),
          /** 归属三态统计(生效集口径;g.events 已去重,影子数不再单独统计) */
          own: ownStatsJson(
            all.map((e) => ({ own: (e.origin === 'vanilla' ? (e.overridden ? 'override' : 'vanilla') : 'new') as Ownership })),
            0,
          ),
        }
      }, (pl) => (pl as { ready?: boolean }).ready !== true)
    }
    if (p === '/api/events/read') {
      const g = ensureEvents()
      if (!g) return send(res, 200, JSON.stringify({ ready: false, busy: EV_BUSY, error: EV_ERR }))
      const id = url.searchParams.get('id') ?? ''
      const e = g.events.get(id)
      if (!e) return send(res, 200, JSON.stringify({ ready: true, found: false, id }))
      return send(res, 200, JSON.stringify({
        ready: true, found: true,
        event: {
          ...e,
          options: e.options.map((o) => ({ ...o })),
        },
        // 同一 id 的覆盖链,便于看出"模组改写了原版哪一条"
        defs: e.defs,
      }))
    }
    /* ── 本地化 API(LOCALISATION_V1)── */
    /* ★ 本地化文本查询:给各可视化页把 id 换成人类可读名称。
 *   lang 缺省 = english(用户 2026-10 定的口径:默认英文,基础游戏可中文)。
 *   keys 逗号分隔;也支持 POST JSON {keys:[...], lang}。 */
if (p === '/api/loc/text') {
  const idx = ensureLoc()
  if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
  const run = async (keys: string[], lang: string) => {
    if (lang) await ensureLocLang(lang)
    if (!keys.length) return send(res, 200, JSON.stringify({ ready: true, lang, texts: {} }))
    const m = lookupKeys(idx, keys, lang || undefined)
    const texts: Record<string, unknown> = {}
    for (const [k, v] of m) texts[k] = v
    let hit = 0
    for (const v of m.values()) if (v) hit++
    return send(res, 200, JSON.stringify({
      ready: true,
      /** 请求的语言(可能为空 = 走默认链);实际命中语言见每条 text 的 lang */
      lang: lang || '',
      langs: idx.langs.map((l) => ({ id: l, label: langLabel(l) })),
      hit,
      miss: keys.length - hit,
      texts,
    }))
  }
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 4_000_000) req.destroy() })
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}')
        void run((j.keys ?? []).slice(0, 3000), j.lang ?? '')
      } catch { send(res, 400, JSON.stringify({ error: '请求体不是合法 JSON' })) }
    })
    return
  }
  const keys = (url.searchParams.get('keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return run(keys.slice(0, 3000), url.searchParams.get('lang') ?? '')
}
if (p === '/api/loc/stats') {
      const idx = ensureLoc(url.searchParams.get('rebuild') === '1')
      if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
      void ensureLocFull()
      const ref = url.searchParams.get('ref') || (idx.langs.includes('l_english') ? 'l_english' : (idx.langs.includes('english') ? 'english' : idx.langs[0] || ''))
      const refMap = ref ? idx.byLang.get(ref) : undefined
      const langs = idx.langs.map((lang) => {
        const m = idx.byLang.get(lang)!
        // missing = 参照语言(默认 english)里有、这门语言里没有的 key 数
        let missing = 0
        if (refMap && lang !== ref) for (const k of refMap.keys()) if (!m.has(k)) missing++
        return { lang, keys: m.size, missing }
      })
      return send(res, 200, JSON.stringify({
        ready: true,
        ref,
        langs,
        /** 语言显示名(前端下拉)。★ 默认 english —— 用户定的口径:默认英文,基础游戏可切中文 */
        langOptions: idx.langs.map((l) => ({ id: l, label: langLabel(l) })),
        defaultLang: 'english',
        files: idx.stats.files,
        entries: idx.stats.entries,
        dupKeys: idx.stats.dupKeys,
        missingBom: idx.stats.missingBom.slice(0, 40),
        missingBomCount: idx.stats.missingBom.length,
        errorFiles: idx.stats.errorFiles.slice(0, 40),
        ms: idx.ms,
        sources: sourcesJson(),
      }))
    }
    if (p === '/api/loc/search') {
      return cacheSend(res, '/api/loc/search' + (url.search ?? ''), () => {
        const idx = ensureLoc()
        if (!idx) return { ready: false, busy: LOC_BUSY, error: LOC_ERR }
        void ensureLocFull()
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const langs = url.searchParams.getAll('lang').map((s) => s.trim()).filter(Boolean)
        const use = langs.length ? langs : idx.langs.slice(0, 2)
        const status = url.searchParams.get('status') ?? 'all' // all | missing | translated | dup
        const src = url.searchParams.get('src') ?? ''            // root 名
        const byFile = url.searchParams.get('file') ?? ''
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

        const refLang = url.searchParams.get('ref') || (idx.langs.includes('l_english') ? 'l_english' : (idx.langs.includes('english') ? 'english' : use[0]))
        const refMap = idx.byLang.get(refLang)
        // 候选 key 集合:以参照语言为准,保证"缺译文"能算出来
        const pool = refMap ? [...refMap.keys()] : [...new Set(use.flatMap((l) => [...(idx.byLang.get(l)?.keys() ?? [])]))]

        const rows: unknown[] = []
        let scanned = 0
        let matched = 0
        for (const key of pool) {
          scanned++
          const cells: Record<string, unknown> = {}
          let anyMissing = false
          for (const lang of use) {
            const hits = idx.byLang.get(lang)?.get(key)
            if (!hits) { anyMissing = true; cells[lang] = null; continue }
            cells[lang] = locRowJson(key, hits)
          }
          if (status === 'missing' && !anyMissing) continue
          if (status === 'translated' && anyMissing) continue
          // 搜索:key 或任意一门语言的值命中
          let hitQ = !q
          if (q) {
            if (key.toLowerCase().includes(q)) hitQ = true
            else {
              for (const lang of use) {
                const c = cells[lang] as { value?: string } | null
                if (c && c.value && c.value.toLowerCase().includes(q)) { hitQ = true; break }
              }
              if (!hitQ) {
                // 也搜没显示出来的语言,免得"明明有却搜不到"
                for (const lang of idx.langs) {
                  const v = joinHits(idx.byLang.get(lang)?.get(key) ?? [])
                  if (v && v.toLowerCase().includes(q)) { hitQ = true; break }
                }
              }
            }
          }
          if (!hitQ) continue
          // 来源筛选:任一门显示语言的生效来源命中即可
          if (src) {
            const ok = use.some((lang) => (cells[lang] as { src?: string } | null)?.src === src)
            if (!ok) continue
          }
          if (byFile) {
            const ok = use.some((lang) => (cells[lang] as { file?: string } | null)?.file === byFile)
            if (!ok) continue
          }
          matched++
          if (matched <= offset || rows.length >= limit) continue
          rows.push({ key, cells })
        }
        return {
          ready: true, langs: use, ref: refLang, rows, total: matched, offset, limit, scanned,
        }
      }, (pl) => (pl as { ready?: boolean }).ready !== true)
    }
    if (p === '/api/loc/files') {
      /* ★ LOCALISATION_V2:递归文件树(按语言 → 目录 → 文件),给「按文件浏览」用。
       *   idx.files 已含全部 yml(相对路径 + 语言 + 条目数),按语言分组、
       *   目录分组即成树;missing = 参照语言里有、该语言没有的 key 数。 */
      const idx = ensureLoc()
      if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
      void ensureLocFull()
      const ref = url.searchParams.get('ref') || (idx.langs.includes('l_english') ? 'l_english' : (idx.langs.includes('english') ? 'english' : idx.langs[0] || ''))
      const refMap = ref ? idx.byLang.get(ref) : undefined
      const byLang = new Map<string, Map<string, LocFileStat[]>>()
      for (const f of idx.files) {
        const lang = f.lang
        const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '(根)'
        if (!byLang.has(lang)) byLang.set(lang, new Map())
        const dm = byLang.get(lang)!
        if (!dm.has(dir)) dm.set(dir, [])
        dm.get(dir)!.push(f)
      }
      const langs = [...byLang.entries()].map(([lang, dm]) => {
        const m = idx.byLang.get(lang)
        const keys = m ? m.size : 0
        let missing = 0
        if (refMap && lang !== ref) for (const k of refMap.keys()) if (!m || !m.has(k)) missing++
        const totalEntries = [...dm.values()].reduce((a, arr) => a + arr.reduce((b, f) => b + f.entries, 0), 0)
        const dirs = [...dm.entries()]
          .map(([dir, files]) => ({ dir, files: files.map((f) => ({ file: f.file, entries: f.entries, hasBom: f.hasBom, errors: f.errors, rootIdx: f.rootIdx })).sort((a, b) => a.file.localeCompare(b.file)) }))
          .sort((a, b) => a.dir.localeCompare(b.dir, 'zh'))
        return { lang, keys, missing, totalEntries, dirs }
      }).sort((a, b) => (b.keys + b.missing) - (a.keys + a.missing))
      return send(res, 200, JSON.stringify({ ready: true, ref, langs }))
    }
    if (p === '/api/loc/file') {
      /* ★ LOCALISATION_V2:某文件的全部条目(该文件宿主语言的所有 key),
       *   并给出所选各语言的译文/缺失,供「按文件」模式逐文件翻译校正。 */
      const idx = ensureLoc()
      if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
      void ensureLocFull()
      const rel = (url.searchParams.get('path') ?? '').trim()
      if (!rel) return send(res, 200, JSON.stringify({ ready: true, found: false, file: rel }))
      const st = idx.files.find((f) => f.file === rel)
      if (!st) return send(res, 200, JSON.stringify({ ready: true, found: false, file: rel }))
      const hostLang = st.lang
      const langs = url.searchParams.getAll('lang').map((s) => s.trim()).filter(Boolean)
      const use = langs.length ? langs : [hostLang]
      const keys: string[] = []
      const hostMap = idx.byLang.get(hostLang)
      if (hostMap) for (const [k, hits] of hostMap) if (hits.some((h) => h.file === rel)) keys.push(k)
      const rows: unknown[] = []
      for (const key of keys) {
        const cells: Record<string, unknown> = {}
        for (const lang of use) {
          const hits = idx.byLang.get(lang)?.get(key)
          cells[lang] = hits && hits.length ? locRowJson(key, hits) : null
        }
        rows.push({ key, cells })
      }
      return send(res, 200, JSON.stringify({ ready: true, found: true, file: rel, hostLang, entries: keys.length, rows }))
    }
    /* MUSIC_V1: /api/music playlist + localized titles; /api/music/audio stream */
    /* ── TRACKER_V2:更新跟踪 API(2026-10-11,按来源独立) ──
     *  GET  /api/tracker/status             各来源独立状态(基础游戏+各模组),busy/error 供轮询
     *  GET  /api/tracker/history?root=<k>   某来源历次检查记录摘要(倒序,fileName/checkedAt/stats,秒开)
     *  GET  /api/tracker/historyEntry?root=<k>&ts=<file>  某条历史记录的完整 changes(选中条目时按需拉取)
     *  GET  /api/tracker/diff?root=<k>&key=&type=&ts=  某来源某条检查中某条变更的行级 diff
     *  GET  /api/tracker/build?root=<k>     SSE: 建立某来源基线(全量扫描),实时推送 {progress} → {done:{ok,files}}
     *  GET  /api/tracker/check?root=<k>     SSE: 检查某来源更新,推送 {progress} → {done:{ok,report}}
     *  POST /api/tracker/clearRoot?root=<k> 删除某来源的基线+历史(不影响其它来源)
     *  POST /api/tracker/clear              删除整个跟踪缓存(仅 tracker 目录)
     */
    const trRootByKey = (k: string): TrackRoot | undefined =>
      trackerRoots().find((r) => trRootKey(r.path) === k)

    if (p === '/api/tracker/status') {
      return send(res, 200, JSON.stringify({ ready: true, busy: trBusy, error: trErr || undefined, roots: trStatus(TRACKER_DIR, trackerRoots()) }))
    }
    if (p === '/api/tracker/history') {
      const rk = url.searchParams.get('root') ?? ''
      // 摘要模式：只返回 fileName/checkedAt/baselineAt/stats，列表秒开（不解析每个历史 JSON 的 diff）
      return send(res, 200, JSON.stringify({ ready: true, busy: trBusy, root: rk, history: trListHistorySummary(TRACKER_DIR, rk) }))
    }
    if (p === '/api/tracker/historyEntry') {
      const rk = url.searchParams.get('root') ?? ''
      const ts = url.searchParams.get('ts') ?? ''
      const entry = trGetHistoryEntry(TRACKER_DIR, rk, ts)
      if (!entry) return send(res, 404, JSON.stringify({ error: '未找到该历史记录: ' + ts }))
      // ★ 响应体护栏:打包态(app://)响应经 IPC 回传,行级 diff 是体积大头,
      //   一条 663 个 modified 的原版检查能把 JSON 撑到 166MB,直接撑爆 IPC 序列化。
      //   内嵌 diff 行数超阈值时整体剥离 —— 前端展开明细时按需走 /api/tracker/diff(可从 pack 重算)。
      let diffRows = 0
      for (const c of entry.changes || []) diffRows += c.diff ? c.diff.length : 0
      if (diffRows > 20000) for (const c of entry.changes) if (c.diff) c.diff = undefined
      return send(res, 200, JSON.stringify({ ready: true, entry }))
    }
    if (p === '/api/tracker/diff') {
      const rk = url.searchParams.get('root') ?? ''
      const tkey = url.searchParams.get('key') ?? ''
      const tkind = url.searchParams.get('type') ?? ''
      const tidx = Number(url.searchParams.get('idx') ?? '0') || 0
      const tts = url.searchParams.get('ts') ?? ''
      ;(async () => {
        const d = await trGetDiff(TRACKER_DIR, rk, tkey, tkind, tts || undefined, tidx)
        send(res, 200, JSON.stringify({ ready: true, diff: d }))
      })()
      return
    }
    // SSE 进度流：把引擎 onProgress 回调转成 data: 帧；客户端断开(res 'close')即中断扫描。
    const sseTrack = (fn: (onP: (p: any) => void) => Promise<any>) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      let aborted = false
      res.on('close', () => { aborted = true })
      const sendFrame = (obj: unknown) => {
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n') } catch { /* 连接已断 */ }
      }
      const onP = (p: any) => {
        if (aborted) throw new Error('__TRACKER_ABORT__')
        sendFrame({ progress: p })
      }
      ;(async () => {
        try {
          trBusy = true
          trErr = ''
          const result = await fn(onP)
          if (aborted) return
          sendFrame({ done: true, ...(result as object) })
        } catch (e) {
          if (!aborted) sendFrame({ error: (e as Error)?.message ?? String(e) })
        } finally {
          trBusy = false
          try { res.end() } catch { /* 已断 */ }
        }
      })()
    }

    if (p === '/api/tracker/build') {
      const rk = url.searchParams.get('root') ?? ''
      const root = trRootByKey(rk)
      if (!root) return send(res, 400, JSON.stringify({ error: '未知来源 key: ' + rk }))
      if (trBusy) return send(res, 409, JSON.stringify({ error: '有其它跟踪任务正在进行，请稍候' }))
      return sseTrack((onP) => trBuildBaseline(TRACKER_DIR, root, onP))
    }
    if (p === '/api/tracker/check') {
      const rk = url.searchParams.get('root') ?? ''
      const root = trRootByKey(rk)
      if (!root) return send(res, 400, JSON.stringify({ error: '未知来源 key: ' + rk }))
      if (trBusy) return send(res, 409, JSON.stringify({ error: '有其它跟踪任务正在进行，请稍候' }))
      return sseTrack((onP) => trCheckUpdate(TRACKER_DIR, root, onP))
    }
    if (p === '/api/tracker/reset' && req.method === 'POST') {
      const rk = url.searchParams.get('root') ?? ''
      const root = trRootByKey(rk)
      if (!root) return send(res, 400, JSON.stringify({ error: '未知来源 key: ' + rk }))
      if (trBusy) return send(res, 409, JSON.stringify({ error: '有其它跟踪任务正在进行，请稍候' }))
      return sseTrack(async (onP) => {
        trClearRoot(TRACKER_DIR, root.path)
        return trBuildBaseline(TRACKER_DIR, root, onP)
      })
    }
    if (p === '/api/tracker/delhist' && req.method === 'POST') {
      const rk = url.searchParams.get('root') ?? ''
      const ts = url.searchParams.get('ts') ?? ''
      // ★ 删除最新检查点会回滚基线,与进行中的扫描并发会互相踩:忙时拒绝
      if (trBusy) return send(res, 409, JSON.stringify({ error: '有其它跟踪任务正在进行，请稍候' }))
      try { trDeleteHistory(TRACKER_DIR, rk, ts); return send(res, 200, JSON.stringify({ ok: true })) }
      catch (e) { return send(res, 500, JSON.stringify({ error: (e as Error)?.message ?? String(e) })) }
    }
    if (p === '/api/tracker/clearRoot' && req.method === 'POST') {
      const rk = url.searchParams.get('root') ?? ''
      const root = trRootByKey(rk)
      if (!root) return send(res, 400, JSON.stringify({ error: '未知来源 key: ' + rk }))
      try { trClearRoot(TRACKER_DIR, root.path); return send(res, 200, JSON.stringify({ ok: true })) }
      catch (e) { return send(res, 500, JSON.stringify({ error: (e as Error)?.message ?? String(e) })) }
    }
    if (p === '/api/tracker/clear' && req.method === 'POST') {
      try { trClear(TRACKER_DIR); return send(res, 200, JSON.stringify({ ok: true })) }
      catch (e) { return send(res, 500, JSON.stringify({ error: (e as Error)?.message ?? String(e) })) }
    }
    if (p === '/api/tracker/gc' && req.method === 'POST') {
      if (trBusy) return send(res, 409, JSON.stringify({ error: '有其它跟踪任务正在进行，请稍候' }))
      trGc(TRACKER_DIR).then(
        (r) => send(res, 200, JSON.stringify({ ok: true, removed: r.removed, remaining: r.remaining, skipped: r.skipped })),
        (e) => send(res, 500, JSON.stringify({ error: (e as Error)?.message ?? String(e) })),
      )
      return
    }
    if (p === '/api/music') {
      const mi = ensureMusic()
      const idx = ensureLoc()
      if (!mi) return send(res, 200, JSON.stringify({ ready: false, pending: true }))
      const langs = idx ? idx.langs : []
      const stations = mi.stations.map((st) => ({
        name: st.name,
        songs: st.songs
          .map((n) => mi.byName.get(n))
          .filter((s): s is MusicSong => !!s)
          .map((s) => ({ name: s.name, rel: s.rel, volume: s.volume, source: s.source, title: locTitles(idx, s.name, langs) })),
      }))
      return send(res, 200, JSON.stringify({ ready: true, pending: false, langs, stations, count: mi.songs.length, ms: mi.ms }))
    }
    if (p === '/api/music/audio') {
      const rel = url.searchParams.get('rel') ?? ''
      const mi = ensureMusic()
      if (!mi) return send(res, 503, JSON.stringify({ pending: true }))
      const song = mi.byRel.get(rel)
      if (!song || !existsSync(song.file)) return send(res, 404, JSON.stringify({ error: 'audio not found' }))
      const stat = statSync(song.file)
      const size = stat.size
      const type = extname(song.file).toLowerCase() === '.ogg' ? 'audio/ogg' : 'application/octet-stream'
      const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
      // HTTP Range:必需的流式支持 — 浏览器 <audio> 时 seek/进度条拖动/大文件分段都依赖它;
      // 无 Range 时返回 200 全量 chunked 无 Content-Length,进度条/拖动失效、部分浏览器播放异常
      const range = req.headers.range as string | undefined
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = 0, end = size - 1
        if (m) {
          if (m[1]) start = parseInt(m[1], 10)
          if (m[2]) end = parseInt(m[2], 10)
        }
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size })
          return res.end()
        }
        if (end >= size) end = size - 1
        res.writeHead(206, { ...base, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1 })
        {
          const _rs = createReadStream(song.file, { start, end })
          _rs.on('error', () => { try { res.end() } catch { /* 流读失败,收尾即可 */ } })
          res.on('close', () => { try { _rs.destroy() } catch { /* 客户端断开,销毁流 */ } })
          _rs.pipe(res)
        }
        return
      }
      res.writeHead(200, { ...base, 'Content-Length': size })
      {
        const _rs = createReadStream(song.file)
        _rs.on('error', () => { try { res.end() } catch { /* 流读失败,收尾即可 */ } })
        res.on('close', () => { try { _rs.destroy() } catch { /* 客户端断开,销毁流 */ } })
        _rs.pipe(res)
      }
      return
    }
    if (p === '/api/loc/key') {
      const idx = ensureLoc()
      if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
      void ensureLocFull()
      const key = url.searchParams.get('key') ?? ''
      const out: Record<string, unknown> = {}
      for (const lang of idx.langs) {
        const hits = idx.byLang.get(lang)?.get(key)
        out[lang] = hits ? locRowJson(key, hits) : null
      }
      return send(res, 200, JSON.stringify({ ready: true, key, langs: idx.langs, byLang: out }))
    }
    if (p === '/api/loc/pair') {
      const idx = ensureLoc()
      if (!idx) return send(res, 200, JSON.stringify({ ready: false, busy: LOC_BUSY, error: LOC_ERR }))
      void ensureLocLang('l_english')
      void ensureLocLang('l_simp_chinese')
      const run = (keys: string[]) => {
        if (!keys.length) return send(res, 200, JSON.stringify({ ready: true, pairs: {} }))
        const m = lookupPair(idx, keys)
        const pairs: Record<string, unknown> = {}
        for (const [k, v] of m) {
          pairs[k] = {
            en: v.en ? { text: v.en.text, lang: v.en.lang, file: v.en.file, line: v.en.line, rootIdx: v.en.rootIdx } : null,
            zh: v.zh ? { text: v.zh.text, lang: v.zh.lang, file: v.zh.file, line: v.zh.line, rootIdx: v.zh.rootIdx } : null,
            missing: v.missing,
          }
        }
        return send(res, 200, JSON.stringify({ ready: true, pairs }))
      }
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 4_000_000) req.destroy() })
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}')
            return run((j.keys ?? []).slice(0, 3000))
          } catch { send(res, 400, JSON.stringify({ error: '请求体不是合法 JSON' })) }
        })
        return
      }
      const keys = (url.searchParams.get('keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      return run(keys.slice(0, 3000))
    }
    if (p === '/api/loc/save' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4000000) req.destroy() })
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}')
          const rootIdx = Number(j.rootIdx)
          const root = ROOTS[rootIdx]
          if (!root) return send(res, 400, JSON.stringify({ error: '来源不存在' }))
          if (!root.writable) return send(res, 400, JSON.stringify({ error: '只读来源不可修改: ' + root.name }))
          const file = String(j.file ?? '')
          const key = String(j.key ?? '')
          if (!file || !key) return send(res, 400, JSON.stringify({ error: '缺少 file / key' }))
          const index = j.index === null || j.index === undefined ? null : Number(j.index)
          const r = saveLocValue(root.path, file, Number(j.line), key, index, String(j.value ?? ''))
          // 写成功后索引立刻失效,下一次请求重建 —— 不做增量,免得状态不一致
          if (r.ok) LOC = null
          return send(res, 200, JSON.stringify(r))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/loc/append' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4000000) req.destroy() })
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}')
          const root = ROOTS[Number(j.rootIdx)]
          if (!root) return send(res, 400, JSON.stringify({ error: '来源不存在' }))
          if (!root.writable) return send(res, 400, JSON.stringify({ error: '只读来源不可修改: ' + root.name }))
          const r = appendLocEntry(root.path, String(j.file ?? ''), String(j.key ?? ''), String(j.value ?? ''))
          if (r.ok) LOC = null
          return send(res, 200, JSON.stringify(r))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    /* ── 目录探查 ──────────────────────────────────────────────
     * 打开工程页每次输入/浏览后都要问一句"这是什么目录":
     *   有 hoi4.exe → 基础游戏;有 .mod → 模组;都沒有 → 普通目录。
     * 一次请求可带多个 ?path=,前端整屏只需要一次往返。
     */
    if (p === '/api/probe') {
      try {
        const paths = url.searchParams.getAll('path').filter((x) => x.trim())
        const out = paths.map((raw) => {
          const dir = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
          const di = dirInfo(dir)
          const mi = di.exists ? readModInfo(dir) : null
          return {
            path: dir,
            ...di,
            // 模组名/版本只在有 .mod 时才有意义
            name: mi?.name || '',
            version: mi?.version || '',
            supportedVersion: mi?.supportedVersion || '',
            versionOk: mi?.versionOk,
            tags: mi?.tags ?? [],
            kind: !di.exists ? 'none' : di.hasExe ? 'game' : di.hasModFile ? 'mod' : 'unknown',
          }
        })
        return send(res, 200, JSON.stringify({ gameVersion: readGameVersion(), items: out }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
    }
    /* ── 文件夹浏览(网页内选目录)────────────────────────────────
     * 用户要求"像打开文件夹那样获取路径"。浏览器出于安全不提供原生目录选择器,
     * 只能在后端列目录:给父路径 → 返回子目录列表 + 每个目录是什么(游戏/模组)。
     * 只读目录名,不读文件内容;越权路径一律拒绝(黑名单 + 只列目录)。
     */
    if (p === '/api/browse') {
      try {
        const raw = (url.searchParams.get('path') ?? '').trim()
        // 不传 path → 列盘符,让用户有起点
        if (!raw) {
          const drives: { name: string; path: string }[] = []
          for (const d of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
            const root = d + ':/'
            if (existsSync(root)) drives.push({ name: '本地磁盘 (' + d + ':)', path: root })
          }
          return send(res, 200, JSON.stringify({ path: '', parent: null, dirs: drives }))
        }
        const dir = raw.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          return send(res, 200, JSON.stringify({ path: dir, parent: dirname(dir), dirs: [], error: '目录不存在' }))
        }
        const REJECT = /^\/+(proc|sys|dev|windows\/system32)/i
        if (REJECT.test(dir.replace(/^[a-z]:/i, ''))) {
          return send(res, 200, JSON.stringify({ path: dir, parent: dirname(dir), dirs: [], error: '该目录不允许浏览' }))
        }
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
          .map((e) => {
            const full = join(dir, e.name).replace(/\\/g, '/')
            return { name: e.name, path: full }
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
          .slice(0, 500)
        // 给每个子目录顺带标出"它是什么"—— 用户一路点下去就能看见 ✔ 游戏 / ✔ 模组
        const dirs = entries.map((e) => {
          const di = dirInfo(e.path)
          return {
            ...e,
            isGame: di.hasExe,
            isMod: di.hasModFile && !di.hasExe,
            hasInterface: di.hasInterface,
          }
        })
        return send(res, 200, JSON.stringify({ path: dir, parent: dirname(dir), dirs }))
      } catch (e) {
        return send(res, 200, JSON.stringify({ path: '', parent: null, dirs: [], error: String(e) }))
      }
    }
    if (p === '/api/detect') {
      try {
        return send(
          res,
          200,
          JSON.stringify({ defaultBase: DEFAULT_GAME_DIR, candidates: detectGameDirs() }),
        )
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
    }
    if (p === '/api/load' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 1000000) req.destroy() })
      req.on('end', () => {
        try {
          const req0 = JSON.parse(body || '{}')
          const base = typeof req0.base === 'string' ? req0.base.trim() : ''
          const mods: string[] = []
          if (typeof req0.mod === 'string' && req0.mod.trim()) mods.push(req0.mod.trim())
          if (Array.isArray(req0.mods)) {
            for (const m of req0.mods) if (typeof m === 'string' && m.trim()) mods.push(m.trim())
          }
          if (!base) return send(res, 400, JSON.stringify({ error: '基础游戏路径为必填项' }))
          if (!existsSync(base)) return send(res, 400, JSON.stringify({ error: `基础游戏路径不存在: ${base}` }))
          for (const m of mods) {
            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))
          }
          // 不阻断,但在响应里点名没有 interface/ 的目录 ——
          // 否则表现为"模组已加载但文件列表里什么都没有",很难自查。
          // SETTINGS_V1
          const noIface = mods.filter((m) => !existsSync(join(m, "interface")))
          // ★ 基础游戏的判据是 hoi4.exe;没有就明确警告(不阻断 —— 有人用复制出来的
          //   工作目录,强拦会让人卡死在这里)。模组则以 .mod 为准。
          const noExe = !dirInfo(base).hasExe
          const noModFile = mods.filter((m) => !dirInfo(m).hasModFile)
          const roots: Root[] = [{ name: 'vanilla', path: base, writable: false }]
          for (const m of mods) {
            // 目录名常是 workshop 数字 ID,直接当来源名很难认;
            // 读 .mod 的 name 更好。读不到才回退 basename(路径)。
            const d = readDescriptor(m)
            roots.push({ name: d.name || basename(m), path: m, writable: true })
          }
          if (READONLY) for (const r of roots) r.writable = false
          ROOTS.length = 0
          for (const r of roots) ROOTS.push(r)
          rebuildIndexes()
          forceBuildAll() /* LOAD_REBUILD_V1(2026-10-10):保存来源后全量重建索引,控制台走完+前端加载画面 */
          /* ★ LOAD_PERSIST_V1:把这次挂载写进设置,首页「模组开关」才看得到。
           *   以前只改 ROOTS 不落盘,而 /api/settings 的 GET 优先回显 saved.mods,
           *   于是"在打开工程页挂的模组"在首页开关里根本不出现 —— 开关只反映
           *   /api/mod/new(建模组那条路径写了 saveSettings)建出来的模组。
           *   合并语义:以本次传入的 mods 为准(它就是用户在页面上看到的列表),
           *   已勾选的 enabled 由调用方给出;不覆盖 display。 */
          try {
            const s0 = loadSettings()
            const base0 = base || s0?.base || ''
            if (base0) {
              saveSettings({
                base: base0,
                mods: normalizeMods(mods.map((m) => ({ path: m, enabled: true }))),
                display: s0?.display ?? defaultDisplay(),
                ...(s0?.ai ? { ai: s0.ai } : {}),
                ...(s0?.icon ? { icon: s0.icon } : {}),
              })
            }
          } catch (e) {
            console.log('  [警告] /api/load 写入设置失败(不影响本次加载): ' + e)
          }
          return send(
            res,
            200,
            JSON.stringify({
              ok: true,
              roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })),
              warnNoInterface: noIface,
              warnNoExe: noExe ? base : '',
              warnNoModFile: noModFile,
            }),
          )
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/settings') {
      // GET:回显已保存的设置;没有就回显当前生效的来源,页面首次打开即有内容
      if (req.method !== 'POST') {
        const saved = loadSettings()
        // 模组名:优先读 .mod 描述符,失败退回目录名 —— 首页开关与设置页都要展示可读名字
        const modName = (p: string): string => {
          try { const d = readDescriptor(p); return d.name || basename(p) } catch { return basename(p) }
        }
        const curMods = ROOTS.filter((r) => r.writable)
          .map((r) => ({ path: r.path, enabled: true, name: r.name || modName(r.path) }))
        const cur = {
          base: (ROOTS.find((r) => !r.writable) || ROOTS[0] || { path: '' }).path,
          mods: curMods,
        }
        const savedMods = saved
          ? normalizeMods(saved.mods).map((m) => ({ path: m.path, enabled: m.enabled, name: modName(m.path) }))
          : curMods
        /* ★ MOD_UNION_V1:开关列表 = 设置里的模组 ∪ 当前实际生效的可写来源。
         *   只回显 saved.mods 会漏掉两类"自己后面加载的模组":
         *     1) run-gui.bat 用 --mod 传进来的(CLI_ROOTS,从不写设置);
         *     2) 走 /api/load 挂载的(旧实现不落盘)。
         *   症状是模组明明在 ROOTS 里参与索引,首页开关却找不到它,无法开关。
         *   去重按规范化路径;已在设置里的保持其 enabled(不篡改用户开关),
         *   只在 ROOTS 里出现的补成 enabled=true(它此刻确实是生效的)。 */
        const union: { path: string; enabled: boolean; name: string }[] = []
        const seen = new Set<string>()
        const keyOf = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
        for (const m of savedMods) {
          const k = keyOf(m.path)
          if (seen.has(k)) continue
          seen.add(k)
          union.push(m)
        }
        for (const m of curMods) {
          const k = keyOf(m.path)
          if (seen.has(k)) continue
          seen.add(k)
          union.push(m)
        }
        return send(res, 200, JSON.stringify({
          base: (saved && saved.base) || cur.base,
          mods: union,
          display: (saved && saved.display) || DEFAULT_DISPLAY,
          gameVersion: readGameVersion(),
          current: cur,
          /* ★ APP_ICON_V1:把已保存的桌面图标(data URL)回给设置页;Electron 壳也可据此设窗口图标 */
          appIcon: (saved && saved.icon) || '',
        }))
      }
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4000000) req.destroy() })
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}')
          const s0 = loadSettings()
          const s: Settings = {
            base: typeof j.base === 'string' ? j.base.trim() : '',
            mods: normalizeMods(j.mods),
            display: { ...DEFAULT_DISPLAY, ...(j.display ?? {}) },
            /* ★ APP_ICON_V1:保留已有的 ai / icon(前端设置页不传这两项时不能丢;
             *   但 icon 是显式字段——传空串表示"清空",不能回退到旧值) */
            ...(j.ai ? { ai: { ...defaultAiConfig(), ...(j.ai as object) } } : (s0?.ai ? { ai: s0.ai } : {})),
            ...('icon' in j && typeof j.icon === 'string' ? { icon: j.icon } : (s0?.icon ? { icon: s0.icon } : {})),
          }
          const r = applySettings(s)
          saveSettings(s)
          return send(res, 200, JSON.stringify({
            ok: true,
            mods: s.mods,
            display: s.display,
            roots: r.roots.map((x) => ({ name: x.name, path: x.path, writable: x.writable })),
            warnNoInterface: r.warnNoInterface,
            disabled: r.disabled,
          }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }    if (p === '/api/config') {
      return send(
        res,
        200,
        // gameVersion:设置页要显示"当前游戏版本",并据此判断模组 supported_version
        JSON.stringify({
          roots: ROOTS.map((r) => ({ name: r.name, writable: r.writable })),
          readonly: READONLY,
          gameVersion: readGameVersion(),
        }),
      )
    }
    if (p === '/api/open-external') {
      // ★ 用本地编辑器打开(root?file=...&line=)。IDE 页「用 VS Code 打开」用。
      //   优先 code(VS Code CLI);找不到则退回系统默认编辑器(start/open)。
      const rootIdx = Number(url.searchParams.get('root') ?? '0')
      const rawFile = url.searchParams.get('file') ?? ''
      const line = Math.max(1, Number(url.searchParams.get('line') ?? '1') || 1)
      const root = ROOTS[rootIdx]
      if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))

      /* ★★ ABS_FILE_V1(2026-10-06 修「DLC 页右键打不开模组 MIO」):
       *   各内容 API 下发的 `file` **格式不统一** ——
       *     · tech / doctrines / focus / events  → **相对** root 的路径
       *     · mio / 部分 defines                → **绝对**路径
       *   老实现一律 `join(root.path, file)`,拿到绝对路径就拼成
       *   `C:/…/test_new_beta/C:/…/test_new_beta/common/…` —— existsSync 假,
       *   统一报「文件不存在或越界」。用户看到的就是「右键打开模组文件失败」。
       *
       *   修法:先判断它已经是绝对路径,是就直接用(仍要过越界校验),
       *   否则才拼 root。两种形态都收敛到同一个 normAbs 守卫,不放宽安全边界。 */
      const isAbs = /^[A-Za-z]:[\\/]/.test(rawFile) || rawFile.startsWith('/')
      const file = isAbs ? rawFile.replace(/\\/g, '/') : rawFile
      const abs = isAbs ? file : join(root.path, file)
      /* ⚠⚠ PATH_GUARD_V2(2026-10-05 修):目录穿越防护原先用
       *   `abs.startsWith(root.path)` 直接比字符串 —— 在 Windows 上恒为 false!
       *   原因:root.path 来自配置,用的是【正斜杠】(C:/…/Hearts of Iron IV),
       *   而 join() 归一化成【反斜杠】(C:/…/Hearts of Iron IV),分隔符不一致。
       *   实测 existsSync(abs)=true 却 startsWith=false → 所有文件都被误判"越界",
       *   表现为「用 VS Code 打开」永远返回 400。修法:两侧都归一化再比。
       *   (resolve() 兜住 ../ 之外的符号链接/大小写,再补一个分隔符防止
       *    C:/…/IVevil 冒充 C:/…/IV 的前缀匹配。) */
      const normRoot = resolve(root.path).replace(/[\\/]+$/, '')
      const normAbs = resolve(abs)
      const inside = normAbs === normRoot || normAbs.startsWith(normRoot + sep)
      if (!inside || !existsSync(abs))
        return send(res, 400, JSON.stringify({ error: '文件不存在或越界', file, abs }))

      /* ══════════════════════════════════════════════════════════
       * 启动外部编辑器 —— 2026-10-05 重写(修"秒闪退 / 打开错文件")
       *
       * 原实现三个真 bug 叠加,用户症状是"VS Code 秒闪退,或打开了错误的文件":
       *
       * ① **-r(--reuse-window)是秒闪退的真凶**。
       *    -r 的语义是"复用**已存在**的窗口";没有实例时它会起来再退出。
       *    实测:未运行 VS Code 时 `code -r -g file` → 进程闪一下就没了。
       *    ❌ 直接删掉 -r。默认行为(无 -r)才是"没实例就新开"。
       *
       * ② **候选里混了过期 CLI** —— 这才是"打开错文件"的原因。
       *    本机 bin/ 下同时存在 code.cmd(旧)与 new_code.cmd(新),两者指向
       *    resources/app/out/ 下**不同的 hash 目录**(04c0d99f4f vs 07f806f999)。
       *    旧 CLI 与当前 Code.exe 版本不匹配时会开错窗口/错文件。
       *    → 探测时 new_code.cmd 必须排在 code.cmd 之前。
       *
       * ③ **完全没有安装探测**。用户原话:"应该先检测 VSCode 是否安装以及安装路径"。
       *    原来只有 open-external 盲试,用户看到的是"点了没反应",
       *    分不清是没装、装在哪、还是权限问题 → 抽出 detectVSCode(),
       *    配 /api/vscode-detect,菜单里先查再打。
       *
       * ④ 路径含空格必须整体加引号。`C:/Program Files (x86)\…` 走 shell 时
       *    会被拆成多个参数 → 打开"错误的文件"。
       *    → 始终用 --goto 传**单个完整参数**(--goto 自己处理冒号与行号)。
       * ══════════════════════════════════════════════════════════ */
      const det = detectVSCode()
      const pos = `${abs}:${line}:1`

      const run = (cmd: string, args: string[], shell = false): boolean => {
        try {
          // ★ PATH_SPACE_V1(修复「打开 Program/Files/Hearts/of/Iron 空白文件」):
          //   经 shell 执行时 args 会被拼成一条命令行,路径里的空格/括号会把
          //   `C:/Program Files (x86)/…` 拆成多个参数 → VS Code 把它们当成独立的
          //   空白文件打开。这里对含空白或 shell 特殊字符的参数整体加双引号保护。
          //   shell:false 时 execFileSync 直接把数组元素当独立参数传,C 运行时不会再拆,
          //   此时【不能】加引号(否则引号会变成路径的一部分),所以只在 shell:true 时加。
          const a = shell ? args.map((x) => (needsShellQuote(x) ? `"${x}"` : x)) : args
          execFileSync(cmd, a, { stdio: 'ignore', timeout: 8000, windowsHide: true, shell })
          return true
        } catch {
          return false
        }
      }

      let via = ''
      const tried: string[] = []
      // ⚠ 不再带 -r:未运行时它会让 VS Code 起来就退(见上 ①)
      const args = ['--goto', pos]

      // ① 探测到的 CLI 绝对路径(new_code > code > Code.exe,已排好序)
      //   ⚠ 更新未完成时 det.updating 为真,此时**先试 Code.exe**:
      //   两个 hash 目录并存,旧 CLI 指向已被替换的资源 → 拉起即秒退。
      //   直接起 exe 是更新期间唯一稳的路。
      const ordered = det.updating
        ? [...det.candidates.filter((c) => /\.exe$/i.test(c.path)), ...det.candidates.filter((c) => !/\.exe$/i.test(c.path))]
        : det.candidates
      for (const bin of ordered) {
        if (run(bin.path, args, bin.shell)) { via = bin.path; break }
        tried.push(bin.path)
      }
      // ② PATH 上的命令
      if (!via) {
        for (const cmd of ['code', 'code-insiders', 'codium']) {
          if (run(cmd, args, true)) { via = cmd; break }
          tried.push(cmd)
        }
      }
      // ③ 系统默认编辑器(打不开行号,只能定位到文件)
      if (!via) {
        const ok =
          process.platform === 'win32'
            ? run('cmd', ['/c', 'start', '', `"${abs}"`], true)
            : run('xdg-open', [abs])
        if (ok) via = '系统默认编辑器'
      }
      if (!via) {
        // ★ PATH_SPACE_V1:路径含空格/括号必须 URI 编码,否则 VS Code 会把
        //  `C:/Program Files (x86)/…` 按空格拆成多个文件
        //  (用户报:打开 Program / Files / Hearts / of / Iron 空白文件)。
        //  逐段 encodeURIComponent,保留 `/` 分隔符;盘符冒号(:)也编码成 %3A 最稳。
        const vpath = abs
          .replace(/\\/g, '/')
          .split('/')
          .map((s) => encodeURIComponent(s))
          .join('/')
        return send(res, 200, JSON.stringify({
          ok: true,
          installed: det.found,
          tried,
          protocol: `vscode://file/${vpath}:${line}:1`,
          path: abs,
          line,
          note: '服务端进程无权启动桌面程序,请点击下方链接交给 VS Code 打开',
        }))
      }
      return send(res, 200, JSON.stringify({
        ok: true,
        installed: det.found,
        via,
        path: abs,
        line,
        version: det.version,
        // 更新未完成 → 必须告诉用户,否则"又闪退了"会变成无解的死循环
        updating: det.updating,
        note: det.updating
          ? '⚠ VS Code 正在更新中,新旧资源并存,启动可能不稳定。建议先让 VS Code 自己更新完(或重启一次系统)再用本功能。'
          : /\.cmd$/i.test(via)
            ? '已通过 VS Code CLI 定位。若 VS Code 已经开着,文件会在那个窗口里以新标签打开。'
            : undefined,
      }))
    }
    /* ★ VS Code 安装探测(问题 3 的前置):点「用 VS Code 打开」之前先问一句。
     *   原来只有 open-external 盲试,用户看到的是"点了没反应",分不清是没装、
     *   装在哪、还是权限问题。这里把结论直接报出来。
     *   `?refresh=1` 强制重扫 —— 用户可能刚装完 VS Code,要能立刻刷出来。 */
    if (p === '/api/vscode-detect') {
      const det = detectVSCode(url.searchParams.get('refresh') === '1')
      return send(res, 200, JSON.stringify({
        ok: true,
        found: det.found,
        kind: det.kind,
        version: det.version,
        updating: det.updating,
        candidates: det.candidates.map((c) => ({ path: c.path, shell: c.shell })),
        searched: det.searched,
      }))
    }
    /* ── 首页概览(PERF_V2)──
     * 旧实现:首页并行拉 /api/files + focus/tech/doctrines/dlc/decisions 五个图,
     * 一共约 5MB JSON(决议一个就 3.2MB),只为填 6 个数字 —— 打开工作台必卡。
     * 这里只返回计数:
     *   · .gui 数直接扫目录(不拼 4 万条数组)
     *   · 内容类取已构建的图缓存;没构建就返回 null 并在后台点火,
     *     前端退避补一次即可 —— 首屏不再被 5MB 拖住。 */
    /* BOOT_GATE_V1:全局加载进度(前端进度圈遮罩轮询)。 */
    if (p === '/api/status') {
      /* BOOT_STAGE_V2:算出"当前阶段"(第一个没跑完的阶段;全跑完则停在最后一个)。
       * 旧字段 building/phase/done/total/since/ready 全部不动,splash 旧逻辑兼容。 */
      let stageIndex = 0, stageName = '', stageDone = 0, stageTotal = 0
      const st = BUILD.stages
      if (st.length) {
        let ci = st.findIndex((x) => x.done < x.total)
        if (ci < 0) ci = st.length - 1
        stageIndex = ci
        stageName = st[ci].name
        stageDone = st[ci].done
        stageTotal = st[ci].total
      }
      return send(
        res,
        200,
        JSON.stringify({
          building: BUILD.building,
          phase: BUILD.phase,
          done: BUILD.done,
          total: BUILD.total,
          since: BUILD.since,
          ready: !BUILD.building,
          /* 新增阶段维度(BOOT_STAGE_V2) */
          stages: st.map((x) => ({ name: x.name, done: x.done, total: x.total })),
          stageIndex, stageCount: st.length, stageName, stageDone, stageTotal,
        }),
      )
    }
    if (p === '/api/stats') {
      /* ★ PERF_V3:计数按来源清单缓存。
       * 前端是退避轮询的(300ms→2.5s),每次都扫 669 个 .gui ≈150ms,
       * 轮询期间的开销全落在正在跑的重索引上,把构建从 2.4s 拖到 9s。
       * 目录内容只在换来源时变,用来源签名做 key 即可。 */
      const key = ROOTS.map((r) => r.path).join('|')
      if (GUI_COUNT < 0 || GUI_COUNT_KEY !== key) {
        let n = 0
        for (const r of ROOTS) {
          const dir = join(r.path, 'interface')
          if (!existsSync(dir)) continue
          for (const _f of walkFiles(dir, ['.gui'])) n++
        }
        GUI_COUNT = n
        GUI_COUNT_KEY = key
      }
      const gui = GUI_COUNT
      // 点火:各 ensure* 是 setImmediate 异步的,这里只是让它们开始建
      ensureFocus(); ensureTech(); ensureDecisions(); ensureDlc(); ensureDoctrines()
      const focusN = FG ? FG.nodes.size : null
      return send(
        res,
        200,
        JSON.stringify({
          gui,
          focus: focusN,
          tech: TG ? TG.nodes.size : null,
          doctrine: DGR ? DGR.subdoctrines.size : null,
          dlc: DM ? [...DM.features.values()].reduce((a, f) => a + f.stats.items, 0) : null,
          decision: DG ? DG.nodes.size : null,
          pending: !FG || !TG || !DG || !DM || !DGR,
        }),
      )
    }

    /* CACHE_V2(2026-10-17):数据根(%APPDATA%\hoi4-toolkit)缓存管理 ——
     * GET 列出引擎磁盘缓存 + Electron/Chromium 缓存明细;POST 清空。
     * ★ 清空目标一律是数据根(KIT_DATA = HOI4TK_DATA),不再散落到程序目录旁;
     *   gui-settings.json(设置)与 tracker/(体检基线)永不触碰。
     * 清空只删磁盘缓存;当前进程内存里已构建的图不受影响,下次重启冷启动才重建。 */
    if (p === '/api/cache' && req.method === 'GET') {
      /* CLEANUP_V1(2026-10-18,优化11):除引擎/Chromium 缓存外,再报 junk 明细 ——
       * temp 下超过 7 天没动的非缓存文件(crash-*.log 等)、tracker 下 key 不在
       * 当前 ROOTS 的过期 baseline。只报不清,真正删走 POST。 */
      const TEMP_JUNK_MS = 7 * 24 * 3600 * 1000
      const curKeys = new Set(ROOTS.map((r) => trRootKey(r.path)))
      appCacheDirs().then(
        (app) => send(res, 200, JSON.stringify({
          root: KIT_DATA, engine: cacheFiles(), app,
          junk: { tempMaxAgeDays: 7, temp: listTempJunk(TEMP_JUNK_MS), tracker: listTrackerStale(KIT_DATA, curKeys) },
        })),
        (e) => send(res, 500, JSON.stringify({ error: String(e) }))
      )
      return
    }
    if (p === '/api/cache' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy() })
      req.on('end', () => {
        /* CLEANUP_V1:scope 枚举 = 'engine'|'all'|'temp-expired'|'tracker-stale'|'cleanup'。
         * 非法/缺省仍回落旧默认 'all'(向后兼容另一组的既有调用)。
         * 'cleanup' = engine + temp-expired + tracker-stale,不动 Chromium 缓存。 */
        const SCOPES = ['engine', 'all', 'temp-expired', 'tracker-stale', 'cleanup']
        let scope = 'all'
        try { const sc = JSON.parse(body || '{}')?.scope; if (SCOPES.includes(sc)) scope = sc } catch { /* 默认 all */ }
        const TEMP_JUNK_MS = 7 * 24 * 3600 * 1000
        const curKeys = new Set(ROOTS.map((r) => trRootKey(r.path)))
        const run = async () => {
          const out = { removed: 0, bytes: 0, groups: [], failed: [] as string[] }
          const merge = (b: { removed: number; bytes: number; groups: { name: string; removed: number; bytes: number }[]; failed: string[] }) => {
            out.removed += b.removed; out.bytes += b.bytes; out.groups.push(...b.groups); out.failed.push(...b.failed)
          }
          if (scope === 'engine' || scope === 'all' || scope === 'cleanup') merge(await clearCache(scope === 'all' ? 'all' : 'engine'))
          if (scope === 'temp-expired' || scope === 'cleanup') merge(clearTempExpired(TEMP_JUNK_MS))
          if (scope === 'tracker-stale' || scope === 'cleanup') merge(clearTrackerStale(KIT_DATA, curKeys))
          return out
        }
        run().then(
          (r) => send(res, 200, JSON.stringify({ ok: true, scope, ...r })),
          (e) => send(res, 500, JSON.stringify({ error: String(e) }))
        )
      })
      return
    }
    /* MAKE_MOD_V1:统一的来源清单。写盘类操作(保存/新建/落盘)的目标下拉都从这里取;
     * base=true 表示只读的游戏目录,只有 base=false 的来源能被写入。 */
    if (p === '/api/sources') {
      return send(res, 200, JSON.stringify({ sources: sourcesJson(), readonly: READONLY }))
    }
    if (p === '/api/completion') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 80)
      const scopeParam = url.searchParams.get('scopes')
      const scopes = scopeParam ? scopeParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const reg = ensureSymbols()
      if (!reg) return send(res, 202, JSON.stringify({ items: [], building: true }))
      const items = reg.completions(q, scopes, 120)
      return send(res, 200, JSON.stringify({ items }))
    }
    if (p === '/api/mod/toggle' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy() })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const path = String(b.path ?? '').trim()
          const enabled = !!b.enabled
          if (!path) return send(res, 400, JSON.stringify({ error: '缺少模组路径' }))
          const s = loadSettings()
          if (!s) return send(res, 500, JSON.stringify({ error: '无法读取设置' }))
          /* ★ MOD_UNION_V1 配套:开关列表已并入"只在 ROOTS 里"的模组(--mod 传的、
           *   或走 /api/load 挂的),这里若只在 s.mods 里找会对它们 404 ——
           *   症状是"开关点得动、请求报错、状态弹回"。找不到就按当前是否生效补一条。
           *   关掉后 applySettings 重建时它不再进 ROOTS,故不会变成僵尸条目。 */
          let m = s.mods.find((x) => x.path === path)
          if (!m) {
            const kEq = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
            m = s.mods.find((x) => kEq(x.path, path))
            if (!m) {
              const live = ROOTS.find((r) => r.writable && kEq(r.path, path))
              m = { path: live ? live.path : path, enabled: true }
              s.mods.push(m)
            }
          }
          m.enabled = enabled
          saveSettings(s)
          const r = applySettings(s)
          console.log(`  模组开关: ${path} → ${enabled ? '启用' : '停用'}(共 ${r.roots.length} 个来源)`)
          return send(res, 200, JSON.stringify({ ok: true, enabled, roots: sourcesJson() }))
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/files') {
      const out: unknown[] = []
      const rsel = url.searchParams.get('root')
      // all=1 → 列出该来源下全部可编辑文件(.gui/.txt/.yml/.gfx/.mod/.csv);
      // 缺省 → 只列 interface/*.gui(IDE/设计器的老语义,避免全库扫描)
      const all = url.searchParams.get('all') === '1'
      ROOTS.forEach((r, i) => {
        if (rsel && String(i) !== rsel) return
        const dir = all ? r.path : join(r.path, 'interface')
        if (!existsSync(dir)) return
        const exts = all ? ['.gui', '.txt', '.yml', '.gfx', '.mod', '.csv'] : ['.gui']
        for (const f of walkFiles(dir, exts)) {
          out.push({ root: i, rootName: r.name, writable: r.writable, file: relative(r.path, f).replace(/\\/g, '/'), name: relative(dir, f).replace(/\\/g, '/') })
          if (out.length >= 40000) break
        }
        if (out.length >= 40000) return
      })
      return send(res, 200, JSON.stringify({ files: out }))
    }
    if (p === '/api/layout') {
      const rootIdx = parseInt(url.searchParams.get('root') ?? '0', 10)
      const file = url.searchParams.get('file') ?? ''
      const bad = badFileReq(rootIdx, file)
      if (bad) return send(res, 400, JSON.stringify({ error: bad }))
      const { layout } = getLayout(rootIdx, file)
      return send(
        res,
        200,
        JSON.stringify({
          file,
          nodes: layout.nodes.map(nodeJson),
          canvasW: layout.canvasW,
          canvasH: layout.canvasH,
          // ★★★ INLAY_SLOT_V5:国策内嵌组件的真实槽位(国策树坐标系)。
          //   有值 → 前端必须按"国策树里的一个部件"渲染,不能套 1920×1080 屏幕语义。
          //   缺值 → 普通屏幕窗口,老逻辑不变。
          inlay: layout.inlay ?? null,
          stats: layout.stats,
          unresolved: layout.unresolved,
          vars: [...layout.vars.entries()],
        }),
      )
    }
    /* ── 工作台默认应用图标(APPICON_V1,2026-10-04)──
     * 取游戏本体 gfx/HOI4_icon.bmp 解码成 PNG(appearance.js 未选自定义图标时
     * 默认用它当 favicon 与左上角 logo)。解码一次缓存在内存。 */
    if (p === '/api/appicon') {
      try {
        if (!APPICON_PNG) {
          const gameDir = (ROOTS.find((r) => !r.writable) ?? ROOTS[0]).path
          const bmpPath = join(gameDir, 'gfx', 'HOI4_icon.bmp')
          const bmp = readFileSync(bmpPath)
          const dec = decodeImage(bmp, '.bmp')
          if (!dec.ok) return send(res, 404, JSON.stringify({ error: dec.error }))
          APPICON_PNG = Buffer.from(encodePng(dec.bitmap.rgba, dec.bitmap.w, dec.bitmap.h))
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(APPICON_PNG.length),
          'Cache-Control': 'public, max-age=86400',
        })
        res.end(APPICON_PNG)
        // ⚠ 必须显式返回:writeHead+end 已发响应,再落到底部兜底 404 会 ERR_HTTP_HEADERS_SENT
        return
      } catch (e) {
        return send(res, 404, JSON.stringify({ error: `读取应用图标失败: ${String(e)}` }))
      }
    }
    if (p === '/api/tex') {
      const raw = url.searchParams.get('id') ?? url.searchParams.get('name') ?? ''
      const id = resolveTexId(raw)
      if (!id) return send(res, 404, JSON.stringify({ error: '未知贴图: ' + raw }))
      const cached = texCache.get(id)
      if (cached) return send(res, 200, JSON.stringify({ id, ...cached }))
      const entry = texTable.get(id)!
      const abs = entry.candidates.find((c) => existsSync(c))
      if (!abs) {
        texCache.set(id, { error: `贴图文件不存在: ${entry.rel}` })
        return send(res, 200, JSON.stringify({ id, error: `贴图文件不存在: ${entry.rel}`, rel: entry.rel }))
      }
      try {
        const buf = readFileSync(abs)
        const r = decodeImage(buf, extname(abs))
        if (!r.ok || !r.bitmap) {
          texCache.set(id, { error: r.error ?? '解码失败' })
          return send(res, 200, JSON.stringify({ id, error: r.error ?? '解码失败', format: r.format, rel: entry.rel }))
        }
        /* ★★★ FRAME_STRIP_V3:frameAnimatedSpriteType 是横向帧条。
         *   引擎按 noOfFrames 切成 n 帧,一个 sprite 名对应整条图。
         *   前端要显示静态缩略图,必须裁出第 0 帧,否则会看到一条被压扁的长图。
         *   例:doctrine 的 GFX_doctrine_* 有不少是 2 帧(高亮/普通态)。 */
        let frames = 1
        if (entry.noOfFrames && entry.noOfFrames > 1) frames = entry.noOfFrames
        let src = r.bitmap
        if (frames > 1 && src.w >= frames) {
          const fw = Math.floor(src.w / frames)
          const cut = new Uint8Array(fw * src.h * 4)
          for (let y = 0; y < src.h; y++) {
            cut.set(src.rgba.subarray(y * src.w * 4, y * src.w * 4 + fw * 4), y * fw * 4)
          }
          src = { w: fw, h: src.h, rgba: cut }
        }
        const ds = downscaleIfNeeded(src.rgba, src.w, src.h, 2_000_000)
        const png = encodePng(ds.rgba, ds.w, ds.h)
        const payload = {
          w: ds.w,
          h: ds.h,
          origW: src.w,
          origH: src.h,
          scaled: ds.scaled,
          format: r.format,
          frames,
          sprite: entry.sprite,
          rel: entry.rel,
          png: png.toString('base64'),
        }
        texCache.set(id, payload)
        return send(res, 200, JSON.stringify({ id, ...payload }))
      } catch (e) {
        const msg = `读取失败: ${String(e)}`
        texCache.set(id, { error: msg })
        return send(res, 200, JSON.stringify({ id, error: msg }))
      }
    }
    if (p === '/api/links/refs') {
      const g = ensureLinks()
      if (!g) return send(res, 503, JSON.stringify({ error: LINK_ERR || '引用图正在构建,请稍候重试' }))
      const name = url.searchParams.get('name') ?? ''
      const kind = (url.searchParams.get('kind') ?? 'gui_element') as SymKind
      if (!name) return send(res, 400, JSON.stringify({ error: '缺少 name' }))
      const refs = refsOf(g, kind, name)
      const defs = defsOf(g, kind, name)
      const overrides = positionOverrides(g, name)
      return send(
        res,
        200,
        JSON.stringify({
          name,
          kind,
          defs: defs.map((d) => ({ root: d.root, rootName: ROOTS[d.root]?.name ?? '?', file: d.file, line: d.line, detail: d.detail })),
          refs: refs.map(refJson),
          overrides: overrides.map(refJson),
          dangling: !defs.length,
        }),
      )
    }
    if (p === '/api/links/overrides') {
      const g = ensureLinks()
      if (!g) return send(res, 503, JSON.stringify({ error: LINK_ERR || '引用图正在构建' }))
      const names = (url.searchParams.get('names') ?? '').split('|').filter(Boolean)
      const out: Record<string, unknown[]> = {}
      for (const n of names) {
        const ovs = positionOverrides(g, n)
        if (ovs.length) out[n] = ovs.map(refJson)
      }
      return send(res, 200, JSON.stringify({ overrides: out }))
    }
    if (p === '/api/rename') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 20_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const b = JSON.parse(body || '{}')
          const g = ensureLinks()
          if (!g) return send(res, 503, JSON.stringify({ error: LINK_ERR || '引用图正在构建,请稍候重试' }))
          const name = String(b.name ?? '')
          const newName = String(b.newName ?? '')
          const kind = (b.kind ?? 'gui_element') as SymKind
          if (!name || !newName) return send(res, 400, JSON.stringify({ error: '缺少 name / newName' }))
          if (!/^[A-Za-z0-9_.\-]+$/.test(newName)) {
            return send(res, 400, JSON.stringify({ error: '新名只能含字母、数字、下划线、点、连字符' }))
          }
          const def = defsOf(g, kind, name)[0]
          if (!def) return send(res, 404, JSON.stringify({ error: `找不到定义: ${name}` }))
          const patches = planRename(g, def, newName)
          const apply = !!b.apply
          if (!apply) {
            return send(
              res,
              200,
              JSON.stringify({ written: false, def, patches: patches.map(patchJson) }),
            )
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const results = patches.map((patch) => ({ ...patchJson(patch), ...commitPatch(patch, stamp) }))
          const ok = results.filter((r) => r.written).length
          const skipped = results.filter((r) => !r.written)
          return send(
            res,
            200,
            JSON.stringify({
              written: ok > 0,
              files: ok,
              skipped,
              results,
            }),
          )
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    if (p === '/api/save' || p === '/api/preview') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 20_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const req0 = JSON.parse(body || '{}')
          const rootIdx = req0.root ?? 0
          const file = req0.file
          const edits = req0.edits ?? []
          const root = ROOTS[rootIdx]
          if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
          const bad = badFileReq(rootIdx, file)
          if (bad) return send(res, 400, JSON.stringify({ error: bad }))
          if (p === '/api/save' && !root.writable) {
            return send(res, 403, JSON.stringify({ error: `「${root.name}」是只读目录,拒绝写入` }))
          }
          dropLayout(rootIdx, file) // applyEdits 原地改 doc,必须先丢缓存
          const { src, layout } = getLayout(rootIdx, file)
          const out = applyEdits(layout, edits)
          const diff = makeDiff(src, out.text)

          // ── 联动:scripted_gui 的 properties.<元素> = { x= y= } 会覆盖 .gui 的 position,
          //    不一起改的话画布上拖了、游戏里纹丝不动。
          const syncXy = !!req0.syncXy
          let xyPatches: FilePatch[] = []
          if (syncXy && out.guard.ok) {
            const g = ensureLinks()
            if (g) {
              const syncs = collectXySyncs(g, layout, edits)
              if (syncs.length) xyPatches = planXySync(g, syncs)
            }
          }

          if (p === '/api/preview' || !out.guard.ok || !edits.length) {
            return send(
              res,
              200,
              JSON.stringify({
                written: false,
                details: out.details,
                warnings: out.warnings,
                guard: out.guard,
                diff,
                xy: xyPatches.map(patchJson),
              }),
            )
          }
          const abs = join(root.path, file)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const backupDir = join(root.path, '.hoi4gui', 'backups', stamp)
          mkdirSync(dirname(join(backupDir, file)), { recursive: true })
          writeFileSync(join(backupDir, file), src, 'utf8')
          writeFileSync(abs, out.text, 'utf8')
          layoutCache.delete(abs)
          softInvalidate([abs], true)

          // 联动写入:每个文件独立守卫,失败不影响已写的 .gui
          const xyResults = xyPatches.map((patch) => ({
            ...patchJson(patch),
            ...commitPatch(patch, stamp),
          }))
          return send(
            res,
            200,
            JSON.stringify({
              written: true,
              backup: relative(root.path, join(backupDir, file)).replace(/\\/g, '/'),
              details: out.details,
              warnings: out.warnings,
              guard: out.guard,
              diff,
              xy: xyResults,
            }),
          )
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    /* ── VS 式所见即所得:增 / 删 / 改属性 ── */
    if (p === '/api/gui/edit') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 5_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const req0 = JSON.parse(body || '{}')
          const rootIdx = req0.root ?? 0
          const file = req0.file
          const op = req0.op
          const root = ROOTS[rootIdx]
          if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
          const bad = badFileReq(rootIdx, file)
          if (bad) return send(res, 400, JSON.stringify({ error: bad }))
          if (!op || !op.kind) return send(res, 400, JSON.stringify({ error: '缺少 op' }))
          dropLayout(rootIdx, file) // applyGuiOp 原地改 doc,必须先丢缓存
          const { src, layout } = getLayout(rootIdx, file)
          const r = applyGuiOp(layout, op)
          const diff = makeDiff(src, r.outcome.text)
          if (req0.preview || !r.outcome.guard.ok || !root.writable) {
            return send(
              res,
              200,
              JSON.stringify({
                written: false,
                newId: r.newId,
                details: r.outcome.details,
                warnings: r.outcome.warnings,
                guard: r.outcome.guard,
                diff,
              }),
            )
          }
          const abs = join(root.path, file)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const backupDir = join(root.path, '.hoi4gui', 'backups', stamp)
          mkdirSync(dirname(join(backupDir, file)), { recursive: true })
          writeFileSync(join(backupDir, file), src, 'utf8')
          writeFileSync(abs, r.outcome.text, 'utf8')
          layoutCache.delete(abs)
          return send(
            res,
            200,
            JSON.stringify({
              written: true,
              newId: r.newId,
              backup: relative(root.path, join(backupDir, file)).replace(/\\/g, '/'),
              details: r.outcome.details,
              warnings: r.outcome.warnings,
              guard: r.outcome.guard,
              diff,
            }),
          )
        } catch (e) {
          return send(res, 500, JSON.stringify({ error: String(e) }))
        }
      })
      return
    }
    /* ── 贴图名清单(属性网格的自动补全用)── */
    if (p === '/api/sprites') {
      const names = spriteIdx ? [...spriteIdx.byName.keys()].sort() : []
      return send(res, 200, JSON.stringify({ names }))
    }
    /* ── ★★★ TEX_BATCH_V3:批量解析贴图元信息(不解码像素)──
     *
     * 为什么不直接批量拿 png:
     *   一次拉 95 个 doctrine 图标 = 95 个 base64 PNG,几 MB 的响应,
     *   而且服务端要把 95 张 DDS 全解码 —— 事件循环直接堵住几百毫秒。
     *
     * 这里只回"贴图在哪、天然多大、有几帧、文件在不在":
     *   - 尺寸走 DDS/TGA 头(dimsCache 已缓存),一次几百个也就几毫秒
     *   - 前端用它做占位与 aspect-ratio,避免图标加载完布局一跳
     *   - 像素仍按需单张取 /api/tex?id=<sprite名>(已支持名字)
     *
     * names 用逗号分隔。上限 500 张,防手滑传一串万把个进来。 */
    if (p === '/api/texinfo') {
      const names = (url.searchParams.get('names') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (!names.length) return send(res, 200, JSON.stringify({ items: {} }))
      if (names.length > 500) return send(res, 400, JSON.stringify({ error: '一次最多 500 张' }))
      const items: Record<string, unknown> = {}
      for (const nm of names) {
        const id = resolveTexId(nm)
        if (!id) {
          items[nm] = { ok: false, error: 'sprite 未定义' }
          continue
        }
        const entry = texTable.get(id)!
        const def = spriteIdx.get(nm)
        const size = spriteIdx.naturalSize(nm) ?? undefined
        const found = entry.candidates.find((c) => existsSync(c))
        items[nm] = {
          ok: !!found,
          id,
          rel: entry.rel,
          frames: entry.noOfFrames && entry.noOfFrames > 1 ? entry.noOfFrames : 1,
          sprite: def?.name ?? entry.sprite,
          type: def?.type ?? entry.type,
          w: size?.w ?? 0,
          h: size?.h ?? 0,
          file: def ? `${def.file}:${def.line}` : undefined,
          error: found ? undefined : `贴图文件不存在: ${entry.rel}`,
        }
      }
      return send(res, 200, JSON.stringify({ items }))
    }
    /* ── IDE:文件树(惰性,按目录展开)── */
    if (p === '/api/tree') {
      const rootIdx = parseInt(url.searchParams.get('root') ?? '0', 10)
      const rel = (url.searchParams.get('path') ?? '').replace(/^\/+/, '')
      const root = ROOTS[rootIdx]
      if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
      const abs = safeJoin(root.path, rel)
      if (!abs) return send(res, 400, JSON.stringify({ error: '非法路径' }))
      if (!existsSync(abs) || !statSync(abs).isDirectory())
        return send(res, 404, JSON.stringify({ error: '不是目录' }))
      let names: string[] = []
      try {
        names = readdirSync(abs)
      } catch {
        return send(res, 500, JSON.stringify({ error: '读目录失败' }))
      }
      const dirs: { name: string; path: string }[] = []
      const files: { name: string; path: string; size: number; type: string }[] = []
      for (const n of names) {
        let st
        try {
          st = statSync(join(abs, n))
        } catch {
          continue
        }
        const childRel = (rel ? rel + '/' : '') + n
        if (st.isDirectory()) dirs.push({ name: n, path: childRel })
        else files.push({ name: n, path: childRel, size: st.size, type: typeOf(extname(n).toLowerCase()) })
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => a.name.localeCompare(b.name))
      return send(res, 200, JSON.stringify({ root: rootIdx, path: rel, dirs, files, total: dirs.length + files.length }))
    }
    /* ── IDE:读取文件原文 ── */
    if (p === '/api/file') {
      const rootIdx = parseInt(url.searchParams.get('root') ?? '0', 10)
      const rel = (url.searchParams.get('file') ?? '').replace(/^\/+/, '')
      const root = ROOTS[rootIdx]
      if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
      const abs = safeJoin(root.path, rel)
      if (!abs) return send(res, 400, JSON.stringify({ error: '非法路径' }))
      if (!existsSync(abs) || statSync(abs).isDirectory())
        return send(res, 404, JSON.stringify({ error: '文件不存在' }))
      const size = statSync(abs).size
      /* ★ IMAGE_ASSET_V1:图像不能按 UTF-8 读 —— dds/tga 是二进制,
       *   强行 toString 会得到带 NUL 的乱码,前端高亮器还会把它拆成
       *   上万行"代码"。这里改成返回图像元信息 + 可直接 <img> 的
       *   data URL,前端切到预览视图。解码复用 dds.ts/decodeBmp,与
       *   /api/tex 同一条链路,不重复实现。 */
      if (isImageExt(extname(rel).toLowerCase())) {
        const info = readImageAsset(abs, rel)
        return send(
          res,
          200,
          JSON.stringify({
            root: rootIdx,
            file: rel,
            size,
            lang: 'image',
            image: true,
            format: info.format,
            width: info.w,
            height: info.h,
            frames: info.frames,
            png: info.png, // base64,无图为 null
            error: info.error,
            truncated: false,
            lines: 0,
            writable: !!root.writable,
            rootName: root.name,
          }),
        )
      }
      const MAX = 1_500_000
      const truncated = size > MAX
      const content = readFileSync(abs, 'utf8').slice(0, truncated ? MAX : size)
      const lang = langOf(extname(rel).toLowerCase())
      let lines = 0
      for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines++
      return send(
        res,
        200,
        JSON.stringify({
          root: rootIdx,
          file: rel,
          size,
          lang,
          truncated,
          lines: lines + (content.length ? 1 : 0),
          content,
          /* MAKE_MOD_V1:IDE 的「编辑 / 保存」按钮要靠这两个字段判断能不能写。
           * 之前没返回,前端 tab.writable 恒 undefined —— 表面上"按钮逻辑写好了",
           * 实际永远禁用,是"能看不能改"的隐性成因之一。 */
          writable: !!root.writable,
          rootName: root.name,
        }),
      )
    }
    /* ── IDE:大纲(符号表)── */
    if (p === '/api/outline') {
      const rootIdx = parseInt(url.searchParams.get('root') ?? '0', 10)
      const rel = (url.searchParams.get('file') ?? '').replace(/^\/+/, '')
      const root = ROOTS[rootIdx]
      if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
      const abs = safeJoin(root.path, rel)
      if (!abs) return send(res, 400, JSON.stringify({ error: '非法路径' }))
      if (!existsSync(abs)) return send(res, 404, JSON.stringify({ error: '文件不存在' }))
      try {
        const doc = parse(readFileSync(abs, 'utf8'))
        const syms: { name: string; line: number; depth: number; kind: string; detail: string }[] = []
        const MAXDEPTH = 5
        const rec = (block: Block, depth: number) => {
          if (depth > MAXDEPTH) return
          for (const e of block.entries) {
            const k = keyText(doc, e)
            const kind = e.block ? blockType(doc, e.block) : e.value >= 0 ? 'value' : 'flag'
            syms.push({
              name: k ?? '(匿名)',
              line: lineOf(doc, e),
              depth,
              kind,
              detail: e.block ? '' : valueText(doc, e) ?? '',
            })
            if (e.block && depth < MAXDEPTH) rec(e.block, depth + 1)
          }
        }
        rec(doc.root, 0)
        return send(res, 200, JSON.stringify({ file: rel, symbols: syms.slice(0, 4000) }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: String(e) }))
      }
    }
    /* ── IDE:跳转到定义 / 查找引用 ── */
    if (p === '/api/nav') {
      const rootIdx = parseInt(url.searchParams.get('root') ?? '0', 10)
      const rel = (url.searchParams.get('file') ?? '').replace(/^\/+/, '')
      const line = parseInt(url.searchParams.get('line') ?? '0', 10)
      const char = parseInt(url.searchParams.get('char') ?? '0', 10)
      const root = ROOTS[rootIdx]
      if (!root) return send(res, 400, JSON.stringify({ error: 'root 不存在' }))
      const abs = safeJoin(root.path, rel)
      if (!abs) return send(res, 400, JSON.stringify({ error: '非法路径' }))
      if (!existsSync(abs)) return send(res, 404, JSON.stringify({ error: '文件不存在' }))
      const src = readFileSync(abs, 'utf8')
      const lines = src.split('\n')
      const l = lines[line - 1] ?? ''
      const re = /[A-Za-z0-9_@.\-]+/g
      let m: RegExpExecArray | null
      let word = ''
      while ((m = re.exec(l))) {
        if (m.index <= char && char <= m.index + m[0].length) {
          word = m[0]
          break
        }
      }
      if (!word) return send(res, 200, JSON.stringify({ word: '', defs: [], refs: [], building: SYM_BUSY }))
      const reg = ensureSymbols()
      let defs: { kind: string; name: string; file: string; line: number; root: number }[] = []
      let refs: { target: string; name: string; file: string; line: number; ctx?: string }[] = []
      if (reg) {
        defs = reg.definition(word).map((x) => ({ kind: x.kind, name: x.name, file: x.file, line: x.line, root: x.root }))
        refs = reg.references(word).map((x) => ({ target: x.target, name: x.name, file: x.file, line: x.line, ctx: x.ctx, root: x.root }))
      }
      return send(
        res,
        200,
        JSON.stringify({ word, defs, refs, defCount: defs.length, refCount: refs.length, building: SYM_BUSY }),
      )
    }
    return send(res, 404, JSON.stringify({ error: 'not found' }))
  } catch (e) {
    // 兜底:处理器抛出未捕获异常。完整栈只打服务端日志,不回给前端(避免泄露内部路径)。
    console.log('  [未捕获异常] ' + (e instanceof Error ? e.stack : String(e)))
    if (res.headersSent) {
      // 响应头已发(个别处理器 writeHead 后才抛):再 writeHead 会 ERR_HTTP_HEADERS_SENT,
      // 此时只能收尾,不能二次写头。
      try { res.end() } catch { /* 连接已断 */ }
    } else {
      try { return send(res, 500, JSON.stringify({ error: '服务器内部错误,详见控制台日志' })) } catch { /* 忽略 */ }
    }
  }
})

/** 被移动的元素 —— 若 scripted_gui 里也有它的 x/y 覆盖,必须一起改 */
function collectXySyncs(g: LinkGraph, layout: Layout, edits: { id: string; x?: number; y?: number }[]) {
  const syncs: { ref: SymRef; x?: number; y?: number }[] = []
  for (const ed of edits) {
    if (ed.x === undefined && ed.y === undefined) continue
    const n = layout.byId.get(ed.id)
    if (!n || !n.name || n.name === '(匿名)') continue
    for (const ov of positionOverrides(g, n.name)) syncs.push({ ref: ov, x: ed.x, y: ed.y })
  }
  return syncs
}

function patchJson(p: FilePatch): Record<string, unknown> {
  return {
    root: p.root,
    rootName: ROOTS[p.root]?.name ?? '?',
    file: p.file,
    details: p.details,
    warnings: p.warnings,
    guard: p.guard,
    diff: p.diff,
  }
}

/* ══════════════════════════════════════════════════════════════════
 * World Map 模型(懒构建,缓存) —— MAPMODEL_V1 多来源合成
 *
 * ══ 与旧实现的差别(旧实现只看基础游戏,是错的)══
 *  旧:`const root = ROOTS.find(r => !r.writable)` 然后一路读它的 map/ 与
 *      history/states。实测本机 36 个创意工坊模组里 **11 个自带 map/**,
 *      其中 Kaiserreich 连 provinces.bmp + definition.csv 都换了;
 *      `history/states` 更是被 replace_path 改得最狠的目录(11 个模组都声明)。
 *      所以旧实现给出的图,和游戏里实际看到的**不是同一张**。
 *
 *  新:① 地图资产按**文件级**归属判定(assetsrc.resolveAssets)
 *      ② states 按**目录级**归属判定(assetsrc.resolveDir,一文件一 state)
 *      ③ 合成交给 engine 的 buildMapModel,本层只负责 BMP 解码与缓存
 *
 * ══ 关键约束 ══
 *  `provinces.bmp` 与 `definition.csv` **必须来自同一个生效来源**。
 *  否则颜色→省份 id 的映射和位图对不上,质心会整片错位而且**不报错** ——
 *  所以下面先判归属再读文件,而不是读到了才发现不对。
 * ══════════════════════════════════════════════════════════════════ */
interface WorldMapData extends MapModel {
  colorToId: Map<number, number>
  /** 省份 id → 归属 tag(着色用) */
  ownerTagOf: Map<number, string>
  /** tag → 颜色 */
  countryColor: Map<string, [number, number, number]>
  /** 省份 id → 地形内部名(来自 definition.csv 第 7 列;地形着色模式用) */
  terrainOf: Map<number, string>
  /** 省份 id → state id(州着色模式用;-1/缺失不收录) */
  provinceStateOf: Map<number, number>
  /** 省份 id → 战略区域 id(战略区域着色模式用) */
  provinceSRof: Map<number, number>
  /** 生效的 provinces.bmp 来自哪个来源 */
  bitmapRoot: number
  /** 生效的 definition.csv 来自哪个来源 */
  definitionRoot: number
  /** DLC 层:扫描结果 + 门控清单 */
  dlc: {
    list: DlcDescriptor[]
    summary: ReturnType<typeof summarizeDlc>
    gates: ReturnType<typeof collectDlcGates>
  }
  ready: true
}
let WM: WorldMapData | null = null
let WM_ERR = ''
const WM_IMG = new Map<string, Buffer>()
/** 地图页勾选启用的 DLC(**目录名**)。默认空 = 全部按"未拥有"算门控。
 *  改动会让地图模型失效(门控标注要重算),由 invalidateWorldMap 挂上。*/
let WM_DLC_ON = new Set<string>()
/** 上次打印 DLC 统计时的启用集合签名。用来去重日志:
 *  反复勾选 DLC 会反复 invalidate + 重建,不判重就会刷十几行同内容。*/
let WM_DLC_SIG: string | null = null

/** 当前 ROOTS(含 replace_path)→ 引擎侧来源表。**顺序即载入序**,靠后者优先 */
function srcRoots(): SrcRoot[] {
  return ROOTS.map((r) => {
    const d = parseModDescriptor(r.path)
    return { name: r.name, path: r.path, writable: r.writable, replacePaths: d.replacePaths }
  })
}

/** 已加载模组的 .mod 描述符(索引与 ROOTS 对齐) */
function modDescriptors(): ModDescriptor[] {
  return ROOTS.map((r) => parseModDescriptor(r.path))
}

/** replace_path 声明的签名串。拼进各功能磁盘缓存签名:
 *  同 ROOTS 下 .mod 的 replace_path 变化(如新声明或删除)应让旧缓存失效。 */
function replacePathsSig(): string {
  return ROOTS.map((r) => parseModDescriptor(r.path).replacePaths.join(',')).join(';')
}

/** 地图模型失效(ROOTS 变了必须重算,否则给出的是旧模组的图) */
function invalidateWorldMap(): void {
  WM = null
  WM_ERR = ''
  WM_IMG.clear()
  // ★ 换来源后即使启用集合没变也要重打统计:数字(如门控处数)可能已变
  WM_DLC_SIG = null
}

function buildWorldMap(): WorldMapData | null {
  if (WM) return WM
  if (WM_ERR) return null
  try {
    const roots = srcRoots()
    if (!roots.length) throw new Error('没有可用的来源')
    const mods = modDescriptors()

    // ① 先判归属 —— 位图与 csv 必须同源
    const assets = resolveAssets(roots, MAP_ASSETS as readonly string[])
    const bmpRef = assets.refs.get('map/provinces.bmp')
    const csvRef = assets.refs.get('map/definition.csv')
    const gapMsg = (ref?: { gapBy?: { root: number; replacePath: string }[] }): string =>
      (ref?.gapBy ?? []).map((x) => `「${roots[x.root]?.name}」replace_path="${x.replacePath}"`).join('、')
    if (!bmpRef || bmpRef.effective < 0) {
      throw new Error(
        `生效的 map/provinces.bmp 不存在(own=${bmpRef?.own ?? '缺失'})` +
          (gapMsg(bmpRef) ? ` —— ${gapMsg(bmpRef)} 声明替换却未提供该文件` : ''),
      )
    }
    if (!csvRef || csvRef.effective < 0) {
      throw new Error(
        `生效的 map/definition.csv 不存在(own=${csvRef?.own ?? '缺失'})` +
          (gapMsg(csvRef) ? ` —— ${gapMsg(csvRef)} 声明替换却未提供该文件` : ''),
      )
    }
    if (bmpRef.effective !== csvRef.effective) {
      throw new Error(
        `provinces.bmp 来自「${roots[bmpRef.effective].name}」而 definition.csv 来自「${roots[csvRef.effective].name}」` +
          ` —— 两者不同源,省份颜色映射会整体错位`,
      )
    }

    // ② 读生效的那一份
    const dec = decodeBmp(readFileSync(join(roots[bmpRef.effective].path, 'map', 'provinces.bmp')))
    if (!dec.ok || !dec.bitmap) throw new Error(dec.error || 'provinces.bmp 解码失败')
    const csvText = readFileSync(join(roots[csvRef.effective].path, 'map', 'definition.csv'), 'utf8')

    // ③ 交给引擎合成(质心 + states + 国家色 + 诊断)
    const model = buildMapModel({
      roots,
      mods,
      bitmap: { w: dec.bitmap.w, h: dec.bitmap.h, rgba: dec.bitmap.rgba },
      definitionCsv: csvText,
    })

    const colorToId = new Map<number, number>()
    for (const line of csvText.split('\n')) {
      const pp = line.split(';')
      if (pp.length < 4) continue
      const id = parseInt(pp[0], 10)
      const r = parseInt(pp[1], 10), g = parseInt(pp[2], 10), b = parseInt(pp[3], 10)
      if (!Number.isFinite(id) || !Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue
      colorToId.set((r << 16) | (g << 8) | b, id)
    }
    const ownerTagOf = new Map<number, string>()
    for (const [pid, info] of model.ownerOf) ownerTagOf.set(pid, info.owner)
    const countryColor = new Map<string, [number, number, number]>()
    for (const c of model.countries) countryColor.set(c.tag, c.color)
    /* ★ 地形映射:从 definition.csv 第 7 列(terrain)建 省份id→地形。
     *   地形着色模式按 province→terrain→调色板上色,独立于 owner 着色。 */
    const terrainOf = new Map<number, string>()
    for (const line of csvText.split('\n')) {
      const pp = line.split(';')
      if (pp.length < 7) continue
      const id = parseInt(pp[0], 10)
      const t = pp[6].trim()
      if (!Number.isFinite(id) || !t) continue
      terrainOf.set(id, t)
    }

    /* ★ 州 / 战略区域着色映射:省份 id → state id / 战略区域 id。
     *   provinces[].stateId 由 ownerOf 推导(无主海洋/湖泊为 -1 → 不收,保留原色);
     *   strategicRegionId 由 strategicregions 省份清单推导。两者都只收"确实有归属"的。*/
    const provinceStateOf = new Map<number, number>()
    const provinceSRof = new Map<number, number>()
    for (const p of model.provinces) {
      if (p.stateId != null && p.stateId >= 0) provinceStateOf.set(p.id, p.stateId)
      if (p.strategicRegionId != null) provinceSRof.set(p.id, p.strategicRegionId)
    }

    /* ④ DLC 层(2026-10-07)。
     * 实测结论写在 engine/src/dlcsrc.ts 顶部:本机 30 个 dlc/ + 4 个
     * integrated_dlc/ 目录全无 history/map 数据,所以 hasData 全 false。
     * 但 has_dlc 门控是真实的(77 个 state 含门控)—— 游戏里没买 DLC 时
     * 那些建筑格子是空的,工具必须能标出来,否则会误导。
     * enabledDlc 由 /api/worldmap/dlc 勾选后写进这里(默认空 = 全按"未拥有")。*/
    const gameRoot = ROOTS.find((r) => !r.writable)?.path ?? ''
    let dlcList: DlcDescriptor[] = []
    if (gameRoot) {
      try {
        dlcList = scanDlcDirs(gameRoot)
      } catch (e) {
        console.log('  DLC 扫描失败(不阻断地图):', String(e))
      }
    }
    const gates = collectDlcGates(model.states, dlcList, WM_DLC_ON)

    WM = {
      ...model,
      colorToId,
      ownerTagOf,
      countryColor,
      terrainOf,
      provinceStateOf,
      provinceSRof,
      bitmapRoot: bmpRef.effective,
      definitionRoot: csvRef.effective,
      dlc: { list: dlcList, summary: summarizeDlc(dlcList), gates },
      ready: true,
    }
    /* ★ 只在"启用集合真的变了"时打印。之前每次 POST /api/worldmap/dlc
     *   都 invalidate → 重建 → 打一行,验收里来回勾选十几轮就是十几行,
     *   真正的启动统计被埋掉了。数据没变时重建本身也省掉(门控结果一样)。*/
    if (dlcList.length) {
      const s = summarizeDlc(dlcList)
      const sig = [...WM_DLC_ON].sort().join('|')
      if (sig !== WM_DLC_SIG) {
        WM_DLC_SIG = sig
        console.log(
          `  DLC: ${s.total} 个(带数据 ${s.withData} / states ${s.withStates} / map ${s.withMap})` +
            ` · DLC 门控 ${gates.refs.length} 处,覆盖 ${Object.keys(gates.byDlc).length} 个 DLC` +
            ` · 已启用 ${WM_DLC_ON.size}`,
        )
        if (s.dataNoDesc.length) {
          console.log(`  ⚠ 这些 DLC 有数据但缺 .dlc 描述符,无法按正式名门控:${s.dataNoDesc.join(', ')}`)
        }
      }
    }
    return WM
  } catch (e: any) {
    WM_ERR = String((e && e.message) || e)
    return null
  }
}

/** 把归属国家的颜色覆盖到对应省份(无主的海洋/湖泊/陆地保留原色) */
function recolorByOwner(m: WorldMapData, rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  out.set(rgba)
  for (let i = 0; i < rgba.length; i += 4) {
    const pid = m.colorToId.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    if (pid === undefined) continue
    const tag = m.ownerTagOf.get(pid)
    if (!tag) continue
    const c = m.countryColor.get(tag)
    if (!c) continue
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255
  }
  return out
}

/** 地形调色板(HOI4 常见地形内部名 → RGB)。缺失的地形用中性灰。 */
const TERRAIN_PALETTE: Record<string, [number, number, number]> = {
  plains: [120, 170, 90], forest: [40, 110, 55], hills: [150, 130, 80],
  mountain: [140, 120, 110], urban: [180, 170, 160], desert: [210, 195, 130],
  jungle: [30, 95, 45], marsh: [95, 130, 120], arctic: [225, 230, 235],
  bocage: [95, 140, 80], frigid: [200, 215, 225], coast: [70, 150, 180],
  ocean: [45, 95, 140], lakes: [55, 120, 165], lake: [55, 120, 165],
  impassable_mountain: [120, 100, 95], oasis: [200, 200, 120], snow: [235, 238, 242],
  ice: [205, 225, 240], unknown: [150, 150, 150],
}
function recolorByTerrain(m: WorldMapData, rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  out.set(rgba)
  for (let i = 0; i < rgba.length; i += 4) {
    const pid = m.colorToId.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    if (pid === undefined) continue
    const t = m.terrainOf.get(pid)
    if (!t) continue
    const c = TERRAIN_PALETTE[t] || TERRAIN_PALETTE.unknown
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255
  }
  return out
}

/** 由整数 id 生成稳定的 RGB(州 / 战略区域着色)。
 *  黄金角递增色相 + 固定饱和度/亮度 → 相邻 id 色差明显,同 id 永远同色。*/
function idToColor(id: number): [number, number, number] {
  const hue = ((id * 137.508) % 360 + 360) % 360
  const s = 0.55, l = 0.55
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = hue / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0, g = 0, b = 0
  if (hp < 1) { r = c; g = x }
  else if (hp < 2) { r = x; g = c }
  else if (hp < 3) { g = c; b = x }
  else if (hp < 4) { g = x; b = c }
  else if (hp < 5) { r = x; b = c }
  else { r = c; b = x }
  const mm = l - c / 2
  return [Math.round((r + mm) * 255), Math.round((g + mm) * 255), Math.round((b + mm) * 255)]
}

/** 按所属 state 给省份上色(无主海洋/湖泊保留原色)。州模式。 */
function recolorByState(m: WorldMapData, rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  out.set(rgba)
  const cache = new Map<number, [number, number, number]>()
  for (let i = 0; i < rgba.length; i += 4) {
    const pid = m.colorToId.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    if (pid === undefined) continue
    const sid = m.provinceStateOf.get(pid)
    if (sid === undefined) continue
    let c = cache.get(sid)
    if (!c) { c = idToColor(sid); cache.set(sid, c) }
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255
  }
  return out
}

/** 按所属战略区域给省份上色(无归属保留原色)。战略区域模式。 */
function recolorBySR(m: WorldMapData, rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  out.set(rgba)
  const cache = new Map<number, [number, number, number]>()
  for (let i = 0; i < rgba.length; i += 4) {
    const pid = m.colorToId.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    if (pid === undefined) continue
    const rid = m.provinceSRof.get(pid)
    if (rid === undefined) continue
    let c = cache.get(rid)
    if (!c) { c = idToColor(rid); cache.set(rid, c) }
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255
  }
  return out
}

/* ── 启动序列(SETTINGS_TDZ)─────────────────────────────────────────────
 * 必须放在文件末尾:此时所有 const/let 模块级状态都已初始化,
 * applySavedSettingsAtBoot() 内部会间接触及 DEFAULT_DISPLAY / GAME_VERSION_TRIED。
 * 顺序:套用设置 → 打印横幅 → 重建索引(让 sprite 覆盖新 ROOTS)。 */
applySavedSettingsAtBoot()

console.log('\n▶ 正在初始化..... (HOI4 工作台构建索引中,请稍候)')
console.log('════════ HOI4 GUI 工作台 ════════')
for (const r of ROOTS) console.log(`  ${r.writable ? '[可写]' : '[只读]'} ${r.name}  ${r.path}`)

rebuildIndexes()
console.log('✔ 基础索引构建完成')

/* PARALLEL_V1(2026-10-17):启动 worker 池。
 * ★ 必须在 forceBuildAll() **之前**完成:runInWorker 在池未就绪时会直接回落
 *   主线程,而回落是按"每次调用"判断的 —— 池晚一拍就绪,首批任务(国策图等)
 *   全都白降级,等于没开并行。所以这里 await 到定标结束(通常几百毫秒)。
 * 池写好了却从未接线是本次要修的核心问题(worker-pool / cpu-probe / job-builders
 * 三者的 runInWorker、initPool、decideConcurrency 全都是零调用点)。 */
try {
  const verdict = await decideConcurrency()
  initPool(verdict.workers)
  console.log(`✔ 并行池就绪:${verdict.reason}(并发 ${verdict.workers})`)
} catch (e) {
  initPool(0)   // 起不来就彻底走主线程,功能不受影响
  console.log(`  [并行] 探测失败,全部回落主线程:${e instanceof Error ? e.message : String(e)}`)
}

/* BOOT_PREBUILD_V1(2026-10-10):启动即预建全部核心图(forceBuildAll),
   控制台走完(BUILD.building=false)后再打开浏览器,打开即就绪,
   期间 /api/status 对前端返回 building,页面不再出现等待遮罩。 */
forceBuildAll()
/* 按功能懒加载:不再启动全量预建。切到某功能页时,该页 ensure* 懒构建,
   前端在该页显示 bootgate 遮罩等待;已访问页命中 RESP_CACHE 秒开。 */

/** 用系统默认程序(浏览器)打开一个 URL。失败不致命。 */
function openBrowserInDefault(url: string): void {
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { windowsHide: true })
    else if (process.platform === 'darwin') execFileSync('open', [url], { windowsHide: true })
    else execFileSync('xdg-open', [url], { windowsHide: true })
  } catch {
    /* 开不了浏览器也不致命,用户手动打开 http://localhost:PORT 即可 */
  }
}

/** 经 shell 执行时,含空格/括号/重定向等字符的参数必须整体加引号,否则被拆成多个文件 */
function needsShellQuote(s: string): boolean {
  for (const c of s) {
    if (c === ' ' || c === '\t' || c === '(' || c === ')' || c === '&' || c === '|' || c === '<' || c === '>' || c === '^' || c === '"' || c === "'") return true
  }
  return false
}

/* CRASHLOG_V1(2026-10-18,优化10-后端侧):崩溃日志落盘。
 *
 * uncaughtException / unhandledRejection 原来只 console.log —— 工作台崩了,
 * 用户除了"窗口没反应"什么都拿不到,开发者也无从排查。这里把 时间戳+stack
 * 落盘到 <数据根>/temp/crash-<本地时间戳>.log:每次崩溃一个文件(可多条并存),
 * 便于事后翻历史。
 * 保持现有"不让进程崩"的行为:记完日志照常返回,不 process.exit;
 * 只有 EADDRINUSE / 服务器致命错误这种本来就要退出的,才在退出前补一条。 */
function writeCrashLog(kind: string, e: unknown): void {
  try {
    const dir = join(KIT_DATA, 'temp')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' + String(d.getMilliseconds()).padStart(3, '0')
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e)
    const body = '[' + d.toISOString() + '] [' + kind + ']' + EOL + stack + EOL + EOL
    writeFileSync(join(dir, 'crash-' + stamp + '.log'), body)
  } catch { /* 日志写不出来也不能再抛 —— 否则崩溃处理器自己崩 */ }
}

/* 端口占用:EADDRINUSE 时打印中文指引并正常退出,而不是抛栈崩溃。 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    writeCrashLog('EADDRINUSE', err)
    console.error(`\n  ✗ 端口 ${PORT} 被占用。`)
    console.error('    可用 --port <端口> 或环境变量 PORT=<端口> 换端口后重试。')
    process.exit(1)
  }
  writeCrashLog('serverError', err)
  console.error('  [服务器错误] ' + (err instanceof Error ? err.stack : String(err)))
  process.exit(1)
})
/* 全局兜底:任何漏网的异步异常 / Promise rejection 都只记日志、不让进程崩溃
 * (本地开发工具,单个请求出错不该把整个工作台搞挂)。 */
process.on('uncaughtException', (e) => {
  writeCrashLog('uncaughtException', e)
  console.log('  [uncaughtException] ' + (e instanceof Error ? e.stack : String(e)))
})
process.on('unhandledRejection', (e) => {
  writeCrashLog('unhandledRejection', e)
  console.log('  [unhandledRejection] ' + (e instanceof Error ? e.stack : String(e)))
})

const __mioIsMain = (() => { try { return !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]) } catch { return false } })()
if (__mioIsMain) {
  // SEC_BIND_V1(2026-10-22):独立运行(浏览器模式)只绑回环。
  // 不传 host 时 Node 绑到 ::(全网卡)—— 这台机器上存着用户整个 mod 目录,
  // 同一局域网的任何人都能 curl 到文件内容与 API。需要对外时用
  // HOI4TK_HOST=0.0.0.0 显式放开(自行斟酌风险)。
  const HOST = process.env.HOI4TK_HOST || '127.0.0.1'
  server.listen(PORT, HOST, () => {
    console.log(`\n  工作台已启动: http://localhost:${PORT} (绑定 ${HOST})`)
  console.log(`  只读模式: ${READONLY ? '是' : '否'}`)
  // AUTO_OPEN:等控制台全量初始化(forceBuildAll 队列走完,BUILD.building=false)
  //   再打开浏览器 —— 打开即是就绪,页面不再等待遮罩
  if (AUTO_OPEN) {
    const tryOpen = () => {
      if (BUILD.building) { setTimeout(tryOpen, 400); return }
      console.log('✔ 初始化完成,工作台已可用')
      console.log('  正在打开浏览器…')
      openBrowserInDefault(`http://127.0.0.1:${PORT}/`)
    }
    tryOpen()
  } else {
    console.log('✔ 初始化完成,工作台已可用')
  }
  // 引用图懒加载(2026-10-10):不再启动预建,主页面秒开。首次访问引用图功能时由 ensureLinks() 按需构建。
})

}
export { server }
