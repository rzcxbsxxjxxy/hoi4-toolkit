/**
 * fix_node_border.cjs — 修复 GUI 设计器可视化时的「累积偏移」bug。
 *
 * 根因(CSS 盒模型):
 *   designer.html 里 .node 用 `border:1px solid` 画边框。
 *   但 .node 是 position:absolute,其【子节点】的 left/top 是相对父级
 *   的【内边距盒(padding box,即 border 内侧)】定位的。于是每嵌套一层,
 *   子节点就被父级 1px 边框多挤 1px —— HOI4 的 .gui 嵌套常达 10~20 层,
 *   叶子节点因此累积偏移 10~20px,表现为"位置仍然不对、但比镜像/居中错乱轻"。
 *
 * 修复:把 border 换成 `box-shadow:inset`(不占布局,视觉边框保留),
 *   子节点的 left/top 现在直接相对父级边框盒(border box)左上角,
 *   与 model.ts 里 offX/offY 的假定(相对父级左上角)完全一致。
 *
 * 标记: NODE_BORDER_FIX(幂等,重复运行安全)
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'packages', 'gui', 'public', 'designer.html');
const MARK = 'NODE_BORDER_FIX';

const OLD = [
  '  .node{position:absolute;border:1px solid #9bb0c9;background:rgba(255,255,255,.66);font-size:11px;overflow:visible;border-radius:2px}',
  '  .node.sel{border-color:var(--accent);box-shadow:0 0 0 2px rgba(47,109,240,.4);z-index:5}',
  '  .node.hover{border-color:var(--warn)}',
  '  .node.bad{border-color:var(--bad);border-style:dashed}',
].join('\n');

const NEW = [
  '  /* NODE_BORDER_FIX: 用 box-shadow:inset 代替 border,避免绝对定位子元素每嵌套一层被挤 1px */',
  '  .node{position:absolute;box-shadow:inset 0 0 0 1px #9bb0c9;background:rgba(255,255,255,.66);font-size:11px;overflow:visible;border-radius:2px}',
  '  .node.sel{box-shadow:inset 0 0 0 1px var(--accent),0 0 0 2px rgba(47,109,240,.4);z-index:5}',
  '  .node.hover{box-shadow:inset 0 0 0 1px var(--warn)}',
  '  .node.bad{box-shadow:inset 0 0 0 1px var(--bad)}',
].join('\n');

let html;
try {
  html = fs.readFileSync(target, 'utf8');
} catch (e) {
  console.error('ERROR: 找不到 ' + target + ' —— 请在 toolkit 根目录运行。');
  process.exit(1);
}

if (html.includes(MARK)) {
  console.log('已经打过补丁 (NODE_BORDER_FIX 已存在),无需重复。');
  process.exit(0);
}

if (!html.includes(OLD)) {
  console.error('ERROR: 未找到目标 CSS 块,文件可能已改动,已跳过以免误改。');
  process.exit(1);
}

html = html.replace(OLD, NEW);
fs.writeFileSync(target, html, 'utf8');
console.log('OK: designer.html 的 .node 边框已从 border 改为 box-shadow:inset(NODE_BORDER_FIX)。');
console.log('    现在子节点不再被 1px 边框逐层挤出,可视化位置与游戏一致。');
