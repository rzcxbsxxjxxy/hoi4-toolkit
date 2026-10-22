/* ══════════════════════════════════════════════════════════════════
 * progress.js —— 全站加载进度条(2026-10-07)
 *
 * 问题:各页面各自写「构建中…」「索引构建中…」「符号库构建中…」,
 *   样式不一、位置不一(有的在 statChip、有的在列表里),而且
 *   **页面一滚动就看不见了** —— 国策树那种要转几十秒的页面,
 *   用户根本不知道页面还在干活,以为卡死了。
 *
 * 形态:贴在顶栏正下方的一条 3px 横条,跨全宽。
 *   · 不确定态(默认):一段来回扫的高亮,表示"在干但不知道进度"
 *   · 确定态:后端给了 done/total 时显示真实百分比
 *   · 阶段文字:浮在条右侧的小字,告诉用户在干什么
 *
 * ★ 为什么大部分场景只能做不确定态:
 *   后端只有体检(CHECK_PROGRESS)真的在报 done/total,
 *   其余各图(国策/科技/决议/学说/AI/DLC/地图)都是 setImmediate
 *   一次性开跑,中间没有可上报的进度点。要做成真进度条得在每个
 *   构建器里插桩,收益不抵成本。所以这里把「不确定」如实表达出来,
 *   配一个已用秒数,而不是拿假进度条糊弄用户。
 *
 * 用法:
 *   import { progress } from './progress.js'   // module
 *   <script src="/progress.js"></script>       // 经典脚本,挂 window.Progress
 *   progress.start('正在构建国策图…')
 *   progress.tick(3, 10, '扫描焦点')            // 有真进度时调
 *   progress.done()
 * ══════════════════════════════════════════════════════════════════ */

/* ★★ 全文件包在 IIFE 里:本文件是**经典脚本**,顶层 const/let 会进
 * 全局词法作用域,与各页面脚本的同名标识符撞车 ——
 *   progress.js 的 const T  vs  worldmap.js 的 const T
 *   → SyntaxError: Identifier 'T' has already been declared,整页脚本不执行。
 * 对外只暴露 window.Progress。*/
(function () {

const T = () => (window.I18N ? window.I18N.t : (k) => k)

let elBar = null
let elFill = null
let elText = null
let t0 = 0
let timer = null
let curMsg = ''
/** 并发计数:多个请求同时在飞时,一个完成不能把别人的进度条收走 */
let depth = 0

function ensure() {
  if (elBar) return
  elBar = document.getElementById('loadbar')
  if (!elBar) {
    elBar = document.createElement('div')
    elBar.id = 'loadbar'
    elBar.className = 'loadbar'
    elBar.innerHTML = '<i class="lbfill"></i><span class="lbtext"></span>'
    // 挂在 body 最前面 → 视觉上紧贴顶栏下方(z-index 由 CSS 给足)
    document.body.insertBefore(elBar, document.body.firstChild)
  }
  elFill = elBar.querySelector('.lbfill')
  elText = elBar.querySelector('.lbtext')
}

function setText(s) {
  ensure()
  if (!elText) return
  elText.textContent = s || ''
}

function show() {
  ensure()
  if (!elBar) return
  elBar.classList.add('on')
}

function hide() {
  ensure()
  if (!elBar) return
  elBar.classList.remove('on')
  elBar.classList.remove('det')
  // 等过渡跑完再隐藏,否则进度条"啪"一下消失,像闪烁
  setTimeout(() => {
    if (!elBar.classList.contains('on')) elFill && (elFill.style.width = '0%')
  }, 260)
}

/** 秒数计时器:让"还在转"有个可读的时间证据 */
function startTimer() {
  stopTimer()
  timer = setInterval(() => {
    if (!elBar || !elBar.classList.contains('on')) return
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    // 不覆盖调用方给的确定态文案
    if (!elBar.classList.contains('det')) {
      setText(`${curMsg} · ${secs}s`)
    }
  }, 1000)
}
function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

const progress = {
  /**
   * 开始一个加载态。
   * @param {string} msg 阶段说明,例如 '正在构建国策图…'
   */
  start(msg) {
    ensure()
    depth++
    // ⚠ t0 必须在 depth 判断**之后**才重置。放前面的话,并发的第二个请求
    //   会把第一个请求已经跑的秒数清零,计时永远停在 1~2s,失去意义。
    if (depth > 1) return
    t0 = Date.now()
    curMsg = msg || T()('app.building')
    elBar.classList.remove('det', 'err')
    elFill.style.width = ''
    show()
    setText(curMsg)
    startTimer()
  },

  /**
   * 上报真实进度。
   * @param {number} done
   * @param {number} total
   * @param {string} [phase]
   */
  tick(done, total, phase) {
    ensure()
    if (!elBar || !elBar.classList.contains('on')) return
    // ⚠ total 缺失/为 0 时必须**退回不确定态**,不能什么都不做。
    //   后端只在体检那条链路上报 done/total,其余图都是 setImmediate 一次性
    //   开跑 —— 那些页面的 tick(0,0) 若被忽略,条会一直停在上一轮遗留的
    //   确定态(显示 30% 却再也不动),看起来像卡死。
    if (!(total > 0)) {
      if (elBar.classList.contains('det')) {
        elBar.classList.remove('det')
        elFill.style.width = ''
        setText(curMsg)
      }
      return
    }
    const pct = Math.max(0, Math.min(100, (done / total) * 100))
    elBar.classList.add('det')
    elFill.style.width = pct + '%'
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    setText(`${curMsg} ${done}/${total} · ${Math.round(pct)}%${phase ? ' · ' + phase : ''} · ${secs}s`)
  },

  /** 当前这一步完成。并发安全:只有归零才真正收条。 */
  done() {
    depth = Math.max(0, depth - 1)
    if (depth > 0) return
    stopTimer()
    ensure()
    elBar.classList.remove('det')
    elFill.style.width = '100%'
    hide()
  },

  /** 失败:停表并留一条红色,别让用户以为还在转 */
  fail(msg) {
    depth = 0
    stopTimer()
    ensure()
    elBar.classList.add('err')
    elBar.classList.remove('det')
    setText(msg || T()('app.error'))
    hide()
    setTimeout(() => elBar && elBar.classList.remove('err'), 1200)
  },

  /** 是否正在显示(测试与调试用) */
  get active() {
    return !!(elBar && elBar.classList.contains('on'))
  },
}

if (typeof window !== 'undefined') {
  window.Progress = progress
  /* ★ 页面加载时就建好条(只是不显示)。
   *   懒创建有个隐蔽后果:缓存命中时各图立刻 ready、从不 start,
   *   于是 #loadbar 压根不在 DOM 里 —— 之后任何依赖
   *   querySelector('#loadbar') 的逻辑(测试、样式断言)全落空,
   *   看起来像"进度条没实现"。预创建消除这个歧义。*/
  if (document.body) ensure()
  else document.addEventListener('DOMContentLoaded', ensure)
  // 页面切走时强制清掉:否则上一页的 timer 会留到下一页继续计时
  window.addEventListener('pagehide', () => progress.done())
}
})()
