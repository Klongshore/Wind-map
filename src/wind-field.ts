/*
 * Wind data: fetches current 10 m wind for a grid of points from Open-Meteo
 * and interpolates it anywhere inside the grid.
 */

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const MAX_LAT = 85;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; field: WindField }>();

export interface Wind {
  u: number;
  v: number;
  speed: number;
}

// The area a grid covers and how many points it has.
export interface GridPlan {
  south: number;
  north: number;
  west: number;
  east: number;
  rows: number;
  cols: number;
  global: boolean;
}

export interface FieldSpec extends GridPlan {
  u: Float32Array;
  v: Float32Array;
  time: string | null;
}

// wind.json, as written by scripts/fetch_wind.py.
interface WindFileMeta {
  time: string;
  south: number;
  north: number;
  west: number;
  rows: number;
  cols: number;
  step: number;
}

// One point of an Open-Meteo forecast response.
interface OpenMeteoPoint {
  current?: {
    time?: string;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
}

export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Wind direction is where the wind blows FROM, in degrees clockwise from north.
export function toUV(speed: number, directionDeg: number): { u: number; v: number } {
  const rad = directionDeg * Math.PI / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

/*
 * A regular lat/lng grid of u/v wind components (m/s).
 * When `global` is true the grid covers all longitudes and wraps around.
 */
export class WindField {
  south: number;
  north: number;
  west: number;
  east: number;
  rows: number;
  cols: number;
  global: boolean;
  u: Float32Array;
  v: Float32Array;
  time: string | null;
  dLat: number;
  dLng: number;
  fromFile = false;

  constructor(spec: FieldSpec) {
    this.south = spec.south;
    this.north = spec.north;
    this.west = spec.west;
    this.east = spec.east;
    this.rows = spec.rows;
    this.cols = spec.cols;
    this.global = spec.global;
    this.u = spec.u;
    this.v = spec.v;
    this.time = spec.time;
    this.dLat = (this.north - this.south) / (this.rows - 1);
    this.dLng = this.global
      ? 360 / this.cols
      : (this.east - this.west) / (this.cols - 1);
  }

  // Returns {u, v, speed} at a point, or null if outside the grid.
  at(lat: number, lng: number): Wind | null {
    if (lat < this.south || lat > this.north) return null;
    const y = (lat - this.south) / this.dLat;
    let x: number;
    if (this.global) {
      x = (((lng - this.west) % 360) + 360) % 360 / this.dLng;
    } else {
      if (lng < this.west || lng > this.east) return null;
      x = (lng - this.west) / this.dLng;
    }
    const r0 = Math.min(Math.floor(y), this.rows - 2);
    let c0 = Math.floor(x);
    const fy = y - r0;
    let fx = x - c0;
    let c1: number;
    if (this.global) {
      c0 = c0 % this.cols;
      c1 = (c0 + 1) % this.cols;
    } else {
      c0 = Math.min(c0, this.cols - 2);
      fx = x - c0;
      c1 = c0 + 1;
    }
    const i00 = r0 * this.cols + c0;
    const i01 = r0 * this.cols + c1;
    const i10 = (r0 + 1) * this.cols + c0;
    const i11 = (r0 + 1) * this.cols + c1;
    const u = bilerp(this.u[i00], this.u[i01], this.u[i10], this.u[i11], fx, fy);
    const v = bilerp(this.v[i00], this.v[i01], this.v[i10], this.v[i11], fx, fy);
    return { u, v, speed: Math.sqrt(u * u + v * v) };
  }

  /*
   * True when this field already covers `bounds` with enough detail, so the
   * view can be redrawn without asking the server again.
   */
  covers(bounds: L.LatLngBounds): boolean {
    const south = Math.max(bounds.getSouth(), -MAX_LAT);
    const north = Math.min(bounds.getNorth(), MAX_LAT);
    const west = bounds.getWest();
    const east = bounds.getEast();
    if (south < this.south || north > this.north) return false;
    if (!this.global && (west < this.west || east > this.east)) return false;
    // Too coarse once the view is much smaller than a few grid cells.
    return (north - south) > this.dLat * 1.5 || this.dLat < 0.1;
  }
}

function bilerp(a00: number, a01: number, a10: number, a11: number, fx: number, fy: number): number {
  const top = a00 + (a01 - a00) * fx;
  const bottom = a10 + (a11 - a10) * fx;
  return top + (bottom - top) * fy;
}

/*
 * Lays out a grid of sample points that covers `bounds` (a Leaflet
 * LatLngBounds, possibly with longitudes outside -180..180).
 */
export function planGrid(bounds: L.LatLngBounds): GridPlan {
  let south = clamp(bounds.getSouth(), -MAX_LAT, MAX_LAT);
  let north = clamp(bounds.getNorth(), -MAX_LAT, MAX_LAT);
  let west = bounds.getWest();
  let east = bounds.getEast();
  // Generous padding so small pans and zooms can reuse the same data.
  const latPad = (north - south) * 0.25 || 1;
  const lngPad = (east - west) * 0.25 || 1;
  south = clamp(south - latPad, -MAX_LAT, MAX_LAT);
  north = clamp(north + latPad, -MAX_LAT, MAX_LAT);
  west -= lngPad;
  east += lngPad;

  const global = east - west >= 300;
  let rows: number, cols: number;
  if (global) {
    west = -180;
    east = 180;
    rows = 11;
    cols = 18;
  } else {
    const aspect = (east - west) / Math.max(north - south, 0.01);
    // Open-Meteo counts every grid point as one API call, so keep the grid small.
    rows = 10;
    cols = clamp(Math.round(rows * aspect), 6, 15);
    // Snap to a coarse grid so small pans can reuse cached data.
    const step = Math.max((east - west) / (cols - 1), (north - south) / (rows - 1));
    const snap = Math.pow(10, Math.floor(Math.log10(step)));
    south = clamp(Math.floor(south / snap) * snap, -MAX_LAT, MAX_LAT);
    north = clamp(Math.ceil(north / snap) * snap, -MAX_LAT, MAX_LAT);
    west = Math.floor(west / snap) * snap;
    east = Math.ceil(east / snap) * snap;
  }
  return { south, north, west, east, rows, cols, global };
}

function gridPoints(plan: GridPlan): { lats: string[]; lngs: string[] } {
  const lats: string[] = [];
  const lngs: string[] = [];
  const dLat = (plan.north - plan.south) / (plan.rows - 1);
  const dLng = plan.global ? 360 / plan.cols : (plan.east - plan.west) / (plan.cols - 1);
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      lats.push((plan.south + r * dLat).toFixed(4));
      lngs.push(wrapLng(plan.west + c * dLng).toFixed(4));
    }
  }
  return { lats, lngs };
}

export function fetchField(bounds: L.LatLngBounds, signal?: AbortSignal): Promise<WindField> {
  const plan = planGrid(bounds);
  const pts = gridPoints(plan);
  const url = API_URL +
    '?latitude=' + pts.lats.join(',') +
    '&longitude=' + pts.lngs.join(',') +
    '&current=wind_speed_10m,wind_direction_10m' +
    '&wind_speed_unit=ms&timezone=UTC';

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return Promise.resolve(hit.field);
  }

  return fetch(url, { signal })
    .then((res) => {
      if (!res.ok) {
        return res.json().catch(() => ({})).then((body: { reason?: string }) => {
          throw new Error(body.reason || ('Wind data request failed (' + res.status + ')'));
        });
      }
      return res.json() as Promise<OpenMeteoPoint | OpenMeteoPoint[]>;
    })
    .then((data) => {
      const list = Array.isArray(data) ? data : [data];
      if (list.length !== pts.lats.length) {
        throw new Error('Unexpected wind data from server');
      }
      const n = list.length;
      const u = new Float32Array(n);
      const v = new Float32Array(n);
      let time: string | null = null;
      for (let i = 0; i < n; i++) {
        const cur = list[i].current || {};
        const uv = toUV(cur.wind_speed_10m || 0, cur.wind_direction_10m || 0);
        u[i] = uv.u;
        v[i] = uv.v;
        time = time || cur.time || null;
      }
      const field = new WindField({ ...plan, u, v, time });
      cache.set(url, { at: Date.now(), field });
      return field;
    });
}

/*
 * Loads the global wind file written by scripts/fetch_wind.py (refreshed on
 * a schedule by GitHub Actions). One file covers the whole world, so the map
 * never has to call the wind service as you move around.
 */
export function fetchFileField(base: string): Promise<WindField> {
  return fetch(base + 'wind.json', { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error('No wind file (' + res.status + ')');
      return res.json() as Promise<WindFileMeta>;
    })
    .then((meta) => {
      return fetch(base + 'wind.bin?t=' + encodeURIComponent(meta.time))
        .then((res) => {
          if (!res.ok) throw new Error('No wind file (' + res.status + ')');
          return res.arrayBuffer();
        })
        .then((buf) => {
          const n = meta.rows * meta.cols;
          const raw = new Int8Array(buf);
          if (raw.length !== 2 * n) throw new Error('Wind file has the wrong size');
          const u = new Float32Array(n);
          const v = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            u[i] = raw[i] * meta.step;
            v[i] = raw[n + i] * meta.step;
          }
          const field = new WindField({
            south: meta.south, north: meta.north, west: meta.west, east: meta.west + 360,
            rows: meta.rows, cols: meta.cols, global: true, u, v, time: meta.time
          });
          field.fromFile = true;
          return field;
        });
    });
}
