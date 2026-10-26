#!/usr/bin/env node
/**
 * Validate catalog.json and check community release pins (ADR 0012).
 *
 * Official entries are refreshed by scripts/update-catalog.mjs. A community entry is
 * pinned, so this script downloads that zip and requires the SHA-256 to match integrity.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog, verifyCommunityPins } from "./update-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "catalog.schema.json"), "utf8"));
const catalog = JSON.parse(readFileSync(resolve(root, "catalog.json"), "utf8"));

validateCatalog(catalog, schema);
const errors = await verifyCommunityPins(catalog);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const pinned = catalog.modules.filter((entry) => entry.tier === "community").length;
console.log(`catalog.json is valid (${pinned} community pin${pinned === 1 ? "" : "s"} checked)`);
