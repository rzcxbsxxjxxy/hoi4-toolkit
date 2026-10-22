/* appearance.js —— 工作台外观：背景主题 / 强调色 / 应用图标。
 *
 * 放在 localStorage(gui.appearance)里,由 nav.js 在每个页面挂载时调用 applyAppearance(),
 * 所以改一次全站生效,不用逐页改代码。
 *
 * ★ 两个容易踩的点:
 *   1) favicon 必须是 SVG data URI 才能"换图标"且不落磁盘文件;
 *      <img>/CSS background 里 SVG 不允许引用外部字体,所以图标全部用基本图形画,不用 emoji。
 *   2) 深色模式下光改 CSS 变量还不够,color-scheme 要跟着变
 *      (否则滚动条/下拉框还是白底),已写进 theme.css 的 :root[data-theme]。
 */

var APPEARANCE_KEY = 'gui.appearance'

export var THEMES = [
  { id: 'light', name: '浅色', desc: '默认 · 白底' },
  { id: 'dark', name: '深色', desc: '夜间 · 深灰' },
  { id: 'midnight', name: '午夜蓝', desc: '冷调深色' },
  { id: 'sand', name: '暖砂', desc: '浅色 · 米底' },
]

export var ACCENTS = [
  { id: '', name: '默认蓝', color: '#2b6cb0' },
  { id: '#2f855a', name: '军绿', color: '#2f855a' },
  { id: '#b7791f', name: '铜金', color: '#b7791f' },
  { id: '#a8642a', name: '赭石', color: '#a8642a' },
  { id: '#6b46c1', name: '紫', color: '#6b46c1' },
  { id: '#c53030', name: '赤', color: '#c53030' },
  { id: '#0f7c8a', name: '青', color: '#0f7c8a' },
]

/* 图标全部用 path/rect/circle 画 —— SVG 在 <img> 环境里拿不到系统字体,
 * 写 emoji 或文字在部分浏览器会变成空白方块。 */
var ICON_GLYPH = {
  cog: '<path d="M32 22a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" fill="#fff"/>' +
       '<g fill="#fff">' +
       [0, 45, 90, 135, 180, 225, 270, 315].map(function (a) {
         return '<rect x="29.5" y="4" width="5" height="12" rx="1.5" transform="rotate(' + a + ' 32 32)"/>'
       }).join('') + '</g>',
  cross: '<path d="M26 12h12v14h14v12H38v14H26V38H12V26h14z" fill="#fff"/>',
  shield: '<path d="M32 10l20 7v17c0 13-9 21-20 25-11-4-20-12-20-25V17z" fill="#fff"/>' +
          '<path d="M32 18l12 4v11c0 8-5 13-12 16-7-3-12-8-12-16V22z" fill="#2b6cb0" opacity=".35"/>',
  star: '<path d="M32 10l6.6 13.6L53 25.6l-10.7 10.4L44.9 50 32 43.1 19.1 50l2.6-14L11 25.6l14.4-2z" fill="#fff"/>',
  globe: '<circle cx="32" cy="32" r="19" fill="none" stroke="#fff" stroke-width="4"/>' +
         '<ellipse cx="32" cy="32" rx="8" ry="19" fill="none" stroke="#fff" stroke-width="3"/>' +
         '<path d="M13 32h38M20 22h24M20 42h24" stroke="#fff" stroke-width="3"/>',
  flag: '<path d="M18 10h6v44h-6z" fill="#fff"/><path d="M24 14h26l-7 8 7 8H24z" fill="#fff"/>',
  map: '<path d="M10 18l16-6v34l-16 6z" fill="#fff"/><path d="M28 12l16 6v34l-16-6z" fill="#fff" opacity=".72"/><path d="M46 18l8-4v34l-8 4z" fill="#fff" opacity=".5"/>',
  helmet: '<path d="M12 30a20 20 0 0 1 40 0v6H12z" fill="#fff"/><rect x="8" y="34" width="48" height="7" rx="3" fill="#fff"/>',
}

export var ICONS = [
  { id: 'hoi4', name: 'HOI4 徽标' },   // 游戏本体 gfx/HOI4_icon.bmp,经 /api/appicon 转 PNG
  { id: 'cog', name: '齿轮' },
  { id: 'cross', name: '铁十字' },
  { id: 'shield', name: '盾牌' },
  { id: 'star', name: '将星' },
  { id: 'globe', name: '地球' },
  { id: 'flag', name: '军旗' },
  { id: 'map', name: '地图' },
  { id: 'helmet', name: '钢盔' },
]

export function iconSvg(id, color) {
  var g = ICON_GLYPH[id] || ICON_GLYPH.cog
  var c = color || '#2b6cb0'
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="' + c + '"/>' + g +
    '</svg>'
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

export function defaultAppearance() {
  return {
    theme: 'light', accent: '', icon: 'hoi4',
    bgImage: '', iconImage: '', density: 'compact',
    /* GLASS_TUNE:壁纸半透明的三个调节量。没设时用 null 表示"跟随主题默认",
     * 由 CSS 的 --glass-a 等承担;这样切主题时透明度会跟着主题走。*/
    glassA: null, bgDim: null, bgBlur: null,
  }
}

export function loadAppearance() {
  try {
    var raw = localStorage.getItem(APPEARANCE_KEY)
    if (!raw) return defaultAppearance()
    var j = JSON.parse(raw)
    var icon = j && typeof j.icon === 'string' ? j.icon : 'hoi4'
    /* 一次性迁移:'cog' 是 2026-10-04 之前的旧默认值,存量用户并非刻意选的 ——
     * 换成 HOI4 徽标。迁移标记避免把"后来刻意选回齿轮"的用户再迁走。 */
    var migrated = j && j.iconMigrated === true
    if (!migrated && icon === 'cog') icon = 'hoi4'
    return {
      theme: j && typeof j.theme === 'string' ? j.theme : 'light',
      accent: j && typeof j.accent === 'string' ? j.accent : '',
      icon: icon,
      bgImage: j && typeof j.bgImage === 'string' ? j.bgImage : '',
      iconImage: j && typeof j.iconImage === 'string' ? j.iconImage : '',
      iconMigrated: true,
    /* UI_SLIM_V1:compact 是默认值(用户反馈"页面繁琐"),
     * 与 light 同款处理 —— 不写属性,免得每页多一个分支。 */
    density: j && j.density === 'loose' ? 'loose' : 'compact',
    /* GLASS_TUNE:只接受合法数值,脏数据当 null(回退到主题默认)。
     * 范围与 CSS 的 GLASS_RANGE 一致:玻璃 30%~75%,压暗 0~80%,模糊 0~24px。
     * 越界值会被这里夹紧 —— 直接透传会让面板变成全透明,文字全糊。*/
    glassA: numOrNull(j && j.glassA, 0.3, 0.75),
    bgDim: numOrNull(j && j.bgDim, 0, 0.8),
    bgBlur: numOrNull(j && j.bgBlur, 0, 24),
    }
  } catch (e) {
    return defaultAppearance()
  }
}

/** 数值夹紧;非有限值返回 null(表示"未设置") */
function numOrNull(v, lo, hi) {
  if (typeof v !== 'number' || !isFinite(v)) return null
  return Math.min(hi, Math.max(lo, v))
}

export function saveAppearance(a) {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a)) } catch (e) {}
  applyAppearance(a)
}

export function applyAppearance(a) {
  var s = a || loadAppearance()
  var root = document.documentElement
  // 主题:light 是默认的,不写属性(省得每页都要处理 [data-theme="light"] 分支)
  if (s.theme && s.theme !== 'light') root.setAttribute('data-theme', s.theme)
  else root.removeAttribute('data-theme')

  // 界面密度:compact / loose。变量在 theme-vars.css,只影响控件与行的松紧。
  if (s.density === 'loose') root.setAttribute('data-density', 'loose')
  else root.removeAttribute('data-density')

  var accent = s.accent || ''
  if (accent) root.style.setProperty('--accent', accent)
  else root.style.removeProperty('--accent')

  // 图标:优先本地图片;否则默认用游戏本体 HOI4_icon.bmp(/api/appicon),
  // 选了矢量预设(齿轮/铁十字…)才走 SVG。favicon 与左上角 logo 共用这一份。
  var isHoi4 = s.icon === 'hoi4'
  var iconUrl = s.iconImage || (isHoi4 ? '/api/appicon' : iconSvg(s.icon, accent || '#2b6cb0'))
  root.style.setProperty('--app-icon', 'url("' + iconUrl + '")')

  // 背景:设置了本地图片 → 注入 --bg-image 并打 data-bg="image" 标记,
  // 由 theme.css 把大部分面板切到半透明毛玻璃。否则清掉。
  if (s.bgImage) {
    root.style.setProperty('--bg-image', 'url("' + s.bgImage + '")')
    root.setAttribute('data-bg', 'image')
    /* GLASS_TUNE:玻璃透明度 / 壁纸压暗 / 壁纸模糊。
     * ⚠ 只在**有壁纸**时写这几个变量 —— 没壁纸时半透明面板会糊在
     *   body 底色上,文字对比度崩掉。没设值(null)就 removeProperty,
     *   让 CSS 里各主题的默认值继续生效(切主题时透明度跟着主题走)。*/
    setOrClear(root, '--glass-a', s.glassA)
    setOrClear(root, '--bg-dim', s.bgDim)
    setOrClear(root, '--bg-blur', s.bgBlur === null ? null : s.bgBlur + 'px')
  } else {
    root.style.removeProperty('--bg-image')
    root.removeAttribute('data-bg')
    setOrClear(root, '--glass-a', null)
    setOrClear(root, '--bg-dim', null)
    setOrClear(root, '--bg-blur', null)
  }

  // favicon:换图标最先看到的就是标签页
  var link = document.querySelector('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = s.iconImage || isHoi4 ? 'image/png' : 'image/svg+xml'
  link.href = iconUrl
  return s
}

/** null → 撤掉内联值(让 CSS 默认接管);否则写入 */
function setOrClear(root, name, value) {
  if (value === null || value === undefined) root.style.removeProperty(name)
  else root.style.setProperty(name, String(value))
}
