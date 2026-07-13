import type { ContentState, TranslationResult } from "../shared/types";
import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
  PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
} from "./constants";
import type { ExtractedSegment } from "./extractor";
import type { ContentRuntimeState } from "./state";

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
  element.lang = "zh-CN";
  element.dir = "auto";
  element.style.boxSizing = "border-box";
  element.style.marginBlock = "0.35em 0.85em";
  element.style.paddingInlineStart = "0.85em";
  element.style.borderInlineStart = "3px solid #6a8f7c";
  element.style.color = "#456257";
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

export function renderTranslation(
  extracted: ExtractedSegment,
  result: TranslationResult,
  state: ContentRuntimeState,
  visible = true,
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
  applyVisibility(translation, visible);
  translation.textContent =
    result.status === "success"
      ? result.translatedText
      : `Translation unavailable. ${result.error.message}`;
  placeTranslation(source, translation);

  return translation;
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
