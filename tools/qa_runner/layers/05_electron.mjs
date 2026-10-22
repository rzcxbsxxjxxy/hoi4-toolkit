/* ================================================================
 * 层 05 —— Electron 主进程(真起 electron.exe,端到端 boot 冒烟)
 *
 * 做法(参考 tools/boot_measure.mts 的 spawn+管道捕获+deadline 轮询+清理退出):
 *   但本层量的不是 dev server,而是【electron 本体】:
 *     spawn(node_modules/electron/dist/electron.exe, ['.'], { cwd: 项目根 })
 *
 * main.cjs 走 app:// 协议自载后端(server.mjs 随 import 构建索引,无 TCP 端口),
 *   故本层【不依赖 5175 dev server】;--base 仅记录用。
 *
 * 关键日志(已核对 main.cjs 行号):
 *   L654  [boot] splash shown (+Xms)                     <- bootT0 起算
 *   L660  [boot] backend loaded (+Yms 构建索引)           <- bootT1 起算(不等于 bootT0)
 *   L665  [boot] main window created (+Zms)              <- bootT2 起算(不等于前两者)
 *   L526  [win] front-ready -^> show main window
 *   L513  [win:show] 主窗显示(壳就绪;自 loadURL 起 Nms)
 *   L103  [electron] uncaughtException:
 *   L646  dialog.showErrorBox('后端重启失败', ...)        (原生弹窗,主流程不触发;仅做日志串扫描)
 *
 * 注意:三个 +Nms 的【基准点不同】(bootT0/bootT1/bootT2),
 *   因此它们之间【不是】跨阶段单调递增的累计值;本层只断言:
 *     (1) 每个 +Nms 都能解析成「非负整数」;
 *     (2) 三行日志在 stdout 中的出现位置按 boot 顺序递增(splash->backend->created)。
 *
 * 退出码: 0=全过(含已确认豁免)  1=有用例失败  2=基础设施错误(electron 起不来/单实例冲突等)
 * 注意:运行会弹出真实窗口,测完用 child.kill() + taskkill /PID /T /F 兜底彻底清理。
 * ================================================================ */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(HERE, '..')
const ROOT = resolve(RUNNER, '..', '..')

const argv = process.argv.slice(2)
const pick = (k, d) => { const h = argv.find((a) => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d }
const BASE = pick('--base', '(none - electron app:// 自载后端,无需 dev server)')
const OUT = pick('--out', join(RUNNER, 'results', '05_electron.json'))

const ELECTRON_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const TOTAL_DEADLINE_MS = 180000   // 首启构建索引可能慢,总等待 180s
const SPLASH_DEADLINE_MS = 60000    // 这么久连 splash 都没出来 -> 视为起不来(基础设施错误)
const STABLE_AFTER_SHOW_MS = 5000  // [win:show] 之后再稳跑 >=5s
const POLL_MS = 100

const cases = []
function rec(name, pass, detail, extra = {}) {
  const exempt = !!extra.exempt
  cases.push({ name, pass, detail, exempt, exemptReason: extra.exemptReason || null })
  console.log(`${exempt ? 'EXEMPT' : pass ? 'PASS  ' : 'FAIL  '} ${name}${detail ? '   ' + detail : ''}`)
}
function writeResult() {
  const summary = { total: cases.length, pass: 0, fail: 0, exempt: 0 }
  for (const c of cases) { if (c.exempt) summary.exempt++; else if (c.pass) summary.pass++; else summary.fail++ }
  const doc = { layer: '05_electron', base: BASE, ts: new Date().toISOString(), summary, cases }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8')
  console.log(`\n=== 05_electron 汇总: total=${summary.total} pass=${summary.pass} fail=${summary.fail} exempt=${summary.exempt} ===`)
  console.log('结果 JSON ->', OUT)
  return summary
}
function infraError(msg) {
  console.error('\n[基础设施错误] ' + msg)
  console.error('---- 已捕获日志 ----')
  console.error(log || '(无 stdout/stderr 输出)')
  writeResult()
  process.exit(2)
}

/* ── 基础设施前置:electron.exe / server.mjs 必须在 ── */
if (!existsSync(ELECTRON_EXE)) infraError(`找不到 electron 二进制: ${ELECTRON_EXE}`)
if (!existsSync(join(ROOT, 'server.mjs'))) infraError('找不到编译后端 server.mjs(请先 npm run build:server)')

/* ── 起 electron(GUI 子进程,直接 spawn exe) ── */
let child = null
let log = ''
let spawnErr = null
try {
  child = spawn(ELECTRON_EXE, ['.'], {
    cwd: ROOT,
    env: { ...process.env, HOI4TK_UPDATE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  infraError('spawn electron.exe 失败: ' + (e && e.message))
}

child.stdout.on('data', (d) => { log += d.toString() })
child.stderr.on('data', (d) => { log += d.toString() })
child.on('error', (e) => { spawnErr = e })
let exitInfo = null  // {code, signal}
child.on('exit', (code, signal) => { exitInfo = { code, signal } })

/* ── 标记检测 + 记录每个标记首次出现的墙钟(用于 front-ready->show 间隔) ── */
const mark = { splash: -1, backend: -1, created: -1, frontReady: -1, show: -1 }
const tStart = Date.now()

const re = {
  splash: /\[boot\] splash shown \(\+(\d+)ms\)/,
  backend: /\[boot\] backend loaded \(\+(\d+)ms 构建索引\)/,
  created: /\[boot\] main window created \(\+(\d+)ms\)/,
  frontReady: /\[win\] front-ready -\^> show main window/,
  show: /\[win:show\] 主窗显示\(壳就绪;自 loadURL 起 (\d+)ms\)/,
}
function detectMarks(now) {
  if (mark.splash < 0 && re.splash.test(log)) mark.splash = now
  if (mark.backend < 0 && re.backend.test(log)) mark.backend = now
  if (mark.created < 0 && re.created.test(log)) mark.created = now
  if (mark.frontReady < 0 && re.frontReady.test(log)) mark.frontReady = now
  if (mark.show < 0 && re.show.test(log)) mark.show = now
}

/* ── 阶段一:轮询到 [win:show] 或超时 ── */
let booted = false
while (Date.now() - tStart < TOTAL_DEADLINE_MS) {
  const now = Date.now() - tStart
  detectMarks(now)

  // 单实例锁:已有另一个实例在跑 -> 当前实例立刻退出
  if (/another instance is running/.test(log)) {
    try { child.kill() } catch (e) {}
    infraError('检测到「another instance is running」:已有另一个 HOI4 工具链 Electron 实例在运行(单实例锁)。请先关闭它再跑本层。')
  }
  if (exitInfo && mark.splash < 0) break  // splash 前就退了 -> 起不来
  if (mark.show >= 0) { booted = true; break }
  if (now > SPLASH_DEADLINE_MS && mark.splash < 0) break  // splash 超时 -> 起不来

  await new Promise((r) => setTimeout(r, POLL_MS))
}
detectMarks(Date.now() - tStart)

/* ── 基础设施判定:splash 都没有 = 起不来(退出码 2) ── */
if (mark.splash < 0) {
  try { child.kill() } catch (e) {}
  infraError(`electron 在 ${SPLASH_DEADLINE_MS}ms 内未输出任何 [boot] splash shown(可能缺依赖/被杀软拦截/启动崩溃)。spawnErr=${spawnErr ? spawnErr.message : '无'} exit=${JSON.stringify(exitInfo)}`)
}

/* ── 阶段二:稳定运行 —— 从 [win:show] 起再跑 >=5s 不退出 ── */
let stableAlive = true
if (booted) {
  const stableDeadline = Date.now() + STABLE_AFTER_SHOW_MS
  while (Date.now() < stableDeadline) {
    if (exitInfo) { stableAlive = false; break }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/* ================================================================
 * 断言
 * ================================================================ */
const bootSplash = log.match(re.splash)
const bootBackend = log.match(re.backend)
const bootCreated = log.match(re.created)
const bootShow = log.match(re.show)

rec('boot_splash_shown', !!bootSplash, bootSplash ? bootSplash[0].trim() : '日志中未出现 [boot] splash shown')
rec('boot_backend_loaded', !!bootBackend, bootBackend ? bootBackend[0].trim() : '日志中未出现 [boot] backend loaded')
rec('boot_main_window_created', !!bootCreated, bootCreated ? bootCreated[0].trim() : '日志中未出现 [boot] main window created')
rec('front_ready_received', /\[win\] front-ready -\^> show main window/.test(log),
  /\[win\] front-ready/.test(log) ? 'front-ready 信号已收到' : '未收到 [win] front-ready(主窗可能走 did-finish-load 兜底 show)')
rec('main_window_shown', !!bootShow, bootShow ? bootShow[0].trim() : '日志中未出现 [win:show] 主窗显示')

/* f. 启动计时:三个 +Nms 均为非负整数;且三行按 boot 顺序出现;front-ready->show 间隔合理 */
{
  const nums = [bootSplash && bootSplash[1], bootBackend && bootBackend[1], bootCreated && bootCreated[1]].map((s) => (s == null ? null : Number(s)))
  const allParsed = nums.every((n) => Number.isFinite(n) && n >= 0)
  const i1 = log.indexOf('[boot] splash shown')
  const i2 = log.indexOf('[boot] backend loaded')
  const i3 = log.indexOf('[boot] main window created')
  const ordered = i1 >= 0 && i2 > i1 && i3 > i2
  const frToShow = (mark.frontReady >= 0 && mark.show >= 0) ? (mark.show - mark.frontReady) : null
  const frOk = frToShow !== null && frToShow >= 0 && frToShow < 30000
  const ok = allParsed && ordered && frOk
  const detail = `+splash=${nums[0]}ms +backend=${nums[1]}ms +created=${nums[2]}ms(各自基准 bootT0/T1/T2 不同); 行序splash<backend<created=${ordered}; front-ready->show=${frToShow === null ? '(缺信号)' : frToShow + 'ms'}`
  rec('boot_timing_sane', ok, detail + (allParsed ? '' : ' 存在无法解析的 +Nms'))
}

/* g. 无错误特征 */
{
  const bad = []
  const scans = [
    [/\[electron\] uncaughtException/, 'uncaughtException'],
    [/后端重启失败/, '后端重启失败'],
    [/exited code/i, 'exited code'],
    [/Render process gone/i, 'Render process gone'],
    [/A JavaScript error occurred/i, 'A JavaScript error occurred'],
  ]
  for (const [rx, name] of scans) if (rx.test(log)) bad.push(name)
  rec('no_errors_or_crash', bad.length === 0, bad.length ? `命中错误特征: ${bad.join(' | ')}` : '日志中无 uncaughtException/重启失败/exited code/渲染崩溃特征')
}

/* h. 稳定运行 >=5s */
rec('stable_after_show_5s', booted && stableAlive,
  booted ? (stableAlive ? `[win:show] 后连续运行 >=${STABLE_AFTER_SHOW_MS}ms 进程未退出` : '稳定观察期内进程提前退出')
    : '未到达 [win:show],无法做稳定运行观察')

/* ================================================================
 * 收尾:彻底杀进程树,防止残留窗口/渲染进程
 * ================================================================ */
const pid = child && child.pid
async function killTree() {
  try { if (child && !exitInfo) child.kill() } catch (e) {}
  for (let i = 0; i < 20; i++) { if (exitInfo) break; await new Promise((r) => setTimeout(r, 100)) }
  if (pid && !exitInfo) {
    await new Promise((res) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      k.on('exit', () => res())
      k.on('error', () => res())
    })
  }
}
await killTree()

/* i. 干净退出:确认本 PID 树已结束(tasklist 里查不到) */
let residue = false
let residueDetail = '无'
if (pid) {
  try { process.kill(pid, 0); residue = true } catch (e) { /* 已退出 = 干净 */ }
  residueDetail = await new Promise((res) => {
    const t = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    t.stdout.on('data', (d) => { out += d.toString() })
    t.on('exit', () => res(out.trim()))
    t.on('error', () => res('(tasklist 不可用)'))
  })
  if (new RegExp(`\\b${pid}\\b`).test(residueDetail)) residue = true
}
rec('clean_exit_no_residue', !residue, residue ? `PID ${pid} 仍在进程列表: ${residueDetail}` : `PID ${pid} 已退出,任务列表无残留`)

/* ── 打印关键 boot 计时证据 ── */
console.log('\n---- boot 计时关键日志片段 ----')
for (const line of log.split(/\r?\n/)) {
  if (/\[boot\]|\[win\]|\[win:show\]|data dir|载入后端|后端已载入/.test(line)) console.log('  ' + line.trim())
}
if (exitInfo) console.log(`(子进程最终 exit: code=${exitInfo.code} signal=${exitInfo.signal})`)

/* ── 写结果 + 退出码 ── */
const summary = writeResult()
process.exit(summary.fail === 0 ? 0 : 1)
