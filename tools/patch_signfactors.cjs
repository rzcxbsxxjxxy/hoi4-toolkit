// Patch model.ts: fix upper_right x-sign in signFactors.
// Run: node patch_signfactors.cjs
const fs = require('fs')
const p = require('path').join(__dirname, '..', 'packages', 'gui', 'src', 'model.ts')
let s = fs.readFileSync(p, 'utf8')

const oldFn = /function signFactors\(name: string \| undefined\): \{ x: number; y: number \} \{[\s\S]*?\n\}\n\/\/ POSITION_SIGN_FIX/
const m = s.match(oldFn)
if (!m) { console.error('OLD signFactors not found!'); process.exit(2) }

const newFn = `function signFactors(name: string | undefined): { x: number; y: number } {
  const o = unquote(name).toLowerCase()
  // X:含 right 时,仅 upper_right 保持 +1(正=右/外),其余 right(lower_right/center_right)翻为 -1(正=左/内)
  let sx = 1
  if (o.includes('right')) sx = o.includes('upper') ? 1 : -1
  // Y:含 lower / down(下锚)翻为 -1(正=上/内);upper / center / 缺省 +1(正=下)
  let sy = 1
  if (o.includes('lower') || o.includes('down')) sy = -1
  return { x: sx, y: sy }
}
// POSITION_SIGN_FIX`

if (s.includes('upper_right 保持 +1')) { console.log('Already patched.'); process.exit(0) }
s = s.replace(oldFn, newFn)
fs.writeFileSync(p, s)
console.log('signFactors patched OK')
