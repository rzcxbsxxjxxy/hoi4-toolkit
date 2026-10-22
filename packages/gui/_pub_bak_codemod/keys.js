/* ══════════════════════════════════════════════════════════════════
 * keys.js —— 全站快捷键框架 + 速查表(KEYS_V1 公共件)
 *
 * ★ 用户诉求:"更适合常用的 VS Code 使用习惯的编辑"
 *
 * VS Code 的肌肉记忆是能直接迁移的,但本工作台原来只有零星几个
 * 页面自己绑的 keydown,彼此不一致、也没有任何"有哪些快捷键"的入口。
 * 本件把这件事做成公共能力:
 *   ① 统一注册:K.bind('mod+f', fn, '描述')   —— mod 自动识别 Ctrl/⌘
 *   ② 作用域:页面级(reg)与全局级(bind)分开,避免各页互相打架
 *   ③ 速查表:按 F1 或 ? 弹出,按分组列出当前页所有已注册快捷键
 *      —— 这是"补了大量快捷键"能被用户发现的前提,否则等于没加
 *   ③ 与输入框共存:焦点在 input/textarea/contenteditable 里时
 *      单键快捷键(f、/、? …)自动让位,只有带 mod 的仍然生效。
 *      ⚠ 这条是必须的:国策页有搜索框,科技页有筛选框,
 *         不让位的话用户在里面打 "/" 就弹菜单,无法正常输入。
 *
 * ── 与 ctx.js 的分工 ──
 *   ctx.js  = 鼠标(右键菜单)
 *   keys.js = 键盘(快捷键 + 速查表)
 *   两者共用同一批"动作",所以 F1 表里的每一项都能真的按出来。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  var MOD = navigator.platform.indexOf('Mac') >= 0 || /Mac|iP(hone|ad)/.test(navigator.userAgent)
  var SEP = '   '

  /* 归一化按键 → 规范串。'mod' 表示 Ctrl(Win/Linux) 或 ⌘(Mac)。
   * 键名部分走 normKey(),与 eventCombo() 共用一张表 —— 两边词汇不一致
   * 是这类框架最典型的失配来源(注册 'escape' 但事件算出 'esc')。 */
  function norm(combo) {
    var parts = String(combo).toLowerCase().split('+').map(function (s) { return s.trim() })
    var out = []
    parts.forEach(function (p) {
      if (!p) return
      if (p === 'mod' || p === 'ctrl' || p === 'cmd' || p === 'meta') out.push('mod')
      else if (p === 'shift') out.push('shift')
      else if (p === 'alt' || p === 'option') out.push('alt')
      else out.push(normKey(p))
    })
    return out.join('+')
  }

  /* 命名键归一:e.key → 本件内部用的规范名。
   * ⚠ 必须覆盖 F1/Escape/Tab/方向键/空格等 —— 早先的写法是
   *   「k.length > 1 就 return null」,结果 F1、Escape、Tab、方向键
   *   全部拿不到 combo,速查表(F1)根本打不开、Esc 也不生效。
   *   教训:这里的过滤条件只能挡「无法枚举的键」,不能挡「名字长的键」。 */
  var NAMED = {
    escape: 'escape', esc: 'escape',
    enter: 'enter', return: 'enter',
    tab: 'tab',
    backspace: 'backspace', delete: 'delete', del: 'delete',
    insert: 'insert',
    home: 'home', end: 'end',
    pageup: 'pageup', pagedown: 'pagedown',
    arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    up: 'up', down: 'down', left: 'left', right: 'right',
    ' ': 'space', spacebar: 'space',
    contextmenu: 'contextmenu', menu: 'contextmenu',
  }
  function normKey(k) {
    var s = String(k).toLowerCase()
    if (NAMED[s]) return NAMED[s]
    // F1..F24
    var f = /^f(\d{1,2})$/.exec(s)
    if (f) return 'f' + f[1]
    return s
  }

  /* 事件 → 规范 combo(与 bind() 用的是同一套词汇) */
  function eventCombo(e) {
    var raw = e.key
    if (!raw) return null
    /* ⚠ 这三个"拿不到真实键名"的状态必须**转小写后**再比。
     *   DOM 规范给的是 'Unidentified'(首字母大写),早先只比小写 → 比不中,
     *   normKey 把它当普通键名放行,算出 'mod+unidentified' 这种垃圾键位
     *   塞进 index,用户按任何一个键都会命中它。输入法组字时正是这个状态。 */
    var low = String(raw).toLowerCase()
    if (low === 'unidentified' || low === 'dead' || low === 'process') return null
    var k = normKey(raw)
    if (!k) return null
    // 字母/数字用 e.code 兜底:非美式布局(拼音输入法)下 e.key 可能是拼音字母
    if (/^[a-z0-9]$/.test(k) && e.code && /^(Key[A-Z]|Digit[0-9])$/.test(e.code)) {
      k = e.code.replace(/^Key|^Digit/, '').toLowerCase()
    }
    var s = ''
    if (e.ctrlKey || e.metaKey) s += 'mod+'
    if (e.altKey) s += 'alt+'
    /* ⚠⚠ Shift 的处理分两种,早先只写了一条,导致 **Shift+字母 被整个吞掉**:
     *   · 命名键/功能键(f10、Tab、Escape)→ 必须显式加 'shift+' 前缀
     *   · 可打印符号(Shift+1 = '!')→ 字符本体已体现,再加前缀就成了
     *     没法注册的 'shift+!'。目录里 view.zoomIn 默认就是 ['+','='],
     *     正是这个约定。
     *   · **字母**是第三种:normKey 会把它强制小写,Shift+J 的 'J' 被抹成 'j',
     *     字符本体不再体现 Shift → 不加前缀的话 Ctrl+Shift+P 与 Ctrl+P
     *     算出同一个 'mod+p',VS Code 最著名的命令面板键就废了。
     *     判据用 **raw 是否为大写单字母**,不能用 "k !== low":字母还会走
     *     e.code(KeyJ)兜底,兜底后 k 恒为小写,那个条件永远不成立。 */
    if (e.shiftKey) {
      if (k.length > 1) s += 'shift+'
      else if (/^[A-Z]$/.test(raw)) s += 'shift+'
    }
    return s + k
  }

  /** 展示用:F1 / Ctrl+P …
   *  ⚠ 必须容忍空/非法输入:combo 为 '' 时 norm('') 得 '',
   *    split('+') → [''] → p.length===1 为真走 toUpperCase 没事,但 p 为空串时
   *    末尾兜底分支 p[0].toUpperCase() 会取 undefined 的属性而抛错。
   *    速查表渲染会对每条记录调 pretty(),一处崩就整个表打不开。 */
  function pretty(combo) {
    if (combo === null || combo === undefined) return ''
    var n = norm(combo)
    if (!n) return ''
    var isMac = MOD
    return n
      .split('+')
      .map(function (p) {
        if (!p) return ''
        if (p === 'mod') return isMac ? '⌘' : 'Ctrl'
        if (p === 'alt') return isMac ? '⌥' : 'Alt'
        if (p === 'shift') return isMac ? '⇧' : 'Shift'
        if (p === 'space') return 'Space'
        if (p === 'escape') return 'Esc'
        if (p === 'enter') return 'Enter'
        if (p === 'tab') return 'Tab'
        if (p === 'backspace') return 'Backspace'
        if (p === 'delete') return 'Del'
        if (p === 'contextmenu') return 'Menu'
        // ★ 方向键内部名已归一为 up/down/left/right(见 NAMED)
        if (p === 'up') return '↑'
        if (p === 'down') return '↓'
        if (p === 'left') return '←'
        if (p === 'right') return '→'
        if (!p) return ''
        return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)
      })
      .join(isMac ? '' : '+')
  }

  /* 输入态:焦点在可编辑元素里 → 单键快捷键让位 */
  function inEditable() {
    var a = document.activeElement
    if (!a) return false
    var t = a.tagName
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable === true
  }

  var registry = [] // { combo, norm, desc, group, fn, global, id }
  var index = new Map()
  var byId = new Map() // 稳定 id → rec(供设置页/页面动态查询)

  /**
   * 注册快捷键
   * @param {string|string[]|null} combo  如 'mod+f' / ['/', 'mod+f'] / f1..F24
   *        ★ 传数组 = 同一动作的多个入口(如 '/' 与 'mod+f' 都聚焦搜索)。
   *        传 null 且给了 opt.id → 键位完全由 keymap 决定(页面自己实现时用)。
   * @param {function} [fn] 执行函数
   * @param {string} desc  速查表里显示的说明
   * @param {{id?:string, group?:string, global?:boolean, doc?:boolean}} [opt]
   *        id    —— 稳定动作 id。**给了 id 才会跟随用户在设置页的改动**:
   *                键位从 Keymap.keysOf(id) 取(有覆盖则只注册覆盖键),
   *                页面代码里写死的 combo 就退化成默认值的备忘。
   *        global=true 时即使焦点在输入框里也触发(如 Ctrl+S)
   *        ★ doc=true —— **只进速查表,不接管按键**。
   *          页面自己已用 document 级监听实现了某快捷键时必须用它:
   *          否则本件在捕获阶段会 preventDefault + stopPropagation,
   *          事件被拦在到达页面/输入框之前,页面自己的实现反而被吃掉。
   *          (实测症状:编辑框里按 Ctrl+S 没反应)
   */
  function bind(combo, fn, desc, opt) {
    opt = opt || {}
    var id = opt.id || null
    var list
    var disabled = false
    if (id && window.Keymap) {
      var KM = window.Keymap
      var page = global.__KEYMAP_PAGE__ || null
      var ks = KM.keysOf(id, page)
      if (ks.length) {
        list = ks.map(norm)
      } else if (KM.isCustom(id)) {
        // 用户在设置页把这个动作显式禁用了(存了空串)→ 不接管按键
        disabled = true
        list = []
      } else {
        // 未覆盖 → 用目录默认值。
        // ⚠ 必须回落目录默认,不能只退回调用处写的 combo:各页已改成
        //   "combo=null + 靠 id",若这里拿 null 当默认,全站快捷键会静默全失。
        list = (KM.resolve(id, page) || []).map(norm)
        if (!list.length && combo) list = (Array.isArray(combo) ? combo : [combo]).map(norm)
        if (!list.length && KM.byId(id)) console.warn('[keys] 目录里查不到默认键位:' + id)
      }
    } else {
      list = (Array.isArray(combo) ? combo : [combo]).filter(Boolean).map(norm)
    }

    var rec = {
      combo: list[0] || '', keys: list, norm: list[0] || '',
      desc: desc || '', group: opt.group || '本页', fn: fn,
      global: !!opt.global, doc: !!opt.doc, id: id, disabled: !!disabled,
    }
    registry.push(rec)
    if (id) {
      var prev = byId.get(id)
      if (prev) unbind(prev)
      byId.set(id, rec)
    }
    if (opt.doc || disabled) return rec // 不进 index → 按键不由此件处理
    list.forEach(function (nc) {
      if (!nc) return
      if (!index.has(nc)) index.set(nc, [])
      index.get(nc).push(rec)
    })
    return rec
  }

  function unbind(rec) {
    var i = registry.indexOf(rec)
    if (i >= 0) registry.splice(i, 1)
    if (rec.id && byId.get(rec.id) === rec) byId.delete(rec.id)
    var arr = index.get(rec.norm)
    if (arr) {
      var j = arr.indexOf(rec)
      if (j >= 0) arr.splice(j, 1)
      if (!arr.length) index.delete(rec.norm)
    }
    // 多键位动作:从所有它占用的槽位里摘掉
    ;(rec.keys || []).forEach(function (nc) {
      if (nc === rec.norm) return
      var a2 = index.get(nc)
      if (!a2) return
      var j2 = a2.indexOf(rec)
      if (j2 >= 0) a2.splice(j2, 1)
      if (!a2.length) index.delete(nc)
    })
  }

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return // ★ 输入法组字中,一律不拦
    var combo = eventCombo(e)
    if (!combo) return
    var arr = index.get(combo)
    if (!arr || !arr.length) return
    // 输入框里:只有 global 的快捷键生效,单键的让位给打字
    var usable = inEditable() ? arr.filter(function (r) { return r.global }) : arr
    if (!usable.length) return
    // 同键多绑定:取最后注册的(页面后加载的优先)
    var rec = usable[usable.length - 1]
    if (typeof rec.fn !== 'function') return
    e.preventDefault()
    e.stopPropagation()
    rec.fn(e)
  }

  /* ══════════════════════════════════════════════════════════
   * 速查表
   * ══════════════════════════════════════════════════════════ */
  /* 鼠标用法:没有"唯一按键"的动作单独列一栏,避免和真实快捷键混在一起
   * 让人误以为按了列出来的键就能触发。 */
  var MOUSE_ROWS = [
    ['鼠标右键任意条目', '打开菜单:定位源码 / 复制 id / 复制路径 / 复制覆盖链'],
  ]

  var sheetEl = null
  function closeSheet() {
    if (sheetEl) { sheetEl.remove(); sheetEl = null }
    document.removeEventListener('keydown', sheetKey, true)
  }
  function sheetKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet() }
  }

  function toggleSheet() {
    if (sheetEl) { closeSheet(); return }
    // 只列真正注册过的项 —— 速查表里出现"按了没反应"的条目比不列更糟
    var groups = new Map()
    registry.forEach(function (r) {
      if (!r.desc) return
      if (!groups.has(r.group)) groups.set(r.group, [])
      groups.get(r.group).push(r)
    })

    var esc = function (s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
      })
    }

    var row = function (desc, keys) {
      return '<div class="sh-r"><span class="sh-d">' + desc + '</span><span class="sh-k">' + keys + '</span></div>'
    }
    var kb = function (combo) { return combo ? '<kbd>' + esc(pretty(combo)) + '</kbd>' : '' }
    /* 一个动作可能有多入口 → 并排显示;被用户改过则加标记,
     * 让"我设的键怎么变样了"在速查表里能一眼看出来(下方可去设置页改回)。
     * ⚠ 过滤空 combo:被禁用的动作 keys 为 [],fallback 到 r.norm 也可能是 ''。 */
    var keysOfRec = function (r) {
      if (r.disabled) return '<em class="sh-off">已禁用</em>'
      var ks = (r.keys && r.keys.length ? r.keys : [r.norm]).filter(Boolean).map(kb).join('')
      if (!ks) return '<em class="sh-off">未绑定</em>'
      return r.id && window.Keymap && window.Keymap.isCustom(r.id)
        ? ks + '<em class="sh-cus" title="已在设置页自定义">改</em>'
        : ks
    }

    var rows = ''
    groups.forEach(function (list, g) {
      if (g === '__global') return
      rows += '<div class="sh-g">' + esc(g) + '</div>'
      list
        .slice()
        .sort(function (a, b) { return (a.norm || '').localeCompare(b.norm || '') })
        .forEach(function (r) { rows += row(esc(r.desc), keysOfRec(r)) })
    })
    rows += '<div class="sh-g">鼠标</div>'
    MOUSE_ROWS.forEach(function (p) { rows += row(esc(p[0] + ' — ' + p[1]), '<kbd>右键</kbd>') })
    if (!rows) rows = '<div class="sh-g">本页尚未注册快捷键</div>'

    var count = registry.filter(function (r) { return r.desc }).length
    var cm = window.Keymap ? window.Keymap.customCount() : 0
    var foot = '本页 ' + count + ' 项快捷键 · 焦点在输入框时单键快捷键自动让位'
    if (cm) foot += ' · <a href="/settings#keymap" class="sh-link">已自定义 ' + cm + ' 项,去修改</a>'
    else foot += ' · <a href="/settings#keymap" class="sh-link">可在设置页自定义</a>'

    var html =
      '<div class="sh-mask"></div>' +
      '<div class="sh-box" role="dialog" aria-label="快捷键速查表">' +
      '<div class="sh-hd">⌨ 快捷键速查<button class="sh-x" title="关闭">✕</button></div>' +
      '<div class="sh-bd">' + rows + '</div>' +
      '<div class="sh-ft">' + foot + (MOD ? '' : ' · 按 F1 或 Ctrl+K 随时打开') + '</div>' +
      '</div>'

    var style = document.createElement('style')
    style.textContent = [
      '.sh-mask{position:fixed;inset:0;background:rgba(10,14,22,.42);z-index:600}',
      '.sh-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:601;',
      'min-width:min(520px,92vw);max-width:min(680px,94vw);max-height:82vh;display:flex;flex-direction:column;',
      'background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow-lg)}',
      '.sh-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;',
      'font-weight:600;border-bottom:1px solid var(--line2)}',
      '.sh-x{background:none;border:0;color:var(--ink3);cursor:pointer;font-size:14px;padding:2px 6px}',
      '.sh-x:hover{color:var(--danger)}',
      '.sh-bd{overflow:auto;padding:6px 0}',
      '.sh-g{padding:8px 14px 4px;color:var(--ink3);font-size:.86em;letter-spacing:.4px}',
      '.sh-r{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:4px 14px}',
      '.sh-r:hover{background:var(--inset)}',
      '.sh-d{color:var(--ink)}',
      '.sh-k{color:var(--ink3);white-space:nowrap}',
      '.sh-k kbd{font:inherit;background:var(--inset);border:1px solid var(--line2);border-radius:4px;',
      'padding:1px 6px;margin-left:4px;color:var(--ink2)}',
      '.sh-cus{font-style:normal;font-size:.8em;color:var(--accent);border:1px solid var(--accent-soft);',
      'border-radius:3px;padding:0 4px;margin-left:4px;background:var(--accent-soft)}',
      '.sh-off{font-style:normal;color:var(--ink3);opacity:.75}',
      '.sh-link{color:var(--accent);text-decoration:none}',
      '.sh-link:hover{text-decoration:underline}',
      '.sh-ft{padding:8px 14px;border-top:1px solid var(--line2);color:var(--ink3);font-size:.86em}',
      ':root[data-bg="image"] .sh-mask{backdrop-filter:blur(2px)}',
      ':root[data-bg="image"] .sh-box{background:var(--glass-raise);backdrop-filter:blur(12px) saturate(1.15)}',
    ].join('')

    var wrap = document.createElement('div')
    wrap.innerHTML = html
    sheetEl = document.createElement('div')
    sheetEl.appendChild(style)
    while (wrap.firstChild) sheetEl.appendChild(wrap.firstChild)
    document.body.appendChild(sheetEl)

    sheetEl.querySelector('.sh-x').onclick = closeSheet
    sheetEl.querySelector('.sh-mask').onclick = closeSheet
    document.addEventListener('keydown', sheetKey, true)
  }

  /* ══════════════════════════════════════════════════════════
   * 通用动作 —— 各页直接复用的几件事
   * ══════════════════════════════════════════════════════════ */

  /** 聚焦页面里的搜索框(约定 id 为 q / search / #qIn) */
  function focusSearch() {
    var el = document.querySelector('#q, #search, #qIn, input[data-search], input[type=search]')
    if (!el) return false
    el.focus()
    if (el.select) el.select()
    return true
  }

  /** 打开当前选中项的右键菜单(键盘等价于右键) */
  function contextMenuKey() {
    /* ⚠ 选中态类名各页不统一(.on / .sel / .card.on / [aria-selected]),
     *   页面可通过 window.__KEYMAP_SEL__ 覆盖默认候选 —— 但**它只是兜底**,
     *   真正可靠的是元素上挂的 ctxItems()。所以先按类名找元素,再取它挂的菜单。
     *   找不到就明说,不要静默。 */
    var sel =
      document.querySelector('[data-ctxsel="1"], .sel, .node.sel, .card.sel, .card.on, .row.on, li.on, tr.on')
    if (!sel) { Ctx.toast('先用鼠标点选一个条目,再按 Shift+F10', true); return }
    var r = sel.getBoundingClientRect()
    // 优先用元素上挂的 ctxItems(各页在渲染时挂上)
    if (typeof sel.ctxItems === 'function') Ctx.open(r.left + 8, r.bottom, sel.ctxItems())
    else if (sel.__obj) Ctx.toast('该条目没有可用菜单(页面未挂 ctxItems)')
    else Ctx.toast('该条目没有可用菜单')
  }

  /* ── 装订 ── */
  var wired = false
  function boot() {
    if (wired) return
    wired = true
    /* 用捕获阶段:页面自己的 keydown 常常先 preventDefault,
     * 捕获阶段先跑能保证 F1 / 速查表这类"框架级"按键永远有效。 */
    document.addEventListener('keydown', onKey, true)
    // 有 id → 键位来自 keymap 目录,用户改了速查表入口也跟着变
    bind(null, toggleSheet, '快捷键速查表', { id: 'global.sheet', group: '全局', global: true })
    // 全屏(FULLSCREEN_V1):走 window.Fullscreen,不直接调 requestFullscreen ——
    //   后者在不支持的浏览器上抛异常,且退全屏后要重算画布,由全屏件统一做。
    bind(null, () => {
      if (!window.Fullscreen) { kToast('当前浏览器不支持全屏', true); return }
      window.Fullscreen.toggle()
    }, '全屏 / 退出全屏', { id: 'global.fullscreen', group: '全局', global: true })
  }

  /* keys.js 独立可用(不保证 ctx.js 已加载),所以自带一个极简提示。
   * 复用页面已有的 #toast;没有就退回 console —— 不为一条提示引入依赖。 */
  function kToast(msg, isErr) {
    var t = document.getElementById('toast')
    if (t) {
      t.textContent = msg
      t.className = 'on' + (isErr ? ' err' : '')
      clearTimeout(kToast._t)
      kToast._t = setTimeout(function () { t.className = '' }, 2600)
    } else {
      console[isErr ? 'warn' : 'log']('[' + (isErr ? 'error' : 'info') + '] ' + msg)
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  global.Keys = {
    bind: bind,
    unbind: unbind,
    norm: norm,
    pretty: pretty,
    /* 事件 → 规范 combo。**设置页的录制态直接用它**,
     * 保证"录到的键"和"框架认的键"是同一套词汇 ——
     * 若设置页自己拼字符串,迟早会出现存进去按不响的组合。 */
    fromEvent: eventCombo,
    /* 某动作当前生效的键位(数组);页面自实现的快捷键用它动态匹配,
     * 这样重绑之后不用重写 onKey。 */
    combo: function (id, i) {
      if (window.Keymap) {
        var ks = window.Keymap.keysOf(id, global.__KEYMAP_PAGE__ || null)
        if (!ks.length) return null // 禁用了 → 传 null,页面 onKey 自然不匹配
        return i === undefined ? ks : ks[i]
      }
      var r = byId.get(id)
      if (!r) return null
      var a = r.keys && r.keys.length ? r.keys : [r.norm]
      return i === undefined ? a : a[i]
    },
    has: function (id) { return byId.has(id) || (!!window.Keymap && !!window.Keymap.byId(id)) },
    recOf: function (id) { return byId.get(id) || null },
    list: function () { return registry.slice() },
    sheet: toggleSheet,
    focusSearch: focusSearch,
    ctxKey: contextMenuKey,
    inEditable: inEditable,
  }
})(window)
