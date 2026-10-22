/**
 * 零依赖 HOI4 LSP 服务端(stdio JSON-RPC)。
 *
 * 直接对标 CWTools(IDE 补全/跳转),但用本工具链的数据驱动语义索引自动获得能力,
 * 不需手写 rules。支持:
 *   - textDocument/definition   跳转到定义(科技/决议/理念/事件/国策/图标/本地化/gui 元素)
 *   - textDocument/references   查找引用(基于索引的引用表,覆盖 common 内引用)
 *   - textDocument/completion   上下文补全(图标 GFX_ / 本地化键 / 各种 id)
 *   - textDocument/hover        悬浮提示(种类 + 定义/引用数)
 *   - textDocument/documentSymbol  文档大纲(顶层块 id)
 *
 * 注意:stdout 只能输出 JSON-RPC 消息,任何日志必须走 stderr。
 *
 * 启动:node packages/lsp/src/server.ts --root <你的mod> --game <游戏根目录>
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { parse } from '../../parser/src/parser.ts'
import { keyText, valueText, lineOf } from '../../parser/src/serialize.ts'
import { SymbolRegistry, type RootSpec } from '../../engine/src/completion.ts'

/* ── 参数 ── */
const roots: RootSpec[] = []
const gameRoots: RootSpec[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--root') roots.push({ name: basename(argv[++i]), path: argv[i] })
  else if (a === '--game') gameRoots.push({ name: basename(argv[++i]), path: argv[i] })
}
if (!roots.length) roots.push({ name: 'cwd', path: process.cwd() })

log(`HOI4 LSP 启动,roots=${roots.length} game=${gameRoots.length}`)

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}

const registry = new SymbolRegistry()
let building = false
let built = false

function buildIndex(): void {
  if (building || built) return
  building = true
  log('索引构建中…')
  const t = Date.now()
  try {
    const all = [...roots, ...gameRoots]
    registry.buildFast(all)
    built = true
    log(`索引完成:${registry.stats.defs} 定义 / ${registry.stats.refs} 引用,${Date.now() - t} ms`)
  } catch (e) {
    log(`索引失败:${String(e)}`)
  } finally {
    building = false
  }
}

function log(s: string): void {
  process.stderr.write(`[lsp] ${s}\n`)
}

/* ── JSON-RPC 收发 ── */
let buf = Buffer.alloc(0)
let nextId = 1

function send(msg: unknown): void {
  const json = JSON.stringify(msg)
  const payload = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
  process.stdout.write(payload)
}

interface JsonRpcMsg {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: any
  result?: unknown
  error?: unknown
}

process.stdin.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk])
  let idx: number
  while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
    const header = buf.subarray(0, idx).toString('utf8')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) {
      // 无法解析,丢弃
      buf = buf.subarray(idx + 4)
      continue
    }
    const len = parseInt(m[1], 10)
    const start = idx + 4
    if (buf.length < start + len) break // 还没收全
    const body = buf.subarray(start, start + len).toString('utf8')
    buf = buf.subarray(start + len)
    try {
      const msg = JSON.parse(body) as JsonRpcMsg
      handle(msg)
    } catch {
      log('JSON 解析失败')
    }
  }
})

function handle(msg: JsonRpcMsg): void {
  const method = msg.method
  if (!method) {
    // 响应(我们作为服务端一般不收响应,忽略)
    return
  }
  switch (method) {
    case 'initialize':
      return respond(msg.id, {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          completionProvider: { triggerCharacters: ['=', '{'], resolveProvider: false },
        },
        serverInfo: { name: 'hoi4kit-lsp', version: '1.0' },
      })
    case 'initialized':
      // 后台构建索引,不阻塞初始化
      setTimeout(buildIndex, 0)
      return
    case 'shutdown':
      return respond(msg.id, null)
    case 'exit':
      process.exit(0)
      return
    case 'textDocument/didOpen': {
      const p = msg.params
      const uri = p?.textDocument?.uri
      const text = p?.textDocument?.text ?? ''
      if (uri) openDocs.set(uri, text)
      return
    }
    case 'textDocument/didChange': {
      const p = msg.params
      const uri = p?.textDocument?.uri
      const text = p?.contentChanges?.[0]?.text ?? openDocs.get(uri) ?? ''
      if (uri) openDocs.set(uri, text)
      return
    }
    case 'textDocument/didClose': {
      const uri = msg.params?.textDocument?.uri
      if (uri) openDocs.delete(uri)
      return
    }
    case 'textDocument/definition':
      return respond(msg.id, definitionAt(msg.params))
    case 'textDocument/references':
      return respond(msg.id, referencesAt(msg.params))
    case 'textDocument/completion':
      return respond(msg.id, completionAt(msg.params))
    case 'textDocument/hover':
      return respond(msg.id, hoverAt(msg.params))
    case 'textDocument/documentSymbol':
      return respond(msg.id, documentSymbols(msg.params))
    default:
      if (msg.id !== undefined) return respond(msg.id, null)
  }
}

function respond(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return
  send({ jsonrpc: '2.0', id, result })
}

const openDocs = new Map<string, string>()
const allRoots = (): RootSpec[] => [...roots, ...gameRoots]

function wordAt(text: string, line: number, character: number): { word: string; start: number; end: number } {
  const lines = text.split('\n')
  const l = lines[line] ?? ''
  let s = character
  let e = character
  const isWord = (c: string) => /[A-Za-z0-9_.]/.test(c)
  while (s > 0 && isWord(l[s - 1])) s--
  while (e < l.length && isWord(l[e])) e++
  return { word: l.slice(s, e), start: s, end: e }
}

function defToLocation(d: { file: string; line: number; root: number }): any {
  const r = allRoots()[d.root] ?? allRoots()[0]
  if (!r) return null
  const abs = join(r.path, d.file)
  const line = Math.max(0, d.line - 1)
  return {
    uri: pathToFileURL(abs).href,
    range: {
      start: { line, character: 0 },
      end: { line, character: 200 },
    },
  }
}

function definitionAt(params: any): any {
  if (!built) return []
  const uri = params?.textDocument?.uri
  const text = openDocs.get(uri) ?? ''
  const { word } = wordAt(text, params?.position?.line ?? 0, params?.position?.character ?? 0)
  if (!word) return []
  const defs = registry.definition(word)
  const locs = defs.map(defToLocation).filter(Boolean)
  return locs
}

function referencesAt(params: any): any {
  if (!built) return []
  const uri = params?.textDocument?.uri
  const text = openDocs.get(uri) ?? ''
  const { word } = wordAt(text, params?.position?.line ?? 0, params?.position?.character ?? 0)
  if (!word) return []
  const refs = registry.references(word)
  const locs = refs.map((r) => defToLocation(r)).filter(Boolean)
  return locs
}

const KIND_MAP: Record<string, number> = {
  gfx_sprite: 21,
  loc_key: 15,
  gui_element: 5,
  scripted_gui: 7,
  inlay_window: 7,
  technology: 22,
  decision: 3,
  idea: 3,
  event: 3,
  focus: 3,
}

function completionAt(params: any): any {
  if (!built) return []
  const uri = params?.textDocument?.uri
  const text = openDocs.get(uri) ?? ''
  const { word } = wordAt(text, params?.position?.line ?? 0, params?.position?.character ?? 0)
  const items = registry.completions(word, 300)
  return items.map((it) => ({
    label: it.label,
    kind: KIND_MAP[it.kind] ?? 12,
    detail: it.detail,
    documentation: `${it.kind}`,
  }))
}

function hoverAt(params: any): any {
  if (!built) return null
  const uri = params?.textDocument?.uri
  const text = openDocs.get(uri) ?? ''
  const { word } = wordAt(text, params?.position?.line ?? 0, params?.position?.character ?? 0)
  if (!word) return null
  const defs = registry.definition(word)
  const refs = registry.references(word)
  if (!defs.length && !refs.length) return null
  const k = defs[0]?.kind ?? '?'
  const md = [`**${word}**`, `种类: ${k}`, `定义: ${defs.length} 处`, `引用: ${refs.length} 处`]
  if (defs[0]) md.push(`位置: \`${defs[0].file}:${defs[0].line}\``)
  return { contents: { kind: 'markdown', value: md.join('\n\n') } }
}

function documentSymbols(params: any): any {
  const uri = params?.textDocument?.uri
  const text = openDocs.get(uri) ?? ''
  if (!text) return []
  let doc
  try {
    doc = parse(text)
  } catch {
    return []
  }
  const out: any[] = []
  for (const e of doc.root.entries) {
    const k = keyText(doc, e)
    if (!k) continue
    const id = e.block ? valueText(doc, e.block.entries.find((x: any) => keyText(doc, x) === 'id') ?? {}) ?? k : k
    out.push({
      name: e.block ? `${k} = ${id}` : k,
      kind: e.block ? 2 : 13,
      location: {
        uri,
        range: {
          start: { line: lineOf(doc, e) - 1, character: 0 },
          end: { line: lineOf(doc, e) - 1, character: 120 },
        },
      },
    })
  }
  return out
}

log('等待客户端 initialize…')
