# 执行计划：把校验能力变现（EXEC-PLAN）

> 日期：2026-10-06
> 上游文档：`IMPROVE-PLAN.md`（方向级）。本文是**手级**：每一步有文件、行号、判据、回滚。
> 所有数字均为本机实测（vanilla 全量 `checkWithRules`），非估算。

---

## 零、与上游方案的关键修正（先读这一节）

上游 P0-1 写的是「**建白名单目录**，先收集真实键集再判」。**实测证明这是错的方向。**

我把 95,043 条 `unknown-key` 全量拆解后，根因是**规则关联缺失 + 一个引擎判定缺陷**，不是规则库覆盖不全：

| 编号 | 缺陷 | 现象 | 证据 | 修法 | 状态 |
|---|---|---|---|---|---|
| **D1** `ELSE`/`ELSE_IF` 不在作用域切换键集 | 1,338 条误报 | `cwt-check.ts:838-844` 有 `IF`/`IF.NE`/`LIMIT`，**唯独缺 `ELSE`/`ELSE_IF`** | 加两个字符串 | 已修 |
| **D2** 混合块不触发作用域切换判定 | 结构性**漏判** | `cwt-check.ts:1036` 用 `.every()`，要求块内**全部**键都是切换键才跳过校验。`IF` 与普通键混排时整块作废 | 改为**按条目粒度**跳过 | 已修 |
| **D3** `type[oob]` 缺 `skip_root_key` | 关联缺失 | `history/units/*.txt` 顶层键是 `units = {`，但 `struct.oob` 派不出去 → 整棵子树无字段表。**规则本身齐全**(`oobs.cwt:100-103` 已声明 `is_name_ordered`/`name_order`,`:186-197` 已声明 `ship.equipment.<equipment.naval_equip>`) | 加一行 `skip_root_key = units` | 已修 |
| **D4** `type[strategic_region]`/`supply_area` 缺 `skip_root_key` | 关联缺失 | 同上。对照:144 个 type 都有 `skipRootKey`(`unit=sub_units`/`technology=technologies`/`focus=focus_tree`),唯独这两个 map 相关 type 没有 | 各加一行 | 已修(29,174 → 0) |
| **D5** 「探针 0 条」的真正原因 | **调用方式错误** | 上游判为"引擎不报",实为顶层键写错(`focus_tree` 被写成 `national_focus`)+ 漏建索引(没先 `ensureIndexes`、没传 `locKeys`/`spriteNames`)。修好后探针 5 条诊断全部正确报出 | 修正调用 | 已修 |

**实测验证**:噪声分类精确切分两类根因

```
unknown-key 总: 95,043
  A) value=undefined(裸实体名 / 结构关联缺失): 22,997  (24.2%)
  B) 有 value(真键缺声明,补规则可消)      : 72,046  (75.8%)
```

### 实际收敛结果(vanilla 全量实测)

| 阶段 | unknown-key | 说明 |
|---|---:|---|
| 降噪前 | **95,043** | 起点 |
| W1(D1+D2) | 88,646 | −6,397,且**修好一处漏判**(混合块内真错恢复检出) |
| W3-1(D4) | 63,132 | −25,514。天气 8 键 29,174 → **0** |
| W3-2(D3) | 79,827 | ⚠ **反而上升** —— 见下 |

**★ 必须讲清的一点:D3 修完后总量上升,不是退步。**

`oob` 的 struct 生效后,`history/units` 从"整棵子树无字段表"变成"有字段表但字段表不全",于是暴露出**下一层**缺口(`location` 5,074 / `start_experience_factor` 4,500 / `division_name` 3,773…)。噪音是**逐层下钻式暴露**。

这是好事:修关联之后引擎才**第一次真的在检查**这批文件。但也意味着总量不是单调下降的指标,不能拿它当唯一判据。

### 关于「<1500」这个目标:实测不成立,须修正

剩余 79,827 条噪音分布在 **2,797 个不同键**上,Top 20 键仅占 61.5%:

```
按目录: history/units 32,260 · national_focus 9,863 · ai_strategy 8,111
        country_leader 7,932 · strategicregions 3,658 · common/units 3,390
按键:   location 5,074 · start_experience_factor 4,500 · hours 4,076
        division_name 3,773 · is_name_ordered 3,773 · name_order 3,694 …
```

**收敛到 1,500 需补 40+ 组 `.cwt` 规则**,每组都要 grep 磁盘核对键集再实测。已完成的 D1–D5 之所以高效,是因为它们各自只消掉**一个**根因(一次规则改动消掉全场重复)。

**修正后的建议判据**

| 阶段 | 判据 | 状态 |
|---|---|---|
| 本次已达 | **四个根因各自归零 + 真错检出能力不降**(可证明的改进) | 10/12 断言通过 |
| 中期 | 按「每目录 Top-N 键」分组补规则,每组消 3,000–30,000 条 | 预计 8–12 组可降到 5,000 以内 |
| 长期 | 2,797 个长尾键里有一部分引擎无法判定(需完整 alias 索引) | `<1,500` 不宜作为承诺 |

> 判据必须来自实测(项目铁律 #3)。上游的「<500」和本计划原写的「<1500」都是拍脑袋的—— 实测 B 类长尾有 2,797 个不同键,达不到。

---

## 一、阶段划分与依赖

```
P0-1  降噪（3 个引擎缺陷 + 4 组规则）      ← 本次执行
      ├─ W1  D1+D2 作用域切换判定修正     零规则改动，纯代码
      ├─ W2  D3 实体容器识别
      └─ W3  补 4 组 struct 规则
P0-2  接入 /api/check                      ← 依赖 P0-1 通过判据
P0-3  scope 上下文校验                    ← 可与 P0-2 并行（独立文件）
P1*   LSP / loc / default.map / 事件树     ← 待 P0 落地后按实际痛点排期
```

**每个 W 独立可交付、独立可回滚**，不合并提交。任一阶段判据不达标就停，不带着噪音往下走。

---

## 二、P0-1　降噪（本次执行主体）

### W1　作用域切换判定修正（D1 + D2）

**改动文件**：`packages/engine/src/cwt-check.ts`（唯一文件）

**W1-a｜D1：补全切换键集**（1 行）
```
L838-844  SCOPE_SWITCH_KEYS 增加 'ELSE'、'ELSE_IF'
```
- 依据：vanilla 中 `ELSE` 643 次、`ELSE_IF` 695 次，全部是脚本语言关键字，不是字段
- 风险：无。`ELSE`/`ELSE_IF` 不可能是任何 struct 的合法字段名

**W1-b｜D2：混合块判定放宽**（改 `L1030-1033`）
```ts
// 现状：every() —— 混合块不触发，整块被按普通结构校验
const isScopeSwitch = blk.entries.length > 0 && blk.entries.every(...)

// 改为：分离「需跳过的切换键」与「需校验的普通键」
const switchEntries = blk.entries.filter(e => {
  const k = keyText(doc, e)
  return k !== undefined && (SCOPE_SWITCH_KEYS.has(k) || SCOPE_SWITCH_KEYS.has(k.toUpperCase()))
})
```
然后在主循环里：对 `switchEntries` 跳过 `unknown-key` 报出（其余校验照旧），普通键仍查 `allowed`。

- **风险（必须在实施时守住）**：`IF` 内部**可以**嵌套真实字段（`IF = { has_war = yes }`），不能整块跳过。做法是**按条目粒度**跳过，不是按块粒度。
- 回归判据：`national_focus/japan.txt` 的 `IF` 相关噪音（1,823 条）应归零；但 `IF` 块内的真错仍须能报出——用探针验证

**验收判据**
1. `node --experimental-strip-types --check cwt-check.ts` 通过
2. vanilla 全量 `unknown-key` 减少 ≥ 3,900 条（IF/ELSE/ELSE_IF/FROM 的直接命中）
3. **`packages/engine/test/cwt-perf.test.ts` 原有断言全绿**（这是引擎的既有护栏，不许改判据迁就实现）
4. 探针：在国策块里故意写 `IF = { bogus_key_qqq = 1 }`，须报出（证明没整块跳过）

---

### W2　D3：实体容器识别

**改动文件**：`packages/engine/src/cwt-check.ts`

**问题**：`equipment = { destroyer_1 = { amount = 1 } }`、`ship = { name = "X" }` 这类**嵌套实体容器**的内层键名（`destroyer_1`、`ship_hull_light_1`、`submarine_1`）是实体标识符，规则库无法穷举，靠查表补规则是死路。

**做法（按可靠性递进）**

1. **先做零风险的抑制**：`value === undefined` 且父键属于已知容器键（`equipment`/`ship`/`unit`/`add_equipment`…）→ 归类为「实体名」，**不报 `unknown-key`**
   - 依据：实测 `value === undefined` 精确对应这一类（22,997 条，Top 键全是舰船/装备型号名）
2. **正确的做法（本次不做，留 P1）**：在 `.cwt` 里为这类容器声明「实体名来自 `equipment`/`technology` 索引」，让引擎能在索引里查到合法实体名——这需要先有装备/科技索引，属于 P0-3 范畴

**风险**：`value === undefined` 也可能是**真的漏写值**（`stability = ` 空值）。区分办法：空值时 `valueText` 返回 `''` 而非 `undefined`，`undefined` 只在「键后紧跟 `}` 或 `{`」时出现——实施时必须实测确认这个指纹，不许凭推断。

**验收判据**
1. `history/units`（15,565 条）与 `common/units`（3,388 条）中 `value===undefined` 的条目归零
2. `type`/`value`/`id` 这类真键（`ai_strategy` 里 2,686/2,545/2,280 条）**仍被报出**（证明没误伤）

---

### W3　补 `.cwt` 规则（4 组，按噪音/收益排序）

纯规则文本改动，**零代码**。每组都是「补一个 struct 定义」。

| # | 目标 | 规则文件 | 消掉 | 键集（实测全集） |
|---|---|---|---|---|
| W3-1 | `strategic_region.weather` | 新建 `map_weather.cwt` | **29,172** | `period` `between` `temperature` `no_phenomenon` `rain_light` `rain_heavy` `snow` `blizzard` `arctic_water` `mud` `sandstorm` `min_snow_level`（12 键，目录内去重仅 19 键） |
| W3-2 | `unit` / `ship` 的 `name_order` 系 | `units.cwt` | **~7,400** | `is_name_ordered` `name_order` `creator` `version_name` |
| W3-3 | 时间字段 | `effects.cwt` | **~3,700** | `hours` `days` `random_hours` `random_days`（已有 `days` 声明但挂在别的 struct 下，需挂到 `weather.period`） |
| W3-4 | P0-1b 补漏（上游已知） | 各 | — | `icon` `prerequisite` `available` `immediate` `option`。`cwt-perf.test.ts:280-292` 已归因：**111 个 `.cwt` 里既无 alias 也无对应 struct 定义**，属规则库工作（该测试注释明确写「不是引擎 bug」）。注意 `struct.focus` 根本不存在，须先建 focus struct 才能判 |

**W3-1 关键说明**：这 29,172 条是 **3,648 = 8 键 × 304 文件 × 1.5 周期**。同一处规则缺失在 304 个文件上重复报——**单条规则消掉全场噪音**，是整个降噪里最高杠杆的一笔。

**验证纪律（项目铁律 #1）**：每补一组规则，**先 grep 磁盘确认键真实存在**再写规则。已确认 `rain_light` 出现在 `map/strategicregions/*.txt` 与 `common/modifiers/00_static_modifiers.txt`。

**验收判据**（分组合计统计，每组单独测）
```
strategic_region 目录 unknown-key : 29,172 → 0
history/units 中 is_name_ordered/name_order : 7,467 → 0
```

---

### W0（前置）：建立噪音基线台账

**这是 W1-W3 的前提**，不可跳过。

新建 `packages/gui/test/cwt-noise.test.cjs`，固化当前基线并锁定判据：

```js
// 断言 1：噪音总量上限（防回归）
assert(uk_total < 1500, `unknown-key 未收敛: ${uk_total}`)
// 断言 2：三个引擎缺陷不复发（精确定位，非总量）
assert(uk.filter(d => ['ELSE','ELSE_IF'].includes(d.key)).length === 0)
// 断言 3：真错仍能报出（防"过度抑制"）
//   在探针目录植入 bogus_key_qqq + scope 违规，必须报出
```

**为什么必须先建**：没有基线就无法证明降噪有效，也无法防止后续改动把噪音放回来。**这是把"判据阈值先看真实数据再定"落成可执行资产。**

---

## 三、P0-2　接入 `/api/check`（W1-W3 通过后执行）

**改动文件**：`packages/gui/src/server.ts`

**接入方式**：复用现成的 `ensureCheck()`（`L1432`）机制——它已有 `runHeavy` 异步、世代号、快照、重置逻辑，设计是精细的，不要另起炉灶。

```
L1432  ensureCheck() 内 runHeavy 回调里：
       现有：validateRoots(rootsSnap, {...}) → rep
       新增：checkWithRules(rootsSnap, { gameRoot, ... }) → rulesRep
       合并：{ ...rep, rules: summarize(rulesRep) }
```

**关键约束**

1. **世代号机制必须复用**：`L1438` 的 `const myGen = ++CHECK_GEN` 与 `L1459/1475/1485/1491` 的作废逻辑对两个引擎同时生效，不要写第二套
2. **`resetIndexCache()` 必须在 ROOTS 变更时调用**（`cwt-check.ts:907`）——否则拿旧来源的 sprite/loc 键去判新模组，**静默假阴性**。这是 `validate.ts:307-310` 已有的教训，必须同步到 cwt 侧
3. **摘要层必须做**：`checkWithRules` 单次 8.3-16.8s、97,606 条原始诊断，直接下发会撑爆前端。需实现三层收敛：
   - `error`/`warning` 全量下发（`undefined-ref` 45 / `bad-enum` 1,429 / `value-type` 754 / `cardinality` 335 —— 合计仅 2,563 条，**这是用户真正要看的**）
   - `info`（`unknown-key`）**只下发按键聚合**：按 `键名 → 出现次数 + 3 个样本位置`。实测 A 类 22,997 条只对应 1,356 个不同键
   - 折叠展示：点开才加载明细
4. **耗时**：8.3s（探针根）~16.8s（vanilla 全量）须走 `busy/progress` 轮询，不可阻塞事件循环

**验收判据**
1. GUI 体检页显示 `rules` 分区，`error`+`warning` 计数与命令行一致
2. 切模组后重跑，命中率缓存 < 1.5s（对齐 `validate.ts` 的两级缓存思路）
3. 探针：故意写错的 3 类问题（unknown key / STATE-only effect / 悬空 loc）**在页面上可见**
4. 全量回归：`smoke_e2e` + `gen-stats` + `detail-blocks` + `aibehave` + `detail-icon` 全绿

---

## 四、P0-3　scope 上下文校验（独立文件，可并行）

**改动文件**：新建 `packages/engine/src/scopes.ts`

**数据基础**（实测）：`cwt/script_documentation.json` 13 种作用域；**502/553 effects 是单 scope（可硬判）**，多 scope 仅 42

```
effects  总553 | 无scope 9 | 单scope 502 | 多scope 42
triggers 总598 | 无scope 6 | 单scope 565 | 多scope 27
scope 种类: COUNTRY STATE any CHARACTER SPECIAL_PROJECT RAID_INSTANCE
           STRATEGIC_REGION OPERATION INDUSTRIAL_ORG PURCHASE_CONTRACT
           COMBATANT ACE FACTION
```

**步骤**
1. 建 `Map<键名, Set<作用域>>`，与 `cwt.ts` 的 `scopes` 表合并
2. 接线：`.cwt` 已解析但**从未使用**的 `push_scope`/`replace_scope` 指令——`cwt.ts:1097-1130` 解析了，`cwt-check.ts:1465` 的 `directiveScopes` 只消费了 `scope`/`severity`。**数据已在仓库，零采集成本**
3. 借作用域栈解掉 `cwt-check.ts:1049` 那句「判不准就整块跳过键校验」

**硬约束（降噪）**：`cwt-check.ts:845-852` 自述「近似带来的是漏判而非误判」。因此**只对单 scope 的 502 个 effect 硬判**，多 scope 的 42 个降级为提示。这是防误报的设计前提，不能为了覆盖率牺牲准确率。

**验收判据**
1. 国策块（COUNTRY 作用域）内写 `add_province_modifier`（STATE-only）**必须报出**
2. KR 全量 `scope-violation` **≤ 50 条**——超过说明作用域基线没建对，不是规则不够

---

## 五、本次执行范围（请确认）

**我建议本轮只做 P0-1（含 W0），不做 P0-2 接入。**

理由：P0-1 的三个缺陷是我刚实测定位的，判据明确、可独立验证、改动集中在 1 个文件 + 规则文本。接进 `/api/check` 是**面向用户的改动**，应该在噪音收敛到 <1,500、终端输出干净之后再做——否则一旦接入就有大量"接错了"的排查噪音。

| 阶段 | 内容 | 状态 |
|---|---|---|
| **W0** | 噪音基线测试 `cwt-noise.test.cjs` | 待执行 |
| **W1** | D1 `ELSE`/`ELSE_IF` + D2 混合块（1 文件） | 待执行 |
| **W2** | D3 实体名识别（1 文件） | 待执行 |
| **W3** | 4 组 `.cwt` 规则 | 待执行 |
| P0-2 | 接入 `/api/check` | 待 W0-W3 通过 |
| P0-3 | scope 校验 | 可并行，待 P0-2 之后收尾 |

---

## 六、每阶段的回滚

无 git 仓库（`toolkit/` 只有 `.gitignore`），所以**每阶段开工前先备份改动文件**：

```
W0  新建文件 → 删掉即回滚
W1/W2  单文件 → 预先 cp 到 _exec_backup_20261006/W{1,2}/，回滚即覆盖
W3  规则文本 → 同上，按 .cwt 文件逐个备份
```

**验证纪律（沿用项目铁律 #4）**：每阶段收尾必做 ①`node --check` ②跑 `cwt-perf.test.ts` + 新增 `cwt-noise.test.cjs` ③真浏览器查 `window.X` 真挂上。**HTTP 200 + 语法绿 ≠ 功能在。**
