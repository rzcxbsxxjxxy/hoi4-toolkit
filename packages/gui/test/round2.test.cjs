/**
 * 真浏览器验收 · 第二轮四项需求(2026-10-07)
 *   ② 中英文双语:默认语言、右上角切换、无刷新切换、术语正确、持久化
 *   ③ 壁纸模糊:只糊壁纸层,UI 文字/顶栏必须清晰(body 上不能有 filter)
 *   ③b 壁纸压暗:默认非 0(深色壁纸上文字可读)、滑条联动
 *   ④ 地图:原版/模组分组图例、未配色标注、国家着色真的拿到了
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = 'http://127.0.0.1:5173'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9477

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
    // ★ 后台标签页会被无头 Edge 节流 setTimeout/fetch —— 必须激活
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

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hoi4-r2-'))
  const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }

  let cdp
  try {
    /* ══════════════ ② 中英文双语 ══════════════ */
    console.log('\n=== 中英文双语 ===')
    cdp = await CDP.open(BASE + '/')
    // ★ 清掉上次跑留下的语言偏好,否则第一条断言随机失败
    await cdp.evalJs(`localStorage.removeItem('gui.lang')`)
    await cdp.goto(BASE + '/')
    await waitFor(cdp, `(()=>{const b=document.getElementById('langBtn');return b?true:false})()`)

    const zh = await cdp.evalJs(`(()=>({
      lang: document.documentElement.lang,
      btn: !!document.getElementById('langBtn'),
      value: (document.getElementById('langValue')||{}).textContent,
      nav: [...document.querySelectorAll('.navgrp summary')].map(x=>x.textContent.replace(/\\s+/g,'').trim()),
      firstItem: (document.querySelector('.navpop a b')||{}).textContent,
      cards: document.querySelectorAll('.card').length,
      h1: (document.querySelector('h1')||{}).textContent,
    }))()`)
    t('默认中文', zh.lang === 'zh-CN', 'lang=' + zh.lang)
    t('右上角有语言按钮', zh.btn)
    // ★ 按钮上显示的是「点了会切成什么」,不是「当前语言」——
    //   现在是中文时按钮应写 English(告诉用户点了会变英文)
    t('按钮显示切换目标语言', zh.value === 'English', 'got=' + zh.value)
    t('导航 4 个分组都是中文', JSON.stringify(zh.nav) === JSON.stringify(['内容', '界面', '文档', '工具']), JSON.stringify(zh.nav))
    t('导航项是中文术语', zh.firstItem === '国策树', 'got=' + zh.firstItem)
    t('主页卡片 20 张', zh.cards === 20, 'got=' + zh.cards)

    // ★ 切语言**不能刷新页面**(用户刚调好的状态会丢)—— 用哨兵变量验证
    await cdp.evalJs(`window.__sentinel = 'kept'`)
    await cdp.evalJs(`document.getElementById('langBtn').click()`)
    await sleep(700)
    const en = await cdp.evalJs(`(()=>({
      lang: document.documentElement.lang,
      value: (document.getElementById('langValue')||{}).textContent,
      nav: [...document.querySelectorAll('.navgrp summary')].map(x=>x.textContent.replace(/\\s+/g,'').trim()),
      firstItem: (document.querySelector('.navpop a b')||{}).textContent,
      firstDesc: (document.querySelector('.navpop a span')||{}).textContent,
      sentinel: window.__sentinel,
      stored: localStorage.getItem('gui.lang'),
      home: (document.querySelector('.navhome')||{}).textContent,
    }))()`)
    t('切到英文后 <html lang>', en.lang === 'en', 'lang=' + en.lang)
    // 英文界面下按钮应显示「中文」(点了会切回中文)
    t('按钮显示切回中文', en.value === '中文', 'got=' + en.value)
    t('导航分组变英文', JSON.stringify(en.nav) === JSON.stringify(['Content', 'Interface', 'Reference', 'Tools']), JSON.stringify(en.nav))
    t('导航项用官方英文术语', en.firstItem === 'National Focus', 'got=' + en.firstItem)
    t('导航项描述也翻了', /Source/.test(en.firstDesc || ''), 'got=' + en.firstDesc)
    t('★ 切语言不刷新页面(哨兵还在)', en.sentinel === 'kept', 'sentinel=' + en.sentinel)
    t('语言写进 localStorage', en.stored === 'en', 'got=' + en.stored)

    // 持久化:重载后仍是英文
    await cdp.goto(BASE + '/')
    await waitFor(cdp, `(()=>{const b=document.getElementById('langBtn');return b?true:false})()`)
    const after = await cdp.evalJs(`document.documentElement.lang`)
    t('重载后仍是英文', after === 'en', 'lang=' + after)

    // 切回中文,并确认 map 页文案也跟着变(不是只翻了导航)
    await cdp.evalJs(`document.getElementById('langBtn').click()`)
    await sleep(500)

    const wmReady = await (async () => {
      await cdp.goto(BASE + '/worldmap')
      return waitFor(cdp, `(()=>{const e=document.getElementById('legendBody');return e&&e.querySelectorAll('.ow').length>0?true:false})()`, 90, 500)
    })()
    t('地图页图例渲染完成', wmReady)

    const wmZh = await cdp.evalJs(`(()=>({
      lang: document.documentElement.lang,
      legend: (document.getElementById('legend')||{}).querySelector('h4') ? document.querySelector('#legend h4').textContent : '',
      groups: [...document.querySelectorAll('#legendBody .lgrp b')].map(x=>x.textContent),
      stat: (document.getElementById('statChip')||{}).textContent,
      hud: (document.getElementById('hud')||{}).textContent,
    }))()`)
    t('地图页语言跟随(中文)', wmZh.lang === 'zh-CN', 'lang=' + wmZh.lang)
    t('★ 图例按来源分组(原版/模组覆盖/模组新增)', wmZh.groups.length >= 1, JSON.stringify(wmZh.groups))
    t('图例分组名是中文', wmZh.groups.some((g) => /原版|模组/.test(g)), JSON.stringify(wmZh.groups))
    t('统计 chip 是中文', /省份/.test(wmZh.stat || ''), wmZh.stat)

    // ★ 切英文后地图文案要跟着变,且**不重载**(地图视图状态保留)
    // ⚠ 必须等 #langBtn 真的存在:它由 nav.js(module,defer)渲染,
    //   而图例是 worldmap.js(经典脚本)渲染的 —— 后者先跑,
    //   等到图例出现时按钮可能还没挂上,click() 静默失败。
    const btnOnMap = await waitFor(cdp, `(()=>{const b=document.getElementById('langBtn');return b?true:false})()`, 40, 300)
    t('地图页也有语言按钮(nav 已挂载)', btnOnMap)
    await cdp.evalJs(`(()=>{const c=document.getElementById('map');window.__keepTx=c?1:0;
      const s=window.__S_probe=null; return true})()`)
    await cdp.evalJs(`document.getElementById('langBtn').click()`)
    await sleep(900)
    const wmEn = await cdp.evalJs(`(()=>({
      lang: document.documentElement.lang,
      groups: [...document.querySelectorAll('#legendBody .lgrp b')].map(x=>x.textContent),
      stat: (document.getElementById('statChip')||{}).textContent,
      hud: (document.getElementById('hud')||{}).textContent,
      flat: document.querySelectorAll('#legendBody .ow.flat').length,
      rows: document.querySelectorAll('#legendBody .ow').length,
      colors: [...document.querySelectorAll('#legendBody .ow i')].slice(0,6).map(x=>x.style.background),
      canvasAlive: !!document.getElementById('map') && document.getElementById('map').width > 0,
      sentinel: window.__keepTx,
    }))()`)
    t('地图页切英文生效', wmEn.lang === 'en', 'lang=' + wmEn.lang)
    t('★ 图例分组变英文', wmEn.groups.some((g) => /Vanilla|Mod/.test(g)), JSON.stringify(wmEn.groups))
    t('统计 chip 变英文', /Province/i.test(wmEn.stat || ''), wmEn.stat)
    t('★ 切语言后画布仍在(没重载)', wmEn.canvasAlive === true)
    t('★ 切语言没丢页面状态(哨兵)', wmEn.sentinel === 1, 'got=' + wmEn.sentinel)

    // ★ 连点三次:navigator 每次用 innerHTML 重建导航,按钮必须**每次都还能点**。
    //   (曾只在 initI18n 绑一次 → 第二次点就失效,显示却被 nav.js 的三元
    //    改对了,于是"看起来能用、其实只能切一次"。)
    const seq = []
    for (let i = 0; i < 3; i++) {
      await cdp.evalJs(`document.getElementById('langBtn').click()`)
      await sleep(500)
      seq.push(await cdp.evalJs(`(()=>({
        lang: document.documentElement.lang,
        btn: (document.getElementById('langValue')||{}).textContent,
      }))()`))
    }
    const seqOk = seq[0].lang === 'zh-CN' && seq[1].lang === 'en' && seq[2].lang === 'zh-CN'
    t('★ 连点三次语言都能来回切', seqOk, JSON.stringify(seq.map((x) => x.lang)))
    t('★ 按钮显示的切换目标随之翻转',
      seq[0].btn === 'English' && seq[1].btn === '中文',
      JSON.stringify(seq.map((x) => x.btn)))

    /* ══════════════ ④ 地图着色 ══════════════ */
    console.log('\n=== 地图着色 ===')
    const colorRes = await cdp.evalJs(`(async()=>{
      const r = await fetch('/api/worldmap/meta'); const j = await r.json();
      const os = j.owners||[];
      const isGrey = c => c && c[0]===128 && c[1]===128 && c[2]===128;
      const grey = os.filter(o=>isGrey(o.color));
      // 省份数加权:真正影响观感的是"有省份却没色"的国家
      const cnt = new Map(); for(const p of j.provinces) if(p.owner) cnt.set(p.owner,(cnt.get(p.owner)||0)+1);
      const greyWithLand = grey.filter(o=>(cnt.get(o.tag)||0) > 0);
      const badProv = j.provinces.filter(p=>p.owner && isGrey((os.find(o=>o.tag===p.owner)||{}).color));
      return {total: os.length, grey: grey.length, greyWithLand: greyWithLand.length,
              badProv: badProv.length, totalProv: j.provinces.length,
              greyTags: greyWithLand.map(o=>o.tag+'('+(cnt.get(o.tag)||0)+')'),
              sample: os.filter(o=>!isGrey(o.color)).slice(0,5).map(o=>o.tag+'='+o.color.join(',')),
              colorDiag: (j.issues||[]).filter(x=>/color/.test(x.msg)).map(x=>x.msg)};
    })()`)
    t('★ 绝大多数国家取到颜色', colorRes.grey <= 12, colorRes.grey + '/' + colorRes.total + ' 灰')
    t('★ 取色失败的国家里几乎无省份', colorRes.greyWithLand <= 2, '有地却无色: ' + colorRes.greyTags.join(','))
    t('★ 灰色省份占比 < 5%', (colorRes.badProv / colorRes.totalProv) < 0.05,
      colorRes.badProv + '/' + colorRes.totalProv)
    t('样例国家有真实颜色', colorRes.sample.length >= 3, colorRes.sample.join(' | '))
    t('未配色有诊断提示', colorRes.colorDiag.length >= 1, (colorRes.colorDiag[0]||'').slice(0, 90))

    /* ══════════════ ③ 壁纸模糊 ══════════════ */
    console.log('\n=== 壁纸模糊 / 压暗 ===')
    await cdp.goto(BASE + '/settings')
    await waitFor(cdp, `(()=>{const e=document.getElementById('tGlass');return e?true:false})()`)
    await cdp.evalJs(`(()=>{
      const cv=document.createElement('canvas'); cv.width=cv.height=64;
      const g=cv.getContext('2d');
      // 高对比条纹:模糊后必须明显糊,才能证明滤镜真的生效在壁纸上
      for(let x=0;x<64;x+=8){ g.fillStyle= x%16===0?'#fff':'#000'; g.fillRect(x,0,8,64); }
      const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      A.bgImage=cv.toDataURL('image/png'); A.theme='light';
      localStorage.setItem('gui.appearance', JSON.stringify(A));
      return true;
    })()`)
    await cdp.goto(BASE + '/settings')
    await waitFor(cdp, `document.documentElement.getAttribute('data-bg')==='image'`)
    await waitFor(cdp, `(()=>{const e=document.getElementById('tDim');return e?true:false})()`)

    // ★★ 核心判据:body 上绝不能有 filter(filter 会模糊所有后代)
    const filterRes = await cdp.evalJs(`(()=>{
      const b=getComputedStyle(document.body);
      const before=getComputedStyle(document.body,'::before');
      return {bodyFilter: b.filter, bodyBackdrop: b.backdropFilter,
              beforeFilter: before.filter, beforeContent: before.content,
              beforeZ: before.zIndex};
    })()`)
    t('★ body 上没有 filter(否则全界面被糊)', filterRes.bodyFilter === 'none', 'body.filter=' + filterRes.bodyFilter)
    t('★ body 上没有 backdrop-filter', filterRes.bodyBackdrop === 'none', 'body.backdrop=' + filterRes.bodyBackdrop)
    t('壁纸滤镜在 ::before 上', /blur/.test(filterRes.beforeFilter || ''), 'before.filter=' + filterRes.beforeFilter)

    // 拉大模糊 → body 的 filter 仍须是 none(这才是"UI 不受影响"的硬判据)
    await cdp.evalJs(`(()=>{const e=document.getElementById('tBlur'); e.value='20';
      e.dispatchEvent(new Event('input',{bubbles:true})); return true})()`)
    await sleep(600)
    const afterBlur = await cdp.evalJs(`(()=>({
      bodyFilter: getComputedStyle(document.body).filter,
      beforeFilter: getComputedStyle(document.body,'::before').filter,
      blurVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-blur').trim(),
      navText: (document.querySelector('.navhome')||{}).textContent,
      navFilter: (()=>{const e=document.querySelector('.navlinks');return e?getComputedStyle(e).filter:'none'})(),
      navBackdrop: (()=>{const e=document.querySelector('.navlinks');return e?getComputedStyle(e).backdropFilter:'none'})(),
    }))()`)
    t('★ 模糊 20px 后 body.filter 仍是 none', afterBlur.bodyFilter === 'none', 'got=' + afterBlur.bodyFilter)
    t('★ 模糊 20px 后导航无 filter', afterBlur.navFilter === 'none', 'got=' + afterBlur.navFilter)
    t('★ 模糊 20px 后导航无 backdrop-filter', afterBlur.navBackdrop === 'none', 'got=' + afterBlur.navBackdrop)
    t('模糊值写进 --bg-blur', afterBlur.blurVar === '20px', 'got=' + afterBlur.blurVar)
    t('::before 确实带上了 blur(滤镜生效)', /blur\(20px\)/.test(afterBlur.beforeFilter || ''), 'got=' + afterBlur.beforeFilter)

    // 压暗:默认不该是 0
    const dimRes = await cdp.evalJs(`(()=>{
      const r=document.documentElement;
      const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      return {inline: r.style.getPropertyValue('--bg-dim'),
              computed: getComputedStyle(r).getPropertyValue('--bg-dim').trim(),
              stored: A.bgDim===undefined?'unset':A.bgDim,
              slider: document.getElementById('tDim').value,
              label: document.getElementById('tDimV').textContent};
    })()`)
    t('★ 压暗默认非 0(主题兜底生效)', parseFloat(dimRes.computed) > 0, 'computed=' + dimRes.computed)
    t('滑条默认值与主题一致', parseInt(dimRes.slider, 10) > 0, 'slider=' + dimRes.slider)
    t('未手动调过时读数显示主题默认', /默认/.test(dimRes.label), 'label=' + dimRes.label)

    // 恢复默认并清理
    await cdp.evalJs(`(()=>{const A=JSON.parse(localStorage.getItem('gui.appearance')||'{}');
      delete A.bgImage; localStorage.setItem('gui.appearance',JSON.stringify(A));
      localStorage.removeItem('gui.lang'); return true})()`)

    t('无未捕获 JS 异常', cdp.errs.length === 0, cdp.errs.slice(0, 3).join(' || '))
    cdp.close()
  } finally {
    try { process.kill(child.pid) } catch {}
  }

  console.log(`\n第二轮真浏览器验收: ${pass}/${pass + fails.length} 通过`)
  if (fails.length) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exitCode = 1 }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
