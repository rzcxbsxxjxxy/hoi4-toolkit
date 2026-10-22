'use strict'
/**
 * AIDE_V1 —— AI 开发面板(前端)
 *
 * ══════════════════════════════════════════════════════════════════
 * 遵循本工作台已有的公共件铁律(踩过的坑,别重犯)
 * ══════════════════════════════════════════════════════════════════
 * ① **样式自注入**,颜色全部读 theme-vars.css 的 CSS 变量
 *    (`--bg/--panel/--ink/--line/--accent/--danger/--ok/--warn/--glass` …),
 *    换主题不用改本文件一行(与 ctx.js / keys.js 同一套做法)。
 *
 * ② **不按 DOM 文本反查数据**。工具调用卡片挂在元素上的 `__tool` 上取数据,
 *    因为消息正文是模型生成的文本,按文本匹配必然出错。
 *
 * ③ **聊天区是全量重建的**(每次 render),所以绑定一律用**事件委托**挂在
 *    容器上,不逐元素绑 —— 否则第二次发消息后按钮全失效。
 *    (与 focus/tech 页 canvas 同理)
 *
 * ④ **keymap.js 必须在 keys.js 之前**,本页不引这两个,只用自家快捷键,
 *    且注册时一律带 `{doc:true}` 的走 document 级,避免与 IDE 已有的
 *    Ctrl+S / Ctrl+E 抢。
 *
 * ⑤ **写文件必须用户点「应用」**。模型只能生成 diff 预览,
 *    本组件不提供任何自动落盘路径。
 * ══════════════════════════════════════════════════════════════════ */

;(function () {
  const $ = (id) => document.getElementById(id)
  const enc = encodeURIComponent
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  /* ══════════════ 状态 ══════════════ */
  const S = {
    ready: false,
    busy: false,
    cfg: {
      provider: 'deepseek', baseUrl: '', model: 'deepseek-chat',
      temperature: 0.2, maxTokens: 4096, allowWrite: false, allowHeavy: true,
    },
    hasKey: false,
    keySource: 'none',
    keyPreview: '',
    providers: [],
    /** [{role, content, tools?:[], previews?:[]}] */
    msgs: [],
    curFile: '',
    abort: null,
    /* 面板是否已挂载 */
    mounted: false,
  }

  const LS = 'gui.ai.config'

  /* ══════════════ 样式自注入 ══════════════ */
  const CSS = `
#tabAI{display:flex;flex-direction:column;min-height:0}
#aiCfg{border-bottom:1px solid var(--line);padding:6px 8px;display:flex;flex-direction:column;gap:5px;flex:none;background:var(--panel)}
#aiCfg .ai-row{display:flex;gap:4px;align-items:center}
#aiCfg select,#aiCfg input{flex:1;min-width:0;background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:3px 5px;font-size:12px}
#aiCfg .ai-lbl{font-size:11px;color:var(--ink3);white-space:nowrap}
#aiCfg .ai-keys{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--ink3);flex-wrap:wrap}
#aiCfg label{display:flex;align-items:center;gap:3px;cursor:pointer;user-select:none}
#aiMsgs{flex:1;overflow-y:auto;min-height:0;padding:8px;display:flex;flex-direction:column;gap:8px}
#aiMsgs .empty{margin:auto;text-align:center;color:var(--ink3);font-size:12px;line-height:1.8;padding:16px}
.ai-msg{border-radius:6px;padding:6px 8px;font-size:12.5px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.ai-msg.user{background:var(--accent);color:var(--bg);align-self:flex-end;max-width:92%}
.ai-msg.bot{background:var(--bg2);border:1px solid var(--line);align-self:flex-start;max-width:96%}
.ai-msg.err{background:color-mix(in srgb,var(--danger) 14%,var(--bg2));border-color:var(--danger);color:var(--ink);align-self:flex-start;max-width:96%;white-space:pre-wrap}
.ai-msg code{background:color-mix(in srgb,var(--ink) 12%,transparent);padding:0 3px;border-radius:3px;font-size:11.5px}
.ai-msg pre{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:6px;margin:5px 0;overflow-x:auto;white-space:pre;font-size:11.5px}
#aiBar{flex:none;border-top:1px solid var(--line);padding:6px 8px;display:flex;gap:5px;align-items:flex-end;background:var(--panel)}
#aiInput{flex:1;resize:none;height:52px;background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:5px 7px;font-size:12.5px;font-family:inherit}
#aiBar button{background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
#aiBar button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent);font-weight:600}
#aiBar button:disabled{opacity:.45;cursor:not-allowed}
.ai-tools{margin-top:5px;display:flex;flex-direction:column;gap:4px}
.ai-tool{border:1px solid var(--line);border-radius:4px;font-size:11px;overflow:hidden;background:var(--bg)}
.ai-tool .hd{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;background:var(--bg2)}
.ai-tool .hd:hover{filter:brightness(1.08)}
.ai-tool .nm{font-family:ui-monospace,Consolas,monospace;color:var(--accent);font-weight:600}
.ai-tool .st{color:var(--ink3);margin-left:auto}
.ai-tool .bd{border-top:1px solid var(--line);padding:4px 6px;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--ink2)}
.ai-pv{border:1px solid var(--warn);border-radius:5px;overflow:hidden;margin:4px 0;font-size:11px}
.ai-pv .hd{background:color-mix(in srgb,var(--warn) 18%,var(--bg2));padding:3px 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ai-pv .hd .f{font-family:ui-monospace,Consolas,monospace;font-weight:600}
.ai-pv .hd button{padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid var(--line);background:var(--bg2);color:var(--ink)}
.ai-pv .hd button.ok{background:var(--ok);border-color:var(--ok);color:var(--bg);font-weight:600}
.ai-pv pre{margin:0;padding:5px 6px;background:var(--bg);overflow-x:auto;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;line-height:1.45;max-height:340px;overflow-y:auto}
.ai-pv pre .d{color:var(--danger)}
.ai-pv pre .a{color:var(--ok)}
.ai-pv pre .h{color:var(--ink3)}
.ai-quick{display:flex;gap:4px;flex-wrap:wrap;padding:0 8px 6px;flex:none}
.ai-quick button{font-size:10.5px;padding:2px 6px;border-radius:10px;border:1px solid var(--line);background:var(--bg2);color:var(--ink2);cursor:pointer}
.ai-quick button:hover{border-color:var(--accent);color:var(--accent)}
`
  function injectCss() {
    if (document.getElementById('aiCss')) return
    const st = document.createElement('style')
    st.id = 'aiCss'
    st.textContent = CSS
    document.head.appendChild(st)
  }

  function toast(msg, err) {
    const t = $('toast')
    if (!t) { console.log('[AI]', msg); return }
    t.textContent = msg
    t.className = 'on' + (err ? ' err' : '')
    clearTimeout(toast._t)
    toast._t = setTimeout(() => { t.className = '' }, 2400)
  }

  /* ══════════════ Markdown 极简渲染 ══════════════
   * 只处理三种:**代码块** / `行内码` / 纯文本换行。
   * 刻意不做列表/表格/链接 —— 模型输出的结构化内容大多在代码块里,
   * 过度渲染反而引入 XSS 面(内容会原样进 innerHTML)。*/
  function mdLite(s) {
    const blocks = []
    /* 先抽出代码块,避免块内内容被后续规则改坏 */
    let t = String(s ?? '').replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push({ lang, code })
      return `\u0000B${blocks.length - 1}\u0000`
    })
    t = esc(t)
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    return t.replace(/\u0000B(\d+)\u0000/g, (_m, i) => {
      const b = blocks[Number(i)]
      return `<pre><code>${esc(b.code.replace(/\n$/, ''))}</code></pre>`
    })
  }

  /* ══════════════ 配置 ══════════════ */
  async function loadConfig() {
    try {
      const r = await fetch('/api/ai/config')
      const j = await r.json()
      if (j.config) Object.assign(S.cfg, j.config)
      S.hasKey = !!j.hasKey
      S.keySource = j.keySource || 'none'
      S.keyPreview = j.keyPreview || ''
      S.providers = j.providers || []
      S.needsKey = !!j.needsKey
    } catch (e) {
      console.warn('[AI] 读配置失败', e)
    }
    /* 本地覆盖(上次选的模型优先,避免每次重开都被 provider 默认值盖掉) */
    try {
      const local = JSON.parse(localStorage.getItem(LS) || '{}')
      if (local.provider) S.cfg.provider = local.provider
      if (local.model) S.cfg.model = local.model
      if (local.baseUrl !== undefined) S.cfg.baseUrl = local.baseUrl
    } catch { /* 坏了就用服务端值 */ }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS, JSON.stringify({ provider: S.cfg.provider, model: S.cfg.model, baseUrl: S.cfg.baseUrl }))
    } catch { /* 无痕模式等,忽略 */ }
  }

  async function postConfig(patch) {
    const r = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const j = await r.json()
    if (j.error) { toast(j.error, true); return false }
    if (typeof j.hasKey === 'boolean') S.hasKey = j.hasKey
    saveLocal()
    renderCfg()
    return true
  }

  /* ══════════════ 渲染:配置区 ══════════════ */
  function renderCfg() {
    const el = $('aiCfg')
    if (!el) return
    const prov = S.providers.find((x) => x.id === S.cfg.provider) ?? S.providers[0]
    const opt = (v, l) => `<option value="${esc(v)}"${v === S.cfg.provider ? ' selected' : ''}>${esc(l)}</option>`
    const models = (prov?.models ?? []).map((m) => `<option value="${esc(m)}"${m === S.cfg.model ? ' selected' : ''}>${esc(m)}</option>`).join('')
    const keyTxt = S.keySource === 'env'
      ? '密钥来自环境变量'
      : S.keyPreview
        ? `密钥 ${esc(S.keyPreview)}`
        : '未设置密钥'
    el.innerHTML = `
      <div class="ai-row">
        <span class="ai-lbl">服务商</span>
        <select id="aiProv">${S.providers.map((p) => opt(p.id, p.label + (p.tag ? ' · ' + p.tag : ''))).join('')}</select>
        <select id="aiModel" title="模型名">${models}<option value="${esc(S.cfg.model)}"${models.includes(`value="${esc(S.cfg.model)}"`) ? ' selected' : ''}>${esc(S.cfg.model) || '(自填)'}</option></select>
      </div>
      <div class="ai-row">
        <span class="ai-lbl">端点</span>
        <input id="aiBase" placeholder="${esc(prov?.baseUrl || 'https://…/v1')}" value="${esc(S.cfg.baseUrl || '')}" title="留空则用服务商默认端点">
        <button id="aiFetchM" title="从该端点拉取可用模型">拉模型</button>
      </div>
      <div class="ai-row">
        <input id="aiKey" type="password" placeholder="${prov?.needsKey ? 'API Key(留空则用已保存的)' : '本地模型无需 key'}" value="" title="只在保存时写进 gui-settings.json">
        <button id="aiSaveKey" title="保存密钥">存</button>
      </div>
      <div class="ai-keys">
        <span title="${esc(keyTxt)}">${keyTxt}</span>
        <label title="允许 AI 生成文件改动(仍需你在 diff 上点「应用」才会落盘)"><input type="checkbox" id="aiAllowWrite"${S.cfg.allowWrite ? ' checked' : ''}> 允许改文件</label>
        <label title="允许 AI 调用体检这类重活"><input type="checkbox" id="aiAllowHeavy"${S.cfg.allowHeavy ? ' checked' : ''}> 允许跑体检</label>
        <label title="清空对话"><input type="checkbox" id="aiClear"> 清空对话</label>
      </div>`

    const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn)
    on('aiProv', 'change', async (e) => {
      const p = S.providers.find((x) => x.id === e.target.value)
      await postConfig({ provider: e.target.value, baseUrl: '', model: p?.models?.[0] ?? '' })
    })
    on('aiModel', 'change', (e) => { S.cfg.model = e.target.value; postConfig({ model: e.target.value }) })
    on('aiBase', 'change', (e) => { S.cfg.baseUrl = e.target.value.trim(); postConfig({ baseUrl: S.cfg.baseUrl }) })
    on('aiSaveKey', 'click', async () => {
      const v = $('aiKey').value.trim()
      if (!v) { toast('请先填入密钥', true); return }
      if (await postConfig({ apiKey: v })) { $('aiKey').value = ''; toast('密钥已保存') }
    })
    on('aiAllowWrite', 'change', async (e) => {
      const v = e.target.checked
      /* 权限变化是安全边界,必须让用户明确确认一次 */
      if (v && !confirm('允许 AI 修改模组文件?\n\nAI 只能生成 diff 预览,仍需你在预览上点「应用」才会真正写入磁盘。\n游戏本体(只读来源)永远禁止写入。')) {
        e.target.checked = false
        return
      }
      await postConfig({ allowWrite: v })
      toast(v ? '已允许生成改动' : '已关闭写权限')
    })
    on('aiAllowHeavy', 'change', (e) => postConfig({ allowHeavy: e.target.checked }))
    on('aiClear', 'change', (e) => { if (e.target.checked) { S.msgs = []; renderMsgs(); e.target.checked = false } })
    on('aiFetchM', 'click', async (e) => {
      const b = e.target
      b.disabled = true
      b.textContent = '拉取中…'
      try {
        const r = await fetch('/api/ai/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: S.cfg.provider, baseUrl: S.cfg.baseUrl, apiKey: undefined }),
        })
        const j = await r.json()
        if (j.models?.length) {
          const sel = $('aiModel')
          const cur = S.cfg.model
          sel.innerHTML = j.models.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('')
          toast(`拿到 ${j.models.length} 个模型`)
        } else {
          toast(j.error || '没拿到模型列表,可手填模型名', true)
        }
      } catch (err) {
        toast('拉取失败:' + err, true)
      } finally {
        b.disabled = false
        b.textContent = '拉模型'
      }
    })
  }

  /* ══════════════ 渲染:消息区 ══════════════ */
  function toolCard(t) {
    const statusTxt = t.state === 'running' ? '执行中…' : t.state === 'error' ? '失败' : '完成'
    return `<div class="ai-tool" data-tid="${esc(t.id)}">
      <div class="ai-tool-hd hd"><span class="nm">${esc(t.name)}</span><span class="st">${statusTxt}</span><span class="tw">▾</span></div>
      <div class="ai-tool-bd bd" style="display:${t.state === 'running' ? 'block' : 'none'}">${esc(JSON.stringify(t.args))}</div>
      <div class="ai-tool-out bd" style="display:${t.state === 'running' ? 'none' : 'block'}">${esc(t.result || '')}</div>
    </div>`
  }

  function previewCard(p) {
    const dl = p.diff || ''
    const body = dl.split('\n').map((ln) => {
      const c = ln.startsWith('+') ? 'a' : ln.startsWith('-') ? 'd' : ln.startsWith('@@') || ln.startsWith('---') || ln.startsWith('+++') ? 'h' : ''
      return `<span class="${c}">${esc(ln)}</span>`
    }).join('\n')
    return `<div class="ai-pv" data-pv="${esc(p.id)}">
      <div class="hd"><span class="f">${esc(p.rootName)}/${esc(p.file)}</span>
        <span class="st">${p.isNew ? '新建' : `覆盖 ${p.bytes} 字符`}</span>
        <button class="ok" data-act="apply">应用</button>
        <button data-act="reject">拒绝</button>
      </div>
      <pre>${body}</pre>
    </div>`
  }

  function renderMsgs() {
    const el = $('aiMsgs')
    if (!el) return
    if (!S.msgs.length) {
      el.innerHTML = `<div class="empty">还没有对话。<br>问我 HOI4 脚本问题,或让我改文件 —— 我会先看真实内容再给 diff。<br><br>下面几个快捷问题可以试试:</div>`
      const q = $('aiQuick')
      if (q) {
        q.innerHTML = QUICK.map((t) => `<button data-q="${esc(t)}">${esc(t)}</button>`).join('')
      }
      return
    }
    el.innerHTML = S.msgs.map((m) => {
      if (m.role === 'user') return `<div class="ai-msg user">${esc(m.content)}</div>`
      if (m.role === 'error') return `<div class="ai-msg err">${esc(m.content)}</div>`
      const tools = (m.tools || []).map(toolCard).join('')
      const pvs = (m.previews || []).map(previewCard).join('')
      return `<div class="ai-msg bot"><span class="ai-txt">${mdLite(m.content)}</span>${tools ? `<div class="ai-tools">${tools}</div>` : ''}${pvs}</div>`
    }).join('')
    el.scrollTop = el.scrollHeight
  }

  const QUICK = [
    '当前文件的结构有什么问题?',
    '这个科技为什么不显示?',
    '帮我检查这个国策树的语法',
    '这个图标名在 vanilla 里存在吗?',
  ]

  /* ══════════════ 发送 ══════════════ */
  async function send(text) {
    const q = (text ?? $('aiInput').value).trim()
    if (!q || S.busy) return
    if (S.needsKey !== false && !S.hasKey) {
      toast('还没设置 API 密钥 —— 请在上方填入并点「存」', true)
      return
    }
    S.msgs.push({ role: 'user', content: q })
    const botMsg = { role: 'bot', content: '', tools: [], previews: [] }
    S.msgs.push(botMsg)
    $('aiInput').value = ''
    S.busy = true
    renderMsgs()
    setSendBtn()

    const ac = new AbortController()
    S.abort = ac
    try {
      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: S.msgs.filter((m) => m.role === 'user' || m.role === 'bot').map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.content })),
          curFile: S.curFile,
        }),
        signal: ac.signal,
      })
      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status
        try { const j = await resp.json(); if (j.error) msg = j.error } catch { /* 非 JSON 错误体 */ }
        throw new Error(msg)
      }
      await readSse(resp, botMsg)
    } catch (e) {
      if (String(e).includes('abort')) {
        S.msgs.push({ role: 'error', content: '已取消' })
      } else {
        S.msgs.push({ role: 'error', content: '请求失败:' + String(e) })
      }
    } finally {
      S.busy = false
      S.abort = null
      renderMsgs()
      setSendBtn()
    }
  }

  /** 解析 SSE:后端统一发 `data: {type, ...}` */
  async function readSse(resp, botMsg) {
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const toolById = new Map()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find((x) => x.startsWith('data:'))
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        handleEvent(ev, botMsg, toolById)
      }
    }
  }

  function handleEvent(ev, botMsg, toolById) {
    switch (ev.type) {
      case 'delta':
        botMsg.content += ev.text || ''
        liveUpdate(botMsg)
        break
      case 'status': {
        const el = $('aiMsgs')
        if (el) el.setAttribute('data-ai-status', ev.text || '')
        break
      }
      case 'tool_call': {
        const c = ev.call
        if (!c) break
        if (!toolById.has(c.id)) {
          const t = { id: c.id, name: c.name, args: c.args, result: '', state: 'running' }
          toolById.set(c.id, t)
          botMsg.tools.push(t)
        }
        break
      }
      case 'tool_result': {
        const c = ev.call
        if (!c) break
        let t = toolById.get(c.id)
        if (!t) { t = { id: c.id, name: c.name, args: c.args, result: '', state: 'running' }; toolById.set(c.id, t); botMsg.tools.push(t) }
        t.result = (t.result ? t.result + '\n' : '') + (ev.result || '')
        t.state = /"error"/.test(ev.result || '') ? 'error' : 'done'
        /* 预览类工具:把 diff 卡片挂到消息上 */
        const pid = ev.data?.previewId
        if (pid) {
          try {
            const pv = JSON.parse(ev.result)
            if (pv.previewId) {
              botMsg.previews.push({
                id: pv.previewId,
                file: pv.file || '',
                rootName: typeof pv.root === 'string' ? pv.root : '',
                bytes: pv.bytes || 0,
                isNew: !!pv.isNew,
                diff: pv.diff || '',
              })
            }
          } catch { /* 非 JSON 结果,忽略 */ }
        }
        break
      }
      case 'error':
        S.msgs.push({ role: 'error', content: ev.text || '未知错误' })
        break
      case 'done':
        break
    }
  }

  /* 流式时局部刷新(不整表重建,否则输入框焦点/滚动会乱)。
   * ⚠ 每条 bot 消息第一个子元素固定是 <span class="ai-txt">,
   *   renderMsgs 重建后按 :last-of-type 重新定位 —— 不要把 DOM 节点
   *   引用挂在消息对象上(会被 JSON 化 / 重建后失效)。*/
  function liveUpdate(botMsg) {
    const el = $('aiMsgs')
    if (!el) return
    const last = el.querySelector('.ai-msg.bot:last-of-type')
    if (!last) { renderMsgs(); return }
    const txt = last.querySelector('.ai-txt')
    if (!txt) { renderMsgs(); return }
    txt.innerHTML = mdLite(botMsg.content)
    el.scrollTop = el.scrollHeight
  }

  function setSendBtn() {
    const b = $('aiSend')
    if (!b) return
    if (S.busy) { b.textContent = '停止'; b.classList.remove('primary'); b.disabled = false }
    else { b.textContent = '发送'; b.classList.add('primary'); b.disabled = false }
  }

  /* ══════════════ 事件(全用委托)══════════════ */
  function wireDelegates() {
    const el = $('aiMsgs')
    if (!el || el.__aiWired) return
    el.__aiWired = true
    /* 工具卡片折叠/展开 */
    el.addEventListener('click', (e) => {
      const hd = e.target.closest('.ai-tool .hd')
      if (hd) {
        const card = hd.closest('.ai-tool')
        const outs = card.querySelectorAll('.bd')
        outs.forEach((o) => { o.style.display = o.style.display === 'none' ? 'block' : 'none' })
        return
      }
      /* 应用/拒绝 diff */
      const btn = e.target.closest('.ai-pv button')
      if (!btn) return
      const card = btn.closest('.ai-pv')
      const id = card?.getAttribute('data-pv')
      if (!id) return
      const act = btn.getAttribute('data-act')
      if (act === 'reject') {
        card.querySelectorAll('button').forEach((b) => { b.disabled = true })
        card.querySelector('pre').style.opacity = '.4'
        card.querySelector('.st').textContent = '已拒绝'
        toast('已拒绝该改动')
        return
      }
      btn.disabled = true
      btn.textContent = '应用中…'
      fetch('/api/ai/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (j.error) { toast(j.error, true); btn.disabled = false; btn.textContent = '应用'; return }
          toast(`已写入 ${j.file}`)
          card.querySelectorAll('button').forEach((b) => { b.disabled = true })
          card.querySelector('.st').textContent = `已应用${j.created ? '(新建)' : '(已备份 .bak)'}`
          btn.classList.add('ok')
          /* 通知宿主页刷新:文件变了,编辑器/大纲需要重载 */
          window.dispatchEvent(new CustomEvent('ai:file-applied', { detail: j }))
          if (window.HoiIde && typeof window.HoiIde.reloadCurrent === 'function') window.HoiIde.reloadCurrent()
        })
        .catch((err) => { toast('应用失败:' + err, true); btn.disabled = false; btn.textContent = '应用' })
    })
  }

  /* ⚠ 这里**不能**在 IIFE 顶层再绑 document 级 input/keydown 与 #aiQuick ——
   *   那几个监听已统一收进 `ensureWired()`(mount 时装,只装一次)。
   *   两处都装会导致:一次回车发两条消息、点一次快捷问题触发两次。*/

  /* ══════════════ 挂载 ══════════════ */
  /* ★ mount 必须**幂等**。
   *   之前 `if (S.mounted) return` 只挡住了重复调用,但三个副作用仍会重复发生:
   *   ① wireDelegates 给 #aiMsgs 再绑一次 click → 点一次触发两次
   *   ② 下面的 document 级 input/keydown 监听再注册一份 → 一次回车发两条
   *   ③ aiSend 按钮已经在了就跳过,导致 setSendBtn 拿不到按钮
   *   现在改成:一次性副作用用 `wired` 标志守卫,配置重拉是允许的。*/
  let wired = false

  async function mount(force) {
    injectCss()
    if (force || !S.mounted) {
      await loadConfig()
      renderCfg()
      S.mounted = true
    }
    ensureWired()
    renderMsgs()
    setSendBtn()
    S.ready = true
  }

  /** 一次性副作用:DOM 委托 + document 监听 + 发送按钮,只装一次 */
  function ensureWired() {
    if (wired) return
    wired = true
    wireDelegates()

    /* 快捷问题按钮:容器内容会被 renderMsgs 重建,所以绑在**容器**上(委托) */
    const quick = $('aiQuick')
    if (quick) {
      quick.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-q]')
        if (b) send(b.getAttribute('data-q'))
      })
    }

    /* 文本框:Enter 发送 / Shift+Enter 换行。
     * ⚠ 用 document 级 + 捕获阶段,是与 IDE 的编辑框快捷键共存的需要;
     *   所以**只能装一次**,重复注册会让一次回车发两条。*/
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'aiInput') {
        e.target.style.height = 'auto'
        e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'
      }
    }, true)
    document.addEventListener('keydown', (e) => {
      if (e.target && e.target.id === 'aiInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        send()
      }
    }, true)

    const bar = $('aiBar')
    if (bar && !$('aiSend')) {
      const b = document.createElement('button')
      b.id = 'aiSend'
      b.className = 'primary'
      b.textContent = '发送'
      b.addEventListener('click', () => { if (S.busy) { S.abort?.abort(); return } send() })
      bar.appendChild(b)
    }
  }

  window.AI = {
    mount,
    state: S,
    send,
    setCurFile(f) { S.curFile = f || '' },
    toast,
  }
  window.dispatchEvent(new CustomEvent('ai:ready'))
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
