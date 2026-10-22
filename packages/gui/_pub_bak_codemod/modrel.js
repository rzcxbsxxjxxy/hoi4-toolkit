/* 模组关系页(MODMETA_V1)
 *
 * 三块内容:
 *  ① 依赖图 —— .mod 的 dependencies={} 解析 + 拓扑排序(被依赖的在前)
 *     依赖项引用的是模组 **name**(实测 36/36 唯一),不是 remote_file_id;
 *     `+JP:` 这类 launcher 语言前缀会被剥掉。
 *  ② replace_path 缺口 —— 声明替换某目录却没提供文件 → 游戏里该文件消失
 *  ③ 逐模组的 replace_path / dependencies 明细
 */
const $ = (s) => document.querySelector(s)

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
function toast(msg, bad) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'on' + (bad ? ' bad' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (el.className = ''), 3200)
}

async function load() {
  let d
  try {
    const r = await fetch('/api/modmeta')
    d = await r.json()
  } catch (e) {
    return toast('请求 /api/modmeta 失败:' + e, true)
  }
  if (d.error) return toast('服务端错误:' + d.error, true)

  const g = d.graph
  const st = g.stats
  $('#chip').textContent = `${st.mods} 模组 · ${st.withDeps} 有依赖 · 游戏 ${d.gameVersion || '未知'}`
  $('#intro').innerHTML =
    `按 <code>.mod</code> 的 <code>replace_path</code> 与 <code>dependencies</code> 解析。` +
    `载入序 = 当前来源数组顺序（靠后者覆盖靠前者）；依赖关系只做校验与展示，<strong>不改写</strong>载入序。`

  // ── 概览卡
  const gapN = d.audit.gaps.length
  $('#cards').innerHTML = [
    card('模组总数', st.mods, ''),
    card('依赖边', st.edges, ''),
    card('悬空依赖', st.missing, st.missing ? 'bad' : 'ok'),
    card('自依赖', st.self, st.self ? 'bad' : 'ok'),
    card('依赖环', st.cycles, st.cycles ? 'bad' : 'ok'),
    card('replace_path 缺口', gapN, gapN ? 'warn' : 'ok'),
  ].join('')

  // ── 载入顺序
  const nameOf = {}
  for (const m of d.mods) nameOf[m.name.toLowerCase()] = m.name
  $('#order').innerHTML = g.order
    .map((k, i) => {
      const n = g.nodes.find((x) => x.key === k)
      return `<span class="pill ok">${i + 1}. ${esc(n ? (n.display || n.name) : k)}</span>`
    })
    .join(' ') || '（无）'

  // ── 依赖关系(逐节点)
  const nodeMap = new Map(g.nodes.map((n) => [n.key, n]))
  $('#graph').innerHTML =
    g.nodes
      .map((n) => {
        const deps = n.depKeys.filter((k) => nodeMap.has(k))
        const miss = n.missingDeps || []
        const lines = []
        for (const k of deps) {
          const t = nodeMap.get(k)
          lines.push(`<span class="ok">→ ${esc(t ? t.name : k)}</span>`)
        }
        for (const m of miss) lines.push(`<span style="color:#e07070">→ ✗ ${esc(m)}（未加载）</span>`)
        if (n.deps.length && !deps.length && !miss.length) lines.push('<span style="color:#d8a94a">（依赖均未加载）</span>')
        const errCls = miss.length || g.cyclic.includes(n.key) ? ' err' : ''
        return (
          `<div class="node${errCls}"><b>${esc(n.display || n.name)}</b>` +
          (n.id ? ` <span class="pill">${esc(n.id)}</span>` : '') +
          (n.deps.length ? '' : ' <span class="pill">无依赖</span>') +
          (n.deps.length ? `<div class="deps">${lines.join('<br>')}</div>` : '') +
          `</div>`
        )
      })
      .join('') || '<div class="hint">未加载任何模组</div>'

  // ── replace_path 缺口
  $('#audit').innerHTML = d.audit.gaps.length
    ? d.audit.gaps
        .map(
          (g2) =>
            `<div class="node err"><b>${esc(g2.mod)}</b> 声明 <code>replace_path="${esc(g2.replacePath)}"</code>` +
            ` 但缺少 ${g2.missing.length} 个文件<div class="rp">${g2.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')}` +
            `${g2.missing.length > 30 ? ' …' : ''}</div></div>`,
        )
        .join('')
    : '<div class="hint ok">未发现 replace_path 缺口</div>'

  // ── 明细表
  $('#table').innerHTML =
    '<table><tr><th>模组</th><th>类型</th><th>replace_path</th><th>dependencies</th><th>告警</th></tr>' +
    d.mods
      .map((m) => {
        const rps = m.replacePaths || []
        return (
          '<tr><td><b>' + esc(m.name || '(无名)') + '</b><div class="hint">' + esc(m.dir) + '</div></td>' +
          '<td>' +
          (m.hasModFile ? '<span class="pill ok">' + esc(m.modFile) + '</span>' : '<span class="pill warn">推断</span>') +
          (m.versionOk === false ? '<span class="pill bad">版本不符</span>' : '') +
          (m.stalePath ? '<span class="pill warn">含 path=</span>' : '') +
          '</td>' +
          '<td class="rp">' +
          (rps.length
            ? '<b>' + rps.length + '</b> 条<div>' + rps.slice(0, 40).map((r) => '<code>' + esc(r) + '</code>').join(' ') + (rps.length > 40 ? ' …' : '') + '</div>'
            : '<span class="hint">无（只新增，不替换）</span>') +
          '</td>' +
          '<td class="rp">' +
          (m.dependencies.length ? m.dependencies.map((x) => '<code>' + esc(x) + '</code>').join(' ') : '<span class="hint">无</span>') +
          '</td>' +
          '<td class="rp">' + (m.warnings.length ? m.warnings.map((w) => esc(w)).join('<br>') : '') + '</td></tr>'
        )
      })
      .join('') +
    '</table>'
}

function card(k, v, cls) {
  return `<div class="card ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`
}

load()