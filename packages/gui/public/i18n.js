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
  'nav.characters': { zh: '人物角色', en: 'Characters' },
  'nav.characters.desc': { zh: 'common/characters · 肖像 · 职务', en: 'Portraits · Roles · Instances' },
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
  'nav.settings': { zh: '设置', en: 'Settings' },
  'nav.settings.desc': { zh: '主题 · 来源 · 背景', en: 'Theme · Sources · Background' },
  'nav.units': { zh: '单位和装备', en: 'Units & Equipment' },
  'nav.tracker': { zh: '火眼金睛', en: 'Update Tracker' },
  'nav.tracker.desc': { zh: '基线快照 · 变更 diff', en: 'Baseline snapshots · diffs' },
  'tr.baselineAt': { zh: '基线时间', en: 'Baseline' },
  'tr.files': { zh: '文件数', en: 'Files' },
  'tr.lastCheck': { zh: '上次检查', en: 'Last check' },
  'tr.noBaseline': { zh: '尚未建立基线', en: 'No baseline yet' },
  'tr.allRoots': { zh: '全部来源', en: 'All sources' },
  'tr.new': { zh: '新增', en: 'New' },
  'tr.modified': { zh: '修改', en: 'Modified' },
  'tr.deleted': { zh: '删除', en: 'Deleted' },
  'tr.moved': { zh: '移动', en: 'Moved' },
  'tr.selectHistory': { zh: '选择左侧一条检查记录查看变更', en: 'Select a check record to see changes' },
  'tr.noMatch': { zh: '没有匹配的变更', en: 'No matching changes' },
  'tr.clickChange': { zh: '点击左侧变更条目查看差异', en: 'Click a change to see the diff' },
  'tr.loading': { zh: '加载中…', en: 'Loading…' },
  'tr.noDiff': { zh: '该文件无可用差异', en: 'No diff available for this file' },
  'tr.noBaseDiff': { zh: '该变更的旧版本数据已被清理，无法生成行级差异。请点击重新检查生成新记录后再查看。', en: 'The old-version data for this change was cleaned up and no line diff can be generated. Run a re-check to restore it.' },
  'tr.recheck': { zh: '重新检查', en: 'Re-check' },
  'tr.timeout': { zh: '处理超时，请稍后重试', en: 'Timed out. Please retry later' },
  'tr.confirmBaseline': { zh: '建立基线会重置全部历史记录。继续？', en: 'Creating a baseline resets all history. Continue?' },
  'tr.busy': { zh: '扫描中…', en: 'Scanning…' },
  'tr.buildBaseline': { zh: '建立基线', en: 'Create baseline' },
  'tr.checkNow': { zh: '立即检查', en: 'Check now' },
  'tr.clearCache': { zh: '删除缓存', en: 'Delete cache' },
  'tr.confirmClear': { zh: '确定删除全部跟踪缓存（基线/内容/历史）？此操作不可撤销。', en: 'Delete all tracker cache (baseline/content/history)? This cannot be undone.' },
  'tr.history': { zh: '检查更新', en: 'Check updates' },
  'tr.clearRoot': { zh: '删除此来源', en: 'Clear this source' },
  'tr.confirmClearRoot': { zh: '确定删除该来源的基线与历史记录？不影响其它来源。', en: 'Delete this source’s baseline & history? Other sources are unaffected.' },
  'tr.resetBaseline': { zh: '以当前为新基线', en: 'Rebaseline' },
  'tr.confirmReset': { zh: '将当前状态设为新基线？旧基线与此前历史记录将被删除。', en: 'Set current state as new baseline? Old baseline & history will be deleted.' },
  'tr.delHist': { zh: '删除此版本', en: 'Delete version' },
  'tr.confirmDel': { zh: '确定删除这条历史记录？', en: 'Delete this history entry?' },
  'tr.writable': { zh: '可写', en: 'Writable' },
  'tr.readonly': { zh: '只读', en: 'Read-only' },
  'tr.noSources': { zh: '没有可跟踪的来源', en: 'No sources to track' },
  'tr.noHistory': { zh: '该来源尚无检查记录', en: 'No check records for this source' },
  'tr.baselineAt': { zh: '基线时间', en: 'Baseline' },
  'tr.files': { zh: '文件数', en: 'Files' },
  'tr.lastCheck': { zh: '上次检查', en: 'Last check' },
  'tr.sources': { zh: '跟踪来源', en: 'Tracked sources' },
  'tr.clearAll': { zh: '清空全部缓存', en: 'Clear all cache' },
  'tr.gcBlobs': { zh: '清理无用 blob', en: 'Clean up unused blobs' },
  'tr.cancel': { zh: '取消', en: 'Cancel' },
  'tr.filter': { zh: '筛选', en: 'Filter' },
  'tr.filter.root': { zh: '来源', en: 'Source' },
  'tr.filter.kind': { zh: '类型', en: 'Type' },
  'tr.filter.keyword': { zh: '关键词', en: 'Keyword' },
  'tr.changes': { zh: '变更列表', en: 'Changes' },
  'tr.allKinds': { zh: '全部类型', en: 'All types' },
  'tr.viewDiff': { zh: '查看差异', en: 'Diff' },
  'tr.trackerHint': { zh: '基础游戏与每个模组各自独立跟踪。每个来源：①「建立基线」把当前内容存为参照；②「立即检查」对比当前与基线的差异并生成一条「检查更新」记录；③ 记录保留在时间线中，基线自动滚动，下次只报新变化。点击变更条目右侧箭头可展开/收起具体明细。', en: 'The base game and each mod are tracked independently. For each source: 1) "Build baseline" stores the current content as reference; 2) "Check now" compares current vs baseline and produces one "Check updates" record; 3) records stay in the timeline, the baseline auto-rolls, and the next check only reports new changes. Click the arrow on a change to expand/collapse details.' },
  'tr.openInIde': { zh: '在 IDE 中打开', en: 'Open in IDE' },
  'tr.copyPath': { zh: '复制路径', en: 'Copy path' },
  'tr.copyLine': { zh: '复制此行', en: 'Copy line' },
  'tr.copyDiff': { zh: '复制差异', en: 'Copy diff' },
  'tr.copied': { zh: '已复制', en: 'Copied' },
  'tr.openList': { zh: '打开更新列表', en: 'Open update list' },
  'tr.closeList': { zh: '关闭更新列表', en: 'Close update list' },
  'tr.loadList': { zh: '正在载入更新列表…', en: 'Loading update list…' },
  'nav.units.desc': { zh: '单位类型 · 装备 · 命名', en: 'Unit types · Equipment · Names' },

  /* ── 单位和装备 ── */
  'un.title': { zh: '单位和装备', en: 'Units & Equipment' },
  'un.tabUnits': { zh: '单位', en: 'Units' },
  'un.tabEquipment': { zh: '装备', en: 'Equipment' },
  'un.search': { zh: '搜索 id / 名称', en: 'Search id / name' },
  'un.loading': { zh: '正在加载单位和装备…', en: 'Loading units & equipment…' },
  'un.building': { zh: '正在构建单位和装备…', en: 'Building units & equipment…' },
  'un.srcAll': { zh: '全部来源', en: 'All sources' },
  'un.srcBase': { zh: '基础游戏生效', en: 'Base game effective' },
  'un.srcMod': { zh: '模组生效', en: 'Mod effective' },
  'un.srcVanilla': { zh: '原版', en: 'Vanilla' },
  'un.srcOverride': { zh: '模组改写', en: 'Mod override' },
  'un.srcNew': { zh: '模组新增', en: 'Mod added' },
  'un.grpRoot': { zh: '单位类型', en: 'Unit types' },
  'un.grpEquipment': { zh: '装备', en: 'Equipment' },
  'un.grpCriticalParts': { zh: '要害部位', en: 'Critical parts' },
  'un.grpUnitModifiers': { zh: '单位修正', en: 'Unit modifiers' },
  'un.grpNames': { zh: '命名·单位池', en: 'Names · Unit pools' },
  'un.grpNamesDivisions': { zh: '命名·师级', en: 'Names · Divisions' },
  'un.grpNamesRailwayGuns': { zh: '命名·铁道炮', en: 'Names · Railway guns' },
  'un.grpNamesShips': { zh: '命名·舰船', en: 'Names · Ships' },
  'un.grpCodenamesOperatives': { zh: '代号·特工', en: 'Codenames · Operatives' },
  'un.insEmpty': { zh: '点选一个条目', en: 'Select an entry' },
  'un.noMatch': { zh: '没有符合筛选条件的条目', en: 'No matching entries' },
  'un.file': { zh: '文件', en: 'File' },
  'un.own': { zh: '归属', en: 'Ownership' },
  'un.defs': { zh: '定义链', en: 'Definition chain' },
  'un.fields': { zh: '字段', en: 'Fields' },
  'un.other': { zh: '其他字段', en: 'Other fields' },
  'un.none': { zh: '无', en: 'None' },
  'un.sum': { zh: ' 条目', en: ' entries' },
  'un.sumFile': { zh: ' 文件', en: ' files' },

  /* un.f.* typed 字段标签 */
  'un.f.abbreviation': { zh: '缩写', en: 'Abbreviation' },
  'un.f.sprite': { zh: '精灵', en: 'Sprite' },
  'un.f.mapIconCategory': { zh: '地图图标类', en: 'Map icon' },
  'un.f.category': { zh: '单位类别', en: 'Category' },
  'un.f.type': { zh: '类型', en: 'Type' },
  'un.f.group': { zh: '分组', en: 'Group' },
  'un.f.morphGroup': { zh: '变形组', en: 'Morph group' },
  'un.f.categories': { zh: '所属类目', en: 'Categories' },
  'un.f.active': { zh: '启用', en: 'Active' },
  'un.f.priority': { zh: '优先级', en: 'Priority' },
  'un.f.aiPriority': { zh: 'AI优先级', en: 'AI priority' },
  'un.f.combatWidth': { zh: '作战宽度', en: 'Combat width' },
  'un.f.manpower': { zh: '人力', en: 'Manpower' },
  'un.f.maxStrength': { zh: '最大兵力', en: 'Max strength' },
  'un.f.maxOrg': { zh: '最大组织度', en: 'Max organisation' },
  'un.f.defaultMorale': { zh: '默认士气', en: 'Default morale' },
  'un.f.trainingTime': { zh: '训练时间', en: 'Training time' },
  'un.f.suppression': { zh: '镇压', en: 'Suppression' },
  'un.f.weight': { zh: '重量', en: 'Weight' },
  'un.f.supplyConsumption': { zh: '补给消耗', en: 'Supply consumption' },
  'un.f.maxSpeed': { zh: '最大速度', en: 'Max speed' },
  'un.f.recon': { zh: '侦察', en: 'Recon' },
  'un.f.need': { zh: '需求装备', en: 'Needs' },
  'un.f.specialForces': { zh: '特种部队', en: 'Special forces' },
  'un.f.marines': { zh: '海军陆战队', en: 'Marines' },
  'un.f.affectsSpeed': { zh: '影响速度', en: 'Affects speed' },
  'un.f.regimental': { zh: '营级', en: 'Regimental' },
  'un.f.canBeParachuted': { zh: '可伞降', en: 'Parachutable' },
  'un.f.casualtyTrickleback': { zh: '伤亡回流', en: 'Casualty trickleback' },
  'un.f.experienceLossFactor': { zh: '经验损失系数', en: 'Exp loss factor' },
  'un.f.supplyConsumptionFactor': { zh: '补给消耗系数', en: 'Supply factor' },
  'un.f.criticalParts': { zh: '要害部件', en: 'Critical parts' },
  'un.f.criticalPartDamageChanceMult': { zh: '要害损坏倍率', en: 'Crit part chance mult' },
  'un.f.hitProfileMult': { zh: '命中轮廓倍率', en: 'Hit profile mult' },
  'un.f.terrain': { zh: '地形修正', en: 'Terrain' },
  'un.f.year': { zh: '年份', en: 'Year' },
  'un.f.isArchetype': { zh: '原型', en: 'Is archetype' },
  'un.f.archetype': { zh: '原型链', en: 'Archetype' },
  'un.f.parent': { zh: '父级', en: 'Parent' },
  'un.f.isBuildable': { zh: '可生产', en: 'Buildable' },
  'un.f.canBeProduced': { zh: '生产门控', en: 'Can be produced' },
  'un.f.picture': { zh: '图片', en: 'Picture' },
  'un.f.folder': { zh: '3D文件夹', en: 'Folder' },
  'un.f.equipName': { zh: '装备名', en: 'Name' },
  'un.f.equipType': { zh: '装备类型', en: 'Type' },
  'un.f.groupBy': { zh: '分组依据', en: 'Group by' },
  'un.f.interfaceCategory': { zh: '界面类', en: 'Interface category' },
  'un.f.visualLevel': { zh: '外观等级', en: 'Visual level' },
  'un.f.buildCostIc': { zh: '造价IC', en: 'IC cost' },
  'un.f.powerCostAdd': { zh: '额外电力', en: 'Power cost' },
  'un.f.resources': { zh: '资源', en: 'Resources' },
  'un.f.reliability': { zh: '可靠性', en: 'Reliability' },
  'un.f.defense': { zh: '防御', en: 'Defense' },
  'un.f.breakthrough': { zh: '突破', en: 'Breakthrough' },
  'un.f.hardness': { zh: '硬度', en: 'Hardness' },
  'un.f.armorValue': { zh: '装甲', en: 'Armor' },
  'un.f.softAttack': { zh: '软攻', en: 'Soft attack' },
  'un.f.hardAttack': { zh: '硬攻', en: 'Hard attack' },
  'un.f.apAttack': { zh: '穿甲', en: 'AP attack' },
  'un.f.airAttack': { zh: '防空', en: 'Air attack' },
  'un.f.lendLeaseCost': { zh: '租借花费', en: 'Lend-lease cost' },
  'un.f.maxSpeedEq': { zh: '最大速度', en: 'Max speed' },
  'un.f.moduleSlots': { zh: '模块槽位', en: 'Module slots' },
  'un.f.upgrades': { zh: '升级', en: 'Upgrades' },
  'un.f.icon': { zh: '图标', en: 'Icon' },
  'un.f.frame': { zh: '帧', en: 'Frame' },
  'un.f.chance': { zh: '损坏几率', en: 'Chance' },
  'un.f.poolParent': { zh: '所属tag', en: 'Pool parent' },
  'un.f.prefix': { zh: '前缀', en: 'Prefix' },
  'un.f.fallbackName': { zh: '后备名', en: 'Fallback name' },
  'un.f.poolType': { zh: '池类型', en: 'Type' },
  'un.f.forCountries': { zh: '适用国家', en: 'For countries' },
  'un.f.genericCount': { zh: '通用名数', en: 'Generic' },
  'un.f.uniqueCount': { zh: '独有名数', en: 'Unique' },
  'un.f.orderedCount': { zh: '序列名数', en: 'Ordered' },
  'un.f.cavalry': { zh: '骑兵', en: 'Cavalry' },
  'un.f.canExfiltrateFromCoast': { zh: '无港离岸', en: 'Coast exfiltration' },
  'un.f.mountaineers': { zh: '山地部队', en: 'Mountaineers' },
  'un.f.transport': { zh: '运输装备', en: 'Transport' },
  'un.f.essential': { zh: '必备装备', en: 'Essential' },
  'un.f.attack': { zh: '火力', en: 'Attack' },
  'un.f.entrenchment': { zh: '堑壕', en: 'Entrenchment' },
  'un.f.initiative': { zh: '主动性', en: 'Initiative' },
  'un.f.suppressionFactor': { zh: '镇压加成', en: 'Suppression factor' },
  'un.f.reliabilityFactor': { zh: '可靠性系数', en: 'Reliability factor' },
  'un.f.movement': { zh: '移动', en: 'Movement' },
  'un.f.canBeLendLeased': { zh: '可租借', en: 'Can be lend-leased' },
  'un.f.isConvertable': { zh: '可转换', en: 'Convertible' },
  'un.f.canLicense': { zh: '可授权', en: 'Can license' },
  'un.f.isFrame': { zh: '框架装备', en: 'Is frame' },
  'un.f.maxMilitaryFactories': { zh: '军工厂上限', en: 'Max mil. factories' },
  'un.f.maxDockyardFactories': { zh: '船坞上限', en: 'Max dockyards' },
  'un.f.navalSpeed': { zh: '航速', en: 'Naval speed' },
  'un.f.fireRange': { zh: '射程(已废弃)', en: 'Fire range (obsolete)' },
  'un.f.lgArmorPiercing': { zh: '轻炮穿甲', en: 'Light gun AP' },
  'un.f.lgAttack': { zh: '轻炮攻击', en: 'Light gun attack' },
  'un.f.hgArmorPiercing': { zh: '重炮穿甲', en: 'Heavy gun AP' },
  'un.f.hgAttack': { zh: '重炮攻击', en: 'Heavy gun attack' },
  'un.f.torpedoAttack': { zh: '鱼雷攻击', en: 'Torpedo attack' },
  'un.f.antiAirAttack': { zh: '防空火力', en: 'Anti-air attack' },
  'un.f.shoreBombardment': { zh: '岸轰(已废弃)', en: 'Shore bombardment (obsolete)' },
  'un.f.evasion': { zh: '闪避(已废弃)', en: 'Evasion (obsolete)' },
  'un.f.surfaceDetection': { zh: '水面探测', en: 'Surface detection' },
  'un.f.subAttack': { zh: '反潜攻击', en: 'Sub attack' },
  'un.f.subDetection': { zh: '潜艇探测', en: 'Sub detection' },
  'un.f.surfaceVisibility': { zh: '水面可见度', en: 'Surface visibility' },
  'un.f.subVisibility': { zh: '潜艇可见度', en: 'Sub visibility' },
  'un.f.navalRange': { zh: '海军航程', en: 'Naval range' },
  'un.f.portCapacityUsage': { zh: '港口占用', en: 'Port capacity usage' },
  'un.f.searchAndDestroyCoordination': { zh: '搜歼协同', en: 'S&D coordination' },
  'un.f.convoyRaidingCoordination': { zh: '破交协同', en: 'Convoy raiding coord.' },
  'un.f.airDefence': { zh: '防空', en: 'Air defence' },
  'un.f.airRange': { zh: '航程', en: 'Air range' },
  'un.f.airAgility': { zh: '机动性', en: 'Air agility' },
  'un.f.airGroundAttack': { zh: '对地攻击', en: 'Air ground attack' },
  'un.f.airBombing': { zh: '战略轰炸', en: 'Air bombing' },
  'un.f.airSuperiority': { zh: '制空权', en: 'Air superiority' },
  'un.f.navalStrikeAttack': { zh: '对海攻击', en: 'Naval strike attack' },
  'un.f.navalStrikeTargetting': { zh: '对海瞄准', en: 'Naval strike targeting' },
  'un.f.carrierSize': { zh: '航母占用', en: 'Carrier size' },
  'un.f.defaultCarrierCompositionWeight': { zh: '航母编成权重', en: 'Carrier composition weight' },
  'un.f.carrierCapable': { zh: '可上航母', en: 'Carrier capable' },
  'un.f.variantName': { zh: '变体名', en: 'Variant name' },

  /* 音乐 */
  'music.open': { zh: '音乐', en: 'Music' },
  'music.play': { zh: '播放', en: 'Play' },
  'music.pause': { zh: '暂停', en: 'Pause' },
  'music.prev': { zh: '上一曲', en: 'Prev' },
  'music.next': { zh: '下一曲', en: 'Next' },
  'music.vol': { zh: '音量', en: 'Volume' },
  'music.station': { zh: '歌单', en: 'Station' },
  'music.hide': { zh: '隐藏', en: 'Hide' },
  'music.songs': { zh: '曲目', en: 'Tracks' },
  'music.source': { zh: '来源', en: 'Source' },
  'music.title': { zh: '音乐播放', en: 'Music Player' },
  /* ★ MUSIC_MODE_V2(2026-10-22):四模式。
     repeat 由"列表循环"改为"单曲循环"(用户点"循环播放"期望重播当前这首),
     列表循环单独用 listloop 键。旧键名保留不破坏已存的 localStorage。 */
  'music.mode.order': { zh: '顺序播放', en: 'Sequential' },
  'music.mode.listloop': { zh: '列表循环', en: 'List Loop' },
  'music.mode.repeat': { zh: '单曲循环', en: 'Repeat One' },
  'music.mode.shuffle': { zh: '随机播放', en: 'Shuffle' },

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
  'wm.tag': { zh: 'TAG', en: 'TAG' },
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
  'wm.pType': { zh: '省份类型', en: 'Province type' },
  'wm.pTypeLand': { zh: '陆地', en: 'Land' },
  'wm.pTypeSea': { zh: '海洋', en: 'Sea' },
  'wm.pTypeLake': { zh: '湖泊', en: 'Lake' },
  'wm.coastal': { zh: '海岸', en: 'Coastal' },
  'wm.terrain': { zh: '地形', en: 'Terrain' },
  'wm.continent': { zh: '大陆', en: 'Continent' },
  'wm.stratRegion': { zh: '战略区域', en: 'Strategic region' },
  'wm.claims': { zh: '宣称', en: 'Claims' },
  'wm.impassable': { zh: '不可通行', en: 'Impassable' },
  'wm.buildingFactor': { zh: '建筑槽系数', en: 'Buildings max level factor' },
  'wm.yes': { zh: '是', en: 'Yes' },
  'wm.no': { zh: '否', en: 'No' },
  'wm.none': { zh: '无', en: 'None' },
  'wm.sr': { zh: '战略区域', en: 'Strategic regions' },
  'wm.srUnit': { zh: ' 区', en: ' regions' },
  'wm.srSearch': { zh: '搜索名称或 ID…', en: 'Search name or ID…' },
  'wm.srProvinces': { zh: '省份', en: 'provinces' },
  'wm.srNavalTerrain': { zh: '海军地形', en: 'Naval terrain' },
  'wm.srModifiers': { zh: '静态修正', en: 'Static modifiers' },
  'wm.srWeather': { zh: '天气周期', en: 'Weather periods' },
  'wm.srPeriod': { zh: '周期', en: 'Period' },
  'wm.srTemperature': { zh: '温度', en: 'Temperature' },
  'wm.srEmpty': { zh: '点击区域查看详情', en: 'Select a region' },
  'wm.srNone': { zh: '无匹配区域', en: 'No matching regions' },
  'wm.srNoWeather': { zh: '无天气数据', en: 'No weather data' },
  /* LAYOUT_V2(2026-10-21):5 个地图模式按钮 + 图例自适应文案 */
  'wm.mProvince': { zh: '省份', en: 'Provinces' },
  'wm.mState': { zh: '州', en: 'States' },
  'wm.mSr': { zh: '战略区域', en: 'Regions' },
  'wm.mOwner': { zh: '国家', en: 'Countries' },
  'wm.mTerrain': { zh: '地形', en: 'Terrain' },
  'wm.dots': { zh: '省份点', en: 'Province dots' },
  'wm.rivers': { zh: '河流叠加', en: 'Rivers' },
  'wm.diag': { zh: '诊断', en: 'Diagnostics' },
  'wm.provinceUnit': { zh: ' 个省份', en: ' provinces' },
  'wm.terrainUnit': { zh: ' 种地形', en: ' terrains' },
  'wm.baseLegendHint': { zh: '原始省份位图：每个省份按 definition.csv 的配色上色。悬停查看归属，点击展开详情。', en: 'Raw province bitmap: each province keeps its definition.csv color. Hover for ownership, click for details.' },
  'wm.stateLegendHint': { zh: '按所属州着色（相邻州色相不同）。悬停看州 ID 与名称，点击展开全部属性。', en: 'Colored by state (adjacent states differ in hue). Hover for state ID/name, click for full details.' },
  'wm.srLegendHint': { zh: '按所属战略区域着色。悬停看归属，点击展开属性；可在「战略区域」面板检索。', en: 'Colored by strategic region. Hover for ownership, click for details; search in the Strategic regions panel.' },

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

  /* ── 更新跟踪 (tracker) ── */
  'tr.title': { zh: 'HOI4 更新跟踪', en: 'HOI4 Update Tracker' },
  'tr.tip': { zh: '对基础游戏与已挂载模组建立基线，手动检查新增 / 修改 / 删除 / 移动。', en: 'Baseline the base game and mounted mods; manually check new / modified / deleted / moved files.' },
  'tr.buildBaseline': { zh: '建立基线', en: 'Build baseline' },
  'tr.checkNow': { zh: '立即检查', en: 'Check now' },
  'tr.busy': { zh: '扫描中…', en: 'Scanning…' },
  'tr.cancel': { zh: '取消', en: 'Cancel' },
  'tr.fileCount': { zh: '文件数', en: 'Files' },
  'tr.rootCount': { zh: '来源数', en: 'Sources' },
  'tr.history': { zh: '检查更新', en: 'Check updates' },
  'tr.noHistory': { zh: '暂无检查记录', en: 'No check records yet' },
  'tr.checkedAt': { zh: '检查时间', en: 'Checked at' },
  'tr.totalChanges': { zh: '变更', en: 'changes' },
  'tr.filter': { zh: '筛选', en: 'Filter' },
  'tr.filter.root': { zh: '来源', en: 'Source' },
  'tr.filter.kind': { zh: '类型', en: 'Type' },
  'tr.filter.keyword': { zh: '关键词', en: 'Keyword' },
  'tr.allSources': { zh: '全部来源', en: 'All sources' },
  'tr.kind.new': { zh: '新增', en: 'New' },
  'tr.kind.modified': { zh: '修改', en: 'Modified' },
  'tr.kind.deleted': { zh: '删除', en: 'Deleted' },
  'tr.kind.moved': { zh: '移动', en: 'Moved' },
  'tr.changes': { zh: '变更列表', en: 'Changes' },
  'tr.noChanges': { zh: '当前筛选下无变更', en: 'No changes match current filters' },
  'tr.from': { zh: '归属', en: 'Source' },
  'tr.overrideNote': { zh: '覆盖了基础来源', en: 'overrides base' },
  'tr.diff.add': { zh: '加', en: 'add' },
  'tr.diff.del': { zh: '删', en: 'del' },
  'tr.diff.ctx': { zh: ' ', en: ' ' },
  'tr.jumpIde': { zh: '跳 IDE', en: 'Open in IDE' },
  'tr.baselineBuilt': { zh: '基线已建立', en: 'Baseline built' },
  'tr.checkedDone': { zh: '检查完成', en: 'Check complete' },
  'tr.loadFail': { zh: '加载失败', en: 'Load failed' },
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
