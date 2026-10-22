/**
 * common/ 全目录定义提取规则表。
 *
 * 设计原则:HOI4 每个 DLC 都可能往 common/ 加新子目录(如 Gotterdämmerung 的
 * military_industrial_organization / raids / technology_sharing)。官方没有完整文档,
 * 所以规则必须**数据驱动、可外挂扩展**,而不是散落在代码里的 if-else。
 *
 * 本表的每一条都是纯数据,由 packages/engine/src/common-index.ts 的通用提取器执行。
 * 新增 DLC 支持有三种方式(见文件末尾 EXTRA 说明):
 *   1. 直接往 COMMON_RULES 加一行
 *   2. 写 common-rules.extra.json —— 不改代码,推荐给模组作者
 *   3. 跑 `hoi4kit common discover` 自动挖掘未覆盖目录并生成候选规则
 *
 * schema 来源:对 vanilla + KR + RT56 共 82 个 common 子目录、约 1.7 万文件
 * 做的统计挖掘(packages/cli/src/diag-common.ts),不是凭印象写的。
 */

export interface CommonRule {
  /** common 下的子目录名 */
  dir: string
  /** 定义种类(用于跨目录引用与分组统计) */
  kind: string
  /**
   * 根级包裹键。'*' 表示文件根级就是定义列表。
   * 例:ideas 的根是 `ideas = { ... }` → root: ['ideas']
   * 例:scripted_effects 文件根级直接是 `xxx = { ... }` → root: '*'
   */
  root: string[] | '*'
  /**
   * 从 root 往下几层才是 id。
   * depth=1:root 下第一层键即 id
   * depth=2:第一层是分组/类别(记为 scope),第二层是 id
   */
  depth: 1 | 2
  /** id 取自块内该键的值,而非键名(如 autonomous_states 的 `id = xxx`) */
  idKey?: string
  /**
   * id 取自嵌套路径,如 intelligence_agencies 的 `default = { tag = USA }` → ['default','tag']。
   * 与 idKey 二选一,idPath 优先。
   */
  idPath?: string[]
  /**
   * 按"块名"精确抓取定义,而不是按 root+depth 层级。
   * 用于那些"定义块名字不固定 / 散落在多处"的情况,例如国策:
   *   focus_tree 容器、其内嵌 focus、以及顶层 shared_focus/joint_focus/continuous_focus 块,
   *   它们名字各不相同但都是"一个焦点定义"。用 matchKeys 统一抓取,
   *   可避免把 focus 内部的 prerequisite/available/offset 等字段误当定义。
   * 命中规则:doc.root 直接子块,以及 root 下 focus_tree 容器内的子块,
   *   其 key ∈ matchKeys 且自身是块 → 视为一个定义。
   */
  matchKeys?: string[]
  /** id 取自文件名(去扩展名)—— countries/ 就是这样,内容是纯属性没有 id */
  idFromFile?: boolean
  /** 允许简单值条目也算定义(country_tags: `GER = "countries/Germany.txt"`) */
  allowValue?: boolean
  /** 跳过这些前缀开头的键(主要用来排除 `@变量` 定义) */
  skipKeyPrefix?: string[]
  /** 明确跳过这些键——它们是配置块而非定义(如 combat_tactics 的 phases) */
  skipKeys?: string[]
  /**
   * 纯行列表格式:整个文件每行一个 token,没有 key = value 结构。
   * 例:common/graphicalculturetype.txt、common/synchronized_dynamic_tokens/tokens.txt
   */
  lineList?: boolean
  /** 排除的子路径(正则字符串),如 decisions/categories */
  exclude?: string
  /** 只在匹配该正则的子路径下生效,与 exclude 相反 */
  include?: string
  /** 该目录里指向 .gfx sprite 的键名,用于图标悬空检查 */
  iconKeys?: string[]
  /** 本地化键名(指向 localisation 的 key) */
  locKeys?: string[]
  /** 说明:用途 / 所属 DLC */
  note?: string
  /** 规则来源 */
  source?: 'vanilla' | 'dlc' | 'user'
}

/** 多数目录共用的图标键 */
const ICON = ['icon', 'picture', 'small_icon', 'map_icon', 'text_icon']
/** 多数目录共用的本地化键 */
const LOC = ['name', 'desc', 'description']

export const COMMON_RULES: CommonRule[] = [
  /* ── 单位与装备 ── */
  { dir: 'units', kind: 'equipment', root: ['equipments'], depth: 1, iconKeys: ICON, note: '装备定义' },
  { dir: 'units', kind: 'sub_unit', root: ['sub_units'], depth: 1, iconKeys: ICON, note: '兵种定义' },
  { dir: 'units', kind: 'equipment_module', root: ['equipment_modules'], depth: 1, note: '舰船/装备模块' },
  { dir: 'units', kind: 'unit_upgrade', root: ['upgrades'], depth: 1, note: '装备升级' },
  { dir: 'units', kind: 'unit_search_filter', root: '*', depth: 1, idKey: 'name', note: '单位搜索筛选器(search_filters 块自带 name)' },
  { dir: 'unit_tags', kind: 'sub_unit_category', root: ['sub_unit_categories'], depth: 1, note: '兵种类别' },
  { dir: 'buildings', kind: 'building', root: ['buildings'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'resources', kind: 'resource', root: ['resources'], depth: 1, iconKeys: ICON, locKeys: LOC },

  /* ── 科技 ── */
  {
    dir: 'technologies',
    kind: 'technology',
    root: ['technologies'],
    depth: 1,
    skipKeyPrefix: ['@'],
    iconKeys: ICON,
    locKeys: LOC,
    note: '科技(文件里常混有 @年份 变量块,必须排除)',
  },
  {
    dir: 'technology_sharing',
    kind: 'technology_sharing_group',
    root: '*',
    depth: 1,
    idKey: 'id',
    iconKeys: ICON,
    locKeys: LOC,
    note: 'Graveyard of Empires / 科技共享组',
  },
  { dir: 'technology_tags', kind: 'technology_folder', root: ['technology_folders'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'technology_tags', kind: 'technology_category', root: ['technology_categories'], depth: 1, note: '科技分类(纯列表)' },
  { dir: 'special_projects', kind: 'special_project', root: '*', depth: 1, skipKeyPrefix: ['@'], iconKeys: ICON, locKeys: LOC },

  /* ── 国家与意识形态 ── */
  { dir: 'country_tags', kind: 'country_tag', root: '*', depth: 1, allowValue: true, note: 'TAG → countries/ 文件路径' },
  {
    dir: 'countries',
    kind: 'country',
    root: '*',
    depth: 1,
    idFromFile: true,
    note: '国家颜色/文化,没有 id 键,id 取自文件名',
  },
  { dir: 'country_tag_aliases', kind: 'country_tag_alias', root: '*', depth: 1, note: 'TAG 别名(动态 TAG)' },
  { dir: 'ideologies', kind: 'ideology', root: ['ideologies'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'names', kind: 'name_list', root: '*', depth: 1, note: '按 TAG 组织的姓名表' },
  { dir: 'factions', kind: 'faction_goal', root: '*', depth: 1, skipKeyPrefix: ['@'], iconKeys: ICON, locKeys: LOC },
  { dir: 'wargoals', kind: 'wargoal_type', root: ['wargoal_types'], depth: 1, locKeys: LOC },
  { dir: 'state_category', kind: 'state_category', root: ['state_categories'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'terrain', kind: 'terrain', root: ['terrain'], depth: 1, note: '地形' },
  { dir: 'terrain', kind: 'terrain_category', root: ['categories'], depth: 1, note: '地形类别' },
  { dir: 'strategic_locations', kind: 'strategic_location', root: '*', depth: 1, note: '战略地点' },

  /* ── 国策 ── */
  {
    dir: 'national_focus',
    kind: 'focus',
    // 焦点定义散落在四种块里:focus_tree 容器本身、其内嵌 focus、以及顶层
    // shared_focus / joint_focus / continuous_focus 块。统一用 matchKeys 抓取,
    // 避免把 focus 内部的 prerequisite/available/offset 等字段误当成定义。
    matchKeys: ['focus_tree', 'focus', 'shared_focus', 'joint_focus', 'continuous_focus'],
    idKey: 'id',
    iconKeys: ['icon'],
    locKeys: LOC,
    note: '焦点定义(focus_tree 容器及其内嵌 focus、顶层 shared/joint/continuous_focus 块)',
  },
  { dir: 'national_focus', kind: 'focus_style', root: ['style'], depth: 1, idKey: 'name', note: '国策标题栏样式' },
  {
    dir: 'continuous_focus',
    kind: 'continuous_focus',
    // 层级实测(vanilla common/continuous_focus/generic.txt):
    //   continuous_focus_palette = { country = {...}  focus = { id = X  available = {...} } ... }
    // palette 的【直接子层】就是 focus,所以 depth:1(不是 2)。用 depth:2 会多下一层,
    // 抓到 available/enable/modifier 这些字段当定义(实测 id 变成 "available")。
    root: ['continuous_focus_palette'],
    depth: 1,
    // palette 的直接子层除 focus 外还有元数据块(country = { factor = 1 }、
    // default / reset_on_civilwar / position 等),它们不是国策,必须排除,
    // 否则会索引出 id="country" 的假定义。
    skipKeys: ['country', 'default', 'position', 'reset_on_civilwar', 'visible', 'available', 'id'],
    idKey: 'id',
    iconKeys: ['icon'],
    locKeys: LOC,
    note: 'continuous_focus_palette 里的持续国策(消耗政治点持续;enable/modifier/available 语义同国策)',
  },
  { dir: 'focus_inlay_windows', kind: 'inlay_window', root: '*', depth: 1, note: '国策内嵌窗口' },

  /* ── 决议与事件相关 ── */
  {
    dir: 'decisions',
    kind: 'decision',
    root: '*',
    depth: 2,
    exclude: 'categories/',
    skipKeyPrefix: ['@'],
    iconKeys: ICON,
    locKeys: LOC,
    note: '根级是分类,第二层是 decision;categories/ 是分类定义需排除',
  },
  {
    dir: 'decisions',
    kind: 'decision_category',
    root: '*',
    depth: 1,
    include: 'categories[/\\\\]',
    iconKeys: ICON,
    locKeys: LOC,
    note: 'decisions/categories 下的分类定义',
  },
  { dir: 'on_actions', kind: 'on_action', root: ['on_actions'], depth: 1, note: '事件钩子' },
  { dir: 'mtth', kind: 'mtth', root: '*', depth: 1, note: '平均发生时间权重' },
  { dir: 'bop', kind: 'balance_of_power', root: '*', depth: 1, note: '势力平衡(Balance of Power)' },
  { dir: 'game_rules', kind: 'game_rule', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'timed_activities', kind: 'timed_activity', root: '*', depth: 1, note: '限时活动' },

  /* ── 脚本层 ── */
  { dir: 'scripted_effects', kind: 'scripted_effect', root: '*', depth: 1, skipKeyPrefix: ['@'] },
  { dir: 'scripted_triggers', kind: 'scripted_trigger', root: '*', depth: 1, skipKeyPrefix: ['@'] },
  {
    dir: 'scripted_localisation',
    kind: 'scripted_loc',
    root: '*',
    depth: 1,
    idKey: 'name',
    skipKeyPrefix: ['@'],
    note: 'defined_text 块自带 name;text 是候选文本块不是定义。root 必须是 *:定义是 defined_text 块本身',
  },
  { dir: 'scripted_guis', kind: 'scripted_gui', root: ['scripted_gui'], depth: 1, skipKeyPrefix: ['@'] },
  { dir: 'scripted_diplomatic_actions', kind: 'scripted_diplomatic_action', root: ['scripted_diplomatic_actions'], depth: 1 },
  { dir: 'script_constants', kind: 'script_constant_group', root: '*', depth: 2, note: '如 state_groups.balkans' },
  { dir: 'scorers', kind: 'scorer', root: '*', depth: 1, note: 'AI 目标评分器' },

  /* ── 修正器 ── */
  { dir: 'modifier_definitions', kind: 'modifier_definition', root: '*', depth: 1, skipKeyPrefix: ['@'] },
  { dir: 'modifiers', kind: 'static_modifier', root: '*', depth: 1, skipKeyPrefix: ['@'] },
  { dir: 'dynamic_modifiers', kind: 'dynamic_modifier', root: '*', depth: 1, skipKeyPrefix: ['@'], iconKeys: ICON },
  { dir: 'opinion_modifiers', kind: 'opinion_modifier', root: ['opinion_modifiers'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'resistance_compliance_modifiers', kind: 'resistance_compliance_modifier', root: '*', depth: 1, iconKeys: ICON },
  { dir: 'resistance_activity', kind: 'resistance_activity', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'occupation_laws', kind: 'occupation_law', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'autonomous_states', kind: 'autonomy_state', root: '*', depth: 1, idKey: 'id', iconKeys: ICON, locKeys: LOC },
  { dir: 'abilities', kind: 'ability', root: ['ability'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'aces', kind: 'ace_modifier', root: ['modifiers'], depth: 1, note: '王牌飞行员(Lt. General)' },

  /* ── 人物 / 特质 ── */
  { dir: 'characters', kind: 'character', root: ['characters'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'country_leader', kind: 'country_leader_trait', root: ['leader_traits'], depth: 1, skipKeyPrefix: ['@'], iconKeys: ICON, locKeys: LOC },
  { dir: 'unit_leader', kind: 'unit_leader_trait', root: ['leader_traits'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'unit_leader', kind: 'unit_leader_skill', root: ['leader_skills'], depth: 1, iconKeys: ICON },
  { dir: 'scientist_traits', kind: 'scientist_trait', root: '*', depth: 1, iconKeys: ICON },
  { dir: 'ribbons', kind: 'ribbon', root: ['ribbons'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'medals', kind: 'medal', root: ['medals'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'unit_medals', kind: 'unit_medal', root: ['unit_medals'], depth: 1, skipKeyPrefix: ['@'], iconKeys: ICON, locKeys: LOC },
  { dir: 'profile_pictures', kind: 'profile_picture', root: ['profile_pictures'], depth: 1 },
  { dir: 'profile_backgrounds', kind: 'profile_background', root: ['profile_backgrounds'], depth: 1 },

  /* ── 理念 ── */
  { dir: 'ideas', kind: 'idea', root: ['ideas'], depth: 2, iconKeys: ICON, locKeys: LOC, note: '第一层是类别(country/industrial_concern)' },
  { dir: 'idea_tags', kind: 'idea_slot', root: ['slot_ledgers'], depth: 1, note: '理念槽位账本' },
  { dir: 'idea_tags', kind: 'idea_category', root: ['idea_categories'], depth: 1, note: '理念类别' },
  { dir: 'generation', kind: 'idea_generation_slot', root: ['idea_generation'], depth: 1, note: '随机将领生成槽位' },
  { dir: 'doctrines', kind: 'doctrine', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },

  /* ── 情报 / 行动 ── */
  {
    dir: 'intelligence_agencies',
    kind: 'intelligence_agency',
    root: '*',
    depth: 1,
    idPath: ['default', 'tag'],
    iconKeys: ICON,
    locKeys: LOC,
    note: '情报机构没有 id 键,用 default.tag 当标识',
  },
  {
    dir: 'intelligence_agency_upgrades',
    kind: 'intelligence_agency_upgrade',
    root: '*',
    depth: 2,
    iconKeys: ICON,
    locKeys: LOC,
    note: '第一层是 branch_* 分支,第二层是具体升级',
  },
  { dir: 'operations', kind: 'operation', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'operation_phases', kind: 'operation_phase', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'operation_tokens', kind: 'operation_token', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'raids', kind: 'raid_type', root: ['types'], depth: 1, iconKeys: ICON, locKeys: LOC, note: 'By Blood Alone 突袭' },
  { dir: 'raids', kind: 'raid_category', root: ['categories'], depth: 1, iconKeys: ICON, locKeys: LOC },

  /* ── 军工组织(MIO)── Gotterdämmerung 新增 ── */
  {
    dir: 'military_industrial_organization',
    kind: 'mio_organization',
    root: '*',
    depth: 1,
    iconKeys: ICON,
    locKeys: LOC,
    source: 'dlc',
    note: 'Gotterdämmerung 军工组织;内部还有 trait 子定义',
  },
  { dir: 'equipment_groups', kind: 'equipment_group', root: '*', depth: 1, source: 'dlc', note: 'MIO 装备组' },

  /* ── 和平会议 ── */
  { dir: 'peace_conference', kind: 'peace_ai_desire', root: ['peace_ai_desires'], depth: 1, locKeys: LOC },
  { dir: 'peace_conference', kind: 'peace_action_modifier', root: ['peace_action_modifiers'], depth: 1, locKeys: LOC },
  { dir: 'peace_conference', kind: 'peace_action_category', root: ['peace_action_categories'], depth: 1, locKeys: LOC },

  /* ── AI ── */
  { dir: 'ai_areas', kind: 'ai_area', root: ['areas'], depth: 1 },
  { dir: 'ai_equipment', kind: 'ai_equipment', root: '*', depth: 1 },
  { dir: 'ai_faction_theaters', kind: 'ai_faction_theater', root: '*', depth: 1 },
  { dir: 'ai_focuses', kind: 'ai_focus', root: '*', depth: 1 },
  { dir: 'ai_navy', kind: 'ai_navy_fleet', root: '*', depth: 1 },
  { dir: 'ai_strategy', kind: 'ai_strategy', root: '*', depth: 1 },
  { dir: 'ai_strategy_plans', kind: 'ai_strategy_plan', root: '*', depth: 1, locKeys: LOC },
  { dir: 'ai_templates', kind: 'ai_template', root: '*', depth: 1 },
  { dir: 'collections', kind: 'collection', root: '*', depth: 1, locKeys: LOC, note: '国家/地块集合(脚本复用)' },

  /* ── 界面与杂项 ── */
  { dir: 'map_modes', kind: 'map_mode', root: ['scripted_map_modes'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'frontend', kind: 'frontend_loader', root: '*', depth: 1, note: 'DLC 前端加载开关(load_nsb 等)' },
  { dir: 'achievements', kind: 'achievement', root: '*', depth: 1, note: '成就;根级还可能有 unique_id' },
  { dir: 'bookmarks', kind: 'bookmark', root: ['bookmarks'], depth: 1, idKey: 'name', locKeys: LOC, iconKeys: ['picture'] },
  { dir: 'difficulty_settings', kind: 'difficulty_setting', root: ['difficulty_settings'], depth: 1, idKey: 'key', locKeys: LOC },
  /* 注意:difficulty_settings 原本写成 depth=2,会取到块内字段名;实际结构是
     difficulty_settings = { difficulty_setting = { key = "..." } },定义自带 key。 */

  /* ── 直接放在 common/ 根下的散文件 ── */
  /* 这些不是目录,是文件。dir 用文件名(带扩展名)匹配。 */
  { dir: 'combat_tactics.txt', kind: 'combat_tactic', root: '*', depth: 1, skipKeys: ['phases'], iconKeys: ['picture'], note: 'phases 是阶段配置不是战术定义' },
  { dir: 'achievements.txt', kind: 'achievement', root: '*', depth: 1, idKey: 'id', note: '成就(vanilla 空文件,模组常填)' },
  { dir: 'script_enums.txt', kind: 'script_enum', root: '*', depth: 1, note: '脚本枚举(operative_mission_type 等)' },
  { dir: 'weather.txt', kind: 'weather_effect', root: ['weather_effects'], depth: 1, iconKeys: ICON, note: 'weather.txt 里还有 settings/terrain_modifiers 配置块' },
  { dir: 'region_colors.txt', kind: 'region_color', root: ['color'], depth: 1, note: '战略区域配色' },
  { dir: 'alerts.txt', kind: 'alert', root: ['alerts'], depth: 1, iconKeys: ICON, locKeys: LOC },
  { dir: 'ai_attitudes.txt', kind: 'ai_attitude', root: '*', depth: 1, note: 'AI 态度(vanilla 仅注释)' },
  { dir: 'ai_personalities.txt', kind: 'ai_personality', root: '*', depth: 1, note: 'AI 人格' },
  { dir: 'acclimatation.txt', kind: 'acclimatation', root: '*', depth: 1, note: '气候适应(冷/热)' },
  { dir: 'companies_traits.txt', kind: 'company_trait', root: ['leader_traits'], depth: 1, iconKeys: ICON, locKeys: LOC, note: 'RT56 企业特质' },
  { dir: 'event_modifiers.txt', kind: 'event_modifier', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC, note: 'vanilla 为预留空文件' },
  { dir: 'triggered_modifiers.txt', kind: 'triggered_modifier', root: '*', depth: 1, iconKeys: ICON, locKeys: LOC, note: 'vanilla 为预留空文件' },
  /* 纯行列表:每行一个 token,没有 key = value 结构 */
  {
    dir: 'graphicalculturetype.txt',
    kind: 'graphical_culture',
    root: '*',
    depth: 1,
    lineList: true,
    note: '每行一个文化类型名,无 key=value 结构',
  },
  {
    dir: 'synchronized_dynamic_tokens',
    kind: 'synchronized_dynamic_token',
    root: '*',
    depth: 1,
    lineList: true,
    note: 'tokens.txt 每行一个 token;用于 scripted_gui 变量同步',
  },
]

/**
 * 外挂扩展:common-rules.extra.json。
 *
 * 这是"为新 DLC 添加扩展"的推荐入口 —— 不用改本文件、不用重新编译。
 * 格式就是 CommonRule 的数组,例如 Graveyard of Empires 若新增 common/xyz:
 *   [{ "dir": "xyz", "kind": "xyz_thing", "root": "*", "depth": 1, "note": "GoE 新增" }]
 *
 * 用 `hoi4kit common discover` 可以自动生成这个文件的内容。
 */
export const EXTRA_RULES_FILE = 'common-rules.extra.json'
