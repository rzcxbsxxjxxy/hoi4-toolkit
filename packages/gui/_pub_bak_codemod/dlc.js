/* DLC 内容浏览器。
 *
 * 一个 DLC 往 common/ 里加的玩法目录(MIO 军工机构 / 特殊工程 / 阵营 / 学说),
 * 按「玩法 → 分组 → 条目」三级呈现,点选看检查器。
 *
 * ★ 为什么要单独一个页面而不是并进"决议树"那类:
 *   ① 这些内容的组织维度不是"前置关系"而是"DLC 归属",放进决议树会挤爆它的分类墙;
 *   ② 每个玩法自己的字段完全不同(工程有 complexity/prototype_time、
 *      军工机构有 equipment_bonus、阵营有 goals/rules 两套形态),
 *      强行统一成一种卡片反而丢信息;
 *   ③ 注册表在 engine/src/dlc.ts,新 DLC 加一条记录即可,前端不用改。
 *
 * 筛选语义与 focus/decisions 一致:
 *   src     '' / base / mod / vanilla / modNew / overridden / 具体来源名
 *   feature 限定某个玩法     dlc 限定某个 DLC     onlyDlc 只看 DLC 专属
 */
const $ = (s) => document.querySelector(s)

const S = {
  features: [],
  byFeature: new Map(),
  installedDlc: [],
  dirGating: [],
  sources: [],
  sources2: [],
  sel: null, // {feature, group, item}
  q: '',
  src: '',
  dlc: '',
  onlyDlc: false,
  total: 0,

  /* ★★★ MIO_TREE_UI:军工机构的链状特质树(替代卡片墙)──
   * 军工机构本质是一张【网格图】:节点有 position(列/行)、有 all_parents/any_parent 连线,
   * 且 include 会继承 generic 底盘。卡片墙把这些关系全压平了,看不出"特质分布"。
   * 所以给军工机构单独走链状视图,像科技树/国策树那样。
   */
  mioOrgs: null,        // 机构清单
  mioStats: null,
  mioOrg: null,         // 当前机构 id
  mioTree: null,        // 当前树的完整数据
  mioSel: null,         // 选中的 token
  mioZoom: 1,
  /* MIO_FILTER_V1:机构清单按模组 / 国家 tag 筛选(只影响左栏列表) */
  mioRoot: '',
  mioTag: '',
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
    if (!api._pg) { api._pg = true; window.Progress.start(`正在构建 DLC 内容图…`) }
  } else if (d && d.ready && window.Progress && api._pg) {
    api._pg = false
    window.Progress.done()
  }
  return d
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/* ── 图标加载已抽到公共件 /tex.js(原来这里和 decisions.js 各抄了一份,
 *    两份都因为把 sprite 名当 tN id 而全部 404)── */

/* ── 来源筛选器(与 focus/decisions 同一套语义与视觉)── */
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
  add('', '全部来源')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  for (const s of S.sources2.filter((x) => !x.base)) add(s.name, srcLabel(s.name), s.path)
  sel.value = S.src
}
const SRC_HINT = {
  '': '',
  base: '最终生效版本来自基础游戏',
  mod: '最终生效版本来自模组',
}
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources2.filter((s) => s.base).length
  const mods = S.sources2.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(`原版 ${base}`)
  if (mods) parts.push(`模组 ${mods}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : '来源:' + srcLabel(S.src)
  el.textContent = parts.length ? `来源 ${parts.join(' / ')}${hint ? ' · ' + hint : ''}` : ''
  el.title = hint
}

/* ── DLC 筛选 ── */
function buildDlcSel() {
  const sel = $('#dlcSel')
  sel.innerHTML = '<option value="">全部 DLC</option>'
  // 只列「在内容里真的出现过」的 DLC,其余(单位包/主题包等纯内容 DLC)没有可提取结构
  const hit = new Map()
  for (const f of S.features) {
    for (const g of f.groups) {
      for (const it of g.items) {
        for (const d of it.hasDlc) hit.set(d, (hit.get(d) ?? 0) + 1)
      }
    }
  }
  for (const [name, n] of [...hit.entries()].sort((a, b) => b[1] - a[1])) {
    const o = document.createElement('option')
    o.value = name
    o.textContent = `${name} (${n})`
    o.title = `按条目自身的 has_dlc = "${name}" 匹配`
    sel.appendChild(o)
  }
  sel.value = S.dlc
}

/* ── 可见性判定 ── */
function srcOk(item) {
  const s = S.src
  if (!s) return true
  if (s === 'base') return item.rootIdx === 0
  if (s === 'mod') return item.rootIdx !== 0
  return item.rootName === s
}
/** 后端 ?src= 已过滤过一次;前端这层只按 rootIdx/rootName 再收一遍,避免两端口径打架 */
function itemVisible(it, rootNames) {
  const s = S.src
  if (!s) return true
  const nm = rootNames[it.root] ?? ''
  if (s === 'base') return nm === 'vanilla'
  if (s === 'mod') return nm !== 'vanilla'
  return nm === s
}

function matchQ(it) {
  const q = S.q
  if (!q) return true
  return (
    it.id.toLowerCase().includes(q) ||
    (it.loc || '').toLowerCase().includes(q) ||
    (it.descLoc || '').toLowerCase().includes(q)
  )
}
function matchDlc(it) {
  if (S.onlyDlc && !it.hasDlc.length) return false
  if (S.dlc && !it.hasDlc.includes(S.dlc) && it.dlc !== S.dlc) return false
  return true
}

/* ── 加载 ── */
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function load() {
  const qp = new URLSearchParams()
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/dlc/content' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : '失败:' + d.error
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  S.features = d.features || []
  S.byFeature = new Map(S.features.map((f) => [f.id, f]))
  S.installedDlc = d.installedDlc || []
  S.dirGating = d.dirGating || []
  S.sources2 = d.sources || []
  S.total = d.totals?.items ?? 0
  /* ★ OWNERSHIP_V1:总数是生效集(同名条目被模组替换后只算一次) */
  S.own = d.own || null
  $('#statChip').textContent = `${S.total} 条内容 / ${d.totals?.features ?? 0} 玩法 / ${S.installedDlc.length} 个 DLC`
  $('#statChip').title = Own.statsLine(S.own)
  if (d.missing?.length) {
    console.warn('[dlc] 注册表里声明但目录不存在(可能 DLC 未购买):', d.missing)
  }
  buildSrcSel()
  buildDlcSel()
  srcSummary()
  renderFeatList()
  renderFeatBar()
  renderDlcList()
  renderGroups()
  renderSum()
}

/* ── 左侧:玩法列表 ── */
function renderFeatList() {
  const box = $('#featList')
  box.innerHTML = ''
  $('#featCount').textContent = String(S.features.length)
  for (const f of S.features) {
    const el = document.createElement('div')
    el.className = 'item' + (S.sel && S.sel.feature === f.id ? ' on' : '')
    el.innerHTML = `<span>${esc(f.label)}</span> <span class="tag">${f.count}</span>`
    el.title = `${f.dir}\nDLC: ${f.dlc}`
    // ★ 数据挂元素(RIGHTCLICK_V2 统一约定,右键/快捷键不按文本反查)
    el.__obj = { _k: 'feature', f }
    el.onclick = () => {
      // ★ 必须无条件设置 S.sel:首次进入时 S.sel 为 null,
      //    若用 `if(S.sel){...}` 守卫会导致 S.sel 保持 null,
      //    使 renderGroups 走 else 分支(显示全部玩法卡片墙 + 不收起 featBar)。
      S.sel = { feature: f.id, group: S.sel ? S.sel.group : null, item: null }
      // ★ 军工机构:左栏从"DLC 清单"切成"机构清单",舞台走链状特质树
      if (f.id === 'mio') {
        S.mioOrg = null; S.mioTree = null; S.mioSel = null
        if (!S.mioOrgs) mioLoadOrgs($('#groups'))
        else { renderMioOrgList(); renderMioStage($('#groups')) }
        $('#dlcTitle').textContent = '机构列表'
      } else {
        S.mioOrg = null; S.mioTree = null; S.mioSel = null
        $('#dlcTitle').textContent = '已安装 DLC'
        renderDlcList()
      }
      renderFeatList()
      renderFeatBar()
      renderGroups()
      renderInsp()
    }
    box.appendChild(el)
  }
}

/* ── DLC 清单 ── */
function renderDlcList() {
  const box = $('#dlcList')
  box.innerHTML = ''
  $('#dlcCount').textContent = String(S.installedDlc.length)
  // 统计每个 DLC 命中了多少条内容(按目录门控清单 + 条目 has_dlc)
  const hit = new Map()
  for (const f of S.features) for (const g of f.groups) for (const it of g.items) for (const d of it.hasDlc) hit.set(d, (hit.get(d) ?? 0) + 1)
  for (const g of S.dirGating) for (const d of g.dlcs) if (!hit.has(d)) hit.set(d, 0)
  const rows = S.installedDlc
    .map((d) => ({ ...d, n: hit.get(d.name) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  for (const d of rows) {
    const el = document.createElement('div')
    el.className = 'drow' + (d.n ? ' hit' : '')
    el.innerHTML =
      `<span class="nm">${esc(d.name)}</span>` +
      (d.category ? `<span class="cat">${esc(d.category)}</span>` : '') +
      `<span class="ct">${d.n || ''}</span>`
    el.title = `${d.dir}${d.n ? `\n内容命中 ${d.n} 条` : '\n该 DLC 未引入可提取的 common 玩法结构'}`
    el.__obj = { _k: 'dlc', d }
    if (d.n) {
      el.style.cursor = 'pointer'
      el.onclick = () => {
        S.dlc = S.dlc === d.name ? '' : d.name
        $('#dlcSel').value = S.dlc
        load()
      }
    }
    box.appendChild(el)
  }
}

/* ── 顶部:玩法切换条 ── */
function renderFeatBar() {
  const bar = $('#featBar')
  bar.innerHTML = ''
  for (const f of S.features) {
    const el = document.createElement('div')
    const on = !S.sel || S.sel.feature === f.id
    el.className = 'feat' + (on ? ' on' : '') + (f.dlc && f.dlc !== '(多 DLC)' ? ' dlc' : '')
    el.innerHTML =
      (f.dlc ? `<span class="ftag">${esc(f.dlc)}</span>` : '') +
      `<div class="fn">${esc(f.label)}</div>` +
      `<div class="fd">common/${esc(f.dir)}</div>` +
      `<div class="fc">${f.count} 条 · ${f.groups.length} 组${f.present ? '' : ' · 目录缺失'}</div>`
    el.title = `DLC: ${f.dlc}\n数据目录: common/${f.dir}\n文件 ${f.stats.files} 个 / 条目自身声明 has_dlc 的 ${f.stats.withHasDlc} 条`
    el.__obj = { _k: 'featbar', f }
    el.onclick = () => {
      S.sel = { feature: f.id, group: null, item: null }
      renderFeatList()
      renderFeatBar()
      renderGroups()
      renderInsp()
    }
    bar.appendChild(el)
  }
  // MIO_FILTER_V1:模组/tag 下拉只在军工机构玩法下显示
  syncMioFilters()
}

/* ── 主区:分组卡片墙 ── */
function rootNames() {
  return S.sources2.map((s) => s.name)
}
/* 渲染单元 → DOM。因为是按顺序追加的,用一个闭包变量记住"当前 .cards",
 * 卡片型的单元直接挂进去,就能重建出原来的「组标题 + 卡片墙」层级。 */
let _curCards = null
function makeGroupUnit(u) {
  if (u.t === 'grp') {
    const wrap = document.createElement('div')
    wrap.className = 'grp'
    const h = document.createElement('div')
    h.className = 'grp-h'
    h.innerHTML = `<span>${esc(u.f.label)} · ${esc(u.g.label)}</span><span class="n">${u.g.count}</span>`
    const cards = document.createElement('div')
    cards.className = 'cards'
    wrap.appendChild(h)
    wrap.appendChild(cards)
    _curCards = cards
    return wrap
  }
  const it = u.it
  const f = u.f
  const g = u.g
  const el = document.createElement('div')
  el.className = 'card' + (S.sel && S.sel.item === it.id && S.sel.feature === f.id ? ' on' : '') + (it.effectiveRoot !== it.root ? ' ovr' : '')
  const hasIcon = !!it.icon
  const badges = []
  if (it.hasDlc.length) badges.push(`<span class="mini dlc" title="${esc(it.hasDlc.join(', '))}">DLC</span>`)
  if (it.gated) badges.push('<span class="mini" title="有 available/visible/allowed 条件">有条件</span>')
  for (const k of Object.keys(it.strs || {})) badges.push(`<span class="mini g" title="${esc(k)}">${esc(String(it.strs[k]).split('.').pop())}</span>`)
  el.innerHTML =
    `<div class="top">` +
    (hasIcon ? `<img class="ic" data-tex="${esc(it.icon)}" alt="">` : `<div class="ic ph">◇</div>`) +
    `<div class="nm">${esc(it.loc || it.id)}</div></div>` +
    `<div class="id">${esc(it.id)}</div>` +
    (badges.length ? `<div class="mt">${badges.join('')}</div>` : '')
  el.title = `${it.id}${it.loc ? `\n本地化: ${it.loc}` : ''}\n${it.file}:${it.line}`
  // ★ 数据挂元素:卡片墙是 incr.js 分批建的,事件委托是唯一稳的接法
  el.__obj = { _k: 'item', it, f, g }
  el.onclick = () => {
    S.sel = { feature: f.id, group: g.id, item: it.id }
    renderGroups()
    renderInsp()
  }
  // 已挂进 _curCards,返回 null 让 incr.js 跳过(否则会被再 append 一次,
  // 等于从 .cards 里挪到容器根部 —— 组层级就没了)
  if (_curCards) _curCards.appendChild(el)
  return null
}

function renderGroups() {
  const box = $('#groups')
  box.innerHTML = ''
  // ★ 军工机构走链状特质树 —— 它本质是网格图,卡片墙会把父子关系压平
  if (S.sel && S.sel.feature === 'mio') {
    // MIO 树是独立框架,把 DLC 页的"上一级框架"(玩法切换条)收起来,避免共存
    const fb = $('#featBar')
    if (fb) fb.style.display = 'none'
    renderMioStage(box)
    return
  }
  // 非 MIO:恢复玩法切换条
  const fb2 = $('#featBar')
  if (fb2) fb2.style.display = ''
  const names = rootNames()
  const list = S.sel ? S.features.filter((f) => f.id === S.sel.feature) : S.features
  /* PERF_V2:1852 条内容一次建完会明显卡。这里把「组标题 + 卡片」展平成一个
   * 渲染单元序列,交给 incr.js 分批建 DOM(滚到底才建下一批)。 */
  const units = []
  let shown = 0
  for (const f of list) {
    for (const g of f.groups) {
      const items = g.items.filter((it) => matchQ(it) && matchDlc(it) && itemVisible(it, names))
      if (!items.length) continue
      shown += items.length
      units.push({ t: 'grp', f: f, g: g })
      for (const it of items) units.push({ t: 'card', f: f, g: g, it: it })
    }
  }
  if (!shown) {
    box.innerHTML = '<div class="empty">没有符合筛选条件的内容</div>'
  } else {
    _curCards = null
    Incr.mount(box, units, makeGroupUnit, {
      batch: 160,
      // 图标懒加载要按批挂:一次性 mount 到整个 box 会漏掉后建的节点
      onBatch: () => Tex.mount(box),
    })
  }
  $('#sum').innerHTML =
    `<span>显示 <b>${shown}</b> / ${S.total} 条</span>` +
    (S.dlc ? `<span>DLC = ${esc(S.dlc)}</span>` : '') +
    (S.onlyDlc ? '<span>仅 DLC 专属</span>' : '') +
    (S.q ? `<span>搜索「${esc(S.q)}」</span>` : '')
}

/* ══════════════════════════════════════════════════════════════════
 * ★★★ 军工机构链状特质树(MIO_TREE_UI)
 *
 * 为什么军工机构不能继续用卡片墙:它在游戏里就是一张【网格图】——
 *   · 每个特质占一格(position = {x 列 y 行})
 *   · all_parents(全满足)/ any_parent(任一满足) 决定解锁 = 连线
 *   · include 继承 generic 底盘(那些节点同样可见、同样参与解锁)
 * 卡片墙把这些关系全压平成"一堆条目",完全看不出特质分布与解锁链。
 *
 * 坐标由后端算好(相对位置按 relative_position_id 逐级累加),前端只画。
 * ══════════════════════════════════════════════════════════════════ */

const MIO_NW = 74, MIO_NH = 74, MIO_PADX = 130, MIO_PADY = 70

/** 拉机构清单(左栏) */
async function mioLoadOrgs(box) {
  try {
    const d = await api('/api/mio/tree')
    if (!d.ready) { setTimeout(() => mioLoadOrgs(box), 1200); return }
    S.mioOrgs = d.orgs || []
    S.mioStats = d.stats
    renderMioOrgList()
    renderMioStage($('#groups'))
  } catch (e) {
    box.innerHTML = '<div class="empty">军工机构加载失败:' + esc(String(e)) + '</div>'
  }
}

/** 拉单棵特质树 */
async function mioLoadTree() {
  try {
    const d = await api('/api/mio/tree?org=' + encodeURIComponent(S.mioOrg))
    if (!d.ready) { setTimeout(mioLoadTree, 1200); return }
    S.mioTree = d
    S.mioSel = null
    /* 本地化:机构 id 与 trait token 都是 localisation key
       (实测 GER_porsche_organization → "$porsche$",GER_mio_trait_hoesch_facilities → "Hoesch Facilities")。
       $xxx$ 是游戏内变量引用,Loc.label 会识别并提示,不直接显示。 */
    /* 列标题文本也是 localisation key(如 mio_header_chassis),一并拉回来 */
    const hdrTexts = (d.columns || []).map((c) => c.text).filter(Boolean)
    Loc.load([S.mioOrg, ...hdrTexts, ...(d.nodes || []).map((n) => n.token)]).then(() => {
      renderMioStage($('#groups'))
      renderInsp()
    })
    renderMioStage($('#groups'))
    renderInsp()
  } catch (e) {
    $('#groups').innerHTML = '<div class="empty">特质树加载失败:' + esc(String(e)) + '</div>'
  }
}

/** 机构文件名 → 国家 tag:MIO_FILTER_V1。
 *  `.../GER_organization.txt` → GER;`00_generic_organization.txt` → GENERIC;
 *  `00_DEBUG_organization.txt` → DEBUG。推导规则稳定,不硬编清单。 */
function mioTagOf(o) {
  const base = String(o.file || '').split(/[\\/]/).pop().replace(/\.txt$/i, '')
  const m = base.match(/^(?:\d+_)?([A-Za-z][A-Za-z0-9]*)_organization$/)
  return (m ? m[1] : base).toUpperCase()
}

/** 模组/tag 下拉:只在军工机构玩法下显示,选项来自当前机构清单 */
function syncMioFilters() {
  const rs = $('#mioRootSel')
  const ts = $('#mioTagSel')
  const isMio = !!(S.sel && S.sel.feature === 'mio')
  rs.style.display = isMio ? '' : 'none'
  ts.style.display = isMio ? '' : 'none'
  if (!isMio) return
  const list = S.mioOrgs || []
  const roots = new Map()
  const tags = new Map()
  for (const o of list) {
    const rn = o.rootName || 'vanilla'
    roots.set(rn, (roots.get(rn) || 0) + 1)
    const tg = mioTagOf(o)
    tags.set(tg, (tags.get(tg) || 0) + 1)
  }
  const fill = (sel, cur, head, map) => {
    sel.innerHTML = ''
    const head0 = document.createElement('option')
    head0.value = ''
    head0.textContent = head
    sel.appendChild(head0)
    for (const [k, n] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const o = document.createElement('option')
      o.value = k
      o.textContent = `${k} (${n})`
      sel.appendChild(o)
    }
    // 当前选择若已不在候选里(来源变了),重置
    sel.value = map.has(cur) ? cur : ''
    if (sel === rs) S.mioRoot = rs.value
    else S.mioTag = ts.value
  }
  fill(rs, S.mioRoot, '全部模组', roots)
  fill(ts, S.mioTag, '全部国家', tags)
}

/** 左侧机构列表(只在军工机构玩法下出现) */
function renderMioOrgList() {
  const box = $('#dlcList')
  if (!box) return
  syncMioFilters()
  box.innerHTML = ''
  const list = S.mioOrgs || []
  $('#dlcCount').textContent = String(list.length)
  const q = S.q.trim().toLowerCase()
  /* id 或译文任一命中即保留 —— 用户看到的是译文,搜的往往也是译文 */
  const rows = list.filter((o) => {
    if (q && !(o.id.toLowerCase().includes(q) || Loc.text(o.id).toLowerCase().includes(q))) return false
    // MIO_FILTER_V1:模组 / 国家 tag 筛选
    if (S.mioRoot && (o.rootName || 'vanilla') !== S.mioRoot) return false
    if (S.mioTag && mioTagOf(o) !== S.mioTag) return false
    return true
  })
  // 有 DLC 门控的排前面(更值得看),其余按名字
  rows.sort((a, b) => (b.hasDlc.length - a.hasDlc.length) || a.id.localeCompare(b.id))
  /* 机构 id 就是 localisation key(实测 GER_porsche_organization → "$porsche$")。
     一次把可见行的 key 全拉回来,渲染时同步读缓存。 */
  Loc.load(rows.map((o) => o.id))
  for (const o of rows) {
    const el = document.createElement('div')
    el.className = 'item' + (S.mioOrg === o.id ? ' on' : '')
    const dl = o.hasDlc.length ? ' <span class="tag dlc">DLC</span>' : ''
    /* 有译文用译文,没有退回 id 去后缀(老行为)。
     * ⚠ MIO_SPELLING_V1(2026-10-06):后缀正则原来只认美式 `_organization`,
     *   英式 `_organisation` / 复数 / `_MIO` 的机构会显示成一长串原始 id,
     *   在列表里根本认不出来(实测模组 44 个机构里 31 个是英式)。
     *   三种拼写都要剥,顺带把 `_MIO` 也去掉。 */
    const nm = Loc.text(o.id) ? Loc.label(o.id, 30) : o.id.replace(/_org[ai]nisations?$|_mio$/i, '')
    el.innerHTML = '<span>' + esc(nm) + '</span>' +
      '<span class="tag">' + o.count + '</span>' + dl +
      /* ★ OWNERSHIP_V1:机构归属三态(模组的机构 = 新增,原版被改写的 = 改写) */
      (Own.of(o) === 'vanilla' ? '' : Own.badge(o))
    el.title = o.id +
      (Loc.text(o.id) ? '\n' + Loc.text(o.id).split('\n')[0] : '') +
      '\n归属: ' + Own.label(o) + ' — ' + Own.hint(o) +
      '\n本国新增 ' + (o.ownTraits ?? 0) + ' 个 / 继承 ' + (o.count - (o.ownTraits ?? 0)) + ' 个' +
      (o.includes.length ? '\ninclude: ' + o.includes.join(', ') : '') +
      (o.hasDlc.length ? '\nDLC: ' + o.hasDlc.join(', ') : '') +
      '\n' + o.file + ':' + o.line
    el.__obj = { _k: 'mioOrg', o }
    el.onclick = () => {
      S.mioOrg = o.id
      renderMioOrgList()
      mioLoadTree()
    }
    box.appendChild(el)
  }
  if (!rows.length) box.innerHTML = '<div class="empty">没有匹配的机构</div>'
}

/** 渲染链状树到舞台(★ MIO_TREE_FRAME:军工机构走自己的独立框架,不再混在 DLC 卡片墙里) */
function renderMioStage(box) {
  if (!box) return
  // ★ 替换而非追加:本函数会被 mioLoadTree 调两次(即时一次 + Loc.load 完成后一次),
  //    若不先清掉上一帧,会叠出两份 frame,导致节点/连线翻倍(验证里 24 vs 12 即此因)。
  const prev = box.querySelector('.mio-frame')
  if (prev) prev.remove()
  if (!S.mioOrgs) {
    box.innerHTML = '<div class="empty">正在加载军工机构…</div>'
    mioLoadOrgs(box)
    return
  }
  if (!S.mioOrg) {
    box.innerHTML = '<div class="empty">左侧选择一个机构,查看它的特质树<br>' +
      '<span style="color:var(--ink3)">共 ' + (S.mioOrgs.length) + ' 个机构 / ' +
      ((S.mioStats && S.mioStats.traits) || 0) + ' 个特质节点</span></div>'
    return
  }
  const T = S.mioTree
  if (!T || T.org !== S.mioOrg) {
    box.innerHTML = '<div class="empty">正在加载特质树…</div>'
    if (S.mioOrg) mioLoadTree()
    return
  }
  const nodes = T.nodes || []
  if (!nodes.length) {
    box.innerHTML = '<div class="empty">该机构没有符合筛选条件的特质</div>'
    return
  }

  let maxX = 0, maxY = 0
  for (const n of nodes) { if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y }
  const W = MIO_PADX * 2 + maxX + MIO_NW
  const H = MIO_PADY * 2 + maxY + MIO_NH

  /* ── 独立外框:标题栏(机构名 / 继承 / DLC)+ 滚动主体。
   *    这样军工机构树有"单独的框架显示",不再与 DLC 页的玩法切换条(上一级框架)共存。 */
  const frame = document.createElement('div')
  frame.className = 'mio-frame'
  const head = document.createElement('div')
  head.className = 'mio-frame-head'
  if (T.icon) {
    const im = document.createElement('img')
    im.className = 'mio-ficon'
    im.dataset.tex = T.icon
    head.appendChild(im)
  }
  const ttl = document.createElement('div')
  ttl.className = 'mio-ftitle'
  ttl.textContent = (Loc.text(T.org) || '').split('\n')[0] || T.org.replace(/_organization$/, '')
  head.appendChild(ttl)
  const meta = document.createElement('div')
  meta.className = 'mio-fmeta'
  const metaParts = [nodes.length + ' 特质']
  if (T.includes && T.includes.length) metaParts.push('继承 ' + T.includes.length + ' 个底盘')
  if (T.hasDlc && T.hasDlc.length) metaParts.push('DLC: ' + T.hasDlc.join(', '))
  if (T.total && T.total !== nodes.length) metaParts.push('总 ' + T.total)
  meta.textContent = metaParts.join(' · ')
  head.appendChild(meta)
  const lg = document.createElement('div')
  lg.className = 'mio-legend'
  lg.innerHTML = '<span class="ln"></span>全满足解锁<span class="ln any"></span>任一满足'
  head.appendChild(lg)
  frame.appendChild(head)

  const view = document.createElement('div')
  view.className = 'mio-view'
  const inner = document.createElement('div')
  inner.className = 'mio-inner'
  inner.style.width = W + 'px'
  inner.style.height = H + 'px'
  inner.style.transform = 'scale(' + (S.mioZoom || 1) + ')'

  /* 列标题 = 本机构自己的【框架 / 段落】(tree_header_text),画成竖向分隔 + 标签,
   * 让"框架"显式可见,而不是所有特质挤在一张无分区的网格里。 */
  const secs = document.createElement('div')
  secs.className = 'mio-secs'
  for (const c of T.columns || []) {
    const s = document.createElement('div')
    s.className = 'mio-sec'
    s.style.left = (MIO_PADX + c.x) + 'px'
    const lab = document.createElement('div')
    lab.className = 'mio-sec-lab'
    lab.textContent = (Loc.text(c.text) || '').split('\n')[0] || c.text
    s.appendChild(lab)
    secs.appendChild(s)
  }
  inner.appendChild(secs)

  // 继承层(上一级 generic 底盘)示意:仅当 inherited 节点局部聚集(不铺满整图)时画边界
  const gen = nodes.filter((n) => n.fromGeneric)
  if (gen.length) {
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity
    for (const n of gen) {
      gx0 = Math.min(gx0, n.x); gy0 = Math.min(gy0, n.y)
      gx1 = Math.max(gx1, n.x + MIO_NW); gy1 = Math.max(gy1, n.y + MIO_NH)
    }
    const cover = (gx1 - gx0) * (gy1 - gy0)
    if (cover < (W - MIO_PADX * 2) * (H - MIO_PADY * 2) * 0.8) {
      const zone = document.createElement('div')
      zone.className = 'mio-genzone'
      zone.style.left = (MIO_PADX + gx0 - 8) + 'px'
      zone.style.top = (MIO_PADY + gy0 - 8) + 'px'
      zone.style.width = (gx1 - gx0 + 16) + 'px'
      zone.style.height = (gy1 - gy0 + 16) + 'px'
      const cap = document.createElement('div')
      cap.className = 'mio-genzone-cap'
      cap.textContent = '继承自通用底盘(上一级框架)'
      zone.appendChild(cap)
      inner.appendChild(zone)
    }
  }

  // 连线(画在节点下层):★ 每个 parent 都画一条,修正"多对多时缺少线"(原先只画 parents[0])
  const posOf = new Map()
  for (const n of nodes) posOf.set(n.token, n)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'mio-links')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  for (const n of nodes) {
    for (const lk of n.links || []) {
      for (const pid of lk.parents) {
        const pn = posOf.get(pid)
        if (!pn) continue
        // 略微弯曲的折线(圆角肘形)—— 全站连线统一风格,实现见 /edgepath.js
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const cx1 = MIO_PADX + pn.x + MIO_NW / 2
        const cy1 = MIO_PADY + pn.y + MIO_NH / 2
        const cx2 = MIO_PADX + n.x + MIO_NW / 2
        const cy2 = MIO_PADY + n.y + MIO_NH / 2
        path.setAttribute('d', edgePathD(cx1, cy1, cx2, cy2, 10))
        // all_parents 实线(全部满足才解锁)/ any_parent 虚线(任一满足)
        path.setAttribute('class', lk.type === 'all' ? 'ln' : 'ln any')
        path.setAttribute('fill', 'none')
        if (lk.parents.length > 1) {
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'title')
          t.textContent = (lk.type === 'all' ? '需全部:' : '任一:') + lk.parents.join(', ')
          path.appendChild(t)
        }
        svg.appendChild(path)
      }
    }
  }
  inner.appendChild(svg)

  // 节点
  for (const n of nodes) {
    const d = document.createElement('div')
    d.className = 'mio-n'
    if (S.mioSel === n.token) d.classList.add('on')
    if (n.fromGeneric) d.classList.add('inh')
    if (n.specialBg) d.classList.add('sp')
    if (n.hasDlc && n.hasDlc.length) d.classList.add('dlc')
    d.style.left = (MIO_PADX + n.x) + 'px'
    d.style.top = (MIO_PADY + n.y) + 'px'
    d.style.width = MIO_NW + 'px'
    d.style.height = MIO_NH + 'px'
    /* 显示名:有本地化就用译文,没有退回短 token(老行为)。
       短 token 只在"查不到译文"时用 —— 译文优先,否则用户看不到真实名称。 */
    const locTxt = Loc.text(n.token).split('\n')[0]
    const short = locTxt
      ? Loc.label(n.token, 26)
      : n.token.replace(/^(generic_|GER_|USA_|[A-Z]{3}_)/, '').replace(/_mio_trait_?/, '') || n.token
    let sum = ''
    const bk = Object.keys(n.bonus || {}).slice(0, 2)
    for (const k of bk) {
      const v = n.bonus[k]
      const label = k.replace(/_/g, ' ').slice(0, 11)
      sum += '<span class="bv' + (v < 0 ? ' neg' : '') + '">' + esc(label) +
        ' ' + (v > 0 ? '+' : '') + (Math.round(v * 1000) / 10) + '%</span>'
    }
    d.innerHTML = (n.icon
      ? '<img data-tex="' + esc(n.icon) + '" alt="">'
      : '<div class="ph">◇</div>') +
      '<div class="tt">' + esc(short) + '</div>' +
      (sum ? '<div class="bs">' + sum + '</div>' : '')
    d.title = n.token +
      (locTxt ? '\n' + locTxt : '') +
      '\n列 ' + n.gx + ' / 行 ' + n.gy +
      (n.relTo ? '\n网格基准: ' + n.relTo : '') +
      (n.links.length ? '\n解锁: ' + n.links.map(function (l) {
        return (l.type === 'all' ? '全部(' : '任一(') + l.parents.join(', ') + ')'
      }).join(' / ') : '') +
      (n.limitTo && n.limitTo.length ? '\n限装备: ' + n.limitTo.join(', ') : '') +
      (n.hasDlc.length ? '\nDLC: ' + n.hasDlc.join(', ') : '') +
      (n.fromGeneric ? '\n(继承自 generic 底盘)' : '') +
      '\n' + n.file + ':' + n.line
    d.__obj = { _k: 'mioNode', n }
    d.onclick = function () {
      S.mioSel = (S.mioSel === n.token) ? null : n.token
      renderMioStage(box)
      renderInsp()
    }
    inner.appendChild(d)
  }

  view.appendChild(inner)
  frame.appendChild(view)
  box.appendChild(frame)
  // ★ 外框整体挂图标(标题栏机构图标 + 节点图标)
  Tex.mount(frame)

  $('#sum').innerHTML =
    '<span><b>' + esc(T.org.replace(/_organization$/, '')) + '</b></span>' +
    '<span>' + nodes.length + ' 特质' + (T.total && T.total !== nodes.length ? ' / ' + T.total : '') + '</span>' +
    (T.includes && T.includes.length ? '<span>继承 ' + T.includes.length + ' 个 generic 底盘</span>' : '') +
    (T.hasDlc && T.hasDlc.length ? '<span>DLC: ' + esc(T.hasDlc.join(', ')) + '</span>' : '')
}

/** 选中节点时,右栏展示它的加成明细(替代 renderInsp 的条目视图) */
function renderMioInsp(box) {
  if (!S.mioTree) { box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个特质</div>'; return }
  const n = (S.mioTree.nodes || []).find((x) => x.token === S.mioSel)
  if (!n) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个特质查看加成<br>' +
      '<span style="font-size:11px">共 ' + (S.mioTree.nodes || []).length + ' 个节点</span></div>'
    return
  }
  const T = S.mioTree
  const kv = (k, v) => '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'
  let h = '<div class="ih"><div class="t">' + esc(Loc.label(n.token, 40)) + '</div>'
  h += '<div class="s">' + esc(Loc.label(T.org, 30)) +
    (n.fromGeneric ? ' · 继承自 generic' : ' · 本国新增') + '</div></div>'
  /* id 始终可见 —— 译文可能缺失或未展开($var$),排查时要能拿到真 id */
  h += '<div class="kv"><span>token</span><b>' + esc(n.token) + '</b></div>'
  h += '<h4>位置</h4>'
  h += kv('网格 列/行', n.gx + ' / ' + n.gy)
  h += kv('像素 画布', Math.round(n.x) + ', ' + Math.round(n.y))
  if (n.relTo) h += kv('网格基准', n.relTo) + '<div class="note">position 是相对该节点的格子偏移，不是相对树原点</div>'
  if (n.links.length) {
    h += '<h4>解锁条件</h4>'
    for (const lk of n.links) {
      h += '<div class="lnk ' + lk.type + '"><b>' + (lk.type === 'all' ? '全部满足' : '任一满足') + '</b>' +
        lk.parents.map((p) => '<code>' + esc(p) + '</code>').join(' ') + '</div>'
    }
  } else h += '<div class="note">无前置条件（起始节点）</div>'
  if (n.limitTo && n.limitTo.length) { h += '<h4>限装备类型</h4><div class="note">' + esc(n.limitTo.join(', ')) + '</div>' }
  if (n.hasDlc && n.hasDlc.length) h += '<h4>DLC 门控</h4><div class="note dl">' + esc(n.hasDlc.join(', ')) + '</div>'
  const bonus = n.bonus || {}
  const bk = Object.keys(bonus)
  if (bk.length) {
    h += '<h4>装备加成（加法/乘法分开）</h4>'
    for (const k of bk) h += kv(k, (bonus[k] > 0 ? '+' : '') + (Math.round(bonus[k] * 1000) / 10) + '%')
  }
  const pb = n.productionBonus || {}
  const pk = Object.keys(pb)
  if (pk.length) {
    h += '<h4>生产加成</h4>'
    for (const k of pk) h += kv(k, (pb[k] > 0 ? '+' : '') + (Math.round(pb[k] * 1000) / 10) + '%')
  }
  h += '<h4>来源</h4>' + kv('文件', n.file.split(/[\\/]/).pop()) + kv('行号', n.line)
  if (n.icon) h += '<h4>图标</h4><div class="note">' + esc(n.icon) + '</div>'
  box.innerHTML = h
}

function renderSum() {
  const g = S.dirGating || []
  const el = $('#sum')
  const top = g.slice(0, 3).map((x) => `${x.dir}(${x.hits})`)
  if (top.length) el.title = 'DLC 门控最密集的目录:' + top.join(' / ')
}

/* ── 检查器 ── */
function renderInsp() {
  const box = $('#insp')
  // ★ 军工机构:右栏展示选中特质的加成明细(链状树视图)
  if (S.sel && S.sel.feature === 'mio') { renderMioInsp(box); return }
  if (!S.sel || !S.sel.item) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一条内容</div>'
    return
  }
  const f = S.byFeature.get(S.sel.feature)
  if (!f) return
  let it = null
  let grp = null
  for (const g of f.groups) for (const x of g.items) if (x.id === S.sel.item) { it = x; grp = g }
  if (!it) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">条目已不在当前筛选结果中</div>'
    return
  }
  const kv = (k, v) => (v ? `<div class="kv"><b>${esc(k)}</b><span>${v}</span></div>` : '')
  const names = rootNames()
  const srcName = names[it.root] ?? '?'
  let h = ''
  h += `<div style="font-weight:650;word-break:break-all;margin-bottom:3px">${esc(it.loc || it.id)}</div>`
  h += `<div style="color:var(--ink3);font-size:11px;word-break:break-all;margin-bottom:6px">${esc(it.id)}</div>`
  h += kv('玩法', esc(f.label))
  h += kv('DLC', esc(f.dlc))
  h += kv('分组', esc(grp.label))
  h += kv('来源', `${esc(srcName)}`)
  h += kv('位置', `${esc(it.file)}:${it.line}`)
  if (it.icon) h += kv('图标', `<code>${esc(it.icon)}</code>`)

  if (it.hasDlc.length) {
    h += `<h4>DLC 门控</h4><div>${it.hasDlc.map((d) => `<span class="tagr">has_dlc = "${esc(d)}"</span>`).join('')}</div>`
  }
  if (it.macros?.length) {
    h += `<h4>DLC 专用宏</h4><div>${it.macros.map((d) => `<span class="tagr">${esc(d)}</span>`).join('')}</div>`
  }
  const nums = Object.entries(it.nums || {})
  if (nums.length) {
    h += `<h4>数值</h4>` + nums.map(([k, v]) => kv(k, String(v))).join('')
  }
  const strs = Object.entries(it.strs || {})
  if (strs.length) {
    h += `<h4>枚举字段</h4>` + strs.map(([k, v]) => kv(k, `<code>${esc(v)}</code>`)).join('')
  }
  const tags = Object.entries(it.tags || {}).filter(([, v]) => v.length)
  if (tags.length) {
    h += `<h4>列表字段</h4>`
    for (const [k, v] of tags) {
      h += `<div style="margin:2px 0"><span style="color:var(--ink2);font-size:11px">${esc(k)} (${v.length})</span><div>${v
        .slice(0, 24)
        .map((x) => `<span class="tagr">${esc(x)}</span>`)
        .join('')}${v.length > 24 ? `<span class="tagr">…另 ${v.length - 24} 个</span>` : ''}</div></div>`
    }
  }
  const raw = Object.entries(it.raw || {})
  if (raw.length) {
    h += `<h4>其它字段 ${raw.length < it.rawTotal ? `(${raw.length}/${it.rawTotal})` : `(${raw.length})`}</h4>`
    h += raw.map(([k, v]) => kv(k, `<code>${esc(v)}</code>`)).join('')
    if (raw.length < it.rawTotal) h += `<div class="warnrow">另有 ${it.rawTotal - raw.length} 个字段未显示</div>`
  }
  if (it.gated) {
    h += `<h4>可用性</h4><div class="warnrow">该条目带 available / visible / allowed 条件,并非所有国家 / 状态都可用</div>`
  }
  box.innerHTML = h
}

/* ── 事件 ── */
let qt = null
$('#q').oninput = (e) => {
  S.q = e.target.value.trim().toLowerCase()
  clearTimeout(qt)
  qt = setTimeout(() => {
    renderGroups()
    renderInsp()
    // 军工机构模式下左栏列表也要跟着搜索词收窄
    if (S.sel && S.sel.feature === 'mio' && S.mioOrgs) renderMioOrgList()
  }, 180)
}
$('#srcSel').onchange = (e) => {
  S.src = e.target.value
  load()
}
$('#dlcSel').onchange = (e) => {
  S.dlc = e.target.value
  load()
}
$('#onlyDlc').onchange = (e) => {
  S.onlyDlc = e.target.checked
  load()
}
/* MIO_FILTER_V1:军工机构按模组 / 国家 tag 筛选(纯前端过滤,不需回源) */
$('#mioRootSel').onchange = (e) => {
  S.mioRoot = e.target.value
  renderMioOrgList()
}
$('#mioTagSel').onchange = (e) => {
  S.mioTag = e.target.value
  renderMioOrgList()
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#q')) {
    e.preventDefault()
    $('#q').focus()
  }
})

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

/* ══════════════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V2)
 *
 * dlc 页有**五种**可右键对象,语义完全不同,分开给菜单:
 *   feature 左栏玩法 / dlc 已装 DLC / featbar 顶部玩法卡
 *   item  内容卡片 / mioOrg 军工机构 / mioNode 特质树节点
 *
 * ⚠ 三层来源语义(和 focus/tech 一致,别混):
 *   it.root           条目自己声明在哪个来源
 *   it.effectiveRoot  最终生效的那份来自哪个来源(origin=vanilla 被模组覆盖时,
 *                     两者不同 —— 卡片上的 .ovr 类就是靠它)
 *   rootNames()[i]    来源名数组,下标即 root 序号
 * ══════════════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire || !window.Ctx) return
  const names = () => rootNames()

  /* ── 内容卡片 ── */
  CtxWire.attach({
    page: 'dlc',
    on: [{
      host: '#groups', sel: '.card',
      resolve: (el) => el,
      obj: (el) => {
        const o = el.__obj
        if (!o || o._k !== 'item') return null
        return {
          id: o.it.id,
          loc: o.it.loc,
          file: o.it.file,
          line: o.it.line,
          root: o.it.effectiveRoot,
          rootName: names()[o.it.effectiveRoot] ?? '',
          _o: o,
        }
      },
      items: (o) => {
        const { it, f, g } = o._o
        const extra = []
        const on = S.sel && S.sel.item === it.id && S.sel.feature === f.id
        extra.push({ label: on ? '在检查器中查看' : '选中这条内容', k: '→', act: () => {
          S.sel = { feature: f.id, group: g.id, item: it.id }
          renderGroups(); renderInsp()
        } })
        if (it.loc && it.loc !== it.id) {
          extra.push({ label: '复制本地化 key', k: '⧉', act: () => Ctx.copy(it.loc, '') })
        }
        if (it.icon) extra.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(it.icon, '') })
        extra.push({ label: '只看这个 DLC(' + f.dlc + ')', k: '→', act: () => {
          if (!S.installedDlc.some((x) => x.name === f.dlc)) {
            Ctx.toast('「' + f.dlc + '」不在已安装 DLC 清单里 —— 条目可能只是声明了 has_dlc', true); return
          }
          S.dlc = f.dlc; $('#dlcSel').value = f.dlc; load()
        } })
        if (it.hasDlc.length) {
          extra.push({ sep: true })
          extra.push({ label: '只勾「' + it.hasDlc[0] + '」的 DLC 筛选', k: '→', act: () => {
            S.dlc = it.hasDlc[0]; $('#dlcSel').value = S.dlc; load()
          } })
        }
        if (it.root !== it.effectiveRoot) {
          extra.push({ sep: true })
          extra.push({ title: `声明在 ${names()[it.root] ?? '?'},生效的是 ${names()[it.effectiveRoot] ?? '?'}` })
          extra.push({ label: '复制覆盖链(两处路径)', k: '⧉', act: () => {
            Ctx.copy(`${names()[it.root] ?? '?'}\t${it.file}:${it.line}`, '')
          } })
        }
        if (it.gated) {
          extra.push({ sep: true })
          extra.push({ title: '该条目带 available / visible / allowed 条件 —— 并非所有国家 / 状态都可用' })
        }
        // 整条内容复制成 KV,方便贴到工单 / 笔记
        extra.push({ sep: true })
        extra.push({ label: '复制整条内容(KV)', k: '⧉', act: () => {
          const kv = [`id = ${it.id}`]
          if (it.loc) kv.push(`loc = ${it.loc}`)
          kv.push(`feature = ${f.id}(${f.label})`, `dlc = ${f.dlc}`, `group = ${g.label}(${g.id})`)
          for (const [k, v] of Object.entries(it.nums || {})) kv.push(`${k} = ${v}`)
          for (const [k, v] of Object.entries(it.strs || {})) kv.push(`${k} = ${v}`)
          for (const [k, v] of Object.entries(it.tags || {})) if (v.length) kv.push(`${k} = ${v.join(', ')}`)
          kv.push(`file = ${it.file}:${it.line}`)
          Ctx.copy(kv.join('\n'), '')
        } })
        return extra
      },
    }],
    keys: [].concat([
      { id: 'find.search', desc: '聚焦搜索框', group: '查找', run: () => { const q = $('#q'); if (q) { q.focus(); q.select && q.select() } } },
      { id: 'nav.nextItem', desc: '下一条卡片', group: '浏览', run: () => stepCard(1) },
      { id: 'nav.prevItem', desc: '上一条卡片', group: '浏览', run: () => stepCard(-1) },
      { id: 'sel.clear', desc: '取消选择 / 清搜索', group: '选中', run: () => {
        if (S.sel && S.sel.item) { S.sel = { ...S.sel, item: null }; renderGroups(); renderInsp(); return }
        if (S.sel && S.sel.feature) { S.sel = null; renderFeatList(); renderFeatBar(); renderGroups(); renderInsp(); return }
        if (S.q) { S.q = ''; $('#q').value = ''; renderGroups(); renderInsp(); if (S.mioOrgs) renderMioOrgList() }
      } },
      { id: 'dlc.onlyDlc', desc: '只看 DLC 专属', group: '筛选', run: () => {
        S.onlyDlc = !S.onlyDlc; $('#onlyDlc').checked = S.onlyDlc; load()
      } },
      { id: 'dlc.clearDlc', desc: '清除 DLC 筛选', group: '筛选', run: () => {
        if (!S.dlc) { Ctx.toast('当前没有 DLC 筛选'); return }
        S.dlc = ''; $('#dlcSel').value = ''; load()
      } },
    ], CtxWire.commonKeys(curItemId, { label: '内容' })),
  })

  /* ── 左栏玩法 / DLC 清单 ── */
  const sideCtx = (host, sel, kind) => Ctx.attach(host, sel, (el) => {
    const o = el.__obj
    if (!o || o._k !== kind) return null
    if (kind === 'feature') {
      const f = o.f
      const on = S.sel && S.sel.feature === f.id
      return [
        { label: on ? '取消玩法筛选' : '只看这个玩法', k: '→', act: () => {
          S.sel = on ? null : { feature: f.id, group: null, item: null }
          renderFeatList(); renderFeatBar(); renderGroups(); renderInsp()
        } },
        { label: '复制玩法 id', k: '⧉', act: () => Ctx.copy(f.id, '') },
        { label: '复制数据目录', k: '⧉', act: () => Ctx.copy('common/' + f.dir, '') },
        { label: '复制统计', k: '⧉', act: () => Ctx.copy(
          `${f.label}\t${f.count} 条\t${f.groups.length} 组\t文件 ${f.stats.files}\tDLC ${f.dlc}\t覆盖 ${f.stats.overridden}\t新增 ${f.stats.modNew}`, '') },
      ]
    }
    const d = o.d
    return [
      { label: S.dlc === d.name ? '清除这个 DLC 筛选' : '只看这个 DLC', k: '→', dis: !d.n, act: () => {
        S.dlc = S.dlc === d.name ? '' : d.name; $('#dlcSel').value = S.dlc; load()
      } },
      { label: '复制 DLC 名', k: '⧉', act: () => Ctx.copy(d.name, '') },
      { label: '复制 DLC 目录', k: '⧉', act: () => Ctx.copy(d.dir, '') },
      { title: d.n ? `命中 ${d.n} 条内容` : '该 DLC 未引入可提取的 common 玩法结构' },
    ]
  })
  sideCtx('#featList', '.item', 'feature')
  sideCtx('#dlcList', '.drow', 'dlc')

  /* ── 顶部玩法卡 ── */
  Ctx.attach('#featBar', '.feat', (el) => {
    const o = el.__obj
    if (!o || o._k !== 'featbar') return null
    const f = o.f
    const on = !S.sel || S.sel.feature === f.id
    const st = f.stats
    return [
      { title: `${f.label}\ncommon/${f.dir}\nDLC ${f.dlc}` },
      { label: on ? '取消玩法筛选' : '只看这个玩法', k: '→', act: () => {
        S.sel = on ? null : { feature: f.id, group: null, item: null }
        renderFeatList(); renderFeatBar(); renderGroups(); renderInsp()
      } },
      { label: '复制玩法 id', k: '⧉', act: () => Ctx.copy(f.id, '') },
      { label: '复制统计', k: '⧉', act: () => Ctx.copy(
        `条目 ${st.items}\n组 ${st.groups}\n文件 ${st.files}\n自身带 has_dlc ${st.withHasDlc}\n被覆盖 ${st.overridden}\n模组新增 ${st.modNew}`, '') },
      { title: f.present ? '' : '⚠ 目录在已挂载来源里不存在' },
    ]
  })

  /* ── 军工机构 ──
   * 单独接,不走 CtxWire 的 on 通道:菜单要按 _k 分派三种对象
   * (机构 / 特质节点),而通道只支持一种 selector。 */
  Ctx.attach('#dlcList', '.item', (el) => {
    const o = el.__obj
    if (!o || o._k !== 'mioOrg') return null
    const org = o.o
    const on = S.mioOrg === org.id
    const extra = [
      { label: on ? '取消机构筛选' : '查看这个机构的特质树', k: '→', act: () => {
        S.mioOrg = on ? null : org.id
        renderMioOrgList(); mioLoadTree()
      } },
      { label: '复制机构 id', k: '⧉', act: () => Ctx.copy(org.id, '') },
      { label: '复制机构名(去 _organization)', k: '⧉', act: () => Ctx.copy(org.id.replace(/_organization$/, ''), '') },
      { label: '只在搜索框里找它', k: '→', act: () => {
        S.q = org.id.toLowerCase(); $('#q').value = org.id; renderMioOrgList()
      } },
    ]
    if (org.includes.length) {
      extra.push({ sep: true })
      extra.push({ label: '复制 include 底盘(' + org.includes.length + ')', k: '⧉', act: () => Ctx.copy(org.includes.join('\n'), '') })
    }
    if (org.hasDlc.length) {
      extra.push({ label: '只看 ' + org.hasDlc[0], k: '→', act: () => {
        S.dlc = org.hasDlc[0]; $('#dlcSel').value = S.dlc; load()
      } })
    }
    if (org.rootName && org.rootName !== 'vanilla') {
      extra.push({ sep: true })
      extra.push({ label: '只看来自 ' + org.rootName + ' 的机构', k: '→', act: () => {
        S.mioRoot = org.rootName; const s = $('#mioRootSel'); if (s) s.value = org.rootName
        renderMioOrgList()
      } })
    }
    return Ctx.sourceItems({
      // ★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开模组文件失败」):
      //   原先硬编码 `root: -1`(= 无来源),于是 DLC 页的 MIO 机构完全没有
      //   「在 IDE 中打开 / 用 VS Code 打开」—— 用户看到的就是"打不开"。
      //   后端 mio/tree 的 orgs 与 nodes 现在都下发真实 root/rootName。
      root: typeof org.root === 'number' && org.root >= 0 ? org.root : -1,
      rootName: org.rootName || '',
      file: org.file, line: org.line,
      id: org.id, loc: org.id, extra,
    })
  })
  Ctx.attach('#groups', '.mio-n', (el) => {
    const o = el.__obj
    if (!o || o._k !== 'mioNode') return null
    const n = o.n
    const on = S.mioSel === n.token
    const extra = []
    if (n.links && n.links.length) {
      for (const lk of n.links) {
        for (const pid of lk.parents) {
          extra.push({
            label: (lk.type === 'all' ? '跳到前置(需全部) ' : '跳到前置(任一) ') + pid,
            k: '→',
            act: () => { S.mioSel = pid; renderMioStage($('#groups')); renderInsp() },
          })
        }
      }
    }
    if (n.limitTo && n.limitTo.length) {
      extra.push({ sep: true })
      extra.push({ label: '复制限装备清单', k: '⧉', act: () => Ctx.copy(n.limitTo.join('\n'), '') })
    }
    if (n.bonus && Object.keys(n.bonus).length) {
      extra.push({ label: '复制全部加成', k: '⧉', act: () => Ctx.copy(
        Object.entries(n.bonus).map(([k, v]) => `${k} = ${v}`).join('\n'), '') })
    }
    if (n.fromGeneric) {
      extra.push({ sep: true })
      extra.push({ title: '继承自 generic 底盘 —— 改它要改 generic,本体不生效' })
    }
    if (n.icon) extra.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(n.icon, '') })
    return Ctx.sourceItems({
      // ★ RIGHTCLICK_ROOT_V1:同机构菜单,用真实来源(原为 -1 = 打不开)
      root: typeof n.root === 'number' && n.root >= 0 ? n.root : -1,
      rootName: n.rootName || '',
      file: n.file, line: n.line,
      id: n.token, extra,
    })
  })
}

/** 卡片墙里上下移动(左栏是机构列表时改成在机构间移动) */
function stepCard(d) {
  if (S.sel && S.sel.feature === 'mio') {
    const list = [...document.querySelectorAll('#dlcList .item')]
    if (!list.length) return
    const cur = list.findIndex((x) => x.classList.contains('on'))
    const j = cur < 0 ? 0 : cur + d
    if (j < 0 || j >= list.length) return
    list[j].click()
    list[j].scrollIntoView({ block: 'nearest' })
    return
  }
  const list = [...document.querySelectorAll('#groups .card')]
  if (!list.length) return
  const cur = list.findIndex((x) => x.classList.contains('on'))
  const j = cur < 0 ? 0 : cur + d
  if (j < 0 || j >= list.length) return
  list[j].click()
  list[j].scrollIntoView({ block: 'nearest' })
}

function curItemId() {
  if (S.sel && S.sel.item) return S.sel.item
  if (S.sel && S.sel.feature === 'mio' && S.mioSel) return S.mioSel
  if (S.mioOrg) return S.mioOrg
  return null
}

wireCtxAndKeys()
load()
