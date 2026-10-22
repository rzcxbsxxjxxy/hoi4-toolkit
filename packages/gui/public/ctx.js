/* ══════════════════════════════════════════════════════════════════
 * ctx.js —— 全站右键菜单框架(RIGHTCLICK_V1 公共件)
 *
 * ★ 为什么要有这个文件
 *
 * 用户诉求:"大量补充鼠标右键功能,更贴近 VS Code 的使用习惯,
 *          右键要能跳到 IDE 里当前部件所在代码的位置,便于查找"。
 *
 * 之前的状态:
 *   - 只有 IDE 页的**文件树**有右键菜单(新建/重命名/删除/复制路径),
 *     而且是写在 ide.js 内部私有的 showCtxMenu(),别的页面一行都用不到。
 *   - 国策/科技/学说/DLC/事件/决议这些"看内容"的页面,
 *     鼠标右键完全没有交代 —— 系统菜单直接弹出来,
 *     想从"这个国策"回到"它写在哪个文件第几行"只能自己去翻。
 *
 * ★ 关键前提:后端早就把位置信息发下来了,只是一直没人用
 *   /api/focus/graph 的 node 带 file + line + defs[] 覆盖链
 *   /api/tech/graph  的 node/folder 带 file + line
 *   /api/doctrines/graph 的 grand/track/sub 带 file + line
 *   (引擎侧 focus.ts / tech.ts / doctrines.ts 都记了 lineOf(doc, e))
 *   所以本件纯粹是"把已有数据接到界面上",不动后端数据结构。
 *
 * ── 设计要点 ──
 * ① 样式**由本件自注入**(读 theme-vars.css 的变量),
 *    各页面不用改一行 CSS —— 11 个页面逐个加样式是典型的重复劳动。
 * ② 菜单项统一 { label, k, hint, act, danger, sep, sub } 结构,
 *    hint 用来右侧显示快捷键提示,和 VS Code 的右键菜单观感一致。
 * ③ attach() 用**事件委托**(挂在容器上,按 selector 匹配),
 *    页面重绘 innerHTML 后无需重新绑定 —— focus/tech 的画布
 *    每次 render() 都重建全部节点,逐元素绑定会立刻失效。
 * ④ 键盘可达:↑↓ 移动、Enter 执行、Esc 关闭、Home/End 跳首尾。
 *    右键菜单只靠鼠标是残缺的,这是无障碍底线也是 VS Code 的做法。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'
  if (global.__CTX_LOADED__) return // DEFAULT_CTX guard:同一文档重复加载时只生效一次(壳层+子页可能各引一次)
  global.__CTX_LOADED__ = true

  var MENU_ID = 'ctxMenuRoot'
  var cur = null // 当前展开的菜单 { el, items, sel, cleanup[] }

  /* ── 样式:自注入一次,跟随主题变量 ── */
  var CSS = [
    '#' + MENU_ID + '{position:fixed;z-index:2147483647;display:none;min-width:190px;max-width:380px;',
    'background:var(--panel);border:1px solid var(--line);border-radius:var(--r,5px);',
    'box-shadow:var(--shadow-lg,0 10px 40px rgba(20,30,50,.16));padding:4px 0;',
    'font-size:var(--ctl-font,13px);color:var(--ink);user-select:none;',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
    '#' + MENU_ID + '.on{display:block}',
    '#' + MENU_ID + ' .ctx-i{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;white-space:nowrap}',
    '#' + MENU_ID + ' .ctx-i:hover{background:var(--accent-soft);color:var(--accent)}',
    '#' + MENU_ID + ' .ctx-i.sel{background:var(--accent-soft);color:var(--accent)}',
    '#' + MENU_ID + ' .ctx-i.dis{opacity:.42;cursor:default}',
    '#' + MENU_ID + ' .ctx-i.dis:hover{background:transparent;color:var(--ink)}',
    '#' + MENU_ID + ' .ctx-i.danger:hover{background:var(--danger-soft);color:var(--danger)}',
    '#' + MENU_ID + ' .ctx-i .k{width:14px;text-align:center;color:var(--ink3);flex:0 0 auto}',
    '#' + MENU_ID + ' .ctx-i .lb{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis}',
    '#' + MENU_ID + ' .ctx-i .hn{flex:0 0 auto;color:var(--ink3);font-size:.9em;margin-left:14px}',
    '#' + MENU_ID + ' .ctx-i:hover .hn{color:var(--accent)}',
    '#' + MENU_ID + ' .ctx-s{height:1px;background:var(--line2);margin:4px 0}',
    '#' + MENU_ID + ' .ctx-t{padding:4px 12px 6px;color:var(--ink3);font-size:.9em;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid var(--line2);margin-bottom:4px}',
    ':root[data-bg="image"] #' + MENU_ID + '{background:var(--glass-raise,rgba(255,255,255,.72));',
    'backdrop-filter:blur(12px) saturate(1.15);-webkit-backdrop-filter:blur(12px) saturate(1.15)}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById('ctxStyle')) return
    var s = document.createElement('style')
    s.id = 'ctxStyle'
    s.textContent = CSS
    document.head.appendChild(s)
  }

  /* ── 小工具 ── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }
  function menuEl() {
    var el = document.getElementById(MENU_ID)
    if (!el) {
      ensureStyle()
      el = document.createElement('div')
      el.id = MENU_ID
      document.body.appendChild(el)
    }
    return el
  }

  /* 复制到剪贴板:优先 async API,失败退回 execCommand。
   * ⚠ file:// 或非安全上下文下 navigator.clipboard 不可用,
   *   所以必须有兜底,否则"复制 id"在部分环境下静默失败。 */
  function copy(text, label) {
    var done = function (ok) {
      toast(ok ? tr('已复制') + (label ? ':' + label : '') : '复制失败', !ok)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true) },
        function () { legacy(text, done) },
      )
    } else legacy(text, done)
  }
  function legacy(text, done) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(ta)
      ta.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(ta)
      done(!!ok)
    } catch (e) { done(false) }
  }

  /** 提示条:优先复用页面自己的 #toast(各页都有),否则自建一个 */
  function toast(msg, bad) {
    var el = document.getElementById('toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'toast'
      el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:500'
      document.body.appendChild(el)
    }
    el.textContent = msg
    el.className = 'on' + (bad ? ' bad' : '')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { el.className = '' }, 2400)
  }

  /* 来源绝对路径缓存(复制绝对路径 / 外部编辑器用) */
  var srcCache = null
  function sources() {
    if (srcCache) return Promise.resolve(srcCache)
    return fetch('/api/sources')
      .then(function (r) { return r.json() })
      .then(function (j) {
        srcCache = j.sources || []
        return srcCache
      })
      .catch(function () { return [] })
  }

  /**
   * 来源序号解析(RIGHTCLICK_ROOT_V1)。
   *
   * 右键菜单是**同步**构建的(不能 await),而来源清单是异步拉的。
   * 所以:先用条目自带的 `root`;没有或非法时,拿 `rootName` 去已经
   * 在内存里的 `srcCache` 反查。`srcCache` 由各页面正常加载时
   * 调过 sources() 填好(内容页都会拉一次来源清单来渲染来源选择器),
   * 所以右键时它通常已经在手 —— 同步查表成立。
   *
   * 查不到返回 -1,调用方据此隐藏跳转项(而不是静默打开 vanilla 的同名文件)。
   */
  function resolveRoot(root, rootName) {
    if (typeof root === 'number' && root >= 0) return root
    /* 字符串数字也认('1' 来自某些 URL 参数) */
    if (root != null && root !== '' && !isNaN(Number(root)) && Number(root) >= 0) return Number(root)
    if (!rootName || !srcCache) return -1
    for (var i = 0; i < srcCache.length; i++) {
      if (srcCache[i] && srcCache[i].name === rootName) return i
    }
    return -1
  }

  /* ★ 预热来源清单(RIGHTCLICK_ROOT_V1)。
   *   resolveRoot 是**同步**的(右键菜单不能 await),所以 srcCache 必须在
   *   用户第一次右键**之前**就在手。原先只靠各页面自己调 sources() 填,
   *   于是「页面没调过 → srcCache 为 null → resolveRoot 一律返回 -1」。
   *   模块加载时先发起一次(不 await,失败也无妨),把窗口缩到最小。 */
  if (typeof fetch === 'function') { try { sources() } catch (e) { void e } }

  /* ══════════════════════════════════════════════════════════
   * 核心:在 IDE 里打开某个位置
   *
   * 用 hash 而不是 query —— 这样文件内容不会因为参数变化而被
   * 浏览器当成新资源重载,IDE 页监听 hashchange 就能就地跳转。
   * 已经在 IDE 页时直接改 hash(不刷新、不丢已开标签)。
   * ══════════════════════════════════════════════════════════ */
  function ideUrl(root, file, line) {
    return '/ide#root=' + encodeURIComponent(root) + '&file=' + encodeURIComponent(file) +
      (line ? '&line=' + encodeURIComponent(line) : '')
  }
  function jumpIde(root, file, line) {
    if (!file) { toast('该条目没有源文件位置', true); return }
    var h = '#root=' + encodeURIComponent(root) + '&file=' + encodeURIComponent(file) +
      (line ? '&line=' + encodeURIComponent(line) : '')
    var onIde = /\/ide(\.html)?$/.test(location.pathname)
    if (onIde) {
      location.hash = h
      global.dispatchEvent(new HashChangeEvent('hashchange'))
    } else {
      location.href = '/ide' + h
    }
  }

  /* ══════════════════════════════════════════════════════════
   * 用系统外部编辑器(VS Code)打开
   *
   * ★ 2026-10-05 加前置检测(用户报"秒闪退 / 打开错文件,应该先检测是否安装")。
   *   服务端原来只有 open-external 盲试:VS Code 没装、装在非默认目录、
   *   还是权限被拦,用户看到的都是同一句"点了没反应",无从判断。
   *   现在先问 /api/vscode-detect 拿结论,再决定怎么打:
   *     · 没装       → 直接说明 + 给下载链接,**不要**再去试系统默认编辑器
   *                    (悄悄用别的程序打开会让人以为"VS Code 打开了")
   *     · 装了       → 报出用的是哪个可执行文件,再去 open-external
   *   结果缓存 60s(server 侧),但用户点菜单是低频,不必每次都等。
   * ══════════════════════════════════════════════════════════ */
  var vscodeProbe = null // {at, val}
  function probeVSCode(force) {
    var now = Date.now()
    if (!force && vscodeProbe && now - vscodeProbe.at < 60000) return Promise.resolve(vscodeProbe.val)
    return fetch('/api/vscode-detect' + (force ? '?refresh=1' : ''))
      .then(function (r) { return r.json() })
      .then(function (j) { vscodeProbe = { at: Date.now(), val: j }; return j })
      .catch(function () { return { found: false, candidates: [] } })
  }

  function vscodeOpen(root, file, line, opt) {
    opt = opt || {}
    if (!file) { toast('该条目没有源文件位置', true); return }
    var lineNo = line || 1
    toast('正在检测 VS Code…')
    probeVSCode(opt.forceProbe).then(function (d) {
      if (!d || !d.found) {
        var msg = '未检测到 VS Code。'
        if (d && d.searched && d.searched.length) msg += tr('已查找:') + d.searched.join('、')
        toast(msg, true)
        // 给下载入口而不是干瞪眼
        if (opt.onMissing) opt.onMissing(d)
        else if (confirm(msg + tr('\n\n是否打开 VS Code 官网下载页?'))) location.href = 'https://code.visualstudio.com/download'
        return
      }
      var via = (d.candidates && d.candidates[0] && d.candidates[0].path) || ''
      void via // 探测到的路径由服务端 open-external 内部复用,这里只用于日志/将来直连
      return fetch('/api/open-external?root=' + encodeURIComponent(root) + '&file=' + encodeURIComponent(file) +
        '&line=' + encodeURIComponent(lineNo))
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (j.error) { toast(tr('打开失败:') + j.error, true); return }
          if (j.protocol) {
            toast('服务端无法直接启动程序,正在用 vscode:// 协议打开…')
            location.href = j.protocol
            return
          }
          var name = j.via ? String(j.via).split(/[\\/]/).pop() : 'VS Code'
          // ⚠ 更新未完成时优先报这个:新旧资源并存会让 CLI 拉起即退,
          //   用户看到的还是"闪退",必须点明真正的原因。
          if (j.updating) {
            toast(tr('⚠ VS Code 正在更新中,启动不稳定。建议先让它更新完(或重启一次系统);') +
              tr('本次已尝试:') + (j.via ? name : '未成功'), true)
            return
          }
          toast(tr('已用 ') + name + tr(' 打开 ') + String(file).split(/[\\/]/).pop() + ':' + (j.line || lineNo) +
            (j.note ? ' · ' + j.note : ''))
        })
        .catch(function (e) { toast(tr('打开失败:') + e, true) })
    })
  }

  /* ══════════════════════════════════════════════════════════
   * 标准源码菜单 —— 各内容页右键时都复用这一份
   *
   * src = { root, rootName, file, line, id, loc, defs, extra }
   *   root/rootName  来源序号与名字(多模组时要说清是哪份文件)
   *   file/line      源文件与行号 —— 没有就不给"跳转"项
   *   id             标识符(国策 id / 科技 id / 学说 id),用于复制
   *   loc            本地化 key(和 id 不一定相同!)
   *   defs[]         全部定义位置(覆盖链),有值时加"看全部定义位置"
   *   extra[]        页面自定义项(插在分隔线之后)
   * ══════════════════════════════════════════════════════════ */
  function sourceItems(src) {
    src = src || {}
    var items = []
    var where = src.file
    if (src.rootName && src.file) where = src.file + ':' + (src.line || 0) + '  ·  ' + src.rootName

    items.push({ title: where || (src.id ? String(src.id) : '无源位置') })
    /* ★★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开基础游戏文件」):
     *   `root` 是**来源序号**,/api/open-external 与 /ide#root= 都靠它定位文件。
     *   很多内容条目历史上只给 rootName 不给 root,页面就硬编码 0
     *   —— 0 恒等于 vanilla,于是「打开模组里的文件」会定位到基础游戏同名文件,
     *   或直接报"文件不存在"。
     *
     *   这里做**双通道兜底**,不依赖每个页面都记得传对:
     *     ① root 是合法非负数 → 直接用;
     *     ② 否则拿 rootName 去 /api/sources 反查序号(结果缓存,与 sources() 同源);
     *     ③ 都查不到 → 隐藏三个跳转项,并说明原因。
     *        宁可不给「打不开」的菜单项,也不要给一个静默打开错文件的项。 */
    var rootIdx = resolveRoot(src.root, src.rootName)
    if (src.file) {
      if (rootIdx >= 0) {
        items.push({ label: '在 IDE 中打开并定位', k: '→', hint: tr('行 ') + (src.line || 1), act: function () { jumpIde(rootIdx, src.file, src.line) } })
        items.push({ label: '在 IDE 中另开标签', k: '⧉', act: function () { global.open(ideUrl(rootIdx, src.file, src.line), '_blank') } })
        items.push({ label: '用 VS Code 打开', k: '⌘', act: function () { vscodeOpen(rootIdx, src.file, src.line) } })
        items.push({ sep: true })
      } else {
        items.push({
          label: '无法定位来源(缺 root / rootName)', dis: true,
          title: '这一条没带来源信息,不知道该在哪个模组里打开。',
        })
      }
    }
    if (src.id) {
      items.push({ label: '复制 ID', k: '⧉', hint: '', act: function () { copy(src.id, ' ID ' + src.id) } })
    }
    if (src.loc && src.loc !== src.id) {
      items.push({ label: '复制本地化 key', k: '⧉', act: function () { copy(src.loc, src.loc) } })
    }
    if (src.file) {
      items.push({ label: '复制相对路径', k: '⧉', act: function () { copy(src.file, src.file) } })
      items.push({ label: '复制「文件:行」', k: '⧉', act: function () { copy(src.file + ':' + (src.line || 1), src.file + ':' + (src.line || 1)) } })
      items.push({ label: '复制绝对路径', k: '⧉', act: function () {
        sources().then(function (list) {
          var base = (list[src.root] || {}).path || ''
          copy(base ? base.replace(/[\\/]+$/, '') + '/' + src.file : src.file, '绝对路径')
        })
      } })
    }
    if (src.defs && src.defs.length > 1) {
      items.push({ sep: true })
      items.push({ label: tr('复制全部 ') + src.defs.length + tr(' 处定义位置'), k: '⧉', act: function () {
        copy(src.defs.map(function (d) { return (d.rootName || d.root) + '  ' + d.file + ':' + d.line }).join('\n'), '')
      } })
    }
    if (src.extra && src.extra.length) {
      items.push({ sep: true })
      items = items.concat(src.extra)
    }
    return items
  }

  /* ══════════════════════════════════════════════════════════
   * 弹出 / 关闭
   * ══════════════════════════════════════════════════════════ */
  function hide() {
    if (!cur) return
    cur.cleanup.forEach(function (f) { f() })
    cur = null
    var el = document.getElementById(MENU_ID)
    if (el) el.classList.remove('on')
  }

  function open(x, y, items) {
    hide()
    items = (items || []).filter(Boolean)
    if (!items.length) return
    ensureStyle()
    var el = menuEl()
    var html = ''
    items.forEach(function (it, i) {
      if (it.sep) { html += '<div class="ctx-s"></div>'; return }
      if (it.title) { html += '<div class="ctx-t" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'; return }
      html += '<div class="ctx-i' + (it.danger ? ' danger' : '') + (it.dis ? ' dis' : '') + '" data-i="' + i + '">' +
        '<span class="k">' + (it.k || '') + '</span>' +
        '<span class="lb">' + esc(it.label) + '</span>' +
        (it.hint ? '<span class="hn">' + esc(it.hint) + '</span>' : '') +
        '</div>'
    })
    el.innerHTML = html
    el.classList.add('on')

    // 定位:贴边翻转,保证菜单完整可见
    var w = el.offsetWidth || 200
    var h = el.offsetHeight || 200
    var vw = global.innerWidth
    var vh = global.innerHeight
    var left = x + w + 6 > vw ? Math.max(4, x - w) : x
    var top = y + h + 6 > vh ? Math.max(4, Math.min(y - h, vh - h - 4)) : y
    el.style.left = Math.max(4, left) + 'px'
    el.style.top = Math.max(4, top) + 'px'

    var acts = items.filter(function (i) { return !i.sep && !i.title && !i.dis })
    var sel = -1
    var el2 = el

    function select(d) {
      if (!acts.length) return
      sel = (sel + d + acts.length) % acts.length
      paint()
    }
    function paint() {
      el2.querySelectorAll('.ctx-i').forEach(function (n) {
        var it = items[Number(n.dataset.i)]
        n.classList.toggle('sel', !!it && acts.indexOf(it) === sel)
      })
    }
    function run(it) {
      hide()
      if (it && it.act) setTimeout(function () { it.act() }, 0)
    }

    var onClick = function (e) {
      var n = e.target.closest('.ctx-i')
      if (!n) return
      var it = items[Number(n.dataset.i)]
      if (!it || it.dis) return
      run(it)
    }
    var onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); select(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); select(-1); return }
      if (e.key === 'Home') { e.preventDefault(); sel = 0; paint(); return }
      if (e.key === 'End') { e.preventDefault(); sel = acts.length - 1; paint(); return }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation()
        if (sel >= 0) run(acts[sel])
      }
    }
    // 点别处 / 滚轮 / 缩放 / 失焦 都收起
    var onAway = function (e) { if (!el2.contains(e.target)) hide() }
    var onScroll = function () { hide() }
    var onBlur = function () { hide() }

    el2.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onAway, true)
    document.addEventListener('scroll', onScroll, true)
    global.addEventListener('resize', onScroll)
    global.addEventListener('blur', onBlur)
    // 右键点菜单自身:别把系统菜单放出来
    el2.addEventListener('contextmenu', function (e) { e.preventDefault() })

    cur = { el: el2, items: items, cleanup: [function () {
      el2.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onAway, true)
      document.removeEventListener('scroll', onScroll, true)
      global.removeEventListener('resize', onScroll)
      global.removeEventListener('blur', onBlur)
    }] }
    if (acts.length) { sel = 0; paint() }
  }

  /**
   * 事件委托绑定:容器上监听 contextmenu,按 selector 命中最近的祖先。
   * ⚠ 必须委托 —— focus/tech 画布每次 render() 重建全部节点。
   * @param {Element|string} root 容器。**也可以直接给选择器字符串**:
   *   ctxwire 的声明式接线(cfg.on[].host)传的就是字符串,
   *   这里只认元素会让 root.addEventListener 抛 "is not a function",
   *   于是**每一页的右键都静默失效**。DOM 桩测不出来(桩里两边都是元素)。
   * @param {string} sel   命中选择器(如 '.node' / '.fchip')
   * @param {function} fn  (target, event) => items[] | null
   *                    返回 null 表示"不接管",放行系统菜单
   */
  function attach(root, sel, fn) {
    function bindOnce() {
      var host = typeof root === 'string' ? document.querySelector(root) : root
      if (!host) return false
      host.addEventListener('contextmenu', function (e) {
        var t = e.target.closest ? e.target.closest(sel) : null
        if (!t || !host.contains(t)) return
        var items = fn(t, e)
        if (!items || !items.length) return
        e.preventDefault()
        e.stopPropagation()
        open(e.clientX, e.clientY, items)
      })
      return true
    }
    if (bindOnce()) return
    /* 容器还没渲染出来(module 脚本可能早于首次 render)。
     * 静默 return 的后果是"这一页右键永久失效",很难查,所以重试几帧。 */
    var tries = 0
    var iv = setInterval(function () {
      if (bindOnce() || ++tries > 40) clearInterval(iv)
    }, 120)
  }

  /** 单元素直接绑定(列表行等固定结构) */
  function on(el, fn) {
    if (!el) return
    el.addEventListener('contextmenu', function (e) {
      var items = fn(el, e)
      if (!items || !items.length) return
      e.preventDefault()
      open(e.clientX, e.clientY, items)
    })
  }


  /* ══════════════════════════════════════════════════════════════
   * DEFAULT_CTX_V1(2026-10-18):全局默认右键兜底
   *
   * ★ 为什么需要:electron 化后,凡是没有被某页 attach()/on() 接管的区域
   *   (空白处、画布缝隙、无菜单的条目…),右键会弹出 Chromium 原生菜单
   *   (后退/刷新/检查…),观感上就是"自定义右键失效"。
   *
   * ★ 原理:所有自定义菜单接管时都会 e.preventDefault()(attach/on 都调了),
   *   所以用一个冒泡到 document 的兜底监听,检查 e.defaultPrevented ——
   *     已 preventDefault  → 有自定义接管,兜底让位;
   *     未 preventDefault → 无人接管,弹"默认菜单"并屏蔽原生菜单。
   *   因 attach/on 均 stopPropagation,若其 host 即 document,stopPropagation
   *   不会拦截同元素监听器,故用 defaultPrevented 判定最稳(不依赖冒泡层级)。
   * ══════════════════════════════════════════════════════════════ */
  /* 安全翻译:tr 由 i18n.js 提供,但默认菜单可能出现在未加载 i18n 的页面(壳/设置等),
   * 直接调 tr 会 ReferenceError 崩溃。这里兜底:有则本地化,无则原样返回。 */
  function t(s) {
    return (typeof tr === 'function') ? tr(s) : s
  }

  /* 当前可复制文本:优先选区,其次输入框/文本域全文(复制菜单的可用性判定) */
  function selText() {
    try {
      var s = window.getSelection ? window.getSelection().toString() : ''
      if (s && s.trim()) return s
      var ae = document.activeElement
      if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /^(text|search|url|tel|password)$/i.test((ae.type || '')))))
        return ae.value || ''
    } catch (e) {}
    return ''
  }

  /* 返回主页:项目用 iframe 壳(index/shell 外壳 + 子页 iframe)。
   * 必须走父壳的统一跳转 shellGo('/')(复用 iframe 池、高亮一致);
   * 若直接 location.href='/' 只会让 iframe 内部跳,外壳还在,观感上"没生效"。 */
  function goHome() {
    try {
      var top = window.top || window
      if (typeof top.shellGo === 'function') { top.shellGo('/'); return }
      if (typeof window.shellGo === 'function') { window.shellGo('/'); return }
    } catch (e) {}
    location.href = '/'
  }

  /* 刷新当前页:iframe 内刷新 iframe 内容(最贴切);整页时刷新整页。
   * 若用 location.reload() 在外壳 iframe 内只刷 iframe,属于预期。 */
  function refreshPage() {
    location.reload()
  }

  /* 默认菜单(右键无人接管时):复制 / 刷新页面 / 返回主页;electron 附加检查元素 */
  function defaultItems() {
    var items = []
    var sel = selText()
    items.push({
      label: t('复制'), k: '⎘', dis: !sel,
      hint: sel ? '' : t('无文本'),
      act: function () { if (sel) copy(sel, '') },
    })
    items.push({ sep: true })
    items.push({ label: t('刷新页面'), k: '⟳', act: function () { refreshPage() } })
    items.push({ label: t('返回主页'), k: '⌂', act: function () { goHome() } })
    var api = (typeof window !== 'undefined') ? (window.electronAPI || null) : null
    if (api && typeof api.openDevTools === 'function') {
      items.push({ sep: true })
      items.push({ label: t('检查元素'), k: '⌥', act: function () { api.openDevTools() } })
    }
    return items
  }

  function onDocCtx(e) {
    // 已被自定义菜单接管 → 让位
    if (e.defaultPrevented) return
    e.preventDefault()
    e.stopImmediatePropagation()
    open(e.clientX, e.clientY, defaultItems())
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('contextmenu', onDocCtx, false)
  }

  global.Ctx = {
    open: open,
    hide: hide,
    attach: attach,
    on: on,
    sourceItems: sourceItems,
    copy: copy,
    toast: toast,
    jumpIde: jumpIde,
    ideUrl: ideUrl,
    vscodeOpen: vscodeOpen,
    sources: sources,
    resolveRoot: resolveRoot,
  }
})(window)
