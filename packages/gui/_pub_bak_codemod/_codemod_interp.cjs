/* _codemod_interp.cjs —— 把「运行期拼接出来的中文」包成 tr('…')
 *
 * ── 为什么这次能成,而上次的「运行时片段替换」不能 ──
 *   上次:DOM 里拿到 "AllSource"(271 树)",不分词边界地 replace('源','Source')
 *         → 把 doctrines / AllSource / 26882事件 全切坏。
 *   这次:在**源码里**精确知道边界 —— 作者写的是 `'原版 (' + n + ' 树)'`,
 *         我们只包住 `'原版 ('` 和 `' 树)'` 两个**完整字面量**,
 *         绝不碰变量值里的内容。中文没有词边界,但**引号有**。
 *
 * ── 处理的两种形态 ──
 *   ① '中文' + expr        → tr('中文') + expr
 *      expr + '中文'        → expr + tr('中文')
 *   ② `中文${expr}中文`     → tr('中文') + expr + tr('中文')
 *      纯静态的整串(无插值)**不动** —— 那些已被运行时替换覆盖。
 *
 * ── 绝不动的地方(误伤=功能坏)──
 *   · 注释里的字符串(判定:该行的字符串字面量是否处于注释内)
 *   · 哨兵值 '(匿名)' '(多 DLC)' '游戏本体' '基础游戏'
 *     —— 它们是**数据键**,拿去 === 比较的,翻译即功能坏
 *   · data-no-i18n 保护区内的渲染(那是模组作者的内容)
 *   · 已经在 tr()/t() 里的
 *
 * 用法:node _codemod_interp.cjs [--dry] [--file=xxx.js]
 *   --dry 只报告不落盘
 */
const fs = require('fs')
const path = require('path')

const PUBLIC = __dirname
const ZH = /[一-龥]/

/** 哨兵值:数据键,永不翻译 */
const SENTINELS = new Set(['(匿名)', '(多 DLC)', '游戏本体', '基础游戏'])

/** 判定某个下标是否落在注释里(粗但够用:行内 // 与块注释 /* */ 都算) */
function makeCommentMask(src) {
  // 返回 Uint8Array,1=注释
  const mask = new Uint8Array(src.length)
  let i = 0
  let inBlock = false
  // 先按行处理 // 与字符串,块注释跨行
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (inBlock) {
      mask[i] = 1
      if (c === '*' && c2 === '/') {
        mask[i + 1] = 1
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (c === '/' && c2 === '*') {
      mask[i] = 1
      mask[i + 1] = 1
      inBlock = true
      i += 2
      continue
    }
    if (c === '/' && c2 === '/') {
      // 行注释到行尾
      while (i < src.length && src[i] !== '\n') {
        mask[i] = 1
        i++
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      // 跳过整条字符串,避免字符串里的 // 被当注释
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === q) {
          i++
          break
        }
        if (src[i] === '\n' && q !== '`') break // 普通字符串不跨行
        i++
      }
      continue
    }
    i++
  }
  return mask
}

/** 找出所有「静态字符串字面量」的位置:返回 [{start,end,quote,value}] */
function findStringLiterals(src, mask) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'") {
      if (mask[i]) {
        i++
        continue
      }
      const start = i
      const q = c
      i++
      let val = ''
      while (i < src.length) {
        if (src[i] === '\\') {
          val += src[i] + src[i + 1]
          i += 2
          continue
        }
        if (src[i] === q) {
          i++
          break
        }
        if (src[i] === '\n') break
        val += src[i]
        i++
      }
      out.push({ start, end: i, quote: q, value: val })
      continue
    }
    i++
  }
  return out
}

/** 找出模板字面量(含 ${})的位置与其内部静态片段 */
function findTemplateSegments(src, mask) {
  // 返回 [{tmplStart, tmplEnd, segs:[{text, s, e}], exprs:[...]}]
  const out = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '`' && !mask[i]) {
      const tmplStart = i
      i++
      const segs = []
      let text = ''
      let segStart = i
      while (i < src.length) {
        if (src[i] === '\\') {
          text += src[i] + src[i + 1]
          i += 2
          continue
        }
        if (src[i] === '`') {
          // 收尾
          segs.push({ text, s: segStart, e: i })
          out.push({ tmplStart, tmplEnd: i + 1, segs })
          i++
          break
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          segs.push({ text, s: segStart, e: i })
          text = ''
          i += 2
          // 跳过表达式(配平花括号,考虑字符串)
          let depth = 1
          while (i < src.length && depth > 0) {
            const d = src[i]
            if (d === '{') depth++
            else if (d === '}') {
              depth--
              if (depth === 0) break
            } else if (d === '"' || d === "'" || d === '`') {
              const q = d
              i++
              while (i < src.length) {
                if (src[i] === '\\') {
                  i += 2
                  continue
                }
                if (src[i] === q) break
                i++
              }
            }
            i++
          }
          i++ // 吃掉 }
          segStart = i
          continue
        }
        text += src[i]
        i++
      }
      continue
    }
    i++
  }
  return out
}

/** 该字面量是否"参与拼接"(即它只是句子的片段,需要 tr 包裹) */
function isInterpolated(src, lit, lits, mask) {
  // 前面是 + 或后面是 +
  const before = src.slice(Math.max(0, lit.start - 4), lit.start)
  const after = src.slice(lit.end, lit.end + 4)
  if (/[+]/.test(after)) return true
  // 前面:跳过空白后是 +
  if (/[+]/.test(before)) return true
  // 前后若有其他字面量紧邻(隐式拼接在 ES 里不存在,但保险)
  return false
}

function alreadyWrapped(src, start) {
  // 往前找最近的非空白非括号字符,若是标识符字母则可能已在 t(/tr( 内
  const before = src.slice(Math.max(0, start - 12), start)
  return /\b(tr|t)\s*\($/.test(before)
}

function shouldSkip(value) {
  if (!value.trim()) return true
  if (!ZH.test(value)) return true
  if (SENTINELS.has(value)) return true
  return false
}

function processFile(f, dry) {
  const full = path.join(PUBLIC, f)
  const src = fs.readFileSync(full, 'utf8')
  const mask = makeCommentMask(src)

  /** 收集要替换的片段:[start, end, replacement] */
  const edits = []
  const keys = new Set()

  // ① 模板字面量:把含中文的静态片段包 tr()
  const tmpls = findTemplateSegments(src, mask)
  for (const tp of tmpls) {
    const hasExpr = tp.segs.length > 1
    if (!hasExpr) continue // 纯静态:运行时替换已覆盖
    for (const seg of tp.segs) {
      if (shouldSkip(seg.text)) continue
      // 该片段本身是否已含变量?seg.text 是纯静态的(变量已被切开)
      edits.push({
        start: seg.s,
        end: seg.e,
        text: seg.text,
        repl: 'tr(' + JSON.stringify(seg.text) + ')',
      })
      keys.add(seg.text)
    }
  }

  // ② 普通字符串字面量:参与 + 拼接的包 tr()
  const lits = findStringLiterals(src, mask)
  for (const lit of lits) {
    if (shouldSkip(lit.value)) continue
    if (!isInterpolated(src, lit, lits, mask)) continue
    if (alreadyWrapped(src, lit.start)) continue
    // 值里有 ${} 说明是模板(已处理)
    if (lit.value.includes('${')) continue
    edits.push({
      start: lit.start,
      end: lit.end,
      text: lit.value,
      repl: 'tr(' + src.slice(lit.start, lit.end) + ')',
    })
    keys.add(lit.value)
  }

  if (!edits.length) return { file: f, n: 0, keys: [] }

  // 去重叠:同一区间只保留一个
  edits.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept = []
  let lastEnd = -1
  for (const e of edits) {
    if (e.start < lastEnd) continue
    kept.push(e)
    lastEnd = e.end
  }

  if (!dry) {
    let out = src
    for (let i = kept.length - 1; i >= 0; i--) {
      const e = kept[i]
      out = out.slice(0, e.start) + e.repl + out.slice(e.end)
    }
    fs.writeFileSync(full, out)
  }
  return { file: f, n: kept.length, keys: [...keys] }
}

/* ── 主流程 ── */
const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const only = argv.find((a) => a.startsWith('--file='))

const files = fs
  .readdirSync(PUBLIC)
  .filter((f) => /\.(js|html)$/.test(f))
  .filter((f) => !f.startsWith('i18n') && !f.startsWith('_') && f !== 'progress.js')
  .filter((f) => (only ? f === only.slice(7) : true))

let total = 0
const allKeys = new Set()
const perFile = []
for (const f of files) {
  const r = processFile(f, dry)
  if (r.n) {
    perFile.push(r)
    total += r.n
    r.keys.forEach((k) => allKeys.add(k))
  }
}

perFile.sort((a, b) => b.n - a.n)
console.log((dry ? '【DRY】' : '【落盘】') + ' 共包裹 ' + total + ' 处,涉及 ' + perFile.length + ' 个文件,唯一片段 ' + allKeys.size + ' 条\n')
perFile.forEach((r) => console.log('  ' + String(r.n).padStart(4) + '  ' + r.file))
fs.writeFileSync(path.join(PUBLIC, '_codemod_keys.json'), JSON.stringify([...allKeys], null, 1))
console.log('\n唯一片段已写入 _codemod_keys.json')
