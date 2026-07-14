import type { SourceSegment } from "../shared/types";
import { invalidateSourceTranslation } from "./cleanup";
import { CANDIDATE_BLOCK_SELECTOR } from "./constants";
import { isEligibleCandidate } from "./eligibility";
import type { ContentRuntimeState } from "./state";
import { getCurrentSourceText, getReadableText } from "./text";

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
  const structuralCandidates = new Set(eligible.filter(isStructuralContainer));
  const eligibleSet = new Set(eligible);
  const candidatesWithEligibleDescendants = new Set<HTMLElement>();
  for (const candidate of eligible) {
    for (
      let ancestor = candidate.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (eligibleSet.has(ancestor)) {
        candidatesWithEligibleDescendants.add(ancestor);
      }
    }
  }
  const selected = eligible.filter((candidate) => {
    if (hasStructuralAncestor(candidate, structuralCandidates)) {
      return false;
    }

    return (
      isStructuralContainer(candidate) ||
      !candidatesWithEligibleDescendants.has(candidate)
    );
  });

  return selected
    .map((element, index) => ({ element, index }))
    .sort(
      (first, second) =>
        readingPriority(first.element) - readingPriority(second.element) ||
        first.index - second.index,
    )
    .map(({ element }): ExtractedSegment => {
      const text = getReadableText(element);

      return {
        element,
        segment: {
          id: getStableId(element, state),
          text,
        },
      };
    });
}
