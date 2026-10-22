/**
 * cache.ts - workbench disk cache (2026-10-09)
 * Serialize ensure* build outputs to <data root>/temp, and on cold start
 * hydrate from cache when the source signature is unchanged (skip rebuild).
 * Cache files: <data root>/temp/_cache_<name>.json, each carrying a source sig.
 *
 * ★ CACHE_V2(2026-10-17)数据根契约:与 server.ts 对齐,优先读 HOI4TK_DATA
 *   (Electron 主进程注入 = %APPDATA%\hoi4-toolkit);浏览器直跑 npm run gui
 *   时无此变量 → 回退"由自身位置上溯三级"的旧算法(源码态 packages/gui/src/… → 项目根)。
 *   上一版只按自身位置算,esbuild 打成 server.mjs 落到资源根后基准错位,导致缓存散落到
 *   D:\temp / %LOCALAPPDATA%\Programs\temp 等程序目录之外。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 可写数据根:设置 / 基线 / 缓存都在这里。 */
export const DATA_ROOT = process.env.HOI4TK_DATA
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const TEMP_DIR = join(DATA_ROOT, 'temp')

/**
 * Electron/Chromium 在数据根下生成、可随时重建的缓存目录(相对 DATA_ROOT)。
 * 刻意不含:gui-settings.json(配置)、tracker/(体检基线与历史)、
 * Preferences / Local State / Local Storage / Session Storage(界面与快捷键状态)。
 */
export const APP_CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'blob_storage', 'Service Worker',
] as const

export function cacheDir(): string {
  mkdirSync(TEMP_DIR, { recursive: true })
  return TEMP_DIR
}

export function serMap<V>(m: Map<string, V>): [string, V][] { return [...m.entries()] }
export function deMap<V>(a: [string, V][] | undefined): Map<string, V> { return new Map(a ?? []) }

export function dirSig(paths: string[]): string {
  /* 快速目录摘要(2026-10-09):不再逐文件拼相对路径字符串 —— 那在 vanilla
   * interface+gfx 上万文件时贡献了冷启动 ~4s。改为累计 count/sizeSum/mtimeMax,
   * 任何文件增删改都会改变三者之一 → 签名变化,足够可靠且 stat 开销最小。 */
  let count = 0
  let sizeSum = 0
  let mtimeMax = 0
  const walk = (dir: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile()) continue
      let st
      try { st = statSync(p) } catch { continue }
      count++
      sizeSum += st.size
      const mt = Math.round(st.mtimeMs / 1000)
      if (mt > mtimeMax) mtimeMax = mt
    }
  }
  for (const p of paths) { if (existsSync(p)) walk(p) }
  return strSig(paths.concat([String(count), String(sizeSum), String(mtimeMax)]))
}

export function strSig(parts: string[]): string {
  let h = 0x811c9dc5
  for (const s of parts) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }; h ^= 0xff }
  return h.toString(36)
}

export function saveCache(name: string, sig: string, data: unknown): void {
  const p = join(cacheDir(), `_cache_${name}.json`)
  try { writeFileSync(p, JSON.stringify({ sig, v: 1, data })) } catch (e) { console.log('  [cache] write fail ' + name + ': ' + e) }
}

/**
 * dirSigAsync - 分片目录签名(2026-10-09)。
 * 冷启动时引用图 hydrate 的瓶颈是 linkCacheSig:串行 stat 3 个来源的
 * interface+gfx 海量文件在冷文件系统下可到 16.5s。这里用同步 readdir 收集
 * 路径(快),再对 size/mtime 做 statSync —— 每 CHUNK 个文件 await 一次
 * setImmediate 让出事件循环,避免长时间阻塞 HTTP;任何文件增删改都会变
 * count/sizeSum/mtimeMax 三者之一 → 签名变化。statSync 不会像并发
 * fs.promises.stat 那样因个别文件挂起。
 */
export async function dirSigAsync(paths: string[]): Promise<string> {
  const files: string[] = []
  const walk = (dir: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile()) continue
      files.push(p)
    }
  }
  for (const p of paths) { if (existsSync(p)) walk(p) }
  let count = 0, sizeSum = 0, mtimeMax = 0
  const CHUNK = 1500
  for (let i = 0; i < files.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, files.length)
    for (let j = i; j < end; j++) {
      try {
        const st = statSync(files[j])
        count++
        sizeSum += st.size
        const mt = Math.round(st.mtimeMs / 1000)
        if (mt > mtimeMax) mtimeMax = mt
      } catch { /* 跳过读不到的文件 */ }
    }
    if (end < files.length) await new Promise<void>((r) => setImmediate(r))
  }
  return strSig(paths.concat([String(count), String(sizeSum), String(mtimeMax)]))
}

export function loadCache<T>(name: string, sig: string): T | null {
  const p = join(cacheDir(), `_cache_${name}.json`)
  if (!existsSync(p)) return null
  try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.v !== 1 || j.sig !== sig || j.data === undefined) return null; return j.data as T } catch { return null }
}

/** 递归求目录体积(字节);读不到就当 0,不抛。 */
export async function dirSize(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
  } catch { return 0 }
  let total = 0
  let entries: import('node:fs').Dirent[]
  try { entries = await fsp.readdir(p, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) total += await dirSize(join(p, e.name))
  return total
}

/** 引擎磁盘缓存(temp/_cache_*.json)明细。 */
export function cacheFiles(): { name: string; size: number }[] {
  const dir = cacheDir()
  const out: { name: string; size: number }[] = []
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('_cache_')) continue
    const p = join(dir, f)
    try { out.push({ name: f.replace(/^_cache_/, '').replace(/\.json$/, ''), size: statSync(p).size }) } catch { }
  }
  return out.sort((a, b) => b.size - a.size)
}

/** 数据根下 Electron/Chromium 缓存目录明细(含体积)。 */
export async function appCacheDirs(): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = []
  for (const name of APP_CACHE_DIRS) {
    const p = join(DATA_ROOT, name)
    if (!existsSync(p)) continue
    out.push({ name, size: await dirSize(p) })
  }
  return out.sort((a, b) => b.size - a.size)
}

export type ClearResult = {
  removed: number      // 删掉的文件/目录项数
  bytes: number        // 释放字节
  groups: { name: string; removed: number; bytes: number }[]
  failed: string[]     // 被占用/无权限而没删掉的路径
}

/**
 * 清理数据根(%APPDATA%\hoi4-toolkit)下的缓存。
 * scope='engine' 只清引擎磁盘缓存;scope='all'(默认) 连同 Electron/Chromium
 * 缓存目录一起清。设置与体检基线(gui-settings.json / tracker)永不触碰。
 *
 * ★ Chromium 主进程正在运行的窗口会锁住 Cache 下的部分文件 → 逐项容错删除,
 *   失败的记入 failed 并在 UI 提示"重启后再清一次",不做整目录硬删。
 */
export async function clearCache(scope: 'engine' | 'all' = 'all'): Promise<ClearResult> {
  const res: ClearResult = { removed: 0, bytes: 0, groups: [], failed: [] }

  // ① 引擎磁盘缓存 temp/_cache_*.json
  {
    let removed = 0, bytes = 0
    const dir = cacheDir()
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('_cache_')) continue
      const p = join(dir, f)
      try { bytes += statSync(p).size; rmSync(p); removed++ } catch (e) { res.failed.push(p) }
    }
    res.removed += removed; res.bytes += bytes
    res.groups.push({ name: '引擎构建缓存(temp)', removed, bytes })
  }

  // ② Electron/Chromium 缓存目录
  if (scope === 'all') {
    for (const name of APP_CACHE_DIRS) {
      const p = join(DATA_ROOT, name)
      if (!existsSync(p)) continue
      const size = await dirSize(p)
      try {
        rmSync(p, { recursive: true, force: true })
        res.removed++; res.bytes += size
        res.groups.push({ name, removed: 1, bytes: size })
      } catch (e) {
        // 目录整体删不掉(文件被占用)→ 逐文件尽力而为
        let n = 0, b = 0
        const walk = async (d: string) => {
          let es: import('node:fs').Dirent[]
          try { es = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
          for (const e of es) {
            const fp = join(d, e.name)
            if (e.isDirectory()) { await walk(fp); continue }
            try {
              b += (await fsp.stat(fp)).size
              await fsp.rm(fp, { force: true })
              n++
            } catch { res.failed.push(fp) }
          }
        }
        await walk(p)
        res.removed += n; res.bytes += b
        res.groups.push({ name, removed: n, bytes: b })
        try { await fsp.rmdir(p) } catch { /* 非空即仍有占用,留给下次 */ }
      }
    }
  }
  return res
}

/* ═══════════════════════════════════════════════════════════════
 * CLEANUP_V1(2026-10-18,优化11-后端侧):数据目录垃圾清理。
 *  GET /api/cache 在此基础上多报 junk 明细;POST scope 扩展为
 *  'engine' | 'all' | 'temp-expired' | 'tracker-stale' | 'cleanup'。
 * 与既有 clearCache 同一风格:逐项容错、失败记 failed,绝不硬删配置/活跃数据。
 * ═══════════════════════════════════════════════════════════════ */

/** 同步递归求目录体积(字节);读不到当 0,不抛。 */
function dirSizeSync(p: string): number {
  let st
  try { st = statSync(p) } catch { return 0 }
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let total = 0
  let entries: string[]
  try { entries = readdirSync(p) } catch { return 0 }
  for (const e of entries) total += dirSizeSync(join(p, e))
  return total
}

export interface JunkFile { name: string; size: number; mtimeMs: number }

/** temp 下"非 _cache_*.json"且 mtime 早于 now-maxAgeMs 的文件(过期垃圾)。
 *  crash-*.log / server-*.log / _cpu_probe.json 之类都在这里。正在写的活跃文件
 *  mtime 很新,不会被选中。 */
export function listTempJunk(maxAgeMs: number): JunkFile[] {
  const dir = cacheDir()
  const cutoff = Date.now() - maxAgeMs
  const out: JunkFile[] = []
  for (const f of readdirSync(dir)) {
    if (f.startsWith('_cache_')) continue
    const p = join(dir, f)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    if (st.mtimeMs < cutoff) out.push({ name: f, size: st.size, mtimeMs: st.mtimeMs })
  }
  return out.sort((a, b) => b.size - a.size)
}

/** 删 temp 下超过 maxAgeMs 未动的非缓存文件。 */
export function clearTempExpired(maxAgeMs: number): ClearResult {
  const res: ClearResult = { removed: 0, bytes: 0, groups: [], failed: [] }
  const dir = cacheDir()
  let removed = 0, bytes = 0
  for (const j of listTempJunk(maxAgeMs)) {
    try { bytes += j.size; rmSync(join(dir, j.name)); removed++ } catch (e) { res.failed.push(join(dir, j.name)) }
  }
  res.removed += removed; res.bytes += bytes
  res.groups.push({ name: 'temp 过期文件', removed, bytes })
  return res
}

export interface StaleBaseline { key: string; size: number }

/** tracker/baseline/<key> 里 key 不在 currentKeys 的过期基线目录。
 *  currentKeys 由 ROOTS 各路径 rootKey(path) 得来 —— 来源被卸载/删掉后,
 *  它的旧基线就成了僵尸,永远不会再被读到。 */
export function listTrackerStale(trackerDir: string, currentKeys: Set<string>): StaleBaseline[] {
  const base = join(trackerDir, 'tracker', 'baseline')
  if (!existsSync(base)) return []
  const out: StaleBaseline[] = []
  for (const k of readdirSync(base)) {
    if (currentKeys.has(k)) continue
    const p = join(base, k)
    try { if (!statSync(p).isDirectory()) continue } catch { continue }
    out.push({ key: k, size: dirSizeSync(p) })
  }
  return out.sort((a, b) => b.size - a.size)
}

/** 删 tracker 下不在当前来源列表里的过期 baseline 与对应 history。
 *  与 engine/src/tracker.ts 的 clearRoot 同语义(按 key 删 baseline+history),
 *  只是这里 key 来自磁盘枚举而非已知 path —— 过期基线的 path 已经不在 ROOTS 里了。 */
export function clearTrackerStale(trackerDir: string, currentKeys: Set<string>): ClearResult {
  const res: ClearResult = { removed: 0, bytes: 0, groups: [], failed: [] }
  let removed = 0, bytes = 0
  for (const st of listTrackerStale(trackerDir, currentKeys)) {
    const bd = join(trackerDir, 'tracker', 'baseline', st.key)
    const hd = join(trackerDir, 'tracker', 'history', st.key)
    try {
      rmSync(bd, { recursive: true, force: true })
      rmSync(hd, { recursive: true, force: true })
      removed++; bytes += st.size
    } catch { res.failed.push(bd) }
  }
  res.removed += removed; res.bytes += bytes
  res.groups.push({ name: 'tracker 过期基线', removed, bytes })
  return res
}
