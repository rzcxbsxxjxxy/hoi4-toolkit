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
    /** ★ LOCALISATION_V2:浏览模式 key(全表)/ file(按文件递归);默认 key */
    mode: 'key', curFile: '', files: null, open: {},
    page: 0, pageSize: 200, allRows: null, seq: 0,
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
      b.innerHTML = esc(l.lang) + ' <i>' + l.keys + (l.missing ? tr(' · 缺') + l.missing : '') + '</i>'
      b.title = l.lang + '：' + l.keys + tr(' 条 key') + (l.missing ? tr('，相对参照语言缺 ') + l.missing + tr(' 条') : '')
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
    bits.push('<b>' + j.entries + tr('</b> 条目'))
    bits.push('<b>' + j.files + tr('</b> 文件'))
    bits.push('<b>' + j.langs.length + tr('</b> 语言'))
    if (j.dupKeys) bits.push(tr('<span class="warn">同语言重复 ') + j.dupKeys + tr(' 条</span>'))
    if (j.missingBomCount) bits.push(tr('<span class="warn">缺 BOM ') + j.missingBomCount + tr(' 个文件</span>'))
    if (j.errorFiles && j.errorFiles.length) bits.push(tr('<span class="warn">解析异常 ') + j.errorFiles.length + tr(' 个文件</span>'))
    bits.push(tr('索引 ') + j.ms + ' ms')
    $('#stat').innerHTML = bits.join(' · ') + tr(' · 参照语言 <b>') + esc(j.ref) + '</b>'
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
        // ★ 基础语言 = 英文(l_english);默认与简体中文并列(用户口径)
        if (S.all.some(function (l) { return l.lang === 'l_english' || l.lang === 'english' })) S.use.push('l_english')
        if (S.all.some(function (l) { return l.lang === 'l_simp_chinese' || l.lang === 'simp_chinese' })) S.use.push('l_simp_chinese')
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
  function search(keepPage) {
    // ★ LOCALISATION_V3 分页:默认每页 S.pageSize 条,服务端 offset/limit 翻页
    if (!keepPage) S.page = 0
    S.allRows = null
    var seq = ++S.seq  // 竞态守卫:翻页/换筛时丢弃过期响应
    var q = []
    S.use.forEach(function (l) { q.push('lang=' + encodeURIComponent(l)) })
    q.push('q=' + encodeURIComponent(S.q))
    q.push('status=' + encodeURIComponent(S.status))
    if (S.src) q.push('src=' + encodeURIComponent(S.src))
    if (S.file) q.push('file=' + encodeURIComponent(S.file))
    q.push('limit=' + S.pageSize)
    q.push('offset=' + (S.page * S.pageSize))
    $('#body').innerHTML = '<div class="empty"><span class="spin"></span> 检索中…</div>'
    api('/api/loc/search?' + q.join('&')).then(function (j) {
      if (seq !== S.seq) return
      if (!j.ready) { $('#body').innerHTML = '<div class="empty">索引构建中,请稍候再点刷新</div>'; return }
      S.rows = j.rows || []
      S.total = j.total || 0
      render()
    }).catch(function (e) {
      if (seq !== S.seq) return
      $('#body').innerHTML = tr('<div class="empty">检索失败:') + esc(e.message) + '</div>'
    })
  }

  function render() {
    // 按文件模式:全量存于 allRows,这里按页切片(客户端分页);key 模式服务端已分页
    if (S.mode === 'file' && S.allRows) {
      var st = S.page * S.pageSize
      S.rows = S.allRows.slice(st, st + S.pageSize)
    }
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
        if (!c) { h += '<td class="v miss" data-r="' + ri + '" data-l="' + esc(l) + tr('" title="缺译文">(缺失)</td>'); return }
        var cls = 'v' + (c.writable ? '' : ' ro')
        if (S.cur.ri === ri && S.cur.lang === l) cls += ' cursel'
        var tag = ''
        if (c.src && S.use.length) tag = ' <span class="src' + (c.writable ? ' new' : '') + '">' + esc(c.src) + '</span>'
        h += '<td class="' + cls + '" data-r="' + ri + '" data-l="' + esc(l) + '" title="' +
          (c.writable ? '点击编辑 · ' : tr('只读 · ')) + esc(c.file) + ':' + c.line + '">' +
          Loc.richText(c.value) + tag + '</td>'
      })
      h += '</tr>'
    })
    h += '</tbody></table>'
    var pages = Math.max(1, Math.ceil(S.total / S.pageSize))
    if (S.total > S.pageSize) {
      h += '<div class="pager">' +
        '<button id="pgPrev"' + (S.page <= 0 ? ' disabled' : '') + '>‹ ' + tr('上一页') + '</button>' +
        '<span class="pgmid">' + tr('第 ') + (S.page + 1) + ' / ' + pages + tr(' 页 · 共 ') + S.total + tr(' 条') + '</span>' +
        '<button id="pgNext"' + (S.page >= pages - 1 ? ' disabled' : '') + '>' + tr('下一页') + ' ›</button></div>'
    }
    $('#body').innerHTML = h
    bindCells()
    bindPager()
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
      toast(tr('这是 ') + parts.length + tr(' 行条目,请保持 ') + parts.length + tr(' 行(一行一段)'), true)
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
      if (!r.ok) { toast(tr('保存失败:') + (r.error || '未知'), true); return }
      cell.value = value
      toast(tr('已保存 ') + jobs.length + tr(' 处'))
      td.innerHTML = Loc.richText(value)
      // 索引已失效,下次会重建;这里直接重查(按当前模式),保证显示是最新的
      setTimeout(refresh, 50)
    }).catch(function (e) {
      toast(tr('保存失败:') + e.message, true)
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
        label: tr('复制') + lang + tr('译文'), k: '⧉',
        hint: cell.multi ? cell.parts.length + tr(' 行') : '',
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
          label: tr('复制全部 ') + cell.parts.length + tr(' 段位置'), k: '⧉',
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
    box.innerHTML = tr('仅看文件 <b>') + esc(S.file) + tr('</b> <button id="fchipX" title="Esc 也可清除">✕</button>')
    $('#fchipX').onclick = function () { S.file = ''; renderFileChip(); search() }
  }

  /* ═══ 按文件浏览(LOCALISATION_V2)═══
   * 模式切换:key(全表检索)/ file(递归文件树 → 逐文件看文本 + 跨语言缺失)。
   * 复用现有 render()/editCell/doSave/step —— 只需把 S.rows 换成该文件条目。 */
  var LANG_CN = { english:'英文', simp_chinese:'简体中文', german:'德文', french:'法文', spanish:'西班牙文',
    polish:'波兰文', russian:'俄文', japanese:'日文', korean:'韩文', braz_por:'巴西葡文' }
  function langLabel(lang) { var id = lang.replace(/^l_/, ''); return LANG_CN[id] || id }
  function refresh() { if (S.mode === 'file' && S.curFile) openFile(S.curFile); else search() }
  function setMode(m) {
    S.mode = m
    $('#mode').textContent = m === 'file' ? '按 key 浏览' : '按文件浏览'
    $('#mode').className = m === 'file' ? 'on' : ''
    $('#ftree').style.display = m === 'file' ? '' : 'none'
    if (m === 'file') { if (!S.open['L:l_english'] && !S.open['L:english']) S.open['L:l_english'] = S.open['L:english'] = true; loadFiles() }
    else renderLangs()
    refresh()
  }
  function loadFiles() {
    api('/api/loc/files').then(function (j) {
      if (!j.ready) { $('#ftree').innerHTML = '<div class="empty">索引构建中…</div>'; return }
      S.files = j.langs || []
      S.ref = j.ref || ''
      renderTree()
    })
  }
  function renderTree() {
    var box = $('#ftree')
    if (!S.files) return
    var h = ''
    S.files.forEach(function (L) {
      var lKey = 'L:' + L.lang
      var on = S.open[lKey]
      h += '<div class="fl" data-k="' + esc(lKey) + '">' + (on ? '▾ ' : '▸ ') + esc(langLabel(L.lang)) +
        ' <i>' + L.keys + tr(' key') + (L.missing ? ' <i class="miss">缺' + L.missing + '</i>' : '') + '</i></div>'
      if (on) {
        L.dirs.forEach(function (d) {
          var dKey = lKey + '/D:' + d.dir
          var don = S.open[dKey]
          h += '<div class="fd" data-k="' + esc(dKey) + '">' + (don ? '▾ ' : '▸ ') + esc(d.dir) + '</div>'
          if (don) d.files.forEach(function (f) {
            var onF = S.curFile === f.file
            h += '<div class="ff' + (onF ? ' on' : '') + '" data-f="' + esc(f.file) + '">' +
              '<span class="n">' + esc(basename(f.file)) + '</span>' +
              (f.errors ? '<span class="e" style="color:var(--danger)">err</span>' : '') +
              '<span class="e">' + f.entries + '</span></div>'
          })
        })
      }
    })
    box.innerHTML = h
    Array.prototype.forEach.call(box.querySelectorAll('.fl,.fd'), function (el) {
      el.onclick = function () { S.open[el.getAttribute('data-k')] = !S.open[el.getAttribute('data-k')]; renderTree() }
    })
    Array.prototype.forEach.call(box.querySelectorAll('.ff'), function (el) {
      el.onclick = function () { openFile(el.getAttribute('data-f')) }
    })
  }
  function basename(path) { var i = path.lastIndexOf('/'); return i >= 0 ? path.slice(i + 1) : path }
  function openFile(path) {
    S.curFile = path
    renderTree()
    var q = ['path=' + encodeURIComponent(path)]
    S.use.forEach(function (l) { q.push('lang=' + encodeURIComponent(l)) })
    $('#body').innerHTML = '<div class="empty"><span class="spin"></span> ' + tr('加载 ') + esc(path) + ' …</div>'
    var seq = ++S.seq  // 竞态守卫
    api('/api/loc/file?' + q.join('&')).then(function (j) {
      if (seq !== S.seq) return
      if (!j.ready) { $('#body').innerHTML = '<div class="empty">' + tr('索引构建中…') + '</div>'; return }
      if (!j.found) { $('#body').innerHTML = '<div class="empty">' + tr('文件不存在:') + ' ' + esc(path) + '</div>'; return }
      S.allRows = j.rows || []
      S.total = S.allRows.length
      S.page = 0
      $('#stat').innerHTML = tr('当前文件 <b>') + esc(path) + tr('</b> · ') + j.entries + tr(' 条 · 宿主语言 ') + esc(langLabel(j.hostLang))
      render()
    }).catch(function (e) {
      if (seq !== S.seq) return
      $('#body').innerHTML = tr('<div class="empty">加载失败:') + esc(e.message) + '</div>'
    })
  }

  function gotoPage(p) {
    var pages = Math.max(1, Math.ceil(S.total / S.pageSize))
    if (p < 0) p = 0
    if (p > pages - 1) p = pages - 1
    if (p === S.page) return
    S.page = p
    if (S.mode === 'file') render()
    else search(true)
  }
  function bindPager() {
    var pp = document.getElementById('pgPrev'); if (pp) pp.onclick = function () { gotoPage(S.page - 1) }
    var pn = document.getElementById('pgNext'); if (pn) pn.onclick = function () { gotoPage(S.page + 1) }
  }

  /* ══════════════════════════════════════════════════════════════
   * 导出缺失译文为游戏本地化 yaml(MISSING_YAML_V1)
   * 值 = 英文参照原文,供据此翻译为各目标语言;格式与游戏 yml 一致:
   *   l_xxx:  key:0 "译文"
   * ══════════════════════════════════════════════════════════════ */
  function exportYaml() {
    var ref = 'l_english'
    var target = S.use.filter(function (l) { return l !== ref })
    if (!target.length) {
      toast(tr('请至少选一门目标语言(除英文参照外),再点导出'), true)
      return
    }
    var q = []
    q.push('lang=' + encodeURIComponent(ref))
    target.forEach(function (l) { q.push('lang=' + encodeURIComponent(l)) })
    // 始终以「缺译文」口径导出:导出缺失文本就是本按钮的用途
    q.push('status=missing')
    if (S.q) q.push('q=' + encodeURIComponent(S.q))
    if (S.src) q.push('src=' + encodeURIComponent(S.src))
    if (S.mode === 'file' && S.curFile) q.push('file=' + encodeURIComponent(S.curFile))
    else if (S.file) q.push('file=' + encodeURIComponent(S.file))

    toast(tr('正在收集缺失译文…'))
    var all = []
    var seq = ++S.seq
    ;(function page(off) {
      return api('/api/loc/search?' + q.join('&') + '&limit=1000&offset=' + off).then(function (j) {
        if (seq !== S.seq) return
        if (!j.ready) { toast(tr('导出失败:索引构建中'), true); return }
        Array.prototype.push.apply(all, j.rows || [])
        var got = (j.rows || []).length
        var next = off + got
        if (next < (j.total || 0)) return page(next)
        buildAndDownload(all, j.ref || ref, target)
      })
    })(0).catch(function (e) {
      if (seq !== S.seq) return
      toast(tr('导出失败:') + (e.message || '未知'), true)
    })
  }

  function buildAndDownload(rows, refLang, target) {
    var now = new Date().toISOString().slice(0, 10)
    var byLang = {}
    var total = 0
    target.forEach(function (l) { byLang[l] = [] })
    rows.forEach(function (r) {
      target.forEach(function (l) {
        if (r.cells[l]) return // 这门语言有译文,不缺
        var refText = (r.cells[refLang] && r.cells[refLang].value) ? r.cells[refLang].value : ''
        byLang[l].push({ key: r.key, text: refText })
        total++
      })
    })
    var lines = []
    lines.push('# HOI4 本地化 — 缺失译文导出')
    lines.push('# 生成时间: ' + now + ' · 参照语言: ' + refLang)
    lines.push('# 值 = 英文参照原文;翻译完成后请替换为该语言的译文。')
    lines.push('# 格式与游戏本地化 yml 一致:  语言:  key:0 "译文"')
    lines.push('')
    target.forEach(function (l) {
      var list = byLang[l]
      lines.push(l + ':')
      if (!list.length) { lines.push('  # 无缺失'); lines.push(''); return }
      lines.push('  # 缺 ' + list.length + ' 条(值为英文原文,待翻译)')
      list.forEach(function (it) {
        lines.push('  ' + it.key + ':0 "' + (it.text ? String(it.text).replace(/"/g, '""') : '') + '"')
      })
      lines.push('')
    })
    var blob = new Blob([lines.join('\n')], { type: 'text/yaml;charset=utf-8' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'hoi4_loc_missing_' + now + '.yml'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(a.href)
    toast(tr('已导出 ') + total + tr(' 条缺失译文 → ') + a.download)
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
  $('#mode').onclick = function () { setMode(S.mode === 'key' ? 'file' : 'key') }
  $('#pageSize').onchange = function () { S.pageSize = +this.value; S.page = 0; refresh() }
  $('#export').onclick = exportYaml
  $('#reload').onclick = function () { if (S.mode === 'file') loadFiles(); loadStats().then(refresh) }
  $('#rebuild').onclick = function () {
    $('#stat').innerHTML = '<span class="spin"></span> 重建索引中…'
    api('/api/loc/stats?rebuild=1').then(function (j) {
      if (!j.ready) { toast(tr('重建失败:') + j.error, true); return }
      S.use = []; loadStats().then(search); toast('索引已重建')
    })
  }

  loadStats().then(function () { search() })
  wireCtxAndKeys()
})()
