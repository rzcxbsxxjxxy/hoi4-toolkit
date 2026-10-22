/* ════════════════════════════════════════════════════════════════════════
 *  学说系统 —— 类别 → 主要学说 → 轨道 → 次要学说
 * ════════════════════════════════════════════════════════════════════════
 *
 * ── 数据实况(vanilla 4 页签 / 12 主要学说 / 14 轨道 / 95 次要学说 / 474 奖励)──
 *
 * ① **同一类别下,所有主要学说共享同一组轨道**。
 *    land 的 4 个主要学说都写 tracks = { infantry combat_support armor operations }。
 *    所以"轨道"是【类别级】实体 —— 把轨道挂在每个主要学说下面,
 *    等于把同样的四行内容重复四遍。故版面上轨道与主要学说平级。
 *
 * ② ★ 本版修掉的两个真 bug:
 *    BUG-A 图标全空白。各页都把 sprite 名(GFX_xxx)塞进 /api/tex?id=,
 *          而后端只认内部 tN id → 全 404。现由公共件 tex.js + 后端
 *          resolveTexId() 一起修好,并顺手支持 frameAnimatedSpriteType 按帧裁剪。
 *    BUG-B 次要学说显示成裸 id。"Mobile Infantry" 的 loc key 是
 *          `SUBDOCTRINE_MOBILE_INFANTRY`(存在 .loc 字段里),
 *          而旧代码 Loc.load([...].map(x => x.id)) 请求的是 `mobile_infantry`
 *          → 永远查不到。现在同时请求 id 与 loc 两条链。
 *
 * ③ ★ 版面重做(用户反馈"无法查看其他次要学说"):
 *    旧版每个轨道默认只渲染 1 条,95 条里只有 14 条可见,而展开开关
 *    藏在顶栏第三组里。现改为:
 *      - 默认全展开,次要学说按自适应网格铺(2~4 列)
 *      - 轨道折叠状态是显式用户选择,才写 localStorage
 *      - 轨道标题右侧标"N 选 1",互斥关系直接可见
 *      - 检查器里列出同轨其它候选并可点击跳转
 */
const $ = (s) => document.querySelector(s)

/* ══════════════════════════════════════════════════════════════════════
 * 名称解析:三条独立来源,优先级从高到低
 *   ① 手写中文映射(用户直接看到的中文,比机翻可信)
 *   ② 本地化 .loc 字段指向的 key(★不是 id —— 见 BUG-B)
 *   ③ 数据文件里的原始 id
 * ══════════════════════════════════════════════════════════════════════ */
const FOLDER_CN = { land: '陆军', naval: '海军', air: '空军', special_forces: '特种部队' }
const TRACK_CN = {
  infantry: '步兵', combat_support: '炮兵战斗支援', armor: '装甲', operations: '作战',
  capital_ships: '主力舰', carriers: '航空母舰', screens: '护航', submarines: '潜艇',
  fighter_aircraft: '战斗机', strike_aircraft: '攻击机',
  medium_aircraft: '中型飞机', heavy_aircraft: '重型飞机',
  special_forces_first: '特种部队', special_forces_second: '特种部队',
}
const GRAND_CN = {
  new_mobile_warfare: '机动作战', superior_firepower: '火力优势',
  grand_battleplan: '大计划', mass_assault: '密集突击',
  new_fleet_in_being: '既存舰队',
  // ⚠ 本地化原文是 "Trade Interdiction"(贸易封锁),不是 id 字面的"护航突击"
  new_convoy_raiding: '贸易封锁', new_base_strike: '基地打击',
  new_strategic_destruction: '战略打击', new_battlefield_support: '战场支援',
  new_operational_integrity: '作战完整性',
  special_forces_quantity: '扩编特种部队', special_forces_quality: '精英特种部队',
}
/** 严格取译文:查不到返回 '' —— 用于兜底链中间环节(Loc.label 查不到会返回 key) */
const locText = (k) => (k ? Loc.text(k).split('\n')[0] : '')

const cnTrack = (t) => TRACK_CN[t.id] || locText(t.loc) || t.id
const cnGrand = (g) => GRAND_CN[g.id] || locText(g.loc) || g.id
const cnFolder = (f) => FOLDER_CN[f.id] || locText(f.loc) || f.id
const cnSub = (s) => locText(s.loc) || s.id

/** 该条目要查的本地化 key:loc 优先,id 兜底(有些模组直接拿 id 当 key) */
const locKeysOf = (x) => [x.loc, x.id].filter(Boolean)

const S = {
  folders: [],
  grand: [],
  tracks: [],
  subs: [],
  byGrand: new Map(),
  byTrack: new Map(),
  byId: new Map(),
  trackById: new Map(),
  issues: [],
  stats: null,
  q: '',
  folder: '',
  onlyDlc: false,
  oneTrack: false,
  sel: null, // {kind:'grand'|'track'|'sub', id}
  /** 用户显式折叠的轨道(只有显式收起才记,默认全展开) */
  closed: new Set(JSON.parse(localStorage.getItem('gui.doctrines.closed') || '[]')),
  src: '',
}

function saveClosed() {
  localStorage.setItem('gui.doctrines.closed', JSON.stringify([...S.closed]))
}

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 3600)
}
/* PROGRESS_V1(2026-10-07):钩在 api() 内部,不包装全局函数(见 focus.js 同处注释) */
async function api(u) {
  const d = await (await fetch(u)).json()
  // 只有「真在构建」(ready:false + busy:true)才拉进度条,普通查询不受影响
  if (d && d.ready === false && d.busy && window.Progress) {
    if (!api._pg) { api._pg = true; window.Progress.start('正在构建学说图…') }
  } else if (d && d.ready && window.Progress && api._pg) {
    api._pg = false
    window.Progress.done()
  }
  return d
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** 图标 <img>;无贴图时给一个占位方块,不留空白洞 */
function iconHtml(tex, cls, ph) {
  return tex
    ? `<img class="${cls}" data-tex="${esc(tex)}" alt="">`
    : `<span class="${cls} ph">${ph || ''}</span>`
}

/* ── 加载 ── */
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function load() {
  const qp = new URLSearchParams()
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/doctrines/graph' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : '失败:' + d.error
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  S.folders = d.folders || []
  S.grand = d.grand || []
  S.tracks = d.tracks || []
  S.subs = d.subdoctrines || []
  S.issues = d.issues || []
  S.stats = d.stats || {}
  /* ★ OWNERSHIP_V1:学说同样按"同名整份替换"生效,统计走生效集 */
  S.own = d.own || null

  S.byGrand = new Map()
  for (const g of S.grand) {
    if (!S.byGrand.has(g.folder)) S.byGrand.set(g.folder, [])
    S.byGrand.get(g.folder).push(g)
  }
  S.trackById = new Map(S.tracks.map((t) => [t.id, t]))
  S.byTrack = new Map()
  for (const s of S.subs) {
    // 一条 subdoctrine 可能挂多条轨道(special_forces 的 8 条就是双轨),每条都要登记
    for (const t of s.tracks.length ? s.tracks : [s.track]) {
      if (!t) continue
      if (!S.byTrack.has(t)) S.byTrack.set(t, [])
      S.byTrack.get(t).push(s)
    }
  }
  S.byId = new Map()
  for (const g of S.grand) S.byId.set('grand:' + g.id, g)
  for (const t of S.tracks) S.byId.set('track:' + t.id, t)
  for (const s of S.subs) S.byId.set('sub:' + s.id, s)

  const st = S.stats
  $('#statChip').textContent =
    `${st.folders} 页签 / ${st.grand} 主要学说 / ${st.tracks} 轨道 / ${st.subdoctrines} 次要学说 / ${st.rewards} 奖励`
  $('#statChip').title = Own.statsLine(S.own)

  buildFolderSel()
  renderFolderList()
  renderIssues()

  /* ★ 先拉本地化再首绘:名称要在第一帧就是中文/英文,
     否则会闪一下裸 id 再变文字(旧版就是这个闪)。 */
  const keys = []
  for (const x of [...S.folders, ...S.grand, ...S.tracks, ...S.subs]) keys.push(...locKeysOf(x))
  await Loc.load(keys)
  renderTree()
  renderInsp()

  /* 图标懒加载:先查尺寸(只读 DDS 头,不解码像素),给占位定好宽高比 */
  Tex.info(collectTexNames()).then((info) => {
    for (const img of document.querySelectorAll('#tree img[data-tex]')) {
      const it = info[img.dataset.tex]
      if (it && it.ok && it.w && it.h) img.style.aspectRatio = `${it.w} / ${it.h}`
    }
  })
  Tex.mount($('#tree'))

  const mods = (d.sources || []).filter((s) => !s.base).length
  $('#srcSum').textContent = mods ? `已挂模组 ${mods} 个` : ''
}

/** 当前视图里会用到的全部贴图名(用于批量查尺寸) */
function collectTexNames() {
  const out = []
  for (const g of S.grand) if (g.icon) out.push(g.icon)
  for (const t of S.tracks) if (t.icon) out.push(t.icon)
  for (const s of S.subs) if (s.icon) out.push(s.icon)
  return out
}

/* ── 左侧 ── */
function buildFolderSel() {
  const sel = $('#folderSel')
  sel.innerHTML = '<option value="">全部页签</option>'
  for (const f of S.folders) {
    const o = document.createElement('option')
    o.value = f.id
    const tags = []
    if (f.ledger) tags.push(f.ledger)
    if (f.dlcGated) tags.push('DLC')
    o.textContent = `${cnFolder(f)} (${f.count})${tags.length ? ' · ' + tags.join('/') : ''}`
    sel.appendChild(o)
  }
  sel.value = S.folder
}
function renderFolderList() {
  const box = $('#fList')
  box.innerHTML = ''
  $('#fCount').textContent = String(S.folders.length)
  const mk = (id, label, count, title) => {
    const el = document.createElement('div')
    el.className = 'item' + (S.folder === id ? ' on' : '')
    el.innerHTML = `<span>${esc(label)}</span> <span class="tag">${count}</span>`
    el.title = title
    el.onclick = () => {
      S.folder = S.folder === id ? '' : id
      $('#folderSel').value = S.folder
      renderFolderList()
      renderTree()
    }
    box.appendChild(el)
  }
  mk('', '全部页签', S.grand.length, '显示所有页签')
  for (const f of S.folders) {
    // 轨道数要去重:同一类别的所有主要学说写的是同一组 tracks,
    // 直接相加会得到 "4 个主要学说 × 4 轨道 = 16 个轨道" 的假象
    const uniq = new Set((S.byGrand.get(f.id) || []).flatMap((g) => g.tracks)).size
    mk(
      f.id,
      cnFolder(f),
      f.count,
      `folder = ${f.id}\nledger = ${f.ledger || '—'}\n` +
        `${f.count} 个主要学说 · ${uniq} 个轨道(去重后)\n` +
        `DLC 门控: ${f.dlcGated ? f.hasDlc.join(', ') || '有条件' : '无'}`,
    )
  }
}
function renderIssues() {
  const box = $('#issList')
  box.innerHTML = ''
  $('#iCount').textContent = String(S.issues.length)
  if (!S.issues.length) {
    box.innerHTML =
      '<div class="iss ok"><div class="k">无异常</div><div class="d">层级引用完整,无孤儿轨道 / 未知页签</div></div>'
    return
  }
  const KIND_CN = {
    orphanTrack: '孤儿',
    unknownTrack: '未知轨道',
    unknownFolder: '未知页签',
    noGrandDoctrine: '空页签',
    noSubdoctrine: '空轨道',
  }
  for (const i of S.issues) {
    const el = document.createElement('div')
    el.className = 'iss'
    el.innerHTML = `<div class="k">${esc(KIND_CN[i.kind] || i.kind)} · ${esc(i.id)}</div><div class="d">${esc(i.detail)}</div>`
    if (i.file) el.title = `${i.file}:${i.line}`
    box.appendChild(el)
  }
}

/* ── 筛选 ── */
function matchSub(s) {
  if (S.onlyDlc && !s.hasDlc?.length) return false
  if (!S.q) return true
  const q = S.q
  return (
    s.id.toLowerCase().includes(q) ||
    (s.loc || '').toLowerCase().includes(q) ||
    cnSub(s).toLowerCase().includes(q) ||
    Object.keys(s.effects || {}).some((k) => k.toLowerCase().includes(q)) ||
    (s.rewards || []).some((r) => r.id.toLowerCase().includes(q) || r.keys.some((k) => k.toLowerCase().includes(q)))
  )
}
function grandMatch(g) {
  if (S.folder && g.folder !== S.folder) return false
  if (S.onlyDlc) {
    const f = S.folders.find((x) => x.id === g.folder)
    if (!f || !f.dlcGated) return false
  }
  if (!S.q) return true
  const q = S.q
  if (g.id.toLowerCase().includes(q) || (g.loc || '').toLowerCase().includes(q)) return true
  if (cnGrand(g).toLowerCase().includes(q)) return true
  if (Object.keys(g.effects || {}).some((k) => k.toLowerCase().includes(q))) return true
  for (const t of g.tracks) if (t.toLowerCase().includes(q)) return true
  for (const s of S.byTrack.get(t) || []) if (matchSub(s)) return true
  return false
}

/* ══════════════════════════════════════════════════════════════════════
 *  主区渲染
 * ══════════════════════════════════════════════════════════════════════ */
function renderTree() {
  const box = $('#tree')
  box.innerHTML = ''
  const list = S.folders.filter((f) => !S.folder || f.id === S.folder)
  let any = false
  for (const f of list) {
    const gds = (S.byGrand.get(f.id) || []).filter(grandMatch)
    if (!gds.length) continue
    any = true
    box.appendChild(folderSection(f, gds))
  }
  if (!any) {
    box.innerHTML = '<div class="hint" style="padding:40px;text-align:center">没有符合筛选条件的学说</div>'
    return
  }
  Tex.mount(box)
}

function folderSection(f, gds) {
  const sec = document.createElement('div')
  sec.className = 'fsec'

  /* ── 类别头 ── */
  const head = document.createElement('div')
  head.className = 'fhead'
  head.__obj = f // 右键菜单用
  const nTracks = new Set(gds.flatMap((g) => g.tracks)).size
  const nSubs = new Set(gds.flatMap((g) => g.tracks).flatMap((t) => (S.byTrack.get(t) || []).map((s) => s.id))).size
  head.innerHTML =
    `<span class="cf" style="background:${folderColor(f.colorFrame)}"></span>` +
    iconHtml(f.ledgerGfx, 'ic', '⚔') +
    `<span class="nm">${esc(cnFolder(f))}</span>` +
    `<span class="n">${gds.length} 主要学说 · ${nTracks} 轨道 · ${nSubs} 次要学说</span>` +
    `<span class="sp"></span>` +
    (f.dlcGated ? `<span class="mini dlc">DLC</span>` : '') +
    `<span class="mini" style="cursor:pointer" data-only>只看此类</span>`
  head.title =
    `folder = ${f.id}\nledger = ${f.ledger || '—'}\n` +
    `${f.dlcGated ? 'DLC 门控: ' + f.hasDlc.join(', ') : '无 DLC 门控'}\n` +
    `位置: ${f.file}:${f.line}`
  head.querySelector('[data-only]').onclick = (e) => {
    e.stopPropagation()
    S.folder = S.folder === f.id ? '' : f.id
    $('#folderSel').value = S.folder
    renderFolderList()
    renderTree()
  }
  sec.appendChild(head)

  const body = document.createElement('div')
  body.className = 'fbody'

  /* ── ① 主要学说 ── */
  const h1 = document.createElement('div')
  h1.className = 'sechead'
  h1.innerHTML = `主要学说<span class="hint">互斥根 · 选一个开全下面 ${nTracks} 个轨道</span>`
  body.appendChild(h1)

  const grow = document.createElement('div')
  grow.className = 'grandrow'
  for (const g of gds) grow.appendChild(grandPill(g))
  body.appendChild(grow)

  /* ── ② 轨道:类别级唯一一组,与主要学说平级 ── */
  const tids = []
  for (const g of gds) for (const t of g.tracks) if (!tids.includes(t)) tids.push(t)
  const shown = S.oneTrack ? tids.slice(0, 1) : tids

  const h2 = document.createElement('div')
  h2.className = 'sechead'
  h2.innerHTML =
    '轨道<span class="hint">' +
    (shown.length === tids.length
      ? `${tids.length} 个 · 本类别全部主要学说共用`
      : `${shown.length}/${tids.length} 个(已按「每类只看首个轨道」过滤)`) +
    '</span>'
  body.appendChild(h2)

  const trow = document.createElement('div')
  trow.className = 'tracks'
  for (const tid of shown) {
    const tr = S.trackById.get(tid)
    if (!tr) {
      const miss = document.createElement('div')
      miss.className = 'tcard'
      miss.innerHTML = `<div class="thead"><span class="nm">⚠ ${esc(tid)}</span><span class="mini ms">未定义</span></div>`
      trow.appendChild(miss)
      continue
    }
    trow.appendChild(trackCard(tr, gds))
  }
  body.appendChild(trow)
  sec.appendChild(body)
  return sec
}

function folderColor(n) {
  return ['#5c6470', '#2f6f4f', '#2b6cb0', '#8a5a2b', '#7c5cbf'][(n ?? 0) % 5]
}

/** 主要学说药丸:只列不解。选中后右栏展示其顶层效果与里程碑。 */
function grandPill(g) {
  const el = document.createElement('div')
  const on = S.sel?.kind === 'grand' && S.sel.id === g.id
  el.className = 'gpill' + (on ? ' on' : '')
  el.__obj = g // 右键菜单按对象取 file/line(别用 DOM 文本反查,会随文案/语言失配)
  el.innerHTML =
    iconHtml(g.icon, 'ic', '✦') +
    `<div class="tx"><div class="nm">${esc(cnGrand(g))}</div><div class="id">${esc(g.id)}</div></div>` +
    /* ★ OWNERSHIP_V1:模组改过的学说才能看出"这不是原版那份" */
    (Own.of(g) === 'vanilla' ? '' : Own.badge(g))
  el.title =
    `${g.id}\n归属: ${Own.label(g)} — ${Own.hint(g)}\n解锁 ${g.xpCost} ${g.xpType} XP\n` +
    `共用轨道 ${g.tracks.length} 个: ${g.tracks.map((t) => cnTrack(S.trackById.get(t) || { id: t })).join('、')}\n` +
    `里程碑 ${g.milestones?.length || 0} 个\n位置: ${g.file}:${g.line}`
  el.onclick = () => {
    S.sel = { kind: 'grand', id: g.id }
    renderTree()
    renderInsp()
  }
  return el
}

/**
 * 轨道卡:手风琴。默认展开 —— 旧版默认只显示 1 条次要学说,
 * 95 条里 81 条看不到,这是用户反馈"无法查看其他次要学说"的直接原因。
 * 标题右侧的"N 选 1"把互斥关系直接写出来,不用点开才知道。
 */
function trackCard(tr, gds) {
  const all = (S.byTrack.get(tr.id) || []).filter(matchSub)
  const closed = S.closed.has(tr.id) && !S.q
  const card = document.createElement('div')
  card.className = 'tcard' + (closed ? ' closed' : '') + (S.sel?.kind === 'track' && S.sel.id === tr.id ? ' sel' : '')

  /* ── 卡头 ── */
  const head = document.createElement('div')
  head.className = 'thead'
  head.__obj = tr // 右键菜单用
  head.innerHTML =
    iconHtml(tr.icon, 'ic', '▸') +
    `<span class="nm">${esc(cnTrack(tr))}</span>` +
    (all.length ? `<span class="cnt" title="该轨道下的次要学说候选数 —— 游戏里只能选一条">${all.length} 选 1</span>` : '') +
    `<span class="car">▼</span>`
  head.onclick = () => {
    // 点卡头 = 折叠/展开;点标题文字 = 选中该轨道看详情
    if (S.closed.has(tr.id)) S.closed.delete(tr.id)
    else S.closed.add(tr.id)
    saveClosed()
    renderTree()
  }
  head.querySelector('.nm').onclick = (e) => {
    e.stopPropagation()
    S.sel = { kind: 'track', id: tr.id }
    renderTree()
    renderInsp()
  }

  /* ── 元信息:熟练度 / 作用目标 / 被几个主要学说共用 ── */
  const meta = []
  if (tr.masteryMultiplier) meta.push(`<span class="mm" title="mastery.multiplier — 该轨道满熟练度时的加成倍率">${tr.masteryMultiplier}×</span>`)
  if (tr.masteryCategories?.length) meta.push(`<span class="tagx" title="mastery.categories">${esc(tr.masteryCategories.join('/'))}</span>`)
  if (gds && gds.length > 1) meta.push(`<span class="tagx" title="本类别全部主要学说都共用这个轨道">共用 ×${gds.length}</span>`)
  if (Own.of(tr) !== 'vanilla') meta.push(Own.badge(tr))
  if (tr.background) meta.push(`<span class="tagx" title="轨道背景贴图">${esc(tr.background)}</span>`)
  card.appendChild(head)
  if (meta.length) {
    const m = document.createElement('div')
    m.className = 'tmeta'
    m.innerHTML = meta.join('')
    card.appendChild(m)
  }
  card.title = `track = ${tr.id}\n位置: ${tr.file}:${tr.line}\n被 ${(gds || []).length} 个主要学说共用`

  /* ── 次要学说:全部候选,多列网格 ── */
  if (!all.length) {
    const e = document.createElement('div')
    e.className = 'tmeta'
    e.style.padding = '0 9px 8px 41px'
    e.textContent = S.q || S.onlyDlc ? '当前筛选下无候选' : '该轨道没有定义次要学说'
    card.appendChild(e)
    return card
  }
  const subs = document.createElement('div')
  subs.className = 'subs'
  for (const s of all) subs.appendChild(subChip(s))
  card.appendChild(subs)
  return card
}

/** 次要学说小卡:细节文字走 data-tip 悬停浮层,版面只留名字与代价 */
function subChip(s) {
  const row = document.createElement('div')
  const multi = s.tracks.length > 1
  row.className =
    'sub' +
    (S.sel?.kind === 'sub' && S.sel.id === s.id ? ' on' : '') +
    (multi ? ' multi' : '') +
    (s.mastery ? ' ownm' : '')
  row.__obj = s // 右键菜单用
  const nm = cnSub(s)
  row.innerHTML =
    iconHtml(s.icon, 'ic', '') +
    `<div class="tx"><div class="nm">${esc(nm)}</div></div>` +
    `<div class="rw">${s.xpCost}XP<br>${s.rewards.length}奖</div>` +
    /* ★ OWNERSHIP_V1:模组新增/改写的次要学说直接标出来 */
    (Own.of(s) === 'vanilla' ? '' : Own.badge(s))

  const tip = [
    nm,
    `id: ${s.id}`,
    `归属: ${Own.label(s)} — ${Own.hint(s)}`,
    `解锁: ${s.xpCost} ${s.xpType || ''} XP · ${s.rewards.length} 个奖励`,
    multi ? `同时挂在 ${s.tracks.length} 个轨道: ${s.tracks.map((t) => cnTrack(S.trackById.get(t) || { id: t })).join('、')}` : '',
    s.xor?.length ? `显式互斥: ${s.xor.join(', ')}` : '',
    s.mastery ? `★自带熟练度加成 ${s.mastery.multiplier ?? '—'}×(覆盖轨道条件)` : '',
    s.hasDlc?.length ? `DLC: ${s.hasDlc.join(', ')}` : '',
    Object.keys(s.effects || {}).length ? `顶层效果 ${Object.keys(s.effects).length} 条(见右栏)` : '',
    s.gated ? '有 available 条件(非 always)' : '',
    `${s.file}:${s.line}`,
  ].filter(Boolean)
  row.dataset.tip = tip.join('\n')
  row.onclick = () => {
    S.sel = { kind: 'sub', id: s.id }
    renderTree()
    renderInsp()
  }
  return row
}

/* ── 检查器 ── */
function renderInsp() {
  const box = $('#insp')
  if (!S.sel) {
    box.innerHTML = '<div class="hint">点选一个主要学说 / 轨道 / 次要学说查看效果明细</div>'
    return
  }
  const o = S.byId.get(S.sel.kind + ':' + S.sel.id)
  if (!o) {
    box.innerHTML = '<div class="hint">条目不存在</div>'
    return
  }
  const kv = (k, v) => (v ? `<div class="kv"><b>${esc(k)}</b><span>${v}</span></div>` : '')
  const effRows = (obj) =>
    Object.entries(obj || {})
      .map(([k, v]) => `<div class="eff"><b>${esc(k)}</b><i>${esc(v)}</i></div>`)
      .join('')
  let h = ''
  const head = (title, sub) =>
    `<div style="font-weight:650;margin-bottom:2px">${esc(title)}</div>` +
    `<div style="color:var(--ink3);font-size:11px;word-break:break-all;margin-bottom:6px">${esc(sub)}</div>`

  if (S.sel.kind === 'grand') {
    const g = o
    h += head(cnGrand(g), g.id)
    h += kv('页签', esc(cnFolder(S.folders.find((f) => f.id === g.folder) || { id: g.folder })))
    h += kv('解锁', `${g.xpCost} ${esc(g.xpType)} XP`)
    h += kv('位置', `${esc(g.file)}:${g.line}`)
    h += kv(
      '共用轨道',
      g.tracks
        .map((t) => {
          const tr = S.trackById.get(t)
          return `<span class="tagr">${esc(tr ? cnTrack(tr) : t)}</span>`
        })
        .join(''),
    )
    const effs = Object.keys(g.effects || {})
    h += `<h4>顶层效果 (${effs.length})</h4>`
    h += effs.length ? effRows(g.effects) : '<div class="hint">无</div>'
    h += `<h4>里程碑 (${g.milestones.length})</h4>`
    for (const m of g.milestones) {
      h += `<div style="margin:3px 0"><b style="color:var(--ink2)">#${m.index}</b> ${m.keys
        .map((k) => `<span class="tagr">${esc(k)}</span>`)
        .join('')}</div>`
    }
  } else if (S.sel.kind === 'track') {
    const tr = o
    const subs = S.byTrack.get(tr.id) || []
    h += head(cnTrack(tr), tr.id)
    h += kv('页签', esc(cnFolder(S.folders.find((f) => f.id === tr.folder) || { id: tr.folder })))
    h += kv('位置', `${esc(tr.file)}:${tr.line}`)
    h += kv('背景贴图', tr.background ? esc(tr.background) : '—')
    h += kv('熟练度倍率', tr.masteryMultiplier ? `${tr.masteryMultiplier}×` : '—')
    h += kv('作用类别', (tr.masteryCategories || []).map((c) => `<span class="tagr">${esc(c)}</span>`).join('') || '—')
    h += kv('作用单位', (tr.masterySubUnits || []).map((c) => `<span class="tagr">${esc(c)}</span>`).join('') || '—')
    h += `<h4>次要学说候选 (${subs.length} · 选 1)</h4>`
    h += subs
      .map(
        (s) =>
          `<div class="sib" data-sub="${esc(s.id)}"><span class="nm">${esc(cnSub(s))}</span>` +
          `<span style="color:var(--ink3);font-size:9.5px">${s.xpCost}XP</span></div>`,
      )
      .join('') || '<div class="hint">无</div>'
    box.innerHTML = h
    for (const el of box.querySelectorAll('[data-sub]')) {
      el.onclick = () => {
        S.sel = { kind: 'sub', id: el.dataset.sub }
        // 目标若在折叠轨道里,自动展开,否则点了看不到高亮
        const s = S.byId.get('sub:' + el.dataset.sub)
        if (s) for (const t of s.tracks) S.closed.delete(t)
        saveClosed()
        renderTree()
        renderInsp()
      }
    }
    return
  } else {
    const s = o
    h += head(cnSub(s), s.id)
    h += kv(
      '所属轨道',
      s.tracks
        .map((t) => {
          const x = S.trackById.get(t)
          return `<span class="tagr">${esc(x ? cnTrack(x) : t)}</span>`
        })
        .join(''),
    )
    h += kv('解锁', `${s.xpCost} ${esc(s.xpType)} XP`)
    h += kv('奖励', `${s.rewards.length} 个`)
    h += kv('位置', `${esc(s.file)}:${s.line}`)
    if (s.hasDlc?.length) h += kv('DLC 门控', s.hasDlc.map((d) => `<span class="tagr">${esc(d)}</span>`).join(''))
    if (s.xor?.length) h += kv('显式互斥', s.xor.map((x) => `<span class="tagr">${esc(x)}</span>`).join(''))
    if (s.descLoc) {
      const d = locText(s.descLoc)
      if (d) h += kv('说明', `<span style="color:var(--ink2)">${esc(d)}</span>`)
    }
    const tr = S.trackById.get(s.tracks[0])
    /* ★ mastery 对照:特种部队的 subdoctrine 自带 mastery 覆盖轨道 */
    if (s.mastery) {
      h += `<h4>熟练度加成 ★本条自带</h4>`
      h += kv('倍率', `${s.mastery.multiplier ?? '—'}×`)
      h += kv('作用类别', (s.mastery.categories || []).map((c) => `<span class="tagr">${esc(c)}</span>`).join('') || '—')
      h += kv('作用单位', (s.mastery.subUnits || []).map((c) => `<span class="tagr">${esc(c)}</span>`).join('') || '—')
      if (tr) {
        h += `<div class="hint">轨道 ${esc(tr.id)} 的 mastery 是 ${tr.masteryMultiplier ?? '—'}×，但本条声明的 mastery <b>会替换</b>轨道条件（源文件注释:subdoctrine override replaces these track conditions）。</div>`
      }
    } else if (tr) {
      h += `<h4>熟练度加成（来自轨道）</h4>`
      h += kv('倍率', `${tr.masteryMultiplier ?? '—'}×`)
      h += kv('作用类别', (tr.masteryCategories || []).map((c) => `<span class="tagr">${esc(c)}</span>`).join('') || '—')
    }
    const effs = Object.keys(s.effects || {})
    h += `<h4>顶层效果 (${effs.length})</h4>`
    h += effs.length ? effRows(s.effects) : '<div class="hint">无（效果全在奖励里）</div>'
    if (s.hasEffectScript) h += `<div class="hint">另含 effect 脚本块（通常是科技加成）</div>`
    h += `<h4>奖励 (${s.rewards.length})</h4>`
    for (const r of s.rewards) {
      h += `<div style="margin:3px 0"><b style="color:var(--ink2);word-break:break-all">${esc(r.id)}</b><div>${r.keys
        .map((k) => `<span class="tagr">${esc(k)}</span>`)
        .join('')}</div></div>`
    }
    /* ★ 同轨其它候选:直接从检查器跳过去,不用回列表找 */
    const sibs = (S.byTrack.get(s.tracks[0]) || []).filter((x) => x.id !== s.id)
    if (sibs.length) {
      h += `<h4>同轨其它候选 (${sibs.length})</h4>`
      h += sibs
        .map(
          (x) =>
            `<div class="sib" data-sub="${esc(x.id)}"><span class="nm">${esc(cnSub(x))}</span>` +
            `<span style="color:var(--ink3);font-size:9.5px">${x.xpCost}XP</span></div>`,
        )
        .join('')
    }
  }
  box.innerHTML = h
  for (const el of box.querySelectorAll('[data-sub]')) {
    el.onclick = () => {
      S.sel = { kind: 'sub', id: el.dataset.sub }
      renderTree()
      renderInsp()
    }
  }
}

/* ── 事件 ── */
let qt = null
$('#q').oninput = (e) => {
  S.q = e.target.value.trim().toLowerCase()
  clearTimeout(qt)
  qt = setTimeout(renderTree, 200)
}
$('#folderSel').onchange = (e) => {
  S.folder = e.target.value
  renderFolderList()
  renderTree()
}
$('#onlyDlc').onchange = (e) => {
  S.onlyDlc = e.target.checked
  renderTree()
  renderInsp()
}
$('#oneTrack').onchange = (e) => {
  S.oneTrack = e.target.checked
  renderTree()
}

// ★ 面板宽度可调
/* ══════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V1 / KEYS_V1)
 *
 * 学说三层:folder(页签)→ grand(主要学说)→ track(轨道)→ sub(次要学说)。
 * 三层的 file/line 后端都发了。★ 关键:一律靠元素上挂的 __obj 取数据对象,
 * 不用 DOM 文本反查 —— 页签名/学说名都是本地化后的可翻译文本,
 * 拿文本 find 回去在改语言或改显示名时立刻失配。
 * ══════════════════════════════════════════════════════════ */
function ctxItemsOf(o, kind) {
  if (!o) return null
  const extra = [{ label: '复制 ' + kind + ' id', k: '⧉', act: () => Ctx.copy(o.id, ' ' + o.id) }]
  if (kind === 'sub') {
    if ((o.xor || []).length) extra.push({ label: '复制显式互斥 id', k: '⧉', act: () => Ctx.copy(o.xor.join('\n'), '') })
    if ((o.rewards || []).length) extra.push({ label: '复制全部奖励 key(' + o.rewards.length + ')', k: '⧉', act: () => Ctx.copy(o.rewards.join('\n'), '') })
  }
  if (kind === 'grand' && (o.tracks || []).length) {
    extra.push({ label: '复制共用轨道 id', k: '⧉', act: () => Ctx.copy(o.tracks.join('\n'), '') })
  }
  if (kind === 'track') {
    extra.push({
      label: S.closed.has(o.id) ? '展开这条轨道' : '折叠这条轨道',
      k: '⇕',
      act: () => {
        if (S.closed.has(o.id)) S.closed.delete(o.id)
        else S.closed.add(o.id)
        saveClosed()
        renderTree()
      },
    })
  }
  extra.push({
    label: '在右栏选中它',
    k: '→',
    act: () => {
      S.sel = { kind: kind, id: o.id }
      renderTree()
      renderInsp()
    },
  })
  // ★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开基础游戏文件」):
  //   原先硬编码 `root: 0`,注释的假设是「学说是单份生效文件」。
  //   那个假设不成立 —— 模组可以整份替换 doctrines 文件,硬编码 0 会让
  //   「用 VS Code 打开」定位到**基础游戏**里的同名文件。
  //   后端 doctrines/graph 现在下发真实的 root/rootName(2026-10-06 补)。
  return Ctx.sourceItems({
    root: typeof o.root === 'number' && o.root >= 0 ? o.root : 0,
    rootName: o.rootName || '学说',
    file: o.file, line: o.line, id: o.id, extra,
  })
}
function wireCtxAndKeys() {
  const host = $('#tree') || document.body
  // 委托到树容器:renderTree() 每次全量重建,逐元素绑定会失效
  Ctx.attach(host, '.gpill', (el) => ctxItemsOf(el.__obj, 'grand'))
  Ctx.attach(host, '.thead', (el) => ctxItemsOf(el.__obj, 'track'))
  Ctx.attach(host, '.sub', (el) => ctxItemsOf(el.__obj, 'sub'))
  Ctx.attach(host, '.fhead', (el) => {
    const f = el.__obj
    if (!f) return null
    return Ctx.sourceItems({
      // ★ RIGHTCLICK_ROOT_V1:同 ctxItemsOf,用真实来源而不是硬编码 0
      root: typeof f.root === 'number' && f.root >= 0 ? f.root : 0,
      rootName: f.rootName || '学说页签',
      file: f.file,
      line: f.line,
      id: f.id,
      extra: [
        { label: '只看这个页签', k: '→', act: () => { S.folder = f.id; renderFolderList(); renderTree() } },
        f.dlcGated ? { label: '⚠ 受 DLC 门控:' + (f.hasDlc || []).join(', '), dis: true } : null,
      ].filter(Boolean),
    })
  })
  if (window.Keys) {
    const K = Keys
    window.__KEYMAP_PAGE__ = 'doctrines' // 本页归属:bind 查 keymap / 设置页按页分组
    K.bind(null, () => $('#q').focus(), '聚焦搜索框', { id: 'find.search', group: '查找' })
    K.bind(
      null,
      () => {
        if (S.sel) Ctx.copy(S.sel.id, ' ' + S.sel.id)
        else toast('先点选一个学说', true)
      },
      '复制选中学说 id',
      { id: 'sel.copyId', group: '选中' },
    )
    K.bind(null, () => Keys.ctxKey(), '对选中学说打开右键菜单', { id: 'sel.menu', group: '选中' })
    K.bind(null, () => { S.sel = null; renderTree(); renderInsp() }, '取消选择', { id: 'sel.clear', group: '选中' })
  }
}

Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event('resize')))

wireCtxAndKeys()

load()
