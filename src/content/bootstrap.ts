import {
  createDisableSiteMessage,
  createGetSiteStateMessage,
  parseDisableSiteResponse,
  parseSiteStateResponse,
} from "../messaging/settings-protocol";
import { siteKeyFromUrl } from "../settings/site-preferences";
import { UserFacingError } from "../shared/errors";
import { installContentRuntime } from "./runtime";

// Content scripts do not touch chrome.storage directly: the background keeps
// storage.local restricted to trusted contexts and owns the site preference.
export interface ContentBootstrapBrowser {
  runtime: Parameters<typeof installContentRuntime>[0]["runtime"];
  getUiLanguage(): string | undefined;
}

export async function bootstrapContentRuntime(
  document: Document,
  location: Location,
  globalObject: Record<string, unknown>,
  api: ContentBootstrapBrowser,
): Promise<boolean> {
  const key = siteKeyFromUrl(location.href);
  if (key === undefined) return false;

  const state = parseSiteStateResponse(
    await api.runtime.sendMessage(createGetSiteStateMessage()),
  );
  // Fail closed: without a valid answer the menu stays off, as it did when
  // the stored preference could not be read.
  if (!state.ok || !state.value.ok || state.value.siteDisabled) {
    return false;
  }

  return installContentRuntime({
    document,
    globalObject,
    runtime: api.runtime,
    getBrowserUiLanguage: () => api.getUiLanguage(),
    siteLabel: key,
    async disableSite() {
      const parsed = parseDisableSiteResponse(
        await api.runtime.sendMessage(createDisableSiteMessage()),
      );
      if (!parsed.ok) {
        throw new UserFacingError(parsed.error.code);
      }
      if (!parsed.value.ok) {
        throw new UserFacingError(parsed.value.error.code);
      }
    },
  });
}
