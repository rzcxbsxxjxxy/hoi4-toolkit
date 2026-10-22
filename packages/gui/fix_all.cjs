/* HOI4 GUI 设计器 —— 一次性落盘全部补丁 (v3)
 *
 *   node fix_all.cjs --dry     # 只校验锚点,不写盘
 *   node fix_all.cjs           # 正式应用
 *   node fix_all.cjs --dir=<目录>  # 打到别的副本上(自测用)
 *
 * ============================ 三部分内容 ============================
 *
 * 【A】Wiki 布局校正(WIKI_LAYOUT_V1/V2/V3 / ORIENT_INHERIT_FIX)
 *   依据 https://hoi4.paradoxwikis.com/Interface_modding
 *   核心:orientation **继承**。Wiki 原文 —
 *     "Elements will inherit the orientation of the containers they are
 *      located in unless the orientation is specified for the element itself."
 *   旧代码 model.ts 的注释写着"实测不继承",与 Wiki 直接冲突,本次用
 *   vanilla 453 个 .gui 独立复测后推翻,证据链:
 *     1) 变量名自证(决定性):career_profile/common_components.gui 里
 *        父容器 orientation=center_up size={width=@ColumnWidth=370},
 *        子容器 position={x=@StatContainerLeftX} size={width=@StatContainerSideW=170},
 *        同文件 @StatContainerLeftX=14 / @StatContainerRightX=-14 / @StatContainerCenterX=0。
 *        Right 取负值只有"以父容器中心为基准往左退"才成立 —— 锚点就是父中心。
 *        算术:继承后 offX = 0.5*370 + 14 - 0.5*170 = 114,子中心 199 = 父中心 185+14 ✓;
 *              不继承则 offX = 14,子中心 99,平白偏离父中心 86px ✗。
 *     2) 样本统计:父级含 right 锚点而子元素未写 orientation 的有 601 个,
 *        其中 599 个连 origo/centerposition 也没写。若不继承,父级 orientation
 *        对子元素毫无意义,vanilla 不会成片这样写。
 *     3) core.gui:218-224 地面真相:orientation=upper_right + origo=upper_right,
 *        slider position={x=-2}、decreaseButton position={x=2}。这种极小偏移
 *        只在"锚点=父级右缘"时成立;按不继承算 offX=-2,滚动条会整体散架飞屏。
 *     4) 同类样本中 32 个 position.x 为负(-1 ~ -17),负偏移只能以右缘为基准解释。
 *
 * 【B】设置页 + Steam 创意工坊模组发现(SETTINGS_V1)
 *   新增 GET /api/workshop,扫 <Steam根>/steamapps/workshop/content/394360/<数字ID>/。
 *   顺带修两个坑:模组名不再显示纯数字 ID(改用 .mod 里的 name);
 *   选到不含 interface/ 的目录时明确告警,而不是"加载了但列表空着"。
 *
 * 【C】以 .mod 文件为特征的模组识别与元信息提取(MODINFO_V1) ← 本次新增
 *   判据从"有没有 interface/"改成"**目录下有没有 .mod 文件**"。
 *   实测依据(本机 workshop/content/394360,36 个模组):
 *     - 36/36 都有 descriptor.mod,且**全部命名为 descriptor.mod**,无一例外
 *     - 29/36 含 interface/,另外 7 个只改 common/ localisation/ events/ 等
 *       → 用 interface/ 当判据会漏掉 7 个合法模组;用 .mod 当判据才准
 *     - 反过来用户自建的本地模组(放在任意目录、**没有 .mod 文件**)
 *       → 所以 .mod 是"有则更准"的强特征,不能当唯一必要条件,
 *         无 .mod 时退化为"有 interface/ 或 common/"的推断判定(inferred)
 *
 *   descriptor.mod 顶层字段实测频次(36 个模组):
 *     replace_path 745  tags 36  name 36  supported_version 36
 *     remote_file_id 36 version 34  picture 22  dependencies 15  path 9
 *
 *   **path= 是陷阱**:9 个模组写了 path=,实测值全都指向作者的机器,例如
 *     1360299796 Kaiserreich Music    path="C:/Users/mw/Documents/Paradox Interactive/..."
 *     3105210203 KR Tech Extension    path="C:/Users/sirip/OneDrive/Documents/..."
 *     创意工坊场景下这是**残留的作者本地路径**,绝不能拿来当模组根目录。
 *     故只作为"需人工确认"的信号返回(stalePath),不参与任何路径决策。
 *
 *   新增 GET /api/modinfo?dir=...  探测单个目录(设置页手填的本地模组目录用)
 *   /api/workshop 与 /api/config 均回传 gameVersion(launcher-settings.json 的 rawVersion)
 *
 * ============================ 幂等 ============================
 *   每个补丁组各自带一个标记,已含标记则整组跳过:
 *     src/model.ts       ORIENT_INHERIT_FIX
 *     public/designer.js WIKI_LAYOUT_V2
 *     src/server.ts      WIKI_LAYOUT_V3(布局) / SETTINGS_V1(创意工坊)
 *     public/open.html   SETTINGS_V1
 *     public/open.js     SETTINGS_V1
 *
 * 由用户在自己的终端运行(agent 沙箱对既有文件无写权限)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR_ARG = process.argv.find((a) => a.startsWith('--dir='));
const DIR = DIR_ARG ? DIR_ARG.slice(6) : __dirname;
const DRY = process.argv.includes('--dry');

const M_ORIENT = 'ORIENT_INHERIT_FIX';
const M_WIKI2 = 'WIKI_LAYOUT_V2';
const M_WIKI3 = 'WIKI_LAYOUT_V3';
const M_SET = 'SETTINGS_V1';

const PATCH = [
  /* ════════════════════════════════════════════════════════════════
   * A-1) src/model.ts —— orientation 继承
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'src/model.ts',
    marker: M_ORIENT,
    edits: [
      /* A-1-1) 顶部文档:纠正"不继承"的错误结论,记录实测证据 */
      {
        o:
          ' *  orientation 是否继承?wiki 说继承,实测否定:父级为 center / upper_right /\n' +
          ' *  lower_right 而子元素未写 orientation 时,子元素 x 呈小正值(0.06~0.14 倍父宽),\n' +
          ' *  按"不继承"算贴边合规率 24~45%,按"继承"算只有 0~5%。故只认元素自己写的。\n',
        n:
          ' *  orientation 是否继承?**继承**(wiki 明确,vanilla 453 文件独立复测确认)。\n' +
          ' *    "Elements will inherit the orientation of the containers they are located\n' +
          ' *     in unless the orientation is specified for the element itself."\n' +
          ' *    旧注释曾判定"不继承",该结论有误,依据如下推翻:\n' +
          ' *      1) 变量名自证:career_profile/common_components.gui 父容器\n' +
          ' *         orientation=center_up size={width=@ColumnWidth=370},子容器\n' +
          ' *         position={x=@StatContainerLeftX} size={width=@StatContainerSideW=170},\n' +
          ' *         同文件 @StatContainerLeftX=14 / @StatContainerRightX=-14 /\n' +
          ' *         @StatContainerCenterX=0。Right 取负值只有"以父中心为基准往左退"\n' +
          ' *         才成立 —— 锚点即父中心。算术:继承后 offX=0.5*370+14-0.5*170=114,\n' +
          ' *         子中心 199 = 父中心 185+14 ✓;不继承则 offX=14,子中心 99,偏 86px ✗。\n' +
          ' *      2) 父级含 right 锚点而子元素未写 orientation 的样本 601 个,其中 599 个\n' +
          ' *         连 origo / centerposition 也未写 —— 若不继承,父级 orientation 对\n' +
          ' *         子元素毫无意义,vanilla 不会成片这样写。\n' +
          ' *      3) core.gui:218-224 地面真相:orientation=upper_right + origo=upper_right,\n' +
          ' *         子元素 slider position={x=-2}、decreaseButton position={x=2}。\n' +
          ' *         这种极小偏移只在"锚点=父级右缘"时成立;按不继承算 offX=-2,\n' +
          ' *         滚动条的滑块/轨道/增减按钮会整体散架飞出屏幕。\n' +
          ' *      4) 同类样本中 32 个 position.x 为负(-1~-17),负偏移只能以右缘为基准解释。\n' +
          ' *    标记 ' + M_ORIENT + ':本次修正。\n',
      },

      /* A-1-2) GuiNode.orientation 注释纠正 + 新增继承结果字段 */
      {
        o:
          '  /** orientation:父级参照点(锚点)。空值按 upper_left 处理(实测不继承父级) */\n' +
          '  orientation?: string\n',
        n:
          '  /** orientation:父级参照点(锚点)。元素未显式写时**继承父级的 orientation** */\n' +
          '  orientation?: string\n' +
          '  /** 实际生效的 orientation = 自身值 ?? 父级继承值(再缺省按 upper_left) */\n' +
          '  effectiveOrientation?: string\n',
      },

      /* A-1-3) anchorFactors:补 CENTER_UP/CENTER_UPPER 等别名,值不变 */
      {
        o:
          '  // \'left\' 单独出现 = 左边中点\n' +
          "  if (o === 'left') return { x: 0, y: 0.5 }\n" +
          '  return { x, y }\n' +
          '}\n',
        n:
          '  // \'left\' 单独出现 = 左边中点\n' +
          "  if (o === 'left') return { x: 0, y: 0.5 }\n" +
          '  return { x, y }\n' +
          '}\n' +
          '\n' +
          '/**\n' +
          ' * 元素的"有效 orientation" = 自身显式值 ?? 父级继承值。\n' +
          ' * 依据 wiki:未指定 orientation 的元素继承所在容器的 orientation。\n' +
          ' * 父级也没有时返回 undefined,由 anchorFactors 兜底为 upper_left。\n' +
          ' */\n' +
          'function effectiveOrientation(own: string | undefined, parent: string | undefined): string | undefined {\n' +
          '  return own ?? parent\n' +
          '}\n',
      },

      /* A-1-4) resolvePositions:用父级 orientation 参与继承,并算出自身对齐点 */
      {
        o:
          '  function resolvePositions(\n' +
          '    list: GuiNode[],\n' +
          '    parentW: number,\n' +
          '    parentH: number,\n' +
          '    absX: number,\n' +
          '    absY: number,\n' +
          '  ): void {\n' +
          '    for (const n of list) {\n' +
          '      const a = anchorFactors(n.orientation)\n',
        n:
          '  function resolvePositions(\n' +
          '    list: GuiNode[],\n' +
          '    parentW: number,\n' +
          '    parentH: number,\n' +
          '    absX: number,\n' +
          '    absY: number,\n' +
          '    parentOri?: string,\n' +
          '  ): void {\n' +
          '    for (const n of list) {\n' +
          '      // orientation 继承:自身没写就用父级的(wiki 明确规定)\n' +
          '      n.effectiveOrientation = effectiveOrientation(n.orientation, parentOri)\n' +
          '      const a = anchorFactors(n.effectiveOrientation)\n' +
          '      // 自身对齐点缺省 = 生效锚点(含继承);显式 origo / centerposition 可覆盖。\n' +
          '      let alX = a.x\n' +
          '      let alY = a.y\n' +
          '      if (n.centerPosition) {\n' +
          '        alX = 0.5\n' +
          '        alY = 0.5\n' +
          '      } else if (n.origo) {\n' +
          '        const of = anchorFactors(n.origo)\n' +
          '        alX = of.x\n' +
          '        alY = of.y\n' +
          '      }\n' +
          '      n.alignX = alX\n' +
          '      n.alignY = alY\n',
      },

      /* A-1-5) resolvePositions 递归:把自己的生效 orientation 传下去 */
      {
        o:
          '      n.absX = absX + n.offX\n' +
          '      n.absY = absY + n.offY\n' +
          '      resolvePositions(n.children, n.w, n.h, n.absX, n.absY)\n',
        n:
          '      n.absX = absX + n.offX\n' +
          '      n.absY = absY + n.offY\n' +
          '      resolvePositions(n.children, n.w, n.h, n.absX, n.absY, n.effectiveOrientation)\n',
      },
    ],
  },

  /* ════════════════════════════════════════════════════════════════
   * A-2) public/designer.js —— 前端按 Wiki 校正
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'public/designer.js',
    marker: M_WIKI2,
    edits: [
      /* A-2-1) orientation 提示:区分"自己写的"与"继承父级的" */
      {
        o:
          "    if (n.orientation) {\n" +
          "      const d = ORIENT_DESC[String(n.orientation).toLowerCase()];\n" +
          "      flags.appendChild(el('span', 'flag', `· 锚点 ${n.orientation}${d ? '(' + d + ')' : ''}:position 是相对该点的偏移,不是父级左上角`));\n" +
          '    }\n',
        n:
          "    if (n.orientation) {\n" +
          "      const d = ORIENT_DESC[String(n.orientation).toLowerCase()];\n" +
          "      flags.appendChild(el('span', 'flag', `· 锚点 ${n.orientation}${d ? '(' + d + ')' : ''}:position 是相对该点的偏移,不是父级左上角`));\n" +
          '    } else if (n.effectiveOrientation) {\n' +
          "      const p = n.parent ? S.byId.get(n.parent.id) : null;\n" +
          "      const d = ORIENT_DESC[String(n.effectiveOrientation).toLowerCase()];\n" +
          "      flags.appendChild(el('span', 'flag', `· 锚点 ${n.effectiveOrientation}${d ? '(' + d + ')' : ''} —— 继承自父级${p ? ' ' + p.name : ''}(wiki:元素默认继承所在容器的 orientation)`));\n" +
          '    }\n',
      },

      /* A-2-2) orientation 下拉:补 Wiki 的 CENTER_UPPER / CENTER_LOWER 别名 */
      {
        o:
          "  const ORIENTS = ['', 'upper_left', 'upper_right', 'lower_left', 'lower_right',\n" +
          "    'center', 'center_up', 'center_down', 'center_left', 'center_right', 'center_lower', 'left'];\n",
        n:
          "  const ORIENTS = ['', 'upper_left', 'upper_right', 'lower_left', 'lower_right',\n" +
          "    'center', 'center_up', 'center_down', 'center_left', 'center_right', 'center_lower', 'left'];\n" +
          '  // Wiki 明确 CENTER_UP 可能与 CENTER_UPPER 互通、CENTER_DOWN 与 CENTER_LOWER 互通。\n' +
          '  // vanilla 实际只写了 center_lower(7 处),但手写 center_upper 时引擎同样认,\n' +
          '  // 下拉里补上别名,避免"引擎认了而设计器改不了"。\n' +
          "  ORIENTS.push('center_upper'); // " + M_WIKI2 + "\n",
      },

      /* A-2-3) 属性面板:补 Wiki 规定的容器属性 + clipping 默认值提示 */
      {
        o:
          "    box.appendChild(propSel('clipping', n.props.clipping || '', ['', 'yes', 'no']));\n" +
          "    box.appendChild(propSel('moveable', n.props.moveable || '', ['', 'yes', 'no']));\n",
        n:
          '    // Wiki:clipping 默认 true —— 面板要能区分"没写(=默认裁剪)"与"显式 no"。\n' +
          '    // 注意 propSel() 自身已返回 propRow,不能再套一层,否则行会嵌行。\n' +
          "    const clipRaw = n.props.clipping || n.props.Clipping || '';\n" +
          "    const clipCtl = sel(['', 'yes', 'no'], clipRaw);\n" +
          "    clipCtl.onchange = () => setProp('clipping', clipCtl.value);\n" +
          "    box.appendChild(propRow(clipRaw ? '裁剪 clipping' : '裁剪 clipping(缺省=默认 yes)', clipCtl));\n" +
          "    box.appendChild(propSel('moveable', n.props.moveable || '', ['', 'yes', 'no']));\n" +
          "    box.appendChild(group('Wiki 容器属性'));\n" +
          "    box.appendChild(propInput('spacing', '间距 spacing', n.props.spacing || '', false));\n" +
          "    box.appendChild(propSel('horizontal', n.props.horizontal || '', ['', 'yes', 'no']));\n" +
          "    box.appendChild(propSel('fixedsize', n.props.fixedsize || '', ['', 'yes', 'no']));\n" +
          "    box.appendChild(propSel('fullScreen', n.props.fullScreen || '', ['', 'yes', 'no']));\n" +
          "    box.appendChild(propSel('alwaysTransparent', n.props.alwaysTransparent || '', ['', 'yes', 'no']));\n",
      },

      /* A-2-4) 文本对齐 format:Wiki 规定只允许 left / center / right,改下拉 */
      {
        o:
          "    box.appendChild(propInput('format', '格式 format', n.props.format || '', false));\n",
        n:
          '    // Wiki:format 有效值只有 left / center / right。用下拉而非自由输入,\n' +
          '    // 免得写进 center_middle 这类引擎不认的值,游戏里静默按默认左对齐。\n' +
          "    const fmt = sel(['left', 'center', 'right'], (n.props.format || 'left').toLowerCase());\n" +
          "    fmt.onchange = () => setProp('format', fmt.value);\n" +
          "    box.appendChild(propRow('格式 format', fmt));\n",
      },
    ],
  },

  /* ════════════════════════════════════════════════════════════════
   * A-3) src/server.ts —— 把继承结果与对齐点下发到前端
   *   不补这组,前端拿不到 effectiveOrientation / alignX,
   *   "继承自父级"的提示永远不会显示,也无法自查对齐点算得对不对。
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'src/server.ts',
    marker: M_WIKI3,
    edits: [
      {
        o:
          "    orientation: n.orientation ?? '',\n" +
          "    origo: n.origo ?? '',\n" +
          '    centerPosition: !!n.centerPosition,\n',
        n:
          "    orientation: n.orientation ?? '',\n" +
          "    origo: n.origo ?? '',\n" +
          '    centerPosition: !!n.centerPosition,\n' +
          '    // 继承后的实际锚点:自身没写 orientation 时等于父级的值(Wiki 规定继承)。\n' +
          "    // 前端据此提示\"锚点 X —— 继承自父级\",避免误以为没写 orientation 就是左上角。\n" +
          "    effectiveOrientation: n.effectiveOrientation ?? '', // " + M_WIKI3 + "\n" +
          '    // 自身对齐点(已含 origo / centerposition 折算)。暴露出来便于自查渲染基准。\n' +
          '    alignX: n.alignX,\n' +
          '    alignY: n.alignY,\n',
      },
    ],
  },

  /* ════════════════════════════════════════════════════════════════
   * B+C-1) src/server.ts —— 创意工坊发现 + .mod 元信息提取
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'src/server.ts',
    marker: M_SET,
    edits: [
      /* B+C-1-1) 扫描代码块:插在 detectGameDirs() 之后 */
      {
        o:
          '  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))\n' +
          '  return out\n' +
          '}\n',
        n:
          '  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          '/* ── Steam 创意工坊模组发现 + .mod 元信息提取(SETTINGS_V1 / MODINFO_V1) ──\n' +
          ' *\n' +
          ' * HoI4 的 appid 是 394360,创意工坊模组解压后落在\n' +
          ' *   <Steam根>/steamapps/workshop/content/394360/<workshopItemId>/\n' +
          ' * 目录名是纯数字 ID,手填路径极难用。本函数把各 Steam 库下的该目录全扫一遍,\n' +
          ' * 读 .mod 的 name/tags/version 把 ID 翻译成模组名,并统计 .gui 数量\n' +
          ' * (用户真正在意的是"这个模组有没有改界面",而不是它有多少张贴图)。\n' +
          ' */\n' +
          'const HOI4_APPID = "394360"\n' +
          '\n' +
          '/* ── 以 .mod 文件为特征的模组识别 ──\n' +
          ' *\n' +
          ' * 判据:**目录下存在 .mod 文件即视为模组**,而不是靠"有没有 interface/"。\n' +
          ' * 依据(实测本机 workshop/content/394360 共 36 个模组):\n' +
          ' *   - 36/36 都有 descriptor.mod,且**全部命名为 descriptor.mod**,无一例外\n' +
          ' *   - 29/36 含 interface/,7 个只改 common/ localisation/ events/ 等(纯数据模组)\n' +
          ' *     → 用 interface/ 当判据会漏掉 7 个合法模组;用 .mod 当判据才准\n' +
          ' *   - 反过来,用户自建的本地模组(放在任意目录、**没有 .mod 文件**)\n' +
          ' *     → 所以 .mod 是"有则更准"的强特征,不能当唯一必要条件。\n' +
          ' *       无 .mod 时退化为"有 interface/ 或 common/"的推断判定(inferred=true)。\n' +
          ' *\n' +
          ' * descriptor.mod 顶层字段实测频次(36 个模组):\n' +
          ' *   replace_path 745  tags 36  name 36  supported_version 36\n' +
          ' *   remote_file_id 36  version 34  picture 22  dependencies 15  path 9\n' +
          ' *\n' +
          ' * **path= 是陷阱**:9 个模组写了 path=,实测值全都指向作者的机器,例如\n' +
          ' *   1360299796 Kaiserreich Musicpath="C:/Users/mw/Documents/Paradox Interactive/..."\n' +
          ' *   3105210203 KR Tech Extensionpath="C:/Users/sirip/OneDrive/Documents/..."\n' +
          ' * 创意工坊场景下这是**残留的作者本地路径**,绝不能拿来当模组根目录。\n' +
          ' * 故只作为"需人工确认"的信号返回(stalePath),不参与任何路径决策。\n' +
          ' */\n' +
          'interface ModInfo {\n' +
          '  /** 是否检到 .mod 文件 —— 模组身份的主判据 */\n' +
          '  hasModFile: boolean\n' +
          '  /** 实际读到的 .mod 文件名(descriptor.mod / 任意 *.mod) */\n' +
          '  modFile?: string\n' +
          '  /** 无 .mod 时靠目录结构推断(有 interface/ 或 common/) */\n' +
          '  inferred: boolean\n' +
          '  name: string\n' +
          '  /** 模组自身版本号 */\n' +
          '  version: string\n' +
          '  /** 游戏版本要求,如 1.19.* —— 与当前游戏版本比对得出兼容性 */\n' +
          '  supportedVersion: string\n' +
          '  /** supported_version 与当前游戏版本是否匹配 */\n' +
          '  versionOk?: boolean\n' +
          '  tags: string[]\n' +
          '  dependencies: string[]\n' +
          '  picture?: string\n' +
          '  remoteFileId?: string\n' +
          '  /** replace_path 条数 —— 反映模组改动覆盖面 */\n' +
          '  replacePathCount: number\n' +
          '  /** .mod 里写了 path= —— 创意工坊下通常是作者本机残留路径,需人工确认 */\n' +
          '  stalePath?: string\n' +
          '}\n' +
          '\n' +
          '/** 列出所有 Steam 根(含 libraryfolders.vdf 指向的额外游戏库) */\n' +
          'function allSteamRoots(): string[] {\n' +
          '  const out: string[] = []\n' +
          '  const seen = new Set<string>()\n' +
          '  const push = (raw: string) => {\n' +
          '    if (!raw) return\n' +
          '    const p = raw.replace(/\\\\/g, "/").replace(/\\/+$/, "")\n' +
          '    const k = p.toLowerCase()\n' +
          '    if (seen.has(k)) return\n' +
          '    seen.add(k)\n' +
          '    out.push(p)\n' +
          '  }\n' +
          '  for (const s of steamRoots()) {\n' +
          '    push(s)\n' +
          '    try {\n' +
          '      const vdf = readFileSync(join(s, "steamapps", "libraryfolders.vdf"), "utf8")\n' +
          '      const re = /"path"\\s+"([^"]+)"/g\n' +
          '      let mm: RegExpExecArray | null\n' +
          '      while ((mm = re.exec(vdf))) push(mm[1])\n' +
          '    } catch {\n' +
          '      /* 无 vdf:忽略 */\n' +
          '    }\n' +
          '  }\n' +
          '  // 注册表读不到时的兜底:直接探常见安装位置。\n' +
          '  // steamRoots() 内部走 reg.exe,在受限环境 / 非标准安装下会返回空,\n' +
          '  // 那时若不兜底,创意工坊列表会整个空掉且前端只显示"没找到模组",\n' +
          '  // 用户根本分不清是"没装模组"还是"没找到 Steam"。\n' +
          '  for (const d of ["C", "D", "E", "F", "G", "H"]) {\n' +
          '    push(d + ":/Program Files (x86)/Steam")\n' +
          '    push(d + ":/Program Files/Steam")\n' +
          '    push(d + ":/Steam")\n' +
          '  }\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          'interface WorkshopMod extends ModInfo {\n' +
          '  id: string\n' +
          '  path: string\n' +
          '  hasInterface: boolean\n' +
          '  guiCount: number\n' +
          '}\n' +
          '\n' +
          'let GAME_VERSION = ""\n' +
          'let GAME_VERSION_TRIED = false\n' +
          '/**\n' +
          ' * 读游戏版本(launcher-settings.json 的 rawVersion,本机实测 1.19.3.0)。\n' +
          ' * 顺序:已加载的只读 root(即基础游戏)→ 自动检测到的可用安装目录 → 默认路径。\n' +
          ' * 只读 root 排在最前,保证用户实际在编辑的那个游戏版本被读到。\n' +
          ' */\n' +
          'function readGameVersion(): string {\n' +
          '  if (GAME_VERSION_TRIED) return GAME_VERSION\n' +
          '  GAME_VERSION_TRIED = true\n' +
          '  const cands: string[] = []\n' +
          '  for (const r of ROOTS) if (!r.writable) cands.push(r.path)\n' +
          '  try {\n' +
          '    for (const c of detectGameDirs()) if (c.ok) cands.push(c.path)\n' +
          '  } catch {\n' +
          '    /* 检测失败就只用手上的 ROOTS */\n' +
          '  }\n' +
          '  cands.push(DEFAULT_GAME_DIR)\n' +
          '  const seen = new Set<string>()\n' +
          '  for (const r of cands) {\n' +
          '    const k = r.toLowerCase()\n' +
          '    if (seen.has(k)) continue\n' +
          '    seen.add(k)\n' +
          '    try {\n' +
          '      const txt = readFileSync(join(r, "launcher-settings.json"), "utf8")\n' +
          '      const m = txt.match(/"rawVersion"\\s*:\\s*"([^"]*)"/)\n' +
          '      if (m && m[1]) {\n' +
          '        GAME_VERSION = m[1].trim()\n' +
          '        return GAME_VERSION\n' +
          '      }\n' +
          '    } catch {\n' +
          '      /* 试下一个 */\n' +
          '    }\n' +
          '  }\n' +
          '  return GAME_VERSION\n' +
          '}\n' +
          '\n' +
          '/**\n' +
          ' * 通配符版本匹配:模组写 1.19.* / 1.19.3.* / 1.19.3.0,游戏是 1.19.3.0。\n' +
          ' * 逐段比较,遇 * 直接通过;pattern 段数少于 actual 时,多出来的段只在\n' +
          ' * pattern 末段是 * 才通过(否则视为不兼容,宁可提醒别静默)。\n' +
          ' */\n' +
          'function versionMatches(pattern: string, actual: string): boolean {\n' +
          '  if (!pattern || !actual) return true\n' +
          '  if (pattern === actual) return true\n' +
          '  const p = pattern.trim().split(".")\n' +
          '  const a = actual.trim().split(".")\n' +
          '  for (let i = 0; i < p.length; i++) {\n' +
          '    const ps = p[i]\n' +
          '    const as = a[i]\n' +
          '    if (ps === "*") return true\n' +
          '    if (as === undefined) return false\n' +
          '    if (ps !== as) return false\n' +
          '  }\n' +
          '  return true\n' +
          '}\n' +
          '\n' +
          '/**\n' +
          ' * 找一个目录下的 .mod 文件 —— 模组身份判据。\n' +
          ' * 优先 descriptor.mod(创意工坊 36/36 都是这个名字);\n' +
          ' * 其次取根层第一个 *.mod(自建模组常叫 <模组名>.mod)。\n' +
          ' * 只看根层,不递归 —— 避免把子模组/子目录里的 .mod 误认成主描述文件。\n' +
          ' */\n' +
          'function findModFile(dir: string): string | undefined {\n' +
          '  if (existsSync(join(dir, "descriptor.mod"))) return "descriptor.mod"\n' +
          '  try {\n' +
          '    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".mod"))\n' +
          '    // 多个 .mod 时取最短的那个:主描述文件通常最短最规范,\n' +
          '    // 子模组的名字往往是 "<主名>_<子模块>" 这种更长的一串。\n' +
          '    files.sort((a, b) => a.length - b.length)\n' +
          '    return files[0]\n' +
          '  } catch {\n' +
          '    /* 读不到目录:当作无 .mod */\n' +
          '  }\n' +
          '  return undefined\n' +
          '}\n' +
          '\n' +
          '/**\n' +
          ' * 解析 .mod,提取模组元信息。以 **.mod 文件存在** 作为模组身份判据。\n' +
          ' * 任何字段缺失都退回空串,绝不抛错 —— 扫描列表时一个坏文件不能拖垮整批。\n' +
          ' */\n' +
          'function readModInfo(dir: string): ModInfo {\n' +
          '  const out: ModInfo = {\n' +
          '    hasModFile: false,\n' +
          '    inferred: false,\n' +
          '    name: "",\n' +
          '    version: "",\n' +
          '    supportedVersion: "",\n' +
          '    tags: [],\n' +
          '    dependencies: [],\n' +
          '    replacePathCount: 0,\n' +
          '  }\n' +
          '  const mf = findModFile(dir)\n' +
          '  if (!mf) {\n' +
          '    // 无 .mod:退化为结构推断,让自建/第三方模组也能被认出来\n' +
          '    out.inferred = existsSync(join(dir, "interface")) || existsSync(join(dir, "common"))\n' +
          '    return out\n' +
          '  }\n' +
          '  out.hasModFile = true\n' +
          '  out.modFile = mf\n' +
          '  let txt = ""\n' +
          '  try {\n' +
          '    txt = readFileSync(join(dir, mf), "utf8")\n' +
          '  } catch {\n' +
          '    return out\n' +
          '  }\n' +
          '  // 每个字段都锚在行首 + 只匹配不带前缀的那个键:\n' +
          '  //   ^\\s*name 不会误吃 supported_version / remote_file_id,\n' +
          '  //   ^\\s*path 不会误吃 replace_path。\n' +
          '  const str = (re: RegExp): string => {\n' +
          '    const m = txt.match(re)\n' +
          '    return m && m[1] ? m[1].trim() : ""\n' +
          '  }\n' +
          '  out.name = str(/^[ \\t]*name[ \\t]*=[ \\t]*"([^"]*)"/m)\n' +
          '  out.version = str(/^[ \\t]*version[ \\t]*=[ \\t]*"([^"]*)"/m)\n' +
          '  out.supportedVersion = str(/^[ \\t]*supported_version[ \\t]*=[ \\t]*"([^"]*)"/m)\n' +
          '  out.picture = str(/^[ \\t]*picture[ \\t]*=[ \\t]*"([^"]*)"/m) || undefined\n' +
          '  out.remoteFileId = str(/^[ \\t]*remote_file_id[ \\t]*=[ \\t]*"([^"]*)"/m) || undefined\n' +
          '  out.stalePath = str(/^[ \\t]*path[ \\t]*=[ \\t]*"([^"]*)"/m) || undefined\n' +
          '  const tm = txt.match(/tags[ \\t]*=[ \\t]*\\{([\\s\\S]*?)\\}/)\n' +
          '  if (tm) out.tags = [...tm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean).slice(0, 6)\n' +
          '  const dm = txt.match(/dependencies[ \\t]*=[ \\t]*\\{([\\s\\S]*?)\\}/)\n' +
          '  if (dm) out.dependencies = [...dm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean).slice(0, 8)\n' +
          '  out.replacePathCount = (txt.match(/^[ \\t]*replace_path[ \\t]*=/gm) || []).length\n' +
          '  const gv = readGameVersion()\n' +
          '  if (out.supportedVersion && gv) out.versionOk = versionMatches(out.supportedVersion, gv)\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          '/** 兼容旧调用:只要 name 的轻量版 */\n' +
          'function readDescriptor(dir: string): { name: string; version: string; tags: string[] } {\n' +
          '  const m = readModInfo(dir)\n' +
          '  return { name: m.name, version: m.version, tags: m.tags }\n' +
          '}\n' +
          '\n' +
          '// ' + M_SET + '\n' +
          '\n' +
          '/** 递归数 .gui 数量。限制深度与文件数,避免超大模组把请求拖死。 */\n' +
          'function countGuiFiles(root: string, cap = 4000): number {\n' +
          '  let n = 0\n' +
          '  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]\n' +
          '  while (stack.length && n < cap) {\n' +
          '    const cur = stack.pop()!\n' +
          '    if (cur.depth > 6) continue\n' +
          '    let items: import("node:fs").Dirent[]\n' +
          '    try {\n' +
          '      items = readdirSync(cur.dir, { withFileTypes: true })\n' +
          '    } catch {\n' +
          '      continue\n' +
          '    }\n' +
          '    for (const it of items) {\n' +
          '      if (n >= cap) break\n' +
          '      if (it.isDirectory()) stack.push({ dir: join(cur.dir, it.name), depth: cur.depth + 1 })\n' +
          '      else if (it.name.toLowerCase().endsWith(".gui")) n++\n' +
          '    }\n' +
          '  }\n' +
          '  return n\n' +
          '}\n' +
          '\n' +
          '/** 把一个目录组装成 WorkshopMod —— 创意工坊与手填目录共用同一套 .mod 提取 */\n' +
          'function describeModDir(dir: string, id: string): WorkshopMod {\n' +
          '  const mi = readModInfo(dir)\n' +
          '  const hasIface = existsSync(join(dir, "interface"))\n' +
          '  return {\n' +
          '    ...mi,\n' +
          '    id,\n' +
          '    // 读不到 name 就退回 ID,总比空字符串强\n' +
          '    name: mi.name || id,\n' +
          '    path: dir,\n' +
          '    hasInterface: hasIface,\n' +
          '    guiCount: hasIface ? countGuiFiles(join(dir, "interface")) : 0,\n' +
          '  }\n' +
          '}\n' +
          '\n' +
          'function scanWorkshopMods(): { roots: string[]; mods: WorkshopMod[] } {\n' +
          '  const roots: string[] = []\n' +
          '  const mods: WorkshopMod[] = []\n' +
          '  const seenPath = new Set<string>()\n' +
          '  for (const sr of allSteamRoots()) {\n' +
          '    const wc = join(sr, "steamapps", "workshop", "content", HOI4_APPID)\n' +
          '    let ids: string[]\n' +
          '    try {\n' +
          '      ids = readdirSync(wc).filter((d) => /^\\d+$/.test(d))\n' +
          '    } catch {\n' +
          '      continue\n' +
          '    }\n' +
          '    if (!ids.length) continue\n' +
          '    roots.push(wc)\n' +
          '    for (const id of ids) {\n' +
          '      const dir = join(wc, id)\n' +
          '      const key = dir.toLowerCase()\n' +
          '      if (seenPath.has(key)) continue\n' +
          '      seenPath.add(key)\n' +
          '      mods.push(describeModDir(dir, id))\n' +
          '    }\n' +
          '  }\n' +
          '  // 排序:有界面的排前面 → 版本兼容的排前面 → .gui 数量降序。\n' +
          '  // 用户一般只关心改过界面且当前游戏版本能跑的模组。\n' +
          '  mods.sort(\n' +
          '    (a, b) =>\n' +
          '      (a.hasInterface === b.hasInterface ? 0 : a.hasInterface ? -1 : 1) ||\n' +
          '      (a.versionOk === b.versionOk ? 0 : a.versionOk ? -1 : 1) ||\n' +
          '      b.guiCount - a.guiCount,\n' +
          '  )\n' +
          '  return { roots, mods }\n' +
          '}\n',
      },

      /* B+C-1-2) 路由:/api/workshop 与 /api/modinfo */
      {
        o:
          "    if (p === '/api/detect') {\n",
        n:
          "    if (p === '/api/workshop') {\n" +
          '      try {\n' +
          '        const { roots, mods } = scanWorkshopMods()\n' +
          '        // gameVersion 一并回传,前端才能判断 supported_version 匹不匹配\n' +
          '        return send(\n' +
          '          res,\n' +
          '          200,\n' +
          '          JSON.stringify({ appid: HOI4_APPID, gameVersion: readGameVersion(), roots, mods }),\n' +
          '        )\n' +
          '      } catch (e) {\n' +
          '        return send(res, 500, JSON.stringify({ error: String(e) }))\n' +
          '      }\n' +
          '    }\n' +
          '    if (p === \'/api/modinfo\') {\n' +
          '      // 单目录探测:设置页手填的本地模组目录用它显示名称 / 版本 / 兼容性。\n' +
          '      // 支持重复 ?dir= 一次探测多个(前端一次请求问完所有手填行)。\n' +
          '      try {\n' +
          '        const dirs = url.searchParams.getAll(\'dir\').filter((d) => d.trim())\n' +
          '        const out = dirs.map((d) => {\n' +
          '          const dir = d.trim().replace(/\\\\/g, "/").replace(/\\/+$/, "")\n' +
          '          if (!existsSync(dir)) return { path: dir, exists: false }\n' +
          '          try {\n' +
          '            if (!statSync(dir).isDirectory()) return { path: dir, exists: false, notDir: true }\n' +
          '          } catch {\n' +
          '            return { path: dir, exists: false }\n' +
          '          }\n' +
          '          return { exists: true, ...describeModDir(dir, basename(dir)) }\n' +
          '        })\n' +
          '        return send(res, 200, JSON.stringify({ gameVersion: readGameVersion(), mods: out }))\n' +
          '      } catch (e) {\n' +
          '        return send(res, 500, JSON.stringify({ error: String(e) }))\n' +
          '      }\n' +
          '    }\n' +
          "    if (p === '/api/detect') {\n",
      },

      /* B-1-3) mod 目录校验:点名没有 interface/ 的目录 */
      {
        o:
          '          for (const m of mods) {\n' +
          '            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))\n' +
          '          }\n',
        n:
          '          for (const m of mods) {\n' +
          '            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))\n' +
          '          }\n' +
          '          // 不阻断,但在响应里点名没有 interface/ 的目录 ——\n' +
          '          // 否则表现为"模组已加载但文件列表里什么都没有",很难自查。\n' +
          '          // ' + M_SET + '\n' +
          '          const noIface = mods.filter((m) => !existsSync(join(m, "interface")))\n',
      },

      /* B-1-4) 响应里回传告警 */
      {
        o:
          "          return send(res, 200, JSON.stringify({ ok: true, roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })) }))\n",
        n:
          '          return send(\n' +
          '            res,\n' +
          '            200,\n' +
          '            JSON.stringify({\n' +
          '              ok: true,\n' +
          '              roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })),\n' +
          '              warnNoInterface: noIface,\n' +
          '            }),\n' +
          '          )\n',
      },

      /* B-1-5) 模组显示名优先用 .mod 里的 name,而不是纯数字目录名。
             load 时把 name 写进 Root.name,前端 sources 下拉就能显示人话。 */
      {
        o:
          "          for (const m of mods) roots.push({ name: basename(m), path: m, writable: true })\n",
        n:
          "          for (const m of mods) {\n" +
          "            // 目录名常是 workshop 数字 ID,直接当来源名很难认;\n" +
          "            // 读 .mod 的 name 更好。读不到才回退 basename(路径)。\n" +
          '            const d = readDescriptor(m)\n' +
          "            roots.push({ name: d.name || basename(m), path: m, writable: true })\n" +
          '          }\n',
      },

      /* C-1-6) /api/config 带上游戏版本(设置页一进来就能显示) */
      {
        o:
          "        JSON.stringify({ roots: ROOTS.map((r) => ({ name: r.name, writable: r.writable })), readonly: READONLY }),\n",
        n:
          '        // gameVersion:设置页要显示"当前游戏版本",并据此判断模组 supported_version\n' +
          '        JSON.stringify({\n' +
          '          roots: ROOTS.map((r) => ({ name: r.name, writable: r.writable })),\n' +
          '          readonly: READONLY,\n' +
          '          gameVersion: readGameVersion(),\n' +
          '        }),\n',
      },
    ],
  },

  /* ════════════════════════════════════════════════════════════════
   * B+C-2) public/open.html —— 创意工坊区块 + 本地模组 + 选项
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'public/open.html',
    marker: M_SET,
    edits: [
      /* C-2-0) 样式:创意工坊列表 + 兼容性徽章 + .mod 探测结果 */
      {
        o:
          '  .opt-row input{width:auto;accent-color:#2f6df0}\n',
        n:
          '  .opt-row input{width:auto;accent-color:#2f6df0}\n' +
          '  /* ' + M_SET + ' */\n' +
          '  #wsList{margin-top:10px;max-height:340px;overflow:auto;border:1px solid #262f3c;border-radius:8px;background:#10161e}\n' +
          '  #wsList:empty{display:none}\n' +
          '  .ws-item{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-bottom:1px solid #1e2733;cursor:pointer;font-size:12px}\n' +
          '  .ws-item:last-child{border-bottom:0}\n' +
          '  .ws-item:hover{background:#151d27}\n' +
          '  .ws-item input{width:auto;flex:none;margin-top:2px;accent-color:#2f8f5b}\n' +
          '  .ws-main{flex:1;min-width:0}\n' +
          '  .ws-name{color:#d3dee9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
          '  .ws-meta{color:#76859a;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
          '  .ws-meta .bad{color:#e6a04b}\n' +
          '  .ws-meta .good{color:#6cd39a}\n' +
          '  .ws-meta .dim{color:#5d6b7d}\n' +
          '  .ws-badges{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px}\n' +
          '  .ws-gui{font-size:11px;padding:1px 6px;border-radius:4px;background:#1e3a2a;color:#6cd39a;white-space:nowrap}\n' +
          '  .ws-gui.none{background:#2a2f36;color:#6b7787}\n' +
          '  .ws-ver{font-size:10px;padding:1px 5px;border-radius:4px;background:#1e3a2a;color:#6cd39a}\n' +
          '  .ws-ver.bad{background:#3a2a1e;color:#e6a04b}\n' +
          '  .ws-ver.inf{background:#1a2432;color:#7d94ad}\n' +
          '  .ws-tags{margin-top:3px;display:flex;gap:4px;flex-wrap:wrap}\n' +
          '  .ws-tag{font-size:10px;padding:0 5px;border-radius:4px;background:#1a2432;color:#7d94ad}\n' +
          '  .ws-stale{font-size:10px;padding:0 5px;border-radius:4px;background:#33272a;color:#c98d95}\n' +
          '  #modList .modrow{flex-wrap:wrap}\n' +
          '  .modprobe{flex-basis:100%;font-size:11px;line-height:1.55;color:#76859a;padding:3px 0 0}\n' +
          '  .modprobe b{color:#9fb3c8;font-weight:600}\n' +
          '  .modprobe .good{color:#6cd39a}\n' +
          '  .modprobe .bad{color:#e6a04b}\n' +
          '  .modprobe .err{color:#ff7a7a}\n' +
          '  #gameVer{color:#6fa8e0}\n',
      },

      /* B+C-2-1) 区块:创意工坊 / 本地模组 / 选项 */
      {
        o:
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>模组目录<span class="tag opt">可选 · 可多个</span></h2>\n' +
          '      <div id="modList"></div>\n' +
          '      <button id="addMod" class="mini" style="margin-top:9px">＋ 添加模组目录</button>\n' +
          '      <div class="hint">留空则以只读方式浏览游戏本体。多个模组按顺序加载，后者在同名文件上覆盖前者；只有模组目录允许写入。</div>\n' +
          '    </div>\n',
        n:
          '    <!-- ' + M_SET + ' -->\n' +
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>创意工坊模组<span class="tag opt">自动发现</span></h2>\n' +
          '      <div class="row">\n' +
          '        <button id="scanWs" class="mini">扫描 Steam 创意工坊</button>\n' +
          '        <input type="text" id="wsFilter" placeholder="按名称 / ID / 标签过滤…" style="flex:1;min-width:0">\n' +
          '      </div>\n' +
          '      <div class="hint" id="wsInfo">扫描 <code>workshop/content/394360/</code>（HoI4 的 App ID）。每个模组以目录下的 <code>.mod</code> 文件为识别特征，解析出名称、版本、标签、依赖与 <code>replace_path</code> 条数，并对照游戏版本 <span id="gameVer">—</span> 标出兼容性。勾选即加入加载列表。</div>\n' +
          '      <div id="wsList"></div>\n' +
          '      <div class="row">\n' +
          '        <button id="wsAll" class="mini">全选有界面的</button>\n' +
          '        <button id="wsNone" class="mini">清空勾选</button>\n' +
          '      </div>\n' +
          '    </div>\n' +
          '\n' +
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>本地模组目录<span class="tag opt">手动添加 · 自动识别</span></h2>\n' +
          '      <div id="modList"></div>\n' +
          '      <button id="addMod" class="mini" style="margin-top:9px">＋ 添加模组目录</button>\n' +
          '      <div class="hint">创意工坊里没有的模组（自己开发、网盘下载）在这里填。填完自动读取该目录下的 <code>.mod</code>（优先 <code>descriptor.mod</code>）显示名称与版本；没有 <code>.mod</code> 就按目录结构推断。可添加多行、改路径、点「移除」删除。多个模组按顺序加载，后者在同名文件上覆盖前者；只有模组目录允许写入。</div>\n' +
          '    </div>\n' +
          '\n' +
          '    <div class="grp">\n' +
          '      <h2>选项</h2>\n' +
          '      <label class="opt-row"><input type="checkbox" id="hideNoGui"> 创意工坊列表里隐藏没有 .gui 的模组</label>\n' +
          '      <label class="opt-row"><input type="checkbox" id="onlyNoIface"> 只显示改过界面的模组（推荐）</label>\n' +
          '    </div>\n',
      },
    ],
  },

  /* ════════════════════════════════════════════════════════════════
   * B+C-3) public/open.js —— 渲染 .mod 元信息 + 手填目录探测
   * ════════════════════════════════════════════════════════════════ */
  {
    file: 'public/open.js',
    marker: M_SET,
    edits: [
      /* C-3-1) 声明新元素 */
      {
        o:
          "  var autoEl = document.getElementById('autoload');\n",
        n:
          "  var autoEl = document.getElementById('autoload');\n" +
          "  var wsListEl = document.getElementById('wsList');\n" +
          "  var wsInfoEl = document.getElementById('wsInfo');\n" +
          "  var wsFilterEl = document.getElementById('wsFilter');\n" +
          "  var hideNoGuiEl = document.getElementById('hideNoGui');\n" +
          "  var onlyNoIfaceEl = document.getElementById('onlyNoIface');\n" +
          "  var gameVerEl = document.getElementById('gameVer');\n" +
          '  // wsMods 存扫描到的创意工坊模组;wsPicked 存已勾选的 id(跨扫描保留)\n' +
          '  var wsMods = [];\n' +
          '  var gameVer = "";\n' +
          "  var wsPicked = loadPicked(); // " + M_SET + "\n",
      },

      /* C-3-2) addModRow:每个手填行下面挂一个 .mod 探测结果条 */
      {
        o:
          "    row.appendChild(inp);\n" +
          "    row.appendChild(del);\n" +
          '    modList.appendChild(row);\n' +
          '    inp.oninput = syncMods;\n' +
          '    return inp;\n',
        n:
          "    var probe = document.createElement('div');\n" +
          "    probe.className = 'modprobe';\n" +
          "    row.appendChild(inp);\n" +
          "    row.appendChild(del);\n" +
          '    row.appendChild(probe);\n' +
          '    modList.appendChild(row);\n' +
          '    inp.oninput = function () { syncMods(); probeMods(); };\n' +
          '    return inp;\n',
      },

      /* B+C-3-3) 勾选状态的读写 + 本地目录 .mod 探测 */
      {
        o:
          '  function syncMods() {\n' +
          "    mods = [].slice.call(modList.querySelectorAll('input')).map(function (i) { return i.value.trim(); }).filter(Boolean);\n" +
          '  }\n',
        n:
          '  function loadPicked() {\n' +
          "    var raw = get('gui.wsPicked');\n" +
          '    if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e) {} }\n' +
          '    return [];\n' +
          '  }\n' +
          '  function savePicked() { set("gui.wsPicked", JSON.stringify(wsPicked)); }\n' +
          '  /* ── 本地模组目录的 .mod 探测 ──\n' +
          '   * 一律用后到的响应覆盖每一行:手填路径改动频繁,按行序号对齐即可,\n' +
          '   * 不需要为每行单独发请求(避免连打 N 次)。 */\n' +
          '  var probeSeq = 0;\n' +
          '  function probeMods() {\n' +
          '    var rows = [].slice.call(modList.querySelectorAll(".modrow"));\n' +
          '    var dirs = rows.map(function (r) { return r.querySelector("input").value.trim(); });\n' +
          '    var need = dirs.map(function (d, i) { return d ? i : -1; }).filter(function (i) { return i >= 0; });\n' +
          '    if (!need.length) return;\n' +
          '    var seq = ++probeSeq;\n' +
          '    var qs = need.map(function (i) { return "dir=" + encodeURIComponent(dirs[i]); }).join("&");\n' +
          '    fetch("/api/modinfo?" + qs).then(function (r) { return r.json(); }).then(function (j) {\n' +
          '      if (seq !== probeSeq) return; // 已有更新的请求,丢弃这次结果\n' +
          '      if (j.gameVersion) setGameVer(j.gameVersion);\n' +
          '      var res = j.mods || [];\n' +
          '      need.forEach(function (rowIdx, k) {\n' +
          '        var cell = rows[rowIdx].querySelector(".modprobe");\n' +
          '        if (!cell) return;\n' +
          '        cell.innerHTML = "";\n' +
          '        var m = res[k];\n' +
          '        if (!m) return;\n' +
          '        if (!m.exists) {\n' +
          '          cell.innerHTML = m.notDir\n' +
          '            ? \'<span class="err">不是目录</span> \' + esc(m.path)\n' +
          '            : \'<span class="err">目录不存在</span> \' + esc(m.path);\n' +
          '          return;\n' +
          '        }\n' +
          '        var bits = [];\n' +
          '        if (m.hasModFile) {\n' +
          '          bits.push(\'<span class="good">\' + esc(m.modFile) + "</span>");\n' +
          '        } else if (m.inferred) {\n' +
          '          bits.push(\'<span class="dim">无 .mod,按目录结构识别</span>\');\n' +
          '        } else {\n' +
          '          bits.push(\'<span class="bad">未识别为模组(既无 .mod,也无 interface/ 或 common/)</span>\');\n' +
          '        }\n' +
          '        if (m.name) bits.push("<b>" + esc(m.name) + "</b>");\n' +
          '        if (m.version) bits.push("v" + esc(m.version));\n' +
          '        if (m.supportedVersion) {\n' +
          '          var okc = m.versionOk === true ? "good" : m.versionOk === false ? "bad" : "dim";\n' +
          '          var okt = m.versionOk === true ? "匹配" : m.versionOk === false ? "不匹配当前版本" : "";\n' +
          '          bits.push(\'<span class="\' + okc + \'">要求 \' + esc(m.supportedVersion) + (okt ? " · " + okt : "") + "</span>");\n' +
          '        }\n' +
          '        if (m.dependencies && m.dependencies.length) bits.push("依赖 " + esc(m.dependencies.join("、")));\n' +
          '        if (m.replacePathCount) bits.push(m.replacePathCount + " 条 replace_path");\n' +
          '        bits.push(m.hasInterface ? (m.guiCount + " 个 .gui") : "无 interface/");\n' +
          '        if (m.stalePath) {\n' +
          '          bits.push(\'<span class="bad" title=".mod 里的 path= 指向作者本机,不作为模组目录使用">\' + "含残留 path=,已忽略</span>");\n' +
          '        }\n' +
          '        cell.innerHTML = bits.join(" · ");\n' +
          '      });\n' +
          '    }).catch(function () { /* 探测失败不打扰用户,路径照常能加载 */ });\n' +
          '  }\n' +
          '  function esc(s) {\n' +
          "    return String(s == null ? '' : s).replace(/[&<>\\\"]/g, function (c) {\n" +
          "      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\\\"': '&quot;' }[c];\n" +
          '    });\n' +
          '  }\n' +
          '  function setGameVer(v) {\n' +
          '    if (!v || v === gameVer) return;\n' +
          '    gameVer = v;\n' +
          '    if (gameVerEl) gameVerEl.textContent = v;\n' +
          '  }\n' +
          '\n' +
          '  function syncMods() {\n' +
          '    var manual = [].slice.call(modList.querySelectorAll(".modrow input")).map(function (i) { return i.value.trim(); }).filter(Boolean);\n' +
          '    // 勾选的创意工坊模组排在手动填的前面:后者通常是本地开发目录,\n' +
          '    // 放后面才能覆盖创意工坊版本(后加载的覆盖先加载的同路径文件)。\n' +
          '    var ws = wsMods.filter(function (m) { return wsPicked.indexOf(m.id) >= 0; }).map(function (m) { return m.path; });\n' +
          '    mods = ws.concat(manual);\n' +
          '  }\n',
      },

      /* B+C-3-4) 创意工坊渲染(带版本兼容徽章 + .mod 依据)+ 扫描 + 探测触发 */
      {
        o:
          "  document.getElementById('addMod').onclick = function () {\n",
        n:
          '  /* ── 创意工坊模组列表 ── */\n' +
          '  function renderWs() {\n' +
          "    var q = (wsFilterEl.value || '').trim().toLowerCase();\n" +
          '    wsListEl.innerHTML = "";\n' +
          '    var shown = 0;\n' +
          '    wsMods.forEach(function (m) {\n' +
          '      if (hideNoGuiEl.checked && !m.guiCount) return;\n' +
          "      if (onlyNoIfaceEl.checked && !m.hasInterface) return;\n" +
          '      if (q) {\n' +
          '        var hay = [m.name, m.id].concat(m.tags || []).concat(m.dependencies || []).join(" ").toLowerCase();\n' +
          '        if (hay.indexOf(q) < 0) return;\n' +
          '      }\n' +
          '      shown++;\n' +
          '      var row = document.createElement("label");\n' +
          '      row.className = "ws-item";\n' +
          '      row.title = m.path;\n' +
          '      var cb = document.createElement("input");\n' +
          '      cb.type = "checkbox";\n' +
          '      cb.checked = wsPicked.indexOf(m.id) >= 0;\n' +
          '      cb.onchange = function () {\n' +
          '        var i = wsPicked.indexOf(m.id);\n' +
          '        if (cb.checked) { if (i < 0) wsPicked.push(m.id); }\n' +
          '        else if (i >= 0) wsPicked.splice(i, 1);\n' +
          '        savePicked();\n' +
          '        syncMods();\n' +
          '      };\n' +
          '      var main = document.createElement("div");\n' +
          '      main.className = "ws-main";\n' +
          '      var nm = document.createElement("div");\n' +
          '      nm.className = "ws-name";\n' +
          '      nm.textContent = m.name;\n' +
          '      /* 元信息一行说清三件事:身份判据(.mod)、版本、兼容性 */\n' +
          '      var meta = document.createElement("div");\n' +
          '      meta.className = "ws-meta";\n' +
          '      var mb = [];\n' +
          '      mb.push("ID " + m.id);\n' +
          '      if (m.version) mb.push("v" + m.version);\n' +
          '      if (m.hasModFile) {\n' +
          '        mb.push(\'<span class="dim">\' + m.modFile + "</span>");\n' +
          '      } else {\n' +
          '        mb.push(\'<span class="bad">无 .mod\' + (m.inferred ? "(结构推断)" : "") + "</span>");\n' +
          '      }\n' +
          '      if (m.replacePathCount) mb.push(m.replacePathCount + " replace_path");\n' +
          '      if (m.dependencies && m.dependencies.length) mb.push("依赖 " + m.dependencies.length);\n' +
          '      meta.innerHTML = mb.join(" · ");\n' +
          '      main.appendChild(nm);\n' +
          '      main.appendChild(meta);\n' +
          '      if (m.tags && m.tags.length) {\n' +
          '        var tw = document.createElement("div");\n' +
          '        tw.className = "ws-tags";\n' +
          '        m.tags.slice(0, 4).forEach(function (t) {\n' +
          '          var s = document.createElement("span");\n' +
          '          s.className = "ws-tag";\n' +
          '          s.textContent = t;\n' +
          '          tw.appendChild(s);\n' +
          '        });\n' +
          '        if (m.stalePath) {\n' +
          '          var sp = document.createElement("span");\n' +
          '          sp.className = "ws-stale";\n' +
          '          sp.textContent = "含残留 path=";\n' +
          '          sp.title = ".mod 里的 path= 指向作者本机(" + m.stalePath + "),已忽略,不作为模组目录";\n' +
          '          tw.appendChild(sp);\n' +
          '        }\n' +
          '        main.appendChild(tw);\n' +
          '      } else if (m.stalePath) {\n' +
          '        var tw2 = document.createElement("div");\n' +
          '        tw2.className = "ws-tags";\n' +
          '        var sp2 = document.createElement("span");\n' +
          '        sp2.className = "ws-stale";\n' +
          '        sp2.textContent = "含残留 path=";\n' +
          '        sp2.title = ".mod 里的 path= 指向作者本机(" + m.stalePath + "),已忽略,不作为模组目录";\n' +
          '        tw2.appendChild(sp2);\n' +
          '        main.appendChild(tw2);\n' +
          '      }\n' +
          '      var badges = document.createElement("span");\n' +
          '      badges.className = "ws-badges";\n' +
          '      /* 版本兼容徽章:supported_version 与当前游戏版本比对的结果 */\n' +
          '      if (m.supportedVersion) {\n' +
          '        var vb = document.createElement("span");\n' +
          '        if (m.versionOk === true) { vb.className = "ws-ver"; vb.textContent = "✓ " + m.supportedVersion; }\n' +
          '        else if (m.versionOk === false) {\n' +
          '          vb.className = "ws-ver bad";\n' +
          '          vb.textContent = "✗ 需 " + m.supportedVersion;\n' +
          '          vb.title = ".mod 要求游戏版本 " + m.supportedVersion + ",当前 " + (gameVer || "未知") + " —— 可能无法正常运行";\n' +
          '        } else { vb.className = "ws-ver inf"; vb.textContent = m.supportedVersion; }\n' +
          '        badges.appendChild(vb);\n' +
          '      }\n' +
          '      var g = document.createElement("span");\n' +
          '      g.className = "ws-gui" + (m.guiCount ? "" : " none");\n' +
          '      g.textContent = m.guiCount ? m.guiCount + " .gui" : "无界面";\n' +
          '      badges.appendChild(g);\n' +
          '      row.appendChild(cb);\n' +
          '      row.appendChild(main);\n' +
          '      row.appendChild(badges);\n' +
          '      wsListEl.appendChild(row);\n' +
          '    });\n' +
          '    syncMods();\n' +
          '  }\n' +
          '\n' +
          "  document.getElementById('scanWs').onclick = function () {\n" +
          "    setStatus('正在扫描 Steam 创意工坊…', '');\n" +
          "    fetch('/api/workshop').then(function (r) { return r.json(); }).then(function (j) {\n" +
          '      if (j.error) throw new Error(j.error);\n' +
          '      if (j.gameVersion) setGameVer(j.gameVersion);\n' +
          '      wsMods = j.mods || [];\n' +
          '      var nIface = wsMods.filter(function (m) { return m.hasInterface; }).length;\n' +
          '      // 以 .mod 为判据:有 .mod 的才算正规模组,其余标为结构推断\n' +
          '      var nMod = wsMods.filter(function (m) { return m.hasModFile; }).length;\n' +
          '      var nNo = wsMods.filter(function (m) { return !m.hasModFile && !m.inferred; }).length;\n' +
          '      var nBad = wsMods.filter(function (m) { return m.versionOk === false; }).length;\n' +
          '      if (!wsMods.length) {\n' +
          "        wsInfoEl.textContent = '未找到创意工坊模组。请确认 Steam 已安装该游戏，或创意工坊目录非默认位置。';\n" +
          "        setStatus('创意工坊目录为空。可用下方「本地模组目录」手动添加。', 'warn');\n" +
          '        renderWs();\n' +
          '        return;\n' +
          '      }\n' +
          '      wsInfoEl.textContent = "找到 " + wsMods.length + " 个模组：" + nMod + " 个含 .mod 描述文件，"\n' +
          '        + nIface + " 个改过界面(.gui)。"\n' +
          '        + (gameVer ? "当前游戏版本 " + gameVer + "，" : "")\n' +
          '        + (nBad ? "其中 " + nBad + " 个版本要求不符。" : "")\n' +
          '        + (nNo ? " " + nNo + " 个既无 .mod 也无常见目录，可能不是模组。" : "")\n' +
          '        + "勾选要加载的模组。";\n' +
          '      setStatus("创意工坊：" + wsMods.length + " 个模组可选。", "ok");\n' +
          '      renderWs();\n' +
          '    }).catch(function (e) {\n' +
          "      setStatus('扫描失败：' + e.message, 'warn');\n" +
          '    });\n' +
          '  };\n' +
          '\n' +
          "  document.getElementById('wsAll').onclick = function () {\n" +
          '    wsMods.forEach(function (m) { if (m.hasInterface && wsPicked.indexOf(m.id) < 0) wsPicked.push(m.id); });\n' +
          '    savePicked();\n' +
          '    renderWs();\n' +
          '    setStatus("已全选有界面的模组，记得点「保存并进入工作台」生效。", "ok");\n' +
          '  };\n' +
          '\n' +
          "  document.getElementById('wsNone').onclick = function () {\n" +
          '    wsPicked = [];\n' +
          '    savePicked();\n' +
          '    renderWs();\n' +
          '  };\n' +
          '\n' +
          '  if (wsFilterEl) wsFilterEl.oninput = renderWs;\n' +
          '  if (hideNoGuiEl) {\n' +
          "    hideNoGuiEl.checked = get('gui.hideNoGui') === '1';\n" +
          '    hideNoGuiEl.onchange = function () { set("gui.hideNoGui", hideNoGuiEl.checked ? "1" : null); renderWs(); };\n' +
          '  }\n' +
          '  if (onlyNoIfaceEl) {\n' +
          "    onlyNoIfaceEl.checked = get('gui.onlyNoIface') !== '0';\n" +
          '    onlyNoIfaceEl.onchange = function () { set("gui.onlyNoIface", onlyNoIfaceEl.checked ? "1" : "0"); renderWs(); };\n' +
          '  }\n' +
          '  probeMods(); // 页面一进来就把上次填的模组目录探测一遍\n' +
          '\n' +
          "  document.getElementById('addMod').onclick = function () {\n",
      },

      /* B-3-5) 加载结果里提示"没 interface/ 的目录" */
      {
        o:
          "        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +\n" +
          "          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');\n",
        n:
          "        warn += (res.j.warnNoInterface || []).length\n" +
          "          ? ' 以下目录没有 interface/，可能选错了：' + res.j.warnNoInterface.join('、')\n" +
          "          : '';\n" +
          "        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +\n" +
          "          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');\n",
      },

      /* C-3-6) /api/config 顺手把游戏版本显示出来 */
      {
        o:
          "  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {\n" +
          "    curEl.textContent = '当前已加载：' + cfg.roots.map(tag).join('  ·  ');\n",
        n:
          "  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {\n" +
          "    if (cfg.gameVersion) setGameVer(cfg.gameVersion);\n" +
          "    curEl.textContent = '当前已加载：' + cfg.roots.map(tag).join('  ·  ')\n" +
          "      + (gameVer ? '　游戏版本 ' + gameVer : '');\n",
      },
    ],
  },
];

/* ── 主流程 ── */
let ok = true;
for (const grp of PATCH) {
  const fp = path.join(DIR, grp.file);
  let content;
  try {
    content = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    console.log('[X] file not found: ' + grp.file + '  (' + e.message + ')');
    ok = false;
    continue;
  }
  if (content.includes(grp.marker)) {
    console.log('[-] already patched, skipping: ' + grp.file + '  [' + grp.marker + ']');
    continue;
  }

  let next = content;
  let groupOk = true;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '[X] anchor not found in ' + grp.file + ' (matched ' + (parts.length - 1) +
          ', need exactly 1). Snippet: ' +
          ed.o.slice(0, 70).replace(/\n/g, '\\n'),
      );
      ok = false;
      groupOk = false;
      break;
    }
    next = next.split(ed.o).join(ed.n);
  }
  if (!groupOk) continue;

  if (DRY) {
    console.log('[OK] dry-run passed: ' + grp.file + '  (' + grp.edits.length + ' edits, marker ' + grp.marker + ')');
  } else {
    fs.writeFileSync(fp, next, 'utf8');
    console.log('[OK] applied: ' + grp.file + '  (' + grp.edits.length + ' edits, marker ' + grp.marker + ')');
  }
}

if (!ok) {
  console.log('\nAnchor mismatch detected. Nothing was written.');
  process.exit(1);
}
console.log(
  '\n' +
    (DRY
      ? 'DRY-RUN done: all anchors matched. Re-run without --dry to apply.'
      : 'Done. Restart run-gui.bat to pick up the changes.'),
);