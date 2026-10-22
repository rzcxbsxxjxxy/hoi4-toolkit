/**
 * AIDE_V1 验收用 mock 上游(OpenAI 兼容协议)
 *
 * 为什么需要它:真实 provider 要 key、要联网,而本机不一定有。
 * 起一个本地假端点,把「流式 + 工具调用 + 工具结果回传」的完整链路
 * 跑通,才能证明 SSE 解析、增量 tool_calls 拼接、工具循环都对。
 *
 * 行为(按轮次):
 *   第 1 轮:回一个 tool_call  list_sources
 *   第 2 轮:回一个 tool_call  read_file(读一个真实存在的文件)
 *   第 3 轮:回纯文本总结 + 结束
 * 另支持 ?fail=1 直接返 500,用来验错误路径。
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 5299)
/** 当前轮次:每请求按「历史里有几条 tool 结果」重算,不跨请求累加 */
let round = 1

const TOOLS_R1 = { id: 'call_1', name: 'list_sources', arguments: '{}' }
const TOOLS_R2 = { id: 'call_2', name: 'read_file', arguments: JSON.stringify({ rootIdx: 0, file: 'common/national_focus/00_kanzai.txt', maxLines: 5 }) }

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (process.argv.includes('--fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock 故意失败' } }))
      return
    }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    /* 真实语义:一轮「工具循环」= 同一个会话里的多次请求。
     * 上游分不清会话,所以这里用「请求体里有没有 tool 角色的历史」来判断:
     *   - 没有 tool 结果 → 这是该会话的第 1 次请求(该发 tool_call)
     *   - 有 tool 结果(1 条)→ 第 2 次(再发一个 tool_call)
     *   - 有 2 条 tool 结果 → 第 3 次(收尾纯文本)
     * 这样每次新对话都从第 1 轮开始,验收可重复跑,不需要额外参数。*/
    let toolResults = 0
    try {
      const parsed = JSON.parse(body || '{}') as { messages?: { role?: string; tool_call_id?: string }[] }
      for (const m of parsed.messages ?? []) if (m.role === 'tool' || m.tool_call_id) toolResults++
      /* ollama 协议无 tool 角色,用「assistant 带 tool_calls」也算一条 */
      for (const m of parsed.messages ?? []) {
        const x = m as unknown as { tool_calls?: unknown }
        if (x.tool_calls) toolResults++
      }
    } catch { /* 解析失败按第 1 轮 */ }
    round = toolResults >= 2 ? 3 : toolResults === 1 ? 2 : 1
    const usage = { prompt_tokens: 10, completion_tokens: 5 }
    if (round === 1) {
      /* 第一段文本 + 一个 tool_call(故意分两片发,验证增量拼接) */
      sse(res, { choices: [{ delta: { content: '我先看看有哪些来源。' } }] })
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_', arguments: '{"root' } }] } }] })
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'sources', arguments: 'Idx":0}' } }] } }] })
    } else if (round === 2) {
      sse(res, { choices: [{ delta: { content: '接着读一个文件。' } }] })
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: TOOLS_R2.id, function: { name: TOOLS_R2.name, arguments: TOOLS_R2.arguments } }] } }] })
    } else {
      const text = '总结:来源如上。我确认过文件内容,没有发现问题。'
      for (const ch of text) sse(res, { choices: [{ delta: { content: ch } }] })
      sse(res, { choices: [{ delta: {}, usage }] })
    }
    sse(res, { data: '[DONE]' })
    res.end()
    console.log(`[mock] round=${round} 已响应`)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[mock] 上游 mock 已起在 http://127.0.0.1:${PORT}/v1`))
