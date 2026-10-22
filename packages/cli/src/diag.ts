/** 诊断:每个目录的根级 key 分布 + 二层和三层结构形态,用于校准定义提取规则 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { parse, keyText } from '../../parser/src/index.ts'

const root = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV/common'

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walkFiles(p)
    else if (extname(name).toLowerCase() === '.txt') yield p
  }
}

const byDir = new Map<string, Map<string, number>>()

for (const p of walkFiles(root)) {
  const doc = parse(readFileSync(p, 'utf8'))
  const dir = relative(root, p).split(/[\\/]/)[0]
  const m = byDir.get(dir) ?? new Map<string, number>()
  for (const e of doc.root.entries) {
    const k = keyText(doc, e)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  byDir.set(dir, m)
}

for (const [dir, m] of [...byDir.entries()].sort()) {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log(`${dir.padEnd(34)} ${top.map(([k, n]) => `${k}(${n})`).join('  ')}`)
}
