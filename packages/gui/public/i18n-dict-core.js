/* ══════════════════════════════════════════════════════════════════
 * i18n 字典 · 批次 1/4:核心 UI(导航 / 主页 / 通用 / 外观 / 主题)
 *
 * 以「精确中文原文」为键。键必须与源码里的字符串**逐字符相同**
 * (含标点、空格、全角/半角),否则运行时查不到 —— 审计测试会兜住。
 *
 * 术语约定(全批统一,别各翻各的):
 *   国策= focus / 国策树 = National Focus
 *   科技= technology / 决议 = decision / 学说 = doctrine
 *   装甲师 = tank division(不译 Armored Div,游戏内官方叫 Armor)
 *   模组 = mod · 来源 = source · 覆盖链 = override chain
 *   挂载 = mount · 落盘 = write to disk · 体检 = validator/audit
 * ══════════════════════════════════════════════════════════════════ */
;(function () {
  const D = {
    /* ── 导航项(与 nav.js 的 NAV_GROUPS 对应)── */
    '国策树': 'National Focus',
    '科技树': 'Technology Tree',
    '决议树': 'Decision Tree',
    '学说系统': 'Doctrine System',
    '事件': 'Events',
    'AI 行为': 'AI Behaviour',
    'DLC 内容': 'DLC Content',
    '世界地图': 'World Map',
    '模组关系': 'Mod Relations',
    '所见即所得': 'Visual Editor',
    '内容生成': 'Content Editor',
    '代码 IDE': 'Code IDE',
    '官方手册': 'Official Manual',
    'common 文档': 'common Reference',
    '本地化': 'Localisation',
    '体检': 'Validator',
    '打开工程': 'Open Project',
    '使用教程': 'Guide',
    '设置': 'Settings',

    /* 导航副标题 */
    '来源 · 坐标 · 体检': 'Source · Position · Audit',
    '两级分类 · 隐藏科技': 'Two tiers · Hidden tech',
    '页签 · 轨道 · 分支': 'Tabs · Tracks · Branches',
    'defines.lua · 官方注释': 'defines.lua · Vanilla notes',
    '类别卡片墙': 'Category cards',
    '触发条件 · 效果': 'Triggers · Effects',
    'common/ai_* · 逐文件归纳': 'common/ai_* · Per-file',
    '军工机构 · 工程 · 阵营': 'Agencies · Projects · Factions',
    '多来源合成 · 省份归属': 'Multi-source · Province owners',
    '依赖图 · replace_path': 'Dependency graph · replace_path',
    '元素树 · 属性 · 回写': 'Element tree · Props · Write-back',
    '表单产出规范文件': 'Form → spec-compliant file',
    '高亮 · 大纲 · 跳转': 'Highlight · Outline · Jump',
    '缺失 · 覆盖链': 'Missing · Override chain',
    '语法 · 悬空引用': 'Syntax · Dangling refs',
    '挂游戏目录 / 模组': 'Mount game / mods',
    '上手 · 概念 · 常见问题': 'Basics · Concepts · FAQ',
    '主题 · 来源 · 背景': 'Theme · Sources · Background',
    '按文件夹索引': 'Indexed by folder',

    /* 导航分组 */
    '内容': 'Content',
    '界面': 'Interface',
    '文档': 'Reference',
    '工具': 'Tools',

    /* 导航自身的元信息(键鼠提示用) */
    '导航': 'Navigation',
    '简洁明了': 'Compact and clear',
    '当前页在哪个组': 'Which group the current page is in',
    '只有总导航栏': 'Top nav bar only',
    '折叠/展开导航': 'Collapse / expand navigation',
    '折叠或展开导航': 'Collapse or expand the navigation',
    '中文': 'Chinese',

    /* ── 主页 ── */
    'HOI4 工作台': 'HOI4 Workbench',
    '当前模组': 'Current mod',
    '切换': 'Switch',
    '＋ 新建模组': '＋ New mod',
    '模组开关': 'Mod toggles',
    '默认只展示基础游戏 · 勾选的模组才会进入索引与编辑范围':
      'Only the base game is shown by default · ticked mods enter the index and editing scope',
    '读取中…': 'Loading…',
    '制作主线': 'Main workflow',
    '做完这四步就有一个能加载的模组': 'Four steps to a loadable mod',
    '建 / 挂模组': 'Create / mount mod',
    '新建一个或挂载已有的': 'Create a new one or mount an existing',
    '产出内容': 'Produce content',
    '脚手架生成规范文件': 'Scaffold generates spec-compliant files',
    '落盘 / 手改': 'Write / hand-edit',
    '写入目标模组目录': 'Write into the target mod directory',
    '校验': 'Validate',
    '体检 + 看可视化结果': 'Audit + inspect the visual result',
    '内容可视化': 'Content visualisation',
    '读 common/ · 只读': 'Reads common/ · read-only',
    '上手教程 →': 'Getting started →',
    '界面开发': 'Interface development',
    '可写回源文件': 'Writes back to source files',
    '文档与工程': 'Docs & engineering',
    '悬停任意卡片或本页底部可看详细说明':
      'Hover any card or the page footer for details',

    '没有模组就在这里「新建模组」:自动建 descriptor.mod + .mod + 12 个常用目录,并挂成可写来源。&#10;已有模组则「添加模组目录」挂进来。':
      'No mods yet? Use “New mod” here: it creates descriptor.mod + .mod + 12 common folders and mounts it as a writable source.&#10;Already have one? Mount it with “Add mod directory”.',
    '表单化产出国策 / 事件 / 决议 / 科技 / 理念 / 装备,带本地化文件,生成时做可解析性自检。':
      'Form-driven generation of focuses / events / decisions / technologies / ideas / equipment, with localisation files and a parseability self-check on generation.',
    '保存到模组': 'Save to mod',
    '「保存到模组」把上一步的产物直接写进目标模组(已存在的文件自动备份 .bak)。&#10;要手工改某个文件,在 IDE 里 Ctrl+E 编辑、Ctrl+S 保存。':
      '“Save to mod” writes the output straight into the target mod (existing files are backed up as .bak).&#10;To hand-edit a file, press Ctrl+E in the IDE and Ctrl+S to save.',
    '对挂载的来源跑校验:语法、括号、悬空引用、重复定义、缺失本地化。&#10;落盘后跑一遍,确认没引入新问题。':
      'Validate mounted sources: syntax, braces, dangling references, duplicate definitions, missing localisation.&#10;Run it after writing to disk to confirm nothing new broke.',
    '所有工具共享同一套 Clausewitz 解析器与 GUI 布局引擎，坐标 / 锚点计算在各界面工具间保持一致。&#10;官方手册与 common 文档实时读取，不做预生成快照 —— 改了文件刷新即可看到。':
      'All tools share one Clausewitz parser and one GUI layout engine, so coordinates and anchors stay consistent across every interface tool.&#10;The official manual and common docs are read live, with no pre-generated snapshot — edit a file and refresh to see it.',

    /* ── index.html (GUI 工作台)── */
    'HOI4 GUI 工作台': 'HOI4 GUI Workbench',
    '预览 · 拖拽 · 无损回写': 'Preview · Drag · Lossless write-back',
    '过滤文件…': 'Filter files…',
    '名称': 'Name',
    '元素树': 'Element tree',
    '在画布或元素树中选择一个元素': 'Select an element in the canvas or the element tree',
    '待保存改动': 'Unsaved changes',
    '查看 diff': 'View diff',

    /* ── 外观 / 主题 ── */
    '换图标': 'Change icon',
    '浅色': 'Light',
    '默认 · 白底': 'Default · white base',
    '深色': 'Dark',
    '夜间 · 深灰': 'Night · dark grey',
    '午夜蓝': 'Midnight blue',
    '冷调深色': 'Cool dark',
    '暖砂': 'Warm sand',
    '浅色 · 米底': 'Light · cream base',
    '默认蓝': 'Default blue',
    '军绿': 'Military green',
    '铜金': 'Bronze gold',
    '赭石': 'Ochre',
    '紫': 'Purple',
    '赤': 'Crimson',
    '青': 'Teal',
    'HOI4 徽标': 'HOI4 crest',
    '齿轮': 'Gear',
    '铁十字': 'Iron cross',
    '盾牌': 'Shield',
    '将星': 'General star',
    '地球': 'Globe',
    '军旗': 'Army flag',
    '地图': 'Map',
    '钢盔': 'Steel helmet',
    '跟随主题默认': 'Follow theme default',
    '后来刻意选回齿轮': 'Deliberately switched back to the gear later',

    /* ── app.js 通用 / 跨域联动 ── */
    '贴图': 'Sprite',
    '应用失败:': 'Apply failed:',
    ' 行': ' lines',
    '无匹配文件': 'No matching file',
    '窗口名': 'Window name',
    '父窗口': 'Parent window',
    '父 scripted_gui': 'Parent scripted_gui',
    '属性覆盖': 'Property override',
    '坐标覆盖': 'Position override',
    '点击效果': 'Click effect',
    '触发器': 'Trigger',
    'AI 权重': 'AI weight',
    '动态列表': 'Dynamic list',
    '列表项容器': 'List item container',
    '国策内嵌窗': 'Focus inlay window',
    '决策分类': 'Decision category',
    '跨域联动': 'Cross-domain link',
    '匿名元素无法被脚本引用': 'Anonymous elements cannot be referenced by scripts',
    '正在查询引用图…': 'Querying the reference graph…',
    '引用图不可用:': 'Reference graph unavailable:',
    '⚠ 拖拽不会生效': '⚠ Dragging will not apply',
    '相关变量:': 'Related variables:',
    '⚠ 悬空元素': '⚠ Dangling element',
    '引用图里找不到它的定义(可能定义在别的目录)':
      'Its definition is not in the reference graph (it may live in another directory)',
    'scripted_gui / 国策内嵌窗里没有引用它':
      'No scripted_gui / focus inlay window references it',
    '改名为…': 'Rename to…',
    '请输入一个不同的名字': 'Please enter a different name',
    '正在计算影响面…': 'Computing the impact…',
    '守卫失败': 'Guard failed',
    '  · 未联动: ': '  · not linked: ',
    '确认应用': 'Confirm apply',
    '<div class="empty">在画布或元素树中选择一个元素</div>':
      '<div class="empty">Select an element in the canvas or the element tree</div>',
    '  ·  第 ': '  ·  #',
    '(游戏内显示为空白)': '(renders blank in game)',
    '⚠ 尺寸未知:无贴图可推断,虚线框仅为占位':
      '⚠ Size unknown: no sprite to infer from, the dashed box is a placeholder only',
    '· 尺寸由贴图推断,未写在文件里': '· Size inferred from the sprite, not written in the file',
    '· 文件里没有 position,当前按 (0,0) 渲染': '· No position in the file, rendering at (0,0)',
    '父级': 'Parent',
    '(根)': '(root)',
    '（新增 size）': '(size added)',
    '未知原因': 'Unknown reason',
    '守卫未通过,已取消写入': 'Guard did not pass, write cancelled',
    '已保存,但有警告:': 'Saved, with warnings:',

    /* ── ownchip.js 来源徽标 ── */
    '原版': 'Vanilla',
    '原版 ': 'Vanilla ',
    '模组改写 ': 'Mod override ',
    '模组新增 ': 'Mod added ',
    '基础游戏原本就有,模组没有同名内容覆盖它 —— 生效的就是原版这一份':
      'Present in the base game with no same-named mod content to override it — this vanilla copy is the one that applies',
    '基础游戏有同名内容,但被模组整份替换了 —— 原版那份已失效,生效的是模组版本':
      'The base game has same-named content but the mod replaced the whole file — the vanilla copy is void, the mod version applies',
    '基础游戏没有这个内容 —— 模组新增,与原版内容共存':
      'The base game has no such content — added by the mod, coexisting with vanilla content',
    ' ｜ 游戏内生效 ': ' ｜ in effect in game ',
    '(另有 ': '(another ',
    ' 份因被同名覆盖而失效)': ' copies voided by same-name override)',
  }
  if (typeof window !== 'undefined' && window.I18N) window.I18N.registerDict(D)
  else if (typeof globalThis !== 'undefined') globalThis.__I18N_DICT = Object.assign(globalThis.__I18N_DICT || {}, D)
})()
