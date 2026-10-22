/* 世界地图预览(参考 HOI4 Mod Utilities 的世界地图预览)
 *
 * ★ 多来源合成(MAPMODEL_V1)——后端已按「载入序 + .mod 的 replace_path」
 *   判完每个资产与 states 的归属,这里只负责渲染与展示**这张图是谁的**。
 *
 * 后端 /api/worldmap/meta 给出:
 *   - 省份质心(x,y,provinces.bmp 坐标系)、归属 tag、所属 state、三态归属
 *   - 生效国家定义(含颜色)—— tag 来自 common/country_tags,不是文件名
 *   - sources[]  各来源贡献了多少地图资产 / states / 有无 replace_path 缺口
 *   - assets[]    每个地图资产的三态归属(原版/模组改写/模组新增/缺口)
 *   - issues[]    诊断(replace_path 造成原版文件消失、owner 无国家定义 …)
 * /api/worldmap/img?mode=base|owner 给出地图 PNG。前端画布叠加可悬停的省份点。 */
const $ = (s) => document.querySelector(s)
const canvas = $('#map')
const ctx = canvas.getContext('2d')

/* I18N_V1(2026-10-07):本页文案随语言切换重渲染。
 * 地图页状态很多(缩放/平移/勾选的 DLC/悬停),切语言**不能重载页面** ——
 * 那样用户刚对好的视图就没了。这里只重渲染受文案影响的 DOM:
 * 图例分组名、来源条、统计 chip、悬停提示的标签。 */
/* ★ 名字要独特:本文件是**经典脚本**,顶层 const 会进全局词法作用域,
 *   与别的脚本同名就 SyntaxError: Identifier 'T' has already been declared
 *   —— 曾与 progress.js 的 const T 撞车,整页脚本不执行、进度条也不出现。
 *   前缀 i18n_ 降低撞车概率。*/
const i18n_t = window.I18N ? window.I18N.t : (k) => k

/** 来源标签(原版/模组改写/…)——双语 */
const OWN_LABEL = () => ({ vanilla: i18n_t('wm.srcVanilla'), override: i18n_t('wm.srcOverride'), new: i18n_t('wm.srcNew'), gap: i18n_t('df.added') })
/** 图例分组标题 */
const GRP_LABEL = () => ({ vanilla: i18n_t('wm.srcVanilla'), override: i18n_t('wm.srcOverride'), new: i18n_t('wm.srcNew') })

const S = {
  meta: null,
  img: null, // Image 对象
  mode: 'base',
  zoom: 1,
  tx: 0,
  ty: 0,
  showDots: true,
  ownerColor: new Map(), // tag → [r,g,b](未取到色时为 null → 画布画灰)
  ownerCount: new Map(), // tag → 省份数
  ownerOwn: new Map(), // tag → 'vanilla' | 'override' | 'new'(颜色定义来自哪一方)
  /* STATE_DETAIL(2026-10-07):state 全字段索引 + DLC 门控 */
  stateById: new Map(), // stateId → state 明细
  provState: new Map(), // 省份 id → stateId(悬停时 O(1) 取)
  dlcOn: new Set(), // 勾选启用的 DLC 目录名
  showStatePanel: false,
  /* STRATEGIC_REGION(2026-10-11):战略区域索引 + 面板状态 */
  srById: new Map(), // regionId → 战略区域对象
  provSr: new Map(), // 省份 id → 战略区域 id
  srList: [], // meta.strategicRegions 缓存
  srSel: null, // 当前选中的 regionId
  srQuery: '', // 搜索框文本
  /* DETAIL_PANEL + TAG_INSPECTOR + RIVER/TERRAIN(2026-10-21) */
  provById: new Map(), // 省份 id → 省份对象(高亮/查表用,O(1))
  tagById: new Map(), // tag → CountryDef
  tagProvs: new Map(), // tag → [省份 id]
  detailPid: null, // 当前点击选中的省份
  tagSel: null, // 当前选中的国家 tag(用于高亮)
  riversImg: null, // 河流叠加图层
  riversOn: false,
  _dragMoved: false, // 本次指针交互是否发生过拖拽(区分点击/拖拽)
}

function api(path, opts) {
  return fetch(path, opts).then((r) => r.json())
}
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (el.className = ''), 3200)
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/**
 * 拉地图模型。
 * @param {{outerProgress?:boolean}} [opts]
 *   outerProgress:调用方(DLC 勾选)已经拉过进度条。
 *     后端 /api/worldmap/dlc 在请求内同步跑完 buildWorldMap,
 *     所以进度条必须在**那个 fetch 之前**拉起,否则条会 start→done 一闪而过。
 *     本函数就不要再 start/done,否则计数不配平,条会常驻不消失。
 */
async function loadMeta(opts) {
  const own = !(opts && opts.outerProgress)
  if (own && window.Progress) window.Progress.start(i18n_t('wm.buildingModel'))
  let d = await api('/api/worldmap/meta')
  let tries = 0
  while (d && !d.ready && tries++ < 40) {
    await new Promise((r) => setTimeout(r, 500))
    d = await api('/api/worldmap/meta')
  }
  if (!d || !d.ready) {
    if (window.Progress) window.Progress.fail(i18n_t('wm.buildFailed'))
    return toast(tr('世界地图构建失败:') + ((d && d.error) || '未知'), true)
  }
  if (own && window.Progress) window.Progress.done()
  S.meta = d
  S.ownerColor = new Map((d.owners || []).map((o) => [o.tag, o.color]))
  S.ownerOwn = new Map((d.owners || []).map((o) => [o.tag, o.own || 'vanilla']))
  S.ownerCount = new Map()
  for (const p of d.provinces) if (p.owner) S.ownerCount.set(p.owner, (S.ownerCount.get(p.owner) || 0) + 1)
  S.provById = new Map(d.provinces.map((p) => [p.id, p]))
  $('#statChip').textContent = `${d.provinces.length} ${i18n_t('wm.province')} · ${S.ownerCount.size} ${i18n_t('wm.legend')}`
  // ⚠ 只用 stats 里的计数:API 不下发 states 明细(那有上千条),
  //   读 d.states.length 会在真实浏览器里直接抛 TypeError(HTTP 200 看不出来)
  const stN = (d.stats && d.stats.states) || 0
  const hud = [`${d.w}×${d.h}`, `${d.provinces.length} ${i18n_t('wm.province')}`, `${stN} state`]
  if (d.stats && d.stats.statesDropped) hud.push(`${i18n_t('wm.srcVanilla')} ${d.stats.statesDropped} state ${i18n_t('wm.droppedByReplace')}`)
  $('#hud').textContent = hud.join(' · ')
  renderLegend()
  renderSources()
  renderDiag()
  buildStateIndex()
  buildSrIndex()
  buildTagIndex()
  renderSr()
  renderDlc()
  renderTagBar()
  loadImg()
}

/* ── I18N_V1:语言切换后重渲染受文案影响的 DOM ──
 * 刻意**不重载页面**:地图页的缩放/平移/DLC 勾选都是用户刚调好的状态,
 * reload 一次全丢。画布本身不含文字,只需重画图例/来源/统计/HUD。*/
if (window.I18N) {
  window.I18N.onLangChange(() => {
    if (!S.meta) return
    $('#statChip').textContent = `${S.meta.provinces.length} ${i18n_t('wm.province')} · ${S.ownerCount.size} ${i18n_t('wm.legend')}`
    const stN = (S.meta.stats && S.meta.stats.states) || 0
    const hud = [`${S.meta.w}×${S.meta.h}`, `${S.meta.provinces.length} ${i18n_t('wm.province')}`, `${stN} state`]
    if (S.meta.stats && S.meta.stats.statesDropped) hud.push(`${i18n_t('wm.srcVanilla')} ${S.meta.stats.statesDropped} state ${i18n_t('wm.droppedByReplace')}`)
    $('#hud').textContent = hud.join(' · ')
    renderLegend()
    renderSources()
    renderDiag()
    renderSr()
    renderDlc()
  })
}

/* ── STATE_DETAIL:建 state / 省份→state 索引(悬停与侧栏共用) ── */
function buildStateIndex() {
  const d = S.meta
  S.stateById.clear()
  S.provState.clear()
  for (const s of d.states || []) {
    S.stateById.set(s.id, s)
    for (const pid of s.provinces || []) S.provState.set(pid, s.id)
  }
}

/* ── STRATEGIC_REGION:建 战略区域↔省份 索引(照 buildStateIndex 模式) ── */
function buildSrIndex() {
  const d = S.meta
  S.srById.clear()
  S.provSr.clear()
  S.srList = d.strategicRegions || []
  for (const r of S.srList) {
    S.srById.set(r.id, r)
    for (const pid of r.provinces || []) S.provSr.set(pid, r.id)
  }
  // 兜底:用 provinces[].strategicRegionId 补齐
  for (const p of d.provinces || []) {
    if (p.strategicRegionId != null && !S.provSr.has(p.id)) S.provSr.set(p.id, p.strategicRegionId)
  }
}

/* ── DLC 面板:哪些 DLC 带数据、哪些门控着建筑 ──
 * 实测(见 engine/src/dlcsrc.ts 顶部):本机 30 个 dlc/ + 4 个 integrated_dlc/
 * 全是纯资源目录 —— 带数据的 0 个。所以这一块默认会很短,
 * 但必须留着:①别的安装确实有带数据的 DLC ②has_dlc 门控真实存在(77 处)。*/
function renderDlc() {
  const box = $('#dlcbar')
  if (!box) return
  const d = S.meta
  const dl = (d && d.dlc) || { list: [], summary: {}, gates: {}, gateTotal: 0 }
  const sum = dl.summary || {}
  const gates = Object.entries(dl.gates || {})
  const withData = (dl.list || []).filter((x) => x.hasData)
  const head =
    `<div class="dh"><b>DLC</b>` +
    `<span class="rs">${sum.total || 0}${tr(" 个 · 带数据 ")}${sum.withData || 0}${tr(" 个 · 门控 ")}${dl.gateTotal || 0}${tr(" 处</span></div>")}`
  if (sum.total === 0) {
    box.innerHTML = head + `<div class="rs">未扫描到 DLC 目录(游戏根目录下没有 dlc/ 或 integrated_dlc/)</div>`
    return
  }
  // 带数据的 DLC 才可能是"地图来源层",列出来并可勾选
  const rows = withData.length
    ? withData
        .map(
          (x) =>
            `<label class="dr"><input type="checkbox" data-dlc="${esc(x.dir)}"${S.dlcOn.has(x.dir) ? ' checked' : ''}>` +
            `<b>${esc(x.name)}</b><span class="rs">${esc(x.dir)} · state ${x.statesCount}${tr(" · map 资产 ")}${x.mapAssetsCount}</span></label>`,
        )
        .join('')
    : `<div class="rs">这批 DLC 都没有 history/states 或 map 目录,不参与地图合成（纯美术/音乐包）</div>`
  // 门控清单:哪些 state 的哪些建筑受 DLC 限制
  const grows = gates.length
    ? gates
        .map(([name, g]) => {
          const act = g.active
          return (
            `<div class="gr${act ? ' on' : ''}"><span class="gl">${act ? '✓' : '🔒'}</span>` +
            `<b>${esc(name)}</b>` +
            `<span class="rs">${g.count}${tr(" 处")}${g.dir ? ' · ' + esc(g.dir) : ' · 未匹配到 DLC 目录'}</span></div>`
          )
        })
        .join('')
    : `<div class="rs">本批 state 里没有 has_dlc 门控</div>`
  box.innerHTML = head + rows + `<div class="dh2">受 DLC 门控的内容</div>` + grows
  for (const cb of box.querySelectorAll('input[data-dlc]')) {
    cb.onchange = async () => {
      const dir = cb.dataset.dlc
      if (cb.checked) S.dlcOn.add(dir)
      else S.dlcOn.delete(dir)
      /* ★ 进度条必须在这个 fetch **之前**拉起来。
       *   后端 /api/worldmap/dlc 是在请求内同步跑完 buildWorldMap 的,
       *   所以响应回来时模型已 ready —— 若等 loadMeta() 里的 start,
       *   条会在同一次任务里 start→done 一闪而过,用户完全看不到。*/
      if (window.Progress) window.Progress.start(i18n_t('wm.rebuilding'))
      await api('/api/worldmap/dlc', { method: 'POST', body: JSON.stringify({ on: [...S.dlcOn] }) })
      toast('已切换 DLC,地图模型重建中…')
      // 后端已 invalidateWorldMap;loadImg 每次都带时间戳绕过图片缓存,
      // 这里只需丢掉旧图引用再重新拉 meta。
      S.img = null
      await loadMeta({ outerProgress: true })
      if (window.Progress) window.Progress.done()
    }
  }
}

/* ── 来源条:这张图由哪些来源合成、各自贡献了什么 ── */
function renderSources() {
  const d = S.meta
  const box = $('#srcbar')
  if (!d || !d.sources || !d.sources.length) {
    box.textContent = '来源信息不可用'
    return
  }
  const bm = d.sources[d.bitmapRoot] || {}
  const rows = d.sources.map((s) => {
    const bits = []
    if (s.index === d.bitmapRoot) bits.push('地图位图')
    if (s.mapAssets) bits.push(`${tr("地图资产 ")}${s.mapAssets}`)
    if (s.states) bits.push(`state ${s.states}`)
    if (s.countries) bits.push(`${tr("国家 ")}${s.countries}`)
    if (s.replacePaths.length) bits.push(`replace_path ${s.replacePaths.length}${tr(" 条")}`)
    const ownCls = s.index === d.bitmapRoot ? 'own' : ''
    return (
      `<div class="sn"><b>${esc(s.name)}</b>` +
      `<span class="tag ${ownCls}">${s.writable ? '模组' : '游戏'}</span>` +
      `<span>${esc(bits.join(' · ') || '未提供任何生效内容')}</span>` +
      `</div>`
    )
  })
  const gapNote = d.stats.assetGaps || d.stats.statesDropped
    ? `${tr("<div class=\"rs\">⚠ 资产缺口 ")}${d.stats.assetGaps}${tr(" · 被 replace_path 丢弃的 state ")}${d.stats.statesDropped}</div>`
    : ''
  box.innerHTML =
    `${tr("<div class=\"sn\"><b>生效地图</b><span>")}${esc(bm.name || '?')}</span>` +
    `<span class="rs">${esc((d.assets || []).filter((a) => a.own !== 'vanilla').map((a) => `${a.path.split('/').pop()}=${OWN_LABEL()[a.own] || a.own}`).join(' · ') || i18n_t('wm.srcVanilla'))}</span></div>` +
    rows.join('') +
    gapNote
}

/* ── 诊断抽屉 ── */
function renderDiag() {
  const d = S.meta
  const issues = d.issues || []
  const btn = $('#toggleDiag')
  const errN = issues.filter((i) => i.severity === 'error').length
  const warnN = issues.length - errN
  $('#diagCount').textContent = issues.length ? `(${errN}${tr(" 错误 / ")}${warnN}${tr(" 警告)")}` : '(无)'
  btn.textContent = issues.length ? `${tr("诊断 ")}${issues.length}` : '诊断'
  if (!issues.length) {
    $('#diagBody').innerHTML = '<div class="it"><span class="k warn">OK</span>未发现 replace_path 缺口或归属异常</div>'
    return
  }
  const dropped = (d.statesDir && d.statesDir.dropped) || []
  let html = issues
    .map(
      (i) =>
        `<div class="it ${esc(i.severity)}"><span class="k">${esc(i.kind)}</span>${esc(i.msg)}` +
        (i.paths && i.paths.length ? `${tr("<div class=\"rs\">路径:")}${i.paths.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div>` : '') +
        `</div>`,
    )
    .join('')
  if (dropped.length) {
    html +=
      `${tr("<div class=\"rs\">被 replace_path 丢弃的原版 state(前 ")}${Math.min(10, dropped.length)}/${dropped.length}):` +
      dropped.slice(0, 10).map((x) => `<code>${esc(x.name)}</code>`).join(' ') +
      `</div>`
  }
  $('#diagBody').innerHTML = html
}

function loadImg() {
  const img = new Image()
  img.onload = () => {
    S.img = img
    fit()
    draw()
  }
  img.onerror = () => toast('地图图片加载失败', true)
  img.src = '/api/worldmap/img?mode=' + S.mode + '&_=' + Date.now()
}

function fit() {
  if (!S.meta || !S.img) return
  const st = $('#stage').getBoundingClientRect()
  const z = Math.min(st.width / S.meta.w, st.height / S.meta.h) * 0.98
  S.zoom = z
  S.tx = (st.width - S.meta.w * z) / 2
  S.ty = (st.height - S.meta.h * z) / 2
  $('#zl').textContent = Math.round(z * 100) + '%'
}

function draw() {
  const st = $('#stage').getBoundingClientRect()
  canvas.width = st.width
  canvas.height = st.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, st.width, st.height)
  if (S.img) {
    ctx.save()
    ctx.translate(S.tx, S.ty)
    ctx.scale(S.zoom, S.zoom)
    ctx.imageSmoothingEnabled = S.zoom < 1
    ctx.drawImage(S.img, 0, 0)
    ctx.restore()
  }
  if (S.showDots && S.zoom > 0.16 && S.meta) {
    for (const p of S.meta.provinces) {
      const sx = p.x * S.zoom + S.tx
      const sy = p.y * S.zoom + S.ty
      if (sx < -10 || sx > st.width + 10 || sy < -10 || sy > st.height + 10) continue
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(1.1, 2.4), 0, 6.2832)
      const oc = p.owner ? S.ownerColor.get(p.owner) : null
      ctx.fillStyle = oc ? rgbCss(oc) : p.owner ? 'rgba(190,190,190,.7)' : 'rgba(170,170,170,.45)'
      ctx.fill()
    }
  }
  /* 河流叠加(state/战略区域/tag 的地形叠加需求一并满足) */
  if (S.riversOn && S.riversImg) {
    try {
      ctx.save()
      ctx.translate(S.tx, S.ty)
      ctx.scale(S.zoom, S.zoom)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(S.riversImg, 0, 0)
      ctx.restore()
    } catch {}
  }
  /* 选中国家 → 高亮其所有省份 */
  if (S.tagSel) {
    const provs = S.tagProvs.get(S.tagSel) || []
    ctx.save()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,210,80,.95)'
    for (const pid of provs) {
      const p = S.provById.get(pid)
      if (!p) continue
      const sx = p.x * S.zoom + S.tx
      const sy = p.y * S.zoom + S.ty
      if (sx < -20 || sx > st.width + 20 || sy < -20 || sy > st.height + 20) continue
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(2.5, 3.4), 0, 6.2832)
      ctx.stroke()
    }
    ctx.restore()
  }
}

/* ── 地形图例:内部名 → 中文名 / 示例色(与后端 TERRAIN_PALETTE 对应) ── */
const TERRAIN_ZH = { plains:'平原', forest:'森林', hills:'丘陵', mountain:'山地', urban:'城市', desert:'沙漠', jungle:'丛林', marsh:'沼泽', arctic:'极地', bocage:'树篱', frigid:'寒冷', coast:'海岸', ocean:'海洋', lakes:'湖泊', lake:'湖泊', impassable_mountain:'不可通行山地', oasis:'绿洲', snow:'雪地', ice:'冰' }
const TERRAIN_SWATCH = { plains:'#7aa85c', forest:'#2c7039', hills:'#97824f', mountain:'#8d786e', urban:'#b6aca2', desert:'#d3c482', jungle:'#1f5f2d', marsh:'#5f8278', arctic:'#e2e7ec', bocage:'#5f8c50', frigid:'#c9d8e2', coast:'#4696b4', ocean:'#2d5f8c', lakes:'#3778a5', impassable_mountain:'#7a6660', oasis:'#c9c979', snow:'#eceff2', ice:'#cee2f0' }
const MODE_TITLE = () => ({ base: i18n_t('wm.province'), state: i18n_t('wm.mState'), sr: i18n_t('wm.sr'), owner: i18n_t('wm.legend'), terrain: i18n_t('wm.terrain') })

/* 图例随模式自适应(LAYOUT_V2):国家→归属色分组 / 地形→地形板 / 州·区域→计数提示 / 省份→说明 */
function renderLegend() {
  const body = $('#legendBody')
  const title = $('#legendTitle')
  const meta = $('#legendMeta')
  if (!S.meta) {
    if (body) body.textContent = '构建中…'
    return
  }
  const mode = S.mode
  if (title) title.textContent = MODE_TITLE()[mode] || MODE_TITLE().owner
  if (mode === 'terrain') {
    const cnt = new Map()
    for (const p of S.meta.provinces) if (p.terrain) cnt.set(p.terrain, (cnt.get(p.terrain) || 0) + 1)
    const rows = [...cnt.entries()].sort((a, b) => b[1] - a[1])
    if (meta) meta.textContent = `${rows.length}${i18n_t('wm.terrainUnit')}`
    if (body) body.innerHTML = rows.length
      ? rows.map(([t, n]) => `<div class="ow"><i style="background:${TERRAIN_SWATCH[t] || '#999'}"></i><span>${TERRAIN_ZH[t] || esc(t)} · ${n}</span></div>`).join('')
      : `<div class="rs">${i18n_t('wm.none')}</div>`
    return
  }
  if (mode === 'state' || mode === 'sr') {
    const n = mode === 'state' ? ((S.meta.stats && S.meta.stats.states) || 0) : ((S.meta.strategicRegions || []).length)
    if (meta) meta.textContent = String(n)
    if (body) body.innerHTML = `<div class="rs">${mode === 'state' ? i18n_t('wm.stateLegendHint') : i18n_t('wm.srLegendHint')}</div>`
    return
  }
  if (mode === 'base') {
    if (meta) meta.textContent = `${S.meta.provinces.length}${i18n_t('wm.provinceUnit')}`
    if (body) body.innerHTML = `<div class="rs">${i18n_t('wm.baseLegendHint')}</div>`
    return
  }
  // owner:归属国家图例(按「颜色来源」分组:原版 / 模组覆盖 / 模组新增)
  if (meta) meta.textContent = String(S.ownerCount.size)
  const rows = [...S.ownerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120)
  const grp = { vanilla: [], override: [], new: [] }
  for (const [tag, n] of rows) {
    const o = S.ownerOwn.get(tag)
    ;(grp[o] || grp.vanilla).push([tag, n])
  }
  let html = ''
  for (const k of ['vanilla', 'override', 'new']) {
    const list = grp[k]
    if (!list.length) continue
    html += `<div class="lgrp"><b>${GRP_LABEL()[k]}</b><span>${list.length}</span></div>`
    html += list
      .map(([tag, n]) => {
        const c = S.ownerColor.get(tag)
        // ★ 灰 = 没取到 color(地图上也是灰),必须标出来
        const flat = !c || (c[0] === 128 && c[1] === 128 && c[2] === 128)
        return `<div class="ow${flat ? ' flat' : ''}"><i style="background:${c ? rgbCss(c) : '#999'}"></i><span>${esc(tag)} · ${n}</span></div>`
      })
      .join('')
  }
  if (body) body.innerHTML = html
}

function rgbCss(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/* ── STRATEGIC_REGION 面板:区域列表(可搜索)+ 检查器 ──
 * 挂 #srbar(右侧,#diag 上方),DOM 模式照 #dlcbar。own 三色徽标。*/
const WX_ZH = { no_phenomenon:'无现象', rain_light:'小雨', rain_heavy:'大雨', snow:'雪', blizzard:'暴风雪', arctic_water:'极地水域', mud:'泥泞', sandstorm:'沙暴', min_snow_level:'最低积雪海拔', temperature_day_night:'昼夜温度(弃用)' }
const SR_OWN_LABEL = () => ({ vanilla: i18n_t('wm.srcVanilla'), override: i18n_t('wm.srcOverride'), new: i18n_t('wm.srcNew') })
function srBadge(own) {
  return `<span class="tag sr-${esc(own || '?')}">${esc(SR_OWN_LABEL()[own] || own || '?')}</span>`
}
function renderSr() {
  const box = $('#srbar')
  if (!box) return
  const list = S.srList || []
  const stats = (S.meta && S.meta.strategicRegionsDir && S.meta.strategicRegionsDir.stats) || null
  const head =
    `<div class="srh"><b>${i18n_t('wm.sr')}</b>` +
    `<span class="rs">${list.length}${i18n_t('wm.srUnit')}` +
    (stats ? ` · ${i18n_t('wm.srcVanilla')}${stats.vanilla || 0}/${i18n_t('wm.srcOverride')}${stats.override || 0}/${i18n_t('wm.srcNew')}${stats.new || 0}` : '') +
    `</span></div>` +
    `<input id="srSearch" type="search" placeholder="${i18n_t('wm.srSearch')}" value="${esc(S.srQuery)}">`
  box.innerHTML = head + `<div id="srList" class="srlist"></div><div id="srDetail" class="srdetail"></div>`
  const inp = $('#srSearch')
  if (inp) inp.oninput = () => { S.srQuery = inp.value; drawSrList() }
  drawSrList()
  if (S.srSel != null) showSrDetail(S.srSel)
  else $('#srDetail').innerHTML = `<div class="rs">${i18n_t('wm.srEmpty')}</div>`
}
function drawSrList() {
  const el = $('#srList')
  if (!el) return
  const q = S.srQuery.trim().toLowerCase()
  const items = (S.srList || []).filter((r) => !q || String(r.id).includes(q) || String(r.name || '').toLowerCase().includes(q))
  if (!items.length) { el.innerHTML = `<div class="rs">${i18n_t('wm.srNone')}</div>`; return }
  el.innerHTML = items.slice(0, 400).map((r) =>
    `<div class="sri${S.srSel === r.id ? ' on' : ''}" data-srid="${r.id}">` +
    `<b>${esc(r.name)}</b> <span class="rs">#${r.id}</span> ${srBadge(r.own)}` +
    `<span class="rs">${(r.provinces || []).length} ${i18n_t('wm.srProvinces')}</span></div>`
  ).join('')
  for (const it of el.querySelectorAll('[data-srid]')) {
    it.onclick = () => { S.srSel = Number(it.dataset.srid); drawSrList(); showSrDetail(S.srSel) }
  }
}
function showSrDetail(id) {
  const el = $('#srDetail')
  if (!el) return
  const r = S.srById.get(id)
  if (!r) { el.innerHTML = `<div class="rs">${i18n_t('wm.srEmpty')}</div>`; return }
  let html = `<div class="srdh"><b>${esc(r.name)}</b> <span class="rs">#${r.id}</span> ${srBadge(r.own)}</div>`
  html += `<div class="srl"><span class="k">${i18n_t('wm.source')}</span><span class="v">${esc(SR_OWN_LABEL()[r.own] || r.own || '?')} · root ${r.root} · chain [${(r.chain || []).join(', ')}] · ${esc(r.path || r.file || '')}</span></div>`
  html += `<div class="srl"><span class="k">${i18n_t('wm.srProvinces')}</span><span class="v">${(r.provinces || []).length}</span></div>`
  html += `<div class="srl"><span class="k">${i18n_t('wm.srNavalTerrain')}</span><span class="v">${r.navalTerrain ? esc(r.navalTerrain) : i18n_t('wm.none')}</span></div>`
  const mods = r.staticModifiers || []
  html += `<div class="srl"><span class="k">${i18n_t('wm.srModifiers')}</span><span class="v">${mods.length ? mods.map((m) => `${esc(m.key)} = ${esc(m.value)}`).join('<br>') : i18n_t('wm.none')}</span></div>`
  const periods = r.weather || []
  html += `<div class="srwh">${i18n_t('wm.srWeather')}（${periods.length}）</div>`
  if (!periods.length) {
    html += `<div class="rs">${i18n_t('wm.srNoWeather')}</div>`
  } else {
    html += periods.map((wd, i) => {
      const b = wd.between
      let s = `<div class="srper"><b>${i18n_t('wm.srPeriod')} ${i + 1}</b> <span class="rs">${b ? `第${Math.round(b[0])}天 – 第${Math.round(b[1])}天` : ''}</span>`
      s += `<div class="srl"><span class="k">${i18n_t('wm.srTemperature')}</span><span class="v">${wd.temperature ? `${wd.temperature[0]} ~ ${wd.temperature[1]}` : i18n_t('wm.none')}</span></div>`
      for (const f of wd.fields || []) {
        s += `<div class="srl"><span class="k">${esc(WX_ZH[f.key] || f.key)}</span><span class="v">${f.value}</span></div>`
      }
      return s + '</div>'
    }).join('')
  }
  el.innerHTML = html
}

/* ══════════════════════════════════════════════════════════════
 * ★ 国家/TAG 检视器 + 点击详情面板 + 右键定位(2026-10-21)
 *
 * 三类交互的分工(对应需求):
 *  · 悬停  = 简要(省份ID/归属/state ID+名/战略区域/国家),见 hover()
 *  · 点击  = 详尽右侧抽屉(state 全字段 + 地形 + 国家 + 定位按钮)
 *  · 右键  = 调出菜单,用 VS Code / 系统编辑器定位到
 *           province(所属 state)/state/战略区域/tag 的文件与行号
 * 国家 检视器补全"四类"(province/state/战略区域/tag)最后一类的可点选界面。
 * ══════════════════════════════════════════════════════════════ */

function buildTagIndex() {
  S.tagById.clear()
  S.tagProvs.clear()
  for (const c of S.meta.countries || []) S.tagById.set(c.tag, c)
  for (const p of S.meta.provinces) {
    if (!p.owner) continue
    let arr = S.tagProvs.get(p.owner)
    if (!arr) { arr = []; S.tagProvs.set(p.owner, arr) }
    arr.push(p.id)
  }
}

function renderTagBar() {
  const box = $('#tagbar')
  if (!box) return
  const list = [...S.tagById.values()]
  box.innerHTML =
    `<div class="th"><b>${tr('国家')}</b><span class="rs" style="font-size:10px;color:var(--ink3)">${list.length}</span><span class="x" data-close="tag">✕</span></div>` +
    `<input id="tagSearch" type="search" placeholder="${tr('搜索 tag 或名称…')}">` +
    `<div id="tagList"></div>`
  const inp = $('#tagSearch')
  if (inp) inp.oninput = () => drawTagList(inp.value)
  drawTagList('')
  const x = box.querySelector('[data-close="tag"]')
  if (x) x.onclick = () => { box.classList.remove('on'); $('#toggleTag').classList.remove('on') }
}

function drawTagList(q) {
  const el = $('#tagList')
  if (!el) return
  q = (q || '').trim().toLowerCase()
  const list = [...S.tagById.values()].filter((c) => !q || c.tag.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
  if (!list.length) { el.innerHTML = `<div class="rs">${i18n_t('wm.none')}</div>`; return }
  el.innerHTML = list.slice(0, 600).map((c) => {
    const col = c.color
    const flat = !col || (col[0] === 128 && col[1] === 128 && col[2] === 128)
    const n = S.ownerCount.get(c.tag) || 0
    return `<div class="ti${S.tagSel === c.tag ? ' on' : ''}" data-tag="${esc(c.tag)}">` +
      `<i class="sw" style="background:${col ? rgbCss(col) : '#999'}"></i>` +
      `<b>${esc(c.tag)}</b><span class="nm">${esc(c.name || '')} · ${n}</span></div>`
  }).join('')
  for (const it of el.querySelectorAll('[data-tag]')) it.onclick = () => selectTag(it.dataset.tag)
}

function selectTag(tag) {
  S.tagSel = S.tagSel === tag ? null : tag
  drawTagList($('#tagSearch') ? $('#tagSearch').value : '')
  const c = S.tagById.get(tag)
  if (S.tagSel && c) showCountryDetail(c)
  else hideDetail()
  draw()
}

function row(k, v) {
  return `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`
}

/* ── 点击国家 → 右侧详情(国家维度) ── */
function showCountryDetail(c) {
  const col = c.color
  const flat = !col || (col[0] === 128 && col[1] === 128 && col[2] === 128)
  const provs = S.tagProvs.get(c.tag) || []
  let html =
    `<h3><span><i class="sw" style="background:${col ? rgbCss(col) : '#999'}"></i>${esc(c.tag)} · ${esc(c.name || '')}</span><span class="x" data-close="detail">✕</span></h3>` +
    `<div class="grp">${tr('国家')}</div>` +
    row(i18n_t('wm.legend'), `<b>${esc(c.tag)}</b>${flat ? ' <span class="rs">(' + tr('无配色') + ')</span>' : ''}`) +
    row(tr('来源归属'), OWN_LABEL()[c.own] || c.own) +
    row(tr('省份数'), String(provs.length)) +
    (c.hist ? row(tr('历史文件'), `<code>${esc(c.hist.path)}</code>`) : '') +
    row(tr('定义文件'), `<code>${esc(c.path)}</code>`) +
    `<div class="locate">` +
    `<button data-loc="tag" data-id="${esc(c.tag)}">${tr('用 VS Code 打开国家')}</button>` +
    `<button data-sel="1">${S.tagSel ? tr('取消高亮') : tr('高亮省份')}</button>` +
    `</div>`
  const dp = $('#detailPanel')
  dp.innerHTML = html
  dp.classList.add('on')
  wireDetail(dp)
  draw()
}

/* ── 点击省份 → 右侧详情(省份 + state 全字段 + 战略区域 + 国家) ── */
function showDetail(p) {
  const dp = $('#detailPanel')
  let html = `<h3><span>${i18n_t('wm.province')} ${p.id}</span><span class="x" data-close="detail">✕</span></h3>`
  html += `<div class="grp">${i18n_t('wm.province')}</div>`
  html += row(i18n_t('wm.coord'), `(${p.x}, ${p.y})`)
  if (p.type) html += row(i18n_t('wm.pType'), PROV_TYPE_ZH[p.type] ? PROV_TYPE_ZH[p.type]() : esc(p.type))
  if (p.coastal != null) html += row(i18n_t('wm.coastal'), yn(!!p.coastal))
  if (p.terrain) html += row(i18n_t('wm.terrain'), esc(p.terrain))
  if (p.continent) html += row(i18n_t('wm.continent'), CONTINENT_ZH[p.continent] || esc(p.continent))
  const srid = p.strategicRegionId != null ? p.strategicRegionId : S.provSr.get(p.id)
  if (srid != null) {
    const r = S.srById.get(srid)
    html += row(i18n_t('wm.stratRegion'), r ? `<a data-sr="${r.id}" style="color:var(--accent);cursor:pointer">${esc(r.name)} (#${r.id})</a>` : `#${srid}`)
  }
  html += `<div class="grp">${i18n_t('wm.owner')}</div>`
  if (p.owner) {
    const c = S.tagById.get(p.owner)
    const col = c && c.color
    html += row(i18n_t('wm.tag'), `${col ? `<i class="sw" style="background:${rgbCss(col)}"></i>` : ''}<b>${esc(p.owner)}</b>`)
    if (c && c.name) html += row(tr('国家'), esc(c.name))
    html += row(tr('来源归属'), OWN_LABEL()[c ? c.own : p.own] || (c ? c.own : p.own))
  } else {
    html += row(i18n_t('wm.owner'), i18n_t('wm.unowned'))
  }
  const sid = S.provState.get(p.id) ?? p.stateId
  if (sid !== undefined && sid >= 0) {
    const s = S.stateById.get(sid)
    if (s) {
      html += `<div class="grp">state ${s.id} · ${esc(s.name || '')}</div>`
      if (s.manpower !== undefined && s.manpower !== null) html += row(i18n_t('wm.manpower'), num(s.manpower))
      if (s.stateCategory) html += row(i18n_t('wm.stateCat'), esc(s.stateCategory))
      if (s.localSupplies !== undefined && s.localSupplies !== null) html += row(i18n_t('wm.supplies'), String(s.localSupplies))
      if (s.impassable !== undefined && s.impassable !== null) html += row(i18n_t('wm.impassable'), yn(!!s.impassable))
      if (s.buildingsMaxLevelFactor !== undefined) html += row(i18n_t('wm.buildingFactor'), s.buildingsMaxLevelFactor == null ? i18n_t('wm.none') : String(s.buildingsMaxLevelFactor))
      if (s.resources && s.resources.length) html += row(i18n_t('wm.resources'), s.resources.map((r) => `${esc(r.id)} ${r.amount}`).join(', '))
      if (s.claims !== undefined) html += row(i18n_t('wm.claims'), (s.claims && s.claims.length) ? s.claims.map(esc).join(', ') : i18n_t('wm.none'))
      if (s.cores && s.cores.length) html += row(i18n_t('wm.cores'), s.cores.map(esc).join(', '))
      if (s.victoryPoints && s.victoryPoints.length) html += row(i18n_t('wm.vp'), s.victoryPoints.map((v) => `${v[0]} ·${v[1]}`).join(', '))
      if (s.buildings && s.buildings.length) html += row(i18n_t('wm.buildings'), s.buildings.slice(0, 16).map((x) => esc(x.id) + (x.level ? ' ' + x.level : '') + (x.dlc ? ` (${esc(x.dlc)})` : '')).join(' · '))
      html += row('文件', `<code>${esc(s.path)}</code>`)
    }
  }
  html += `<div class="locate">` +
    `<button data-loc="province" data-id="${p.id}">${tr('用 VS Code 打开省份')}</button>` +
    (sid !== undefined && sid >= 0 ? `<button data-loc="state" data-id="${sid}">${tr('用 VS Code 打开 state')}</button>` : '') +
    (srid != null ? `<button data-loc="sr" data-id="${srid}">${tr('用 VS Code 打开战略区域')}</button>` : '') +
    (p.owner ? `<button data-loc="tag" data-id="${esc(p.owner)}">${tr('用 VS Code 打开国家')}</button>` : '') +
    `</div>`
  dp.innerHTML = html
  dp.classList.add('on')
  wireDetail(dp)
  S.detailPid = p.id
  draw()
}

function wireDetail(dp) {
  const x = dp.querySelector('[data-close="detail"]')
  if (x) x.onclick = () => hideDetail()
  for (const b of dp.querySelectorAll('[data-loc]')) b.onclick = () => locateTarget(b.dataset.loc, b.dataset.id)
  const sel = dp.querySelector('[data-sel]')
  if (sel) sel.onclick = () => { S.tagSel = null; drawTagList($('#tagSearch') ? $('#tagSearch').value : ''); hideDetail(); draw() }
  for (const a of dp.querySelectorAll('[data-sr]')) {
    a.onclick = () => {
      S.srSel = Number(a.dataset.sr)
      $('#srbar').classList.add('on')
      $('#toggleSr').classList.add('on')
      renderSr()
      showSrDetail(S.srSel)
    }
  }
}

function hideDetail() {
  $('#detailPanel').classList.remove('on')
  S.detailPid = null
  draw()
}

/** 取鼠标下的省份(悬停/点击/右键共用) */
function pickProvince(e) {
  if (!S.meta) return null
  const st = $('#stage').getBoundingClientRect()
  const mx = e.clientX - st.left
  const my = e.clientY - st.top
  let best = null, bestD = 9 * 9
  for (const p of S.meta.provinces) {
    const sx = p.x * S.zoom + S.tx
    const sy = p.y * S.zoom + S.ty
    const dx = sx - mx, dy = sy - my
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = p }
  }
  return best
}

/** 右键定位:解析成「来源+文件+行号」后交给 /api/open-external(已含 VS Code 探测/--goto/回退) */
async function locateTarget(kind, id) {
  let j = null
  try { j = await api('/api/worldmap/locate?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(id)) } catch { return toast(tr('打开失败') + ': 网络', true) }
  if (!j || !j.ok) return toast(tr('打开失败') + ': ' + ((j && j.error) || '未知'), true)
  let res = null
  try {
    const r = await fetch('/api/open-external?root=' + j.root + '&file=' + encodeURIComponent(j.file) + '&line=' + j.line)
    res = await r.json()
  } catch { return toast(tr('打开失败'), true) }
  if (res && res.ok) toast((res.via ? tr('已用 ') + res.via : tr('已打开')) + ' → ' + j.file + ' :' + j.line)
  else if (res && res.protocol) { try { window.open(res.protocol, '_blank') } catch {}; toast(tr('请用链接交给 VS Code 打开')) }
  else toast(tr('打开失败') + ': ' + ((res && res.error) || ''), true)
}

/* ── 河流叠加图层(懒加载一次) ── */
function loadRivers() {
  if (S.riversImg) return
  const img = new Image()
  img.onload = () => { S.riversImg = img; if (S.riversOn) draw() }
  img.onerror = () => {}
  img.src = '/api/worldmap/img-rivers?_=' + Date.now()
}

/* ── 右键菜单 ── */
function openCtx(cx, cy, p) {
  const m = $('#wmCtx')
  let html = ''
  if (!p) {
    html = `<div class="hdr">${i18n_t('wm.province')} ?</div><div class="mi" data-act="fit">${tr('适应视图')}</div>`
  } else {
    html += `<div class="hdr">${i18n_t('wm.province')} ${p.id}${p.owner ? ' · ' + esc(p.owner) : ''}</div>`
    html += `<div class="mi" data-kind="province" data-id="${p.id}">${tr('用 VS Code 打开省份')}(${tr('所属 state')})</div>`
    const sid = S.provState.get(p.id) ?? p.stateId
    if (sid !== undefined && sid >= 0) html += `<div class="mi" data-kind="state" data-id="${sid}">${tr('用 VS Code 打开 state')}</div>`
    const srid = p.strategicRegionId != null ? p.strategicRegionId : S.provSr.get(p.id)
    if (srid != null) html += `<div class="mi" data-kind="sr" data-id="${srid}">${tr('用 VS Code 打开战略区域')}</div>`
    if (p.owner) html += `<div class="mi" data-kind="tag" data-id="${esc(p.owner)}">${tr('用 VS Code 打开国家')}</div>`
    html += `<div class="sep"></div><div class="mi" data-act="detail">${tr('查看详情')}</div>`
  }
  m.innerHTML = html
  m.style.display = 'block'
  m.style.left = Math.min(cx, window.innerWidth - 200) + 'px'
  m.style.top = Math.min(cy, window.innerHeight - 120) + 'px'
  for (const it of m.querySelectorAll('.mi[data-kind]')) {
    it.onclick = () => { closeCtx(); locateTarget(it.dataset.kind, it.dataset.id) }
  }
  const det = m.querySelector('[data-act="detail"]')
  if (det) det.onclick = () => { closeCtx(); if (p) showDetail(p) }
  const fit = m.querySelector('[data-act="fit"]')
  if (fit) fit.onclick = () => { closeCtx(); fit(); draw() }
}
function closeCtx() { const m = $('#wmCtx'); if (m) m.style.display = 'none' }

/* ── 交互 ── */
let drag = null
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty, sx: e.clientX, sy: e.clientY }
  S._dragMoved = false
  canvas.classList.add('grab')
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    if (Math.abs(e.clientX - drag.sx) > 4 || Math.abs(e.clientY - drag.sy) > 4) S._dragMoved = true
    S.tx = drag.tx + (e.clientX - drag.x)
    S.ty = drag.ty + (e.clientY - drag.y)
    draw()
    return
  }
  hover(e)
})
/* ★ 点击 = 打开右侧详情;与拖拽区分:本帧发生过移动则视为拖拽,不弹面板 */
canvas.addEventListener('click', (e) => {
  if (S._dragMoved) { S._dragMoved = false; return }
  const p = pickProvince(e)
  if (p) showDetail(p)
  else hideDetail()
})
/* ★ 右键 = 定位菜单(在 IDE / VS Code 打开 province/state/战略区域/tag) */
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const p = pickProvince(e)
  openCtx(e.clientX, e.clientY, p)
})
canvas.addEventListener('pointerup', (e) => {
  drag = null
  canvas.classList.remove('grab')
  try { canvas.releasePointerCapture(e.pointerId) } catch {}
})
canvas.addEventListener('pointerleave', () => {
  drag = null
  canvas.classList.remove('grab')
  $('#tip').style.display = 'none'
})
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const st = $('#stage').getBoundingClientRect()
    const mx = e.clientX - st.left
    const my = e.clientY - st.top
    const ix = (mx - S.tx) / S.zoom
    const iy = (my - S.ty) / S.zoom
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
    S.zoom = Math.max(0.05, Math.min(8, S.zoom * f))
    S.tx = mx - ix * S.zoom
    S.ty = my - iy * S.zoom
    $('#zl').textContent = Math.round(S.zoom * 100) + '%'
    draw()
  },
  { passive: false },
)

function hover(e) {
  if (!S.meta) return
  const st = $('#stage').getBoundingClientRect()
  const mx = e.clientX - st.left
  const my = e.clientY - st.top
  let best = null
  let bestD = 9 * 9 // 屏幕 9px 阈值
  for (const p of S.meta.provinces) {
    const sx = p.x * S.zoom + S.tx
    const sy = p.y * S.zoom + S.ty
    const dx = sx - mx
    const dy = sy - my
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  const tip = $('#tip')
  if (!best) {
    tip.style.display = 'none'
    return
  }
  tip.style.display = 'block'
  tip.style.left = Math.min(mx + 12, st.width - 300) + 'px'
  tip.style.top = my + 12 + 'px'
  // ★ 悬停=简要:省份ID / 归属 / state ID+名 / 战略区域 / 国家(点击才展开全字段)
  let h = `<b>${i18n_t('wm.province')} ${best.id}</b>`
  h += best.owner ? `<br>${i18n_t('wm.owner')}: <b>${esc(best.owner)}</b>` : `<br>${i18n_t('wm.unowned')}`
  const sid = S.provState.get(best.id) ?? best.stateId
  if (sid !== undefined && sid >= 0) {
    const s = S.stateById.get(sid)
    h += `<br>state ${sid}${s && s.name ? ' · ' + esc(s.name) : ''}`
  }
  const srid = best.strategicRegionId != null ? best.strategicRegionId : S.provSr.get(best.id)
  if (srid != null) {
    const r = S.srById.get(srid)
    h += `<br>${i18n_t('wm.stratRegion')}: ${r ? esc(r.name) : '#' + srid}`
  }
  if (best.owner) {
    const c = S.tagById.get(best.owner)
    if (c && c.name) h += `<br>${tr('国家')}: ${esc(c.name)}`
  }
  tip.innerHTML = h
}

/* ── 省份扩展字段:类型/海岸/地形/大陆/所属战略区域 ── */
const CONTINENT_ZH = { europe:'欧洲', north_america:'北美洲', south_america:'南美洲', australia:'大洋洲', africa:'非洲', asia:'亚洲', middle_east:'中东' }
const PROV_TYPE_ZH = { land:() => i18n_t('wm.pTypeLand'), sea:() => i18n_t('wm.pTypeSea'), lake:() => i18n_t('wm.pTypeLake') }
function yn(v) { return v ? i18n_t('wm.yes') : i18n_t('wm.no') }
function provMetaHtml(p) {
  const rows = []
  if (p.type) rows.push([i18n_t('wm.pType'), PROV_TYPE_ZH[p.type] ? PROV_TYPE_ZH[p.type]() : esc(p.type)])
  if (p.coastal != null) rows.push([i18n_t('wm.coastal'), yn(!!p.coastal)])
  if (p.terrain) rows.push([i18n_t('wm.terrain'), esc(p.terrain)])
  if (p.continent) rows.push([i18n_t('wm.continent'), CONTINENT_ZH[p.continent] || esc(p.continent)])
  const srid = p.strategicRegionId != null ? p.strategicRegionId : S.provSr.get(p.id)
  if (srid != null) {
    const r = S.srById.get(srid)
    rows.push([i18n_t('wm.stratRegion'), r ? `${esc(r.name)} (#${r.id})` : `#${srid}`])
  }
  if (!rows.length) return ''
  return `<div class="sdb">` + rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('') + '</div>'
}

/* ── STATE_DETAIL:省份所属 state 的属性块 ──
 * 用户要判断的是"这块地值不值得抢" —— 人力、分类、资源、建筑、
 * 胜利点、核心国都是决策依据,只给"归属 XX"不够。
 * ★ DLC 门控的建筑单独标出并注明当前是否拥有该 DLC:
 *   游戏里没买 DLC 时那些格子是空的,不标出来会让人误判。*/
function stateDetailHtml(p) {
  const sid = S.provState.get(p.id) ?? p.stateId
  if (sid === undefined || sid < 0) return ''
  const s = S.stateById.get(sid)
  if (!s) return ''
  const rows = []
  if (s.manpower !== undefined && s.manpower !== null) rows.push([i18n_t('wm.manpower'), num(s.manpower)])
  if (s.stateCategory) rows.push([i18n_t('wm.stateCat'), esc(s.stateCategory)])
  if (s.localSupplies !== undefined && s.localSupplies !== null) rows.push([i18n_t('wm.supplies'), String(s.localSupplies)])
  if (s.claims !== undefined) rows.push([i18n_t('wm.claims'), (s.claims && s.claims.length) ? s.claims.map(esc).join(', ') : i18n_t('wm.none')])
  if (s.impassable !== undefined && s.impassable !== null) rows.push([i18n_t('wm.impassable'), yn(!!s.impassable)])
  if (s.buildingsMaxLevelFactor !== undefined) rows.push([i18n_t('wm.buildingFactor'), s.buildingsMaxLevelFactor == null ? i18n_t('wm.none') : String(s.buildingsMaxLevelFactor)])
  if (s.resources && s.resources.length) {
    rows.push([i18n_t('wm.resources'), s.resources.map((r) => `${esc(r.id)} ${r.amount}`).join(', ')])
  }
  if (s.cores && s.cores.length) rows.push([i18n_t('wm.cores'), s.cores.map(esc).join(', ')])
  if (s.victoryPoints && s.victoryPoints.length) {
    // 只列这个省份自己的 VP,全 state 的 VP 太多会淹没提示框
    const own = s.victoryPoints.filter((v) => v[0] === p.id)
    if (own.length) rows.push([i18n_t('wm.vp'), own.map((v) => `${v[1]} ${i18n_t('app.level')}`).join(', ')])
  }
  // ★ 所有键必须留在同一个 .sdb 容器内:曾经在这里提前闭合 </div>,
  //   结果「建筑」那两个 span 掉到容器外 —— innerText 里看得见文字,
  //   但 .sdb .k 选不到,样式全丢。
  if (s.buildings && s.buildings.length) {
    const b = s.buildings.slice(0, 14)
    const items = b
      .map((x) => {
        const lock = x.dlc
          ? S.dlcOn.has(dlcDirOf(x.dlc))
            ? ` <span class="un">${i18n_t('wm.needsDlc')} ${esc(x.dlc)} (${i18n_t('wm.dlcOn')})</span>`
            : ` <span class="lk">${i18n_t('wm.needsDlc')} ${esc(x.dlc)}</span>`
          : ''
        return `${esc(x.id)}${x.level ? ' ' + x.level : ''}${lock}`
      })
      .join(' · ')
    rows.push([i18n_t('wm.buildings'), items])
  }
  if (!rows.length) return ''
  return `<div class="sdb"><div class="sdh">state ${s.id} · ${i18n_t('wm.buildings')}</div>` + rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('') + '</div>'
}

function num(v) {
  return typeof v === 'number' ? v.toLocaleString('en-US') : String(v)
}

/** DLC 正式名 → 目录名(判断是否已启用);找不到返回 '' */
function dlcDirOf(dlcName) {
  const gates = (S.meta && S.meta.dlc && S.meta.dlc.gates) || {}
  const g = gates[dlcName]
  return (g && g.dir) || ''
}

/* ── 控件 ── */
/* LAYOUT_V2:5 个地图模式按钮(省份=底图 / 州 / 战略区域 / 国家=归属 / 地形)。
 * 其余是勾选项(省份点/河流)与面板开关(战略区域/国家/诊断/DLC)。*/
const MODE_BTN = { base: '#mProvince', state: '#mState', sr: '#mSr', owner: '#mOwner', terrain: '#mTerrain' }
for (const [mode, sel] of Object.entries(MODE_BTN)) {
  const el = $(sel)
  if (el) el.addEventListener('click', () => switchMode(mode))
}
function switchMode(m) {
  if (S.mode === m) return
  S.mode = m
  for (const [mode, sel] of Object.entries(MODE_BTN)) { const el = $(sel); if (el) el.classList.toggle('on', mode === m) }
  loadImg()
  renderLegend()
}
$('#cRivers').addEventListener('change', (e) => {
  S.riversOn = e.target.checked
  if (S.riversOn) loadRivers()
  draw()
})
$('#toggleTag').addEventListener('click', () => {
  const el = $('#tagbar')
  el.classList.toggle('on')
  $('#toggleTag').classList.toggle('on', el.classList.contains('on'))
})
// 右键菜单在画布外点击时关闭
document.addEventListener('click', (e) => {
  const m = $('#wmCtx')
  if (m && m.style.display === 'block' && !(e.target.closest && e.target.closest('#wmCtx'))) closeCtx()
})
$('#cDots').addEventListener('change', (e) => {
  S.showDots = e.target.checked
  draw()
})
$('#toggleDiag').addEventListener('click', () => {
  const el = $('#diag')
  el.classList.toggle('on')
  $('#toggleDiag').classList.toggle('on', el.classList.contains('on'))
})
$('#toggleDlc').addEventListener('click', () => {
  const el = $('#dlcbar')
  el.classList.toggle('on')
  $('#toggleDlc').classList.toggle('on', el.classList.contains('on'))
})
const _tsr = $('#toggleSr')
if (_tsr) _tsr.addEventListener('click', () => {
  const el = $('#srbar')
  el.classList.toggle('on')
  _tsr.classList.toggle('on', el.classList.contains('on'))
})
$('#zi').addEventListener('click', () => zoomBy(1.25))
$('#zo').addEventListener('click', () => zoomBy(1 / 1.25))
$('#fit').addEventListener('click', () => {
  fit()
  draw()
})
function zoomBy(f) {
  const st = $('#stage').getBoundingClientRect()
  const mx = st.width / 2
  const my = st.height / 2
  const ix = (mx - S.tx) / S.zoom
  const iy = (my - S.ty) / S.zoom
  S.zoom = Math.max(0.05, Math.min(8, S.zoom * f))
  S.tx = mx - ix * S.zoom
  S.ty = my - iy * S.zoom
  $('#zl').textContent = Math.round(S.zoom * 100) + '%'
  draw()
}
window.addEventListener('resize', () => draw())
/* LAYOUT_V2:右栏详情抽屉开合会改变 #stage 宽度 → 用 ResizeObserver 重画,
 * 否则打开详情后地图仍按旧尺寸渲染(被压扁/留白)。 */
if (typeof ResizeObserver !== 'undefined') {
  try { new ResizeObserver(() => draw()).observe($('#stage')) } catch {}
}

loadMeta()