/*
 * Animated wind-particle layer for Leaflet, in the style of hint.fm/wind:
 * particles drift slowly with the wind, each drawing a long tapering trail
 * from its recent path, so the flow patterns read clearly on screen and in
 * saved or printed images.
 */
(function (global) {
  'use strict';

  var CELL = 6;              // px size of the screen-space velocity lookup grid
  var SPEED_SCALE = 0.12;    // px per step for each m/s of wind
  var SAMPLE = 6;            // steps between remembered trail points
  var TRAIL = 28;            // trail points kept per particle
  var MAX_AGE = 600;         // steps before a particle is respawned
  var SECTIONS = 3;          // trail drawn in parts, fainter towards the tail
  var MPH_PER_MS = 2.23694;
  var LEGEND_MAX_MPH = 40;

  // Black-and-white trails: faster wind draws brighter (or darker on the
  // light map), like hint.fm/wind.
  var BUCKETS = 8;

  function trailColor(t, light) {
    t = Math.max(0, Math.min(1, t));
    var alpha = (0.4 + 0.6 * t).toFixed(2);
    return light ? 'rgba(20,20,20,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')';
  }

  // colors[bucket][section]: speed sets the base strength, the tail fades out.
  function bucketColors(light) {
    var colors = [];
    for (var b = 0; b < BUCKETS; b++) {
      var row = [];
      var base = 0.4 + 0.6 * (b / (BUCKETS - 1));
      for (var k = 0; k < SECTIONS; k++) {
        var alpha = (base * (k + 1) / SECTIONS).toFixed(3);
        row.push(light ? 'rgba(20,20,20,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')');
      }
      colors.push(row);
    }
    return colors;
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
      this._colors = this._colors || bucketColors(false);

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

    setLight: function (light) {
      this._colors = bucketColors(light);
      if (this._map) this._rebuild();
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
      if (this._paused) {
        // Draw a still frame (the trails were grown in _spawnAll).
        this._draw();
        return;
      }
      this._running = true;
      this._tick();
    },

    setPaused: function (paused) {
      this._paused = paused;
      if (paused) {
        this._stop();
      } else if (this._map && this._field && !this._running) {
        this._running = true;
        this._tick();
      }
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
      var count = Math.round(Math.min(4500, Math.max(1500, area / 180)));
      this._particles = new Array(count);
      for (var i = 0; i < count; i++) {
        this._particles[i] = this._spawn({
          hx: new Float32Array(TRAIL),
          hy: new Float32Array(TRAIL)
        }, true);
      }
      // Let the trails grow before the first frame is shown.
      for (var f = 0; f < SAMPLE * TRAIL; f++) this._step();
    },

    _spawn: function (p, randomAge) {
      p.x = Math.random() * this._w;
      p.y = Math.random() * this._h;
      p.age = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
      p.len = 0;      // remembered points
      p.head = 0;     // ring buffer slot for the next point
      p.bucket = 0;
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
      // Redraw every other display frame (half the drawing work) and move the
      // particles two steps each time.
      this._odd = !this._odd;
      if (this._odd) {
        this._step();
        this._step();
        this._draw();
      }
      var self = this;
      this._frame = requestAnimationFrame(function () { self._tick(); });
    },

    // Moves every particle one step and remembers its path.
    _step: function () {
      var g = this._grid;
      var ps = this._particles;
      for (var n = 0; n < ps.length; n++) {
        var p = ps[n];
        var i = this._lookup(p.x, p.y);
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
        var t = (g.sp[i] * MPH_PER_MS) / LEGEND_MAX_MPH;
        p.bucket = Math.min(BUCKETS - 1, Math.floor(t * (BUCKETS - 1) + 0.5));
      }
    },

    // Redraws every trail from scratch, grouped by color for speed.
    _draw: function () {
      var ctx = this._ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      var ps = this._particles;
      for (var b = 0; b < BUCKETS; b++) {
        for (var k = 0; k < SECTIONS; k++) {
          ctx.beginPath();
          var any = false;
          for (var n = 0; n < ps.length; n++) {
            var p = ps[n];
            if (p.bucket !== b || p.len < 2) continue;
            // Points oldest to newest, then the live position.
            var total = p.len + 1;
            var from = Math.floor(k * (total - 1) / SECTIONS);
            var to = Math.floor((k + 1) * (total - 1) / SECTIONS);
            if (to <= from) continue;
            var oldest = (p.head - p.len + TRAIL) % TRAIL;
            for (var j = from; j <= to; j++) {
              var x, y;
              if (j === p.len) {
                x = p.x;
                y = p.y;
              } else {
                var slot = (oldest + j) % TRAIL;
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
  });

  global.WindLayer = WindLayer;
  global.WindColors = { trailColor: trailColor, MPH_PER_MS: MPH_PER_MS, LEGEND_MAX_MPH: LEGEND_MAX_MPH };
})(window);
