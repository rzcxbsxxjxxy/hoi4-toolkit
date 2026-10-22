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
    baseVerdict.appendChild(el('span', info.hasExe ? 'v exe' : 'v bad', info.hasExe ? tr('✔ 含 ') + (info.exe || 'hoi4.exe') : '✘ 未找到 hoi4.exe'));
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
      pkList.appendChild(el('div', 'd', tr('读取失败：') + e.message));
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
      d.onclick = function () { baseEl.value = c.path; scheduleProbe(); setStatus(tr('已选择：') + c.path, ''); };
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
        setStatus(tr('检测到 ') + ok.length + tr(' 个含 hoi4.exe 的目录，已填入：') + ok[0].path, 'ok');
      } else {
        setStatus('未自动找到含 hoi4.exe 的目录，请手动粘贴或用「浏览…」选择。', 'warn');
      }
    }).catch(function (e) {
      setStatus(tr('检测失败：') + e.message + tr('（可手动粘贴路径）'), 'warn');
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
        wsList.appendChild(el('div', 'ws', tr('没找到创意工坊模组（roots: ') + (j.roots || []).join(' / ') + '）'));
        wsList.classList.add('show');
        setStatus('未找到创意工坊模组，可用「浏览…」手动定位。', 'warn');
        return;
      }
      mods0.forEach(function (m) {
        var row = el('div', 'ws');
        row.appendChild(el('span', 'nm', '[' + m.id + '] ' + (m.name || '')));
        row.appendChild(el('span', m.versionOk === false ? 'v bad' : 'id', m.supportedVersion || ''));
        if (m.hasModFile) row.appendChild(el('span', 'v modf', '✔ .mod'));
        else row.appendChild(el('span', 'v info', '推断'));
        if (m.replacePathCount > 0) row.appendChild(el('span', 'v info', 'replace_path ' + m.replacePathCount));
        if (m.dependencies && m.dependencies.length) row.appendChild(el('span', 'v info', '依赖 ' + m.dependencies.length));
        var add = el('button', 'mini', '添加');
        add.onclick = function () {
          var cur = collectMods();
          if (cur.indexOf(m.path) >= 0) { setStatus(tr('该模组已在列表中：') + m.name, 'warn'); return; }
          var inputs = modList.querySelectorAll('input');
          var target = null;
          for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { target = inputs[i]; break; }
          if (!target) target = addModRow('');
          target.value = m.path;
          sync(); scheduleProbe();
          setStatus(tr('已添加模组：') + (m.name || m.path), 'ok');
        };
        row.appendChild(add);
        wsList.appendChild(row);
      });
      wsList.classList.add('show');
      setStatus(tr('创意工坊找到 ') + mods0.length + tr(' 个模组（appid ') + j.appid + tr('，游戏版本 ') + (j.gameVersion || '?') + '）', 'ok');
    }).catch(function (e) { setStatus(tr('扫描失败：') + e.message, 'err'); });
  };

  /* ── 用户目录本地模组(<userdir>/mod/*.mod)── */
  var localList = document.getElementById('localList');
  function renderLocalModRow(m) {
    var row = el('div', 'ws');
    row.appendChild(el('span', 'nm', m.name || m.path.split('/').pop() || m.id));
    row.title = m.path;
    row.appendChild(el('span', m.versionOk === false ? 'v bad' : 'id', m.supportedVersion || ''));
    if (m.hasModFile) row.appendChild(el('span', 'v modf', '✔ .mod'));
    else row.appendChild(el('span', 'v info', '推断'));
    if (m.replacePathCount > 0) row.appendChild(el('span', 'v info', 'replace_path ' + m.replacePathCount));
    if (m.dependencies && m.dependencies.length) row.appendChild(el('span', 'v info', '依赖 ' + m.dependencies.length));
    var add = el('button', 'mini', '添加');
    add.onclick = function () {
      var cur = collectMods();
      if (cur.indexOf(m.path) >= 0) { setStatus(tr('该模组已在列表中：') + m.name, 'warn'); return; }
      var inputs = modList.querySelectorAll('input');
      var target = null;
      for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { target = inputs[i]; break; }
      if (!target) target = addModRow('');
      target.value = m.path;
      sync(); scheduleProbe();
      setStatus(tr('已添加模组：') + (m.name || m.path), 'ok');
    };
    row.appendChild(add);
    return row;
  }
  document.getElementById('scanLocalBtn').onclick = function () {
    setStatus('正在扫描用户目录 mod/…', '');
    fetch('/api/localmods').then(function (r) { return r.json(); }).then(function (j) {
      localList.innerHTML = '';
      var mods0 = j.mods || [];
      if (!mods0.length) {
        localList.appendChild(el('div', 'ws', tr('用户目录下没有可识别的本地模组') + (j.userDir ? '（' + j.userDir + '）' : '')));
        localList.classList.add('show');
        setStatus(tr('未找到用户目录模组') + (j.userDir ? tr('（用户目录：') + j.userDir + '）' : ''), 'warn');
        return;
      }
      mods0.forEach(function (m) { localList.appendChild(renderLocalModRow(m)); });
      localList.classList.add('show');
      setStatus(tr('用户目录找到 ') + mods0.length + tr(' 个本地模组（') + (j.userDir || '?') + '）', 'ok');
    }).catch(function (e) { setStatus(tr('扫描失败：') + e.message, 'err'); });
  };

  /* ── 当前已加载 ── */
  function tag(r) { return r.name + (r.writable ? '（可写·模组）' : '（只读·游戏）'); }
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    curEl.textContent = tr('当前已加载：') + cfg.roots.map(tag).join('  ·  ') + tr('（游戏版本 ') + (cfg.gameVersion || '?') + '）';
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
        if (res.j.warnNoExe) warn += tr(' 该目录未找到 hoi4.exe，可能不是游戏安装目录。');
        if (nBase === 0) warn += tr(' 游戏路径下未找到 interface/*.gui。');
        setStatus(tr('已加载 ') + res.j.roots.length + tr(' 个来源（游戏 ') + nBase + tr(' 个 .gui') +
          (mods.length ? tr('，模组 ') + nMod + tr(' 个') : tr('，未加载模组')) + '）' + warn, warn ? 'warn' : 'ok');
        /* BOOT_GATE:导入/保存来源触发全量重建 —— 壳(iframe)用父 BootGate 全屏进度圈;
         * 独立打开本页(非 iframe)时自显全屏加载画面,避免「点击保存后画面消失」。 */
        if (thenGo) {
          /* ELECTRON_RELOAD(2026-10):桌面端导入/开关模组确认后,走主进程重载:
             关闭大窗口 → 重新出现初始化加载小窗口 → 重启后端读新配置 → 重开大窗口 */
          if (window.electronAPI && window.electronAPI.reloadModules) {
            window.electronAPI.reloadModules();
            return;
          }
          if (window.parent && window.parent !== window && window.parent.BootGate) {
            window.parent.BootGate.show(tr('正在重建索引…'));
          } else { showBoot(); }
          waitReadyThenGo();
        } else { btn.disabled = false; }
      });
    }).catch(function (e) {
      setStatus(tr('加载失败：') + e.message, 'err');
      btn.disabled = false;
    });
  }

  /* BOOTGATE_INLINE:独立页(非 iframe)自显全屏加载画面 —— 只显示遮罩,ready 轮询走 waitReadyThenGo。 */
  function showBoot() {
    var mk = document.getElementById('bootmask');
    var msgEl = document.getElementById('bmMsg');
    if (mk) mk.hidden = false;
    if (msgEl) msgEl.textContent = tr('正在重建索引…');
  }
  /* ★★ 2026-10-10 白屏修复 ——————————————————————————————————————
   * 旧代码无条件 `location.href = '/'`。但 `/` 返回的是【外壳页 shell.html】,
   * 而本页(open.html)自己就跑在壳的 iframe 里 → iframe 里又套了一层 shell,
   * 而壳内 shell 会因 window !== top 把导航藏起来,于是 iframe 区域全白
   * —— 用户看到的就是「只剩最上面一条导航栏的白色画面」,且怎么刷都回不去。
   * 正确做法:壳内 → 让父壳把 iframe 切到工作台首页 /home;独立页 → 才整页跳 /。 */
  function goWorkbench() {
    var mk = document.getElementById('bootmask');
    if (mk) mk.hidden = true;            // 独立页的自显遮罩:跳之前先收
    var par = (window.parent && window.parent !== window) ? window.parent : null;
    if (!par) { location.href = '/'; return; }
    try {
      if (par.shellSwitch) {
        /* ★★ 顺序必须是【先 show、后 switch】—— 反过来就死锁:
         * sticky 的判据是"当前活动帧 ≠ show() 那一刻记下的帧,且新帧 complete"。
         * 若先 shellSwitch,show() 记下的就已经是新帧,cur !== stickyFrame
         * 永远不成立 → 只能等 20s 超时才收遮罩(实测:遮罩白挡 20 秒)。
         * 先 show 记下的是旧帧(open),switch 之后当前帧换成 home → 判据成立。 */
        if (par.BootGate) par.BootGate.show(tr('正在进入工作台…'), null, true);
        /* ★ POOL_DROP_V1(2026-10-17):先丢掉池里的旧 home 帧。
         * 壳的 iframe 池命中即复用、**不重新加载**,而 home 帧是壳启动时就
         * shellSwitch('/home', …) 建好的 → 导入模组后 /api/load 改了 ROOTS 并
         * 落了盘,但切回去拿到的是旧帧的 DOM,模组开关列表仍是导入前的快照。
         * 症状就是"导入后列表没反应,重启程序才对"。
         * 必须夹在 show() 与 switch() 之间:show() 要先把当前帧(open)记成
         * stickyFrame 作为"切走后"的判据,drop 只动 home 帧,不影响它。 */
        if (par.__shellDropFrame) { try { par.__shellDropFrame('/home') } catch (e) {} }
        par.shellSwitch('/home', '/home.html?frame=1');
        return;
      }
    } catch (e) {}
    // 父壳缺 shellSwitch(异常/老版本)时的兜底:跳 /home 而不是 /。
    // ★ 这里【不能】用 sticky —— 这条路径是 iframe 自己换 src,帧元素不变,
    //   sticky 的"帧换了"判据永远不成立 → 又是 20s 超时。
    //   普通模式的判据(后端 ready + 当前帧 complete)刚好合适:换 src 期间
    //   readyState 是 loading → 不收;加载完 → 收。
    if (par.BootGate) { try { par.BootGate.show(tr('正在进入工作台…')) } catch (e) {} }
    location.href = '/home.html?frame=1';
  }

  /* 等后端 ready(重建完成)再跳 —— 固定 1200ms 太短,
   * forceBuildAll 重建需几十秒,固定跳会过早进主页导致白屏/回不去。 */
  function waitReadyThenGo() {
    var pctEl = document.getElementById('bmPct');
    var start = Date.now();
    var MIN_SHOW = 1500;
    var poll = setInterval(function () {
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
        if (pctEl && s.total > 0) pctEl.textContent = Math.round((s.done / s.total) * 100) + '%';
        var elapsed = Date.now() - start;
        if (s.ready && elapsed >= MIN_SHOW) {
          clearInterval(poll);
          goWorkbench();
        } else if (s.ready && elapsed < MIN_SHOW) {
          if (pctEl) pctEl.textContent = '100%';
        }
      }).catch(function () {});
    }, 500);
  }
  btn.onclick = function () { doLoad(true); };
  autoEl.onchange = function () { set('gui.autoload', autoEl.checked ? '1' : null); };
  scheduleProbe();
  /* AUTOLOAD_FIX(2026-10-10):「自动加载上次路径」只负责把 base 填入输入框(第 40 行 + fetch /api/settings 已完成),
   * 不自动保存并跳转 —— 否则一打开本页就 silently 跳回主页,表现为「画面无故消失」。 */
})();
