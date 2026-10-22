/**
 * 国策树体检。规则全部来自"这会在游戏里出什么毛病",而不是风格偏好。
 *
 * 最关键的一条是 overlap 的消歧:HOI4 的标准写法是把互斥分支放在**同一个坐标**,
 * 靠 available/互斥条件让游戏只显示其中一个。所以"两个国策坐标相同"本身不是 bug。
 * 只有同时满足"既不互斥、又无 offset 条件偏移、也不属于不同分支"时才真的会在
 * 游戏里叠成一团 —— 实测 448 棵树里 1389 处坐标重合,绝大多数是合法的互斥分支。
 */

import type { FocusGraph, FocusNode, FocusTree } from './model.ts'
import { treeNodes } from './model.ts'

export type Severity = 'error' | 'warn' | 'info'

export interface FocusIssue {
  severity: Severity
  rule: string
  tree: string
  /** 涉及的一到多个国策 id */
  ids: string[]
  message: string
  file?: string
  line?: number
}

export interface LintOptions {
  /** sprite 名 → 是否存在;传入则检查 icon 是否会在游戏里显示成空白 */
  hasSprite?: (name: string) => boolean
  /** 只检查这棵树 */
  tree?: string
}

export function lintFocus(g: FocusGraph, opts: LintOptions = {}): FocusIssue[] {
  const out: FocusIssue[] = []
  // 必须用 byId(最终生效版本),不能用 g.trees 的第一份 ——
  // 否则 vanilla 的节点列表会配上 mod 覆盖后的坐标,凭空造出不存在的重叠
  const trees: FocusTree[] = []
  for (const t of g.byId.values()) {
    if (opts.tree && t.id !== opts.tree) continue
    trees.push(t)
  }

  for (const t of trees) {
    const ns = treeNodes(g, t)
    const idx = new Map(ns.map((n) => [n.id, n]))

    /* ── 1. 坐标重叠 ── */
    const at = new Map<string, FocusNode[]>()
    for (const n of ns) {
      const k = `${n.ax},${n.ay}`
      const l = at.get(k) ?? []
      l.push(n)
      at.set(k, l)
    }
    for (const [, l] of at) {
      if (l.length < 2) continue
      // 两两之间都互斥 → 官方写法(靠条件只显示一个)
      const allMutex = l.every((a) => l.every((b) => a === b || a.mutex.includes(b.id) || b.mutex.includes(a.id)))
      // 有 offset 说明位置随 trigger 变化,静态求解不了,只能提示人工确认
      const anyOffset = l.some((n) => n.offset)
      if (allMutex) {
        out.push({
          severity: 'info',
          rule: 'overlap-mutex',
          tree: t.id,
          ids: l.map((x) => x.id),
          message: `(${l[0].ax},${l[0].ay}) 处 ${l.length} 个互斥分支共用坐标 —— 正常写法`,
          file: l[0].file,
          line: l[0].line,
        })
      } else if (anyOffset) {
        out.push({
          severity: 'warn',
          rule: 'overlap-conditional',
          tree: t.id,
          ids: l.map((x) => x.id),
          message: `(${l[0].ax},${l[0].ay}) 处 ${l.length} 个国策重合,其中含 offset 条件偏移 —— 需确认各 trigger 互斥: ${l
            .map((x) => x.id)
            .join(' / ')}`,
          file: l[0].file,
          line: l[0].line,
        })
      } else if (allDifferentTag(l)) {
        // 多个国家/派系共用一棵树(如 china_warlord_sea_focus),各自只看到自己的那一支,
        // 坐标天然重合 —— 靠 available 里的 tag 区分,不是 bug
        out.push({
          severity: 'info',
          rule: 'overlap-multitag',
          tree: t.id,
          ids: l.map((x) => x.id),
          message: `(${l[0].ax},${l[0].ay}) 处 ${l.length} 个不同派系的国策共用坐标 —— 共享树正常写法`,
          file: l[0].file,
          line: l[0].line,
        })
      } else {
        // 坐标被"别的树"的定义覆盖了 —— 模组改了共享国策的坐标,却影响了引用它的另一棵树
        const foreign = l.filter((x) => x.tree && x.tree !== t.id)
        const foreignNote = foreign.length
          ? ` —— 其中 ${foreign.map((x) => `${x.id}(坐标取自树 ${x.tree} 的定义)`).join('、')}`
          : ''
        out.push({
          severity: foreign.length ? 'warn' : 'error',
          rule: foreign.length ? 'overlap-crosstree' : 'overlap-hard',
          tree: t.id,
          ids: l.map((x) => x.id),
          message:
            `(${l[0].ax},${l[0].ay}) 处 ${l.length} 个国策重叠且不互斥 —— 游戏里会叠在一起: ` +
            `${l.map((x) => x.id).join(' / ')}${foreignNote}`,
          file: l[0].file,
          line: l[0].line,
        })
      }
    }

    /* ── 2. 孤立国策:既无前置也无后继 ── */
    const incoming = new Set<string>()
    for (const n of ns) for (const p of n.prereq) if (idx.has(p)) incoming.add(p)
    for (const n of ns) {
      // 前置不在本树(多半在 shared/joint 池里) → 信息不全,不判
      if (n.prereq.some((p) => !idx.has(p))) continue
      if (n.prereq.length || incoming.has(n.id) || n.mutex.length) continue
      out.push({
        severity: 'warn',
        rule: 'orphan',
        tree: t.id,
        ids: [n.id],
        message: `既无前置也无后继也无互斥 —— 玩家可能永远看不到(${n.id})`,
        file: n.file,
        line: n.line,
      })
    }

    /* ── 3. shared_focus 引用未解析 ── */
    for (const sid of t.shared) {
      if (!g.nodes.has(sid)) {
        out.push({
          severity: 'error',
          rule: 'shared-missing',
          tree: t.id,
          ids: [sid],
          message: `引用了 shared_focus ${sid},但没找到定义`,
          file: t.file,
          line: t.line,
        })
      }
    }

    /* ── 4. icon 在 .gfx 里不存在 → 游戏里是空白框 ── */
    if (opts.hasSprite) {
      for (const n of ns) {
        if (n.icon && !opts.hasSprite(n.icon)) {
          out.push({
            severity: 'error',
            rule: 'icon-missing',
            tree: t.id,
            ids: [n.id],
            message: `icon ${n.icon} 未在任何 .gfx 里定义 —— 游戏里显示为空白`,
            file: n.file,
            line: n.line,
          })
        }
      }
    }

    /* ── 5. 分支对称性:互斥声明应当是双向的 ── */
    for (const n of ns) {
      for (const m of n.mutex) {
        const o = idx.get(m)
        if (o && !o.mutex.includes(n.id)) {
          out.push({
            severity: 'warn',
            rule: 'mutex-onesided',
            tree: t.id,
            ids: [n.id, m],
            message: `${n.id} 声明与 ${m} 互斥,但 ${m} 没有反向声明`,
            file: n.file,
            line: n.line,
          })
        }
      }
    }
  }

  /* ── 全局级 ── */
  for (const d of g.danglingRel) {
    out.push({
      severity: 'error',
      rule: 'dangling-rel',
      tree: '',
      ids: [d.id],
      message: `relative_position_id 指向不存在: ${d.rel}(经 ${d.via.join(' → ')})`,
      file: d.file,
      line: d.line,
    })
  }
  for (const d of g.danglingLink) {
    out.push({
      severity: 'error',
      rule: 'dangling-link',
      tree: '',
      ids: [d.id],
      message: `${d.kind} 指向不存在的国策 ${d.target}`,
      file: d.file,
      line: d.line,
    })
  }
  for (const c of g.cycles) {
    out.push({
      severity: 'error',
      rule: 'rel-cycle',
      tree: '',
      ids: c,
      message: `relative_position_id 成环: ${c.join(' → ')}`,
    })
  }
  return out
}

/** id 前缀(第一个下划线前)= 国家/派系 tag。共享树里不同 tag 的国策坐标重合是正常的 */
function tagOf(id: string): string {
  const i = id.indexOf('_')
  return i > 0 ? id.slice(0, i) : ''
}

/** 是否所有 id 都分属不同派系 */
function allDifferentTag(l: FocusNode[]): boolean {
  const tags = new Set(l.map((n) => tagOf(n.id)))
  return tags.size === l.length && !tags.has('')
}

export function summarize(issues: FocusIssue[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const i of issues) m[i.rule] = (m[i.rule] ?? 0) + 1
  return m
}
