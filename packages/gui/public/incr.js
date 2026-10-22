/* incr.js —— 增量渲染(PERF_V2 公共件)
 *
 * 为什么需要:决议页一次要渲染 3000+ 张卡片,每张卡一个 innerHTML + 一个
 * <img> + 一次贴图挂载 —— 主线程被 DOM 构建吃掉几百毫秒,滚动时更卡。
 * 用户的描述是"运行时比较卡顿",而这正是最大的一块。
 *
 * 做法:先渲染首批(默认 100),底部放一个哨兵元素,滚到它可见时再追加下一批。
 * 只有真的滚过去才建 DOM,首屏时间与总 DOM 数同时降下来。
 *
 * 用法:
 *   Incr.mount(container, items, makeOne, { batch, onDone })
 *     container 滚动容器内的直接父元素(本件会自动找滚动父级)
 *     items     数据数组
 *     makeOne   (item, i) => HTMLElement
 * 再次调用 mount 会重置(换筛选条件时用)。
 */
;(function () {
  var DEF_BATCH = 100

  /** 向上找真正的滚动容器(overflow:auto/hidden/scroll) */
  function scrollParent(el) {
    var p = el.parentElement
    while (p && p !== document.body) {
      var ov = getComputedStyle(p).overflowY
      if (ov === 'auto' || ov === 'scroll') return p
      p = p.parentElement
    }
    return null
  }

  function mount(container, items, makeOne, opt) {
    opt = opt || {}
    var batch = opt.batch || DEF_BATCH
    container.innerHTML = ''
    if (!items || !items.length) return
    var root = opt.root || scrollParent(container) || null
    var i = 0
    var io = null
    var sentinel = null

    function more() {
      if (i >= items.length) {
        if (sentinel && sentinel.parentNode) sentinel.remove()
        if (io) io.disconnect()
        if (opt.onDone) opt.onDone(i)
        return
      }
      if (sentinel && sentinel.parentNode) sentinel.remove()
      var end = Math.min(i + batch, items.length)
      var frag = document.createDocumentFragment()
      for (; i < end; i++) {
        var el = makeOne(items[i], i)
        if (el) frag.appendChild(el)
      }
      if (i < items.length) {
        sentinel = document.createElement('div')
        sentinel.className = 'incr-more'
        sentinel.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--ink3);font-size:11px;padding:8px'
        sentinel.textContent = '加载更多…'
        frag.appendChild(sentinel)
      }
      container.appendChild(frag)
      if (opt.onBatch) opt.onBatch(i, items.length)
      if (sentinel) {
        if (!io && 'IntersectionObserver' in window) {
          io = new IntersectionObserver(
            function (es) {
              for (var k = 0; k < es.length; k++) if (es[k].isIntersecting) more()
            },
            { root: root, rootMargin: '240px' },
          )
        }
        if (io) io.observe(sentinel)
        else {
          // 兜底:没有 IO 就一次性渲染完,保证功能不丢
          while (i < items.length) {
            var e2 = makeOne(items[i], i)
            if (e2) container.appendChild(e2)
            i++
          }
        }
      }
    }

    more()
    return { more: more, get done() { return i >= items.length } }
  }

  window.Incr = { mount: mount, scrollParent: scrollParent }
})()
