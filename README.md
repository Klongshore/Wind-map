# Wind Map

An animated wind map in the style of [hint.fm/wind](http://hint.fm/wind/).
Thousands of particles drift with the current surface wind, coloured from calm
(blue) to strong (purple).

- **Zoom and pan** anywhere in the world; the wind reloads for the area you are looking at.
- **Tap or click** a spot to see its wind speed (mph and km/h) and direction.
- **Save image** downloads a PNG of the map with the time and a legend.
- **Print** prints that same image.
- **Light map / Dark map** switches the background (light uses less ink when printing).
- **My location** jumps to where you are.
- The address bar keeps the current view, so a copied link opens the same map.

Wind data is NOAA's GFS global 10 m wind (0.5° grid, free, no key).
`scripts/fetch_wind.py` downloads the latest run into `data/wind.json` and
`data/wind.bin`, and the **Publish site** GitHub Actions workflow
(`.github/workflows/pages.yml`) runs it every 3 hours and publishes the site to
GitHub Pages. For that, set **Settings › Pages › Source** to **GitHub Actions**.
If the wind file is missing (for example when running locally without it), the
page falls back to asking [Open-Meteo](https://open-meteo.com/) for the area in
view, which has a free usage limit. Map tiles are Esri's grey canvas basemaps (no key needed).

## Running it

It is a static page with no build step. Open `index.html` through any web
server, for example:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

To use the NOAA data locally, first run
`pip install pygrib numpy && python3 scripts/fetch_wind.py data`.

## Tests

```sh
npm install
npx playwright install chromium
npm test
```

The smoke test loads the page in Chromium with the wind data and tiles mocked,
checks that the wind animates, zooms in, saves an image and prints. Screenshots
land in `test-output/`.
