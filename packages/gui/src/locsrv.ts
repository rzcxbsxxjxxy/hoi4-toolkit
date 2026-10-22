/**
 * 本地化(localisation)索引与读写 —— 多语言并列浏览 / 缺失译文检测 / 改写。
 *
 * ★ 为什么单独一个文件:
 *   server.ts 已经 2300 行,而本地化有自己的一套数据结构(按语言分桶、
 *   多行条目合并、BOM 保真)。混进去会让两边都难读。
 *
 * ★ 数据形态(vanilla 实测):
 *   - 目录是 localisation/<语言>/<若干>.yml,10 个语言各 ~207 个文件
 *   - 首行语言头 l_english: / l_simp_chinese:
 *   - 单行:KEY: "值";多行:KEY:0 "第一段" / KEY:1 "第二段"
 *     多行必须按序号拼起来给用户看,否则一条译文被切成好几行,看不出缺哪段
 *   - 文件必须 UTF-8 with BOM,改写时不能丢
 *
 * ★ 覆盖规则与工作台其它模块一致:ROOTS 顺序,后者覆盖前者。
 *   (模组改了同一个 key,生效的是模组那份。)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseLocYml } from '../../engine/src/loc.ts'
import { isUnloadedByLaterReplacePath } from '../../engine/src/assetsrc.ts'
import { type NormPath } from '../../engine/src/modmeta.ts'

export interface LocHit {
  value: string
  rootIdx: number
  /** 相对 root 的路径,如 localisation/english/xxx.yml */
  file: string
  line: number
  /** KEY:0 的序号;单行条目为 null */
  index: number | null
}

export interface LocFileStat {
  rootIdx: number
  file: string
  lang: string
  entries: number
  hasBom: boolean
  errors: number
}

export interface LocIndex {
  /** 语言列表,按条目数降序 */
  langs: string[]
  /** lang -> key -> 该语言下的所有命中(多行条目会有多个 index) */
  byLang: Map<string, Map<string, LocHit[]>>
  files: LocFileStat[]
  stats: {
    files: number
    entries: number
    /** 同一语言内被多次定义的 key 数(覆盖链里属正常,但同源重复是真问题) */
    dupKeys: number
    missingBom: string[]
    errorFiles: string[]
  }
  ms: number
  builtAt: number
}

interface ScanRoot {
  name: string
  path: string
  writable: boolean
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

/** 递归找 localisation 下的 .yml。深度限制 4,避免把整个 mod 目录走一遍。 */
export function locFiles(root: string): string[] {
  const out: string[] = []
  const base = join(root, 'localisation')
  if (!existsSync(base)) return out
  const stack: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur.depth > 4) continue
    let items: ReturnType<typeof readdirSync>
    try {
      items = readdirSync(cur.dir, { withFileTypes: true }) as any
    } catch {
      continue
    }
    for (const it of items as any[]) {
      const full = join(cur.dir, it.name)
      if (it.isDirectory()) {
        stack.push({ dir: full, depth: cur.depth + 1 })
      } else if (it.isFile() && /\.yml$/i.test(it.name)) {
        // ★ languages.yml 是【配置文本】(声明支持的语言与显示名),不是翻译文本 —— 跳过,
        //   否则会被解析成各语言下的 "l_english/l_braz_por/…" 假条目,污染翻译索引与缺失计算。
        if (it.name.toLowerCase() === 'languages.yml') continue
        out.push(full)
      }
    }
  }
  return out.sort()
}

/* ── 构建累积器:同步版 / 异步分片版 / 流式版(worker)共用,保证三条路径结果完全一致 ── */
export interface LocAcc {
  byLang: Map<string, Map<string, LocHit[]>>
  files: LocFileStat[]
  missingBom: string[]
  errorFiles: string[]
  entries: number
  dupKeys: number
}

function newAcc(): LocAcc {
  return { byLang: new Map(), files: [], missingBom: [], errorFiles: [], entries: 0, dupKeys: 0 }
}

/* ══════════════════════════════════════════════════════════════════
 * ★★ PARALLEL_V2(2026-10-17):把 ingestFile 拆成【解析】与【合并】两段
 *
 * 为什么拆(实测 vanilla+4 模组 / 3252 个 yml / 184 万条目):
 *   readFileSync  3.6s (19.1%)
 *   parseLocYml   8.5s (45.0%)   ← 两项合计 12.1s,全是「可以搬到别的线程」的纯计算
 *   合并进 Map    6.8s (35.9%)   ← 结果必须活在本线程,搬不了
 *
 * 原实现把三段写在一个函数里,所以只能整体留在主线程,靠分片让出事件循环。
 * 拆开后 read+parse 可以整段送进 worker,主线程只跑合并 ——
 * 实测主线程占用从 18.9s 降到约 6.8s,且没有任何一次超过一个批次的尖峰。
 *
 * ★ 三条路径必须共用 ingestParsed,否则指纹不等会被误读成"并行结果不一致"
 *   (这正是 job-builders 存在的同一个理由)。
 * ══════════════════════════════════════════════════════════════════ */

/** parseLocYml 的返回值(用 ReturnType 跟随上游改动,不手抄结构) */
type LocParsed = ReturnType<typeof parseLocYml>

/** 【第一段】读文件 + 解析。纯计算,可整体在 worker 里跑。读不到/解不了都返回 null。 */
export function parseLocFile(abs: string, rel: string): LocParsed | null {
  let src: string
  try {
    src = readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  try {
    return parseLocYml(src, rel)
  } catch {
    return null
  }
}

/** 【第二段】把解析结果合并进累积器。★ 三条构建路径唯一的数据入口 */
export function ingestParsed(
  acc: LocAcc,
  rootIdx: number,
  rel: string,
  r: LocParsed,
  wantLangs?: Set<string>,
): void {
  acc.files.push({
    rootIdx,
    file: rel,
    lang: r.lang ?? 'unknown',
    entries: r.entries.length,
    hasBom: r.hasBom,
    errors: r.errors.length,
  })
  if (!r.hasBom) acc.missingBom.push(rel)
  if (r.errors.length) acc.errorFiles.push(rel)
  if (!r.lang) return
  if (wantLangs && !wantLangs.has(r.lang)) return
  let m = acc.byLang.get(r.lang)
  if (!m) { m = new Map(); acc.byLang.set(r.lang, m) }
  for (const e of r.entries) {
    acc.entries++
    const arr = m.get(e.key)
    if (arr) {
      // 覆盖:同语言同 key 同 index,后者(后面的 root)生效
      const i = arr.findIndex((x) => x.index === e.index)
      const hit: LocHit = { value: e.value, rootIdx, file: rel, line: e.line, index: e.index }
      if (i >= 0) {
        if (arr[i].rootIdx !== rootIdx) acc.dupKeys++
        arr[i] = hit
      } else arr.push(hit)
    } else {
      m.set(e.key, [{ value: e.value, rootIdx, file: rel, line: e.line, index: e.index }])
    }
  }
}

/** 解析失败时也要记账(否则 errorFiles 会丢,「缺失/错误文件」清单变空) */
export function noteParseError(acc: LocAcc, rel: string): void {
  acc.errorFiles.push(rel)
}

/** 解析一个 yml 并合并进累积器。★ 唯一的数据入口,三个构建版本都走它。 */
function ingestFile(acc: LocAcc, rootIdx: number, rootPath: string, abs: string, wantLangs?: Set<string>): void {
  const rel = relative(rootPath, abs).replace(/\\/g, '/')
  const r = parseLocFile(abs, rel)
  if (!r) { noteParseError(acc, rel); return }
  ingestParsed(acc, rootIdx, rel, r, wantLangs)
}

export function finishAcc(acc: LocAcc, ms: number): LocIndex {
  const langs = [...acc.byLang.entries()]
    .map(([lang, m]) => ({ lang, n: m.size }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.lang)

  return {
    langs,
    byLang: acc.byLang,
    files: acc.files,
    stats: {
      files: acc.files.length,
      entries: acc.entries,
      dupKeys: acc.dupKeys,
      missingBom: acc.missingBom,
      errorFiles: acc.errorFiles,
    },
    ms,
    builtAt: Date.now(),
  }
}

/** 新建一个空累积器(流式构建的主线程侧用) */
export function newLocAcc(): LocAcc {
  return newAcc()
}

/** 累积器 → 完整索引(流式构建收尾用) */
export function finalizeLocAcc(acc: LocAcc, ms: number): LocIndex {
  return finishAcc(acc, ms)
}

/* ══════════════════════════════════════════════════════════════════
 * ★★ PARALLEL_V2:流式构建 —— worker 解析,主线程合并
 *
 * 现状的问题:主线程把 read+parse+merge 三段一起跑(实测 18.9s),
 * 靠分片让出事件循环,结果是「主线程连续忙 19 秒」——
 * 音乐缓冲、`/api/status` 探活全在夹缝里抢时间,表现就是「加载时卡」。
 *
 * 流式的分工:
 *   worker:读文件 + 解析(实测 12.1s / 64%)—— 纯计算,搬得走
 *   主线程:合并(实测 6.8s / 36%)—— 结果要活在本线程,搬不走,但可分片让出
 *
 * 为什么不「整体搬迁」(一次 postMessage 把整个 LocIndex 传回来):
 *   实测裸对象载荷 381MB / 595 万节点,structuredClone 的 deserialize 单趟
 *   2671ms —— 主线程会被**连续**堵 2.7 秒,比现状的分片(单片 180ms)更糟。
 *   流式的每批回传只有几十 KB,deserialize 可以忽略不计。
 *
 * ★ 批次顺序必须与同步版完全一致(roots 顺序 → locFiles 排序 → 逐个),
 *   否则「后者覆盖前者」的覆盖链结果会不同 —— 这是隐蔽错误,界面不报错但译文错。
 * ══════════════════════════════════════════════════════════════════ */

/** 一批解析任务(worker 侧算,主线程侧合并) */
export interface LocBatchJob {
  rootIdx: number
  rel: string
  abs: string
}

/** 列出全部待解析文件。★ worker 与主线程都必须用这个函数得到【同样的顺序】 */
export function planLocBatches(roots: ScanRoot[]): LocBatchJob[] {
  const jobs: LocBatchJob[] = []
  roots.forEach((root, rootIdx) => {
    for (const abs of locFiles(root.path)) {
      const rel = relative(root.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, rootIdx, rel)) continue
      jobs.push({ rootIdx, rel, abs })
    }
  })
  return jobs
}

/**
 * worker 侧:把一批文件读+解析,返回可传输的紧凑结果。
 * 【不】在这里合并 —— 合并留在主线程(见 ingestParsed)。
 */
export interface LocParsedBatch {
  /** 逐文件:解析结果或 null(读不到/解不了);顺序与入参一致 */
  items: ({ lang: string | null; hasBom: boolean; errorCount: number; entries: { key: string; value: string; line: number; index: number | null }[] } | null)[]
  rootIdx: number[]
}

/** worker 侧执行一批的 read+parse。纯计算,不碰累积器。 */
export function parseLocBatch(jobs: LocBatchJob[]): LocParsedBatch {
  const items: LocParsedBatch['items'] = []
  const rootIdx: number[] = []
  for (const j of jobs) {
    const r = parseLocFile(j.abs, j.rel)
    rootIdx.push(j.rootIdx)
    items.push(
      r
        ? {
            lang: r.lang ?? null,
            hasBom: r.hasBom,
            errorCount: r.errors.length,
            entries: r.entries.map((e) => ({ key: e.key, value: e.value, line: e.line, index: e.index })),
          }
        : null,
    )
  }
  return { items, rootIdx }
}

/**
 * 主线程侧:把一批解析结果合并进累积器。
 * ★ 与同步版 ingestParsed 逐字对应 —— 覆盖链、同 index 去重、dupKeys 统计全一致。
 */
export function mergeLocBatch(
  acc: LocAcc,
  batch: LocParsedBatch,
  rels: string[],
  wantLangs?: Set<string>,
): void {
  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i]
    const rel = rels[i]!
    const rootIdx = batch.rootIdx[i]!
    if (!item) { noteParseError(acc, rel); continue }
    /* 造一个与 parseLocYml 同形的对象好让 ingestParsed 复用 ——
     * 宁可多一层薄封装,也不要复制一份合并逻辑(两份合并必然漂移)。
     *
     * ★★ errors 的长度必须【严格】等于 item.errorCount,绝不能写 Math.max(1, n)。
     *   ingestParsed 判的是 `r.errors.length`(truthy 判断),所以 max(1,0) 会在
     *   「解析成功但有 0 个错」的文件上凭空造出长度 1 的数组 → 每个文件都被
     *   记进 errorFiles。实测症状极具迷惑性:entries / missingBom / dupKeys
     *   全部一致(它们不走这个分支),只有 errorFiles 与逐字段指纹不等。 */
    ingestParsed(acc, rootIdx, rel, {
      lang: item.lang ?? undefined,
      hasBom: item.hasBom,
      errors: new Array<unknown>(item.errorCount).fill(null),
      entries: item.entries,
    } as unknown as LocParsed, wantLangs)
  }
}

/**
 * 同步全量构建。
 *
 * ★ opts.wantLangs(2026-10-17 PARALLEL_V2 新增):与异步版同参。
 *   搬进 worker 后线程里没有 HTTP 要让,分片纯属浪费 —— 同一份代码用
 *   同步路径即可(结果与分片版【完全一致】:两者共用 ingestFile/finishAcc)。
 *   主线程仍走 buildLocIndexAsync(那里必须分片让出事件循环)。
 */
export function buildLocIndex(roots: ScanRoot[], opts?: { wantLangs?: Set<string> }): LocIndex {
  const t0 = Date.now()
  const acc = newAcc()
  roots.forEach((root, rootIdx) => {
    for (const abs of locFiles(root.path)) {
      const rel = relative(root.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, rootIdx, rel)) continue
      ingestFile(acc, rootIdx, root.path, abs, opts?.wantLangs)
    }
  })
  return finishAcc(acc, Date.now() - t0)
}

/**
 * ★ PERF_V3(2026-10-05):分片协作式构建 —— worker 不可用时的兜底。
 *
 * 原来这是唯一的分片路径(read+parse+merge 都在主线程,每 60 文件让出一次)。
 * PARALLEL_V2 之后主线程优先走 buildLocIndexStream(解析在 worker),
 * 只有 worker 起不来/超时/出错才回落到这里 —— 那时"至少不把主线程堵死"
 * 仍然重要,所以这条路径原样保留,只是改用拆分后的同一对函数
 * (parseLocFile + ingestParsed),保证与流式路径结果【逐字一致】。
 *
 * 每块默认 60 个文件(实测单块 ≈150~200ms)。CPU 时间单独累计,墙钟不混进来。
 */
export async function buildLocIndexAsync(
  roots: ScanRoot[],
  opts?: { chunk?: number; wantLangs?: Set<string> },
): Promise<LocIndex> {
  const t0 = Date.now()
  const acc = newAcc()
  const jobs = planLocBatches(roots)
  const chunk = Math.max(1, opts?.chunk ?? 60)
  let cpuMs = 0
  for (let k = 0; k < jobs.length; k += chunk) {
    const c0 = Date.now()
    const end = Math.min(k + chunk, jobs.length)
    const slice = jobs.slice(k, end)
    const rels = slice.map((j) => j.rel)
    mergeLocBatch(acc, parseLocBatch(slice), rels, opts?.wantLangs)
    cpuMs += Date.now() - c0
    // 让出主线程:让排队的 HTTP 请求有机会被处理掉
    await new Promise<void>((done) => setImmediate(done))
  }
  return finishAcc(acc, cpuMs)
}

/** 把多行条目按 index 拼成一个展示值 */
export function joinHits(hits: LocHit[]): string {
  if (hits.length === 1) return hits[0].value
  const parts = [...hits].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return parts.map((h) => h.value).join('\n')
}

/* ────────────────────────────────────────────────────────────────
 * key → 文本(给 focus / tech / mio / doctrines 等页面做「显示名」)
 *
 * ★ 用户定的口径(2026-10):默认英文,基础游戏可以中文。
 *   模组的 localisation 常只写一种语言,英文是唯一能覆盖全部 key 的,
 *   所以默认 english;只有 key 在英文里缺失时才回落到别的语言。
 *
 * ★ 覆盖链:与全站一致 —— ROOTS 顺序,后者(模组)覆盖前者(基础游戏)。
 *   byLang 里已经按这个规则合并过了,直接取即可。
 *
 * ★ 键名后缀差异:同一个概念在英文/中文目录里 key 完全一样(HoI4 的
 *   localisation key 不带语言后缀),但 **文件名** 带(_l_english / _l_simp_chinese)。
 *   这里只按 key 查,不碰文件名,所以无需做后缀推导。
 * ──────────────────────────────────────────────────────────────── */

/**
 * 语言优先级:英文第一;调用方指定的语言排最前。
 *
 * ★ 实测坑:索引里的语言名**带 l_ 前头**(l_english / l_simp_chinese),
 *   因为那就是 yml 首行的语言头。写 'english' 一定匹配不上 —— 踩过。
 *   这里同时认 'english' 与 'l_english' 两种写法,免得调用方踩坑。
 */
function langChain(idx: LocIndex, prefer?: string): Map<string, Map<string, LocHit[]>> {
  const norm = (s: string) => (s.startsWith('l_') ? s : 'l_' + s)
  /** 候选语言按优先级排序 */
  const order: string[] = []
  const push = (l: string | undefined) => {
    if (!l) return
    const k = norm(l)
    if (idx.byLang.has(k) && !order.includes(k)) order.push(k)
  }
  push(prefer)
  push('english')
  for (const l of idx.langs) push(l)
  const chain = new Map<string, Map<string, LocHit[]>>()
  for (const l of order) chain.set(l, idx.byLang.get(l)!)
  return chain
}

export interface LocTextHit {
  text: string
  lang: string
  file: string
  line: number
  rootIdx: number
}

/**
 * 批量查 key 的显示文本。
 *
 * 返回的 Map 一定包含【每个请求的 key】——查不到的值是 `null`,
 * 让调用方能区分"没这个 key"(要显示 id 兜底)而不是"忘了传"。
 */
export function lookupKeys(
  idx: LocIndex,
  keys: string[],
  prefer?: string,
): Map<string, LocTextHit | null> {
  const chain = langChain(idx, prefer)
  const out = new Map<string, LocTextHit | null>()
  for (const key of keys) {
    let found: LocTextHit | null = null
    for (const [lang, m] of chain) {
      const hits = m.get(key)
      if (!hits || !hits.length) continue
      const top = [...hits].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
      found = { text: joinHits(hits), lang, file: top.file, line: top.line, rootIdx: top.rootIdx }
      break
    }
    out.set(key, found)
  }
  return out
}

/** 语言显示名(前端下拉用)。索引里的键带 l_ 前头,这里统一去掉 */
export function langLabel(lang: string): string {
  const id = lang.replace(/^l_/, '')
  const map: Record<string, string> = {
    english: '英文',
    simp_chinese: '简体中文',
    german: '德文',
    french: '法文',
    spanish: '西班牙文',
    polish: '波兰文',
    russian: '俄文',
    japanese: '日文',
    korean: '韩文',
    braz_por: '巴西葡文',
  }
  return map[id] ?? id
}

/* ────────────────────────────────────────────────────────────────
 * 改写
 *
 * ★ 不能直接"读文件→正则替换→写回":
 *   1) BOM 必须保住,否则游戏读不到这个语言;
 *   2) 行尾可能是 CRLF,统一成 LF 会让整个文件的 diff 变成几千行;
 *   3) 值里可能有 #(引号外才是注释),按行号定位才安全。
 * 所以按【行号 + key 复核】定点替换,只动那一行。
 * ──────────────────────────────────────────────────────────────── */
export function saveLocValue(
  rootPath: string,
  rel: string,
  line: number,
  key: string,
  index: number | null,
  value: string,
): { ok: boolean; error?: string; before?: string; after?: string } {
  const abs = join(rootPath, rel)
  if (!existsSync(abs)) return { ok: false, error: '文件不存在: ' + rel }
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (e) {
    return { ok: false, error: '读取失败: ' + String(e) }
  }
  const hasBom = raw.charCodeAt(0) === 0xfeff
  const body = hasBom ? raw.slice(1) : raw
  const crlf = body.indexOf('\r\n') >= 0
  const lines = body.split(/\r?\n/)
  const i = line - 1
  if (i < 0 || i >= lines.length) return { ok: false, error: '行号越界: ' + line }

  const old = lines[i]
  // 复核这一行确实是我们要改的条目(行号可能因外部编辑漂移)
  const keyRe = new RegExp('^[ \\t]*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s*:\\s*' + (index ?? '\\d+') + ')?\\s')
  if (!keyRe.test(old)) return { ok: false, error: '第 ' + line + ' 行已不是 ' + key + ',请刷新后重试' }

  const esc = '"' + value.replace(/"/g, '""') + '"'
  // 保留行首缩进与 KEY 部分,只替换引号里的值
  const m = old.match(/^([ \t]*)([^\s:]+(?:\s*:\s*\d+)?\s*)(.*)$/)
  if (!m) return { ok: false, error: '无法解析该行' }
  const next = m[1] + m[2] + esc
  if (next === old) return { ok: false, error: '内容没有变化' }

  lines[i] = next
  const out = (hasBom ? '\uFEFF' : '') + lines.join(crlf ? '\r\n' : '\n')
  try {
    writeFileSync(abs, out, 'utf8')
  } catch (e) {
    return { ok: false, error: '写入失败: ' + String(e) }
  }
  return { ok: true, before: old.trim(), after: next.trim() }
}

/** 追加一条新 key(写进指定语言的某个文件末尾) */
export function appendLocEntry(
  rootPath: string,
  rel: string,
  key: string,
  value: string,
): { ok: boolean; error?: string; line?: number } {
  const abs = join(rootPath, rel)
  if (!existsSync(abs)) return { ok: false, error: '文件不存在: ' + rel }
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  const hasBom = raw.charCodeAt(0) === 0xfeff
  const body = hasBom ? raw.slice(1) : raw
  const crlf = body.indexOf('\r\n') >= 0
  const nl = crlf ? '\r\n' : '\n'
  const esc = '"' + value.replace(/"/g, '""') + '"'
  const add = nl + ' ' + key + ': ' + esc + nl
  const out = (hasBom ? '\uFEFF' : '') + body.replace(/\s*$/, '') + add
  try {
    writeFileSync(abs, out, 'utf8')
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  const line = (hasBom ? body.replace(/\s*$/, '') : body).split(/\r?\n/).length + 1
  return { ok: true, line }
}
/* ────────────────────────────────────────────────────────────────
 * ★ 双语配对(lookupPair / LocPairHit):一次取出某个 key 的
 *   【英文 + 简体中文】,各带来源(文件 / 行号 / root),并列出缺失的语言。
 *
 * 与 lookupKeys 的区别:
 *   lookupKeys 走「语言链」(指定语言→英文→其余,缺了回退) —— 适合显示名,
 *   一次只给一个语言。
 *   lookupPair 严格按语言取(英文只读 l_english、中文只读 l_simp_chinese),
 *   不回退 —— 适合「本地化管理」与「英中对照」:能真实看出某 key
 *   在英文/中文里是否存在、来自哪个文件、是否缺译文。
 *
 * 供:本地化管理入口、其他功能(把 id 换成英中对照)统一接入。
 * ──────────────────────────────────────────────────────────────── */
function singleLookup(idx: LocIndex, key: string, lang: string): LocTextHit | null {
  const m = idx.byLang.get(lang)
  const hits = m?.get(key)
  if (!hits || !hits.length) return null
  const top = [...hits].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
  return { text: joinHits(hits), lang, file: top.file, line: top.line, rootIdx: top.rootIdx }
}

export interface LocPairHit {
  key: string
  en: LocTextHit | null
  zh: LocTextHit | null
  /** 该 key 缺失的语言(l_english / l_simp_chinese) */
  missing: string[]
}

export function lookupPair(idx: LocIndex, keys: string[]): Map<string, LocPairHit> {
  const out = new Map<string, LocPairHit>()
  for (const key of keys) {
    const en = singleLookup(idx, key, "l_english")
    const zh = singleLookup(idx, key, "l_simp_chinese")
    const missing: string[] = []
    if (!en) missing.push("l_english")
    if (!zh) missing.push("l_simp_chinese")
    out.set(key, { key, en, zh, missing })
  }
  return out
}
