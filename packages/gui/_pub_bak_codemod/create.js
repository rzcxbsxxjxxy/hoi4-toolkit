/* 内容生成脚手架前端:选类型 → 填字段 → POST /api/create → 预览无损产物。
 *
 * ★ GEN_STATS_V1(2026-10-06 重写):字段表不再自带镜像。
 * 旧版在这里硬写了一份 GEN_FIELDS(6 类 52 个字段),和引擎的GEN_FIELDS
 * 以及各 genXxx() 实际读取的键**三处各写一遍、早已不同步**:
 *   - focus 引擎读 available / reward,表单里没有 → 填不了
 *   - decision 与 technology 引擎读 aiWillDo,表单里没有
 *   - event 引擎读 isTriggeredOnly / fireOnlyOnce,表单里没有
 * 现在唯一数据源是引擎的 GEN_SCHEMA,经 /api/gen/schema 下发,
 * select 的取值也来自实测扫描真实数据的fieldstats —— 原版更新不会漂移。
 *
 * 条件/效果类字段是 script 类型:多行源码框 + 旁边的真实键提示(点一下插入),
 * 不再是 `comment('在此填写…')` 那种空壳占位。
 */
const $ = (s) => document.querySelector(s)

/* ── 状态 ── */
let SCHEMA = null/* /api/gen/schema 的 schema 部分 */
let REAL_KEYS = [] /* /api/gen/keys 的键列表(按频次) */
let STATS_INFO = { files: 0, ms: 0, ready: false, error: '' }

let lastFiles = []
let lastIdx = -1
let lastKind = 'focus'
let lastOpts = null
/** 各字段当前值(含 bool / script) */
const VALS = {}

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 4200)
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** 取当前类型的 schema */
function schemaOf(kind) {
  return SCHEMA ? SCHEMA[kind] : null
}
function fieldsOf(kind) {
  const sc = schemaOf(kind)
  return sc ? sc.fields : []
}

/* ── 载入 schema 与真实键 ── */
async function loadSchema() {
  try {
    const r = await fetch('/api/gen/schema')
    const d = await r.json()
    if (!d.ok && !d.schema) {
      $('#statLine').innerHTML =
        '<span style="color:var(--danger)">字段数据未就绪:' + esc(d.error || '未知错误') + '</span>'
      return
    }
    SCHEMA = d.schema
    STATS_INFO = { files: d.files, ms: d.ms, ready: d.ready, error: d.error || '' }
    renderStatLine()
    buildKindSel()
    renderFields()
  } catch (e) {
    $('#statLine').innerHTML = '<span style="color:var(--danger)">无法读取字段表:' + esc(String(e)) + '</span>'
  }
  // 键提示是锦上添花,失败不影响主流程
  try {
    const r = await fetch('/api/gen/keys')
    const d = await r.json()
    if (d.ok && d.keys) REAL_KEYS = d.keys
  } catch {
    REAL_KEYS = []
  }
}

function renderStatLine() {
  const el = $('#statLine')
  if (!el) return
  if (!STATS_INFO.ready) {
    el.innerHTML = '<span style="color:var(--danger)">真实字段数据未就绪 —— 生成器只能做语法检查,无法验证键名与层级</span>'
    return
  }
  el.innerHTML =
    '判据来自实测:已扫描<b>' + STATS_INFO.files + '</b> 个原版+模组文件(' + STATS_INFO.ms + ' ms)。' +
    '字段名、层级、枚举取值都按真实数据核对,不是手写表。'
}

/* ── 类型下拉 ── */
function buildKindSel() {
  const sel = $('#kindSel')
  const cur = sel.value
  sel.innerHTML = ''
  if (!SCHEMA) {
    sel.innerHTML = '<option value="focus">正在载入字段…</option>'
    sel.disabled = true
    return
  }
  sel.disabled = false
  for (const [k, sc] of Object.entries(SCHEMA)) {
    const o = document.createElement('option')
    o.value = k
    o.textContent = sc.label + ' (' + k + ')'
    sel.appendChild(o)
  }
  if (cur && SCHEMA[cur]) sel.value = cur
  sel.onchange = renderFields
}

/* ── 字段渲染(按 group 分区) ── */
function renderFields() {
  const kind = $('#kindSel').value
  const box = $('#fields')
  box.innerHTML = ''
  const fs = fieldsOf(kind)
  const sc = schemaOf(kind)
  const pathHint = $('#pathHint')
  if (pathHint) pathHint.textContent = sc ? '产物: ' + sc.pathHint : ''

  if (!fs.length) {
    box.innerHTML = '<div class="hint">字段表为空:请检查服务端 /api/gen/schema</div>'
    return
  }

  let lastGroup = null
  for (const f of fs) {
    if (f.group && f.group !== lastGroup) {
      lastGroup = f.group
      const h = document.createElement('div')
      h.className = 'grp'
      h.textContent = f.group
      box.appendChild(h)
    }
    box.appendChild(renderField(kind, f))
  }
}

function renderField(kind, f) {
  const wrap = document.createElement('div')
  wrap.className = 'field'
  if (f.type === 'script') wrap.className = 'field script'

  // 标签 + 提示气泡
  const lbl = document.createElement('label')
  lbl.innerHTML = esc(f.label) + (f.block ? ' <span class="blkname">' + esc(f.block) + '</span>' : '')
  if (f.hint) {
    const q = document.createElement('span')
    q.className = 'q'
    q.textContent = '?'
    q.title = f.hint
    lbl.appendChild(q)
  }
  wrap.appendChild(lbl)

  const t = f.type || 'text'
  if (t === 'script') {
    /* 多行源码框 + 键提示 */
    const ta = document.createElement('textarea')
    ta.id = 'f_' + f.key
    ta.dataset.key = f.key
    ta.rows = f.defOpen ? 3 : 2
    ta.placeholder = f.placeholder || '每行一句,如 has_war = yes'
    ta.spellcheck = false
    if (VALS[f.key] !== undefined) ta.value = VALS[f.key]
    wrap.appendChild(ta)
    // 键提示按钮组(可折叠)
    if (REAL_KEYS.length) {
      const box2 = document.createElement('div')
      box2.className = 'keyhint'
      const tog = document.createElement('button')
      tog.type = 'button'
      tog.className = 'khToggle'
      tog.textContent = '可用键 ' + REAL_KEYS.length + ' 个 ▾'
      const list = document.createElement('div')
      list.className = 'khList'
      for (const it of REAL_KEYS.slice(0, 60)) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'kh'
        b.textContent = it.key
        b.title = '原库出现 ' + it.n + ' 次 · 点击插入'
        b.onclick = () => insertAtCursor(ta, it.key + ' = ')
        list.appendChild(b)
      }
      tog.onclick = () => {
        list.classList.toggle('show')
        tog.classList.toggle('open')
      }
      box2.appendChild(tog)
      box2.appendChild(list)
      wrap.appendChild(box2)
    }
  } else if (t === 'select') {
    const sel = document.createElement('select')
    sel.id = 'f_' + f.key
    sel.dataset.key = f.key
    const ph = document.createElement('option')
    ph.value = ''
    ph.textContent = f.placeholder || '(不填)'
    sel.appendChild(ph)
    for (const v of f.values || []) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = v
      sel.appendChild(o)
    }
    // 枚举很长时提示总数,免得以为只有这些
    if (f.valueTotal && f.valueTotal > (f.values || []).length) {
      const o = document.createElement('option')
      o.value = '__more__'
      o.textContent = '… 共 ' + f.valueTotal + ' 个,此处只列常用 ' + f.values.length + ' 个'
      o.disabled = true
      sel.appendChild(o)
    }
    sel.value = VALS[f.key] !== undefined ? VALS[f.key] : (f.def || '')
    wrap.appendChild(sel)
  } else if (t === 'bool') {
    const row = document.createElement('div')
    row.className = 'row'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.id = 'f_' + f.key
    cb.dataset.key = f.key
    const init = VALS[f.key] !== undefined ? VALS[f.key] : f.def
    cb.checked = init === 'yes' || init === true
    const sp = document.createElement('span')
    sp.className = 'hint'
    sp.textContent = '勾选 = yes'
    row.appendChild(cb)
    row.appendChild(sp)
    wrap.appendChild(row)
  } else {
    const inp = document.createElement('input')
    inp.type = t === 'number' ? 'number' : 'text'
    inp.id = 'f_' + f.key
    inp.dataset.key = f.key
    if (f.placeholder) inp.placeholder = f.placeholder
    if (VALS[f.key] !== undefined) inp.value = VALS[f.key]
    wrap.appendChild(inp)
  }
  return wrap
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length
  const e = ta.selectionEnd ?? s
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e)
  const p = s + text.length
  ta.focus()
  ta.setSelectionRange(p, p)
  VALS[ta.dataset.key] = ta.value
}

/* ── 填示例 / 清空 ── */
function fillSample() {
  const kind = $('#kindSel').value
  for (const f of fieldsOf(kind)) {
    if (f.type === 'script') {
      VALS[f.key] = ''
      const el = document.getElementById('f_' + f.key)
      if (el) el.value = ''
      continue
    }
    const v = f.def !== undefined ? f.def : ''
    VALS[f.key] = v
    const el = document.getElementById('f_' + f.key)
    if (!el) continue
    if (f.type === 'bool') el.checked = v === 'yes'
    else el.value = v
  }
  toast('已填入示例值(条件/效果块留空,按需自己写)')
}

function clearFields() {
  for (const el of document.querySelectorAll('#fields input, #fields textarea, #fields select')) {
    if (el.type === 'checkbox') el.checked = false
    else el.value = ''
    if (el.dataset.key) VALS[el.dataset.key] = ''
  }
}

/* ── 收集当前值 ── */
function currentOpts() {
  const kind = $('#kindSel').value
  const opts = {
    mod: $('#mod').value.trim() || 'my_mod',
    lang: $('#lang').value.trim() || 'l_english',
  }
  for (const f of fieldsOf(kind)) {
    const el = document.getElementById('f_' + f.key)
    if (!el) continue
    let v
    if (f.type === 'bool') v = el.checked ? 'yes' : 'no'
    else v = el.value.trim()
    if (v !== '') opts[f.key] = v
  }
  return { kind, opts }
}

/* ── 生成 ── */
async function gen() {
  const { kind, opts } = currentOpts()
  lastKind = kind
  lastOpts = opts
  const btn = $('#genBtn')
  btn.disabled = true
  btn.textContent = '生成中…'
  try {
    const r = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, opts }),
    })
    const d = await r.json()
    if (d.error) return toast(d.error, true)
    lastFiles = d.files || []
    renderResult(d.warnings || [], d.errors || [])
  } catch (e) {
    toast('请求失败: ' + String(e), true)
  } finally {
    btn.disabled = false
    btn.textContent = '生成'
  }
}

/* MAKE_MOD_V1:预览只是中间态 —— 真正"做出模组"要把内容写进目标模组目录。
 * 生成 → 落盘走同一个 generate(),所见即所得,不会有"预览和落盘不一致"。 */
async function saveToMod() {
  const t = Target.current('#targetSel')
  if (!t) return toast('没有可写模组:请到「打开 / 挂载」页新建或挂载一个模组', true)
  // ★ 有 error 时必须先拦住:错误都是"游戏不认"的结构问题,写进去只会静默失效
  if (lastErrs && lastErrs.length) {
    if (!confirm('当前产物有 ' + lastErrs.length + ' 处语义错误(游戏可能不认这些结构)。\n仍要写入模组吗?')) {
      return toast('已取消:请先修掉标红的错误', true)
    }
  }
  const { kind, opts } = lastOpts ? { kind: lastKind, opts: lastOpts } : currentOpts()
  if (!lastFiles.length) {
    await gen()
    if (!lastFiles.length) return
  }
  $('#saveBtn').disabled = true
  const r = await Target.post('/api/gen/save', { kind, opts, rootIdx: t.i })
  $('#saveBtn').disabled = false
  if (!r.ok) return toast(r.error, true)
  const w = r.data.written || []
  const news = w.filter((x) => x.created).length
  toast(`已写入「${r.data.rootName}」:${w.length} 个文件(新建 ${news} / 覆盖 ${w.length - news})`)
  const hint = $('#saveHint')
  if (hint) {
    hint.innerHTML =
      '✅ 已写入: ' +
      w.map((x) => esc(x.path)).join('、') +
      '<br>索引正在后台重建,可到「国策 / 科技 / 决议」页刷新查看,或到「体检」页校验。'
  }
}

/* ── 结果渲染 ── */
let lastErrs = []

function renderResult(warnings, errors) {
  lastErrs = errors || []
  const filesBox = $('#files')
  const warnBox = $('#warnBox')
  const errBox = $('#errBox')
  const empty = $('#empty')
  empty.style.display = 'none'

  // 错误优先显示:这些是"游戏不认"的结构问题,必须显眼
  errBox.innerHTML = ''
  if (lastErrs.length) {
    errBox.className = 'show'
    errBox.innerHTML =
      '<b>✗ 语义错误 ' + lastErrs.length + ' 处</b>（游戏可能完全不认这些结构）' +
      lastErrs
        .map(
          (e) =>
            '<div class="e"><span class="ew">' + esc(e.where) + '</span> ' + esc(e.message) +
            '<br><span class="ep">' + esc(e.path) + '</span></div>',
        )
        .join('')
  } else {
    errBox.className = ''
  }

  if (warnings.length) {
    warnBox.className = 'show'
    warnBox.innerHTML =
      '<b>⚠ 提示 ' + warnings.length + ' 条</b>' + warnings.map((w) => '<div class="w">• ' + esc(w) + '</div>').join('')
  } else {
    warnBox.className = ''
  }

  filesBox.innerHTML = ''
  if (!lastFiles.length) {
    filesBox.innerHTML = '<div style="padding:14px;color:var(--ink3)">没有生成任何文件。</div>'
    $('#contentWrap').style.display = 'none'
    return
  }
  lastFiles.forEach((f, i) => {
    const tab = document.createElement('div')
    tab.className = 'filetab' + (i === 0 ? ' on' : '')
    tab.dataset.idx = String(i)
    tab.innerHTML = '<span class="p">' + esc(f.path) + '</span><span class="copy">复制</span>'
    tab.__obj = f
    tab.onclick = (ev) => {
      if (ev.target.classList.contains('copy')) {
        copy(f.content)
        return
      }
      showFile(i)
    }
    filesBox.appendChild(tab)
  })
  showFile(0)
}

function showFile(i) {
  lastIdx = i
  for (const t of document.querySelectorAll('.filetab')) t.classList.toggle('on', Number(t.dataset.idx) === i)
  const f = lastFiles[i]
  if (!f) {
    $('#contentPath').textContent = ''
    $('#content').textContent = ''
    $('#contentWrap').style.display = 'none'
    return
  }
  $('#contentPath').textContent = f.path
  $('#content').textContent = f.content
  $('#contentWrap').style.display = 'flex'
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制到剪贴板')
  } catch {
    toast('复制失败,请手动选择', true)
  }
}

/* ── 绑定 ── */
$('#genBtn').addEventListener('click', gen)
$('#sampleBtn').addEventListener('click', fillSample)
$('#clearBtn').addEventListener('click', clearFields)
$('#saveBtn').addEventListener('click', saveToMod)
$('#copyBtn').addEventListener('click', () => {
  if (lastFiles[lastIdx]) copy(lastFiles[lastIdx].content)
})

// 目标模组下拉(MAKE_MOD_V1):没有可写模组时给出引导而非静默禁用
Target.fill('#targetSel', {
  onEmpty: () => {
    const h = $('#targetHint')
    if (h) h.innerHTML = '当前没有可写模组。请到 <a href="/open" style="color:var(--accent)">打开 / 挂载</a> 页新建一个。'
  },
})

Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event('resize')))

/* ══════════════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V2)
 *
 * create 页没有"已存在的条目"可点,右键的价值全在**生成结果**上:
 *   · 一次生成会产出好几个文件,「全部复制」「全部路径列表」比一个个点强得多
 *   · 生成的文件还没落盘,所以**不给"在 IDE 中打开"**——
 *     那是 /api/gen/save 之后才存在的路径,给了就是骗人。
 * ══════════════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire || !window.Ctx) return
  CtxWire.attach({
    page: 'create',
    on: [
      {
        host: '#files',
        sel: '.filetab',
        obj: (el) => {
          const f = el.__obj
          if (!f) return null
          return { id: f.path, _f: f }
        },
        items: (o) => {
          const f = o._f
          return [
            { label: '复制文件内容', k: '⧉', hint: f.content.length + ' 字符', act: () => copy(f.content) },
            { label: '复制文件路径', k: '⧉', act: () => copy(f.path, '') },
            { label: '复制路径 + 内容', k: '⧉', act: () => copy(f.path + '\n\n' + f.content, '') },
            { sep: true },
            {
              label: '复制全部 ' + lastFiles.length + ' 个文件的内容',
              k: '⧉',
              act: () => {
                copy(lastFiles.map((x) => '── ' + x.path + ' ──\n' + x.content).join('\n\n'), '')
              },
            },
            { label: '复制全部文件路径', k: '⧉', act: () => copy(lastFiles.map((x) => x.path).join('\n'), '') },
            { sep: true },
            { title: '还没落盘 —— 写进模组后才能在 IDE 里打开' },
            { label: '写进目标模组', k: '→', act: () => saveToMod() },
          ]
        },
      },
      {
        /* 真实键提示也可以右键复制 —— 进阶者常常要连着写好几个键 */
        host: '#fields',
        sel: '.kh',
        obj: (el) => (el ? { id: el.textContent, _t: el.textContent } : null),
        items: (o) => [
          { label: '复制 "' + o._t + ' = "', k: '⧉', act: () => copy(o._t + ' = ') },
          {
            label: '在搜索框里找这个键',
            k: '🔍',
            act: () => {
              const inp = document.createElement('input')
              inp.type = 'search'
              inp.placeholder = '在全站搜 ' + o._t
              inp.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:200;padding:6px 12px;font:13pxinherit;'
              document.body.appendChild(inp)
              inp.focus()
              inp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                  window.open('/open?q=' + encodeURIComponent(o._t), '_blank')
                  inp.remove()
                }
                if (e.key === 'Escape') inp.remove()
              }
              inp.onblur = () => inp.remove()
            },
          },
        ],
      },
    ],
    keys: [
      {
        id: 'find.search',
        desc: '聚焦当前类型的 ID 输入框',
        group: '查找',
        run: () => {
          const kind = $('#kindSel').value
          const f = fieldsOf(kind).find((x) => x.key === 'id')
          const el = f ? document.getElementById('f_' + f.key) : null
          if (el) {
            el.focus()
            el.select && el.select()
          }
        },
      },
      { id: 'create.gen', desc: '生成', group: '文件', run: () => gen() },
      { id: 'create.nextFile', desc: '下一个产物文件', group: '浏览', run: () => stepFile(1) },
      { id: 'create.prevFile', desc: '上一个产物文件', group: '浏览', run: () => stepFile(-1) },
      {
        id: 'create.copyFile',
        desc: '复制当前产物内容',
        group: '编辑',
        run: () => {
          if (!lastFiles[lastIdx]) {
            toast('还没有生成产物', true)
            return
          }
          copy(lastFiles[lastIdx].content)
        },
      },
      { id: 'create.sample', desc: '填入示例值', group: '编辑', run: () => fillSample() },
      {
        id: 'create.clear',
        desc: '清空字段',
        group: '编辑',
        run: () => {
          if (lastFiles.length && !confirm('清空字段不会撤销已生成的预览,确定?')) return
          clearFields()
        },
      },
      {
        id: 'sel.clear',
        desc: '取消选择',
        group: '选中',
        run: () => {
          if (lastIdx >= 0 && lastFiles.length) {
            showFile(-1)
            lastIdx = -1
            toast('已回到未选中状态')
          }
        },
      },
      // ⚠ 这里**不接** CtxWire.commonKeys:它给的是 mod+c(sel.copyId),
      //   与本页的 create.copyFile(同样是 mod+c)撞键 —— 一次按键两个动作。
    ],
  })
}

function stepFile(d) {
  if (!lastFiles.length) {
    toast('还没有生成产物', true)
    return
  }
  const j = Math.min(lastFiles.length - 1, Math.max(0, lastIdx + d))
  showFile(j)
  const t = document.querySelector('.filetab[data-idx="' + j + '"]')
  if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' })
}

wireCtxAndKeys()
loadSchema()

/* 调试句柄(验收测试用) */
window.CreateApp = { get schema() { return SCHEMA }, get files() { return lastFiles }, get errors() { return lastErrs }, gen, get vals() { return VALS } }