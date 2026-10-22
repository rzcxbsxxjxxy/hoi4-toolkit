/* ══════════════════════════════════════════════════════════════════
 * fullscreen.js —— 全站全屏(FULLSCREEN_V1 公共件)
 *
 * ★ 用户诉求:"应该能够全屏运行"
 *
 * 做"真全屏"(Fullscreen API)而不是"最大化窗口":
 *   · 最大化只是把浏览器窗口铺满,浏览器 chrome(地址栏/标签栏/书签栏)
 *     还占着一条,做数据核对时那一条就是纯浪费;
 *   · 真全屏把整块屏幕给 <body>,画布能多拿将近 100px 纵向,
 *     对本工作台这种"树 + 画布 + 侧栏"三栏布局是实打实的空间。
 *   · 顺带把 F11 让出来 —— 用户在别的应用里按 F11 是系统级的,
 *     不该被本页面抢走做网页全屏。
 *
 * ── 为什么不做成"进全屏就自动隐藏顶栏" ──
 *   全屏时顶栏要留着:它是唯一的"退出全屏"入口(ESC 也能退,但用户不一定知道),
 *   而且工作台的 15 个页面全靠它导航。全屏只把**纵向**的滚动条和窗口边框
 *   去掉,顶栏保持可见。
 *
 * ── 各页差异的处理 ──
 *   ① 有画布的页(focus/tech/doctrines/designer/ide):退全屏后必须
 *      重算画布尺寸 —— 画布用的是 clientWidth/Height,全屏切换会改它,
 *      不重算会出现"节点位置偏了/画布留白"。→ 派发 resize 事件,
 *      各页本来都监听 window resize(sizer.onChange 也是这么接的)。
 *   ② check.html / open.html:自带布局,只 body 变黑即可,无需特殊处理。
 *
 * ── 快捷键 ──
 *   F11        = 交还给浏览器(不抢)。用户要"真全屏"时按 F11 是浏览器行为,
 *               本件不监听,避免和"用户想在别的标签页按 F11"打架。
 *   mod+enter  = 进出全屏(绑到 keymap 目录,设置页可改)。
 *   f          已用于"缩放至适合窗口",不复用。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  var BTN_ID = 'fsBtn'
  var LS = 'gui.fullscreen'
  var el = null // 注入的按钮
  var forced = false // 用户偏好里强制全屏(进页就进)

  function docEl() {
    return document.documentElement
  }

  /** 浏览器是否支持真全屏(Fullscreen API;不认 prefixed 旧 API,那些机器早没了) */
  function supported() {
    var d = docEl()
    return !!(d.requestFullscreen || d.webkitRequestFullscreen)
  }

  function active() {
    var d = docEl()
    return !!(d.fullscreenElement || d.webkitFullscreenElement)
  }

  function request() {
    var d = docEl()
    var fn = d.requestFullscreen || d.webkitRequestFullscreen
    if (!fn) return Promise.reject(new Error('unsupported'))
    // ⚠ 必须 catch:用户按 Esc 拒绝、或策略禁止时会 reject,
    //   不接住就是一个 unhandledrejection 打到控制台。
    return Promise.resolve(fn.call(d, { navigationUI: 'hide' })).catch(function () {})
  }

  function exit() {
    var d = docEl()
    var fn = d.exitFullscreen || d.webkitExitFullscreen
    if (!fn || !active()) return Promise.resolve()
    return Promise.resolve(fn.call(d)).catch(function () {})
  }

  function toggle() {
    return active() ? exit() : request()
  }

  function label() {
    return active() ? '⤓ 退出全屏' : '⤢ 全屏'
  }

  function syncBtn() {
    if (el) el.textContent = label()
    document.body.classList.toggle('in-fullscreen', active())
  }

  function mount() {
    // ⚠ 幂等:nav.js 的 mountNav() 与本件的 boot() 都会调 mount(),
    //   而它们是两条独立的调用路径(谁先执行取决于 script 标签顺序)。
    //   必须按 **DOM** 判重,不能只靠闭包变量 —— 两次调用可能来自
    //   不同代码路径,闭包变量在各自的执行上下文里并不共享。
    var exist = document.getElementById(BTN_ID)
    if (exist) { el = exist; syncBtn(); return }
    /* ⚠ 导航宿主不止一种:多数页是 #nav,open.html 是 #topnav
     *   (它没有 <header>,导航固定在右上角)。两种都要认,
     *   否则"打开工程"页会没有全屏按钮。
     *   找不到宿主就静默返回 —— 不注入到 body 里瞎放。 */
    var nav = document.getElementById('nav') || document.getElementById('topnav')
    if (!nav) return
    var host = nav.querySelector('.navlinks') || nav
    el = document.createElement('button')
    el.id = BTN_ID
    el.className = 'fsbtn'
    el.textContent = label()
    el.title = '全屏 / 退出全屏(快捷键 Ctrl+Enter;F11 是浏览器的,本页面不抢)'
    el.onclick = function () { toggle() }
    // .navlinks 是 flex 容器,插到最前;open.html 的 #topnav 是普通块,
    // 插到最前也合理(全屏在"工作台"之前,视觉上作为"视图操作"更靠前)。
    host.insertBefore(el, host.firstChild)
    syncBtn()
  }

  function boot() {
    if (!supported()) return // 不支持就别注入按钮,免得点了没反应
    mount()
    // 状态变化:用户按 Esc 也会触发 fullscreenchange,所以两条路都要同步
    document.addEventListener('fullscreenchange', function () {
      syncBtn()
      // ★ 关键:画布尺寸变了必须让各页重算,否则节点位置全偏。
      //   延后一帧 —— change 事件触发时布局还没完成,立刻量会拿到旧值。
      setTimeout(function () { window.dispatchEvent(new Event('resize')) }, 60)
    })
    document.addEventListener('webkitfullscreenchange', syncBtn)
    // 记下本次会话的选择,下次进页面照旧
    document.addEventListener('fullscreenchange', function () {
      try { localStorage.setItem(LS, active() ? '1' : '0') } catch (e) { /* 隐私模式 */ }
    })
    // 用户之前要的是全屏 → 直接进
    try { forced = localStorage.getItem(LS) === '1' } catch (e) { /* 隐私模式 */ }
    if (forced && !active()) setTimeout(function () { request() }, 120)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  global.Fullscreen = {
    toggle: toggle,
    enter: request,
    exit: exit,
    active: active,
    supported: supported,
    label: label,
    mount: mount,
  }
// ⚠ 收尾必须传 window —— 声明是 (function (global) {...})。
  //   写成 `})()` 时 global 是 undefined,`global.Fullscreen = {...}` 会抛
  //   TypeError,于是**整个文件静默失效**:nav.js 轮询等不到 window.Fullscreen,
  //   全屏按钮不出现,快捷键里的"全屏"也只在有桩时才测得出。
  //   这个 bug 只有真跑一次公共件才暴露,语法检查是绿的。
})(window)
