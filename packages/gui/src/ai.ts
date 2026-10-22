/**
 * AI 开发接口（AIDE_V1）—— 服务端代理层
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计要点(每条都是踩过或想清楚的,别顺手改掉)
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **零依赖**:只用 node: 内置 + Node 22 原生 fetch。
 *    工作台全链路无 npm 包,这个模块必须守住。
 *
 * ② **依赖注入,不 import server.ts**。
 *    server.ts 有 4700+ 行且 ROOTS/LINK/VAL 全是模块级可变状态,
 *    反向 import 会成环(而且 server.ts 顶层有启动副作用,被 import 就直接起服务)。
 *    所以这里定义 `AiDeps` 接口,由 server.ts 在启动序列里 `createAi(deps)` 注入。
 *
 * ③ **密钥永不落进 git / 永不进日志**。
 *    - 配置写 `gui-settings.json`(已在 .gitignore)
 *    - 也可只用环境变量 `HOI4_AI_KEY`,不写文件
 *    - `redactKey()` 在所有错误信息里把 key 打码
 *    - `/api/ai/config` 回读时**只返回 `hasKey`,绝不返回 key 本身**
 *
 * ④ **写文件必须两阶段**(沿用工作台既有原则「保存前强制备份,先返回 diff 供审查」)。
 *    模型调 `write_file` → 写进 `.ai-preview/<hash>.txt` 并返回 unified diff,
 *    前端渲染 diff 让用户点「应用」,才由 `/api/ai/apply` 真正落盘。
 *    AI 不能绕过用户直接改模组 —— 这条是硬红线。
 *
 * ⑤ **工具调用循环有硬上限**(MAX_TOOL_ROUNDS)。
 *    模型可能反复调同一个工具死循环;超限就带诊断信息收尾,而不是无限烧 token。
 *
 * ⑥ **三种协议适配**(openai / anthropic / ollama)。
 *    覆盖市面上绝大多数可用端点:
 *    - openai 兼容:DeepSeek / Kimi / Qwen / GLM / SiliconFlow / OpenRouter / OpenAI 本体
 *    - anthropic    :Claude(消息格式与 tool_use 完全不同,必须单独一套)
 *    - ollama        :本地模型,无 key,`/api/chat` 而非 `/v1/chat/completions`
 *
 * ⑦ **SSE 透传**:上游流式 → 逐 chunk 解析 → 转成本模块自定义事件
 *    (`delta` / `tool_call` / `tool_result` / `done` / `error`)→ 浏览器。
 *    统一事件格式让前端只需认一种协议,换 provider 零改动。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'

/* ══════════════════════════════════════════════════════════════
 * 一、provider 目录
 * ══════════════════════════════════════════════════════════════ */

export type AiProtocol = 'openai' | 'anthropic' | 'ollama'

export interface AiProvider {
  id: string
  label: string
  protocol: AiProtocol
  /** 留空 = 从环境变量或已保存配置取 */
  baseUrl: string
  /** 该 provider 常用的默认模型(用户可改) */
  models: string[]
  /** 是否需要 apiKey(ollama 不需要) */
  needsKey: boolean
  /** 免费/本地,UI 上打个标记 */
  tag?: string
}

/**
 * 预置 provider 目录。
 *
 * ★ baseUrl 一律写到「路径前缀」,不含 `/chat/completions` 之类尾部 ——
 *   不同厂商尾部路径不一致(openai 兼容系统一 `/chat/completions`,
 *   ollama 是 `/api/chat`),由 `chatUrl()` 按协议拼。
 */
export const AI_PROVIDERS: AiProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], needsKey: true },
  { id: 'moonshot', label: '月之暗面 Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo-preview', 'moonshot-v1-128k'], needsKey: true },
  { id: 'qwen', label: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen3-coder-plus'], needsKey: true },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4-plus'], needsKey: true },
  { id: 'siliconflow', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-Coder-32B-Instruct'], needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini'], needsKey: true },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], needsKey: true },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], needsKey: true },
  { id: 'ollama', label: 'Ollama 本地', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['qwen2.5-coder:7b', 'llama3.1:8b'], needsKey: false, tag: '本地 · 免 key' },
  { id: 'custom', label: '自定义端点', protocol: 'openai', baseUrl: '', models: [], needsKey: true },
]

/* ══════════════════════════════════════════════════════════════
 * 二、配置
 * ══════════════════════════════════════════════════════════════ */

export interface AiConfig {
  provider: string
  baseUrl: string
  model: string
  /** 只在 POST 时接收,落盘前不参与任何回读 */
  apiKey?: string
  temperature: number
  maxTokens: number
  /** 允许 AI 写文件(默认 false —— 用户显式开) */
  allowWrite: boolean
  /** 允许 AI 跑体检这类重活 */
  allowHeavy: boolean
}

export function defaultAiConfig(): AiConfig {
  return {
    provider: 'deepseek',
    baseUrl: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 4096,
    allowWrite: false,
    allowHeavy: true,
  }
}

/** 密钥打码:只留头尾各 3 位,足够用户认出是哪个 key,泄不出内容 */
export function redactKey(k: string): string {
  if (!k) return ''
  if (k.length <= 8) return '*'.repeat(k.length)
  return k.slice(0, 3) + '*'.repeat(Math.min(k.length - 6, 20)) + k.slice(-3)
}

/* ══════════════════════════════════════════════════════════════
 * 三、依赖注入接口
 * ══════════════════════════════════════════════════════════════ */

export interface AiRoot {
  name: string
  path: string
  writable: boolean
}

export interface AiDeps {
  /** 当前来源列表(只读/可写标记在这里,工具层据此拦截) */
  roots(): AiRoot[]
  /** 路径守卫:返回绝对路径,越界返回 null。**工具层唯一允许的路径入口** */
  safeJoin(rootPath: string, rel: string): string | null
  /** 符号/引用图(定义跳转、找引用) */
  links(): unknown
  /** 体检报告 */
  check(): unknown
  /** 本地化索引:查 key 是否存在 */
  loc(): unknown
  /** 官方文档读取 */
  readDoc(rel: string): { text: string } | null
  listDocs(): { files: { path: string; title: string }[] }
  /** 写文件落盘(仅 /api/ai/apply 用,工具层只写 preview) */
  writeFile(rootIdx: number, rel: string, content: string): { ok: boolean; error?: string; backup?: boolean; created?: boolean }
  /** 强制刷新各索引 */
  invalidate(abs: string): void
}

/* ══════════════════════════════════════════════════════════════
 * 四、工具定义与实现
 * ══════════════════════════════════════════════════════════════ */

interface ToolCtx {
  deps: AiDeps
  cfg: AiConfig
  /** 预览暂存区:tool_call_id → 预览信息 */
  previews: Map<string, PreviewItem>
  trace: string[]
}

export interface PreviewItem {
  id: string
  rootIdx: number
  rootName: string
  file: string
  /** 旧内容(不存在则 null) */
  before: string | null
  after: string
  diff: string
  bytes: number
}

const PREVIEW_DIR = '.ai-preview'

/* ── 4.1 OpenAI 风格工具 schema ── */
function openAiTools(ctx: ToolCtx): unknown[] {
  const w = ctx.cfg.allowWrite
  return [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出某个来源(rootIdx)下某个目录的内容。只读。path 用相对路径,空字符串=根目录。',
        parameters: {
          type: 'object',
          properties: {
            rootIdx: { type: 'integer', description: '来源序号,用 0=vanilla。用 list_sources 拿全量。' },
            path: { type: 'string', description: '相对路径,空=根' },
          },
          required: ['rootIdx', 'path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取一个文本文件的完整内容。用来在改动前**先看**真实内容,不要凭猜写。',
        parameters: {
          type: 'object',
          properties: {
            rootIdx: { type: 'integer' },
            file: { type: 'string', description: '相对路径' },
            maxLines: { type: 'integer', description: '最多返回多少行,默认 600' },
          },
          required: ['rootIdx', 'file'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: '在所有来源里全文搜索一个字符串(大小写不敏感),返回文件+行号+该行内容。这是找「某东西在哪定义/被引用」的主力工具。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', description: '默认 60' },
            rootIdx: { type: 'integer', description: '只搜某个来源;省略=全搜' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_symbol',
        description: '查一个符号(图标名 GFX_xxx / GUI 元素名 / 国策 id / 科技 id / 本地化键)的定义位置与引用位置。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, limit: { type: 'integer' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '读一篇官方文档(HOI4 官方脚本文档的中文/英文 markdown)。写任何脚本前**应该**先查对应文档确认键名与语法。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '如 effects_documentation.md / common/national_focus' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_sources',
        description: '列出当前工作台挂载的所有来源(序号、名称、路径、是否可写)。写文件前必须先确认 rootIdx。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_check',
        description: '对指定来源(或全部)跑一遍内置体检,返回错误/警告摘要。改完文件后用它自检。',
        parameters: {
          type: 'object',
          properties: { rootIdx: { type: 'integer', description: '省略=全部' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: w
          ? '修改/新建一个文件。**注意:这一步只是生成预览**,用户会看到 diff 并决定是否真正落盘。你不会立刻生效。'
          : '【当前未授权写文件】用户没有开启写权限,只能用只读工具。',
        parameters: {
          type: 'object',
          properties: {
            rootIdx: { type: 'integer' },
            file: { type: 'string', description: '相对路径' },
            content: { type: 'string', description: '完整的新内容(不是片段!)' },
            reason: { type: 'string', description: '一句话说明为什么改,会显示给用户' },
          },
          required: ['rootIdx', 'file', 'content', 'reason'],
        },
      },
    },
  ].filter((t) => w || (t as { function: { name: string } }).function.name !== 'write_file')
}

/** Anthropic 的工具 schema:顶层 type/input,不是 function/parameters */
function anthropicTools(ctx: ToolCtx): unknown[] {
  return openAiTools(ctx).map((t) => {
    const f = (t as { function: { name: string; description: string; parameters: unknown } }).function
    return { name: f.name, description: f.description, input_schema: f.parameters }
  })
}

/* ── 4.2 工具执行 ── */
async function runTool(ctx: ToolCtx, name: string, args: Record<string, unknown>, callId: string): Promise<string> {
  const { deps, cfg } = ctx
  const roots = deps.roots()
  const num = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const rootOf = (i: unknown): AiRoot | null => {
    const idx = num(i, 0)
    return roots[idx] ?? null
  }
  const J = (o: unknown): string => JSON.stringify(o)

  try {
    switch (name) {
      case 'list_sources':
        return J(roots.map((r, i) => ({ rootIdx: i, name: r.name, writable: r.writable })))

      case 'list_dir': {
        const r = rootOf(args.rootIdx)
        if (!r) return J({ error: `rootIdx ${args.rootIdx} 不存在,共 ${roots.length} 个来源` })
        const rel = str(args.path).replace(/^\/+/, '')
        const abs = deps.safeJoin(r.path, rel)
        if (!abs) return J({ error: '路径越界' })
        if (!existsSync(abs)) return J({ error: '目录不存在' })
        const dirs: string[] = []
        const files: { name: string; size: number }[] = []
        for (const n of readdirSync(abs).slice(0, 500)) {
          try {
            const st = statSync(join(abs, n))
            if (st.isDirectory()) dirs.push(n)
            else files.push({ name: n, size: st.size })
          } catch { /* 跳过读不到 stat 的项(权限/断链) */ }
        }
        dirs.sort()
        files.sort((a, b) => a.name.localeCompare(b.name))
        return J({ root: r.name, path: rel, dirs, files })
      }

      case 'read_file': {
        const r = rootOf(args.rootIdx)
        if (!r) return J({ error: `rootIdx ${args.rootIdx} 不存在` })
        const rel = str(args.file).replace(/^\/+/, '')
        const abs = deps.safeJoin(r.path, rel)
        if (!abs) return J({ error: '路径越界' })
        let st
        try { st = statSync(abs) } catch { return J({ error: '文件不存在' }) }
        if (st.isDirectory()) return J({ error: '不是文件,无法读取' })
        const size = st.size
        const maxLines = num(args.maxLines, 600)
        const full = readFileSync(abs, 'utf8')
        const lines = full.split('\n')
        const cut = lines.slice(0, maxLines)
        return J({
          root: r.name,
          file: rel,
          size,
          totalLines: lines.length,
          returnedLines: cut.length,
          truncated: lines.length > maxLines,
          content: cut.join('\n'),
        })
      }

      case 'search_text': {
        const q = str(args.query).trim()
        if (!q) return J({ error: 'query 不能为空' })
        const limit = Math.min(num(args.limit, 60), 300)
        const only = args.rootIdx === undefined || args.rootIdx === null ? null : num(args.rootIdx, 0)
        const needle = q.toLowerCase()
        const hits: { root: string; file: string; line: number; text: string }[] = []
        const exts = new Set(['.txt', '.yml', '.gui', '.gfx', '.mod', '.lua', '.json', '.csv', '.txt2'])
        for (let ri = 0; ri < roots.length; ri++) {
          if (only !== null && ri !== only) continue
          const root = roots[ri]
          walkText(root.path, '', exts, hits, needle, limit, root.name, 0)
          if (hits.length >= limit) break
        }
        return J({ query: q, hitCount: hits.length, hits })
      }

      case 'find_symbol': {
        const n = str(args.name).trim()
        if (!n) return J({ error: 'name 不能为空' })
        const limit = Math.min(num(args.limit, 40), 200)
        const g = deps.links() as
          | { defsOf?(name: string): unknown[]; refsOf?(name: string): unknown[]; defs?: Map<string, unknown[]>; refs?: Map<string, unknown[]> }
          | null
        let defs: unknown[] = []
        let refs: unknown[] = []
        if (g?.defsOf) { defs = g.defsOf(n) ?? []; refs = g.refsOf?.(n) ?? [] }
        else if (g?.defs) { defs = g.defs.get(n) ?? []; refs = g.refs?.get(n) ?? [] }
        return J({ name: n, defs: defs.slice(0, limit), refs: refs.slice(0, limit) })
      }

      case 'read_doc': {
        const p = str(args.path).trim()
        if (!p) return J({ error: 'path 不能为空' })
        const d = deps.readDoc(p)
        if (!d) {
          const all = deps.listDocs().files.slice(0, 60).map((f) => f.path)
          return J({ error: `没找到文档「${p}」。可用文档(部分):`, available: all })
        }
        /* 文档动辄上万行,只给前 400 行 + 总行数,让模型自己决定要不要 narrow */
        const lines = d.text.split('\n')
        return J({ path: p, totalLines: lines.length, returnedLines: Math.min(400, lines.length), content: lines.slice(0, 400).join('\n') })
      }

      case 'run_check': {
        if (!cfg.allowHeavy) return J({ error: '用户未授权运行体检(allowHeavy=false)' })
        const rep = deps.check() as
          | { stats?: { error?: number; warning?: number; info?: number }; issues?: unknown[] }
          | null
        if (!rep) return J({ error: '体检还没跑完(工作台正在后台跑),稍后再试' })
        const issues = Array.isArray(rep.issues) ? rep.issues : []
        return J({
          stats: rep.stats ?? {},
          total: issues.length,
          issues: issues.slice(0, 40).map((x) => {
            const o = x as Record<string, unknown>
            return { severity: o.severity, code: o.code, file: o.file, line: o.line, message: o.message }
          }),
        })
      }

      case 'write_file': {
        if (!cfg.allowWrite) return J({ error: '用户未授权写文件(allowWrite=false)。请改为只给建议,由用户手动改。' })
        const r = rootOf(args.rootIdx)
        if (!r) return J({ error: `rootIdx ${args.rootIdx} 不存在` })
        if (!r.writable) return J({ error: `「${r.name}」是只读来源(游戏本体),禁止写入。请改用模组来源。` })
        const rel = str(args.file).replace(/^\/+/, '')
        if (!rel.trim()) return J({ error: '缺少 file' })
        const content = str(args.content)
        if (!content) return J({ error: '缺少 content' })
        const abs = deps.safeJoin(r.path, rel)
        if (!abs) return J({ error: '路径越界(不能写到来源目录之外)' })
        const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
        const item: PreviewItem = {
          id: callId || createHash('sha1').update(rel + content).digest('base64url').slice(0, 12),
          rootIdx: num(args.rootIdx, 0),
          rootName: r.name,
          file: rel,
          before,
          after: content,
          diff: makeDiff(before ?? '', content, rel),
          bytes: content.length,
        }
        ctx.previews.set(item.id, item)
        return J({
          status: 'preview_ready',
          previewId: item.id,
          reason: str(args.reason),
          file: rel,
          root: r.name,
          isNew: before === null,
          bytes: item.bytes,
          diff: item.diff.split('\n').slice(0, 120).join('\n'),
          note: '已生成 diff 预览,等用户在界面上点「应用」后才会真正写入磁盘。你现在可以继续别的事。',
        })
      }

      default:
        return J({ error: `未知工具 ${name}` })
    }
  } catch (e) {
    return J({ error: `工具执行异常:${String(e)}` })
  }
}

/** 递归搜文本文件(限深 12 层,防打爆) */
function walkText(
  dir: string,
  rel: string,
  exts: Set<string>,
  hits: { root: string; file: string; line: number; text: string }[],
  needle: string,
  limit: number,
  rootName: string,
  depth: number,
): void {
  if (depth > 12 || hits.length >= limit) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (hits.length >= limit) return
    if (n === '.ai-preview' || n === '.git') continue
    const p = join(dir, n)
    const childRel = rel ? rel + '/' + n : n
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkText(p, childRel, exts, hits, needle, limit, rootName, depth + 1)
      continue
    }
    if (!exts.has(extname(n).toLowerCase())) continue
    if (st.size > 4_000_000) continue
    let txt: string
    try {
      txt = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const lines = txt.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) return
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ root: rootName, file: childRel, line: i + 1, text: lines[i].trim().slice(0, 300) })
      }
    }
  }
}

/* ── 4.3 unified diff(给人和模型都看)── */

/**
 * 切行,但**丢掉末尾那个由结尾换行产生的空串**。
 *
 * 不丢的话,新建空文件会得到 `[""]` 的一行,于是 diff 里凭空多一条 `-`
 * (实测 `makeDiff('', 'hello\nworld')` 输出末尾多一个 `-`),
 * 用户看着像「删了一行」。真实 diff 工具(git 等)也是这么处理的。
 */
function splitLines(s: string): string[] {
  if (s === '') return []
  const out = s.split('\n')
  if (out.length && out[out.length - 1] === '') out.pop()
  return out
}

export function makeDiff(before: string, after: string, label: string): string {
  const A = splitLines(before)
  const B = splitLines(after)
  /* LCS 表在超大文件上会吃内存,>4000 行就退化为「整体替换」 */
  if (A.length > 4000 || B.length > 4000) {
    return `--- a/${label}\n+++ b/${label}\n@@ 整体替换 @@\n-${A.length} 行 → +${B.length} 行(文件过大,省略逐行 diff)`
  }
  const n = A.length
  const m = B.length
  /* dp[i][j] = A[i..] 与 B[j..] 的最长公共子序列长度 */
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`]
  let i = 0
  let j = 0
  /* hunk 累积区。每条改动记下它在**旧/新**文件里的行号,收尾时算 @@ 头 */
  let hunk: { s: string; oldNo: number; newNo: number }[] = []
  const flush = (): void => {
    if (!hunk.length) return
    const oldStart = hunk[0].oldNo
    const newStart = hunk[0].newNo
    const oldLen = hunk.filter((x) => x.s[0] !== '+').length
    const newLen = hunk.filter((x) => x.s[0] !== '-').length
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)
    for (const h of hunk) out.push(h.s)
    hunk = []
  }
  const push = (s: string): void => {
    hunk.push({ s, oldNo: i + 1, newNo: j + 1 })
  }
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (hunk.length) {
        /* 连续 3 行相同就收尾,免得整个文件全是上下文噪声 */
        let same = 0
        while (i + same < n && j + same < m && A[i + same] === B[j + same] && same < 3) same++
        if (same >= 3) { flush(); i += same; j += same; continue }
      }
      i++
      j++
      continue
    }
    /* LCS 指引:删除优先于新增,保证同一处的 `-` 排在 `+` 前面
     * (diff 的惯例;反过来输出前端渲染时会看着像「先加后删」)。*/
    const canDel = i < n
    const canAdd = j < m
    const delBetter = canDel && (!canAdd || dp[i + 1][j] >= dp[i][j + 1])
    if (delBetter) {
      push('-' + A[i])
      i++
    } else if (canAdd) {
      push('+' + B[j])
      j++
    } else {
      break
    }
    if (hunk.length > 400) flush()
  }
  flush()
  if (out.length === 2) out.push('(无差异)')
  return out.join('\n')
}

/* ══════════════════════════════════════════════════════════════
 * 五、协议适配
 * ══════════════════════════════════════════════════════════════ */

function chatUrl(p: AiProvider, baseUrl: string): string {
  const b = (baseUrl || p.baseUrl).replace(/\/+$/, '')
  if (p.protocol === 'ollama') return b + '/api/chat'
  return b + '/chat/completions'
}

function modelsUrl(p: AiProvider, baseUrl: string): string {
  const b = (baseUrl || p.baseUrl).replace(/\/+$/, '')
  if (p.protocol === 'ollama') return b + '/api/tags'
  return b + '/models'
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 工具调用往返(仅 openai/anthropic 协议内部用) */
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[]
  tool_call_id?: string
  name?: string
}

interface SseEvent {
  type: 'delta' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'status'
  text?: string
  call?: { id: string; name: string; args: Record<string, unknown> }
  result?: string
  data?: unknown
}

const MAX_TOOL_ROUNDS = 8

/** 系统提示词:把工作台的能力边界讲清楚,减少模型乱试 */
function systemPrompt(ctx: ToolCtx, curFile: string): string {
  const roots = ctx.deps.roots()
  return [
    '你是《钢铁雄心 IV》(HOI4) 模组开发助手,服务于一个本地模组开发工作台(HOI4 Toolkit)。',
    '',
    '## 你的工作方式',
    '1. **先看再改**:任何 write_file 之前必须先 read_file 或 search_text 确认真实内容。HOI4 脚本对缩进、括号、键名极其敏感,凭记忆写必然出错。',
    '2. **键名/语法必须查证**:用 read_doc 查官方文档确认键名拼写与可用值。不要假设 vanilla 里的写法就是唯一合法写法。',
    '3. **写文件是预览式的**:write_file 只生成 diff 给用户看,不会自动生效。所以不要写完就宣称「已修复」,要说「已生成改动,等你确认」。',
    '4. **改完自检**:用 run_check 看有没有引入新问题。',
    '5. 中文回答,代码块用 ``` 包裹并标明文件路径。',
    '',
    '## 这个工作台的硬性限制',
    `- 序号 0 通常是 ${roots[0]?.name ?? 'vanilla'}(游戏本体),**只读,禁止写入**;模组来源才是可写的。`,
    '- 你不能执行 shell 命令,不能上网,不能改工作台自己的源码。',
    '- 本地化:HOI4 的 loc key 常常写在 .loc 字段里而不是 id 上,遇到「界面显示 %key% 不显示」优先怀疑 key 拼错或缺译文。',
    '- 缩进:HOI4 的 Clausewitz 解析器对缩进敏感,同一层级必须用 Tab 或空格统一,不要混用。',
    curFile ? `\n## 用户当前正在看的文件\n${curFile}(用户的问题很可能与它相关)` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 主入口:跑一轮完整对话(含工具循环),逐事件回调。
 * onEvent 返回 false 表示客户端已断开,应立即停止。
 */
export async function runChat(
  deps: AiDeps,
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: {
    curFile?: string
    onEvent: (e: SseEvent) => boolean | void
    /** 注册断连回调:传函数=订阅,传 null=退订(runner 结束时自动退订) */
    onDisconnect?: (fn: (() => void) | null) => void
  },
): Promise<void> {
  const prov = AI_PROVIDERS.find((x) => x.id === cfg.provider) ?? AI_PROVIDERS[0]
  const key = await resolveKey(cfg, prov)
  if (prov.needsKey && !key) {
    opts.onEvent({ type: 'error', text: `没有可用的 API Key。请在设置里填,或设环境变量 ${envNameFor(prov.id)}。` })
    return
  }
  const ctx: ToolCtx = { deps, cfg, previews: new Map(), trace: [] }

  const sys = systemPrompt(ctx, opts.curFile ?? '')
  const hist = messages.filter((m) => m.role !== 'system' || m.content).slice(-24)
  /* 客户端断开后要能真的停下:fetch 用 AbortController 挂上,
   * 否则用户关掉面板后,上游还在按 maxTokens 烧 token。*/
  const ac = new AbortController()
  let disconnected = false
  const onDisconnect = (): void => { disconnected = true; ac.abort() }
  opts.onDisconnect?.(onDisconnect)
  try {
    await runLoops()
  } finally {
    opts.onDisconnect?.(null)
  }

  async function runLoops(): Promise<void> {
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (disconnected) return
    let stopped = false
    const emit = (e: SseEvent): void => {
      if (stopped) return
      if (opts.onEvent(e) === false) { stopped = true; disconnected = true; onDisconnect() }
    }

    const payload = buildPayload(prov, sys, hist, cfg, key, ctx)
    let resp: Response
    try {
      resp = await fetch(chatUrl(prov, cfg.baseUrl), {
        method: 'POST',
        headers: headersFor(prov, key),
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
    } catch (e) {
      /* 客户端主动断开不算错误,静默收尾 */
      if (disconnected) return
      emit({ type: 'error', text: `连不上 ${chatUrl(prov, cfg.baseUrl)}:${String(e)}` })
      return
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      emit({ type: 'error', text: `HTTP ${resp.status}:${(key ? t.replaceAll(key, '***') : t).slice(0, 600)}` })
      return
    }

    let got: StreamGot
    try {
      got = await readStream(resp, prov, emit)
    } catch (e) {
      if (!disconnected) emit({ type: 'error', text: '读取流式响应失败:' + String(e) })
      return
    }
    if (stopped) return

    /* 没有工具调用 → 对话结束 */
    if (!got.toolCalls.length) {
      emit({ type: 'done' })
      return
    }

    /* 工具循环:把 assistant 的工具调用 + 各工具结果追加进历史。
     * ★ openai 协议要求把 assistant 那条带 tool_calls 的消息与每条
     *   tool 角色结果都回传,否则第二轮会 400(anthropic 由 buildPayload 转换)。
     * ★ 轮次之间要插一个换行:每一轮模型都会重新说一段话,
     *   直接拼起来会变成「…来源。接着读…」这种连成一坨的正文。*/
    hist.push({ role: 'assistant', content: got.text, tool_calls: got.toolCalls })
    for (const c of got.toolCalls) {
      if (stopped) return
      emit({ type: 'status', text: `调用工具 ${c.name}…` })
      const result = await runTool(ctx, c.name, c.args, c.id)
      ctx.trace.push(`${c.name}(${JSON.stringify(c.args).slice(0, 120)})`)
      /* 预览类工具:额外带 previewId,前端据此渲染 diff 卡片 */
      let parsed: { status?: string; previewId?: string } = {}
      try {
        parsed = JSON.parse(result) as { status?: string; previewId?: string }
      } catch { /* 工具返回非 JSON(不该发生),按纯文本处理 */ }
      if (parsed.previewId) {
        /* 预览要存进全局 store,否则 /api/ai/apply 按 id 取不到 */
        const pv = ctx.previews.get(parsed.previewId)
        if (pv) putPreview(pv)
        emit({ type: 'tool_call', call: c, result })
      }
      emit({ type: 'tool_result', call: { id: c.id, name: c.name, args: c.args }, result, data: parsed.previewId ? { previewId: parsed.previewId } : undefined })
      hist.push({ role: 'user', content: result, tool_call_id: c.id, name: c.name })
    }
    /* 本轮有正文才发分隔换行(纯工具轮不发,免得多空行) */
    if (got.text) emit({ type: 'delta', text: '\n\n' })
    if (round === MAX_TOOL_ROUNDS) {
      emit({ type: 'error', text: `已达到 ${MAX_TOOL_ROUNDS} 轮工具调用上限,停止继续调用。请让模型基于已有信息收尾回答。` })
    }
  }
  }
}

function envNameFor(providerId: string): string {
  const up = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return `HOI4_AI_KEY_${up}`
}

async function resolveKey(cfg: AiConfig, prov: AiProvider): Promise<string> {
  /* 优先级:环境变量(按 provider 专属名) > 通用名 > 配置里存的 */
  const names = [envNameFor(prov.id), 'HOI4_AI_KEY']
  for (const n of names) {
    const v = process.env[n]
    if (v && v.trim()) return v.trim()
  }
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim()
  return ''
}

function headersFor(prov: AiProvider, key: string): Record<string, string> {
  if (prov.protocol === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }
  }
  if (prov.protocol === 'ollama') return { 'Content-Type': 'application/json' }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
}

function buildPayload(
  prov: AiProvider,
  sys: string,
  hist: ChatMessage[],
  cfg: AiConfig,
  key: string,
  ctx: ToolCtx,
): Record<string, unknown> {
  const base = { model: cfg.model, stream: true }
  if (prov.protocol === 'anthropic') {
    return {
      ...base,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      system: sys,
      tools: anthropicTools(ctx),
      messages: hist
        .filter((m) => m.role !== 'system')
        .map((m) => {
          if (m.role === 'assistant' && m.tool_calls?.length) {
            return {
              role: 'assistant',
              content: [
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
                ...m.tool_calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
              ],
            }
          }
          if (m.tool_call_id) return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] }
          return { role: m.role, content: m.content }
        }),
    }
  }
  if (prov.protocol === 'ollama') {
    return { ...base, options: { temperature: cfg.temperature, num_predict: cfg.maxTokens }, tools: openAiTools(ctx), messages: [{ role: 'system', content: sys }, ...hist] }
  }
  void key
  return {
    ...base,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    tools: openAiTools(ctx),
    tool_choice: 'auto',
    messages: [{ role: 'system', content: sys }, ...hist],
  }
}

/* ── 5.1 SSE / NDJSON 解析 ── */
interface StreamGot {
  text: string
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
}

async function readStream(resp: Response, prov: AiProvider, emit: (e: SseEvent) => void): Promise<StreamGot> {
  const got: StreamGot = { text: '', toolCalls: [] }
  if (!resp.body) return got
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  /* openai 系的 tool_calls 是**增量分片**:index 相同的多段要拼起来 */
  const partial = new Map<number, { id: string; name: string; args: string }>()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (prov.protocol === 'ollama') {
        handleOllamaLine(line, got, emit)
        continue
      }
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j: Record<string, unknown>
      try {
        j = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }
      if (prov.protocol === 'anthropic') handleAnthropicChunk(j, got, partial, emit)
      else handleOpenAiChunk(j, got, partial, emit)
    }
  }
  /* 收尾:把分片拼成完整调用 */
  const idxs = [...partial.keys()].sort((a, b) => a - b)
  for (const i of idxs) {
    const p = partial.get(i)!
    let args: Record<string, unknown> = {}
    try {
      args = p.args ? (JSON.parse(p.args) as Record<string, unknown>) : {}
    } catch {
      emit({ type: 'error', text: `工具 ${p.name} 的参数不是合法 JSON,已跳过` })
      continue
    }
    got.toolCalls.push({ id: p.id, name: p.name, args })
  }
  return got
}

function handleOpenAiChunk(
  j: Record<string, unknown>,
  got: StreamGot,
  partial: Map<number, { id: string; name: string; args: string }>,
  emit: (e: SseEvent) => void,
): void {
  const choices = (j.choices ?? []) as { delta?: { content?: string; tool_calls?: unknown[] } }[]
  for (const c of choices) {
    const d = c.delta
    if (!d) continue
    if (typeof d.content === 'string' && d.content) {
      got.text += d.content
      emit({ type: 'delta', text: d.content })
    }
    const tcs = d.tool_calls ?? []
    for (const t of tcs as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
      const i = t.index ?? 0
      const cur = partial.get(i) ?? { id: '', name: '', args: '' }
      if (t.id) cur.id = t.id
      if (t.function?.name) cur.name += t.function.name
      if (t.function?.arguments) cur.args += t.function.arguments
      partial.set(i, cur)
    }
  }
  if (typeof j.error === 'object' && j.error) {
    emit({ type: 'error', text: JSON.stringify(j.error).slice(0, 400) })
  }
}

function handleAnthropicChunk(
  j: Record<string, unknown>,
  got: StreamGot,
  partial: Map<number, { id: string; name: string; args: string }>,
  emit: (e: SseEvent) => void,
): void {
  const type = String(j.type ?? '')
  if (type === 'content_block_delta') {
    const d = j.delta as { type?: string; text?: string; partial_json?: string } | undefined
    if (d?.type === 'text_delta' && d.text) {
      got.text += d.text
      emit({ type: 'delta', text: d.text })
    } else if (d?.type === 'input_json_delta' && d.partial_json) {
      const bi = Number((j.index ?? 0) as number)
      const cur = partial.get(bi) ?? { id: '', name: '', args: '' }
      cur.args += d.partial_json
      partial.set(bi, cur)
    }
  } else if (type === 'content_block_start') {
    const cb = j.content_block as { type?: string; id?: string; name?: string } | undefined
    if (cb?.type === 'tool_use') {
      const bi = Number((j.index ?? 0) as number)
      partial.set(bi, { id: cb.id ?? `t${bi}`, name: cb.name ?? '', args: '' })
    }
  } else if (type === 'error') {
    emit({ type: 'error', text: JSON.stringify(j.error ?? j).slice(0, 400) })
  }
}

function handleOllamaLine(line: string, got: StreamGot, emit: (e: SseEvent) => void): void {
  let j: { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }; done?: boolean; error?: string }
  try {
    j = JSON.parse(line) as typeof j
  } catch {
    return
  }
  if (j.error) emit({ type: 'error', text: j.error })
  const c = j.message?.content
  if (c) {
    got.text += c
    emit({ type: 'delta', text: c })
  }
  for (const tc of j.message?.tool_calls ?? []) {
    let args: Record<string, unknown> = {}
    const a = tc.function?.arguments
    if (typeof a === 'string') { try { args = JSON.parse(a) as Record<string, unknown> } catch { args = {} } }
    else if (a && typeof a === 'object') args = a as Record<string, unknown>
    got.toolCalls.push({ id: `ollama_${got.toolCalls.length}`, name: tc.function?.name ?? '', args })
  }
}

/* ══════════════════════════════════════════════════════════════
 * 六、拉模型列表
 * ══════════════════════════════════════════════════════════════ */

export async function listModels(cfg: AiConfig): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const prov = AI_PROVIDERS.find((x) => x.id === cfg.provider) ?? AI_PROVIDERS[0]
  const key = await resolveKey(cfg, prov)
  if (prov.needsKey && !key) return { ok: false, models: [], error: '没有 API Key' }
  try {
    const r = await fetch(modelsUrl(prov, cfg.baseUrl), { headers: headersFor(prov, key) })
    if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` }
    const j = (await r.json()) as { data?: { id?: string }[]; models?: { name?: string; model?: string }[] }
    const ids = j.data?.map((x) => x.id).filter((x): x is string => !!x) ?? []
    const oll = j.models?.map((x) => x.name ?? x.model).filter((x): x is string => !!x) ?? []
    const models = (ids.length ? ids : oll).slice(0, 200)
    return models.length ? { ok: true, models } : { ok: false, models: [], error: '上游没返回模型列表(该端点可能不支持 /models,可手填模型名)' }
  } catch (e) {
    return { ok: false, models: [], error: String(e) }
  }
}

/* ══════════════════════════════════════════════════════════════
 * 七、预览暂存区管理
 * ══════════════════════════════════════════════════════════════ */

const previewStore = new Map<string, PreviewItem>()

export function putPreview(item: PreviewItem): void {
  previewStore.set(item.id, item)
}

export function getPreview(id: string): PreviewItem | undefined {
  return previewStore.get(id)
}

export function dropPreview(id: string): void {
  previewStore.delete(id)
  /* 尽力清掉可能写出的临时文件(本实现不落盘 preview,留着以防将来改) */
  try {
    const abs = join(process.cwd(), PREVIEW_DIR, id + '.txt')
    if (existsSync(abs)) rmSync(abs, { force: true })
  } catch { /* 清不掉就算了,不影响主流程 */ }
}

/** 把相对路径写进 preview 暂存目录(供将来「导出补丁」用) */
export function savePreviewFile(id: string, content: string, baseDir: string): string {
  const dir = join(baseDir, PREVIEW_DIR)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, id + '.txt')
  writeFileSync(p, content, 'utf8')
  return p
}

export { PREVIEW_DIR }
export type { SseEvent }

/* 让 TS 知道 relative/dirname 被用到(给未来扩展留位置,不报未使用) */
void relative
void dirname
