# HOI4 模组工具链 (hoi4-toolkit) · Electron 桌面版

HOI4 模组工程化工具链：无损解析、索引、重构、可视化工作台。**完整的 Electron 桌面程序**。

本目录是**自包含的完整工程**：源码 + Electron 壳 + 打包配置都在这里，是导出安装包所使用的文件夹。
**不含任何浏览器模式内容**（无 `run-gui.*` / `boot.cjs`）。

## 环境要求
- **运行桌面程序**：无额外要求，程序自带运行环境（Electron 内置 Node）。
- **开发 / 打包**：需要 **Node.js ≥ 22.6** 与 npm。

## 快速开始

👉 **`新手指南.md`** 是写给第一次用的人的图文说明。

### 日常使用（开发）
```bash
cd toolkit-electron
npm install       # 首次
npm start         # 启动 Electron 桌面程序（开发模式，直接跑 packages/gui 源码）
```

### 出安装包（两步：先成品，再安装器）
1. **`更新成品.bat`**（在本目录）：编译后端 + 暂存前端 + `electron-builder --dir` 出免安装程序
   `app\win-unpacked`，并注入 `resources/app-update.yml`（GitHub 更新源）。
2. **`..\installer\deploy-installer.bat`**：把上一步的 `app\win-unpacked` 打包成自解压安装器，
   产物输出到 **`..\installer\dist\`**：
   - `HOI4-Toolkit-Installer-<版本>.exe` —— 自解压安装器（双击安装到自选目录）
   - `HOI4-Toolkit-Uninstaller-<版本>.exe` —— 随安装目录附带的独立卸载器
   - `HOI4-Toolkit-Portable-<版本>.zip` —— 免安装压缩包（解压即用的便携版）
- `latest.yml` —— 自动更新元数据（随安装器一起发布到 GitHub Releases）

> npm 等价命令：`npm run pack`（= 第 1 步）、`node ..\installer\tools\build.mjs`（= 第 2 步）。

## 目录结构
```
toolkit-electron/                ← 本目录：项目本体
├─ README.md · 新手指南.md        ← 用户文档
├─ 更新成品.bat · build-pack.ps1   ← 出免安装成品（app\win-unpacked）+ 注入更新源
├─ main.cjs · preload.cjs · splash.html  ← Electron 主进程 / 预加载 / 启动闪屏
├─ server.mjs · worker-entry.mjs   ← 编译后的后端（esbuild 打包，Electron 自带 Node 托管）
├─ package.json · .gitignore · VERSION · CHANGELOG.md · version.json
├─ stage.mjs · clean.mjs          ← 打包辅助（暂存 / 清理 public）
├─ tools/write-update-config.cjs  ← 把更新源(github)写入打包产物
├─ build/                         ← 打包资源（build/icon.ico 等）
├─ gui-settings.example.json      ← 配置模板
├─ packages/                      ← 程序本体（parser / engine / gui / cli / spec）
├─ docs/                          ← 工程文档（deploy.md / MAINTAIN.md / COMPARE-TOOLS.md / …）
├─ tools/                         ← 开发 / QA 脚本（verify_* / compare_* / audit_* / smoke_e2e …）
└─ （同级）installer/             ← 安装器构建：deploy-installer.bat → HOI4-Toolkit-Installer-*.exe
```

## 常用命令（package.json scripts）
```bash
npm start           # 启动 Electron 桌面程序（开发模式）
npm run build:server# 仅编译后端 server.ts → server.mjs
npm run pack        # 出免安装成品 app\win-unpacked（= 更新成品.bat 的命令行版）
npm run installer   # 生成安装器（委派 ../installer/tools/build.mjs → HOI4-Toolkit-Installer-*.exe）
npm run dist        # 同 installer（保留的惯用别名）
npm run stats       # 统计
npm run roundtrip   # 无损往返校验
npm run links       # 跨域链接检查
```

## 配置路径（重要：全部用户私有）
本工程**不含任何机器专属绝对路径**。游戏目录、模组路径、AI key 都来自你自己的
`gui-settings.json`（已被 git 忽略）：
- **位置**：**`%APPDATA%\hoi4-toolkit\gui-settings.json`**（固定路径，开发态/打包态一致）
- 复制 `gui-settings.example.json` 改名得到，把 `base` 改成你的 HOI4 安装目录，`mods` 填模组路径。

> 想参与维护 / 打发布包？见 `docs/MAINTAIN.md`。

## 更新（长期维护）
本工具通过统一的版本源（`VERSION` + `version.json` + `CHANGELOG.md`）管理版本。
每次变化都会写进 `CHANGELOG.md`，建议先看它再决定是否更新。

- **更新源 = GitHub Releases**（`rzcxbsxxjxjxxy/hoi4-toolkit`）：安装版**启动即在后台检查**新版本，
  无需手动触发；也可在「设置 → 软件更新」卡片点「检查更新」手动检查 / 下载 / 安装。
- 发布时把 `HOI4-Toolkit-Installer-<版本>.exe` 与 `latest.yml` 一并上传到 GitHub Releases 即可；
  想要免安装版的用户可下载随发布附带的 `HOI4-Toolkit-Portable-<版本>.zip`。
- 「设置 → 软件更新」卡片内的**项目主页**一键打开 GitHub 仓库；想用自建更新源时，可用
  环境变量 `HOI4TK_UPDATE_URL`（仅 `https` 或调试期 `HOI4TK_ALLOW_HTTP_UPDATE=1`）覆盖。