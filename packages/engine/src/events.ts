/**
 * 事件模型(events/*.txt)。
 *
 * 文件结构(vanilla/KR 实测):
 *   add_namespace = my_namespace
 *
 *   country_event = {
 *     id = my_namespace.1
 *     title = my_namespace.1.t          ← 本地化 key
 *     desc  = my_namespace.1.d
 *     picture = GFX_report_event_xxx
 *     is_triggered_only = yes           ← 只能被脚本触发(不进事件池)
 *     fire_only_once = yes
 *     hidden = yes
 *     major = yes                        ← news_event 专有:是否头条
 *     trigger   = { ... }
 *     immediate = { ... }
 *     after     = { ... }
 *     option = {
 *       name = my_namespace.1.a
 *       ai_chance = { factor = 10 }
 *       trigger = { ... }
 *       <effects…>
 *     }
 *   }
 *
 * ★ 事件类型不止 country_event:news_event / unit_leader_event /
 *   operative_event / ace_event / division_event 都要认,否则 KR 里一大半事件会消失。
 *   判据统一为"顶层块名以 _event 结尾"。
 *
 * ★ option 里的"效果"没有固定键 —— 它就是这个 option 块里除
 *   name / ai_chance / trigger / highlight 之外的全部条目。所以摘要要按排除法收集,
 *   不能按白名单取。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnloadedByLaterReplacePath } from './assetsrc.ts'
import { type NormPath } from './modmeta.ts'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf, unquote } from '../../parser/src/serialize.ts'
import type { Block, Document, Entry } from '../../parser/src/ast.ts'

export interface EventRoot {
  name: string
  path: string
  writable?: boolean
  /** 该来源 .mod 里规范化后的 replace_path 列表(replace_path 卸载判定用) */
  replacePaths?: readonly NormPath[]
}

export interface EventOption {
  /** 本地化 key(option 名) */
  name: string
  aiChance: string
  hasTrigger: boolean
  originalRecipientOnly: boolean
  /** 效果摘要:option 块里除控制键之外的条目,上限 12 条 */
  effects: string[]
  effectCount: number
  line: number
  script: string
}

export interface EventNode {
  id: string
  /** country_event / news_event / … */
  type: string
  /** id 的前缀(第一个点之前)。没有点则为空 */
  namespace: string
  title: string
  desc: string
  picture: string
  isTriggeredOnly: boolean
  fireOnlyOnce: boolean
  hidden: boolean
  major: boolean
  trigger: string
  immediate: string
  after: string
  /** mean_time_to_happen 块原文(自动触发频率,MTTH) */
  meanTimeToHappen: string
  /** show_major 块原文(头条仅对满足国家显示) */
  showMajor: string
  /** fire_for_sender = no 时 false(头条不给发起者) */
  fireForSender: boolean
  /** timeout_days 值(选项自动选择倒计时) */
  timeoutDays: string
  /** minor_flavor = yes(小彩蛋事件,可关闭弹窗) */
  minorFlavor: boolean
  /** title / desc 为条件块(多条件本地化)时的原文 */
  titleCond: string
  descCond: string
  /** state_event 特有:trigger_for */
  triggerFor: string
  /** operative_event 特有:originator / recipient / set_root / set_from / set_from_from */
  originator: string
  recipient: string
  setRoot: string
  setFrom: string
  setFromFrom: string
  options: EventOption[]
  file: string
  line: number
  root: number
  rootName: string
  writable: boolean
  /** 覆盖链:后加载的 root 覆盖先加载的 */
  defs: { root: number; rootName: string; file: string; line: number }[]
  /** origin: 原版就有 / 模组新增 */
  origin: 'vanilla' | 'mod'
  overridden: boolean
}

export interface EventIndex {
  roots: EventRoot[]
  events: Map<string, EventNode>
  /** namespace → 事件列表(按 id 排序) */
  namespaces: Map<string, EventNode[]>
  files: { root: number; rootName: string; file: string; events: number }[]
  ms: number
}

function walk(dir: string, exts: string[]): string[] {
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
    if (st.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => it.toLowerCase().endsWith(e))) out.push(p)
  }
  return out
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase() && e.block) return e.block
  return undefined
}
function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) if (keyText(doc, e)?.toLowerCase() === key.toLowerCase()) return valueText(doc, e)
  return undefined
}
function yes(s: string | undefined): boolean {
  if (!s) return false
  const v = unquote(s).trim().toLowerCase()
  return v === 'yes' || v === 'true' || v === '1'
}

/* option 的控制键 —— 剩下的才当作"效果" */
const OPTION_CTRL = new Set(['name', 'ai_chance', 'trigger', 'highlight', 'default_hide', 'is_ai_only'])

/** 把脚本块渲染成可读文本(只读展示用,不参与无损改写) */
function scriptText(doc: Document, b: Block | undefined, depth = 0, cap = 200): string {
  if (!b) return ''
  const pad = '  '.repeat(depth)
  let n = 0
  const lines: string[] = []
  const one = (e: Entry): string => {
    const k = keyText(doc, e) ?? ''
    if (e.block) return pad + '  ' + k + ' = {\n' + scriptText(doc, e.block, depth + 1, cap) + '\n' + pad + '  }'
    return pad + '  ' + k + ' = ' + (valueText(doc, e) ?? '')
  }
  for (const e of b.entries) {
    if (n++ >= cap) { lines.push(pad + '  … (' + (b.entries.length - cap) + ' 条省略)'); break }
    lines.push(one(e))
  }
  return lines.join('\n')
}

function summarize(doc: Document, b: Block | undefined, cap = 12): string[] {
  if (!b) return []
  const out: string[] = []
  for (const e of b.entries) {
    if (out.length >= cap) break
    const k = keyText(doc, e) ?? ''
    out.push(e.block ? k + ' = { … }' : k + ' = ' + (valueText(doc, e) ?? ''))
  }
  return out
}

export function buildEventIndex(roots: EventRoot[]): EventIndex {
  const t0 = Date.now()
  const g: EventIndex = {
    roots,
    events: new Map(),
    namespaces: new Map(),
    files: [],
    ms: 0,
  }

  roots.forEach((r, ri) => {
    const dir = join(r.path, 'events')
    if (!existsSync(dir)) return
    for (const abs of walk(dir, ['.txt'])) {
      const file = relative(r.path, abs).replace(/\\/g, '/')
      // ★ REPLACE_PATH_V1:被更高优先级来源 replace_path 卸载的文件不加载(游戏规则)
      if (isUnloadedByLaterReplacePath(roots, ri, file)) continue
      let doc: Document
      try {
        doc = parse(readFileSync(abs, 'utf8'))
      } catch {
        continue
      }
      let n = 0
      for (const e of doc.root.entries) {
        const type = keyText(doc, e)
        if (!type || !e.block) continue
        const tl = type.toLowerCase()
        // ★ 顶层事件块:名字以 _event 结尾。add_namespace 之类的一律跳过
        if (!tl.endsWith('_event')) continue
        const eb = e.block
        let id = childValue(doc, eb, 'id')
        if (!id) {
          // 少数写法:id 写在块名上(country_event = { my_ns.1 = { ... } } 不常见),
          // 这里退化为"块名 + 行号",至少在列表里能看见并点开
          id = '__anon_' + file.replace(/[^\w]/g, '_') + '_' + lineOf(doc, e)
        }
        id = unquote(id).trim()
        const dot = id.indexOf('.')
        const ns = dot > 0 ? id.slice(0, dot) : ''
        const options: EventOption[] = []
        for (const oe of eb.entries) {
          const ok = keyText(doc, oe)
          if (!ok || ok.toLowerCase() !== 'option' || !oe.block) continue
          const ob = oe.block
          const effects: string[] = []
          for (const fe of ob.entries) {
            const fk = (keyText(doc, fe) ?? '').toLowerCase()
            if (OPTION_CTRL.has(fk)) continue
            effects.push(fe.block ? fk + ' = { … }' : fk + ' = ' + (valueText(doc, fe) ?? ''))
          }
          const ac = childBlock(doc, ob, 'ai_chance')
          options.push({
            name: unquote(childValue(doc, ob, 'name') ?? ''),
            aiChance: ac ? summarize(doc, ac, 4).join(' ') : '',
            hasTrigger: childBlock(doc, ob, 'trigger') !== undefined,
            originalRecipientOnly: yes(childValue(doc, ob, 'original_recipient_only')),
            effects: effects.slice(0, 12),
            effectCount: effects.length,
            line: lineOf(doc, oe),
            script: scriptText(doc, ob, 0, 120),
          })
        }
        const titleB = childBlock(doc, eb, 'title')
        const descB = childBlock(doc, eb, 'desc')
        const mttB = childBlock(doc, eb, 'mean_time_to_happen')
        const smB = childBlock(doc, eb, 'show_major')
        const node: EventNode = {
          id,
          type: tl,
          namespace: ns,
          title: titleB ? '' : unquote(childValue(doc, eb, 'title') ?? ''),
          desc: descB ? '' : unquote(childValue(doc, eb, 'desc') ?? ''),
          picture: unquote(childValue(doc, eb, 'picture') ?? ''),
          isTriggeredOnly: yes(childValue(doc, eb, 'is_triggered_only')),
          fireOnlyOnce: yes(childValue(doc, eb, 'fire_only_once')),
          hidden: yes(childValue(doc, eb, 'hidden')),
          major: yes(childValue(doc, eb, 'major')),
          trigger: scriptText(doc, childBlock(doc, eb, 'trigger'), 0, 60),
          immediate: scriptText(doc, childBlock(doc, eb, 'immediate'), 0, 60),
          after: scriptText(doc, childBlock(doc, eb, 'after'), 0, 60),
          meanTimeToHappen: mttB ? scriptText(doc, mttB, 0, 60) : '',
          showMajor: smB ? scriptText(doc, smB, 0, 60) : '',
          fireForSender: !/^\s*(no|false)\s*$/i.test(childValue(doc, eb, 'fire_for_sender') ?? ''),
          timeoutDays: unquote(childValue(doc, eb, 'timeout_days') ?? ''),
          minorFlavor: yes(childValue(doc, eb, 'minor_flavor')),
          titleCond: titleB ? scriptText(doc, titleB, 0, 80) : '',
          descCond: descB ? scriptText(doc, descB, 0, 80) : '',
          triggerFor: unquote(childValue(doc, eb, 'trigger_for') ?? ''),
          originator: unquote(childValue(doc, eb, 'originator') ?? ''),
          recipient: unquote(childValue(doc, eb, 'recipient') ?? ''),
          setRoot: unquote(childValue(doc, eb, 'set_root') ?? ''),
          setFrom: unquote(childValue(doc, eb, 'set_from') ?? ''),
          setFromFrom: unquote(childValue(doc, eb, 'set_from_from') ?? ''),
          options,
          file,
          line: lineOf(doc, e),
          root: ri,
          rootName: r.name,
          writable: !!r.writable,
          defs: [],
          origin: 'vanilla',
          overridden: false,
        }
        n++
        // 覆盖链:后加载的 root 覆盖先加载的(与工作台其它模块一致)
        const prev = g.events.get(id)
        const chain = prev ? prev.defs : []
        chain.push({ root: ri, rootName: r.name, file, line: node.line })
        node.defs = chain
        const firstRoot = chain[0].root
        node.origin = roots[firstRoot]?.writable === false ? 'vanilla' : 'mod'
        node.overridden = node.origin === 'vanilla' && ri !== firstRoot
        g.events.set(id, node)
      }
      if (n) g.files.push({ root: ri, rootName: r.name, file, events: n })
    }
  })

  for (const ev of g.events.values()) {
    const arr = g.namespaces.get(ev.namespace) ?? []
    arr.push(ev)
    g.namespaces.set(ev.namespace, arr)
  }
  for (const arr of g.namespaces.values()) arr.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))

  g.ms = Date.now() - t0
  return g
}
