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
    return toast('世界地图构建失败:' + ((d && d.error) || '未知'), true)
  }
  if (own && window.Progress) window.Progress.done()
  S.meta = d
  S.ownerColor = new Map((d.owners || []).map((o) => [o.tag, o.color]))
  S.ownerOwn = new Map((d.owners || []).map((o) => [o.tag, o.own || 'vanilla']))
  S.ownerCount = new Map()
  for (const p of d.provinces) if (p.owner) S.ownerCount.set(p.owner, (S.ownerCount.get(p.owner) || 0) + 1)
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
  renderDlc()
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
    `<span class="rs">${sum.total || 0} 个 · 带数据 ${sum.withData || 0} 个 · 门控 ${dl.gateTotal || 0} 处</span></div>`
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
            `<b>${esc(x.name)}</b><span class="rs">${esc(x.dir)} · state ${x.statesCount} · map 资产 ${x.mapAssetsCount}</span></label>`,
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
            `<span class="rs">${g.count} 处${g.dir ? ' · ' + esc(g.dir) : ' · 未匹配到 DLC 目录'}</span></div>`
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
    if (s.mapAssets) bits.push(`地图资产 ${s.mapAssets}`)
    if (s.states) bits.push(`state ${s.states}`)
    if (s.countries) bits.push(`国家 ${s.countries}`)
    if (s.replacePaths.length) bits.push(`replace_path ${s.replacePaths.length} 条`)
    const ownCls = s.index === d.bitmapRoot ? 'own' : ''
    return (
      `<div class="sn"><b>${esc(s.name)}</b>` +
      `<span class="tag ${ownCls}">${s.writable ? '模组' : '游戏'}</span>` +
      `<span>${esc(bits.join(' · ') || '未提供任何生效内容')}</span>` +
      `</div>`
    )
  })
  const gapNote = d.stats.assetGaps || d.stats.statesDropped
    ? `<div class="rs">⚠ 资产缺口 ${d.stats.assetGaps} · 被 replace_path 丢弃的 state ${d.stats.statesDropped}</div>`
    : ''
  box.innerHTML =
    `<div class="sn"><b>生效地图</b><span>${esc(bm.name || '?')}</span>` +
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
  $('#diagCount').textContent = issues.length ? `(${errN} 错误 / ${warnN} 警告)` : '(无)'
  btn.textContent = issues.length ? `诊断 ${issues.length}` : '诊断'
  if (!issues.length) {
    $('#diagBody').innerHTML = '<div class="it"><span class="k warn">OK</span>未发现 replace_path 缺口或归属异常</div>'
    return
  }
  const dropped = (d.statesDir && d.statesDir.dropped) || []
  let html = issues
    .map(
      (i) =>
        `<div class="it ${esc(i.severity)}"><span class="k">${esc(i.kind)}</span>${esc(i.msg)}` +
        (i.paths && i.paths.length ? `<div class="rs">路径:${i.paths.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div>` : '') +
        `</div>`,
    )
    .join('')
  if (dropped.length) {
    html +=
      `<div class="rs">被 replace_path 丢弃的原版 state(前 ${Math.min(10, dropped.length)}/${dropped.length}):` +
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
}

function renderLegend() {
  const body = $('#legendBody')
  if (!S.meta) {
    body.textContent = '构建中…'
    return
  }
  const rows = [...S.ownerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120)
  /* ★ 按「颜色来源」分组:原版定义 / 模组覆盖 / 模组新增。
   *   用户问"这是原版还是模组的"时,现在能一眼分开 —— 之前 120 行 tag
   *   混在一起,只有鼠标悬停才看得到来源,没法横向对比。*/
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
        // ★ 灰 = 没取到 color(地图上也是灰),必须标出来,
        //   否则用户看到一片灰会以为工具坏了
        const flat = !c || (c[0] === 128 && c[1] === 128 && c[2] === 128)
        return `<div class="ow${flat ? ' flat' : ''}"><i style="background:${c ? rgbCss(c) : '#999'}"></i><span>${esc(tag)} · ${n}</span></div>`
      })
      .join('')
  }
  body.innerHTML = html
}

function rgbCss(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/* ── 交互 ── */
let drag = null
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty }
  canvas.classList.add('grab')
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    S.tx = drag.tx + (e.clientX - drag.x)
    S.ty = drag.ty + (e.clientY - drag.y)
    draw()
    return
  }
  hover(e)
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
  tip.innerHTML =
    `<b>${i18n_t('wm.province')} ${best.id}</b><br>坐标 (${best.x}, ${best.y})` +
    (best.owner ? `<br>${i18n_t('wm.owner')}: <b>${esc(best.owner)}</b>` : `<br>${i18n_t('wm.unowned')}`) +
    (best.stateId >= 0 ? `<br>state ${best.stateId}` : '') +
    (best.own ? `<br>${i18n_t('wm.source')}: ${esc(OWN_LABEL()[best.own] || best.own)}` : '') +
    stateDetailHtml(best)
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
$('#mBase').addEventListener('click', () => switchMode('base'))
$('#mOwner').addEventListener('click', () => switchMode('owner'))
function switchMode(m) {
  if (S.mode === m) return
  S.mode = m
  $('#mBase').classList.toggle('on', m === 'base')
  $('#mOwner').classList.toggle('on', m === 'owner')
  loadImg()
}
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

loadMeta()