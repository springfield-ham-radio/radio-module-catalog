#!/usr/bin/env node
/**
 * Refresh catalog.json from the latest published GitHub release of each module.
 *
 * Usage:
 *   node scripts/update-catalog.mjs [--dry-run] [--catalog path] [--schema path] [--report path]
 *
 * Reads each module downloadUrl, loads that repo's latest non-draft, non-prerelease
 * release, and updates version, downloadUrl, integrity, radios, and supportedRadios
 * from the module zip. A published release older than the catalog entry is left in
 * place so a newer pin is not replaced by an older asset.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

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

export function selectModuleZipAsset(assets, version) {
  const zips = (assets || []).filter(
    (asset) => typeof asset?.name === "string" && asset.name.toLowerCase().endsWith(".zip"),
  );
  let candidates = zips.filter((asset) => /^radio-module-.+\.zip$/i.test(asset.name));
  if (candidates.length === 0) {
    candidates = zips;
  }

  if (version) {
    const versioned = candidates.filter((asset) => asset.name.includes(version));
    if (versioned.length > 0) {
      candidates = versioned;
    }
  }

  const labeled = candidates.filter(
    (asset) => typeof asset.label === "string" && /radio module/i.test(asset.label),
  );
  if (labeled.length === 1) {
    return labeled[0];
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const names = candidates.map((asset) => asset.name).join(", ");
  throw new Error(`expected one module zip asset, found ${names || "none"}`);
}

export function sha256Integrity(buffer) {
  const digest = createHash("sha256").update(buffer).digest("hex");
  return `sha256:${digest}`;
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

export function radiosFromZip(buffer) {
  const configs = readZipEntries(buffer)
    .filter((entry) => /^configs\/[^/]+\.json$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (configs.length === 0) {
    throw new Error("module zip does not contain configs/*.json");
  }

  return configs.map((entry) => {
    const config = JSON.parse(entry.content.toString("utf8"));
    const modelId = config?.id?.model;
    const name = config?.id?.name;

    if (typeof modelId !== "string" || modelId.length === 0 || typeof name !== "string" || name.length === 0) {
      throw new Error(`${entry.name} is missing id.model or id.name`);
    }

    return {
      modelId,
      name,
      config: entry.name,
    };
  });
}

export function applyReleaseAsset(moduleEntry, release, zipBuffer) {
  const version = versionFromTag(release.tag_name);
  if (compareSemver(version, moduleEntry.version) < 0) {
    return {
      module: moduleEntry,
      change: {
        id: moduleEntry.id,
        action: "skipped-downgrade",
        from: moduleEntry.version,
        to: version,
      },
    };
  }

  const asset = selectModuleZipAsset(release.assets, version);
  const integrity = sha256Integrity(zipBuffer);
  if (typeof asset.digest === "string" && asset.digest.length > 0) {
    const expected = asset.digest.toLowerCase();
    if (expected !== integrity.toLowerCase()) {
      throw new Error(
        `${moduleEntry.id} zip ${integrity} does not match release asset digest ${asset.digest}`,
      );
    }
  }

  const radios = radiosFromZip(zipBuffer);
  const next = {
    ...moduleEntry,
    version,
    radios,
    supportedRadios: radios.map((radio) => radio.modelId),
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
      to: version,
    },
  };
}

export function formatCatalog(catalog) {
  const lines = ["{"];
  lines.push(`  "schemaVersion": ${catalog.schemaVersion},`);
  lines.push('  "modules": [');

  catalog.modules.forEach((moduleEntry, moduleIndex) => {
    lines.push("    {");
    const keys = Object.keys(moduleEntry);
    keys.forEach((key, keyIndex) => {
      const comma = keyIndex === keys.length - 1 ? "" : ",";
      const value = moduleEntry[key];
      if (key === "radios") {
        lines.push('      "radios": [');
        value.forEach((radio, radioIndex) => {
          const radioComma = radioIndex === value.length - 1 ? "" : ",";
          lines.push("        {");
          ["modelId", "name", "config"].forEach((radioKey, radioKeyIndex, radioKeys) => {
            const radioKeyComma = radioKeyIndex === radioKeys.length - 1 ? "" : ",";
            lines.push(`          "${radioKey}": ${JSON.stringify(radio[radioKey])}${radioKeyComma}`);
          });
          lines.push(`        }${radioComma}`);
        });
        lines.push(`      ]${comma}`);
      } else if (key === "supportedRadios") {
        const inline = value.map((item) => JSON.stringify(item)).join(", ");
        lines.push(`      "supportedRadios": [${inline}]${comma}`);
      } else {
        lines.push(`      "${key}": ${JSON.stringify(value)}${comma}`);
      }
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
  if (errors.length > 0) {
    throw new Error(`catalog.json does not match catalog.schema.json:\n${errors.join("\n")}`);
  }
}

function checkSchema(value, schema, path, errors) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  }

  if (schema.type === "object") {
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
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        checkSchema(item, schema.items, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (schema.type === "string") {
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
    return;
  }

  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${path} must be an integer`);
  }
}

export async function fetchLatestPublishedRelease(repo, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`,
    {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub latest release for ${repo.owner}/${repo.repo} returned HTTP ${response.status}`,
    );
  }

  const release = await response.json();
  if (release.draft || release.prerelease) {
    throw new Error(`latest release ${release.tag_name} for ${repo.repo} is not a published release`);
  }

  return release;
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

  for (const moduleEntry of catalog.modules) {
    const repo = parseGithubRepo(moduleEntry.downloadUrl);
    const release = await fetchLatestPublishedRelease(repo, { token, fetchImpl });
    const remoteVersion = versionFromTag(release.tag_name);

    if (compareSemver(remoteVersion, moduleEntry.version) < 0) {
      modules.push(moduleEntry);
      changes.push({
        id: moduleEntry.id,
        action: "skipped-downgrade",
        from: moduleEntry.version,
        to: remoteVersion,
      });
      continue;
    }

    const asset = selectModuleZipAsset(release.assets, remoteVersion);
    const zipBuffer = await downloadZip(asset.browser_download_url, fetchImpl);
    const result = applyReleaseAsset(moduleEntry, release, zipBuffer);
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const schema = JSON.parse(readFileSync(options.schemaPath, "utf8"));
  const catalog = JSON.parse(readFileSync(options.catalogPath, "utf8"));
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const { catalog: nextCatalog, changes } = await syncCatalog(catalog, { token });
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
    console.log(`${change.id}: ${change.action} ${change.from} -> ${change.to}`);
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
