import type { StructuredError } from "./errors";

export type SegmentId = string;

export interface SourceSegment {
  id: SegmentId;
  text: string;
}

export interface TranslationRequest {
  sourceLanguage: "auto";
  targetLanguage: "zh-CN";
  segments: readonly SourceSegment[];
}

export interface TranslationSuccess {
  id: SegmentId;
  status: "success";
  translatedText: string;
}

export interface TranslationFailure {
  id: SegmentId;
  status: "failure";
  error: StructuredError;
}

export type TranslationResult = TranslationSuccess | TranslationFailure;

export interface ContentState {
  translationCount: number;
  failureCount: number;
  visible: boolean;
}
