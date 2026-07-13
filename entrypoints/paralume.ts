import { installContentRuntime } from "../src/content/runtime";

export default defineUnlistedScript(() => {
  return installContentRuntime({
    document,
    globalObject: globalThis,
    runtime: browser.runtime,
  });
});
