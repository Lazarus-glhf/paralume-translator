import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_REQUEST_LIMITS,
  countPageRequestPrefix,
  exceedsPageRequestLimits,
} from "../src/shared/request-budget";
import type { SourceSegment } from "../src/shared/types";

function segments(count: number, textLength: number): SourceSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `segment-${String(index)}`,
    text: "a".repeat(textLength),
  }));
}

describe("page request budget", () => {
  it("allows long documentation pages beyond the old 200 segment and 50,000 character ceiling", () => {
    const page = segments(500, 400);

    expect(countPageRequestPrefix(page)).toBe(page.length);
    expect(exceedsPageRequestLimits(page)).toBe(false);
    expect(DEFAULT_PAGE_REQUEST_LIMITS).toEqual({
      maxSegments: 10_000,
      maxCharacters: 5_000_000,
    });
  });

  it("retains a finite whole-page safety ceiling", () => {
    const page = segments(10_001, 1);

    expect(countPageRequestPrefix(page)).toBe(10_000);
    expect(exceedsPageRequestLimits(page)).toBe(true);
  });
});
