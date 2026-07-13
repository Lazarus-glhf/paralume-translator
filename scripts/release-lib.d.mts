export const RELEASE_BROWSERS: readonly ["chrome", "edge"];
export const REQUIRED_ARCHIVE_FILES: readonly string[];
export const REQUIRED_PERMISSIONS: readonly string[];
export const REQUIRED_OPTIONAL_HOST_PERMISSIONS: readonly string[];

export interface ReleaseMetadataInput {
  packageVersion: unknown;
  eventName?: string;
  refType?: string;
  refName?: string;
  inputVersion?: unknown;
  releaseSha?: unknown;
  trustedMainSha?: unknown;
}

export interface ReleaseMetadata {
  version: string;
  tag: string;
}

export function parseReleaseVersion(value: unknown, label?: string): string;
export function validateTrustedReleaseCommit(
  releaseSha: unknown,
  trustedMainSha: unknown,
): string;
export function resolveReleaseMetadata(
  input: ReleaseMetadataInput,
): ReleaseMetadata;
export function validateReleaseManifest(
  manifest: unknown,
  version: string,
  browser: string,
): void;
export function validateArchiveEntries(entries: unknown, browser: string): void;
export function getReleaseAssetNames(
  packageName: unknown,
  version: string,
): {
  archives: Record<(typeof RELEASE_BROWSERS)[number], string>;
  checksums: string;
};
