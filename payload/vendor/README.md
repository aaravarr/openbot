# Vendored compression libraries

`payload/image-read.cjs` re-encodes oversized images to JPEG so outbound hop
requests stay inside the upstream body limits. These two pure-JS libraries are
vendored here so the compression ladder keeps working on boxes that cannot
reach the npm registry. The lazy loader resolves the vendored copies FIRST (so
an install without `node_modules` — the normal tarball shape — always
compresses), and falls back to npm `node_modules` in source checkouts.
`install.sh` skips its best-effort `npm install --omit=dev` step entirely when
both packages are present here.

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| `pngjs` | 7.0.0 | MIT | https://github.com/lukeapage/pngjs |
| `jpeg-js` | 0.4.4 | BSD-3-Clause | https://github.com/eugeneware/jpeg-js |

Both are dependency-free pure JavaScript. Each directory keeps the upstream
`package.json` (for `main` resolution and version attribution) and the
original `LICENSE`. Nothing in the vendored sources is modified.

Trimmed from the npm packages to keep the payload small:

- `pngjs`: `browser.js` (browser bundle), `README.md`, `CHANGELOG.md`, `examples/`, `test/`
- `jpeg-js`: `README.md`, `CONTRIBUTING.md`, `index.d.ts`, `.github/`, `test/`

To update a vendored library: bump the version in the root `package.json`,
copy the same runtime files from the freshly installed `node_modules/<pkg>`
into `payload/vendor/<pkg>/` (keep `package.json` + `LICENSE`, trim as above),
and re-run the image test suite (`npm test`).
