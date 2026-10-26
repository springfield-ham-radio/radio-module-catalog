#!/usr/bin/env node
/**
 * Refresh catalog.json from published per-radio GitHub Release assets (ADR 0009).
 *
 * Usage:
 *   node scripts/update-catalog.mjs [--dry-run] [--catalog path] [--schema path] [--report path]
 *
 * For each catalog entry, resolves the manufacturer repo from downloadUrl, scans every
 * published release (drafts and prereleases are skipped), considers assets named
 * radio-module-<id>-<semver>.zip, picks the highest stable semver, downloads the zip,
 * verifies the release digest, and sets version, name, config, minApiVersion, downloadUrl,
 * and integrity from that asset. package, manufacturer, description, tier, publisher, and
 * deprecated stay as they are in the catalog. tier community is pinned to the reviewed
 * release and is not moved to a newer zip. Drafts and prereleases are
 * ignored. A model with no matching asset keeps a previously verified entry; a placeholder
 * integrity is rejected so it cannot be merged or published.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModuleCatalog } from "@springfield/ham-radio-registry";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

/** Matches radio-module-<modelId>-<major.minor.patch>.zip (not legacy manufacturer zips). */
export const PER_RADIO_ASSET_PATTERN =
  /^radio-module-([a-z0-9]+(?:-[a-z0-9]+)+)-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.zip$/i;

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    catalogPath: resolve(repoRoot, "catalog.json"),
    schemaPath: resolve(repoRoot, "catalog.schema.json"),
    reportPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--catalog") {
      options.catalogPath = resolve(argv[++index]);
    } else if (arg === "--schema") {
      options.schemaPath = resolve(argv[++index]);
    } else if (arg === "--report") {
      options.reportPath = resolve(argv[++index]);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return options;
}

export function parseGithubRepo(downloadUrl) {
  const url = new URL(downloadUrl);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\//);
  if ((url.hostname !== "github.com" && url.hostname !== "www.github.com") || !match) {
    throw new Error(`cannot find a GitHub repository in download URL ${downloadUrl}`);
  }

  return { owner: match[1], repo: match[2] };
}

export function versionFromTag(tagName) {
  return String(tagName || "").replace(/^v/, "");
}

export function compareSemver(left, right) {
  const leftParts = String(left).split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = String(right).split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (Number.isNaN(leftPart) || Number.isNaN(rightPart)) {
      throw new Error(`invalid semver "${left}" or "${right}"`);
    }
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

export function parsePerRadioAssetName(assetName, modelId) {
  const match = PER_RADIO_ASSET_PATTERN.exec(assetName);
  if (!match) {
    return undefined;
  }
  const [, assetModelId, version] = match;
  if (assetModelId !== modelId) {
    return undefined;
  }
  return version;
}

export function expectedPerRadioAssetName(modelId, version) {
  return `radio-module-${modelId}-${version}.zip`;
}

/**
 * Collect the highest semver per-radio asset for modelId across published releases.
 * Returns undefined when no matching asset exists.
 */
export function selectHighestPerRadioAsset(releases, modelId) {
  let best;

  for (const release of releases || []) {
    if (release.draft || release.prerelease) {
      continue;
    }

    for (const asset of release.assets || []) {
      if (typeof asset?.name !== "string") {
        continue;
      }
      const version = parsePerRadioAssetName(asset.name, modelId);
      if (!version) {
        continue;
      }
      if (
        !best ||
        compareSemver(version, best.version) > 0 ||
        (compareSemver(version, best.version) === 0 &&
          compareSemver(versionFromTag(release.tag_name), versionFromTag(best.release.tag_name)) > 0)
      ) {
        best = { asset, release, version };
      }
    }
  }

  return best;
}

export function sha256Integrity(buffer) {
  const digest = createHash("sha256").update(buffer).digest("hex");
  return `sha256:${digest}`;
}

/** True for digests that were never computed from a zip (sha256:000…0 and any repeated nibble). */
export function isPlaceholderIntegrity(integrity) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(integrity ?? "").trim());
  if (!match) {
    return false;
  }
  return /^(.)\1{63}$/i.test(match[1]);
}

export function readZipEntries(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const endOfCentralDirectory = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(endOfCentralDirectory + 10);
  let offset = data.readUInt32LE(endOfCentralDirectory + 16);
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("zip central directory header is invalid");
    }

    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localHeaderOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`zip64 entry is not supported: ${name}`);
    }

    if (data.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`zip local header is invalid for ${name}`);
    }

    const localNameLength = data.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = data.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(dataStart, dataStart + compressedSize);
    let content = Buffer.alloc(0);

    if (!name.endsWith("/")) {
      if (method === 0) {
        content = Buffer.from(compressed);
      } else if (method === 8) {
        content = inflateRawSync(compressed);
      } else {
        throw new Error(`unsupported zip method ${method} for ${name}`);
      }
    }

    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(data) {
  const minimum = Math.max(0, data.length - 22 - 65535);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = data.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === data.length) {
        return offset;
      }
    }
  }

  throw new Error("zip end of central directory not found");
}

export function configFromZip(buffer, expectedModelId) {
  const configs = readZipEntries(buffer).filter((entry) => /^configs\/[^/]+\.json$/.test(entry.name));

  if (configs.length !== 1) {
    throw new Error(`module zip must contain exactly one configs/*.json, found ${configs.length}`);
  }

  const entry = configs[0];
  const parsed = JSON.parse(entry.content.toString("utf8"));
  const modelId = parsed?.id?.model;
  const name = parsed?.id?.name;
  const version = parsed?.version;
  const minApiVersion = parsed?.minApiVersion;

  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error(`${entry.name} is missing id.model`);
  }
  if (expectedModelId && modelId !== expectedModelId) {
    throw new Error(`${entry.name} id.model ${modelId} does not match catalog id ${expectedModelId}`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${entry.name} is missing id.name`);
  }
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`${entry.name} is missing a major.minor.patch version`);
  }
  if (typeof minApiVersion !== "string" || minApiVersion.length === 0) {
    throw new Error(`${entry.name} is missing minApiVersion`);
  }
  if (entry.name !== `configs/${modelId}.json`) {
    throw new Error(`${entry.name} must be configs/${modelId}.json`);
  }

  return {
    modelId,
    name,
    version,
    minApiVersion,
    config: entry.name,
  };
}

export function applyVerifiedAsset(moduleEntry, selection, zipBuffer) {
  const { asset, release, version: assetVersion } = selection;

  if (release.draft || release.prerelease) {
    throw new Error(`${moduleEntry.id} release ${release.tag_name} is not a published release`);
  }

  if (asset.name !== expectedPerRadioAssetName(moduleEntry.id, assetVersion)) {
    throw new Error(`${moduleEntry.id} asset name ${asset.name} does not match version ${assetVersion}`);
  }

  if (typeof asset.browser_download_url !== "string" || asset.browser_download_url.length === 0) {
    throw new Error(`${moduleEntry.id} release ${release.tag_name} zip has no download URL`);
  }

  const integrity = sha256Integrity(zipBuffer);
  if (isPlaceholderIntegrity(integrity)) {
    throw new Error(`${moduleEntry.id} zip integrity is a placeholder and must not be published`);
  }
  if (typeof asset.digest !== "string" || asset.digest.length === 0) {
    throw new Error(`${moduleEntry.id} release ${release.tag_name} zip has no checksum to verify`);
  }
  const digest = asset.digest.trim().toLowerCase();
  const normalizedDigest = digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
  if (normalizedDigest !== integrity.toLowerCase()) {
    throw new Error(
      `${moduleEntry.id} zip ${integrity} does not match release asset digest ${asset.digest}`,
    );
  }

  const config = configFromZip(zipBuffer, moduleEntry.id);
  if (config.version !== assetVersion) {
    throw new Error(
      `${moduleEntry.id} zip config version ${config.version} does not match asset version ${assetVersion}`,
    );
  }

  const next = {
    ...moduleEntry,
    name: config.name,
    version: config.version,
    config: config.config,
    minApiVersion: config.minApiVersion,
    downloadUrl: asset.browser_download_url,
    integrity,
  };
  const changed = JSON.stringify(moduleEntry) !== JSON.stringify(next);

  return {
    module: next,
    change: {
      id: moduleEntry.id,
      action: changed ? "updated" : "unchanged",
      from: moduleEntry.version,
      to: config.version,
    },
  };
}

const MODULE_KEY_ORDER = [
  "id",
  "package",
  "manufacturer",
  "name",
  "description",
  "tier",
  "publisher",
  "version",
  "config",
  "minApiVersion",
  "downloadUrl",
  "integrity",
  "deprecated",
];

const OFFICIAL_GITHUB_OWNER = "springfield-ham-radio";

export function moduleTier(moduleEntry) {
  return moduleEntry?.tier === "community" ? "community" : "official";
}

function orderedModuleKeys(moduleEntry) {
  const keys = Object.keys(moduleEntry);
  const ordered = MODULE_KEY_ORDER.filter((key) => keys.includes(key));
  for (const key of keys) {
    if (!ordered.includes(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

function catalogJsonValue(key, value) {
  if (key === "deprecated" && value && typeof value === "object" && !Array.isArray(value)) {
    const ordered = {};
    if (Object.prototype.hasOwnProperty.call(value, "reason")) {
      ordered.reason = value.reason;
    }
    if (Object.prototype.hasOwnProperty.call(value, "date")) {
      ordered.date = value.date;
    }
    for (const child of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(ordered, child)) {
        ordered[child] = value[child];
      }
    }
    return JSON.stringify(ordered);
  }
  return JSON.stringify(value);
}

export function formatCatalog(catalog) {
  const lines = ["{"];
  lines.push(`  "schemaVersion": ${catalog.schemaVersion},`);
  lines.push('  "modules": [');

  catalog.modules.forEach((moduleEntry, moduleIndex) => {
    lines.push("    {");
    const keys = orderedModuleKeys(moduleEntry);
    keys.forEach((key, keyIndex) => {
      const comma = keyIndex === keys.length - 1 ? "" : ",";
      lines.push(`      "${key}": ${catalogJsonValue(key, moduleEntry[key])}${comma}`);
    });
    const moduleComma = moduleIndex === catalog.modules.length - 1 ? "" : ",";
    lines.push(`    }${moduleComma}`);
  });

  lines.push("  ]");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function validateCatalog(catalog, schema) {
  const errors = [];
  checkSchema(catalog, schema, "catalog", errors);
  if (catalog && Array.isArray(catalog.modules)) {
    catalog.modules.forEach((moduleEntry, index) => {
      if (moduleEntry && isPlaceholderIntegrity(moduleEntry.integrity)) {
        errors.push(
          `catalog.modules[${index}].integrity is a placeholder and must not be published (${moduleEntry.id || "unknown"})`,
        );
      }
      assertReleaseOwnerMatchesTier(moduleEntry, index, errors);
    });
  }
  if (errors.length > 0) {
    throw new Error(`catalog.json is not publishable:\n${errors.join("\n")}`);
  }
  parseModuleCatalog(JSON.stringify(catalog));
}

function assertReleaseOwnerMatchesTier(moduleEntry, index, errors) {
  if (!moduleEntry || typeof moduleEntry !== "object" || Array.isArray(moduleEntry)) {
    return;
  }
  if (typeof moduleEntry.downloadUrl !== "string" || moduleEntry.downloadUrl.length === 0) {
    return;
  }

  let owner;
  try {
    owner = parseGithubRepo(moduleEntry.downloadUrl).owner.toLowerCase();
  } catch {
    errors.push(
      `catalog.modules[${index}].downloadUrl must be a GitHub Releases asset URL (${moduleEntry.id || "unknown"})`,
    );
    return;
  }

  const tier = moduleTier(moduleEntry);
  if (tier === "official" && owner !== OFFICIAL_GITHUB_OWNER) {
    errors.push(
      `catalog.modules[${index}] tier official must be a GitHub release from ${OFFICIAL_GITHUB_OWNER} (${moduleEntry.id || "unknown"})`,
    );
  }
  if (tier === "community" && owner === OFFICIAL_GITHUB_OWNER) {
    errors.push(
      `catalog.modules[${index}] tier community must be a GitHub release outside ${OFFICIAL_GITHUB_OWNER} (${moduleEntry.id || "unknown"})`,
    );
  }
}

/**
 * Download each community zip and require its SHA-256 to match integrity.
 * Official entries are checked by the release sync, not here.
 */
export async function verifyCommunityPins(catalog, fetchImpl = fetch) {
  const errors = [];
  const modules = Array.isArray(catalog?.modules) ? catalog.modules : [];

  for (let index = 0; index < modules.length; index += 1) {
    const moduleEntry = modules[index];
    if (!moduleEntry || moduleEntry.tier !== "community") {
      continue;
    }
    const label = moduleEntry.id || "unknown";
    try {
      const zipBuffer = await downloadZip(moduleEntry.downloadUrl, fetchImpl);
      const integrity = sha256Integrity(zipBuffer);
      if (integrity !== String(moduleEntry.integrity ?? "").trim().toLowerCase()) {
        errors.push(
          `catalog.modules[${index}] ${label} pin ${moduleEntry.integrity} does not match downloaded zip ${integrity}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`catalog.modules[${index}] ${label} community pin could not be verified: ${message}`);
    }
  }

  return errors;
}

function checkSchema(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  const objectKeywords =
    schema.properties || schema.required || schema.additionalProperties === false;
  if (schema.type === "object" || (!schema.type && objectKeywords)) {
    checkObjectSchema(value, schema, path, errors);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
    } else {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
      }
      if (schema.items) {
        value.forEach((item, index) => {
          checkSchema(item, schema.items, `${path}[${index}]`, errors);
        });
      }
    }
  } else if (schema.type === "string") {
    checkStringSchema(value, schema, path, errors);
  } else if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${path} must be an integer`);
  }

  if (Array.isArray(schema.allOf)) {
    for (const subschema of schema.allOf) {
      checkSchema(value, subschema, path, errors);
    }
  }

  if (schema.if) {
    const ifErrors = [];
    checkSchema(value, schema.if, path, ifErrors);
    if (ifErrors.length === 0) {
      if (schema.then) {
        checkSchema(value, schema.then, path, errors);
      }
    } else if (schema.else) {
      checkSchema(value, schema.else, path, errors);
    }
  }
}

function checkObjectSchema(value, schema, path, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${path}.${key} is required`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      checkSchema(value[key], propertySchema, `${path}.${key}`, errors);
    }
  }
}

function checkStringSchema(value, schema, path, errors) {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path} must not be empty`);
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} does not match ${schema.pattern}`);
  }
  if (schema.format === "uri") {
    try {
      const url = new URL(value);
      if (!url.protocol || !url.hostname) {
        errors.push(`${path} must be a URI`);
      }
    } catch {
      errors.push(`${path} must be a URI`);
    }
  }
  if (schema.format === "date" && !isIsoDate(value)) {
    errors.push(`${path} must be a YYYY-MM-DD date`);
  }
}

function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export async function fetchPublishedReleases(repo, { token, fetchImpl = fetch } = {}) {
  const releases = [];
  let page = 1;

  while (true) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub releases for ${repo.owner}/${repo.repo} returned HTTP ${response.status}`,
      );
    }

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    releases.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return releases;
}

export async function downloadZip(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`download ${url} returned HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "radio-module-catalog-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function syncCatalog(catalog, { token, fetchImpl } = {}) {
  const modules = [];
  const changes = [];
  const releasesByRepo = new Map();

  for (const moduleEntry of catalog.modules) {
    if (moduleTier(moduleEntry) === "community") {
      modules.push(moduleEntry);
      changes.push({
        id: moduleEntry.id,
        action: "unchanged",
        from: moduleEntry.version,
        to: moduleEntry.version,
        reason: "community entry is pinned to a reviewed release",
      });
      continue;
    }

    const repo = parseGithubRepo(moduleEntry.downloadUrl);
    const repoKey = `${repo.owner}/${repo.repo}`;
    let releases = releasesByRepo.get(repoKey);
    if (!releases) {
      releases = await fetchPublishedReleases(repo, { token, fetchImpl });
      releasesByRepo.set(repoKey, releases);
    }

    const selection = selectHighestPerRadioAsset(releases, moduleEntry.id);
    if (!selection) {
      if (isPlaceholderIntegrity(moduleEntry.integrity)) {
        throw new Error(
          `${moduleEntry.id} has no published radio-module-${moduleEntry.id}-<semver>.zip and its integrity is a placeholder`,
        );
      }
      modules.push(moduleEntry);
      changes.push({
        id: moduleEntry.id,
        action: "unchanged",
        from: moduleEntry.version,
        to: moduleEntry.version,
        reason: "no published per-radio asset",
      });
      continue;
    }

    const zipBuffer = await downloadZip(selection.asset.browser_download_url, fetchImpl);
    const result = applyVerifiedAsset(moduleEntry, selection, zipBuffer);
    modules.push(result.module);
    changes.push(result.change);
  }

  return {
    catalog: {
      ...catalog,
      modules,
    },
    changes,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const options = parseArgs(argv);
  const schema = JSON.parse(readFileSync(options.schemaPath, "utf8"));
  const catalog = JSON.parse(readFileSync(options.catalogPath, "utf8"));
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const { catalog: nextCatalog, changes } = await syncCatalog(catalog, { token, fetchImpl });
  validateCatalog(nextCatalog, schema);

  const currentText = readFileSync(options.catalogPath, "utf8");
  const nextText = formatCatalog(nextCatalog);
  const wrote = !options.dryRun && currentText !== nextText;
  if (wrote) {
    writeFileSync(options.catalogPath, nextText);
  }

  const report = {
    dryRun: options.dryRun,
    wrote,
    changes,
  };
  if (options.reportPath) {
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  for (const change of changes) {
    const suffix = change.reason ? ` (${change.reason})` : "";
    console.log(`${change.id}: ${change.action} ${change.from} -> ${change.to}${suffix}`);
  }
  if (options.dryRun) {
    console.log("dry-run: catalog.json was not modified");
  } else if (wrote) {
    console.log(`updated ${options.catalogPath}`);
  } else {
    console.log("catalog.json already matches the published releases");
  }

  return report;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
