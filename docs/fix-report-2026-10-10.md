# HOI4 模组工具链工作台 · 全面巡检修复与可移植性报告（2026-10-10）

> 目标：让工作台在**其他用户的设备**上也能正常运行，尽可能无误、稳定、高效。
> 范围：前端 `packages/gui/public/`、后端 `packages/gui/src/`（含 server.ts 全文件深检）、启动器 `boot.cjs` / `run-gui.bat` / `run-gui.sh`、文档与配置示例。
> 原则：遵循项目现有结构与命名风格，无破坏性重写；保留全部已交付功能（国策树/科技树/决议树/本地化缺失对比/音乐播放/IDE 查找替换/defines 对比/界面设计器等）。

---

## 一、主线 bug：贴图 id 不稳定 → /api/tex 404（科技/决议图标空白）

### 根因
`server.ts` 的 `texIdFor()` 用 `'t' + texIds.size` 按扫描顺序生成贴图内部 id，`/api/tech/graph`、`/api/decisions/graph` 响应内嵌这些 id 并被存进磁盘缓存（`temp/_cache_tech_graph.json`、`_cache_dec_graph_*.json`）。后端重启重建 `texTable` 后，旧缓存里的 `t0/t1/...` 序号 id 与新表失配 → `/api/tex?id=tXXX` 全部 404 → 科技树/决议树图标空白（Edge 实测大量 404）。

### 修复（`packages/gui/src/server.ts`）
| 改动 | 位置 | 说明 |
|---|---|---|
| 新增 `TEX_SCHEME = 'v2'` 与 `texHash()`（sha1 截断 12 位 hex） | ~1002–1015 | id = `'t' + sha1(归一化路径).hex.slice(0,12)`，与扫描顺序解耦，跨重启/跨缓存重建稳定 |
| 替换两处 `'t' + texIds.size` | texIdFor ~1023、resolveTexId ~1075 | first-wins 语义、键归一化（去前导斜杠 / `interface/` 前缀 / lowercase）完全不变 |
| `TEX_SCHEME` 掺入 graph 缓存签名 | _tgSig ~3339、_dgSig ~3851（`strSig([TEX_SCHEME, dirSig(...)])`） | 旧格式缓存自动失效，其他用户设备残留的旧缓存无需手工清理 |
| **磁盘缓存 hydrate 后回填 texTable**（新增 `collectTexEntries` / `restoreTexEntries`，缓存载荷增加 `tex` 映射字段） | ~1017–1042、tech load/save ~3368/3548、dec load/save ~3881/3979 | **关键补丁**：此前 hydrate 路径跳过序列化 → texTable 为空 → 热重启后内部 id 仍 404。现在缓存命中重启后，响应内每个内部 id 都能正常出图，且帧动画信息（sprite/noOfFrames/type）不丢 |

### 验证
- 冷启动（删缓存重建）：graph 内 556 个 texId **全部**匹配 `/^t[0-9a-f]{12}$/`，短序号 id 为 0；抽样 `/api/tex?id=` 全部 200（PNG 元数据正确）。
- 跨重启：run1/run2 有序 texId 列表 **556 条完全一致**（Compare-Object 0 差异）。
- 热重启（缓存 hydrate，修复前 404）：同一批 id 全部 200；帧动画条目 `frames=2`、sprite 名完整保留。
- 决策树：响应内嵌 2102 个内部 id 抽样 200；缓存含 294 个 tex 条目。
- 404 兜底：`/api/tex?id=GFX_definitely_not_exist` → 404 JSON，不崩溃。
- 残留缺口：无功能性遗留；`collectTexEntries` 按 `"tex"` 键正则提取，未来若 graph 新增其它内嵌内部 id 的字段需同步扩展（已注释说明）。

---

## 二、前端 `public/` 全面巡检

### 严重 bug（实际打不开页面）
| 文件 | 问题 | 修复 |
|---|---|---|
| `doctrines.js` / `aibehave.js` | `api(u)` 签名缺 `opt` 形参，函数体却 `fetch(u, opt)` → 首次调用即 `ReferenceError` → 学说页、AI 行为页加载遮罩**永久转圈打不开** | 签名补 `opt`，与其余四页对齐 |

### 错误兜底（防白屏/无限转圈）
| 文件 | 问题 | 修复 |
|---|---|---|
| `tech.js` / `focus.js` / `decisions.js` / `dlc.js` / `doctrines.js` / `aibehave.js` | 共用 `api()` 在轮询循环内裸 `await fetch()`+`json()` 无 try/catch：网络中断或后端 500 时异常上抛，而 `api()` 开头已无条件 `LoadGate.show()` → **遮罩永久悬挂** | fetch/json 外包 try/catch，失败收起遮罩与进度条、回传 `{ready:false, busy:false, error}` → 自动流入既有「失败提示 + 1.6 倍退避重试」分支，不改渲染语义 |

### 缓存与资源
- `tech.html`：脚本版本号 `?v=20261009f → ?v=20261010a`（tech.js 有改动，避免用户浏览器继续跑旧缓存；全站唯一带版本号的引用）。
- 资源巡检：43 个页面 × 48 个唯一 js/css/图片引用 **全部 200，404 清零**。
- 硬编码本机路径（`C:/Users/123`、`D:\杂项`、`.workbuddy` 等）：public/ 下**零命中**。

### 已验证的既有机制（未改动）
- Boot 白屏防护：shell.html iframe 池、nav.js shellSwitch、bootgate.js（`/api/status` 轮询 + 失败自动重试）、loadgate.js、progress.js（并发计数防进度条不收回）、open.js（`/api/load` 后 BootGate.show + 500ms 轮询 ready）均有兜底。
- 贴图加载器 `tex.js`：`fetchOne` 全程 catch → 失败写缓存 null → `markFail()` 占位，404/error 不会 pending 悬挂。

### 遗留缺口（如实说明）
- 无头浏览器限制：doctrines/aibehave 修复后的视觉渲染靠语法校验 + 代码复核 + 后端 200 推断，未在真实浏览器实测出图。
- `worldmap.js` 的 `api()` 仍无 catch（有 40 次退避轮询 + Progress.fail 提示，网络硬断只留进度条不白屏，风险低于已修六页，未改）。
- `loc.js` 的 `loadStats()` 初始调用无 `.catch`（本地工具页，未改）。

---

## 三、后端模块巡检（`gui/src` 除 server.ts）

| 文件 | 问题 | 修复 |
|---|---|---|
| `dds.ts` | 损坏/伪造 DDS 头声明天文尺寸（如 `w=0x7FFFFFFF`）→ `new Uint8Array(w*h*4)` 直接 OOM；TGA 像素数据不足静默填零；BMP 用有符号 `readInt32LE` 读宽、负宽度抛 RangeError | 新增 `MAX_PIXELS=64M` 与 `dimsError()` 统一拦截，三个解码器分配前校验；TGA 增加数据完整性检查 |
| `png.ts` | 损坏 PNG 的 IHDR 块不足 13 字节 → `readUInt32BE(4)` 抛 RangeError；原 `w>20000||h>20000` 只卡单维，20000×20000=4 亿像素仍会 OOM | IHDR 长度守卫 + 总像素量上限 64M |
| `sprites.ts` | **死代码 bug**：`texturePath()` 首行无条件 return 使 DLC 贴图目录 `texRoot` 分支永远不可达，DLC 贴图解析被静默跳过 | 改为优先在 `texRoot` 找文件，未命中回落 `gameRoot` |
| `locsrv.ts` | `ingestFile` 里 `parseLocYml` 无 try/catch，一个损坏 yml 抛异常会让整个本地化索引构建崩溃 | 包 try/catch，失败记入 `errorFiles` 并跳过该文件 |
| `cache.ts` | `loadCache` 只校验 v/sig，损坏缓存缺 `data` 字段时返回 undefined 给调用方 | 增加 `j.data === undefined → null` |
| `ai.ts` | `read_file` 工具 `existsSync + 两次 statSync` | 合并为单次 `statSync`（少一次系统调用） |
| `model.ts` / `edit.ts` / `docs.ts` | 精读未发现崩溃点（空树/0 尺寸/百分比/parent 环 depth>32 + seen、diff 超 60000 降级、`safeDocPath` 防目录穿越均已处理） | 未改动 |

- 端点抽查（5192）：`/api/loc/stats` 200（133 万条目/10 语言）；缺失 loc 键 → 200 结构化空；`/api/tex?id=<真实路径>` → 200 图像；`/api/tex?id=GFX_nonexistent` → 404 不崩溃；`/api/layout` 真实文件 200 / 非法参数 400；`/api/docs/*`、`/api/ai/config`（不泄露 key）、`/api/cache`、`/api/appicon`（BMP→PNG 端到端）全部正常；服务器日志无 Uncaught Exception。
- 兄弟包（engine/focus/parser 41 个 .ts）：语法全过，按要求未改代码。

---

## 四、可移植性审计与修复

### boot.cjs（核心修复）
| 位置 | 问题 | 修复 |
|---|---|---|
| `freePort()` | netstat 找 PID 后**无差别 `taskkill /f`** —— 在其他用户设备上会杀掉占用该端口的无关软件 | 重写：只收 LISTENING 行；每个 PID 先查命令行身份，**只杀含工具包标识的进程**（KIT_ROOT / `packages/gui/src/server.ts` / `boot.cjs`）；无关占用打印中文警告并提示 `PORT` 换端口；取命令行失败时保守按"无关进程"处理（宁可不杀不误杀） |
| `cmdlineOf(pid)` | — | Windows：`wmic`（缺失回退 PowerShell/CIM）；非 Windows：`/proc/<pid>/cmdline`（回退 `ps -o args=`）；零第三方依赖、失败静默 |
| **PORT 环境变量断链** | server.ts 只认 `--port` 参数、不读 PORT env —— 原版 freePort 清理的端口与服务实际监听端口可能不一致，文档承诺的"PORT=5199 换端口"失效 | boot.cjs spawn 时把 `PORT` env 翻译成 `--port <PORT>` 传给 server.ts |
| 可测试性 | main() 直接执行，无法 require 复用 | `module.exports` + `if (require.main === module) main()`；`freePort(port)` 可传参 |

### 启动器与文档
- `run-gui.sh`：补齐与 .bat 对等的多级 node 回退（`.workbuddy` 管理运行时 → 任意版本 → PATH → nvm → /usr/local/bin）。
- `README.md`：补 `PORT=5199`（换端口）、`HOI4_NO_REG=1`（跳过注册表探测）环境变量说明。
- `新手指南.md`：端口 FAQ 重写——"启动器只清理自己的残留、不动其他软件"，给出 `--port` 与 `PORT` 两种换端口方式。
- `docs/deploy.md`：删去本机专属示例路径（`D:\杂项\`），改为"中文文件夹路径原样可用"。
- `gui-settings.example.json`：字段与实际 `gui-settings.json` 一致（未改动，确认无差异）。

### 验证
- `node --check boot.cjs` 通过。
- freePort 隔离测试：无关进程（命令行无工具包标识）监听 5193 → **存活**（未被杀，打印警告）；命令行含 KIT_ROOT 的伪装进程监听 5194 → **被杀**。两例均 PASS。
- `detectGameDir`：无游戏目录时返回 null 不抛异常；真实环境命中默认路径。
- 全程未触碰 5173 用户实例；测试端口与临时文件均已清理。

### 硬编码路径审计分类
- **兜底探测候选（可接受，未改）**：boot.cjs 的 `C:/Program Files (x86)/Steam/...` 候选、run-gui.bat 的 `.workbuddy` 回退（均带存在性检查）、`server.ts` 的 `DEFAULT_GAME_DIR`（仅作无配置时兜底，引用点 ~533/674/5670 均只作候选/回显）。
- **已修**：`docs/deploy.md` 示例、PORT env 断链。
- **用户数据（禁改）**：`gui-settings.json`。
- **建议后续（不影响 GUI 启动链路）**：`packages/cli/src/*`、`tools/*`、`packages/*/test/*`、`setup_sources*.cjs`、`fix_*.cjs`、`_pub_bak_codemod` 内存在本机路径（开发 QA 脚本，建议改 env/argv 驱动）。

---

## 五、server.ts 全文件深检与性能（6767 → ~7020 行）

### 端口可移植性
| 改动 | 说明 |
|---|---|
| `let PORT = 5173` → 读 `process.env.PORT`（合法数字才用） | `--port` 仍优先；未传时回退 PORT env；npm 脚本直跑也能换端口。实测 `PORT=5196` 无 `--port` 启动 → 监听 5196 |
| `server.on('error')` 捕获 `EADDRINUSE` | 打印中文提示「端口 N 被占用。可用 --port <端口> 或环境变量 PORT=<端口> 换端口后重试。」并 `process.exit(1)`，无栈崩溃。实测第三实例同端口 → 退出码 1、仅中文提示 |

### 异常兜底（稳定性核心）
| 改动 | 说明 |
|---|---|
| 全局 catch 加固（headersSent 感知） | catch 内先完整记栈（仅服务端日志）；`res.headersSent` 时只 `res.end()` 收尾（避免 ERR_HTTP_HEADERS_SENT 二次崩溃）；否则返回结构化 JSON `{error:'服务器内部错误,详见控制台日志'}`，不泄露内部错误 |
| `process.on('uncaughtException'/'unhandledRejection')` | 只记日志、不让进程退出（本地工具取舍：单请求出错不搞挂整个工作台） |
| 3 处异步 `req.on('end')` 回调补 try/catch | 外层同步 try/catch 覆盖不到异步回调：`POST /api/check/target`（setCheckTarget）、`POST /api/focus/save`/`preview`（planFocusMove/commitPatch）、`POST /api/worldmap/dlc`（buildWorldMap）；其余 20 处本已有守卫 |
| `/api/music/audio` 两条 `createReadStream().pipe(res)` | 补流 `error` 监听（文件被删等场景不再进程崩）+ `res.on('close')` 销毁流 |

异常注入实测：`/api/layout`、`/api/loc/file`、`/api/tree`、`/api/outline`、`/api/file` 非法参数，以及 `POST /api/fs/write`、`/focus/save`、`/worldmap/dlc`、`/gui/edit`、`/save`、`/rename`、`/loc/save` 非法 JSON → **全部结构化 JSON（400/404/500），无挂死、无进程崩**，事后 `/api/status` 正常，日志无 uncaught/unhandled。

### 性能（不改语义）
| 改动 | 说明 |
|---|---|
| `graphCacheSend` gzip 正确性 | 新增 `gzIsReal = c.gz !== c.raw`：仅当真 gzip 时才标 `Content-Encoding: gzip`，否则按原文下发（修复"压缩率不足时把原始 JSON 标成 gzip"的潜在 bug） |
| miss 路径消除重复 gzip | `graphCacheSet` 后直接 `graphCacheSend` 复用缓存里的 gz，不再对同一原始 JSON 二次 `gzipSync`（冷建一次省一次 715KB/3.4MB 压缩） |

实测（curl）：
| 端点 | 无 gzip | 带 gzip | 压缩比 |
|---|---|---|---|
| `/api/tech/graph` | 715,244 B | 48,953 B | ~14.6× |
| `/api/decisions/graph` | 3,413,178 B | 133,180 B | ~25.6× |

- 非 gzip 客户端不标 Content-Encoding；gzip 体解压后 JSON 首尾完整；连续请求命中 RESP_CACHE（体积一致，无重建日志）。
- 其余大端点（links/refs、loc/file、music、worldmap/img、events/list）巡检后未发现可安全再缓存的冗余计算（worldmap/img 已内存缓存并直发 PNG、music 索引已缓存、loc 按索引即时组装），未强行加缓存。

### 其他核查
- `DEFAULT_GAME_DIR`：仅兜底候选（见上），按要求未改、已注明。
- VS Code 探测路径用 `process.env.ProgramFiles` 带 fallback，可移植。
- `--open` 参数：parseArgs 置 `AUTO_OPEN`，listen 回调等构建结束后 `openBrowserInDefault(http://127.0.0.1:PORT/)`，逻辑完整，行为与现有一致。
- 贴图 id 区域（texIdFor/resolveTexId/texHash/TEX_SCHEME/collectTexEntries/restoreTexEntries 及 tech/dec 缓存存取、/api/tex 404 兜底）：按要求未动，深检未发现新 bug（`/api/tex?id=t8994d29b0ced` 实测正常）。

---

## 六、集成验证（5173 重启 + 全链路冒烟）

### 链接图【重建】路径专项验证（此前唯一未被完整跑通的路径）
- 操作：备份并移除 `temp/_cache_links.json` 强制缓存 miss → `--port 5173` 启动 → 触发 `/api/links/refs`。
- 结果：`引用图就绪: 25458 定义 / 176 引用 / 0 悬空,12765 ms(已写缓存)` —— 全量重建 12.7s **成功、无崩溃**，新缓存落盘，`.bak` 过期缓存已清理。
- 判定：此前一次冒烟中"链接图重建中途进程消失"经核实为**工具会话进程树回收**所致，非代码崩溃；本次在独立会话内完整跑通重建 + 落盘 + 查询（`/api/links/refs` 200、err 日志 0 字节）。

### 5173 全链路冒烟（同一实例，agent 会话内执行）
| 类别 | 结果 |
|---|---|
| 静态页（/、tech、focus、decisions、doctrines、aibehave、dlc、worldmap、designer、ide、settings、open、home 共 13 页） | 全部 200 |
| 核心 API（status/config/sources/loc/stats/music/cache/focus/graph/tech/graph/decisions/graph/doctrines/graph/dlc/content/aibehave/graph/defines/docs/list/events/list/links/refs 共 18 个） | 全部 200 |
| 贴图链路（5 个内部 hash id：t8994d29b0ced 等） | 逐个 200 |
| `/api/tex?id=GFX_definitely_not_exist` | 404 + JSON，不崩溃 |
| gzip `/api/tech/graph` | 715,244 B → 48,953 B（Content-Encoding: gzip） |
| gzip `/api/decisions/graph` | 3,413,178 B → 133,180 B（Content-Encoding: gzip） |

### 最终状态（复核于 15:0x）
- **PID 17472 运行中，5173 监听确认**，`/api/status` 200，`srv_err.log` 0 字节。
- 该实例作为用户可用的工作台实例**保留运行**。

---

## 七、验证方式与覆盖汇总

| 验证手段 | 覆盖 |
|---|---|
| `node --check` / `node --experimental-strip-types --check` | 全部改动的 js/ts（前端 56 个 js、gui/src 全部 ts、server.ts、boot.cjs、兄弟包 41 个 ts） |
| 独立端口实例联调（5190/5191/5192/5195/5196） | 各 agent 改动后的启动、端点抽查、异常注入、gzip、PORT env、EADDRINUSE |
| 跨重启稳定性 | 贴图 id 556 条有序列表两次启动完全一致 |
| 资源巡检 | 43 页面 × 48 唯一资源全部 200、404 清零 |
| 集成冒烟（5173） | 见第六节 |

## 八、遗留缺口汇总（如实说明）

1. **真实浏览器渲染**未实测（无头限制）：doctrines/aibehave 修复后视觉出图、各页交互仅靠语法+代码复核+后端 200 推断。
2. `run-gui.sh` 本机无 bash，仅静态复核，建议在 macOS/Linux 实机跑一次。
3. `wmic` 在 Win11 逐步弃用：boot.cjs 已内置 PowerShell/CIM 回退；`pidIsOurs` 取命令行失败一律按"无关进程"处理（不会误杀）。
4. `worldmap.js` / `loc.js` 两处 api() 无 catch（有退避重试与失败提示兜底，风险已评估为可接受，未改）。
5. `packages/cli/src/*`、`tools/*`、`packages/*/test/*`、`setup_sources*.cjs`、`fix_*.cjs`、`_pub_bak_codemod` 中的本机路径未修（不影响 GUI 启动链路，建议后续改 env/argv 驱动）。
6. 全进程级异常策略为"记日志不退出"（本地开发工具取舍），若生产化建议改为重启策略。
