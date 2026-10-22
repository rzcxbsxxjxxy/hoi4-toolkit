/* 国策树可视化:预览 + 拖拽 + 无损回写
 *
 * 两个性能要点:
 *  1) 一棵树可以有 900+ 个国策,图标是逐张 PNG(b64)—— 全部请求会打爆浏览器。
 *     所以图标按"视口内才加载"处理,配并发上限与缓存。
 *  2) 坐标换算:文件里的 x/y 有 94% 是 relative_position_id 的相对偏移,
 *     后端已展开成绝对坐标(ax/ay)。画布拖拽的是绝对坐标,回写时由后端换算回相对值。
 */
const $ = (s) => document.querySelector(s)
const SVGNS = 'http://www.w3.org/2000/svg'

/* ── 坐标比例:一个国策图标约 66px,水平一格约 24px,垂直一格约 90px ── */
const XU = 24
const YU = 90
const NW = 62
const NH = 62

const S = {
  tree: null,
  nodes: [],
  totalNodes: 0,
  byId: new Map(),
  edges: [],
  bbox: null,
  sel: null,
  /** shortcut = { name target scroll_wheel_factor } —— 树内跳转点(游戏侧左栏快捷标签) */
  shortcuts: [],
  pending: new Map(), // id → {x,y} 绝对坐标
  zoom: 1,
  tx: 0,
  ty: 0,
  icons: new Map(), // tex → {url, w, h}
  loading: new Set(),
  showName: false,
  issues: [],
  /* ── 来源筛选 ──
   * src 语义(与后端 ?src= 一致):'' = 全部,'base' = 仅原版,'mod' = 仅模组,
   * 其余 = 具体来源名。同一份状态同时管树列表与画布节点,避免两边口径不一致。 */
  sources: [], // [{i,name,path,base}]
  sourceStats: {}, // name → {trees, nodes}
  originStats: {}, // {vanilla, modNew, overridden}
  src: '',
  totalTrees: 0,
  /* ── allow_branch 显隐模拟(参考 HOI4 Mod Utilities 国策分析)──
   * completed:模拟「已完成的国策」;★ 方向:n.allow_branch = { has_completed_focus = X }
   *   表示【n 自己】要等 X 完成才显形(游戏里 allow_branch 不满足时整条分支不可见),
   *   所以 gatedBy 存 n.id → [X...]。任一 X 被模拟完成 → n 显形 → 采用 offset 坐标。
   * showHidden:强制画出被隐藏的分支(灰显),便于整体审阅。
   * useOffset:用 offset 条件偏移后的坐标(axOff/ayOff)而非主坐标。 */
  completed: new Set(),
  showHidden: false,
  useOffset: false,
  /** focusId → 【它自己】的 allow_branch 里要求先完成的 focus 列表(即本节点显形依赖谁) */
  gatedBy: new Map(),
  /** 检查器「显示详情」开关:展开节点的完整字段 */
  focusDetail: false,
}

const svg = $('#canvas')
const gRoot = document.createElementNS(SVGNS, 'g')
const gEdge = document.createElementNS(SVGNS, 'g')
const gNode = document.createElementNS(SVGNS, 'g')
gRoot.appendChild(gEdge)
gRoot.appendChild(gNode)
svg.appendChild(gRoot)

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
    if (!api._pg) { api._pg = true; window.Progress.start(`正在构建国策图…`) }
  } else if (d && d.ready && window.Progress && api._pg) {
    api._pg = false
    window.Progress.done()
  }
  return d
}

/* ── 来源筛选器 ──
 * 下拉结构:全部 / ── / 仅原版 / 仅模组 / ── / 每个来源(带树数)
 * 「原版 vs 模组」的判据是后端给的 base 标记(只读 root = 原版),前端不再猜路径。
 */
function srcLabel(name) {
  return name === 'vanilla' ? '基础游戏' : name
}
function buildSrcSel() {
  const sel = $('#srcSel')
  const cur = S.src
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
  /* ★ OWNERSHIP_V1:同名国策树由模组【整份替换】,所以只有三态,总数不重复计 */
  const os = S.originStats || {}
  const ow = S.own || {}
  add('', `全部 (${S.totalTrees} 树)`, '同名树只列最终生效的那一份')
  sep('── 内容归属 ──')
  add('vanilla', `原版 (${os.vanilla ?? ow.vanilla ?? 0} 树)`, '原版树,模组没有同名覆盖它')
  add('override', `模组改写 (${os.overridden ?? ow.override ?? 0} 树)`, '原版有同名树,被模组整份替换')
  add('new', `模组新增 (${os.modNew ?? ow.new ?? 0} 树)`, '原版没有这棵树,模组新增 —— 与原版共存')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  const mods = S.sources.filter((s) => !s.base)
  if (mods.length) {
    sep('──────────')
    for (const s of mods) {
      const st = S.sourceStats[s.name] || { trees: 0, nodes: 0 }
      add(s.name, `${srcLabel(s.name)} (${st.trees} 树 / ${st.nodes} 国策)`, s.path)
    }
  }
  sel.value = cur
}

const SRC_HINT = {
  '': '',
  vanilla: '原版树,模组没有同名覆盖它',
  override: '原版有同名树,被模组整份替换 —— 原版那份已失效',
  new: '模组新增的树(原版没有),与原版共存',
  base: '最终生效版本来自基础游戏',
  mod: '最终生效版本来自模组',
}
function srcSummary() {
  const el = $('#srcSum')
  if (!S.sources.length) return (el.textContent = '')
  const base = S.sources.filter((s) => s.base)
  const mods = S.sources.filter((s) => !s.base)
  const parts = []
  if (base.length) parts.push(`原版 ${base.length}`)
  if (mods.length) parts.push(`模组 ${mods.length}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : '来源:' + srcLabel(S.src)
  el.textContent = `来源 ${parts.join(' / ')}${hint ? ' · ' + hint : ''}`
  el.title = hint
}

/** 树列表按来源过滤(与后端 /api/focus/graph?src= 同一套判据) */
function treeVisible(t) {
  const s = S.src
  if (!s) return true
  if (s === 'base') return t.base
  if (s === 'mod') return !t.base
  /* ★ 三态:优先用后端下发的 own(旧字段兜底) */
  if (s === 'vanilla') return Own.of(t) === 'vanilla'
  if (s === 'override' || s === 'overridden') return Own.of(t) === 'override'
  if (s === 'new' || s === 'modNew') return Own.of(t) === 'new'
  return t.rootName === s
}

/* ── 树列表 ──
 * 树只有 448 项,一次性拉全量在本地过滤 —— 切换来源筛选器是瞬时的,不用等网络。
 * 画布节点相反(单棵树可达 900+、全量 43814),过滤必须交给后端做。
 */
let ALL = []
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function loadTrees() {
  const d = await api('/api/focus/graph')
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : '失败:' + d.error
    _retry++
    setTimeout(loadTrees, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  ALL = d.trees
  S.sources = d.sources || []
  S.sourceStats = d.sourceStats || {}
  S.originStats = d.originStats || {}
  S.own = d.own || null
  S.totalTrees = d.stats.unique
  /* ★ 生效集口径:unique 已经是"同名只算一次"的树数 */
  const chip = $('#statChip')
  if (chip) chip.title = Own.statsLine(S.own)
  buildSrcSel()
  srcSummary()
  renderTreeList()
}

function renderTreeList() {
  const q = $('#q').value.trim().toLowerCase()
  let list = S.src ? ALL.filter(treeVisible) : ALL
  if (q) list = list.filter((t) => t.id.toLowerCase().includes(q) || t.tags.some((x) => x.toLowerCase().includes(q)))
  $('#treeCount').textContent = `${list.length}/${ALL.length}`
  const box = $('#treeList')
  box.innerHTML = ''
  for (const t of list.slice(0, 400)) {
    const el = document.createElement('div')
    el.className = 'item' + (S.tree === t.id ? ' on' : '')
    // 右键菜单按 id 取树对象,不去猜 DOM 文本(改文案就会失配)
    el.dataset.treeId = t.id
    // ★ OWNERSHIP_V1:徽标统一走 Own —— 归属三态(原版/模组改写/模组新增)+ 生效来源
    const ownTxt = Own.label(t)
    const ownCls = Own.CLS[Own.of(t)]
    el.innerHTML =
      `<span>${esc(t.id)}</span> ` +
      `<span class="src ${ownCls}">${ownTxt}</span> ` +
      `<span class="src ${t.base ? 'base' : 'mod'}">${esc(srcLabel(t.rootName))}</span> ` +
      `<span class="tag">${esc(t.tags.join(',') || '—')} · ${t.nodes}</span>`
    el.title =
      `${t.id}\n归属: ${ownTxt} — ${Own.hint(t)}\n` +
      `最终生效: ${t.rootName}(${t.base ? '基础游戏' : '模组'})\n位置: ${t.rootName}:${t.file}` +
      (t.versions.length > 1 ? '\n覆盖链: ' + t.versions.map((v) => srcLabel(v.rootName)).join(' → ') : '')
    el.onclick = () => selectTree(t.id)
    box.appendChild(el)
  }
  const sel = $('#treeSel')
  sel.innerHTML = ''
  for (const t of list.slice(0, 400)) {
    const o = document.createElement('option')
    o.value = t.id
    o.textContent = t.id
    sel.appendChild(o)
  }
  if (S.tree) sel.value = S.tree
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

async function selectTree(id) {
  S.tree = id
  S.pending.clear()
  S.sel = null
  renderTreeList()
  const d = await api('/api/focus/tree?id=' + encodeURIComponent(id) + (S.src ? '&src=' + encodeURIComponent(S.src) : ''))
  if (!d.ready) return toast(d.error || '未就绪', true)
  if (d.error) return toast(d.error, true)
  S.nodes = d.nodes
  S.totalNodes = d.totalNodes ?? d.nodes.length
  S.edges = d.edges
  S.shortcuts = d.shortcuts || []
  S.bbox = d.bbox
  S.byId = new Map(S.nodes.map((n) => [n.id, n]))
  buildGating()
  updateBranchStat()
  /* 本地化:国策 id 就是本地化 key(实测 10948 个节点命中 10942 = 99.9%)。
     异步拉,拉完重绘 —— 别 await 阻塞首屏。 */
  Loc.load(S.nodes.map((n) => n.id)).then(() => {
    if (S.byId && S.nodes.length) {
      applyLoc()
      render()
    }
  })
  $('#pendChip').style.display = 'none'
  $('#btnSave').disabled = true
  render()
  fit()
  const t = d.tree
  const shown = S.nodes.length < S.totalNodes ? ` 显示 ${S.nodes.length}/${S.totalNodes}` : ''
  /* ★ OWNERSHIP_V1:三态归属统一走 Own(不再按 origin/overridden 手写) */
  const ownTxt = Own.label(t)
  const ownCls = Own.CLS[Own.of(t)]
  const srcTxt = t.base ? '基础游戏' : '模组 · ' + srcLabel(t.rootName)
  $('#hud').textContent =
    `${t.id} · [${ownTxt}/${srcTxt}] ${S.nodes.length} 国策${shown} · ${t.rootName}:${t.file}` +
    (t.versions.length > 1 ? ` · 被 ${t.versions.length} 处定义覆盖` : '')
  $('#insp').innerHTML = `<div style="padding:6px 11px">
    <div class="kv"><b>树</b><span>${esc(t.id)}</span></div>
    <div class="kv"><b>国家</b><span>${esc(t.tags.join(', ') || '—')}</span></div>
    <div class="kv"><b>内容归属</b><span><span class="src ${ownCls}">${ownTxt}</span> <span style="font-size:11px">${esc(Own.hint(t))}</span></span></div>
    <div class="kv"><b>生效来源</b><span><span class="src ${t.base ? 'base' : 'mod'}">${esc(srcLabel(t.rootName))}</span> ${t.base ? '基础游戏' : '模组'}</span></div>
    <div class="kv"><b>文件</b><span>${esc(t.rootName + ':' + t.file)}</span></div>
    <div class="kv"><b>节点</b><span>${S.nodes.length}${S.nodes.length < S.totalNodes ? ` / ${S.totalNodes}(来源筛选中)` : ''}(含共享引用 ${t.shared})</span></div>
    ${t.versions.length > 1 ? `<div class="kv"><b>覆盖链</b><span>${t.versions.map((v) => esc(srcLabel(v.rootName))).join(' → ')}</span></div>` : ''}
    ${t.inlayWindows.length ? `<div class="kv"><b>内嵌窗</b><span>${esc(t.inlayWindows.join(', '))}</span></div>` : ''}
    ${S.shortcuts.length ? `<h4>快捷跳转 ${S.shortcuts.length}</h4>${S.shortcuts.map((s) => `<div class="kv scrow${s.inTree ? '' : ' bad'}" data-target="${esc(s.target)}"><b>${esc(s.name)}</b><span>→ ${esc(s.target)}${s.factor !== undefined ? ` · 缩放 ${s.factor}` : ''}${s.inTree ? '' : ' <em>目标不在本树</em>'}</span></div>`).join('')}` : ''}
  </div>`
  $('#lintList').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">未体检</div>'
  // shortcut 行可点:跳到目标国策(target 不在本树时按钮禁用样式已标 .bad)
  for (const row of document.querySelectorAll('#insp .scrow[data-target]')) {
    row.onclick = () => {
      const id = row.dataset.target
      const n = S.byId.get(id)
      if (!n) return toast(`${id} 不在本树(来源筛选或数据错误)`, true)
      S.sel = id
      S.pending.delete(id)
      applySel()
      showInsp(n)
      centerOn(id)
    }
  }
}

/* ── 渲染 ── */
function px(n) {
  return { x: n.x * XU, y: n.y * YU }
}

/** 当前生效坐标:优先用户拖拽(pending),其次条件偏移(offset),否则主坐标。
 *  ★ 联动 allow_branch:当一个门控国策被「模拟已完成」、本节点因此显形时,
 *    一并采用它的条件偏移坐标(offset),与游戏"分支在条件下跳到偏移位"一致。 */
function coordOf(n) {
  const p = S.pending.get(n.id)
  if (p) return p
  const revealed = gatedRevealed(n)
  const useOff = (S.useOffset || revealed) && n.xOff != null
  return useOff ? { x: n.xOff, y: n.yOff } : { x: n.x, y: n.y }
}
/** 本节点是否因某门控国策被模拟完成而显形(allow_branch 门控) */
function gatedRevealed(n) {
  const gates = S.gatedBy.get(n.id)
  return !!(gates && gates.length && gates.some((g) => S.completed.has(g)))
}

/** 从本树节点建「受控关系」:allow_branch = { has_completed_focus = X } 表示【本节点 n 要等 X 完成才显形】,
 *  所以是 n 受控于 X → gatedBy[n.id] = [X, ...]。(★ 方向别搞反:n 是声明 allow_branch 的那个焦点) */
function buildGating() {
  S.gatedBy = new Map()
  for (const n of S.nodes) {
    const br = n.branch
    if (!br || !br.length) continue
    S.gatedBy.set(n.id, br.slice())
  }
}

/** 一个国策的可见状态:{ v:是否画出, f:是否灰显(因 showHidden 强显) } */
function nodeVisState(n) {
  const gates = S.gatedBy.get(n.id)
  if (!gates || !gates.length) return { v: true, f: false }
  if (S.showHidden) return { v: true, f: true }
  // 任一门控国策被模拟「已完成」→ 该分支显形
  const opened = gates.some((g) => S.completed.has(g))
  return { v: opened, f: false }
}

/** 更新「隐藏分支」计数读数 */
function updateBranchStat() {
  const el = document.getElementById('bxStat')
  if (!el) return
  let hidden = 0
  for (const n of S.nodes) if (!nodeVisState(n).v) hidden++
  el.textContent = hidden ? `隐藏分支 ${hidden} / ${S.nodes.length}` : `分支全显 ${S.nodes.length}`
}

/** 文本截断(SVG 里没法靠 CSS 省略号,超长会糊成一片) */
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * 本地化重绘入口。
 *
 * ★ 只重绘【文本与 tooltip】,不动布局:节点坐标/连线/拖拽状态全部保持。
 *   所以换语言时不会出现"画布跳一下"或"拖到一半的国策被重置"。
 */
function applyLoc() {
  render()
  // 检查器里如果正选着节点,顺带刷新标题
  const n = S.sel ? S.byId.get(S.sel) : null
  if (n) showInsp(n)
}

function render() {
  gNode.innerHTML = ''
  gEdge.innerHTML = ''
  const pos = new Map()
  const faded = new Set()
  for (const n of S.nodes) {
    const st = nodeVisState(n)
    if (!st.v) continue // 被 allow_branch 隐藏且未模拟完成 → 不画
    pos.set(n.id, coordOf(n))
    if (st.f) faded.add(n.id)
  }
  for (const e of S.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const p = document.createElementNS(SVGNS, 'path')
    const x1 = a.x * XU + NW / 2
    const y1 = a.y * YU + NH
    const x2 = b.x * XU + NW / 2
    const y2 = b.y * YU
    // 略微弯曲的折线(圆角肘形)—— 全站连线统一风格,实现见 /edgepath.js
    // axis='v':国策树是"父在上子在下"的竖向流向,强制竖向肘形,弯曲方向恒定正确
    p.setAttribute('d', edgePathD(x1, y1, x2, y2, 12, 'v'))
    p.setAttribute('class', 'edge ' + e.kind + (faded.has(e.from) || faded.has(e.to) ? ' ghost' : ''))
    p.dataset.from = e.from
    p.dataset.to = e.to
    gEdge.appendChild(p)
  }
  for (const n of S.nodes) {
    if (!pos.has(n.id)) continue
    const c = pos.get(n.id)
    const g = document.createElementNS(SVGNS, 'g')
    g.setAttribute('class', 'node' + (n.joint ? ' joint' : '') + (n.kind === 'shared' ? ' shared' : '') + (n.xOff != null ? ' has-offset' : '') + (faded.has(n.id) ? ' branch-hidden' : ''))
    g.dataset.id = n.id
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('class', 'box')
    r.setAttribute('x', c.x * XU)
    r.setAttribute('y', c.y * YU)
    r.setAttribute('width', NW)
    r.setAttribute('height', NH)
    r.setAttribute('rx', 5)
    g.appendChild(r)
    const img = document.createElementNS(SVGNS, 'image')
    img.setAttribute('x', c.x * XU + 1)
    img.setAttribute('y', c.y * YU + 1)
    img.setAttribute('width', NW - 2)
    img.setAttribute('height', NH - 2)
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    g.appendChild(img)
    // 来源角标:左上角小三角。绿=模组改写(原版有,被改了),蓝=模组新增(原版没有)。
    // 原版节点不画 —— 900 个框全带角标反而看不清。
    if (n.origin === 'mod') {
      const mk = document.createElementNS(SVGNS, 'path')
      mk.setAttribute('class', 'modmark new')
      mk.setAttribute('d', `M${c.x * XU} ${c.y * YU} L${c.x * XU + 11} ${c.y * YU} L${c.x * XU} ${c.y * YU + 11} Z`)
      g.appendChild(mk)
    } else if (n.overridden) {
      const mk = document.createElementNS(SVGNS, 'path')
      mk.setAttribute('class', 'modmark ovr')
      mk.setAttribute('d', `M${c.x * XU} ${c.y * YU} L${c.x * XU + 11} ${c.y * YU} L${c.x * XU} ${c.y * YU + 11} Z`)
      g.appendChild(mk)
    }
    const ti = document.createElementNS(SVGNS, 'title')
    ti.textContent =
      n.origin === 'mod'
        ? `${n.id} — 模组新增 · ${n.rootName}`
        : n.overridden
          ? `${n.id} — 原版国策,被 ${n.rootName} 改写`
          : `${n.id} — 基础游戏`
    /* 本地化:有译文就显示译文,没有保留 id(用户 2026-10 定的默认英文) */
    const locTxt = Loc.text(n.id).split('\n')[0]
    if (locTxt) ti.textContent = `${locTxt}\n${ti.textContent}`
    g.appendChild(ti)
    if (S.showName) {
      const t = document.createElementNS(SVGNS, 'text')
      t.setAttribute('x', c.x * XU + NW / 2)
      t.setAttribute('y', c.y * YU + NH + 10)
      t.setAttribute('text-anchor', 'middle')
      /* 有译文显示译文(截断),没有则退回去前缀的 id —— 老行为不变 */
      t.textContent = locTxt ? truncate(locTxt, 22) : n.id.replace(/^[A-Z0-9]+_/, '')
      t.appendChild(document.createElementNS(SVGNS, 'title')).textContent = locTxt
      g.appendChild(t)
    }
    g.addEventListener('pointerdown', (ev) => startDrag(ev, n))
    /* Shift+F10(键盘等价右键):把菜单挂在元素上,Keys.ctxKey() 直接取用。
       画布节点是 SVG <g>,不是 HTMLElement,拿不到 dataset 之外的挂载点,
       所以用 JS 私有属性 —— 每次 render() 重建时自然失效,不会指向旧节点。 */
    g.ctxItems = () => nodeMenuItems(n)
    gNode.appendChild(g)
  }
  applySel()
  lazyIcons()
}

function applySel() {
  for (const g of gNode.children) {
    const id = g.dataset.id
    g.classList.toggle('sel', S.sel === id)
    g.classList.toggle('pend', S.pending.has(id))
  }
  for (const p of gEdge.children) {
    p.classList.toggle('hot', S.sel && (p.dataset.from === S.sel || p.dataset.to === S.sel))
  }
}

function applyTransform() {
  gRoot.setAttribute('transform', `translate(${S.tx} ${S.ty}) scale(${S.zoom})`)
  $('#zl').textContent = Math.round(S.zoom * 100) + '%'
  lazyIcons()
}

/* ── 图标:只加载视口内的 ── */
let lazyTimer = null
function lazyIcons() {
  clearTimeout(lazyTimer)
  lazyTimer = setTimeout(doLazyIcons, 160)
}
async function doLazyIcons() {
  const st = $('#stage').getBoundingClientRect()
  const want = []
  for (const n of S.nodes) {
    if (!n.tex || S.icons.has(n.tex)) continue
    const c = coordOf(n)
    const sx = c.x * XU * S.zoom + S.tx
    const sy = c.y * YU * S.zoom + S.ty
    const w = NW * S.zoom
    const h = NH * S.zoom
    if (sx + w < -200 || sx > st.width + 200 || sy + h < -200 || sy > st.height + 200) continue
    want.push(n)
  }
  // 并发上限,避免一次性打出上百个请求
  const batch = want.slice(0, 24)
  await Promise.all(batch.map((n) => loadIcon(n.tex)))
  paintIcons()
  if (want.length > batch.length) lazyIcons()
}
async function loadIcon(tex) {
  if (!tex || S.icons.has(tex) || S.loading.has(tex)) return
  S.loading.add(tex)
  try {
    const d = await api('/api/tex?id=' + encodeURIComponent(tex))
    if (d.png) S.icons.set(tex, { url: 'data:image/png;base64,' + d.png })
    else S.icons.set(tex, { url: null })
  } catch {
    S.icons.set(tex, { url: null })
  }
  S.loading.delete(tex)
}
function paintIcons() {
  for (const g of gNode.children) {
    const n = S.byId.get(g.dataset.id)
    if (!n || !n.tex) continue
    const ic = S.icons.get(n.tex)
    if (!ic || !ic.url) continue
    const img = g.querySelector('image')
    if (img && img.getAttribute('href') !== ic.url) img.setAttribute('href', ic.url)
  }
}

/* ── 拖拽 ── */
let drag = null
function startDrag(ev, n) {
  ev.preventDefault()
  ev.stopPropagation()
  S.sel = n.id
  applySel()
  showInsp(n)
  const st = $('#stage').getBoundingClientRect()
  drag = {
    n,
    ox: ev.clientX - st.left,
    oy: ev.clientY - st.top,
    base: S.pending.get(n.id) ?? { x: n.x, y: n.y },
    moved: false,
  }
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', endDrag)
}
function onDrag(ev) {
  if (!drag) return
  const st = $('#stage').getBoundingClientRect()
  const dx = (ev.clientX - st.left - drag.ox) / S.zoom / XU
  const dy = (ev.clientY - st.top - drag.oy) / S.zoom / YU
  if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02 && !drag.moved) return
  drag.moved = true
  const nx = Math.round(drag.base.x + dx)
  const ny = Math.round(drag.base.y + dy)
  S.pending.set(drag.n.id, { x: nx, y: ny })
  const g = gNode.querySelector(`[data-id="${cssEsc(drag.n.id)}"]`)
  if (g) {
    const r = g.querySelector('rect')
    r.setAttribute('x', nx * XU)
    r.setAttribute('y', ny * YU)
    const img = g.querySelector('image')
    img.setAttribute('x', nx * XU + 1)
    img.setAttribute('y', ny * YU + 1)
    const t = g.querySelector('text')
    if (t) {
      t.setAttribute('x', nx * XU + NW / 2)
      t.setAttribute('y', ny * YU + NH + 10)
    }
    g.classList.add('pend')
  }
  updateEdgesFor(drag.n.id)
  refreshPend()
}
function updateEdgesFor(id) {
  for (const p of gEdge.children) {
    if (p.dataset.from !== id && p.dataset.to !== id) continue
    const a = S.pending.get(p.dataset.from) ?? S.byId.get(p.dataset.from)
    const b = S.pending.get(p.dataset.to) ?? S.byId.get(p.dataset.to)
    if (!a || !b) continue
    const x1 = a.x * XU + NW / 2
    const y1 = a.y * YU + NH
    const x2 = b.x * XU + NW / 2
    const y2 = b.y * YU
    p.setAttribute('d', edgePathD(x1, y1, x2, y2, 12, 'v'))
  }
}
function endDrag() {
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', endDrag)
  if (drag && drag.moved) lazyIcons()
  drag = null
}
function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&')
}
function refreshPend() {
  const n = S.pending.size
  const c = $('#pendChip')
  c.style.display = n ? 'inline-flex' : 'none'
  c.textContent = `${n} 处待保存`
  c.className = 'chip hot'
  $('#btnSave').disabled = !n
}

/* ── 检查器 ── */
function showInsp(n) {
  const pend = S.pending.get(n.id)
  /* 标题与描述:key = id(实测 99.9% 命中)。没有译文就不显示这两行,不占位。 */
  const title = Loc.text(n.id).split('\n')[0]
  const desc = (Loc.hit(n.id) || {}).value
  const descText = desc && desc.indexOf('\n') > 0 ? desc.slice(desc.indexOf('\n') + 1) : ''
  $('#insp').innerHTML = `
    <button id="inspDetailBtn" class="dbtn">${S.focusDetail ? '▾ 收起详情' : '▸ 显示详情'}</button>
    ${title ? `<div class="kv"><b>标题</b><span>${esc(title)}</span></div>` : ''}
    <div class="kv"><b>id</b><span>${esc(n.id)}</span></div>
    ${descText ? `<div class="kv" style="flex-direction:column;align-items:stretch"><b style="width:auto">描述</b><span style="white-space:pre-wrap;color:var(--ink2)">${esc(truncate(descText, 400))}</span></div>` : ''}
    <div class="kv"><b>类型</b><span>${n.kind === 'focus' ? '国策' : n.kind === 'shared' ? '共享' : '联合'}${n.dynamic ? ' · 动态' : ''}${n.continuous ? ' · 连续' : ''}</span></div>
    <div class="kv"><b>图标</b><span>${esc(n.icon) || '—'}</span></div>
    <div class="kv"><b>成本</b><span>${n.cost}</span></div>
    <div class="kv"><b>来源</b><span>${Own.badge(n)} ${esc(srcLabel(n.rootName))}${
      (n.defs || []).length > 1
        ? ' <span style="color:var(--ink3)">同名定义 ' + (n.defs || []).length + ' 处,最后一个生效</span>'
        : ''
    }</span></div>
    <div class="kv"><b>坐标</b><span>(${n.x}, ${n.y})${pend ? ` → <b style="color:var(--warn)">(${pend.x}, ${pend.y})</b>` : ''}</span></div>
    <div class="kv"><b>相对</b><span>${n.rel ? esc(n.rel) : '绝对坐标'}${n.rel ? ` (偏移 ${n.rx}, ${n.ry})` : ''}</span></div>
    <div class="kv"><b>位置</b><span>${esc(n.rootName + ':' + n.file)}:${n.line}</span></div>
    ${kvBlock('available · 出现条件', n.available)}
    ${kvBlock('ai_will_do · AI 完成意愿', n.aiWillDo)}
    ${kvBlock('completion_reward · 完成奖励', n.completionReward)}
    ${kvBlock('search_filters · 搜索过滤', n.searchFilters)}
    ${kvBlock('bypass · 跳过条件', n.bypass)}
    ${
      n.xOff != null
        ? `<div class="kv"><b>条件偏移</b><span>主坐标 (${n.x}, ${n.y}) → 偏移 (${n.xOff}, ${n.yOff})${
            n.offsetRaw ? '（触发条件见下方 offset 块）' : ''
          }</span></div>${kvBlock('offset · 条件偏移', n.offsetRaw)}`
        : ''
    }
    ${n.prereq.length ? `<h4>前置 ${n.prereq.length}</h4>${n.prereq.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
    ${n.mutex.length ? `<h4>互斥 ${n.mutex.length}</h4>${n.mutex.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
    ${n.branch && n.branch.length ? `
      <h4>allow_branch · 本国策显形需先完成 ${n.branch.length}</h4>
      ${n.branch.map((b) => `<div class="kv"><span>${esc(b)}</span></div>`).join('')}` : ''}
    ${kvBlock('allow_branch · 分支显形条件', n.branchRaw)}
    <label class="bx" style="display:flex;gap:5px;align-items:center;margin:5px 0 2px">
      <input type="checkbox" id="bxDone" ${S.completed.has(n.id) ? 'checked' : ''}>
      模拟已完成此国策(勾上会让依赖它的分支显形)
    </label>
    ${S.gatedBy && S.gatedBy.get(n.id) && S.gatedBy.get(n.id).length ? `
      <div class="kv"><b>显形依赖</b><span>需先完成 ${S.gatedBy.get(n.id).map((g) => esc(g)).join('、')}(allow_branch 条件)${
        n.xOff != null && n.xOff !== n.x ? `;显形后坐标 (${n.x},${n.y})→(${n.xOff},${n.yOff})` : ''
      }</span></div>` : ''}
    ${n.defs && n.defs.length > 1 ? `<h4>定义位置 ${n.defs.length} 处</h4>${n.defs.map((d) => `<div class="kv"><span>[${esc(srcLabel(d.rootName))}] ${esc(d.file)}:${d.line}</span></div>`).join('')}` : ''}
    ${S.focusDetail ? focusDump(n) : ''}`
  const done = document.getElementById('bxDone')
  if (done)
    done.onchange = () => {
      if (done.checked) S.completed.add(n.id)
      else S.completed.delete(n.id)
      render()
      updateBranchStat()
    }
  const btn = document.getElementById('inspDetailBtn')
  if (btn)
    btn.onclick = () => {
      S.focusDetail = !S.focusDetail
      showInsp(n)
    }
}

/* 显示详情:把节点上所有字段(raw)列出来,方便排查坐标 / 类型 / 来源等细节 */
function focusDump(n) {
  const skip = new Set(['defs', 'own', 'ownLabel', 'stale', 'base', 'origin', 'overridden', 'tree', 'rel', 'kind'])
  const rows = []
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k)) continue
    const multiline = typeof v === 'string' && String(v).includes('\n')
    let s
    if (Array.isArray(v)) s = v.length ? v.map((x) => esc(String(x))).join(', ') : '（空）'
    else if (v === null || v === undefined || v === '') continue
    else s = esc(String(v))
    rows.push(
      `<div class="kv ${multiline ? 'blk' : ''}"><b>${esc(k)}</b>${
        multiline ? `<pre class="raw">${s}</pre>` : `<span>${s}</span>`
      }</div>`,
    )
  }
  return `<div class="sec-t">完整字段(raw · 显示详情)</div>` + (rows.join('') || '<div style="color:var(--ink3)">无</div>')
}
/* 渲染"条件/奖励"类块:标题 + 原始文本(截断,长文本可滚动),空则不放 */
function kvBlock(title, text) {
  if (!text) return ''
  const lines = String(text).split('\n')
  const trunc = lines.length > 8 ? lines.slice(0, 8).join('\n') + `\n…(共 ${lines.length} 行,点「显示详情」看完整)` : text
  return `<div class="kv blk"><b>${esc(title)}</b><pre class="raw">${esc(trunc)}</pre></div>`
}
function px0() {}

/* ── 保存 ── */
async function save() {
  if (!S.pending.size) return
  const moves = [...S.pending.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y }))
  const r = await api('/api/focus/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves, apply: true }),
  })
  if (r.error) return toast(r.error, true)
  const fails = (r.results || []).filter((x) => !x.written)
  let html = ''
  for (const x of r.results || []) {
    const d = (x.details || []).map((y) => `L${y.line} ${y.field}: ${y.from} → ${y.to}`).join('<br>')
    html += `<div style="padding:5px 11px;border-bottom:1px solid var(--line2)">
      <div style="font-size:12px">${esc(x.file)} ${x.written ? '<span style="color:var(--ok)">已写入</span>' : `<span style="color:var(--warn)">${esc(x.reason || '未写入')}</span>`}</div>
      <div style="color:var(--ink3);font-size:11px">${d || '—'}</div>
      ${x.backup ? `<div style="color:var(--ink3);font-size:11px">备份 ${esc(x.backup)}</div>` : ''}
    </div>`
    if (x.diff) html += `<pre class="diff">${esc(x.diff).replace(/^\+(.*)$/gm, '<span class="add">+$1</span>').replace(/^-(.*)$/gm, '<span class="del">-$1</span>')}</pre>`
  }
  $('#diffBox').innerHTML = html
  if (!fails.length) {
    toast(`已保存 ${moves.length} 处移动`)
    S.pending.clear()
    refreshPend()
    applySel()
  } else {
    toast(`${fails.length} 个文件未写入: ${fails[0].reason}`, true)
  }
}

/* ── 体检 ── */
async function runLint() {
  const d = await api('/api/focus/lint?id=' + encodeURIComponent(S.tree || ''))
  if (!d.ready) return toast('未就绪', true)
  S.issues = d.issues
  const sev = { error: 0, warn: 0, info: 0 }
  for (const i of d.issues) sev[i.severity]++
  $('#lintCount').innerHTML = `<span style="color:var(--danger)">${sev.error}</span> / <span style="color:var(--warn)">${sev.warn}</span> / ${sev.info}`
  const box = $('#lintList')
  box.innerHTML = ''
  const order = { error: 0, warn: 1, info: 2 }
  const list = [...d.issues].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 120)
  for (const i of list) {
    const el = document.createElement('div')
    el.className = 'iss ' + i.severity
    el.innerHTML = `<div><span class="r">${esc(i.rule)}</span> ${esc(i.message)}</div>
      ${i.file ? `<div class="f">${esc(i.file)}:${i.line}</div>` : ''}`
    el.onclick = () => {
      if (i.ids && S.byId.has(i.ids[0])) {
        S.sel = i.ids[0]
        applySel()
        showInsp(S.byId.get(i.ids[0]))
        centerOn(i.ids[0])
      }
    }
    box.appendChild(el)
  }
  toast(`体检完成: ${sev.error} 错误 / ${sev.warn} 警告 / ${sev.info} 提示`)
}

function centerOn(id) {
  const n = S.byId.get(id)
  if (!n) return
  const c = coordOf(n)
  const st = $('#stage').getBoundingClientRect()
  S.tx = st.width / 2 - (c.x * XU + NW / 2) * S.zoom
  S.ty = st.height / 2 - (c.y * YU + NH / 2) * S.zoom
  applyTransform()
}

/* ── 缩放平移 ── */
function fit() {
  if (!S.nodes.length) return
  const st = $('#stage').getBoundingClientRect()
  const b = S.bbox
  const w = (b.maxX - b.minX) * XU + NW + 40
  const h = (b.maxY - b.minY) * YU + NH + 40
  S.zoom = Math.min(st.width / w, st.height / h, 1.6)
  S.zoom = Math.max(S.zoom, 0.05)
  S.tx = (st.width - w * S.zoom) / 2 - b.minX * XU * S.zoom
  S.ty = (st.height - h * S.zoom) / 2 - b.minY * YU * S.zoom
  applyTransform()
}
function zoomBy(f) {
  const st = $('#stage').getBoundingClientRect()
  const cx = st.width / 2
  const cy = st.height / 2
  const z0 = S.zoom
  S.zoom = Math.min(Math.max(S.zoom * f, 0.05), 4)
  S.tx = cx - ((cx - S.tx) / z0) * S.zoom
  S.ty = cy - ((cy - S.ty) / z0) * S.zoom
  applyTransform()
}

/* 平移:空白处拖动 */
let pan = null
svg.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.node')) return
  pan = { x: ev.clientX, y: ev.clientY, tx: S.tx, ty: S.ty }
  window.addEventListener('pointermove', onPan)
  window.addEventListener('pointerup', endPan)
})
function onPan(ev) {
  if (!pan) return
  S.tx = pan.tx + (ev.clientX - pan.x)
  S.ty = pan.ty + (ev.clientY - pan.y)
  applyTransform()
}
function endPan() {
  window.removeEventListener('pointermove', onPan)
  window.removeEventListener('pointerup', endPan)
  pan = null
}
svg.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault()
    zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12)
  },
  { passive: false },
)

/* ══════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V1 / KEYS_V1)
 *
 * 画布节点与左侧树列表都挂上,菜单内容一致 ——
 * 位置信息后端早就给了(node.file/node.line/node.defs),这里只是接线。
 * ══════════════════════════════════════════════════════════ */
function nodeMenuItems(n) {
  return Ctx.sourceItems({
    root: n.root,
    rootName: n.rootName,
    file: n.file,
    line: n.line,
    id: n.id,
    loc: n.loc || n.id,
    defs: n.defs,
    extra: [
      {
        label: '只看这一条国策的体检结果',
        k: '✚',
        act: () => {
          $('#q').value = n.id
          renderTreeList()
          toast('已按 id 过滤树列表:' + n.id)
        },
      },
      {
        label: '复制全部前置依赖 id',
        k: '⧉',
        act: () => Ctx.copy((n.prereq || []).join('\n') || '(无)', ' 前置 ' + (n.prereq || []).length + ' 条'),
      },
      {
        label: '复制全部互斥 id',
        k: '⧉',
        act: () => Ctx.copy((n.mutex || []).join('\n') || '(无)', ' 互斥 ' + (n.mutex || []).length + ' 条'),
      },
    ],
  })
}
function treeMenuItems(t) {
  return Ctx.sourceItems({
    root: t.root,
    rootName: t.rootName,
    file: t.file,
    line: t.line,
    id: t.id,
    defs: (t.versions || []).map((v) => ({ root: v.root, rootName: v.rootName, file: v.file, line: v.line })),
    extra: [
      { label: '打开这棵树', k: '→', act: () => selectTree(t.id) },
      { label: '复制覆盖链', k: '⧉', act: () => Ctx.copy((t.versions || []).map((v) => `${v.rootName}  ${v.file}:${v.line}`).join('\n'), '') },
    ],
  })
}
function wireCtxAndKeys() {
  // 画布:委托到节点层 gNode(每次 render() 全量重建,不能逐节点绑定)。
  // ⚠ 用 gNode 而不是 gRoot:gRoot 还要承载 pan/zoom 的 transform,
  //   委托目标只负责"命中最近的 g.node",两者都能命中,取更贴切的内层。
  Ctx.attach(gNode, 'g.node', (el) => {
    const n = S.byId.get(el.dataset.id)
    return n ? nodeMenuItems(n) : null
  })
  // 左侧树列表:行上带 data-tree-id,菜单直接按 id 取,不去猜 span 文本
  Ctx.attach($('#treeList'), '.item', (el) => {
    const t = ALL.find((x) => x.id === el.dataset.treeId)
    return t ? treeMenuItems(t) : null
  })
  // 画布已有 pointerdown 拖拽;右键也要能"点选后看菜单",这里补 Shift+F10 支持
  if (window.Keys) {
    const K = Keys
    // ★ 声明本页归属:bind 时用于查 keymap,设置页按页分组也靠它
    window.__KEYMAP_PAGE__ = 'focus'
    // ★ 全部带 id —— 键位以 keymap.js 目录为准,用户在设置页改了这里就跟着变。
    //   'find.search' 有两个入口,合并成一次 bind(目录里 keys:['/','mod+f'])
    K.bind(null, () => $('#q').focus(), '聚焦搜索框', { id: 'find.search', group: '查找' })
    K.bind(null, fit, '缩放至适合窗口', { id: 'view.fit', group: '视图' })
    K.bind(null, () => { S.zoom = 1; applyTransform() }, '重置缩放 100%', { id: 'view.zoomReset', group: '视图' })
    K.bind(null, () => zoomBy(1.25), '放大', { id: 'view.zoomIn', group: '视图' })
    K.bind(null, () => zoomBy(1 / 1.25), '缩小', { id: 'view.zoomOut', group: '视图' })
    K.bind(
      null,
      () => {
        if (S.sel) Ctx.copy(S.sel, ' ' + S.sel)
        else toast('先用鼠标点选一个国策', true)
      },
      '复制选中国策的 id',
      { id: 'sel.copyId', group: '选中' },
    )
    K.bind(null, () => Keys.ctxKey(), '对选中国策打开右键菜单', { id: 'sel.menu', group: '选中' })
    K.bind(null, () => { S.sel = null; applySel(); $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">未选中(点选国策看详情,右键看菜单)</div>' }, '取消选择', { id: 'sel.clear', group: '选中' })
  }
}

/* ── 绑定 ── */
$('#q').addEventListener('input', renderTreeList)
/* 来源筛选:树列表本地过滤(瞬时),画布节点重新向后端要(节点量大,必须服务端裁剪)。
 * 当前选中的树若被筛掉,就自动切到筛选结果里的第一棵,避免画布停在一棵看不见的树上。 */
$('#srcSel').addEventListener('change', async (e) => {
  S.src = e.target.value
  srcSummary()
  renderTreeList()
  const list = S.src ? ALL.filter(treeVisible) : ALL
  if (S.tree && !list.some((t) => t.id === S.tree)) {
    S.tree = ''
    S.nodes = []
    S.edges = []
    S.byId = new Map()
    S.pending.clear()
    S.sel = null
    gNode.innerHTML = ''
    gEdge.innerHTML = ''
    $('#hud').textContent = '—'
    $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">当前筛选下没有树,请在上方列表选一棵</div>'
    if (list.length) await selectTree(list[0].id)
  } else if (S.tree) {
    await selectTree(S.tree)
  }
})
$('#treeSel').addEventListener('change', (e) => selectTree(e.target.value))
$('#btnLint').addEventListener('click', runLint)
$('#btnSave').addEventListener('click', save)
$('#zi').addEventListener('click', () => zoomBy(1.25))
$('#zo').addEventListener('click', () => zoomBy(1 / 1.25))
$('#fit').addEventListener('click', fit)
$('#bxShowHidden').addEventListener('change', (e) => {
  S.showHidden = e.target.checked
  render()
  updateBranchStat()
})
$('#bxOffset').addEventListener('change', (e) => {
  S.useOffset = e.target.checked
  render()
  fit()
  updateBranchStat()
})
$('#togName').addEventListener('click', () => {
  S.showName = !S.showName
  render()
})
window.addEventListener('keydown', (ev) => {
  if (!S.sel) return
  const n = S.byId.get(S.sel)
  if (!n) return
  const cur = S.pending.get(n.id) ?? { x: n.x, y: n.y }
  let d = null
  if (ev.key === 'ArrowLeft') d = { x: cur.x - 1, y: cur.y }
  else if (ev.key === 'ArrowRight') d = { x: cur.x + 1, y: cur.y }
  else if (ev.key === 'ArrowUp') d = { x: cur.x, y: cur.y - 1 }
  else if (ev.key === 'ArrowDown') d = { x: cur.x, y: cur.y + 1 }
  if (d) {
    ev.preventDefault()
    S.pending.set(n.id, d)
    refreshPend()
    render()
  }
})
window.addEventListener('resize', () => applyTransform())

void px
void px0
// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

// ★ 调试句柄:供无头浏览器验收断言用(allow_branch 门控 / offset 坐标联动)。
//   只读暴露内部状态与纯函数,不改变任何行为。
window.FocusApp = { S, coordOf, nodeVisState, buildGating, gatedRevealed }

// ★ 右键菜单 + 快捷键(必须在 Sizer 之后、loadTrees 之前:
//   绑定只依赖已存在的 DOM 节点,不依赖数据)
wireCtxAndKeys()

loadTrees()
