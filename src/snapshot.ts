/*
 * Renders what is on screen (map tiles + wind trails) plus a caption into a
 * single canvas, for saving as a PNG or printing.
 */
import { LEGEND_MAX_MPH, trailColor } from './wind-layer.js';

const CAPTION_H = 44;

export interface SnapshotOptions {
  background: string;
  light: boolean;
  title: string;
  subtitle: string;
}

export interface Snapshot {
  canvas: HTMLCanvasElement;
  tilesDropped: boolean;
}

export function snapshot(map: L.Map, windCanvas: HTMLCanvasElement, opts: SnapshotOptions): Snapshot {
  const container = map.getContainer();
  const rect = container.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);

  const out = document.createElement('canvas');
  out.width = Math.round(w * scale);
  out.height = Math.round((h + CAPTION_H) * scale);
  const ctx = out.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, w, h);

  // Tiles: draw every loaded tile image at its on-screen position. This goes
  // on its own canvas first, because a tile server without CORS headers
  // "taints" a canvas and then it can no longer be exported.
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = out.width;
  tileCanvas.height = Math.round(h * scale);
  const tctx = tileCanvas.getContext('2d')!;
  tctx.scale(scale, scale);
  const tiles = container.querySelectorAll<HTMLImageElement>('.leaflet-tile-pane img.leaflet-tile-loaded');
  for (const img of tiles) {
    const r = img.getBoundingClientRect();
    if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
    const layerEl = img.parentNode?.parentNode;
    const opacity = layerEl instanceof Element ? parseFloat(getComputedStyle(layerEl).opacity) : NaN;
    tctx.globalAlpha = isNaN(opacity) ? 1 : opacity;
    tctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
  }
  let tainted = false;
  try {
    tctx.getImageData(0, 0, 1, 1);
    ctx.drawImage(tileCanvas, 0, 0, w, h);
  } catch {
    tainted = true;
  }

  // State and country outlines (Leaflet canvas renderer, same origin).
  const overlays = container.querySelectorAll<HTMLCanvasElement>('.leaflet-borders-pane canvas');
  for (const overlay of overlays) {
    const ob = overlay.getBoundingClientRect();
    ctx.drawImage(overlay, ob.left - rect.left, ob.top - rect.top, ob.width, ob.height);
  }

  // Wind trails.
  ctx.drawImage(windCanvas, 0, 0, w, h);

  // Caption bar.
  ctx.fillStyle = opts.light ? '#ffffff' : '#141619';
  ctx.fillRect(0, h, w, CAPTION_H);
  ctx.fillStyle = opts.light ? '#1b1d21' : '#f2f2f2';
  ctx.font = '600 15px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.title, 12, h + CAPTION_H / 2 - 7);
  ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillStyle = opts.light ? '#5a606b' : '#b8bcc4';
  ctx.fillText(opts.subtitle, 12, h + CAPTION_H / 2 + 10);

  // Legend in the caption bar, right aligned.
  const lw = Math.min(140, w * 0.22);
  const lx = w - lw - 12;
  const ly = h + CAPTION_H / 2 - 4;
  const grad = ctx.createLinearGradient(lx, 0, lx + lw, 0);
  for (let s = 0; s <= 10; s++) grad.addColorStop(s / 10, trailColor(s / 10, opts.light));
  ctx.fillStyle = grad;
  ctx.fillRect(lx, ly, lw, 8);
  ctx.fillStyle = opts.light ? '#5a606b' : '#b8bcc4';
  ctx.font = '10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('calm', lx, ly + 16);
  ctx.textAlign = 'right';
  ctx.fillText(LEGEND_MAX_MPH + '+ mph', lx + lw, ly + 16);
  ctx.textAlign = 'left';

  return { canvas: out, tilesDropped: tainted };
}
