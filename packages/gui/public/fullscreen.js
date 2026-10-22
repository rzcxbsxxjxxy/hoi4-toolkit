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
    // ★ 根因修复:fullscreenElement 是 document 的属性,documentElement 上没有它。
    //   旧写法 docEl().fullscreenElement 恒为 undefined → active() 恒 false,
    //   于是 toggle 永远走 request()(无法退出)、按钮永远显示"全屏"。
    var d = document
    return !!(d.fullscreenElement || d.webkitFullscreenElement)
  }

  function request() {
    var d = docEl()
    var fn = d.requestFullscreen || d.webkitRequestFullscreen
    if (!fn) return Promise.reject(new Error('unsupported'))
    // ⚠ 必须 catch:用户按 Esc 拒绝、或策略禁止时会 reject,
    //   不接住就是一个 unhandledrejection 打到控制台。
    return Promise.resolve(fn.call(d, { navigationUI: 'hide' }))
      .then(function () {
        // ★ 手动全屏也记偏好 → 切页后 FULLSCREEN_V2 首次手势恢复(跨页保持)
        forced = true
        try { localStorage.setItem(LS, '1') } catch (e) { /* 隐私模式 */ }
      })
      .catch(function () {})
  }

  function exit() {
    // ★ 根因修复:exitFullscreen 是 document 的方法,documentElement 上没有。
    //   旧写法 docEl().exitFullscreen 恒为 undefined → fn 为空 → 永远无法退出全屏。
    var d = document
    var fn = d.exitFullscreen || d.webkitExitFullscreen
    if (!fn || !active()) return Promise.resolve()
    return Promise.resolve(fn.call(d))
      .then(function () {
        forced = false
        try { localStorage.setItem(LS, '0') } catch (e) { /* 隐私模式 */ }
      })
      .catch(function () {})
  }

  function toggle() {
    // ★ 手动点按钮 = 用户明确表态,不再等「首次手势」自动恢复
    disarm()
    removeHint()
    return active() ? exit() : request()
  }

  function label() {
    return active() ? '⤓ 退出全屏' : '⤢ 全屏'
  }

  function syncBtn() {
    // ★ 用 query 取当前 DOM 按钮:导航可能重建导航把旧 el 节点换掉,闭包 el 会失焦导致按钮不更新
    var b = document.getElementById(BTN_ID)
    if (b) b.textContent = label()
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
    /* 点击改走 boot() 的事件委托(按钮可能被 nav 重建,事件委托不受 DOM 替换影响) */
    // .navlinks 是 flex 容器,插到最前;open.html 的 #topnav 是普通块,
    // 插到最前也合理(全屏在"工作台"之前,视觉上作为"视图操作"更靠前)。
    host.insertBefore(el, host.firstChild)
    syncBtn()
  }

  /* ══════════════════════════════════════════════════════════════════
   * ★ 跨页保持(FULLSCREEN_V2)—— 用户 2026-10-07 报"点到全屏后切页又被取消"
   *
   * 根因不在恢复逻辑写没写,而在于**浏览器根本不会批准那次请求**:
   *   Fullscreen API 的 fullscreenElement 是【文档(document)级】状态,
   *   导航 = 销毁旧文档 + 载入新文档 → 新文档必然不在全屏。
   *   而 requestFullscreen() 规范要求【必须有用户手势(user activation)】,
   *   页面加载时自己调用属于"无手势",Chrome / Edge 一律 reject。
   *   所以旧版的 `if (forced && !active()) setTimeout(request, 120)`
   *   是 100% 静默失败的 —— catch 吞掉了 reject,页面表现就是"全屏被取消"。
   *
   * 正确做法:把恢复动作挂到**用户的第一次真实手势**上。
   *   pointerdown / keydown 都是有效的用户激活,浏览器会批准,
   *   于是"切页后第一次点击"顺手就把全屏接回来,用户几乎无感。
   *
   * 同时给一个可见提示(而不是静默恢复):用户可能不想全屏,
   *   静默强制会剥夺 ESC 之外的选择权。提示条只显示到第一次交互为止。
   *
   * ⚠ 别再在 load 期直接 request —— 那是本次修复要消灭的行为。
   * ══════════════════════════════════════════════════════════════════ */
  var armed = false // 已挂上「首次手势恢复」监听
  var hintEl = null

  function removeHint() {
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl)
    hintEl = null
  }

  function onFirstGesture() {
    if (!forced || active()) return
    // 手势确实被消费掉了,监听器必须摘,否则每次点击都会重试
    disarm()
    request().then(function () {
      if (active()) removeHint()
    })
  }

  function disarm() {
    armed = false
    document.removeEventListener('pointerdown', onFirstGesture, true)
    document.removeEventListener('keydown', onFirstGesture, true)
  }

  /** 可见提示:告诉用户「点一下就恢复全屏」,并给一个明确的取消入口 */
  function showHint() {
    if (hintEl || !forced) return
    var h = document.createElement('div')
    h.className = 'fs-hint'
    h.innerHTML =
      '<span class="fs-hint-tx">切换页面后浏览器会退出全屏 —— 点击页面任意处即可恢复</span>' +
      '<button type="button" class="fs-hint-no">本次不再提示</button>'
    document.body.appendChild(h)
    hintEl = h
    h.querySelector('.fs-hint-no').onclick = function (ev) {
      ev.stopPropagation()
      // 关掉本次会话的偏好,否则下一页还会再提示
      forced = false
      try { localStorage.setItem(LS, '0') } catch (e) { /* 隐私模式 */ }
      disarm()
      removeHint()
    }
  }

  /** 装上「首次手势恢复」。幂等 —— boot 可能被 mount 之外的路再调一次。 */
  function armRestore() {
    if (armed) return
    armed = true
    document.addEventListener('pointerdown', onFirstGesture, true)
    document.addEventListener('keydown', onFirstGesture, true)
    showHint()
  }

  function boot() {
    if (!supported()) return // 不支持就别注入按钮,免得点了没反应
    mount()
    // ★ 事件委托:按钮可能被导航重建,DOM 级监听保证点击始终能触发 toggle
    document.addEventListener('click', function (ev) {
      var t = ev.target
      var b = t && t.closest ? t.closest('#' + BTN_ID) : null
      if (b) toggle()
    }, false)
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
      var on = active()
      try { localStorage.setItem(LS, on ? '1' : '0') } catch (e) { /* 隐私模式 */ }
      // 已经真的进/退了全屏 → 提示条与待恢复监听都没意义了
      if (on) { disarm(); removeHint() }
    })
    // 用户之前要的是全屏 → 挂上首次手势恢复(**不是**直接 request,见上文)
    try { forced = localStorage.getItem(LS) === '1' } catch (e) { /* 隐私模式 */ }
    if (forced && !active()) {
      if (document.readyState === 'complete') armRestore()
      else window.addEventListener('load', armRestore, { once: true })
    }
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
