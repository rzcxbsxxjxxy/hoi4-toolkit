/* ==========================================================
 * loadgate.js - per-page centered loading dialog (2026-10-10)
 * For lazy build: when a feature page's graph is not ready yet,
 * the page shows a small centered dialog (spinner + progress bar),
 * background does NOT block page interaction, and hides once ready.
 *
 * Usage:
 *   <script src="/loadgate.js"></script>
 *   window.LoadGate.show('正在加载科技树…')   // 数据未就绪
 *   window.LoadGate.progress(42)              // 可选,更新进度条
 *   window.LoadGate.hide()                    // 数据就绪,渲染完成
 *   window.LoadGate.busy()                    // 是否正在显示
 * ========================================================== */
(function () {
  var CSS =
    '.loadgate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(8,11,16,.4);opacity:1;transition:opacity .25s ease;pointer-events:none}' +
    '.loadgate.hide{opacity:0;pointer-events:none}' +
    '.loadgate .lg-panel{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:14px;' +
    'background:rgba(15,20,28,.94);border:1px solid rgba(120,160,200,.22);border-radius:12px;padding:24px 34px;min-width:280px;' +
    'box-shadow:0 14px 44px rgba(0,0,0,.5)}' +
    '.loadgate .lg-ring{width:54px;height:54px;border-radius:50%;border:4px solid rgba(255,255,255,.16);border-top-color:#4f8ef7;' +
    'animation:lgspin .9s linear infinite}' +
    '@keyframes lgspin{to{transform:rotate(360deg)}}' +
    '.loadgate .lg-bar{width:230px;height:6px;background:rgba(255,255,255,.16);border-radius:3px;overflow:hidden}' +
    '.loadgate .lg-bar i{display:block;height:100%;width:0;background:#4f8ef7;border-radius:3px;transition:width .25s ease}' +
    '.loadgate .lg-msg{color:#aab6c4;font-size:13px;letter-spacing:.03em;max-width:70vw;text-align:center}'
  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  function ensure() {
    var el = document.getElementById('loadgate')
    if (el) return el
    el = document.createElement('div')
    el.id = 'loadgate'
    el.className = 'loadgate hide'
    el.innerHTML = '<div class="lg-panel"><div class="lg-ring"></div><div class="lg-bar"><i id="lgBar"></i></div><div class="lg-msg" id="lgMsg"></div></div>'
    document.body.appendChild(el)
    return el
  }

  var timer = null
  var baseMsg = ''
  function lprogress(pct) {
    var bar = document.getElementById('lgBar')
    if (bar && typeof pct === 'number') bar.style.width = Math.max(0, Math.min(100, pct)) + '%'
  }
  function autoStep() {
    var p = 8
    var m = document.getElementById('lgMsg')
    clearInterval(timer)
    timer = setInterval(function () {
      p = Math.min(92, p + 2 + Math.random() * 5)
      lprogress(Math.round(p))
      if (m) m.textContent = baseMsg + ' · ' + Math.round(p) + '%'
    }, 140)
  }
  window.LoadGate = {
    show: function (msg) {
      var el = ensure()
      baseMsg = msg || '加载中…'
      var m = document.getElementById('lgMsg')
      if (m) m.textContent = baseMsg
      el.classList.remove('hide')
      autoStep()
    },
    progress: lprogress,
    hide: function () {
      clearInterval(timer); timer = null
      lprogress(100)
      var el = document.getElementById('loadgate')
      if (el) el.classList.add('hide')
    },
    busy: function () {
      var el = document.getElementById('loadgate')
      return !!el && !el.classList.contains('hide')
    }
  }
})()
