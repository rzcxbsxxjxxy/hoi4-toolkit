/* HOI4 GUI Toolkit —— 撤销 orientation 继承(回归修复)
 *
 * 背景:
 *   之前的 V3 补丁(ORIENT_INHERIT_FIX)给子控件加了"继承父级 orientation"的逻辑,
 *   依据是 wiki 一句 "Elements will inherit the orientation of the containers"。
 *   但实测 HOI4 的真实行为是:子元素的 position 是相对父级【左上角】的局部坐标,
 *   并不继承父级的 CENTER / upper_right 等取向。继承会把 CENTER 父级的子按钮推到
 *   窗口中心、把 upper_right 父级的子图标推到面板左边缘外 —— 正是用户反复报告的
 *   "子控件脱离父控件 / 位置异常"。
 *
 *   原版代码本就是不继承的(原 model.ts L183 注释:"空值按 upper_left 处理(实测不继承父级)"),
 *   V3 是误改。本补丁把 effectiveOrientation 改回 `n.orientation ?? 'upper_left'`,撤销该回归。
 *
 * 与 POSITION_SIGN_FIX(方向符号) 互不冲突:本补丁只改锚点取值,符号逻辑保留。
 *
 * 用法:
 *   node fix_orient_inherit.cjs                # 作用于 packages/gui(同目录)
 *   node fix_orient_inherit.cjs --dir=<path>   # 作用于指定副本(沙箱验证用)
 *   node fix_orient_inherit.cjs --dry          # 只校验锚点,不写盘
 */
'use strict'
const fs = require('fs')
const path = require('path')

const MARK = 'ORIENT_NO_INHERIT_FIX'
const dirArg = process.argv.find((a) => a.startsWith('--dir='))
const ROOT = dirArg ? dirArg.slice(6) : __dirname
const DRY = process.argv.includes('--dry')

const modelPath = path.join(ROOT, 'src', 'model.ts')

const OLD = [
  "      // orientation 继承:自身没写就用父级的(wiki 明确规定)",
  "      n.effectiveOrientation = effectiveOrientation(n.orientation, parentOri)",
].join('\n')

const NEW = [
  "      // 子控件锚点 = 自身 orientation ?? upper_left(锚定父级【左上角】局部原点),",
  "      // 不继承父级 orientation。HOI4 实测:子元素 position 是相对父级左上角的局部坐标,",
  "      // 继承父级(CENTER / upper_right 等)会把子控件推到父级中心/边缘甚至框外",
  "      // (pdx_int_logo / single_player 按钮应落在父框内或左上,继承则跑到框外/居中)。",
  "      n.effectiveOrientation = n.orientation ?? 'upper_left' // " + MARK,
].join('\n')

function main() {
  let s
  try { s = fs.readFileSync(modelPath, 'utf8') } catch (e) {
    console.log('[X] cannot read ' + modelPath + ' (' + e.message + ')')
    process.exit(1)
  }
  if (s.includes(MARK)) {
    console.log('[-] already patched, skipping: ' + modelPath + '  [' + MARK + ']')
    process.exit(0)
  }
  if (!s.includes(OLD)) {
    console.log('[X] anchor not found in ' + modelPath + '. The file may already differ or was edited manually.')
    console.log('    Expected first line: ' + OLD.split('\n')[0])
    process.exit(1)
  }
  if (DRY) {
    console.log('[OK] dry-run passed: ' + modelPath + '  (anchor matched, would apply ' + MARK + ')')
    process.exit(0)
  }
  const out = s.replace(OLD, NEW)
  if (!out.includes(MARK)) {
    console.log('[X] replacement failed (marker missing after replace). Aborting, nothing written.')
    process.exit(1)
  }
  fs.writeFileSync(modelPath, out)
  console.log('[OK] applied: ' + modelPath + '  (' + MARK + ')')
}

main()
