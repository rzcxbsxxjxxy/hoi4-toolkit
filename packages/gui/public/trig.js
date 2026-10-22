/* ══════════════════════════════════════════════════════════════════
 * trig.js —— 前端条件求值与条件面板(TRIGGERS_V1, 忠实移植 HOI4 Mod Utilities 0.18.1)
 *
 * 与后端 packages/focus/src/trigger.ts 同表、同模型:
 *   - 条件叶子【规范化】成 nodeContent = "key = value"(字符串值去引号),
 *     求值 = 叶子在「用户选中的条件集合 scope(Set<string>)」里按相等命中 → true,
 *     否则 false。两态,没有"未知"。
 *   - QV 真值表:and / or / andnot / ornot / count(对齐 MU common.js)。
 *   - scope = 用户在条件面板勾选的那组 nodeContent。
 *
 * 页面 #allowbranch-container 勾选条件后,整棵树按新 scope 重算显隐。
 * 全局挂在 window.Trig 上。
 * ══════════════════════════════════════════════════════════════════ */
;(function (global) {
  'use strict'

  /* 逻辑/不可开关键 —— 不进条件面板,不作为可判定叶子 */
  var NON_SWITCHABLE = {
    if: 1, limit: 1, else_if: 1, 'else': 1,
    custom_trigger_tooltip: 1, hidden_trigger: 1,
  }

  /** 规范化叶子条件:key = value(去掉字符串两侧引号) */
  function canonicalCondition(key, value) {
    key = String(key == null ? '' : key).trim()
    value = String(value == null ? '' : value).trim().replace(/^"(.*)"$/, '$1')
    return key + ' = ' + value
  }

  /**
   * ★ 求值入口 —— 照搬 MU 0.18.1 的 QV(common.js):
   *   leaf 在 scope 里命中 → true;否则 false(两态)。
   *   and  : 任一 false → false;否则 true
   *   or   : 任一 true  → true;否则 false
   *   andnot:任一 false → true;否则 false   (NAND)
   *   ornot :任一 true  → false;否则 true   (NOR)
   *   not   :取反
   *   count :命中数 ≥ amount
   */
  function evalTrig(node, scope) {
    if (node === null || node === undefined) return false
    if (typeof node === 'boolean') return node
    switch (node.type) {
      case 'bool':
        return !!node.value
      case 'leaf':
        /* GAMERULE_DEFAULT_V1:has_game_rule 按规则「当前选项」比较(默认=模组定义),
           不是简单的"勾了就 true"。规则未定义时退回旧行为(scope 命中)。 */
        if (node.key === 'has_game_rule') return evalGameRuleLeaf(node, scope)
        return scope.has(node.nodeContent)
      case 'not':
        return !evalTrig(node.items[0], scope)
      case 'count': {
        var hit = 0
        for (var i = 0; i < node.items.length; i++) if (evalTrig(node.items[i], scope)) hit++
        return hit >= node.amount
      }
      case 'and': {
        for (var a = 0; a < node.items.length; a++) if (!evalTrig(node.items[a], scope)) return false
        return true
      }
      case 'or': {
        for (var o = 0; o < node.items.length; o++) if (evalTrig(node.items[o], scope)) return true
        return false
      }
      case 'andnot': {
        for (var an = 0; an < node.items.length; an++) if (!evalTrig(node.items[an], scope)) return true
        return false
      }
      case 'ornot': {
        for (var on = 0; on < node.items.length; on++) if (evalTrig(node.items[on], scope)) return false
        return true
      }
    }
    return false
  }

  /** 收集树上所有唯一条件叶子(nodeContent 去重),附次数。对齐 MU 的 U()。 */
  function collectConditions(node, out) {
    out = out || new Map()
    if (!node || typeof node === 'boolean') return out
    if (node.type === 'leaf') {
      var k = String(node.key || '').toLowerCase().trim()
      if (!NON_SWITCHABLE[k]) {
        var nc = node.nodeContent
        var cur = out.get(nc)
        if (cur) cur.count++
        else out.set(nc, { nodeContent: nc, key: node.key, count: 1 })
      }
      return out
    }
    for (var i = 0; i < (node.items || []).length; i++) collectConditions(node.items[i], out)
    return out
  }

  /** 展开成可读单行(检查器「显示详情」用) */
  function fmt(node) {
    if (!node || typeof node === 'boolean') return String(node)
    if (node.type === 'leaf') return node.nodeContent || node.raw
    if (node.type === 'bool') return node.value ? 'always = yes' : 'always = no'
    if (node.type === 'not') return 'NOT ' + (node.items || []).map(fmt).filter(Boolean).join(' ')
    if (node.type === 'and') return (node.items || []).map(fmt).filter(Boolean).join(' AND ')
    if (node.type === 'or') return (node.items || []).map(fmt).filter(Boolean).join(' OR ')
    if (node.type === 'andnot') return 'ANDNOT ' + (node.items || []).map(fmt).filter(Boolean).join(' ')
    if (node.type === 'ornot') return 'ORNOT ' + (node.items || []).map(fmt).filter(Boolean).join(' ')
    if (node.type === 'count')
      return 'AT_LEAST(' + node.amount + ' of ' + (node.items || []).length + ') ' + (node.items || []).map(fmt).filter(Boolean).join(' / ')
    return ''
  }

  /** 一行式摘要(检查器用):只留结构关键词 */
  function summarize(node) {
    if (!node) return ''
    var s = fmt(node).replace(/\s+/g, ' ')
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }

  /* ── Scope 管理:Set<string>(nodeContent) ── */
  function emptyScope() {
    return new Set()
  }
  function scopeFromJson(j) {
    var sc = new Set()
    if (!j) return sc
    for (var i = 0; i < (j || []).length; i++) sc.add(j[i])
    return sc
  }
  function scopeToJson(sc) {
    return Array.from(sc || new Set())
  }

  /* ── 游戏规则默认值求值(GAMERULE_DEFAULT_V1)──
   * has_game_rule 叶子要按该规则的「当前选项」比较:当前选项默认 = 模组 common/game_rules
   * 里定义的 default(如 obsolete_focus_branches_visibility 默认 HIDE),面板可勾选覆盖。
   * 规则在 game_rules 里没定义(默认未知)时退回旧行为(scope 字符串命中)。 */
  var GAME_RULE_DEFAULT = {}
  var GAME_RULE_CURRENT = {}
  function setGameRuleDefaults(defs) {
    GAME_RULE_DEFAULT = Object.assign({}, defs || {})
    GAME_RULE_CURRENT = Object.assign({}, GAME_RULE_DEFAULT)
  }
  function getGameRuleCurrent() { return Object.assign({}, GAME_RULE_CURRENT) }
  function parseGameRule(nc) {
    /* ⚠ 正则须带 \b:否则 'has_game_rule = {' 里的 'rule' 也被命中 */
    var m = String(nc || '').match(/\brule\s*=\s*([^\s}]+)[\s\S]*?\boption\s*=\s*([^\s}]+)/)
    return m ? { rule: m[1].trim(), option: m[2].trim() } : null
  }
  function matchGameRule(nc) {
    var g = parseGameRule(nc)
    if (g && g.rule in GAME_RULE_CURRENT) return GAME_RULE_CURRENT[g.rule] === g.option
    return false
  }
  function setGameRule(nc, on) {
    var g = parseGameRule(nc)
    if (!g) return
    if (on) GAME_RULE_CURRENT[g.rule] = g.option
    else if (g.rule in GAME_RULE_DEFAULT) GAME_RULE_CURRENT[g.rule] = GAME_RULE_DEFAULT[g.rule]
  }
  function evalGameRuleLeaf(node, scope) {
    var g = parseGameRule(node.nodeContent)
    if (g && g.rule in GAME_RULE_CURRENT) return GAME_RULE_CURRENT[g.rule] === g.option
    return scope.has(node.nodeContent)
  }

  /* ── 面板分组(仅显示归类,不影响求值) ── */
  var CATEGORY = {
    has_dlc: 'DLC',
    has_completed_focus: '已完成国策', has_completed_any_focus: '已完成国策',
    has_completed_branch: '已完成国策分支', has_national_focus: '已有国策', focus: '国策',
    has_completed_tech: '已完成科技', has_tech: '已有科技',
    has_country_flag: '国家旗标', has_flag: '旗标', country_flag: '国家旗标', has_global_flag: '全局旗标',
    has_game_rule: '游戏规则', game_rules_allow_achievements: '游戏规则',
    original_tag: '原国策tag',
  }
  var CATEGORY_ORDER = ['DLC', '已完成科技', '已有科技', '已完成国策', '已完成国策分支', '已有国策', '国策', '游戏规则', '国家旗标', '旗标', '全局旗标', '原国策tag', '其他']
  function categoryOf(key) {
    return CATEGORY[String(key == null ? '' : key).toLowerCase().trim()] || '其他'
  }
  /** 面板分组顺序:返回一个 {cat: [items]} 的有序数组 */
  function groupConditions(conditions) {
    var groups = new Map()
    for (var i = 0; i < conditions.length; i++) {
      var it = conditions[i]
      var cat = categoryOf(it.key)
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat).push(it)
    }
    var out = []
    for (var o = 0; o < CATEGORY_ORDER.length; o++) {
      var c = CATEGORY_ORDER[o]
      if (groups.has(c)) { out.push({ cat: c, items: groups.get(c) }); groups.delete(c) }
    }
    for (var r of groups.keys()) out.push({ cat: r, items: groups.get(r) })
    return out
  }

  global.Trig = {
    evalTrig: evalTrig,
    collectConditions: collectConditions,
    canonicalCondition: canonicalCondition,
    fmt: fmt,
    summarize: summarize,
    emptyScope: emptyScope,
    scopeFromJson: scopeFromJson,
    scopeToJson: scopeToJson,
    categoryOf: categoryOf,
    groupConditions: groupConditions,
    /* GAMERULE_DEFAULT_V1 */
    setGameRuleDefaults: setGameRuleDefaults,
    getGameRuleCurrent: getGameRuleCurrent,
    setGameRule: setGameRule,
    matchGameRule: matchGameRule,
  }
})(window)