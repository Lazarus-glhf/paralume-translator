import type { SourceSegment } from "../shared/types";
import { CANDIDATE_BLOCK_SELECTOR } from "./constants";
import { isEligibleCandidate } from "./eligibility";
import type { ContentRuntimeState } from "./state";
import { getReadableText } from "./text";

export interface ExtractedSegment {
  element: HTMLElement;
  segment: SourceSegment;
}

function isStructuralContainer(element: HTMLElement): boolean {
  return ["LI", "TD", "TH"].includes(element.tagName);
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
  const eligible = Array.from(
    root.querySelectorAll(CANDIDATE_BLOCK_SELECTOR),
  ).filter((element) => isEligibleCandidate(element, state));
  const structuralCandidates = new Set(eligible.filter(isStructuralContainer));
  const selected = eligible.filter((candidate) => {
    if (hasStructuralAncestor(candidate, structuralCandidates)) {
      return false;
    }

    if (isStructuralContainer(candidate)) {
      return true;
    }

    return !eligible.some(
      (other) => other !== candidate && candidate.contains(other),
    );
  });

  return selected.map((element): ExtractedSegment => {
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
