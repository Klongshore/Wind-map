// Builds data/borders.json. Run from a folder with us-atlas@3, world-atlas@2 and
// topojson-client@3 and topojson-simplify@3 installed: node build-borders.cjs path/to/borders.json
const topo = require('topojson-client');
const simp = require('topojson-simplify');
const fs = require('fs');
// Round to 0.01 degrees (about 1 km) and drop repeated points to keep the file small.
const r = (c) => c
  .map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100])
  .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
function lines(file, obj) {
  let t = JSON.parse(fs.readFileSync(file));
  // Drop detail too small to see at the map's zoom levels.
  t = simp.simplify(simp.presimplify(t), 0.01);
  return topo.mesh(t, t.objects[obj]).coordinates.map(r);
}
const out = {
  source: 'Natural Earth via world-atlas 2 (countries 1:50m) and US Census via us-atlas 3 (states 1:10m)',
  countries: lines('node_modules/world-atlas/countries-50m.json', 'countries'),
  states: lines('node_modules/us-atlas/states-10m.json', 'states')
};
fs.writeFileSync(process.argv[2], JSON.stringify(out));
