import { installContentRuntime } from "../src/content/runtime";

export default defineUnlistedScript(() => {
  installContentRuntime({
    document,
    globalObject: globalThis,
    runtime: browser.runtime,
    getBrowserUiLanguage: () => browser.i18n.getUILanguage(),
  });
});
