/**
 * verify_layout.mts — GUI 布局模型全量回归（改 model.ts / server.ts 后必跑）
 *
 * 对扫描到的全部 .gui 文件跑 buildLayout，检查：
 *   1. 不抛异常（结构错误会让 designer 整个文件打不开）
 *   2. 无 NaN / Infinity 坐标（会静默渲染错位）
 *   3. bgLayers 统计（附加 background 层的覆盖面，2026-10-22 基线 181）
 *   4. 顶层 sizeUnknown / spriteMissing 汇总（误报会排查噪声，真错会漏检）
 *
 * 跑法：node --experimental-strip-types tools/verify_layout.mts
 * 依赖：与 server.ts 同一套 roots（从 gui-settings.json 读），不预热贴图索引也能跑
 *   （本脚本自建最小 SpriteIndex，只为拿 natural size；全量回归看的是结构不变量）。
 */
import { buildLayout } from '../packages/gui/src/model.ts'
import { SpriteIndex } from '../packages/gui/src/sprites.ts'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface RootCfg { name: string; path: string }

const SETTINGS = join(process.cwd(), 'gui-settings.json')
const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
// gui-settings.json 结构：{ base: 游戏路径, mods: [{path, enabled}, ...] }
// roots 顺序 = 覆盖优先级（mods 在前、base 在末，与 server.ts 的 ROOTS 一致）
const roots: RootCfg[] = [
  ...(settings.mods || []).filter((m: any) => m.enabled).map((m: any, i: number) => ({ name: 'mod' + i, path: m.path })),
  { name: 'base', path: settings.base || '' },
].filter((r: RootCfg) => r.path && existsSync(r.path))

if (!roots.length) {
  console.error('no usable roots from', SETTINGS)
  process.exit(2)
}
console.log('roots:', roots.map(r => r.name + '=' + r.path).join(' | '))

/** 枚举所有 root 的 interface/*.gui（含子目录） */
function enumGuiFiles(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of roots) {
    const stack = [join(r.path, 'interface')]
    while (stack.length) {
      const cur = stack.pop()!
      let items
      try { items = readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const it of items) {
        const p = join(cur, it.name)
        if (it.isDirectory()) stack.push(p)
        else if (it.isFile() && it.name.toLowerCase().endsWith('.gui')) {
          if (!seen.has(it.name)) { seen.add(it.name); out.push(p) }
        }
      }
    }
  }
  return out.sort()
}

// 自建 SpriteIndex（含 candidateFn —— 缺了它模组重定义但文件缺失的贴图会误报尺寸未知）
const TEX_EXTS = ['.dds', '.tga', '.png']
const spriteIdx = new SpriteIndex(roots[roots.length - 1].path)
spriteIdx.candidateFn = (tf: string) => {
  const dot = tf.lastIndexOf('.')
  const stem = dot > 0 ? tf.slice(0, dot) : tf
  const declared = dot > 0 ? tf.slice(dot).toLowerCase() : ''
  const exts = TEX_EXTS.includes(declared) ? [declared, ...TEX_EXTS.filter(e => e !== declared)] : [...TEX_EXTS]
  const out: string[] = []
  for (let i = roots.length - 1; i >= 1; i--) for (const e of exts) out.push(join(roots[i].path, stem + e))
  for (const e of exts) out.push(join(roots[0].path, stem + e))
  return out
}
for (const r of roots) spriteIdx.scanAll([{ dir: join(r.path, 'interface'), gameRoot: r.path }])

const files = enumGuiFiles()
console.log('gui files:', files.length)

let ok = 0, thrown = 0, nan = 0
let nodeTotal = 0, withBgLayers = 0, unknownSize = 0, missingSprite = 0
const bgLayerSamples: string[] = []
const problemFiles: string[] = []

for (const abs of files) {
  const rel = abs.slice(abs.indexOf('interface'))
  try {
    const src = readFileSync(abs, 'utf8')
    const j = buildLayout(src, rel, spriteIdx)
    let bad = false
    const walk = (n: any) => {
      nodeTotal++
      if (n.spriteMissing) missingSprite++
      if (n.sizeUnknown) unknownSize++
      for (const v of [n.absX, n.absY, n.drawW, n.drawH, n.offX, n.offY, n.w, n.h]) {
        if (typeof v === 'number' && !isFinite(v)) { nan++; bad = true }
      }
      const layers = n.bgLayers || []
      if (layers.length) {
        withBgLayers++
        if (bgLayerSamples.length < 200) bgLayerSamples.push(`${rel} :: ${n.name}`)
        for (const L of layers) {
          for (const v of [L.offX, L.offY, L.drawW, L.drawH]) {
            if (typeof v === 'number' && !isFinite(v)) { nan++; bad = true }
          }
        }
      }
      for (const c of n.children || []) walk(c)
    }
    for (const r of j.nodes) walk(r)
    if (bad) problemFiles.push(rel)
    else ok++
  } catch (e: any) {
    thrown++
    if (problemFiles.length < 50) problemFiles.push(`${rel} :: THROW ${e && e.message}`)
  }
}

console.log(`ok=${ok} throw=${thrown} nan=${nan}`)
console.log(`nodes=${nodeTotal} bgLayerNodes=${withBgLayers} sizeUnknown=${unknownSize} spriteMissing=${missingSprite}`)
if (problemFiles.length) {
  console.log('--- problem files (first 50) ---')
  for (const p of problemFiles) console.log(' ', p)
}
if (bgLayerSamples.length) {
  console.log('--- bgLayer samples (first 20) ---')
  for (const p of bgLayerSamples.slice(0, 20)) console.log(' ', p)
}
// throw/nan 是硬失败；sizeUnknown/spriteMissing 只汇报（可能随贴图索引缓存变化）
process.exit(thrown || nan ? 1 : 0)
