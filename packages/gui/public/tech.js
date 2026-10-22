/* 科技树可视化:基于 folder.position 的绝对网格坐标渲染。
 *
 * 与国策树不同,科技没有相对坐标:x/y 是绝对网格坐标(列=水平,行=垂直),
 * 边来自 path.leads_to_tech(实线)与 enable_technologies(虚线)。
 * 科技没有图标字段,所以不加载贴图,纯矢量渲染,体量大也跑得动。
 *
 * ── 两级分类体系(2026-10 新增)──
 * 游戏里的科技树是两级结构,数据来自 common/technology_tags/00_technology.txt 的两个块:
 *   technology_categories = { ... }  134 个裸 id —— 顺序表,决定图上左右次序
 *   technology_folders    = { ... }  16 个块     —— 显示分组,带 ledger / doctrine / DLC 门控
 * 科技侧:`categories = { ... }` 归类、`folder = { name = ... }` 归组。
 *
 * 三类需要单独处理的东西(全部实测,见 engine/src/tech.ts 文件头):
 *   1) 无 categories 的科技(实测 73 个)—— 游戏里没有标题栏,单独归组显示。
 *      默认隐藏,勾选「显示隐藏科技」才出现,避免它们混进主分类让人以为漏了内容。
 *   2) ledger = hidden 的文件夹(实测 1 个:special_forces_doctrine_folder)
 *      —— 游戏默认不显示该页签,画布上用不同颜色的标题带标出。
 *   3) 顺序表里有但没科技引用的 category(实测 28 个 doctrine 树容器)
 *      —— 由 script 动态填充,下拉里保留但标注"空",不静默消失。
 * ── ★ 横纵向分布:四个必须处理的实测坑(2026-10 修正)──
 *   坑 A【同格多条科技】实测 58 组同 folder 同坐标,最极端一格塞了 7 条
 *     (bba_air_techs_folder@(0,2))。这是游戏的互斥/DLC 替代排布,**不是脏数据**。
 *     旧版直接画 → 58 组完全重叠成一坨。
 *     修法:同 folder 同坐标的合成【一张卡带】竖向堆叠(N 条 = NH+(N-1)*SOCKH),
 *     行距 YU 按本页最深堆叠动态放大,保证不压下一行。
 *   坑 B【标签压下一行】旧版节点高 NH=40、行距 YU=46,标签却画在 y+NH+10 = y+50,
 *     超出 8px 必然压在下一行框上。修法:标签【行内】画在框内底部,不再外溢。
 *   坑 C【自动补位拉出长条】141 个无 folder.position 的科技若排成单列 x=0,
 *     y 会拉到 140,而其余 folder 只有 20 行 —— 画布纵向被一条无关的长条撑爆。
 *     engine 侧已改成按 category 聚簇 + 5 列网格,并【全局避让】所有 folder 的
 *     显式坐标(只避自己 folder 会精准压到 bba 空军那 7 条真实科技上)。
 *   坑 D【跨 folder 同坐标】★ 最隐蔽的一个。实测 95 个 (x,y) 被多个 folder 同时占用,
 *     铺在一张画布上产生 **518 处真重叠**(air_techs_folder@(0,2) 的 early_fighter
 *     会和 bba_air_techs_folder@(0,2) 的 7 条 + artillery_folder 的 interwar_artillery
 *     画在完全相同的像素上)。
 *     根因:忽略了游戏里科技树是【一页一页翻】的 —— 各 technology_folders 页签
 *     共用同一套 x/y 坐标但**不同屏显示**,所以跨页签撞格在游戏里根本不会同时出现。
 *     修法:① 胶囊栏第 1 行做页签切换(默认 infantry_folder);
 *          ② 渲染时按当前可见集的坐标范围做平移归一(与游戏"每页独立居中"一致)。
 *
 * ── ★ 默认视图:先看步兵(2026-10)──
 *   585 个科技一次全铺开没法读(缩放会掉到 0.2,完全看不清)。
 *   默认选中 页签=infantry_folder + 领域=infantry_weapons → 13 个科技一屏读完。
 */
const $ = (s) => document.querySelector(s)
const SVGNS = 'http://www.w3.org/2000/svg'

/* ── 坐标比例 ──
 * ★ TECHLAYOUT_GUI_V1:节点位置不再用自定 XU/YU 间距,直接用 engine 按
 * countrytechtreeview.gui(gridbox 原点 + position×slotsize)算好的像素坐标。
 * NW/NH 是卡片尺寸;无 gui 布局的 folder 用 SLOT_DEF 兜底格。 */
const NW = 88 // 节点宽
const NH = 64 // ★ 单条节点高(放大:图标 46 顶部 + 下方名称)
const ICON = 46 // ★ 节点图标边长(放大,居中于卡片顶部,名称在其下)
const SOCKH = 12 // 同格堆叠时每条占高(坑 A)
const SLOT_DEF = 70 // ★ 兜底格宽高(游戏 slotsize 绝大多数 70×70)

/** ★ 默认视图:先看步兵(用户 2026-10 明确要求"应该先展示步兵的") */
const DEFAULT_AREA = 'infantry_weapons'
/** ★ 默认页签 = 步兵所在的 folder(游戏里科技树也是一页一页翻的) */
const DEFAULT_FOLDER = 'infantry_folder'

const S = {
  nodes: [],
  edges: [],
  byId: new Map(),
  allNodes: [],
  allEdges: [],
  areas: [],
  categories: [],
  folders: [],
  slots: [],
  /** ★ TECHGRAPH_V1:起始科技树分组(服务端 buildTechTrees 算好) */
  techTrees: [],
  slotIndex: new Map(), // techId → {slot, i, n}
  crossFolder: new Map(), // "x,y" → [folderId...] 该格被哪些页签占用(坑 D)
  dangling: [],
  sel: null,
  zoom: 1,
  tx: 0,
  ty: 0,
  showLabel: true,
  areaFilter: '',
  folderFilter: '',
  /** ★ TECHGRAPH_V1:选中的起始科技(= 一个科技树页签) */
  treeFilter: '',
  showHidden: false,
  onlyDangling: false,
  /** HIDDENTECH_V1: 显示无 folder.position 的隐藏科技(单独条目视图)。 */
  hiddenView: false,
  showBands: true,
  /** 东亚排序用:folder 声明顺序 */
  folderOrder: [],
  /** tex → data:URL(已解码的 PNG);加载失败则存 null */
  icons: new Map(),
  loading: new Set(),
  /** 检查器「显示详情」开关:展开节点的完整字段 */
  techDetail: false,
  /* ═ TRIGGERS_V1:条件求值 scope + 本树可开关条件清单。
     scope 桶 = {tech, focus, flag, gamerule, tag}(各一个 Set),勾选面板写入,重算显隐。
     惰性初始化:loadGraph 里 window.Trig 就绪后 emptyScope()。 */
  scope: null,
  conditions: [],
}

/* ★ 默认科技图标:内置齿轮 SVG(无网络也能显示),当科技没有 icon 字段,
 *   或该 GFX 贴图加载失败时使用 —— 避免出现破图。 */
/* ═ TECHEFFECT_V1:研究完成效果区块(检查器用)。
 * 数值字段直接显示;复杂块(modifiers/research_bonus/equipment_bonus)以 <pre> 代码块原文展示。 */
function effectsHtml(eff) {
  if (!eff) return ''
  const rows = []
  if (eff.instant) rows.push('<div class="kv"><b>立即完成</b><span>是</span></div>')
  if (eff.researchSpeed !== undefined) rows.push(`<div class="kv"><b>研究速度</b><span>+${esc(eff.researchSpeed)}</span></div>`)
  if (eff.startResearchSkill !== undefined) rows.push(`<div class="kv"><b>起始研究技能</b><span>${esc(eff.startResearchSkill)}</span></div>`)
  if (eff.startXp !== undefined) rows.push(`<div class="kv"><b>起始经验</b><span>${esc(eff.startXp)}</span></div>`)
  if (eff.modifiers) rows.push(`<div class="kv"><b>修正 (modifiers)</b></div><pre class="effpre">${esc(eff.modifiers)}</pre>`)
  if (eff.researchBonus) rows.push(`<div class="kv"><b>研究加成 (research_bonus)</b></div><pre class="effpre">${esc(eff.researchBonus)}</pre>`)
  if (eff.equipmentBonus) rows.push(`<div class="kv"><b>装备加成 (equipment_bonus)</b></div><pre class="effpre">${esc(eff.equipmentBonus)}</pre>`)
  if (eff.onComplete) rows.push(`<div class="kv"><b>研究完成 (on_research_complete)</b></div><pre class="effpre">${esc(eff.onComplete)}</pre>`)
  if (eff.onCompleteLimit) rows.push(`<div class="kv"><b>效果触发条件 (on_research_complete_limit)</b></div><pre class="effpre">${esc(eff.onCompleteLimit)}</pre>`)
  if (eff.pathResearchSpeed) rows.push(`<div class="kv"><b>研究速度 (path.research_speed)</b></div><pre class="effpre">${esc(eff.pathResearchSpeed)}</pre>`)
  if (eff.xpType) {
    const _xp = [eff.xpType, eff.xpBonus !== undefined ? '×' + eff.xpBonus : '', eff.xpCost !== undefined ? '花费 ' + eff.xpCost : ''].filter(Boolean).join(' ')
    rows.push(`<div class="kv"><b>XP 加成</b><span>${esc(_xp)}</span></div>`)
  if (eff.xpUnlockCost !== undefined) rows.push(`<div class="kv"><b>经验直接解锁 (xp_unlock_cost)</b><span>${esc(eff.xpUnlockCost)}</span></div>`)
  }
  if (!rows.length) return ''
  return '<h4>效果</h4>' + rows.join('')
}

/* 隐藏页条目的效果摘要(紧凑版) */
function hidEffectsHtml(eff) {
  if (!eff) return ''
  const parts = []
  if (eff.instant) parts.push('立即完成')
  if (eff.researchSpeed !== undefined) parts.push('研速 +' + eff.researchSpeed)
  if (eff.startResearchSkill !== undefined) parts.push('起始技能 ' + eff.startResearchSkill)
  if (eff.startXp !== undefined) parts.push('起始经验 ' + eff.startXp)
  if (eff.modifiers) parts.push('modifiers ' + (eff.modifiers.split('\\n').length - 2) + ' 项')
  if (eff.researchBonus) parts.push('research_bonus')
  if (eff.equipmentBonus) parts.push('equipment_bonus')
  if (eff.onComplete) parts.push('on_research_complete')
  if (eff.xpType) parts.push(eff.xpType + (eff.xpBonus !== undefined ? ' ×' + eff.xpBonus : ''))
  if (eff.pathResearchSpeed) parts.push('research_speed')
  return parts.length ? `<div class="hid-eff">${esc(parts.join(' · '))}</div>` : ''
}

const DEFAULT_TECH_ICON = (() => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    "<circle cx='16' cy='16' r='8' fill='none' stroke='#8a929e' stroke-width='2.5'/>" +
    "<g fill='#8a929e'>" +
    "<rect x='14' y='2' width='4' height='7' rx='1'/>" +
    "<rect x='14' y='23' width='4' height='7' rx='1'/>" +
    "<rect x='2' y='14' width='7' height='4' rx='1'/>" +
    "<rect x='23' y='14' width='7' height='4' rx='1'/>" +
    "<rect x='5.5' y='5.5' width='6' height='4' rx='1' transform='rotate(45 8.5 7.5)'/>" +
    "<rect x='20.5' y='20.5' width='6' height='4' rx='1' transform='rotate(45 23.5 22.5)'/>" +
    "<rect x='20.5' y='5.5' width='6' height='4' rx='1' transform='rotate(-45 23.5 7.5)'/>" +
    "<rect x='5.5' y='20.5' width='6' height='4' rx='1' transform='rotate(-45 8.5 22.5)'/>" +
    "</g><circle cx='16' cy='16' r='3' fill='#8a929e'/></svg>"
  return 'data:image/svg+xml;base64,' + btoa(svg)
})()

const svg = $('#canvas')
const gRoot = document.createElementNS(SVGNS, 'g')
const gBand = document.createElementNS(SVGNS, 'g')
const gEdge = document.createElementNS(SVGNS, 'g')
const gNode = document.createElementNS(SVGNS, 'g')
/* 给四层挂 id:既是 CSS 钩子,也是自动化验收的唯一可靠抓手。
   ⚠ 这些是顶层 const,不会挂到 window —— 验收脚本不能靠 S.xxx 取,必须查 DOM。 */
gBand.id = 'gBand'
gEdge.id = 'gEdge'
gNode.id = 'gNode'
gRoot.id = 'gRoot'
gRoot.appendChild(gBand)
gRoot.appendChild(gEdge)
gRoot.appendChild(gNode)
svg.appendChild(gRoot)

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
window.LoadGate && window.LoadGate.show("正在加载科技…")
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
      if (!api._pg) { api._pg = true; window.Progress && window.Progress.start(`正在构建科技图…`) }
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
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/** 分组标题带的中文名:technology_folders 的 id 去后缀再翻译,查不到就显示原 id */
const FOLDER_CN = {
  infantry_folder: '步兵',
  support_folder: '支援连',
  armour_folder: '装甲',
  nsb_armour_folder: '装甲(NSB)',
  artillery_folder: '火炮',
  air_techs_folder: '空军',
  bba_air_techs_folder: '空军(BBA)',
  naval_folder: '海军',
  naval_equipment_folder: '海军装备',
  mtgnavalfolder: '海军(MTG)',
  mtgnavalsupportfolder: '海军支援(MTG)',
  electronics_folder: '电子',
  naval_doctrine_folder: '海军学说',
  air_doctrine_folder: '空军学说',
  special_forces_doctrine_folder: '特种部队学说',
  land_doctrine_folder: '陆军学说',
}
const LEDGER_CN = { army: '陆军', air: '空军', navy: '海军', civilian: '民用', hidden: '隐藏' }
function folderName(id) {
  return FOLDER_CN[id] || id.replace(/_folder$/, '')
}

/* ★ TECHGRAPH_V1:科技树页签名。游戏页签显示的是起始科技的可读名,
 * 不是 id(例如 early_naval_theory 显示为"早期海军理论")。
 * loc 表在客户端(LC)里,查不到就退回把 id 的下划线换空格。 */
function techName(id) {
  if (!id) return ''
  if (window.Loc && Loc.text(id)) return Loc.label(id, 20)
  return String(id).replace(/_/g, ' ')
}

/* ── 领域(technology_categories)中文名 ──
 * 顺序表有 133 项,常用的给中文;没列出的显示 id 本名(不猜、不硬编)。
 * 军种/装备大类给全,细分型号与 doctrine 树容器留 id —— 那些没有稳定中文译名。 */
const AREA_CN = {
  // 陆軍
  infantry_weapons: '步兵武器',
  infantry_tech: '步兵技术',
  support_tech: '支援连',
  motorized_equipment: '摩托化',
  armor: '装甲',
  artillery: '火炮',
  cat_anti_tank: '反坦克',
  cat_anti_air: '防空',
  cat_fortification: '筑城',
  cat_armored_cars: '装甲车',
  cat_mechanized_equipment: '机械化',
  // 空军
  light_air: '轻型飞机',
  medium_air: '中型飞机',
  heavy_air: '重型飞机',
  naval_air: '海军航空',
  light_fighter: '轻型战斗机',
  cat_heavy_fighter: '重型战斗机',
  tactical_bomber: '战术轰炸机',
  cat_strategic_bomber: '战略轰炸机',
  naval_bomber: '海军轰炸机',
  cas_bomber: '近距空中支援',
  jet_technology: '喷气技术',
  air_equipment: '空军装备',
  // 海军
  naval_equipment: '海军装备',
  ship_modules_tech: '舰船模块',
  dd_tech: '驱逐舰',
  ca_tech: '巡洋舰',
  cv_tech: '航母',
  bc_tech: '战列巡洋舰',
  bb_tech: '战列舰',
  shbb_tech: '超级战列舰',
  ss_tech: '潜艇',
  tp_tech: '运输舰',
  // 通用
  industry: '工业',
  electronics: '电子',
  rocketry: '火箭',
  nuclear: '核技术',
  construction_tech: '建造',
  excavation_tech: '挖掘',
  encryption_tech: '加密',
  decryption_tech: '解密',
  computing_tech: '计算',
  radar_tech: '雷达',
  synth_resources: '合成资源',
  marine_tech: '陆战队',
}
function areaName(id) {
  return AREA_CN[id] || id
}

/* ── 加载图 ── */
/* PERF_V2:索引异步构建时的重试退避计数(300ms 起步,1.6 倍递增,上限 2.5s) */
let _retry = 0
async function loadGraph() {
  const d = await api('/api/tech/graph')
  if (!d.ready) {
    $('#statChip').textContent = d.busy ? '构建中…' : tr('失败:') + d.error
    _retry++
    setTimeout(loadGraph, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  S.allNodes = d.nodes
  S.allEdges = d.edges
  /* ═ TRIGGERS_V1:新树 → 重置条件 scope,渲染条件面板(对齐国策树)。 */
  S.scope = window.Trig ? window.Trig.emptyScope() : null
  /* GAMERULE_DEFAULT_V1:has_game_rule 按规则默认选项求值(与国策树同源) */
  if (window.Trig) window.Trig.setGameRuleDefaults(d.gameRules || {})
  renderTrigPanel(d.conditions || [])
  /* ★ TECHGRAPH_V1:补上 xor 边。以前 xor 字段根本没解析,互斥科技被画成
     普通并行 leads 线,读图的人以为可以同时研究。MU 用 ⊻ 中转点,
     这里用 kind='xor' 双向虚线,前端按 xorPairs 生成。 */
  if (d.xorPairs && d.xorPairs.length) {
    const has = new Set(S.allEdges.map((e) => e.from + '>' + e.to + '>' + e.kind))
    for (const p of d.xorPairs) {
      const k = p.a + '>' + p.b + '>xor'
      if (has.has(k)) continue
      has.add(k)
      S.allEdges.push({ from: p.a, to: p.b, kind: 'xor' })
    }
  }
  S.areas = d.areas || []
  S.categories = d.categories || []
  S.folders = d.folders || []
  /* ★ TECHLAYOUT_GUI_V1:gui 布局表(folder → gridbox),前端据此画网格 / 算卡片宽 */
  S.guiLayout = new Map()
  for (const lf of d.layout || []) S.guiLayout.set(lf.id, lf)
  S.dangling = d.danglingEdge || []
  S.slots = d.slots || []
  /* ★ TECHGRAPH_V1:起始科技树分组(MU `$s()` 等价)。游戏页签按它切,
     不是按 technology_folders 切 —— 前端优先用 techTrees 建页签。 */
  S.techTrees = d.techTrees || []
  // ★ 建立「科技 → 同格槽位」索引:渲染时据此堆叠(坑 A)
  S.slotIndex = new Map()
  // ★ 多 folder:同一科技在不同 folder 有不同格子,槽位按 `${folder}|${gb}|${id}` 键存;
  //   gb 保证【不同 gridbox 子树的同坐标格互不干扰】(transport 树与 mb 子树有同 (0,1) 格)
  for (const sl of S.slots) sl.ids.forEach((id, i) => S.slotIndex.set(`${sl.folder || ''}|${sl.gb || ''}|${id}`, { slot: sl, i, n: sl.ids.length }))
  // ★ 建立「坐标 → 占用它的页签列表」:检查器提示"这格还有别的页签在用"(坑 D)
  S.crossFolder = new Map()
  for (const n of S.allNodes) {
    const p = `${n.x},${n.y}`
    if (!S.crossFolder.has(p)) S.crossFolder.set(p, [])
    const arr = S.crossFolder.get(p)
    const f = n.folder || ''
    if (!arr.includes(f)) arr.push(f)
  }
  const st = d.stats
  $('#statChip').textContent =
    `${st.nodes}${tr(" 科技 / ")}${st.edges}${tr(" 边 / ")}${st.folders}${tr(" 分组 / ")}${st.catsDeclared}${tr(" 领域")}` +
    (st.overlapSlots ? ` / ${st.overlapSlots}${tr(" 组同格")}` : '')
  /* ★ OWNERSHIP_V1:总数就是生效集(同名科技已被模组替换,不重复计)。
   *   悬停显示三态拆分 + 因被覆盖而失效的旧版本数。 */
  S.own = d.own || null
  $('#statChip').title = Own.statsLine(S.own)
  buildOwnSelect()
  if (st.hiddenTechs) {
    $('#showHidden').parentElement.title =
      `${tr("无 categories 的科技:游戏里没有标题栏,单独归组显示(实测 ")}${st.hiddenTechs}${tr(" 个)")}`
  }
  if (d.unknownCategories?.length) {
    console.warn('[tech] 科技引用了但 technology_categories 表里没有的:', d.unknownCategories)
  }
  if (d.unknownFolders?.length) {
    console.warn('[tech] folder.name 未在 technology_folders 声明的:', d.unknownFolders)
  }
  buildFolderSelect()
  buildAreaSelect()
  buildCatBar()
  renderDangling()
  /* 本地化:科技 id 就是 localisation key(实测 vanilla 585 个科技全部命中)。
     异步拉,拉完只重绘文本与列表 —— 不动坐标/缩放/拖拽状态。 */
  Loc.load(S.allNodes.map((n) => n.id)).then(() => {
    if (S.nodes.length) {
      renderNodeList()
      render()
    }
  })
  /* ★★ 默认视图(用户 2026-10):不能一次展示全部,先看步兵。
   * 游戏里科技树是一页一页翻的,所以这里直接落到「步兵页签」
   * (infantry_folder),再叠加 categories = infantry_weapons —— 13 个科技一屏读完。
   * 两者都不存在时(纯模组工程)才退回全部。 */
  const hasFolder = S.folders.some((f) => f.id === DEFAULT_FOLDER && f.count)
  const hasArea = S.categories.some((c) => c.id === DEFAULT_AREA && c.count)
  S.folderFilter = hasFolder ? DEFAULT_FOLDER : ''
  S.areaFilter = hasArea ? DEFAULT_AREA : ''
  $('#folderSel').value = S.folderFilter
  $('#areaSel').value = S.areaFilter
  if (!hasFolder && !hasArea) toast('未找到步兵分类/页签,显示全部科技', true)
  applyFilter()
}

function buildFolderSelect() {
  const sel = $('#folderSel')
  sel.innerHTML = '<option value="">全部分组</option>'
  for (const f of S.folders) {
    const o = document.createElement('option')
    o.value = f.id
    const tags = []
    if (f.ledger) tags.push(LEDGER_CN[f.ledger] || f.ledger)
    if (f.doctrine) tags.push('学说')
    if (f.dlcGated) tags.push('DLC')
    o.textContent = `${folderName(f.id)} (${f.count})${tags.length ? ' · ' + tags.join('/') : ''}`
    sel.appendChild(o)
  }
}

/* ★ OWNERSHIP_V1:归属筛选器。同名科技由模组整份替换,所以只有三态:
 *   原版 / 模组改写 / 模组新增,三者相加 = 游戏里真实生效的科技总数。 */
function buildOwnSelect() {
  const sel = $('#ownSel')
  if (!sel) return
  const st = S.own || {}
  sel.innerHTML = ''
  const add = (v, t, title) => {
    const o = document.createElement('option')
    o.value = v
    o.textContent = t
    if (title) o.title = title
    sel.appendChild(o)
  }
  add('', '全部归属', '同名科技只显示最终生效的那一份')
  add('vanilla', `${tr("原版 ")}${st.vanilla ?? 0}`, '原版科技,模组没有同名覆盖它')
  add('override', `${tr("模组改写 ")}${st.override ?? 0}`, '原版有同名科技,被模组整份替换 —— 原版那份已失效')
  add('new', `${tr("模组新增 ")}${st.new ?? 0}`, '原版没有这条科技,模组新增 —— 与原版共存')
  sel.value = S.ownFilter || ''
}

function buildAreaSelect() {
  const sel = $('#areaSel')
  sel.innerHTML = '<option value="">全部领域</option>'
  for (const c of S.categories) {
    const o = document.createElement('option')
    o.value = c.id
    // 顺序表里声明但没科技引用的(实测 28 个 doctrine 树容器)标"空"而不是隐藏
    o.textContent = c.count ? `${areaName(c.id)} (${c.count})` : `${c.id}${tr(" (空 · 由脚本填充)")}`
    sel.appendChild(o)
  }
}

/* ── 分类切换胶囊栏 ──
 * 552 个科技不可能一次看完(用户 2026-10: "不能同时展示所有的,应该先展示步兵的")。
 * 分两行:第 1 行 = 页签(technology_folders,游戏里就是一页一页翻的),
 *         第 2 行 = 领域(technology_categories,横向排序维度)。
 * 点胶囊即切换;「全部」各自固定在行尾。
 *
 * ⚠ 2026-10-05 用户报"领域部分占据过长"。原实现两行都 flex-wrap:wrap,
 *   领域多时(vanilla 上百个 categories)堆成十几行,把画布压掉一大半。
 *   现在:行内 nowrap + 横向滚动(高度恒定)· 整条可拖动改高 · 可折叠。
 *   → 填充进 .catwrap,**不能**再 bar.innerHTML='' :那会连折叠按钮和
 *     拖动把手一起删掉(它们是 HTML 里静态给出的常驻节点)。 */
function buildCatBar() {
  const bar = $('#catbar')
  if (!bar) return
  // 常驻节点(.cat-fold / .cat-grip)保留,只清掉上一次的内容层
  let wrap = bar.querySelector('.catwrap')
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.className = 'catwrap'
    bar.appendChild(wrap)
  }
  wrap.innerHTML = ''

  /* ── 第 1 行:页签 ── */
  const L1 = document.createElement('div')
  L1.className = 'catrow'
  const l1 = document.createElement('span')
  l1.className = 'barlab'
  l1.textContent = '页签'
  l1.title = '游戏里科技树一页一页翻,每次只显示一个 technology_folders 页签。\n各页共用同一套 x/y 坐标但不同屏显示 —— 所以同坐标跨页签撞格是正常的。'
  L1.appendChild(l1)
  const ORD = { army: 0, navy: 1, air: 2, civilian: 3, hidden: 4 }
  const fl = S.folders
    .slice()
    .sort((a, b) => (ORD[a.ledger] ?? 9) - (ORD[b.ledger] ?? 9) || b.count - a.count)
  for (const f of fl) {
    const el = document.createElement('button')
    el.className = 'cpill' + (S.folderFilter === f.id ? ' on' : '')
    el.dataset.kind = 'folder'
    el.dataset.id = f.id
    el.textContent = `${folderName(f.id)} ${f.count}`
    const tags = []
    if (f.ledger) tags.push(LEDGER_CN[f.ledger] || f.ledger)
    if (f.doctrine) tags.push('学说')
    if (f.dlcGated) tags.push('DLC')
    el.title = `folder = ${f.id}\n${f.count}${tr(" 个科技\\n")}${tags.join('/') || '无门控'}${tr("\\n点按只看这一页")}`
    el.onclick = () => {
      S.folderFilter = S.folderFilter === f.id ? '' : f.id
      $('#folderSel').value = S.folderFilter
      // 换页签时清掉领域筛选:领域的科技散在多个页签,叠加容易筛出空集
      S.areaFilter = ''
      $('#areaSel').value = ''
      // ★ 同理清掉科技树页签:一棵树必然只属于一个 folder,
      //   与另一个 folder 页签求交集恒为空。
      S.treeFilter = ''
      S.hiddenView = false
      syncCatBar()
      applyFilter()
    }
    L1.appendChild(el)
  }
  /* HIDDENTECH_V1:隐藏科技页签 —— 无 folder.position 的科技,游戏里不显示在树,
     单独以条目查看。kind='hidden' 让 syncCatBar / applyFilter 识别。 */
  const hidBtn = document.createElement('button')
  hidBtn.className = 'cpill' + (S.hiddenView ? ' on' : '')
  hidBtn.dataset.kind = 'hidden'
  hidBtn.dataset.id = 'hidden'
  const hidN = S.allNodes.filter((x) => x.posDeclared === false).length
  hidBtn.textContent = `隐藏 ${hidN}`
  hidBtn.title = `无 folder.position 的科技(文件没写坐标,游戏里不显示在科技树)。\n共 ${hidN} 个,以条目形式查看属性与效果。`
  hidBtn.onclick = () => {
    S.hiddenView = !S.hiddenView
    if (S.hiddenView) {
      S.folderFilter = ''
      S.treeFilter = ''
      S.areaFilter = ''
      $('#folderSel').value = ''
      $('#areaSel').value = ''
    }
    syncCatBar()
    applyFilter()
  }
  L1.appendChild(hidBtn)
  const allF = document.createElement('button')
  allF.className = 'cpill' + (S.folderFilter === '' ? ' on' : '')
  allF.dataset.kind = 'folder'
  allF.dataset.id = ''
  allF.textContent = '全部页签'
  allF.title = `${tr("不按页签筛选,显示全部 ")}${S.allNodes.length}${tr(" 个科技")}`
  allF.onclick = () => {
    S.folderFilter = ''
    $('#folderSel').value = ''
    S.hiddenView = false
    syncCatBar()
    applyFilter()
  }
  L1.appendChild(allF)
  wrap.appendChild(L1)

  /* ── 第 1b 行:科技树(★ TECHGRAPH_V1)──
   * 上面那行是 technology_folders(文件的显示分组),下面这行才是游戏里
   * 真正一页一页翻的东西 —— HOI4 MU `$s()` 按 leadsToTechs 可达性把每个
   * folder 内的科技合并成若干棵「起始科技树」,一个页签 = 一棵树。
   * 举例:naval_folder 有 30+ 科技,但游戏里只有几棵树;
   * 若按 folder 切,一堆互不可达的科技会挤在同一页(看着像同一棵树)。 */
  if (S.techTrees.length) {
    const T1 = document.createElement('div')
    T1.className = 'catrow'
    const t1 = document.createElement('span')
    t1.className = 'barlab'
    t1.textContent = '科技树'
    t1.title =
      '★ 按 HOI4 Mod Utilities 的逻辑:同一 folder 内沿 leadsToTechs 可达的科技合并成一棵树,\n' +
      '一个页签 = 一棵树(起始科技即页签名)。这是游戏里真正一页一页翻的单位。'
    T1.appendChild(t1)
    /* ⚠ 循环变量【不能】叫 tr —— 会遮蔽全局的 tr() 翻译函数,
     *   下面 el.title 里的 tr(...) 会变成 TypeError: tr is not a function,
     *   整个 buildCatBar 抛错 → loadGraph 中断 → 页面空白。 */
    for (const tree of S.techTrees) {
      const el = document.createElement('button')
      el.className = 'cpill' + (S.treeFilter === tree.startTechnology ? ' on' : '')
      el.dataset.kind = 'tree'
      el.dataset.id = tree.startTechnology
      /* data-count:验收脚本据此区分「本该有节点却0 节点」(bug)
         与「单节点隐藏科技被开关滤掉」(正确行为)。 */
      el.dataset.count = String(tree.technologies.length)
      el.textContent = `${techName(tree.startTechnology)} ${tree.technologies.length}`
      const tags = []
      if (tree.folder) tags.push(folderName(tree.folder))
      if (tree.xorGroups.length) tags.push(`⊻${tree.xorGroups.length}`)
      el.title =
        `startTechnology = ${tree.startTechnology}\n` +
        `${tree.technologies.length}${tr(' 个科技(沿 leadsToTechs 可达)')}\n` +
        (tags.length ? tags.join(' · ') + '\n' : '') +
        tr('点按只看这一棵树')
      el.onclick = () => {
        S.treeFilter = S.treeFilter === tree.startTechnology ? '' : tree.startTechnology
        /* ★ 必须清掉 folder/area 筛选:科技树页签已经隐式定了 folder
           (buildTechTrees 按 folder 分组),再叠加 folderFilter 就是
           【两个不同 folder 求交集】→ 结果恒为空,用户点了却什么都看不到。
           这与上面 folder 页签"换页签清领域"是同一个道理。 */
        if (S.treeFilter) {
          S.folderFilter = ''
          S.areaFilter = ''
          const fs = $('#folderSel')
          if (fs) fs.value = ''
          const as = $('#areaSel')
          if (as) as.value = ''
        }
        S.hiddenView = false
        syncCatBar()
        applyFilter()
      }
      T1.appendChild(el)
    }
    const allT = document.createElement('button')
    allT.className = 'cpill' + (S.treeFilter === '' ? ' on' : '')
    allT.dataset.kind = 'tree'
    allT.dataset.id = ''
    allT.textContent = `全部树 ${S.techTrees.length}`
    allT.title = tr('不按科技树筛选')
    allT.onclick = () => {
      S.treeFilter = ''
      S.hiddenView = false
      syncCatBar()
      applyFilter()
    }
    T1.appendChild(allT)
    wrap.appendChild(T1)
  }

  /* ── 第 2 行:领域 ── */
  const L2 = document.createElement('div')
  L2.className = 'catrow'
  const l2 = document.createElement('span')
  l2.className = 'barlab'
  l2.textContent = '领域'
  l2.title = 'categories 字段 —— 决定科技归到哪个标题下(横向排序维度)'
  L2.appendChild(l2)
  const used = S.categories.filter((c) => c.count).sort((a, b) => b.count - a.count)
  const PIN = [
    'infantry_weapons', 'support_tech', 'armor', 'artillery',
    'light_air', 'naval_equipment', 'industry', 'electronics',
  ]
  const pinned = PIN.filter((id) => used.some((c) => c.id === id))
  const rest = used.filter((c) => !pinned.includes(c.id))
  const mkArea = (id, label, count, title) => {
    const el = document.createElement('button')
    el.className = 'cpill' + (S.areaFilter === id ? ' on' : '')
    el.dataset.kind = 'area'
    el.dataset.id = id
    el.textContent = `${label} ${count}`
    el.title = title
    el.onclick = () => {
      S.areaFilter = S.areaFilter === id ? '' : id
      $('#areaSel').value = S.areaFilter
      S.hiddenView = false
      syncCatBar()
      applyFilter()
    }
    L2.appendChild(el)
  }
  for (const id of pinned) {
    const c = used.find((x) => x.id === id)
    if (c) mkArea(id, areaName(id), c.count, `categories = { ${id} }\n${c.count}${tr(" 个科技")}`)
  }
  if (rest.length) {
    const sep = document.createElement('span')
    sep.className = 'barlab'
    sep.textContent = '其他'
    L2.appendChild(sep)
    for (const c of rest) mkArea(c.id, areaName(c.id), c.count, `categories = { ${c.id} }\n${c.count}${tr(" 个科技")}`)
  }
  const allA = document.createElement('button')
  allA.className = 'cpill' + (S.areaFilter === '' ? ' on' : '')
  allA.dataset.kind = 'area'
  allA.dataset.id = ''
  allA.textContent = '全部领域'
  allA.title = '不按领域筛选'
  allA.onclick = () => {
    S.areaFilter = ''
    $('#areaSel').value = ''
    syncCatBar()
    applyFilter()
  }
  L2.appendChild(allA)
  wrap.appendChild(L2)
  applyCatH(true)
}

/* ══════════════════════════════════════════════════════════
 * 分类栏高度:自适应 / 手动 / 折叠(CATH_V1)
 *
 * 三种状态,存 localStorage:
 *   unset  → 自适应(两行内容的高度,永远刚好包住,不浪费一像素)
 *   数字   → 用户拖出来的固定高(可滚动看被裁掉的内容)
 *   'off'  → 折叠(只留 22px 标签,画布拿回全部纵向空间)
 *
 * ⚠ 与 sizer 的分工:sizer 管**横向**侧栏宽度(gui.sizes),
 *   这里管分类栏**纵向**高度(gui.tech.catH),两套键别混。
 * ⚠ 自适应高度必须在渲染后测(内容有多高),所以用 requestAnimationFrame
 *   等一帧再量 —— 同一 tick 里 offsetHeight 还是上一批胶囊的高度。
 * ══════════════════════════════════════════════════════════ */
const CAT_H_KEY = 'gui.tech.catH'
let catHUser = null // null=自适应
const CAT_H_MIN = 24
const CAT_H_MAX = () => Math.max(160, Math.round(window.innerHeight * 0.6))

function catHStore() {
  try {
    const v = localStorage.getItem(CAT_H_KEY)
    if (v === 'off') return 'off'
    if (v && /^\d+$/.test(v)) return Math.max(CAT_H_MIN, Math.min(+v, CAT_H_MAX()))
  } catch {}
  return null
}

function applyCatH(silent) {
  const bar = $('#catbar')
  if (!bar) return
  const st = catHStore()
  if (st === 'off') {
    bar.classList.add('collapsed')
    // 折叠时 --cat-h 走 CSS 的 !important,这里不用再设
  } else {
    bar.classList.remove('collapsed')
    if (typeof st === 'number') {
      catHUser = st
      bar.style.setProperty('--cat-h', st + 'px')
      return
    }
    catHUser = null
    // 自适应:撤掉内联高度让 CSS 的 auto 生效,再量一次写进去
    bar.style.removeProperty('--cat-h')
    requestAnimationFrame(() => {
      const w = bar.querySelector('.catwrap')
      if (!w || bar.classList.contains('collapsed')) return
      const need = Math.ceil(w.getBoundingClientRect().height)
      const max = CAT_H_MAX()
      const h = Math.max(CAT_H_MIN, Math.min(need, max))
      // 内容本来就比上限矮时不必锁死,留 auto 更好(胶囊数量会变)
      if (need <= max) bar.style.removeProperty('--cat-h')
      else bar.style.setProperty('--cat-h', h + 'px')
      if (!silent) window.dispatchEvent(new Event('resize'))
    })
  }
  const f = $('#catFold')
  if (f) f.textContent = st === 'off' ? '▸ 展开' : '▾ 折叠'
  if (!silent) window.dispatchEvent(new Event('resize'))
}

/** 装上下沿拖动把手 + 折叠按钮(只装一次) */
function wireCatBar() {
  const bar = $('#catbar')
  if (!bar || bar.__catWired) return
  bar.__catWired = true
  const grip = $('#catGrip')
  const fold = $('#catFold')

  if (fold) {
    fold.addEventListener('click', () => {
      const on = $('#catbar').classList.toggle('collapsed')
      fold.textContent = on ? '▸ 展开' : '▾ 折叠'
      // 折叠状态也持久化:用户下次来还想保持画布全高
      try { localStorage.setItem(CAT_H_KEY, on ? 'off' : String(catHUser || Math.ceil(bar.querySelector('.catwrap')?.getBoundingClientRect().height || 46))) } catch {}
      window.dispatchEvent(new Event('resize'))
    })
  }
  // 双击分类栏空白处也折叠(与把手双击复位区分:双击把手才复位)
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.cpill') || e.target.closest('.cat-grip') || e.target.closest('.cat-fold')) return
    fold && fold.click()
  })

  if (!grip) return
  let drag = null
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    drag = { y: ev.clientY, h: bar.getBoundingClientRect().height }
    grip.setPointerCapture(ev.pointerId)
    document.body.classList.add('sizer-dragging')
  })
  grip.addEventListener('pointermove', (ev) => {
    if (!drag) return
    // 往上拖变高
    const h = Math.max(CAT_H_MIN, Math.min(drag.h + (drag.y - ev.clientY), CAT_H_MAX()))
    $('#catbar').style.setProperty('--cat-h', h + 'px')
  })
  function end(ev) {
    if (!drag) return
    drag = null
    document.body.classList.remove('sizer-dragging')
    try { grip.releasePointerCapture(ev.pointerId) } catch {}
    const h = Math.round($('#catbar').getBoundingClientRect().height)
    catHUser = h
    try { localStorage.setItem(CAT_H_KEY, String(h)) } catch {}
    $('#catbar').style.setProperty('--cat-h', h + 'px')
    window.dispatchEvent(new Event('resize'))
  }
  grip.addEventListener('pointerup', end)
  grip.addEventListener('pointercancel', end)
  // 双击把手 = 恢复自适应(不是恢复某个固定值)
  grip.addEventListener('dblclick', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    catHUser = null
    try { localStorage.removeItem(CAT_H_KEY) } catch {}
    applyCatH()
    toast('分类栏高度已恢复自适应')
  })
}
/** 胶囊选中态同步(下拉改动 / 胶囊点击 / 筛选重算后都要刷) */
function syncCatBar() {
  for (const el of document.querySelectorAll('#catbar .cpill')) {
    let on
    if (el.dataset.kind === 'hidden') on = S.hiddenView
    else if (el.dataset.kind === 'folder') on = !S.hiddenView && el.dataset.id === S.folderFilter
    else on = !S.hiddenView && el.dataset.id === S.areaFilter
    el.classList.toggle('on', on)
  }
}

function renderDangling() {
  const box = $('#dangList')
  $('#dangCount').textContent = S.dangling.length
  if (!S.dangling.length) {
    box.innerHTML = '<div style="color:var(--ok);padding:6px 11px">无悬空边 ✓</div>'
    return
  }
  box.innerHTML = ''
  for (const e of S.dangling.slice(0, 200)) {
    const el = document.createElement('div')
    el.className = 'iss error'
    el.innerHTML = `<div><span class="r">${esc(e.kind)}</span> ${esc(e.from)} → ${esc(e.to)}</div>`
    el.title = '边指向不存在的科技'
    el.onclick = () => {
      if (S.byId.has(e.from)) selectNode(e.from)
    }
    box.appendChild(el)
  }
}

/* ── 过滤 ── */
/** ★ 关键:科技树在游戏里是【一页一页】翻的(每个 technology_folder 一页),
 *  各页共用同一套 x/y 坐标但**不同屏显示**。
 *  旧版把所有 folder 铺在一张画布上 → 实测 95 个格坐标被多个 folder 同时占用,
 *  产生 518 处跨 folder 真重叠(用户看到的"横纵向分布有误"主因)。
 *  这里保留 engine 下发的原始坐标(检查器里要显示),渲染时按【当前可见集】
 *  的坐标范围做一次平移归一 —— 与游戏"每页独立居中"一致。 */
function normOffsets(nodes) {
  if (!nodes.length) return { dx: 0, dy: 0 }
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    const p = rawXY(n)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  return { dx: -minX, dy: -minY }
}

function applyFilter() {
  const q = $('#q').value.trim().toLowerCase()
  S.areaFilter = $('#areaSel').value
  S.folderFilter = $('#folderSel').value
  S.showHidden = $('#showHidden').checked
  S.onlyDangling = $('#onlyDangling').checked
  // ★ OWNERSHIP_V1:按内容归属筛(原版 / 模组改写 / 模组新增)
  S.ownFilter = $('#ownSel') ? $('#ownSel').value : ''

  /* ★ 一致性归并:科技树页签(techTrees 按 folder 分组)与 folder 页签
     【互斥】—— 同时选中必然是"两个 folder 求交集",恒为空集。
     下拉框改值也会走到这里,所以兜在 applyFilter 里清,而不是只清 onclick。 */
  if (S.treeFilter && S.folderFilter) {
    const tree = S.techTrees.find((t) => t.startTechnology === S.treeFilter)
    if (tree && tree.folder && tree.folder !== S.folderFilter) {
      S.folderFilter = ''
      $('#folderSel').value = ''
    }
  }

  /* HIDDENTECH_V1:隐藏科技视图 —— 只看无 folder.position 的科技。
     它们没有网格位,不进 folder/tree/area 筛选,以左侧条目形式查看。 */
  if (S.hiddenView) {
    let hnodes = S.allNodes.filter((n) => n.posDeclared === false)
    if (S.ownFilter) hnodes = hnodes.filter((n) => Own.of(n) === S.ownFilter)
    if (q) hnodes = hnodes.filter(
      (n) => n.id.toLowerCase().includes(q) || (n.categories || []).some((c) => c.toLowerCase().includes(q)),
    )
    S.nodes = hnodes
    S.byId = new Map(hnodes.map((n) => [n.id, n]))
    S.edges = S.allEdges.filter((e) => { const _a = S.byId.get(e.from); const _b = S.byId.get(e.to); return _a && _b })
    const off = normOffsets(hnodes)
    S.off = off
    renderNodeList()
    render()
    fit()
    const _bits = S.ownFilter ? [Own.LABEL[S.ownFilter] || S.ownFilter] : []
    $('#hud').textContent = `隐藏科技 ${hnodes.length}${tr(' 条(无 folder.position)')}${_bits.length ? ' · ' + _bits.join(' · ') : ''}`
    syncCatBar()
    return
  }
  // ★ 主视图:无 position 的科技不再 autoLayout 补位显示(已抽到"隐藏"页签)
  let nodes = S.allNodes.filter((n) => n.posDeclared !== false)
  // ★ 无 categories 的科技:默认隐藏(游戏里也没有标题栏)。
  //   但按归属筛选时【不能】用 hidden 把结果清空 —— 实测 2 个「模组改写」科技
  //   (elephantry / uranium_tipped_bullets)与 8 个「模组新增」全是 hidden,
  //   先过滤 hidden 会让归属筛选恒等于 0 条,用户选了却什么都看不到。
  if (!S.showHidden && !S.ownFilter) nodes = nodes.filter((n) => !n.hidden)
  if (S.ownFilter) nodes = nodes.filter((n) => Own.of(n) === S.ownFilter)
  if (S.folderFilter) nodes = nodes.filter((n) => (n.folders && S.folderFilter in n.folders) || n.folder === S.folderFilter)
  /* ★ TECHGRAPH_V1:按科技树页签筛 = 只留这一棵树(沿 leadsToTechs 可达的那批)。
     * 与 folderFilter 是【包含】关系:选了树就隐式定了 folder,再叠加也一致。 */
  if (S.treeFilter) {
    /* ⚠ 变量名不能叫 tr(遮蔽全局 tr() 翻译函数)—— 见 buildCatBar 里的同类坑。 */
    const tree = S.techTrees.find((t) => t.startTechnology === S.treeFilter)
    const ids = tree ? new Set(tree.technologies) : new Set([S.treeFilter])
    nodes = nodes.filter((n) => ids.has(n.id))
  }
  // 多分类科技:命中任一 category 即保留
  if (S.areaFilter) nodes = nodes.filter((n) => (n.categories || []).includes(S.areaFilter))
  if (q) {
    nodes = nodes.filter(
      (n) =>
        n.id.toLowerCase().includes(q) ||
        (n.categories || []).some((c) => c.toLowerCase().includes(q)) ||
        (n.folder || '').toLowerCase().includes(q),
    )
  }
  S.nodes = nodes
  S.byId = new Map(nodes.map((n) => [n.id, n]))

  const idset = new Set(nodes.map((n) => n.id))
  let edges = S.allEdges
  if (S.onlyDangling) edges = S.dangling
  else if (S.folderFilter || S.areaFilter || q) edges = edges.filter((e) => idset.has(e.from) && idset.has(e.to))
  S.edges = edges

  // ★ 归一化(按 gui 像素坐标平移,保证每页独立居中)
  const off = normOffsets(nodes)
  S.off = off

  renderNodeList()
  render()
  fit()
  const bits = []
  if (S.folderFilter) bits.push(tr('页签 ') + folderName(S.folderFilter))
  if (S.treeFilter) bits.push(tr('科技树 ') + techName(S.treeFilter))
  if (S.areaFilter) bits.push(tr('领域 ') + areaName(S.areaFilter))
  if (S.ownFilter) bits.push(Own.LABEL[S.ownFilter] || S.ownFilter)
  $('#hud').textContent = `${S.nodes.length}${tr(" 科技 · ")}${S.edges.length}${tr(" 边")}${bits.length ? ' · ' + bits.join(' · ') : ''}`
  syncCatBar()
}

function renderNodeList() {
  const list = S.nodes
  $('#nodeCount').textContent = `${S.nodes.length}/${S.allNodes.length}`
  const box = $('#nodeList')
  box.innerHTML = ''
  /* HIDDENTECH_V1:隐藏科技视图 → 卡片条目(属性 + 效果摘要),不按 folder 分组 */
  if (S.hiddenView) {
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--ink3);padding:6px 11px">没有符合条件的隐藏科技。</div>'
      return
    }
    for (const n of list.slice(0, 400)) {
      const el = document.createElement('div')
      el.className = 'item' + (S.sel === n.id ? ' on' : '')
      el.dataset.id = n.id
      el.innerHTML =
        `<div class="hid-name"><span class="tag" style="color:var(--warn)">隐藏</span> <b>${esc(n.id)}</b></div>` +
        `<div class="hid-meta">${esc(areaName((n.categories || [])[0] || '—'))}${n.cost ? ' · 花费 ' + n.cost : ''}${n.year ? ' · ' + n.year + ' 年' : ''}</div>` +
        hidEffectsHtml(n.effects)
      el.title = `${n.id}\n${n.file}:${n.line}\n无 folder.position(隐藏科技)`
      el.onclick = () => selectNode(n.id)
      box.appendChild(el)
    }
    return
  }
  const shown = list.slice(0, 400)
  let lastFolder = null
  for (const n of shown) {
    // 按分组插入小标题,列表也能看出归属
    if (n.folder !== lastFolder) {
      lastFolder = n.folder
      const h = document.createElement('div')
      h.className = 'pane-title'
      const f = S.folders.find((x) => x.id === n.folder)
      const tags = []
      if (f?.ledger) tags.push(LEDGER_CN[f.ledger] || f.ledger)
      if (f?.dlcGated) tags.push('DLC')
      h.innerHTML = `${esc(folderName(n.folder || '(无分组)'))}<span class="spacer"></span><span style="font-weight:400;color:var(--ink3)">${tags.join('/')}</span>`
      h.style.cursor = 'pointer'
      h.title = '点击只看这个页签'
      h.onclick = () => {
        S.folderFilter = n.folder || ''
        $('#folderSel').value = S.folderFilter
        syncCatBar()
        applyFilter()
      }
      box.appendChild(h)
    }
    const el = document.createElement('div')
    el.className = 'item' + (S.sel === n.id ? ' on' : '')
    el.dataset.id = n.id
    const si = slotOf(n)
    const sock = si && si.n > 1 ? `${tr(" <span class=\"tag\" style=\"color:var(--warn)\" title=\"同坐标 (")}${si.slot.x}, ${si.slot.y}${tr(") 共 ")}${si.n}${tr(" 条科技\">")}${si.i + 1}/${si.n}</span>` : ''
    const mark = n.hidden ? ' <span class="tag" style="color:var(--warn)">隐藏</span>' : ''
    el.innerHTML = `<span>${esc(n.id)}</span>${mark}${sock} <span class="tag">${esc(areaName((n.categories || [])[0] || '—'))}${n.cost ? ' · ' + n.cost : ''}</span>`
    el.title = `${n.id}\n${n.file}:${n.line}${tr("\\n坐标 (")}${n.x}, ${n.y})${n.posDeclared === false ? '(自动补位)' : ''}${si ? `\n同格 ${si.i + 1}/${si.n}` : ''}`
    el.onclick = () => selectNode(n.id)
    box.appendChild(el)
  }
  if (list.length > shown.length) {
    const more = document.createElement('div')
    more.className = 'item'
    more.style.color = 'var(--ink3)'
    more.textContent = `${tr("… 还有 ")}${list.length - shown.length}${tr(" 个,用搜索缩小范围")}`
    box.appendChild(more)
  }
}

/* ── 渲染 ── */
/** ★ 一格内多条科技(坑 A)时,该格的实际绘制高度。
 *  单条 = NH;N 条 = NH + (N-1)*SOCKH,向下生长(行距 YU 已按本页最深堆叠动态放大)。 */
function stackH(si) {
  return si && si.n > 1 ? NH + (si.n - 1) * SOCKH : NH
}
/** 当前 folder 页签下该科技所用的 folder id(多 folder 按当前页签取) */
function curFolderId(n) {
  return (S.folderFilter && n.folders && S.folderFilter in n.folders) ? S.folderFilter : (n.folder || '')
}
/** 某科技在【当前 folder 页签】下的逻辑坐标(文件原始值,检查器展示用) */
function nodePos(n) {
  const f = curFolderId(n)
  if (n.folders && f in n.folders) return n.folders[f]
  return { x: n.x, y: n.y }
}
/** 当前 folder 页签下该科技的槽位(多 folder 科技按当前 folder 取) */
function slotOf(n) {
  const f = curFolderId(n)
  return S.slotIndex.get(`${f}|${n.gb && n.gb[f] || ''}|${n.id}`)
}
/* ★ TECHLAYOUT_GUI_V1:该科技在【当前 folder 页签】下的 gui 像素坐标(未加归一化偏移)。
 *   px = engine 按 countrytechtreeview.gui 算好(gridbox 原点 + position×slotsize,
 *   轴交换已在引擎侧完成);无 gui 布局的 folder → 70×70 兜底格。 */
function rawXY(n) {
  const f = curFolderId(n)
  const p = (n.px && n.px[f]) || { x: (n.x || 0) * SLOT_DEF, y: (n.y || 0) * SLOT_DEF }
  return { x: p.x, y: p.y }
}
/** 某节点绘制时的左上角像素坐标(含本页归一化偏移) */
function nodeXY(n) {
  const o = S.off || { dx: 0, dy: 0 }
  const p = rawXY(n)
  return { x: p.x + o.dx, y: p.y + o.dy, h: stackH(slotOf(n)) }
}
/** 节点卡片宽:随格宽收缩(60px 格 → 52px 卡片,避免相邻列重叠;默认 70 格 → 62px) */
function nodeW(n) {
  const f = curFolderId(n)
  const lf = S.guiLayout.get(f)
  const gbName = n.gb && n.gb[f]
  const slotW = lf && gbName && lf.gridboxes.find((b) => b.name.replace(/_tree$/, '') === gbName)?.slotW
  return Math.min(NW, (slotW || SLOT_DEF) - 8)
}
/* ══════════════ TRIGGERS_V1 两态显隐 + 条件面板 ══════════════
 * 对齐 HOI4 Mod Utilities:allow_branch 是「分支显形条件」,用 Trig.evalTrig
 * (条件树, scope) 判 true / false(两态,无未知)。
 * st.v = 是否画出;st.f = 是否强制灰显(showHidden)。 */
function nodeVisState(n) {
  const T = window.Trig
  if (!T) return { v: true, f: false }
  if (n.allowBranchTrig == null) return { v: true, f: false }
  const r = T.evalTrig(n.allowBranchTrig, S.scope)
  if (r === false) return S.showHidden ? { v: true, f: true } : { v: false, f: false }
  return { v: true, f: false }
}

/* MU 下游传播:某科技 allow_branch 不满足 → 隐藏;若某科技的全部 leads 前置
   都被隐藏,它也随之隐藏(整条分支不可达)。返回 {base, vis}。 */
function buildVis() {
  const base = new Map()
  for (const n of S.nodes) base.set(n.id, nodeVisState(n))
  const pred = new Map()
  for (const e of S.edges) {
    if (e.kind !== '' && e.kind !== 'leads') continue
    if (!pred.has(e.to)) pred.set(e.to, [])
    pred.get(e.to).push(e.from)
  }
  const vis = new Map()
  for (const n of S.nodes) vis.set(n.id, base.get(n.id).v)
  let changed = true
  while (changed) {
    changed = false
    for (const n of S.nodes) {
      if (!vis.get(n.id)) continue
      const ps = pred.get(n.id)
      if (!ps || !ps.length) continue
      let allHidden = true
      for (const p of ps) if (vis.get(p)) { allHidden = false; break }
      if (allHidden) { vis.set(n.id, false); changed = true }
    }
  }
  return { base, vis }
}

/* 条件面板:把本树所有唯一条件叶子列成复选框,勾选写入 S.scope(Set<nodeContent>),
   重算显隐。分组按 Trig.groupConditions(仅显示归类,求值按字符串相等)。 */
const TRIG_MAX = 200
function renderTrigPanel(conditions) {
  const list = document.getElementById('trigList')
  const box = document.getElementById('trigbox')
  const tgl = document.getElementById('trigToggle')
  if (!list || !box) return
  const T = window.Trig
  if (!T) { box.style.display = 'none'; return }
  S.conditions = conditions || []
  if (!S.scope) S.scope = T.emptyScope()
  if (!S.conditions.length) { box.style.display = 'none'; return }
  box.style.display = ''
  const groups = T.groupConditions(S.conditions)
  let total = 0
  for (const g of groups) total += g.items.length
  tgl.dataset.n = String(total)
  tgl.textContent = trigLabel(tgl, !!box.classList.contains('expanded'))
  list.innerHTML = ''
  for (const g of groups) {
    const items = g.items
    if (!items.length) continue
    /* ★ DLCFILTER_V2:DLC 筛选默认全勾 —— 把全部 has_dlc 视为已拥有,显示 DLC 内容;
       用户取消勾选后该项从 scope 移除,不再默认勾回。 */
    if (g.cat === 'DLC') for (const it of items) S.scope.add(it.nodeContent)
    const h = document.createElement('div')
    h.className = 'tgrp'
    h.textContent = g.cat + ' (' + items.length + ')'
    list.appendChild(h)
    for (const it of items.slice(0, TRIG_MAX)) {
      const row = document.createElement('label')
      row.className = 'trow'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = String(it.key || '').toLowerCase() === 'has_game_rule'
        ? T.matchGameRule(it.nodeContent)
        : S.scope.has(it.nodeContent)
      cb.onchange = () => {
        const k = String(it.key || '').toLowerCase()
        if (k === 'has_game_rule') {
          T.setGameRule(it.nodeContent, cb.checked)
          renderTrigPanel(S.conditions) /* 同规则多选项复选框联动 */
        } else if (cb.checked) S.scope.add(it.nodeContent)
        else S.scope.delete(it.nodeContent)
        applyFilter()
        if (S.sel) { const n = S.byId.get(S.sel); if (n) showInsp(n) }
      }
      const sp = document.createElement('span')
      sp.textContent = it.nodeContent
      sp.title = it.key
      const em = document.createElement('em')
      em.textContent = it.count
      row.append(cb, sp, em)
      list.appendChild(row)
    }
    if (items.length > TRIG_MAX) {
      const more = document.createElement('div')
      more.className = 'tgrp'
      more.textContent = '… 另 ' + (items.length - TRIG_MAX) + ' 项'
      list.appendChild(more)
    }
  }
  updateTrigStat()
}
function updateTrigStat() {
  const ts = document.getElementById('trigStat')
  if (!ts) return
  const { vis } = buildVis()
  let hidden = 0
  for (const n of S.nodes) if (!vis.get(n.id)) hidden++
  const parts = []
  if (hidden) parts.push(`${tr('隐藏')} ` + hidden)
  ts.textContent = parts.join(' · ')
}

function render() {
  const oldHint = document.getElementById('canvasHint')
  if (oldHint) oldHint.remove()
  gNode.innerHTML = ''
  gEdge.innerHTML = ''
  gBand.innerHTML = ''
  /* HIDDENTECH_V1:隐藏科技无网格位置 → 画布只显示提示,不画节点 */
  if (S.hiddenView) {
    const h = document.createElement('div')
    h.id = 'canvasHint'
    h.className = 'overlay'
    h.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-50%);padding:14px 22px;max-width:64%;text-align:center;line-height:1.7;pointer-events:none'
    h.textContent = '隐藏科技:无 folder.position,游戏里不显示在科技树页面 —— 请在左侧条目中查看属性与效果。'
    $('#stage').appendChild(h)
    return
  }
  renderBands()
  /* ★ GRIDWIRE_V1:照抄 HOI4 MU 的格间正交布线。
     旧版 edgePathD 画的是"节点中心到节点中心"的曲线 —— 与游戏内
     「整数网格 + 格间轨道」的画法完全不同,长距离连线会横穿一堆节点。
     occ 是整张画布共享的占用表,xor/sub 这类装饰边后画,让主依赖线优先。 */
  const GW = window.GridWire
  const occ = new Map()
  /* ═ TRIGGERS_V1:预计算可见性(含下游传播)+ 已绘制 id 集(画边跳过指向隐藏节点的线)。 */
  const { base: visBase, vis: visMap } = buildVis()
  const drawn = new Set()
  for (const n of S.nodes) if (visMap.get(n.id)) drawn.add(n.id)
  const order = { '': 0, leads: 0, enable: 1, gate: 2, sub: 3, xor: 4 }
  const edges = S.edges
    .slice()
    .sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0))
  let conflicts = 0
  for (const e of edges) {
    const a = S.byId.get(e.from)
    const b = S.byId.get(e.to)
    if (!a || !b || !drawn.has(a.id) || !drawn.has(b.id)) continue // TRIGGERS_V1:端点隐藏则不画边
    const pa = nodeXY(a)
    const pb = nodeXY(b)
    const x1 = pa.x + nodeW(a) / 2
    const y1 = pa.y + pa.h
    const x2 = pb.x + nodeW(b) / 2
    const y2 = pb.y
    const p = document.createElementNS(SVGNS, 'path')
    if (GW) {
      /* ★ TECHLAYOUT_GUI_V1:GW 用像素空间(cw=ch=1,halfH=NH/2),但锚点按【上方节点底边 /
         下方节点顶边】对齐 —— 通道(chanY = 源节点底 + 0.5 / 上节点顶 - 0.5)因此恰好落在
         两节点之间的行间空隙里,不会切进节点矩形(旧网格空间的等距行模型已被 gui 布局取代)。 */
      const upX = pa.y <= pb.y ? pa.x : pb.x
      const upY = pa.y <= pb.y ? pa.y : pb.y
      const dnX = pa.y <= pb.y ? pb.x : pa.x
      const dnY = pa.y <= pb.y ? pb.y : pa.y
      const upW = pa.y <= pb.y ? nodeW(a) : nodeW(b)
      const dnW = pa.y <= pb.y ? nodeW(b) : nodeW(a)
      const r = GW.routeAvoiding(
        occ,
        e.from + '>' + e.to + '>' + (e.kind || ''),
        { gx: upX + (upW - 1) / 2, gy: upY + NH / 2 },
        { gx: dnX + (dnW - 1) / 2, gy: dnY - NH / 2 },
        { cw: 1, ch: 1, halfH: NH / 2 },
      )
      if (!r.d) continue
      p.setAttribute('d', r.d)
      if (r.conflict) conflicts++
    } else {
      // 略微弯曲的折线(圆角肘形)—— 全站连线统一风格,实现见 /edgepath.js
      // axis='v':科技树是"前置在上、解锁在下"的竖向流向,强制竖向肘形
      p.setAttribute('d', edgePathD(x1, y1, x2, y2, 12, 'v'))
    }
    p.setAttribute('class', 'edge ' + (e.kind === 'enable' ? 'enable' : e.kind === 'xor' ? 'xor' : ''))
    p.dataset.from = e.from
    p.dataset.to = e.to
    gEdge.appendChild(p)
  }
  S.gridConflicts = conflicts
  const tiny = S.nodes.length > 200
  for (const n of S.nodes) {
    const st = visBase.get(n.id)
    if (!visMap.get(n.id)) continue // TRIGGERS_V1:条件未满足 / 下游不可达 → 不画
    const p = nodeXY(n)
    const si = slotOf(n)
    const g = document.createElementNS(SVGNS, 'g')
    /* ★ OWNERSHIP_V1:画布上直接区分归属 —— 模组新增描绿边、被模组改写的描橙边。
     *   原版科技不额外描边(占绝大多数,描了满屏都是色)。 */
    const own = Own.of(n)
    g.setAttribute(
      'class',
      'node' +
        (S.sel === n.id ? ' sel' : '') +
        (tiny ? ' tiny' : '') +
        (n.hidden ? ' c-hidden' : '') +
        (si && si.n > 1 ? ' c-sock' : '') +
        (n.posDeclared === false ? ' c-auto' : '') +
        /* ★ TRIGGERS_V1:allow_branch 两态显隐。
           st.f(条件未满足被 showHidden 强显)→ gated 虚线框。满足条件 = 普通节点。 */
        (st.f ? ' gated' : '') +
        ((n.subTechnologies && n.subTechnologies.length) ? ' has-sub' : '') +
        (own === 'new' ? ' own-new' : own === 'override' ? ' own-ovr' : ''),
    )
    g.dataset.id = n.id
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('class', 'box')
    r.setAttribute('x', p.x)
    r.setAttribute('y', p.y)
    r.setAttribute('width', nodeW(n))
    r.setAttribute('height', p.h)
    r.setAttribute('rx', 5)
    g.appendChild(r)
    // ★ 图标:单条节点在左上角画 18×18 图标;堆叠行(si.n>1)太小不放,只留文字
    const isSock = si && si.n > 1
    if (!isSock) {
      const img = document.createElementNS(SVGNS, 'image')
      img.setAttribute('class', 'nodeicon')
      img.setAttribute('x', p.x + Math.max(1, (nodeW(n) - ICON) / 2))
      img.setAttribute('y', p.y + 3)
      img.setAttribute('width', ICON)
      img.setAttribute('height', ICON)
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      // 默认先画内置齿轮图标;懒加载到真实贴图后由 paintIcons 覆盖(失败则保持默认)
      img.setAttribute('href', DEFAULT_TECH_ICON)
      g.appendChild(img)
    }
    // ★ 标签【行内】(坑 B):单条画在框内底部;同格堆叠时每条只画自己那 13px 的行
    const t = document.createElementNS(SVGNS, 'text')
    if (isSock) {
      t.setAttribute('x', p.x + nodeW(n) / 2)
      t.setAttribute('y', p.y + si.i * SOCKH + SOCKH - 3)
      t.setAttribute('text-anchor', 'middle')
      t.textContent = Loc.text(n.id) ? Loc.label(n.id, 20) : n.id
    } else {
      // ★ 名称在图标下方,居中;按卡宽截断避免压边
      t.setAttribute('class', 'nlabel')
      t.setAttribute('x', p.x + nodeW(n) / 2)
      t.setAttribute('y', p.y + NH - 7)
      t.setAttribute('text-anchor', 'middle')
      const maxC = Math.max(4, Math.floor(nodeW(n) / 9))
      const txt = Loc.text(n.id) ? Loc.label(n.id, 20) : n.id
      t.textContent = txt.length > maxC ? txt.slice(0, maxC - 1) + '…' : txt
    }
    g.appendChild(t)
    // 同格分隔线:让一格多条看起来是"一叠"而不是一个长条
    if (si && si.n > 1) {
      for (let k = 1; k < si.n; k++) {
        const ln = document.createElementNS(SVGNS, 'line')
        ln.setAttribute('class', 'sockline')
        ln.setAttribute('x1', p.x + 3)
        ln.setAttribute('x2', p.x + nodeW(n) - 3)
        ln.setAttribute('y1', p.y + k * SOCKH)
        ln.setAttribute('y2', p.y + k * SOCKH)
        g.appendChild(ln)
      }
    }
    g.addEventListener('pointerdown', (ev) => selectNode(n.id, true))
    /* Shift+F10 用:菜单挂元素上,Keys.ctxKey() 取用(每次 render 重建,不会指向旧节点) */
    g.ctxItems = () => techMenuItems(n)
    gNode.appendChild(g)
  }
  applySel()
  lazyIcons()
}

/* ── 图标:只加载视口内的 ── */
let lazyTimer = null
function lazyIcons() {
  clearTimeout(lazyTimer)
  lazyTimer = setTimeout(doLazyIcons, 160)
}
async function doLazyIcons() {
  const st = $('#stage').getBoundingClientRect()
  const want = []
  for (const n of S.nodes) {
    if (!n.tex || S.icons.has(n.tex)) continue
    const c = nodeXY(n) // 已是像素坐标
    const sx = c.x * S.zoom + S.tx
    const sy = c.y * S.zoom + S.ty
    const w = NW * S.zoom
    const h = c.h * S.zoom
    if (sx + w < -200 || sx > st.width + 200 || sy + h < -200 || sy > st.height + 200) continue
    want.push(n)
  }
  const batch = want.slice(0, 24)
  await Promise.all(batch.map((n) => loadIcon(n.tex)))
  paintIcons()
  if (want.length > batch.length) lazyIcons()
}
async function loadIcon(tex) {
  if (!tex || S.icons.has(tex) || S.loading.has(tex)) return
  S.loading.add(tex)
  try {
    const d = await api('/api/tex?id=' + encodeURIComponent(tex))
    if (d.png) S.icons.set(tex, 'data:image/png;base64,' + d.png)
    else S.icons.set(tex, null)
  } catch {
    S.icons.set(tex, null)
  }
  S.loading.delete(tex)
}
function paintIcons() {
  for (const g of gNode.children) {
    const n = S.byId.get(g.dataset.id)
    if (!n) continue
    const img = g.querySelector('image.nodeicon')
    if (!img) continue
    const ic = n.tex ? S.icons.get(n.tex) : null
    // 没图标字段 / 加载失败 → 内置默认科技图标(无破图)
    img.setAttribute('href', ic || DEFAULT_TECH_ICON)
  }
}

/** 分组标题带:在每个 folder 的科技上方画一条横带,标出分组名与 ledger */
function renderBands() {
  if (!S.showBands) return
  // 按 folder 收集当前可见科技的坐标范围(用错开后的像素坐标,坑 A)
  const groups = new Map()
  for (const n of S.nodes) {
    const key = n.folder || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }
  for (const [fid, list] of groups) {
    const f = S.folders.find((x) => x.id === fid)
    const px = list.map((n) => nodeXY(n).x)
    const py = list.map((n) => nodeXY(n).y)
    const ph = list.map((n) => nodeXY(n).h)
    const minX = Math.min(...px)
    const maxX = Math.max(...px)
    const minY = Math.min(...py)
    const bottom = Math.max(...py) + Math.max(...ph)
    const x = minX - 8
    const w = maxX - minX + NW + 16
    const g = document.createElementNS(SVGNS, 'g')
    g.setAttribute('class', 'fband' + (f?.ledger === 'hidden' ? ' hidden' : ''))
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('x', x)
    r.setAttribute('y', minY - 24)
    r.setAttribute('width', w)
    r.setAttribute('height', bottom - minY + 34)
    r.setAttribute('rx', 4)
    g.appendChild(r)
    const t = document.createElementNS(SVGNS, 'text')
    t.setAttribute('x', x + 7)
    t.setAttribute('y', minY - 11)
    const tags = []
    if (f?.ledger) tags.push(LEDGER_CN[f.ledger] || f.ledger)
    if (f?.doctrine) tags.push('学说')
    if (f?.dlcGated) tags.push('DLC 门控')
    t.textContent = `${folderName(fid || '(无分组)')}${tags.length ? ' · ' + tags.join('/') : ''}  (${list.length})`
    g.appendChild(t)
    g.style.cursor = 'pointer'
    g.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation()
      // 点标题带 → 切到该页签(只在"全部页签"视图下有意义的动作)
      S.folderFilter = fid
      $('#folderSel').value = fid
      syncCatBar()
      applyFilter()
    })
    gBand.appendChild(g)
  }
  // 无分组的科技(纯 %坐标、没有 folder 块)也标一条,免得看起来"凭空出现"
  const noFolder = S.nodes.filter((n) => !n.folder)
  if (noFolder.length) {
    const px = noFolder.map((n) => nodeXY(n).x)
    const py = noFolder.map((n) => nodeXY(n).y)
    const ph = noFolder.map((n) => nodeXY(n).h)
    const minX = Math.min(...px)
    const minY = Math.min(...py)
    const g = document.createElementNS(SVGNS, 'g')
    g.setAttribute('class', 'fband empty')
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('x', minX - 8)
    r.setAttribute('y', minY - 24)
    r.setAttribute('width', Math.max(...px) - minX + NW + 16)
    r.setAttribute('height', Math.max(...py) + Math.max(...ph) - minY + 34)
    r.setAttribute('rx', 4)
    g.appendChild(r)
    const t = document.createElementNS(SVGNS, 'text')
    t.setAttribute('x', minX - 1)
    t.setAttribute('y', minY - 11)
    t.textContent = `${tr("(无 folder 声明 · 坐标自动补位)  (")}${noFolder.length})`
    g.appendChild(t)
    gBand.appendChild(g)
  }
}

function applySel() {
  for (const g of gNode.children) g.classList.toggle('sel', S.sel === g.dataset.id)
  for (const p of gEdge.children) p.classList.toggle('hot', S.sel && (p.dataset.from === S.sel || p.dataset.to === S.sel))
}

function applyTransform() {
  gRoot.setAttribute('transform', `translate(${S.tx} ${S.ty}) scale(${S.zoom})`)
  $('#zl').textContent = Math.round(S.zoom * 100) + '%'
  lazyIcons()
}

/* ── 检查器 ── */
function selectNode(id, fromCanvas) {
  S.sel = id
  applySel()
  const n = S.byId.get(id)
  if (!n) return
  renderNodeList()
  showInsp(n)
  if (fromCanvas) centerOn(id)
}

function showInsp(n) {
  const req = S.allEdges.filter((e) => e.to === n.id).map((e) => e.from)
  const f = S.folders.find((x) => x.id === n.folder)
  const si = slotOf(n)
  const cats = (n.categories || []).map((c) => {
    const cnt = S.categories.find((x) => x.id === c)?.count
    return `${areaName(c)} <span style="color:var(--ink3)">(${c}${cnt === undefined ? '' : ' · ' + cnt})</span>`
  })
  const sockRow = si
    ? `${tr("<div class=\"kv\"><b>同格</b><span><span style=\"color:var(--warn)\">第 ")}${si.i + 1} / ${si.n}${tr(" 条</span> —\n        坐标 (")}${si.slot.x}, ${si.slot.y}${tr(") 上共 ")}${si.n}${tr(" 条科技(互斥/DLC 替代,画布上堆叠显示为一卡带)<br>\n        ")}${si.slot.ids.map((id, i) => `<span class="tagr${i === si.i ? ' on' : ''}">${esc(id)}</span>`).join('')}</span></div>`
    : ''
  $('#insp').innerHTML = `
    <button id="inspDetailBtn" class="dbtn">${S.techDetail ? '▾ 收起详情' : '▸ 显示详情'}</button>
    <div class="kv"><b>id</b><span>${esc(n.id)}${tr("</span></div>\n    <div class=\"kv\"><b>归属</b><span>")}${Own.badge(n)} ${esc(n.rootName || '')}${
      (n.defs || []).length > 1
        ? ` <span style="color:var(--ink3)">(同名定义 ${(n.defs || []).length} 处:${
            (n.defs || []).map((d) => esc(d.rootName)).join(' → ')
          },最后一个生效)</span>`
        : ''
    }${tr("</span></div>\n    <div class=\"kv\"><b>分组</b><span>")}${n.folder ? esc(folderName(n.folder)) + (f ? ` <span style="color:var(--ink3)">(${esc(f.id)})</span>` : '') : '<span style="color:var(--warn)">无 folder 声明</span>'}</span></div>
    <div class="kv"><b>ledger</b><span>${f?.ledger ? esc(LEDGER_CN[f.ledger] || f.ledger) + ` <span style="color:var(--ink3)">(${esc(f.ledger)})</span>` : '—'}</span></div>
    ${f?.dlcGated ? '<div class="kv"><b>DLC</b><span style="color:var(--warn)">该分组有 available 条件(按 DLC 切换)</span></div>' : ''}${tr("\n    <div class=\"kv\"><b>隐藏</b><span>")}${n.hidden ? '<span style="color:var(--warn)">是 — 无 categories,游戏里无标题栏</span>' : '否'}</span></div>
    ${sockRow}${tr("\n    <h4>领域 (")}${(n.categories || []).length})</h4>
    ${cats.length ? cats.map((c) => `<div class="kv"><span>${c}</span></div>`).join('') : '<div class="kv"><span style="color:var(--warn)">无</span></div>'}${tr("\n    <div class=\"kv\"><b>研究花费</b><span>")}${n.cost}${tr("</span></div>\n    <div class=\"kv\"><b>起始年</b><span>")}${n.year || '—'}${tr("</span></div>")}${effectsHtml(n.effects)}${tr("\n    <div class=\"kv\"><b>坐标</b><span>(")}${n.x}, ${n.y})${n.posDeclared === false ? ' <span style="color:var(--warn)">自动补位(文件未写 folder.position)</span>' : ''}${
      (S.crossFolder?.[`${n.x},${n.y}`] || []).filter((x) => x !== n.folder || '').length
        ? ` <span style="color:var(--warn)">另有 ${(S.crossFolder[`${n.x},${n.y}`] || []).length - 1} 个其他页签也用这一格(游戏里不同屏,正常)</span>`
        : ''
    }${tr("</span></div>\n    <div class=\"kv\"><b>位置</b><span>")}${esc(n.file)}:${n.line}${tr("</span></div>\n    <div class=\"kv\"><b>图标</b><span>")}${
      n.icon
        ? `显式 icon = ${esc(n.icon)}`
        : `无 icon → 用游戏默认科技图标 <code style="color:var(--ink3)">GFX_technology_medium</code>${
            n.showEquipmentIcon ? ' <span style="color:var(--warn)">(show_equipment_icon = yes)</span>' : ''
          }`
    }</span></div>
    ${
      n.equipList && n.equipList.length
        ? `<div class="kv"><b>关联装备</b><span>${n.equipList.map((e) => esc(e)).join(', ')}</span></div>`
        : ''
    }
    ${n.leads && n.leads.length ? `<h4>解锁(leads) ${n.leads.length}</h4>${n.leads.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
    ${n.enables && n.enables.length ? `<h4>同级启用 ${n.enables.length}</h4>${n.enables.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
    ${n.enableSubunits && n.enableSubunits.length ? `<h4>解锁 sub-unit (enable_subunits)</h4>${n.enableSubunits.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join("")}` : ""}
    ${n.enableEquipmentModules && n.enableEquipmentModules.length ? `<h4>解锁装备模块 (enable_equipment_modules)</h4>${n.enableEquipmentModules.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join("")}` : ""}
    ${n.enableBuildings && n.enableBuildings.length ? `<h4>解锁建筑 (enable_building)</h4>${n.enableBuildings.map((b) => `<div class="kv"><span>${esc(b.building)} → 等级 ${b.level}</span></div>`).join("")}` : ""}
    ${n.enableTactic ? `<div class="kv"><b>解锁战术</b><span>${esc(n.enableTactic)}</span></div>` : ""}
    ${n.dependencies && n.dependencies.length ? `<h4>AND 依赖 (dependencies)</h4>${n.dependencies.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join("")}` : ""}
    ${req.length ? `<h4>前置 ${req.length}</h4>${req.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
    ${
      n.xor && n.xor.length
        ? `<h4>⊻互斥(xor) ${n.xor.length}</h4>${n.xor.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}`
        : ''
    }
    ${
      n.hasAllowBranch
        ? `<div class="kv"><b>显形门(allow_branch)</b><span>${
            (n.allowBranchDlcs || []).length
              ? `需要 DLC: ${n.allowBranchDlcs.map((d) => `<code class="or-id">${esc(d)}</code>`).join(' ')}`
              : ''
          }${n.allowBranch ? `${n.allowBranchDlcs && n.allowBranchDlcs.length ? '<br>' : ''}需先完成 <code class="or-id">${esc(n.allowBranch)}</code>` : ''}</span></div>`
        : ''
    }
    ${
      n.inAllowBranch && n.inAllowBranch.length > 1
        ? `<div class="kv"><b>继承的显形门</b><span>${n.inAllowBranch
            .filter((p) => p !== n.allowBranch)
            .map((p) => `<code class="or-id">${esc(p)}</code>`)
            .join(' ')}${tr("(传递闭包,由上游分支门继承)")}</span></div>`
        : ''
    }
    ${
      n.subTechnologies && n.subTechnologies.length
        ? `<h4>子科技 ${n.subTechnologies.length}</h4>${n.subTechnologies.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}`
        : ''
    }
    ${
      n.startTechnology && n.startTechnology !== n.id
        ? `<div class="kv"><b>所属科技树</b><span>${esc(techName(n.startTechnology))}</span></div>`
        : ''
    }
    ${n.doctrine || n.doctrineName || n.showEffectAsDesc || n.extraDesc ? `<h4>学说 / 描述</h4>` + (n.doctrine ? `<div class="kv"><b>doctrine</b><span>是</span></div>` : "") + (n.doctrineName ? `<div class="kv"><b>doctrine_name</b><span>${esc(n.doctrineName)}</span></div>` : "") + (n.showEffectAsDesc ? `<div class="kv"><b>show_effect_as_desc</b><span>是</span></div>` : "") + (n.extraDesc ? `<div class="kv"><b>额外描述 (desc)</b><span>${esc(n.extraDesc)}</span></div>` : "") : ""}
    ${n.aiWillDo ? `<h4>AI 权重 (ai_will_do)</h4><pre class="effpre">${esc(n.aiWillDo)}</pre>` : ""}
    ${n.aiResearchWeights ? `<h4>AI 侧重 (ai_research_weights)</h4><pre class="effpre">${esc(n.aiResearchWeights)}</pre>` : ""}
    ${n.pathDetails && n.pathDetails.length ? `<h4>路径 (path) ${n.pathDetails.length}</h4>${n.pathDetails.map((pd) => `<div class="kv"><span>→ ${esc(pd.leads)}</span><span>${pd.costCoeff !== undefined ? "cost_coeff " + pd.costCoeff : ""}${pd.ignoreForLayout ? " · ignore_for_layout" : ""}</span></div>`).join("")}` : ""}
    ${S.techDetail ? nodeDump(n) : ''}`
  const btn = $('#inspDetailBtn')
  if (btn)
    btn.onclick = () => {
      S.techDetail = !S.techDetail
      showInsp(n)
    }
}

/* 显示详情:把节点上所有字段(raw)列出来,方便排查坐标 / 分类 / 来源等细节 */
function nodeDump(n) {
  const skip = new Set(['defs', 'own', 'ownLabel', 'stale', 'base', 'origin', 'overridden', 'posDeclared', 'hidden', 'area'])
  const rows = []
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k)) continue
    let s
    if (Array.isArray(v)) s = v.length ? v.map((x) => esc(String(x))).join(', ') : '（空）'
    else if (v === null || v === undefined || v === '') continue
    else s = esc(String(v))
    rows.push(`<div class="kv"><b>${esc(k)}</b><span>${s}</span></div>`)
  }
  const defs = (n.defs || []).map((d) => `[${esc(d.rootName)}] ${esc(d.file)}:${d.line}`).join('<br>')
  return (
    `<div class="sec-t">完整字段(raw · 显示详情)</div>` +
    rows.join('') +
    (defs ? `${tr("<div class=\"kv\"><b>定义位置</b><span>")}${defs}</span></div>` : '')
  )
}

/* ── 缩放平移 ── */
function fit() {
  if (!S.nodes.length) return
  const px = S.nodes.map((n) => nodeXY(n).x)
  const py = S.nodes.map((n) => nodeXY(n).y)
  const ph = S.nodes.map((n) => nodeXY(n).h)
  const minX = Math.min(...px)
  const maxX = Math.max(...px)
  const minY = Math.min(...py)
  const maxY = Math.max(...py) + Math.max(...ph)
  const st = $('#stage').getBoundingClientRect()
  const w = maxX - minX + NW + 56
  const h = maxY - minY + 78
  S.zoom = Math.min(st.width / w, st.height / h, 1.6)
  S.zoom = Math.max(S.zoom, 0.05)
  S.tx = (st.width - w * S.zoom) / 2 - minX * S.zoom
  S.ty = (st.height - h * S.zoom) / 2 - minY * S.zoom
  applyTransform()
}
function zoomBy(f) {
  const st = $('#stage').getBoundingClientRect()
  const cx = st.width / 2
  const cy = st.height / 2
  const z0 = S.zoom
  S.zoom = Math.min(Math.max(S.zoom * f, 0.05), 4)
  S.tx = cx - ((cx - S.tx) / z0) * S.zoom
  S.ty = cy - ((cy - S.ty) / z0) * S.zoom
  applyTransform()
}
function centerOn(id) {
  const n = S.byId.get(id)
  if (!n) return
  const p = nodeXY(n)
  const st = $('#stage').getBoundingClientRect()
  S.tx = st.width / 2 - (p.x + nodeW(n) / 2) * S.zoom
  S.ty = st.height / 2 - (p.y + p.h / 2) * S.zoom
  applyTransform()
}

/* 平移:空白处拖动 */
let pan = null
svg.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.node')) return
  pan = { x: ev.clientX, y: ev.clientY, tx: S.tx, ty: S.ty }
  window.addEventListener('pointermove', onPan)
  window.addEventListener('pointerup', endPan)
})
function onPan(ev) {
  if (!pan) return
  S.tx = pan.tx + (ev.clientX - pan.x)
  S.ty = pan.ty + (ev.clientY - pan.y)
  applyTransform()
}
function endPan() {
  window.removeEventListener('pointermove', onPan)
  window.removeEventListener('pointerup', endPan)
  pan = null
}
svg.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault()
    zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12)
  },
  { passive: false },
)

/* ── 绑定 ── */
$('#q').addEventListener('input', applyFilter)
$('#areaSel').addEventListener('change', (e) => {
  S.areaFilter = e.target.value
  syncCatBar()
  applyFilter()
})
$('#folderSel').addEventListener('change', (e) => {
  S.folderFilter = e.target.value
  syncCatBar()
  applyFilter()
})
$('#showHidden').addEventListener('change', applyFilter)
/* TRIGGERS_V1:条件面板展开/收起 + 全部清空。 */
/* ★ TRIGWIN_V1(2026-10-22):条件面板从"停靠坞里的一块"升级为**画布浮动小窗** ——
   标题栏按住拖动 = 移动;底缘握把拖动 = 拉长/收缩;标题按钮 = 折叠/展开;
   双击标题栏 = 复位到右上角。位置/高度存 localStorage(gui.trigWin),两页共用。 */
const TRIGWIN_KEY = 'gui.trigWin'
function trigWinLoad() {
  try {
    const j = JSON.parse(localStorage.getItem(TRIGWIN_KEY) || 'null')
    if (j && typeof j === 'object') return j
  } catch {}
  /* 兼容上一轮只存高度的旧键 trigH */
  try {
    const h = parseInt(localStorage.getItem('trigH') || '0', 10)
    if (h >= 64) return { h }
  } catch {}
  return null
}
function trigWinSave(p) { try { localStorage.setItem(TRIGWIN_KEY, JSON.stringify(p)) } catch {} }
/** 标题文案:保留 renderTrigPanel 写进 dataset.n 的计数,箭头随展开态切换 */
function trigLabel(el, open) {
  const n = el.dataset.n || ''
  return (tr('条件') + (n ? ' ' + n : '') + ' ' + (open ? '▾' : '▸')).replace(/\s+/g, ' ').trim()
}
/** 设置浮窗高度(px),按舞台高度 clamp 并持久化 */
function trigApplyH(box, h) {
  const st = box.parentElement
  const max = Math.round((st ? st.clientHeight : window.innerHeight) * 0.72)
  h = Math.max(64, Math.min(h, max))
  box.style.height = h + 'px'
  box.style.maxHeight = h + 'px'
  trigWinSave(Object.assign(trigWinLoad() || {}, { h }))
}
/** 把浮窗钳制在舞台内(至少露出标题栏,拖不出画布) */
function trigClamp(box) {
  const st = box.parentElement
  if (!st) return
  const M = 8
  const maxX = Math.max(M, st.clientWidth - box.offsetWidth - M)
  const maxY = Math.max(M, st.clientHeight - 30 - M)
  box.style.left = Math.min(Math.max(box.offsetLeft, M), maxX) + 'px'
  box.style.top = Math.min(Math.max(box.offsetTop, M), maxY) + 'px'
}
$('#trigToggle').addEventListener('click', () => {
  const panel = $('#trigPanel')
  const hidden = panel.hidden
  panel.hidden = !hidden
  const box = $('#trigbox')
  if (box) {
    box.classList.toggle('expanded', hidden)  // hidden 原=true → 刚展开
    if (hidden) {                  // 刚展开:恢复上次拖出来的高度
      const h = (trigWinLoad() || {}).h || 0
      if (h >= 64) trigApplyH(box, h)
    } else {                        // 刚收起:释放高度,只留标题条
      box.style.height = ''
      box.style.maxHeight = ''
    }
  }
  $('#trigToggle').textContent = trigLabel($('#trigToggle'), hidden)
})
$('#trigClear').addEventListener('click', () => {
  if (!S.scope) return
  S.scope.clear()
  renderTrigPanel(S.conditions)
  applyFilter()
})
/* ── 浮窗交互:标题栏拖动移动 + 底缘调高 + 双击标题栏复位 ── */
function bindTrigWin() {
 try {
  const box = document.getElementById('trigbox')
  const bar = document.getElementById('trigBar')
  if (!box || !bar) return
  /* 恢复上次的位置/高度 */
  const p = trigWinLoad()
  if (p) {
    if (p.h >= 64) trigApplyH(box, p.h)
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      box.style.right = 'auto'
      box.style.left = p.x + 'px'
      box.style.top = p.y + 'px'
    }
  }
  trigClamp(box)
  /* 拖动移动 */
  let d = null
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    /* ★ 标题栏上的按钮是点击目标,不能启动拖动 —— setPointerCapture 会吞掉
       真实点击的 click(参照 music.js 浮窗标题栏的同款教训)。 */
    if (e.target.closest && e.target.closest('button')) return
    e.preventDefault()
    d = { x: e.clientX, y: e.clientY, ox: box.offsetLeft, oy: box.offsetTop }
    try { bar.setPointerCapture(e.pointerId) } catch {}
    box.classList.add('dragging')
  })
  bar.addEventListener('pointermove', (e) => {
    if (!d) return
    box.style.right = 'auto'
    box.style.left = Math.round(d.ox + (e.clientX - d.x)) + 'px'
    box.style.top = Math.round(d.oy + (e.clientY - d.y)) + 'px'
    trigClamp(box)
  })
  function endDrag(e) {
    if (!d) return
    d = null
    box.classList.remove('dragging')
    try { bar.releasePointerCapture(e.pointerId) } catch {}
    trigWinSave(Object.assign(trigWinLoad() || {}, { x: box.offsetLeft, y: box.offsetTop }))
  }
  bar.addEventListener('pointerup', endDrag)
  bar.addEventListener('pointercancel', endDrag)
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('button')) return
    box.style.left = ''; box.style.top = ''; box.style.right = ''
    trigClamp(box)
    trigWinSave(Object.assign(trigWinLoad() || {}, { x: null, y: null }))
  })
  /* 底缘高度握把 */
  const grip = document.getElementById('trigResize')
  if (grip) {
    let r = null
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      r = { y: e.clientY, h: box.getBoundingClientRect().height }
      try { grip.setPointerCapture(e.pointerId) } catch {}
    })
    grip.addEventListener('pointermove', (e) => {
      if (!r) return
      trigApplyH(box, r.h + (r.y - e.clientY))   // 向上拖 → 变高
    })
    function endResize(e) {
      if (!r) return
      r = null
      try { grip.releasePointerCapture(e.pointerId) } catch {}
    }
    grip.addEventListener('pointerup', endResize)
    grip.addEventListener('pointercancel', endResize)
  }
  window.addEventListener('resize', () => trigClamp(box))
 } catch (e2) { console.error('bindTrigWin init failed (non-fatal):', e2 && e2.message) }
}
bindTrigWin()
if ($('#onlyDangling')) $('#onlyDangling').addEventListener('change', applyFilter)
/* OWNERSHIP_V1:归属筛选 */
if ($('#ownSel')) $('#ownSel').addEventListener('change', applyFilter)
$('#zi').addEventListener('click', () => zoomBy(1.25))
$('#zo').addEventListener('click', () => zoomBy(1 / 1.25))
$('#fit').addEventListener('click', fit)
$('#togName').addEventListener('click', () => {
  S.showLabel = !S.showLabel
  render()
})
window.addEventListener('resize', () => applyTransform())

/* ══════════════════════════════════════════════════════════
 * 右键菜单 + 快捷键(RIGHTCLICK_V1 / KEYS_V1)
 * ══════════════════════════════════════════════════════════ */
function techMenuItems(n) {
  return Ctx.sourceItems({
    // ★ RIGHTCLICK_ROOT_V1(2026-10-06 修「右键只能打开基础游戏文件」):
    //   原先硬编码 `root: 0`,注释的假设是「科技只有一份生效文件,所以用 vanilla」。
    //   那个假设不成立 —— 模组可以整份替换 technology/technology_folders,
    //   硬编码 0 会让「用 VS Code 打开」定位到**基础游戏**里的同名文件。
    //   后端 tech/graph 现在下发真实的 root/rootName(2026-10-06 补)。
    root: typeof n.root === 'number' && n.root >= 0 ? n.root : 0,
    rootName: n.rootName || '科技',
    file: n.file,
    line: n.line,
    id: n.id,
    extra: [
      { label: '复制 id', k: '⧉', act: () => Ctx.copy(n.id, ' ' + n.id) },
      {
        label: tr('复制前置科技 id(') + (n.leads || []).length + ')',
        k: '⧉',
        act: () => Ctx.copy((n.leads || []).join('\n') || '(无)', ''),
      },
      {
        label: tr('复制后续科技 id(') + (n.enables || []).length + ')',
        k: '⧉',
        act: () => Ctx.copy((n.enables || []).join('\n') || '(无)', ''),
      },
      { label: '只显示这个页签', k: '→', act: () => { S.folderFilter = n.folder || ''; render(); toast(tr('已切到页签:') + (n.folder || '全部')) } },
      {
        label: n.hidden ? '取消「隐藏科技」筛选' : '只看隐藏科技',
        k: '◐',
        act: () => { S.showHidden = !S.showHidden; render() },
      },
    ],
  })
}
function folderMenuItems(f) {
  return Ctx.sourceItems({
    // ★ RIGHTCLICK_ROOT_V1:同 techMenuItems,用真实来源而不是硬编码 0
    root: typeof f.root === 'number' && f.root >= 0 ? f.root : 0,
    rootName: f.rootName || '科技页签定义',
    file: f.file,
    line: f.line,
    id: f.id,
    extra: [
      { label: '只看这个页签', k: '→', act: () => { S.folderFilter = f.id; render() } },
      { label: '复制页签 id', k: '⧉', act: () => Ctx.copy(f.id, ' ' + f.id) },
      f.dlcGated ? { label: '⚠ 此页签受 DLC 门控', dis: true } : null,
    ].filter(Boolean),
  })
}
function wireCtxAndKeys() {
  Ctx.attach(gNode, 'g.node', (el) => {
    const n = S.byId.get(el.dataset.id)
    return n ? techMenuItems(n) : null
  })
  // 页签 / 领域筛选条(两类都是 .cpill,用 data-kind 区分)
  Ctx.attach(document.body, '.cpill', (el) => {
    if (el.dataset.kind !== 'folder' || !el.dataset.id) return null // "全部页签"无位置信息
    const f = S.folders.find((x) => x.id === el.dataset.id)
    return f ? folderMenuItems(f) : null
  })
  // 左侧条目栏(.item):隐藏页卡片与常规列表复用同一套科技右键菜单
  Ctx.attach(document.body, '.item', (el) => {
    const n = S.byId.get(el.dataset.id)
    return n ? techMenuItems(n) : null
  })
  if (window.Keys) {
    const K = Keys
    window.__KEYMAP_PAGE__ = 'tech' // 本页归属:bind 查 keymap / 设置页按页分组
    K.bind(null, () => { const q = $('#q'); if (q) q.focus() }, '聚焦搜索框', { id: 'find.search', group: '查找' })
    K.bind(null, fit, '缩放至适合窗口', { id: 'view.fit', group: '视图' })
    K.bind(null, () => { S.zoom = 1; applyTransform() }, '重置缩放 100%', { id: 'view.zoomReset', group: '视图' })
    K.bind(null, () => zoomBy(1.25), '放大', { id: 'view.zoomIn', group: '视图' })
    K.bind(null, () => zoomBy(1 / 1.25), '缩小', { id: 'view.zoomOut', group: '视图' })
    K.bind(null, () => { if (S.sel) Ctx.copy(S.sel, ' ' + S.sel); else toast('先点选一个科技', true) }, '复制选中科技 id', { id: 'sel.copyId', group: '选中' })
    K.bind(null, () => Keys.ctxKey(), '对选中科技打开右键菜单', { id: 'sel.menu', group: '选中' })
    K.bind(null, () => { S.showHidden = !S.showHidden; render(); toast(S.showHidden ? '显示隐藏科技' : '隐藏隐藏科技') }, '切换隐藏科技显示', { id: 'view.toggleHidden', group: '视图' })
    // 分类栏折叠(CATH_V1):折叠后画布拿回全部纵向空间,快捷键比去点右上角快
    K.bind(null, () => { const f = $('#catFold'); if (f) f.click(); else toast('分类栏不在本页', true) }, '折叠 / 展开分类栏(页签·领域)', { id: 'view.foldCat', group: '视图' })
  }
}

// ★ 面板宽度可调:挂载左右侧栏的分隔条,并在宽度变化后重算画布
Sizer.mountAll()
Sizer.onChange(() => applyTransform()) /* 既有 bug:onChange 本身注册的是 resize 监听器,再 dispatch 'resize' 会无限自递归 → 栈溢出。改为直接布局,等价且不循环 */

// ★ 分类栏高度可拉伸 / 可折叠(CATH_V1,修"领域部分占据过长")
wireCatBar()
applyCatH(true)

wireCtxAndKeys()

loadGraph()
