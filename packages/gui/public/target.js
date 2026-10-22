/* target.js —— 目标模组选择器(MAKE_MOD_V1 公共件)
 *
 * 工作台以前只能"看",因为没有任何页面知道"该把文件写到哪儿"。
 * 所有写盘类操作(脚手架落盘 / IDE 保存)共用这一个选择器:
 *   - 只列出可写来源(base=false 的模组目录),游戏目录一律不出现
 *   - 记住上次选择(localStorage),下次打开仍在
 *   - 没有可写来源时给出可点的引导(去"打开/挂载"页新建模组)
 *
 * 用法:
 *   await Target.fill('#targetSel')            // 填充下拉
 *   const r = Target.current('#targetSel')     // { i, name, path } | null
 */
;(function () {
  const KEY = 'gui.targetRoot'

  let cache = null // { sources: [...], readonly: bool }
  let cacheAt = 0
  const TTL = 5000

  async function sources(force) {
    if (!force && cache && Date.now() - cacheAt < TTL) return cache
    const r = await fetch('/api/sources')
    const j = await r.json()
    cache = { sources: j.sources || [], readonly: !!j.readonly }
    cacheAt = Date.now()
    return cache
  }

  /** 可写来源列表(base=false) */
  async function writable(force) {
    const s = await sources(force)
    return s.sources.filter((x) => !x.base)
  }

  function saved() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null')
    } catch {
      return null
    }
  }
  function remember(v) {
    try {
      if (v) localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  /**
   * 填充下拉。
   * @param sel  CSS 选择器或 <select> 元素
   * @param opt  { empty:'没有可写模组', onChange }
   * @returns    { ok:boolean, list:[...] }
   */
  async function fill(sel, opt) {
    opt = opt || {}
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    if (!el) return { ok: false, list: [] }
    const list = await writable()
    const prev = el.value || ''
    el.innerHTML = ''
    if (!list.length) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = opt.empty || '（没有可写模组 · 请先新建）'
      el.appendChild(o)
      el.disabled = true
      if (opt.onEmpty) opt.onEmpty(el)
      return { ok: false, list }
    }
    el.disabled = false
    const want = saved()
    for (const s of list) {
      const o = document.createElement('option')
      o.value = String(s.i)
      o.textContent = s.name
      o.title = s.path || ''
      el.appendChild(o)
    }
    // 优先级:上次记住 > 当前选中 > 第一个
    let pick = null
    if (want && list.some((s) => String(s.i) === String(want.i))) pick = String(want.i)
    else if (prev && list.some((s) => String(s.i) === prev)) pick = prev
    else pick = String(list[0].i)
    el.value = pick
    const cur = list.find((s) => String(s.i) === pick)
    remember(cur ? { i: cur.i, name: cur.name } : null)
    if (opt.onChange) opt.onChange(cur || null)
    el.onchange = () => {
      const c = list.find((s) => String(s.i) === el.value)
      remember(c ? { i: c.i, name: c.name } : null)
      if (opt.onChange) opt.onChange(c || null)
    }
    return { ok: true, list }
  }

  /** 当前选中的来源 */
  function current(sel) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    if (!el || !el.value) return null
    const o = el.options[el.selectedIndex]
    return { i: Number(el.value), name: o ? o.textContent : '', path: o ? o.title : '' }
  }

  /** 写盘统一入口:返回 { ok, data } 或 { ok:false, error } */
  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const d = await r.json().catch(() => ({ error: tr('响应不是 JSON (HTTP ') + r.status + ')' }))
      if (!r.ok || d.error) return { ok: false, error: d.error || 'HTTP ' + r.status }
      return { ok: true, data: d }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  window.Target = { sources, writable, fill, current, post, KEY }
})()
