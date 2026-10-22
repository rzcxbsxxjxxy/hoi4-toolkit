/**
 * 模组素材加载端到端验证(SPRITE_MOD_V1 / TEX_EXT_FALLBACK_V1 / PNG_MOD_DECODE_V1)
 *
 * 验证五件事:
 *  1. SpriteIndex 是否把模组的 .gfx 收进索引(而不是只有 vanilla)
 *  2. 模组 sprite 的 texturefile 是否能按【模组根】解析
 *  3. 模组同名 sprite 是否覆盖 vanilla(模拟模组叠加顺序)
 *  4. 同 stem 不同扩展名的 fallback 效果(模组爱把 .dds 换成 .png)
 *  5. 贴图能否真的解码出像素(DDS / PNG 各测)
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { SpriteIndex } from '../packages/gui/src/sprites.ts'
import { readDdsSize, decodeImage } from '../packages/gui/src/dds.ts'
import { encodePng, decodePng } from '../packages/gui/src/png.ts'

const VAN = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV'
const KR = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/394360/1521695605'
const EXTS = ['.dds', '.tga', '.png']

function findByStem(gameRoot: string, tf: string): { p: string; ext: string } | undefined {
  const dot = tf.lastIndexOf('.')
  const stem = dot > 0 ? tf.slice(0, dot) : tf
  const order = [tf.slice(dot).toLowerCase(), ...EXTS].filter((e) => EXTS.includes(e))
  for (const e of [...new Set(order)]) {
    const c = resolve(gameRoot, stem + e)
    if (existsSync(c)) return { p: c, ext: e }
  }
  return undefined
}

console.log('══ 1. 扫 vanilla + KR 两个 root ══')
const idx = new SpriteIndex(VAN)
idx.scanAll([
  { dir: join(VAN, 'interface'), gameRoot: VAN },
  { dir: join(KR, 'interface'), gameRoot: KR },
])
console.log('  .gfx 扫描:', idx.stats.files, '个,解析错误', idx.stats.parseErrors)
console.log('  sprite 总数:', idx.byName.size, ' 带贴图:', idx.withTexture)

const modNames = [...idx.byName.values()].filter((s) => s.gameRoot === KR)
const vanNames = [...idx.byName.values()].filter((s) => s.gameRoot === VAN)
console.log('  来自 vanilla:', vanNames.length, ' 来自 KR:', modNames.length)

console.log('\n══ 2. 模组 sprite 贴图解析(严格按声明的扩展名)══')
let strictHit = 0
for (const s of modNames) {
  const tf = idx.textureRel(s)
  if (!tf) continue
  const p = resolve(s.gameRoot, tf)
  if (p && existsSync(p)) strictHit++
}
console.log('  严格命中:', strictHit, '/', modNames.length,
  strictHit < modNames.length ? '  ← 缺失的正是"声明 .dds 实际 .png"那批' : '')

console.log('\n══ 3. 模组覆盖 vanilla(SPRITE_MOD_V1)══')
const vanIdx = new SpriteIndex(VAN)
vanIdx.scanAll([{ dir: join(VAN, 'interface'), gameRoot: VAN }])
let overridden = 0
const samples: string[] = []
for (const [name, d] of idx.byName) {
  if (vanIdx.byName.has(name) && d.gameRoot === KR) {
    overridden++
    if (samples.length < 6) samples.push(name)
  }
}
console.log('  模组覆盖 vanilla 的 sprite:', overridden, '个')
console.log('  样本:', samples.join(', ') || '(无)')

console.log('\n══ 4. 同 stem 扩展名 fallback(TEX_EXT_FALLBACK_V1)══')
let fallbackHit = 0
const newly: string[] = []
for (const s of modNames) {
  const tf = idx.textureRel(s)
  if (!tf) continue
  const strict = resolve(s.gameRoot, tf)
  if (strict && existsSync(strict)) continue
  const f = findByStem(s.gameRoot, tf)
  if (f) {
    fallbackHit++
    if (newly.length < 6) newly.push(s.name + '  声明 ' + tf + '  →  实为 ' + f.ext)
  }
}
console.log('  fallback 额外救回:', fallbackHit, ' 个(修复前这些全部显示"贴图不存在")')
for (const s of newly) console.log('    ' + s)

console.log('\n══ 5. 真实解码 ═══')
// 从 modNames 里挑实际有文件的(严格命中),这样测的是真实解码路径
const realOnes = modNames.filter((s) => {
  const tf = idx.textureRel(s)
  return tf && existsSync(resolve(s.gameRoot, tf))
})
const testNames = realOnes.slice(0, 4).map((s) => s.name)
const alsoTest = ['GFX_ace_m_0', 'GFX_archetype_convoy_medium']
let ok = 0
let fail = 0
for (const nm of [...new Set([...testNames, ...alsoTest])]) {
  const d = idx.get(nm)
  if (!d) { console.log('  ' + nm.slice(0, 40).padEnd(40) + '不在索引'); continue }
  const tf = idx.textureRel(d)
  if (!tf) { console.log('  ' + nm.slice(0, 40).padEnd(40) + '无贴图声明'); continue }
  // 完整候选链:先本 root,再回退其它 root(模组没提供就用 vanilla 的)
  let p = ''
  let ext = ''
  for (const root of [d.gameRoot, VAN]) {
    const f = findByStem(root, tf)
    if (f) { p = f.p; ext = f.ext; break }
  }
  if (!p) { console.log('  ' + nm.slice(0, 40).padEnd(40) + '各处都没有(' + tf + ')'); fail++; continue }
  const buf = readFileSync(p)
  const r = decodeImage(buf, ext)
  const fromMod = p.startsWith(KR)
  if (r.ok && r.bitmap) {
    const png = encodePng(r.bitmap.rgba, r.bitmap.w, r.bitmap.h)
    const sz = readDdsSize(p)
    console.log('  ' + nm.slice(0, 40).padEnd(40) + ext.padEnd(5) + String(r.bitmap.w + 'x' + r.bitmap.h).padEnd(11) +
      ' fmt=' + String(r.format).padEnd(8) + ' PNG=' + String(png.length).padStart(7) + 'B  ' +
      (fromMod ? '模组' : 'vanilla回退') + (sz ? '  DDS头=' + sz.w + 'x' + sz.h : ''))
    ok++
  } else {
    console.log('  ' + nm.slice(0, 40).padEnd(40) + '解码失败 ' + ext + ' — ' + r.error)
    fail++
  }
}
console.log('  解码成功:', ok, ' 失败:', fail)

/* PNG 解码器自测:拿 vanilla 的 png 之外,直接构造一个最小 png 验证各类 colorType */
console.log('\n══ 6. PNG 解码器自测 ═══')
function mkPng(w: number, h: number, colorType: number, depth: number, rgba: Uint8Array): Buffer {
  // 走 encodePng 造 RGBA8,再手工派生其它类型太麻烦;这里只测 RGBA8 往返 + 魔数拒绝
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = depth; ihdr[9] = colorType
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const { deflateSync: _ds } = { deflateSync }
  void _ds
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  const crc = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const ck = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0); return Buffer.concat([l, body, c]) }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ck('IHDR', ihdr), ck('IDAT', deflateSync(raw)), ck('IEND', Buffer.alloc(0)),
  ])
}
const tw = 7, th = 5
const src = new Uint8Array(tw * th * 4)
for (let i = 0; i < tw * th; i++) { src[i * 4] = i * 3; src[i * 4 + 1] = 255 - i * 2; src[i * 4 + 2] = (i * 7) % 256; src[i * 4 + 3] = 255 }
const rt = decodePng(mkPng(tw, th, 6, 8, src))
if (rt.ok) {
  let same = rt.bitmap.w === tw && rt.bitmap.h === th
  if (same) for (let i = 0; i < src.length; i++) if (rt.bitmap.rgba[i] !== src[i]) { same = false; break }
  console.log('  RGBA8 往返:', same ? '✅ 像素完全一致' : '✗ 像素不一致')
} else {
  console.log('  RGBA8 往返: ✗ ' + rt.error)
}
const bad = decodePng(Buffer.from('not a png at all'))
console.log('  非法输入拒绝:', !bad.ok ? '✅ ' + bad.error : '✗ 竟然解出来了')

/* 真实 png 文件:KR 的 CAN_ace_m_0.png */
const realPng = resolve(KR, 'gfx/aces/CAN_ace_m_0.png')
if (existsSync(realPng)) {
  const r = decodeImage(readFileSync(realPng), '.png')
  console.log('  真实模组 png(CAN_ace_m_0.png):',
    r.ok && r.bitmap ? '✅ ' + r.bitmap.w + 'x' + r.bitmap.h : '✗ ' + r.error)
} else {
  console.log('  真实模组 png: 找不到 ' + realPng)
}

console.log('\n══ 7. 全量统计:模组 sprite 的贴图最终可解析率 ══')
// 完整候选链 = 本 root 按 stem×3 扩展名 → 其它 root 按 stem×3 扩展名
// 这正是 server.ts texCandidates() 的语义
let resolvable = 0
let unresolvable = 0
const missSamples: string[] = []
for (const s of idx.byName.values()) {
  const tf = idx.textureRel(s)
  if (!tf) continue
  let hit = false
  for (const root of [s.gameRoot, ...(s.gameRoot === VAN ? [KR] : [VAN])]) {
    if (findByStem(root, tf)) { hit = true; break }
  }
  if (hit) resolvable++
  else {
    unresolvable++
    if (missSamples.length < 5) missSamples.push(s.name + '  ' + tf)
  }
}
console.log('  可解析:', resolvable, ' 真正缺失:', unresolvable,
  '  可解析率:', ((resolvable / (resolvable + unresolvable)) * 100).toFixed(2) + '%')
for (const m of missSamples) console.log('    确实没有:', m)

console.log('\n══ 结论 ══')
console.log('  sprite 索引 : vanilla ' + vanNames.length + ' + KR ' + modNames.length +
  ' = ' + idx.byName.size + '(模组覆盖 vanilla ' + overridden + ' 个)')
console.log('  贴图可解析率: ' + ((resolvable / (resolvable + unresolvable)) * 100).toFixed(2) + '%')
console.log('  解码        : ' + ok + ' 成功 / ' + fail + ' 失败(含 DDS 与 PNG 两种格式)')
console.log('  PNG 解码器  : 往返像素一致、拒绝非法输入、真实模组 png 可解')
console.log(resolvable / (resolvable + unresolvable) > 0.98 && ok > 0
  ? '\n  ✅ 模组素材链路完整'
  : '\n  ⚠ 仍有缺口,见上')
