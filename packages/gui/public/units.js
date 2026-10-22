/* 单位和装备浏览器 —— common/units/(顶层 unit 类型 · equipment/ · critical_parts/ ·
 *   unit_modifiers/ · names* / codenames_operatives/)。
 *
 * 三栏:左=分组+文件清单 · 中=条目卡片墙 · 右=检查器(typed 字段 / 其他字段 / 定义链)。
 * 遵循全工作台统一来源语义(基础游戏→DLC→模组,后者优先),ownchip.js 负责归属徽标。
 * 页签:单位(全部非 equipment 分组)/ equipment(仅装备分组)。
 */
const $ = (s) => document.querySelector(s)
const i18n_t = window.I18N ? window.I18N.t : (k) => k

const S = {
  groups: [],     // 响应 groups: [{key, files:[...]}]
  files: [],      // 平铺文件索引(跨分组),每个文件对象带 __grp
  sources2: [],
  stats: {},
  q: '',
  src: '',
  tab: 'units',
  selFile: null,  // 索引 into S.files
  selEntry: null, // 当前选中条目对象
  collapsed: {},  // 分组 key -> true(折叠)
}

/* 分组 key → i18n 标签键(顺序与服务端 groups 数组一致) */
const GRP_I18N = {
  root: 'un.grpRoot',
  equipment: 'un.grpEquipment',
  critical_parts: 'un.grpCriticalParts',
  unit_modifiers: 'un.grpUnitModifiers',
  names: 'un.grpNames',
  names_divisions: 'un.grpNamesDivisions',
  names_railway_guns: 'un.grpNamesRailwayGuns',
  names_ships: 'un.grpNamesShips',
  codenames_operatives: 'un.grpCodenamesOperatives',
}

/* 各 kind 的 typed 字段渲染顺序(标签 = un.f.<key>),未定义/空值跳过 */
const TYPED_FIELDS = {
  units: ['abbreviation','sprite','mapIconCategory','category','type','group','morphGroup','categories','active','priority','aiPriority','combatWidth','manpower','maxStrength','maxOrg','defaultMorale','trainingTime','suppression','weight','supplyConsumption','maxSpeed','recon','need','specialForces','marines','affectsSpeed','regimental','canBeParachuted','casualtyTrickleback','experienceLossFactor','supplyConsumptionFactor','criticalParts','criticalPartDamageChanceMult','hitProfileMult','terrain','cavalry','canExfiltrateFromCoast','mountaineers','transport','essential','attack','softAttack','hardAttack','airAttack','apAttack','breakthrough','defense','armorValue','hardness','entrenchment','initiative','reliability','suppressionFactor','reliabilityFactor','movement'],
  equipment: ['year','isArchetype','archetype','parent','isBuildable','canBeProduced','picture','folder','equipName','equipType','groupBy','interfaceCategory','visualLevel','buildCostIc','powerCostAdd','resources','reliability','defense','breakthrough','hardness','armorValue','softAttack','hardAttack','apAttack','airAttack','lendLeaseCost','maxSpeedEq','moduleSlots','upgrades','priority','active','canBeLendLeased','isConvertable','canLicense','isFrame','maxMilitaryFactories','maxDockyardFactories','manpower','maxStrength','entrenchment','recon','navalSpeed','fireRange','lgArmorPiercing','lgAttack','hgArmorPiercing','hgAttack','torpedoAttack','antiAirAttack','shoreBombardment','evasion','surfaceDetection','subAttack','subDetection','surfaceVisibility','subVisibility','navalRange','portCapacityUsage','searchAndDestroyCoordination','convoyRaidingCoordination','airDefence','airRange','airAgility','airGroundAttack','airBombing','airSuperiority','navalStrikeAttack','navalStrikeTargetting','carrierSize','defaultCarrierCompositionWeight','carrierCapable','variantName','criticalParts'],
  critical_parts: ['icon','frame','chance'],
  names: ['poolParent','prefix','fallbackName','poolType','forCountries','genericCount','uniqueCount','orderedCount'],
}

const COLLAPSE_KEY = 'un.collapsed'
function loadCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {} } catch { return {} } }
function saveCollapsed() { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(S.collapsed)) } catch { /* 隐私模式 */ } }

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 3600)
}

async function api(u, opt) {
  window.LoadGate && window.LoadGate.show(i18n_t('un.loading'))
  let busyN = 0
  for (;;) {
    let d
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30000)
      const r = await fetch(u, Object.assign({}, opt, { signal: ctrl.signal }))
      clearTimeout(timer)
      d = await r.json()
    } catch (e) {
      if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
      window.LoadGate && window.LoadGate.hide()
      const msg = (e && e.name === 'AbortError') ? 'request timeout (30s), server may still be building' : ((e && e.message) || 'request failed')
      return { ready: false, busy: false, error: msg }
    }
    if (d && d.ready === false && d.busy) {
      if (++busyN > 75) {
        if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
        window.LoadGate && window.LoadGate.hide()
        return { ready: false, busy: false, error: 'build timeout (>90s), please refresh' }
      }
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(i18n_t('un.building')) }
      window.LoadGate && window.LoadGate.show(i18n_t('un.loading'))
      await new Promise((res) => setTimeout(res, 1200))
      continue
    }
    if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
    window.LoadGate && window.LoadGate.hide()
    return d
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/* ── 来源下拉(照 characters.js) ── */
function srcLabel(name) { return name === 'vanilla' ? i18n_t('un.srcVanilla') : name }
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
  const sep = (t) => { const o = document.createElement('option'); o.disabled = true; o.textContent = t; sel.appendChild(o) }
  add('', i18n_t('un.srcAll'))
  sep('──')
  add('base', i18n_t('un.srcBase'))
  add('mod', i18n_t('un.srcMod'))
  for (const s of S.sources2.filter((x) => !x.base)) add(s.name, srcLabel(s.name), s.path)
  sel.value = S.src
}
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources2.filter((s) => s.base).length
  const mods = S.sources2.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(i18n_t('un.srcVanilla') + ' ' + base)
  if (mods) parts.push(i18n_t('un.srcMod') + ' ' + mods)
  el.textContent = parts.length ? parts.join(' / ') : ''
}

function flattenGroups(groups) {
  const out = []
  for (const g of groups) for (const f of (g.files || [])) { f.__grp = g.key; out.push(f) }
  return out
}
function visibleGroups() {
  return S.groups.filter((g) => (S.tab === 'equipment' ? g.key === 'equipment' : g.key !== 'equipment'))
}

/* 文件名短显示:剥 common/units/ 前缀与 .txt;再剥掉本组首段目录名 */
function relShort(f) {
  let rel = String(f.rel || '')
  const PFX = 'common/units/'
  if (rel.startsWith(PFX)) rel = rel.slice(PFX.length)
  rel = rel.replace(/\.txt$/i, '')
  const grp = f.group || f.__grp
  if (grp && grp !== 'root' && rel.startsWith(grp + '/')) rel = rel.slice(grp.length + 1)
  return rel || f.rel
}

/* ── 加载 ── */
let _retry = 0
async function load() {
  const qp = new URLSearchParams()
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/units' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? i18n_t('un.building') : i18n_t('un.loading') + (d.error ? ' ' + d.error : '')
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  _retry = 0
  S.groups = d.groups || []
  S.files = flattenGroups(S.groups)
  S.sources2 = d.sources || []
  S.stats = d.stats || {}
  S.own = d.own || null
  const st = S.stats
  $('#statChip').textContent =
    (st.shownFiles != null ? st.shownFiles : st.files) + i18n_t('un.sumFile') + ' / ' +
    (st.shownEntries != null ? st.shownEntries : st.entries) + i18n_t('un.sum')
  $('#statChip').title = Own.statsLine(S.own)
  $('#fileCount').textContent = (st.shownFiles != null ? st.shownFiles : st.files)
  buildSrcSel()
  srcSummary()
  S.selFile = null
  S.selEntry = null
  renderFileList()
  pickFirstFile()
  renderCards()
  preloadLoc()
}

/* 当前页签下自动选中第一个文件 */
function pickFirstFile() {
  S.selFile = null
  for (const g of visibleGroups()) {
    for (const f of (g.files || [])) { S.selFile = S.files.indexOf(f); break }
    if (S.selFile !== null) break
  }
}

/* ── 本地化预热:收集当前文件集条目 id ── */
function preloadLoc() {
  const seen = new Set()
  const keys = []
  for (const f of S.files) for (const e of (f.entries || [])) {
    if (e.id && !seen.has(e.id)) { seen.add(e.id); keys.push(e.id) }
  }
  if (keys.length) Loc.load(keys)
}
let _locLang = Loc.currentLang()
Loc.on(() => {
  if (!S.files.length) return
  const lang = Loc.currentLang()
  if (lang !== _locLang) { _locLang = lang; preloadLoc() }
  renderCards()
  if (S.selEntry) renderInsp()
})

/* ── 左栏:分组(可折叠)+ 文件行 ── */
function renderFileList() {
  const el = $('#fileList')
  el.innerHTML = ''
  const vis = visibleGroups()
  if (!vis.length) {
    el.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">' + esc(i18n_t('un.noMatch')) + '</div>'
    return
  }
  for (const g of vis) {
    const collapsed = !!S.collapsed[g.key]
    const gh = document.createElement('div')
    gh.className = 'grprow'
    const glabel = i18n_t(GRP_I18N[g.key] || g.key)
    gh.innerHTML = `<span class="caret">${collapsed ? '▸' : '▾'}</span><span class="gn">${esc(glabel)}</span><span class="ct">${(g.files || []).length}</span>`
    gh.onclick = () => { S.collapsed[g.key] = !S.collapsed[g.key]; saveCollapsed(); renderFileList() }
    el.appendChild(gh)
    if (collapsed) continue
    for (const f of (g.files || [])) {
      const idx = S.files.indexOf(f)
      const row = document.createElement('div')
      row.className = 'frow' + (idx === S.selFile ? ' hit' : '')
      const badge = Own.of(f.own) === 'vanilla' ? '' : `<span class="ow">${Own.badge(f.own)}</span>`
      row.innerHTML = `<span class="nm">${esc(relShort(f))}</span><span class="ct">${(f.entries || []).length}</span>${badge}`
      row.title = `${f.rel} · ${(f.entries || []).length}`
      row.dataset.i = idx
      row.onclick = () => {
        S.selFile = idx
        S.selEntry = null
        renderFileList()
        renderCards()
        $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">' + esc(i18n_t('un.insEmpty')) + '</div>'
      }
      el.appendChild(row)
    }
  }
}

/* ── 中栏:条目卡片 ── */
function entryName(e) { return Loc.label(e.id) || e.id }
function minBadge(t) { return t === undefined || t === null || t === '' ? '' : `<span class="min">${esc(t)}</span>` }

function makeCard(e) {
  const el = document.createElement('div')
  const sel = S.selEntry && S.selEntry.id === e.id && S.selEntry.line === e.line
  el.className = 'char' + (sel ? ' on' : '') +
    ((e.own && e.own.own === 'new') ? ' modnew' : (e.own && e.own.own === 'override') ? ' ovr' : '')
  let badges = ''
  if (e.kind === 'units') {
    const ty = (e.type || []).slice(0, 2).join(', ')
    badges = minBadge(ty) + minBadge(e.group) + minBadge(e.active) +
      minBadge(e.combatWidth != null ? 'CW ' + e.combatWidth : '') +
      minBadge(e.manpower != null ? 'P ' + e.manpower : '')
  } else if (e.kind === 'equipment') {
    badges = minBadge(e.year) + minBadge(e.equipType) + minBadge(e.archetype || e.parent) +
      minBadge(e.buildCostIc != null ? e.buildCostIc + ' IC' : '')
  } else if (e.kind === 'critical_parts') {
    badges = minBadge(e.icon) + minBadge(e.frame != null ? 'F' + e.frame : '')
  } else if (e.kind === 'names') {
    badges = minBadge(e.poolParent) +
      minBadge(e.genericCount != null ? 'G' + e.genericCount : '') +
      minBadge(e.uniqueCount != null ? 'U' + e.uniqueCount : '')
  }
  /* unit_modifier:裸 token,无摘要 */
  el.innerHTML = `<div class="nm">${esc(entryName(e))}</div><div class="id">${esc(e.id)}</div><div class="badges">${badges}</div>`
  el.__obj = e
  el.onclick = () => { S.selEntry = e; renderCards(); renderInsp() }
  return el
}

function matchQ(e) {
  const q = S.q.toLowerCase().trim()
  if (!q) return true
  return e.id.toLowerCase().includes(q) || entryName(e).toLowerCase().includes(q)
}

function renderCards() {
  const box = $('#cards')
  const f = S.selFile !== null ? S.files[S.selFile] : null
  if (!f || !f.entries || !f.entries.length) {
    box.innerHTML = '<div class="empty">' + esc(i18n_t('un.noMatch')) + '</div>'
    $('#sum').innerHTML = ''
    return
  }
  const list = f.entries.filter(matchQ)
  $('#sum').innerHTML = `<span><b>${list.length}</b> / ${f.entries.length}${i18n_t('un.sum')} · ${esc(f.rel)}</span>`
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + esc(i18n_t('un.noMatch')) + '</div>'
    return
  }
  Incr.mount(box, list, makeCard, { batch: 150 })
}

/* ── typed 字段值格式化 ── */
function fmtTyped(key, v) {
  if (v === undefined || v === null || v === '') return ''
  if (key === 'terrain') {
    return v.map(([name, pairs]) => `${name}{${pairs.map(([k, val]) => `${k}=${val}`).join(',')}}`).join(', ')
  }
  if (Array.isArray(v)) {
    if (!v.length) return ''
    if (Array.isArray(v[0])) return v.map(([k, val]) => `${k}=${val}`).join(', ')
    return v.join(', ')
  }
  return String(v)
}

/* ── 右栏:检查器 ── */
function renderInsp() {
  const box = $('#insp')
  const e = S.selEntry
  if (!e) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">' + esc(i18n_t('un.insEmpty')) + '</div>'
    return
  }
  const loc = Loc.label(e.id)
  const locLine = (loc && loc !== e.id) ? `<div class="loc">${esc(loc)}</div>` : ''
  const ownChip = (!e.own || Own.of(e.own) === 'vanilla') ? ''
    : `<div class="kv"><b>${esc(i18n_t('un.own'))}</b><span>${Own.badge(e.own)} ${esc(Own.label(e.own))} — ${esc(Own.hint(e.own))}</span></div>`

  const keys = TYPED_FIELDS[e.kind] || []
  const flds = []
  for (const k of keys) {
    const v = e[k]
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && !v.length) continue
    const txt = fmtTyped(k, v)
    if (!txt) continue
    flds.push(`<div class="fld"><b>${esc(i18n_t('un.f.' + k))}</b><span>${esc(txt)}</span></div>`)
  }
  const fldsHtml = flds.length ? flds.join('')
    : `<div class="ic" style="color:var(--ink3)">${esc(i18n_t('un.none'))}</div>`

  const others = (e.fields || [])
    .map(([k, v]) => `<div class="ic"><span class="mono">${esc(k)}</span> = ${esc(v)}</div>`).join('')
  const othersHtml = others || `<div class="ic" style="color:var(--ink3)">${esc(i18n_t('un.none'))}</div>`

  const defs = (e.defs || [])
    .map((d) => `<div class="ic">${esc(d.rootName || ('root' + d.root))} · ${esc(d.file)}:${d.line}${d.base ? '' : ' (' + esc(i18n_t('un.srcMod')) + ')'}</div>`).join('')

  box.innerHTML = `
    <div class="her"><div class="nm">${esc(entryName(e))}</div><div class="id">${esc(e.id)}</div>${locLine}</div>
    <div style="margin-top:8px">
      ${ownChip}
      <div class="kv"><b>${esc(i18n_t('un.file'))}</b><span>${esc(e.file)}:${e.line}</span></div>
    </div>
    <h4>${esc(i18n_t('un.fields'))}</h4>${fldsHtml}
    <h4>${esc(i18n_t('un.other'))}</h4>${othersHtml}
    ${defs ? `<h4>${esc(i18n_t('un.defs'))}</h4>${defs}` : ''}
  `
}

/* ── 事件 ── */
$('#q').addEventListener('input', (e) => { S.q = e.target.value; renderCards() })
$('#srcSel').addEventListener('change', (e) => { S.src = e.target.value; load() })

document.querySelectorAll('#tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    if (S.tab === tab) return
    S.tab = tab
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b === btn))
    S.selFile = null
    S.selEntry = null
    renderFileList()
    pickFirstFile()
    renderCards()
    $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">' + esc(i18n_t('un.insEmpty')) + '</div>'
  })
})

/* ── 右键(全站 Ctx 体系):文件行 / 条目卡 ── */
if (window.Ctx) {
  Ctx.attach('#fileList', '.frow', (el) => {
    const f = S.files[Number(el.dataset.i)]
    if (!f) return null
    return Ctx.sourceItems({ root: f.root, rootName: f.rootName, file: f.rel, id: f.rel })
  })
  Ctx.attach('#cards', '.char', (el) => {
    const e = el.__obj
    if (!e) return null
    return Ctx.sourceItems({ root: e.root, rootName: e.rootName, file: e.file, line: e.line, id: e.id, loc: e.id, defs: e.defs })
  })
}

/* 界面语言切换:重渲染所有动态文案 */
if (window.I18N && I18N.onLangChange) {
  I18N.onLangChange(() => {
    if (!S.files.length) return
    buildSrcSel()
    srcSummary()
    renderFileList()
    renderCards()
    if (S.selEntry) renderInsp()
  })
}

S.collapsed = loadCollapsed()
load()