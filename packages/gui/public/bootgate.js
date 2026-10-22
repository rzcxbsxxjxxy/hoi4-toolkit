(function () {
  var el = document.getElementById('bootgate')
  var msgEl = document.getElementById('bgMsg')
  var barEl = document.getElementById('bgBar')
  if (!el) return
  var timer = null
  var readyCb = null
  /* ══ STICKY 模式(2026-10-10)══
   * 「保存并进入工作台」这类场景:调用方 show() 之后**马上**要切 iframe,
   * 但切页前后端 /api/status 可能已经 ready(索引重建在跳之前就完成了),
   * 于是旧逻辑 poll 第一轮就 finish → 遮罩一闪而过,而新页面还在白屏加载
   * ——用户看到的就是「白一下然后空白」。
   * sticky = 不认"当前这一帧已 ready",只认【切换后的新一帧】加载完成。
   * ★ 必须带超时安全网:万一 iframe 永远不 complete(池化异常/加载失败),
   *   遮罩会永久挡住平台,比白屏更糟。 */
  var stickyFrame = null
  var stickyT0 = 0
  var STICKY_MAX = 20000

  function setText(s) { if (msgEl) msgEl.textContent = s || '' }
  /** @param {boolean} [sticky] 等"切走之后的下一帧"ready 才收遮罩 */
  function show(msg, cb, sticky) {
    readyCb = cb || null
    stickyFrame = sticky ? document.querySelector('#content iframe.on') : null
    stickyT0 = sticky ? Date.now() : 0
    if (msg) setText(msg)
    el.classList.remove('hide')
    poll()
  }
  function hide() {
    el.classList.add('hide')
    readyCb = null
    stickyFrame = null
    if (timer) { clearTimeout(timer); timer = null }
  }
  /** 当前活动 iframe 是否已 complete;取不到(跨域/未挂载)返回 null */
  function frameReady(frame) {
    var on = frame || document.querySelector('#content iframe.on')
    if (!on) return null
    try {
      var w = on.contentWindow
      if (!w || !w.document) return null
      return w.document.readyState === 'complete' ? true : false
    } catch (e) { return null }
  }
  function poll() {
    if (el.classList.contains('hide')) return
    clearTimeout(timer)
    if (stickyFrame) {
      // sticky 只看"新帧是否加载完",不看后端(后端在切页前就已经 ready 了)
      var cur = document.querySelector('#content iframe.on')
      if (cur && cur !== stickyFrame && frameReady(cur) === true) { finish(); return }
      if (Date.now() - stickyT0 > STICKY_MAX) { finish(); return } // 安全网
      timer = setTimeout(poll, 250)
      return
    }
    fetch('/api/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        /* ★★ 收遮罩必须【两个条件同时满足】:后端 ready + 当前帧加载完。
         * 旧逻辑只看 frameReady() 就 finish —— 而 open.html 保存时自己早已
         * complete,于是「正在重建索引…」的遮罩刚显示就被收掉,露出还没
         * 数据的白屏(用户报的"画面消失"就是这个)。
         * fr === null 表示取不到(跨域/无帧),此时只信后端。 */
        var fr = frameReady()
        if (j && j.ready && fr !== false) { finish(); return }
        var m = (j && j.phase) ? j.phase : '正在初始化，请稍后'
        if (j && j.total > 0) {
          var pct = Math.round((j.done || 0) / j.total * 100)
          if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%'
          m += ' · ' + pct + '%'
        }
        var secs = Math.max(0, Math.floor((Date.now() - ((j && j.since) || Date.now())) / 1000))
        m += ' · ' + secs + 's'
        setText(m)
        timer = setTimeout(poll, 250)
      })
      .catch(function () { timer = setTimeout(poll, 400) })
  }
  function finish() {
    hide()
    var cb = readyCb
    readyCb = null
    if (cb) try { cb() } catch (e) {}
  }
  /* ★ 只"看着办":后端未就绪就挂遮罩,就绪就什么都不做。
   * 与 ensure() 的区别:不接管回调、不阻塞调用方 —— 用于 nav.js 那种
   * "先切页、遮罩只是附带的反馈" 的场景。 */
  function watch() {
    if (el.classList.contains('hide') === false) return // 已经在转了
    fetch('/api/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j && !j.ready) show('正在初始化，请稍后') })
      .catch(function () {})
  }
  /** @param {Function} cb 后端就绪(或判定超时)后执行 —— 【保证会调用一次】 */
  function ensure(cb) {
    /* ★ 超时兜底(2026-10-10):后端重构建期间 /api/status 会排队,
     * 实测符号库阶段连续 5 秒都没响应。旧代码没有超时,cb 就一直不执行
     * → 依赖它的动作(比如切页)永远不触发。等技术上"在忙",那就先放行,
     *   页面里各自的 busy 重试会把真实状态补上。 */
    var settled = false
    var once = function (ready) {
      if (settled) return
      settled = true
      if (ready) { if (cb) cb(); return }
      show('正在初始化，请稍后', cb)
    }
    var timer2 = setTimeout(function () { once(true) }, 2000)
    fetch('/api/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        clearTimeout(timer2)
        once(j && j.ready)
      })
      .catch(function () { clearTimeout(timer2); once(true) })
  }
  window.BootGate = { show: show, hide: hide, ensure: ensure, watch: watch }
})()
