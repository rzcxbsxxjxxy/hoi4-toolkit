/* 决议树可视化:按分类陈列的卡片墙。
 *
 * 决议之间没有原生"前置"边(靠 available/allow 里的 flag 间接控制),
 * 所以这里按"分类"分组,用可滚动的卡片墙呈现,点选查看详细面板。
 * 图标按需懒加载(视口内 + 缓存),避免一次性请求上千张贴图。
 */
const $ = (s) => document.querySelector(s)

const S = {
  cats: [],
  byCat: new Map(), // catId → category
  byDec: new Map(), // decId → {node, cat}
  selCat: '',
  selDec: null,
  /* 「显示详情」:false=脚本块截断 8 行 + 按钮;true=全文 + 完整字段 */
  decDetail: false,
  q: '',
  /* ── 来源筛选 ──
   * src 语义与 focus 页一致:'' = 全部,'base' = 仅原版,'mod' = 仅模组,其余 = 来源名。
   * 决议总量不大(vanilla 数百项),但后端已支持 ?src=,统一走后端口径,
   * 免得前端再实现一遍分类→成员的来源归属推断。 */
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

/* PROGRESS_V1(2026-10-07):钩在 api() 内部,不包装全局函数。
 * 包装全局 api() 有两个坑:①必须插在首次调用之前,插在文件末尾时
 * 首次调用早已跑完,包装完全无效;②重绑定全局标识符容易与文件里
 * 已有的 const/let 同名撞车(SyntaxError: Identifier 'T' has already
 * been declared,整页脚本不执行)。函数体内加钩子没有这两个问题。*/
async function api(u, opt) {
  const r = await fetch(u, opt)
  const d = await r.json()
  // 只有「真在构建」(ready:false + busy:true)才拉进度条,普通查询不受影响
  if (d && d.ready === false && d.busy && window.Progress) {
    if (!api._pg) { api._pg = true; window.Progress.start(`正在构建决议图…`) }
  } else if (d && d.ready && window.Progress && api._pg) {
    api._pg = false
    window.Progress.done()
  }
  return d
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/* 图标加载已抽到公共件 /tex.js。
 * 原来这里抄了一份和 dlc.js 一模一样的 loadTex + IntersectionObserver,
 * 但那份把 sprite 名(GFX_xxx)直接塞进 /api/tex?id=,而后端只认 tN 内部 id
 * → 全 404,图标一片空白。现在统一走 Tex.mount()。 */

/* ── 来源筛选器(与 focus.html/js 同一套语义与视觉) ── */
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
  /* ★ OWNERSHIP_V1:三态归属。同名决议由模组【整份替换】(不是多一份),
   *   所以"模组改写"这类条目的总数里只计一次,见 statChip 的生效口径。 */
  const os = S.originStats || {}
  const ow = S.own || {}
  add('', `全部 (${S.totalDecisions})`, '同名决议只列最终生效的那一份')
  sep('── 内容归属 ──')
  add('vanilla', `原版 (${os.vanilla ?? ow.vanilla ?? 0})`, '原版决议,模组没有同名覆盖它')
  add('override', `模组改写 (${os.overridden ?? ow.override ?? 0})`, '原版有同名决议,被模组整份替换')
  add('new', `模组新增 (${os.modNew ?? ow.new ?? 0})`, '原版没有这条决议,模组新增 —— 与原版共存')
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
  if (base) parts.push(`原版 ${base}`)
  if (mods) parts.push(`模组 ${mods}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : '来源:' + srcLabel(S.src)
  el.textContent = parts.length ? `来源 ${parts.join(' / ')}${hint ? ' · ' + hint : ''}` : ''
  el.title = hint
}

/** 卡片来源判定(与后端 ?src= 一致) */
function decVisible(d) {
  const s = S.src
  if (!s) return true
  if (s === 'base') return d.base
  if (s === 'mod') return !d.base
  /* ★ 三态:优先用后端下发的 own,旧字段兜底 */
  if (s === 'vanilla') return Own.of(d) === 'vanilla'
  if (s === 'override' || s === 'overridden') return Own.of(d) === 'override'
  if (s === 'new' || s === 'modNew') return Own.of(d) === 'new'
  return d.rootName === s
}

/* ── 加载 ── */
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function loadGraph() {
  const d = await api('/api/decisions/graph' + (S.src ? '?src=' + encodeURIComponent(S.src) : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : '失败:' + d.error
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
  S.sources = d.sources || []
  S.sourceStats = d.sourceStats || {}
  S.originStats = d.originStats || {}
  S.own = d.own || null
  S.totalDecisions = d.stats.nodes
  const shown = d.stats.shownDecisions ?? d.stats.nodes
  $('#statChip').textContent =
    shown < S.totalDecisions
      ? `${shown}/${S.totalDecisions} 决议(来源筛选中)· ${d.stats.shownCategories ?? d.stats.categories} 分类`
      : `${d.stats.categories} 分类 / ${d.stats.nodes} 决议`
  // ★ 生效集口径:总数 = 原版 + 模组改写 + 模组新增(同名只算一次)
  $('#statChip').title = Own.statsLine(S.own)
  buildSrcSel()
  srcSummary()
  const sel = $('#catSel')
  sel.innerHTML = '<option value="">全部分类</option>'
  for (const c of S.cats) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = `${c.id} (${c.decisions.length})`
    sel.appendChild(o)
  }
  if (S.selCat && !S.byCat.has(S.selCat)) S.selCat = ''
  if (S.selCat) sel.value = S.selCat
  renderCatList()
  renderCards()
}

function renderCatList() {
  const q = $('#q').value.trim().toLowerCase()
  const list = q ? S.cats.filter((c) => c.id.toLowerCase().includes(q)) : S.cats
  $('#catCount').textContent = `${list.length}/${S.cats.length}`
  const box = $('#catList')
  box.innerHTML = ''
  for (const c of list.slice(0, 500)) {
    // 分类徽标用后端给的归属三态 —— 它按 catDefs 全链判定,比"成员里最大 root"准
    const ownCls = Own.CLS[Own.of(c)]
    const ownTxt = Own.label(c)
    const el = document.createElement('div')
    el.className = 'item' + (S.selCat === c.id ? ' on' : '')
    // ★ 右键要按 id 取分类对象,不能按 DOM 文本反查(文本是本地化的)
    el.dataset.id = c.id
    el.__obj = c
    el.innerHTML =
      `<span>${esc(c.id)}</span> ` +
      `<span class="src ${ownCls}">${ownTxt}</span> ` +
      `<span class="tag">${c.decisions.length}</span>`
    el.title = `${c.id}\n归属: ${ownTxt}\n${Own.hint(c)}`
    el.onclick = () => {
      S.selCat = c.id
      $('#catSel').value = c.id
      renderCatList()
      renderCards()
    }
    box.appendChild(el)
  }
}

/* ── 卡片墙 ── */
function currentDecisions() {
  const q = $('#q').value.trim().toLowerCase()
  if (S.selCat) {
    const c = S.byCat.get(S.selCat)
    if (!c) return []
    return q ? c.decisions.filter((d) => d.id.toLowerCase().includes(q)) : c.decisions
  }
  // 未选分类:跨全部分类搜索
  let all = [...S.byDec.values()].map((x) => x.node)
  if (q) all = all.filter((d) => d.id.toLowerCase().includes(q))
  return all
}

function renderCards() {
  const grid = $('#grid')
  const decs = currentDecisions()
  const mods = decs.filter((d) => !d.base).length
  $('#cardSum').innerHTML = decs.length
    ? `<span>${decs.length} 个决议 · 模组 ${mods} / 原版 ${decs.length - mods}${
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
  /* PERF_V2:3000+ 决议一次建完会让主线程卡住几百毫秒。
   * 改成分批:先 120 张,滚到底再追加。makeOne 与原循环体一致。 */
  Incr.mount(grid, decs, makeCard, { batch: 120 })
}

function makeCard(n) {
  const card = document.createElement('div')
  card.className = 'card' + (S.selDec === n.id ? ' on' : '') + (n.base ? '' : ' frommod')
  card.dataset.id = n.id
  // ★ 右键菜单的数据源(挂对象,不反查 DOM 文本)
  card.__obj = n
  const chips = []
  if (n.cost) chips.push(`<span class="mini c">花费 ${n.cost}</span>`)
  if (n.days) chips.push(`<span class="mini d">${n.days}天</span>`)
  const flags = []
  if (n.hasAvailable) flags.push('avail')
  if (n.hasAllow) flags.push('allow')
  if (n.hasEffect) flags.push('eff')
  if (n.hasVisible) flags.push('vis')
  if (n.hasComplete) flags.push('comp')
  if (flags.length) chips.push(`<span class="mini f">${flags.join('·')}</span>`)
  /* ★ OWNERSHIP_V1:三态徽标统一由 Own 生成(不再自己判 origin/overridden) */
  if (Own.of(n) !== 'vanilla') chips.push(Own.badge(n))
  if (!n.base) chips.push(`<span class="mini m">${esc(srcLabel(n.rootName))}</span>`)
  card.innerHTML = `
      <img class="ic" data-tex="${esc(n.tex || '')}" alt="">
      <div class="nm">${esc(n.id)}</div>
      <div class="mt">${chips.join('')}</div>`
  card.title =
    `${n.id}\n归属: ${Own.label(n)}\n${Own.hint(n)}` +
    `\n最终生效: ${n.rootName}(${n.base ? '基础游戏' : '模组'})\n位置: ${n.file}:${n.line}`
  card.onclick = () => selectDec(n.id)
  // Shift+F10(键盘等价右键)靠这个钩子;事件的 target 可能落在卡片内的
  // img/div 上,所以用 closest 回溯到卡片本身。
  card.ctxItems = (ev) => {
    const el = (ev && ev.target && ev.target.closest) ? ev.target.closest('.card') : card
    const d = el && el.__obj ? el.__obj : n
    return window.Ctx ? Ctx.sourceItems({ root: d.root, rootName: d.rootName, file: d.file, line: d.line, id: d.id, loc: d.loc }) : null
  }
  const img = card.querySelector('img.ic')
  // 统一交给公共加载器:命中缓存直接贴,否则挂观察器
  if (n.tex) Tex.mount(card)
  else img.style.background = 'var(--line2)'
  return card
}

function selectDec(id) {
  S.selDec = id
  for (const c of document.querySelectorAll('.card')) c.classList.toggle('on', c.dataset.id === id)
  const rec = S.byDec.get(id)
  if (!rec) return
  const n = rec.node
  // ★ 脚本块:原先只显示一个标签(hasAvailable 等),看不到条件与效果内容。
  //   字段名按 vanilla 实测(5467 决议):没有 effect 块,效果类是
  //   complete_effect / remove_effect / hidden_effect / modifier,条件类另有 target_trigger / ai_will_do。
  const condBlocks = [
    ['available · 出现条件', n.availableRaw],
    ['allowed · 允许条件', n.allowRaw],
    ['visible · 可见条件', n.visibleRaw],
    ['target_trigger · 目标条件', n.targetTriggerRaw],
    ['ai_will_do · AI 意愿', n.aiWillDoRaw],
  ]
  const effBlocks = [
    ['complete_effect · 完成效果', n.completeRaw],
    ['modifier · 修正器', n.modifierRaw],
    ['remove_effect · 移除效果', n.removeEffectRaw],
    ['hidden_effect · 隐藏效果', n.hiddenEffectRaw],
  ]
  const hasCond = condBlocks.some(([, t]) => t)
  const hasEff = effBlocks.some(([, t]) => t)
  const flags = []
  if (n.hasAvailable) flags.push('available')
  if (n.hasAllow) flags.push('allow')
  if (n.hasVisible) flags.push('visible')
  if (n.hasComplete) flags.push('complete_effect')
  if (n.hasEffect) flags.push('effect')
  const btnId = 'decDetailBtn'
  $('#insp').innerHTML = `
    <div class="kv"><b>id</b><span>${esc(n.id)}</span></div>
    <div class="kv"><b>分类</b><span>${esc(rec.cat)}</span></div>
    <div class="kv"><b>内容归属</b><span>${
      n.origin === 'mod'
        ? '<span class="src new">模组新增</span> 原版没有这个决议'
        : n.overridden
          ? `<span class="src ovr">模组改写</span> 原版有,现由 ${esc(srcLabel(n.rootName))} 生效`
          : '<span class="src base">基础游戏</span>'
    }</span></div>
    <div class="kv"><b>生效来源</b><span><span class="src ${n.base ? 'base' : 'mod'}">${esc(srcLabel(n.rootName))}</span> ${n.base ? '基础游戏' : '模组'}</span></div>
    <div class="kv"><b>图标</b><span>${esc(n.icon) || '—'}</span></div>
    <div class="kv"><b>花费</b><span>${n.cost}</span></div>
    <div class="kv"><b>移除天数</b><span>${n.days}</span></div>
    <div class="kv"><b>位置</b><span>${esc(n.rootName + ':' + n.file)}:${n.line}</span></div>
    ${
      hasCond
        ? `<h4>条件 <span style="font-weight:400;color:var(--ink3)">${flags.slice(0, 3).map(esc).join(' / ') || ''}</span></h4>` +
          condBlocks.map(([t, txt]) => (txt ? decBlock(t, txt, S.decDetail) : '')).join('')
        : ''
    }
    ${
      hasEff
        ? '<h4>效果</h4>' + effBlocks.map(([t, txt]) => (txt ? decBlock(t, txt, S.decDetail) : '')).join('')
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
  const body = !full && lines.length > 8 ? lines.slice(0, 8).join('\n') + `\n…(共 ${lines.length} 行)` : text
  return `<div class="kv blk"><b>${esc(title)}</b><pre class="raw">${esc(body)}</pre></div>`
}

/** 显示详情:列出决议节点上所有字段(raw),便于排查来源 / 覆盖 / 类型细节 */
function decDump(n) {
  const skip = new Set([
    'defs',
    'hasAvailable',
    'hasAllow',
    'hasEffect',
    'hasVisible',
    'hasComplete',
    // 脚本块原文已由 decBlock 分组展示,dump 里不再重复
    'availableRaw',
    'allowRaw',
    'visibleRaw',
    'completeRaw',
    'removeEffectRaw',
    'hiddenEffectRaw',
    'modifierRaw',
    'targetTriggerRaw',
    'aiWillDoRaw',
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
  renderCatList()
  renderCards()
})
$('#catSel').addEventListener('change', (e) => {
  S.selCat = e.target.value
  renderCatList()
  renderCards()
})
$('#srcSel').addEventListener('change', async (e) => {
  S.src = e.target.value
  S.selDec = null
  $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个决议</div>'
  await loadGraph()
})

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

/* ══════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V2,2026-10-05)
 *
 * 后端 /api/decisions/graph 已下发 file/line/origin/overridden/rootName,
 * 所以"定位源码 / 复制 id / 复制路径"这些标准动作直接复用 Ctx.sourceItems。
 * 数据靠 el.__obj 现取 —— **不按 DOM 文本反查**:卡片上的文字是 id,
 * 改显示名或换语言就会失配(doctrines 页踩过这个坑)。
 * ══════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire) return
  CtxWire.attach({
    page: 'decisions',
    on: [
      /* 决议卡片墙 —— 数据已在 makeCard 挂到 el.__obj */
      {
        host: '#grid',
        sel: '.card',
        obj: (el) => {
          const n = el.__obj
          if (!n) return null
          return { root: n.root, rootName: n.rootName, file: n.file, line: n.line, id: n.id, loc: n.loc, _n: n }
        },
        items: (o) => {
          const n = o._n
          const catId = S.byDec.get(n.id)?.cat
          return [
            n.cost ? { label: '复制花费(' + n.cost + ')', k: '⧉', act: () => Ctx.copy(String(n.cost), '') } : null,
            n.days ? { label: '复制天数(' + n.days + ')', k: '⧉', act: () => Ctx.copy(String(n.days), '') } : null,
            {
              label: '只看这个分类',
              k: '→',
              act: () => { S.selCat = catId || ''; loadGraph() },
            },
          ].filter(Boolean)
        },
      },
      /* 左侧分类列表 —— 数据已在 renderCatList 挂到 el.__obj */
      {
        host: '#catList',
        sel: '.item',
        obj: (el) => (el.__obj ? { id: el.__obj.id, rootName: '决议分类', _c: el.__obj } : null),
        items: (o) => [
          { label: '复制分类 id', k: '⧉', act: () => Ctx.copy(o.id, '') },
          {
            label: o.id === S.selCat ? '取消筛选' : '只看这个分类',
            k: '→',
            act: () => { S.selCat = o.id === S.selCat ? '' : o.id; loadGraph() },
          },
        ],
      },
    ],
    keys: [
      { id: 'find.search', run: () => { const q = $('#q'); if (q) q.focus() }, desc: '聚焦搜索框', group: '查找' },
      ...CtxWire.commonKeys(() => (S.selDec ? { id: S.selDec } : null), {
        label: '决议',
        clear: () => { S.selDec = null; renderCards() },
      }),
      { id: 'sel.clear', desc: '取消选择', group: '选中', run: () => { S.selDec = null; renderCards(); const i = $('#insp'); if (i) i.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个决议</div>' } },
    ],
  })
}
wireCtxAndKeys()

loadGraph()
