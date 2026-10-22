# Changelog

### 0.5.0 — GitHub Releases 自动更新 + 设置页项目主页

- **自动更新源切换为 GitHub Releases（AUTOUPDATE_V2）**：打包产物注入 `resources/app-update.yml`
  （`provider: github`, owner/repo=`rzcxbsxxjxxy/hoi4-toolkit`）。`electron-builder --dir` 不生成该文件，
  不注入则已安装程序缺失更新源、`configuredUpdateUrl()` 返回空、启动后台检测与设置页「软件更新」全部失效——此版补齐。
- **启动后台检测更新**：`setupUpdater()` 在 `app.ready` 后若检测到有效更新源即调用
  `autoUpdater.checkForUpdates()`（非阻塞、默认不自动下载），新版本出现时设置页卡片收到 `update:state` 事件。
- **设置页新增「项目主页」**：软件更新卡片内增加 GitHub 仓库链接，Electron 经主进程
  `app:open-external` → `shell.openExternal` 在系统浏览器打开，浏览器环境退回 `window.open`。
- **界面设计器 / GUI 布局对齐游戏（DESIGNER_V1）**：容器多 `background` 块按「拉伸撑满容器」渲染
  （证据：82×82 九宫格贴图用于 640×84 窗口）；`instantTextBoxType` 高度 0、`spriteType=""` 占位不再误判；
  `spriteIdx.candidateFn` 注入修复模组重定义贴图缺失时的天然尺寸回退。以基础游戏 `GER_inner_circle` 为验收，
  顾问框架 / 名称缎带 / 特质条 / 聚光灯层 / 7 头像完整嵌合。

### 0.4.0 — Electron 桌面壳：NSIS 安装包 + 自动更新 + 自定义桌面图标

- **三目录布局 + 纯 Electron（LAYOUT_V3）**：项目移至 `D:\杂项\hoi4\toolkit-electron\`（自包含完整
  Electron 工程，**移除全部浏览器模式内容** `run-gui.*`/`boot.cjs`）；NSIS 安装包输出到
  `D:\杂项\hoi4\toolkit-installer\`（`build.directories.output=../toolkit-installer`）；
  免安装程序 `npm run pack` 输出到 `toolkit-electron\app\`（= 安装后内容，`HOI4 工具链.exe`）。
  打包入口 `build-installer.bat/.sh` 在上一级 `D:\杂项\hoi4\`。
- **配置统一到 AppData（SHARED_SETTINGS_V3）**：所有形态（开发态/打包态/免安装）统一读写固定的
  `%APPDATA%\hoi4-toolkit\gui-settings.json`，exe 挪到任意位置也指向同一份，配置永不分裂。
- **跨平台打包修复**：`stage.mjs`/`clean.mjs` 改用 Node 内置 fs 手动递归（原先 shell `rm -rf`/`cp -r`
  在 Windows cmd.exe 不存在会失败）。
- **批处理编码修复**：所有 `.bat` 改为纯 ASCII（cmd 默认 OEM 码读 UTF-8 中文会乱码并被误解析成命令）。

- **NSIS 安装包（PACKAGING_V1）**：根 `package.json`（electron 壳已提升为 toolkit 根）的 `win.target`
  由 `dir` 改为 `nsis`，新增 `nsis` 块（非一键安装、允许自选目录、桌面/开始菜单快捷方式）；
  `scripts` 增加 `dist` / `release`（`electron-builder --win nsis`）。
- **自动更新（AUTOUPDATE_V1）**：声明 `electron-updater` 依赖，主进程 `setupUpdater()`
  在打包态拉取更新（先确认再下载，下载完成后二次确认重启安装）；更新源可用环境变量
  `HOI4TK_UPDATE_URL` 覆盖（指向托管 `latest.yml` + 安装包的目录），未设置时回退到
  `build.publish` 占位 URL。
- **自定义桌面图标（APP_ICON_V1）**：`gui-settings.json` 新增 `icon` 字段（data URL，
  设置页缩放到 256px）；后端 `GET/POST /api/settings` 与 `/api/load` 保留该字段；
  设置页「外观 → 桌面程序图标」可上传/清除；主进程启动后拉取并 `win.setIcon`，
  设置页选图经 `electronAPI.setAppIcon` 实时套用到窗口/任务栏。
- **安装包纯净（PURE_PACKAGE_V1）**：`build.files` 明确不含真实 `gui-settings.json`；
  `stage.mjs`/`clean.mjs` 只暂存示例模板；`gui-settings.example.json` 已清空为纯净模板
  （`base:""`、`mods:[]`），分发安装包不含任何用户真实路径/模组/AI key。
- **安装包图标**：`build/icon.ico` 新增（国策树风格徽标），用作 EXE / 安装向导图标。
- **项目提升为根目录（ROOT_PROMOTE_V1）**：electron 壳从 `packages/gui/electron/` 整体迁移到
  toolkit 根目录，后续开发以此根为准。`package.json` 合并 electron 的 `main`/`build`/`dependencies`
  (electron-updater)/`devDependencies`(electron, electron-builder, esbuild)/scripts
  (`start`/`build:server`/`stage`/`clean`/`pack`/`dist`/`release`)，并保留 toolkit 原有
  `type:module`/`workspaces`/工具脚本；`main.cjs` 的 `KIT_ROOT` 改为 `__dirname`（开发态与打包态均在根），
  `preload.js` 改名 `preload.cjs` 以适配根 `type:module`；`stage.mjs` 仅把 `packages/gui/public`
  暂存为根 `./public`，`clean.mjs` 仅删该暂存；新增 `build-installer.bat`/`build-installer.sh`
  一键输出安装包（内部即 `npm run dist`）。

### 0.3.0 — 更新追踪重构：零碎小文件 → 按来源大文件 + 三处提速

- **存储重写（TRACKER_PACK_V1）**：原来每个被追踪的文本文件都存成一个独立小文件
  (`tracker/blobs/<sha256>`)，几千上万个零碎文件既吃 inode、又在 NTFS 上因簇对齐
  虚高占用大量磁盘。现改为**按来源（基础游戏 / 每个模组）合并成大文件**：
  - `baseline/<key>/content.pack`：二进制大文件，内部为重复的
    `[4 字节小端长度][gzip(内容)]` 拼接，内容寻址、来源内自动去重；
  - `baseline/<key>/content.idx`：小 JSON 索引，`sha256 → [offset, compressedLength]`，
    随机读取靠它定位。每个来源最多 2 个文件。
  - **旧 `blobs/` 自动迁移**：「建立基线」时检测到旧目录会整体删除，不会残留。
  - 增量复用仍保留：size+mtime 未变的文件跳过重新哈希，只对新文件写入 pack。
- **「建立基线 / 检查更新」提速（TRACKER_PARALLEL_HASH）**：`scanSnapshot` 改为
  **24 路并行哈希** worker 池（旧版近似串行）；同时保留增量复用与 SSE 进度 / yield 点，
  大目录扫描明显更快。
- **「打开更新列表」提速（TRACKER_HISTORY_SUMMARY）**：列表不再逐个解析每个历史 JSON
  （里面嵌着整段逐行 diff），改为读一份轻量 `history/<key>/index.json` 摘要
  （`fileName / checkedAt / baselineAt / stats`）；选中某条记录时才**按需懒加载**完整条目
  （`/api/tracker/historyEntry?root=&ts=`）。常用场景下 `toggleDiff` 直接用已加载的
  `curEntry`，**零网络往返**。
- **来源隔离不变**：每来源独立 `baseline/<key>/`，「清除」只清单来源；GC 改为按来源的
  `compactStore`（重写 pack 只保留存活 sha，设阈值避免每次日常检查都重写整个 pack）。
- **验证**：`tools/tracker_perroot_test.ts` 回归 **21/21 全部通过**（旧 blobs 已消失、
  pack+idx 按来源独立、history/index.json 摘要、A/B 来源互不影响、clearRoot 只清单来源）；
  真机 HTTP 冒烟：`/status` 多来源含基线、`/history` 走摘要、`/historyEntry` 缺失 404、
  `/diff` 无基线优雅 200。

### 0.3.1 — 补充合入：多核构建、units/characters 新页面、校验增强、UI 修复

- **性能 · 多核构建队列（BUILD_PARALLEL_V1）**：新增 `worker-pool.ts` / `job-builders.ts` /
  `cpu-probe.ts`，索引重建按 CPU 核心数并行分片（实测多核收益），冷/热启动更快；`boot.cjs`
  与之配套（`+154` 行）。含验证脚本 `tools/verify_worker_pool.ts` / `verify_settings_perf.ts` /
  `verify_ide_ctx.cjs`。
- **新页面 · 装备（units）**：`units.ts` 解析陆/海/空装备数据（加/乘法属性分离），配套
  `units.html` / `units.js`。
- **新页面 · 角色/将领（characters）**：`characters.ts` + `characters.html` / `characters.js`。
- **地图增强（worldmap）**：`worldmap.js` 扩充（`+123`）、`worldmap.html` 调整；新增 `mapcheck.ts`
  地图校验、`aiwiki.ts` AI 维基抽取。
- **校验增强**：`validate.ts`（`+235`）扩展规则；`modmeta.ts` / `ownership.ts` / `mio.ts` /
  `decisions.ts` / `events.ts` / `aibehave.ts` / `tech.ts` / `gen.ts` / `fieldstats.ts` /
  `assetsrc.ts` 同步改进；新增 `docs/fix-report-2026-10-10.md` 修复报告。
- **UI 修复/改进**：designer / ide / dlc / check / modrel / nav / settings / shell / home / open /
  locclient / focus / doctrines / events / tech / aibehave 等多页修正；`run-gui.sh` / `README.md` /
  `docs/deploy.md` 更新。
- **配套**：`.gitignore` 追加忽略运行时 `tracker/` 目录。

### 0.2.27 — 修复:「保存并进入工作台」白屏 + 移除「新建模组」

- **白屏根因**:`open.js` 保存完成后无条件 `location.href = '/'` —— 而 `/` 返回的
  是**外壳页 `shell.html`**,本页自己又跑在壳的 iframe 里 → iframe 内再套一层 shell,
  而壳内 shell 会因 `window !== top` 隐藏导航 → 用户看到的就是「只剩最上面一条
  导航栏的白色画面」,刷新也回不去。
  修复:壳内改为让父壳把 iframe 切到工作台首页(`shellSwitch('/home', ...)`),
  独立页(非 iframe)才整页跳 `/`。
- **加载画面不出现**:`bootgate.js` 原来只看 `frameReady()` 就收遮罩 —— 而 open.html
  保存时自己早已 `complete`,于是「正在重建索引…」刚显示就被收掉。
  修复:收遮罩改为**两个条件同时满足**(后端 `ready` **且** 当前帧 `complete`),
  `frameReady()` 取不到时(跨域/无帧)只信后端。
- **切页遮罩死锁**:新增 sticky 模式(等"切换后的新一帧"加载完才收),用于
  「保存 → 切到工作台」这种后端已 ready 但页面还在加载的场景。
  ⚠ **挂载顺序必须是先 `show(sticky)` 再 `shellSwitch`** —— 反过来会把新帧记成
  基准帧,`cur !== stickyFrame` 永不成立 → 只能等 20s 超时兜底(实测遮罩白挡 20 秒)。
  另附 20s 超时安全网,避免帧永远不 complete 时遮罩永久挡住平台。
- **移除「新建模组」**:按用户要求从「打开工程」页摘掉整个 `details.nm` 区块与
  `open.js` 的 MAKE_MOD_V1 绑定(本页只负责打开/挂载已有工程)。后端 `/api/mod/new`
  保留未动。
- 验收 `tools/verify_gotoworkbench.cjs`(无头 Edge + CDP):走 壳 → 打开工程 →
  点保存并进入工作台,判据全绿 —— 跳到 `/home`(非 `/`)、遮罩已收、页面 262 个
  可见节点(非白屏)、iframe 池 4 个无嵌套 shell。

### 0.2.26 — 科技树:隐藏科技页签 + 研究完成效果展示

- 隐藏科技(无 `folder.position`,文件没写坐标的科技)从主网格抽出,放进单独的
  「隐藏 N」页签,以**左侧条目形式**查看(属性 + 效果摘要),画布显示空态提示。
  主视图不再对无 position 科技做 autoLayout 补位,网格只显示 415 个有坐标的科技。
  识别用后端已下发的 `posDeclared === false`(≠ `hidden`,后者是「无 categories」)。
  点击任意常规页签(页签/领域/科技树/全部)会自动退出隐藏视图;隐藏提示层
  `pointer-events:none` 不拦截操作。
- 每个科技展示**属性和效果**:引擎 `tech.ts` 新增 `TechNode.effects?` 字段
  (TECHEFFECT_V1),解析研究完成效果 —— `modifiers` / `research_bonus` /
  `equipment_bonus`(blockText 原文)、`research_speed_bonus` / `start_research_skill` /
  `start_xp`(数值)、`instant`(布尔),以及 vanilla 最常见的
  `on_research_complete`(原文,实测 106 条)与 XP 加成
  (`xp_research_type` / `xp_boost_cost` / `xp_research_bonus`)和
  `path.research_speed` 块。`/api/tech/graph` 下发 `effects`。检查器新增「效果」区块
  (<pre> 展示复杂块原文),隐藏页条目显示效果摘要。
- 实测(vanilla + test_new_beta):564 科技中 149 无 position → 隐藏页签;
  effects 118 条(on_research_complete 106)。后端改动重启生效,前端静态改动新开 tab 生效。

### 0.2.25 — 修复 defines 模组 lua 文件读取失败

- 根因:`rebuildIndexes()`(挂载/更换模组后全量重建)与 `softInvalidate()`(写盘后软失效)
  重置全部索引缓存(LINK/SYM/FG/TG/DG/AB/DM/DGR/MT/LOC/EV…)时**唯独漏了 defines 的
  `DF` 缓存** —— `ensureDefines()` 的 `if (DF) return DF` 因此永不失效。服务器一旦
  在旧来源下构建过 defines,之后再挂载/更换模组 ROOTS 变化,`/api/defines` 仍返回
  旧数据,模组的 defines lua 文件完全读不到,「原版 vs 模组」差异面板恒为空。
- 修复:在 `rebuildIndexes()` 与 `softInvalidate()` 两处补齐
  `DF = null; DF_ERR = ''; DF_BUSY = false`,来源变化 / 写盘后 defines 缓存正确失效并重建。
- 实测(重启后挂 vanilla + 可写模组 test_new_beta):diff 面板渲染 155 条模组改动
  (112 真改动 · 升 69 / 降 42 · 39 同值重写 · 4 新增),首条
  `NAI.REGION_THREAT_LEVEL_TO_BLOCK_REGION base=25*100 → mod=25*5000`;
  主表 39 组 / 4000 条(总 4669 = vanilla 4506 + 模组新增)。后端改动,重启生效;
  前端静态文件改动新开 tab 生效。
- 修复多行键值:`parseDefines` 此前只处理单行值,`KEY = { ... }` 跨多行的数组/表
  只取到一个孤零零的 `{`(如 `NFactions.FACTION_INTELLIGENCE_ALLOWED_ADVISOR_TRAIT`,
  实测解析成 value="{"、array=[])。新增 `valueOpen` + `collectValue`:值以 `{` 开头
  未闭合时跨行拼接到花括号配平,块形态(`KEY = {`)与点形态(`NDefines.NGroup.KEY = {`)
  都生效。
- 实测:模组该键解析出 16 个元素(KR_head_of_intelligence…),vanilla 解析出 32 个,
  该键进入 diff(override);单行值、多行内联表、块内普通数字均无回归。引擎改动,重启生效。

### 0.2.24 — IDE 大纲去繁琐 + 查找/替换(VSCode 对齐)
- 大纲(OUTLINE_V2):默认只显示「结构节点 + 标识字段(name/id/key/sprite…)」,隐藏
  x/y/width/height/font 等纯字段叶子 —— 否则 gui 文件每个字段都平铺成大树(实测
  countrytechtreeview.gui 滚动高 80041px→730px,行数 4000→1554)。每行右侧新增
  行号(VSCode 风格);深层子块默认折叠;工具栏「字段」开关可临时显示全部字段。
- 查找(FIND_V2):统一文本源(编辑模式取 textarea,可替换;只读视图取当前文件文本),
  支持 区分大小写 / 全字 / 正则 三选项;输入实时统计,Enter/Shift+Enter 下一个/上一个,
  Esc 关闭;修复查找基于已失效的 state.lines(改为 curTab().content)。
- 替换:Ctrl+H 打开替换行;替换当前 / 全部替换;可写文件自动进入编辑模式,只读来源
  明确提示「只读来源,不能替换」。实测:fsReplaceAllText 字符串替换、全字选项只替换整词、
  Ctrl+H 展开替换行均通过。
- 快捷键:keymap.js 新增 ide.replace(mod+h);registerShortcuts 登记;编辑框内
  Ctrl+F/Ctrl+H 生效(onKey 白名单放开)。
- 语法校验通过;前端静态文件改动,新开页面即生效(浏览器强缓存需新开 tab 才加载新脚本)。

 — LOC_LANGUAGES_CONFIG · localisation/languages.yml 视为配置文本
- 修复:`locFiles` 原先把 `localisation/` 下所有 `.yml` 当翻译文本收集,
  `localisation/languages.yml`(声明支持的语言与显示名,如 `l_english: l_english: "English"`)
  也被解析成各语言下的配置假条目,污染翻译索引与缺失计算。
- 修复:`locsrv.ts` 扫描时跳过 basename 为 `languages.yml` 的文件 —— 它是配置文本,非翻译。
- 实测(服务重启后重建索引):文件列表无 `languages.yml`;搜索 `l_english:0 "English"` 等
  配置条目为 0;语言列表仍为 10 门真实翻译语言;`unknown` 桶仅 1 个空文件(0 条目)。
- 后端改动,重启生效(新 PID 39304)。

 — LOC_EXPORT_YAML · 本地化「缺译文」导出游戏格式 yaml
- 新增:本地化页工具栏「导出缺译文 yml」按钮(`loc.js exportYaml/buildAndDownload`)。
- 行为:按当前筛选(搜索 / 来源 / 文件)分页拉取全部缺失译文(以 l_english 为参照、
  含参照列),按目标语言分组,输出游戏本地化格式 yaml:
  `l_xxx:  key:0 "译文"` —— 值为**英文参照原文**,供据此翻译为各语言;内嵌引号按
  游戏规范转义为 `""`;文件 `hoi4_loc_missing_<日期>.yml`。
- 实测:切「缺译文」→ 导出 → 下载 43KB yaml,`l_simp_chinese:` 段 408 条缺失 key
  均带英文原文;语法校验通过(修复一次 `\n` 在插入中被写成真实换行导致的语法错)。
- 改前端静态文件,刷新即生效。

 — TECH_INSP_COMMENT · 修科技树检查器底部异常文本
- 修复:科技树检查器(`tech.js` showInsp 的 innerHTML 模板字符串)里嵌了一段
  `/* TECHGRAPH_V1:… */` 代码注释 —— 反引号模板内 `/* */` 不当作注释,被当作
  文本原样渲染到检查器底部(如 tank_landing_craft 的「前置」下方)。删除该注释块。
- 实测(bu):选中节点检查器底部干净 ——「前置 → 悬空边 0 · 无悬空边✓」,异常文本消失。
- 改前端静态文件,刷新即生效;语法校验通过。

 — EVENTS_LOC · 事件制作 → 事件查看(语言可切换 + 文本/图片完整展示)
- **重命名**:页面标题与 h1「事件制作」→「事件查看」。
- **语言条**:顶部新增语言下拉(从 loc 索引取全部语言),默认英文、可切换并持久化(localStorage `evtLang`)。
- **修俄语 bug**:`events.js` 的 `locOf` 原先用 `byLang.english` 取译文,但服务端 `/api/loc/key`
  的键带 `l_` 前缀(`l_english`…)→ 恒取不到 → 回退 `langs[0]`(俄语)。改为按
  选中语言 → `l_english` → 任一门已有译文回退。
- **文本完整展示**:事件标题 / 描述 / 选项名按所选语言显示译文 + 原 key;
  列表每行标题改用 `/api/loc/text` **POST**(GET 拼长 key 列表触发 431)批量翻译。
- **图片**:详情「图片」行按 GFX 名经 `/api/tex` 解析游戏贴图,成功则渲染成 PNG。
- 实测(bu):默认 `l_english`;切简体中文后列表/标题/描述/选项均显示中文;AAT_britain_narvik.1
  配图渲染为人物肖像;标题「[SWE.GetAdjective]矿场遭到炸毁」+ 描述全文 + key 并列展示。

 — AIBEHAVE_DETAIL · AI 行为条目显示更全面(脚本块完整原文)
- **后端(RAWS_V1)**:`aibehave.ts` 每条目新增 `raws` —— 顶层脚本块的**完整原文**(逐块,
  重复块各占一条,如多次 `ai_strategy = {…}`)。`entryText` 按 token 区间无损切片,含 `key =`
  与整块。服务端 `...e` 已透传。
- **前端**:条目检查器新增「脚本块详情 · 完整原文」区,把 `allowed / enable / abort / ai_strategy`
  等块分组渲染为可滚动 `<pre>`(重复块分别列出,不裁剪)。配 `.kv.blk` / `pre.raw` 样式。
- 实测:选中 `ai_strategy` 方面条目 `ARG_avoid_china` → 子块构成 `abort×1 ai_strategy×1
  allowed×1 enable×1`,脚本块详情逐块显示 `allowed = { original_tag = CHI has_dlc = … }`、
  `enable = { … }` 等完整内容。服务重启生效(PID 37644);bu 截图验证。

 — DECISIONFIX · 决议类控制块不作为决议 + 显示决议类属性
- **解析器(CATCONTROL_V1)**:决议类块内的控制键(`allow / visible / available / target_trigger /
  ai_will_do / priority / picture / cost / days_remove / is_alert / id / icon / default / decision /
  remove_effect / complete_effect / hidden_effect / modifier / …`)是「决议类是否出现」的条件,
  **不是决议**。旧版把 `visible`/`priority`/`available`/`picture` 等块误当成决议(实测 471 个假决议:
  visible×436 / priority×22 / available×12 / picture×1)。现单独捕获为分类属性,不再进入决议列表。
  - 实测:假决议清零;唯一决议数 4177→4173;分类下决议数随之修正(_debug_decisions 93→92)。
- **捕获并展示决议类属性**:分类接口新增 `allowRaw/visibleRaw/availableRaw/targetTriggerRaw/
  aiWillDoRaw/priority/picture/cost/daysRemove/isAlert`;服务端下发。
- **前端展示**:
  - 左侧决议类条目:带出现条件时加 `▨N` 标记(438/598 分类),tooltip 列出条件名与行数。
  - 选中决议类:顶部属性条(priority/cost/days_remove + 出现条件按钮),点击条件按钮 → 检查器
    显示该块原文。
- 附:前端曾因辅助函数 `catCondList` 未随中断脚本写盘而 ReferenceError、树渲染中断 —— 补定义后
  恢复。服务重启生效(PID 8496);bu 验证 condc 438、catMeta 条件按钮、检查器原文均正常。

 — DECISIONTREE · 决议树三级重构：文件 → 决议类 → 决议
- **后端(DECFILE_V1)**:`/api/decisions/graph` 的每个分类新增 `file / root / rootName`(取
  `catDefs` 链末位 = 该分类【生效定义所在文件】)。决议本就自带各自 `file` —— 二者可不同,
  前端据此独立标注。
- **前端三级树**:左侧栏由「扁平分类列表」重做为**可展开文件树**:
  - 第一级  文件(common/decisions/** 下的 .txt,主要 categories/,递归含 _generic_decisions.txt 等)
  - 第二级  决议类(文件内定义的 category 块,带归属徽标与决议计数)
  - 第三级  决议(卡片墙,分批懒加载)
  - 点分类 → 主区显示其决议,顶部面包屑 `文件 › 决议类`;点文件可展开/收起。
- **决议各自文件标注**:选中决议类后,凡决议自己的 file ≠ 该分类的 file,卡片上加蓝色
  `文件名` 徽标(title 亦标出) —— 满足「决议归属文件可能与决议类不同」的口径。
  实测 `debug_decisions` 分类(_debug_decisions.txt)下 93 条决议中 57 条来自其他文件
  (卡片标 `CZE.txt` 等),三级归属正确。
- 检查器新增「定义文件 / 分类文件」两行;右键支持复制文件路径 / 只看该文件。
- 服务端重启生效(PID 33948);bu 验证 81 文件 / 598 决议类 / 4177 决议,交互与徽标均正常。

 — FOCUSFIX2 · 国策树：游戏规则默认值 + 误隐藏修复
- **① 游戏规则默认值(GAMERULE_DEFAULT_V1)**:国策被 `allow_branch = has_game_rule ... ` 门控时,
  旧版把「未勾选的游戏规则」一律判 false → 该国策被误隐藏。现服务端解析
  common/game_rules/*.txt 的 `default` 块下发 `gameRules` 默认表;前端 has_game_rule 按
  「规则当前选项(=默认)」求值,面板可勾选覆盖。
  - 例:模组 `obsolete_focus_branches_visibility` 默认 HIDE → `has_game_rule ... HIDE` 默认判 true,
    `china_nationalist_sea_focus` 的 CHI_end_military_primacy / CHI_strengthening_our_resolve 得以显示。
  - 附:解析正则须带 \b 词边界,否则 `has_game_rule = {` 里的 rule 被误命中。
- **② 前置传播排除 branch 门控边**:buildVis 的 pred 原把 branch 边当前置传播,
  但 branch 边方向是「被门控方→门控国策」(与 to 依赖 from 相反),导致
  「门控方隐藏 → 连带被门控方隐藏」误判(如 CHI_form_saco→CHI_end_military_primacy 把后者连带隐藏)。
  现只把 prereq / or 当真前置;allow_branch 门控已由 nodeVisState 求值,传递门控由前置链传播覆盖。
  - 实测:china_nationalist_sea_focus 两目标国策现显示;依赖它们的 CHI_form_saco 仍正确隐藏;
    usa_focus 互斥隐藏回归通过。

### 0.2.15 — FOCUSFIX · 国策树：互斥/矛盾分支隐藏 + 条件偏移带子国跟随
- **① 互斥(矛盾)分支隐藏**:实测互斥关系全在 `S.edges`(kind='mutex',direction from>to),
  而节点 `n.mutex` 常为空。据此在 `buildVis` 里从互斥边建**对称「互斥伙伴」表** `mutexOf`:
  当模拟勾选完成某国策(scope 存 `has_completed_focus = <id>`)后,与之互斥的另一方及其
  **整条下游矛盾分支隐藏**;未勾任何互斥方时互斥不隐藏(不破坏默认全览)。与 allow_branch
  门控叠加,实现「不止互斥、未满足条件的分支也一并隐藏」。
  - 实测:usa_focus 模拟完成 `USA_carrier_primacy` → `USA_battleship_primacy` 及其下游
    `modern_battleship` 隐藏;撤销后恢复。
- **② 条件偏移沿相对链累计(子国跟随父国)**:`coordOf` 改为沿 `n.rel` 相对定位链向上累计
  命中条件的 offset 增量——父国策因条件偏移位移时,下方相对定位的子国策**跟随同移,连线不断**。
  `n.x` 已是解析后的绝对坐标(含祖先基准),故只累加链上各节点的 offset 增量。
  - 调试开关「应用 offset 偏移」(useOffset) 保持原语义(无条件首条 offset、不级联),
    避免整链首 offset 累加造成的极端位移。
  - 实测:mu_czech_focus 触发 `CZE_coalition_building` 的条件 offset(-12) 后,
    其相对子国 `CZE_revive_the_czechoslovak_legion_dynamic` 由 75→63 格(4950→4158px)精确跟随。

### 0.2.14 — LOCFIX3 · 修复「缺译文」翻页不加载(竞态)
- **症状**:在「缺译文」(status=missing)状态下点「下一页」偶发内容不变/不加载。
- **根因**:翻页/换筛会并发多个 /api/loc/search 请求,旧请求(慢)晚于新请求返回,
  把 S.rows 覆盖回旧分页内容(页面看似没翻)。缺译文筛选结果少(408 条)时更易触发。
- **修复**:loc.js 给 search()/openFile() 加请求序号守卫 `S.seq`——每次请求取 `++S.seq`,
  响应回调若 `seq !== S.seq` 则丢弃(过期响应),只应用最新一次。node --check 通过。
- **实测**:缺译文状态连点 3 次「下一页」稳定落在第 3/3 页,内容为首行 l_french、8 条
  (与后端 offset=400 一致),不再回退到旧页。

### 0.2.13 — LOCFIX2 · 文件树可滚动
- **修复「按文件浏览」侧栏(#ftree)不能滚动**:flex 容器子项默认 `min-height:auto`,会被
  内容高度撑开(等于内容高度 → overflow 无处可滚),加 `min-height:0` 后高度受 #wrap 约束,
  overflow-y:auto 正常滚动。实测:树全展开后 scrollHeight=4932 > clientHeight=641,可滚动。

### 0.2.12 — LOCFIX · 本地化页面滚动修复 + 分页
- **修复页面不能滚动**:0.2.11 引入的布局容器 div 只有 `id="wrap"` 而没有 `class="wrap"`,
  但 CSS 用的是类选择器 `.wrap{flex:1;display:flex;min-height:0}`,样式从未生效 → main 高度
  不受约束、内容被 body overflow:hidden 裁掉、整页无法滚动。改为 `#wrap` 选择器后,
  main 高度受限(实测 clientHeight=641 < scrollHeight=6655)、overflow-y:auto 正常滚动。
- **新增分页「每 XXX 条为一页」**(loc.html/loc.js):
  - 工具条新增「每页条数」下拉(100/200/500,默认 200)。
  - key 全表模式走服务端 offset/limit 翻页;按文件模式走客户端切片分页。
  - 表底新增分页条:‹上一页 / 第 X / N 页 · 共 M 条 / 下一页›,首末页按钮自动禁用。
  - 实测:默认空查询 129931 条 → 200/页共 650 页,下一页跳转、换首行、页数正确;
    切 100/页 → 1300 页、每页 100 条。

### 0.2.11 — LOCALISATION_V2 · 本地化按文件递归浏览 + 基础语言英文
- **新增「按文件」浏览模式**(loc.html/loc.js):工具条「按文件浏览」切换;左侧递归文件树
  按 语言 → 目录 → 文件 罗列(含每文件条目数、错误标记、语言级缺失数),点文件右侧列出
  该文件全部条目 + 所选各语言译文,缺失标「(缺失)」;复用现有单元格改写/复制/键盘导航。
- **后端新增两个端点**(server.ts):
  - `/api/loc/files`:递归文件树(按语言分组→目录→文件),语言级 keys/missing(相对参照语言)。
  - `/api/loc/file?path=&lang=...`:某文件宿主语言的全部 key + 各请求语言的译文/缺失。
- **基础语言 = 英文**:修正前端默认语言(原判断 `lang==='english'` 永远匹配不上 `l_english`,
  导致默认选了俄/法);现在默认 l_english + l_simp_chinese 并列。
- **参照语言 = 英文**:修正 /api/loc/stats 与 /api/loc/search 的 ref 默认值(`l_english`),
  缺失检测统一以英文为基准(实测 l_simp_chinese 相对英文缺 408 条)。
- 验证:后端端点经 python 实测(aat_focus_l_english.yml 2191 条、zh 全命中);浏览器实测
  文件树渲染、点文件显示条目+缺失;默认语言列=l_english|l_simp_chinese;参照语言=l_english。

### 0.2.10 — TECHCARD_V1 · 科技节点展示调整(图标放大 + 名称移到图标下方)
- 图标由原 18×18 放大到 46×46,居中于卡片顶部;文字名称由「图标右侧」改为「图标下方居中」。
- 改动(tech.js):`NH` 34→64(容纳放大图标+下方名称)、新增 `ICON = 46`;图标 x 按
  `p.x+(nodeW-ICON)/2` 居中、y=p.y+3;单条节点标签 text-anchor=middle、y=p.y+NH-7,
  按卡宽 `max(4,floor(nodeW/9))` 截断。
- 改动(tech.html):`.node text.nlabel` font-size 9→10px。
- 同格堆叠(单格多条)仍保持逐条文字行,不改;缩放极小(tiny)时仍隐藏文字。
- 验证:node --check 通过;服务端下发的 tech.js/tech.html 已确认含新常量与样式(服务器直供磁盘文件,刷新即生效)。

### 0.2.9 — TECHLAYOUT_GUI_V2 · 逐 folder 轴方向修正(修复 8 页签与游戏不符)+ DLC 筛选默认全勾
- **根因**:上一版(0.2.8)对所有 folder 无条件轴交换(x=b.x+p.y*slotW),只对「年份横排」folder
  正确;对「年份竖排」的 folder 全部画歪(装甲NSB/火炮/装甲/空军BBA/空军/工业/电子)。判断依据:
  gui 每个 folder 容器内 year 标签的方向——横排(infantry/support/naval/mtg 海军)需交换,
  竖排(其余)不交换。
- **修复(tech.ts)**:新增 `SWAP_AXIS_FOLDERS` 常量(交换组 5 个:infantry_folder、support_folder、
  naval_folder、mtgnavalfolder、mtgnavalsupportfolder);assignGridboxes 像素公式按 `axisSwap`
  分支:交换组 `{x:b.x+p.y*slotW, y:b.y+p.x*slotH}`,不交换组 `{x:b.x+p.x*slotW, y:b.y+p.y*slotH}`
  (slotW/slotH 取该 folder 所属 gridbox 的 slotsize)。tech→gridbox 归属算法沿用 0.2.8,未改动。
- **修复(tech.js)**:条件面板 DLC 分组默认全部勾选(buildTrigPanel 对 DLC 组 items 预置
  S.scope.add),而非默认全不选。
- **全量坐标审计**:修复后 /api/tech/graph 568 条 px 与 gui gridbox 数学(origin+position×slotsize)
  完全一致(12 个具名 folder 零 mismatch;唯一 mismatch 为空 folder id 的 141 个补位科技,设计内行为)。
  - 工业页签归属实证:concentrated_industry→basic_machine_tools 树、fuel_refining→fuel_silos 树
    (两者原始 position 相同但游戏内分属不同 gridbox 原点,引擎归属与游戏一致);power 链→
    power_high_pressure_boilers 树、construction/excavation→construction1 树、oil/rubber→fuel_silos 树。
  - 海军MTG 保持交换组(年份横排,用户明确不反转);其 gridbox 归属未决疑点(sonar/smoke/
    depth_charges 归 early_ship_hull_light 树、basic_heavy_armor_scheme 归 basic_cruiser_armor_scheme
    树)已如实标注,若后续实测再报该页签错,以此两点核 dump 的 gb 归属。
- **验证(headless Edge + CDP 实渲染,2400×1600 视口)**:12 页签全部截图;节点数/图标数全匹配
  (infantry 13/13、support 42/42、armour 18/18、nsb 28/28、artillery 28/28、mtgnaval 38/38、
  mtgnavalsupport 41/39、naval 32/32、air 34/34、bba 41/41、industry 47/47、electronics 27/27);
  **console 错误 0 条**;图标全部 data: 内嵌真实 PNG 装备贴图;DLC 复选框 {total:8, checked:8}。
  目检截图:火炮 4 竖列(主炮/AA/火箭/AT)、空军各机种竖链、工业 construction/excavation 并排 +
  合成油/电力分块、电子四簇、装甲(NSB)轻/中/重/超重/陆巡分列、海军MTG 保持年份横排。

### 0.2.8 — TECHLAYOUT_GUI_V1 · 科技树布局对齐 countrytechtreeview.gui + 图标真实 GFX
- **布局:科技位置不再用自定 XU/YU 间距,改为【gui gridbox 原点 + position×slotsize】**。
  - engine(tech.ts):`readTechLayout(roots)` 递归解析 interface/countrytechtreeview.gui
    (15 个 folder 容器 / 64 个 gridbox,多 root 后加载覆盖;百分比坐标按 GUI_REFW=1400/
    GUI_REFH=1275 折算),`assignGridboxes(g)` 做 tech→gridbox 归属 + 像素坐标(px)。
  - 归属算法(无法在无游戏环境下逐帧确证,方案如下):名字分层(相等100/前缀+下划线90/前缀80/
    去数字前缀85/去噪声核心60,NOISE 词表=iw/bba/early/interwar/basic/improved/advanced/modern/
    tech/gw/gwtank/experimental/jet)→ 边亲和优先(唯一指向的 box 直接归入,修 infantry_at 被
    拉去 support_weapons)→ 家族回退(boxW=按分类去重取最大权重,非 mio 1.0/mio 0.25;平局按 gui
    声明顺序)→ 全 0 分兜底该 folder 首个 box。同原点 gridbox(infantry support/night_vision、
    naval early_heavy/light_cruiser)按名字归属,不按坐标离群。
  - 特例:air 60×70、electronics 60×60、basic_battery 70×35(行距压缩)、armour 百分比 x。
  - 实测:556 科技全有 px;415 个有 gui 布局的科技进 gridbox,141 个(撰稿/mio 等无 folder)按
    70×70 兜底不进任何 gridbox;0 unmatched;同格堆叠从 ~58 组收敛到 2 组(按 gridbox 分组,
    transport 树与 mb 子树同坐标格不再互扰)。
- **图标:装备→GFX 三段回退,不再清一色齿轮/坦克图标**。
  - server.ts:tex = 显式 icon → `equipTexId(科技id, 节点)` → 默认 GFX_technology_medium。
  - equipTexId 匹配【sprite 名(去 gfx_ 前缀)+ 贴图 basename】双通道(权威名是 sprite 名:
    GFX_GER_iw_small_airframe_medium 的贴图其实是 GER_early_fighter.dds);候选名=装备名列表+
    科技 id;装备名再派生【去尾版本号 / 再去 _equipment|_module】基准(light_tank_equipment_1 →
    archetype_light_tank_equipment);打分 GER6>SOV4>他国2>通用1,+路径含 technologies、+medium、
    +id 精确形式(GFX_<id>_medium / GER_<id>_medium,修 fighter1 平局误中 heavy_fighter1)。
  - 实测:416 种 distinct 贴图;默认图标仅 65 个(全部为无装备的工业/电力/撰稿科技,游戏里同样
    画默认);491/556 = 88% 真实装备/科技图标;抽检 infantry_weapons1→GER_infantry1_medium、
    early_destroyer→GFX_early_destroyer_medium、basic_light_tank→GER_basic_light_tank_medium
    均正确。
- **前端(tech.js):全部改像素坐标系**。
  - 删自定 XU=104/YU=62;SLOT_DEF=70 兜底格;slotIndex 键 `${folder}|${gb}|${id}`;
    curFolderId/rawXY/nodeXY 按当前页签取 gui 像素;nodeW 随 slotW 收缩(60px 格→52px 卡,
    默认→62px);normOffsets/fit/centerOn 走像素;GW 边路由改【上节点底锚/下节点顶锚 +
    cw=ch=1】,通道(chanY)恰落行间空隙(全量 385 边 node 级复算:0 路由失败、0 NaN,
    24 条同列纯垂直边、1 条紧行距(8px)让位轻微下探已接受)。
  - 验证(headless Edge 实渲染):tech.html 无 console 错误;默认页 13 个步兵科技坐标与
    gui gridbox 精确吻合(support_weapons 行 y=0、infantry_weapons 行 y=115、AT/advanced 行
    y=255,列=文件 position×70);13/13 图标为 data: PNG 真实贴图、无齿轮回退;TRIGGERS 条件
    面板、15 个 folder 页签、同格堆叠(2 组)、OWNERSHIP 描边、techTrees 全保留。
- 说明:浏览器自动化(bu)在本机无法连接宿主 localhost,改用宿主 headless Edge 渲染 + DOM/
    截图验证;tech→gridbox 归属在无游戏环境下以「gridbox 原点 + position×slotsize 能形成规整
    子树分块且不冲突」为准,逐 folder 与 v6 全量报告核对一致。


### 0.2.7 — INLAY_SLOT_V6 · 内嵌窗口按 orientation 锚定槽位
- 根因:model.ts/MU 把内嵌根窗口左上角置于槽位 (sl.x, sl.y),忽略窗口声明的 `orientation=lower_left`。
  内嵌根应以其【左下角】贴槽位锚点,即整窗上移窗口高度。上版(V5)因此让整个窗口相对槽位偏低 550px(窗口高)。
- 修复:designer.js `geomOf()` 对无父级内嵌根,按 orientation 求左上角平移 —— lower_left → 左上角在 (sl.x, sl.y-高);
  center → (sl.x-宽/2, sl.y-高/2);right/lower 同理。vanilla 6 个 inlay 组件统一 lower_left,均适用。
- 验证:GER_inner_circle 根窗左下角与槽位锚点 (4500,1150) 重合(画布:窗底==槽位顶),内部 42 元素相对坐标不变。

记录每次发布的**用户可见**变化。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)
（`MAJOR.MINOR.PATCH`）：

- `MAJOR`：不兼容的目录/启动方式大改
- `MINOR`：新功能 / 明显改进（向后兼容）
- `PATCH`：修 bug / 细微修正

---

## [0.2.6] - 2026-10-07

### 修复
- **界面设计器·内嵌组件(GER_inner_circle 等)未嵌合进槽位(INLAY_SLOT_V5)**：
  内嵌窗口的父级是国策树槽位原点,不是屏幕 (0,0)。此前渲染用 `geomOf(root)`=(0,0),
  只有 `absOf()`(fit 用)对根加了槽位平移 → 根窗口画在 (0,0),而槽位在几千像素外
  (实测 GER_inner_circle 槽位 {4500,1150}),窗口与槽位永不重叠。
  现把槽位平移并入 `geomOf()`(inlay 根节点,`!n.parent` 时加 sl.x/sl.y),
  `absOf()` 去掉重复加;渲染与 fit 统一。
  验证:GER_inner_circle_scripted_gui 根窗口与槽位完全重合,
  内部元素相对坐标与后端 absX/absY 逐位一致(fuhrer_frame 237,58 / ascended_advisor_3_frame 409,274 / advisors_container 80,490 等)。

## [0.2.1] - 2026-10-07

### 修复
- **国策树 / 科技树加载即 Out of Memory（GRIDWIRE_V2）**：
  连线占用表的 `release()` 原是「遍历整张表删掉这条线」，却被放在**每条边**的循环里
  → 复杂度 O(边数 × 格子数)。实测最大树（japan_wtt_focus，448 节点 / 655 边）在
  512MB 堆限制下**直接把 V8 打崩**；浏览器里表现为加载国策树 / 科技树时 Out of Memory。
  现在每条线登记自己占过的格子，撤销只删自己那几个 → 复杂度与总格数无关。
  同数据实测：**2ms / 943 格**（原来直接 OOM）。
  另修三处连带问题：
  - 拖拽时每个 `pointermove` 都重建整张占用表 → 改为每帧最多跑一次（松手时同步补一次）；
  - 坐标缺合法性守卫（一个 NaN 就能让 for 循环永不终止）→ 加非有限 / 越界 / 超容量上限；
  - 绕行两次都冲突时会把自己的占用登记清掉，导致后续边检测不到冲突（越画越乱）→ 改为保留。
- **科技树首屏空白**：`buildCatBar` 里的循环变量 `tr` 遮蔽了全局 `tr()` 翻译函数，
  抛 `TypeError: tr is not a function` 中断 `loadGraph` → 页面一片空白。
  已改名并在注释里标出这个坑（同类坑：`applyFilter` 里也有一处）。
- **国策树首屏不自动选树**：树列表加载完成后不再自动打开第一棵，画布空着等用户手点。
- **科技树页签点出空集**：科技树页签（按 folder 分组）与 folder 页签同时选中时
  是「两个 folder 求交集」，恒为空。现在两者互斥（下拉框改值也兜在 `applyFilter` 里）。

### 新增 / 改进
- **IDE 图像素材预览（IMAGE_ASSET_V1）**：IDE 直接打开 `.dds` / `.tga` / `.bmp` / `.png` /
  `.jpg`，服务端解码后以内嵌 PNG 下发，前端进独立预览视图（棋盘格底 + 缩放按钮 +
  Ctrl+滚轮 + 适应窗口 + 1:1）。不再当二进制文本乱码。
- **全屏跨页保持（FULLSCREEN_V2）**：切页后浏览器必然退出全屏，而无用户手势的
  `requestFullscreen()` 会被浏览器一律拒绝 —— 旧版「加载后 120ms 自动恢复」是 100% 静默失败。
  改为首次 `pointerdown` / `keydown`（捕获阶段）恢复，并给出可关闭的提示条。
- **国策树对齐 HOI4 MU（GRIDWIRE_V1 + OR_V1）**：
  - 连线改「整数网格 + 格间正交轨道 + 占用表避让」，不再画节点中心曲线；
  - `prerequisite` / `mutually_exclusive` 保留「且 / 或」结构，`OR` 边画点线、检查器分组显示；
  - `allow_branch` 传递闭包（下游科技也受上游分支门控）以连线形式下发。
- **科技树对齐 HOI4 MU（TECHGRAPH_V1）**：
  - 新解析 `xor`（互斥，双向虚线）、`allow_branch`（DLC / 前置科技门控）、
    `sub_technologies`（45 处）、`force_use_small_tech_layout`；
  - `allow_branch` 沿 `leadsToTechs` 求传递闭包；
  - 新增「科技树」页签行：按 HOI4 MU `$s()` 的可达性合并算法，把每个 folder 内的科技
    合成若干棵起始科技树（实测 552 科技 → 200 棵树），与游戏里一页一页翻的单位一致；
    `technology_folders` 行保留为分区与统计。
- **国策树 / 科技树「分支显形」条件 = 忠实移植 HOI4 MU 0.18.1（TRIGGERS_V1，重写）**：
  - 按 MU 的 QV 模型（`static/common.js`）重写 `trigger.ts`：每个条件叶子规范化为
    `{scopeName:'', nodeContent:'key = value'}` 对，求值 = **在 scope（Set<nodeContent>）里按
    原样字符串相等命中 → true，否则 false** —— 两态，无「未知灰显」（MU 没有未知态）。
  - 组合算子按 MU 真值表：AND / OR / NOT / ANDNOT(NAND) / ORNOT(NOR) / count(命中数≥amount)。
  - `allow_branch` 是**完整条件树**（非粗略 has_dlc 列表），前端 `Trig.evalTrig(tree, scope)`
    真正决定分支显隐；**下游传播**：某科技 / 国策的全部前置均被隐藏 → 它也隐藏（沿 leads 边）。
  - 新增条件面板：全树**唯一 nodeContent 去重**条件叶子列成复选框（按「DLC / 已完成科技 /
    已有科技 / 已完成国策 / 国策分支 / 已有国策 / 游戏规则 / 旗标 / 全局旗标 / 原国策tag」分组），
    勾选写入 scope 即时重算显隐与统计；默认收起；「全部清空」一键复位。
  - 条件清单口径对齐 MU：科技树只收 `allow_branch`；国策树按 MU `yg()` 只收
    `allow_branch + offset.trigger`（**不含 available/visible**，避免省份键噪音）。
  - **解析器完整对齐 MU（TRIGGERS_V2，重写 `trigger-parse.ts`）**：按 MU `dist/web-extension.js`
    的 `D()/M()/b()/x()/U()/$()/B()/j()` 忠实移植 ——
    - `if/limit/else_if/else` 展开成 `or-of-andnot` 链（不再保留为 opaque leaf）：过时分支
      （`has_game_rule = { rule = obsolete_focus_branches_visibility option = HIDE }`）的门控
      与 MU 一致，勾选 HIDE 即显形隐藏的分支；
    - `not` 编译为 `ornot` 整块（`NOT = {a b}` = `!(a 或 b)`，与单子取反不同）；
    - nodeContent 用 MU `b()/x()` 口径：字符串值**保留引号**（`has_dlc = "La Resistance"`）、
      块值规范化为单空格 `{ rule = … option = … }` —— 游戏规则等块值条件不再因空白不同而重复；
    - `M()` 嵌套作用域判定（tag / 角色 / mio / sp / 省份 / this / root / prev / from / 作用域化触发键）；
    - `U()` 布尔化简在收集前执行（`always = yes/no` 折叠为布尔、单子 and/or 折叠）。
  - **前端交互对齐 MU new mode（TRIGGERS_V3）**：
    - **每节点"已完成"复选框**（MU `checkedFocuses`）：被某个 `allow_branch` 以
      `has_completed_focus = <id>` 依赖的国策，节点左上角画一个复选框；勾选把
      `has_completed_focus = <id>` 写入 scope 并整树重算 → 依赖它的分支显形。
      隐藏节点不画复选框（与 MU 一致）；复选框层 `pointer-events:none`，只留自身可点，
      不挡拖拽/平移/缩放。
    - **条件面板排除 `has_focus_tree` / `has_completed_focus` 前缀**：这两类条件
      由树本身 + 每节点复选框驱动，不再占面板（对齐 MU `useConditionInFocus` 的
      `conditionExprs` 过滤口径）。
    - 该复选框与检查器"模拟已完成此国策"写同一 scope 键，两者等价可互换。
  - 顺带修复两页都存在的 `Sizer.onChange` 自递归（onChange 自身即 resize 监听器，处理函数再
    `dispatchEvent('resize')` 无限自递归 → 页面冻结），改为直接重算布局。

### 维护
- 版本号统一到 `0.2.1`（`VERSION` / `version.json` / `CHANGELOG.md` / `package.json`）。

## [0.2.1] 补充 - 2026-10-07

### 修复 / 改进
- **国策树列距修正（FOCUS_GRID_V1）**：列距 `XU` 由 24 提到 66（MU 的 `xGridSize≈50`，本项目节点盒 62px，
  取 66 让列距 ≥ 盒宽）。此前列距 24 远小于盒宽 62 → 相邻列节点横向重叠 38px：
  窄树渲染成一条细竖列（"左右宽度过窄"），宽树盒子叠在一起、连线挤在窄通道（"线条凌乱"）。
  实测 122 节点：**节点重叠 0**（7381 对），149 条连线**全正交无斜线**。
- **科技树轴交换（TECH_AXIS_SWAP_V1）**：HOI4 科技文件里 `x`=纵向分支行、`y`=横向进阶列，
  游戏画面是**左右进阶**（列=文件 y、行=文件 x）。此前未交换轴 → 所有页签的科技树渲染成竖排。
  现 `nodeXY`/边布线/归一化统一交换 → 科技树左右排布（实测 fighter1 在 early_fighter 右侧 71px）。
- **科技树图标加载修复（TECH_ICON_V1）**：`doLazyIcons` 把 `nodeXY` 返回的**像素坐标**又乘了一次
  `XU/YU`（双重放大 ~1 万倍）→ 所有图标被判定在视口外，只显示内置默认齿轮。已改为直接用像素坐标，
  现加载游戏的 `.dds/.tga` 素材图（实测 `nodeicon` href 为游戏 PNG data URL）。

## [0.2.2] 补充 - 2026-10-07

### 修复 / 改进
- **连线重写：端点锚点一致 + 水平段进通道（GRIDWIRE_V3）**。
  `packages/gui/public/gridwire.js`（focus 与 tech 共享）:
  - **修反折上挑**：目标锚点原为 `by = b.gy*ch - hh`（目标行顶上方 1/2 节点高），
    与源锚点 `ay = a.gy*ch + hh`（节点中心）不一致 → 每条斜边末端会**向上反折**一段
    （如 `...V90 H... V59` 在 90 处又折回 59），且线永远差 1/2 节点高够不到目标节点，
    在上下层交界处看起来特别乱。已统一为 `by = b.gy*ch + hh`（节点中心，与源对称）→ 线干净下穿进节点。
  - **水平段进行间通道**：原水平段画在 `turnY*ch`（下一行**行顶边界**），会压着下一行节点顶边
    （“线切过节点行”的乱象）。已改为放进源节点相邻的**行间通道中点**
    `chanY = turnY*ch ± ch/2 + hh`（下行=下一行上方通道、上行=上一行下方通道）。
  - 实测 focus（generic_focus 67 边）与技术树（infantry 36 边）斜边均为
    `M src V chan H tgt V center`，无上挑、无穿行节点；两页 console 0 error。

## [0.2.3] 补充 - 2026-10-07

### 修复 / 改进
- **科技/国策位置按 `position` 字段 + @常量按文件作用域（POS_AT_FILE_VARS）**。
  游戏特性:`@常量名 = 数值` 定义常量、`变量名 = @常量名` 使用常量，且常量**仅限所在文件可见**。
  - `packages/engine/src/tech.ts`：位置来源顺序改为 **tech 块自己的 `position = { x y }` →
    folder 子块的 position（vanilla 标准格式）→ 直接 x/y**；`@` 常量由全局表改为**按文件表**
    `g.fileVars` 收集/解析。实测同名常量跨文件数值不同（infantry.txt `@1936=2`、
    NSB_armor.txt `@1936=4`），全局后加载覆盖会串味 → 部分科技 y 全错。
    修后 NSB_armor 坦克科技 y=@1937→5、@1940→7（本文件值，不再被 infantry 污染）。
  - `packages/focus/src/model.ts`：新增 `scanFileVars`/`resolveNum`，按文件收集 `@` 并用于
    国策 x/y、continuous_focus_position / initial_show_position / inlay_window 的坐标解析。
  - 实测：tech 552 科技 / 382 边 / 8 条件；generic_focus 56 节点坐标与文件一致。

## [0.2.4] 补充 - 2026-10-07

### 多 folder 科技支持（MULTI_FOLDER_TECHS）
- **科技树 folder 分组来源**:先读 `common/technology_tags/*.txt` 的 `technology_folders` 取规范文件夹清单
  （`g.folders` + `g.folderOrder`,原有实现已具备）;再按每项科技在 `common/technologies/*.txt` 的
  `folder = { name = X position = { x y } }` 块,取得该科技在【每个】folder 的独立 name + position。
- **一个科技有多个 folder 都算上**（对齐 HOI4 MU `tech.folders[当前folder].x/.y`）:
  - `packages/engine/src/tech.ts`:TechNode 新增 `folders: Record<folderName,{x,y}>`;
    解析循环改用 `childBlocks` 读**全部** folder 块,每块独立 name+position;主 folder/x/y 取首个块
    （单 folder 场景与旧逻辑完全一致）。
  - 图构建 `buildTechTrees` 按 `node.folders` 全部分组,多 folder 科技进入【每个】folder 的树;
    `collectSlots`/`autoLayoutPositions` 的槽位与全局占用同样按全部 folder,非主 folder 的声明坐标
    也计入全局占用避免补位碰撞。
  - `packages/gui/src/server.ts`:科技节点 JSON 下发 `folders` 映射。
  - `packages/gui/public/tech.js`:新增 `nodePos`/`slotOf`;folder 过滤按 `folder in n.folders`;
    定位节点时 folderFilter 命中则用 `n.folders[folderFilter]`,否则用主 x/y;槽位索引按 `${folder}|${id}` 键存。
- 实测原版 12 个多 folder 科技全部正确处理:radio（electronics_folder + support_folder）、
  motorised_infantry（infantry_folder + support_folder）、sp_centrifugal_jet_tech（bba_air_techs_folder +
  air_techs_folder）等。浏览器实测:切 support_folder 页签时 radio/motorised_infantry 出现在该 folder
  并按 folders[support_folder] 坐标排布;切回 electronics_folder 时 radio 换回 electronics 坐标（-3,2）。
  552 科技 / 382 边 / 8 条件不变。

## [0.2.5] 补充 - 2026-10-07

### 界面设计器元素定位对齐 HOI4 MU（DESIGNER_MARGIN_V1 + RESIZE_RECUR_FIX）
- **后端定位引擎核对结论**：`packages/gui/src/model.ts` 的 `axis()`/`applyMin` 已与 MU `m()/g()/f()`
  逐位一致（orientation 锚点表、`%/%%` 单位、负尺寸、size.min 减自身 off、centerposition 减未缩放
  sprite/2、orientation 不继承、根上下文 1920×1080、margin、show_position、fullscreen）。
  元素位置的**核心算法无需再改**，问题都在前端渲染路径。
- **修复前端 Sizer 自递归栈溢出（RESIZE_RECUR_FIX）**：`designer.js:800`
  `Sizer.onChange(() => dispatchEvent('resize'))` 无限自递归（onChange 本身即 resize 监听器），
  一加载即 `Maximum call stack size exceeded`、画布渲染中断。改为 no-op（画布相对定位、
  面板宽度变化不改变元素坐标），与 focus/tech 已修过的同类 bug 一致。
- **修复子元素 margin 平移丢失（DESIGNER_MARGIN_V1）**：后端 offX 相对「绘制尺寸扣 margin」的
  缩减框计算、本身不含 margin 平移，但前端嵌套 DOM 直接把子元素画在父内 → 带 margin 的窗口
  子元素整体缺了 (margin.left, margin.top)。MU 用 `containerwindowChildren` div 平移到 margin；
  这里等价实现：`server.ts nodeJson` 下发 `margin`，`designer.js buildDom` 为有 margin 的节点包一层
  `.node-margin` 容器 div（absolute + left/top=margin）。实测 countrydiplomacyview 23 个 margin
  窗口的 wargoals_grid 相对父偏移由缺失前的 (1,1) 修正为 (3,3)（= margin 13 + offX 6 × 缩放），
  与后端 absX 一致。

## [0.2.0] - 2026-10-07

### 新增 / 改进
- **目录结构重组**：用户入口（`run-gui.*` / `README.md` / `新手指南.md`）留在根目录；
  工程文档归入 `docs/`；开发/QA 脚本归入 `tools/`；截图归入 `docs/assets/`。
  根目录不再堆满散落文件，便于整理和查看。
- **双语（i18n）补全**：覆盖审计 39/39 全绿。新增 `i18n-dict-html.js`（HTML 块内部标签）
  与 `i18n-dict-ui.js`（状态/提示短句）；修正 `dlc.js` 动态 `title` 串与字典值反斜杠 bug；
  审计口径改为「HTML 块解构为内部中文 token」。
- **顶栏交互**：导航下拉由「点击」改为「鼠标停留（hover）即展开」。
- **顶栏固定布局**：20 个页面 `<header>` 只留导航，页面工具下移进 `.subbar`，布局统一。

### 维护
- 初始化 Git 仓库；新增 `VERSION` / `CHANGELOG.md` / `version.json` 作为统一版本源。
- 启动器 `boot.cjs` 支持**可选远程版本检查**（环境变量 `HOI4TK_UPDATE_URL`），
  发现新版本时打印提示，不阻断启动。

## [0.1.0] - 初始版本
- 无损解析、索引、重构、可视化工作台；零运行时依赖，Node 22.6+ 原生跑 `.ts`（无需 npm install / 构建）。
- 一键启动器：自动探测游戏目录、生成 `gui-settings.json`、启动服务并打开浏览器。
