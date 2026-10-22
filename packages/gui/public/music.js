/* MUSIC_V3: floating player. Draggable, source filter, track list, cross-page resume. Depends on i18n.js. */
(function () {
  if (window.__musicInit) return
  window.__musicInit = true

  const STORE = 'hoi4.music.state'
  const LANG_STORE = 'hoi4.music.lang'
  /* MUSIC_LANG_V1:歌名语言独立设置。仅当所选语言在 title 中存在才采用,否则由
     songTitle() 回退英文;未设置时跟随工作台语言。 */
  const langKey = () => {
    const custom = localStorage.getItem(LANG_STORE)
    if (custom && /^(english|simp_chinese)$/i.test(custom)) return custom.toLowerCase()
    const g = (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : 'zh'
    return g === 'en' ? 'english' : 'simp_chinese'
  }

  let stations = []
  let curStation = 0
  let curIdx = 0
  let audio = null
  let loading = false
  let sources = []   // [{name, enabled}]
  let listOpen = true
  let userPlayed = false
  let wasPlaying = false
  let lastSaveT = 0
  /* ★ MUSIC_MODE_V2(2026-10-22):四种模式,语义对齐主流播放器 ——
   *   order    顺序播放(到末尾停)
   *   listloop 列表循环(到末尾绕回开头)
   *   repeat   单曲循环(重播当前这一首)  ← 用户说的"循环播放"
   *   shuffle  随机播放
   * 旧版只有 order/repeat/shuffle 三个键,且 repeat 实为"列表循环"——
   *   用户点"循环播放"却看到换歌,于是判为"失效"。 */
  let mode = 'order'  // order | listloop | repeat | shuffle
  const MODES = ['order', 'listloop', 'repeat', 'shuffle']
  let stationsLoaded = false   /* ★ 站点列表是否已成功加载过一次(避免 show() 重复拉取/重播) */
  let loadFailed = false       /* 加载失败标记:出错时不再无限重试刷屏 */

  const dock = document.createElement('div')
  dock.id = 'musicdock'
  dock.className = 'musicdock hidden'
  dock.innerHTML = `
    <style>
    .musicdock{position:fixed;right:18px;bottom:18px;z-index:250;width:330px;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-family:inherit;overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
    :root[data-bg="image"] .musicdock{background:var(--glass-raise)}
    .musicdock.hidden{display:none}
    .mus-head{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:color-mix(in srgb,var(--panel) 82%,transparent);border-bottom:1px solid var(--line);cursor:grab;user-select:none}
    .mus-head:active{cursor:grabbing}
    .mus-title{font-weight:700;font-size:13px;color:var(--ink);letter-spacing:.5px}
    .mus-hide{background:none;border:none;color:var(--ink3);font-size:18px;cursor:pointer;line-height:1;padding:0 4px;border-radius:6px}
    .mus-hide:hover{color:var(--ink);background:var(--line2)}
    .mus-now{font-size:14px;color:var(--ink);padding:11px 14px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
    .mus-ctrl{display:flex;justify-content:center;align-items:center;gap:8px;padding:8px 14px}
    .mus-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--inset);color:var(--ink2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .12s,background .12s,border-color .12s}
    .mus-btn:hover{border-color:var(--accent);color:var(--accent);transform:scale(1.06)}
    .mus-btn:active{transform:scale(.95)}
    .mus-btn.mus-play{width:44px;height:44px;background-image:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 65%,#000))!important;background-color:transparent!important;border-color:transparent;color:#fff;box-shadow:0 4px 16px color-mix(in srgb,var(--accent) 40%,transparent)}
    .mus-btn.mus-play:hover{color:#fff;border-color:transparent;transform:scale(1.08)}
    .mus-seek{display:flex;align-items:center;gap:8px;padding:0 14px 6px}
    .mus-time{font-size:11px;color:var(--ink3);white-space:nowrap;min-width:88px;text-align:center;font-variant-numeric:tabular-nums}
    .mus-seekbar{flex:1;min-width:0;accent-color:var(--accent);cursor:pointer;height:4px}
    .mus-meta{display:flex;align-items:center;gap:10px;padding:2px 14px 6px}
    .mus-station{flex:1;background:var(--inset);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:5px 8px;font-size:12px;outline:none}
    .mus-voltag{font-size:11px;color:var(--ink3)}
    .mus-vol{width:72px;accent-color:var(--accent);cursor:pointer}
    .mus-srcbar{display:flex;flex-wrap:wrap;gap:6px;padding:4px 14px 8px;border-top:1px solid var(--line)}
    .mus-srclbl{font-size:11px;color:var(--ink3);align-self:center;margin-right:2px}
    .mus-srcchk{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid var(--line);background:var(--inset);color:var(--ink3);cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all .12s}
    .mus-srcchk.on{background:var(--accent);border-color:var(--accent);color:#fff}
    .mus-srcchk:hover{border-color:var(--accent)}
    .mus-lst{display:flex;align-items:center;justify-content:space-between;padding:6px 14px;border-top:1px solid var(--line);cursor:pointer;color:var(--ink2);font-size:12px;font-weight:600}
    .mus-lst:hover{color:var(--accent)}
    .mus-lst .mus-lstarr{transition:transform .15s;color:var(--ink3)}
    .mus-lst.open .mus-lstarr{transform:rotate(90deg)}
    .mus-groups{max-height:210px;overflow-y:auto;padding:0 6px 8px;border-top:1px solid var(--line)}
    .mus-group{margin-top:6px}
    .mus-srchead{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;font-weight:700;color:var(--ink3)}
    .mus-srchead .mus-srcname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mus-srchead .mus-srccount{color:var(--ink3)}
    .mus-song{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--ink2);transition:background .1s}
    .mus-song:hover{background:var(--line2)}
    .mus-song.cur{color:var(--accent);background:var(--accent-soft)}
    .mus-song .mus-songic{width:16px;text-align:center;color:var(--ink3);flex:none}
    .mus-song .mus-songnm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    :root[data-bg="image"] .mus-station,:root[data-bg="image"] .mus-srcchk{background:var(--glass-ctrl)}
    /* 自定义背景:全局按钮半透明规则(如 button{background:var(--glass-ctrl)})
       specificity 更高会覆盖 .mus-btn.mus-play 的渐变,
       导致播放按钮变半透明白底、白图标看不清。
       这里用更高优先级恢复按钮底色与播放渐变。 */
    :root[data-bg="image"] .mus-btn{background:var(--inset)}
    :root[data-bg="image"] .mus-btn.mus-play{background-image:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 65%,#000))!important;background-color:transparent!important}
  </style>
  <div class="mus-head"><span class="mus-title"></span><button class="mus-lang" title="歌名语言"></button><button class="mus-hide" title="">&times;</button></div>
  <div class="mus-now">&mdash;</div>
  <div class="mus-ctrl">
    <button class="mus-btn mus-mode" title=""></button>
    <button class="mus-btn mus-prev" title=""></button>
    <button class="mus-btn mus-play" title=""></button>
    <button class="mus-btn mus-next" title=""></button>
  </div>
  <div class="mus-seek"><span class="mus-time">0:00 / 0:00</span><input class="mus-seekbar" type="range" min="0" max="1000" value="0"></div>
  <div class="mus-meta">
    <select class="mus-station"></select>
    <span class="mus-voltag"></span>
    <input class="mus-vol" type="range" min="0" max="100" value="80">
  </div>
  <div class="mus-srcbar"><span class="mus-srclbl"></span></div>
  <div class="mus-lst"><span class="mus-lstname"></span><span class="mus-lstarr">&#9654;</span></div>
  <div class="mus-groups"></div>
  `
  document.body.appendChild(dock)

  /* ★ MUSIC_FIX_V1(2026-10-22):<audio> 必须挂在 body 上,**不能**留在 dock 里,
   *   也**不能**加 display:none。
   *   ① dock 初始是 display:none(面板收起)—— 媒体元素在 display:none 的祖先里
   *      会被 Chromium 暂停解码 → currentTime 不推进(实测 ct 恒为 0)。
   *   ② 同样,给 audio 自己加 display:none 也会触发同样的暂停。
   *   audio 元素没有 controls 属性时本来就不渲染任何可见 UI,无需隐藏。 */
  const audioEl = document.createElement('audio')
  audioEl.className = 'mus-audio'
  audioEl.preload = 'none'
  document.body.appendChild(audioEl)

  const svg = {
    play: '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 6h2v12H6zM20 6l-9 6 9 6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 6h2v12h-2zM4 6l9 6-9 6z"/></svg>',
    modeOrder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="15" y2="7"/><polyline points="12 4 15 7 12 10"/><line x1="4" y1="13" x2="11" y2="13"/><polyline points="8 10 11 13 8 16"/><line x1="4" y1="19" x2="15" y2="19"/><polyline points="12 16 15 19 12 22"/></svg>',
    modeRepeat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    modeListLoop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="9" fill="currentColor" stroke="none" text-anchor="middle" font-family="sans-serif">1</text></svg>',
    modeShuffle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  }

  const $ = (s) => dock.querySelector(s)
  const headEl = $('.mus-head')
  const titleEl = $('.mus-title')
  const nowEl = $('.mus-now')
  const modeBtn = $('.mus-mode')
  const playBtn = $('.mus-play')
  const prevBtn = $('.mus-prev')
  const nextBtn = $('.mus-next')
  const hideBtn = $('.mus-hide')
  const seekbar = $('.mus-seekbar')
  const timeEl = $('.mus-time')
  const stationSel = $('.mus-station')
  const voltag = $('.mus-voltag')
  const vol = $('.mus-vol')
  const srcbar = $('.mus-srcbar')
  const srclbl = $('.mus-srclbl')
  const lstEl = $('.mus-lst')
  const lstname = $('.mus-lstname')
  const lstarr = $('.mus-lstarr')
  const groupsEl = $('.mus-groups')
  audio = audioEl

  const t = (k) => (window.I18N && window.I18N.t) ? window.I18N.t(k) : k

  function fmtTime(sec) {
    if (sec == null || !Number.isFinite(sec)) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return m + ':' + String(s).padStart(2, '0')
  }
  function updateTime() {
    const d = audio && audio.duration ? audio.duration : NaN
    const durTxt = Number.isFinite(d) ? fmtTime(d) : '--:--'
    timeEl.textContent = fmtTime(audio ? audio.currentTime : 0) + ' / ' + durTxt
  }

  function save() {
    const st = stations[curStation]
    if (!st) return
    try {
      localStorage.setItem(STORE, JSON.stringify({
        station: st.name,
        stationNames: stations.map((x) => x.name),
        idx: curIdx,
        t: audio ? audio.currentTime : 0,
        paused: audio ? audio.paused : true,
        vol: vol.value,
        userPlayed,
        mode,
        sources: sources.map((s) => ({ name: s.name, enabled: s.enabled })),
      }))
    } catch (e) {}
  }

  function restoreAndResume() {
    let d = null
    try { d = JSON.parse(localStorage.getItem(STORE) || 'null') } catch (e) {}
    if (!d) return
    if (d.mode && MODES.indexOf(d.mode) >= 0) { mode = d.mode; renderModeIcon() }
    if (!d.userPlayed) return
    if (Array.isArray(d.sources)) {
      sources.forEach((s) => { const m = d.sources.find((x) => x.name === s.name); if (m) s.enabled = m.enabled })
      renderSrcbar()
    }
    const si = d.stationNames ? stations.findIndex((s) => s.name === d.station) : -1
    if (si < 0) return
    curStation = si
    curIdx = 0
    renderStationOptions()
    if (!d.paused) {
      userPlayed = true
      const idx = Math.min(d.idx || 0, stations[curStation].songs.length - 1)
      playSong(idx, d.t)
    }
  }

  function songTitle(song) {
    if (!song) return '—'
    const title = song.title || {}
    // 当前语言缺失时回退英文/俄文,再回退逻辑名
    return title[langKey()] || title.english || title.russian || song.name
  }
  function songEnabled(song) {
    const s = sources.find((x) => x.name === song.source)
    return !s || s.enabled
  }

  function updateNow() {
    const st = stations[curStation]
    if (!st) { nowEl.textContent = '—'; return }
    const s = st.songs[curIdx]
    nowEl.textContent = s ? songTitle(s) : '—'
  }

  function renderStationOptions() {
    stationSel.innerHTML = ''
    stations.forEach((st, i) => {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = st.name
      stationSel.appendChild(o)
    })
    if (curStation < stations.length) stationSel.value = String(curStation)
  }

  function collectSources() {
    const seen = []
    stations.forEach((st) => st.songs.forEach((s) => {
      if (seen.indexOf(s.source) < 0) seen.push(s.source)
    }))
    sources = seen.map((n) => ({ name: n, enabled: true }))
  }

  function renderSrcbar() {
    srcbar.querySelectorAll('.mus-srcchk').forEach((e) => e.remove())
    sources.forEach((s) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mus-srcchk' + (s.enabled ? ' on' : '')
      b.textContent = (s.enabled ? '✓ ' : '✗ ') + s.name
      b.title = s.name
      b.addEventListener('click', () => {
        s.enabled = !s.enabled
        renderSrcbar()
        renderGroups()
        const st = stations[curStation]
        if (st && !songEnabled(st.songs[curIdx])) {
          const ni = nextIndex(curIdx, 1)
          if (ni >= 0) playSong(ni)
        }
        save()
      })
      srcbar.appendChild(b)
    })
  }

  function renderGroups() {
    groupsEl.innerHTML = ''
    const st = stations[curStation]
    if (!st) return
    let shown = 0
    sources.forEach((s) => {
      if (!s.enabled) return
      const songs = st.songs.filter((x) => x.source === s.name)
      if (!songs.length) return
      shown += songs.length
      const g = document.createElement('div')
      g.className = 'mus-group'
      const h = document.createElement('div')
      h.className = 'mus-srchead'
      const hn = document.createElement('span')
      hn.className = 'mus-srcname'
      hn.textContent = s.name
      const hc = document.createElement('span')
      hc.className = 'mus-srccount'
      hc.textContent = songs.length
      h.appendChild(hn); h.appendChild(hc)
      g.appendChild(h)
      songs.forEach((song) => {
        const it = document.createElement('div')
        it.className = 'mus-song'
        const ic = document.createElement('span')
        ic.className = 'mus-songic'
        ic.textContent = song.name === (stations[curStation] && stations[curStation].songs[curIdx] ? stations[curStation].songs[curIdx].name : '') ? '▶' : '♫'
        const nm = document.createElement('span')
        nm.className = 'mus-songnm'
        nm.textContent = songTitle(song)
        it.appendChild(ic); it.appendChild(nm)
        it.addEventListener('click', () => {
          const idx = stations[curStation].songs.findIndex((x) => x.rel === song.rel)
          if (idx >= 0) playSong(idx)
        })
        g.appendChild(it)
      })
      groupsEl.appendChild(g)
    })
    lstname.textContent = t('music.songs') + ' (' + shown + ')'
    groupsEl.style.display = listOpen ? '' : 'none'
    lstEl.classList.toggle('open', listOpen)
  }

  function nextIndex(from, dir) {
    const st = stations[curStation]
    if (!st || !st.songs.length) return -1
    const n = st.songs.length
    for (let k = 1; k <= n; k++) {
      const idx = (((from + dir * k) % n) + n) % n
      if (songEnabled(st.songs[idx])) return idx
    }
    return -1
  }
  // 选下一首:dir: 1 next, -1 prev。
  // ★ MUSIC_MODE_V2:四模式语义 —
  //   order    顺序(到末尾返回 -1 = 停止)
  //   listloop 列表循环(末尾绕回开头)
  //   repeat   单曲循环(永远返回当前这首)
  //   shuffle  随机(不重复挑当前这首)
  function advance(dir) {
    const st = stations[curStation]
    if (!st || !st.songs.length) return -1
    if (mode === 'repeat') {
      // ★ 单曲循环:重播当前这首(不是换歌)。当前首被禁用时退化为顺序下一首。
      if (songEnabled(st.songs[curIdx])) return curIdx
      return nextIndex(curIdx, dir)
    }
    if (mode === 'shuffle') {
      const idxs = st.songs.map((x, i) => songEnabled(x) ? i : -1).filter((i) => i >= 0)
      if (!idxs.length) return -1
      if (idxs.length === 1) return idxs[0]
      let pick
      do { pick = idxs[Math.floor(Math.random() * idxs.length)] } while (pick === curIdx)
      return pick
    }
    if (mode === 'order') {
      for (let k = 1; k <= st.songs.length; k++) {
        const idx = curIdx + dir * k
        if (idx < 0 || idx >= st.songs.length) return -1
        if (songEnabled(st.songs[idx])) return idx
      }
      return -1
    }
    // listloop:nextIndex 内部会绕回
    return nextIndex(curIdx, dir)
  }
  function renderModeIcon() {
    if (!modeBtn) return
    modeBtn.innerHTML = mode === 'repeat' ? svg.modeRepeat
      : (mode === 'shuffle' ? svg.modeShuffle
        : (mode === 'listloop' ? svg.modeListLoop : svg.modeOrder))
    modeBtn.title = t('music.mode.' + mode)
  }

  function playSong(i, seekT) {
    const st = stations[curStation]
    if (!st || !st.songs.length) return
    if (i < 0 || i >= st.songs.length || !songEnabled(st.songs[i])) return
    curIdx = i
    const s = st.songs[curIdx]
    if (!s) return
    userPlayed = true
    const url = '/api/music/audio?rel=' + encodeURIComponent(s.rel)
    /* ★ MUSIC_FIX_V1(2026-10-22):切歌不再"先 load() 再改 src"(错序)。
     *   旧写法 audio.src=X; audio.load(); audio.play() —— load() 会 abort
     *   当前资源并把媒体元素复位,正在播的声音被硬生生掐断
     *   (用户报"音乐播放和切换会中断")。
     *   实测(无头 Edge 对照 A/B/C 三写法):把 load() 放在 src 赋值【之后】、
     *   play() 之前,启动延迟与旧写法一致(2.5s 时 ct=2.42s);
     *   完全去掉 load() 则启动明显变慢(2.5s 时 ct 仍为 0)。
     *   → 正确顺序:改 src → load()(在新资源上) → play()。 */
    if (audio.getAttribute('src') === url) {
      // 同一首(单曲循环):不停资源,直接回到开头重播
      try { audio.currentTime = 0 } catch (e) {}
    } else {
      audio.setAttribute('src', url)
      audio.load()
    }
    const p = audio.play()
    if (p) p.catch((e) => {
      // ★ AbortError = 被新的 play/load 抢占(切歌时正常);其余是真错,提示用户
      if (e && e.name === 'AbortError') return
      const msg = (e && e.message) ? e.message : String(e)
      nowEl.textContent = '⚠ 播放失败:' + msg
      playBtn.innerHTML = svg.play
    })
    if (seekT != null && seekT > 0) {
      const onMeta = () => {
        try { if (audio.duration > seekT) audio.currentTime = seekT } catch (e) {}
        audio.removeEventListener('loadedmetadata', onMeta)
      }
      audio.addEventListener('loadedmetadata', onMeta)
    }
    updateNow()
    renderGroups()
    save()
  }

  function togglePlay() {
    if (!stations.length) { load(); return }
    if (!audio.getAttribute('src')) { playSong(curIdx); return }
    if (audio.paused) {
      userPlayed = true
      const p = audio.play()
      if (p) p.catch(() => {})
    } else audio.pause()
    save()
  }

  function refreshLang() {
    titleEl.textContent = t('music.title')
    hideBtn.title = t('music.hide')
    voltag.textContent = t('music.vol')
    srclbl.textContent = t('music.source')
    renderModeIcon()
    updateNow()
    renderGroups()
  }

  async function load() {
    if (loading) return
    /* ★ MUSIC_FIX_V1:站点列表已加载过就不再重复 fetch。
     *   旧逻辑每次 show() 都重新 load() → restoreAndResume() → playSong()
     *   → 重设 audio.src 并从头播,于是"打开音乐面板"就打断了正在放的歌。 */
    if (stationsLoaded) return
    if (loadFailed) return
    loading = true
    try {
      const r = await fetch('/api/music')
      const d = await r.json()
      if (!d.ready) { setTimeout(load, 1500); return }
      stations = d.stations || []
      if (curStation >= stations.length) curStation = 0
      collectSources()
      renderStationOptions()
      refreshLang()
      renderSrcbar()
      stationsLoaded = true
      restoreAndResume()
    } catch (e) {
      setTimeout(load, 3000)
    } finally {
      loading = false
    }
  }

  // ---- drag ----
  let drag = { on: false, dx: 0, dy: 0 }
  headEl.addEventListener('pointerdown', (e) => {
    // ★ 标题栏上的按钮(隐藏 × 等)是点击目标,不启动拖动;
    //   否则 setPointerCapture 会吞掉真实点击的 click(无法隐藏/转发)。
    if (e.target && e.target.closest && e.target.closest('button')) return
    drag.on = true
    drag.dx = e.clientX - dock.offsetLeft
    drag.dy = e.clientY - dock.offsetTop
    headEl.setPointerCapture && headEl.setPointerCapture(e.pointerId)
  })
  headEl.addEventListener('pointermove', (e) => {
    if (!drag.on) return
    const x = Math.min(Math.max(e.clientX - drag.dx, 4), window.innerWidth - dock.offsetWidth - 4)
    const y = Math.min(Math.max(e.clientY - drag.dy, 4), window.innerHeight - dock.offsetHeight - 4)
    dock.style.left = x + 'px'
    dock.style.top = y + 'px'
    dock.style.right = 'auto'
    dock.style.bottom = 'auto'
  })
  headEl.addEventListener('pointerup', () => { drag.on = false })

  renderModeIcon()
  playBtn.innerHTML = svg.play
  prevBtn.innerHTML = svg.prev
  nextBtn.innerHTML = svg.next

  playBtn.addEventListener('click', () => { togglePlay() })
  modeBtn.addEventListener('click', () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
    renderModeIcon()
    save()
  })
  prevBtn.addEventListener('click', () => { const i = advance(-1); if (i >= 0) playSong(i) })
  nextBtn.addEventListener('click', () => { const i = advance(1); if (i >= 0) playSong(i) })
  /* ★ MUSIC_FIX_V1(2026-10-22):收起面板不暂停音乐(与 MusicUI.hide() 一致)。
     旧写法在此处 audio.pause() —— 点 × 就把歌停了,用户报"音乐播放会中断"。 */
  hideBtn.addEventListener('click', () => { dock.classList.add('hidden'); save() })
  seekbar.addEventListener('input', () => {
    if (audio && audio.duration) audio.currentTime = (seekbar.value / 1000) * audio.duration
    updateTime()
    save()
  })
  stationSel.addEventListener('change', () => {
    curStation = Number(stationSel.value) || 0
    curIdx = 0
    renderGroups()
    const i = stations[curStation].songs.findIndex((x) => songEnabled(x))
    if (i >= 0) playSong(i)
  })
  vol.addEventListener('input', () => { if (audio) audio.volume = vol.value / 100; save() })
  lstEl.addEventListener('click', () => { listOpen = !listOpen; renderGroups() })
  /* MUSIC_LANG_V1:面板歌名语言切换按钮 */
  const LANGS = ['english', 'simp_chinese']
  const LANG_LABEL = { english: 'EN', simp_chinese: '中文' }
  const langBtn = $('.mus-lang')
  function updateLangBtn() { if (langBtn) langBtn.textContent = LANG_LABEL[langKey()] || langKey() }
  function cycleLang() {
    const cur = langKey()
    const i = LANGS.indexOf(cur)
    const next = LANGS[(i + 1) % LANGS.length]
    localStorage.setItem(LANG_STORE, next)
    renderStationOptions()
    updateNow()
    renderGroups()
    updateLangBtn()
  }
  if (langBtn) langBtn.addEventListener('click', cycleLang)
  updateLangBtn()

  audio.addEventListener('timeupdate', () => {
    if (audio.duration && Number.isFinite(audio.duration)) seekbar.value = Math.round((audio.currentTime / audio.duration) * 1000)
    updateTime()
    const now = Date.now()
    if (now - lastSaveT > 2000) { lastSaveT = now; save() }
  })
  audio.addEventListener('loadedmetadata', () => { seekbar.value = 0; updateTime() })
  audio.addEventListener('play', () => { playBtn.innerHTML = svg.pause; save() })
  audio.addEventListener('pause', () => { playBtn.innerHTML = svg.play; save() })
  audio.addEventListener('ended', () => {
    /* ★ 播完自动接下一首:所有模式都走 advance(1)。
     *   order   = 顺序下一首(到列表末尾停)
     *   listloop= 列表循环(末尾绕回开头)
     *   repeat  = 单曲循环(重播当前这首)
     *   shuffle = 随机选播
     * advance() 内部已按模式分流,这里不再重复判断。 */
    const i = advance(1)
    if (i >= 0) { playSong(i); return }
    // 无下一首(order 末尾):回到开头等待,不直接停在当前呕并可重播
    playBtn.innerHTML = svg.play
    audio.currentTime = 0
    audio.pause()
    save()
  })

  window.MusicUI = {
    show() {
      dock.classList.remove('hidden')
      load()
      refreshLang()
      /* ★ MUSIC_FIX_V1(2026-10-22):打开面板【不得】重播。
       *   旧逻辑:show() → load() → restoreAndResume() → playSong()
       *   → 重设 audio.src + audio.load() → 正在放的歌被掐断重头开始。
       *   现在 load() 在列表已加载时直接返回(stationsLoaded 短路),
       *   这里只做"若因暂停而停着,则恢复播放",不碰 src。 */
      if (audio && audio.paused && audio.getAttribute('src') && userPlayed) {
        const p = audio.play()
        if (p) p.catch(() => {})
      }
      wasPlaying = false
    },
    /* ★ MUSIC_FIX_V1:收起面板【不得】暂停音乐 —— 收起只是隐藏 UI,
     *   音乐应当继续在后台放。用户报"音乐播放会中断"的另一处根因。 */
    hide() { dock.classList.add('hidden'); save() },
    toggle() { if (dock.classList.contains('hidden')) this.show(); else this.hide() },
    refreshLang,
  }

  if (window.I18N && window.I18N.onLangChange) {
    window.I18N.onLangChange(() => refreshLang())
  }

  // init: fetch stations and resume playback in background (dock stays hidden unless opened)
  load()
})()
export const MusicUI = window.MusicUI
