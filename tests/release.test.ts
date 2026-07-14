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
  version: "0.1.0",
  permissions: ["activeTab", "scripting", "storage"],
  host_permissions: ["http://*/*", "https://*/*"],
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      run_at: "document_idle",
      js: ["content-scripts/content.js"],
    },
  ],
};

describe("release version metadata", () => {
  it("uses 0.1.0 for the first public release package version", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as { version?: unknown };

    expect(packageJson.version).toBe("0.1.0");
  });

  it("accepts the first public release version and Chromium-compatible numeric SemVer", () => {
    expect(parseReleaseVersion("0.1.0")).toBe("0.1.0");
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
        packageVersion: "0.1.0",
        eventName: "push",
        refType: "tag",
        refName: "v0.1.0",
        releaseSha: releaseCommit,
        trustedMainSha: releaseCommit,
      }),
    ).toEqual({ version: "0.1.0", tag: "v0.1.0" });

    expect(() =>
      resolveReleaseMetadata({
        packageVersion: "0.1.0",
        eventName: "push",
        refType: "tag",
        refName: "v0.1.1",
      }),
    ).toThrow("exact tag v0.1.0");
  });

  it("accepts an exact manual version only from main", () => {
    expect(
      resolveReleaseMetadata({
        packageVersion: "0.1.0",
        eventName: "workflow_dispatch",
        refType: "branch",
        refName: "main",
        inputVersion: "0.1.0",
        releaseSha: releaseCommit,
        trustedMainSha: releaseCommit,
      }),
    ).toEqual({ version: "0.1.0", tag: "v0.1.0" });

    expect(() =>
      resolveReleaseMetadata({
        packageVersion: "0.1.0",
        eventName: "workflow_dispatch",
        refType: "branch",
        refName: "release-test",
        inputVersion: "0.1.0",
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
      validateReleaseManifest(validManifest, "0.1.0", "chrome");
    }).not.toThrow();
  });

  it("rejects version, granted host permission, and permission drift", () => {
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, version: "0.1.1" },
        "0.1.0",
        "chrome",
      );
    }).toThrow("does not match");
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, optional_host_permissions: ["https://*/*"] },
        "0.1.0",
        "chrome",
      );
    }).toThrow("must not declare optional_host_permissions");
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, content_scripts: [] },
        "0.1.0",
        "chrome",
      );
    }).toThrow("exactly one content script");
    expect(() => {
      validateReleaseManifest(
        {
          ...validManifest,
          content_scripts: [
            {
              matches: ["<all_urls>"],
              run_at: "document_start",
              js: ["unexpected.js"],
            },
          ],
        },
        "0.1.0",
        "chrome",
      );
    }).toThrow("content script matches");
    expect(() => {
      validateReleaseManifest(
        { ...validManifest, permissions: ["activeTab", "storage"] },
        "0.1.0",
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
    "content-scripts/content.js",
    "icon/16.png",
    "icon/32.png",
    "icon/48.png",
    "icon/128.png",
    "assets/popup.css",
  ];

  it("accepts required root files and produces stable asset names", () => {
    expect(() => {
      validateArchiveEntries(expectedEntries, "chrome");
    }).not.toThrow();
    expect(getReleaseAssetNames("paralume-translator", "0.1.0")).toEqual({
      archives: {
        chrome: "paralume-translator-0.1.0-chrome.zip",
        edge: "paralume-translator-0.1.0-edge.zip",
      },
      checksums: "paralume-translator-0.1.0-SHA256SUMS.txt",
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
