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
 * 格子 = 节点 + 间隙。标签【行内】画在框内底部,不再溢出压下一行(坑 B)。 */
const XU = 104 // 列距
const NW = 88 // 节点宽
const NH = 34 // 单条节点高
const SOCKH = 12 // 同格堆叠时每条占高(坑 A)
/** 行距:按【当前页】最大堆叠高度动态算 —— 一页内一格最多 7 条(实测 bba 空军) */
let YU = 62

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
  showHidden: false,
  onlyDangling: false,
  showBands: true,
  /** 东亚排序用:folder 声明顺序 */
  folderOrder: [],
  /** tex → data:URL(已解码的 PNG);加载失败则存 null */
  icons: new Map(),
  loading: new Set(),
  /** 检查器「显示详情」开关:展开节点的完整字段 */
  techDetail: false,
}

/* ★ 默认科技图标:内置齿轮 SVG(无网络也能显示),当科技没有 icon 字段,
 *   或该 GFX 贴图加载失败时使用 —— 避免出现破图。 */
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
  const r = await fetch(u, opt)
  const d = await r.json()
  // 只有「真在构建」(ready:false + busy:true)才拉进度条,普通查询不受影响
  if (d && d.ready === false && d.busy && window.Progress) {
    if (!api._pg) { api._pg = true; window.Progress.start(`正在构建科技图…`) }
  } else if (d && d.ready && window.Progress && api._pg) {
    api._pg = false
    window.Progress.done()
  }
  return d
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
    $('#statChip').textContent = d.busy ? '构建中…' : '失败:' + d.error
    _retry++
    setTimeout(loadGraph, Math.min(300 * Math.pow(1.6, _retry - 1), 2500))
    return
  }
  S.allNodes = d.nodes
  S.allEdges = d.edges
  S.areas = d.areas || []
  S.categories = d.categories || []
  S.folders = d.folders || []
  S.dangling = d.danglingEdge || []
  S.slots = d.slots || []
  // ★ 建立「科技 → 同格槽位」索引:渲染时据此堆叠(坑 A)
  S.slotIndex = new Map()
  for (const sl of S.slots) sl.ids.forEach((id, i) => S.slotIndex.set(id, { slot: sl, i, n: sl.ids.length }))
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
    `${st.nodes} 科技 / ${st.edges} 边 / ${st.folders} 分组 / ${st.catsDeclared} 领域` +
    (st.overlapSlots ? ` / ${st.overlapSlots} 组同格` : '')
  /* ★ OWNERSHIP_V1:总数就是生效集(同名科技已被模组替换,不重复计)。
   *   悬停显示三态拆分 + 因被覆盖而失效的旧版本数。 */
  S.own = d.own || null
  $('#statChip').title = Own.statsLine(S.own)
  buildOwnSelect()
  if (st.hiddenTechs) {
    $('#showHidden').parentElement.title =
      `无 categories 的科技:游戏里没有标题栏,单独归组显示(实测 ${st.hiddenTechs} 个)`
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
  add('vanilla', `原版 ${st.vanilla ?? 0}`, '原版科技,模组没有同名覆盖它')
  add('override', `模组改写 ${st.override ?? 0}`, '原版有同名科技,被模组整份替换 —— 原版那份已失效')
  add('new', `模组新增 ${st.new ?? 0}`, '原版没有这条科技,模组新增 —— 与原版共存')
  sel.value = S.ownFilter || ''
}

function buildAreaSelect() {
  const sel = $('#areaSel')
  sel.innerHTML = '<option value="">全部领域</option>'
  for (const c of S.categories) {
    const o = document.createElement('option')
    o.value = c.id
    // 顺序表里声明但没科技引用的(实测 28 个 doctrine 树容器)标"空"而不是隐藏
    o.textContent = c.count ? `${areaName(c.id)} (${c.count})` : `${c.id} (空 · 由脚本填充)`
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
    el.title = `folder = ${f.id}\n${f.count} 个科技\n${tags.join('/') || '无门控'}\n点按只看这一页`
    el.onclick = () => {
      S.folderFilter = S.folderFilter === f.id ? '' : f.id
      $('#folderSel').value = S.folderFilter
      // 换页签时清掉领域筛选:领域的科技散在多个页签,叠加容易筛出空集
      S.areaFilter = ''
      $('#areaSel').value = ''
      syncCatBar()
      applyFilter()
    }
    L1.appendChild(el)
  }
  const allF = document.createElement('button')
  allF.className = 'cpill' + (S.folderFilter === '' ? ' on' : '')
  allF.dataset.kind = 'folder'
  allF.dataset.id = ''
  allF.textContent = '全部页签'
  allF.title = `不按页签筛选,显示全部 ${S.allNodes.length} 个科技`
  allF.onclick = () => {
    S.folderFilter = ''
    $('#folderSel').value = ''
    syncCatBar()
    applyFilter()
  }
  L1.appendChild(allF)
  wrap.appendChild(L1)

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
      syncCatBar()
      applyFilter()
    }
    L2.appendChild(el)
  }
  for (const id of pinned) {
    const c = used.find((x) => x.id === id)
    if (c) mkArea(id, areaName(id), c.count, `categories = { ${id} }\n${c.count} 个科技`)
  }
  if (rest.length) {
    const sep = document.createElement('span')
    sep.className = 'barlab'
    sep.textContent = '其他'
    L2.appendChild(sep)
    for (const c of rest) mkArea(c.id, areaName(c.id), c.count, `categories = { ${c.id} }\n${c.count} 个科技`)
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
    const on = el.dataset.kind === 'folder' ? el.dataset.id === S.folderFilter : el.dataset.id === S.areaFilter
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
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
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

  let nodes = S.allNodes
  // ★ 无 categories 的科技:默认隐藏(游戏里也没有标题栏)。
  //   但按归属筛选时【不能】用 hidden 把结果清空 —— 实测 2 个「模组改写」科技
  //   (elephantry / uranium_tipped_bullets)与 8 个「模组新增」全是 hidden,
  //   先过滤 hidden 会让归属筛选恒等于 0 条,用户选了却什么都看不到。
  if (!S.showHidden && !S.ownFilter) nodes = nodes.filter((n) => !n.hidden)
  if (S.ownFilter) nodes = nodes.filter((n) => Own.of(n) === S.ownFilter)
  if (S.folderFilter) nodes = nodes.filter((n) => n.folder === S.folderFilter)
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

  // ★ 归一化 + 动态行距(按本页最深堆叠)
  const off = normOffsets(nodes)
  S.off = off
  let deepest = 1
  for (const n of nodes) {
    const s = S.slotIndex.get(n.id)
    if (s && s.n > deepest) deepest = s.n
  }
  YU = deepest > 1 ? NH + (deepest - 1) * SOCKH + 14 : 62

  renderNodeList()
  render()
  fit()
  const bits = []
  if (S.folderFilter) bits.push('页签 ' + folderName(S.folderFilter))
  if (S.areaFilter) bits.push('领域 ' + areaName(S.areaFilter))
  if (S.ownFilter) bits.push(Own.LABEL[S.ownFilter] || S.ownFilter)
  $('#hud').textContent = `${S.nodes.length} 科技 · ${S.edges.length} 边${bits.length ? ' · ' + bits.join(' · ') : ''}`
  syncCatBar()
}

function renderNodeList() {
  const list = S.nodes
  $('#nodeCount').textContent = `${S.nodes.length}/${S.allNodes.length}`
  const box = $('#nodeList')
  box.innerHTML = ''
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
    const si = S.slotIndex.get(n.id)
    const sock = si && si.n > 1 ? ` <span class="tag" style="color:var(--warn)" title="同坐标 (${si.slot.x}, ${si.slot.y}) 共 ${si.n} 条科技">${si.i + 1}/${si.n}</span>` : ''
    const mark = n.hidden ? ' <span class="tag" style="color:var(--warn)">隐藏</span>' : ''
    el.innerHTML = `<span>${esc(n.id)}</span>${mark}${sock} <span class="tag">${esc(areaName((n.categories || [])[0] || '—'))}${n.cost ? ' · ' + n.cost : ''}</span>`
    el.title = `${n.id}\n${n.file}:${n.line}\n坐标 (${n.x}, ${n.y})${n.posDeclared === false ? '(自动补位)' : ''}${si ? `\n同格 ${si.i + 1}/${si.n}` : ''}`
    el.onclick = () => selectNode(n.id)
    box.appendChild(el)
  }
  if (list.length > shown.length) {
    const more = document.createElement('div')
    more.className = 'item'
    more.style.color = 'var(--ink3)'
    more.textContent = `… 还有 ${list.length - shown.length} 个,用搜索缩小范围`
    box.appendChild(more)
  }
}

/* ── 渲染 ── */
/** ★ 一格内多条科技(坑 A)时,该格的实际绘制高度。
 *  单条 = NH;N 条 = NH + (N-1)*SOCKH,向下生长(行距 YU 已按本页最深堆叠动态放大)。 */
function stackH(si) {
  return si && si.n > 1 ? NH + (si.n - 1) * SOCKH : NH
}
/** 某节点绘制时的左上角像素坐标(含本页归一化偏移) */
function nodeXY(n) {
  const o = S.off || { dx: 0, dy: 0 }
  return { x: (n.x + o.dx) * XU, y: (n.y + o.dy) * YU, h: stackH(S.slotIndex.get(n.id)) }
}
function render() {
  gNode.innerHTML = ''
  gEdge.innerHTML = ''
  gBand.innerHTML = ''
  renderBands()
  for (const e of S.edges) {
    const a = S.byId.get(e.from)
    const b = S.byId.get(e.to)
    if (!a || !b) continue
    const pa = nodeXY(a)
    const pb = nodeXY(b)
    const x1 = pa.x + NW / 2
    const y1 = pa.y + pa.h
    const x2 = pb.x + NW / 2
    const y2 = pb.y
    // 略微弯曲的折线(圆角肘形)—— 全站连线统一风格,实现见 /edgepath.js
    // axis='v':科技树是"前置在上、解锁在下"的竖向流向,强制竖向肘形,弯曲方向恒定正确
    const p = document.createElementNS(SVGNS, 'path')
    p.setAttribute('d', edgePathD(x1, y1, x2, y2, 12, 'v'))
    p.setAttribute('class', 'edge ' + (e.kind === 'enable' ? 'enable' : ''))
    p.dataset.from = e.from
    p.dataset.to = e.to
    gEdge.appendChild(p)
  }
  const tiny = S.nodes.length > 200
  for (const n of S.nodes) {
    const p = nodeXY(n)
    const si = S.slotIndex.get(n.id)
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
        (own === 'new' ? ' own-new' : own === 'override' ? ' own-ovr' : ''),
    )
    g.dataset.id = n.id
    const r = document.createElementNS(SVGNS, 'rect')
    r.setAttribute('class', 'box')
    r.setAttribute('x', p.x)
    r.setAttribute('y', p.y)
    r.setAttribute('width', NW)
    r.setAttribute('height', p.h)
    r.setAttribute('rx', 5)
    g.appendChild(r)
    // ★ 图标:单条节点在左上角画 18×18 图标;堆叠行(si.n>1)太小不放,只留文字
    const isSock = si && si.n > 1
    if (!isSock) {
      const img = document.createElementNS(SVGNS, 'image')
      img.setAttribute('class', 'nodeicon')
      img.setAttribute('x', p.x + 3)
      img.setAttribute('y', p.y + (NH - 18) / 2)
      img.setAttribute('width', 18)
      img.setAttribute('height', 18)
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      // 默认先画内置齿轮图标;懒加载到真实贴图后由 paintIcons 覆盖(失败则保持默认)
      img.setAttribute('href', DEFAULT_TECH_ICON)
      g.appendChild(img)
    }
    // ★ 标签【行内】(坑 B):单条画在框内底部;同格堆叠时每条只画自己那 13px 的行
    const t = document.createElementNS(SVGNS, 'text')
    if (isSock) {
      t.setAttribute('x', p.x + NW / 2)
      t.setAttribute('y', p.y + si.i * SOCKH + SOCKH - 3)
      t.setAttribute('text-anchor', 'middle')
      t.textContent = Loc.text(n.id) ? Loc.label(n.id, 20) : n.id
    } else {
      // 有图标 → 标签从图标右侧起,左对齐,缩短截断避免压边
      t.setAttribute('class', 'nlabel')
      t.setAttribute('x', p.x + 24)
      t.setAttribute('y', p.y + NH / 2 + 4)
      t.setAttribute('text-anchor', 'start')
      const txt = Loc.text(n.id) ? Loc.label(n.id, 12) : n.id
      t.textContent = txt.length > 12 ? txt.slice(0, 11) + '…' : txt
    }
    g.appendChild(t)
    // 同格分隔线:让一格多条看起来是"一叠"而不是一个长条
    if (si && si.n > 1) {
      for (let k = 1; k < si.n; k++) {
        const ln = document.createElementNS(SVGNS, 'line')
        ln.setAttribute('class', 'sockline')
        ln.setAttribute('x1', p.x + 3)
        ln.setAttribute('x2', p.x + NW - 3)
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
    const c = nodeXY(n)
    const sx = c.x * XU * S.zoom + S.tx
    const sy = c.y * YU * S.zoom + S.ty
    const w = NW * S.zoom
    const h = nodeXY(n).h * S.zoom
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
    t.textContent = `(无 folder 声明 · 坐标自动补位)  (${noFolder.length})`
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
  const si = S.slotIndex.get(n.id)
  const cats = (n.categories || []).map((c) => {
    const cnt = S.categories.find((x) => x.id === c)?.count
    return `${areaName(c)} <span style="color:var(--ink3)">(${c}${cnt === undefined ? '' : ' · ' + cnt})</span>`
  })
  const sockRow = si
    ? `<div class="kv"><b>同格</b><span><span style="color:var(--warn)">第 ${si.i + 1} / ${si.n} 条</span> —
        坐标 (${si.slot.x}, ${si.slot.y}) 上共 ${si.n} 条科技(互斥/DLC 替代,画布上堆叠显示为一卡带)<br>
        ${si.slot.ids.map((id, i) => `<span class="tagr${i === si.i ? ' on' : ''}">${esc(id)}</span>`).join('')}</span></div>`
    : ''
  $('#insp').innerHTML = `
    <button id="inspDetailBtn" class="dbtn">${S.techDetail ? '▾ 收起详情' : '▸ 显示详情'}</button>
    <div class="kv"><b>id</b><span>${esc(n.id)}</span></div>
    <div class="kv"><b>归属</b><span>${Own.badge(n)} ${esc(n.rootName || '')}${
      (n.defs || []).length > 1
        ? ` <span style="color:var(--ink3)">(同名定义 ${(n.defs || []).length} 处:${
            (n.defs || []).map((d) => esc(d.rootName)).join(' → ')
          },最后一个生效)</span>`
        : ''
    }</span></div>
    <div class="kv"><b>分组</b><span>${n.folder ? esc(folderName(n.folder)) + (f ? ` <span style="color:var(--ink3)">(${esc(f.id)})</span>` : '') : '<span style="color:var(--warn)">无 folder 声明</span>'}</span></div>
    <div class="kv"><b>ledger</b><span>${f?.ledger ? esc(LEDGER_CN[f.ledger] || f.ledger) + ` <span style="color:var(--ink3)">(${esc(f.ledger)})</span>` : '—'}</span></div>
    ${f?.dlcGated ? '<div class="kv"><b>DLC</b><span style="color:var(--warn)">该分组有 available 条件(按 DLC 切换)</span></div>' : ''}
    <div class="kv"><b>隐藏</b><span>${n.hidden ? '<span style="color:var(--warn)">是 — 无 categories,游戏里无标题栏</span>' : '否'}</span></div>
    ${sockRow}
    <h4>领域 (${(n.categories || []).length})</h4>
    ${cats.length ? cats.map((c) => `<div class="kv"><span>${c}</span></div>`).join('') : '<div class="kv"><span style="color:var(--warn)">无</span></div>'}
    <div class="kv"><b>研究花费</b><span>${n.cost}</span></div>
    <div class="kv"><b>起始年</b><span>${n.year || '—'}</span></div>
    <div class="kv"><b>坐标</b><span>(${n.x}, ${n.y})${n.posDeclared === false ? ' <span style="color:var(--warn)">自动补位(文件未写 folder.position)</span>' : ''}${
      (S.crossFolder?.[`${n.x},${n.y}`] || []).filter((x) => x !== n.folder || '').length
        ? ` <span style="color:var(--warn)">另有 ${(S.crossFolder[`${n.x},${n.y}`] || []).length - 1} 个其他页签也用这一格(游戏里不同屏,正常)</span>`
        : ''
    }</span></div>
    <div class="kv"><b>位置</b><span>${esc(n.file)}:${n.line}</span></div>
    <div class="kv"><b>图标</b><span>${
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
    ${req.length ? `<h4>前置 ${req.length}</h4>${req.map((p) => `<div class="kv"><span>${esc(p)}</span></div>`).join('')}` : ''}
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
    (defs ? `<div class="kv"><b>定义位置</b><span>${defs}</span></div>` : '')
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
  S.tx = st.width / 2 - (p.x + NW / 2) * S.zoom
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
$('#onlyDangling').addEventListener('change', applyFilter)
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
        label: '复制前置科技 id(' + (n.leads || []).length + ')',
        k: '⧉',
        act: () => Ctx.copy((n.leads || []).join('\n') || '(无)', ''),
      },
      {
        label: '复制后续科技 id(' + (n.enables || []).length + ')',
        k: '⧉',
        act: () => Ctx.copy((n.enables || []).join('\n') || '(无)', ''),
      },
      { label: '只显示这个页签', k: '→', act: () => { S.folderFilter = n.folder || ''; render(); toast('已切到页签:' + (n.folder || '全部')) } },
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
Sizer.onChange(() => window.dispatchEvent(new Event("resize")))

// ★ 分类栏高度可拉伸 / 可折叠(CATH_V1,修"领域部分占据过长")
wireCatBar()
applyCatH(true)

wireCtxAndKeys()

loadGraph()
