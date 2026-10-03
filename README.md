# Radio Module Catalog

Official index of installable radio modules for the HamBench desktop app.

The app fetches [`catalog.json`](./catalog.json) (served via GitHub Pages) and installs only modules listed here. Each entry points at a JSON-only zip attached to a GitHub Release of the corresponding `radio-module-*` repository. The zip is one manufacturer package; `radios` lists each `configs/*.json` file inside that zip.

## Update workflow

[`Update module catalog`](.github/workflows/update-catalog.yml) keeps `catalog.json` aligned with published module releases.

It runs on three triggers:

- an hourly schedule (`23 * * * *`; GitHub may start the job later)
- `workflow_dispatch` from the Actions tab
- `repository_dispatch` with event type `module-released`

The job uses the workflow `GITHUB_TOKEN` with `contents: write` and `pull-requests: write`. It does not use any other secrets. `node scripts/update-catalog.mjs` reads each module `downloadUrl`, requests that repository’s latest published GitHub release (drafts and prereleases are excluded), downloads the module zip, and refreshes `version`, `downloadUrl`, `integrity`, `radios`, and `supportedRadios`. `radios` comes from `configs/*.json` inside the zip (`id.model`, `id.name`, and the config path). Manufacturer, description, package name, and `minApiVersion` stay as they are in the catalog. If the latest published release is older than the catalog pin, that module is left unchanged.

`main` is protected, so the workflow does not push the catalog there. When `catalog.json` changes, it force-pushes branch `chore/sync-module-releases` and opens a pull request, or updates the open pull request for that branch. Merging the pull request publishes the catalog through the GitHub Pages workflow.

Check the sync locally without writing the file:

```bash
node scripts/update-catalog.mjs --dry-run
```

`node --test scripts/update-catalog.test.mjs` covers release selection, zip reading, schema validation, and dry-run.

### Optional trigger from a module repository

The hourly run picks up a new release on its own. A module repository can also ask for an immediate run after it publishes. This catalog does not store a credential for that call. The module repository needs its own token that is allowed to create a `repository_dispatch` event on `springfield-ham-radio/radio-module-catalog` (for example a fine-grained personal access token or GitHub App installation token). Store that token in the module repository, then POST after the release job succeeds:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $CATALOG_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/springfield-ham-radio/radio-module-catalog/dispatches \
  -d '{"event_type":"module-released"}'
```

The payload is optional. The catalog workflow refreshes every module listed in `catalog.json`.

### Manual edit

1. Publish a new `radio-module-*` release (semantic-release attaches the zip asset).
2. Run `yarn pack:release` in the module repo. It prints `integrity` and writes `dist-release/catalog-module.json` from `configs/*.json`.
3. Copy that object into `catalog.json` `modules` (or update `version`, `downloadUrl`, `integrity`, and `radios` to match).
4. Open a pull request to `main`. GitHub Pages serves the update after the pull request merges.

Do not invent radio ids. If a model shares a config (for example UV-5R and UV-5RE Plus), list that config once.

## Schema

See [`catalog.schema.json`](./catalog.schema.json). Keep `schemaVersion` at `1` until the app ships a newer format. `supportedRadios` must be the same ids as `radios[].modelId`.

## Local preview

Serve this directory over HTTPS or use a local static server when testing catalog fetch against a non-Pages URL (override via the app’s catalog URL setting if available).

## License

MIT / Bryan Hunt. See [LICENSE](./LICENSE).
