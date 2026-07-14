import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { createBackgroundRouter } from "../src/messaging/background-router";
import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import { createSettingsRepository } from "../src/settings/repository";
import { createBackgroundTranslationResultMessage } from "../src/messaging/protocol";
import { createSettingsBackedProviderResolver } from "../src/translation/registry";

export default defineBackground(() => {
  type RuntimeSender = Parameters<
    Parameters<typeof browser.runtime.onMessage.addListener>[0]
  >[1];
  const settingsRepository = createSettingsRepository({
    get: (key) => browser.storage.local.get(key),
    set: (items) => browser.storage.local.set(items),
  });
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
    createSettingsMessageHandler(settingsRepository, resolveProvider),
  );

  registerBackgroundMessageListener(browser.runtime.onMessage, handleMessage);
});
