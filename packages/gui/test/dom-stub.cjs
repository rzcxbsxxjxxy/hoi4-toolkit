/* 极简 DOM 桩:只实现 ctx.js / keys.js 真正用到的那几个 API。
 * 目的:在没有 Chromium 的环境里对公共件做**行为**验证(而不是只做语法检查)。
 * ⚠ 这不是通用测试框架,只服务本次 RIGHTCLICK_V1 / KEYS_V1 的验收。 */
class CL {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    }
    this._html = ''
    this._text = ''
    this._listeners = {}
  }
  set className(v) {
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean))
  }
  get className() {
    return [...this.classList._s].join(' ')
  }
  set innerHTML(v) {
    this._html = String(v)
    this.children = parseHtml(this._html, this)
  }
  get innerHTML() {
    return this._html
  }
  set textContent(v) {
    this._text = String(v)
  }
  get textContent() {
    return this._text
  }
  set id(v) {
    this._id = v
    DOC._byId[v] = this
  }
  get id() {
    return this._id
  }
  appendChild(c) {
    /* 真实 DOM 会把节点从旧父级摘下来。keys.js 的速查表正是用
     * `while (wrap.firstChild) sheetEl.appendChild(wrap.firstChild)` 搬节点,
     * 所以这里必须做摘除,否则死循环。
     * ⚠⚠ 两个顺序/引用要点(都实测踩过):
     *   ① 先从旧父级摘(此时 c.parentNode 还是旧的),再设新父级;
     *      反过来写 filter 会作用在 this 身上,把自己又塞回去。
     *   ② 必须**原地**改写旧父级的 children(filter 后 splice 回同一个数组对象),
     *      不能 `old.children = old.children.filter(...)` 整体换引用 ——
     *      innerHTML 解析时 root.children 与调用方持有的是同一数组,
     *      换新数组后 while 循环读到的还是旧数组,永远摘不空。 */
    const old = c.parentNode
    if (old && old !== this && old.children) {
      const i = old.children.indexOf(c)
      if (i >= 0) old.children.splice(i, 1)
    }
    c.parentNode = this
    this.children.push(c)
    return c
  }
  get firstChild() {
    return this.children[0] || null
  }
  /** 第一个**元素**子节点(跳过文本节点);fullscreen.js 用它把按钮插到最前 */
  get firstElementChild() {
    for (const c of this.children) if (c.tagName !== '#text') return c
    return null
  }
  /**
   * 派发事件并沿 parentNode 冒泡。
   * ⚠ 事件委托的验收离不开它 —— Ctx.attach 绑在容器上,
   *   冒泡断了就测不出"动态插入的元素也能命中"。
   *   stopPropagation 会真的截断后续冒泡,和浏览器一致。
   */
  dispatchEvent(e) {
    if (!e || typeof e.type !== 'string') throw new TypeError('dispatchEvent 需要带 type 的事件对象')
    let n = this
    while (n) {
      const a = n._listeners[e.type]
      if (a) {
        e.currentTarget = n
        for (const f of a.slice()) f.call(n, e)
      }
      // 捕获阶段:从根往下(桩不做真捕获,统一在冒泡时跑已足够验收委托)
      if (e.stopped) break
      n = n.parentNode
    }
    return !e.defaultPrevented
  }
  removeChild(c) {
    const i = this.children.indexOf(c)
    if (i >= 0) this.children.splice(i, 1)
    c.parentNode = null
    return c
  }
  /** insertBefore:fullscreen.js 用它把按钮插到 .navlinks 最前 */
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c)
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(c)
    else this.children.splice(i, 0, c)
    c.parentNode = this
    return c
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  contains(n) {
    if (n === this) return true
    return this.children.some((c) => c.contains && c.contains(n))
  }
  closest(sel) {
    let n = this
    while (n) {
      if (match(n, sel)) return n
      n = n.parentNode
    }
    return null
  }
  matches(sel) {
    return match(this, sel)
  }
  addEventListener(t, fn) {
    ;(this._listeners[t] = this._listeners[t] || []).push(fn)
  }
  removeEventListener(t, fn) {
    const a = this._listeners[t]
    if (a) this._listeners[t] = a.filter((f) => f !== fn)
  }
  dispatch(t, ev) {
    const a = this._listeners[t] || []
    for (const f of a.slice()) f(ev)
  }
  querySelector(sel) {
    return query(this, sel)
  }
  querySelectorAll(sel) {
    const out = []
    walk(this, (n) => {
      if (match(n, sel)) out.push(n)
    })
    return out
  }
  getBoundingClientRect() {
    return { left: 100, top: 100, right: 200, bottom: 140, width: 100, height: 40 }
  }
  get offsetWidth() {
    return 200
  }
  get offsetHeight() {
    return 180
  }
  focus() {
    DOC.activeElement = this
  }
  select() {}
  /* textarea / input 的 value —— ctx.js 的复制兜底(legacy)会
   *   建 textarea、设 .value、再 execCommand('copy')。
   *   缺 value 的话 mock 读到的就是 undefined,"复制类"断言全成假阴性。
   *   (本轮就栽在这:commonKeys 返回字符串的用例明明逻辑对了却判失败。) */
  get value() {
    return this._value === undefined ? '' : this._value
  }
  set value(v) {
    this._value = v
  }
}
/* 极简 HTML → 子节点。只支持公共件实际生成的那几种标签/属性
 * (div/span/kbd/style + class/data-i/style),够验证 querySelectorAll 即可。
 * ⚠ 必须建真正的树(子节点放进父节点的 children),不能把扁平节点列表
 *   直接当 children —— 否则 `while (wrap.firstChild) appendChild(...)`
 *   这类"搬空容器"的写法会死循环(appendChild 从旧父级摘节点后,
 *   扁平数组里那份并不会同步减少)。 */
function parseHtml(html, parent) {
  const root = new CL('#frag')
  root.parentNode = parent
  const stack = [root]
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, selfClose, text] = m
    const top = stack[stack.length - 1]
    if (text != null) {
      if (text.trim()) {
        const t = new CL('#text')
        t._text = text
        t.parentNode = top
        top.children.push(t)
      }
      continue
    }
    if (close) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const el = new CL(tag)
    const ar = /([\w-]+)="([^"]*)"/g
    let a
    while ((a = ar.exec(attrs || ''))) {
      const k = a[1]
      const v = a[2]
      if (k === 'class') el.className = v
      else if (k === 'style') {
        v.split(';').forEach((d) => {
          const [p, val] = d.split(':')
          if (p && val) el.style[p.trim()] = val.trim()
        })
      } else if (k.startsWith('data-')) el.dataset[k.slice(5)] = v
      else el[k] = v
    }
    el.parentNode = top
    top.children.push(el)
    if (!selfClose) stack.push(el)
  }
  return root.children
}

function match(n, sel) {
  // 支持 '#id' / 'tag' / '.cls' / 'tag.cls' / 'a,b'
  // ⚠ '#id' 是后来补的:fullscreen.js 的幂等判重走 getElementById(可以),
  //   但验收"只留一个按钮"要用 querySelectorAll('#fsBtn') —— 桩不支持就测不了。
  return String(sel)
    .split(',')
    .map((s) => s.trim())
    .some((one) => {
      if (one.charAt(0) === '#') return n.id === one.slice(1)
      const parts = one.split('.')
      const tag = parts[0]
      const cls = parts.slice(1)
      if (tag && n.tagName !== tag.toUpperCase()) return false
      return cls.every((c) => n.classList.contains(c))
    })
}
function walk(n, fn) {
  for (const c of n.children) {
    fn(c)
    walk(c, fn)
  }
}
function query(root, sel) {
  let found = null
  walk(root, (n) => {
    if (!found && match(n, sel)) found = n
  })
  return found
}

const DOC = {
  _byId: {},
  activeElement: null,
  _listeners: {},
  createElement: (t) => new CL(t),
  createTextNode: () => new CL('#text'),
  getElementById(id) {
    return DOC._byId[id] || null
  },
  querySelector(s) {
    return query(DOC.body, s)
  },
  querySelectorAll(s) {
    const out = []
    walk(DOC.body, (n) => {
      if (match(n, s)) out.push(n)
    })
    return out
  },
  addEventListener(t, fn) {
    ;(DOC._listeners[t] = DOC._listeners[t] || []).push(fn)
  },
  removeEventListener(t, fn) {
    const a = DOC._listeners[t]
    if (a) DOC._listeners[t] = a.filter((f) => f !== fn)
  },
  dispatch(t, ev) {
    for (const f of (DOC._listeners[t] || []).slice()) f(ev)
  },
}
DOC.body = new CL('body')
DOC.head = new CL('head')
DOC.documentElement = new CL('html')

function ev(o) {
  return Object.assign(
    {
      // ⚠ type 必填:dispatchEvent 靠它查监听表。真实 DOM 一定有,
      //   桩里以前没带,导致"派发右键事件"这类用例根本没法写。
      type: '',
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
      stopImmediatePropagation() { this.stopped = true },
      defaultPrevented: false,
      stopped: false,
      target: null,
    },
    o,
  )
}

function install() {
  global.window = global
  global.document = DOC
  global.navigator = { platform: 'Win32', userAgent: 'node', clipboard: null }
  global.location = { hash: '', pathname: '/focus', href: '' }
  global.addEventListener = (t, fn) => DOC.addEventListener(t, fn)
  global.removeEventListener = (t, fn) => DOC.removeEventListener(t, fn)
  global.innerWidth = 1600
  global.innerHeight = 900
  global.fetch = async () => ({ json: async () => ({ sources: [{ path: 'C:/game' }] }) })
  global.HashChangeEvent = class {
    constructor(t) {
      this.type = t
    }
  }
  global.dispatchEvent = () => {}
  global.open = () => {}
  /* 定时器 —— 委托给 Node 真实定时器(保持既有行为),同时登记到 __timers,
   * 让 flushTimers() 能**立刻**把它们跑掉。
   * 为什么不直接用纯手动时钟:桩里大量代码(toast 自动隐藏、debounce、
   * poll 轮询)依赖定时器真的会触发,换成纯手动会让这些测试全停在半路。
   * 为什么不干脆不管:Ctx.attach 的"容器还没渲染就重试"这类**延迟绑定**
   * 逻辑需要可控时钟才测得到(上一轮就漏了这条判据)。
   * 用法:flushTimers() 立即跑掉所有已登记的定时器。 */
  global.__timers = new Map()
  let tid = 0
  const realST = global.setTimeout.bind(global)
  const realSI = global.setInterval.bind(global)
  const realCT = global.clearTimeout.bind(global)
  const realCI = global.clearInterval.bind(global)
  global.setTimeout = (fn, ms, ...a) => {
    const h = realST(fn, ms, ...a)
    global.__timers.set(h, { fn, args: a, clear: () => realCT(h) })
    return h
  }
  global.setInterval = (fn, ms, ...a) => {
    const h = realSI(fn, ms, ...a)
    global.__timers.set(h, { fn, args: a, clear: () => realCI(h) })
    return h
  }
  global.clearTimeout = global.clearInterval = (h) => {
    const t = global.__timers.get(h)
    if (t) { t.clear(); global.__timers.delete(h); return }
    realCT(h); realCI(h)
  }
  /** 把所有登记在册的定时器立刻跑一遍(不等真实时间)。 */
  global.flushTimers = () => {
    for (const [, t] of Array.from(global.__timers)) {
      try { t.fn(...t.args) } catch (e) { /* 桩里不因定时器抛错而中断 */ }
    }
  }
  /* localStorage —— keymap.js(快捷键覆盖表)依赖它。
   * 用 Map 存字符串,附带 dump()/clear() 便于测试隔离。 */
  const store = new Map()
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    dump: () => Object.fromEntries(store),
  }
}

module.exports = { CL, DOC, ev, install, walk, match }
