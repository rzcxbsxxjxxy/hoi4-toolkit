/* events.js —— 事件制作：列表 + 详情(触发 / 立即 / 选项 / 本地化联动)。
 *
 * ★ 展示原则:title / desc / option.name 存的都是【本地化 key】,
 *   直接显示 key 看不懂,所以详情里会顺带查一次 /api/loc/key 把译文带上。
 *   查不到就只显示 key 并标灰 —— 这本身就是"缺本地化"的信号。
 *
 * ★ 虚拟滚动(VIRTUAL_LIST_V1):事件列表最多 5000 行,全量 DOM 会卡。
 *   #list(滚动容器)里只放一个 position:relative 的 spacer(高度=行数×行高),
 *   可视行 absolute 定位(top=i×行高),滚动时按需增删。行高固定
 *   (title 单行省略),首次渲染测量一次。
 */
(function () {
  'use strict'
  var $ = function (s) { return document.querySelector(s) }
  var S = { rows: [], cur: null, meta: null, locCache: {},
    /* 展示语言(默认英文,可切换并持久化)。title/desc/option.name 都是本地化 key */
    lang: (function(){ try { return localStorage.getItem('evtLang') || 'l_english' } catch(e){ return 'l_english' } })(),
    page: 1, pageSize: 200, totalPages: 1, total: 0 }

  function toast(msg, bad) {
    var t = $('#toast')
    t.textContent = msg
    t.className = 'on' + (bad ? ' bad' : '')
    clearTimeout(t._tm)
    t._tm = setTimeout(function () { t.className = '' }, 2600)
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }
  function api(u) { return fetch(u).then(function (r) { return r.json() }) }

  /* ── 列表 ── */
  function load() {
    var q = []
    var v = $('#q').value.trim()
    if (v) q.push('q=' + encodeURIComponent(v))
    if ($('#ns').value) q.push('ns=' + encodeURIComponent($('#ns').value))
    if ($('#type').value) q.push('type=' + encodeURIComponent($('#type').value))
    if ($('#src').value) q.push('src=' + encodeURIComponent($('#src').value))
    if ($('#origin').value) q.push('origin=' + encodeURIComponent($('#origin').value))
    if ($('#file').value) q.push('file=' + encodeURIComponent($('#file').value))
    q.push('limit=' + S.pageSize + '&offset=0')
    $('#list').innerHTML = '<div class="empty"><span class="spin"></span> 载入中…</div>'
    api('/api/events/list?' + q.join('&')).then(function (j) {
      if (!j.ready) {
        $('#list').innerHTML = tr('<div class="empty">索引构建中:') + esc(j.error || tr('请稍候')) + '</div>'
        return
      }
      S.meta = j
      S.rows = j.rows || []
      S.total = j.total || S.rows.length
      S.page = 1
      paginate()
      fillFilters(j)
      $('#cnt').textContent = tr('共 ') + j.total + tr(' 个事件 · ') + (j.files || 0) + tr(' 个文件')
      renderList()
    }).catch(function (e) {
      $('#list').innerHTML = tr('<div class="empty">载入失败:') + esc(e.message) + '</div>'
    })
  }


  /* 分页: 页内用 _page(当前页切片), 虚拟滚动只渲染该页可视行 */
  function paginate() {
    S.totalPages = Math.max(1, Math.ceil((S.total || S.rows.length) / S.pageSize))
    if (S.page > S.totalPages) S.page = S.totalPages
  }
  function gotoPage(p) {
    p = Math.max(1, Math.min(+p || 1, S.totalPages))
    if (p === S.page) return
    var q = []
    var v = $('#q').value.trim()
    if (v) q.push('q=' + encodeURIComponent(v))
    if ($('#ns').value) q.push('ns=' + encodeURIComponent($('#ns').value))
    if ($('#type').value) q.push('type=' + encodeURIComponent($('#type').value))
    if ($('#src').value) q.push('src=' + encodeURIComponent($('#src').value))
    if ($('#origin').value) q.push('origin=' + encodeURIComponent($('#origin').value))
    if ($('#file').value) q.push('file=' + encodeURIComponent($('#file').value))
    q.push('limit=' + S.pageSize + '&offset=' + (p - 1) * S.pageSize)
    if (_list) _list.innerHTML = '<div class="empty"><span class="spin"></span> ' + tr('载入中…') + '</div>'
    api('/api/events/list?' + q.join('&')).then(function (j) {
      if (!j.ready) return
      S.rows = j.rows || []
      S.total = j.total || S.rows.length
      S.page = p
      paginate()
      if (_list) _list.scrollTop = 0
      renderList()
    }).catch(function (e) {
      if (_list) _list.innerHTML = '<div class="empty">' + tr('载入失败:') + ' ' + esc(e.message) + '</div>'
    })
  }
  function updatePager() {
    var bar = $('#pager')
    if (!bar) return
    if (!S.rows.length && !S.total) { bar.style.display = 'none'; return }
    bar.style.display = ''
    $('#pgInfo').textContent = tr('第 ') + S.page + ' / ' + S.totalPages + tr(' 页 · 共 ') + (S.total || S.rows.length) + tr(' 条')
    var prev = $('#pgPrev'), next = $('#pgNext')
    prev.disabled = S.page <= 1
    next.disabled = S.page >= S.totalPages
    $('#pgInput').value = S.page
  }
  var filterReady = false
  function fillFilters(j) {
    var ns = $('#ns'), ty = $('#type'), sr = $('#src'), fl = $('#file')
    var keepNs = ns.value, keepTy = ty.value, keepSr = sr.value, keepFl = fl.value
    ns.innerHTML = '<option value="">全部</option>'
    ;(j.namespaces || []).slice(0, 400).forEach(function (n) {
      var o = document.createElement('option')
      o.value = n.name; o.textContent = n.name + ' (' + n.count + ')'
      ns.appendChild(o)
    })
    ty.innerHTML = '<option value="">全部</option>'
    ;(j.types || []).forEach(function (t) {
      var o = document.createElement('option')
      o.value = t; o.textContent = t
      ty.appendChild(o)
    })
    sr.innerHTML = '<option value="">全部</option>'
    ;(j.sources || []).forEach(function (s) {
      var o = document.createElement('option')
      o.value = s.name; o.textContent = s.name + (s.base ? '（基础）' : '（模组）')
      sr.appendChild(o)
    })
    // ★ 文件筛选:按 root 分组,value = `${root}|${相对路径}`
    fl.innerHTML = '<option value="">全部</option>'
    ;(j.fileList || []).forEach(function (f) {
      var o = document.createElement('option')
      o.value = f.root + '|' + f.file
      var short = f.file.replace(/^events\//, '')
      o.textContent = f.rootName + ' › ' + short + ' (' + f.events + ')'
      fl.appendChild(o)
    })
    if (filterReady) { ns.value = keepNs; ty.value = keepTy; sr.value = keepSr; fl.value = keepFl }
    filterReady = true
  }

  /* ── 虚拟滚动核心 ── */
  var ROW_H = 0                // 固定行高,首次渲染测量
  var VIEW_BUF = 8             // 上下缓冲行
  var _list = null, _spacer = null, _range = { s: -1, e: -1 }, _page = []

  function rowHtml(e, i) {
    var srcCls = e.overridden ? ' ovr' : e.origin === 'mod' ? ' new' : ''
    var srcTxt = e.overridden ? '模组改写' : e.origin === 'mod' ? '模组新增' : '基础游戏'
    return '<div class="item' + (S.cur === e.id ? ' on' : '') + '" data-i="' + i + '">' +
      '<div class="id">' + esc(e.id) + '</div>' +
      '<div class="t">' + esc(e.title || e.desc || tr('（无标题）')) + '</div>' +
      '<div class="t" style="margin-top:2px">' + esc(e.type) + ' · ' + e.options + tr(' 选项 · ') +
      '<span class="src' + srcCls + '">' + srcTxt + ' · ' + esc(e.src) + '</span></div>' +
      '</div>'
  }
  function rowEl(e, i) {
    var el = document.createElement('div')
    el.className = 'item' + (S.cur === e.id ? ' on' : '')
    el.style.position = 'absolute'
    el.style.left = '0'; el.style.right = '0'; el.style.top = (i * ROW_H) + 'px'
    el.setAttribute('data-i', i)
    el.__obj = e
    el.innerHTML = rowHtml(e, i)
    return el
  }
  /* 滚动 → 只增删可视区间。完全不重叠时全清重建,否则头/尾增删。 */
  function vupdate() {
    if (!S.rows.length || !_spacer) return
    var st = _list.scrollTop, vh = _list.clientHeight
    var s = Math.max(0, Math.floor(st / ROW_H) - VIEW_BUF)
    var e = Math.min(S.rows.length, Math.ceil((st + vh) / ROW_H) + VIEW_BUF)
    if (s === _range.s && e === _range.e) return
    if (e < _range.s || s > _range.e) {
      _spacer.textContent = ''
      var f = document.createDocumentFragment()
      for (var i = s; i < e; i++) f.appendChild(rowEl(S.rows[i], i))
      _spacer.appendChild(f)
    } else {
      if (s > _range.s) for (var i = _range.s; i < s; i++) _spacer.removeChild(_spacer.firstChild)
      if (s < _range.s) {
        var f2 = document.createDocumentFragment()
        for (var i = s; i < _range.s; i++) f2.appendChild(rowEl(S.rows[i], i))
        _spacer.insertBefore(f2, _spacer.firstChild)
      }
      if (e > _range.e) {
        for (var i = _range.e; i < e; i++) _spacer.appendChild(rowEl(S.rows[i], i))
      }
    }
    _range.s = s; _range.e = e
    translateVisible()
  }
  function visibleItems() { return _spacer ? _spacer.querySelectorAll('.item') : [] }

  function renderList() {
    _list = $('#list')
    if (!S.rows.length) { _list.innerHTML = '<div class="empty">没有匹配的事件</div>'; _range = { s: -1, e: -1 }; _spacer = null; updatePager(); return }
    // 首次测量固定行高
    if (!ROW_H) {
      _list.innerHTML = ''
      var probe = document.createElement('div')
      probe.innerHTML = rowHtml(S.rows[0], 0)
      _list.appendChild(probe.firstChild)
      ROW_H = (_list.firstChild).offsetHeight || 60
    }
    var keepTop = _list.scrollTop || 0
    _spacer = document.createElement('div')
    _spacer.style.position = 'relative'
    _spacer.style.height = (S.rows.length * ROW_H) + 'px'
    _list.innerHTML = ''
    _list.appendChild(_spacer)
    _range = { s: -1, e: -1 }
    _list.onscroll = vupdate
    _list.scrollTop = Math.min(keepTop, Math.max(0, S.rows.length * ROW_H - _list.clientHeight))
    vupdate()
    updatePager()
  }

  /* 只翻译当前可视行(虚拟滚动下不遍历全量) */
  var _locBusy = false, _locRetry = 0
  function translateVisible() {
    var need = {}
    var items = visibleItems()
    for (var k = 0; k < items.length; k++) {
      var e = S.rows[+items[k].getAttribute('data-i')]
      if (e) { if (e.title) need[e.title] = 1; if (e.desc) need[e.desc] = 1 }
    }
    var keys = Object.keys(need).slice(0, 800)
    if (!keys.length) return
    if (_locBusy) return
    _locBusy = true
    fetch('/api/loc/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: keys, lang: S.lang }),
    }).then(function (r) { return r.json() }).then(function (j) {
      _locBusy = false
      _locRetry = 0
      if (!j || !j.texts) return
      var its = visibleItems()
      for (var i = 0; i < its.length; i++) {
        var e = S.rows[+its[i].getAttribute('data-i')]
        if (!e) continue
        var k = e.title || e.desc || ''
        var hit = j.texts[k]
        if (hit && hit.text) {
          var tt = its[i].querySelector('.t')
          if (tt) tt.textContent = hit.text
        }
      }
    }).catch(function () {
      _locBusy = false
      if (_locRetry < 3) { _locRetry++; setTimeout(translateVisible, 500) }
    })
  }

  /* ══════════════════════════════════════════════════════════
   * 右键菜单 + 快捷键(RIGHTCLICK_V2)
   *
   * 事件数据里 locKey 与 id 不一定相同(title/desc/option.name 存的
   * 都是本地化 key),所以菜单里要同时给"复制 id"和"复制本地化 key"。
   * ══════════════════════════════════════════════════════════ */
  function wireCtxAndKeys() {
    if (!window.CtxWire) return
    CtxWire.attach({
      page: 'events',
      on: [
        {
          host: '#list',
          sel: '.item',
          obj: function (el) {
            var e = el.__obj
            if (!e) return null
            return {
              root: e.root, rootName: e.src, file: e.file, line: e.line,
              id: e.id, _e: e,
            }
          },
          items: function (o) {
            var e = o._e
            return [
              e.type ? { label: tr('复制类型(') + e.type + ')', k: '⧉', act: function () { Ctx.copy(e.type, '') } } : null,
              e.options ? { label: tr('复制选项数(') + e.options + ')', k: '⧉', act: function () { Ctx.copy(String(e.options), '') } } : null,
              e.picture ? { label: '复制图片路径', k: '⧉', act: function () { Ctx.copy(e.picture, '') } } : null,
              { label: tr('复制命名空间(') + e.namespace + ')', k: '⧉', act: function () { Ctx.copy(e.namespace, '') } },
              { label: '只看这个命名空间', k: '→', act: function () { $('#ns').value = e.namespace || ''; load() } },
              { label: '只看这个文件', k: '→', act: function () { $('#file').value = e.root + '|' + e.file; load() } },
            ].filter(Boolean)
          },
        },
      ],
      keys: [
        { id: 'find.search', desc: '聚焦搜索框', group: '查找', run: function () { var q = $('#q'); if (q) q.focus() } },
        {
          id: 'sel.copyId', desc: '复制选中事件的 id', group: '选中',
          run: function () { if (S.cur) Ctx.copy(S.cur, ' ' + S.cur); else toast('先点选一个事件', true) },
        },
        { id: 'sel.menu', desc: '对选中事件打开右键菜单', group: '选中', run: function () { Keys.ctxKey() } },
        { id: 'nav.nextItem', desc: '下一个事件', group: '浏览', run: function () { step(1) } },
        { id: 'nav.prevItem', desc: '上一个事件', group: '浏览', run: function () { step(-1) } },
        {
          id: 'sel.clear', desc: '返回列表', group: '浏览',
          run: function () { if (S.cur) { S.cur = null; renderList() } },
        },
      ],
    })
  }

  /* 上下移动选中项(列表导航,虚拟滚动下直接定位滚动) */
  function step(d) {
    if (!S.rows.length) return
    var i = S.rows.findIndex(function (r) { return r.id === S.cur })
    var j = i < 0 ? 0 : i + d
    if (j < 0) j = 0
    if (j >= S.rows.length) j = S.rows.length - 1
    open(S.rows[j].id)
    if (_list && ROW_H) { _list.scrollTop = j * ROW_H; vupdate() }
    else {
      var it = document.querySelectorAll('#list .item')[j]
      if (it && it.scrollIntoView) it.scrollIntoView({ block: 'nearest' })
    }
  }

  /* ── 详情 ── */
  function open(id) {
    S.cur = id
    renderList()
    $('#detail').innerHTML = '<div class="empty"><span class="spin"></span></div>'
    api('/api/events/read?id=' + encodeURIComponent(id)).then(function (j) {
      if (!j.found) { $('#detail').innerHTML = tr('<div class="empty">找不到事件 ') + esc(id) + '</div>'; return }
      renderDetail(j.event, j.defs || [])
    }).catch(function (e) {
      $('#detail').innerHTML = tr('<div class="empty">读取失败:') + esc(e.message) + '</div>'
    })
  }

  /* 本地化:title / desc / option name 都是 key,顺手把译文取回来。
   * byLang 的键带 l_ 前缀(如 l_english)。★ 选择顺序:选中语言 → 英文 → 任一门已有译文。 */
  function pickLang(vals) {
    if (!vals) return null
    var v = null
    if (S.lang && vals[S.lang]) v = vals[S.lang]
    else if (vals['l_english']) v = vals['l_english']
    else for (var k in vals) if (vals[k]) { v = vals[k]; break }
    if (v && typeof v === 'object' && v.value) return v.value
    return v || null
  }
  function locOf(key, cb) {
    if (!key) { cb(null); return }
    var hit = S.locCache[key]
    if (hit !== undefined) { cb(pickLang(hit)); return }
    api('/api/loc/key?key=' + encodeURIComponent(key)).then(function (j) {
      var map = (j && j.byLang) ? j.byLang : {}
      S.locCache[key] = map
      cb(pickLang(map))
    }).catch(function () { S.locCache[key] = null; cb(null) })
  }

  /* 语言条:从 loc 索引取全部语言,默认英文,可切换(切换后重绘列表 + 当前详情) */
  function initLangBar() {
    api('/api/loc/stats').then(function (j) {
      if (!j.ready || !j.langOptions || !j.langOptions.length) return
      var opts = j.langOptions
      if (S.lang !== 'l_english' && !opts.some(function (o) { return o.id === S.lang })) S.lang = 'l_english'
      var sel = document.createElement('select')
      sel.id = 'evtLang'
      opts.forEach(function (o) {
        var oo = document.createElement('option')
        oo.value = o.id; oo.textContent = o.label; sel.appendChild(oo)
      })
      sel.value = S.lang
      sel.onchange = function () {
        S.lang = sel.value
        try { localStorage.setItem('evtLang', S.lang) } catch (e) {}
        if (S.cur) open(S.cur); else load()
      }
      var lb = document.createElement('label')
      lb.className = 'fl'
      var sp = document.createElement('span'); sp.className = 'lb'; sp.textContent = '语言'
      lb.appendChild(sp); lb.appendChild(sel)
      var bar = document.getElementById('evtlangbar')
      if (bar) bar.appendChild(lb)
    }).catch(function () {})
  }

  function renderDetail(e, defs) {
    var h = ''
    h += '<div class="d-hd"><h2>' + esc(e.id) + '</h2>' +
      '<span class="id">' + esc(e.type) + '</span>' +
      '<span class="src' + (e.overridden ? ' ovr' : e.origin === 'mod' ? ' new' : '') + '">' +
      esc(e.origin === 'mod' ? '模组新增' : e.overridden ? '模组改写' : '基础游戏') + '</span>' +
      (e.isTriggeredOnly ? '<span class="flag hot">仅脚本触发</span>' : '') +
      (e.fireOnlyOnce ? '<span class="flag">只触发一次</span>' : '') +
      (e.hidden ? '<span class="flag">隐藏</span>' : '') +
      (e.major ? '<span class="flag hot">头条</span>' : '') +
      (e.minorFlavor ? '<span class="flag">彩蛋</span>' : '') +
      (e.fireForSender === false ? '<span class="flag">不发发起者</span>' : '') +
      '</div>'
    h += tr('<div class="kv"><b>文件</b><span>') + esc(e.file) + ':' + e.line + '</span></div>'
    h += tr('<div class="kv"><b>命名空间</b><span>') + esc(e.namespace || '—') + '</span></div>'
    if (e.picture) {
      h += tr('<div class="kv"><b>图片</b><span>') + esc(e.picture) + '</span></div>'
      h += '<div class="picshow" data-pic="' + esc(e.picture) + '"></div>'
    }

    h += tr('<div class="card"><div class="hd">标题 / 描述</div><div class="bd">') +
      '<div class="loc" id="locTitle"><span class="k">' + esc(e.title || '—') + '</span></div>' +
      '<div class="loc" id="locDesc"><span class="k">' + esc(e.desc || '—') + '</span></div>' +
      (e.titleCond ? '<div class="loc"><span class="k" style="color:var(--ink3)">title 条件块:</span><pre>' + esc(e.titleCond) + '</pre></div>' : '') +
      (e.descCond ? '<div class="loc"><span class="k" style="color:var(--ink3)">desc 条件块:</span><pre>' + esc(e.descCond) + '</pre></div>' : '') +
      '</div></div>'

    if (e.trigger) h += '<div class="card"><div class="hd">trigger</div><div class="bd"><pre>' + esc(e.trigger) + '</pre></div></div>'
    if (e.immediate) h += '<div class="card"><div class="hd">immediate</div><div class="bd"><pre>' + esc(e.immediate) + '</pre></div></div>'
    if (e.after) h += '<div class="card"><div class="hd">after</div><div class="bd"><pre>' + esc(e.after) + '</pre></div></div>'
    if (e.meanTimeToHappen) h += '<div class="card"><div class="hd">mean_time_to_happen</div><div class="bd"><pre>' + esc(e.meanTimeToHappen) + '</pre></div></div>'
    if (e.showMajor) h += '<div class="card"><div class="hd">show_major</div><div class="bd"><pre>' + esc(e.showMajor) + '</pre></div></div>'
    if (e.timeoutDays) h += tr('<div class="kv"><b>timeout_days</b><span>') + esc(e.timeoutDays) + tr(' 天</span></div>')
    if (e.triggerFor) h += tr('<div class="kv"><b>trigger_for</b><span>') + esc(e.triggerFor) + '</span></div>'
    var op = [e.originator && 'originator=' + e.originator, e.recipient && 'recipient=' + e.recipient, e.setRoot && 'set_root=' + e.setRoot, e.setFrom && 'set_from=' + e.setFrom, e.setFromFrom && 'set_from_from=' + e.setFromFrom].filter(Boolean)
    if (op.length) h += tr('<div class="kv"><b>operative 作用域</b><span>') + esc(op.join(' · ')) + '</span></div>'

    h += tr('<div class="card"><div class="hd">选项 <span style="font-weight:400;color:var(--ink3)">') + e.options.length + tr(' 个</span></div><div class="bd">')
    if (!e.options.length) h += tr('<div class="empty" style="padding:14px">没有 option —— 这类事件通常只播一条消息</div>')
    e.options.forEach(function (o, i) {
      h += '<div class="opt">' +
        tr('<div class="on">选项 ') + (i + 1) + '：<span class="k" style="font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--ink3)" id="optName' + i + '">' + esc(o.name || '—') + '</span></div>' +
        '<div class="meta">' +
        (o.aiChance ? '<span>ai_chance: ' + esc(o.aiChance) + '</span>' : tr('<span>无 ai_chance</span>')) +
        (o.hasTrigger ? '<span>有 trigger</span>' : '') +
        (o.originalRecipientOnly ? '<span>仅原始接收者</span>' : '') +
        '<span>' + o.effectCount + tr(' 条效果</span>') +
        tr('<span>行 ') + o.line + '</span>' +
        '</div>'
      if (o.effects.length) h += '<div class="eff">' + esc(o.effects.join('\n')) + '</div>'
      h += '</div>'
    })
    h += '</div></div>'

    h += tr('<div class="card"><div class="hd">option 原文</div><div class="bd">')
    e.options.forEach(function (o, i) {
      h += '<div style="margin-bottom:8px"><div style="font-size:11.5px;color:var(--ink3)">option ' + (i + 1) + '</div><pre>' + esc(o.script) + '</pre></div>'
    })
    h += '</div></div>'

    if (defs.length > 1) {
      h += tr('<div class="card"><div class="hd">覆盖链</div><div class="bd">')
      defs.forEach(function (d, i) {
        h += '<div class="kv"><b>' + esc(d.rootName) + '</b><span>' + esc(d.file) + ':' + d.line +
          (i === defs.length - 1 ? ' ← 生效' : '') + '</span></div>'
      })
      h += '</div></div>'
    }

    $('#detail').innerHTML = h
    // 图片:按 GFX 名经 /api/tex 解析游戏贴图,成功则渲染成 PNG
    ;(function () {
      var box = document.querySelector('.picshow')
      if (!box || !box.getAttribute('data-pic')) return
      var pic = box.getAttribute('data-pic')
      api('/api/tex?id=' + encodeURIComponent(pic)).then(function (j) {
        if (j && j.png) box.innerHTML = '<img src="data:image/png;base64,' + j.png + '" alt="" style="max-width:100%;max-height:280px;border-radius:8px;border:1px solid var(--line)">'
        else box.innerHTML = ''
      }).catch(function () { box.innerHTML = '' })
    })()
    // 本地化回填(异步,不阻塞主体渲染)
    locOf(e.title, function (v) {
      var el = document.getElementById('locTitle')
      if (!el) return
      el.innerHTML = v ? Loc.colorize(v).replace(/\n/g, '<br>') + (e.title ? ' <span class="k">' + esc(e.title) + '</span>' : '') : (e.title ? '<span class="k">' + esc(e.title) + '</span>' : '—')
    })
    locOf(e.desc, function (v) {
      var el = document.getElementById('locDesc')
      if (!el) return
      el.innerHTML = v ? Loc.colorize(v).replace(/\n/g, '<br>') + (e.desc ? ' <span class="k">' + esc(e.desc) + '</span>' : '') : (e.desc ? '<span class="k">' + esc(e.desc) + '</span>' : '—')
    })
    e.options.forEach(function (o, i) {
      locOf(o.name, function (v) {
        var el = document.getElementById('optName' + i)
        if (!el) return
        el.innerHTML = v ? Loc.colorize(v).replace(/\n/g, '<br>') + (o.name ? ' <span class="k">' + esc(o.name) + '</span>' : '') : (o.name ? '<span class="k">' + esc(o.name) + '</span>' : '—')
      })
    })
  }

  /* ── 绑定 ── */
  var qt = null
  $('#q').oninput = function () { clearTimeout(qt); qt = setTimeout(load, 320) }
  // ★ 级联筛选:选上级重置下级(src→file→ns),type 为辅助维度一并重置
  $('#src').onchange = function () { $('#file').value = ''; $('#ns').value = ''; $('#type').value = ''; load() }
  $('#file').onchange = function () { $('#ns').value = ''; $('#type').value = ''; load() }
  $('#ns').onchange = load
  $('#type').onchange = load
  $('#origin').onchange = load
  $('#reset').onclick = function () {
    $('#q').value = ''
    $('#ns').value = ''
    $('#type').value = ''
    $('#src').value = ''
    $('#origin').value = ''
    $('#file').value = ''
    load()
  }
  // 点击行打开详情(委托 —— 虚拟滚动下行是动态增删的)
  $('#list').addEventListener('click', function (ev) {
    var it = ev.target.closest ? ev.target.closest('.item') : null
    if (it) {
      var e = S.rows[+it.getAttribute('data-i')]
      if (e) open(e.id)
    }
  })

  $('#pgPrev').onclick = function () { gotoPage(S.page - 1) }
  $('#pgNext').onclick = function () { gotoPage(S.page + 1) }
  $('#pgInput').onchange = function () { gotoPage(this.value) }

  initLangBar()
  load()
  wireCtxAndKeys()
})()
