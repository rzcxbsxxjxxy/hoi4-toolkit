'use strict'
/* ══════════════════════════════════════════════════════════════════
 * 文档查阅前端 —— /ref(官方手册) 与 /commondocs(common 文档) 共用。
 * kind 由 pathname 决定,切页按钮只是跳到另一个路由。
 *
 * 后端是【实时】的:每次点文档都现读现解析,所以这里不做任何内容缓存,
 * 只有"当前已加载的那篇"留在内存里供搜索/定位。
 * ══════════════════════════════════════════════════════════════════ */

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

const KIND = /commondocs/i.test(location.pathname) ? 'common' : 'official'
document.body.dataset.kind = KIND

const IS_COMMON = KIND === 'common'
$('#hTitle').firstChild.textContent = IS_COMMON ? '📚 common 文档 ' : '📚 官方手册 '
$('#btnOfficial').className = IS_COMMON ? '' : 'on'
$('#btnCommon').className = IS_COMMON ? 'on' : ''
$('#btnOfficial').onclick = () => { location.href = '/ref' }
$('#btnCommon').onclick = () => { location.href = '/commondocs' }
$('#treeTitle').textContent = '文档目录'
$('#outlineTitle').textContent = '条目大纲'
$('#q').placeholder = IS_COMMON ? '搜索文件…' : '搜索文档…'
$('#qOutline').placeholder = IS_COMMON ? '搜索章节…' : '搜索条目(如 add_attack)…'

let GROUPS = []
let CUR = null          // 当前已加载文档
let CUR_ID = ''
let OPEN = new Set()    // 展开的类别

function toast(m, bad) {
  const t = $('#toast')
  t.textContent = m
  t.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(t._h)
  t._h = setTimeout(() => { t.className = '' }, 2200)
}

/* ─────────────── 左侧树 ─────────────── */

/* ─────────────── 左栏:文档目录 ─────────────── */

function renderTree(hits) {
  // ★ REF_SPLIT_V1:左栏只放【文档目录】(按组/文件夹列出的文档列表)。
  //   当前文档的条目大纲已拆到右侧 #outline(renderOutline),不再混在一栏里。
  const tree = $('#tree')
  const q = hits ? hits.q : ''
  let html = ''

  for (const g of GROUPS) {
    const items = q && hits ? g.items.filter((f) => hits.docs.has(f.id)) : g.items
    if (q && hits && !items.length) continue
    const gname = IS_COMMON ? (g.name === 'common' ? 'common/(顶层)' : g.name) : g.name
    html += `<div class="grp">${esc(gname)} <span style="font-weight:400">${items.length}</span></div>`
    for (const f of items) {
      html += `<div class="doc${f.id === CUR_ID ? ' on' : ''}" data-id="${esc(f.id)}" title="${esc(f.rel)}">${esc(f.name)}</div>`
    }
  }
  tree.innerHTML = html || '<div class="empty" style="padding:20px">没有匹配</div>'
}

/* ─────────────── 右栏:条目大纲 ─────────────── */

function renderOutline(hits) {
  // ★ REF_SPLIT_V1:右栏【条目大纲】= 当前文档的类别/条目(common 是章节)。
  //   无 CUR 时给引导文案;搜索态(q + ents)只列命中项。
  const ol = $('#outline')
  if (!CUR) {
    ol.innerHTML = '<div class="empty" style="padding:24px 12px">打开一篇文档后<br>这里显示本篇的条目大纲</div>'
    return
  }
  const q = hits ? hits.q : ''
  let html = ''
  if (IS_COMMON) {
    const secs = q && hits ? CUR.sections.filter((s) => s.title && hits.ents.has(s.title)) : CUR.sections
    if (q && hits && !secs.length) html = '<div class="empty" style="padding:20px">无匹配章节</div>'
    else for (const s of secs) {
      if (!s.title) continue
      html += `<div class="ent" data-anchor="${esc(s.id)}">${esc(s.title)}</div>`
    }
  } else {
    for (const c of CUR.categories) {
      const ents = q && hits ? c.entries.filter((e) => hits.ents.has(e.name)) : null
      if (q && hits) {
        for (const e of ents) html += `<div class="ent" data-anchor="${esc(e.id)}" title="${esc(c.name)}">${esc(e.name)}</div>`
        continue
      }
      const open = OPEN.has(c.id)
      html += `<div class="cat${open ? ' open' : ''}" data-cat="${esc(c.id)}">` +
        `<span class="n">${open ? '▾' : '▸'} ${esc(c.name)}</span><span class="c">${c.entries.length}</span></div>`
      if (open) for (const e of c.entries) {
        html += `<div class="ent" data-anchor="${esc(e.id)}">${esc(e.name)}</div>`
      }
    }
  }
  ol.innerHTML = html
}

/* ─────────────── 右侧正文 ─────────────── */

function renderDoc() {
  const wrap = $('#doc')
  if (!CUR) { wrap.innerHTML = '<div class="wrap"><div class="empty">左侧选择一篇文档</div></div>'; return }
  const f = CUR.file
  const meta = `${esc(f.rootName)} · ${esc(f.rel)} · ${(f.size / 1024).toFixed(1)} KB`
  let body = ''

  if (IS_COMMON) {
    for (const s of CUR.sections) {
      if (s.title) {
        const lv = Math.min(3, Math.max(2, s.level || 2))
        body += `<h${lv} class="sec" id="${esc(s.id)}">${esc(s.title)}</h${lv}>`
      }
      body += s.html
    }
  } else {
    body += CUR.intro || ''
    for (const c of CUR.categories) {
      body += `<h2 class="sec" id="cat-${esc(c.id)}">${esc(c.name)} <span style="font-weight:400;color:var(--ink3);font-size:12px">${c.entries.length}</span></h2>`
      for (const e of c.entries) {
        body += `<h3 class="ent-t" id="${esc(e.id)}">${esc(e.name)}</h3>`
        if (e.scopes || e.targets) {
          body += `<div class="scopes">` +
            (e.scopes ? `<b>Scopes:</b> ${esc(e.scopes)}　` : '') +
            (e.targets ? `<b>Targets:</b> ${esc(e.targets)}` : '') + `</div>`
        }
        body += e.html
      }
    }
  }

  wrap.innerHTML = `<div class="wrap"><h1 class="t">${esc(CUR.title)}</h1><div class="meta">${meta}</div>${body}</div>`
  delete wrap.dataset.orig // 换文档了,搜索高亮的"原文快照"要作废
  $('#doc').scrollTop = 0
}

/* ─────────────── 加载 ─────────────── */

async function openDoc(id) {
  if (id === CUR_ID) return
  CUR_ID = id
  renderTree(null)
  renderOutline(null)
  try {
    const r = await fetch(`/api/docs/read?kind=${KIND}&id=${encodeURIComponent(id)}`)
    const j = await r.json()
    if (j.error) { toast(j.error, true); return }
    CUR = j
    OPEN = new Set((j.categories ?? []).slice(0, 1).map((c) => c.id))
    renderTree(null)
    renderOutline(null)
    renderDoc()
  } catch (e) { toast(tr('加载失败: ') + e.message, true) }
}

async function loadList() {
  try {
    const r = await fetch(`/api/docs/list?kind=${KIND}`)
    const j = await r.json()
    if (j.error) { toast(j.error, true); return }
    GROUPS = j.groups ?? []
    const total = j.total ?? 0
    $('#statChip').textContent = `${total}${tr(" 篇 · ")}${j.groups.length}${tr(" 组")}`
    if (!j.ready) { $('#statChip').textContent = '未挂载来源'; return }
    renderTree(null)
    // 默认打开第一篇
    const first = GROUPS[0]?.items?.[0]
    if (first) openDoc(first.id)
  } catch (e) { toast(tr('列表加载失败: ') + e.message, true) }
}

/* ─────────────── 事件 ─────────────── */

/* 左栏(文档目录)/ 右栏(条目大纲)共用一套点击逻辑:
 *   .doc    → 打开该文档
 *   .cat    → 展开/收起(只存在于右栏)
 *   .ent    → 滚动到正文对应锚点 */
function onPaneClick(e) {
  const doc = e.target.closest('.doc')
  if (doc) { openDoc(doc.dataset.id); return }
  const cat = e.target.closest('.cat')
  if (cat) {
    const id = cat.dataset.cat
    if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id)
    renderOutline(null)
    return
  }
  const ent = e.target.closest('.ent')
  if (ent) {
    const el = document.getElementById(ent.dataset.anchor)
    if (el) el.scrollIntoView({ block: 'start' })
    return
  }
}
$('#tree').addEventListener('click', onPaneClick)
$('#outline').addEventListener('click', onPaneClick)

/* 文档正文命中高亮(右栏搜索条目时用) */
function restoreDocBody() {
  const wrap = $('#doc')
  if (wrap.dataset.orig) wrap.innerHTML = wrap.dataset.orig
}
function highlightDocBody(q, ents) {
  const wrap = $('#doc')
  if (!wrap.dataset.orig) wrap.dataset.orig = wrap.innerHTML
  else wrap.innerHTML = wrap.dataset.orig
  if (ents.size) {
    const rx = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const w = wrap.querySelector('.wrap')
    if (w) w.innerHTML = w.innerHTML.replace(/(>[^<]+<)/g, (m) => m.replace(rx, '<span class="hit">$1</span>'))
  }
}

/* 左栏搜索:只过滤【文档目录】(按文件名 / 路径) */
$('#q').addEventListener('input', () => {
  const q = $('#q').value.trim().toLowerCase()
  if (!q) { renderTree(null); return }
  const docs = new Set()
  for (const g of GROUPS) for (const f of g.items) {
    if (f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q)) docs.add(f.id)
  }
  renderTree({ q, docs })
})

/* 右栏搜索:过滤【条目大纲】并在正文里高亮命中(跨文档搜索太重,不做) */
$('#qOutline').addEventListener('input', () => {
  const q = $('#qOutline').value.trim().toLowerCase()
  if (!q) { renderOutline(null); restoreDocBody(); return }
  const ents = new Set()
  if (CUR) {
    const list = IS_COMMON
      ? (CUR.sections ?? []).map((s) => s.title)
      : (CUR.categories ?? []).flatMap((c) => c.entries.map((e) => e.name))
    for (const n of list) if (n && n.toLowerCase().includes(q)) ents.add(n)
  }
  renderOutline({ q, ents })
  highlightDocBody(q, ents)
})

/* ══════════════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V2)
 *
 * 文档页的价值在于"条目名"本身就是 identifier(effect / trigger / scope),
 * 所以菜单重点给:复制条目名 · 复制锚点链接 · 复制当前文件路径。
 * ⚠ 后端 /api/docs/list 给的 f.rel 是**相对 documentation 目录**的路径,
 *   不是游戏文件路径 —— 所以这里不给"在 IDE 打开"(给不出可用的 root+file),
 *   只给"复制路径"与"复制锚点链接"。这比给一个点了会报错的入口诚实。
 * ══════════════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire) return
  const findDoc = (id) => GROUPS.flatMap((g) => g.items).find((x) => x.id === id)
  CtxWire.attach({
    page: 'ref',
    on: [
      /* 左栏文档目录 / 右栏条目大纲 */
      {
        host: '#tree, #outline',
        sel: '.doc, .cat, .ent',
        obj: (el) => {
          let id = el.dataset.id || el.dataset.anchor || el.dataset.cat
          if (!id) return null
          // 类别标题在正文里的锚点是 cat-<id>(renderDoc 里拼的),这里补上前缀
          if (el.dataset.cat) id = 'cat-' + id
          // 树里的 .doc 才带 data-id;目录/条目归到当前文档
          const docId = el.dataset.id || CUR_ID
          const f = findDoc(docId)
          return { id, rootName: IS_COMMON ? 'common 文档' : '官方手册', file: f ? f.rel : '', line: 0, _f: f, _anchor: id }
        },
        items: (o) => [
          o._f ? { label: tr('复制相对路径(') + o._f.rel + ')', k: '⧉', act: () => Ctx.copy(o._f.rel, '') } : null,
          { label: '复制本条锚点链接', k: '⧉', act: () => Ctx.copy(location.origin + location.pathname + '#' + o._anchor, '') },
          o._f ? { label: '打开这篇文档', k: '→', act: () => openDoc(o._f.id) } : null,
        ].filter(Boolean),
      },
      /* 正文区块:复制锚点 */
      {
        host: '#doc',
        sel: 'h2.sec, h3.ent-t, h4.ent-t',
        obj: (el) =>
          el.id
            ? { id: el.id, rootName: IS_COMMON ? 'common 文档' : '官方手册', file: (findDoc(CUR_ID) || {}).rel || '' }
            : null,
        items: (o) => [
          { label: '复制锚点链接', k: '⧉', act: () => Ctx.copy(location.origin + location.pathname + '#' + o.id, '') },
        ],
      },
    ],
    keys: [
      { id: 'find.search', desc: '聚焦搜索框', group: '查找', run: () => { const q = $('#q'); if (q) q.focus() } },
      {
        id: 'sel.copyId', desc: '复制当前文档的相对路径', group: '选中',
        run: () => {
          const f = findDoc(CUR_ID)
          if (!f) { toast('还没打开文档', true); return }
          Ctx.copy(f.rel, '')
        },
      },
      { id: 'sel.menu', desc: '对选中条目打开右键菜单', group: '选中', run: () => Keys.ctxKey() },
      { id: 'nav.nextItem', desc: '下一个条目(在当前文档目录里)', group: '浏览', run: () => stepEnt(1) },
      { id: 'nav.prevItem', desc: '上一个条目', group: '浏览', run: () => stepEnt(-1) },
      {
        id: 'sel.clear', desc: '清空搜索', group: '查找',
        run: () => { const q = $('#q'); if (q) { q.value = ''; q.dispatchEvent(new Event('input')) } },
      },
    ],
  })

  /* 条目大纲内上下移动(j/k,像 vim) */
  function stepEnt(d) {
    const list = [...document.querySelectorAll('#outline .ent')]
    if (!list.length) { toast('当前文档没有条目目录', true); return }
    const cur = list.findIndex((e) => e.classList.contains('on'))
    const j = cur < 0 ? 0 : cur + d
    if (j < 0 || j >= list.length) return
    list[j].click()
    list[j].scrollIntoView({ block: 'nearest' })
  }
}
wireCtxAndKeys()

loadList()

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))
