import { PARALUME_SOURCE_ID_ATTRIBUTE } from "./constants";
import type { ContentRuntimeState } from "./state";

function isWithinRoot(root: ParentNode, node: Node): boolean {
  return (root as Node).contains(node);
}

export function clearTranslations(
  root: ParentNode,
  state: ContentRuntimeState,
): number {
  let removed = 0;

  for (const translation of Array.from(state.translations)) {
    if (!isWithinRoot(root, translation)) {
      continue;
    }

    const retryControl = state.retryControls.get(translation);
    if (retryControl !== undefined) {
      retryControl.button.removeEventListener("click", retryControl.listener);
      state.retryControls.delete(translation);
    }
    translation.remove();
    state.translations.delete(translation);
    state.translationStatuses.delete(translation);
    removed += 1;
  }

  for (const [source, marker] of Array.from(state.sourceMarkers)) {
    if (!isWithinRoot(root, source)) {
      continue;
    }

    const translation = state.translationsBySource.get(source);
    if (translation !== undefined && !state.translations.has(translation)) {
      state.translationsBySource.delete(source);
    }

    if (
      marker.attributeAdded &&
      source.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE) === marker.segmentId
    ) {
      source.removeAttribute(PARALUME_SOURCE_ID_ATTRIBUTE);
    }
    state.sourceMarkers.delete(source);
  }

  return removed;
}
