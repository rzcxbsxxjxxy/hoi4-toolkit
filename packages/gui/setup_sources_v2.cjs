/* HOI4 GUI 设计器 —— 素材来源加载器 v2（自动检测 + 多模组 + 设置面板）
 *
 *   · 基础游戏：必填，自动检测（Steam 注册表 / 各游戏库 / 常见盘符），可手动改
 *   · 模组目录：可选，可添加多个，随时增删改
 *   · 来源区分：蓝＝游戏(只读) / 绿＝模组(可写)
 *
 * 由用户在自己的终端运行（agent 沙箱对既有文件无写权限）：
 *   cd /d 杂项/hoi4/toolkit/packages/gui
 *   node setup_sources_v2.cjs --dry     # 仅校验锚点，不写盘
 *   node setup_sources_v2.cjs           # 正式应用
 *
 * 本脚本是 v1(setup_sources.cjs) 的完整超集,只需运行本脚本即可。
 * 规则：任一锚点不匹配即整体中止,不会留下半改状态。
 * 幂等：检测到 server.ts 已含 /api/detect 则跳过 server 改动。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY = process.argv.includes('--dry');

/* 基础游戏默认安装路径（自动检测失败时的兜底） */
const DEFAULT_BASE = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV';

/* ── open.html：设置面板（游戏必填 + 模组多选） ── */
const OPEN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>打开工程 · 素材来源设置</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,'Segoe UI',Roboto,'Microsoft Yahei',sans-serif;background:#11151c;color:#e6edf3;display:flex;align-items:flex-start;justify-content:center;min-height:100vh;padding:28px 0}
  .card{width:640px;max-width:94vw;background:#1a2029;border:1px solid #2a3340;border-radius:14px;padding:24px 28px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:#8b98a8;font-size:13px;margin-bottom:16px;line-height:1.6}
  .grp{margin:14px 0;padding:13px 15px;background:#141a22;border:1px solid #283140;border-radius:10px}
  .grp.req{border-color:#3b6fb5}
  .grp h2{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .dot.game{background:#3b6fb5}
  .dot.mod{background:#2f8f5b}
  .tag{font-size:11px;padding:1px 6px;border-radius:5px;font-weight:600}
  .tag.req{color:#8fc0f5;background:#1d2c42;border:1px solid #2f4a6b}
  .tag.opt{color:#7e8c9e;background:#1a222c;border:1px solid #2a3340}
  input[type=text]{width:100%;background:#0e131a;border:1px solid #2c3645;color:#e6edf3;padding:9px 10px;border-radius:8px;font-size:13px}
  input.req-in{border-color:#3b6fb5}
  input:focus{outline:none;border-color:#4d8ce0}
  .row{display:flex;gap:8px;margin-top:8px;align-items:center}
  .row input{flex:1;min-width:0}
  button{min-width:0;padding:8px 12px;border:1px solid #2f3a4a;background:#1e2632;color:#cfd9e5;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit}
  button:hover{background:#26303e;border-color:#3c4a5e}
  button.primary{padding:11px;border:0;background:#2f6df0;color:#fff;font-size:14px;border-radius:9px;width:100%;margin-top:16px}
  button.primary:hover{background:#3f7bff}
  button.primary:disabled{background:#3a4757;cursor:not-allowed}
  button.mini{padding:6px 9px;font-size:11px;flex:none}
  button.x{color:#ff9a9a;border-color:#4a3038;background:#2a1f24}
  button.x:hover{background:#3a2830}
  .hint{color:#76859a;font-size:12px;margin-top:7px;line-height:1.6}
  code{background:#0e131a;padding:1px 5px;border-radius:4px;font-size:11px;color:#9fb3c8}
  #cands{margin-top:9px;display:none;flex-direction:column;gap:5px}
  #cands.show{display:flex}
  .cand{display:flex;align-items:center;gap:8px;padding:6px 9px;background:#10161e;border:1px solid #262f3c;border-radius:7px;cursor:pointer;font-size:12px}
  .cand:hover{border-color:#4d8ce0;background:#141c26}
  .cand .p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b8c6d6;font-family:ui-monospace,Consolas,monospace;font-size:11px}
  .cand .badge{font-size:10px;padding:1px 5px;border-radius:4px;flex:none}
  .badge.ok{background:#1e3a2a;color:#6cd39a}
  .badge.no{background:#33272a;color:#c98d95}
  .badge.src{background:#1a2432;color:#7d94ad}
  .modrow{display:flex;gap:8px;margin-top:8px;align-items:center}
  .modrow input{flex:1;min-width:0}
  .opt-row{display:flex;align-items:center;gap:7px;margin-top:14px;font-size:12px;color:#8b98a8;cursor:pointer}
  .opt-row input{width:auto;accent-color:#2f6df0}
  #status{margin-top:12px;font-size:13px;min-height:18px}
  #status.ok{color:#5fd08a}#status.warn{color:#e6c14b}#status.err{color:#ff7a7a}
  .cur{font-size:12px;color:#8b98a8;margin-top:9px;line-height:1.5}
  .foot{margin-top:14px;font-size:12px;color:#5d6b7d}
  a{color:#7fa8f2}
</style>
</head>
<body>
  <div class="card">
    <h1>打开工程 · 素材来源设置</h1>
    <div class="sub">
      <b style="color:#6fa8e0">蓝＝基础游戏</b>（必填，只读）提供全部原始素材与定义；
      <b style="color:#5fd08a">绿＝模组</b>（可选，可写）可添加多个。
      两者同时加载时，内容会自动按来源标注。
    </div>

    <div class="grp req">
      <h2><span class="dot game"></span>基础游戏<span class="tag req">必填</span></h2>
      <div class="row">
        <input type="text" class="req-in" id="basePath" placeholder="C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hearts of Iron IV">
        <button id="detectBtn" class="mini">自动检测</button>
      </div>
      <div id="cands"></div>
      <div class="hint">目录内应含 <code>interface/</code> <code>common/</code>。点「自动检测」会依次查找 Steam 注册表、各游戏库与常见安装盘符；也可 Shift+右键文件夹 →「复制文件地址」直接粘贴。</div>
    </div>

    <div class="grp">
      <h2><span class="dot mod"></span>模组目录<span class="tag opt">可选 · 可多个</span></h2>
      <div id="modList"></div>
      <button id="addMod" class="mini" style="margin-top:9px">＋ 添加模组目录</button>
      <div class="hint">留空则以只读方式浏览游戏本体。多个模组按顺序加载，后者在同名文件上覆盖前者；只有模组目录允许写入。</div>
    </div>

    <label class="opt-row"><input type="checkbox" id="autoload"> 下次打开本页面时自动加载上次路径</label>

    <button class="primary" id="loadBtn">保存并进入工作台</button>
    <div id="status"></div>
    <div class="cur" id="current"></div>
    <div class="foot">路径仅保存在本机浏览器（localStorage），不会上传。也可在 <a href="/studio.html">工作台</a> 顶栏随时点「打开工程」返回此处修改。</div>
  </div>
  <script src="/open.js"></script>
</body>
</html>
`;

/* ── open.js：自动检测 + 多模组增删 + 设置持久化 ── */
const OPEN_JS = `/* open.js — 素材来源设置：基础游戏(必填,自动检测) + 模组(可选,多个)。 */
(function () {
  var baseEl = document.getElementById('basePath');
  var modList = document.getElementById('modList');
  var candsEl = document.getElementById('cands');
  var statusEl = document.getElementById('status');
  var curEl = document.getElementById('current');
  var btn = document.getElementById('loadBtn');
  var autoEl = document.getElementById('autoload');

  var DEF_BASE = ${JSON.stringify(DEFAULT_BASE)};

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  function loadMods() {
    var raw = get('gui.mods');
    if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e) {} }
    var one = get('gui.mod');
    return one ? [one] : [];
  }
  var mods = loadMods();
  baseEl.value = get('gui.base') || DEF_BASE;
  autoEl.checked = get('gui.autoload') === '1';

  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ''; }

  /* ── 模组行 ── */
  function addModRow(v) {
    var row = document.createElement('div');
    row.className = 'modrow';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '模组目录路径（可留空或删除该行）';
    inp.value = v || '';
    var del = document.createElement('button');
    del.className = 'mini x';
    del.textContent = '移除';
    del.onclick = function () { row.remove(); syncMods(); };
    row.appendChild(inp);
    row.appendChild(del);
    modList.appendChild(row);
    inp.oninput = syncMods;
    return inp;
  }
  function syncMods() {
    mods = [].slice.call(modList.querySelectorAll('input')).map(function (i) { return i.value.trim(); }).filter(Boolean);
  }
  mods.forEach(function (m) { addModRow(m); });
  if (!mods.length) addModRow('');

  document.getElementById('addMod').onclick = function () {
    var inputs = modList.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) if (!inputs[i].value.trim()) { inputs[i].focus(); return; }
    addModRow('').focus();
  };

  /* ── 自动检测游戏目录 ── */
  function renderCands(list) {
    candsEl.innerHTML = '';
    if (!list || !list.length) { candsEl.classList.remove('show'); return; }
    list.forEach(function (c) {
      var d = document.createElement('div');
      d.className = 'cand';
      var p = document.createElement('span');
      p.className = 'p';
      p.textContent = c.path;
      p.title = c.path;
      var b1 = document.createElement('span');
      b1.className = 'badge ' + (c.ok ? 'ok' : 'no');
      b1.textContent = c.ok ? '可用' : '无 interface';
      var b2 = document.createElement('span');
      b2.className = 'badge src';
      b2.textContent = c.source;
      d.appendChild(p); d.appendChild(b1); d.appendChild(b2);
      d.title = '点击设为游戏目录';
      d.onclick = function () { baseEl.value = c.path; setStatus('已选择：' + c.path, ''); };
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
        setStatus('检测到 ' + ok.length + ' 个可用目录，已填入：' + ok[0].path, 'ok');
      } else {
        setStatus('未自动找到 HoI4 安装目录，请手动粘贴路径。', 'warn');
      }
    }).catch(function (e) {
      setStatus('检测失败：' + e.message + '（可手动粘贴路径）', 'warn');
    });
  };

  /* ── 当前已加载 ── */
  function tag(r) { return r.name + (r.writable ? '（可写·模组）' : '（只读·游戏）'); }
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    curEl.textContent = '当前已加载：' + cfg.roots.map(tag).join('  ·  ');
  }).catch(function () {
    curEl.textContent = '（未能连接服务器，请确认设计器已启动）';
  });

  /* ── 保存并加载 ── */
  function doLoad(thenGo) {
    var base = baseEl.value.trim();
    syncMods();
    if (!base) { setStatus('基础游戏路径为必填项 —— 请先填写或自动检测 HoI4 安装目录。', 'err'); baseEl.focus(); return; }
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
        if (nBase === 0) warn += ' 游戏路径下未找到 interface/*.gui，请确认目录是否正确。';
        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +
          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');
        if (thenGo) setTimeout(function () { location.href = '/studio.html'; }, 1200);
        else btn.disabled = false;
      });
    }).catch(function (e) {
      setStatus('加载失败：' + e.message, 'err');
      btn.disabled = false;
    });
  }

  btn.onclick = function () { doLoad(true); };

  autoEl.onchange = function () { set('gui.autoload', autoEl.checked ? '1' : null); };
  if (autoEl.checked && get('gui.base')) setTimeout(function () { doLoad(true); }, 250);
})();
`;

/* ── 需要改写的既有文件 ── */
const PATCH = [
  {
    file: 'src/server.ts',
    marker: "'/api/detect'",
    edits: [
      // 1) 引入 child_process（读 Steam 注册表用）
      {
        o: "import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'",
        n:
          "import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'\n" +
          "import { execFileSync } from 'node:child_process'",
      },
      // 2) ROOTS / spriteIdx / scanEntries 改为 let，允许运行时重载
      { o: 'const ROOTS: Root[] = []', n: 'let ROOTS: Root[] = []' },
      { o: 'const spriteIdx = new SpriteIndex(ROOTS[0].path)', n: 'let spriteIdx = new SpriteIndex(ROOTS[0].path)' },
      { o: 'const scanEntries = ROOTS.map((r) => ({', n: 'let scanEntries = ROOTS.map((r) => ({' },

      // 3) 基础游戏为必需项：未给 --base 时补默认路径，置于首位
      {
        o: 'if (READONLY) for (const r of ROOTS) r.writable = false',
        n:
          'if (READONLY) for (const r of ROOTS) r.writable = false\n' +
          '// 基础游戏为必需项:未显式给出 --base 时补上默认安装路径。\n' +
          '// 置于首位 —— spriteIdx / scanEntries 均以 ROOTS[0] 为基准。\n' +
          'if (!ROOTS.some((r) => !r.writable)) {\n' +
          '  ROOTS.unshift({\n' +
          "    name: 'vanilla',\n" +
          '    path: ' + JSON.stringify(DEFAULT_BASE) + ',\n' +
          '    writable: false,\n' +
          '  })\n' +
          '}',
      },

      // 4) rebuildIndexes() + 自动检测函数
      {
        o: 'const t0 = Date.now()',
        n:
          "const t0 = Date.now()\n\n" +
          'const DEFAULT_GAME_DIR = ' + JSON.stringify(DEFAULT_BASE) + '\n\n' +
          'function rebuildIndexes() {\n' +
          "  scanEntries = ROOTS.map((r) => ({\n" +
          "    dir: join(r.path, 'interface'),\n" +
          '    gameRoot: r.path,\n' +
          "  })).filter((e) => existsSync(e.dir))\n" +
          "  spriteIdx = new SpriteIndex(ROOTS[0] && ROOTS[0].path ? ROOTS[0].path : '')\n" +
          '  if (ROOTS.length) spriteIdx.scanAll(scanEntries)\n' +
          '  texIds.clear(); texTable.clear(); texCache.clear()\n' +
          '  layoutCache.clear()\n' +
          "  LINK = null; LINK_ERR = ''; LINK_BUSY = false\n" +
          "  SYM = null; SYM_ERR = ''; SYM_BUSY = false\n" +
          "  FG = null; FG_ERR = ''; FG_BUSY = false\n" +
          "  CHECK = null; CHECK_ERR = ''; CHECK_BUSY = false\n" +
          "  TG = null; TG_ERR = ''; TG_BUSY = false\n" +
          "  DG = null; DG_ERR = ''; DG_BUSY = false\n" +
          "  console.log('  已重建索引: ' + ROOTS.length + ' 个来源')\n" +
          "  for (const r of ROOTS) console.log('    ' + (r.writable ? '[可写·模组]' : '[只读·游戏]') + ' ' + r.name + '  ' + r.path)\n" +
          '}\n\n' +
          '/** 是否像一个 HoI4 安装目录：有 interface/ 且有 common/ */\n' +
          'function looksLikeGameDir(p: string): boolean {\n' +
          '  try {\n' +
          "    return existsSync(join(p, 'interface')) && existsSync(join(p, 'common'))\n" +
          '  } catch {\n' +
          '    return false\n' +
          '  }\n' +
          '}\n\n' +
          '/** 从注册表读 Steam 根目录(仅 Windows;失败返回空数组) */\n' +
          'function steamRoots(): string[] {\n' +
          '  const out: string[] = []\n' +
          '  const keys: [string, string][] = [\n' +
          "    ['HKCU\\\\Software\\\\Valve\\\\Steam', 'SteamPath'],\n" +
          "    ['HKLM\\\\SOFTWARE\\\\WOW6432Node\\\\Valve\\\\Steam', 'InstallPath'],\n" +
          "    ['HKLM\\\\SOFTWARE\\\\Valve\\\\Steam', 'InstallPath'],\n" +
          '  ]\n' +
          '  for (const kv of keys) {\n' +
          '    try {\n' +
          "      const txt = execFileSync('reg', ['query', kv[0], '/v', kv[1]], {\n" +
          "        encoding: 'utf8',\n" +
          "        stdio: ['ignore', 'pipe', 'ignore'],\n" +
          '        timeout: 3000,\n' +
          '      })\n' +
          '      const m = txt.match(new RegExp(kv[1] + \'\\\\s+REG_SZ\\\\s+(.+)\'))\n' +
          "      if (m && m[1]) out.push(m[1].trim().replace(/\\\\/g, '/'))\n" +
          '    } catch {\n' +
          '      /* 非 Windows / 无 reg / 无该键:忽略 */\n' +
          '    }\n' +
          '  }\n' +
          '  return out\n' +
          '}\n\n' +
          '/**\n' +
          ' * 列出 HoI4 安装目录候选:默认路径 → Steam 注册表 → Steam 各游戏库\n' +
          ' * (含 libraryfolders.vdf 指向其它盘的库)→ 各盘常见安装位置。\n' +
          ' * ok=true 表示该目录下确实有 interface/ 与 common/。\n' +
          ' */\n' +
          'function detectGameDirs(): { path: string; ok: boolean; source: string }[] {\n' +
          '  const seen = new Set<string>()\n' +
          '  const out: { path: string; ok: boolean; source: string }[] = []\n' +
          '  const add = (raw: string, source: string) => {\n' +
          '    if (!raw) return\n' +
          "    const p = raw.replace(/\\\\/g, '/').replace(/\\/+$/, '')\n" +
          '    const k = p.toLowerCase()\n' +
          '    if (seen.has(k)) return\n' +
          '    seen.add(k)\n' +
          '    out.push({ path: p, ok: looksLikeGameDir(p), source })\n' +
          '  }\n' +
          "  const GAME = 'Hearts of Iron IV'\n" +
          '  add(DEFAULT_GAME_DIR, \'默认路径\')\n' +
          '  for (const s of steamRoots()) {\n' +
          "    add(join(s, 'steamapps', 'common', GAME), 'Steam 注册表')\n" +
          '    try {\n' +
          "      const vdf = readFileSync(join(s, 'steamapps', 'libraryfolders.vdf'), 'utf8')\n" +
          '      const re = /"path"\\s+"([^"]+)"/g\n' +
          '      let mm: RegExpExecArray | null\n' +
          '      while ((mm = re.exec(vdf))) {\n' +
          "        add(join(mm[1], 'steamapps', 'common', GAME), 'Steam 游戏库')\n" +
          '      }\n' +
          '    } catch {\n' +
          '      /* 无 vdf 或读不到:忽略 */\n' +
          '    }\n' +
          '  }\n' +
          "  for (const d of ['C', 'D', 'E', 'F', 'G', 'H']) {\n" +
          "    add(d + ':/Program Files (x86)/Steam/steamapps/common/' + GAME, '常见路径')\n" +
          "    add(d + ':/Steam/steamapps/common/' + GAME, '常见路径')\n" +
          '  }\n' +
          '  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))\n' +
          '  return out\n' +
          '}',
      },

      // 5) GET /api/detect —— 自动检测游戏目录
      {
        o: "    if (p === '/api/config') {",
        n:
          "    if (p === '/api/detect') {\n" +
          '      try {\n' +
          '        return send(\n' +
          '          res,\n' +
          '          200,\n' +
          '          JSON.stringify({ defaultBase: DEFAULT_GAME_DIR, candidates: detectGameDirs() }),\n' +
          '        )\n' +
          '      } catch (e) {\n' +
          "        return send(res, 500, JSON.stringify({ error: String(e) }))\n" +
          '      }\n' +
          '    }\n' +
          "    if (p === '/api/config') {",
      },

      // 6) POST /api/load —— base 必填、mods 可选(数组),逐个存在性校验
      {
        o: "    if (p === '/api/config') {",
        n:
          "    if (p === '/api/load' && req.method === 'POST') {\n" +
          "      let body = ''\n" +
          "      req.on('data', (c) => { body += c; if (body.length > 1000000) req.destroy() })\n" +
          "      req.on('end', () => {\n" +
          '        try {\n' +
          "          const req0 = JSON.parse(body || '{}')\n" +
          "          const base = typeof req0.base === 'string' ? req0.base.trim() : ''\n" +
          '          const mods: string[] = []\n' +
          "          if (typeof req0.mod === 'string' && req0.mod.trim()) mods.push(req0.mod.trim())\n" +
          '          if (Array.isArray(req0.mods)) {\n' +
          "            for (const m of req0.mods) if (typeof m === 'string' && m.trim()) mods.push(m.trim())\n" +
          '          }\n' +
          "          if (!base) return send(res, 400, JSON.stringify({ error: '基础游戏路径为必填项' }))\n" +
          '          if (!existsSync(base)) return send(res, 400, JSON.stringify({ error: `基础游戏路径不存在: ${base}` }))\n' +
          '          for (const m of mods) {\n' +
          '            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))\n' +
          '          }\n' +
          "          const roots: Root[] = [{ name: 'vanilla', path: base, writable: false }]\n" +
          '          for (const m of mods) roots.push({ name: basename(m), path: m, writable: true })\n' +
          '          if (READONLY) for (const r of roots) r.writable = false\n' +
          '          ROOTS.length = 0\n' +
          '          for (const r of roots) ROOTS.push(r)\n' +
          '          rebuildIndexes()\n' +
          "          return send(res, 200, JSON.stringify({ ok: true, roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })) }))\n" +
          '        } catch (e) {\n' +
          "          return send(res, 500, JSON.stringify({ error: String(e) }))\n" +
          '        }\n' +
          '      })\n' +
          '      return\n' +
          '    }\n' +
          "    if (p === '/api/config') {",
      },

      // 7) /api/files 每条附带 rootName + writable
      {
        o: 'out.push({ root: i, file: relative(r.path, f)',
        n: 'out.push({ root: i, rootName: r.name, writable: r.writable, file: relative(r.path, f)',
      },

      // 8) /open 页面路由
      {
        o:
          "    if (p === '/designer.js') {\n" +
          "      const js = readFileSync(join(PUBLIC, 'designer.js'), 'utf8')\n" +
          "      return send(res, 200, js, 'application/javascript; charset=utf-8')\n" +
          '    }',
        n:
          "    if (p === '/designer.js') {\n" +
          "      const js = readFileSync(join(PUBLIC, 'designer.js'), 'utf8')\n" +
          "      return send(res, 200, js, 'application/javascript; charset=utf-8')\n" +
          '    }\n' +
          "    if (p === '/open' || p === '/open.html') {\n" +
          "      const html = readFileSync(join(PUBLIC, 'open.html'), 'utf8')\n" +
          "      return send(res, 200, html, 'text/html; charset=utf-8')\n" +
          '    }\n' +
          "    if (p === '/open.js') {\n" +
          "      const js = readFileSync(join(PUBLIC, 'open.js'), 'utf8')\n" +
          "      return send(res, 200, js, 'application/javascript; charset=utf-8')\n" +
          '    }',
      },
    ],
  },
  {
    file: 'public/app.js',
    marker: 'src-chip',
    edits: [
      {
        o: '    S.roots = cfg.roots;',
        n:
          '    S.roots = cfg.roots;\n' +
          "    if (!document.getElementById('src-chip-style')) {\n" +
          "      const _st = document.createElement('style');\n" +
          "      _st.id = 'src-chip-style';\n" +
          "      _st.textContent = '.src-chip{display:inline-block;font-size:11px;line-height:1;padding:1px 5px;border-radius:6px;margin-right:6px;vertical-align:middle;color:#fff;font-weight:600}.src-chip.game{background:#3b6fb5}.src-chip.mod{background:#2f8f5b}';\n" +
          '      document.head.appendChild(_st);\n' +
          '    }',
      },
      {
        o:
          "    $('#rootSel').innerHTML = cfg.roots\n" +
          "      .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '' : '（只读）'}</option>`)\n" +
          "      .join('');",
        n:
          "    $('#rootSel').innerHTML =\n" +
          "      '<option value=\"-1\">全部来源</option>' +\n" +
          '      cfg.roots\n' +
          "        .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)\n" +
          "        .join('');",
      },
      {
        o: '(f) => f.root === S.root && (!q || f.name.toLowerCase().includes(q))',
        n: '(f) => (S.root < 0 || f.root === S.root) && (!q || f.name.toLowerCase().includes(q))',
      },
      {
        o:
          "      const d = el('div', 'file-item' + (f.file === S.file ? ' on' : ''));\n" +
          '      d.textContent = f.name;',
        n:
          "      const d = el('div', 'file-item' + (f.file === S.file ? ' on' : ''));\n" +
          '      const r0 = S.roots[f.root] || {};\n' +
          "      const chip = el('span', 'src-chip' + (r0.writable ? ' mod' : ' game'));\n" +
          "      chip.textContent = r0.name || ('root' + f.root);\n" +
          '      d.appendChild(chip);\n' +
          '      d.appendChild(document.createTextNode(f.name));',
      },
    ],
  },
  {
    file: 'public/designer.js',
    marker: '【模组】',
    edits: [
      {
        o:
          "    $('#rootSel').innerHTML = cfg.roots\n" +
          "      .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '' : '（只读）'}</option>`)\n" +
          "      .join('');",
        n:
          "    $('#rootSel').innerHTML =\n" +
          "      '<option value=\"-1\">全部来源</option>' +\n" +
          '      cfg.roots\n' +
          "        .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)\n" +
          "        .join('');",
      },
      {
        o:
          '  function renderFileList() {\n' +
          '    const list = S.files.filter((f) => f.root === S.root);\n' +
          "    const sel = $('#fileSel');\n" +
          "    sel.innerHTML = list.map((f) => `<option value=\"${cssEsc(f.file)}\">${f.name}</option>`).join('');\n" +
          '    if (S.file) sel.value = S.file;\n' +
          '  }',
        n:
          '  function renderFileList() {\n' +
          '    const list = S.files.filter((f) => S.root < 0 || f.root === S.root);\n' +
          "    const sel = $('#fileSel');\n" +
          '    sel.innerHTML = list.map((f) => {\n' +
          "      const tag = (S.roots[f.root] && S.roots[f.root].writable) ? '【模组】' : '【游戏】';\n" +
          '      return `<option value="${cssEsc(f.file)}">${tag}${f.name}</option>`;\n' +
          "    }).join('');\n" +
          '    if (S.file) sel.value = S.file;\n' +
          '  }',
      },
    ],
  },
  {
    file: 'public/index.html',
    marker: '/open.html',
    edits: [
      {
        o: '  <a href="/designer" style="font-size:12px;color:var(--accent)">界面设计器</a>',
        n:
          '  <a href="/designer" style="font-size:12px;color:var(--accent)">界面设计器</a>\n' +
          '  <a href="/open.html" style="font-size:12px;color:var(--accent)">打开工程</a>',
      },
    ],
  },
  {
    file: 'public/studio.html',
    marker: '/open.html',
    edits: [
      {
        o:
          '  <div class="spacer"></div>\n' +
          '  <select id="rootSel" title="模组/游戏根目录"></select>',
        n:
          '  <div class="spacer"></div>\n' +
          '  <a href="/open.html" style="font-size:12px;color:var(--accent)">打开工程</a>\n' +
          '  <select id="rootSel" title="模组/游戏根目录"></select>',
      },
    ],
  },
];

/* ── 主流程 ── */
let ok = true;
let applied = 0;
let skipped = 0;

for (const grp of PATCH) {
  const fp = path.join(DIR, grp.file);
  let content;
  try {
    content = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    console.log('✗ 找不到文件: ' + grp.file + '  (' + e.message + ')');
    ok = false;
    continue;
  }

  if (grp.marker && content.includes(grp.marker)) {
    console.log('• 已是最新，跳过: ' + grp.file);
    skipped++;
    continue;
  }

  let next = content;
  let groupOk = true;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '✗ 锚点不匹配 [' + grp.file + ']，出现次数=' + parts.length + ' 期望=1。片段: ' +
          ed.o.slice(0, 70).replace(/\n/g, '\\n'),
      );
      ok = false;
      groupOk = false;
      break;
    }
    next = next.split(ed.o).join(ed.n);
  }
  if (!groupOk) continue;

  if (DRY) {
    console.log('✓ 校验通过(未写盘): ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
  } else {
    fs.writeFileSync(fp, next, 'utf8');
    console.log('✓ 已应用: ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
    applied++;
  }
}

/* open.html / open.js 始终整体重写为最新版本 */
for (const [name, content] of [['public/open.html', OPEN_HTML], ['public/open.js', OPEN_JS]]) {
  const fp = path.join(DIR, name);
  if (DRY) {
    console.log('✓ 将写入(未写盘): ' + name + '  (' + content.length + ' 字符)');
  } else {
    fs.writeFileSync(fp, content, 'utf8');
    console.log('✓ 已写入: ' + name + '  (' + content.length + ' 字符)');
    applied++;
  }
}

if (!ok) {
  console.log('\n存在锚点不匹配，未做任何修改。请检查上述文件是否为最新版本。');
  process.exit(1);
}
console.log(
  '\n' +
    (DRY
      ? 'DRY-RUN 完成：所有锚点均匹配，可去掉 --dry 正式应用。'
      : '全部完成（应用 ' + applied + ' 项' + (skipped ? '，跳过 ' + skipped + ' 项已最新' : '') + '）。\n' +
        '下一步：双击 run-gui.bat 启动，打开 http://localhost:5173/open.html 点「自动检测」选择游戏目录。'),
);
