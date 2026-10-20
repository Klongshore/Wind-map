# Wind Map

## Language: TypeScript

All app code is TypeScript. Write new code in TypeScript and don't add
JavaScript files to the app.

- Source lives in `src/*.ts`. `tsc` (config in `tsconfig.json`, `strict` on)
  compiles it to `js/*.js`, which is build output: it is gitignored, so never
  edit or commit it.
- The output is native ES modules that `index.html` loads directly, with no
  bundler. Import sibling files with a `.js` extension
  (`import { x } from './wind-field.js'`) so the browser can resolve them.
- Leaflet is vendored in `vendor/leaflet/` and loaded as a classic script.
  Use it through the global `L`, typed by `@types/leaflet`. Don't
  `import 'leaflet'`, because the browser can't resolve bare package names.
- Run `npm run typecheck` (fast) and `npm test` (builds, then runs the
  Playwright smoke test) before pushing.

## Other notes

- `index.html` sets a Content-Security-Policy. If you add a script, style,
  image, or network host, update the policy too.
- Dependencies are pinned to exact versions: npm packages in `package.json`,
  Python packages in `scripts/requirements.txt`, and GitHub Actions by commit
  SHA. Dependabot keeps them updated.
