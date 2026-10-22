#!/usr/bin/env node
/*
 * fix_position_sign.cjs — 修复相对/绝对位置的方向符号(Wiki 规定)
 *
 * 背景:HOI4 的 position 偏移方向由 orientation 决定(Wiki 明文):
 *   UPPER_LEFT 时 position 正 = 往右/下;LOWER_RIGHT 时 position 正 = 往左/上。
 * 旧实现把 rx/ry 当无符号偏移直接相加,导致 RIGHT / LOWER 锚点的子元素被镜像到
 * 父级另一侧(本应贴父右上角的按钮飞到父右下 / 父外) —— “子控件脱离父控件”的主因。
 *
 * 本补丁在 model.ts 的 resolvePositions 里引入 signFactors():
 *   offX = a.x * parentW + s.x * rx - alignX * drawW   (s = 方向符号, RIGHT/LOWER 翻转)
 *   offY = a.y * parentH + s.y * ry - alignY * drawH
 *
 * 适用对象:已应用 V3(WIKI_LAYOUT_V3 / ORIENT_INHERIT_FIX)的 model.ts。
 * 标记:POSITION_SIGN_FIX(注入到 signFactors 末尾,用于幂等检测)
 *
 * 用法:
 *   node fix_position_sign.cjs                 # 作用于 packages/gui(同目录)
 *   node fix_position_sign.cjs --dir=/path/gui # 作用于指定目录(验证用)
 *   node fix_position_sign.cjs --dry           # 只校验锚点,不写盘
 */
const fs = require('fs')
const path = require('path')

const MARK = 'POSITION_SIGN_FIX'

// 解析 --dir=xxx 与 --dry
let GUI_DIR = path.resolve(__dirname)
let DRY = false
for (const a of process.argv.slice(2)) {
  if (a === '--dry') DRY = true
  else if (a.startsWith('--dir=')) GUI_DIR = path.resolve(a.slice(6))
}

const SIGN_FN =
`/**\n` +
` * 与 anchorFactors 配套的“方向符号”。\n` +
` * Wiki 规定 position 的偏移方向由 orientation 决定:\n` +
` *   UPPER_LEFT → 往右/下;LOWER_RIGHT → 往左/上。\n` +
` * 即 RIGHT 锚点 position.x 正 → 左移(向父内),LOWER 锚点 position.y 正 → 上移。\n` +
` * 旧实现把 rx/ry 当无符号偏移直接相加,使 RIGHT/LOWER 锚点元素被镜像到父级另一侧\n` +
` * (本应贴父右上角的按钮飞到父右下 / 父外) —— “子控件脱离父控件”的主因。\n` +
` */\n` +
`function signFactors(name: string | undefined): { x: number; y: number } {\n` +
`  const o = unquote(name).toLowerCase()\n` +
`  // X:含 right → 左移(-1);含 left / center / middle / 缺省 → 右移(+1)\n` +
`  let sx = 1\n` +
`  if (o.includes('right')) sx = -1\n` +
`  else if (o.includes('left')) sx = 1\n` +
`  else sx = 1\n` +
`  // Y:含 lower / down → 上移(-1);含 upper / up / center / middle / 缺省 → 下移(+1)\n` +
`  let sy = 1\n` +
`  if (o.includes('lower') || o.includes('down')) sy = -1\n` +
`  else if (o.includes('upper') || o.includes('up')) sy = 1\n` +
`  else sy = 1\n` +
`  return { x: sx, y: sy }\n` +
`}\n` +
`// ${MARK}\n`

const groups = [
  {
    file: 'src/model.ts',
    marker: MARK,
    edits: [
      {
        // 1) 在 anchorFactors 末尾插入 signFactors 定义
        o:
`  // 'left' 单独出现 = 左边中点
  if (o === 'left') return { x: 0, y: 0.5 }
  return { x, y }
}
`,
        n:
`  // 'left' 单独出现 = 左边中点
  if (o === 'left') return { x: 0, y: 0.5 }
  return { x, y }
}

${SIGN_FN}`,
      },
      {
        // 2) resolvePositions 内取方向符号
        o: `      const a = anchorFactors(n.effectiveOrientation)\n`,
        n:
`      const a = anchorFactors(n.effectiveOrientation)
      const s = signFactors(n.effectiveOrientation)
`,
      },
      {
        // 3) offX/offY 乘以方向符号
        o:
`      n.offX = a.x * parentW + rx - n.alignX * n.drawW
      n.offY = a.y * parentH + ry - n.alignY * n.drawH
`,
        n:
`      n.offX = a.x * parentW + s.x * rx - n.alignX * n.drawW
      n.offY = a.y * parentH + s.y * ry - n.alignY * n.drawH
`,
      },
    ],
  },
]

function single(grp) {
  const p = path.join(GUI_DIR, grp.file)
  let content
  try {
    content = fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.log('[X] file not found: ' + grp.file + '  (' + e.message + ')')
    return false
  }
  if (content.includes(grp.marker)) {
    console.log('[-] already patched, skipping: ' + grp.file + '  [' + grp.marker + ']')
    return true
  }
  let ok = true
  for (const ed of grp.edits) {
    const parts = content.split(ed.o)
    if (parts.length !== 2) {
      console.log(
        '[X] anchor not found in ' + grp.file + ' (matched ' + (parts.length - 1) +
          ', need exactly 1). Snippet (may be garbled in a GBK console): ' +
          ed.o.slice(0, 70).replace(/\n/g, '\\n'),
      )
      ok = false
      break
    }
    if (!DRY) content = parts.join(ed.n)
  }
  if (ok && !DRY) {
    fs.writeFileSync(p, content)
    console.log('[OK] applied: ' + grp.file + '  (' + grp.edits.length + ' edits, marker ' + grp.marker + ')')
  } else if (ok && DRY) {
    console.log('[OK] dry-run passed: ' + grp.file + '  (' + grp.edits.length + ' edits, marker ' + grp.marker + ')')
  }
  return ok
}

let allOk = true
for (const g of groups) allOk = single(g) && allOk

console.log(
  DRY
    ? 'DRY-RUN done: all anchors matched. Re-run without --dry to apply.'
    : 'Done. Restart run-gui.bat to pick up the changes.',
)
process.exit(allOk ? 0 : 1)
