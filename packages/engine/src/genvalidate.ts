/**
 * 生成产物的语义校验 —— 取代原来那套"只看语法"的 round-trip 自检。
 *
 * ★ 为什么必须换掉旧的:
 *   旧 finalize() 只做 parse(),判据是"语法有没有错"。但 HOI4 里最常见的
 *   失效方式是**语法完全合法、语义游戏不认**:
 *     equipment = { my_eq = { ... } }   ← 顶层键少了 s,语法 100% 合法
 *     decision { effect { } }           ← effect 原版 0 处,语法 100% 合法
 *     ideas { my_ideas { id {} } }      ← 少 country 层,语法 100% 合法
 *   这三类错旧自检一个都抓不到,于是全部溜到了游戏里。
 *
 * 现在校验四类语义:
 *   ① 顶层块名   —— 必须出现在真实数据的 topKeys 里(focus_tree / equipments / ideas / …)
 *   ② 条目层键   —— 每个键必须在该类型的真实字段表里
 *   ③ 条件效果块 —— available/trigger/complete_effect 等块内的键必须在真实键白名单
 *   ④ 枚举取值   —— categories / type / group_by 等必须取真实值
 *
 * 判据来自 fieldstats.ts(实测扫描原版 + 模组),不是手写表,原版更新不会漂移。
 */

import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import type { FieldStats, GenKind } from './fieldstats.ts'

export type Severity = 'error' | 'warn'

export interface SemIssue {
  severity: Severity
  /** 出问题的文件 */
  path: string
  /** 出问题的键或位置描述 */
  where: string
  message: string
}

/** 条件/效果类块:块内的键要在"触发器/效果/修正器"白名单里 */
const SCRIPT_BLOCK_KEYS = new Set([
  'available',
  'allowed',
  'visible',
  'visible_when_empty',
  'allowed_civil_war',
  'trigger',
  'immediate',
  'complete_effect',
  'remove_effect',
  'hidden_effect',
  'timeout_effect',
  'cancel_trigger',
  'target_trigger',
  'modifier',
  'targeted_modifier',
  'completion_reward',
  'ai_will_do',
  'traits',
  'prerequisite',
  'bypass',
  'search_filters',
  'on_start',
  'on_research_complete',
  'on_remove',
  'cancel',
  'picture',
])

/**
 * 从真实数据里收"脚本块内允许的键"。
 * 这些键分布在 trigger / effect / modifier 等各种位置,单独统计一次。
 * 规则库(fieldstats)不覆盖 —— 所以这里按全库文本扫,建一张宽松白名单。
 */
export function buildScriptKeyWhitelist(stats: FieldStats): Set<string> {
  const set = new Set<string>(SCRIPT_BLOCK_KEYS)
  // 把所有类型条目层出现过的键并进来:
  // 触发器/效果键与结构键同表(如 has_war 只出现在 effect 里,不在条目层,
  // 但并进来只会让白名单更宽 —— 宁可放过也别误报)
  for (const k of Object.keys(stats.kinds)) {
    for (const f of stats.kinds[k].fields) set.add(f.key)
  }
  return set
}

/**
 * 递归收集块内所有键
 */
function keysIn(doc: Document, b: Block, out: Set<string>): void {
  for (const e of b.entries) {
    const k = keyText(doc, e)
    if (k) out.add(k)
    if (e.block) keysIn(doc, e.block, out)
  }
}

/**
 * ★ 哪些块才该查"块内键白名单"?
 * 只有**条件类/效果类**块:available / trigger / complete_effect / hidden_effect …
 * 不该查的:
 *   - country > modifier   —— 它装的是 { add = 1  tag = MY } 这类**树筛选器**,不是效果
 *   - completion_reward   —— 装的是 political_power / add_stability 等**奖励键**
 *   - folder>position     —— 装 x / y 坐标
 * 这几个误查会刷出大量假警(实测 add / stability_factor 都被误报)。
 */
const CHECK_INNER_KEYS = new Set([
  'available',
  'allowed',
  'visible',
  'visible_when_empty',
  'trigger',
  'immediate',
  'complete_effect',
  'remove_effect',
  'hidden_effect',
  'timeout_effect',
  'cancel_trigger',
  'target_trigger',
  'on_start',
  'on_research_complete',
  'on_remove',
])

/** 不查内层键、但要求是块的键(只校验它确实是块) */
const ONLY_MUST_BE_BLOCK = new Set([
  'completion_reward',
  'modifier',
  'targeted_modifier',
  'traits',
  'folder',
  'archetype',
])

function push(issues: SemIssue[], path: string, where: string, message: string, severity: Severity = 'error'): void {
  issues.push({ severity, path, where, message })
}

/**
 * 校验单个产物文件。
 * kind 为生成器类型;file 是 .txt 才查(yml 单独查编码与键形)。
 */
export function validateGenFile(
  path: string,
  content: string,
  kind: GenKind,
  stats: FieldStats,
  scriptKeys: Set<string>,
): SemIssue[] {
  const issues: SemIssue[] = []
  const ks = stats.kinds[kind]
  if (!ks) return issues

  // 本地化 yml:只查 BOM 与 key 形状
  if (path.endsWith('.yml')) {
    if (!content.startsWith('﻿')) push(issues, path, '文件头', '本地化文件缺 UTF-8 BOM,HOI4 读不出中文', 'warn')
    const body = content.replace(/^﻿/, '')
    if (!/^l_[a-z_]+:\s*$/m.test(body)) push(issues, path, '第 2 行', '缺少语言顶层键(如 l_english:)', 'error')
    for (const [i, ln] of body.split(/\r?\n/).entries()) {
      if (!ln.trim() || ln.trim() === body.split(/\r?\n/)[0].trim()) continue
      if (/^\s+[\w.\-]+(:\d+)?:\s*".*"\s*$/.test(ln)) continue
      if (/^l_[a-z_]+:\s*$/.test(ln.trim())) continue
      push(issues, path, `第 ${i + 2} 行`, `本地化条目格式可疑: ${ln.trim().slice(0, 50)}`, 'warn')
    }
    return issues
  }
  if (!path.endsWith('.txt')) return issues

  // ① 语法(旧自检保留,但降级为其中一项)
  let doc: Document
  try {
    doc = parse(content)
  } catch (e) {
    push(issues, path, '语法', `无法解析: ${String(e)}`)
    return issues
  }
  if (doc.errors.length) push(issues, path, '语法', `解析告警 ${doc.errors.length} 条: ${doc.errors[0]}`, 'warn')

  // ② 顶层块名
  const topEntries = doc.root.entries.filter((e) => keyText(doc, e))
  if (!topEntries.length) {
    push(issues, path, '顶层', '没有任何顶层键')
    return issues
  }
  /* 只对"顶层块名由游戏约定"的类型查表。
   * ✗ decision 的顶层块是**分类名**,完全自定义(my_cat / XXX_category),
   *   拿vanilla 的 49 个分类名去比对用户自己的分类 → 必然误报。
   * ✓ equipment 顶层必须是 equipments(复数),focus 必须是 focus_tree —— 这些查表才对。
   * ✓ event 顶层是 type 变量,也不查。 */
  const CHECK_TOP = kind === 'equipment' || kind === 'focus' || kind === 'idea' || kind === 'technology'
  if (CHECK_TOP && ks.topKeys.length) {
    for (const t of topEntries) {
      const tk = keyText(doc, t)!
      if (!ks.topKeys.includes(tk)) {
        push(
          issues,
          path,
          `顶层键 ${tk}`,
          `原版里没有这个顶层块。原版 ${kind} 实际用的是: ${ks.topKeys.slice(0, 4).join(' / ')}`,
        )
      }
    }
  }

  // ③ 定位条目层并查键
  const entryBlocks: { block: Block; label: string }[] = []
  for (const top of topEntries) {
    const tk = keyText(doc, top)!
    if (!top.block) continue
    if (kind === 'event') {
      entryBlocks.push({ block: top.block, label: `事件 ${tk}` })
    } else if (kind === 'decision') {
      for (const cat of top.block.entries) if (cat.block) entryBlocks.push({ block: cat.block, label: `决议 ${keyText(doc, cat)}` })
    } else if (kind === 'idea') {
      const country = top.block.entries.find((x) => keyText(doc, x) === 'country')
      if (!country?.block) {
        push(issues, path, `顶层 ${tk}`, 'ideas 下面缺country 层(原版是 ideas > country > <id>)')
        continue
      }
      for (const e of country.block.entries) if (e.block) entryBlocks.push({ block: e.block, label: `理念 ${keyText(doc, e)}` })
    } else {
      for (const e of top.block.entries) if (e.block) entryBlocks.push({ block: e.block, label: `${kind} 条目` })
    }
  }
  if (!entryBlocks.length) push(issues, path, '结构', '没找到任何条目块')

  const allowedFields = new Set(ks.fields.map((f) => f.key))
  const fieldMap = new Map(ks.fields.map((f) => [f.key, f]))
  for (const { block, label } of entryBlocks) {
    for (const e of block.entries) {
      const k = keyText(doc, e)
      if (!k) continue
      if (!allowedFields.has(k)) {
        const near = ks.fields
          .slice(0, 12)
          .map((f) => f.key)
          .join(' / ')
        push(issues, path, `${label} 的 ${k}`, `原版该层没有这个键。同层常见键: ${near}`)
      } else {
        /* ④b形态校验:键名对但形态错(键存在,可当块用却写成标量 / 反之)。
         * 实测历史 bug:`active = { block = no }` —— active 是合法键,
         * 但原版它**只做标量** yes/no(13 处),写成块游戏不认。
         * 这类错单靠"键在不在"抓不到,必须比形态。 */
        const st = fieldMap.get(k)!
        const isBlock = !!e.block
        if (isBlock && st.isBlock === false) {
          const hint = st.samples?.length ? `原版写法如 ${st.samples.join(' / ')}` : '原版里它只做标量'
          push(issues, path, `${label} 的 ${k}`, `形态不对:原版这个键是**标量**,不该写成块。${hint}`)
        } else if (!isBlock && st.isScalar === false) {
          push(issues, path, `${label} 的 ${k}`, '形态不对:原版这个键是**块**,不该写成单值')
        }
      }
      // ④ 脚本块内的键 → 白名单(只查条件/效果类,见 CHECK_INNER_KEYS 注释)
      if (e.block && CHECK_INNER_KEYS.has(k)) {
        const inner = new Set<string>()
        keysIn(doc, e.block, inner)
        for (const ik of inner) {
          if (!scriptKeys.has(ik)) {
            push(issues, path, `${label} > ${k} 内的 ${ik}`, `原版全库未见这个条件/效果键(可能拼错)`, 'warn')
          }
        }
      }
      // ⑤ 枚举取值
      if (e.block) {
        for (const ek of ['categories', 'type', 'group_by', 'interface_category']) {
          if (k !== ek) continue
          const known = ks.enums[ek]?.values
          if (!known || !known.length) continue
          for (const c of e.block.entries) {
            const v = keyText(doc, c) ?? valueText(doc, c)
            if (v && !known.includes(v)) {
              push(issues, path, `${label} > ${k} 的 ${v}`, `不在原版取值里。原版 ${ek} 常见: ${known.slice(0, 5).join(' / ')}`)
            }
          }
        }
      }
    }
  }

  // ⑥ 国策专属: country 带 tag 判定时 factor 必须为 0
  if (kind === 'focus') {
    for (const top of topEntries) {
      if (!top.block) continue
      const country = top.block.entries.find((x) => keyText(doc, x) === 'country')
      if (!country?.block) continue
      const factorE = country.block.entries.find((x) => keyText(doc, x) === 'factor')
      const modE = country.block.entries.find((x) => keyText(doc, x) === 'modifier')
      if (modE?.block) {
        const inner = new Set<string>()
        keysIn(doc, modE.block, inner)
        if (inner.has('tag') || inner.has('original_tag')) {
          const fv = factorE ? valueText(doc, factorE).trim() : ''
          if (fv !== '0') {
            push(
              issues,
              path,
              'focus_tree > country',
              `有 tag/original_tag 判定时 factor 必须是 0(当前 ${fv || '缺省'})。` +
                `写成 1 会让这棵树对所有国家可见。`,
            )
          }
        }
      }
    }
  }

  // ⑦ 本地化 key 引用:title/desc 指向的 loc key 是否在同批 yml 里
  return issues
}

/** 跨文件校验:生成的 loc key 是否被正确引用 */
export function crossValidate(files: { path: string; content: string }[], issues: SemIssue[]): void {
  const locKeys = new Set<string>()
  for (const f of files) {
    if (!f.path.endsWith('.yml')) continue
    for (const m of f.content.matchAll(/^\s+([\w.\-]+):/gm)) locKeys.add(m[1])
  }
  if (!locKeys.size) return
  for (const f of files) {
    if (!f.path.endsWith('.txt')) continue
    // 找 title = X / desc = X 这类"裸 loc key 引用"(事件/决议的惯例)
    for (const m of f.content.matchAll(/^\s+(title|desc)\s*=\s*([\w.\-]+)\s*$/gm)) {
      const ref = m[2]
      if (ref.startsWith('GFX_')) continue // 图标名不是 loc key
      if (!locKeys.has(ref)) {
        push(issues, f.path, `${m[1]} 引用 ${ref}`, '该本地化 key 在本次生成的 .yml 里不存在,游戏里会显示原始 key 名')
      }
    }
  }
}