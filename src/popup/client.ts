import { createError, UserFacingError } from "../shared/errors";
import {
  createContentCommand,
  createErrorResponse,
  type ContentCommand,
  type ContentResponse,
} from "../messaging/protocol";
import { parseContentResponse } from "../messaging/validation";
import {
  createEnableSiteMessage,
  createGetContentSettingsMessage,
  createListDisabledSitesMessage,
  parseContentSettingsResponse,
  parseDisabledSitesResponse,
  parseEnableSiteResponse,
} from "../messaging/settings-protocol";
import { isValidSiteKey, siteKeyFromUrl } from "../settings/site-preferences";
import type { ContentSettings } from "../settings/types";

export interface PopupTab {
  id?: number;
  url?: string;
}

export interface PopupBrowser {
  tabs: {
    query: (query: {
      active: true;
      currentWindow: true;
    }) => Promise<readonly PopupTab[]>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
  };
  scripting: {
    executeScript: (injection: {
      target: { tabId: number };
      files: readonly string[];
    }) => Promise<unknown>;
  };
}

const INJECTED_SCRIPT_PATH = "paralume.js";
const ALLOWED_PAGE_PROTOCOLS = new Set(["http:", "https:", "file:"]);
let pageCommandDispatchTail: Promise<void> = Promise.resolve();

function isAllowedPage(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }

  try {
    return ALLOWED_PAGE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export async function runPageCommand(
  command: ContentCommand,
  api?: PopupBrowser,
): Promise<ContentResponse> {
  const previousDispatch = pageCommandDispatchTail;
  let releaseDispatch: (() => void) | undefined;
  pageCommandDispatchTail = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  await previousDispatch;
  const release = (): void => {
    releaseDispatch?.();
    releaseDispatch = undefined;
  };
  const extensionApi = api ?? (browser as unknown as PopupBrowser);
  try {
    let tabs: readonly PopupTab[];
    try {
      tabs = await extensionApi.tabs.query({
        active: true,
        currentWindow: true,
      });
    } catch {
      return createErrorResponse(createError("NO_ACTIVE_TAB"));
    }

    const activeTab = tabs[0];

    if (activeTab?.id === undefined) {
      return createErrorResponse(createError("NO_ACTIVE_TAB"));
    }

    if (!isAllowedPage(activeTab.url)) {
      return createErrorResponse(createError("RESTRICTED_PAGE"));
    }

    // Poll existing runtimes without repeatedly injecting the script. First
    // use still falls back to explicit injection when no listener exists.
    if (command === "status") {
      try {
        const existing = parseContentResponse(
          await extensionApi.tabs.sendMessage(
            activeTab.id,
            createContentCommand(command),
          ),
        );
        if (existing.ok) return existing.value;
      } catch {
        // No content runtime yet; install it below.
      }
    }

    try {
      await extensionApi.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: [INJECTED_SCRIPT_PATH],
      });
    } catch {
      return createErrorResponse(createError("INJECTION_FAILED"));
    }

    try {
      const response = extensionApi.tabs.sendMessage(
        activeTab.id,
        createContentCommand(command),
      );
      // Let a concurrently requested Stop dispatch after Translate has been
      // posted, without waiting for the long-running Translate response.
      release();
      const parsed = parseContentResponse(await response);
      return parsed.ok ? parsed.value : createErrorResponse(parsed.error);
    } catch {
      return createErrorResponse(createError("INJECTION_FAILED"));
    }
  } finally {
    release();
  }
}

export interface PopupSettingsRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface PopupSiteState {
  readonly site: string;
  readonly disabled: boolean;
}

export async function loadPopupSiteState(
  api?: PopupBrowser,
  runtime?: PopupSettingsRuntime,
): Promise<PopupSiteState | undefined> {
  const extensionApi = api ?? (browser as unknown as PopupBrowser);
  const activeRuntime = runtime ?? browser.runtime;
  let tabs: readonly PopupTab[];
  try {
    tabs = await extensionApi.tabs.query({
      active: true,
      currentWindow: true,
    });
  } catch {
    throw new UserFacingError("NO_ACTIVE_TAB");
  }
  const activeUrl = tabs[0]?.url;
  if (activeUrl === undefined) {
    return undefined;
  }
  const site = siteKeyFromUrl(activeUrl);
  if (site === undefined || site === "file://") {
    return undefined;
  }
  const parsedUrl = new URL(activeUrl);
  if (
    (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
    parsedUrl.hostname !== site ||
    !isValidSiteKey(site)
  ) {
    return undefined;
  }
  const parsed = parseDisabledSitesResponse(
    await activeRuntime.sendMessage(createListDisabledSitesMessage()),
  );
  if (!parsed.ok) {
    throw new UserFacingError(parsed.error.code);
  }
  if (!parsed.value.ok) {
    throw new UserFacingError(parsed.value.error.code);
  }
  return { site, disabled: parsed.value.sites.includes(site) };
}

export async function enablePopupSite(
  site: string,
  runtime?: PopupSettingsRuntime,
): Promise<void> {
  if (!isValidSiteKey(site) || site === "file://") {
    throw new UserFacingError("INVALID_MESSAGE");
  }
  const activeRuntime = runtime ?? browser.runtime;
  const parsed = parseEnableSiteResponse(
    await activeRuntime.sendMessage(createEnableSiteMessage(site)),
  );
  if (!parsed.ok) {
    throw new UserFacingError(parsed.error.code);
  }
  if (!parsed.value.ok) {
    throw new UserFacingError(parsed.value.error.code);
  }
}

export async function loadPopupContentSettings(
  runtime?: PopupSettingsRuntime,
): Promise<ContentSettings> {
  const activeRuntime = runtime ?? browser.runtime;
  const parsed = parseContentSettingsResponse(
    await activeRuntime.sendMessage(createGetContentSettingsMessage()),
  );
  if (!parsed.ok) {
    throw new UserFacingError(parsed.error.code);
  }
  if (!parsed.value.ok) {
    throw new UserFacingError(parsed.value.error.code);
  }
  return parsed.value.contentSettings;
}
