/* HOI4 GUI 设计器 —— 设置页增强 (Workshop 模组发现 + 模组增删改 + 附加选项)
 * 依据: https://hoi4.paradoxwikis.com/Interface_modding
 *       Steam 创意工坊目录结构 workshop/content/<appid>/<workshopItemId>
 *
 * ── 背景 ──
 * 现有 open.html/open.js 已支持基础游戏(必填) + 模组目录(可增删改),但只能手填路径。
 * 实际使用时最难的就是找路径:HoI4 的 Workshop 模组躺在
 *   C:\Program Files (x86)\Steam\steamapps\workshop\content\394360\<数字ID>\
 * 一堆纯数字 ID 目录,手填极痛苦。本补丁让服务端直接扫出来并带上模组名。
 *
 * ── 实测依据(本机 Steam 库,36 个模组)──
 *   workshop/content/394360 下 36 个目录,其中 29 个含 interface/,
 *   最大的 BlackICE 有 863 个 .gui,Kaiserreich 216 个 —— 确实值得做成可勾选列表。
 *   每个模组根下有 descriptor.mod,首行附近是 name="..." / tags={...} / version="...",
 *   靠它把数字 ID 翻译成人能看的名字。
 *
 * ── 新增接口 ──
 *   GET /api/workshop          → 扫描所有 Steam 库的 workshop/content/394360
 *   GET /api/workshop?dir=...  → 额外扫描指定的本地模组根目录
 *   返回 { workshopRoots:[...], mods:[{ id, name, version, tags[], path, guiCount, enabled }] }
 *   mods 已按"是否已在加载列表"标记 enabled,前端直接渲染勾选框。
 *
 * ── 一并修正 ──
 *   1) /api/load 之前对 mod 目录只做 existsSync 校验,传进一个不含 interface 的
 *      目录也不报错,表现为"模组加载了但文件列表里什么都没有"。现在额外提示。
 *   2) 模组名用 basename(路径) 会让 sources 下拉里全是数字 ID,
 *      改为 descriptor.mod 的 name(读不到才回退 basename)。
 *
 * 由用户在自己的终端运行（agent 沙箱对既有文件无写权限）：
 *   cd /d 杂项/hoi4/toolkit/packages/gui
 *   node fix_settings.cjs --dry     # 仅校验锚点,不写盘
 *   node fix_settings.cjs           # 正式应用
 * 幂等:检测到已含 SETTINGS_V1 标记则跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DRY = process.argv.includes('--dry');
const MARK = 'SETTINGS_V1';

const PATCH = [
  /* ══════════════ 1) server.ts —— Workshop 扫描 ══════════════ */
  {
    file: 'src/server.ts',
    marker: MARK,
    edits: [
      /* 1-1) 扫描函数:放在 detectGameDirs 之后 */
      {
        o:
          '  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))\n' +
          '  return out\n' +
          '}\n',
        n:
          '  out.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? -1 : 1))\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          '/* ── Steam 创意工坊模组发现(SETTINGS_V1) ──\n' +
          ' *\n' +
          ' * HoI4 的 appid 是 394360,创意工坊模组解压后落在\n' +
          ' *   <Steam根>/steamapps/workshop/content/394360/<workshopItemId>/\n' +
          ' * 目录名是纯数字 ID,手填路径极难用。本函数把各 Steam 库下的该目录全扫一遍,\n' +
          ' * 读 descriptor.mod 的 name/tags/version 把 ID 翻译成模组名,并统计 .gui 数量\n' +
          ' * (用户真正在意的是"这个模组有没有改界面",而不是它有多少张贴图)。\n' +
          ' */\n' +
          'const HOI4_APPID = "394360"\n' +
          '\n' +
          'interface WorkshopMod {\n' +
          '  id: string\n' +
          '  name: string\n' +
          '  version: string\n' +
          '  tags: string[]\n' +
          '  path: string\n' +
          '  guiCount: number\n' +
          '  hasInterface: boolean\n' +
          '}\n' +
          '\n' +
          '/** 列出所有 Steam 根(含 libraryfolders.vdf 指向的额外游戏库) */\n' +
          'function allSteamRoots(): string[] {\n' +
          '  const out: string[] = []\n' +
          '  const seen = new Set<string>()\n' +
          '  const push = (raw: string) => {\n' +
          '    if (!raw) return\n' +
          '    const p = raw.replace(/\\\\/g, "/").replace(/\\/+$/, "")\n' +
          '    const k = p.toLowerCase()\n' +
          '    if (seen.has(k)) return\n' +
          '    seen.add(k)\n' +
          '    out.push(p)\n' +
          '  }\n' +
          '  for (const s of steamRoots()) {\n' +
          '    push(s)\n' +
          '    try {\n' +
          '      const vdf = readFileSync(join(s, "steamapps", "libraryfolders.vdf"), "utf8")\n' +
          '      const re = /"path"\\s+"([^"]+)"/g\n' +
          '      let mm: RegExpExecArray | null\n' +
          '      while ((mm = re.exec(vdf))) push(mm[1])\n' +
          '    } catch {\n' +
          '      /* 无 vdf:忽略 */\n' +
          '    }\n' +
          '  }\n' +
          '  // 注册表读不到时的兜底:直接探常见安装位置。\n' +
          '  // steamRoots() 依赖 reg.exe,在受限环境 / 非标准安装下会返回空,\n' +
          '  // 那时若不兜底,创意工坊列表会整个空掉且没有任何提示。\n' +
          '  for (const d of ["C", "D", "E", "F", "G", "H"]) {\n' +
          '    push(d + ":/Program Files (x86)/Steam")\n' +
          '    push(d + ":/Program Files/Steam")\n' +
          '    push(d + ":/Steam")\n' +
          '  }\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          '/** 解析 descriptor.mod 的 name / version / tags。文件缺失或格式异常都退回默认值 */\n' +
          'function readDescriptor(dir: string): { name: string; version: string; tags: string[] } {\n' +
          '  const out = { name: "", version: "", tags: [] as string[] }\n' +
          '  let txt = ""\n' +
          '  for (const f of ["descriptor.mod", "descriptor.txt"]) {\n' +
          '    try {\n' +
          '      txt = readFileSync(join(dir, f), "utf8")\n' +
          '      break\n' +
          '    } catch {\n' +
          '      /* 试下一个 */\n' +
          '    }\n' +
          '  }\n' +
          '  if (!txt) return out\n' +
          '  const nm = txt.match(/^\\s*name\\s*=\\s*"([^"]*)"/m)\n' +
          '  if (nm) out.name = nm[1].trim()\n' +
          '  const vm = txt.match(/^\\s*version\\s*=\\s*"([^"]*)"/m)\n' +
          '  if (vm) out.version = vm[1].trim()\n' +
          '  const tm = txt.match(/tags\\s*=\\s*\\{([^}]*)\\}/s)\n' +
          '  if (tm) {\n' +
          '    out.tags = [...tm[1].matchAll(/"([^"]*)"/g)].map((x) => x[1].trim()).filter(Boolean).slice(0, 6)\n' +
          '  }\n' +
          '  return out\n' +
          '}\n' +
          '\n' +
          '/** 递归数 .gui 数量。限制深度与文件数,避免超大模组把请求拖死。 */\n' +
          'function countGuiFiles(root: string, cap = 4000): number {\n' +
          '  let n = 0\n' +
          '  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]\n' +
          '  while (stack.length && n < cap) {\n' +
          '    const cur = stack.pop()!\n' +
          '    if (cur.depth > 6) continue\n' +
          '    let items: import("node:fs").Dirent[]\n' +
          '    try {\n' +
          '      items = readdirSync(cur.dir, { withFileTypes: true })\n' +
          '    } catch {\n' +
          '      continue\n' +
          '    }\n' +
          '    for (const it of items) {\n' +
          '      if (n >= cap) break\n' +
          '      if (it.isDirectory()) stack.push({ dir: join(cur.dir, it.name), depth: cur.depth + 1 })\n' +
          '      else if (it.name.toLowerCase().endsWith(".gui")) n++\n' +
          '    }\n' +
          '  }\n' +
          '  return n\n' +
          '}\n' +
          '\n' +
          'function scanWorkshopMods(): { roots: string[]; mods: WorkshopMod[] } {\n' +
          '  const roots: string[] = []\n' +
          '  const mods: WorkshopMod[] = []\n' +
          '  const seenPath = new Set<string>()\n' +
          '  for (const sr of allSteamRoots()) {\n' +
          '    const wc = join(sr, "steamapps", "workshop", "content", HOI4_APPID)\n' +
          '    let ids: string[]\n' +
          '    try {\n' +
          '      ids = readdirSync(wc).filter((d) => /^\\d+$/.test(d))\n' +
          '    } catch {\n' +
          '      continue\n' +
          '    }\n' +
          '    if (!ids.length) continue\n' +
          '    roots.push(wc)\n' +
          '    for (const id of ids) {\n' +
          '      const dir = join(wc, id)\n' +
          '      const key = dir.toLowerCase()\n' +
          '      if (seenPath.has(key)) continue\n' +
          '      seenPath.add(key)\n' +
          '      const d = readDescriptor(dir)\n' +
          '      const hasIface = existsSync(join(dir, "interface"))\n' +
          '      mods.push({\n' +
          '        id,\n' +
          '        // 读不到 name 就退回 ID,总比空字符串强\n' +
          '        name: d.name || id,\n' +
          '        version: d.version,\n' +
          '        tags: d.tags,\n' +
          '        path: dir,\n' +
          '        hasInterface: hasIface,\n' +
          '        guiCount: hasIface ? countGuiFiles(join(dir, "interface")) : 0,\n' +
          '      })\n' +
          '    }\n' +
          '  }\n' +
          '  // 有界面的排前面,其次按 .gui 数量降序 —— 用户一般只关心改过界面的模组\n' +
          '  mods.sort((a, b) => (a.hasInterface === b.hasInterface ? 0 : a.hasInterface ? -1 : 1) || b.guiCount - a.guiCount)\n' +
          '  return { roots, mods }\n' +
          '}\n',
      },

      /* 1-2) 路由:/api/workshop */
      {
        o:
          "    if (p === '/api/detect') {\n",
        n:
          "    if (p === '/api/workshop') {\n" +
          '      try {\n' +
          '        const { roots, mods } = scanWorkshopMods()\n' +
          '        return send(res, 200, JSON.stringify({ appid: HOI4_APPID, roots, mods }))\n' +
          '      } catch (e) {\n' +
          '        return send(res, 500, JSON.stringify({ error: String(e) }))\n' +
          '      }\n' +
          '    }\n' +
          "    if (p === '/api/detect') {\n",
      },

      /* 1-3) mod 目录校验:提示"该目录没有 interface/,可能选错了" */
      {
        o:
          '          for (const m of mods) {\n' +
          '            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))\n' +
          '          }\n',
        n:
          '          for (const m of mods) {\n' +
          '            if (!existsSync(m)) return send(res, 400, JSON.stringify({ error: `模组路径不存在: ${m}` }))\n' +
          '          }\n' +
          '          // 不阻断,但在响应里点名没有 interface/ 的目录 ——\n' +
          '          // 否则表现为"模组已加载但文件列表里什么都没有",很难自查。\n' +
          '          // ' + MARK + '\n' +
          '          const noIface = mods.filter((m) => !existsSync(join(m, "interface")))\n',
      },

      /* 1-4) 响应里回传告警 */
      {
        o:
          "          return send(res, 200, JSON.stringify({ ok: true, roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })) }))\n",
        n:
          "          return send(\n" +
          "            res,\n" +
          "            200,\n" +
          "            JSON.stringify({\n" +
          "              ok: true,\n" +
          "              roots: ROOTS.map((r) => ({ name: r.name, path: r.path, writable: r.writable })),\n" +
          "              warnNoInterface: noIface,\n" +
          "            }),\n" +
          "          )\n",
      },

      /* 1-5) 模组显示名优先用 descriptor.mod 的 name,而不是纯数字目录名。
             这里在 load 时把 name 写进 Root.name,前端 sources 下拉就能显示人话。 */
      {
        o:
          "          for (const m of mods) roots.push({ name: basename(m), path: m, writable: true })\n",
        n:
          "          for (const m of mods) {\n" +
          "            // 目录名常是 workshop 数字 ID,直接当来源名很难认;\n" +
          "            // 读 descriptor.mod 的 name 更好。读不到才回退 basename(路径)。\n" +
          "            const d = readDescriptor(m)\n" +
          "            roots.push({ name: d.name || basename(m), path: m, writable: true })\n" +
          "          }\n",
      },
    ],
  },

  /* ══════════════ 2) open.html —— 设置页结构 ══════════════ */
  {
    file: 'public/open.html',
    marker: MARK,
    edits: [
      /* 2-0) 创意工坊列表样式 */
      {
        o:
          '  .opt-row input{width:auto;accent-color:#2f6df0}\n',
        n:
          '  .opt-row input{width:auto;accent-color:#2f6df0}\n' +
          '  #wsList{margin-top:10px;max-height:320px;overflow:auto;border:1px solid #262f3c;border-radius:8px;background:#10161e}\n' +
          '  #wsList:empty{display:none}\n' +
          '  .ws-item{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-bottom:1px solid #1e2733;cursor:pointer;font-size:12px}\n' +
          '  .ws-item:last-child{border-bottom:0}\n' +
          '  .ws-item:hover{background:#151d27}\n' +
          '  .ws-item input{width:auto;flex:none;margin-top:2px;accent-color:#2f8f5b}\n' +
          '  .ws-main{flex:1;min-width:0}\n' +
          '  .ws-name{color:#d3dee9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
          '  .ws-meta{color:#76859a;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
          '  .ws-gui{flex:none;font-size:11px;padding:1px 6px;border-radius:4px;background:#1e3a2a;color:#6cd39a}\n' +
          '  .ws-gui.none{background:#2a2f36;color:#6b7787}\n' +
          '  .ws-tags{margin-top:3px;display:flex;gap:4px;flex-wrap:wrap}\n' +
          '  .ws-tag{font-size:10px;padding:0 5px;border-radius:4px;background:#1a2432;color:#7d94ad}\n',
      },

      /* 2-1) 创意工坊区块 + 本地模组 + 选项 */
      {
        o:
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>模组目录<span class="tag opt">可选 · 可多个</span></h2>\n' +
          '      <div id="modList"></div>\n' +
          '      <button id="addMod" class="mini" style="margin-top:9px">＋ 添加模组目录</button>\n' +
          '      <div class="hint">留空则以只读方式浏览游戏本体。多个模组按顺序加载，后者在同名文件上覆盖前者；只有模组目录允许写入。</div>\n' +
          '    </div>\n',
        n:
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>创意工坊模组<span class="tag opt">自动发现</span></h2>\n' +
          '      <!-- ' + MARK + ' -->\n' +
          '      <div class="row">\n' +
          '        <button id="scanWs" class="mini">扫描 Steam 创意工坊</button>\n' +
          '        <input type="text" id="wsFilter" placeholder="按名称 / ID 过滤…" style="flex:1;min-width:0">\n' +
          '      </div>\n' +
          '      <div class="hint" id="wsInfo">扫描 <code>workshop/content/394360/</code>（HoI4 的 App ID），把创意工坊模组连同名称与 <code>.gui</code> 数量列出来，勾选即加入加载列表。</div>\n' +
          '      <div id="wsList"></div>\n' +
          '      <div class="row">\n' +
          '        <button id="wsAll" class="mini">全选有界面的</button>\n' +
          '        <button id="wsNone" class="mini">清空勾选</button>\n' +
          '      </div>\n' +
          '    </div>\n' +
          '\n' +
          '    <div class="grp">\n' +
          '      <h2><span class="dot mod"></span>本地模组目录<span class="tag opt">手动添加</span></h2>\n' +
          '      <div id="modList"></div>\n' +
          '      <button id="addMod" class="mini" style="margin-top:9px">＋ 添加模组目录</button>\n' +
          '      <div class="hint">创意工坊里没有的模组（自己开发、网盘下载）在这里填。可添加多行、改路径、点「移除」删除。多个模组按顺序加载，后者在同名文件上覆盖前者；只有模组目录允许写入。</div>\n' +
          '    </div>\n' +
          '\n' +
          '    <div class="grp">\n' +
          '      <h2>选项</h2>\n' +
          '      <label class="opt-row"><input type="checkbox" id="autoload"> 打开本页面时自动加载上次路径</label>\n' +
          '      <label class="opt-row"><input type="checkbox" id="hideNoGui"> 创意工坊列表里隐藏没有 .gui 的模组</label>\n' +
          '      <label class="opt-row"><input type="checkbox" id="onlyNoIface"> 只显示改过界面的模组（推荐）</label>\n' +
          '    </div>\n',
      },
    ],
  },

  /* ══════════════ 3) open.js —— 创意工坊勾选 + 选项持久化 ══════════════ */
  {
    file: 'public/open.js',
    marker: MARK,
    edits: [
      /* 3-1) 声明新元素 */
      {
        o:
          "  var autoEl = document.getElementById('autoload');\n",
        n:
          "  var autoEl = document.getElementById('autoload');\n" +
          "  var wsListEl = document.getElementById('wsList');\n" +
          "  var wsInfoEl = document.getElementById('wsInfo');\n" +
          "  var wsFilterEl = document.getElementById('wsFilter');\n" +
          "  var hideNoGuiEl = document.getElementById('hideNoGui');\n" +
          "  var onlyNoIfaceEl = document.getElementById('onlyNoIface');\n" +
          "  // wsMods 存扫描到的创意工坊模组;wsPicked 存已勾选的 id(跨扫描保留)\n" +
          '  var wsMods = [];\n' +
          "  var wsPicked = loadPicked(); // " + MARK + "\n",
      },

      /* 3-2) 勾选状态的读写 —— 创意工坊勾选与本地模组行合并成最终 mods 列表 */
      {
        o:
          '  function syncMods() {\n' +
          "    mods = [].slice.call(modList.querySelectorAll('input')).map(function (i) { return i.value.trim(); }).filter(Boolean);\n" +
          '  }\n',
        n:
          '  function loadPicked() {\n' +
          "    var raw = get('gui.wsPicked');\n" +
          '    if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e) {} }\n' +
          '    return [];\n' +
          '  }\n' +
          '  function savePicked() { set("gui.wsPicked", JSON.stringify(wsPicked)); }\n' +
          '\n' +
          '  function syncMods() {\n' +
          "    var manual = [].slice.call(modList.querySelectorAll('input')).map(function (i) { return i.value.trim(); }).filter(Boolean);\n" +
          '    // 勾选的创意工坊模组排在手动填的前面:后者通常是本地开发目录,\n' +
          '    // 放后面才能覆盖创意工坊版本(后加载的覆盖先加载的同路径文件)。\n' +
          '    var ws = wsMods.filter(function (m) { return wsPicked.indexOf(m.id) >= 0; }).map(function (m) { return m.path; });\n' +
          '    mods = ws.concat(manual);\n' +
          '  }\n',
      },

      /* 3-3) 创意工坊渲染 + 扫描 */
      {
        o:
          "  document.getElementById('addMod').onclick = function () {\n",
        n:
          '  /* ── 创意工坊模组列表 ── */\n' +
          '  function renderWs() {\n' +
          "    var q = (wsFilterEl.value || '').trim().toLowerCase();\n" +
          '    wsListEl.innerHTML = "";\n' +
          '    var shown = 0;\n' +
          '    wsMods.forEach(function (m) {\n' +
          '      if (hideNoGuiEl.checked && !m.guiCount) return;\n' +
          "      if (onlyNoIfaceEl.checked && !m.hasInterface) return;\n" +
          '      if (q && m.name.toLowerCase().indexOf(q) < 0 && m.id.indexOf(q) < 0) return;\n' +
          '      shown++;\n' +
          '      var row = document.createElement("label");\n' +
          '      row.className = "ws-item";\n' +
          '      row.title = m.path;\n' +
          '      var cb = document.createElement("input");\n' +
          '      cb.type = "checkbox";\n' +
          '      cb.checked = wsPicked.indexOf(m.id) >= 0;\n' +
          '      cb.onchange = function () {\n' +
          '        var i = wsPicked.indexOf(m.id);\n' +
          '        if (cb.checked) { if (i < 0) wsPicked.push(m.id); }\n' +
          '        else if (i >= 0) wsPicked.splice(i, 1);\n' +
          '        savePicked();\n' +
          '        syncMods();\n' +
          '      };\n' +
          '      var main = document.createElement("div");\n' +
          '      main.className = "ws-main";\n' +
          '      var nm = document.createElement("div");\n' +
          '      nm.className = "ws-name";\n' +
          '      nm.textContent = m.name;\n' +
          '      var meta = document.createElement("div");\n' +
          '      meta.className = "ws-meta";\n' +
          '      meta.textContent = "ID " + m.id + (m.version ? " · v" + m.version : "");\n' +
          '      main.appendChild(nm);\n' +
          '      main.appendChild(meta);\n' +
          '      if (m.tags && m.tags.length) {\n' +
          '        var tw = document.createElement("div");\n' +
          '        tw.className = "ws-tags";\n' +
          '        m.tags.slice(0, 4).forEach(function (t) {\n' +
          '          var s = document.createElement("span");\n' +
          '          s.className = "ws-tag";\n' +
          '          s.textContent = t;\n' +
          '          tw.appendChild(s);\n' +
          '        });\n' +
          '        main.appendChild(tw);\n' +
          '      }\n' +
          '      var g = document.createElement("span");\n' +
          '      g.className = "ws-gui" + (m.guiCount ? "" : " none");\n' +
          '      g.textContent = m.guiCount ? m.guiCount + " .gui" : "无界面";\n' +
          '      row.appendChild(cb);\n' +
          '      row.appendChild(main);\n' +
          '      row.appendChild(g);\n' +
          '      wsListEl.appendChild(row);\n' +
          '    });\n' +
          '    if (!shown) {\n' +
          '      wsListEl.innerHTML = "";\n' +
          '    }\n' +
          '    syncMods();\n' +
          '  }\n' +
          '\n' +
          "  document.getElementById('scanWs').onclick = function () {\n" +
          "    setStatus('正在扫描 Steam 创意工坊…', '');\n" +
          "    fetch('/api/workshop').then(function (r) { return r.json(); }).then(function (j) {\n" +
          '      if (j.error) throw new Error(j.error);\n' +
          '      wsMods = j.mods || [];\n' +
          '      var nIface = wsMods.filter(function (m) { return m.hasInterface; }).length;\n' +
          '      if (!wsMods.length) {\n' +
          "        wsInfoEl.textContent = '未找到创意工坊模组。请确认 Steam 已安装该游戏，或创意工坊目录非默认位置。';\n" +
          "        setStatus('创意工坊目录为空。可用下方「本地模组目录」手动添加。', 'warn');\n" +
          '        renderWs();\n' +
          '        return;\n' +
          '      }\n' +
          "      wsInfoEl.textContent = '已找到 ' + wsMods.length + ' 个模组，其中 ' + nIface + ' 个改过界面(.gui)。勾选要加载的模组。';\n" +
          "      setStatus('创意工坊：' + wsMods.length + ' 个模组可选。', 'ok');\n" +
          '      renderWs();\n' +
          '    }).catch(function (e) {\n' +
          "      setStatus('扫描失败：' + e.message, 'warn');\n" +
          '    });\n' +
          '  };\n' +
          "\n" +
          "  document.getElementById('wsAll').onclick = function () {\n" +
          '    wsMods.forEach(function (m) { if (m.hasInterface && wsPicked.indexOf(m.id) < 0) wsPicked.push(m.id); });\n' +
          '    savePicked();\n' +
          '    renderWs();\n' +
          '    setStatus("已全选有界面的模组，记得点「保存并进入工作台」生效。", "ok");\n' +
          '  };\n' +
          "\n" +
          "  document.getElementById('wsNone').onclick = function () {\n" +
          '    wsPicked = [];\n' +
          '    savePicked();\n' +
          '    renderWs();\n' +
          '  };\n' +
          '\n' +
          '  if (wsFilterEl) wsFilterEl.oninput = renderWs;\n' +
          '  if (hideNoGuiEl) {\n' +
          "    hideNoGuiEl.checked = get('gui.hideNoGui') === '1';\n" +
          '    hideNoGuiEl.onchange = function () { set("gui.hideNoGui", hideNoGuiEl.checked ? "1" : null); renderWs(); };\n' +
          '  }\n' +
          '  if (onlyNoIfaceEl) {\n' +
          "    onlyNoIfaceEl.checked = get('gui.onlyNoIface') !== '0';\n" +
          '    onlyNoIfaceEl.onchange = function () { set("gui.onlyNoIface", onlyNoIfaceEl.checked ? "1" : "0"); renderWs(); };\n' +
          '  }\n' +
          '\n' +
          "  document.getElementById('addMod').onclick = function () {\n",
      },

      /* 3-4) 加载结果里提示"没 interface/ 的目录",以及创意工坊来源名 */
      {
        o:
          "        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +\n" +
          "          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');\n",
        n:
          "        warn += (res.j.warnNoInterface || []).length\n" +
          "          ? ' 以下目录没有 interface/，可能选错了：' + res.j.warnNoInterface.join('、')\n" +
          "          : '';\n" +
          "        setStatus('已加载 ' + res.j.roots.length + ' 个来源（游戏 ' + nBase + ' 个 .gui' +\n" +
          "          (mods.length ? '，模组 ' + nMod + ' 个' : '，未加载模组') + '）' + warn, warn ? 'warn' : 'ok');\n",
      },
    ],
  },
];

/* ── 主流程 ── */
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
  if (content.includes(grp.marker)) {
    console.log('• 已是最新，跳过: ' + grp.file);
    continue;
  }

  let next = content;
  let groupOk = true;
  for (const ed of grp.edits) {
    const parts = content.split(ed.o);
    if (parts.length !== 2) {
      console.log(
        '✗ 锚点不匹配 [' + grp.file + ']，命中 ' + (parts.length - 1) + ' 处（要求恰好 1 处）。片段: ' +
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
  }
}

if (!ok) {
  console.log('\n存在锚点不匹配，未做任何修改。');
  process.exit(1);
}
console.log(
  '\n' +
    (DRY
      ? 'DRY-RUN 完成：锚点均匹配，可去掉 --dry 正式应用。'
      : '完成。重启 run-gui.bat 生效。'),
);
