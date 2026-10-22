/* ★ 最终验收:四项需求全链路真浏览器验证
 * ① 页面切换白屏 → 有"正在加载"界面,且不误收
 * ② 音乐播放/切歌不中断
 * ③ 循环(单曲)/随机/列表循环 三模式真实行为
 * ④ 启动加载页白色主题(读 boot.html/splash.html 源码断言)
 */
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9417
const BASE = 'http://127.0.0.1:5188'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map()
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data)
      if (m.id && this.w.has(m.id)) { const { res, rej } = this.w.get(m.id); this.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)) } }, 60000) }) }
}
async function pageWs() {
  return new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b).webSocketDebuggerUrl) } catch (e) { rej(e) } }) }); req.on('error', rej); req.end() })
}
async function ev(cdp, e) { const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js err'); return r.result && r.result.value }
let fail = 0
const ok = (c, msg, extra = '') => { console.log((c ? '  PASS ' : '  FAIL ') + msg + (extra ? '  [' + extra + ']' : '')); if (!c) fail++ }
const H = (s) => console.log('\n══ ' + s + ' ══')

;(async () => {
  const udd = fs.mkdtempSync(path.join(__dirname, '_edgeFinal-'))
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 40; i++) { try { await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/version`, (r) => { r.resume(); res() }).on('error', rej)); break } catch { await sleep(400) } }
    const ws = new WebSocket(await pageWs())
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

    /* ══ ④ 启动加载页白色主题(源码断言 + 渲染验证) ══ */
    H('需求④ 初始化加载页主题色为白色')
    const bootSrc = fs.readFileSync(path.join(__dirname, 'boot.html'), 'utf8')
    ok(/background\s*:\s*#ffffff/i.test(bootSrc), 'boot.html 背景为白色')
    ok(/color\s*:\s*#1f2328/i.test(bootSrc), 'boot.html 文字为深色(白底可读)')
    const mainSrc = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
    ok(/backgroundColor:\s*'#ffffff'/.test(mainSrc), 'main.cjs 主窗口底色为白')
    // ★ 剥掉所有块注释与行注释后再查,避免注释里的 transparent:true 误判
    const codeOnly = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok(!/transparent\s*:\s*true/.test(codeOnly), 'main.cjs 已去掉透明窗(Windows 透明区呈黑)')
    ok(/transparent\s*:\s*false/.test(codeOnly), 'main.cjs splash 明确为不透明窗')
    // 渲染验证:直接加载 boot.html 看计算样式
    await cdp.send('Page.navigate', { url: 'file:///' + path.join(__dirname, 'boot.html').replace(/\\/g, '/') })
    await sleep(800)
    const bootR = await ev(cdp, `(()=>{const b=getComputedStyle(document.body);
      return {bg:b.backgroundColor, fg:b.color, ring:getComputedStyle(document.querySelector('.ring')).borderTopColor}})()`)
    console.log('  boot.html 计算样式:', JSON.stringify(bootR))
    ok(bootR.bg === 'rgb(255, 255, 255)', 'boot.html 实际渲染背景为纯白', bootR.bg)
    ok(bootR.fg === 'rgb(31, 35, 40)', 'boot.html 实际渲染文字为深色', bootR.fg)

    /* ══ ①②③ 壳页 ══ */
    await cdp.send('Page.navigate', { url: BASE + '/' })
    let n = 0
    for (let i = 0; i < 90; i++) { await sleep(400)
      n = await ev(cdp, `document.querySelectorAll('.mus-song').length`).catch(() => 0)
      if (n > 0) break }
    ok(n > 0, '壳页就绪(曲目已渲染)', 'songs=' + n)
    await ev(cdp, `try{localStorage.removeItem('hoi4.music.state')}catch(e){}`)

    H('需求① 页面切换"正在加载"界面')
    // 1a. 切页瞬间必须显示遮罩
    const race = await ev(cdp, `(async()=>{
      const b=document.getElementById('framebusy');
      const log=[];
      window.shellSwitch('/events','/events?frame=1');
      log.push({t:'sync', hidden:b.hidden, msg:(b.querySelector('.fb-msg')||{}).textContent});
      await new Promise(r=>setTimeout(r,50));  log.push({t:'50ms', hidden:b.hidden});
      // ★ 等足时间:子页可能耗时数秒才 ready(实测 events 页约 2.5s)
      let hidden=false;
      for(let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,100)); if(b.hidden){hidden=true;break} }
      log.push({t:'ready', hidden:b.hidden});
      const f=[...document.querySelectorAll('#content iframe')].find(x=>x.classList.contains('on'));
      return {log, waitedHidden:hidden, kids:f&&f.contentDocument&&f.contentDocument.body?f.contentDocument.body.children.length:-1};
    })()`)
    console.log('  遮罩时序:', race.log.map(x => x.t + ':' + (x.hidden ? 'hidden' : 'SHOWN')).join('  '))
    ok(race.log[0].hidden === false, '切页瞬间遮罩显示(不再被 about:blank 误收)')
    ok(/正在加载/.test(race.log[0].msg || ''), '遮罩含"正在加载"文案', race.log[0].msg)
    ok(race.waitedHidden === true, '页面就绪后遮罩收起')
    ok(race.kids > 0, '切页后内容非空(无白屏)', 'kids=' + race.kids)

    // 1b. 预取帧 load 不得误收当前页遮罩
    const pre = await ev(cdp, `(async()=>{
      const b=document.getElementById('framebusy');
      // 触发一次新页切换(未预取过的页),遮罩应显示
      window.shellSwitch('/units','/units?frame=1');
      await new Promise(r=>setTimeout(r,80));
      const during=b.hidden;
      // 等所有后台预取帧都 load 完(它们各自 load 也会触发回调)
      await new Promise(r=>setTimeout(r,2500));
      return {during, after:b.hidden};
    })()`)
    console.log('  预取干扰:', JSON.stringify(pre))
    ok(pre.during === false, '切页期间遮罩保持显示')

    H('需求② 音乐播放/切歌不中断')
    const play = await ev(cdp, `(async()=>{
      const a=document.querySelector('.mus-audio');
      document.querySelector('.mus-play').click();
      await new Promise(r=>setTimeout(r,2200));
      const p1={ct:a.currentTime,paused:a.paused,err:a.error?a.error.code:null};
      // 打开面板(不该重播)
      window.MusicUI.show();
      await new Promise(r=>setTimeout(r,1200));
      const p2={ct:a.currentTime,paused:a.paused,err:a.error?a.error.code:null};
      // 收起面板(不该暂停)
      window.MusicUI.hide();
      await new Promise(r=>setTimeout(r,1200));
      const p3={ct:a.currentTime,paused:a.paused,err:a.error?a.error.code:null};
      return {p1,p2,p3};
    })()`)
    console.log('  播放后:', JSON.stringify(play.p1), ' show后:', JSON.stringify(play.p2), ' hide后:', JSON.stringify(play.p3))
    ok(play.p1.err === null && play.p1.paused === false, '播放正常无错误')
    ok(play.p2.ct >= play.p1.ct - 0.3, 'show() 不重播不归零', play.p1.ct + ' -> ' + play.p2.ct)
    ok(play.p3.paused === false, 'hide() 不暂停音乐')
    ok(play.p3.ct >= play.p2.ct - 0.3, 'hide() 后播放位置不回退', play.p2.ct + ' -> ' + play.p3.ct)

    // 切歌:连切 3 首,每首都要真的播下去
    const sw = await ev(cdp, `(async()=>{
      const a=document.querySelector('.mus-audio'); const out=[];
      for(let i=0;i<3;i++){
        const s0=a.getAttribute('src');
        document.querySelector('.mus-next').click();
        await new Promise(r=>setTimeout(r,1800));
        out.push({changed:a.getAttribute('src')!==s0, paused:a.paused, ct:a.currentTime, err:a.error?a.error.code:null});
      }
      return out;
    })()`)
    console.log('  连续切歌:', JSON.stringify(sw))
    ok(sw.every(x => x.changed), '每次切歌都换了源')
    ok(sw.every(x => !x.paused), '每次切歌后都处于播放态')
    ok(sw.every(x => x.err === null), '切歌无媒体错误')
    ok(sw.every(x => x.ct > 0), '每次切歌后播放位置在推进', sw.map(x => x.ct.toFixed(2)).join(','))

    // 切页不中断播放
    const swPage = await ev(cdp, `(async()=>{
      const a=document.querySelector('.mus-audio');
      const b={ct:a.currentTime,paused:a.paused};
      window.shellSwitch('/doctrines','/doctrines?frame=1');
      await new Promise(r=>setTimeout(r,2500));
      return {b, a:{ct:a.currentTime,paused:a.paused}, same:document.querySelector('.mus-audio')===a};
    })()`)
    console.log('  切页:', JSON.stringify(swPage))
    ok(swPage.same, '切页后 audio 元素未重建')
    ok(swPage.a.paused === false, '切页后音乐未暂停')
    ok(swPage.a.ct >= swPage.b.ct, '切页后播放位置未回退', swPage.b.ct + ' -> ' + swPage.a.ct)

    H('需求③ 循环/随机/列表循环 真实行为')
    const setMode = async (want) => ev(cdp, `(async()=>{
      for(let i=0;i<5;i++){ if(document.querySelector('.mus-mode').title==='${want}') break;
        document.querySelector('.mus-mode').click(); await new Promise(r=>setTimeout(r,120)); }
      return document.querySelector('.mus-mode').title;
    })()`)
    // 单曲循环:ended 后应还是同一首
    const mRep = await ev(cdp, `(async()=>{
      for(let i=0;i<5;i++){ if(document.querySelector('.mus-mode').title==='单曲循环') break;
        document.querySelector('.mus-mode').click(); await new Promise(r=>setTimeout(r,120)); }
      const a=document.querySelector('.mus-audio');
      const before=document.querySelector('.mus-now').textContent;
      a.dispatchEvent(new Event('ended'));
      await new Promise(r=>setTimeout(r,900));
      return {mode:document.querySelector('.mus-mode').title, before, after:document.querySelector('.mus-now').textContent, playing:!a.paused};
    })()`)
    console.log('  单曲循环:', JSON.stringify(mRep))
    ok(mRep.mode === '单曲循环', '模式标题为"单曲循环"', mRep.mode)
    ok(mRep.after === mRep.before, '单曲循环:ended 后仍是同一首', mRep.before + ' -> ' + mRep.after)
    ok(mRep.playing, '单曲循环:ended 后继续播放')

    // 列表循环:末曲 ended 绕回开头
    const mList = await ev(cdp, `(async()=>{
      for(let i=0;i<5;i++){ if(document.querySelector('.mus-mode').title==='列表循环') break;
        document.querySelector('.mus-mode').click(); await new Promise(r=>setTimeout(r,120)); }
      const a=document.querySelector('.mus-audio');
      const items=[...document.querySelectorAll('.mus-song')];
      items[items.length-1].click();
      await new Promise(r=>setTimeout(r,700));
      const last=document.querySelector('.mus-now').textContent;
      const firstTitle=items[0].querySelector('.mus-songnm').textContent;
      a.dispatchEvent(new Event('ended'));
      await new Promise(r=>setTimeout(r,900));
      return {mode:document.querySelector('.mus-mode').title, last, after:document.querySelector('.mus-now').textContent, first:firstTitle, playing:!a.paused};
    })()`)
    console.log('  列表循环:', JSON.stringify(mList))
    ok(mList.mode === '列表循环', '模式标题为"列表循环"', mList.mode)
    ok(mList.after === mList.first, '列表循环:末曲 ended 绕回第一首', mList.last + ' -> ' + mList.after + ' (首=' + mList.first + ')')

    // 随机播放:ended 后应换成不同的一首
    const mShuf = await ev(cdp, `(async()=>{
      for(let i=0;i<5;i++){ if(document.querySelector('.mus-mode').title==='随机播放') break;
        document.querySelector('.mus-mode').click(); await new Promise(r=>setTimeout(r,120)); }
      const a=document.querySelector('.mus-audio');
      const before=document.querySelector('.mus-now').textContent;
      a.dispatchEvent(new Event('ended'));
      await new Promise(r=>setTimeout(r,900));
      return {mode:document.querySelector('.mus-mode').title, before, after:document.querySelector('.mus-now').textContent, playing:!a.paused};
    })()`)
    console.log('  随机播放:', JSON.stringify(mShuf))
    ok(mShuf.mode === '随机播放', '模式标题为"随机播放"', mShuf.mode)
    ok(mShuf.after !== mShuf.before, '随机播放:ended 后换了一首', mShuf.before + ' -> ' + mShuf.after)
    ok(mShuf.playing, '随机播放:ended 后继续播放')

    // 模式持久化:刷新后保持
    const persist = await ev(cdp, `(()=>{const v=JSON.parse(localStorage.getItem('hoi4.music.state')||'{}');return v.mode})()`)
    ok(persist === 'shuffle', '模式写入 localStorage', persist)
  } catch (e) { console.error('EXC', e); fail++ } finally { try { proc.kill('SIGKILL') } catch (e) {} }
  console.log(fail === 0 ? '\n★ ALL PASS' : `\n★ ${fail} FAILURES`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('ERR', e); process.exitCode = 1 })
