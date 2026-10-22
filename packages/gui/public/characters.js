/* 人物角色浏览器 —— common/characters/*.txt。
 *
 * 三栏:左=文件清单 · 中=人物卡片墙 · 右=检查器(肖像/职务/allowed_civil_war/instance+DLC门控/来源)。
 * 遵循全工作台统一来源语义(基础游戏→DLC→模组,后者优先),ownchip.js 负责归属徽标。
 * 实例(instance)带 has_dlc 门控,右栏可勾选 DLC 过滤实例显示。
 * 多画像人物可在检查器内切换当前展示的肖像。
 */
const $ = (s) => document.querySelector(s)

const S = {
  files: [],
  sources2: [],
  own: null,
  q: '',
  src: '',
  selFile: null, // idx into S.files
  selChar: null, // char object
  dlcFilter: '',
  curTex: '',    // 检查器当前展示的画像 tex
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
  window.LoadGate && window.LoadGate.show('正在加载人物角色…')
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
      const msg = (e && e.name === 'AbortError') ? '请求超时(30s),服务器可能仍在构建' : ((e && e.message) || '请求失败')
      return { ready: false, busy: false, error: msg }
    }
    if (d && d.ready === false && d.busy) {
      if (++busyN > 75) {
        if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
        window.LoadGate && window.LoadGate.hide()
        return { ready: false, busy: false, error: '构建超时(>90s),请稍后刷新重试' }
      }
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start('正在构建人物角色…') }
      window.LoadGate && window.LoadGate.show('加载中… ' + Math.round(busyN * 1.2) + 's')
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
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources2.filter((s) => s.base).length
  const mods = S.sources2.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(tr('原版 ') + base)
  if (mods) parts.push(tr('模组 ') + mods)
  el.textContent = parts.length ? tr('来源 ') + parts.join(' / ') : ''
}

let _retry = 0
async function load() {
  const qp = new URLSearchParams()
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/characters/graph' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  _retry = 0
  S.files = d.files || []
  S.sources2 = d.sources || []
  S.own = d.own || null
  S.stats = d.stats || {}
  $('#statChip').textContent =
    `${d.stats.shownFiles}${tr(' 文件 / ')}${d.stats.shownCharacters}${tr(' 人物(共 ')}${d.stats.characters}${tr(')')}`
  $('#statChip').title = Own.statsLine(S.own)
  $('#fileCount').textContent = d.stats.shownFiles
  buildSrcSel()
  srcSummary()
  renderFileList()
  if (S.selFile === null && S.files.length) {
    let best = 0
    for (let i = 0; i < S.files.length; i++) {
      if ((S.files[i].characters || []).length > (S.files[best].characters || []).length) best = i
    }
    S.selFile = best
  }
  renderCards()
  preloadLoc(S.files) // 人名本地化异步预热
}

/* ── 人名本地化:批量拉取人名键,拉完重渲染 ── */
function preloadLoc(files) {
  const seen = new Set()
  const keys = []
  for (const f of files) {
    for (const c of f.characters) {
      if (c.name && !seen.has(c.name)) { seen.add(c.name); keys.push(c.name) }
    }
  }
  if (keys.length) {
    Loc.load(keys).then(() => {
      // Loc.load 成功后会 emit() 触发下面的 Loc.on —— 这里无需额外重渲染
    })
  }
}
/* 本地化缓存就绪/变化时刷新人名显示 */
let _locLang = Loc.currentLang()
Loc.on(() => {
  if (!S.files.length) return
  const lang = Loc.currentLang()
  // 换语言时 cache 被清空 → 仅语言真正变化才按当前语言重拉人名译文,再重渲染
  if (lang !== _locLang) { _locLang = lang; preloadLoc(S.files) }
  renderCards()
  if (S.selChar) renderInsp()
})

/* 左栏文件名:剥掉公共的 common/characters 前缀与 .txt 后缀(全部相同,只看文件名) */
function relShort(rel) {
  return String(rel || '').split(/[\\/]/).pop().replace(/\.txt$/i, '')
}

/* ── 左栏:文件列表 ── */
function renderFileList() {
  const el = $('#fileList')
  el.innerHTML = ''
  if (!S.files.length) {
    el.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">无文件</div>'
    return
  }
  S.files.forEach((f, i) => {
    const row = document.createElement('div')
    row.className = 'frow' + (i === S.selFile ? ' hit' : '')
    const badge = Own.of(f.own) === 'vanilla' ? '' : `<span class="ow">${Own.badge(f.own)}</span>`
    row.innerHTML = `<span class="nm">${esc(relShort(f.rel))}</span><span class="ct">${f.characters.length}</span>${badge}`
    row.title = `${f.rel} · ${f.characters.length} 人物`
    row.dataset.i = i
    row.onclick = () => { S.selFile = i; S.selChar = null; S.curTex = ''; renderFileList(); renderCards(); $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个人物</div>' }
    el.appendChild(row)
  })
}

/* ── 中栏:人物卡片墙(incr 分批 + tex 挂载)── */
function avatarTex(c) {
  if (c.portraits && c.portraits.length) {
    const large = c.portraits.find((p) => p.kind === 'large' && p.role === 'civilian') ||
      c.portraits.find((p) => p.kind === 'large') || c.portraits[0]
    return large.tex
  }
  return ''
}
/* 显示名:有译文用译文,否则退回 id —— 用 Loc.label */
function charName(c) {
  return Loc.label(c.name) || c.id || ''
}
function makeCharUnit(c) {
  const el = document.createElement('div')
  const sel = S.selChar && S.selChar.id === c.id
  el.className = 'char' + (sel ? ' on' : '') + (c.own.own === 'new' ? ' modnew' : c.own.own === 'override' ? ' ovr' : '')
  const tx = avatarTex(c)
  const av = tx ? `<img class="av" data-tex="${esc(tx)}">` : `<div class="av ph">👤</div>`
  const roles = (c.roles || []).map((r) => `<span class="min">${esc(r.cn)}</span>`).join('')
  const dlc = c.hasDlcAll && c.hasDlcAll.length ? `<span class="min dlc" title="DLC 实例:${esc(c.hasDlcAll.join(', '))}">${c.hasDlcAll.length} DLC</span>` : ''
  const badge = Own.of(c.own) === 'vanilla' ? '' : `<span class="min">${esc(Own.label(c.own))}</span>`
  el.innerHTML = `${av}<div class="nm">${esc(charName(c))}</div><div class="id">${esc(c.id)}</div>` +
    `<div class="roles">${roles}${dlc}${badge}</div>`
  el.__obj = c
  el.onclick = () => { S.selChar = c; S.curTex = avatarTex(c); renderCards(); renderInsp() }
  return el
}
function renderCards() {
  const box = $('#cards')
  const f = S.selFile !== null ? S.files[S.selFile] : null
  if (!f || !f.characters.length) {
    box.innerHTML = '<div class="empty">没有符合筛选条件的人物</div>'
    $('#sum').innerHTML = ''
    return
  }
  const list = f.characters.filter((c) => matchQ(c))
  $('#sum').innerHTML = `${tr('<span>显示 <b>')}${list.length}</b> / ${f.characters.length}${tr(' 人 · ')}${esc(f.rel)}</span>` + (S.q ? `${tr('<span>搜索「')}${esc(S.q)}」</span>` : '')
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有符合筛选条件的人物</div>'
    return
  }
  Incr.mount(box, list, makeCharUnit, { batch: 150, onBatch: () => Tex.mount(box) })
}

function matchQ(c) {
  const q = S.q.toLowerCase().trim()
  if (!q) return true
  return c.id.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q) || charName(c).toLowerCase().includes(q)
}

/* ── 职务块渲染 ── */
function roleBlockHtml(r) {
  const bits = []
  const kv = (k, v) => { if (v !== undefined && v !== null && v !== '') bits.push(`<span class="tagr"><b>${esc(k)}</b> ${esc(v)}</span>`) }
  kv('意识形态', r.ideology)
  kv('槽位', r.slot)
  kv('idea_token', r.ideaToken)
  kv('ledger', r.ledger)
  kv('desc', r.desc)
  kv('expire', r.expire)
  kv('legacy_id', r.legacyId)
  kv('cost', r.cost)
  kv('skill', r.skill)
  kv('攻击', r.attackSkill)
  kv('防御', r.defenseSkill)
  kv('计划', r.planningSkill)
  kv('后勤', r.logisticsSkill)
  kv('机动', r.maneuveringSkill)
  kv('协调', r.coordinationSkill)
  kv('不可解雇', r.canBeFired)
  if (r.skills && Object.keys(r.skills).length) {
    bits.push(`<span class="tagr"><b>专长</b> ${Object.entries(r.skills).map((kv2) => `${esc(kv2[0])}=${kv2[1]}`).join(' ')}</span>`)
  }
  if (r.traits && r.traits.length) {
    bits.push(`<span class="tagr"><b>特质</b> ${r.traits.map((t) => esc(t)).join(' ')}</span>`)
  }
  const flags = []
  if (r.hasAllowed) flags.push('allowed')
  if (r.hasAvailable) flags.push('available')
  if (r.hasVisible) flags.push('visible')
  if (r.hasOnAdd) flags.push('on_add')
  if (r.hasOnRemove) flags.push('on_remove')
  if (flags.length) bits.push(`<span class="tagr"><b>脚本</b> ${flags.join('/')}</span>`)
  const fields = (r.fields || []).map((f) => `<span class="tagr">${esc(f)}</span>`).join('')
  return `<div class="role"><div class="rh">${esc(r.cn)} <span class="rk">(${esc(r.key)})</span>` +
    (r.line ? `<span class="rl">L${r.line}</span>` : '') + `</div>` +
    (bits.length ? `<div class="rf">${bits.join('')}</div>` : '') +
    (fields ? `<div class="rf">${fields}</div>` : '') + `</div>`
}

/* ── 右栏:检查器 ── */
function renderInsp() {
  const box = $('#insp')
  const c = S.selChar
  if (!c) { box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个人物</div>'; return }
  const cur = S.curTex || avatarTex(c)

  // 多画像切换:全部画像缩略条 + 当前大图
  let shotsHtml = ''
  const allPx = c.portraits || []
  if (allPx.length) {
    const curRole = (allPx.find((p) => p.tex === cur) || allPx[0]).role
    shotsHtml = `<h4>画像 (${allPx.length})</h4><div class="shots">` +
      allPx.map((p) => {
        const on = p.tex === cur
        return `<img class="shot${on ? ' on' : ''}" data-tex="${esc(p.tex)}" title="${esc(p.role)} · ${esc(p.kind)}" onclick="window._charPick('${esc(p.tex)}')">`
      }).join('') +
      `<span class="shotcur" title="当前画像">${esc(curRole)} · large</span></div>`
  }
  window._charPick = (tex) => { S.curTex = tex; renderInsp() }

  const her = cur ? `<img class="hero" data-tex="${esc(cur)}">` : `<div class="hero ph">👤</div>`
  const ownChip = Own.of(c.own) === 'vanilla' ? '' : `<div class="kv"><b>${tr('归属')}</b><span>${Own.badge(c.own)} ${esc(Own.label(c.own))} — ${esc(Own.hint(c.own))}</span></div>`
  const rolesHtml = (c.roles || []).map(roleBlockHtml).join('') || '<span style="color:var(--ink3)">无</span>'
  const aw = (c.allowedCivilWar || []).map((x) => `<span class="tagr" title="允许内战的条件">${esc(x)}</span>`).join('') || null

  // DLC 实例过滤下拉
  let dlcSelHtml = ''
  if (c.instances && c.instances.length) {
    const dlcs = [...new Set(c.instances.flatMap((i) => i.hasDlc))].sort()
    if (dlcs.length) {
      const opts = ['<option value="">全部实例</option>']
      for (const d of dlcs) opts.push(`<option value="${esc(d)}">${esc(d)}</option>`)
      dlcSelHtml = `<div class="dlcsel"><select id="inspDlc" title="按 DLC 门控过滤实例">${opts.join('')}</select></div>`
    }
  }

  const instHtml = (c.instances || [])
    .filter((i) => !S.dlcFilter || (i.hasDlc.length ? i.hasDlc.includes(S.dlcFilter) : true))
    .map((i) => {
      const dlc = (i.hasDlc || []).map((d) => `<span class="tagr dlc">DLC ${esc(d)}</span>`).join('')
      const cond = (i.cond || []).map((x) => `<span class="tagr">${esc(x)}</span>`).join('')
      const iroles = (i.roles || []).map((r) => `<div class="instrole"><span class="rk">${esc(r.cn)}</span>` +
        ((r.fields || []).length ? `<span class="ic">${r.fields.map((f) => esc(f)).join(' · ')}</span>` : '') + `</div>`).join('')
      return `<div class="inst"><div class="ih">实例 ${dlc}</div>` +
        (i.name ? `<div class="ic">name: ${esc(i.name)}</div>` : '') +
        (cond ? `<div class="ic">allowed: ${cond}</div>` : '') +
        (iroles ? `<div class="ic">职务: ${iroles}</div>` : '') +
        (i.portraits && i.portraits.length ? `<div class="ic">肖像: ${i.portraits.map((p) => esc(p.tex)).join(', ')}</div>` : '') +
        `</div>`
    }).join('')

  const defs = (c.defs || []).map((d) => `<div class="ic">${esc(d.rootName || ('root' + d.root))} · ${esc(d.file)}:${d.line}${d.base ? '' : ' (模组)'}</div>`).join('')

  box.innerHTML = `
    <div class="her">${her}<div><div class="nm">${esc(charName(c))}</div><div class="id">${esc(c.id)}</div></div></div>
    ${shotsHtml}
    <div style="margin-top:8px">
      ${ownChip}
      ${c.gender ? `<div class="kv"><b>性别</b><span>${esc(c.gender)}</span></div>` : ''}
      <div class="kv"><b>文件</b><span>${esc(c.file)}:${c.line}</span></div>
    </div>
    <h4>职务</h4><div>${rolesHtml}</div>
    ${aw ? `<h4>允许内战条件 (allowed_civil_war)</h4><div>${aw}</div>` : ''}
    ${c.instances && c.instances.length ? `<h4>实例 (instance)${dlcSelHtml}</h4>${instHtml || '<div class="ic" style="color:var(--ink3)">无匹配实例</div>'}` : ''}
    ${defs ? `<h4>定义链</h4>${defs}` : ''}
  `
  if ($('#inspDlc')) {
    $('#inspDlc').value = S.dlcFilter
    $('#inspDlc').onchange = (e) => { S.dlcFilter = e.target.value; renderInsp() }
  }
  Tex.mount(box)
}

/* ── 事件 ── */
$('#q').addEventListener('input', (e) => { S.q = e.target.value; renderCards() })
$('#srcSel').addEventListener('change', (e) => { S.src = e.target.value; S.selFile = null; S.selChar = null; S.curTex = ''; load() })
/* ── 右键(全站 Ctx 体系):文件行 / 人物卡 / 实例块 ── */
if (window.Ctx) {
  Ctx.attach('#fileList', '.frow', (el) => {
    const f = S.files[Number(el.dataset.i)]
    if (!f) return null
    return Ctx.sourceItems({ root: f.root, rootName: f.rootName, file: f.rel, id: f.rel })
  })
  Ctx.attach('#cards', '.char', (el) => {
    const c = el.__obj
    if (!c) return null
    const extra = []
    if (c.name && c.name !== c.id) extra.push({ label: '复制本地化 key(名字)', k: '⧉', act: () => Ctx.copy(c.name, c.name) })
    return Ctx.sourceItems({ root: c.root, rootName: c.rootName, file: c.file, line: c.line, id: c.id, loc: c.name, defs: c.defs, extra })
  })
  Ctx.attach('#insp', '.inst', (el) => {
    const c = S.selChar
    if (!c) return null
    return Ctx.sourceItems({ root: c.root, rootName: c.rootName, file: c.file, line: c.line, id: c.id, loc: c.name })
  })
}

load()
