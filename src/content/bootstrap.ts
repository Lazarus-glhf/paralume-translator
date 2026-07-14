import { installContentRuntime } from "./runtime";

export const DISABLED_SITES_STORAGE_KEY = "disabledFloatingMenuSites";

export interface ContentBootstrapBrowser {
  runtime: Parameters<typeof installContentRuntime>[0]["runtime"];
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  getUiLanguage(): string | undefined;
}

function siteKey(location: Location): string | undefined {
  return location.protocol === "file:"
    ? "file://"
    : location.hostname || undefined;
}

function parseDisabledSites(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function bootstrapContentRuntime(
  document: Document,
  location: Location,
  globalObject: Record<string, unknown>,
  api: ContentBootstrapBrowser,
): Promise<boolean> {
  const key = siteKey(location);
  if (key === undefined) return false;

  const stored = await api.storage.local.get(DISABLED_SITES_STORAGE_KEY);
  if (parseDisabledSites(stored[DISABLED_SITES_STORAGE_KEY]).includes(key)) {
    return false;
  }

  return installContentRuntime({
    document,
    globalObject,
    runtime: api.runtime,
    getBrowserUiLanguage: () => api.getUiLanguage(),
    siteLabel: key,
    async disableSite() {
      const latest = await api.storage.local.get(DISABLED_SITES_STORAGE_KEY);
      const disabled = new Set(
        parseDisabledSites(latest[DISABLED_SITES_STORAGE_KEY]),
      );
      disabled.add(key);
      await api.storage.local.set({
        [DISABLED_SITES_STORAGE_KEY]: Array.from(disabled).sort(),
      });
    },
  });
}
