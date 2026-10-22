/* HOI4 界面设计器 —— VS 式所见即所得
 *
 * 四栏布局:工具箱 | 元素树 | 画布(WYSIWYG) | 属性网格。
 * 复用 /api/layout 解析、/api/tex 贴图、/api/save 几何回写,
 * 并新增 /api/gui/edit 负责 增/删/改属性(无损,带守卫)。
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined) d.textContent = txt;
    return d;
  };
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

  // orientation 取值以 vanilla 实际出现的为准(全量扫描 453 个 .gui):
  //  upper_left(1427) center(500) upper_right(470) center_up(270) lower_left(218)
  //  lower_right(152) center_down(53) center_right(45) center_left(20) left(8) center_lower(7)
  // 别写 wiki 那套 upper_center / middle_left —— 游戏文件里一次都没出现过。
  const ORIENTS = ['', 'upper_left', 'upper_right', 'lower_left', 'lower_right',
    'center', 'center_up', 'center_down', 'center_left', 'center_right', 'center_lower', 'left'];
  // Wiki 明确 CENTER_UP 可能与 CENTER_UPPER 互通、CENTER_DOWN 与 CENTER_LOWER 互通。
  // vanilla 实际只写了 center_lower(7 处),但手写 center_upper 时引擎同样认,
  // 下拉里补上别名,避免"引擎认了而设计器改不了"。
  ORIENTS.push('center_upper'); // WIKI_LAYOUT_V2

  const TOOLBOX = [
    { type: 'containerWindowType', label: '容器 Container', d: { w: 260, h: 180 } },
    { type: 'iconType', label: '图标 Icon', d: { w: 64, h: 64, spriteType: 'GFX_ability_icon_default' } },
    // 按钮不给默认贴图:vanilla 里没有真正通用的按钮贴图,硬塞一个只会立刻标红
    { type: 'buttonType', label: '按钮 Button', d: { w: 140, h: 32 } },
    { type: 'guiButtonType', label: 'GUI 按钮 GuiButton', d: { w: 140, h: 32 } },
    { type: 'instantTextBoxType', label: '文本框 TextBox', d: { w: 220, h: 26, text: '文本' } },
    { type: 'editBoxType', label: '编辑框 EditBox', d: { w: 220, h: 26 } },
    { type: 'textBoxType', label: '多行文本 TextArea', d: { w: 220, h: 80 } },
    { type: 'checkboxType', label: '复选框 Checkbox', d: { w: 28, h: 28, spriteType: 'GFX_checkbox' } },
    { type: 'listBoxType', label: '列表框 Listbox', d: { w: 220, h: 200 } },
    { type: 'smoothListBoxType', label: '平滑列表 Smooth', d: { w: 220, h: 200 } },
    { type: 'scrollbarType', label: '滚动条 Scrollbar', d: { w: 14, h: 120 } },
    { type: 'overlappingElementsBoxType', label: '重叠框 Overlap', d: { w: 120, h: 120 } },
    { type: 'dropDownBoxType', label: '下拉框 Dropdown', d: { w: 200, h: 28 } },
    { type: 'extendedScrollbarType', label: '扩展滚动条 ExtScroll', d: { w: 14, h: 120 } },
    { type: 'gridBoxType', label: '网格 Grid', d: { w: 200, h: 200 } },
    { type: 'positionType', label: '定位点 Position', d: { w: 8, h: 8 } },
  ];

  const S = {
    roots: [], files: [], sprites: [],
    root: 0, file: null,
    nodes: [], flat: [], byId: new Map(), childrenOf: new Map(),
    selected: null, pending: new Map(), zoom: 1, showTex: true, showMask: true, texUrl: new Map(), texMeta: new Map(), collapsed: new Set(),
    // ★ FIT_V2:true = 最后一次视图操作是"适应" —— 窗口/侧栏大小变化时按新尺寸重算。
    //   手动缩放(setZoom)会置 false,避免抢用户的缩放。
    fitView: false,
    // ★ LOC_TEXT:文本节点(instantTextBoxType)的 loc key → 解析后游戏文本映射。
    //   由 resolveLocs() 拉 /api/loc/text 填充;脚本式 [xxx] 与 §颜色码在 stripLoc 里清掉。
    locMap: {},
    /**
     * ★★★ INLAY_SLOT_V5:本文件是不是【国策树内嵌组件】,以及它在国策树里的真实槽位。
     *
     * 官方 documentation.md:inlay_window 的 `position` 是
     * "same syntax and scale as continuous focus position" —— 国策树坐标系,不是屏幕。
     * vanilla 的 ger_inner_circle_inlay_window 位于 {x:4500 y:1150},离屏很远。
     * 所以这类文件【不能】套 1920×1080 屏幕语义,否则整窗位置完全不对
     * (这正是用户报的"位置错误")。有值时改按槽位语义渲染。
     */
    inlay: null,
  };

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 3400);
  }

  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  // ★ LOC_TEXT:把游戏文本里的 §颜色码(§Y/§!/§W...)与脚本式占位([GetXXX]/[ROOT.GetX])清掉。
  //   脚本式文本无法求值 → 清成空串,画布上不显示,报告里说明。
  function stripLoc(s) {
    return String(s == null ? '' : s)
      .replace(/§[A-Za-z!]?/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .trim();
  }
  // 字体名(hoi_36header / hoi_20b / hoi_18mbs)→ 像素字号,取首个数字。
  function fontPx(f) {
    const m = String(f || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 14;
  }
  // 收集所有文本节点的 loc key,拉 /api/loc/text 解析,写入 S.locMap。
  async function resolveLocs() {
    const keys = new Set();
    for (const n of S.flat) {
      if (!/textboxtype|editboxtype/i.test(n.type || '')) continue;
      const k = n.text || (n.props && (n.props.text || n.props.context_aware_text)) || '';
      if (k && !/^\s*\[[^\]]*\]\s*$/.test(k)) keys.add(k); // 纯脚本式占位不拉
    }
    S.locMap = {};
    if (!keys.size) return;
    try {
      const j = await api('/api/loc/text?keys=' + encodeURIComponent([...keys].join(',')));
      for (const [k, v] of Object.entries(j.texts || {})) {
        S.locMap[k] = stripLoc(v && v.text);
      }
    } catch (e) { S.locMap = {}; }
  }

  /* ───────── 初始化 ───────── */

  async function boot() {
    const cfg = await api('/api/config');
    S.roots = cfg.roots;
    $('#rootSel').innerHTML =
      tr('<option value="-1">全部来源</option>') +
      cfg.roots
        .map((r, i) => `<option value="${i}">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)
        .join('');
    let def = 0;
    for (let i = 0; i < cfg.roots.length; i++) if (cfg.roots[i].writable) { def = i; break; }
    S.root = def;
    $('#rootSel').value = String(def);

    try { const sp = await api('/api/sprites'); S.sprites = sp.names || []; buildSpriteList(); } catch (e) {}

    $('#rootSel').onchange = () => { S.root = +$('#rootSel').value; renderFileList(); };
    $('#fileSel').onchange = () => { if (S.pending.size && !confirm('有未保存的改动,确定切换文件吗?')) { $('#fileSel').value = S.file || ''; return; } loadFile(S.root, $('#fileSel').value); };
    $('#reloadBtn').onclick = () => { if (S.file) loadFile(S.root, S.file); };
    $('#zoomIn').onclick = () => setZoom(S.zoom * 1.25);
    $('#zoomOut').onclick = () => setZoom(S.zoom / 1.25);
    $('#fitBtn').onclick = fit;
    // ★ FIT_V2:最后一次操作是"适应"时,画布区大小一变化(窗口缩放、侧栏拖拽、
    //   属性栏宽窄)就按新尺寸重算缩放与定位 —— "缩放根据窗口大小计算"不是
    //   只在点击那一刻算一次。手动缩放会清 S.fitView,不会被抢。
    try {
      const ro = new ResizeObserver(() => { if (S.fitView) fit(); });
      ro.observe($('#canvasWrap'));
    } catch (e) { /* 老浏览器没有 ResizeObserver:退化为只在点击时计算 */ }
    // ★ 开关态底色走全站统一的 button.on 类(theme.css),不再硬编码 #dbe7f5 ——
    //   那个浅蓝在深色主题下是一块刺眼的白,且切换/初始化要写两遍样式。
    $('#texBtn').onclick = (e) => { S.showTex = !S.showTex; e.target.classList.toggle('on', S.showTex); applyTextures(); };
    $('#texBtn').classList.add('on');
    // ★ 去除遮罩开关:开启(#stage.nomask)后隐去名称标注/文本/拖拽柄/参考框等叠加层,只留图形与贴图。
    //   纯视觉隐藏——选中、拖拽、右键菜单照常可用;选中态反馈由元素树(.tree-row.on)与属性网格承担。
    $('#maskBtn').onclick = () => { S.showMask = !S.showMask; applyMask(); };
    function applyMask() {
      const nomask = !S.showMask;            // true = 去除遮罩已开启
      $('#stage').classList.toggle('nomask', nomask);
      const b = $('#maskBtn');
      b.classList.toggle('on', nomask);
      b.title = nomask ? '恢复遮罩(显示标注/参考框)' : '去除遮罩(只看纯图形)';
    }
    applyMask();
    $('#previewBtn').onclick = showDiff;
    $('#discardBtn').onclick = discardAll;
    $('#saveBtn').onclick = saveAll;

    buildToolbox();
    document.addEventListener('keydown', onKey);
    $('#canvasWrap').addEventListener('mousedown', onDown);
    $('#canvasWrap').addEventListener('click', (e) => { if (!e.target.closest('.node')) select(null); });

    const f = await api('/api/files');
    S.files = f.files;
    renderFileList();
    const cand = S.files.filter((x) => x.root === S.root);
    const pick = cand.find((x) => /unitview|countryproduction|main|hud|topbar/i.test(x.name)) || cand[0];
    if (pick) loadFile(pick.root, pick.file);
  }

  function buildSpriteList() {
    let dl = document.getElementById('spriteList');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'spriteList'; document.body.appendChild(dl); }
    dl.innerHTML = S.sprites.slice(0, 4000).map((s) => `<option value="${cssEsc(s)}">`).join('');
  }

  function renderFileList() {
    const list = S.files.filter((f) => S.root < 0 || f.root === S.root);
    const sel = $('#fileSel');
    sel.innerHTML = list.map((f) => {
      const tag = (S.roots[f.root] && S.roots[f.root].writable) ? '【模组】' : '【游戏】';
      return `<option value="${cssEsc(f.file)}" data-root="${f.root}">${tag}${f.name}</option>`;
    }).join('');
    if (S.file) sel.value = S.file;
  }

  /*
   * 所见即所得操作前把入参归一化:
   *  · 选的是「全部来源」(-1)时,按当前下拉里选中的那一项解析出真实 root;
   *    否则服务端会拿到 ROOTS[-1] === undefined 而崩。
   *  · 尚未载入文件(S.file 为 null)时直接拦下 —— 否则 join(path, null)
   *    会抛 ERR_INVALID_ARG_TYPE: The "path" argument must be of type string.
   * 返回 { root, file } 或 null(已提示并return)。
   */
  function opTarget() {
    const sel = $('#fileSel');
    let root = S.root;
    if (root < 0) {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      if (!opt || !opt.dataset.root) { toast('请先在上方选择一个具体的游戏或模组目录', true); return null; }
      root = +opt.dataset.root;
    }
    const file = S.file || (sel.value || null);
    if (!file) { toast('请先在文件下拉框里选择一个 .gui 文件', true); return null; }
    if (!S.roots[root]) { toast('来源不存在,请重新选择目录', true); return null; }
    return { root, file };
  }

  function buildToolbox() {
    const box = $('#toolList');
    box.innerHTML = '';
    for (const t of TOOLBOX) {
      const b = el('button', 'tool');
      b.innerHTML = `${t.label}<small>${t.type}</small>`;
      b.onclick = () => addElement(t.type);
      box.appendChild(b);
    }
  }

  /* ───────── 载入布局 ───────── */

  async function loadFile(root, file, keepSel) {
    S.root = root; S.file = file;
    $('#rootSel').value = String(root);
    $('#fileSel').value = file || '';
    const data = await api(`/api/layout?root=${root}&file=${encodeURIComponent(file)}`);
    S.nodes = data.nodes;
    // ★★★ INLAY_SLOT_V5:内嵌组件的真实槽位(有值 = 不是屏幕窗口)
    S.inlay = data.inlay || null;
    S.flat = []; S.byId = new Map(); S.childrenOf = new Map();
    (function walk(ns, parent) {
      for (const n of ns) {
        n.parent = parent || null;
        S.flat.push(n); S.byId.set(n.id, n);
        if (parent) {
          const arr = S.childrenOf.get(parent.id) || [];
          arr.push(n); S.childrenOf.set(parent.id, arr);
        }
        walk(n.children || [], n);
      }
    })(S.nodes, null);
    S.pending.clear();
    S.selected = keepSel && S.byId.has(keepSel) ? keepSel : null;

    renderTree(); renderStage(); renderProps(); renderChanges();
    loadTextures();
    fit();
    // ★ LOC_TEXT:先按空文本渲一版,再异步拉 loc 文本、解析完重渲舞台,让游戏文字出现。
    resolveLocs().then(() => renderStage());

    const bad = (data.unresolved || []).length;
    $('#statChip').textContent = `${data.stats.elements}${tr(" 元素 · ")}${data.stats.maxDepth}${tr(" 层")}`;
    $('#statChip').className = 'chip' + (bad ? ' hot' : '');
    if (bad) $('#statChip').textContent += ` · ${bad}${tr(" 处贴图未解析")}`;
    if (S.selected) {
      const d = document.querySelector(`.node[data-id="${cssEsc(S.selected)}"]`);
      if (d) d.classList.add('sel');
    }
  }

  /* ───────── 元素树 ───────── */

  function renderTree() {
    const box = $('#tree');
    box.innerHTML = '';
    (function walk(ns, depth) {
      for (const n of ns) {
        const row = el('div', 'tree-row' + (S.selected === n.id ? ' on' : ''));
        row.style.paddingLeft = 8 + depth * 12 + 'px';
        const kids = n.children || [];
        if (kids.length) {
          const tgl = el('span', 'tgl', S.collapsed.has(n.id) ? '▶' : '▼');
          tgl.style.cssText = 'width:10px;flex:none;cursor:pointer;color:var(--ink3);font-size:9px';
          tgl.onclick = (e) => {
            e.stopPropagation();
            if (S.collapsed.has(n.id)) S.collapsed.delete(n.id); else S.collapsed.add(n.id);
            renderTree();
          };
          row.appendChild(tgl);
        } else {
          row.appendChild(el('span', 'tglsp'));
        }
        row.appendChild(el('span', 'dot' + (n.spriteMissing ? ' bad' : '')));
        const nm = el('span', 'nm', n.name);
        row.appendChild(nm);
        row.appendChild(el('span', 'ty', shortType(n.type)));
        if (n.spriteSource) row.appendChild(sourceChip(n.spriteSource));
        row.onclick = () => select(n.id);
        // ★ 数据挂元素(各页统一约定,右键/快捷键都靠它,不按文本反查)
        row.__obj = n;
        // Shift+F10 走Keys.ctxKey → 它只认元素上挂的 ctxItems
        row.ctxItems = () => nodeMenu(n);
        box.appendChild(row);
        if (!S.collapsed.has(n.id)) walk(kids, depth + 1);
      }
    })(S.nodes, 0);
  }

  function shortType(t) { return t.replace(/Type$/i, '').replace(/window/i, 'win'); }

  // F4: 贴图来源归属徽标(原版=灰 / 模组=橙 / DLC=蓝;后端字段缺失时返回空 span)
  function sourceChip(src) {
    if (!src || !src.kind) return el('span', '');
    const cls = src.kind === 'mod' ? 'chip src-mod' : src.kind === 'dlc' ? 'chip src-dlc' : 'chip src-van';
    const name = src.name ? '·' + src.name : '';
    return el('span', cls, src.kind === 'mod' ? '模组' + name : src.kind === 'dlc' ? 'DLC' : '原版');
  }

  /* ───────── 画布 ───────── */

  /**
   * ★★★ INLAY_SLOT_V5:画布语义。
   *
   * 两类根窗口的坐标系完全不同,必须分开画,否则就是"位置错误":
   *
   *  A) 屏幕窗口(占绝大多数):父容器 = 屏幕 1920×1080,orientation 决定贴屏哪一角。
   *     → 画一个 1920×1080 的虚线参考框,窗口按真实 orientation 摆进去。
   *
   *  B) 国策内嵌组件(vanilla 6 个:GER_inner_circle / CZE_industry_focus /
   *     JAP_imperial_influence / SIA_khana_ratsadon / AST 两兄弟):
   *     它【不在屏幕上】,而是被国策树摆到树坐标系里的一个部件
   *     (inlay_window.position,官方写明 "same syntax and scale as
   *     continuous focus position")。GER 那个位于 {x:4500 y:1150}。
   *     → 画布原点 = 国策树坐标原点,窗口按槽位坐标摆放,
   *       并画出槽位参考框 + 坐标标注,让"它在树的哪儿"一目了然。
   *
   * B 类若按 A 类画(1920×1080 屏幕 + 窗口贴左上),用户看到的整窗位置
   * 与游戏里完全不符 —— 上一轮报的问题就是这个。
   */
  function canvasSemantics() {
    if (S.inlay) {
      const sl = S.inlay;
      // 槽位框 = 窗口自身声明尺寸(它就是那个"部件"),画在树坐标 slot 处
      const w = (S.nodes[0] && (S.nodes[0].drawW || S.nodes[0].w)) || 600;
      const h = (S.nodes[0] && (S.nodes[0].drawH || S.nodes[0].h)) || 550;
      return {
        kind: 'inlay',
        // 画布范围:包住槽位框,四周留边以便看清
        left: sl.x - 260, top: sl.y - 160,
        w: w + 520, h: h + 320,
        slot: { x: sl.x, y: sl.y, w, h, tree: sl.tree, file: sl.file, line: sl.line },
      };
    }
    return { kind: 'screen', left: 0, top: 0, w: 1920, h: 1080, slot: null };
  }

  function renderStage() {
    const stage = $('#stage');
    stage.innerHTML = '';
    const sem = canvasSemantics();
    // ★ 内嵌组件模式:底色/提示都要与屏幕模式区分,否则用户会误以为
    //   "这个窗口贴在屏幕左上角" —— 而它在国策树的 (4500,1150) 处。
    stage.classList.toggle('inlay', sem.kind === 'inlay');
    // 画布尺寸:参考框与实际内容取并集
    let cw = sem.w, ch = sem.h;
    for (const n of S.flat) { const a = absOf(n), g = geomOf(n); cw = Math.max(cw, a.x + g.w); ch = Math.max(ch, a.y + g.h); }
    stage.style.width = Math.round(cw) + 'px';
    stage.style.height = Math.round(ch) + 'px';

    // 参考框(两类语义各画各的)
    const sc = el('div', sem.kind === 'inlay' ? 'slot' : 'screen');
    if (sem.kind === 'inlay') {
      const s = sem.slot;
      sc.style.left = s.x + 'px';
      sc.style.top = s.y + 'px';
      sc.style.width = Math.max(0, s.w) + 'px';
      sc.style.height = Math.max(0, s.h) + 'px';
      stage.appendChild(sc);
      stage.appendChild(el('div', 'slot-cap',
        tr('国策树槽位 (') + s.x + ', ' + s.y + tr(')　来自 ') + s.tree + ':' + s.line +
        '　—　inlay_window.position(国策树坐标系,非屏幕)'));
    } else {
      stage.appendChild(sc);
      stage.appendChild(el('div', 'screen-cap', '屏幕 1920 × 1080(根窗口的父级)'));
    }
    for (const n of S.nodes) stage.appendChild(buildDom(n));
    if (S.selected) {
      const d = document.querySelector(`.node[data-id="${cssEsc(S.selected)}"]`);
      if (d) d.classList.add('sel');
    }
  }

  function buildDom(n) {
    const d = el('div', 'node');
    d.dataset.id = n.id;
    // ★ 同renderTree:画布节点也挂 __obj,右键才能取到完整节点数据
    d.__obj = n;
    if (n.spriteMissing || n.sizeUnknown) d.classList.add('bad');
    const g = geomOf(n);
    d.style.left = g.x + 'px';
    d.style.top = g.y + 'px';
    d.style.width = Math.max(0, g.w) + 'px';
    d.style.height = visualH(n, g) + 'px';
    if (n.name && n.name !== '(匿名)') d.appendChild(el('div', 'cap', n.name + (n.spriteMissing ? ' ⚠' : '')));
    const txt = n.text || n.props.text || n.buttonText || n.props.buttonText || '';
    if (txt) d.appendChild(el('div', 'txt', txt));
    // ★ LOC_TEXT:游戏文本层(.gametext)。区别于上面的 .txt(显示 loc key 的标注):
    //   .gametext 显示解析后的真实文本,且 #stage.nomask 下【不隐藏】(游戏文本是 UI 本体,不是标注)。
    //   定位:节点 div 已在 left=offX/top=offY;.gametext 从 (0,0) 起,宽=maxWidth,
    //   format=center → 文本在 maxWidth 内居中(中心=offX+maxWidth/2)。字号取 font 名数字。
    if (/textboxtype|editboxtype/i.test(n.type || '')) {
      const key = n.text || (n.props && (n.props.text || n.props.context_aware_text)) || '';
      const disp = (S.locMap && S.locMap[key]) || '';
      if (disp) {
        const gt = el('div', 'gametext', disp);
        const mw = parseFloat((n.props && n.props.maxWidth)) || n.drawW || 0;
        gt.style.width = Math.max(0, mw) + 'px';
        gt.style.fontSize = fontPx(n.props && n.props.font) + 'px';
        if (/center/i.test((n.props && n.props.format) || '')) { gt.style.textAlign = 'center'; gt.style.left = -(n.offX || 0) + 'px'; }
        d.appendChild(gt);
      }
    }
    d.appendChild(el('div', 'h'));
    // ★ BG_LAYERS_V1:附加 background 层(带 position 的聚光灯等)。
    //   与子元素同一坐标系(已扣 margin),衬在子元素之下(z-index:0)、容器底色之上。
    const layers = (n.bgLayers || []).map(buildBgLayer);
    // ★ MARGIN_WRAP_MU:后端 offX 是相对「绘制尺寸扣 margin」的缩减框算的,本身不含 margin 平移;
    //   MU 用 containerwindowChildren div 把子元素整体平移到 (margin.left, margin.top),这里等价实现。
    const mg = n.margin;
    if (mg && (mg.left || mg.top || mg.right || mg.bottom)) {
      const wrap = el('div', 'node-margin');
      wrap.style.left = (mg.left || 0) + 'px';
      wrap.style.top = (mg.top || 0) + 'px';
      for (const ld of layers) wrap.appendChild(ld);
      for (const c of n.children || []) wrap.appendChild(buildDom(c));
      d.appendChild(wrap);
    } else {
      for (const ld of layers) d.appendChild(ld);
      for (const c of n.children || []) d.appendChild(buildDom(c));
    }
    return d;
  }

  /** ★ BG_LAYERS_V1:附加背景层 div —— 位置/尺寸用模型算好的 offX/offY/drawW/drawH */
  function buildBgLayer(L) {
    const ld = el('div', 'bglayer');
    ld.style.left = (L.offX || 0) + 'px';
    ld.style.top = (L.offY || 0) + 'px';
    ld.style.width = Math.max(0, L.drawW || 0) + 'px';
    ld.style.height = Math.max(0, L.drawH || 0) + 'px';
    ld.style.zIndex = '0';
    // ⚠ dataset.texId 会映射成 data-tex-id 属性,与选择器 .bglayer[data-texid] 不匹配
    //   (踩过:层几何全对但贴图永不应用)—— 统一用小写键 data-texid
    if (L.texId) ld.dataset.texid = L.texId;
    return ld;
  }

  /**
   * ★ TEXT_BOX_H_V1:instantTextBoxType 不写 size 时布局模型给 h=0(扩展预览也如此),
   *   节点框退化成 2px 细线 —— 点不中、拖不动、看起来"元素丢了"。
   *   游戏里文本框按字号自适应行高,这里给一个【纯视觉】的最小高度(字号×1.3),
   *   只影响节点 div 的盒模型,不写回布局引擎(避免动摇已验证的坐标体系)。
   */
  function visualH(n, g) {
    let h = Math.max(0, g.h);
    if (/textboxtype|editboxtype/i.test(n.type || '') && h < 6) {
      h = Math.max(h, Math.round(fontPx(n.props && n.props.font) * 1.3));
    }
    return h;
  }

  /**
   * 几何分两套,别混:
   *  - rawOf :文件里写的原始 x/y —— 属性网格显示与保存用它
   *  - geomOf:画布渲染用的"相对父级像素偏移"
   *    偏移 = offX(引擎按锚点算的基准) + (原始 x 的改动量)
   *    直接用 relX 渲染会漏掉 orientation 锚点 / origo / centerposition,
   *    表现就是"看不出相对位置关系"。拖拽 delta 在两套坐标下 1:1,故保存仍写原始值。
   */
  function rawOf(n) {
    const v = S.pending.get(n.id) || {};
    return {
      x: v.x !== undefined ? v.x : n.x,
      y: v.y !== undefined ? v.y : n.y,
      w: v.w !== undefined ? v.w : n.drawW,
      h: v.h !== undefined ? v.h : n.drawH,
    };
  }

  function geomOf(n) {
    const r = rawOf(n);
    const bx = n.offX !== undefined ? n.offX : n.x;
    const by = n.offY !== undefined ? n.offY : n.y;
    let x = bx + (r.x - n.x);
    let y = by + (r.y - n.y);
    // ★ INLAY_SLOT_V5:内嵌根窗口的父级是国策树槽位原点,不是屏幕 (0,0)。
    //   渲染必须平移到槽位,否则根窗口画在 (0,0) 而槽位在几千像素外,窗口与槽位永不嵌合。
    //   子元素相对根继续用 offX/offY(嵌套在根 div 内),由根的平移整体带入。
    const sl = S.inlay;
    if (sl && !n.parent) {
      // ★ INLAY_SLOT_V6:内嵌窗口以 orientation 锚定槽位。
      //   lower_left(vanilla 6 组件统一) → 窗口【左下角】贴槽位锚点 (sl.x, sl.y),
      //   即窗口顶在 sl.y - 窗口高。上一版把左上角放槽位,整窗偏低了窗口高度。
      //   center 则居中(左上角在 sl - draw/2)。按实际 orientation 求左上角。
      const ori = n.orientation || 'upper_left';
      const dw = r.w || n.drawW || 0;
      const dh = r.h || n.drawH || 0;
      let lx = 0, ly = 0;
      if (ori.includes('right')) lx = -dw; else if (ori.startsWith('center')) lx = -dw / 2;
      if (ori.includes('lower')) ly = -dh; else if (ori.startsWith('center')) ly = -dh / 2;
      x += sl.x + lx;
      y += sl.y + ly;
    }
    return { x, y, w: r.w, h: r.h };
  }

  /** 父级在画布上的尺寸(用于解释锚点落到哪) */
  function parentSizeOf(n) {
    const p = n.parent ? S.byId.get(n.parent.id) : null;
    // ★ 根级:屏幕窗口的父级是 1920×1080;内嵌组件的父级是【自身声明尺寸】
    //   (它在国策树槽位里,没有"屏幕"这一层)。
    if (!p) {
      if (S.inlay) {
        const r = S.nodes[0] || n;
        return { w: r.drawW || r.w, h: r.drawH || r.h };
      }
      return { w: 1920, h: 1080 };
    }
    const g = geomOf(p);
    return { w: g.w, h: g.h };
  }

  const ORIENT_DESC = {
    upper_left: '父级左上角', upper_right: '父级右上角',
    lower_left: '父级左下角', lower_right: '父级右下角',
    center: '父级中心', center_up: '父级上边中点', center_down: '父级下边中点',
    center_left: '父级左边中点', center_right: '父级右边中点',
    center_lower: '父级下边中点', left: '父级左边中点',
  };

  function place(d, n) { const g = geomOf(n); d.style.left = g.x + 'px'; d.style.top = g.y + 'px'; d.style.width = Math.max(0, g.w) + 'px'; d.style.height = visualH(n, g) + 'px'; }

  /**
   * 元素的画布绝对坐标。
   *
   * ★★★ INLAY_SLOT_V5:引擎算出的 absX/absY 是【槽位内局部坐标】
   *   (inlay 组件的父容器是自身声明尺寸,不是屏幕),所以要加上槽位原点
   *   才是国策树里的真实位置。普通屏幕窗口的槽位是 (0,0),加不加一样。
   */
  function absOf(n) {
    let x = 0, y = 0, c = n;
    while (c) { const g = geomOf(c); x += g.x; y += g.y; c = c.parent; }
    // geomOf 已对 inlay 根窗口平移槽位,这里不再重复加。
    return { x, y };
  }

  function setZoom(z) {
    S.zoom = Math.min(8, Math.max(0.1, z));
    const st = $('#stage');
    st.style.transform = `scale(${S.zoom})`;
    // ★ FIT_V2:手动缩放要清掉"适应"留下的居中 margin(那是按上一次适应的缩放
    //   算的,留着会把内容推偏),同时取消"跟随窗口重算"。fit() 在 setZoom
    //   之后会自己重设这两项。
    st.style.marginLeft = '';
    st.style.marginRight = '';
    st.style.marginTop = '';
    st.style.marginBottom = '';
    S.fitView = false;
    $('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  }

  /**
   * 适应窗口:缩放按【当前窗口大小】算,并把内容送到视野正中。
   *
   * ★★ 旧算法三处不合理(用户报"适应按钮应该调整"):
   *   1) 缩放分母用"从画布原点到内容的最大跨度" —— 内嵌组件在国策树
   *      (4500,1150) 处,跨度 ~5100×1700,于是 600×550 的组件被缩到 0.2,
   *      窗口里只剩一个点。应按【内容包围盒】(min/max)算,不是跨度。
   *   2) 上限写死 2 —— 大窗口里 1920 屏幕最多 2 倍,铺不满窗口。
   *   3) 定位 `scrollLeft = slot.x - 60` 喂的是画布坐标,而 scrollLeft 是
   *      屏幕像素(没乘缩放)→ 滚到几千像素外的空白区;屏幕模式更是不复位,
   *      用户之前停在哪儿,适应后还停在哪儿。
   * 现在:包围盒 → 按 wrap 的 clientWidth/Height 求缩放 → 内容居中
   * (比窗口小:用 margin 推到可视区正中;比窗口大:用 scroll 把包围盒中心
   *  对准窗口中心)。负坐标内容(摆到画布原点外)额外把舞台推移 |x0|·z,
   *  否则那部分元素在滚动容器里永远够不着。
   */
  function fit() {
    const wrap = $('#canvasWrap');
    const stage = $('#stage');
    const sem = canvasSemantics();
    // 内容包围盒(画布坐标):所有节点 + 参考框取并集。
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y, w, h) => {
      x = +x; y = +y; w = +w || 0; h = +h || 0;
      if (!isFinite(x) || !isFinite(y)) return;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    };
    for (const n of S.flat) { const a = absOf(n); const g = geomOf(n); add(a.x, a.y, g.w, g.h); }
    // 屏幕模式:整块 1920×1080 必须在视野内;内嵌模式:槽位框就是内容本体。
    if (sem.kind === 'screen') add(0, 0, 1920, 1080);
    else { const s = sem.slot; add(s.x, s.y, s.w, s.h); }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = sem.w; y1 = sem.h; }
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    // 缩放:按可视窗口大小算,四周留 24px 余量;上限放到 4(小组件在大窗口里也允许铺满)
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    const availW = Math.max(120, vw - 24);
    const availH = Math.max(120, vh - 24);
    const z = Math.min(4, Math.max(0.1, Math.min(availW / cw, availH / ch)));
    setZoom(z);
    // 定位:把内容包围盒【居中】放到可视窗口。两个手段配合:
    //  ① margin —— 内容比窗口小时,四周补等宽空白把内容推到正中(贴左上角会剩
    //     一大片空白,不像"适应");右侧/下侧的 margin 同时补出滚动余量,
    //     否则内容挨着滚动区末端时"居中"永远差一截、够不着。
    //  ② scroll —— 比窗口大(或画布比内容宽,如内嵌组件的树坐标空间)时,
    //     把包围盒中心对准窗口中心。scrollLeft/Top 是屏幕像素,画布坐标必须先乘缩放。
    const padX = Math.max(0, Math.round((vw - cw * z) / 2));
    const padY = Math.max(0, Math.round((vh - ch * z) / 2));
    // ★ 负坐标内容(元素被摆到画布原点之外:屏幕外/父级边缘外)在滚动容器里
    //   本来就【永远够不着】—— 滚动起点就是画布原点,往左/上滚不动。把舞台
    //   整体向右/下推 |x0|·z / |y0|·z(屏幕像素),负坐标内容才进得了可视区,
    //   后面的"居中"也才算得准(否则中心被原点外的部分拽偏)。
    const shiftX = Math.round(Math.max(0, -x0) * z);
    const shiftY = Math.round(Math.max(0, -y0) * z);
    stage.style.marginLeft = (padX + shiftX) + 'px';
    stage.style.marginRight = padX + 'px';
    stage.style.marginTop = (padY + shiftY) + 'px';
    stage.style.marginBottom = padY + 'px';
    // 读一次 scrollWidth 强制按新缩放+新 margin 刷新布局,否则滚动范围还是旧值。
    void wrap.scrollWidth;
    const maxX = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const maxY = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.scrollLeft = Math.min(maxX, Math.max(0, Math.round((padX + shiftX) + (x0 + cw / 2) * z - wrap.clientWidth / 2)));
    wrap.scrollTop = Math.min(maxY, Math.max(0, Math.round((padY + shiftY) + (y0 + ch / 2) * z - wrap.clientHeight / 2)));
    S.fitView = true;
  }

  /* ───────── 贴图 ───────── */

  function texKey(id, frame) { return id + (frame > 0 ? '#f' + frame : ''); }
  async function loadTextures() {
    const keys = new Set();
    for (const n of S.flat) {
      const fr = parseInt(n.props && n.props.frame, 10) || 0;
      if (n.texId) keys.add(texKey(n.texId, fr));
      if (n.bgTexId) keys.add(texKey(n.bgTexId, fr));
      // ★ BG_LAYERS_V1:附加背景层也要拉贴图(无 frame 概念,直接用 texId)
      for (const L of n.bgLayers || []) if (L.texId) keys.add(L.texId);
    }
    const todo = [...keys].filter((k) => !S.texUrl.has(k));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const k = todo[i++];
        try {
          const hash = k.indexOf('#f');
          const id = hash < 0 ? k : k.slice(0, hash);
          const fr = hash < 0 ? 0 : parseInt(k.slice(hash + 2), 10) || 0;
          const r = await api('/api/tex?id=' + encodeURIComponent(id) + (fr > 0 ? '&frame=' + fr : ''));
          if (r.png) S.texUrl.set(k, 'data:image/png;base64,' + r.png);
          // F5: 缓存贴图元信息(borderSize / tilingCenter / spriteType / 来源),供九宫格与徽标使用
          if (r.borderSize || r.tilingCenter !== undefined || r.spriteType) {
            S.texMeta.set(k, { borderSize: r.borderSize, tilingCenter: r.tilingCenter, spriteType: r.spriteType, sourceRoot: r.sourceRoot, sourceKind: r.sourceKind });
          }
        } catch (e) {}
      }
      applyTextures();
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    applyTextures();
  }

  function applyTextures() {
    for (const n of S.flat) {
      const d = document.querySelector(`.node[data-id="${cssEsc(n.id)}"]`);
      if (!d) continue;
      const oldBg9 = d.querySelector('.bg9'); if (oldBg9) oldBg9.remove();
      d.style.backgroundImage = ''; d.style.backgroundSize = '';
      if (S.showTex) {
        const fr = parseInt(n.props && n.props.frame, 10) || 0;
        const bgKey = n.bgTexId ? texKey(n.bgTexId, fr) : null;
        const fgKey = n.texId ? texKey(n.texId, fr) : null;
        const bgMeta = bgKey ? S.texMeta.get(bgKey) : null;
        const bgUrl = bgKey ? S.texUrl.get(bgKey) : null;
        // F5: corneredTile 九宫格(背景图 meta 含 borderSize 时用 .bg9 做 border-image 9-slice)
        if (bgUrl && bgMeta && bgMeta.borderSize && bgMeta.borderSize.x) {
          const bs = bgMeta.borderSize;
          const bg9 = el('div', 'bg9');
          bg9.style.borderImageSource = `url("${bgUrl}")`;
          bg9.style.borderImageSlice = `${bs.y} ${bs.x} fill`;
          bg9.style.borderImageWidth = `${bs.y}px ${bs.x}px`;
          bg9.style.borderImageRepeat = 'stretch';
          bg9.style.borderStyle = 'solid';
          bg9.style.borderWidth = `${bs.y}px ${bs.x}px`;
          d.insertBefore(bg9, d.firstChild);
          d.style.backgroundImage = '';
        } else {
          const u = bgUrl || (fgKey ? S.texUrl.get(fgKey) : null);
          if (u) { d.style.backgroundImage = `url(${u})`; d.style.backgroundSize = '100% 100%'; }
        }
      }
      // ★ BG_LAYERS_V1:附加背景层贴图(聚光灯/边框底等)。
      //   ⚠ 读写必须同一个小写键:dataset.texId ↔ data-tex-id,dataset.texid ↔ data-texid,
      //     混用会让选择器命中而取值拿到 undefined(贴图静默不应用)。
      //   层是【撑满容器】的(与第一个 background 一致):corneredTile 类贴图
      //   (meta.borderSize)走 border-image 九宫格,其余直接拉伸 100% 100%。
      for (const ld of d.querySelectorAll('.bglayer[data-texid]')) {
        const key = ld.dataset.texid;
        const u = S.texUrl.get(key);
        const meta = S.texMeta.get(key);
        ld.style.backgroundImage = '';
        const old9 = ld.querySelector('.bg9'); if (old9) old9.remove();
        if (S.showTex && u) {
          if (meta && meta.borderSize && meta.borderSize.x) {
            const bs = meta.borderSize;
            const bg9 = el('div', 'bg9');
            bg9.style.borderImageSource = `url("${u}")`;
            bg9.style.borderImageSlice = `${bs.y} ${bs.x} fill`;
            bg9.style.borderImageWidth = `${bs.y}px ${bs.x}px`;
            bg9.style.borderImageRepeat = 'stretch';
            bg9.style.borderStyle = 'solid';
            bg9.style.borderWidth = `${bs.y}px ${bs.x}px`;
            ld.appendChild(bg9);
          } else {
            ld.style.backgroundImage = `url(${u})`;
            ld.style.backgroundSize = '100% 100%';
          }
        }
      }
    }
  }

  /* ───────── 选择 / 属性网格 ───────── */

  function select(id) {
    S.selected = id;
    document.querySelectorAll('.node.sel').forEach((d) => d.classList.remove('sel'));
    renderTree();
    if (id) {
      const d = document.querySelector(`.node[data-id="${cssEsc(id)}"]`);
      if (d) d.classList.add('sel');
    }
    renderProps();
  }

  function renderProps() {
    const box = $('#props');
    const n = S.selected ? S.byId.get(S.selected) : null;
    if (!n) { box.innerHTML = '<div class="empty">在画布或元素树中选择一个元素<br>或用左侧工具箱新增元素</div>'; return; }
    const off = geomOf(n);
    box.innerHTML = '';
    box.appendChild(propRow('类型', txt(shortType(n.type))));
    const nm = inp('text', n.name); nm.onchange = () => setProp('name', nm.value.trim());
    box.appendChild(propRow('名称 name', nm));
    box.appendChild(propRow('行号', txt(String(n.line))));

    const r = rawOf(n);
    box.appendChild(group('位置(文件原始值)'));
    box.appendChild(geomRow('x', r.x, 'x'));
    box.appendChild(geomRow('y', r.y, 'y'));
    const ps = parentSizeOf(n);
    box.appendChild(propRow('画布偏移', txt(`${Math.round(off.x)}, ${Math.round(off.y)}${tr("  ← 父级 ")}${Math.round(ps.w)}×${Math.round(ps.h)}`)));
    box.appendChild(group('尺寸'));
    box.appendChild(geomRow('width', Math.round(off.w), 'w'));
    box.appendChild(geomRow('height', Math.round(off.h), 'h'));

    box.appendChild(group('外观 / 文本'));
    box.appendChild(propInput('spriteType', '贴图 spriteType', n.sprite || '', true));
    box.appendChild(propInput('quadTextureSprite', '动态贴图 quad', n.props.quadTextureSprite || '', true));
    box.appendChild(propInput('text', '文本 text', n.props.text || '', false));
    box.appendChild(propInput('buttonText', '按钮文字 buttonText', n.props.buttonText || '', false));
    const or = sel(ORIENTS, n.orientation || ''); or.onchange = () => setProp('orientation', or.value);
    box.appendChild(propRow('锚点 orientation', or));
    const og = sel(ORIENTS, n.origo || ''); og.onchange = () => setProp('origo', og.value);
    box.appendChild(propRow('自身对齐点 origo', og));
    box.appendChild(propSel('centerposition', n.centerPosition ? 'yes' : '', ['', 'yes', 'no']));
    const sc = inp('number', parseFloat(n.props.scale) || 1); sc.onchange = () => setProp('scale', String(parseFloat(sc.value) || 1));
    box.appendChild(propRow('缩放 scale', sc));
    // Wiki:clipping 默认 true —— 面板要能区分"没写(=默认裁剪)"与"显式 no"。
    // 注意 propSel() 自身已返回 propRow,不能再套一层,否则行会嵌行。
    const clipRaw = n.props.clipping || n.props.Clipping || '';
    const clipCtl = sel(['', 'yes', 'no'], clipRaw);
    clipCtl.onchange = () => setProp('clipping', clipCtl.value);
    box.appendChild(propRow(clipRaw ? '裁剪 clipping' : '裁剪 clipping(缺省=默认 yes)', clipCtl));
    box.appendChild(propSel('moveable', n.props.moveable || '', ['', 'yes', 'no']));
    box.appendChild(group('Wiki 容器属性'));
    box.appendChild(propInput('spacing', '间距 spacing', n.props.spacing || '', false));
    box.appendChild(propSel('horizontal', n.props.horizontal || '', ['', 'yes', 'no']));
    box.appendChild(propSel('fixedsize', n.props.fixedsize || '', ['', 'yes', 'no']));
    box.appendChild(propSel('fullScreen', n.props.fullScreen || '', ['', 'yes', 'no']));

    // 文本类高频属性(vanilla 频次:font 3988 / format 3837 / maxWidth 3524 / maxHeight 3006),
    // 原先属性网格一个都没有,改这些只能手工开文件
    box.appendChild(group('文本'));
    box.appendChild(propInput('font', '字体 font', n.props.font || '', false));
    // Wiki:format 有效值只有 left / center / right。用下拉而非自由输入,
    // 免得写进 center_middle 这类引擎不认的值,游戏里静默按默认左对齐。
    const fmt = sel(['left', 'center', 'right'], (n.props.format || 'left').toLowerCase());
    fmt.onchange = () => setProp('format', fmt.value);
    box.appendChild(propRow('格式 format', fmt));
    box.appendChild(propInput('maxWidth', '最大宽 maxWidth', n.props.maxWidth || '', false));
    box.appendChild(propInput('maxHeight', '最大高 maxHeight', n.props.maxHeight || '', false));

    box.appendChild(group('外观 / 行为'));
    box.appendChild(propSel('alwaystransparent', n.props.alwaystransparent || '', ['', 'yes', 'no']));
    box.appendChild(propSel('hide', n.props.hide || '', ['', 'yes', 'no']));
    box.appendChild(propInput('clicksound', '点击音 clicksound', n.props.clicksound || '', false));
    box.appendChild(propInput('frame', '帧 frame', n.props.frame || '', false));
    box.appendChild(propInput('pdx_tooltip', '提示 pdx_tooltip', n.props.pdx_tooltip || '', false));

    // 块形态属性:真实语法里 borderSize / margin / slotSize 都写在子块内,
    // 必须走点号路径(borderSize.x)才改得到
    const pb = n.propBlocks || {};
    const blk = (title, key, fields, useList) => {
      // 块名大小写不敏感查找(vanilla verticalscrollbar / verticalScrollbar 并存)
      let inner = pb[key] || pb[key.toLowerCase()];
      if (!inner) for (const k of Object.keys(pb)) { if (k.toLowerCase() === key.toLowerCase()) { inner = pb[k]; break; } }
      if (!inner) return;
      box.appendChild(group(title + ' (' + key + ')'));
      for (const f of fields) {
        if (!(f in inner)) continue;
        const i = inp('text', inner[f]);
        if (useList) i.setAttribute('list', 'spriteList');
        i.onchange = () => setProp(key + '.' + f, i.value.trim());
        box.appendChild(propRow(f, i));
      }
    };
    blk('边框', 'borderSize', ['x', 'y']);
    blk('外边距', 'margin', ['left', 'right', 'top', 'bottom']);
    blk('格位尺寸', 'slotSize', ['width', 'height']);
    blk('瓦片尺寸', 'tileSize', ['width', 'height']);

    // F2: 容器/滚动条专属功能组(按类型条件渲染,不污染其它元素面板)
    const ntype = (n.type || '').toLowerCase();
    const isContainer = ntype === 'containerwindowtype' || ntype === 'windowtype';
    const isScrollbar = ntype === 'scrollbartype' || ntype === 'extendedscrollbartype';
    if (isContainer) {
      blk('背景 background', 'background', ['spriteType', 'quadTextureSprite'], true);
      box.appendChild(group('容器滚动 scroll'));
      box.appendChild(propSel('autohide_scrollbars', n.props.autohide_scrollbars || '', ['', 'yes', 'no']));
      box.appendChild(propInput('scroll_wheel_factor', '滚轮因子 scroll_wheel_factor', n.props.scroll_wheel_factor || '', false));
      box.appendChild(propSel('smooth_scrolling', n.props.smooth_scrolling || '', ['', 'yes', 'no']));
      blk('垂直滚动条 verticalscrollbar', 'verticalscrollbar', ['spriteType']);
      blk('水平滚动条 horizontalscrollbar', 'horizontalscrollbar', ['spriteType']);
      blk('拖拽滚动音 drag_scroll', 'drag_scroll', ['left', 'middle', 'right']);
      box.appendChild(group('容器动画 animation'));
      blk('显示位置 show_position', 'show_position', ['x', 'y']);
      blk('隐藏位置 hide_position', 'hide_position', ['x', 'y']);
      box.appendChild(propInput('show_animation_type', '显示动画类型', n.props.show_animation_type || '', false));
      box.appendChild(propInput('hide_animation_type', '隐藏动画类型', n.props.hide_animation_type || '', false));
      box.appendChild(propInput('animation_type', '动画类型 animation_type', n.props.animation_type || '', false));
      box.appendChild(propInput('animation_time', '动画时长 animation_time', n.props.animation_time || '', false));
      box.appendChild(propInput('show_sound', '显示音效 show_sound', n.props.show_sound || '', false));
      box.appendChild(propInput('hide_sound', '隐藏音效 hide_sound', n.props.hide_sound || '', false));
      box.appendChild(propInput('fade_time', '渐变时长 fade_time', n.props.fade_time || '', false));
      box.appendChild(propInput('fade_type', '渐变类型 fade_type', n.props.fade_type || '', false));
    }
    if (isScrollbar) {
      box.appendChild(group('滚动条部件 parts'));
      blk('滑块 slider', 'slider', ['spriteType'], true);
      blk('滑轨 track', 'track', ['spriteType'], true);
      blk('左/上增量 leftbutton', 'leftbutton', ['spriteType'], true);
      blk('右/下增量 rightbutton', 'rightbutton', ['spriteType'], true);
      box.appendChild(group('滚动条取值 range'));
      box.appendChild(propInput('maxValue', '最大值 maxValue', n.props.maxValue || '', false));
      box.appendChild(propInput('minValue', '最小值 minValue', n.props.minValue || '', false));
      box.appendChild(propInput('stepSize', '步进 stepSize', n.props.stepSize || '', false));
      box.appendChild(propInput('startValue', '起始值 startValue', n.props.startValue || '', false));
      box.appendChild(propInput('priority', '优先级 priority', n.props.priority || '', false));
    }
    // F2: 跨类型高频交互/提示字段
    const isBtnLike = /buttontype|guibuttontype|checkboxtype/.test(ntype);
    const isTextField = /textboxtype|instanttextboxtype|editboxtype/.test(ntype);
    const isListField = /listboxtype|smoothlistboxtype|dropdownboxtype/.test(ntype);
    if (isBtnLike || isTextField || isListField) {
      box.appendChild(group('交互 / 提示扩展'));
      if (isBtnLike) {
        box.appendChild(propInput('buttonFont', '按钮字体 buttonFont', n.props.buttonFont || '', false));
        box.appendChild(propInput('shortcut', '快捷键 shortcut', n.props.shortcut || '', false));
        box.appendChild(propInput('oversound', '悬停音 oversound', n.props.oversound || '', false));
        box.appendChild(propInput('web_link', '链接 web_link', n.props.web_link || '', false));
      }
      box.appendChild(propInput('hint_tag', '提示键 hint_tag', n.props.hint_tag || '', false));
      box.appendChild(propInput('pdx_tooltip_delayed', '延迟提示 pdx_tooltip_delayed', n.props.pdx_tooltip_delayed || '', false));
      if (isTextField || isListField) {
        const sbKey = n.props.scrollbarType ? 'scrollbarType' : (n.props.scrollbartype ? 'scrollbartype' : 'scrollbarType');
        box.appendChild(propInput(sbKey, '滚动条 scrollbarType', n.props.scrollbarType || n.props.scrollbartype || '', false));
      }
      if (ntype === 'editboxtype') {
        box.appendChild(propSel('ignore_tab_navigation', n.props.ignore_tab_navigation || '', ['', 'yes', 'no']));
      }
    }

    const flags = el('div');
    if (n.spriteSource) flags.appendChild(sourceChip(n.spriteSource));
    if (n.bgSpriteSource) flags.appendChild(sourceChip(n.bgSpriteSource));
    if (n.spriteMissing) flags.appendChild(el('span', 'flag err', tr('⚠ sprite 未定义:') + n.sprite));
    if (n.sizePct) flags.appendChild(el('span', 'flag', '· 尺寸是百分比(相对父级),已折算为像素显示;改成固定值会丢失自适应'));
    if (n.sizeAuto) flags.appendChild(el('span', 'flag', '· 尺寸写 0 由内容自适应,此处为子元素包围盒估算'));
    if (n.varRefs > 0) flags.appendChild(el('span', 'flag', tr('· 有 ') + n.varRefs + tr(' 个几何值引用 @var,直接改数字不会生效,需改变量定义')));
    if (n.bgSprite) flags.appendChild(el('span', 'flag', tr('· background 贴图: ') + n.bgSprite));
    if (n.sizeUnknown) flags.appendChild(el('span', 'flag err', '⚠ 尺寸未知:无贴图可推断'));
    else if (n.sizeInferred) flags.appendChild(el('span', 'flag', '· 尺寸由贴图推断'));
    if (n.posMissing) flags.appendChild(el('span', 'flag', '· 文件无 position,按 (0,0)'));
    if (n.orientation) {
      const d = ORIENT_DESC[String(n.orientation).toLowerCase()];
      flags.appendChild(el('span', 'flag', `${tr("· 锚点 ")}${n.orientation}${d ? '(' + d + ')' : ''}${tr(":position 是相对该点的偏移,不是父级左上角")}`));
    } else if (n.effectiveOrientation) {
      const p = n.parent ? S.byId.get(n.parent.id) : null;
      const d = ORIENT_DESC[String(n.effectiveOrientation).toLowerCase()];
      flags.appendChild(el('span', 'flag', `${tr("· 锚点 ")}${n.effectiveOrientation}${d ? '(' + d + ')' : ''}${tr(" —— 继承自父级")}${p ? ' ' + p.name : ''}${tr("(wiki:元素默认继承所在容器的 orientation)")}`));
    }
    if (n.origo) flags.appendChild(el('span', 'flag', `${tr("· 自身对齐点 origo = ")}${n.origo}${tr(":渲染时扣掉元素自身的对应点")}`));
    if (n.centerPosition) flags.appendChild(el('span', 'flag', '· centerposition = yes:position 指向元素中心'));
    if (n.posPct) flags.appendChild(el('span', 'flag', '· position 写成百分比,已按父级折算'));
    if (flags.children.length) box.appendChild(flags);

    const btns = el('div'); btns.style.cssText = 'display:flex;gap:6px;padding:10px';
    const bp = el('button', '', '选中父级'); bp.disabled = !n.parent; bp.onclick = () => select(n.parentId);
    const br = el('button', '', '撤销此元素'); br.onclick = () => { S.pending.delete(n.id); refreshNode(n); renderChanges(); renderProps(); };
    const bd = el('button', 'danger', '删除元素'); bd.onclick = deleteElement;
    btns.appendChild(bp); btns.appendChild(br); btns.appendChild(bd);
    box.appendChild(btns);

    box.appendChild(el('div', 'prop note', '提示:几何(x/y/宽/高)走"保存"回写;其余属性即时写入文件。'));
  }

  function txt(v) { const d = el('div'); d.textContent = v; d.style.fontSize = '12px'; return d; }
  function inp(type, val) { const i = document.createElement('input'); i.type = type; i.value = val; return i; }
  function sel(opts, val) { const s = document.createElement('select'); s.innerHTML = opts.map((o) => `<option value="${cssEsc(o)}"${o === val ? ' selected' : ''}>${o || '(无)'}</option>`).join(''); return s; }
  function propRow(label, control) { const d = el('div', 'prop'); d.appendChild(el('label', '', label)); d.appendChild(control); return d; }
  function group(title) { const d = el('div', 'prop group'); d.textContent = title; return d; }
  function geomRow(label, val, field) {
    const i = inp('number', val); i.onchange = () => { const num = parseFloat(i.value); if (!isFinite(num)) return; setField(S.selected, field, Math.round(num)); renderProps(); };
    return propRow(label, i);
  }
  function propInput(key, label, val, useList) {
    const i = inp('text', val); if (useList) i.setAttribute('list', 'spriteList');
    i.onchange = () => setProp(key, i.value.trim());
    return propRow(label, i);
  }
  function propSel(key, val, opts) { const s = sel(opts, val); s.onchange = () => setProp(key, s.value); return propRow(key, s); }

  /* ───────── 增 / 删 / 改属性 ───────── */

  async function setProp(key, value) {
    if (!S.selected) return;
    if (S.pending.size) await saveGeometry(); // 先把拖拽/缩放落盘,避免丢失
    await guiEdit({ kind: 'set', id: S.selected, key, value });
  }

  async function addElement(type) {
    const parentId = S.selected ? S.selected : null;
    const def = TOOLBOX.find((t) => t.type === type);
    const base = (def && def.label.split(' ')[0]) || type;
    const name = uniqueName('new_' + base);
    const d = (def && def.d) || {};
    const op = { kind: 'add', parentId, type, name, x: 20, y: 20 };
    if (d.w !== undefined) op.w = d.w;
    if (d.h !== undefined) op.h = d.h;
    if (d.spriteType) op.spriteType = d.spriteType;
    if (d.text) op.text = d.text;
    if (type === 'iconType' || type === 'buttonType' || type === 'checkboxType') op.orientation = 'upper_left';
    await guiEdit(op);
  }

  async function deleteElement() {
    if (!S.selected) return;
    if (!confirm('确定删除该元素及其全部子元素?')) return;
    await guiEdit({ kind: 'del', id: S.selected });
  }

  async function guiEdit(op) {
    const t = opTarget();
    if (!t) return false;
    try {
      const r = await api('/api/gui/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: t.root, file: t.file, op }),
      });
      if (r.guard && !r.guard.ok) { if (r.diff) showDiffBox(r.diff); toast(tr('守卫失败:') + r.guard.message, true); return false; }
      if (!r.written) { toast('未写入(只读或守卫拦截)', true); if (r.diff) showDiffBox(r.diff); return false; }
      S.pending.clear();
      await loadFile(t.root, t.file, op.kind === 'add' ? r.newId : S.selected);
      if (op.kind === 'add') toast(tr('已新增 ') + op.type);
      else if (op.kind === 'del') toast('已删除元素');
      else toast(tr('已更新 ') + op.key);
      return true;
    } catch (e) { toast(tr('操作失败:') + e.message, true); return false; }
  }

  function uniqueName(base) {
    let i = 1; const taken = new Set(S.flat.map((n) => n.name));
    let cand = base;
    while (taken.has(cand)) cand = base + '_' + i++;
    return cand;
  }

  /* ───────── 拖拽 / 缩放 ───────── */

  let drag = null;
  function onDown(e) {
    const target = e.target.closest('.node');
    if (!target) return;
    const id = target.dataset.id;
    select(id);
    const n = S.byId.get(id); if (!n) return;
    const resizing = e.target.classList.contains('h');
    const v = S.pending.get(id) || {};
    drag = { id, resizing, sx: e.clientX, sy: e.clientY, ox: v.x !== undefined ? v.x : n.x, oy: v.y !== undefined ? v.y : n.y, ow: v.w !== undefined ? v.w : n.drawW, oh: v.h !== undefined ? v.h : n.drawH, n };
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / S.zoom;
    const dy = (e.clientY - drag.sy) / S.zoom;
    const p = S.pending.get(drag.id) || {};
    if (drag.resizing) { p.w = Math.max(0, Math.round(drag.ow + dx)); p.h = Math.max(0, Math.round(drag.oh + dy)); }
    else { p.x = Math.round(drag.ox + dx); p.y = Math.round(drag.oy + dy); }
    S.pending.set(drag.id, p);
    refreshNode(drag.n);
    renderPropsLite();
  }
  function onUp() {
    if (!drag) return; drag = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderChanges(); renderProps();
  }
  function renderPropsLite() {
    if (!S.selected) return;
    const n = S.byId.get(S.selected);
    const inputs = $('#props').querySelectorAll('input[type=number]');
    // 顺序:x y width height —— 前两个必须是文件原始值(保存写的是它),不是画布偏移
    const r = rawOf(n);
    if (inputs.length >= 4) { inputs[0].value = Math.round(r.x); inputs[1].value = Math.round(r.y); inputs[2].value = Math.round(r.w); inputs[3].value = Math.round(r.h); }
  }
  function setField(id, field, val) {
    const p = S.pending.get(id) || {}; p[field] = val; S.pending.set(id, p);
    refreshNode(S.byId.get(id)); renderChanges();
  }
  function refreshNode(n) { const d = document.querySelector(`.node[data-id="${cssEsc(n.id)}"]`); if (d) place(d, n); }

  function onKey(e) {
    if (!S.selected) return;
    if (/input|select|textarea/i.test(e.target.tagName)) {
      if (e.key === 'Delete') e.stopPropagation();
      return;
    }
    if (e.key === 'Delete') { e.preventDefault(); deleteElement(); return; }
    const step = e.shiftKey ? 10 : 1;
    const n = S.byId.get(S.selected); const v = S.pending.get(n.id) || {};
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    v.x = (v.x !== undefined ? v.x : n.x) + dx; v.y = (v.y !== undefined ? v.y : n.y) + dy;
    S.pending.set(n.id, v); refreshNode(n); renderChanges(); renderProps();
  }

  /* ───────── 改动 / 保存 ───────── */

  function editsArray() { return [...S.pending.entries()].map(([id, v]) => Object.assign({ id }, v)); }

  function renderChanges() {
    const n = S.pending.size;
    $('#changeCount').textContent = String(n);
    $('#changeCount').className = 'chip' + (n ? ' hot' : '');
    const btn = $('#saveBtn');
    btn.disabled = !n || !S.roots[S.root] || !S.roots[S.root].writable;
    btn.textContent = n ? `${tr("保存 ")}${n}` : '保存 0';
    if (n && !S.roots[S.root].writable) btn.textContent = '只读目录';
  }

  function discardAll() { S.pending.clear(); renderStage(); renderChanges(); renderProps(); $('#diffBox').style.display = 'none'; toast('已撤销全部改动'); }

  /** 写盘几何改动(被 setProp 调用时只需落盘,不重载) */
  async function saveGeometry() {
    if (!S.pending.size) return true;
    try {
      const t = opTarget();
      if (!t) return false;
      const r = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: t.root, file: t.file, edits: editsArray(), syncXy: true }) });
      if (!r.written) { if (r.diff) showDiffBox(r.diff); toast(r.guard && !r.guard.ok ? '守卫未通过' : '保存失败', true); return false; }
      S.pending.clear(); renderChanges();
      return true;
    } catch (e) { toast(tr('保存几何失败:') + e.message, true); return false; }
  }

  async function saveAll() {
    if (!S.pending.size) { toast('没有待保存的改动'); return; }
    const btn = $('#saveBtn'); btn.disabled = true;
    try {
      const t = opTarget();
      if (!t) { btn.disabled = false; return; }
      const r = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: t.root, file: t.file, edits: editsArray(), syncXy: true }) });
      if (!r.written) { showDiffBox(r.diff); toast(r.guard && !r.guard.ok ? '守卫未通过,已取消' : '保存失败', !r.guard || !r.guard.ok); return; }
      toast(`${tr("已保存 ")}${r.details.length}${tr(" 处改动 · 备份 ")}${r.backup}`);
      showDiffBox(r.diff); reportXy(r.xy);
      const keep = S.selected;
      S.pending.clear();
      await loadFile(t.root, t.file, keep);
    } catch (e) { toast(tr('保存失败:') + e.message, true); }
    finally { btn.disabled = false; }
  }

  function reportXy(xy) {
    if (!xy || !xy.length) return;
    const box = $('#diffBox');
    let blocked = 0;
    const lines = xy.map((p) => {
      if (p.written) return `${tr("+ 联动写入 ")}${p.rootName}:${p.file}(${p.details.length}${tr(" 处)")}`;
      blocked++; return `${tr("- 联动未写入 ")}${p.rootName}:${p.file} — ${p.reason || ''}`;
    });
    box.innerHTML += '\n' + lines.map((l) => { const e = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return l.startsWith('+') ? `<span class="add">${e}</span>` : `<span class="del">${e}</span>`; }).join('\n');
    if (blocked) toast(`${tr("已保存,但 ")}${blocked}${tr(" 处坐标被脚本变量控制,拖拽在游戏里不生效")}`, true);
  }

  function showDiff() {
    if (!S.pending.size) return toast('没有待保存的改动');
    const t = opTarget();
    if (!t) return;
    api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: t.root, file: t.file, edits: editsArray() }) })
      .then((r) => { showDiffBox(r.diff); if (!r.guard.ok) toast(tr('守卫失败:') + r.guard.message, true); })
      .catch((e) => toast(tr('预览失败:') + e.message, true));
  }

  function showDiffBox(diff) {
    const box = $('#diffBox');
    box.style.display = 'block';
    box.innerHTML = (diff || '(无差异)').split('\n').map((l) => {
      const e = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (l.startsWith('+')) return '<span class="add">' + e + '</span>';
      if (l.startsWith('-')) return '<span class="del">' + e + '</span>';
      return e;
    }).join('\n');
  }

  // ★ 面板宽度可调:挂载工具箱 / 元素树的分隔条,并在宽度变化后重算画布
  Sizer.mountAll()
  // 既有 bug:onChange 注册的是 resize 监听器,再 dispatch 'resize' 会无限自递归 -> 栈溢出。
  // 画布 #stage 相对定位、无居中,面板宽度变化不改变元素坐标,无需动作。
  Sizer.onChange(() => {})

  /* ══════════════════════════════════════════════════════════════════
   * 右键菜单 + 快捷键(RIGHTCLICK_V2)
   *
   * 设计器页的右键重心和别的页不同:内容页是"看信息",这里是"**改坐标**"。
   * 拖拽只能改 x/y 和 w/h,想批量对齐 / 改单个轴 / 复制坐标都得进属性网格,
   * 而属性网格一次只看得到一个元素。所以把坐标操作全提到右键上。
   *
   * ⚠ 坐标有两套(见 geomOf 的注释):rawOf 是文件里的原始书写值(保存写它),
   *   geomOf 是画布偏移(含 orientation 锚点 / origo / centerposition)。
   *   菜单里"复制坐标"给的是 raw + 画布绝对两套,让人能核对游戏里实际位置。
   * ══════════════════════════════════════════════════════════════════ */
  function nodeMenu(n) {
    const r = rawOf(n);
    const ab = absOf(n);
    const ps = parentSizeOf(n);
    const isSel = S.selected === n.id;
    const items = [];

    items.push({
      label: isSel ? '在属性网格中编辑' : '选中这个元素', k: '→',
      act: () => select(n.id),
    });
    items.push({ label: '复制元素 id', k: '⧉', act: () => Ctx.copy(n.id, ' ' + n.id) });
    items.push({ label: '复制元素名', k: '⧉', act: () => Ctx.copy(n.name, '') });

    // ── 坐标 ──
    items.push({ sep: true });
    items.push({
      label: '复制坐标(x, y)', k: '⧉',
      hint: tr('画布绝对 ') + Math.round(ab.x) + ', ' + Math.round(ab.y),
      act: () => Ctx.copy(Math.round(r.x) + ', ' + Math.round(r.y), ''),
    });
    items.push({
      label: '复制 size(w × h)', k: '⧉',
      act: () => Ctx.copy(Math.round(r.w) + ' × ' + Math.round(r.h), ''),
    });
    items.push({
      label: '复制完整 position/size 语句', k: '⧉',
      act: () => Ctx.copy(
        `${n.type} {\n    name = "${n.name}"\n    position = { x = ${Math.round(r.x)} y = ${Math.round(r.y)} }\n    size = { w = ${Math.round(r.w)} h = ${Math.round(r.h)} }\n}`,
        ''),
    });
    items.push({
      label: '改X / 改Y…', k: '⌨',
      hint: tr('当前 ') + Math.round(r.x) + ', ' + Math.round(r.y),
      act: () => {
        const s = prompt(`${tr("改position —— 当前 x=")}${Math.round(r.x)} y=${Math.round(r.y)}${tr("\\n格式:x,y(两个都填;只填一个请给原值)")}`,
          Math.round(r.x) + ',' + Math.round(r.y));
        if (s === null) return;
        const m = s.split(',').map((v) => parseFloat(v));
        if (m.length !== 2 || m.some((v) => !isFinite(v))) { toast('格式不对,要「数字,数字」', true); return; }
        select(n.id);
        setField(n.id, 'x', Math.round(m[0]));
        setField(n.id, 'y', Math.round(m[1]));
        toast(tr('position已改为 ') + Math.round(m[0]) + ', ' + Math.round(m[1]));
      },
    });

    // ── 对齐(相对父级坐标系,直接给引擎认的值)──
    items.push({ sep: true });
    const alignTo = (label, fx, fy) => ({
      label, k: '⇔',
      hint: `${tr("父级 ")}${Math.round(ps.w)}×${Math.round(ps.h)}`,
      act: () => {
        select(n.id);
        setField(n.id, 'x', Math.round((ps.w - r.w) * fx));
        setField(n.id, 'y', Math.round((ps.h - r.h) * fy));
      },
    });
    items.push(alignTo('父级内左上对齐', 0, 0));
    items.push(alignTo('父级内水平居中', 0.5, 0));
    items.push(alignTo('父级内右上对齐', 1, 0));
    items.push(alignTo('父级内垂直居中', 0, 0.5));
    items.push(alignTo('父级内正中', 0.5, 0.5));
    items.push(alignTo('父级内左下对齐', 0, 1));
    items.push(alignTo('父级内右下对齐', 1, 1));
    items.push({
      label: '撑满父级', k: '⇔',
      act: () => {
        select(n.id);
        setField(n.id, 'x', 0); setField(n.id, 'y', 0);
        setField(n.id, 'w', Math.round(ps.w)); setField(n.id, 'h', Math.round(ps.h));
      },
    });

    // ── 导航 ──
    items.push({ sep: true });
    if (n.parent) {
      items.push({ label: tr('选中父级(') + shortType(n.parent.type) + ')', k: '↑', act: () => select(n.parent.id) });
    }
    if (n.children && n.children.length) {
      items.push({
        label: '选中第一个子级', k: '↓',
        act: () => select(n.children[0].id),
      });
    }

    // ── 诊断 ──
    const warn = [];
    if (n.varRefs) warn.push(n.varRefs + tr(' 个值由 @var 驱动(改了游戏里可能不生效)'));
    if (n.spriteMissing) warn.push(tr('贴图 ') + (n.sprite || '?') + tr(' 未找到'));
    if (n.sizeInferred) warn.push('尺寸来自贴图推断');
    if (n.sizePct) warn.push('尺寸写成百分比');
    if (n.parentRef) warn.push(tr('parent 引用 ') + n.parentRef);
    if (n.centerPosition) warn.push('centerposition = yes');
    if (warn.length) {
      items.push({ sep: true });
      items.push({ title: warn.join(' · ') });
    }
    if (n.sprite) items.push({ label: '复制贴图名', k: '⧉', act: () => Ctx.copy(n.sprite, '') });

    // ── 危险操作 ──
    items.push({ sep: true });
    items.push({
      label: '删除这个元素(含子级)', k: '✕', cls: 'danger',
      act: () => { select(n.id); deleteElement(); },
    });
    items.push({
      label: '在此之后新增同级元素', k: '+',
      dis: !S.roots[S.root] || !S.roots[S.root].writable,
      act: async () => {
        select(n.parent ? n.parent.id : null);
        await addElement(n.type);
      },
    });

    // 位置交给公共骨架(sourceItems 提供 IDE 跳转 / VS Code 打开 / 复制路径)
    const t = opTarget();
    return Ctx.sourceItems({
      root: t ? t.root : S.root,
      rootName: (S.roots[S.root] || {}).name || '',
      file: t ? t.file : (S.file || ''),
      line: n.line,
      id: n.id,
      loc: n.text,
      extra: items,
    });
  }

  function curNode() { return S.selected ? S.byId.get(S.selected) : null }

  /** 层级导航:父级 / 首个子级 / 兄弟 */
  function goto(d) {
    const n = curNode();
    if (!n) { toast('先选中一个元素', true); return }
    if (d === 'parent') {
      if (!n.parent) { toast('已经是根元素了', true); return }
      select(n.parent.id);
    } else if (d === 'child') {
      if (!n.children || !n.children.length) { toast('没有子元素', true); return }
      select(n.children[0].id);
    } else {
      if (!n.parent) { toast('根元素没有兄弟', true); return }
      const sib = n.parent.children || [];
      const i = sib.findIndex((x) => x.id === n.id);
      const j = i + d;
      if (j < 0 || j >= sib.length) return;
      select(sib[j].id);
    }
  }

  function wireCtxAndKeys() {
    if (!window.CtxWire || !window.Ctx) return;
    window.__KEYMAP_PAGE__ = 'designer';
    // ⚠ 右键不走 CtxWire 的 on 通道:那条通道会自动套一层 Ctx.sourceItems,
    //   而 nodeMenu 自己已经调过(要把坐标类菜单排在「跳转 IDE」之前)。
    const nodeCtx = (host, sel) => Ctx.attach(host, sel, (e2) => {
      const n = e2.__obj;
      if (!n) return null;
      return nodeMenu(n);
    });
    nodeCtx('#tree', '.tree-row');
    nodeCtx('#stage', '.node');
    CtxWire.attach({
      page: 'designer',
      keys: [].concat(
        [
          { id: 'view.fit', desc: '缩放至适合窗口', group: '视图', run: fit },
          { id: 'view.zoomReset', desc: '重置缩放 100%', group: '视图', run: () => setZoom(1) },
          { id: 'view.zoomIn', desc: '放大', group: '视图', run: () => setZoom(S.zoom * 1.25) },
          { id: 'view.zoomOut', desc: '缩小', group: '视图', run: () => setZoom(S.zoom / 1.25) },
          { id: 'view.toggleTex', desc: '切换贴图显示', group: '视图', run: () => $('#texBtn').click() },
          { id: 'designer.save', desc: '保存全部改动', group: '文件', run: () => { if (!S.pending.size) { toast('没有待保存的改动'); return } saveAll() } },
          { id: 'designer.preview', desc: '预览差异', group: '文件', run: showDiff },
          { id: 'designer.discard', desc: '撤销全部改动', group: '文件', run: () => { if (S.pending.size && confirm(tr('撤销全部 ') + S.pending.size + tr(' 处未保存改动?'))) discardAll(); else if (!S.pending.size) toast('没有待撤销的改动') } },
          { id: 'designer.parent', desc: '选中父级元素', group: '浏览', run: () => goto('parent') },
          { id: 'designer.firstChild', desc: '选中第一个子元素', group: '浏览', run: () => goto('child') },
          { id: 'designer.sibling', desc: '选中下一个兄弟元素', group: '浏览', run: () => goto(1) },
          { id: 'designer.prevSibling', desc: '选中上一个兄弟元素', group: '浏览', run: () => goto(-1) },
          { id: 'sel.clear', desc: '取消选择', group: '选中', run: () => select(null) },
        ],
        CtxWire.commonKeys(curId, { label: '元素' }),
      ),
    })
    function curId() { const n = curNode(); return n ? n.id : null }
  }
  wireCtxAndKeys()

  boot().catch((e) => toast(tr('初始化失败:') + e.message, true));
})();
