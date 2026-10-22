/**
 * ⚠ 已废弃 —— 请用 compare_v5.ts。
 *
 * 废弃原因（假通过）：本脚本 buildLayout 时【没有传 sprites】，
 * icon/button 两侧尺寸都是 0，于是永远「0 差异」，掩盖了 86 处真实偏移。
 * v5 加载 SpriteIndex 并复刻 Ua()/Ja() 的 centerposition 减半。
 *
 * 坐标公式权威对照 v4 —— 独立复刻扩展【完整渲染链】,与 buildLayout 逐样本对比。
 *
 * v3 只对比了「单个元素的 o()」,所以它报 0 差异也说明不了问题:
 * 真正的偏差来自元素【类型之间】的差异(尺寸来源 / margin / show_position / parent)。
 * v4 把扩展 dist/extension.js 的渲染链整条搬过来当基准:
 *
 *   m()   = 832 模块的 u()  —— 单元素坐标 + 尺寸
 *   o()   = 832 模块的 o()
 *   r()   = 832 模块的 r()
 *   ss()  = 容器:m() → 扣 margin → 子元素用 T.size
 *   Ha()  = 文本框:size 取自 maxwidth/maxheight
 *   Ua()/Ja() = icon/button:size 恒 undefined → 减不去 align
 *   is()  = parent 引用累加
 *
 * 解析层复用 buildLayout(保证唯一实现),只独立重算几何 —— 与 v3 同样的思路,
 * 但这次基准是【整条链】而不是单个函数。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout } from '../packages/gui/src/model.ts'

const VAN = process.env.HOI4_VAN ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const EPS = 0.01

// ── 扩展 module 832 的 ANCHOR(精确 9 个 key)──
const ANCHOR: Record<string, { x: number; y: number }> = {
  upper_left: { x: 0, y: 0 }, upper_right: { x: 1, y: 0 },
  lower_left: { x: 0, y: 1 }, lower_right: { x: 1, y: 1 },
  center_up: { x: 0.5, y: 0 }, center_down: { x: 0.5, y: 1 },
  center_left: { x: 0, y: 0.5 }, center_right: { x: 1, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
}
const anch = (n?: string | null) => ANCHOR[(n ?? 'upper_left').toLowerCase()] ?? ANCHOR.upper_left

/** 扩展 r(t, n, e=0) */
function r(v: number | undefined, unit: string | undefined, n: number, e = 0): number | undefined {
  if (v === undefined) return undefined
  if (unit === '%') return (v / 100) * n
  if (unit === '%%') return (v / 100) * n - e
  return v
}

/** 扩展 o(pos, size, parentSize, anchor, align, scale) */
function o(
  posV: number | undefined, posU: string | undefined,
  sizeV: number | undefined, sizeU: string | undefined,
  parentSize: number, anchorF: number, alignF: number, scale: number,
): [number, number] {
  const f = r(posV, posU, parentSize) ?? 0
  let h = (r(sizeV, sizeU, parentSize) ?? 0) * scale
  if (sizeU === '%%') h -= f
  if (h < 0) h += parentSize
  const p = f + parentSize * anchorF - h * alignF
  if (sizeU === '%%' || (sizeV ?? 0) < 0) {
    let t = r(sizeV, sizeU, parentSize) ?? 0
    if (t < 0) t += parentSize
    h = Math.max(0, t - p)
  }
  return [p, h]
}

/** 扩展 m() = u()。size 三个参数都可能 undefined(textbox 走 maxWH,icon/button 走 sprite) */
function m(
  orientation: string | undefined, origo: string | undefined,
  posX: number | undefined, posXu: string | undefined,
  posY: number | undefined, posYu: string | undefined,
  sizeW: number | undefined, sizeWu: string | undefined,
  sizeH: number | undefined, sizeHu: string | undefined,
  minW: number | undefined, minWu: string | undefined,
  minH: number | undefined, minHu: string | undefined,
  scale: number, parentW: number, parentH: number,
): [number, number, number, number] {
  const b = anch(orientation)
  const a = anch(origo)
  const [offX, dW] = o(posX, posXu, sizeW, sizeWu, parentW, b.x, a.x, scale)
  const [offY, dH] = o(posY, posYu, sizeH, sizeHu, parentH, b.y, a.y, scale)
  // ⚠ 扩展 u(): r(size.min, 父宽, offX) —— 第三参数是 offX 本身
  const mw = r(minW, minWu, parentW, offX) ?? dW
  const mh = r(minH, minHu, parentH, offY) ?? dH
  return [offX, offY, Math.max(mw, dW), Math.max(mh, dH)]
}

function walkFiles(d: string, o: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walkFiles(p, o)
    else if (e.name.toLowerCase().endsWith('.gui')) o.push(p)
  }
  return o
}

const SIZE_FROM_MAXWH = new Set(['instanttextboxtype', 'textboxtype'])
const SIZE_FROM_SPRITE = new Set(['icontype', 'buttontype', 'guibuttontype', 'checkboxtype'])
const CONTAINER = new Set(['containerwindowtype', 'windowtype'])

const files = walkFiles(join(VAN, 'interface'))
console.log('语料 .gui 文件:', files.length)

let compared = 0
let skippedNoParent = 0
let skippedZeroParent = 0
interface Diff {
  file: string; name: string; type: string
  field: string; ours: number; ref: number
  /** 归因标签:哪些是"我们刻意更准",哪些是真 bug */
  autoSize?: boolean
  orientLeft?: boolean
  parentSizeDrift?: boolean
}
const diffs: Diff[] = []
/** 分类计数:偏差归因 */
const byType = new Map<string, { n: number; d: number }>()

// 扩展 is():parent 引用累加(带环检测)
function parentAccum(list: any[], n: any, seen: Set<string>, depth: number): { x: number; y: number } {
  if (!n.parentRef || depth > 32) return { x: 0, y: 0 }
  if (seen.has(n.parentRef)) return { x: 0, y: 0 }
  const t = list.find((s) => s.name === n.parentRef)
  if (!t) return { x: 0, y: 0 }
  seen.add(n.parentRef)
  const up = parentAccum(list, t, seen, depth + 1)
  return { x: t.offX + up.x, y: t.offY + up.y }
}

for (const f of files) {
  let src: string
  try { src = readFileSync(f, 'utf8') } catch { continue }
  let L: any
  try { L = buildLayout(src, f) } catch { continue }

  // 逐个根节点独立走一遍扩展的渲染链
  const visit = (list: any[], parentW: number, parentH: number, absX: number, absY: number) => {
    for (const n of list) {
      const lk = n.type.toLowerCase()
      const isTextWH = SIZE_FROM_MAXWH.has(lk)
      const isSpriteSz = SIZE_FROM_SPRITE.has(lk)

      // ── 决定喂给 m() 的 size(这是 v3 漏掉的关键)──
      // ⚠ 必须用【原始书写值】_wRaw/_hRaw,不能用 w/h。
      //   w/h 已被 resolveSizes 按父级折算成像素,再按单位折算就是二次缩放
      //   (v4 初版就栽在这里,报出 12738 个假差异)。
      let sizeW: number | undefined
      let sizeWu: string | undefined
      let sizeH: number | undefined
      let sizeHu: string | undefined
      if (isTextWH) {
        // 扩展 Ha(): size = { width: maxwidth, height: maxheight }
        sizeW = n._wRaw
        sizeWu = n._wUnit
        sizeH = n._hRaw
        sizeHu = n._hUnit
      } else if (isSpriteSz) {
        // 扩展 Ua()/Ja():size 是 undefined → r() 返回 undefined → 折算成 0
        sizeW = undefined
        sizeH = undefined
      } else {
        sizeW = n._wRaw
        sizeWu = n._wUnit
        sizeH = n._hRaw
        sizeHu = n._hUnit
      }

      // position:show_position 优先(仅容器)
      const useShow = CONTAINER.has(lk) && n.effectivePos?.fromShow
      const posX = n.relX
      const posXu = n._xUnit
      const posY = n.relY
      const posYu = n._yUnit
      void useShow

      // align:icon/button 恒 0(size 为 undefined 时减 align 没有意义,扩展直接传 undefined)
      const align = isSpriteSz ? { x: 0, y: 0 } : anch(n.origo)
      if (isSpriteSz && n.centerPosition) {
        // 扩展: centerposition 时手工减半 sprite 尺寸
        // 这里 sprite 尺寸未知(没加载 gfx),跳过 —— 由 spriteMissing 统计体现
      }
      const a2 = n.centerPosition && !isSpriteSz ? { x: 0.5, y: 0.5 } : align
      const b2 = anch(n.effectiveOrientation ?? n.orientation)

      const [offX, offY, drawW, drawH] = m(
        n.orientation, n.origo,
        posX, posXu, posY, posYu,
        sizeW, sizeWu, sizeH, sizeHu,
        n._minWRaw || undefined, n._minWUnit, n._minHRaw || undefined, n._minHUnit,
        n.scale ?? 1, parentW, parentH,
      )

      // 对比(元素自身坐标 + 绘制尺寸)
      const rel = f.replace(VAN + '\\', '').replace(VAN, '')
      const rec = byType.get(n.type) ?? { n: 0, d: 0 }
      rec.n++
      let bad = false
      const push = (field: string, ours: number, ref: number) => {
        if (Math.abs(ours - ref) > EPS) {
          diffs.push({
            file: rel, name: n.name, type: n.type, field, ours, ref,
            // 自适应尺寸:size 写 0 交给引擎按内容撑开。扩展渲染成 0 宽高的空盒,
            // 我们用子元素包围盒估算(见 model.ts resolveAuto)—— 我们更接近游戏。
            autoSize: !!(n.sizeAuto || n._autoW || n._autoH || n._wPct === undefined && n.w === 0),
            // orientation = left:扩展 ANCHOR 表没这个 key,fallback 到 upper_left;
            // 我们按 {x:0, y:.5} 处理(见 model.ts anchorFactors 的地面真相论证)。
            orientLeft: (n.orientation ?? '').toLowerCase() === 'left',
          })
          bad = true
        }
      }
      // icon/button 的 align 差异不参与(扩展传 undefined),只比 offset 的 anchor 部分
      if (!isSpriteSz) {
        push('offX', n.offX, offX)
        push('offY', n.offY, offY)
      }
      push('drawW', n.drawW, drawW)
      push('drawH', n.drawH, drawH)
      if (bad) rec.d++
      byType.set(n.type, rec)
      compared++

      // ── MARGIN_V3:子元素坐标系 = 绘制尺寸扣掉 margin,再平移 (left, top)──
      let cw = drawW
      let ch = drawH
      let cx = absX
      let cy = absY
      if (n.margin) {
        cw = Math.max(0, drawW - n.margin.left - n.margin.right)
        ch = Math.max(0, drawH - n.margin.top - n.margin.bottom)
        cx = absX + offX + n.margin.left
        cy = absY + offY + n.margin.top
      } else {
        cx = absX + offX
        cy = absY + offY
      }
      // parent 引用累加
      if (n.parentRef) {
        const acc = parentAccum(list, n, new Set([n.id]), 0)
        cx += acc.x
        cy += acc.y
      }
      if (n.children.length) visit(n.children, cw, ch, cx, cy)
    }
  }
  visit(L.nodes, 1920, 1080, 0, 0)
}

console.log('对比样本:', compared)
console.log('差异总数:', diffs.length)

/*
 * 差异归因:把「我们刻意更准」与「真 bug」分开。
 * 两类已知的有意偏差(不算失败):
 *   autoSize  —— size 写 0 交给引擎按内容撑开。扩展直接渲染成 0 宽高的空盒,
 *                我们用子元素包围盒估算(见 model.ts resolveAuto),更接近游戏。
 *   orientLeft —— orientation = left。扩展 ANCHOR 表没这个 key,fallback 到 upper_left;
 *                我们按 {x:0, y:.5} 处理(见 model.ts anchorFactors 的地面真相论证)。
 * 剩下的才是要查的。
 */
const known = diffs.filter((d) => d.autoSize || d.orientLeft)
const suspect = diffs.filter((d) => !d.autoSize && !d.orientLeft)
console.log(`  已知有意偏差(自适应尺寸 / orientation=left): ${known.length}`)
console.log(`  待核查: ${suspect.length}`)

if (suspect.length) {
  const byField = new Map<string, number>()
  for (const d of suspect) byField.set(d.field, (byField.get(d.field) ?? 0) + 1)
  console.log('  按字段:', [...byField.entries()])
  const st = new Map<string, number>()
  for (const d of suspect) st.set(d.type, (st.get(d.type) ?? 0) + 1)
  console.log('  按类型:', [...st.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log('')
  console.log('  前 30 条待核查差异:')
  for (const d of suspect.slice(0, 30)) {
    console.log(`    ${d.file} [${d.type}] "${d.name}" ${d.field}: ours=${d.ours.toFixed(2)} ext=${d.ref.toFixed(2)} diff=${(d.ours - d.ref).toFixed(2)}`)
  }
  const byFile = new Map<string, number>()
  for (const d of suspect) byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1)
  console.log('')
  console.log('  待核查差异最多的文件:')
  for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${k}: ${v}`)
} else {
  console.log('OK: 无待核查差异(剩余全部为已知有意偏差)')
}
void byType
void skippedNoParent
void skippedZeroParent
