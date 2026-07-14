import type { UiLocale } from "../localization";
import type { ContentCommand } from "../messaging/protocol";
import type { TranslationProgress } from "./controller";

export interface FloatingMenu {
  readonly host: HTMLElement;
  setLocale(locale: UiLocale): void;
  setProgress(progress: TranslationProgress): void;
  setFailureCount(count: number): void;
}

const labels = {
  en: {
    translate: "Translate page",
    expand: "More translation controls",
    toggle: "Show or hide translations",
    clear: "Clear translations",
    retryFailed: "Retry all failed",
    ready: "Ready",
    translating: "Translating",
    complete: "Translation complete",
    error: "Translation needs attention",
  },
  "zh-CN": {
    translate: "翻译页面",
    expand: "更多翻译控制",
    toggle: "显示或隐藏译文",
    clear: "清除译文",
    retryFailed: "批量重试失败项",
    ready: "准备就绪",
    translating: "正在翻译",
    complete: "翻译完成",
    error: "翻译需要处理",
  },
} as const;

export function installFloatingMenu(
  document: Document,
  runCommand: (command: ContentCommand) => Promise<unknown>,
  locale: UiLocale,
): FloatingMenu {
  const host = document.createElement("div");
  host.setAttribute("data-paralume-owned", "true");
  host.style.cssText =
    "all:initial;position:fixed;right:0;top:42%;z-index:2147483646;display:block;";
  const shadow = host.attachShadow({ mode: "open" });
  const text = labels[locale];
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      .dock { display:flex; align-items:center; gap:6px; padding:6px; border:1px solid rgba(120,120,130,.24); border-right:0; border-radius:14px 0 0 14px; background:rgba(250,250,252,.94); box-shadow:0 12px 34px rgba(15,23,42,.18); backdrop-filter:blur(18px); font:500 13px/1.3 Inter,ui-sans-serif,system-ui,sans-serif; color:#202124; }
      button { appearance:none; border:0; border-radius:9px; min-width:34px; min-height:34px; padding:8px; background:transparent; color:inherit; cursor:pointer; font:inherit; }
      button:hover { background:rgba(80,86,100,.10); }
      button:focus-visible { outline:2px solid #6d5dfc; outline-offset:2px; }
      .primary { padding-inline:12px; background:#6558e8; color:white; font-weight:650; }
      .primary:hover { background:#574bcf; }
      .mark { display:inline-block; width:7px; height:7px; margin-right:7px; border-radius:50%; background:#8b8f99; }
      [data-working="true"] .mark { background:#6558e8; animation:pulse 1.2s ease-in-out infinite; }
      .panel { position:absolute; right:10px; top:52px; width:236px; padding:10px; border:1px solid rgba(120,120,130,.22); border-radius:14px; background:rgba(250,250,252,.97); box-shadow:0 18px 50px rgba(15,23,42,.20); color:#202124; }
      .panel[hidden] { display:none; }
      .status { margin:0 0 8px; padding:8px 10px; color:#5c606a; font-size:12px; }
      .row { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
      .danger { color:#b42318; }
      @keyframes pulse { 50% { opacity:.35; transform:scale(.75); } }
      @media (prefers-color-scheme:dark) { .dock,.panel { background:rgba(27,28,32,.95); color:#f4f4f5; border-color:rgba(255,255,255,.14); } .status { color:#b5b7bf; } button:hover { background:rgba(255,255,255,.09); } }
      @media (prefers-reduced-motion:reduce) { [data-working="true"] .mark { animation:none; } }
      @media (forced-colors:active) { .dock,.panel,.primary { forced-color-adjust:auto; border:1px solid ButtonText; } }
    </style>
    <div class="dock" data-working="false">
      <button class="primary" data-action="primary" type="button" aria-label="${text.translate}"><span class="mark"></span>${text.translate}</button>
      <button data-action="expand" type="button" aria-label="${text.expand}" aria-expanded="false">•••</button>
      <div class="panel" data-panel hidden>
        <p class="status" role="status">${text.ready}</p>
      <div class="row">
          <button data-action="retry-failed" type="button" disabled>${text.retryFailed}</button>
          <button data-action="toggle" type="button">${text.toggle}</button>
          <button class="danger" data-action="clear" type="button">${text.clear}</button>
        </div>
      </div>
    </div>
  `;
  const dock = shadow.querySelector<HTMLElement>(".dock");
  const panel = shadow.querySelector<HTMLElement>("[data-panel]");
  const expand = shadow.querySelector<HTMLButtonElement>(
    '[data-action="expand"]',
  );
  const invoke = (command: ContentCommand): void => {
    void runCommand(command).catch(() => undefined);
  };
  shadow
    .querySelector('[data-action="primary"]')
    ?.addEventListener("click", () => {
      invoke("translate");
    });
  shadow
    .querySelector('[data-action="retry-failed"]')
    ?.addEventListener("click", () => {
      invoke("retry-failed");
    });
  shadow
    .querySelector('[data-action="toggle"]')
    ?.addEventListener("click", () => {
      invoke("toggle");
    });
  shadow
    .querySelector('[data-action="clear"]')
    ?.addEventListener("click", () => {
      invoke("clear");
    });
  expand?.addEventListener("click", () => {
    const opening = panel?.hasAttribute("hidden") ?? false;
    panel?.toggleAttribute("hidden", !opening);
    expand.setAttribute("aria-expanded", String(opening));
  });
  document.documentElement.append(host);

  let activeLocale = locale;
  let activeProgress: TranslationProgress = {
    phase: "idle",
    completed: 0,
    total: 0,
  };
  const updateText = (): void => {
    const activeLabels = labels[activeLocale];
    const status = shadow.querySelector<HTMLElement>('[role="status"]');
    const phaseText =
      activeLabels[
        activeProgress.phase === "idle" ? "ready" : activeProgress.phase
      ];
    if (status !== null) {
      status.textContent = `${phaseText} · ${String(activeProgress.completed)} / ${String(activeProgress.total)}`;
    }
    const primary = shadow.querySelector<HTMLButtonElement>(
      '[data-action="primary"]',
    );
    if (primary !== null) {
      primary.setAttribute("aria-label", activeLabels.translate);
      const labelNode = primary.lastChild;
      if (labelNode !== null) {
        labelNode.textContent = activeLabels.translate;
      }
    }
    const expandButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="expand"]',
    );
    expandButton?.setAttribute("aria-label", activeLabels.expand);
    const toggleButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="toggle"]',
    );
    if (toggleButton !== null) {
      toggleButton.textContent = activeLabels.toggle;
    }
    const retryFailedButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="retry-failed"]',
    );
    if (retryFailedButton !== null) {
      retryFailedButton.textContent = activeLabels.retryFailed;
    }
    const clearButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="clear"]',
    );
    if (clearButton !== null) {
      clearButton.textContent = activeLabels.clear;
    }
  };

  return {
    host,
    setLocale(nextLocale) {
      activeLocale = nextLocale;
      updateText();
    },
    setProgress(progress) {
      activeProgress = progress;
      updateText();
      dock?.setAttribute(
        "data-working",
        String(progress.phase === "translating"),
      );
    },
    setFailureCount(count) {
      const button = shadow.querySelector<HTMLButtonElement>(
        '[data-action="retry-failed"]',
      );
      if (button !== null) {
        button.disabled = count === 0;
        button.hidden = count === 0;
      }
    },
  };
}
