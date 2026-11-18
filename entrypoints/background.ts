import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { createBackgroundRouter } from "../src/messaging/background-router";
import { createExtensionPageSenderCheck } from "../src/messaging/sender";
import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import {
  createSettingsRepository,
  restrictStorageToTrustedContexts,
} from "../src/settings/repository";
import { createSitePreferenceStore } from "../src/settings/site-preferences";
import { createBackgroundTranslationResultMessage } from "../src/messaging/protocol";
import { createSettingsBackedProviderResolver } from "../src/translation/registry";

export default defineBackground(() => {
  type RuntimeSender = Parameters<
    Parameters<typeof browser.runtime.onMessage.addListener>[0]
  >[1];
  // Keys live in storage.local; keep content scripts out of it. Best effort:
  // unsupported browsers keep the default and still never receive keys
  // through messaging.
  void restrictStorageToTrustedContexts(browser.storage.local);
  const localStorageArea = {
    get: (key: string) => browser.storage.local.get(key),
    set: (items: Record<string, unknown>) => browser.storage.local.set(items),
  };
  const settingsRepository = createSettingsRepository(localStorageArea);
  const resolveProvider = createSettingsBackedProviderResolver(
    settingsRepository,
    browser.permissions,
  );
  const handleMessage = createBackgroundRouter<
    import("../src/messaging/protocol").BackgroundResponse,
    Awaited<ReturnType<ReturnType<typeof createSettingsMessageHandler>>>,
    RuntimeSender
  >(
    createBackgroundMessageHandler<RuntimeSender>(
      resolveProvider,
      undefined,
      undefined,
      {
        sendResult(sender, operationId, result) {
          const tabId = sender.tab?.id;
          if (tabId === undefined) return;
          void browser.tabs
            .sendMessage(
              tabId,
              createBackgroundTranslationResultMessage(operationId, result),
              sender.frameId === undefined
                ? undefined
                : { frameId: sender.frameId },
            )
            .catch(() => undefined);
        },
      },
    ),
    createSettingsMessageHandler(settingsRepository, resolveProvider, {
      openOptionsPage: () => browser.runtime.openOptionsPage(),
      isExtensionPageSender: createExtensionPageSenderCheck(
        browser.runtime.id,
        browser.runtime.getURL("/"),
      ),
      sitePreferences: createSitePreferenceStore(localStorageArea),
    }),
  );

  registerBackgroundMessageListener(browser.runtime.onMessage, handleMessage);
});
