/**
 * PNG 编解码(编码器仅 8bit RGBA;解码器覆盖 HOI4 模组常见格式)。
 *
 * 为什么不用原始 RGBA 传给浏览器:UI 背景图动辄 1920×1080,
 * 原始 RGBA 是 8MB、base64 后 11MB,一次请求就卡死。
 * PNG(deflate)能把界面贴图压到几十 KB。
 *
 * ⚠ 解码器是模组素材能显示的关键:vanilla 的贴图几乎全是 DDS(引擎格式),
 * 但模组为了改小体积普遍改用 PNG —— 实测 KR 有 25272 个 png vs 998 个 dds。
 * 只认 dds/tga 时模组贴图全挂,界面预览里是大片"贴图不存在"。
 * HOI4 引擎自己也不挑扩展名,同一路径下 dds/tga/png 都能命中。
 */

import { deflateSync, inflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** rgba: 长度 w*h*4,RGBA 顺序 */
export function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每行前置 filter 字节 0(None)
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    const dst = y * (w * 4 + 1)
    raw[dst] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, dst + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 超过阈值就整体降采样(最近邻),保证响应体积可控 */
export function downscaleIfNeeded(
  rgba: Uint8Array,
  w: number,
  h: number,
  maxPixels: number,
): { rgba: Uint8Array; w: number; h: number; scaled: boolean } {
  const px = w * h
  if (px <= maxPixels) return { rgba, w, h, scaled: false }
  const factor = Math.ceil(Math.sqrt(px / maxPixels))
  const nw = Math.max(1, Math.floor(w / factor))
  const nh = Math.max(1, Math.floor(h / factor))
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, x * factor)
      const sy = Math.min(h - 1, y * factor)
      const s = (sy * w + sx) * 4
      const d = (y * nw + x) * 4
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = rgba[s + 3]
    }
  }
  return { rgba: out, w: nw, h: nh, scaled: true }
}

/* ═══════════════ PNG 解码(PNG_MOD_DECODE_V1)═══════════════ */

export interface PngImage {
  rgba: Uint8Array
  w: number
  h: number
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** CRC 校验用:解码时不逐块验(HOI4 素材都是本地可信文件),跳过。 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 逐行反滤波,把带 filter byte 的原始像素流还原成纯像素。
 * bpp = 每像素字节数(依赖 colorType + bitDepth)。
 */
function unfilter(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp
  const out = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[up + i] : 0
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0
      let v: number
      switch (ft) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: throw new Error('未知的 PNG filter 类型 ' + ft)
      }
      out[dst + i] = v & 0xff
    }
  }
  return out
}

/** 隔行(Adam7)重建:把 7 个 pass 拼回完整图像。 */
function deinterlace(pix: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const out = new Uint8Array(w * h * bpp)
  const XO = [0, 4, 0, 2, 0, 1, 0]
  const YO = [0, 0, 4, 0, 2, 0, 1]
  const XS = [8, 8, 4, 4, 2, 2, 1]
  const YS = [8, 8, 8, 4, 4, 2, 2]
  let si = 0
  for (let p = 0; p < 7; p++) {
    const pw = Math.ceil((w - XO[p]) / XS[p])
    const ph = Math.ceil((h - YO[p]) / YS[p])
    if (pw <= 0 || ph <= 0) continue
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const dx = XO[p] + x * XS[p]
        const dy = YO[p] + y * YS[p]
        for (let k = 0; k < bpp; k++) {
          out[(dy * w + dx) * bpp + k] = pix[si * bpp + k]
        }
        si++
      }
    }
  }
  return out
}

/** 按调色板展开为 RGBA。 */
function paletteToRgba(idx: Uint8Array, w: number, h: number, plte: Uint8Array, trns?: Uint8Array): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const p = idx[i]
    out[i * 4] = plte[p * 3]
    out[i * 4 + 1] = plte[p * 3 + 1]
    out[i * 4 + 2] = plte[p * 3 + 2]
    out[i * 4 + 3] = trns && p < trns.length ? trns[p] : 255
  }
  return out
}

/**
 * 解码 PNG → RGBA。
 * 支持 colorType 0(灰度)/2(RGB)/3(调色板)/4(灰度+A)/6(RGBA),
 * bitDepth 1/2/4/8/16,隔行与非隔行。16bit 一律取高字节(预览不需要低精度)。
 */
export function decodePng(buf: Buffer): { ok: true; bitmap: PngImage } | { ok: false; error: string } {
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return { ok: false, error: '不是 PNG 文件' }
  let off = 8
  let w = 0
  let h = 0
  let depth = 8
  let color = 6
  let interlace = 0
  let plte: Uint8Array | undefined
  let trns: Uint8Array | undefined
  const idat: Buffer[] = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      // ★ 损坏文件 IHDR 块可能不足 13 字节,readUInt32BE(4) 会抛 RangeError 崩进程
      if (body.length >= 13) {
        w = body.readUInt32BE(0)
        h = body.readUInt32BE(4)
        depth = body[8]
        color = body[9]
        interlace = body[12]
      }
    } else if (type === 'PLTE') {
      plte = Uint8Array.from(body)
    } else if (type === 'tRNS') {
      trns = Uint8Array.from(body)
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (!w || !h) return { ok: false, error: 'PNG 缺少 IHDR' }
  if (!idat.length) return { ok: false, error: 'PNG 没有 IDAT' }
  if (w > 20000 || h > 20000) return { ok: false, error: `尺寸过大 ${w}x${h}` }
  if (w * h > 64 * 1024 * 1024) return { ok: false, error: `像素总量过大 ${w}x${h}(超过 6400 万,拒绝解码以防内存溢出)` }

  let raw: Uint8Array
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idat)))
  } catch (e) {
    return { ok: false, error: 'IDAT 解压失败: ' + String(e) }
  }

  // 每像素字节数(bitDepth>=8 时)
  const chan = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : 4
  const bpp = Math.max(1, (chan * depth) / 8)

  let rgba: Uint8Array
  try {
    if (depth < 8) {
      // 位深 1/2/4:仅对灰度(color 0)与调色板(color 3)有意义
      const bitsPerRow = w * depth
      const stride = Math.ceil(bitsPerRow / 8)
      const px = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        const ft = raw[y * (stride + 1)]
        const src = y * (stride + 1) + 1
        const line = raw.subarray(src, src + stride)
        const cur = new Uint8Array(stride)
        for (let i = 0; i < stride; i++) {
          const a = i > 0 ? cur[i - 1] : 0
          const b = y > 0 ? raw[(y - 1) * (stride + 1) + 1 + i] : 0
          const c = y > 0 && i > 0 ? raw[(y - 1) * (stride + 1) + i] : 0
          let v: number
          switch (ft) {
            case 0: v = line[i]; break
            case 1: v = line[i] + a; break
            case 2: v = line[i] + b; break
            case 3: v = line[i] + ((a + b) >> 1); break
            default: v = line[i] + paeth(a, b, c)
          }
          cur[i] = v & 0xff
        }
        for (let x = 0; x < w; x++) {
          const bit = x * depth
          const byte = cur[bit >> 3]
          const shift = 8 - depth - (bit & 7)
          const mask = (1 << depth) - 1
          px[y * w + x] = (byte >> shift) & mask
        }
      }
      if (color === 3) {
        if (!plte) return { ok: false, error: '调色板 PNG 缺 PLTE' }
        rgba = paletteToRgba(px, w, h, plte, trns)
      } else {
        // 灰度位深<8:按比例放大到 0~255
        const max = (1 << depth) - 1
        rgba = new Uint8Array(w * h * 4)
        for (let i = 0; i < w * h; i++) {
          const v = Math.round((px[i] / max) * 255)
          rgba[i * 4] = v
          rgba[i * 4 + 1] = v
          rgba[i * 4 + 2] = v
          rgba[i * 4 + 3] = 255
        }
      }
    } else {
      const px = unfilter(raw, w, h, bpp)
      const full = interlace === 1 ? deinterlace(px, w, h, bpp) : px
      rgba = new Uint8Array(w * h * 4)
      const step = depth === 16 ? 2 : 1
      for (let i = 0; i < w * h; i++) {
        const s = i * bpp
        const d = i * 4
        if (color === 0) {
          const v = full[s]
          rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; rgba[d + 3] = 255
        } else if (color === 2) {
          rgba[d] = full[s]; rgba[d + 1] = full[s + 1]; rgba[d + 2] = full[s + 2]; rgba[d + 3] = 255
        } else if (color === 3) {
          const p = full[s]
          if (!plte) return { ok: false, error: '调色板 PNG 缺 PLTE' }
          rgba[d] = plte[p * 3]; rgba[d + 1] = plte[p * 3 + 1]; rgba[d + 2] = plte[p * 3 + 2]
          rgba[d + 3] = trns && p < trns.length ? trns[p] : 255
        } else if (color === 4) {
          const v = full[s]
          rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; rgba[d + 3] = full[s + step]
        } else {
          rgba[d] = full[s]; rgba[d + 1] = full[s + step]; rgba[d + 2] = full[s + step * 2]
          rgba[d + 3] = full[s + step * 3]
        }
      }
    }
  } catch (e) {
    return { ok: false, error: '像素重建失败: ' + String(e) }
  }

  return { ok: true, format: `PNG${depth}${ctName(color)}${interlace ? 'I' : ''}`, bitmap: { rgba, w, h } }
}

/** colorType 的可读名,用于 format 字段(与 dds.ts 的 RGB32/DXT5 风格对齐) */
function ctName(c: number): string {
  return c === 0 ? 'GRAY' : c === 2 ? 'RGB' : c === 3 ? 'PAL' : c === 4 ? 'GRAYA' : 'RGBA'
}
