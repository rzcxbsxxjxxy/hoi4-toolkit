import { readFileSync } from 'node:fs'
import { parse, serialize, walk, keyText, valueText } from '../src/index.ts'

// 冒烟:先拿三个形态各异的真实文件验证
const samples = [
  'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common/ideas/GER.txt',
  'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common/scripted_effects/00_scripted_effects.txt',
  'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common/units/infantry_equipment_1.txt',
]

for (const p of samples) {
  let buf: Buffer
  try {
    buf = readFileSync(p)
  } catch {
    console.log(`[skip] 不存在: ${p}`)
    continue
  }
  const src = buf.toString('utf8')
  const t0 = performance.now()
  const doc = parse(src)
  const out = serialize(doc)
  const ms = (performance.now() - t0).toFixed(1)
  const ok = Buffer.from(out, 'utf8').equals(buf)

  let pairs = 0
  let blocks = 0
  walk(doc, (e) => {
    if (e.block) blocks++
    else if (keyText(doc, e) !== undefined) pairs++
  })

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${buf.length.toString().padStart(7)}B  ${ms.padStart(6)}ms  ` +
      `pairs=${pairs} blocks=${blocks} errors=${doc.errors.length}  ${p.split('/').pop()}`,
  )
  if (doc.errors.length) console.log('       首个异常: ' + doc.errors[0])
}

// 语法细节抽查
const src = `key = value # 行尾注释
block = {
\tinner = 1
\tlist = { a b c }
\tGE = "quoted # not comment"
}
GER.my_var@ENG > 5
1936.1.1 = { yes }
`
const d = parse(src)
console.log('\n--- 语法细节抽查 ---')
console.log('round-trip:', serialize(d) === src ? 'PASS' : 'FAIL')
walk(d, (e) => {
  const k = keyText(d, e)
  const v = valueText(d, e)
  if (k !== undefined) console.log(`  ${k} ${v ?? (e.block ? '{...}' : '')}`)
})
console.log('异常数:', d.errors.length, d.errors)
