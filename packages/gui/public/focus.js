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
const XU = 66 // 列距;MU 用 50,本项目节点盒 62px,取 66(>=盒宽)消除相邻列重叠 → 宽度变宽 + 连线不再挤在窄通道
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
  undoBase: new Map(), // id → 拖动前文件坐标(撤销)
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
  /* ★★ TRIGGERS_V1:scope = 用户选中的条件 nodeContent 集合(Set<string>)。
   *   allow_branch 真值判定交给 evalTrig(两态,对齐 MU QV)。
   *   「模拟已完成此国策」= 把 has_completed_focus = <id> 加进 scope。 */
  scope: window.Trig.emptyScope(),
  /** 本树唯一条件清单: [{nodeContent, key, count}] —— 服务端 conditions */
  /** ★ MU 对齐:被某个 allow_branch 依赖"完成"的国策 id 集合 → 每节点复选框 */
  conditions: [],
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
/* 同 tech.js:顶层 const 不挂 window,自动化验收只能查 DOM,故挂 id。 */
gEdge.id = 'gEdge'
gNode.id = 'gNode'
gRoot.id = 'gRoot'
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
window.LoadGate && window.LoadGate.show("正在加载国策…")
  // LOADGATE_V1:按功能懒加载 —— 图未就绪(busy)时显示全屏遮罩并轮询,就绪后放行;
  //   已缓存页直接返回(遮罩一闪而过/不出现)。
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
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(`正在构建国策图…`) }
      window.LoadGate && window.LoadGate.show(`正在加载国策…`)
      await new Promise((res) => setTimeout(res, 1200))
      continue
    }
    if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
    window.LoadGate && window.LoadGate.hide()
    return d
  }
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
  add('', `${tr("全部 (")}${S.totalTrees}${tr(" 树)")}`, '同名树只列最终生效的那一份')
  sep('── 内容归属 ──')
  add('vanilla', `${tr("原版 (")}${os.vanilla ?? ow.vanilla ?? 0}${tr(" 树)")}`, '原版树,模组没有同名覆盖它')
  add('override', `${tr("模组改写 (")}${os.overridden ?? ow.override ?? 0}${tr(" 树)")}`, '原版有同名树,被模组整份替换')
  add('new', `${tr("模组新增 (")}${os.modNew ?? ow.new ?? 0}${tr(" 树)")}`, '原版没有这棵树,模组新增 —— 与原版共存')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  const mods = S.sources.filter((s) => !s.base)
  if (mods.length) {
    sep('──────────')
    for (const s of mods) {
      const st = S.sourceStats[s.name] || { trees: 0, nodes: 0 }
      add(s.name, `${srcLabel(s.name)} (${st.trees}${tr(" 树 / ")}${st.nodes}${tr(" 国策)")}`, s.path)
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
  if (base.length) parts.push(`${tr("原版 ")}${base.length}`)
  if (mods.length) parts.push(`${tr("模组 ")}${mods.length}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : tr('来源:') + srcLabel(S.src)
  el.textContent = `${tr("来源 ")}${parts.join(' / ')}${hint ? ' · ' + hint : ''}`
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
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
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
  /* ★ 首屏自动选第一棵树。此前首屏什么都不选,画布空着、
     要用户手点列表 —— 用户报"加载国策树无法加载"其实是这个。
     索引是异步建的(上面失败会退避重试),所以首屏会晚一点才有内容。 */
  if (!S.tree && ALL.length) {
    const list = S.src ? ALL.filter(treeVisible) : ALL
    if (list.length) selectTree(list[0].id)
  }
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
      `${t.id}${tr("\\n归属: ")}${ownTxt} — ${Own.hint(t)}\n` +
      `${tr("最终生效: ")}${t.rootName}(${t.base ? '基础游戏' : '模组'}${tr(")\\n位置: ")}${t.rootName}:${t.file}` +
      (t.versions.length > 1 ? tr('\n覆盖链: ') + t.versions.map((v) => srcLabel(v.rootName)).join(' → ') : '')
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
  /* GAMERULE_DEFAULT_V1:has_game_rule 按规则默认选项求值,须先注入模组定义的默认 */
  if (window.Trig) window.Trig.setGameRuleDefaults(d.gameRules || {})
  buildGating()
  renderTrigPanel(d.conditions || [])
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
  const shown = S.nodes.length < S.totalNodes ? `${tr(" 显示 ")}${S.nodes.length}/${S.totalNodes}` : ''
  /* ★ OWNERSHIP_V1:三态归属统一走 Own(不再按 origin/overridden 手写) */
  const ownTxt = Own.label(t)
  const ownCls = Own.CLS[Own.of(t)]
  const srcTxt = t.base ? '基础游戏' : tr('模组 · ') + srcLabel(t.rootName)
  $('#hud').textContent =
    `${t.id} · [${ownTxt}/${srcTxt}] ${S.nodes.length}${tr(" 国策")}${shown} · ${t.rootName}:${t.file}` +
    (t.versions.length > 1 ? `${tr(" · 被 ")}${t.versions.length}${tr(" 处定义覆盖")}` : '')
  $('#insp').innerHTML = `${tr("<div style=\"padding:6px 11px\">\n    <div class=\"kv\"><b>树</b><span>")}${esc(t.id)}${tr("</span></div>\n    <div class=\"kv\"><b>国家</b><span>")}${esc(t.tags.join(', ') || '—')}${tr("</span></div>\n    <div class=\"kv\"><b>内容归属</b><span><span class=\"src ")}${ownCls}">${ownTxt}</span> <span style="font-size:11px">${esc(Own.hint(t))}${tr("</span></span></div>\n    <div class=\"kv\"><b>生效来源</b><span><span class=\"src ")}${t.base ? 'base' : 'mod'}">${esc(srcLabel(t.rootName))}</span> ${t.base ? '基础游戏' : '模组'}${tr("</span></div>\n    <div class=\"kv\"><b>文件</b><span>")}${esc(t.rootName + ':' + t.file)}${tr("</span></div>\n    <div class=\"kv\"><b>节点</b><span>")}${S.nodes.length}${S.nodes.length < S.totalNodes ? ` / ${S.totalNodes}(来源筛选中)` : ''}${tr("(含共享引用 ")}${t.shared})</span></div>
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
      if (!n) return toast(`${id}${tr(" 不在本树(来源筛选或数据错误)")}`, true)
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

/** 当前生效坐标:优先用户拖拽(pending),其次条件偏移后的坐标,否则主坐标。
 *
 *  ★★ TRIGGERS_V1:offset 是【列表】,每条各带自己的 trigger,
 *  命中的**全部叠加** —— 对齐 HOI4 Mod Utilities 的 focustree.js:
 *      for (const t of e.offset)
 *        t.trigger !== void 0 && QV(t.trigger, s) && (c.x += t.x, c.y += t.y)
 *  旧版 childBlock() 只取第一条 offset(实测 czechoslovakia_mu.txt 一棵树
 *  98 个 offset、20 个国策有多条、最多 8 条)→ 分支位置全错。
 *  条件为 null(无 trigger)的 offset 恒生效 —— 游戏里无 trigger 的 offset
 *  就是无条件位移。 */
function offsetDelta(n) {
  const rules = n.offsetRules
  if (!rules || !rules.length) return null
  const T = window.Trig
  let ox = 0
  let oy = 0
  let any = false
  for (const r of rules) {
    // 无 trigger = 无条件位移;true = 命中;false/null = 不命中
    const ok = r.trigger == null ? true : T ? T.evalTrig(r.trigger, S.scope) === true : false
    if (ok) {
      ox += r.x || 0
      oy += r.y || 0
      any = true
    }
  }
  return any ? { x: ox, y: oy } : null
}

function coordOf(n) {
  const p = S.pending.get(n.id)
  if (p) return p
  // 调试开关:无条件套用服务端算好的首条 offset 坐标(不级联,仅供手动对比)
  if (S.useOffset && n.xOff != null) return { x: n.xOff, y: n.yOff }
  /* ★ OFFSET_CHAIN_V1:条件 offset 沿「相对链」累计 —— 父国策 offset 位移时,
     下方相对定位的子国策跟随同移(连线不断)。旧版只算本节点 offset:父节点一移、
     子节点原地 → 折线断开。n.x 已是解析后的绝对坐标(含祖先基准),
     这里再加整条相对链上命中条件的 offset 增量。 */
  let ox = 0, oy = 0, cur = n, seen = new Set()
  while (cur) {
    if (seen.has(cur.id)) break
    seen.add(cur.id)
    const d = offsetDelta(cur)
    if (d) { ox += d.x; oy += d.y }
    if (!cur.rel) break
    cur = S.byId.get(cur.rel)
  }
  return (ox || oy) ? { x: n.x + ox, y: n.y + oy } : { x: n.x, y: n.y }
}

/** 本节点是否因某门控国策被模拟完成而显形(allow_branch 门控)
 *  ★ TRIGGERS_V1 后这个函数只用于【检查器提示文案】,真正的显隐走 nodeVisState。 */
function gatedRevealed(n) {
  const st = nodeVisState(n)
  return st.v && !st.f
}

/** 从本树节点建「受控关系」:allow_branch = { has_completed_focus = X } 表示【本节点 n 要等 X 完成才显形】,
 *  所以是 n 受控于 X → gatedBy[n.id] = [X, ...]。
 *  ★ TRIGGERS_V1:真正的判定已交给 evalTrig(支持 AND/OR/NOT/DLC 门控),
 *  这里保留 gatedBy 只为检查器展示与老代码引用 —— 只收 focus 类叶子。 */
function buildGating() {
  S.gatedBy = new Map()
  const T = window.Trig
  for (const n of S.nodes) {
    let deps = []
    if (T) {
      // 优先从条件树里提"纯 focus AND"的依赖(能带 OR/NOT 信息之外的准确集合)
      deps = flatFocusDeps(n.allowBranchTrig) || []
    }
    // 条件树提不出(有 OR / NOT / DLC 门控)→ 退回服务端给的 branch 列表(只含 focus 类)
    if (!deps.length) deps = (n.branch || []).slice()
    if (deps.length) S.gatedBy.set(n.id, [...new Set(deps)])
  }
}

/** 若条件树是"纯 focus AND"(叶子全是 has_completed_focus),返回依赖 id 列表;否则 null。
 *  与 MU 的语义一致:has_completed_focus 是它唯一支持的"焦点完成"判定,
 *  其余条件(DLC/旗标/规则)对它来说是不可知的。 */
function flatFocusDeps(node) {
  if (!node) return null
  if (node.type === 'leaf') {
    const k = String(node.key || '').toLowerCase()
    return k === 'has_completed_focus' || k === 'has_completed_any_focus' || k === 'focus' ? [node.value] : null
  }
  if (node.type === 'unknown' || node.type === 'count') return null
  if (node.type !== 'and') return null // OR / NOT 一律不当依赖列表
  const out = []
  for (const it of node.items || []) {
    const r = flatFocusDeps(it)
    if (!r) return null
    for (const x of r) out.push(x)
  }
  return out
}

/** 一个国策的可见状态(三态,TRIGGERS_V1):
 *   v=是否画出  f=是否灰显  u=是否"条件未知"(求值出 null)。
 *  ★★ 关键:evalTrig 返回 null 时【不能当 false】——
 *   null 的含义是"这条条件引用了本工具判不了的东西"(DLC / 真实世界状态 / 未登记键),
 *   当成 false 会把"该显形的分支"错标成隐藏。MU 也是把这类键留成不可判定。
 *   我们的处理:null → 画出但灰显,交给「显示隐藏分支」开关决定是否淡化。 */
function nodeVisState(n) {
  const T = window.Trig
  // 无条件 → 永远显形
  if (!T) return { v: true, f: false }
  if (n.allowBranchTrig == null) return { v: true, f: false }
  const r = T.evalTrig(n.allowBranchTrig, S.scope)
  if (r === false) return S.showHidden ? { v: true, f: true } : { v: false, f: false }
  return { v: true, f: false }
}

/* MU 下游传播:某国策 allow_branch 不满足 → 隐藏;若某国策的全部前置(非互斥依赖边)
   都被隐藏,它也随之隐藏(整条分支不可达)。返回 {base, vis}。 */
/* ★ PREREQ_AND_V1:prerequisite 多块需全部满足(AND)该国策分支才显形。
   默认全览(未勾选任何前置)不受影响;一旦勾选任一前置开始模拟完成,
   需全部前置完成才显形,否则隐藏/灰显(游戏语义:依赖链 AND)。 */
function prereqFullyDone(groups, scope) {
  for (const grp of groups || []) {
    let ok = (grp.focus && grp.focus.length) ? grp.focus.some((f) => scope.has('has_completed_focus = ' + f)) : false
    if (!ok && grp.or && grp.or.length) ok = grp.or.some((set) => set.every((f) => scope.has('has_completed_focus = ' + f)))
    if (!ok) return false
  }
  return true
}
function buildVis() {
  const base = new Map()
  for (const n of S.nodes) {
    let st = nodeVisState(n)
    const g = n.prereqGroups
    if (g && g.length && st.v) {
      const flat = []
      for (const grp of g) { for (const f of grp.focus || []) flat.push(f); for (const set of grp.or || []) for (const f of set) flat.push(f) }
      let anyFocusDone = false
      for (const k of S.scope.keys()) { if (k.startsWith('has_completed_focus = ')) { anyFocusDone = true; break } }
    }
    base.set(n.id, st)
  }
  const pred = new Map()
  for (const e of S.edges) {
    /* ⚠ 只把真正的「前置依赖」当传播条件:prereq / or。
       mutex 互斥不参与(另有专门隐藏);branch 门控边(被门控方→门)方向
       与 to 依赖 from 相反,混进来会「门控方隐藏→连带被门控方隐藏」误判
       (如 CHI_form_saco→CHI_end_military_primacy),而 allow_branch 门控
       已由 nodeVisState 直接求值,前置链传播也覆盖了传递门控。 */
    if (e.kind === 'mutex' || e.kind === 'branch') continue
    if (!pred.has(e.to)) pred.set(e.to, [])
    pred.get(e.to).push(e.from)
  }
  /* ★ MUTEX_HIDE_V1:互斥边(对称)建「互斥伙伴」表 —— 实测 n.mutex 常为空,
     互斥关系全在 S.edges(kind='mutex',direction from>to)。语义对称:任一方完成,
     另一方所在矛盾分支隐藏。未勾任何互斥方时互斥不隐藏(不破坏默认全览)。 */
  const mutexOf = new Map()
  for (const e of S.edges) {
    if (e.kind !== 'mutex') continue
    if (!mutexOf.has(e.from)) mutexOf.set(e.from, [])
    mutexOf.get(e.from).push(e.to)
    if (!mutexOf.has(e.to)) mutexOf.set(e.to, [])
    mutexOf.get(e.to).push(e.from)
  }
  const vis = new Map()
  for (const n of S.nodes) {
    let v = base.get(n.id).v
    const partners = mutexOf.get(n.id)
    if (v && partners && partners.length) {
      for (const mt of partners) {
        if (S.scope.has('has_completed_focus = ' + mt)) { v = false; break }
      }
    }
    vis.set(n.id, v)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const n of S.nodes) {
      if (!vis.get(n.id)) continue
      const ps = pred.get(n.id)
      if (!ps || !ps.length) continue
      let allHidden = true
      for (const p of ps) if (vis.get(p)) { allHidden = false; break }
      if (allHidden) { vis.set(n.id, false); changed = true }
    }
  }
  return { base, vis }
}

/* ══════════════ TRIGGERS_V1 条件面板 ══════════════
 * 对齐 HOI4 Mod Utilities 的 #allowbranch-container:把本树所有唯一条件叶子
 * 列成复选框,勾选写入 S.scope(Set<nodeContent>),重算全树。
 * 分组按 Trig.groupConditions(仅显示归类,求值按字符串相等)。 */
const TRIG_MAX = 200

function renderTrigPanel(conditions) {
function collectIconConds() {
  const T = window.Trig
  S.iconConds = []
  if (!T || !S.nodes) return
  const out = new Map()
  for (const n of S.nodes) {
    for (const it of n.iconList || []) {
      if (it.trig) T.collectConditions(it.trig, out)
    }
  }
  S.iconConds = [...out.values()]
}
function condRow(it, T) {
  const row = document.createElement('label')
  row.className = 'trow'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = String(it.key || '').toLowerCase() === 'has_game_rule' ? T.matchGameRule(it.nodeContent) : S.scope.has(it.nodeContent)
  cb.onchange = () => {
    const k = String(it.key || '').toLowerCase()
    if (k === 'has_game_rule') {
      T.setGameRule(it.nodeContent, cb.checked)
      renderTrigPanel(S.conditions)
    } else if (cb.checked) S.scope.add(it.nodeContent)
    else S.scope.delete(it.nodeContent)
    render()
    if (S.sel) { const n = S.byId.get(S.sel); if (n) showInsp(n) }
  }
  const sp = document.createElement('span')
  sp.textContent = it.nodeContent
  sp.title = it.key
  const em = document.createElement('em')
  em.textContent = it.count
  row.append(cb, sp, em)
  return row
}
  const list = document.getElementById('trigList')
  const box = document.getElementById('trigbox')
  const tgl = document.getElementById('trigToggle')
  if (!list || !box) return
  const T = window.Trig
  S.conditions = conditions || []
  collectIconConds()
  /* ★ MU 对齐:收集"被某个 allow_branch 依赖完成"的国策 id → 每节点复选框 */
  S.completionGated = new Set()
  for (const it of S.conditions) {
    if (it.nodeContent.startsWith('has_completed_focus = ')) {
      const id = it.nodeContent.slice('has_completed_focus = '.length).trim()
      if (id) S.completionGated.add(id)
    }
  }
  /* ★ MU 对齐(new mode):条件面板排除 has_focus_tree / has_completed_focus 前缀,
     它们由每节点复选框 + 树本身驱动,不占面板。 */
  const panelConds = S.conditions.filter(
    (it) => !it.nodeContent.startsWith('has_focus_tree = ') && !it.nodeContent.startsWith('has_completed_focus = '),
  )
  if (!panelConds.length && !S.iconConds.length) {
    box.style.display = 'none'
    return
  }
  box.style.display = ''
  const groups = T ? T.groupConditions(panelConds) : []
  let total = 0
  for (const g of groups) total += g.items.length
  tgl.dataset.n = String(total + (S.iconConds.length || 0))
  tgl.textContent = trigLabel(tgl, !!box.classList.contains('expanded'))
  list.innerHTML = ''
  if (groups.length) {
    const secT = document.createElement('div')
    secT.className = 'tsec'
    secT.textContent = tr('国策树条件') + ' (' + total + ')'
    list.appendChild(secT)
  }
  for (const g of groups) {
    const items = g.items
    if (!items.length) continue
    const h = document.createElement('div')
    h.className = 'tgrp'
    h.textContent = `${g.cat} (${items.length})`
    list.appendChild(h)
    for (const it of items.slice(0, TRIG_MAX)) {
      const row = document.createElement('label')
      row.className = 'trow'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = String(it.key || '').toLowerCase() === 'has_game_rule'
        ? T.matchGameRule(it.nodeContent)
        : S.scope.has(it.nodeContent)
      cb.onchange = () => {
        const k = String(it.key || '').toLowerCase()
        if (k === 'has_game_rule') {
          T.setGameRule(it.nodeContent, cb.checked)
          renderTrigPanel(S.conditions) /* 同规则多选项复选框联动 */
        } else if (cb.checked) S.scope.add(it.nodeContent)
        else S.scope.delete(it.nodeContent)
        render()
        if (S.sel) { const n = S.byId.get(S.sel); if (n) showInsp(n) }
      }
      const sp = document.createElement('span')
      sp.textContent = it.nodeContent
      sp.title = it.key
      const em = document.createElement('em')
      em.textContent = it.count
      row.append(cb, sp, em)
      list.appendChild(row)
    }
    if (items.length > TRIG_MAX) {
      const more = document.createElement('div')
      more.className = 'tgrp'
      more.textContent = `… 另 ${items.length - TRIG_MAX} 项`
      list.appendChild(more)
    }
  }
  if (S.iconConds.length) {
    const secI = document.createElement('div')
    secI.className = 'tsec'
    secI.textContent = tr('图标条件') + ' (' + S.iconConds.length + ')'
    list.appendChild(secI)
    const igroups = T ? T.groupConditions(S.iconConds) : []
    for (const g of igroups) {
      const items = g.items
      if (!items.length) continue
      const h = document.createElement('div')
      h.className = 'tgrp'
      h.textContent = g.cat + ' (' + items.length + ')'
      list.appendChild(h)
      for (const it of items.slice(0, TRIG_MAX)) {
        list.appendChild(condRow(it, T))
      }
      if (items.length > TRIG_MAX) {
        const more = document.createElement('div')
        more.className = 'tgrp'
        more.textContent = '… 另 ' + (items.length - TRIG_MAX) + ' 项'
        list.appendChild(more)
      }
    }
  }
}

/** ★ MU 对齐:每节点"已完成"复选框(checkedFocuses)。
 *   只有被某个 allow_branch 以 has_completed_focus 依赖的国策才画复选框;
 *   勾选写入 scope 的 has_completed_focus = id,重算全树 → 依赖它的分支显形。
 *   层 pointer-events:none,只有复选框可点,不挡拖拽/平移。 */
function renderChecks() {
  let layer = document.getElementById('checkLayer')
  if (!layer) {
    layer = document.createElement('div')
    layer.id = 'checkLayer'
    document.getElementById('stage').appendChild(layer)
  }
  layer.innerHTML = ''
  if (!S.completionGated || !S.completionGated.size) return
  for (const n of S.nodes) {
    if (!S.completionGated.has(n.id)) continue
    const st = nodeVisState(n)
    if (!st.v) continue // 隐藏的节点不画复选框
    const c = coordOf(n)
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'fcheck'
    cb.title = '模拟已完成此国策(勾上让依赖它的分支显形)'
    cb.checked = S.scope.has('has_completed_focus = ' + n.id)
    cb.onchange = () => {
      if (cb.checked) S.scope.add('has_completed_focus = ' + n.id)
      else S.scope.delete('has_completed_focus = ' + n.id)
      render()
      if (S.sel) { const m = S.byId.get(S.sel); if (m) showInsp(m) }
    }
    cb.style.left = (c.x * XU * S.zoom + S.tx) + 'px'
    cb.style.top = (c.y * YU * S.zoom + S.ty) + 'px'
    cb.style.transform = 'scale(' + Math.max(0.5, S.zoom) + ')'
    layer.appendChild(cb)
  }
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
  const { base: visBase, vis: visMap } = buildVis()
  for (const n of S.nodes) {
    const st = visBase.get(n.id)
    if (!visMap.get(n.id)) continue // 被 allow_branch 隐藏 / 前置不可达 → 不画
    pos.set(n.id, coordOf(n))
    if (st.f) faded.add(n.id)
  }
  /* ★★ GRIDWIRE_V1:连线改用网格轨道正交折线(HOI4 Mod Utilities 的画法)。
   *
   * 旧版从节点中心拉曲线,节点一多就"斜线交叉糊成一片" ——
   * 那是画法错了,不是数据错了。游戏里的国策连线本来就是
   * 「铺在整数网格上、走格与格之间的边界、永远横平竖直」。
   *
   * ★ 占用表 occ 必须**整张画布一份**:只有跨边累积才能检测到
   *   两条线抢占同一格通道(交叉)。每条边各自建表 = 永远检测不到冲突。
   * ★ 边按 kind 排序后布线:互斥(mutex)是虚线,让它们后画 → 冲突时
   *   是实线让路,与游戏里"主线优先"的观感一致。
   */
  const occ = new Map()
  const GW = window.GridWire
  const edges = S.edges.slice().sort((a, b) => (a.kind === 'mutex' ? 1 : 0) - (b.kind === 'mutex' ? 1 : 0))
  let conflicts = 0
  for (const e of edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    let d
    if (GW) {
      const r = GW.routeAvoiding(occ, e.from + '>' + e.to, { gx: a.x, gy: a.y }, { gx: b.x, gy: b.y }, { cw: XU, ch: YU, halfH: NH / 2 })
      d = r.d
      if (r.conflict) conflicts++
    } else {
      // GridWire 没加载上(理论上不会,已加静态路由)时的兜底:退回旧曲线
      d = edgePathD(a.x * XU + NW / 2, a.y * YU + NH, b.x * XU + NW / 2, b.y * YU, 12, 'v')
    }
    if (!d) continue
    const p = document.createElementNS(SVGNS, 'path')
    p.setAttribute('d', d)
    /* 折线是直角轨道,不需要圆角半径 —— 视觉上与游戏一致。
       直线段仍是 1px,拐角处不需要额外处理(SVG 直角无抗锯齿缺口)。 */
    p.setAttribute('class', 'edge ' + e.kind + (faded.has(e.from) || faded.has(e.to) ? ' ghost' : ''))
    p.dataset.from = e.from
    p.dataset.to = e.to
    gEdge.appendChild(p)
  }
  S.gridConflicts = conflicts
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
        ? `${n.id}${tr(" — 模组新增 · ")}${n.rootName}`
        : n.overridden
          ? `${n.id}${tr(" — 原版国策,被 ")}${n.rootName}${tr(" 改写")}`
          : `${n.id}${tr(" — 基础游戏")}`
    /* 本地化:有译文就显示译文,没有保留 id(用户 2026-10 定的默认英文) */
    const locTxt = Loc.label(n.id)
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
  renderChecks()
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
  renderChecks()
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
    const tex = curIconTex(n)
    if (!tex || S.icons.has(tex)) continue
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
  await Promise.all(batch.map((n) => loadIcon(curIconTex(n))))
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
    if (!n) continue
    const tex = curIconTex(n)
    if (!tex) continue
    const ic = S.icons.get(tex)
    if (!ic || !ic.url) continue
    const img = g.querySelector('image')
    if (img && img.getAttribute('href') !== ic.url) img.setAttribute('href', ic.url)
  }
}

/* ★ ICON_COND_V1:条件图标 icon={GFX_a={cond} GFX_b={cond}}，
   按 scope 求值选当前应显示的 tex；无满足回退无条件/首个。 */
function curIconTex(n) {
  const list = n.iconList
  if (list && list.length) {
    const T = window.Trig
    let fb = ''
    for (const it of list) {
      if (!it.trig) { if (!fb) fb = it.tex; continue }
      if (T && T.evalTrig(it.trig, S.scope) === true) return it.tex
    }
    return fb || (list[0] && list[0].tex) || n.tex
  }
  return n.tex
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
  if (!S.undoBase.has(n.id)) S.undoBase.set(n.id, { x: n.x, y: n.y })
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
  /* ★ GRIDWIRE_V2:重画连线要节流。updateEdgesFor 会重建整张占用表并重跑
     全部边的布线(实测最大树 655 边 ≈ 2ms),而 pointermove 每秒能触发
     60~120 次 → 每秒重建上百张占用表,旧的靠 GC 回收,瞬时堆占用极高,
     拖拽大树时直接 Out of Memory。改成每个动画帧最多跑一次。 */
  scheduleEdgeUpdate(drag.n.id)
  refreshPend()
}
/** rAF 节流版 updateEdgesFor:同帧内多次调用只执行最后一次 */
let _edgeRaf = 0
let _edgeArg = ''
function scheduleEdgeUpdate(id) {
  _edgeArg = id
  if (_edgeRaf) return
  _edgeRaf = requestAnimationFrame(() => {
    _edgeRaf = 0
    const a = _edgeArg
    _edgeArg = ''
    updateEdgesFor(a)
  })
}
function updateEdgesFor(id) {
  /* ★ GRIDWIRE_V1:拖拽时重画连线也必须走同一套网格轨道,
   *   否则拖动中连线会从"直角轨道"变回"斜线",松手瞬间整棵树跳变。
   *   重建占用表 → 与 render() 的布线顺序完全一致。 */
  const pos = new Map()
  for (const n of S.nodes) if (nodeVisState(n).v) pos.set(n.id, coordOf(n))
  const occ = new Map()
  const GW = window.GridWire
  const byKey = new Map()
  for (const child of gEdge.children) byKey.set(child.dataset.from + '>' + child.dataset.to, child)
  const edges = S.edges.slice().sort((a, b) => (a.kind === 'mutex' ? 1 : 0) - (b.kind === 'mutex' ? 1 : 0))
  for (const e of edges) {
    const el = byKey.get(e.from + '>' + e.to)
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!el || !a || !b) continue
    if (GW) {
      const r = GW.routeAvoiding(occ, e.from + '>' + e.to, { gx: a.x, gy: a.y }, { gx: b.x, gy: b.y }, { cw: XU, ch: YU, halfH: NH / 2 })
      if (r.d) el.setAttribute('d', r.d)
    } else {
      el.setAttribute('d', edgePathD(a.x * XU + NW / 2, a.y * YU + NH, b.x * XU + NW / 2, b.y * YU, 12, 'v'))
    }
  }
}
function endDrag() {
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', endDrag)
  /* rAF 节流后,最后一帧可能还挂在队列里没跑 —— 松手时必须同步补一次,
     否则松手瞬间连线停在旧位置(视觉上"跳一下")。 */
  if (_edgeRaf) {
    cancelAnimationFrame(_edgeRaf)
    _edgeRaf = 0
    const a = _edgeArg
    _edgeArg = ''
    if (a) updateEdgesFor(a)
  }
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
  c.textContent = `${n}${tr(" 处待保存")}`
  c.className = 'chip hot'
  $('#btnSave').disabled = !n
  const u = $('#btnUndo')
  if (u) u.disabled = !n
}

/* ── 检查器 ── */
function showInsp(n) {
  const pend = S.pending.get(n.id)
  /* 标题与描述:key = id(实测 99.9% 命中)。没有译文就不显示这两行,不占位。 */
  const hasTitle = !!Loc.text(n.id)
  const titleHtml = Loc.rich(n.id)
  const desc = (Loc.hit(n.id) || {}).value
  const descText = desc && desc.indexOf('\n') > 0 ? desc.slice(desc.indexOf('\n') + 1) : ''
  $('#insp').innerHTML = `
    <button id="inspDetailBtn" class="dbtn">${S.focusDetail ? '▾ 收起详情' : '▸ 显示详情'}</button>
    ${hasTitle ? `<div class="kv"><b>标题</b><span>${titleHtml}</span></div>` : ''}
    <div class="kv"><b>id</b><span>${esc(n.id)}</span></div>
    ${descText ? `<div class="kv" style="flex-direction:column;align-items:stretch"><b style="width:auto">描述</b><span style="white-space:pre-wrap;color:var(--ink2)">${Loc.richText(truncate(descText, 400))}</span></div>` : ''}${tr("\n    <div class=\"kv\"><b>类型</b><span>")}${n.kind === 'focus' ? '国策' : n.kind === 'shared' ? '共享' : '联合'}${n.dynamic ? ' · 动态' : ''}${n.continuous ? ' · 连续' : ''}${tr("</span></div>\n    <div class=\"kv\"><b>图标</b><span>")}${esc(n.icon) || '—'}${tr("</span></div>\n    <div class=\"kv\"><b>成本</b><span>")}${n.cost}${tr("</span></div>\n    <div class=\"kv\"><b>来源</b><span>")}${Own.badge(n)} ${esc(srcLabel(n.rootName))}${
      (n.defs || []).length > 1
        ? tr(' <span style="color:var(--ink3)">同名定义 ') + (n.defs || []).length + tr(' 处,最后一个生效</span>')
        : ''
    }${tr("</span></div>\n    <div class=\"kv\"><b>坐标</b><span>(")}${n.x}, ${n.y})${pend ? ` → <b style="color:var(--warn)">(${pend.x}, ${pend.y})</b>` : ''}${tr("</span></div>\n    <div class=\"kv\"><b>相对</b><span>")}${n.rel ? esc(n.rel) : '绝对坐标'}${n.rel ? ` (偏移 ${n.rx}, ${n.ry})` : ''}${tr("</span></div>\n    <div class=\"kv\"><b>位置</b><span>")}${esc(n.rootName + ':' + n.file)}:${n.line}</span></div>
    ${kvBlock('available · 出现条件', n.available)}
    ${kvBlock('ai_will_do · AI 完成意愿', n.aiWillDo)}
    ${kvBlock('completion_reward · 完成奖励', n.completionReward)}
    ${kvBlock('complete_tooltip · 完成奖励提示', n.completeTooltip)}
    ${kvBlock('select_effect · 选择时效果', n.selectEffect)}
    ${kvBlock('bypass_effect · 跳过时效果', n.bypassEffect)}
    ${kvBlock('cancel_effect · 取消时效果', n.cancelEffect)}
    ${n.autoBypassDisabled ? `<div class="kv"><b>enable_automatic_bypass</b><span>no · 禁止自动跳过</span></div>` : ''}
    ${n.bypassIfUnavailable ? `<div class="kv"><b>bypass_if_unavailable</b><span>yes · 条件不满足自动跳过</span></div>` : ''}
    ${n.textIcon ? `<div class="kv"><b>标题栏样式 text_icon</b><span>${esc(n.textIcon)}</span></div>` : ''}
    ${n.jointTrigger ? kvBlock('joint_trigger · 联合条件', n.jointTrigger) : ''}
    ${kvBlock('search_filters · 搜索过滤', n.searchFilters)}
    ${kvBlock('bypass · 跳过条件', n.bypass)}
    ${
      n.xOff != null
        ? `<div class="kv"><b>条件偏移</b><span>主坐标 (${n.x}, ${n.y}) → 偏移 (${n.xOff}, ${n.yOff})${
            n.offsetRaw ? '（触发条件见下方 offset 块）' : ''
          }</span></div>${kvBlock('offset · 条件偏移', n.offsetRaw)}`
        : ''
    }
    ${grpBlock('前置', n.prereq, n.prereqGroups)}
    ${grpBlock('互斥', n.mutex, n.mutexGroups)}
    ${n.branch && n.branch.length ? `
      <h4>allow_branch · 本国策显形需先完成 ${n.branch.length}</h4>
      ${n.branch.map((b) => `<div class="kv"><span>${esc(b)}</span></div>`).join('')}` : ''}
    ${kvBlock('allow_branch · 分支显形条件', n.branchRaw)}
    <label class="bx" style="display:flex;gap:5px;align-items:center;margin:5px 0 2px">
      <input type="checkbox" id="bxDone" ${S.scope.has('has_completed_focus = ' + n.id) ? 'checked' : ''}${tr(">\n      模拟已完成此国策(勾上会让依赖它的分支显形)\n    </label>\n    ")}${S.gatedBy && S.gatedBy.get(n.id) && S.gatedBy.get(n.id).length ? `
      <div class="kv"><b>显形依赖</b><span>需先完成 ${S.gatedBy.get(n.id).map((g) => esc(g)).join('、')}(allow_branch 条件)${
        n.xOff != null && n.xOff !== n.x ? `;显形后坐标 (${n.x},${n.y})→(${n.xOff},${n.yOff})` : ''
      }</span></div>` : ''}
    ${n.defs && n.defs.length > 1 ? `<h4>定义位置 ${n.defs.length} 处</h4>${n.defs.map((d) => `<div class="kv"><span>[${esc(srcLabel(d.rootName))}] ${esc(d.file)}:${d.line}</span></div>`).join('')}` : ''}
    ${S.focusDetail ? focusDump(n) : ''}`
  const done = document.getElementById('bxDone')
  if (done)
    done.onchange = () => {
      if (done.checked) S.scope.add('has_completed_focus = ' + n.id)
      else S.scope.delete('has_completed_focus = ' + n.id)
      render()
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
  const trunc = lines.length > 8 ? lines.slice(0, 8).join('\n') + `${tr("\\n…(共 ")}${lines.length}${tr(" 行,点「显示详情」看完整)")}` : text
  return `<div class="kv blk"><b>${esc(title)}</b><pre class="raw">${esc(trunc)}</pre></div>`
}
function px0() {}
/* ★ OR_V1:按 HOI4 MU 的语义分组显示前置/互斥。
   prerequisite 里多个块之间是「且」;同一个块内 focus= 是「且」、OR= 是「任选其一」。
   groups 为空(旧接口/无 OR)时退回扁平列表,保证不回归。 */
function grpBlock(title, flat, groups) {
  if (!flat || !flat.length) return ''
  if (!groups || !groups.length) {
    return `<h4>${esc(title)} ${flat.length}</h4>` + flat.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')
  }
  const rows = groups.map((g, i) => {
    const and = (g.focus || []).map((p) => `<code class="or-id">${esc(p)}</code>`).join(' <i>且</i> ')
    const or = (g.or || []).map((set) => `<span class="or-set">${set.map((p) => `<code class="or-id">${esc(p)}</code>`).join(' <i>或</i> ')}</span>`).join(' <i>或</i> ')
    const body = [and, or].filter(Boolean).join(' <i>，或整组满足</i><br>')
    return `<div class="kv grp"><b>#${i + 1}</b><span>${body || '—'}</span></div>`
  })
  return `<h4>${esc(title)} ${flat.length} · ${groups.length} 组</h4>${rows.join('')}`
}

/* ── 撤销 ── */
function undoMove() {
  if (!S.pending.size && !S.undoBase.size) return
  const ids = [...S.undoBase.keys()]
  for (const id of ids) {
    const b = S.undoBase.get(id)
    const n = S.nodes.find((x) => x.id === id)
    if (!n || !b) continue
    n.x = b.x
    n.y = b.y
    S.pending.delete(id)
    const g = gNode.querySelector(`[data-id="${cssEsc(id)}"]`)
    if (g) {
      const r = g.querySelector('rect')
      if (r) { r.setAttribute('x', b.x * XU); r.setAttribute('y', b.y * YU) }
      const img = g.querySelector('image')
      if (img) { img.setAttribute('x', b.x * XU + 1); img.setAttribute('y', b.y * YU + 1) }
      const t = g.querySelector('text')
      if (t) { t.setAttribute('x', b.x * XU + NW / 2); t.setAttribute('y', b.y * YU + NH + 10) }
      g.classList.remove('pend')
    }
  }
  S.undoBase.clear()
  S.pending.clear()
  for (const id of ids) scheduleEdgeUpdate(id)
  refreshPend()
}
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
    toast(`${tr("已保存 ")}${moves.length}${tr(" 处移动")}`)
    S.pending.clear()
    refreshPend()
    applySel()
  } else {
    toast(`${fails.length}${tr(" 个文件未写入: ")}${fails[0].reason}`, true)
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
  toast(`${tr("体检完成: ")}${sev.error}${tr(" 错误 / ")}${sev.warn}${tr(" 警告 / ")}${sev.info}${tr(" 提示")}`)
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
          toast(tr('已按 id 过滤树列表:') + n.id)
        },
      },
      {
        label: '复制全部前置依赖 id',
        k: '⧉',
        act: () => Ctx.copy((n.prereq || []).join('\n') || '(无)', tr(' 前置 ') + (n.prereq || []).length + tr(' 条')),
      },
      {
        label: '复制全部互斥 id',
        k: '⧉',
        act: () => Ctx.copy((n.mutex || []).join('\n') || '(无)', tr(' 互斥 ') + (n.mutex || []).length + tr(' 条')),
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
$('#btnUndo').addEventListener('click', undoMove)
$('#btnSave').addEventListener('click', save)
$('#zi').addEventListener('click', () => zoomBy(1.25))
$('#zo').addEventListener('click', () => zoomBy(1 / 1.25))
$('#fit').addEventListener('click', fit)
/* TRIGGERS_V1:条件面板展开/收起 + 全部清空。
   面板默认收起(条件多的树能有上百项),点标题展开;清空则把四个 scope 桶全重置。 */
/* ★ TRIGWIN_V1(2026-10-22):条件面板从"停靠坞里的一块"升级为**画布浮动小窗** ——
   标题栏按住拖动 = 移动;底缘握把拖动 = 拉长/收缩;标题按钮 = 折叠/展开;
   双击标题栏 = 复位到右上角。位置/高度存 localStorage(gui.trigWin),两页共用。 */
const TRIGWIN_KEY = 'gui.trigWin'
function trigWinLoad() {
  try {
    const j = JSON.parse(localStorage.getItem(TRIGWIN_KEY) || 'null')
    if (j && typeof j === 'object') return j
  } catch {}
  /* 兼容上一轮只存高度的旧键 trigH */
  try {
    const h = parseInt(localStorage.getItem('trigH') || '0', 10)
    if (h >= 64) return { h }
  } catch {}
  return null
}
function trigWinSave(p) { try { localStorage.setItem(TRIGWIN_KEY, JSON.stringify(p)) } catch {} }
/** 标题文案:保留 renderTrigPanel 写进 dataset.n 的计数,箭头随展开态切换 */
function trigLabel(el, open) {
  const n = el.dataset.n || ''
  return (tr('条件') + (n ? ' ' + n : '') + ' ' + (open ? '▾' : '▸')).replace(/\s+/g, ' ').trim()
}
/** 设置浮窗高度(px),按舞台高度 clamp 并持久化 */
function trigApplyH(box, h) {
  const st = box.parentElement
  const max = Math.round((st ? st.clientHeight : window.innerHeight) * 0.72)
  h = Math.max(64, Math.min(h, max))
  box.style.height = h + 'px'
  box.style.maxHeight = h + 'px'
  trigWinSave(Object.assign(trigWinLoad() || {}, { h }))
}
/** 把浮窗钳制在舞台内(至少露出标题栏,拖不出画布) */
function trigClamp(box) {
  const st = box.parentElement
  if (!st) return
  const M = 8
  const maxX = Math.max(M, st.clientWidth - box.offsetWidth - M)
  const maxY = Math.max(M, st.clientHeight - 30 - M)
  box.style.left = Math.min(Math.max(box.offsetLeft, M), maxX) + 'px'
  box.style.top = Math.min(Math.max(box.offsetTop, M), maxY) + 'px'
}
$('#trigToggle').addEventListener('click', () => {
  const panel = $('#trigPanel')
  const hidden = panel.hidden
  panel.hidden = !hidden
  const box = $('#trigbox')
  if (box) {
    box.classList.toggle('expanded', hidden)  // hidden 原=true → 刚展开
    if (hidden) {                  // 刚展开:恢复上次拖出来的高度
      const h = (trigWinLoad() || {}).h || 0
      if (h >= 64) trigApplyH(box, h)
    } else {                        // 刚收起:释放高度,只留标题条
      box.style.height = ''
      box.style.maxHeight = ''
    }
  }
  $('#trigToggle').textContent = trigLabel($('#trigToggle'), hidden)
})
$('#trigClear').addEventListener('click', () => {
  S.scope.clear()
  renderTrigPanel(S.conditions)
  render()
})
/* ── 浮窗交互:标题栏拖动移动 + 底缘调高 + 双击标题栏复位 ── */
function bindTrigWin() {
 try {
  const box = document.getElementById('trigbox')
  const bar = document.getElementById('trigBar')
  if (!box || !bar) return
  /* 恢复上次的位置/高度 */
  const p = trigWinLoad()
  if (p) {
    if (p.h >= 64) trigApplyH(box, p.h)
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      box.style.right = 'auto'
      box.style.left = p.x + 'px'
      box.style.top = p.y + 'px'
    }
  }
  trigClamp(box)
  /* 拖动移动 */
  let d = null
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    /* ★ 标题栏上的按钮是点击目标,不能启动拖动 —— setPointerCapture 会吞掉
       真实点击的 click(参照 music.js 浮窗标题栏的同款教训)。 */
    if (e.target.closest && e.target.closest('button')) return
    e.preventDefault()
    d = { x: e.clientX, y: e.clientY, ox: box.offsetLeft, oy: box.offsetTop }
    try { bar.setPointerCapture(e.pointerId) } catch {}
    box.classList.add('dragging')
  })
  bar.addEventListener('pointermove', (e) => {
    if (!d) return
    box.style.right = 'auto'
    box.style.left = Math.round(d.ox + (e.clientX - d.x)) + 'px'
    box.style.top = Math.round(d.oy + (e.clientY - d.y)) + 'px'
    trigClamp(box)
  })
  function endDrag(e) {
    if (!d) return
    d = null
    box.classList.remove('dragging')
    try { bar.releasePointerCapture(e.pointerId) } catch {}
    trigWinSave(Object.assign(trigWinLoad() || {}, { x: box.offsetLeft, y: box.offsetTop }))
  }
  bar.addEventListener('pointerup', endDrag)
  bar.addEventListener('pointercancel', endDrag)
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('button')) return
    box.style.left = ''; box.style.top = ''; box.style.right = ''
    trigClamp(box)
    trigWinSave(Object.assign(trigWinLoad() || {}, { x: null, y: null }))
  })
  /* 底缘高度握把 */
  const grip = document.getElementById('trigResize')
  if (grip) {
    let r = null
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      r = { y: e.clientY, h: box.getBoundingClientRect().height }
      try { grip.setPointerCapture(e.pointerId) } catch {}
    })
    grip.addEventListener('pointermove', (e) => {
      if (!r) return
      trigApplyH(box, r.h + (r.y - e.clientY))   // 向上拖 → 变高
    })
    function endResize(e) {
      if (!r) return
      r = null
      try { grip.releasePointerCapture(e.pointerId) } catch {}
    }
    grip.addEventListener('pointerup', endResize)
    grip.addEventListener('pointercancel', endResize)
  }
  window.addEventListener('resize', () => trigClamp(box))
 } catch (e2) { console.error('bindTrigWin init failed (non-fatal):', e2 && e2.message) }
}
bindTrigWin()
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
Sizer.onChange(() => applyTransform()) /* 既有 bug:onChange 本身注册的是 resize 监听器,再 dispatch 'resize' 会无限自递归 → 栈溢出。改为直接布局,等价且不循环 */

// ★ 调试句柄:供无头浏览器验收断言用(allow_branch 门控 / offset 坐标联动)。
//   只读暴露内部状态与纯函数,不改变任何行为。
window.FocusApp = { S, coordOf, nodeVisState, buildGating, gatedRevealed }

// ★ 右键菜单 + 快捷键(必须在 Sizer 之后、loadTrees 之前:
//   绑定只依赖已存在的 DOM 节点,不依赖数据)
wireCtxAndKeys()

loadTrees()
