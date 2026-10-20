/*
 * Animated wind-particle layer for Leaflet, in the style of hint.fm/wind:
 * thousands of particles drift with the wind and leave fading trails.
 */
(function (global) {
  'use strict';

  var CELL = 6;              // px size of the screen-space velocity lookup grid
  var FADE = 0.93;           // how much of each trail survives a frame
  var MAX_AGE = 90;          // frames before a particle is respawned
  var SPEED_SCALE = 0.22;    // px per frame for each m/s of wind
  var MPH_PER_MS = 2.23694;
  var LEGEND_MAX_MPH = 40;

  // Colour ramp matching the legend in the page (calm -> strong).
  var RAMP = [
    [79, 143, 214],
    [70, 198, 165],
    [232, 214, 74],
    [240, 138, 60],
    [226, 67, 59],
    [177, 58, 209]
  ];
  var BUCKETS = 16;

  function rampColor(t, alpha) {
    t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    var i = Math.min(Math.floor(t), RAMP.length - 2);
    var f = t - i;
    var a = RAMP[i];
    var b = RAMP[i + 1];
    return 'rgba(' +
      Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * f) + ',' + alpha + ')';
  }

  var BUCKET_COLORS = [];
  for (var b = 0; b < BUCKETS; b++) {
    BUCKET_COLORS.push(rampColor(b / (BUCKETS - 1), 0.9));
  }

  var WindLayer = L.Layer.extend({
    onAdd: function (map) {
      this._map = map;
      this.canvas = L.DomUtil.create('canvas', 'wind-canvas');
      map.getContainer().appendChild(this.canvas);
      this._ctx = this.canvas.getContext('2d');
      this._particles = [];
      this._grid = null;
      this._running = false;

      map.on('movestart zoomstart', this._pause, this);
      map.on('moveend resize', this._rebuild, this);
      this._rebuild();
    },

    onRemove: function (map) {
      map.off('movestart zoomstart', this._pause, this);
      map.off('moveend resize', this._rebuild, this);
      this._stop();
      L.DomUtil.remove(this.canvas);
    },

    setField: function (field) {
      this._field = field;
      this._rebuild();
    },

    _pause: function () {
      this._stop();
      this._clear();
      this.canvas.style.visibility = 'hidden';
    },

    _stop: function () {
      this._running = false;
      if (this._frame) cancelAnimationFrame(this._frame);
      this._frame = null;
    },

    _clear: function () {
      this._ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    },

    _rebuild: function () {
      if (!this._map) return;
      this._stop();
      var size = this._map.getSize();
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
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
      this._buildGrid();
      this._spawnAll();
      this._running = true;
      this._tick();
    },

    // Precompute wind (in px/frame) for a coarse grid of screen positions.
    _buildGrid: function () {
      var cols = Math.ceil(this._w / CELL) + 1;
      var rows = Math.ceil(this._h / CELL) + 1;
      var vx = new Float32Array(cols * rows);
      var vy = new Float32Array(cols * rows);
      var sp = new Float32Array(cols * rows);
      var valid = new Uint8Array(cols * rows);
      var map = this._map;
      var field = this._field;
      var pt = L.point(0, 0);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          pt.x = c * CELL;
          pt.y = r * CELL;
          var ll = map.containerPointToLatLng(pt);
          var w = field.at(ll.lat, ll.lng);
          var i = r * cols + c;
          if (!w) continue;
          vx[i] = w.u * SPEED_SCALE;
          vy[i] = -w.v * SPEED_SCALE;
          sp[i] = w.speed;
          valid[i] = 1;
        }
      }
      this._grid = { cols: cols, rows: rows, vx: vx, vy: vy, sp: sp, valid: valid };
    },

    _spawnAll: function () {
      var area = this._w * this._h;
      var count = Math.round(Math.min(6000, Math.max(800, area / 220)));
      this._particles = new Array(count);
      for (var i = 0; i < count; i++) {
        this._particles[i] = this._spawn({}, true);
      }
    },

    _spawn: function (p, randomAge) {
      p.x = Math.random() * this._w;
      p.y = Math.random() * this._h;
      p.age = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
      return p;
    },

    _lookup: function (x, y) {
      var g = this._grid;
      var c = Math.round(x / CELL);
      var r = Math.round(y / CELL);
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
      var i = r * g.cols + c;
      return g.valid[i] ? i : -1;
    },

    _tick: function () {
      if (!this._running) return;
      var ctx = this._ctx;
      var dpr = this._dpr;
      var g = this._grid;

      // Fade existing trails.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0,0,0,' + FADE + ')';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var paths = [];
      for (var k = 0; k < BUCKETS; k++) paths.push([]);

      var ps = this._particles;
      for (var n = 0; n < ps.length; n++) {
        var p = ps[n];
        var i = this._lookup(p.x, p.y);
        if (i < 0 || p.age++ > MAX_AGE) {
          this._spawn(p, false);
          continue;
        }
        var nx = p.x + g.vx[i];
        var ny = p.y + g.vy[i];
        var t = (g.sp[i] * MPH_PER_MS) / LEGEND_MAX_MPH;
        var bucket = Math.min(BUCKETS - 1, Math.floor(t * (BUCKETS - 1) + 0.5));
        paths[bucket].push(p.x, p.y, nx, ny);
        p.x = nx;
        p.y = ny;
      }

      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      for (var bk = 0; bk < BUCKETS; bk++) {
        var segs = paths[bk];
        if (!segs.length) continue;
        ctx.strokeStyle = BUCKET_COLORS[bk];
        ctx.beginPath();
        for (var s = 0; s < segs.length; s += 4) {
          ctx.moveTo(segs[s], segs[s + 1]);
          ctx.lineTo(segs[s + 2], segs[s + 3]);
        }
        ctx.stroke();
      }

      var self = this;
      this._frame = requestAnimationFrame(function () { self._tick(); });
    }
  });

  global.WindLayer = WindLayer;
  global.WindColors = { rampColor: rampColor, MPH_PER_MS: MPH_PER_MS, LEGEND_MAX_MPH: LEGEND_MAX_MPH };
})(window);
