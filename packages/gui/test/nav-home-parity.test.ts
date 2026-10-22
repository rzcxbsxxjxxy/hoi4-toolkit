/**
 * 主页入口 vs 顶栏导航的**一致性断言**(2026-10-07)。
 *
 * 问题:顶栏 NAV_GROUPS 与 home.html 的 GROUPS 是两份独立维护的表。
 * 用户反馈"左上角(顶栏)有的功能主页没出现" —— 实测漏了 4 个:
 *   /defines /worldmap /modrel /settings
 * 根因就是这份重复:加页面时只改了 nav.js,忘了改 home.html。
 *
 * 本测试把「主页必须覆盖顶栏全部入口」变成硬判据,以后漏了直接红。
 * ★ 判据用 href 集合比对,不看顺序、不看显示名 ——
 *   显示名可以改,链接不能少。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PUB = join(process.cwd(), 'packages', 'gui', 'public')
const nav = readFileSync(join(PUB, 'nav.js'), 'utf8')
const home = readFileSync(join(PUB, 'home.html'), 'utf8')

let pass = 0
const fails: string[] = []
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
  } catch (e) {
    fails.push(name + ' :: ' + (e as Error).message)
  }
}
function ok(v: unknown, msg = '') {
  if (!v) throw new Error(msg || '期望为真')
}

/** nav.js 里 NAV_GROUPS 的 items(限定在该数组字面量内,避免抓到 mountNav 里的字符串) */
function navItems(): string[] {
  const start = nav.indexOf('export const NAV_GROUPS')
  ok(start >= 0, 'nav.js 里找不到 NAV_GROUPS')
  const end = nav.indexOf('\n]\n', start)
  ok(end > start, 'NAV_GROUPS 数组没闭合')
  const body = nav.slice(start, end)
  return [...body.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1])
}

/** home.html 里 GROUPS 的 href */
function homeItems(): string[] {
  const start = home.indexOf('const GROUPS = {')
  ok(start >= 0, 'home.html 里找不到 GROUPS')
  const end = home.indexOf('\n};', start)
  ok(end > start, 'GROUPS 没闭合')
  const body = home.slice(start, end)
  return [...body.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1])
}

const NAV = navItems()
const HOME = [...new Set(homeItems())]

t('NAV_GROUPS 解析出 20 个入口(基准,变了要同步改测试)', () => {
  ok(NAV.length >= 20, '实际 ' + NAV.length + ': ' + NAV.join(' '))
})

t('★ 主页覆盖顶栏全部入口(用户反馈的漏项就死在这条)', () => {
  const missing = NAV.filter((h) => !HOME.includes(h))
  ok(missing.length === 0, '主页缺这些入口:' + missing.join(' '))
})

t('★ 曾漏掉的 4 个入口现在都在主页里(防回退)', () => {
  for (const h of ['/defines', '/worldmap', '/modrel', '/settings']) {
    ok(HOME.includes(h), h + ' 不在主页')
  }
})

t('主页不出现顶栏没有的入口(别加野路由)', () => {
  const extra = HOME.filter((h) => !NAV.includes(h))
  ok(extra.length === 0, '主页多了:' + extra.join(' '))
})

t('★ 主页每张卡片都有对应图标(加卡片忘加图标 = 空图标位)', () => {
  const icBlock = home.slice(home.indexOf('const IC = {'), home.indexOf('};', home.indexOf('const IC = {')))
  const declared = [...icBlock.matchAll(/^\s{2}([A-Za-z0-9_]+):'/gm)].map((m) => m[1])
  const start = home.indexOf('const GROUPS = {')
  const body = home.slice(start, home.indexOf('\n};', start))
  const used = [...body.matchAll(/ic:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  const missing = [...new Set(used)].filter((k) => !declared.includes(k))
  ok(missing.length === 0, 'IC 里缺这些图标:' + missing.join(' '))
})

t('每张卡片都有 tip 与 short(悬停说明与版面上的一行)', () => {
  const start = home.indexOf('const GROUPS = {')
  const body = home.slice(start, home.indexOf('\n};', start))
  const cards = body.split(/\n\s*\{ href:/).slice(1)
  ok(cards.length >= 15, '卡片数异常:' + cards.length)
  const bad = cards.filter((c) => !/tip:\s*'/.test(c) || !/short:\s*'/.test(c))
  ok(bad.length === 0, bad.length + ' 张卡片缺 tip 或 short')
})

console.log(`\n主页入口一致性: ${pass}/${pass + fails.length} 通过`)
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
