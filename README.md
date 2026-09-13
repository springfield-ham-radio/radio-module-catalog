# Radio Module Catalog

Official index of installable radio modules for the HamBench desktop app.

The app fetches [`catalog.json`](./catalog.json) (served via GitHub Pages) and installs only modules listed here. Each entry points at a JSON-only zip attached to a GitHub Release of the corresponding `radio-module-*` repository. The zip is one manufacturer package; `radios` lists each `configs/*.json` file inside that zip.

## Update workflow

1. Publish a new `radio-module-*` release (semantic-release attaches the zip asset).
2. Run `yarn pack:release` in the module repo. It prints `integrity` and writes `dist-release/catalog-module.json` from `configs/*.json`.
3. Copy that object into `catalog.json` `modules` (or update `version`, `downloadUrl`, `integrity`, and `radios` to match).
4. Push to `main` so GitHub Pages serves the update.

Do not invent radio ids. If a model shares a config (for example UV-5R and UV-5RE Plus), list that config once.

## Schema

See [`catalog.schema.json`](./catalog.schema.json). Keep `schemaVersion` at `1` until the app ships a newer format. `supportedRadios` must be the same ids as `radios[].modelId`.

## Local preview

Serve this directory over HTTPS or use a local static server when testing catalog fetch against a non-Pages URL (override via the app’s catalog URL setting if available).
