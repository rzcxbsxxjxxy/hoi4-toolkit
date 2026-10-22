// 真机验收辅助:以「打包态」方式拉起编译后的 server.mjs(等价于 Electron 主进程
// 用 ELECTRON_RUN_AS_NODE 跑 server.mjs),注入与 main.mjs 一致的 env,
// 供 headless Edge 加载 built UI 做端到端功能验收。
const { spawn } = require('node:child_process')
const path = require('node:path')

const KIT_ROOT = path.resolve(__dirname, '..', '..', '..')
const SERVER_MJS = path.join(__dirname, 'server.mjs')
const PORT = Number(process.env.HOI4TK_PORT || 5173)
const DATA_DIR = process.env.HOI4TK_DATA || path.join(__dirname, '..', '..', '..', 'accept_data')

function waitForServer(timeoutMs = 90000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/status`)
        if (r.ok) return resolve(true)
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error('后端启动超时'))
      setTimeout(tick, 500)
    }
    tick()
  })
}

const child = spawn(process.execPath, [SERVER_MJS, '--port', String(PORT)], {
  cwd: KIT_ROOT,
  env: {
    ...process.env,
    HOI4TK_ROOT: KIT_ROOT,
    HOI4TK_DATA: DATA_DIR,
    HOI4_NO_REG: process.env.HOI4_NO_REG || '1',
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
child.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`))
child.on('exit', (code) => { console.error(`[run_packaged] server 退出 code=${code}`); process.exit(code || 0) })

waitForServer()
  .then(() => { console.log(`[run_packaged] 后端就绪 @ http://127.0.0.1:${PORT}`); })
  .catch((e) => { console.error(e.message); child.kill(); process.exit(1) })

// 让进程常驻直到被外部 kill(验收脚本通过它连后端)
process.on('SIGINT', () => { child.kill(); process.exit(0) })
process.on('SIGTERM', () => { child.kill(); process.exit(0) })
