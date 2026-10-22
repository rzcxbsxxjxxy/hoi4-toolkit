/**
 * TRACKER_V2 —— 更新跟踪引擎：基线快照 + 增量对比 + 持久化。
 *
 * ══ 它做什么 ══
 *   给「基础游戏(vanilla+DLC) + 已挂载模组」这套来源集合建一份清单（基线），
 *   之后每次"检查更新"重新扫一遍，对比出四类变更：
 *     new       —— 快照有、基线没有
 *     deleted   —— 基线有、快照没有
 *     modified  —— 都有但 sha256 不同（文本文件附行级 diff，二进制只填 meta）
 *     moved     —— deleted 与 new 按 sha256 配对（同哈希视为移动）
 *
 * ══ 关键设计取舍 ══
 *  ① 归属判定一律走 resolveAssets（assetsrc.ts），不自己写 root===0 之类判据。
 *     这样"某模组文件覆盖了原版某文件"、replace_path 制造的 gap 都和全站口径一致。
 *     resolveAssets 对 gap 文件 effective=-1；本模块把 gap 文件也纳入清单（磁盘上确实
 *     存在，只是游戏里被 replace_path 删掉了），root 取 chain 里最高优先级的磁盘来源。
 *
 *  ② 增量哈希是性能核心：scanSnapshot 收 prev（上次 byRel Map）后，每个文件先 stat，
 *     size+mtime 与 prev 完全一致 → 直接复用 prev.sha256，不重读文件（skippedRehash++）。
 *     否则按 64KB 分块流式重哈希。这样"检查更新"不会每次重读几十 GB 的 vanilla。
 *
 *  ③ 文本 diff 的旧内容从哪来：内容寻址 pack。文本文件扫描时把全文 gzip 顺序追加到
 *     <tracker>/baseline/<key>/content.pack（单文件大包），并用 content.idx 记录
 *     sha256 → [offset, length]。基线 JSON 只存清单（不塞内容）。重启后 diff 仍能从
 *     pack 按偏移切片恢复旧内容；基线滚动后旧内容保留在 pack，历史 diff 不受影响。
 *     ★ V2 改为惰性恢复：扫描/对比阶段不再为每个文件 eager 读包，只在 compare 出
 *     modified 文本文件时按需读旧/新内容，避免每次"检查更新"全量解压几千个 blob。
 *     ★ 2026-10-13 改为「按来源的大文件 pack」取代旧版每内容一文件的 blobs/：无论来源
 *     有多少文本文件，磁盘上最多 2 个内容文件（一个大 pack + 一个小索引），消除零碎小文件
 *     对簇/硬盘的浪费。
 *
 *  ④ 文本/二进制判定：扩展名白名单直接定；未知扩展名读前 8KB 查 NUL 兜底。
 *     二进制不参与行级 diff，变更只填 meta。
 *
 *  ⑤ 移动配对确定性：deleted/new 各按 rel 排序，按 sha256 分组后一一配对，
 *     同输入同输出（可复现、可测试）。
 *
 *  ⑥ 存储布局（项目根/tracker）：
 *       baseline/<key>/baseline.json —— 当前基线清单（无 content，可重启恢复）
 *       baseline/<key>/content.pack  —— 文本内容 gzip 拼接的大文件（内容寻址，按来源一份）
 *       baseline/<key>/content.idx   —— 索引 sha256 → [offset, length]
 *       history/<key>/<ts>.json       —— 每次"检查更新"一条记录（含四态变更与行级 diff）
 *     每条来源（基础游戏/各模组）一套独立基线+历史+内容包，key 由 root.path 稳定派生。
 *
 *  ══ V2 性能修复（2026-10-11）══
 *   - 磁盘枚举/哈希/写 blob 全部异步化：walkRoot 用 fs.promises.readdir + 分块并行 stat，
 *     哈希用 createReadStream 流式喂 createHash，gzip 走 zlib 线程池，定期让出事件循环
 *     （walk 每 256 文件、hash 每 64 文件、blob 每批 64），"建立基线/检查更新"不再
 *     长时间独占事件循环 → 其它 API 不再超时、SSE 进度能实时推送。
 *   - 写 blob 批量限流：scan 内收集 (sha, content)，每 512 条或结束时异步批量写
 *     （每批 64 并发，'wx' 幂等跳过已存在），不再逐文件同步 gzip+write。
 *   - 滚动基线后自动 GC：仅当某来源 content.pack 的死 blob 较多时才紧凑重写（保持检查快速），
 *     同时清理旧版全局 blobs/ 目录（已被 pack 取代），返回 {removed, remaining, skipped}。
 *   - 兼容旧基线格式：旧 JSON 顶层存单数 root，新格式存 roots 数组；读取时自动归一。
 */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { normRelPath, type NormPath } from './modmeta.ts'
import { resolveAssets, type SrcRoot } from './assetsrc.ts'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

// ── 历史记录内嵌 diff 的体积护栏 ─────────────────────────────
// 单条变更 diff 最大行数(diffLines 超限时保留头尾+省略标注行)。
const MAX_EMBED_DIFF_ROWS = 4000
// 单条历史 JSON 里全部内嵌 diff 的总字节预算(粗估:行文本长度+每行 40B 开销)。
// 超预算时从最大的 diff 开始丢弃 —— diff 丢弃后展示仍可用:/api/tracker/diff
// 会按 shas 从 content.pack 重算,内嵌 diff 只是零往返快路径 + blob 被 GC 后的兜底。
const MAX_EMBED_DIFF_BYTES = 12 * 1024 * 1024

/** 按「总字节预算」裁剪一条历史记录的内嵌 diff:从最大的开始丢,直到预算内。 */
function trimEmbeddedDiffs(changes: TrackChange[], budget = MAX_EMBED_DIFF_BYTES): void {
  const costs: { i: number; n: number }[] = []
  let total = 0
  changes.forEach((c, i) => {
    if (!c.diff) return
    let n = 0
    for (const d of c.diff) n += (d.text ? d.text.length : 0) + 40
    costs.push({ i, n })
    total += n
  })
  if (total <= budget) return
  costs.sort((a, b) => b.n - a.n)
  for (const { i, n } of costs) {
    if (total <= budget) break
    changes[i].diff = undefined
    total -= n
  }
}

// ── 对外接口（server.ts import 别名依赖以下导出名）────────────────
export interface TrackRoot {
  name: string
  path: string
  writable: boolean
  replacePaths?: readonly string[]
}

export interface TrackEntry {
  rel: string // 规范化相对路径（小写/正斜杠/无首尾斜杠）
  size: number
  mtime: number
  sha256: string
  root: number // 最终生效来源的 root 下标
  own: 'vanilla' | 'override' | 'new' | 'gap'
  chain: number[] // 提供该文件的所有 root（载入序）
  shadowed: number[]
  text: boolean // true=文本类（可做行级 diff），false=二进制（仅元数据）
}

export interface TrackBaseline {
  version: 1
  createdAt: string
  roots: TrackRoot[]
  files: TrackEntry[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface TrackChange {
  kind: 'new' | 'modified' | 'deleted' | 'moved'
  rel: string
  prevRel?: string // moved 时 prevRel=旧路径
  root: number
  text: boolean
  own: 'vanilla' | 'override' | 'new' | 'gap'
  meta?: {
    oldSize?: number
    newSize?: number
    oldMtime?: number
    newMtime?: number
    oldSha?: string
    newSha?: string
  }
  diff?: DiffLine[] // 仅 modified 且 text 文件
}

export interface TrackReport {
  version: 1
  checkedAt: string
  baselineAt: string
  roots: TrackRoot[]
  changes: TrackChange[]
  stats: {
    total: number
    byRoot: Record<string, number>
    byKind: Record<'new' | 'modified' | 'deleted' | 'moved', number>
  }
}

/** 历史记录条目（每次"检查更新"一条，持久化到 history/<ts>.json） */
export interface TrackHistoryEntry {
  version: 1
  checkedAt: string
  baselineAt: string
  roots: TrackRoot[]
  stats: TrackReport['stats']
  changes: TrackChange[]
}

// ── 进度回调（供 SSE 实时上报「建基线 / 检查更新」的进度）──────────
export type TrackPhase = 'walk' | 'hash' | 'compare' | 'finalize'
export interface TrackProgress {
  phase: TrackPhase
  current: number
  total: number // -1 表示未知（前端显示不确定进度条）
  stage: string // 当前细节：正在枚举的来源名 / 正在校验的文件 rel
}
export type ProgressFn = (p: TrackProgress) => void

// 运行期内部扩展：文本文件缓存全文供 diff 用（不导出、不进 JSON）
type TrackEntryX = TrackEntry & { content?: string }

// ── 扩展名白名单 ─────────────────────────────────────────────────
const TEXT_EXTS = new Set([
  '.txt', '.csv', '.lua', '.gui', '.gfx', '.asset', '.shader', '.hlsl', '.fx',
  '.xml', '.json', '.yml', '.yaml', '.md', '.cfg', '.ini', '.toml', '.defines',
  '.localisation', '.loc', '.mod', '.script', '.eu4script', '.name', '.mtl', '.fxt',
  '.readme', '.gitignore', '.css', '.js', '.ts', '.html', '.bat', '.cmd', '.ps1',
  '.sh', '.py', '.c', '.h', '.cpp', '.hpp',
])
const BINARY_EXTS = new Set([
  '.bmp', '.dds', '.png', '.jpg', '.jpeg', '.tga', '.tiff', '.gif', '.ico', '.cur',
  '.wav', '.ogg', '.mp3', '.flac', '.m4a', '.wmv', '.mp4', '.avi', '.mov',
  '.mesh', '.anim', '.fbx', '.obj', '.dae', '.scenario', '.zip', '.rar', '.7z',
  '.dat', '.bin', '.exe', '.dll', '.pdb', '.otf', '.ttf', '.woff', '.woff2',
  '.pyc', '.so', '.dylib',
])

function extOf(rel: string): string {
  const i = rel.lastIndexOf('.')
  return i < 0 ? '' : rel.slice(i).toLowerCase()
}

/** 扩展名三态：text=已知文本 / binary=已知二进制 / unknown=需 NUL 探测 */
function classifyExt(rel: string): 'text' | 'binary' | 'unknown' {
  const e = extOf(rel)
  if (TEXT_EXTS.has(e)) return 'text'
  if (BINARY_EXTS.has(e)) return 'binary'
  return 'unknown'
}

/**
 * 文本/二进制判定（按扩展名）。
 * 已知文本/未知 → true（未知再由 scanSnapshot 读前 8KB 查 NUL 兜底）；
 * 已知二进制 → false。
 */
export function isTextRel(rel: string): boolean {
  return classifyExt(rel) !== 'binary'
}

// ── 按来源(root)独立的内容打包存储（取代旧版成千上万个零碎 blob 小文件）──
// 每个来源在 <tracker>/baseline/<key>/ 下放：
//   content.pack —— 二进制大文件：多条 [4字节小端长度][gzip(原文)] 记录顺序拼接（内容寻址、追加写）
//   content.idx  —— JSON 索引：sha256 → [offset, length]，读取时按偏移切片解压
// 这样无论来源有多少个文本文件，磁盘上最多 2 个内容文件（一个大 pack + 一个小索引），
// 彻底消除「零碎小文件过多占用大量簇/硬盘」的问题；同一 sha 只存一次（内容寻址去重）。
// 旧版 tracker/blobs/<sha256>（每内容一文件）已弃用，gc / 建基线时会清理该目录。
function trackerSubDir(root: string): string {
  return join(root, 'tracker')
}

interface ContentStore {
  bdir: string
  pack: string
  idxPath: string
  index: Map<string, [number, number]> // sha256 → [offset, compressedLength]
  fd: import('node:fs/promises').FileHandle | null
  size: number
}

function packPaths(bdir: string): { pack: string; idx: string } {
  return { pack: join(bdir, 'content.pack'), idx: join(bdir, 'content.idx') }
}

/** 打开某来源的 pack 存储；fresh=true 时删除旧 pack/idx（建基线用） */
async function openStore(bdir: string, fresh: boolean): Promise<ContentStore> {
  const { pack, idx } = packPaths(bdir)
  await fs.mkdir(bdir, { recursive: true })
  if (fresh) {
    await fs.rm(pack, { force: true }).catch(() => {})
    await fs.rm(idx, { force: true }).catch(() => {})
  }
  const store: ContentStore = { bdir, pack, idxPath: idx, index: new Map(), fd: null, size: 0 }
  try {
    const o = JSON.parse(await fs.readFile(idx, 'utf8')) as { index?: Record<string, [number, number]> }
    if (o.index) for (const [k, v] of Object.entries(o.index)) store.index.set(k, v)
  } catch {
    /* 无索引则空 */
  }
  return store
}

/** 取得/创建 pack 文件句柄（'r+'，不存在先建空文件），并维护当前 size */
async function storeFd(store: ContentStore): Promise<import('node:fs/promises').FileHandle> {
  if (!store.fd) {
    if (!existsSync(store.pack)) await fs.writeFile(store.pack, Buffer.alloc(0)).catch(() => {})
    store.fd = await fs.open(store.pack, 'r+')
    store.size = (await store.fd.stat()).size
  }
  return store.fd
}

/** 按需读旧内容：按索引切片解压（仅 diff 时调用，不做全量恢复） */
async function storeRead(store: ContentStore, sha: string): Promise<string | undefined> {
  const loc = store.index.get(sha)
  if (!loc) return undefined
  const [off, len] = loc
  const fh = await storeFd(store)
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, off)
  try { return (await gunzipAsync(buf)).toString('utf8') } catch { return undefined }
}

// 串行的写链：gzip 是异步的，offset 在 await 之后才能确定，必须用链避免并发写同一偏移导致损坏。
let _writeChain: Promise<void> = Promise.resolve()
function storeWrite(store: ContentStore, sha: string, content: string): Promise<void> {
  if (store.index.has(sha)) return Promise.resolve()
  const run = _writeChain.then(async () => {
    const comp = await gzipAsync(Buffer.from(content, 'utf8'))
    const fh = await storeFd(store)
    const off = store.size
    await fh.write(comp, 0, comp.length, off)
    store.size += comp.length
    store.index.set(sha, [off, comp.length])
  })
  _writeChain = run.catch(() => {})
  return run
}

/** 关闭句柄（操作结束后调用，释放文件句柄） */
async function storeClose(store: ContentStore): Promise<void> {
  if (store.fd) {
    try { await store.fd.close() } catch { /* 已关 */ }
    store.fd = null
  }
}

/** 持久化索引（追加写后必须调用，否则下次读取找不到偏移） */
async function storeSaveIdx(store: ContentStore): Promise<void> {
  const o: Record<string, [number, number]> = {}
  for (const [k, v] of store.index) o[k] = v
  await fs.writeFile(store.idxPath, JSON.stringify({ version: 1, index: o }))
}

/** 按来源 key 读取某 sha 内容（供 getDiff 等无 store 上下文的调用；每次独立开包） */
async function readContent(trackerDir: string, key: string, sha?: string): Promise<string | undefined> {
  if (!sha) return undefined
  const store = await openStore(baselineDir(trackerDir, key), false)
  try { return await storeRead(store, sha) } finally { await storeClose(store) }
}

/** 紧凑某来源的 pack：只保留 live 集合的 sha，重写 pack + idx，回收改动/删除产生的死 blob */
async function compactStore(store: ContentStore, live: Set<string>): Promise<{ removed: number }> {
  const liveEntries = [...store.index.entries()].filter(([sha]) => live.has(sha))
  const removed = store.index.size - liveEntries.length
  if (!liveEntries.length) {
    await fs.rm(store.pack, { force: true }).catch(() => {})
    await fs.rm(store.idxPath, { force: true }).catch(() => {})
    store.index = new Map()
    store.size = 0
    return { removed }
  }
  const tmp = store.pack + '.tmp'
  const fh = await storeFd(store)
  const wfh = await fs.open(tmp, 'w')
  let off = 0
  for (const [sha, [o, len]] of liveEntries) {
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, o)
    let content: Buffer
    try { content = await gunzipAsync(buf) } catch { continue }
    const comp = await gzipAsync(content)
    await wfh.write(comp, 0, comp.length, off)
    store.index.set(sha, [off, comp.length])
    off += comp.length
  }
  await wfh.close()
  await storeClose(store)
  await fs.rm(store.pack, { force: true }).catch(() => {})
  await fs.rename(tmp, store.pack)
  store.size = off
  await storeSaveIdx(store)
  return { removed }
}

// ── 按来源(root)独立跟踪的存储布局 ───────────────────────────────
// 每条来源（基础游戏 / 各模组）一套独立基线+历史+内容包，互不影响：
//   <tracker>/baseline/<key>/baseline.json   该来源自己的基线
//   <tracker>/baseline/<key>/content.pack    该来源文本内容的打包大文件（内容寻址）
//   <tracker>/baseline/<key>/content.idx     内容索引 sha256 → [offset, length]
//   <tracker>/history/<key>/<ts>.json        该来源每次"检查更新"的记录
//   <tracker>/history/<key>/index.json       历史列表轻量索引（供"打开更新列表"秒开）
// key 由 root.path 稳定派生（sha256 前 16 位），与载入顺序无关。

/** 稳定且文件系统/URL 安全的来源 key：对 root.path 取 sha256 前 16 位。 */
export function rootKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

function baselineDir(root: string, key: string): string {
  return join(trackerSubDir(root), 'baseline', key)
}
function historyDir(root: string, key: string): string {
  return join(trackerSubDir(root), 'history', key)
}

/** 基线归一化：新格式顶层 roots 数组；兼容旧格式顶层单数 root。 */
function baselineRoots(base: TrackBaseline): TrackRoot[] {
  if (Array.isArray(base.roots) && base.roots.length) return base.roots
  const old = base as unknown as { root?: TrackRoot }
  return old.root ? [old.root] : []
}

// ── 磁盘枚举与哈希 ────────────────────────────────────────────────

/**
 * 异步递归枚举 root 下的文件：规范化rel → {size, mtime}。
 * fs.promises.readdir(withFileTypes) 判断类型，目录内文件分块（64/批）并行 stat，
 * 每累计 256 个文件让出一次事件循环，避免长扫描独占主线程。目录读不到 → 空，不抛。
 */
async function walkRoot(root: TrackRoot, out: Map<string, { size: number; mtime: number }>, yieldNow: () => Promise<void>): Promise<void> {
  const stack: Array<{ dir: string; pre: string }> = [{ dir: root.path, pre: '' }]
  let visited = 0
  while (stack.length) {
    const { dir, pre } = stack.pop()!
    let ents: import('node:fs').Dirent[]
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const subdirs: Array<{ dir: string; pre: string }> = []
    const files: Array<{ abs: string; rel: string }> = []
    for (const e of ents) {
      const rel = pre ? pre + '/' + e.name : e.name
      if (e.isDirectory()) subdirs.push({ dir: join(dir, e.name), pre: rel })
      else if (e.isFile()) files.push({ abs: join(dir, e.name), rel })
    }
    for (let i = 0; i < files.length; i += 64) {
      const chunk = files.slice(i, i + 64)
      const stats = await Promise.all(chunk.map((f) => fs.stat(f.abs).catch(() => null)))
      for (let j = 0; j < chunk.length; j++) {
        const st = stats[j]
        if (!st) continue
        const n = normRelPath(chunk[j].rel)
        if (n) out.set(n, { size: st.size, mtime: st.mtimeMs })
      }
      visited += chunk.length
      if ((visited & 255) === 0) await yieldNow()
    }
    // DFS：dirs 反序压栈，保持与 readdir 相同的先序
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i])
  }
}

/**
 * 异步流式哈希：createReadStream 以 64KB 分块喂 createHash，不整文件读入内存。
 * 文本文件顺带缓存全文（供行级 diff）；未知扩展名读前 8KB 查 NUL。
 * 读失败 → 返回 sha=''（调用方跳过该文件），不抛。
 */
async function hashFile(abs: string, rel: string, yieldNow: () => Promise<void>): Promise<{ sha: string; text: boolean; content?: string }> {
  const kind = classifyExt(rel)
  const hash = createHash('sha256')
  const accumulate = kind !== 'binary'
  const chunks: Buffer[] = []
  let peek = Buffer.alloc(0)
  let detectedNul = false
  try {
    const stream = createReadStream(abs, { highWaterMark: 64 * 1024 })
    let n = 0
    for await (const raw of stream) {
      const slice = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      hash.update(slice)
      if (accumulate) chunks.push(slice)
      if (kind === 'unknown' && !detectedNul && peek.length < 8192) {
        const need = 8192 - peek.length
        peek = Buffer.concat([peek, slice.subarray(0, Math.min(need, slice.length))])
        for (let i = 0; i < peek.length; i++) {
          if (peek[i] === 0) {
            detectedNul = true
            break
          }
        }
      }
      n++
      // 大文件每 512 块让出一次
      if ((n & 511) === 0) await yieldNow()
    }
  } catch {
    return { sha: '', text: false }
  }
  const sha = hash.digest('hex')
  const text = kind === 'binary' ? false : kind === 'text' ? true : !detectedNul
  let content: string | undefined
  if (text) content = Buffer.concat(chunks).toString('utf8')
  return { sha, text, content }
}

// ── scanSnapshot ──────────────────────────────────────────────────

/**
 * 扫一遍当前磁盘状态，出 TrackEntry 清单。
 *
 * @param roots 参与跟踪的来源（顺序=载入序，靠后者优先）
 * @param prev  上次的 byRel Map（基线或上次快照）；size+mtime 命中则复用 sha256
 * @param store 可选；给定时文本全文 gzip 顺序追加写入该来源的 content.pack（内容寻址大文件）
 * @returns roots 原样回传 + files 清单 + skippedRehash（复用哈希数，性能指标）
 *
 * 性能：枚举(walk)与哈希(hash)异步化；哈希阶段对需要重算的文件用并发限制(24)的 worker 池
 * 并行处理（磁盘 I/O 与 zlib 线程池可真正并行），增量复用(size+mtime 命中)的文件直接进结果、
 * 不进哈希队列。每累计 64 个完成文件上报一次进度并让出事件循环，保证 SSE 实时、可中断。
 */
export async function scanSnapshot(
  roots: TrackRoot[],
  prev?: Map<string, TrackEntry> | null,
  store?: ContentStore | null,
  onProgress?: ProgressFn,
): Promise<{ roots: TrackRoot[]; files: TrackEntry[]; skippedRehash: number }> {
  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  const report = (p: TrackProgress) => { if (onProgress) onProgress(p) }
  // 1. 逐 root 枚举磁盘文件（异步 walk，定期让出事件循环）
  const perRoot = roots.map(() => new Map<string, { size: number; mtime: number }>())
  report({ phase: 'walk', current: 0, total: -1, stage: '' })
  for (let i = 0; i < roots.length; i++) {
    await walkRoot(roots[i], perRoot[i], yieldNow)
    report({ phase: 'walk', current: i + 1, total: -1, stage: roots[i].name })
    await yieldNow()
  }

  // 2. 汇总所有 rel（归一化后）
  const allRels = new Set<string>()
  for (const m of perRoot) for (const k of m.keys()) allRels.add(k)

  // 3. 归属判定走 resolveAssets（口径全站一致）
  const srcRoots: SrcRoot[] = roots.map((r) => ({
    name: r.name,
    path: r.path,
    writable: r.writable,
    replacePaths: r.replacePaths as readonly NormPath[] | undefined,
  }))
  const resolved = resolveAssets(srcRoots, allRels, (i, rel) => perRoot[i].has(rel))

  // 4. 拆分：增量复用(同 size+mtime)直接进结果；其余进哈希队列
  const prevX = (prev ?? null) as Map<string, TrackEntryX> | null
  const total = resolved.refs.size
  const reuse: TrackEntryX[] = []
  const tasks: Array<{ rel: string; diskRoot: number; st: { size: number; mtime: number }; ref: { own: TrackEntry['own']; chain: number[]; shadowed: number[]; effective: number }; pe?: TrackEntryX }> = []
  for (const [rel, ref] of resolved.refs) {
    // gap 时 effective=-1，取 chain 最高优先级的磁盘来源做 stat/hash
    const diskRoot = ref.effective >= 0 ? ref.effective : ref.chain.length ? ref.chain[ref.chain.length - 1] : 0
    const st = perRoot[diskRoot] && perRoot[diskRoot].get(rel)
    if (!st) continue
    const pe = prevX && prevX.get(rel)
    if (pe && pe.size === st.size && pe.mtime === st.mtime) {
      // ★ 增量：size+mtime 完全一致 → 复用 sha，不重读文件；content 不预取，
      //   只在 compare 出 modified 文本文件时按需从 pack 恢复（避免全量解压）
      reuse.push({ rel, size: st.size, mtime: st.mtime, sha256: pe.sha256, root: diskRoot, own: ref.own, chain: ref.chain, shadowed: ref.shadowed, text: pe.text })
    } else {
      tasks.push({ rel, diskRoot, st, ref, pe })
    }
  }

  // 5. 并行哈希（并发限制，避免内存/句柄耗尽；每 64 个上报并让出）
  const files: TrackEntryX[] = reuse
  let done = 0
  let skipped = reuse.length
  report({ phase: 'hash', current: 0, total, stage: '' })
  const CONC = 24
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const i = cursor++
      const t = tasks[i]
      const abs = join(roots[t.diskRoot].path, t.rel)
      const h = await hashFile(abs, t.rel, yieldNow)
      if (!h.sha) {
        // 个别文件读失败（权限/占用）→ 跳过并告警，不拖垮整批
        console.warn('[tracker] 跳过文件（哈希失败）: ' + abs)
        continue
      }
      if (store && h.text && h.content && !store.index.has(h.sha)) {
        await storeWrite(store, h.sha, h.content)
      }
      files.push({
        rel: t.rel,
        size: t.st.size,
        mtime: t.st.mtime,
        sha256: h.sha,
        root: t.diskRoot,
        own: t.ref.own,
        chain: t.ref.chain,
        shadowed: t.ref.shadowed,
        text: h.text,
        content: h.content,
      })
      done++
      if ((done & 63) === 0 || done === tasks.length) {
        report({ phase: 'hash', current: done, total, stage: t.rel })
        await yieldNow()
      }
    }
  }
  if (tasks.length) {
    await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, worker))
  }
  return { roots, files, skippedRehash: skipped }
}

// ── buildBaseline ─────────────────────────────────────────────────

/**
 * 建基线：全量快照 → 写 tracker/baseline/<key>/baseline.json（清单，不塞 content），
 * 文本全文 gzip 顺序写入同目录的 content.pack（单文件大包，取代旧版零碎 blobs/）；
 * 并清空该来源历史记录（重建基线=重置跟踪起点）；随后自动 GC 清理旧版 blob 目录/死内容。
 * @param trackerDir 项目根（tracker 目录 = <项目根>/tracker）
 */
export async function buildBaseline(trackerDir: string, root: TrackRoot, onProgress?: ProgressFn, autoGc = true): Promise<{ ok: boolean; files: number; gc?: { removed: number; remaining: number; skipped: number } }> {
  const key = rootKey(root.path)
  const bd = baselineDir(trackerDir, key)
  const store = await openStore(bd, true) // 全新：删除旧 pack/idx
  const snap = await scanSnapshot([root], null, store, onProgress)
  await storeSaveIdx(store)
  await storeClose(store)
  await fs.mkdir(bd, { recursive: true })
  const files: TrackEntry[] = snap.files.map(({ content: _c, ...e }) => e)
  await fs.writeFile(
    join(bd, 'baseline.json'),
    JSON.stringify({ version: 1 as const, createdAt: new Date().toISOString(), roots: [root], files }),
  )
  const hd = historyDir(trackerDir, key)
  await fs.rm(hd, { recursive: true, force: true })
  await fs.mkdir(hd, { recursive: true })
  // 迁移清理：删除旧版全局 blobs 目录（已被 pack 取代）
  await fs.rm(join(trackerSubDir(trackerDir), 'blobs'), { recursive: true, force: true }).catch(() => {})
  let gc: { removed: number; remaining: number; skipped: number } | undefined
  if (autoGc) {
    try { gc = await gcBlobs(trackerDir, onProgress) } catch (e) { console.warn('[tracker] GC 失败: ' + (e as Error)?.message) }
  }
  return { ok: true, files: files.length, gc }
}

// ── 行级 diff ─────────────────────────────────────────────────────

/** 按 \r?\n 切行；末尾换行不产生空尾行；空串 → [] */
function splitLines(t: string): string[] {
  if (!t) return []
  const parts = t.split(/\r?\n/)
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

interface MidLine {
  type: 'ctx' | 'del' | 'add'
  text: string
}

/** O(ND) Myers 行级 LCS：返回与 lcsBlock 同形的 MidLine[]。
 *  编辑距离小则极快（与文件大小无关）；仅当编辑距离超出 MAXD（近全量重写）才退化为
 *  「整段删 + 整段加」，此时与文件确为全改的语义一致。 */
function myersMid(A: string[], B: string[]): MidLine[] {
  const N = A.length
  const M = B.length
  if (N === 0) return B.map((t) => ({ type: 'add' as const, text: t }))
  if (M === 0) return A.map((t) => ({ type: 'del' as const, text: t }))
  const MAXD = 4000
  const MAX = Math.min(N + M, MAXD)
  const offset = MAX
  const V = new Array<number>(2 * offset + 1).fill(0)
  const trace: number[][] = []
  let endD = -1
  outer: for (let d = 0; d <= MAX; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1]))
        x = V[offset + k + 1]
      else
        x = V[offset + k - 1] + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) { x++; y++ }
      V[offset + k] = x
      if (x >= N && y >= M) { endD = d; break outer }
    }
    trace.push(V.slice())
  }
  if (endD < 0) {
    const r: MidLine[] = []
    for (const s of A) r.push({ type: 'del', text: s })
    for (const s of B) r.push({ type: 'add', text: s })
    return r
  }
  const edits: MidLine[] = []
  let x = N, y = M
  for (let d = endD; d > 0; d--) {
    const Vprev = trace[d - 1]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && Vprev[offset + k - 1] < Vprev[offset + k + 1]))
      prevK = k + 1
    else
      prevK = k - 1
    const x0 = Vprev[offset + prevK]
    const y0 = x0 - prevK
    const ex = prevK === k + 1 ? x0 : x0 + 1
    const ey = prevK === k + 1 ? y0 + 1 : y0
    while (x > ex || y > ey) { edits.push({ type: 'ctx', text: A[x - 1] }); x--; y-- }
    if (prevK === k + 1) edits.push({ type: 'add', text: B[ey - 1] })
    else edits.push({ type: 'del', text: A[ex - 1] })
    x = x0; y = y0
  }
  while (x > 0 || y > 0) { edits.push({ type: 'ctx', text: A[x - 1] }); x--; y-- }
  edits.reverse()
  return edits
}

/** 中间块 LCS：小文件用精确 DP（快速且严格最小）；大文件改用 O(ND) Myers，
 *  避免原 O(m·n) DP 在 m·n>4M 时退化为「整段删+整段加」、把仅小改动的巨大文件
 *  误报成上万行的伪 diff。 */
function lcsBlock(A: string[], B: string[]): MidLine[] {
  const m = A.length
  const n = B.length
  if (m * n <= 4000000) {
    const dp: number[][] = []
    for (let i = 0; i <= m; i++) dp.push(new Array<number>(n + 1).fill(0))
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    const r: MidLine[] = []
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (A[i] === B[j]) {
        r.push({ type: 'ctx', text: A[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        r.push({ type: 'del', text: A[i] })
        i++
      } else {
        r.push({ type: 'add', text: B[j] })
        j++
      }
    }
    while (i < m) {
      r.push({ type: 'del', text: A[i] })
      i++
    }
    while (j < n) {
      r.push({ type: 'add', text: B[j] })
      j++
    }
    return r
  }
  return myersMid(A, B)
}

/** 公共前缀/后缀剥离 + 中间块 LCS，输出带 1-based 行号的 DiffLine */
function computeDiff(O: string[], N: string[]): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  const minLen = Math.min(O.length, N.length)
  while (i < minLen && O[i] === N[i]) i++
  let jOld = O.length - 1
  let jNew = N.length - 1
  while (jOld >= i && jNew >= i && O[jOld] === N[jNew]) {
    jOld--
    jNew--
  }
  // 前缀 ctx
  for (let k = 0; k < i; k++) {
    out.push({ type: 'ctx', oldNo: k + 1, newNo: k + 1, text: O[k] })
  }
  // 中间块（行号从 i+1 开始）
  const midOld = O.slice(i, jOld + 1)
  const midNew = N.slice(i, jNew + 1)
  const mid = lcsBlock(midOld, midNew)
  let oldNo = i + 1
  let newNo = i + 1
  for (const d of mid) {
    if (d.type === 'ctx') {
      out.push({ type: 'ctx', oldNo, newNo, text: d.text })
      oldNo++
      newNo++
    } else if (d.type === 'del') {
      out.push({ type: 'del', oldNo, newNo: null, text: d.text })
      oldNo++
    } else {
      out.push({ type: 'add', oldNo: null, newNo, text: d.text })
      newNo++
    }
  }
  // 后缀 ctx（O[jOld+1+x] 与 N[jNew+1+x] 相同）
  let x = 0
  for (let kOld = jOld + 1; kOld < O.length; kOld++) {
    out.push({ type: 'ctx', oldNo: kOld + 1, newNo: jNew + 1 + x + 1, text: O[kOld] })
    x++
  }
  return out
}

/**
 * 行级文本 diff。
 * @param maxDiff 最大输出行数，默认 500；超过时保留前 250 / 后 250，中间插一条省略标注行。
 */
export function diffLines(oldText: string, newText: string, maxDiff: number = 200000): DiffLine[] {
  const O = splitLines(oldText)
  const N = splitLines(newText)
  const full = computeDiff(O, N)
  if (full.length <= maxDiff) return full
  const head = Math.ceil(maxDiff / 2)
  const tail = maxDiff - head
  const omitted = full.length - head - tail
  const out = full.slice(0, head)
  out.push({ type: 'ctx', oldNo: null, newNo: null, text: '… 中间省略 ' + omitted + ' 行 …' })
  for (const l of full.slice(full.length - tail)) out.push(l)
  return out
}

// ── compareBaseline ───────────────────────────────────────────────

async function readTextSafe(abs: string): Promise<string> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 对比基线与本次快照，出变更报告。
 * 四态：new / deleted / modified（文本附 diff）/ moved（同 sha 配对）。
 * 变更的 own/chain/root 按本次快照归属。
 * @param store 可选；给定时旧/新文本优先从来源自己的 content.pack 按偏移恢复（重启后基线无 content）
 */
/**
 * 新增 / 删除文件的上下文片段：只取前 CONTEXT 行，避免整文件全量展示。
 * 供 new / deleted 变更在检查时即内嵌进 history（不依赖 blob，GC 安全）。
 */
function contextDiff(txt: string, type: 'add' | 'del'): DiffLine[] {
  const lines = splitLines(txt || '')
  const N = Math.min(60, lines.length)
  const out: DiffLine[] = []
  for (let i = 0; i < N; i++) {
    out.push({ type, oldNo: type === 'del' ? i + 1 : null, newNo: type === 'add' ? i + 1 : null, text: lines[i] })
  }
  if (lines.length > N) {
    out.push({ type: 'ctx', oldNo: null, newNo: null, text: '… 仅显示前 ' + N + ' 行（共 ' + lines.length + ' 行）…' })
  }
  return out
}

export async function compareBaseline(
  baseline: TrackBaseline,
  snap: { roots: TrackRoot[]; files: TrackEntry[] },
  store?: ContentStore | null,
): Promise<TrackReport> {
  const bRoots = baselineRoots(baseline)
  const baseMap = new Map<string, TrackEntryX>()
  for (const f of baseline.files as TrackEntryX[]) baseMap.set(f.rel, f)
  const snapMap = new Map<string, TrackEntryX>()
  for (const f of snap.files as TrackEntryX[]) snapMap.set(f.rel, f)

  const deleted: TrackEntryX[] = []
  const added: TrackEntryX[] = []
  for (const b of baseline.files) if (!snapMap.has(b.rel)) deleted.push(b as TrackEntryX)
  for (const s of snap.files) if (!baseMap.has(s.rel)) added.push(s as TrackEntryX)

  const changes: TrackChange[] = []

  // modified：都在且 sha 不同（异步按需恢复旧/新文本，仅 modified 文本文件）
  for (const s of snap.files) {
    const b = baseMap.get(s.rel)
    if (!b) continue
    if (b.sha256 === s.sha256) continue
    const sx = s as TrackEntryX
    const ch: TrackChange = {
      kind: 'modified',
      rel: s.rel,
      root: s.root,
      text: s.text,
      own: s.own,
      meta: {
        oldSize: b.size,
        newSize: s.size,
        oldMtime: b.mtime,
        newMtime: s.mtime,
        oldSha: b.sha256,
        newSha: s.sha256,
      },
    }
    if (s.text) {
      const oldText = b.content ?? (store ? await storeRead(store, b.sha256) : undefined) ?? (await readTextSafe(join(bRoots[b.root]?.path ?? '', b.rel)))
      const newText = sx.content ?? (store ? await storeRead(store, s.sha256) : undefined) ?? (await readTextSafe(join(snap.roots[s.root]?.path ?? '', s.rel)))
      // ★ 内嵌 diff 行数上限:原版巨型 loc 文件动辄十几万行 diff,663 个 modified 就能把
      //   一条历史 JSON 写到 166MB,打包态(app:// 经 IPC 回传)直接把后端子进程序列化撑爆。
      //   超限行在 diffLines 内部截断(保留头尾+省略标注),展示层不受影响。
      ch.diff = diffLines(oldText, newText, MAX_EMBED_DIFF_ROWS)
    }
    changes.push(ch)
  }

  // moved 配对：按 sha 分组，deleted/new 各按 rel 排序后一一配对（确定性）
  const delBySha = new Map<string, TrackEntryX[]>()
  for (const d of deleted) {
    if (!d.sha256) continue
    const arr = delBySha.get(d.sha256)
    if (arr) arr.push(d)
    else delBySha.set(d.sha256, [d])
  }
  for (const arr of delBySha.values()) arr.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const usedDel = new Set<string>()
  const remainingAdded: TrackEntryX[] = []
  const addedSorted = [...added].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const a of addedSorted) {
    const arr = a.sha256 ? delBySha.get(a.sha256) : undefined
    if (arr && arr.length) {
      const d = arr.shift()!
      usedDel.add(d.rel)
      changes.push({
        kind: 'moved',
        rel: a.rel,
        prevRel: d.rel,
        root: a.root,
        text: a.text,
        own: a.own,
        meta: { oldSize: d.size, newSize: a.size, oldSha: d.sha256, newSha: a.sha256 },
      })
    } else {
      remainingAdded.push(a)
    }
  }

  // 未配对的 deleted → deleted
  for (const d of deleted) {
    if (usedDel.has(d.rel)) continue
        let _dtx = ''
    try {
      _dtx = d.content ?? (store && d.text ? await storeRead(store, d.sha256) : undefined) ?? await readTextSafe(join(bRoots[d.root]?.path ?? '', d.rel))
    } catch { _dtx = '' }
    changes.push({
      kind: 'deleted',
      rel: d.rel,
      root: d.root,
      text: d.text,
      own: d.own,
      meta: { oldSize: d.size, oldMtime: d.mtime, oldSha: d.sha256 },
      diff: d.text ? contextDiff(_dtx, 'del') : undefined,
    })
  }
  // 未配对的 added → new
  for (const a of remainingAdded) {
        let _ntx = ''
    try {
      _ntx = a.content ?? (store && a.text ? await storeRead(store, a.sha256) : undefined) ?? await readTextSafe(join(snap.roots[a.root]?.path ?? '', a.rel))
    } catch { _ntx = '' }
    changes.push({
      kind: 'new',
      rel: a.rel,
      root: a.root,
      text: a.text,
      own: a.own,
      meta: { newSize: a.size, newMtime: a.mtime, newSha: a.sha256 },
      diff: a.text ? contextDiff(_ntx, 'add') : undefined,
    })
  }

  // 确定性排序：按 rel
  changes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  // stats
  const byRoot: Record<string, number> = {}
  const byKind = { new: 0, modified: 0, deleted: 0, moved: 0 }
  for (const c of changes) {
    const rn = (snap.roots[c.root] && snap.roots[c.root].name) ?? String(c.root)
    byRoot[rn] = (byRoot[rn] ?? 0) + 1
    byKind[c.kind]++
  }

  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    baselineAt: baseline.createdAt,
    roots: snap.roots,
    changes,
    stats: { total: changes.length, byRoot, byKind },
  }
}

// ── 服务端持久化入口（server.ts import 别名：trBuildBaseline/trCheckUpdate/trGetDiff/trListHistory/trStatus）────

/**
 * 检查更新：读基线 → 增量扫描（size+mtime 复用，diff 内容惰性从 blob 恢复）→ 对比出四态变更 →
 * 写一条历史记录（含行级 diff）→ 滚动基线到当前（下次只看到新的变化）→ 自动 GC 清理无人引用的 blob。
 * @param trackerDir 项目根
 */
export async function checkUpdate(trackerDir: string, root: TrackRoot, onProgress?: ProgressFn, autoGc = true): Promise<{ ok: boolean; report?: TrackReport; gc?: { removed: number; remaining: number; skipped: number } }> {
  const key = rootKey(root.path)
  const bPath = join(baselineDir(trackerDir, key), 'baseline.json')
  let base: TrackBaseline | null = null
  try {
    base = JSON.parse(await fs.readFile(bPath, 'utf8')) as TrackBaseline
  } catch {
    return { ok: false }
  }
  if (!base) return { ok: false }
  // 兼容旧格式（旧 JSON 顶层为单数 root）：归一化为 roots 数组后再 compare
  const baselineX: TrackBaseline = { ...base, roots: baselineRoots(base) }
  const prev = new Map<string, TrackEntry>(base.files.map((f) => [f.rel, f]))
  const store = await openStore(baselineDir(trackerDir, key), false)
  const snap = await scanSnapshot([root], prev, store, onProgress)
  if (onProgress) onProgress({ phase: 'compare', current: 0, total: -1, stage: '' })
  const report = await compareBaseline(baselineX, snap, store)
  if (onProgress) onProgress({ phase: 'finalize', current: 1, total: 1, stage: '' })

  // 写历史（每条来源各自一份，互不影响）
  const hd = historyDir(trackerDir, key)
  await fs.mkdir(hd, { recursive: true })
  const entry: TrackHistoryEntry = {
    version: 1,
    checkedAt: report.checkedAt,
    baselineAt: report.baselineAt,
    roots: snap.roots,
    stats: report.stats,
    changes: report.changes,
  }
  const tsFile = Date.now() + '.json'
  // ★ 体积护栏:先按总预算裁掉过大的内嵌 diff,再落盘(见 trimEmbeddedDiffs 注释)
  trimEmbeddedDiffs(entry.changes)
  await fs.writeFile(join(hd, tsFile), JSON.stringify(entry))
  // 维护轻量索引（供「打开更新列表」秒开，无需逐个解析历史 JSON）
  {
    let idxEntries = readHistIndex(hd) || buildHistIndexFromDir(hd)
    idxEntries = idxEntries.filter((e) => e.fileName !== tsFile)
    idxEntries.unshift({ fileName: tsFile, checkedAt: entry.checkedAt, baselineAt: entry.baselineAt, stats: entry.stats })
    if (idxEntries.length > 200) idxEntries = idxEntries.slice(0, 200) // 索引最多保留最近 200 条
    writeHistIndex(hd, idxEntries)
  }

  // 滚动基线到当前:下次「检查更新」只看到该来源新的变化(类似 git commit 后干净工作区)。
  // pack 已追加写入本次新增/改动文件的当前内容,索引稍后落盘;旧内容保留在 pack 中,历史 diff
  // 内嵌于 history JSON 不依赖 pack;无人引用的死 blob 由 GC 紧凑回收。
  const files: TrackEntry[] = snap.files.map(({ content: _c, ...e }) => e)
  await fs.writeFile(
    bPath,
    JSON.stringify({ version: 1 as const, createdAt: base.createdAt ?? report.checkedAt, roots: [root], files }),
  )
  // 落盘本次追加内容的索引（不改写 pack 本身，保持检查快速）
  await storeSaveIdx(store)
  await storeClose(store)
  let gc: { removed: number; remaining: number; skipped: number } | undefined
  // 仅当死 blob 较多时才做紧凑重写，避免每次检查都重写整个大 pack（保证速度）
  if (autoGc) {
    try { gc = await gcBlobs(trackerDir, onProgress, 512) } catch (e) { console.warn('[tracker] GC 失败: ' + (e as Error)?.message) }
  }
  return { ok: true, report, gc }
}

// ── blob GC（内容寻址回收）────────────────────────────────────────

/**
 * 紧凑各来源的 content.pack：只保留其当前基线引用的 sha，回收改动/删除产生的死 blob，
 * 同时清理旧版全局 blobs/ 目录（已被 pack 取代）。
 * 保留集 = 该来源当前基线 baseline.json 的 text 文件 files[].sha256。
 * 死 blob 数 < minGarbage 时跳过该来源（避免每次检查都重写整个大 pack，保持速度）；
 * 手动 GC(默认 minGarbage=64)或大量改动后会真正紧凑。
 */
export async function gcBlobs(trackerDir: string, onProgress?: ProgressFn, minGarbage = 64): Promise<{ removed: number; remaining: number; skipped: number }> {
  const baseRoot = join(trackerSubDir(trackerDir), 'baseline')
  // 迁移清理：删除旧版全局 blobs 目录（若存在）
  await fs.rm(join(trackerSubDir(trackerDir), 'blobs'), { recursive: true, force: true }).catch(() => {})
  let keys: string[] = []
  try {
    keys = await fs.readdir(baseRoot)
  } catch {
    return { removed: 0, remaining: 0, skipped: 0 }
  }
  let removed = 0
  let remaining = 0
  let skipped = 0
  for (const k of keys) {
    const bd = join(baseRoot, k)
    let base: TrackBaseline | null = null
    try {
      base = JSON.parse(await fs.readFile(join(bd, 'baseline.json'), 'utf8')) as TrackBaseline
    } catch {
      continue
    }
    const live = new Set<string>()
    for (const f of base.files) if (f.text && f.sha256) live.add(f.sha256)
    // ★ 关键修复：历史记录里引用的 oldSha/newSha 也必须纳入 live。
    //   否则「删除最新检查点→回滚基线→立即重查」时，回滚所依赖的旧内容 blob
    //   已被 GC 回收：重查时 compareBaseline 用 oldSha 取旧内容取不到，退化成读磁盘
    //   （磁盘仍是新内容）→ 旧/新文本相等 → diffLines 全是 ctx 无增删 → 前端显示
    //   「该文件无可用差异」。纳入历史 shas 后，只要该检查点还存在，其内容就保活。
    //   （历史文件本身被删、且不再被任何基线/历史引用时，对应 blob 自然成为 dead 被回收。）
    try {
      const hist = listHistory(trackerDir, k)
      for (const e of hist) for (const c of e.changes || []) {
        const m = c.meta || {}
        if (m.oldSha) live.add(m.oldSha)
        if (m.newSha) live.add(m.newSha)
      }
    } catch { /* 历史读不出就不纳入，按基线口径走 */ }
    const store = await openStore(bd, false)
    const dead = [...store.index.keys()].filter((s) => !live.has(s))
    if (dead.length < minGarbage) {
      skipped += dead.length
      await storeClose(store)
      continue
    }
    if (onProgress) onProgress({ phase: 'finalize', current: removed, total: -1, stage: 'GC 紧凑 ' + k })
    const r = await compactStore(store, live)
    removed += r.removed
    remaining += store.index.size
    await storeClose(store)
  }
  return { removed, remaining, skipped }
}

/** 单来源跟踪状态（用于前端按来源列出） */
export interface TrackRootStatus {
  key: string
  name: string
  path: string
  writable: boolean
  hasBaseline: boolean
  baselineAt?: string
  baselineFiles?: number
  lastCheckAt?: string | null
  lastCheckTotal?: number
}

/** 各来源独立状态：基础游戏 + 每个模组各返回一条。 */
export function trackerStatus(trackerDir: string, roots: TrackRoot[]): TrackRootStatus[] {
  return roots.map((r) => {
    const key = rootKey(r.path)
    const bPath = join(baselineDir(trackerDir, key), 'baseline.json')
    const st: TrackRootStatus = { key, name: r.name, path: r.path, writable: r.writable, hasBaseline: false }
    if (!existsSync(bPath)) return st
    try {
      const base = JSON.parse(readFileSync(bPath, 'utf8')) as TrackBaseline
      const hist = listHistory(trackerDir, key)
      const last = hist[0]
      st.hasBaseline = true
      st.baselineAt = base.createdAt
      st.baselineFiles = base.files.length
      st.lastCheckAt = last ? last.checkedAt : null
      st.lastCheckTotal = last ? last.stats.total : 0
    } catch {
      /* 基线损坏则视为未建 */
    }
    return st
  })
}

// ── 历史记录的轻量索引（供「打开更新列表」秒开，不逐个解析历史 JSON）──
export interface TrackHistorySummary {
  fileName: string
  checkedAt: string
  baselineAt: string
  stats: TrackReport['stats']
}

function readHistIndex(hd: string): TrackHistorySummary[] | null {
  try {
    const o = JSON.parse(readFileSync(join(hd, 'index.json'), 'utf8')) as { entries?: TrackHistorySummary[] }
    return o.entries && o.entries.length ? o.entries : null
  } catch {
    return null
  }
}
function writeHistIndex(hd: string, entries: TrackHistorySummary[]): void {
  try { writeFileSync(join(hd, 'index.json'), JSON.stringify({ version: 1, entries })) } catch { /* 忽略 */ }
}
function buildHistIndexFromDir(hd: string): TrackHistorySummary[] {
  let names: string[] = []
  try { names = readdirSync(hd) } catch { return [] }
  const out: TrackHistorySummary[] = []
  for (const n of names) {
    if (!/^[0-9]+\.json$/.test(n)) continue
    try {
      const e = JSON.parse(readFileSync(join(hd, n), 'utf8')) as TrackHistoryEntry
      out.push({ fileName: n, checkedAt: e.checkedAt, baselineAt: e.baselineAt, stats: e.stats })
    } catch { /* 跳过坏文件 */ }
  }
  out.sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1))
  return out
}

/** 历史列表摘要（供「打开更新列表」秒开：只读一个轻量 index.json，不逐个解析历史 JSON） */
export function listHistorySummary(trackerDir: string, key: string): TrackHistorySummary[] {
  const hd = historyDir(trackerDir, key)
  const idx = readHistIndex(hd)
  if (idx) return idx
  // 旧数据无索引：退化扫描目录并回填索引，之后即秒开
  const built = buildHistIndexFromDir(hd)
  if (built.length) writeHistIndex(hd, built)
  return built
}

/** 取某条历史记录的完整内容（含 changes/diff），按文件名精确读取，不联动其它条目 */
export function getHistoryEntry(trackerDir: string, key: string, ts: string): TrackHistoryEntry | null {
  if (!/^[0-9]+\.json$/.test(ts)) return null
  try {
    return JSON.parse(readFileSync(join(historyDir(trackerDir, key), ts), 'utf8')) as TrackHistoryEntry
  } catch {
    return null
  }
}

/** 历史记录列表（新的在前，含完整 changes），按来源 key 取该来源自己的记录（getDiff 等仍用） */
const _histCache = new Map<string, { sig: number; data: TrackHistoryEntry[] }>()
export function listHistory(trackerDir: string, key: string): TrackHistoryEntry[] {
  const hd = historyDir(trackerDir, key)
  // 排除轻量索引 index.json（不是历史记录）
  const isHistFile = (n: string) => n.endsWith('.json') && n !== 'index.json'
  let sig = 0
  try {
    sig = readdirSync(hd).filter(isHistFile).reduce((s, n) => s + statSync(join(hd, n)).mtimeMs, 0)
  } catch { /* 目录不存在 */ }
  const cached = _histCache.get(key)
  if (cached && cached.sig === sig) return cached.data
  let names: string[] = []
  try {
    names = readdirSync(hd)
  } catch {
    return []
  }
  const list = names
    .filter(isHistFile)
    .map((n) => {
      try {
        const _e = JSON.parse(readFileSync(join(hd, n), 'utf8')) as TrackHistoryEntry
        return { ..._e, fileName: n }
      } catch {
        return null
      }
    })
    .filter((e): e is TrackHistoryEntry => !!e)
    .sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1))
  _histCache.set(key, { sig, data: list })
  return list
}

/** 取某来源某条检查记录里某条变更的行级 diff（diff 在检查时已算好并持久化） */
export async function getDiff(
  trackerDir: string,
  rkey: string,
  key: string,
  kind: string,
  ts?: string,
  idx = 0,
): Promise<{ kind: string; rel: string; diff: DiffLine[]; noBase?: boolean } | null> {
  const entry = ts ? getHistoryEntry(trackerDir, rkey, ts) : (listHistory(trackerDir, rkey)[idx] ?? listHistory(trackerDir, rkey)[0])
  if (!entry) return null
  const ch = entry.changes.find((c) => c.rel === key && c.kind === kind)
  if (!ch) return null
  if (kind === 'modified' && ch.meta && ch.meta.oldSha && ch.meta.newSha) {
    // ★ 内容与存储可达时一律重算：既能修正早期 lcsBlock 兜底产生的超大伪 diff，
    // 也能保证展示始终与真实文本一致。旧 blob 损坏/GC 不可读时回退到存储 diff。
    try {
      const oldT = await readContent(trackerDir, rkey, ch.meta.oldSha)
      const newT = await readContent(trackerDir, rkey, ch.meta.newSha)
      if (typeof oldT === 'string' && typeof newT === 'string') {
        const fresh = diffLines(oldT, newT)
        const freshChange = (fresh || []).some((d) => d.type === 'add' || d.type === 'del')
        ch.diff = freshChange ? fresh : []
        return { kind: ch.kind, rel: ch.rel, diff: ch.diff }
      }
      // 旧内容已不可读(多半被 GC 回收)：直接标记 noBase，前端提示「重新检查」，
      // 不要再装作「无差异」误导用户（磁盘回退读取会产生等价的假空 diff）。
      if (typeof oldT !== 'string') {
        return { kind: ch.kind, rel: ch.rel, diff: [], noBase: true }
      }
    } catch {}
    // 内容不可读：若存储 diff 明显是旧兜底假 diff（几乎全增删、无上下文），不展示它
    const stored = ch.diff || []
    const changeCount = stored.filter((d) => d.type === 'add' || d.type === 'del').length
    const ctxCount = stored.length - changeCount
    if (changeCount > 500 && ctxCount < changeCount * 0.05) {
      return { kind: ch.kind, rel: ch.rel, diff: [], noBase: true }
    }
  }
  return { kind: ch.kind, rel: ch.rel, diff: ch.diff ?? [] }
}

/**
 * 删除整个跟踪缓存（基线 / blobs / 历史，即 tracker 目录本身）。
 * ★ 安全护栏：仅当目录名恰为 `tracker` 时才执行，拒绝误删其它目录。
 */
export function clearTracker(trackerDir: string): void {
  const target = trackerSubDir(trackerDir)
  const tail = basename(target.replace(/\\/g, '/').replace(/\/+$/, ''))
  if (tail !== 'tracker') throw new Error('clearTracker: 拒绝删除非 tracker 目录: ' + target)
  rmSync(target, { recursive: true, force: true })
}

/**
 * 把基线回滚到「某次检查之前」的状态(删除【最新】检查点时调用)。
 * 反向应用该条记录的变更:new→移除 / modified→还原 oldSha / deleted→还原条目 / moved→还原旧路径。
 * 旧 sha 的内容 blob 可能已被 GC 回收:基线仅引用 sha,扫描比对完全不受影响;
 * 只有事后查看该文件 diff 时若无法从 pack 取旧文,会回退到记录内嵌的 diff(或提示重新检查)。
 */
function rollbackBaseline(trackerDir: string, key: string, ts: string): void {
  let entry: TrackHistoryEntry
  try {
    entry = JSON.parse(readFileSync(join(historyDir(trackerDir, key), ts), 'utf8')) as TrackHistoryEntry
  } catch { return }
  const bPath = join(baselineDir(trackerDir, key), 'baseline.json')
  let base: TrackBaseline
  try {
    base = JSON.parse(readFileSync(bPath, 'utf8')) as TrackBaseline
  } catch { return }
  const files = new Map(base.files.map((f) => [f.rel, f]))
  for (const c of entry.changes || []) {
    const m = c.meta || {}
    if (c.kind === 'new') {
      files.delete(c.rel)
    } else if (c.kind === 'modified') {
      const f = files.get(c.rel)
      if (f && m.oldSha) {
        f.sha256 = m.oldSha
        if (m.oldSize != null) f.size = m.oldSize
        if (m.oldMtime != null) f.mtime = m.oldMtime
      }
    } else if (c.kind === 'deleted') {
      if (m.oldSha) {
        files.set(c.rel, { rel: c.rel, size: m.oldSize ?? 0, mtime: m.oldMtime ?? 0, sha256: m.oldSha, root: c.root, own: c.own, chain: [c.root], shadowed: [], text: c.text })
      }
    } else if (c.kind === 'moved') {
      files.delete(c.rel)
      if (c.prevRel && m.oldSha) {
        files.set(c.prevRel, { rel: c.prevRel, size: m.oldSize ?? 0, mtime: m.oldMtime ?? 0, sha256: m.oldSha, root: c.root, own: c.own, chain: [c.root], shadowed: [], text: c.text })
      }
    }
  }
  base.files = [...files.values()]
  // 基线时间回拨到该次检查所参照的基线时刻(纯展示语义,不影响比对)
  if (entry.baselineAt) base.createdAt = entry.baselineAt
  try { writeFileSync(bPath, JSON.stringify(base)) } catch { /* 写不进就不回滚 */ }
}

/** 删除某来源一条历史记录（按文件名，安全过滤，仅允许纯数字 .json）。
 * ★ 若删除的是【最新】一条检查点,基线一并回滚到该次检查之前 ——
 *   下次「立即检查」以更早的检查点为参照,被删检查点报告过的差异会重新出现;
 *   删除非最新记录只删记录本身(中间态基线已被滚动覆盖,无法回溯)。 */
export function deleteHistory(trackerDir: string, key: string, ts: string): void {
  if (!/^[0-9]+\.json$/.test(ts)) throw new Error('deleteHistory: 非法历史文件名: ' + ts)
  const hd = historyDir(trackerDir, key)
  const idx = readHistIndex(hd) || buildHistIndexFromDir(hd)
  const latest = idx.length ? idx.reduce((a, b) => (a.checkedAt > b.checkedAt ? a : b)) : null
  if (latest && latest.fileName === ts) rollbackBaseline(trackerDir, key, ts)
  rmSync(join(hd, ts), { force: true })
  if (idx) writeHistIndex(hd, idx.filter((e) => e.fileName !== ts))
}

/** 删除单个来源的跟踪缓存（该来源的基线 + 历史），不影响其它来源。 */
export function clearRoot(trackerDir: string, path: string): void {
  const key = rootKey(path)
  rmSync(baselineDir(trackerDir, key), { recursive: true, force: true })
  rmSync(historyDir(trackerDir, key), { recursive: true, force: true })
}