/* edgepath.js —— 展示图连线统一成「略微弯曲的折线」(2026-10-04 引入,2026-10 修正)。
 *
 * 用户口径:折线的角不是尖的直角拐,而是带一点圆角的肘形(圆角肘形折线),
 * 比纯直线有方向感、比大 S 曲线克制。国策树 / 科技树 / MIO 特质树三处共用,
 * 勿在各页再抄一份(历史上贴图加载器抄了 4 份全坏,引以为戒)。
 *
 * 用法(经典脚本,函数挂全局):
 *   path.setAttribute('d', edgePathD(x1, y1, x2, y2, 10))
 *   path.setAttribute('d', edgePathD(x1, y1, x2, y2, 10, 'v'))  // 强制竖向肘形
 *
 * 形状规则:
 *   - 主轴为「竖向」(树的父子边,父在上子在下)→ 中段水平走线,两直角拐各用二次贝塞尔圆角;
 *   - 主轴为「横向」(左→右的流向)→ 中段竖向走线,同理;
 *   - 几乎共线 → 退化为直线;
 *   - r 是圆角半径,自动收缩到线段长度允许的最大值,永不画过头。
 *
 * ★★★ 2026-10 修正(弯曲方向错误):
 *   原版按 |dy| >= |dx| 自动选主轴。对"父在上、子在下"的树(国策/科技)来说,
 *   一旦子节点被放到很偏右但只低一点点(|dx|>|dy|)的位置,就会退化成"先横向出、再竖向进"
 *   —— 线从父节点底部先往旁边横着走,视觉上像从侧面溜出去,很不美观。
 *   所以新增 axis 参数:
 *     axis 省略 / 'auto' → 按 |dx| vs |dy| 自动(适合 MIO 中心对中心任意方向)
 *     axis = 'v'         → 强制竖向肘形(父底部先向下出、中段横走、子顶部向下进)★ 国策/科技用
 *     axis = 'h'         → 强制横向肘形(父右侧先向右出、中段竖走、子左侧向右进)
 *   这样"父在上"的树永远是从父底部往下走,弯曲方向恒定正确。
 */
function edgePathD(x1, y1, x2, y2, r, axis) {
  if (r == null) r = 10
  var dx = x2 - x1
  var dy = y2 - y1
  // 同点 / 几乎共线:直线
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2
  var vertical
  if (axis === 'v') vertical = true
  else if (axis === 'h') vertical = false
  else vertical = Math.abs(dy) >= Math.abs(dx)
  return vertical ? _vElbow(x1, y1, x2, y2, r, dx, dy) : _hElbow(x1, y1, x2, y2, r, dx, dy)
}

/* 竖向主轴肘形:从 (x1,y1) 向下走、中段水平、到 (x2,y2) 从顶部向下进。
 * 无论父在上(dy>0)还是反向(dy<0),都按这个语义圆角,方向恒定正确。 */
function _vElbow(x1, y1, x2, y2, r, dx, dy) {
  var my = y1 + dy / 2
  var s = dx > 0 ? 1 : -1
  var rr = Math.min(r, Math.abs(dx) / 2, Math.abs(my - y1), Math.abs(y2 - my))
  if (rr < 0.5) return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2
  return (
    'M' + x1 + ' ' + y1 +
    ' L' + x1 + ' ' + (my - rr) +
    ' Q' + x1 + ' ' + my + ' ' + (x1 + s * rr) + ' ' + my +
    ' L' + (x2 - s * rr) + ' ' + my +
    ' Q' + x2 + ' ' + my + ' ' + x2 + ' ' + (my + rr) +
    ' L' + x2 + ' ' + y2
  )
}

/* 横向主轴肘形:从 (x1,y1) 向右走、中段竖向、到 (x2,y2) 从左侧向右进。 */
function _hElbow(x1, y1, x2, y2, r, dx, dy) {
  var mx = x1 + dx / 2
  var s2 = dy > 0 ? 1 : -1
  var rr2 = Math.min(r, Math.abs(dy) / 2, Math.abs(mx - x1), Math.abs(x2 - mx))
  if (rr2 < 0.5) return 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2
  return (
    'M' + x1 + ' ' + y1 +
    ' L' + (mx - rr2) + ' ' + y1 +
    ' Q' + mx + ' ' + y1 + ' ' + mx + ' ' + (y1 + s2 * rr2) +
    ' L' + mx + ' ' + (y2 - s2 * rr2) +
    ' Q' + mx + ' ' + y2 + ' ' + (mx + rr2) + ' ' + y2 +
    ' L' + x2 + ' ' + y2
  )
}

window.edgePathD = edgePathD
