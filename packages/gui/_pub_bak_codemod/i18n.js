/* ══════════════════════════════════════════════════════════════════
 * i18n —— 全站中英双语 (2026-10-07, V2 覆盖率版)
 *
 * ── 加载方式:必须用经典 <script src="/i18n.js">,不能用 type=module ──
 *   原因:全站页面脚本执行顺序是 —— 经典脚本按标签顺序立即执行,
 *   module 脚本 defer 到 DOMContentLoaded。而绝大多数页面脚本
 *   (worldmap.js / settings.js / defines.js …)都是经典脚本,
 *   它们执行时 module 版 i18n 还没跑,window.I18N 是 undefined。
 *
 * ── V2 架构:两套键,各管一类 ──
 *   1) 语义键 ('nav.focus' / 'app.save') —— 用于 HTML 里显式标记
 *      <span data-i18n="nav.focus">。可读性好、改文案不影响代码。
 *   2) ★ 原文键 ('来源:' / '保存')—— 用于运行时替换。
 *      V1 只做了第1 套,全站 2074 条文案里只落地了几十条,
 *      其余全是硬编码中文,英文模式下混排 —— 这正是 V2 要解决的。
 *      原文键的好处:**零改调用点**。2074 处硬编码文案不必逐个包t(),
 *      由 translateElement() 在渲染后按"文本节点原文"查表替换。
 *
 * ── 为什么不能"遍历文本节点查表"就完事(★V1 的错误认知)──
 *   ① 数据键污染:游戏数据里的中文(focus 名/决议名)也会被查表替换,
 *      把用户自己的模组内容翻译掉 —— 这是数据损坏,不是显示问题。
 *      → 解法:只替换「在字典里登记过的」原文,且DOM 上标记
 *        data-no-i18n 的子树整棵跳过(游戏数据容器都加这个标记)。
 *   ② 一份原文多处差异:'来源' 和 '来源:' 是两个键;带不带句号
 *      都要单独登记。字典以**精确原文**为键,天然不会串台。
 *   ③ 插值串无法整串匹配:'共 12 条' 里的数字是运行时的,
 *      原文对不上 → 这类必须源码里包 t(),由 codemod 完成,
 *      不能靠 DOM 替换(见 t())。
 *
 * ── 哨兵值白名单(SENTINELS)──
 *   '(匿名)' / '(多 DLC)' / '游戏本体' 这类中文是**数据键**:
 *   拿去做=== 比较、和接口返回值配对。翻译它们 = 功能直接坏掉。
 *   审计测试会强制它们永不出现在字典里。
 * ══════════════════════════════════════════════════════════════════ */

const LS_KEY = 'gui.lang'

/** 当前语言:'zh' | 'en' */
let LANG = (() => {
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    /* 隐私模式 localStorage 会抛 */
  }
  const nav = (navigator.language || '').toLowerCase()
  if (nav.startsWith('zh')) return 'zh'
  if (nav.startsWith('en')) return 'en'
  return 'zh'
})()

/* ──────────────────────────────────────────────────────────────
 * 哨兵值:中文但不是文案,是数据。**永不翻译**。
 * 来源:审计 public/*.js 里所有含中文的 === / !== 比较得出。
 * ────────────────────────────────────────────────────────────── */
const SENTINELS = new Set([
  '(匿名)',
  '(多 DLC)',
  '游戏本体',
  '基础游戏',   // 源标签,仅作 key 用;显示走 t()
])

/**
 * ★ 数据区标记:这些子树内的文本是**用户模组/游戏数据**,不是工作台 UI。
 *   例如 focus 名 "机动部队" 是模组作者写的内容,不是我们的界面文案。
 *   runtime 替换必须跳过,否则会把用户内容擅自翻译。
 *   JS 在渲染游戏数据时给容器加 data-no-i18n,HTML 静态区由 audit 补。
 */
const NO_I18N_ATTR = 'data-no-i18n'

/* ──────────────────────────────────────────────────────────────
 * 语义键字典 (V1 保留)
 * ────────────────────────────────────────────────────────────── */
const DICT = {
  /* ── 应用 / 通用 ── */
  'app.name': { zh: '工作台', en: 'Workbench' },
  'app.home': { zh: '返回工作台', en: 'Back to workbench' },
  'app.lang': { zh: '语言', en: 'Language' },
  'app.langSwitch': { zh: '切换到英文', en: 'Switch to Chinese' },
  'app.loading': { zh: '加载中…', en: 'Loading…' },
  'app.building': { zh: '构建中…', en: 'Building…' },
  'app.empty': { zh: '暂无内容', en: 'Nothing here yet' },
  'app.error': { zh: '出错了', en: 'Error' },
  'app.retry': { zh: '重试', en: 'Retry' },
  'app.save': { zh: '保存', en: 'Save' },
  'app.cancel': { zh: '取消', en: 'Cancel' },
  'app.close': { zh: '关闭', en: 'Close' },
  'app.reset': { zh: '恢复默认', en: 'Reset to defaults' },
  'app.search': { zh: '搜索', en: 'Search' },
  'app.level': { zh: '级', en: 'lvl' },
  'app.seconds': { zh: '秒', en: 's' },
  'app.tutorial': { zh: '教程', en: 'Guide' },
  'app.settings': { zh: '设置', en: 'Settings' },

  /* ── 导航分组 ── */
  'nav.grpContent': { zh: '内容', en: 'Content' },
  'nav.grpUi': { zh: '界面', en: 'Interface' },
  'nav.grpDocs': { zh: '文档', en: 'Reference' },
  'nav.grpTools': { zh: '工具', en: 'Tools' },

  /* ── 导航项 ── */
  'nav.focus': { zh: '国策树', en: 'National Focus' },
  'nav.focus.desc': { zh: '来源 · 坐标 · 体检', en: 'Source · Position · Audit' },
  'nav.tech': { zh: '科技树', en: 'Technology Tree' },
  'nav.tech.desc': { zh: '两级分类 · 隐藏科技', en: 'Two tiers · Hidden tech' },
  'nav.doctrines': { zh: '学说系统', en: 'Doctrines' },
  'nav.doctrines.desc': { zh: '页签 · 轨道 · 分支', en: 'Tabs · Tracks · Branches' },
  'nav.defines': { zh: '平衡参数', en: 'Defines' },
  'nav.defines.desc': { zh: 'defines.lua · 官方注释', en: 'defines.lua · Vanilla notes' },
  'nav.decisions': { zh: '决议树', en: 'Decisions' },
  'nav.decisions.desc': { zh: '类别卡片墙', en: 'Category cards' },
  'nav.events': { zh: '事件', en: 'Events' },
  'nav.events.desc': { zh: '触发条件 · 效果', en: 'Triggers · Effects' },
  'nav.aibehave': { zh: 'AI 行为', en: 'AI Behaviour' },
  'nav.aibehave.desc': { zh: 'common/ai_* · 逐文件归纳', en: 'common/ai_* · Per-file' },
  'nav.dlc': { zh: 'DLC 内容', en: 'DLC Content' },
  'nav.dlc.desc': { zh: '军工机构 · 工程 · 阵营', en: 'Agencies · Projects · Factions' },
  'nav.worldmap': { zh: '世界地图', en: 'World Map' },
  'nav.worldmap.desc': { zh: '多来源合成 · 省份归属', en: 'Multi-source · Province owners' },
  'nav.modrel': { zh: '模组关系', en: 'Mod Relations' },
  'nav.modrel.desc': { zh: '依赖图 · replace_path', en: 'Dependency graph · replace_path' },
  'nav.designer': { zh: '所见即所得', en: 'Visual Editor' },
  'nav.designer.desc': { zh: '元素树 · 属性 · 回写', en: 'Element tree · Props · Write-back' },
  'nav.create': { zh: '内容生成', en: 'Content Editor' },
  'nav.create.desc': { zh: '表单产出规范文件', en: 'Form → spec-compliant file' },
  'nav.ide': { zh: '代码 IDE', en: 'Code IDE' },
  'nav.ide.desc': { zh: '高亮 · 大纲 · 跳转', en: 'Highlight · Outline · Jump' },
  'nav.ref': { zh: '官方手册', en: 'Official Manual' },
  'nav.ref.desc': { zh: 'effects / triggers', en: 'effects / triggers' },
  'nav.commondocs': { zh: 'common 文档', en: 'common Reference' },
  'nav.commondocs.desc': { zh: '按文件夹索引', en: 'Indexed by folder' },
  'nav.loc': { zh: '本地化', en: 'Localisation' },
  'nav.loc.desc': { zh: '缺失 · 覆盖链', en: 'Missing · Override chain' },
  'nav.check': { zh: '体检', en: 'Validator' },
  'nav.check.desc': { zh: '语法 · 悬空引用', en: 'Syntax · Dangling refs' },
  'nav.open': { zh: '打开工程', en: 'Open Project' },
  'nav.open.desc': { zh: '挂游戏目录 / 模组', en: 'Mount game / mods' },
  'nav.docs': { zh: '使用教程', en: 'Guide' },
  'nav.docs.desc': { zh: '上手 · 概念 · 常见问题', en: 'Basics · Concepts · FAQ' },
  'nav.settings.desc': { zh: '主题 · 来源 · 背景', en: 'Theme · Sources · Background' },

  /* ── 主页 ── */
  'home.h1': { zh: 'HOI4 模组工作台', en: 'HOI4 Mod Workbench' },
  'home.sub': { zh: '解析、检查、编辑你的模组 —— 全部在本机完成', en: 'Parse, audit and edit your mod — all on your machine' },
  'home.group.content': { zh: '内容', en: 'Content' },
  'home.group.ui': { zh: '界面', en: 'Interface' },
  'home.group.doc': { zh: '文档', en: 'Reference' },
  'home.group.tool': { zh: '工具', en: 'Tools' },

  /* ── 壁纸调节 ── */
  'tune.title': { zh: '壁纸半透明', en: 'Wallpaper translucency' },
  'tune.glass': { zh: '面板玻璃度', en: 'Panel opacity' },
  'tune.dim': { zh: '壁纸压暗', en: 'Wallpaper dim' },
  'tune.blur': { zh: '壁纸模糊', en: 'Wallpaper blur' },
  'tune.themeDefault': { zh: '主题默认', en: 'Theme default' },
  'tune.note': { zh: '玻璃度越低越能看清壁纸，越高原文字越清晰。', en: 'Lower panel opacity shows more wallpaper; higher keeps text crisp.' },

  /* ── 世界地图 ── */
  'wm.legend': { zh: '归属国家', en: 'Province owners' },
  'wm.srcVanilla': { zh: '原版定义', en: 'Vanilla' },
  'wm.srcOverride': { zh: '模组覆盖', en: 'Mod override' },
  'wm.srcNew': { zh: '模组新增', en: 'Mod added' },
  'wm.dlc': { zh: 'DLC', en: 'DLC' },
  'wm.province': { zh: '省份', en: 'Province' },
  'wm.owner': { zh: '归属', en: 'Owner' },
  'wm.source': { zh: '来源', en: 'Source' },
  'wm.manpower': { zh: '人力', en: 'Manpower' },
  'wm.stateCat': { zh: '类型', en: 'Category' },
  'wm.supplies': { zh: '本地补给', en: 'Local supplies' },
  'wm.resources': { zh: '资源', en: 'Resources' },
  'wm.cores': { zh: '核心国', en: 'Cores' },
  'wm.vp': { zh: '胜利点', en: 'Victory points' },
  'wm.buildings': { zh: '建筑', en: 'Buildings' },
  'wm.unowned': { zh: '无归属（海洋/湖泊/空地）', en: 'Unowned (sea / lake / empty)' },
  'wm.needsDlc': { zh: '需', en: 'Needs' },
  'wm.dlcOn': { zh: '已启用', en: 'enabled' },
  'wm.assets': { zh: '地图资产', en: 'Map assets' },
  'wm.droppedByReplace': { zh: '被 replace_path 丢弃', en: 'dropped by replace_path' },
  'wm.coord': { zh: '坐标', en: 'Coordinates' },
  'wm.buildingModel': { zh: '正在合成世界地图…', en: 'Building world map…' },
  'wm.buildFailed': { zh: '世界地图构建失败', en: 'World map build failed' },
  'wm.rebuilding': { zh: '正在按 DLC 重算地图归属…', en: 'Recomputing map ownership…' },

  /* ── defines 差异 ── */
  'df.diffBtn': { zh: '原版 vs 模组', en: 'Vanilla vs Mod' },
  'df.base': { zh: '原版', en: 'Vanilla' },
  'df.mod': { zh: '模组', en: 'Mod' },
  'df.delta': { zh: '差值', en: 'Delta' },
  'df.src': { zh: '来源', en: 'Source' },
  'df.changed': { zh: '真改动', en: 'Changed' },
  'df.same': { zh: '同值重写', en: 'Same value' },
  'df.added': { zh: '模组新增', en: 'Added by mod' },
  'df.all': { zh: '全部', en: 'All' },
}

/* ──────────────────────────────────────────────────────────────
 * ★ 原文键字典 (V2):精确中文原文 → 英文
 *
 * 加载顺序:i18n.js 先定义机制,再由 /i18n-dict.js 调registerDict() 注入。
 * 分文件的原因:2074 条译文体量远超 i18n.js 本身该承担的范围,
 * 拆开才能按域维护/审校。缺哪个文件 → console.warn,不会静默。
 * ────────────────────────────────────────────────────────────── */
const BY_TEXT = new Map()

/** 注入原文键字典。zh 侧就是键本身,只需给 en。 */
function registerDict(obj) {
  if (!obj || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string') BY_TEXT.set(k, obj[k])
  }
}

/** t —— 两种模式:
 *  t('nav.focus')          语义键(HTML data-i18n 用)
 *  t('来源:')              原文键(JS 里包插值用,读的是 BY_TEXT) */
function t(key) {
  if (key == null) return ''
  const k = String(key)
  if (DICT[key]) return LANG === 'en' ? DICT[key].en : DICT[key].zh
  if (BY_TEXT.has(k)) return LANG === 'en' ? BY_TEXT.get(k) : k
  if (typeof console !== 'undefined') {
    // 一次只warn 一次同一个键,免得刷屏
    if (!t._warned) t._warned = new Set()
    if (!t._warned.has(k)) {
      t._warned.add(k)
      console.warn('[i18n] 缺翻译:', k)
    }
  }
  return k
}

/** 字典是否收录(审计测试用)。哨兵值永远返回 false。 */
function hasDict(key) {
  if (SENTINELS.has(key)) return false
  return !!DICT[key] || BY_TEXT.has(key)
}

function getLang() {
  return LANG
}

const listeners = new Set()

/** 注册语言变化回调。返回反注册函数。 */
function onLangChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setLang(lang, opts) {
  if (lang !== 'zh' && lang !== 'en') return
  const same = lang === LANG
  LANG = lang
  if (!opts || opts.persist !== false) {
    try {
      localStorage.setItem(LS_KEY, lang)
    } catch {
      /* 隐私模式 */
    }
  }
  applyI18n()
  for (const fn of listeners) {
    try {
      fn(lang)
    } catch (e) {
      console.error('[i18n] 回调出错', e)
    }
  }
  if (!same) document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN')
}

function toggleLang() {
  setLang(LANG === 'zh' ? 'en' : 'zh')
}

/* ──────────────────────────────────────────────────────────────
 * ★ 运行时原文替换
 *
 * 只替换「字典里登记过的精确原文」。这保证:
 *   - 模组作者自己写的中文(focus 名等)不会被翻译 —— 没登记就不动
 *   - 漏翻的地方保持中文,审计测试会报出来
 * ────────────────────────────────────────────────────────────── */

/** 反查:英文 → 中文(切回中文时需要)。懒建,不落盘。
 *  一对多(两个中文原文译成同一英文)时保留首个,避免切回中文时来回抖动。 */
let BY_EN = null
function reverseMap() {
  if (BY_EN) return BY_EN
  const m = new Map()
  for (const [zh, en] of BY_TEXT) if (!m.has(en)) m.set(en, zh)
  BY_EN = m
  return m
}

/**
 * ★★ 关于"运行期拼接的句子"(实测踩过的坑,别再走一遍)
 *
 * 源码写的是 '全部 (' + n + ' 树)',DOM 里的文本节点是
 * "全部 (271 树)" —— 整串匹配不到字典任何键,英文界面里会冒出
 * "271 树" 这种半中半英。(实测 tech/doctrines 各 85~170 处。)
 *
 * ★ 试过"片段级替换"(建一张量词表,对文本节点做 replaceAll):
 *   **失败,已回退。** 中文没有词边界,子串替换必然切错:
 *     '模组'→'mod'  把 "次要学说" 变成 "minor doctrines" 又把
 *                 "mod" 塞进 "Parsing"、造出 "AllSource"
 *     '国策'→'focuses' 让 "国策树" 变 "focuses树"
 *     ' 个'→''    "共 26882事件" 数字与文字粘连
 *   片段越长越会误伤短词,越短越会误伤长句 —— 没有安全的粒度。
 *
 * ★ 正确解法是**在源码里把插值片段包进t()**:
 *     '全部 (' + t('共 {n} 树') + ')'
 *   即 codemod 改造那~400 处插值点(见 _i18n_codemod)。
 *   在那之前,这些句子保持中文是正确的取舍:
 *   **宁可留中文,不可译错** —— 错译会改变语义、误导用户。
 * ────────────────────────────────────────────────────────────── */

/** 文本节点替换。返回是否改动了。 */
function translateTextNode(node) {
  const raw = node.nodeValue
  if (!raw) return false
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (SENTINELS.has(trimmed)) return false

  const lead = raw.slice(0, raw.length - raw.trimStart().length)
  const tail = raw.slice(raw.trimEnd().length)

  if (LANG === 'en') {
    // 只做整串精确命中。见上方说明:片段替换已验证不可用。
    const en = BY_TEXT.get(trimmed)
    if (en === undefined || en === trimmed) return false
    node.nodeValue = lead + en + tail
    return true
  }

  // 切回中文:整串反查
  const zh = reverseMap().get(trimmed)
  if (zh === undefined || zh === trimmed) return false
  node.nodeValue = lead + zh + tail
  return true
}

/** 属性替换(title / placeholder / alt / aria-label / label)。
 *  ★ 绝不动 value —— 那是用户输入/正在编辑的内容,翻了会丢字。 */
const I18N_ATTRS = ['title', 'placeholder', 'alt', 'aria-label', 'label']
function translateAttrs(el) {
  if (LANG !== 'en') return
  for (const a of I18N_ATTRS) {
    if (!el.hasAttribute(a)) continue
    const v = el.getAttribute(a)
    if (SENTINELS.has(v)) continue
    const en = BY_TEXT.get(v)
    if (en && en !== v) el.setAttribute(a, en)
  }
}

/**
 * 替换一棵子树里的文案。
 *
 * ★ 跳过规则(顺序不能变):
 *   1. data-no-i18n 子树  → 用户模组数据,绝不翻
 *   2. SENTINELS 原文     → 数据键
 *   3. <script>/<style>/<code>/<pre> → 不是显示文案
 *   4. textarea / input[value] → 用户可编辑,翻了会丢内容
 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA'])

/**
 * 子树是否整棵跳过。
 *
 * ★ INPUT 的处置是个真实的取舍,不是笔误:
 *   input 没有子节点,所以"跳过子树"对它本来毫无影响 ——
 *   真正要防的是**它的 value**:翻了用户正在编辑的内容会丢字。
 *   而 title / placeholder 是纯 UI 提示,必须翻。
 *   → 因此 input 不进跳过名单,改为在 translateAttrs 里
 *     显式跳过 value(见下)。桩测专门盯这条。
 */
function isSkipped(el) {
  const tag = el.tagName
  if (SKIP_TAGS.has(tag)) return true
  if (el.hasAttribute(NO_I18N_ATTR)) return true
  if (el.isContentEditable) return true
  return false
}

/**
 * 替换一棵子树里的文案。
 *
 * ★ 跳过规则(前序剪枝,命中即return,不再下探):
 *   1. data-no-i18n 子树  → 用户模组数据,绝不翻
 *   2. SCRIPT/STYLE/CODE/PRE/TEXTAREA/INPUT → 不是可显示/可编辑文案
 *   3. isContentEditable  → 用户正在编辑的内容,翻了会丢字
 *
 * 用递归而不是 TreeWalker:TreeWalker 没有"跳过整棵子树"的能力,
 * 只能 nextNode() 一路走过去 —— 既慢又没法提前退出。
 */
function translateElement(root) {
  if (!root) return 0
  let n = 0

  const walk = (node) => {
    // childNodes 是活集合,一边改 nodeValue 一边遍历是安全的
    // (只改文本节点的值,不改结构),但为稳妥先取快照。
    const kids = node.childNodes
    for (let i = 0; i < kids.length; i++) {
      const cur = kids[i]
      if (cur.nodeType === 3) {
        if (translateTextNode(cur)) n++
      } else if (cur.nodeType === 1) {
        if (isSkipped(cur)) continue
        translateAttrs(cur)
        walk(cur)
      }
    }
  }

  if (root.nodeType === 3) {
    if (translateTextNode(root)) n++
    return n
  }
  if (root.nodeType === 1) {
    if (isSkipped(root)) return 0
    translateAttrs(root)
    walk(root)
  }
  return n
}

/**
 * 就地替换 DOM 里的文案。
 *
 * 两种标记:
 *   <span data-i18n="nav.focus">国策树</span>        → 语义键
 *   <input placeholder data-i18n-ph="app.search">→ 语义键
 * 加上 V2 的原文替换:字典登记过的中文文本节点 → 英文。
 */
function applyI18n(root) {
  const host = root || document
  for (const el of host.querySelectorAll('[data-i18n]')) {
    const k = el.getAttribute('data-i18n')
    const v = t(k)
    if (v !== k) el.textContent = v
  }
  for (const el of host.querySelectorAll('[data-i18n-ph]')) {
    const v = t(el.getAttribute('data-i18n-ph'))
    if (v) el.placeholder = v
  }
  for (const el of host.querySelectorAll('[data-i18n-title]')) {
    const v = t(el.getAttribute('data-i18n-title'))
    if (v) el.title = v
  }
  /* 语言按钮:显示的是「点了会切成什么」 */
  const lv = document.getElementById('langValue')
  if (lv) lv.textContent = LANG === 'zh' ? 'English' : '中文'
  /* ★ V2:原文替换 */
  if (typeof document !== 'undefined' && document.body) translateElement(document.body)
  wireLangBtn()
}

/* ──────────────────────────────────────────────────────────────
 * 语言按钮:事件委托
 *  ★ nav.js 每次切语言都 renderNav(),innerHTML 重建整个导航,
 *    直接绑按钮的话第二次点就失效(显示还被改对,像"只能切一次")。
 * ────────────────────────────────────────────────────────────── */
let delegWired = false
function wireLangBtn() {
  if (delegWired || typeof document === 'undefined') return
  delegWired = true
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#langBtn')
    if (btn) {
      e.preventDefault()
      toggleLang()
    }
  })
}

/** 页面初始化:设 <html lang> + 就地替换 + 挂切换按钮 */
function initI18n() {
  document.documentElement.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-CN')
  applyI18n() // 内含 wireLangBtn()
  wireObserver()
}

/**
 * ★ MutationObserver:页面异步渲染的内容(国策树、科技树拉完才 paint)
 * 不会经过 applyI18n,必须在 DOM 变化后补一次替换。
 *
 * 用 requestAnimationFrame 合并:一次渲染往往触发几十次 mutation,
 * 逐个跑 translateElement 会明显卡顿。
 */
let obsWired = false
function wireObserver() {
  if (obsWired || typeof MutationObserver === 'undefined') return
  obsWired = true
  let queued = false
  const mo = new MutationObserver((muts) => {
    if (LANG !== 'en') return
    // 只关心有中文文本的变动
    let need = false
    for (const m of muts) {
      if (m.type === 'characterData') {
        need = true
        break
      }
      for (const nd of m.addedNodes) {
        if (nd.nodeType === 3) {
          if (/[一-龥]/.test(nd.nodeValue || '')) {
            need = true
            break
          }
        } else if (nd.nodeType === 1 && nd.textContent && /[一-龥]/.test(nd.textContent)) {
          need = true
          break
        }
      }
      if (need) break
    }
    if (!need || queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (LANG === 'en') translateElement(document.body)
    })
  })
  mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  window.__i18nObserver = mo
}

/** 供审计测试/控制台调用 */
const I18N = {
  t,
  setLang,
  getLang,
  toggleLang,
  onLangChange,
  applyI18n,
  initI18n,
  registerDict,
  hasDict,
  translateElement,
  dictSize: () => BY_TEXT.size,
  semanticSize: () => Object.keys(DICT).length,
  sentinels: SENTINELS,
}
if (typeof window !== 'undefined') {
  window.I18N = I18N

  /* ──────────────────────────────────────────────────────────────
   * tr() —— 全局短别名,专供 codemod 包裹插值片段用。
   *
   * 为什么单独开一个短名(而不是让 653 处调用点 import { t }):
   *   ① 这些文件绝大多数是 **经典脚本**(非 module),根本没有 import;
   *      i18n.js 也是经典脚本,挂 window 是唯一能让两者通信的方式。
   *   ② `tr` 两字符 vs `I18N.t(...)` 十字符 —— 653 处包裹后
   *      可读性差别很明显(尤其在模板字符串里)。
   *   ③ 名字必须**全站未被占用**:codemod 会把它插进 29 个文件,
   *      若某个文件已有顶层 `tr` 标识符就会 SyntaxError,
   *      而那会让整页脚本不执行(极隐蔽)。已 grep 确认全站未占用。
   *
   * 语义与 t() 完全相同(同一函数),只是名字短。
   * ────────────────────────────────────────────────────────────── */
  window.tr = t

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initI18n)
  else initI18n()
}
/* ★ 本文件**绝不能有 export**。
 *   它用经典 <script src> 加载(必须如此,见文件头说明),
 *   而 export 只在 ES module 里合法 —— 经典脚本里出现 export,
 *   浏览器直接抛 SyntaxError 且**整个文件不执行**。
 *   症状极隐蔽:页面照常渲染、按钮照常能点,只是 window.I18N 是 undefined,
 *   所有文案静默退回硬编码中文,控制台才有红字。
 *   nav.js 从 window.I18N 取值(不是 import),所以这里不需要导出。
 *   (V2 重写时误加回来过一次,由 i18n.browser.test.cjs 的
 *    "window.I18N 挂上 / dictSize>=1800" 两条断言抓出来。) */
