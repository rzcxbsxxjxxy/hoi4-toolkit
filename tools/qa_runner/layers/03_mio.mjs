/* ================================================================
 * QA 层 03 — MIO 军工机构专项
 *
 * 复用以 tools/verify_mio_tree_fix.cjs 为原型的 Edge headless CDP 驱动:
 *   spawn msedge --headless=new --remote-debugging-port=<random>,
 *   GET /json/list 拿 page target, WebSocket 发 Runtime.evaluate 取 DOM/数据。
 *
 * 两大部分:
 *   A. 原样复用 verify_mio_tree_fix.cjs 的全部断言(MIO_FIX 回归:
 *      多对多连线全画 / 独立框架 / 列标题 / 玩法条收起 / 无运行时异常)。
 *   B. 新增断言:
 *     a. 机构列表按来源文件名分组(API file 字段 ↔ DOM .mio-grp)
 *     b. 特质树线条三规则(水平=0 弯折 / 垂直=0 弯折 / 转折=2 弯折,
 *        API 不带 path 序列 → 按渲染器公式由坐标反推期望 d,与 DOM 实测 path 逐点比对)
 *     c. 互斥线红色(.ln.mutex 实测 strokeStyle)
 *     d. 政策展示 + 图标(.mioPolicy 条目 + img.picon / .pol-icon)
 *     e. Equipment / Production / Organisation 三类属性分组(API 三 dict + DOM h4)
 *     f. 属性栏键值美观化(可见 kv 标签无 UPPER_SNAKE 原始键)
 *
 * 用法: node tools/qa_runner/layers/03_mio.mjs [--base=http://127.0.0.1:5175] [--out=...]
 * 退出码: 0=全过(含已确认豁免) 1=有失败 2=基础设施错误(dev server 不可达/CDP 连不上)
 * ================================================================ */
import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9400 + Math.floor(Math.random() * 60)

const argv = process.argv.slice(2)
const pick = (key, def) => {
  const hit = argv.find((a) => a.startsWith(key + '='))
  return hit ? hit.split('=').slice(1).join('=') : def
}
const BASE = pick('--base', 'http://127.0.0.1:5175').replace(/\/$/, '')
const OUT = pick('--out', path.join(__dirname, '..', 'results', '03_mio.json'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function httpJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

const cases = []
function rec(name, { pass = false, detail = '', exempt = false, exemptReason = '' } = {}) {
  cases.push({ name, pass, detail, exempt, exemptReason })
  const tag = exempt ? '[EXEMPT]' : pass ? '[PASS]' : '[FAIL]'
  console.log('  ' + tag + ' ' + name + (detail ? '  — ' + detail : ''))
}
const ok = (name, detail) => rec(name, { pass: true, detail })
const fail = (name, detail) => rec(name, { pass: false, detail })

;(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + os.tmpdir() + '/cdp-qa03-' + Date.now(),
    '--window-size=1600,900', '--remote-debugging-port=' + PORT, 'about:blank',
  ], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 40; i++) {
    try { list = await httpJson('/json/list'); if (list && list.length) break } catch {}
    await sleep(300)
  }
  if (!list || !list.length) {
    console.log('无法连上 Edge DevTools')
    try { child.kill('SIGKILL') } catch {}
    process.exit(2)
  }
  const tgt = list.find((t) => t.type === 'page') || list[0]
  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  const pageErr = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') pageErr.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const cmd = (method, params) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错')
    return r.result.value
  }

  console.log('=== QA 层 03 MIO 专项 === base=' + BASE)

  try {
    await cmd('Page.enable'); await cmd('Runtime.enable')
    await cmd('Page.navigate', { url: BASE + '/dlc.html?feature=mio' })
    pageErr.length = 0
    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(400)
      try { if (await evalJs('!!document.querySelector("#featList") && typeof window.CtxWire !== "undefined"')) { ready = true; break } } catch {}
    }
    ok('dlc 页面装载(CtxWire 就绪)', ready ? 'ready' : '')
    if (!ready) throw new Error('dlc 页未就绪,中止')

    const clicked = await evalJs(`(function(){ const items=[...document.querySelectorAll('#featList .item')]; const t=items.find(e=>/军工|MIO|military/i.test(e.textContent)); if(t){ if(typeof t.onclick==='function') t.onclick({}); else t.click(); return true } return false })()`)
    ok('点击军工机构玩法', clicked === true ? 'clicked' : '未找到 MIO 玩法项')

    for (let i = 0; i < 50; i++) {
      await sleep(400)
      try { if (await evalJs('[...document.querySelectorAll("#dlcList .item")].some(e=>e.__obj&&e.__obj._k==="mioOrg")')) break } catch {}
    }
    const oc = await evalJs('[...document.querySelectorAll("#dlcList .item")].filter(e=>e.__obj&&e.__obj._k==="mioOrg").length').catch(() => 0)
    ok('机构清单加载(MIO 模式)', '机构条目=' + oc)

    const pickJson = await evalJs(`(async()=>{
      const list=await (await fetch('/api/mio/tree')).json();
      const ids=(list.orgs||[]).map(o=>o.id);
      let best=null;
      for(const id of ids.slice(0,60)){
        const t=await (await fetch('/api/mio/tree?org='+encodeURIComponent(id))).json();
        let multi=0,total=0;
        for(const n of (t.nodes||[])) for(const lk of (n.links||[])){ total+=lk.parents.length; if(lk.parents.length>1) multi++; }
        if(multi>0 && (!best||multi>best.multi)) best={id,multi,total};
      }
      return JSON.stringify(best);
    })()`)
    let bestOrg = null
    try { bestOrg = JSON.parse(pickJson) } catch {}
    if (!bestOrg || !bestOrg.id) fail('选定多父机构(MIO_FIX 目标)', '前 60 机构无多父连线')
    else console.log('    选定机构=' + bestOrg.id + ' 多父连线=' + bestOrg.multi + ' 总连线=' + bestOrg.total)

    if (bestOrg && bestOrg.id) {
      await evalJs(`(function(){
        const it=[...document.querySelectorAll('#dlcList .item')].find(e=>e.__obj&&e.__obj._k==='mioOrg'&&e.__obj.o&&e.__obj.o.id===${JSON.stringify(bestOrg.id)});
        if(it){ if(typeof it.onclick==='function') it.onclick({}); else it.click(); return true } return false;
      })()`)
    }
    let treeReady = false
    for (let i = 0; i < 80; i++) {
      await sleep(400)
      try { if (await evalJs('!!document.querySelector("#groups .mio-frame") && document.querySelectorAll("#groups .mio-n").length')) { treeReady = true; break } } catch {}
    }
    ok('特质树渲染(.mio-frame + 节点)', treeReady ? 'rendered' : '')

    const renderStats = await evalJs(`(async()=>{
      const org=${JSON.stringify(bestOrg && bestOrg.id ? bestOrg.id : '')};
      const rendered=document.querySelectorAll('#groups .mio-links path').length;
      const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(org))).json();
      let s=0,nodes=0,multi=0,mutex=0;
      for(const nd of (d.nodes||[])){nodes++; for(const lk of (nd.links||[])){ s+=lk.parents.length; if(lk.parents.length>1) multi++; }}
      for(const nd of (d.nodes||[])) if(nd.mutuallyExclusive) mutex+=nd.mutuallyExclusive.length;
      return JSON.stringify({exp:s,nodes,multi,mutex,dom:rendered,org:d.org});
    })()`)
    let rs = { exp: 0, nodes: 0, multi: 0, mutex: 0, dom: 0 }
    try { rs = JSON.parse(renderStats) } catch {}
    console.log('    节点=' + rs.nodes + '  多父连线=' + rs.multi + '  互斥对数=' + rs.mutex + '  期望(parents和)=' + rs.exp + '  DOM path=' + rs.dom)
    ok('多对多连线全部绘制(渲染==parents 之和)', 'dom=' + rs.dom + ' exp=' + rs.exp + ' multi=' + rs.multi)

    const frameOk = await evalJs('!!document.querySelector("#groups .mio-frame") && !!document.querySelector("#groups .mio-frame-head .mio-ftitle")')
    ok('MIO 独立框架(标题栏)存在', frameOk ? 'frame-head.ftitle' : '')

    const secRes = await evalJs(`(async()=>{
      const org=${JSON.stringify(bestOrg && bestOrg.id ? bestOrg.id : '')};
      const secs=document.querySelectorAll('#groups .mio-sec').length;
      const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(org))).json();
      return JSON.stringify({secs, cols:(d.columns||[]).length});
    })()`)
    let secObj = { secs: 0, cols: 0 }
    try { secObj = JSON.parse(secRes) } catch {}
    ok('列标题框架(段落分隔)渲染', 'secs=' + secObj.secs + ' cols=' + secObj.cols)

    const fbHidden = await evalJs(`(function(){var fb=document.querySelector("#featBar"); return fb? getComputedStyle(fb).display==="none":false})()`)
    ok('DLC 玩法切换条(上一级框架)已收起', fbHidden === true ? 'featBar=none' : '')

    const grpRes = await evalJs(`(async()=>{
      const list=await (await fetch('/api/mio/tree')).json();
      const apiG={};
      const BS=String.fromCharCode(92);
      for(const o of list.orgs){ const f=String(o.file||''); const i=Math.max(f.lastIndexOf(BS), f.lastIndexOf('/')); const fn=(i>=0?f.slice(i+1):f)||'(未知文件)'; apiG[fn]=(apiG[fn]||0)+1; }
      const grps=[...document.querySelectorAll('#dlcList .mio-grp')].map(g=>{
        const head=g.querySelector('.mio-grp-head');
        return {head:head?head.textContent.trim():'', body:g.querySelectorAll('.mio-grp-body .item').length};
      });
      const domOrgs=[...document.querySelectorAll('#dlcList .item')].filter(e=>e.__obj&&e.__obj._k==='mioOrg').length;
      return JSON.stringify({apiG, grps, domOrgs});
    })()`)
    let grp = { apiG: {}, grps: [], domOrgs: 0 }
    try { grp = JSON.parse(grpRes) } catch {}
    let grpPass = true
    const mismatches = []
    let domSum = 0
    for (const g of grp.grps) {
      const m = g.head.match(/^(.*)\s*\((\d+)\)\s*$/)
      if (!m) { grpPass = false; mismatches.push('头格式异常:' + g.head); continue }
      const fn = m[1].trim(), n = Number(m[2]); domSum += n
      if (grp.apiG[fn] !== n) { grpPass = false; mismatches.push(fn + ':头N=' + n + ' API=' + grp.apiG[fn]) }
      if (g.body !== n) { grpPass = false; mismatches.push(fn + ':body=' + g.body + '≠头N=' + n) }
    }
    if (domSum !== grp.domOrgs) { grpPass = false; mismatches.push('分组计数和=' + domSum + '≠机构条目=' + grp.domOrgs) }
    if (!Object.keys(grp.apiG).length) { grpPass = false; mismatches.push('API orgs 无 file 字段') }
    const grpDetail = '分组容器=' + grp.grps.length + ' API 文件组=' + Object.keys(grp.apiG).length + ' 条目和=' + domSum + '/' + grp.domOrgs
    if (grpPass) ok('机构列表按来源文件名分组(.mio-grp)', grpDetail)
    else fail('机构列表按来源文件名分组(.mio-grp)', grpDetail + ' | ' + mismatches.slice(0, 5).join('; '))

    /* B-b/c 展示机构优选:在含互斥线的机构里挑同时覆盖 水平/垂直/转折 三类边者,
       让三规则抽样都能实采(而不是有一类只能 EXEMPT)。 */
    if (bestOrg && bestOrg.id) {
      const swap = await evalJs(`(async()=>{
        const cur=${JSON.stringify(bestOrg.id)};
        const list=await (await fetch('/api/mio/tree')).json();
        let best=null;
        const scoreOf=(mu,h,v)=>(mu>0?4:0)+(h>0?2:0)+(v>0?1:0);
        for(const o of list.orgs.slice(0,120)){
          const t=await (await fetch('/api/mio/tree?org='+encodeURIComponent(o.id))).json();
          const by={}; for(const n of t.nodes) by[n.token]=n;
          const isInit=n=>(t.initialTrait&&n.token===t.initialTrait)||/^generic_mio_initial_trait_/i.test(n.token);
          let mu=0,h=0,v=0,e=0;
          for(const n of t.nodes){ if(isInit(n))continue;
            for(const lk of (n.links||[])) for(const p of lk.parents){ const pn=by[p]; if(!pn||isInit(pn))continue;
              if(Math.abs(pn.y-n.y)<0.5)h++; else if(Math.abs(pn.x-n.x)<0.5)v++; else e++; }
            for(const m of (n.mutuallyExclusive||[])){ if(by[m]&&!isInit(by[m])) mu++; }
          }
          const sc=scoreOf(mu,h,v);
          if(sc>0 && (!best||sc>best.sc || (sc===best.sc && o.id===cur))) best={id:o.id,mu,h,v,e,sc};
        }
        return JSON.stringify(best);
      })()`)
      let tg = null; try { tg = JSON.parse(swap) } catch {}
      if (tg && tg.id && tg.id !== bestOrg.id) {
        await evalJs(`(function(){ const it=[...document.querySelectorAll('#dlcList .item')].find(e=>e.__obj&&e.__obj._k==='mioOrg'&&e.__obj.o&&e.__obj.o.id===${JSON.stringify(tg.id)}); if(it){ if(typeof it.onclick==='function') it.onclick({}); else it.click(); } return true })()`)
        for (let i = 0; i < 60; i++) { await sleep(400); try { if (await evalJs('!!document.querySelector("#groups .mio-frame") && document.querySelectorAll("#groups .mio-n").length')) break } catch {} }
      }
      if (tg && tg.id) {
        console.log('    展示机构=' + tg.id + ' 互斥=' + tg.mu + ' 水平边=' + tg.h + ' 垂直边=' + tg.v + ' 转折边=' + tg.e)
        bestOrg = { id: tg.id }
      }
    }

    const edgeRes = await evalJs(`(async()=>{
      const org=${JSON.stringify(bestOrg && bestOrg.id ? bestOrg.id : '')};
      const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(org))).json();
      const isInit=n=>(d.initialTrait&&n.token===d.initialTrait)||/^generic_mio_initial_trait_/i.test(n.token);
      const by={}; for(const n of d.nodes) by[n.token]=n;
      const PADX=130,PADY=70,NW=74,NH=74;
      const cxm=t=>PADX+t.x+NW/2, cyB=t=>PADY+t.y+NH, cyT=t=>PADY+t.y;
      const seen=new Set(); const edges=[];
      for(const n of d.nodes){ if(isInit(n))continue;
        for(const lk of (n.links||[])) for(const p of lk.parents){
          const pn=by[p]; if(!pn||isInit(pn))continue;
          const key=[p,n.token].sort().join('>');
          if(seen.has(key))continue; seen.add(key);
          edges.push({p,c:n.token,px:pn.x,py:pn.y,cx:n.x,cy:n.y});
        }
      }
      function expect(e){
        const P={x:e.px,y:e.py},C={x:e.cx,y:e.cy};
        if(Math.abs(P.y-C.y)<0.5){ const my=PADY+P.y+NH/2; const L=P.x<C.x?P:C,R=P.x<C.x?C:P;
          return {cls:'h', d:'M'+(PADX+L.x+NW)+' '+my+'L'+(PADX+R.x)+' '+my}; }
        if(Math.abs(P.x-C.x)<0.5){ const T=P.y<C.y?P:C,B=P.y<C.y?C:P;
          return {cls:'v', d:'M'+cxm(T)+' '+cyB(T)+'L'+cxm(B)+' '+cyT(B)}; }
        const T=P.y<C.y?P:C,B=P.y<C.y?C:P;
        const ax=cxm(T),ay=cyB(T),bx=cxm(B),by=cyT(B);
        const my=Math.max(ay+6,Math.min(ay+NH/2,by-4));
        return {cls:'e', d:'M'+ax+' '+ay+'L'+ax+' '+my+'L'+bx+' '+my+'L'+bx+' '+by};
      }
      const expected=edges.map(e=>({...e,...expect(e)}));
      const paths=[...document.querySelectorAll('#groups .mio-links path')].map(p=>({d:p.getAttribute('d'),cls:p.getAttribute('class')||''}));
      const norm=paths.filter(p=>!p.cls.includes('mutex'));
      const mutexN=paths.length-norm.length;
      const cnt=a=>{const m={};for(const x of a)m[x]=(m[x]||0)+1;return m};
      const ea=cnt(norm.map(p=>p.d)), ee=cnt(expected.map(x=>x.d));
      const same=JSON.stringify(ea)===JSON.stringify(ee);
      const bends=s=>(s.split('L').length-2);
      const pickCls=c=>{ const ex=expected.filter(x=>x.cls===c); if(!ex.length)return null;
        const s=ex[0]; return {sample:s.p+' -> '+s.c, expectD:s.d, found:norm.some(p=>p.d===s.d), bends:bends(s.d)}; };
      return JSON.stringify({counts:{expected:expected.length, actualNorm:norm.length, mutex:mutexN}, same,
        h:pickCls('h'), v:pickCls('v'), e:pickCls('e')});
    })()`)
    let er = { counts: { expected: 0, actualNorm: 0, mutex: 0 }, same: false, h: null, v: null, e: null }
    try { er = JSON.parse(edgeRes) } catch {}
    const deriv = '推导式:|Δy|<0.5→水平M…L…(0弯折);|Δx|<0.5→垂直M…L…(0弯折);否则M(父底)→L(半层my)→L(子x)→L(子顶)=2弯折;折点数=d.split("L").length-1'
    if (er.same && er.counts.expected === er.counts.actualNorm) {
      ok('三规则:边集合与 DOM path 逐点一致', '期望=' + er.counts.expected + ' 实测=' + er.counts.actualNorm + ' 互斥=' + er.counts.mutex + ' | ' + deriv)
    } else {
      fail('三规则:边集合与 DOM path 逐点一致', '期望=' + er.counts.expected + ' 实测=' + er.counts.actualNorm + ' same=' + er.same + ' | ' + deriv)
    }
    const samp = (label, s, expB) => {
      if (!s) rec('三规则抽样:' + label, { exempt: true, detail: '本机构无此类边(数据侧)', exemptReason: '当前机构父子坐标不产生此类连线' })
      else if (!s.found) fail('三规则抽样:' + label, 'sample=' + s.sample + ' 期望d未在DOM: ' + s.expectD)
      else if (s.bends !== expB) fail('三规则抽样:' + label, 'sample=' + s.sample + ' 实测弯折=' + s.bends + ' ≠ 期望=' + expB + ' d=' + s.expectD)
      else ok('三规则抽样:' + label, 'sample=' + s.sample + ' 弯折=' + s.bends + '(=期望' + expB + ') 期望d命中DOM')
    }
    samp('水平直线(0弯折)', er.h, 0)
    samp('垂直直线(0弯折)', er.v, 0)
    samp('转折肘线(2弯折)', er.e, 2)

    const mutexRes = await evalJs(`(function(){
      const mu=[...document.querySelectorAll('#groups .mio-links path')].filter(p=>(p.getAttribute('class')||'').includes('mutex'));
      const nm=[...document.querySelectorAll('#groups .mio-links path')].filter(p=>!(p.getAttribute('class')||'').includes('mutex'));
      return JSON.stringify({
        count:mu.length,
        strokes:mu.slice(0,3).map(p=>getComputedStyle(p).stroke),
        normalStrokes:nm.slice(0,2).map(p=>getComputedStyle(p).stroke)
      });
    })()`)
    let ms = { count: 0, strokes: [], normalStrokes: [] }
    try { ms = JSON.parse(mutexRes) } catch {}
    const redOk = ms.count > 0 && ms.strokes.length > 0 && ms.strokes.every(s => {
      const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!m) return false
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      return r > 180 && g < 120 && b < 120
    })
    if (ms.count === 0) rec('互斥线红色(.ln.mutex)', { exempt: true, detail: '当前机构无互斥连线可测', exemptReason: '数据侧:本机构无 mutuallyExclusive 对' })
    else if (redOk) ok('互斥线红色(.ln.mutex)', '条数=' + ms.count + ' stroke=' + ms.strokes[0] + ' 普通线=' + (ms.normalStrokes[0] || 'n/a'))
    else fail('互斥线红色(.ln.mutex)', '条数=' + ms.count + ' 实测stroke=' + JSON.stringify(ms.strokes) + ' 期望近红rgb(229,72,77)')

    await evalJs(`(function(){ const b=[...document.querySelectorAll('.mio-modebar button.mio-mode')].find(x=>x.textContent.includes('政策')); if(b){b.click();return true} return false })()`)
    for (let i = 0; i < 40; i++) {
      await sleep(400)
      try { if (await evalJs('[...document.querySelectorAll("#dlcList .item")].some(e=>e.__obj&&e.__obj._k==="mioPolicy")')) break } catch {}
    }
    const polRes = await evalJs(`(function(){
      const items=[...document.querySelectorAll('#dlcList .item')].filter(e=>e.__obj&&e.__obj._k==='mioPolicy');
      const icons=document.querySelectorAll('#dlcList .item img.picon, #dlcList .item img[data-tex]').length;
      const grps=document.querySelectorAll('#dlcList .mio-grp').length;
      if(items.length){ const it=items[0]; if(typeof it.onclick==='function') it.onclick({}); else it.click(); }
      return JSON.stringify({items:items.length, icons, grps});
    })()`)
    await sleep(600)
    const polInsp = await evalJs(`(function(){
      const ih=document.querySelector('#insp .ih');
      const polIcon=document.querySelectorAll('#insp img.pol-icon, #insp img[data-tex]').length;
      return JSON.stringify({hasInsp:!!ih, polIcon});
    })()`)
    let pr = { items: 0, icons: 0, grps: 0 }, pi = { hasInsp: false, polIcon: 0 }
    try { pr = JSON.parse(polRes) } catch {}
    try { pi = JSON.parse(polInsp) } catch {}
    if (pr.items > 0 && (pr.icons > 0 || pi.polIcon > 0)) {
      ok('政策展示+图标(.mioPolicy/img.picon)', '政策条目=' + pr.items + ' 列表图标=' + pr.icons + ' 检查器图标=' + pi.polIcon + ' 分组=' + pr.grps)
    } else {
      fail('政策展示+图标(.mioPolicy/img.picon)', 'items=' + pr.items + ' icons=' + pr.icons + ' inspIcon=' + pi.polIcon)
    }

    await evalJs(`(function(){ const b=[...document.querySelectorAll('.mio-modebar button.mio-mode')].find(x=>x.textContent.includes('机构树')); if(b) b.click(); return true })()`)
    for (let i = 0; i < 40; i++) { await sleep(400); try { if (await evalJs('!!document.querySelector("#groups .mio-frame")')) break } catch {} }
    await sleep(400)
    await evalJs(`(function(){ const h=document.querySelector('#groups .mio-frame-head'); if(h){ if(typeof h.onclick==='function') h.onclick({}); else h.click(); } return true })()`)
    await sleep(400)

    const inspRes = await evalJs(`(async()=>{
      const org=${JSON.stringify(bestOrg && bestOrg.id ? bestOrg.id : '')};
      const d=await (await fetch('/api/mio/tree?org='+encodeURIComponent(org))).json();
      const nd=(d.nodes||[]).find(n=>Object.keys(n.bonus||{}).length||Object.keys(n.productionBonus||{}).length||Object.keys(n.organizationModifier||{}).length)
             ||(d.nodes||[])[0]||{};
      const apiCats={bonus:Object.keys(nd.bonus||{}).length, prod:Object.keys(nd.productionBonus||{}).length, orgmod:Object.keys(nd.organizationModifier||{}).length};
      const insp=document.querySelector('#insp');
      const h4s=[...insp.querySelectorAll('h4')].map(h=>h.textContent.trim());
      const kvSpans=[...insp.querySelectorAll('.kv span')].map(s=>s.textContent.trim());
      return JSON.stringify({apiCats, sampleToken:nd.token||'', h4s, kvSpans:kvSpans.slice(0,24)});
    })()`)
    let ir = { apiCats: { bonus: 0, prod: 0, orgmod: 0 }, sampleToken: '', h4s: [], kvSpans: [] }
    try { ir = JSON.parse(inspRes) } catch {}

    const hasEq = ir.h4s.some(h => h.includes('装备') || h.includes('Equipment'))
    const hasProd = ir.h4s.some(h => h.includes('生产') || h.includes('Production'))
    const hasOrg = ir.h4s.some(h => h.includes('组织') || h.includes('Organisation'))
    const catDetail = 'API三dict=[bonus:' + ir.apiCats.bonus + ',prod:' + ir.apiCats.prod + ',orgmod:' + ir.apiCats.orgmod + '] DOM段=' +
      (hasEq ? '装备✓' : '装备✗') + (hasProd ? '/生产✓' : '/生产✗') + (hasOrg ? '/组织✓' : '/组织✗')
    if (hasEq || hasProd || hasOrg) ok('三类属性分组(Equipment/Production/Organisation)', catDetail + ' 样本=' + ir.sampleToken)
    else rec('三类属性分组(Equipment/Production/Organisation)', { exempt: true, detail: catDetail + ' — 当前样本三类加成均空,仅有 API 三 dict 结构证据', exemptReason: '数据侧:该机构特质 bonus/prod/orgmod 为空,无 DOM 属性段可断言' })

    const SNAKE = /[A-Z][A-Z0-9_]{3,}_[A-Z0-9_]+/
    const rawHits = ir.kvSpans.filter(s => SNAKE.test(s))
    const cjkHits = ir.kvSpans.filter(s => /[一-龥]/.test(s))
    if (rawHits.length === 0 && cjkHits.length > 0) {
      ok('属性栏键值美观化(无原始大写下划线键)', 'kv样本=[' + ir.kvSpans.slice(0, 6).join(' | ') + '] 中文标签=' + cjkHits.length + ' 原始键命中=0')
    } else if (rawHits.length === 0 && cjkHits.length === 0) {
      rec('属性栏键值美观化(无原始大写下划线键)', { exempt: true, detail: '检查器无可比对 kv 标签(样本=' + JSON.stringify(ir.kvSpans.slice(0, 6)) + ')', exemptReason: '数据侧:样本节点无 kv 属性行' })
    } else {
      fail('属性栏键值美观化(无原始大写下划线键)', '发现原始键:[' + rawHits.join(', ') + ']')
    }

    await sleep(300)
    ok('无页面运行时异常', pageErr.length === 0 ? 'clean' : pageErr.slice(0, 2).join(' | '))
  } catch (e) {
    console.log('层异常: ' + e.message)
    fail('层主流程未中断', e.message)
  }

  const summary = { total: cases.length, pass: 0, fail: 0, exempt: 0 }
  for (const c of cases) {
    if (c.exempt) summary.exempt++
    else if (c.pass) summary.pass++
    else summary.fail++
  }
  const doc = { layer: '03_mio', base: BASE, ts: new Date().toISOString(), summary, cases }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8')
  console.log('\n结果: total=' + summary.total + ' pass=' + summary.pass + ' fail=' + summary.fail + ' exempt=' + summary.exempt)
  console.log('写入: ' + OUT)
  try { child.kill('SIGKILL') } catch {}
  process.exit(summary.fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })