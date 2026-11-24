import type { SourceSegment } from "../shared/types";
import { invalidateSourceTranslation } from "./cleanup";
import { CANDIDATE_BLOCK_SELECTOR } from "./constants";
import { isEligibleCandidate } from "./eligibility";
import type { ContentRuntimeState } from "./state";
import {
  getCurrentSourceText,
  getReadableText,
  isCompoundStructuralContainer,
} from "./text";

export interface ExtractedSegment {
  element: HTMLElement;
  segment: SourceSegment;
}

function isStructuralContainer(element: HTMLElement): boolean {
  return ["LI", "TD", "TH"].includes(element.tagName);
}

function readingPriority(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const viewportHeight = element.ownerDocument.defaultView?.innerHeight ?? 0;
  if (rect.bottom >= 0 && rect.top <= viewportHeight) {
    return 0;
  }
  return rect.top > viewportHeight ? 1 : 2;
}

function hasStructuralAncestor(
  element: HTMLElement,
  structuralCandidates: ReadonlySet<HTMLElement>,
): boolean {
  for (
    let current = element.parentElement;
    current !== null;
    current = current.parentElement
  ) {
    if (structuralCandidates.has(current)) {
      return true;
    }
  }

  return false;
}

function getStableId(element: HTMLElement, state: ContentRuntimeState): string {
  const existing = state.segmentIds.get(element);
  if (existing !== undefined) {
    return existing;
  }

  state.nextSegmentNumber += 1;
  const id = `segment-${state.runtimeId}-${String(state.nextSegmentNumber)}`;
  state.segmentIds.set(element, id);
  return id;
}

export function extractSegments(
  root: ParentNode,
  state: ContentRuntimeState,
): readonly ExtractedSegment[] {
  for (const [source, marker] of Array.from(state.sourceMarkers)) {
    if (
      !source.isConnected ||
      getCurrentSourceText(source, state) !== marker.sourceText
    ) {
      invalidateSourceTranslation(source, state);
    }
  }

  const eligible = Array.from(
    root.querySelectorAll(CANDIDATE_BLOCK_SELECTOR),
  ).filter((element) => isEligibleCandidate(element, state));
  // Merged list items/cells own their nested blocks. Compound ones (nested
  // lists/tables, preformatted prose, or several readable blocks; never code
  // blocks or `translate="no"` blocks, which are skipped) let nested blocks
  // stand alone and keep only their loose text, so layout tables and nested
  // lists do not collapse into one oversized segment.
  const structuralCandidates = new Set(
    eligible.filter(
      (candidate) =>
        isStructuralContainer(candidate) &&
        !isCompoundStructuralContainer(candidate, state),
    ),
  );
  // Any other eligible candidate is selected: its text excludes every nested
  // block that is translated on its own (an eligible nested block always has
  // meaningful text, so it is split out), so a container with its own loose
  // text is translated without duplicating or dropping nested text.
  const selected = eligible.filter(
    (candidate) => !hasStructuralAncestor(candidate, structuralCandidates),
  );
  // A merged list item/cell about to be translated now owns its nested
  // blocks. One that was compound before (for example until the page removed
  // a sibling block) may still have translations rendered for nested blocks;
  // drop them so that text is not shown twice.
  for (const owner of selected) {
    if (!structuralCandidates.has(owner)) {
      continue;
    }
    for (const source of Array.from(state.sourceMarkers.keys())) {
      if (source !== owner && owner.contains(source)) {
        invalidateSourceTranslation(source, state);
      }
    }
  }

  return selected
    .map((element, index) => ({ element, index }))
    .sort(
      (first, second) =>
        readingPriority(first.element) - readingPriority(second.element) ||
        first.index - second.index,
    )
    .map(({ element }): ExtractedSegment => {
      const text = getReadableText(element, state);

      return {
        element,
        segment: {
          id: getStableId(element, state),
          text,
        },
      };
    });
}
