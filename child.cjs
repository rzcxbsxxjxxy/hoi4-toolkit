// child.cjs — 后端子进程适配入口(由 main.cjs child_process.fork 启动)
// import server.mjs(无端口模式:__mioIsMain=false 故不 listen),经 IPC 处理 app:// 请求。
// 后端全部重活在子进程,主进程只做窗口/UI —— 根治"后端构建/序列化阻塞主进程"的卡顿。
"use strict";
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

let server = null

async function load() {
  const m = await import(pathToFileURL(path.join(__dirname, 'server.mjs')).href + '?t=' + Date.now())
  server = m.server
  if (process.send) process.send({ type: 'ready' })
  console.log('[child] server loaded')
}

function handleRequest(id, req) {
  return new Promise((resolve) => {
    const bodyReq = Readable.from(req.body || [])
    bodyReq.method = req.method
    bodyReq.url = req.url
    bodyReq.headers = req.headers || {}
    bodyReq.socket = { remoteAddress: '127.0.0.1', remotePort: 0, encrypted: false }
    bodyReq.connection = bodyReq.socket
    let status = 200
    const headers = {}
    const chunks = []
    const res = {
      req: bodyReq, statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = String(v) },
      getHeader(k) { return headers[k.toLowerCase()] },
      removeHeader(k) { delete headers[k.toLowerCase()] },
      hasHeader(k) { return k.toLowerCase() in headers },
      getHeaders() { return headers },
      writeHead(s, h) { if (s) status = s; if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v) },
      write(c) { if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))) },
      end(c) {
        if (c != null) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
        resolve({ id, status, headers, body: Buffer.concat(chunks) })
      },
      on() { return res }, once() { return res }, emit() { return res },
      addListener() { return res }, removeListener() { return res }, removeAllListeners() { return res },
      flushHeaders() {}, cork() {}, uncork() {},
    }
    server.emit('request', bodyReq, res)
  })
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ping') { if (process.send) process.send({ type: 'pong' }); return }
  if (msg.type === 'shutdown') { process.exit(0); return }
  if (msg.id != null && msg.req) {
    try {
      const r = await handleRequest(msg.id, msg.req)
      // ★ IPC 体积护栏:默认 JSON 序列化会把 Buffer 展开成上亿个数字,超大响应体
      //   (如 166MB 的历史记录)会把本子进程撑爆/拖死,连带后端整体不可用。
      //   超限一律回 500 JSON,让前端展示真实原因,而不是静默崩溃。
      const MAX_IPC_BODY = 48 * 1024 * 1024
      if (r.body && r.body.length > MAX_IPC_BODY) {
        const err = JSON.stringify({ error: '响应体过大(' + Math.round(r.body.length / 1048576) + 'MB),已拒绝经 IPC 回传: ' + (msg.req.url || '') })
        if (process.send) process.send({ id: msg.id, status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(err) })
        return
      }
      if (process.send) process.send(r)
    } catch (e) {
      if (process.send) process.send({ id: msg.id, status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ error: 'internal error: ' + ((e && e.stack) || e) })) })
    }
  }
})

load().catch((e) => { console.error('[child] load failed', e); process.exit(1) })
