// 供 run.bat 调用：判断 server.mjs 是否已是最新（后端源码未变）
// 退出码 0 = fresh（可直接 electron .）；2 = stale（需 npm start 构建）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const serverMjs = path.join(root, 'server.mjs')
const deps = [
  'packages/gui/src/server.ts',
  'packages/gui/src/worker-entry.ts',
  'tools/build-server.cjs',
].map((p) => path.join(root, p))
if (!fs.existsSync(serverMjs)) { console.log('fresh=0'); process.exit(2) }
const sm = fs.statSync(serverMjs).mtimeMs
for (const d of deps) {
  if (fs.existsSync(d) && fs.statSync(d).mtimeMs > sm) { console.log('fresh=0'); process.exit(2) }
}
console.log('fresh=1')
process.exit(0)