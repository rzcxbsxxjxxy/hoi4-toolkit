/* ══════════════════════════════════════════════════════════════════
 * i18n 字典 · 批次 3/4:DLC 内容页(dlc.js / dlc.html)
 *             + 源码组织页(focus / doctrines / decisions / events /
 *                          aibehave / ai / modrel / ref)
 *
 * ★ 注意:所有以 \n 开头的键,那个 \n 是**字面反斜杠 + n**
 *   (源码写在普通字符串里),不是真换行。写成真换行键就对不上,
 *   孤儿键检查会报出来。
 * ══════════════════════════════════════════════════════════════════ */
;(function () {
  const D = {
    /* ═════ dlc.js ═════ */
    '来源': 'Source',
    '筛选': 'Filter',
    '分组': 'Group',
    '复制统计': 'Copy stats',
    '已安装 DLC': 'Installed DLC',
    '全部模组': 'All mods',
    '全部国家': 'All countries',
    ' 特质': ' Traits',
    '玩法': 'Gameplay',
    '清除 DLC 筛选': 'Clear DLC filter',
    '取消玩法筛选': 'Clear gameplay filter',
    '只看这个玩法': 'Show only this gameplay',
    '复制玩法 id': 'Copy gameplay id',
    '前置关系': 'Prerequisites',
    'DLC 归属': 'DLC ownership',
    '特质分布': 'Trait distribution',
    '<option value="">全部 DLC</option>': '<option value="">All DLC</option>',
    '[dlc] 注册表里声明但目录不存在(可能 DLC 未购买):':
      '[dlc] declared in the registry but the directory is missing (DLC probably not owned):',
    '机构列表': 'Agency list',
    '\\n该 DLC 未引入可提取的 common 玩法结构':
      '\\nThis DLC introduces no extractable common gameplay structure',
    ' · 目录缺失': ' · directory missing',
    '当前 .cards': 'Current .cards',
    '<span class="mini" title="有 available/visible/allowed 条件">有条件</span>':
      '<span class="mini" title="Has available/visible/allowed conditions">Conditional</span>',
    '<div class="empty">没有符合筛选条件的内容</div>':
      '<div class="empty">Nothing matches the current filters</div>',
    '<span>仅 DLC 专属</span>': '<span>DLC exclusive</span>',
    '一堆条目': 'entries',
    '<div class="empty">军工机构加载失败:': '<div class="empty">Failed to load military agencies:',
    '<div class="empty">特质树加载失败:': '<div class="empty">Failed to load the trait tree:',
    '\\n归属: ': 'Owner: ',
    '\\n本国新增 ': '\\nNew in this country: ',
    ' 个 / 继承 ': ' / inherited: ',
    '<div class="empty">没有匹配的机构</div>':
      '<div class="empty">No matching agency</div>',
    '<div class="empty">正在加载军工机构…</div>':
      '<div class="empty">Loading military agencies…</div>',
    '<div class="empty">左侧选择一个机构,查看它的特质树<br>':
      '<div class="empty">Pick an agency on the left to see its trait tree<br>',
    '<span style="color:var(--ink3)">共 ': '<span style="color:var(--ink3)">',
    ' 个机构 / ': ' agencies / ',
    ' 个特质节点</span></div>': ' trait nodes</span></div>',
    '<div class="empty">正在加载特质树…</div>':
      '<div class="empty">Loading the trait tree…</div>',
    '<div class="empty">该机构没有符合筛选条件的特质</div>':
      '<div class="empty">This agency has no traits matching the filters</div>',
    '单独的框架显示': 'Standalone frame display',
    '继承 ': 'Inherits ',
    ' 个底盘': ' chassis',
    '总 ': 'Total ',
    '<span class="ln"></span>全满足解锁<span class="ln any"></span>任一满足':
      '<span class="ln"></span>all must match<span class="ln any"></span>any may match',
    '框架': 'Frame',
    '继承自通用底盘(上一级框架)': 'Inherited from the generic chassis (parent frame)',
    '需全部:': 'Requires all:',
    '任一:': 'Any of:',
    '查不到译文': 'No localisation found',
    '\\n列 ': '\\nColumn ',
    ' / 行 ': ' / row ',
    '\\n网格基准: ': '\\nGrid basis: ',
    '\\n解锁: ': '\\nUnlocks: ',
    '全部(': 'All (',
    '任一(': 'Any (',
    '\\n限装备: ': '\\nLimited to equipment: ',
    '\\n(继承自 generic 底盘)': '\\n(inherited from the generic chassis)',
    '<span>继承 ': '<span>Inherits ',
    ' 个 generic 底盘</span>': ' generic chassis</span>',
    '<div style="color:var(--ink3);padding:6px 11px">点选一个特质</div>':
      '<div style="color:var(--ink3);padding:6px 11px">Click a trait</div>',
    '<div style="color:var(--ink3);padding:6px 11px">点选一个特质查看加成<br>':
      '<div style="color:var(--ink3);padding:6px 11px">Click a trait to see its bonuses<br>',
    '<span style="font-size:11px">共 ': '<span style="font-size:11px">',
    ' 个节点</span></div>': ' nodes</span></div>',
    ' · 继承自 generic': ' · inherited from generic',
    ' · 本国新增': ' · new in this country',
    '<h4>位置</h4>': '<h4>Position</h4>',
    '网格 列/行': 'Grid column/row',
    '像素 画布': 'Pixel canvas',
    '网格基准': 'Grid basis',
    '<div class="note">position 是相对该节点的格子偏移，不是相对树原点</div>':
      '<div class="note">position is a cell offset relative to this node, not relative to the tree origin</div>',
    '<h4>解锁条件</h4>': '<h4>Unlock conditions</h4>',
    '全部满足': 'All must match',
    '任一满足': 'Any may match',
    '<div class="note">无前置条件（起始节点）</div>':
      '<div class="note">No prerequisites (starting node)</div>',
    '<h4>限装备类型</h4><div class="note">': '<h4>Limited equipment types</h4><div class="note">',
    '<h4>DLC 门控</h4><div class="note dl">': '<h4>DLC gate</h4><div class="note dl">',
    '<h4>装备加成（加法/乘法分开）</h4>': '<h4>Equipment bonuses (additive and multiplicative listed separately)</h4>',
    '<h4>生产加成</h4>': '<h4>Production bonuses</h4>',
    '<h4>来源</h4>': '<h4>Source</h4>',
    '<h4>图标</h4><div class="note">': '<h4>Icon</h4><div class="note">',
    'DLC 门控最密集的目录:': 'Directories with the densest DLC gating:',
    '<div style="color:var(--ink3);padding:6px 11px">点选一条内容</div>':
      '<div style="color:var(--ink3);padding:6px 11px">Click an entry</div>',
    '<div style="color:var(--ink3);padding:6px 11px">条目已不在当前筛选结果中</div>':
      '<div style="color:var(--ink3);padding:6px 11px">The entry is no longer in the current filter results</div>',
    '图标': 'Icon',
    '在检查器中查看': 'View in the inspector',
    '选中这条内容': 'Select this entry',
    '只看这个 DLC(': 'Show only this DLC (',
    '」不在已安装 DLC 清单里 —— 条目可能只是声明了 has_dlc':
      '” is not in the installed DLC list — the entry may merely declare has_dlc',
    '只勾「': 'Tick only the DLC "',
    '」的 DLC 筛选': '" filter',
    '复制覆盖链(两处路径)': 'Copy the override chain (both paths)',
    '该条目带 available / visible / allowed 条件 —— 并非所有国家 / 状态都可用':
      'This entry has available / visible / allowed conditions — it is not available to every country / state',
    '复制整条内容(KV)': 'Copy the whole entry (KV)',
    '下一条卡片': 'Next card',
    '上一条卡片': 'Previous card',
    '取消选择 / 清搜索': 'Clear selection / search',
    '只看 DLC 专属': 'Show only DLC-exclusive entries',
    '当前没有 DLC 筛选': 'No DLC filter currently',
    '复制数据目录': 'Copy the data directory',
    '清除这个 DLC 筛选': 'Clear this DLC filter',
    '只看这个 DLC': 'Show only this DLC',
    '复制 DLC 名': 'Copy DLC name',
    '复制 DLC 目录': 'Copy DLC directory',
    '该 DLC 未引入可提取的 common 玩法结构':
      'This DLC introduces no extractable common gameplay structure',
    '⚠ 目录在已挂载来源里不存在': '⚠ The directory does not exist in any mounted source',
    '取消机构筛选': 'Clear agency filter',
    '查看这个机构的特质树': 'View this agency’s trait tree',
    '复制机构 id': 'Copy agency id',
    '复制机构名(去 _organization)': 'Copy agency name (without _organization)',
    '只在搜索框里找它': 'Find it via the search box only',
    '复制 include 底盘(': 'Copy included chassis (',
    '只看 ': 'Show only ',
    '只看来自 ': 'Show only agencies from ',
    /* ★ 下面几条译文是**故意的空串**,不是漏翻:
     *   源码把中文句子按变量切成了片段,如
     *     '只看来自 ' + org.rootName + ' 的机构'
     *   英文语序里 "Show only agencies from GER" 不需要尾部的 "的机构",
     *   所以 ' 的机构' → ''。留中文会变成 "Show only agencies from GER 的机构"。
     *   i18n.cover.test.cjs 的 ALLOW_EMPTY 白名单据此放行。*/
    ' 的机构': '',
    ' 个': ' ',    '跳到前置(需全部) ': 'Jump to prerequisites (all required) ',
    '跳到前置(任一) ': 'Jump to prerequisites (any) ',
    '复制限装备清单': 'Copy limited equipment list',
    '复制全部加成': 'Copy all bonuses',
    '继承自 generic 底盘 —— 改它要改 generic,本体不生效':
      'Inherited from the generic chassis — change it in generic, editing it here has no effect',
  }
  if (typeof window !== 'undefined' && window.I18N) window.I18N.registerDict(D)
})()
