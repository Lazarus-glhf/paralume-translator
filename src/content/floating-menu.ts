import type { UiLocale } from "../localization";
import type { ContentCommand } from "../messaging/protocol";
import type { TranslationProgress } from "./controller";

export interface FloatingMenu {
  readonly host: HTMLElement;
  setLocale(locale: UiLocale): void;
  setProgress(progress: TranslationProgress): void;
  setFailureCount(count: number): void;
}

export interface FloatingMenuOptions {
  readonly siteLabel?: string;
  readonly disableSite?: () => Promise<void>;
}

const labels = {
  en: {
    translate: "Translate page",
    expand: "More translation controls",
    toggle: "Show or hide translations",
    clear: "Clear translations",
    retryFailed: "Retry all failed",
    hidePage: "Hide on this page",
    disableSite: "Disable on this site",
    siteControls: "Site controls",
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
    hidePage: "在此页面隐藏",
    disableSite: "在此网站停用",
    siteControls: "网站控制",
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
  options: FloatingMenuOptions = {},
): FloatingMenu {
  const host = document.createElement("div");
  host.setAttribute("data-paralume-owned", "true");
  host.style.cssText =
    "all:initial;position:fixed;right:0;top:42%;z-index:2147483646;display:block;";
  const shadow = host.attachShadow({ mode: "open" });
  const text = labels[locale];
  shadow.innerHTML = `
    <style>
      :host { color-scheme:light dark; --accent:#6757e8; --accent-strong:#5143c7; --surface:rgba(255,255,255,.96); --surface-soft:#f6f5fb; --text:#24232b; --muted:#73717d; --line:rgba(38,35,55,.11); }
      * { box-sizing:border-box; }
      button { appearance:none; border:0; font:inherit; cursor:pointer; color:inherit; }
      button:focus-visible { outline:3px solid rgba(103,87,232,.34); outline-offset:2px; }
      .dock { position:relative; width:42px; height:48px; font:500 13px/1.35 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--text); }
      .handle { position:relative; display:grid; place-items:center; width:42px; height:48px; padding:0; border:1px solid var(--line); border-right:0; border-radius:15px 0 0 15px; background:var(--surface); box-shadow:0 8px 28px rgba(30,24,67,.16); backdrop-filter:blur(18px) saturate(1.25); transition:width 160ms ease,background 160ms ease,transform 160ms ease; }
      .handle:hover { width:46px; background:#faf9ff; transform:translateX(-4px); }
      .handle svg { width:24px; height:24px; overflow:visible; }
      .mark { position:absolute; right:5px; top:6px; width:6px; height:6px; border:2px solid var(--surface); border-radius:50%; background:#9c99a8; }
      [data-working="true"] .mark { background:var(--accent); animation:pulse 1.2s ease-in-out infinite; }
      .panel { position:absolute; right:50px; top:-78px; width:286px; overflow:hidden; border:1px solid var(--line); border-radius:20px; background:var(--surface); box-shadow:0 22px 70px rgba(26,21,55,.22),0 3px 12px rgba(26,21,55,.08); backdrop-filter:blur(24px) saturate(1.25); }
      .panel[hidden] { display:none; }
      .header { display:flex; align-items:center; gap:11px; padding:15px 16px 12px; }
      .brand { display:grid; place-items:center; width:34px; height:34px; border-radius:11px; background:linear-gradient(145deg,#7667f2,#5143c7); color:white; box-shadow:0 6px 16px rgba(81,67,199,.25); }
      .brand svg { width:21px; height:21px; }
      .heading { min-width:0; flex:1; }
      .title { margin:0; font-size:14px; font-weight:720; letter-spacing:-.01em; }
      .site { overflow:hidden; margin:2px 0 0; color:var(--muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
      .status { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 12px 12px; padding:10px 12px; border:1px solid rgba(103,87,232,.12); border-radius:12px; background:rgba(103,87,232,.07); color:#565263; font-size:12px; }
      .progress { flex:none; color:var(--accent-strong); font-variant-numeric:tabular-nums; font-weight:700; }
      .actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; padding:0 12px 12px; }
      .action { min-height:38px; padding:8px 10px; border:1px solid var(--line); border-radius:11px; background:var(--surface-soft); font-size:12px; font-weight:630; transition:background 140ms ease,border-color 140ms ease,transform 140ms ease; }
      .action:hover:not(:disabled) { border-color:rgba(103,87,232,.22); background:#eeebff; transform:translateY(-1px); }
      .primary { grid-column:1/-1; min-height:42px; border-color:transparent; background:var(--accent); color:white; font-size:13px; }
      .primary:hover:not(:disabled) { border-color:transparent; background:var(--accent-strong); }
      .action:disabled { cursor:default; opacity:.45; }
      .site-actions { display:grid; grid-template-columns:1fr 1fr; gap:4px; padding:8px; border-top:1px solid var(--line); background:rgba(245,244,249,.78); }
      .site-action { min-height:32px; padding:6px 8px; border-radius:9px; background:transparent; color:var(--muted); font-size:11px; }
      .site-action:hover { background:rgba(45,42,58,.07); color:var(--text); }
      .site-action.danger:hover { background:#fff0ee; color:#a42b22; }
      @keyframes pulse { 50% { opacity:.35; transform:scale(.7); } }
      @media (prefers-color-scheme:dark) { :host { --surface:rgba(29,28,35,.96); --surface-soft:#27262e; --text:#f4f3f7; --muted:#aaa7b3; --line:rgba(255,255,255,.11); } .handle:hover { background:#24222d; } .status { color:#c4c0cf; } .action:hover:not(:disabled) { background:#332f50; } .site-actions { background:rgba(22,21,27,.78); } .site-action.danger:hover { background:#402522; color:#ffb6ae; } }
      @media (prefers-reduced-motion:reduce) { .handle,.action { transition:none; } [data-working="true"] .mark { animation:none; } }
      @media (forced-colors:active) { .handle,.panel,.action,.status { forced-color-adjust:auto; border:1px solid ButtonText; } }
    </style>
    <div class="dock" data-working="false">
      <button class="handle" data-action="expand" type="button" aria-label="${text.expand}" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 6.5h9M9.5 4v2.5c0 4-2.2 7.2-5.5 9.5m3-6c1.4 2.2 3.2 4 5.5 5.2M14.5 10.5 20 20m-7.5 0 5.2-13 2.3 5.5"/></svg>
        <span class="mark"></span>
      </button>
      <div class="panel" data-panel hidden>
        <div class="header">
          <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 6.5h9M9.5 4v2.5c0 4-2.2 7.2-5.5 9.5m3-6c1.4 2.2 3.2 4 5.5 5.2M14.5 10.5 20 20m-7.5 0 5.2-13 2.3 5.5"/></svg></div>
          <div class="heading"><p class="title">Paralume</p><p class="site">${options.siteLabel ?? ""}</p></div>
        </div>
        <p class="status" role="status"><span data-phase>${text.ready}</span><span class="progress" data-progress>0 / 0</span></p>
        <div class="actions">
          <button class="action primary" data-action="primary" type="button">${text.translate}</button>
          <button class="action" data-action="retry-failed" type="button" disabled>${text.retryFailed}</button>
          <button class="action" data-action="toggle" type="button">${text.toggle}</button>
          <button class="action" data-action="clear" type="button">${text.clear}</button>
        </div>
        <div class="site-actions" data-site-actions aria-label="${text.siteControls}">
          <button class="site-action" data-action="hide-page" type="button">${text.hidePage}</button>
          <button class="site-action danger" data-action="disable-site" type="button">${text.disableSite}</button>
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
  shadow
    .querySelector('[data-action="hide-page"]')
    ?.addEventListener("click", () => {
      host.remove();
    });
  shadow
    .querySelector('[data-action="disable-site"]')
    ?.addEventListener("click", () => {
      const disableSite = options.disableSite;
      if (disableSite === undefined) {
        host.remove();
        return;
      }
      void disableSite().then(
        () => {
          host.remove();
        },
        () => undefined,
      );
    });
  expand?.addEventListener("click", () => {
    const opening = panel?.hasAttribute("hidden") ?? false;
    panel?.toggleAttribute("hidden", !opening);
    expand.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.composedPath().includes(host)) {
      panel?.setAttribute("hidden", "");
      expand?.setAttribute("aria-expanded", "false");
    }
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
    const status = shadow.querySelector<HTMLElement>("[data-phase]");
    const progress = shadow.querySelector<HTMLElement>("[data-progress]");
    const phaseText =
      activeLabels[
        activeProgress.phase === "idle" ? "ready" : activeProgress.phase
      ];
    if (status !== null) {
      status.textContent = phaseText;
    }
    if (progress !== null) {
      progress.textContent = `${String(activeProgress.completed)} / ${String(activeProgress.total)}`;
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
    const hidePageButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="hide-page"]',
    );
    if (hidePageButton !== null) {
      hidePageButton.textContent = activeLabels.hidePage;
    }
    const disableSiteButton = shadow.querySelector<HTMLButtonElement>(
      '[data-action="disable-site"]',
    );
    if (disableSiteButton !== null) {
      disableSiteButton.textContent = activeLabels.disableSite;
    }
    shadow
      .querySelector<HTMLElement>("[data-site-actions]")
      ?.setAttribute("aria-label", activeLabels.siteControls);
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
