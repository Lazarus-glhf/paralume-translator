import { createError } from "../shared/errors";
import {
  createContentCommand,
  createErrorResponse,
  type ContentCommand,
  type ContentResponse,
} from "../messaging/protocol";
import { parseContentResponse } from "../messaging/validation";

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
  const extensionApi = api ?? (browser as unknown as PopupBrowser);
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

  try {
    await extensionApi.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: [INJECTED_SCRIPT_PATH],
    });
  } catch {
    return createErrorResponse(createError("INJECTION_FAILED"));
  }

  try {
    const rawResponse = await extensionApi.tabs.sendMessage(
      activeTab.id,
      createContentCommand(command),
    );
    const parsed = parseContentResponse(rawResponse);
    return parsed.ok ? parsed.value : createErrorResponse(parsed.error);
  } catch {
    return createErrorResponse(createError("INJECTION_FAILED"));
  }
}
