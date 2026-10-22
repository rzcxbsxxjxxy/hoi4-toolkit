/**
 * 学说页前端逻辑验收 —— DOCTRINE_UI_VERIFY_V1
 *
 * 用户报了两个问题,这里用真实 API 数据把前端逻辑跑一遍来判定:
 *   ① 「很多素材图需要加载」→ 图标接口是否对得上
 *   ② 「无法查看其他次要学说」→ 默认可见的次要学说数量
 *
 * 做法:不引入浏览器,而是把 doctrines.js 里与"显示数量 / 名称解析 / 图标引用"
 * 相关的纯逻辑抄一份跑真数据。抄的部分用 `// @copy` 标注,前端改了这里要跟着改。
 * 目的是**卡住数量与命中率**,不是复刻渲染。
 *
 * 用法: node --experimental-strip-types verify_doctrine_ui.ts
 */

const BASE = process.argv[2] || 'http://127.0.0.1:5173'

const FOLDER_CN = { land: '陆军', naval: '海军', air: '空军', special_forces: '特种部队' }
const TRACK_CN = {
  infantry: '步兵', combat_support: '炮兵战斗支援', armor: '装甲', operations: '作战',
  capital_ships: '主力舰', carriers: '航空母舰', screens: '护航', submarines: '潜艇',
  fighter_aircraft: '战斗机', strike_aircraft: '攻击机',
  medium_aircraft: '中型飞机', heavy_aircraft: '重型飞机',
  special_forces_first: '特种部队', special_forces_second: '特种部队',
}
const GRAND_CN = {
  new_mobile_warfare: '机动作战', superior_firepower: '火力优势',
  grand_battleplan: '大计划', mass_assault: '密集突击',
  new_fleet_in_being: '既存舰队', new_convoy_raiding: '贸易封锁',
  new_base_strike: '基地打击', new_strategic_destruction: '战略打击',
  new_battlefield_support: '战场支援', new_operational_integrity: '作战完整性',
  special_forces_quantity: '扩编特种部队', special_forces_quality: '精英特种部队',
}

const get = async (u: string) => {
  const r = await fetch(BASE + u)
  if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`)
  return r.json()
}

async function main() {
  console.log(`目标: ${BASE}`)
  const g = await get('/api/doctrines/graph')
  if (!g.ready) throw new Error('学说不就绪: ' + JSON.stringify(g).slice(0, 200))

  const subs: any[] = g.subdoctrines
  const tracks: any[] = g.tracks
  const grands: any[] = g.grand
  const folders: any[] = g.folders

  /* ══ 判据 1:默认可见的次要学说数量 ══
     旧版每个轨道默认只渲染 1 条 → 14/95。这是用户报"看不到其他次要学说"的根因。*/
  const byTrack = new Map<string, any[]>()
  for (const s of subs) {
    for (const t of s.tracks.length ? s.tracks : [s.track]) {
      if (!t) continue
      if (!byTrack.has(t)) byTrack.set(t, [])
      byTrack.get(t)!.push(s)
    }
  }
  // 复刻前端渲染口径:每个 folder 取其 grand 的 tracks 并集(去重),全部轨道都渲染
  const byGrand = new Map<string, any[]>()
  for (const gr of grands) {
    if (!byGrand.has(gr.folder)) byGrand.set(gr.folder, [])
    byGrand.get(gr.folder)!.push(gr)
  }
  let visibleTracks = 0
  const visibleSubs = new Set<string>()
  for (const f of folders) {
    const tids = new Set<string>()
    for (const gr of byGrand.get(f.id) || []) for (const t of gr.tracks) tids.add(t)
    visibleTracks += tids.size
    for (const t of tids) for (const s of byTrack.get(t) || []) visibleSubs.add(s.id)
  }
  const oldVisible = visibleTracks // 旧版:每轨道 1 条
  console.log('─'.repeat(66))
  console.log(`判据 1 · 次要学说可见性`)
  console.log(`  数据总量        ${subs.length} 条次要学说 / ${tracks.length} 个轨道 / ${grands.length} 个主要学说`)
  console.log(`  旧版默认可见    ${oldVisible} 条(每轨道 1 条)→ ${((oldVisible / subs.length) * 100).toFixed(1)}%`)
  console.log(`  新版默认可见    ${visibleSubs.size} 条(全部轨道展开)  → ${((visibleSubs.size / subs.length) * 100).toFixed(1)}%`)
  const okVisible = visibleSubs.size === subs.length
  console.log(`  ${okVisible ? '✅' : '❌'} ${okVisible ? '全部次要学说默认可见' : `仍有 ${subs.length - visibleSubs.size} 条不可见`}`)

  /* ══ 判据 2:名称本地化命中率 ══
     BUG-B:前端原先 Loc.load([...].map(x => x.id)) 请求的是 id,
     而真正的 loc key 在 .loc 字段(如 SUBDOCTRINE_MOBILE_INFANTRY)。 */
  const keys: string[] = []
  for (const x of [...folders, ...grands, ...tracks, ...subs]) {
    keys.push(...[x.loc, x.id].filter(Boolean)) // @copy 前端 locKeysOf
  }
  const uniq = [...new Set(keys)]
  console.log('─'.repeat(66))
  console.log(`判据 2 · 名称本地化(同时请求 id 与 loc)`)
  const texts: Record<string, any> = {}
  for (let i = 0; i < uniq.length; i += 150) {
    const d = await get('/api/loc/text?keys=' + encodeURIComponent(uniq.slice(i, i + 150).join(',')))
    Object.assign(texts, d.texts)
  }
  // 复刻前端的名称兜底链
  const locText = (k: string) => (k && texts[k]?.text ? String(texts[k].text).split('\n')[0] : '')
  const cnSub = (s: any) => locText(s.loc) || s.id // @copy
  const cnTrack = (t: any) => TRACK_CN[t.id] || locText(t.loc) || t.id // @copy
  const cnGrand = (x: any) => GRAND_CN[x.id] || locText(x.loc) || x.id // @copy
  const cnFolder = (f: any) => FOLDER_CN[f.id] || locText(f.loc) || f.id // @copy

  let rawSub = 0, rawTrack = 0, rawGrand = 0, rawFolder = 0
  for (const s of subs) if (cnSub(s) === s.id) rawSub++
  for (const t of tracks) if (cnTrack(t) === t.id) rawTrack++
  for (const x of grands) if (cnGrand(x) === x.id) rawGrand++
  for (const f of folders) if (cnFolder(f) === f.id) rawFolder++
  const okName = rawSub === 0 && rawTrack === 0 && rawGrand === 0 && rawFolder === 0
  console.log(`  次要学说  ${subs.length - rawSub}/${subs.length} 有名字   ${rawSub === 0 ? '✅' : '❌ 仍显示裸 id: ' + subs.filter((s) => cnSub(s) === s.id).slice(0, 5).map((s) => s.id).join(',')}`)
  console.log(`  轨道      ${tracks.length - rawTrack}/${tracks.length} 有名字   ${rawTrack === 0 ? '✅' : '❌ ' + tracks.filter((t) => cnTrack(t) === t.id).map((t) => t.id).join(',')}`)
  console.log(`  主要学说  ${grands.length - rawGrand}/${grands.length} 有名字   ${rawGrand === 0 ? '✅' : '❌ ' + grands.filter((x) => cnGrand(x) === x.id).map((x) => x.id).join(',')}`)
  console.log(`  页签      ${folders.length - rawFolder}/${folders.length} 有名字   ${rawFolder === 0 ? '✅' : '❌ ' + folders.filter((f) => cnFolder(f) === f.id).map((f) => f.id).join(',')}`)

  /* ══ 判据 3:图标接口可达性 ══
     BUG-A:前端传 sprite 名,后端只认 tN → 全 404。
     这里直接按前端的方式(GFX_xxx)逐个请求,统计成功率。 */
  console.log('─'.repeat(66))
  console.log(`判据 3 · 图标(以 sprite 名请求,与前端一致)`)
  const texNames = [
    ...grands.map((x) => x.icon),
    ...tracks.map((x) => x.icon),
    ...subs.map((x) => x.icon),
  ].filter(Boolean)
  const texUniq = [...new Set(texNames)]
  const info = await get('/api/texinfo?names=' + encodeURIComponent(texUniq.slice(0, 500).join(',')))
  let okTex = 0, badTex = 0, noDef = 0
  const badList: string[] = []
  for (const n of texUniq.slice(0, 500)) {
    const it = info.items[n]
    if (!it) { noDef++; continue }
    if (it.ok) okTex++
    else { badTex++; if (badList.length < 8) badList.push(`${n}(${it.error})`) }
  }
  console.log(`  不同贴图名 ${texUniq.length} 个(取前 500 抽查)`)
  console.log(`  可解析 ${okTex} · 贴图文件缺失 ${badTex} · 未定义 ${noDef}`)
  console.log(`  ${badTex === 0 ? '✅' : '⚠ '} ${badTex === 0 ? '全部命中' : '缺失样本: ' + badList.join(' | ')}`)

  // 抽样真解码 3 张,确认不是空白
  console.log('─'.repeat(66))
  console.log(`判据 4 · 抽样解码(确认非空白)`)
  const sample = texUniq.slice(0, 40).filter((n) => info.items[n]?.ok)
  let nonBlank = 0
  const samples: string[] = []
  for (const n of sample) {
    const d = await get('/api/tex?id=' + encodeURIComponent(n))
    if (!d.png) continue
    const bytes = Buffer.from(d.png, 'base64').length
    // 99 字节是修复前"全空白 64×64"的特征值
    if (bytes > 200) nonBlank++
    if (samples.length < 5) samples.push(`${n} ${d.w}x${d.h} ${bytes}B`)
  }
  console.log(`  抽样 ${sample.length} 张,非空白 ${nonBlank} 张`)
  for (const s of samples) console.log('   ', s)
  console.log(`  ${sample.length > 0 && nonBlank === sample.length ? '✅' : '❌'} 抽样全部有内容`)

  console.log('─'.repeat(66))
  const pass = okVisible && okName && badTex === 0 && sample.length > 0 && nonBlank === sample.length
  console.log(pass ? '✅ 学说页验收通过' : '❌ 存在未通过项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
