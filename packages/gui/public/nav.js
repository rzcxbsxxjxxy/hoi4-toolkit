/* ══════════════════════════════════════════════════════════════════
 * 统一顶栏导航
 *
 * 之前每个页面各自手写「← GUI 工作台」和「⚙ 设置」两个 <a>,
 * 而且设置按钮是内联 style、颜色硬编码 —— 加一个入口要改 6 个文件。
 * 这里统一注入:分组导航 + 当前页高亮 + 📖 教程 + ⚙ 设置。
 *
 * 用法:页面里放 <div id="nav"></div> 后调 mountNav('#nav')。
 *
 * ★ 2026-10-05 导航从「13 项平铺」改为「4 组下拉」(用户要求"简洁明了"):
 *   平铺 13 个链接在 1280px 宽下会换行,且新加 2 个模块后更挤。
 *   改为:1 个 logo/首页 + 4 个分组下拉(内容 / 界面 / 文档 / 工具)
 *   + 教程 + 设置。任何一屏最多 7 个元素,加模块不再影响布局。
 *   ⚠ 页面自己若需要展示"当前页在哪个组",用 opts.active 自动高亮。
 *
 * ★ 顺带在这里套用外观设置(主题 / 强调色 / 图标):
 *   nav.js 是所有页面都会加载的入口,挂导航时把外观一起应用,
 *   就不用给 10 个页面各加一遍 <script>。
 * ══════════════════════════════════════════════════════════════════ */
import { applyAppearance } from './appearance.js'

/* I18N_V1:i18n.js 刻意**没有 export**(它是经典脚本,给 15 个页面的
 *   普通 <script> 共用)。nav.js 是 module,不能 import 一个无 export 的文件,
 *   所以从 window.I18N 取。页面里 i18n.js 必须排在 nav.js 之前 ——
 *   见各页面 <script> 顺序。*/
const I18N = window.I18N
const t = (k) => (I18N ? I18N.t(k) : k)
const onLangChange = (fn) => (I18N ? I18N.onLangChange(fn) : () => {})

/** 导航项的中英文键。label/desc 直接用 i18n 键,
 *  切换语言时重挂导航即可全站跟着变(不需要每个页面各写一遍)。*/
const I18N_KEY = {
  '/focus': ['nav.focus', 'nav.focus.desc'],
  '/tech': ['nav.tech', 'nav.tech.desc'],
  '/doctrines': ['nav.doctrines', 'nav.doctrines.desc'],
  '/defines': ['nav.defines', 'nav.defines.desc'],
  '/decisions': ['nav.decisions', 'nav.decisions.desc'],
  '/events': ['nav.events', 'nav.events.desc'],
  '/aibehave': ['nav.aibehave', 'nav.aibehave.desc'],
  '/dlc': ['nav.dlc', 'nav.dlc.desc'],
  '/worldmap': ['nav.worldmap', 'nav.worldmap.desc'],
  '/modrel': ['nav.modrel', 'nav.modrel.desc'],
  '/characters': ['nav.characters', 'nav.characters.desc'],
  '/units': ['nav.units', 'nav.units.desc'],
  '/designer': ['nav.designer', 'nav.designer.desc'],
  '/create': ['nav.create', 'nav.create.desc'],
  '/ide': ['nav.ide', 'nav.ide.desc'],
  '/ref': ['nav.ref', 'nav.ref.desc'],
  '/commondocs': ['nav.commondocs', 'nav.commondocs.desc'],
  '/loc': ['nav.loc', 'nav.loc.desc'],
  '/tracker': ['nav.tracker', 'nav.tracker.desc'],
  '/check': ['nav.check', 'nav.check.desc'],
  '/open.html': ['nav.open', 'nav.open.desc'],
  '/docs': ['nav.docs', 'nav.docs.desc'],
  '/settings': ['nav.settings', 'nav.settings.desc'],
}
/* ⚠ 分组名用独立的 nav.grp* 键,不能复用条目键。
 *   曾把「文档」组映射到 nav.docs —— 而 nav.docs 同时是"使用教程"条目的键,
 *   结果组名渲染成「使用教程」。键空间撞车,改一处崩两处。*/
const GROUP_KEY = { 内容: 'nav.grpContent', 界面: 'nav.grpUi', 文档: 'nav.grpDocs', 工具: 'nav.grpTools' }

/**
 * 分组导航表。
 * ⚠ 新增页面只改这一处 —— mountNav / mountSide / 搜索都从这里派生,
 *   不要在别处再抄一份链接数组。
 */
export const NAV_GROUPS = [
  {
    label: '内容',
    items: [
      { href: '/focus', label: '国策树', desc: '来源 · 坐标 · 体检' },
      { href: '/tech', label: '科技树', desc: '两级分类 · 隐藏科技' },
      { href: '/doctrines', label: '学说系统', desc: '页签 · 轨道 · 分支' },
      { href: '/defines', label: '平衡参数', desc: 'defines.lua · 官方注释' },
      { href: '/decisions', label: '决议树', desc: '类别卡片墙' },
      { href: '/events', label: '事件', desc: '触发条件 · 效果' },
      { href: '/aibehave', label: 'AI 行为', desc: 'common/ai_* · 逐文件归纳' },
      { href: '/dlc?feature=mio', label: 'DLC-军工机构', desc: 'Arms Against Tyranny' },
      { href: '/dlc?feature=special_projects', label: 'DLC-特殊工程', desc: 'Gotterdammerung' },
      { href: '/dlc?feature=factions', label: 'DLC-阵营', desc: 'No Compromise, No Surrender' },
      { href: '/worldmap', label: '世界地图', desc: '多来源合成 · 省份归属' },
      { href: '/modrel', label: '模组关系', desc: '依赖图 · replace_path' },
      { href: '/characters', label: '人物角色', desc: 'common/characters · 肖像 · 职务' },
      { href: '/units', label: '单位和装备', desc: '单位类型 · 装备 · 命名' },
    ],
  },
  {
    label: '界面',
    items: [
      { href: '/designer', label: '所见即所得', desc: '元素树 · 属性 · 回写' },
      { href: '/create', label: '内容生成', desc: '表单产出规范文件' },
      { href: '/ide', label: '代码 IDE', desc: '高亮 · 大纲 · 跳转' },
    ],
  },
  {
    label: '文档',
    items: [
      { href: '/ref', label: '官方手册', desc: 'effects / triggers' },
      { href: '/commondocs', label: 'common 文档', desc: '按文件夹索引' },
      { href: '/loc', label: '本地化', desc: '缺失 · 覆盖链' },
    ],
  },
  {
    label: '工具',
    items: [
      { href: '/tracker', label: '更新跟踪', desc: '基线快照 · 变更 diff' },
      { href: '/check', label: '体检', desc: '语法 · 悬空引用' },
      { href: '/open.html', label: '打开工程', desc: '挂游戏目录 / 模组' },
      { href: '/docs', label: '使用教程', desc: '上手 · 概念 · 常见问题' },
      { href: '/settings', label: '设置', desc: '主题 · 来源 · 背景' },
    ],
  },
]

/** 扁平化,便于 curKey / mountSide 复用 */
const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })))

/* ═══ 壳 iframe 池(性能:切换秒开)═══
 * 壳容器 div#content 内常驻多个隐藏 iframe;访问过的页面保留(池限容量),
 * 切回时免整页重建。__shellFrame() 返回当前活动 iframe 供 curKey 读取。 */
const FRAME_MAX = 10 /* PERF_V1(2026-10-18):16→10,减少常驻隐藏 iframe 内存。预取也精简了(见下),低频页按需加载 */
let shellPool = {}
let shellCur = null
let shellNavEl = null

/* 统一跳转:壳内子页(iframe)与壳导航都走它 → 复用 iframe 池 + 预取,
 * 既快又保证导航高亮一致。暴露到 window 供 iframe 内的链接/卡片调用。
 * ★ 2026-10-11 修复:之前主页卡片用 location.href 直接刷新本 iframe(绕过池,
 *   既慢又容易"点了没反应");现在统一走 shellGo → 命中预取池、显示加载遮罩。 */
function shellGo(href) {
  if (typeof href !== 'string') return
  const base = href.split('#')[0] || href
  const tgt = base === '/' ? '/home' : base
  const key = tgt.replace(/\.html?$/, '') || '/'
  const url = tgt + (tgt.indexOf('?') >= 0 ? '&' : '?') + 'frame=1'
  if (window.shellSwitch) window.shellSwitch(key, url)
  else location.href = tgt
}
window.shellGo = shellGo

/* 每帧加载遮罩:iframe 未 ready 时挡住白屏,loaded 后收起(见 shellSwitch / shellEnsure)。
 * 暴露到 window 供 iframe 内链接在跳转前显式 show。
 * ★ FRAME_BUSY_V2(2026-10-22):遮罩改为【按帧跟踪】,修掉两个白屏来源 ——
 *   ① 新建 iframe 的 contentDocument 此刻是 about:blank,readyState 也是 'complete',
 *      旧逻辑据此判定"已就绪"→ 遮罩秒收,子页还没到 → 满屏白。
 *   ② 旧逻辑对【任何】帧的 load 事件都收遮罩 —— 后台预取帧加载完成时
 *      会把当前页正在显示的遮罩抢跑收掉,同样露白。
 * 现在:每帧自己记 __shellReady;只有【当前活动帧】load 完且内容非空才收。 */
let frameBusyEl = null
let frameBusyMsgEl = null
const shellFrameBusy = {
  show(msg) {
    if (!frameBusyEl) return
    if (msg != null && frameBusyMsgEl) frameBusyMsgEl.textContent = msg
    frameBusyEl.hidden = false
  },
  hide() { if (frameBusyEl) frameBusyEl.hidden = true },
  bind(el) {
    frameBusyEl = el
    frameBusyMsgEl = el ? el.querySelector('.fb-msg') : null
  },
}
window.shellFrameBusy = shellFrameBusy

/* 帧内容是否真的就绪(同源可读;跨域/未挂载返回 null) */
function frameContentReady(f) {
  try {
    const w = f && f.contentWindow
    if (!w || !w.document) return null
    if (w.document.readyState !== 'complete') return false
    const b = w.document.body
    return b && b.children.length > 0 ? true : false
  } catch (e) { return null }
}

/* 帧内容就绪后收遮罩(带超时安全网)。
 * ★ 必须在 shellSwitch 里也挂:池内已加载完的帧再次切回时不会再触发 load
 *   事件,若只靠 load 回调收遮罩,切回旧页会一直挂着"正在加载"。 */
function waitFrameReady(f) {
  let waited = 0
  const confirm = () => {
    if (shellCur !== f) return          // 期间又切走了 → 交棒给新帧
    const st = frameContentReady(f)
    if (st === true) { shellFrameBusy.hide(); return }
    if (st === null || waited >= 3000) { shellFrameBusy.hide(); return }  // 跨域取不到/超时 → 强制收起,别永久挡住平台
    waited += 60
    setTimeout(confirm, 60)
  }
  setTimeout(confirm, 60)
}

function shellEnsure(url, tgt) {
  if (shellPool[url]) return shellPool[url]
  const f = document.createElement('iframe')
  f.className = 'shellframe'
  f.setAttribute('allow', 'autoplay; fullscreen')
  f.setAttribute('name', 'appframe')
  /* ★ 该帧是否真正 load 完成。新建时为 false —— about:blank 不算。 */
  f.__shellReady = false
  f.src = tgt
  f.addEventListener('load', () => {
    f.__shellReady = true
    /* ★ 遮罩由 shellSwitch 统一挂 waitFrameReady 收 —— 这里【不】再收:
     *   后台预取帧的 load 不能抢跑收掉当前页正在显示的遮罩。 */
    if (shellNavEl && document.body && document.body.contains(shellNavEl)) updateNavActive(shellNavEl)
    /* FRONT_READY:首次 iframe 加载完成 = 壳页前端完全就绪,通知主进程再显示主窗口
       避免"主窗口出现但前端还在初始化/首帧卡顿"的未响应体验 */
    if (typeof window.__frontReadySent === 'undefined') {
      window.__frontReadySent = true
      if (window.electronAPI && typeof window.electronAPI.windowShowReady === 'function') {
        try { window.electronAPI.windowShowReady() } catch (e) {}
      }
    }
  })
  const host = document.getElementById('content')
  if (host) host.appendChild(f)
  shellPool[url] = f
  return f
}
function shellSwitch(url, tgt) {
  const f = shellEnsure(url, tgt)
  /* ★ FRAME_BUSY_V2:不能用 `f.contentDocument.readyState === 'complete'` 判断就绪 ——
   *   新建 iframe 的 contentDocument 此刻还是 about:blank,readyState 同样是 'complete',
   *   于是遮罩在子页尚未到达前就被收起 → 满屏白(用户报的"进页面白屏")。
   *   改看该帧自己的 __shellReady 标志:只有真正 load 过才算数。 */
  if (f.__shellReady) {
    const st = frameContentReady(f)
    if (st === true) shellFrameBusy.hide()
    else shellFrameBusy.show()
  } else {
    shellFrameBusy.show()
  }
  const keys = Object.keys(shellPool)
  if (keys.length >= FRAME_MAX && !shellPool[url]) {
    const victim = keys.find((k) => k !== url && k !== curKey())
    if (victim && shellPool[victim]) { shellPool[victim].remove(); delete shellPool[victim] }
  }
  for (const k in shellPool) {
    const fr = shellPool[k]
    if (fr === f) { fr.classList.add('on'); fr.style.visibility = 'visible' }
    else { fr.classList.remove('on'); fr.style.visibility = 'hidden' }
  }
  shellCur = f
  window.__shellFrame = () => f
  /* ★ 遮罩收起的统一出口:不管这帧是刚建(等 load 事件)还是池内复用
   *   (load 早已发生,不会再触发),都在这里挂一次就绪轮询。
   *   池内复用的帧若内容已就绪,waitFrameReady 会在第一拍直接收起。 */
  waitFrameReady(f)
  if (shellNavEl) updateNavActive(shellNavEl)
  return f
}
function shellPrefetch(url, tgt) {
  if (shellPool[url]) return
  shellEnsure(url, tgt)
}

/** 当前页路径 → 归一化(/focus.html 与 /focus 算同一个)。
 * 壳模式(shell.html 统一外壳)下 location 恒为 /,改从 iframe 当前 src 读当前页。 */
function curKey() {
  if (window.__shellFrame) {
    try {
      const f = typeof window.__shellFrame === 'function' ? window.__shellFrame() : window.__shellFrame
      const st = f && f.src ? new URL(f.src).pathname : ''
      if (st) {
        const pp = st.replace(/\.html?$/, '')
        return pp === '' || pp === '/index' || pp === '/home' ? '/' : pp
      }
    } catch (e) {}
  }
  const p = location.pathname.replace(/\.html?$/, '')
  return p === '' || p === '/index' || p === '/home' ? '/' : p
}

const ESC = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/**
 * @param {string|Element} host  容器选择器或元素
 * @param {{dark?:boolean}} [opts]
 *        ⚠ 2026-10-05 起 `dark` 已**无视觉效果**。原先它给容器加 `.on-dark`,
 *        用来切到体检页/打开工程页各自复制的深色配色;那两份硬编码配色
 *        已随「背景统一到设置中的主题」删除,配色改由 theme-vars.css 的
 *        变量决定,自动跟随 light / dark / midnight / sand。
 *        参数保留只为不破坏既有调用点(传了无害)。
 */
/** ★ 壳内子页:由统一外壳 shell.html 的 iframe 以 ?frame=1 加载。
 *   这时本页不渲染顶部导航(壳统一渲染)、不注入音乐框(壳统一持有),
 *   只保留外观应用 + 语言联动 + 内部链接保持 frame 模式跳转。 */
const IS_FRAME = new URLSearchParams(location.search).has('frame') || (window !== window.top)

export function mountNav(host, opts) {
  // 外观先套用:深色主题必须在渲染导航前生效,否则会看到一帧白底闪烁
  applyAppearance()
  const el = typeof host === 'string' ? document.querySelector(host) : host
  if (!el) return
  // ★ 壳内子页:隐藏本页导航容器(header 仅含 #nav 时整体隐藏),不注入音乐框
  if (IS_FRAME) {
    const hd = el.closest('header')
    if (hd && hd.children.length <= 1) hd.style.display = 'none'
    else el.style.display = 'none'
    document.body.classList.add('in-shell')
    wireFrameLang()
    wireFrameLinks()
    return
  }
  el.dataset.navHost = '1'
  el._navOpts = opts
  // ★ 统一外壳(shell.html):opts.frame=true。壳渲染顶部导航 + 持有音乐框,
  //   curKey/导航拦截从 iframe 当前 src 读,iframe load 后刷新导航高亮。
  if (opts && opts.frame) {
    if (!el._navFrameWired) {
      el._navFrameWired = true
      shellNavEl = el
      if (window.__shellFrame == null) window.__shellFrame = () => shellCur || document.getElementById('content')
      window.shellSwitch = shellSwitch
      window.shellPrefetch = shellPrefetch
      /* ★ POOL_DROP_V1(2026-10-17):按 key 丢弃池中的某一帧。
       * 存在的理由:shellEnsure 命中池即复用,**不重新加载** → 凡是"后端状态变了、
       * 需要目标页重新拉数据"的场景,直接 shellSwitch 会拿到旧 DOM,表现为
       * "列表没更新,得重启程序"。导入模组后回首页就是这个 bug 的实例
       * (/api/load 改了 ROOTS 并落盘,但 home 帧是池里预热好的旧帧)。
       * 只丢指定 key(其余页面仍复用),比重置整池(location.reload 全站闪)代价小得多。 */
      window.__shellDropFrame = function (key) {
        const fr = shellPool[key]
        if (!fr) return false
        try { if (fr.parentNode) fr.parentNode.removeChild(fr) } catch (e) {}
        delete shellPool[key]
        if (shellCur === fr) shellCur = null
        return true
      }
      window.__shellResetPool = function () {
        for (const k in shellPool) {
          const fr = shellPool[k]
          try { if (fr && fr.parentNode) fr.parentNode.removeChild(fr) } catch (e) {}
          delete shellPool[k]
        }
        shellPool = {}
        shellCur = null
        if (shellNavEl && shellNavEl._navFrameWired) { shellNavEl._navFrameWired = false }
        location.reload()
      }
      shellFrameBusy.bind(document.getElementById('framebusy'))
      // 首页 iframe 延迟到壳渲染完成 + front-ready 之后创建(见 PROG_FRONT_READY 块后),
      // 避免首页重渲染阻塞壳渲染进程,导致主窗迟迟不显示 / 显示后无响应。
      // 预取高频页:闲置时后台加载隐藏 iframe,切到时秒开
      setTimeout(() => {
        shellPrefetch('/tech', '/tech?frame=1')
        shellPrefetch('/focus', '/focus?frame=1')
      }, 900)
      // 2026-10-11:多预取几个常用页(错峰,避免一次性卡顿)
      setTimeout(() => {
        const more = ['/dlc', '/doctrines'] /* PERF_V1:精简预取,去掉低频 5 页(designer/check/tracker/decisions/events),降低常驻内存与后台开销;核心页 /tech /focus /dlc /doctrines 仍秒开 */
        more.forEach((u, i) => setTimeout(() => shellPrefetch(u, u + '?frame=1'), 300 + i * 250))
      }, 900)
    }
  }
  renderNav(el)
  /* PROG_FRONT_READY(渐进式启动):壳页导航渲染完成即视为前端就绪,
     通知主进程立即显示主窗口——不再等首个首页 iframe 加载完成。
     首页 iframe 在 shellSwitch 中异步加载,期间由 framebusy 遮罩过渡。 */
  if (typeof window.__frontReadySent === 'undefined') {
    window.__frontReadySent = true
    if (window.electronAPI && typeof window.electronAPI.windowShowReady === 'function') {
      try { window.electronAPI.windowShowReady() } catch (e) {}
    }
  }
  // 壳可交互后再创建首页 iframe(后台加载,由 framebusy 遮罩过渡),不阻塞壳渲染进程
  if (opts && opts.frame) shellSwitch('/home', '/home?v=20261010&frame=1')
  // MUSIC_V3: 页面加载时即负载 music.js,后台恢复播放(跨页不间断)
  if (!el._navMusicWired) {
    el._navMusicWired = true
    import('./music.js?v=m12').catch(() => {})
  }
  // ★ 语言切换后重挂导航。只重挂导航不重载页面 ——
  //   用户在地图页拖了半天缩放/勾了 DLC,切语言不该把这些状态全丢掉。
  if (!el._navLangWired) {
    el._navLangWired = true
    onLangChange(() => {
      if (document.body && document.body.contains(el)) renderNav(el)
      else mountNav(el, el._navOpts) // 已被换页时重新拿一次容器
    })
  }
}

/** 轻量高亮更新:iframe 切页后只改 .cur / .on,不整体重建导航(避免闪烁/瞬时空白) */
function updateNavActive(el) {
  const cur = curKey()
  el.querySelectorAll('.navlinks a[href]').forEach((a) => {
    const h = a.getAttribute('href')
    a.classList.toggle('cur', h === cur)
  })
  el.querySelectorAll('.navgrp').forEach((g) => {
    const on = g.querySelectorAll('a.cur').length > 0
    g.classList.toggle('on', on)
    const dot = g.querySelector('.curdot')
    if (dot) dot.style.display = on ? '' : 'none'
  })
}

function renderNav(el) {
  const cur = curKey()
  const inGroup = (g) => g.items.some((i) => i.href === cur)
  el.className = 'navlinks' + (el._navOpts && el._navOpts.dark ? ' on-dark' : '')
  el.innerHTML =
    `<a href="/" class="navhome${cur === '/' ? ' cur' : ''}" title="${ESC(t('app.home'))}" style="position:relative;z-index:300">` +
    `<span class="app-icon"></span>${ESC(t('app.name'))}</a>` +
    NAV_GROUPS.map((g) => {
      const on = inGroup(g)
      const gl = GROUP_KEY[g.label] ? t(GROUP_KEY[g.label]) : g.label
      // <details> 免 JS 下拉:点击展开、再次点击或点别处收起,键盘可达
      return (
        `<div class="navgrp${on ? ' on' : ''}">` +
        `<button type="button" class="navsum" title="${ESC(gl)}" aria-haspopup="true" aria-expanded="false">${ESC(gl)}${on ? '<i class="curdot"></i>' : ''}</button>` +
        `<div class="navpop">` +
        g.items
          .map((i) => {
            const k = I18N_KEY[i.href]
            const label = k ? t(k[0]) : i.label
            const desc = k ? t(k[1]) : i.desc
            return (
              `<a href="${i.href}" class="${i.href === cur ? 'cur' : ''}">` +
              `<b>${ESC(label)}</b><span>${ESC(desc)}</span></a>`
            )
          })
          .join('') +
        `</div></div>`
      )
    }).join('') +
    // ★ 语言切换按钮(2026-10-07 i18n)。放导航最右侧 —— 右上角,
    //   与"外观/全屏"同一层,任何页面都能直接换语言。
    //   ⚠ 按钮文字是「点了会切成什么」:中文界面显示 English,反过来显示 中文。
    //   这里只给**初始**值;之后每次切换由 i18n.applyI18n 统一写,
    //   避免两处各判一次产生两个语义不同的答案。
    `<button id="musicBtn" class="langbtn" type="button" title="${ESC(t('music.open'))}">` +
    `${tr('<span class="musico"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg></span>')}</button>` +
    `<button id="langBtn" class="langbtn" type="button" title="${ESC(t('app.langSwitch'))}">` +
    `${tr("<span class=\"langico\">文</span><span id=\"langValue\">")}${I18N && I18N.getLang() === 'en' ? '中文' : 'English'}</span></button>`

  // 导航分组下拉改为 hover/focus 展开(CSS 控制),无需「点外部收起」逻辑。
  // ★ 全屏按钮挂在导航区最前(FULLSCREEN_V1)。放在这里而不是各页单独写,
  //   是因为 nav.js 是 15 个页面唯一共有的入口 —— 写一次就全站生效。
  //   ⚠ 加载顺序:nav.js 是 type=module(默认 defer),而 fullscreen.js 是普通
  //   <script>,两者谁先执行取决于页面里的标签顺序,不能假定 Fullscreen 已存在。
  //   → 这里轮询等一小会儿(最多 2s);拿不到就算了,fullscreen.js 自己的
  //   DOMContentLoaded/立即执行分支也会 mount,两边幂等不会重复插按钮。
  // ★ 2026-10-09 下拉交互:悬停(CSS hover)与点击(.open)都能展开;
  //   鼠标脱离整个分组(含弹层)后收起 —— 满足「hover/点击可选,脱离即隐」。
  //   renderNav 每次重挂 innerHTML 后都会重新绑定,语言切换后同样有效。
  // MUSIC_V1: open floating player; lazy-load music.js if not yet mounted
  // ★ 2026-10-10 工作台入口强制导航:不依赖默认<a>导航。capture 最先触发,
  //   整页模式直接 location.href,壳内模式走 shellSwitch —— 鼠标点击必然回到工作台。
  const homeEl = el.querySelector('.navhome')
  if (homeEl) {
    homeEl.addEventListener('click', (ev) => {
      if (el._navOpts && el._navOpts.frame) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        document.querySelectorAll('.navgrp').forEach((g) => g.classList.remove('open'))
        if (window.shellSwitch) {
          window.shellSwitch('/home', '/home?v=20261010&frame=1')
          // 兜底：短暂后确认当前 iframe 确为主页，异常则整页跳转，绝不落到别的页
          setTimeout(() => {
            try {
              const vis = document.querySelector('#content iframe.on')
              const p = vis && vis.contentWindow && vis.contentWindow.location ? vis.contentWindow.location.pathname : ''
              if (p && p !== '/home' && p !== '/') location.href = '/'
            } catch (e) {}
          }, 180)
        } else location.href = '/home?v=20261010&frame=1'
      } else {
        ev.stopImmediatePropagation()
      }
    }, true)
  }
  const mb = el.querySelector('#musicBtn')
  // MUSIC: 导航音乐按钮切换(toggle) — 隐藏时显示,显示时隐藏;
  // 之前用 show() 总是显示,导致已显示后点击无法关闭
  if (mb) mb.addEventListener('click', () => {
    if (window.MusicUI) { window.MusicUI.toggle(); return }
    import('./music.js?v=m12').then((m) => { if (window.MusicUI) window.MusicUI.toggle() }).catch(() => {})
  })

  el.querySelectorAll('.navgrp').forEach((g) => {
    const btn = g.querySelector('.navsum')
    if (!btn) return
    btn.addEventListener('click', (ev) => { ev.preventDefault(); g.classList.toggle('open') })
    g.addEventListener('mouseleave', () => g.classList.remove('open'))
  })

  let fsTries = 0
  const tryFs = () => {
    if (globalThis.Fullscreen) { globalThis.Fullscreen.mount(); return }
    if (++fsTries < 40) setTimeout(tryFs, 50)
  }
  // ★ 统一外壳:点击导航项 → 只切 iframe 内容,不整页跳转(壳永不重建,音乐/导航保持)
  if (el._navOpts && el._navOpts.frame) {
    el.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault()
        const href = a.getAttribute('href')
        if (!href || href === '#' || href === '' || /^javascript:/i.test(href)) return
        const tgt = href === '/' ? '/home' : href
        const key = tgt.replace(/\.html?$/, '') || '/'
        const doSwitch = () => {
          if (window.shellGo) window.shellGo(href)
          else location.href = tgt
        }
        /* ★★ 响应性优先(2026-10-10):【先切页,再决定要不要挂遮罩】。
         * 旧逻辑是 BootGate.ensure(doSwitch) —— 把"切页"串行依赖在
         * /api/status 的返回之后。而后端重构建期间该请求会排队:
         * 实测符号库阶段 88 秒,期间 /api/status 连续 5 秒超时无响应
         * → ensure 的回调几十秒不来 → 用户点了导航【完全没反应】
         *   (页面都不切,连加载画面都没有),表现为"一段时间内点不动"。
         * 切页本身是纯前端动作,没必要等后端;页面进去后各自的 api()
         * 有 busy 重试 + 进度条,反馈更准确。 */
        doSwitch()
        // 只让遮罩"看着办":后端没就绪就挂上,不参与切页决策
        if (window.BootGate && window.BootGate.watch) window.BootGate.watch()
      })
    })
  }
  tryFs()
}

/* ══════════════════════════════════════════════════════════════════
 * 左侧导航栏 —— 顶栏之外的第二入口,窄屏/长页面下更易跳转。
 * ⚠ 2026-10-05 起 mountNav() 不再自动调用它(用户要求"只有总导航栏"),
 *   保留导出供个别页面按需启用。
 * ══════════════════════════════════════════════════════════════════ */
const SIDE_KEY = 'hoi4.side.collapsed'
let sideInjected = false

export function mountSide(variant = 'light', title = '导航') {
  if (sideInjected) return
  if (!document.body) return
  sideInjected = true

  const collapsed = localStorage.getItem(SIDE_KEY) === '1'
  const rail = document.createElement('nav')
  rail.id = 'siderail'
  rail.className = (variant === 'dark' ? 'on-dark ' : '') + (collapsed ? 'collapsed' : '')
  rail.innerHTML =
    `<button class="side-toggle" title="折叠/展开导航" aria-label="折叠或展开导航">☰</button>` +
    `<div class="side-title">${ESC(title)}</div>` +
    `<div class="side-links">` +
    NAV_FLAT.map((p) => {
      const full = p.label
      return `<a href="${p.href}" class="${p.href === curKey() ? 'cur' : ''}" title="${ESC(p.group)} · ${ESC(full)}" data-full="${ESC(full)}" data-i="${ESC(full.slice(0, 1))}">${ESC(full)}</a>`
    }).join('') +
    `</div>`

  document.body.appendChild(rail)
  const applyPad = () => {
    document.body.classList.add('has-siderail')
    document.body.classList.toggle('siderail-collapsed', rail.classList.contains('collapsed'))
  }
  applyPad()
  rail.querySelector('.side-toggle').addEventListener('click', () => {
    rail.classList.toggle('collapsed')
    localStorage.setItem(SIDE_KEY, rail.classList.contains('collapsed') ? '1' : '0')
    applyPad()
  })
}

/* ══════════════════════════════════════════════════════════════════
 * 壳内子页(frame=1)辅助:语言联动 + 内部链接保持 frame 模式。
 * 语言:壳 setLang 写 localStorage 'gui.lang',iframe 子窗口收到 storage
 *   事件后就地 setLang 应用新语言(iframe 与壳是两个 window,storage 跨窗口触发)。
 * 内部链接:子页里的卡片/链接跳转到其他工作台页面时,保持 ?frame=1 在 iframe
 *   内导航(避免子页整页跳转后重复渲染导航),壳 iframe load 再刷新导航高亮。
 * ══════════════════════════════════════════════════════════════════ */
function wireFrameLang() {
  if (window.__frameLangWired) return
  window.__frameLangWired = true
  window.addEventListener('storage', (e) => {
    if (e.key === 'gui.lang' && window.I18N && window.I18N.setLang) {
      const v = e.newValue
      if (v === 'zh' || v === 'en') window.I18N.setLang(v)
    }
  })
}

function wireFrameLinks() {
  if (window.__frameLinksWired) return
  window.__frameLinksWired = true
  /* ★ 2026-10-11 统一跳转:iframe 内所有内部链接走父壳的 shellGo,
   * 复用预取池 + 显示加载遮罩,与顶部导航栏完全一致(不再直接 location.href 卡白屏)。 */
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null
    if (!a) return
    const href = a.getAttribute('href')
    if (!href || href === '#' || href === '' || /^javascript:/i.test(href)) return
    if (a.target && String(a.target).toLowerCase() === '_blank') return
    if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return
    ev.preventDefault()
    const p = window.parent
    if (p && p !== window && p.shellGo) p.shellGo(href)
    else if (window.shellGo) window.shellGo(href)
    else {
      const base = href.split('#')[0] || href
      const tgt = base === '/' ? '/home' : base
      location.href = tgt + (tgt.indexOf('?') >= 0 ? '&' : '?') + 'frame=1'
    }
  })
}
