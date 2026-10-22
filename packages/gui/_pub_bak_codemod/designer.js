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
    selected: null, pending: new Map(), zoom: 1, showTex: true, texUrl: new Map(),
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

  /* ───────── 初始化 ───────── */

  async function boot() {
    const cfg = await api('/api/config');
    S.roots = cfg.roots;
    $('#rootSel').innerHTML =
      '<option value="-1">全部来源</option>' +
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
    $('#texBtn').onclick = (e) => { S.showTex = !S.showTex; e.target.classList.toggle('on', S.showTex); e.target.style.background = S.showTex ? '#dbe7f5' : ''; applyTextures(); };
    $('#texBtn').style.background = '#dbe7f5';
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

    const bad = (data.unresolved || []).length;
    $('#statChip').textContent = `${data.stats.elements} 元素 · ${data.stats.maxDepth} 层`;
    $('#statChip').className = 'chip' + (bad ? ' hot' : '');
    if (bad) $('#statChip').textContent += ` · ${bad} 处贴图未解析`;
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
        row.appendChild(el('span', 'dot' + (n.spriteMissing ? ' bad' : '')));
        const nm = el('span', 'nm', n.name);
        row.appendChild(nm);
        row.appendChild(el('span', 'ty', shortType(n.type)));
        row.onclick = () => select(n.id);
        // ★ 数据挂元素(各页统一约定,右键/快捷键都靠它,不按文本反查)
        row.__obj = n;
        // Shift+F10 走Keys.ctxKey → 它只认元素上挂的 ctxItems
        row.ctxItems = () => nodeMenu(n);
        box.appendChild(row);
        walk(n.children || [], depth + 1);
      }
    })(S.nodes, 0);
  }

  function shortType(t) { return t.replace(/Type$/i, '').replace(/window/i, 'win'); }

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
        '国策树槽位 (' + s.x + ', ' + s.y + ')　来自 ' + s.tree + ':' + s.line +
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
    d.style.height = Math.max(0, g.h) + 'px';
    if (n.name && n.name !== '(匿名)') d.appendChild(el('div', 'cap', n.name + (n.spriteMissing ? ' ⚠' : '')));
    const txt = n.text || n.props.text;
    if (txt) d.appendChild(el('div', 'txt', txt));
    d.appendChild(el('div', 'h'));
    for (const c of n.children || []) d.appendChild(buildDom(c));
    return d;
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
    return { x: bx + (r.x - n.x), y: by + (r.y - n.y), w: r.w, h: r.h };
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

  function place(d, n) { const g = geomOf(n); d.style.left = g.x + 'px'; d.style.top = g.y + 'px'; d.style.width = Math.max(0, g.w) + 'px'; d.style.height = Math.max(0, g.h) + 'px'; }

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
    const sl = S.inlay;
    if (sl && n === S.nodes[0]) { x += sl.x; y += sl.y; }
    return { x, y };
  }

  function setZoom(z) {
    S.zoom = Math.min(8, Math.max(0.1, z));
    $('#stage').style.transform = `scale(${S.zoom})`;
    $('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  }

  function fit() {
    const wrap = $('#canvasWrap');
    let w = 0, h = 0;
    for (const n of S.flat) { const a = absOf(n); const g = geomOf(n); w = Math.max(w, a.x + g.w); h = Math.max(h, a.y + g.h); }
    // ★ 参考框本身也要纳入视野,否则槽位在 4500,1150 时窗口会跑出可视区。
    const sem = canvasSemantics();
    w = Math.max(w, sem.w); h = Math.max(h, sem.h);
    // 只有【屏幕窗口】才至少纳入整块 1920×1080;
    // 内嵌组件在国策树坐标系里,套屏幕尺寸会把视野拉到几千像素、窗口缩成一个小点。
    if (sem.kind === 'screen') { w = Math.max(w, 1920); h = Math.max(h, 1080); }
    const z = Math.min((wrap.clientWidth - 40) / Math.max(w, 1), (wrap.clientHeight - 40) / Math.max(h, 1), 2);
    setZoom(Math.max(0.1, z));
    // 内嵌组件在远坐标,平移回内容处
    if (sem.kind === 'inlay') {
      const wrapEl = $('#canvasWrap');
      wrapEl.scrollLeft = Math.max(0, sem.slot.x - 60);
      wrapEl.scrollTop = Math.max(0, sem.slot.y - 60);
    }
  }

  /* ───────── 贴图 ───────── */

  async function loadTextures() {
    const ids = new Set();
    for (const n of S.flat) { if (n.texId) ids.add(n.texId); if (n.bgTexId) ids.add(n.bgTexId); }
    const todo = [...ids].filter((i) => !S.texUrl.has(i));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const id = todo[i++];
        try { const r = await api('/api/tex?id=' + encodeURIComponent(id)); if (r.png) S.texUrl.set(id, 'data:image/png;base64,' + r.png); } catch (e) {}
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
      if (S.showTex) {
        const u = (n.bgTexId && S.texUrl.get(n.bgTexId)) || (n.texId && S.texUrl.get(n.texId));
        if (u) { d.style.backgroundImage = `url(${u})`; d.style.backgroundSize = '100% 100%'; }
      } else d.style.backgroundImage = '';
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
    box.appendChild(propRow('画布偏移', txt(`${Math.round(off.x)}, ${Math.round(off.y)}  ← 父级 ${Math.round(ps.w)}×${Math.round(ps.h)}`)));
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
    box.appendChild(propSel('alwaysTransparent', n.props.alwaysTransparent || '', ['', 'yes', 'no']));

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
    box.appendChild(propSel('alwaysTransparent', n.props.alwaysTransparent || '', ['', 'yes', 'no']));
    box.appendChild(propSel('centerPosition', n.props.centerPosition || '', ['', 'yes', 'no']));
    box.appendChild(propSel('hide', n.props.hide || '', ['', 'yes', 'no']));
    box.appendChild(propInput('clickSound', '点击音 clickSound', n.props.clickSound || '', false));
    box.appendChild(propInput('frame', '帧 frame', n.props.frame || '', false));
    box.appendChild(propInput('pdx_tooltip', '提示 pdx_tooltip', n.props.pdx_tooltip || '', false));

    // 块形态属性:真实语法里 borderSize / margin / slotSize 都写在子块内,
    // 必须走点号路径(borderSize.x)才改得到
    const pb = n.propBlocks || {};
    const blk = (title, key, fields) => {
      const inner = pb[key] || pb[key.toLowerCase()];
      if (!inner) return;
      box.appendChild(group(title + ' (' + key + ')'));
      for (const f of fields) {
        if (!(f in inner)) continue;
        const i = inp('text', inner[f]);
        i.onchange = () => setProp(key + '.' + f, i.value.trim());
        box.appendChild(propRow(f, i));
      }
    };
    blk('边框', 'borderSize', ['x', 'y']);
    blk('外边距', 'margin', ['left', 'right', 'top', 'bottom']);
    blk('格位尺寸', 'slotSize', ['width', 'height']);
    blk('瓦片尺寸', 'tileSize', ['width', 'height']);

    const flags = el('div');
    if (n.spriteMissing) flags.appendChild(el('span', 'flag err', '⚠ sprite 未定义:' + n.sprite));
    if (n.sizePct) flags.appendChild(el('span', 'flag', '· 尺寸是百分比(相对父级),已折算为像素显示;改成固定值会丢失自适应'));
    if (n.sizeAuto) flags.appendChild(el('span', 'flag', '· 尺寸写 0 由内容自适应,此处为子元素包围盒估算'));
    if (n.varRefs > 0) flags.appendChild(el('span', 'flag', '· 有 ' + n.varRefs + ' 个几何值引用 @var,直接改数字不会生效,需改变量定义'));
    if (n.bgSprite) flags.appendChild(el('span', 'flag', '· background 贴图: ' + n.bgSprite));
    if (n.sizeUnknown) flags.appendChild(el('span', 'flag err', '⚠ 尺寸未知:无贴图可推断'));
    else if (n.sizeInferred) flags.appendChild(el('span', 'flag', '· 尺寸由贴图推断'));
    if (n.posMissing) flags.appendChild(el('span', 'flag', '· 文件无 position,按 (0,0)'));
    if (n.orientation) {
      const d = ORIENT_DESC[String(n.orientation).toLowerCase()];
      flags.appendChild(el('span', 'flag', `· 锚点 ${n.orientation}${d ? '(' + d + ')' : ''}:position 是相对该点的偏移,不是父级左上角`));
    } else if (n.effectiveOrientation) {
      const p = n.parent ? S.byId.get(n.parent.id) : null;
      const d = ORIENT_DESC[String(n.effectiveOrientation).toLowerCase()];
      flags.appendChild(el('span', 'flag', `· 锚点 ${n.effectiveOrientation}${d ? '(' + d + ')' : ''} —— 继承自父级${p ? ' ' + p.name : ''}(wiki:元素默认继承所在容器的 orientation)`));
    }
    if (n.origo) flags.appendChild(el('span', 'flag', `· 自身对齐点 origo = ${n.origo}:渲染时扣掉元素自身的对应点`));
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
      if (r.guard && !r.guard.ok) { if (r.diff) showDiffBox(r.diff); toast('守卫失败:' + r.guard.message, true); return false; }
      if (!r.written) { toast('未写入(只读或守卫拦截)', true); if (r.diff) showDiffBox(r.diff); return false; }
      S.pending.clear();
      await loadFile(t.root, t.file, op.kind === 'add' ? r.newId : S.selected);
      if (op.kind === 'add') toast('已新增 ' + op.type);
      else if (op.kind === 'del') toast('已删除元素');
      else toast('已更新 ' + op.key);
      return true;
    } catch (e) { toast('操作失败:' + e.message, true); return false; }
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
    btn.textContent = n ? `保存 ${n}` : '保存 0';
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
    } catch (e) { toast('保存几何失败:' + e.message, true); return false; }
  }

  async function saveAll() {
    if (!S.pending.size) { toast('没有待保存的改动'); return; }
    const btn = $('#saveBtn'); btn.disabled = true;
    try {
      const t = opTarget();
      if (!t) { btn.disabled = false; return; }
      const r = await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: t.root, file: t.file, edits: editsArray(), syncXy: true }) });
      if (!r.written) { showDiffBox(r.diff); toast(r.guard && !r.guard.ok ? '守卫未通过,已取消' : '保存失败', !r.guard || !r.guard.ok); return; }
      toast(`已保存 ${r.details.length} 处改动 · 备份 ${r.backup}`);
      showDiffBox(r.diff); reportXy(r.xy);
      const keep = S.selected;
      S.pending.clear();
      await loadFile(t.root, t.file, keep);
    } catch (e) { toast('保存失败:' + e.message, true); }
    finally { btn.disabled = false; }
  }

  function reportXy(xy) {
    if (!xy || !xy.length) return;
    const box = $('#diffBox');
    let blocked = 0;
    const lines = xy.map((p) => {
      if (p.written) return `+ 联动写入 ${p.rootName}:${p.file}(${p.details.length} 处)`;
      blocked++; return `- 联动未写入 ${p.rootName}:${p.file} — ${p.reason || ''}`;
    });
    box.innerHTML += '\n' + lines.map((l) => { const e = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return l.startsWith('+') ? `<span class="add">${e}</span>` : `<span class="del">${e}</span>`; }).join('\n');
    if (blocked) toast(`已保存,但 ${blocked} 处坐标被脚本变量控制,拖拽在游戏里不生效`, true);
  }

  function showDiff() {
    if (!S.pending.size) return toast('没有待保存的改动');
    const t = opTarget();
    if (!t) return;
    api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: t.root, file: t.file, edits: editsArray() }) })
      .then((r) => { showDiffBox(r.diff); if (!r.guard.ok) toast('守卫失败:' + r.guard.message, true); })
      .catch((e) => toast('预览失败:' + e.message, true));
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
  Sizer.onChange(() => window.dispatchEvent(new Event('resize')))

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
      hint: '画布绝对 ' + Math.round(ab.x) + ', ' + Math.round(ab.y),
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
      hint: '当前 ' + Math.round(r.x) + ', ' + Math.round(r.y),
      act: () => {
        const s = prompt(`改position —— 当前 x=${Math.round(r.x)} y=${Math.round(r.y)}\n格式:x,y(两个都填;只填一个请给原值)`,
          Math.round(r.x) + ',' + Math.round(r.y));
        if (s === null) return;
        const m = s.split(',').map((v) => parseFloat(v));
        if (m.length !== 2 || m.some((v) => !isFinite(v))) { toast('格式不对,要「数字,数字」', true); return; }
        select(n.id);
        setField(n.id, 'x', Math.round(m[0]));
        setField(n.id, 'y', Math.round(m[1]));
        toast('position已改为 ' + Math.round(m[0]) + ', ' + Math.round(m[1]));
      },
    });

    // ── 对齐(相对父级坐标系,直接给引擎认的值)──
    items.push({ sep: true });
    const alignTo = (label, fx, fy) => ({
      label, k: '⇔',
      hint: `父级 ${Math.round(ps.w)}×${Math.round(ps.h)}`,
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
      items.push({ label: '选中父级(' + shortType(n.parent.type) + ')', k: '↑', act: () => select(n.parent.id) });
    }
    if (n.children && n.children.length) {
      items.push({
        label: '选中第一个子级', k: '↓',
        act: () => select(n.children[0].id),
      });
    }

    // ── 诊断 ──
    const warn = [];
    if (n.varRefs) warn.push(n.varRefs + ' 个值由 @var 驱动(改了游戏里可能不生效)');
    if (n.spriteMissing) warn.push('贴图 ' + (n.sprite || '?') + ' 未找到');
    if (n.sizeInferred) warn.push('尺寸来自贴图推断');
    if (n.sizePct) warn.push('尺寸写成百分比');
    if (n.parentRef) warn.push('parent 引用 ' + n.parentRef);
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
          { id: 'designer.discard', desc: '撤销全部改动', group: '文件', run: () => { if (S.pending.size && confirm('撤销全部 ' + S.pending.size + ' 处未保存改动?')) discardAll(); else if (!S.pending.size) toast('没有待撤销的改动') } },
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

  boot().catch((e) => toast('初始化失败:' + e.message, true));
})();
