/* ownchip.js —— OWNERSHIP_V1:全工作台统一的「原版 / 模组改写 / 模组新增」徽标。
 *
 * 游戏语义:同名 → 后载入的模组【整份替换】先载入的原版;不同名 → 共存(新增)。
 * 所以任何内容只有三种归属,统计只算生效集(每个 key 一次):
 *   vanilla  原版内容(模组没有同名覆盖它)
 *   override 原版有、但被模组整份替换了(原版那份已失效)
 *   new      原版没有、模组新增
 *
 * 各页不要再自己写 `origin === 'mod'` / `root === 0` 这类判据,一律走这里 ——
 * 否则又会出现"同名当增加"的假统计。后端统一下发 `own` 字段。
 */
;(function () {
  var LABEL = { vanilla: '原版', override: '模组改写', new: '模组新增' }
  /** 与 theme.css 的 .src.* 颜色语义一致 */
  var CLS = { vanilla: 'base', override: 'ovr', new: 'new' }
  var HINT = {
    vanilla: '基础游戏原本就有,模组没有同名内容覆盖它 —— 生效的就是原版这一份',
    override: '基础游戏有同名内容,但被模组整份替换了 —— 原版那份已失效,生效的是模组版本',
    new: '基础游戏没有这个内容 —— 模组新增,与原版内容共存',
  }

  /** 从任一条目上取归属三态(后端下发的 own 优先,其次按旧字段推) */
  function of(o) {
    if (!o) return 'new'
    if (o.own === 'vanilla' || o.own === 'override' || o.own === 'new') return o.own
    if (o.overridden) return 'override'
    if (o.origin === 'mod') return 'new'
    if (o.origin === 'vanilla') return 'vanilla'
    return o.base ? 'vanilla' : 'new'
  }

  function label(o) { return LABEL[of(o)] || '—' }
  function hint(o) { return HINT[of(o)] || '' }

  /** 徽标 HTML。opt:{ title 额外说明 } */
  function badge(o, opt) {
    opt = opt || {}
    var k = of(o)
    var t = hint(o)
    if (opt.title) t += '\n' + opt.title
    return '<span class="src ' + CLS[k] + '" title="' + esc(t) + '">' + LABEL[k] + '</span>'
  }

  /** 统计条文案:st = { vanilla, override, new, effective, shadowed } */
  function statsLine(st) {
    if (!st) return ''
    var parts = []
    parts.push(tr('原版 ') + (st.vanilla ?? 0))
    parts.push(tr('模组改写 ') + (st.override ?? 0))
    parts.push(tr('模组新增 ') + (st.new ?? 0))
    var s = parts.join(' · ')
    s += tr(' ｜ 游戏内生效 ') + (st.effective ?? (st.vanilla ?? 0) + (st.override ?? 0) + (st.new ?? 0))
    if (st.shadowed) s += tr('(另有 ') + st.shadowed + tr(' 份因被同名覆盖而失效)')
    return s
  }

  /** 筛选器标准选项(与后端 src 参数一致) */
  function filters(st) {
    return [
      { v: '', t: '全部' },
      { v: 'vanilla', t: tr('原版 ') + ((st && st.vanilla) ?? '') },
      { v: 'override', t: tr('模组改写 ') + ((st && st.override) ?? '') },
      { v: 'new', t: tr('模组新增 ') + ((st && st.new) ?? '') },
    ]
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  window.Own = { LABEL: LABEL, CLS: CLS, HINT: HINT, of: of, label: label, hint: hint, badge: badge, statsLine: statsLine, filters: filters, esc: esc }
})()
