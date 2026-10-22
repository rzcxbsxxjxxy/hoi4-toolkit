/* defines 平衡参数浏览器(wiki Modding / Defines 机制)。
 *
 * 数据源:游戏本体 common/defines/*.lua(6299 行),经 engine/src/defines.ts
 * 解析为 N* 分组 → 键值 → 值类型 + 行尾注释。
 *
 * 为什么单独一页:
 *   defines 是【调平衡】的入口(开局日期、产能、燃料、补给、AI 频率…),
 *   全是"改一个数就影响全局"的参数 —— 与内容页(国策/科技)的信息维度完全不同,
 *   混进内容树只会挤爆。且它有独特的可读性需求:值类型 + 官方注释必须同屏,
 *   否则一个孤零零的 96 根本看不出是什么(是小时还是吨)。
 *
 * 覆盖语义与游戏一致:模组的 NGame = { ... } 写在后面会【覆盖】vanilla 同名键,
 * 所以 byKey 只保留生效值,而本表列出全部来源,被覆盖的用醒目样式标出。
 */
const $ = (s) => document.querySelector(s)

const S = {
  groups: [],
  entries: [],
  total: 0,
  sel: null,     // 选中的 key
  group: '',     // 左栏选中的分组('' = 全部)
  q: '',
  type: '',
  src: '',
  onlyOv: false,
  types: [],
  sources: [],
}

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  if (!el) return
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 3600)
}

async function api(u) {
  try {
    const r = await fetch(u)
    return await r.json()
  } catch (e) {
    return { ready: false, error: String(e) }
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** 值显示:数组/表达式长值折叠,完整值在检查器里看 */
function valText(e) {
  if (e.type === 'array') {
    const a = (e.array || []).map((x) => (typeof x === 'number' ? x : esc(x))).join(', ')
    return '{' + (a.length > 90 ? a.slice(0, 88) + '…' : a) + '}'
  }
  if (e.type === 'expr') return e.value + (e.num !== undefined ? ` = ${e.num}` : '')
  return esc(e.value)
}

/** 当前生效来源名(前缀 "mod名/xxx.lua" → mod名);vanilla 返回 'vanilla' */
function srcOf(e) {
  const i = e.file.indexOf('/')
  return i < 0 ? e.file : e.file.slice(0, i)
}
function isMod(e) {
  const s = srcOf(e)
  return s !== 'vanilla' && s !== '游戏本体'
}

/**
 * 来源名 → 在 ROOTS 里的序号。
 * ⚠ 必须在【页面启动时预载】好:CtxWire 的 obj() 是同步回调(要返回对象给
 *   菜单用),不能在里面 await。所以这里先 fetch 一次存下映射;
 *   拿不到时退化为 0(vanilla),至少菜单还能用,只是绝对路径会指到 vanilla。
 */
let ROOT_IDX = new Map()
async function preloadSources() {
  try {
    const list = (await Ctx.sources()) || []
    // ★ 用服务端给的 `i` 字段当 root 序号,别用数组下标 ——
    //   /api/sources 返回的顺序未必与 ROOTS 内部序号一致(可能有 base 腿),
    //   拿错序号会让 IDE 跳到别的来源,而且不会报错(最难发现的一类错)。
    ROOT_IDX = new Map(list.map((s) => [s.name, typeof s.i === 'number' ? s.i : 0]))
  } catch {
    ROOT_IDX = new Map()
  }
}
function rootIdxOf(name) {
  const v = ROOT_IDX.get(name)
  return v === undefined ? 0 : v
}

/**
 * 文件字段是 "来源名/common/defines/xx.lua",而 IDE/绝对路径需要的是
 * 【相对该来源根目录】的路径(服务端按 root.path + file 拼)。
 * 所以这里把来源前缀换成 common/defines/xx.lua。
 */
function plainPath(file) {
  const i = file.indexOf('/')
  return i < 0 ? file : file.slice(i + 1)
}

let _retry = 0
async function load() {
  const qp = new URLSearchParams()
  if (S.group) qp.set('group', S.group)
  if (S.q) qp.set('q', S.q)
  if (S.type) qp.set('type', S.type)
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/defines' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '解析中…' : '失败:' + (d.error || '未知')
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  _retry = 0
  S.groups = d.groups || []
  S.entries = d.entries || []
  S.total = d.total || 0
  S.types = d.types || []
  if (!$('#typeSel').dataset.filled) {
    const sel = $('#typeSel')
    for (const t of S.types) {
      const o = document.createElement('option')
      o.value = t
      o.textContent = t
      sel.appendChild(o)
    }
    sel.dataset.filled = '1'
  }
  render()
}

function render() {
  const chip = $('#statChip')
  chip.textContent = `${S.entries.length} / ${S.total} 条`
  const ovCount = S.entries.filter(isMod).length
  $('#grpCount').textContent = S.groups.length + ' 组'
  $('#sum').innerHTML =
    `<div style="font-size:11.5px;color:var(--ink3);margin-bottom:10px">` +
    `共 <b style="color:var(--ink2)">${S.total}</b> 个平衡参数,` +
    `当前显示 <b style="color:var(--accent-2)">${S.entries.length}</b> 条` +
    (ovCount ? ` · 其中 <b style="color:var(--warn)">${ovCount}</b> 条被模组改过` : '') +
    `</div>`

  // 左栏分组
  const gl = $('#grpList')
  gl.innerHTML = ''
  const all = document.createElement('div')
  all.className = 'gi' + (S.group === '' ? ' on' : '')
  all.innerHTML = `<span>全部分组</span><span class="n">${S.total}</span>`
  all.onclick = () => { S.group = ''; load() }
  gl.appendChild(all)
  for (const g of S.groups) {
    const d = document.createElement('div')
    d.className = 'gi' + (S.group === g.name ? ' on' : '') + (g.overridden ? ' ov' : '')
    d.innerHTML = `<span>${esc(g.name)}</span><span class="n">${g.count}${g.overridden ? '·' + g.overridden : ''}</span>`
    d.title = `${g.count} 个键${g.overridden ? `,${g.overridden} 个被模组改过` : ''}\n${g.file}`
    d.onclick = () => { S.group = g.name; load() }
    d.__obj = g
    d.dataset.group = g.name
    gl.appendChild(d)
  }

  // 主表:按分组分节(全部分组时),单组时直接一张表
  const stage = $('#groups')
  stage.innerHTML = ''
  let list = S.entries
  if (S.onlyOv) list = list.filter(isMod)
  if (!list.length) {
    stage.innerHTML = '<div class="hint">没有匹配的参数。试试清空搜索或换分组。</div>'
    return
  }
  const byGroup = new Map()
  for (const e of list) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, [])
    byGroup.get(e.group).push(e)
  }
  const groups = S.group ? [[S.group, byGroup.get(S.group) || []]] : [...byGroup.entries()]
  for (const [gname, es] of groups) {
    const box = document.createElement('div')
    box.className = 'grp'
    const ov = es.filter(isMod).length
    box.innerHTML =
      `<h3><span>${esc(gname)}</span><span class="c">${es.length} 个键${ov ? ` · ${ov} 个模组改过` : ''}</span></h3>` +
      `<table class="kv"><thead><tr><th style="width:44%">键名</th><th>值</th><th style="width:52px">行</th></tr></thead><tbody></tbody></table>`
    const tb = box.querySelector('tbody')
    for (const e of es) {
      const tr = document.createElement('tr')
      tr.dataset.key = e.key
      if (S.sel === e.key) tr.className = 'sel'
      const mod = isMod(e)
      // 值列前置类型徽标:定义页里值类型是判读的关键
      // (96 是 number 还是 array,以及 expr 的计算结果,一眼可辨)
      tr.innerHTML =
        `<td class="k">${esc(e.name)}` +
        `<span class="tg ${esc(e.type)}">${esc(e.type)}</span>` +
        (mod ? ' <span class="tg expr">模组</span>' : '') +
        (e.comment ? `<div class="cmt">${esc(e.comment)}</div>` : '') +
        `</td>` +
        `<td class="v${e.type === 'array' ? ' arr' : ''}">${valText(e)}</td>` +
        `<td class="ln">${e.line}</td>`
      tr.onclick = () => select(e.key)
      tr.__obj = e
      tb.appendChild(tr)
    }
    stage.appendChild(box)
  }
}

function select(key) {
  S.sel = key
  for (const tr of document.querySelectorAll('tr[data-key]')) {
    tr.className = tr.dataset.key === key ? 'sel' : ''
  }
  showInsp(key)
}

async function showInsp(key) {
  const box = $('#insp')
  const d = await api('/api/defines/item?key=' + encodeURIComponent(key))
  if (!d.ready || !d.entry) {
    box.innerHTML = '<div class="hint">读取失败:' + esc(d.error || '未知') + '</div>'
    return
  }
  const e = d.entry
  const typeName = { number: '数值', string: '字符串', bool: '布尔', array: '数组', table: '内联表', expr: '表达式', unknown: '未知' }
  const rows = [
    ['完整键', `<code>${esc(e.key)}</code>`],
    ['值', `<code>${esc(e.value)}</code>`],
    ['类型', `<span class="tg ${esc(e.type)}">${esc(e.type)} · ${typeName[e.type] || ''}</span>`],
    ['分组', esc(e.group)],
    ['文件', `<code>${esc(e.file)}</code> <span style="color:var(--ink3)">第 ${e.line} 行</span>`],
  ]
  if (e.num !== undefined) rows.push(['计算值', `<b>${e.num}</b>`])
  if (e.bool !== undefined) rows.push(['布尔', String(e.bool)])
  if (e.array) rows.push(['数组长度', String(e.array.length)])
  let html = `<div class="kv2">${rows.map(([k, v]) => `<b>${k}</b><div>${v}</div>`).join('')}</div>`
  if (e.comment) {
    html += `<pre>${esc(e.comment)}</pre>`
  } else {
    html += `<div class="hint" style="padding:8px 0">官方手册未给这个键写注释 —— 只能靠命名推断。</div>`
  }
  // 同键多来源 = 模组覆盖了游戏默认,这是调平衡最该看的
  if (d.sources && d.sources.length > 1) {
    html += `<div class="ovr"><span>⚠ 有 ${d.sources.length} 处定义(模组覆盖游戏默认)</span></div>`
    for (const s of d.sources) {
      html +=
        `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:3px 8px;color:var(--ink3)">` +
        `<code>${esc(s.file)}:${s.line}</code><code>${esc(s.value)}</code></div>`
    }
  }
  box.innerHTML = html
}

/* ══════════════════════════════════════════════════════════════════
 * DEFDIFF_V1 —— 「原版默认值 → 模组生效值」差异视图(2026-10-07)
 *
 * 为什么要单独一页而不是在原表上标一列:
 *   原表是**键的目录**(6000+ 条原版默认值),差异是**另一个维度的问题**
 *   ——「模组动了什么」。混在一起会让 99% 的行都是"没动过",
 *   真正要看的几十条被淹掉。所以独立面板 + 三态筛选。
 *
 * 判据(全部在 engine/src/defines.ts 的 computeDefineDiffs):
 *   changed 真改动  值不同 → 算差异,给 delta / deltaPct
 *   same    同值重写 值相同但模组重写 → 灰显,不算改动
 *   added   模组新增 原版没有这个键
 * ★ -- 注释不参与比较(用户明确要求):模组常把 vanilla 的行尾注释删掉,
 *   若不剥注释会把"只删注释"全报成改动。
 * ══════════════════════════════════════════════════════════════════ */
let DIFF = { diffs: [], sum: null, kind: '', q: '', ready: false, error: '', baseName: '', loading: false }

/* ★ 引擎的 kind 词汇是 override / same-value / mod-add / mod-drop,
 *   UI 一律用 changed / same / added。三处(行 class、筛选、差值徽标)
 *   都依赖这个映射,以前两边各写各的 → 行渲染出来了但 tr.changed 选不中、
 *   差值列全变成"同值重写"徽标。真浏览器验收抓到的就是这个。*/
const KIND_MAP = { override: 'changed', 'same-value': 'same', 'mod-add': 'added', 'mod-drop': 'changed' }
function uiKind(k) {
  return KIND_MAP[k] || k || 'changed'
}

async function loadDiff() {
  DIFF.loading = true
  const qp = new URLSearchParams()
  if (DIFF.kind) qp.set('kind', DIFF.kind)
  if (DIFF.q) qp.set('q', DIFF.q)
  const d = await api('/api/defines/diff' + (qp.toString() ? '?' + qp : ''))
  DIFF.loading = false
  if (!d.ready) {
    DIFF.error = d.error || '解析中'
    renderDiff()
    return
  }
  DIFF.ready = true
  DIFF.error = d.error || ''
  DIFF.baseName = d.baseName || ''
  DIFF.sum = d.sum
  DIFF.diffs = (d.diffs || []).map((x) => ({ ...x, uiKind: uiKind(x.kind) }))
  DIFF.matched = d.matched
  renderDiff()
}

function fmtDelta(d) {
  if (d.delta === undefined || d.delta === null) return ''
  const cls = d.delta > 0 ? 'up' : d.delta < 0 ? 'dn' : 'same'
  const sign = d.delta > 0 ? '+' : ''
  let s = sign + d.delta
  // 百分比只在有意义时给(base 为 0 或非数值时不给,否则 +∞% 是噪声)
  if (d.deltaPct !== undefined && d.deltaPct !== null && isFinite(d.deltaPct)) {
    s += ' (' + (d.deltaPct > 0 ? '+' : '') + d.deltaPct.toFixed(0) + '%)'
  }
  return `<span class="dl ${cls}">${esc(s)}</span>`
}

function renderDiff() {
  const box = $('#diffBody')
  const hint = $('#diffHint')
  if (!box) return
  if (!DIFF.ready) {
    box.innerHTML = `<div class="empty">${DIFF.loading ? '比较中…' : esc(DIFF.error || '未就绪')}</div>`
    if (hint) hint.textContent = '—'
    return
  }
  if (DIFF.error) {
    box.innerHTML = `<div class="empty">${esc(DIFF.error)}</div>`
    if (hint) hint.textContent = '—'
    return
  }
  const s = DIFF.sum || { total: 0, changed: 0, same: 0, added: 0, up: 0, down: 0 }
  if (hint) {
    hint.innerHTML =
      `相对 <b>${esc(DIFF.baseName)}</b>:共 <b>${s.total}</b> 条被模组碰过 · ` +
      `<b style="color:var(--warn)">${s.changed}</b> 条真改动(升 ${s.up} / 降 ${s.down}) · ` +
      `${s.same} 条同值重写 · ${s.added} 条新增` +
      (DIFF.matched !== undefined && DIFF.matched !== s.total ? ` · 当前筛选出 ${DIFF.matched} 条` : '')
  }
  if (!DIFF.diffs.length) {
    box.innerHTML = `<div class="empty">没有符合条件的差异。${DIFF.kind === '' ? '模组可能没有改 defines。' : '换个筛选看看。'}</div>`
    return
  }
  // 按 group 分节,组内保持后端给的排序(变化最显著的在前)
  const byGroup = new Map()
  for (const d of DIFF.diffs) {
    if (!byGroup.has(d.group)) byGroup.set(d.group, [])
    byGroup.get(d.group).push(d)
  }
  const KIND_LABEL = { changed: '真改动', same: '同值重写', added: '模组新增' }
  let html = ''
  for (const [g, list] of byGroup) {
    html += `<div class="dgrp"><h3><span>${esc(g)}</span><span class="c">${list.length} 条</span></h3>` +
      `<table><thead><tr><th style="width:30%">键</th><th style="width:34%">原版 → 模组</th><th style="width:64px">差值</th><th style="width:80px">来源</th></tr></thead><tbody>`
    for (const d of list) {
      const uk = d.uiKind || 'changed'
      const oldV = d.base ? `<span class="old">${esc(d.base.value)}</span>` : `<span class="old">—</span>`
      const newV = `<span class="new">${esc(d.mod ? d.mod.value : '—')}</span>`
      const arrow = d.base ? '<span class="arrow">→</span>' : '<span class="arrow">新增</span>'
      const dl = uk === 'changed' ? fmtDelta(d) : `<span class="dl same">${KIND_LABEL[uk] || uk}</span>`
      const src = `<span class="sh">${esc(uk === 'added' ? '仅模组' : d.mod ? d.mod.file : '')}</span>` +
        (d.shadowed && d.shadowed.length ? `<span class="sh">被 ${d.shadowed.length} 层覆盖</span>` : '')
      const cmt = (d.mod && d.mod.comment) ? `<div class="cmt">${esc(d.mod.comment)}</div>` : ''
      html +=
        `<tr class="${esc(uk)}" data-dkey="${esc(d.key)}">` +
        `<td class="dk">${esc(d.name)}${cmt}</td>` +
        `<td class="dv">${oldV}${arrow}${newV}</td>` +
        `<td>${dl}</td>` +
        `<td>${src}</td>` +
        `</tr>`
    }
    html += `</tbody></table></div>`
  }
  box.innerHTML = html
}

function toggleDiffView(on) {
  const on2 = on === undefined ? $('#diffPanel').style.display === 'none' : on
  $('#diffPanel').style.display = on2 ? '' : 'none'
  $('#groups').style.display = on2 ? 'none' : ''
  $('#diffBtn').classList.toggle('on', on2)
  if (on2 && !DIFF.ready) loadDiff()
}

function wireDiff() {
  const btn = $('#diffBtn')
  if (btn) btn.onclick = () => toggleDiffView()
  const seg = $('#diffKind')
  if (seg) {
    seg.onclick = (e) => {
      const b = e.target.closest('button[data-k]')
      if (!b) return
      for (const x of seg.querySelectorAll('button')) x.classList.toggle('on', x === b)
      DIFF.kind = b.dataset.k
      DIFF.ready = false
      loadDiff()
    }
  }
  // 复用顶栏搜索框:在差异视图里也按键名/注释筛
  const q = $('#q')
  if (q) {
    const orig = q.oninput
    q.oninput = () => {
      if (orig) orig.call(q)
      if ($('#diffPanel').style.display !== 'none') {
        DIFF.q = q.value.trim()
        DIFF.ready = false
        clearTimeout(q._dt)
        q._dt = setTimeout(loadDiff, 220)
      }
    }
  }
}
wireDiff()

/* ── 工具栏 ── */
function bindToolbar() {
  const q = $('#q')
  let t = null
  q.oninput = () => {
    clearTimeout(t)
    t = setTimeout(() => { S.q = q.value.trim(); load() }, 220)
  }
  $('#typeSel').onchange = (e) => { S.type = e.target.value; load() }
  $('#srcSel').onchange = (e) => { S.src = e.target.value; load() }
  $('#onlyOv').onchange = (e) => { S.onlyOv = e.target.checked; render() }
}

/* 来源下拉:与 rootIdxOf 共用同一份来源表(Ctx.sources 内部有缓存) */
async function loadSources() {
  const list = (await Ctx.sources()) || []
  const sel = $('#srcSel')
  sel.innerHTML = '<option value="">全部来源</option>'
  for (const s of list) {
    const o = document.createElement('option')
    o.value = s.name
    o.textContent = s.name + (s.writable ? '' : '(只读)')
    sel.appendChild(o)
  }
}

/* ── 右键菜单 + 快捷键接线(CTX_V1 / KEYMAP_V1)──
 * 走 CtxWire.attach 统一入口(与其它页一致):它会设 __KEYMAP_PAGE__,
 * 并把 id 交给 keymap 目录解析键位 —— 用户在设置页改键才生效。
 */
function wireCtxAndKeys() {
  if (!window.CtxWire || !window.Ctx) return
  CtxWire.attach({
    page: 'defines',
    on: [
      {
        host: '#groups', sel: 'tr[data-key]',
        resolve: (el) => el,
        obj: (el) => {
          const e = el.__obj
          if (!e) return null
          // ★ root 必须是"来源在 ROOTS 里的真实序号",sourceItems 拿它去查
          //   root.path 拼绝对路径。填 0 会让 IDE/绝对路径全指到 vanilla ——
          //   模组改过的键会跳到游戏本体去(而且 0 是合法值,不会报错,最难发现)。
          return {
            id: e.key, file: plainPath(e.file), line: e.line,
            root: rootIdxOf(srcOf(e)), rootName: srcOf(e), defs: [{ root: rootIdxOf(srcOf(e)) }],
          }
        },
        items: (o, el) => {
          const e = el.__obj
          const extra = [
            { label: '复制键名', k: '⧉', act: () => Ctx.copy(e.key, '') },
            { label: '复制值', k: '⧉', act: () => Ctx.copy(String(e.value), '') },
          ]
          if (e.comment) extra.push({ label: '复制官方注释', k: '⧉', act: () => Ctx.copy(e.comment, '') })
          extra.push({ label: '复制组内键名', k: '⧉', act: () => {
            const same = S.entries.filter((x) => x.group === e.group)
            Ctx.copy(same.map((x) => x.key).join('\n'), `已复制 ${e.group} 的 ${same.length} 个键名`)
          } })
          extra.push({ label: '复制整行(名=值)', k: '⧉', act: () => Ctx.copy(`${e.name} = ${e.value}`, '') })
          return extra
        },
      },
      {
        host: '#grpList', sel: '.gi[data-group]',
        resolve: (el) => el,
        obj: (el) => el.__obj || null,
        items: (g) => [
          { label: '只看该组', k: '→', act: () => { S.group = g.name; load() } },
          { label: '复制该组键名清单', k: '⧉', act: () => {
            const same = S.entries.filter((x) => x.group === g.name)
            Ctx.copy(same.map((x) => x.key).join('\n'), `已复制 ${same.length} 个键名`)
          } },
          { label: '复制统计', k: '⧉', act: () => Ctx.copy(
            `${g.name}\t${g.count} 个键${g.overridden ? `\t${g.overridden} 个被模组改过` : ''}\t${g.file}`, '') },
        ],
      },
    ],
    keys: [
      { id: 'find.search', group: '查找', desc: '聚焦搜索框', run: () => {
        const q = $('#q'); if (q) { q.focus(); q.select() }
      } },
      { id: 'sel.copyId', group: '选中', desc: '复制当前参数的完整键名', run: () => {
        if (S.sel) Ctx.copy(S.sel, '已复制键名')
        else Ctx.toast('先用「/」搜索,或点选一条参数')
      } },
      { id: 'sel.clear', group: '选中', desc: '清空搜索与筛选', run: () => {
        S.q = ''; S.group = ''; S.type = ''; S.src = ''; S.onlyOv = false
        $('#q').value = ''; $('#typeSel').value = ''; $('#srcSel').value = ''; $('#onlyOv').checked = false
        load()
      } },
    ],
  })
}

wireCtxAndKeys()
bindToolbar()
preloadSources()
loadSources()
load()

/* 供页面级快捷键/右键菜单使用 */
window.DefinesState = S
window.DefinesSelect = select
