import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { resolveReleaseMetadata } from "./release-lib.mjs";

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const metadata = resolveReleaseMetadata({
  packageVersion: packageJson.version,
  eventName: process.env.GITHUB_EVENT_NAME,
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  inputVersion: process.env.RELEASE_VERSION_INPUT,
  releaseSha: process.env.GITHUB_SHA,
  trustedMainSha: process.env.TRUSTED_MAIN_SHA,
});

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${metadata.version}\ntag=${metadata.tag}\n`,
    "utf8",
  );
}

process.stdout.write(
  `Release metadata validated: package ${metadata.version}, tag ${metadata.tag}.\n`,
);
