/**
 * .gui → 可渲染布局树。
 *
 * 关键设计:每个节点除了几何信息,还持有它在 AST 中的 Entry 引用。
 * 这样拖拽产生的新坐标能直接定位回 token,做原地改写 —— 无损回写的前提。
 *
 * ── 相对位置机制(基准 = VSCode 扩展 chaofan.hoi4modutilities 0.18.1,勿凭 wiki 改)──
 *
 *  ⚠⚠⚠ 上一轮只复刻了「单个元素的坐标公式」,漏掉了扩展渲染链里【元素类型之间】的差异 ——
 *     那才是剩余位置偏差的真正来源。四条,按影响面排序:
 *
 *  A) TEXTBOX_SIZE_V3 —— instantTextBoxType / textBoxType 的尺寸**不在 size 块里**,
 *     扩展 Ha() 传的是 { ...e, size:{width:e.maxwidth, height:e.maxheight} }。
 *     实测 vanilla:instantTextBoxType 3525 个里写 size 的 **0** 个、写 maxWidth 的 3468 个;
 *     textBoxType 22 个同样全用 maxWidth;只有 editBoxType 103 个全用 size。
 *     之前按 size 解析 → 3490 个文本框尺寸全 0,而它们又是父级锚点尺寸的来源,
 *     误差沿树向下传播 —— 这是"整体仍偏"的头号原因。
 *     borderSize 在文本框里是 padding(扩展 padding: `${y}px ${x}px`),不参与尺寸。
 *
 *  B) ICON_BTN_SIZE_V3 —— iconType / buttonType 系同样**没有 size**:
 *     扩展 Ua()/Ja() 走 m(e,t),而 m() 里 size 为 undefined 时 r() 返回 undefined
 *     → 折算成 0,于是 offX = position.x + 父宽*anchor,**不减 align**
 *     (元素自身对齐点被完全跳过),绘制尺寸另取 sprite 的宽高 × scale。
 *     扩展随后对 centerposition 手工减半:`if (e.centerposition) u -= c.width/2`。
 *     实测 vanilla:6654 个 iconType 写 size 的 0 个、centerposition 604 个;
 *     2885 个 button 类里写 size 的仅 126 个。
 *     ⚠ 交叉印证:origo 在 vanilla 里 198 处全部落在 containerWindowType(190)
 *       与 extendedScrollbarType(8)上 —— 与扩展的类型化 schema 一致
 *       (Oa/Ca 有 origo,Ea/xa/Ta 没有)。origo 缺省只能是 0(左上角)。
 *
 *  C) MARGIN_V3 —— 容器 margin 同时做两件事,之前完全没实现。
 *     扩展 ss():```
 *       const E = [margin.top, margin.right, margin.bottom, margin.left]   // 按自身绘制尺寸折算
 *       const T = { size: { width : 绘制宽 - E[1] - E[3],      // left / right
 *                           height: 绘制高 - E[0] - E[2] },    // top  / bottom
 *                   orientation }
 *       // 子元素容器 div 额外写  left: E[3]px; top: E[0]px
 *     ```
 *     即 ① 子元素的父级尺寸 = 父【绘制尺寸】扣掉 margin(不是父声明尺寸!)
 *          ② 子元素整体再右下平移 (left, top)。
 *     实测 vanilla 257 处 margin,其中 containerWindowType 215 处 —— 影响面最大的一项。
 *
 *  D) SHOW_POSITION_V3 —— 扩展 ss() 第一行:
 *       `const h = n.useShowPosition && e.show_position ? e.show_position : e.position`
 *     useShowPosition 只在渲染【嵌套 containerWindowType】时为真(扩展 onRenderChild
 *     对 containerwindow 传 useShowPosition:true),根容器与普通元素均为 false。
 *     所以:**嵌套容器一旦写了 show_position,布局就按 show_position 算,position 被忽略**。
 *     实测 vanilla 148 处 show_position,其中 containerWindowType 101 处。
 *     这解释了 battleplantools.gui 那类 position 与 show_position 差 245px 的窗口整体错位。
 *
 *  ── 权威基准(扩展 dist/extension.js 里的 u()/o()/r(),已逐字核对)──
 *
 *      const ANCHOR = {upper_left:{0,0} upper_right:{1,0} lower_left:{0,1} lower_right:{1,1}
 *                      center_up:{.5,0} center_down:{.5,1} center_left:{0,.5}
 *                      center_right:{1,.5} center:{.5,.5}}          // 精确匹配 9 个 key
 *      function r(t, n, e=0) { if (t) switch (t._unit) {
 *          case '%' : return t._value/100 * n
 *          case '%%': return t._value/100 * n - e
 *          default  : return t._value } }
 *      function o(pos, size, parentSize, anchor, align, scale) {
 *        let f = r(pos, parentSize) ?? 0
 *        let h = (r(size, parentSize) ?? 0) * scale
 *        if (size?._unit === '%%') h -= f       // ① %% 尺寸减 position
 *        if (h < 0) h += parentSize              // ② 负尺寸向反方向延伸
 *        const p = f + parentSize*anchor - h*align
 *        if (size?._unit === '%%' || (size?._value ?? 0) < 0) {   // ③ 重算绘制宽
 *          let t = r(size, parentSize) ?? 0
 *          if (t < 0) t += parentSize
 *          h = Math.max(0, t - p)
 *        }
 *        return [p, h]
 *      }
 *      function u({orientation, origo, position, size, scale}, parent) {
 *        const anch  = ANCHOR[orientation ?? 'upper_left']   // 父级锚点
 *        const align = ANCHOR[origo      ?? 'upper_left']   // ★ 自身对齐点
 *        let [offX, drawW] = o(position?.x, size?.width,  parent.size.width,  anch.x, align.x, scale ?? 1)
 *        let [offY, drawH] = o(position?.y, size?.height, parent.size.height, anch.y, align.y, scale ?? 1)
 *        const minW = r(size?.min, parent.size.width,  offX) ?? drawW   // ★ 第三参数 = offX
 *        const minH = r(size?.min, parent.size.height, offY) ?? drawH
 *        return [offX, offY, Math.max(minW, drawW), Math.max(minH, drawH), orientation ?? 'upper_left']
 *      }
 *
 *  ⚠ size.min 写成 '%%' 时要减的是【自己的 offX】(u() 调 r(min, 父宽, offX)),
 *     不是常量 0。ALIGN_DEFAULT_V2 曾把 align 缺省写成 anchor,造成 93 个元素平移半个自身宽度。
 *
 *  1) orientation —— 父级参照点(锚点),同时决定「元素自身对齐点的缺省值」
 *  2) origo —— 元素自身的对齐点;未写时 = 【orientation 指定的那个角】(ALIGN_DEFAULT_REALGAME),
 *     即元素以 orientation 角对齐父级对应角(与 wiki"LOWER_RIGHT → 右下角"一致)。
 *     只有 icon/button 系(无 origo 字段)缺省恒 0,但其 axis 里 h=0 不影响 off。
 *  3) centerposition = yes —— 扩展对 icon/button 手工减半 sprite 尺寸 /2
 *
 *  ⚠ position.x / position.y 是【普通屏幕坐标系的带符号偏移】,不做镜像(实测结论,勿加反号):
 *     x 正 = 向右,y 正 = 向下 —— 与 orientation 无关。
 *     反证:vanilla 里 upper_right 有 401/438 个把 x 写成负数、lower_right 有 112/113 个,
 *     作者就是按「负 x = 从右缘往左退」写的;一旦镜像这些元素会被整体推到父框外。
 *
 *  ⚠⚠⚠ 尺寸与 position 的【单位】有三种 —— EXT_UNIT_V2
 *     ⚠ position 上的 '%%' 与 '%' 【数值相同】(o() 调 r(t,e) 只传两个参数,
 *       第三个"基准量"恒为 0),但仍要按单位折算,判据用 _xUnit 而非 _xPct。
 *     ⚠ 扩展的 ANCHOR 表没有 left/right/up/down,fallback 到 upper_left,
 *       vanilla 里 8 处 orientation = left 扩展算错、我们是对的(见 anchorFactors)。
 *
 *  orientation 是否继承?**不继承**(实测推翻 wiki 的笼统说法,见 resolvePositions 处注释)。
 *    子元素 position 永远相对父级【左上角】的局部坐标系。
 *
 * ── 真实语法要点(全部来自 vanilla 453 个 .gui 的全量扫描,勿凭印象改) ──
 *  1. @var:40/453 个文件在用,332 处定义、2467 处引用
 *  2. 百分比尺寸:size 内 63% 写成 `width = 100%` / `-100%`
 *  3. 自适应尺寸:`height = 0` 且带子元素 → 引擎按内容撑开
 *  4. 贴图引用不止 spriteType:quadTextureSprite 有 3867 处
 *  5. background.name 只是局部名,不是贴图引用
 *  6. borderSize(1104 处)才是真名,不是 border
 *  7. expandedWindow 内含子元素,自身不是元素,子元素要提升到宿主下
 *  8. parent = "name"(34 处,全在 guiButtonType)—— 扩展 is() 把被引用者的偏移
 *     【累加】到引用者上(带环检测),已实现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf, walk } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import type { SpriteIndex } from './sprites.ts'

/**
 * 可参与布局的元素类型(小写比较)。大小写混用是 vanilla 自己就有的
 * (instantTextboxType / instantTextBoxType、ButtonType / buttonType 并存)。
 *
 * 注:progressbartype / piecharttype / maskedshieldtype 等主要是 .gfx 里的
 * spriteTypes 名;作为 .gui 元素在 vanilla 中未出现,保留在此仅为兼容,无害。
 */
const ELEMENT_TYPES = new Set([
  'containerwindowtype',
  'windowtype',
  'icontype',
  'buttontype',
  'guibuttontype',
  'instanttextboxtype',
  'gridboxtype',
  'checkboxtype',
  'editboxtype',
  'scrollbartype',
  'extendedscrollbartype',
  'dropdownboxtype',
  'listboxtype',
  'smoothlistboxtype',
  'textboxtype',
  'positiontype',
  'overlappingelementsboxtype',
  'browsertype',
  'maskedshieldtype',
  'arrowtype',
  'piecharttype',
  'progressbartype',
  'circularprogressbartype',
  'linecharttype',
  /* legacy(wiki 列出但 vanilla 极少见): */
  'shieldtype',
  'eu3dialogtype',
])

/**
 * ⚠ TEXTBOX_SIZE_V3:尺寸来源与 icon/button 同族的元素类型。
 *
 * 扩展的 schema 是**按类型**声明字段的(dist/extension.js 里 Oa/Ea/Ta/xa/Ia…),
 * 各类型喂给 m() 的 size 并不相同:
 *   instantTextBoxType / textBoxType → size = { width: maxwidth, height: maxheight }
 *   editBoxType                       → 用元素自己的 size 块
 *   iconType / buttonType 系          → 没有 size,尺寸取 sprite
 * 之前对所有类型一律读 size 块,导致 3490 个文本框尺寸为 0。
 */
const SIZE_FROM_MAXWH = new Set(['instanttextboxtype', 'textboxtype'])

/**
 * ⚠ ICON_BTN_SIZE_V3:没有 size 块、绘制尺寸取 sprite 宽高的类型。
 * 这些元素在扩展里 m() 拿到的 size 是 undefined → 折算成 0,
 * 于是 offX = position.x + 父宽*anchor(不减 align),centerposition 由扩展手工减半 sprite/2。
 * 实测 vanilla:iconType 6654 个写 size 的 0 个;button 类 2885 个里仅 126 个写 size。
 */
const SIZE_FROM_SPRITE = new Set([
  'icontype', 'buttontype', 'guibuttontype', 'checkboxtype', 'shieldtype',
])

/**
 * ⚠ SHOW_POSITION_V3:扩展只对【嵌套】containerWindowType 启用 show_position
 * (onRenderChild 里对 containerwindow 传 useShowPosition:true)。
 * 根级容器与所有非容器元素都用 position。
 */
const CONTAINER_TYPES = new Set(['containerwindowtype', 'windowtype', 'eu3dialogtype'])

/**
 * 只作为属性存在、不是子元素的块(实测自 vanilla 453 个 .gui 的全量扫描)。
 *
 * 注意:原实现里的 'border' 在真实语法中根本不存在 —— 真名是 borderSize,
 * 结果 borderSize = { x= y= }(1104 处)既没被当属性也没被当元素,被静默丢弃。
 */
const PROP_BLOCKS = new Set([
  'background', 'background_margin', 'border', 'bordersize', 'cursor', 'drag_scroll',
  'expandbutton', 'hide_position', 'margin', 'max', 'max_slots', 'min', 'offset', 'padding',
  'pdx_tooltip_anchor', 'peek_check_size', 'peek_check_top_left', 'peek_position',
  'position', 'scrollbar', 'show_position', 'size', 'slotsize', 'tilesize', 'track',
  'slider', 'decreasebutton', 'increasebutton', 'closed_position', 'open_position',
  'bound_tooltip', 'verticalscrollbar', 'horizontalscrollbar',
])

/**
 * 自身不是元素、但内部含子元素的容器块 —— 子元素要提升到宿主元素下。
 * 实测:expandedWindow(43 处)内含 gridBoxType / positionType / instantTextboxType,
 * 若按属性块整块跳过,这些子元素会凭空消失。
 */
const CONTAINER_BLOCKS = new Set(['expandedwindow'])

/** HOI4 界面基准分辨率。根级元素的百分比尺寸 / 锚点按它折算(UI 布局都是按这个尺寸设计的) */
const BASE_W = 1920
const BASE_H = 1080

/**
 * ★★★ INLAY_V4:国策内嵌组件识别。
 *
 * 有一类 .gui 根容器【不是屏幕窗口】,而是国策树的"内嵌组件"(inlay component):
 * 由 common/focus_inlay_windows/<id>.txt 定义(内部 `window_name = <gui 根容器名>`),
 * 再由 common/national_focus/*.txt 的 `inlay_window = { id, position }` 摆到国策树的
 * 槽位上。它在屏幕上【没有对应窗口】,拿 1920×1080 当父容器定位必然出错。
 *
 * 识别方式:根容器名出现在某个 focus_inlay_windows/*.txt 的 window_name 里。
 * 名单在模块加载期从游戏目录扫一次(见 refreshInlayNames),扫不到就退化为
 * 「屏幕根窗口」语义 —— 即回到绝大多数窗口的正确行为,不会误伤。
 *
 * 实测 vanilla 6 个:cze_industry_focus_ui_window / ger_inner_circle_ui_window /
 * jap_imperial_influence_ui_window / sia_khana_ratsadon_ui_window /
 * ast_right_vs_left_campaign_ui_window / ast_right_vs_left_campaign_empty_ui_window。
 * 6 个根容器清一色 `orientation = lower_left position = {0,0}`
 * → 语义是"贴【自身槽位】左下角",而非贴屏幕左下角。
 */
const inlayWindowNames = new Set<string>()

/**
 * ★★★ INLAY_SLOT_V5:窗口名 → 国策树槽位坐标。
 *
 * 官方 documentation.md 原文:
 *   ```
 *   inlay_window = {
 *       id = inlay_window_id
 *       position = { x = XXX y = YYY }   # same syntax and scale as continuous focus position
 *   }
 *   ```
 * → inlay 组件摆在**国策树坐标系**里(和 continuous focus 同一套坐标),
 *   **不是**屏幕 1920×1080 坐标。vanilla 的 ger_inner_circle_inlay_window 位于
 *   `position = { x = 4500 y = 1150 }` —— 离屏很远。
 *
 * ★ 为什么必须扫国策文件:refreshInlayNames 只读 common/focus_inlay_windows/,
 *   那里只有 `window_name = xxx` 和 window→inlay_id 的对应,**没有坐标**;
 *   坐标在 common/national_focus/<tree>.txt 的 `inlay_window` 块里。
 *   要还原游戏里的真实位置,必须两边都读并按 inlay id 关联。
 */
const inlaySlots = new Map<string, { inlayId: string; x: number; y: number; tree: string; file: string; line: number }>()

/** 供 server 启动时调用:扫描游戏目录 common/focus_inlay_windows,建立 inlay 名单 */
export function refreshInlayNames (roots: { path: string; readOnly?: boolean }[]): number {
  inlayWindowNames.clear()
  inlaySlots.clear()
  let found = 0
  for (const r of roots) {
    // ① focus_inlay_windows/*.txt —— window_name → inlay id(只给名字,无坐标)
    /** @type {Map<string,string>} 窗口名 → inlay_window id */
    const win2id = new Map<string, string>()
    const dir = joinPath(r.path, 'common', 'focus_inlay_windows')
    let names: string[]
    try { names = readdirSync(dir) } catch { names = [] }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.txt')) continue
      let txt: string
      try { txt = readFileSync(joinPath(dir, n), 'utf8') } catch { continue }
      // window_name = xxx   (裸 id 或带引号)
      for (const m of txt.matchAll(/^\s*window_name\s*=\s*"?([A-Za-z0-9_.\-]+)"?\s*$/gm)) {
        inlayWindowNames.add(m[1])
        found++
        // 同一文件里的顶层块名 = inlay_window id(文件名去掉 _inlay_window 后缀)
        const iid = n.replace(/\.txt$/i, '')
        if (!win2id.has(m[1])) win2id.set(m[1], iid)
      }
    }
    // ② national_focus/*.txt —— inlay_window = { id position } 给真实槽位坐标
    for (const f of walkFocusFiles(joinPath(r.path, 'common', 'national_focus'))) {
      let txt: string
      try { txt = readFileSync(f, 'utf8') } catch { continue }
      const lines = txt.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*inlay_window\s*=\s*\{/.test(lines[i])) continue
        // 块体通常 3~4 行,直接扫到配对的 }
        let id = ''
        let px: number | undefined
        let py: number | undefined
        for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
          const ln = lines[j]
          if (/^\s*\}/.test(ln)) break
          const mi = /^\s*id\s*=\s*"?([A-Za-z0-9_.\-]+)"?\s*$/.exec(ln)
          if (mi) { id = mi[1]; continue }
          const mp = /^\s*position\s*=\s*\{([^}]*)\}/.exec(ln)
          if (mp) {
            const mx = /x\s*=\s*(-?[\d.]+)/.exec(mp[1])
            const my = /y\s*=\s*(-?[\d.]+)/.exec(mp[1])
            if (mx) px = Number(mx[1])
            if (my) py = Number(my[1])
          }
        }
        if (!id) continue
        // 把 inlay id 反查回窗口名(可能有多个窗口名指向同一 inlay,都记上)
        for (const [win, wid] of win2id) {
          if (wid !== id) continue
          inlaySlots.set(win, {
            inlayId: id, x: px ?? 0, y: py ?? 0,
            tree: f.split(/[\\/]/).pop() ?? f,
            file: f, line: i + 1,
          })
        }
        // 兜底:inlay id 本身就等于窗口名(vanilla 6 个里 5 个同名)
        if (![...win2id.values()].includes(id)) {
          inlaySlots.set(id, {
            inlayId: id, x: px ?? 0, y: py ?? 0,
            tree: f.split(/[\\/]/).pop() ?? f,
            file: f, line: i + 1,
          })
        }
      }
    }
  }
  return found
}

/** 递归列出目录下所有 .txt(只一层目录,国策文件都在顶层) */
function walkFocusFiles(dir: string): string[] {
  let ents: string[]
  try { ents = readdirSync(dir) } catch { return [] }
  return ents.filter((n) => n.toLowerCase().endsWith('.txt')).map((n) => joinPath(dir, n))
}

/** 该根容器在国策树里的槽位(仅 inlay 组件有) */
export function inlaySlotOf (name: string | undefined): { x: number; y: number; tree: string; file: string; line: number } | undefined {
  if (!name) return undefined
  const s = inlaySlots.get(name)
  return s ? { x: s.x, y: s.y, tree: s.tree, file: s.file, line: s.line } : undefined
}

/** 该根容器是否是国策内嵌组件 */
function isInlayComponent (n: GuiNode): boolean {
  return !!n.name && inlayWindowNames.has(n.name)
}

/** 该容器名是否在 inlay 名单里(供验收脚本 compare_v5 归因用) */
export function isInlayName (name: string | undefined): boolean {
  return !!name && inlayWindowNames.has(name)
}


/**
 * 把 orientation / origo 名解析成 0~1 的比例因子。
 *   0 = 左/上,0.5 = 居中,1 = 右/下
 * 实测取值:upper_left / upper_right / lower_left / lower_right / center /
 *   center_up / center_down / center_left / center_right / center_lower / left
 * (大小写混用,且可能带引号:orientation = "CENTER")
 */
function anchorFactors(name: string | undefined): { x: number; y: number } {
  const o = unquote(name).toLowerCase().trim()
  // ⚠ ANCHOR_EXACT_V5:【精确表】匹配,不再子串模糊(之前把 center_lower 算成 {0.5,1} 是错的)。
  //   表在下方 ANCHOR_TABLE,含 wiki 互通别名 center_lower/center_upper/left。
  //   vanilla 全量扫描只有 2 个非标准取值:center_lower(7 处)与 left(5 处),均已入表。
  return ANCHOR_TABLE[o] ?? { x: 0, y: 0 }
}

/**
 * 扩展 u() 用的锚点表。wiki《Interface modding》明确列出的 9 个 key 之外,
 * 还补充了 wiki 注明的互通别名:
 *   - center_lower ⇄ center_down(扩展/vanilla 里 center_lower 出现 7 次)
 *   - center_upper ⇄ center_up(手写时引擎同样认)
 *   - left ⇄ center_left(vertical 居中的「贴左边」;vanilla 5 处 orientation=left)
 * 之前把 center_lower 当未知 fallback 成 {0,0} 是错的 —— 会让 divisiondesignerview
 * 的 unit_icon 等跑到父容器外,且整个角落对齐语义错乱。
 */
const ANCHOR_TABLE: Record<string, { x: number; y: number }> = {
  upper_left: { x: 0, y: 0 },
  upper_right: { x: 1, y: 0 },
  lower_left: { x: 0, y: 1 },
  lower_right: { x: 1, y: 1 },
  center_up: { x: 0.5, y: 0 },
  center_down: { x: 0.5, y: 1 },
  center_left: { x: 0, y: 0.5 },
  center_right: { x: 1, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  // ── wiki 互通别名 ──
  center_lower: { x: 0.5, y: 1 },
  center_upper: { x: 0.5, y: 0 },
  left: { x: 0, y: 0.5 },
}


/**
 * 元素的"有效 orientation" = 自身显式值 ?? 兜底 upper_left。
 * 不继承父级 orientation:子元素 position 始终相对父级【左上角】的局部坐标系,
 * 见文件头注释的地面真相论证(mainmenu_panel_bottom 左对齐栈)。
 * 父级也没有时返回 undefined,由 anchorFactors 兜底为 upper_left。
 */
function effectiveOrientation(own: string | undefined, _parent: string | undefined): string | undefined {
  return own ?? undefined
}

/** 去掉标量值两侧可能带的引号(`orientation = "CENTER"`) */
function unquote(v: string | undefined): string {
  if (!v) return ''
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 扩展 r(t, n, e=0) 的前半(不减量版本):把原始书写值按单位折算成像素。
 *   ''  → 原值
 *   '%' → v/100 * 父尺寸
 *   '%%' → v/100 * 父尺寸   ← 减量那一步由调用方在 o() 里做(h -= f)
 * ⚠ '%%' 在 r() 里还要减去第三个参数(对 size 来说是 offX),但 o() 里
 *   先算 h 再减 f、最后又用 t 重算,所以这里只提供"不含减量"的基准值。
 */
function foldSize(v: number, unit: '' | '%' | '%%' | undefined, parentSize: number): number {
  if (unit === '%' || unit === '%%') return (v / 100) * parentSize
  return v
}

/** margin 的一个边:原始值 + 单位(扩展 f() 只在 '%' / '%%' 时才除 100) */
interface MarginVal {
  v: number
  unit: '' | '%' | '%%'
}

/** 附加 background 块(见 GuiNode.bgLayers)。几何值在 resolvePositions 里回填 */
export interface BgLayer {
  /** 贴图名(spriteType / sprite / quadTextureSprite) */
  sprite?: string
  /** position 原始像素值 */
  x: number
  y: number
  orientation?: string
  origo?: string
  centerPosition?: boolean
  scale: number
  /** 贴图天然尺寸(未缩放),sprite 解析阶段回填 */
  _spriteW?: number
  _spriteH?: number
  /** 相对容器的像素偏移(含锚点/对齐折算),resolvePositions 回填 */
  offX?: number
  offY?: number
  /** 绘制尺寸 = 贴图天然尺寸 × scale */
  drawW?: number
  drawH?: number
}

export interface GuiNode {
  id: string
  type: string
  name: string
  /** 文件里写的原始值;若 size 缺失,会在 sprite 解析后被替换为贴图尺寸 */
  relX: number
  relY: number
  w: number
  h: number
  /** 绝对坐标(渲染用),由父级累加得到 —— 含锚点与自身对齐点折算 */
  absX: number
  absY: number
  /**
   * 相对父级的最终像素偏移(= absX - 父级 absX)。渲染嵌套 DOM 时用这个,
   * 不能用 relX —— 后者没算 orientation 锚点,也没算 origo/centerposition。
   */
  offX: number
  offY: number
  /** 渲染尺寸(已含 scale 与尺寸推断) */
  drawW: number
  drawH: number
  scale: number
  /** 尺寸来自贴图推断而非文件显式声明 */
  sizeInferred: boolean
  /** 尺寸写成百分比(width = 100% / -100%),已按父级折算成像素 */
  sizePct?: boolean
  /** 尺寸写 0 由内容自适应(gridBoxType / containerWindowType 常见),已按子元素包围盒估算 */
  sizeAuto?: boolean
  /** 尺寸写 0 且无百分比 → 需按子级包围盒撑开 */
  _autoW?: boolean
  _autoH?: boolean
  /** 百分比尺寸的第二遍折算字段(折算后清掉) */
  _wPct?: number
  _hPct?: number
  /** position 写成百分比(`position = { x = 3% y = 2 }`,vanilla 有 9 处) */
  _xPct?: number
  _yPct?: number
  posPct?: boolean
  /** size.min —— 绘制尺寸下界(基准 max(size.min, size));0 = 未声明。百分比在 _minWPct */
  minW?: number
  minH?: number
  /** size.min 写成百分比时的比例,第二遍按父级折算后清掉 */
  _minWPct?: number
  _minHPct?: number
  /** ⚠ SHOW_POSITION_V3:嵌套容器实际生效的 position(优先 show_position)—— 回写/调试用 */
  effectivePos?: { x: number; y: number; fromShow: boolean }
  /** ⚠ MARGIN_V3:容器内边距(按自身绘制尺寸折算后的像素值),子元素坐标系要扣掉它 */
  margin?: { top: number; right: number; bottom: number; left: number }
  /** margin 的原始声明(单位未折算),每遍按最新绘制尺寸重算 */
  _marginSpec?: { top?: MarginVal; right?: MarginVal; bottom?: MarginVal; left?: MarginVal }
  /** ⚠ parent = "name" —— 引用同级的另一个元素,扩展 is() 把对方的偏移累加进来 */
  parentRef?: string
  /** parentRef 累加进来的偏移量(解析后回填) */
  _parentOffX?: number
  _parentOffY?: number
  /** ⚠ EXT_UNIT_V2:原始单位与符号,resolvePositions 复刻扩展 o() 时要用,折算后保留 */
  _wUnit?: '' | '%' | '%%'
  _hUnit?: '' | '%' | '%%'
  _xUnit?: '' | '%' | '%%'
  _yUnit?: '' | '%' | '%%'
  /** 尺寸写成负数(vanilla 76 处)—— 语义是"向反方向延伸",基准要 h += 父宽 */
  _wNeg?: boolean
  _hNeg?: boolean
  /**
   * ⚠ 尺寸的【原始书写值】(未按父级折算),供属性面板展示与独立复刻扩展 o() 时用。
   *   必须保留:_wPct 折算后会被 clearTemp 清掉,而 w 已经是像素,
   *   拿 w 再按 % 折算会二次缩放(对比脚本 v4 就踩过这个坑)。
   *   单位在 _wUnit/_hUnit 里。position 侧同理用 _xUnit/_yUnit + relX/relY(未折算)。
   */
  _wRaw?: number
  _hRaw?: number
  /** size.min 的原始单位(扩展 r(size.min, 父宽, offX) 要按单位折算,%/%% 减的是 offX) */
  _minWUnit?: '' | '%' | '%%'
  _minHUnit?: '' | '%' | '%%'
  _minWRaw?: number
  _minHRaw?: number
  /** 想推断但推断不出来(无贴图的 progressbartype 等)——界面上画占位虚线框 */
  sizeUnknown?: boolean
  posMissing: boolean
  /* ⚠ SPRITE_SIZE_V4:icon / button 系的绘制尺寸【只能来自 sprite】,不能走 axis()。
   * 这类元素没有 size 块,扩展给 o() 传 undefined → h=0 → off 正确(不减 align),
   * 但 draw 也是 0;真正的绘制宽高在渲染阶段另取 sprite 宽高 × scale。
   * 之前让 axis() 的 0 落到 drawW/drawH,于是 designer 里所有图标都是 0×0 的空框,
   * 判例:CZE_industry_focus_scripted_gui.gui 的 12 个 icon/button 全是 0×0。
   * 置位时 resolvePositions 里跳过 axis 的 draw,改用 n.w/n.h(sprite 尺寸)× scale。
   */
  _spriteSize?: boolean
  /* ⚠ CENTER_POS_V5:sprite 的【未缩放】原始尺寸。
   * 扩展 Ua()/Ja() 在 centerposition 时减的是 c.width/2 —— c 是 naturalSize,
   * **不乘 scale**(见 dist/extension.js:`u -= c.width/2`,而宽度用的是 c.width*p)。
   * 必须单独存一份:n.w/n.h 在 _wPct 分支里会被 drawW/scale 覆盖,不能拿来减半。 */
  _spriteW?: number
  _spriteH?: number
  /** orientation:父级参照点(锚点)。元素未显式写时**不继承父级的 orientation**,按 upper_left 处理 */
  orientation?: string
  /** 实际生效的 orientation = 自身值 ?? upper_left 兜底 */
  effectiveOrientation?: string
  /** origo:元素自身的对齐点。空值按左上角处理 */
  origo?: string
  /** centerposition = yes:position 指向元素中心,等价于 origo = center(优先级更高) */
  centerPosition?: boolean
  /** 自身对齐点折算成比例(由 origo / centerposition 得出),渲染时扣掉 */
  alignX: number
  alignY: number
  sprite?: string
  texturefile?: string
  bgSprite?: string
  /**
   * ★ BG_LAYERS_V1(2026-10-22):容器的【附加】background 块。
   *
   * vanilla 的容器可以写多个 background(实测 GER_inner_circle 根容器两个:
   * decor_bg 无 position + spotlight_overlay 有 position)。旧实现只读第一个,
   *   第二个整层丢失 —— 游戏里那层聚光灯带来的中心光晕就没了。
   * 规则:
   *   · 无 position 的第一个 background → 仍是容器自身 bgSprite(拉伸铺满);
   *   · 其余(含带 position 的第一个)→ bgLayers,按元素规则定位
   *     (orientation 锚点 + origo/centerposition 对齐 + 贴图天然尺寸 × scale)。
   * 渲染层由前端挂在容器 div 内、衬在子元素之下(z-index:0)。
   */
  bgLayers?: BgLayer[]
  props: Record<string, string>
  /** 块形态的属性(background / borderSize / margin / slotSize…),内层标量已按点号摊平 */
  propBlocks: Record<string, Record<string, string>>
  /** 几何值里来自 @var 的个数 —— 界面提示"由变量驱动",避免改了却看不到变化 */
  varRefs: number
  children: GuiNode[]
  depth: number
  parentId?: string
  line: number
  /** 引用的 sprite 在 .gfx 里找不到 —— 游戏里表现为空白/问号 */
  spriteMissing?: boolean
}

export interface Layout {
  file: string
  /** 原始文本 —— 回写后校验差异要用它做基准 */
  source: string
  doc: Document
  nodes: GuiNode[]
  flat: GuiNode[]
  byId: Map<string, GuiNode>
  /** id → AST entry,回写用 */
  entries: Map<string, { doc: Document; entry: Entry }>
  unresolved: { id: string; sprite: string }[]
  /** 文件内 @var 定义(小写索引)。vanilla 40/453 个 .gui 用到,332 处定义 / 2467 处引用 */
  vars: Map<string, number>
  canvasW: number
  canvasH: number
  /**
   * ★★★ INLAY_SLOT_V5:本文件根容器在国策树里的真实槽位。
   * 只有 inlay 内嵌组件有;普通屏幕窗口为 undefined。
   * 前端据此决定画布语义(见 designer.js 的 applyCanvasSemantics)。
   */
  inlay?: { x: number; y: number; tree: string; file: string; line: number }
  stats: { elements: number; maxDepth: number; withSprite: number }
}

interface Ctx {
  doc: Document
  sprites?: SpriteIndex
  /** 小写索引的 @var 表(两遍扫描的第一遍产出) */
  vars: Map<string, number>
  flat: GuiNode[]
  byId: Map<string, GuiNode>
  entries: Map<string, { doc: Document; entry: Entry }>
  unresolved: { id: string; sprite: string }[]
}

export function buildLayout(src: string, file: string, sprites?: SpriteIndex): Layout {
  const doc = parse(src)
  const ctx: Ctx = {
    doc,
    sprites,
    vars: collectVars(doc),
    flat: [],
    byId: new Map(),
    entries: new Map(),
    unresolved: [],
  }

  // 只从 guiTypes 块里取元素。.gui 根级还有 spriteTypes 等定义块,不能混进来
  const rootBlocks: Block[] = []
  for (const e of doc.root.entries) {
    const k = keyText(doc, e)
    if (!k || !e.block) continue
    if (k.toLowerCase() === 'guitypes') rootBlocks.push(e.block)
  }
  // 少数 .gui 直接把元素写在根级
  if (!rootBlocks.length) rootBlocks.push(doc.root)

  const nodes: GuiNode[] = []
  // id 必须带上根块序号:一个 .gui 里可能出现多个 guiTypes 块
  // (vanilla 的 widgets/equipmentcategoryfilterswidget.gui 就有 4 个),
  // 不区分的话 id 会撞车,改名会写到错误的节点上。
  rootBlocks.forEach((rb, r) => {
    const counters = new Map<string, number>()
    for (const e of rb.entries) {
      const k = keyText(doc, e)
      if (!k || !e.block) continue
      if (!ELEMENT_TYPES.has(k.toLowerCase())) continue
      const i = counters.get(k) ?? 0
      counters.set(k, i + 1)
      const node = buildNode(ctx, e, `r${r}/${k}:${i}`, 0, undefined)
      if (node) nodes.push(node)
    }
  })

  /**
   * 自顶向下解析百分比与自适应尺寸。
   *
   * 百分比:width = 100% 表示占满父级,-100% 同样占满但向反方向延伸(右/下锚定,
   * 常见于 gridBoxType 的自动布局),渲染时取绝对值。
   * 自适应:尺寸写 0 且带子元素时,引擎按内容撑开 —— 这里用子元素包围盒估算。
   *
   * 必须自顶向下:子级的 100% 依赖父级已解析出来的像素尺寸。
   *
   * 注意:这里只算尺寸不算坐标 —— 坐标依赖 drawW/drawH,而 drawW 还要等贴图
   * 推断那一遍(centerposition 的元素往往没有显式 size),故放到 resolvePositions,
   * 在贴图解析之后跑。
   */
  function resolveSizes(list: GuiNode[], parentW: number, parentH: number): void {
    for (const n of list) {
      if (n._wPct !== undefined) {
        n.w = parentW * n._wPct
        n.sizePct = true
      }
      if (n._hPct !== undefined) {
        n.h = parentH * n._hPct
        n.sizePct = true
      }
      // size.min 作下界(基准 max(size.min, size))。
      // ⚠ MIN_RAW_V3:扩展 u() 里是 `r(size.min, 父宽, offX)` —— '%%' 要减掉自己的 offX,
      //   所以必须用【原始值 + 单位】现算,不能只留一个比例:
      //     r(v, '%' , P, off) = v/100 * P
      //     r(v, '%%', P, off) = v/100 * P - off
      //   地面真相(countrytechtreeview.gui 的 techtree_stripes):
      //     size = { width = 1400 height = 1275  min = { width = 100%% height = 100%% } }
      //     父宽 1885、offX=0 → min 折算 = 1885,绘制宽取 max(1885, 1400) = 1885。
      //   之前把 min 的 100%% 当成 100% * 自身声明宽,得到 1400,整块窄了 485px。
      const mwPx = n._minWRaw
        ? foldSize(n._minWRaw, n._minWUnit, parentW) - (n._minWUnit === '%%' ? n.offX : 0)
        : (n.minW ?? 0)
      const mhPx = n._minHRaw
        ? foldSize(n._minHRaw, n._minHUnit, parentH) - (n._minHUnit === '%%' ? n.offY : 0)
        : (n.minH ?? 0)
      n.drawW = Math.max(mwPx, n.w * n.scale) // SIZE_MIN_V1
      n.drawH = Math.max(mhPx, n.h * n.scale)
      // ⚠ MARGIN_V3:子元素的父级尺寸 = 父【绘制尺寸】扣掉 margin,
      //   margin 的 % 按自身绘制尺寸折算(扩展 f(margin.top, b.height),b = 绘制尺寸)。
      //   与 resolvePositions 里传下去的一致,两处必须同源,否则子元素坐标会漂。
      let cw = n.drawW
      let ch = n.drawH
      if (n._marginSpec) {
        const m = resolveMargin(n._marginSpec, n.drawW, n.drawH)
        n.margin = m
        cw = Math.max(0, n.drawW - m.left - m.right)
        ch = Math.max(0, n.drawH - m.top - m.bottom)
      }
      for (const c of n.children) resolveSizes([c], cw, ch)
    }
  }

  /**
   * MARGIN_V3:margin 的 % / %% 按元素【自身绘制尺寸】折算。
   * 扩展 ss():\`const E = [f(margin.top, b.height), f(margin.right, b.width),
   *                        f(margin.bottom, b.height), f(margin.left, b.width)]\`
   * 其中 b = { width: drawW, height: drawH }。
   * 缺失的边按 0 处理(vanilla 里 \`margin = { top = 2 bottom = 2 }\\` 这种只写一半很常见)。
   */
  function resolveMargin(
    spec: { top?: MarginVal; right?: MarginVal; bottom?: MarginVal; left?: MarginVal },
    drawW: number,
    drawH: number,
  ): { top: number; right: number; bottom: number; left: number } {
    const one = (v: MarginVal | undefined, base: number): number => {
      if (v === undefined) return 0
      const n = v.v
      if (v.unit === '%') return (n / 100) * base
      if (v.unit === '%%') return (n / 100) * base
      return n
    }
    return {
      top: one(spec.top, drawH),
      right: one(spec.right, drawW),
      bottom: one(spec.bottom, drawH),
      left: one(spec.left, drawW),
    }
  }

  /**
   * 自顶向下把 position 折算成像素偏移(必须在 drawW/drawH 定型之后)。
   *
   *   offX = anchorX(orientation) * 父宽 + x - alignX(origo/centerposition) * 绘制宽
   *
   * 父级尺寸为 0(未知)时锚点退化成左上角,不会跳到屏幕外。
   * 百分比 position(x = 3%)按父宽折算。
   *
   * 子控件锚点 = 自身 orientation ?? upper_left(锚定父级【左上角】局部原点),
   * 不继承父级 orientation。HOI4 实测:子元素 position 是相对父级左上角的局部坐标,
   * 继承父级(CENTER / upper_right 等)会把子控件推到父级中心/边缘甚至框外
   * (pdx_int_logo / single_player 按钮应落在父框内或左上,继承则跑到框外/居中)。
   * 见文件头地面真相论证。
   *
   * ⚠⚠ 父级尺寸这里传的是【父的绘制尺寸 drawW/drawH】,不是声明尺寸 w/h,
   *   且要先扣掉 MARGIN_V3 的 margin —— 扩展 ss() 传给子元素的正是
   *   `{ size:{ width: drawW - left - right, height: drawH - top - bottom } }`。
   *   之前传 n.w / n.h(声明尺寸),遇到 % 尺寸 / size.min / scale 时就与扩展不一致。
   */
  function resolvePositions(
    list: GuiNode[],
    parentW: number,
    parentH: number,
    absX: number,
    absY: number,
    _parentOri?: string,
    isRoot = false,
    inlayMode = false,
  ): void {
    for (const n of list) {
      // ★ 真实游戏语义(对照 wiki《Interface modding》+ 三个点名判例):
      //   根窗口【不】强制 upper_left —— 扩展预览为单窗口方便才强制,属预览 hack 非游戏语义。
      //   三个判例(CZE/GER/JAP)根容器全是 `orientation = lower_left position = {0,0}`,
      //   游戏里落在屏幕【左下角】;强制 upper_left 会把它推到左上角(正是"位置错误"的真凶)。
      const isRootNode = isRoot && n.depth === 0
      const oriName = n.orientation ?? 'upper_left' // ORIENT_NO_INHERIT_FIX(根也用真实 orientation)
      n.effectiveOrientation = oriName
      const a = anchorFactors(oriName)
      // ★★ ALIGN_DEFAULT_V4(2026-10-05 终版,推翻前三轮摇摆):
      //   对齐点(origo)缺省 = upper_left,【与 orientation 无关】—— 根级也一样。
      //
      //   为什么不能用"根级 align = orientation"(上一轮的改动,已回退):
      //     · 那是把 wiki 的一句话当铁律,导致全量 vanilla 1511 个元素出屏;
      //     · 地面真相 pdx_online/online_accountcreate_simple.gui 的 content_window
      //       (position=(-350,-300)/700x700/orientation=center/无 origo):
      //       align=0 → offX=610,窗口 x∈[610,1310] 居中偏左 ✓;align=0.5 → 260 偏左 ✗。
      //     · achievements.gui 显式写 Origo=center,反证 vanilla 作者需要居中时自己会写。
      //   inlay 内嵌组件例外:它的 orientation 语义是"贴槽位哪一角",
      //   align 同样取 orientation(6 个组件统一 lower_left,{0,0},贴槽内左下)。
      let alX = 0
      let alY = 0
      if (n.origo) {
        const of = anchorFactors(n.origo)
        alX = of.x
        alY = of.y
      } else if (isRootNode && inlayMode) {
        const of = anchorFactors(oriName)
        alX = of.x
        alY = of.y
      }
      n.alignX = alX
      n.alignY = alY

      /* ═══ EXT_UNIT_V2:逐轴复刻扩展 832 模块的 o() ═══
       *
       * 基准原文(反混淆后):
       *   function o(pos, size, parentSize, anchor, align, scale) {
       *     let f = r(pos, parentSize) ?? 0                 // position 绝对值
       *     let h = (r(size, parentSize) ?? 0) * scale       // 绘制宽
       *     if (size?._unit === '%%') h -= f                // ① %% 减 position
       *     if (h < 0) h += parentSize                       // ② 负尺寸加父宽
       *     const p = f + parentSize * anchor - h * align    // offX
       *     if (size?._unit === '%%' || (size?._value ?? 0) < 0) {
       *       let t = r(size, parentSize) ?? 0
       *       if (t < 0) t += parentSize
       *       h = Math.max(0, t - p)                       // ③ 重算绘制宽
       *     }
       *     return [p, h]
       *   }
       *
       * ①②③ 是之前完全缺失的分支:vanilla 里 %% 尺寸 819 处、负尺寸 76 处,
       * 之前把 %% 当 % 解析(丢掉单位)、把负尺寸取绝对值,这些元素全部错位。
       *
       * ⚠⚠⚠ 关键:o() 是【一次性】从「原始书写值 + 父尺寸」算出 off 与 draw 的,
       *   中间没有"先把尺寸折算成像素"的独立步骤。我们早期实现分成
       *   resolveSizes(折算尺寸) + resolvePositions(算坐标)两步,
       *   于是 '%%' 语义在第一步就丢了 —— 第一步只会算 parentH * 1.0,
       *   完全不知道要减掉自身 position。
       *   地面真相(chat.gui):
       *     chat_window(根): position y=-349, size height=100%%, orientation=lower_left
       *       扩展:h = 100/100*1080 = 1080;h -= f(-349) → 1429
       *            p = -349 + 1080*1 = 731
       *            %% 分支:t = 1080 → h = max(0, 1080-731) = 349
       *       语义 = 「从屏幕底边往上 349px 处,向上占满到屏幕顶」→ 真实高度 349。
       *       我们两步走时第一步给 drawH=1080,%% 分支算成 max(0,1080-731)=349 也对,
       *       但它的【子元素】再按 1080 折算就全错了(chat_panel 应是 349,拿到 1080)。
       *   所以下面这版直接吃原始值,不再依赖预折算结果。
       */
      const axis = (
        posAbs: number,
        rawSize: number | undefined,
        sizeUnit: '' | '%' | '%%' | undefined,
        sizeNeg: boolean | undefined,
        parentSize: number,
        anchorF: number,
        alignF: number,
        scale: number,
      ): { off: number; draw: number } => {
        // f = r(position, 父尺寸)。position 上的 % 与 %% 数值相同
        // (扩展 r() 的第三个参数在 position 上恒为 0),所以调用方直接传折算后的绝对值。
        const f = posAbs
        // h = r(size, 父尺寸) * scale —— 从【原始书写值】现算,不走预折算的 n.drawW
        let h = (rawSize === undefined ? 0 : foldSize(rawSize, sizeUnit, parentSize)) * scale
        if (sizeUnit === '%%') h -= f
        if (h < 0) h += parentSize
        const p = f + parentSize * anchorF - h * alignF
        if (sizeUnit === '%%' || sizeNeg) {
          let t = rawSize === undefined ? 0 : foldSize(rawSize, sizeUnit, parentSize)
          if (t < 0) t += parentSize
          h = Math.max(0, t - p)
        }
        return { off: p, draw: h }
      }

      /**
       * MIN_RAW_V3 —— 扩展 u() 在 o() 之后做的一步:
       *   \`const minW = r(size?.min, parent.size.width, offX) ?? drawW\`
       *   \`drawW = Math.max(minW, drawW)\`
       * 注意 r() 的第三个参数是【offX 本身】,'%%' 要减掉它。
       * 这一步必须在 off 算出来之后做,所以不能留在 resolveSizes 里。
       */
      const applyMin = (
        rawMin: number | undefined,
        minUnit: '' | '%' | '%%' | undefined,
        parentSize: number,
        off: number,
        draw: number,
      ): number => {
        if (!rawMin) return draw
        const m = foldSize(rawMin, minUnit, parentSize) - (minUnit === '%%' ? off : 0)
        return Math.max(m, draw)
      }

      // ⚠ 传【折算后的绝对值】,不是 relX —— relX 里还带着 "50" 这种未折算的原始数值。
      //   position = { y = 50%% } 的绝对值是 父高*0.5,不是 50px。
      //   判据用 _xUnit 而非 _xPct:'%%' 的 position 与 '%' 数值相同(扩展 r() 的减量恒为 0),
      //   而 _xPct 只在 '%' 分支被赋值,用它会漏掉 '%%'。
      if (n._xUnit || n._yUnit) n.posPct = true
      const hasX = n._xUnit === '%' || n._xUnit === '%%'
      const hasY = n._yUnit === '%' || n._yUnit === '%%'
      // ★ 真实游戏语义:position 负值【不】钳 0。
      //   扩展 Nc() 的 `w.x._value < 0 && (w.x._value = 0)` 是"单窗口预览"便利 ——
      //   预览时把根窗口从屏幕外拉回可见区。游戏里脚本故意写负值把窗口推出屏幕
      //   (做滑入/滑出动画的中间态),钳 0 会让这些窗口错位。
      const px = n.relX
      const py = n.relY
      const posAbsX = hasX ? (parentW * px) / 100 : px
      const posAbsY = hasY ? (parentH * py) / 100 : py
      // ⚠ 传【原始书写值】_wRaw/_hRaw,不是 drawW/drawH ——
      //   drawW/drawH 是上一轮预折算的结果,%% 语义已经在那里丢过一次。
      //   icon/button 的 size 恒为 undefined(扩展 Ua()/Ja() 不给 size),
      //   传 undefined 让 foldSize 走 default 分支 → 0,与扩展的 r(undefined) 一致。
      const rxA = axis(posAbsX, n._wRaw, n._wUnit, n._wNeg, parentW, a.x, alX, n.scale)
      const ryA = axis(posAbsY, n._hRaw, n._hUnit, n._hNeg, parentH, a.y, alY, n.scale)
      n.offX = rxA.off
      n.offY = ryA.off
      /* ⚠ CENTER_POS_V5 —— 扩展 Ua()(iconType)/ Ja()(buttonType)在 m() 之后的一步:
       *     let [u, d] = m(e, t)
       *     if (e.centerposition) { u -= c.width / 2; d -= c.height / 2 }
       * 三个要点:
       *   ① 只有 icon/button 系有这一步(它们的 schema 里就没有 origo,减 align 恒为 0)
       *   ② 减的是【未缩放】的 sprite 尺寸 —— 渲染宽度才乘 scale(c.width*p),减半不乘
       *   ③ 贴图查不到时扩展直接 return ""(整个元素不渲染),也就无所谓减半
       * 漏掉它的实测后果(compare_v5,三个点名判例):86 处 offX/offY 偏差,
       *   差值恰好 = sprite 宽/2(fuhrer_frame Δ82.5=165/2、emperor_frame Δ102=204/2)。
       */
      if (n._spriteSize && n.centerPosition && n._spriteW && n._spriteH) {
        n.offX -= n._spriteW / 2
        n.offY -= n._spriteH / 2
      }
      /* ⚠ SPRITE_SIZE_V4:icon/button 的绘制尺寸来自 sprite,不是 axis()。
       * axis() 对它们返回 draw=0(与扩展 o() 一致,off 是对的),
       * 但绘制宽高必须是 sprite 尺寸 × scale —— 否则 designer 里全是 0×0 空框。
       * n.w/n.h 已在 sprite 解析阶段被填成 naturalSize,回写场景无 sprites 时为 0,
       * 这时退回 axis 结果(与旧行为一致,不会更差)。
       */
      if (n._spriteSize && (n.w || n.h)) {
        n.drawW = n.w * n.scale
        n.drawH = n.h * n.scale
      } else {
        n.drawW = applyMin(n._minWRaw, n._minWUnit, parentW, rxA.off, rxA.draw)
        n.drawH = applyMin(n._minHRaw, n._minHUnit, parentH, ryA.off, ryA.draw)
      }
      // w/h 同步为"最终绘制尺寸的来源值":声明尺寸给属性面板看,
      // 而子元素的父级尺寸一律走 drawW/drawH(扩展用的就是绘制尺寸)。
      if (n._wPct !== undefined) n.w = n.drawW / (n.scale || 1)
      if (n._hPct !== undefined) n.h = n.drawH / (n.scale || 1)
      // ⚠ parent = "name"(PARENT_REF_V3):扩展 is() 把被引用元素的偏移【累加】进来。
      //   实测 vanilla 34 处,全在 guiButtonType(scrollbarType 的按钮链)。
      n.absX = absX + n.offX + (n._parentOffX ?? 0)
      n.absY = absY + n.offY + (n._parentOffY ?? 0)

      /* ═══ MARGIN_V3 ═══
       * 扩展 ss() 把子元素的父级尺寸设为「自身绘制尺寸扣掉 margin」,
       * 并让子元素整体右下平移 (margin.left, margin.top):
       *     T = { size: { width : drawW - margin.left - margin.right,
       *                   height: drawH - margin.top  - margin.bottom } }
       *     子元素容器 div: left: margin.left px; top: margin.top px
       * margin 自身的 % 按【自身绘制尺寸】折算(扩展 f(margin.top, b.height),b=绘制尺寸)。
       */
      let childW = n.drawW
      let childH = n.drawH
      if (n.margin) {
        const m = n.margin
        childW = Math.max(0, n.drawW - m.left - m.right)
        childH = Math.max(0, n.drawH - m.top - m.bottom)
      }
      /* ═══ BG_LAYERS_V1:附加 background 层的几何 ═══
       * 与子元素用同一套锚点公式,但【尺寸语义不同】:
       *   · 子元素:绘制尺寸 = 自身声明/贴图天然尺寸;
       *   · background 层:绘制尺寸 = 撑满容器(与第一个 background 的拉伸行为一致)。
       * 地面证据(airselectionview.gui):GFX_air_priorities_tiled_bg 贴图天然只有
       * 82×82,却用在 640×84 的窗口上 —— 不拉伸只会是角落里一小块,而游戏里它是
       * 整窗的边框底;corneredTile 类贴图(GFX_tiled_window_1b_thin_border 192×192
       * 用于 250×128 窗)同样必须撑满才能让九宫格边框包住窗口。
       * position 是相对锚点的偏移量,不是尺寸声明。 */
      for (const L of n.bgLayers ?? []) {
        const la = anchorFactors(L.orientation ?? 'upper_left')
        let alx = 0
        let aly = 0
        if (L.origo) {
          const of = anchorFactors(L.origo)
          alx = of.x
          aly = of.y
        } else if (L.centerPosition) {
          alx = 0.5
          aly = 0.5
        }
        L.offX = L.x + childW * la.x - childW * alx
        L.offY = L.y + childH * la.y - childH * aly
        L.drawW = childW
        L.drawH = childH
      }
      if (n.margin) {
        const m = n.margin
        resolvePositions(n.children, childW, childH, n.absX + m.left, n.absY + m.top, n.effectiveOrientation)
      } else {
        resolvePositions(n.children, childW, childH, n.absX, n.absY, n.effectiveOrientation)
      }
    }
  }

  /**
   * 标记"尺寸写 0、需按内容撑开"的元素。
   * 必须在贴图推断之后跑 —— 贴图推断出的尺寸是权威值,不能被包围盒覆盖。
   */
  function markAuto(list: GuiNode[]): void {
    for (const n of list) {
      if (n._wPct === undefined && n.w === 0) n._autoW = true
      if (n._hPct === undefined && n.h === 0) n._autoH = true
      markAuto(n.children)
    }
  }

  /**
   * PARENT_REF_V3 —— `parent = "name"` 的偏移累加。
   *
   * 扩展 is()(反混淆原文):
   *   function is(e, t, n, r) {          // e=元素 t=兄弟表 n=父上下文 r=已访问集合
   *     const [i, o] = m(e, n)           // 自身偏移
   *     const a = e.parent
   *     if (!a || r.has(a)) return [i, o]        // 无 parent / 成环 → 就用自身的
   *     const s = t.get(a)
   *     if (!s) return [i, o]                    // 引用不到 → 也只用自身的
   *     const l = new Set(r); e.name && l.add(e.name)
   *     const [c, u] = is(s, t, n, l)            // 递归累加被引用者的偏移
   *     return [i + c, o + u]
   *   }
   *
   * 即"自己的偏移 + 被引用者(递归)的偏移",可多级串联;成环则断在环上。
   * 实测 vanilla 34 处,全在 guiButtonType(scrollbarType 里的滑块 / 箭头按钮链)。
   */
  function resolveParentRefs(list: GuiNode[]): void {
    for (const n of list) {
      if (n.parentRef) {
        // 同级里按 name 找被引用的元素(扩展的 t 表就是同级 name → 元素)
        const target = list.find((s) => s.name === n.parentRef)
        if (target && target !== n) {
          // 递归取被引用者的累加偏移(带深度上限防环)
          const acc = parentAccum(list, target, new Set([n.id]), 0)
          n._parentOffX = acc.x
          n._parentOffY = acc.y
        } else {
          n._parentOffX = 0
          n._parentOffY = 0
        }
      }
      resolveParentRefs(n.children)
    }
  }

  /** 递归求某元素因 parent 链而额外获得的偏移(相对父坐标系) */
  function parentAccum(list: GuiNode[], n: GuiNode, seen: Set<string>, depth: number): { x: number; y: number } {
    if (!n.parentRef || depth > 32) return { x: 0, y: 0 }
    if (seen.has(n.parentRef)) return { x: 0, y: 0 }
    const t = list.find((s) => s.name === n.parentRef)
    if (!t) return { x: 0, y: 0 }
    seen.add(n.parentRef)
    const up = parentAccum(list, t, seen, depth + 1)
    // 扩展是把 m() 算出的绝对偏移相加,这里用 offX/offY(相对同一父级)
    return { x: t.offX + up.x, y: t.offY + up.y }
  }

  /**
   * 自适应尺寸:写 0 且有子元素 → 用子元素包围盒撑开(后序遍历,子级先算完)。
   * 必须用 offX/offY 而不是 relX —— 带 orientation 的子元素原始 x 常为负数
   * (贴右写成 x = -w),用 relX 算包围盒会得到 0,父窗口就撑不开。
   */
  function resolveAuto(list: GuiNode[]): void {
    for (const n of list) {
      resolveAuto(n.children)
      if (!n.children.length) continue
      let bw = 0
      let bh = 0
      for (const c of n.children) {
        bw = Math.max(bw, (c.offX ?? c.relX) + c.drawW)
        bh = Math.max(bh, (c.offY ?? c.relY) + c.drawH)
      }
      if (n._autoW && bw > 0) { n.w = bw; n.sizeAuto = true; n.drawW = Math.max(n.minW ?? 0, n.w * n.scale) }
      if (n._autoH && bh > 0) { n.h = bh; n.sizeAuto = true; n.drawH = Math.max(n.minH ?? 0, n.h * n.scale) }
    }
  }

  /** 清掉百分比折算的临时字段(收敛完成后才清,否则第二轮没法重算) */
  function clearTemp(list: GuiNode[]): void {
    for (const n of list) {
      delete n._wPct
      delete n._hPct
      delete n._xPct
      delete n._yPct
      clearTemp(n.children)
    }
  }


  const collect = (n: GuiNode) => {
    ctx.flat.push(n)
    ctx.byId.set(n.id, n)
    for (const c of n.children) collect(c)
  }
  for (const n of nodes) collect(n)

  // sprite 解析:补尺寸、标缺失(回写场景下可不给 sprites,跳过这步)
  if (sprites) for (const n of ctx.flat) {
    if (n.sprite) {
      const def = sprites.get(n.sprite)
      if (!def) {
        n.spriteMissing = true
        ctx.unresolved.push({ id: n.id, sprite: n.sprite })
      } else {
        n.texturefile = def.texturefile ?? def.textureFile1 ?? def.textureFile2
        if (n.sizeInferred) {
          const dims = sprites.naturalSize(n.sprite)
          if (dims) {
            n.w = dims.w
            n.h = dims.h
            n._spriteW = dims.w // CENTER_POS_V5:留一份未缩放值给 centerposition 减半
            n._spriteH = dims.h
          } else {
            n.sizeUnknown = true
          }
        }
      }
    }
    if (n.bgSprite && sprites && !sprites.get(n.bgSprite)) ctx.unresolved.push({ id: n.id, sprite: n.bgSprite })
    // ★ BG_LAYERS_V1:附加背景层的贴图天然尺寸(定位/绘制要用)
    for (const L of n.bgLayers ?? []) {
      if (!L.sprite) continue
      if (!sprites.get(L.sprite)) {
        ctx.unresolved.push({ id: n.id, sprite: L.sprite })
        continue
      }
      const dims = sprites.naturalSize(L.sprite)
      if (dims) {
        L._spriteW = dims.w
        L._spriteH = dims.h
      }
    }
    n.drawW = Math.max(n.minW ?? 0, n.w * n.scale) // SIZE_MIN_V1
    n.drawH = Math.max(n.minH ?? 0, n.h * n.scale)
  }

  /**
   * 尺寸与位置的依赖是循环的,必须迭代收敛:
   *   百分比尺寸 依赖 父级尺寸 → 自适应尺寸 依赖 子级偏移 → 子级偏移 依赖 父级尺寸(锚点)。
   * 实测两轮即收敛(再增加轮次结果不变)。
   * 根级元素的父级 = 屏幕(1920x1080) —— 这就是"最后的父窗口与屏幕像素有关"。
   *
   * ⚠ PARENT_REF_V3:parent = "name" 的偏移要等所有兄弟都定位完才能累加,
   *   所以每轮 resolvePositions 之前先按上一轮结果结算一次。
   */
  /**
   * ⚠ 故意【不】照抄扩展的预览便利(要的是游戏真实情况,不是扩展预览):
   *   ① 根级不强制 orientation/origo = upper_left → 用文件里写的真实 orientation
   *   ② 根级不把 position 负值钳 0        → 保留脚本写的负偏移
   *   ③ 屏幕根窗口父容器恒为 1920×1080     → 不是"根容器自身声明尺寸"
   *
   * ★★★ INLAY_V4(2026-10-05,推翻前三轮反复摇摆的结论)———
   *   根容器分【两类】,定位基准完全不同,判据 = 该根容器名是否被
   *   common/focus_inlay_windows/*.txt 的 window_name 引用(internal = yes)。
   *
   *   A) 屏幕根窗口(绝大多数,如 advisorroleselectionview / achievements):
   *      父容器 = 屏幕 1920×1080,orientation 决定贴屏哪一角。
   *      ⚠ 对齐点(origo)缺省 = upper_left,【不是】自身 orientation。
   *      地面真相:pdx_online/online_accountcreate_simple.gui 的 content_window
   *      (position=(-350,-300) / 700x700 / orientation=center / 无 origo):
   *      align=0 → offX=-350+960=610,窗口占 x∈[610,1310] 居中偏左 ✓;
   *      align=0.5 → 260 明显偏左 ✗。同文件 122 个显式 origo 元素全部自洽。
   *      反例 achievements.gui 显式写 Origo=center,证明 vanilla 作者需要时自己会写。
   *
   *   B) 国策内嵌组件(inlay,6 个:cze/ger/jap/sia/ast/ast_empty):
   *      由 common/focus_inlay_windows 定义 + 国策树 inlay_window.position 定位,
   *      【不存在于屏幕上】——它被画在国策树的 inlay 槽位里。
   *      6 个根容器清一色 `orientation = lower_left position = {0,0}`,
   *      即"贴【自身槽位】左下角",与 1920×1080 屏幕毫无关系。
   *      父容器 = 自身声明尺寸(槽位即窗口),orientation/origo 只影响槽内摆放。
   *      ⚠ 此前误按屏幕定位,把 GER 判例根容器贴到 y=530,
   *        导致 advisors_container(abs y=1020)及其 7 个子头像全部出屏 —— 是假 bug。
   *      实测判例内部坐标完全自洽(41 元素全在 600×550 内),证实槽位语义。
   */
  const resolveRoots = (): void => {
    for (const root of nodes) {
      if (isInlayComponent(root)) {
        // 槽位 = 窗口自身:父尺寸取自身声明尺寸,基准点左上角
        resolvePositions([root], root.w || 0, root.h || 0, 0, 0, undefined, true, true)
      } else {
        // ★ 屏幕根窗口:父容器就是【屏幕 1920×1080】,恒定不变。
        //   扩展 Nc() 用"根容器自身声明尺寸"当父尺寸,是它一次只预览一个根窗口的取巧。
        resolvePositions([root], BASE_W, BASE_H, 0, 0, undefined, true)
      }
    }
  }

  markAuto(nodes)
  resolveSizes(nodes, BASE_W, BASE_H)
  for (let i = 0; i < 2; i++) {
    resolveParentRefs(nodes)
    resolveRoots()
    resolveAuto(nodes)
    resolveSizes(nodes, BASE_W, BASE_H)
  }
  resolveParentRefs(nodes)
  resolveRoots()
  clearTemp(nodes)

  let canvasW = 100
  let canvasH = 100
  let maxDepth = 0
  let withSprite = 0
  for (const n of ctx.flat) {
    canvasW = Math.max(canvasW, n.absX + n.drawW)
    canvasH = Math.max(canvasH, n.absY + n.drawH)
    maxDepth = Math.max(maxDepth, n.depth)
    if (n.sprite) withSprite++
    // 折腾完仍然 0 尺寸的(子元素也全是 0、既无贴图也无显式尺寸)——
    // 标为未知,界面画占位虚线框,免得用户面对一个隐形盒子无从下手
    // ★ TEXT_AUTOH_V1:instantTextBoxType/editBoxType 高度为 0 是【正常】的
    //   (游戏按字号自动排版,maxWidth 给宽度),只有宽度也 0 才算未知。
    //   否则 GER_inner_circle 等文件里一排文本框被误标红(内容其实完全正确)。
    // ★ EMPTY_SPRITE_V1:spriteType="" 是作者显式声明的运行时占位
    //   (如 GER 顾问肖像,游戏内由 scripted_gui 动态指派贴图),同样不算未知。
    const isAutoH = /textboxtype|editboxtype/i.test(n.type || '')
    const zeroSize = isAutoH ? n.w === 0 : (n.w === 0 || n.h === 0)
    if (zeroSize && n.sprite !== '') n.sizeUnknown = true
  }

  return {
    file,
    source: src,
    doc,
    nodes,
    flat: ctx.flat,
    byId: ctx.byId,
    entries: ctx.entries,
    unresolved: ctx.unresolved,
    vars: ctx.vars,
    canvasW,
    canvasH,
    // ★ INLAY_SLOT_V5:根容器若是国策内嵌组件,带出它的真实槽位坐标
    inlay: nodes.length === 1 && isInlayComponent(nodes[0]) ? inlaySlotOf(nodes[0].name) : undefined,
    stats: { elements: ctx.flat.length, maxDepth, withSprite },
  }
}

function buildNode(
  ctx: Ctx,
  e: Entry,
  id: string,
  depth: number,
  parentId: string | undefined,
): GuiNode | undefined {
  const doc = ctx.doc
  const type = keyText(doc, e) ?? '?'
  const block = e.block
  if (!block) return undefined

  // entry 在这里就地登记,保证 id 与 AST 节点严格同源
  ctx.entries.set(id, { doc, entry: e })

  const name = childValue(doc, block, 'name') ?? '(匿名)'
  const props: Record<string, string> = {}
  const propBlocks: Record<string, Record<string, string>> = {}
  let varRefs = 0
  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k) continue
    if (!c.block) {
      const v = valueText(doc, c)
      if (v !== undefined) props[k] = v
      continue
    }
    // 块形态属性:递归摊平内层标量(点号连接,如 size.min.width),
    // 属性网格才能编辑 borderSize / margin / slotSize / size.min
    const inner: Record<string, string> = {}
    const flatten = (b: Block, prefix: string, d: number) => {
      if (d > 3) return
      for (const g of b.entries) {
        const gk = keyText(doc, g)
        if (!gk) continue
        if (!g.block) {
          const gv = valueText(doc, g)
          if (gv !== undefined) inner[prefix ? `${prefix}.${gk}` : gk] = gv
        } else {
          flatten(g.block, prefix ? `${prefix}.${gk}` : gk, d + 1)
        }
      }
    }
    flatten(c.block, '', 0)
    propBlocks[k] = inner
  }

  // @var 感知的数值解析:解析不出来且确实是 @引用时,记一笔供界面提示
  const numV = (v: string | undefined): number | undefined => {
    const n = num(v, ctx.vars)
    if (n === undefined && v !== undefined && v.trim().startsWith('@')) varRefs++
    return n
  }

  const posBlock = childBlock(doc, block, 'position')
  // ⚠ SHOW_POSITION_V3:扩展 ss() 第一行
  //     const h = n.useShowPosition && e.show_position ? e.show_position : e.position
  //   useShowPosition 只在渲染【嵌套 containerWindowType】时为真
  //   (onRenderChild 里对 containerwindow 传 useShowPosition:true)。
  //   根容器走另一条:扩展预览时 `const v = e.show_position ?? e.position` —— 同样优先 show_position。
  //   两条合起来 = **只要是容器且写了 show_position,布局就按 show_position 算**。
  //   非容器元素(show_position 归属统计里 dropDownBoxType/editBoxType 等)扩展不读,仍用 position。
  //   实测 vanilla 148 处 show_position,其中 containerWindowType 101 处。
  //   battleplantools.gui 的 battleplantools_window 就是 position y=0 / show_position y=-245,
  //   差 245px —— 之前整窗错位就是这里。
  //
  // ⚠ 根级另有两处扩展行为我们**故意不照抄**,因为那是预览便利而非游戏语义:
  //   ① 扩展把根级负 position 钳到 0(`w.x._value < 0 && (w.x._value = 0)`)
  //      —— 只为让预览窗口可见;游戏里 -270 这类偏移是有意义的(贴边/居中微调)。
  //   ② 扩展把「屏幕尺寸」换成根容器自己的 size(`h.width = g._value`,见 Nc()),
  //      因为它一次只预览一个根窗口;本工具把全部根窗口叠在一张 1920x1080 画布上,
  //      必须保留 BASE_W/BASE_H,否则多窗口叠加的相对关系全错。
  //   唯一照抄的是 fullscreen = yes:整屏铺满,position 归零、size 记 100%%(vanilla 4 处)。
  const isContainer = CONTAINER_TYPES.has(type.toLowerCase())
  const showBlock = childBlock(doc, block, 'show_position')
  const useShow = isContainer && showBlock !== undefined
  const fullscreenRaw = unquote(childValue(doc, block, 'fullscreen')).toLowerCase()
  const fullscreen = isContainer && depth === 0 && (fullscreenRaw === 'yes' || fullscreenRaw === 'true')
  const posSrc = useShow ? showBlock! : posBlock

  // position 也支持百分比(vanilla 9 处,如 `position = { x = 3% y = 2 }`),按父级折算。
  // ⚠ 单位有三种(基准 EXT_UNIT_V2):'' 像素 / '%' 占父级百分比 / '%%' 占父级百分比再减自身。
  //   扩展的 r(): '%' → v/100*父宽;'%%' → v/100*父宽 - 自身尺寸。
  //   position 上的 %% 与 % 数值相同(减的是 0),但 size 上的 %% 会减 position,必须区分。
  const posVal = (key: string): number | undefined => {
    if (!posSrc) return undefined
    const raw = childValue(doc, posSrc, key)
    if (raw === undefined) return undefined
    return numV(raw.trim())
  }
  const unitOf = (key: string): '' | '%' | '%%' => {
    if (!posSrc) return ''
    const raw = childValue(doc, posSrc, key)
    if (raw === undefined) return ''
    const t = raw.trim()
    return t.endsWith('%%') ? '%%' : t.endsWith('%') ? '%' : ''
  }
  const relX = posVal('x') ?? 0
  const relY = posVal('y') ?? 0
  const xUnit = unitOf('x')
  const yUnit = unitOf('y')
  // 百分比 position 折算标记(带单位信息,供 resolvePositions 用)
  const xPct = xUnit ? relX / 100 : undefined
  const yPct = yUnit ? relY / 100 : undefined
  // ⚠ fullscreen = yes(根容器,vanilla 4 处):扩展把 position 换成 {0,0}、size 换成 100%%
  //   (Nc():\`size: e.fullscreen ? {width:d("100%%"), height:d("100%%")} : e.size\`)。
  //   这里通过把单位标成 '%%' 且值取 100 来复用同一条折算路径,语义与扩展一致。
  const fxX = fullscreen ? 100 : relX
  const fxY = fullscreen ? 100 : relY
  const fxXUnit: '' | '%' | '%%' = fullscreen ? '%%' : xUnit
  const fxYUnit: '' | '%' | '%%' = fullscreen ? '%%' : yUnit

  // ⚠ TEXTBOX_SIZE_V3:尺寸来源【按元素类型不同】,扩展的 schema 是分类型声明的。
  //   instantTextBoxType / textBoxType → size = { width: maxwidth, height: maxheight }
  //   实测 vanilla:instantTextBoxType 3525 个写 size 的 0 个、写 maxWidth 的 3468 个;
  //             textBoxType 22 个同样全用 maxWidth。
  //   editBoxType 反之(103 个全写 size),所以只对前两类改用 maxWidth。
  const lk = type.toLowerCase()
  const sizeFromMaxWH = SIZE_FROM_MAXWH.has(lk)
  // ⚠ ICON_BTN_SIZE_V3:iconType / buttonType 系扩展不给 size(走 sprite 尺寸),
  //   m() 里 r(undefined) → 0,于是 offX = position.x + 父宽*anchor,**不减 align**。
  //   实测 vanilla:6654 个 iconType 写 size 的 0 个。
  const sizeFromSprite = SIZE_FROM_SPRITE.has(lk)

  // size 有两种写法:{ width= height= } 与 { x= y= }(listboxType 等用后者)
  // 另外 63% 的 size 值写成百分比(width = 100% / -100%),还有写成 0 交给引擎按内容自适应的。
  // 这两种都不能直接当像素用:百分比要按父级折算,0 要按子元素包围盒估算 —— 都在第二遍做。
  const sizeBlock = sizeFromSprite ? undefined : childBlock(doc, block, 'size')
  let w = 0
  let h = 0
  let wPct: number | undefined
  let hPct: number | undefined
  // ⚠ EXT_UNIT_V2:尺寸单位与符号,供 resolvePositions 复刻扩展 o() 的 %% / 负值分支
  let wUnit: '' | '%' | '%%' = ''
  let hUnit: '' | '%' | '%%' = ''
  let wNeg = false
  let hNeg = false
  // ⚠ 原始书写值(含符号、未折算),供独立复刻扩展 o() 用
  let wRaw = 0
  let hRaw = 0
  // size.min —— 绘制尺寸下界。minW/minH 存绝对像素,minWPct/minHPct 存比例(第二遍折算)
  let minW = 0
  let minH = 0
  let minWPct: number | undefined
  let minHPct: number | undefined
  let minWRaw = 0
  let minHRaw = 0
  let minWUnit: '' | '%' | '%%' = ''
  let minHUnit: '' | '%' | '%%' = ''
  if (sizeBlock) {
    // ⚠ EXT_UNIT_V2:单位与符号必须原样保留,不能在这里折算也不能取绝对值。
    //   基准(扩展 832 模块 o()/r()):
    //     let h = r(size, 父宽) * scale
    //     if (size 单位 === '%%') h -= position      ← %% 要减 position
    //     if (h < 0) h += 父宽                       ← 负尺寸向反方向延伸
    //   之前把 -100% 直接 Math.abs 成 1.0(占满父级),把 100%% 当 100%(丢掉单位),
    //   两者都与基准不符 —— vanilla 里 %% 尺寸 819 处、负尺寸 76 处,是真实的错位来源。
    const dim = (a: string, b: string): { v: number; unit: '' | '%' | '%%' } => {
      const raw = childValue(doc, sizeBlock, a) ?? childValue(doc, sizeBlock, b)
      if (raw === undefined) return { v: 0, unit: '' }
      const t = raw.trim()
      const unit: '' | '%' | '%%' = t.endsWith('%%') ? '%%' : t.endsWith('%') ? '%' : ''
      // numV 要能吃带单位的串:交给调用方按 unit 折算,这里只取数值
      const n = unit ? num(t.slice(0, t.length - unit.length), ctx.vars) : numV(t)
      return { v: n ?? 0, unit }
    }
    const dw = dim('width', 'x')
    const dh = dim('height', 'y')
    if (dw.unit) { wPct = dw.v / 100; wUnit = dw.unit } else w = dw.v
    if (dh.unit) { hPct = dh.v / 100; hUnit = dh.unit } else h = dh.v
    wNeg = w < 0 || wPct! < 0
    hNeg = h < 0 || hPct! < 0
    if (wPct !== undefined) wPct = Math.abs(wPct)
    if (hPct !== undefined) hPct = Math.abs(hPct)
    // ⚠ 保留原始书写值(含符号),供独立复刻扩展 o() 时用。
    //   w / h 会被取绝对值并按父级折算,拿折算结果再按单位折算就是二次缩放。
    wRaw = dw.v
    hRaw = dh.v
    if (w < 0) w = -w
    if (h < 0) h = -h

    // size.min —— 元素绘制尺寸的下界(基准:drawW = max(size.min, size))。
    // 两种写法都要认:扁平成 `size = { width = 100 min = 40 }`(vanilla 13 处),
    // 以及嵌套 `size = { width = 100 min = { width = 40 } }`。
    // ⚠ 统一存成【绝对像素】:百分比在此按父级折算不了(此刻还不知道父宽),
    //   故记成比例由 resolveSizes 折算,见该处 SIZE_MIN_V1。
    //   缺失时记 0,max(0, drawW) 等于原值,零影响。
    // ⚠ 同时保留原始值与单位:扩展 u() 里是 r(size.min, 父宽, offX),
    //   '%%' 要减掉自己的 offX,不看原始值无法复刻。
    const minRaw = childValue(doc, sizeBlock, 'min')
    const rdMin = (raw: string | undefined): { v: number; unit: '' | '%' | '%%' } => {
      if (raw === undefined) return { v: 0, unit: '' }
      const t = raw.trim()
      const unit: '' | '%' | '%%' = t.endsWith('%%') ? '%%' : t.endsWith('%') ? '%' : ''
      const n = unit ? num(t.slice(0, t.length - unit.length), ctx.vars) : numV(t)
      return { v: n ?? 0, unit }
    }
    if (minRaw !== undefined) {
      const r1 = rdMin(minRaw)
      minWRaw = r1.v
      minWUnit = r1.unit
      if (r1.unit) minWPct = Math.abs(r1.v) / 100
      else minW = r1.v
    } else {
      const minBlk = childBlock(doc, sizeBlock, 'min')
      if (minBlk) {
        const mw = childValue(doc, minBlk, 'width') ?? childValue(doc, minBlk, 'x')
        const mh = childValue(doc, minBlk, 'height') ?? childValue(doc, minBlk, 'y')
        if (mw !== undefined) {
          const r1 = rdMin(mw)
          minWRaw = r1.v
          minWUnit = r1.unit
          if (r1.unit) minWPct = Math.abs(r1.v) / 100
          else minW = r1.v
        }
        if (mh !== undefined) {
          const r1 = rdMin(mh)
          minHRaw = r1.v
          minHUnit = r1.unit
          if (r1.unit) minHPct = Math.abs(r1.v) / 100
          else minH = r1.v
        }
      }
    }
  }
  // ⚠ TEXTBOX_SIZE_V3:instantTextBoxType / textBoxType 的尺寸走 maxWidth / maxHeight。
  //   扩展 Ha():\`const [p,h,g,v] = m({...e, size:{width:e.maxwidth, height:e.maxheight}}, t)\`
  //   maxWidth 支持 % / %% 吗?实测 vanilla 里全是整数像素,但为稳妥仍按同一套单位逻辑折算。
  //   borderSize 在这里是 padding(扩展 \`padding: \${y}px \${x}px\`),不参与尺寸。
  if (sizeFromMaxWH) {
    const mw = childValue(doc, block, 'maxWidth') ?? childValue(doc, block, 'maxwidth')
    const mh = childValue(doc, block, 'maxHeight') ?? childValue(doc, block, 'maxheight')
    const rd = (raw: string | undefined): { v: number; unit: '' | '%' | '%%' } => {
      if (raw === undefined) return { v: 0, unit: '' }
      const t = raw.trim()
      const unit: '' | '%' | '%%' = t.endsWith('%%') ? '%%' : t.endsWith('%') ? '%' : ''
      const n = unit ? num(t.slice(0, t.length - unit.length), ctx.vars) : numV(t)
      return { v: n ?? 0, unit }
    }
    const dw = rd(mw)
    const dh = rd(mh)
    if (dw.unit) { wPct = dw.v / 100; wUnit = dw.unit } else w = dw.v
    if (dh.unit) { hPct = dh.v / 100; hUnit = dh.unit } else h = dh.v
    wNeg = w < 0
    hNeg = h < 0
    wRaw = dw.v
    hRaw = dh.v
    if (w < 0) w = -w
    if (h < 0) h = -h
  }

  // ⚠ fullscreen = yes(根容器):扩展把 size 换成 100%%(Nc() 里的
  //   `size: e.fullscreen ? { width: d("100%%"), height: d("100%%") } : e.size`)。
  //   %% 走的是"占满父级再减去自身 position"的分支,语义与扩展完全一致。
  if (fullscreen) {
    w = 0
    h = 0
    wPct = 1
    hPct = 1
    wUnit = '%%'
    hUnit = '%%'
    wRaw = 100
    hRaw = 100
    wNeg = false
    hNeg = false
    minW = 0
    minH = 0
    minWPct = undefined
    minHPct = undefined
  }

  // sizeInferred = 没有可用的尺寸声明,后面由 sprite 推断
  // (icon/button 恒为 true —— 扩展就是拿 sprite 宽高当尺寸)
  const sizeInferred = !sizeBlock && !fullscreen

  const scale = num(props['scale'], ctx.vars) ?? 1
  // 贴图引用不止 spriteType。实测 vanilla:quadTextureSprite 有 3867 处,
  // 是 iconType / buttonType 等元素的直接贴图引用 —— 只读 spriteType 会让它们渲染成空框。
  const sprite =
    childValue(doc, block, 'spriteType') ??
    childValue(doc, block, 'sprite') ??
    childValue(doc, block, 'quadTextureSprite')
  const bgBlocks = childBlocks(doc, block, 'background')
  // 注意:background.name 只是局部名 —— vanilla 1473 处无一以 GFX_ 开头,不能当贴图引用。
  // background 里真正指向贴图的是 spriteType / quadTextureSprite(后者 882 处)。
  // ★ BG_LAYERS_V1:第一个【无 position】的 background 仍是容器自身底色(拉伸铺满);
  //   带 position 的(以及第一个之后的无 position 兄弟)按元素规则定位成附加层。
  let bgSprite: string | undefined
  const bgLayers: BgLayer[] = []
  for (const b of bgBlocks) {
    const spr =
      childValue(doc, b, 'spriteType') ??
      childValue(doc, b, 'sprite') ??
      childValue(doc, b, 'quadTextureSprite')
    if (!spr) continue
    const pb = childBlock(doc, b, 'position')
    if (!pb && bgSprite === undefined) {
      bgSprite = spr
      continue
    }
    bgLayers.push({
      sprite: spr,
      x: pb ? (numV((childValue(doc, pb, 'x') ?? '0').trim()) ?? 0) : 0,
      y: pb ? (numV((childValue(doc, pb, 'y') ?? '0').trim()) ?? 0) : 0,
      orientation:
        unquote(childValue(doc, b, 'orientation') ?? childValue(doc, b, 'Orientation')) || undefined,
      origo: unquote(childValue(doc, b, 'origo') ?? childValue(doc, b, 'Origo')) || undefined,
      centerPosition: /^(yes|true)$/i.test(
        unquote(childValue(doc, b, 'centerposition') ?? childValue(doc, b, 'centerPosition')),
      ),
      scale: num(props['scale'], ctx.vars) ?? 1,
    })
  }

  // ── 相对定位三件套 ──
  // orientation(父级参照点)/ origo(自身对齐点)/ centerposition(强制中心对齐)。
  // 大小写混用(LOWER_RIGHT / lower_RIGHT)且有带引号写法(orientation = "CENTER"),
  // 统一 unquote 后按小写解析。
  const orientation =
    unquote(childValue(doc, block, 'orientation') ?? childValue(doc, block, 'Orientation')) || undefined
  const origo = unquote(childValue(doc, block, 'origo') ?? childValue(doc, block, 'Origo')) || undefined
  const cpRaw = unquote(
    childValue(doc, block, 'centerposition') ?? childValue(doc, block, 'centerPosition'),
  ).toLowerCase()
  const centerPosition = cpRaw === 'yes' || cpRaw === 'true'
  // 元素自身的对齐点(origo / centerposition / 缺省 = orientation)。
  // ⚠ ALIGN_DEFAULT_REALGAME:缺省 = orientation(见 resolvePositions 处论证)。
  //   icon/button(sizeFromSprite)的 extend schema 无 origo,align 恒 0——
  //   但其 axis 里 h=0,align 不参与 off 计算,故效果与 align=orientation 一致,无副作用。
  //   centerposition 由扩展手工减半 sprite/2,这里用 align=0.5 等价实现
  //   (前提是 drawW 已被 sprite 推断填好,见 sprite 解析段)。
  // 注:此处的 alignX/alignY 会被 resolvePositions 重新计算覆盖,这里只作初值。
  const fac0 = anchorFactors(orientation ?? 'upper_left')
  let alignX = 0
  let alignY = 0
  if (sizeFromSprite) {
    // icon/button:align 恒 0(且其 axis h=0,align 不影响 off)
  } else if (centerPosition) {
    alignX = 0.5
    alignY = 0.5
  } else if (origo) {
    const of = anchorFactors(origo)
    alignX = of.x
    alignY = of.y
  } else {
    alignX = fac0.x
    alignY = fac0.y
  }

  // ⚠ MARGIN_V3:margin = { top= right= bottom= left= }(也常只写一半)
  const marginBlock = childBlock(doc, block, 'margin')
  let marginSpec: GuiNode['_marginSpec']
  if (marginBlock) {
    const mv = (k: string): MarginVal | undefined => {
      const raw = childValue(doc, marginBlock, k)
      if (raw === undefined) return undefined
      const t = raw.trim()
      const unit: '' | '%' | '%%' = t.endsWith('%%') ? '%%' : t.endsWith('%') ? '%' : ''
      const n = unit ? num(t.slice(0, t.length - unit.length), ctx.vars) : numV(t)
      if (n === undefined) return undefined
      return { v: n, unit }
    }
    marginSpec = {
      top: mv('top'),
      right: mv('right'),
      bottom: mv('bottom'),
      left: mv('left'),
    }
  }

  // ⚠ PARENT_REF_V3:parent = "name" —— 引用同级另一元素,偏移会被累加
  const parentRef = unquote(childValue(doc, block, 'parent')) || undefined

  const node: GuiNode = {
    id,
    type,
    name,
    relX: fxX,
    relY: fxY,
    w,
    h,
    absX: 0,
    absY: 0,
    offX: relX,
    offY: relY,
    drawW: w * scale,
    drawH: h * scale,
    scale,
    sizeInferred,
    _spriteSize: sizeFromSprite, // SPRITE_SIZE_V4
    _wPct: wPct,
    _hPct: hPct,
    _xPct: xPct,
    _yPct: yPct,
    _wUnit: wUnit,
    _hUnit: hUnit,
    _xUnit: fxXUnit,
    _yUnit: fxYUnit,
    _wNeg: wNeg,
    _hNeg: hNeg,
    _wRaw: wRaw,
    _hRaw: hRaw,
    minW,
    minH,
    _minWPct: minWPct,
    _minHPct: minHPct,
    _minWRaw: minWRaw,
    _minHRaw: minHRaw,
    _minWUnit: minWUnit,
    _minHUnit: minHUnit,
    posMissing: !posBlock && !useShow,
    orientation,
    origo,
    centerPosition: centerPosition || undefined,
    alignX,
    alignY,
    effectivePos: useShow
      ? { x: relX, y: relY, fromShow: true }
      : posBlock
        ? { x: relX, y: relY, fromShow: false }
        : undefined,
    _marginSpec: marginSpec,
    parentRef,
    sprite,
    bgSprite,
    bgLayers: bgLayers.length ? bgLayers : undefined,
    props,
    propBlocks,
    varRefs,
    children: [],
    depth,
    parentId,
    line: lineOf(doc, e),
  }

  const counters = new Map<string, number>()
  for (const c of block.entries) {
    const k = keyText(doc, c)
    if (!k || !c.block) continue
    const lk = k.toLowerCase()
    if (PROP_BLOCKS.has(lk)) continue
    if (ELEMENT_TYPES.has(lk)) {
      const i = counters.get(k) ?? 0
      counters.set(k, i + 1)
      const child = buildNode(ctx, c, `${id}/${k}:${i}`, depth + 1, id)
      if (child) node.children.push(child)
      continue
    }
    // 容器块(如 expandedWindow):自身不是元素,但子元素要挂到宿主下
    if (CONTAINER_BLOCKS.has(lk)) {
      const innerCounters = new Map<string, number>()
      for (const g of c.block.entries) {
        const gk = keyText(doc, g)
        if (!gk || !g.block) continue
        if (!ELEMENT_TYPES.has(gk.toLowerCase())) continue
        const gi = innerCounters.get(gk) ?? 0
        innerCounters.set(gk, gi + 1)
        const child = buildNode(ctx, g, `${id}/${k}/${gk}:${gi}`, depth + 1, id)
        if (child) node.children.push(child)
      }
    }
  }

  return node
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key && e.block) return e.block
  }
  return undefined
}

/** 同 childBlock,但返回【全部】匹配块(background 可写多个,见 BG_LAYERS_V1) */
function childBlocks(doc: Document, b: Block, key: string): Block[] {
  const out: Block[] = []
  for (const e of b.entries) {
    if (keyText(doc, e) === key && e.block) out.push(e.block)
  }
  return out
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key) return valueText(doc, e)
  }
  return undefined
}

/**
 * 解析数值,支持 .gui 的 @var 引用。
 *
 * @var 不是边缘语法:vanilla 453 个 .gui 里有 40 个在用,共计 332 处定义、2467 处引用,
 * 典型如 `size = { width = 220 height = @equipment_entry_heigth }`。
 * 不解析的话 parseFloat("@x") = NaN,坐标与尺寸会静默退化成 0 —— 整片布局塌成一个点。
 *
 * 定义可以出现在任意层级(根级与嵌套块内都有),所以必须两遍扫描:先全文收集,再解析引用。
 * 大小写两种都有(vanilla 同时存在 @POSTERS_Y 与 @equipment_entry_heigth),
 * 故先精确匹配、再回退到小写匹配。
 */
function num(v: string | undefined, vars?: Map<string, number>): number | undefined {
  if (v === undefined) return undefined
  const raw = v.trim()
  const n = parseFloat(raw)
  if (Number.isFinite(n)) return n
  if (!raw.startsWith('@') || !vars) return undefined
  return vars.get(raw) ?? vars.get(raw.toLowerCase())
}

/** 全文收集 @var 定义(两遍扫描的第一遍)。值只取字面量,不做变量套变量。 */
function collectVars(doc: Document): Map<string, number> {
  const vars = new Map<string, number>()
  walk(doc, (e) => {
    if (e.block) return
    const k = keyText(doc, e)
    if (!k || !k.startsWith('@')) return
    const v = num(valueText(doc, e))
    if (v !== undefined) vars.set(k.toLowerCase(), v)
  })
  return vars
}
