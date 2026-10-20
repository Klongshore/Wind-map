/*
 * Renders what is on screen (map tiles + wind trails) plus a caption into a
 * single canvas, for saving as a PNG or printing.
 */
(function (global) {
  'use strict';

  var CAPTION_H = 44;

  function snapshot(map, windCanvas, opts) {
    var container = map.getContainer();
    var rect = container.getBoundingClientRect();
    var scale = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);

    var out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round((h + CAPTION_H) * scale);
    var ctx = out.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, w, h);

    // Tiles: draw every loaded tile image at its on-screen position. This goes
    // on its own canvas first, because a tile server without CORS headers
    // "taints" a canvas and then it can no longer be exported.
    var tileCanvas = document.createElement('canvas');
    tileCanvas.width = out.width;
    tileCanvas.height = Math.round(h * scale);
    var tctx = tileCanvas.getContext('2d');
    tctx.scale(scale, scale);
    var tiles = container.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded');
    for (var i = 0; i < tiles.length; i++) {
      var img = tiles[i];
      var r = img.getBoundingClientRect();
      if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
      var opacity = parseFloat(getComputedStyle(img.parentNode.parentNode).opacity);
      tctx.globalAlpha = isNaN(opacity) ? 1 : opacity;
      tctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
    }
    var tainted = false;
    try {
      tctx.getImageData(0, 0, 1, 1);
      ctx.drawImage(tileCanvas, 0, 0, w, h);
    } catch (e) {
      tainted = true;
    }

    // State and country outlines (Leaflet canvas renderer, same origin).
    var overlays = container.querySelectorAll('.leaflet-borders-pane canvas');
    for (var j = 0; j < overlays.length; j++) {
      var ob = overlays[j].getBoundingClientRect();
      ctx.drawImage(overlays[j], ob.left - rect.left, ob.top - rect.top, ob.width, ob.height);
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
    var lw = Math.min(140, w * 0.22);
    var lx = w - lw - 12;
    var ly = h + CAPTION_H / 2 - 4;
    var grad = ctx.createLinearGradient(lx, 0, lx + lw, 0);
    for (var s = 0; s <= 10; s++) grad.addColorStop(s / 10, global.WindColors.trailColor(s / 10, opts.light));
    ctx.fillStyle = grad;
    ctx.fillRect(lx, ly, lw, 8);
    ctx.fillStyle = opts.light ? '#5a606b' : '#b8bcc4';
    ctx.font = '10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('calm', lx, ly + 16);
    ctx.textAlign = 'right';
    ctx.fillText(global.WindColors.LEGEND_MAX_MPH + '+ mph', lx + lw, ly + 16);
    ctx.textAlign = 'left';

    return { canvas: out, tilesDropped: tainted };
  }

  global.WindSnapshot = { snapshot: snapshot };
})(window);
