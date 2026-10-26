# Contributing

Official radios are published by [springfield-ham-radio](https://github.com/springfield-ham-radio) and move forward with the catalog sync described in the [README](./README.md). This page is the pull request for a driver published somewhere else.

The rules come from [ADR 0012](https://github.com/springfield-ham-radio/ham-radio-docs/blob/main/docs/developer/adr/0012-community-drivers.md). The longer guide is [Third-party and manufacturer drivers](https://github.com/springfield-ham-radio/ham-radio-docs/blob/main/docs/developer/third-party-drivers.md).

## List a community driver

Keep the driver in your repository. Open a pull request that adds one `modules` entry to [`catalog.json`](./catalog.json). Bryan Hunt approves it. The entry is pinned to one GitHub Release asset and the SHA-256 of that zip. Shipping a newer zip does not move the catalog. Open another pull request for the new release. The hourly sync skips `tier` `community`.

`schemaVersion` stays `3`. Do not change it in a listing pull request.

```json
{
  "id": "example-ht",
  "package": "@springfield/radio-module-example-ht",
  "manufacturer": "Example",
  "name": "Example HT",
  "tier": "community",
  "publisher": "Example Amateur Radio",
  "version": "1.2.3",
  "config": "configs/example-ht.json",
  "minApiVersion": "18.0.1",
  "downloadUrl": "https://github.com/example-club/radio-module-example/releases/download/v1.2.3/radio-module-example-ht-1.2.3.zip",
  "integrity": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

| Field | Rule |
| --- | --- |
| `tier` | `community`. `official` is only for a release from `springfield-ham-radio`. Omitted means `official`. |
| `publisher` | Display name in **Community, by &lt;publisher&gt;**. Required for `community`. Not a GitHub login and not an npm scope. |
| `package` | `@springfield/radio-module-<id>`. This is a logical id. HamBench on `@springfield/ham-radio-registry` 2.x rejects any other shape, including community entries. |
| `downloadUrl` | HTTPS GitHub Releases URL. The owner must not be `springfield-ham-radio`. The asset name is `radio-module-<id>-<version>.zip`. |
| `integrity` | `sha256:` plus 64 hex characters of that release asset. A repeated-nibble digest is rejected. |
| `id`, `version`, `config`, `minApiVersion` | Taken from the one `configs/*.json` inside the zip. `config` is `configs/<id>.json`. |

Download the release asset and hash those bytes:

```bash
curl -fsSL -o module.zip "$DOWNLOAD_URL"
sha256sum module.zip
```

Prefix the hex with `sha256:`. CI runs `node scripts/verify-community-pins.mjs`, which downloads each community zip and requires the same digest.

## Review checklist

The pull request shows all of the following:

- Schema checks and CI pass (`npm test` and `node scripts/verify-community-pins.mjs`).
- Tests use your own radio dumps. The driver contains no CHIRP code.
- A hardware report: read, write, and restore on a real radio.
- A named maintainer.
- A license of MIT or Apache-2.0.
- A `Signed-off-by` line on each commit ([Developer Certificate of Origin](https://developercertificate.org/)). There is no CLA.

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s`. The listed driver has to be publishable under that license. Confidential radio specifications can stay private.

## Deprecation

Mark an entry when the driver is broken, or when nobody responds for about 90 days. Removal is a later pull request. The hourly sync still does not move a community entry.

```json
"deprecated": {
  "reason": "No maintainer response for 90 days",
  "date": "2026-10-26"
}
```

`reason` is a short explanation. `date` is the calendar date (`YYYY-MM-DD`) the entry was marked. Omit `deprecated` when the driver is not deprecated. An official entry can use the same object. Taking over an openly licensed driver is allowed by MIT and Apache-2.0.

## What this catalog does not store

A zip installed from a file is **Unverified** in HamBench. Do not add a catalog row for it, and do not set `tier` to `unverified`. A `x.y.z-beta.n` file install is **Beta**. There is no beta catalog.
