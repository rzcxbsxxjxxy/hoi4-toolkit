/* ══════════════════════════════════════════════════════════════════
 * 验收 1:无损往返(round-trip)
 *
 * parse → serialize 后必须与原文【逐字节相同】。这是所有「无损改写」功能的地基:
 * 一旦这里挂了,拖拽改坐标、跨文件重命名、元素级编辑产生的 diff 就会
 * 连带你没碰过的行,而用户很难察觉。
 *
 * 用法:
 *   node --experimental-strip-types verify_roundtrip.ts
 *   node --experimental-strip-types verify_roundtrip.ts <额外目录> ...
 *
 * 说明:只比对文本内容。BOM / CRLF 差异会算作不一致 —— 这是刻意的,
 * 因为写回时也必须保持原样。
 * ══════════════════════════════════════════════════════════════════ */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parse } from '../packages/parser/src/parser.ts'
import { serialize } from '../packages/parser/src/serialize.ts'

const VAN = process.env.HOI4_VANILLA
  ?? 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'

/* 默认覆盖:interface 全量 .gui(坐标相关)+ common 全量(国策/科技/决议/单位)。
 * 排布 localisation 是因为它是 YML 行格式,走另一条解析链路。 */
const TARGETS = [
  { dir: join(VAN, 'interface'), exts: ['.gui', '.txt'] },
  { dir: join(VAN, 'common'), exts: ['.txt'] },
]
for (const d of process.argv.slice(2)) TARGETS.push({ dir: d, exts: ['.gui', '.txt'] })

function walk(dir, exts, out = []) {
  let ents
  try { ents = readdirSync(dir) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.includes(extname(e).toLowerCase())) out.push(p)
  }
  return out
}

let ok = 0
const bad = []
const t0 = Date.now()

for (const t of TARGETS) {
  const files = walk(t.dir, t.exts)
  let o = 0
  for (const f of files) {
    let src
    try { src = readFileSync(f, 'utf8') } catch { continue }
    try {
      if (serialize(parse(src)) === src) { ok++; o++ } else bad.push(f)
    } catch (e) { bad.push(`${f}  (解析异常: ${e?.message ?? e})`) }
  }
  console.log(`  ${t.dir}  ${o}/${files.length} 一致`)
}

const ms = Date.now() - t0
console.log(`\n无损往返: ${ok} 个文件逐字节一致, ${bad.length} 不一致  (${ms}ms)`)
if (bad.length) {
  for (const b of bad.slice(0, 10)) console.log('  ✘ ' + b)
  if (bad.length > 10) console.log(`  … 另有 ${bad.length - 10} 个`)
}
process.exit(bad.length === 0 ? 0 : 1)
