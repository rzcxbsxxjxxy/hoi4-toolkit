/* AI 行为(common/ai_*)可视化 —— AI_BEHAVE_V1
 *
 * 三级结构:方面(ai_strategy / ai_strategy_plans / ai_templates / ai_navy …)
 *          → 文件(逐个文件归纳,这是用户明确要的粒度)
 *          → 条目(文件内的顶层条目 + 关键字段摘要)
 *
 * 与 decisions 页的关系:同源同构(懒加载 + ready 轮询 + src 筛选 + 右键三件套),
 * 但陈列方式不同 —— 决议是"分类卡片墙",这里是"文件卡 + 卡内条目",
 * 因为 AI 内容的分析单元是**文件**(比如"模组改了 GER.txt 里的哪些策略")。
 */
const $ = (s) => document.querySelector(s)

const S = {
  aspects: [],
  byAsp: new Map(), // key → aspect
  selAsp: '',
  selFile: null, // { aspectKey, file, root }
  selEntry: null, // 条目对象
  q: '',
  src: '',
  sources: [],
  sourceStats: {},
  originStats: {},
  /** ★ OWNERSHIP_V1:生效集统计 { vanilla, override, new, effective, shadowed } */
  own: null,
  ownEntries: null,
  showShadowed: false,
  aiDetail: false,
  totalFiles: 0,
  totalEntries: 0,
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

/* PROGRESS_V1(2026-10-07):钩在 api() 内部,不包装全局函数(见 focus.js 同处注释) */
async function api(u, opt) {
window.LoadGate && window.LoadGate.show("正在加载AI行为…")
  // LOADGATE_V1:按功能懒加载 —— 图未就绪(busy)时全屏遮罩并轮询,就绪放行;已缓存页秒回。
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
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(`正在构建…`) }
      window.LoadGate && window.LoadGate.show(`加载中…`)
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

/* ── WIKI_V1:字段中文说明 / 策略类型目录(服务端 /api/aibehave/graph 下发) ── */
function wikiDoc(aspectKey, k) { const w = S.wiki.fieldDocs || {}; return (w[''] && w[''][k]) || (w[aspectKey] && w[aspectKey][k]) || '' }
const CAT_ZH = { diplomacy: '外交', army: '陆军', navy: '海军', intel: '情报', production: '生产', air: '空军', raid: '突袭', other: '其他' }
const CAT_ORDER = ['diplomacy', 'army', 'navy', 'intel', 'production', 'air', 'raid', 'other']

/* ── 来源筛选器(与 decisions / focus 同一套语义) ── */
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
  /* ★ OWNERSHIP_V1:筛选项统一为三态归属(原版 / 模组改写 / 模组新增)。
   *   注意「模组改写」= 原版有同名文件、被模组整份替换 —— 它不是"多出来一份",
   *   总数里只算一次(生效集),旧写法把两份都算就是"同名当增加"。 */
  const os = S.originStats || {}
  const ow = S.own || {}
  add('', `${tr("全部 (")}${S.totalFiles}${tr(" 文件)")}`, '同名文件只列最终生效的那一份')
  sep('── 内容归属 ──')
  add('vanilla', `${tr("原版 (")}${os.vanilla ?? ow.vanilla ?? 0})`, '原版文件,模组没有同名覆盖它')
  add('override', `${tr("模组改写 (")}${os.overridden ?? ow.override ?? 0})`, '原版有同名文件,被模组整份替换')
  add('new', `${tr("模组新增 (")}${os.modNew ?? ow.new ?? 0})`, '原版没有这个文件,模组新增 —— 与原版共存')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  const mods = S.sources.filter((s) => !s.base)
  if (mods.length) {
    sep('──────────')
    for (const s of mods) {
      const st = S.sourceStats[s.name] || { files: 0, entries: 0 }
      add(s.name, `${srcLabel(s.name)} (${st.files})`, s.path)
    }
  }
  sel.value = S.src
}
const SRC_HINT = {
  '': '',
  vanilla: '原版文件,模组没有同名覆盖它',
  override: '原版有同名文件,被模组整份替换 —— 原版那份已失效',
  new: '模组新增的文件(原版没有),与原版共存',
  base: '最终生效版本来自基础游戏',
  mod: '最终生效版本来自模组',
}
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources.filter((s) => s.base).length
  const mods = S.sources.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(`${tr("原版 ")}${base}`)
  if (mods) parts.push(`${tr("模组 ")}${mods}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : tr('来源:') + srcLabel(S.src)
  el.textContent = parts.length ? `${tr("来源 ")}${parts.join(' / ')}${hint ? ' · ' + hint : ''}` : ''
  el.title = hint
}

/* ── 加载 ── */
let _retry = 0
async function load() {
  /* ★ shadowed=1 才把"被模组同名替换掉、已失效的原版文件"也列出来(默认只列生效集) */
  const qs = []
  if (S.src) qs.push('src=' + encodeURIComponent(S.src))
  if (S.showShadowed) qs.push('shadowed=1')
  const d = await api('/api/aibehave/graph' + (qs.length ? '?' + qs.join('&') : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  _retry = 0
  S.aspects = d.aspects || []
  S.byAsp = new Map(S.aspects.map((a) => [a.key, a]))
  S.sources = d.sources || []
  S.sourceStats = d.sourceStats || {}
  S.originStats = d.originStats || {}
  S.own = d.own || null
  S.wiki = d.wiki || { strategyTypes: [], fieldDocs: {}, mtthDocs: '' }
  S.ownEntries = d.ownEntries || null
  /* ★ 生效集口径:files / entries 已经是"同名只算一次"的数字 */
  S.totalFiles = d.stats?.files ?? 0
  S.totalEntries = d.stats?.entries ?? 0
  const rawF = d.stats?.rawFiles ?? S.totalFiles
  const shownF = d.stats?.shownFiles ?? S.totalFiles
  const shownE = d.stats?.shownEntries ?? S.totalEntries
  $('#statChip').textContent =
    shownF < S.totalFiles
      ? `${shownF}/${S.totalFiles}${tr(" 文件 · ")}${shownE}/${S.totalEntries}${tr(" 条目(筛选中)")}`
      : `${S.aspects.length}${tr(" 方面 / ")}${S.totalFiles}${tr(" 文件 / ")}${S.totalEntries}${tr(" 条目")}`
  $('#statChip').title =
    Own.statsLine(S.own) +
    `${tr("\\n(磁盘上共 ")}${rawF}${tr(" 个文件,其中 ")}${S.own?.shadowed ?? 0}${tr(" 个原版文件被模组同名替换后失效,不计入生效数)")}`
  if (S.selAsp && !S.byAsp.has(S.selAsp)) S.selAsp = ''
  buildSrcSel()
  srcSummary()
  const sel = $('#aspSel')
  sel.innerHTML = '<option value="">全部方面</option>'
  for (const a of S.aspects) {
    const o = document.createElement('option')
    o.value = a.key
    o.textContent = `${a.label} · ${a.key} (${a.stats.files})`
    sel.appendChild(o)
  }
  sel.value = S.selAsp
  renderAspList()
  renderFiles()
  if (S.selAsp) showAspect(S.selAsp)
}

/* ── 左栏:方面 ── */
function renderAspList() {
  const q = $('#q').value.trim().toLowerCase()
  const list = q ? S.aspects.filter((a) => (a.key + ' ' + a.label).toLowerCase().includes(q)) : S.aspects
  $('#aspCount').textContent = `${list.length}/${S.aspects.length}`
  const box = $('#aspList')
  box.innerHTML = ''
  for (const a of list) {
    const el = document.createElement('div')
    el.className = 'item' + (S.selAsp === a.key ? ' on' : '')
    el.dataset.id = a.key
    el.__obj = a
    const modFiles = a.stats.modFiles || 0
    el.innerHTML =
      `<span>${esc(a.label)}</span> ` +
      (modFiles ? `${tr("<span class=\"src mod\">模 ")}${modFiles}</span> ` : '') +
      `<span class="tag">${a.stats.files}${tr(" 文件 / ")}${a.stats.entries}</span>`
    el.title = `${a.key}\n${a.desc}${tr("\\n文件 ")}${a.stats.files}${tr("(模组 ")}${modFiles}${tr(")· 条目 ")}${a.stats.entries}`
    el.onclick = () => {
      S.selAsp = S.selAsp === a.key ? '' : a.key
      S.selFile = null
      S.selEntry = null
      $('#aspSel').value = S.selAsp
      renderAspList()
      renderFiles()
      if (S.selAsp) showAspect(S.selAsp)
      else $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">选中一个方面 / 文件 / 条目</div>'
    }
    box.appendChild(el)
  }
}

/* ── 中栏:文件卡 ── */
function visibleFiles() {
  const q = $('#q').value.trim().toLowerCase()
  const out = []
  for (const a of S.aspects) {
    if (S.selAsp && a.key !== S.selAsp) continue
    for (const f of a.files) {
      if (!q) {
        out.push({ a, f })
        continue
      }
      // 搜索:文件名 / 条目 id / 字段名 任一命中
      let hit = f.file.toLowerCase().includes(q)
      if (!hit) hit = f.entries.some((e) => e.id.toLowerCase().includes(q))
      if (!hit) hit = f.topKeys.some((t) => t.k.toLowerCase().includes(q))
      if (hit) out.push({ a, f })
    }
  }
  return out
}

function renderFiles() {
  const rows = visibleFiles()
  const mods = rows.filter((r) => !r.f.base).length
  $('#fileSum').innerHTML =
    (rows.length
      ? `<span>${rows.length}${tr(" 个文件 · 模组 ")}${mods}${tr(" / 原版 ")}${rows.length - mods}${
          S.src ? ` · 已按来源筛选(生效集共 ${S.totalFiles})` : ''
        }</span>`
      : '') + `<span style="color:var(--ink2)">${Own.statsLine(S.own)}</span>`
  const box = $('#fileList')
  if (!rows.length) {
    box.innerHTML = '<div class="empty">没有匹配的文件</div>'
    return
  }
  // 文件数上千(实测 400),分批建 DOM 免得首屏卡
  Incr.mount(box, rows, makeFileCard, { batch: 60 })
}

const MAX_CHIPS = 12

function makeFileCard(row) {
  const { a, f } = row
  const card = document.createElement('div')
  card.className = 'fcard' + (f.base ? '' : ' frommod') + (f.stale ? ' stale' : '')
  card.dataset.file = f.file
  card.dataset.root = String(f.root)
  card.__obj = { _a: a, _f: f }

  // ★ OWNERSHIP_V1:徽标统一走 Own(原版 / 模组改写 / 模组新增),不再各页自己推
  const ownTxt = f.stale ? '已失效' : Own.label(f)
  const ownCls = f.stale ? 'stale' : Own.CLS[Own.of(f)]
  // 面向模组制作者:同文件被多个来源定义时,把"还有谁定义了它"写进提示
  const others = (f.defs || []).length
  const chips = f.entries.slice(0, MAX_CHIPS).map((e) => entryChip(e))
  const more = f.entries.length - chips.length
  const kb = (f.bytes / 1024).toFixed(1)
  card.innerHTML =
    `<div class="fh">` +
    `<span class="fn" data-act="file">${esc(shortPath(f.file))}</span>` +
    `<span class="src ${ownCls}">${ownTxt}</span>` +
    (f.base ? '' : `<span class="mini m">${esc(srcLabel(f.rootName))}</span>`) +
    `<span class="mini">${f.entries.length}${tr(" 条目</span>")}` +
    `</div>` +
    `<div class="fm"><span>${esc(f.file)}</span><span>${f.lines}${tr(" 行 · ")}${kb} KB${
      f.sub ? ` · ${esc(f.sub)}/` : ''
    }</span>${others > 1 ? `<span>${f.stale ? '被' : '另有'} ${others - 1} 处同名定义</span>` : ''}${
      f.parseError ? `<span style="color:var(--danger)">解析异常</span>` : ''
    }</div>` +
    (f.entries.length
      ? `<div class="fe">${chips.join('')}${more > 0 ? `<span class="echip" data-act="more">+${more} 条…</span>` : ''}</div>`
      : `<div class="empty-note">无可识别条目(整文件可能被注释,或是纯脚本块)</div>`) +
    (f.topKeys.length
      ? `<div class="fe">${f.topKeys
          .slice(0, 4)
          .map((t) => `<span class="mini k">${esc(t.k)} ×${t.n}</span>`)
          .join('')}</div>`
      : '')

  // ★ chip 是 innerHTML 字符串建的,__obj 必须**建完 DOM 后按索引回挂** ——
  //   不挂的话点条目没反应,右键菜单同样取不到数据(静默失效,不报错)。
  bindChips(card, f)

  card.title =
    `${f.file}${tr("\\n归属: ")}${ownTxt}` +
    (f.stale
      ? `\n⚠ 这个文件被更高优先级的来源同名替换了,在游戏里不生效(旧版本)`
      : `\n${Own.hint(f)}${tr("\\n最终生效: ")}${f.rootName}(${f.base ? '基础游戏' : '模组'})`) +
    `${tr("\\n方面: ")}${a.label} · ${a.key}`

  // 点文件名 → 检查器显示文件详情;点条目 chip → 显示条目详情
  card.addEventListener('click', (ev) => {
    const chip = ev.target.closest ? ev.target.closest('.echip') : null
    if (chip) {
      if (chip.dataset.act === 'more') {
        renderExpanded(card, f)
        return
      }
      const e = chip.__obj
      if (e) selectEntry(e, a, f)
      return
    }
    const nm = ev.target.closest ? ev.target.closest('.fn') : null
    if (nm) selectFile(a, f)
  })
  return card
}

/** 去掉 common/ai_xxx/ 前缀,卡上只留文件名(完整路径在下面一行) */
function shortPath(file) {
  const i = file.lastIndexOf('/')
  return i < 0 ? file : file.slice(i + 1)
}

function entryChip(e) {
  const tail = []
  if (e.flags.length) tail.push(e.flags.slice(0, 2).join('·'))
  if (e.blocks.length) tail.push(`${e.blocks[0].k}×${e.blocks[0].n}`)
  const t = tail.length ? ` <span class="ct">${esc(tail.join(' '))}</span>` : ''
  // ★ 条目也可能被更高优先级来源的同名条目替换(整文件替换时整卡都是旧的)
  const cls = 'echip' + (e.stale ? ' stale' : '')
  return `<span class="${cls}" data-act="entry" title="${esc(
    e.stale ? '已被同名条目替换,游戏里不生效' : Own.hint(e),
  )}">${esc(e.id)}${t}</span>`
}

/** chip(字符串模板产物)→ 挂回条目对象。索引与 f.entries 一一对应。 */
function bindChips(card, f) {
  card.querySelectorAll('.echip[data-act="entry"]').forEach((el, i) => {
    if (f.entries[i]) el.__obj = f.entries[i]
  })
}

/** "+N 条…" → 展开该文件的全部条目 */
function renderExpanded(card, f) {
  const box = card.querySelector('.fe')
  if (!box) return
  box.innerHTML = f.entries.map((e) => entryChip(e)).join('')
  bindChips(card, f)
}

/* ── 右栏:检查器 ── */
function showAspect(key) {
  const a = S.byAsp.get(key)
  if (!a) return
  const max = Math.max(1, ...a.profile.map((p) => p.n))
  const prof = a.profile.length
    ? a.profile
        .map(
          (p) =>
            `<div class="row"><b title="${esc(p.k)}">${esc(p.k)}</b>` +
            `<i><u style="width:${Math.round((p.n / max) * 100)}%"></u></i>` +
            `<s>${p.n}${tr(" 条目")}${p.block ? ` · ${p.block} 块` : ''}</s></div>`,
        )
        .join('')
    : '<div style="color:var(--ink3)">无字段数据</div>'
  /* WIKI_V1:方面级字段说明 / MTTH 速览 / ai_strategy 策略类型速查 */
  const fd = (S.wiki.fieldDocs || {})[a.key] || {}
  const fieldDocRows = Object.keys(fd).length
    ? `<div class="sec-t">${tr('字段说明 (Wiki)')}</div>` +
      Object.entries(fd).map(([k, v]) => `<div class="kv sub"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')
    : ''
  const mtthSec = S.wiki.mtthDocs
    ? `<details class="wiki-d"><summary>${tr('MTTH 机制速览 (Wiki)')}</summary><div class="desc">${esc(S.wiki.mtthDocs)}</div></details>`
    : ''
  let stratSec = ''
  if (a.key === 'ai_strategy') {
    const list = S.wiki.strategyTypes || []
    if (list.length) {
      const byCat = CAT_ORDER.map((cat) => ({ cat, items: list.filter((t) => (t.cat || 'other') === cat) })).filter((g) => g.items.length)
      stratSec = `<details class="wiki-d"><summary>${tr('策略类型速查 (Wiki)')} · ${list.length}${tr(' 类')}</summary><div style="max-height:320px;overflow:auto">` +
        byCat.map((g) => `<div class="sec-t">${CAT_ZH[g.cat]} (${g.items.length})</div>` + g.items.map((t) => `<div class="kv sub"><b>${esc(t.name)}</b><span>${esc(t.desc || '')}</span></div>`).join('')).join('') +
        `</div></details>`
    }
  }
  $('#insp').innerHTML =
    `${tr("<div class=\"kv\"><b>方面</b><span>")}${esc(a.key)}</span></div>` +
    `${tr("<div class=\"kv\"><b>名称</b><span>")}${esc(a.label)}</span></div>` +
    `${tr("<div class=\"kv\"><b>类型</b><span>")}${a.isFile ? '单个配置文件' : '目录(含子目录)'}</span></div>` +
    `${tr("<div class=\"kv\"><b>文件</b><span>")}${a.stats.files}${a.stats.modFiles ? ` · 模组 ${a.stats.modFiles}` : ''}</span></div>` +
    `${tr("<div class=\"kv\"><b>条目</b><span>")}${a.stats.entries}</span></div>` +
    (a.docFile ? `${tr("<div class=\"kv\"><b>官方文档</b><span>")}${esc(a.docFile)}</span></div>` : '') +
    `<div class="desc">${esc(a.desc)}</div>` +
    `<div class="sec-t">字段画像 · 该方面最常用的字段</div>` +
    `<div class="prof">${prof}</div>` +
    fieldDocRows +
    mtthSec +
    stratSec
}

function selectFile(a, f) {
  S.selFile = { aspectKey: a.key, file: f.file, root: f.root }
  S.selEntry = null
  for (const c of document.querySelectorAll('.fcard')) {
    c.classList.toggle('on', c.dataset.file === f.file && c.dataset.root === String(f.root))
  }
  const own = f.stale ? '已失效(被同名替换)' : Own.label(f)
  /* ★ 覆盖链:同名文件在哪些来源里都写过,最后一行的才是生效的 */
  const chainRows = (f.defs || []).length
    ? `<div class="sec-t">覆盖链 · 同名文件的各来源定义</div>` +
      (f.defs || [])
        .map(
          (d) =>
            `<div class="kv"><b>${esc(d.base ? '基础游戏' : d.rootName)}</b><span>${esc(d.file)}:${d.line}${
              d.root === f.root ? '' : ''
            }${d.root === (f.defs || []).slice(-1)[0].root ? ' · 生效' : ' · 已被覆盖'}</span></div>`,
        )
        .join('')
    : ''
  const rows = f.entries
    .slice(0, 40)
    .map(
      (e) =>
        `<div class="kv"><b style="width:auto;flex:1">${esc(e.id)}</b><span style="flex:none;color:var(--ink3)">:${e.line}</span></div>`,
    )
    .join('')
  $('#insp').innerHTML =
    `${tr("<div class=\"kv\"><b>文件</b><span>")}${esc(f.file)}</span></div>` +
    `${tr("<div class=\"kv\"><b>方面</b><span>")}${esc(a.label)} · ${esc(a.key)}${f.sub ? ' / ' + esc(f.sub) : ''}</span></div>` +
    `${tr("<div class=\"kv\"><b>内容归属</b><span><span class=\"src ")}${
      f.stale ? 'stale' : Own.CLS[Own.of(f)]
    }">${own}</span></span></div>` +
    (f.stale ? '' : `${tr("<div class=\"kv\"><b>含义</b><span style=\"font-size:11px\">")}${esc(Own.hint(f))}</span></div>`) +
    `${tr("<div class=\"kv\"><b>生效来源</b><span><span class=\"src ")}${f.base ? 'base' : 'mod'}">${esc(
      srcLabel(f.rootName),
    )}</span></span></div>` +
    chainRows +
    `${tr("<div class=\"kv\"><b>规模</b><span>")}${f.lines}${tr(" 行 · ")}${(f.bytes / 1024).toFixed(1)} KB · ${f.entries.length}${tr(" 条目</span></div>")}` +
    (f.parseError ? `${tr("<div class=\"kv\"><b>解析</b><span style=\"color:var(--danger)\">")}${esc(f.parseError)}</span></div>` : '') +
    (f.topKeys.length
      ? `${tr("<div class=\"sec-t\">顶层键</div><div>")}${f.topKeys
          .map((t) => `<span class="mini k">${esc(t.k)} ×${t.n}</span>`)
          .join(' ')}</div>`
      : '') +
    `${tr("<div class=\"sec-t\">条目")}${f.entries.length > 40 ? ' (前 40)' : ''}</div>` +
    (rows || '<div style="color:var(--ink3)">无</div>')
}

function selectEntry(e, a, f) {
  S.selEntry = e
  S.selFile = { aspectKey: a.key, file: f.file, root: f.root }
  for (const c of document.querySelectorAll('.echip')) {
    c.classList.toggle('on', c.__obj === e)
  }
  renderEntryInsp(e, a, f)
}

function renderEntryInsp(e, a, f) {
  $('#insp').innerHTML = entryInspHTML(e, a, f)
  const btn = $('#inspDetailBtn')
  if (btn)
    btn.onclick = () => {
      S.aiDetail = !S.aiDetail
      renderEntryInsp(e, a, f)
    }
}

/** RAWS_V1:把条目的顶层脚本块**完整原文**(allowed/enable/abort/ai_strategy …)分组渲染。
 *  重复块各占一个 <pre>(如多次 ai_strategy = {…}),逐块完整展示,不裁剪。 */
function rawBlocksHTML(raws, aspectKey) {
  if (!raws || !raws.length) return '<div style="color:var(--ink3)">无脚本块</div>'
  const groups = new Map()
  for (const r of raws) {
    if (!groups.has(r.k)) groups.set(r.k, [])
    groups.get(r.k).push(r.text)
  }
  let out = ''
  for (const [k, texts] of groups) {
    out += `<div class="sec-t">▸ ${esc(k)}${texts.length > 1 ? ` ×${texts.length}` : ''}</div>`
    const wd = wikiDoc(aspectKey, k)
    if (wd) out += `<div class="wk">${esc(wd)}</div>`
    texts.forEach((t) => { out += `<pre class="raw">${esc(t)}</pre>` })
  }
  /* WIKI_V1:ai_strategy 块里出现的 type=XXX,按 Wiki 目录挂成策略类型卡片 */
  if (groups.has('ai_strategy')) {
    const types = []
    for (const t of groups.get('ai_strategy')) {
      const m = t.match(/type\s*=\s*([\w]+)/g)
      if (m) for (const mm of m) { const v = /type\s*=\s*([\w]+)/.exec(mm)[1]; if (!types.includes(v)) types.push(v) }
    }
    if (types.length) {
      const idx = new Map((S.wiki.strategyTypes || []).map((d) => [d.name, d]))
      out += `<div class="sec-t">${tr('策略类型')}</div>`
      out += `<div class="wk">${tr('本节依据 HOI4 官方 Wiki「AI modding」与游戏自带 _documentation.md')}</div>`
      for (const name of types) {
        const doc = idx.get(name)
        if (!doc) { out += `<span class="mini">type = ${esc(name)} · ${tr('目录未收录')}</span>`; continue }
        out += `<div class="wk-card"><span class="wk-cat">${CAT_ZH[doc.cat] || '其他'}</span><b>${esc(doc.name)}</b>`
        out += `<div class="wk-desc">${esc(doc.desc || '')}</div>`
        if (doc.params && doc.params.length) out += `<div class="wk-params">${doc.params.map(esc).join('<br>')}</div>`
        if (doc.note) out += `<div class="wk-note">${esc(doc.note)}</div>`
        if (doc.example) out += `<pre class="raw">${esc(doc.example)}</pre>`
        out += `</div>`
      }
    }
  }
  return out
}

/* 条目检查器:默认摘要;点「显示详情」展开完整嵌套结构(每个块里具体填了什么值)。 */
function entryInspHTML(e, a, f) {
  const scalars = e.scalars.length
    ? e.scalars.map((s) => `<div class="kv"><b>${esc(s.k)}</b><span>${esc(s.v)}</span></div>`).join('')
    : '<div style="color:var(--ink3)">无标量字段</div>'
  const blocks = e.blocks.length
    ? e.blocks.map((b) => `<span class="mini k">${esc(b.k)} ×${b.n}</span>`).join(' ')
    : '<span style="color:var(--ink3)">无子块</span>'
  const flags = e.flags.length ? e.flags.map((x) => `<span class="mini">${esc(x)}</span>`).join(' ') : '<span style="color:var(--ink3)">无</span>'
  let detail = ''
  if (S.aiDetail) {
    const subs = (e.subs || []).length
      ? (e.subs || [])
          .map((sb) => {
            const items = sb.items.length
              ? sb.items
                  .map((it) =>
                    it.isBlock
                      ? `<div class="kv sub"><b>${esc(it.k)}${tr("</b><span style=\"color:var(--ink3)\">块</span></div>")}`
                      : `<div class="kv sub"><b>${esc(it.k)}</b><span>${esc(it.v)}</span></div>`,
                  )
                  .join('')
              : '<div style="color:var(--ink3);padding-left:10px">（空块）</div>'
            return `<div class="sec-t">▸ ${esc(sb.k)}${sb.n > 1 ? ` ×${sb.n}` : ''}</div>${items}`
          })
          .join('')
      : '<div style="color:var(--ink3)">无嵌套子字段</div>'
    detail =
      `<div class="sec-t">完整结构(显示详情)</div>` +
      (e.loc ? `<div class="kv"><b>loc key</b><span>${esc(e.loc)}</span></div>` : '') +
      subs
  }
  /* WIKI_V1:字段逐项对照表(字段名→中文说明),与上面的原文块并存,只列有说明的 */
  const wikiKeys = []
  for (const r of e.raws || []) if (!wikiKeys.includes(r.k)) wikiKeys.push(r.k)
  const wikiRows = []
  for (const k of wikiKeys) { const wd = wikiDoc(a.key, k); if (wd) wikiRows.push(`<div class="kv sub"><b>${esc(k)}</b><span>${esc(wd)}</span></div>`) }
  for (const s of e.scalars || []) { const wd = wikiDoc(a.key, s.k); if (wd) wikiRows.push(`<div class="kv sub"><b>${esc(s.k)}</b><span>${esc(wd)}</span></div>`) }
  const wikiSec = wikiRows.length
    ? `${tr("<div class=\"sec-t\">Wiki 说明 · 字段逐项</div>")}${wikiRows.join('')}`
    : `${tr("<div class=\"sec-t\">Wiki 说明 · 字段逐项</div><div style=\"color:var(--ink3)\">无对应 Wiki 说明</div>")}`
  return (
    `<button id="inspDetailBtn" class="dbtn">${S.aiDetail ? '▾ 收起详情' : '▸ 显示详情'}</button>` +
    `${tr("<div class=\"kv\"><b>条目</b><span>")}${esc(e.id)}</span></div>` +
    `${tr("<div class=\"kv\"><b>归属</b><span><span class=\"src ")}${Own.CLS[Own.of(e)]}">${Own.label(e)}</span></span></div>` +
    `${tr("<div class=\"kv\"><b>类型</b><span>")}${esc(e.kind || '顶层条目')}</span></div>` +
    `${tr("<div class=\"kv\"><b>方面</b><span>")}${esc(a.label)} · ${esc(a.key)}</span></div>` +
    `${tr("<div class=\"kv\"><b>位置</b><span>")}${esc(e.rootName + ':' + e.file)}:${e.line}</span></div>` +
    `${tr("<div class=\"kv\"><b>生效来源</b><span><span class=\"src ")}${e.base ? 'base' : 'mod'}">${esc(
      srcLabel(e.rootName),
    )}</span></span></div>` +
    `${tr("<div class=\"sec-t\">标量字段")}${S.aiDetail ? '' : `（前 ${e.scalars.length}）`}</div>${scalars}` +
    `${tr("<div class=\"sec-t\">子块构成</div><div>")}${blocks}</div>` +
    `${tr("<div class=\"sec-t\">脚本块</div><div>")}${flags}</div>` +
    `${tr("<div class=\"sec-t\">脚本块详情 · 完整原文</div>")}${rawBlocksHTML(e.raws, a.key)}` +
    wikiSec +
    detail
  )
}

/* ── 绑定 ── */
$('#q').addEventListener('input', () => {
  renderAspList()
  renderFiles()
})
$('#aspSel').addEventListener('change', (e) => {
  S.selAsp = e.target.value
  S.selFile = null
  S.selEntry = null
  renderAspList()
  renderFiles()
  if (S.selAsp) showAspect(S.selAsp)
})
$('#srcSel').addEventListener('change', async (e) => {
  S.src = e.target.value
  S.selFile = null
  S.selEntry = null
  $('#insp').innerHTML = '<div style="color:var(--ink3);padding:6px 11px">选中一个方面 / 文件 / 条目</div>'
  await load()
})
/* ★ 勾选后重新拉取:把"被同名替换而失效的旧版本"也列出来(灰色删除线) */
$('#shadowChk').addEventListener('change', async (e) => {
  S.showShadowed = !!e.target.checked
  await load()
})

Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event('resize')))

/* ══════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键
 * ⚠ 铁律:数据一律从 el.__obj 取,绝不按 DOM 文本反查
 *   (文件名/条目名都是数据,改显示就会失配)。
 * ⚠ 文件卡是 Incr 分批重建的 → 必须事件委托(Ctx.attach)。
 * ══════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire) return
  CtxWire.attach({
    page: 'aibehave',
    on: [
      /* 文件卡:定位到文件本身(行 1) */
      {
        host: '#fileList',
        sel: '.fcard',
        obj: (el) => {
          const o = el.__obj
          if (!o) return null
          const f = o._f
          return { root: f.root, rootName: f.rootName, file: f.file, line: 1, id: shortPath(f.file), _f: f, _a: o._a }
        },
        items: (o) => [
          {
            label: '只看这个方面',
            k: '→',
            act: () => {
              S.selAsp = o._a.key
              $('#aspSel').value = o._a.key
              renderAspList()
              renderFiles()
              showAspect(o._a.key)
            },
          },
          { label: `${tr("复制文件名(")}${shortPath(o._f.file)})`, k: '⧉', act: () => Ctx.copy(shortPath(o._f.file), '') },
        ],
      },
      /* 条目 chip:定位到条目的具体行 */
      {
        host: '#fileList',
        sel: '.echip',
        obj: (el) => {
          const e = el.__obj
          if (!e) return null
          return { root: e.root, rootName: e.rootName, file: e.file, line: e.line, id: e.id, loc: e.loc, _e: e }
        },
        items: (o) => [
          { label: '复制条目 id', k: '⧉', act: () => Ctx.copy(o.id, '') },
          ...(o._e.scalars[0]
            ? [
                {
                  label: `${tr("复制 ")}${o._e.scalars[0].k}(${o._e.scalars[0].v})`,
                  k: '⧉',
                  act: () => Ctx.copy(o._e.scalars[0].v, ''),
                },
              ]
            : []),
        ],
      },
      /* 左栏方面 */
      {
        host: '#aspList',
        sel: '.item',
        obj: (el) => (el.__obj ? { id: el.__obj.key, rootName: 'AI 方面', _a: el.__obj } : null),
        items: (o) => [
          { label: '复制方面目录名', k: '⧉', act: () => Ctx.copy(o.id, '') },
          {
            label: o.id === S.selAsp ? '取消筛选' : '只看这个方面',
            k: '→',
            act: () => {
              S.selAsp = o.id === S.selAsp ? '' : o.id
              $('#aspSel').value = S.selAsp
              renderAspList()
              renderFiles()
            },
          },
        ],
      },
    ],
    keys: [
      { id: 'find.search', run: () => { const q = $('#q'); if (q) q.focus() }, desc: '聚焦搜索框', group: '查找' },
      ...CtxWire.commonKeys(
        () => (S.selEntry ? { id: S.selEntry.id } : S.selFile ? { id: shortPath(S.selFile.file) } : null),
        {
          label: '条目 / 文件',
          clear: () => {
            S.selEntry = null
            S.selFile = null
            for (const c of document.querySelectorAll('.fcard')) c.classList.remove('on')
            for (const c of document.querySelectorAll('.echip')) c.classList.remove('on')
          },
        },
      ),
      { id: 'sel.clear', desc: '取消选择', group: '选中', run: () => { S.selEntry = null; S.selFile = null; for (const c of document.querySelectorAll('.fcard')) c.classList.remove('on'); for (const c of document.querySelectorAll('.echip')) c.classList.remove('on') } },
    ],
  })
}
wireCtxAndKeys()

load()
