/**
 * sprite 索引:name → texturefile / 定义位置 / 天然像素尺寸。
 *
 * 两个用途:
 *  1. 预览时解析 iconType 的 spriteType = "GFX_xxx" 到底用哪张图;
 *  2. iconType 常常不写 size —— 此时 HOI4 用贴图本身的像素尺寸作为元素尺寸,
 *     所以布局推断必须能拿到贴图宽高(只读 DDS 头即可,不必解码像素)。
 *
 * 多 root:贴图路径是相对各 root 的(模组自带的 gfx 在模组目录下),
 * 所以每个定义要记住自己来自哪个 root,不能统一按游戏根目录解析。
 *
 * 注意:.gfx 里"可被引用的命名元素"不止 spriteType,实测有 11 种
 * (spriteType / SpriteType / frameAnimatedSpriteType / corneredTileSpriteType /
 *  progressbartype / textSpriteType / maskedShieldType / pieChartType /
 *  circularProgressbarType / lineChartType,以及 objectTypes 下的 arrowType)。
 * 只匹配 spriteType 会大量误报缺失 —— 这里统一按"带 name 的块"采集。
 *
 * 采集范围必须是 .gfx 的 spriteTypes / objectTypes,不能图省事扫全部文件:
 * 早期版本连同 .gui 一起扫,把"任何带 name 的块"都当贴图,于是 .gui 的元素名
 * (containerWindowType / iconType / instantTextboxType…)被收进索引 ——
 * 33886 条里 8574 条(25%)来自 .gui,spriteType 自动补全被污染得没法用。
 * 实测 .gui 从不定义 spriteTypes(0/453),所以只扫 .gfx 是安全的。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, resolve } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import type { Document, Block, Entry } from '../../parser/src/ast.ts'
import { readDdsSize } from './dds.ts'

export interface SpriteDef {
  name: string
  /** 如 gfx/interface/traits/trait_jaeger.dds */
  texturefile?: string
  /** progressbartype 用 textureFile1/2 而不是 texturefile */
  textureFile1?: string
  textureFile2?: string
  /** 定义里显式声明的尺寸(progressbartype 的 size = {x= y=}) */
  defW?: number
  defH?: number
  noOfFrames?: number
  type: string
  /** 定义所在文件(相对该 root 的 interface 目录) */
  file: string
  line: number
  /** 该定义来自哪个 root —— 贴图路径按它解析 */
  gameRoot: string
  /** DLC 时:贴图物理根(DLC 目录),供 texturePath 优先解析 */
  texRoot?: string
  /** corneredTileSpriteType 九宫格边框(像素) */
  borderW?: number
  borderH?: number
  /** corneredTileSpriteType:中心区域是否平铺 */
  tilingCenter?: boolean
}

export interface SpriteIndexStats {
  files: number
  scannedBytes: number
  sprites: number
  withTexture: number
  parseErrors: number
}

export interface ScanEntry {
  /** interface 目录 */
  dir: string
  /** 该 interface 所属的根目录(游戏本体或模组) */
  gameRoot: string
  /** DLC 时:贴图物理根(DLC 目录) */
  texRoot?: string
}

export class SpriteIndex {
  byName = new Map<string, SpriteDef>()
  private dimsCache = new Map<string, { w: number; h: number } | null>()
  /** 按 sprite 名缓存"最终尺寸"(已含 noOfFrames 折算) */
  private sizeCache = new Map<string, { w: number; h: number } | null>()
  private gameRoot: string
  /**
   * 可选:贴图路径候选探测(由 server 注入 texCandidates)。
   * 注入后 texturePath / computeNaturalSize 按候选顺序找第一个 existsSync 的文件,
   * 与 /api/tex 的多 root + 扩展名回退保持一致(消除"图显示正常但尺寸推断失败")。
   */
  candidateFn?: (rel: string) => string[]
  stats: SpriteIndexStats = { files: 0, scannedBytes: 0, sprites: 0, withTexture: 0, parseErrors: 0 }

  constructor(gameRoot: string) {
    this.gameRoot = gameRoot
  }

  /** 单 root 便捷入口 */
  scan(dirs: string[]): void {
    this.scanAll(dirs.map((d) => ({ dir: d, gameRoot: this.gameRoot })))
  }

  /** 按 root 顺序扫描;后扫的覆盖先扫的(模拟模组叠加顺序) */
  scanAll(entries: ScanEntry[]): void {
    for (const { dir, gameRoot, texRoot } of entries) {
      // 只扫 .gfx —— .gui 里的 name 是元素名,不是贴图名(详见文件头注释)
      for (const p of walkFiles(dir, ['.gfx'])) {
        this.stats.files++
        let src: string
        try {
          src = readFileSync(p, 'utf8')
        } catch {
          continue
        }
        this.stats.scannedBytes += Buffer.byteLength(src)
        let doc: Document
        try {
          doc = parse(src)
        } catch {
          this.stats.parseErrors++
          continue
        }
        if (doc.errors.length) this.stats.parseErrors++
        const rel = relative(dir, p)
        // 只从 spriteTypes / objectTypes 顶层块里采集,避免把 .gfx 里其它带 name 的
        // 结构(如 bitmapfonts)误当贴图
        for (const top of doc.root.entries) {
          const tk = keyText(doc, top)
          if (!tk || !top.block) continue
          const lk = tk.toLowerCase()
          if (lk !== 'spritetypes' && lk !== 'objecttypes') continue
          eachEntry(doc, top.block, (e) => {
            if (!e.block) return
            const def = spriteDefOf(doc, e)
            if (!def) return
            this.byName.set(def.name, { ...def, file: rel, line: lineOf(doc, e), gameRoot, texRoot })
          })
        }
      }
    }
    this.stats.sprites = this.byName.size
    this.stats.withTexture = [...this.byName.values()].filter(
      (s) => s.texturefile || s.textureFile1 || s.textureFile2,
    ).length
  }

  get(name: string): SpriteDef | undefined {
    return this.byName.get(name)
  }

  /** 主贴图相对路径 */
  textureRel(def: SpriteDef): string | undefined {
    return def.texturefile ?? def.textureFile1 ?? def.textureFile2
  }

  /** 贴图绝对路径。
   *
   * 注入 candidateFn 后:按候选顺序(= texCandidates:mod 逆序 → DLC → vanilla,
   * 扩展名 dds/tga/png 回退)找第一个 existsSync 的文件 —— 与 /api/tex 显示用的
   * 解析链完全一致,mod 重定义 sprite 但贴图在 vanilla 时尺寸推断不再失败。
   * 候选顺序本身已含 DLC 层,DLC 优先语义由 server 的 texCandidates 保证。
   * 未注入 candidateFn(单 root 测试等)时回退旧逻辑:texRoot 优先,再 gameRoot。
   */
  texturePath(def: SpriteDef): string | undefined {
    const tf = this.textureRel(def)
    if (!tf) return undefined
    if (this.candidateFn) {
      for (const c of this.candidateFn(tf)) if (existsSync(c)) return c
      return undefined
    }
    if (def.texRoot) {
      const p = resolve(def.texRoot, tf)
      if (existsSync(p)) return p
    }
    return resolve(def.gameRoot, tf)
  }

  /**
   * 贴图天然尺寸。只读头部,不解码像素。
   * frameAnimatedSpriteType 用 noOfFrames 横向切分,单帧宽度 = w / frames。
   */
  naturalSize(name: string): { w: number; h: number } | null {
    // 按 name 缓存最终结果。
    // 坑:不能只按贴图路径缓存原始尺寸 —— frameAnimatedSpriteType 还要除以
    // noOfFrames,缓存命中时漏除会让同一元素两次加载得到不同宽度。
    const cached = this.sizeCache.get(name)
    if (cached !== undefined) return cached
    const size = this.computeNaturalSize(name)
    this.sizeCache.set(name, size)
    return size
  }

  private computeNaturalSize(name: string): { w: number; h: number } | null {
    const def = this.byName.get(name)
    if (!def) return null
    // 1) 定义里显式写了 size(progressbartype 是 size = {x= y=})——最权威
    if (def.defW && def.defH) return { w: def.defW, h: def.defH }
    // 2) 否则读贴图头部
    const abs = this.texturePath(def)
    if (!abs) return null
    let dims = this.dimsCache.get(abs)
    if (dims === undefined) {
      try {
        const buf = readFileSync(abs)
        const ext = extname(abs).toLowerCase()
        if (ext === '.dds') dims = readDdsSize(buf)
        else if (ext === '.tga' && buf.length >= 18) dims = { w: buf.readUInt16LE(12), h: buf.readUInt16LE(14) }
        else dims = null
      } catch {
        dims = null
      }
      this.dimsCache.set(abs, dims)
    }
    if (!dims) return null
    if (def.noOfFrames && def.noOfFrames > 1) return { w: Math.floor(dims.w / def.noOfFrames), h: dims.h }
    return dims
  }
}

/** 递归遍历一个块内的所有 entry(含嵌套) */
function eachEntry(_doc: Document, b: Block, cb: (e: Entry) => void): void {
  for (const e of b.entries) {
    cb(e)
    if (e.block) eachEntry(_doc, e.block, cb)
  }
}

/** 判断一个块是否是"可被引用的命名资源" */
function spriteDefOf(doc: Document, e: Entry): Omit<SpriteDef, 'file' | 'line' | 'gameRoot'> | undefined {
  const type = keyText(doc, e)
  if (!type || !e.block) return undefined
  const name = childValue(doc, e.block, 'name')
  if (!name) return undefined
  const texturefile = childValue(doc, e.block, 'texturefile') ?? childValue(doc, e.block, 'textureFile')
  const f1 = childValue(doc, e.block, 'textureFile1')
  const f2 = childValue(doc, e.block, 'textureFile2')
  const framesRaw = childValue(doc, e.block, 'noOfFrames')
  const noOfFrames = framesRaw ? parseInt(framesRaw, 10) : undefined
  // size 块两种写法:{ width= height= } 与 progressbartype 的 { x= y= }
  let defW: number | undefined
  let defH: number | undefined
  const sb = childBlock(doc, e.block, 'size')
  if (sb) {
    defW = numOr(childValue(doc, sb, 'width') ?? childValue(doc, sb, 'x'))
    defH = numOr(childValue(doc, sb, 'height') ?? childValue(doc, sb, 'y'))
  }
  // corneredTileSpriteType:borderSize = { x= y= }(或 width/height 别名)+ tilingCenter = yes/no。
  // gfx 里大小写不统一(borderSize / bordersize),统一按大小写不敏感找。
  let borderW: number | undefined
  let borderH: number | undefined
  const bb = childBlockCI(doc, e.block, 'borderSize')
  if (bb) {
    borderW = numOr(childValueCI(doc, bb, 'width') ?? childValueCI(doc, bb, 'x'))
    borderH = numOr(childValueCI(doc, bb, 'height') ?? childValueCI(doc, bb, 'y'))
  }
  const tilingRaw = childValueCI(doc, e.block, 'tilingCenter')
  const tilingCenter = tilingRaw ? /^(yes|true|1)$/i.test(tilingRaw) : undefined
  return {
    name,
    texturefile,
    textureFile1: f1,
    textureFile2: f2,
    defW,
    defH,
    noOfFrames: noOfFrames && noOfFrames > 0 ? noOfFrames : undefined,
    type,
    borderW,
    borderH,
    tilingCenter,
  }
}

function childBlock(doc: Document, b: Block, key: string): Block | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key && e.block) return e.block
  }
  return undefined
}

function childValue(doc: Document, b: Block, key: string): string | undefined {
  for (const e of b.entries) {
    if (keyText(doc, e) === key) return valueText(doc, e)
  }
  return undefined
}

/** 大小写不敏感的块/标量查找(gfx 键名大小写不统一) */
function childBlockCI(doc: Document, b: Block, key: string): Block | undefined {
  const k = key.toLowerCase()
  for (const e of b.entries) {
    const t = keyText(doc, e)
    if (t && t.toLowerCase() === k && e.block) return e.block
  }
  return undefined
}

function childValueCI(doc: Document, b: Block, key: string): string | undefined {
  const k = key.toLowerCase()
  for (const e of b.entries) {
    const t = keyText(doc, e)
    if (t && t.toLowerCase() === k) return valueText(doc, e)
  }
  return undefined
}

function numOr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

export function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let items: string[]
    try {
      items = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of items) {
      const p = join(cur, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (exts.some((x) => name.toLowerCase().endsWith(x))) out.push(p)
    }
  }
  return out.sort()
}
