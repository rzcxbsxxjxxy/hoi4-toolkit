/* 决议树可视化:三级递进「文件 → 决议类 → 决议」。
 *
 * 决议之间没有原生"前置"边(靠 available/allow 里的 flag 间接控制),
 * 所以三级按文件分组递进:
 *   第一级  文件(common/decisions/** 下的 .txt,主要是 categories/)
 *   第二级  决议类(文件里定义的 category 块)
 *   第三级  决议(决议类里的具体决议)
 *
 * ★ DECFILE_V1:分类与决议各自归属的文件【不一定相同】——
 *   分类的 file = 它生效定义所在文件;决议的 file = 决议自己定义所在文件。
 *   同一决议类下,不同决议可能来自不同文件,卡片上会按需标出各自文件。
 *
 * 图标按需懒加载(视口内 + 缓存),避免一次性请求上千张贴图。
 */
const $ = (s) => document.querySelector(s)

const S = {
  cats: [],
  files: [], // 三级树的文件层:[{key,file,rootName,root,name,cats[],open}]
  byCat: new Map(), // catId → category
  byDec: new Map(), // decId → {node, cat}
  selFile: '',
  selCat: '',
  selDec: null,
  /* 「显示详情」:false=脚本块截断 8 行 + 按钮;true=全文 + 完整字段 */
  decDetail: false,
  q: '',
  /* ── 来源筛选 ── */
  sources: [],
  sourceStats: {},
  originStats: {},
  src: '',
  totalDecisions: 0,
}

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 3600)
}

async function api(u, opt) {
window.LoadGate && window.LoadGate.show("正在加载决议…")
  // LOADGATE_V1:按功能懒加载 —— 图未就绪(busy)时全屏遮罩并轮询,就绪放行;已缓存页秒回。
  for (;;) {
    let d
    try {
      const r = await fetch(u, opt)
      d = await r.json()
    } catch (e) {
      // 网络中断 / 500 返回非 JSON:收起加载遮罩并回传 error 对象,
      // 走调用方既有的「!d.ready → 失败提示 + 退避重试」分支,
      // 绝不把 LoadGate 永久吊在原地(无限转圈)。
      if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
      window.LoadGate && window.LoadGate.hide()
      return { ready: false, busy: false, error: (e && e.message) || '请求失败' }
    }
    if (d && d.ready === false && d.busy) {
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(`正在构建决议图…`) }
      window.LoadGate && window.LoadGate.show(`加载中…`)
      await new Promise((res) => setTimeout(res, 1200))
      continue
    }
    if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
    window.LoadGate && window.LoadGate.hide()
    return d
  }
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
/** 本地化名称:有译文用译文(Loc.label 截断),无译文退回原始键 */
function locName(key, maxLen) {
  const t = window.Loc ? Loc.text(key) : ''
  if (t) return window.Loc ? Loc.label(key, maxLen) : t
  return String(key)
}
/** 取路径末段(文件名),用于树节点与徽标 */
function basename(p) {
  const s = String(p || '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/* ── 来源筛选器 ── */
/** 决议类自身有的「出现条件」块(allow/visible/available/target_trigger/ai_will_do) */
const CAT_KEYS = { allow: 'hasAllow', visible: 'hasVisible', available: 'hasAvailable', target_trigger: 'hasTargetTrigger', ai_will_do: 'hasAiWillDo', on_map_area: 'hasOnMapArea', highlight_states: 'hasHighlight' }
function catCondList(c) {
  return ['allow', 'visible', 'available', 'target_trigger', 'ai_will_do', 'on_map_area', 'highlight_states'].filter((k) => c[CAT_KEYS[k]] || c[k + 'Raw'])
}
/** 条件块行数 */
function condLines(c, k) {
  const t = c[k + 'Raw']
  return t ? String(t).split('\n').length : 0
}

function srcLabel(name) {
  return name === 'vanilla' ? '基础游戏' : name
}
function buildSrcSel() {
  const sel = $('#srcSel')
  sel.innerHTML = ''
  const add = (v, label, title) => {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (title) o.title = title
    sel.appendChild(o)
  }
  const sep = (t) => {
    const o = document.createElement('option')
    o.disabled = true
    o.textContent = t
    sel.appendChild(o)
  }
  const os = S.originStats || {}
  const ow = S.own || {}
  add('', `${tr("全部 (")}${S.totalDecisions})`, '同名决议只列最终生效的那一份')
  sep('── 内容归属 ──')
  add('vanilla', `${tr("原版 (")}${os.vanilla ?? ow.vanilla ?? 0})`, '原版决议,模组没有同名覆盖它')
  add('override', `${tr("模组改写 (")}${os.overridden ?? ow.override ?? 0})`, '原版有同名决议,被模组整份替换')
  add('new', `${tr("模组新增 (")}${os.modNew ?? ow.new ?? 0})`, '原版没有这条决议,模组新增 —— 与原版共存')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  const mods = S.sources.filter((s) => !s.base)
  if (mods.length) {
    sep('──────────')
    for (const s of mods) {
      const st = S.sourceStats[s.name] || { cats: 0, nodes: 0 }
      add(s.name, `${srcLabel(s.name)} (${st.nodes})`, s.path)
    }
  }
  sel.value = S.src
}
const SRC_HINT = {
  '': '',
  vanilla: '原版决议,模组没有同名覆盖它',
  override: '原版有同名决议,被模组整份替换 —— 原版那份已失效',
  new: '模组新增的决议(原版没有),与原版共存',
  base: '最终生效版本来自基础游戏',
  mod: '最终生效版本来自模组',
}
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources.filter((s) => s.base).length
  const mods = S.sources.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(`${tr("原版 ")}${base}`)
  if (mods) parts.push(`${tr("模组 ")}${mods}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : tr('来源:') + srcLabel(S.src)
  el.textContent = parts.length ? `${tr("来源 ")}${parts.join(' / ')}${hint ? ' · ' + hint : ''}` : ''
  el.title = hint
}

/** 卡片来源判定(与后端 ?src= 一致) */
function decVisible(d) {
  const s = S.src
  if (!s) return true
  if (s === 'base') return d.base
  if (s === 'mod') return !d.base
  if (s === 'vanilla') return Own.of(d) === 'vanilla'
  if (s === 'override' || s === 'overridden') return Own.of(d) === 'override'
  if (s === 'new' || s === 'modNew') return Own.of(d) === 'new'
  return d.rootName === s
}

/* ── 三级树:按分类生效文件分组 ── */
function groupByFiles() {
  const map = new Map()
  for (const c of S.cats) {
    const key = (c.rootName || '?') + '::' + (c.file || '?')
    let f = map.get(key)
    if (!f) {
      f = { key, file: c.file || '?', rootName: c.rootName, root: c.root, name: basename(c.file), cats: [], open: false }
      map.set(key, f)
    }
    f.cats.push(c)
  }
  S.files = [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/* ── 加载 ── */
let _retry = 0
async function loadGraph() {
  const d = await api('/api/decisions/graph' + (S.src ? '?src=' + encodeURIComponent(S.src) : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
    _retry++
    setTimeout(loadGraph, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  // 按列号排序,分类呈现更有结构感
  S.cats = [...d.categories].sort((a, b) => (a.column || 0) - (b.column || 0))
  S.byCat = new Map()
  S.byDec = new Map()
  for (const c of S.cats) {
    S.byCat.set(c.id, c)
    for (const dec of c.decisions) S.byDec.set(dec.id, { node: dec, cat: c.id })
  }
  groupByFiles()
  S.sources = d.sources || []
  S.sourceStats = d.sourceStats || {}
  S.originStats = d.originStats || {}
  S.own = d.own || null
  S.totalDecisions = d.stats.nodes
  const shown = d.stats.shownDecisions ?? d.stats.nodes
  $('#statChip').textContent =
    shown < S.totalDecisions
      ? `${shown}/${S.totalDecisions}${tr(" 决议(来源筛选中)· ")}${d.stats.shownCategories ?? d.stats.categories}${tr(" 分类")}`
      : `${d.stats.categories}${tr(" 分类 / ")}${d.stats.nodes}${tr(" 决议 / ")}${S.files.length}${tr(" 文件")}`
  $('#statChip').title = Own.statsLine(S.own)
  buildSrcSel()
  srcSummary()
  const sel = $('#catSel')
  sel.innerHTML = '<option value="">全部分类</option>'
  for (const c of S.cats) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = `${locName(c.id, 30)} (${c.decisions.length})`
    sel.appendChild(o)
  }
  if (S.selCat && !S.byCat.has(S.selCat)) S.selCat = ''
  if (S.selCat) sel.value = S.selCat
  if (S.selFile) {
    const f = S.files.find((x) => x.key === S.selFile)
    if (!f) S.selFile = ''
  }
  // 本地化:决议 id 与决议类 id 都是 loc 键 → 批量加载,完成后再渲染译文
  const locKeys = []
  for (const c of S.cats) { locKeys.push(c.id); for (const dec of c.decisions) locKeys.push(dec.id) }
  const finish = () => { renderTree(); renderCards() }
  if (window.Loc && locKeys.length) Loc.load(locKeys).then(finish)
  else finish()
}

/* ── 左侧三级树:文件 → 决议类 ── */
function renderTree() {
  const q = $('#q').value.trim().toLowerCase()
  const box = $('#catList')
  box.innerHTML = ''
  const isMatch = (c) => !q || c.id.toLowerCase().includes(q) || c.decisions.some((d) => d.id.toLowerCase().includes(q))
  const matchFile = (f) => !q || f.name.toLowerCase().includes(q) || f.cats.some(isMatch)
  let fCount = 0
  let cCount = 0
  for (const f of S.files) {
    if (!matchFile(f)) continue
    fCount++
    cCount += f.cats.length
    const cats = q ? f.cats.filter(isMatch) : f.cats
    const open = q ? true : (S.selFile === f.key || f.open)
    const total = f.cats.reduce((a, c) => a + c.decisions.length, 0)
    /* 文件节点 */
    const fEl = document.createElement('div')
    fEl.className = 'fitem' + (S.selFile === f.key ? ' on' : '')
    fEl.__f = f
    fEl.innerHTML =
      `<span class="caret">${open ? '▾' : '▸'}</span>` +
      `<span class="fic" data-tex="${esc(f.cats[0]?.tex || '')}"></span>` +
      `<span class="fname">${esc(f.name)}</span>` +
      `<span class="tag">${total}</span>`
    fEl.title = `${esc(f.file)}${tr("\\n决议类 ")}${f.cats.length}${tr(" / 决议 ")}${total}${tr("\\n来源 ")}${srcLabel(f.rootName)}`
    fEl.onclick = () => {
      S.selFile = S.selFile === f.key ? '' : f.key
      f.open = !f.open
      renderTree()
    }
    box.appendChild(fEl)
    /* 分类子节点 */
    const ch = document.createElement('div')
    ch.className = 'fchildren' + (open ? '' : ' hide')
    for (const c of cats) {
      const ownCls = Own.CLS[Own.of(c)]
      const ownTxt = Own.label(c)
      const el = document.createElement('div')
      el.className = 'item' + (S.selCat === c.id ? ' on' : '')
      el.dataset.id = c.id
      el.__obj = c
      const conds = catCondList(c)
      el.innerHTML =
        `<span class="catid">${esc(locName(c.id, 24))}</span> ` +
        (conds.length ? `<span class="condc" title="决议类出现条件">▨${conds.length}</span> ` : '') +
        `<span class="src ${ownCls}">${ownTxt}</span> ` +
        `<span class="tag">${c.decisions.length}</span>`
      el.title = `${c.id}${tr("\\n归属: ")}${ownTxt}\n${Own.hint(c)}\n${tr("\\n定义文件: ")}${esc(c.file)}`
      el.title = el.title + (conds.length ? `\n出现条件: ${conds.map((k) => k + '(' + condLines(c, k) + '行)').join(', ')}` : `\n无出现条件(始终显示)`)
      el.onclick = (e) => {
        e.stopPropagation()
        S.selCat = c.id
        S.selFile = f.key
        f.open = true
        $('#catSel').value = c.id
        renderTree()
        renderCards()
      }
      ch.appendChild(el)
    }
    box.appendChild(ch)
  }
  $('#catCount').textContent = `${cCount}/${S.cats.length}`
  if (!fCount) box.innerHTML = '<div class="empty" style="padding:10px 12px">没有匹配的文件</div>'
}

/* ── 卡片墙 ── */
function currentDecisions() {
  const q = $('#q').value.trim().toLowerCase()
  if (S.selCat) {
    const c = S.byCat.get(S.selCat)
    if (!c) return []
    return q ? c.decisions.filter((d) => d.id.toLowerCase().includes(q)) : c.decisions
  }
  // 未选分类:跨全部分类搜索(决策自带 file,归属清楚)
  let all = [...S.byDec.values()].map((x) => x.node)
  if (q) all = all.filter((d) => d.id.toLowerCase().includes(q))
  return all
}

/** 面包屑:显示当前选中的 文件 → 决议类 */
function renderCrumb() {
  const crumb = $('#crumb')
  if (!crumb) return
  if (S.selCat) {
    const c = S.byCat.get(S.selCat)
    if (!c) {
      crumb.innerHTML = ''
      return
    }
    const f = S.files.find((x) => x.key === S.selFile)
    crumb.innerHTML =
      `<button class="crumb-file" title="${esc(c.file)}">${esc(f ? f.name : basename(c.file))}</button>` +
      `<span class="crumb-sep">›</span><span class="crumb-cat">${esc(c.id)}</span>`
    crumb.querySelector('.crumb-file').onclick = () => {
      S.selCat = ''
      S.selFile = f ? f.key : ''
      $('#catSel').value = ''
      renderTree()
      renderCards()
    }
  } else crumb.innerHTML = ''
}

/** 选中决议类时,显示该决议类的属性与出现条件(allow/visible/…,点击可查看原文) */
function renderCatMeta() {
  const el = $('#catMeta')
  if (!el) return
  if (!S.selCat) { el.innerHTML = ''; return }
  const c = S.byCat.get(S.selCat)
  if (!c) { el.innerHTML = ''; return }
  const conds = catCondList(c)
  const attrs = []
  if (c.priority !== undefined) attrs.push(`priority ${c.priority}`)
  if (c.cost !== undefined) attrs.push(`cost ${c.cost}`)
  if (c.daysRemove !== undefined) attrs.push(`days_remove ${c.daysRemove}`)
  if (c.isAlert) attrs.push(`is_alert ${c.isAlert}`)
  if (c.visibleWhenEmpty) attrs.push(`visible_when_empty yes`)
  if (c.scriptedGui) attrs.push(`scripted_gui ${c.scriptedGui}`)
  el.innerHTML =
    `<span class="catmeta-id">${esc(locName(c.id, 40))}</span>` +
    (attrs.length ? `<span class="catmeta-attrs">${esc(attrs.join(' · '))}</span>` : '') +
    (conds.length
      ? `<span class="catmeta-conds">出现条件: ` +
        conds.map((k) => `<button class="cond" data-k="${k}">${k}</button>`).join(' ') +
        `</span>`
      : `<span class="catmeta-nocond" style="color:var(--ink3)">无出现条件(始终显示)</span>`)
  el.querySelectorAll('button.cond').forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.k
      $('#insp').innerHTML = `<div class="hint" style="padding:20px">加载 ${esc(k)} 条件…</div>`
      const dd = await api('/api/decisions/catdetail?id=' + encodeURIComponent(c.id))
      const RAWKEY = { on_map_area: "onMapAreaRaw", highlight_states: "highlightRaw" }
      const rk = RAWKEY[k] || (k + "Raw")
      const txt = dd && dd.ready && dd.found ? (dd.node[rk] || '') : ''
      $('#insp').innerHTML =
        `<h4>决议类条件 · ${esc(k)}</h4>` +
        decBlock(`${esc(k)} · 决议类 ${esc(c.id)}`, txt, true) +
        `<button class="dbtn" style="margin-top:8px" id="condClose">关闭</button>`
      document.getElementById('condClose').onclick = () => {
        $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个决议</div>'
      }
    }
  })
}

function renderCards() {
  const grid = $('#grid')
  const decs = currentDecisions()
  const mods = decs.filter((d) => !d.base).length
  renderCrumb()
  renderCatMeta()
  $('#cardSum').innerHTML = decs.length
    ? `<span>${decs.length}${tr(" 个决议 · 模组 ")}${mods}${tr(" / 原版 ")}${decs.length - mods}${
        S.src ? ` · 已按来源筛选(全部 ${S.totalDecisions})` : ''
      }</span>` +
      `<span><i class="mk" style="background:#8a929e"></i>基础游戏</span>` +
      `<span><i class="mk" style="background:var(--warn)"></i>模组改写</span>` +
      `<span><i class="mk" style="background:var(--accent)"></i>模组新增</span>`
    : ''
  grid.innerHTML = ''
  if (!decs.length) {
    grid.innerHTML = '<div class="empty">没有匹配的决议</div>'
    return
  }
  Incr.mount(grid, decs, makeCard, { batch: 120 })
}

function makeCard(n) {
  const card = document.createElement('div')
  card.className = 'card' + (S.selDec === n.id ? ' on' : '') + (n.base ? '' : ' frommod')
  card.dataset.id = n.id
  card.__obj = n
  const chips = []
  if (n.cost) chips.push(`${tr("<span class=\"mini c\">花费 ")}${n.cost}</span>`)
  if (n.days) chips.push(`<span class="mini d">${n.days}${tr("天</span>")}`)
  const flags = []
  if (n.hasAvailable) flags.push('avail')
  if (n.hasAllow) flags.push('allow')
  if (n.hasEffect) flags.push('eff')
  if (n.hasVisible) flags.push('vis')
  if (n.hasComplete) flags.push('comp')
  if (flags.length) chips.push(`<span class="mini f">${flags.join('·')}</span>`)
  if (Own.of(n) !== 'vanilla') chips.push(Own.badge(n))
  if (!n.base) chips.push(`<span class="mini m">${esc(srcLabel(n.rootName))}</span>`)
  /* ★ DECFILE_V1:决议自己的文件可能与所在分类的文件不同 → 标出(仅当确实不同) */
  if (S.selCat) {
    const c = S.byCat.get(S.selCat)
    if (c && n.file && n.file !== c.file) chips.push(`<span class="mini x">${esc(basename(n.file))}</span>`)
  }
  card.innerHTML = `
      <img class="ic" data-tex="${esc(n.tex || '')}" alt="" loading="lazy">
      <div class="nm">${esc(locName(n.id, 42))}</div>
      <div class="mt">${chips.join('')}</div>`
  card.title =
    `${n.id}${tr("\\n归属: ")}${Own.label(n)}\n${Own.hint(n)}` +
    `${tr("\\n最终生效: ")}${n.rootName}(${n.base ? '基础游戏' : '模组'}${tr(")\\n位置: ")}${n.file}:${n.line}`
  card.onclick = () => selectDec(n.id)
  card.ctxItems = (ev) => {
    const el = (ev && ev.target && ev.target.closest) ? ev.target.closest('.card') : card
    const d = el && el.__obj ? el.__obj : n
    return window.Ctx ? Ctx.sourceItems({ root: d.root, rootName: d.rootName, file: d.file, line: d.line, id: d.id, loc: d.loc }) : null
  }
  const img = card.querySelector('img.ic')
  if (n.tex) Tex.mount(card)
  else img.style.background = 'var(--line2)'
  return card
}

async function selectDec(id) {
  S.selDec = id
  for (const c of document.querySelectorAll('.card')) c.classList.toggle('on', c.dataset.id === id)
  const rec = S.byDec.get(id)
  if (!rec) return
  const n = rec.node
  // DECISION_DETAIL_V1:graph 已裁剪决议 raw,首次选中该决议时异步拉详情补字段(已缓存则秒渲)
  if (!n._rawLoaded) {
    $('#insp').innerHTML = `<div class="hint" style="padding:20px">加载脚本块…</div>`
    const dd = await api('/api/decisions/detail?id=' + encodeURIComponent(id))
    if (S.selDec !== id) return
    n._rawLoaded = true
    if (dd && dd.ready && dd.found) {
      const dn = dd.node
      n.availableRaw = dn.availableRaw || ''; n.allowRaw = dn.allowRaw || ''; n.visibleRaw = dn.visibleRaw || ''
      n.completeRaw = dn.completeRaw || ''; n.removeEffectRaw = dn.removeEffectRaw || ''; n.hiddenEffectRaw = dn.hiddenEffectRaw || ''
      n.modifierRaw = dn.modifierRaw || ''; n.targetTriggerRaw = dn.targetTriggerRaw || ''; n.aiWillDoRaw = dn.aiWillDoRaw || ''
      n.daysReEnable = dn.daysReEnable || 0; n.fireOnlyOnce = !!dn.fireOnlyOnce; n.priority = dn.priority || 0
      n.customCostTriggerRaw = dn.customCostTriggerRaw || ""; n.customCostText = dn.customCostText || ""; n.aiHintPpCost = dn.aiHintPpCost || 0
      n.removeTriggerRaw = dn.removeTriggerRaw || ""; n.cancelTriggerRaw = dn.cancelTriggerRaw || ""; n.cancelIfNotVisible = !!dn.cancelIfNotVisible
      n.cancelEffectRaw = dn.cancelEffectRaw || ""; n.warWithOnRemove = dn.warWithOnRemove || ""; n.warWithOnComplete = dn.warWithOnComplete || ""
      n.fixedRandomSeed = dn.fixedRandomSeed !== undefined ? dn.fixedRandomSeed : true
      n.highlightRaw = dn.highlightRaw || ""; n.targetedModifierRaw = dn.targetedModifierRaw || ""
    }
  }
  const condBlocks = [
    ['available · 出现条件', n.availableRaw],
    ['allowed · 允许条件', n.allowRaw],
    ['visible · 可见条件', n.visibleRaw],
    ['target_trigger · 目标条件', n.targetTriggerRaw],
    ['ai_will_do · AI 意愿', n.aiWillDoRaw],
    ['custom_cost_trigger · 自定义成本条件', n.customCostTriggerRaw],
    ['remove_trigger · 即时移除条件', n.removeTriggerRaw],
    ['cancel_trigger · 提前取消条件', n.cancelTriggerRaw],
    ['highlight_states · 状态/省高亮', n.highlightRaw],
  ]
  const effBlocks = [
    ['complete_effect · 完成效果', n.completeRaw],
    ['modifier · 修正器', n.modifierRaw],
    ['targeted_modifier · 目标修正', n.targetedModifierRaw],
    ['remove_effect · 移除效果', n.removeEffectRaw],
    ['hidden_effect · 隐藏效果', n.hiddenEffectRaw],
    ['cancel_effect · 取消效果', n.cancelEffectRaw],
  ]
  const hasCond = condBlocks.some(([, t]) => t)
  const hasEff = effBlocks.some(([, t]) => t)
  const extraParams = [
    n.daysReEnable ? ['再次可选取(冷却)', `days_re_enable ${n.daysReEnable}`] : null,
    n.fireOnlyOnce ? ['只触发一次', 'fire_only_once = yes'] : null,
    n.priority ? ['优先级', `priority ${n.priority}`] : null,
    n.customCostText ? ['自定义成本文本', `custom_cost_text ${n.customCostText}`] : null,
    n.aiHintPpCost ? ['AI 预留政治点', `ai_hint_pp_cost ${n.aiHintPpCost}`] : null,
    n.cancelIfNotVisible ? ['不可见即取消', 'cancel_if_not_visible = yes'] : null,
    n.warWithOnComplete ? ['战争预告(完成时)', `war_with_on_complete ${n.warWithOnComplete}`] : null,
    n.warWithOnRemove ? ['战争预告(移除时)', `war_with_on_remove ${n.warWithOnRemove}`] : null,
    n.fixedRandomSeed === false ? ['固定随机种子', 'fixed_random_seed = no'] : null,
  ].filter(Boolean)
  const flags = []
  if (n.hasAvailable) flags.push('available')
  if (n.hasAllow) flags.push('allow')
  if (n.hasVisible) flags.push('visible')
  if (n.hasComplete) flags.push('complete_effect')
  if (n.hasEffect) flags.push('effect')
  const btnId = 'decDetailBtn'
  const catFile = S.byCat.get(rec.cat)
  $('#insp').innerHTML = `
    <div class="kv"><b>id</b><span>${esc(n.id)}${tr("</span></div>\n    <div class=\"kv\"><b>分类</b><span>")}${esc(rec.cat)}${tr("</span></div>\n    <div class=\"kv\"><b>内容归属</b><span>")}${
      n.origin === 'mod'
        ? '<span class="src new">模组新增</span> 原版没有这个决议'
        : n.overridden
          ? `<span class="src ovr">模组改写</span> 原版有,现由 ${esc(srcLabel(n.rootName))} 生效`
          : '<span class="src base">基础游戏</span>'
    }${tr("</span></div>\n    <div class=\"kv\"><b>生效来源</b><span><span class=\"src ")}${n.base ? 'base' : 'mod'}">${esc(srcLabel(n.rootName))}</span> ${n.base ? '基础游戏' : '模组'}${tr("</span></div>\n    <div class=\"kv\"><b>图标</b><span>")}${esc(n.icon) || '—'}${tr("</span></div>\n    <div class=\"kv\"><b>花费</b><span>")}${n.cost}${tr("</span></div>\n    <div class=\"kv\"><b>移除天数</b><span>")}${n.days}${tr("</span></div>\n    <div class=\"kv\"><b>定义文件</b><span>")}${esc(n.file)}:${n.line}${tr("</span></div>\n    <div class=\"kv\"><b>分类文件</b><span>")}${catFile ? esc(catFile.file) : '—'}${tr("</span></div>\n    <div class=\"kv\"><b>位置</b><span>")}${esc(n.rootName + ':' + n.file)}:${n.line}</span></div>
    ${extraParams.length ? '<h4>参数</h4>' + extraParams.map(function (e2) { return '<div class="kv"><b>' + esc(e2[0]) + '</b><span>' + esc(e2[1]) + '</span></div>'; }).join('') : ''}
    ${
      hasCond
        ? `<h4>条件 <span style="font-weight:400;color:var(--ink3)">${flags.slice(0, 3).map(esc).join(' / ') || ''}</span></h4>` +
          condBlocks.map(([t, txt]) => (txt ? decBlock(t, txt, S.decDetail) : '')).join('')
        : ''
    }
    ${
      hasEff
        ? tr('<h4>效果</h4>') + effBlocks.map(([t, txt]) => (txt ? decBlock(t, txt, S.decDetail) : '')).join('')
        : ''
    }
    ${
      !hasCond && !hasEff
        ? '<div class="hint" style="padding:6px 0">该决议没有任何脚本块 —— 游戏里点下去什么都不做。</div>'
        : ''
    }
    ${S.decDetail ? decDump(n) : `<button id="${btnId}" class="dbtn" style="margin-top:8px">▸ 显示详情</button>`}`
  const btn = document.getElementById(btnId)
  if (btn)
    btn.onclick = () => {
      S.decDetail = !S.decDetail
      selectDec(id)
    }
}

/** 渲染一个脚本块:默认截断 8 行,显示详情时给全文 */
function decBlock(title, text, full) {
  const lines = String(text).split('\n')
  const body = !full && lines.length > 8 ? lines.slice(0, 8).join('\n') + `${tr("\\n…(共 ")}${lines.length}${tr(" 行)")}` : text
  return `<div class="kv blk"><b>${esc(title)}</b><pre class="raw">${esc(body)}</pre></div>`
}

/** 显示详情:列出决议节点上所有字段(raw) */
function decDump(n) {
  const skip = new Set([
    'defs', 'hasAvailable', 'hasAllow', 'hasEffect', 'hasVisible', 'hasComplete',
    'availableRaw', 'allowRaw', 'visibleRaw', 'completeRaw', 'removeEffectRaw',
    'hiddenEffectRaw', 'modifierRaw', 'targetTriggerRaw', 'aiWillDoRaw',
    'customCostTriggerRaw', 'removeTriggerRaw', 'cancelTriggerRaw', 'cancelEffectRaw',
    'highlightRaw', 'targetedModifierRaw',
  ])
  const rows = []
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k)) continue
    let s
    if (Array.isArray(v)) s = v.length ? v.map((x) => esc(String(x))).join(', ') : '（空）'
    else if (v === null || v === undefined || v === '') continue
    else s = esc(String(v))
    rows.push(`<div class="kv"><b>${esc(k)}</b><span>${s}</span></div>`)
  }
  return `<div class="sec-t">完整字段(raw · 显示详情)</div>` + (rows.join('') || '<div class="hint">无</div>')
}

/* ── 绑定 ── */
$('#q').addEventListener('input', () => {
  renderTree()
  renderCards()
})
$('#catSel').addEventListener('change', (e) => {
  S.selCat = e.target.value
  if (S.selCat) {
    const c = S.byCat.get(S.selCat)
    if (c) S.selFile = S.files.find((f) => f.cats.includes(c))?.key || ''
  }
  renderTree()
  renderCards()
})
$('#srcSel').addEventListener('change', async (e) => {
  S.src = e.target.value
  S.selCat = ''
  S.selFile = ''
  S.selDec = null
  $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个决议</div>'
  await loadGraph()
})

// ★ 面板宽度可调
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

/* ═══ 右键菜单 + 快捷键(RIGHTCLICK_V2) ═══ */
function wireCtxAndKeys() {
  if (!window.CtxWire) return
  CtxWire.attach({
    page: 'decisions',
    on: [
      { host: '#grid', sel: '.card', obj: (el) => {
          const n = el.__obj
          if (!n) return null
          return { root: n.root, rootName: n.rootName, file: n.file, line: n.line, id: n.id, loc: n.loc, _n: n }
        },
        items: (o) => {
          const n = o._n
          const catId = S.byDec.get(n.id)?.cat
          return [
            n.cost ? { label: tr('复制花费(') + n.cost + ')', k: '⧉', act: () => Ctx.copy(String(n.cost), '') } : null,
            n.days ? { label: tr('复制天数(') + n.days + ')', k: '⧉', act: () => Ctx.copy(String(n.days), '') } : null,
            { label: '只看这个分类', k: '→', act: () => { S.selCat = catId || ''; loadGraph() } },
          ].filter(Boolean)
        } },
      /* 三级树的分类项 —— 数据在 el.__obj */
      { host: '#catList', sel: '.item', obj: (el) => (el.__obj ? { id: el.__obj.id, rootName: '决议分类', _c: el.__obj } : null),
        items: (o) => [
          { label: '复制分类 id', k: '⧉', act: () => Ctx.copy(o.id, '') },
          { label: o.id === S.selCat ? '取消筛选' : '只看这个分类', k: '→', act: () => { S.selCat = o.id === S.selCat ? '' : o.id; loadGraph() } },
        ] },
      /* 文件节点 —— 数据在 el.__f */
      { host: '#catList', sel: '.fitem', obj: (el) => (el.__f ? { id: el.__f.file, rootName: '决议文件', _f: el.__f } : null),
        items: (o) => [
          { label: '复制文件路径', k: '⧉', act: () => Ctx.copy(o.id, '') },
          { label: '只看这个文件', k: '→', act: () => { S.selCat = ''; S.selFile = o._f.key; $('#q').value=''; renderTree(); renderCards() } },
        ] },
    ],
    keys: [
      { id: 'find.search', run: () => { const q = $('#q'); if (q) q.focus() }, desc: '聚焦搜索框', group: '查找' },
      ...CtxWire.commonKeys(() => (S.selDec ? { id: S.selDec } : null), { label: '决议', clear: () => { S.selDec = null; renderCards() } }),
      { id: 'sel.clear', desc: '取消选择', group: '选中', run: () => { S.selDec = null; renderCards(); const i = $('#insp'); if (i) i.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个决议</div>' } },
    ],
  })
}
wireCtxAndKeys()

loadGraph()
