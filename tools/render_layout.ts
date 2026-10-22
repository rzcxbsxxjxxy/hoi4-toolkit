/**
 * 把 .gui 的解析结果画成 PNG,用于肉眼核对布局是否正确。
 * 用法:node --experimental-strip-types render_layout.ts <相对 interface 的路径> [输出png] [缩放]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { buildLayout } from '../packages/gui/src/model.ts'
import { SpriteIndex } from '../packages/gui/src/sprites.ts'

const VAN = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const rel = process.argv[2] || 'tutorialscreen.gui'
const out = process.argv[3] || 'layout.png'
const zoom = Number(process.argv[4] || 0.5)

const idx = new SpriteIndex(VAN)
idx.scan([join(VAN, 'interface')])
const L = buildLayout(readFileSync(join(VAN, 'interface', rel), 'utf8'), rel, idx)

const W = Math.max(1920, Math.ceil(L.canvasW))
const H = Math.max(1080, Math.ceil(L.canvasH))
const iw = Math.max(1, Math.round(W * zoom))
const ih = Math.max(1, Math.round(H * zoom))
const buf = Buffer.alloc(iw * ih * 3, 0xff)

// 屏幕底色(浅灰蓝),屏幕范围外更暗
for (let y = 0; y < ih; y++) {
  for (let x = 0; x < iw; x++) {
    const inside = x < 1920 * zoom && y < 1080 * zoom
    const i = (y * iw + x) * 3
    buf[i] = inside ? 0xef : 0xd8
    buf[i + 1] = inside ? 0xf2 : 0xd8
    buf[i + 2] = inside ? 0xf6 : 0xd8
  }
}

const COLORS: [number, number, number][] = [
  [0x2f, 0x6d, 0xf0], [0xd9, 0x33, 0x3f], [0x1f, 0x9d, 0x55],
  [0xf5, 0xa6, 0x23], [0x8e, 0x44, 0xad], [0x16, 0xa0, 0x85],
]

function rect(x: number, y: number, w: number, h: number, c: [number, number, number], fill: boolean) {
  const x0 = Math.max(0, Math.round(x * zoom)), y0 = Math.max(0, Math.round(y * zoom))
  const x1 = Math.min(iw - 1, Math.round((x + w) * zoom)), y1 = Math.min(ih - 1, Math.round((y + h) * zoom))
  if (x1 < x0 || y1 < y0) return
  if (fill) {
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const i = (yy * iw + xx) * 3
      buf[i] = buf[i] * 0.72 + c[0] * 0.28
      buf[i + 1] = buf[i + 1] * 0.72 + c[1] * 0.28
      buf[i + 2] = buf[i + 2] * 0.72 + c[2] * 0.28
    }
  } else {
    for (let xx = x0; xx <= x1; xx++) { put(xx, y0, c); put(xx, y1, c) }
    for (let yy = y0; yy <= y1; yy++) { put(x0, yy, c); put(x1, yy, c) }
  }
}
function put(x: number, y: number, c: [number, number, number]) {
  if (x < 0 || y < 0 || x >= iw || y >= ih) return
  const i = (y * iw + x) * 3
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]
}

const rec = (ns: any[]) => {
  for (const n of ns) {
    const c = COLORS[n.depth % COLORS.length]
    rect(n.absX, n.absY, n.drawW, n.drawH, c, n.depth === 0)
    rec(n.children || [])
  }
}
rec(L.nodes)
// 屏幕边框
rect(0, 0, 1919, 1079, [0x60, 0x60, 0x60], false)

/* ── 最小 PNG 编码 ── */
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return (b: Buffer) => { let c = -1; for (const v of b) c = t[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
})()
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(iw, 0); ihdr.writeUInt32BE(ih, 4)
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(ih * (iw * 3 + 1))
for (let y = 0; y < ih; y++) {
  raw[y * (iw * 3 + 1)] = 0
  buf.copy(raw, y * (iw * 3 + 1) + 1, y * iw * 3, (y + 1) * iw * 3)
}
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]))
console.log(`${rel} → ${out} (${iw}x${ih}) 元素 ${L.stats.elements} 根窗口 ${L.nodes.length}`)
for (const n of L.nodes.slice(0, 8)) {
  console.log(`  ${n.type.replace(/Type$/, '')}:${n.name} abs=${Math.round(n.absX)},${Math.round(n.absY)} ${Math.round(n.drawW)}x${Math.round(n.drawH)}${n.orientation ? ' ori=' + n.orientation : ''}`)
}
