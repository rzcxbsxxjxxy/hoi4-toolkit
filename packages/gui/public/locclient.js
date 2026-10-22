/**
 * 页面本地化客户端 —— 把 id 换成人类可读文本。
 *
 * ★ 为什么单独文件(而不是各页自己 fetch):
 *   focus / tech / mio / doctrines / decisions / events 都缺同一件事 ——
 *   把 `GER_mio_trait_hoesch_facilities` 这种 id 换成 "Hoesch 设施"。
 *   每页各写一份就是六份重复的缓存 + 去重 + 竞态处理。
 *
 * ★ 语言口径(用户 2026-10 明确):默认英文,基础游戏可切中文。
 *   模组的 localisation 往往只写英文,英文是唯一能覆盖全部 key 的;
 *   中文只在 key 齐全时才值得用(基础游戏 208 个文件 vs 英文 207 个,基本齐)。
 *
 * ★ 服务端已经按覆盖链合并(ROOTS 顺序,模组覆盖基础游戏),
 *   所以这里只管"查不到就显示 id",不做来源判断。
 *
 * 用法:
 *   await Loc.ready()                    // 索引就绪(可选,不等也能用)
 *   Loc.text('GER_some_focus')           // 同步读缓存,查不到返回 ''
 *   await Loc.load(['a','b','c'])        // 批量拉(自动去重/分批/并发限流)
 *   Loc.on(cb)                           // 缓存变化时回调(渲染层刷新用)
 */
;(function (global) {
  'use strict'

  /** 语言选择:localStorage('gui.locLang'),默认 english */
  var LANG_KEY = 'gui.locLang'
  var DEFAULT_LANG = 'english'

  /** key → {text, lang, file, line} */
  var cache = new Map()
  /** key → 正在请求中的 Promise(防并发重复) */
  var inflight = new Map()
  var listeners = []
  /** 已知语言(第一次 /api/loc/text 或 /api/loc/stats 返回后填充) */
  var langOptions = []
  var statsLoaded = false

  function currentLang() {
    try {
      return localStorage.getItem(LANG_KEY) || DEFAULT_LANG
    } catch (e) {
      return DEFAULT_LANG
    }
  }

  function setLang(l) {
    try {
      if (l) localStorage.setItem(LANG_KEY, l)
      else localStorage.removeItem(LANG_KEY)
    } catch (e) {
      /* 无痕模式等,忽略 */
    }
    // 换语言 = 缓存全废(同一 key 在不同语言下是不同文本)
    cache.clear()
    inflight.clear()
    emit()
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]()
      } catch (e) {
        console.error('[Loc] 回调异常', e)
      }
    }
  }

/** ── 本地化渲染(统一 API)────────────────────────────────────
 *  escHtml(s)     HTML 转义
 *  colorize(str)  HTML 转义(§ 码原样保留)
 *  html(key)      本地化键 → HTML 转义(查不到退回 key)
 */
  /* ★ LOCALISATION_WIKI_V1:游戏 § 颜色码 → 真色 span(HOI4 Wiki「Colouring characters」全表)。
   *   §C/§L/§W/§B/§G/§R/§b/§g/§Y/§H/§T/§O/§0-9/§t;§! 结束当前色。
   *   前导 §X 开色,§! 关色;§ 后为非法/缺失字符时原样保留。 */
  var LOC_COLORS = {
    C:'#23CEFF', L:'#C3B091', W:'#FFFFFF', B:'#0000FF', G:'#009F03',
    R:'#FF3232', b:'#000000', g:'#B0B0B0', Y:'#FFBD00', H:'#FFBD00', T:'#FFFFFF',
    O:'#FF7019', 0:'#CB00CB', 1:'#8078D3', 2:'#5170F3', 3:'#518FDC', 4:'#5ABEE7',
    5:'#3FB5C2', 6:'#77CCBA', 7:'#99D199', 8:'#CCA333', 9:'#FCA97D', t:'#FF4C4D',
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] })
  }

  function colorize(str) {
    var s = String(str == null ? '' : str)
    var out = '', open = false, i = 0, len = s.length
    while (i < len) {
      var c = s.charAt(i)
      if (c === '\u00A7' && i + 1 < len) {
        var n = s.charAt(i + 1)
        if (n === '!') { if (open) { out += '</span>'; open = false } i += 2; continue }
        if (Object.prototype.hasOwnProperty.call(LOC_COLORS, n)) {
          if (open) { out += '</span>'; open = false }
          out += '<span style="color:' + LOC_COLORS[n] + '">'; open = true
          i += 2; continue
        }
      }
      out += escHtml(c)
      i++
    }
    if (open) out += '</span>'
    return out
  }

  function html(key) {
    var t = text(key)
    return t ? colorize(t) : escHtml(key || '' )
  }
    /** 同步读缓存。查不到返回 ''(调用方决定回退成 id 还是别的) */
  function text(key) {
    if (!key) return ''
    var h = cache.get(key)
    return h ? h.text : ''
  }

  /** $KEY$ 展开:本地化值里 '$某键$' 是对另一个 key 的引用,递归取它(循环保护)。
   *  例:CHN_armour_industry_infantry_tank_organisation: "$CHN_armour_industry_organisation$(坦克研发部门)"
   *   → "中国装甲企业(坦克研发部门)"。找不到被引用 key 时保留原样。 */
  function expandRefs(s, depth) {
    depth = depth || 0
    if (depth > 6) return s
    // $$ = 字面美元符(Wiki:输入 $ 本身需双写)——先转占位,再展开 $KEY$,最后还原
    var out = String(s).replace(/\$\$/g, '\u0000')
    out = out.replace(/\$([A-Za-z0-9_]+)\$/g, function (_, k) {
      var v = text(k)
      if (!v) return '$' + k + '$'
      if (v.indexOf('$') >= 0) return expandRefs(v, depth + 1)
      return v
    })
    return out.replace(/\u0000/g, '$')
  }
  function hit(key) {
    return cache.get(key) || null
  }

  /**
   * 显示名:有译文用译文,没有就退回 id。
   * UI 里绝大多数场景要的就是这个 —— 一律用它,不用自己判空。
   *
   * ★ `$var$` 处理:本地化值里常嵌游戏内变量引用,例如
   *     GER_porsche_organization: "$porsche$"
   *   原样显示 "$porsche$" 对用户毫无意义,但直接显示 "porsche" 又像译文。
   *   这里保留可辨识形态:去掉 $ 包裹并在前面加「⚠」,提示"这是变量不是译文"。
   */
  /** ── 统一本地化渲染 API(各模块统一调用,不要再手拼 innerHTML)────────
   *  rich(key, {maxLen, showKey})  key → 带色 HTML。有译文按 § 码着色;
   *                                无译文退回灰体 key;showKey=true 时译文后附灰体 key 小字(检查器用)。
   *  richText(text, {maxLen})      任意文本 → 带色 HTML(翻译原文预览,保留 $var$)。
   *  fill(el, key, opt)            el.innerHTML = rich(key, opt)。
   *  底层:colorize() 文本→HTML(§ 原样) / html() 键→HTML。 */
  function rich(key, opt) {
    opt = opt || {}
    var t = text(key)
    if (!t) return '<span class="k">' + escHtml(key || '—') + '</span>'
    var s = expandRefs(t.split('\n')[0])

    if (opt.maxLen && s.length > opt.maxLen) s = s.slice(0, opt.maxLen - 1) + '…'
    var body = colorize(s)
    if (opt.showKey) body += ' <span class="k">' + escHtml(key) + '</span>'
    return body
  }
  function richText(text, opt) {
    var s = String(text == null ? '' : text).split('\n')[0]
    if (opt && opt.maxLen && s.length > opt.maxLen) s = s.slice(0, opt.maxLen - 1) + '…'
    return colorize(s)
  }
  function fill(el, key, opt) {
    if (el) el.innerHTML = rich(key, opt)
    return el
  }

  function label(key, maxLen) {
    var t = text(key)
    if (!t) return key || ''
    // 多行条目(描述文本)取第一行,太长截断 —— 列表里塞整段会炸版。
    // § 码原样显示(用户回退)。
    var s = expandRefs(t.split('\n')[0])

    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
    return s
  }
  function on(fn) {
    listeners.push(fn)
    return function off() {
      var i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  /** 单批上限:URL 长度有限,一次别发太多 */
  var BATCH = 400

  /* PERF_V2:轮询退避。
   * 固定 900ms 的问题:索引 1 秒内就绪时白等 900ms;真慢时(几十秒)又要
   * 打几十次请求,每次都是一次完整往返。改成 250ms 起步、1.5 倍递增、
   * 上限 2s —— 快时不迟钝,慢时不刷屏。 */
  function backoff(attempt) {
    var ms = 250 * Math.pow(1.5, Math.min(attempt, 6))
    return Math.min(ms, 2000)
  }

  function fetchBatch(keys, lang, attempt) {
    attempt = attempt || 0
    var qs = keys.map(encodeURIComponent).join(',')
    return fetch('/api/loc/text?lang=' + encodeURIComponent(lang || currentLang()) + '&keys=' + qs)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (j) {
        /* 索引还在异步构建(2026-10 起 ensureLoc 也是 setImmediate 模式)→
         * 服务端回 ready:false。等一会原样重试同一批,不能当成"无译文"。 */
        if (j && j.ready === false) {
          if (attempt >= 120) return j // 退避后总时长约 3 分钟,够索引构建完
          return new Promise(function (done) {
            setTimeout(function () { done(null) }, backoff(attempt))
          }).then(function () { return fetchBatch(keys, lang, attempt + 1) })
        }
        if (j && Array.isArray(j.langs)) {
          langOptions = j.langs
        }
        var texts = (j && j.texts) || {}
        for (var k in texts) {
          var v = texts[k]
          if (v) cache.set(k, v)
          // 查不到的**不写 null** —— 换语言后可能要重查,
          // 写 null 会让"缓存命中"和"确认不存在"混为一谈
        }
        return j
      })
  }

  /**
   * 批量加载本地化文本。
   * @param {string[]} keys
   * @param {object} [opt] {force} force=true 时忽略缓存全量重拉
   * @returns {Promise<number>} 实际新加载的 key 数
   */
  function load(keys, opt) {
    opt = opt || {}
    var lang = currentLang()
    if (opt.force) {
      cache.clear()
    }
    // 先按缓存过滤,避免每次渲染都发一堆已知请求
    var want = []
    var seen = new Set()
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (!k || seen.has(k)) continue
      seen.add(k)
      if (!cache.has(k)) want.push(k)
    }
    if (!want.length) return Promise.resolve(0)

    // 已在飞的合并进同一个 Promise
    var todo = []
    var waits = []
    for (var j = 0; j < want.length; j++) {
      var kk = want[j]
      if (inflight.has(kk)) waits.push(inflight.get(kk))
      else todo.push(kk)
    }
    if (!todo.length) return Promise.all(waits).then(function () { return 0 })

    // 分批 + 逐批串行(单批并发 3,别把本地 server 打满)
    var p = Promise.resolve()
    for (var b = 0; b < todo.length; b += BATCH) {
      ;(function (slice) {
        p = p.then(function () {
          var jp = fetchBatch(slice, lang)
          for (var q = 0; q < slice.length; q++) inflight.set(slice[q], jp)
          return jp.then(
            function () {
              for (var q = 0; q < slice.length; q++) inflight.delete(slice[q])
              emit()
            },
            function (e) {
              for (var q = 0; q < slice.length; q++) inflight.delete(slice[q])
              throw e
            },
          )
        })
      })(todo.slice(b, b + BATCH))
    }
    return p.then(function () { return todo.length })
  }

  /** 语言下拉选项(第一次调用会拉 /api/loc/stats) */
  function languages(attempt) {
    if (statsLoaded) return Promise.resolve(langOptions)
    attempt = attempt || 0
    return fetch('/api/loc/stats')
      .then(function (r) { return r.json() })
      .then(function (j) {
        /* ⚠ 服务端同时给两个数组,字段名不同,挑错就静默炸:
         *   j.langs       = [{ lang, keys, missing }]  ← 统计用,没有 id/label
         *   j.langOptions = [{ id, label }]            ← 下拉要的
         *   曾经只读 j.langs,于是 langOptions 里全是 {lang,keys,missing},
         *   fill() 里 o.id 为 undefined → .replace 直接抛,
         *   **全站每个挂了下拉的页面都跟着炸**(桩测测不出来,DOM 桩没有真页面)。
         *   优先读 langOptions,退回 langs 时现场补出 id/label。 */
        if (j && j.ready === false && attempt < 120) {
          return new Promise(function (done) { setTimeout(done, backoff(attempt)) })
            .then(function () { return languages(attempt + 1) })
        }
        if (j && Array.isArray(j.langOptions) && j.langOptions.length) {
          langOptions = j.langOptions
        } else if (j && Array.isArray(j.langs) && j.langs.length) {
          langOptions = j.langs.map(function (x) {
            return { id: x.id || x.lang, label: x.label || x.lang }
          })
        }
        statsLoaded = true
        return langOptions
      })
      .catch(function () { return langOptions })
  }

  /** 建一个语言下拉 <select>,挂在 host 里。返回 el。 */
  function mountLangSelect(host, onChange) {
    var sel = document.createElement('select')
    sel.title = '界面显示名使用的语言(默认英文)'
    sel.style.maxWidth = '120px'
    function fill() {
      sel.innerHTML = ''
      var cur = currentLang() || DEFAULT_LANG
      for (var i = 0; i < langOptions.length; i++) {
        var o = document.createElement('option')
        /* ⚠ 兜底:字段名对不上时宁可显示原始 id,也不能让整页抛异常。
         *   (langOptions 来自服务端,一旦字段改名就是全站级故障) */
        var id = langOptions[i].id || langOptions[i].lang || ''
        o.value = id
        o.textContent = langOptions[i].label || id
        // 索引里的 id 带 l_ 前头,用户存的是 english —— 两种写法都算命中
        if (id === cur || id.replace(/^l_/, '') === cur.replace(/^l_/, '')) {
          o.selected = true
        }
        sel.appendChild(o)
      }
      // 索引里没有当前语言(比如索引只扫到部分根)→ 补一个免得显示空白
      if (!sel.value) {
        var o2 = document.createElement('option')
        o2.value = cur
        o2.textContent = cur
        o2.selected = true
        sel.appendChild(o2)
      }
    }
    languages().then(fill)
    sel.addEventListener('change', function () {
      setLang(sel.value)
      fill()
      if (onChange) onChange(sel.value)
    })
    if (host) host.appendChild(sel)
    return sel
  }

  /* 自动挂载:页面里有 #langbar 就把语言下拉塞进去。
   * 条件是容器存在且还没挂过 —— 各页 HTML 已统一加了 <div id="langbar">。 */
  function autoMount() {
    var host = document.getElementById('langbar')
    if (!host || host.dataset.locMounted) return
    host.dataset.locMounted = '1'
    mountLangSelect(host, function () {
      // 换语言 → 通知所有页面重绘(各页自己监听 Loc.on)
      emit()
    })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount)
  } else {
    autoMount()
  }

  /** ★ 双语配对:一次拿多个 key 的【英文+中文】(含来源/缺失)。
   * 供本地化管理、英中对照、其他功能统一接入。返回 {key: {en, zh, missing}}。
   * en/zh = {text, lang, file, line, rootIdx} 或 null;missing = 缺失语言数组。 */
  function pair(keys) {
    var list = []
    var seen = new Set()
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (!k || seen.has(k)) continue
      seen.add(k)
      list.push(k)
    }
    if (!list.length) return Promise.resolve({})
    var qs = list.map(encodeURIComponent).join(',')
    return fetch('/api/loc/pair?keys=' + qs)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (j) { return (j && j.pairs) || {} })
  }
  global.Loc = {
    DEFAULT_LANG: DEFAULT_LANG,
    currentLang: currentLang,
    setLang: setLang,
    text: text,
    hit: hit,
    label: label,
    on: on,
    load: load,
    languages: languages,
    mountLangSelect: mountLangSelect,
    autoMount: autoMount,
    pair: pair,
    cacheSize: function () { return cache.size },
    rich: rich,
    richText: richText,
    fill: fill,
    colorize: colorize,
    html: html,
  }
})(window)
