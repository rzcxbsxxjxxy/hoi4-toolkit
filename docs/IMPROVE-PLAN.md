# 改进方案：参考 CWTools 与 HOI4 Mod Utilities

> 日期：2026-10-06
> 对标对象：CWTools: Paradox Language Services（cwtools/cwtools-vscode）、HOI4 Mod Utilities（herbix/hoi4modutilities v0.18.1）
> 本文所有数据结论均来自本机实测，不采信文档描述。涉及文件均给出行号。

---

## 摘要

本项目在**可视化广度**和**写入能力**上已超过两个对标对象（14 个域可视化 + 唯一能写回文件；CWTools 与 HOI4 MU 都是只读预览）。真正的短板集中在**校验深度**：

> **1,672 行规则引擎 + 111 个 `.cwt` 规则文件（1,962 条 alias）已经写完并有测试，但完全没有接入产品。**
> 用户在 GUI 上点「体检」，跑的是另一套 683 行硬编码的 6 类检查。规则引擎能查的 `undefined-ref` / `bad-enum` / `value-type` / `cardinality` / `unknown-key` / `missing-loc` 一条都看不到。

这是本次最高优先级问题——**已投入未变现**，且修复成本极低。

---

## 一、事实核查（实测，非转述）

### 1.1 三个结构性发现

| # | 论断 | 实测方式 | 结果 |
|---|------|---------|------|
| 1 | cwt-check 未接入产品 | `grep -rn checkWithRules` 全仓 | 调用方只有 `engine/test/*.test.ts` 与根目录 `_probe_*.ts`。**`server.ts` 里没有任何 `cwt` 相关 import** |
| 2 | `script_documentation.json` 是死数据 | `grep -rn script_documentation` 全仓 | **0 命中** |
| 3 | 官方 `scopes` 字段只用于补全 | 追 `OFFICIAL_ALL` / `.scopes` 消费方 | 唯一消费方是 `completion.ts:190-196`，拼成 hover 提示文本。`validate.ts` 与 `cwt-check.ts` **从未读过 `scopes`** |

### 1.2 关键数据价值实测

两份作用域数据**互补**，不是重复：

| 数据源 | 位置 | effects | triggers | 带 scope | 用途 |
|--------|------|--------:|---------:|---------:|------|
| `script_documentation.json` | `engine/cwt/` | 553 | 598 | effects **544** / triggers **592** | 死数据 |
| `official-docs.gen.ts` | `engine/src/` | 623 | 535 | effects **522** / triggers **459** | 仅补全 |

`script_documentation.json` 的作用域覆盖更高（544/553 = 98.4%），且带 `description`（`add_legitimacy = 10. Adds legitimacy to Scope country.`）。

**可判定性实测**（决定方案可行性）：

```
effects   总 553 | 无 scope 9 | 单 scope(可硬判) 502 | 多 scope(需包含判断) 42
triggers  总 598 | 无 scope 6 | 单 scope(可硬判) 565 | 多 scope(需包含判断) 27
出现的 scope 种类数: 13
  COUNTRY, STATE, any, CHARACTER, SPECIAL_PROJECT, RAID_INSTANCE,
  STRATEGIC_REGION, OPERATION, INDUSTRIAL_ORG, PURCHASE_CONTRACT,
  COMBATANT, ACE, FACTION
```

**结论**：13 种作用域、90% 以上是单值——**完全可以做硬判定**。这是 CWTools 最核心的护城河（"这个 effect 能不能用在这个作用域"），本项目目前是 0。

### 1.3 引擎能跑，但必须先降噪

实测 `checkWithRules`（vanilla + 探针目录）：

```
耗时 8303 ms
规则规模: {"aliases":1962,"structs":120,"types":229,"enums":152}
诊断 97606 条  stats = {"error":45,"warning":2518,"info":95043}
  byCode: {unknown-key: 95043, bad-enum: 1429, value-type: 754,
           cardinality: 335, undefined-ref: 45}
```

**97% 是噪音**（`unknown-key` 95,043 条）。噪音 Top：单个 `00_traits.txt` 就产 7,008 条。

更重要的是：我在探针目录里植入的三个错误（STATE-only 的 `add_province_modifier`、不存在的 `totally_bogus_effect_zzz`）**一条都没被报出**——探针目录相关诊断为 **0 条**。

**这意味着：直接接入 cwt-check 会得到一个"9 万条噪音 + 漏报真错"的体检页，比现状更糟。** 降噪是接入的前置条件，不是后续优化。

---

## 二、改进方案（按投入产出比排序）

### P0-1　规则引擎接入 + 降噪（最高优先）

**目标**：把已完成的能力变现，且不制造噪音。

**步骤**

1. **先降噪（独立一步，不可跳过）**
   - `unknown-key` 改判定：仅当键**在全局 alias 索引里也不存在**时才报。现有逻辑是"结构里没声明 + 规则库也无 alias"就报 info——但 `00_traits.txt` 那类文件用的键大量在规则库覆盖范围外。
   - 按 `severity` 指令分流：`info` 类默认不进体检页，只在"显示全部"时列出。
   - 建立**白名单目录**：`common/characteristics`、`common/traits` 等已知覆盖不全的目录，先收集真实键集再判。
   - 验收判据：**噪音总量 < 500 条**，且探针里的 3 个植入错误必须被报出。

2. **接入 `/api/check`**
   - `server.ts:2676` 的报告结构保持不变，新增 `rules` 分区，合并 `validateRoots()` 与 `checkWithRules()` 两套结果。
   - 复用现有异步 + 世代号机制（`server.ts:1429-1478`），cwt 建索引 8.3s 走 `busy/progress` 轮询，不阻塞事件循环。
   - 缓存键复用 `validate.ts` 的两级缓存思路（按来源签名），切换模组命中 < 1.5s。

3. **补充 `.cwt` 规则缺口**
   `cwt-perf.test.ts:285-296` 已归因：`icon` / `prerequisite` / `available` / `immediate` / `option` 5 个键在 111 个 `.cwt` 里既无 alias 也无 struct。补规则文本即可，零代码。

**风险**：`resetIndexCache()` 必须在 ROOTS 变更时调用，否则拿旧来源的 sprite/loc 键去判新模组——静默假阴性（`validate.ts:307-310` 已有此教训）。

---

### P0-2　scope 上下文校验（CWTools 护城河）

**目标**：检出"在 COUNTRY 作用域里写了 STATE 专用 effect"这类高频错误，目前完全做不到。

**数据基础**：`script_documentation.json` 的 13 种作用域 + 502 个单值 effects（见 1.2）。**零采集成本，数据已在仓库里。**

**步骤**

1. 新建 `engine/src/scopes.ts`：从 `script_documentation.json` 建 `Map<键名, Set<作用域>>`，与 `cwt.ts` 的 `scopes` 表合并。
2. 把 `.cwt` 里**已解析但未使用**的 `push_scope` / `replace_scope` 指令接进作用域栈。
   - 现状：`cwt.ts:1097-1130` 已解析这两个指令，但 `cwt-check.ts:1465` 的 `directiveScopes` 只消费了 `scope` 和 `severity`。
   - 改 `cwt-check.ts:1049-1053` 那句"整块跳过键校验"——有了作用域栈就不必跳过。
3. 逐目录建立作用域上下文基线：`national_focus`/`ideas` = COUNTRY，`state` 相关 = STATE，`operative` = OPERATIVE…

**降噪是硬约束**：`cwt-check.ts:845-852` 自己写明"近似带来的是漏判而非误判"。本方案必须**只对单 scope 的 502 个 effect 做硬判**，多 scope 的 42 个降级为提示。

**验收判据**：故意在国策块里写 `add_province_modifier`（STATE-only）必须被报出；KR 全量跑 `scope-violation` ≤ 50 条（超过说明基线没建对）。

---

### P1-1　LSP 诊断与 hover 补全

**现状**（`packages/lsp/src/server.ts`，299 行，真实可用但残缺）：

| 能力 | 状态 |
|------|------|
| go-to-definition / find-references / completion / documentSymbol | ✅ 已实现 |
| hover | ⚠️ 只有"种类/定义N处/引用N处"统计，**无官方文档说明** |
| `publishDiagnostics` | ❌ 完全没有（**LSP 一半的价值在这**） |
| `textDocumentSync` | `1` = Full，应为 `2` = Incremental |
| 文件监听 | ❌ 无 |

**步骤**
1. hover 接 `official-docs.gen.ts`（2,836 条带说明）——数据已备，`completion.ts:190` 已经会拼 `detail`，LSP 侧照做即可。**成本极低**。
2. `publishDiagnostics` 接 validate + cwt-check 双源，`textDocumentSync` 改 `2`。
3. 修 `server.ts:198-201` 的 `character: 200` 硬编码——改为真实 token 范围。

**定位差异**：本项目的 LSP 是**唯一能改文件**的补全通道，CWTools 只能诊断。补齐后可直接替代它在编辑期的角色。

---

### P1-2　本地化补齐（对标 CWTools `genlocall`）

**现状缺口**（实测确认）：
- ❌ 「定义了但从未被使用」的 loc 键检测 —— `grep unused|未使用|orphan` 全仓，loc 侧零命中
- ❌ 「译文 key 不一致」检测 —— `/api/loc/search` 只按参照语言（english）的 key 池遍历，**中文目录里 english 没有的孤儿键根本不出现在候选池里，无从检测**
- ❌ 占位符一致性（`{0}` `{1}` 数量、`§X` 颜色码配对）
- ❌ 一键生成本地化骨架

**步骤**：先做"双向 key 集对比"（各语言独立求差集，取代当前单向以 english 为准），再做未使用键反向遍历。这两项目录已存在（`locsrv.ts`），增量成本低。

---

### P1-3　`default.map` 解析（对标 HOI4 MU World map preview）

**现状**（`server.ts:5593-5670`，写在巨型 server 文件里，无独立模块）：
- ✅ `provinces.bmp` 解码 → 省份质心 → `definition.csv` 建颜色→id 映射 → `history/states/*.txt` 抓 owner → `common/countries` 抓 color → 重着色
- ❌ **`map/default.map` 完全没解析** → 邻接关系、大陆划分、`area` 区域、terrain 全部无从谈起
- ❌ hover 是**质心点拾取**（9px 半径），不是多边形命中 → 欧洲密集区拾取体验差
- ❌ 无战略地区高亮、无多 owner 省份（只取第一个 owner）

**`default.map` 是纯文本、格式简单**，解析成本远低于建索引。解析后一次性解锁：邻接、大陆、terrain 区分、区域高亮。**这是 worldmap 投入产出比最高的一步。**

顺带把 worldmap 从 `server.ts` 抽成独立模块——5,719 行的单文件已到维护临界点。

---

### P2-1　事件树

**现状**：`after = { ... }` 被解析但**只存脚本文本**（`events.ts:239`），不解析其中的 `country_event = { XXX }` 引用，不建有向边。

对比：国策树有完整图 + 边 + 拖拽改坐标 + lint；事件只有列表 + 详情。

**步骤**：解析 `after` 块建事件间有向边 → 自动布局 → 可视化。价值在于展示"哪些事件会导致哪些事件"，以及 `trigger` 里的跨事件条件依赖（`has_country_flag` 等）。

---

### P2-2　架构：`server.ts` 拆分

5,719 行单文件承载 76 条 API + 14 个 `ensure*` 缓存层 + 14 个域构建逻辑，worldmap 甚至内联在 L5593-5670。**这是当前最大的维护风险**，且会持续拖慢新功能开发。

**建议**：按域拆 `packages/gui/src/routes/{focus,tech,loc,worldmap,check,gen}.ts`，保持 `server.ts` 只做分发。零行为变更，纯重构。

---

## 三、暂不做（附理由）

| 项 | 理由 |
|----|------|
| 补全 `packages/spec/`（901 行死代码） | `guilint.ts` 标注"原型"，且能力已被 `cwt-check` + `validate.ts` 覆盖。建议直接删除而非补全 |
| 文件监听 / 增量索引 | 无监听导致外部改动不感知。但当前缓存策略（惰性+异步+世代号）设计精细，增量改造风险大于收益。等 P0 落地后按实际痛点决定 |
| HOI4 MU 的 inlay 窗口预览 | 本项目已通过 `focus_inlay_windows` 名册（6 条）支持国策内嵌组件，覆盖度相当 |
| 地图导出 PNG / 键盘快捷键 | `toDataURL` 一行的事，收益低 |

---

## 四、验收纪律（沿用项目既有铁律）

1. **误报先 grep 磁盘**：报 undefined-sprite / missing-loc 前必须先在真实文件里 grep 那个名字。
2. **索引采集必须覆盖所有来源**：否则跨模组引用全报悬空。
3. **判据阈值先看真实数据再定**：不预设"噪音应该 < 100 条"，先跑 vanilla + KR 看真实分布。
4. **静默失效清单**（项目已有）：改公共件后必做 ①`node --check` ②桩测 ③真浏览器查 `window.X` 真挂上。HTTP 200 + 语法绿 ≠ 功能在。
5. **每项改动后跑全量回归**：`smoke_e2e.ts` + `gen-stats` + `detail-blocks` + `aibehave` + `detail-icon`。

---

## 五、建议执行顺序

```
P0-1a  降噪（独立可交付，先让 97606 → <500）
P0-1b  接入 /api/check + 补 5 个键规则
P0-2   scope 校验（数据已备，零采集）
P1-1   LSP diagnostics + hover
P1-2   loc 双向 key 对比
P1-3   default.map 解析
P2-1   事件树
P2-2   server.ts 拆分（贯穿全程，小步做）
```

P0 三项完成后，本项目在校验深度上会**超过 CWTools**（因为叠加了 HOI4 MU 没有的写入能力 + 国策/GUI 可视化），届时对标关系会从"各有短板"变为"本校验更强、对方可视化更细"。
