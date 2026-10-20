// Smoke test: loads the page in Chromium with Open-Meteo and the map tiles
// mocked, checks that wind particles animate, and that save/print produce an image.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = process.env.SMOKE_OUT || path.join(root, 'test-output');
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const target = file.endsWith(path.sep) ? path.join(file, 'index.html') : file;
  if (!target.startsWith(root) || !fs.existsSync(target)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

// A 256x256 solid tile PNG.
function solidPng(r, g, b) {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      const line = x % 64 === 0 || y % 64 === 0;
      raw[o] = line ? r + 30 : r; raw[o + 1] = line ? g + 30 : g; raw[o + 2] = line ? b + 30 : b;
    }
  }
  const crc = (buf) => { let c, crc = -1; for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const tile = solidPng(40, 44, 52);

// Synthetic wind: a big cyclone centred on Kansas plus a westerly breeze.
function windAt(lat, lng) {
  const dx = (lng + 98) * Math.cos(lat * Math.PI / 180);
  const dy = lat - 38;
  const r = Math.hypot(dx, dy) + 1;
  const strength = 18 * Math.exp(-r / 12);
  const u = -dy / r * strength + 6;
  const v = dx / r * strength;
  const speed = Math.hypot(u, v);
  const dir = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  return { wind_speed_10m: speed, wind_direction_10m: dir };
}

let apiCalls = 0;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const { viewport, hash, tag } of [
    { tag: 'desktop', viewport: { width: 1280, height: 800 }, hash: '' },
    { tag: 'phone', viewport: { width: 390, height: 844 }, hash: '' },
    { tag: 'world', viewport: { width: 1600, height: 900 }, hash: '#20,170,2z' }
  ]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://*.basemaps.cartocdn.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile }));
    await page.route('https://api.open-meteo.com/**', (route) => {
      apiCalls++;
      const u = new URL(route.request().url());
      const lats = u.searchParams.get('latitude').split(',').map(Number);
      const lngs = u.searchParams.get('longitude').split(',').map(Number);
      const body = lats.map((lat, i) => ({ latitude: lat, longitude: lngs[i], current: { time: '2026-10-20T12:00', ...windAt(lat, lngs[i]) } }));
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    });

    await page.goto(base + hash);
    await page.waitForFunction(() => /^Wind at/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
    await page.waitForTimeout(1500);

    const painted = await page.evaluate(() => {
      const c = document.querySelector('.wind-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
      return n;
    });
    assert.ok(painted > 2000, `wind trails should be drawn (got ${painted} pixels)`);

    await page.screenshot({ path: path.join(outDir, `screen-${tag}.png`) });

    // Zoom in, the wind should come back after the move.
    await page.evaluate(() => document.querySelector('.leaflet-control-zoom-in').click());
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => document.querySelector('.wind-canvas').style.visibility), 'visible');

    // Save image.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-save')]);
    assert.match(download.suggestedFilename(), /^wind-map-.*\.png$/);
    const saved = path.join(outDir, `saved-${tag}.png`);
    await download.saveAs(saved);
    assert.ok(fs.statSync(saved).size > 10000, 'saved PNG should not be empty');
    assert.doesNotMatch(await page.textContent('#status'), /could not/i);

    // Print: stub window.print and check the print image is filled in.
    await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
    await page.click('#btn-print');
    await page.waitForFunction(() => window.__printed, null, { timeout: 5000 });
    assert.match(await page.getAttribute('#print-image', 'src'), /^data:image\/png;base64,/);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('map')).display), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('print-image')).display), 'block');
    await page.emulateMedia({ media: 'screen' });

    // Light theme toggles.
    await page.click('#btn-theme');
    assert.ok(await page.evaluate(() => document.body.classList.contains('light')));
    assert.match(page.url(), /,light$/);

    assert.deepEqual(errors, []);
    await context.close();
    console.log(`ok - ${tag}`);
  }
  assert.ok(apiCalls >= 2, 'wind data should be fetched');
} finally {
  await browser.close();
  server.close();
}
