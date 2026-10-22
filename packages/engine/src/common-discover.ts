/**
 * common/ 未知目录自动发现器 —— "为新 DLC 添加扩展"的核心。
 *
 * 当 HOI4 出了新 DLC,common/ 里出现一个我们没有规则的新子目录时,不必读文档、
 * 不必猜:扫一遍真实文件就能推断出该目录的"形态(archetype)",生成候选规则。
 *
 * 推断依据(全部来自统计,不靠硬编码目录名):
 *  1. 根级键是否集中在少数几个键上
 *     - 集中(前 1~2 个键占 ≥55%)→ 这些键是"包裹键",root=[它们]
 *     - 分散                    → 文件根级就是定义列表,root='*'
 *  2. 块内是否普遍带 id/name 自述键(≥60%)→ idKey
 *  3. 孙层是否更像定义(孙层普遍带 id/name 且子层不带)→ depth=2
 *  4. 是否出现 icon/picture/small_icon 等键 → iconKeys
 *  5. 是否出现 name/desc/description → locKeys
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Document } from '../../parser/src/ast.ts'
import type { CommonRule } from './common-rules.ts'
import type { RootSpec } from './common-index.ts'

const ID_KEYS = ['id', 'name', 'key', 'tag', 'token']
const ICON_CANDIDATES = ['icon', 'picture', 'small_icon', 'map_icon', 'text_icon', 'sprite']
const LOC_CANDIDATES = ['name', 'desc', 'description', 'title']

interface Probe {
  dir: string
  files: number
  /** 根级键 → 次数 / 块次数 / 值次数 */
  rootKeys: Map<string, { n: number; block: number; value: number }>
  /** 根级键 → 子键频次 */
  subKeys: Map<string, Map<string, number>>
  /** 根级键 → 块内带自述 id 的次数 */
  selfId: Map<string, number>
  /** 根级键 → 孙块带自述 id 的次数 */
  grandId: Map<string, number>
  /** 全部子键频次(用于 icon/loc 判定) */
  allSub: Map<string, number>
  /** 是否有 @ 开头的根级键 */
  hasVar: boolean
  /** 解析不出任何条目,但文件确实有非空非注释行 → 纯行列表格式 */
  lineList: boolean
}

function walk(dir: string): string[] {
  const out: string[] = []
  let items: string[] = []
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }
  for (const it of items) {
    const p = join(dir, it)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) out.push(...walk(p))
    else if (it.toLowerCase().endsWith('.txt')) out.push(p)
  }
  return out
}

export function probeDir(roots: RootSpec[], dir: string): Probe | undefined {
  const p: Probe = {
    dir,
    files: 0,
    rootKeys: new Map(),
    subKeys: new Map(),
    selfId: new Map(),
    grandId: new Map(),
    allSub: new Map(),
    hasVar: false,
    lineList: false,
  }
  let any = false
  for (const r of roots) {
    const abs = join(r.path, 'common', dir)
    if (!existsSync(abs)) continue
    // dir 既可能是子目录,也可能是直接放在 common/ 下的散文件(如 weather.txt)
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs]
    for (const f of files) {
      const raw = readFileSync(f, 'utf8')
      let doc: Document
      try {
        doc = parse(raw)
      } catch {
        continue
      }
      any = true
      p.files++
      // 解析出 0 个条目但文件有实质内容 → 纯行列表(如 graphicalculturetype.txt)
      if (!doc.root.entries.length) {
        const meaningful = raw.split(/\r?\n/).filter((l) => l.replace(/#.*$/, '').trim()).length
        if (meaningful > 0) p.lineList = true
        continue
      }
      for (const e of doc.root.entries) {
        const k = keyText(doc, e)
        if (!k) continue
        if (k.startsWith('@')) p.hasVar = true
        const cur = p.rootKeys.get(k) ?? { n: 0, block: 0, value: 0 }
        cur.n++
        if (e.block) cur.block++
        else if (e.value >= 0) cur.value++
        p.rootKeys.set(k, cur)
        if (!e.block) continue

        let sub = p.subKeys.get(k)
        if (!sub) {
          sub = new Map()
          p.subKeys.set(k, sub)
        }
        let sid = false
        for (const c of e.block.entries) {
          const ck = keyText(doc, c)
          if (!ck) continue
          sub.set(ck, (sub.get(ck) ?? 0) + 1)
          p.allSub.set(ck, (p.allSub.get(ck) ?? 0) + 1)
          if (ID_KEYS.includes(ck.toLowerCase()) && c.value >= 0) sid = true
        }
        if (sid) p.selfId.set(k, (p.selfId.get(k) ?? 0) + 1)

        // 孙层
        let gid = false
        for (const c of e.block.entries) {
          if (!c.block) continue
          for (const g of c.block.entries) {
            const gk = keyText(doc, g)
            if (gk && ID_KEYS.includes(gk.toLowerCase()) && g.value >= 0) gid = true
          }
        }
        if (gid) p.grandId.set(k, (p.grandId.get(k) ?? 0) + 1)
      }
    }
  }
  return any ? p : undefined
}

/** 由探测结果推断候选规则;返回空数组表示"信息不足,无法自动判定" */
export function inferRules(p: Probe): CommonRule[] {
  const total = [...p.rootKeys.values()].reduce((a, b) => a + b.n, 0)

  // 纯行列表:直接给结论,后面的键统计都没意义
  if (p.lineList && !total) {
    return [
      {
        dir: p.dir,
        kind: p.dir.replace(/\.txt$/, '').replace(/s$/, ''),
        root: '*',
        depth: 1,
        lineList: true,
        note: '自动推断:纯行列表格式(每行一个 token,无 key=value)',
        source: 'user',
      },
    ]
  }
  if (!total) return []

  const sorted = [...p.rootKeys.entries()].sort((a, b) => b[1].n - a[1].n)
  const top1 = sorted[0]
  const share1 = top1[1].n / total
  const share2 = sorted.length > 1 ? (top1[1].n + sorted[1][1].n) / total : share1

  // 集中 → 有包裹键
  const wrapped = share1 >= 0.55 || (share2 >= 0.55 && sorted.length <= 3)
  const rootKeys = wrapped ? sorted.filter(([, v]) => v.n / total >= 0.2).map(([k]) => k) : []
  const root: string[] | '*' = wrapped ? rootKeys : '*'

  // id 来源:若块内普遍带自述 id → idKey
  const idKey = (() => {
    const pool = wrapped ? rootKeys : sorted.slice(0, 3).map(([k]) => k)
    let best: { key: string; rate: number } | undefined
    for (const k of ID_KEYS) {
      let hit = 0
      let tot = 0
      for (const rk of pool) {
        const sub = p.subKeys.get(rk)
        if (!sub) continue
        const c = sub.get(k) ?? 0
        hit += c
        tot += p.rootKeys.get(rk)?.block ?? 0
      }
      if (!tot) continue
      const rate = hit / tot
      if (rate >= 0.6 && (!best || rate > best.rate)) best = { key: k, rate }
    }
    return best?.key
  })()

  // depth:若没用 idKey,且孙层普遍带自述 id 而子层不带 → depth=2
  const depth: 1 | 2 = (() => {
    if (idKey) return 1
    const pool = wrapped ? rootKeys : sorted.slice(0, 3).map(([k]) => k)
    let self = 0
    let grand = 0
    let n = 0
    for (const rk of pool) {
      self += p.selfId.get(rk) ?? 0
      grand += p.grandId.get(rk) ?? 0
      n += p.rootKeys.get(rk)?.block ?? 0
    }
    if (!n) return 1
    return grand / n >= 0.5 && self / n < 0.5 ? 2 : 1
  })()

  const iconKeys = ICON_CANDIDATES.filter((k) => {
    const c = p.allSub.get(k) ?? 0
    return c >= 3 && c / Math.max(1, total) >= 0.05
  })
  const locKeys = LOC_CANDIDATES.filter((k) => {
    const c = p.allSub.get(k) ?? 0
    return c >= 3 && c / Math.max(1, total) >= 0.05
  })

  const rule: CommonRule = {
    dir: p.dir,
    kind: p.dir.replace(/s$/, ''),
    root,
    depth,
    note: `自动推断:根级${wrapped ? `包裹键 ${rootKeys.join('/')}` : '即定义列表'}(占比 ${(Math.max(share1, share2) * 100).toFixed(0)}%),${idKey ? `id 取自 ${idKey}` : 'id 取自键名'}`,
    source: 'user',
  }
  if (idKey) rule.idKey = idKey
  if (iconKeys.length) rule.iconKeys = iconKeys
  if (locKeys.length) rule.locKeys = locKeys
  if (p.hasVar) rule.skipKeyPrefix = ['@']

  return [rule]
}

/** 供 CLI 打印的探测摘要 */
export function describeProbe(p: Probe): string {
  const total = [...p.rootKeys.values()].reduce((a, b) => a + b.n, 0)
  const sorted = [...p.rootKeys.entries()].sort((a, b) => b[1].n - a[1].n)
  const top = sorted.slice(0, 3).map(([k, v]) => `${k}(${v.n})`).join(' ')
  return `${p.files} 文件 / ${p.rootKeys.size} 种根级键 / ${total} 条  · 高频: ${top}`
}
void valueText
