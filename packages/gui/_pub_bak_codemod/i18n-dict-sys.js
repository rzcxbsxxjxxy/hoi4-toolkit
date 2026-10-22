/* ══════════════════════════════════════════════════════════════════
 * i18n 字典 · 批次 6/6:打开工程 / 设置页 / 体检 / 事件 / AI 行为
 *             / defines / 快捷键 / 右键菜单 / 杂项工具
 * ══════════════════════════════════════════════════════════════════ */
;(function () {
  const D = {
    /* ═════ open.js — 打开 / 挂载工程 ═════ */
    '浏览…': 'Browse…',
    '目录不存在': 'Directory does not exist',
    ' 个 .gui': ' .gui files',
    '这目录像不像游戏': 'Does this look like the game directory?',
    '没挂任何模组': 'No mods mounted',
    '✔ 含 ': '✔ contains ',
    '✘ 未找到 hoi4.exe': '✘ hoi4.exe not found',
    '这是游戏目录,不是模组': 'This is the game directory, not a mod',
    '无 .mod（推断为模组）': 'No .mod (inferred as a mod)',
    '模组目录路径（可留空或删除该行）': 'Mod directory path (leave blank or delete the line)',
    '移除': 'Remove',
    '（没有子目录）': '(no subdirectories)',
    '读取失败：': 'Read failed:',
    '✘ 无 hoi4.exe': '✘ no hoi4.exe',
    '点击设为游戏目录': 'Click to set as the game directory',
    '已选择：': 'Selected:',
    '正在检测游戏目录…': 'Detecting the game directory…',
    '检测到 ': 'Detected ',
    ' 个含 hoi4.exe 的目录，已填入：': ' directories containing hoi4.exe, filled in:',
    '未自动找到含 hoi4.exe 的目录，请手动粘贴或用「浏览…」选择。':
      'No directory containing hoi4.exe was found automatically — paste one manually or use “Browse…”.',
    '检测失败：': 'Detection failed:',
    '（可手动粘贴路径）': '(you can paste a path manually)',
    '正在扫描 Steam 创意工坊…': 'Scanning the Steam workshop…',
    '没找到创意工坊模组（roots: ': 'No workshop mods found (roots: ',
    '未找到创意工坊模组，可用「浏览…」手动定位。':
      'No workshop mods found — locate one manually with “Browse…”.',
    '添加': 'Add',
    '该模组已在列表中：': 'This mod is already in the list:',
    '已添加模组：': 'Mod added:',
    '创意工坊找到 ': 'Workshop found ',
    ' 个模组（appid ': ' mods (appid ',
    '，游戏版本 ': ', game version ',
    '扫描失败：': 'Scan failed:',
    '挂载已经存在的目录': 'Mount an existing directory',
    '看别人的模组': 'Browse other people’s mods',
    '请填写模组名。': 'Please fill in the mod name.',
    '请选择模组要建在哪个目录下。': 'Please choose which directory the mod should be created in.',
    '正在创建模组骨架…': 'Creating the mod skeleton…',
    '创建失败': 'Create failed',
    '✅ 已创建 <b>': '✅ Created <b>',
    ' 个目录 + descriptor.mod），': ' directories + descriptor.mod),',
    '并已挂载为可写来源。<br>下一步:去 <a href="/create.html">内容生成</a> 生成内容并保存到它，':
      ' and mounted it as a writable source.<br>Next: generate content on the <a href="/create.html">Content Editor</a> page and save it there,',
    '或到 <a href="/ide.html">文件编辑器</a> 直接写。':
      ' or write files directly in the <a href="/ide.html">file editor</a>.',
    '模组已创建并挂载:': 'Mod created and mounted:',
    '创建失败:': 'Create failed:',
    '当前已加载：': 'Currently loaded:',
    '（游戏版本 ': '(game version ',
    '（未能连接服务器，请确认工作台已启动）':
      '(could not reach the server, make sure the workbench is running)',
    '基础游戏路径为必填项 —— 请先填写或用「自动检测」/「浏览…」定位含 hoi4.exe 的目录。':
      'The base game path is required — fill it in or use “Auto-detect” / “Browse…” to locate a directory containing hoi4.exe.',
    '未填写模组目录，将以只读方式浏览基础游戏。':
      'No mod directory given — the base game will be browsed read-only.',
    '正在加载…': 'Loading…',
    '加载失败': 'Load failed',
    ' 该目录未找到 hoi4.exe，可能不是游戏安装目录。':
      ' No hoi4.exe in that directory — it may not be a game installation.',
    ' 游戏路径下未找到 interface/*.gui。': ' No interface/*.gui found under the game path.',
    '已加载 ': 'Loaded ',
    ' 个来源（游戏 ': ' sources (game ',
    '，模组 ': ', mods ',
    '，未加载模组': ', mods not loaded',
    '加载失败：': 'Load failed:',

    /* ═════ settings.html ═════ */
    '快捷键': 'Shortcuts',
    '和': 'and',
    '粘贴模组文件夹路径…': 'Paste the mod folder path…',
    '设置 · HOI4 GUI 工作台': 'Settings · HOI4 GUI Workbench',
    '游戏目录 · 模组文件夹 · 显示选项': 'Game directory · mod folders · display options',
    '基础游戏目录': 'Base game directory',
    '所有 sprite / .gfx 都以它为基准,必须指向 HoI4 安装根目录':
      'Every sprite / .gfx resolves against it, so it must point at the HoI4 installation root',
    '安装路径': 'Install path',
    '模组文件夹': 'Mod folders',
    '目录下有 .mod 文件即视为模组;关闭的模组保留配置但不参与界面索引与渲染(点「保存并应用」后生效)。创意工坊路径形如 steamapps/workshop/content/394360/&lt;ID&gt;':
      'A directory with a .mod file counts as a mod; disabled mods keep their settings but drop out of interface indexing and rendering (applies after “Save and apply”). Workshop paths look like steamapps/workshop/content/394360/&lt;ID&gt;',
    '扫描创意工坊': 'Scan workshop',
    '模组按顺序叠加,后面的覆盖前面的。左列的“已改界面”显示该模组内':
      'Mods stack in order, later ones override earlier ones. “Overrides interface” in the left column shows the number of',
    '文件数量 —— 纯数据模组(只改 common/ localisation/)会是 0,属正常。':
      ' files in that mod — a pure data mod (only touching common/ localisation/) shows 0, which is normal.',
    '手动添加': 'Add manually',
    '探测并添加': 'Probe and add',
    '外观': 'Appearance',
    '背景主题、强调色与工作台图标 · 立即预览,点「保存并应用」持久化':
      'Background theme, accent colour and workbench icon · previewed immediately, persisted via “Save and apply”',
    '背景主题': 'Background theme',
    '本地背景图': 'Local wallpaper',
    '已使用本地背景': 'Using a local wallpaper',
    '用本地图片作全站背景,此时大部分面板自动半透明':
      'Use a local image as the site-wide background; most panels turn translucent automatically',
    '壁纸效果': 'Wallpaper effect',
    '面板不透明': 'Panel opacity',
    '面板越透明,壁纸越明显但文字越难读;深色壁纸建议同时压暗一点':
      'The more transparent the panels, the more visible the wallpaper but the harder the text reads; dark wallpapers work better dimmed',
    '强调色': 'Accent colour',
    '界面密度': 'Interface density',
    '紧凑 = 控件与列表行更薄,一屏能看更多内容':
      'Compact = thinner controls and list rows, so more fits on screen',
    '工作台图标': 'Workbench icon',
    '本地图标图': 'Local icon image',
    '已使用本地图标': 'Using a local icon',
    '用本地图片作工作台图标(同时是浏览器标签页图标)':
      'Use a local image as the workbench icon (also the browser tab icon)',
    '已就绪': 'Ready',
    '示例按钮': 'Sample button',
    '图标同时用作浏览器标签页图标(favicon)。设置存在本机浏览器里,换浏览器/清缓存会回到默认。':
      'The icon doubles as the browser tab icon (favicon). Settings live in this browser, so a different browser or a cache clear resets them.',
    '显示选项': 'Display options',
    '影响界面设计器 / 各类可视化页面的默认状态':
      'Affects the default state of the interface designer and the visualisation pages',
    '默认显示贴图': 'Show sprites by default',
    '默认显示元素名称': 'Show element names by default',
    '拖拽吸附网格': 'Snap grid when dragging',
    '默认缩放': 'Default zoom',
    'IDE 自动补全范围': 'IDE autocomplete scope',
    '决定编辑器自动补全的候选来源,可单独开关 · 存于本机浏览器':
      'Decides which sources the editor completes from, each toggleable · stored in this browser',
    '官方文档 = 引擎内置的 effect / trigger / scope 关键字;common = 各单位 / 国策 / idea 等数据定义; scripted_effects / scripted_triggers = common 目录下自定义的效应与触发器。补全时每条都会标注出处。':
      'Official docs = the engine’s built-in effect / trigger / scope keywords; common = data definitions for units / focuses / ideas etc.; scripted_effects / scripted_triggers = custom effects and triggers under common/. Each completion is labelled with its origin.',
    '点击键位后直接按下新组合键即可改绑 · 存于本机浏览器':
      'Click a key then press the new combination to rebind · stored in this browser',
    '改动': 'Changes',
    '立即生效': 'take effect immediately',
    ',但只影响本页与各业务页的下次加载(快捷键在页面加载时注册)。':
      ', but only affect this page and the next load of each tool page (shortcuts register on page load).',
    '斜杠': 'Slash',
    '这类无修饰键会与浏览器/输入法有冲突, 若改完发现打不出,可用该项右侧的「清除」禁用它。':
      'Modifier-less keys like this clash with the browser or the IME; if it stops working after rebinding, use “Clear” on the right to disable it.',
    '保存并应用': 'Save and apply',
    '清空模组列表': 'Clear the mod list',

    /* ═════ i18n.js 自身的界面文案 ═════ */
    '工作台': 'Workbench',
    '语言': 'Language',
    '关闭': 'Close',
    '恢复默认': 'Reset to defaults',
    'HOI4 模组工作台': 'HOI4 Mod Workbench',
    '壁纸压暗': 'Wallpaper dim',
    '壁纸模糊': 'Wallpaper blur',
    '归属国家': 'Province owners',
    '归属': 'Owner',
    '原版 vs 模组': 'Vanilla vs Mod',
    '返回工作台': 'Back to workbench',
    '切换到英文': 'Switch to Chinese',
    '暂无内容': 'Nothing here yet',
    '出错了': 'Error',
    '重试': 'Retry',
    '搜索': 'Search',
    '级': 'lvl',
    '正在构建…': 'Building…',
    '秒': 's',
    '教程': 'Guide',
    '解析、检查、编辑你的模组 —— 全部在本机完成':
      'Parse, audit and edit your mod — all on your machine',
    '壁纸半透明': 'Wallpaper translucency',
    '面板玻璃度': 'Panel opacity',
    '玻璃度越低越能看清壁纸,越高原文字越清晰。':
      'Lower panel opacity shows more wallpaper; higher keeps text crisp.',
    '原版定义': 'Vanilla',
    '模组覆盖': 'Mod override',
    '省份': 'Province',
    '人力': 'Manpower',
    '本地补给': 'Local supplies',
    '资源': 'Resources',
    '核心国': 'Cores',
    '胜利点': 'Victory points',
    '建筑': 'Buildings',
    '无归属(海洋/湖泊/空地)': 'Unowned (sea / lake / empty)',
    '需': 'Needs',
    '地图资产': 'Map assets',
    '被 replace_path 丢弃': 'dropped by replace_path',
    '坐标': 'Coordinates',
    '正在合成世界地图…': 'Building world map…',
    '世界地图构建失败': 'World map build failed',
    '正在按 DLC 重算地图归属…': 'Recomputing map ownership…',
    '差值': 'Delta',
    '[i18n] 缺翻译:': '[i18n] missing translation:',
    '[i18n] 回调出错': '[i18n] callback error',
    '要翻的地方在哪': 'Where to translate',
    '当前语言': 'Current language',
    '看起来能用、其实只能切一次':
      'Looks like it works, but only switches once',

    /* ═════ check.js — 体检 ═════ */
    ' 项': ' items',
    '<div class="muted">未发现明显问题</div>':
      '<div class="muted">No obvious problems found</div>',
    '全部来源(vanilla + 已挂载模组)': 'All sources (vanilla + mounted mods)',
    '（计算机）': '(computer)',
    '无': 'None',
    '请求失败: ': 'Request failed: ',
    '正在生成体检报告…': 'Generating the audit report…',
    '  [已挂载]': '  [mounted]',
    '  [无 .mod]': '  [no .mod]',
    '  ⚠ 版本不匹配': '  ⚠ version mismatch',
    '已挂载来源': 'Mounted sources',
    '创意工坊(未挂载)': 'Workshop (not mounted)',
    '  [当前]': '  [current]',
    '<span class="pill muted">全量体检</span>':
      '<span class="pill muted">Full audit</span>',
    '<span class="pill muted">统计所有已挂载来源的问题</span>':
      '<span class="pill muted">Counts problems across every mounted source</span>',
    '已挂载': 'Mounted',
    '未挂载 · 仅体检': 'Not mounted · audit only',
    '支持 ': 'Supports ',
    '<span class="pill bad">无 .mod · 按目录结构识别</span>':
      '<span class="pill bad">No .mod · recognised by directory structure</span>',
    '读取模组清单失败: ': 'Failed to read the mod list: ',
    '设定失败': 'Set failed',
    '设定失败: ': 'Set failed: ',
    '<div class="d"><span class="nm muted">（没有子目录）</span></div>':
      '<div class="d"><span class="nm muted">(no subdirectories)</span></div>',
    '<div class="d"><span class="nm">读取失败：': '<div class="d"><span class="nm">Read failed:',
    '错误': 'Error',
    '告警/提示': 'Warning / note',
    '定义': 'Definition',
    '引用': 'Reference',
    '脚本文件': 'Script file',
    '本地化文件': 'Localisation file',
    '语法错误': 'Syntax error',
    '<span class="tag bad">缺 }</span>': '<span class="tag bad">missing }</span>',
    '<span class="tag bad">多 }</span>': '<span class="tag bad">extra }</span>',
    ' 等': ' etc.',
    '括号结构提示(可能误报,需人工确认)':
      'Brace structure notes (may be false positives, confirm manually)',
    '<span class="tag bad">同文件真重复</span>':
      '<span class="tag bad">a real duplicate in the same file</span>',
    '<span class="tag hint">共享/覆盖</span>': '<span class="tag hint">shared / overridden</span>',
    '重复定义': 'Duplicate definition',
    '悬空图标引用(GFX_ 前缀)': 'Dangling sprite reference (GFX_ prefix)',
    '主语言': 'Main language',
    '<span class="tag bad">全缺</span>': '<span class="tag bad">all missing</span>',
    '缺失本地化': 'Missing localisation',
    '本地化完整性': 'Localisation completeness',
    '体检生成失败: ': 'Audit generation failed: ',
    '体检请求失败': 'Audit request failed',

    /* ═════ events.js ═════ */
    '<option value="">全部</option>': '<option value="">All</option>',
    '复制选中事件的 id': 'Copy the selected event id',
    '对选中事件打开右键菜单': 'Open the context menu for the selected event',
    '缺本地化': 'Missing localisation',
    '<div class="empty"><span class="spin"></span> 载入中…</div>':
      '<div class="empty"><span class="spin"></span> Loading…</div>',
    '<div class="empty">索引构建中:': '<div class="empty">Index building:',
    '请稍候': 'please wait',
    ' 个事件 · ': ' events · ',
    ' 个文件': ' files',
    '<div class="empty">载入失败:': '<div class="empty">Load failed:',
    '<div class="empty">没有匹配的事件</div>':
      '<div class="empty">No matching events</div>',
    '（无标题）': '(untitled)',
    ' 选项 · ': ' options · ',
    ' —— 换个命名空间或用搜索缩小范围</div>':
      ' — try another namespace or narrow it down with the search</div>',
    '复制类型(': 'Copy type (',
    '复制选项数(': 'Copy option count (',
    '复制图片路径': 'Copy image path',
    '复制命名空间(': 'Copy namespace (',
    '只看这个命名空间': 'Show only this namespace',
    '先点选一个事件': 'Click an event first',
    '下一个事件': 'Next event',
    '上一个事件': 'Previous event',
    '返回列表': 'Back to the list',
    '<div class="empty">找不到事件 ': '<div class="empty">Event not found: ',
    '<div class="empty">读取失败:': '<div class="empty">Read failed:',
    '<span class="flag hot">仅脚本触发</span>':
      '<span class="flag hot">script-triggered only</span>',
    '<span class="flag">只触发一次</span>': '<span class="flag">fires once</span>',
    '<span class="flag">隐藏</span>': '<span class="flag">hidden</span>',
    '<span class="flag hot">头条</span>': '<span class="flag hot">headline</span>',
    '<div class="kv"><b>文件</b><span>': '<div class="kv"><b>File</b><span>',
    '<div class="kv"><b>命名空间</b><span>': '<div class="kv"><b>Namespace</b><span>',
    '<div class="kv"><b>图片</b><span>': '<div class="kv"><b>Image</b><span>',
    '<div class="card"><div class="hd">标题 / 描述</div><div class="bd">':
      '<div class="card"><div class="hd">Title / description</div><div class="bd">',
    '<div class="card"><div class="hd">选项 <span style="font-weight:400;color:var(--ink3)">':
      '<div class="card"><div class="hd">Options <span style="font-weight:400;color:var(--ink3)">',
    ' 个</span></div><div class="bd">': ' </span></div><div class="bd">',
    '<div class="empty" style="padding:14px">没有 option —— 这类事件通常只播一条消息</div>':
      '<div class="empty" style="padding:14px">No options — this kind of event usually just fires one message</div>',
    '<div class="on">选项 ': '<div class="on">Option ',
    '<span>无 ai_chance</span>': '<span>no ai_chance</span>',
    '<span>有 trigger</span>': '<span>has trigger</span>',
    ' 条效果</span>': ' effects</span>',
    '<span>行 ': '<span>Line ',
    '<div class="card"><div class="hd">option 原文</div><div class="bd">':
      '<div class="card"><div class="hd">Option source</div><div class="bd">',
    '<div class="card"><div class="hd">覆盖链</div><div class="bd">':
      '<div class="card"><div class="hd">Override chain</div><div class="bd">',
    ' ← 生效': ' ← in effect',
  }
  if (typeof window !== 'undefined' && window.I18N) window.I18N.registerDict(D)
})()
