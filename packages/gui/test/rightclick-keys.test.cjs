/* RIGHTCLICK_V1 / KEYS_V1 公共件行为验收
 *
 * 跑法(零依赖,不用装 Chromium):
 *   node packages/gui/test/rightclick-keys.test.cjs
 * 退出码 0 = 全绿,1 = 有失败,2 = 抛异常。
 *
 * 覆盖:菜单构建 / 弹出定位翻转 / 键盘导航 / 事件委托 / 复制兜底 /
 *       快捷键匹配(命名键·修饰键·输入法) / 输入态让位 / doc:true / 速查表 / 展示名
 *
 * ★ 为什么要有这个(不是"锦上添花的单测"):
 *   ctx.js 与 keys.js 是 11 个页面共用的地基,一旦静默失效是全站级的。
 *   本轮就靠它抓出两个真 bug:
 *     ① eventCombo 的 `k.length > 1 → return null` 把 F1/Escape/Tab/方向键
 *        全部判死 → 速查表(F1)根本打不开、Esc 也不生效;
 *     ② 用空函数冒充满分项注册 IDE 的 Ctrl+S 等键,会在捕获阶段
 *        preventDefault+stopPropagation,吃掉页面自己的实现
 *        (症状:"编辑框里按 Ctrl+S 没反应")→ 因此才有 doc:true 模式。
 *   两者都不会抛异常、不会打日志,只靠肉眼看页面很难第一时间归因。
 *
 * ⚠ 桩的限制(别把它当浏览器):
 *   dom-stub.cjs 只实现公共件用到的那几个 API,没有真实布局/事件冒泡/
 *   焦点顺序。所以它能证明"逻辑分支正确",不能证明"视觉与真浏览器一致"。
 *   视觉与手感仍需人眼在浏览器里过一遍。 */
;(async function () {
const fs = require('fs')
const path = require('path')
const { DOC, ev, install, CL } = require('./dom-stub.cjs')

install()

function load(f) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function(src)()
}
load('ctx.js')
// ⚠ 顺序有依赖:keymap.js 必须先加载。keys.js 的 boot() 会 bind('global.sheet'),
//   它的键位来自 keymap 目录;目录不在,F1 就注册不上(这是实测踩过的静默失效)。
load('keymap.js')
load('keys.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''))
  }
}
function section(t) {
  console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)))
}

/* ═══ 1. sourceItems 菜单结构 ═══ */
section('1. 标准源码菜单(sourceItems)')
{
  const items = Ctx.sourceItems({
    root: 0,
    rootName: 'vanilla',
    file: 'common/national_focus/abc.txt',
    line: 42,
    id: 'ABC_focus',
    loc: 'ABC_focus_loc',
    defs: [
      { root: 0, rootName: 'vanilla', file: 'common/national_focus/abc.txt', line: 42 },
      { root: 1, rootName: 'my_mod', file: 'common/national_focus/abc.txt', line: 7 },
    ],
  })
  const labels = items.filter((i) => i.label).map((i) => i.label)
  ok('有「在 IDE 中打开并定位」', labels.includes('在 IDE 中打开并定位'))
  ok('有「用 VS Code 打开」', labels.includes('用 VS Code 打开'))
  ok('有「复制 ID」', labels.includes('复制 ID'))
  ok('有「复制相对路径」', labels.includes('复制相对路径'))
  ok('有「复制「文件:行」」', labels.includes('复制「文件:行」'))
  ok('有「复制绝对路径」', labels.includes('复制绝对路径'))
  ok('loc≠id 时给「复制本地化 key」', labels.includes('复制本地化 key'))
  ok('defs>1 时给「复制全部 2 处定义位置」', labels.some((l) => l.includes('复制全部 2 处定义位置')))
  ok('标题含 file:line 与来源', items[0].title === 'common/national_focus/abc.txt:42  ·  vanilla', items[0].title)

  const noFile = Ctx.sourceItems({ root: 0, id: 'X' })
  const nl = noFile.filter((i) => i.label).map((i) => i.label)
  ok('无 file 时不出现「在 IDE 中打开」', !nl.includes('在 IDE 中打开并定位'))
  ok('无 file 时仍有「复制 ID」', nl.includes('复制 ID'))
  ok('loc===id 时不重复给「复制本地化 key」', !nl.includes('复制本地化 key'))

  const withExtra = Ctx.sourceItems({ root: 0, file: 'a.txt', line: 1, id: 'I', extra: [{ label: '自定义项', act() {} }] })
  ok('extra 被追加', withExtra.some((i) => i.label === '自定义项'))
}

/* ═══ 2. 深链 URL ═══ */
section('2. IDE 深链 URL')
{
  const u = Ctx.ideUrl(2, 'common/technologies/air_techs.txt', 7)
  ok('URL 含 root/file/line', u === '/ide#root=2&file=common%2Ftechnologies%2Fair_techs.txt&line=7', u)
  const u2 = Ctx.ideUrl(0, 'a b/c.txt')
  ok('无 line 时省略 line 参数', !u2.includes('line='), u2)
}

/* ═══ 3. 菜单弹出 / 定位翻转 ═══ */
section('3. 弹出、定位翻转、关闭')
{
  Ctx.open(300, 400, [{ label: 'A', act() {} }, { sep: true }, { label: 'B', act() {} }])
  const m = DOC.getElementById('ctxMenuRoot')
  ok('菜单元素已创建', !!m)
  ok('菜单带 on 类', m.classList.contains('on'))
  ok('菜单 HTML 含两项', m.innerHTML.includes('>A<') && m.innerHTML.includes('>B<'), m.innerHTML.slice(0, 80))
  ok('分隔线已渲染', m.innerHTML.includes('ctx-s'))
  ok('正常定位', m.style.left === '300px' && m.style.top === '400px', m.style.left + ',' + m.style.top)

  // 贴右下角 → 翻转
  Ctx.open(1590, 890, [{ label: 'A', act() {} }])
  ok('右溢出时向左翻转', parseInt(m.style.left) < 1590, m.style.left)
  ok('下溢出时向上翻转', parseInt(m.style.top) < 890, m.style.top)

  // 空菜单不弹
  Ctx.hide()
  m.classList.remove('on')
  Ctx.open(10, 10, [])
  ok('空菜单不弹出', !m.classList.contains('on'))
  Ctx.open(10, 10, null)
  ok('null 菜单不弹出', !m.classList.contains('on'))
}

/* ═══ 4. 菜单键盘导航 ═══ */
section('4. 菜单键盘导航(↑↓/Enter/Esc)')
{
  // ⚠ ctx.js 里 run() 是 hide() 之后 setTimeout(act) —— 菜单先关、动作下一 tick 才跑。
  //   这是有意的(避免在 DOM 还高亮时执行跳转导致撕裂),所以断言必须放到 tick 之后。
  const tick = () => new Promise((r) => setTimeout(r, 5))
  let ranA = 0
  let ranB = 0
  Ctx.open(50, 50, [
    { label: 'A', act: () => ranA++ },
    { label: '禁用', dis: true, act: () => { throw new Error('不该执行') } },
    { label: 'B', act: () => ranB++ },
  ])
  const m = DOC.getElementById('ctxMenuRoot')
  const selIdx = () => {
    const n = m.querySelectorAll('.ctx-i.sel')[0]
    return n ? Number(n.dataset.i) : -1
  }
  ok('弹出后默认选中第一项', selIdx() === 0, 'sel=' + selIdx())

  DOC.dispatch('keydown', ev({ key: 'ArrowDown' }))
  ok('↓ 跳过禁用项选中 B(索引 2)', selIdx() === 2, 'sel=' + selIdx())

  DOC.dispatch('keydown', ev({ key: 'Enter' }))
  await tick()
  ok('Enter 执行 B', ranB === 1, 'ranB=' + ranB)
  ok('执行后菜单关闭', !m.classList.contains('on'))
  ok('禁用项未被误执行', true)

  // ↑ 回绕
  Ctx.open(50, 50, [
    { label: 'A', act: () => ranA++ },
    { label: 'B', act: () => ranB++ },
  ])
  DOC.dispatch('keydown', ev({ key: 'ArrowUp' }))
  ok('↑ 从第一项回绕到末项', selIdx() === 1, 'sel=' + selIdx())
  DOC.dispatch('keydown', ev({ key: 'Enter' }))
  await tick()
  ok('回绕后 Enter 执行 B', ranB === 2, 'ranB=' + ranB)

  // End / Home
  Ctx.open(50, 50, [
    { label: 'A', act: () => ranA++ },
    { label: 'B', act: () => ranB++ },
    { label: 'C', act: () => ranA++ },
  ])
  DOC.dispatch('keydown', ev({ key: 'End' }))
  ok('End 跳到末项', selIdx() === 2, 'sel=' + selIdx())
  DOC.dispatch('keydown', ev({ key: 'Home' }))
  ok('Home 回到首项', selIdx() === 0, 'sel=' + selIdx())
  DOC.dispatch('keydown', ev({ key: 'Enter' }))
  await tick()
  ok('Home 后 Enter 执行 A', ranA === 1, 'ranA=' + ranA)

  // Esc 关闭
  Ctx.open(50, 50, [{ label: 'A', act() {} }])
  DOC.dispatch('keydown', ev({ key: 'Escape' }))
  ok('Esc 关闭菜单', !DOC.getElementById('ctxMenuRoot').classList.contains('on'))

  // 鼠标点击菜单项也要能执行
  let clicked = 0
  Ctx.open(50, 50, [{ label: 'X', act: () => clicked++ }])
  const xi = DOC.getElementById('ctxMenuRoot').querySelectorAll('.ctx-i')[0]
  DOC.getElementById('ctxMenuRoot').dispatch('click', ev({ target: xi }))
  await tick()
  ok('鼠标点击菜单项可执行', clicked === 1, 'clicked=' + clicked)
}

/* ═══ 5. 事件委托 ═══ */
section('5. 事件委托(画布重绘不失效)')
{
  const host = new CL('div')
  host.id = 'host'
  DOC.body.appendChild(host)
  const node = new CL('g')
  node.className = 'node'
  node.dataset.id = 'F1'
  host.appendChild(node)
  const other = new CL('rect')
  other.className = 'box'
  host.appendChild(other)

  let hits = []
  Ctx.attach(host, 'g.node', (el) => {
    hits.push(el.dataset.id)
    return [{ label: '菜单-' + el.dataset.id, act() {} }]
  })
  // 命中节点
  let e1 = ev({ target: node, clientX: 10, clientY: 10, preventDefault() { this.pd = true }, stopPropagation() {} })
  host.dispatch('contextmenu', e1)
  ok('命中 g.node 并接管菜单', hits.length === 1 && DOC.getElementById('ctxMenuRoot').classList.contains('on'))
  ok('调用了 preventDefault', e1.pd === true)
  Ctx.hide()
  // 未命中 → 放行系统菜单
  let e2 = ev({ target: other, clientX: 10, clientY: 10, preventDefault() { this.pd = true }, stopPropagation() {} })
  host.dispatch('contextmenu', e2)
  ok('未命中时不接管(不弹菜单)', hits.length === 1 && !DOC.getElementById('ctxMenuRoot').classList.contains('on'))
  ok('未命中时不 preventDefault', e2.pd !== true)
  // 返回 null → 放行
  const host2 = new CL('div')
  DOC.body.appendChild(host2)
  const n2 = new CL('g')
  n2.className = 'node'
  host2.appendChild(n2)
  Ctx.attach(host2, 'g.node', () => null)
  let e3 = ev({ target: n2, clientX: 1, clientY: 1, preventDefault() { this.pd = true }, stopPropagation() {} })
  host2.dispatch('contextmenu', e3)
  ok('返回 null 时放行', e3.pd !== true)
}

/* ═══ 6. 复制兜底 ═══ */
section('6. 复制(clipboard 缺失时兜底)')
{
  let copied = null
  document.execCommand = (cmd) => {
    if (cmd === 'copy') {
      const ta = DOC.body.children[DOC.body.children.length - 1]
      copied = ta.value
      return true
    }
    return false
  }
  // navigator.clipboard 已在 install() 里置 null → 必走 legacy
  Ctx.copy('ABC_focus', ' ID ')
  ok('无 clipboard API 时用 execCommand 兜底', copied === 'ABC_focus', String(copied))
  ok('提示已复用 #toast', !!DOC.getElementById('toast'))
  // 临时 textarea 已移除
  ok('临时 textarea 已清理', !DOC.body.children.some((c) => c.tagName === 'TEXTAREA'))
}

/* ═══ 7. keys:注册与匹配 ═══ */
section('7. keys.js 快捷键匹配')
{
  let hit = 0
  const rec = Keys.bind('mod+j', () => hit++, '测试 J', { group: '测试' })
  ok('注册返回 rec', !!rec && rec.norm === 'mod+j', rec && rec.norm)
  DOC.dispatch('keydown', ev({ key: 'j', ctrlKey: true, code: 'KeyJ' }))
  ok('Ctrl+J 命中', hit === 1, 'hit=' + hit)

  // 命名键:F1 / Escape / 方向键
  let f1 = 0
  const recF1 = Keys.bind('f1', () => f1++, 'F1 测试', { group: '测试' })
  DOC.dispatch('keydown', ev({ key: 'F1' }))
  ok('F1 命中(命名键可用)', f1 === 1, 'f1=' + f1)
  /* ⚠ 两个必须解绑/善后的点:
   *   ① 同键多绑定时"取最后注册的" —— 留着会顶掉 boot 注册的 toggleSheet。
   *   ② 这次 F1 打开的是**本件的速查表**(boot 的 toggleSheet 也在链上),
   *      必须关掉,否则第 10 节第一次按 F1 只会"关闭"已开的面板。 */
  Keys.unbind(recF1)
  Keys.sheet() // toggle:关掉刚才被打开的那张
  ok('测试用 F1 已解绑且面板已复位', Keys.list().filter((r) => r.norm === 'f1').length === 1)

  let esc = 0
  Keys.bind('escape', () => esc++, 'Esc 测试', { group: '测试' })
  DOC.dispatch('keydown', ev({ key: 'Escape' }))
  ok('Escape 命中', esc === 1, 'esc=' + esc)

  let up = 0
  Keys.bind('up', () => up++, '↑ 测试', { group: '测试' })
  DOC.dispatch('keydown', ev({ key: 'ArrowUp' }))
  ok('ArrowUp 命中(归一为 up)', up === 1, 'up=' + up)

  let sf = 0
  Keys.bind('shift+f10', () => sf++, 'Shift+F10 测试', { group: '测试' })
  DOC.dispatch('keydown', ev({ key: 'F10', shiftKey: true }))
  ok('Shift+F10 命中', sf === 1, 'sf=' + sf)

  Keys.unbind(rec)
  DOC.dispatch('keydown', ev({ key: 'j', ctrlKey: true, code: 'KeyJ' }))
  ok('unbind 后不再触发', hit === 1, 'hit=' + hit)
}

/* ═══ 8. 输入态让位 ═══ */
section('8. 焦点在输入框时单键让位')
{
  let typed = 0
  let saved = 0
  Keys.bind('k', () => typed++, '单键 K', { group: '测试' })
  Keys.bind('mod+s', () => saved++, '保存', { group: '测试', global: true })

  const inp = new CL('input')
  DOC.activeElement = inp

  let e1 = ev({ key: 'k', code: 'KeyK' })
  DOC.dispatch('keydown', e1)
  ok('输入框内单键不触发', typed === 0, 'typed=' + typed)
  ok('输入框内单键不 preventDefault(能正常打字)', e1.defaultPrevented !== true)

  let e2 = ev({ key: 's', ctrlKey: true, code: 'KeyS' })
  DOC.dispatch('keydown', e2)
  ok('输入框内 mod 快捷键仍触发', saved === 1, 'saved=' + saved)

  // 焦点离开后单键恢复
  DOC.activeElement = DOC.body
  DOC.dispatch('keydown', ev({ key: 'k', code: 'KeyK' }))
  ok('离开输入框后单键恢复', typed === 1, 'typed=' + typed)

  // 输入法组字中不拦
  let composing = 0
  Keys.bind('j', () => composing++, '组字测试', { group: '测试' })
  let e3 = ev({ key: 'Process', isComposing: true })
  DOC.dispatch('keydown', e3)
  ok('输入法组字中不拦', composing === 0 && e3.defaultPrevented !== true)
}

/* ═══ 9. doc:true 只登记不接管 ═══ */
section('9. doc:true(页面已自实现按键时只登记)')
{
  let shadow = 0
  Keys.bind('mod+d', () => shadow++, '文档项', { group: '测试', doc: true })
  const e = ev({ key: 'd', ctrlKey: true, code: 'KeyD' })
  DOC.dispatch('keydown', e)
  ok('doc:true 不执行动作', shadow === 0, 'shadow=' + shadow)
  ok('doc:true 不 preventDefault(页面自己能收到)', e.defaultPrevented !== true)
  ok('doc:true 仍出现在速查表', Keys.list().some((r) => r.combo === 'mod+d' && r.desc === '文档项'))
}

/* ═══ 10. 速查表 ═══ */
section('10. F1 速查表')
{
  // F1 的真实绑定是 keys.js 自己 boot() 时注册的(toggleSheet)。
  // ⚠ 不要再注册第二个 f1 —— 同键多绑定时"取最后注册的"会把 toggleSheet 顶掉。
  const f1s = Keys.list().filter((r) => r.norm === 'f1')
  ok('boot 已注册 f1 → 速查表', f1s.length === 1 && f1s[0].desc === '快捷键速查表', 'n=' + f1s.length)

  // 专门为第 10 节准备一条"干净"的注册项(第 7 节那些都被 unbind 了)
  Keys.bind('mod+b', () => {}, '速查表自检项', { group: '自检' })

  const hasSheet = () => DOC.body.children.some((c) => JSON.stringify(c._html || '') + (c.innerHTML || '').includes('快捷键速查'))
  /* 速查表是"造节点再搬进 body"的,不是 innerHTML 字符串 ——
     断言必须递归找文本,不能只看顶层 innerHTML。 */
  const txt = (n) => (n._text || '') + (n._html || '') + n.children.map(txt).join('')
  const findSheet = () => DOC.body.children.find((c) => txt(c).includes('快捷键速查'))

  DOC.dispatch('keydown', ev({ key: 'F1' }))
  const sh = findSheet()
  ok('F1 打开速查表', !!sh)
  if (sh) {
    const t = txt(sh)
    ok('速查表含已注册项(含说明文字)', t.includes('速查表自检项'), '注册项未列出')
    ok('速查表把 mod 显示成 Ctrl', t.includes('Ctrl+B'), '按键未按 pretty() 渲染')
    ok('速查表含鼠标说明栏', t.includes('鼠标'))
    ok('速查表列出快捷键统计', /\d+ 项/.test(t), t.slice(-50))
    ok('速查表有关闭按钮 .sh-x', sh.querySelectorAll('.sh-x').length === 1)
  }
  // 再按 F1 关闭
  DOC.dispatch('keydown', ev({ key: 'F1' }))
  ok('再按 F1 关闭', !findSheet())
  // Esc 也能关
  DOC.dispatch('keydown', ev({ key: 'F1' }))
  ok('F1 再次打开', !!findSheet())
  DOC.dispatch('keydown', ev({ key: 'Escape' }))
  ok('Esc 关闭速查表', !findSheet())
}

/* ═══ 11. pretty 展示 ═══ */
section('11. 快捷键展示名')
{
  const cases = [
    ['mod+f', 'Ctrl+F'],
    ['f1', 'F1'],
    ['escape', 'Esc'],
    ['up', '↑'],
    ['shift+f10', 'Shift+F10'],
    ['alt+right', 'Alt+→'],
    ['space', 'Space'],
    ['mod+shift+p', 'Ctrl+Shift+P'],
    ['', ''],
  ]
  cases.forEach(([c, want]) => {
    const got = Keys.pretty(c)
    ok('pretty(' + c + ') = ' + want, got === want, 'got=' + got)
  })
}

/* ═══ 12. keymap 目录:覆盖 / 默认 / 禁用 ═══ */
section('12. keymap 目录与用户覆盖')
{
  const KM = global.Keymap
  ok('keymap.js 已加载', !!KM)
  ok('目录里有 20+ 个动作', KM.ACTIONS.length >= 20, '实际 ' + KM.ACTIONS.length)
  // 默认值
  ok('默认 view.zoomIn = [+, =]', JSON.stringify(KM.defaultKeysOf('view.zoomIn')) === '["+","="]')
  ok('默认 find.search = [/, mod+f]', JSON.stringify(KM.defaultKeysOf('find.search')) === '["/","mod+f"]')
  ok('未覆盖时 keysOf = 默认', JSON.stringify(KM.keysOf('view.fit')) === '["f"]')
  ok('未覆盖时 isCustom=false', KM.isCustom('view.fit') === false)
  // resolve:没覆盖也要给默认(这正是 bind 的回退路径,曾因漏掉导致全站快捷键静默失联)
  ok('resolve 未覆盖时给默认', JSON.stringify(KM.resolve('view.fit')) === '["f"]')
  // 写入覆盖
  const r = KM.set('view.fit', 'mod+shift+f')
  ok('set 返回 ok', r.ok === true)
  ok('覆盖生效', JSON.stringify(KM.keysOf('view.fit')) === '["mod+shift+f"]', JSON.stringify(KM.keysOf('view.fit')))
  ok('isCustom=true', KM.isCustom('view.fit') === true)
  ok('defaultKeysOf 仍是默认', JSON.stringify(KM.defaultKeysOf('view.fit')) === '["f"]')
  ok('customCount=1', KM.customCount() === 1)
  // 显式禁用 = 存空串
  KM.set('view.zoomIn', '')
  ok('禁用后 keysOf=[]', KM.keysOf('view.zoomIn').length === 0)
  ok('禁用后 resolve 回落默认', JSON.stringify(KM.resolve('view.zoomIn')) === '["+","="]')
  // 恢复
  KM.reset('view.fit')
  ok('reset 后回到默认', JSON.stringify(KM.keysOf('view.fit')) === '["f"]')
  ok('reset 后 isCustom=false', KM.isCustom('view.fit') === false)
}

/* ═══ 13. 冲突检测(同页作用域) ═══ */
section('13. 冲突检测')
{
  const KM = global.Keymap
  // 默认状态不该有冲突
  const conf0 = KM.allConflicts()
  ok('默认键位零冲突', conf0.length === 0, JSON.stringify(conf0))
  // 把「缩小 -」改成与「重置缩放 mod+0」相同 → 同页(view)撞车
  KM.set('view.zoomOut', 'mod+0')
  const c = KM.conflictsOf('view.zoomOut')
  ok('缩小与重置缩放撞键', c.some((x) => x.id === 'view.zoomReset'), JSON.stringify(c))
  ok('冲突项带页名', c.length > 0 && c[0].page === 'focus')
  ok('allConflicts 能查出', KM.allConflicts().length > 0)
  // 跨页不算冲突:find.search 改到 mod+0 —— ide 页有 mod+0?没有,focus/tech 有 view.zoomReset → 算撞
  // 但 global.sheet 改到 'f' 只在全局域,view.fit 也在 focus/tech → 应报 focus+tech 两处
  KM.set('global.sheet', 'f')
  const cs = KM.conflictsOf('global.sheet')
  ok('全局动作跨页分别报冲突', cs.length >= 2, JSON.stringify(cs))
  // 禁用后不冲突
  KM.set('view.zoomOut', 'mod+0')
  KM.set('view.zoomReset', '') // 禁用重置缩放 → 缩小的 mod+0 不再撞
  ok('禁用后冲突消失', KM.conflictsOf('view.zoomOut').length === 0)
  KM.resetAll()
  ok('resetAll 清空', KM.customCount() === 0)
  ok('resetAll 后零冲突', KM.allConflicts().length === 0)
}

/* ═══ 14. bind 遵循覆盖 ═══ */
section('14. bind 使用覆盖后的键位')
{
  const KM = global.Keymap
  let hit = 0
  KM.set('view.fit', 'mod+shift+j')
  const rec = Keys.bind(null, () => { hit++ }, '测试:缩放至适合窗口', { id: 'view.fit', group: '__t' })
  ok('rec.keys 来自目录', JSON.stringify(rec.keys) === '["mod+shift+j"]', JSON.stringify(rec.keys))
  // ⚠ 大写 J + Shift:e.code 兜底只处理单字符,Shift 已体现在字符本身上
  DOC.dispatch('keydown', ev({ key: 'J', ctrlKey: true, shiftKey: true }))
  ok('新键位触发', hit === 1, 'hit=' + hit)
  DOC.dispatch('keydown', ev({ key: 'f' }))
  ok('旧键位不再触发(改绑真的生效)', hit === 1, 'hit=' + hit)
  Keys.unbind(rec)
  // 多键位
  const r2 = Keys.bind(null, () => {}, '测试:搜索', { id: 'find.search', group: '__t' })
  ok('多键位两个都注册', JSON.stringify(r2.keys) === '["/","mod+f"]', JSON.stringify(r2.keys))
  Keys.unbind(r2)
  // 禁用 → 不注册按键,但仍进速查表
  KM.set('view.zoomOut', '')
  const r3 = Keys.bind(null, () => {}, '测试:缩小', { id: 'view.zoomOut', group: '__t' })
  ok('禁用后 rec.disabled=true', r3.disabled === true)
  DOC.dispatch('keydown', ev({ key: '-' }))
  ok('禁用后按键不被接管(能正常打字)', true)
  Keys.unbind(r3)
  KM.resetAll()
}

/* ═══ 15. 导出 / 导入 ═══ */
section('15. 键位导出导入')
{
  const KM = global.Keymap
  KM.set('view.fit', 'mod+9')
  const txt = KM.exportMap()
  ok('导出是 JSON', txt.indexOf('"view.fit"') > 0)
  ok('导出含版本号', JSON.parse(txt).v === 1)
  KM.resetAll()
  const r = KM.importMap(txt)
  ok('导入 ok', r.ok === true)
  ok('导入应用了 1 项', r.applied === 1)
  ok('导入后键位还原', JSON.stringify(KM.keysOf('view.fit')) === '["mod+9"]')
  const bad = KM.importMap('{不是 json')
  ok('非法 JSON 被拒', bad.ok === false)
  const r2 = KM.importMap(JSON.stringify({ keymap: { 'view.fit': 'mod+8', '不存在.id': 'x' } }))
  ok('未知 id 被剔除', r2.unknown.indexOf('不存在.id') >= 0)
  ok('合法项仍导入', JSON.stringify(KM.keysOf('view.fit')) === '["mod+8"]')
  KM.resetAll()
}

/* ═══ 16. fromEvent = 录制用的归一化 ═══ */
section('16. 录制归一 fromEvent')
{
  const cases = [
    [{ key: 'F5' }, 'f5'],
    [{ key: 'Escape' }, 'escape'],
    [{ key: 'ArrowUp' }, 'up'],
    [{ key: '/', ctrlKey: true }, 'mod+/'],
    [{ key: 'K', ctrlKey: true, metaKey: false }, 'mod+k'],
    [{ key: 'Tab', ctrlKey: true }, 'mod+tab'],
    [{ key: 'ArrowRight', altKey: true }, 'alt+right'],
    [{ key: 'F10', shiftKey: true }, 'shift+f10'],
    // ⚠ Shift+字母曾被整个吞掉:normKey 强制小写后字符本体不再体现 Shift,
    //   导致 Ctrl+Shift+P 与 Ctrl+P 算出同一个 mod+p。锁死这条。
    [{ key: 'P', ctrlKey: true, shiftKey: true }, 'mod+shift+p'],
    [{ key: 'J', ctrlKey: true, shiftKey: true }, 'mod+shift+j'],
    [{ key: 'A', shiftKey: true }, 'shift+a'],
    [{ key: 'a' }, 'a'],
    // Shift+符号仍按"字符本体"约定(不产生 shift+! 这种没法注册的串)
    [{ key: '!', shiftKey: true }, '!'],
    [{ key: 'Dead' }, null],
    [{ key: 'Unidentified' }, null],
    [{}, null],
  ]
  cases.forEach(([e, want]) => {
    const got = Keys.fromEvent(e)
    ok('fromEvent(' + JSON.stringify(e) + ') = ' + want, got === want, 'got=' + got)
  })
  // 录到的键必须与 bind 认的键同一套词汇(否则存进去按不响)
  ok('录到的 f5 能被 bind 认', Keys.norm('F5') === Keys.fromEvent({ key: 'F5' }))
  ok('录到的 up 能被 bind 认', Keys.norm('ArrowUp') === Keys.fromEvent({ key: 'ArrowUp' }))
}

/* ═══ 17. ctxwire.js 接线骨架 ═══ */
section('17. ctxwire 接线骨架')
{
  load('ctxwire.js')
  ok('CtxWire 导出 attach', typeof CtxWire.attach === 'function')
  ok('CtxWire 导出 commonKeys', typeof CtxWire.commonKeys === 'function')
  ok('CtxWire 导出 toast', typeof CtxWire.toast === 'function')

  /* 事件委托:在容器上绑一次,之后动态塞进去的元素也要能命中 */
  const host = DOC.createElement('div')
  const seen = []
  const origAttach = Ctx.attach
  Ctx.attach = (root, sel, fn) => { seen.push([root, sel]); return origAttach(root, sel, fn) }
  let ok1 = CtxWire.attach({
    page: 'loc',
    on: [{ host: host, sel: 'tbody tr', obj: (el) => ({ id: 'x' }), items: () => [{ label: 'a' }] }],
    keys: [{ keys: 'j', desc: '下移', run: () => { seen.push('j') } }],
  })
  ok('attach 返回 true', ok1 === true)
  ok('写入了 __KEYMAP_PAGE__', window.__KEYMAP_PAGE__ === 'loc')
  ok('右键绑到了指定容器', seen.length >= 1 && seen[0][0] === host && seen[0][1] === 'tbody tr')

  /* obj 返回 null → 不给菜单(不能拿空菜单糊住右键) */
  let called = 0
  Ctx.attach(host, '.card', () => { called++; return null })
  const row = DOC.createElement('tr')
  row.className = 'card'
  host.appendChild(row)
  const cm = ev({ type: 'contextmenu', target: row })
  row.dispatchEvent(cm)
  ok('委托命中了动态插入的元素', called === 1)
  ok('obj 返回 null 时不吞掉默认右键', cm.defaultPrevented === false)
  ok('obj 返回 null 时菜单没打开', !DOC.getElementById('ctxMenuRoot').className.match(/\bon\b/))

  /* 反之:obj 有返回就该弹并吞掉默认右键。
     ⚠ 必须换一个 host:上一个 attach 在同一个 host 上,stopPropagation
     会截断后续冒泡,复用 host 测出来的"没弹"是假阴性。
     ⚠ 判据用菜单 DOM 的 class,而不是替换 Ctx.open 计数 ——
     ctx.js 的 attach 内部直接调用模块作用域的 open,替换全局 Ctx.open
     它看不见(这是"测不到"而不是"没弹",别被它骗了)。 */
  const host2 = DOC.createElement('div')
  Ctx.attach(host2, '.card', () => [{ label: 'x' }])
  const row2 = DOC.createElement('tr')
  row2.className = 'card'
  host2.appendChild(row2)
  const cm2 = ev({ type: 'contextmenu', target: row2 })
  row2.dispatchEvent(cm2)
  ok('有菜单时弹出', /ctx-i/.test(DOC.getElementById('ctxMenuRoot').innerHTML))
  ok('有菜单时阻止默认右键', cm2.defaultPrevented === true)
  Ctx.attach = origAttach

  /* ★★ 无头浏览器实测抓到的两个 bug 的回归判据(2026-10-05)。
   *   这两个都是 200/200 全绿时漏掉的 —— 桩测看不出来:
   *   ① host 传选择器**字符串**(八页的声明式写法就是字符串),
   *      而 Ctx.attach 原来只认元素 → root.addEventListener 抛
   *      "is not a function" → **八页右键全部静默失效**。
   *      桩里两边都恰好是元素,所以永远测不到。
   *      无头 Edge 里是 "TypeError: root.addEventListener is not a function"。 */
  const strHost = DOC.createElement('div')
  strHost.id = 'strHostBox'
  DOC.body.appendChild(strHost)
  let viaStr = 0
  Ctx.attach('#strHostBox', '.card', () => { viaStr++; return [{ label: 's' }] })
  const srow = DOC.createElement('div')
  srow.className = 'card'
  strHost.appendChild(srow)
  srow.dispatchEvent(ev({ type: 'contextmenu', target: srow }))
  ok('host 可以是选择器字符串(八页的写法)', viaStr === 1, '命中 ' + viaStr)

  /* 容器还没渲染时不能静默放弃:应重试并最终绑上。
   * 桩的 flushTimers 会把 Ctx.attach 内部那个重试 setInterval 立刻跑掉。 */
  let lateHits = 0
  Ctx.attach('#notYetThere', '.card', () => { lateHits++; return [{ label: 'l' }] })
  const lateBox = DOC.createElement('div')
  lateBox.id = 'notYetThere'
  const lateRow = DOC.createElement('div')
  lateRow.className = 'card'
  lateBox.appendChild(lateRow)
  lateRow.dispatchEvent(ev({ type: 'contextmenu', target: lateRow }))
  ok('容器出现之前右键不误弹', lateHits === 0, '命中 ' + lateHits)
  DOC.body.appendChild(lateBox)          // 容器"晚到"
  if (global.flushTimers) global.flushTimers()   // 推进重试
  lateRow.dispatchEvent(ev({ type: 'contextmenu', target: lateRow }))
  ok('容器后出现也能绑上(不静默失效)', lateHits === 1, '命中 ' + lateHits)

  /* commonKeys:必须有 id 才复制,没选中要明说而不是静默 */
  let copied = null
  document.execCommand = (cmd) => {
    if (cmd === 'copy') { copied = DOC.body.children[DOC.body.children.length - 1].value; return true }
    return false
  }
  const ks = CtxWire.commonKeys(() => ({ id: 'demo_id' }), { label: '条目' })
  ok('commonKeys 给 2 项', ks.length === 2)
  ok('commonKeys 首项是 sel.copyId', ks[0].id === 'sel.copyId', ks[0].id)
  ok('commonKeys 次项是 sel.menu', ks[1].id === 'sel.menu', ks[1].id)
  ks[0].run()
  ok('复制了选中 id', String(copied || '').indexOf('demo_id') >= 0, String(copied))
  const ks2 = CtxWire.commonKeys(() => null, { label: '条目' })
  ks2[0].run()
  ok('没选中时提示而不是静默', String(DOC.getElementById('toast').textContent).indexOf('先点选') >= 0)

  /* ★★ o() 返回**字符串**时也必须能复制(无头浏览器实测抓到的)。
   *   loc.js 传 curId → 返回 c.key;designer.js 传 curId → 返回 n.id,
   *   都是字符串。老实现只判 !d.id,而字符串的 .id 是 undefined,
   *   于是两页的「复制 id」快捷键**从来没生效过** ——
   *   不抛异常、页面照常加载,桩测与冒烟全都测不出来。 */
  copied = null
  const ksStr = CtxWire.commonKeys(() => 'SOME_ID', { label: '条目' })
  ksStr[0].run()
  ok('o() 返回字符串时也能复制 id', String(copied || '').indexOf('SOME_ID') >= 0, String(copied))
  const ksObj = CtxWire.commonKeys(() => ({ id: 'OBJ_ID' }), { label: '条目' })
  ksObj[0].run()
  ok('o() 返回对象时也能复制 id', String(copied || '').indexOf('OBJ_ID') >= 0, String(copied))
  const ksEmpty = CtxWire.commonKeys(() => '', { label: '条目' })
  ksEmpty[0].run()
  ok('o() 返回空串时提示而不是复制空',
    String(DOC.getElementById('toast').textContent).indexOf('先点选') >= 0, String(copied))

  /* ★ 给了 id 就把键位交给目录(combo 位传 null)——
   *   两处都写会让 keys 只在"目录查不到"时才用,改了不生效还误导人。 */
  let ran = 0
  CtxWire.attach({
    page: 'loc',
    keys: [{ id: 'loc.edit', desc: 'x', run: () => ran++ }],
  })
  const kmEdit = Keymap.keysOf('loc.edit')
  ok('loc.edit 在目录里', Array.isArray(kmEdit) && kmEdit.length > 0)
  ok('loc.edit 绑到 enter(表格里 Enter 进编辑)', kmEdit.indexOf('enter') >= 0, JSON.stringify(kmEdit))
  ok('接线不覆盖目录键位', ran === 0)
  /* ★ 目录里不该有跨页撞车的键位。撞了会两页同时响应,
   *   且用户在设置页改其中一个会以为另一个也跟着变。 */
  const dup = Keymap.allConflicts ? Keymap.allConflicts() : []
  ok('目录零冲突', Array.isArray(dup) && dup.length === 0, JSON.stringify(dup))
}

/* ═══ 18. fullscreen.js 全屏公共件 ═══ */
section('18. fullscreen 全屏件')
{
  /* ★ 这一段本身就是回归:fullscreen.js 的 IIFE 曾声明 (global) 却收尾 `})()`,
   *   导致 global 是 undefined、整份文件抛 TypeError 静默失效 ——
   *   语法检查是绿的、页面也不报错,只是全屏按钮永远不出现。 */
  load('fullscreen.js')
  ok('挂上了 window.Fullscreen', typeof Fullscreen === 'object')
  ok('导出齐全',
    ['toggle', 'enter', 'exit', 'active', 'supported', 'label', 'mount']
      .every((k) => typeof Fullscreen[k] === 'function'))
  ok('初始不在全屏', Fullscreen.active() === false)
  ok('supported() 返回布尔', typeof Fullscreen.supported() === 'boolean')
  ok('label() 返回字符串', typeof Fullscreen.label() === 'string')

  /* 幂等:两次 mount 不能插两个按钮 —— nav.js 与 fullscreen.js 是两条调用路径 */
  const nav = DOC.createElement('nav')
  nav.id = 'nav'
  const links = DOC.createElement('div')
  links.className = 'navlinks'
  nav.appendChild(links)
  DOC.body.appendChild(nav)
  Fullscreen.mount()
  Fullscreen.mount()
  ok('重复 mount 只留一个按钮', DOC.querySelectorAll('#fsBtn').length === 1)
  ok('按钮插在 .navlinks 最前', links.firstElementChild && links.firstElementChild.id === 'fsBtn')

  /* 第二种宿主:#topnav(open.html)也要认 */
  const top = DOC.createElement('nav')
  top.id = 'topnav'
  DOC.body.appendChild(top)
  ok('认 #topnav 宿主', Fullscreen.mount() !== false)
}

/* ═══ 19. 各新页面确实用上了 id(不是裸 keys) ═══
 * 判据:接线里出现裸 keys 说明该键位**不在 keymap 目录里**,
 * 用户在设置页改不动它 —— 这正是 KEYMAP_V1 要消灭的写法。
 * ⚠ sel.copyId / sel.menu 由 commonKeys() 统一提供,不逐页写字面量;
 *   所以那两项在页面里查不到是正常的,要单独验 commonKeys 自己用 id。 */
section('19. 新接入页的键位都进了目录')
{
  const pages = {
    'loc.js': ['find.search', 'sel.clear', 'nav.nextItem', 'nav.prevItem',
      'nav.nextCol', 'nav.prevCol', 'loc.edit'],
    'dlc.js': ['find.search', 'sel.clear', 'nav.nextItem', 'nav.prevItem',
      'dlc.onlyDlc', 'dlc.clearDlc'],
    'designer.js': ['view.fit', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'view.toggleTex',
      'designer.save', 'designer.preview', 'designer.discard', 'designer.parent', 'designer.firstChild',
      'designer.sibling', 'designer.prevSibling', 'sel.clear'],
    'create.js': ['find.search', 'create.gen', 'create.nextFile', 'create.prevFile', 'create.copyFile',
      'create.sample', 'create.clear', 'sel.clear'],
    'events.js': ['find.search', 'sel.copyId', 'sel.menu', 'nav.nextItem', 'nav.prevItem', 'sel.clear'],
    'ref.js': ['find.search', 'sel.copyId', 'sel.menu', 'nav.nextItem', 'nav.prevItem', 'sel.clear'],
    'decisions.js': ['find.search', 'sel.clear'],
  }
  for (const [file, ids] of Object.entries(pages)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8')
    const missing = ids.filter((id) => src.indexOf("id: '" + id + "'") < 0)
    ok(file + ' 的 ' + ids.length + ' 个键位都用 id', missing.length === 0, '缺: ' + missing.join(','))
    const bare = /\{\s*keys:\s*['"`]/.test(src)
    ok(file + ' 无裸 keys 声明', !bare)
  }
  /* sel.copyId / sel.menu 走 commonKeys —— 那里也必须是 id,
   *   否则这两项在设置页改不动,而且七页各写一遍裸键位必然漂移。 */
  const cw = fs.readFileSync(path.join(__dirname, '..', 'public', 'ctxwire.js'), 'utf8')
  ok('commonKeys 用 sel.copyId 目录项', cw.indexOf("id: 'sel.copyId'") >= 0)
  ok('commonKeys 用 sel.menu 目录项', cw.indexOf("id: 'sel.menu'") >= 0)
  ok('commonKeys 不再声明裸键位', !/\{\s*keys:\s*['"`]/.test(cw))
  /* docs.html 的 id 在 HTML 里,单独查 */
  const docs = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'), 'utf8')
  const docIds = ['find.search', 'docs.top', 'docs.nextSec', 'docs.prevSec', 'docs.shortcuts']
  const dm = docIds.filter((id) => docs.indexOf("id: '" + id + "'") < 0)
  ok('docs.html 的键位都用 id', dm.length === 0, '缺: ' + dm.join(','))
  /* 公共件必须在 module 脚本之前(否则是踩"defer 顺序"的隐性依赖)。
     ⚠ 只认**行首就是标签**的那一行 —— 注释里也写着 `<script type="module">`
     这串字,单纯 indexOf 会命中注释,断言永远为真(假绿)。 */
  const lines = docs.split('\n')
  const ci = lines.findIndex((l) => l.indexOf('src="/ctxwire.js"') >= 0 && l.trim().indexOf('<script') === 0)
  const mi = lines.findIndex((l) => l.trim().indexOf('<script type="module">') === 0)
  ok('docs.html 公共件在 module 之前', ci > 0 && mi > 0 && ci < mi, 'ctxwire@' + ci + ' module@' + mi)
}

/* ═══ 20. 各页都真的调了接线 ═══ */
section('20. 八个页面都接了线')
{
  const pages = {
    'decisions.js': 'decisions', 'events.js': 'events', 'ref.js': 'ref', 'loc.js': 'loc',
    'dlc.js': 'dlc', 'designer.js': 'designer', 'create.js': 'create',
  }
  for (const [file, page] of Object.entries(pages)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8')
    ok(file + ' 声明了 page: ' + page, src.indexOf("page: '" + page + "'") >= 0)
    ok(file + ' 调了 CtxWire.attach', /CtxWire\.attach|Ctx\.attach/.test(src))
  }
  /* __obj 是"数据挂元素"的落地处,少一个就有一处右键会失配 */
  const needObj = {
    'loc.js': ['S.hit'], 'dlc.js': ["_k: 'item'", "_k: 'mioOrg'", "_k: 'mioNode'", "_k: 'feature'", "_k: 'dlc'", "_k: 'featbar'"],
    'designer.js': ['row.__obj = n', 'd.__obj = n'],
    'create.js': ['tab.__obj = f'],
  }
  for (const [file, marks] of Object.entries(needObj)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8')
    const miss = marks.filter((m) => src.indexOf(m) < 0)
    ok(file + ' 挂了数据到元素', miss.length === 0, '缺: ' + miss.join(','))
  }
}

section('21. 语言下拉的数据形状(无头浏览器抓出的全站级 bug)')
{
  /* ★ 服务端 /api/loc/stats 同时给两个数组,字段名不同:
   *     langs       = [{ lang, keys, missing }]  统计用,**没有 id/label**
   *     langOptions = [{ id, label }]            下拉要的
   *   locclient 原来只读 j.langs,于是每个 option 的 id 是 undefined,
   *   fill() 里 .replace 直接抛 —— 全站每个挂了下拉的页面都炸。
   *   桩测测不到是因为没人测过 locclient。判据钉死"必须读 langOptions"。 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'locclient.js'), 'utf8')
  ok('locclient 优先读 langOptions', /j\.langOptions/.test(src))
  ok('locclient 有 langs 兜底', /j\.langs/.test(src))
  ok('fill 里对 id 做了兜底', /langOptions\[i\]\.id \|\|/.test(src))

  /* 真跑一遍:桩一个 fetch,验证下拉能建出来且 option 取到 id/label。
   * 关键点是**不能只看源码正则** —— 上一轮就是"源码看着对、桩测全绿"，
   * 真浏览器里 .replace 抛异常。这里必须让 fill() 真的执行一遍。 */
  const prevFetch = global.fetch
  global.fetch = (u) => {
    if (String(u).indexOf('/api/loc/stats') >= 0) {
      return Promise.resolve({
        json: () => Promise.resolve({
          ready: true,
          langs: [{ lang: 'l_english', keys: 100, missing: 0 }],   // ← 陷阱字段
          langOptions: [{ id: 'l_english', label: '英文' }],
        }),
      })
    }
    return Promise.resolve({ json: () => Promise.resolve({}) })
  }
  let lcErr = null
  try { load('locclient.js') } catch (e) { lcErr = e }
  ok('locclient 加载不抛', lcErr === null, lcErr ? lcErr.message : '')

  if (!lcErr && global.Loc && typeof global.Loc.languages === 'function') {
    const langs = await global.Loc.languages().catch(() => null)
    ok('languages() 不抛', Array.isArray(langs), String(langs))
    ok('取到的是 {id,label} 而不是 {lang,keys}',
      !!langs && langs.length > 0 && !!langs[0].id && !!langs[0].label,
      JSON.stringify(langs && langs[0]))

    const host = DOC.createElement('div')
    DOC.body.appendChild(host)
    let sel = null, selErr = null
    /* ⚠ 必须先 await languages():数据没到位时 fill() 不填 option,
     *   这是设计(下拉不能先空着再闪),不是 bug。 */
    try {
      await global.Loc.languages()
      sel = global.Loc.mountLangSelect(host, () => {})
    } catch (e) { selErr = e }
    ok('mountLangSelect 不抛(这条曾炸全站)', selErr === null, selErr ? selErr.message : '')
    ok('mountLangSelect 返回 select', !!sel && sel.tagName === 'SELECT')
    /* mountLangSelect 内部是 languages().then(fill) —— 微任务,
     * 返回时 option 还没填。冲刷一下微任务队列再看。 */
    await new Promise((r) => setImmediate(r))
    if (sel) {
      const opt = sel.querySelector ? sel.querySelector('option') : null
      ok('下拉里有 option 且 value 非 undefined',
        !!opt && opt.value !== undefined && opt.value !== '', opt ? String(opt.value) : '(无 option)')
      ok('option 显示名取自 label 而不是 undefined', !!opt && opt.textContent === '英文',
        opt ? String(opt.textContent) : '')
    }
  } else if (!lcErr) {
    ok('Loc 导出存在', false, 'global.Loc=' + typeof global.Loc)
  }
  global.fetch = prevFetch
}

console.log('\n' + '═'.repeat(60))
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail ? 1 : 0)
})().catch(e => { console.error('THREW:', e); process.exit(2) })
