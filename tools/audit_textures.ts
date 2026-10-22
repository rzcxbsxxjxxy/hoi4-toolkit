/**
 * 贴图解码体检 —— TEX_AUDIT_V5
 *
 * 用途:验证 `packages/gui/src/dds.ts` 的解码器在**全量真实贴图**上是否正常。
 * 这是 dds.ts 两次静默 bug 的守门人:
 *
 *   BUG-1 DDS_PITCH_V4      —— dwPitchOrLinearSize 写的是"总字节数"而非行跨距,
 *                              导致 stride=16384,每张图只解出第 1 行(其余全 0)。
 *   BUG-2 DXT5_ALPHA48_V4   —— alpha 索引是 48 bit(6 字节),旧代码只读 4 字节,
 *                              且 JS 位移计数 mod 32 → 索引 8..15 全错 → 整图近全透明。
 *   BUG-3 DDS_SIGNED_SHIFT_V4—— 掩码位宽用 >> 算,0xFF000000 >> 24 === -1(有符号溢出)。
 *
 * 这三个 bug 的共同特征:**都不报错**。decodeImage 返回 ok:true、尺寸正确、
 * format 正确,只是像素是垃圾。所以只能靠"统计可见像素"这种外部判据发现,
 * 光看返回值永远发现不了 —— 这就是本脚本存在的理由。
 *
 * 判据:
 *   完全空   = 可见像素(alpha>0)占比 == 0  → 一定是解码坏了
 *   近全透明 = 占比 < 1%                   → 可能是遮罩类贴图(a0=0,a1=5),需人工确认
 *   解码失败 = decodeImage 返回 !ok        → 格式未支持(与本脚本要抓的 bug 无关)
 *
 * 用法:
 *   node --experimental-strip-types audit_textures.ts        # 在 toolkit/ 下跑
 *   node --experimental-strip-types audit_textures.ts <gfx目录>
 *
 * 参考基线(vanilla + Kaiserreich 挂载,2026-10-04 修复后):
 *   贴图 28675 · 正常 27981 · 近全透明 183 · 完全空 **0** · 刻意留白 21 · 解码失败 490
 *   失败全部是"格式未支持"(16bit 未压缩 / TGA type10 / DX10 / RXGB),不是解码错误。
 *   21 个"刻意留白"含 blank_leader_portrait / decryption_bar_empty / *_empty /
 *   *_specular(镜面图纯黑即"无高光",正确数据)/ 两个已核对整块为 0 的文件。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { decodeImage } from '../packages/gui/src/dds.ts'

const DEFAULT_GFX = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/gfx'

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out
  let items: string[]
  try {
    items = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of items) {
    const p = join(dir, n)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out, depth + 1)
    else if (['.dds', '.tga', '.png'].includes(extname(n).toLowerCase())) out.push(p)
  }
  return out
}

/**
 * 语义上就是"全透明/全黑"的贴图,不算 bug。
 *
 * 分两类:
 *  ① 文件名直说了 —— blank / empty / placeholder / null(占位底图、进度条空槽)
 *  ② specular / nospec —— 镜面反射贴图。游戏里"无高光"就是纯黑,
 *     所以 alpha=0 + RGB 全 0 是**正确数据**(实测 nospec.dds 的
 *     DXT5 块 a0=0、所有索引=0,即整块 alpha 0)。
 *     这类贴图不参与 2D 界面渲染,工作台里本来也看不到。
 */
const INTENTIONAL_BLANK =
  /blank|empty|placeholder|_transp|transparent|null|specular|nospec/i

/**
 * 已逐一核对过原始字节、确认整块为 0 的文件(不是解码器漏了数据)。
 * 列出来是为了让"0 异常"这个结论可复核,而不是靠通配符蒙混过去。
 *   onmap_unit_flag_overlay.dds   10x7  整块 0
 *   scrollbar_sliderbackground.dds 16x16 整块 0(滚动条滑块底,游戏里就是透明)
 */
const VERIFIED_ALL_ZERO = new Set(['interface/onmap_unit_flag_overlay.dds', 'interface/scrollbar_sliderbackground.dds'])

const root = process.argv[2] || DEFAULT_GFX
const files = walk(root)
console.log(`贴图目录: ${root}`)
console.log(`待检贴图: ${files.length}`)

let ok = 0
let fail = 0
let empty = 0
let thin = 0
let intentional = 0
const reasons = new Map<string, number>()
const empties: string[] = []
const thins: string[] = []
const t0 = Date.now()

for (const f of files) {
  const r = decodeImage(readFileSync(f), extname(f))
  if (!r.ok || !r.bitmap) {
    fail++
    const k = r.error ?? '?'
    reasons.set(k, (reasons.get(k) ?? 0) + 1)
    continue
  }
  const { w, h, rgba } = r.bitmap
  let vis = 0
  const total = w * h
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) vis++
  const ratio = total ? vis / total : 0
  /* ⚠ 必须先把 f 归一化成正斜杠再减 root。
   * walk() 用 path.join(),在 Windows 上产生的是 **反斜杠**,
   * 而 root 是正斜杠字符串 → replace 匹配不上 → rel 变成绝对路径,
   * 导致 VERIFIED_ALL_ZERO 这类相对路径集合判断全部失效(静默漏判)。*/
  const rel = f.replace(/\\/g, '/').replace(root.replace(/\\/g, '/'), '').replace(/^\/+/, '')

  if (ratio <= 0) {
    if (INTENTIONAL_BLANK.test(rel) || w * h <= 4 || VERIFIED_ALL_ZERO.has(rel)) {
      intentional++
    } else {
      empty++
      if (empties.length < 20) empties.push(`${rel}  ${w}x${h} fmt=${r.format}`)
    }
  } else if (ratio < 0.01) {
    thin++
    if (thins.length < 10) thins.push(`${rel}  ${w}x${h} fmt=${r.format} 可见 ${(ratio * 100).toFixed(2)}%`)
  } else {
    ok++
  }
}

const ms = Date.now() - t0
console.log('─'.repeat(64))
console.log(`正常      ${ok}`)
console.log(`近全透明  ${thin}   (占比 <1%,可能是遮罩类贴图,需人工确认)`)
console.log(`完全空    ${empty}   (可见像素 0 —— 一定是解码 bug)`)
console.log(`刻意留白  ${intentional}   (文件名含 blank/empty/placeholder,正常)`)
console.log(`解码失败  ${fail}   (格式未支持,与解码 bug 无关)`)
console.log(`耗时      ${ms} ms`)
if (reasons.size) {
  console.log('─'.repeat(64))
  console.log('失败原因:')
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ×${v}`)
}
if (empties.length) {
  console.log('─'.repeat(64))
  console.log('⚠ 完全空样本(解码 bug):')
  for (const e of empties) console.log('  ', e)
}
if (thins.length) {
  console.log('─'.repeat(64))
  console.log('近全透明样本(人工确认):')
  for (const t of thins) console.log('  ', t)
}
console.log('─'.repeat(64))
console.log(empty === 0 ? '✅ 无「完全空」贴图 —— 解码器未回归' : `❌ ${empty} 张完全空,解码器有 bug`)
