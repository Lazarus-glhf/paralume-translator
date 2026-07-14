import { PARALUME_SOURCE_ID_ATTRIBUTE } from "./constants";
import type { ContentRuntimeState } from "./state";

function isWithinRoot(root: ParentNode, node: Node): boolean {
  return (root as Node).contains(node);
}

function releaseTranslation(
  translation: HTMLElement,
  state: ContentRuntimeState,
): void {
  const retryControl = state.retryControls.get(translation);
  if (retryControl !== undefined) {
    retryControl.button.removeEventListener("click", retryControl.listener);
    state.retryControls.delete(translation);
  }
  translation.remove();
  state.translations.delete(translation);
  state.translationStatuses.delete(translation);
}

function releaseSourceMarker(
  source: HTMLElement,
  state: ContentRuntimeState,
): void {
  const marker = state.sourceMarkers.get(source);
  if (
    marker?.attributeAdded === true &&
    source.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE) === marker.segmentId
  ) {
    source.removeAttribute(PARALUME_SOURCE_ID_ATTRIBUTE);
  }
  state.sourceMarkers.delete(source);
}

export function invalidateSourceTranslation(
  source: HTMLElement,
  state: ContentRuntimeState,
): void {
  const translation = state.translationsBySource.get(source);
  if (translation !== undefined) {
    releaseTranslation(translation, state);
    state.translationsBySource.delete(source);
  }
  releaseSourceMarker(source, state);
}

export function clearTranslations(
  root: ParentNode,
  state: ContentRuntimeState,
): number {
  let removed = 0;

  for (const translation of Array.from(state.translations)) {
    if (isWithinRoot(root, translation)) {
      removed += 1;
    }
    releaseTranslation(translation, state);
  }

  for (const source of Array.from(state.sourceMarkers.keys())) {
    state.translationsBySource.delete(source);
    releaseSourceMarker(source, state);
  }

  return removed;
}
