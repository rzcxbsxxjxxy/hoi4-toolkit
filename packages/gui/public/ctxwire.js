/* ══════════════════════════════════════════════════════════════════
 * ctxwire.js —— 右键 + 快捷键接线的公共骨架(RIGHTCLICK_V2)
 *
 * ★ 用户诉求(2026-10-05):"应该大量为所有可能的页面补充鼠标右键和快捷键的功能"
 *
 * 前一轮 ctx.js / keys.js 只是把"能力"做出来了,实际只接了 focus / tech /
 * doctrines / ide 四页。剩下 decisions / dlc / loc / events / designer /
 * create / ref / docs 八页都是零。
 *
 * 为什么不逐页手写:
 *   八页的接线是**同一个形状** —— "某容器里的一类元素,右键给一份菜单,
 *   顺便绑几个页内快捷键"。手写八遍意味着:
 *     · 同一处 bug 要修八次(已经踩过:元素必须挂 __obj 不能按文本反查);
 *     · 后面再加页又是新一轮复制;
 *     · 各页快捷键目录(keymap.js)要手工同步,极易漏。
 *   所以把"接线"抽成本件:页面只声明 {容器, 选择器, 取数据, 额外菜单项, 快捷键}。
 *
 * ── 铁律:数据挂元素,不按 DOM 文本反查 ──
 *   各页 UI 上的文字是**本地化文本**,改语言或改显示名就失配。
 *   所以菜单数据一律通过 el.__obj 现取(与 doctrines 页的教训一致)。
 *   `data-*` 只用来定位元素与判类型,不用来反推数据。
 *
 * ── 为什么用事件委托而不是逐元素绑定 ──
 *   focus/tech 的画布每次 render() 全量重建节点,逐元素绑定立刻失效。
 *   Ctx.attach 绑在容器上按 selector 匹配,重建后无需重绑。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  /**
   * 接入一页
   * @param {object} cfg
   * @param {string} cfg.page          页 id(对应 keymap.js 的 page,用于查覆盖)
   * @param {Array<{
   *     host: string|Element,          容器
   *     sel: string,                   元素选择器
   *     obj: (el:Element)=>any|null,  取数据(返回 null 则不给菜单)
   *     items?: (obj:any, el:Element)=>Array, 额外的自定义菜单项
   *     resolve?: (el:Element)=>Element,      展开子元素(有些行的可点区域在子元素上,事件 target 落在子元素)
   *   }>} [cfg.on]                     右键绑定,可多组(如"卡片"+"分类行")
   * @param {Array<{id?:string, keys?:string|string[], run:Function, desc:string, group?:string}>} [cfg.keys]
   * @param {()=>void} [cfg.onReady]    接线完成后的回调(装自定义热区等)
   */
  function attach(cfg) {
    if (!global.Ctx || !global.Keys) return false
    var page = cfg.page
    if (page) global.__KEYMAP_PAGE__ = page

    // ── 右键 ──
    ;(cfg.on || []).forEach(function (g) {
      if (!g.items) return
      Ctx.attach(g.host, g.sel, function (el) {
        var target = g.resolve ? g.resolve(el) || el : el
        var o = g.obj(target)
        if (o === null || o === undefined) return null
        return Ctx.sourceItems(
          Object.assign(
            {
              root: o.root,
              rootName: o.rootName,
              file: o.file,
              line: o.line,
              id: o.id,
              loc: o.loc,
              defs: o.defs,
            },
            { extra: g.items ? g.items(o, target) : null },
          ),
        )
      })
    })

    // ── 快捷键 ──
    // ⚠ 键位一律交给 keymap 目录:给了 id 用目录的(用户可在设置页改),
    //   没给 id 才用本处的 keys。**不要两处都写** ——
    //   写了 id 又写 keys 时,keys 只在"目录查不到该 id"时才被用到,
    //   正常情况下它是死值,改它不会生效,反而误导后来的人。
    ;(cfg.keys || []).forEach(function (k) {
      if (typeof k.run !== 'function') return
      // 给了 id → combo 位传 null,键位由 keymap 目录决定(用户可改);
      // 没给 id → 键位只能在本处声明,直接走 combo 位。
      Keys.bind(k.id ? null : k.keys || null, k.run, k.desc || '', {
        id: k.id,
        group: k.group || '本页',
        global: !!k.global,
      })
    })

    if (cfg.onReady) cfg.onReady()
    return true
  }

  /**
   * 给"当前选中项"补一组通用动作(复制 id / 复制路径 / 打开右键菜单 / 取消选择)。
   * 八页里七页都有"选中一项看详情",这三个动作是共通的,不必各写一遍。
   *
   * ⚠ **必须走目录 id,不能用裸键位**:裸键位写在这里的话,用户在设置页
   *   改不了 —— 而这正是 KEYMAP_V1 存在的理由。所以 mod+c / shift+f10
   *   统一取 keymap 目录的 sel.copyId / sel.menu(各页 desc 已在目录里区分)。
   * @param {function():(object|string|null)} o 取当前选中数据的函数。
   *   返回**对象**({id:...})或**字符串**(直接就是 id)都认 —— 两种都实际在用:
   *     decisions.js 传 () => (S.selDec ? { id: S.selDec } : null)   对象
   *     loc.js       传 curId  → 返回 c.key,是**字符串**
   *     designer.js  传 curId  → 返回 n.id,也是**字符串**
   *   ⚠ 只判 `!d.id` 的话,字符串的 .id 是 undefined,于是**永远提示
   *     「先点选一个…」** —— loc / designer 两页的「复制 id」快捷键
   *     实际上从来没生效过,而桩测与页面加载都测不出来(不抛异常,
   *     只是按了没反应)。无头浏览器实测才暴露出来。
   * @param {{clear?:()=>void, label?:string}} [opt]
   */
  function commonKeys(o, opt) {
    opt = opt || {}
    var lab = opt.label || '选中项'
    /** 归一成 {id} —— 字符串与对象都接受,**统一返回对象**
     *  (run 里读的是 d.id,若这里直接返回字符串,d.id 就是 undefined) */
    function idOf() {
      var d = o()
      if (!d) return null
      if (typeof d === 'string') return d ? { id: d } : null
      return d.id ? d : null
    }
    return [
      {
        id: 'sel.copyId',
        desc: tr('复制') + lab + tr('的 id'),
        group: '选中',
        run: function () {
          var d = idOf()
          if (!d) { toast(tr('先点选一个') + lab, true); return }
          Ctx.copy(d.id, ' ' + d.id)
        },
      },
      {
        id: 'sel.menu',
        desc: tr('对') + lab + tr('打开右键菜单'),
        group: '选中',
        run: function () { Keys.ctxKey() },
      },
    ]
  }

  function toast(msg, bad) {
    if (global.Ctx && Ctx.toast) return Ctx.toast(msg, bad)
    var t = document.getElementById('toast')
    if (!t) { console[bad ? 'warn' : 'log'](msg); return }
    t.textContent = msg
    t.className = 'on' + (bad ? ' err bad' : '')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { t.className = '' }, 2600)
  }

  global.CtxWire = { attach: attach, commonKeys: commonKeys, toast: toast }
})(window)
