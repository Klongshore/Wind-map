/*
 * Animated wind-particle layer for Leaflet, in the style of hint.fm/wind:
 * particles drift slowly with the wind, each drawing a long tapering trail
 * from its recent path, so the flow patterns read clearly on screen and in
 * saved or printed images.
 */
import type { WindField } from './wind-field.js';

const CELL = 6;              // px size of the screen-space velocity lookup grid
const SPEED_SCALE = 0.12;    // px per step for each m/s of wind
const SAMPLE = 6;            // steps between remembered trail points
const TRAIL = 28;            // trail points kept per particle
const MAX_AGE = 600;         // steps before a particle is respawned
const SECTIONS = 3;          // trail drawn in parts, fainter towards the tail
export const MPH_PER_MS = 2.23694;
export const LEGEND_MAX_MPH = 40;

// Black-and-white trails: faster wind draws brighter (or darker on the
// light map), like hint.fm/wind.
const BUCKETS = 8;

interface Particle {
  x: number;
  y: number;
  age: number;
  len: number;      // remembered points
  head: number;     // ring buffer slot for the next point
  bucket: number;
  hx: Float32Array;
  hy: Float32Array;
}

// Wind (in px per step) at a coarse grid of screen positions.
interface ScreenGrid {
  cols: number;
  rows: number;
  vx: Float32Array;
  vy: Float32Array;
  sp: Float32Array;
  valid: Uint8Array;
}

export function trailColor(t: number, light: boolean): string {
  t = Math.max(0, Math.min(1, t));
  const alpha = (0.4 + 0.6 * t).toFixed(2);
  return light ? 'rgba(20,20,20,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')';
}

// colors[bucket][section]: speed sets the base strength, the tail fades out.
function bucketColors(light: boolean): string[][] {
  const colors: string[][] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const row: string[] = [];
    const base = 0.4 + 0.6 * (b / (BUCKETS - 1));
    for (let k = 0; k < SECTIONS; k++) {
      const alpha = (base * (k + 1) / SECTIONS).toFixed(3);
      row.push(light ? 'rgba(20,20,20,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')');
    }
    colors.push(row);
  }
  return colors;
}

export class WindLayer extends L.Layer {
  canvas!: HTMLCanvasElement;
  private _ctx!: CanvasRenderingContext2D;
  private _particles: Particle[] = [];
  private _grid: ScreenGrid | null = null;
  private _running = false;
  private _paused = false;
  private _odd = false;
  private _frame: number | null = null;
  private _colors: string[][] = bucketColors(false);
  private _field: WindField | null = null;
  private _dpr = 1;
  private _w = 0;
  private _h = 0;

  onAdd(map: L.Map): this {
    this._map = map;
    this.canvas = L.DomUtil.create('canvas', 'wind-canvas');
    map.getContainer().appendChild(this.canvas);
    this._ctx = this.canvas.getContext('2d')!;
    this._particles = [];
    this._grid = null;
    this._running = false;

    map.on('movestart zoomstart', this._pause, this);
    map.on('moveend resize', this._rebuild, this);
    this._rebuild();
    return this;
  }

  onRemove(map: L.Map): this {
    map.off('movestart zoomstart', this._pause, this);
    map.off('moveend resize', this._rebuild, this);
    this._stop();
    L.DomUtil.remove(this.canvas);
    return this;
  }

  setLight(light: boolean): void {
    this._colors = bucketColors(light);
    if (this._map) this._rebuild();
  }

  setField(field: WindField): void {
    this._field = field;
    this._rebuild();
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
    if (paused) {
      this._stop();
    } else if (this._map && this._field && !this._running) {
      this._running = true;
      this._tick();
    }
  }

  private _pause(): void {
    this._stop();
    this._clear();
    this.canvas.style.visibility = 'hidden';
  }

  private _stop(): void {
    this._running = false;
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  private _clear(): void {
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private _rebuild(): void {
    if (!this._map) return;
    this._stop();
    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this._w = size.x;
    this._h = size.y;
    this.canvas.width = Math.round(size.x * dpr);
    this.canvas.height = Math.round(size.y * dpr);
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    this._clear();
    this.canvas.style.visibility = 'visible';

    if (!this._field) return;
    this._buildGrid(this._field);
    this._spawnAll();
    if (this._paused) {
      // Draw a still frame (the trails were grown in _spawnAll).
      this._draw();
      return;
    }
    this._running = true;
    this._tick();
  }

  // Precompute wind (in px/frame) for a coarse grid of screen positions.
  private _buildGrid(field: WindField): void {
    const cols = Math.ceil(this._w / CELL) + 1;
    const rows = Math.ceil(this._h / CELL) + 1;
    const vx = new Float32Array(cols * rows);
    const vy = new Float32Array(cols * rows);
    const sp = new Float32Array(cols * rows);
    const valid = new Uint8Array(cols * rows);
    const map = this._map;
    const pt = L.point(0, 0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        pt.x = c * CELL;
        pt.y = r * CELL;
        const ll = map.containerPointToLatLng(pt);
        const w = field.at(ll.lat, ll.lng);
        const i = r * cols + c;
        if (!w) continue;
        vx[i] = w.u * SPEED_SCALE;
        vy[i] = -w.v * SPEED_SCALE;
        sp[i] = w.speed;
        valid[i] = 1;
      }
    }
    this._grid = { cols, rows, vx, vy, sp, valid };
  }

  private _spawnAll(): void {
    const area = this._w * this._h;
    const count = Math.round(Math.min(4500, Math.max(1500, area / 180)));
    this._particles = new Array<Particle>(count);
    for (let i = 0; i < count; i++) {
      const p: Particle = {
        x: 0, y: 0, age: 0, len: 0, head: 0, bucket: 0,
        hx: new Float32Array(TRAIL),
        hy: new Float32Array(TRAIL)
      };
      this._particles[i] = this._spawn(p, true);
    }
    // Let the trails grow before the first frame is shown.
    for (let f = 0; f < SAMPLE * TRAIL; f++) this._step();
  }

  private _spawn(p: Particle, randomAge: boolean): Particle {
    p.x = Math.random() * this._w;
    p.y = Math.random() * this._h;
    p.age = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
    p.len = 0;
    p.head = 0;
    p.bucket = 0;
    return p;
  }

  private _lookup(g: ScreenGrid, x: number, y: number): number {
    const c = Math.round(x / CELL);
    const r = Math.round(y / CELL);
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
    const i = r * g.cols + c;
    return g.valid[i] ? i : -1;
  }

  private _tick(): void {
    if (!this._running) return;
    // Redraw every other display frame (half the drawing work) and move the
    // particles two steps each time.
    this._odd = !this._odd;
    if (this._odd) {
      this._step();
      this._step();
      this._draw();
    }
    this._frame = requestAnimationFrame(() => this._tick());
  }

  // Moves every particle one step and remembers its path.
  private _step(): void {
    const g = this._grid;
    if (!g) return;
    const ps = this._particles;
    for (let n = 0; n < ps.length; n++) {
      const p = ps[n];
      const i = this._lookup(g, p.x, p.y);
      if (i < 0 || p.age++ > MAX_AGE) {
        this._spawn(p, false);
        continue;
      }
      if (p.age % SAMPLE === 0 || p.len === 0) {
        p.hx[p.head] = p.x;
        p.hy[p.head] = p.y;
        p.head = (p.head + 1) % TRAIL;
        if (p.len < TRAIL) p.len++;
      }
      p.x += g.vx[i];
      p.y += g.vy[i];
      const t = (g.sp[i] * MPH_PER_MS) / LEGEND_MAX_MPH;
      p.bucket = Math.min(BUCKETS - 1, Math.floor(t * (BUCKETS - 1) + 0.5));
    }
  }

  // Redraws every trail from scratch, grouped by color for speed.
  private _draw(): void {
    const ctx = this._ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const ps = this._particles;
    for (let b = 0; b < BUCKETS; b++) {
      for (let k = 0; k < SECTIONS; k++) {
        ctx.beginPath();
        let any = false;
        for (let n = 0; n < ps.length; n++) {
          const p = ps[n];
          if (p.bucket !== b || p.len < 2) continue;
          // Points oldest to newest, then the live position.
          const total = p.len + 1;
          const from = Math.floor(k * (total - 1) / SECTIONS);
          const to = Math.floor((k + 1) * (total - 1) / SECTIONS);
          if (to <= from) continue;
          const oldest = (p.head - p.len + TRAIL) % TRAIL;
          for (let j = from; j <= to; j++) {
            let x: number, y: number;
            if (j === p.len) {
              x = p.x;
              y = p.y;
            } else {
              const slot = (oldest + j) % TRAIL;
              x = p.hx[slot];
              y = p.hy[slot];
            }
            if (j === from) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          any = true;
        }
        if (any) {
          ctx.strokeStyle = this._colors[b][k];
          ctx.stroke();
        }
      }
    }
  }
}
