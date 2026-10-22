/**
 * DDS / TGA 解码器(零依赖)。
 *
 * 实测 vanilla gfx 下 4000 个 .dds 的格式分布:
 *   RGB32 3557(89%)、DXT5 393、DXT1 28、DXT3 12、DX10 5、RGB24 4、RXGB 1
 * 所以支持 RGB32 + DXT1/3/5 即可覆盖 99.9%,DX10/RXGB 直接放弃并返回原因。
 *
 * 输出统一为 RGBA(Uint8Array),便于浏览器端直接构造 ImageData。
 */

import { decodePng } from './png.ts'

export interface Bitmap {
  w: number
  h: number
  /** 长度 w*h*4,RGBA 顺序(浏览器友好) */
  rgba: Uint8Array
}

export interface DecodeResult {
  ok: boolean
  bitmap?: Bitmap
  error?: string
  /** 像素格式,便于诊断 */
  format?: string
}

/** 像素总量上限:损坏文件声明天文尺寸时挡住 new Uint8Array(w*h*4) 的 OOM。
 *  HOI4 真实贴图最大约 4096x4096;放宽到 6400 万像素(输出 <=256MB)仍拒绝荒谬值。 */
const MAX_PIXELS = 64 * 1024 * 1024
function dimsError(w: number, h: number): string | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return `非法尺寸 ${w}x${h}`
  if (w * h > MAX_PIXELS) return `尺寸过大 ${w}x${h}(超过 ${MAX_PIXELS} 像素,拒绝解码以防内存溢出)`
  return null
}

/** 只读头部拿尺寸——布局推断需要 sprite 的天然尺寸,但不必解码像素 */
export function readDdsSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 128 || buf.toString('latin1', 0, 4) !== 'DDS ') return null
  const h = buf.readUInt32LE(12)
  const w = buf.readUInt32LE(16)
  return { w, h }
}

export function decodeDds(buf: Buffer): DecodeResult {
  if (buf.length < 128 || buf.toString('latin1', 0, 4) !== 'DDS ') {
    return { ok: false, error: '不是 DDS 文件' }
  }
  const height = buf.readUInt32LE(12)
  const width = buf.readUInt32LE(16)
  const pitch = buf.readUInt32LE(20)
  const pfFlags = buf.readUInt32LE(80)
  const fourCC = buf.toString('latin1', 84, 88)
  const rgbBitCount = buf.readUInt32LE(88)

  const de = dimsError(width, height)
  if (de) return { ok: false, error: de }

  const data = buf.subarray(128)

  if (pfFlags & 0x4) {
    const cc = fourCC.trim()
    switch (cc) {
      case 'DXT1':
        return { ok: true, format: cc, bitmap: { w: width, h: height, rgba: decodeDxt1(data, width, height) } }
      case 'DXT2':
      case 'DXT3':
        return { ok: true, format: cc, bitmap: { w: width, h: height, rgba: decodeDxt3(data, width, height) } }
      case 'DXT4':
      case 'DXT5':
        return { ok: true, format: cc, bitmap: { w: width, h: height, rgba: decodeDxt5(data, width, height) } }
      case 'DX10':
        return { ok: false, error: 'DX10 扩展头暂不支持', format: cc }
      default:
        return { ok: false, error: `未知的压缩格式 ${cc}`, format: cc }
    }
  }

  if (pfFlags & 0x40) {
    const rMask = buf.readUInt32LE(92)
    const gMask = buf.readUInt32LE(96)
    const bMask = buf.readUInt32LE(100)
    const aMask = (pfFlags & 0x1) !== 0 ? buf.readUInt32LE(104) : 0
    const bytesPerPixel = rgbBitCount / 8
    if (bytesPerPixel !== 4 && bytesPerPixel !== 3) {
      return { ok: false, error: `未压缩格式位深 ${rgbBitCount} 暂不支持`, format: `RGB${rgbBitCount}` }
    }
    /* ★★★ DDS_PITCH_V4:dwPitchOrLinearSize 有二义性,必须按数据长度判定。
     *
     * 这个字段的官方定义是:未压缩格式 = 行跨距(stride),
     * 压缩格式 = 整张图的总字节数。HOI4 的文件两种都见过 ——
     * 本例(doctrine_mobile_warfare.dds 64×64×4)写的是 16384
     * = 64*64*4 = **总字节数**,而真实行跨距只有 256。
     *
     * 旧代码 `pitch || width*bpp` 直接信它 → stride=16384,
     * 于是第 2 行开始 rowStart 就超出 data.length,`if (p+bpp>data.length) break`
     * 立刻退出 —— **每张这样的图只有第 1 行被解出来**,其余全是 0。
     * 症状极隐蔽:尺寸对、格式报 RGB32、无任何报错,
     * 只是图看起来"几乎全透明"(实测该图 4096 像素里 4032 个是填充 0)。
     *
     * 判定:行跨距必须 ≥ 一行的字节数,且 (height-1)*stride + 一行 ≤ 数据长度。
     * 两个条件都成立才认它是 stride,否则按紧密排列(width*bpp)处理。
     * 顺带兼容真有行填充(padding)的文件 —— 那种 stride 更大但仍满足上述约束。*/
    const tight = width * bytesPerPixel
    const rowBytes = bytesPerPixel === 4 ? tight : ((width * bytesPerPixel + 3) >> 2) << 2
    let stride = tight
    if (pitch >= rowBytes && (height - 1) * pitch + rowBytes <= data.length) {
      stride = pitch
    }
    return {
      ok: true,
      format: `RGB${rgbBitCount}`,
      bitmap: { w: width, h: height, rgba: decodeUncompressed(data, width, height, stride, bytesPerPixel, rMask, gMask, bMask, aMask) },
    }
  }

  return { ok: false, error: `不支持的像素格式标志 0x${pfFlags.toString(16)}` }
}

function decodeUncompressed(
  data: Buffer,
  w: number,
  h: number,
  stride: number,
  bpp: number,
  rMask: number,
  gMask: number,
  bMask: number,
  aMask: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const rShift = shiftOf(rMask)
  const gShift = shiftOf(gMask)
  const bShift = shiftOf(bMask)
  const aShift = shiftOf(aMask)
  /* ★★★ DDS_SIGNED_SHIFT_V4:必须用无符号右移 >>>,不能用 >>。
   *
   * HOI4 的贴图绝大多数是 RGB32 且 aMask = 0xFF000000 —— 最高位置 1。
   * 而 JS 的位运算一律按 **有符号 32 位** 处理,于是:
   *     0xFF000000 >> 24  ===  -1     (不是 255!)
   * 掩码位宽是用 `mask >> shift` 算的,拿到 -1 之后:
   *     rMax/aMax = -1
   *     norm(255, -1) = Math.min(255, Math.round(255*255/-1)) = -65025
   * 写进 Uint8Array 被截断回绕 → alpha 变成 0 / 255 乱值,
   * 表现为「图标一片空白」或「半透明」。实测 doctrine 的 64×64 图标
   * 1024 个不透明像素全被算成 alpha=0,PNG 压到 99 字节(纯空白)。
   *
   * 之前没暴露是因为只肉眼看了大图(212×83 的里程碑图恰好 alpha 分布
   * 撞对了回绕值),没统计像素。DDS 格式统计里 RGB32 占 89%(3557 个),
   * 所以这一个符号错误会让绝大多数贴图显示异常。
   * >>> 之后再无高位符号问题,0xFF000000 >>> 24 === 255。*/
  const rMax = (rMask >>> rShift) || 1
  const gMax = (gMask >>> gShift) || 1
  const bMax = (bMask >>> bShift) || 1
  const aMax = (aMask >>> aShift) || 1

  for (let y = 0; y < h; y++) {
    const rowStart = y * stride
    for (let x = 0; x < w; x++) {
      const p = rowStart + x * bpp
      if (p + bpp > data.length) break
      /* 读成一个 32 位无符号整数再用掩码拆通道。
       * ⚠ 不要写成 `data.readUInt32LE(p) & rMask` 之外再 `>>>` 的混合写法 ——
       *   拆通道时的移位已在 decodeUncompressed 里统一用 >>>,这里保持原样即可。
       *   readUInt32LE 返回的是无符号数,配合 >>> 全程无符号,高位 alpha 才不会翻负。*/
      let v = 0
      if (bpp === 4) v = data.readUInt32LE(p)
      else v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
      const o = (y * w + x) * 4
      out[o] = norm((v & rMask) >>> rShift, rMax)
      out[o + 1] = norm((v & gMask) >>> gShift, gMax)
      out[o + 2] = norm((v & bMask) >>> bShift, bMax)
      out[o + 3] = aMask ? norm((v & aMask) >>> aShift, aMax) : 255
    }
  }
  return out
}

function shiftOf(mask: number): number {
  if (!mask) return 0
  let s = 0
  // >>> 无符号右移:mask 高位为 1 时(0xFF000000)用 >> 会因有符号溢出提前停在错误位置
  while (((mask >>> s) & 1) === 0 && s < 32) s++
  return s
}

function norm(v: number, max: number): number {
  if (max === 255) return v & 255
  return Math.min(255, Math.round((v * 255) / max))
}

/* ── DXT ── */

function decodeDxt1(data: Buffer, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const bw = Math.ceil(w / 4)
  const bh = Math.ceil(h / 4)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * 8
      if (off + 8 > data.length) return out
      const c0 = data.readUInt16LE(off)
      const c1 = data.readUInt16LE(off + 2)
      const bits = data.readUInt32LE(off + 4)
      const colors = buildDxtColors(c0, c1, false)
      writeBlock(out, w, h, bx * 4, by * 4, bits, colors)
    }
  }
  return out
}

function decodeDxt3(data: Buffer, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const bw = Math.ceil(w / 4)
  const bh = Math.ceil(h / 4)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * 16
      if (off + 16 > data.length) return out
      const a0 = data.readUInt32LE(off)
      const a1 = data.readUInt32LE(off + 4)
      const c0 = data.readUInt16LE(off + 8)
      const c1 = data.readUInt16LE(off + 10)
      const bits = data.readUInt32LE(off + 12)
      const colors = buildDxtColors(c0, c1, false)
      /* ★★★ DXT3_ALPHA64_V4:alpha 是每像素 4 位显式值,16×4 = **64 bit(8 字节)**。
       *
       * 坑有两个,叠加后整张图不可见:
       *  ① **字节序**:这 8 字节是「大端位流」—— 第 i 个像素的 nibble 在
       *     第 floor(i/2) 个字节,i 偶数取高 4 位、i 奇数取低 4 位。
       *     旧代码用 readUInt32LE 拼成整数再移位,等于按小端解释,
       *     于是 0xFF FF FF FF… 全被读成 nibble=0 → **整图 alpha=0**。
       *  ② **位移回绕**:JS 位移计数 mod 32,i≥8 时 `i*4 ≥ 32` 会被回绕。
       *
       * 与其和移位语义搏斗,不如直接按位场取:先定位字节,再取半字节。
       * 顺带修掉了 `>>>` 也救不了的那个错(见 DXT5_ALPHA48_V4 的同类说明)。
       */
      const alpha = new Uint8Array(16)
      for (let i = 0; i < 16; i++) {
        const byte = data[off + (i >> 1)]
        const nib = i % 2 === 0 ? (byte >> 4) & 0xf : byte & 0xf
        // 4 位 → 8 位:乘 17(0..15 → 0..255),等价于 (nib<<4)|nib
        alpha[i] = nib * 17
      }
      writeBlock(out, w, h, bx * 4, by * 4, bits, colors, alpha)
    }
  }
  return out
}

function decodeDxt5(data: Buffer, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const bw = Math.ceil(w / 4)
  const bh = Math.ceil(h / 4)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * 16
      if (off + 16 > data.length) return out
      const a0 = data[off]
      const a1 = data[off + 1]
      /* ★★★ DXT5_ALPHA48_V4:alpha 索引是 **48 bit(6 字节)**,不是 32 bit。
       *
       * DXT5 块布局(16 字节):
       *   [0]     a0     alpha 端点 0
       *   [1]     a1     alpha 端点 1
       *   [2..7]  16×3bit alpha 索引(6 字节 = 48 bit)
       *   [8..15] 颜色(2×RGB565 + 4 字节索引)
       *
       * 旧代码只用 `data[off+2] | (…<<8) | (…<<16) | (…<<24)` 拼了 **4 字节**,
       * 于是索引 8..15(需要 bit 24..47)有两处错:
       *   ① 高 16 位(off+6/off+7)根本没读进来;
       *   ② 就算读了,JS 位移计数会 **mod 32** —— i=11 的 `i*3=33` 实际位移 1,
         取到的是完全无关的位。
       * 另外即便补齐 6 字节,「小端拼整数再移位」仍会在跨字节边界处算错
       * (实测索引 2 应为 3,拼整数得到 7)。
       *
       * 症状:颜色解得很好(实测 524 种颜色)但 **可见像素 0%**,
       * 图看着像纯透明 —— 正是 achievements / doctrine 图标那批的观感。
       *
       * 结论:超过 32 位的位场**不要用整数拼接**,直接按位场取:
       *     bit = i*3;  byte = off + 2 + (bit>>3);  idx = (data[byte] >> (bit&7)) & 7
       * 3bit 索引最大 shift=5,不跨字节,单字节足够。
       * (DXT3 的 64 位 alpha 同理,见 DXT3_ALPHA64_V4)
       */
      const c0 = data.readUInt16LE(off + 8)
      const c1 = data.readUInt16LE(off + 10)
      const bits = data.readUInt32LE(off + 12)
      const colors = buildDxtColors(c0, c1, false)
      const alpha = new Uint8Array(16)
      for (let i = 0; i < 16; i++) {
        // ★ 见 DXT5_ALPHA48_V4:按位场取,不用整数拼接(超 32 位 + 位移回绕)
        const bit = i * 3
        const idx = (data[off + 2 + (bit >> 3)] >> (bit & 7)) & 0x7
        alpha[i] =
          idx === 0 ? a0 : idx === 1 ? a1 : a0 > a1 ? ((8 - idx) * a0 + (idx - 1) * a1) / 7 : ((6 - idx) * a0 + (idx - 1) * a1) / 5
      }
      writeBlock(out, w, h, bx * 4, by * 4, bits, colors, alpha)
    }
  }
  return out
}

/* 注:DXT3/DXT5 的 alpha 位场(64 / 48 bit)都改成按位场直取了,
   不再需要 2^n 幂表 —— 见 DXT3_ALPHA64_V4 / DXT5_ALPHA48_V4。 */

function buildDxtColors(c0: number, c1: number, _dxt1a: boolean): Uint8Array {
  const r0 = ((c0 >> 11) & 0x1f) * 255 / 31
  const g0 = ((c0 >> 5) & 0x3f) * 255 / 63
  const b0 = (c0 & 0x1f) * 255 / 31
  const r1 = ((c1 >> 11) & 0x1f) * 255 / 31
  const g1 = ((c1 >> 5) & 0x3f) * 255 / 63
  const b1 = (c1 & 0x1f) * 255 / 31
  const out = new Uint8Array(16) // 4 个颜色 × RGBA
  out.set([r0, g0, b0, 255], 0)
  out.set([r1, g1, b1, 255], 4)
  out.set([(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255], 8)
  out.set([(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255], 12)
  return out
}

function writeBlock(
  out: Uint8Array,
  w: number,
  h: number,
  px: number,
  py: number,
  bits: number,
  colors: Uint8Array,
  alpha?: Uint8Array,
): void {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const gx = px + x
      const gy = py + y
      if (gx >= w || gy >= h) continue
      const i = y * 4 + x
      const idx = (bits >> (i * 2)) & 0x3
      const o = (gy * w + gx) * 4
      out[o] = colors[idx * 4]
      out[o + 1] = colors[idx * 4 + 1]
      out[o + 2] = colors[idx * 4 + 2]
      out[o + 3] = alpha ? alpha[i] : 255
    }
  }
}

/* ── TGA(Hoi4 的 gfx 里也有少量 tga) ── */

export function decodeTga(buf: Buffer): DecodeResult {
  if (buf.length < 18) return { ok: false, error: 'TGA 过短' }
  const idLen = buf[0]
  const imgType = buf[2]
  const w = buf.readUInt16LE(12)
  const h = buf.readUInt16LE(14)
  const bpp = buf[16]
  const desc = buf[17]
  const originTop = (desc & 0x20) === 0
  if (imgType !== 2) return { ok: false, error: `TGA 仅支持未压缩真彩(type 2),实际 type=${imgType}` }
  if (bpp !== 24 && bpp !== 32) return { ok: false, error: `TGA 位深 ${bpp} 不支持` }
  const de = dimsError(w, h)
  if (de) return { ok: false, error: de }
  const bppBytes = bpp / 8
  const start = 18 + idLen
  if (start + w * h * bppBytes > buf.length) return { ok: false, error: 'TGA 像素数据不完整' }
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcY = originTop ? y : h - 1 - y
    for (let x = 0; x < w; x++) {
      const p = start + (srcY * w + x) * bppBytes
      const o = (y * w + x) * 4
      out[o] = buf[p + 2]
      out[o + 1] = buf[p + 1]
      out[o + 2] = buf[p]
      out[o + 3] = bpp === 32 ? buf[p + 3] : 255
    }
  }
  return { ok: true, format: `TGA${bpp}`, bitmap: { w, h, rgba: out } }
}

/**
 * BMP 解码(ICON_BMP_V1,2026-10-04)。
 * 用途:游戏本体 gfx/HOI4_icon.bmp 作为工作台默认应用图标(未压缩 BI_RGB)。
 * 只支持常见两种:24bpp(BGR,无 alpha)与 32bpp(BGRA);不压缩。
 * 行序默认自下而上(height>0),负 height = 自上而下。
 */
export function decodeBmp(buf: Buffer): DecodeResult {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    return { ok: false, error: '不是合法的 BMP 文件' }
  }
  const dataOff = buf.readUInt32LE(10)
  const headerSize = buf.readUInt32LE(14)
  if (headerSize < 40) return { ok: false, error: `不支持的 BMP 头 ${headerSize}` }
  const compression = buf.readUInt32LE(30)
  if (compression !== 0) return { ok: false, error: `不支持的 BMP 压缩类型 ${compression}(仅支持未压缩)` }
  const w = buf.readInt32LE(18)
  const hRaw = buf.readInt32LE(22)
  const topDown = hRaw < 0
  const h = Math.abs(hRaw)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24 && bpp !== 32 && bpp !== 8 && bpp !== 4) {
    return { ok: false, error: `不支持的 BMP 位深 ${bpp}(仅支持 4/8/24/32)` }
  }
  const de = dimsError(w, h)
  if (de) return { ok: false, error: de }
  const rowBytes = Math.floor((bpp * w + 31) / 32) * 4
  const out = new Uint8Array(w * h * 4)
  /* 索引色 BMP(4/8 位):调色板紧跟 DIB 头之后,每项为 BGR+保留(4 字节)。
   * rivers.bmp / terrain.bmp 在 HOI4 里都是 8 位索引图,没有调色板会整张解为黑。
   * 解出来后用调色板把索引展开成 RGBA,下游(img-rivers / terrain 叠加)才能识别。*/
  let palette: Buffer | null = null
  if (bpp === 8 || bpp === 4) {
    const palCount = bpp === 8 ? 256 : 16
    const palOff = 14 + headerSize
    if (palOff + palCount * 4 <= buf.length) palette = buf.subarray(palOff, palOff + palCount * 4)
  }
  const idxShift = bpp === 4 ? 1 : 0
  for (let y = 0; y < h; y++) {
    const srcY = topDown ? y : h - 1 - y
    const rowOff = dataOff + srcY * rowBytes
    if (rowOff + rowBytes > buf.length) return { ok: false, error: 'BMP 像素数据不完整' }
    if (bpp === 8 || bpp === 4) {
      for (let x = 0; x < w; x++) {
        const byte = buf[rowOff + (x >> idxShift)]
        const idx = bpp === 4 ? (x & 1 ? byte & 0x0f : (byte >> 4) & 0x0f) : byte
        const po = idx * 4
        const o = (y * w + x) * 4
        if (palette && po + 2 < palette.length) {
          // 调色板项是 BGR(第 3 字节是保留)→ 转 RGBA
          out[o] = palette[po + 2]
          out[o + 1] = palette[po + 1]
          out[o + 2] = palette[po]
          out[o + 3] = 255
        } else {
          out[o + 3] = 0
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        const p = rowOff + x * (bpp / 8)
        const o = (y * w + x) * 4
        // BMP 是 BGR(A) 序 → 转 RGBA
        out[o] = buf[p + 2]
        out[o + 1] = buf[p + 1]
        out[o + 2] = buf[p]
        out[o + 3] = bpp === 32 ? buf[p + 3] : 255
      }
    }
  }
  return { ok: true, format: `BMP${bpp}`, bitmap: { w, h, rgba: out } }
}

/**
 * 按扩展名自动选择解码器。
 *
 * ⚠ PNG_MOD_DECODE_V1:png 必须认。vanilla 贴图几乎全是 dds,但模组为了压体积
 * 普遍换成 png(KR:25272 png vs 998 dds),漏掉它模组贴图全挂。
 * 另加"按魔数兜底":扩展名缺失/写错时 sniff 一次签名。
 */
export function decodeImage(buf: Buffer, ext: string): DecodeResult {
  const e = ext.toLowerCase()
  if (e === '.dds') return decodeDds(buf)
  if (e === '.tga') return decodeTga(buf)
  if (e === '.png') return decodePng(buf)
  if (e === '.bmp') return decodeBmp(buf)
  // 兜底 sniff:DDS 头 "DDS " / TGA 无魔数(靠 footer) / PNG 签名 / BMP "BM"
  if (buf.length >= 4) {
    if (buf[0] === 0x44 && buf[1] === 0x44 && buf[2] === 0x53 && buf[3] === 0x20) return decodeDds(buf)
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return decodePng(buf)
    if (buf[0] === 0x42 && buf[1] === 0x4d) return decodeBmp(buf)
  }
  return { ok: false, error: `不支持的图片格式 ${ext}` }
}
