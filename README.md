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

The code is TypeScript in `src/`. It compiles to plain ES modules in `js/`
(not committed), which the page loads directly, with no bundler. Build it, then
open `index.html` through any web server (opening the file directly won't
work, because browsers only load modules over HTTP):

```sh
npm install
npm run build        # or: npx tsc -p . --watch
python3 -m http.server 8000
# then visit http://localhost:8000
```

`npm run typecheck` checks the types without writing any files.

The test and the borders build script (`data/build-borders.ts`) are TypeScript
too. Node 22.18 or newer runs them directly by stripping the types, with no
compile step; `npm run build:borders` regenerates `data/borders.json`.

To use the NOAA data locally, first run
`pip install -r scripts/requirements.txt && python3 scripts/fetch_wind.py data`.

## Tests

```sh
npm install
npx playwright install chromium
npm test
```

`npm test` builds the TypeScript first. The smoke test loads the page in Chromium with the wind data and tiles mocked,
checks that the wind animates, zooms in, saves an image and prints. Screenshots
land in `test-output/`.
