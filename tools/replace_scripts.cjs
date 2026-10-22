// replace_scripts.cjs — 依据 bundles-report.json 改写各页 HTML:
//   普通同步 src 脚本 -> 首个换成 bundle.js,其余删除;
//   i18n-dict.js(async/defer 等保留脚本)原块保留; module src -> bundle.mjs; 内联保留。
"use strict";
const fs = require('fs')
const path = require('path')
const PUBLIC = path.resolve(process.argv[2] || 'D:/杂项/hoi4/toolkit-electron/packages/gui/public')
const OUT = path.join(PUBLIC, 'bundles')
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'bundles-report.json'), 'utf8'))

// 需要"保留原块"的普通脚本(动态端点 / async-defer / 任何 norm 之外)
function isKept(r, clean) { return (r.keptDyn || []).includes(clean) || (r.keptAsync || []).includes(clean) }

for (const h of Object.keys(report)) {
  const r = report[h]
  if (!r.normUrl && !r.modUrl && !(r.keptDyn || []).length && !(r.keptAsync || []).length) continue
  const file = path.join(PUBLIC, h)
  let t = fs.readFileSync(file, 'utf8')
  let nNorm = 0, nMod = 0, nKept = 0
  const re = /<script\b[^>]*>[\s\S]*?<\/script>/g
  t = t.replace(re, (block) => {
    const am = /<script\b([^>]*)>/.exec(block)
    const attrs = am ? am[1] : ''
    const srcM = /src="([^"]+)"/.exec(attrs)
    if (!srcM) return block // 内联,保留
    const isModule = /type\s*=\s*["']module["']/.test(attrs)
    const clean = srcM[1].split('?')[0].replace(/^\//, '')
    if (isModule) {
      nMod++
      return (nMod === 1 && r.modUrl) ? `<script type="module" src="${r.modUrl}"></script>` : ''
    }
    if (isKept(r, clean)) { nKept++; return block } // 动态/async 保留原块
    nNorm++
    return (nNorm === 1 && r.normUrl) ? `<script src="${r.normUrl}"></script>` : ''
  })
  fs.writeFileSync(file, t, 'utf8')
  console.log(`${h}: bundle=${nNorm ? '1' : 0} kept=${nKept} mod=${nMod}`)
}
console.log('done')
