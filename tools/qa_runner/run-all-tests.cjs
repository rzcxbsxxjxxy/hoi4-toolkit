/* ================================================================
 * QA Runner -- HOI4 Toolkit (Electron) 统一自动化测试入口
 *
 * 用法:
 *   node tools/qa_runner/run-all-tests.cjs                          # 跑全部层
 *   node tools/qa_runner/run-all-tests.cjs --base=http://127.0.0.1:5175
 *   node tools/qa_runner/run-all-tests.cjs --layers=01,03,06        # 只跑指定层
 *   (Windows 一键: 双击 run-all-tests.bat)
 *
 * 退出码: 0 = 全部通过(含已确认豁免项)   1 = 存在失败
 *
 * 每层契约:
 *   - 脚本自打印 [PASS] / [FAIL] / [EXEMPT] 行
 *   - 结果 JSON 写入 results/<json>:
 *       { layer, base, ts, summary:{total,pass,fail,exempt},
 *         cases:[{name, pass, detail, exempt, exemptReason}] }
 *     (exempt=true 的用例计入 summary.exempt,不计入 fail)
 *   - 退出码 0/1 (2=基础设施错误,如 dev server 不可达)
 *
 * 02 渲染层为 bu 交互式层(无 node 脚本):由 browser-use-automation 驱动
 *   Chrome 逐页实测,产出 results/02_render_bu.json;runner 直接读取该文件。
 *   文件缺失时本层判 FAIL 并给出重跑指引。
 * ================================================================ */
const { spawn } = require('node:child_process')
const { readFileSync, existsSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const RUNNER = __dirname
const ROOT = resolve(RUNNER, '..', '..')          // 项目根
const RESULTS = join(RUNNER, 'results')

const argv = process.argv.slice(2)
const pick = (key, def) => {
  const hit = argv.find((a) => a.startsWith(key + '='))
  return hit ? hit.split('=').slice(1).join('=') : def
}
const BASE = pick('--base', 'http://127.0.0.1:5175')
const LAYER_FILTER = (pick('--layers', '') || '').split(',').map((s) => s.trim()).filter(Boolean)

/* 层清单: 顺序即执行顺序。05(Electron)放最后,避免 GUI 窗口干扰其他层 */
const LAYERS = [
  { id: '01', file: 'layers/01_static_api.mts', json: '01_static_api.json', desc: '静态/语法/路由/后端 API', timeoutMs: 900000 },
  { id: '03', file: 'layers/03_mio.mjs',        json: '03_mio.json',        desc: 'MIO 专项(机构树/政策/属性)', timeoutMs: 900000 },
  { id: '04', file: 'layers/04_loc.mjs',        json: '04_loc.json',        desc: '本地化专项($$解键/name优先)', timeoutMs: 900000 },
  { id: '06', file: 'layers/06_mod_replace.mjs', json: '06_mod_replace.json', desc: '模组替换规则(同路径同名去重)', timeoutMs: 900000 },
  { id: '02', file: null, external: true, json: '02_render_bu.json', desc: '前端渲染 26 页(bu 自动化)', timeoutMs: 0 },
  { id: '05', file: 'layers/05_electron.mjs',   json: '05_electron.json',  desc: 'Electron 主进程(启动/计时/不崩)', timeoutMs: 240000 },
]

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function summarize(rows) {
  const t = { total: 0, pass: 0, fail: 0, exempt: 0 }
  for (const r of rows) { t.total += r.summary.total; t.pass += r.summary.pass; t.fail += r.summary.fail; t.exempt += r.summary.exempt }
  return t
}

async function runNodeLayer(l) {
  const t0 = Date.now()
  const script = join(RUNNER, l.file)
  const out = join(RESULTS, l.json)
  const args = []
  if (/\.(mts|ts)$/.test(l.file)) args.push('--experimental-strip-types')
  args.push(script, '--base=' + BASE, '--out=' + out)
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, l.timeoutMs || 600000)
  const code = await new Promise((res) => child.on('close', res))
  clearTimeout(timer)
  const doc = readJson(out)
  /* 结果判定: 退出码 0 且 JSON 合法且 fail=0 才算过 */
  const ok = code === 0 && doc && Array.isArray(doc.cases) && doc.summary && doc.summary.fail === 0
  const summary = doc ? doc.summary : { total: 0, pass: 0, fail: 1, exempt: 0 }
  let detail = 'exit=' + code
  if (!doc) detail += ' / 未产出结果 JSON(' + out + ')'
  else if (code !== 0 && doc.summary.fail === 0) detail += ' / 退出码与 JSON 不一致'
  const fails = (doc ? doc.cases : []).filter((c) => !c.pass && !c.exempt)
  return {
    layer: l.id, desc: l.desc, status: ok ? 'PASS' : 'FAIL', summary,
    duration: Date.now() - t0, detail, log, fails,
  }
}

function readExternalLayer(l) {
  const out = join(RESULTS, l.json)
  const doc = readJson(out)
  if (!doc || !Array.isArray(doc.cases) || !doc.summary) {
    return {
      layer: l.id, desc: l.desc, status: 'FAIL', duration: 0,
      summary: { total: 0, pass: 0, fail: 1, exempt: 0 },
      detail: '缺失结果文件 ' + out + ' — 需先由 bu 自动化逐页实测并产出(见验收报告「如何重跑」)',
      log: '', fails: [{ name: '02_render_bu.json 缺失', pass: false, detail: 'bu 渲染层未执行' }],
    }
  }
  const fails = (doc.cases || []).filter((c) => !c.pass && !c.exempt)
  return {
    layer: l.id, desc: l.desc, status: doc.summary.fail === 0 ? 'PASS' : 'FAIL',
    summary: doc.summary, duration: 0,
    detail: doc.base ? 'base=' + doc.base : '', log: '', fails,
  }
}

async function preflight() {
  try {
    const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(4000) })
    const j = await r.json()
    if (r.status === 200 && j && (j.ready === true || j.ready === false)) return 'dev server 可达(' + BASE + '),ready=' + j.ready
    return 'dev server 返回异常状态码 ' + r.status
  } catch (e) {
    return 'dev server 不可达(' + BASE + '): ' + e.message + ' —— 请先起 dev server(提示:node server.mjs --port 5175)或改用 --base 指向其他实例'
  }
}

;(async () => {
  mkdirSync(RESULTS, { recursive: true })
  console.log('\n=== HOI4 Toolkit QA Runner ===  base=' + BASE)
  console.log('预检: ' + (await preflight()) + '\n')

  const rows = []
  for (const l of LAYERS) {
    if (LAYER_FILTER.length && !LAYER_FILTER.includes(l.id)) continue
    const t0 = Date.now()
    process.stdout.write('── 层 ' + l.id + ' ' + l.desc + ' ... ')
    const row = l.external ? readExternalLayer(l) : await runNodeLayer(l)
    row.duration = Date.now() - t0
    const f = row.summary.fail
    process.stdout.write(row.status + ' (total=' + row.summary.total + ' pass=' + row.summary.pass + ' fail=' + f + ' exempt=' + row.summary.exempt + ' ' + Math.round(row.duration / 1000) + 's)\n')
    if (row.detail) console.log('    ' + row.detail)
    for (const c of row.fails.slice(0, 20)) console.log('    FAIL 用例: ' + c.name + '  ' + c.detail)
    if (row.fails.length > 20) console.log('    … 其余 ' + (row.fails.length - 20) + ' 个失败用例见 results/' + LAYERS.find((x) => x.id === row.layer).json)
    rows.push(row)
  }

  const t = summarize(rows)
  console.log('\n============ 汇总 ============')
  for (const r of rows) console.log('  层 ' + r.layer + ' [' + r.status + '] ' + r.desc + ': total=' + r.summary.total + ' pass=' + r.summary.pass + ' fail=' + r.summary.fail + ' exempt=' + r.summary.exempt + ' (' + Math.round(r.duration / 1000) + 's)')
  console.log('\n总计: ' + t.total + ' 用例 / ' + t.pass + ' 通过 / ' + t.fail + ' 失败 / ' + t.exempt + ' 豁免')
  if (t.fail === 0) {
    console.log('\n✔ 验收通过:全部层 PASS(失败 0,豁免项已确认)\n')
    process.exit(0)
  } else {
    console.log('\n✘ 验收未通过:' + t.fail + ' 个失败用例。失败明细见上方各层输出与 results/*.json\n')
    process.exit(1)
  }
})().catch((e) => { console.error('runner 异常:', e); process.exit(1) })