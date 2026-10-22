/**
 * events / history / localisation 的定义提取规则
 *
 * 这些规则全部是「先统计真实文件的根级 key 分布,再写」得来的,不是凭印象。
 * 每一条规则上方标注了实测依据。
 *
 * 之所以独立成文件而非并入 indexer.ts:
 *   indexer.ts 当前被进程独占无法写入,等待解锁后合并到 DEF_RULES 即可。
 */

import type { Block, Document } from '../../parser/src/ast.ts'
import { keyText, lineOf, valueText, unquote } from '../../parser/src/serialize.ts'
import type { DefRule, Definition } from './indexer.ts'
import type { LocFileResult } from './loc.ts'

/* ───────── 局部工具(与 indexer.ts 同名函数保持一致) ───────── */

function childValue(doc: Document, block: Block, key: string): string | undefined {
  const e = block.entries.find((x) => keyText(doc, x) === key)
  return e ? valueText(doc, e) : undefined
}

/** 去引号 */
function unq(v: string | undefined): string | undefined {
  return v === undefined ? undefined : unquote(v)
}

/** 文件路径 → 文件名(去目录与扩展名) */
export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
}

/* ───────── events ───────── */

/**
 * 实测(vanilla events/,128 文件)根级 key 分布:
 *   country_event 6247 / news_event 677 / add_namespace 412
 *   unit_leader_event 33 / state_event 6 / operative_leader_event 7
 * 事件 id 形如 `denmark_political_events.1`,点是命名空间分隔符。
 */
export const EVENT_TYPES = [
  'country_event',
  'news_event',
  'unit_leader_event',
  'state_event',
  'operative_leader_event',
]

/** 从事件 id 取命名空间(最后一个点之前的部分) */
export function namespaceOf(id: string): string | undefined {
  const i = id.lastIndexOf('.')
  return i > 0 ? id.slice(0, i) : undefined
}

/* ───────── history ───────── */

/**
 * 实测(vanilla history/)结构:
 *   countries/*.txt —— 根级**没有包裹块**,直接是 effect 列表
 *     (recruit_character 3409 / set_variable 1739 / if 1090 / set_grand_doctrine 890 …)
 *     ⇒ 定义即「国家 TAG」,只能从文件名取:`AFG - Afghanistan.txt` → AFG
 *   states/*.txt —— 根级只有一个 key:`state`(1081 次),内含 id 与 name
 *   units/*.txt  —— 根级:division_template 586 / units 354 / instant_effect 329 / air_wings 179
 *     ⇒ 两个定义来源:division_template(name) 与 OOB 文件本身(文件名,如 AFG_1936)
 *   general/*.txt —— 实测整个文件被 `#` 注释掉,不产生定义
 */

/* ───────── 规则表 ───────── */

export const EXTRA_DEF_RULES: DefRule[] = [
  {
    kind: 'event',
    dir: /[\\/]events[\\/]/i,
    extract: (d, f) => {
      const out: Definition[] = []
      for (const e of d.root.entries) {
        const k = keyText(d, e)
        if (!k || !e.block || !EVENT_TYPES.includes(k)) continue
        const id = unq(childValue(d, e.block, 'id'))
        if (!id) continue
        out.push({ kind: 'event', id, file: f, line: lineOf(d, e), scope: namespaceOf(id) })
      }
      return out
    },
  },
  {
    kind: 'event_namespace',
    dir: /[\\/]events[\\/]/i,
    extract: (d, f) => {
      const out: Definition[] = []
      for (const e of d.root.entries) {
        if (keyText(d, e) !== 'add_namespace') continue
        const id = unq(valueText(d, e))
        if (id) out.push({ kind: 'event_namespace', id, file: f, line: lineOf(d, e) })
      }
      return out
    },
  },
  {
    kind: 'state',
    dir: /[\\/]history[\\/]states[\\/]/i,
    extract: (d, f) => {
      const out: Definition[] = []
      for (const e of d.root.entries) {
        if (keyText(d, e) !== 'state' || !e.block) continue
        const id = unq(childValue(d, e.block, 'id'))
        if (!id) continue
        const name = unq(childValue(d, e.block, 'name'))
        out.push({ kind: 'state', id, file: f, line: lineOf(d, e), scope: name })
      }
      return out
    },
  },
  {
    // 文件名即 TAG:`AFG - Afghanistan.txt` → AFG
    kind: 'country_history',
    dir: /[\\/]history[\\/]countries[\\/]/i,
    extract: (d, f) => {
      const tag = baseName(f).split(/\s+-\s+/)[0].trim()
      if (!tag) return []
      return [{ kind: 'country_history', id: tag, file: f, line: 1 }]
    },
  },
  {
    // division_template 是**文件内作用域**:每个 OOB 各自定义 "Infantry Division"
    // 之类通用名,跨文件重名是正常语义。故 scope = OOB 文件名,
    // 重复判定必须按 (oob, name) 而非全局 name。
    kind: 'division_template',
    dir: /[\\/]history[\\/]units[\\/]/i,
    extract: (d, f) => {
      const out: Definition[] = []
      const oob = baseName(f)
      for (const e of d.root.entries) {
        if (keyText(d, e) !== 'division_template' || !e.block) continue
        const name = unq(childValue(d, e.block, 'name'))
        if (name) out.push({ kind: 'division_template', id: name, file: f, line: lineOf(d, e), scope: oob })
      }
      return out
    },
  },
  {
    // OOB 文件本身是一个定义,被 country_history 的 set_oob / oob 引用
    kind: 'oob',
    dir: /[\\/]history[\\/]units[\\/]/i,
    extract: (d, f) => [{ kind: 'oob', id: baseName(f), file: f, line: 1 }],
  },
]

/** 与 indexer.ts 的 DEF_RULES 合并后的完整规则表 */
export function allDefRules(base: DefRule[]): DefRule[] {
  return [...base, ...EXTRA_DEF_RULES]
}

/* ───────── localisation ───────── */

/**
 * 实测(vanilla localisation/english):
 *   `l_english:` 头之后每行 ` KEY: "value"`,少数带序号 `KEY:0` / `KEY:1`
 *   (102814 条无序号、2094 条 :0、263 条 :1、14 条 :2)
 *   ⇒ 定义 = KEY(scope = 语言),序号不参与 id(同一 key 的 :0/:1 是多行文本)
 */
export function locDefinitions(results: LocFileResult[]): Definition[] {
  const out: Definition[] = []
  for (const r of results) {
    const lang = r.lang ?? 'unknown'
    for (const e of r.entries) {
      out.push({ kind: 'loc_key', id: e.key, file: e.file, line: e.line, scope: lang })
    }
  }
  return out
}

/* ───────── 跨文件引用:history/countries → OOB ───────── */

export interface Ref {
  kind: string
  id: string
  file: string
  line: number
  /** 引用的写法,如 set_oob / oob */
  via: string
}

/**
 * 实测两种写法并存:`set_oob = "AFG_1936"`(主流)与 `oob = "AFG_1939"`。
 *
 * 关键:set_oob **几乎总在 `if = { limit = { has_dlc = ... } }` 里**,不在根级。
 * 只扫根级会得到 0 条。必须递归全树。
 */
export function oobReferences(doc: Document, file: string): Ref[] {
  const out: Ref[] = []
  const visit = (b: Block) => {
    for (const e of b.entries) {
      const k = keyText(doc, e)
      if (k === 'set_oob' || k === 'oob') {
        const id = unq(valueText(doc, e))
        if (id) out.push({ kind: 'oob_ref', id, file, line: lineOf(doc, e), via: k })
      }
      if (e.block) visit(e.block)
    }
  }
  visit(doc.root)
  return out
}
