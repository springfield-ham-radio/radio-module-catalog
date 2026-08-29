# Radio Module Catalog

Official index of installable radio modules for the HamBench desktop app.

The app fetches [`catalog.json`](./catalog.json) (served via GitHub Pages) and installs only modules listed here. Each entry points at a JSON-only zip attached to a GitHub Release of the corresponding `radio-module-*` repository.

## Update workflow

1. Publish a new `radio-module-*` release (semantic-release attaches the zip asset).
2. Compute `sha256:<hex>` of that zip.
3. Update `catalog.json` with the new `version`, `downloadUrl`, and `integrity`.
4. Push to `main` so GitHub Pages serves the update.

## Schema

See [`catalog.schema.json`](./catalog.schema.json). Keep `schemaVersion` at `1` until the app ships a newer format.

## Local preview

Serve this directory over HTTPS or use a local static server when testing catalog fetch against a non-Pages URL (override via the app’s catalog URL setting if available).
