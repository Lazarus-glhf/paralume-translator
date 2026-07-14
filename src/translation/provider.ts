import type { TranslationRequest, TranslationResult } from "../shared/types";

export interface TranslationProviderContext {
  readonly signal?: AbortSignal;
  readonly sendResult?: (result: TranslationResult) => void;
  readonly onResult?: (result: TranslationResult) => void;
}

export interface TranslationProvider {
  readonly name: string;
  translate: (
    request: TranslationRequest,
    context?: TranslationProviderContext,
  ) => Promise<readonly TranslationResult[]>;
}

export interface TranslationStreamProvider extends TranslationProvider {
  streamTranslate: (
    request: TranslationRequest,
    context?: TranslationProviderContext,
  ) => Promise<readonly TranslationResult[]>;
}

export type TranslationProviderResolver = () => Promise<TranslationProvider>;
