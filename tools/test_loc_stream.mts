/**
 * test_loc_stream.cjs —— 验收 loc 流式构建与串行构建【结果完全一致】
 *
 * ★ 为什么必须逐字段比对而不只是看「有没有报错」:
 *   流式把「一条链 = 连续一段批次」,若切分错了(比如交错发批),
 *   覆盖链(同 key 后者覆盖前者)就会算错 —— 界面不报错、HTTP 全 200,
 *   只是译文内容错了。这类错误只有比对指纹才能发现。
 *
 * 判据:byLang 每个 key 的每条 hit(value/rootIdx/file/line/index)全等,
 *      langs 顺序、stats 四项计数全等。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const S = (p) => pathToFileURL(join(ROOT, 'packages', 'gui', 'src', p)).href

const { buildLocIndex, buildLocIndexAsync, locFiles } = await import(S('locsrv.ts'))
const { runLocStream } = await import(S('worker-pool.ts'))
const { decideConcurrency } = await import(S('cpu-probe.ts'))

function roots() {
  const s = JSON.parse(readFileSync(resolve(ROOT, 'gui-settings.json'), 'utf8'))
  const out = []
  if (s.base) out.push({ name: 'vanilla', path: s.base, writable: false })
  for (const m of s.mods ?? []) if (m.enabled) out.push({ name: m.path.split(/[\\/]/).pop(), path: m.path, writable: true })
  return out
}
const rs = roots()
const LANGS = new Set(['l_english', 'l_simp_chinese'])

/** 指纹:把 LocIndex 拍成可比对的字符串(顺带暴露顺序与覆盖链) */
function fingerprint(idx) {
  const parts = []
  for (const lang of idx.langs) {
    const m = idx.byLang.get(lang)
    const keys = [...m.keys()].sort()
    for (const k of keys) {
      const hits = m.get(k)
      // hit 的顺序有意义(多行条目按 index 排),不能排序掉
      const h = hits.map((x) => `${x.index}${x.value}${x.rootIdx}${x.file}${x.line}`).join('')
      parts.push(`${lang}${k}${h}`)
    }
  }
  return parts.join('')
}

let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fail++
}

// ── 基线:主线程同步全量
console.log('建基线(主线程同步全量)…')
const t0 = Date.now()
const base = buildLocIndex(rs, { wantLangs: LANGS })
console.log(`  ${Date.now() - t0} ms  语言 ${base.langs.join(',')}  key ${[...base.byLang.values()].reduce((s, m) => s + m.size, 0)}  条目 ${base.stats.entries}\n`)
const baseFp = fingerprint(base)

check('基线非空', base.stats.entries > 0)
check('基线语言集 = english + 简中', base.langs.length === 2 && base.langs.includes('l_english') && base.langs.includes('l_simp_chinese'))

// ── 分片异步版(降级路径)也要一致
console.log('\n比对降级路径 buildLocIndexAsync…')
const async_ = await buildLocIndexAsync(rs, { wantLangs: LANGS })
check('异步分片 == 同步基线', fingerprint(async_) === baseFp)
check('异步分片 stats 一致', JSON.stringify(async_.stats.missingBom) === JSON.stringify(base.stats.missingBom) && async_.stats.entries === base.stats.entries && async_.stats.errorFiles.length === base.stats.errorFiles.length)

// ── 流式(多链并行)
console.log('\n起 worker 池…')
const verdict = await decideConcurrency({ probe: false })
const { initPool } = await import(S('worker-pool.ts'))
initPool(verdict.workers)
console.log(`  ${verdict.workers} workers  (${verdict.reason})\n`)

console.log('跑流式 loc 构建…')
const t1 = Date.now()
const streamed = await runLocStream(rs, LANGS)
const wall = Date.now() - t1
const st = streamed.stats
console.log(`  ${wall} ms  chains=${st.chains} batches=${st.batches} merge=${st.mergeMs}ms fallback=${st.fallback}\n`)

check('流式未走降级', !st.fallback, st.fallback ? '(worker 链失败)' : '')
check('流式 == 同步基线(逐字段)', fingerprint(streamed.index) === baseFp)
check('流式 stats.entries 一致', streamed.index.stats.entries === base.stats.entries, `${streamed.index.stats.entries} vs ${base.stats.entries}`)
check('流式 missingBom 一致', JSON.stringify(streamed.index.stats.missingBom) === JSON.stringify(base.stats.missingBom))
check('流式 errorFiles 一致', JSON.stringify(streamed.index.stats.errorFiles) === JSON.stringify(base.stats.errorFiles))
check('流式 dupKeys 一致', streamed.index.stats.dupKeys === base.stats.dupKeys, `${streamed.index.stats.dupKeys} vs ${base.stats.dupKeys}`)
check('流式 files 清单长度一致', streamed.index.files.length === base.files.length)
check('流式 langs 顺序一致', JSON.stringify(streamed.index.langs) === JSON.stringify(base.langs))

// ── 墙钟收益
console.log(`\n墙钟:主线程 ${Date.now() - t0}ms → 流式 ${wall}ms(主线程合并仅 ${st.mergeMs}ms)`)
check('流式墙钟 < 基线', wall < (Date.now() - t0))

const { shutdownPool } = await import(S('worker-pool.ts'))
await shutdownPool()
console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
process.exit(fail === 0 ? 0 : 1)