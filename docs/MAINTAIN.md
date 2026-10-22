# 维护者指南（MAINTAIN）

本文件写给**后续维护者 / 想参与开发的人**。普通用户请看根目录的 `README.md` 与 `新手指南.md`。

> **项目形态**：本仓库是一个**自包含的完整 Electron 桌面程序**（主进程 `main.cjs` + 打包后端 `server.mjs`）。
> **不含任何浏览器模式内容**（无 `run-gui.*` / `boot.cjs`）。开发调试用 `npm start`。

---

## 1. 目录结构（职责边界）

```
toolkit-electron/
├─ README.md · 新手指南.md      ← 用户文档（根目录，醒目）
├─ main.cjs · preload.cjs · splash.html  ← Electron 主进程 / 预加载 / 启动闪屏
├─ server.mjs                   ← 编译后的后端（esbuild 打包，Electron 自带 Node 托管）
├─ app\                         ← 免安装可运行程序 =「安装后内容」（双击 app\HOI4 工具链.exe 即用）
├─ ..\build-installer\          ←【上一级】打包流水线（.bat/.sh 双击入口 + build-installer.mjs 本体）
├─ stage.mjs · clean.mjs        ← 打包辅助（暂存 / 清理 public）
├─ build/                       ← 打包资源（build/icon.ico 等）
├─ gui-settings.example.json   ← 用户复制成 gui-settings.json 的配置模板
├─ package.json · .gitignore · VERSION · CHANGELOG.md · version.json
├─ packages/                   ← 程序本体（parser / engine / gui / cli / spec）
├─ common/ · spec/             ← 数据 / 规格（common/ 含用户本地数据，已被 git 忽略）
├─ docs/                       ← 工程文档：deploy.md / MAINTAIN.md / COMPARE-TOOLS.md /
│                                 EXEC-PLAN.md / IMPROVE-PLAN.md / assets/*.png（截图）
└─ tools/                      ← 开发 / QA 脚本（verify_* / compare_* / measure_* /
                                  audit_* / render_layout / patch_* / selfcheck / smoke_e2e …）
```

> **铁律**：`main.cjs` / `boot.cjs` 均通过 `__dirname` / `path.join(__dirname, ...)` 引用文件，
> 因此电子壳相关资源（`preload.cjs` / `splash.html` / `server.mjs`）与启动器（`run-gui.*` / `boot.cjs` /
> `gui-settings.example.json`）必须留在根目录。`tools/` 里的脚本一律用 `../packages/...` 引用本体。
> `tools/` 里的脚本一律用 `../packages/...` 引用本体（已统一改写），所以从任意 cwd 都能跑。

---

## 2. 日常开发

- **桌面程序（主路径）**：`npm start` —— Electron 壳拉起 `server.mjs` 并打开原生窗口，
  直接读 `packages/gui/public`（无需暂存），改 `packages/gui` 源码后重启即生效。
- **纯 Web 模式（可选）**：双击 `run-gui.bat`（或 `./run-gui.sh`）直接跑 `server.ts` + 浏览器。
- **改后端**：后端在 `packages/gui/src/server.ts`；`npm run build:server` 把它打包成根目录 `server.mjs`
  （`main.cjs` 通过 `ELECTRON_RUN_AS_NODE` 由 Electron 自带 Node 拉起，**用户机无需装 Node**）。
- **改前端**：都在 `packages/gui/public/` 下，静态资源，改完刷新即可。
- **跑测试 / QA**：`node tools/<脚本>.ts`（或 `.cjs`）。Node 22.6+ 直接跑 `.ts`，无需构建。
- **零依赖 / 零构建**：本体只用 Node 内置能力 + `--experimental-strip-types`，不要引入第三方运行时依赖
  （启动器 `boot.cjs` 更是严禁；Electron 相关依赖只在 `devDependencies` / `dependencies` 里声明）。

---

## 3. 如何发版本

### 统一版本源（必须同步修改）
- `VERSION`：一行纯版本号，供 `boot.cjs` 本地读取，也作为安装包版本号来源。
- `version.json`：给「发布包渠道」用的远程清单（`download` 填发布页 / 压缩包地址）。
- `package.json` 的 `version` 字段：同时是 Electron 安装包版本号（`artifactName` 用 `${version}`）。
- 并在 `CHANGELOG.md` 加一条 `[x.y.z] - 日期` 记录用户可见变化。

### 渠道 A：Git（开发者 / 进阶用户）
1. 提交改动：`git add -A && git commit -m "..."`
2. 打 tag：`git tag v0.4.0 && git push --tags`
3. 推到远程（GitHub / Gitee）。用户端 `git pull` 后 `npm start` 即更新。

### 渠道 B：NSIS 安装包 + 自动更新（普通用户，零门槛）
1. **一键出包**：Windows 双击上一级目录的 `..\build-installer\build-installer.bat`（或在本目录 `npm run dist`）→
   生成 `..\toolkit-installer\HOI4-Toolkit-Setup-<version>.exe` + `latest.yml`（自动更新元数据）。
   后台流程：`build:server`（编译后端）→ `stage`（暂存 public）→ `electron-builder --win nsis` → `clean`。
2. 把 `HOI4-Toolkit-Setup-<version>.exe` 与 `latest.yml` **一起**上传到更新源目录。
3. 用户安装后，程序启动会自动检测更新（见第 4 节），可一键下载安装，
   **不会覆盖**其 `%APPDATA%\hoi4-toolkit\gui-settings.json` 等数据。
4. 安装包内容保持纯净：`package.json` 的 `build.files` 明确**不含真实 `gui-settings.json`**，
   只含 `gui-settings.example.json`，用户数据在运行时生成于 `%APPDATA%\hoi4-toolkit\`（userData）。

### 渠道 B'：免安装免注册（`app\` = 安装后内容）
1. `npm run pack`（= `electron-builder --dir`）生成免安装程序到 `app\`，其中
   `app\HOI4 工具链.exe` **双击即用、无需安装**，app 资源完整内置于 `app\resources\app\`。
   该目录就是「安装包安装出来的内容」，已在 `.gitignore` 中忽略。

> 更新源占位：默认回退到 `package.json` 的 `build.publish[0].url`（当前为占位地址），
> 上线前请替换为真实托管目录；或用环境变量 `HOI4TK_UPDATE_URL` 临时覆盖。

---

## 4. 版本检查 / 自动更新机制

两种入口都通过 `HOI4TK_UPDATE_URL` 指向托管 `version.json`（含 `latest.yml` 的同级目录）：

- **纯 Web 模式（`boot.cjs`）**：仅当 `HOI4TK_UPDATE_URL` 非空时检查；拉取 `<URL>/version.json` 对比本地
  `VERSION`，**非阻塞、失败静默**，发现新版本只打印黄色提示，不自动更新。
- **桌面程序（`electron-updater`）**：仅 `app.isPackaged` 时启用；`autoDownload=false`，发现新版本弹窗询问，
  用户同意后才下载并 `quitAndInstall`。未配置更新源 / 离线时静默跳过，不弹错。

本地自测版本提示 / 更新：
```bash
# 纯 Web 模式
HOI4TK_UPDATE_URL=https://你的静态地址/ node run-gui.bat

# 桌面程序：把 version.json + latest.yml + 安装包放在同一目录，设该目录 URL 后启动
set HOI4TK_UPDATE_URL=https://你的静态地址/
npm start
```

---

## 5. 提交前注意（gitignore 已在守护）

- `gui-settings.json`：每个用户自己的设置（含本机绝对路径），**绝不提交**。
  运行时实际位置是固定的 **`%APPDATA%\hoi4-toolkit\gui-settings.json`**（不在仓库里）。
- `common/`：用户本地模组样例数据，**已忽略**。
- `app/`：免安装程序 =「安装后内容」，**已忽略**；`public/`：打包暂存目录，**已忽略**（开发态不进仓库）。
- `../toolkit-installer/`：NSIS 安装包输出目录（在项目外，不入库）。
- `_*.json` / `_*.log` / `_*.png`：运行期生成物 / 临时文件，**已忽略**。
- 不要把第三方依赖装进仓库（`node_modules/` 已忽略）。
- `asar` 当前**关闭**（`build.asar=false`）：因后端 `server.mjs` 需以 `ELECTRON_RUN_AS_NODE` 直接执行，
  不能压进 asar；此为非致命告警，属预期设置。
