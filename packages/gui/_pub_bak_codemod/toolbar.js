/* toolbar.js —— 顶栏筛选器折叠(UI_SLIM_V1 公共件)
 *
 * 用户反馈"所有页面看起来比较繁琐"。数了一下顶栏控件:
 *   designer 15 个、dlc 6 个、tech 5 个、doctrines 4 个……
 * 搜索框是高频的,下拉/勾选框多半只在特定场景用一次 —— 但一直占着位置。
 *
 * 做法:页面把"非高频筛选控件"所在的 .tgroup 标上 data-collapse,
 * 本件在它前面插一个「筛选」按钮,点击整组收起/展开,状态记在 localStorage。
 *
 * 用法(HTML):
 *   <div class="tgroup" data-collapse> <select id="dlcSel">…</select> </div>
 * 引入:<script src="/toolbar.js"></script>(放在页内脚本之前或之后都行,
 *       内部按 DOMContentLoaded 兜底)
 */
;(function () {
  var KEY = 'gui.filters'

  function boot() {
    var groups = document.querySelectorAll('header [data-collapse]')
    if (!groups.length) return
    var btn = document.createElement('button')
    btn.id = 'tbFilter'
    btn.className = 'icon'
    btn.type = 'button'

    var off = false
    try {
      off = localStorage.getItem(KEY) === 'off'
    } catch (e) {}

    function apply() {
      document.body.setAttribute('data-filters', off ? 'off' : 'on')
      btn.textContent = off ? '筛选 ⌄' : '筛选 ⌃'
      btn.classList.toggle('on', !off)
      btn.title = off ? '展开筛选器' : '收起筛选器'
    }

    btn.onclick = function () {
      off = !off
      try {
        localStorage.setItem(KEY, off ? 'off' : 'on')
      } catch (e) {}
      apply()
    }

    // 插在第一组之前:视觉顺序是「筛选按钮 + 被折叠的那几组」
    groups[0].parentNode.insertBefore(btn, groups[0])
    apply()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
