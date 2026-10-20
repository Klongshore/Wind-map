/*
 * Wind data: fetches current 10 m wind for a grid of points from Open-Meteo
 * and interpolates it anywhere inside the grid.
 */
(function (global) {
  'use strict';

  var API_URL = 'https://api.open-meteo.com/v1/forecast';
  var MAX_LAT = 85;
  var CACHE_MS = 10 * 60 * 1000;
  var cache = new Map();

  function wrapLng(lng) {
    return ((((lng + 180) % 360) + 360) % 360) - 180;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Wind direction is where the wind blows FROM, in degrees clockwise from north.
  function toUV(speed, directionDeg) {
    var rad = directionDeg * Math.PI / 180;
    return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
  }

  /*
   * A regular lat/lng grid of u/v wind components (m/s).
   * When `global` is true the grid covers all longitudes and wraps around.
   */
  function WindField(spec) {
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
  WindField.prototype.at = function (lat, lng) {
    if (lat < this.south || lat > this.north) return null;
    var y = (lat - this.south) / this.dLat;
    var x;
    if (this.global) {
      x = (((lng - this.west) % 360) + 360) % 360 / this.dLng;
    } else {
      if (lng < this.west || lng > this.east) return null;
      x = (lng - this.west) / this.dLng;
    }
    var r0 = Math.min(Math.floor(y), this.rows - 2);
    var c0 = Math.floor(x);
    var fy = y - r0;
    var fx = x - c0;
    var c1;
    if (this.global) {
      c0 = c0 % this.cols;
      c1 = (c0 + 1) % this.cols;
    } else {
      c0 = Math.min(c0, this.cols - 2);
      fx = x - c0;
      c1 = c0 + 1;
    }
    var i00 = r0 * this.cols + c0;
    var i01 = r0 * this.cols + c1;
    var i10 = (r0 + 1) * this.cols + c0;
    var i11 = (r0 + 1) * this.cols + c1;
    var u = bilerp(this.u[i00], this.u[i01], this.u[i10], this.u[i11], fx, fy);
    var v = bilerp(this.v[i00], this.v[i01], this.v[i10], this.v[i11], fx, fy);
    return { u: u, v: v, speed: Math.sqrt(u * u + v * v) };
  };

  function bilerp(a00, a01, a10, a11, fx, fy) {
    var top = a00 + (a01 - a00) * fx;
    var bottom = a10 + (a11 - a10) * fx;
    return top + (bottom - top) * fy;
  }

  /*
   * Lays out a grid of sample points that covers `bounds` (a Leaflet
   * LatLngBounds, possibly with longitudes outside -180..180).
   */
  function planGrid(bounds) {
    var south = clamp(bounds.getSouth(), -MAX_LAT, MAX_LAT);
    var north = clamp(bounds.getNorth(), -MAX_LAT, MAX_LAT);
    var west = bounds.getWest();
    var east = bounds.getEast();
    var latPad = (north - south) * 0.15 || 1;
    var lngPad = (east - west) * 0.15 || 1;
    south = clamp(south - latPad, -MAX_LAT, MAX_LAT);
    north = clamp(north + latPad, -MAX_LAT, MAX_LAT);
    west -= lngPad;
    east += lngPad;

    var global = east - west >= 300;
    var rows, cols;
    if (global) {
      west = -180;
      east = 180;
      rows = 15;
      cols = 24;
    } else {
      var aspect = (east - west) / Math.max(north - south, 0.01);
      rows = 11;
      cols = clamp(Math.round(rows * aspect), 8, 18);
      // Snap to a coarse grid so small pans can reuse cached data.
      var step = Math.max((east - west) / (cols - 1), (north - south) / (rows - 1));
      var snap = Math.pow(10, Math.floor(Math.log10(step)));
      south = clamp(Math.floor(south / snap) * snap, -MAX_LAT, MAX_LAT);
      north = clamp(Math.ceil(north / snap) * snap, -MAX_LAT, MAX_LAT);
      west = Math.floor(west / snap) * snap;
      east = Math.ceil(east / snap) * snap;
    }
    return { south: south, north: north, west: west, east: east, rows: rows, cols: cols, global: global };
  }

  function gridPoints(plan) {
    var lats = [];
    var lngs = [];
    var dLat = (plan.north - plan.south) / (plan.rows - 1);
    var dLng = plan.global ? 360 / plan.cols : (plan.east - plan.west) / (plan.cols - 1);
    for (var r = 0; r < plan.rows; r++) {
      for (var c = 0; c < plan.cols; c++) {
        lats.push((plan.south + r * dLat).toFixed(4));
        lngs.push(wrapLng(plan.west + c * dLng).toFixed(4));
      }
    }
    return { lats: lats, lngs: lngs };
  }

  function fetchField(bounds, signal) {
    var plan = planGrid(bounds);
    var pts = gridPoints(plan);
    var url = API_URL +
      '?latitude=' + pts.lats.join(',') +
      '&longitude=' + pts.lngs.join(',') +
      '&current=wind_speed_10m,wind_direction_10m' +
      '&wind_speed_unit=ms&timezone=UTC';

    var hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return Promise.resolve(hit.field);
    }

    return fetch(url, { signal: signal })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            throw new Error(body.reason || ('Wind data request failed (' + res.status + ')'));
          });
        }
        return res.json();
      })
      .then(function (data) {
        var list = Array.isArray(data) ? data : [data];
        if (list.length !== pts.lats.length) {
          throw new Error('Unexpected wind data from server');
        }
        var n = list.length;
        var u = new Float32Array(n);
        var v = new Float32Array(n);
        var time = null;
        for (var i = 0; i < n; i++) {
          var cur = list[i].current || {};
          var uv = toUV(cur.wind_speed_10m || 0, cur.wind_direction_10m || 0);
          u[i] = uv.u;
          v[i] = uv.v;
          time = time || cur.time;
        }
        plan.u = u;
        plan.v = v;
        plan.time = time;
        var field = new WindField(plan);
        cache.set(url, { at: Date.now(), field: field });
        return field;
      });
  }

  global.WindData = {
    fetchField: fetchField,
    WindField: WindField,
    planGrid: planGrid,
    toUV: toUV,
    wrapLng: wrapLng
  };
})(window);
