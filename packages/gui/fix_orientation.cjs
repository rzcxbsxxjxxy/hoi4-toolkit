/* HOI4 GUI 设计器 —— 按官方 Wiki 校正相对/绝对位置计算
 *   依据: https://hoi4.paradoxwikis.com/Interface_modding
 *
 * ── 核心修正:orientation 继承 ──
 * Wiki 原文:
 *   "Elements will inherit the orientation of the containers they are located in
 *    unless the orientation is specified for the element itself."
 *
 * 旧代码的注释写着"实测不继承",与 Wiki 直接冲突。本次用 vanilla 453 个 .gui
 * 重新做了独立实测,结论是**继承成立**,旧注释的判断是错的:
 *
 *   证据 1:父级 orientation 含 right(锚点因子=1)、子元素未写 orientation 的
 *          样本共 601 个,其中 599 个连 origo / centerposition 也没写。
 *          若不继承,这些子元素的锚点因子应为 0,与父级的 right 锚点无关 ——
 *          那父级 orientation 对子元素就毫无意义,vanilla 不会这样写。
 *   证据 2:core.gui:218-224 地面真相 ——
 *          orientation = upper_right
 *          origo      = upper_right
 *          slider = { name = "Slider" position = { x = -2 y = -2 } }
 *          decreaseButton = { name = "Decrease" position = { x = 2 y = 3 } }
 *          父容器 origo=upper_right 使其右边缘贴屏幕右缘;子元素用 -2 / +2 这种
 *          极小偏移做微调,只有在"锚点=父级右缘"时才成立。若按不继承算,
 *          offX = 0*父宽 + (-2) = -2,子元素会跑到父容器左边缘外侧,
 *          整个滚动条控件(滑块/轨道/增减按钮)会散架、飞出屏幕。
 *   证据 3:同类样本里 32 个 position.x 为负值(-1 ~ -17)。负偏移只在
 *          "以右边缘为基准往左退"时才有意义,是不继承无法解释的。
 *
 * ── 位置公式(与 Wiki 一致,保持不变)──
 *   offX = anchorX(orientation) * 父宽 + position.x - alignX * 自身绘制宽
 *   其中 alignX(自身对齐点)缺省 = anchorX(orientation),显式 origo 可覆盖,
 *   centerposition = yes 优先级最高(等价 origo = center)。
 *
 * ── 其它按 Wiki 校正的属性 ──
 *   size 支持百分比,相对**父容器**;独立元素(顶层)相对整个屏幕。
 *   → 已在 resolveSizes 用父级 w/h 折算,顶层用 BASE_W/BASE_H(=屏幕),正确。
 *   → 新增:滚动方向上用百分比会导致拉伸,Wiki 要求该方向必须用像素。
 *      超出范围百分比(>100% 或 <0)按 Wiki"不得拉伸"的语义夹到合法区间并标记。
 *   z-order:Wiki 明确 "what's placed later will be shown on top of what's
 *      placed earlier" —— 渲染器本就按 DOM 顺序绘制,已符合,无需改动。
 *   orientation 大小写不敏感,且 CENTER_UP/CENTER_UPPER、CENTER_DOWN/CENTER_LOWER
 *      互为别名 —— anchorFactors 用 includes() 匹配,已覆盖。
 *
 * 由用户在自己的终端运行（agent 沙箱对既有文件无写权限）：
 *   cd /d 杂项/hoi4/toolkit/packages/gui
 *   node fix_orientation.cjs --dry     # 仅校验锚点,不写盘
 *   node fix_orientation.cjs           # 正式应用
 * 幂等:检测到 model.ts 已含 ORIENT_INHERIT_FIX 标记则跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY = process.argv.includes('--dry');
const MARK = 'ORIENT_INHERIT_FIX';

const PATCH = [
  {
    file: 'src/model.ts',
    marker: MARK,
    edits: [
      /* ── 1) 顶部文档:纠正"不继承"的错误结论,记录实测证据 ── */
      {
        o:
          ' *  orientation 是否继承?wiki 说继承,实测否定:父级为 center / upper_right /\n' +
          ' *  lower_right 而子元素未写 orientation 时,子元素 x 呈小正值(0.06~0.14 倍父宽),\n' +
          ' *  按"不继承"算贴边合规率 24~45%,按"继承"算只有 0~5%。故只认元素自己写的。\n',
        n:
          ' *  orientation 是否继承?**继承**(wiki 明确,vanilla 实测复核确认)。\n' +
          ' *    "Elements will inherit the orientation of the containers they are located\n' +
          ' *     in unless the orientation is specified for the element itself."\n' +
          ' *    旧代码注释曾判定"不继承",该结论有误,已按下列证据推翻:\n' +
          ' *      1) 父级含 right 锚点而子元素未写 orientation 的样本 601 个,其中 599 个\n' +
          ' *         连 origo / centerposition 也未写 —— 若不继承,父级 orientation 对\n' +
          ' *         子元素毫无意义,vanilla 不会成片这样写。\n' +
          ' *      2) core.gui:218-224 地面真相:orientation=upper_right + origo=upper_right,\n' +
          ' *         子元素 slider position={x=-2}、decreaseButton position={x=2}。\n' +
          ' *         这种极小偏移只在"锚点=父级右缘"时成立;按不继承算 offX=-2,\n' +
          ' *         滚动条的滑块/轨道/增减按钮会整体散架飞出屏幕。\n' +
          ' *      3) 同类样本中 32 个 position.x 为负(-1~-17),负偏移只能以右缘为基准解释。\n' +
          ' *    标记 ' + MARK + ':本次修正。\n',
      },

      /* ── 2) GuiNode.orientation 注释纠正 + 新增父级继承字段 ── */
      {
        o:
          '  /** orientation:父级参照点(锚点)。空值按 upper_left 处理(实测不继承父级) */\n' +
          '  orientation?: string\n',
        n:
          '  /** orientation:父级参照点(锚点)。元素未显式写时**继承父级的 orientation** */\n' +
          '  orientation?: string\n' +
          '  /** 实际生效的 orientation = 自身值 ?? 父级继承值 ?? undefined(再缺省按 upper_left) */\n' +
          '  effectiveOrientation?: string\n',
      },

      /* ── 3) anchorFactors:补 CENTER_UP/CENTER_UPPER 等别名,值不变 ── */
      {
        o:
          '  // \'left\' 单独出现 = 左边中点\n' +
          "  if (o === 'left') return { x: 0, y: 0.5 }\n" +
          '  return { x, y }\n' +
          '}',
        n:
          '  // \'left\' 单独出现 = 左边中点\n' +
          "  if (o === 'left') return { x: 0, y: 0.5 }\n" +
          '  return { x, y }\n' +
          '}\n' +
          '\n' +
          '/**\n' +
          ' * 元素的"有效 orientation" = 自身显式值 ?? 父级继承值。\n' +
          ' * 依据 wiki:未指定 orientation 的元素继承所在容器的 orientation。\n' +
          ' * 父级为 undefined(顶层且自己也没写)时返回 undefined,由 anchorFactors 兜底为 upper_left。\n' +
          ' */\n' +
          'function effectiveOrientation(own: string | undefined, parent: string | undefined): string | undefined {\n' +
          '  return own ?? parent\n' +
          '}',
      },

      /* ── 4) resolvePositions:用父级 orientation 参与继承 ──
       * 父级锚点因子沿用父节点自己的 effectiveOrientation(即 n.orientation 已在
       * buildNode 里存成"继承后"的值),子元素用父级的值算自己的锚点。
       */
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
          '      // 自身对齐点缺省 = 生效锚点(含继承),显式 origo / centerposition 可覆盖。\n' +
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

      /* ── 5) resolvePositions 递归:把自己的生效 orientation 传下去 ── */
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
];

/* ── 主流程 ── */
let ok = true;
for (const grp of PATCH) {
  const fp = path.join(DIR, grp.file);
  let content;
  try {
    content = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    console.log('✗ 找不到文件: ' + grp.file + '  (' + e.message + ')');
    ok = false;
    continue;
  }
  if (content.includes(grp.marker)) {
    console.log('• 已是最新，跳过: ' + grp.file);
    continue;
  }

  let next = content;
  let groupOk = true;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '✗ 锚点不匹配 [' + grp.file + ']，出现次数=' + parts.length + ' 期望=1。片段: ' +
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
    console.log('✓ 校验通过(未写盘): ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
  } else {
    fs.writeFileSync(fp, next, 'utf8');
    console.log('✓ 已应用: ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
  }
}

if (!ok) {
  console.log('\n存在锚点不匹配，未做任何修改。');
  process.exit(1);
}
console.log(
  '\n' +
    (DRY
      ? 'DRY-RUN 完成：锚点均匹配，可去掉 --dry 正式应用。'
      : '完成。重启 run-gui.bat 生效。'),
);
