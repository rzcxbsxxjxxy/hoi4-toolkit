/* 模组关系页(MODMETA_V1)
 *
 * 三块内容:
 *  ① 依赖图 —— .mod 的 dependencies={} 解析 + 拓扑排序(被依赖的在前)
 *     依赖项引用的是模组 **name**(实测 36/36 唯一),不是 remote_file_id;
 *     `+JP:` 这类 launcher 语言前缀会被剥掉。
 *  ② replace_path 缺口 —— 声明替换某目录却没提供文件 → 游戏里该文件消失
 *  ③ 逐模组的 replace_path / dependencies 明细
 *
 * 口径对齐 HOI4 Modding Wiki(2026-10-11 快照):
 *  · dependencies 会改写加载序(强制本模组在所列模组之后加载),不是"只做校验";
 *    找不到依赖模组只是无法确定相对顺序,非运行必需 → 悬空依赖按 warn 呈现。
 *  · replace_path 只卸载指定文件夹内【直接】文件,子文件夹不受影响;不改加载序。
 *  · 求值序 ≠ 载入序:states 先建者胜 / sprite 后建者胜 / 国策重复破坏前置行。
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

/** 把 replace_path 缺口的 missing 列表拆成:直接文件(确定被删)与子文件夹文件(Wiki 口径下可能未受影响)。
 *  判定:missing 文件相对该 replacePath 去掉前缀后,剩余路径含 '/' 即为子文件夹文件。 */
function splitGap(replacePath, missing) {
  const norm = String(replacePath).replace(/\\/g, '/').replace(/[\/]+$/, '')
  const prefix = norm + '/'
  const direct = []
  const nested = []
  for (const f of missing) {
    const fwd = String(f).replace(/\\/g, '/')
    const rel = fwd.toLowerCase().startsWith(prefix.toLowerCase()) ? fwd.slice(prefix.length) : fwd
    if (rel.indexOf('/') >= 0) nested.push(f)
    else direct.push(f)
  }
  return { direct, nested }
}

async function load() {
  let d
  try {
    const r = await fetch('/api/modmeta')
    d = await r.json()
  } catch (e) {
    return toast(tr('请求 /api/modmeta 失败:') + e, true)
  }
  if (d.error) return toast(tr('服务端错误:') + d.error, true)

  const g = d.graph
  const st = g.stats
  $('#chip').textContent = `${st.mods}${tr(" 模组 · ")}${st.withDeps}${tr(" 有依赖 · 游戏 ")}${d.gameVersion || '未知'}`
  $('#intro').innerHTML =
    `游戏内默认加载序：基础游戏 → DLC（按内部 ID）→ 用户目录 → 模组（默认按用户 <code>.mod</code> 描述符文件名排序，如 <code>mod/abc_mod.mod</code> 先于 <code>mod/xyz_mod.mod</code>）。` +
    `<code>dependencies = { ... }</code> 会改写加载序，强制本模组在所列模组<strong>之后</strong>加载；<code>replace_path</code> <strong>不改变</strong>加载序。工作台按当前挂载序近似展示如下。`

  // ── 概览卡
  const gapN = d.audit.gaps.length
  $('#cards').innerHTML = [
    card('模组总数', st.mods, ''),
    card('依赖边', st.edges, ''),
    card('悬空依赖', st.missing, st.missing ? 'warn' : 'ok'),
    card('自依赖', st.self, st.self ? 'bad' : 'ok'),
    card('依赖环', st.cycles, st.cycles ? 'bad' : 'ok'),
    card('replace_path 缺口', gapN, gapN ? 'warn' : 'ok'),
  ].join('')

  // ── 载入顺序:① 工作台挂载序(mods 数组顺序) ② 依赖拓扑序(g.order)
  $('#orderMount').innerHTML =
    `<b style="color:var(--ink2)">① 工作台挂载序（当前 mods 数组顺序）：</b><br>` +
    (d.mods.length
      ? d.mods
          .map((m, i) => `<span class="pill">${i + 1}. ${esc(m.name || m.dir)}</span>`)
          .join(' ')
      : `（${tr('无')}）`)

  $('#orderTopo').innerHTML =
    `<b style="color:var(--ink2)">② 依赖修正后的游戏内加载序（拓扑序：被依赖的在前）：</b><br>` +
    (g.order.length
      ? g.order
          .map((k, i) => {
            const n = g.nodes.find((x) => x.key === k)
            return `<span class="pill ok">${i + 1}. ${esc(n ? n.display || n.name : k)}</span>`
          })
          .join(' ')
      : `（${tr('无')}）`)

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
        // 悬空依赖:依赖只决定排序、非运行必需 → warn(黄),不是 bad(红)
        for (const m of miss) lines.push(`<span style="color:#d8a94a">→ ${esc(m)}（未加载——依赖仅决定排序，非必需）</span>`)
        if (n.deps.length && !deps.length && !miss.length) lines.push('<span style="color:#d8a94a">（依赖均未加载）</span>')
        const isCyclic = g.cyclic.includes(n.key)
        const nodeCls = isCyclic ? ' err' : miss.length ? ' warn' : ''
        return (
          `<div class="node${nodeCls}"><b>${esc(n.display || n.name)}</b>` +
          (n.id ? ` <span class="pill">${esc(n.id)}</span>` : '') +
          (n.deps.length ? '' : tr(' <span class="pill">无依赖</span>')) +
          (n.deps.length ? `<div class="deps">${lines.join('<br>')}</div>` : '') +
          `</div>`
        )
      })
      .join('') || '<div class="hint">未加载任何模组</div>'

  // ── replace_path 缺口(直接文件 vs 子文件夹文件分层)
  $('#audit').innerHTML = d.audit.gaps.length
    ? d.audit.gaps
        .map((g2) => {
          const { direct, nested } = splitGap(g2.replacePath, g2.missing)
          const cls = direct.length ? 'err' : 'warn'
          let h = `<div class="node ${cls}"><b>${esc(g2.mod)}</b> 声明 <code>replace_path="${esc(g2.replacePath)}"</code>`
          if (direct.length) {
            h += `<div style="margin-top:4px"><span class="pill bad">确定被删 · 直接文件 ${direct.length}</span></div>`
            h += `<div class="rp">${direct.map((m) => `<code style="color:#e07070">${esc(m)}</code>`).join(' ')}</div>`
          }
          if (nested.length) {
            h += `<div style="margin-top:4px"><span class="pill warn">子文件夹文件 ${nested.length}</span> <span class="hint">（Wiki 口径：replace_path 只卸载直接文件，子文件夹不受影响；此处仅按子树口径报告）</span></div>`
            h += `<div class="rp">${nested.map((m) => `<code style="color:var(--ink3)">${esc(m)}</code>`).join(' ')}</div>`
          }
          h += '</div>'
          return h
        })
        .join('')
    : '<div class="hint ok">未发现 replace_path 缺口</div>'

  // ── 明细表
  $('#table').innerHTML =
    tr('<table><tr><th>模组</th><th>类型</th><th>replace_path</th><th>dependencies</th><th>告警</th></tr>') +
    d.mods
      .map((m) => {
        const rps = m.replacePaths || []
        return (
          '<tr><td><b>' + esc(m.name || tr('(无名)')) + '</b><div class="hint">' + esc(m.dir) + '</div></td>' +
          '<td>' +
          (m.hasModFile ? '<span class="pill ok">' + esc(m.modFile) + '</span>' : tr('<span class="pill warn">推断</span>')) +
          (m.versionOk === false ? '<span class="pill bad">版本不符</span>' : '') +
          (m.stalePath ? '<span class="pill warn">含 path=</span>' : '') +
          '</td>' +
          '<td class="rp">' +
          (rps.length
            ? '<b>' + rps.length + tr('</b> 条<div>') + rps.slice(0, 40).map((r) => '<code>' + esc(r) + '</code>').join(' ') + (rps.length > 40 ? ' …' : '') + '</div>'
            : tr('<span class="hint">无（只新增，不替换）</span>')) +
          '</td>' +
          '<td class="rp">' +
          (m.dependencies.length ? m.dependencies.map((x) => '<code>' + esc(x) + '</code>').join(' ') : tr('<span class="hint">无</span>')) +
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