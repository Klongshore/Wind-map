(function () {
  'use strict';

  var TILES = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
  };
  var TILE_ATTRIBUTION =
    'Wind: <a href="https://open-meteo.com/">Open-Meteo</a> | ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>';
  var BACKGROUND = { dark: '#202226', light: '#e9ebee' };

  var statusEl = document.getElementById('status');
  var themeBtn = document.getElementById('btn-theme');
  var saveBtn = document.getElementById('btn-save');
  var printBtn = document.getElementById('btn-print');
  var locateBtn = document.getElementById('btn-locate');
  var printImg = document.getElementById('print-image');

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
    subdomains: 'abcd',
    maxZoom: 19,
    crossOrigin: 'anonymous'
  }).addTo(map);

  var wind = new WindLayer().addTo(map);
  var field = null;
  var pending = null;
  var fetchTimer = null;

  applyTheme(state.theme);

  map.on('moveend', function () {
    saveState();
    scheduleFetch();
  });
  scheduleFetch(0);

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

  function loadWind() {
    if (pending) pending.abort();
    var ctrl = new AbortController();
    pending = ctrl;
    if (!field) setStatus('Loading wind…');
    WindData.fetchField(map.getBounds(), ctrl.signal)
      .then(function (f) {
        if (pending !== ctrl) return;
        pending = null;
        field = f;
        wind.setField(f);
        setStatus(describeTime(f.time));
      })
      .catch(function (err) {
        if (err.name === 'AbortError') return;
        pending = null;
        setStatus('Could not load wind: ' + err.message);
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
      title: 'Wind Map · ' + describeTime(field.time),
      subtitle: 'Wind: Open-Meteo · Map: © OpenStreetMap contributors, © CARTO'
    });
    if (shot.tilesDropped) setStatus('Map tiles could not be included; saved wind only.');
    return shot;
  }

  function applyTheme(theme) {
    state.theme = theme;
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
    if (m) {
      s.lat = +m[1];
      s.lng = +m[2];
      s.zoom = +m[3];
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
