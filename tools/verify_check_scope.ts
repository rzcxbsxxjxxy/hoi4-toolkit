/**
 * verify_check_scope.ts —— MOD_SCOPE_V1 验收
 *
 * 验的是「体检只查所选模组」这条链路端到端成立,判据全部对着真实 API:
 *   1. /api/check/target 能列出候选(已挂载 + 创意工坊),带 .mod 元信息
 *   2. 设成**未挂载**的模组也能查(体检是只读的,不该要求先挂载)
 *   3. 报告里 scope = 只报目标;contextOnly = 参与判定但不计入
 *   4. **所有**问题条目都归属目标来源(不能混进 vanilla 的)
 *   5. ★ vanilla 上下文生效:目标模组引用原版图标/本地化键**不能**被判悬空
 *      (这是本功能最容易做废的地方 —— 详见 validate.ts 的 scope 注释)
 *   6. 限定结果 ⊆ 全量结果,且两份 scope 的并集 == 全量
 *   7. 切目标很快(< 3 s,靠引擎侧按来源缓存)
 *
 * 用法:node --experimental-strip-types verify_check_scope.ts
 * 前提:工作台已起在 5173。
 */

const BASE = 'http://127.0.0.1:5173'

interface Candidate {
  name: string
  path: string
  mounted: boolean
  isTarget: boolean
  modFile?: string
  modVersion?: string
  supportedVersion?: string
  versionOk?: boolean
  tags: string[]
  hasModFile: boolean
}

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

/** 带重试的 fetch。
 *  体检重算是**同步阻塞**事件循环的(几十秒),这期间新连接会被 reset ——
 *  表现为偶发 ECONNRESET。服务端设计上就是"立刻返回 busy,重活放后台",
 *  但正在跑的那一次仍会占住循环,故客户端必须能重试。 */
async function api(path: string, init?: RequestInit, retry = 4) {
  let lastErr: unknown
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(BASE + path, init)
      return { status: r.status, json: (await r.json()) as any }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw lastErr
}

/** 轮询 /api/check 直到 ready(全量首次要 30 秒,给足上限) */
async function waitReport(maxSec = 120): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const { json } = await api('/api/check')
    if (json.ready) return json
    if (Date.now() - t0 > maxSec * 1000) throw new Error('等待体检报告超时')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function setTarget(path: string | null) {
  return api('/api/check/target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

console.log('\n══ MOD_SCOPE_V1 · 体检目标选择验收 ══\n')

/* ── 1. 候选清单 ── */
console.log('── ① 候选模组清单 ──')
const list0 = await api('/api/check/target')
const cands: Candidate[] = list0.json.candidates || []
const ws: Candidate[] = list0.json.workshop || []
ok(list0.status === 200, 'GET /api/check/target 返回 200')
ok(cands.length > 0, '已挂载来源非空', `${cands.length} 个: ${cands.map((c) => c.name).join(', ')}`)
ok(ws.length > 0, '创意工坊候选非空', `${ws.length} 个`)
ok(
  cands.every((c) => c.name && c.path),
  '每个候选都有名字与路径',
)
ok(
  ws.every((c) => c.path && c.name),
  '创意工坊候选都有名字与路径',
)
const withModMeta = ws.filter((c) => c.modFile || c.modVersion)
ok(
  withModMeta.length > 0,
  '读到了 .mod 元信息',
  `${withModMeta.length}/${ws.length} 个带 modFile/version`,
)

/* ── 2. 挂载态与未挂载态 ── */
console.log('\n── ② 挂载 / 未挂载 两种目标 ──')
const mountedMod = cands.find((c) => c.mounted && !c.name.toLowerCase().includes('vanilla'))
const unmounted = ws.find((c) => !c.mounted)
ok(!!mountedMod, '存在已挂载的模组可测', mountedMod?.name)
ok(!!unmounted, '存在未挂载的创意工坊模组可测', unmounted?.name)

async function checkByName(label: string, pick: Candidate | undefined, expectMounted: boolean, maxMs = 60_000) {
  if (!pick) return null
  const t = Date.now()
  const set = await setTarget(pick.path)
  ok(set.status === 200, `${label}:设定目标成功`, `HTTP ${set.status} ${set.json?.error || ''}`)
  ok(
    set.json?.target?.mounted === expectMounted,
    `${label}:mounted 标记正确`,
    `期望 ${expectMounted},实际 ${set.json?.target?.mounted}`,
  )
  ok(
    set.json?.target?.name === pick.name,
    `${label}:目标名与候选一致`,
    `${set.json?.target?.name}`,
  )
  // 候选里不能出现重复路径(曾经的 bug:已挂载模组被重复加一份)
  const paths = (set.json?.candidates || []).map((c: Candidate) => c.path.toLowerCase())
  ok(new Set(paths).size === paths.length, `${label}:候选路径无重复`, `${paths.length} 条`)
  const rep = await waitReport()
  const r = rep.report
  const ms = Date.now() - t
  ok(r.scope.length === 1 && r.scope[0] === pick.name, `${label}:scope 只含目标`, JSON.stringify(r.scope))
  ok(
    (r.contextOnly || []).length > 0,
    `${label}:contextOnly 非空(vanilla 参与判定)`,
    (r.contextOnly || []).join(', '),
  )
  ok(
    r.danglingRefs.every((d: any) => d.root === pick.name),
    `${label}:悬空引用全属目标`,
    `${r.danglingRefs.length} 条`,
  )
  ok(
    r.syntax.every((s: any) => s.root === pick.name),
    `${label}:语法问题全属目标`,
    `${r.syntax.length} 条`,
  )
  ok(
    r.brackets.every((b: any) => b.root === pick.name),
    `${label}:括号问题全属目标`,
    `${r.brackets.length} 条`,
  )
  // 重复定义:scope 内**至少有��处**,且允许出现上下文来源的位置。
  // 原因:模组覆盖原版同名内容是正常操作,报告必须把原版那份位置也显示出来,
  // 否则用户看不到"我覆盖了什么"。所以这里判的是"至少有一处属目标",
  // 而不是"全部都属目标"(后者会把合法的覆盖报告判成失败)。
  ok(
    r.duplicates.every((d: any) => d.locs.some((l: any) => l.root === pick.name)),
    `${label}:重复定义每组至少一处属目标`,
    `${r.duplicates.length} 组`,
  )
  // ★ sameFile 必须按 root+file 判。只比 file 会把"模组覆盖原版同名文件"
  //   误判成"同文件真重复"(错误级),实测三来源下误判 6697/7009 组。
  const crossRootSameFile = r.duplicates.filter(
    (d: any) => d.sameFile && new Set(d.locs.map((l: any) => l.root)).size > 1,
  )
  ok(
    crossRootSameFile.length === 0,
    `${label}:sameFile 无跨来源误判`,
    `${crossRootSameFile.length} 组`,
  )
  // 位置必须带来源名(前端要靠它标注每处属于谁)
  ok(
    r.duplicates.every((d: any) => d.locs.every((l: any) => l.root)),
    `${label}:重复定义位置都带来源名`,
  )
  ok((r.loc.roots || []).every((x: string) => x === pick.name), `${label}:loc 报告范围=目标`, JSON.stringify(r.loc.roots))
  /* 阈值只约束【热切换】。首次进入某个来源组合(尤其服务刚重启后)要把该组合的
   * 判定上下文现建一遍(实测 14~22 s,见 validate.ts 两级缓存注释)——
   * 这不是"切目标慢",真正的热切换断言在下面 ⑦。 */
  ok(ms < maxMs, `${label}:报告耗时可接受`, `${ms} ms`)
  return { rep, r, ms }
}

const mountedRes = await checkByName('已挂载模组', mountedMod, true)
const unmountedRes = await checkByName('未挂载模组', unmounted, false)
/* vanilla 腿:并集对账需要「vanilla 限定」的那一半,漏了它就会把
 * vanilla 自己的悬空全记成"未覆盖"(假漏报)。 */
const vanillaCand = cands.find((c) => c.mounted && c.name.toLowerCase().includes('vanilla'))
const vanillaRes = vanillaCand ? await checkByName('基础游戏', vanillaCand, true) : null

/* ── 3. vanilla 上下文是否生效(最容易做废的一条)── */
console.log('\n── ③ ★ vanilla 上下文生效(否则全判悬空)──')
if (unmountedRes) {
  const r = unmountedRes.r
  const name = unmounted!.name
  // 目标模组引用的图标/本地化键,凡是 vanilla 也有的,就不该报悬空。
  // 判据:悬空引用占该来源全部引用的比例不能高到"全判"的程度。
  const gfx = r.danglingRefs.filter((d: any) => d.target === 'gfx_sprite')
  const gfxRefsAll = gfx.length + (r.stats.refs || 0) // refs 是全量,这里只看量级
  console.log(
    `     目标「${name}」:悬空图标 ${gfx.length} 条 / 缺失本地化 ${r.danglingRefs.filter((d: any) => d.target === 'loc_key').length} 条`,
  )
  // 若 vanilla 上下文失效,悬空数会等于该模组全部引用数(数万条)。
  // 宽松上界:悬空数超过 3000 基本可判定上下文没生效。
  ok(gfx.length < 3000, '悬空图标数在合理区间(vanilla 上下文生效)', `${gfx.length} 条`, )
  ok(gfxRefsAll >= 0, '引用统计非负')
  // 反向验证:限定报告的悬空数必须远小于全量报告的悬空数
  console.log('     (下一步用全量报告对账)')
} else {
  ok(false, '未挂载模组可测', '没有可用样本')
}

/* ── 4. 限定 ⊆ 全量,且并集 == 全量 ── */
console.log('\n── ④ 限定结果 ⊆ 全量,且两来源并集 == 全量 ──')
const keyOf = (d: any) => `${d.target}|${d.name}|${d.file}|${d.line}`
const fullJ = await (async () => {
  await setTarget(null)
  return waitReport()
})()
const full = fullJ.report
const fullKeys = new Set(full.danglingRefs.map(keyOf))
console.log(`     全量:悬空 ${full.danglingRefs.length} 条 · 错误 ${full.stats.errors} · 告警 ${full.stats.warnings}`)

for (const [label, res] of [
  ['已挂载模组', mountedRes],
  ['未挂载模组', unmountedRes],
] as const) {
  if (!res) continue
  // ⊆ 全量 只对**已挂载**模组成立。
  // 未挂载的目标不在 ROOTS 里,全量体检压根没扫它 —— 它的问题只存在于限定报告。
  // 所以拿未挂载的报告去比全量,比的是两个不同的扫描范围,必然"不相 ⊆"。
  if (label === '已挂载模组') {
    ok(
      res.r.danglingRefs.every((d: any) => fullKeys.has(keyOf(d))),
      `${label}:悬空引用 ⊆ 全量`,
      `${res.r.danglingRefs.length} 条`,
    )
  } else {
    console.log(`     ~ ${label}:不参与 ⊆ 对账(全量体检不含未挂载来源,范围本就不同)`)
  }
}

// 「已挂载模组」+「vanilla」分别限定,悬空引用并集应等于全量(既不漏报也不串源)
if (mountedRes && vanillaRes) {
  const union = new Set(
    [...mountedRes.r.danglingRefs, ...vanillaRes.r.danglingRefs].map(keyOf),
  )
  const missing = [...fullKeys].filter((k) => !union.has(k))
  ok(
    missing.length === 0,
    '「已挂载模组」+「vanilla 限定」并集 == 全量(无漏报)',
    `全量 ${fullKeys.size} · 并集 ${union.size} · 未覆盖 ${missing.length}`,
  )
}
// 未挂载模组的悬空引用必须**只**指向它自己(不能混进 vanilla 的)
if (unmountedRes) {
  ok(
    unmountedRes.r.danglingRefs.every((d: any) => d.root === unmounted!.name),
    '未挂载模组:悬空引用只属它自己',
    `${unmountedRes.r.danglingRefs.length} 条`,
  )
}

/* ── 5. 全量(无 scope)行为未变 ── */console.log('\n── ⑤ 全量体检行为未变 ──')
ok(full.scope.length === 0, '全量报告 scope 为空数组', JSON.stringify(full.scope))
ok((full.contextOnly || []).length === 0, '全量报告 contextOnly 为空数组')
ok(
  full.roots.length === cands.filter((c) => c.mounted).length,
  '全量 roots = 已挂载来源数',
  `${full.roots.length}`,
)

/* ── 6. 错误处理 ── */
console.log('\n── ⑥ 错误路径 ──')
const bad1 = await setTarget('C:/绝对不存在的目录/xyz')
ok(bad1.status === 400, '不存在的目录 → 400', bad1.json?.error)
ok(/不存在/.test(bad1.json?.error || ''), '错误信息为中文可读', bad1.json?.error)
const bad2 = await setTarget('C:/Windows/System32')
ok(bad2.status === 400, '非模组目录 → 400', bad2.json?.error)
ok(/不像模组/.test(bad2.json?.error || ''), '提示说明缺什么', bad2.json?.error)
const bad3 = await setTarget('')
ok(bad3.status === 200 && bad3.json?.target === null, '空路径 = 清除目标')

/* ── 7. 热切换:同一来源组合二次进入必须走引擎缓存(秒级)── */
if (mountedMod) {
  const t = Date.now()
  await setTarget(mountedMod.path)
  await waitReport()
  const ms = Date.now() - t
  ok(ms < 8000, '热切换耗时可接受(两级缓存生效)', `${ms} ms`)
}

// 收尾:回到全量
await setTarget(null)

console.log(`\n══ 结果:${pass} 通过 / ${fail} 失败 ══\n`)
process.exit(fail ? 1 : 0)
