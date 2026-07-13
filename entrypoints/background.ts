import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { MockTranslationProvider } from "../src/translation/mock";

export default defineBackground(() => {
  const handleMessage = createBackgroundMessageHandler(
    new MockTranslationProvider(),
  );

  registerBackgroundMessageListener(browser.runtime.onMessage, handleMessage);
});
