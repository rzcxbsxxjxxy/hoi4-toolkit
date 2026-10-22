/**
 * 面板宽度可调 —— 通用 splitter。
 *
 * ★ 用户需求(2026-10):"除了顶部的栏外,每个控件(例如显示窗、检查器等)
 *   应该能调整宽窄,而不是固定的"。
 *
 * ★ 为什么做成通用件而不是每页各写:
 *   三栏页(focus / tech / dlc / doctrines / decisions / events / loc / designer /
 *   ide / check / open)有 11+ 个,每页各写一遍拖拽逻辑就是 11 份 bug。
 *   这里一次实现,各页只声明"哪个侧栏可调 + 宽度写哪条 CSS 变量"。
 *
 * ★ 设计要点:
 *   1) 宽度存 CSS 变量(--sideL / --sideR),页面布局本身不写死 px,
 *      这样 splitter 改的就是**布局真实用的那个值**,不需要额外同步。
 *   2) localStorage 持久化(键带页面路径),换页回来宽度还在。
 *   3) 双击分隔条 = 复位默认宽度(用户最容易发现的"怎么还原")。
 *   4) 双击侧栏本体 = 折叠/展开。侧栏是显示窗/检查器,折叠后画布全宽,
 *      比把它拖到 0 宽好用得多。
 *   5) 双击边缘(离分隔条很近但不在分隔条上)= 沿用浏览器原生 auto 尺寸,
 *      应对"内容比默认值宽"的页(如某些树的标题很长)。
 *   6) 拖拽时给 body 加 class 禁掉文字选中,否则鼠标一拖就选中一片文本。
 *
 * 用法:
 *   Sizer.mount('#left', 'left')             // 左侧栏,var = --sideL
 *   Sizer.mount('#right', 'right', 300)      // 右侧栏,var = --sideR,默认 300
 *   Sizer.mountAll()                         // 扫描 [data-sizer] 自动挂载
 */
;(function (global) {
  'use strict'

  var STORE_KEY = 'gui.sizes'
  var MIN = 160 // 再窄就没法看内容了
  var EDGE = 6 // 双击"贴边自动"判定半径

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}
    } catch (e) {
      return {}
    }
  }
  function writeStore(o) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(o))
    } catch (e) {
      /* 忽略 */
    }
  }

  function pageKey() {
    return location.pathname.replace(/\.html$/, '') || '/'
  }

  function storageKey(side) {
    return pageKey() + '#' + side
  }

  var mounted = []

  /**
   * @param {string} sel 侧栏选择器
   * @param {'left'|'right'} side 贴哪边(决定分隔条放内侧、拖拽方向)
   * @param {number} [defW] 默认宽度(px);不给则读元素当前 offsetWidth
   */
  function mount(sel, side, defW) {
    var el = document.querySelector(sel)
    if (!el) return null
    if (el.dataset.sizerMounted) return el.__sizer || null
    var bar = el.__sizer
    if (!bar) return null

    var fallback = defW || el.offsetWidth || (side === 'left' ? 300 : 320)
    var store = readStore()
    var saved = store[storageKey(side)]
    var cur = typeof saved === 'number' && saved >= MIN ? saved : fallback

    function varName() {
      return side === 'left' ? '--sideL' : '--sideR'
    }
    function apply(w) {
      cur = Math.max(MIN, Math.round(w))
      el.style.setProperty(varName(), cur + 'px')
      el.style.width = cur + 'px'
    }
    apply(cur)

    /* ── 拖拽 ── */
    var drag = null
    bar.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      ev.preventDefault()
      ev.stopPropagation()
      drag = { x: ev.clientX, w: cur }
      bar.setPointerCapture(ev.pointerId)
      document.body.classList.add('sizer-dragging')
    })
    bar.addEventListener('pointermove', function (ev) {
      if (!drag) return
      // 左栏往右拖变宽,右栏往左拖变宽 → 方向相反
      var d = side === 'left' ? ev.clientX - drag.x : drag.x - ev.clientX
      apply(drag.w + d)
    })
    function endDrag(ev) {
      if (!drag) return
      drag = null
      document.body.classList.remove('sizer-dragging')
      try {
        bar.releasePointerCapture(ev.pointerId)
      } catch (e) {
        /* 指针已释放 */
      }
      store[storageKey(side)] = cur
      writeStore(store)
      window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    }
    bar.addEventListener('pointerup', endDrag)
    bar.addEventListener('pointercancel', endDrag)

    /* ── 双击分隔条:复位默认 ── */
    bar.addEventListener('dblclick', function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
      apply(fallback)
      store[storageKey(side)] = fallback
      writeStore(store)
      window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    })

    /* ── 双击侧栏本体:折叠/展开 ── */
    el.addEventListener('dblclick', function (ev) {
      // 别在输入框/文本上双击时触发
      var t = ev.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // 贴着分隔条的双击 → 让给 bar 的复位逻辑(事件序上 bar 先跑)
      var r = el.getBoundingClientRect()
      var nearEdge = side === 'left' ? ev.clientX - r.left < EDGE : r.right - ev.clientX < EDGE
      if (nearEdge) return
      ev.preventDefault()
      if (el.classList.contains('sizer-collapsed')) {
        el.classList.remove('sizer-collapsed')
        apply(cur)
        store[storageKey(side)] = cur
      } else {
        cur = el.offsetWidth
        el.classList.add('sizer-collapsed')
        store[storageKey(side)] = cur
      }
      writeStore(store)
      window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    })

    /* ── 双击【屏幕边缘】:恢复 auto(交给内容撑开) ──
       某些树的标题/条目比默认宽,用户拖不动更宽时用这招。 */
    el.addEventListener('dblclick', function (ev) {
      var r = el.getBoundingClientRect()
      var atEdge = side === 'left' ? ev.clientX - r.left < EDGE : r.right - ev.clientX < EDGE
      if (!atEdge) return
      var t = ev.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      ev.preventDefault()
      ev.stopPropagation()
      el.style.removeProperty(varName())
      el.style.width = ''
      el.classList.remove('sizer-collapsed')
      cur = el.offsetWidth
      window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    })

    /* ── 折叠态:留一个竖条抓手,不然双击展开找不着 ── */
    var grip = document.createElement('div')
    grip.className = 'sizer-grip'
    grip.title = '双击展开'
    el.appendChild(grip)
    grip.addEventListener('dblclick', function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
      el.classList.remove('sizer-collapsed')
      apply(cur)
      store[storageKey(side)] = cur
      writeStore(store)
      window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    })

    el.dataset.sizerMounted = '1'
    el.__sizer = bar
    mounted.push({ el: el, bar: bar, apply: apply })
    window.dispatchEvent(new CustomEvent('sizer:change', { detail: { side: side, w: cur } }))
    return el.__sizerApi || (el.__sizerApi = { apply: apply, el: el, bar: bar, get width() { return cur } })
  }

  /** 扫描 [data-sizer="left|right"] 自动挂载 */
  function mountAll() {
    var els = document.querySelectorAll('[data-sizer]')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      var side = el.dataset.sizer === 'right' ? 'right' : 'left'
      var defW = el.dataset.sizerDef ? Number(el.dataset.sizerDef) : undefined
      mount('#' + el.id, side, defW)
    }
  }

  /** 重算画布尺寸(分隔条加了 5px 宽,画布可用宽度会变) */
  function onChange(fn) {
    window.addEventListener('sizer:change', fn)
    window.addEventListener('resize', fn)
  }

  global.Sizer = {
    mount: mount,
    mountAll: mountAll,
    onChange: onChange,
    mounted: mounted,
    store: readStore,
  }
})(window)