'use strict'
/* HOI4 IDE — 文件树 + 语法高亮编辑器 + 多标签 + 跳转/引用 + 布局预览 + 快速打开
 * 零依赖,仅调用 hoi4kit GUI 服务端的 /api/tree /api/file /api/outline /api/nav /api/layout /api/files */

const enc = encodeURIComponent
const $ = (id) => document.getElementById(id)

const state = {
  root: 0,
  file: '',
  content: '',
  lines: [],
  outline: [],
  cache: new Map(),            // 目录相对路径 -> {dirs,files}
  expanded: new Set(['']),     // 已展开的目录(含根 '')
  building: false,
  // ★ 多标签
  tabs: [],                    // {root,file,content,lines,writable,rootName}
  active: -1,
  fileIndex: new Map(),        // root -> 全部文件列表(快速打开用,惰性加载)
  findMatches: [],             // 当前查找命中的行号
  findIdx: -1,
  curLine: 1,                  // 当前光标行(「用 VS Code 打开」定位用)
  editing: false,              // MAKE_MOD_V1:是否处于文本编辑模式
  dirty: false,                // 编辑区是否有未保存改动
}

/* ── 工具 ── */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
async function getJson(url) {
  const r = await fetch(url)
  return r.json()
}
function toast(msg, err) {
  const t = $('toast')
  t.textContent = msg
  t.className = 'on' + (err ? ' err' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (t.className = ''), 2200)
}

/* ── 语法高亮(Clausewitz 近似)── */
function highlight(line) {
  if (line.trimStart().startsWith('#')) return '<span class="c-com">' + esc(line) + '</span>'
  let sep = -1
  for (let k = 0; k < line.length; k++) {
    const c = line[k]
    if (c === '"') {
      let j = k + 1
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++ }
      k = j; continue
    }
    if (c === '=' || c === '{') { sep = k; break }
  }
  let out = ''
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line[i]
    if (c === '#') { out += '<span class="c-com">' + esc(line.slice(i)) + '</span>'; break }
    if (c === '"') {
      let j = i + 1
      while (j < n && line[j] !== '"') { if (line[j] === '\\') j++; j++ }
      out += '<span class="c-str">' + esc(line.slice(i, Math.min(j + 1, n))) + '</span>'
      i = Math.min(j + 1, n); continue
    }
    if (c === '{' || c === '}') { out += '<span class="c-br">' + c + '</span>'; i++; continue }
    if (c === '=' || c === '>') { out += '<span class="c-op">' + c + '</span>'; i++; continue }
    if (/[A-Za-z_@]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_@.\-]/.test(line[j])) j++
      const w = line.slice(i, j)
      const cls = i < sep ? 'c-key' : 'c-val'
      out += '<span class="c-word ' + cls + '" data-w="' + esc(w) + '">' + esc(w) + '</span>'
      i = j; continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < n && /[0-9.]/.test(line[j])) j++
      out += '<span class="c-num">' + esc(line.slice(i, j)) + '</span>'
      i = j; continue
    }
    out += esc(c); i++
  }
  return out
}

/* ── 文件树 ── */
function mkRow(icon, name, depth, kind) {
  const row = document.createElement('div')
  row.className = 'tree-row'
  row.style.paddingLeft = 8 + depth * 14 + 'px'
  const tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = kind === 'dir' ? '▸' : ''
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name
  const ty = document.createElement('span'); ty.className = 'ty'
  const sz = document.createElement('span'); sz.className = 'sz'
  row.appendChild(tw); row.appendChild(nm)
  if (kind !== 'dir') { ty.textContent = kind; ty.classList.add(kind); row.appendChild(ty); sz.textContent = '' }
  return { row, tw, ty, sz }
}
function dirNode(path, depth) {
  const frag = document.createDocumentFragment()
  const data = state.cache.get(path) || { dirs: [], files: [] }
  for (const d of data.dirs) {
    const full = (path ? path + '/' : '') + d.name
    const { row, tw } = mkRow('📁', d.name, depth, 'dir')
    row.dataset.path = full; row.dataset.kind = 'dir'
    if (state.expanded.has(full)) tw.textContent = '▾'
    row.onclick = async () => {
      if (state.expanded.has(full)) { state.expanded.delete(full); renderTree() }
      else { state.expanded.add(full); await loadTree(full); renderTree() }
    }
    if (state.expanded.has(full)) { frag.appendChild(row); frag.appendChild(dirNode(full, depth + 1)) }
    else frag.appendChild(row)
    row.oncontextmenu = (e) => showCtxMenu(e, row)
  }
  for (const f of data.files) {
    const full = (path ? path + '/' : '') + f.name
    const { row, ty, sz } = mkRow('📄', f.name, depth, f.type)
    row.dataset.path = full; row.dataset.kind = f.type
    sz.textContent = f.size > 9999 ? Math.round(f.size / 1024) + 'K' : f.size
    if (full === state.file) row.classList.add('on')
    row.onclick = () => openFile(state.root, full)
    row.oncontextmenu = (e) => showCtxMenu(e, row)
    frag.appendChild(row)
  }
  return frag
}
function renderTree() {
  const tree = $('tree')
  tree.innerHTML = ''
  tree.appendChild(dirNode('', 0))
}
async function loadTree(path) {
  if (state.cache.has(path)) return state.cache.get(path)
  const j = await getJson(`/api/tree?root=${state.root}&path=${enc(path)}`)
  state.cache.set(path, { dirs: j.dirs || [], files: j.files || [] })
  return state.cache.get(path)
}

/* ── 多标签编辑 ── */
function tabKey(t) { return t.root + '|' + t.file }
function openFile(root, file, gotoL) {
  const existing = state.tabs.findIndex((t) => t.root === root && t.file === file)
  if (existing >= 0) {
    activateTab(existing)
    if (gotoL) gotoLine(gotoL)
    return Promise.resolve()
  }
  // ★ 返回 Promise:深链(jumpToHash)要等文件真正载入并定位完再收尾
  return doOpenFresh(root, file, gotoL)
}
async function doOpenFresh(root, file, gotoL) {
  state.root = root
  $('rootSel').value = String(root)
  try {
    const j = await getJson(`/api/file?root=${root}&file=${enc(file)}`)
    if (j.error) { toast(j.error, true); return }
    const tab = {
      root, file, content: j.content, lines: j.content.split('\n'),
      writable: j.writable, rootName: j.rootName || '', truncated: !!j.truncated,
    }
    state.tabs.push(tab)
    state.active = state.tabs.length - 1
    state.curLine = 1
    renderCode(j.content)
    $('crumb').innerHTML = `<b>${esc(file.split('/').pop())}</b> <span style="color:var(--ink3)">${esc(file)}</span>`
    $('fileTitle').textContent = file + (j.truncated ? ' (已截断)' : '')
    $('statFile').textContent = `${j.lang} · ${(j.size / 1024).toFixed(1)}K · ${j.lines} 行${j.truncated ? ' · 截断' : ''}`
    $('prevBtn').disabled = !file.endsWith('.gui')
    renderTree()
    renderTabs()
    await loadOutline(root, file)
    switchTab('outline')
    if (gotoL) gotoLine(gotoL)
  } catch (e) { toast('打开失败: ' + e, true) }
  syncEditButtons()
}
function activateTab(idx) {
  if (idx < 0 || idx >= state.tabs.length) return
  if (state.editing) {
    if (state.dirty && !confirm('当前文件有未保存的改动,切换后会丢失。确定继续?')) return
    setEditMode(false)
  }
  state.active = idx
  const t = state.tabs[idx]
  state.root = t.root; state.file = t.file; state.content = t.content; state.lines = t.lines
  renderCode(t.content)
  syncEditButtons()
  $('crumb').innerHTML = `<b>${esc(t.file.split('/').pop())}</b> <span style="color:var(--ink3)">${esc(t.file)}</span>`
  $('prevBtn').disabled = !t.file.endsWith('.gui')
  renderTree()
  renderTabs()
  loadOutline(t.root, t.file)
  switchTab('outline')
}
function closeTab(idx) {
  const isActive = idx === state.active
  const closed = state.tabs.splice(idx, 1)[0]
  if (closed) clearFind()
  if (!state.tabs.length) {
    state.active = -1; state.file = ''; state.editing = false; state.dirty = false
    setEditMode(false)
    $('code').innerHTML = '<div class="empty" style="padding:20px">从左侧选择一个文件开始浏览</div>'
    $('crumb').textContent = '未打开文件'; $('fileTitle').textContent = '编辑器'
    $('statFile').textContent = ''; $('statSym').textContent = ''; $('tabOutline').innerHTML = '<div class="empty">打开文件后显示符号大纲</div>'
    renderTabs(); syncEditButtons(); return
  }
  if (isActive) {
    const na = Math.max(0, idx - 1)
    activateTab(na)
  } else {
    if (idx < state.active) state.active--
    renderTabs()
  }
}
function renderTabs() {
  const bar = $('tabBar')
  bar.innerHTML = ''
  state.tabs.forEach((t, i) => {
    const el = document.createElement('div')
    el.className = 'edtab' + (i === state.active ? ' on' : '')
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t.file.split('/').pop()
    const src = document.createElement('span'); src.className = 'src' + (t.writable ? ' mod' : ''); src.textContent = t.writable ? '模组' : '基础'
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'
    x.title = '关闭 (Ctrl+W)'
    x.onclick = (e) => { e.stopPropagation(); closeTab(i) }
    el.appendChild(nm); el.appendChild(src); el.appendChild(x)
    el.title = t.file
    el.onclick = () => activateTab(i)
    bar.appendChild(el)
  })
}

/* ── 编辑模式(MAKE_MOD_V1)────────────────────────────────────
 * IDE 原本只renderCode():高亮视图只读,改一个数字都得去外部编辑器,
 * 于是"在这个工作台里做模组"这条链路是断的。
 * 这里做成双视图:高亮视图(看) ↔ textarea(改),保存走 /api/fs/write。
 * 刻意不去动 renderCode —— 高亮逻辑有不少边界,能不动就不动。 */
function curTab() { return state.tabs[state.active] || null }

function syncEditButtons() {
  const t = curTab()
  const can = !!t && !!t.writable && t.file
  $('editBtn').disabled = !can
  $('saveBtn').disabled = !state.editing || !state.dirty
  /* COMMENT_V1:注释按钮与「编辑」同可用性(它要写 textarea) */
  if ($('cmtBtn')) $('cmtBtn').disabled = !can
  if ($('editBtn')) $('editBtn').textContent = state.editing ? '退出编辑' : '编辑'
  if ($('editBtn') && can && !t.writable) $('editBtn').title = '该来源只读'
}

function setEditMode(on) {
  const t = curTab()
  if (on && (!t || !t.writable)) {
    toast('这个来源只读,不能编辑。请挂载/新建一个模组再改。', true)
    return
  }
  // ★ 大文件是截断读取的,直接把截断后的内容写回去会静默丢掉后半截
  if (on && t && t.truncated) {
    toast('文件过大(已截断显示),为避免覆盖损坏,请用外部编辑器修改。', true)
    return
  }
  state.editing = !!on
  if (on) {
    $('rawEdit').value = t.content
    $('codeWrap').style.display = 'none'
    $('rawEdit').style.display = 'block'
    $('editBar').style.display = 'flex'
    $('editHint').textContent = t.file
    setTimeout(() => $('rawEdit').focus(), 0)
  } else {
    $('rawEdit').style.display = 'none'
    $('editBar').style.display = 'none'
    $('codeWrap').style.display = ''
  }
  syncEditButtons()
}

async function saveFile() {
  const t = curTab()
  if (!t) return
  if (!t.writable) { toast('这个来源只读,不能保存。', true); return }
  const content = $('rawEdit').value
  $('saveBtn').disabled = true
  const r = await Target.post('/api/fs/write', { rootIdx: t.root, file: t.file, content })
  $('saveBtn').disabled = false
  if (!r.ok) { toast('保存失败: ' + r.error, true); return }
  // 写盘成功才算"内容变了",否则渲染会和服务端不一致
  t.content = content
  t.lines = content.split('\n')
  state.content = content
  state.lines = t.lines
  state.dirty = false
  renderCode(content)
  toast(r.data.created ? '已新建并保存: ' + t.file : '已保存(旧版备份为 .bak)')
  setEditMode(false)
  // 该文件的大纲是缓存的,内容变了要重取
  try { await loadOutline(t.root, t.file) } catch { /* 大纲失败不影响保存结果 */ }
}

function onEditInput() {
  state.dirty = $('rawEdit').value !== (curTab() || {}).content
  $('saveBtn').disabled = !state.dirty
  $('editDot').style.visibility = state.dirty ? '' : 'hidden'
}

/**
 * 注释 / 取消注释选中行(COMMENT_V1,快捷键 Ctrl+/ → `ide.toggleComment`)
 *
 * ── 为什么只做「切换」不做「加/解」两个动作 ──
 *   Clausewitz 脚本(Text / gui / localization)只有**行注释**一种:
 *   `#` 到行尾。没有块注释,所以注释与取消注释天然互为逆操作,
 *   一个 toggle 就够 —— 与 VS Code / 大多数编辑器一致。
 *
 * ── 判定「这批行是否已注释」用多数票,而不是看第一行 ──
 *   真实文件里混着「已注释 + 未注释」的选区很常见(比如注释掉一段配置
 *   中间又手写一行)。按第一行判会出现「看着加了注释其实没加」的错位反馈。
 *   多数票的行为稳定,且用户再按一次就能得到期望结果。
 *
 * ── 空行不参与 ──
 *   空行加 `#` 是纯噪音(游戏读脚本时忽略,却污染 diff),跳过它们;
 *   若选区全是空行则什么都不做。
 *
 * ── 缩进保持 ──
 *   `#` 插在**原有前导空白之后**,即 `  foo` → `  # foo`。
 *   Clausewitz 靠缩进表达层级,插到行首会破坏语义。
 */
function toggleComment() {
  const ta = $('rawEdit')
  if (!ta || ta.style.display === 'none') { toast('先进入编辑模式( Ctrl+E )再注释'); return }
  const v = ta.value
  const s = ta.selectionStart
  const e = ta.selectionEnd
  /* 行首偏移:e==s(无选区)时就把光标所在行整行处理 */
  const ls = v.lastIndexOf('\n', s - 1) + 1
  let le = v.indexOf('\n', e)
  if (le < 0) le = v.length
  const seg = v.slice(ls, le)
  const lines = seg.split('\n')

  const meaningful = lines.filter((l) => l.trim() !== '')
  if (!meaningful.length) { toast('选区里只有空行,没有可注释的内容'); return }
  const commented = meaningful.filter((l) => /^\s*#/.test(l)).length
  const toComment = commented * 2 < meaningful.length   /* 严格多数 → 加,否则 → 解 */

  const out = lines.map((l) => {
    if (l.trim() === '') return l
    if (toComment) {
      const m = /^(\s*)/.exec(l)
      const ind = m ? m[1] : ''
      const rest = l.slice(ind.length).replace(/^#+\s?/, '')
      return ind + '# ' + rest
    }
    const m = /^(\s*)#+\s?/.exec(l)
    return m ? m[1] + l.slice(m[0].length) : l
  })
  const newSeg = out.join('\n')
  const nv = v.slice(0, ls) + newSeg + v.slice(le)

  /* 每行可能 +2 字符,按比例把选区往后挪,保持覆盖同一批行 */
  const delta = newSeg.length - seg.length
  ta.value = nv
  ta.selectionStart = s
  ta.selectionEnd = Math.max(ls, e + (e > ls ? delta : 0))
  onEditInput()
  /* 保持新内容在视野内 —— 长文件里逐行 +2 会让光标顶出去 */
  const firstLine = v.slice(0, ls).split('\n').length
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18
  ta.scrollTop = Math.max(0, (firstLine - 4) * lineH)
  toast(toComment ? `已注释 ${meaningful.length} 行` : `已取消注释 ${meaningful.length} 行`)
}

/* ── 打开文件 ── */
function renderCode(content) {
  const lines = content.split('\n')
  let html = ''
  for (let i = 0; i < lines.length; i++) {
    html += `<div class="ln" data-line="${i + 1}"><span class="num">${i + 1}</span><span class="ct">${highlight(lines[i])}</span></div>`
  }
  $('code').innerHTML = html
  clearFind()
}
function gotoLine(line) {
  const el = $('code').querySelector(`.ln[data-line="${line}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  setActiveLine(el)
  document.querySelectorAll('.ln.hl').forEach((x) => x.classList.remove('hl'))
  el.classList.add('hl')
}
function setActiveLine(el) {
  document.querySelectorAll('.ln.active').forEach((x) => x.classList.remove('active'))
  el.classList.add('active')
  const ln = parseInt(el.dataset.line, 10)
  state.curLine = ln
  const txt = state.lines[ln - 1] || ''
  $('statPos').textContent = `行 ${ln},列 1 · ${txt.length} 字`
}

/* ── 用本地编辑器打开(优先 VS Code)──
 * 服务端依次尝试 code.cmd(带 shell)→ PATH code → 系统默认;
 * 全部失败时返回 vscode:// 协议链接,由浏览器交给已安装的 VS Code 打开。*/
async function openInLocalEditor() {
  const t = state.tabs[state.active]
  if (!t) return toast('先打开一个文件', true)
  const url = `/api/open-external?root=${t.root}&file=${enc(t.file)}&line=${state.curLine || 1}`
  try {
    const j = await getJson(url)
    // 服务端进程无权拉起桌面程序(受限环境常见)→ 改用协议链接,让浏览器接力
    if (j.protocol) {
      toast('服务端无法直接启动 VS Code,正在用 vscode:// 协议打开…')
      window.location.href = j.protocol
      return
    }
    toast(j.via && j.via.startsWith('code') ? `已用 ${j.via.split(/[\\/]/).pop()} 打开(第 ${j.line} 行)` : `已用${j.via}打开(第 ${j.line} 行)`)
  } catch (e) {
    toast('打开失败:' + (e && e.message ? e.message : e), true)
  }
}

/* ── 大纲 ── */
async function loadOutline(root, file) {
  try {
    const j = await getJson(`/api/outline?root=${root}&file=${enc(file)}`)
    state.outline = j.symbols || []
    renderOutline(j)
    $('statSym').textContent = `${state.outline.length} 符号`
  } catch { $('statSym').textContent = '' }
}
function renderOutline(j) {
  const tab = $('tabOutline')
  tab.innerHTML = ''
  const syms = j.symbols || []
  if (!syms.length) { tab.innerHTML = '<div class="empty">无可识别的符号</div>'; return }
  const key = 'ol-collapsed:' + state.file
  let collapsed = new Set()
  try { collapsed = new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch {}
  const persist = () => { try { localStorage.setItem(key, JSON.stringify([...collapsed])) } catch {} }
  const root = { children: [] }
  const stack = [root]
  for (const s of syms) {
    const node = { s, children: [], depth: s.depth || 0 }
    while (stack.length > 1 && stack[stack.length - 1].depth >= node.depth) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  const tree = document.createElement('div'); tree.className = 'ol-tree'
  const renderNode = (n) => {
    const wrap = document.createElement('div'); wrap.className = 'ol-node'
    const hasKids = n.children.length > 0
    const isOpen = !collapsed.has(n.s.line)
    const row = document.createElement('div'); row.className = 'ol-row'
    row.style.paddingLeft = 6 + n.depth * 14 + 'px'
    const tw = document.createElement('span')
    tw.className = 'ol-tw' + (hasKids ? (isOpen ? ' c' : '') : ' leaf'); tw.textContent = '▶'
    const ic = document.createElement('span')
    ic.className = 'ol-ic'; ic.textContent = n.s.kind === 'value' ? '•' : n.s.kind === 'flag' ? '⚑' : '▸'
    const nm = document.createElement('span'); nm.className = 'ol-name'; nm.textContent = n.s.name
    row.appendChild(tw); row.appendChild(ic); row.appendChild(nm)
    if (n.s.detail) {
      const det = document.createElement('span'); det.className = 'ol-det'
      det.textContent = n.s.detail.length > 24 ? n.s.detail.slice(0, 24) + '…' : n.s.detail
      row.appendChild(det)
    }
    row.title = n.s.kind + ' · 行 ' + n.s.line + (hasKids ? ' · 点击箭头折叠' : '')
    if (hasKids) {
      tw.onclick = (e) => {
        e.stopPropagation()
        if (collapsed.has(n.s.line)) collapsed.delete(n.s.line); else collapsed.add(n.s.line)
        persist()
        childrenBox.classList.toggle('open', !collapsed.has(n.s.line))
        tw.classList.toggle('c', !collapsed.has(n.s.line))
      }
    }
    row.onclick = () => gotoLine(n.s.line)
    wrap.appendChild(row)
    if (hasKids) {
      const childrenBox = document.createElement('div')
      childrenBox.className = 'ol-children' + (isOpen ? ' open' : '')
      for (const c of n.children) childrenBox.appendChild(renderNode(c))
      wrap.appendChild(childrenBox)
    }
    return wrap
  }
  for (const c of root.children) tree.appendChild(renderNode(c))
  const bar = document.createElement('div'); bar.className = 'ol-toolbar'
  const bAll = document.createElement('button'); bAll.textContent = '全部折叠'
  bAll.onclick = () => { const cl = (nd) => { if (nd.children.length) { collapsed.add(nd.s.line); nd.children.forEach(cl) } }; root.children.forEach(cl); persist(); renderOutline(j) }
  const bExp = document.createElement('button'); bExp.textContent = '全部展开'
  bExp.onclick = () => { collapsed.clear(); persist(); renderOutline(j) }
  bar.appendChild(bAll); bar.appendChild(bExp)
  tab.appendChild(bar); tab.appendChild(tree)
}

/* ── 跳转 / 引用 ── */
async function doNav(word, line) {
  switchTab('nav')
  const tab = $('tabNav')
  tab.innerHTML = '<div class="empty"><span class="spin"></span> 检索定义与引用…</div>'
  const char = state.lines[line - 1] ? state.lines[line - 1].indexOf(word) : 0
  try {
    const j = await getJson(`/api/nav?root=${state.root}&file=${enc(state.file)}&line=${line}&char=${char < 0 ? 0 : char}`)
    renderNav(j)
    if (j.building) {
      if (window.Progress) window.Progress.start('正在构建符号库…')
      $('statIdx').textContent = '符号库构建中…'
    } else if (window.Progress && window.Progress.active) window.Progress.done()
  } catch (e) { tab.innerHTML = '<div class="empty">检索失败: ' + esc(e) + '</div>' }
}
function renderNav(j) {
  const tab = $('tabNav')
  if (!j.word) { tab.innerHTML = '<div class="empty">光标处未识别到标识符</div>'; return }
  let html = `<div style="margin-bottom:8px"><span class="nav-word">${esc(j.word)}</span> <span class="badge">${j.defCount} 定义</span> <span class="badge">${j.refCount} 引用</span></div>`
  if (j.defs && j.defs.length) {
    html += '<div class="nav-sec">定义</div>'
    for (const d of j.defs) {
      html += `<div class="refitem" data-root="${d.root}" data-file="${esc(d.file)}" data-line="${d.line}">
        <div class="rl"><span class="rk">${esc(d.kind)}</span><span class="rf">${esc(d.file)}:${d.line}</span></div></div>`
    }
  }
  if (j.refs && j.refs.length) {
    html += '<div class="nav-sec">引用</div>'
    for (const r of j.refs.slice(0, 400)) {
      html += `<div class="refitem" data-root="${r.root != null ? r.root : state.root}" data-file="${esc(r.file)}" data-line="${r.line}">
        <div class="rl"><span class="rk">${esc(r.target)}</span><span class="rf">${esc(r.file)}:${r.line}</span></div>
        ${r.ctx ? `<div class="rl" style="color:var(--ink3)">ctx: ${esc(r.ctx)}</div>` : ''}</div>`
    }
    if (j.refs.length > 400) html += `<div class="empty">仅显示前 400 / ${j.refs.length}</div>`
  }
  if (!j.defs.length && !j.refs.length) html += '<div class="empty">未找到定义或引用(可能不在索引范围内)</div>'
  tab.innerHTML = html
  tab.querySelectorAll('.refitem').forEach((el) => {
    el.onclick = () => openFile(parseInt(el.dataset.root, 10) || state.root, el.dataset.file, parseInt(el.dataset.line, 10))
  })
}

/* ── 布局预览(.gui)── */
async function showPreview() {
  const tab = $('tabPreview')
  if (!state.file.endsWith('.gui')) { tab.innerHTML = '<div class="empty">仅 .gui 文件支持布局预览</div>'; return }
  tab.innerHTML = '<div class="empty"><span class="spin"></span> 渲染布局…</div>'
  try {
    const j = await getJson(`/api/layout?root=${state.root}&file=${enc(state.file)}`)
    const nodes = j.nodes || []
    if (!nodes.length) { tab.innerHTML = '<div class="empty">无元素</div>'; return }
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
    for (const nd of nodes) {
      minX = Math.min(minX, nd.absX); minY = Math.min(minY, nd.absY)
      maxX = Math.max(maxX, nd.absX + nd.drawW); maxY = Math.max(maxY, nd.absY + nd.drawH)
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY)
    const W = tab.clientWidth - 16, H = 240
    const s = Math.min(W / bw, H / bh, 1)
    let html = `<div id="prevWrap"><div id="prevStage" style="transform:translate(8px,8px) scale(${s})">`
    for (const nd of nodes) {
      const x = (nd.absX - minX) * s, y = (nd.absY - minY) * s
      const w = Math.max(2, nd.drawW * s), h = Math.max(2, nd.drawH * s)
      html += `<div class="pnode ${nd.spriteMissing ? 'miss' : ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
        <span class="pn">${esc(nd.name || nd.type)}</span></div>`
    }
    html += '</div></div>'
    tab.innerHTML = html
  } catch (e) { tab.innerHTML = '<div class="empty">预览失败: ' + esc(e) + '</div>' }
}

/* ── tabs(右侧)── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name))
  $('tabOutline').style.display = name === 'outline' ? '' : 'none'
  $('tabNav').style.display = name === 'nav' ? '' : 'none'
  $('tabPreview').style.display = name === 'preview' ? '' : 'none'
  const ai = $('tabAI')
  if (ai) ai.style.display = name === 'ai' ? '' : 'none'
  if (name === 'preview') showPreview()
  /* AIDE_V1:首次切到 AI 页才挂载(配置请求不必抢启动),并把当前文件喂给它 */
  if (name === 'ai' && window.AI && typeof window.AI.mount === 'function') {
    window.AI.mount()
    window.AI.setCurFile(curFileLabel())
  }
}

/** 当前打开文件的「来源名/相对路径」,给 AI 当上下文 */
function curFileLabel() {
  const t = state.tabs[state.active]
  if (!t) return ''
  const rn = t.rootName || ''
  return rn ? `${rn}/${t.file}` : t.file
}

/* AIDE_V1:AI 应用改动后要能刷新当前文件/大纲。
 * 挂在 window 上而不是让 ai.js 直接摸内部状态 —— 两个 IIFE 之间只留这一个接口。*/
window.HoiIde = {
  reloadCurrent() {
    const t = state.tabs[state.active]
    if (!t) return
    /* 重新拉一次文件内容并原地替换当前 tab,不新开标签 */
    getJson(`/api/file?root=${t.root}&file=${enc(t.file)}`).then((j) => {
      if (j.error) { console.warn('[HoiIde] 重载失败:' + j.error); return }
      t.content = j.content
      t.lines = j.content.split('\n')
      t.truncated = !!j.truncated
      activateTab(state.active)
    }).catch((e) => console.warn('[HoiIde] 重载失败', e))
  },
  curFile: curFileLabel,
}

/* ★ COMMENT_V1 验收钩子:把注释切换暴露成可测入口。
 *   toggleComment 是纯 DOM 操作(读 textarea 的选区 → 改 value),
 *   不依赖任何页面状态,所以能直接在无头浏览器里喂用例。
 *   只挂 toggleComment —— 不挂 setEditMode:那个会连带改 state 与按钮,
 *   在测试里造出「假编辑态」反而掩盖真问题。 */
window.__tc = toggleComment

/* ── 查找(Ctrl+F)── */
function showFind() {
  const fb = $('findBar'); fb.classList.add('on')
  const inp = $('findInput'); inp.value = ''; inp.focus(); clearFind()
}
function clearFind() {
  state.findMatches = []; state.findIdx = -1
  document.querySelectorAll('.ln.found').forEach((x) => x.classList.remove('found'))
  const fb = $('findBar'); if (fb) fb.classList.remove('on')
  const st = $('findStat'); if (st) st.textContent = ''
}
function doFind(dir) {
  const q = $('findInput').value.trim().toLowerCase()
  if (!q) { clearFind(); return }
  const matches = []
  state.lines.forEach((ln, i) => { if (ln.toLowerCase().includes(q)) matches.push(i + 1) })
  state.findMatches = matches
  document.querySelectorAll('.ln.found').forEach((x) => x.classList.remove('found'))
  if (!matches.length) { $('findStat').textContent = '0 / 0'; return }
  for (const m of matches) {
    const el = $('code').querySelector(`.ln[data-line="${m}"]`)
    if (el) el.classList.add('found')
  }
  if (dir > 0) state.findIdx = state.findIdx >= matches.length - 1 ? 0 : state.findIdx + 1
  else if (dir < 0) state.findIdx = state.findIdx <= 0 ? matches.length - 1 : state.findIdx - 1
  else state.findIdx = 0
  const line = matches[state.findIdx]
  $('findStat').textContent = `${state.findIdx + 1} / ${matches.length}`
  const el = $('code').querySelector(`.ln[data-line="${line}"]`)
  if (el) { el.scrollIntoView({ block: 'center' }); setActiveLine(el) }
}

/* ── 快速打开(Ctrl+P)── */
let qoList = []
let qoSel = 0
async function openQuickOpen() {
  const mask = $('qoMask'); mask.classList.add('on')
  const inp = $('qoInput'); inp.value = ''; inp.focus()
  if (!state.fileIndex.has(state.root)) {
    try {
      const j = await getJson(`/api/files?root=${state.root}&all=1`)
      state.fileIndex.set(state.root, j.files || [])
    } catch { state.fileIndex.set(state.root, []) }
  }
  qoList = state.fileIndex.get(state.root) || []
  renderQo('')
}
function renderQo(q) {
  const list = $('qoList')
  const ql = q.trim().toLowerCase()
  const cand = ql
    ? qoList.filter((f) => f.file.toLowerCase().includes(ql)).slice(0, 200)
    : qoList.slice(0, 200)
  qoSel = 0
  if (!cand.length) { list.innerHTML = '<div class="qo-row">无匹配文件</div>'; return }
  list.innerHTML = ''
  cand.forEach((f, i) => {
    const r = document.createElement('div')
    r.className = 'qo-row' + (i === 0 ? ' on' : '')
    const ext = (f.name.split('.').pop() || '').toLowerCase()
    r.innerHTML = `<span class="ty">${ext}</span><span class="qf">${esc(f.name)}</span><span class="qr">${esc(f.rootName)}</span>`
    r.onclick = () => { closeQuickOpen(); openFile(f.root, f.file) }
    r.onmouseenter = () => { qoSel = i; updateQoSel() }
    list.appendChild(r)
  })
  qoList._cand = cand
}
function updateQoSel() {
  const rows = $('qoList').querySelectorAll('.qo-row')
  rows.forEach((r, i) => r.classList.toggle('on', i === qoSel))
  const on = rows[qoSel]; if (on) on.scrollIntoView({ block: 'nearest' })
}
function closeQuickOpen() {
  $('qoMask').classList.remove('on')
}
function qoConfirm() {
  const cand = qoList._cand || []
  if (cand[qoSel]) { $('qoMask').classList.remove('on'); openFile(cand[qoSel].root, cand[qoSel].file) }
}

/* ── 键盘快捷键 ──
 * ★ 每个键都按 **动作 id** 查表匹配(Keys.combo(id)),不再写死 e.key === 's'。
 *   原因:本页这些键是"页面自己实现 + 登记进速查表"(doc:true),
 *   若 onKey 仍按字面键判断,用户在设置页把 Ctrl+S 改成 Ctrl+Shift+S,
 *   速查表会显示新键但实际按旧键才生效 —— 看起来改了、其实没改。
 *   走 Keys.combo 之后,改键只需改 keymap 目录里的覆盖,onKey 不用动。 */
const IDE_ACTS = {
  'ide.save': (e) => {
    e.preventDefault()
    if (state.editing) saveFile()
    else if (curTab() && curTab().writable) setEditMode(true)
    else toast('只读来源,不能保存。', true)
  },
  'ide.editMode': (e) => { e.preventDefault(); setEditMode(!state.editing) },
  'ide.quickOpen': (e) => { e.preventDefault(); openQuickOpen() },
  'ide.find': (e) => { e.preventDefault(); showFind() },
  'ide.gotoLine': (e) => {
    e.preventDefault()
    const v = prompt('跳转到行:')
    if (v && /^\d+$/.test(v)) gotoLine(parseInt(v, 10))
  },
  'ide.closeTab': (e) => { e.preventDefault(); if (state.active >= 0) closeTab(state.active) },
  'ide.cycleTab': (e) => {
    e.preventDefault()
    if (!state.tabs.length) return
    const n = state.tabs.length
    activateTab(e.shiftKey ? (state.active - 1 + n) % n : (state.active + 1) % n)
  },
  'ide.nextTab': (e) => {
    e.preventDefault()
    if (!state.tabs.length) return
    activateTab((state.active + 1) % state.tabs.length)
  },
  'ide.prevTab': (e) => {
    e.preventDefault()
    if (!state.tabs.length) return
    activateTab((state.active - 1 + state.tabs.length) % state.tabs.length)
  },
  'ide.toggleTree': (e) => {
    e.preventDefault()
    document.body.classList.toggle('tree-hidden')
  },
  /* ★ COMMENT_V1:焦点在编辑框时走 rawEdit 自己的 keydown(那里先命中);
   *   焦点不在(比如停在文件树上)时到这里,自动进编辑模式再注释 ——
   *   否则用户按 Ctrl+/ 毫无反应,会以为快捷键没绑上。 */
  'ide.toggleComment': (e) => {
    e.preventDefault()
    if (!state.editing) {
      if (!curTab() || !curTab().writable) { toast('只读来源,不能编辑。', true); return }
      setEditMode(true)
    }
    toggleComment()
  },
  'ide.completion': (e) => {
    // 真正干活的是 rawEdit 自己的 keydown(见下,那里有 stopPropagation)。
    // 焦点不在编辑框时按这个键没意义,给个提示而不是静默。
    e.preventDefault()
    toast('先把光标放进编辑框,再按这个键触发补全', true)
  },
}

function onKey(e) {
  if (e.isComposing || e.keyCode === 229) return
  const combo = window.Keys ? Keys.fromEvent(e) : null
  if (combo) {
    // 逐个动作比对当前生效键位(用户在设置页改过的键在这里生效)
    for (const id in IDE_ACTS) {
      const keys = Keys.combo(id) || []
      if (keys.indexOf(combo) < 0) continue
      // 编辑模式下除保存/编辑/补全/注释外的快捷键一律不拦,否则打字会被吞。
      // ⚠ 注释必须在白名单里:焦点在编辑框时它由 rawEdit 的 keydown 处理,
      //   但那监听会 stopPropagation,这里只是双保险(焦点在别处时走这条)。
      if (state.editing && document.activeElement === $('rawEdit') &&
          id !== 'ide.save' && id !== 'ide.editMode' && id !== 'ide.completion' &&
          id !== 'ide.toggleComment') return
      IDE_ACTS[id](e)
      return
    }
  }
  if (e.key === 'Escape') {
    if ($('qoMask').classList.contains('on')) { $('qoMask').classList.remove('on'); return }
    if ($('findBar').classList.contains('on')) { clearFind(); return }
  }
  // 快速打开内的导航(面板打开时方向键/回车归它,不查动作表)
  if ($('qoMask').classList.contains('on')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); qoSel = Math.min(qoSel + 1, (qoList._cand ? qoList._cand.length - 1 : 0)); updateQoSel(); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); qoSel = Math.max(qoSel - 1, 0); updateQoSel(); return }
    if (e.key === 'Enter') { e.preventDefault(); qoConfirm(); return }
  }
}

/* ── 自动补全(MAKE_MOD_V1:官方文档 + common + scripted_* )──
 * 数据源:/api/completion,作用域可在设置页配置(localStorage gui.compScopes)。 */
const AC_DEFAULT_SCOPES = ['official', 'common', 'scripted_effect', 'scripted_trigger', 'loc', 'gfx', 'gui']
function acScopes() {
  try {
    const v = JSON.parse(localStorage.getItem('gui.compScopes') || '')
    if (Array.isArray(v) && v.length) return v
  } catch {}
  return AC_DEFAULT_SCOPES.slice()
}
let ROOT_PATHS = []
const ac = { open: false, items: [], sel: 0, start: 0, end: 0, timer: 0, busy: false }

function getWordAtCaret(ta) {
  const pos = ta.selectionStart
  const v = ta.value
  let s = pos
  while (s > 0 && /[A-Za-z0-9_@.:-]/.test(v[s - 1])) s--
  let e = pos
  while (e < v.length && /[A-Za-z0-9_@.:-]/.test(v[e])) e++
  return { word: v.slice(s, e), start: s, end: e }
}
function caretCoords(ta, pos) {
  const div = document.createElement('div')
  const cs = getComputedStyle(ta)
  ;['boxSizing', 'width', 'font', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing',
    'tabSize', 'lineHeight', 'paddingTop', 'paddingLeft', 'borderWidth', 'whiteSpace', 'wordWrap', 'overflowWrap']
    .forEach((p) => { try { div.style[p] = cs[p] } catch {} })
  div.style.position = 'absolute'; div.style.visibility = 'hidden'; div.style.whiteSpace = 'pre'; div.style.overflow = 'hidden'
  div.textContent = ta.value.substring(0, pos)
  const span = document.createElement('span'); span.textContent = ta.value.substring(pos) || '.'
  div.appendChild(span); document.body.appendChild(div)
  const c = { top: span.offsetTop, left: span.offsetLeft }
  document.body.removeChild(div)
  return c
}
function acPosition() {
  const ta = $('rawEdit'); const pop = $('acPop')
  if (!ac.open) return
  const c = caretCoords(ta, ac.end)
  const lh = parseInt(getComputedStyle(ta).lineHeight, 10) || 18
  let top = ta.offsetTop + c.top - ta.scrollTop + lh
  let left = ta.offsetLeft + c.left - ta.scrollLeft
  top = Math.min(top, ta.clientHeight - 30)
  left = Math.min(left, ta.clientWidth - pop.offsetWidth - 6)
  pop.style.top = Math.max(2, top) + 'px'
  pop.style.left = Math.max(2, left) + 'px'
}
function acShow(items) {
  ac.items = items; ac.sel = 0
  const pop = $('acPop')
  if (!items.length) { acHide(); return }
  pop.innerHTML = ''
  items.forEach((it, i) => {
    const row = document.createElement('div')
    row.className = 'ac-item' + (i === 0 ? ' on' : '')
    const kind = document.createElement('span'); kind.className = 'ac-kind k-' + it.kind
    kind.textContent = it.kind.replace('scripted_', 's_')
    const lab = document.createElement('span'); lab.className = 'ac-lab'; lab.textContent = it.label
    const src = document.createElement('span'); src.className = 'ac-src'; src.textContent = it.source || ''
    row.appendChild(kind); row.appendChild(lab); row.appendChild(src)
    row.onmousedown = (e2) => { e2.preventDefault(); acAccept(i) }
    row.onmouseenter = () => acSetSel(i)
    pop.appendChild(row)
  })
  pop.classList.add('on'); ac.open = true
  acPosition()
}
function acSetSel(i) {
  ac.sel = i
  const rows = $('acPop').querySelectorAll('.ac-item')
  rows.forEach((r, idx) => r.classList.toggle('on', idx === i))
  if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' })
}
function acHide() { ac.open = false; $('acPop').classList.remove('on') }
function acAccept(i) {
  const it = ac.items[i]; if (!it) return
  const ta = $('rawEdit'); const v = ta.value
  ta.value = v.slice(0, ac.start) + it.label + v.slice(ac.end)
  const caret = ac.start + it.label.length
  ta.selectionStart = ta.selectionEnd = caret
  acHide(); onEditInput(); ta.focus()
}
async function acQuery(force) {
  const ta = $('rawEdit')
  const w = getWordAtCaret(ta)
  if (!force && w.word.length < 1) { acHide(); return }
  ac.start = w.start; ac.end = w.end
  const scopes = acScopes().join(',')
  try {
    const r = await fetch(`/api/completion?q=${enc(w.word)}&scopes=${enc(scopes)}`)
    const j = await r.json()
    if (j.building) return // 符号库还在构建,保留现状
    acShow((j.items || []).slice(0, 60))
  } catch { /* 忽略瞬时错误 */ }
}
function scheduleAc() { clearTimeout(ac.timer); ac.timer = setTimeout(() => acQuery(false), 280) }

/* ── 文件树右键菜单(类 VS Code 文件操作)── */
let CTX = { root: 0, path: '', kind: '' }
function hideCtxMenu() { $('ctxMenu').classList.remove('on') }
async function rootPaths() {
  if (!ROOT_PATHS.length) {
    try { const j = await getJson('/api/sources'); ROOT_PATHS = (j.sources || []).map((s) => s.path) } catch {}
  }
  return ROOT_PATHS
}
function showCtxMenu(e, row) {
  e.preventDefault()
  CTX = { root: state.root, path: row.dataset.path || '', kind: row.dataset.kind || 'file' }
  const parent = CTX.kind === 'dir' ? CTX.path : CTX.path.split('/').slice(0, -1).join('/')
  const menu = $('ctxMenu')
  const items = [
    { label: '新建文件', k: '＋', act: () => ctxNewFile(parent) },
    { label: '新建文件夹', k: '📁', act: () => ctxNewDir(parent) },
  ]
  if (CTX.path) items.push({ label: '重命名', k: '✎', act: () => ctxRename(CTX.path) })
  items.push({ sep: true })
  if (CTX.path) items.push({ label: '删除', k: '🗑', danger: true, act: () => ctxDelete(CTX.path) })
  items.push({ sep: true })
  items.push({ label: '复制路径', k: '⧉', act: () => ctxCopyPath(CTX.root, CTX.path) })
  menu.innerHTML = ''
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); return }
    const el = document.createElement('div'); el.className = 'ctx-item' + (it.danger ? ' danger' : '')
    el.innerHTML = `<span class="ck">${it.k}</span><span>${it.label}</span>`
    el.onclick = () => { hideCtxMenu(); it.act() }
    menu.appendChild(el)
  })
  menu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px'
  menu.style.top = Math.min(e.clientY, innerHeight - 200) + 'px'
  menu.classList.add('on')
}
async function ctxNewFile(parent) {
  const name = prompt('新文件名(含扩展名,如 my_script.txt):', 'new_file.txt')
  if (!name) return
  const file = (parent ? parent + '/' : '') + name.replace(/[\\/]/g, '_')
  const r = await Target.post('/api/fs/write', { rootIdx: CTX.root, file, content: '' })
  if (!r.ok) { toast('创建失败: ' + r.error, true); return }
  toast('已创建 ' + file)
  if (CTX.root === state.root) { state.expanded.add(parent); await refreshTreeFor(parent) }
  openFile(CTX.root, file)
}
async function ctxNewDir(parent) {
  const name = prompt('新文件夹名:', 'new_folder')
  if (!name) return
  const dir = (parent ? parent + '/' : '') + name.replace(/[\\/]/g, '_')
  const r = await Target.post('/api/fs/mkdir', { rootIdx: CTX.root, dir })
  if (!r.ok) { toast('创建失败: ' + r.error, true); return }
  toast('已创建文件夹 ' + dir)
  if (CTX.root === state.root) { state.expanded.add(parent); await refreshTreeFor(parent) }
}
async function ctxRename(path) {
  const base = path.split('/').pop()
  const np = prompt('重命名为:', base)
  if (!np || np === base) return
  const parent = path.split('/').slice(0, -1).join('/')
  const to = (parent ? parent + '/' : '') + np.replace(/[\\/]/g, '_')
  const r = await Target.post('/api/fs/rename', { rootIdx: CTX.root, from: path, to })
  if (!r.ok) { toast('重命名失败: ' + r.error, true); return }
  toast('已重命名')
  const idx = state.tabs.findIndex((t) => t.root === CTX.root && t.file === path)
  if (idx >= 0) closeTab(idx)
  if (CTX.root === state.root) await refreshTreeFor(parent)
}
async function ctxDelete(path) {
  if (!confirm('确定删除 ' + path + ' ?\n(目录会递归删除)')) return
  const parent = path.split('/').slice(0, -1).join('/')
  const r = await Target.post('/api/fs/delete', { rootIdx: CTX.root, path })
  if (!r.ok) { toast('删除失败: ' + r.error, true); return }
  toast('已删除 ' + path)
  const idx = state.tabs.findIndex((t) => t.root === CTX.root && t.file === path)
  if (idx >= 0) closeTab(idx)
  if (CTX.root === state.root) await refreshTreeFor(parent)
}
async function ctxCopyPath(root, path) {
  const paths = await rootPaths()
  const abs = (paths[root] || '') + '/' + (path || '')
  try { await navigator.clipboard.writeText(abs) } catch {}
  toast('已复制路径: ' + abs)
}
async function refreshTreeFor(dir) {
  for (const k of [...state.cache.keys()]) {
    if (k === '' || k === dir || k.startsWith(dir + '/') || dir.startsWith(k + '/')) state.cache.delete(k)
  }
  await loadTree(dir || ''); renderTree()
}

/* ── 装订 ── */
/* ★ 把已有快捷键登记进 Keys 框架,好让 F1 速查表能列出来。
 * ⚠⚠ 一律用 doc:true —— 这些键**本来就由本页 onKey() 实现**
 *   (它挂在 document 上,处理完还会管编辑态让位)。Keys 走捕获阶段,
 *   若真注册就会 preventDefault+stopPropagation 把事件吃掉,
 *   表现为"编辑框里按 Ctrl+S 没反应"。doc:true 只登记说明、不接管按键。 */
function registerShortcuts() {
  if (!window.Keys) return
  const K = window.Keys
  const D = { doc: true }
  window.__KEYMAP_PAGE__ = 'ide' // 本页归属:bind 查 keymap / 设置页按页分组
  // ★ combo 传 null + 带上 id:键位完全由 keymap 目录给出,
  //   这里写下的名字只是"这份速查表里该显示什么"的备忘。
  K.bind(null, null, '快速打开文件', Object.assign({ id: 'ide.quickOpen', group: '文件' }, D))
  K.bind(null, null, '保存 / 进入编辑模式', Object.assign({ id: 'ide.save', group: '文件' }, D))
  K.bind(null, null, '切换编辑模式', Object.assign({ id: 'ide.editMode', group: '文件' }, D))
  K.bind(null, null, '关闭当前标签', Object.assign({ id: 'ide.closeTab', group: '文件' }, D))
  K.bind(null, null, '文件内查找', Object.assign({ id: 'ide.find', group: '查找' }, D))
  K.bind(null, null, '跳转到行号', Object.assign({ id: 'ide.gotoLine', group: '查找' }, D))
  K.bind(null, null, '切换标签', Object.assign({ id: 'ide.cycleTab', group: '标签' }, D))
  K.bind(null, null, '下一个标签', Object.assign({ id: 'ide.nextTab', group: '标签' }, D))
  K.bind(null, null, '上一个标签', Object.assign({ id: 'ide.prevTab', group: '标签' }, D))
  K.bind(null, null, '折叠 / 展开文件树', Object.assign({ id: 'ide.toggleTree', group: '视图' }, D))
  K.bind(null, null, '触发自动补全', Object.assign({ id: 'ide.completion', group: '编辑' }, D))
}
function bind() {
  registerShortcuts()
  $('openVscode').onclick = openInLocalEditor
  // MAKE_MOD_V1:编辑 / 保存
  $('editBtn').onclick = () => setEditMode(!state.editing)
  // COMMENT_V1:工具栏入口,与 Ctrl+/ 走同一条路径(行为完全一致,不会两套逻辑)
  $('cmtBtn').onclick = () => {
    if (!state.editing) { if (!curTab() || !curTab().writable) { toast('只读来源,不能编辑。', true); return } setEditMode(true) }
    toggleComment()
  }
  $('saveBtn').onclick = saveFile
  $('rawEdit').addEventListener('input', (e) => { onEditInput(); scheduleAc() })
  $('rawEdit').addEventListener('keydown', (e) => {
    e.stopPropagation() // ★ 本监听在冒泡阶段就掐断,下面的键不会到 document 的 onKey,
    //   所以凡是"编辑框内也要生效"的快捷键必须在这里单独按 id 查一次,
    //   否则用户在设置页改了 Ctrl+S / Ctrl+Space,编辑框里按的还是旧键。
    // 补全弹窗打开时,方向键/回车/Tab/Esc 全部交给补全处理
    if (ac.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acSetSel(Math.min(ac.sel + 1, ac.items.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); acSetSel(Math.max(ac.sel - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acAccept(ac.sel); return }
      if (e.key === 'Escape') { e.preventDefault(); acHide(); return }
    }
    const hit = (id) => {
      if (!window.Keys) return false
      const c = Keys.fromEvent(e)
      return !!c && (Keys.combo(id) || []).indexOf(c) >= 0
    }
    if (hit('ide.completion')) { e.preventDefault(); acQuery(true); return }
    if (hit('ide.save')) { e.preventDefault(); saveFile(); return }
    /* ★ COMMENT_V1:注释 / 取消注释。必须挂在这里(rawEdit 的 keydown)——
     *   上面第一行 `e.stopPropagation()` 已经掐断了冒泡,到 document 的
     *   onKey 根本收不到,注册在那里等于没注册。 */
    if (hit('ide.toggleComment')) { e.preventDefault(); toggleComment(); return }
    if (e.key === 'Escape') { e.preventDefault(); setEditMode(false) }
  })
  $('rawEdit').addEventListener('scroll', () => ac.open && acPosition())
  $('rawEdit').addEventListener('blur', () => setTimeout(() => ac.open && acHide(), 120))
  $('rootSel').onchange = async () => {
    if (state.editing) setEditMode(false)
    state.root = parseInt($('rootSel').value, 10)
    state.cache.clear(); state.expanded = new Set([''])
    state.fileIndex.delete(state.root)
    await loadTree(''); renderTree()
  }
  $('reloadTree').onclick = async () => {
    state.cache.clear(); state.expanded = new Set([''])
    await loadTree(''); renderTree()
  }
  $('code').addEventListener('click', (e) => {
    const ln = e.target.closest('.ln')
    if (ln) { setActiveLine(ln); document.querySelectorAll('.ln.hl').forEach((x) => x.classList.remove('hl')) }
    const wspan = e.target.closest('.c-word')
    if (!wspan) return
    const line = parseInt(ln.dataset.line, 10)
    doNav(wspan.dataset.w, line)
    const txt = state.lines[line - 1] || ''
    $('statPos').textContent = `行 ${line},列 ${txt.indexOf(wspan.dataset.w) + 1}`
  })
  $('prevBtn').onclick = () => switchTab('preview')
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)))
  // 查找条
  $('findInput').addEventListener('input', () => doFind(0))
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey ? -1 : 1) }
    if (e.key === 'Escape') { e.preventDefault(); clearFind() }
  })
  $('findNext').onclick = () => doFind(1)
  $('findPrev').onclick = () => doFind(-1)
  $('findClose').onclick = () => clearFind()
  // 快速打开
  $('qoInput').addEventListener('input', () => renderQo($('qoInput').value))
  $('qoInput').addEventListener('keydown', (e) => {
    e.stopPropagation() // 避免与全局 onKey 重复处理方向键/回车
    if (e.key === 'Enter') { e.preventDefault(); qoConfirm() }
    if (e.key === 'ArrowDown') { e.preventDefault(); qoSel = Math.min(qoSel + 1, (qoList._cand ? qoList._cand.length - 1 : 0)); updateQoSel() }
    if (e.key === 'ArrowUp') { e.preventDefault(); qoSel = Math.max(qoSel - 1, 0); updateQoSel() }
    if (e.key === 'Escape') { e.preventDefault(); $('qoMask').classList.remove('on') }
  })
  $('qoMask').addEventListener('click', (e) => { if (e.target === $('qoMask')) $('qoMask').classList.remove('on') })
  // 右键菜单:点击别处或按 Esc 关闭
  document.addEventListener('click', (e) => { if (!e.target.closest('#ctxMenu')) hideCtxMenu() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu() })
  document.addEventListener('scroll', () => hideCtxMenu(), true)
  document.addEventListener('keydown', onKey)
}

/* ── 启动 ── */
/* ★ 深链(RIGHTCLICK_V1):各内容页右键「在 IDE 中打开并定位」会跳到
 *   /ide#root=<来源序号>&file=<相对路径>&line=<行号>
 *   用 hash 而非 query —— 参数变化不触发资源重载,已开的标签不丢。
 *   已经在本页时只改 hash,由 hashchange 接管(见 jumpToHash)。 */
function parseHash() {
  const h = location.hash.replace(/^#/, '')
  if (!h) return null
  const q = new URLSearchParams(h)
  let file = q.get('file')
  if (!file) return null
  const root = Number(q.get('root') ?? '0') || 0
  const line = Number(q.get('line') ?? '0') || 0
  /* ★ ABS_FILE_V1(2026-10-06):深链的 `file` 可能是**绝对路径**。
   *   各内容 API 下发格式不统一 —— tech/doctrines/focus 给相对路径,
   *   mio 给绝对路径。DLC 页右键「在 IDE 中打开」带着绝对路径跳过来,
   *   openFile(root, 绝对路径) 会拼成 `root/C:/…` 而找不到文件。
   *   这里把绝对路径裁成相对 root 的那一段,两种来源都能打开。
   *   裁不掉就原样传(跨来源的绝对路径不该被静默改写,让 openFile 报出来)。 */
  const base = (ROOT_PATHS[root] || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base) {
    const norm = file.replace(/\\/g, '/')
    const lowB = base.toLowerCase()
    const lowF = norm.toLowerCase()
    if (lowF === lowB) file = ''
    else if (lowF.startsWith(lowB + '/')) file = norm.slice(lowB.length + 1)
  }
  return { root, file, line }
}
let hashLock = false
async function jumpToHash() {
  const t = parseHash()
  if (!t) return
  hashLock = true
  try {
    $('rootSel').value = String(t.root)
    await openFile(t.root, t.file, t.line || undefined)
  } finally {
    hashLock = false
  }
}

async function init() {
  bind()
  try {
    const cfg = await getJson('/api/config')
    const sel = $('rootSel')
    sel.innerHTML = ''
    for (const r of cfg.roots) {
      const o = document.createElement('option')
      o.value = String(r.name === 'vanilla' ? 0 : cfg.roots.indexOf(r))
      o.textContent = r.name + (r.writable ? ' [可写]' : ' [只读]')
      sel.appendChild(o)
    }
    state.root = 0
    // 取各来源绝对路径(右键菜单"复制路径"要用)
    try { const s = await getJson('/api/sources'); ROOT_PATHS = (s.sources || []).map((x) => x.path) } catch {}
    await loadTree(''); renderTree()
    await jumpToHash()
  } catch (e) { toast('初始化失败: ' + e, true) }
  // 已在 IDE 页时右键跳转:只改 hash,不清空已开标签
  window.addEventListener('hashchange', () => { if (!hashLock) jumpToHash() })
}

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event('resize')))

init()
