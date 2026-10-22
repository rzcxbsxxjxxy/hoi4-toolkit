/* HOI4 GUI 设计器 —— 素材来源加载器（基础游戏必填 / 模组可选）
 *
 * 由用户在自己的终端运行（agent 沙箱对既有文件无写权限）：
 *   cd /d 杂项/hoi4/toolkit/packages/gui
 *   node setup_sources.cjs --dry     # 仅校验锚点，不写盘
 *   node setup_sources.cjs           # 正式应用
 *
 * 规则：任一锚点不匹配即整体中止，不会留下半改状态。
 * 幂等：重复运行会识别「已打过补丁」并直接跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

/* 基础游戏为必填的默认安装路径 */
const DEFAULT_BASE = 'C:/Program Files (x86)/Steam/steamapps/common/Hearts of Iron IV';

/* ── open.html：基础游戏必填、模组可选 ── */
const OPEN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>打开工程 · 选择素材来源</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,'Segoe UI',Roboto,'Microsoft Yahei',sans-serif;background:#11151c;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{width:600px;max-width:92vw;background:#1a2029;border:1px solid #2a3340;border-radius:14px;padding:26px 28px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:#8b98a8;font-size:13px;margin-bottom:18px;line-height:1.5}
  .grp{margin:16px 0;padding:14px 16px;background:#141a22;border:1px solid #283140;border-radius:10px}
  .grp.req{border-color:#3b6fb5}
  .grp h2{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .dot.game{background:#3b6fb5}
  .dot.mod{background:#2f8f5b}
  .req-tag{font-size:11px;font-weight:600;color:#8fc0f5;background:#1d2c42;border:1px solid #2f4a6b;padding:1px 6px;border-radius:5px}
  .opt-tag{font-size:11px;color:#7e8c9e;background:#1a222c;border:1px solid #2a3340;padding:1px 6px;border-radius:5px}
  .row{display:flex;gap:8px;margin-top:8px}
  input[type=text]{flex:1;background:#0e131a;border:1px solid #2c3645;color:#e6edf3;padding:9px 10px;border-radius:8px;font-size:13px;min-width:0}
  input.req-in{border-color:#3b6fb5}
  input:focus{outline:none;border-color:#4d8ce0}
  .hint{color:#76859a;font-size:12px;margin-top:8px;line-height:1.6}
  code{background:#0e131a;padding:1px 5px;border-radius:4px;font-size:11px;color:#9fb3c8}
  button.go{margin-top:18px;width:100%;padding:11px;border:0;border-radius:9px;background:#2f6df0;color:#fff;font-size:14px;cursor:pointer}
  button.go:hover{background:#3f7bff}
  button.go:disabled{background:#3a4757;cursor:not-allowed}
  #status{margin-top:14px;font-size:13px;min-height:18px}
  #status.ok{color:#5fd08a}#status.warn{color:#e6c14b}#status.err{color:#ff7a7a}
  .cur{font-size:12px;color:#8b98a8;margin-top:10px;line-height:1.5}
  .foot{margin-top:16px;font-size:12px;color:#5d6b7d}
  a{color:#7fa8f2}
</style>
</head>
<body>
  <div class="card">
    <h1>打开工程 · 选择素材来源</h1>
    <div class="sub">
      <b style="color:#6fa8e0">蓝＝基础游戏</b>（必填，只读）提供全部原始素材与定义；
      <b style="color:#5fd08a">绿＝模组</b>（可选，可写）在此基础上的改动。
      两者同时加载时，内容会自动按来源标注。
    </div>

    <div class="grp req">
      <h2><span class="dot game"></span>基础游戏（HoI4 安装目录 · 只读）<span class="req-tag">必填</span></h2>
      <div class="row">
        <input type="text" class="req-in" id="basePath" placeholder="C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hearts of Iron IV">
      </div>
      <div class="hint">目录内应含 <code>interface/</code> <code>common/</code> <code>gfx/</code> <code>localisation/</code>。获取路径：资源管理器中 <b>Shift+右键</b> 该文件夹 →「复制文件地址」，粘贴到此处。</div>
    </div>

    <div class="grp">
      <h2><span class="dot mod"></span>你的模组（可写 · 修改会写回这里）<span class="opt-tag">可选</span></h2>
      <div class="row">
        <input type="text" id="modPath" placeholder="例如 D:\\杂项\\hoi4\\en（留空则只读浏览基础游戏）">
      </div>
      <div class="hint">留空即可只读浏览游戏本体；填写后模组内容会与游戏内容并列显示，且只有模组目录允许写入。</div>
    </div>

    <button class="go" id="loadBtn">加载并进入工作台</button>
    <div id="status"></div>
    <div class="cur" id="current"></div>
    <div class="foot">路径仅保存在本机浏览器（localStorage），不会上传。也可在 <a href="/studio.html">工作台</a> 顶栏随时点「打开工程」返回此处。</div>
  </div>
  <script src="/open.js"></script>
</body>
</html>
`;

/* ── open.js：base 必填校验，mod 可空 ── */
const OPEN_JS = `/* open.js — 打开工程页：选择基础游戏（必填）+ 模组（可选），运行时加载到设计器。 */
(function () {
  var baseEl = document.getElementById('basePath');
  var modEl = document.getElementById('modPath');
  var statusEl = document.getElementById('status');
  var curEl = document.getElementById('current');
  var btn = document.getElementById('loadBtn');

  var DEF_BASE = ${JSON.stringify(DEFAULT_BASE)};
  var lsBase = localStorage.getItem('gui.base') || DEF_BASE;
  var lsMod = localStorage.getItem('gui.mod') || '';
  baseEl.value = lsBase;
  modEl.value = lsMod;

  function tag(r) { return r.name + (r.writable ? '（可写·模组）' : '（只读·游戏）'); }
  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ''; }

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    curEl.textContent = '当前已加载：' + cfg.roots.map(tag).join('  ·  ');
  }).catch(function () {
    curEl.textContent = '（未能连接服务器，请确认设计器已启动）';
  });

  btn.onclick = function () {
    var base = baseEl.value.trim();
    var mod = modEl.value.trim();

    // 基础游戏必填
    if (!base) { setStatus('基础游戏路径为必填项 —— 请先填写 HoI4 安装目录。', 'err'); baseEl.focus(); return; }
    if (!mod) setStatus('未填写模组路径，将以只读方式浏览基础游戏。', '');

    btn.disabled = true;
    setStatus('正在加载…', '');

    fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: base, mod: mod || undefined })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (!res.ok) throw new Error((res.j && res.j.error) || '加载失败');
      localStorage.setItem('gui.base', base);
      if (mod) localStorage.setItem('gui.mod', mod); else localStorage.removeItem('gui.mod');
      return fetch('/api/files').then(function (r) { return r.json(); }).then(function (f) {
        var files = f.files || [];
        var nBase = files.filter(function (x) { return x.rootName === 'vanilla'; }).length;
        var nMod = files.filter(function (x) { return x.rootName !== 'vanilla'; }).length;
        var warn = '';
        if (nBase === 0) warn += ' 基础游戏路径下未找到 interface/*.gui，请确认该目录是否正确。';
        if (mod && nMod === 0) warn += ' 模组路径下未找到 interface/*.gui（模组没有界面文件也属正常）。';
        setStatus('已加载：' + res.j.roots.map(function (r) { return r.name; }).join(' / ') +
          '　（游戏 ' + nBase + ' 个 .gui' + (mod ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn,
          warn ? 'warn' : 'ok');
        setTimeout(function () { location.href = '/studio.html'; }, 1400);
      });
    }).catch(function (e) {
      setStatus('加载失败：' + e.message, 'err');
      btn.disabled = false;
    });
  };
})();
`;

/* ── 需要改写的既有文件 ── */
const PATCH = [
  {
    file: 'src/server.ts',
    marker: "if (p === '/api/load'",
    edits: [
      // 1) ROOTS / spriteIdx / scanEntries 改为 let，允许运行时重载
      { o: 'const ROOTS: Root[] = []', n: 'let ROOTS: Root[] = []' },
      { o: 'const spriteIdx = new SpriteIndex(ROOTS[0].path)', n: 'let spriteIdx = new SpriteIndex(ROOTS[0].path)' },
      { o: 'const scanEntries = ROOTS.map((r) => ({', n: 'let scanEntries = ROOTS.map((r) => ({' },

      // 2) 基础游戏为必需项：只给了 --mod 时补一个默认 vanilla 只读根。
      //    放在首位，因为 spriteIdx / scanEntries 都以 ROOTS[0] 为基准。
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

      // 3) rebuildIndexes()：重扫 sprite 索引 + 清空所有懒构建图缓存
      {
        o: 'const t0 = Date.now()',
        n:
          "const t0 = Date.now()\n\n" +
          'function rebuildIndexes() {\n' +
          "  scanEntries = ROOTS.map((r) => ({\n" +
          "    dir: join(r.path, 'interface'),\n" +
          '    gameRoot: r.path,\n' +
          "  })).filter((e) => existsSync(e.dir))\n" +
          "  spriteIdx = new SpriteIndex(ROOTS[0] && ROOTS[0].path ? ROOTS[0].path : '')\n" +
          '  if (ROOTS.length) spriteIdx.scanAll(scanEntries)\n' +
          '  texIds.clear(); texTable.clear(); texCache.clear()\n' +
          '  layoutCache.clear()\n' +
          '  LINK = null; LINK_ERR = \'\'; LINK_BUSY = false\n' +
          '  SYM = null; SYM_ERR = \'\'; SYM_BUSY = false\n' +
          '  FG = null; FG_ERR = \'\'; FG_BUSY = false\n' +
          '  CHECK = null; CHECK_ERR = \'\'; CHECK_BUSY = false\n' +
          '  TG = null; TG_ERR = \'\'; TG_BUSY = false\n' +
          '  DG = null; DG_ERR = \'\'; DG_BUSY = false\n' +
          "  console.log('  已重建索引: ' + ROOTS.length + ' 个来源')\n" +
          "  for (const r of ROOTS) console.log('    ' + (r.writable ? '[可写·模组]' : '[只读·游戏]') + ' ' + r.name + '  ' + r.path)\n" +
          '}',
      },

      // 4) POST /api/load —— base 必填、mod 可选，带路径存在性校验
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
          "          const mod = typeof req0.mod === 'string' ? req0.mod.trim() : ''\n" +
          "          if (!base) return send(res, 400, JSON.stringify({ error: '基础游戏路径为必填项' }))\n" +
          '          if (!existsSync(base)) return send(res, 400, JSON.stringify({ error: `基础游戏路径不存在: ${base}` }))\n' +
          "          if (mod && !existsSync(mod)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${mod}` }))\n" +
          '          const roots = []\n' +
          "          roots.push({ name: 'vanilla', path: base, writable: false })\n" +
          "          if (mod) roots.push({ name: basename(mod), path: mod, writable: true })\n" +
          '          if (READONLY) for (const r of roots) r.writable = false\n' +
          '          ROOTS.length = 0\n' +
          '          for (const r of roots) ROOTS.push(r)\n' +
          '          rebuildIndexes()\n' +
          "          return send(res, 200, JSON.stringify({ ok: true, roots: ROOTS.map((r) => ({ name: r.name, writable: r.writable })) }))\n" +
          '        } catch (e) {\n' +
          "          return send(res, 500, JSON.stringify({ error: String(e) }))\n" +
          '        }\n' +
          '      })\n' +
          '      return\n' +
          '    }\n' +
          "    if (p === '/api/config') {",
      },

      // 5) /api/files 每条附带 rootName + writable，前端据此区分来源
      {
        o: 'out.push({ root: i, file: relative(r.path, f)',
        n: 'out.push({ root: i, rootName: r.name, writable: r.writable, file: relative(r.path, f)',
      },

      // 6) /open 页面路由
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

  // 幂等：已打过补丁就跳过（--force 可强制重打）
  if (!FORCE && grp.marker && content.includes(grp.marker)) {
    console.log('• 已是最新，跳过: ' + grp.file);
    skipped++;
    continue;
  }

  // 先全量校验锚点，任一不匹配则整组放弃（不写半成品）
  let next = content;
  let groupOk = true;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '✗ 锚点不匹配 [' + grp.file + ']，出现次数=' + parts.length + '  期望=1。片段: ' +
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

/* open.html / open.js 每次整体重写（内容由本脚本提供，始终为最新） */
for (const [name, content] of [['public/open.html', OPEN_HTML], ['public/open.js', OPEN_JS]]) {
  const fp = path.join(DIR, name);
  if (DRY) {
    console.log('✓ 将写入(未写盘): ' + name + '  (' + content.length + ' 字节)');
  } else {
    fs.writeFileSync(fp, content, 'utf8');
    console.log('✓ 已写入: ' + name + '  (' + content.length + ' 字节)');
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
        '下一步：双击 run-gui.bat 启动，然后访问 http://localhost:5173/open.html 选择素材来源。'),
);
