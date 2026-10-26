# Radio Module Catalog

Official index of installable radio modules for the HamBench desktop app.

The app fetches [`catalog.json`](./catalog.json) (served via GitHub Pages) and installs only modules listed here. Each entry is one radio: a JSON-only zip named `radio-module-<modelId>-<version>.zip` on a GitHub Release of the corresponding manufacturer `radio-module-*` repository.

## Update workflow

[`Update module catalog`](.github/workflows/update-catalog.yml) keeps `catalog.json` aligned with published module releases.

It runs on three triggers:

- an hourly schedule (`23 * * * *`; GitHub may start the job later)
- `workflow_dispatch` from the Actions tab
- `repository_dispatch` with event type `module-released`

The job uses the workflow `GITHUB_TOKEN` with `contents: write` and `pull-requests: write`. It does not use any other secrets. `node scripts/update-catalog.mjs` reads each entry’s `downloadUrl` to find the manufacturer repository, lists every GitHub release, and skips drafts and prereleases. It considers assets named `radio-module-<id>-<semver>.zip`, picks the highest stable semver per radio, downloads that zip, and continues only when the SHA-256 of those bytes matches the release asset digest. It then sets `version`, `name`, `config`, `minApiVersion`, `downloadUrl`, and `integrity` from the zip’s single `configs/*.json`. `package`, `manufacturer`, `description`, `tier`, `publisher`, and `deprecated` stay as they are in the catalog. An entry with `tier` `community` is pinned to the reviewed release: the sync does not download a newer zip and does not change `version`, `downloadUrl`, or `integrity`. A newer community release is listed only by a reviewed pull request ([CONTRIBUTING.md](./CONTRIBUTING.md)). When no stable release carries an official radio’s zip, a previously verified entry is left unchanged. Placeholder integrity values (every hex digit the same, including `sha256:000…0`) are rejected, so an entry that has never been verified fails the sync and cannot be published. The sync job runs only on `main` and will not open a pull request that changes `schemaVersion`.

`main` is protected, so the workflow does not push the catalog there. When `catalog.json` changes, it force-pushes branch `chore/sync-module-releases` and opens a pull request, or updates the open pull request for that branch. Merging the pull request publishes the catalog through the GitHub Pages workflow.

Check the sync locally without writing the file:

```bash
node scripts/update-catalog.mjs --dry-run
```

`npm test` covers per-radio release selection across tags, zip reading, schema and `@springfield/ham-radio-registry` validation, and dry-run.

### Optional trigger from a module repository

The hourly run picks up a new release on its own. A module repository can also ask for an immediate run after it publishes. This catalog does not store a credential for that call. The module repository needs its own token that is allowed to create a `repository_dispatch` event on `springfield-ham-radio/radio-module-catalog` (for example a fine-grained personal access token or GitHub App installation token). Store that token in the module repository, then POST after the release job succeeds:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $CATALOG_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/springfield-ham-radio/radio-module-catalog/dispatches \
  -d '{"event_type":"module-released"}'
```

The payload is optional. The catalog workflow refreshes every official module listed in `catalog.json`. Community entries stay pinned.

### Manual edit

1. Publish a new `radio-module-*` release (semantic-release attaches the zip asset).
2. Run `yarn pack:release` in the module repo. It writes `dist-release/catalog-entries.json` (schema version 3) and per-radio zips.
3. Copy or sync those entries into `catalog.json` `modules` (or run `node scripts/update-catalog.mjs` after the release publishes).
4. Open a pull request to `main`. GitHub Pages serves the update after the pull request merges.

Do not invent radio ids. If a model shares a config (for example UV-5R and UV-5RE Plus), list that config once.

A driver published outside `springfield-ham-radio` is not added by this sync. The listing pull request is described in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Trust labels

[ADR 0012](https://github.com/springfield-ham-radio/ham-radio-docs/blob/main/docs/developer/adr/0012-community-drivers.md) gives each catalog entry a trust tier. `schemaVersion` stays `3`.

| `tier` | Who publishes the zip | Label in HamBench |
| --- | --- | --- |
| `official` (default) | `springfield-ham-radio` | Official |
| `community` | another GitHub owner, reviewed in a catalog pull request | Community, by `<publisher>` |

`publisher` is the display name. It is required when `tier` is `community`. Every entry already in this catalog is `"tier": "official"` and has no `publisher`.

`deprecated` is optional. When it is present it is `{ "reason": string, "date": "YYYY-MM-DD" }`. Set it when the driver is broken, or when a community maintainer has not responded for about 90 days. The entry stays listed until a later pull request removes it. A file install is **Unverified** in the app. That value is not a catalog tier.

`@springfield/ham-radio-registry` 2.x still parses this document. It ignores `tier`, `publisher`, and `deprecated`. HamBench reads those fields from `catalog.json` when it shows the labels.

## Schema

See [`catalog.schema.json`](./catalog.schema.json). Published catalogs use `schemaVersion` `3` (one entry per radio). HamBench builds on `@springfield/ham-radio-registry` 2.x read this format, plus the trust fields above when that build understands them. `npm test` and `node scripts/verify-community-pins.mjs` validate the schema, the trust rules, and the SHA-256 of each community zip. Pull requests run both.

## Local preview

Serve this directory over HTTPS or use a local static server when testing catalog fetch against a non-Pages URL (override via the app’s catalog URL setting if available).

## License

MIT / Bryan Hunt. See [LICENSE](./LICENSE).
