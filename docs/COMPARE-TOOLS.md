# 可靠性验收 + 同类工具对标

> 生成日期：见文件时间。数据来源：本机实跑（不是估算）。
> 对标对象：`chaofan.hoi4modutilities-0.18.1`、`tboby.cwtools-vscode-0.10.31`
> —— 两者都装在本机 `~/.vscode/extensions/`，能力清单直接读它们的 `package.json`，不靠记忆。

---

## 一、可靠性验收

### 1. 无损往返（地基）

```
node --experimental-strip-types verify_roundtrip.ts [额外目录...]
```

| 语料 | 文件数 | 逐字节一致 |
|---|---|---|
| vanilla `interface/`（.gui + .txt） | 455 | 455 |
| vanilla `common/` | 2218 | 2218 |
| KR 模组（workshop 1521695605） | 5054 | 5054 |
| 本地 `en/common` | 2218 | 2218 |
| **合计** | **9945** | **9945（0 不一致）** |

这是拖拽改坐标、跨文件重命名、元素级编辑的地基：一旦这里挂了，
diff 会连带你没碰过的行，而用户很难察觉。

### 2. GUI 坐标算法（对比 VSCode 扩展渲染链）

```
node --experimental-strip-types compare_v4.ts
```

| 指标 | 值 |
|---|---|
| 语料 .gui 文件 | 453 |
| 对比样本 | 23558 |
| 差异总数 | 5 |
| 其中「已知有意偏差」 | 5（自适应尺寸 / `orientation=left`） |
| **待核查** | **0** |

### 3. 三个判例（用户点名）

`/api/layout` 实测，节点含嵌套子节点：

| 判例 | 元素数 | icon/button | 0×0（非文本框） |
|---|---|---|---|
| `CZE_industry_focus_scripted_gui.gui` | 19 | 14 | **0** |
| `GER_inner_circle_scripted_gui.gui` | 42 | 23 | 3 |
| `JAP_imperial_influence_scripted_gui.gui` | 66 | 32 | **0** |

- CZE：12 个方块图标全部 `94×94`，logo `CZE_center_cosmetic` = `102×102`（204 × scale 0.5）。
- JAP：4 个 faction 容器间距 152/155/153 **不等距** —— 查原文确认
  `position.x` 本身就是 `-280 / -128 / 27 / 180`，是原版写死的，不是算错。
- GER 的 3 个 0×0（`ascended_advisor_1/2/3_portrait`）原文是 `spriteType = ""`，
  运行时由脚本填充。**0×0 是正确结果**，不是 bug。

### 4. 端到端冒烟

```
node --experimental-strip-types smoke_e2e.ts   # 需先起 server
```

覆盖：页面接入统一主题/导航（30 项）、内联脚本与 `public/*.js` 语法（21 项）、
13 条路由可达、6 个无参 API + 2 个带参 API 的结构断言。

> 注：沙箱里 node 不能再 spawn 子进程（EBUSY），语法检查走 `new Function` 进程内解析。

---

## 二、同类工具能力清单（实读 package.json）

### CWTools（`tboby.cwtools-vscode`）

定位：**编辑器内的语义校验 + 语言服务**，覆盖 10 个 P 社游戏。

命令：`outputerrors` `genlocall` `reloadrulesconfig` `cacheVanilla` `listAllFiles`
`listAllLocFiles` `debugrules` `pretriggerAllFiles` `startcustomgame`
`showGraph` `graphFromJson` `exportTypes` `saveGraphImage` `setGraphDepth` `saveGraphJson`

配置要点：`cwtools.rules_version` / `rules_folder`（规则文件可换版本）、
`localisation.languages`（多语言）、`cache.hoi4`（原版缓存）、`ignore_patterns`。

### HOI4 Mod Utilities（`chaofan.hoi4modutilities`）

定位：**HOI4 专属的可视化预览**。

命令：`preview` `previewworld` `scanreferences` `selectmodfile` `selecthoifolder`

- 自定义编辑器：`*.dds` / `*.tga`（贴图直接看图）
- Webview：`hoi4ftpreview`（国策树）、`hoi4worldmappreview`（世界地图）
- 索引范围（配置项 enum）：`gfx` `sharedfocus` `localisation` `event` `gui`
- 激活条件覆盖：`*.gfx`、`national_focus/`、`technologies/`、`military_industrial_organization/`、`events/`、`interface/*.gui`、`map/default.map`

---

## 三、功能对照

| 能力 | 我们 | CWTools | HOI4 MU | 说明 |
|---|:--:|:--:|:--:|---|
| 无损解析 / 回写 | ✅ | ❌ | ❌ | 我们的核心差异点 |
| GUI 所见即所得拖拽 | ✅ | ❌ | ⚠ 只读预览 | |
| 国策树可视化 + 坐标回写 | ✅ | 图导出 | ✅ 只读 | 我们能改 |
| 科技树 / 决议树可视化 | ✅ | ❌ | ⚠ 科技只读 | |
| 来源三层语义（base/origin/overridden） | ✅ | ❌ | ❌ | 多模组覆盖链 |
| 跨文件无损重命名 | ✅ | ❌ | ⚠ 只扫描引用 | |
| 语法 / 括号 / 悬空引用 / 重复定义 | ✅ | ✅ | ❌ | |
| 缺失本地化检查 | ✅ | ✅ | ❌ | |
| **字段级类型与值域校验（rules）** | ❌ | ✅ | ❌ | **最大缺口** |
| **本地化自动生成** | ❌ | ✅ `genlocall` | ❌ | |
| **世界地图预览（default.map）** | ❌ | ❌ | ✅ | |
| **贴图浏览器（dds/tga/png）** | IDE 内独立预览 | ✅ | ✅ 独立编辑器 | |
| **事件（events/）可视化** | ❌ 仅索引 | ❌ | ✅ | |
| **MIO 组织可视化** | ❌ 仅索引 | ❌ | ✅ | |
| 依赖图可视化与导出 | ❌ 有数据无图 | ✅ showGraph / saveGraphImage | ❌ | |
| 多游戏（EU4/CK3/Vic3…） | ❌ | ✅ | — | 取舍，非缺陷 |

---

## 四、缺口清单（按性价比排序）

### P0 —— 直接决定「能不能少写 bug」

1. **字段级类型与值域校验**
   现在只能查结构性问题（语法、括号、悬空、重复）。
   CWTools 靠 `.cwt` 规则文件能查「`cost` 写了字符串」「这个 scope 里不允许这个 key」。
   我们已有 `engine/src/common-rules.ts`（目录 → 键名 → 目标类型的映射），
   补一层「已知键的值域 + 未知键告警」就能覆盖大部分收益，不必上完整规则引擎。

2. **本地化自动生成**
   已有 `engine/src/loc.ts`（解析 + 建索引）。差的是：
   把体检里「缺失本地化」那一节一键导出成 `l_english.yml` 片段，
   并对接用户正在做的 MC​G key 三层→两层迁移。

### P1 —— 覆盖面补齐

3. **事件（events/）可视化**：`domains.ts` 已经解析 events，缺一张图 / 一个页面。
4. **MIO 组织可视化**：`indexer.ts` 已有 `mio_organization` 符号种类，缺前端。
5. **贴图浏览器**：`IMAGE_ASSET_V1` 已让 IDE 直接预览 dds/tga/bmp/png/jpg
   （棋盘格底 + 缩放 + 适应 + 1:1）。
   仍缺一个**按目录浏览 sprite 的独立面板**（列出尺寸、查被谁引用）。

### P2 —— 长线

6. **依赖图可视化**：`links.ts` 已有引用图（37594 定义 / 1429 引用），
   缺力导向布局与图片导出（对齐 CWTools `showGraph`）。
7. **世界地图预览**：需要 `map/default.map` + `provinces.bmp` 解析，投入大、收益窄。

---

## 五、结论

结构性能力（无损、坐标、来源语义、重命名）我们已经对齐或超过同类工具；
**缺口集中在「语义深度」和「覆盖面」两端**：

- 深度：字段级校验（P0-1）—— 这是 CWTools 真正的护城河，也是体检页最该补的一块。
- 覆盖面：事件 / MIO / 贴图（P1）—— 数据层大多已就绪，缺的是前端页面。

建议下一步按 P0-1 → P0-2 → P1-3/4/5 推进，每一项都能独立交付、独立验收。
