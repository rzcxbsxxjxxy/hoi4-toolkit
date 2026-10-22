// build-frontend.cjs — 前端打包(逐页保序 concat 普通全局脚本 + esbuild bundle module 脚本)
// 动态端点(i18n-dict.js)不 concat,保留独立 <script>。
"use strict";
const fs = require('fs')
const path = require('path')
const esbuild = require('D:/杂项/hoi4/toolkit-electron/node_modules/esbuild')

const DYNAMIC = new Set(['i18n-dict.js']) // server 动态合成端点,保留独立 script

async function main() {
  const PUBLIC = path.resolve(process.argv[2] || 'D:/杂项/hoi4/toolkit-electron/packages/gui/public')
  const OUT = path.join(PUBLIC, 'bundles')
  fs.mkdirSync(OUT, { recursive: true })
  const ts = Date.now().toString(36)
  const report = {}
  const htmls = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html')).sort()

  for (const h of htmls) {
    const file = path.join(PUBLIC, h)
    const t = fs.readFileSync(file, 'utf8')
    const name = h.replace(/\.html$/, '')
    const re = /<script\b[^>]*>[\s\S]*?<\/script>/g
    const blocks = t.match(re) || []
    const srcScripts = []
    blocks.forEach((b) => {
      const am = /<script\b([^>]*)>/.exec(b)
      const attrs = am ? am[1] : ''
      const srcM = /src="([^"]+)"/.exec(attrs)
      if (!srcM) return
      const isModule = /type\s*=\s*["']module["']/.test(attrs)
      const clean = srcM[1].split('?')[0].replace(/^\//, '')
      srcScripts.push({ block: b, src: srcM[1], file: clean, module: isModule, attrs })
    })
    const normAll = srcScripts.filter(s => !s.module)
    const mod = srcScripts.filter(s => s.module)
    const isAsync = (a) => /(?:^|\s)(async|defer)(?:\s|$)/.test(a || '')
    const norm = normAll.filter(s => !DYNAMIC.has(s.file) && !isAsync(s.attrs)) // concatable 静态同步普通脚本
    const keptDyn = normAll.filter(s => DYNAMIC.has(s.file)) // 保留独立(动态端点)
    const keptAsync = normAll.filter(s => !DYNAMIC.has(s.file) && isAsync(s.attrs)) // 保留独立(async/defer 保时序)
    const missing = []
    let normUrl = null
    if (norm.length) {
      let body = ''
      for (const s of norm) {
        // ★ 自引用解环:HTML 往往直接引用本页打包产物 bundles/<name>.bundle.js,
        //   若不处理,build 会把"上一次的产物"再 concat 一遍 → 源 worldmap.js 的改动永远进不了包。
        //   解法是读旧包里的 `/* ==== file.js ==== */` 标记,还原出原始源文件清单,再实时重读源文件。
        let files = [s.file]
        if (s.file.startsWith('bundles/') && s.file.endsWith('.bundle.js')) {
          const base = s.file.slice('bundles/'.length, -'.bundle.js'.length)
          if (base === name) {
            const oldB = path.join(PUBLIC, s.file)
            if (fs.existsSync(oldB)) {
              const txt = fs.readFileSync(oldB, 'utf8')
              const srcs = []
              const re = /\/\*\s*====\s*([^=]+?)\s*====\s*\*\//g
              let m
              while ((m = re.exec(txt))) { const f = m[1].trim(); if (f && !f.startsWith('bundles/') && fs.existsSync(path.join(PUBLIC, f))) srcs.push(f) }
              if (srcs.length) files = srcs
            }
          }
        }
        for (const f of files) {
          const sp = path.join(PUBLIC, f)
          if (!fs.existsSync(sp)) { missing.push(f); continue }
          body += `/* ==== ${f} ==== */\n${fs.readFileSync(sp, 'utf8')}\n;\n`
        }
      }
      const bf = path.join(OUT, `${name}.bundle.js`)
      fs.writeFileSync(bf, body, 'utf8')
      normUrl = `/bundles/${name}.bundle.js?v=${ts}`
    }
    let modUrl = null
    if (mod.length) {
      const bf = path.join(OUT, `${name}.bundle.mjs`)
      // ★ module 脚本同样要"自解环":HTML 常直接引用本页打包产物
      //   bundles/<name>.bundle.mjs。若把它当 entry,esbuild 会把**上一次**
      //   的产物再打一遍(源 defines.js 的改动永远进不了包),甚至报
      //   "Refusing to overwrite input file"(输入=输出)。
      //   解法:把 bundles/<name>.bundle.mjs 还原成同名源 <name>.js。
      const modFiles = mod.map((s) => {
        const f = s.file
        if (f.startsWith('bundles/') && f.endsWith('.bundle.mjs')) {
          const base = f.slice('bundles/'.length, -'.bundle.mjs'.length)
          if (base === name) {
            const src = base + '.js'
            if (fs.existsSync(path.join(PUBLIC, src))) return src
          }
        }
        return f
      })
      // ★ 输出前先删旧产物(esbuild 的 outfile 与输入同目录会拒绝覆盖)
      try { if (fs.existsSync(bf)) fs.rmSync(bf, { force: true }) } catch (e) {}
      try {
        if (modFiles.length === 1) {
          await esbuild.build({ entryPoints: [path.join(PUBLIC, modFiles[0])], outfile: bf, bundle: true, format: 'esm', target: 'es2020', sourcemap: false, logLevel: 'silent', allowOverwrite: true })
        } else {
          const entry = path.join(OUT, `_${name}.entry.js`)
          fs.writeFileSync(entry, modFiles.map((f) => `export * from ${JSON.stringify('../' + f.replace(/\.js$/, ''))};`).join('\n'))
          await esbuild.build({ entryPoints: [entry], outfile: bf, bundle: true, format: 'esm', target: 'es2020', sourcemap: false, logLevel: 'silent', allowOverwrite: true })
          fs.rmSync(entry, { force: true })
        }
        modUrl = `/bundles/${name}.bundle.mjs?v=${ts}`
      } catch (e) { console.error(`  !! ${h} esbuild fail: ${e.message}`) }
    }
    report[h] = { name, normUrl, modUrl, norm: norm.map(s => s.file), keptDyn: keptDyn.map(s => s.file), keptAsync: keptAsync.map(s => s.file), mod: mod.map(s => s.file), missing }
    const kb = normUrl ? (fs.statSync(path.join(OUT, `${name}.bundle.js`)).size / 1024).toFixed(0) : 0
    console.log(`${h}: norm=${norm.length}->${kb}KB dyn=${keptDyn.map(s=>s.file).join(',')||'-'} async=${keptAsync.map(s=>s.file).join(',')||'-'} mod=${mod.length}${modUrl ? '->mjs' : ''}${missing.length ? ' MISSING:' + missing.join(',') : ''}`)
  }
  fs.writeFileSync(path.join(OUT, 'bundles-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('\nreport -> ' + path.join(OUT, 'bundles-report.json'))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
