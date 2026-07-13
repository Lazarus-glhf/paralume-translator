export interface SourceMarkerState {
  readonly segmentId: string;
  readonly attributeAdded: boolean;
}

export interface ContentRuntimeState {
  readonly runtimeId: string;
  readonly ownedNodes: WeakSet<Node>;
  readonly translations: Set<HTMLElement>;
  readonly translationsBySource: WeakMap<HTMLElement, HTMLElement>;
  readonly translationStatuses: WeakMap<HTMLElement, "success" | "failure">;
  readonly retryControls: Map<
    HTMLElement,
    {
      readonly button: HTMLButtonElement;
      readonly listener: () => void;
    }
  >;
  readonly sourceMarkers: Map<HTMLElement, SourceMarkerState>;
  readonly segmentIds: WeakMap<HTMLElement, string>;
  nextSegmentNumber: number;
}

export interface ContentRuntimeStateOptions {
  runtimeId?: string;
}

function createRuntimeId(): string {
  return globalThis.crypto.randomUUID();
}

function normalizeRuntimeId(runtimeId: string): string {
  const normalized = runtimeId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80);
  return normalized.length > 0 ? normalized : createRuntimeId();
}

export function createContentRuntimeState(
  options: ContentRuntimeStateOptions = {},
): ContentRuntimeState {
  return {
    runtimeId: normalizeRuntimeId(options.runtimeId ?? createRuntimeId()),
    ownedNodes: new WeakSet(),
    translations: new Set(),
    translationsBySource: new WeakMap(),
    translationStatuses: new WeakMap(),
    retryControls: new Map(),
    sourceMarkers: new Map(),
    segmentIds: new WeakMap(),
    nextSegmentNumber: 0,
  };
}
