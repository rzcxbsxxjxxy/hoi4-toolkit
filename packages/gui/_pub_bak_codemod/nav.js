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
  '/designer': ['nav.designer', 'nav.designer.desc'],
  '/create': ['nav.create', 'nav.create.desc'],
  '/ide': ['nav.ide', 'nav.ide.desc'],
  '/ref': ['nav.ref', 'nav.ref.desc'],
  '/commondocs': ['nav.commondocs', 'nav.commondocs.desc'],
  '/loc': ['nav.loc', 'nav.loc.desc'],
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
      { href: '/dlc', label: 'DLC 内容', desc: '军工机构 · 工程 · 阵营' },
      { href: '/worldmap', label: '世界地图', desc: '多来源合成 · 省份归属' },
      { href: '/modrel', label: '模组关系', desc: '依赖图 · replace_path' },
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
      { href: '/check', label: '体检', desc: '语法 · 悬空引用' },
      { href: '/open.html', label: '打开工程', desc: '挂游戏目录 / 模组' },
      { href: '/docs', label: '使用教程', desc: '上手 · 概念 · 常见问题' },
      { href: '/settings', label: '设置', desc: '主题 · 来源 · 背景' },
    ],
  },
]

/** 扁平化,便于 curKey / mountSide 复用 */
const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })))

/** 当前页路径 → 归一化(/focus.html 与 /focus 算同一个) */
function curKey() {
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
export function mountNav(host, opts) {
  // 外观先套用:深色主题必须在渲染导航前生效,否则会看到一帧白底闪烁
  applyAppearance()
  const el = typeof host === 'string' ? document.querySelector(host) : host
  if (!el) return
  el.dataset.navHost = '1'
  el._navOpts = opts
  renderNav(el)
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

function renderNav(el) {
  const cur = curKey()
  const inGroup = (g) => g.items.some((i) => i.href === cur)
  el.className = 'navlinks' + (el._navOpts && el._navOpts.dark ? ' on-dark' : '')
  el.innerHTML =
    `<a href="/" class="navhome${cur === '/' ? ' cur' : ''}" title="${ESC(t('app.home'))}">` +
    `<span class="app-icon"></span>${ESC(t('app.name'))}</a>` +
    NAV_GROUPS.map((g) => {
      const on = inGroup(g)
      const gl = GROUP_KEY[g.label] ? t(GROUP_KEY[g.label]) : g.label
      // <details> 免 JS 下拉:点击展开、再次点击或点别处收起,键盘可达
      return (
        `<details class="navgrp${on ? ' on' : ''}">` +
        `<summary title="${ESC(gl)}">${ESC(gl)}${on ? '<i class="curdot"></i>' : ''}</summary>` +
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
        `</div></details>`
      )
    }).join('') +
    // ★ 语言切换按钮(2026-10-07 i18n)。放导航最右侧 —— 右上角,
    //   与"外观/全屏"同一层,任何页面都能直接换语言。
    //   ⚠ 按钮文字是「点了会切成什么」:中文界面显示 English,反过来显示 中文。
    //   这里只给**初始**值;之后每次切换由 i18n.applyI18n 统一写,
    //   避免两处各判一次产生两个语义不同的答案。
    `<button id="langBtn" class="langbtn" type="button" title="${ESC(t('app.langSwitch'))}">` +
    `<span class="langico">文</span><span id="langValue">${I18N && I18N.getLang() === 'en' ? '中文' : 'English'}</span></button>`

  // 点菜单外任意处收起所有下拉
  if (!el.dataset.navWired) {
    el.dataset.navWired = '1'
    document.addEventListener('click', (e) => {
      if (el.contains(e.target)) return
      for (const d of el.querySelectorAll('details.navgrp[open]')) d.open = false
    })
  }
  // ★ 全屏按钮挂在导航区最前(FULLSCREEN_V1)。放在这里而不是各页单独写,
  //   是因为 nav.js 是 15 个页面唯一共有的入口 —— 写一次就全站生效。
  //   ⚠ 加载顺序:nav.js 是 type=module(默认 defer),而 fullscreen.js 是普通
  //   <script>,两者谁先执行取决于页面里的标签顺序,不能假定 Fullscreen 已存在。
  //   → 这里轮询等一小会儿(最多 2s);拿不到就算了,fullscreen.js 自己的
  //   DOMContentLoaded/立即执行分支也会 mount,两边幂等不会重复插按钮。
  let fsTries = 0
  const tryFs = () => {
    if (globalThis.Fullscreen) { globalThis.Fullscreen.mount(); return }
    if (++fsTries < 40) setTimeout(tryFs, 50)
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
