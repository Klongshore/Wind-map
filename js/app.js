(function () {
  'use strict';

  // Esri's grey canvas basemaps: free, no key, and they allow cross-origin use,
  // which the save/print snapshot needs.
  var TILES = {
    dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
  };
  var TILE_ATTRIBUTION =
    'Wind: <a href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast">NOAA GFS</a> | ' +
    'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OSM';
  var BACKGROUND = { dark: '#202226', light: '#e9ebee' };

  var statusEl = document.getElementById('status');
  var themeBtn = document.getElementById('btn-theme');
  var saveBtn = document.getElementById('btn-save');
  var printBtn = document.getElementById('btn-print');
  var locateBtn = document.getElementById('btn-locate');
  var printImg = document.getElementById('print-image');
  var pauseBtn = document.getElementById('btn-pause');
  var paused = false;

  var state = loadState();

  var map = L.map('map', {
    center: [state.lat, state.lng],
    zoom: state.zoom,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomSnap: 0.5
  });

  var tiles = L.tileLayer(TILES[state.theme], {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 16,
    crossOrigin: 'anonymous'
  }).addTo(map);

  // State and country outlines, drawn on a canvas so they can be saved/printed.
  map.createPane('borders');
  map.getPane('borders').style.zIndex = 350;
  map.getPane('borders').style.pointerEvents = 'none';
  var borderRenderer = L.canvas({ pane: 'borders', padding: 0.5 });
  var borders = L.layerGroup().addTo(map);
  fetch('data/borders.json')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      borders.addLayer(L.geoJSON({ type: 'MultiLineString', coordinates: data.countries }, {
        renderer: borderRenderer, interactive: false, style: borderStyle(0.8)
      }));
      borders.addLayer(L.geoJSON({ type: 'MultiLineString', coordinates: data.states }, {
        renderer: borderRenderer, interactive: false, style: borderStyle(0.5)
      }));
    })
    .catch(function () { /* the map still works without outlines */ });

  var wind = new WindLayer().addTo(map);
  var field = null;
  var pending = null;
  var fetchTimer = null;

  applyTheme(state.theme);

  map.on('moveend', function () {
    saveState();
    scheduleFetch();
  });
  // Prefer the global wind file; fall back to asking Open-Meteo for the view.
  loadWindFile(true);
  setInterval(function () { loadWindFile(false); }, 30 * 60 * 1000);

  map.on('click', function (e) {
    if (!field) return;
    var w = field.at(e.latlng.lat, e.latlng.lng);
    if (!w) return;
    var mph = w.speed * WindColors.MPH_PER_MS;
    var kmh = w.speed * 3.6;
    // Direction the wind is coming FROM, compass style.
    var from = (Math.atan2(-w.u, -w.v) * 180 / Math.PI + 360) % 360;
    L.popup()
      .setLatLng(e.latlng)
      .setContent(
        '<div class="wind-popup"><strong>' + Math.round(mph) + ' mph</strong> (' +
        Math.round(kmh) + ' km/h)<br>from ' + compass(from) + ' (' + Math.round(from) + '&deg;) ' +
        '<span class="arrow" style="transform:rotate(' + Math.round(from + 180) + 'deg)">&uarr;</span></div>'
      )
      .openOn(map);
  });

  pauseBtn.addEventListener('click', function () {
    paused = !paused;
    wind.setPaused(paused);
    pauseBtn.textContent = paused ? 'Play' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(paused));
  });

  themeBtn.addEventListener('click', function () {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    saveState();
  });

  saveBtn.addEventListener('click', function () {
    var shot = takeSnapshot();
    if (!shot) return;
    var name = 'wind-map-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
    shot.canvas.toBlob(function (blob) {
      if (!blob) return setStatus('Could not create the image.');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }, 'image/png');
  });

  printBtn.addEventListener('click', function () {
    var shot = takeSnapshot();
    if (!shot) return;
    printImg.onload = function () {
      printImg.onload = null;
      window.print();
    };
    printImg.src = shot.canvas.toDataURL('image/png');
  });

  locateBtn.addEventListener('click', function () {
    if (!navigator.geolocation) return setStatus('Location is not available in this browser.');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 7));
      },
      function () { setStatus('Could not get your location.'); },
      { timeout: 10000 }
    );
  });

  function scheduleFetch(delay) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(loadWind, delay === undefined ? 350 : delay);
  }

  function loadWindFile(firstTime) {
    WindData.fetchFileField('data/')
      .then(function (f) {
        if (field && field.fromFile && field.time === f.time) return;
        useField(f);
      })
      .catch(function () {
        if (firstTime) scheduleFetch(0);
      });
  }

  function useField(f) {
    field = f;
    wind.setField(f);
    setStatus(describeTime(f.time));
  }

  function loadWind() {
    if (field && (field.fromFile || field.covers(map.getBounds()))) return;
    if (pending) pending.abort();
    var ctrl = new AbortController();
    pending = ctrl;
    if (!field) setStatus('Loading wind…');
    WindData.fetchField(map.getBounds(), ctrl.signal)
      .then(function (f) {
        if (pending !== ctrl) return;
        pending = null;
        useField(f);
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        pending = null;
        setStatus(field
          ? 'Showing earlier wind. The wind service said: ' + err.message
          : 'Could not load wind: ' + err.message);
      });
  }

  function takeSnapshot() {
    if (!field) {
      setStatus('Wait for the wind to load first.');
      return null;
    }
    var shot = WindSnapshot.snapshot(map, wind.canvas, {
      background: BACKGROUND[state.theme],
      light: state.theme === 'light',
      title: describeTime(field.time),
      subtitle: 'Wind: ' + (field.fromFile ? 'NOAA GFS' : 'Open-Meteo') + ' · Map: © Esri, OpenStreetMap'
    });
    if (shot.tilesDropped) setStatus('Map tiles could not be included; saved wind only.');
    return shot;
  }

  function borderStyle(weight) {
    return function () {
      return {
        color: state.theme === 'light' ? '#000' : '#fff',
        opacity: state.theme === 'light' ? 0.3 : 0.25,
        weight: weight
      };
    };
  }

  function applyTheme(theme) {
    state.theme = theme;
    wind.setLight(theme === 'light');
    borders.eachLayer(function (layer) { layer.setStyle(layer.options.style); });
    document.body.classList.toggle('light', theme === 'light');
    tiles.setUrl(TILES[theme]);
    themeBtn.textContent = theme === 'dark' ? 'Light map' : 'Dark map';
  }

  function describeTime(iso) {
    if (!iso) return 'Current wind';
    var d = new Date(iso + 'Z');
    if (isNaN(d)) return 'Current wind';
    return 'Wind at ' + d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function compass(deg) {
    var names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(deg / 22.5) % 16];
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // The view and theme are remembered in the URL hash so a link reopens the same map.
  function loadState() {
    var s = { lat: 39, lng: -96, zoom: 4, theme: 'dark' };
    var m = /^#(-?[\d.]+),(-?[\d.]+),([\d.]+)z(?:,(light|dark))?/.exec(location.hash);
    // The pattern also lets through things like "1.2.3", so check the numbers.
    if (m && isFinite(m[1]) && isFinite(m[2]) && isFinite(m[3])) {
      s.lat = Math.max(-85, Math.min(85, +m[1]));
      s.lng = +m[2];
      s.zoom = Math.max(2, Math.min(12, +m[3]));
      if (m[4]) s.theme = m[4];
    }
    return s;
  }

  function saveState() {
    var c = map.getCenter().wrap();
    var hash = '#' + c.lat.toFixed(3) + ',' + c.lng.toFixed(3) + ',' + map.getZoom() + 'z,' + state.theme;
    history.replaceState(null, '', hash);
  }
})();
