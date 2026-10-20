import { fetchField, fetchFileField, type WindField } from './wind-field.js';
import { WindLayer, MPH_PER_MS } from './wind-layer.js';
import { snapshot, type Snapshot } from './snapshot.js';

type Theme = 'dark' | 'light';

interface ViewState {
  lat: number;
  lng: number;
  zoom: number;
  theme: Theme;
}

// data/borders.json, as written by data/build-borders.cjs.
interface Borders {
  countries: GeoJSON.Position[][];
  states: GeoJSON.Position[][];
}

// Esri's grey canvas basemaps: free, no key, and they allow cross-origin use,
// which the save/print snapshot needs.
const TILES: Record<Theme, string> = {
  dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
};
const TILE_ATTRIBUTION =
  'Wind: <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast">NOAA GFS</a> | ' +
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OSM';
const BACKGROUND: Record<Theme, string> = { dark: '#202226', light: '#e9ebee' };

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusEl = byId('status');
const themeBtn = byId<HTMLButtonElement>('btn-theme');
const saveBtn = byId<HTMLButtonElement>('btn-save');
const printBtn = byId<HTMLButtonElement>('btn-print');
const locateBtn = byId<HTMLButtonElement>('btn-locate');
const printImg = byId<HTMLImageElement>('print-image');
const pauseBtn = byId<HTMLButtonElement>('btn-pause');
let paused = false;

const state = loadState();

const map = L.map('map', {
  center: [state.lat, state.lng],
  zoom: state.zoom,
  minZoom: 2,
  maxZoom: 12,
  worldCopyJump: true,
  zoomSnap: 0.5
});

const tiles = L.tileLayer(TILES[state.theme], {
  attribution: TILE_ATTRIBUTION,
  maxZoom: 16,
  crossOrigin: 'anonymous'
}).addTo(map);

// State and country outlines, drawn on a canvas so they can be saved/printed.
map.createPane('borders');
map.getPane('borders')!.style.zIndex = '350';
map.getPane('borders')!.style.pointerEvents = 'none';
const borderRenderer = L.canvas({ pane: 'borders', padding: 0.5 });
const borders = L.layerGroup().addTo(map);
fetch('data/borders.json')
  .then((res) => res.json() as Promise<Borders>)
  .then((data) => {
    borders.addLayer(L.geoJSON({ type: 'MultiLineString', coordinates: data.countries } as GeoJSON.MultiLineString, {
      renderer: borderRenderer, interactive: false, style: borderStyle(0.8)
    } as L.GeoJSONOptions));
    borders.addLayer(L.geoJSON({ type: 'MultiLineString', coordinates: data.states } as GeoJSON.MultiLineString, {
      renderer: borderRenderer, interactive: false, style: borderStyle(0.5)
    } as L.GeoJSONOptions));
  })
  .catch(() => { /* the map still works without outlines */ });

const wind = new WindLayer().addTo(map);
let field: WindField | null = null;
let pending: AbortController | null = null;
let fetchTimer: ReturnType<typeof setTimeout> | undefined;

applyTheme(state.theme);

map.on('moveend', () => {
  saveState();
  scheduleFetch();
});
// Prefer the global wind file; fall back to asking Open-Meteo for the view.
loadWindFile(true);
setInterval(() => { loadWindFile(false); }, 30 * 60 * 1000);

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!field) return;
  const w = field.at(e.latlng.lat, e.latlng.lng);
  if (!w) return;
  const mph = w.speed * MPH_PER_MS;
  const kmh = w.speed * 3.6;
  // Direction the wind is coming FROM, compass style.
  const from = (Math.atan2(-w.u, -w.v) * 180 / Math.PI + 360) % 360;
  L.popup()
    .setLatLng(e.latlng)
    .setContent(
      '<div class="wind-popup"><strong>' + Math.round(mph) + ' mph</strong> (' +
      Math.round(kmh) + ' km/h)<br>from ' + compass(from) + ' (' + Math.round(from) + '&deg;) ' +
      '<span class="arrow" style="transform:rotate(' + Math.round(from + 180) + 'deg)">&uarr;</span></div>'
    )
    .openOn(map);
});

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  wind.setPaused(paused);
  pauseBtn.textContent = paused ? 'Play' : 'Pause';
  pauseBtn.setAttribute('aria-pressed', String(paused));
});

themeBtn.addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  saveState();
});

saveBtn.addEventListener('click', () => {
  const shot = takeSnapshot();
  if (!shot) return;
  const name = 'wind-map-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
  shot.canvas.toBlob((blob) => {
    if (!blob) return setStatus('Could not create the image.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); }, 30000);
  }, 'image/png');
});

printBtn.addEventListener('click', () => {
  const shot = takeSnapshot();
  if (!shot) return;
  printImg.onload = () => {
    printImg.onload = null;
    window.print();
  };
  printImg.src = shot.canvas.toDataURL('image/png');
});

locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available in this browser.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 7));
    },
    () => { setStatus('Could not get your location.'); },
    { timeout: 10000 }
  );
});

function scheduleFetch(delay = 350): void {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(loadWind, delay);
}

function loadWindFile(firstTime: boolean): void {
  fetchFileField('data/')
    .then((f) => {
      if (field && field.fromFile && field.time === f.time) return;
      useField(f);
    })
    .catch(() => {
      if (firstTime) scheduleFetch(0);
    });
}

function useField(f: WindField): void {
  field = f;
  wind.setField(f);
  setStatus(describeTime(f.time));
}

function loadWind(): void {
  if (field && (field.fromFile || field.covers(map.getBounds()))) return;
  if (pending) pending.abort();
  const ctrl = new AbortController();
  pending = ctrl;
  if (!field) setStatus('Loading wind…');
  fetchField(map.getBounds(), ctrl.signal)
    .then((f) => {
      if (pending !== ctrl) return;
      pending = null;
      useField(f);
    })
    .catch((err: Error) => {
      if (err.name === 'AbortError') return;
      pending = null;
      setStatus(field
        ? 'Showing earlier wind. The wind service said: ' + err.message
        : 'Could not load wind: ' + err.message);
    });
}

function takeSnapshot(): Snapshot | null {
  if (!field) {
    setStatus('Wait for the wind to load first.');
    return null;
  }
  const shot = snapshot(map, wind.canvas, {
    background: BACKGROUND[state.theme],
    light: state.theme === 'light',
    title: describeTime(field.time),
    subtitle: 'Wind: ' + (field.fromFile ? 'NOAA GFS' : 'Open-Meteo') + ' · Map: © Esri, OpenStreetMap'
  });
  if (shot.tilesDropped) setStatus('Map tiles could not be included; saved wind only.');
  return shot;
}

function borderStyle(weight: number): () => L.PathOptions {
  return () => ({
    color: state.theme === 'light' ? '#000' : '#fff',
    opacity: state.theme === 'light' ? 0.3 : 0.25,
    weight
  });
}

function applyTheme(theme: Theme): void {
  state.theme = theme;
  wind.setLight(theme === 'light');
  borders.eachLayer((layer) => {
    const geo = layer as L.GeoJSON;
    geo.setStyle(geo.options.style as L.StyleFunction);
  });
  document.body.classList.toggle('light', theme === 'light');
  tiles.setUrl(TILES[theme]);
  themeBtn.textContent = theme === 'dark' ? 'Light map' : 'Dark map';
}

function describeTime(iso: string | null): string {
  if (!iso) return 'Current wind';
  const d = new Date(iso + 'Z');
  if (isNaN(d.getTime())) return 'Current wind';
  return 'Wind at ' + d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function compass(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(deg / 22.5) % 16];
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// The view and theme are remembered in the URL hash so a link reopens the same map.
function loadState(): ViewState {
  const s: ViewState = { lat: 39, lng: -96, zoom: 4, theme: 'dark' };
  const m = /^#(-?[\d.]+),(-?[\d.]+),([\d.]+)z(?:,(light|dark))?/.exec(location.hash);
  // The pattern also lets through things like "1.2.3", so check the numbers.
  if (m && isFinite(+m[1]) && isFinite(+m[2]) && isFinite(+m[3])) {
    s.lat = Math.max(-85, Math.min(85, +m[1]));
    s.lng = +m[2];
    s.zoom = Math.max(2, Math.min(12, +m[3]));
    if (m[4]) s.theme = m[4] as Theme;
  }
  return s;
}

function saveState(): void {
  const c = map.getCenter().wrap();
  const hash = '#' + c.lat.toFixed(3) + ',' + c.lng.toFixed(3) + ',' + map.getZoom() + 'z,' + state.theme;
  history.replaceState(null, '', hash);
}
