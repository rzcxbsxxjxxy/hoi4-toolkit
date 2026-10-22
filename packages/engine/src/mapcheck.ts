/**
 * 地图一致性检查(mapcheck)—— 对齐 Wiki Troubleshooting 的「加载期崩溃」清单。
 *
 * 依据:temp/wiki-troubleshooting.md(Hearts of Iron 4 Wiki - Troubleshooting)。
 * 检查项:
 *   1. map/provinces.bmp:BM 签名 / DIB 头(必须 BITMAPINFOHEADER) / 宽高 256 整数倍 / ≤40MiB
 *   2. map/definition.csv:生效一份(挂载序最后者)、重复 id
 *   3. map/strategicregions/*.txt:region 重复 / 引用非法省 / 省无归属 / 省多归属
 *   4. history/states/*.txt:state 重复 / 引用非法省 / 省多 state / 无主 state /
 *      strategic_region 缺失 / victory_points 引用非法省
 *   5. map/supply_nodes.txt / map/railways.txt:省 id 合法性
 *   6. map/buildings.txt:沿海省无港口(error.log 原文会报 nudger 缺 port → 死循环崩溃)
 *
 * 每个 issue 带 files 归属(root),validate.ts 按 scope 过滤:
 * files 为空 = 全局/地图级问题,限定单模组时不报(那是 vanilla 的事)。
 */

import { openSync, readSync, closeSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseStateFileFull } from './mapmodel.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Document, Entry, Block } from '../../parser/src/ast.ts'

export interface MapCheckFileRef {
  root: string
  rel: string
  line?: number
}

export interface MapCheckIssue {
  kind: string
  severity: 'error' | 'warn'
  msg: string
  files: MapCheckFileRef[]
}

export interface MapCheckResult {
  issues: MapCheckIssue[]
  stats: { provinces: number; states: number; regions: number; bitmapOk: boolean }
}

interface RootSpec {
  name: string
  path: string
}

/** 截断展示条数(Wiki 类问题动辄几百个省,全列出来没有可读性) */
const TRUNC = 30

function listTxt(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt'))
  } catch {
    return []
  }
}

/** 递归收集块内所有标量 entry(不带块的) */
function walkScalars(b: Block, cb: (e: Entry) => void): void {
  for (const e of b.entries) {
    if (e.block) walkScalars(e.block, cb)
    else cb(e)
  }
}

/** 递归找 key 命中(小写)的标量整数值 */
function scalarInt(doc: Document, b: Block, k: string): number | undefined {
  let found: number | undefined
  walkScalars(b, (e) => {
    if (found !== undefined) return
    if (keyText(doc, e)?.toLowerCase() !== k) return
    const v = valueText(doc, e)?.trim()
    if (v && /^-?\d+$/.test(v)) found = parseInt(v, 10)
  })
  return found
}

/** 递归找 key 命中的子块 */
function childBlock(doc: Document, b: Block, k: string): Block | undefined {
  for (const e of b.entries) {
    if (!e.block) continue
    if (keyText(doc, e)?.toLowerCase() === k) return e.block
    const nested = childBlock(doc, e.block, k)
    if (nested) return nested
  }
  return undefined
}

/** 块内收集所有整数(标量值,不论有无键) */
function collectInts(doc: Document, b: Block): number[] {
  const out: number[] = []
  walkScalars(b, (e) => {
    const v = valueText(doc, e)?.trim()
    if (v && /^-?\d+$/.test(v)) out.push(parseInt(v, 10))
  })
  return out
}

export function runMapCheck(roots: RootSpec[]): MapCheckResult {
  const issues: MapCheckIssue[] = []
  let bitmapOk = true
  const bump = (kind: string, severity: 'error' | 'warn', msg: string, files: MapCheckFileRef[]) => {
    if (severity === 'error') bitmapOk = kind.startsWith('bmp') ? false : bitmapOk
    issues.push({ kind, severity, msg, files })
  }

  /* ── 3.1 位图检查 ── */
  for (const r of roots) {
    const abs = join(r.path, 'map/provinces.bmp')
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    let buf = Buffer.alloc(64)
    let fd: number | undefined
    try {
      fd = openSync(abs, 'r')
      readSync(fd, buf, 0, 64, 0)
    } catch {
      continue
    } finally {
      if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
    }
    const files: MapCheckFileRef[] = [{ root: r.name, rel: 'map/provinces.bmp' }]
    if (buf[0] !== 0x42 || buf[1] !== 0x4d) {
      bump('bmp-signature', 'error', 'provinces.bmp 文件头不是 "BM" —— 不是合法 BMP(Wiki:地图位图错误在主菜单加载期崩溃)', files)
      continue
    }
    const dibSize = buf.readInt32LE(14)
    if (dibSize === 124) {
      bump('bmp-dib', 'error', 'provinces.bmp 使用 BITMAPV5HEADER(DIB 头 124 字节)—— 游戏只接受 BITMAPINFOHEADER(40 字节)', files)
    }
    const w = Math.abs(buf.readInt32LE(18))
    const h = Math.abs(buf.readInt32LE(22))
    if (w % 256 !== 0 || h % 256 !== 0) {
      bump('bmp-size', 'error', `provinces.bmp 宽高(${w}×${h})不是 256 的整数倍(Wiki:主菜单加载期崩溃)`, files)
    }
    if (st.size > 40 * 1024 * 1024) {
      bump('bmp-size', 'error', `provinces.bmp 体积(${(st.size / 1024 / 1024).toFixed(1)} MiB)超过 40 MiB 上限(Wiki:主菜单加载期崩溃)`, files)
    }
  }

  /* ── 3.2 definition.csv(挂载序最后一份生效) ── */
  let defRoot: RootSpec | null = null
  for (const r of roots) {
    if (existsSync(join(r.path, 'map/definition.csv'))) defRoot = r
  }
  const provinceIds = new Set<number>()
  const coastalIds = new Set<number>()
  const landIds = new Set<number>()
  let maxProv = 0
  if (defRoot) {
    const abs = join(defRoot.path, 'map/definition.csv')
    const files: MapCheckFileRef[] = [{ root: defRoot.name, rel: 'map/definition.csv' }]
    const seenId = new Map<number, number>()
    let lineNo = 0
    for (const raw of readFileSync(abs, 'utf8').split(/\r?\n/)) {
      lineNo++
      const line = raw.trim()
      if (!line || line.includes('#')) continue
      const parts = line.split(';')
      if (!/^\d+$/.test((parts[0] || '').trim())) continue
      const id = parseInt(parts[0].trim(), 10)
      if (id <= 0) continue // 首行的占位省 0 不是真实省份,跳过
      const type = (parts[1] || '').trim().toLowerCase()
      if (parts.length < 4) {
        bump('def-line', 'warn', `definition.csv 第 ${lineNo} 行列数不足(${parts.length} 列):${line.slice(0, 60)}`, files)
        continue
      }
      if (seenId.has(id)) {
        bump('def-dup', 'error', `definition.csv 省份 id ${id} 重复定义第 ${lineNo} 行`, files)
      } else {
        seenId.set(id, lineNo)
      }
      provinceIds.add(id)
      if (id > maxProv) maxProv = id
      if (type.includes('coastal')) coastalIds.add(id)
      if (type !== 'sea') landIds.add(id)
    }
  }
  const hasDef = provinceIds.size > 0

  /* ── 3.3 strategic regions ── */
  const regionIds = new Set<number>()
  // ★ 多归属判定按来源隔离:模组(如 KR)用 replace_path 整体替换 strategicregions 后,
  //   同 id 的省在 vanilla 与模组里是不同的实体,合并统计会把「覆盖」误判成「一省多归属」
  //   (实测 vanilla+KR 13413 条假警报)。
  const regionOfByRoot = new Map<string, Map<number, number[]>>()
  // ★ 重复只在**同一来源内**报:跨来源同 id 是覆盖(replace_path / 后载覆盖先载),
  //   那是 replacePaths/gap 检查的职责,这里报就是全量噪音(实测 vanilla+KR 275 条)。
  const regionIdFiles = new Map<number, Map<string, MapCheckFileRef[]>>()
  for (const r of roots) {
    const dir = join(r.path, 'map/strategicregions')
    for (const name of listTxt(dir)) {
      const abs = join(dir, name)
      const rel = `map/strategicregions/${name}`
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      for (const e of doc.root.entries) {
        if (!e.block) continue
        if (keyText(doc, e)?.toLowerCase() !== 'strategic_region') continue
        const rid = scalarInt(doc, e.block, 'id')
        const provBlock = childBlock(doc, e.block, 'provinces')
        const provs = provBlock ? collectInts(doc, provBlock) : []
        if (rid !== undefined) {
          regionIds.add(rid)
          const byRoot = regionIdFiles.get(rid) ?? new Map<string, MapCheckFileRef[]>()
          const list = byRoot.get(r.name) ?? []
          list.push({ root: r.name, rel })
          byRoot.set(r.name, list)
          regionIdFiles.set(rid, byRoot)
        }
        for (const p of provs) {
          const rm = regionOfByRoot.get(r.name) ?? new Map<number, number[]>()
          const arr = rm.get(p) ?? []
          arr.push(rid ?? -1)
          rm.set(p, arr)
          regionOfByRoot.set(r.name, rm)
        }
        if (hasDef) {
          const bad = provs.filter((p) => !provinceIds.has(p))
          if (bad.length) {
            bump(
              'region-province-invalid',
              'error',
              `战略区 ${rid ?? '?'} 引用 ${bad.length} 个不在 definition.csv 的省份:${bad.slice(0, TRUNC).join('、')}${bad.length > TRUNC ? ` …共 ${bad.length} 个` : ''}`,
              [{ root: r.name, rel }],
            )
          }
        }
      }
    }
  }
  for (const [rid, byRoot] of regionIdFiles) {
    for (const [rname, files] of byRoot) {
      if (files.length > 1) {
        bump('region-dup', 'error', `战略区 id ${rid} 在来源 ${rname} 内被 ${files.length} 个文件重复定义`, files)
      }
    }
  }
  if (hasDef) {
    const covered = new Set<number>()
    for (const rm of regionOfByRoot.values()) for (const p of rm.keys()) covered.add(p)
    const noRegion: number[] = []
    for (const p of landIds) if (!covered.has(p)) noRegion.push(p)
    for (const p of coastalIds) if (!covered.has(p)) noRegion.push(p)
    if (noRegion.length) {
      bump(
        'province-no-region',
        'warn',
        `${noRegion.length} 个陆地/沿海省份没有归属任何战略区(Wiki:strategic regions 损坏 → 主菜单崩溃):${noRegion.slice(0, TRUNC).join('、')}${noRegion.length > TRUNC ? ` …共 ${noRegion.length} 个` : ''}`,
        [],
      )
    }
    const multi: string[] = []
    for (const rm of regionOfByRoot.values()) for (const [p, rids] of rm) {
      if (rids.length >= 2) multi.push(`${p}(属 ${rids.join('/')})`)
    }
    if (multi.length) {
      bump(
        'province-multi-region',
        'error',
        `${multi.length} 个省份同时归属多个战略区:${multi.slice(0, TRUNC).join('、')}${multi.length > TRUNC ? ` …共 ${multi.length} 个` : ''}`,
        [],
      )
    }
  }

  /* ── 3.4 states ── */
  let stateCount = 0
  // 同 regionIdFiles:重复只在同一来源内报(跨来源同 id = 覆盖,不算错)
  const stateIdFiles = new Map<number, Map<string, MapCheckFileRef[]>>()
  // ★ 同 regionOfByRoot:省份多 state 归属也按来源隔离(覆盖语义不是冲突)
  const stateOfByRoot = new Map<string, Map<number, number[]>>()
  for (const r of roots) {
    const dir = join(r.path, 'history/states')
    for (const name of listTxt(dir)) {
      const abs = join(dir, name)
      const rel = `history/states/${name}`
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      let st
      try {
        st = parseStateFileFull(name, text)
      } catch {
        continue
      }
      stateCount++
      const files: MapCheckFileRef[] = [{ root: r.name, rel }]
      if (Number.isFinite(st.id)) {
        const byRoot = stateIdFiles.get(st.id) ?? new Map<string, MapCheckFileRef[]>()
        const list = byRoot.get(r.name) ?? []
        list.push({ root: r.name, rel })
        byRoot.set(r.name, list)
        stateIdFiles.set(st.id, byRoot)
      }
      if (!st.owner) {
        bump('state-no-owner', 'warn', `state ${st.id}(${st.name || name})没有 owner 定义(Wiki:游戏中途操作该 state 会 CTD)`, files)
      }
      const srMatch = text.match(/(?:^|\n)\s*strategic_region\s*=\s*(-?\d+)/m)
      if (srMatch) {
        const srid = parseInt(srMatch[1], 10)
        if (regionIds.size && !regionIds.has(srid)) {
          bump('state-region-missing', 'warn', `state ${st.id} 引用的 strategic_region=${srid} 不存在`, files)
        }
      }
      if (hasDef) {
        const badProv = (st.provinces || []).filter((p: number) => !provinceIds.has(p))
        if (badProv.length) {
          bump(
            'state-province-invalid',
            'error',
            `state ${st.id}(${st.name || name})引用 ${badProv.length} 个不在 definition.csv 的省份:${badProv.slice(0, TRUNC).join('、')}${badProv.length > TRUNC ? ` …共 ${badProv.length} 个` : ''}`,
            files,
          )
        }
        for (const p of st.provinces || []) {
          const sm = stateOfByRoot.get(r.name) ?? new Map<number, number[]>()
          const arr = sm.get(p) ?? []
          arr.push(st.id)
          sm.set(p, arr)
          stateOfByRoot.set(r.name, sm)
        }
        const badVp = (st.victoryPoints || []).map((v: [number, number]) => v[0]).filter((p: number) => !provinceIds.has(p))
        if (badVp.length) {
          bump(
            'vp-province-invalid',
            'error',
            `state ${st.id}(${st.name || name})的 victory_points 引用 ${badVp.length} 个不存在的省份:${badVp.slice(0, TRUNC).join('、')}${badVp.length > TRUNC ? ` …共 ${badVp.length} 个` : ''}`,
            files,
          )
        }
      }
    }
  }
  for (const [sid, byRoot] of stateIdFiles) {
    for (const [rname, files] of byRoot) {
      if (files.length > 1) {
        bump('state-dup', 'error', `state id ${sid} 在来源 ${rname} 内被 ${files.length} 个文件重复定义`, files)
      }
    }
  }
  if (hasDef) {
    const multiState: string[] = []
    for (const sm of stateOfByRoot.values()) for (const [p, sids] of sm) {
      if (sids.length >= 2) multiState.push(`${p}(属 state ${[...new Set(sids)].join('/')})`)
    }
    if (multiState.length) {
      bump(
        'province-multi-state',
        'error',
        `${multiState.length} 个省份同时归属多个 state:${multiState.slice(0, TRUNC).join('、')}${multiState.length > TRUNC ? ` …共 ${multiState.length} 个` : ''}`,
        [],
      )
    }
  }

  /* ── 3.5 supply_nodes / railways ── */
  const collectMapNumbers = (doc: Document): number[] => {
    const out: number[] = []
    walkScalars(doc.root, (e) => {
      const key = keyText(doc, e)
      const v = valueText(doc, e)?.trim()
      if (!v || !/^-?\d+$/.test(v)) return
      const n = parseInt(v, 10)
      const kk = (key ?? '').toLowerCase()
      // 块内 id=/from=/to=、纯数值 entry、纯数字键(如 supply_nodes 里 `12345 = {...}`)
      if (e.key < 0 || kk === 'id' || kk === 'from' || kk === 'to' || (key !== undefined && /^\d+$/.test(key))) out.push(n)
    })
    return out
  }
  for (const [fname, kind] of [
    ['map/supply_nodes.txt', 'supply-province-invalid'],
    ['map/railways.txt', 'railway-province-invalid'],
  ] as const) {
    for (const r of roots) {
      const abs = join(r.path, fname)
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      let doc: Document
      try {
        doc = parse(text)
      } catch {
        continue
      }
      if (!hasDef) break
      const nums = [...new Set(collectMapNumbers(doc).filter((n) => n >= 1 && n <= maxProv))]
      const bad = nums.filter((n) => !provinceIds.has(n))
      if (bad.length) {
        bump(
          kind,
          'error',
          `${fname} 里 ${bad.length} 个省 id 不在 definition.csv(Wiki:选国家阶段崩溃):${bad.slice(0, TRUNC).join('、')}${bad.length > TRUNC ? ` …共 ${bad.length} 个` : ''}`,
          [{ root: r.name, rel: fname }],
        )
      }
    }
  }

  /* ── 3.6 buildings.txt 沿海省港口覆盖 ── */
  if (hasDef && coastalIds.size) {
    const built = new Set<number>()
    for (const r of roots) {
      const abs = join(r.path, 'map/buildings.txt')
      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      let doc: Document
      try {
        doc = parse(text)
      } catch {
        continue
      }
      walkScalars(doc.root, (e) => {
        if (keyText(doc, e)?.toLowerCase() !== 'id') return
        const v = valueText(doc, e)?.trim()
        if (v && /^\d+$/.test(v)) built.add(parseInt(v, 10))
      })
    }
    const missing: number[] = []
    for (const p of coastalIds) if (!built.has(p)) missing.push(p)
    if (missing.length) {
      bump(
        'port-missing',
        'warn',
        `${missing.length} 个沿海省在 buildings.txt 里没有港口定义(Wiki error.log 原文:"Province <N> is setup as coastal but has no port building in the nudger. This will likely crash the game."):${missing.slice(0, TRUNC).join('、')}${missing.length > TRUNC ? ` …共 ${missing.length} 个` : ''}`,
        [],
      )
    }
  }

  return {
    issues,
    stats: { provinces: provinceIds.size, states: stateCount, regions: regionIds.size, bitmapOk },
  }
}