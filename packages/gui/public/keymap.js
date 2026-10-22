/* ══════════════════════════════════════════════════════════════════
 * keymap.js —— 快捷键目录(全站唯一数据源,KEYMAP_V1)
 *
 * ★ 用户诉求:"将快捷键可在设置页面中设置"
 *
 * 根本难点不是"画个设置界面",而是**设置页要能看到所有快捷键**。
 * 各页的快捷键原本是页面加载时各自 Keys.bind() 注册的,设置页如果只看
 * 自己的运行时注册表,就只能看见设置页自己的键 —— 用户必须先逐页访问,
 * 那里改完还得回设置页刷新,体验不成立。
 *
 * 解法:把"有哪些动作、各自默认键位是什么"抽成本件这份**声明式目录**,
 * 三方都从它派生:
 *   keymap.js  目录 + 覆盖读写 + 冲突检测(本文件)
 *   keys.js    注册时读覆盖 → 用户改了就用用户的键
 *   settings   渲染成可录制表单
 * 页面代码只负责"这个动作做什么",不再自己写死键位。
 *
 * ── 动作 id 命名 ──
 *   <域>.<动作>  域 = global / find / view / sel / ide
 *   一个动作可作用于多个页(如「放大」focus 与 tech 都有)→ 改一次两页生效,
 *   这比按页各设一遍更符合直觉。
 *
 * ── 覆盖存储 ──
 *   localStorage['gui.keymap'] = { "<id>": "mod+g" | "" }
 *   ""  表示**显式禁用**(不是"没改过")。用 hasOwnProperty 区分。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  var LS = 'gui.keymap'

  /* 页面元数据(设置页按此顺序分组) */
  var PAGES = [
    { id: 'global', name: '全局', hint: '任何页面都生效' },
    { id: 'focus', name: '国策树', hint: '/focus' },
    { id: 'tech', name: '科技树', hint: '/tech' },
    { id: 'doctrines', name: '学说', hint: '/doctrines' },
    { id: 'ide', name: 'IDE 编辑器', hint: '/ide' },
    { id: 'defines', name: '平衡参数', hint: '/defines' },
  ]

  /* ── 动作目录 ──
   * pages: '*' = 全局(所有页都注册);数组 = 仅这些页注册
   * keys:  默认键位(可多个,任一命中即触发)
   * desc:  说明;可为 {page: 说明} 覆盖个别页的措辞
   * doc:   true = 页面自己用 document 级监听实现(与 keys.js 同义,
   *        这里只是备忘,真正的接管与否由页面传 opt.doc 决定)
   * scope: 'global' = 焦点在输入框里也生效
   */
  var ACTIONS = [
    /* 全局 */
    {
      id: 'global.sheet', pages: '*', group: '全局', scope: 'global',
      desc: '快捷键速查表', keys: ['f1', 'mod+k'],
    },
    {
      id: 'global.fullscreen', pages: '*', group: '全局', scope: 'global',
      // ⚠ 不用 F11:F11 是**浏览器**的进/退全屏键,抢它会让用户
      //   在本页面按 F11 却只全屏了网页、以为浏览器坏了。留给浏览器。
      desc: '全屏 / 退出全屏', keys: ['mod+enter'],
    },

    /* 查找 */
    {
      id: 'find.search', pages: ['focus', 'tech', 'doctrines', 'loc', 'decisions', 'events', 'ref', 'dlc', 'create', 'defines'],
      group: '查找',
      desc: '聚焦搜索框', keys: ['/', 'mod+f'],
    },

    /* 视图 */
    {
      id: 'view.fit', pages: ['focus', 'tech', 'designer'], group: '视图',
      desc: '缩放至适合窗口', keys: ['f'],
    },
    {
      id: 'view.zoomReset', pages: ['focus', 'tech', 'designer'], group: '视图',
      desc: '重置缩放 100%', keys: ['mod+0'],
    },
    {
      id: 'view.zoomIn', pages: ['focus', 'tech', 'designer'], group: '视图',
      desc: '放大', keys: ['+', '='],
    },
    {
      id: 'view.zoomOut', pages: ['focus', 'tech', 'designer'], group: '视图',
      desc: '缩小', keys: ['-'],
    },
    {
      id: 'view.toggleHidden', pages: ['tech'], group: '视图',
      desc: '切换隐藏科技的显示', keys: ['h'],
    },
    {
      id: 'view.foldCat', pages: ['tech'], group: '视图',
      desc: '折叠 / 展开分类栏(页签 · 领域)', keys: ['mod+b'],
    },
    {
      id: 'view.toggleTex', pages: ['designer'], group: '视图',
      desc: '切换贴图显示', keys: ['t'],
    },

    /* 选中 */
    {
      id: 'sel.copyId', pages: ['focus', 'tech', 'doctrines', 'loc', 'decisions', 'events', 'ref', 'dlc', 'designer', 'defines'],
      group: '选中',
      desc: {
        default: '复制选中项的 id',
        focus: '复制选中国策的 id',
        tech: '复制选中科技的 id',
        doctrines: '复制选中学说的 id',
        loc: '复制选中条目的本地化 key',
        decisions: '复制选中决议的 id',
        events: '复制选中事件的 id',
        ref: '复制选中条目的 id',
        dlc: '复制选中条目的 id',
        designer: '复制选中元素的 id',
      },
      keys: ['mod+c'],
    },
    {
      id: 'sel.menu', pages: ['focus', 'tech', 'doctrines', 'loc', 'decisions', 'events', 'ref', 'dlc', 'designer'],
      group: '选中',
      desc: {
        default: '对选中项打开右键菜单',
        focus: '对选中国策打开右键菜单',
        tech: '对选中科技打开右键菜单',
        doctrines: '对选中学说打开右键菜单',
        loc: '对选中译文打开右键菜单',
        decisions: '对选中决议打开右键菜单',
        events: '对选中事件打开右键菜单',
        ref: '对选中条目打开右键菜单',
        dlc: '对选中条目打开右键菜单',
        designer: '对选中元素打开右键菜单',
      },
      keys: ['shift+f10'],
    },
    {
      id: 'sel.clear', pages: ['focus', 'doctrines', 'events', 'ref', 'loc', 'designer', 'defines'], group: '选中',
      desc: '取消选择 / 清空筛选', keys: ['escape'],
    },

    /* 列表导航(vim 式,八页统一) */
    {
      id: 'nav.nextItem', pages: ['events', 'ref', 'loc', 'dlc'], group: '浏览',
      desc: '下一条', keys: ['j'],
    },
    {
      id: 'nav.prevItem', pages: ['events', 'ref', 'loc', 'dlc'], group: '浏览',
      desc: '上一条', keys: ['k'],
    },
    {
      id: 'nav.nextCol', pages: ['loc', 'dlc'], group: '浏览',
      desc: '右一列 / 下一门语言', keys: ['l'],
    },
    {
      id: 'nav.prevCol', pages: ['loc', 'dlc'], group: '浏览',
      desc: '左一列 / 上一门语言', keys: ['h'],
    },

    /* 教程页特有 */
    {
      id: 'docs.top', pages: ['docs'], group: '浏览',
      desc: '回到顶部', keys: ['mod+home'],
    },
    {
      id: 'docs.nextSec', pages: ['docs'], group: '浏览',
      desc: '下一节', keys: ['j'],
    },
    {
      id: 'docs.prevSec', pages: ['docs'], group: '浏览',
      desc: '上一节', keys: ['k'],
    },
    {
      id: 'docs.shortcuts', pages: ['docs'], group: '全局',
      desc: '打开快捷键速查表', keys: ['mod+/'],
    },

/* 生成页特有 */
    {
      id: 'create.gen', pages: ['create'], group: '文件',
      // ⚠ 不能用 mod+enter:全局全屏已经占了它(冲突检测会报,且两个动作
      //   在同一页同时存在时行为不确定)。生成用 mod+g 更贴近浏览器习惯。
      desc: '生成产物', keys: ['mod+g'],
    },
    {
      id: 'create.nextFile', pages: ['create'], group: '浏览',
      desc: '下一个产物文件', keys: ['j'],
    },
    {
      id: 'create.prevFile', pages: ['create'], group: '浏览',
      desc: '上一个产物文件', keys: ['k'],
    },
    {
      id: 'create.copyFile', pages: ['create'], group: '编辑',
      desc: '复制当前产物内容', keys: ['mod+c'],
    },
    {
      id: 'create.sample', pages: ['create'], group: '编辑',
      desc: '填入示例值', keys: ['mod+shift+s'],
    },
    {
      id: 'create.clear', pages: ['create'], group: '编辑',
      desc: '清空字段', keys: ['mod+backspace'],
    },

/* DLC 页特有 */
    {
      id: 'dlc.onlyDlc', pages: ['dlc'], group: '筛选',
      desc: '只看 DLC 专属条目', keys: ['mod+d'],
    },
    {
      id: 'dlc.clearDlc', pages: ['dlc'], group: '筛选',
      desc: '清除 DLC 筛选', keys: ['mod+shift+d'],
    },

    /* 本地化页特有 */
    {
      id: 'loc.edit', pages: ['loc'], group: '编辑',
      desc: '编辑选中的译文', keys: ['enter'],
    },

    /* 设计器特有 */
    {
      id: 'designer.save', pages: ['designer'], group: '文件',
      desc: '保存全部改动', keys: ['mod+s'],
    },
    {
      id: 'designer.preview', pages: ['designer'], group: '文件',
      desc: '预览差异', keys: ['mod+d'],
    },
    {
      id: 'designer.discard', pages: ['designer'], group: '文件',
      desc: '撤销全部改动', keys: ['mod+shift+z'],
    },
    {
      id: 'designer.parent', pages: ['designer'], group: '浏览',
      desc: '选中父级元素', keys: ['mod+arrowup'],
    },
    {
      id: 'designer.firstChild', pages: ['designer'], group: '浏览',
      desc: '选中第一个子元素', keys: ['mod+arrowdown'],
    },
    {
      id: 'designer.sibling', pages: ['designer'], group: '浏览',
      desc: '选中下一个兄弟元素', keys: ['mod+arrowright'],
    },
    {
      id: 'designer.prevSibling', pages: ['designer'], group: '浏览',
      desc: '选中上一个兄弟元素', keys: ['mod+arrowleft'],
    },

    /* IDE 文件 */
    { id: 'ide.quickOpen', pages: ['ide'], group: '文件', doc: true, desc: '快速打开文件', keys: ['mod+p'] },
    { id: 'ide.save', pages: ['ide'], group: '文件', doc: true, desc: '保存 / 进入编辑模式', keys: ['mod+s'] },
    { id: 'ide.editMode', pages: ['ide'], group: '文件', doc: true, desc: '切换编辑模式', keys: ['mod+e'] },
    { id: 'ide.closeTab', pages: ['ide'], group: '文件', doc: true, desc: '关闭当前标签', keys: ['mod+w'] },
    { id: 'ide.find', pages: ['ide'], group: '查找', doc: true, desc: '文件内查找', keys: ['mod+f'] },
    { id: 'ide.replace', pages: ['ide'], group: '查找', doc: true, desc: '查找 / 替换', keys: ['mod+h'] },
    { id: 'ide.gotoLine', pages: ['ide'], group: '查找', doc: true, desc: '跳转到行号', keys: ['mod+g'] },
    { id: 'ide.cycleTab', pages: ['ide'], group: '标签', doc: true, desc: '切换标签', keys: ['mod+tab'] },
    { id: 'ide.nextTab', pages: ['ide'], group: '标签', doc: true, desc: '下一个标签', keys: ['alt+arrowright'] },
    { id: 'ide.prevTab', pages: ['ide'], group: '标签', doc: true, desc: '上一个标签', keys: ['alt+arrowleft'] },
    { id: 'ide.toggleTree', pages: ['ide'], group: '视图', doc: true, desc: '折叠 / 展开文件树', keys: ['mod+b'] },
    { id: 'ide.completion', pages: ['ide'], group: '编辑', doc: true, desc: '触发自动补全', keys: ['mod+space'] },
    /* ★ 注释(2026-10-06 加):Clausewitz 脚本只有一种注释 —— 行首 `#`。
     *   没有块注释,所以「切换」= 全部行统一加上或去掉。
     *   `mod+/` 是 VS Code / 大多数编辑器的通用键,用户按 Ctrl+/ 期待的就是它。
     *   归一化没问题:Ctrl+/ 的 e.key='/' → normKey('/')='/' → combo='mod+/';
     *   按 Shift 时 e.key 变成 '?',得到 'mod+?' —— 与不按 Shift 的不冲突。 */
    { id: 'ide.toggleComment', pages: ['ide'], group: '编辑', doc: true, desc: '注释 / 取消注释(选中行)', keys: ['mod+/'] },
  ]

  var BY_ID = new Map()
  ACTIONS.forEach(function (a) { BY_ID.set(a.id, a) })

  function inPages(a, page) {
    return a.pages === '*' || (Array.isArray(a.pages) && a.pages.indexOf(page) >= 0)
  }

  function descOf(a, page) {
    if (typeof a.desc === 'string') return a.desc
    if (a.desc && typeof a.desc === 'object') return a.desc[page] || a.desc.default || a.id
    return a.id
  }

  /* ── 覆盖表读写 ──
   * localStorage 在 file:// 或隐私模式下可能抛异常,全程 try 包住,
   * 不能因为存不了就整个公共件挂掉。 */
  function readRaw() {
    try {
      var s = localStorage.getItem(LS)
      if (!s) return {}
      var o = JSON.parse(s)
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
    } catch (e) {
      return {}
    }
  }

  function writeRaw(o) {
    try {
      localStorage.setItem(LS, JSON.stringify(o))
      return true
    } catch (e) {
      return false
    }
  }

  /** 某动作是否被用户改过(含显式禁用) */
  function isCustom(id) {
    return Object.prototype.hasOwnProperty.call(readRaw(), id)
  }

  /** 该动作在给定页的生效键位(已应用覆盖)。禁用 → 空数组。 */
  function keysOf(id, page) {
    var a = BY_ID.get(id)
    if (!a) return []
    var ov = readRaw()
    if (!Object.prototype.hasOwnProperty.call(ov, id)) return a.keys.slice()
    var v = ov[id]
    if (v === '' || v === null || v === undefined) return [] // 显式禁用
    // 兼容早期可能的数组写法
    if (Array.isArray(v)) return v.slice()
    return [String(v)]
  }

  /** 只取该动作在给定页的默认键位(设置页展示"默认:…"用) */
  function defaultKeysOf(id) {
    var a = BY_ID.get(id)
    return a ? a.keys.slice() : []
  }

  /**
   * 设置键位。
   *   combo = ''  → **显式禁用**(存空串)。设置页点「清除」走的是 reset()。
   *   combo = null → 删掉覆盖,恢复默认。
   * ⚠ 别把空串当"删除覆盖":那会让"禁用"永远存不进去 ——
   *   keys.js 判禁用靠的就是 isCustom(id) && keysOf(id).length===0。
   * 返回 {ok:true, conflict:[同页冲突]} 或 {ok:false, reason}
   */
  function set(id, combo) {
    if (!BY_ID.has(id)) return { ok: false, reason: tr('未知动作 ') + id }
    var ov = readRaw()
    if (combo === null || combo === undefined) delete ov[id]
    else ov[id] = String(combo)
    if (!writeRaw(ov)) return { ok: false, reason: '无法写入 localStorage(浏览器隐私模式?)' }
    return { ok: true, conflict: conflictsOf(id) }
  }

  function reset(id) {
    var ov = readRaw()
    if (!Object.prototype.hasOwnProperty.call(ov, id)) return true
    delete ov[id]
    return writeRaw(ov)
  }

  function resetAll() {
    return writeRaw({})
  }

  /** 当前覆盖表(设置页展示"已自定义 N 项") */
  function overrides() {
    var ov = readRaw()
    var out = {}
    Object.keys(ov).forEach(function (k) { if (BY_ID.has(k)) out[k] = ov[k] })
    return out
  }

  function customCount() {
    return Object.keys(overrides()).length
  }

  /** 导出/导入(便于迁移到另一台机器) */
  function exportMap() {
    return JSON.stringify({ v: 1, keymap: overrides() }, null, 2)
  }
  function importMap(text) {
    var o
    try { o = JSON.parse(text) } catch (e) { return { ok: false, reason: '不是合法 JSON' } }
    var m = o && o.keymap ? o.keymap : o
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, reason: '格式不对' }
    var clean = {}
    var bad = []
    Object.keys(m).forEach(function (k) {
      if (!BY_ID.has(k)) { bad.push(k); return }
      if (typeof m[k] === 'string') clean[k] = m[k]
    })
    writeRaw(clean)
    return { ok: true, applied: Object.keys(clean).length, unknown: bad }
  }

  /* ── 冲突检测 ──
   * 作用域 = **同一个页面**。跨页重复不算冲突:
   * focus 的 mod+f 与 ide 的 mod+f 本来就分属不同页面,永远不同时生效。 */
  function forPage(page) {
    return ACTIONS.filter(function (a) { return inPages(a, page) })
  }

  /**
   * 某动作的键位与同页其它动作撞车 → 返回 [{id, keys:[交集], page}]
   * ⚠ 跨页动作(如「放大」focus+tech 都有)必须**逐页各查一次**:
   *   只查第一个页会漏报 —— 它在 focus 上没冲突,不代表在 tech 上没冲突。
   */
  function conflictsOf(id) {
    var a = BY_ID.get(id)
    if (!a) return []
    var pages = a.pages === '*' ? PAGES.map(function (p) { return p.id }) : a.pages.slice()
    var seen = new Set()
    var out = []
    pages.forEach(function (page) {
      var mine = keysOf(id, page)
      if (!mine.length) return
      forPage(page).forEach(function (b) {
        if (b.id === id) return
        var bs = keysOf(b.id, page)
        if (!bs.length) return
        var hit = bs.filter(function (k) { return mine.indexOf(k) >= 0 })
        if (!hit.length) return
        var sig = page + '|' + b.id
        if (seen.has(sig)) return
        seen.add(sig)
        out.push({ id: b.id, page: page, keys: hit })
      })
    })
    return out
  }

  /** 全站所有冲突(设置页顶部提示用) */
  function allConflicts() {
    var seen = new Set()
    var out = []
    ACTIONS.forEach(function (a) {
      if (seen.has(a.id)) return
      seen.add(a.id)
      var c = conflictsOf(a.id)
      if (c.length) out.push({ id: a.id, page: pageOf(a.id), desc: descOf(a, pageOf(a.id)), with: c })
    })
    return out
  }

  /** 该动作"归属"的页面(取第一个具体页;* 取 global) */
  function pageOf(id) {
    var a = BY_ID.get(id)
    if (!a) return null
    if (a.pages === '*') return 'global'
    return a.pages[0]
  }

  global.Keymap = {
    LS: LS,
    PAGES: PAGES,
    ACTIONS: ACTIONS,
    byId: function (id) { return BY_ID.get(id) || null },
    inPages: inPages,
    descOf: descOf,
    pageOf: pageOf,
    forPage: forPage,
    keysOf: keysOf,
    defaultKeysOf: defaultKeysOf,
    /* 解析"这个动作该按哪些键":先看用户覆盖,没覆盖用目录默认。
     * ★ keys.js 的 bind() 必须走这个 —— 它不能只看页面调用处写的 combo,
     *   因为调用处正是按"combo=null + 靠目录"改成 id 模式的,
     *   直接读默认会拿到空数组 → 所有快捷键静默消失。 */
    resolve: function (id, page) {
      var a = BY_ID.get(id)
      if (!a) return null
      var ks = keysOf(id, page)
      return ks.length ? ks : a.keys.slice()
    },
    isCustom: isCustom,
    set: set,
    reset: reset,
    resetAll: resetAll,
    overrides: overrides,
    customCount: customCount,
    exportMap: exportMap,
    importMap: importMap,
    conflictsOf: conflictsOf,
    allConflicts: allConflicts,
  }
})(window)
