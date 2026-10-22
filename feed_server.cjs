// 真机验收 · 本地更新源服务器
// 把 dist/ 目录以静态文件方式暴露出来,模拟 electron-updater 的 generic feed。
// electron-updater 拉取顺序: <url>/latest.yml -> 解析 files[].url -> 下载安装包。
// 本脚本只负责把 dist/ 当文件服务器跑起来(默认端口 5999)。
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.FEED_DIR || path.join(__dirname, 'dist')
const PORT = Number(process.env.FEED_PORT || 5999)

const types = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.json': 'application/json',
  '.html': 'text/html',
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/latest.yml'
  const fp = path.join(ROOT, p)
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('not found: ' + p); return
  }
  const buf = fs.readFileSync(fp)
  res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' })
  res.end(buf)
})
server.listen(PORT, () => console.log(`[feed] serving ${ROOT} @ http://127.0.0.1:${PORT}/  (latest.yml -> ${ROOT}/latest.yml)`))
