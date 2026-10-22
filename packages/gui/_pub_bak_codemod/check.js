'use strict'
/**
 * HOI4 模组体检前端。
 *
 * ★ MOD_SCOPE_V1:支持「只体检某一个模组」。
 *   目标由后端 /api/check/target 管理 —— 它才知道哪些来源已挂载、
 *   模组名怎么从 .mod 读、路径有没有重复。前端只负责三件事:
 *     - 拉候选清单 → 填下拉(带 .mod 元信息)
 *     - 设定 / 清除目标 → 重置轮询
 *     - 把目标信息显示出来
 *
 * 关键约定:**范围写在报告里**(rep.scope / rep.contextOnly 由后端下发)。
 *   前端不自己推断 —— 推断就得在前端复刻一遍 root 归属逻辑,两处必然漂移。
 */

const $ = (sel) => document.querySelector(sel)
const statusEl = $('#status')
const cardsEl = $('#cards')
const sectionsEl = $('#sections')

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
function fileLink(rel, line) {
  const l = line != null ? ':' + line : ''
  return `<a class="file" href="/?file=${encodeURIComponent(rel)}">${esc(rel)}</a>${l ? ` <span class="muted">${l}</span>` : ''}`
}

function card(cls, n, label) {
  return `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`
}

function section(title, count, bodyHtml) {
  const cnt = `<span class="cnt">${count == null ? '' : count + ' 项'}</span>`
  return `<section><h2>${esc(title)} ${cnt}</h2><div class="row">${bodyHtml || '<div class="muted">未发现明显问题</div>'}</div></section>`
}

/* ══════════════════════════════════════════════════════════════
 * 目标选择
 * ══════════════════════════════════════════════════════════════ */

const tSel = $('#tSel')
const tPath = $('#tPath')
const tErr = $('#tErr')
const tMeta = $('#tMeta')
const bApply = $('#tApply')
const bClear = $('#tClear')
let TARGET = null

function setErr(msg) {
  tErr.textContent = msg || ''
}

/** 候选清单填下拉:已挂载来源与创意工坊订阅模组分两组。 */
function fillCandidates(cands, workshop) {
  const cur = TARGET ? TARGET.path : ''
  tSel.innerHTML = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = '全部来源(vanilla + 已挂载模组)'
  all.selected = !cur
  tSel.appendChild(all)

  const addGroup = (label, list) => {
    if (!list || !list.length) return
    const g = document.createElement('optgroup')
    g.label = label
    for (const c of list) {
      const o = document.createElement('option')
      o.value = c.path
      const bad = c.versionOk === false
      o.textContent =
        c.name +
        (c.mounted ? '  [已挂载]' : '') +
        (c.hasModFile ? '' : '  [无 .mod]') +
        (bad ? '  ⚠ 版本不匹配' : '')
      g.appendChild(o)
    }
    tSel.appendChild(g)
  }
  addGroup('已挂载来源', (cands || []).filter((c) => c.mounted))
  addGroup('创意工坊(未挂载)', workshop)

  // 目标不在候选里(手动输了别的路径)→ 临时补一条,
  // 否则下拉会显示「全部来源」而实际在查单个模组,很容易误读。
  if (cur) {
    const hit = Array.from(tSel.options).some((o) => o.value === cur)
    if (!hit) {
      const o = document.createElement('option')
      o.value = cur
      o.textContent = TARGET.name + '  [当前]'
      tSel.appendChild(o)
    }
    tSel.value = cur
  }
}

/** 目标元信息(读自 .mod):让人知道「查的是哪个版本的什么模组」。 */
function renderMeta(t) {
  if (!t) {
    tMeta.innerHTML =
      '<span class="pill muted">全量体检</span>' +
      '<span class="pill muted">统计所有已挂载来源的问题</span>'
    return
  }
  const p = []
  p.push('<span class="pill">' + esc(t.name) + '</span>')
  p.push('<span class="pill ' + (t.mounted ? '' : 'muted') + '">' + (t.mounted ? '已挂载' : '未挂载 · 仅体检') + '</span>')
  if (t.modFile) p.push('<span class="pill muted">' + esc(t.modFile) + '</span>')
  if (t.modVersion) p.push('<span class="pill muted">v' + esc(t.modVersion) + '</span>')
  if (t.supportedVersion) {
    const cls = t.versionOk === false ? 'bad' : t.versionOk ? 'ok' : 'muted'
    const mark = t.versionOk === false ? '⚠ ' : t.versionOk ? '✔ ' : ''
    p.push('<span class="pill ' + cls + '">' + mark + '支持 ' + esc(t.supportedVersion) + '</span>')
  }
  if (!t.hasModFile) p.push('<span class="pill bad">无 .mod · 按目录结构识别</span>')
  for (const tag of t.tags || []) p.push('<span class="pill muted">' + esc(tag) + '</span>')
  tMeta.innerHTML = p.join('')
}

async function loadTarget() {
  try {
    const r = await fetch('/api/check/target')
    const j = await r.json()
    TARGET = j.target
    fillCandidates(j.candidates, j.workshop)
    renderMeta(j.target)
    setErr(j.error || '')
    return j
  } catch (e) {
    setErr('读取模组清单失败: ' + e.message)
    return null
  }
}

/** 设定 / 清除目标;成功后重置报告并重新轮询。 */
async function applyTarget(path) {
  setErr('')
  tSel.disabled = bApply.disabled = bClear.disabled = true
  try {
    const r = await fetch('/api/check/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path || null }),
    })
    const j = await r.json()
    if (!r.ok) {
      setErr(j.error || '设定失败')
      return false
    }
    TARGET = j.target
    renderMeta(j.target)
    tPath.value = j.target ? j.target.path : ''
    await loadTarget() // 候选清单要重拉:新目标可能被加进 candidates
    restart()
    return true
  } catch (e) {
    setErr('设定失败: ' + e.message)
    return false
  } finally {
    tSel.disabled = bApply.disabled = bClear.disabled = false
  }
}

/* ── 目录选择器(与 open.html 同形态)── */
const mask = $('#mask')
let pkCur = ''
let pkDone = null

function browse(path) {
  pkCur = path || ''
  fetch('/api/browse?path=' + encodeURIComponent(pkCur))
    .then((r) => r.json())
    .then((j) => {
      $('#pkPath').textContent = j.path || '（计算机）'
      $('#pkSel').textContent = j.path || ''
      const list = $('#pkList')
      list.innerHTML = ''
      if (j.error) {
        list.innerHTML = '<div class="d"><span class="nm">' + esc(j.error) + '</span></div>'
        return
      }
      const dirs = j.dirs || []
      for (const d of dirs) {
        const row = document.createElement('div')
        row.className = 'd'
        const nm = document.createElement('span')
        nm.className = 'nm'
        nm.textContent = d.name
        row.appendChild(nm)
        // 体检目标最关心的就是「这个目录里有没有 .mod」,直接标出来
        if (d.isMod) {
          const v = document.createElement('span')
          v.className = 'v modf'
          v.textContent = '✔ .mod'
          row.appendChild(v)
        }
        row.title = d.path
        row.onclick = () => browse(d.path)
        list.appendChild(row)
      }
      if (!dirs.length) list.innerHTML = '<div class="d"><span class="nm muted">（没有子目录）</span></div>'
    })
    .catch((e) => {
      $('#pkList').innerHTML = '<div class="d"><span class="nm">读取失败：' + esc(e.message) + '</span></div>'
    })
}

function pickDir(start, done) {
  pkDone = done
  mask.classList.add('show')
  browse(start || '')
}
$('#pkClose').onclick = () => {
  mask.classList.remove('show')
  pkDone = null
}
mask.onclick = (e) => {
  if (e.target === mask) {
    mask.classList.remove('show')
    pkDone = null
  }
}
$('#pkUp').onclick = () =>
  fetch('/api/browse?path=' + encodeURIComponent(pkCur))
    .then((r) => r.json())
    .then((j) => {
      if (j.parent) browse(j.parent)
    })
$('#pkOk').onclick = () => {
  const p = pkCur
  if (pkDone) pkDone(p)
  mask.classList.remove('show')
  pkDone = null
}

tSel.onchange = () => {
  const v = tSel.value
  if (!v) applyTarget(null)
  else {
    tPath.value = v
    applyTarget(v)
  }
}
$('#tBrowse').onclick = () =>
  pickDir(tPath.value || '', (p) => {
    tPath.value = p
    applyTarget(p)
  })
bApply.onclick = () => applyTarget(tPath.value.trim())
tPath.onkeydown = (e) => {
  if (e.key === 'Enter') applyTarget(tPath.value.trim())
}
bClear.onclick = () => {
  tPath.value = ''
  applyTarget(null)
}

function render(rep) {
  const s = rep.stats
  cardsEl.innerHTML =
    card(s.errors ? 'err' : 'ok', s.errors, '错误') +
    card(s.warnings ? 'warn' : 'ok', s.warnings, '告警/提示') +
    card('', s.defs.toLocaleString(), '定义') +
    card('', s.refs.toLocaleString(), '引用') +
    card('', rep.scanned.files.toLocaleString(), '脚本文件') +
    card('', rep.scanned.locFiles.toLocaleString(), '本地化文件')

  const parts = []

  if (rep.syntax.length) {
    const rows = rep.syntax
      .slice(0, 100)
      .map((x) => `<tr><td>${fileLink(x.rel, x.line)}</td><td class="mono">${esc(x.error)}</td></tr>`)
      .join('')
    parts.push(section('语法错误', rep.syntax.length, `<table><tr><th>位置</th><th>信息</th></tr>${rows}</table>`))
  }

  if (rep.brackets.length) {
    const rows = rep.brackets
      .slice(0, 60)
      .map((b) => {
        const kind = b.kind === 'unclosed' ? '<span class="tag bad">缺 }</span>' : '<span class="tag bad">多 }</span>'
        const ls = b.lines.slice(0, 5).join('、')
        return `<tr><td>${kind}</td><td>${fileLink(b.rel)}</td><td class="mono">第 ${ls}${b.lines.length > 5 ? ' 等' : ''} 行</td></tr>`
      })
      .join('')
    parts.push(
      section('括号结构提示(可能误报,需人工确认)', rep.brackets.length, `<table><tr><th></th><th>文件</th><th>行</th></tr>${rows}</table>`),
    )
  }

  if (rep.duplicates.length) {
    const rows = rep.duplicates
      .slice(0, 80)
      .map((d) => {
        const tag = d.sameFile ? '<span class="tag bad">同文件真重复</span>' : '<span class="tag hint">共享/覆盖</span>'
        const locs = d.locs.slice(0, 4).map((l) => fileLink(l.file, l.line)).join(' ')
        return `<tr><td>${tag}</td><td class="mono">${esc(d.kind)}:${esc(d.id)}</td><td>×${d.count}</td><td>${locs}</td></tr>`
      })
      .join('')
    parts.push(section('重复定义', rep.duplicates.length, `<table><tr><th></th><th>种类:id</th><th>次数</th><th>位置</th></tr>${rows}</table>`))
  }

  const gfx = rep.danglingRefs.filter((d) => d.target === 'gfx_sprite')
  if (gfx.length) {
    const rows = gfx
      .slice(0, 80)
      .map((d) => {
        const owner = d.owner ? `<span class="muted">(${esc(d.ownerKind)}:${esc(d.owner)})</span>` : ''
        return `<tr><td class="mono">${esc(d.name)}</td><td>${fileLink(d.file, d.line)}</td><td>${owner}</td></tr>`
      })
      .join('')
    parts.push(section('悬空图标引用(GFX_ 前缀)', gfx.length, `<table><tr><th>图标</th><th>引用处</th><th></th></tr>${rows}</table>`))
  }

  const locMiss = rep.danglingRefs.filter((d) => d.target === 'loc_key')
  if (locMiss.length) {
    const rows = locMiss
      .slice(0, 100)
      .map((d) => {
        const tag = d.missingInPrimary
          ? `<span class="tag hint">缺${esc(rep.primaryLang || '主语言')}</span>`
          : '<span class="tag bad">全缺</span>'
        const owner = d.owner ? `<span class="muted">(${esc(d.ownerKind)}:${esc(d.owner)})</span>` : ''
        return `<tr><td>${tag}</td><td class="mono">${esc(d.name)}</td><td>${fileLink(d.file, d.line)}</td><td>${owner}</td></tr>`
      })
      .join('')
    parts.push(section('缺失本地化', locMiss.length, `<table><tr><th></th><th>键</th><th>引用处</th><th></th></tr>${rows}</table>`))
  }

  const loc = rep.loc
  if (loc.files) {
    let body = ''
    if (loc.noBom.length)
      body += `<div class="muted">无 BOM 文件 ${loc.noBom.length} 个(中文会乱码)—— ${esc(loc.noBom.slice(0, 3).join(', '))}${loc.noBom.length > 3 ? '…' : ''}</div>`
    if (loc.dupKeys.length)
      body += `<div class="muted">跨文件重复键 ${loc.dupKeys.length} 个—— ${esc(loc.dupKeys.slice(0, 3).map((d) => d.id).join(', '))}${loc.dupKeys.length > 3 ? '…' : ''}</div>`
    if (loc.errorFiles.length)
      body += `<div class="muted">解析异常 ${loc.errorFiles.length} 个—— ${esc(loc.errorFiles.slice(0, 3).map((d) => d.file).join(', '))}${loc.errorFiles.length > 3 ? '…' : ''}</div>`
    if (!body) body = '<div class="muted">未发现明显问题</div>'
    parts.push(section('本地化完整性', loc.noBom.length + loc.dupKeys.length + loc.errorFiles.length, body))
  }

  sectionsEl.innerHTML = parts.join('')

  /* 范围说明放在最后 —— 这行是「这份报告到底统计了谁」的唯一权威出处。
   * 数据全部来自后端(rep.scope / rep.contextOnly),前端不自行推断。*/
  const scope = rep.scope || []
  const ctx = rep.contextOnly || []
  statusEl.textContent =
    (scope.length
      ? `范围:${scope.join(', ')}(只统计这些来源;${ctx.join(', ') || '无'} 作为上下文参与判定,不计入统计)`
      : `范围:${rep.roots.join(', ')}(全量)`) +
    `  ·  已扫描 ${rep.scanned.files} 脚本 / ${rep.scanned.locFiles} 本地化`
}

/**
 * 体检要扫几万个文件(实测 vanilla 约 33 秒)。服务端已改成异步,
 * 这里用进度 + 耗时计时把「等待」变成可读的进度,而不是白屏干等。
 *
 * t0 在 restart() 里重置 —— 切换目标后是新一轮等待,
 * 沿用旧计时会显示「已用 300 秒」这种吓人的数字。
 */
let t0 = Date.now()
function showBusy(j) {
  const p = (j && j.progress) || { done: 0, total: 0, phase: '' }
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const who = (j && j.target && j.target.name) || '全部来源'
  let msg
  if (j && j.error) {
    msg = '体检生成失败: ' + j.error
  } else if (p.total > 0 && p.done > 0) {
    const pct = Math.round((p.done / p.total) * 100)
    msg = `正在体检「${who}」… ${p.done}/${p.total} (${pct}%) · ${p.phase} · 已用 ${secs}s`
    // PROGRESS_V1:体检是全站唯一真报 done/total 的图 → 用确定态进度条
    if (window.Progress) window.Progress.tick(p.done, p.total, p.phase)
  } else {
    msg = `正在体检「${who}」… 已用 ${secs}s(全量约 30 秒;限定单个模组通常 1~2 秒)`
    if (window.Progress) window.Progress.tick(0, 0)
  }
  statusEl.textContent = msg
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const r = await fetch('/api/check')
    const j = await r.json()
    if (!j.ready) {
      showBusy(j)
      setTimeout(poll, 1000)
      return
    }
    // PROGRESS_V1:就绪 → 收进度条(体检是唯一会报真进度的图)
    if (window.Progress) window.Progress.done()
    render(j.report)
  } catch (e) {
    statusEl.textContent = '请求失败: ' + e.message
    if (window.Progress) window.Progress.fail('体检请求失败')
    setTimeout(poll, 3000)
  } finally {
    polling = false
  }
}

/** 换目标后重新开始一轮等待 */
function restart() {
  t0 = Date.now()
  cardsEl.innerHTML = ''
  sectionsEl.innerHTML = ''
  statusEl.textContent = '正在生成体检报告…'
  // PROGRESS_V1:换目标是新一轮,先把上一轮的计时收掉再重新 start
  if (window.Progress) {
    window.Progress.done()
    window.Progress.start('正在生成体检报告…')
  }
  setTimeout(poll, 60)
}

// 先拉模组清单(下拉要显示 .mod 元信息),再开始轮询
loadTarget().then(restart)
