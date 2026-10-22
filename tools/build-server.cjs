#!/usr/bin/env node
/* ============================================================================
 * build-server.cjs — 后端打包脚本(开发态)
 *
 * 两种模式:
 *   默认    : 带源码哈希缓存。对 server.ts / worker-entry.ts 依赖树做 dirSig 摘要,
 *             签名未变且产物已存在 → 打印 cache hit 跳过 esbuild;否则全量重打包并写回缓存。
 *   --watch : 递归监听 packages 下相关源码目录,变动后自动重打包两个 mjs 并热重启
 *             后端子进程(spawn node 跑 server.mjs,旧进程用进程对象 kill 干净再起新的)。
 *
 * 环境变量:
 *   HOI4TK_BUILD_OUT  产物输出目录(默认项目根,即 server.mjs/worker-entry.mjs)。
 *                     联调/CI 时指向临时目录,避免覆盖正式构建产物。
 *   HOI4TK_DATA       数据根(默认 %APPDATA%\hoi4-toolkit);缓存状态写在 <数据根>/temp/build-cache.json。
 *   PORT              watch 模式后端端口(默认 5199,避开日常开发 5173)。
 * ============================================================================ */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const esbuild = require("esbuild");

const WATCH_DIRS = [
  "packages/gui/src",
  "packages/engine/src",
  "packages/parser/src",
  "packages/focus/src",
  "packages/cli/src",
].map((d) => path.join(ROOT, d));

// worker-entry 还会经 worker-pool/job-builders 动态 import cli 引擎文件,签名口径略宽
const SERVER_DIRS = WATCH_DIRS.slice(0, 4);
const WORKER_DIRS = WATCH_DIRS;

const OUT_DIR = process.env.HOI4TK_BUILD_OUT
  ? path.resolve(process.env.HOI4TK_BUILD_OUT)
  : ROOT;
const DATA_ROOT = process.env.HOI4TK_DATA
  || path.join(process.env.APPDATA || os.homedir(), "hoi4-toolkit");
const CACHE_FILE = path.join(DATA_ROOT, "temp", "build-cache.json");

// ---- dirSig:复刻 packages/gui/src/cache.ts 的 FNV-1a 摘要(轻量重写,不 import TS) ----
function fnv(parts) {
  let h = 0x811c9dc5;
  for (const s of parts) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0xff;
  }
  return h.toString(36);
}
function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walkFiles(p, out); continue; }
    if (!e.isFile()) continue;
    if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
    out.push(p);
  }
}
function dirSig(dirs) {
  const files = [];
  for (const d of dirs) if (fs.existsSync(d)) walkFiles(d, files);
  let count = 0, sizeSum = 0, mtimeMax = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      count++;
      sizeSum += st.size;
      const mt = Math.round(st.mtimeMs / 1000);
      if (mt > mtimeMax) mtimeMax = mt;
    } catch { /* 读不到就跳过 */ }
  }
  return fnv([...dirs.map((d) => path.relative(ROOT, d)), String(count), String(sizeSum), String(mtimeMax)]);
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn("[build] 写缓存失败:", e.message); }
}

async function bundleOne(entry, outfile) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    logLevel: "warning",
  });
}

async function buildAll(reason) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`[build] 全量打包 ${reason || ""}`.trim());
  await bundleOne(path.join(ROOT, "packages/gui/src/server.ts"), path.join(OUT_DIR, "server.mjs"));
  await bundleOne(path.join(ROOT, "packages/gui/src/worker-entry.ts"), path.join(OUT_DIR, "worker-entry.mjs"));
  console.log(`[build] 完成,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT_DIR}`);
}

// ---- 默认模式:带缓存的一次构建 ----
async function runOnce() {
  const sigServer = dirSig(SERVER_DIRS);
  const sigWorker = dirSig(WORKER_DIRS);
  const prev = loadCache();
  const serverOut = path.join(OUT_DIR, "server.mjs");
  const workerOut = path.join(OUT_DIR, "worker-entry.mjs");
  const hit = prev.sigServer === sigServer
    && prev.sigWorker === sigWorker
    && fs.existsSync(serverOut)
    && fs.existsSync(workerOut);
  if (hit) {
    console.log(`[build] cache hit (sig=${sigServer}/${sigWorker}) — 跳过 esbuild`);
    return;
  }
  console.log(`[build] cache miss (prev=${prev.sigServer || "-"}/${prev.sigWorker || "-"} cur=${sigServer}/${sigWorker})`);
  await buildAll("源码签名变化");
  saveCache({ sigServer, sigWorker, ts: Date.now() });
}

// ---- --watch 模式:监听 + 热重启后端 ----
let child = null;
let restartTimer = null;
let restarting = false;

function startBackend() {
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5199;
  const serverOut = path.join(OUT_DIR, "server.mjs");
  if (!fs.existsSync(serverOut)) { console.warn("[watch] server.mjs 不存在,先构建"); return; }
  child = spawn(process.execPath, [serverOut], {
    env: { ...process.env, PORT: String(port), HOI4TK_DATA: DATA_ROOT },
    stdio: "inherit",
  });
  child.on("exit", (code) => { if (child) console.log(`[watch] 后端退出 code=${code}`); });
  console.log(`[watch] 后端已启动 pid=${child.pid} port=${port}`);
}

function killBackend() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) { child = null; return resolve(); }
    const c = child; child = null;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    c.once("exit", finish);
    try { c.kill(); } catch { /* already gone */ }
    setTimeout(finish, 1500); // Windows 上兜底:杀不掉也别死等
  });
}

async function rebuildAndRestart() {
  if (restarting) return;
  restarting = true;
  try {
    await killBackend();
    await buildAll("源码变动");
    const sigServer = dirSig(SERVER_DIRS);
    const sigWorker = dirSig(WORKER_DIRS);
    saveCache({ sigServer, sigWorker, ts: Date.now() });
    startBackend();
  } catch (e) {
    console.error("[watch] 重打包失败:", e.message);
  } finally {
    restarting = false;
  }
}

function scheduleRebuild() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { restartTimer = null; rebuildAndRestart(); }, 400);
}

async function runWatch() {
  // 首次构建(走缓存)
  await runOnce();
  startBackend();

  const watchers = [];
  for (const d of WATCH_DIRS) {
    if (!fs.existsSync(d)) continue;
    try {
      const w = fs.watch(d, { recursive: true }, (_ev, fname) => {
        if (!fname) return;
        if (!/\.(ts|js|mjs)$/.test(fname)) return; // 只关心源码
        scheduleRebuild();
      });
      w.on("error", () => {});
      watchers.push(w);
      console.log(`[watch] 监听 ${path.relative(ROOT, d)}`);
    } catch (e) {
      console.warn(`[watch] 无法监听 ${d}: ${e.message}`);
    }
  }
  console.log("[watch] 就绪,改动源码将自动重打包并热重启后端 (Ctrl+C 退出)");

  const shutdown = async () => {
    for (const w of watchers) try { w.close(); } catch {}
    await killBackend();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

(async () => {
  const isWatch = process.argv.includes("--watch");
  if (isWatch) await runWatch();
  else await runOnce();
})().catch((e) => { console.error(e); process.exit(1); });