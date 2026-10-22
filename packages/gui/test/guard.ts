/**
 * 守卫的阳性测试:证明它真能拦住意外改动,而不是永远放行。
 *
 * 一个永远通过的守卫等于没有守卫 —— 所以必须造几个"确实错了"的场景,
 * 确认它能报错;同时确认"确实没错"的场景不会误报。
 */
import { verifyEdit } from '../src/edit.ts'

const src = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
const lines = src.split('\n')

function caseRun(name: string, mutate: (l: string[]) => void, touched: number[], expectOk: boolean) {
  const l = [...lines]
  mutate(l)
  const after = l.join('\n')
  const g = verifyEdit(src, after, touched)
  const pass = g.ok === expectOk
  console.log(`  ${pass ? '通过' : '✗ 失败'}  ${name}`)
  console.log(`        期望 ${expectOk ? '放行' : '拦截'},实际 ${g.ok ? '放行' : '拦截'} — ${g.message}`)
  if (!pass) process.exitCode = 1
}

console.log('════════ 守卫阳性/阴性测试 ════════\n')

console.log('── 应当拦截 ──')
caseRun('改动了完全无关的第 5 行', (l) => (l[4] = 'line 5 被偷偷改了'), [20], false)
caseRun('改动落在预期行之前', (l) => (l[9] = 'x'), [20], false)
caseRun('改动落在预期行之后', (l) => (l[29] = 'y'), [20], false)
caseRun('删除了一行', (l) => l.splice(3, 1), [20], false)
caseRun('在无关位置插入一行', (l) => l.splice(2, 0, '凭空多出的一行'), [20], false)
caseRun('预期改第 20 行,实际改的是第 21 行', (l) => (l[20] = 'line 21 改了'), [20], false)

console.log('\n── 应当放行 ──')
caseRun('无改动', () => {}, [20], true)
caseRun('只改预期行', (l) => (l[19] = 'line 20 改了'), [20], true)
caseRun('改多个预期行', (l) => {
  l[19] = 'a'
  l[24] = 'b'
}, [20, 25], true)
caseRun('在预期行后插入(行号偏移场景)', (l) => {
  l[19] = 'line 20 改了'
  l.splice(19, 0, '新增的 position 行')
}, [20, 21], true)
caseRun('仅行尾空白变化', (l) => (l[19] = 'line 20   '), [20], true)

console.log('\n── 大规模:1000 行的文件,改 1 行 ──')
const big = Array.from({ length: 1000 }, (_, i) => `content ${i + 1}`).join('\n')
const bl = big.split('\n')
bl[499] = 'content 500 已修改'
const g1 = verifyEdit(big, bl.join('\n'), [500])
console.log(`  期望放行,实际 ${g1.ok ? '放行' : '拦截'} — ${g1.message}`)
bl[499] = 'content 500'
bl[900] = '被篡改'
const g2 = verifyEdit(big, bl.join('\n'), [500])
console.log(`  期望拦截,实际 ${g2.ok ? '放行' : '拦截'} — ${g2.message}`)
if (g1.ok !== true || g2.ok !== false) process.exitCode = 1

console.log('\n' + (process.exitCode ? '存在失败用例' : '全部用例符合预期'))
