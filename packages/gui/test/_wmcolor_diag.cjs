//临时诊断脚本：统计世界地图国家配色覆盖率（用完可删）
const http = require('http');

http.get('http://127.0.0.1:5173/api/worldmap/meta', (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    const m = JSON.parse(b);
    console.log('meta keys:', Object.keys(m).join(', '));
    console.log('provinces:', m.provinces.length);
    const owners = new Set();
    for (const p of m.provinces) if (p.owner) owners.add(p.owner);
    console.log('distinct owners:', owners.size);
    if (m.palette) {
      const keys = Object.keys(m.palette);
      console.log('palette size:', keys.length);
      const missing = [...owners].filter((o) => !m.palette[o]);
      console.log('owners missing color:', missing.length, missing.slice(0, 40).join(','));
      const flat = keys.filter((k) => !m.palette[k]);
      console.log('palette entries empty:', flat.length, flat.slice(0, 40).join(','));
    }
    if (Array.isArray(m.countries)) {
      console.log('countries len:', m.countries.length);
      console.log('sample:', JSON.stringify(m.countries[0]));
      const noColor = m.countries.filter((c) => !c.color);
      console.log('countries without color:', noColor.length, noColor.slice(0, 20).map((c) => c.tag || c.id).join(','));
    }
  });
}).on('error', (e) => console.log('ERR', e.message));
