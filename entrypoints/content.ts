import { bootstrapContentRuntime } from "../src/content/bootstrap";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  async main() {
    await bootstrapContentRuntime(document, location, globalThis, {
      runtime: browser.runtime,
      storage: browser.storage,
      getUiLanguage: () => browser.i18n.getUILanguage(),
    });
  },
});
