import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  applyReleaseAsset,
  compareSemver,
  formatCatalog,
  main,
  parseGithubRepo,
  radiosFromZip,
  selectModuleZipAsset,
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
      "https://github.com/springfield-ham-radio/radio-module-kenwood/releases/download/v1.9.2/radio-module-kenwood-1.9.2.zip",
    ),
    { owner: "springfield-ham-radio", repo: "radio-module-kenwood" },
  );
});

test("compareSemver orders catalog versions", () => {
  assert.equal(compareSemver("1.11.2", "1.9.2"), 1);
  assert.equal(compareSemver("3.6.1", "3.7.1"), -1);
  assert.equal(compareSemver("3.7.1", "3.7.1"), 0);
});

test("selectModuleZipAsset prefers the versioned radio-module zip", () => {
  const asset = selectModuleZipAsset(
    [
      { name: "notes.txt", browser_download_url: "https://example.com/notes.txt" },
      {
        name: "radio-module-kenwood-1.9.2.zip",
        label: "old",
        browser_download_url: "https://example.com/old.zip",
      },
      {
        name: "radio-module-kenwood-1.11.2.zip",
        label: "Radio module JSON package (zip)",
        browser_download_url: "https://example.com/new.zip",
      },
    ],
    "1.11.2",
  );

  assert.equal(asset.name, "radio-module-kenwood-1.11.2.zip");
});

test("radiosFromZip reads configs from a deflated module zip", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-zip-"));
  try {
    mkdirSync(join(directory, "configs"));
    writeFileSync(
      join(directory, "configs", "kenwood-th-f6.json"),
      JSON.stringify({ id: { model: "kenwood-th-f6", name: "Kenwood TH-F6" } }),
    );
    writeFileSync(
      join(directory, "configs", "kenwood-th-d74.json"),
      JSON.stringify({ id: { model: "kenwood-th-d74", name: "Kenwood TH-D74" } }),
    );
    const zipPath = join(directory, "module.zip");
    const zipResult = spawnSync(
      "zip",
      ["-r", zipPath, "configs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(zipResult.status, 0, zipResult.stderr);

    const radios = radiosFromZip(readFileSync(zipPath));
    assert.deepEqual(radios, [
      { modelId: "kenwood-th-d74", name: "Kenwood TH-D74", config: "configs/kenwood-th-d74.json" },
      { modelId: "kenwood-th-f6", name: "Kenwood TH-F6", config: "configs/kenwood-th-f6.json" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("radiosFromZip reads a stored zip entry", () => {
  const payload = Buffer.from(
    JSON.stringify({ id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" } }),
  );
  const radios = radiosFromZip(storedZip([{ name: "configs/baofeng-uv5r.json", content: payload }]));
  assert.deepEqual(radios, [
    { modelId: "baofeng-uv5r", name: "Baofeng UV-5R", config: "configs/baofeng-uv5r.json" },
  ]);
});

test("applyReleaseAsset refreshes release fields and keeps manufacturer metadata", () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(JSON.stringify({ id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" } })),
    },
  ]);
  const integrity = sha256Integrity(zip);
  const current = {
    id: "baofeng",
    package: "@springfield/radio-module-baofeng",
    manufacturer: "Baofeng",
    description: "Baofeng UV-5R series (UV-5R and UV-5RE Plus share one config)",
    version: "3.6.1",
    radios: [{ modelId: "baofeng-uv5r", name: "Baofeng UV-5R", config: "configs/baofeng-uv5r.json" }],
    supportedRadios: ["baofeng-uv5r"],
    minApiVersion: "17.3.0",
    downloadUrl:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-3.6.1.zip",
    integrity: "sha256:2020c229dc81230f8305464e2eb327e508e21b41ea4651f1a60b9f18672da9ce",
  };
  const release = {
    tag_name: "v3.7.1",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "radio-module-baofeng-3.7.1.zip",
        label: "Radio module JSON package (zip)",
        browser_download_url:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.1/radio-module-baofeng-3.7.1.zip",
        digest: integrity,
      },
    ],
  };

  const result = applyReleaseAsset(current, release, zip);
  assert.equal(result.change.action, "updated");
  assert.equal(result.module.version, "3.7.1");
  assert.equal(result.module.integrity, integrity);
  assert.equal(result.module.manufacturer, "Baofeng");
  assert.equal(result.module.description, current.description);
  assert.equal(result.module.minApiVersion, "17.3.0");
  assert.deepEqual(result.module.supportedRadios, ["baofeng-uv5r"]);
  validateCatalog({ schemaVersion: 1, modules: [result.module] }, schema);
});

test("applyReleaseAsset rejects a draft and a checksum that does not match the zip", () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(JSON.stringify({ id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" } })),
    },
  ]);
  const current = {
    id: "baofeng",
    version: "3.6.1",
    downloadUrl:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-3.6.1.zip",
  };
  const asset = {
    name: "radio-module-baofeng-3.7.1.zip",
    browser_download_url:
      "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.1/radio-module-baofeng-3.7.1.zip",
    digest: sha256Integrity(zip),
  };

  assert.throws(
    () => applyReleaseAsset(current, { tag_name: "v3.7.1", draft: true, prerelease: false, assets: [asset] }, zip),
    /not a published release/,
  );
  assert.throws(
    () =>
      applyReleaseAsset(
        current,
        {
          tag_name: "v3.7.1",
          draft: false,
          prerelease: false,
          assets: [{ ...asset, digest: `sha256:${"ab".repeat(32)}` }],
        },
        zip,
      ),
    /does not match release asset digest/,
  );
});

test("syncCatalog moves Baofeng to a newer published release after hashing the zip", async () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(JSON.stringify({ id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" } })),
    },
  ]);
  const integrity = sha256Integrity(zip);
  const downloadUrl =
    "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.7.2/radio-module-baofeng-3.7.2.zip";
  const release = {
    tag_name: "v3.7.2",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "radio-module-baofeng-3.7.2.zip",
        label: "Radio module JSON package (zip)",
        browser_download_url: downloadUrl,
        digest: integrity,
      },
    ],
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/releases/latest")) {
      return { ok: true, json: async () => release };
    }
    if (String(url) === downloadUrl) {
      return {
        ok: true,
        arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const catalog = {
    schemaVersion: 1,
    modules: [
      {
        id: "baofeng",
        package: "@springfield/radio-module-baofeng",
        manufacturer: "Baofeng",
        description: "Baofeng UV-5R series (UV-5R and UV-5RE Plus share one config)",
        version: "3.6.1",
        radios: [{ modelId: "baofeng-uv5r", name: "Baofeng UV-5R", config: "configs/baofeng-uv5r.json" }],
        supportedRadios: ["baofeng-uv5r"],
        minApiVersion: "17.3.0",
        downloadUrl:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-3.6.1.zip",
        integrity: "sha256:2020c229dc81230f8305464e2eb327e508e21b41ea4651f1a60b9f18672da9ce",
      },
    ],
  };

  const result = await syncCatalog(catalog, { fetchImpl });
  assert.equal(result.changes[0].action, "updated");
  assert.equal(result.catalog.modules[0].version, "3.7.2");
  assert.equal(result.catalog.modules[0].downloadUrl, downloadUrl);
  assert.equal(result.catalog.modules[0].integrity, integrity);
  validateCatalog(result.catalog, schema);
});

test("syncCatalog refuses a draft returned as the latest release", async () => {
  const catalog = {
    schemaVersion: 1,
    modules: [
      {
        id: "baofeng",
        version: "3.6.1",
        downloadUrl:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-3.6.1.zip",
      },
    ],
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ tag_name: "v3.7.1", draft: true, prerelease: false, assets: [] }),
  });

  await assert.rejects(() => syncCatalog(catalog, { fetchImpl }), /not a published release/);
});

test("formatCatalog is valid JSON and matches the catalog schema", () => {
  const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  const formatted = formatCatalog(catalog);
  const parsed = JSON.parse(formatted);
  validateCatalog(parsed, schema);
  assert.equal(formatted, formatCatalog(parsed));
});

test("dry-run does not write the catalog", async () => {
  const zip = storedZip([
    {
      name: "configs/baofeng-uv5r.json",
      content: Buffer.from(JSON.stringify({ id: { model: "baofeng-uv5r", name: "Baofeng UV-5R" } })),
    },
  ]);
  const integrity = sha256Integrity(zip);
  const downloadUrl =
    "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v3.6.1/radio-module-baofeng-3.6.1.zip";
  const release = {
    tag_name: "v3.6.1",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "radio-module-baofeng-3.6.1.zip",
        label: "Radio module JSON package (zip)",
        browser_download_url: downloadUrl,
        digest: integrity,
      },
    ],
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/releases/latest")) {
      return { ok: true, json: async () => release };
    }
    if (href === downloadUrl) {
      return {
        ok: true,
        arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
      };
    }
    throw new Error(`unexpected URL ${href}`);
  };

  const directory = mkdtempSync(join(tmpdir(), "catalog-dry-"));
  const catalogPath = join(directory, "catalog.json");
  const original = {
    schemaVersion: 1,
    modules: [
      {
        id: "baofeng",
        package: "@springfield/radio-module-baofeng",
        manufacturer: "Baofeng",
        description: "Baofeng UV-5R series (UV-5R and UV-5RE Plus share one config)",
        version: "9.9.9",
        radios: [
          { modelId: "baofeng-uv5r", name: "Baofeng UV-5R", config: "configs/baofeng-uv5r.json" },
        ],
        supportedRadios: ["baofeng-uv5r"],
        minApiVersion: "17.3.0",
        downloadUrl:
          "https://github.com/springfield-ham-radio/radio-module-baofeng/releases/download/v9.9.9/radio-module-baofeng-9.9.9.zip",
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
    assert.equal(report.changes[0].to, "3.6.1");
    assert.match(output, /baofeng: updated 9\.9\.9 -> 3\.6\.1/);
    assert.match(output, /dry-run/);
    assert.equal(readFileSync(catalogPath, "utf8"), originalText);
  } finally {
    console.log = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  // Touch deflateRawSync so a stored-only fixture still imports the same zlib surface the reader uses.
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
