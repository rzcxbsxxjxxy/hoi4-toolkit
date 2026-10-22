/* HOI4 GUI 工作台 —— 前端
 *
 * 渲染用嵌套 DOM:子元素 position:absolute 相对父容器,
 * 与 HOI4 的坐标语义一一对应(子坐标相对父原点)。
 * 好处是拖动父容器时子元素自动跟随,不需要手工重算子树。
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

  const S = {
    roots: [],
    files: [],
    root: 0,
    file: null,
    nodes: [],
    flat: [],
    byId: new Map(),
    childrenOf: new Map(),
    selected: null,
    hover: null,
    pending: new Map(), // id -> {x,y,w,h}
    zoom: 1,
    showTex: true,
    snap: false,
    grid: 5,
    texUrl: new Map(),
    stats: null,
    unresolved: [],
  };

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 3200);
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
    if (!document.getElementById('src-chip-style')) {
      const _st = document.createElement('style');
      _st.id = 'src-chip-style';
      _st.textContent = '.src-chip{display:inline-block;font-size:11px;line-height:1;padding:1px 5px;border-radius:6px;margin-right:6px;vertical-align:middle;color:#fff;font-weight:600}.src-chip.game{background:#3b6fb5}.src-chip.mod{background:#2f8f5b}';
      document.head.appendChild(_st);
    }
    $('#rootSel').innerHTML =
      tr('<option value="-1">全部来源</option>') +
      cfg.roots
        .map((r, i) => `<option value="${i}">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)
        .join('');
    // 默认选第一个可写的 root(模组),没有就选第一个
    let def = 0;
    for (let i = 0; i < cfg.roots.length; i++) if (cfg.roots[i].writable) { def = i; break; }
    S.root = def;
    $('#rootSel').value = String(def);

    const f = await api('/api/files');
    S.files = f.files;
    renderFileList();

    $('#rootSel').onchange = () => { S.root = +$('#rootSel').value; renderFileList(); };
    $('#fileFilter').oninput = renderFileList;
    $('#zoomIn').onclick = () => setZoom(S.zoom * 1.25);
    $('#zoomOut').onclick = () => setZoom(S.zoom / 1.25);
    $('#fitBtn').onclick = fit;
    $('#texBtn').onclick = (e) => {
      S.showTex = !S.showTex;
      e.target.classList.toggle('on', S.showTex);
      e.target.style.background = S.showTex ? '#dbe7f5' : '';
      applyTextures();
    };
    $('#texBtn').style.background = '#dbe7f5';
    $('#nameBtn').onclick = (e) => {
      document.body.classList.toggle('showNames');
      e.target.style.background = document.body.classList.contains('showNames') ? '#dbe7f5' : '';
    };
    applyDisplaySettings();
    $('#discardBtn').onclick = discardAll;
    $('#previewBtn').onclick = showDiff;
    $('#saveBtn').onclick = save;

    document.addEventListener('keydown', onKey);
    $('#canvasWrap').addEventListener('mousedown', onDown);
    $('#canvasWrap').addEventListener('click', (e) => { if (!e.target.closest('.node')) select(null); });

    // 默认打开元素最多的文件之一,让首屏就有东西看
    const cand = S.files.filter((x) => x.root === S.root);
    const pick =
      cand.find((x) => /unitview|countryproduction|main|hud|topbar/i.test(x.name)) || cand[0];
    if (pick) loadFile(pick.root, pick.file);
  }

  /* 从设置页读取显示选项。读不到就保持缺省,不阻塞启动。 */
  async function applyDisplaySettings() {
    let d = null;
    try { d = (await api('/api/settings')).display; } catch { return; }
    if (!d) return;
    S.snap = !!d.snap;
    S.grid = Math.max(1, d.grid || 5);
    if (d.showTex !== false) {
      S.showTex = true;
      $('#texBtn').classList.add('on');
      $('#texBtn').style.background = '#dbe7f5';
    }
    if (d.showNames) {
      document.body.classList.add('showNames');
      $('#nameBtn').style.background = '#dbe7f5';
    }
    const z = parseFloat(d.defaultZoom);
    if (Number.isFinite(z) && z > 0 && Math.abs(z - S.zoom) > 0.001) setZoom(z);
  }

  function renderFileList() {
    const q = $('#fileFilter').value.trim().toLowerCase();
    const list = S.files.filter(
      (f) => (S.root < 0 || f.root === S.root) && (!q || f.name.toLowerCase().includes(q)),
    );
    const box = $('#fileList');
    box.innerHTML = '';
    list.forEach((f) => {
      const d = el('div', 'file-item' + (f.file === S.file ? ' on' : ''));
      const r0 = S.roots[f.root] || {};
      const chip = el('span', 'src-chip' + (r0.writable ? ' mod' : ' game'));
      chip.textContent = r0.name || ('root' + f.root);
      d.appendChild(chip);
      d.appendChild(document.createTextNode(f.name));
      d.onclick = () => {
        if (S.pending.size && !confirm('有未保存的改动,确定切换文件吗?')) return;
        loadFile(f.root, f.file);
      };
      box.appendChild(d);
    });
    if (!list.length) box.appendChild(el('div', 'empty', '无匹配文件'));
  }

  /* ───────── 载入布局 ───────── */

  async function loadFile(root, file) {
    S.root = root; S.file = file;
    $('#rootSel').value = String(root);
    renderFileList();
    const data = await api(`/api/layout?root=${root}&file=${encodeURIComponent(file)}`);
    S.nodes = data.nodes;
    S.stats = data.stats;
    S.unresolved = data.unresolved || [];
    S.pending.clear();
    S.selected = null;

    S.flat = [];
    S.byId = new Map();
    S.childrenOf = new Map();
    (function walk(ns, parent) {
      for (const n of ns) {
        n.parent = parent || null;
        S.flat.push(n);
        S.byId.set(n.id, n);
        if (parent) {
          const arr = S.childrenOf.get(parent.id) || [];
          arr.push(n);
          S.childrenOf.set(parent.id, arr);
        }
        walk(n.children || [], n);
      }
    })(S.nodes, null);

    renderTree();
    renderStage();
    renderInspector();
    renderChanges();
    loadTextures();
    fit();

    const bad = S.unresolved.length;
    $('#statChip').textContent = `${S.stats.elements}${tr(" 元素 · ")}${S.stats.maxDepth}${tr(" 层")}`;
    $('#statChip').className = 'chip' + (bad ? ' hot' : '');
    if (bad) $('#statChip').textContent += ` · ${bad}${tr(" 处贴图未解析")}`;
  }

  /* ───────── 元素树 ───────── */

  function renderTree() {
    const box = $('#tree');
    box.innerHTML = '';
    (function walk(ns, depth) {
      for (const n of ns) {
        const bad = n.spriteMissing;
        const row = el('div', 'tree-row' + (S.selected === n.id ? ' on' : ''));
        row.style.paddingLeft = 6 + depth * 12 + 'px';
        row.appendChild(el('span', 'dot' + (bad ? ' bad' : '')));
        const nm = el('span', '', n.name);
        nm.style.overflow = 'hidden';
        nm.style.textOverflow = 'ellipsis';
        row.appendChild(nm);
        row.appendChild(el('span', 'ty', shortType(n.type)));
        row.onclick = () => select(n.id);
        row.onmouseenter = () => { S.hover = n.id; markHover(); };
        row.onmouseleave = () => { S.hover = null; markHover(); };
        box.appendChild(row);
        walk(n.children || [], depth + 1);
      }
    })(S.nodes, 0);
  }

  function shortType(t) {
    return t.replace(/Type$/i, '').replace(/window/i, 'win');
  }

  function markHover() {
    document.querySelectorAll('.node.hover').forEach((d) => d.classList.remove('hover'));
    if (S.hover) {
      const d = document.querySelector(`.node[data-id="${cssEsc(S.hover)}"]`);
      if (d) d.classList.add('hover');
    }
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ───────── 画布 ───────── */

  function renderStage() {
    const stage = $('#stage');
    stage.innerHTML = '';
    // 屏幕参考框:根级窗口的父级就是屏幕(1920x1080)
    let cw = 1920, ch = 1080;
    for (const n of S.flat) { const a = absOf(n); cw = Math.max(cw, a.x + (n.drawW || 0)); ch = Math.max(ch, a.y + (n.drawH || 0)); }
    stage.style.width = Math.round(cw) + 'px';
    stage.style.height = Math.round(ch) + 'px';
    const sc = el('div', 'screen');
    sc.appendChild(el('div', 'screen-cap', '屏幕 1920 × 1080(根窗口的父级)'));
    stage.appendChild(sc);
    for (const n of S.nodes) stage.appendChild(buildDom(n));
    markHover();
    if (S.selected) {
      const d = document.querySelector(`.node[data-id="${cssEsc(S.selected)}"]`);
      if (d) d.classList.add('sel');
    }
  }

  function buildDom(n) {
    const d = el('div', 'node');
    d.dataset.id = n.id;
    if (n.spriteMissing || n.sizeUnknown) d.classList.add('bad');
    if (n.sizeUnknown) d.classList.add('unknown');
    place(d, n);

    const cap = el('div', 'cap', n.name + (n.spriteMissing ? ' ⚠' : ''));
    d.appendChild(cap);

    if (n.text) {
      const t = el('div', '', n.text);
      t.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'font-size:11px;color:#fff;text-shadow:0 1px 2px #000;overflow:hidden;pointer-events:none';
      d.appendChild(t);
    }

    const h = el('div', 'h');
    d.appendChild(h);

    for (const c of n.children || []) d.appendChild(buildDom(c));
    return d;
  }

  /**
   * 画布渲染偏移 = offX(引擎按 orientation 锚点 + origo/centerposition 折算)
   *              + 原始 x 的改动量。
   * 直接用 n.x(文件原始值)渲染会漏掉锚点 —— upper_right / lower_right 之类
   * 的元素会全部堆到父级左上角,表现为"看不出相对位置关系"。
   */
  function offOf(n) {
    const v = S.pending.get(n.id);
    const rx = v && v.x !== undefined ? v.x : n.x;
    const ry = v && v.y !== undefined ? v.y : n.y;
    const bx = n.offX !== undefined ? n.offX : n.x;
    const by = n.offY !== undefined ? n.offY : n.y;
    return { x: bx + (rx - n.x), y: by + (ry - n.y) };
  }

  function place(d, n) {
    const v = S.pending.get(n.id);
    const o = offOf(n);
    const w = v && v.w !== undefined ? v.w : n.drawW;
    const hh = v && v.h !== undefined ? v.h : n.drawH;
    d.style.left = o.x + 'px';
    d.style.top = o.y + 'px';
    d.style.width = Math.max(0, w) + 'px';
    d.style.height = Math.max(0, hh) + 'px';
  }

  function absOf(n) {
    let x = 0, y = 0, c = n;
    while (c) {
      const o = offOf(c);
      x += o.x;
      y += o.y;
      c = c.parent;
    }
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
    for (const n of S.flat) {
      const a = absOf(n);
      const v = S.pending.get(n.id);
      w = Math.max(w, a.x + (v && v.w !== undefined ? v.w : n.drawW));
      h = Math.max(h, a.y + (v && v.h !== undefined ? v.h : n.drawH));
    }
    w = Math.max(w, 1920); h = Math.max(h, 1080);
    const z = Math.min((wrap.clientWidth - 40) / Math.max(w, 1), (wrap.clientHeight - 40) / Math.max(h, 1), 2);
    setZoom(Math.max(0.1, z));
  }

  /* ───────── 贴图 ───────── */

  async function loadTextures() {
    const ids = new Set();
    for (const n of S.flat) {
      if (n.texId) ids.add(n.texId);
      if (n.bgTexId) ids.add(n.bgTexId);
    }
    const todo = [...ids].filter((i) => !S.texUrl.has(i));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const id = todo[i++];
        try {
          const r = await api('/api/tex?id=' + encodeURIComponent(id));
          if (r.png) S.texUrl.set(id, 'data:image/png;base64,' + r.png);
        } catch (e) { /* 单张失败不影响整体 */ }
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
        if (u) {
          d.style.backgroundImage = `url(${u})`;
          d.style.backgroundSize = '100% 100%';
        }
      } else {
        d.style.backgroundImage = '';
      }
    }
  }

  /* ───────── 选择 / 检查器 ───────── */

  /* ───────── 跨域联动(interface 之外) ───────── */

  const REF_LABEL = {
    window_name: '窗口名',
    parent_window: '父窗口',
    parent_scripted_gui: '父 scripted_gui',
    property: '属性覆盖',
    property_xy: '坐标覆盖',
    effect: '点击效果',
    trigger: '触发器',
    ai_weight: 'AI 权重',
    dynamic_list: '动态列表',
    entry_container: '列表项容器',
    inlay_child: '国策内嵌窗',
    sprite: '贴图',
    scripted_gui_use: '决策分类',
    inlay_use: '国策树',
  };
  const refCache = new Map(); // 元素名 -> 引用数据

  function linkSection(n) {
    const sec = el('div', 'linksec');
    const head = el('div', 'linkhead');
    head.appendChild(el('span', '', '跨域联动'));
    const chip = el('span', 'chip', '…');
    head.appendChild(chip);
    sec.appendChild(head);
    if (!n.name || n.name === '(匿名)') {
      sec.appendChild(el('div', 'empty', '匿名元素无法被脚本引用'));
      return sec;
    }
    const body = el('div', 'linkbody');
    sec.appendChild(body);

    const cached = refCache.get(n.name);
    if (cached) {
      renderLinkBody(body, n, cached);
      return sec;
    }
    body.appendChild(el('div', 'empty', '正在查询引用图…'));
    fetch('/api/links/refs?name=' + encodeURIComponent(n.name))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || r.statusText);
        refCache.set(n.name, d);
        // 选中元素可能已经换了(用户手快),只更新还在显示的那个
        if (S.selected !== n.id) return;
        body.innerHTML = '';
        renderLinkBody(body, n, d);
      })
      .catch((e) => {
        body.innerHTML = '';
        body.appendChild(el('div', 'empty', tr('引用图不可用:') + e.message));
      });
    return sec;
  }

  function renderLinkBody(box, n, d) {
    const refs = d.refs || [];
    const ovs = d.overrides || [];
    // 位置被 scripted_gui 覆盖 → 在画布上拖它根本不会生效,必须说清楚
    for (const ov of ovs) {
      const w = el('div', 'warnbox');
      w.appendChild(el('div', 'wt', '⚠ 拖拽不会生效'));
      const expr = [ov.override && ov.override.x, ov.override && ov.override.y]
        .filter(Boolean)
        .join(' / ');
      w.appendChild(
        el('div', 'wbody', `${ov.rootName}:${ov.file}:${ov.line}${tr(" 把这个元素的位置绑到了脚本值 ")}${expr}`),
      );
      if (ov.vars && ov.vars.length) w.appendChild(el('div', 'wbody', tr('相关变量:') + ov.vars.join(', ')));
      box.appendChild(w);
    }
    if (d.dangling) {
      const w = el('div', 'warnbox warn');
      w.appendChild(el('div', 'wt', '⚠ 悬空元素'));
      w.appendChild(el('div', 'wbody', '引用图里找不到它的定义(可能定义在别的目录)'));
      box.appendChild(w);
    }

    if (!refs.length && !ovs.length) {
      box.appendChild(el('div', 'empty', 'scripted_gui / 国策内嵌窗里没有引用它'));
    } else {
      const byFile = new Map();
      for (const r of refs) {
        const k = r.rootName + ':' + r.file;
        if (!byFile.has(k)) byFile.set(k, []);
        byFile.get(k).push(r);
      }
      for (const [file, list] of byFile) {
        const row = el('div', 'refitem');
        row.appendChild(el('div', 'rf', file));
        for (const r of list) {
          const line = el('div', 'rl');
          line.appendChild(el('span', 'rk', REF_LABEL[r.kind] || r.kind));
          line.appendChild(el('span', 'rn', `L${r.line}`));
          const tail = r.suffix ? `${r.raw}${tr("(后缀 ")}${r.suffix})` : r.raw;
          line.appendChild(el('span', 'rv', tail));
          row.appendChild(line);
        }
        box.appendChild(row);
      }
    }

    // 重命名:改一处,所有引用一起改
    const rr = el('div', 'rename');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = n.name;
    inp.className = 'rname';
    rr.appendChild(inp);
    const btn = el('button', '', '改名为…');
    rr.appendChild(btn);
    box.appendChild(rr);
    const out = el('div', 'rout');
    box.appendChild(out);

    btn.onclick = async () => {
      const to = inp.value.trim();
      if (!to || to === n.name) return toast('请输入一个不同的名字');
      out.innerHTML = '';
      out.appendChild(el('div', 'empty', '正在计算影响面…'));
      try {
        const d2 = await api('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: n.name, newName: to, kind: 'gui_element' }),
        });
        out.innerHTML = '';
        const patches = d2.patches || [];
        const total = patches.reduce((s, p) => s + p.details.length, 0);
        out.appendChild(el('div', 'rsum', `${patches.length}${tr(" 个文件,")}${total}${tr(" 处改动")}`));
        for (const p of patches) {
          const row = el('div', 'rfile');
          row.appendChild(el('span', 'rf', p.rootName + ':' + p.file));
          row.appendChild(el('span', '', p.guard.ok ? `${p.details.length}${tr(" 处")}` : '守卫失败'));
          out.appendChild(row);
          for (const det of p.details) {
            out.appendChild(el('div', 'rdiff', `  L${det.line}  ${det.from} → ${det.to}`));
          }
          for (const w of p.warnings) out.appendChild(el('div', 'rdiff warn', '  ⚠ ' + w));
          // 同名但没被自动改的地方(变量、派生元素名)必须让人看见
          for (const note of p.notes || []) out.appendChild(el('div', 'rnote', tr('  · 未联动: ') + note));
        }
        const applyBtn = el('button', 'primary', '确认应用');
        applyBtn.style.marginTop = '6px';
        applyBtn.onclick = async () => {
          applyBtn.disabled = true;
          try {
            const r = await api('/api/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: n.name, newName: to, kind: 'gui_element', apply: true }),
            });
            refCache.clear();
            const skipped = r.skipped || [];
            if (skipped.length) {
              toast(
                `${tr("已改 ")}${r.files}${tr(" 个文件,")}${skipped.length}${tr(" 个被跳过:")}${skipped.map((s) => s.reason).join('; ')}`,
                true,
              );
            } else {
              toast(`${tr("已重命名:")}${r.files}${tr(" 个文件")}`);
            }
            await loadFile(S.root, S.file);
          } catch (e) {
            toast(tr('应用失败:') + e.message, true);
          }
        };
        out.appendChild(applyBtn);
      } catch (e) {
        out.innerHTML = '';
        out.appendChild(el('div', 'empty', tr('预览失败:') + e.message));
      }
    };
  }

  function select(id) {
    S.selected = id;
    document.querySelectorAll('.node.sel').forEach((d) => d.classList.remove('sel'));
    if (id) {
      const d = document.querySelector(`.node[data-id="${cssEsc(id)}"]`);
      if (d) d.classList.add('sel');
    }
    renderTree();
    renderInspector();
  }

  function renderInspector() {
    const box = $('#insp');
    const n = S.selected ? S.byId.get(S.selected) : null;
    if (!n) { box.innerHTML = '<div class="empty">在画布或元素树中选择一个元素</div>'; return; }
    const v = S.pending.get(n.id) || {};
    const gx = v.x !== undefined ? v.x : n.x;
    const gy = v.y !== undefined ? v.y : n.y;
    const gw = v.w !== undefined ? v.w : n.drawW;
    const gh = v.h !== undefined ? v.h : n.drawH;
    const a = absOf(n);

    box.innerHTML = '';
    const head = el('div', '', n.name);
    head.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:2px;word-break:break-all';
    box.appendChild(head);
    const sub = el('div', '', n.type + tr('  ·  第 ') + n.line + tr(' 行'));
    sub.style.cssText = 'color:var(--ink3);font-size:11px;margin-bottom:8px';
    box.appendChild(sub);

    const f = el('div', 'flags');
    if (n.spriteMissing) f.appendChild(el('span', 'flag err', tr('⚠ sprite 未定义:') + n.sprite + tr('(游戏内显示为空白)')));
    if (n.sizeUnknown) f.appendChild(el('span', 'flag err', '⚠ 尺寸未知:无贴图可推断,虚线框仅为占位'));
    else if (n.sizeInferred) f.appendChild(el('span', 'flag', '· 尺寸由贴图推断,未写在文件里'));
    if (n.posMissing) f.appendChild(el('span', 'flag', '· 文件里没有 position,当前按 (0,0) 渲染'));
    if (f.children.length) box.appendChild(f);

    const grid = el('div');
    grid.style.marginBottom = '8px';
    [['x', gx], ['y', gy], ['width', gw], ['height', gh]].forEach(([k, val]) => {
      const row = el('div', 'row');
      row.appendChild(el('label', '', k));
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = Math.round(val * 100) / 100;
      inp.onchange = () => {
        const num = parseFloat(inp.value);
        if (!isFinite(num)) return;
        setField(n.id, k === 'width' ? 'w' : k === 'height' ? 'h' : k, num);
        renderInspector();
      };
      row.appendChild(inp);
      grid.appendChild(row);
    });
    box.appendChild(grid);

    const kv = (k, v2) => {
      const r = el('div', 'kv');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v2));
      return r;
    };
    const info = el('div');
    info.appendChild(kv('绝对坐标', `${Math.round(a.x)}, ${Math.round(a.y)}`));
    if (n.sprite) info.appendChild(kv('sprite', n.sprite));
    if (n.orientation) info.appendChild(kv('orientation', n.orientation));
    if (n.origo) info.appendChild(kv('origo', n.origo));
    if (n.centerPosition) info.appendChild(kv('centerposition', 'yes'));
    if (n.clipping) info.appendChild(kv('clipping', n.clipping));
    if (n.moveable) info.appendChild(kv('moveable', n.moveable));
    if (n.text) info.appendChild(kv('text', n.text));
    info.appendChild(kv('父级', n.parent ? n.parent.name : '(根)'));
    info.appendChild(kv('id', n.id));
    box.appendChild(info);

    // 跨域联动:这个元素在 interface 之外被谁引用着
    box.appendChild(linkSection(n));

    const btns = el('div');
    btns.style.cssText = 'display:flex;gap:6px;margin-top:10px';
    const bp = el('button', '', '选中父级');
    bp.disabled = !n.parent;
    bp.onclick = () => select(n.parentId);
    const br = el('button', '', '撤销此元素');
    br.onclick = () => { S.pending.delete(n.id); refreshNode(n); renderChanges(); renderInspector(); };
    btns.appendChild(bp); btns.appendChild(br);
    box.appendChild(btns);
  }

  function setField(id, field, val) {
    const p = S.pending.get(id) || {};
    p[field] = val;
    S.pending.set(id, p);
    refreshNode(S.byId.get(id));
    renderChanges();
  }

  function refreshNode(n) {
    const d = document.querySelector(`.node[data-id="${cssEsc(n.id)}"]`);
    if (d) place(d, n);
  }

  /* ───────── 拖拽 / 缩放 ───────── */

  let drag = null;
  function onDown(e) {
    const target = e.target.closest('.node');
    if (!target) return;
    const id = target.dataset.id;
    select(id);
    const n = S.byId.get(id);
    if (!n) return;
    const resizing = e.target.classList.contains('h');
    const v = S.pending.get(id) || {};
    drag = {
      id, resizing,
      sx: e.clientX, sy: e.clientY,
      ox: v.x !== undefined ? v.x : n.x,
      oy: v.y !== undefined ? v.y : n.y,
      ow: v.w !== undefined ? v.w : n.drawW,
      oh: v.h !== undefined ? v.h : n.drawH,
      n,
    };
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function onMove(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / S.zoom;
    const dy = (e.clientY - drag.sy) / S.zoom;
    const p = S.pending.get(drag.id) || {};
    if (drag.resizing) {
      p.w = Math.max(0, Math.round(drag.ow + dx));
      p.h = Math.max(0, Math.round(drag.oh + dy));
    } else {
      p.x = Math.round(drag.ox + dx);
      p.y = Math.round(drag.oy + dy);
      if (S.snap) {
        const g = S.grid;
        p.x = Math.round(p.x / g) * g;
        p.y = Math.round(p.y / g) * g;
      }
    }
    S.pending.set(drag.id, p);
    refreshNode(drag.n);
    renderInspectorLite();
  }

  function onUp() {
    if (!drag) return;
    drag = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderChanges();
    renderInspector();
  }

  function renderInspectorLite() {
    if (!S.selected) return;
    const n = S.byId.get(S.selected);
    const v = S.pending.get(n.id) || {};
    const box = $('#insp');
    const inputs = box.querySelectorAll('input[type=number]');
    if (inputs.length === 4) {
      inputs[0].value = Math.round((v.x !== undefined ? v.x : n.x) * 100) / 100;
      inputs[1].value = Math.round((v.y !== undefined ? v.y : n.y) * 100) / 100;
      inputs[2].value = Math.round((v.w !== undefined ? v.w : n.drawW) * 100) / 100;
      inputs[3].value = Math.round((v.h !== undefined ? v.h : n.drawH) * 100) / 100;
    }
  }

  function onKey(e) {
    if (!S.selected) return;
    if (/input|select|textarea/i.test(e.target.tagName)) return;
    const step = e.shiftKey ? 10 : 1;
    const n = S.byId.get(S.selected);
    const v = S.pending.get(n.id) || {};
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    v.x = (v.x !== undefined ? v.x : n.x) + dx;
    v.y = (v.y !== undefined ? v.y : n.y) + dy;
    S.pending.set(n.id, v);
    refreshNode(n);
    renderChanges();
    renderInspector();
  }

  /* ───────── 改动 / 保存 ───────── */

  function editsArray() {
    return [...S.pending.entries()].map(([id, v]) => Object.assign({ id }, v));
  }

  function renderChanges() {
    const n = S.pending.size;
    $('#changeCount').textContent = String(n);
    $('#changeCount').className = 'chip' + (n ? ' hot' : '');
    const btn = $('#saveBtn');
    btn.disabled = !n || !S.roots[S.root] || !S.roots[S.root].writable;
    btn.textContent = n ? `${tr("保存 ")}${n}` : '保存 0';
    if (n && !S.roots[S.root].writable) btn.textContent = '只读目录';

    const list = $('#changeList');
    list.style.display = n ? 'block' : 'none';
    list.innerHTML = '';
    for (const [id, v] of S.pending) {
      const node = S.byId.get(id);
      if (!node) continue;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:1px 0';
      const a = el('span', 'idc', node.name);
      a.style.minWidth = '150px';
      row.appendChild(a);
      const parts = [];
      if (v.x !== undefined && v.x !== node.x) parts.push(`x ${node.x} → ${v.x}`);
      if (v.y !== undefined && v.y !== node.y) parts.push(`y ${node.y} → ${v.y}`);
      if (v.w !== undefined) parts.push(`w ${Math.round(node.drawW)} → ${v.w}${node.sizeInferred ? '（新增 size）' : ''}`);
      if (v.h !== undefined) parts.push(`h ${Math.round(node.drawH)} → ${v.h}`);
      row.appendChild(el('span', '', parts.join('   ')));
      list.appendChild(row);
    }
  }

  function discardAll() {
    S.pending.clear();
    renderStage();
    renderChanges();
    renderInspector();
    $('#diffBox').style.display = 'none';
    toast('已撤销全部改动');
  }

  async function showDiff() {
    if (!S.pending.size) return toast('没有待保存的改动');
    try {
      const r = await api('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: S.root, file: S.file, edits: editsArray() }),
      });
      showDiffBox(r.diff);
      if (!r.guard.ok) toast(tr('守卫失败:') + r.guard.message, true);
    } catch (e) { toast(tr('预览失败:') + e.message, true); }
  }

  function showDiffBox(diff) {
    const box = $('#diffBox');
    box.style.display = 'block';
    box.innerHTML = (diff || '(无差异)')
      .split('\n')
      .map((l) => {
        const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (l.startsWith('+')) return '<span class="add">' + esc + '</span>';
        if (l.startsWith('-')) return '<span class="del">' + esc + '</span>';
        return esc;
      })
      .join('\n');
  }

  /** 联动结果单独说清楚,否则用户会以为"保存成功 = 游戏里生效了" */
  function reportXy(xy) {
    if (!xy || !xy.length) return;
    const box = $('#diffBox');
    const lines = [];
    let blocked = 0;
    for (const p of xy) {
      if (p.written) {
        lines.push(`${tr("+ 联动写入 ")}${p.rootName}:${p.file}(${p.details.length}${tr(" 处)")}`);
      } else {
        blocked++;
        lines.push(`${tr("- 联动未写入 ")}${p.rootName}:${p.file} — ${p.reason || '未知原因'}`);
        for (const w of p.warnings || []) lines.push(`-   ${w}`);
      }
    }
    box.innerHTML +=
      '\n' +
      lines
        .map((l) => {
          const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return l.startsWith('+') ? `<span class="add">${esc}</span>` : `<span class="del">${esc}</span>`;
        })
        .join('\n');
    if (blocked) {
      toast(
        `${tr("已保存,但 ")}${blocked}${tr(" 处联动未写入:元素位置被脚本变量控制,拖拽在游戏里不生效")}`,
        true,
      );
    }
  }

  async function save() {
    if (!S.pending.size) return;
    const btn = $('#saveBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 默认带上联动:scripted_gui 的 properties 若覆写了坐标,只改 .gui 是无效的。
        // 动态绑定(变量/表达式)会被服务端拦下,不会误写。
        body: JSON.stringify({ root: S.root, file: S.file, edits: editsArray(), syncXy: true }),
      });
      if (!r.written) {
        showDiffBox(r.diff);
        toast(r.guard.ok ? '守卫未通过,已取消写入' : tr('守卫失败:') + r.guard.message, !r.guard.ok);
        return;
      }
      if (r.warnings && r.warnings.length) toast(tr('已保存,但有警告:') + r.warnings.join('; '), true);
      else toast(`${tr("已保存 ")}${r.details.length}${tr(" 处改动 · 备份 ")}${r.backup}`);
      showDiffBox(r.diff);
      reportXy(r.xy);
      const keep = S.selected;
      S.pending.clear();
      await loadFile(S.root, S.file);
      if (keep) select(keep);
    } catch (e) {
      toast(tr('保存失败:') + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  boot().catch((e) => toast(tr('初始化失败:') + e.message, true));
})();
