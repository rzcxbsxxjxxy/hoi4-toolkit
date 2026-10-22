/**
 * 真浏览器验收(无头 Edge + CDP,Node 22 内置 WebSocket)。
 *
 * 覆盖本轮 6 项需求里能在浏览器里验证的部分:
 *   ① 壁纸滑条:改值 → CSS 变量真变 → 面板透明度跟着变
 *   ② 主页入口:4 个新卡片真在 DOM 里
 *   ③ defines 差异:面板能开、行数 > 0、原版→模组两列都在
 *   ④⑤⑥ 地图:DLC 面板、state 属性、悬停出属性块
 *
 * ★ 铁律(见记忆):HTTP 200 + node --check 都发现不了契约不一致,
 *   必须真浏览器里查 window.X 真挂上、DOM 真有内容。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = 'http://127.0.0.1:5173'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9411

let pass = 0
const fails = []
function t(name, ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (msg ? ' :: ' + msg : '')); console.log('  ✗ ' + name + (msg ? ' :: ' + msg : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询直到 expr 返回 true;超时返回 false。
 *  ★ 必须 === true:evalJs 抛异常时返回 {__err:...} 对象,是 truthy,
 *    只判真值会把"页面还没解析完"误判成"条件已满足"。 */
async function waitFor(cdp, expr, tries = 40, gap = 300) {
  for (let i = 0; i < tries; i++) {
    if ((await cdp.evalJs(expr)) === true) return true
    await sleep(gap)
  }
  return false
}

/* ── 最小 CDP 客户端 ── */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.errs = [] }
  static async open(url) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    const tgt = await r.json()
    const ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    c.targetId = tgt.id
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        c.errs.push((d.exception && d.exception.description) || d.text || '')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.errs.push(m.params.args.map((a) => a.value || a.description || '').join(' '))
      }
    }
    await c.send('Runtime.enable')
    await c.send('Page.enable')
    // ★ 必须 bringToFront:同一浏览器里开第 3 个标签页时它是后台的,
    //   无头 Edge 会节流后台标签页的 setTimeout/fetch —— 表现就是
    //   「面板已显示但数据迟迟不来」,轮询再久也不够。激活后才正常。
    try { await c.send('Page.bringToFront') } catch {}
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res) => this.waiters.set(id, (m) => res(m.result)))
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }
    return r.result.value
  }
  async goto(url) {
    try { await this.send('Page.bringToFront') } catch {}
    await this.send('Page.navigate', { url })
    await sleep(900)
  }
  close() { try { this.ws.close() } catch {} }
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4-edge-'))
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) }
  }

  let cdp
  try {
    /* ══ ① 壁纸调节条 ══ */
    console.log('\n=== 设置页 · 壁纸调节 ===')
    cdp = await CDP.open(BASE + '/settings')
    await waitFor(cdp, `(()=>{const e=document.getElementById('tGlass');return e?true:false})()`)
    const has = await cdp.evalJs(`(()=>{
      const ids=['tuneRow','tGlass','tDim','tBlur','tReset'];
      const o={}; for(const i of ids) o[i]=!!document.getElementById(i); return o;
    })()`)
    t('调节条 4 个控件 + 容器都在 DOM', has && has.tuneRow && has.tGlass && has.tDim && has.tBlur && has.tReset, JSON.stringify(has))

    // ⚠ #tGlass 是静态 HTML,DOM 一解析就有;真正给 tuneRow  打 off 标记的
    //   是 settings.js 里的 renderAppearance → syncTuneInputs(含 AP 动态 import)。
    //   所以这里必须等"状态被渲染出来",不能只等"元素存在"。
    const offReady = await waitFor(cdp, `(()=>{const r=document.getElementById('tuneRow');
      return r ? r.classList.contains('off') : false})()`)
    const offByDefault = await cdp.evalJs(`(()=>{const r=document.getElementById('tuneRow');return r?r.classList.contains('off'):null})()`)
    t('没选壁纸时调节条置灰禁用(off)', offReady && offByDefault === true, 'off=' + offByDefault)

    // 塞一张壁纸,确认控件解禁且变量真写进 <html>
    await cdp.evalJs(`(()=>{
      const cv=document.createElement('canvas'); cv.width=cv.height=8;
      const g=cv.getContext('2d'); g.fillStyle='#3a5a8c'; g.fillRect(0,0,8,8);
      const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      A.bgImage=cv.toDataURL('image/png'); A.theme='light';
      localStorage.setItem('gui.appearance', JSON.stringify(A));
      return true;
    })()`)
    await cdp.goto(BASE + '/settings')
    await waitFor(cdp, `document.documentElement.getAttribute('data-bg')==='image'`)
    const onState = await cdp.evalJs(`(()=>{
      const root=document.documentElement;
      const tr=document.getElementById('tuneRow');
      return {
        off: tr ? tr.classList.contains('off') : null,
        dataBg: root.getAttribute('data-bg'),
        glassBefore: root.style.getPropertyValue('--glass-a'),
        computed: getComputedStyle(document.documentElement).getPropertyValue('--glass-a').trim(),
      };
    })()`)
    t('有壁纸后调节条解禁', onState.off === false, JSON.stringify(onState))
    t('html[data-bg=image] 已置位', onState.dataBg === 'image', 'data-bg=' + onState.dataBg)
    t('默认未调时 --glass-a 为空(跟随主题)', !onState.glassBefore, 'got=' + onState.glassBefore)

    // 拖玻璃滑条 → 内联变量真变 + 面板透明度真变
    const glass = await cdp.evalJs(`(()=>{
      const inp=document.getElementById('tGlass');
      inp.value='38';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      const root=document.documentElement;
      const card=document.querySelector('.card');
      const cs=card?getComputedStyle(card):null;
      return {
        inline: root.style.getPropertyValue('--glass-a'),
        label: document.getElementById('tGlassV').textContent,
        panelVar: getComputedStyle(root).getPropertyValue('--glass').trim(),
        cardBg: cs?cs.backgroundColor:'',
        dim: root.style.getPropertyValue('--bg-dim'),
        blur: root.style.getPropertyValue('--bg-blur'),
      };
    })()`)
    t('拖玻璃滑条 → --glass-a 内联生效', glass.inline === '0.38', 'got=' + glass.inline)
    t('读数显示 38%', glass.label === '38%', 'got=' + glass.label)
    t('合成出 rgba 玻璃底色', /rgba?\(/.test(glass.panelVar), 'got=' + glass.panelVar)
    // ★ 未设值时 appearance.js 走 setOrClear(..., null) → removeProperty,
    //   刻意不写内联变量,让 theme-vars.css 各主题默认值接管。
    //   曾经误判成"联动失败",其实是期望写错。
    t('压暗/模糊未设值时不写内联变量(交主题默认值)', glass.dim === '' && glass.blur === '', 'dim=' + glass.dim + ' blur=' + glass.blur)

    const dimBlur = await cdp.evalJs(`(()=>{
      const d=document.getElementById('tDim'), b=document.getElementById('tBlur');
      d.value='45'; d.dispatchEvent(new Event('input',{bubbles:true}));
      b.value='8';  b.dispatchEvent(new Event('input',{bubbles:true}));
      const r=document.documentElement;
      return {dim:r.style.getPropertyValue('--bg-dim'), blur:r.style.getPropertyValue('--bg-blur'),
              dimL:document.getElementById('tDimV').textContent, blurL:document.getElementById('tBlurV').textContent};
    })()`)
    t('压暗滑条 → --bg-dim=0.45', dimBlur.dim === '0.45', 'got=' + dimBlur.dim)
    t('模糊滑条 → --bg-blur=8px', dimBlur.blur === '8px', 'got=' + dimBlur.blur)
    t('两条读数同步', dimBlur.dimL === '45%' && dimBlur.blurL === '8px', JSON.stringify(dimBlur))

    // 持久化 + 恢复默认
    const persist = await cdp.evalJs(`(()=>{
      const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      A.glassA=0.38; A.bgDim=0.45; A.bgBlur=8;
      localStorage.setItem('gui.appearance', JSON.stringify(A)); return true;
    })()`)
    await cdp.goto(BASE + '/settings')
    await waitFor(cdp, `(()=>{const e=document.getElementById('tGlass');return e?e.value==='38':false})()`)
    const reloaded = await cdp.evalJs(`(()=>{
      const r=document.documentElement;
      const e=document.getElementById('tGlass'), v=document.getElementById('tGlassV');
      return {g:r.style.getPropertyValue('--glass-a'), d:r.style.getPropertyValue('--bg-dim'),
              slider: e?e.value:'', label: v?v.textContent:''};
    })()`)
    t('重载后滑条值从 localStorage 恢复', reloaded.slider === '38', 'got=' + reloaded.slider)
    t('重载后 CSS 变量仍生效', reloaded.g === '0.38', 'got=' + reloaded.g)

    const reset = await cdp.evalJs(`(()=>{
      document.getElementById('tReset').click();
      const r=document.documentElement;
      return {g:r.style.getPropertyValue('--glass-a'), label:document.getElementById('tGlassV').textContent};
    })()`)
    t('「恢复默认」清掉内联覆盖', reset.g === '', 'got=' + reset.g)
    t('恢复后读数显示「主题默认」', reset.label === '主题默认', 'got=' + reset.label)

    // 越界防护
    const clamped = await cdp.evalJs(`(()=>{
      const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      A.glassA=0.02; A.bgDim=5; A.bgBlur=-3; A.bgImage='x';
      localStorage.setItem('gui.appearance', JSON.stringify(A));
      return true;
    })()`)
    await cdp.goto(BASE + '/settings')
    await waitFor(cdp, `(()=>{const e=document.getElementById('tGlass');return e?e.value==='30':false})()`)
    const clampRes = await cdp.evalJs(`(()=>{const e=document.getElementById('tGlass');return e?e.value:''})()`)
    t('越界值被夹到下限 30(不会变全透明)', clampRes === '30', 'got=' + clampRes)
    await cdp.evalJs(`(()=>{const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}'); delete A.bgImage; localStorage.setItem('gui.appearance',JSON.stringify(A)); return 1})()`)
    cdp.close()

    /* ══ ② 主页入口 ══ */
    console.log('\n=== 主页 · 入口完整性 ===')
    cdp = await CDP.open(BASE + '/')
    await waitFor(cdp, `document.querySelectorAll('.card').length>0`)
    const cards = await cdp.evalJs(`(()=>{
      const a=[...document.querySelectorAll('.card')];
      return a.length?{total:a.length, hrefs:a.map(x=>x.getAttribute('href'))}:{total:0,hrefs:[]};
    })()`)
    t('主页卡片数 = 20(与顶栏一致)', cards.total === 20, '实际 ' + cards.total)
    for (const h of ['/defines', '/worldmap', '/modrel', '/settings']) {
      t('主页有 ' + h + ' 入口', cards.hrefs.includes(h), 'hrefs=' + cards.hrefs.join(' '))
    }
    const noIcon = await cdp.evalJs(`(()=>{
      const a=[...document.querySelectorAll('.card .cic svg')];
      return {svg:a.length, cards:document.querySelectorAll('.card').length};
    })()`)
    t('每张卡片都有图标 svg', noIcon.svg === noIcon.cards, noIcon.svg + '/' + noIcon.cards)
    cdp.close()

    /* ══ ③ defines 差异 ══ */
    console.log('\n=== defines · 原版 vs 模组 ===')
    cdp = await CDP.open(BASE + '/defines')
    // ★ 等 onclick 真的挂上,不能只等元素存在:#diffBtn 是静态 HTML,
    //   DOM 一解析就有,而 wireDiff() 在 defines.js 里才跑。
    //   「等骨架≠等绑定」—— 只等骨架会让 click 打在未绑定的按钮上,
    //   面板永远不开,看起来像功能坏了(探针单跑却是好的)。
    let boot = false
    for (let i = 0; i < 60; i++) {
      boot = (await cdp.evalJs(`(()=>{const b=document.getElementById('diffBtn');return b&&b.onclick?true:false})()`)) === true
      if (boot) break
      await sleep(300)
    }
    t('defines 页 #diffBtn 就绪且已绑定', boot)
    await cdp.evalJs(`document.getElementById('diffBtn').click()`)
    // 差异接口要扫 34 个 defines 文件,等面板真出内容而不是死等固定时长
    let grew = false
    for (let i = 0; i < 80; i++) {
      grew = (await cdp.evalJs(`document.querySelectorAll('#diffBody tr').length>0`)) === true
      if (grew) break
      await sleep(400)
    }
    const diff = await cdp.evalJs(`(()=>{
      const rows=[...document.querySelectorAll('#diffBody tr')];
      const first=rows[0];
      const panel=document.getElementById('diffPanel');
      const groups=document.getElementById('groups');
      const hintEl=document.getElementById('diffHint');
      return {
        // ⚠ display 是空串表示"用 CSS 默认值(显示)",不是"隐藏"。
        //   判隐藏要用 getComputedStyle 或 offsetParent,不能比 'none'。
        visible: panel ? getComputedStyle(panel).display!=='none' : false,
        groupsHidden: groups ? getComputedStyle(groups).display==='none' : false,
        rows: rows.length,
        hint: hintEl ? hintEl.textContent.replace(/\\s+/g,' ').trim() : '',
        firstHtml: first?first.innerText.replace(/\\s+/g,' ').trim().slice(0,120):'',
        changed: document.querySelectorAll('#diffBody tr.changed').length,
        same: document.querySelectorAll('#diffBody tr.same').length,
        added: document.querySelectorAll('#diffBody tr.added').length,
        arrowCount: document.querySelectorAll('#diffBody .arrow').length,
        deltaCount: document.querySelectorAll('#diffBody .dl.up, #diffBody .dl.dn').length,
      };
    })()`)
    t('差异面板已显示', diff.visible, 'visible=' + diff.visible)
    t('原表已隐藏(二选一)', diff.groupsHidden, 'groupsHidden=' + diff.groupsHidden)
    t('差异行数 > 100(真实模组)', diff.rows > 100, '实际 ' + diff.rows)
    t('真改动行有内容', diff.changed > 0, 'changed=' + diff.changed)
    t('存在「原版 → 模组」箭头', diff.arrowCount > 0, 'arrow=' + diff.arrowCount)
    t('存在差值徽标', diff.deltaCount > 0, 'delta=' + diff.deltaCount)
    t('汇总含「真改动」计数', /真改动/.test(diff.hint), diff.hint)

    // 三态筛选
    await cdp.evalJs(`(()=>{
      const btn=[...document.querySelectorAll('#diffKind button')].find(b=>b.dataset.k==='same');
      if(btn) btn.click();
      return true;
    })()`)
    // 筛选要重新拉接口,轮询到行数稳定变化而不是死等
    let filtered = false
    for (let i = 0; i < 30; i++) {
      const r = await cdp.evalJs(`(()=>({same:document.querySelectorAll('#diffBody tr.same').length,
                                          changed:document.querySelectorAll('#diffBody tr.changed').length}))()`)
      if (r === true || (r && r.changed === 0 && r.same > 0)) { filtered = true; break }
      await sleep(300)
    }
    const sameOnly = await cdp.evalJs(`(()=>({
      rows: document.querySelectorAll('#diffBody tr').length,
      same: document.querySelectorAll('#diffBody tr.same').length,
      changed: document.querySelectorAll('#diffBody tr.changed').length,
    }))()`)
    t('「同值重写」筛选只剩同值行', filtered && sameOnly.changed === 0 && sameOnly.same > 0, JSON.stringify(sameOnly))

    const firstSame = await cdp.evalJs(`(()=>{
      const r=document.querySelector('#diffBody tr.same');
      return r?r.innerText.replace(/\\s+/g,' ').trim().slice(0,140):'';
    })()`)
    t('同值行的原版与模组值一致(注释差异不算改动)', /→/.test(firstSame), firstSame)
    cdp.close()

    /* ══ ④⑤⑥ 地图:DLC 面板 + state 属性 ══ */
    console.log('\n=== 世界地图 · DLC 与 state 属性 ===')
    cdp = await CDP.open(BASE + '/worldmap')
    let mapReady = false
    for (let i = 0; i < 80; i++) {
      // ⚠ S 是 worldmap.js 的模块作用域变量,外部(CDP eval)读不到 ——
      //   只能看 DOM 上的真实产物(HUD 文本、面板内容)。
      // ⚠ evalJs 异常时返回 {__err} 对象(truthy),必须 === true。
      const r = await cdp.evalJs(`(()=>{const h=document.getElementById('hud');return h?/\\d+ state/.test(h.textContent):false})()`)
      mapReady = r === true
      if (mapReady) break
      await sleep(500)
    }
    t('地图模型就绪(HUD 显示 state 数)', mapReady)
    // 通过 DOM 反推:HUD 会显示省份/state 数,来源条显示各来源贡献
    const dom = await cdp.evalJs(`(()=>{
      const hud=document.getElementById('hud'), src=document.getElementById('srcbar');
      return {hud: hud?hud.textContent.replace(/\\s+/g,' ').trim():'',
              src: src?src.innerText.replace(/\\s+/g,' ').trim():''};
    })()`)
    t('来源条显示各来源贡献', dom.src.length > 30, dom.src.slice(0, 140))

    // DLC 面板(它直接渲染 meta.dlc)
    await cdp.evalJs(`document.getElementById('toggleDlc') && document.getElementById('toggleDlc').click()`)
    await sleep(900)
    const dlcPanel = await cdp.evalJs(`(()=>{
      const el=document.getElementById('dlcbar');
      if(!el) return {on:false, text:'', lock:0, cb:0};
      return {on: el.classList.contains('on'), text: el.innerText.replace(/\\s+/g,' ').trim(),
              lock: el.querySelectorAll('.gr').length,
              cb: el.querySelectorAll('input[data-dlc]').length};
    })()`)
    t('DLC 面板可展开', dlcPanel.on)
    t('★ DLC 扫描到 30+ 个', /3[0-9] 个/.test(dlcPanel.text), dlcPanel.text.slice(0, 200))
    t('★ 列出受门控的 DLC', dlcPanel.lock >= 1, 'gr=' + dlcPanel.lock + ' text=' + dlcPanel.text.slice(0, 160))
    t('★ 门控点名 NCNS / Gotterdammerung', /No Compromise/.test(dlcPanel.text) && /Gotterdammerung/.test(dlcPanel.text), dlcPanel.text.slice(0, 240))

    // 悬停出 state 属性块 —— 用 CDP Input 真鼠标(合成 mouseover 不改 CSS)
    // 从 canvas 尺寸与省份数据反推一个屏幕坐标:直接用地图中心附近的点,
    // 让 hover() 的 9px 命中逻辑去捞。
    const pos = await cdp.evalJs(`(()=>{
      const st=document.getElementById('stage').getBoundingClientRect();
      return {cx: st.left+st.width/2, cy: st.top+st.height/2,
              l:st.left, t:st.top, w:st.width, h:st.height};
    })()`)
    // 扫一圈找命中点:每 40px 试一次,直到 tip 里出现 .sdb
    let found = null
    for (let ring = 0; ring < 26 && !found; ring++) {
      for (let a = 0; a < 8 && !found; a++) {
        const ang = (a / 8) * Math.PI * 2
        const r = 40 + ring * 34
        const x = Math.round(pos.cx + Math.cos(ang) * r)
        const y = Math.round(pos.cy + Math.sin(ang) * r * 0.6)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
        await sleep(35)
        const has = await cdp.evalJs(`(()=>{const t=document.getElementById('tip');
          return getComputedStyle(t).display!=='none' && !!t.querySelector('.sdb')})()`)
        if (has) found = { x, y }
      }
    }
    t('★ 悬停命中省份并展开 state 属性块', !!found, JSON.stringify(found))
    if (found) {
      const tip = await cdp.evalJs(`(()=>{
        const t=document.getElementById('tip');
        return {text: t.innerText.replace(/\\s+/g,' ').trim().slice(0,300),
                keys: [...t.querySelectorAll('.sdb .k')].map(x=>x.textContent)};
      })()`)
      console.log('    悬停内容: ' + tip.text)
      t('★ 属性块含「人力」', tip.keys.includes('人力'), JSON.stringify(tip.keys))
      t('★ 属性块含「建筑」', tip.keys.includes('建筑'), JSON.stringify(tip.keys))
      t('★ 属性块至少 3 个字段', tip.keys.length >= 3, JSON.stringify(tip.keys))
    }

    // DLC 勾选往返
    const tog = await cdp.evalJs(`(async()=>{
      const r=await fetch('/api/worldmap/dlc',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({on:['dlc049_no_compromise_no_surrender']})});
      const j=await r.json();
      const g=j.gates&&j.gates['No Compromise, No Surrender'];
      return {ok:j.ok, enabled:j.enabled, gateTotal:j.gateTotal, active:g?g.active:null};
    })()`)
    t('DLC 勾选接口生效', tog.ok === true, JSON.stringify(tog))
    t('★ 勾选 NCNS 后门控标为已启用', tog.active === true, JSON.stringify(tog))
    const tog2 = await cdp.evalJs(`(async()=>{
      const r=await fetch('/api/worldmap/dlc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:[]})});
      const j=await r.json();
      const g=j.gates&&j.gates['No Compromise, No Surrender'];
      return {active:g?g.active:null};
    })()`)
    t('取消勾选后门控回到未启用', tog2.active === false, JSON.stringify(tog2))

    const jsErr = cdp.errs.filter((e) => !/favicon/.test(e))
    t('地图页无未捕获 JS 异常', jsErr.length === 0, jsErr.slice(0, 2).join(' | '))
    cdp.close()
  } catch (e) {
    fails.push('异常: ' + e.message)
    console.log('  ✗ 异常 ' + e.message + '\n' + (e.stack || ''))
  } finally {
    try { child.kill() } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  console.log(`\n真浏览器验收: ${pass}/${pass + fails.length} 通过`)
  for (const f of fails) console.log('  ✗ ' + f)
  if (fails.length) process.exit(1)
}

main()
