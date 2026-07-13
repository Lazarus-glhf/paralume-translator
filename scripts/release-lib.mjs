const NUMERIC_SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_PACKAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_MANIFEST_VERSION_COMPONENT = 65_535n;

export const RELEASE_BROWSERS = ["chrome", "edge"];
export const REQUIRED_ARCHIVE_FILES = [
  "manifest.json",
  "background.js",
  "popup.html",
  "options.html",
  "paralume.js",
];
export const REQUIRED_PERMISSIONS = ["activeTab", "scripting", "storage"];
export const REQUIRED_OPTIONAL_HOST_PERMISSIONS = ["https://*/*"];

export function parseReleaseVersion(value, label = "version") {
  if (typeof value !== "string" || !NUMERIC_SEMVER_PATTERN.test(value)) {
    throw new Error(
      `${label} must be canonical numeric SemVer (for example, 0.0.1).`,
    );
  }

  const components = value.split(".").map((component) => BigInt(component));
  if (
    components.some((component) => component > MAX_MANIFEST_VERSION_COMPONENT)
  ) {
    throw new Error(
      `${label} components must be between 0 and 65535 for Chromium manifests.`,
    );
  }

  if (components.every((component) => component === 0n)) {
    throw new Error(`${label} must not be the placeholder version 0.0.0.`);
  }

  return value;
}

export function validateTrustedReleaseCommit(releaseSha, trustedMainSha) {
  for (const [value, label] of [
    [releaseSha, "Release commit"],
    [trustedMainSha, "origin/main HEAD"],
  ]) {
    if (typeof value !== "string" || !FULL_COMMIT_SHA_PATTERN.test(value)) {
      throw new Error(`${label} must be a full commit SHA.`);
    }
  }

  if (releaseSha !== trustedMainSha) {
    throw new Error(
      `Release commit ${releaseSha} must equal origin/main HEAD ${trustedMainSha}.`,
    );
  }

  return releaseSha;
}

export function resolveReleaseMetadata({
  packageVersion,
  eventName,
  refType,
  refName,
  inputVersion,
  releaseSha,
  trustedMainSha,
}) {
  const version = parseReleaseVersion(packageVersion, "package.json version");
  const tag = `v${version}`;

  if (eventName === undefined || eventName === "") {
    if (inputVersion !== undefined && inputVersion !== "") {
      const localVersion = parseReleaseVersion(
        inputVersion,
        "requested version",
      );
      if (localVersion !== version) {
        throw new Error(
          `Requested version ${localVersion} does not match package.json ${version}.`,
        );
      }
    }
    return { version, tag };
  }

  if (eventName === "push") {
    if (refType !== "tag" || refName !== tag) {
      throw new Error(
        `Tag releases require the exact tag ${tag}; received ${refName ?? "no tag"}.`,
      );
    }
    validateTrustedReleaseCommit(releaseSha, trustedMainSha);
    return { version, tag };
  }

  if (eventName === "workflow_dispatch") {
    const requestedVersion = parseReleaseVersion(
      inputVersion,
      "workflow_dispatch version",
    );
    if (requestedVersion !== version) {
      throw new Error(
        `Requested version ${requestedVersion} does not match package.json ${version}.`,
      );
    }
    if (refType !== "branch" || refName !== "main") {
      throw new Error(
        "Manual releases must be dispatched from the main branch.",
      );
    }
    validateTrustedReleaseCommit(releaseSha, trustedMainSha);
    return { version, tag };
  }

  throw new Error(`Unsupported release event: ${eventName}.`);
}

function assertExactStringSet(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== "string")
  ) {
    throw new Error(`${label} must be an array of strings.`);
  }

  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `${label} must be exactly ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`,
    );
  }
}

export function validateReleaseManifest(manifest, version, browser) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new Error(`${browser} manifest must be a JSON object.`);
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(`${browser} manifest must use Manifest V3.`);
  }
  if (manifest.version !== version) {
    throw new Error(
      `${browser} manifest version ${String(manifest.version)} does not match package.json ${version}.`,
    );
  }
  if (
    Object.hasOwn(manifest, "version_name") &&
    manifest.version_name !== version
  ) {
    throw new Error(`${browser} manifest version_name must match ${version}.`);
  }

  assertExactStringSet(
    manifest.permissions,
    REQUIRED_PERMISSIONS,
    `${browser} manifest permissions`,
  );
  assertExactStringSet(
    manifest.optional_host_permissions,
    REQUIRED_OPTIONAL_HOST_PERMISSIONS,
    `${browser} manifest optional_host_permissions`,
  );

  for (const forbiddenKey of ["host_permissions", "content_scripts"]) {
    if (Object.hasOwn(manifest, forbiddenKey)) {
      throw new Error(`${browser} manifest must not declare ${forbiddenKey}.`);
    }
  }
}

export function validateArchiveEntries(entries, browser) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${browser} archive must contain files.`);
  }

  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${browser} archive contains an invalid path.`);
    }
    const segments = entry.split("/");
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      segments.includes("..") ||
      segments.includes(".")
    ) {
      throw new Error(`${browser} archive contains an unsafe path: ${entry}.`);
    }
    if (seen.has(entry)) {
      throw new Error(
        `${browser} archive contains a duplicate path: ${entry}.`,
      );
    }
    seen.add(entry);
  }

  for (const requiredFile of REQUIRED_ARCHIVE_FILES) {
    if (!seen.has(requiredFile)) {
      throw new Error(
        `${browser} archive is missing required file ${requiredFile}.`,
      );
    }
  }
}

export function getReleaseAssetNames(packageName, version) {
  if (
    typeof packageName !== "string" ||
    !SAFE_PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new Error("package.json name is not safe for release asset names.");
  }
  parseReleaseVersion(version, "release asset version");

  const prefix = `${packageName}-${version}`;
  return {
    archives: Object.fromEntries(
      RELEASE_BROWSERS.map((browser) => [browser, `${prefix}-${browser}.zip`]),
    ),
    checksums: `${prefix}-SHA256SUMS.txt`,
  };
}
