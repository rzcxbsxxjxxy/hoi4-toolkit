/* TRACKER_V2 · 更新跟踪前端（基础游戏与每个模组按来源独立） */
(function () {
  'use strict'
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.from(document.querySelectorAll(s))
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const L = window.I18N
  const EN = L && typeof L.getLang === 'function' && L.getLang() === 'en'
  const T = (k, fb) => (L && L.t ? L.t(k) : (fb || k))
  const KIND_L = EN
    ? { new: 'New', modified: 'Modified', deleted: 'Deleted', moved: 'Moved' }
    : { new: '新增', modified: '修改', deleted: '删除', moved: '移动' }
  const OWN_L = EN
    ? { vanilla: 'Vanilla', override: 'Override', new: 'New', gap: 'GAP' }
    : { vanilla: '原版', override: '覆盖', new: '新增', gap: 'GAP' }

  let roots = []      // TrackRootStatus[]
  let selKey = null   // 当前选中的来源 key
  let hist = []       // 选中来源的 history 摘要列表(summary)
  let curEntry = null // 当前选中条目的完整内容(changes)，选中时按需拉取
  let curTs = null    // 当前选中条目的文件名(ts)
  let curIdx = null
  let busy = false
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function setBusy(b) {
    busy = b
    $('#busyBadge').style.display = b ? '' : 'none'
    $$('button[data-act]').forEach((el) => { if (el.dataset.act !== 'detail') el.disabled = b })
    $('#clearAllBtn').disabled = b
    $('#gcBtn').disabled = b
  }

  async function loadStatus() {
    try {
      const d = await (await fetch('/api/tracker/status')).json()
      roots = d.roots || []
      renderRoots()
    } catch (e) { /* 服务未就绪 */ }
  }
  async function loadHistory(key) {
    try {
      const d = await (await fetch('/api/tracker/history?root=' + encodeURIComponent(key))).json()
      hist = d.history || [] // 摘要列表（fileName/checkedAt/stats），秒开
      curIdx = hist.length ? 0 : null
      curEntry = null
      curTs = null
      renderTimeline()
      if (curIdx !== null) await select(curIdx)
      else { renderFilters(); renderChanges() }
    } catch (e) { /* 忽略 */ }
  }

  function renderRoots() {
    const box = $('#roots')
    if (!roots.length) { box.innerHTML = '<div class="empty">' + T('tr.noSources') + '</div>'; return }
    box.innerHTML = roots.map((r) => {
      const open = r.key === selKey && $('#detail').style.display !== 'none'
      const sub = []
      if (r.hasBaseline) {
        sub.push('<span class="stat-k">' + T('tr.baselineAt') + '</span> ' + new Date(r.baselineAt).toLocaleString())
        sub.push('<span class="stat-k">' + T('tr.files') + '</span> ' + r.baselineFiles)
      } else {
        sub.push('<span class="pill">⚠ ' + T('tr.noBaseline') + '</span>')
      }
      if (r.lastCheckAt) sub.push('<span class="stat-k">' + T('tr.lastCheck') + '</span> ' + new Date(r.lastCheckAt).toLocaleString() + ' · ' + r.lastCheckTotal)
      const access = r.writable ? '<span class="pill">' + T('tr.writable') + '</span>' : '<span class="pill">' + T('tr.readonly') + '</span>'
      return '<div class="root-card' + (r.key === selKey ? ' cur' : '') + '" data-key="' + esc(r.key) + '">' +
        '<div class="root-head"><span class="root-name">' + esc(r.name) + '</span>' + access + '</div>' +
        '<div class="root-sub">' + sub.join(' &nbsp; ') + '</div>' +
        '<div class="acts">' +
          '<span class="sp"></span>' +
          '<button data-act="baseline" data-key="' + esc(r.key) + '">' + T('tr.buildBaseline') + '</button>' +
          '<button data-act="check" data-key="' + esc(r.key) + '"' + (r.hasBaseline ? '' : ' disabled') + '>' + T('tr.checkNow') + '</button>' +
          '<button data-act="detail" data-key="' + esc(r.key) + '">' + (open ? T('tr.closeList') : T('tr.openList')) + '</button>' +
          '<button data-act="reset" data-key="' + esc(r.key) + '"' + (r.hasBaseline ? '' : ' disabled') + '>' + T('tr.resetBaseline') + '</button>' +
          '<button class="danger" data-act="clearRoot" data-key="' + esc(r.key) + '">' + T('tr.clearRoot') + '</button>' +
        '</div>' +
      '</div>'
    }).join('')
  }

  $('#roots').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]')
    if (!btn) return
    const key = btn.dataset.key
    const act = btn.dataset.act
    if (act === 'baseline') doBaseline(key)
    else if (act === 'check') doCheck(key)
    else if (act === 'clearRoot') doClearRoot(key)
    else if (act === 'reset') doReset(key)
    else if (act === 'detail') {
      const det = $('#detail')
      if (det.style.display !== 'none' && selKey === key) { det.style.display = 'none'; selKey = null; renderRoots(); setHistTitle(false); return }
      selectRoot(key)
    }
  })

  function setHistTitle(open) {
    const el = document.getElementById('histTitle')
    if (el) el.textContent = T(open ? 'tr.closeList' : 'tr.openList')
  }
  function selectRoot(key) {
    selKey = key
    renderRoots()
    $('#detail').style.display = ''
    setHistTitle(true)
    showListProg()
    loadHistory(key).finally(closeTrack)
  }
  function showListProg() {
    $('#progTitle').textContent = T('tr.loadList')
    $('#progPct').textContent = ''
    $('#progFill').classList.add('indet')
    $('#progFill').style.width = ''
    $('#progStage').textContent = ''
    $('#prog').style.display = ''
  }

  function renderTimeline() {
    const box = $('#timeline')
    if (!hist.length) { box.innerHTML = '<div class="empty">' + T('tr.noHistory') + '</div>'; return }
    box.innerHTML = hist.map((e, i) => {
      const k = e.stats.byKind || {}
      const mk = (key, label, n) => '<span class="pill ' + key + '">' + label + ' ' + n + '</span>'
      const sub = mk('new', KIND_L.new, k.new || 0) + mk('modified', KIND_L.modified, k.modified || 0) + mk('deleted', KIND_L.deleted, k.deleted || 0) + mk('moved', KIND_L.moved, k.moved || 0)
      return '<div class="tl-item' + (i === curIdx ? ' cur' : '') + '" data-i="' + i + '">' +
        '<div class="tm">' + new Date(e.checkedAt).toLocaleString() + '</div>' +
        '<button class="delhist" data-ts="' + esc(e.fileName || '') + '" title="' + T('tr.delHist') + '">✕</button>' +
        '<div class="sub">' + sub + '</div></div>'
    }).join('')
  }

  $('#timeline').addEventListener('click', (ev) => {
    const del = ev.target.closest('button.delhist')
    if (del) { doDelHist(del.dataset.ts); return }
    const row = ev.target.closest('.tl-item')
    if (row) select(Number(row.dataset.i))
  })

  async function select(i) {
    curIdx = i
    const e = hist[i]
    curTs = e ? e.fileName : null
    renderTimeline()
    $('#changes').innerHTML = '<div class="empty">' + T('tr.loading') + '</div>'
    let loadErr = null
    try {
      if (e && e.fileName) {
        const r = await fetch('/api/tracker/historyEntry?root=' + encodeURIComponent(selKey) + '&ts=' + encodeURIComponent(e.fileName))
        const d = await r.json().catch(() => null)
        if (!r.ok) loadErr = (d && d.error) ? d.error : ('HTTP ' + r.status)
        else curEntry = d.entry || null
      } else curEntry = null
    } catch (e2) { loadErr = String((e2 && e2.message) || e2) }
    renderFilters()
    if (loadErr) {
      $('#changes').innerHTML = '<div class="empty">⚠ ' + esc(loadErr) + '</div>'
      return
    }
    renderChanges()
  }
  function renderFilters() {
    const entry = curEntry
    const sel = $('#fKind')
    const kinds = new Set()
    if (entry) for (const c of entry.changes) kinds.add(c.kind)
    const curK = sel.value
    sel.innerHTML = '<option value="">' + T('tr.allKinds') + '</option>' +
      [...kinds].sort().map((kd) => '<option value="' + kd + '">' + (KIND_L[kd] || kd) + '</option>').join('')
    if (curK && kinds.has(curK)) sel.value = curK
  }
  function currentChanges() {
    const entry = curEntry
    if (!entry) return []
    const kind = $('#fKind').value
    const q = $('#fKw').value.trim().toLowerCase()
    return entry.changes.filter((c) => {
      if (kind && c.kind !== kind) return false
      if (q && !c.rel.toLowerCase().includes(q) && !(c.prevRel || '').toLowerCase().includes(q)) return false
      return true
    })
  }
  function renderChanges() {
    const box = $('#changes')
    const entry = curEntry
    if (!entry) { box.innerHTML = '<div class="empty">' + T('tr.selectHistory') + '</div>'; return }
    const list = currentChanges()
    if (!list.length) { box.innerHTML = '<div class="empty">' + T('tr.noMatch') + '</div>'; return }
    box.innerHTML = list.map((c) => {
      const own = '<span class="ovr">' + (OWN_L[c.own] || c.own) + '</span>'
      const meta = c.meta ? ' · ' + sizeStr(c.meta) : ''
      const gitSym = { new: '+', modified: '~', deleted: '-', moved: '→' }[c.kind] || ''
      return '<div class="chg" data-key="' + esc(c.rel) + '" data-kind="' + c.kind + '" data-idx="' + curIdx + '">' +
        '<div class="head"><span class="gitsym ' + c.kind + '">' + esc(gitSym) + '</span><span class="pill ' + c.kind + '">' + (KIND_L[c.kind] || c.kind) + '</span>' + fkBadge(c.rel) +
        own +
        '<span class="rel">' + esc(c.rel) + '</span>' +
        (c.prevRel ? '<span class="prel">' + esc(c.prevRel) + '</span>' : '') +
        '<span class="meta">' + meta + '</span>' +
        '<span class="caret">▸</span><span class="jump" data-i18n="tr.viewDiff">diff</span></div>' +
        '<div class="diff" style="display:none"></div></div>'
    }).join('')
  }
  function sizeStr(m) {
    return (m.oldSize != null && m.newSize != null) ? (m.oldSize + '→' + m.newSize + ' B') : ''
  }

  async function toggleDiff(card) {
    const diffBox = card.querySelector('.diff')
    const caret = card.querySelector('.caret')
    const key = card.dataset.key
    const kind = card.dataset.kind
    if (diffBox.style.display !== 'none') { diffBox.style.display = 'none'; if (caret) caret.textContent = '▸'; return }
    diffBox.style.display = 'block'
    if (caret) caret.textContent = '▾'
    diffBox.innerHTML = '<div class="empty">' + T('tr.loading') + '</div>'

    // 优先用已加载的条目内容直接渲染（选中条目时已拉取完整 changes，零网络往返）
    const ch = curEntry && curEntry.changes.find((c) => c.rel === key && c.kind === kind)
    if (ch && ch.diff && ch.diff.length) {
      const hasChange = ch.diff.some((d) => d.type === 'add' || d.type === 'del')
      if (hasChange || kind !== 'modified') {
        diffBox.innerHTML = ''
        renderDiffHunks(diffBox, ch.diff, key, kind)
        return
      }
    }
    // 兜底：向服务端请求（例如 modified 但差异为空、需从 pack 重新比对）
    try {
      const d = await (await fetch('/api/tracker/diff?root=' + encodeURIComponent(selKey) + '&key=' + encodeURIComponent(key) + '&type=' + kind + '&ts=' + encodeURIComponent(curTs || '') + '&idx=' + (card.dataset.idx || 0))).json()
      const lines = (d.diff && d.diff.diff) || []
      if (!lines.length) {
        diffBox.innerHTML = '<div class="empty">' + (d.noBase ? T('tr.noBaseDiff') : T('tr.noDiff')) + '</div>'
        if (d.noBase) {
          const btn = document.createElement('button')
          btn.className = 'mini-btn'
          btn.textContent = T('tr.recheck')
          btn.onclick = () => openTrack('check', selKey, 'tr.checkNow')
          diffBox.appendChild(btn)
        }
        return
      }
      diffBox.innerHTML = ''
      renderDiffHunks(diffBox, lines, card.dataset.key, card.dataset.kind)
    } catch (e) {
      diffBox.innerHTML = '<div class="empty">' + esc(String(e)) + '</div>'
    }
  }

  // ── 文件类型 / diff 分组 / 跳转 / 右键 ───────────────
  const FILE_KIND_RE = [
    [/^common\/national_focus/, '国策'], [/^common\/technolog/, '科技'], [/^common\/decisions/, '决议'],
    [/^common\/characters/, '人物'], [/^localisation\//, '本地化'], [/^events?\//, '事件'],
    [/^common\/units/, '单位'], [/^map\//, '地图'], [/^interface\//, '界面'], [/^gfx\//, '素材'],
    [/^common\/idea/, '思想'], [/^common\/country/, '国家'], [/^common\/ai/, 'AI'], [/^music\//, '音乐'],
    [/^common\/defines/, 'defines'], [/^history\//, '历史'], [/^common\/scripted/, '脚本'],
  ]
  function fileKind(rel) { for (const [re, l] of FILE_KIND_RE) if (re.test(rel || '')) return l; return '其他' }
  function fkBadge(rel) { return '<span class="fk">' + esc(fileKind(rel)) + '</span>' }
  /** 把 diff 行按"变更簇 + 上下文"分组：多个相距较远的变更各自成为独立子框 */
  function splitHunks(lines, ctx) {
    ctx = ctx || 4
    const chg = []
    lines.forEach((ln, i) => { if (ln.type === 'add' || ln.type === 'del') chg.push(i) })
    if (!chg.length) return []
    const out = []
    let i = 0
    while (i < chg.length) {
      const first = Math.max(0, chg[i] - ctx)
      let last = chg[i]
      while (i + 1 < chg.length && chg[i + 1] - last <= ctx * 2) { last = chg[i + 1]; i++ }
      i++
      last = Math.min(lines.length - 1, last + ctx)
      const rows = lines.slice(first, last + 1)
      const firstChg = rows.find((r) => r.type === 'add' || r.type === 'del')
      const o = rows.find((r) => r.oldNo != null) || firstChg
      const n = rows.find((r) => r.newNo != null) || firstChg
      out.push({ rows, oldStart: (o && o.oldNo != null) ? o.oldNo : 1, newStart: (n && n.newNo != null) ? n.newNo : 1, oldCount: rows.filter((r) => r.type !== 'add').length, newCount: rows.filter((r) => r.type !== 'del').length })
    }
    return out.filter((h) => h.rows.some((r) => r.type === 'add' || r.type === 'del'))
  }
    function fileHeader(box, rel, kind) {
    const hd = document.createElement("div")
    hd.className = "dfhead"
    const a = esc(rel)
    let html = ""
    if (kind === "new") {
      html += "<div class=\"dfgit\">diff --git a/" + a + " b/" + a + "</div>"
      html += "<div class=\"dfminus\">--- /dev/null</div>"
      html += "<div class=\"dfplus\">+++ b/" + a + "</div>"
    } else if (kind === "deleted") {
      html += "<div class=\"dfgit\">diff --git a/" + a + " b/" + a + "</div>"
      html += "<div class=\"dfminus\">--- a/" + a + "</div>"
      html += "<div class=\"dfplus\">+++ /dev/null</div>"
    } else if (kind === "moved") {
      html += "<div class=\"dfgit\">rename from a/" + a + "</div>"
      html += "<div class=\"dfgit\">rename to b/" + a + "</div>"
    } else {
      html += "<div class=\"dfgit\">diff --git a/" + a + " b/" + a + "</div>"
      html += "<div class=\"dfminus\">--- a/" + a + "</div>"
      html += "<div class=\"dfplus\">+++ b/" + a + "</div>"
    }
    hd.innerHTML = html
    box.appendChild(hd)
  }
    function renderDiffHunks(box, lines, rel, kind) {
    const hunks = splitHunks(lines)
    if (!hunks.length) { box.innerHTML = '<div class="empty">' + T('tr.noDiff') + '</div>'; return }
    box.innerHTML = ''
    fileHeader(box, rel, kind)
    hunks.forEach((h, hi) => {
      if (hi > 0) {
        const gap = document.createElement('div')
        gap.className = 'dhgap'
        gap.textContent = '… 中间省略若干行 …'
        box.appendChild(gap)
      }
      const hb = document.createElement('div')
      hb.className = 'dihunk'
      const adds = h.rows.filter((r) => r.type === 'add').length
      const dels = h.rows.filter((r) => r.type === 'del').length
      const hst = document.createElement('div')
      hst.className = 'dihstat'
      hst.innerHTML = '<span class="dihunkhead">@@ -' + (h.oldStart || 1) + ',' + (h.oldCount || 0) + ' +' + (h.newStart || 1) + ',' + (h.newCount || 0) + ' @@</span><span class="dihstatn">' + (adds ? '+' + adds : '') + (adds && dels ? ' ' : '') + (dels ? '-' + dels : '') + '</span>'
      hb.appendChild(hst)
      h.rows.forEach((ln) => {
        const row = document.createElement('div')
        row.className = 'dline ' + (ln.type === 'add' ? 'add' : ln.type === 'del' ? 'del' : 'ctx')
        row.dataset.rel = rel
        const lno = document.createElement('span'); lno.className = 'lnl'; lno.textContent = (ln.type !== 'add' && ln.oldNo != null) ? String(ln.oldNo) : ''
        const rno = document.createElement('span'); rno.className = 'lnr'; rno.textContent = (ln.type !== 'del' && ln.newNo != null) ? String(ln.newNo) : ''
        const dt = document.createElement('span'); dt.className = 'dt'; dt.textContent = (ln.type === 'add' ? '+ ' : ln.type === 'del' ? '- ' : '  ') + (ln.text || '')
        row.dataset.line = ln.newNo != null ? ln.newNo : (ln.oldNo != null ? ln.oldNo : '')
        row.appendChild(lno); row.appendChild(rno); row.appendChild(dt)
        row.addEventListener('click', () => { if (row.dataset.line) jumpIde(rel, row.dataset.line) })
        hb.appendChild(row)
      })
      box.appendChild(hb)
    })
  }
    function jumpIde(rel, line) {
    if (!rel) return
    const idx = roots.findIndex((r) => r.key === selKey)
    const hash = 'root=' + (idx >= 0 ? idx : 0) + '&file=' + encodeURIComponent(rel) + '&line=' + (line || 1)
    if (window.parent && window.parent.shellSwitch) window.parent.shellSwitch('/ide', '/ide?frame=1#' + hash)
    else location.href = '/ide#' + hash
  }
  function copyText(s) {
    if (!s) return
    try { navigator.clipboard.writeText(s).then(() => { if (window.parent && window.parent.shellToast) window.parent.shellToast(T('tr.copied')) }) } catch {}
  }
  async function copyDiff(card) {
    const box = card.querySelector('.diff')
    if (!box) return
    copyText((box.innerText || '').split(/\r?\n/).slice(0, 300).join(String.fromCharCode(10)))
  }
  function showCtx(x, y, items) {
    let menu = document.getElementById('ctxMenu')
    if (!menu) { menu = document.createElement('div'); menu.id = 'ctxMenu'; menu.className = 'ctxmenu'; document.body.appendChild(menu) }
    menu.innerHTML = items.map((it, i) => '<div class="ctx-item" data-i="' + i + '">' + esc(it.label) + '</div>').join('')
    menu.style.display = 'block'
    menu.style.left = Math.min(x, window.innerWidth - 170) + 'px'
    menu.style.top = Math.min(y, window.innerHeight - items.length * 28 - 10) + 'px'
    const hide = () => { menu.style.display = 'none'; document.removeEventListener('click', hide) }
    setTimeout(() => document.addEventListener('click', hide), 0)
    menu.onclick = (ev) => { ev.stopPropagation(); const it = ev.target.closest('.ctx-item'); if (it) { const f = items[Number(it.dataset.i)].fn; if (f) try { f() } catch {} } hide() }
  }
    // ── 进度条：服务端经 fetch 流式推回 SSE 帧 ─────────────────────
  const PHASE_L = EN
    ? { walk: 'Discovering files', hash: 'Hashing files', compare: 'Comparing', finalize: 'Writing history' }
    : { walk: '枚举文件', hash: '校验文件', compare: '比对变更', finalize: '写入历史' }
  let trackCtrl = null // AbortController，用于取消进行中的跟踪任务

  function closeTrack() {
    if (trackCtrl) { try { trackCtrl.abort() } catch {} trackCtrl = null }
    const fill = $('#progFill')
    if (fill) { fill.classList.remove('indet'); fill.style.width = '0%' }
    const pe = $('#prog')
    if (pe) pe.style.display = 'none'
  }

  function handleTrackMsg(m) {
    if (m.progress) {
      const p = m.progress
      const fill = $('#progFill')
      const pct = $('#progPct')
      const known = p.total && p.total > 0
      if (known) {
        fill.classList.remove('indet')
        const pc = Math.max(0, Math.min(100, Math.round((p.current / p.total) * 100)))
        fill.style.width = pc + '%'
        pct.textContent = pc + '%'
      } else {
        fill.classList.add('indet')
        pct.textContent = ''
      }
      const ph = PHASE_L[p.phase] || ''
      $('#progStage').textContent = ph + (p.stage ? ' · ' + p.stage : '')
    } else if (m.error) {
      alert(m.error)
    }
    // m.done 由 finally 收尾刷新界面
  }

  async function openTrack(op, key, titleKey) {
    if (busy) return
    if (op === 'build' && !confirm(T('tr.confirmBaseline'))) return
    if (op === 'reset' && !confirm(T('tr.confirmReset'))) return
    if (op === 'check') {
      const r = roots.find((x) => x.key === key)
      if (!r || !r.hasBaseline) { alert(T('tr.noBaseline')); return }
    }
    setBusy(true)
    $('#progTitle').textContent = T(titleKey)
    $('#progPct').textContent = '0%'
    $('#progFill').classList.remove('indet')
    $('#progFill').style.width = '0%'
    $('#progStage').textContent = ''
    $('#prog').style.display = ''
    trackCtrl = new AbortController()
    try {
      const resp = await fetch('/api/tracker/' + op + '?root=' + encodeURIComponent(key), {
        method: op === 'reset' ? 'POST' : 'GET',
        signal: trackCtrl.signal
      })
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status
        try { const j = await resp.json(); msg = j.error || msg } catch {}
        throw new Error(msg)
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          const payload = dataLine.slice(5).trim()
          let m
          try { m = JSON.parse(payload) } catch { continue }
          handleTrackMsg(m)
        }
      }
    } catch (e) {
      const ec = e && e.name
      if (ec !== 'AbortError') alert(String((e && e.message) || e))
    } finally {
      closeTrack()
      setBusy(false)
      await loadStatus()
      if (selKey === key) await loadHistory(key)
    }
  }

  async function doBaseline(key) { await openTrack('build', key, 'tr.buildBaseline') }
  async function doCheck(key) { await openTrack('check', key, 'tr.checkNow') }
  async function doReset(key) { await openTrack('reset', key, 'tr.resetBaseline') }
  async function doClearRoot(key) {
    if (busy) return
    if (!confirm(T('tr.confirmClearRoot'))) return
    setBusy(true)
    try { await fetch('/api/tracker/clearRoot?root=' + encodeURIComponent(key), { method: 'POST' }) } catch (e) { setBusy(false); alert(String(e)); return }
    setBusy(false)
    await loadStatus()
    if (selKey === key) { hist = []; curIdx = null; renderTimeline(); renderChanges() }
  }
  async function doDelHist(ts) {
    if (!ts || busy) return
    if (!confirm(T('tr.confirmDel'))) return
    setBusy(true)
    try { await fetch('/api/tracker/delhist?root=' + encodeURIComponent(selKey) + '&ts=' + encodeURIComponent(ts), { method: 'POST' }) }
    catch (e) { setBusy(false); alert(String(e)); return }
    setBusy(false)
    await loadHistory(selKey)
  }
  async function doGc() {
    if (busy) return
    setBusy(true)
    try {
      const d = await (await fetch('/api/tracker/gc', { method: 'POST' })).json()
      if (d.error) alert(d.error)
      else alert('GC 完成：清理 ' + d.removed + ' 个无用 blob，保留 ' + d.remaining + ' 个')
    } catch (e) { alert(String(e)) } finally { setBusy(false) }
    await loadStatus()
  }
  async function doClearAll() {
    if (busy) return
    if (!confirm(T('tr.confirmClear'))) return
    setBusy(true)
    try { await fetch('/api/tracker/clear', { method: 'POST' }) } catch (e) { setBusy(false); alert(String(e)); return }
    setBusy(false)
    await loadStatus()
    selKey = null
    hist = []; curIdx = null
    $('#detail').style.display = 'none'
    setHistTitle(false)
  }

  $('#changes').addEventListener('click', (ev) => {
    const card = ev.target.closest('.chg')
    if (card) toggleDiff(card)
  })
  $('#changes').addEventListener('contextmenu', (ev) => {
    const line = ev.target.closest('.dline')
    if (line && line.dataset.rel) {
      ev.preventDefault()
      showCtx(ev.clientX, ev.clientY, [
        { label: T('tr.openInIde'), fn: () => jumpIde(line.dataset.rel, line.dataset.line || 1) },
        { label: T('tr.copyPath'), fn: () => copyText(line.dataset.rel + ':' + (line.dataset.line || 1)) },
        { label: T('tr.copyLine'), fn: () => copyText((line.querySelector('.dt') || {}).textContent || '') },
      ])
      return
    }
    const card = ev.target.closest('.chg')
    if (card) {
      ev.preventDefault()
      showCtx(ev.clientX, ev.clientY, [
        { label: T('tr.openInIde'), fn: () => jumpIde(card.dataset.key, 1) },
        { label: T('tr.copyPath'), fn: () => copyText(card.dataset.key) },
        { label: T('tr.copyDiff'), fn: () => copyDiff(card) },
      ])
    }
  })
  $('#fKind').addEventListener('change', renderChanges)
  $('#fKw').addEventListener('input', renderChanges)
  $('#gcBtn').addEventListener('click', doGc)
  $('#clearAllBtn').addEventListener('click', doClearAll)
  $('#progCancel').addEventListener('click', closeTrack)

  loadStatus()
})()
