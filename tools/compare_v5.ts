/**
 * 坐标公式权威对照 v5 —— 在 v4 基础上补上【sprite 尺寸】与【centerposition 减半】。
 *
 * ★ 为什么必须 v5:
 *   v4 调用 buildLayout(src, file) 时【不传 sprites】,于是 icon/button 的
 *   n.w/n.h 恒为 0、扩展侧也是 0 —— 两边都是 0 就"0 差异"。
 *   可真实渲染(工作台加载了 .gfx)里图标是 94×94,
 *   SPRITE_SIZE_V4 的改动只在这一侧生效,v4 完全测不到。典型的假通过。
 *
 * ★ 权威依据(逐字摘自 chaofan.hoi4modutilities-0.18.1/dist/extension.js):
 *
 *   // iconType 渲染器 Ua();buttonType 渲染器 Ja() 与之逐字相同
 *   async function Ua(e, t, n) {
 *     const l = e.spritetype ?? e.quadtexturesprite
 *     const c = n.getSprite && l ? await n.getSprite(l, "icon", e.name) : void 0
 *     if (c === undefined) return ""                       // ← 没贴图就整个不渲染
 *     let [u, d] = m(e, t)                                 // m() = u();size 恒 undefined → draw=0
 *     if (e.centerposition) { u -= c.width / 2; d -= c.height / 2 }   // ★ 不乘 scale!
 *     const p = e.scale ?? 1
 *     return `<div style="left:${u}px;top:${d}px;width:${c.width*p}px;height:${c.height*p}px">…`
 *   }
 *
 *   // 单元素坐标 u()
 *   function u({orientation:t, origo:n, position:e, size:u, scale:a}, l) {
 *     const _ = t?._name ?? "upper_left"
 *     const g = l.size                                     // 父尺寸
 *     const b = i[_] ?? i.upper_left                       // anchor ← orientation
 *     const m = i[n?._name ?? "upper_left"] ?? i.upper_left// align  ← origo
 *     let [w,x] = o(e?.x, c(u), g.width,  b.x, m.x, a ?? 1)
 *     let [E,$] = o(e?.y, s(u), g.height, b.y, m.y, a ?? 1)
 *     const S = r(c(u?.min), g.width,  w) ?? x
 *     const j = r(s(u?.min), g.height, E) ?? $
 *     return [w, E, Math.max(S,x), Math.max(j,$), _]
 *   }
 *
 *   // schema(同文件 683992 起)证明 icon/button/textbox 根本没有 origo 与 size:
 *   Ea(iconType)  = {name, orientation, position, centerposition, spritetype, quadtexturesprite, frame, scale}
 *   xa(buttonType)= {name, parent, spritetype, quadtexturesprite, position, orientation, frame, text,
 *                    buttontext, buttonfont, scale, centerposition}
 *   Ta(instantTextBoxType) = {name, orientation, position, bordersize, maxwidth, maxheight,
 *                             format, font, text, vertical_alignment}
 *
 * 用法:
 *   node --experimental-strip-types compare_v5.ts            # 三个点名判例
 *   node --experimental-strip-types compare_v5.ts --all      # vanilla 全量
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLayout, refreshInlayNames, isInlayName } from '../packages/gui/src/model.ts'
import { SpriteIndex } from '../packages/gui/src/sprites.ts'

const VAN = process.env.HOI4_VAN ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const EPS = 0.01
const ALL = process.argv.includes('--all')

const ANCHOR: Record<string, { x: number; y: number }> = {
  upper_left: { x: 0, y: 0 }, upper_right: { x: 1, y: 0 },
  lower_left: { x: 0, y: 1 }, lower_right: { x: 1, y: 1 },
  center_up: { x: 0.5, y: 0 }, center_down: { x: 0.5, y: 1 },
  center_left: { x: 0, y: 0.5 }, center_right: { x: 1, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  // ── wiki 互通别名(与 model.ts ANCHOR_TABLE 保持一致)──
  center_lower: { x: 0.5, y: 1 },
  center_upper: { x: 0.5, y: 0 },
  left: { x: 0, y: 0.5 },
}
const anch = (n?: string | null) => ANCHOR[(n ?? 'upper_left').toLowerCase()] ?? ANCHOR.upper_left

/** 扩展 r(t, n, e=0) */
function r(v: number | undefined, unit: string | undefined, n: number, e = 0): number | undefined {
  if (v === undefined) return undefined
  if (unit === '%') return (v / 100) * n
  if (unit === '%%') return (v / 100) * n - e
  return v
}

/** 扩展 o(pos, size, parentSize, anchor, align, scale) → [off, draw] */
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

interface RefNode {
  offX: number; offY: number; drawW: number; drawH: number
  /** 扩展根本不渲染这个元素(贴图缺失) */
  notRendered?: boolean
}

/** 扩展 m() = u(),外加 Ua()/Ja() 的 centerposition 减半与 sprite 尺寸 */
function refGeom(
  n: any, parentW: number, parentH: number, spriteSize: { w: number; h: number } | null,
  depth: number,
): RefNode {
  const lk = String(n.type).toLowerCase()
  const isSpriteSz = SIZE_FROM_SPRITE.has(lk)
  const scale = n.scale ?? 1
  // ★ 真实游戏语义(有意偏离扩展预览的三处):
  //   ① 根级不强制 orientation=upper_left,用文件里写的真实 orientation
  //   ② 根级不把负 position 钳 0
  //   ③ 根级父容器恒为屏幕 1920×1080(不是"根容器自身声明尺寸")
  const isRootNode = depth === 0
  const oriName = n.orientation ?? 'upper_left'
  const b = anch(oriName)
  // 非根:align = origo ?? upper_left(逐字照扩展 u(),避免此前 align=orientation 的回归)
  // 根:origo 缺省时 = 自身 orientation(wiki:origo 未写默认等同 orientation)
  const a = n.origo ? anch(n.origo) : (isRootNode ? anch(oriName) : anch('upper_left'))
  const scaleArg = scale

  // 根级父容器 = 屏幕
  const pW = isRootNode ? 1920 : parentW
  const pH = isRootNode ? 1080 : parentH

  const sizeW = isSpriteSz ? undefined : n._wRaw
  const sizeWu = isSpriteSz ? undefined : n._wUnit
  const sizeH = isSpriteSz ? undefined : n._hRaw
  const sizeHu = isSpriteSz ? undefined : n._hUnit

  const hasX = n._xUnit === '%' || n._xUnit === '%%'
  const hasY = n._yUnit === '%' || n._yUnit === '%%'
  // ★ 负 position 不钳 0(真实游戏语义)
  const posX = hasX ? (pW * n.relX) / 100 : n.relX
  const posY = hasY ? (pH * n.relY) / 100 : n.relY

  let [offX, drawW] = o(posX, n._xUnit, sizeW, sizeWu, pW, b.x, a.x, scaleArg)
  let [offY, drawH] = o(posY, n._yUnit, sizeH, sizeHu, pH, b.y, a.y, scaleArg)
  const mw = r(n._minWRaw || undefined, n._minWUnit, pW, offX) ?? drawW
  const mh = r(n._minHRaw || undefined, n._minHUnit, pH, offY) ?? drawH
  drawW = Math.max(mw, drawW)
  drawH = Math.max(mh, drawH)

  if (isSpriteSz) {
    if (!spriteSize) return { offX, offY, drawW: 0, drawH: 0, notRendered: true }
    // ★ Ua()/Ja():centerposition 时【手工减半未缩放的 sprite 尺寸】
    if (n.centerPosition) {
      offX -= spriteSize.w / 2
      offY -= spriteSize.h / 2
    }
    drawW = spriteSize.w * scale
    drawH = spriteSize.h * scale
  }
  return { offX, offY, drawW, drawH }
}

const SIZE_FROM_MAXWH = new Set(['instanttextboxtype', 'textboxtype'])
const SIZE_FROM_SPRITE = new Set(['icontype', 'buttontype', 'guibuttontype', 'checkboxtype'])
const CONTAINER = new Set(['containerwindowtype', 'windowtype'])

function walkFiles(d: string, o: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walkFiles(p, o)
    else if (e.name.toLowerCase().endsWith('.gui')) o.push(p)
  }
  return o
}

// ── sprite 索引(必须加载,否则 icon/button 尺寸永远是 0,v4 就是栽在这)──
const sprites = new SpriteIndex(VAN)
sprites.scan([join(VAN, 'interface')])
console.log(`贴图索引: ${sprites.stats.sprites} 个 sprite / ${sprites.stats.files} 个 .gfx`)

// ★★★ INLAY_V4:必须加载 inlay 名单,否则被测物按屏幕语义算根窗口,
//   而扩展参照物按"根容器自身尺寸"算 —— 两边都错,3 个判例会假报 3 处根窗口差异。
//   加载后被测物按【槽位】语义算(inlay 组件根容器 offY=0),这才是游戏实况。
const inlayCount = refreshInlayNames([{ path: VAN }])
console.log(`inlay 名单: ${inlayCount} 条`)

const CASES = [
  'CZE_industry_focus_scripted_gui.gui',
  'GER_inner_circle_scripted_gui.gui',
  'JAP_imperial_influence_scripted_gui.gui',
]
const files = ALL
  ? walkFiles(join(VAN, 'interface'))
  : CASES.map((f) => join(VAN, 'interface', f)).filter((p) => { try { readFileSync(p); return true } catch { return false } })

console.log(`语料: ${files.length} 个 .gui${ALL ? '（全量）' : '（判例）'}\n`)

interface Diff {
  file: string; name: string; type: string
  field: string; ours: number; ref: number
  /** 归因:未实现的类型 / 刻意偏差 / 扩展的屏幕替换策略 */
  why: string
}
const diffs: Diff[] = []
/** 归因判定 —— 与扩展不一致不等于我们错,要分清三种情况 */
function whyOf(n: any, depth: number): string {
  const lk = String(n.type).toLowerCase()
  if (lk === 'gridboxtype') return 'gridbox 布局未实现'
  if (String(n.orientation ?? '').toLowerCase() === 'left') return 'orientation=left(刻意更准)'
  // ★★★ INLAY_V4:国策内嵌组件的根容器按【槽位】定位(offY=0),
  //   扩展却按 1920×1080 屏幕给它算贴屏底 —— 扩展对 inlay 组件的预览本就无意义
  //   (它会被画进国策树的 inlay 槽位,屏幕上不存在这个窗口)。
  //   三个点名判例(CZE/GER/JAP)全属此类,3 处根窗口 offY 差异是【预期修正】,非 bug。
  if (depth === 0 && isInlayName(n?.name)) return 'inlay 内嵌组件按槽位定位(刻意更准)'
  // ★★★ SCREEN_ROOT_V6(2026-10-04 用户判例 ger_inner_circle 复核后定稿):
  //   屏幕根窗口按【屏幕 1920×1080】定位 = 游戏实况(根窗口的父容器就是屏幕)。
  //   扩展 Nc() 用根容器自身声明尺寸当父尺寸,是它"一次只预览一个根窗口"的取巧。
  //   偏差可解析验证:Δ = anchor*(屏幕 - 自身尺寸)
  //     判例 acesview(orientation=center,1420×570):Δx=0.5*(1920-1420)=250 ✓ Δy=0.5*(1080-570)=255 ✓
  //   全量 358 处全是这一类,属【预期修正】,不是待查 bug。
  if (depth === 0) return '屏幕根窗口按 1920×1080 定位(刻意更准)'
  return '待核查'
}
let compared = 0
let notRendered = 0
let spriteMissing = 0

/** 容器扣 margin 后的子坐标系(扩展 ss()) */
function childBox(n: any, drawW: number, drawH: number): [number, number] {
  if (n.margin) {
    return [
      Math.max(0, drawW - n.margin.left - n.margin.right),
      Math.max(0, drawH - n.margin.top - n.margin.bottom),
    ]
  }
  return [drawW, drawH]
}

for (const f of files) {
  let src: string
  try { src = readFileSync(f, 'utf8') } catch { continue }
  let L: any
  try { L = buildLayout(src, f, sprites) } catch (e) { console.log('解析失败', f, e); continue }

  const visit = (list: any[], parentW: number, parentH: number, depth: number) => {
    for (const n of list) {
      const lk = String(n.type).toLowerCase()
      const sp = SIZE_FROM_SPRITE.has(lk) && n.sprite ? sprites.naturalSize(n.sprite) : null
      if (SIZE_FROM_SPRITE.has(lk) && n.sprite && !sp) spriteMissing++
      const ref = refGeom(n, parentW, parentH, sp, depth)
      if (ref.notRendered) { notRendered++; }

      const rel = f.replace(VAN + '\\', '').replace(VAN, '')
      const why = whyOf(n, depth)
      const push = (field: string, ours: number, r: number) => {
        if (Math.abs(ours - r) > EPS) diffs.push({ file: rel, name: n.name, type: n.type, field, ours, ref: r, why })
      }
      if (!ref.notRendered) {
        push('offX', n.offX, ref.offX)
        push('offY', n.offY, ref.offY)
        push('drawW', n.drawW, ref.drawW)
        push('drawH', n.drawH, ref.drawH)
      }
      compared++

      const [cw, ch] = childBox(n, ref.drawW, ref.drawH)
      if (n.children.length) visit(n.children, cw, ch, depth + 1)
    }
  }
  visit(L.nodes, 1920, 1080, 0)
}

console.log(`对比样本: ${compared}   扩展不渲染(贴图缺失): ${notRendered}   贴图查不到: ${spriteMissing}`)
console.log(`差异总数: ${diffs.length}`)

if (diffs.length) {
  const byWhy = new Map<string, number>()
  for (const d of diffs) byWhy.set(d.why, (byWhy.get(d.why) ?? 0) + 1)
  console.log('  归因:')
  for (const [k, v] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`)
  const byField = new Map<string, number>()
  for (const d of diffs) byField.set(d.field, (byField.get(d.field) ?? 0) + 1)
  console.log('  按字段:', [...byField.entries()].sort((a, b) => b[1] - a[1]))
  const byType = new Map<string, number>()
  for (const d of diffs) byType.set(d.type, (byType.get(d.type) ?? 0) + 1)
  console.log('  按类型:', [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  const byFile = new Map<string, number>()
  for (const d of diffs) byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1)
  console.log('\n  差异最多的文件:')
  for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${k}: ${v}`)
  console.log('\n  前 40 条:')
  for (const d of diffs.slice(0, 40)) {
    console.log(`    ${d.file} [${d.type}] "${d.name}" ${d.field}: ours=${d.ours.toFixed(2)} ext=${d.ref.toFixed(2)} Δ=${(d.ours - d.ref).toFixed(2)}  (${d.why})`)
  }
} else {
  console.log('OK: 与扩展逐样本一致')
}
void CONTAINER
