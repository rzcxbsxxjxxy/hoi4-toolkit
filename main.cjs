// HOI4 Toolkit · Electron 主进程(v3)
//
// CommonJS:Electron 对 require('electron') 原生支持最稳。server.mjs 是 ESM,
// 由 ELECTRON_RUN_AS_NODE 单另拉起,互不影响。
//
// v3 桌面壳域新增:
//   B1 窗口状态记忆(window-state.json:大小/位置/最大化态,重启还原,防拔屏跑出界)
//   B2 系统托盘 + 关闭按钮隐藏到托盘(后端继续跑);托盘菜单:显示/导出日志/退出
//   B3 后端 stdout/stderr 按天落盘 + 异常退出/未捕获异常写 crash-main-*.log + 导出日志

const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, screen, protocol, net, shell } = require('electron')

// app:// 自定义协议:standard → 解析成 host+path,前端相对 URL 正常解析。必须在 app ready 前声明。
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
const { spawn, spawnSync, fork } = require('node:child_process')
const {
  existsSync, copyFileSync, readFileSync, writeFileSync,
  appendFileSync, mkdirSync, readdirSync,
} = require('node:fs')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')
const zlib = require('node:zlib')

// electron-updater 仅在打包态 + 已声明更新源时使用;开发态或未配置时不加载。
let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch (e) { autoUpdater = null }

// 资源根:开发态 = toolkit 根;打包态 = resources/app。
const KIT_ROOT = __dirname
const SERVER_MJS = join(__dirname, 'server.mjs')
let PORT = Number(process.env.HOI4TK_PORT || 5173)

// 可写数据根(与 server.ts 契约一致):%APPDATA%\hoi4-toolkit
function kitData() { return app.getPath('userData') }

// ═══════════════════ SEC_NAV_V1(2026-10-22):窗口打开/导航守卫 ═══════════════════
// Electron 安全清单硬性项:渲染进程的任何"开新窗/跳走"都必须经主进程审批。
//   · setWindowOpenHandler —— window.open / target=_blank 的唯一出口
//   · will-navigate        —— 顶层框架被导航走的唯一出口
// 策略:app:// 本应用页面放行(应用内弹窗,如 /open?q=);其余一律拒绝并交
// shell.openExternal(系统浏览器 / vscode:// 等协议处理器)。
// file: 与 javascript: 显式拒绝 —— 前者等于把本地路径交给默认程序,后者无意义。
function openExternalSafe(u) {
  try {
    const proto = u.protocol
    const ok = proto === 'http:' || proto === 'https:' ||
      (proto !== 'file:' && proto !== 'javascript:' && proto !== 'data:' && proto !== 'about:' && /^[a-z][a-z0-9+.-]*:$/.test(proto))
    if (!ok) return
    shell.openExternal(u.toString()).catch(() => {})
  } catch (e) {}
}
function guardWebContents(wc) {
  if (!wc || wc.__secGuard) return
  wc.__secGuard = true
  wc.setWindowOpenHandler(({ url }) => {
    let u = null
    try { u = new URL(url, 'app://local/') } catch (e) { return { action: 'deny' } }
    if (u.protocol === 'app:') return { action: 'allow' } // 应用内弹窗(同协议,仍走后端路由白名单)
    openExternalSafe(u)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    let u = null
    try { u = new URL(url, 'app://local/') } catch (e2) { e.preventDefault(); return }
    if (u.protocol === 'app:') return
    e.preventDefault()
    openExternalSafe(u)
  })
}
function tempDir() {
  const t = join(kitData(), 'temp')
  try { mkdirSync(t, { recursive: true }) } catch (e) {}
  return t
}

let serverChild = null
let mainWin = null
let splashWin = null
let shuttingDown = false // 优雅退出标记:真正退出(托盘退出/app.quit)时置 true,避免误报崩溃与拦截 close
let reloading = false // 模组重载中(关大窗→splash→重启后端→重开大窗):此时 kill 后端不误报崩溃
let tray = null

// ── 一次性迁移:历史"项目目录旁" gui-settings.json → userData ──
function migrateLegacySettings(dataDir) {
  try {
    const target = join(dataDir, 'gui-settings.json')
    if (existsSync(target)) return
    const legacy = join(KIT_ROOT, 'gui-settings.json')
    if (existsSync(legacy)) {
      copyFileSync(legacy, target)
      console.log('[electron] 已迁移设置: 项目目录 -> ' + target)
    }
  } catch (e) {
    console.warn('[electron] 迁移旧设置失败(忽略): ' + e)
  }
}

// ═══════════════════════ B3:日志落盘 ═══════════════════════
function serverLogPath() {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return join(tempDir(), `server-${ymd}.log`)
}
function appendServerLog(data) {
  try {
    appendFileSync(serverLogPath(), `[${new Date().toISOString()}] ${data.toString()}`, 'utf8')
  } catch (e) { /* 日志写盘失败不影响主流程 */ }
}
function writeCrashLog(reason, code, signal) {
  try {
    const ts = new Date()
    const tag = ts.toISOString().replace(/[-:T]/g, '-').replace(/\..+$/, 'Z')
    const p = join(tempDir(), `crash-main-${tag}.log`)
    let tail = ''
    try {
      const c = readFileSync(serverLogPath(), 'utf8')
      tail = c.trim().split('\n').slice(-30).join('\n')
    } catch (e) { /* server log 可能不存在 */ }
    const body = [
      `时间: ${ts.toISOString()}`,
      `原因: ${reason}`,
      `exit code: ${code}`,
      `exit signal: ${signal}`,
      `--- server log 尾部(最多30行) ---`,
      tail,
    ].join('\n')
    writeFileSync(p, body, 'utf8')
    console.log(`[electron] crash log written: ${p}`)
    return p
  } catch (e) {
    console.warn('[electron] write crash log failed:', e)
  }
}

// 主进程自身未捕获异常:写 crash log 后继续运行(不退出,保持健壮性语义)
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err)
  try {
    writeCrashLog(`主进程未捕获异常: ${err && err.stack ? err.stack : String(err)}`, null, null)
  } catch (e) {}
})

// ═══════════════════════ B1:窗口状态记忆 ═══════════════════════
function windowStateFile() { return join(kitData(), 'window-state.json') }

function loadWindowState() {
  try {
    const p = windowStateFile()
    if (!existsSync(p)) return null
    const s = JSON.parse(readFileSync(p, 'utf8'))
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y) &&
        Number.isFinite(s.width) && Number.isFinite(s.height)) return s
  } catch (e) {}
  return null
}

// 校验 b 至少与某个显示器工作区相交 —— 防拔显示器/改分辨率后窗口跑出屏幕。
function boundsOnScreen(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) ||
      !Number.isFinite(b.width) || !Number.isFinite(b.height)) return false
  if (b.width < 400 || b.height < 300) return false
  try {
    for (const d of screen.getAllDisplays()) {
      const wa = d.workArea
      const overlap = b.x < wa.x + wa.width && b.x + b.width > wa.x &&
                      b.y < wa.y + wa.height && b.y + b.height > wa.y
      if (overlap) return true
    }
  } catch (e) {}
  return false
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const state = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
    mkdirSync(kitData(), { recursive: true })
    writeFileSync(windowStateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch (e) { console.warn('[electron] save window state failed:', e) }
}

let winSaveTimer = null
function scheduleSaveWindowState(win) {
  if (winSaveTimer) clearTimeout(winSaveTimer)
  winSaveTimer = setTimeout(() => saveWindowState(win), 500)
}

// ═══════════════════════ B2:托盘图标(程序化 PNG 回退) ═══════════════════════
// 图标策略:开发态优先读 build/icon.ico(与任务栏图标同源,视觉统一);
// 打包态若 files 白名单未含 ico,回退到下面程序化生成的 32x32 PNG,保证托盘永远有图标。
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      crc32.table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function makePngBuffer(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 6 })
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeFallbackIconImage() {
  const size = 32
  const rgba = Buffer.alloc(size * size * 4)
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a
  }
  const rr = 7
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角蓝色方块底
      const cx = Math.min(Math.max(x, rr), size - rr)
      const cy = Math.min(Math.max(y, rr), size - rr)
      const dx0 = x - cx, dy0 = y - cy
      if (dx0 * dx0 + dy0 * dy0 <= rr * rr) put(x, y, 31, 111, 235, 255) // #1f6feb
      // 白色圆环(中心 16,16,外径 9 内径 5)
      const dx = x - 15.5, dy = y - 15.5
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d >= 5 && d <= 9) put(x, y, 255, 255, 255, 255)
    }
  }
  return nativeImage.createFromBuffer(makePngBuffer(size, size, rgba))
}

function trayIcon() {
  try {
    const ico = join(KIT_ROOT, 'build', 'icon.ico')
    if (existsSync(ico)) {
      const img = nativeImage.createFromPath(ico)
      const small = img.resize({ width: 32, height: 32 })
      if (!small.isEmpty()) return small
    }
  } catch (e) {}
  return makeFallbackIconImage()
}

// ═══════════════════════ B2:托盘菜单与退出 ═══════════════════════
function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) { createWindow(); return }
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
}

function quitApp() {
  shuttingDown = true
  saveWindowState(mainWin)
  if (mainWin) { try { mainWin.destroy() } catch (e) {} }
  killServerChild().then(() => app.quit())
}
// ── 模组切换重载(2026-10):关大窗 → 显示启动小窗 → 重启后端(读新配置) → 重开大窗 ──
// 停止后端子进程(模组切换/退出/重启时调用)
async function killServerChild() {
  if (mioChild) {
    const c = mioChild
    mioChild = null
    try { c.send({ type: 'shutdown' }) } catch (e) {}
    try { c.kill() } catch (e) {}
  }
  for (const [, pp] of __pendingReq) { try { pp.reject(new Error('backend restarted')) } catch (e) {} }
  __pendingReq.clear()
  return
}

async function reloadModules() {
  // 关掉可能残留的 splash
  if (splashWin && !splashWin.isDestroyed()) { try { splashWin.destroy() } catch (e) {} }
  splashWin = null
  // 先关大窗(不退出)
  if (mainWin && !mainWin.isDestroyed()) { saveWindowState(mainWin); try { mainWin.destroy() } catch (e) {} }
  mainWin = null
  // 重新出现初始化加载小窗口
  splashWin = createSplash()
  // 重启后端:让它读取已保存的新模组配置(重建 ROOTS)
  reloading = true
  await killServerChild()
  await startServer()
  const reporter = setInterval(async () => {
    try {
      const r = await net.fetch('app://local/api/status')
      if (!r.ok) return
      const s = await r.json()
      splashWin?.webContents.send('splash:progress', s)
    } catch (e) {}
  }, 400)
  try {
    await waitForServer()
  } catch (e) {
    clearInterval(reporter)
    reloading = false
    try { splashWin?.destroy() } catch (err) {}
    splashWin = null
    dialog.showErrorBox('重新加载失败', String(e))
    createWindow()
    return { ok: false, error: String(e) }
  }
  clearInterval(reporter)
  reloading = false
  splashWin?.webContents.send('splash:progress', { ready: true, building: false, phase: '', done: 1, total: 1 })
  createWindow()
  return { ok: true }
}
ipcMain.handle('app:reload-modules', () => reloadModules())

// B3:导出日志 —— 选目录 → 复制 temp 下 crash-*.log / crash-main-*.log / server-*.log
async function exportLogs() {
  try {
    const res = await dialog.showOpenDialog(mainWin || undefined, {
      title: '选择日志导出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths || !res.filePaths.length) return // 取消静默
    const dest = res.filePaths[0]
    const files = readdirSync(tempDir()).filter((f) => /^(crash-main-|crash-|server-).*\.log$/.test(f))
    let n = 0
    for (const f of files) {
      try { copyFileSync(join(tempDir(), f), join(dest, f)); n++ } catch (e) {}
    }
    await dialog.showMessageBox({
      type: 'info',
      title: '导出日志完成',
      message: `已导出 ${n} 个日志文件到:\n${dest}`,
      buttons: ['确定'],
    })
  } catch (e) {
    dialog.showErrorBox('导出日志失败', String(e))
  }
}

function setupTray() {
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip('HOI4 Toolkit')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '导出日志', click: () => { exportLogs().catch((e) => console.warn(e)) } },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]))
    tray.on('double-click', () => showMainWindow())
  } catch (e) { console.warn('[electron] tray init failed:', e) }
}

// ═══════════════════════ 后端拉起 ═══════════════════════
// 后端在独立子进程(经 IPC 转发 app:// 请求),主进程只做窗口/UI —— 根治卡顿
const CHILD_CJS = join(__dirname, 'child.cjs')
let mioChild = null
let __reqId = 0
const __pendingReq = new Map() // id -> {resolve, reject}
function forwardReq(fetchReq) {
  return new Promise((resolve, reject) => {
    const u = new URL(fetchReq.url)
    const id = ++__reqId
    const req = { method: fetchReq.method, url: u.pathname + u.search, headers: {}, body: null }
    fetchReq.headers.forEach((v, k) => { req.headers[k] = v })
    __pendingReq.set(id, { resolve, reject })
    const sendIt = () => { try { mioChild.send({ id, req }) } catch (e) { __pendingReq.delete(id); reject(e) } }
    if (fetchReq.body) {
      const chunks = []
      ;(async () => {
        try { for await (const c of fetchReq.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)) } catch (e) {}
        req.body = Buffer.concat(chunks)
        sendIt()
      })()
    } else sendIt()
  })
}
function registerAppProtocol() {
  protocol.handle('app', async (fetchReq) => {
    try {
      const r = await forwardReq(fetchReq)
      const hdrs = new Headers()
      for (const [k, v] of Object.entries(r.headers || {})) hdrs.set(k, String(v))
      const body = Buffer.from(r.body || new Uint8Array())
      if (r.status === 304 || r.status === 204 || r.status === 205) return new Response(null, { status: r.status, headers: hdrs })
      return new Response(body, { status: r.status, headers: hdrs })
    } catch (e) {
      // ★ 回 JSON(而非纯文本):前端 resp.json() 才能取到 error 字段,
      //   弹窗显示真实原因;纯文本会退化成不可诊断的「HTTP 500」。
      return new Response(JSON.stringify({ error: 'internal error: ' + ((e && e.stack) || e) }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } })
    }
  })
}

async function startServer() {
  if (!existsSync(SERVER_MJS)) {
    dialog.showErrorBox('后端缺失', `未找到编译后的后端 ${SERVER_MJS}\n请先运行: npm run build:server`)
    app.quit()
    return
  }
  const dataDir = kitData()
  migrateLegacySettings(dataDir)
  process.env.HOI4TK_ROOT = KIT_ROOT
  process.env.HOI4TK_DATA = dataDir
  process.env.HOI4_NO_REG = process.env.HOI4_NO_REG || '1'
  console.log(`[electron] data dir (gui-settings.json): ${dataDir}`)
  console.log(`[electron] 启动后端子进程: ${CHILD_CJS} (app:// 协议经 IPC,无 TCP 端口)`)
  try { splashWin?.webContents.send('splash:progress', { phase: '初始化索引', ready: false, stageCount: 0 }) } catch (e) {}
  await killServerChild()
  mioChild = fork(CHILD_CJS, [], { serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  mioChild.stdout?.on('data', (d) => { process.stdout.write(d); appendServerLog(d) })
  mioChild.stderr?.on('data', (d) => { process.stdout.write(d); appendServerLog(d) })
  mioChild.on('message', (m) => {
    if (m && typeof m === 'object' && m.id != null && __pendingReq.has(m.id)) {
      const pp = __pendingReq.get(m.id)
      __pendingReq.delete(m.id)
      pp.resolve(m)
    }
  })
  mioChild.on('exit', (code, signal) => {
    console.log(`[electron] backend exited code=${code} signal=${signal}`)
    for (const [, pp] of __pendingReq) { try { pp.reject(new Error('backend exited')) } catch (e) {} }
    __pendingReq.clear()
  })
  // 等子进程 import server 完成(导出 server 并回 ready)
  await new Promise((resolve, reject) => {
    const tmr = setTimeout(() => reject(new Error('后端子进程 90s 未就绪')), 90000)
    const onMsg = (m) => { if (m && m.type === 'ready') { clearTimeout(tmr); resolve() } }
    mioChild.on('message', onMsg)
    mioChild.once('exit', () => { clearTimeout(tmr); reject(new Error('后端子进程退出')) })
  })
  registerAppProtocol()
  console.log('✔ 后端子进程已就绪(app:// 协议经 IPC)')
}
// 轮询 /api/status 直到后端构建完成(经 app:// -> 子进程)。
async function waitForServer(timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try { const r = await net.fetch('app://local/api/status'); if (r.ok) { const j = await r.json(); if (j && j.ready) return } } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('后端构建超时')
    await new Promise((res) => setTimeout(res, 400))
  }
}

function registerWindowIpc() {
  ipcMain.handle('win:min', () => mainWin?.minimize())
  ipcMain.handle('win:max', () => {
    if (!mainWin) return
    if (mainWin.isMaximized()) mainWin.unmaximize()
    else mainWin.maximize()
  })
  ipcMain.handle('win:close', () => mainWin?.close()) // close 事件里拦截为 hide
  ipcMain.handle('win:isMax', () => mainWin?.isMaximized() ?? false)
  ipcMain.handle('win:getBounds', () => {
    if (!mainWin) return null
    const r = mainWin.getBounds()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  ipcMain.handle('win:setBounds', (_e, b) => {
    // SEC_IPC_V1(2026-10-22):渲染进程传什么就直接喂给 setBounds 太冒险 ——
    // 非数值/负值/超大值都能把窗口锁死或扔到屏外( frameless 下用户无系统菜单可救)。
    // 这里逐字段校验 + 尺寸下限/上限夹取,只把干净的数字交出去。
    if (!mainWin || !b || typeof b !== 'object') return
    const nb = {}
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = b[k]
      if (v == null) continue
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      nb[k] = Math.round(n)
    }
    if (nb.width != null) nb.width = Math.max(240, Math.min(nb.width, 16384))
    if (nb.height != null) nb.height = Math.max(180, Math.min(nb.height, 16384))
    if (!Object.keys(nb).length) return
    try { mainWin.setBounds(nb) } catch (e) {}
  })
  // preload 桥接的 openDevTools(另一组在 preload.cjs 暴露);补 handler 消除悬空桥。
  ipcMain.handle('win:open-devtools', () => mainWin?.webContents.openDevTools({ mode: 'detach' }))
}

// ── 原生启动闪屏 ──
function createSplash() {
  const win = new BrowserWindow({
    width: 440,
    height: 250,
    frame: false,
    /* ★ BOOT_WHITE(2026-10-22):改为不透明白底。
       旧版 transparent:true + backgroundColor:'#00000000' —— Windows 上
       透明区域渲染成黑色,启动瞬间是一块黑底,与白色主题不符,
       且透明窗在部分 Windows 版本上会拖慢首帧。 */
    transparent: false,
    resizable: false,
    movable: true,
    /* FIX_SPLASH_TOPMOST:加载窗不置顶、不抢焦点,否则始终压在其他窗口前面 */
    alwaysOnTop: false,
    focusable: false,
    skipTaskbar: true,
    center: true,
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      /* SEC_SANDBOX_V1(2026-10-22):恢复渲染进程沙箱(Electron ≥20 的默认值,
         这里曾被显式关掉)。preload.cjs 只用到 electron 模块(contextBridge /
         ipcRenderer),沙箱预加载完全支持;关掉它等于给渲染进程攻击面
         开后门(一旦页面被注入,可直接摸 Node 原语)。 */
      sandbox: true,
    },
  })
  guardWebContents(win.webContents)
  win.loadFile(join(__dirname, 'splash.html'))
  return win
}

function createWindow() {
  // B1:读取上次窗口状态;校验在屏,否则默认 1440x900 居中
  const saved = loadWindowState()
  const opts = {
    minWidth: 1024,
    minHeight: 680,
    width: 1024,
    height: 768,
    title: 'HOI4 Toolkit',
    frame: false,
    /* FX_V2(2026-10-21):Win11 圆角窗口。Win10 上该选项被忽略(退回直角),
       不影响自建标题栏 —— 圆角裁的正是标题栏外侧两个角,与系统应用一致。 */
    roundedCorners: true,
    /* ★ BOOT_WHITE(2026-10-22):主窗口底色改白 —— 加载期(boot.html)与
       切到工作台之间的空档,深色底会闪一帧黑,与白色主题不符。 */
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      /* SEC_SANDBOX_V1:同 createSplash —— 恢复渲染进程沙箱。
         预加载只用 electron 模块,不受影响;风险面从"整个 Node 运行时"
         收回成"contextBridge 暴露的那几个 API"。 */
      sandbox: true,
    },
  }
  if (saved && boundsOnScreen(saved)) {
    opts.x = saved.x
    opts.y = saved.y
    opts.width = saved.width
    opts.height = saved.height
  } else {
    opts.center = true
  }
  const win = new BrowserWindow(opts)
  guardWebContents(win.webContents) // SEC_NAV_V1:开窗/导航守卫(见函数注释)
  // 最大化还原需在 show 之后调用:构造期隐藏窗口时 maximize() 不可靠。
  const shouldMaximize = !!(saved && saved.maximized)

  win.on('maximize', () => win.webContents.send('win:max-changed', true))
  win.on('unmaximize', () => win.webContents.send('win:max-changed', false))

  // B1:resize/move 防抖写回(最大化/还原也会触发 resize)
  win.on('resize', () => scheduleSaveWindowState(win))
  win.on('move', () => scheduleSaveWindowState(win))

  // B2(2026-10):右上角关闭 → 真正退出(杀后端 + quit),不再驻留托盘
  win.on('close', (e) => {
    if (shuttingDown) return
    e.preventDefault()
    saveWindowState(win)
    shuttingDown = true
    killServerChild().then(() => app.quit())
  })

  /* BOOT_EARLY:主窗口先加载本地 boot.html 加载页(渲染进程独立动画,不依赖后端),
   *   server 后台初始化完成后由 switchToApp 切到真实工作台页面,消除启动无响应。 */
  win.loadFile(join(__dirname, 'boot.html'))
  const __winT0 = Date.now()
  const showMainWindowNow = () => {
    if (win.isDestroyed() || win.isVisible()) return
    try { win.show() } catch (e) { console.log('[win:show] err', e) }
    console.log(`[win:show] 主窗显示(壳就绪;自 loadURL 起 ${Date.now() - __winT0}ms)`)
    if (splashWin) {
      try { splashWin.webContents.send('splash:done') } catch (e) {}
      const s = splashWin
      splashWin = null
      setTimeout(() => { try { s.close() } catch (e) {} }, 500)
    }
  }
  /* FRONT_READY:等壳页前端完全就绪(初始 iframe 加载完成)再显示主窗口,
     避免"主窗口出现但前端仍在初始化/首帧卡顿"的未响应体验。
     ready-to-show 不作为主路径(它可能早于前端就绪,导致过早显示)。 */
  win.webContents.on('ipc-message', (_e, channel) => {
    if (channel === 'front-ready') {
      console.log('[win] front-ready -^> show main window')
      if (shouldMaximize) { try { win.maximize() } catch (e) {} }
      showMainWindowNow()
    }
  })
  // fallback:若就绪信号未触发(极少数),load 完成后延迟补 show
  win.webContents.on('did-finish-load', () => { setTimeout(showMainWindowNow, 2500) })
  win.on('closed', () => { mainWin = null })
  mainWin = win
}

/** server 就绪后:主窗口从 boot 加载页切到真实工作台页面(app:// local/shell.html)。 */
function switchToApp(win) {
  if (!win || win.isDestroyed()) return
  try { win.loadURL('app://local/shell.html') } catch (e) { console.log('[win:switch] err', e) }
}

/** 等后端核心图构建完成(本地化+内容图,/api/status ready)。
 * 引用图已懒建不在此列。消除"切工作台后首屏卡顿"(方案①:延后切换)。 */
async function waitForBootReady(timeoutMs = 25000) {
  const t0 = Date.now()
  for (;;) {
    try { const r = await net.fetch('app://local/api/status'); if (r.ok) { const j = await r.json(); if (j && j.ready) { console.log(`[boot] backend build ready (+${Date.now() - t0}ms)`); return } } } catch (e) {}
    if (Date.now() - t0 > timeoutMs) { console.log(`[boot] waitForBootReady timeout (+${Date.now() - t0}ms)`); return }
    await new Promise((res) => setTimeout(res, 300))
  }
}

// ── 桌面程序图标(APP_ICON_V1) ──
function applyAppIcon(dataUri) {
  try {
    if (!mainWin || !dataUri || !String(dataUri).startsWith('data:')) return
    const img = nativeImage.createFromDataURL(dataUri)
    if (img.isEmpty()) return
    mainWin.setIcon(img)
  } catch (e) {}
}
ipcMain.handle('app:set-icon', (_e, dataUri) => applyAppIcon(dataUri))

async function fetchAndApplyAppIcon() {
  try {
    const r = await net.fetch('app://local/api/settings')
    if (!r.ok) return
    const cfg = await r.json()
    if (cfg && cfg.appIcon) applyAppIcon(cfg.appIcon)
  } catch (e) {}
}

// ── 自动更新(NSIS 安装包) ──
// 更新源优先级:显式环境变量 HOI4TK_UPDATE_URL > electron-builder 注入的 app-update.yml(build.publish)。
// 打包产物由 electron-builder 把 build.publish 写入 resources/app-update.yml,
// electron-updater 启动即自动读取;这里只在显式 env 存在时覆盖。
// SEC_UPDATE_V1(2026-10-22):更新链 = 提权链。http:// 明文 feed 可被中间人
// 篡改成任意 exe → 远程代码执行。因此只认 https;确需本地/局域网 http
// 调试时,显式设 HOI4TK_ALLOW_HTTP_UPDATE=1 才放行(该 env 不随安装包分发)。
function updateUrlAllowed(u) {
  if (!u || typeof u !== 'string') return false
  if (/^https:\/\//.test(u)) return true
  if (process.env.HOI4TK_ALLOW_HTTP_UPDATE === '1' && /^http:\/\//.test(u)) return true
  return false
}
function configuredUpdateUrl() {
  try {
    const p = join(process.resourcesPath || __dirname, 'app-update.yml')
    if (existsSync(p)) {
      const txt = readFileSync(p, 'utf8')
      // GitHub provider:app-update.yml 没有单一 url 字段,凭 provider 标记判定。
      // 占位符(owner 写成 YOUR_/REPLACE_WITH/EXAMPLE)视为未配置,避免打包后空跑 404。
      if (/provider:\s*['"]?github/.test(txt)) {
        return /REPLACE_WITH|YOUR_|EXAMPLE/i.test(txt) ? '' : 'github'
      }
      const m = txt.match(/url:\s*['"]?([^'"\s]+)/)
      if (m && m[1] && !/REPLACE_WITH/.test(m[1]) && updateUrlAllowed(m[1])) return m[1]
    }
  } catch (e) {}
  const env = process.env.HOI4TK_UPDATE_URL || ''
  return updateUrlAllowed(env) ? env : ''
}
function setupUpdater() {
  if (!app.isPackaged || !autoUpdater) return
  try {
    const feed = process.env.HOI4TK_UPDATE_URL
    if (feed && updateUrlAllowed(feed)) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // 状态推送到渲染进程(设置页「软件更新」卡片监听 update:state)
    const emit = (state, extra) => {
      const p = { state, ...(extra || {}) }
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:state', p)
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('update:state', p)
    }
    autoUpdater.on('error', (e) => emit('error', { message: (e && e.message) || String(e) }))
    autoUpdater.on('checking-for-update', () => emit('checking'))
    autoUpdater.on('update-available', (info) => emit('available', { version: info && info.version }))
    autoUpdater.on('update-not-available', () => emit('not-available'))
    autoUpdater.on('download-progress', (p) => emit('progress', {
      percent: Math.round((p && p.percent) || 0),
      transferred: p && p.transferred, total: p && p.total,
    }))
    autoUpdater.on('update-downloaded', (info) => emit('downloaded', { version: info && info.version }))
    // 只有配置了有效更新源才启动静默检查;否则由前端 UI 提示「未配置更新源」
    if (configuredUpdateUrl()) autoUpdater.checkForUpdates().catch(() => {})
  } catch (e) {}
}

// 更新接口:设置页「软件更新」卡片调用
ipcMain.handle('app:check-update', async () => {
  if (!app.isPackaged || !autoUpdater) return { ok: false, reason: 'not-packaged', message: '当前为开发模式或未启用自动更新' }
  try { autoUpdater.checkForUpdates(); return { ok: true } }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
})
ipcMain.handle('app:download-update', async () => {
  if (!app.isPackaged || !autoUpdater) return { ok: false, reason: 'not-packaged' }
  try { await autoUpdater.downloadUpdate(); return { ok: true } }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
})
ipcMain.handle('app:install-update', async () => {
  if (!app.isPackaged || !autoUpdater) return { ok: false, reason: 'not-packaged' }
  try { setImmediate(() => { try { autoUpdater.quitAndInstall() } catch (e) {} }); return { ok: true } }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
})
ipcMain.handle('app:update-configured', async () => {
  const url = configuredUpdateUrl()
  const provider = url === 'github' ? 'github' : (url ? 'generic' : 'none')
  return {
    ok: app.isPackaged && !!autoUpdater && provider !== 'none',
    provider,
    url: url && url.startsWith('http') ? url : '',
  }
})

// ── IPC(主进程 → 渲染进程 桥) ──
// 渲染进程请求在系统浏览器中打开外部链接(设置页「项目主页」等)
ipcMain.handle('app:open-external', (_e, url) => {
  try { openExternalSafe(new URL(String(url || ''))) } catch (e) {}
})
ipcMain.handle('app:quit', () => { shuttingDown = true; app.quit() })
ipcMain.handle('app:version', () => app.getVersion())
registerWindowIpc()

// 任何退出路径(菜单/Ctrl+Q/托盘)都先置 shuttingDown,避免 close 被拦截成 hide。
app.on('before-quit', () => { shuttingDown = true })

// 单实例锁。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('[electron] another instance is running, exit')
  app.quit()
} else {
  app.on('second-instance', async () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
    }
    // ★ 再运行一次 → 强制重启后端(加载最新 server.mjs / 模组配置),彻底解决"无法重启后端"
    try {
      reloading = true
      await startServer() // app:// 无端口:重新 import server + 重注册 protocol
      if (mainWin && !mainWin.isDestroyed()) { mainWin.loadURL('app://local/shell.html') }
    } catch (e) {
      dialog.showErrorBox('后端重启失败', String(e))
    } finally {
      reloading = false
    }
  })
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null) // P0-3: 去掉默认菜单栏,消除菜单占位与焦点开销
    const __bootT0 = Date.now()
    /* BOOT_EARLY:先创建主窗口并显示本地 boot.html 加载页(渲染进程独立动画,
     * 不依赖后端 import)。再后台加载 server;import 期间主窗口动画照常播放,
     * 不再出现"主窗口前一段黑屏/无响应"。后端就绪后 switchToApp 切真实页面。 */
    createWindow()
    console.log(`[boot] main window boot-page shown (+${Date.now() - __bootT0}ms)`)

    const __bootT1 = Date.now()
    await startServer()
    console.log(`[boot] backend loaded (+${Date.now() - __bootT1}ms 构建索引)`)
    // server 就绪后,等核心图构建完成(/api/status ready)再切工作台,
    // 消除"切过去首屏卡顿"(方案①:延后切换)。引用图已懒建,不在此列。
    await waitForBootReady()
    if (mainWin && !mainWin.isDestroyed()) switchToApp(mainWin)
    console.log(`[boot] app ready (+${Date.now() - __bootT0}ms)`)
    setupTray() // B2:主窗口就绪后建托盘
    fetchAndApplyAppIcon()
    setupUpdater()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// 托盘模式:点关闭按钮只是 hide(不触发 window-all-closed);
// 真正退出时 shuttingDown=true → 杀后端并 quit。
app.on('window-all-closed', () => {
  if (shuttingDown) {
    killServerChild().then(() => app.quit())
  }
})