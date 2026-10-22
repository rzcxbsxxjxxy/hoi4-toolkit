/* HOI4 GUI 设计器：让设计器能同时加载「基础游戏 + 模组」并区分来源。
 * 由用户在自己的终端运行（agent 沙箱对既有文件无写权限）：
 *   cd <repo>/packages/gui
 *   node apply_source_patch.cjs            # 真正应用
 *   node apply_source_patch.cjs --dry      # 仅校验锚点，不写盘
 * 该脚本只做精确字符串替换；任一锚点不匹配即整体中止，不会留下半改状态。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY = process.argv.includes('--dry');

// 每个文件一组编辑：o = 旧串(必须唯一出现一次)，n = 新串
const PATCH = [
  {
    file: 'src/server.ts',
    edits: [
      // 1) ROOTS 改为 let，允许运行时重载
      { o: 'const ROOTS: Root[] = []', n: 'let ROOTS: Root[] = []' },
      // 2) spriteIdx / scanEntries 改为 let（rebuildIndexes 会重赋值）
      { o: 'const spriteIdx = new SpriteIndex(ROOTS[0].path)', n: 'let spriteIdx = new SpriteIndex(ROOTS[0].path)' },
      { o: 'const scanEntries = ROOTS.map((r) => ({', n: 'let scanEntries = ROOTS.map((r) => ({' },
      // 3) 插入 rebuildIndexes()：重扫 sprite 索引并清空所有懒构建图
      {
        o: 'const t0 = Date.now()',
        n:
          "const t0 = Date.now()\n\n" +
          "function rebuildIndexes() {\n" +
          "  scanEntries = ROOTS.map((r) => ({\n" +
          "    dir: join(r.path, 'interface'),\n" +
          "    gameRoot: r.path,\n" +
          "  })).filter((e) => existsSync(e.dir))\n" +
          "  spriteIdx = new SpriteIndex(ROOTS[0] && ROOTS[0].path ? ROOTS[0].path : '')\n" +
          "  if (ROOTS.length) spriteIdx.scanAll(scanEntries)\n" +
          "  texIds.clear(); texTable.clear(); texCache.clear()\n" +
          "  LINK = null; LINK_ERR = ''; LINK_BUSY = false\n" +
          "  SYM = null; SYM_ERR = ''; SYM_BUSY = false\n" +
          "  FG = null; FG_ERR = ''; FG_BUSY = false\n" +
          "  CHECK = null; CHECK_ERR = ''; CHECK_BUSY = false\n" +
          "  TG = null; TG_ERR = ''; TG_BUSY = false\n" +
          "  DG = null; DG_ERR = ''; DG_BUSY = false\n" +
          "  console.log('rebuilt indexes for ' + ROOTS.length + ' roots')\n" +
          "  for (const r of ROOTS) console.log('  ' + (r.writable ? '[可写]' : '[只读]') + ' ' + r.name + '  ' + r.path)\n" +
          '}',
      },
      // 4) 新增 POST /api/load：运行时切换 base + mod 并重建索引
      {
        o: "    if (p === '/api/config') {",
        n:
          "    if (p === '/api/load' && req.method === 'POST') {\n" +
          "      let body = ''\n" +
          "      req.on('data', (c) => { body += c; if (body.length > 1000000) req.destroy() })\n" +
          "      req.on('end', () => {\n" +
          "        try {\n" +
          "          const req0 = JSON.parse(body || '{}')\n" +
          "          const roots = []\n" +
          "          if (req0.base && typeof req0.base === 'string') roots.push({ name: 'vanilla', path: req0.base, writable: false })\n" +
          "          if (req0.mod && typeof req0.mod === 'string') roots.push({ name: basename(req0.mod), path: req0.mod, writable: true })\n" +
          "          if (!roots.length) return send(res, 400, JSON.stringify({ error: '至少需要 base 或 mod 路径' }))\n" +
          "          if (READONLY) for (const r of roots) r.writable = false\n" +
          "          ROOTS.length = 0\n" +
          "          for (const r of roots) ROOTS.push(r)\n" +
          "          rebuildIndexes()\n" +
          "          return send(res, 200, JSON.stringify({ ok: true, roots: ROOTS.map((r) => ({ name: r.name, writable: r.writable })) }))\n" +
          "        } catch (e) {\n" +
          "          return send(res, 500, JSON.stringify({ error: String(e) }))\n" +
          '        }\n' +
          '      })\n' +
          '      return\n' +
          '    }\n\n' +
          "    if (p === '/api/config') {",
      },
      // 5) /api/files 每条附带 rootName + writable，便于前端区分来源
      {
        o: 'out.push({ root: i, file: relative(r.path, f)',
        n: 'out.push({ root: i, rootName: r.name, writable: r.writable, file: relative(r.path, f)',
      },
      // 6) 新增 /open 页面路由（open.html / open.js）
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
    edits: [
      // A1 注入来源标签样式
      {
        o: '    S.roots = cfg.roots;',
        n:
          "    S.roots = cfg.roots;\n" +
          "    const _st = document.createElement('style');\n" +
          "    _st.textContent = '.src-chip{display:inline-block;font-size:11px;line-height:1;padding:1px 5px;border-radius:6px;margin-right:6px;vertical-align:middle;color:#fff;font-weight:600}.src-chip.game{background:#3b6fb5}.src-chip.mod{background:#2f8f5b}';\n" +
          '    document.head.appendChild(_st);',
      },
      // A2 下拉框增加「全部来源」并标注 游戏/模组
      {
        o:
          "    $('#rootSel').innerHTML = cfg.roots\n" +
          "      .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '' : '（只读）'}</option>`)\n" +
          "      .join('');",
        n:
          "    $('#rootSel').innerHTML =\n" +
          "      '<option value=\"-1\">全部来源</option>' +\n" +
          "      cfg.roots\n" +
          "        .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)\n" +
          "        .join('');",
      },
      // A3 文件列表支持「全部来源」(root = -1)
      {
        o: '(f) => f.root === S.root && (!q || f.name.toLowerCase().includes(q))',
        n: '(f) => (S.root < 0 || f.root === S.root) && (!q || f.name.toLowerCase().includes(q))',
      },
      // A4 每个文件加来源标签（蓝=游戏 / 绿=模组）
      {
        o:
          "      const d = el('div', 'file-item' + (f.file === S.file ? ' on' : ''));\n" +
          "      d.textContent = f.name;",
        n:
          "      const d = el('div', 'file-item' + (f.file === S.file ? ' on' : ''));\n" +
          "      const r0 = S.roots[f.root] || {};\n" +
          "      const chip = el('span', 'src-chip' + (r0.writable ? ' mod' : ' game'));\n" +
          "      chip.textContent = r0.name || ('root' + f.root);\n" +
          "      d.appendChild(chip);\n" +
          "      d.appendChild(document.createTextNode(f.name));",
      },
    ],
  },
  {
    file: 'public/designer.js',
    edits: [
      // D1 下拉框增加「全部来源」并标注 游戏/模组
      {
        o:
          "    $('#rootSel').innerHTML = cfg.roots\n" +
          "      .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '' : '（只读）'}</option>`)\n" +
          "      .join('');",
        n:
          "    $('#rootSel').innerHTML =\n" +
          "      '<option value=\"-1\">全部来源</option>' +\n" +
          "      cfg.roots\n" +
          "        .map((r, i) => `<option value=\"${i}\">${r.name}${r.writable ? '（可写·模组）' : '（只读·游戏）'}</option>`)\n" +
          "        .join('');",
      },
      // D2 文件下拉：支持「全部来源」+ 选项前缀【游戏】/【模组】
      {
        o:
          '  function renderFileList() {\n' +
          "    const list = S.files.filter((f) => f.root === S.root);\n" +
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
          "      return `<option value=\"${cssEsc(f.file)}\">${tag}${f.name}</option>`;\n" +
          '    }).join(\'\');\n' +
          '    if (S.file) sel.value = S.file;\n' +
          '  }',
      },
    ],
  },
  {
    file: 'public/index.html',
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

let ok = true;
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
  let next = content;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '✗ 锚点不匹配 [' + grp.file + ']，出现次数=' + parts.length +
        '  期望=1。片段: ' + ed.o.slice(0, 70).replace(/\n/g, '\\n'),
      );
      ok = false;
      next = null;
      break;
    }
    next = next.split(ed.o).join(ed.n);
  }
  if (next === null) continue;
  if (DRY) {
    console.log('✓ 校验通过(未写盘): ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
  } else {
    fs.writeFileSync(fp, next, 'utf8');
    console.log('✓ 已应用: ' + grp.file + '  (' + grp.edits.length + ' 处编辑)');
  }
}

if (!ok) {
  console.log('\n存在锚点不匹配，未做任何修改。请检查上述文件是否为最新版本。');
  process.exit(1);
}
console.log('\n' + (DRY ? 'DRY-RUN 完成：所有锚点均匹配，可去掉 --dry 正式应用。' : '全部应用完成。重启 run-gui.bat 使改动生效。'));
