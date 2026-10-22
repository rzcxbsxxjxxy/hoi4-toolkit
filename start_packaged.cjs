// HOI4 Toolkit — 启动「免安装成品版」(app\win-unpacked)
// 由 启动打包版.bat 双击调用；直接 node 运行本文件亦可。
'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const exe = path.join(__dirname, 'app', 'win-unpacked', 'HOI4 Toolkit.exe')
if (!fs.existsSync(exe)) {
  console.error('未找到免安装成品：' + exe)
  console.error('请先在项目根运行一次：npm run pack')
  process.exit(1)
}
const child = spawn(exe, [], {
  detached: true,
  stdio: 'ignore',
  cwd: path.dirname(exe),
})
child.on('error', (e) => { console.error('启动失败：' + e.message); process.exit(1) })
child.unref()
console.log('已启动：' + exe)
setTimeout(() => process.exit(0), 1200)