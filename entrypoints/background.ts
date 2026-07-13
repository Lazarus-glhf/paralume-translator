import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { createBackgroundRouter } from "../src/messaging/background-router";
import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import { createSettingsRepository } from "../src/settings/repository";
import { createSettingsBackedProviderResolver } from "../src/translation/registry";

export default defineBackground(() => {
  const settingsRepository = createSettingsRepository({
    get: (key) => browser.storage.local.get(key),
    set: (items) => browser.storage.local.set(items),
  });
  const resolveProvider = createSettingsBackedProviderResolver(
    settingsRepository,
    browser.permissions,
  );
  const handleMessage = createBackgroundRouter(
    createBackgroundMessageHandler(resolveProvider),
    createSettingsMessageHandler(settingsRepository, resolveProvider),
  );

  registerBackgroundMessageListener(browser.runtime.onMessage, handleMessage);
});
