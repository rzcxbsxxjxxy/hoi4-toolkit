/* DLC 内容浏览器。
 *
 * 一个 DLC 往 common/ 里加的玩法目录(MIO 军工机构 / 特殊工程 / 阵营 / 学说),
 * 按「玩法 → 分组 → 条目」三级呈现,点选看检查器。
 *
 * ★ 为什么要单独一个页面而不是并进"决议树"那类:
 *   ① 这些内容的组织维度不是"前置关系"而是"DLC 归属",放进决议树会挤爆它的分类墙;
 *   ② 每个玩法自己的字段完全不同(工程有 complexity/prototype_time、
 *      军工机构有 equipment_bonus、阵营有 goals/rules 两套形态),
 *      强行统一成一种卡片反而丢信息;
 *   ③ 注册表在 engine/src/dlc.ts,新 DLC 加一条记录即可,前端不用改。
 *
 * 筛选语义与 focus/decisions 一致:
 *   src     '' / base / mod / vanilla / modNew / overridden / 具体来源名
 *   feature 限定某个玩法     dlc 限定某个 DLC     onlyDlc 只看 DLC 专属
 */
const $ = (s) => document.querySelector(s)

/* ★ MIO_WIKI_V1:文档 Equipment Stats 分类 —— 用于装备加成的类别标注 */
const MIO_STAT_GROUP = {
  tank:     { label: '坦克', stats: ['maximum_speed','reliability','defense','breakthrough','armor_value','soft_attack','hard_attack','ap_attack','air_attack','build_cost_ic','fuel_consumption','hardness','entrenchment','fuel_capacity'] },
  ship:     { label: '舰船', stats: ['lg_armor_piercing','lg_attack','hg_armor_piercing','hg_attack','torpedo_attack','sub_attack','anti_air_attack','armor_value','surface_detection','sub_detection','sub_visibility','surface_visibility','naval_speed','reliability','naval_range','max_strength','fuel_consumption','build_cost_ic','manpower','naval_dominance_factor','naval_torpedo_enemy_critical_chance_factor','naval_torpedo_damage_reduction_factor','carrier_size','mines_sweeping','mines_planting','naval_torpedo_hit_chance_factor','naval_light_gun_hit_chance_factor','naval_heavy_gun_hit_chance_factor'] },
  plane:    { label: '飞机', stats: ['air_superiority','reliability','naval_strike_attack','naval_strike_targetting','manpower','fuel_consumption','build_cost_ic','resources','thrust','weight','maximum_speed','air_range','air_agility','air_attack','air_defence','surface_detection','sub_detection','air_ground_attack','air_bombing','mines_planting','mines_sweeping','night_penalty'] },
  materiel: { label: '装备', stats: ['reliability','build_cost_ic','maximum_speed','defense','breakthrough','hardness','armor_value','soft_attack','hard_attack','ap_attack','air_attack','fuel_consumption','railway_gun_attack'] },
}
/* stat → 需要的 DLC(文档标注的装备前提) */
const MIO_STAT_DLC = {
  entrenchment: 'NSB(推土铲模块)', fuel_capacity: 'NSB(扩容油箱模块)',
  thrust: 'BBA', weight: 'BBA', night_penalty: 'BBA',
  mines_planting: 'MTG+BBA', mines_sweeping: 'MTG+BBA',
  naval_torpedo_enemy_critical_chance_factor: 'MTG', naval_torpedo_damage_reduction_factor: 'MTG', carrier_size: 'MTG',
}
/* ★ MIO_WIKI_V1:organization_modifier 白名单(文档:仅 MIO 专属 modifier 有效) */
const MIO_ORG_MODS = ['military_industrial_organization_research_bonus','military_industrial_organization_design_team_assign_cost','military_industrial_organization_design_team_change_cost','military_industrial_organization_industrial_manufacturer_assign_cost','military_industrial_organization_task_capacity','military_industrial_organization_size_up_requirement','military_industrial_organization_funds_gain']
/* 装备加成 stat → 类别标注文本(纯文本,供 kv 转义) */
function mioStatTag(k) {
  const groups = Object.keys(MIO_STAT_GROUP).filter((g) => MIO_STAT_GROUP[g].stats.includes(k))
  const g = groups.length ? groups.map((x) => MIO_STAT_GROUP[x].label).join('/') : '未知stat'
  return '[' + g + ']' + (MIO_STAT_DLC[k] ? ' (需 ' + MIO_STAT_DLC[k] + ')' : '')
}
/* ★★ AI_BONUS_V1:stat / 生产加成 / 组织 modifier 中文名(依据 ai_bonus_weights.txt default 全部条目) */
const MIO_STAT_LOC = {
  air_agility:'机动', air_attack:'空袭', air_bombing:'空袭轰炸', air_defence:'防空', air_ground_attack:'对地攻击', air_range:'航程', air_superiority:'制空',
  anti_air_attack:'防空攻击', ap_attack:'穿甲攻击', armor_value:'装甲', breakthrough:'突破', build_cost_ic:'建造费用', carrier_size:'载机量',
  defense:'防御', entrenchment:'堑壕', fuel_consumption:'燃油消耗', hard_attack:'硬攻', hardness:'硬度', hg_armor_piercing:'重炮穿甲', hg_attack:'重炮攻击',
  lg_armor_piercing:'轻炮穿甲', lg_attack:'轻炮攻击', max_organisation:'组织度', max_strength:'最大兵力', maximum_speed:'最大速度',
  mines_planting:'布雷', mines_sweeping:'扫雷', naval_heavy_gun_hit_chance_factor:'重炮命中', naval_light_gun_hit_chance_factor:'轻炮命中',
  naval_range:'航程', naval_speed:'航速', naval_strike_attack:'舰载机攻击', naval_strike_targetting:'舰载机锁定',
  naval_torpedo_damage_reduction_factor:'鱼雷减伤', naval_torpedo_hit_chance_factor:'鱼雷命中', naval_weather_penalty_factor:'天气惩罚',
  night_penalty:'夜战惩罚', reliability:'可靠性', reliability_factor:'可靠性系数', soft_attack:'软攻', strategic_attack:'战略轰炸',
  sub_attack:'潜艇攻击', sub_detection:'潜艇探测', sub_visibility:'潜艇隐蔽', supply_consumption:'补给消耗',
  surface_detection:'水面探测', surface_visibility:'水面可见', thrust:'推力', torpedo_attack:'鱼雷攻击', weight:'重量',
  default_morale:'默认士气', recon:'侦察', initiative:'主动性', casualty_trickleback:'伤兵归队', supply_consumption_factor:'补给系数',
  suppression:'镇压', suppression_factor:'镇压系数', experience_loss_factor:'经验损失', equipment_capture_factor:'缴获',
  fuel_capacity:'燃料容量', amphibious_defense:'两栖防御', naval_torpedo_enemy_critical_chance_factor:'敌方鱼雷暴击',
  convoy_raiding_coordination:'破交协同', patrol_coordination:'巡逻协同', search_and_destroy_coordination:'猎潜协同',
  air_visibility_factor:'空中可见性', railway_gun_attack:'列车炮攻击', railway_gun_attack_range:'列车炮射程',
  fuel_consumption_factor:'燃油系数', acclimatization_hot_climate_gain_factor:'炎热习服', acclimatization_cold_climate_gain_factor:'寒冷习服',
}
const MIO_PROD_LOC = {
  production_capacity_factor:'产能', production_conversion_speed_factor:'转换速度', production_cost_factor:'生产成本',
  production_efficiency_cap_factor:'效率上限', production_efficiency_gain_factor:'效率增长', production_resource_need_factor:'资源需求',
  production_resource_penalty_factor:'资源惩罚', production_power_draw_factor:'电力消耗',
}
const MIO_OM_LOC = {
  military_industrial_organization_design_team_assign_cost:'设计组任命成本', military_industrial_organization_design_team_change_cost:'设计组更换成本',
  military_industrial_organization_funds_gain:'资金获取', military_industrial_organization_industrial_manufacturer_assign_cost:'制造商任命成本',
  military_industrial_organization_research_bonus:'研究加成', military_industrial_organization_size_up_requirement:'扩张需求',
  military_industrial_organization_task_capacity:'任务容量',
}
function mioStatCn(k) { return MIO_STAT_LOC[k] || k }
function mioProdCn(k) { return MIO_PROD_LOC[k] || k }
function mioOmCn(k) { return MIO_OM_LOC[k] || k }


const S = {
  features: [],
  byFeature: new Map(),
  installedDlc: [],
  dirGating: [],
  sources: [],
  sources2: [],
  sel: null, // {feature, group, item}
  q: '',
  src: '',
  dlc: '',
  onlyDlc: false,
  total: 0,

  /* ★★★ MIO_TREE_UI:军工机构的链状特质树(替代卡片墙)──
   * 军工机构本质是一张【网格图】:节点有 position(列/行)、有 all_parents/any_parent 连线,
   * 且 include 会继承 generic 底盘。卡片墙把这些关系全压平了,看不出"特质分布"。
   * 所以给军工机构单独走链状视图,像科技树/国策树那样。
   */
  mioOrgs: null,        // 机构清单
  mioStats: null,
  mioOrg: null,         // 当前机构 id
  mioTree: null,        // 当前树的完整数据
  mioSel: null,         // 选中的 token
  mioZoom: 1,
  /* MIO_FILTER_V1:机构清单按模组 / 国家 tag 筛选(只影响左栏列表) */
  mioRoot: '',
  mioTag: '',
  /* POLICY_V2:军工机构「机构树 / 政策」视图切换 */
  mioView: 'tree',
  mioPolicies: null,
  mioPolicySel: null,
}

let tt = null
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(tt)
  tt = setTimeout(() => (el.className = ''), 3600)
}

/* PROGRESS_V1(2026-10-07):钩在 api() 内部,不包装全局函数。
 * 包装全局 api() 有两个坑:①必须插在首次调用之前,插在文件末尾时
 * 首次调用早已跑完,包装完全无效;②重绑定全局标识符容易与文件里
 * 已有的 const/let 同名撞车(SyntaxError: Identifier 'T' has already
 * been declared,整页脚本不执行)。函数体内加钩子没有这两个问题。*/
async function api(u, opt) {
window.LoadGate && window.LoadGate.show("正在加载DLC…")
  // LOADGATE_V1:按功能懒加载 —— 图未就绪(busy)时全屏遮罩并轮询,就绪放行;已缓存页秒回。
  for (;;) {
    let d
    try {
      const r = await fetch(u, opt)
      d = await r.json()
    } catch (e) {
      // 网络中断 / 500 返回非 JSON:收起加载遮罩并回传 error 对象,
      // 走调用方既有的「!d.ready → 失败提示 + 退避重试」分支,
      // 绝不把 LoadGate 永久吊在原地(无限转圈)。
      if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
      window.LoadGate && window.LoadGate.hide()
      return { ready: false, busy: false, error: (e && e.message) || '请求失败' }
    }
    if (d && d.ready === false && d.busy) {
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(`正在构建 DLC 内容图…`) }
      window.LoadGate && window.LoadGate.show(`加载中…`)
      await new Promise((res) => setTimeout(res, 1200))
      continue
    }
    if (api._pg) { api._pg = false; window.Progress && window.Progress.done() }
    window.LoadGate && window.LoadGate.hide()
    return d
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/* ── 图标加载已抽到公共件 /tex.js(原来这里和 decisions.js 各抄了一份,
 *    两份都因为把 sprite 名当 tN id 而全部 404)── */

/* ── 来源筛选器(与 focus/decisions 同一套语义与视觉)── */
function srcLabel(name) {
  return name === 'vanilla' ? '基础游戏' : name
}
function buildSrcSel() {
  const sel = $('#srcSel')
  sel.innerHTML = ''
  const add = (v, label, title) => {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (title) o.title = title
    sel.appendChild(o)
  }
  const sep = (t) => {
    const o = document.createElement('option')
    o.disabled = true
    o.textContent = t
    sel.appendChild(o)
  }
  add('', '全部来源')
  sep('── 生效来源 ──')
  add('base', '基础游戏生效')
  add('mod', '模组生效')
  for (const s of S.sources2.filter((x) => !x.base)) add(s.name, srcLabel(s.name), s.path)
  sel.value = S.src
}
const SRC_HINT = {
  '': '',
  base: '最终生效版本来自基础游戏',
  mod: '最终生效版本来自模组',
}
function srcSummary() {
  const el = $('#srcSum')
  const base = S.sources2.filter((s) => s.base).length
  const mods = S.sources2.filter((s) => !s.base).length
  const parts = []
  if (base) parts.push(`${tr("原版 ")}${base}`)
  if (mods) parts.push(`${tr("模组 ")}${mods}`)
  const hint = SRC_HINT[S.src] !== undefined ? SRC_HINT[S.src] : tr('来源:') + srcLabel(S.src)
  el.textContent = parts.length ? `${tr("来源 ")}${parts.join(' / ')}${hint ? ' · ' + hint : ''}` : ''
  el.title = hint
}

/* ── DLC 筛选 ── */
function buildDlcSel() {
  const sel = $('#dlcSel')
  sel.innerHTML = '<option value="">全部 DLC</option>'
  // 只列「在内容里真的出现过」的 DLC,其余(单位包/主题包等纯内容 DLC)没有可提取结构
  const hit = new Map()
  for (const f of S.features) {
    for (const g of f.groups) {
      for (const it of g.items) {
        for (const d of it.hasDlc) hit.set(d, (hit.get(d) ?? 0) + 1)
      }
    }
  }
  for (const [name, n] of [...hit.entries()].sort((a, b) => b[1] - a[1])) {
    const o = document.createElement('option')
    o.value = name
    o.textContent = `${name} (${n})`
    o.title = tr('按条目自身的 has_dlc = ') + '"' + name + '"' + tr(' 匹配')
    sel.appendChild(o)
  }
  sel.value = S.dlc
}

/* ── 可见性判定 ── */
function srcOk(item) {
  const s = S.src
  if (!s) return true
  if (s === 'base') return item.rootIdx === 0
  if (s === 'mod') return item.rootIdx !== 0
  return item.rootName === s
}
/** 后端 ?src= 已过滤过一次;前端这层只按 rootIdx/rootName 再收一遍,避免两端口径打架 */
function itemVisible(it, rootNames) {
  const s = S.src
  if (!s) return true
  const nm = rootNames[it.root] ?? ''
  if (s === 'base') return nm === 'vanilla'
  if (s === 'mod') return nm !== 'vanilla'
  return nm === s
}

function matchQ(it) {
  const q = S.q
  if (!q) return true
  return (
    it.id.toLowerCase().includes(q) ||
    (it.loc || '').toLowerCase().includes(q) ||
    (it.descLoc || '').toLowerCase().includes(q)
  )
}
function matchDlc(it) {
  if (S.onlyDlc && !it.hasDlc.length) return false
  if (S.dlc && !it.hasDlc.includes(S.dlc) && it.dlc !== S.dlc) return false
  return true
}

/* ── 加载 ── */
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function load() {
  const _fq = new URLSearchParams(location.search).get('feature')
  const qp = new URLSearchParams()
  if (S.src) qp.set('src', S.src)
  const d = await api('/api/dlc/content' + (qp.toString() ? '?' + qp : ''))
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
    _retry++
    setTimeout(load, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  S.features = d.features || []
  S.byFeature = new Map(S.features.map((f) => [f.id, f]))
  S.installedDlc = d.installedDlc || []
  S.dirGating = d.dirGating || []
  S.sources2 = d.sources || []
  S.total = d.totals?.items ?? 0
  /* ★ OWNERSHIP_V1:总数是生效集(同名条目被模组替换后只算一次) */
  S.own = d.own || null
  $('#statChip').textContent = `${S.total}${tr(" 条内容 / ")}${d.totals?.features ?? 0}${tr(" 玩法 / ")}${S.installedDlc.length}${tr(" 个 DLC")}`
  $('#statChip').title = Own.statsLine(S.own)
  if (d.missing?.length) {
    console.warn('[dlc] 注册表里声明但目录不存在(可能 DLC 未购买):', d.missing)
  }
  buildSrcSel()
  buildDlcSel()
  srcSummary()
  renderFeatList()
  renderFeatBar()
  if (!_fq) renderDlcList()
  renderGroups()
  renderSum()
  /* 本地化预取 */
  const _locKeys = []
  for (const f of S.features) for (const g of f.groups) for (const it of g.items) {
    if (it.loc && !_locKeys.includes(it.loc)) _locKeys.push(it.loc)
    if (it.descLoc && !_locKeys.includes(it.descLoc)) _locKeys.push(it.descLoc)
  }
  if (_locKeys.length) Loc.load(_locKeys).then(() => {
    /* ★ MIO_FIX:军工机构页左栏/中间面板走专属渲染(renderMioOrgList/renderMioStage),
       本地化加载完的回调若再跑 renderFeatItemsList 会把机构列表覆盖成"DLC 玩法条目
       (完整路径分组、无机构树/政策按钮)"——即实测的机构列表混分组 bug。 */
    if (S.sel && S.sel.feature === 'mio') return
    renderFeatItemsList(); renderGroups(); if (S.sel && S.sel.item) renderInsp()
  })
  /* DLC_SPLIT_V1:支持 /dlc?feature=mio|special_projects|factions 直达对应玩法(首页/导航三入口) */
  if (_fq && S.byFeature.has(_fq)) {
    document.body.classList.add('single', 'feat-' + _fq)
    S.sel = { feature: _fq, group: null, item: null }
    if (_fq === 'mio') {
      S.mioOrg = null; S.mioTree = null; S.mioSel = null
      $('#dlcList').innerHTML = ''
      if (!S.mioOrgs) mioLoadOrgs($('#groups'))
      else { renderMioOrgList(); renderMioStage($('#groups')) }
      $('#dlcTitle').textContent = '机构列表'
    } else {
      S.mioOrg = null; S.mioTree = null; S.mioSel = null
      $('#dlcTitle').textContent = (S.byFeature.get(_fq) || {}).label || '已安装 DLC'
      renderFeatItemsList()
    }
    renderFeatList(); renderFeatBar(); renderGroups(); renderInsp()
  }
}

/* ── 左侧:玩法列表 ── */
function renderFeatList() {
  const box = $('#featList')
  box.innerHTML = ''
  $('#featCount').textContent = String(S.features.length)
  for (const f of S.features) {
    const el = document.createElement('div')
    el.className = 'item' + (S.sel && S.sel.feature === f.id ? ' on' : '')
    el.innerHTML = `<span>${esc(f.label)}</span> <span class="tag">${f.count}</span>`
    el.title = `${f.dir}\nDLC: ${f.dlc}`
    // ★ 数据挂元素(RIGHTCLICK_V2 统一约定,右键/快捷键不按文本反查)
    el.__obj = { _k: 'feature', f }
    el.onclick = () => {
      // ★ 必须无条件设置 S.sel:首次进入时 S.sel 为 null,
      //    若用 `if(S.sel){...}` 守卫会导致 S.sel 保持 null,
      //    使 renderGroups 走 else 分支(显示全部玩法卡片墙 + 不收起 featBar)。
      S.sel = { feature: f.id, group: S.sel ? S.sel.group : null, item: null }
      // ★ 军工机构:左栏从"DLC 清单"切成"机构清单",舞台走链状特质树
      if (f.id === 'mio') {
        S.mioOrg = null; S.mioTree = null; S.mioSel = null
        if (!S.mioOrgs) mioLoadOrgs($('#groups'))
        else { renderMioOrgList(); renderMioStage($('#groups')) }
        $('#dlcTitle').textContent = '机构列表'
      } else {
        S.mioOrg = null; S.mioTree = null; S.mioSel = null
        $('#dlcTitle').textContent = '已安装 DLC'
        renderDlcList()
      }
      renderFeatList()
      renderFeatBar()
      renderGroups()
      renderInsp()
    }
    box.appendChild(el)
  }
}

/* ── DLC 清单 ── */
function renderDlcList() {
  const box = $('#dlcList')
  box.innerHTML = ''
  $('#dlcCount').textContent = String(S.installedDlc.length)
  // 统计每个 DLC 命中了多少条内容(按目录门控清单 + 条目 has_dlc)
  const hit = new Map()
  for (const f of S.features) for (const g of f.groups) for (const it of g.items) for (const d of it.hasDlc) hit.set(d, (hit.get(d) ?? 0) + 1)
  for (const g of S.dirGating) for (const d of g.dlcs) if (!hit.has(d)) hit.set(d, 0)
  const rows = S.installedDlc
    .map((d) => ({ ...d, n: hit.get(d.name) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  for (const d of rows) {
    const el = document.createElement('div')
    el.className = 'drow' + (d.n ? ' hit' : '')
    el.innerHTML =
      `<span class="nm">${esc(d.name)}</span>` +
      (d.category ? `<span class="cat">${esc(d.category)}</span>` : '') +
      `<span class="ct">${d.n || ''}</span>`
    el.title = `${d.dir}${d.n ? `\n内容命中 ${d.n} 条` : '\n该 DLC 未引入可提取的 common 玩法结构'}`
    el.__obj = { _k: 'dlc', d }
    if (d.n) {
      el.style.cursor = 'pointer'
      el.onclick = () => {
        S.dlc = S.dlc === d.name ? '' : d.name
        $('#dlcSel').value = S.dlc
        load()
      }
    }
    box.appendChild(el)
  }
}

/* ── 顶部:玩法切换条 ── */
function renderFeatBar() {
  const bar = $('#featBar')
  bar.innerHTML = ''
  for (const f of S.features) {
    const el = document.createElement('div')
    const on = !S.sel || S.sel.feature === f.id
    el.className = 'feat' + (on ? ' on' : '') + (f.dlc && f.dlc !== '(多 DLC)' ? ' dlc' : '')
    el.innerHTML =
      (f.dlc ? `<span class="ftag">${esc(f.dlc)}</span>` : '') +
      `<div class="fn">${esc(f.label)}</div>` +
      `<div class="fd">common/${esc(f.dir)}</div>` +
      `<div class="fc">${f.count}${tr(" 条 · ")}${f.groups.length}${tr(" 组")}${f.present ? '' : ' · 目录缺失'}</div>`
    el.title = `DLC: ${f.dlc}${tr("\\n数据目录: common/")}${f.dir}${tr("\\n文件 ")}${f.stats.files}${tr(" 个 / 条目自身声明 has_dlc 的 ")}${f.stats.withHasDlc}${tr(" 条")}`
    el.__obj = { _k: 'featbar', f }
    el.onclick = () => {
      S.sel = { feature: f.id, group: null, item: null }
      renderFeatList()
      renderFeatBar()
      renderGroups()
      renderInsp()
    }
    bar.appendChild(el)
  }
  // MIO_FILTER_V1:模组/tag 下拉只在军工机构玩法下显示
  syncMioFilters()
}

/* ── 主区:分组卡片墙 ── */
function rootNames() {
  return S.sources2.map((s) => s.name)
}
/* 渲染单元 → DOM。因为是按顺序追加的,用一个闭包变量记住"当前 .cards",
 * 卡片型的单元直接挂进去,就能重建出原来的「组标题 + 卡片墙」层级。 */
let _curCards = null
function makeGroupUnit(u) {
  if (u.t === 'grp') {
    const wrap = document.createElement('div')
    wrap.className = 'grp'
    const h = document.createElement('div')
    h.className = 'grp-h'
    h.innerHTML = `<span>${esc(u.f.label)} · ${esc(u.g.label)}</span><span class="n">${u.g.count}</span>`
    const cards = document.createElement('div')
    cards.className = 'cards'
    wrap.appendChild(h)
    wrap.appendChild(cards)
    _curCards = cards
    return wrap
  }
  const it = u.it
  const f = u.f
  const g = u.g
  const el = document.createElement('div')
  el.className = 'card' + (S.sel && S.sel.item === it.id && S.sel.feature === f.id ? ' on' : '') + (it.effectiveRoot !== it.root ? ' ovr' : '')
  const hasIcon = !!it.icon
  const badges = []
  if (it.hasDlc.length) badges.push(`<span class="mini dlc" title="${esc(it.hasDlc.join(', '))}">DLC</span>`)
  if (it.gated) badges.push('<span class="mini" title="有 available/visible/allowed 条件">有条件</span>')
  for (const k of Object.keys(it.strs || {})) badges.push(`<span class="mini g" title="${esc(k)}">${esc(String(it.strs[k]).split('.').pop())}</span>`)
  el.innerHTML =
    `<div class="top">` +
    (hasIcon ? `<img class="ic" data-tex="${esc(it.icon)}" alt="">` : `<div class="ic ph">◇</div>`) +
    `<div class="nm">${(it.loc && Loc.text(it.loc)) ? Loc.label(it.loc, 30) : esc(it.loc || it.id)}</div></div>` +
    `<div class="id">${esc(it.id)}</div>` +
    (badges.length ? `<div class="mt">${badges.join('')}</div>` : '')
  el.title = `${it.id}${it.loc ? `\n本地化: ${it.loc}` : ''}\n${it.file}:${it.line}`
  // ★ 数据挂元素:卡片墙是 incr.js 分批建的,事件委托是唯一稳的接法
  el.__obj = { _k: 'item', it, f, g }
  el.onclick = () => {
    S.sel = { feature: f.id, group: g.id, item: it.id }
    renderGroups()
    renderInsp()
  }
  // 已挂进 _curCards,返回 null 让 incr.js 跳过(否则会被再 append 一次,
  // 等于从 .cards 里挪到容器根部 —— 组层级就没了)
  if (_curCards) _curCards.appendChild(el)
  return null
}

function renderFeatItemsList() {
  const box = $('#dlcList')
  box.innerHTML = ''
  const f = S.byFeature.get(S.sel.feature)
  if (!f) { box.innerHTML = '<div class="empty">无内容</div>'; return }
  const _grps = new Map()
  for (const g of f.groups) {
    for (const it of g.items) {
      const key = it.file || it.root || '(未知)'
      if (!_grps.has(key)) _grps.set(key, [])
      _grps.get(key).push({ it, g })
    }
  }
  if (!_grps.size) { box.innerHTML = '<div class="empty">无条目</div>'; return }
  for (const [_fn, _arr] of _grps) {
    const _grp = document.createElement('div')
    _grp.className = 'mio-grp'
    const _gh = document.createElement('div')
    _gh.className = 'mio-grp-head'
    _gh.textContent = _fn + ' (' + _arr.length + ')'
    _gh.onclick = () => _grp.classList.toggle('fold')
    const _gb = document.createElement('div')
    _gb.className = 'mio-grp-body'
    _grp.appendChild(_gh); _grp.appendChild(_gb)
    box.appendChild(_grp)
    for (const { it, g } of _arr) {
      const el = document.createElement('div')
      el.className = 'item' + (S.sel.item === it.id ? ' on' : '')
      const _locK = it.loc || it.id
      const nm = Loc.text(_locK) ? Loc.label(_locK, 30) : (it.loc || it.id || '?')
      const dl = (it.hasDlc && it.hasDlc.length) ? ' <span class="tag dlc">DLC</span>' : ''
      el.innerHTML = '<span>' + esc(nm) + '</span>' + dl
      el.title = it.id + '\n' + (it.file || '') + ':' + (it.line ?? '')
      el.__obj = { _k: 'featItem', it, g, f }
      el.onclick = () => {
        S.sel = { feature: f.id, group: g.id, item: it.id }
        renderFeatItemsList()
        renderGroups()
        renderInsp()
      }
      _gb.appendChild(el)
    }
  }
}

function renderGroups() {
  const box = $('#groups')
  box.innerHTML = ''
  // ★ 军工机构走链状特质树 —— 它本质是网格图,卡片墙会把父子关系压平
  if (S.sel && S.sel.feature === 'mio') {
    // MIO 树是独立框架,把 DLC 页的"上一级框架"(玩法切换条)收起来,避免共存
    const fb = $('#featBar')
    if (fb) fb.style.display = 'none'
    renderMioStage(box)
    return
  }
  // 非 MIO:恢复玩法切换条
  const fb2 = $('#featBar')
  if (fb2) fb2.style.display = ''
  const names = rootNames()
  const list = S.sel ? S.features.filter((f) => f.id === S.sel.feature) : S.features
  /* PERF_V2:1852 条内容一次建完会明显卡。这里把「组标题 + 卡片」展平成一个
   * 渲染单元序列,交给 incr.js 分批建 DOM(滚到底才建下一批)。 */
  const units = []
  let shown = 0
  for (const f of list) {
    for (const g of f.groups) {
      const items = g.items.filter((it) => matchQ(it) && matchDlc(it) && itemVisible(it, names))
      if (!items.length) continue
      shown += items.length
      units.push({ t: 'grp', f: f, g: g })
      for (const it of items) units.push({ t: 'card', f: f, g: g, it: it })
    }
  }
  if (!shown) {
    box.innerHTML = '<div class="empty">没有符合筛选条件的内容</div>'
  } else {
    _curCards = null
    Incr.mount(box, units, makeGroupUnit, {
      batch: 160,
      // 图标懒加载要按批挂:一次性 mount 到整个 box 会漏掉后建的节点
      onBatch: () => Tex.mount(box),
    })
  }
  $('#sum').innerHTML =
    `${tr("<span>显示 <b>")}${shown}</b> / ${S.total}${tr(" 条</span>")}` +
    (S.dlc ? `<span>DLC = ${esc(S.dlc)}</span>` : '') +
    (S.onlyDlc ? '<span>仅 DLC 专属</span>' : '') +
    (S.q ? `${tr("<span>搜索「")}${esc(S.q)}」</span>` : '')
}

/* ══════════════════════════════════════════════════════════════════
 * ★★★ 军工机构链状特质树(MIO_TREE_UI)
 *
 * 为什么军工机构不能继续用卡片墙:它在游戏里就是一张【网格图】——
 *   · 每个特质占一格(position = {x 列 y 行})
 *   · all_parents(全满足)/ any_parent(任一满足) 决定解锁 = 连线
 *   · include 继承 generic 底盘(那些节点同样可见、同样参与解锁)
 * 卡片墙把这些关系全压平成"一堆条目",完全看不出特质分布与解锁链。
 *
 * 坐标由后端算好(相对位置按 relative_position_id 逐级累加),前端只画。
 * ══════════════════════════════════════════════════════════════════ */

const MIO_NW = 74, MIO_NH = 74, MIO_PADX = 130, MIO_PADY = 70

/** 拉机构清单(左栏) */
async function mioLoadOrgs(box) {
  try {
    const d = await api('/api/mio/tree')
    if (!d.ready) { setTimeout(() => mioLoadOrgs(box), 1200); return }
    S.mioOrgs = d.orgs || []
    S.mioStats = d.stats
    renderMioOrgList()
    renderMioStage($('#groups'))
  } catch (e) {
    box.innerHTML = tr('<div class="empty">军工机构加载失败:') + esc(String(e)) + '</div>'
  }
}

/** 拉单棵特质树 */
async function mioLoadTree() {
  try {
    const d = await api('/api/mio/tree?org=' + encodeURIComponent(S.mioOrg))
    if (!d.ready) { setTimeout(mioLoadTree, 1200); return }
    S.mioTree = d
    S.mioSel = null
    /* 本地化:机构 id 与 trait token 都是 localisation key
       (实测 GER_porsche_organization → "$porsche$",GER_mio_trait_hoesch_facilities → "Hoesch Facilities")。
       $xxx$ 是游戏内变量引用,Loc.label 会识别并提示,不直接显示。 */
    /* 列标题文本也是 localisation key(如 mio_header_chassis),一并拉回来 */
    const hdrTexts = (d.columns || []).map((c) => c.text).filter(Boolean)
    Loc.load([S.mioOrg, ...hdrTexts, ...(d.nodes || []).flatMap((n) => (n.name ? [n.token, n.name] : [n.token]))]).then(() => {
      renderMioStage($('#groups'))
      renderInsp()
    })
    renderMioStage($('#groups'))
    renderInsp()
  } catch (e) {
    $('#groups').innerHTML = tr('<div class="empty">特质树加载失败:') + esc(String(e)) + '</div>'
  }
}

/** 机构文件名 → 国家 tag:MIO_FILTER_V1。
 *  `.../GER_organization.txt` → GER;`00_generic_organization.txt` → GENERIC;
 *  `00_DEBUG_organization.txt` → DEBUG。推导规则稳定,不硬编清单。 */
function mioTagOf(o) {
  const base = String(o.file || '').split(/[\\/]/).pop().replace(/\.txt$/i, '')
  const m = base.match(/^(?:\d+_)?([A-Za-z][A-Za-z0-9]*)_organization$/)
  return (m ? m[1] : base).toUpperCase()
}

/** 模组/tag 下拉:只在军工机构玩法下显示,选项来自当前机构清单 */
function syncMioFilters() {
  const rs = $('#mioRootSel')
  const ts = $('#mioTagSel')
  const isMio = !!(S.sel && S.sel.feature === 'mio')
  rs.style.display = isMio ? '' : 'none'
  ts.style.display = isMio ? '' : 'none'
  if (!isMio) return
  const list = S.mioOrgs || []
  const roots = new Map()
  const tags = new Map()
  for (const o of list) {
    const rn = o.rootName || 'vanilla'
    roots.set(rn, (roots.get(rn) || 0) + 1)
    const tg = mioTagOf(o)
    tags.set(tg, (tags.get(tg) || 0) + 1)
  }
  const fill = (sel, cur, head, map) => {
    sel.innerHTML = ''
    const head0 = document.createElement('option')
    head0.value = ''
    head0.textContent = head
    sel.appendChild(head0)
    for (const [k, n] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const o = document.createElement('option')
      o.value = k
      o.textContent = `${k} (${n})`
      sel.appendChild(o)
    }
    // 当前选择若已不在候选里(来源变了),重置
    sel.value = map.has(cur) ? cur : ''
    if (sel === rs) S.mioRoot = rs.value
    else S.mioTag = ts.value
  }
  fill(rs, S.mioRoot, '全部模组', roots)
  fill(ts, S.mioTag, '全部国家', tags)
}

/* ══════════════════════════════════════════════════════════════════
 * ★★★ POLICY_V2:MIO 政策视图(common/.../policies/_documentation.md)
 * 玩家可为每个 MIO 附加 1 个政策,拿额外加成。与机构树并列的第二个视图:
 *   左栏按文件分组列政策;中间面板显示选中政策的完整配置。
 * ══════════════════════════════════════════════════════════════════ */
function mioModeBar(active) {
  const bar = document.createElement('div')
  bar.className = 'mio-modebar'
  bar.style.cssText = 'display:flex;gap:6px;padding:6px 4px;border-bottom:1px solid var(--line,#e3e3e3);margin-bottom:4px'
  const mk = (lab, v) => {
    const b = document.createElement('button')
    b.className = 'mio-mode' + (active === v ? ' on' : '')
    b.textContent = lab
    b.style.cssText = 'flex:1;padding:4px 0;border:1px solid var(--line,#ddd);border-radius:4px;cursor:pointer;background:var(--bg,#fff);font-size:12px'
    if (active === v) { b.style.background = 'var(--acc,#4a6cf7)'; b.style.color = '#fff'; b.style.borderColor = 'var(--acc,#4a6cf7)' }
    b.onclick = function () { if (S.mioView === v) return; S.mioView = v; S.mioSel = null; S.mioPolicySel = null; if (v === 'policies') { renderMioPolicyList(); renderMioPolicies($('#groups')) } else { renderMioOrgList(); renderMioStage($('#groups')) } renderInsp() }
    return b
  }
  bar.appendChild(mk('机构树', 'tree')); bar.appendChild(mk('政策', 'policies'))
  return bar
}

async function mioLoadPolicies() {
  try {
    const d = await api('/api/mio/policies')
    if (!d.ready) { setTimeout(mioLoadPolicies, 1200); return }
    S.mioPolicies = d.policies || []
    S.mioPolicySel = null
    renderMioPolicyList()
    renderMioPolicies($('#groups'))
    renderInsp()
  } catch (e) {
    $('#groups').innerHTML = tr('<div class="empty">政策加载失败:') + esc(String(e)) + '</div>'
  }
}

function renderMioPolicyList() {
  const box = $('#dlcList'); if (!box) return
  syncMioFilters()
  box.innerHTML = ''
  box.appendChild(mioModeBar('policies'))
  renderMioPolicyListBody(box)
}

function renderMioPolicyListBody(box) {
  const list = S.mioPolicies || []
  $('#dlcCount').textContent = String(list.length)
  if (!list.length) { box.innerHTML += '<div class="empty">暂无政策</div>'; return }
  const q = S.q.trim().toLowerCase()
  const rows = list.filter((pl) => !q || pl.token.toLowerCase().includes(q) || (pl.name || '').toLowerCase().includes(q))
  const _grps = new Map()
  for (const pl of rows) {
    const fn = String(pl.file).split(/[\\/]/).pop().replace(/\.txt$/i, '').replace(/^_/, '').replace(/_policies$/i, '')
    const gn = (fn === '_' ? '' : fn) || '通用'
    if (!_grps.has(gn)) _grps.set(gn, [])
    _grps.get(gn).push(pl)
  }
  for (const [gn, ps] of _grps) {
    const _grp = document.createElement('div'); _grp.className = 'mio-grp'
    const _gh = document.createElement('div'); _gh.className = 'mio-grp-head'
    _gh.textContent = gn + tr(' 政策 (') + ps.length + ')'
    _gh.onclick = () => _grp.classList.toggle('fold')
    const _gb = document.createElement('div'); _gb.className = 'mio-grp-body'
    _grp.appendChild(_gh); _grp.appendChild(_gb); box.appendChild(_grp)
    for (const pl of ps) {
      const el = document.createElement('div')
      el.className = 'item' + (S.mioPolicySel === pl.token ? ' on' : '')
      const dl = pl.hasDlc.length ? ' <span class="tag dlc">DLC</span>' : ''
      const nm = (pl.name && Loc.text(pl.name)) ? Loc.label(pl.name, 24) : (Loc.text(pl.token) ? Loc.label(pl.token, 24) : pl.token)
      const _ic = pl.icon ? '<img class="picon" data-tex="' + esc(pl.icon) + '" alt="">' : ''
      el.innerHTML = _ic + '<span>' + esc(nm) + '</span><span class="tag">' + (pl.cost != null ? pl.cost + 'PP' : '') + '</span>' + dl
      el.title = pl.token + (pl.cost != null ? '\ncost: ' + pl.cost : '') + (pl.cooldown != null ? '\ncooldown: ' + pl.cooldown : '') + '\n' + pl.file + ':' + pl.line
      el.__obj = { _k: 'mioPolicy', pl }
      el.onclick = function () { S.mioPolicySel = (S.mioPolicySel === pl.token) ? null : pl.token; renderMioPolicyList(); renderMioPolicies($('#groups')); renderInsp() }
      _gb.appendChild(el)
    }
  }
  if (!S._mioPolLocTried) { S._mioPolLocTried = 1; Loc.load(rows.flatMap((pl) => (pl.name ? [pl.token, pl.name] : [pl.token]))).then(() => { if (document.querySelector('.mio-grp')) renderMioPolicyList() }) }
  /* 挂载政策列表图标(列表项 data-tex img → gfx 纹理) */
  Tex.mount(box)
}

function renderMioPolicies(box) {
  if (!box) return
  if (!S.mioPolicies) {
    box.innerHTML = tr('<div class="empty">正在加载政策…</div>')
    if (!S._mioPolTried) { S._mioPolTried = 1; mioLoadPolicies() }
    return
  }
  const pl = (S.mioPolicies || []).find((x) => x.token === S.mioPolicySel)
  const nm = pl && (pl.name && Loc.text(pl.name)) ? Loc.label(pl.name, 40) : (pl ? (Loc.text(pl.token) ? Loc.label(pl.token, 40) : esc(pl.token)) : '')
  box.innerHTML = tr('<div class="empty">政策详情显示在右侧「属性」面板<br>') +
    (pl ? '<span style="color:var(--ink);font-weight:650">' + nm + '</span><br>' : '') +
    tr('<span style="color:var(--ink3)">共 ') + (S.mioPolicies.length) + tr(' 个政策</span></div>')
}

/* ── 政策详情(右栏属性面板):图标 + 生效条件(美观) + 三类加成分行 ── */
function renderMioPolicyInsp(box) {
  if (!box) return
  if (!S.mioPolicies) { box.innerHTML = tr('<div style="color:var(--ink3);padding:6px 11px">正在加载政策…</div>'); return }
  const pl = (S.mioPolicies || []).find((x) => x.token === S.mioPolicySel)
  if (!pl) { box.innerHTML = tr('<div style="color:var(--ink3);padding:6px 11px">左侧选择一个政策查看详情</div>'); return }
  const kv = (k, v) => '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'
  const gateRow = (name, val) => '<div class="mio-gate"><span class="mg-n">' + esc(name) + '</span><code class="mg-v">' + esc(val) + '</code></div>'
  const plIc = pl.icon ? '<img class="pol-icon" data-tex="' + esc(pl.icon) + '" alt="">' : ''
  let h = '<div class="ih"><div class="t">' + plIc + ((pl.name && Loc.text(pl.name)) ? Loc.label(pl.name, 40) : (Loc.text(pl.token) ? Loc.label(pl.token, 40) : esc(pl.token))) + '</div>'
  h += '<div class="s">' + esc(pl.token) + '</div></div>'
  if (pl.cost != null) h += kv('cost(PP)', String(pl.cost))
  if (pl.cooldown != null) h += kv('cooldown', pl.cooldown + tr(' 天'))
  if (pl.gates && (pl.gates.allowed || pl.gates.visible || pl.gates.available)) {
    h += tr('<h4>生效条件</h4>')
    if (pl.gates.allowed) h += gateRow('allowed', pl.gates.allowed)
    if (pl.gates.available) h += gateRow('available', pl.gates.available)
    if (pl.gates.visible) h += gateRow('visible', pl.gates.visible)
  }
  const eqb = pl.equipmentBonus || {}
  if (Object.keys(eqb).length) {
    h += tr('<h4>装备属性 Equipment Stats(按装备类型)</h4>')
    for (const [eq, stats] of Object.entries(eqb)) {
      h += '<div class="lnk any"><b>' + esc(eq) + '</b></div>'
      for (const [sk, sv] of Object.entries(stats)) {
        h += '<div class="kv"><span>' + esc(mioStatCn(sk)) + '</span><b>' + (sv > 0 ? '+' : '') + (Math.round(sv * 1000) / 10) + '% ' + mioStatTag(sk) + '</b></div>'
      }
    }
  }
  const pb2 = pl.productionBonus || {}
  if (Object.keys(pb2).length) {
    h += tr('<h4>生产加成 Production bonuses(按装备类型)</h4>')
    for (const [eq, stats] of Object.entries(pb2)) {
      h += '<div class="lnk any"><b>' + esc(eq) + '</b></div>'
      for (const [sk, sv] of Object.entries(stats)) {
        h += '<div class="kv"><span>' + esc(mioProdCn(sk)) + '</span><b>' + (sv > 0 ? '+' : '') + (Math.round(sv * 1000) / 10) + '%</b></div>'
      }
    }
  }
  const om2 = pl.organizationModifier || {}
  if (Object.keys(om2).length) {
    h += tr('<h4>机构修正 Organisation modifiers</h4>')
    for (const [k, v] of Object.entries(om2)) {
      const wl = MIO_ORG_MODS.includes(k)
      h += kv(mioOmCn(k) + (wl ? '' : ' ⚠非白名单'), (v > 0 ? '+' : '') + (Math.round(v * 1000) / 10) + '%')
    }
  }
  if (pl.onAdd) h += tr('<h4>on_add(附加时)</h4><div class="note">') + esc(pl.onAdd) + '</div>'
  if (pl.onRemove) h += tr('<h4>on_remove(移除时)</h4><div class="note">') + esc(pl.onRemove) + '</div>'
  if (pl.aiWillDo) h += tr('<h4>AI 权重</h4><div class="note">') + esc(pl.aiWillDo) + '</div>'
  if (pl.hasDlc && pl.hasDlc.length) h += tr('<h4>DLC 门控</h4><div class="note dl">') + esc(pl.hasDlc.join(', ')) + '</div>'
  h += tr('<h4>来源</h4>') + kv('文件', pl.file.split(/[\\/]/).pop()) + kv('行号', String(pl.line))
  box.innerHTML = h
  Tex.mount(box)
}

/** 左侧机构列表(只在军工机构玩法下出现) */
function renderMioOrgList() {
  const box = $('#dlcList')
  if (!box) return
  syncMioFilters()
  box.innerHTML = ''
  box.appendChild(mioModeBar('tree'))
  if (S.mioView === 'policies') return renderMioPolicyListBody(box)
  const list = S.mioOrgs || []
  $('#dlcCount').textContent = String(list.length)
  const q = S.q.trim().toLowerCase()
  /* id 或译文任一命中即保留 —— 用户看到的是译文,搜的往往也是译文 */
  const rows = list.filter((o) => {
    if (q && !(o.id.toLowerCase().includes(q) || (o.loc || o.name || '').toLowerCase().includes(q) || Loc.text(o.id).toLowerCase().includes(q) || (Loc.text(o.loc || o.name || '').toLowerCase().includes(q)))) return false
    // MIO_FILTER_V1:模组 / 国家 tag 筛选
    if (S.mioRoot && (o.rootName || 'vanilla') !== S.mioRoot) return false
    if (S.mioTag && mioTagOf(o) !== S.mioTag) return false
    return true
  })
  // 有 DLC 门控的排前面(更值得看),其余按名字
  rows.sort((a, b) => (b.hasDlc.length - a.hasDlc.length) || a.id.localeCompare(b.id))
  /* 机构 id 就是 localisation key(实测 GER_porsche_organization → "$porsche$")。
     一次把可见行的 key 全拉回来,渲染时同步读缓存。 */
  if (!S._mioOrgLocTried) { S._mioOrgLocTried = 1; Loc.load(rows.flatMap((o) => (o.loc || o.name ? [o.id, o.loc || o.name] : [o.id]))).then(() => { if (document.querySelector(".mio-grp")) renderMioOrgList() }) }
  const _grps = new Map()
  for (const o of rows) {
    const _fn = String(o.file || '').split(/[\\/]/).pop() || '(未知文件)'
    if (!_grps.has(_fn)) _grps.set(_fn, [])
    _grps.get(_fn).push(o)
  }
  for (const [_fn, _os] of _grps) {
    const _grp = document.createElement('div')
    _grp.className = 'mio-grp'
    const _gh = document.createElement('div')
    _gh.className = 'mio-grp-head'
    _gh.textContent = _fn + ' (' + _os.length + ')'
    _gh.onclick = () => _grp.classList.toggle('fold')
    const _gb = document.createElement('div')
    _gb.className = 'mio-grp-body'
    _grp.appendChild(_gh); _grp.appendChild(_gb)
    box.appendChild(_grp)
    for (const o of _os) {
    const el = document.createElement('div')
    el.className = 'item' + (S.mioOrg === o.id ? ' on' : '')
    const dl = o.hasDlc.length ? ' <span class="tag dlc">DLC</span>' : ''
    /* 有译文用译文,没有退回 id 去后缀(老行为)。
     * ⚠ MIO_SPELLING_V1(2026-10-06):后缀正则原来只认美式 `_organization`,
     *   英式 `_organisation` / 复数 / `_MIO` 的机构会显示成一长串原始 id,
     *   在列表里根本认不出来(实测模组 44 个机构里 31 个是英式)。
     *   三种拼写都要剥,顺带把 `_MIO` 也去掉。 */
    const _loc = o.loc || o.name; const orgLoc = (_loc && Loc.text(_loc)) ? _loc : o.id
    const nm = Loc.text(orgLoc) ? Loc.label(orgLoc, 30) : o.id.replace(/_org[ai]nisations?$|_mio$/i, '')
    el.innerHTML = '<span>' + esc(nm) + '</span>' +
      '<span class="tag">' + o.count + '</span>' + dl +
      /* ★ OWNERSHIP_V1:机构归属三态(模组的机构 = 新增,原版被改写的 = 改写) */
      (Own.of(o) === 'vanilla' ? '' : Own.badge(o))
    el.title = o.id +
      (o.loc ? '\nname: ' + o.loc : '') +
      (o.equipmentType && o.equipmentType.length ? '\nequipment_type: ' + o.equipmentType.join(', ') : '') +
      (o.researchCategories && o.researchCategories.length ? '\nresearch_categories: ' + o.researchCategories.join(', ') : '') +
      (o.researchBonus != null ? '\nresearch_bonus: ' + o.researchBonus : '') +
      (o.taskCapacity != null ? '\ntask_capacity: ' + o.taskCapacity : '') +
      (o.aiWillDo ? '\nai_will_do: ' + o.aiWillDo : '') +
      (o.background ? '\nbackground: ' + o.background : '') +
      (o.initialTrait ? '\ninitial_trait: ' + o.initialTrait : '') +
      (o.orgEvents && o.orgEvents.length ? '\n事件: ' + o.orgEvents.join(', ') : '') +
      (o.removeTraits && o.removeTraits.length ? '\nremove_trait: ' + o.removeTraits.join(', ') : '') +
      (o.gates && o.gates.allowed ? '\nallowed: ' + o.gates.allowed : '') +
      (o.gates && o.gates.visible ? '\nvisible: ' + o.gates.visible : '') +
      (o.gates && o.gates.available ? '\navailable: ' + o.gates.available : '') +
      (Loc.text(orgLoc) ? '\n' + Loc.label(orgLoc) : '') +
      tr('\n归属: ') + Own.label(o) + ' — ' + Own.hint(o) +
      tr('\n本国新增 ') + (o.ownTraits ?? 0) + tr(' 个 / 继承 ') + (o.count - (o.ownTraits ?? 0)) + tr(' 个') +
      (o.includes.length ? '\ninclude: ' + o.includes.join(', ') : '') +
      (o.hasDlc.length ? '\nDLC: ' + o.hasDlc.join(', ') : '') +
      '\n' + o.file + ':' + o.line
    el.__obj = { _k: 'mioOrg', o }
    el.onclick = () => {
      S.mioOrg = o.id
      renderMioOrgList()
      mioLoadTree()
    }
      _gb.appendChild(el)
    }
  }
  if (!rows.length) box.innerHTML = '<div class="empty">没有匹配的机构</div>'
}

/** 渲染链状树到舞台(★ MIO_TREE_FRAME:军工机构走自己的独立框架,不再混在 DLC 卡片墙里) */
function renderMioStage(box) {
  if (!box) return
  if (S.mioView === 'policies') return renderMioPolicies(box)
  // ★ 替换而非追加:本函数会被 mioLoadTree 调两次(即时一次 + Loc.load 完成后一次),
  //    若不先清掉上一帧,会叠出两份 frame,导致节点/连线翻倍(验证里 24 vs 12 即此因)。
  const prev = box.querySelector('.mio-frame')
  if (prev) prev.remove()
  if (!S.mioOrgs) {
    box.innerHTML = '<div class="empty">正在加载军工机构…</div>'
    mioLoadOrgs(box)
    return
  }
  if (!S.mioOrg) {
    box.innerHTML = tr('<div class="empty">左侧选择一个机构,查看它的特质树<br>') +
      tr('<span style="color:var(--ink3)">共 ') + (S.mioOrgs.length) + tr(' 个机构 / ') +
      ((S.mioStats && S.mioStats.traits) || 0) + tr(' 个特质节点</span></div>')
    return
  }
  const T = S.mioTree
  if (!T || T.org !== S.mioOrg) {
    box.innerHTML = '<div class="empty">正在加载特质树…</div>'
    if (S.mioOrg) mioLoadTree()
    return
  }
  /* ★ 起始节点(继承 generic 的 initial trait,如 generic_mio_initial_trait_*_designer)从树中移除,
   *   其属性信息通过点击上方标题栏获取 */
  const _initTok = (n) => (T.initialTrait && n.token === T.initialTrait) || /^generic_mio_initial_trait_/i.test(n.token)
  const _initT = (T.nodes || []).find(_initTok)
  const nodes = (T.nodes || []).filter((n) => !_initTok(n))
  if (!nodes.length) {
    box.innerHTML = '<div class="empty">该机构没有符合筛选条件的特质</div>'
    return
  }

  let maxX = 0, maxY = 0
  for (const n of nodes) { if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y }
  const W = MIO_PADX * 2 + maxX + MIO_NW
  const H = MIO_PADY * 2 + maxY + MIO_NH

  /* ── 独立外框:标题栏(机构名 / 继承 / DLC)+ 滚动主体。
   *    这样军工机构树有"单独的框架显示",不再与 DLC 页的玩法切换条(上一级框架)共存。 */
  const frame = document.createElement('div')
  frame.className = 'mio-frame'
  const head = document.createElement('div')
  head.className = 'mio-frame-head'
  if (T.icon) {
    const im = document.createElement('img')
    im.className = 'mio-ficon'
    im.dataset.tex = T.icon
    head.appendChild(im)
  }
  const ttl = document.createElement('div')
  ttl.className = 'mio-ftitle'
  ttl.textContent = Loc.text(T.org) ? Loc.label(T.org, 30) : T.org.replace(/_organization$/, '')
  head.appendChild(ttl)
  const meta = document.createElement('div')
  meta.className = 'mio-fmeta'
  const metaParts = [nodes.length + tr(' 特质')]
  if (T.includes && T.includes.length) metaParts.push(tr('继承 ') + T.includes.length + tr(' 个底盘'))
  if (T.hasDlc && T.hasDlc.length) metaParts.push('DLC: ' + T.hasDlc.join(', '))
  if (T.total && T.total !== nodes.length) metaParts.push(tr('总 ') + T.total)
    if (T.initialTrait) metaParts.push(tr('起始: ') + (Loc.text(T.initialTrait) ? Loc.label(T.initialTrait, 16) : T.initialTrait))
  meta.textContent = metaParts.join(' · ')
  head.appendChild(meta)
  const lg = document.createElement('div')
  lg.className = 'mio-legend'
  lg.innerHTML = '<span class="ln"></span>全满足解锁<span class="ln any"></span>任一满足'
  head.appendChild(lg)
  /* 起始节点已从树中移除:点击标题栏查看其属性 */
  if (_initT) {
    head.style.cursor = 'pointer'
    head.title = tr('查看起始特质属性: ') + _initT.token
    head.onclick = function () {
      S.mioSel = '__mio_header__'
      renderMioStage(box)
      renderInsp()
    }
  }
  frame.appendChild(head)

  const view = document.createElement('div')
  view.className = 'mio-view'
  const inner = document.createElement('div')
  inner.className = 'mio-inner'
  inner.style.width = W + 'px'
  inner.style.height = H + 'px'
  inner.style.transform = 'scale(' + (S.mioZoom || 1) + ')'

  /* 列标题 = 本机构自己的【框架 / 段落】(tree_header_text),画成竖向分隔 + 标签,
   * 让"框架"显式可见,而不是所有特质挤在一张无分区的网格里。 */
  const secs = document.createElement('div')
  secs.className = 'mio-secs'
  for (const c of T.columns || []) {
    const s = document.createElement('div')
    s.className = 'mio-sec'
    s.style.left = (MIO_PADX + c.x) + 'px'
    const lab = document.createElement('div')
    lab.className = 'mio-sec-lab'
    lab.textContent = Loc.text(c.text) ? Loc.label(c.text, 30) : c.text
    s.appendChild(lab)
    secs.appendChild(s)
  }
  inner.appendChild(secs)

  // 继承层(上一级 generic 底盘)示意:仅当 inherited 节点局部聚集(不铺满整图)时画边界
  const gen = nodes.filter((n) => n.fromGeneric)
  if (gen.length) {
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity
    for (const n of gen) {
      gx0 = Math.min(gx0, n.x); gy0 = Math.min(gy0, n.y)
      gx1 = Math.max(gx1, n.x + MIO_NW); gy1 = Math.max(gy1, n.y + MIO_NH)
    }
    const cover = (gx1 - gx0) * (gy1 - gy0)
    if (cover < (W - MIO_PADX * 2) * (H - MIO_PADY * 2) * 0.8) {
      const zone = document.createElement('div')
      zone.className = 'mio-genzone'
      zone.style.left = (MIO_PADX + gx0 - 8) + 'px'
      zone.style.top = (MIO_PADY + gy0 - 8) + 'px'
      zone.style.width = (gx1 - gx0 + 16) + 'px'
      zone.style.height = (gy1 - gy0 + 16) + 'px'
      const cap = document.createElement('div')
      cap.className = 'mio-genzone-cap'
      cap.textContent = '继承自通用底盘(上一级框架)'
      zone.appendChild(cap)
      inner.appendChild(zone)
    }
  }

  // 连线(画在节点下层):★ 每个 parent 都画一条(水平/垂直/斜向三条规则 + 互斥线)
  const posOf = new Map()
  for (const n of nodes) posOf.set(n.token, n)
  const findParent = (token) => posOf.get(token)
  const edgeKey = (a, b) => (a.token < b.token ? a.token + '>' + b.token : b.token + '>' + a.token)
  const seenEdge = new Set()
  // 两条特质的连线关系:
  //   1) 同一水平层 -> 直接水平相连(0 个折线弯)
  //   2) 不同水平层: 同一垂直层 -> 直接垂直相连(0 个折线弯)
  //   3) 不同水平层且不同垂直层 -> 先向下半层,再横到对方正上方,最后向下(2 个折线弯)
  const appendLink = (pn, n, cls, titleText) => {
    const k = edgeKey(pn, n)
    if (seenEdge.has(k)) return
    seenEdge.add(k)
    const P = pn, C = n
    const hh = MIO_NH / 2
    const cxm = (t) => MIO_PADX + t.x + MIO_NW / 2
    const cyB = (t) => MIO_PADY + t.y + MIO_NH
    const cyT = (t) => MIO_PADY + t.y
    let d
    if (Math.abs(P.y - C.y) < 0.5) {
      const my = MIO_PADY + P.y + hh
      const L = P.x < C.x ? P : C
      const R = P.x < C.x ? C : P
      d = 'M' + (MIO_PADX + L.x + MIO_NW) + ' ' + my + 'L' + (MIO_PADX + R.x) + ' ' + my
    } else if (Math.abs(P.x - C.x) < 0.5) {
      const T = P.y < C.y ? P : C
      const B = P.y < C.y ? C : P
      d = 'M' + cxm(T) + ' ' + cyB(T) + 'L' + cxm(B) + ' ' + cyT(B)
    } else {
      const T = P.y < C.y ? P : C
      const B = P.y < C.y ? C : P
      const ax = cxm(T), ay = cyB(T)
      const bx = cxm(B), by = cyT(B)
      const my = Math.max(ay + 6, Math.min(ay + hh, by - 4))
      d = 'M' + ax + ' ' + ay + 'L' + ax + ' ' + my + 'L' + bx + ' ' + my + 'L' + bx + ' ' + by
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('class', cls)
    path.setAttribute('fill', 'none')
    if (titleText) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      t.textContent = titleText
      path.appendChild(t)
    }
    svg.appendChild(path)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'mio-links')
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  for (const n of nodes) {
    for (const lk of n.links || []) {
      for (const pid of lk.parents) {
        const pn = findParent(pid)
        if (!pn) { console.warn('[mio] 父节点缺失(未下发):', n.token, '<-', pid); continue }
        appendLink(pn, n, lk.type === 'all' ? 'ln' : 'ln any', lk.parents.length > 1 ? ((lk.type === 'all' ? '需全部:' : tr('任一:')) + lk.parents.join(', ')) : '')
      }
    }
    if (n.parentNum && n.parentNum.traits.length) {
      for (const pid of n.parentNum.traits) {
        const pn = findParent(pid)
        if (!pn) { console.warn('[mio] 父节点缺失(未下发):', n.token, '<-', pid); continue }
        appendLink(pn, n, 'ln any', tr('至少 ') + n.parentNum.numNeeded + tr(' 个: ') + n.parentNum.traits.join(', '))
      }
    }
    if (n.mutuallyExclusive && n.mutuallyExclusive.length) {
      for (const m of n.mutuallyExclusive) {
        const mn = findParent(m)
        if (!mn) { console.warn('[mio] 互斥节点缺失(未下发):', n.token, '<->', m); continue }
        appendLink(n, mn, 'ln mutex', tr('互斥: ') + m)
      }
    }
  }
  inner.appendChild(svg)

  // 节点
  for (const n of nodes) {
    const d = document.createElement('div')
    d.className = 'mio-n'
    if (S.mioSel === n.token) d.classList.add('on')
    if (n.fromGeneric) d.classList.add('inh')
    if (n.specialBg) d.classList.add('sp')
    if (n.hasDlc && n.hasDlc.length) d.classList.add('dlc')
    d.style.left = (MIO_PADX + n.x) + 'px'
    d.style.top = (MIO_PADY + n.y) + 'px'
    d.style.width = MIO_NW + 'px'
    d.style.height = MIO_NH + 'px'
    /* 显示名:有本地化就用译文,没有退回短 token(老行为)。
       短 token 只在"查不到译文"时用 —— 译文优先,否则用户看不到真实名称。 */
    const tk = (n.name && Loc.text(n.name)) ? n.name : n.token
    const hasLoc = !!Loc.text(tk)
    const short = hasLoc
      ? Loc.label(tk, 26)
      : n.token.replace(/^(generic_|GER_|USA_|[A-Z]{3}_)/, '').replace(/_mio_trait_?/, '') || n.token
    /* 特质节点只显示图标 + 名称;属性(装备/生产/组织加成)一律放到检查器看。 */
    d.innerHTML = (n.icon
      ? '<img data-tex="' + esc(n.icon) + '" alt="">'
      : '<div class="ph">◇</div>') +
      '<div class="tt">' + esc(short) + '</div>'
    d.title = n.token +
      (hasLoc ? '\n' + Loc.text(tk) : '') +
      tr('\n列 ') + n.gx + tr(' / 行 ') + n.gy +
      (n.relTo ? tr('\n网格基准: ') + n.relTo : '') +
      (n.links.length ? tr('\n解锁: ') + n.links.map(function (l) {
        return (l.type === 'all' ? '全部(' : tr('任一(')) + l.parents.join(', ') + ')'
      }).join(' / ') : '') +
      (n.parentNum ? tr('\n父节点(至少 ') + n.parentNum.numNeeded + tr(' 个): ') + n.parentNum.traits.join(', ') : '') +
      (n.onCompleteText ? tr('\n完成事件: ') + n.onCompleteText : '') +
      (n.gates && n.gates.visible ? '\nvisible: ' + n.gates.visible : '') +
      (n.gates && n.gates.available ? '\navailable: ' + n.gates.available : '') +
      (n.limitTo && n.limitTo.length ? tr('\n限装备: ') + n.limitTo.join(', ') : '') +
      (n.hasDlc.length ? '\nDLC: ' + n.hasDlc.join(', ') : '') +
      (n.fromGeneric ? '\n(继承自 generic 底盘)' : '') +
      '\n' + n.file + ':' + n.line
    d.__obj = { _k: 'mioNode', n }
    d.onclick = function () {
      S.mioSel = (S.mioSel === n.token) ? null : n.token
      renderMioStage(box)
      renderInsp()
    }
    inner.appendChild(d)
  }

  view.appendChild(inner)
  frame.appendChild(view)
  box.appendChild(frame)
  // ★ 外框整体挂图标(标题栏机构图标 + 节点图标)
  Tex.mount(frame)

  $('#sum').innerHTML =
    '<span><b>' + esc(T.org.replace(/_organization$/, '')) + '</b></span>' +
    '<span>' + nodes.length + tr(' 特质') + (T.total && T.total !== nodes.length ? ' / ' + T.total : '') + '</span>' +
    (T.includes && T.includes.length ? tr('<span>继承 ') + T.includes.length + tr(' 个 generic 底盘</span>') : '') +
    (T.hasDlc && T.hasDlc.length ? '<span>DLC: ' + esc(T.hasDlc.join(', ')) + '</span>' : '')
}

/** 选中节点时,右栏展示它的加成明细(替代 renderInsp 的条目视图) */
function renderMioInsp(box) {
  if (!S.mioTree) { box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一个特质</div>'; return }
  const T0 = S.mioTree
  const kv = (k, v) => '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'
  /* ── 机构元信息块 ── */
  const orgHtml = () => {
    let ho = '<div class="ih"><div class="t">' + (Loc.text(T0.org) ? Loc.label(T0.org, 40) : T0.org) + '</div>'
    ho += '<div class="s">机构元信息（点选一个特质查看加成）</div></div>'
    ho += kv('id', T0.org)
    if (T0.name) ho += kv('name', T0.name)
    if (T0.icon) ho += kv('icon', T0.icon)
    if (T0.background) ho += kv('background', T0.background)
    if (T0.equipmentType && T0.equipmentType.length) ho += kv('equipment_type', T0.equipmentType.join(', '))
    if (T0.researchCategories && T0.researchCategories.length) ho += kv('research_categories', T0.researchCategories.join(', '))
    if (T0.researchBonus != null) ho += kv('research_bonus', T0.researchBonus)
    if (T0.taskCapacity != null) ho += kv('task_capacity', T0.taskCapacity)
    if (T0.aiWillDo) ho += kv('ai_will_do', T0.aiWillDo)
    if (T0.gates) {
      if (T0.gates.allowed) ho += kv('allowed', T0.gates.allowed)
      if (T0.gates.visible) ho += kv('visible', T0.gates.visible)
      if (T0.gates.available) ho += kv('available', T0.gates.available)
    }
    if (T0.initialTrait) ho += kv('initial_trait', Loc.text(T0.initialTrait) ? Loc.label(T0.initialTrait, 30) : T0.initialTrait)
    if (T0.orgEvents && T0.orgEvents.length) ho += kv('事件键', T0.orgEvents.join(', '))
    if (T0.removeTraits && T0.removeTraits.length) ho += kv('remove_trait', T0.removeTraits.join(', '))
    if (T0.deleteIncluded && T0.deleteIncluded.length) ho += kv('delete_included_values', T0.deleteIncluded.join(', '))
    if (T0.includes && T0.includes.length) ho += kv('include 底盘', T0.includes.join(', '))
    if (T0.hasDlc && T0.hasDlc.length) ho += kv('DLC 门控', T0.hasDlc.join(', '))
    ho += kv('归属', Own.label(T0) + (Own.hint(T0) ? ' — ' + Own.hint(T0) : ''))
    if (T0.defs && T0.defs.length) {
      ho += tr('<h4>定义现场(覆盖链)</h4>')
      for (const d of T0.defs) ho += '<div class="note">' + esc((d.rootName || ('root' + d.root)) + '  ' + String(d.file).split(/[\\/]/).pop() + ':' + d.line) + '</div>'
    }
    if (T0.overrides && T0.overrides.length) {
      ho += tr('<h4>override_trait(覆盖继承) ') + T0.overrides.length + tr(' 处</h4>')
      for (const o of T0.overrides.slice(0, 40)) {
        const fs = []
        if (o.pos) fs.push('位置'); if (o.bonus) fs.push('装备'); if (o.productionBonus) fs.push('生产'); if (o.organizationModifier) fs.push('组织'); if (o.name) fs.push('名'); if (o.icon) fs.push('图标'); if (o.mutuallyExclusive) fs.push('互斥'); if (o.deleteIncluded) fs.push('del'); if (o.gates || o.hasAvailable || o.hasVisible) fs.push('条件')
        ho += '<div class="note">' + esc(o.token + ' → ' + ((fs.join('、')) || '仅位置') + ' @ ' + String(o.file).split(/[\\/]/).pop() + ':' + o.line) + '</div>'
      }
    }
    ho += tr('<h4>节点统计</h4>') + kv('总数', String(T0.total != null ? T0.total : (T0.nodes || []).length)) + kv('本列表', String((T0.nodes || []).length))
    return ho
  }
  /* ── 单个特质属性块 ── */
  const traitHtml = (n) => {
    let h = '<div class="ih"><div class="t">' + Loc.rich(n.token, { maxLen: 40 }) + '</div>'
    h += '<div class="s">' + Loc.rich(T0.org, { maxLen: 30 }) +
      (n.fromGeneric ? ' · 继承自 generic' : tr(' · 本国新增')) + '</div></div>'
    h += '<div class="kv"><span>token</span><b>' + esc(n.token) + '</b></div>'
    const ovr = (T0.overrides || []).find((o) => o.token === n.token)
    if (ovr) {
      const flds = []
      if (ovr.pos) flds.push('位置')
      if (ovr.bonus) flds.push('装备加成')
      if (ovr.productionBonus) flds.push('生产加成')
      if (ovr.organizationModifier) flds.push('组织加成')
      if (ovr.name) flds.push('名称')
      if (ovr.icon) flds.push('图标')
      if (ovr.mutuallyExclusive) flds.push('互斥')
      if (ovr.deleteIncluded) flds.push('delete_included_values')
      if (ovr.gates || ovr.hasAvailable || ovr.hasVisible) flds.push('条件')
      h += tr('<h4>override 覆盖</h4><div class="note">') + esc((flds.join('、') || '仅位置') + ' — ' + ovr.file.split(/[\\/]/).pop() + ':' + ovr.line) + '</div>'
    }
    h += tr('<h4>位置</h4>')
    h += kv('网格 列/行', n.gx + ' / ' + n.gy)
    h += kv('像素 画布', Math.round(n.x) + ', ' + Math.round(n.y))
    if (n.relTo) h += kv('网格基准', n.relTo) + tr('<div class="note">position 是相对该节点的格子偏移，不是相对树原点</div>')
    if (n.links.length) {
      h += tr('<h4>解锁条件</h4>')
      for (const lk of n.links) {
        h += '<div class="lnk ' + lk.type + '"><b>' + (lk.type === 'all' ? '全部满足' : tr('任一满足')) + '</b>' +
          lk.parents.map((p) => '<code>' + esc(p) + '</code>').join(' ') + '</div>'
      }
    } else h += tr('<div class="note">无前置条件（起始节点）</div>')
    if (n.parentNum && n.parentNum.traits.length) {
      h += tr('<h4>父节点(至少 ') + n.parentNum.numNeeded + tr(' 个)</h4>')
      h += '<div class="lnk any"><b>' + tr('至少 ') + n.parentNum.numNeeded + tr(' 个满足') + '</b> ' +
        n.parentNum.traits.map((p) => '<code>' + esc(p) + '</code>').join(' ') + '</div>'
    }
    if (n.limitTo && n.limitTo.length) { h += tr('<h4>限装备类型</h4><div class="note">') + esc(n.limitTo.join(', ')) + '</div>' }
    const om = n.organizationModifier || {}
    const ok = Object.keys(om)
    if (ok.length) {
      h += tr('<h4>机构修正 Organisation modifiers</h4>')
      for (const k of ok) {
        const wl = MIO_ORG_MODS.includes(k)
        h += kv(mioOmCn(k) + (wl ? '' : ' ⚠非白名单'), (om[k] > 0 ? '+' : '') + (Math.round(om[k] * 1000) / 10) + '%')
      }
      h += tr('<div class="note">白名单 7 个 MIO 专属 modifier;非白名单项可能无效</div>')
    }
    if (n.deleteIncluded && n.deleteIncluded.length) h += tr('<h4>delete_included_values</h4><div class="note">') + esc(n.deleteIncluded.join(', ')) + tr('(include/override 时回默认)</div>')
    if (n.mutuallyExclusive && n.mutuallyExclusive.length) h += tr('<h4>互斥特质</h4><div class="note">') + esc(n.mutuallyExclusive.join(', ')) + '</div>'
    let conds = []
    if (n.hasVisible) conds.push('visible')
    if (n.hasAvailable) conds.push('available')
    if (conds.length) h += tr('<h4>条件</h4><div class="note">') + conds.join(', ') + '</div>'
    if (n.gates) {
      if (n.gates.allowed) h += kv('allowed', n.gates.allowed)
      if (n.gates.visible) h += kv('visible', n.gates.visible)
      if (n.gates.available) h += kv('available', n.gates.available)
    }
    if (n.onCompleteText) h += tr('<h4>完成事件</h4><div class="note">') + esc(n.onCompleteText) + '</div>'
    else if (n.onComplete) h += tr('<h4>完成事件</h4><div class="note">on_complete</div>')
    if (n.aiWillDo) h += tr('<h4>AI 权重</h4><div class="note">') + esc(n.aiWillDo) + '</div>'
    if (n.hasDlc && n.hasDlc.length) h += tr('<h4>DLC 门控</h4><div class="note dl">') + esc(n.hasDlc.join(', ')) + '</div>'
    const bonus = n.bonus || {}
    const bk = Object.keys(bonus)
    if (bk.length) {
      h += tr('<h4>装备属性 Equipment Stats</h4>')
      for (const k of bk) h += kv(mioStatCn(k), (bonus[k] > 0 ? '+' : '') + (Math.round(bonus[k] * 1000) / 10) + '%  ' + mioStatTag(k))
    }
    const pb = n.productionBonus || {}
    const pk = Object.keys(pb)
    if (pk.length) {
      h += tr('<h4>生产加成 Production bonuses</h4>')
      for (const k of pk) h += kv(mioProdCn(k), (pb[k] > 0 ? '+' : '') + (Math.round(pb[k] * 1000) / 10) + '%')
    }
    h += tr('<h4>来源</h4>') + kv('文件', n.file.split(/[\\/]/).pop()) + kv('行号', n.line)
    if (n.icon) h += tr('<h4>图标</h4><div class="note">') + esc(n.icon) + '</div>'
    return h
  }
  /* ── 标题栏点击:机构元信息 + 起始节点属性合并 ── */
  if (S.mioSel === '__mio_header__') {
    const initT = (T0.nodes || []).find((x) => (T0.initialTrait && x.token === T0.initialTrait) || /^generic_mio_initial_trait_/i.test(x.token))
    let h = orgHtml()
    if (initT) {
      h += '<div class="ih" style="margin-top:12px"><div class="t">' + Loc.rich(initT.token, { maxLen: 30 }) + '</div><div class="s">继承自 generic 起始特质</div></div>'
      h += traitHtml(initT)
    }
    box.innerHTML = h
    return
  }
  const n = (T0.nodes || []).find((x) => x.token === S.mioSel)
  if (n) { box.innerHTML = traitHtml(n); return }
  if (S.mioOrg && T0.org === S.mioOrg) { box.innerHTML = orgHtml(); return }
  box.innerHTML = tr('<div style="color:var(--ink3);padding:6px 11px">点选一个特质查看加成<br>') +
    tr('<span style="font-size:11px">共 ') + (T0.nodes || []).length + tr(' 个节点</span></div>')
}

function renderSum() {
  const g = S.dirGating || []
  const el = $('#sum')
  const top = g.slice(0, 3).map((x) => `${x.dir}(${x.hits})`)
  if (top.length) el.title = tr('DLC 门控最密集的目录:') + top.join(' / ')
}

/* ── 检查器 ── */
function renderInsp() {
  const box = $('#insp')
  // ★ 军工机构:右栏展示选中特质的加成明细(链状树视图)
  if (S.sel && S.sel.feature === 'mio') {
    if (S.mioView === 'policies') { renderMioPolicyInsp(box); return }
    renderMioInsp(box); return
  }
  if (!S.sel || !S.sel.item) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">点选一条内容</div>'
    return
  }
  const f = S.byFeature.get(S.sel.feature)
  if (!f) return
  let it = null
  let grp = null
  for (const g of f.groups) for (const x of g.items) if (x.id === S.sel.item) { it = x; grp = g }
  if (!it) {
    box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">条目已不在当前筛选结果中</div>'
    return
  }
  const kv = (k, v) => (v ? `<div class="kv"><b>${esc(k)}</b><span>${v}</span></div>` : '')
  const names = rootNames()
  const srcName = names[it.root] ?? '?'
  let h = ''
  h += `<div style="font-weight:650;word-break:break-all;margin-bottom:3px">${(it.loc && Loc.text(it.loc)) ? Loc.label(it.loc, 40) : esc(it.loc || it.id)}</div>`
  if (it.descLoc) h += `<div style="color:var(--ink2);font-size:12px;line-height:1.5;margin-bottom:6px">${Loc.text(it.descLoc) ? Loc.label(it.descLoc, 60) : esc(it.descLoc)}</div>`
  h += `<div style="color:var(--ink3);font-size:11px;word-break:break-all;margin-bottom:6px">${esc(it.id)}</div>`
  h += kv('玩法', esc(f.label))
  h += kv('DLC', esc(f.dlc))
  h += kv('分组', esc(grp.label))
  h += kv('来源', `${esc(srcName)}`)
  h += kv('位置', `${esc(it.file)}:${it.line}`)
  if (it.icon) h += kv('图标', `<code>${esc(it.icon)}</code>`)

  if (it.hasDlc.length) {
    h += `${tr("<h4>DLC 门控</h4><div>")}${it.hasDlc.map((d) => `<span class="tagr">has_dlc = "${esc(d)}"</span>`).join('')}</div>`
  }
  if (it.macros?.length) {
    h += `${tr("<h4>DLC 专用宏</h4><div>")}${it.macros.map((d) => `<span class="tagr">${esc(d)}</span>`).join('')}</div>`
  }
  const nums = Object.entries(it.nums || {})
  if (nums.length) {
    h += `<h4>数值</h4>` + nums.map(([k, v]) => kv(k, String(v))).join('')
  }
  const strs = Object.entries(it.strs || {})
  if (strs.length) {
    h += `<h4>枚举字段</h4>` + strs.map(([k, v]) => kv(k, `<code>${esc(v)}</code>`)).join('')
  }
  const tags = Object.entries(it.tags || {}).filter(([, v]) => v.length)
  if (tags.length) {
    h += `<h4>列表字段</h4>`
    for (const [k, v] of tags) {
      h += `<div style="margin:2px 0"><span style="color:var(--ink2);font-size:11px">${esc(k)} (${v.length})</span><div>${v
        .slice(0, 24)
        .map((x) => `<span class="tagr">${esc(x)}</span>`)
        .join('')}${v.length > 24 ? `<span class="tagr">…另 ${v.length - 24} 个</span>` : ''}</div></div>`
    }
  }
  const raw = Object.entries(it.raw || {})
  if (raw.length) {
    h += `${tr("<h4>其它字段 ")}${raw.length < it.rawTotal ? `(${raw.length}/${it.rawTotal})` : `(${raw.length})`}</h4>`
    h += raw.map(([k, v]) => kv(k, `<code>${esc(v)}</code>`)).join('')
    if (raw.length < it.rawTotal) h += `${tr("<div class=\"warnrow\">另有 ")}${it.rawTotal - raw.length}${tr(" 个字段未显示</div>")}`
  }
  if (it.gated) {
    h += `<h4>可用性</h4><div class="warnrow">该条目带 available / visible / allowed 条件,并非所有国家 / 状态都可用</div>`
  }
  box.innerHTML = h
}

/* ── 事件 ── */
let qt = null
$('#q').oninput = (e) => {
  S.q = e.target.value.trim().toLowerCase()
  clearTimeout(qt)
  qt = setTimeout(() => {
    renderGroups()
    renderInsp()
    // 军工机构模式下左栏列表也要跟着搜索词收窄
    if (S.sel && S.sel.feature === 'mio' && S.mioOrgs) renderMioOrgList()
  }, 180)
}
$('#srcSel').onchange = (e) => {
  S.src = e.target.value
  load()
}
$('#dlcSel').onchange = (e) => {
  S.dlc = e.target.value
  load()
}
$('#onlyDlc').onchange = (e) => {
  S.onlyDlc = e.target.checked
  load()
}
/* MIO_FILTER_V1:军工机构按模组 / 国家 tag 筛选(纯前端过滤,不需回源) */
$('#mioRootSel').onchange = (e) => {
  S.mioRoot = e.target.value
  renderMioOrgList()
}
$('#mioTagSel').onchange = (e) => {
  S.mioTag = e.target.value
  renderMioOrgList()
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#q')) {
    e.preventDefault()
    $('#q').focus()
  }
})

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

/* ══════════════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V2)
 *
 * dlc 页有**五种**可右键对象,语义完全不同,分开给菜单:
 *   feature 左栏玩法 / dlc 已装 DLC / featbar 顶部玩法卡
 *   item  内容卡片 / mioOrg 军工机构 / mioNode 特质树节点
 *
 * ⚠ 三层来源语义(和 focus/tech 一致,别混):
 *   it.root           条目自己声明在哪个来源
 *   it.effectiveRoot  最终生效的那份来自哪个来源(origin=vanilla 被模组覆盖时,
 *                     两者不同 —— 卡片上的 .ovr 类就是靠它)
 *   rootNames()[i]    来源名数组,下标即 root 序号
 * ══════════════════════════════════════════════════════════════════ */
function wireCtxAndKeys() {
  if (!window.CtxWire || !window.Ctx) return
  const names = () => rootNames()

  /* ── 内容卡片 ── */
  CtxWire.attach({
    page: 'dlc',
    on: [{
      host: '#groups', sel: '.card',
      resolve: (el) => el,
      obj: (el) => {
        const o = el.__obj
        if (!o || o._k !== 'item') return null
        return {
          id: o.it.id,
          loc: o.it.loc,
          file: o.it.file,
          line: o.it.line,
          root: o.it.effectiveRoot,
          rootName: names()[o.it.effectiveRoot] ?? '',
          _o: o,
        }
      },
      items: (o) => {
        const { it, f, g } = o._o
        const extra = []
        const on = S.sel && S.sel.item === it.id && S.sel.feature === f.id
        extra.push({ label: on ? '在属性中查看' : '选中这条内容', k: '→', act: () => {
          S.sel = { feature: f.id, group: g.id, item: it.id }
          renderGroups(); renderInsp()
        } })
        if (it.loc && it.loc !== it.id) {
          extra.push({ label: '复制本地化 key', k: '⧉', act: () => Ctx.copy(it.loc, '') })
        }
        if (it.icon) extra.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(it.icon, '') })
        extra.push({ label: tr('只看这个 DLC(') + f.dlc + ')', k: '→', act: () => {
          if (!S.installedDlc.some((x) => x.name === f.dlc)) {
            Ctx.toast('「' + f.dlc + tr('」不在已安装 DLC 清单里 —— 条目可能只是声明了 has_dlc'), true); return
          }
          S.dlc = f.dlc; $('#dlcSel').value = f.dlc; load()
        } })
        if (it.hasDlc.length) {
          extra.push({ sep: true })
          extra.push({ label: tr('只勾「') + it.hasDlc[0] + tr('」的 DLC 筛选'), k: '→', act: () => {
            S.dlc = it.hasDlc[0]; $('#dlcSel').value = S.dlc; load()
          } })
        }
        if (it.root !== it.effectiveRoot) {
          extra.push({ sep: true })
          extra.push({ title: `${tr("声明在 ")}${names()[it.root] ?? '?'}${tr(",生效的是 ")}${names()[it.effectiveRoot] ?? '?'}` })
          extra.push({ label: '复制覆盖链(两处路径)', k: '⧉', act: () => {
            Ctx.copy(`${names()[it.root] ?? '?'}\t${it.file}:${it.line}`, '')
          } })
        }
        if (it.gated) {
          extra.push({ sep: true })
          extra.push({ title: '该条目带 available / visible / allowed 条件 —— 并非所有国家 / 状态都可用' })
        }
        // 整条内容复制成 KV,方便贴到工单 / 笔记
        extra.push({ sep: true })
        extra.push({ label: '复制整条内容(KV)', k: '⧉', act: () => {
          const kv = [`id = ${it.id}`]
          if (it.loc) kv.push(`loc = ${it.loc}`)
          kv.push(`feature = ${f.id}(${f.label})`, `dlc = ${f.dlc}`, `group = ${g.label}(${g.id})`)
          for (const [k, v] of Object.entries(it.nums || {})) kv.push(`${k} = ${v}`)
          for (const [k, v] of Object.entries(it.strs || {})) kv.push(`${k} = ${v}`)
          for (const [k, v] of Object.entries(it.tags || {})) if (v.length) kv.push(`${k} = ${v.join(', ')}`)
          kv.push(`file = ${it.file}:${it.line}`)
          Ctx.copy(kv.join('\n'), '')
        } })
        return extra
      },
    }],
    keys: [].concat([
      { id: 'find.search', desc: '聚焦搜索框', group: '查找', run: () => { const q = $('#q'); if (q) { q.focus(); q.select && q.select() } } },
      { id: 'nav.nextItem', desc: '下一条卡片', group: '浏览', run: () => stepCard(1) },
      { id: 'nav.prevItem', desc: '上一条卡片', group: '浏览', run: () => stepCard(-1) },
      { id: 'sel.clear', desc: '取消选择 / 清搜索', group: '选中', run: () => {
        if (S.sel && S.sel.item) { S.sel = { ...S.sel, item: null }; renderGroups(); renderInsp(); return }
        if (S.sel && S.sel.feature) { S.sel = null; renderFeatList(); renderFeatBar(); renderGroups(); renderInsp(); return }
        if (S.q) { S.q = ''; $('#q').value = ''; renderGroups(); renderInsp(); if (S.mioOrgs) renderMioOrgList() }
      } },
      { id: 'dlc.onlyDlc', desc: '只看 DLC 专属', group: '筛选', run: () => {
        S.onlyDlc = !S.onlyDlc; $('#onlyDlc').checked = S.onlyDlc; load()
      } },
      { id: 'dlc.clearDlc', desc: '清除 DLC 筛选', group: '筛选', run: () => {
        if (!S.dlc) { Ctx.toast('当前没有 DLC 筛选'); return }
        S.dlc = ''; $('#dlcSel').value = ''; load()
      } },
    ], CtxWire.commonKeys(curItemId, { label: '内容' })),
  })

  /* ── 左栏玩法 / DLC 清单 ── */
  const sideCtx = (host, sel, kind) => Ctx.attach(host, sel, (el) => {
    const o = el.__obj
    if (!o || o._k !== kind) return null
    if (kind === 'feature') {
      const f = o.f
      const on = S.sel && S.sel.feature === f.id
      return [
        { label: on ? '取消玩法筛选' : '只看这个玩法', k: '→', act: () => {
          S.sel = on ? null : { feature: f.id, group: null, item: null }
          renderFeatList(); renderFeatBar(); renderGroups(); renderInsp()
        } },
        { label: '复制玩法 id', k: '⧉', act: () => Ctx.copy(f.id, '') },
        { label: '复制数据目录', k: '⧉', act: () => Ctx.copy('common/' + f.dir, '') },
        { label: '复制统计', k: '⧉', act: () => Ctx.copy(
          `${f.label}\t${f.count}${tr(" 条\\t")}${f.groups.length}${tr(" 组\\t文件 ")}${f.stats.files}\tDLC ${f.dlc}${tr("\\t覆盖 ")}${f.stats.overridden}${tr("\\t新增 ")}${f.stats.modNew}`, '') },
      ]
    }
    const d = o.d
    return [
      { label: S.dlc === d.name ? '清除这个 DLC 筛选' : '只看这个 DLC', k: '→', dis: !d.n, act: () => {
        S.dlc = S.dlc === d.name ? '' : d.name; $('#dlcSel').value = S.dlc; load()
      } },
      { label: '复制 DLC 名', k: '⧉', act: () => Ctx.copy(d.name, '') },
      { label: '复制 DLC 目录', k: '⧉', act: () => Ctx.copy(d.dir, '') },
      { title: d.n ? `${tr("命中 ")}${d.n}${tr(" 条内容")}` : '该 DLC 未引入可提取的 common 玩法结构' },
    ]
  })
  sideCtx('#featList', '.item', 'feature')
  sideCtx('#dlcList', '.drow', 'dlc')

  /* ── 顶部玩法卡 ── */
  Ctx.attach('#featBar', '.feat', (el) => {
    const o = el.__obj
    if (!o || o._k !== 'featbar') return null
    const f = o.f
    const on = !S.sel || S.sel.feature === f.id
    const st = f.stats
    return [
      { title: `${f.label}\ncommon/${f.dir}\nDLC ${f.dlc}` },
      { label: on ? '取消玩法筛选' : '只看这个玩法', k: '→', act: () => {
        S.sel = on ? null : { feature: f.id, group: null, item: null }
        renderFeatList(); renderFeatBar(); renderGroups(); renderInsp()
      } },
      { label: '复制玩法 id', k: '⧉', act: () => Ctx.copy(f.id, '') },
      { label: '复制统计', k: '⧉', act: () => Ctx.copy(
        `${tr("条目 ")}${st.items}${tr("\\n组 ")}${st.groups}${tr("\\n文件 ")}${st.files}${tr("\\n自身带 has_dlc ")}${st.withHasDlc}${tr("\\n被覆盖 ")}${st.overridden}${tr("\\n模组新增 ")}${st.modNew}`, '') },
      { title: f.present ? '' : '⚠ 目录在已挂载来源里不存在' },
    ]
  })

  /* ── 军工机构 ──
   * 单独接,不走 CtxWire 的 on 通道:菜单要按 _k 分派三种对象
   * (机构 / 特质节点),而通道只支持一种 selector。 */
  Ctx.attach('#dlcList', '.item', (el) => {
    const o = el.__obj
    if (!o) return null
    /* ── 政策右键菜单 ── */
    if (o._k === 'mioPolicy') {
      const pl = o.pl
      const on = S.mioPolicySel === pl.token
      const arr = [
        { label: on ? '取消选择' : '查看这个政策', k: '→', act: () => { S.mioPolicySel = on ? null : pl.token; renderMioPolicyList(); renderMioPolicies($('#groups')); renderInsp() } },
        { label: '复制政策 token', k: '⧉', act: () => Ctx.copy(pl.token, '') },
        { label: '复制政策名', k: '⧉', act: () => Ctx.copy(pl.name || pl.token, '') },
      ]
      if (pl.icon) arr.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(pl.icon, '') })
      arr.push({ sep: true })
      arr.push({ label: '复制整条配置(KV)', k: '⧉', act: () => {
        const kv = ['policy = ' + pl.token]
        if (pl.name) kv.push('name = ' + pl.name)
        if (pl.icon) kv.push('icon = ' + pl.icon)
        if (pl.cost != null) kv.push('cost = ' + pl.cost)
        if (pl.gates) { for (const g of ['allowed', 'available', 'visible']) if (pl.gates[g]) kv.push(g + ' = ' + pl.gates[g]) }
        kv.push('file = ' + pl.file + ':' + pl.line)
        Ctx.copy(kv.join('\n'), '')
      } })
      return Ctx.sourceItems({
        /* RIGHTCLOCK:政策右键也支持「在 IDE 中打开 / 用 VS Code 打开」 */
        root: typeof pl.root === 'number' && pl.root >= 0 ? pl.root : -1,
        rootName: (typeof rootNames === 'function' && rootNames()[pl.root]) || '',
        file: pl.file, line: pl.line,
        id: pl.token, loc: pl.token,
        extra: arr,
      })
    }
    /* ── DLC 内容条目右键:在 IDE / VS Code 打开 + 复制(阵营等) ── */
    if (o._k === 'featItem') {
      const it = o.it, f2 = o.f
      const extra = [
        { label: '复制 ID', k: '⧉', act: () => Ctx.copy(it.id, '') },
        { label: '复制本地化键', k: '⧉', act: () => Ctx.copy(it.loc || it.id, '') },
        { label: '复制来源 文件:行', k: '⧉', act: () => Ctx.copy((it.file || '') + ':' + (it.line ?? ''), '') },
        { label: '只看这个分组', k: '→', act: () => { S.sel = { feature: f2.id, group: it.group, item: null }; renderFeatItemsList(); renderGroups(); renderInsp() } },
      ]
      return Ctx.sourceItems({
        root: typeof it.root === 'number' && it.root >= 0 ? it.root : -1,
        rootName: (typeof rootNames === 'function' && rootNames()[it.root]) || '',
        file: it.file, line: it.line,
        id: it.id, loc: it.loc || it.id, extra,
      })
    }
    if (o._k !== 'mioOrg') return null
    const org = o.o
    const on = S.mioOrg === org.id
    const extra = [
      { label: on ? '取消机构筛选' : '查看这个机构的特质树', k: '→', act: () => {
        S.mioOrg = on ? null : org.id
        renderMioOrgList(); mioLoadTree()
      } },
      { label: '复制机构 id', k: '⧉', act: () => Ctx.copy(org.id, '') },
      { label: '复制机构名(去 _organization)', k: '⧉', act: () => Ctx.copy(org.id.replace(/_organization$/, ''), '') },
      { label: '只在搜索框里找它', k: '→', act: () => {
        S.q = org.id.toLowerCase(); $('#q').value = org.id; renderMioOrgList()
      } },
    ]
    if (org.includes.length) {
      extra.push({ sep: true })
      extra.push({ label: tr('复制 include 底盘(') + org.includes.length + ')', k: '⧉', act: () => Ctx.copy(org.includes.join('\n'), '') })
    }
    if (org.hasDlc.length) {
      extra.push({ label: tr('只看 ') + org.hasDlc[0], k: '→', act: () => {
        S.dlc = org.hasDlc[0]; $('#dlcSel').value = S.dlc; load()
      } })
    }
    if (org.rootName && org.rootName !== 'vanilla') {
      extra.push({ sep: true })
      extra.push({ label: tr('只看来自 ') + org.rootName + tr(' 的机构'), k: '→', act: () => {
        S.mioRoot = org.rootName; const s = $('#mioRootSel'); if (s) s.value = org.rootName
        renderMioOrgList()
      } })
    }
    return Ctx.sourceItems({
      // ★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开模组文件失败」):
      //   原先硬编码 `root: -1`(= 无来源),于是 DLC 页的 MIO 机构完全没有
      //   「在 IDE 中打开 / 用 VS Code 打开」—— 用户看到的就是"打不开"。
      //   后端 mio/tree 的 orgs 与 nodes 现在都下发真实 root/rootName。
      root: typeof org.root === 'number' && org.root >= 0 ? org.root : -1,
      rootName: org.rootName || '',
      file: org.file, line: org.line,
      id: org.id, loc: org.id, extra,
    })
  })
  Ctx.attach('#groups', '.mio-n', (el) => {
    const o = el.__obj
    if (!o || o._k !== 'mioNode') return null
    const n = o.n
    const on = S.mioSel === n.token
    const extra = []
    if (n.links && n.links.length) {
      for (const lk of n.links) {
        for (const pid of lk.parents) {
          extra.push({
            label: (lk.type === 'all' ? '跳到前置(需全部) ' : tr('跳到前置(任一) ')) + pid,
            k: '→',
            act: () => { S.mioSel = pid; renderMioStage($('#groups')); renderInsp() },
          })
        }
      }
    }
    if (n.limitTo && n.limitTo.length) {
      extra.push({ sep: true })
      extra.push({ label: '复制限装备清单', k: '⧉', act: () => Ctx.copy(n.limitTo.join('\n'), '') })
    }
    if (n.bonus && Object.keys(n.bonus).length) {
      extra.push({ label: '复制全部加成', k: '⧉', act: () => Ctx.copy(
        Object.entries(n.bonus).map(([k, v]) => `${k} = ${v}`).join('\n'), '') })
    }
    if (n.fromGeneric) {
      extra.push({ sep: true })
      extra.push({ title: '继承自 generic 底盘 —— 改它要改 generic,本体不生效' })
    }
    if (n.icon) extra.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(n.icon, '') })
    return Ctx.sourceItems({
      // ★ RIGHTCLICK_ROOT_V1:同机构菜单,用真实来源(原为 -1 = 打不开)
      root: typeof n.root === 'number' && n.root >= 0 ? n.root : -1,
      rootName: n.rootName || '',
      file: n.file, line: n.line,
      id: n.token, extra,
    })
  })
}

/** 卡片墙里上下移动(左栏是机构列表时改成在机构间移动) */
function stepCard(d) {
  if (S.sel && S.sel.feature === 'mio') {
    const list = [...document.querySelectorAll('#dlcList .item')]
    if (!list.length) return
    const cur = list.findIndex((x) => x.classList.contains('on'))
    const j = cur < 0 ? 0 : cur + d
    if (j < 0 || j >= list.length) return
    list[j].click()
    list[j].scrollIntoView({ block: 'nearest' })
    return
  }
  const list = [...document.querySelectorAll('#groups .card')]
  if (!list.length) return
  const cur = list.findIndex((x) => x.classList.contains('on'))
  const j = cur < 0 ? 0 : cur + d
  if (j < 0 || j >= list.length) return
  list[j].click()
  list[j].scrollIntoView({ block: 'nearest' })
}

function curItemId() {
  if (S.sel && S.sel.item) return S.sel.item
  if (S.sel && S.sel.feature === 'mio' && S.mioSel) return S.mioSel
  if (S.mioOrg) return S.mioOrg
  return null
}

wireCtxAndKeys()
load()
