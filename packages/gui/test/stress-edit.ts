/**
 * 回写压力测试:随机改动 → 校验"没有伤及无辜"。
 *
 * 最强的一条断言:改动后重新解析,逐节点比对 —— 凡是没有被改的节点,
 * 它的 x/y/w/h 必须与改动前完全一致。任何附带损伤都会被抓出来。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SpriteIndex, walkFiles } from '../src/sprites.ts'
import { buildLayout } from '../src/model.ts'
import { applyEdits } from '../src/edit.ts'
import { parse } from '../../parser/src/parser.ts'
import { serialize } from '../../parser/src/serialize.ts'

const V = process.argv[3] || 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const sprites = new SpriteIndex(V)
sprites.scan([join(V, 'interface')])

const files = walkFiles(join(V, 'interface'), ['.gui'])
const limit = parseInt(process.argv[2] ?? '80', 10)
const picked = files.slice(0, limit)

let rng = 12345
const rand = (n: number) => {
  rng = (rng * 1103515245 + 12345) & 0x7fffffff
  return rng % n
}

let filesOk = 0
let filesBad = 0
let totalEdits = 0
let guardFail = 0
let roundTripFail = 0
let collateral = 0
let nodeCountDiff = 0
const problems: string[] = []

for (const p of picked) {
  const src = readFileSync(p, 'utf8')
  const rel = relative(join(V, 'interface'), p)
  const lay = buildLayout(src, rel, sprites)
  if (lay.flat.length < 2) continue

  // 期望值:所有节点的原始几何
  const expect = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const n of lay.flat) expect.set(n.id, { x: n.relX, y: n.relY, w: n.w, h: n.h })

  // 随机挑 4 个节点,随机改坐标和尺寸
  const edits: Record<string, number>[] = []
  const ids: string[] = []
  for (let i = 0; i < 4; i++) ids.push(lay.flat[rand(lay.flat.length)].id)
  for (const id of ids) {
    const e: Record<string, number> = { id }
    if (rand(4) !== 0) {
      e.x = rand(400) - 50
      e.y = rand(300) - 40
    }
    if (rand(3) === 0) {
      e.w = 20 + rand(200)
      e.h = 20 + rand(120)
    }
    if (e.x === undefined && e.w === undefined) e.x = rand(200)
    edits.push(e)
    const ex = expect.get(id)!
    if (e.x !== undefined) ex.x = e.x
    if (e.y !== undefined) ex.y = e.y
    if (e.w !== undefined) ex.w = e.w
    if (e.h !== undefined) ex.h = e.h
  }

  const out = applyEdits(lay, edits as never)
  totalEdits += out.details.length

  let bad = false
  if (!out.guard.ok) {
    guardFail++
    bad = true
    problems.push(`[守卫] ${rel}: ${out.guard.message}`)
  }
  if (serialize(parse(out.text)) !== out.text) {
    roundTripFail++
    bad = true
    problems.push(`[往返] ${rel}`)
  }

  const lay2 = buildLayout(out.text, rel, sprites)
  if (lay2.flat.length !== lay.flat.length) {
    nodeCountDiff++
    bad = true
    problems.push(`[节点数] ${rel}: ${lay.flat.length} → ${lay2.flat.length}`)
  }
  for (const n of lay2.flat) {
    const ex = expect.get(n.id)
    if (!ex) continue
    if (n.relX !== ex.x || n.relY !== ex.y || n.w !== ex.w || n.h !== ex.h) {
      collateral++
      if (problems.length < 20) {
        problems.push(
          `[附带损伤] ${rel} ${n.id} "${n.name}": 期望 (${ex.x},${ex.y},${ex.w},${ex.h}) 实际 (${n.relX},${n.relY},${n.w},${n.h})`,
        )
      }
      bad = true
    }
  }

  if (bad) filesBad++; else filesOk++
}

console.log('════════ 回写压力测试 ════════')
console.log(`  文件 ${filesOk + filesBad} 个(成功 ${filesOk} / 有问题 ${filesBad})`)
console.log(`  累计写入 ${totalEdits} 处改动`)
console.log(`  守卫失败     ${guardFail}`)
console.log(`  往返失败     ${roundTripFail}`)
console.log(`  节点数变化   ${nodeCountDiff}`)
console.log(`  附带损伤     ${collateral}`)
if (problems.length) {
  console.log('\n  问题明细:')
  for (const p of problems.slice(0, 20)) console.log('    ' + p)
} else {
  console.log('\n  全部通过:未改动的节点坐标与尺寸一字未动')
}
