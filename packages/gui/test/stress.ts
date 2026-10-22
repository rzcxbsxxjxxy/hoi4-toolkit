/** 对全部 .gui 跑布局构建,检验模型在真实规模下的健壮性 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SpriteIndex, walkFiles } from '../src/sprites.ts'
import { buildLayout } from '../src/model.ts'

const roots = process.argv.slice(2)
if (!roots.length) {
  console.log('用法: node stress.ts <interface 目录> [更多目录...]')
  process.exit(1)
}

const t0 = Date.now()
const sprites = new SpriteIndex(roots[0].replace(/[\\/]interface$/, ''))
sprites.scan(roots)
console.log(`sprite 索引: ${sprites.stats.sprites} 个(带贴图 ${sprites.stats.withTexture}),${Date.now() - t0} ms\n`)

let files = 0
let ok = 0
let fail = 0
let elements = 0
let unresolved = 0
let noPos = 0
let sizeUnknown = 0
let maxDepth = 0
const failures: string[] = []
const top: { file: string; n: number }[] = []

for (const root of roots) {
  for (const p of walkFiles(root, ['.gui'])) {
    files++
    let src: string
    try {
      src = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    try {
      const lay = buildLayout(src, relative(root, p), sprites)
      ok++
      elements += lay.stats.elements
      unresolved += lay.unresolved.length
      maxDepth = Math.max(maxDepth, lay.stats.maxDepth)
      for (const n of lay.flat) {
        if (n.posMissing) noPos++
        if (n.sizeUnknown) sizeUnknown++
      }
      top.push({ file: lay.file, n: lay.stats.elements })
    } catch (e) {
      fail++
      if (failures.length < 8) failures.push(`${relative(root, p)}: ${e}`)
    }
  }
}

console.log(`文件 ${files}  成功 ${ok}  失败 ${fail}`)
console.log(`元素总数 ${elements}  最大嵌套深度 ${maxDepth}`)
console.log(`sprite 未解析 ${unresolved}  缺 position ${noPos}  尺寸推断不出 ${sizeUnknown}`)
console.log(`耗时 ${Date.now() - t0} ms`)
console.log('\n元素最多的 10 个文件:')
for (const t of top.sort((a, b) => b.n - a.n).slice(0, 10)) console.log(`  ${String(t.n).padStart(6)}  ${t.file}`)
if (failures.length) {
  console.log('\n失败样例:')
  for (const f of failures) console.log('  ' + f)
}
