/* loc.js —— 本地化工具：多语言并列 / 缺失译文 / 单元格改写。
 *
 * ★ 三条设计约束:
 *   1) 语言可多选,默认 english + simp_chinese(用户点名的两门)。
 *   2) "缺译文"以【参照语言】为准(默认 english),不是"任意一门缺" ——
 *      否则 10 门语言里只要有 1 门没翻就全标红,没法用。
 *   3) 改写只落在可写 root(vanilla 一律只读),且按【行号 + key 复核】写,
 *      行号漂移会被后端拒绝,不会改错行。
 */
(function () {
  'use strict'
  var $ = function (s) { return document.querySelector(s) }
  var S = {
    langs: [], all: [], use: [], src: '', q: '', status: 'all',
    rows: [], total: 0, offset: 0,
    /** 文件过滤(后端 /api/loc/search?file= 支持,但UI 原本没暴露 —— 右键菜单用) */
    file: '',
    /** 当前选中格 {ri, lang};ri=-1 表示没选 */
    cur: { ri: -1, lang: '' },
  }

  function toast(msg, bad) {
    var t = $('#toast')
    t.textContent = msg
    t.className = 'on' + (bad ? ' bad' : '')
    clearTimeout(t._tm)
    t._tm = setTimeout(function () { t.className = '' }, 3000)
  }
  function api(u) {
    return fetch(u).then(function (r) { return r.json() })
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  /* ── 语言按钮 ── */
  function renderLangs() {
    var box = $('#langs')
    box.innerHTML = ''
    S.all.forEach(function (l) {
      var b = document.createElement('button')
      b.className = 'langbtn' + (S.use.indexOf(l.lang) >= 0 ? ' on' : '')
      b.innerHTML = esc(l.lang) + ' <i>' + l.keys + (l.missing ? ' · 缺' + l.missing : '') + '</i>'
      b.title = l.lang + '：' + l.keys + ' 条 key' + (l.missing ? '，相对参照语言缺 ' + l.missing + ' 条' : '')
      b.onclick = function () {
        var i = S.use.indexOf(l.lang)
        if (i >= 0) { if (S.use.length > 1) S.use.splice(i, 1) }
        else S.use.push(l.lang)
        renderLangs(); search()
      }
      box.appendChild(b)
    })
  }

  function renderStat(j) {
    var bits = []
    bits.push('<b>' + j.entries + '</b> 条目')
    bits.push('<b>' + j.files + '</b> 文件')
    bits.push('<b>' + j.langs.length + '</b> 语言')
    if (j.dupKeys) bits.push('<span class="warn">同语言重复 ' + j.dupKeys + ' 条</span>')
    if (j.missingBomCount) bits.push('<span class="warn">缺 BOM ' + j.missingBomCount + ' 个文件</span>')
    if (j.errorFiles && j.errorFiles.length) bits.push('<span class="warn">解析异常 ' + j.errorFiles.length + ' 个文件</span>')
    bits.push('索引 ' + j.ms + ' ms')
    $('#stat').innerHTML = bits.join(' · ') + ' · 参照语言 <b>' + esc(j.ref) + '</b>'
  }

  function loadStats() {
    return api('/api/loc/stats').then(function (j) {
      if (!j.ready) {
        // PROGRESS_V1:loc 索引全量构建很慢,页面无提示像卡死。
        // start() 内部有并发计数,重复调用不会重置计时。
        if (window.Progress) window.Progress.start('正在构建本地化索引…')
        $('#stat').innerHTML = '索引构建中…'; return null
      }
      if (window.Progress && window.Progress.active) window.Progress.done()
      S.all = j.langs || []
      if (!S.use.length) {
        S.use = []
        if (S.all.some(function (l) { return l.lang === 'english' })) S.use.push('english')
        if (S.all.some(function (l) { return l.lang === 'simp_chinese' })) S.use.push('simp_chinese')
        if (!S.use.length) S.use = S.all.slice(0, 2).map(function (l) { return l.lang })
      }
      var sel = $('#src')
      sel.innerHTML = '<option value="">全部来源</option>'
      ;(j.sources || []).forEach(function (s) {
        var o = document.createElement('option')
        o.value = s.name; o.textContent = s.name + (s.base ? '（基础）' : '（模组）')
        sel.appendChild(o)
      })
      renderLangs(); renderStat(j)
      return j
    })
  }

  /* ── 表格 ── */
  function search() {
    var q = []
    S.use.forEach(function (l) { q.push('lang=' + encodeURIComponent(l)) })
    q.push('q=' + encodeURIComponent(S.q))
    q.push('status=' + encodeURIComponent(S.status))
    if (S.src) q.push('src=' + encodeURIComponent(S.src))
    if (S.file) q.push('file=' + encodeURIComponent(S.file))
    q.push('limit=200')
    $('#body').innerHTML = '<div class="empty"><span class="spin"></span> 检索中…</div>'
    api('/api/loc/search?' + q.join('&')).then(function (j) {
      if (!j.ready) { $('#body').innerHTML = '<div class="empty">索引构建中,请稍候再点刷新</div>'; return }
      S.rows = j.rows || []
      S.total = j.total || 0
      render()
    }).catch(function (e) {
      $('#body').innerHTML = '<div class="empty">检索失败:' + esc(e.message) + '</div>'
    })
  }

  function render() {
    if (!S.rows.length) {
      $('#body').innerHTML = '<div class="empty">没有匹配的条目</div>'
      return
    }
    var h = '<table><thead><tr><th style="width:30%">key</th>'
    S.use.forEach(function (l) { h += '<th>' + esc(l) + '</th>' })
    h += '</tr></thead><tbody>'
    S.rows.forEach(function (r, ri) {
      h += '<tr data-r="' + ri + '"' + (S.cur.ri === ri ? ' class="sel"' : '') + '>' +
        '<td class="k" data-r="' + ri + '" title="' + esc(r.key) + '">' + esc(r.key) + '</td>'
      S.use.forEach(function (l) {
        var c = r.cells[l]
        if (!c) { h += '<td class="v miss" data-r="' + ri + '" data-l="' + esc(l) + '" title="缺译文">(缺失)</td>'; return }
        var cls = 'v' + (c.writable ? '' : ' ro')
        if (S.cur.ri === ri && S.cur.lang === l) cls += ' cursel'
        var tag = ''
        if (c.src && S.use.length) tag = ' <span class="src' + (c.writable ? ' new' : '') + '">' + esc(c.src) + '</span>'
        h += '<td class="' + cls + '" data-r="' + ri + '" data-l="' + esc(l) + '" title="' +
          (c.writable ? '点击编辑 · ' : '只读 · ') + esc(c.file) + ':' + c.line + '">' +
          esc(c.value) + tag + '</td>'
      })
      h += '</tr>'
    })
    h += '</tbody></table>'
    if (S.total > S.rows.length) {
      h += '<div class="empty">已显示 ' + S.rows.length + ' / ' + S.total + ' 条 —— 用搜索框缩小范围</div>'
    }
    $('#body').innerHTML = h
    bindCells()
  }

  function bindCells() {
    var tds = document.querySelectorAll('#body td.v')
    for (var i = 0; i < tds.length; i++) {
      (function (td) {
        td.onclick = function () {
          // 记录选中格 —— 键盘导航(上下换行 / 左右换语言列)全靠它
          select(+td.getAttribute('data-r'), td.getAttribute('data-l'))
          if (td.classList.contains('ro')) { toast('只读来源(vanilla)不可编辑', true); return }
          if (td.querySelector('textarea')) return
          var ri = +td.getAttribute('data-r')
          var lang = td.getAttribute('data-l')
          var cell = S.rows[ri].cells[lang]
          if (!cell) return
          editCell(td, cell)
        }
      })(tds[i])
    }
    var trs = document.querySelectorAll('#body tbody tr')
    for (var j = 0; j < trs.length; j++) {
      ;(function (tr) {
        tr.onclick = function (e) {
          // 点在 key 列 / 行内空白处 → 只选中不进入编辑
          if (e.target.closest('td.v')) return
          select(+tr.getAttribute('data-r'), S.cur.lang || S.use[0] || '')
        }
      })(trs[j])
    }
  }

  /* 选中某个格(只改 class,不重绘 —— 重绘会打断正在编辑的 textarea) */
  function select(ri, lang) {
    if (ri < 0 || ri >= S.rows.length) return
    if (!S.use.length) return
    if (lang && S.use.indexOf(lang) < 0) lang = ''
    if (!lang) lang = S.use.indexOf(S.cur.lang) >= 0 && S.cur.ri === ri ? S.cur.lang : S.use[0]
    S.cur = { ri: ri, lang: lang }
    var old = document.querySelector('#body td.cursel')
    if (old) old.classList.remove('cursel')
    var oldRow = document.querySelector('#body tr.sel')
    if (oldRow) oldRow.classList.remove('sel')
    var td = document.querySelector('#body td.v[data-r="' + ri + '"][data-l="' + lang + '"]')
    if (td) td.classList.add('cursel')
    var tr = document.querySelector('#body tr[data-r="' + ri + '"]')
    if (tr) tr.classList.add('sel')
  }

  /** 上下换行(d>0 下一行);左右换语言列 —— vim 式,和 ref/events 页一致 */
  function step(d, dlang) {
    if (!S.rows.length) return
    var ri = S.cur.ri < 0 ? 0 : S.cur.ri + d
    if (ri < 0) ri = 0
    if (ri >= S.rows.length) ri = S.rows.length - 1
    var lang = S.cur.lang
    if (dlang) {
      var i = S.use.indexOf(lang)
      if (i < 0) i = 0
      else i += dlang
      if (i < 0) i = 0
      if (i >= S.use.length) i = S.use.length - 1
      lang = S.use[i]
    } else if (!lang) {
      lang = S.use[0]
    }
    select(ri, lang)
    var td = document.querySelector('#body td.v[data-r="' + ri + '"][data-l="' + lang + '"]')
    if (td && td.scrollIntoView) td.scrollIntoView({ block: 'nearest' })
  }

  /** 当前选中格的数据对象;没选中返回 null */
  function curCell() {
    if (S.cur.ri < 0) return null
    var r = S.rows[S.cur.ri]
    if (!r) return null
    return r.cells[S.cur.lang] || null
  }

  function editCell(td, cell) {
    var old = td.innerHTML
    var ta = document.createElement('textarea')
    ta.value = cell.value
    td.innerHTML = ''
    td.appendChild(ta)
    var act = document.createElement('div')
    act.className = 'edact'
    var save = document.createElement('button')
    save.className = 'pri'; save.textContent = '保存'
    var cancel = document.createElement('button')
    cancel.textContent = '取消'
    act.appendChild(save); act.appendChild(cancel)
    td.appendChild(act)
    ta.focus()
    cancel.onclick = function () { td.innerHTML = old; bindCells() }
    save.onclick = function () { doSave(td, cell, ta.value, old) }
    ta.onkeydown = function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { doSave(td, cell, ta.value, old) }
      if (e.key === 'Escape') { td.innerHTML = old; bindCells() }
    }
  }

  function doSave(td, cell, value, oldHtml) {
    var parts = cell.parts || [{ index: null, value: cell.value, file: cell.file, line: cell.line, rootIdx: cell.rootIdx }]
    var lines = String(value).split('\n')
    var jobs
    if (parts.length > 1 && lines.length === parts.length) {
      jobs = parts.map(function (p, i) {
        return { rootIdx: p.rootIdx, file: p.file, line: p.line, key: cell.key, index: p.index, value: lines[i] }
      })
    } else if (parts.length > 1) {
      toast('这是 ' + parts.length + ' 行条目,请保持 ' + parts.length + ' 行(一行一段)', true)
      return
    } else {
      jobs = [{ rootIdx: parts[0].rootIdx, file: parts[0].file, line: parts[0].line, key: cell.key, index: parts[0].index, value: value }]
    }
    var chain = Promise.resolve({ ok: true })
    jobs.forEach(function (j) {
      chain = chain.then(function (prev) {
        if (!prev.ok) return prev
        return fetch('/api/loc/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j),
        }).then(function (r) { return r.json() })
      })
    })
    chain.then(function (r) {
      if (!r.ok) { toast('保存失败:' + (r.error || '未知'), true); return }
      cell.value = value
      toast('已保存 ' + jobs.length + ' 处')
      td.innerHTML = esc(value)
      // 索引已失效,下次搜索会重建;这里直接重查,保证显示是最新的
      setTimeout(search, 50)
    }).catch(function (e) {
      toast('保存失败:' + e.message, true)
      td.innerHTML = oldHtml
      bindCells()
    })
  }

  /* ══════════════════════════════════════════════════════════════════
   * 右键菜单 + 快捷键(RIGHTCLICK_V2 / CtxWire)
   *
   * loc 页的右键价值全在**一个格子上携带 6 个可操作量**:
   *   key(本地化 key = 标识符) / value(译文) / lang(语言)
   *   file + line(定义位置) / src(来源 root 名) / writable(可否改)
   * 所以菜单按"格子"给,而不是按"行"给。
   *
   * ★ 后端字段核实(2026-10-05,server.ts:1564locRowJson):
   *   { key, value, multi, parts[{index,value,file,line,rootIdx}],
   *     rootIdx, src, file, line, writable }
   *   ⚠ file 是**相对 root 的路径**(locsrv.ts:137 `file: rel`),
   *     rootIdx 才是 root 序号 —— 传给 Ctx.sourceItems 时 root=rootIdx。
   * ══════════════════════════════════════════════════════════════════ */
  function wireCtxAndKeys() {
    if (!window.CtxWire || !window.Ctx) return
    // 事件委托只把匹配到的 <tr> 传进来,拿不到"右键落在哪个 td"。
    // 用捕获阶段记一次落点(只记不消费,preventDefault 仍由 Ctx.attach 做)。
    document.addEventListener('contextmenu', function (e) {
      var td = e.target.closest ? e.target.closest('#body td.v') : null
      S.hit = td
        ? { ri: +td.getAttribute('data-r'), lang: td.getAttribute('data-l') }
        : null
    }, true)

    CtxWire.attach({
      page: 'loc',
      on: [
        {
          host: '#body',
          sel: 'tbody tr',
          obj: function (tr) {
            var ri = +tr.getAttribute('data-r')
            var row = S.rows[ri]
            if (!row) return null
            // 落在译文格上就用那一格;落在 key 列/行空白 → 用当前选中格
            var hit = S.hit && S.hit.ri === ri ? S.hit : null
            var lang = hit ? hit.lang : (S.cur.ri === ri ? S.cur.lang : '')
            return { row: row, ri: ri, lang: lang }
          },
          items: function (o) { return cellMenu(o) },
        },
      ],
      keys: [].concat(
        [
          { id: 'find.search', desc: '聚焦搜索框', group: '查找', run: function () { var q = $('#q'); if (q) { q.focus(); q.select && q.select() } } },
          { id: 'sel.clear', desc: '清空搜索 / 取消编辑', group: '查找', run: clearAll },
          { id: 'nav.nextItem', desc: '下一条', group: '浏览', run: function () { step(1, 0) } },
          { id: 'nav.prevItem', desc: '上一条', group: '浏览', run: function () { step(-1, 0) } },
          { id: 'nav.nextCol', desc: '下一门语言', group: '浏览', run: function () { step(0, 1) } },
          { id: 'nav.prevCol', desc: '上一门语言', group: '浏览', run: function () { step(0, -1) } },
          { id: 'loc.edit', desc: '编辑选中的译文', group: '编辑', run: editCur },
        ],
        CtxWire.commonKeys(curId, { label: '条目' }),
      ),
    })
  }

  function curId() {
    var c = curCell()
    if (c) return c.key
    if (S.cur.ri >= 0 && S.rows[S.cur.ri]) return S.rows[S.cur.ri].key
    return null
  }

  /** 取某行某语的格子数据;lang 空则退回该行第一个可定位的格子 */
  function cellOf(ri, lang) {
    var row = S.rows[ri]
    if (!row) return null
    if (lang && row.cells[lang]) return { lang: lang, cell: row.cells[lang] }
    for (var i = 0; i < S.use.length; i++) {
      if (row.cells[S.use[i]]) return { lang: S.use[i], cell: row.cells[S.use[i]] }
    }
    return null
  }

  /**
   * 格子的右键菜单。
   * 事件委托拿不到"右键落在哪个 td"(ctx.js 只把匹配到的 tr 传进来),
   * 所以额外挂一个 document 级监听记落点 —— 只记不消费,
   * Ctx.attach 仍负责 preventDefault 与弹菜单。
   */
  function cellMenu(o) {
    var hit = cellOf(o.ri, o.lang || S.cur.lang)
    var row = o.row
    var key = row.key
    var cell = hit && hit.cell
    var lang = hit && hit.lang
    var extra = []

    extra.push({
      label: '复制本地化 key', k: '⧉',
      act: function () { Ctx.copy(key, ' ' + key) },
    })
    if (cell) {
      extra.push({
        label: '复制' + lang + '译文', k: '⧉',
        hint: cell.multi ? cell.parts.length + ' 行' : '',
        act: function () { Ctx.copy(cell.value, '') },
      })
    }
    // 整行复制成 TSV —— 直接粘进 Excel / 表格工具对译极有用
    extra.push({
      label: '复制整行(key + 各语言)', k: '⧉',
      act: function () {
        var tsv = [key].concat(S.use.map(function (l) {
          var c = row.cells[l]
          return c ? String(c.value).replace(/\t/g, ' ').replace(/\n/g, '\\n') : ''
        })).join('\t')
        Ctx.copy(tsv, '')
      },
    })
    // 只看这一个 key —— 表格里 key 经常被截断,这个最实用
    extra.push({
      label: '只看这个 key', k: '→',
      act: function () { S.q = key; $('#q').value = key; search() },
    })

    if (cell) {
      extra.push({ sep: true })
      extra.push({
        label: '只看这个文件', k: '→',
        act: function () { S.file = cell.file; search(); renderFileChip() },
      })
      extra.push({
        label: cell.writable ? '编辑这条译文' : '只读,不可编辑',
        dis: !cell.writable,
        act: function () { editCell(tdOf(o.ri, lang), cell) },
      })
      if (cell.multi && cell.parts.length > 1) {
        extra.push({
          label: '复制全部 ' + cell.parts.length + ' 段位置', k: '⧉',
          act: function () {
            Ctx.copy(cell.parts.map(function (p) { return p.file + ':' + p.line }).join('\n'), '')
          },
        })
      }
    }

    return Ctx.sourceItems({
      root: cell ? cell.rootIdx : undefined,
      rootName: cell ? cell.src : '',
      file: cell ? cell.file : '',
      line: cell ? cell.line : 0,
      id: key,
      extra: extra,
    })
  }

  function tdOf(ri, lang) {
    return document.querySelector('#body td.v[data-r="' + ri + '"][data-l="' + lang + '"]')
  }

  function editCur() {
    var c = curCell()
    if (!c) { toast('先点选一个译文格', true); return }
    var td = tdOf(S.cur.ri, S.cur.lang)
    if (!td) return
    if (td.querySelector('textarea')) { td.querySelector('textarea').focus(); return }
    if (!c.writable) { toast('只读来源(vanilla)不可编辑', true); return }
    editCell(td, c)
  }

  function clearAll() {
    // 编辑中的 textarea 自己处理 Esc(它 stopPropagation),走到这里说明不在编辑
    var ta = document.querySelector('#body textarea')
    if (ta) { ta.blur(); return }
    if (S.file) { S.file = ''; renderFileChip(); search(); return }
    if (S.q) { S.q = ''; $('#q').value = ''; search(); return }
    if (S.status !== 'all') { S.status = 'all'; $('#status').value = 'all'; search(); return }
    if (S.src) { S.src = ''; $('#src').value = ''; search() }
  }

  /** 文件过滤是右键加的、UI 上没有输入框 —— 必须给一个可见的出口,否则用户以为搜索失灵了 */
  function renderFileChip() {
    var box = $('#fchip')
    if (!box) return
    if (!S.file) { box.innerHTML = ''; box.style.display = 'none'; return }
    box.style.display = ''
    box.innerHTML = '仅看文件 <b>' + esc(S.file) + '</b> <button id="fchipX" title="Esc 也可清除">✕</button>'
    $('#fchipX').onclick = function () { S.file = ''; renderFileChip(); search() }
  }

  /* ── 绑定 ── */
  var qt = null
  $('#q').oninput = function () {
    clearTimeout(qt)
    var v = this.value
    qt = setTimeout(function () { S.q = v; search() }, 300)
  }
  $('#status').onchange = function () { S.status = this.value; search() }
  $('#src').onchange = function () { S.src = this.value; search() }
  $('#reload').onclick = function () { loadStats().then(search) }
  $('#rebuild').onclick = function () {
    $('#stat').innerHTML = '<span class="spin"></span> 重建索引中…'
    api('/api/loc/stats?rebuild=1').then(function (j) {
      if (!j.ready) { toast('重建失败:' + j.error, true); return }
      S.use = []; loadStats().then(search); toast('索引已重建')
    })
  }

  loadStats().then(function () { search() })
  wireCtxAndKeys()
})()
