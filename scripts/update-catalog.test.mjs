import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { parseModuleCatalog } from "@springfield/ham-radio-registry";

import {
  applyVerifiedAsset,
  compareSemver,
  configFromZip,
  formatCatalog,
  main,
  parseGithubRepo,
  parsePerRadioAssetName,
  isPlaceholderIntegrity,
  selectHighestPerRadioAsset,
  sha256Integrity,
  syncCatalog,
  validateCatalog,
} from "./update-catalog.mjs";

globalThis.fetch = async (url) => {
  throw new Error(`tests must not call the network: ${url}`);
};

const schema = JSON.parse(readFileSync(new URL("../catalog.schema.json", import.meta.url), "utf8"));

test("parseGithubRepo reads the module repository from a release download URL", () => {
  assert.deepEqual(
    parseGithubRepo(
      "https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v1.9.2/radio-module-kenwood-th-f6-1.9.2.zip",
    ),
    { owner: "springfield-ham-radio", repo: "radio-module-kenwood" },
  );
});

test("parsePerRadioAssetName accepts per-radio assets and rejects manufacturer zips", () => {
  assert.equal(parsePerRadioAssetName("radio-module-kenwood-th-f6-1.11.0.zip", "kenwood-th-f6"), "1.11.0");
  assert.equal(parsePerRadioAssetName("radio-module-kenwood-1.11.6.zip", "kenwood-th-f6"), undefined);
  assert.equal(parsePerRadioAssetName("radio-module-kenwood-th-d74-1.11.1.zip", "kenwood-th-f6"), undefined);
});

test("compareSemver orders catalog versions", () => {
  assert.equal(compareSemver("1.11.2", "1.9.2"), 1);
  assert.equal(compareSemver("3.6.1", "3.7.1"), -1);
  assert.equal(compareSemver("3.7.1", "3.7.1"), 0);
});

test("selectHighestPerRadioAsset picks the highest semver across releases", () => {
  const releases = [
    {
      tag_name: "v1.12.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-kenwood-th-d74-1.11.2.zip",
          browser_download_url: "https://example.com/th-d74-1.11.2.zip",
        },
      ],
    },
    {
      tag_name: "v1.11.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-kenwood-th-d74-1.11.1.zip",
          browser_download_url: "https://example.com/th-d74-1.11.1.zip",
        },
        {
          name: "radio-module-kenwood-th-f6-1.11.0.zip",
          browser_download_url: "https://example.com/th-f6.zip",
        },
      ],
    },
  ];

  const thD74 = selectHighestPerRadioAsset(releases, "kenwood-th-d74");
  assert.equal(thD74.version, "1.11.2");
  assert.equal(thD74.asset.name, "radio-module-kenwood-th-d74-1.11.2.zip");

  const thF6 = selectHighestPerRadioAsset(releases, "kenwood-th-f6");
  assert.equal(thF6.version, "1.11.0");
});

test("selectHighestPerRadioAsset skips drafts and prereleases", () => {
  const releases = [
    {
      tag_name: "v9.0.0",
      draft: true,
      prerelease: false,
      assets: [{ name: "radio-module-baofeng-uv5r-9.0.0.zip", browser_download_url: "https://example.com" }],
    },
    {
      tag_name: "v3.8.0-beta.1",
      draft: false,
      prerelease: true,
      assets: [{ name: "radio-module-baofeng-uv5r-3.8.0.zip", browser_download_url: "https://example.com" }],
    },
    {
      tag_name: "v3.7.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-baofeng-uv5r-3.7.0.zip",
          browser_download_url: "https://example.com/stable.zip",
        },
      ],
    },
  ];

  const selection = selectHighestPerRadioAsset(releases, "baofeng-uv5r");
  assert.equal(selection.version, "3.7.0");
});

test("configFromZip reads a single config and rejects multiple configs", () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" },
          version: "3.7.0",
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);

  assert.deepEqual(configFromZip(zip, "baofeng-uv5r"), {
    modelId: "baofeng-uv5r",
    name: "Baofeng UV-5R",
    version: "3.7.0",
    minApiVersion: "18.0.1",
    config: "configs/baofeng-uv5r.json",
  });

  const multi = storedZip([
    {
      name: "configs/kenwood-th-f6.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "kenwood-th-f6", name: "Kenwood TH-F6" },
          version: "1.11.0",
          minApiVersion: "18.0.1",
        }),
      ),
    },
    {
      name: "configs/kenwood-th-d74.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "kenwood-th-d74", name: "Kenwood TH-D74" },
          version: "1.11.1",
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);
  assert.throws(() => configFromZip(multi, "kenwood-th-f6"), /exactly one configs/);
});

test("configFromZip reads configs from a deflated module zip", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-zip-"));
  try {
    mkdirSync(join(directory, "configs"));
    writeFileSync(
      join(directory, "configs", "kenwood-th-f6.json"),
      JSON.stringify({
        id: { model: "kenwood-th-f6", name: "Kenwood TH-F6" },
        version: "1.11.0",
        minApiVersion: "18.0.1",
      }),
    );
    const zipPath = join(directory, "module.zip");
    const zipResult = spawnSync("zip", ["-r", zipPath, "configs"], { cwd: directory, encoding: "utf8" });
    assert.equal(zipResult.status, 0, zipResult.stderr);

    const config = configFromZip(readFileSync(zipPath), "kenwood-th-f6");
    assert.equal(config.modelId, "kenwood-th-f6");
    assert.equal(config.version, "1.11.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applyVerifiedAsset refreshes release fields and keeps manufacturer metadata", () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" },
          version: "3.7.1",
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);
  const integrity = sha256Integrity(zip);
  const current = {
    id: "baofeng-uv5r",
    package: "@springfield/radio-module-baofeng-uv5r",
    manufacturer: "Baofeng",
    description: "Baofeng UV-5R series (UV-5R and UV-5RE Plus share one config)",
    name: "Baofeng UV-5R",
    version: "3.6.1",
    config: "configs/baofeng-uv5r.json",
    minApiVersion: "17.3.0",
    downloadUrl:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-uv5r-3.6.1.zip",
    integrity: "sha256:2020c229dc81230f8305464e2eb327e508e21b41ea4651f1a60b9f18672da9ce",
  };
  const release = {
    tag_name: "v3.7.1",
    draft: false,
    prerelease: false,
  };
  const asset = {
    name: "radio-module-baofeng-uv5r-3.7.1.zip",
    browser_download_url:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.1/radio-module-baofeng-uv5r-3.7.1.zip",
    digest: integrity,
  };

  const result = applyVerifiedAsset(current, { asset, release, version: "3.7.1" }, zip);
  assert.equal(result.change.action, "updated");
  assert.equal(result.module.version, "3.7.1");
  assert.equal(result.module.integrity, integrity);
  assert.equal(result.module.manufacturer, "Baofeng");
  assert.equal(result.module.description, current.description);
  assert.equal(result.module.minApiVersion, "18.0.1");
  validateCatalog({ schemaVersion: 3, modules: [result.module] }, schema);
});

test("applyVerifiedAsset rejects a draft and a checksum that does not match the zip", () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" },
          version: "3.7.1",
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);
  const current = {
    id: "baofeng-uv5r",
    version: "3.6.1",
    downloadUrl:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-uv5r-3.6.1.zip",
  };
  const asset = {
    name: "radio-module-baofeng-uv5r-3.7.1.zip",
    browser_download_url:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.1/radio-module-baofeng-uv5r-3.7.1.zip",
    digest: sha256Integrity(zip),
  };

  assert.throws(
    () =>
      applyVerifiedAsset(
        current,
        { asset, release: { tag_name: "v3.7.1", draft: true, prerelease: false }, version: "3.7.1" },
        zip,
      ),
    /not a published release/,
  );
  assert.throws(
    () =>
      applyVerifiedAsset(
        current,
        {
          asset: { ...asset, digest: `sha256:${"ab".repeat(32)}` },
          release: { tag_name: "v3.7.1", draft: false, prerelease: false },
          version: "3.7.1",
        },
        zip,
      ),
    /does not match release asset digest/,
  );
});

test("syncCatalog resolves Kenwood radios when the latest release only ships one zip", async () => {
  const thF6Zip = kenwoodZip("kenwood-th-f6", "1.11.0", "Kenwood TH-F6");
  const thD74OldZip = kenwoodZip("kenwood-th-d74", "1.11.1", "Kenwood TH-D74");
  const thD74NewZip = kenwoodZip("kenwood-th-d74", "1.11.2", "Kenwood TH-D74");
  const thF6Integrity = sha256Integrity(thF6Zip);
  const thD74OldIntegrity = sha256Integrity(thD74OldZip);
  const thD74NewIntegrity = sha256Integrity(thD74NewZip);

  const releases = [
    {
      tag_name: "v1.12.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-kenwood-th-d74-1.11.2.zip",
          browser_download_url:
            "https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v1.12.0/radio-module-kenwood-th-d74-1.11.2.zip",
          digest: thD74NewIntegrity,
        },
      ],
    },
    {
      tag_name: "v1.11.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-kenwood-th-f6-1.11.0.zip",
          browser_download_url:
            "https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v1.11.0/radio-module-kenwood-th-f6-1.11.0.zip",
          digest: thF6Integrity,
        },
        {
          name: "radio-module-kenwood-th-d74-1.11.1.zip",
          browser_download_url:
            "https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v1.11.0/radio-module-kenwood-th-d74-1.11.1.zip",
          digest: thD74OldIntegrity,
        },
      ],
    },
  ];

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/releases?")) {
      return { ok: true, json: async () => releases };
    }
    if (href.endsWith("radio-module-kenwood-th-f6-1.11.0.zip")) {
      return { ok: true, arrayBuffer: async () => bufferSlice(thF6Zip) };
    }
    if (href.endsWith("radio-module-kenwood-th-d74-1.11.2.zip")) {
      return { ok: true, arrayBuffer: async () => bufferSlice(thD74NewZip) };
    }
    throw new Error(`unexpected URL ${href}`);
  };

  const catalog = {
    schemaVersion: 3,
    modules: [
      kenwoodCatalogSeed("kenwood-th-f6", "1.10.0"),
      kenwoodCatalogSeed("kenwood-th-d74", "1.10.0"),
    ],
  };

  const result = await syncCatalog(catalog, { fetchImpl });
  assert.equal(result.catalog.modules[0].version, "1.11.0");
  assert.equal(result.catalog.modules[0].integrity, thF6Integrity);
  assert.equal(result.catalog.modules[1].version, "1.11.2");
  assert.equal(result.catalog.modules[1].integrity, thD74NewIntegrity);
  validateCatalog(result.catalog, schema);
});

test("validateCatalog rejects placeholder integrity", () => {
  const catalog = {
    schemaVersion: 3,
    modules: [
      {
        ...kenwoodCatalogSeed("kenwood-th-f6", "1.11.0"),
        integrity: `sha256:${"0".repeat(64)}`,
      },
    ],
  };

  assert.equal(isPlaceholderIntegrity(catalog.modules[0].integrity), true);
  assert.throws(() => validateCatalog(catalog, schema), /placeholder/);
});

test("syncCatalog leaves a verified entry unchanged when no per-radio asset exists yet", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      {
        tag_name: "v1.11.6",
        draft: false,
        prerelease: false,
        assets: [{ name: "radio-module-kenwood-1.11.6.zip", browser_download_url: "https://example.com" }],
      },
    ],
  });

  const catalog = {
    schemaVersion: 3,
    modules: [kenwoodCatalogSeed("kenwood-th-f6", "1.11.0")],
  };

  const result = await syncCatalog(catalog, { fetchImpl });
  assert.equal(result.changes[0].action, "unchanged");
  assert.equal(result.changes[0].reason, "no published per-radio asset");
  assert.deepEqual(result.catalog.modules[0], catalog.modules[0]);
  validateCatalog(result.catalog, schema);
});

test("syncCatalog fails when a model has no per-radio asset and a placeholder integrity", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      {
        tag_name: "v3.7.2",
        draft: false,
        prerelease: false,
        assets: [{ name: "radio-module-baofeng-3.7.2.zip", browser_download_url: "https://example.com/old.zip" }],
      },
    ],
  });
  const catalog = {
    schemaVersion: 3,
    modules: [
      {
        ...kenwoodCatalogSeed("baofeng-uv5r", "3.7.0"),
        package: "@springfield/radio-module-baofeng-uv5r",
        manufacturer: "Baofeng",
        name: "Baofeng UV-5R",
        config: "configs/baofeng-uv5r.json",
        downloadUrl:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.0/radio-module-baofeng-uv5r-3.7.0.zip",
        integrity: `sha256:${"0".repeat(64)}`,
      },
    ],
  };

  await assert.rejects(() => syncCatalog(catalog, { fetchImpl }), /placeholder/);
});

test("formatCatalog round-trips catalog.json", () => {
  const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  const formatted = formatCatalog(catalog);
  const parsed = JSON.parse(formatted);
  assert.equal(formatted, formatCatalog(parsed));
  assert.equal(parsed.schemaVersion, 3);
});

test("catalog.json must not ship placeholder integrity", () => {
  const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  for (const moduleEntry of catalog.modules) {
    assert.equal(
      isPlaceholderIntegrity(moduleEntry.integrity),
      false,
      `${moduleEntry.id} integrity is a placeholder and must not be merged or served`,
    );
  }
  validateCatalog(catalog, schema);
  parseModuleCatalog(JSON.stringify(catalog));
});

test("dry-run does not write the catalog", async () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(
        JSON.stringify({
          id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" },
          version: "3.7.0",
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);
  const integrity = sha256Integrity(zip);
  const downloadUrl =
    "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.0/radio-module-baofeng-uv5r-3.7.0.zip";
  const releases = [
    {
      tag_name: "v3.7.0",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "radio-module-baofeng-uv5r-3.7.0.zip",
          browser_download_url: downloadUrl,
          digest: integrity,
        },
      ],
    },
  ];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/releases?")) {
      return { ok: true, json: async () => releases };
    }
    if (href === downloadUrl) {
      return { ok: true, arrayBuffer: async () => bufferSlice(zip) };
    }
    throw new Error(`unexpected URL ${href}`);
  };

  const directory = mkdtempSync(join(tmpdir(), "catalog-dry-"));
  const catalogPath = join(directory, "catalog.json");
  const original = {
    schemaVersion: 3,
    modules: [
      {
        id: "baofeng-uv5r",
        package: "@springfield/radio-module-baofeng-uv5r",
        manufacturer: "Baofeng",
        description: "Baofeng UV-5R series (UV-5R and UV-5RE Plus share one config)",
        name: "Baofeng UV-5R",
        version: "9.9.9",
        config: "configs/baofeng-uv5r.json",
        minApiVersion: "18.0.1",
        downloadUrl:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v9.9.9/radio-module-baofeng-uv5r-9.9.9.zip",
        integrity: "sha256:2020c229dc81230f8305464e2eb327e508e21b41ea4651f1a60b9f18672da9ce",
      },
    ],
  };
  const originalText = `${JSON.stringify(original, null, 2)}\n`;
  writeFileSync(catalogPath, originalText);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };
  try {
    const report = await main(
      [
        "--dry-run",
        "--catalog",
        catalogPath,
        "--schema",
        new URL("../catalog.schema.json", import.meta.url).pathname,
      ],
      {},
      fetchImpl,
    );
    const output = logs.join("\n");
    assert.equal(report.dryRun, true);
    assert.equal(report.wrote, false);
    assert.equal(report.changes[0].action, "updated");
    assert.equal(report.changes[0].to, "3.7.0");
    assert.match(output, /baofeng-uv5r: updated 9\.9\.9 -> 3\.7\.0/);
    assert.match(output, /dry-run/);
    assert.equal(readFileSync(catalogPath, "utf8"), originalText);
  } finally {
    console.log = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

function kenwoodCatalogSeed(modelId, version) {
  return {
    id: modelId,
    package: `@springfield/radio-module-${modelId}`,
    manufacturer: "Kenwood",
    name: `Kenwood ${modelId}`,
    version,
    config: `configs/${modelId}.json`,
    minApiVersion: "18.0.1",
    downloadUrl: `https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v0.0.0/radio-module-${modelId}-${version}.zip`,
    integrity: "sha256:2020c229dc81230f8305464e2eb327e508e21b41ea4651f1a60b9f18672da9ce",
  };
}

function kenwoodZip(modelId, version, name) {
  return storedZip([
    {
      name: `configs/${modelId}.json`,
      content: Buffer.from(
        JSON.stringify({
          id: { model: modelId, name },
          version,
          minApiVersion: "18.0.1",
        }),
      ),
    },
  ]);
}

function bufferSlice(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const content = file.content;
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  deflateRawSync(Buffer.from("catalog"));
  return Buffer.concat([...locals, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
