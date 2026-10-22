/**
 * AIDE_V1 验收:写盘安全边界 + 密钥不泄漏
 *
 * 跑法(三件套,按顺序):
 *   # 1) 工作台(任意端口,P 环境变量指定,默认 5199)
 *   node --experimental-strip-types packages/gui/src/server.ts --port 5199
 *   # 2) mock 上游(替代真 provider,免 key 免联网)
 *   node --experimental-strip-types packages/gui/test/ai-mock-upstream.ts 5299
 *   # 3) 本脚本
 *   node --experimental-strip-types packages/gui/test/ai-security.test.ts
 *
 * ★ 脚本会**临时**把 provider 指到 mock 上游,跑完**原样还原**。
 *   不还原的话会把你自己的 API 配置覆盖掉。
 *   还原失败会在末尾明确告警。
 *
 * ★ 刻意**不改来源列表**(那需要重启服务),安全判据全部用
 *   「当前已在挂载的来源」就能验完。
 *
 * 判据:
 *  1. makeDiff 基本行为(有差异/无差异/新建无幽灵行)
 *  2. redactKey 不泄露中段
 *  3. 默认配置**不允许**写文件
 *  4. preview 存取
 *  5. 配置回读不含 key 明文,且带打码预览
 *  6. provider 目录完整下发
 *  7. 只读来源(vanilla)写入被拒 + 磁盘未变
 *  8. 路径越界写入被拒 + 磁盘未变
 *  9. 不存在的 previewId → 404
 * 10. allowWrite 开关往返生效
 * 11. SSE 事件类型齐备(有 delta/tool_result/done,无 error)
 * 12. 未知子路由 404 + /ai.js 可访问且 MIME 正确
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getPreview, putPreview, makeDiff, redactKey, AI_PROVIDERS, defaultAiConfig } from '../src/ai.ts'

const PORT = process.env.PORT_GUI || '5199'
const BASE = `http://127.0.0.1:${PORT}`
/** mock 上游端口,与 ai-mock-upstream.ts 默认一致 */
const MOCK_PORT = process.env.PORT_MOCK || '5299'

let pass = 0
let fail = 0
const ok = (b: unknown, what: string, extra = '') => {
  if (b) { pass++; console.log(`  ✓ ${what}`) }
  else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) }
}
const line = (s = '') => console.log(s)

const OLD = 'focus_tree = {\n\tid = original_id\n}\n'
const NEW = 'focus_tree = {\n\tid = ai_generated_id\n\tcountry = { factor = 1 }\n}\n'

line('══════════ 1. 纯函数层 ══════════')
{
  const d = makeDiff(OLD, NEW, 'common/national_focus/zz.txt')
  ok(d.includes('-') && d.includes('+'), 'makeDiff 能出差异')
  /* ⚠ 判据不能写成 `!diff.includes('+')` —— diff 头 `+++ b/xxx` 本身就含 `+`。
   *   要看的是「有没有以 + 开头的内容行」。*/
  const plusLines = (s: string) => s.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
  const minusLines = (s: string) => s.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length
  ok(plusLines(makeDiff(OLD, OLD, 'x')) === 0 && minusLines(makeDiff(OLD, OLD, 'x')) === 0, '无变化时不出增删行')
  ok(plusLines(d) > 0 && minusLines(d) > 0, '有变化时增删行都存在')
  ok(minusLines(makeDiff('', 'hello\nworld', 'new.txt')) === 0, '新建文件不产生幽灵 - 行')
  putPreview({ id: 'unit_test_1', rootIdx: 99, rootName: 't', file: 'a.txt', before: OLD, after: NEW, diff: d, bytes: NEW.length })
  ok(getPreview('unit_test_1')?.file === 'a.txt', 'preview 存取正常')
  ok(redactKey('sk-abcdefghijklmnop').includes('*'), 'redactKey 会打码')
  ok(!redactKey('sk-abcdefghijklmnop').includes('efghijklm'), '★ redactKey 不泄露中段')
  ok(AI_PROVIDERS.length >= 8, `provider 目录 ${AI_PROVIDERS.length} 个`)
  ok(defaultAiConfig().allowWrite === false, '默认**不允许**写文件(安全默认)')
}

line('\n══════════ 2. 配置接口 ══════════')
const cfg = await fetch(`${BASE}/api/ai/config`).then((r) => r.json())
ok(!!cfg.providers && cfg.providers.length >= 8, `provider 目录已下发(${cfg.providers?.length} 个)`)
/* ★ 关键安全判据:整份响应里既没有 apiKey 字段,也不含任何 key 明文。
   注意不能用「不含 'mock-key'」这种字面量判据 —— 用户真 key 前缀千变万化,
   要按「结构 + 形态」判:字段不存在,且值里没有长串密钥特征。*/
ok(!('apiKey' in (cfg.config ?? {})), '★ 配置回读不含 apiKey 字段')
ok(!/[A-Za-z0-9_-]{24,}/.test((cfg.config?.baseUrl ?? '') + (cfg.keyPreview ?? '')), '★ 配置回读无长串密钥形态')
ok(!cfg.config?.apiKey, '★ config 对象里没有 apiKey 属性')
ok('hasKey' in cfg && 'keySource' in cfg, 'hasKey / keySource 字段齐备')

line('\n══════════ 3. 写盘安全边界 ══════════')
{
  /* ★ 游戏路径必须从 /api/sources 动态取,不能写死本机绝对路径
   *   (GitHub 可移植性铁律)。取第一个只读来源即可。*/
  const srcJ = await fetch(`${BASE}/api/sources`).then((r) => r.json()).catch(() => null)
  const readOnly = srcJ?.sources?.find((s: { writable?: boolean }) => !s.writable)
  ok(!!readOnly, '找到只读来源', JSON.stringify(srcJ?.sources?.[0] ?? {}).slice(0, 80))
  const probeRel = 'common/__aide_probe_should_not_exist.txt'
  const probeAbs = readOnly ? join(readOnly.path, probeRel) : ''
  ok(!probeAbs || !existsSync(probeAbs), '前置:只读来源里确实没有该探针文件')

  /* 7) 只读来源写入 */
  putPreview({ id: 'ro_probe', rootIdx: 0, rootName: readOnly?.name ?? 'ro', file: probeRel, before: null, after: 'x', diff: 'x', bytes: 1 })
  const r1 = await fetch(`${BASE}/api/ai/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ro_probe' }) })
  const j1 = await r1.json()
  ok(r1.status === 403 || !!j1.error, '只读来源写入被拒', JSON.stringify(j1))
  ok(!probeAbs || !existsSync(probeAbs), '★ 只读来源磁盘未被改动')

  /* 8) 路径越界 */
  putPreview({ id: 'esc_probe', rootIdx: 0, rootName: readOnly?.name ?? 'ro', file: '../../../__aide_escape.txt', before: null, after: 'x', diff: 'x', bytes: 1 })
  const r2 = await fetch(`${BASE}/api/ai/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'esc_probe' }) })
  const j2 = await r2.json()
  ok(r2.status === 400 || !!j2.error, '路径越界写入被拒', JSON.stringify(j2))
  /* 越界目标是「来源目录的父目录」,按相对关系判,不写死盘符 */
  const escOutside = readOnly?.path ? readOnly.path.replace(/[\\/]+$/, '') + '/../../__aide_escape.txt' : ''
  ok(!escOutside || !existsSync(escOutside), '★ 越界目标未落盘')
}

line('\n══════════ 4. 预览与应用往返 ══════════')
{
  const r = await fetch(`${BASE}/api/ai/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'definitely_missing_id' }) })
  const j = await r.json()
  ok(r.status === 404 && !!j.error, '不存在的 previewId → 404')
}

line('\n══════════ 5. 写权限开关往返 ══════════')
{
  const before = (await fetch(`${BASE}/api/ai/config`).then((r) => r.json())).config.allowWrite
  await fetch(`${BASE}/api/ai/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowWrite: !before }) })
  const mid = (await fetch(`${BASE}/api/ai/config`).then((r) => r.json())).config.allowWrite
  ok(mid === !before, `allowWrite 可切换(${before} → ${mid})`)
  await fetch(`${BASE}/api/ai/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowWrite: before }) })
  const back = (await fetch(`${BASE}/api/ai/config`).then((r) => r.json())).config.allowWrite
  ok(back === before, 'allowWrite 可还原')
}

line('\n══════════ 6. SSE 事件齐备(临时指到 mock 上游)══════════')
{
  /* ★ 自举:SSE 判据需要一个「有 key 且端点可达」的 provider。
   *   这里临时把配置指向 mock,跑完在末尾原样还原 ——
   *   否则会覆盖用户自己的 API 配置。*/
  const saved = (await fetch(`${BASE}/api/ai/config`).then((r) => r.json())).config ?? {}
  await fetch(`${BASE}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      model: 'mock-model-a',
      apiKey: 'mock-key-selftest',
    }),
  })

  const text = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
  }).then((r) => r.text())
  ok(text.includes('"type":"delta"'), '有 delta 事件(流式正文)', text.slice(0, 120))
  ok(text.includes('"type":"tool_result"'), '有 tool_result 事件(工具执行)', text.slice(0, 200))
  ok(text.includes('"type":"done"'), '有 done 事件')
  ok((text.match(/"type":"done"/g) || []).length === 1, '★ done 只发一次(幂等)')
  ok(!text.includes('"type":"error"'), '无 error 事件', (/"type":"error"[^}]*/.exec(text)?.[0] ?? ''))
  const call = /"name":"([a-z_]+)","args"/.exec(text)
  ok(!!call, `工具名解析:${call?.[1] ?? '(未解析)'}`)

  /* ── 还原配置 ── */
  const restore = async (): Promise<boolean> => {
    try {
      await fetch(`${BASE}/api/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* ★ 必须 clearKey:否则 mock 的假 key 会留在用户配置里 */
        body: JSON.stringify({ ...saved, clearKey: true }),
      })
      const now = (await fetch(`${BASE}/api/ai/config`).then((r) => r.json())).config ?? {}
      return now.provider === saved.provider
    } catch {
      return false
    }
  }
  const restored = await restore()
  ok(restored, '★ 已还原原有 AI 配置', `原 provider=${saved.provider}`)
}

line('\n══════════ 7. 路由完整性 ══════════')
{
  const r = await fetch(`${BASE}/api/ai/nope`)
  ok(r.status === 404, '未知 /api/ai/* → 404')
  const js = await fetch(`${BASE}/ai.js`)
  const body = await js.text()
  ok(js.status === 200 && body.includes('window.AI'), '★ /ai.js 可访问且挂上 window.AI')
  ok((js.headers.get('content-type') || '').includes('javascript'), 'ai.js MIME 正确(否则浏览器拒绝执行)')
}

line(`\n判据:${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
