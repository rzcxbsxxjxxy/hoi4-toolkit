// HOI4 Toolkit · Electron 预加载桥(contextIsolation 沙箱边界)
//
// 渲染进程(Navigator/页面)只通过 window.electronAPI 与主进程通信,
// 绝不直接 require('fs') / 读游戏目录——文件访问全部发生在后端子进程。
// 注:前端现有 fetch('/api/...') 仍走 loopback HTTP(后端就在本机子进程),
// 已被 D 层响应缓存加速;若后续要彻底去掉 loopback,可在此 patch fetch
// 经 ipcRenderer 转发到主进程(可选优化,非必需)。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectronHost: true,
  quit: () => ipcRenderer.invoke('app:quit'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  reloadModules: () => ipcRenderer.invoke('app:reload-modules'),
  // ── 窗口控制(frame:false 下自建标题栏需要)──
  windowMinimize: () => ipcRenderer.invoke('win:min'),
  windowMaximize: () => ipcRenderer.invoke('win:max'),
  windowClose: () => ipcRenderer.invoke('win:close'),

  windowIsMaximized: () => ipcRenderer.invoke('win:isMax'),
  openDevTools: () => ipcRenderer.invoke('win:open-devtools'),
  // 主进程最大化/还原状态变化时回调(用于切换标题栏按钮图标)
  onMaximizedChange: (cb) => ipcRenderer.on('win:max-changed', (_e, v) => cb(v)),
  // ── frameless 自定义缩放(electron-host 专用)──
  getBounds: () => ipcRenderer.invoke('win:getBounds'),
  setBounds: (b) => ipcRenderer.invoke('win:setBounds', b),
  // ── 启动闪屏进度(splash 页面监听)──
  onSplashProgress: (cb) => ipcRenderer.on('splash:progress', (_e, s) => cb(s)),
  onSplashDone: (cb) => ipcRenderer.on('splash:done', () => cb()),
  // ── FRONT_READY:壳页前端完全就绪(初始页 iframe 加载完成)后通知主进程再显示主窗口
  windowShowReady: () => ipcRenderer.send('front-ready'),
  // ── 桌面程序图标(APP_ICON_V1):设置页选图后实时套用到窗口/任务栏 ──
  setAppIcon: (dataUri) => ipcRenderer.invoke('app:set-icon', dataUri),
  // ── 软件更新(设置页「软件更新」卡片;仅打包态可用)──
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  updateConfigured: () => ipcRenderer.invoke('app:update-configured'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, st) => cb(st)),
  // 打开外部链接(系统浏览器):设置页「项目主页」等
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
})
