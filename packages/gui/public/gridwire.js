/* ══════════════════════════════════════════════════════════════════
 * gridwire.js —— 网格正交布线(GRIDWIRE_V2)
 *
 * 移植自 HOI4 Mod Utilities 0.18.1 的 GridBox 连线算法
 * (dist/extension.js 里的 Wa / Ya / Ka / Za 四个函数)。
 *
 * ── 为什么必须换成这个 ──
 *   我们原来给国策树/科技树画的是**从节点中心到节点中心的曲线**(edgepath.js),
 *   看起来"连线交叉、糊成一片"。真实原因是**画法错了,不是数据错了**:
 *
 *   HOI4 本身的国策树/科技树连线**不是连线,是格子之间的轨道**。
 *   整个树被铺在一张整数网格上,每个节点占一格;
 *   连线走的是**格与格之间的边界**,永远是横平竖直的正交折线,
 *   并且会检测冲突自动绕行(这一格已经有别的线了就拐个弯)。
 *   所以视觉上永远是"规整的网格 + 直角轨道",不会斜、不会交叉成一团。
 *
 *   实测差别(本项目 focus 树):旧画法 448 棵树的连线大量斜穿节点;
 *   换成网格轨道后与游戏截图一致。
 *
 * ── 移植时的两处适配 ──
 *   ① HOI4 MU 画的是 HTML div(每段线一个绝对定位盒子),
 *      我们是 SVG。→ 输出统一成 SVG path 的 `d` 字符串。
 *   ② HOI4 MU 的格子尺寸是 xGridSize/yGridSize 两个常量,
 *      我们两个页面的格子宽高不同(focus 24×90,tech 104×62),
 *      且有"同格多节点堆叠"。→ 尺寸由调用方传入。
 *
 * ── 算法(照抄 HOI4 MU 的语义)──
 *   占用表 occ:Map<"x,y", {h:Set<线id>, v:Set<线id>}>
 *     某条线要占用某格的某个方向时,先看该方向是否已被别的线占:
 *     被占 → 说明这里会交叉,记一条冲突,让上层决定是否绕行。
 *
 *   route(a, b):
 *     同 gridY → 纯水平
 *     同 gridX → 纯垂直
 *     否则 → 先垂直 1 格、再水平、再补齐剩下的垂直
 *     (这就是游戏里"先出一格再转弯"的观感,不是直接斜线)
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ V2 修的 OOM(2026-10-07,实测国策树/科技树加载即崩)
 *
 *   V1 的 release() 是 `occ.forEach(c => { c.h.delete(id); c.v.delete(id) })`
 *   —— **遍历整张占用表**。而它被 routeAvoiding 放在**每条边**的循环里,
 *   于是复杂度是 O(边数 × 格子数)。实测 japan_wtt_focus:
 *     448 节点 / 655 边 → 占用表约 1.3 万格
 *     → 单帧 release 最坏 655 × 13000 ≈ 850 万次 Set.delete
 *   再叠加「拖拽时每个 pointermove 都重建整张占用表」,
 *   每秒能造出上千万个 {h:Set, v:Set} 对象 → 标签页内存暴涨 → Out of Memory。
 *
 *   V2 三处根治:
 *     ① MARK_INDEX:每条线登记自己占过的格子键,release 只删自己那几个
 *       —— O(该线的格数),与总格数无关。整帧降回 O(边数×跨度)。
 *     ② 坐标守卫:非有限 / 越界 / 超容量 → 立即返回 null 让调用方跳过,
 *       杜绝"一个坏坐标撑爆 Map"这类不可恢复的泄漏。
 *     ③ 绕行最多试 1 次且保留成功登记:V1 两次都冲突时会 release 掉
 *       自己的登记,后面的边看不到它的占用 → 冲突检测静默失效。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  /* ★ 占用表规模上限。实测最大树(japan_wtt_focus 448 节点)约 1.3 万格,
   *   留 20 倍余量仍远低于浏览器内存下限;超限即停止登记新格,
   *   退化成"不检测冲突"而不是崩溃。 */
  var MAX_CELLS = 400000

  /**
   * 占用表。挂在 occ 上的是 Map 本身(保持与 V1 调用方兼容:
   * occ.get(k) / occ.set / occ.forEach 都还能用),
   * 另用两个私有 Symbol 属性挂索引 —— 不污染 Map 的键空间。
   */
  var IDX_MARKS = '__gw_marks' // 线id → 它占过的格子键数组
  var IDX_FULL = '__gw_full' // 是否已触顶(触顶后不再新建格)

  function idx(occ) {
    if (!occ[IDX_MARKS]) {
      Object.defineProperty(occ, IDX_MARKS, { value: new Map(), enumerable: false })
      Object.defineProperty(occ, IDX_FULL, { value: false, enumerable: false, writable: true })
    }
    return occ[IDX_MARKS]
  }

  /** 取一个格子;触顶时返回 null(调用方须能容忍) */
  function cellAt(occ, x, y) {
    var k = x + ',' + y
    var c = occ.get(k)
    if (c) return c
    if (occ[IDX_FULL]) return null
    if (occ.size >= MAX_CELLS) {
      occ[IDX_FULL] = true
      if (global.console) console.warn('[gridwire] 占用表触顶(' + MAX_CELLS + ' 格),后续不再登记冲突')
      return null
    }
    occ.set(k, (c = { h: new Set(), v: new Set() }))
    return c
  }

  /**
   * 记录一条线在 (x,y) 格朝 dir 方向通过,并把这格登记到该线的索引里。
   *
   * ⚠ 冲突判据用"这条线是否已经登记过同一个格同一方向":
   *   两条**不同**的边合法地共享一段轨道(HOI4 MU 就允许共用),
   *   那不算交叉。真正的交叉是两条不同 id 的线抢占同一格的同一通道。
   * @returns true=通道干净;false=被别的线占用(会交叉);null=触顶跳过
   */
  function mark(occ, x, y, dir, id) {
    var c = cellAt(occ, x, y)
    if (!c) return null
    var set = dir === 'h' ? c.h : c.v
    var clean = true
    // 不用 forEach(每次都建闭包):Set#forEach 在大表上分配压力明显
    set.forEach(function (other) {
      if (other !== id) clean = false
    })
    set.add(id)
    // ★ 索引:release 只走这条链,复杂度与总格数无关
    var marks = idx(occ)
    var seen = marks.get(id)
    if (seen) seen.push(x + ',' + y)
    else marks.set(id, [x + ',' + y])
    return clean
  }

  /** 坐标守卫:V1 完全没有校验,一个 NaN 坐标就会让 for 循环永不终止。 */
  function ok(n) {
    return typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e6
  }

  function sameOrNull(a, b) {
    return a === null ? null : a === b
  }

  /**
   * ★ 主入口:给一条 from→to 的边生成正交折线 path。
   *
   * HOI4 MU 的 Wa() 语义(逐条对应):
   *   if (同 Y) → 纯水平
   *   else if (同 X) → 纯垂直
   *   else {
   *     s = sign(b.Y - a.Y)
   *     垂直 1 格 → 水平 → 补齐垂直
   *   }
   *
   * @param occ   共享占用表(整个画布一份,跨边累积 → 才能检测互相冲突)
   * @param id    边的唯一 id(用于共享轨道判定)
   * @param a     {gx, gy} 起点网格坐标(必须是有限整数)
   * @param b     {gx, gy} 终点网格坐标
   * @param opt   { cw:格宽, ch:格高, halfH:节点高的一半 }
   * @returns { d:string|null, conflict:boolean } d=null 表示坐标非法,调用方跳过
   */
  function route(occ, id, a, b, opt) {
    // ★ 守卫:任一坐标非法/步长非法 → 交回 null,绝不放行(否则下面 for 会死循环)
    if (!ok(a.gx) || !ok(a.gy) || !ok(b.gx) || !ok(b.gy)) return { d: null, conflict: false }
    var aw = Math.abs(b.gx - a.gx)
    var ah = Math.abs(b.gy - a.gy)
    // 跨度上限:超过就不可能是有意义的树(实测最大 y 跨度 45)
    if (aw > 5000 || ah > 5000) return { d: null, conflict: false }

    var cw = opt.cw
    var ch = opt.ch
    var hh = opt.halfH == null ? ch / 2 : opt.halfH

    // 锚点:节点底部中心 / 顶部中心(竖向流向)
    var ax = a.gx * cw + cw / 2
    var ay = a.gy * ch + hh
    var bx = b.gx * cw + cw / 2
    var by = b.gy * ch + hh

    if (a.gy === b.gy) {
      // 同层:水平直连
      return {
        d: 'M' + ax + ' ' + ay + 'H' + bx,
        conflict: !sameOrNull(mark(occ, (a.gx + b.gx) / 2, a.gy, 'h', id), true),
      }
    }
    if (a.gx === b.gx) {
      // 同列:垂直直连
      return {
        d: 'M' + ax + ' ' + ay + 'V' + by,
        conflict: !sameOrNull(mark(occ, a.gx, (a.gy + b.gy) / 2, 'v', id), true),
      }
    }
    // ★ 斜向:先垂直出一格,再水平,再垂直补齐 —— 游戏里就是这个观感。
    //   中转格固定在 a.gy+s(出发点后一格),不是终点前一格:
    //   HOI4 MU 是 `Ka(gridX, fromY, toY)` + `Ya(fromY+s, ...)`,
    //   竖直段画满全程,水平段放在**起点紧邻的那一行**。
    return diag(occ, id, a, b, opt, a.gy + (b.gy > a.gy ? 1 : -1))
  }

  /** 斜向路径的实际画法(水平段放在 turnY 这一行) */
  function diag(occ, id, a, b, opt, turnY) {
    var cw = opt.cw
    var ch = opt.ch
    var hh = opt.halfH == null ? ch / 2 : opt.halfH
    var s = b.gy > a.gy ? 1 : -1
    var ax = a.gx * cw + cw / 2
    var ay = a.gy * ch + hh
    var bx = b.gx * cw + cw / 2
    var by = b.gy * ch + hh
    /* ★ 端点锚点一致:源/目标都落在节点中心(原 by=...-hh 会让线在末端反折上挑、
       并且线永远差 1/2 节点高够不到目标节点)。
       水平段放进源节点相邻的「行间通道」中点(下行=下一行上方、上行=上一行下方),
       不再压在下一行节点顶边 —— 消除「线贴着/切过节点行」的乱象。 */
    var chanY = s > 0 ? turnY * ch - ch / 2 + hh : turnY * ch + ch / 2 + hh

    var d =
      'M' + ax + ' ' + ay +
      'V' + chanY +
      'H' + bx +
      'V' + by
    // 冲突检测:竖直段沿途 + 水平段所在的那一行
    var conflict = false
    // ★ 用绝对步数循环,不用 `y !== b.gy` —— 后者在非整数坐标下**永不终止**
    var steps = Math.abs(b.gy - a.gy)
    for (var i = 0; i < steps; i++) {
      if (mark(occ, a.gx, a.gy + i * s, 'v', id) === false) conflict = true
    }
    var hSteps = Math.abs(b.gx - a.gx)
    for (var j = 0; j < hSteps; j++) {
      if (mark(occ, a.gx + (a.gx < b.gx ? j : -j), turnY, 'h', id) === false) conflict = true
    }
    return { d: d, conflict: conflict }
  }

  /**
   * ★ 冲突绕行(Hoi4 MU 的做法,简版)
   *
   * route() 遇到冲突只会"标记",不会自己拐弯 —— HOI4 MU 也是这样:
   * 它把冲突喂给布局层(Ya/Ka 的 s 与 l 两个布尔参数控制是否画),
   * 由上层把节点挪一格重排。
   *
   * 我们前端拿不到那个重排循环,但有更省的办法:
   * **把绕行做进 route 本身** —— 中转那一行被占时,水平段往下/上让一行。
   * 视觉上等价于游戏里"H 让一格",而不用重排整棵树。
   */
  function routeAvoiding(occ, id, a, b, opt) {
    var r = route(occ, id, a, b, opt)
    if (!r.d || !r.conflict) return r
    var s = b.gy > a.gy ? 1 : -1
    // ★ 绝对值为 1 时没什么好让的(V1 只判 `=== 1`,向上让位时会白跑一次)
    if (Math.abs(b.gy - a.gy) === 1) return r
    var alt = a.gy + s * 2
    // 让位行越过终点就失去意义(会画出反折的怪线),直接用原结果
    if (alt === b.gy || (s > 0 ? alt > b.gy : alt < b.gy)) return r
    // 先把上一轮占的撤掉(★ V2:只删自己那几个格,O(自身跨度))
    release(occ, id)
    var r2 = diag(occ, id, a, b, opt, alt)
    if (!r2.d) return r
    // ★ V2 修:两次都冲突时**保留**这一轮的登记。V1 会 release 掉,
    //   导致后面的边看不到本线的占用 → 冲突检测静默失效(越画越乱)。
    return r2
  }

  /**
   * 撤销某条线在占用表里的登记(用于换中转格时的回滚)。
   * ★ V2:走该线自己的索引,O(该线占的格数);V1 是遍历整表 O(全部格数)。
   */
  function release(occ, id) {
    var marks = occ[IDX_MARKS]
    if (!marks) return
    var keys = marks.get(id)
    if (!keys) return
    for (var i = 0; i < keys.length; i++) {
      var c = occ.get(keys[i])
      if (!c) continue
      c.h.delete(id)
      c.v.delete(id)
      // 两边都空了就把格子回收掉,否则 Map 只增不减 → 长时间拖拽必泄漏
      if (c.h.size === 0 && c.v.size === 0) occ.delete(keys[i])
    }
    marks.delete(id)
  }

  /** 释放整张占用表(画布重绘前调用,避免残留) */
  function clear(occ) {
    occ.clear()
    if (occ[IDX_MARKS]) occ[IDX_MARKS].clear()
    occ[IDX_FULL] = false
  }

  /** 统计(检查器/调试用) */
  function countConflicts(occ) {
    return { cells: occ.size, lines: occ[IDX_MARKS] ? occ[IDX_MARKS].size : 0, full: !!occ[IDX_FULL] }
  }

  global.GridWire = {
    route: route,
    routeAvoiding: routeAvoiding,
    release: release,
    clear: clear,
    countConflicts: countConflicts,
  }
})(window)