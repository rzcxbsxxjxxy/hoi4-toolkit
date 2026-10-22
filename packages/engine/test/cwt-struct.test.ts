import { getRules } from '../src/cwt-check.ts'
const R = getRules()
console.log('顶层结构定义:', R.structs.size, '个')
for (const [k,v] of R.structs) {
  console.log(` ${k.padEnd(22)} 条目 ${String(v.entries.length).padStart(3)}  来自 ${v.files.join(',')}`)
}
const nf = R.structs.get('focus_tree')
if (nf) console.log('\nfocus_tree 的键:', nf.entries.map(e=>e.key).join(', '))
const ev = R.structs.get('event')
if (ev) console.log('\nevent 的键:', ev.entries.map(e=>e.key).join(', '))
const tech = R.structs.get('technology')
if (tech) console.log('\ntechnology 的键(前30):', tech.entries.slice(0,30).map(e=>e.key).join(', '))
