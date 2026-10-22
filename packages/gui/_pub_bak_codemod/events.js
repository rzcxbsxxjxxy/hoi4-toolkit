/* events.js —— 事件制作：列表 + 详情(触发 / 立即 / 选项 / 本地化联动)。
 *
 * ★ 展示原则:title / desc / option.name 存的都是【本地化 key】,
 *   直接显示 key 看不懂,所以详情里会顺带查一次 /api/loc/key 把译文带上。
 *   查不到就只显示 key 并标灰 —— 这本身就是"缺本地化"的信号。
 */
(function () {
  'use strict'
  var $ = function (s) { return document.querySelector(s) }
  var S = { rows: [], cur: null, meta: null, locCache: {} }

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
    q.push('limit=300')
    $('#list').innerHTML = '<div class="empty"><span class="spin"></span> 载入中…</div>'
    api('/api/events/list?' + q.join('&')).then(function (j) {
      if (!j.ready) {
        $('#list').innerHTML = '<div class="empty">索引构建中:' + esc(j.error || '请稍候') + '</div>'
        return
      }
      S.meta = j
      S.rows = j.rows || []
      fillFilters(j)
      $('#cnt').textContent = '共 ' + j.total + ' 个事件 · ' + (j.files || 0) + ' 个文件'
      renderList()
    }).catch(function (e) {
      $('#list').innerHTML = '<div class="empty">载入失败:' + esc(e.message) + '</div>'
    })
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

  function renderList() {
    if (!S.rows.length) { $('#list').innerHTML = '<div class="empty">没有匹配的事件</div>'; return }
    var h = ''
    S.rows.forEach(function (e, i) {
      var srcCls = e.overridden ? ' ovr' : e.origin === 'mod' ? ' new' : ''
      var srcTxt = e.overridden ? '模组改写' : e.origin === 'mod' ? '模组新增' : '基础游戏'
      h += '<div class="item' + (S.cur === e.id ? ' on' : '') + '" data-i="' + i + '">' +
        '<div class="id">' + esc(e.id) + '</div>' +
        '<div class="t">' + esc(e.title || e.desc || '（无标题）') + '</div>' +
        '<div class="t" style="margin-top:2px">' + esc(e.type) + ' · ' + e.options + ' 选项 · ' +
        '<span class="src' + srcCls + '">' + srcTxt + ' · ' + esc(e.src) + '</span></div>' +
        '</div>'
    })
    if (S.meta && S.meta.total > S.rows.length) {
      h += '<div class="empty">已显示 ' + S.rows.length + ' / ' + S.meta.total + ' —— 换个命名空间或用搜索缩小范围</div>'
    }
    $('#list').innerHTML = h
    var items = document.querySelectorAll('#list .item')
    for (var k = 0; k < items.length; k++) {
      (function (it) {
        var ev = S.rows[+it.getAttribute('data-i')]
        it.onclick = function () { open(ev.id) }
        // ★ RIGHTCLICK_V2:右键菜单的数据源。
        //   data-i 只是索引,不是数据 —— 记下 __obj 免得菜单再反查一遍。
        it.__obj = ev
      })(items[k])
    }
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
              e.type ? { label: '复制类型(' + e.type + ')', k: '⧉', act: function () { Ctx.copy(e.type, '') } } : null,
              e.options ? { label: '复制选项数(' + e.options + ')', k: '⧉', act: function () { Ctx.copy(String(e.options), '') } } : null,
              e.picture ? { label: '复制图片路径', k: '⧉', act: function () { Ctx.copy(e.picture, '') } } : null,
              { label: '复制命名空间(' + e.namespace + ')', k: '⧉', act: function () { Ctx.copy(e.namespace, '') } },
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

  /* 上下移动选中项(列表导航) */
  function step(d) {
    if (!S.rows.length) return
    var i = S.rows.findIndex(function (r) { return r.id === S.cur })
    var j = i < 0 ? 0 : i + d
    if (j < 0) j = 0
    if (j >= S.rows.length) j = S.rows.length - 1
    open(S.rows[j].id)
    var it = document.querySelectorAll('#list .item')[j]
    if (it && it.scrollIntoView) it.scrollIntoView({ block: 'nearest' })
  }

  /* ── 详情 ── */
  function open(id) {
    S.cur = id
    renderList()
    $('#detail').innerHTML = '<div class="empty"><span class="spin"></span></div>'
    api('/api/events/read?id=' + encodeURIComponent(id)).then(function (j) {
      if (!j.found) { $('#detail').innerHTML = '<div class="empty">找不到事件 ' + esc(id) + '</div>'; return }
      renderDetail(j.event, j.defs || [])
    }).catch(function (e) {
      $('#detail').innerHTML = '<div class="empty">读取失败:' + esc(e.message) + '</div>'
    })
  }

  /* 本地化:title / desc / option name 都是 key,顺手把译文取回来 */
  function locOf(key, cb) {
    if (!key) { cb(null); return }
    if (S.locCache[key] !== undefined) { cb(S.locCache[key]); return }
    api('/api/loc/key?key=' + encodeURIComponent(key)).then(function (j) {
      var pick = null
      if (j.ready && j.byLang) {
        pick = j.byLang.english || j.byLang.simp_chinese || j.byLang[j.langs && j.langs[0]] || null
      }
      S.locCache[key] = pick
      cb(pick)
    }).catch(function () { S.locCache[key] = null; cb(null) })
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
      '</div>'
    h += '<div class="kv"><b>文件</b><span>' + esc(e.file) + ':' + e.line + '</span></div>'
    h += '<div class="kv"><b>命名空间</b><span>' + esc(e.namespace || '—') + '</span></div>'
    if (e.picture) h += '<div class="kv"><b>图片</b><span>' + esc(e.picture) + '</span></div>'

    h += '<div class="card"><div class="hd">标题 / 描述</div><div class="bd">' +
      '<div class="loc" id="locTitle"><span class="k">' + esc(e.title || '—') + '</span></div>' +
      '<div class="loc" id="locDesc"><span class="k">' + esc(e.desc || '—') + '</span></div>' +
      '</div></div>'

    if (e.trigger) h += '<div class="card"><div class="hd">trigger</div><div class="bd"><pre>' + esc(e.trigger) + '</pre></div></div>'
    if (e.immediate) h += '<div class="card"><div class="hd">immediate</div><div class="bd"><pre>' + esc(e.immediate) + '</pre></div></div>'
    if (e.after) h += '<div class="card"><div class="hd">after</div><div class="bd"><pre>' + esc(e.after) + '</pre></div></div>'

    h += '<div class="card"><div class="hd">选项 <span style="font-weight:400;color:var(--ink3)">' + e.options.length + ' 个</span></div><div class="bd">'
    if (!e.options.length) h += '<div class="empty" style="padding:14px">没有 option —— 这类事件通常只播一条消息</div>'
    e.options.forEach(function (o, i) {
      h += '<div class="opt">' +
        '<div class="on">选项 ' + (i + 1) + '：<span class="k" style="font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--ink3)" id="optName' + i + '">' + esc(o.name || '—') + '</span></div>' +
        '<div class="meta">' +
        (o.aiChance ? '<span>ai_chance: ' + esc(o.aiChance) + '</span>' : '<span>无 ai_chance</span>') +
        (o.hasTrigger ? '<span>有 trigger</span>' : '') +
        '<span>' + o.effectCount + ' 条效果</span>' +
        '<span>行 ' + o.line + '</span>' +
        '</div>'
      if (o.effects.length) h += '<div class="eff">' + esc(o.effects.join('\n')) + '</div>'
      h += '</div>'
    })
    h += '</div></div>'

    h += '<div class="card"><div class="hd">option 原文</div><div class="bd">'
    e.options.forEach(function (o, i) {
      h += '<div style="margin-bottom:8px"><div style="font-size:11.5px;color:var(--ink3)">option ' + (i + 1) + '</div><pre>' + esc(o.script) + '</pre></div>'
    })
    h += '</div></div>'

    if (defs.length > 1) {
      h += '<div class="card"><div class="hd">覆盖链</div><div class="bd">'
      defs.forEach(function (d, i) {
        h += '<div class="kv"><b>' + esc(d.rootName) + '</b><span>' + esc(d.file) + ':' + d.line +
          (i === defs.length - 1 ? ' ← 生效' : '') + '</span></div>'
      })
      h += '</div></div>'
    }

    $('#detail').innerHTML = h
    // 本地化回填(异步,不阻塞主体渲染)
    locOf(e.title, function (v) {
      var el = document.getElementById('locTitle')
      if (el) el.innerHTML = v ? esc(v.value) + ' <span class="k">' + esc(e.title) + '</span>' : '<span class="k">' + esc(e.title || '—') + '</span>'
    })
    locOf(e.desc, function (v) {
      var el = document.getElementById('locDesc')
      if (el) el.innerHTML = v ? esc(v.value) + ' <span class="k">' + esc(e.desc) + '</span>' : '<span class="k">' + esc(e.desc || '—') + '</span>'
    })
    e.options.forEach(function (o, i) {
      locOf(o.name, function (v) {
        var el = document.getElementById('optName' + i)
        if (el && v) el.innerHTML = esc(v.value) + ' <span style="color:var(--ink3)">' + esc(o.name) + '</span>'
      })
    })
  }

  /* ── 绑定 ── */
  var qt = null
  $('#q').oninput = function () { clearTimeout(qt); qt = setTimeout(load, 320) }
  $('#ns').onchange = load
  $('#type').onchange = load
  $('#src').onchange = load
  $('#origin').onchange = load
  $('#file').onchange = load
  $('#reset').onclick = function () {
    $('#q').value = ''
    $('#ns').value = ''
    $('#type').value = ''
    $('#src').value = ''
    $('#origin').value = ''
    $('#file').value = ''
    load()
  }

  load()
  wireCtxAndKeys()
})()
