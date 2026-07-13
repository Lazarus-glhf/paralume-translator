import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getReleaseAssetNames,
  parseReleaseVersion,
  resolveReleaseMetadata,
  validateArchiveEntries,
  validateReleaseManifest,
  validateTrustedReleaseCommit,
} from "../scripts/release-lib.mjs";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

const validManifest = {
  manifest_version: 3,
  version: "0.0.1",
  permissions: ["activeTab", "scripting", "storage"],
  optional_host_permissions: ["https://*/*"],
};

describe("release version metadata", () => {
  it("uses 0.0.1 for the first Alpha package version", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as { version?: unknown };

    expect(packageJson.version).toBe("0.0.1");
  });

  it("accepts the first Alpha version and Chromium-compatible numeric SemVer", () => {
    expect(parseReleaseVersion("0.0.1")).toBe("0.0.1");
    expect(parseReleaseVersion("65535.2.3")).toBe("65535.2.3");
  });

  it.each([
    "0.0.1-alpha.1",
    "01.2.3",
    "1.2",
    "0.0.0",
    "65536.0.0",
    "0.0.1; echo unsafe",
  ])("rejects a non-release version: %s", (version) => {
    expect(() => parseReleaseVersion(version)).toThrow();
  });

  it("requires a tag push to match package.json exactly", () => {
    expect(
      resolveReleaseMetadata({
        packageVersion: "0.0.1",
        eventName: "push",
        refType: "tag",
        refName: "v0.0.1",
        releaseSha: releaseCommit,
        trustedMainSha: releaseCommit,
      }),
    ).toEqual({ version: "0.0.1", tag: "v0.0.1" });

    expect(() =>
      resolveReleaseMetadata({
        packageVersion: "0.0.1",
        eventName: "push",
        refType: "tag",
        refName: "v0.1.1",
      }),
    ).toThrow("exact tag v0.0.1");
  });

  it("accepts an exact manual version only from main", () => {
    expect(
      resolveReleaseMetadata({
        packageVersion: "0.0.1",
        eventName: "workflow_dispatch",
        refType: "branch",
        refName: "main",
        inputVersion: "0.0.1",
        releaseSha: releaseCommit,
        trustedMainSha: releaseCommit,
      }),
    ).toEqual({ version: "0.0.1", tag: "v0.0.1" });

    expect(() =>
      resolveReleaseMetadata({
        packageVersion: "0.0.1",
        eventName: "workflow_dispatch",
        refType: "branch",
        refName: "release-test",
        inputVersion: "0.0.1",
      }),
    ).toThrow("main branch");
  });

  it("requires the release commit to equal the freshly fetched main HEAD", () => {
    expect(validateTrustedReleaseCommit(releaseCommit, releaseCommit)).toBe(
      releaseCommit,
    );

    expect(() =>
      validateTrustedReleaseCommit(
        releaseCommit,
        "fedcba9876543210fedcba9876543210fedcba98",
      ),
    ).toThrow("must equal origin/main HEAD");
    expect(() =>
      validateTrustedReleaseCommit("refs/tags/v0.0.1", releaseCommit),
    ).toThrow("full commit SHA");
  });
});

describe("release manifest validation", () => {
  it("accepts the minimal expected Manifest V3 permissions", () => {
    expect(() => {
      validateReleaseManifest(validManifest, "0.0.1", "chrome");
    }).not.toThrow();
  });

  it("rejects version, granted host permission, and permission drift", () => {
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, version: "0.1.1" },
        "0.0.1",
        "chrome",
      );
    }).toThrow("does not match");
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, host_permissions: ["https://*/*"] },
        "0.0.1",
        "chrome",
      );
    }).toThrow("must not declare host_permissions");
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, permissions: ["activeTab", "storage"] },
        "0.0.1",
        "chrome",
      );
    }).toThrow("permissions must be exactly");
  });
});

describe("release archive validation", () => {
  const expectedEntries = [
    "manifest.json",
    "background.js",
    "popup.html",
    "options.html",
    "paralume.js",
    "assets/popup.css",
  ];

  it("accepts required root files and produces stable asset names", () => {
    expect(() => {
      validateArchiveEntries(expectedEntries, "chrome");
    }).not.toThrow();
    expect(getReleaseAssetNames("paralume-translator", "0.0.1")).toEqual({
      archives: {
        chrome: "paralume-translator-0.0.1-chrome.zip",
        edge: "paralume-translator-0.0.1-edge.zip",
      },
      checksums: "paralume-translator-0.0.1-SHA256SUMS.txt",
    });
  });

  it("rejects traversal, duplicate paths, and incomplete archives", () => {
    expect(() => {
      validateArchiveEntries([...expectedEntries, "../secret"], "chrome");
    }).toThrow("unsafe path");
    expect(() => {
      validateArchiveEntries([...expectedEntries, "popup.html"], "chrome");
    }).toThrow("duplicate path");
    expect(() => {
      validateArchiveEntries(
        expectedEntries.filter((entry) => entry !== "manifest.json"),
        "chrome",
      );
    }).toThrow("missing required file manifest.json");
  });
});
