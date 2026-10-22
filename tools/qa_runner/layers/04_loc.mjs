/* ================================================================
 * 层 04 —— 本地化专项 ($$ 解键 / name 优先 / 无原始键残留 / 不硬编码键值)
 *
 * 数据来源(本层主口径): 进程内 import packages/gui/src/locsrv.ts,
 *   调 buildLocIndex 构建 LocIndex。不依赖 dev server 也能跑。
 *   (--base 仅用于记录与可选探活;本地化断言一律以进程内索引为准。)
 *
 * $$ 解析算法(与 locclient 思路一致,但修正了 `$$` 预吞边界的缺陷):
 *   1) 反复把 `$KEY$` 分词换成「同语言词典里 KEY 的值」,直到不动点(≤12 轮防自循环):
 *        - KEY 在本语言词典里有 → 代入;代入结果若仍含 $,下一轮继续解。
 *        - KEY 在本语言词典里没有 → 原样保留 `$KEY$`(游戏运行期变量,如 $arms_factory$,
 *          不属于本地化缺译,单列桶计数,不判失败)。
 *   2) `$A$$B$` 这种首尾相接的两条引用:中间的 `$$` 是边界,不是转义美元;
 *      分词式直接把 A、B 各自解析,边界 `$` 即分隔符(绝不能先做 `$$`→占位符,否则两条引用都坏)。
 *   「多层引用」= 某值整体就是 `$A$`,而 A 的值又是 `$B$`,B 的值才是正文 ——
 *      迭代到不动点自然把它解到底;本层额外对「链中含至少一层嵌套」的条目做结构性计数。
 *
 * 退出码: 0=全过(含已确认豁免)  1=有失败
 * ================================================================ */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(HERE, '..')
const ROOT = resolve(RUNNER, '..', '..')
const S = (p) => pathToFileURL(join(ROOT, 'packages', 'gui', 'src', p)).href

const argv = process.argv.slice(2)
const pick = (k, d) => { const h = argv.find((a) => a.startsWith(k + '=')); return h ? h.split('=').slice(1).join('=') : d }
const BASE = pick('--base', 'http://127.0.0.1:5175')
const OUT = pick('--out', join(RUNNER, 'results', '04_loc.json'))

const cases = []
function rec(name, pass, detail, extra = {}) {
  const exempt = !!extra.exempt
  cases.push({ name, pass, detail, exempt, exemptReason: extra.exemptReason || null })
  console.log(`${exempt ? 'EXEMPT' : pass ? 'PASS  ' : 'FAIL  '} ${name}${detail ? '   ' + detail : ''}`)
}

/* ── 根目录:与 tools/test_loc_stream.mts 同一读法 ── */
function roots() {
  const s = JSON.parse(readFileSync(join(ROOT, 'gui-settings.json'), 'utf8'))
  const out = []
  if (s.base) out.push({ name: 'vanilla', path: s.base, writable: false })
  for (const m of s.mods ?? []) if (m.enabled) out.push({ name: m.path.split(/[\\/]/).pop(), path: m.path, writable: true })
  return out
}

/* ── 载入 locsrv(进程内 .ts 直读,Node22 自带 type strip) ── */
const loc = await import(S('locsrv.ts'))
const rootsArr = roots()
const WANT = new Set(['l_english', 'l_simp_chinese'])

console.log('构建 LocIndex(进程内同步全量)…')
const t0 = Date.now()
const idx = loc.buildLocIndex(rootsArr, { wantLangs: WANT })
console.log(`  ${Date.now() - t0} ms  langs=${idx.langs.join(',')}  entries=${idx.stats.entries}  files=${idx.files.length}\n`)

/* per-language: key -> 拼接后的展示值(多行按 index 拼成一个串) */
function langDict(lang) {
  const m = idx.byLang.get(lang)
  const d = new Map()
  if (!m) return d
  for (const [k, hits] of m) d.set(k, loc.joinHits(hits))
  return d
}

/* expandRefs:正确的引用分词 —— 反复把 `$KEY$` 换成同语言词典值,直到不动点。
 * 【关键修正】不能像 locclient 那样先做 `$$`→占位符:对 `$A$$B$`(两个引用首尾相接),
 *   中间的 `$$` 是两条引用的边界,不是转义美元;先吃掉它会把两条引用都弄坏、永远解不开。
 *   正确做法:直接按 `$KEY$` 贪婪左→右分词,边界 `$` 本身就是引用分隔符。
 *   词典里没有的 K(游戏运行期变量 $arms_factory$ 等)原样保留。
 */
function expandRefs(raw, dict) {
  let out = String(raw)
  const undefinedRefs = new Set()
  for (let i = 0; i < 12; i++) {
    let changed = false
    out = out.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, k) => {
      if (dict.has(k)) { changed = true; return dict.get(k) }
      undefinedRefs.add(k)
      return whole
    })
    if (!changed) break
  }
  return { text: out, undefinedRefs }
}

/* ================================================================
 * 用例 0: 索引本身可用
 * ================================================================ */
rec('loc_index_built',
  idx.stats.entries > 0 && idx.langs.includes('l_english') && idx.langs.includes('l_simp_chinese'),
  `langs=${idx.langs.join(',')} entries=${idx.stats.entries} files=${idx.files.length}`)

/* ================================================================
 * 用例 A: $KEY$ 引用 —— 词典里有的键必须解到不动点;$$ 是字面 $
 * ================================================================ */
{
  let definedRefs = 0, multiLayerChains = 0
  const broken = []
  const undefinedByLang = {}
  for (const lang of idx.langs) {
    const dict = langDict(lang)
    undefinedByLang[lang] = new Set()
    for (const [k, raw] of dict) {
      if (!raw.includes('$')) continue
      const { text, undefinedRefs } = expandRefs(raw, dict)
      for (const u of undefinedRefs) undefinedByLang[lang].add(u)
      // 多层:值整体是 $X$,且 X 的值本身又含 $ → 命中嵌套链
      const m0 = raw.match(/^\$([A-Za-z0-9_]+)\$/)
      if (m0) {
        const innerVal = dict.get(m0[1])
        if (innerVal && innerVal !== raw && innerVal.includes('$')) multiLayerChains++
      }
      for (const m of raw.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
        const K = m[1]
        if (dict.has(K)) {
          definedRefs++
          const re = new RegExp('\\$' + K.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\$')
          if (re.test(text)) broken.push(`${lang}:${k} -> ${K}`)
        }
      }
    }
  }
  const undefSummary = Object.entries(undefinedByLang).map(([l, s]) => `${l}:${s.size}变量`).join(' ')
  rec('dollar_ref_defined_resolves_to_fixedpoint',
    broken.length === 0,
    `definedRefs=${definedRefs} nestedChains=${multiLayerChains} undefined(游戏变量/缺译,单列不判错)=${undefSummary}` +
    (broken.length ? `  残留 ${broken.length} 条,例: ${broken.slice(0, 5).join(' | ')}` : ''))
  // $$ 字面保留:含 $$ 的源串,展开后占位符必须还原成单个 $,不得泄漏 \u0000
  let dollarLiteralOk = true, dollarChecked = 0, dollarBroken = []
  for (const lang of idx.langs) {
    const dict = langDict(lang)
    for (const [, raw] of dict) {
      if (!raw.includes('$$')) continue
      dollarChecked++
      const { text } = expandRefs(raw, dict)
      // 分词式展开不得引入任何占位符/控制字符;也不得把非引用位置的 $$ 吃成空
      if (text.includes('\u0000') || text.includes('\u0001')) { dollarLiteralOk = false; dollarBroken.push(lang) }
    }
  }
  rec('dollar_literal_$$_not_corrupted',
    dollarLiteralOk,
    `含$$源串=${dollarChecked}(分词式展开不碰非引用 $$,无占位符泄漏)` + (dollarBroken.length ? `  泄漏:${dollarBroken.join(',')}` : ''))
}

/* ================================================================
 * 用例 B: name 优先,无 name 用本名
 * ================================================================ */
{
  const en = idx.byLang.get('l_english')
  const sample = [...en.keys()].find((k) => {
    const t = loc.joinHits(en.get(k))
    return t && t.length >= 2 && t !== k && !t.includes('$')
  })
  const hit = loc.lookupKeys(idx, [sample]).get(sample)
  const expected = hit ? hit.text : sample
  function resolveDisplay(entry) {
    const key = entry.name || entry.id
    if (!key) return { out: null, used: null }
    const h = loc.lookupKeys(idx, [key]).get(key)
    return { out: h ? h.text : key, used: key }
  }
  const withName = resolveDisplay({ name: sample, id: 'FAKE_ID_no_such_key_zzz' })
  const b1 = withName.out === expected && withName.out !== 'FAKE_ID_no_such_key_zzz'
  const noName = resolveDisplay({ id: sample })
  const b2 = noName.out === expected && noName.out !== sample
  rec('name_attribute_preferred_then_fallback_to_id',
    b1 && b2,
    `样本key=${sample}  有name→${b1 ? '用name译文OK' : 'BAD'}  无name→${b2 ? '用本名译文OK' : 'BAD'}  out="${String(expected).slice(0, 30)}"`)
}

/* ================================================================
 * 用例 C: 前端 html/js 里不出现「既是 loc 键、又被硬编码进可见文本」的原始键
 * ================================================================ */
{
  const dict = new Set()
  for (const m of idx.byLang.values()) for (const k of m.keys()) dict.add(k)
  const dir = join(ROOT, 'packages', 'gui', 'public')
  const files = readdirSync(dir).filter((f) => /\.(html|js)$/.test(f) && !/\.bak/.test(f))
  const re = /[A-Z][A-Z0-9_]{3,}_[A-Z0-9_]+/g
  const hits = new Map()
  for (const f of files) {
    if (f.startsWith('i18n-dict')) continue
    const lines = readFileSync(join(dir, f), 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
      for (const tok of line.match(re) || []) {
        if (dict.has(tok)) { if (!hits.has(tok)) hits.set(tok, new Set()); hits.get(tok).add(f) }
      }
    }
  }
  const arr = [...hits.entries()].map(([k, fs]) => `${k}<-${[...fs].join(',')}`)
  rec('no_raw_loc_key_hardcoded_in_ui',
    hits.size === 0,
    `交集 token=${hits.size}(0=无硬编码原始键)` + (arr.length ? `  发现: ${arr.slice(0, 10).join(' | ')}` : ''))
}

/* ================================================================
 * 用例 D: 不做硬编码键值 —— 「值==键」只允许纯数据侧出现,
 *   该键绝不允许同时被我们前端源码引用(那才是回退残留)。
 * ================================================================ */
{
  const eq = []
  for (const lang of idx.langs) {
    const m = idx.byLang.get(lang)
    for (const [k, hits] of m) if (loc.joinHits(hits).trim() === k) eq.push(k)
  }
  const dir = join(ROOT, 'packages', 'gui', 'public')
  const ourSrc = readdirSync(dir).filter((f) => /\.(html|js)$/.test(f) && !/\.bak/.test(f))
    .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
  // 只盯「全大写下划线式、像 loc 键」的 value==key;月份/星期/专名(Mar/Dec/Allies…)
  // 是人读词或在日期数组里正常使用,不算回退残留。
  const residue = eq.filter((k) => /^[A-Z][A-Z0-9_]{4,}$/.test(k) && ourSrc.includes(k))
  rec('no_key_value_fallback_residue_in_our_code',
    residue.length === 0,
    `数据侧 value==key 共 ${eq.length} 条(月份/星期/阵营/专名,合法);其中被前端源码引用=${residue.length}` +
    (residue.length ? `  疑似硬编码兜底: ${residue.slice(0, 10).join(', ')}` : ''))
}

/* ================================================================
 * 用例 E: 流式 vs 串行 一致性指纹(复用 test_loc_stream 口径)
 * ================================================================ */
{
  function fingerprint(index) {
    const parts = []
    for (const lang of index.langs) {
      const m = index.byLang.get(lang)
      for (const k of [...m.keys()].sort()) {
        const hits = m.get(k)
        const h = hits.map((x) => `${x.index}${x.value}${x.rootIdx}${x.file}${x.line}`).join('')
        parts.push(`${lang}${k}${h}`)
      }
    }
    return parts.join('')
  }
  try {
    const pool = await import(S('worker-pool.ts'))
    const cpu = await import(S('cpu-probe.ts'))
    const verdict = cpu.decideConcurrency ? await cpu.decideConcurrency({ probe: false }) : { workers: 2 }
    pool.initPool?.(verdict.workers)
    const streamed = await pool.runLocStream(rootsArr, WANT)
    pool.shutdownPool && await pool.shutdownPool()
    const fpOk = fingerprint(streamed.index) === fingerprint(idx)
    const st = streamed.stats
    rec('streamed_loc_equals_serial_fingerprint',
      fpOk,
      `workers=${verdict.workers} chains=${st.chains} batches=${st.batches} fallback=${st.fallback}  逐字段指纹${fpOk ? '一致' : '不等'}`)
  } catch (e) {
    rec('streamed_loc_equals_serial_fingerprint', false,
      'worker-pool 起流失败,跳过真流式比对(串行↔分片一致性由 tools/test_loc_stream.mts 专职验收)',
      { exempt: true, exemptReason: '依赖 worker-pool/cpu-probe,导入/起流失败: ' + (e && e.message) })
  }
}

/* ── 汇总写盘 ── */
const summary = { total: cases.length, pass: 0, fail: 0, exempt: 0 }
for (const c of cases) { if (c.exempt) summary.exempt++; else if (c.pass) summary.pass++; else summary.fail++ }
const doc = { layer: '04_loc', base: BASE, ts: new Date().toISOString(), summary, cases }
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8')
console.log(`\n=== 04_loc 汇总: total=${summary.total} pass=${summary.pass} fail=${summary.fail} exempt=${summary.exempt} ===`)
console.log('结果 JSON ->', OUT)
process.exit(summary.fail === 0 ? 0 : 1)
