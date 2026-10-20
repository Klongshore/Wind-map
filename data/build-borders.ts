// Builds data/borders.json from the pinned world-atlas and us-atlas packages:
// npm run build:borders
import fs from 'node:fs';
import { mesh } from 'topojson-client';
import { presimplify, simplify } from 'topojson-simplify';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Position } from 'geojson';

// Round to 0.01 degrees (about 1 km) and drop repeated points to keep the file small.
const r = (c: Position[]): Position[] => c
  .map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100])
  .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
function lines(file: string, obj: string): Position[][] {
  let t = JSON.parse(fs.readFileSync(file, 'utf8')) as Topology<Record<string, GeometryCollection>>;
  // Drop detail too small to see at the map's zoom levels.
  t = simplify(presimplify(t), 0.01);
  return mesh(t, t.objects[obj]).coordinates.map(r);
}
const out = {
  source: 'Natural Earth via world-atlas 2 (countries 1:50m) and US Census via us-atlas 3 (states 1:10m)',
  countries: lines('node_modules/world-atlas/countries-50m.json', 'countries'),
  states: lines('node_modules/us-atlas/states-10m.json', 'states')
};
fs.writeFileSync(process.argv[2] || 'data/borders.json', JSON.stringify(out));
