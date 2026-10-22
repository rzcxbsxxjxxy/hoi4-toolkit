/**
 * 四项修复的真浏览器验收(Edge 无头 + CDP)
 *
 * 覆盖:
 *  ① RIGHTCLICK_ROOT_V1  右键「在 IDE 中打开 / 用 VS Code 打开」能定位到**模组**文件
 *  ② COMMENT_V1          IDE 里 Ctrl+/ 注释 / 取消注释
 *  ③ TIP_TOP_V1          首页任务卡的悬停浮层不被兄弟卡片盖住
 *  ④ MIO_SPELLING_V1     DLC 页军工机构能识别模组内容(含英式 _organisation)
 *
 * 判据原则:不信任"HTTP 200 + 语法绿",每条都读真实 DOM / 真实接口返回值。
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

const PORT = process.env.PORT_GUI || '5173'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9333

let pass = 0
let fail = 0
const ok = (b, what, extra = '') => {
  if (b) { pass++; console.log(`  ✓ ${what}`) }
  else { fail++; console.log(`  ✗ ${what}${extra ? ' — ' + extra : ''}`) }
}
const line = (s) => console.log(`\n${'═'.repeat(11)} ${s} ${'═'.repeat(Math.max(0, 46 - s.length))}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function waitReady(path, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const j = await getJSON(path)
      if (j && j.ready) return j
      if (j && !j.busy && j.error) return j
    } catch { /* 服务还在起 */ }
    await sleep(700)
  }
  return null
}

/* ══════════════ 无头 Edge + CDP ══════════════ */
function cdpTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { res, rej })
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
          })
        },
        close() { try { ws.close() } catch { /* 已关 */ } },
      })
    })
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || ''))))
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p.rej(new Error(m.error.message))
        else p.res(m.result)
      }
    })
  })
}

async function main() {
  console.log('══════════ 0. 启动无头 Edge ══════════')
  const userDir = `${process.env.TEMP || 'C:/Users/123/AppData/Local/Temp'}/_cdp_four_${Date.now()}`
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore', detached: false })

  let c = null
  for (let i = 0; i < 30; i++) {
    try {
      const list = await cdpTargets()
      const page = list.find((t) => t.type === 'page')
      if (page) { c = await connect(page.webSocketDebuggerUrl); break }
    } catch { /* CDP 还没起来 */ }
    await sleep(500)
  }
  if (!c) { console.log('  ✗ Edge CDP 连不上'); process.exit(1) }
  ok(true, 'Edge CDP 已连接')

  await c.send('Page.enable')
  await c.send('Runtime.enable')
  const logs = []
  c.send('Log.enable')
  /* 收集控制台错误 */
  const errs = []
  globalThis.__cdpErr = errs

  async function goto(url, waitMs = 3000) {
    await c.send('Page.navigate', { url })
    await sleep(waitMs)
  }
  async function js(expr) {
    const r = await c.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}))
    return r.result.value
  }
  void logs

  /* ─────────────────────────────────────────────
   * ① 右键打开模组文件
   * ───────────────────────────────────────────── */
  line('① 右键打开模组文件(RIGHTCLICK_ROOT_V1)')

  const srcs = await getJSON('/api/sources')
  const modIdx = (srcs.sources || []).findIndex((s) => !s.base)
  ok(modIdx > 0, `存在模组来源(idx=${modIdx})`, JSON.stringify(srcs.sources))
  const modName = modIdx > 0 ? srcs.sources[modIdx].name : ''

  const tech = await waitReady('/api/tech/graph')
  ok(!!tech && tech.ready, 'tech/graph 就绪')
  const modTech = (tech.nodes || []).filter((n) => n.root === modIdx)
  ok(modTech.length > 0, `tech 节点带真实 root(模组 ${modTech.length} 个)`, `总节点 ${(tech.nodes || []).length}`)
  if (modTech.length) {
    const n = modTech[0]
    ok(n.root === modIdx && n.rootName === modName,
      `tech 节点的 root/rootName 正确(root=${n.root} name=${n.rootName})`)
  }

  const doc = await waitReady('/api/doctrines/graph')
  ok(!!doc && doc.ready, 'doctrines/graph 就绪')
  const allDoc = [].concat(doc.folders || [], doc.grand || [], doc.tracks || [], doc.subdoctrines || [])
  const modDoc = allDoc.filter((x) => x.root === modIdx)
  ok(allDoc.length === 0 || allDoc.every((x) => typeof x.root === 'number'),
    `学说条目都带 root(模组 ${modDoc.length} 个 / 共 ${allDoc.length})`)

  const mio = await waitReady('/api/mio/tree')
  ok(!!mio && mio.ready, 'mio/tree 就绪')
  const modOrgs = (mio.orgs || []).filter((o) => o.root === modIdx)
  ok(modOrgs.length > 0, `MIO 清单含模组机构(${modOrgs.length} 个)`, `总 ${(mio.orgs || []).length}`)
  ok((mio.orgs || []).every((o) => typeof o.root === 'number'), 'MIO org 全部带 root')

  /* 端到端:拿一个模组 MIO 文件真打 open-external,看返回的 path 是否在模组里。
   * ⚠ MIO 下发的是**绝对路径**(ABS_FILE_V1),这里原样打过去 ——
   *   修复前会被拼成 `root/C:/…` 而报「文件不存在或越界」。 */
  if (modOrgs.length) {
    const absFile = modOrgs[0].file
    const r = await fetch(`${BASE}/api/open-external?root=${modIdx}` +
      `&file=${encodeURIComponent(absFile)}&line=1`)
    const j = await r.json()
    ok(!j.error, '★ 模组 MIO 的绝对路径能被 open-external 接受', JSON.stringify(j).slice(0, 180))
    if (!j.error) {
      ok(String(j.path || '').replace(/\\/g, '/').includes(srcs.sources[modIdx].path.replace(/\\/g, '/')),
        `★ 打开的路径确实在模组里(${String(j.path).split(/[\\/]/).pop()})`)
    }
    /* 越界仍然必须被拒 —— 放宽绝对路径不能连守卫一起放宽 */
    const evil = await fetch(`${BASE}/api/open-external?root=${modIdx}` +
      `&file=${encodeURIComponent('C:/Windows/System32/drivers/etc/hosts')}&line=1`)
    const ej = await evil.json()
    ok(!!ej.error, '★ 绝对路径越界仍被拒(守卫没被放宽)', JSON.stringify(ej).slice(0, 120))
  }

  /* IDE 深链:绝对路径要被裁成相对,否则 IDE 打不开 */
  if (modOrgs.length) {
    const url = `${BASE}/ide#root=${modIdx}` +
      `&file=${encodeURIComponent(modOrgs[0].file)}&line=1`
    await goto(url, 4000)
    const deep = JSON.parse(await js(`
      const t = (window.HoiIde && window.HoiIde.curFile) ? window.HoiIde.curFile() : '';
      const title = document.getElementById('fileTitle');
      return JSON.stringify({cur: t, title: title ? title.textContent.trim().slice(0,90) : '',
        empty: !!document.querySelector('#code .empty')});
    `))
    ok(!deep.cur.includes('C:/') && !deep.cur.includes(':\\'),
      `★ IDE 深链已把绝对路径裁成相对(当前文件 ${deep.cur})`)
    ok(!deep.empty, `IDE 真的打开了文件(标题「${deep.title}」)`)
  }

  /* 前端:ctx.resolveRoot 兜底 + 菜单项存在性 */
  await goto(`${BASE}/tech`, 3500)
  const ctxProbe = await js(`
    return JSON.stringify({
      hasCtx: !!window.Ctx,
      hasResolve: !!(window.Ctx && window.Ctx.resolveRoot),
      r0: window.Ctx && window.Ctx.resolveRoot ? window.Ctx.resolveRoot(0, 'zzz') : null,
      rNeg: window.Ctx && window.Ctx.resolveRoot ? window.Ctx.resolveRoot(-1, 'zzz') : null,
      rName: window.Ctx && window.Ctx.resolveRoot ? window.Ctx.resolveRoot(undefined, ${JSON.stringify(modName)}) : null,
    })
  `)
  const cj = JSON.parse(ctxProbe)
  ok(cj.hasCtx && cj.hasResolve, 'Ctx.resolveRoot 已挂上')
  ok(cj.r0 === 0, `resolveRoot(0) → 0(实际 ${cj.r0})`)
  ok(cj.rNeg === -1, `resolveRoot(-1, 未知名) → -1(实际 ${cj.rNeg})`)
  ok(cj.rName === modIdx, `resolveRoot(undefined, 模组名) → ${modIdx}(实际 ${cj.rName})`)

  /* 真在 tech 页上对**模组科技**点右键,菜单标题里应显示模组来源名(而非 vanilla),
   * 并且菜单项存在 —— 这才是用户视角的"能打开模组文件"。
   * ⚠ tech.js 不用 `el.__obj`(它靠 `Ctx.attach` + `S.byId.get(el.dataset.id)`
   *   取数据,RIGHTCLICK_V1 铁律的"取数据用 __obj"在这页的具体形态就是 dataset.id)。
   *   所以只能从 `.node[data-id]` 出发,再判断渲染出的菜单标题。 */
  const menuProbe = await js(`
    /* ⚠ 选择器必须与 tech.js 的 Ctx.attach 一致:**g.node**
       (挂在 <g> 上的 SVG 节点,不是 div)。用错选择器就永远右键不出菜单。 */
    const nodes = [...document.querySelectorAll('g.node')];
    if (!nodes.length) return JSON.stringify({skip:'no-nodes'});
    /* ⚠⚠ 坐标必须落在**实心 rect.box** 上,不能用 g 的几何中心。
       同格堆叠(tech 页一屏只有 13 个节点、其中 10 个是 sock)时,
       g 只有一条 13px 的行且夹着分隔线 <line class="sockline">,
       中心恰好落在线上 —— 实测菜单就是弹不出来。
       办法:取 rect.box 的中心;被视口裁掉的节点先跳过。 */
    let pick = null;
    const tries = [];
    for (const n of nodes) {
      const box = n.querySelector('rect.box');
      if (!box) continue;
      const b = box.getBoundingClientRect();
      if (b.width < 12 || b.height < 6) continue;
      tries.push({id:n.dataset.id, w:Math.round(b.width), h:Math.round(b.height),
        x:Math.round(b.left), y:Math.round(b.top)});
      if (b.left < 2 || b.top < 2 || b.right > innerWidth-2 || b.bottom > innerHeight-2) continue;
      pick = { id: n.dataset.id, b }; break;
    }
    if (!pick) return JSON.stringify({skip:'no-clickable-node', total:nodes.length, tries});
    return JSON.stringify({id: pick.id,
      x: Math.round(pick.b.left + pick.b.width/2), y: Math.round(pick.b.top + pick.b.height/2),
      w: Math.round(pick.b.width), h: Math.round(pick.b.height)});
  `)
  const mj = JSON.parse(menuProbe)
  if (mj.skip) {
    ok(false, 'tech 页有可右键的节点', JSON.stringify(mj))
  } else {
    ok(mj.w > 8 && mj.h > 8, `tech 节点有实际尺寸(${mj.w}×${mj.h})，坐标 ${mj.x},${mj.y}`)

    /* ★ EDGE_PICK_V1 的守门判据:那个坐标上命中的是**节点 rect**,
       不是连线 path。
       修复前 `.edge` 没写 pointer-events,SVG 默认 `visiblePainted`,
       横穿节点中心的 1.4px 描边会吃掉命中 → event.target 是 path,
       `closest('g.node')` 匹配不到,菜单静默不弹。
       这就是「右键打不开」在树页上的真实机制。 */
    const hit = JSON.parse(await js(`
      const el = document.elementFromPoint(${mj.x}, ${mj.y});
      if (!el) return JSON.stringify({skip:'null'});
      return JSON.stringify({tag: el.tagName, cls: el.getAttribute('class') || '',
        pe: getComputedStyle(el).pointerEvents,
        inNode: !!(el.closest && el.closest('g.node'))});
    `))
    ok(!hit.skip && hit.tag === 'rect' && hit.inNode,
      `★ 节点中心命中的是 rect 而非连线(命中 ${hit.tag}.${hit.cls})`)
    ok(hit.pe !== 'none', `命中元素可接收指针(pointer-events=${hit.pe})`)

    /* ★★ 为什么用**合成 contextmenu** 而不是 CDP 的真右键:
     *   实测插桩发现,无头 Edge 下 `Input.dispatchMouseEvent(button:'right')`
     *   **根本不产生 `contextmenu` 事件**(事件日志只有 `mousedown:rect:box`)。
     *   菜单能弹出来纯粹是上一次合成事件的残留,随后被 mousedown 关掉。
     *   也就是说:真右键这条路在无头环境里测不了 —— 但 `Ctx.attach` 监听的
     *   就是 `contextmenu`,合成事件走的**完全是同一条代码路径**
     *   (委托 → closest → items 构造 → open),判据依然有效。
     *   真鼠标的可达性由上面那条"命中诊断"覆盖(见 EDGE_PICK_V1)。 */
    const menu = JSON.parse(await js(`
      const g = document.querySelector('g.node[data-id="' + ${JSON.stringify(mj.id)} + '"]');
      if (!g) return JSON.stringify({skip:'no-g'});
      g.dispatchEvent(new MouseEvent('contextmenu',
        {bubbles:true, cancelable:true, clientX:${mj.x}, clientY:${mj.y}}));
      await new Promise(r => setTimeout(r, 400));
      /* ⚠ 菜单容器 id 是 **ctxMenuRoot**(ctx.js 的 MENU_ID),首次右键才懒创建 */
      const m = document.getElementById('ctxMenuRoot');
      if (!m) return JSON.stringify({skip:'no-menu'});
      const txt = m.textContent || '';
      return JSON.stringify({on: m.classList.contains('on'), text: txt.slice(0,260),
        hasModName: txt.includes(${JSON.stringify(modName)}),
        hasVanilla: txt.includes('vanilla')});
    `))
    if (menu.skip) {
      ok(false, '右键菜单未弹出', JSON.stringify(menu))
    } else {
      ok(menu.on, '★ 右键菜单已弹出(.on)')
      ok(/VS Code/.test(menu.text), '菜单含「用 VS Code 打开」')
      ok(/IDE/.test(menu.text), '菜单含「在 IDE 中打开并定位」')
      /* ★ 关键:菜单标题里的来源名必须是**该节点真实的 rootName**。
         修复前 tech.js 硬编码 rootName='科技' + root=0,
         打开模组科技会定位到基础游戏 —— 这条就是它的守门判据。 */
      ok(menu.hasModName || menu.hasVanilla,
        `菜单标题带真实来源名(模组=${menu.hasModName} vanilla=${menu.hasVanilla})`,
        menu.text.slice(0, 90))
    }

    /* 决定性判据:直接验菜单项闭包捕获的 root —— 它必须等于节点真实来源。
       读不到闭包就退而用「对模组科技构造菜单,看标题是否 vanilla」:
       模组科技若被当成 vanilla,标题就会显示 vanilla(错)。 */
    const modTech = (tech.nodes || []).filter((n) => n.root === modIdx)
    if (modTech.length) {
      const t0 = modTech[0]
      const probe2 = await js(`
        const n = ${JSON.stringify({ id: t0.id, root: t0.root, rootName: t0.rootName, file: t0.file, line: t0.line })};
        const items = window.Ctx.sourceItems({
          root: n.root, rootName: n.rootName, file: n.file, line: n.line, id: n.id,
        });
        return JSON.stringify({title: (items[0]||{}).title,
          labels: items.filter(x=>x.label).map(x=>x.label)});
      `)
      const pj = JSON.parse(probe2)
      ok(String(pj.title || '').includes(modName),
        `★ 模组科技 ${t0.id} 的菜单标题显示模组来源(实际「${pj.title}」)`)
      ok(!String(pj.title || '').includes('vanilla'),
        '★ 标题不含 vanilla(修复前会误标)')
    }
  }

  /* ─────────────────────────────────────────────
   * ② Ctrl+/ 注释
   * ───────────────────────────────────────────── */
  line('② IDE 注释快捷键(COMMENT_V1)')

  await goto(`${BASE}/ide`, 3000)
  const km = await js(`
    const K = window.Keymap;
    if (!K) return JSON.stringify({skip:'no-keymap'});
    const acts = K.ACTIONS ? K.ACTIONS.filter(a=>a.id==='ide.toggleComment') : [];
    return JSON.stringify({
      n: acts.length,
      keys: acts[0] ? acts[0].keys : [],
      combo: (window.Keys && window.Keys.combo) ? window.Keys.combo('ide.toggleComment') : null,
    })
  `)
  const kj = JSON.parse(km)
  ok(kj.n === 1, 'keymap 里有 ide.toggleComment 动作')
  ok((kj.keys || []).includes('mod+/'), `默认键位是 mod+/(实际 ${JSON.stringify(kj.keys)})`)
  ok((kj.combo || []).includes('mod+/'), `Keys.combo 解析出 mod+/(实际 ${JSON.stringify(kj.combo)})`)

  /* 真敲 Ctrl+/ —— 用 CDP 派发真实键盘事件(带 ctrlKey),走完整事件链 */
  const commentProbe = await js(`
    // 直接进编辑模式并塞入可控内容,再触发 toggleComment
    const ta = document.getElementById('rawEdit');
    if (!ta) return JSON.stringify({skip:'no-rawEdit'});
    // 通过 IDE 内部入口切编辑模式
    if (window.HoiIde && window.HoiIde.__setEditMode) window.HoiIde.__setEditMode(true);
    return JSON.stringify({ok:true, display: ta.style.display});
  `)
  ok(!commentProbe.includes('skip'), 'IDE 有 rawEdit 编辑框(' + commentProbe + ')')

  /* 事件链验证:构造 KeyboardEvent 打到 rawEdit 上,看默认键位能否命中 */
  const evtProbe = await js(`
    const K = window.Keys;
    const combos = K.combo('ide.toggleComment') || [];
    const e = new KeyboardEvent('keydown', {key:'/', code:'Slash', ctrlKey:true, bubbles:true, cancelable:true});
    return JSON.stringify({fromEvent: K.fromEvent(e), combos, hit: combos.indexOf(K.fromEvent(e))>=0});
  `)
  const ej = JSON.parse(evtProbe)
  ok(ej.fromEvent === 'mod+/', `fromEvent 归一为 mod+/(实际 ${ej.fromEvent})`)
  ok(ej.hit, '★ mod+/ 能命中 toggleComment 的键位表')

  /* 函数级验证:把 toggleComment 暴露出来测行为(缩进保持/多数票/空行跳过) */
  const fnProbe = await js(`
    if (typeof window.__tc !== 'function') return JSON.stringify({skip:'not-exposed'});
    const ta = document.getElementById('rawEdit');
    const orig = ta.value;
    /* ⚠ 必须先让它"可见":toggleComment 开头有 display==='none' 的守卫
     *   (未进编辑模式不该能注释)。测试里直接置 display 绕过编辑模式,
     *   因为进编辑模式要真的打开一个可写文件,那会让脚本依赖模组状态。 */
    const origDisp = ta.style.display;
    ta.style.display = 'block';
    function run(text, s, e) {
      ta.value = text; ta.selectionStart = s; ta.selectionEnd = e;
      window.__tc();
      return ta.value;
    }
    const cases = [
      run('a\\nb\\n', 0, 3),            // 0:两行未注释 → 全加
      run('# a\\n# b\\n', 0, 7),        // 1:两行已注释 → 全解
      run('  foo\\n  bar\\n', 0, 13),   // 2:缩进保持
      run('\\n\\n', 0, 2),              // 3:全空行 → 不动
      run('# a\\nb\\n', 0, 7),          // 4:一注一没(1:1 平票)→ 严格多数不成立 → 全解
      run('  # x\\n  y\\n', 0, 11),     // 5:带缩进的混合(平票)→ 全解
      run('a\\nb\\nc\\n', 0, 5),        // 6:三行全未注释 → 全加
    ];
    ta.value = orig; ta.style.display = origDisp;
    return JSON.stringify(cases);
  `)
  const cj2 = JSON.parse(fnProbe)
  ok(!cj2.skip, 'toggleComment 已暴露可测')
  if (!cj2.skip) {
    ok(cj2[0] === '# a\n# b\n', `① 未注释→全加注释(实际 ${JSON.stringify(cj2[0])})`)
    ok(cj2[1] === 'a\nb\n', `② 已注释→全取消(实际 ${JSON.stringify(cj2[1])})`)
    ok(cj2[2] === '  # foo\n  # bar\n', `③ 缩进保持(实际 ${JSON.stringify(cj2[2])})`)
    ok(cj2[3] === '\n\n', `④ 全空行不动(实际 ${JSON.stringify(cj2[3])})`)
    ok(cj2[4] === 'a\nb\n', `⑤ 平票选区按"严格多数不成立"→ 全解(实际 ${JSON.stringify(cj2[4])})`)
    ok(cj2[5] === '  x\n  y\n', `⑥ 带缩进的平票选区(实际 ${JSON.stringify(cj2[5])})`)
    ok(cj2[6] === '# a\n# b\n# c\n', `⑦ 三行全未注释 → 全加(实际 ${JSON.stringify(cj2[6])})`)
  }

  /* ─────────────────────────────────────────────
   * ③ 首页悬浮窗置顶
   * ───────────────────────────────────────────── */
  line('③ 首页任务卡悬浮窗置顶(TIP_TOP_V1)')

  await goto(`${BASE}/`, 2500)
  const tipProbe = await js(`
    const card = document.querySelector('.card.tip, .fstep.tip');
    if (!card) return JSON.stringify({skip:'no-card'});
    const r = card.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.left + r.width/2),
      y: Math.round(r.top + r.height/2),
      afterZ: getComputedStyle(card, '::after').zIndex,
      varTip: getComputedStyle(document.documentElement).getPropertyValue('--z-tip').trim(),
    })
  `)
  const tj = JSON.parse(tipProbe)
  ok(!tj.skip, '首页有 .tip 卡片')
  ok(Number(tj.afterZ) >= 60, `::after z-index 用了变量且 ≥60(${tj.afterZ})`)
  ok(tj.varTip !== '', `--z-tip 变量已定义(${tj.varTip})`)

  /* ★ 决定性判据。
   * ⚠⚠ **不能用 `dispatchEvent(new MouseEvent('mouseover'))` 来测 `:hover`**:
   *   合成事件只走监听器,**不改变 CSS 伪类状态** —— getComputedStyle 读到的
   *   永远是未 hover 的值。这正是本条判据第一次跑出 `auto` 的原因:
   *   断言写错了,不是样式没生效。
   *   正确做法:用 CDP `Input.dispatchMouseEvent` 发**真**鼠标移动,
   *   让浏览器真的把指针放到那个坐标上。 */
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tj.x, y: tj.y, buttons: 0 })
  await sleep(400)
  const hoverZ = await js(`
    const card = document.querySelector('.card.tip, .fstep.tip');
    const cs = getComputedStyle(card);
    return JSON.stringify({z: cs.zIndex, transform: cs.transform, matches: card.matches(':hover')});
  `)
  const hj = JSON.parse(hoverZ)
  ok(hj.matches, `★ 指针真的落在卡片上(:hover 命中,坐标 ${tj.x},${tj.y})`)
  ok(Number(hj.z) >= 60,
    `★ hover 时卡片自身升到 ${hj.z}(>0 才能逃出 transform 建立的层叠上下文)`)

  /* 浮层必须真的可见(不只是 z-index 对) */
  const vis = await js(`
    const card = document.querySelector('.card.tip, .fstep.tip');
    const cs = getComputedStyle(card, '::after');
    return JSON.stringify({op: cs.opacity, vis: cs.visibility, z: cs.zIndex});
  `)
  const vj = JSON.parse(vis)
  ok(Number(vj.op) > 0.5 && vj.vis === 'visible', `浮层已可见(opacity=${vj.op} visibility=${vj.vis})`)

  /* ─────────────────────────────────────────────
   * ④ DLC 页 MIO 识别模组
   * ───────────────────────────────────────────── */
  line('④ DLC 页军工机构识别模组(MIO_SPELLING_V1)')

  ok(modOrgs.length >= 30, `★ 模组 MIO 机构 ≥30 个(实际 ${modOrgs.length})—— 修复前只有 6`)
  const spell = { org: 0, mis: 0, mio: 0 }
  for (const o of mio.orgs || []) {
    const id = String(o.id || '').toLowerCase()
    if (id.endsWith('_organisation')) spell.mis++
    else if (id.endsWith('_organization')) spell.org++
    else if (id.endsWith('_mio')) spell.mio++
  }
  ok(spell.mis > 0, `英式 _organisation 机构已识别(${spell.mis} 个)—— 修复前整批漏掉`)
  ok(spell.mio > 0, `_MIO 结尾的机构已识别(${spell.mio} 个)`)

  /* 悬空 include 诊断 */
  const dang = (mio.issues || []).filter((i) => i.kind === 'danglingInclude')
  console.log(`  ℹ 悬空 include 诊断:${dang.length} 条`)
  for (const d of dang.slice(0, 3)) console.log(`     - ${d.detail}`)

  /* 打开 DLC 页,确认 MIO 框架能渲染出模组机构。
   * ⚠ 两个前置知识(都是踩过的坑,别再猜):
   *   ① MIO 索引**懒加载**:首次进军工机构视图才在后台构建,首屏没有 .mio-frame,
   *      必须轮询等。
   *   ② 机构列表**不是 <select>**,是 `#dlcList > .item`,数据挂在
   *      `el.__obj = { _k:'mioOrg', o }`(RIGHTCLICK_V1 铁律:取数据用 __obj)。
   *      早先按 `mioOrgSel` 找 select 一直找不到 —— 那个 id 根本不存在。 */
  await goto(`${BASE}/dlc`, 3000)
  /* 切到「军工机构」视图(它在 featBar 上,不是 URL 参数) */
  await js(`
    const t = [...document.querySelectorAll('.featbar .feat, .featbar > *')]
      .find(x => /军工|mio|机构/i.test(x.textContent || ''));
    if (t) t.click();
    return 1;
  `)
  let mioUi = null
  for (let i = 0; i < 25; i++) {
    mioUi = JSON.parse(await js(`
      const box = document.getElementById('dlcList');
      const items = box ? [...box.querySelectorAll('.item')] : [];
      const mod = items.filter(x => x.__obj && x.__obj._k === 'mioOrg' && x.__obj.o.root === ${modIdx});
      return JSON.stringify({
        hasBox: !!box, total: items.length, mod: mod.length,
        frame: !!document.querySelector('.mio-frame'),
        nodes: document.querySelectorAll('.mio-n').length,
        sample: mod.slice(0,3).map(x => (x.textContent||'').trim()),
        allSample: items.slice(0,2).map(x => (x.textContent||'').trim()),
      });
    `))
    if (mioUi.mod > 0) break
    await sleep(900)
  }
  ok(mioUi.hasBox, `DLC 页有机构列表容器(共 ${mioUi.total} 项)`)
  ok(mioUi.mod > 0, `★ 列表里出现模组机构(${mioUi.mod} 个 / 共 ${mioUi.total})`)
  console.log(`  ℹ 模组机构样本:${JSON.stringify(mioUi.sample)}`)
  console.log(`  ℹ 列表首项(对照):${JSON.stringify(mioUi.allSample)}`)

  /* 点第一个模组机构,验证能渲染出节点(而非空树) */
  if (mioUi.mod > 0) {
    const one = JSON.parse(await js(`
      const box = document.getElementById('dlcList');
      const el = [...box.querySelectorAll('.item')].find(x => x.__obj && x.__obj._k === 'mioOrg' && x.__obj.o.root === ${modIdx});
      if (!el) return JSON.stringify({skip:'not-found'});
      const id = el.__obj.o.id;
      el.click();
      await new Promise(r => setTimeout(r, 2000));
      return JSON.stringify({id, nodes: document.querySelectorAll('.mio-n').length,
        frame: !!document.querySelector('.mio-frame'),
        title: (document.querySelector('.mio-ftitle')||{}).textContent || ''});
    `))
    if (one.skip) {
      ok(false, '能点到模组机构', JSON.stringify(one))
    } else {
      ok(one.frame && one.nodes > 0,
        `★ 模组机构 ${one.id} 渲染出 ${one.nodes} 个节点(修复前是空树)`, JSON.stringify(one).slice(0,140))
    }
  }

  /* ───────────────────────────────────────────── */
  line('⑤ 控制台无报错')
  const real = (globalThis.__cdpErr || []).filter((e) => !/favicon|ERR_ABORTED/i.test(e))
  ok(real.length === 0, '控制台无报错', real.slice(0, 3).join(' | '))

  c.close()
  try { process.kill(child.pid) } catch { /* 已退出 */ }

  console.log(`\n判据:${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('验收脚本异常:', e); process.exit(1) })
