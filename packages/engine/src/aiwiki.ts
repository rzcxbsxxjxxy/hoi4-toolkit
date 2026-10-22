/**
 * AI WIKI —— 依据 HOI4 官方 Wiki《AI modding》页(本地 ai_wiki.txt 提取版)
 * 与游戏内官方文档(common/ai_strategy/_documentation.md、
 * common/ai_templates/_documentation.md、common/ai_equipment/_documentation.md、
 * common/peace_conference/ai_peace/_documentation.md、common/ai_navy/_documentation.md)
 * 整理的中文参考数据。
 *
 * 本文件只存"知识",不含解析逻辑;解析与展示由 aibehave.ts / server.ts / aibehave.js 消费。
 * server.ts 的 /api/aibehave/graph 把 AI_WIKI 原样挂到下发的 graph 上(wiki 字段),
 * 前端据此给条目字段挂 Wiki 说明、解析 ai_strategy 的 type 目录。
 *
 * 结构:
 *   strategyTypes —— 全部 AI 策略类型目录(Wiki Types 表 ∪ 官方 _documentation.md token 表)
 *   fieldDocs     —— 字段说明:aspectKey(空串 = 通用)→ 字段名 → 中文说明;
 *                    某方面有特指时用方面键覆盖通用键(如 enable 在计划/和会里语义不同)
 *   mtthDocs      —— MTTH 块机制速览(ai_will_do / ai_chance / add / base / factor)
 */

export interface AiStrategyTypeDoc {
  /** 策略类型 token(ai_strategy 里的 type = X) */
  name: string
  /** 分类:diplomacy / army / navy / intel / production / air / raid / other */
  cat: string
  /** 参数说明,每项一条(zh) */
  params: string[]
  /** 作用描述(zh) */
  desc: string
  /** 备注(zh,可选) */
  note?: string
  /** 示例块原文(可选,<pre> 直接展示) */
  example?: string
}

export interface AiWikiBundle {
  strategyTypes: AiStrategyTypeDoc[]
  /** aspectKey('' = 通用)→ 字段名 → 中文说明 */
  fieldDocs: Record<string, Record<string, string>>
  /** MTTH 机制速览(zh) */
  mtthDocs: string
}

export const AI_WIKI: AiWikiBundle = {
  strategyTypes: [
    /* ── 外交 diplomacy ── */
    {
      name: 'alliance',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 与某国结盟,尽可能加入同一阵营。',
      example: `ai_strategy = {
    type = alliance
    id = USA
    value = -100
}`,
    },
    {
      name: 'antagonize',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 敌视某国,拒绝与其进行大多数外交行动。',
      example: `ai_strategy = {
    type = antagonize
    id = USA
    value = -100
}`,
    },
    {
      name: 'asking_foreign_garrison',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标(不写则对所有国家生效)'],
      desc: '促使 AI 向某国请求外援人力来完成驻防任务。',
      note: '不指定 id 时对所有其他国家生效。',
      example: `ai_strategy = {
    type = asking_foreign_garrison
    id = USA
    value = 100
}`,
    },
    {
      name: 'avoid_starting_wars',
      cat: 'diplomacy',
      params: ['value = <int> 权重(无 id,与 conquer 策略叠加,不针对特定国家)'],
      desc: '让 AI 避免主动挑起战争;其权重与 conquer 策略相加(无目标)。仅用于极特殊场合,不建议广泛使用。',
      example: `ai_strategy = {
    type = avoid_starting_wars
    value = -200
}

ai_strategy = {
    type = conquer
    id = GER
    value = 200
}`,
    },
    {
      name: 'befriend',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 与某国交好,接受与其进行大多数外交行动。',
      example: `ai_strategy = {
    type = befriend
    id = USA
    value = 100
}`,
    },
    {
      name: 'conquer',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 征服某国:更可能宣战、更愿意制造战争目标。',
      note: '不改变战争中 AI 指挥前线的方式。',
      example: `ai_strategy = {
    type = conquer
    id = USA
    value = 100
}`,
    },
    {
      name: 'consider_weak',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '让 AI 认为某国更弱:降低宣战犹豫,或更不愿与其结盟。',
      example: `ai_strategy = {
    type = consider_weak
    id = USA
    value = 100
}`,
    },
    {
      name: 'contain',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 遏制某国,保护该国想要敌视或入侵的国家。',
      example: `ai_strategy = {
    type = contain
    id = USA
    value = 100
}`,
    },
    {
      name: 'declare_war',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 在已有战争目标的情况下对某国宣战。',
      example: `ai_strategy = {
    type = declare_war
    id = USA
    value = 100
}`,
    },
    {
      name: 'diplo_action_acceptance',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标', 'target = <外交行动> 要修改的外交行动'],
      desc: '促使 AI 在他国请求时接受某外交行动(不会因此更主动提出该行动)。',
      note: '外交行动名通常取自本地化键:如 DIPLOMACY_SEND_VOLUNTEERS_TITLE 对应 send_volunteers。',
      example: `ai_strategy = {
    type = diplo_action_acceptance
    id = USA
    value = 100
    target = join_allies
}`,
    },
    {
      name: 'diplo_action_desire',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标', 'target = <外交行动> 要修改的外交行动'],
      desc: '促使 AI 主动向指定国家发起某外交行动(不会因此更可能接受别人提出的该行动)。',
      note: '外交行动名通常取自本地化键(见上)。',
      example: `ai_strategy = {
    type = diplo_action_desire
    id = USA
    value = 100
    target = call_allies
}`,
    },
    {
      name: 'dont_join_wars_with',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 并肩参战的一方', 'target_country = <country> 交战对象'],
      desc: '降低 AI 与指定国家并肩对另一特定国家参战的意愿。',
      note: '不影响 AI 与其他国家一起参战——哪怕那样会和指定国家并肩作战。',
      example: `ai_strategy = {
    type = dont_join_wars_with
    id = USA
    value = 100
    target_country = BHR
}`,
    },
    {
      name: 'ignore',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '降低 AI 与该国进行或接受任何外交行动的意愿。',
      example: `ai_strategy = {
    type = ignore
    id = USA
    value = 100
}`,
    },
    {
      name: 'ignore_claim',
      cat: 'diplomacy',
      params: ['value = <int> 布尔意义,直接设 1', 'id = <country> 策略目标'],
      desc: '促使 AI 无视自己对该国拥有的任何宣称。',
      note: 'value 是布尔意义,设为 1 即可。',
      example: `ai_strategy = {
    type = ignore_claim
    id = USA
    value = 1
}`,
    },
    {
      name: 'influence',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 对目标国家施加外交影响。',
    },
    {
      name: 'prepare_for_war',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 为对某国开战做准备,把部队调往其边境。',
      example: `ai_strategy = {
    type = prepare_for_war
    id = USA
    value = 100
}`,
    },
    {
      name: 'protect',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 保护某国:保证其独立或将其拉入同一阵营。',
      note: '总价值(计入所有策略)为负时,AI 永不保证该国独立。',
      example: `ai_strategy = {
    type = protect
    id = CZE
    value = 200
}`,
    },
    {
      name: 'send_lend_lease_desire',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 向指定国家输送租借法案装备。',
      example: `ai_strategy = {
    type = send_lend_lease_desire
    id = USA
    value = 100
}`,
    },
    {
      name: 'send_volunteers_desire',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 向指定国家派遣志愿军。',
      example: `ai_strategy = {
    type = send_volunteers_desire
    id = USA
    value = 100
}`,
    },
    {
      name: 'spent_faction_initiative_priority',
      cat: 'diplomacy',
      params: ['id = <用途> 阵营倡议点数去向:program / unlock_doctrine_sharing / unlock_faction_commander', 'value = <int> 优先级权重'],
      desc: '修改 AI 花费阵营倡议点数(Faction Initiative)在指定用途上的优先级。',
      note: '非原版类型,由已装载模组定义;阵营规则的倡议点数支出优先级由规则自身的 ai_will_do 决定。',
    },
    {
      name: 'support',
      cat: 'diplomacy',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 在战争中支援某国:输送租借、志愿者或远征军。',
      example: `ai_strategy = {
    type = support
    id = USA
    value = 100
}`,
    },
    /* ── 陆军 army ── */
    {
      name: 'area_priority',
      cat: 'army',
      params: ['value = <int> 策略权重', 'id = <AI area> 要优先的 AI 区域'],
      desc: '促使 AI 在指定 AI 区域内部署更多部队。',
      example: `ai_strategy = {
    type = area_priority
    id = europe
    value = 100
}`,
    },
    {
      name: 'dont_defend_ally_borders',
      cat: 'army',
      params: ['value = <int> 策略权重(>0 即生效)', 'id = <country> 策略目标'],
      desc: '让 AI 绝不在指定国家与其交战国家之间的边境上部署部队。',
      note: '严格二元:总价值为正即生效,AI 不在该边境放一兵一卒。',
      example: `ai_strategy = {
    type = dont_defend_ally_borders
    id = POL
    value = 10
}`,
    },
    {
      name: 'force_concentration_factor',
      cat: 'army',
      params: ['value = <int> 增减的百分点(40 = +40%)'],
      desc: '在默认「集中兵力」比例上额外加的系数。20 表示 +20%(基础 15% 则变 35%)。作用于前线最低需求满足后剩余的"非必需"部队。',
      note: '见 Defines 的 FORCE_CONCENTRATION_UNIT_RATIO_BASE;很大的负值会让 AI 在任何地方都不集中兵力。',
      example: `ai_strategy = {
    type = force_concentration_factor
    value = 20
}`,
    },
    {
      name: 'force_concentration_front_factor',
      cat: 'army',
      params: [
        'tag = <country> / state = <省> / strategic_region = <ID> / area = <AI区域> 目标(均可多个)',
        'country_trigger = { ... } 对国家的触发块(作用域为敌国,FROM 为本国)',
        'state_trigger = { ... } 对省的触发块(作用域为省,FROM 为敌国,FROM.FROM 为本国)',
        'ratio = <小数> 目标覆盖前线比例超过它才启用',
        'value = <int> 正常优先级的系数:40 = +40%,-60 = -60%',
      ],
      desc: '提高/降低 AI 在指定前线集中兵力的优先级分数。所有参数可选,至少指定一个目标。',
      note: 'AI 主要把 armor / heavy_armor / mechanized_assault 角色的师用于进攻。',
      example: `ai_strategy = {
    type = force_concentration_front_factor
    tag = CZE
    state = 9
    strategic_region = 22
    ratio = 0.2
    value = 40
}`,
    },
    {
      name: 'force_concentration_target_weight',
      cat: 'army',
      params: [
        'tag = <country> / state = <省> / strategic_region = <ID> / area = <AI区域> 目标(均可多个)',
        'country_trigger = { ... } 对国家的触发块',
        'state_trigger = { ... } 对省的触发块',
        'value = <int> 正常优先级的系数:40 = +40%,-60 = -60%',
      ],
      desc: '影响 AI「集中兵力」时对各进攻目标的评分。所有参数可选,至少指定一个目标。',
      example: `ai_strategy = {
    # As Germany - Avoid attacking the areas behind the Maginot line
    type = force_concentration_target_weight
    state = 18 # Champagne
    state = 17 # Franche-Comte
    state = 28 # Alsace-Lorraine
    state = 27 # Bourgogne
    value = -60
}`,
    },
    {
      name: 'force_defend_ally_borders',
      cat: 'army',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标(也接受 AI 区域)'],
      desc: '促使 AI 在指定国家与其交战国家之间的边境上部署部队。',
      example: `ai_strategy = {
    type = force_defend_ally_borders
    id = FRA
    value = 100
}`,
    },
    {
      name: 'front_armor_score',
      cat: 'army',
      params: ['value = <int> 策略权重', 'id = <country> 策略目标'],
      desc: '促使 AI 为入侵指定国家投入更多坦克单位。',
      note: '模板里 role = armor 或 front_role_override = offence 的师更易被派往前线。',
      example: `ai_strategy = {
    type = front_armor_score
    id = POL
    value = 100
}`,
    },
    {
      name: 'front_control',
      cat: 'army',
      params: [
        'state = <省> / tag = <country> / strategic_region = <ID> / area = <AI区域> 目标(可多选,须同时满足)',
        'country_trigger = { ... } 对国家的触发块',
        'state_trigger = { ... } 对省份的触发块',
        'ratio = <小数> 该前线需达到的覆盖比例才启用,默认 0',
        'priority = <整数> 优先级,矛盾时高者生效',
        'ordertype = front|invasion 仅作用于陆战线或登陆',
        'execution_type = careful|balanced|rush|rush_weak 前线的执行类型',
        'execute_order = <bool> 强制/禁止执行前线指令',
        'manual_attack = <bool> 是否允许小规模试探进攻,默认 yes',
      ],
      desc: '修改 AI 给某条前线派发的指令(目标类型可叠加,各目标须全部满足)。只改变已存在前线的指令,不改变派往前线的兵力、也不强制创建前线。',
      example: `ai_strategy = {
    type = front_control
    state_trigger = {
        industrial_complex > 1
        is_owned_by = ENG
    }
    ratio = 0.1
    ordertype = front
    execution_type = rush
    manual_attack = no
}`,
    },
    {
      name: 'front_unit_request',
      cat: 'army',
      params: [
        'state = <省> / tag = <country> / strategic_region = <ID> / area = <AI区域> 目标(可多选,须同时满足)',
        'country_trigger = { ... } 对国家的触发块',
        'state_trigger = { ... } 对省份的触发块',
        'value = <int> 在常规请求之上加成的系数',
      ],
      desc: '促使 AI 在指定陆战线上部署更多(负值则更少)部队。',
      example: `ai_strategy = {
    type = front_unit_request
    tag = POL
    value = 100
}`,
    },
    {
      name: 'garrison',
      cat: 'army',
      params: ['value = <int> 策略权重'],
      desc: '控制 AI 用于驻守胜利点与港口、而非活跃在前线的部队数量。',
      example: `ai_strategy = {
    type = garrison
    value = 10
}`,
    },
    {
      name: 'garrison_reinforcement_priority',
      cat: 'army',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 更高优先级地补员驻守胜利点与海军基地的部队。',
      example: `ai_strategy = {
    type = garrison_reinforcement_priority
    value = 100
}`,
    },
    {
      name: 'ignore_army_incompetence',
      cat: 'army',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 在计算中无视师缺乏经验带来的修正。',
      example: `ai_strategy = {
    type = ignore_army_incompetence
    value = 100
}`,
    },
    {
      name: 'invasion_unit_request',
      cat: 'army',
      params: [
        'state = <省> / tag = <country> / strategic_region = <ID> / area = <AI区域> 目标(可多选,须同时满足)',
        'country_trigger = { ... } 对国家的触发块',
        'state_trigger = { ... } 对省份的触发块',
        'value = <int> 在常规请求之上加成的系数',
      ],
      desc: '促使 AI 在以指定目标为目的地的登陆作战中部署更多部队。',
      example: `ai_strategy = {
    type = invasion_unit_request
    state = 123
    value = 100
}`,
    },
    {
      name: 'invade',
      cat: 'army',
      params: ['value = <int> 策略权重(负值 = 避免入侵)', 'id = <country> 策略目标'],
      desc: '促使 AI 对指定国家发动登陆入侵;负值则完全避免入侵该国,正值作为对该潜在敌人的入侵重要性系数。',
      example: `ai_strategy = {
    type = invade
    id = ITA
    value = -10
}`,
    },
    {
      name: 'occupation_policy',
      cat: 'army',
      params: ['value = <int> 策略权重'],
      desc: '修改 AI 对占领区治理政策的选择倾向。',
    },
    {
      name: 'put_unit_buffers',
      cat: 'army',
      params: [
        'ratio = <小数> 要保留的预备部队比例',
        'order_id = <int> 同 ID 的多条策略共享同一比例而非叠加',
        'states = { ... } 要派驻预备队的省份列表',
        'area = <AI区域> 要派驻预备队的 AI 区域',
        'subtract_invasions_from_need = yes 该区域内登陆行动不计入需求,默认 no',
        'subtract_fronts_from_need = yes 该区域内陆战线不计入需求,默认 no',
      ],
      desc: '促使 AI 在指定区域按一定比例保留预备队(驻防待命,可被该区域内的作战指令调用)。',
      example: `ai_strategy = {
    type = put_unit_buffers
    ratio = 0.4
    order_id = 2
    states = {
        125
        126
    }
    area = europe
    subtract_fronts_from_need = yes
}`,
    },
    {
      name: 'scorched_earth_prio',
      cat: 'army',
      params: ['value = <int> 策略权重', 'id = <country> 使用焦土的省份所有者', 'states = { ... } 要使用焦土的省份列表'],
      desc: '促使 AI 在指定省份使用焦土政策。',
      example: `ai_strategy = {
    type = scorched_earth_prio
    value = 100
    id = ENG
    states = {
        123
        124
    }
}`,
    },
    {
      name: 'spare_unit_factor',
      cat: 'army',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 留出更多部队用于协防盟友。',
      example: `ai_strategy = {
    type = spare_unit_factor
    value = 100
}`,
    },
    {
      name: 'theatre_distribution_demand_increase',
      cat: 'army',
      params: ['value = <int> 增加的部队需求(value 1 = 1 个师)', 'id = <省> 目标省(取其所在战区)'],
      desc: '促使 AI 在包含指定省份的战区(及其战线/区域防御)内部分配更多部队。',
      example: `ai_strategy = {
    type = theatre_distribution_demand_increase
    id = 123
    value = 10
}`,
    },
    /* ── 海军 navy ── */
    {
      name: 'coast_defense',
      cat: 'navy',
      params: ['id = <战略地区> 目标战略地区', 'value = <0-100 百分比>'],
      desc: '为指定战略地区设定海岸防御强度。',
      example: `ai_strategy = {
    type = coast_defense
    id = 35
    value = 100
}`,
    },
    {
      name: 'convoy_raiding_target',
      cat: 'navy',
      params: ['id = <country> 目标国家', 'value = <0-100 百分比>'],
      desc: '设定破交作战(袭击运输船)的目标重要性。',
      example: `ai_strategy = {
    type = convoy_raiding_target
    id = FRA
    value = 80
}`,
    },
    {
      name: 'naval_avoid_region',
      cat: 'navy',
      params: ['value = <int> 策略权重', 'id = <战略地区> 目标战略地区'],
      desc: '促使 AI 让舰船避开指定的战略地区。',
      example: `ai_strategy = {
    type = naval_avoid_region
    id = 23
    value = 100
}`,
    },
    {
      name: 'naval_blockade',
      cat: 'navy',
      params: ['target_country = <country> 目标国家', 'id = <战略地区> 战略地区 ID', 'value = <0-100 百分比>'],
      desc: '为指定战略地区设定海上封锁强度。',
      example: `ai_strategy = {
    type = naval_blockade
    target_country = GER
    id = 35
    value = 100
}`,
    },
    {
      name: 'naval_convoy_raid_region',
      cat: 'navy',
      params: ['value = <int> 策略权重', 'id = <战略地区> 目标战略地区'],
      desc: '促使 AI 在指定战略地区袭击运输船。',
      example: `ai_strategy = {
    type = naval_convoy_raid_region
    id = 23
    value = 100
}`,
    },
    {
      name: 'naval_dominance',
      cat: 'navy',
      params: ['id = <AI区域> 或 <战略地区 ID> 目标', 'value = <0-100 百分比>'],
      desc: '为指定 AI 区域(或战略地区)设定夺取制海权的目标强度。',
      example: `ai_strategy = {
    type = naval_dominance
    id = winter_war_front
    value = 99
}`,
    },
    {
      name: 'naval_invasion_dominance_weight',
      cat: 'navy',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 把更多海军力量投入到登陆航线必经海域以夺取制海权。',
      example: `ai_strategy = {
    type = naval_invasion_dominance_weight
    value = 30
}`,
    },
    {
      name: 'naval_invasion_focus',
      cat: 'navy',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 发动登陆作战。',
      example: `ai_strategy = {
    type = naval_invasion_focus
    value = 100
}`,
    },
    {
      name: 'naval_mission_threshold',
      cat: 'navy',
      params: ['value = <int> 策略权重(值越高越不愿执行)', 'id = <海军任务> 要修改阈值的任务'],
      desc: '提高 AI 执行某海军任务的门槛 —— 值越高越不可能去执行该任务。',
      note: '任务名见 core_l_english.yml,如 NAVAL_MISSION_NAME_CONVOY_RAIDING 对应 MISSION_CONVOY_RAIDING。',
      example: `ai_strategy = {
    type = naval_mission_threshold
    id = MISSION_CONVOY_RAIDING
    value = -100
}`,
    },
    {
      name: 'strike_force_home_base',
      cat: 'navy',
      params: ['value = <int> 策略权重', 'id = <战略地区> 目标战略地区'],
      desc: '促使 AI 在指定战略地区执行打击舰队任务。',
      example: `ai_strategy = {
    type = strike_force_home_base
    id = 18
    value = 70
}`,
    },
    /* ── 情报 intel ── */
    {
      name: 'activate_crypto',
      cat: 'intel',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 优先激活密码学(情报机构)项目。',
    },
    {
      name: 'agency_ai_base_num_factories_factor',
      cat: 'intel',
      params: ['value = <int> 百分比系数'],
      desc: '修改 AI 升级情报机构计算时使用的基线工厂数。',
      note: 'value 为 1 相当于在 Defines 基线上增加 1%。',
      example: `ai_strategy = {
    type = agency_ai_base_num_factories_factor
    value = 70
}`,
    },
    {
      name: 'agency_ai_per_upgrade_factories_factor',
      cat: 'intel',
      params: ['value = <int> 百分比系数'],
      desc: '修改 AI 升级情报机构计算时所需的工厂数量。',
      note: 'value 为 1 相当于在基线上增加 1%。',
      example: `ai_strategy = {
    type = agency_ai_per_upgrade_factories_factor
    value = 70
}`,
    },
    {
      name: 'become_head_of_counter_intel',
      cat: 'intel',
      params: ['value = <int> 花费政治点数就任该情报岗位的权重'],
      desc: '为 AI 设定花费政治点数就任「反情报主管」情报顾问岗位的权重(机制类似 become_spymaster)。',
      note: '非原版类型,由已装载模组定义。',
    },
    {
      name: 'become_head_of_crypto',
      cat: 'intel',
      params: ['value = <int> 花费政治点数就任该情报岗位的权重'],
      desc: '为 AI 设定花费政治点数就任「密码主管」情报顾问岗位的权重(机制类似 become_spymaster)。',
      note: '非原版类型,由已装载模组定义。',
    },
    {
      name: 'become_head_of_operations',
      cat: 'intel',
      params: ['value = <int> 花费政治点数就任该情报岗位的权重'],
      desc: '为 AI 设定花费政治点数就任「行动主管」情报顾问岗位的权重(机制类似 become_spymaster)。',
      note: '非原版类型,由已装载模组定义。',
    },
    {
      name: 'become_spymaster',
      cat: 'intel',
      params: ['value = <int> 花费政治点数就任情报主管的权重'],
      desc: '为阵营领袖在尚未担任情报主管时,设定其花费政治点数就任情报主管的权重。',
      note: '1.15.2 加入。',
      example: `ai_strategy = {
    type = become_spymaster
    value = 30
}`,
    },
    {
      name: 'decrypt_target',
      cat: 'intel',
      params: ['value = <int> 策略权重', 'id = <country> 目标国家'],
      desc: '促使 AI 优先破译目标国家的加密通讯。',
    },
    {
      name: 'intelligence_agency_branch_desire_factor',
      cat: 'intel',
      params: ['value = <int> 百分比系数', 'id = <分支> 目标分支机构'],
      desc: '修改 AI 升级情报机构某一分支的意愿权重。',
      note: '分支定义在 common/intelligence_agency_upgrades/*.txt。',
      example: `ai_strategy = {
    type = intelligence_agency_branch_desire_factor
    id = branch_crypto
    value = 70
}`,
    },
    {
      name: 'intelligence_agency_usable_factories',
      cat: 'intel',
      params: ['value = <int> 策略权重(无 id)'],
      desc: '修改 AI 投入情报机构的工厂数量。',
      example: `ai_strategy = {
    type = intelligence_agency_usable_factories
    value = 8
}`,
    },
    {
      name: 'operation_equipment_priority',
      cat: 'intel',
      params: ['value = <int> 策略权重'],
      desc: '促使 AI 优先把装备用于资助秘密行动,而非其他用途。',
      example: `ai_strategy = {
    type = operation_equipment_priority
    value = 80
}`,
    },
    {
      name: 'operative_mission',
      cat: 'intel',
      params: [
        'value = <int> 与其他任务比较的得分',
        'mission = <任务> 要优先的特工任务',
        'mission_target = <country> 目标国家',
        'state = <省> 目标国内优先的省份(可多个,选其一)',
        'priority = <int> 矛盾时最高者生效',
        'num_operatives = <int> 分配的特工人数(可选)',
      ],
      desc: '促使 AI 对目标执行指定的特工任务。',
      note: '任务名见 operatives_l_english.yml,如 BOOST_IDEOLOGY 对应 boost_ideology。',
      example: `ai_strategy = {
    type = operative_mission
    value = 80
    mission = quiet_intel_network
    state = 123
    state = 321
    mission_target = ENG
}`,
    },
    {
      name: 'operative_operation',
      cat: 'intel',
      params: [
        'value = <int> 与其他任务比较的得分',
        'operation = <行动> 要优先的秘密行动',
        'operation_target = <country> 目标国家',
        'state = <省> 目标国内优先的省份(可选,可多个选一)',
        'region = <战略地区> 目标国内优先的战略地区(可选)',
        'priority = <int> 矛盾时最高者生效',
      ],
      desc: '促使 AI 对目标执行指定的秘密行动。',
      note: '行动定义在 common/operations/*.txt。',
      example: `ai_strategy = {
    type = operative_operation
    value = 80
    operation = heavy_water_raid
    operation_target = ENG
}`,
    },
    /* ── 生产 production ── */
    {
      name: 'added_military_to_civilian_factory_ratio',
      cat: 'production',
      params: ['value = <int> 策略权重(正 = 更多军工厂)'],
      desc: '修改 AI 想要维持的军工厂/民用工厂比例。',
      example: `ai_strategy = {
    type = added_military_to_civilian_factory_ratio
    value = 50
}`,
    },
    {
      name: 'ai_wanted_divisions_factor',
      cat: 'production',
      params: ['value = <int> 系数'],
      desc: '修改 AI 期望师数量的系数。',
    },
    {
      name: 'air_factory_balance',
      cat: 'production',
      params: ['value = <int> 策略权重(正 = 更多空军)'],
      desc: '修改 AI 想要维持的空军规模与工厂数量的比例。',
      example: `ai_strategy = {
    type = air_factory_balance
    value = 50
}`,
    },
    {
      name: 'air_xp_spend_priority',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <用途> 要修改的花费用途'],
      desc: '修改 AI 花费空军经验的意愿。',
      note: 'id 可用 unlock_doctrine / equipment_variant / upgrade_xp_cutoff / air_spirit 等(须与空军类别对应)。',
    },
    {
      name: 'build_airplane',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <机型> 目标机型'],
      desc: '促使 AI 生产指定机型的飞机。',
    },
    {
      name: 'build_army',
      cat: 'production',
      params: ['value = <int> 期望的师数量', 'id = <单位角色> 目标角色'],
      desc: '修改 AI 期望的师数量;目标是 AI 模板里的角色。例:infantry = 200 表示 AI 想要正好 200 个步兵师。',
      example: `ai_strategy = {
    type = build_army
    id = infantry
    value = 200
}`,
    },
    {
      name: 'build_building',
      cat: 'production',
      params: [
        'value = <int> AI 权重,用于加权随机选择要建造的建筑',
        'id = <建筑> 目标建筑',
        'target = <省> (或 <省州>) 建造地点,省建筑用省 ID,州建筑用州 ID',
      ],
      desc: '促使 AI 在指定州(或省)建造指定建筑;未指定 target 时随机选址。策略在目标建筑已在建时被忽略。',
      note: '内部 AI 也会动态使用该策略,默认权重为 1。',
      example: `ai_strategy = {
    type = build_building
    id = industrial_complex
    target = 803
    value = 1
}`,
    },
    {
      name: 'build_ship',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <舰型> 目标舰型'],
      desc: '促使 AI 建造指定类型的舰船。',
    },
    {
      name: 'building_target',
      cat: 'production',
      params: ['value = <int> 要保有的数量', 'id = <建筑> 要保有的建筑'],
      desc: '让 AI 把指定建筑保有到最低数量,在此之前优先建造它。',
      note: '按「总量」计算:含本土、占领区、贸易及附庸上缴的。',
      example: `ai_strategy = {
    type = building_target
    id = industrial_complex
    value = 85
}`,
    },
    {
      name: 'convoy_efficiency_to_cancel_trades',
      cat: 'production',
      params: ['value = <int> 策略权重'],
      desc: '修改 AI 因护航效率过低而取消贸易的判定阈值。',
    },
    {
      name: 'dockyard_to_military_factory_ratio',
      cat: 'production',
      params: ['value = <int> 策略权重(正 = 更多船坞)'],
      desc: '修改 AI 想要维持的船坞/军工厂比例。',
      example: `ai_strategy = {
    type = dockyard_to_military_factory_ratio
    value = 50
}`,
    },
    {
      name: 'equipment_market_buy',
      cat: 'production',
      params: ['equipment_type = <装备类型/原型>(可选)', 'seller = <国家>(可选,可用作用域变量)', 'value = <int> 购买评分'],
      desc: '影响 AI 对市场上可购装备的评分;须至少指定 equipment_type 或 seller 之一。',
      example: `ai_strategy = {
    type = equipment_market_buy
    equipment_type = light_tank_chassis
    seller = GER
    value = 200
}`,
    },
    {
      name: 'equipment_market_buying_threshold',
      cat: 'production',
      params: ['value = <int> 装备数量绝对值', 'id = <装备原型>'],
      desc: '影响 AI 对市场购买的需求感知:50 表示比实际需求多买 50,-20 表示缺口超过 20 才买。',
      example: `ai_strategy = {
    type = equipment_market_buying_threshold
    id = small_plane_cas_airframe
    value = 100
}`,
    },
    {
      name: 'equipment_market_for_sale_factor',
      cat: 'production',
      params: ['value = <int> 百分比系数(50 = 系数 1.5)', 'id = <装备类型>'],
      desc: '修改 AI 挂上市场出售的装备盈余比例。',
      example: `ai_strategy = {
    type = equipment_market_for_sale_factor
    id = train
    value = 50
}`,
    },
    {
      name: 'equipment_market_for_sale_threshold',
      cat: 'production',
      params: ['value = <int> 装备数量绝对值', 'id = <装备类型>'],
      desc: 'AI 的该装备盈余达到此数量后,才会当作可售盈余挂到市场。',
      example: `ai_strategy = {
    type = equipment_market_for_sale_threshold
    id = train
    value = 200
}`,
    },
    {
      name: 'equipment_market_max_for_sale',
      cat: 'production',
      params: ['value = <int> 最大在售数量', 'id = <装备类型>'],
      desc: '限制该装备挂到市场上的最大数量(value 0 被忽略,要用其他策略阻止出售)。',
      example: `ai_strategy = {
    type = equipment_market_max_for_sale
    id = train
    value = 30
}`,
    },
    {
      name: 'equipment_market_min_for_sale',
      cat: 'production',
      params: ['value = <int> 最低在售数量', 'id = <装备类型>'],
      desc: '作为在售数量的下限,且按此数量的倍数挂售;覆盖 Defines 默认块大小。',
      example: `ai_strategy = {
    type = equipment_market_min_for_sale
    id = train
    value = 20
}`,
    },
    {
      name: 'equipment_market_spend_factories',
      cat: 'production',
      params: ['value = <int> 系数(20 = 系数 1.2)'],
      desc: '修改 AI 想花在购买装备上的最大民用工厂数。',
      example: `ai_strategy = {
    type = equipment_market_spend_factories
    value = 20
}`,
    },
    {
      name: 'equipment_market_trade_desire',
      cat: 'production',
      params: ['value = <int> 增减量', 'id = <country> 期望的贸易伙伴'],
      desc: '提高(负值则降低)与某国交易的意愿,影响购买请求接受度与市场准入意愿。',
      example: `ai_strategy = {
    type = equipment_market_trade_desire
    id = ENG
    value = 30
}`,
    },
    {
      name: 'equipment_production_factor',
      cat: 'production',
      params: ['value = <int> 百分比(50 = 感知需求工厂 +50%)', 'id = <装备类别>'],
      desc: '促使 AI 多生产指定类别的装备(类别见 script_enum_equipment_category)。',
      example: `ai_strategy = {
    type = equipment_production_factor
    id = armor
    value = 30
}`,
    },
    {
      name: 'equipment_production_min_factories',
      cat: 'production',
      params: ['value = <int> 军工厂数(value 1 = 1 厂)', 'id = <装备类型>'],
      desc: '强制 AI 在该装备类型的生产线上至少保持这么多工厂(不考虑工厂是否够用);多条策略叠加。',
      note: '同一 type 的多个变体(如各型火炮/火箭炮)都会被覆盖。',
      example: `ai_strategy = {
    type = equipment_production_min_factories
    id = artillery
    value = 3
}`,
    },
    {
      name: 'equipment_production_min_factories_archetype',
      cat: 'production',
      params: ['value = <int> 军工厂数', 'id = <装备原型>'],
      desc: '与 equipment_production_min_factories 类似,但按装备原型(is_archetype)而非类型,选择更精细;多条叠加。',
      example: `ai_strategy = {
    type = equipment_production_min_factories_archetype
    id = artillery_equipment
    value = 4
}`,
    },
    {
      name: 'equipment_production_surplus_management',
      cat: 'production',
      params: ['value = <int> 与其他类型比较的权重', 'id = <装备类型>(不必是原型)'],
      desc: '控制 AI 在所有正常需求都满足后还生产什么:按权重比例分配富余工厂。',
      note: '过高值会干扰正常需求计算,慎用。',
      example: `ai_strategy = {
    type = equipment_production_surplus_management
    id = infantry_equipment
    value = 10
}`,
    },
    {
      name: 'equipment_stockpile_surplus_ratio',
      cat: 'production',
      params: ['value = <int> 策略权重'],
      desc: '修改 AI 宁愿囤库也不立即使用的装备比例。',
      example: `ai_strategy = {
    type = equipment_stockpile_surplus_ratio
    value = 30
}`,
    },
    {
      name: 'equipment_variant_production_factor',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <装备原型>'],
      desc: '促使 AI 多生产指定装备原型。',
      example: `ai_strategy = {
    type = equipment_variant_production_factor
    id = light_tank_chassis
    value = -100
}`,
    },
    {
      name: 'factory_build_score_factor',
      cat: 'production',
      params: ['value = <int> 策略权重', 'target = <省> 建造地点'],
      desc: '促使 AI 在指定省份内建造建筑。',
      example: `ai_strategy = {
    type = factory_build_score_factor
    target = 365
    value = 1
}`,
    },
    {
      name: 'force_build_armies',
      cat: 'production',
      params: ['value = <int> 策略权重'],
      desc: '强制 AI 超过期望数量继续建造师。',
      example: `ai_strategy = {
    type = force_build_armies
    value = 30
}`,
    },
    {
      name: 'fuel_buffer',
      cat: 'production',
      params: ['value = <int> 系数'],
      desc: '修改 AI「期望最大燃油储备」缓冲天数(与 stockpile_fuel 配套使用)。',
    },
    {
      name: 'land_xp_spend_priority',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <用途> 要修改的花费用途'],
      desc: '修改 AI 花费陆军经验的优先级。',
      note: '本体常用 id 有 division_template、upgrade_xp_cutoff;另有 unlock_doctrine / equipment_variant / army_spirit。',
      example: `ai_strategy = {
    type = land_xp_spend_priority
    id = division_template
    value = 100
}`,
    },
    {
      name: 'min_convoy_efficiency_factor_for_war_support_hit',
      cat: 'production',
      params: ['value = <int> 策略权重'],
      desc: '修改 AI 战争支持度受打击所需的最低护航效率系数。',
    },
    {
      name: 'min_wanted_supply_trains',
      cat: 'production',
      params: ['value = <int> 数量'],
      desc: '覆盖 AI 期望的补给列车最低保有量。',
      example: `ai_strategy = {
    type = min_wanted_supply_trains
    value = 300
}`,
    },
    {
      name: 'min_wanted_supply_trucks',
      cat: 'production',
      params: ['value = <int> 数量'],
      desc: '覆盖 AI 期望的补给卡车最低保有量。',
      example: `ai_strategy = {
    type = min_wanted_supply_trucks
    value = 30
}`,
    },
    {
      name: 'navy_xp_spend_priority',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <用途> 要修改的花费用途'],
      desc: '修改 AI 花费海军经验的意愿。',
      note: 'id 可用 unlock_doctrine / equipment_variant / upgrade_xp_cutoff / navy_spirit 等(须与海军类别对应)。',
    },
    {
      name: 'pp_spend_amount',
      cat: 'production',
      params: ['value = <int> 保留的政治力量', 'id = <用途>'],
      desc: '修改 AI 应为指定用途保留的政治力量。',
      note: '本体常用 idea、decision。',
      example: `ai_strategy = {
    type = pp_spend_amount
    id = idea
    value = 100
}`,
    },
    {
      name: 'pp_spend_priority',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <用途>'],
      desc: '修改 AI 优先把政治力量花在何处。',
      note: '本体可用 admiral / guarantee / relation / decision。',
      example: `ai_strategy = {
    type = pp_spend_priority
    id = relation
    value = 100
}`,
    },
    {
      name: 'production_upgrade_desire_offset',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <装备类型>'],
      desc: '促使 AI 把生产线升级到指定装备类型。',
      example: `ai_strategy = {
    type = production_upgrade_desire_offset
    id = artillery_equipment_2
    value = -50
}`,
    },
    {
      name: 'railway_gun_divisions_ratio',
      cat: 'production',
      params: ['value = <int> 叠加值'],
      desc: '修改 AI 想要维持的铁道炮/师比例(叠加在 Defines 基线之上,0-100 量纲)。',
      note: '基线为 RAILWAY_GUN_PRODUCTION_BASE_DIVISIONS_RATIO_PERCENT,默认 0。',
      example: `ai_strategy = {
    type = railway_gun_divisions_ratio
    value = 5
}`,
    },
    {
      name: 'recruit_scientist',
      cat: 'production',
      params: ['id = <专业> 要招募的科学家专业:specialization_land / specialization_nuclear / specialization_naval / specialization_air', 'value = <int> 策略权重'],
      desc: '促使 AI 招募指定专业方向的科学家(通常在已有对应科研设施专长、且尚无该专业科学家时启用)。',
      note: '非原版类型,由已装载模组定义。',
    },
    {
      name: 'research_tech',
      cat: 'production',
      params: ['value = <int> 只要为正即可', 'id = <科技> 要研究的科技'],
      desc: '强制 AI 尽快研究指定科技(若条件允许)。',
      example: `ai_strategy = {
    type = research_tech
    id = radio_detection
    value = 100
}`,
    },
    {
      name: 'research_weight_factor',
      cat: 'production',
      params: ['value = <int> 百分比(50 = +50%,-30 = -30%)', 'id = <科技>'],
      desc: '修改某科技的 AI 权重(评分)。',
      example: `ai_strategy = {
    type = research_weight_factor
    id = radio_detection
    value = 2000
}`,
    },
    {
      name: 'role_ratio',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <角色>'],
      desc: '修改 AI 为指定角色制作的模板数量。',
      note: '角色定义在 AI 模板(陆军师)与 AI 装备(舰船/坦克变体)里。',
      example: `ai_strategy = {
    type = role_ratio
    id = paratroopers
    value = 30
}`,
    },
    {
      name: 'save_equipment',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <装备类型>'],
      desc: '促使 AI 节约/保留指定装备,不轻易消耗。',
    },
    {
      name: 'stockpile_fuel',
      cat: 'production',
      params: [
        'start_below = <百分比> 燃油低于「期望最大燃油」的该比例时进入节油模式',
        'stop_above = <百分比> 恢复到该比例以上才解除(必须高于 start_below)',
      ],
      desc: '让 AI 在燃油储备回补前暂停耗油行动:空军/海军任务节流、陆军进攻计划暂停。多块同时生效时取最严的阈值。',
      note: '被 front_control 的 execute_order = yes 及 AI 眼中的绝望战线覆盖;阈值是「期望最大燃油」的百分比,而非总容量。',
      example: `ai_strategy = {
    type = stockpile_fuel
    start_below = 30
    stop_above = 80
}`,
    },
    {
      name: 'template_prio',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <角色/模板>'],
      desc: '修改 AI 升级师模板时的优先级倾向。',
    },
    {
      name: 'unit_ratio',
      cat: 'production',
      params: ['value = <int> 策略权重', 'id = <单位>'],
      desc: '修改 AI 用指定单位制作的模板数量(陆/海/空皆可)。',
      note: '空军机型按权重分配数量;其余单位以 100 为基准加减(value -40 = 只做 60%)。',
      example: `ai_strategy = {
    type = unit_ratio
    id = cas
    value = 30
}`,
    },
    {
      name: 'wanted_supply_trains',
      cat: 'production',
      params: ['value = <int> 数量'],
      desc: '修改 AI 期望的补给列车保有量。',
    },
    {
      name: 'wanted_supply_trucks',
      cat: 'production',
      params: ['value = <int> 数量'],
      desc: '修改 AI 期望的补给卡车保有量。',
    },
    /* ── 空军 air ── */
    {
      name: 'strategic_air_importance',
      cat: 'air',
      params: ['id = <战略地区> 要考虑的战略地区', 'value = <int> 加/减的分数'],
      desc: '修改指定地区「战略重要性」总分,AI 据此决定在哪里执行空军任务。AI 分数通常上万,数值太小看不出效果。',
      example: `ai_strategy = {
    type = strategic_air_importance
    id = 18 #English Channel
    value = -30000
}`,
    },
    /* ── 突袭 raid ── */
    {
      name: 'raid_target_country',
      cat: 'raid',
      params: ['id = <country> 目标国家', 'value = <int> 概率影响(200 = +200%,-50 = -50%)'],
      desc: '让 AI 更(或更不)倾向于以突袭针对某国。',
      example: `ai_strategy = {
    type = raid_target_country
    id = GER
    value = 200
}`,
    },
  ],
  fieldDocs: {
    /* 通用字段(所有 ai_* 方面通用;方面有特指时在方面键里覆盖) */
    '': {
      allowed: '触发块:只在游戏开局前检查一次,永久允许/禁止该条目。通常只做国家(tag = OMA)或 DLC 检查。',
      enable: '触发块:必须满足才启用该条目;默认不满足并不会取消已启用的条目(除非另有 abort_when_not_enabled)。',
      abort: '触发块:满足即移除该条目;它不满足也阻止条目被添加。',
      abort_when_not_enabled: '标量 yes/no:设为 yes 后,enable 一旦不满足条目就会被撤销。',
      reversed: '标量 yes:反转策略 —— 原本"我(id 国)对满足 enable 的国家"翻转为"满足 enable 的国家对我(id 国)"。',
      enable_reverse: '触发块(无默认作用域,须自己切入作用域):反转策略的额外启用条件。',
      ai_strategy: 'AI 策略本体:type = <类型> 决定行为,其余参数取决于该类型。可写多条,同时生效。',
      ai_will_do: 'MTTH 权重块:在 0 与该值之间生成随机数,取最高者选中。可被计划/Defines 里的修饰再乘。',
      ai_chance: '事件选项概率块:按各选项权重比例抽样,最终概率必须是 1/100 的倍数。',
      modifier: 'MTTH 修饰块:条件触发;内含 add / base / factor 与触发器混排,默认作用域为当前国家。',
      factor: 'MTTH 修饰:把当前值乘以该数(如 factor = 0 直接清零)。',
      base: 'MTTH 修饰:把当前值设为该数(等价于乘 0 再加,通常放在最前)。',
      add: 'MTTH 修饰:给当前值加上该数。',
      type: 'ai_strategy 的策略类型 token,决定行为;其余参数随类型而定。',
      id: '策略目标:国家 tag / 省州 ID / 建筑 / 角色 / 任务等,含义随 type 变化。',
      value: '策略权重/分数:可为加项、百分比或绝对值,含义随 type 变化;负值降低意愿。',
      priority: '优先级:矛盾策略同时存在时,数值最高者生效。',
      target: '随 type 变化:外交行动名 / 建造地点 / 装备类型等。',
      ratio: '比例(小数):前线覆盖比例或预备队/缓冲比例。',
      tag: '目标国家 tag,可写多个。',
      state: '目标省 ID,可写多个。',
      area: 'AI 区域名(如 europe),定义在 common/ai_areas/*.txt。',
      name: '名称:随方面变化(计划名/设计名),一般不展示给玩家。',
      desc: '描述:随方面变化,一般不展示给玩家。',
    },
    /* 各方面特指字段 */
    ai_strategy: {},
    ai_strategy_plans: {
      name: '计划名(不展示给玩家,aiview 控制台用)。',
      desc: '计划描述(不展示给玩家,aiview 控制台用)。',
      allowed: '触发块(国家作用域):只在开局前检查一次,永久限定该计划适用的国家与 DLC。',
      enable: '触发块:允许即把计划分配给 AI;之后即使条件变假也不会自动撤销(与通用 enable 语义不同)。常用 has_game_rule / is_historical_focus_on。',
      abort: '触发块:满足则 AI 停用该计划;它不满足也是计划能被选中的前提。',
      ai_national_focuses: '国策顺序列表(空白分隔):AI 依序尝试,完成后才回到 ai_will_do 权重选择。',
      focus_factors: '国策权重乘数:TAG_focus_name = 3 表示该国策 ai_will_do 值乘 3;factor 0 表示绝不选(除非在 ai_national_focuses 里点名)。',
      research: '科技权重乘数:artillery = 3 表示该类别下所有科技的 ai_will_do 乘 3。',
      ideas: '理念/顾问权重乘数(用 idea_token 写条目)。',
      traits: '国家领袖特质权重乘数。',
      ai_strategy: '计划开启期间同时生效的 AI 策略(可写多条)。',
      weight: 'MTTH 权重块:计划总权重,乘到计划内每个 factor 上。1.25 会把 4 倍国策因子变成 5 倍。',
    },
    ai_templates: {
      role: '角色 token(脚本定义),被 role_ratio 策略引用,决定 AI 想要多少该角色的师。',
      blocked_for: '排除列表:这些国家不用该角色级模板条目(与 available_for 二选一)。',
      available_for: '白名单:只有这些国家用该条目(不写则所有国家可用)。',
      upgrade_prio: 'MTTH 权重块:角色级 —— 加权随机决定 AI 先升级哪个角色;目标级 —— 确定性决定哪个是"当前目标模板"。',
      enable: '触发块(国家作用域):为假则当作该模板不存在。',
      reinforce_prio: '结果模板的补员优先级:驻军用 0(低),精锐用 2(高),默认 1。',
      custom_icon: '是否使用自定义图标。',
      division_names_group: '师名组;默认沿用被"分叉"模板的名组。',
      can_upgrade_in_field: '触发块(国家作用域):是否允许在战场上就地升级该目标模板。',
      target_template: '目标模板本体:support 支援连 + regiments 线列团。',
      support: '期望的支援连:AI 在科技允许时尽量加上。',
      regiments: '期望的线列团:AI 在科技允许时尽量加上。',
      replace_at_match: '匹配度阈值:当前目标模板的匹配分达到它时,改用 replace_with。',
      replace_with: '替换目标:达到 replace_at_match 后切换到的目标模板。',
      target_min_match: '替换前提:最佳匹配模板与 replace_with 的匹配分至少达到它,切换才发生。',
    },
    ai_equipment: {
      category: '类别:land(坦克) / naval(舰船) / air(飞机)。',
      roles: '角色列表(可自定义),供 role_ratio 策略使用;AI 为每个角色保留一个变体。',
      available_for: '使用该角色模板的国家白名单;不写则所有国家可用。',
      blocked_for: '禁用的国家列表(仅在无 available_for 时需要)。',
      priority: 'MTTH 权重块:角色模板/单个设计的"重要性",决定经验花费的优先方向。',
      name: '设计名:启用后该装备可作为预设方案;不写则按本地化短名匹配。',
      role_icon_index: '给舰船分配的角色图标序号(陆地装备无效)。',
      enable: '触发块:决定 AI 何时以该设计为目标。',
      allowed_types: '可加入设计的子单位列表;漏掉某种,AI 就永远不会加它。',
      target_variant: 'AI 瞄准的变体:match_value 匹配价值 + type 装备类型 + modules 模块 + upgrades 升级 + requirements 硬性要求。',
      match_value: '该模板匹配时对 AI 的价值。',
      type: '目标变体必须使用的具体装备类型。',
      modules: '各模块槽位要求:模块类别/具体模块/empty,可用 > < 要求更新或更旧的模块;槽内可用 any_of 表示至少其一。',
      upgrades: '升级列表:固定数字或 MTTH 块,指定各升级的 AI 优先级。',
      requirements: '硬性要求:AI 必须已有的模块(不限定槽位,格式同 modules 槽位要求)。',
      allowed_modules: '目标变体满足后可用的模块列表,先后顺序即优先顺序;不在列表里的模块永不被选。',
    },
    ai_areas: {
      continents: '构成该区域的大洲列表(用 continent.txt 里的全名,不是省份定义里的 ID)。',
      strategic_regions: '构成该区域的战略地区 ID 列表。多个同时定义时,省份属于其中任意一个即可。',
    },
    ai_focuses: {
      research: '随当前国策调整的科技类别倾向:告诉 AI 在追逐当前国策时优先选哪些科技类别与国策。',
    },
    ai_peace: {
      peace_action_type: '该和会 AI 条目适用的和谈选项:puppet / liberate / force_government / take_states(1.12 起)。',
      ai_desire: '和谈选项优先级:-1000 永不选,1000 最高优先。',
      annex: '吞并:国家 FROM 被 ROOT 完全吞并(只评估国家;旧版 1.12 前)。',
      liberate: '解放:国家 FROM 被 ROOT 解放。',
      puppet: '傀儡:国家 FROM 被 ROOT 傀儡化。',
      puppet_all: '傀儡且保留全部州(旧版)。',
      puppet_state: '州 ROOT 移交给 FROM.FROM(和会中成为 FROM 附庸;旧版)。',
      take_states: '割地:州 FROM.FROM.FROM 由 FROM 接管(旧版为州 FROM 被 ROOT 吞并)。',
      force_government: '强制改变 FROM 的意识形态。',
      take_navy: '接管海军(无 AI 修改支持,1.12 起)。',
    },
    ai_navy: {
      objective_type: '海军目标类型:naval_invasion_support / naval_invasion_defense / mines_sweeping / coast_defense / convoy_protection / convoy_raiding。',
      available_for: '白名单:写了之后该目标默认对所有国家禁用,只对白名单内国家可用。',
      blocked_for: '黑名单:禁用该目标的国家。',
      min_priority: '该目标优先级区间下限(决定目标评分范围,见目标评分机制)。',
      max_priority: '该目标优先级区间上限。',
    },
  },
  mtthDocs:
    'MTTH 块(common/mtth/ 里的机制,散布于国策/科技/事件等各处):给某块赋一个动态值。' +
    '最常见的用途是给国策或科技一个 AI 权重(ai_will_do):游戏生成 0 到该值之间的随机数,取最高者选中;' +
    '计划、Defines 里的修饰会再乘到这个值上。' +
    '事件选项用 ai_chance,按选项权重比例抽样,最终概率必须是 1/100 的倍数。' +
    '\nMTTH 块从 1 开始,有三种取值修饰:add 加数、factor 乘数、base 设值(等价于乘 0 再加,通常放最前)。' +
    '条件修饰用 modifier = { ... },它同时是触发块,默认作用域(即 ROOT)是评估该块的当前国家;' +
    '不同 MTTH 块可能另加 FROM / FROM.FROM 作用域。add/base/factor 可以混在 modifier 里的任意位置。' +
    'modifier 内定义的临时变量,取值修饰必须写在变量定义之后才能引用;变量也能直接在 MTTH 块里用。',
}