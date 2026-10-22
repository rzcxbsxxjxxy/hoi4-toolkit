/* HOI4 GUI 工作台 —— 设置页(SETTINGS_V1)
 *
 * 职责:
 *   1) 基础游戏目录:自动探测 + 手填;
 *   2) 模组文件夹:增 / 删 / 改,通过读取目录下 .mod 确认确实是模组并显示元信息;
 *   3) 显示选项:默认贴图 / 名称 / 吸附网格 / 缩放。
 *
 * 模组身份判据(与后端一致):**目录下存在 .mod 文件即视为模组**。
 * 无 .mod 时退化为结构推断(有 interface/ 或 common/),标记为「推断」提醒人工确认。
 *
 * 所有写入都走 POST /api/settings —— 后端负责持久化到 gui-settings.json
 * 并重建 ROOTS,前端不直接碰文件系统。
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
    base: '',
    mods: [],          // {path, enabled}[] —— 模组目录 + 启用开关 (MOD_TOGGLE_V1)
    probe: {},         // path -> ModInfo 探测结果缓存
    ws: [],            // 创意工坊扫描结果
    gameVersion: '',
  };

  /** 兼容旧版 string[] 与后端 normalizeMods 的返回 */
  function toEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((m) =>
      typeof m === 'string' ? { path: m, enabled: true } : { path: m.path, enabled: m.enabled !== false },
    ).filter((m) => m && typeof m.path === 'string' && m.path);
  }
  const enabledCount = () => S.mods.filter((m) => m.enabled).length;

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
    const txt = await r.text();
    let j = {};
    try { j = txt ? JSON.parse(txt) : {}; } catch { j = {}; }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  const postJSON = (path, obj) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  /* ───────── 载入 ───────── */

  async function boot() {
    try {
      const cfg = await api('/api/settings');
      S.base = cfg.base || (cfg.current && cfg.current.base) || '';
      S.mods = toEntries(cfg.mods);
      S.gameVersion = cfg.gameVersion || '';
      applyDisplay(cfg.display || {});
      $('#base').value = S.base;
      renderMods();
      renderChips();
      renderCompScopes();
      if (S.base) checkBase(S.base, true);
      if (S.mods.length) probeAll();
    } catch (e) {
      toast('载入设置失败:' + e.message, true);
    }
  }

  function applyDisplay(d) {
    $('#d_showTex').checked = d.showTex !== false;
    $('#d_showNames').checked = !!d.showNames;
    $('#d_snap').checked = !!d.snap;
    $('#d_grid').value = d.grid || 5;
    $('#d_zoom').value = d.defaultZoom || 1;
  }

  function readDisplay() {
    return {
      showTex: $('#d_showTex').checked,
      showNames: $('#d_showNames').checked,
      snap: $('#d_snap').checked,
      grid: Math.max(1, parseInt($('#d_grid').value, 10) || 5),
      defaultZoom: Math.min(4, Math.max(0.1, parseFloat($('#d_zoom').value) || 1)),
    };
  }

  /* ───────── 基础游戏目录 ───────── */

  async function detect() {
    const btn = $('#detectBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '检测中…';
    try {
      const r = await api('/api/detect');
      const box = $('#candBox');
      box.innerHTML = '';
      const list = (r.candidates || []).slice();
      if (r.defaultBase) list.unshift(r.defaultBase);
      const uniq = [...new Set(list)];
      if (!uniq.length) {
        box.appendChild(el('div', 'empty', '未找到 HoI4 安装目录,请手动填写路径'));
        return;
      }
      const t = el('div', 'pane-title');
      t.style.cssText = 'padding:6px 0;font-size:12px;color:var(--ink2);font-weight:600';
      t.textContent = '检测到的候选目录(点击选用)';
      box.appendChild(t);
      for (const c of uniq) {
        const row = el('div', 'wrow');
        row.appendChild(el('div', 'wn', c));
        const use = el('button', 'link', '选用');
        use.onclick = () => { $('#base').value = c; checkBase(c, true); };
        row.appendChild(use);
        row.onclick = (e) => { if (e.target === use) return; $('#base').value = c; checkBase(c, true); };
        box.appendChild(row);
      }
      if (!$('#base').value && uniq.length) { $('#base').value = uniq[0]; checkBase(uniq[0], true); }
    } catch (e) {
      toast('检测失败:' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /** 就地校验一个游戏目录:有 interface/ + common/ 才算合法 */
  function checkBase(p, quiet) {
    const box = $('#baseStat');
    const path = (p || '').trim();
    if (!path) { box.className = 'status'; return; }
    const ok = /[\\/]interface([\\/]|$)/i.test(path) || /[\\/]common([\\/]|$)/i.test(path);
    // 只做启发式判断(前端拿不到 fs);真正的校验在保存时由后端做
    box.className = 'status on ' + (ok ? 'ok' : 'warn');
    box.textContent = ok
      ? '看起来是有效的 HoI4 安装目录。'
      : '该路径下未发现 interface/ 或 common/ —— 保存时后端会再校验一次。';
  }

  /* ───────── 模组探测 ───────── */

  async function probeAll() {
    if (!S.mods.length) return;
    try {
      const q = S.mods.map((m) => 'dir=' + encodeURIComponent(m.path)).join('&');
      const r = await api('/api/modinfo?' + q);
      S.gameVersion = r.gameVersion || S.gameVersion;
      for (const m of r.mods || []) S.probe[m.path] = m;
      renderMods();
      renderChips();
    } catch (e) {
      toast('模组信息读取失败:' + e.message, true);
    }
  }

  /** 手动添加:先探测,确认目录存在再加入 */
  async function addManual() {
    const inp = $('#manual');
    let dir = inp.value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!dir) { toast('请输入模组文件夹路径', true); return; }
    const btn = $('#manualBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '探测中…';
    try {
      const r = await api('/api/modinfo?dir=' + encodeURIComponent(dir));
      S.gameVersion = r.gameVersion || S.gameVersion;
      const info = (r.mods || [])[0];
      if (!info || !info.exists) {
        setModStat('bad', '目录不存在:' + dir);
        toast('目录不存在:' + dir, true);
        return;
      }
      dir = info.path || dir;
      if (S.mods.some((m) => m.path.toLowerCase() === dir.toLowerCase())) {
        setModStat('warn', '该模组已在列表中');
        return;
      }
      S.probe[dir] = info;
      S.mods.push({ path: dir, enabled: true });
      inp.value = '';
      renderMods();
      renderChips();
      // 明确提示判据来源,避免"为什么它没被认出来"
      if (!info.hasModFile) {
        setModStat('warn', `「${info.name || dir}」目录下没有 .mod 文件,已按目录结构(inferred)推断为模组 —— 请确认路径正确。`);
      } else {
        setModStat('ok', `已添加「${info.name}」(${info.modFile || '.mod'}),已启用`);
      }
    } catch (e) {
      toast('探测失败:' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function removeMod(i) {
    const p = S.mods[i].path;
    S.mods.splice(i, 1);
    delete S.probe[p];
    renderMods();
    renderChips();
  }

  /** 启用/关闭开关 —— 关闭的模组不进 ROOTS,不参与索引与渲染,但配置保留。 */
  function toggleMod(i) {
    const m = S.mods[i];
    m.enabled = !m.enabled;
    const info = S.probe[m.path] || {};
    const name = info.name || m.path.split('/').pop();
    renderMods();
    renderChips();
    setModStat(
      m.enabled ? 'ok' : 'warn',
      m.enabled
        ? `已启用「${name}」—— 保存并应用后生效`
        : `已关闭「${name}」—— 它不会参与界面索引与渲染(配置仍保留),保存并应用后生效`,
    );
  }

  /** 批量开关 */
  function setAllMods(on) {
    S.mods.forEach((m) => { m.enabled = on; });
    renderMods();
    renderChips();
    setModStat(
      on ? 'ok' : 'warn',
      on ? `已启用全部 ${S.mods.length} 个模组 —— 保存并应用后生效`
         : `已关闭全部 ${S.mods.length} 个模组 —— 工作台将只读 vanilla,保存并应用后生效`,
    );
  }

  /** 改路径:复用手动添加的探测流程,替换掉原来那一项 */
  function editMod(i) {
    const old = S.mods[i].path;
    const next = prompt('修改模组文件夹路径:', old);
    if (next === null) return;
    const dir = next.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!dir || dir === old) { renderMods(); return; }
    if (S.mods.some((m, k) => k !== i && m.path.toLowerCase() === dir.toLowerCase())) {
      setModStat('warn', '该路径已在列表中');
      return;
    }
    api('/api/modinfo?dir=' + encodeURIComponent(dir))
      .then((r) => {
        const info = (r.mods || [])[0];
        if (!info || !info.exists) { setModStat('bad', '新路径不存在:' + dir); return; }
        delete S.probe[old];
        S.probe[info.path || dir] = info;
        S.mods[i].path = info.path || dir;
        renderMods();
        renderChips();
        setModStat('ok', '路径已更新');
      })
      .catch((e) => toast('修改失败:' + e.message, true));
  }

  function renderMods() {
    const box = $('#modList');
    box.innerHTML = '';
    if (!S.mods.length) {
      box.appendChild(el('div', 'empty', '尚未添加模组。可点「扫描创意工坊」批量选择,或在下方手动填写路径。'));
      return;
    }
    S.mods.forEach((entry, i) => {
      const p = entry.path;
      const on = entry.enabled !== false;
      const info = S.probe[p] || {};
      const row = el('div', 'mod' + (info.exists === false ? ' bad' : on ? '' : ' off'));

      const sw = el('label', 'sw');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.title = on ? '点击关闭该模组' : '点击启用该模组';
      cb.onchange = () => { entry.enabled = cb.checked; toggleMod(i); };
      sw.appendChild(cb);
      sw.appendChild(el('span', 'track'));
      sw.appendChild(el('span', 'lbl', on ? '已启用' : '已关闭'));
      row.appendChild(sw);

      const mi = el('div', 'mi');
      const mt = el('div', 'mt');
      mt.appendChild(el('b', null, info.name || p.split('/').pop()));

      if (info.exists === false) {
        mt.appendChild(el('span', 'tag bad', '路径不存在'));
      } else if (info.hasModFile) {
        mt.appendChild(el('span', 'tag mod', info.modFile || '.mod'));
      } else {
        mt.appendChild(el('span', 'tag warn', '无 .mod · 结构推断'));
      }
      if (!on) mt.appendChild(el('span', 'tag off', '不参与索引'));
      if (typeof info.guiCount === 'number') {
        mt.appendChild(el('span', 'tag ' + (info.guiCount > 0 ? 'ok' : ''), '已改界面 ' + info.guiCount + ' 个 .gui'));
      }
      if (info.hasInterface === false && info.exists !== false) {
        mt.appendChild(el('span', 'tag', '无 interface/'));
      }
      if (info.versionOk === true) mt.appendChild(el('span', 'tag ok', '版本兼容'));
      else if (info.versionOk === false) mt.appendChild(el('span', 'tag bad', '版本不匹配 ' + (info.supportedVersion || '')));
      if (info.version) mt.appendChild(el('span', 'tag', 'v' + info.version));
      if (info.stalePath) mt.appendChild(el('span', 'tag warn', '.mod 内 path= 指向作者本机,已忽略'));
      mi.appendChild(mt);
      mi.appendChild(el('div', 'mp', p));
      row.appendChild(mi);

      const acts = el('div', 'acts');
      const bEdit = el('button', null, '更改');
      bEdit.onclick = () => editMod(i);
      const bDel = el('button', 'danger', '删除');
      bDel.onclick = () => removeMod(i);
      acts.appendChild(bEdit);
      acts.appendChild(bDel);
      row.appendChild(acts);
      box.appendChild(row);
    });

    // 汇总 + 批量开关
    const nOn = enabledCount();
    const nOff = S.mods.length - nOn;
    const sum = el('div', 'modsum');
    sum.appendChild(el('span', null,
      '共 ' + S.mods.length + ' 个模组 · 启用 ' + nOn + ' 个' + (nOff ? ' · 关闭 ' + nOff + ' 个' : '')));
    if (S.mods.length) {
      const bAll = el('button', null, '全部启用');
      bAll.onclick = () => setAllMods(true);
      const bNone = el('button', null, '全部关闭');
      bNone.onclick = () => setAllMods(false);
      sum.appendChild(bAll);
      sum.appendChild(bNone);
    }
    box.appendChild(sum);
  }

  function setModStat(kind, msg) {
    const s = $('#modStat');
    s.className = 'status on ' + kind;
    s.textContent = msg;
  }

  /* ───────── 创意工坊 ───────── */

  async function scanWorkshop() {
    const btn = $('#scanWsBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '扫描中…';
    $('#wsBox').style.display = 'block';
    $('#wsList').innerHTML = '<div class="empty"><span class="spin"></span> 正在扫描 Steam 创意工坊…</div>';
    try {
      const r = await api('/api/workshop');
      S.ws = r.mods || [];
      S.gameVersion = r.gameVersion || S.gameVersion;
      renderChips();
      renderWs();
    } catch (e) {
      $('#wsList').innerHTML = '';
      $('#wsList').appendChild(el('div', 'empty', '扫描失败:' + e.message));
      toast('扫描失败:' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function renderWs() {
    const box = $('#wsList');
    box.innerHTML = '';
    if (!S.ws.length) {
      box.appendChild(el('div', 'empty', '未找到创意工坊模组。确认 Steam 已登录且 HoI4 创意工坊已订阅过内容。'));
      return;
    }
    const chosen = new Set(S.mods.map((m) => m.path.toLowerCase()));
    for (const m of S.ws) {
      const on = chosen.has((m.path || '').toLowerCase());
      const row = el('div', 'wrow' + (on ? ' on' : ''));
      const n = el('div', 'wn');
      n.appendChild(el('b', null, m.name || m.id));
      if (m.hasModFile) n.appendChild(el('span', 'tag mod', ' .mod'));
      else n.appendChild(el('span', 'tag warn', ' 推断'));
      if (m.guiCount > 0) n.appendChild(el('span', 'tag ok', ' ' + m.guiCount + ' .gui'));
      if (m.versionOk === false) n.appendChild(el('span', 'tag bad', ' 版本不匹配'));
      if (on) {
        const e = S.mods.find((x) => x.path.toLowerCase() === (m.path || '').toLowerCase());
        if (e && e.enabled === false) n.appendChild(el('span', 'tag off', ' 已关闭'));
      }
      row.appendChild(n);
      row.appendChild(el('div', 'wg', m.id));
      row.onclick = () => {
        const p = m.path;
        const k = S.mods.findIndex((x) => x.path.toLowerCase() === p.toLowerCase());
        if (k >= 0) { S.mods.splice(k, 1); delete S.probe[p]; }
        else { S.mods.push({ path: p, enabled: true }); S.probe[p] = m; }
        renderMods();
        renderWs();
        renderChips();
      };
      box.appendChild(row);
    }
  }

  /* ───────── 保存 ───────── */

  async function save() {
    const base = $('#base').value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!base) { toast('基础游戏目录为必填项', true); return; }
    const btn = $('#saveBtn');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '保存中…';
    try {
      const r = await postJSON('/api/settings', { base, mods: S.mods, display: readDisplay() });
      // 外观不随工程配置走,单独持久化到本机
      if (AP) AP.saveAppearance(A);
      S.base = base;
      S.mods = toEntries(r.mods || S.mods);
      const nOn = enabledCount();
      const nOff = S.mods.length - nOn;
      renderMods();
      renderChips();

      const warn = r.warnNoInterface || [];
      const dis = r.disabled || [];
      if (!nOn) {
        // 一个都没启用 = 只读 vanilla,这是合法但容易误操作的状态,必须显式说清
        setModStat('warn', '已保存。当前所有模组均已关闭 —— 工作台只索引 vanilla 界面。');
        toast('已保存,但所有模组都已关闭:工作台现在只读 vanilla', false);
      } else if (warn.length || dis.length) {
        const bits = [];
        if (dis.length) bits.push(dis.length + ' 个模组已关闭(不参与索引)');
        if (warn.length) bits.push(warn.length + ' 个没有 interface/ 目录');
        setModStat('ok', '已保存并应用 ·启用 ' + nOn + ' 个。注:' + bits.join('、'));
        toast('已保存并应用(' + bits.join('、') + ')', false);
      } else {
        setModStat('ok', '已保存并应用 · 启用 ' + nOn + ' 个模组。');
        toast('设置已保存并应用', false);
      }
    } catch (e) {
      toast('保存失败:' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function renderChips() {
    const c = $('#verChip');
    const parts = [];
    if (S.gameVersion) parts.push('游戏版本 ' + S.gameVersion);
    const nOn = enabledCount();
    const nOff = S.mods.length - nOn;
    parts.push(nOff ? nOn + ' 个模组启用 / ' + nOff + ' 关闭' : S.mods.length + ' 个模组');
    c.textContent = parts.join(' · ');
  }

  /* ───────── IDE 自动补全范围(存本机浏览器,不进工程配置)─────────
   * 与 settings 的外观同理:这是"我这台机器上编辑器怎么补全",不是工程配置。 */
  const COMP_SCOPES = [
    { id: 'official', label: '官方文档(effect/trigger/scope)' },
    { id: 'common', label: 'common 目录定义(单位/国策/idea…)' },
    { id: 'scripted_effect', label: 'scripted_effects' },
    { id: 'scripted_trigger', label: 'scripted_triggers' },
    { id: 'loc', label: '本地化键(loc)' },
    { id: 'gfx', label: '图标名(GFX_)' },
    { id: 'gui', label: 'GUI 元素 / 脚本GUI' },
  ]
  function loadCompScopes() {
    try {
      const v = JSON.parse(localStorage.getItem('gui.compScopes') || '')
      if (Array.isArray(v) && v.length) return v
    } catch {}
    return COMP_SCOPES.map((s) => s.id)
  }
  function renderCompScopes() {
    const box = $('#compScopeBox')
    if (!box) return
    const sel = new Set(loadCompScopes())
    box.innerHTML = ''
    COMP_SCOPES.forEach((s) => {
      const o = el('div', 'opt')
      const cb = el('input'); cb.type = 'checkbox'; cb.id = 'cs_' + s.id; cb.checked = sel.has(s.id)
      cb.onchange = () => {
        const cur = new Set(loadCompScopes())
        if (cb.checked) cur.add(s.id); else cur.delete(s.id)
        // 至少保留一个,否则补全彻底失效
        if (cur.size === 0) { cb.checked = true; cur.add(s.id); toast('至少保留一个补全来源', true); }
        localStorage.setItem('gui.compScopes', JSON.stringify([...cur]))
      }
      o.appendChild(cb)
      const lab = el('label', null, s.label)
      lab.setAttribute('for', 'cs_' + s.id)
      o.appendChild(lab)
      box.appendChild(o)
    })
  }

  /* ───────── 快捷键自定义(KEYMAP_V1)─────────
   *
   * 数据源是 /keymap.js 那份声明式目录(全站唯一),所以这一页能看到
   * **所有页面**的快捷键,而不只是设置页自己运行时注册过的那几个。
   * 覆盖表写 localStorage['gui.keymap'],各页下次加载时由 Keys.bind 读走。
   */
  let kmRecording = null; // 正在录制的动作 id

  function kmStyle() {
    if (document.getElementById('kmStyle')) return;
    const s = document.createElement('style');
    s.id = 'kmStyle';
    s.textContent = [
      '.km-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.km-top .sp{flex:1}',
      '.km-hint{color:var(--ink3);font-size:12px}',
      '.km-warn{color:var(--danger);background:var(--danger-soft);border:1px solid var(--danger-soft);',
      'border-radius:5px;padding:3px 9px;font-size:12px}',
      '.km-pg{margin:12px 0 4px;display:flex;align-items:baseline;gap:8px}',
      '.km-pg b{color:var(--ink)}',
      '.km-pg span{color:var(--ink3);font-size:12px}',
      '.km-list{border:1px solid var(--line2);border-radius:7px;overflow:hidden}',
      '.km-r{display:flex;align-items:center;gap:10px;padding:6px 10px;border-top:1px solid var(--line2)}',
      '.km-r:first-child{border-top:0}',
      '.km-r:nth-child(even){background:var(--inset)}',
      '.km-r.hit{box-shadow:inset 3px 0 0 var(--accent)}',
      '.km-d{flex:1;min-width:0;color:var(--ink)}',
      '.km-d i{color:var(--ink3);font-style:normal;font-size:11.5px;margin-left:6px}',
      '.km-k{font:inherit;min-width:150px;text-align:center;cursor:pointer;',
      'background:var(--panel);border:1px solid var(--line2);border-radius:5px;padding:3px 8px;color:var(--ink2)}',
      '.km-k:hover{border-color:var(--accent)}',
      '.km-k.on{border-color:var(--accent);background:var(--accent-soft);color:var(--ink)}',
      '.km-k.off{color:var(--ink3);opacity:.6;font-style:italic}',
      '.km-x{background:none;border:0;color:var(--ink3);cursor:pointer;padding:2px 5px;font-size:12px}',
      '.km-x:hover{color:var(--accent)}',
      '.km-x:disabled{opacity:.3;cursor:default}',
      '.km-c{color:var(--danger);font-size:11.5px;min-width:0;max-width:190px}',
      ':root[data-bg="image"] .km-r:nth-child(even){background:var(--glass-raise)}',
    ].join('');
    document.head.appendChild(s);
  }

  function kmKeyText(id) {
    const ks = window.Keymap.keysOf(id);
    if (!ks.length) return '已禁用';
    return ks.map((k) => window.Keys.pretty(k)).join('  /  ');
  }

  function renderKeymap() {
    kmStyle();
    const top = $('#keymapTop');
    const box = $('#keymapBox');
    if (!top || !box) return;
    const KM = window.Keymap;

    /* 顶部状态条:自定义数量 + 全部重置 + 导出/导入 */
    top.innerHTML = '';
    const cnt = KM.customCount();
    const info = el('span', 'km-hint', cnt ? ('已自定义 ' + cnt + ' 项') : '当前全部为默认键位');
    top.appendChild(info);
    const conf = KM.allConflicts();
    if (conf.length) top.appendChild(el('span', 'km-warn', '⚠ ' + conf.length + ' 项与其它动作撞键'));
    top.appendChild(el('span', 'sp'));
    const bReset = el('button', null, '全部恢复默认');
    bReset.disabled = !cnt;
    bReset.onclick = () => {
      if (!confirm('把所有自定义快捷键恢复成默认?')) return;
      KM.resetAll();
      renderKeymap();
      toast('已恢复全部默认键位');
    };
    top.appendChild(bReset);
    const bExp = el('button', null, '导出');
    bExp.onclick = () => {
      const txt = KM.exportMap();
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败,见控制台', true),
      );
      else toast('当前环境不支持剪贴板', true);
    };
    top.appendChild(bExp);
    const bImp = el('button', null, '导入');
    bImp.onclick = () => {
      const t = prompt('粘贴导出的 JSON(留空=取消):');
      if (!t) return;
      const r = KM.importMap(t);
      if (!r.ok) { toast('导入失败:' + r.reason, true); return }
      renderKeymap();
      toast('已导入 ' + r.applied + ' 项' + (r.unknown.length ? '(' + r.unknown.length + ' 项无法识别)' : ''));
    };
    top.appendChild(bImp);

    /* 按页分组列出动作 */
    box.innerHTML = '';
    KM.PAGES.forEach((p) => {
      const acts = KM.forPage(p.id);
      if (!acts.length) return;
      const h = el('div', 'km-pg');
      h.appendChild(el('b', null, p.name));
      h.appendChild(el('span', null, p.hint + ' · ' + acts.length + ' 项'));
      box.appendChild(h);
      const list = el('div', 'km-list');
      // 保持目录声明顺序(已按 分组 → 动作 排好),不再按字母重排,
      // 否则"查找/视图/选中"的语义分组会被打散。
      acts.forEach((a) => {
        const ks = KM.keysOf(a.id);
        const r = el('div', 'km-r' + (KM.isCustom(a.id) ? ' hit' : ''));
        const d = el('div', 'km-d');
        d.appendChild(document.createTextNode(KM.descOf(a, p.id)));
        const dflt = KM.defaultKeysOf(a.id).map((k) => window.Keys.pretty(k)).join(' / ');
        if (KM.isCustom(a.id) && dflt) d.appendChild(el('i', null, '默认 ' + dflt));
        r.appendChild(d);

        const b = el('button', 'km-k' + (ks.length ? '' : ' off'));
        b.textContent = kmRecording === a.id ? '按下新组合键…' : kmKeyText(a.id);
        if (kmRecording === a.id) b.classList.add('on');
        b.onclick = () => { kmRecording = kmRecording === a.id ? null : a.id; renderKeymap() };
        r.appendChild(b);

        const cf = KM.conflictsOf(a.id);
        if (cf.length) {
          const names = cf.map((c) => KM.descOf(KM.byId(c.id), c.page) + '(' + c.page + ')').join('、')
          r.appendChild(el('span', 'km-c', '⚠ 与「' + names + '」同键'));
        }

        const x = el('button', 'km-x', KM.isCustom(a.id) ? '清除' : '—');
        x.disabled = !KM.isCustom(a.id)
        x.title = KM.isCustom(a.id) ? '恢复这一项的默认键位' : '未自定义'
        x.onclick = () => {
          if (kmRecording === a.id) kmRecording = null;
          KM.reset(a.id);
          renderKeymap();
          toast('已恢复「' + KM.descOf(a, p.id) + '」的默认键位');
        }
        r.appendChild(x);
        list.appendChild(r);
      });
      box.appendChild(list);
    });
  }

  /* 录制态:捕获下一次按键。归一化复用 Keys.fromEvent ——
   * 绝不能在这里自己拼字符串,否则存进去的组合会与框架认的组合不一致
   * (最典型:F1 变成 f1?方向键存成 arrowup 而框架只认 up)。 */
  function kmRecKey(e) {
    if (e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    e.stopPropagation()
    if (!kmRecording) return
    if (e.key === 'Escape') { kmRecording = null; renderKeymap(); return }
    const combo = window.Keys.fromEvent(e)
    if (!combo) { toast('这个键无法识别,请换一个', true); return }
    const id = kmRecording
    kmRecording = null
    const r = window.Keymap.set(id, combo)
    if (!r.ok) { toast('保存失败:' + r.reason, true); renderKeymap(); return }
    renderKeymap()
    const desc = window.Keymap.descOf(window.Keymap.byId(id), window.Keymap.pageOf(id))
    if (r.conflict.length) {
      const others = r.conflict.map((c) => window.Keymap.descOf(window.Keymap.byId(c.id), c.page)).join('、')
      toast('已改为 ' + window.Keys.pretty(combo) + ',但与「' + others + '」在 ' + r.conflict[0].page + ' 页撞键', true)
    } else {
      toast('「' + desc + '」已改为 ' + window.Keys.pretty(combo) + ',业务页刷新后生效')
    }
  }

  function bootKeymap() {
    if (!window.Keymap || !window.Keys || !$('#keymapBox')) return;
    renderKeymap();
    // 捕获阶段 + preventDefault:录制时不能有任何页面逻辑抢先处理这个键
    document.addEventListener('keydown', kmRecKey, true)
    // F1 在录制态已被吃掉,速查表不会误弹
    if (location.hash === '#keymap') {
      const card = $('#keymap');
      if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }

  /* ───────── 外观:主题 / 强调色 / 图标(APPEARANCE_V1)─────────
   *
   * 存在 localStorage,不进 gui-settings.json —— 它是"这台机器上这个浏览器怎么看",
   * 不是工程配置,混进工程配置会在多人协作时互相覆盖对方的配色。
   * 应用动作由 appearance.js 完成,nav.js 在每页挂载时都会调一次,所以全站同步。
   */
  let AP = null;
  let A = { theme: 'light', accent: '', icon: 'hoi4' };
  // ↑ 只是兜底初值;bootAppearance 立刻用 AP.loadAppearance() 的完整对象覆盖。
  //   滑条字段(glassA/bgDim/bgBlur)为 null 表示"跟随主题默认",与 appearance.js 一致。

  const THEME_SWATCH = {
    light: ['#f6f7f9', '#ffffff', '#2b6cb0'],
    dark: ['#14181f', '#1b212a', '#5b9cf0'],
    midnight: ['#0f1420', '#151c2b', '#4f8ef7'],
    sand: ['#f4f1ea', '#fffdf8', '#a8642a'],
  };

  async function bootAppearance() {
    // settings.js 是经典脚本,用动态 import 拿 ES 模块
    AP = await import('/appearance.js');
    A = AP.loadAppearance();
    renderAppearance();
    wireLocalImages();
    wireGlassTune();
  }

  /* ── GLASS_TUNE:壁纸半透明的三条调节 ──
   * 范围与 theme-vars.css 的 GLASS_RANGE 一致,别在这里放宽:
   *   玻璃 30%~75%(30% 是文字可读下限,75% 是"等于没开壁纸")
   *   压暗 0~80%,模糊 0~24px
   * 值存 appearance(见 appearance.js 的 numOrNull),null = 跟随主题默认。
   * ⚠ 拖动时只 applyAppearance 实时预览,不落盘 —— 与本页其它控件一致,
   *   统一由底部「保存并应用」持久化。 */
  const TUNE = {
    glass: { el: '#tGlass', val: '#tGlassV', key: 'glassA', min: 30, max: 75, scale: 100, unit: '%', defText: '主题默认' },
    /* def 必须与 theme-vars.css 各主题的 --bg-dim 兜底值一致。
     *   2026-10-07 起默认不再是 0 —— 深色壁纸上不压暗会让文字糊掉。*/
    dim: { el: '#tDim', val: '#tDimV', key: 'bgDim', min: 0, max: 80, scale: 100, unit: '%', def: 18, defText: '主题默认' },
    blur: { el: '#tBlur', val: '#tBlurV', key: 'bgBlur', min: 0, max: 24, scale: 1, unit: 'px', def: 0, defText: '主题默认' },
  };

  function wireGlassTune() {
    for (const t of Object.values(TUNE)) {
      const inp = $(t.el);
      const out = $(t.val);
      if (!inp || !out) continue;
      inp.addEventListener('input', () => {
        const n = Number(inp.value);
        // 玻璃按百分比存,压暗/模糊按原值 —— 与 appearance.js 的夹紧范围对应
        A[t.key] = t.scale === 100 ? n / 100 : n;
        out.textContent = n + t.unit;
        AP.applyAppearance(A);
      });
    }
    const rst = $('#tReset');
    if (rst) rst.onclick = () => {
      A.glassA = null; A.bgDim = null; A.bgBlur = null;
      AP.applyAppearance(A);
      renderAppearance();
    };
    syncTuneInputs();
  }

  /** 把 A 里的值回填到滑条(渲染时统一调,避免与 renderAppearance 打架) */
  function syncTuneInputs() {
    const hasBg = !!A.bgImage;
    const row = $('#tuneRow');
    if (row) row.classList.toggle('off', !hasBg);
    for (const t of Object.values(TUNE)) {
      const inp = $(t.el);
      const out = $(t.val);
      if (!inp || !out) continue;
      const cur = A[t.key];
      if (cur === null || cur === undefined) {
        // 没设值:滑条停在该主题的默认档,读数显示"主题默认"
        inp.value = String(t.def === undefined ? t.min : t.def);
        out.textContent = t.defText;
      } else {
        const n = t.scale === 100 ? Math.round(cur * 100) : cur;
        inp.value = String(n);
        out.textContent = n + t.unit;
      }
    }
  }

  function renderAppearance() {
    const tp = $('#themePick');
    tp.innerHTML = '';
    AP.THEMES.forEach((t) => {
      const b = el('div', 'thm' + (A.theme === t.id ? ' on' : ''));
      b.appendChild(el('div', 'n', t.name));
      b.appendChild(el('div', 'd', t.desc));
      const sw = el('div', 'sw');
      (THEME_SWATCH[t.id] || THEME_SWATCH.light).forEach((c) => {
        const i = document.createElement('i');
        i.style.background = c;
        sw.appendChild(i);
      });
      b.appendChild(sw);
      b.onclick = () => { A.theme = t.id; AP.applyAppearance(A); renderAppearance(); };
      tp.appendChild(b);
    });

    const ap = $('#accentPick');
    ap.innerHTML = '';
    AP.ACCENTS.forEach((c) => {
      const b = el('button', 'swc' + ((A.accent || '') === c.id ? ' on' : ''));
      b.style.background = c.color;
      b.title = c.name;
      b.onclick = () => { A.accent = c.id; AP.applyAppearance(A); renderAppearance(); };
      ap.appendChild(b);
    });

    /* UI_SLIM_V1:紧凑 / 宽松。密度变量在 theme-vars.css,这里只负责写属性。 */
    const dp = $('#densityPick');
    if (dp) {
      dp.innerHTML = '';
      [['compact', '紧凑'], ['loose', '宽松']].forEach(([id, nm]) => {
        const b = el('button', 'segbtn' + ((A.density || 'compact') === id ? ' on' : ''), nm);
        b.onclick = () => { A.density = id; AP.applyAppearance(A); renderAppearance(); };
        dp.appendChild(b);
      });
    }

    const ip = $('#iconPick');
    ip.innerHTML = '';
    AP.ICONS.forEach((ic) => {
      const b = el('button', 'ic' + (A.icon === ic.id ? ' on' : ''));
      const img = document.createElement('img');
      // HOI4 徽标预设是游戏本体的位图(/api/appicon),不是矢量 glyph
      img.src = ic.id === 'hoi4' ? '/api/appicon' : AP.iconSvg(ic.id, A.accent || '#2b6cb0');
      img.alt = ic.name;
      b.appendChild(img);
      b.title = ic.name;
      b.onclick = () => { A.icon = ic.id; AP.applyAppearance(A); renderAppearance(); };
      ip.appendChild(b);
    });

    // 滑条读数跟着 A 走(切主题时"主题默认"的含义变了,滑条位置要重算)
    if (typeof syncTuneInputs === 'function') syncTuneInputs();
  }

  /* ── 本地图片:背景图 + 图标图 ──
   * 选图后用 canvas 等比缩放到合理尺寸再转 data URI,避免把几 MB 的原图塞进
   * localStorage(约 5MB 上限)把存储撑爆。背景上限 1920px、图标上限 128px。*/
  function readImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('未选择文件')); return; }
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('读取失败'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('不是有效图片'));
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          const s = Math.min(1, maxDim / Math.max(w, h));
          if (s < 1) { w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s)); }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          try { resolve(cv.toDataURL('image/jpeg', quality || 0.85)); }
          catch (e) { reject(e); }
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function syncImgControls() {
    const bgT = $('#bgThumb'), bgS = $('#bgSet'), bgC = $('#bgClear');
    if (A.bgImage) {
      bgT.style.backgroundImage = 'url("' + A.bgImage + '")';
      bgT.classList.remove('hide'); bgS.classList.remove('hide'); bgC.classList.remove('hide');
    } else {
      bgT.style.backgroundImage = ''; bgT.classList.add('hide'); bgS.classList.add('hide'); bgC.classList.add('hide');
    }
    const icT = $('#icThumb'), icS = $('#icSet'), icC = $('#icClear');
    if (A.iconImage) {
      icT.style.backgroundImage = 'url("' + A.iconImage + '")';
      icT.classList.remove('hide'); icS.classList.remove('hide'); icC.classList.remove('hide');
    } else {
      icT.style.backgroundImage = ''; icT.classList.add('hide'); icS.classList.add('hide'); icC.classList.add('hide');
    }
    // 壁纸有/无会决定调节条是否可用(没壁纸时调了看不出效果)
    if (typeof syncTuneInputs === 'function') syncTuneInputs();
  }

  function wireLocalImages() {
    $('#bgFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { A.bgImage = await readImage(f, 1920, 0.82); AP.applyAppearance(A); syncImgControls(); }
      catch (err) { toast('背景图读取失败:' + err.message, true); }
    });
    $('#bgClear').addEventListener('click', () => { A.bgImage = ''; AP.applyAppearance(A); syncImgControls(); });
    $('#icFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { A.iconImage = await readImage(f, 128, 0.92); AP.applyAppearance(A); syncImgControls(); }
      catch (err) { toast('图标图读取失败:' + err.message, true); }
    });
    $('#icClear').addEventListener('click', () => { A.iconImage = ''; AP.applyAppearance(A); syncImgControls(); });
    syncImgControls();
  }

  /* ───────── 绑定 ───────── */

  $('#detectBtn').onclick = detect;
  $('#manualBtn').onclick = addManual;
  $('#manual').onkeydown = (e) => { if (e.key === 'Enter') addManual(); };
  $('#base').oninput = () => checkBase($('#base').value);
  $('#base').onblur = () => checkBase($('#base').value);
  $('#scanWsBtn').onclick = scanWorkshop;
  $('#saveBtn').onclick = save;
  $('#reloadBtn').onclick = boot;
  $('#resetBtn').onclick = () => {
    if (!S.mods.length) { toast('列表已经是空的'); return; }
    if (!confirm('确定清空模组列表吗?(不会删除任何文件,保存后生效)')) return;
    S.mods = [];
    S.probe = {};
    setModStat('warn', '已清空,点「保存并应用」生效。');
    renderMods();
    renderChips();
  };

  boot();
  bootAppearance();
  // 快捷键 UI 完全在前端(localStorage),不依赖 /api/settings ——
  // 必须独立启动,否则后端设置接口一失败,快捷键这一整块就跟着消失。
  bootKeymap();
})();
