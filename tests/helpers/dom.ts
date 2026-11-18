import { vi } from "vitest";

/**
 * Dispatches a click that Paralume treats as user-initiated. happy-dom does
 * not implement `Event.isTrusted`; real browsers define it as an unforgeable,
 * non-configurable own property, so this override only works in tests.
 */
export function trustedClick(target: Element): void {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.defineProperty(event, "isTrusted", { value: true });
  target.dispatchEvent(event);
}

/**
 * Records every shadow root attached while the spy is active (restored after
 * each test by `restoreMocks`), so tests can inspect closed shadow roots that
 * `host.shadowRoot` intentionally hides.
 */
// Captured once at import so repeated spies never wrap an existing spy.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalAttachShadow = Element.prototype.attachShadow;

export function captureShadowRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = originalAttachShadow.call(this, init);
    roots.push(root);
    return root;
  });
  return roots;
}
