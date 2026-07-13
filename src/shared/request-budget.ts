import type { SourceSegment } from "./types";

export interface PageRequestLimits {
  maxSegments: number;
  maxCharacters: number;
}

export const DEFAULT_PAGE_REQUEST_LIMITS: PageRequestLimits = {
  maxSegments: 200,
  maxCharacters: 50_000,
};

export function assertPageRequestLimits(limits: PageRequestLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

export function countPageRequestPrefix(
  segments: readonly SourceSegment[],
  limits: PageRequestLimits = DEFAULT_PAGE_REQUEST_LIMITS,
): number {
  assertPageRequestLimits(limits);
  let count = 0;
  let characters = 0;

  for (const segment of segments) {
    if (
      count >= limits.maxSegments ||
      characters + segment.text.length > limits.maxCharacters
    ) {
      break;
    }

    count += 1;
    characters += segment.text.length;
  }

  return count;
}

export function exceedsPageRequestLimits(
  segments: readonly SourceSegment[],
  limits: PageRequestLimits = DEFAULT_PAGE_REQUEST_LIMITS,
): boolean {
  assertPageRequestLimits(limits);
  return (
    segments.length > limits.maxSegments ||
    segments.reduce((total, segment) => total + segment.text.length, 0) >
      limits.maxCharacters
  );
}
