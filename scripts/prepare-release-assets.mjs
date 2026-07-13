import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  RELEASE_BROWSERS,
  getReleaseAssetNames,
  parseReleaseVersion,
  validateArchiveEntries,
  validateReleaseManifest,
} from "./release-lib.mjs";

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const version = parseReleaseVersion(
  packageJson.version,
  "package.json version",
);
const assetNames = getReleaseAssetNames(packageJson.name, version);
const outputDirectory = resolve(".output");
const releaseDirectory = resolve("release-assets");

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const checksumLines = [];
for (const browser of RELEASE_BROWSERS) {
  const manifestPath = resolve(
    outputDirectory,
    `${browser}-mv3`,
    "manifest.json",
  );
  const unpackedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateReleaseManifest(unpackedManifest, version, browser);

  const archiveName = assetNames.archives[browser];
  const archivePath = resolve(outputDirectory, archiveName);
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size === 0) {
    throw new Error(`${browser} archive is missing or empty: ${archiveName}.`);
  }

  const entries = execFileSync("unzip", ["-Z1", archivePath], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
  validateArchiveEntries(entries, browser);

  const archivedManifest = JSON.parse(
    execFileSync("unzip", ["-p", archivePath, "manifest.json"], {
      encoding: "utf8",
    }),
  );
  validateReleaseManifest(archivedManifest, version, `${browser} ZIP`);
  if (!isDeepStrictEqual(archivedManifest, unpackedManifest)) {
    throw new Error(
      `${browser} ZIP manifest differs from the unpacked build manifest.`,
    );
  }

  const releaseArchivePath = resolve(releaseDirectory, archiveName);
  await copyFile(archivePath, releaseArchivePath);
  const digest = createHash("sha256")
    .update(await readFile(releaseArchivePath))
    .digest("hex");
  checksumLines.push(`${digest}  ${archiveName}`);
}

await writeFile(
  resolve(releaseDirectory, assetNames.checksums),
  `${checksumLines.join("\n")}\n`,
  "utf8",
);

process.stdout.write(`Prepared release assets for ${version}:\n`);
for (const archiveName of Object.values(assetNames.archives)) {
  process.stdout.write(`- release-assets/${archiveName}\n`);
}
process.stdout.write(`- release-assets/${assetNames.checksums}\n`);
