/* ══════════════════════════════════════════════════════════════════
 * HOI4 / Clausewitz 术语对照表 —— 全批译文的唯一依据
 *
 * ★ 为什么单独成文件:2074 条译文分散在4 个批次文件里,
 *   "隐藏科技" 有人译 hidden technology、有人译 hidden tech,
 *   用户在英文界面里看到两个词就是质量事故。
 *   新增译文前先查这张表,不要现场造词。
 *
 * ── 铁律 ──
 *   1. 引擎/脚本侧的词(api 名、文件路径、字段名)**不译**:
 *      show_equipment_icon / has_dlc / inlay_window.position 保持原样。
 *      用户要照着改游戏文件,译了反而没法用。
 *   2. 游戏内已有官方英文译名的,用官方译名(见★ 行)。
 *   3. 括号里补英文时,英文用半角括号。
 * ══════════════════════════════════════════════════════════════════ */

export const TERMS = {
  /* ══ 内容类 ══ */
  国策: 'focus',                       // 官方: National Focus
  国策树: 'National Focus tree',
  焦点: 'focus',                       // ★ parser 层的 focus = 国策
  科技: 'technology',
  科技树: 'technology tree',
  学说: 'doctrine',
  学说系统: 'doctrine system',
  决议: 'decision',
  决议树: 'decision tree',
  事件: 'event',
  理念: 'idea',
  装备: 'equipment',
  装甲师: 'armor division',            // ★ 游戏内官方叫 Armor,不译 Armored
  摩步师: 'motorized division',
  机械化师: 'mechanized division',
  步兵师: 'infantry division',
  自走军属: 'self-propelled gun battalion',
  隐藏科技: 'hidden technology',
  可见科技: 'visible technology',
  支线: 'branch',                      // doctrine 的分支轨道
  轨道: 'track',                       // doctrine 的轨道

  /* ══ 来源与覆盖 ══ */
  模组: 'mod',
  基础游戏: 'base game',
  原版: 'vanilla',
  来源: 'source',
  覆盖链: 'override chain',
  覆盖: 'override',
  改写: 'overridden',                  // origin=vanilla 但生效的是模组
  挂载: 'mount',
  落盘: 'write to disk',
  生效: 'in effect',
  失效: 'void',                        // 被同名覆盖而不生效
  独占: 'exclusive',
  替换路径: 'replace_path',

  /* ══ 工程 ══ */
  体检: 'audit',                       // 官方术语是 validator,UI 上用 Audit 更短
  校验: 'validate',
  语法: 'syntax',
  悬空引用: 'dangling reference',
  重复定义: 'duplicate definition',
  缺失本地化: 'missing localisation',
  本地化: 'localisation',
  无损: 'lossless',
  回写: 'write-back',
  写回: 'write back',
  大纲: 'outline',
  跳转: 'jump to definition',
  元素树: 'element tree',
  画布: 'canvas',
  侧栏: 'sidebar',
  顶栏: 'top bar',
  待保存改动: 'unsaved changes',
  快捷键: 'shortcut',
  右键菜单: 'context menu',
  悬停: 'hover',
  折叠: 'collapse',
  展开: 'expand',
  筛选: 'filter',
  筛选器: 'filters',
  适应: 'fit',
  缩放: 'zoom',
  放大: 'zoom in',
  缩小: 'zoom out',

  /* ══ 地图 ══ */
  省份: 'province',
  归属: 'owner',
  人力: 'manpower',
  胜利点: 'victory points',
  本地补给: 'local supplies',
  核心国: 'cores',
  底图: 'base map',
  归属着色: 'ownership colours',
  省份点: 'province dots',
  诊断: 'diagnostics',

  /* ══ GUI ══ */
  容器: 'container',
  按钮: 'button',
  图标: 'icon',
  文本框: 'textbox',
  编辑框: 'editbox',
  复选框: 'checkbox',
  列表框: 'listbox',
  滚动条: 'scrollbar',
  下拉框: 'dropdown',
  网格: 'grid',
  定位点: 'position',
  贴图: 'sprite',
  窗口名: 'window name',
  父窗口: 'parent window',
  内嵌窗: 'inlay window',
  屏幕根: 'screen root',
  根容器: 'root container',
  锚点: 'anchor',
  尺寸: 'size',
  位置: 'position',
  可见: 'visible',
  透明度: 'opacity',
  层级: 'layer',

  /* ══ 来源类型(V1 的四态) ══ */
  'vanilla / override / new / gap': 'vanilla / override / new / gap',
}

/** 这些词**永不翻译**,出现即原文照抄(含大小写与下划线)。 */
export const KEEP_AS_IS = [
  // 文件路径与目录
  'common/', 'events/', 'history/states', 'interface/', 'gfx/', 'localisation/',
  // 脚本 api
  'has_dlc', 'has_game_rule', 'has_country_flag', 'has_completed_focus',
  'show_equipment_icon', 'add_ideas', 'set_state_owner', 'inlay_window.position',
  'descriptor.mod', '.mod', 'defines.lua', 'replace_path', 'dependencies',
  // 技术标识
  'sprite', 'container', 'button', 'icon', 'inlay_window', 'scripted_gui',
  'gui_type', 'position', 'size', 'text', 'name',
]
