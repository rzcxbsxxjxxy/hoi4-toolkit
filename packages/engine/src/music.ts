/**
 * HOI4 音乐解析模块(2026-10-09)
 *
 * 游戏的音乐分两层:
 *   *.asset(music.asset / *_music.asset):定义歌曲 name + 音频 file + volume
 *   *.txt(_songs.txt / *_soundtrack.txt):定义广播台 music_station + 歌单 music={song, chance}
 * 音频 file 相对 asset 所在 music 目录解析(如 music/hoi2/hoi2_music.asset 的 file 在 music/hoi2/ 下)。
 *
 * 来源目录:
 *   root/music/ 下全部(含 hoi2 / hoi3 等 DLC 子目录)
 *   root/dlc 下各 DLC 的 music 目录(DLC 音乐包)
 *   模组 root/music/ 目录(模组音乐)
 *
 * rel = 音频相对 root 的路径(如 music/general_peace_1.ogg 或 dlc/dlc028/music/x.ogg),
 * 供 /api/music/audio 按已索引的 rel 安全定位(只服务本索引声明的音频,不做任意路径读取)。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname, relative } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'

export interface MusicSong {
  name: string // 歌曲逻辑名(也是本地化键)
  file: string // 音频绝对路径
  rel: string // 相对 root 路径(用于 /api/music/audio 索引)
  volume?: number
  source: string // root name
}
export interface MusicStation {
  name: string // music_station 名(base_music / classic / ...)
  songs: string[] // song name 列表(按歌单顺序)
}
export interface MusicIndex {
  songs: MusicSong[]
  byName: Map<string, MusicSong>
  byRel: Map<string, MusicSong>
  stations: MusicStation[]
  files: number
  ms: number
}

function listMusicDirs(root: string): string[] {
  const out: string[] = []
  const rm = join(root, 'music')
  if (existsSync(rm)) out.push(rm)
  const dlc = join(root, 'dlc')
  if (existsSync(dlc)) {
    let subs: string[] = []
    try { subs = readdirSync(dlc) } catch { /* 不可读忽略 */ }
    for (const s of subs) {
      const mm = join(dlc, s, 'music')
      if (existsSync(mm)) out.push(mm)
    }
  }
  return out
}

function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const rec = (d: string) => {
    let ents: string[] = []
    try { ents = readdirSync(d) } catch { return }
    for (const e of ents) {
      const p = join(d, e)
      let isDir = false
      try { isDir = statSync(p).isDirectory() } catch { continue }
      if (isDir) rec(p)
      else if (exts.includes(extname(p).toLowerCase())) out.push(p)
    }
  }
  rec(dir)
  return out
}

function parseSongAsset(root: { name: string; path: string }, f: string, byName: Map<string, MusicSong>): void {
  let doc
  try { doc = parse(readFileSync(f, 'utf8'), f) } catch { return }
  const baseDir = dirname(f)
  for (const e of doc.root.entries) {
    if (keyText(doc, e) !== 'music' || !e.block) continue
    let name: string | undefined
    let file: string | undefined
    let volume: number | undefined
    for (const c of e.block.entries) {
      const k = keyText(doc, c)
      if (k === 'name') name = valueText(doc, c)
      else if (k === 'file') file = valueText(doc, c)
      else if (k === 'volume') {
        const v = parseFloat(valueText(doc, c) ?? '')
        if (!Number.isNaN(v)) volume = v
      }
    }
    if (!name || !file) continue
    const abs = join(baseDir, file)
    if (!existsSync(abs)) continue
    const rel = relative(root.path, abs).replace(/\\/g, '/')
    byName.set(name, { name, file: abs, rel, volume, source: root.name })
  }
}

function parseStationTxt(root: { name: string; path: string }, f: string, stations: Map<string, MusicStation>): void {
  let doc
  try { doc = parse(readFileSync(f, 'utf8'), f) } catch { return }
  let station: MusicStation | null = null
  for (const e of doc.root.entries) {
    const k = keyText(doc, e)
    if (k === 'music_station') {
      const nm = valueText(doc, e)
      if (!nm) continue
      station = stations.get(nm) ?? { name: nm, songs: [] }
      stations.set(nm, station)
    } else if (k === 'music' && e.block && station) {
      let song: string | undefined
      for (const c of e.block.entries) {
        if (keyText(doc, c) === 'song') song = valueText(doc, c)
      }
      if (song) station.songs.push(song)
    }
  }
}

export function buildMusicIndex(roots: Array<{ name: string; path: string }>): MusicIndex {
  const t = Date.now()
  const byName = new Map<string, MusicSong>()
  const byRel = new Map<string, MusicSong>()
  const stations = new Map<string, MusicStation>()
  let files = 0
  for (const [ri, root] of roots.entries()) {
    for (const md of listMusicDirs(root.path)) {
      for (const f of walkFiles(md, ['.asset'])) {
        const rel = relative(root.path, f).replace(/\\/g, '/')
        // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
        if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
        parseSongAsset(root, f, byName); files++
      }
      for (const f of walkFiles(md, ['.txt'])) {
        const rel = relative(root.path, f).replace(/\\/g, '/')
        // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
        if (isUnloadedByLaterReplacePath(roots, ri, rel)) continue
        parseStationTxt(root, f, stations); files++
      }
    }
  }
  for (const s of byName.values()) if (!byRel.has(s.rel)) byRel.set(s.rel, s)
  return {
    songs: [...byName.values()],
    byName,
    byRel,
    stations: [...stations.values()],
    files,
    ms: Date.now() - t,
  }
}
