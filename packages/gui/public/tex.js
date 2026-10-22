/**
 * ════════════════════════════════════════════════════════════════════════
 *  公共贴图加载器 —— 所有内容页共用(焦点/科技/学说/决议/事件/DLC/MIO)
 * ════════════════════════════════════════════════════════════════════════
 *
 * ★★★ 为什么要有这个文件(实测踩出来的)
 *
 * 之前 focus / decisions / dlc / doctrines 四页各抄了一份 `loadTex()`,
 * 四份代码一模一样,但**四份全是坏的**:它们把数据文件里的贴图名
 * (如 `GFX_doctrine_strategic_destruction_medium`)直接塞进
 * `/api/tex?id=`,而后端只认自己生成的 `t0/t1/...` 内部 id
 * → 全部 404 → 所有内容页的图标一片空白。
 *
 * 所以真正的修复有两半,缺一不可:
 *   后端 resolveTexId()  —— 接受 tN / sprite 名 / 原始路径三种形态
 *   本文件 Tex.mount()   —— 统一懒加载 + 统一缓存 + 统一失败占位
 *
 * ── 用法 ──
 *   元素:  <img class="ic" data-tex="GFX_xxx">
 *   渲染后:Tex.mount(rootEl)          // 一次性挂载,自动 IntersectionObserver
 *   动态加: Tex.refresh(container)    // 或重新 mount
 *   预取:  await Tex.prefetch([...])  // 提前把像素拉进缓存
 *   尺寸:  await Tex.info([...])      // 只查天然尺寸/帧数,不解码像素
 *
 * 贴图名解析顺序(与后端 resolveTexId 一致):
 *   ① sprite 名 GFX_xxx     → spriteIdx 查 texturefile
 *   ② 原始贴图路径 gfx/...  → 直接建候选(即使没被任何 sprite 引用)
 *   ③ 都不是                → 记为失败,占位不重试
 *
 * 与 locclient.js 同风格:IIFE + 挂 window,普通 <script src> 引入即可,
 * 不需要各页改成 type="module"(那会连带影响页面里其它脚本的加载顺序)。
 */
;(function (global) {
  'use strict'

  var api = function (u) {
    return fetch(u).then(function (r) {
      return r.json()
    })
  }

  /** name → dataURI | null(null = 已知失败,不再重试) */
  var cache = new Map()
  /** 正在请求中的 name,防止同一张图被 N 个 <img> 同时触发 */
  var inflight = new Map()

  var io = null
  function observer() {
    if (io) return io
    io = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i]
          if (!e.isIntersecting) continue
          var img = e.target
          io.unobserve(img)
          if (!img.dataset.tex || img.src) continue
          apply(img)
        }
      },
      // root 留 null:观察 viewport。内容页的滚动容器是自己布局的,
      // 绑具体 root 反而会在面板折叠/换页后失效(这是原来那几份副本的老 bug)。
      { rootMargin: '300px 0px' },
    )
    return io
  }

  /** 失败占位:去掉 src 并打标记,CSS 负责画一个底色方块 */
  function markFail(img) {
    img.classList.add('tex-fail')
    img.removeAttribute('src')
  }

  /** 把已缓存的 URL 贴到 <img> 上;没有就发起请求 */
  function apply(img) {
    var tex = img.dataset.tex
    if (!tex) return
    if (!cache.has(tex)) {
      fetchOne(tex).then(function (u) {
        // 同一 tex 的所有 <img> 都要补上(卡片墙常有几十个同图)
        var all = document.querySelectorAll('img[data-tex]')
        for (var i = 0; i < all.length; i++) {
          var el = all[i]
          if (el.dataset.tex === tex && !el.src) {
            if (u) el.src = u
            else markFail(el)
          }
        }
      })
      return
    }
    var hit = cache.get(tex)
    if (hit) img.src = hit
    else markFail(img)
  }

  function fetchOne(tex) {
    if (cache.has(tex)) return Promise.resolve(cache.get(tex))
    if (inflight.has(tex)) return inflight.get(tex)
    var p = api('/api/tex?id=' + encodeURIComponent(tex))
      .then(function (d) {
        var url = d && d.png ? 'data:image/png;base64,' + d.png : null
        cache.set(tex, url)
        return url
      })
      .catch(function () {
        cache.set(tex, null)
        return null
      })
      .finally(function () {
        inflight.delete(tex)
      })
    inflight.set(tex, p)
    return p
  }

  global.Tex = {
    /** 挂载一个容器内所有 data-tex <img>(幂等,已挂过的跳过) */
    mount: function (root) {
      var box = root || document
      var list = box.querySelectorAll('img[data-tex]')
      for (var i = 0; i < list.length; i++) {
        var img = list[i]
        if (img.dataset.texMounted) continue
        img.dataset.texMounted = '1'
        img.loading = 'lazy'
        img.decoding = 'async'
        // 有缓存的直接贴上,没缓存的挂观察器等进视口
        apply(img)
        if (!cache.has(img.dataset.tex)) observer().observe(img)
      }
    },

    /** 容器内容整体替换后调用:重新扫描 + 清理已移出 DOM 的观察(防观察器攒死节点) */
    refresh: function (root) {
      if (io) {
        var all = document.querySelectorAll('img[data-tex]')
        for (var i = 0; i < all.length; i++) {
          if (!all[i].isConnected) io.unobserve(all[i])
        }
      }
      this.mount(root)
    },

    /** 预取像素(进缓存)。不阻塞渲染,失败静默。 */
    prefetch: function (names) {
      var seen = new Set()
      var todo = []
      for (var i = 0; i < (names || []).length; i++) {
        var n = names[i]
        if (n && !cache.has(n) && !seen.has(n)) {
          seen.add(n)
          todo.push(n)
        }
      }
      if (!todo.length) return Promise.resolve()
      // 分批并发,别一次打上百个请求把浏览器连接队列堵死
      var chain = Promise.resolve()
      for (var j = 0; j < todo.length; j += 6) {
        ;(function (batch) {
          chain = chain.then(function () {
            return Promise.all(batch.map(fetchOne))
          })
        })(todo.slice(j, j + 6))
      }
      return chain
    },

    /**
     * ★ 尺寸预取:只取"贴图在哪 / 多大 / 几帧",不解码像素。
     * 用于渲染前先占好位,避免图片到位后布局一跳。
     * 返回 { name: {ok, w, h, frames, rel, error} }
     */
    info: function (names) {
      var seen = new Set()
      var todo = []
      for (var i = 0; i < (names || []).length; i++) {
        var n = names[i]
        if (n && !seen.has(n)) {
          seen.add(n)
          todo.push(n)
        }
      }
      if (!todo.length) return Promise.resolve({})
      var out = {}
      var chain = Promise.resolve()
      for (var j = 0; j < todo.length; j += 200) {
        ;(function (batch) {
          chain = chain.then(function () {
            return api('/api/texinfo?names=' + encodeURIComponent(batch.join(',')))
              .then(function (d) {
                Object.assign(out, (d && d.items) || {})
              })
              .catch(function () {
                for (var k = 0; k < batch.length; k++) out[batch[k]] = { ok: false, error: '查询失败' }
              })
          })
        })(todo.slice(j, j + 200))
      }
      return chain.then(function () {
        return out
      })
    },

    /** 单张 URL(同步,只查已缓存的;未缓存返回 '') */
    peek: function (tex) {
      return cache.get(tex) || ''
    },

    /** 已缓存的贴图统计 —— 调试用 */
    stats: function () {
      var ok = 0
      var bad = 0
      cache.forEach(function (v) {
        if (v) ok++
        else bad++
      })
      return { total: cache.size, ok: ok, bad: bad }
    },
  }

  /* 页面切走时断开观察器 */
  global.addEventListener('beforeunload', function () {
    if (io) io.disconnect()
  })
})(window)
