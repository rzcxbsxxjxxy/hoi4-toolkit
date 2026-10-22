import { getRules } from '../src/cwt-check.ts'
const R = getRules()
const ev = R.types.find(t=>t.name==='event')
console.log('type[event].subtypes:')
for (const [k,v] of Object.entries(ev?.subtypes||{})) console.log('  ', k.padEnd(24), 'typeKeyFilter=', JSON.stringify(v.typeKeyFilter), 'pushScope=', v.pushScope||'-')
const nf = R.types.find(t=>t.name==='national_focus'||t.name==='focus')
console.log('\ntype[focus].subtypes:', Object.entries(nf?.subtypes||{}).map(([k,v])=>k+'→'+JSON.stringify(v.typeKeyFilter)).join(' '))
let withFilter = 0, total = 0
for (const t of R.types) for (const v of Object.values(t.subtypes)) { total++; if (v.typeKeyFilter.length) withFilter++ }
console.log(`\nsubtype 总数 ${total},带 typeKeyFilter 的 ${withFilter}`)
