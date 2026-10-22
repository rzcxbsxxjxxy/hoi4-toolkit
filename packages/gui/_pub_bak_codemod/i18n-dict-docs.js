/* ══════════════════════════════════════════════════════════════════
 * i18n 字典 · 批次 10:使用教程正文(docs.html)
 *
 * ★ 这些条目是被 inline 标签(<code>/<b>/<em>)切碎的**句子片段**,
 *   不是一个整句。译文必须保证:按原顺序拼回去后读起来是通顺的英文,
 *   而不是逐字对译。写之前先看前后片段。
 *   例:"与" 夹在两个 <code> 之间,译成 "and" 才通;
 *      "、 做" 是顿号+动词片段,不能译成 ", do" 这种半截。
 * ══════════════════════════════════════════════════════════════════ */
;(function () {
  const D = {
    '使用教程 · HOI4 工作台': 'Guide · HOI4 Workbench',
    '📖 使用教程': '📖 Guide',
    '这是什么': 'What this is',
    '一套本地运行的 HOI4 模组辅助工作台：把游戏目录与创意工坊模组挂进来， 就能':
      'A locally running HOI4 mod workbench: mount a game directory and workshop mods, and you can',
    '可视化浏览': 'browse visually',
    '国策树 / 科技树 / 决议树、': 'the focus tree / technology tree / decision tree,',
    '拖拽编辑': 'drag to edit',
    '、 做': ', make',
    '无损改写': 'lossless rewrites',
    '、跑': ', run',
    '与': 'and',
    '跨文件重命名': 'cross-file renames',
    '。 所有解析走自研的 Clausewitz 无损解析器 —— 改写后文件里你手写的注释、空行、缩进都会原样保留。':
      '. All parsing goes through our own lossless Clausewitz parser — after a rewrite, your own comments, blank lines and indentation are preserved exactly.',
    '和同类工具的区别': 'How this differs from similar tools',
    '常见工具（HOI4 Mod Utilities 等）定位在': 'Common tools (HOI4 Mod Utilities and the like) focus on',
    '编辑器内写代码': 'writing code inside the editor',
    '：语法高亮、补全、跳转、校验。 本工作台定位在':
      ': syntax highlighting, completion, jump-to-definition, validation. This workbench focuses on',
    '跨文件的整体视图': 'a cross-file overview',
    '：把散落在几十个文件里的国策/决议/科技/界面元素 汇总成一张图，看清结构、来源归属和坐标关系，再一次性回写。 两边互补，不冲突。':
      ': it gathers the focuses / decisions / technologies / interface elements scattered across dozens of files into one picture, so you can see structure, source ownership and coordinate relationships, then write everything back in one go. The two complement each other.',
    '快速开始': 'Quick start',
    '打开': 'Open',
    '（或直接进': '(or go straight to',
    '⚙ 设置': '⚙ Settings',
    '），填游戏安装目录。 点「自动检测」，工具会扫描 Steam 库、列出所有候选路径，选一个即可。':
      ') and fill in the game install directory. Click “Auto-detect” and the tool scans your Steam libraries and lists every candidate path — pick one.',
    '在': 'In',
    '区勾选要挂进来的模组。可以「扫描创意工坊」批量列出':
      ', tick the mods you want to mount. Use “Scan workshop” to list them in bulk,',
    '，也可以在输入框粘贴本地模组目录手动添加。 模组顺序 = 游戏加载顺序，可用上下箭头调整；':
      ' or paste a local mod directory into the box to add it by hand. Mod order = game load order; use the arrows to rearrange it —',
    '越靠后优先级越高': 'the later an entry is, the higher its priority',
    '点「保存并应用」→「重新载入」。重载后所有页面（国策/科技/决议/GUI）都会按新的来源组合重建索引。':
      'Click “Save and apply” → “Reload”. After reloading, every page (focus / technology / decisions / GUI) rebuilds its index from the new source combination.',
    '看不到模组内容？先查这三件事': 'No mod content showing? Check these three things first',
    '目录里有没有': 'Whether the directory contains a',
    '文件 —— 这是模组识别的特征文件，没有就识别不出来。':
      ' file — that is what identifies a mod, without it the mod cannot be recognised.',
    '模组是否声明了': 'Whether the mod declares a',
    '，设置页会显示版本兼容提示。':
      ', in which case the settings page shows a version compatibility hint.',
    '如果只勾了模组没勾基础游戏，原版内容会缺失；':
      'If you ticked only mods and not the base game, vanilla content will be missing;',
    '基础游戏应当始终排在最前面': 'the base game should always come first',
    '核心概念：来源的三层语义': 'Core concept: the three layers of source semantics',
    '挂了多个来源后，同一个国策/决议/文件可能同时存在于原版和模组里。 工具用三个字段描述「它到底是谁的」，理解这组语义是使用筛选功能的前提：':
      'Once several sources are mounted, the same focus / decision / file may exist in both vanilla and a mod. Three fields describe “whose it really is” — understanding them is the prerequisite for using the filters:',
    '含义': 'Meaning',
    '内容归属': 'Content ownership',
    '：最终生效的那一份，来自': ': the copy that actually takes effect, comes from',
    '只读的基础游戏': 'the read-only base game',
    '。 注意 —— 若模组把内容全量覆盖了，这一档会是':
      '. Note — if a mod overrides that content wholesale, this bucket ends up',
    '的， 所以「仅基础游戏」筛选结果为空是正常的，不代表解析失败。':
      ', so an empty “base game only” filter result is normal and does not mean parsing failed.',
    '出身': 'Origin',
    '（覆盖链里包含只读基础游戏） 或': '(the override chain includes the read-only base game), or',
    '（原版根本没有这个东西，模组独创）。': '(vanilla has no such thing at all — the mod invented it).',
    '是否被改写': 'Overridden',
    'origin=原版': 'origin = vanilla',
    '但最终生效的那份来自模组。 标记成':
      'but the copy that takes effect comes from a mod. Marked as',
    '改写': 'overridden',
    '，是排查「为什么我的改动不生效」的第一入口。':
      ' — this is the first thing to check when “why is my change not taking effect”.',
    '徽标图例': 'Badge legend',
    '原版内容，未被模组改动': 'Vanilla content, untouched by any mod',
    '原版有，但被模组覆盖': 'Present in vanilla but overridden by a mod',
    '新增': 'Added',
    '原版没有，模组独有': 'Not in vanilla, exclusive to the mod',
    '生效来源为模组': 'The effective source is a mod',
    '典型用法': 'Typical use',
    '想知道「KR 到底改了原版哪些国策」→ 国策页来源筛选选':
      'To see “which vanilla focuses did KR actually change” → pick',
    '； 想知道「KR 新增了什么」→ 选':
      'on the focus page source filter; to see “what did KR add” → pick',
    '。 这两个数字在树列表下方的统计条里会直接给出。':
      '. Both numbers appear directly in the stats bar under the tree list.',
    '页面导览': 'Page tour',
    'GUI 预览与拖拽': 'GUI preview and dragging',
    '左侧文件树列出所有': 'The file tree on the left lists every',
    '，中间画布按真实坐标渲染，右上是缩放/适应/贴图/名称开关。 在画布上':
      ', the canvas in the middle renders at real coordinates, and the top right has the zoom / fit / sprite / name toggles. On the canvas you can',
    '拖动元素': 'drag an element',
    '会进入待改区（右上「待保存 N」）， 确认后点「保存」—— 回写是':
      'to move it into the pending area (the “N pending” counter at the top right); once confirmed, click “Save” — the write-back is',
    '行级最小差异': 'a minimal line-level diff',
    '，只改动你碰过的那几行，其余字节原样不动。':
      ' — only the lines you touched change, every other byte stays untouched.',
    '：自动缩放铺满视口，找元素时先按一下。':
      ': auto-zooms to fill the viewport — press it first when hunting for an element.',
    '：开关 sprite 背景。模组常用': ': toggles the sprite background. Mods commonly use',
    '（原版多用': ' (vanilla prefers',
    '），工具两者都认。': '), and the tool understands both.',
    '：显示元素名，调试坐标时非常有用。':
      ': shows element names, which is extremely handy when debugging coordinates.',
    '四栏可视化编辑': 'Four-pane visual editing',
    '文件树 / 画布 / 元素树 / 属性网格。相比工作台多出：':
      'File tree / canvas / element tree / property grid. Compared with the workbench it adds:',
    '属性网格': 'the property grid',
    '：按语法枚举给出候选值，不用手敲字符串。':
      ': offers candidate values from the syntax enums, so you never type raw strings.',
    '增删元素': 'adding and removing elements',
    '：选中后按': ': select one and press',
    '删除，属性网格里可加子块。':
      ' to delete it; the property grid can add child blocks.',
    '吸附': 'Snapping',
    '：设置页可开「拖拽吸附网格」并指定格宽，对齐时省事。':
      ': enable “snap grid when dragging” on the settings page and set the cell width to make alignment painless.',
    '结构、体检与坐标回写': 'Structure, audit and coordinate write-back',
    '来源筛选': 'Source filtering',
    '：按上一节的三层语义过滤，树列表会显示每棵树的来源徽标。':
      ': filter by the three layers described above; the tree list shows a source badge on each tree.',
    '拖拽改坐标': 'Dragging to change coordinates',
    '：拖动国策节点后保存。若该节点写了':
      ': drag a focus node and save. If that node declares',
    '，写回的是': ', what gets written back is',
    '相对父节点的偏移': 'the offset relative to the parent node',
    '，而不是绝对坐标 —— 这是官方的相对布局语法，写绝对值会破坏相对关系。':
      ', not absolute coordinates — that is the official relative layout syntax, and writing absolute values breaks the relationship.',
    '：检查悬空依赖、重复 id、坐标重叠、缺失本地化等， 结果分 error / warning 两级列在右侧。':
      ': checks dangling dependencies, duplicate ids, overlapping coordinates, missing localisation and more; results are listed on the right in two levels, error and warning.',
    '坐标重叠不一定是 bug': 'Overlapping coordinates are not necessarily a bug',
    '互斥分支（如两个互斥的国策路线）用': 'Mutually exclusive branches (say two competing focus paths) use',
    '同一坐标': 'the same coordinates',
    '是官方惯用写法 —— 因为同一时刻只会有一条生效。体检对这种情况做了消歧，不会误报。 另外 id 前缀不同的树属于「多国共享树」，也不算冲突。':
      ' — that is the idiomatic vanilla approach, since only one of them is ever active at a time. The audit disambiguates this case and does not report it. Also, trees whose id prefixes differ are “shared trees” for multiple countries, which is not a conflict either.',
    '两级分类与隐藏科技': 'The two classification layers and hidden technologies',
    '科技有': 'Technologies have',
    '两层分类': 'two classification layers',
    '，容易混淆：': 'which are easy to confuse:',
    '作用': 'serves as',
    '横向顺序表，决定左右排列次序，': 'a horizontal order table deciding the left-to-right order, and is',
    '不是': 'not',
    '显示分组': 'the display grouping',
    '真正的显示分组，带': 'The real display grouping, which carries',
    '「隐藏科技」有两类，勾选「隐藏科技」后都会显示：':
      'There are two kinds of “hidden technology”, both shown once you tick “Hidden technologies”:',
    '没有': 'those without',
    '的科技 —— 游戏里没有标题栏，画布上画成':
      ' — no header row in game, drawn on the canvas as',
    '米色虚线框': 'a beige dashed box',
    '的文件夹里的科技 —— 游戏里整个分组都不显示。':
      ' — technologies inside such a folder; the entire group is hidden in game.',
    '另有一部分 doctrine 分类声明了但当前没有科技（由脚本运行时填充）， 画布上标为「空 · 由脚本填充」而不是隐藏，避免误判成解析失败。 科技普遍是多分类的，筛选用的是包含判断而非等值。':
      'A number of doctrine categories are declared but currently hold no technologies (they are filled at runtime by scripts); on the canvas these are marked “empty · script-filled” rather than hidden, so they are not mistaken for a parse failure. Technologies commonly belong to several categories, so the filter tests containment rather than equality.',
    '按': 'Organised by',
    '组织成卡片墙，绿左边条表示该分类来自模组。 顶部统计条给出原版 / 模组新增的条数，点分类钻取到具体决议， 右侧检查器显示生效来源与覆盖链。':
      ' into a card wall, with a green left bar marking categories that come from a mod. The stats bar at the top gives the vanilla / mod-added counts; click a category to drill into its decisions, and the inspector on the right shows the effective source and the override chain.',
    '脚手架': 'Scaffolding',
    '选择产物类型（国策 / 决议 / 事件 / 本地化等），填字段后生成可直接落盘的':
      'Pick an output type (focus / decision / event / localisation …), fill in the fields, and it generates files you can write straight to disk:',
    '。可以「填示例」看格式，生成结果支持一键复制。':
      '. Use “Fill sample” to see the format; the result can be copied in one click.',
    'IDE / 体检': 'IDE / Validator',
    '编辑与全量校验': 'Editing and full validation',
    '：基于符号表的补全与跳转，适合精修单个文件。':
      ': completion and jump-to-definition based on the symbol table — best for polishing a single file.',
    '：对当前挂载的全部来源跑校验，按严重度分卡片汇总，点条目可跳到对应文件。':
      ': runs validation across every mounted source and groups the results into cards by severity; click an entry to jump to the file.',
    '进阶：GUI 坐标是怎么算的': 'Advanced: how GUI coordinates are computed',
    '如果你想改': 'If you are trying to change',
    '却总觉得位置对不上，这一节是必读的。 我们的渲染链路逐字对齐了 VSCode 扩展':
      ' and the position never lines up, this section is essential. Our rendering path follows the VSCode extension',
    '的实现 （扩展': ' implementation line for line (the extension’s',
    '里的': ' in ',
    '）， 并在原版 23558 个样本上比对通过。下面是几个最容易踩的坑：':
      ') and was verified against 23558 vanilla samples. Here are the easiest traps:',
    '1. 锚点来自': '1. The anchor comes from',
    '，对齐点来自': ', the alignment point comes from',
    '—— 不是同一个东西': '— these are not the same thing',
    '决定': 'decides',
    '父级的哪个点': 'which point of the parent',
    '作为坐标原点（锚点，9 种取值）；': 'is the coordinate origin (the anchor, 9 possible values);',
    '元素自身的哪个点': 'which point of the element itself',
    '对齐到那个锚点（对齐点）。 把两者当成同一个东西，元素会整体平移半个自身宽度。':
      'is aligned to that anchor (the alignment point). Treating them as the same thing shifts the element by half its own width.',
    '缺省对齐点是': 'The default alignment point is',
    '，只看': ', it only looks at',
    '，与': ', and has nothing to do with',
    '无关。': '.',
    '判例不能随便挑': 'Pick your test cases carefully',
    '用某个元素「看起来对」来反推缺省行为是危险的 —— 比如':
      'Inferring default behaviour from an element that “looks right” is dangerous — for example',
    '贴齐 1920，常被当作「对齐点 = 锚点」的证据， 但它':
      'flush at 1920 is often taken as evidence that “alignment point = anchor”, but it',
    '显式写了': 'explicitly declares',
    '，对缺省行为零信息量。 验证缺省行为必须挑「没有写该字段」的样本。':
      ', which says nothing about the default. To verify default behaviour you must pick samples that omit the field.',
    '是两种不同的单位': 'are two different units',
    "'100' → 100 px（绝对值） '100%' → 父尺寸 × 100 / 100 '100%%' → 父尺寸 × 100 / 100 − 自身坐标偏移":
      "'100' → 100 px (absolute) · '100%' → parent size × 100 / 100 · '100%%' → parent size × 100 / 100 − own position offset",
    '的语义是「': 'The meaning of',
    '延伸到父级边界': 'extends to the parent edge',
    '」：先按百分比算，再扣掉自己的坐标偏移。 原版里有 800 多处':
      '” is: compute by percentage first, then subtract your own position offset. Vanilla has 800-odd occurrences of',
    '尺寸和几十处': 'sizes and several dozen',
    '负尺寸': 'negative sizes',
    '， 负尺寸表示向反方向延伸，不能提前取绝对值。':
      '; a negative size extends in the opposite direction, so you must not take the absolute value early.',
    '3. 图标 / 按钮没有': '3. Icons and buttons have no',
    '块': ' block',
    '通常不写': 'and usually declare no',
    '， 它们的绘制尺寸': ', so their drawn size',
    '只能取自 sprite': 'can only come from the sprite',
    '。 如果按「没写 size 就是 0」处理，画布上所有图标都会变成 0×0 的空框 —— 这是早期版本最明显的一个位置错误。现在尺寸会取 sprite 宽高再乘':
      '. Treating “no size means 0” turns every icon on the canvas into an empty 0×0 box — the most obvious positioning bug in the early versions. The size is now taken from the sprite width and height, multiplied by',
    '同理，取': 'Likewise, take',
    '4. 传给子元素的父尺寸是「声明值」':
      '4. The parent size passed to children is the “declared value”',
    '子元素的坐标系用的是父级': 'A child’s coordinate system uses the parent’s',
    '的': ' ',
    '声明值': 'declared value',
    '，不是父级最终绘制宽度 （绘制宽度可能被':
      ', not the parent’s final drawn width (the drawn width may have been recalculated by',
    '或': ' or',
    '重算过）。 用绘制宽度会让整棵子树偏移。':
      '). Using the drawn width shifts the entire subtree.',
    '5. 其他几个会影响位置的机制': '5. A few other mechanisms that affect position',
    '机制': 'Mechanism',
    '效果': 'Effect',
    '容器级：子坐标系扣除 margin，整体右下平移':
      'Container level: margins are subtracted from the child coordinate system, shifting everything right and down',
    '嵌套': 'Nesting',
    '写了它，就忽略': 'declaring it makes the tool ignore',
    '递归累加被引用元素的偏移（带环检测）':
      'and recursively accumulate the referenced element’s offset instead (with cycle detection)',
    '原版有 9 处用到，语义是「左边中点」。扩展的锚点表漏了这个键，会 fallback 算错；我们保留了特例':
      'Vanilla uses it in 9 places, where it means “left centre”. The extension’s anchor table omits that key and falls back incorrectly; we kept the special case',
    '按键': 'By key',
    '工作台 / 设计器 / 国策页：微调选中元素坐标 1px':
      'Workbench / designer / focus page: nudge the selected element by 1px',
    '+ 方向键': '+ arrow keys',
    '工作台 / 设计器：按 10px 步进微调':
      'Workbench / designer: nudge in 10px steps',
    '设计器：删除选中元素（在输入框内不触发）':
      'Designer: delete the selected element (does not fire inside inputs)',
    '滚轮': 'Mouse wheel',
    '画布缩放；拖动空白处平移': 'zoom the canvas; drag empty space to pan',
    '常见问题': 'FAQ',
    '改完保存，游戏里没变化？': 'You saved your change but nothing happened in game?',
    '先确认你改的是': 'First make sure you edited',
    '生效的那一层': 'the layer that actually takes effect',
    '。如果原版同名文件还在更靠后的位置被模组覆盖， 你的改动会被覆盖掉。用来源徽标（':
      '. If a same-named vanilla file sits later and gets overridden by a mod, your change is overwritten. Use the source badge (',
    '）确认哪份最终生效。':
      ') to confirm which copy wins.',
    '为什么筛选「仅基础游戏」是空的？': 'Why is the “base game only” filter empty?',
    '因为': 'Because',
    '指的是「最终生效的那份来自只读基础游戏」。 当你挂的模组把内容全量覆盖了，这一档自然为空 —— 这是预期行为，不是 bug。 要对比原版请去掉模组来源，或改用':
      'means “the copy that takes effect comes from the read-only base game”. Once a mounted mod overrides that content wholesale the bucket is naturally empty — expected behaviour, not a bug. To compare against vanilla, drop the mod sources or switch to',
    '维度筛选。': 'filtering.',
    '模组贴图显示不出来？': 'A mod sprite will not show?',
    '模组喜欢把原版的': 'Mods like to swap vanilla’s',
    '换成': 'for',
    '，但声明里照抄不改扩展名。 工具会按同 stem 依次尝试':
      'while copying the declaration verbatim without changing the extension. The tool tries the same stem in turn:',
    '； 若模组目录里确实没有，会回退到原版同名文件（很多模组只是重新声明 sprite 复用原版贴图）。':
      '; if the mod directory really has none, it falls back to the same-named vanilla file (many mods merely redeclare the sprite to reuse the vanilla image).',
    '无损回写会不会破坏我的格式？': 'Does the lossless write-back break my formatting?',
    '不会。解析器保留 token 流与原始下标，序列化时按原文拼接， 只替换被改动的那几个 token 的字面量。未改动的文件逐字节相同。 保存时会在同目录留':
      'No. The parser keeps the token stream and original offsets, and serialises by concatenating the original text, replacing only the literals of the tokens you changed. Untouched files come out byte-identical. On save it leaves a',
    '能撤销吗？': 'Can I undo?',
    '保存前所有改动都在「待保存」区，可直接丢弃重来； 保存后靠同目录的':
      'Before saving, every change sits in the pending area and can simply be discarded; after saving, restore from the',
    '备份文件恢复。': 'backup file in the same directory.',
    '附录：后端接口': 'Appendix: backend endpoints',
    '想二次开发或写脚本批量处理，可以直接调这些接口：':
      'If you want to build on this or script bulk processing, call these endpoints directly:',
    '接口': 'Endpoint',
    '文件列表与内容': 'File list and contents',
    '单个': 'A single',
    '的布局（含坐标）': ' layout (with coordinates)',
    '无损回写 / 预览差异': 'Lossless write-back / diff preview',
    '元素级增删字段': 'Element-level field add / remove',
    '国策图 / 单树 / 体检 / 回写': 'Focus graph / single tree / audit / write-back',
    '科技图 / 决议图': 'Technology graph / decision graph',
    '跨文件引用图与无损重命名': 'Cross-file reference graph and lossless rename',
    '全量体检 / 符号导航': 'Full audit / symbol navigation',
    '读写设置 / 运行时重载来源': 'Read and write settings / reload sources at runtime',
    '扫描创意工坊 / 自动检测游戏目录': 'Scan the workshop / auto-detect the game directory',
  }
  if (typeof window !== 'undefined' && window.I18N) window.I18N.registerDict(D)
})()
