/**
 * 真浏览器验收 · 加载进度条(PROGRESS_V1,2026-10-07)
 *
 * 判据要点:
 *   · 条必须**贴在顶栏正下方且不被盖住**(z-index 够高)—— 盖住等于没做
 *   · 不确定态(多数图没有真进度)与确定态(done/total)都要能用
 *   · 并发安全:两个请求在飞时,一个完成不能把条收走
 *   · 切页后 timer 不能留在上一页继续计时
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = 'http://127.0.0.1:5173'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9488

let pass = 0
const fails = []
function t(name, ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (msg ? ' :: ' + msg : '')); console.log('  ✗ ' + name + (msg ? ' :: ' + msg : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.errs = [] }
  static async open(url) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    const tgt = await r.json()
    const ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        c.errs.push((d.exception && d.exception.description) || d.text || '')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.errs.push('[console] ' + m.params.args.map((a) => a.value || a.description || '').join(' '))
      }
    }
    await c.send('Runtime.enable'); await c.send('Page.enable')
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
    await this.send('Page.navigate', { url }); await sleep(900)
  }
  close() { try { this.ws.close() } catch {} }
}
async function waitFor(cdp, expr, tries = 50, gap = 300) {
  for (let i = 0; i < tries; i++) {
    if ((await cdp.evalJs(expr)) === true) return true
    await sleep(gap)
  }
  return false
}

const BAR = `(()=>{const b=document.getElementById('loadbar');return b?{
  on: b.classList.contains('on'),
  det: b.classList.contains('det'),
  err: b.classList.contains('err'),
  text: (b.querySelector('.lbtext')||{}).textContent||'',
  width: (b.querySelector('.lbfill')||{}).style?.width || '',
  z: getComputedStyle(b).zIndex,
  top: Math.round(b.getBoundingClientRect().top),
  h: Math.round(b.getBoundingClientRect().height),
  opacity: getComputedStyle(b).opacity,
  anim: (()=>{const f=b.querySelector('.lbfill');return f?getComputedStyle(f).animationName:'none'})(),
} : null})()`

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4-pg-'))
  const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }

  const cdp = await CDP.open(BASE + '/')
  try {
    /* ── 脚本已加载 + API 可用 ── */
    await waitFor(cdp, `typeof window.Progress==='object'`)
    const api = await cdp.evalJs(`(()=>({
      has: typeof window.Progress==='object',
      keys: window.Progress?Object.keys(window.Progress):[],
      fns: window.Progress?['start','tick','done','fail'].filter(k=>typeof window.Progress[k]==='function'):[],
    }))()`)
    t('progress.js 已加载(window.Progress 存在)', api.has === true, JSON.stringify(api))
    t('API 齐全 start/tick/done/fail', api.fns.length === 4, JSON.stringify(api.fns))

    /* ── 不确定态 ── */
    await cdp.evalJs(`window.Progress.start('正在构建国策图…')`)
    await sleep(500)
    const ind = await cdp.evalJs(BAR)
    t('不确定态:条出现', ind && ind.on === true)
    t('不确定态:有关键帧动画', ind && /sweep|lbsweep/.test(ind.anim || ''), 'anim=' + (ind && ind.anim))
    t('不确定态:不是确定态', ind && ind.det === false)
    t('不确定态:有阶段文字', ind && /国策/.test(ind.text || ''), 'text=' + (ind && ind.text))
    t('★ 贴在页面最上方(紧贴顶栏)', ind && ind.top >= 0 && ind.top <= 2, 'top=' + (ind && ind.top))
    t('★ z-index 足够高(不被浮层盖住)', ind && parseInt(ind.z, 10) > 200000, 'z=' + (ind && ind.z))
    t('高度 3px(不抢注意力)', ind && ind.h === 3, 'h=' + (ind && ind.h))
    t('完全可见', ind && parseFloat(ind.opacity) > 0.9, 'op=' + (ind && ind.opacity))

    // 计时器:秒数应该会自己往上走
    const s1 = (await cdp.evalJs(BAR)).text
    await sleep(2300)
    const s2 = (await cdp.evalJs(BAR)).text
    t('★ 已用秒数会走动', /1s|2s/.test(s1 + '|' + s2), `"${s1}" → "${s2}"`)

    /* ── 确定态(新起一轮,与上面那轮分开) ── */
    // ⚠ Progress 是并发计数:上一轮的 start(106 行)在这里先配对 done,
    //   否则 depth 永远归不了零,后面所有 done 都收不了条(测试自己的坑)。
    await cdp.evalJs(`window.Progress.done()`)
    await sleep(400)
    await cdp.evalJs(`window.Progress.start('正在体检…')`)
    await sleep(300)
    await cdp.evalJs(`window.Progress.tick(3, 10, '扫描焦点')`)
    await sleep(400)
    const det = await cdp.evalJs(BAR)
    t('确定态:切到 det', det && det.det === true)
    t('确定态:宽度按比例 30%', det && /^30(\.\d+)?%$/.test((det.width || '').trim()), 'width=' + (det && det.width))
    t('确定态:动画关掉', det && det.anim === 'none', 'anim=' + (det && det.anim))
    t('确定态:文字含 done/total 与百分比', det && /3\/10/.test(det.text) && /30%/.test(det.text), 'text=' + (det && det.text))
    t('确定态:文字含阶段名', det && /扫描焦点/.test(det.text), 'text=' + (det && det.text))

    // 边界:total=0 不能变成确定态(NaN%)—— 接着确定态那一轮,不新起
    await cdp.evalJs(`window.Progress.tick(0, 0)`)
    await sleep(300)
    const zero = await cdp.evalJs(BAR)
    t('★ total=0 时不进入确定态(避免 NaN%)', zero && zero.det === false, 'det=' + (zero && zero.det))
    await cdp.evalJs(`window.Progress.done()`)
    await sleep(400)

    /* ── done 收条 ── */
    await cdp.evalJs(`window.Progress.start('x')`)
    await sleep(200)
    await cdp.evalJs(`window.Progress.done()`)
    await sleep(600)
    const off = await cdp.evalJs(BAR)
    t('done() 后条消失', off && off.on === false)

    /* ── ★ 并发安全 ── */
    await cdp.evalJs(`window.Progress.start('A'); window.Progress.start('B')`)
    await sleep(250)
    await cdp.evalJs(`window.Progress.done()`)   // 只完成了一个
    await sleep(300)
    const conc = await cdp.evalJs(BAR)
    t('★ 并发时一个 done 不收条', conc && conc.on === true, 'on=' + (conc && conc.on))
    await cdp.evalJs(`window.Progress.done()`)
    await sleep(500)
    const conc2 = await cdp.evalJs(BAR)
    t('★ 全部 done 后才收条', conc2 && conc2.on === false)

    // 并发 start 不重置计时(第二个请求不该把第一个的耗时清零)
    await cdp.evalJs(`window.Progress.start('A')`)
    await sleep(2200)
    const tm1 = (await cdp.evalJs(BAR)).text
    await cdp.evalJs(`window.Progress.start('B')`)
    await sleep(300)
    const tm2 = (await cdp.evalJs(BAR)).text
    const g = (s) => { const m = String(s).match(/(\d+)s/); return m ? +m[1] : -1 }
    t('★ 并发 start 不重置已用秒数', g(tm2) >= g(tm1), `"${tm1}" → "${tm2}"`)
    // 这一段起了两个(A/B),必须 done 两次 —— 否则 depth 泄漏到后面的用例
    await cdp.evalJs(`window.Progress.done(); window.Progress.done()`)
    await sleep(500)

    /* ── fail 态 ── */
    await cdp.evalJs(`window.Progress.start('x')`)
    await sleep(200)
    await cdp.evalJs(`window.Progress.fail('构建失败: 磁盘')`)
    await sleep(300)
    const fl = await cdp.evalJs(BAR)
    t('fail():标红并给出原因', fl && fl.err === true && /磁盘/.test(fl.text || ''), JSON.stringify({ err: fl && fl.err, text: fl && fl.text }))
    await sleep(1200)

    /* ── 真实页面自动接线 ──
     * ⚠⚠ 两个坑叠加,让"切到 focus 页"看不到条:
     *   ① progress.js 的条是**懒创建**的(首次 start 才插入 DOM),
     *      缓存命中 → api 立刻 ready → 从不 start → #loadbar 压根不存在;
     *   ② 各图早已构建好并缓存在服务端内存,不会走 busy 分支。
     *   所以必须先 /api/reload 全量失效,再切页 —— 此时 api 返回
     *   ready:false+busy:true,api() 钩子才会自动拉起进度条。*/
    await cdp.evalJs(`fetch('/api/reload',{method:'POST'})`)
    await sleep(1200)
    await cdp.goto(BASE + '/focus')
    const samples = await cdp.evalJs(`(async()=>{
      const log=[]; const t0=Date.now();
      while(Date.now()-t0 < 12000){
        const b=document.getElementById('loadbar');
        log.push([b?b.classList.contains('on'):null, b?(b.querySelector('.lbtext')||{}).textContent||'':'']);
        await new Promise(r=>setTimeout(r,40));
      }
      const onFrames = log.filter(x=>x[0]);
      const b=document.getElementById('loadbar');
      return {total:log.length, onCount:onFrames.length, sample:onFrames.slice(0,2),
              endOn: b?b.classList.contains('on'):null,
              endText: b?(b.querySelector('.lbtext')||{}).textContent||'':''};
    })()`)
    t('★ 图重建时进度条自动出现(无需手动调用)', samples.onCount > 0,
      `采样 ${samples.total} 帧,on ${samples.onCount} 帧`)
    if (samples.onCount) t('自动拉起的进度条有阶段文字', /国策|focus/i.test(samples.sample[0][1] || ''), JSON.stringify(samples.sample[0]))
    t('★ 构建完成后条自动收起', samples.endOn === false, 'endOn=' + samples.endOn)

    /* ── 切页不留残留(换到另一页再看一次) ── */
    await cdp.goto(BASE + '/worldmap')
    await waitFor(cdp, `document.getElementById('hud').textContent.indexOf('state')>=0`, 90, 500)
    const afterNav = await cdp.evalJs(`(()=>({
      bar: !!document.getElementById('loadbar'),
      on: document.getElementById('loadbar')?document.getElementById('loadbar').classList.contains('on'):null,
    }))()`)
    t('切页后不残留上一条的 on 状态', afterNav.on === false || afterNav.on === null, JSON.stringify(afterNav))

    t('无未捕获 JS 异常', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' || '))
  } finally {
    cdp.close()
    try { process.kill(child.pid) } catch {}
  }

  console.log(`\n进度条真浏览器验收: ${pass}/${pass + fails.length} 通过`)
  if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exitCode = 1 }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
