import { formatMessage, translateError, type UiLocale } from "../localization";
import { DEFAULT_APPEARANCE_SETTINGS } from "../settings/defaults";
import type { AppearanceSettings } from "../settings/types";
import type { ContentState, TranslationResult } from "../shared/types";
import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_RETRY_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
  PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
} from "./constants";
import type { ExtractedSegment } from "./extractor";
import type { ContentRuntimeState } from "./state";

export interface RenderTranslationOptions {
  appearance?: AppearanceSettings;
  locale?: UiLocale;
  onRetry?: () => void;
}

const FONT_FAMILIES: Readonly<
  Record<AppearanceSettings["fontFamily"], string>
> = {
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sans-serif": "Arial, Helvetica, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  monospace: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
};

function isWithinRoot(root: ParentNode, node: Node): boolean {
  return (root as Node).contains(node);
}

function getTranslationElements(
  root: ParentNode,
  state: ContentRuntimeState,
): HTMLElement[] {
  return Array.from(state.translations).filter((translation) =>
    isWithinRoot(root, translation),
  );
}

function createTranslationElement(source: HTMLElement): HTMLElement {
  const element = source.ownerDocument.createElement("div");

  element.className = "paralume-translation";
  element.dir = "auto";
  element.style.boxSizing = "border-box";
  element.style.padding = "0.65em 0.8em";
  element.style.borderInlineStart = "3px solid #6a8f7c";
  element.style.borderRadius = "0 0.35em 0.35em 0";
  element.style.fontStyle = "normal";
  element.style.whiteSpace = "pre-wrap";

  return element;
}

function isStructuralContainer(source: HTMLElement): boolean {
  return ["LI", "TD", "TH"].includes(source.tagName);
}

function placeTranslation(source: HTMLElement, translation: HTMLElement): void {
  if (isStructuralContainer(source)) {
    if (
      translation.parentElement !== source ||
      source.lastElementChild !== translation
    ) {
      source.append(translation);
    }
    return;
  }

  if (source.nextElementSibling !== translation) {
    source.after(translation);
  }
}

function markSource(
  source: HTMLElement,
  segmentId: string,
  state: ContentRuntimeState,
): void {
  if (state.sourceMarkers.has(source)) {
    return;
  }

  const attributeAdded = !source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE);
  if (attributeAdded) {
    source.setAttribute(PARALUME_SOURCE_ID_ATTRIBUTE, segmentId);
  }
  state.sourceMarkers.set(source, { segmentId, attributeAdded });
}

function applyVisibility(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
  if (visible) {
    element.style.removeProperty("display");
  } else {
    element.style.setProperty("display", "none", "important");
  }
}

function disposeRetryControl(
  translation: HTMLElement,
  state: ContentRuntimeState,
): void {
  const control = state.retryControls.get(translation);
  if (control === undefined) {
    return;
  }
  control.button.removeEventListener("click", control.listener);
  state.retryControls.delete(translation);
}

function applyAppearance(
  translation: HTMLElement,
  appearance: AppearanceSettings,
): void {
  translation.style.fontFamily = FONT_FAMILIES[appearance.fontFamily];
  translation.style.fontSize = `${String(appearance.fontSize)}px`;
  translation.style.color = appearance.textColor;
  translation.style.backgroundColor = appearance.backgroundColor;
  translation.style.lineHeight = String(appearance.lineHeight);
  translation.style.opacity = String(appearance.opacity);
  translation.style.marginBlock = `${String(appearance.verticalSpacing)}px`;
}

function renderFailure(
  translation: HTMLElement,
  result: Extract<TranslationResult, { status: "failure" }>,
  state: ContentRuntimeState,
  locale: UiLocale,
  onRetry?: () => void,
): void {
  const errorText = translateError(locale, result.error.code);
  const message = translation.ownerDocument.createElement("span");
  message.textContent = formatMessage(
    locale,
    "content.translationUnavailable",
    {
      error: errorText,
    },
  );

  if (onRetry === undefined) {
    translation.replaceChildren(message);
    return;
  }

  const button = translation.ownerDocument.createElement("button");
  button.type = "button";
  button.setAttribute(PARALUME_OWNED_ATTRIBUTE, "true");
  button.setAttribute(PARALUME_RETRY_ATTRIBUTE, "true");
  button.setAttribute(
    "aria-label",
    formatMessage(locale, "content.retryAccessible"),
  );
  button.textContent = formatMessage(locale, "content.retry");
  button.style.justifySelf = "end";
  button.style.display = "block";
  button.style.marginBlockStart = "0.35em";
  button.style.marginInlineStart = "auto";
  button.style.padding = "0.15em 0.45em";
  button.style.border = "1px solid currentColor";
  button.style.borderRadius = "0.35em";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "inherit";
  button.style.fontSize = "0.8em";
  button.style.lineHeight = "1.25";
  button.style.cursor = "pointer";
  button.style.opacity = "0.72";

  const listener = () => {
    if (!button.disabled) {
      onRetry();
    }
  };
  button.addEventListener("click", listener);
  state.ownedNodes.add(button);
  state.retryControls.set(translation, { button, listener });
  translation.replaceChildren(message, button);
}

export function renderTranslation(
  extracted: ExtractedSegment,
  result: TranslationResult,
  state: ContentRuntimeState,
  visible = true,
  options: RenderTranslationOptions = {},
): HTMLElement {
  if (result.id !== extracted.segment.id) {
    throw new Error("Translation result ID does not match its source segment.");
  }

  const { element: source } = extracted;
  markSource(source, extracted.segment.id, state);

  const existing = state.translationsBySource.get(source);
  const translation = existing ?? createTranslationElement(source);
  if (existing === undefined) {
    state.ownedNodes.add(translation);
    state.translations.add(translation);
    state.translationsBySource.set(source, translation);
  }

  disposeRetryControl(translation, state);
  translation.setAttribute(PARALUME_OWNED_ATTRIBUTE, "true");
  translation.setAttribute(
    PARALUME_TRANSLATION_FOR_ATTRIBUTE,
    extracted.segment.id,
  );
  translation.setAttribute(
    PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
    result.status,
  );
  state.translationStatuses.set(translation, result.status);
  const locale = options.locale ?? "en";
  translation.lang = result.status === "success" ? "zh-CN" : locale;
  applyAppearance(
    translation,
    options.appearance ?? DEFAULT_APPEARANCE_SETTINGS,
  );
  translation.removeAttribute("aria-busy");
  applyVisibility(translation, visible);
  if (result.status === "success") {
    translation.textContent = result.translatedText;
  } else {
    renderFailure(translation, result, state, locale, options.onRetry);
  }
  placeTranslation(source, translation);

  return translation;
}

export function setTranslationPending(
  translation: HTMLElement,
  state: ContentRuntimeState,
  pending: boolean,
  locale: UiLocale,
): void {
  const control = state.retryControls.get(translation);
  if (control === undefined) {
    return;
  }
  control.button.disabled = pending;
  control.button.textContent = formatMessage(
    locale,
    pending ? "content.retryPending" : "content.retry",
  );
  if (pending) {
    translation.setAttribute("aria-busy", "true");
  } else {
    translation.removeAttribute("aria-busy");
  }
}

export function applyAppearanceToTranslations(
  root: ParentNode,
  state: ContentRuntimeState,
  appearance: AppearanceSettings,
): void {
  for (const translation of getTranslationElements(root, state)) {
    applyAppearance(translation, appearance);
  }
}

export function setTranslationsVisible(
  root: ParentNode,
  state: ContentRuntimeState,
  visible: boolean,
): void {
  for (const translation of getTranslationElements(root, state)) {
    applyVisibility(translation, visible);
  }
}

export function getContentState(
  root: ParentNode,
  state: ContentRuntimeState,
): ContentState {
  const translations = getTranslationElements(root, state);

  return {
    translationCount: translations.length,
    failureCount: translations.filter(
      (translation) => state.translationStatuses.get(translation) === "failure",
    ).length,
    visible:
      translations.length === 0 ||
      translations.every((translation) => !translation.hidden),
  };
}
