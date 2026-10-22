/* open.js — 打开工程：基础游戏(判据 hoi4.exe) + 模组(判据 .mod)。
 *
 * ★ 判据改动(用户要求):
 *   基础游戏  ← 目录里存在 hoi4.exe(不再是 interface/ + common/)
 *   模组      ← 目录里存在 .mod 文件
 * 后端 /api/probe 一次可问多个路径,页面在这里统一发问并渲染徽标,
 * 前端不再自己猜"这目录像不像游戏"。
 */
(function () {
  var baseEl = document.getElementById('basePath');
  var modList = document.getElementById('modList');
  var candsEl = document.getElementById('cands');
  var statusEl = document.getElementById('status');
  var curEl = document.getElementById('current');
  var btn = document.getElementById('loadBtn');
  var autoEl = document.getElementById('autoload');
  var baseVerdict = document.getElementById('baseVerdict');
  var wsList = document.getElementById('wsList');

  var DEF_BASE = "C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV";
  var probeTimer = null;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ''; }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function loadMods() {
    var raw = get('gui.mods');
    if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e) {} }
    var one = get('gui.mod');
    return one ? [one] : [];
  }
  var mods = loadMods();
  baseEl.value = get('gui.base') || DEF_BASE;
  autoEl.checked = get('gui.autoload') === '1';

  /* ★ MODS_FROM_SERVER:模组列表以服务端 settings 为准,localStorage 只当兜底。
   *   以前只读 localStorage gui.mods,而首页「模组开关」(以及 run-gui.bat 的 --mod)
   *   加载的模组并不写进 localStorage —— 于是这一页显示"没挂任何模组",
   *   用户点一次「保存并进入工作台」就把 settings.mods 覆盖成空,模组静默消失。
   *   以服务端为准可让两页看到同一份清单,来回切不会互相清空。 */
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (j) {
    var list = (j && j.mods) || [];
    if (!list.length) return;
    var paths = list.map(function (m) { return m.path; }).filter(Boolean);
    if (!paths.length) return;
    // 已存在的路径不重复添加
    var have = {};
    mods.forEach(function (p) { if (p) have[String(p).replace(/[\\/]+$/, '').toLowerCase()] = 1; });
    var added = 0;
    paths.forEach(function (p) {
      var k = String(p).replace(/[\\/]+$/, '').toLowerCase();
      if (have[k]) return;
      addModRow(p);
      added++;
    });
    if (added) { sync(); }
    if (j.base && !get('gui.base')) baseEl.value = j.base;
    if (j.base) set('gui.base', j.base);
  }).catch(function () { /* 服务端不可达时沿用 localStorage,不阻断 */ });

  /* ── 探查:给一组路径,问后端它们各是什么 ── */
  function probe(paths, done) {
    if (!paths.length) { done({}); return; }
    var q = paths.map(function (p) { return 'path=' + encodeURIComponent(p); }).join('&');
    fetch('/api/probe?' + q).then(function (r) { return r.json(); }).then(function (j) {
      var m = {};
      (j.items || []).forEach(function (it) { m[it.path] = it; });
      done(m);
    }).catch(function () { done({}); });
  }

  function renderBaseVerdict(info) {
    baseVerdict.innerHTML = '';
    if (!info) return;
    if (!info.exists) { baseVerdict.appendChild(el('span', 'v bad', '目录不存在')); return; }
    baseVerdict.appendChild(el('span', info.hasExe ? 'v exe' : 'v bad', info.hasExe ? '✔ 含 ' + (info.exe || 'hoi4.exe') : '✘ 未找到 hoi4.exe'));
    if (info.hasInterface) baseVerdict.appendChild(el('span', 'v info', 'interface/'));
    if (info.hasCommon) baseVerdict.appendChild(el('span', 'v info', 'common/'));
  }

  function scheduleProbe() {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () {
      var paths = [baseEl.value.trim()].concat(collectMods()).filter(Boolean);
      probe(paths, function (m) {
        renderBaseVerdict(m[baseEl.value.trim()]);
        var rows = modList.querySelectorAll('.modrow');
        for (var i = 0; i < rows.length; i++) renderModVerdict(rows[i], m);
      });
    }, 350);
  }

  function renderModVerdict(row, m) {
    var v = row.querySelector('.verdict');
    var p = row.querySelector('input').value.trim();
    v.innerHTML = '';
    if (!p) return;
    var info = m[p];
    if (!info) return;
    if (!info.exists) { v.appendChild(el('span', 'v bad', '目录不存在')); return; }
    if (info.hasExe) { v.appendChild(el('span', 'v bad', '这是游戏目录,不是模组')); return; }
    v.appendChild(el('span', info.hasModFile ? 'v modf' : 'v info',
      info.hasModFile ? '✔ ' + (info.modFile || '.mod') : '无 .mod（推断为模组）'));
    if (info.name) v.appendChild(el('span', 'v info', info.name));
    if (info.supportedVersion) {
      v.appendChild(el('span', info.versionOk === false ? 'v bad' : 'v info', info.supportedVersion));
    }
  }

  /* ── 模组行 ── */
  function collectMods() {
    return [].slice.call(modList.querySelectorAll('input')).map(function (i) { return i.value.trim(); }).filter(Boolean);
  }
  function addModRow(v) {
    var row = el('div', 'modrow');
    var wrap = el('div');
    wrap.style.cssText = 'flex:1;min-width:0';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '模组目录路径（可留空或删除该行）';
    inp.value = v || '';
    inp.style.width = '100%';
    var vd = el('div', 'verdict');
    wrap.appendChild(inp); wrap.appendChild(vd);
    var browse = el('button', 'mini', '浏览…');
    browse.onclick = function () { pickDir(inp.value || '', function (p) { inp.value = p; sync(); scheduleProbe(); }); };
    var del = el('button', 'mini x', '移除');
    del.onclick = function () { row.remove(); sync(); };
    row.appendChild(wrap); row.appendChild(browse); row.appendChild(del);
    modList.appendChild(row);
    inp.oninput = function () { sync(); scheduleProbe(); };
    return inp;
  }
  function sync() { mods = collectMods(); }
  mods.forEach(function (m) { addModRow(m); });
  if (!mods.length) addModRow('');

  document.getElementById('addMod').onclick = function () {
    var inputs = modList.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { inputs[i].focus(); return; }
    addModRow('').focus();
  };
  baseEl.oninput = scheduleProbe;

  /* ── 目录选择器 ── */
  var mask = document.getElementById('mask');
  var pkPath = document.getElementById('pkPath');
  var pkList = document.getElementById('pkList');
  var pkSel = document.getElementById('pkSel');
  var pkCur = '';
  var pkDone = null;

  function pickDir(start, done) {
    pkDone = done;
    pkCur = start || '';
    mask.classList.add('show');
    browse(pkCur);
  }
  function browse(path) {
    pkCur = path;
    fetch('/api/browse?path=' + encodeURIComponent(path)).then(function (r) { return r.json(); }).then(function (j) {
      pkPath.textContent = j.path || '（计算机）';
      pkSel.textContent = j.path || '';
      pkList.innerHTML = '';
      if (j.error) { pkList.appendChild(el('div', 'd', j.error)); return; }
      (j.dirs || []).forEach(function (d) {
        var row = el('div', 'd');
        var nm = el('span', 'nm', d.name);
        row.appendChild(nm);
        if (d.isGame) row.appendChild(el('span', 'v exe', '✔ hoi4.exe'));
        else if (d.isMod) row.appendChild(el('span', 'v modf', '✔ .mod'));
        row.title = d.path;
        row.onclick = function () { browse(d.path); };
        pkList.appendChild(row);
      });
      if (!(j.dirs || []).length) pkList.appendChild(el('div', 'd', '（没有子目录）'));
    }).catch(function (e) {
      pkList.innerHTML = '';
      pkList.appendChild(el('div', 'd', '读取失败：' + e.message));
    });
  }
  document.getElementById('pkUp').onclick = function () {
    fetch('/api/browse?path=' + encodeURIComponent(pkCur)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.parent) browse(j.parent);
    });
  };
  document.getElementById('pkClose').onclick = function () { mask.classList.remove('show'); pkDone = null; };
  mask.onclick = function (e) { if (e.target === mask) { mask.classList.remove('show'); pkDone = null; } };
  document.getElementById('pkOk').onclick = function () {
    if (pkDone) pkDone(pkCur);
    mask.classList.remove('show'); pkDone = null;
  };

  /* ── 自动检测游戏目录 ── */
  function renderCands(list) {
    candsEl.innerHTML = '';
    if (!list || !list.length) { candsEl.classList.remove('show'); return; }
    list.forEach(function (c) {
      var d = el('div', 'cand');
      var p = el('span', 'p', c.path);
      p.title = c.path;
      d.appendChild(p);
      d.appendChild(el('span', 'badge ' + (c.ok ? 'ok' : 'no'), c.ok ? '✔ hoi4.exe' : '✘ 无 hoi4.exe'));
      d.appendChild(el('span', 'badge src', c.source));
      d.title = '点击设为游戏目录';
      d.onclick = function () { baseEl.value = c.path; scheduleProbe(); setStatus('已选择：' + c.path, ''); };
      candsEl.appendChild(d);
    });
    candsEl.classList.add('show');
  }

  document.getElementById('detectBtn').onclick = function () {
    setStatus('正在检测游戏目录…', '');
    fetch('/api/detect').then(function (r) { return r.json(); }).then(function (j) {
      renderCands(j.candidates);
      var ok = (j.candidates || []).filter(function (c) { return c.ok; });
      if (ok.length) {
        baseEl.value = ok[0].path;
        scheduleProbe();
        setStatus('检测到 ' + ok.length + ' 个含 hoi4.exe 的目录，已填入：' + ok[0].path, 'ok');
      } else {
        setStatus('未自动找到含 hoi4.exe 的目录，请手动粘贴或用「浏览…」选择。', 'warn');
      }
    }).catch(function (e) {
      setStatus('检测失败：' + e.message + '（可手动粘贴路径）', 'warn');
    });
  };
  document.getElementById('browseBase').onclick = function () {
    pickDir(baseEl.value || '', function (p) { baseEl.value = p; scheduleProbe(); });
  };

  /* ── 创意工坊 ── */
  document.getElementById('wsBtn').onclick = function () {
    setStatus('正在扫描 Steam 创意工坊…', '');
    fetch('/api/workshop').then(function (r) { return r.json(); }).then(function (j) {
      wsList.innerHTML = '';
      var mods0 = j.mods || [];
      if (!mods0.length) {
        wsList.appendChild(el('div', 'ws', '没找到创意工坊模组（roots: ' + (j.roots || []).join(' / ') + '）'));
        wsList.classList.add('show');
        setStatus('未找到创意工坊模组，可用「浏览…」手动定位。', 'warn');
        return;
      }
      mods0.forEach(function (m) {
        var row = el('div', 'ws');
        row.appendChild(el('span', 'nm', '[' + m.id + '] ' + (m.name || '') + (m.guiCount ? ' · ' + m.guiCount + ' .gui' : '')));
        row.appendChild(el('span', 'id', m.supportedVersion || ''));
        if (m.hasModFile) row.appendChild(el('span', 'v modf', '✔ .mod'));
        var add = el('button', 'mini', '添加');
        add.onclick = function () {
          var cur = collectMods();
          if (cur.indexOf(m.path) >= 0) { setStatus('该模组已在列表中：' + m.name, 'warn'); return; }
          var inputs = modList.querySelectorAll('input');
          var target = null;
          for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { target = inputs[i]; break; }
          if (!target) target = addModRow('');
          target.value = m.path;
          sync(); scheduleProbe();
          setStatus('已添加模组：' + (m.name || m.path), 'ok');
        };
        row.appendChild(add);
        wsList.appendChild(row);
      });
      wsList.classList.add('show');
      setStatus('创意工坊找到 ' + mods0.length + ' 个模组（appid ' + j.appid + '，游戏版本 ' + (j.gameVersion || '?') + '）', 'ok');
    }).catch(function (e) { setStatus('扫描失败：' + e.message, 'err'); });
  };

  /* ── 新建模组(MAKE_MOD_V1)─────────────────────────────────────
   * 之前这个页面只能"挂载已经存在的目录":手上没有模组的人卡在第一步,
   * 于是整个工作台永远是"看别人的模组",做不出自己的。
   * 这里调 /api/mod/new 直接建骨架并挂成可写来源,建完即可去生成内容。 */
  var nmName = document.getElementById('nmName');
  var nmParent = document.getElementById('nmParent');
  var nmVer = document.getElementById('nmVer');
  var nmSup = document.getElementById('nmSup');
  var nmTags = document.getElementById('nmTags');
  var nmHint = document.getElementById('nmHint');
  var nmBtn = document.getElementById('nmCreate');

  if (nmParent) {
    // 父目录默认落在"上次用过的模组目录的上一级",减少一次手工输入
    var seed = mods.filter(Boolean)[0] || get('gui.base') || '';
    if (seed) {
      var up = seed.replace(/[\\\/][^\\\/]*$/, '');
      nmParent.value = up || seed;
    }
    document.getElementById('nmBrowse').onclick = function () {
      pickDir(nmParent.value || '', function (p) { nmParent.value = p; });
    };
  }

  nmBtn.onclick = function () {
    var name = (nmName.value || '').trim();
    var parent = (nmParent.value || '').trim();
    if (!name) { setStatus('请填写模组名。', 'err'); nmName.focus(); return; }
    if (!parent) { setStatus('请选择模组要建在哪个目录下。', 'err'); nmParent.focus(); return; }
    nmBtn.disabled = true;
    setStatus('正在创建模组骨架…', '');
    fetch('/api/mod/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent: parent,
        name: name,
        version: (nmVer.value || '').trim() || '1.0',
        supportedVersion: (nmSup.value || '').trim(),
        tags: (nmTags.value || '').trim().split(/\s+/).filter(Boolean)
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      nmBtn.disabled = false;
      if (!res.ok || res.j.error) throw new Error((res.j && res.j.error) || '创建失败');
      var j = res.j;
      // 建完就把它放进模组列表并记住 —— 下次打开页面还在
      var inputs = modList.querySelectorAll('input');
      var target = null;
      for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { target = inputs[i]; break; }
      if (!target) target = addModRow('');
      target.value = j.dir;
      sync(); scheduleProbe();
      set('gui.mods', JSON.stringify(mods));
      try { localStorage.setItem(Target.KEY, JSON.stringify({ i: j.rootIdx, name: j.name })); } catch (e) {}
      nmHint.innerHTML = '✅ 已创建 <b>' + j.name + '</b>（' + j.files + ' 个目录 + descriptor.mod），' +
        '并已挂载为可写来源。<br>下一步:去 <a href="/create.html">内容生成</a> 生成内容并保存到它，' +
        '或到 <a href="/ide.html">文件编辑器</a> 直接写。';
      setStatus('模组已创建并挂载:' + j.dir, 'ok');
    }).catch(function (e) {
      nmBtn.disabled = false;
      setStatus('创建失败:' + e.message, 'err');
    });
  };

  /* ── 当前已加载 ── */
  function tag(r) { return r.name + (r.writable ? '（可写·模组）' : '（只读·游戏）'); }
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    curEl.textContent = '当前已加载：' + cfg.roots.map(tag).join('  ·  ') + '（游戏版本 ' + (cfg.gameVersion || '?') + '）';
  }).catch(function () {
    curEl.textContent = '（未能连接服务器，请确认工作台已启动）';
  });

  /* ── 保存并加载 ── */
  function doLoad(thenGo) {
    var base = baseEl.value.trim();
    sync();
    if (!base) { setStatus('基础游戏路径为必填项 —— 请先填写或用「自动检测」/「浏览…」定位含 hoi4.exe 的目录。', 'err'); baseEl.focus(); return; }
    if (!mods.length) setStatus('未填写模组目录，将以只读方式浏览基础游戏。', '');
    btn.disabled = true;
    setStatus('正在加载…', '');
    fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: base, mods: mods })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (!res.ok) throw new Error((res.j && res.j.error) || '加载失败');
      set('gui.base', base);
      set('gui.mods', JSON.stringify(mods));
      set('gui.autoload', autoEl.checked ? '1' : null);
      return fetch('/api/files').then(function (r) { return r.json(); }).then(function (f) {
        var files = f.files || [];
        var nBase = files.filter(function (x) { return x.rootName === 'vanilla'; }).length;
        var nMod = files.filter(function (x) { return x.rootName !== 'vanilla'; }).length;
        var warn = '';
        if (res.j.warnNoExe) warn += ' 该目录未找到 hoi4.exe，可能不是游戏安装目录。';
        if (nBase === 0) warn += ' 游戏路径下未找到 interface/*.gui。';
        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +
          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');
        /* 落回初始工作台(首页),不是所见即所得 —— 首页才有「模组开关」和制作主线。
         * 旧行为跳 /studio.html,而它只是 /designer 的跳板(见 studio.html 的 meta refresh),
         * 于是「保存并进入工作台」实际把用户丢进了设计器,且看不到刚挂的模组。 */
        if (thenGo) setTimeout(function () { location.href = '/'; }, 1200);
        else btn.disabled = false;
      });
    }).catch(function (e) {
      setStatus('加载失败：' + e.message, 'err');
      btn.disabled = false;
    });
  }

  btn.onclick = function () { doLoad(true); };
  autoEl.onchange = function () { set('gui.autoload', autoEl.checked ? '1' : null); };
  scheduleProbe();
  if (autoEl.checked && get('gui.base')) setTimeout(function () { doLoad(true); }, 250);
})();
