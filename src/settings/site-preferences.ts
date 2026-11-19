import type { SettingsStorageArea } from "./repository";

export const DISABLED_SITES_STORAGE_KEY = "disabledFloatingMenuSites";

// Sites are keyed by hostname (or "file://" for local files). Any other
// scheme, including extension pages, has no floating-menu site preference.
export function siteKeyFromUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    return "file://";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  return url.hostname || undefined;
}

export function isValidSiteKey(value: unknown): value is string {
  if (value === "file://") {
    return true;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 253) {
    return false;
  }
  try {
    const parsed = new URL(`https://${value}/`);
    return (
      value === value.toLowerCase() &&
      parsed.hostname.length > 0 &&
      parsed.hostname === value.toLowerCase() &&
      parsed.host === value.toLowerCase()
    );
  } catch {
    return false;
  }
}

function parseDisabledSites(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter(isValidSiteKey))).sort()
    : [];
}

export interface SitePreferenceStore {
  isDisabled(site: string): Promise<boolean>;
  disable(site: string): Promise<void>;
  list(): Promise<readonly string[]>;
  enable(site: string): Promise<void>;
}

export function createSitePreferenceStore(
  storage: SettingsStorageArea,
): SitePreferenceStore {
  const load = async () =>
    parseDisabledSites(
      (await storage.get(DISABLED_SITES_STORAGE_KEY))[
        DISABLED_SITES_STORAGE_KEY
      ],
    );
  // `disable` is a read-modify-write of one shared list. This store is the
  // only writer of the key and the background owns a single instance, so a
  // local queue serializes writes: two sites disabled concurrently can no
  // longer overwrite each other. A failed write rejects its own caller but
  // never blocks the operations queued after it.
  let writeQueue: Promise<void> = Promise.resolve();
  return {
    async isDisabled(site) {
      await writeQueue;
      return (await load()).includes(site);
    },
    disable(site) {
      const write = writeQueue.then(async () => {
        const disabled = new Set(await load());
        if (disabled.has(site)) {
          return;
        }
        disabled.add(site);
        await storage.set({
          [DISABLED_SITES_STORAGE_KEY]: Array.from(disabled).sort(),
        });
      });
      writeQueue = write.catch(() => undefined);
      return write;
    },
    async list() {
      await writeQueue;
      return load();
    },
    enable(site) {
      const write = writeQueue.then(async () => {
        const disabled = new Set(await load());
        if (!disabled.delete(site)) {
          return;
        }
        await storage.set({
          [DISABLED_SITES_STORAGE_KEY]: Array.from(disabled).sort(),
        });
      });
      writeQueue = write.catch(() => undefined);
      return write;
    },
  };
}
